#!/usr/bin/env node
/**
 * dsh-git 部署测试(端到端):**构建 → 打包 → 装进一个真 profile → 启动 → 验证 UI → 走路由改仓库并推送到 test 分支**。
 *
 * ## 它验证什么(以及为什么这样验证)
 *
 * 单元测试只能证明「函数是对的」,证明不了「这个包装进 dsh 之后真的能用」——而
 * 我们踩过的坑几乎全在后者:
 *
 * 1. **profile 不会自动创建**(`dsh --profile <新名>` 直接报错退出),所以脚本自己建;
 * 2. **`latest` tag 是脏的**:`@deepseek-ai/dsh-base` / `dsh-web-app` 在公开 npm 上
 *    `latest` = `0.0.1-rc.1`,而当前 CLI 是 `0.2.0-rc.2` —— 不锁版本就会装进一个
 *    与宿主不兼容的老包。所以 profile 里那两个 bundle **按 `dsh --version` 的实测版本锁死**,
 *    这也正是当年「右侧栏服务永远不来」那个 version skew 的根因;
 * 3. **pnpm 11 把「忽略 build script」当致命错误**(`ERR_PNPM_IGNORED_BUILDS`,exit 1),
 *    而 dsh 的依赖树里有一串带 install/postinstall 的包(`node-pty`、`protobufjs`、
 *    `koffi`…)且会随版本变 ⇒ 脚本不写死白名单,而是 `pnpm install`(允许失败)→
 *    `pnpm approve-builds --all`(让 pnpm 自己批自己知道的全部),见第 4 步;
 * 4. **失败会留下 `package.json.lock`**:`dsh plugin add` 中途报错会留一个写着死进程 PID 的锁,
 *    之后每一次 add 都会**永久挂住**(实测卡满 10 分钟)。所以脚本开工前清死锁;
 * 5. **插件真的能加载**:浏览器控制台必须出现本产物的 `[dsh-git] client build …` 戳,
 *    且页面不能出现 host 的 `Failed to load plugins` —— 硬依赖 `sidebarRightTabs` 那次
 *    事故的表现就是整页报这个错;
 * 6. **端到端真的能推送**:登记仓库 → 改文件 → stage → commit → push 全部走插件自己的
 *    `/dsh-git/*` 路由,最后用**独立的** `git ls-remote` 证明远端 `test` 分支的 head 前进了。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/e2e-deploy.mjs                      # 本地:用当前 checkout 的 origin,推 test 分支
 * node scripts/e2e-deploy.mjs --skip-push          # 只跑到 commit(无凭据时)
 * node scripts/e2e-deploy.mjs --keep               # 保留 profile 与临时克隆,便于事后排查
 * node scripts/e2e-deploy.mjs --tarball x.tgz      # 跳过构建/打包,直接测一个现成 tarball
 * ```
 *
 * @module dsh-git/scripts/e2e-deploy
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  rmSync, writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// 参数与常量
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
/** 读一个 `--flag value` 形式的值。 */
function flag(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
}
/** 读一个布尔开关。 */
function has(name) {
  return argv.includes(`--${name}`);
}

/** 仓库根(本脚本在 scripts/ 下)。 */
const REPO = resolve(import.meta.dirname, '..');
/** 测试用 profile 名。刻意不叫 `web`/`desktop`:那两个是 shipped 名字,不能作为自定义 profile 目标。 */
const PROFILE = flag('profile', 'dshe2e');
/** 截图与产物的落盘目录。 */
const SHOTS = resolve(flag('shots', join(REPO, 'artifacts', 'e2e')));
/** 推送目标分支(用户裁决:用本仓库的 test 分支做落点)。 */
const BRANCH = flag('branch', 'test');
/** 是否跳过 push 与远端断言。 */
const SKIP_PUSH = has('skip-push');
/** 是否保留 profile 与临时克隆。 */
const KEEP = has('keep');

/** 统一的日志前缀,方便在 CI 日志里 grep。 */
const tag = 'dsh-git e2e';
let stepNo = 0;
/** 每一步的结论,最后汇成 GitHub Actions 的 job summary。 */
const checks = [];
/** 失败原因(top-level await 抛错时由 handler 记下)。 */
let failure;

/** 打印一个步骤标题。 */
function step(title) {
  stepNo += 1;
  console.log(`\n▸ [${stepNo}] ${title}`);
}
/** 打印一条信息。 */
function info(message) {
  console.log(`  ${message}`);
}
/** 打印一条成功,并记进 summary。 */
function ok(message) {
  console.log(`  ✓ ${message}`);
  checks.push({ kind: 'ok', message });
}
/** 打印一条警告(不中断),并记进 summary。 */
function warn(message) {
  console.log(`  ! ${message}`);
  checks.push({ kind: 'warn', message });
}

/**
 * 把这次运行的结论写进 GitHub Actions 的 **job summary**。
 *
 * CI 里 `$GITHUB_STEP_SUMMARY` 是 Actions 给的汇总文件:写进去的 Markdown 会显示在
 * 那次运行的首页上,于是「部署测试到底验了什么、结论如何」不必翻几千行日志。
 * 本机跑时这个变量不存在,就只把同样的内容打到终端。
 *
 * 用**同步**写:失败路径上进程随时可能退出,异步写会丢。
 */
function writeSummary() {
  const failed = failure !== undefined || process.exitCode === 1;
  const lines = [];
  lines.push(`## ${failed ? '❌' : '✅'} 部署测试(端到端)${failed ? '失败' : '通过'}`);
  lines.push('');
  lines.push('构建 → 打包 → 装进真 profile → 无头启动 → 浏览器验证 → 走路由改仓库 → push 到远端分支。');
  lines.push('');
  if (failure !== undefined) {
    lines.push('```');
    lines.push(failure);
    lines.push('```');
    lines.push('');
  }
  lines.push('| | 结论 |');
  lines.push('|---|---|');
  for (const entry of checks) {
    const mark = entry.kind === 'ok' ? '✓' : '!';
    lines.push(`| ${mark} | ${entry.message.replace(/\|/g, '\\|')} |`);
  }
  lines.push('');
  const text = `${lines.join('\n')}\n`;
  if (process.env.GITHUB_STEP_SUMMARY !== undefined) {
    try {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
    } catch (error) {
      console.error(`${tag}: 写 job summary 失败:${String(error)}`);
    }
  }
  console.log(`\n${tag} ---- summary ----\n${text}`);
}

/*
 * summary **一定要落地**(失败时更是),所以挂在 `exit` 上而不是写在最后一行;
 * 顶层 await 抛错走的是 `unhandledRejection`,在那里记下原因并置 exit code 1,
 * 否则脚本会以 0 退出 —— 那比失败本身更糟。
 */
process.on('exit', writeSummary);
process.on('unhandledRejection', (reason) => {
  failure = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  console.error(reason);
  process.exitCode = 1;
});


/** 子进程执行(继承输出,失败即抛)。 */
function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: 'pipe', ...options });
}
/** 在终端里原样回显一条命令(不含潜在凭据)。 */
function echo(cmd, args) {
  info(`$ ${cmd} ${args.join(' ')}`);
}
/** 把可能含凭据的 URL 打码后再打印。 */
function redact(url) {
  return url.replace(/\/\/[^/@]*@/, '//***@');
}

// ---------------------------------------------------------------------------
// 0. 预检:环境里到底有什么
// ---------------------------------------------------------------------------

step('预检:node / dsh / Chrome / playwright');

const nodeMajor = Number(process.versions.node.split('.')[0]);
info(`node ${process.version}`);
if (nodeMajor < 22) {
  throw new Error(`node >= 22 才能跑(当前 ${process.version})`);
}

/** 当前 dsh CLI 版本 —— profile 的 bundle 就按它锁。 */
const DSH_VERSION = flag('dsh-version', run('dsh', ['--version']).trim());
ok(`dsh ${DSH_VERSION}`);
if (!/^\d+\.\d+\.\d+/.test(DSH_VERSION)) {
  throw new Error(`dsh --version 输出不像版本号:${JSON.stringify(DSH_VERSION)}`);
}

/** 全局 node_modules —— playwright 是全局装的(不进 devDependencies)。 */
const GLOBAL_ROOT = run('npm', ['root', '-g']).trim();
const PLAYWRIGHT_ENTRY = join(GLOBAL_ROOT, '@playwright', 'test', 'index.mjs');
if (!existsSync(PLAYWRIGHT_ENTRY)) {
  throw new Error(`找不到全局 playwright:${PLAYWRIGHT_ENTRY}\n  先装:npm i -g @playwright/test`);
}
ok(`playwright ${PLAYWRIGHT_ENTRY}`);

/*
 * 浏览器用**系统 Chrome**(`channel: 'chrome'`),不下载 Chromium:
 * 本地是为了不动用户已有的浏览器缓存,CI 里是因为 GitHub 的 ubuntu runner 自带
 * google-chrome,而 `playwright install` 那一步会白拉一个 100+ MB 的浏览器。
 */
const CHROME_HINT = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p) => existsSync(p));
if (CHROME_HINT === undefined) {
  warn('没找到系统 Chrome;playwright 会尝试自己解析 channel:chrome,失败则报错');
} else {
  ok(`系统 Chrome ${CHROME_HINT}`);
}

/** dsh 的 home(profile 都住在 $DSH_HOME/profiles 下)。 */
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const PROFILE_DIR = join(DSH_HOME, 'profiles', PROFILE);
info(`DSH_HOME = ${DSH_HOME}`);

/*
 * `dsh plugin` 是 **pnpm 的包装器**:它把参数交给 PATH 上的 pnpm
 * (dsh 自己在 exit 127 时会提示「install pnpm and make it available on PATH」)。
 * 于是「PATH 上的 pnpm 是哪一个」直接决定这个测试能不能跑 —— 而这里有两个坑:
 *
 * 1. **开发机上 PATH 最前面那个 pnpm 往往是 DSH Desktop 的运行时 shim**
 *    (`…/DSH Desktop/runtime-commands/<generation>/bin/pnpm`)。那玩意儿的实现是去
 *    启动/联系 Electron App;从普通 node 进程里调用它会**挂住** —— 实测卡满 10 分钟
 *    连一行输出都没有(dsh 自己那个 12s 的锁等待都没轮到,因为卡在 shim 里)。
 * 2. **CI 上根本没有 pnpm**(见 .github/workflows/ci.yml 里那一步 `npm i -g pnpm@11`)。
 *
 * 所以这里自己解析一个**真的** pnpm,校验它能应答,并把它所在目录**前置**到
 * 子进程的 PATH —— 这样 `dsh plugin` 内部 spawn 的也是同一个。
 */

/** 跑一次 `pnpm --version` 看它是否真的能用(带超时:shim 会挂住,不能无限等)。 */
function probePnpm(executable) {
  const attempt = spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 30_000 });
  const version = (attempt.stdout ?? '').trim();
  if (attempt.status !== 0 || !/^\d+\.\d+\.\d+/.test(version)) {
    return undefined;
  }
  return version;
}

/** 找一个可用的真 pnpm;找不到就抛(附上可操作的指引,而不是让 dsh 报 127)。 */
function resolvePnpm() {
  const globalBin = join(run('npm', ['prefix', '-g']).trim(), 'bin');
  const candidates = [
    process.env.DSH_E2E_PNPM,
    join(globalBin, 'pnpm'),
    join(homedir(), 'Library', 'pnpm', 'pnpm'), // pnpm 自管的 standalone(macOS)
    '/opt/homebrew/bin/pnpm',
    '/usr/local/bin/pnpm',
    // 最后兜底:PATH 里任何一个 —— 但**跳过** Desktop 的 shim。
    ...(process.env.PATH ?? '').split(':').map((dir) => join(dir, 'pnpm')),
  ];
  const tried = [];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate === '' || !existsSync(candidate)) {
      continue;
    }
    if (/DSH Desktop[\\/]runtime-commands/.test(candidate)) {
      tried.push(`${candidate}(Desktop 运行时 shim,跳过)`);
      continue;
    }
    const version = probePnpm(candidate);
    if (version === undefined) {
      tried.push(`${candidate}(没有应答)`);
      continue;
    }
    return { executable: candidate, version };
  }
  throw new Error(`找不到可用的 pnpm。试过:\n  ${tried.join('\n  ')}\n`
    + '装一个真的:`npm i -g pnpm@11`(注意别用 DSH Desktop 的运行时 shim,它会挂住)');
}

const pnpm = resolvePnpm();
if (Number(pnpm.version.split('.')[0]) < 10) {
  warn(`pnpm ${pnpm.version} 偏老(< 10):build script 的批准机制不同,脚本会按能力自适应`);
}
ok(`pnpm ${pnpm.version} @ ${pnpm.executable}`);
// 让 dsh 内部 spawn 的 pnpm 与脚本用的是同一个。
process.env.PATH = `${dirname(pnpm.executable)}:${process.env.PATH ?? ''}`;

// ---------------------------------------------------------------------------
// 1. 清理:旧 profile 与**死锁**
// ---------------------------------------------------------------------------

step('清理旧 profile 与残留锁');

if (existsSync(PROFILE_DIR)) {
  rmSync(PROFILE_DIR, { recursive: true, force: true });
  ok(`删掉旧 profile ${PROFILE_DIR}`);
} else {
  info('没有旧 profile');
}

/**
 * 清掉写着**已死进程**的 `package.json.lock`。
 *
 * `dsh plugin add` 失败时会把这个锁留在 profile 里(内容是一个 PID),而后续每一次
 * add 都会等它 —— 表现为**永久挂住**(2026-10 实测:卡满 10 分钟无任何输出)。
 * 活进程持有的锁**绝不动**,只清死的。
 * @param dir - profile 目录。
 */
function clearStaleLock(dir) {
  const lock = join(dir, 'package.json.lock');
  if (!existsSync(lock)) {
    return;
  }
  const pid = readFileSync(lock, 'utf8').trim();
  let alive = false;
  try {
    process.kill(Number(pid), 0);
    alive = true;
  } catch {
    alive = false;
  }
  if (alive) {
    throw new Error(`profile ${dir} 的锁被活进程 ${pid} 持有,拒绝继续`);
  }
  rmSync(lock, { force: true });
  warn(`清掉死锁 ${lock}(PID ${pid} 已不在)`);
}
clearStaleLock(PROFILE_DIR);

// ---------------------------------------------------------------------------
// 2. 构建与打包 —— 测的就是要发布的那份产物
// ---------------------------------------------------------------------------

step('构建并打包(测的是 npm 上会拿到的那份文件)');

const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
info(`${pkg.name}@${pkg.version}`);

let tarball = flag('tarball');
if (tarball === undefined) {
  const buildOut = run('npm', ['run', 'build'], { cwd: REPO, stdio: 'pipe' });
  const stamp = /build (\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)/.exec(buildOut);
  ok(`构建完成${stamp === null ? '' : `(build ${stamp[1]})`}`);

  const packDir = mkdtempSync(join(tmpdir(), 'dsh-git-pack-'));
  const packed = run('npm', ['pack', '--pack-destination', packDir], { cwd: REPO }).trim();
  tarball = join(packDir, packed.split('\n').pop().trim());
  ok(`打包 ${tarball}`);
} else {
  tarball = resolve(tarball);
  info(`用现成 tarball ${tarball}`);
}
if (!existsSync(tarball)) {
  throw new Error(`tarball 不存在:${tarball}`);
}

// ---------------------------------------------------------------------------
// 3. 建 profile:从 shipped `web` 模板拷 bundle 列表,再把版本锁死
// ---------------------------------------------------------------------------

step(`建 profile ${PROFILE}(从 web 模板初始化)`);

/*
 * `--from-default-profile web` 是**官方支持的**初始化入口:它把 shipped `web` 模板的
 * bundle 列表([dsh-base, dsh-web-app])抄进新 profile,并铺好 4 个文件
 * (cordis.yml / cordis.patch.yml / package.json / pnpm-workspace.yaml)。
 * 不传它就只会拿到 `DEFAULT_PROFILE_BUNDLES` —— 那里面**没有** web app,
 * 于是 `dsh --profile X` 会静默地什么服务都不起(实测:没有任何输出)。
 */
echo('dsh', ['--profile', PROFILE, '--from-default-profile', 'web', '--dump-config']);
run('dsh', ['--profile', PROFILE, '--from-default-profile', 'web', '--dump-config'], { stdio: 'pipe' });
ok('profile 已创建');

/** profile 的 package.json。 */
const profileManifestPath = join(PROFILE_DIR, 'package.json');
const profileManifest = JSON.parse(readFileSync(profileManifestPath, 'utf8'));
const bundles = profileManifest.dsh?.profile?.bundles ?? [];
if (!bundles.includes('@deepseek-ai/dsh-web-app')) {
  throw new Error(`模板没有带 web app bundle,实际 = ${JSON.stringify(bundles)}`);
}
ok(`bundles = ${bundles.join(', ')}`);

/*
 * ⭐ **锁版本**(本脚本存在的最重要理由之一)。
 *
 * 这两个包在公开 npm 上的 `latest` 停在 `0.0.1-rc.1`(与当前 CLI 不兼容),
 * 真正对得上的是 `next` tag / 精确版本。这里直接用**本地 dsh CLI 自己的版本**去锁,
 * 于是 profile 里的 bundle 与宿主永远同版本 —— 也就是把 version skew 从根上掐掉。
 * 不写进 dependencies 的话 pnpm 不会装它们,而 CI 里没有 `$DSH_HOME/profiles/node_modules`
 * 可以蹭,profile 会起不来。
 */
profileManifest.dependencies = {
  ...profileManifest.dependencies,
  '@deepseek-ai/dsh-base': DSH_VERSION,
  '@deepseek-ai/dsh-web-app': DSH_VERSION,
};
writeFileSync(profileManifestPath, `${JSON.stringify(profileManifest, null, 2)}\n`);
ok(`dependencies 锁到 ${DSH_VERSION}`);

// ---------------------------------------------------------------------------
// 4. 安装插件 —— 用打包出来的 tarball,不是 link
// ---------------------------------------------------------------------------

step('把插件装进 profile');

/*
 * ⭐ **先过 build script 关**(两阶段,刻意不写白名单)。
 *
 * dsh 的依赖树里有一串带 install/postinstall 的包(`node-pty`、`protobufjs`、
 * `@google/genai`、`@deepseek-ai/dsh-subprocess-local`、`koffi`…)—— 而且**会随版本变**:
 * 手写一份白名单,下一个 rc 就会漂。所以这里让 pnpm 自己报、自己批:
 *
 *   1. `pnpm install` —— 只用来拿到「待批准清单」;
 *   2. `pnpm approve-builds --all` —— 把 pnpm 自己知道的待批准项写进 profile 的
 *      `pnpm-workspace.yaml`,并(在 11.x 上)立刻执行它们;
 *   3. 再 `pnpm install` 一遍 —— 10.x 的 approve 只记账不执行,这一遍才真正把
 *      node-pty 的 prebuild 等产物生成出来(幂等,已批准时是秒级空跑);
 *   4. 之后 `dsh plugin add` 才是干净的一遍。
 *
 * **两个大版本的行为不同,所以判据取自输出而不是退出码**:
 *   · pnpm 11:**致命**(`ERR_PNPM_IGNORED_BUILDS`,exit 1);
 *   · pnpm 10:同一件事只是**警告**(exit 0)。
 * 两种都靠 `Ignored build scripts:` 这一行认出来。
 */
const installAttempt = spawnSync(pnpm.executable, ['install'], { cwd: PROFILE_DIR, encoding: 'utf8' });
const installOutput = `${installAttempt.stdout ?? ''}${installAttempt.stderr ?? ''}`;
/** pnpm 打印的待批准清单(两种版本都用同一句话)。 */
const pending = [...new Set([...installOutput.matchAll(/Ignored build scripts: (.+)/g)]
  .flatMap((match) => match[1].split(',').map((name) => name.trim())))];

if (installAttempt.status !== 0 && pending.length === 0) {
  throw new Error(`pnpm install 失败:\n${installOutput.slice(-2000)}`);
}

if (pending.length === 0) {
  ok('pnpm install 一遍过(没有待批准的 build script)');
} else {
  warn(`pnpm 忽略了 ${pending.length} 个 build script,用 approve-builds 批准:${pending.join(', ')}`);
  const approve = spawnSync(pnpm.executable, ['approve-builds', '--all'], { cwd: PROFILE_DIR, encoding: 'utf8' });
  if (approve.status !== 0) {
    throw new Error(`pnpm approve-builds --all 失败:\n${approve.stdout}\n${approve.stderr}`);
  }
  const second = spawnSync(pnpm.executable, ['install'], { cwd: PROFILE_DIR, encoding: 'utf8' });
  const secondOutput = `${second.stdout ?? ''}${second.stderr ?? ''}`;
  if (second.status !== 0 || /Ignored build scripts:/.test(secondOutput)) {
    throw new Error(`批准之后再装仍然没通过:\n${secondOutput.slice(-2000)}`);
  }
  ok('build script 已批准并执行');
}

/*
 * 装 **tarball** 而不是 `link:` 当前目录:这样测的是 `npm pack` 出来的那份文件
 * (即 npm 上会拿到的东西)—— `files` 漏了什么、`lib/*.map` 混进去了,
 * 都会在这一步变成真实的加载失败。
 */
/*
 * 这一步要装 400+ 个包并跑原生构建,CI 上要几分钟。**输出捕获起来只回显尾部**:
 * 全新 profile 里 `autoInstallPeers: false` 会让 pnpm 打出上千行「missing peer」
 * 明细(那是 dsh 自己的 peer 布局,与我们无关),直接灌进 CI 日志会把有用的信息淹掉。
 * 失败时 execFileSync 会把完整输出带进异常信息里 —— 现场不丢。
 */
echo('dsh', ['plugin', '--profile', PROFILE, 'add', tarball]);
info('装 400+ 个包并跑原生构建,CI 上要几分钟…');
const addOut = run('dsh', ['plugin', '--profile', PROFILE, 'add', tarball], { stdio: 'pipe' });
info(addOut.trim().split('\n').slice(-4).join('\n  '));
clearStaleLock(PROFILE_DIR);

/** 装完之后再读一次 manifest —— `add` 应该把插件追加进 bundles(否则它不会加载)。 */
const afterManifest = JSON.parse(readFileSync(profileManifestPath, 'utf8'));
const afterBundles = afterManifest.dsh?.profile?.bundles ?? [];
if (!afterBundles.includes(pkg.name)) {
  throw new Error(`dsh plugin add 没有把 ${pkg.name} 写进 dsh.profile.bundles:实际 = ${JSON.stringify(afterBundles)}`);
}
ok(`${pkg.name} 已装入并写进 bundles`);

// ---------------------------------------------------------------------------
// 5. 无头启动,解析真实 URL
// ---------------------------------------------------------------------------

step('无头启动并等它就绪');

/**
 * 启动 dsh,等 stdout 里出现那行带端口的 URL。
 *
 * `--port 0` 让操作系统挑一个空闲端口(CI 上不会撞端口),`--no-open` 不弹浏览器。
 * 输出的形状是 `dsh web: http://127.0.0.1:<port>/?token=<token>` —— **token 必须带上**,
 * 否则页面拿不到会话。
 *
 * ⭐ `DSH_PERMISSION_MODE=danger-full-access`:profile 里那条
 * `sandbox-policy` 的 `mode` 就是读这个环境变量(默认 `workspace-write`,
 * `workspaceRoot` 取 `process.cwd()`),而**插件的 git 全部走宿主受管子进程**
 * (`ctx.subprocess`),所以宿主沙箱策略会直接决定 git 能不能跑。2026-10 在 CI 上
 * 实测:同一个仓库,本机 `git rev-parse` 说它是仓库,插件的受管路径却说
 * 「不是 git 仓库」—— Linux 的沙箱比 macOS 严,本地因此一直是绿的。
 * 这条测试判的是**插件**,不是沙箱策略(沙箱是宿主的事,有它自己的测试),
 * 所以这里把策略显式放开,让判据跨平台一致。
 *
 * `DSH_GIT_DEBUG=1` 打开插件自己的诊断开关(见 `src/host/git-runner.ts`):把每次
 * **失败**的 git 调用的 argv/cwd/退出码/stderr 打到宿主 stderr,而那些行会被下面的
 * 启动日志原样转发出来。默认关(失败在正常使用里很常见),CI 里必须开 ——
 * 否则「受管路径里的 git 为什么失败」在日志里查不到。
 * @returns 服务端进程与 URL。
 */
async function boot() {
  const child = spawn('dsh', ['--profile', PROFILE, '--no-open', '--port', '0'], {
    cwd: REPO,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DSH_PERMISSION_MODE: 'danger-full-access', DSH_GIT_DEBUG: '1' },
  });
  let out = '';
  const url = await new Promise((resolveUrl, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`启动超时(180s)。\n--- stdout ---\n${out}\n--- stderr ---\n${err}`));
    }, 180_000);
    let err = '';
    child.stdout.on('data', (chunk) => {
      out += String(chunk);
      process.stdout.write(`    │ ${String(chunk).trimEnd()}\n`);
      const match = /(http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/.exec(out);
      if (match !== null) {
        clearTimeout(timer);
        resolveUrl(match[1]);
      }
    });
    child.stderr.on('data', (chunk) => {
      err += String(chunk);
      process.stdout.write(`    │ ${String(chunk).trimEnd()}\n`);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`dsh 启动即退出(code ${code})\n--- stdout ---\n${out}\n--- stderr ---\n${err}`));
    });
  });
  return { child, url };
}

const { child: server, url } = await boot();
ok(`已就绪 ${redact(url)}`);

/** 收尾:一定要把服务端带走。 */
function stopServer() {
  if (server.exitCode === null && server.signalCode === null) {
    server.kill('SIGTERM');
  }
}
process.on('exit', stopServer);
process.on('SIGINT', () => { stopServer(); process.exit(130); });

const origin = new URL(url).origin;

/**
 * 调一条 `/dsh-git/*` 路由。
 *
 * 信封是 `{ok:true,value}` / `{ok:false,error:{code,message}}`;失败**当场抛**,
 * 这样断言点就在调用处,而不是后面某个莫名其妙的 undefined。
 *
 * ⭐ **网络层错误要重试一次**:Node 的 fetch(undici)默认复用 keep-alive 连接,
 * 而两次调用之间只要隔了一次慢操作(`git ls-remote` 那种几秒的网络往返),服务端
 * 可能已经把那条空闲连接关了 —— 复用它就会得到 `ECONNRESET`(实测踩到:
 * push 断言全过之后,那条纯属收尾的 `log` 调用把整次运行判红)。
 * 只有**没有拿到响应**才重试;拿到 `{ok:false}` 是业务失败,立即抛,不重试。
 * @param route - 路由名(相对前缀),如 `repos/add`。
 * @param body - JSON 请求体。
 * @returns 路由的 `value`。
 */
async function call(route, body) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 300));
    }
    let response;
    try {
      response = await fetch(`${origin}/dsh-git/${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
    } catch (error) {
      lastError = error;
      continue; // 连接被复用坏了:重来一次
    }
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`${route} 返回的不是 JSON(${response.status}):${text.slice(0, 200)}`);
    }
    if (json.ok !== true) {
      throw new Error(`${route} 失败:${JSON.stringify(json.error ?? json)}`);
    }
    return json.value;
  }
  throw new Error(`${route} 连不上(重试 3 次):${String(lastError)}`);
}

/*
 * 就绪探针:路由是在 storage domain 打开之后才挂上的,所以插件自己的 `health`
 * 才是「真的能用了」的判据(而不是 HTTP 200)。
 */
let health;
for (let i = 0; i < 60; i += 1) {
  try {
    health = await call('health');
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 1000));
  }
}
if (health === undefined) {
  throw new Error('60s 内 /dsh-git/health 始终没有就绪');
}
ok(`插件路由已就绪:build=${health.build} repos=${health.repos}`);

// ---------------------------------------------------------------------------
// 6. 浏览器验证(截图 = CI artifact)
// ---------------------------------------------------------------------------

step('浏览器验证:页面加载 + 本插件真的执行 + 截图');

mkdirSync(SHOTS, { recursive: true });
const { chromium } = await import(pathToFileURL(PLAYWRIGHT_ENTRY).href);
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

/** 浏览器控制台里留下的一切 —— 本插件的诊断与 host 的报错都在这里。 */
const consoleLines = [];
page.on('console', (m) => consoleLines.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => consoleLines.push(`[pageerror] ${e.message}`));

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(12_000);

/*
 * 试着关掉**首次启动的「预览版说明」弹窗**(一个全新的 DSH_HOME 一定会弹它)——
 * 它盖住整个界面,留着会让截图看起来像「页面没起来」。
 *
 * ⚠️ 但它**可能关不掉**:实测在全新 DSH_HOME 里点「继续」之后,宿主自己会提示
 * 「暂时无法保存确认状态,请重试」,弹窗原地不动(那是宿主的存储问题,与本插件无关)。
 * 所以这里**只报告事实**:关掉了就说关掉了,没关掉就如实说截图里盖着它 ——
 * 点了按钮就当成功,是一条假证据。
 */
const noticeButton = page.getByRole('button', { name: '继续' }).first();
let hadNotice = false;
let noticeGone = false;
try {
  hadNotice = await noticeButton.isVisible();
  if (hadNotice) {
    await noticeButton.click({ timeout: 5000 });
    await page.waitForTimeout(1500);
    noticeGone = await noticeButton.isHidden();
  }
} catch (error) {
  info(`处理「预览版说明」弹窗时出岔子(不影响断言):${String(error).split('\n')[0]}`);
}
if (!hadNotice) {
  info('没有「预览版说明」弹窗,直接截图');
} else if (noticeGone) {
  ok('已关掉首次启动的「预览版说明」弹窗');
} else {
  warn('「预览版说明」弹窗仍在(宿主提示「暂时无法保存确认状态」)⇒ 截图里它盖着界面');
}

/** 首屏截图。 */
const shotMain = join(SHOTS, '01-ui-loaded.png');
await page.screenshot({ path: shotMain });
ok(`截图 ${shotMain}`);

const seen = await page.evaluate(() => ({
  failedPlugins: /Failed to load plugins/i.test(document.body.innerText ?? ''),
  buttons: document.querySelectorAll('button').length,
}));

/*
 * 断言一:**不能**有 host 的插件加载失败。
 *
 * 硬依赖 `sidebarRightTabs` 那次事故,页面表现就是这一行 —— 而我们的插件是
 * **可选**依赖右侧栏的,所以任何 profile 里都不该出现它。
 */
if (seen.failedPlugins) {
  throw new Error('页面出现 "Failed to load plugins":有插件(很可能是本插件)不激活了');
}
ok('页面没有 "Failed to load plugins"');

/** 断言二:本插件的**浏览器半**确实执行了(控制台里的构建戳)。 */
const buildLine = consoleLines.find((l) => l.includes('[dsh-git] client build'));
if (buildLine === undefined) {
  throw new Error(`浏览器控制台里没有本插件的构建戳,说明 client 半没加载。\n${consoleLines.join('\n')}`);
}
ok(buildLine.replace(/^\[info\]\s*/, ''));

/*
 * 断言三:宿主真的在**服务**本插件的设置命名空间 —— 这是我们唯一的「自己的 UI」
 * 在纯 web profile 里能落地的地方(右侧栏 tab 需要 sidebarRightTabs,见下)。
 */
const servedLine = consoleLines.find((l) => l.includes('whileServed 已触发'));
if (servedLine !== undefined) {
  const served = /其中包含 dsh-git = (\w+)/.exec(servedLine);
  if (served !== null && served[1] !== 'true') {
    throw new Error('宿主没有服务 dsh-git 设置命名空间,设置卡片不会出现');
  }
  ok('宿主正在服务 dsh-git 设置命名空间');
}

/*
 * 纯 `dsh web` profile 里**没有**右侧栏提供方(`@deepseek-ai/dsh-client-ui-sidebar-right`
 * 的公开版本与宿主对不上),所以右侧栏 tab 注册不上 —— 这不是失败,是设计内的降级:
 * 插件必须照常加载,只是没有那个 tab。这条断言把「降级」与「崩掉」区分开。
 */
const degraded = consoleLines.find((l) => l.includes('没有 sidebarRightTabs'));
if (degraded !== undefined) {
  warn('该 profile 没有右侧栏提供方 ⇒ 已按可选依赖降级(插件其余能力照常)');
}

const shotButtons = seen.buttons;
info(`首屏按钮数 = ${shotButtons}`);

// ---------------------------------------------------------------------------
// 7. 路由驱动:登记仓库 → 改文件 → stage → commit
// ---------------------------------------------------------------------------

step('准备一个真仓库(test 分支的浅克隆)');

/**
 * 临时克隆放**工作区内**,不放 `os.tmpdir()`。
 *
 * ⚠️ 这是 2026-10 在 CI 上踩出来的:插件的 git 全部走宿主受管子进程
 * (`ctx.subprocess` = `dsh-subprocess-local`,见 `source/host/git-runner.ts` 头注释),
 * 那条路径**受宿主沙箱管辖** —— Linux 上把仓库放在工作区之外,`git rev-parse`
 * 直接非 0 退出,界面上表现为「这个目录不是 git 仓库」;而 macOS 的沙箱弱,
 * 同一个脚本本地跑是通的(`/tmp` 也能过)。所以这里按**用户真实的姿势**来:
 * 仓库就在工作区里。顺带这也是唯一有意义的判据 —— 沙箱本来就不允许碰工作区之外的东西。
 */
const SCRATCH_ROOT = resolve(flag('scratch-root', join(REPO, '.e2e-scratch')));
mkdirSync(SCRATCH_ROOT, { recursive: true });

/** 远端 URL:CI 里用 GITHUB_TOKEN,本地用当前 checkout 的 origin。 */
function resolveOriginUrl() {
  const explicit = flag('origin');
  if (explicit !== undefined) {
    return explicit;
  }
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (repository !== undefined && token !== undefined && token !== '') {
    return `https://x-access-token:${token}@github.com/${repository}.git`;
  }
  return run('git', ['remote', 'get-url', 'origin'], { cwd: REPO }).trim();
}

const originUrl = resolveOriginUrl();
const scratch = mkdtempSync(join(SCRATCH_ROOT, 'repo-'));
info(`临时克隆 ${scratch}(工作区内)`);
info(`远端 ${redact(originUrl)}`);

if (SKIP_PUSH) {
  /*
   * 不推送的模式:自己造一个有 remote 的仓库就够了(仍然走插件的 stage/commit 路由,
   * 只是不碰网络)。本地无凭据时用这个。
   */
  run('git', ['init', '--initial-branch', BRANCH, scratch]);
  run('git', ['remote', 'add', 'origin', originUrl], { cwd: scratch });
  writeFileSync(join(scratch, 'README.md'), '# e2e scratch\n');
} else {
  run('git', ['clone', '--depth', '1', '--single-branch', '--branch', BRANCH, originUrl, scratch]);
}
ok('临时仓库就绪');

/** commit 需要身份:CI 的 runner 上没有全局 git 身份,不配就会 commit 失败。 */
run('git', ['config', 'user.email', 'e2e@example.invalid'], { cwd: scratch });
run('git', ['config', 'user.name', 'dsh-git e2e'], { cwd: scratch });
run('git', ['config', 'commit.gpgsign', 'false'], { cwd: scratch });

/** 推送前的远端 head(独立于插件量出来的基线)。 */
function remoteHead() {
  const out = run('git', ['ls-remote', originUrl, `refs/heads/${BRANCH}`]).trim();
  return out === '' ? '(不存在)' : out.split(/\s+/)[0];
}

const headBefore = SKIP_PUSH ? '(skip)' : remoteHead();
info(`推送前 ${BRANCH} = ${headBefore}`);

step('走插件自己的路由:登记 → 改文件 → stage → commit');

/*
 * ⭐ **先登记「宿主工作区里的仓库」**(= 本 checkout),再登记临时克隆。
 *
 * 它同时是**受管路径探针**:插件的 git 走宿主受管子进程,受宿主沙箱策略管辖。
 * 如果连工作区里的仓库都登记不上,那就不是「临时目录选错了」,而是这条受管路径
 * 在这个环境里根本不通 —— 那种失败必须指名道姓地说出来,并且**附上对比证据**
 * (同一个路径,直接用本机 git 看),否则下一个人只会看到「这个目录不是 git 仓库」
 * 这种把真因藏起来的报错。
 */
const workspaceAdded = await call('repos/add', { path: REPO }).catch((error) => {
  let direct;
  try {
    direct = run('git', ['-C', REPO, 'rev-parse', '--show-toplevel']).trim();
  } catch (directError) {
    direct = `本机 git 也失败:${String(directError).split('\n')[0]}`;
  }
  throw new Error(`连宿主工作区里的仓库都登记不上:${error instanceof Error ? error.message : String(error)}\n`
    + `  · 被拒路径:${REPO}\n`
    + `  · 同一路径用本机 git 看:${direct}\n`
    + '  ⇒ 路径本身是仓库,问题出在插件的**受管子进程**(`ctx.subprocess`)这条路径上'
    + '(宿主沙箱策略 / 受管 spawn)。E2E 已用 DSH_PERMISSION_MODE=danger-full-access 启动,'
    + '若仍到这里,说明不是沙箱策略能解释的。');
});
if (workspaceAdded.added !== true) {
  throw new Error(`宿主工作区仓库登记返回了 added=false:${JSON.stringify(workspaceAdded).slice(0, 200)}`);
}
ok(`宿主工作区仓库已登记(${REPO.split('/').pop()})`);

/** 登记临时克隆(host 侧没有目录选择器,所以必须给绝对路径)。 */
const added = await call('repos/add', { path: scratch });
if (added.added !== true) {
  throw new Error(`repos/add 没有登记成功:${JSON.stringify(added).slice(0, 200)}`);
}
ok(`临时克隆已登记(清单共 ${added.repos.length} 个)`);

/** 改一个文件 —— 用时间戳保证每次内容都不同,否则第二次跑就没有变更可提交。 */
const marker = join(scratch, 'e2e-marker.txt');
const markerText = `dsh-git e2e ${new Date().toISOString()}\n`;
writeFileSync(marker, markerText);
ok('写入 e2e-marker.txt');

const statusDirty = JSON.stringify(await call('status', { path: scratch }));
if (!statusDirty.includes('e2e-marker.txt')) {
  throw new Error(`status 没看到新文件:${statusDirty.slice(0, 300)}`);
}
ok('status 看到了变更');

await call('stage', { path: scratch, files: ['e2e-marker.txt'] });
ok('stage {files:["e2e-marker.txt"]} 成功');

const message = `test(e2e): 部署测试提交 ${new Date().toISOString()}`;
await call('commit', { path: scratch, message });
ok(`commit 成功:${message}`);

/** 用**独立的** git 命令核对提交真的落地了(不信插件自己的回执)。 */
const localHead = run('git', ['rev-parse', 'HEAD'], { cwd: scratch }).trim();
const subject = run('git', ['log', '-1', '--pretty=%s'], { cwd: scratch }).trim();
if (subject !== message) {
  throw new Error(`本地 HEAD 的提交信息不是我们的:${JSON.stringify(subject)}`);
}
ok(`本地 HEAD = ${localHead.slice(0, 10)}(${subject.slice(0, 40)}…)`);

// ---------------------------------------------------------------------------
// 8. push 并独立断言远端 head 前进
// ---------------------------------------------------------------------------

if (SKIP_PUSH) {
  warn('--skip-push:跳过 push 与远端断言');
} else {
  step(`推送到 ${BRANCH} 并断言远端 head 前进`);

  await call('push', { path: scratch });
  ok('push 路由返回成功');

  const headAfter = remoteHead();
  info(`推送后 ${BRANCH} = ${headAfter}`);

  if (headAfter === headBefore) {
    throw new Error(`远端 ${BRANCH} 的 head 没有变化(${headAfter})—— push 没有真的落下去`);
  }
  if (!headAfter.startsWith(localHead)) {
    throw new Error(`远端 head(${headAfter})不是我们刚提交的那个(${localHead})`);
  }
  ok(`远端 ${BRANCH} 前进:${headBefore.slice(0, 10)} → ${headAfter.slice(0, 10)}`);

  /** 我们的提交就在远端的 HEAD 上 —— 用宿主不参与的证据链收尾。 */
  const remoteSubject = run('git', ['ls-remote', originUrl, `refs/heads/${BRANCH}`]).trim();
  info(`ls-remote 原始输出 ${remoteSubject}`);

  /** 顺带证明插件的 `log` 路由能读到这条提交。 */
  const log = await call('log', { path: scratch, limit: 1 });
  if (!JSON.stringify(log).includes(message.slice(0, 20))) {
    warn('log 路由没有回显本次提交(不影响 push 结论)');
  } else {
    ok('log 路由读到了本次提交');
  }
}

// ---------------------------------------------------------------------------
// 9. 收尾
// ---------------------------------------------------------------------------

step('收尾');

await browser.close();
stopServer();
ok('浏览器与服务端已关闭');

if (KEEP) {
  warn(`--keep:保留 profile ${PROFILE_DIR} 与克隆 ${scratch}`);
} else {
  rmSync(SCRATCH_ROOT, { recursive: true, force: true });
  rmSync(PROFILE_DIR, { recursive: true, force: true });
  ok('临时克隆与 profile 已删除');
}

console.log(`\n${tag}: 全部通过(截图在 ${SHOTS})`);
