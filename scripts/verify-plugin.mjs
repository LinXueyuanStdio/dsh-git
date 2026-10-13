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
 *     设置卡片的席位 key(`plugins.bundle.config`)必须**等于包名** —— 宿主按包名派发,
 *     不相等时卡片整段静默不渲染;
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
import { readFile, access, readdir } from 'node:fs/promises';
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

/**
 * 这个说明符是不是 **Node 内置** —— **子路径形式也要认**(2026-10-11 修)。
 *
 * ## 为什么必须认子路径(实测的假阳性)
 *
 * 判据原先只比整条说明符(`BUILTINS.has(specifier)`),于是 `fs/promises` 被判成
 * **未声明的 npm 依赖**,报「用户机器上会加载失败」。它不是:npm **禁止**发布与
 * 核心模块同名的包(`validate-npm-package-name` 把这类名字判成 `core module names`),
 * 所以第一段命中 {@link BUILTINS} 的说明符**只可能**是核心模块的子路径。
 * Node 今天真实的子路径至少有:`fs/promises`、`timers/promises`、`dns/promises`、
 * `stream/promises`、`stream/web`、`stream/consumers`、`util/types`、`assert/strict`、
 * `path/posix`、`path/win32`、`readline/promises`。
 *
 * 假阳性的来源是**逐字镜像**:宿主半把上游 `lib/**` 抄进来,而那些文件写的是
 * 上游的 `import { access } from 'fs/promises'`(镜像**一个字节都不许改**),
 * 宿主产物里因此**真的**有一条 `from "fs/promises"` —— 它在 Node 里加载得好好的,
 * 却让本脚本在 `npm publish` 前把发布判红(实测:`lib/index.js`,报 1 处)。
 * 修法只能是「判定认子路径」,不能是「改镜像的 import」。
 *
 * ## 为什么放宽这一段不会漏掉真缺口
 *
 * 被跳过的说明符满足「第一段是核心模块名」,而那种名字**不可能**是 npm 包
 * (见上)。反过来,真缺口(装不上的第三方包)的第一段永远不在 {@link BUILTINS} 里,
 * 判定与改前逐字相同 —— 打开一个假阳性,不动任何一条真阳性。
 *
 * @param {string} specifier - 源码里出现的外部模块说明符(裸名或带子路径)。
 * @returns {boolean} 是 Node 内置(含 `node:` 前缀与核心子路径)则为 `true`。
 */
function isBuiltinSpecifier(specifier) {
	if (specifier.startsWith('node:')) return true;
	return BUILTINS.has(specifier.split('/')[0]);
}

/** 从模块说明符取出包名:`react/jsx-runtime` → `react`,`@scope/pkg/x` → `@scope/pkg`。 */
function packageOf(specifier) {
	const parts = specifier.split('/');
	return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** 合法的 npm 包名(含 scope 与子路径)。用来把注释/字符串里的巧合命中挡掉。 */
const SPECIFIER_RE = /^(?:@[A-Za-z0-9][A-Za-z0-9._~-]*\/)?[A-Za-z0-9][A-Za-z0-9._~-]*(?:\/[A-Za-z0-9._~-]+)*$/;

/**
 * 「声明在 `dependencies` 里、却**没有**被产物当外部依赖引用」的**已登记例外**。
 *
 * 键 = 包名,值 = **为什么它可以这样**(没有理由的条目等于把闸门关掉,别加)。
 * 今天为空:唯一的 `dependencies`(`dugite`)真的被 `lib/index.js` 外部 `import`。
 *
 * 什么时候才该往这里加:那个包**确实**要在运行期被加载(所以不能进 devDependencies),
 * 但它的引用方式让静态扫描看不到 —— 例如本仓代码按**字符串**在运行期解析包名
 * (静态扫描只认 `import` / `require` / `import()` 里的字面量)。判据与背景见
 * `THIRD-PARTY-NOTICES.md` §2/§3。
 *
 * @type {Map<string, string>}
 */
const DECLARED_BUT_NOT_EXTERNAL_OK = new Map([]);

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
			if (isBuiltinSpecifier(specifier)) continue;
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
		/*
		 * ⚠️ **通配导出**(`"./locale/*.json"`)不是一条路径:直接 `access()` 它必然 ENOENT,
		 * 于是这条本来防「清单指向不存在的文件」的判据会**误报**一个不存在的缺陷。
		 * 对通配条目改成它真正要问的问题:那个目录在不在、里面**至少有一个**文件匹配。
		 * (2026-10-13 加 `locale/*.json` 时踩到;形状照 dsh-context 的 package.json。)
		 */
		if (rel.includes('*')) {
			const dir = join(REPO, rel.slice(0, rel.indexOf('*')).replace(/\/$/, ''));
			const suffix = rel.slice(rel.indexOf('*') + 1);
			let entries = [];
			try {
				entries = await readdir(dir);
			} catch {
				fail(`package.json 的通配导出 ${rel} 指向的目录不存在(装上去会缺文件)`);
				continue;
			}
			const hit = entries.filter((name) => suffix === '' || name.endsWith(suffix));
			if (hit.length === 0) {
				fail(`package.json 的通配导出 ${rel} 在 ${dir.slice(REPO.length + 1)}/ 里一个文件都匹配不到`);
			}
			continue;
		}
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

	/*
	 * ---------- 2b. 设置卡片的席位 key 必须**等于包名**(2026-10-13 加) ----------
	 *
	 * `plugins.bundle.config` 是 keyed 席位,宿主按 **bundle 的包名**派发
	 * (`PluginManagerPage.tsx:735` 的 `{ entryKey: pkg.name }`),是否渲染又由
	 * `configured={ledger.bundles.has(openPkg.name)}` 决定(`:1571`)—— 而 `ledger.bundles`
	 * 就是这个席位 key 的集合(`config-ledger.ts:40,66`)。
	 *
	 * ⇒ 把 key 写成配置命名空间(`'dsh-git'`)而不是包名,后果是
	 * **`section[data-plugin-config]` 整个节点不出现,且不报错、不警告**。
	 * 这条判据把那个静默失败变成一个退出码。
	 *
	 * 判据取**产物本身**(不是源码惯例):先读源码里的常量(它是人写 key 的唯一入口),
	 * 再从 `lib/client.js` 的注册对象里**解出**真正生效的 key —— 两者都必须 === `pkg.name`。
	 * 三样都查,是因为它们各自会单独漂移:常量改了没重构建、构建产物被手改、
	 * 或者有人绕开常量直接写了一个字符串字面量。
	 */
	const srcText = await readFile(join(REPO, 'src/client/index.ts'), 'utf8');
	const constantMatch = srcText.match(/export const DSH_GIT_BUNDLE_NAME\s*=\s*["']([^"']+)["']/);
	if (!constantMatch) {
		fail('src/client/index.ts 里找不到 `export const DSH_GIT_BUNDLE_NAME = \'…\'` —— 席位 key 的单一真源没了');
	} else if (constantMatch[1] !== pkg.name) {
		fail(
			`DSH_GIT_BUNDLE_NAME(${constantMatch[1]})≠ package.json 的 name(${pkg.name})`
			+ ' —— plugins.bundle.config 的 key 必须是包名,否则设置卡片整段不渲染(且不报错)',
		);
	}
	const seatIndex = clientText.indexOf('name: "plugins.bundle.config"');
	if (seatIndex < 0) {
		fail('lib/client.js 里没有注册 `plugins.bundle.config` —— 设置卡片在「插件」页上不会出现');
	} else {
		const keyMatch = clientText.slice(seatIndex, seatIndex + 400).match(/key:\s*([^,\n]+)/);
		if (!keyMatch) {
			fail('lib/client.js 的 `plugins.bundle.config` 注册里找不到 `key` —— keyed 席位没有 key 会抛异常');
		} else {
			const expr = keyMatch[1].trim();
			let resolved = expr;
			if (!/^["']/.test(expr)) {
				// 标识符形式(构建保留了常量引用):回到产物里解它的值。
				const ident = expr.match(/^[A-Za-z_$][\w$]*$/);
				const decl = ident === null ? null : clientText.match(new RegExp(`var ${ident[0]} = ["']([^"']+)["']`));
				resolved = decl === null ? `<未能从产物解出 ${expr}>` : decl[1];
			} else {
				resolved = expr.replace(/^["']|["']$/g, '');
			}
			if (resolved !== pkg.name) {
				fail(
					`lib/client.js 里 plugins.bundle.config 的 key 解出来是 ${resolved},不是包名 ${pkg.name}`
					+ ' —— 宿主按包名派发,key 不符时 section[data-plugin-config] 整段不出现(静默失败)',
				);
			} else {
				notes.push(`设置卡片席位:plugins.bundle.config key = ${resolved}(= 包名)`);
			}
		}
	}

	// ---------- 3. 运行时依赖都声明了吗 ----------
	const declaredRuntime = new Set([
		...Object.keys(pkg.dependencies ?? {}),
		...Object.keys(pkg.peerDependencies ?? {}),
	]);
	const undeclared = new Set();
	/** 产物里真的被外部引用的包名(两个 bundle 的并集)—— 下面第二向判据要用它。 */
	/** @type {Set<string>} */
	const externallyReferenced = new Set();
	for (const bundle of [hostBundle, clientBundle]) {
		for (const name of await externalsOf(bundle)) {
			externallyReferenced.add(name);
			if (!declaredRuntime.has(name)) undeclared.add(`${name}(被 ${bundle.slice(REPO.length + 1)} 引用)`);
		}
	}
	for (const item of undeclared) fail(`产物引用了未声明的外部依赖 ${item} —— 用户机器上会加载失败`);

	/*
	 * ---------- 3b. 反向:声明了 dependencies 却没被产物外部引用 ----------
	 *
	 * 这条是上一条的**镜像**,2026-10-12 加(那次偏移的现场:4 个**已经被 esbuild 内联**的包
	 * 因为「反正要装」被留在 `dependencies` 里 —— 后果有两层:①每个用户的 profile 白装一遍
	 * 那 4 个包(它们的代码就在 `lib/*.js` 里,运行期一个都不 import);②`THIRD-PARTY-NOTICES.md`
	 * 的清单口径当时是「根包的 `dependencies` 闭包」⇒ 它们**静默离开**了署名表,其中
	 * `dompurify` 还是 Apache-2.0。判据与修法写在 `THIRD-PARTY-NOTICES.md` §2/§3)。
	 *
	 * 判据不是「惯例」,而是**产物本身**:`dependencies` / `optionalDependencies` 里的每一项
	 * 都必须真的出现在某个产物的外部 `import`/`require` 里 —— 否则它就是内联包,该回
	 * `devDependencies`(想让它在运行期可用,就得像 `dugite` 那样**标成 external**,
	 * 那时这条自然通过)。
	 */
	for (const bucket of ['dependencies', 'optionalDependencies']) {
		for (const name of Object.keys(pkg[bucket] ?? {})) {
			if (externallyReferenced.has(name) || DECLARED_BUT_NOT_EXTERNAL_OK.has(name)) continue;
			fail(
				`${bucket} 里的 ${name} 没有被任何产物当外部依赖引用 —— 它的代码其实是被 esbuild **内联**的,` +
				`留在 ${bucket} 只会让每个用户的 profile 白装一遍(运行期一个都不 import);` +
				'按 THIRD-PARTY-NOTICES.md §2/§3 的判据移到 devDependencies;' +
				'若它真的在运行期被 import,就把它标成 external,并在本脚本的 DECLARED_BUT_NOT_EXTERNAL_OK 里登记理由',
			);
		}
	}

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
