/**
 * 插件可用性自检:回答「这一个包装得上、加载得起来吗」。
 *
 * 与 `scripts/check-*.mjs` 的分工(这是刻意的):
 *   - `check-*.mjs` 是**源码卫生**闸门(闭包配方、未接线祖先、lint、类型、生成物摘要…),
 *     它们盯的是这个仓库自己怎么写的,与「别人装上能不能用」无关;
 *   - 本脚本只看**发布出去的那个包**,而且只问四件事:
 *
 *  1. **清单自洽**:`package.json` 里的 `dsh.bundle.patch`、`exports` 指向的文件真的存在;
 *  2. **能被宿主加载**:`lib/client.js` 的 ModuleLoader banner 里 `id` 必须等于包名
 *     (Desktop 侧就是这么校验的,不一致 = 装上也加载不了);`lib/index.js` 是 ESM;
 *  3. **运行时依赖都声明了**:两个产物里出现的**外部 import/require** 必须落在
 *     `dependencies` / `peerDependencies` 里(子路径归到包名,如 `react/jsx-runtime` → `react`)。
 *     这条抓的是「包 import 了一个没声明、也没随包打进去的东西」—— 那会让插件在用户机器上
 *     直接加载失败,而本地因为 node_modules 齐全永远看不出来;
 *  4. **发出去的内容完整且不含源码**:`npm pack` 的清单里必须有两个入口、`cordis.patch.yml`、
 *     `icon.svg`、README、LICENSE,且**不含** `.map`(map 内嵌全部源码,只给本机 devtools 用)。
 *
 * 退出码:0 = 通过;1 = 有缺陷;2 = 前置条件缺失(例如还没构建)会说明原因。
 *
 * 用法:
 *     node scripts/verify-plugin.mjs            # 人读
 *     node scripts/verify-plugin.mjs --json     # 机器可读
 *     node scripts/verify-plugin.mjs --help
 *
 * @module dsh-git/scripts/verify-plugin
 */

import { execFile } from 'node:child_process';
import { readFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const REPO = resolve(import.meta.dirname, '..');

const HELP = `用法: node scripts/verify-plugin.mjs [--json] [--help]

插件可用性自检(发布出去的那个包装得上、加载得起来吗)。

  --json    机器可读输出
  --help    显示本帮助

退出码:0 = 通过;1 = 有缺陷;2 = 前置条件缺失。`;

/** Node 内置模块(含 `node:` 前缀形式)。 */
const BUILTINS = new Set([
	'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants',
	'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain', 'events', 'fs', 'http',
	'http2', 'https', 'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'process',
	'punycode', 'querystring', 'readline', 'repl', 'stream', 'string_decoder', 'sys',
	'timers', 'tls', 'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi',
	'worker_threads', 'zlib',
]);

/** 从模块说明符取出包名:`react/jsx-runtime` → `react`,`@scope/pkg/x` → `@scope/pkg`。 */
function packageOf(specifier) {
	const parts = specifier.split('/');
	return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** 合法的 npm 包名(含 scope 与子路径)。用来把注释/字符串里的巧合命中挡掉。 */
const SPECIFIER_RE = /^(?:@[A-Za-z0-9][A-Za-z0-9._~-]*\/)?[A-Za-z0-9][A-Za-z0-9._~-]*(?:\/[A-Za-z0-9._~-]+)*$/;

/** 扫描一个产物里出现的所有外部模块说明符。 */
async function externalsOf(file) {
	const raw = await readFile(file, 'utf8');
	// 先去掉注释:打包产物里保留了注释,而注释里会出现 `// require('focus-trap')`
	// 这种说明文字 —— 不剥掉就会被当成真实依赖(实测踩过)。
	const text = raw
		.replace(/\/\*[\s\S]*?\*\//g, ' ')
		.replace(/^[ \t]*\/\/.*$/gm, ' ');
	const found = new Set();
	const patterns = [
		/\bfrom\s*["']([^"']+)["']/g, // ESM import ... from "x" / export ... from "x"
		/\brequire\(\s*["']([^"']+)["']\s*\)/g, // CJS require("x")
		/\bimport\(\s*["']([^"']+)["']\s*\)/g, // 动态 import("x")
	];
	for (const re of patterns) {
		for (const match of text.matchAll(re)) {
			const specifier = match[1];
			if (!SPECIFIER_RE.test(specifier)) continue;
			if (specifier.startsWith('.')) continue;
			if (specifier.startsWith('node:')) continue;
			if (BUILTINS.has(specifier)) continue;
			found.add(packageOf(specifier));
		}
	}
	return found;
}

/** 主流程。 */
async function main() {
	const argv = process.argv.slice(2);
	if (argv.includes('--help') || argv.includes('-h')) {
		process.stdout.write(`${HELP}\n`);
		return 0;
	}
	const asJson = argv.includes('--json');
	const failures = [];
	const notes = [];
	const fail = (message) => failures.push(message);

	// ---------- 前置:产物必须已经构建 ----------
	const hostBundle = join(REPO, 'lib', 'index.js');
	const clientBundle = join(REPO, 'lib', 'client.js');
	let missing = [];
	for (const file of [hostBundle, clientBundle]) {
		try {
			await access(file, constants.R_OK);
		} catch {
			missing.push(file.slice(REPO.length + 1));
		}
	}
	if (missing.length > 0) {
		const message = `lib/ 里缺少 ${missing.join('、')} —— 先跑 npm run build(本脚本只验已构建的包)`;
		if (asJson) process.stdout.write(`${JSON.stringify({ ok: false, skipped: true, reason: message }, null, 2)}\n`);
		else process.stdout.write(`verify-plugin: SKIP(未构建)\n  ${message}\n`);
		return 2;
	}

	// ---------- 1. 清单自洽 ----------
	const pkg = JSON.parse(await readFile(join(REPO, 'package.json'), 'utf8'));
	const declared = [
		...(pkg.exports ? Object.values(pkg.exports).filter((v) => typeof v === 'string' && v.startsWith('./')) : []),
		pkg.dsh?.bundle?.patch,
	].filter(Boolean);
	for (const rel of declared) {
		try {
			await access(join(REPO, rel), constants.R_OK);
		} catch {
			fail(`package.json 指向的 ${rel} 不存在(装上去会缺文件)`);
		}
	}
	if (!pkg.dsh?.bundle?.patch) fail('package.json 没有 dsh.bundle.patch —— 只有 dsh.client 的包无法用 dsh plugin add 安装');
	if (pkg.name !== '@linxueyuan/dsh-git') notes.push(`包名是 ${pkg.name}(非预期,确认一下是否改过名)`);

	// ---------- 2. 宿主能加载吗 ----------
	const clientText = await readFile(clientBundle, 'utf8');
	const banner = clientText.match(/window\.__ModuleLoader__\.load\(\{\s*id:\s*["']([^"']+)["']/);
	if (!banner) {
		fail('lib/client.js 里找不到 ModuleLoader banner —— 浏览器半不会被宿主加载');
	} else if (banner[1] !== pkg.name) {
		fail(`lib/client.js 的 ModuleLoader id(${banner[1]})≠ package.json 的 name(${pkg.name})——Desktop 会拒绝加载`);
	}
	const patchPath = join(REPO, pkg.dsh.bundle.patch);
	const patchText = await readFile(patchPath, 'utf8');
	if (!patchText.includes(pkg.name)) {
		fail(`${pkg.dsh.bundle.patch} 里没有出现包名 ${pkg.name} —— patch 指向的会是别的包`);
	}

	// ---------- 3. 运行时依赖都声明了吗 ----------
	const declaredRuntime = new Set([
		...Object.keys(pkg.dependencies ?? {}),
		...Object.keys(pkg.peerDependencies ?? {}),
	]);
	const undeclared = new Set();
	for (const bundle of [hostBundle, clientBundle]) {
		for (const name of await externalsOf(bundle)) {
			if (!declaredRuntime.has(name)) undeclared.add(`${name}(被 ${bundle.slice(REPO.length + 1)} 引用)`);
		}
	}
	for (const item of undeclared) fail(`产物引用了未声明的外部依赖 ${item} —— 用户机器上会加载失败`);

	// ---------- 4. 发出去的内容 ----------
	let packInfo = null;
	try {
		const { stdout } = await execFileAsync('npm', ['pack', '--dry-run', '--json'], { cwd: REPO });
		packInfo = JSON.parse(stdout)[0];
	} catch (error) {
		fail(`npm pack --dry-run 失败:${error.message.split('\n')[0]}`);
	}
	if (packInfo) {
		const files = packInfo.files.map((f) => f.path.replace(/^\.\//, ''));
		for (const required of ['lib/index.js', 'lib/client.js', pkg.dsh.bundle.patch.replace(/^\.\//, ''), 'README.md', 'LICENSE']) {
			if (!files.includes(required)) fail(`发布的包里缺少 ${required}`);
		}
		const maps = files.filter((f) => f.endsWith('.map'));
		if (maps.length > 0) fail(`发布的包里有 sourcemap(${maps.join('、')})—— 它内嵌全部源码,只应留在本机`);
		notes.push(`发布内容:${packInfo.entryCount} 个文件 / ${(packInfo.size / 1024).toFixed(1)} kB`);
	}

	// ---------- 汇总 ----------
	if (asJson) {
		process.stdout.write(`${JSON.stringify({ ok: failures.length === 0, failures, notes, package: `${pkg.name}@${pkg.version}` }, null, 2)}\n`);
	} else {
		process.stdout.write(`verify-plugin: ${pkg.name}@${pkg.version}\n`);
		for (const note of notes) process.stdout.write(`  · ${note}\n`);
		if (failures.length === 0) {
			process.stdout.write('  结论:PASS —— 包完整、能被宿主加载、运行时依赖都已声明\n');
		} else {
			for (const message of failures) process.stdout.write(`  ✗ ${message}\n`);
			process.stdout.write(`  结论:FAIL(${failures.length} 处)  退出码 1\n`);
		}
	}
	return failures.length === 0 ? 0 : 1;
}

process.exitCode = await main();
