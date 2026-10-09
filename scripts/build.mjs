/**
 * dsh-git 双入口构建(照 dsh-github-workbench / dsh-client-ui-git-graph 的成熟格式):
 *   1) lib/index.js  —— host 半,ESM,node20,跑 git / 路由 / 模型调用;
 *   2) lib/client.js —— 浏览器半,CJS,包在 window.__ModuleLoader__.load 工厂里,
 *      react 与 @deepseek-ai/* 不打包,由宿主 loader 的 require 解析。
 * Desktop 校验 ModuleLoader id === package.json name,故 banner 用包名。
 *
 * 构建前先跑两条样式表自检 —— 它们拦下的两类错误都会让 esbuild 报出**指不到病根**的错:
 *   1) CSS 模板里有游离反引号 → 模板提前结束,esbuild 把 CSS 当 TS 解析;
 *   2) 重复选择器 → 后写的静默覆盖前者(曾经把左右两栏悄悄变成上下堆叠)。
 */
import { build } from 'esbuild';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  PORT_SCOPES,
  CLASS_EXCEPTIONS,
  CRITICAL_CLASSES,
  buildPortStyles,
  classCoverage,
} from './styles.mjs';
import { writeHighlighterWorkerModule } from './highlighter-worker.mjs';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

/** 仓库根(本文件在 `scripts/` 下)。{@link aliveAliasPlugin} 要用它拼替身路径。 */
const REPO = resolve(import.meta.dirname, '..');

/**
 * 构建时间戳:写进 host 注册日志与客户端控制台。
 * 加它的直接原因:无法从日志判断「运行中的是哪一版」—— host 半不参与热重载,
 * 刷新页面只换前端,于是「界面是新的、host 是旧的」极难发现。
 */
const BUILD_STAMP = new Date().toISOString().replace('T', ' ').slice(0, 19);
const define = { __BUILD_STAMP__: JSON.stringify(BUILD_STAMP) };

const banner = [
  `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkg.name)}, factory: (require) => {`,
  'var module = { exports: {} };',
  'var exports = module.exports;',
].join('\n');
const footer = '\nreturn module.exports;\n}});';

/**
 * 浏览器半的公共 esbuild 选项 —— host 半不用。
 *
 * `alias`:镜像里逐字复制的 Desktop 文件 `import * as Path from 'path'`
 * (`models/repository.ts:1`、`models/cloning-repository.ts:1`、`ui/lib/path-text.tsx:2`、
 * `ui/diff/binary-file.tsx:2`、`ui/diff/syntax-highlighting/index.ts:1`、`lib/path.ts:1`),
 * 浏览器半不能有 node 内置模块,所以把 `path` / `url` / `fs/promises`
 * 指向 `src/client/shim-node-*.ts`。这样**镜像文件保持一字不改**。
 *
 * `inject`:Desktop 的构建期全局 `__DEV__` / `__DARWIN__` / `__WIN32__` / `__LINUX__` /
 * `__dirname`。不能用 `define` —— `define` 只接受 JSON 字面量或单个标识符,
 * 而平台判断必须运行期做。`inject` 正为此设计:把自由标识符换成
 * `src/client/desktop-globals.ts` 的同名导出。
 *
 * 两者都只作用于我们自己的源码:react 系与 @deepseek-ai/* 是 external,
 * 第三方包(react-virtualized 等)不引用这些自由标识符(构建前已 grep 确认)。
 */
const clientAlias = {
  path: './src/client/shim-node-path.ts',
  url: './src/client/shim-node-url.ts',
  'fs/promises': './src/client/shim-node-fs-promises.ts',
  // `os` 的唯一使用方是上游 `ui/changes/filter-changes-list.tsx` 的 `EOL`
  // (逐字镜像的 Changes 面之一),只用于拼剪贴板路径文本。
  os: './src/client/shim-node-os.ts',
  /*
   * `util` 的唯一使用方是镜像的进度解析器
   * `src/core/desktop/lib/progress/git.ts:1` 的 `stripVTControlCharacters`。
   *
   * ⚠️ **这条 alias 今天是冗余的**(实测):esbuild 会读 `tsconfig.json` 的
   * `paths`,而 `tsconfig.json` 里已经有 `"util": ["./src/client/shim-node-util.ts"]`
   * (tsc 那半需要它,否则镜像多一条 TS2307)。写在这里是**为了让解析不依赖
   * 「esbuild 恰好也读 paths」这个隐式事实** —— 那份配置哪天被改成不读,
   * 这里仍然给出同一个替身,而不是突然变成 `Could not resolve "util"`。
   *
   * 实测代价(2026-10):把 `lib/progress/git.ts` 单独按浏览器半打一次
   * = **5,297 B / 4 个模块**(替身 + 解析器 + 它的两个步骤表)。也就是说
   * 万一有人把解析器 import 进 `src/client/**`,它会**成功**打包并带上替身,
   * 而不是报错 —— 与 `path`/`url`/`fs/promises`/`os` 四条同形。
   * 替身与真 `node:util` 的等价性由 `docs/probes/shim-node-util-probe.mjs` 钉住。
   */
  util: './src/client/shim-node-util.ts',
};

/**
 * 浏览器半的 `.svg` 一律**内联成 data URL**。
 *
 * 为什么需要(2026-10,用户报「主题这里图片加载失败了」):
 * 上游 `ui/preferences/appearance.tsx:143-144` 用
 * `encodePathAsUrl(__dirname, 'static/ghd_light.svg')` 定位那两张主题色板图,
 * 而在浏览器半那条链是 `shim-node-path.resolve` + `shim-node-url.pathToFileURL`
 * (后者**返回原串**)⇒ 产出的 `src` 是一个**根相对 HTTP 路径**
 * `/dsh-git-diff/static/ghd_light.svg`(实测;宿主只注册了 `/dsh-git` 前缀,
 * 所以那个请求必然 403/404)⇒ 三张图 **`naturalWidth === 0`**,用户看到裂图。
 *
 * `dataurl` 让那两处 `import` 在**构建期**就变成 data URL:浏览器不再发任何请求,
 * 因此**不需要**新增宿主静态路由、也**不**依赖 `__dirname` 的取值。
 *
 * ⚠️ 本 loader 只作用于**静态 import**。`encodePathAsUrl(...)` 那种**运行期拼串**
 * 的调用点(镜像里还有 6 处:`ui/diff/index.tsx:38`、`ui/changes/no-changes.tsx:54`、
 * `ui/repositories-list/repositories-list.tsx:31` 等)**不受本项影响** ——
 * 它们仍然是「指向不存在的 URL」,但那是 goal 文档 §5 已登记的
 * 「**不是**缺陷」现象(只有 `NoDiffImage` 那一张被点名),本项刻意不扩范围。
 */
const clientLoader = { '.svg': 'dataurl' };
const clientInject = ['./src/client/desktop-globals.ts'];

// react 系与 @deepseek-ai/* 由宿主 loader 提供,必须保持 external。
const clientExternal = ['react', 'react-dom', 'react-dom/*', 'react/jsx-runtime', '@deepseek-ai/*'];

/**
 * **宿主半**的 esbuild `alias`(与 `clientAlias` 同一套思路,但只作用于 host)。
 *
 * ## `byline`(2026-10-08 起:**真依赖 + 一层转换**,不再是手写替身)
 *
 * 上游 `lib/**` 的 4 个文件(`lib/file-system.ts`、`lib/progress/from-process.ts`、
 * `lib/git/{rebase,cherry-pick}.ts`)写的是 `import byline from 'byline'`。
 * 用户裁决(逐字):「**可以,使用 `@github/alive-client`、`byline`**」⇒
 * `byline@^5.0.0` 进了 `dependencies`(与上游 `app/yarn.lock:399-402` 同区间)。
 *
 * ⚠️ **装真包不会自动正确,实测**:byline 5.0.0 的 `LineStream._reencode`
 * (`node_modules/byline/lib/byline.js:144-155`)在**输出流自己没有 encoding** 时
 * 发的是 `new Buffer(line, encoding)` —— 它靠 `'pipe'` 事件继承**输入流**的
 * `_readableState.encoding`,而我们这 4 处的输入是 `process.stderr` / `process.stdout`
 * 与 `child_process.spawn` 的 stdio 管道,**实测 encoding 全是 `null`** ⇒ 发 `Buffer`
 * ⇒ `lib/progress/git.ts:219` 的 `stripVTControlCharacters(line)` 抛
 * `ERR_INVALID_ARG_TYPE`(那 4 个消费方自己的类型标注互相矛盾:`(line: string)` ×3
 * vs `(buffer: Buffer)` ×1)。
 *
 * ⇒ 边界处**一次**转换,落在 `src/host/shims/byline.ts`:它调**真包**并传
 * `{ encoding: 'utf8' }`(byline **自己的**选项,不是我们手搓的行切分)。
 * 镜像文件一个字节都不动。
 *
 * ## `byline-real`:为什么需要第二条 alias(不是风格问题)
 *
 * esbuild 的 `alias` **对 alias 目标自己的 import 也生效** —— 实测:让
 * `byline` 指向的替身 `import real from 'byline'` 会打成
 * `function wrap(stream){ return wrap(stream) }`(**构建成功、运行期无限递归**),
 * 而写成 `'byline/lib/byline.js'` 则直接构建失败
 * (`The path "byline/lib/byline.js" was remapped to "<替身>/lib/byline.js"`)。
 * ⇒ 替身必须用**一个不会被 alias 命中的说明符**去拿真包,这就是 `byline-real`。
 * 它不是 npm 上的包:类型声明在 `types/host-shims.d.ts`,映射就是下面这一行。
 *
 * ⚠️ 改这里必须同时确认两份类型层镜像(`tsconfig.host.json` 与
 * `tsconfig.host-mirror.json` 的 `paths.byline`),否则会出现「esbuild 打得出来、
 * tsc 报 TS2307」这种自相矛盾的读数。(`byline-real` 不需要 `paths`:
 * 它由 `types/host-shims.d.ts` 的 ambient module 声明顶住。)
 */
const hostAlias = {
  byline: './src/host/shims/byline.ts',
  'byline-real': './node_modules/byline/lib/byline.js',
};

/**
 * **alive 的四条相对 import,按「谁 import 的」重定向**(2026-10-08)。
 *
 * ## 为什么不能用 `alias`(实测)
 *
 * 那四条说明符是**相对**的(`./accounts-store` / `../api` / `../endpoint-capabilities` /
 * `../../models/account`),esbuild 的 `alias` 只接受**裸包名** ⇒ 实测
 * `error: Invalid alias name: "../endpoint-capabilities"`(**构建直接失败**)。
 *
 * ## 为什么必须按 importer 收窄(不是风格问题)
 *
 * 这四条说明符在宿主编译闭包里**别人也在用**:
 *   - `mirror/lib/stores/git-store.ts` / `mirror-git.ts` 用 `../models/account`;
 *   - `mirror/lib/api.ts` 自己用 `./endpoint-capabilities`(它**转发** `isDotCom`/`isGHE`),
 *     而 `mirror/models/{popup,account}.ts`、`app-state.ts`、`feature-flag.ts`、
 *     `repository-matching.ts` 又都 import `account` / `api`。
 * ⇒ 一条全局 alias 会把**整片**镜像的解析改掉。{@link aliveAliasPlugin} 只对
 * `mirror/lib/stores/alive-store.ts` 这一个 importer 生效,其余文件**一个字节不变**。
 *
 * ## 重定向到什么
 *
 * `src/host/shims/alive-lib.ts`:它转发**同一份** `Account` 与 `getDotComAPIEndpoint`,
 * 并把另外三个面缩到 `AliveStore` 真正引用的那一小块(见该文件头)。
 *
 * ⚠️ **类型层(C6)仍然会解析到真的 `accounts-store.ts`**:`tsconfig.host.json` 的
 * `paths` 对相对说明符**不生效**(实测:加了四条,诊断一条没变),所以那一条
 * TS2307(`../auth`)进了 `scripts/type-baseline.json` 的 host 段 —— 如实登记,见
 * 该文件 `$aliveNote`。
 * @type {import('esbuild').Plugin}
 */
const aliveAliasPlugin = {
  name: 'dsh-git-alive-alias',
  setup(build) {
    /** 只重定向这一个 importer 的四条相对 import。 */
    const MIRROR_ALIVE_STORE = 'src/host/mirror/lib/stores/alive-store.ts';
    const REDIRECT = new Set([
      './accounts-store',
      '../api',
      '../endpoint-capabilities',
      '../../models/account',
    ]);
    build.onResolve({ filter: /^(\.\.?\/)/ }, (args) => {
      if (!args.importer.endsWith(MIRROR_ALIVE_STORE)) {
        return null;
      }
      if (!REDIRECT.has(args.path)) {
        return null;
      }
      /*
       * ⚠️ **必须 `namespace: 'file'`**:onResolve 的返回值默认落在**当前插件**的
       * namespace 里,而 esbuild 会拿它去问下一个 `onLoad` ⇒ 实测
       * `ERROR: No loader is configured for ".ts" files`(文件根本没被读)。
       */
      return { path: resolve(REPO, 'src/host/shims/alive-lib.ts'), namespace: 'file' };
    });
  },
};


// ---------- 样式表自检 ----------

/**
 * 取出 CSS 模板字面量的内容(起始标记为 const CSS = 加一个反引号)。
 *
 * 刻意用 indexOf 而不是正则:正则字面量里放反引号会让这一行本身变成语法错
 * (这一点我踩过,所以这里连正则都不写)。
 * @param source - 源文件内容。
 * @returns 模板体,或 null(文件里没有这个模板)。
 */
function cssTemplateBody(source) {
  const tick = String.fromCharCode(96);
  const startMark = `const CSS = ${tick}`;
  const start = source.indexOf(startMark);
  if (start === -1) return null;
  const end = source.lastIndexOf(`${tick};`);
  if (end <= start) return null;
  return source.slice(start + startMark.length, end);
}

/**
 * CSS 模板里不能有游离反引号。
 * 注释里写 .gw-empty 这种反引号会让模板字符串提前结束,esbuild 随后报出
 * 「Expected ";" but found ...」,完全指不到病根。这个错犯过两次。
 * @param file - 含 CSS 模板字面量的源文件。
 */
async function checkCssTemplate(file) {
  const body = cssTemplateBody(await readFile(file, 'utf8'));
  if (body === null) return;
  const stray = (body.match(new RegExp(String.fromCharCode(96), 'g')) ?? []).length;
  if (stray > 0) {
    console.warn(`dsh-git: ${file} 的 CSS 模板里有 ${stray} 个游离反引号。`);
    console.warn('  模板会提前结束,esbuild 会把 CSS 当 TS 解析并报出误导性的语法错。');
    console.warn('  请把注释里的反引号换成别的引号。');
    process.exitCode = 1;
  }
}

/**
 * 同一份样式表里出现重复的顶层选择器 → 报警。
 * CSS 逐属性覆盖,后写的赢,所以重复几乎总是一个 bug。确认无误就在该行尾加
 * 行内出现 dup-ok 字样即视为已确认(例如写成 dup-ok: 有意覆盖)。
 * @param file - 含 CSS 模板的源文件。
 */
async function checkDuplicateSelectors(file) {
  const body = cssTemplateBody(await readFile(file, 'utf8'));
  if (body === null) return;
  const seen = new Map();
  for (const line of body.split('\n')) {
    // 只统计顶层选择器(行首无缩进);容器查询里的缩进覆盖不算
    if (/^\s/.test(line) || line.trim() === '' || line.trim().startsWith('/*')) continue;
    // 只要行内出现 dup-ok 就跳过(允许 /* dup-ok: 说明 */ 这种带解释的写法)
    if (!line.includes('{') || line.includes('dup-ok')) continue;
    const selector = line.slice(0, line.indexOf('{'));
    for (const one of selector.split(',')) {
      const key = one.trim();
      if (key === '' || key.startsWith('@')) continue;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
  }
  const dups = [...seen.entries()].filter(([, n]) => n > 1);
  if (dups.length > 0) {
    console.warn('dsh-git: 样式表里有重复选择器(后写的静默覆盖前者,逐个人工确认;');
    console.warn('  确认无误就在该行尾加 dup-ok 注释让检查静默):');
    for (const [key, n] of dups) console.warn(`  ${key} × ${n}`);
  }
}


/**
 * 扫描目录里的 .ts/.tsx(递归)。
 * @param dir - 目录。
 * @returns 文件路径数组(相对仓库根)。
 */
async function listSources(dir) {
  const { readdir } = await import('node:fs/promises');
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await listSources(path)));
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(path);
  }
  return out;
}

/**
 * 检查 TSX 内联样式里的主题令牌是否真实存在。
 *
 * 加它的原因:CSS 里的令牌我做过检查,但**内联 style** 是另一条路径 ——
 * code-view.tsx 用了 --dsw-alias-accent-primary,而该令牌在 DSH 里 0 次出现
 * (只有 --dsw-alias-brand-primary),所以目录图标一直退化成继承色,谁也没发现。
 *
 * 令牌集从 DSH 应用树里现读;读不到(例如在没装 DSH 的机器上构建)就跳过,
 * 只提示一句,不阻断构建。
 *
 * 扫描范围(2026-05 扩):以前只看 `src/client/*.ts(x)`(非递归),
 * 于是**新镜像进来的整个 Desktop diff 样式面**是盲区。现在:
 *  - `src/client/**`(含生成的 Desktop diff 样式表)→ 命中即**让构建失败**;
 *  - `src/core/desktop/**`(逐字镜像)→ 只警告,因为那是上游的文件,
 *    它引用自己的 `--text-color` 之类变量不该拦住我们的构建。
 */
async function checkInlineTokens() {
  const appRoot = '/Applications/DSH Desktop.app/Contents/Resources/app';
  let tokenSet;
  try {
    const { execFileSync } = await import('node:child_process');
    /*
     * ⚠️ **必须是「声明」(`--name:`),不是「提及」(任意出现)。** 2026-10 修:
     * 旧写法 `grep -o --dsw-alias-[a-z0-9-]+` 把**出现过**的名字全收进白名单,而宿主自己
     * 也在一条同样坏的规则里**提到**过那个错名 ⇒ 错名进了白名单,闸门放行,于是
     * `--dsw-alias-state-warning-primary`(宿主真名是 `--state-warn-primary`,
     * = `var(--dsw-static-amber-500)`)**0 处声明**却一路绿到界面(修改态图标退化成继承色)。
     * 这条是「令牌必须是宿主真实存在的」那条不变式的**唯一**守卫,它必须数**声明**。
     */
    /*
     * ⚠️ 命名空间**必须覆盖宿主真实声明的全部族**,不能只认 `--dsw-alias-`。
     * 宿主 `ui-theme` 还真实声明了 `--dsw-specific-*`(`design-platform.css`,10 个)与
     * `--dsw-focus-ring-width/-color`(`focus.css`)。它们此前**两个方向都漏**:
     *   · `styles.mjs` 的 `HOST_VARIABLE_RE` 不认它们 ⇒ 判成「未绑定变量」而拦下;
     *   · 这里也不数它们 ⇒ 若有人**真的**写了拼错的 `--dsw-specific-foo`,没有任何检查。
     * 后者更危险:只放宽 `styles.mjs` 而不放宽这里,等于对这两个族**不校验就放行**。
     * 所以两处必须同时覆盖同一组命名空间,判据仍是**声明**(不是提及)。
     */
    const NAMESPACE_RE = '--dsw-(alias|specific|focus-ring)-[a-z0-9-]+';
    const out = execFileSync('grep', ['-rhoE', '--', `${NAMESPACE_RE}[[:space:]]*:`, appRoot], {
      encoding: 'utf8', maxBuffer: 64 << 20,
    });
    tokenSet = new Set(
      out.split('\n')
        .map((line) => (line.match(new RegExp(NAMESPACE_RE)) ?? [''])[0])
        .filter((one) => one !== ''),
    );
  } catch {
    console.log('dsh-git: 读不到 DSH 安装,跳过内联令牌检查。');
    return;
  }
  /*
   * 判据夹具(构建期每次都跑)。改 `grep` 或改上面的名字提取都可能让集合**空掉**或
   * 重新把「只被提及」的名字收进来 —— 两种都让这条闸门变成橡皮图章,所以钉死两个方向:
   *   · 正向:一个**确定被声明**的宿主令牌必须在集合里(防 grep 写错 ⇒ 集合为空 ⇒ 全绿);
   *   · 负向:一个**只被提及、从未声明**的错名永远不许进集合(防退回「提及」判据)。
   * 宿主升级导致正向夹具失效时,构建失败是**正确**的:那说明我们的令牌假设需要重核。
   */
  const fixtureProblems = [];
  if (!tokenSet.has('--dsw-alias-state-warn-primary')) {
    fixtureProblems.push(
      '正向夹具失败:宿主令牌集里找不到 --dsw-alias-state-warn-primary —— ' +
        '要么 grep 的「声明」形态写错了,要么宿主真的改了名(两种情况都必须人工核)。',
    );
  }
  /*
   * 正向夹具(**命名空间扩展**):证明 `--dsw-specific-*` / `--dsw-focus-ring-*` 真的被数进来了。
   * 没有这条,上面的命名空间写法可以被悄悄写窄,而 `styles.mjs` 那边一旦放宽
   * `HOST_VARIABLE_RE`,这两个族就变成**不校验的放行** —— 正是我们刚关上的那扇门。
   */
  if (!tokenSet.has('--dsw-specific-sidebar-nav-item-active')) {
    fixtureProblems.push(
      '正向夹具失败(命名空间):宿主声明的 --dsw-specific-sidebar-nav-item-active 不在集合里 —— ' +
        '要么命名空间写法写窄了(漏了 `specific`),要么宿主改了名。',
    );
  }
  if (tokenSet.has('--dsw-alias-state-warning-primary')) {
    fixtureProblems.push(
      '负向夹具失败:--dsw-alias-state-warning-primary 只被宿主**提及**、从未被**声明**,' +
        '却进了白名单 ⇒ 判据退回成「提及」了。',
    );
  }
  if (fixtureProblems.length > 0) {
    console.warn('dsh-git: checkInlineTokens 的判据夹具失败(闸门本身不可信):');
    for (const one of fixtureProblems) console.warn(`  ${one}`);
    process.exitCode = 1;
    return;
  }
  const bad = [];
  const mirrorBad = [];
  for (const file of await listSources('src/client')) {
    const raw = await readFile(file, 'utf8');
    // 剥注释:注释里提到某个令牌名只是说明文字(我自己就写过「原来是 X」),不算使用
    const text = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const token of text.match(/--dsw-alias-[a-z0-9-]+/g) ?? []) {
      if (!tokenSet.has(token)) bad.push(`${file}: ${token}`);
    }
  }
  for (const file of await listSources('src/core/desktop')) {
    const text = await readFile(file, 'utf8');
    for (const token of text.match(/--dsw-alias-[a-z0-9-]+/g) ?? []) {
      if (!tokenSet.has(token)) mirrorBad.push(`${file}: ${token}`);
    }
  }
  if (bad.length > 0) {
    console.warn('dsh-git: 用了宿主**不存在**的主题令牌(会退化成继承色):');
    for (const one of [...new Set(bad)]) console.warn(`  ${one}`);
    process.exitCode = 1;
  }
  if (mirrorBad.length > 0) {
    console.warn('dsh-git: (仅提示)镜像里的 Desktop 代码引用了宿主没有的令牌:');
    for (const one of [...new Set(mirrorBad)].slice(0, 20)) console.warn(`  ${one}`);
  }
}


/**
 * 检查 TSX 里用到的每个**大写开头**的 JSX 标签,都能在本文件定义或导入。
 *
 * 加它的原因:esbuild **不做类型检查**,未定义的组件标识符会一路进产物,
 * 直到运行时才炸成 "X is not defined"。我自己就把一个还没写的弹层组件先引用了,
 * 构建照样通过 —— 这个检查就是为那一次加的。
 */
async function checkJsxIdentifiers() {
  const missing = [];
  const mirrorMissing = [];
  const scan = async (file, bucket) => {
    const raw = await readFile(file, 'utf8');
    // 先剥掉块注释与行注释:注释里写 <Foo> 只是说明文字,不是 JSX
    const text = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // 只取**真正的 JSX 标签**:排除 `useState<Foo>` / `Record<Foo,..>` 这类泛型参数 ——
    // 判据是 `<` 前面那个字符:紧跟标识符字符(字母/数字/_/$/`>`)的是泛型,
    // 而真正的 JSX 出现在行首、`(`、`{`、空格或 `&&` 之后。
    const used = new Set(
      [...text.matchAll(/(^|[^A-Za-z0-9_$>])<([A-Z][A-Za-z0-9]*)/gm)].map((m) => m[2]),
    );
    if (used.size === 0) return;
    const defined = new Set([
      ...[...text.matchAll(/(?:function|const|let|class)\s+([A-Z][A-Za-z0-9]*)/g)].map((m) => m[1]),
      ...[...text.matchAll(/import\s+([A-Z][A-Za-z0-9]*)\s*(?:,|from)/g)].map((m) => m[1]),
      ...[...text.matchAll(/import\s*\{([^}]*)\}/g)].flatMap((m) =>
        m[1].split(',').map((one) => one.trim().split(/\s+as\s+/).pop().trim()).filter(Boolean)),
    ]);
    // React 的内置 JSX 名与已知全局不算未定义
    for (const builtin of ['Fragment', 'React']) defined.add(builtin);
    for (const tag of used) if (!defined.has(tag)) bucket.push(`${file}: <${tag}>`);
  };
  // 本插件自己的代码(含新接线的 desktop-diff.tsx):命中即构建失败。
  for (const file of await listSources('src/client')) {
    if (file.endsWith('.tsx')) await scan(file, missing);
  }
  // 逐字镜像的上游代码:只警告。
  // 为什么值得扫:`src/core/desktop/ui/**` 是约 5,000 行新镜像进来的 JSX,而这条检查
  // 以前只看 `src/client/*.tsx`,等于**整个镜像都是盲区** —— 镜像里一个没导入的
  // 组件标识符,esbuild 不做类型检查,会一路进产物直到运行时才炸。
  // 为什么只警告:上游有它的构建期全局/我们没镜像的文件,报出来的未必是我们的错。
  for (const file of await listSources('src/core/desktop')) {
    if (file.endsWith('.tsx')) await scan(file, mirrorMissing);
  }
  if (missing.length > 0) {
    console.warn('dsh-git: 这些 JSX 标签既没在本文件定义也没导入(运行时才会炸):');
    for (const one of missing) console.warn(`  ${one}`);
    process.exitCode = 1;
  }
  if (mirrorMissing.length > 0) {
    console.warn(`dsh-git: (仅提示)镜像 src/core/desktop 里有 ${mirrorMissing.length} 处未解析的 JSX 标签:`);
    for (const one of mirrorMissing.slice(0, 20)) console.warn(`  ${one}`);
  }
}

/**
 * 从 `start` 处的开括号扫到配对的闭括号(跳过字符串字面量里的括号)。
 * @param source - 源码。
 * @param start - 开括号下标。
 * @param open - 开括号字符。
 * @param close - 闭括号字符。
 * @returns 配对闭括号的下标,找不到返回 -1。
 */
function matchBalanced(source, start, open, close) {
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      // 跳过字符串字面量(含模板字面量);模板里的 ${} 内部的括号不参与配对,
      // 但对「取一段源码」这个用途足够:插值里不会出现 className/classNames 调用。
      const end = source.indexOf(ch, i + 1);
      if (end === -1) return -1;
      i = end;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * 从 TSX 源码里抽出 `className` / `classNames(...)` 真正用到的类名。
 *
 * 两个坑,都踩过:
 *  1. 直接在整文件里抓 `'...'` 会把 import 路径、`role="cell"`、日志文案全算进来;
 *  2. 只从调用点往后取固定长度也不行 —— 会把后面兄弟元素的 `title="You can…"`
 *     一起吞进来,于是一次量出 20 多个假缺口。
 * 所以这里**先配平括号取出那次调用的完整实参**,再只从这段里取字符串字面量。
 * @param source - TSX 源码。
 * @returns 类名集合。
 */
function classNamesUsedIn(source) {
  const out = new Set();
  const anchor = /(?:className|classNames)\s*[=(]\s*/g;
  for (const m of source.matchAll(anchor)) {
    const i = m.index + m[0].length;
    const ch = source[i];
    let region;
    if (ch === '{') {
      const end = matchBalanced(source, i, '{', '}');
      region = end === -1 ? source.slice(i, i + 200) : source.slice(i, end + 1);
    } else if (ch === '(') {
      const end = matchBalanced(source, i, '(', ')');
      region = end === -1 ? source.slice(i, i + 200) : source.slice(i, end + 1);
    } else if (ch === '"' || ch === "'" || ch === '`') {
      const end = matchBalanced(source, i - 0, ch, ch);
      region = end === -1 ? source.slice(i, i + 200) : source.slice(i - 0, end + 1);
    } else {
      region = source.slice(i, i + 120);
    }
    for (const lit of region.matchAll(/'([^']*)'|"([^"]*)"|`([^`]*)`/g)) {
      const text = lit[1] ?? lit[2] ?? lit[3] ?? '';
      // 模板字面量里的 `${...}` 是插值,不是类名
      for (const token of text.split(/[\s${}]+/)) {
        if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(token) || token.length < 2) continue;
        // 类名在本仓库/Desktop 里都是小写或 kebab-case;PascalCase 一律是别的东西
        // (文案、组件名)。react-virtualized 的 `ReactVirtualized__Grid` 是唯一例外。
        if (/^[A-Z]/.test(token) && !token.includes('__')) continue;
        out.add(token);
      }
    }
  }
  return out;
}

/*
 * ---------- 移植面样式:声明式注册 ----------
 *
 * 这一整块**不再是「每条移植线都要改的代码」**,而只是一次调用:样式面的清单在
 * `scripts/styles.mjs` 的 `PORT_SURFACES` 表里。加一个移植面 = 加一条表项
 * (外加那个面的入口 SCSS),**不需要动本文件**。
 *
 * 这么做是因为 `build.mjs` 曾经是所有移植线的争用热点(同一时刻只允许一个写入者),
 * 而每条线都要加样式表。判定的语义一条没变,全部搬到 `scripts/styles.mjs`:
 *   · 编译产物里每条规则都必须落在某个移植面的作用域根之下,否则**构建失败**;
 *   · 每个移植面显式声明的**基底配方**必须在它自己的作用域下真的出现,否则**构建失败**
 *     —— `.sr-only` 那次静默破相就是「类名在、配方不在」(goal 文档 §7)。
 */

/**
 * 第 7 项预构建检查:**样式面不能悄悄消失,不能漏出作用域,不能双重前缀,
 * 根元素不能在作用域根之后,基底配方与变量都不能缺**。
 *
 * 判据(前两个原本就在这里,其余是 2026-10 架构改动时补的):
 *  1. 产物非空 —— 渲染层接上了而样式表不见了/变空,界面会一片白;
 *  2. 作用域 —— 有人往 SCSS 里加顶层裸选择器,会污染宿主界面;
 *  3. **双重前缀** —— 一条选择器里同一个作用域根出现两次 = 永不匹配
 *     (嵌套 `@import` 对 `&.switch &-item` 的产物;19 条规则因此静默失效);
 *  4. **顺序颠倒** —— `body`/`html`/`:root` 出现在作用域根**之后** = 永不匹配
 *     (嵌套 `@import` 下 `_platform.scss` 的 `body.platform-win32 &` 产物;14 条);
 *  5. **归属** —— 某个面的产物必须落在**它自己的**作用域下(比全局白名单更严);
 *  6. **变量绑定** —— 面里 `var(--x)` 引用的自定义属性必须在该面作用域下有声明
 *     (未定义 `var()` 让整条声明静默失效,goal §3 失败模式 10);
 *  7. **基底配方** —— 某个移植面声明的 `requires` 没进它自己的作用域,
 *     就是下一个 `.sr-only`。
 * 顺带报两个数字:**类覆盖率**与**合并去重的体检**。
 */
async function checkPortStyles(result) {
  if (typeof result.css !== 'string' || result.css.trim() === '') {
    console.warn('dsh-git: Desktop 移植样式表编译结果为空 —— 界面会以无样式渲染。');
    process.exitCode = 1;
    return;
  }

  // ---------- 1) 作用域检查(白名单来自注册表) ----------
  if (result.leaked.length > 0) {
    console.warn(
      `dsh-git: Desktop 移植样式里有 ${result.leaked.length} 条规则没套作用域(会污染宿主界面),` +
        `允许的根:${PORT_SCOPES.join(' / ')}:`,
    );
    for (const one of result.leaked.slice(0, 10)) console.warn(`  ${one}`);
    process.exitCode = 1;
  }

  // ---------- 2) 双重前缀(作用域根出现 >1 次) ----------
  if (result.doubleScoped.length > 0) {
    console.warn(
      `dsh-git: ${result.doubleScoped.length} 条选择器里同一个作用域根出现了两次 —— 结构上永不匹配:`,
    );
    for (const one of result.doubleScoped.slice(0, 10)) {
      console.warn(`  ${one.scope} ×${one.count}  ${one.selector}${one.afterDedupe ? '(去重后)' : ''}`);
    }
    console.warn('  根因通常是**:把上游 partial 嵌进了作用域根**(嵌套 @import 会把第二个');
    console.warn('  `&` 换成完整父选择器)。修法:入口 SCSS 顶层 import,作用域交给前缀化。');
    process.exitCode = 1;
  }

  // ---------- 3) 顺序颠倒(body/html/:root 在作用域根之后) ----------
  if (result.rootAfterScope.length > 0) {
    console.warn(
      `dsh-git: ${result.rootAfterScope.length} 条选择器把根元素放在了作用域根**之后** —— ` +
        'body/html/:root 只能是作用域根的祖先,所以永不匹配:',
    );
    for (const one of result.rootAfterScope.slice(0, 10)) {
      console.warn(`  ${one.selector}${one.afterDedupe ? '(去重后)' : ''}`);
    }
    console.warn('  上游 `mixins/_platform.scss` 的 `body.platform-* &` 就是这一类;');
    console.warn('  前缀化的正确形状是 `body.platform-win32 .gw-x …`(前缀插在根元素之后)。');
    process.exitCode = 1;
  }

  // ---------- 4) 归属:每个面只能出现自己的作用域根 ----------
  if (result.foreign.length > 0) {
    console.warn(`dsh-git: 有 ${result.foreign.length} 条规则落在**别的**移植面的作用域里:`);
    for (const one of result.foreign.slice(0, 10)) {
      console.warn(
        `  [${one.surface}] ${one.selector}` +
          (one.landsIn.length > 0 ? `  ← 落到了 ${one.landsIn.join(' / ')}` : '  ← 没有落到任何注册的作用域'),
      );
    }
    console.warn('  典型原因:某个面的入口 SCSS import 了另一个面的入口(一个面一个入口文件)。');
    process.exitCode = 1;
  }

  // ---------- 5) 变量绑定 ----------
  if (result.unboundVariables.length > 0) {
    console.warn(
      `dsh-git: ${result.unboundVariables.length} 个自定义属性被引用、但没有在**它自己的作用域下**` +
        '以正确的位置声明(整条声明会按 invalid-at-computed-value-time 丢掉,goal §3 失败模式 10):',
    );
    for (const one of result.unboundVariables.slice(0, 10)) {
      console.warn(
        `  [${one.surface}] ${one.variable}(引用 ${one.uses} 次)` +
          (one.portalHost === true ? '  ← 这是 portal 宿主面:只能声明在**作用域元素自己**身上' : ''),
      );
    }
    console.warn('  修法:在该面的入口 SCSS 里绑上它(照 `_dsh-bridge.scss` 的取值规则);');
    console.warn(
      '  portal 宿主面(`portalHost: true`)上,声明在兄弟子树里浮层继承不到,必须写在作用域元素自己身上;',
    );
    console.warn('  若它由宿主、行内 style 或插件全局提供,登记到 scripts/styles.mjs 的 VARIABLE_EXCEPTIONS 并写理由。');
    process.exitCode = 1;
  }

  // ---------- 6) 基底配方检查 ----------
  if (result.missingRecipes.length > 0) {
    console.warn('dsh-git: 有移植面声明了基底配方,但它**没有进自己的作用域** —— 规则不会生效:');
    for (const one of result.missingRecipes) {
      console.warn(`  [${one.surface}] ${one.selector}`);
      if (one.why !== undefined) console.warn(`      为什么不能缺:${one.why}`);
    }
    console.warn('  修法:在那个面的入口 SCSS 里 import 提供该配方的 partial,或就地补配方。');
    process.exitCode = 1;
  }

  // ---------- 7) 类覆盖检查 ----------
  const coverage = await classCoverage(result.css);
  const percent = coverage.total === 0 ? 0 : Math.round((coverage.covered / coverage.total) * 100);
  console.log(
    `dsh-git: Desktop 移植样式类覆盖 ${coverage.covered}/${coverage.total} (${percent}%);` +
      `未覆盖 ${coverage.missing.length} 个,其中 ${coverage.explained.length} 个有账本理由,` +
      `${coverage.unexplained.length} 个待解释`,
  );
  if (coverage.explained.length > 0) {
    console.log('  账本(未覆盖但有理由):');
    for (const token of coverage.explained) console.log(`    .${token} — ${CLASS_EXCEPTIONS.get(token)}`);
  }
  if (coverage.unexplained.length > 0) {
    // 只提示不失败:提取器天生有噪声,而「关键类」那一条已经覆盖了真正不能缺的东西。
    console.log(`  (提示)账本里没有的未覆盖类名:${coverage.unexplained.join(', ')}`);
  }

  // ---------- 8) 关键类:渲染路径**必然**用到,缺一个就是「接上了但没样式」 ----------
  const missingCritical = CRITICAL_CLASSES.filter((token) => !coverage.presentInCss.has(token));
  if (missingCritical.length > 0) {
    console.warn('dsh-git: 移植面的关键类在编译产物里找不到:');
    for (const one of missingCritical) console.warn(`  .${one}`);
    process.exitCode = 1;
  }

  // ---------- 9) 合并去重的体检(数字必须报出来,不许声称没量过的赢) ----------
  /*
   * 旧版本这里写的是「0 是预期值」,而 0 的真正原因是:diff 面与 split 面**共用入口**,
   * 整份样式被编译两遍(每个选择器出现两次、约 80KB),而旧去重逻辑按「作用域块体」找
   * 规则 —— 产物是**扁平**的,一条都找不到。现在:
   *   · 「一个面一个入口文件」把那份冗余从**源头**消掉(不是文本比较的功劳);
   *   · 文本级去重只删「删掉一定无副作用」的两类:逐字相同的定义式 at-rule 与空规则块。
   * 逐字相同的**样式规则**保守不删(两条之间夹着同特异性规则时,后者对前者的再断言
   * 会改变谁赢)—— 它们的条数与字节数下面照报,免得看起来像「已经优化干净了」。
   */
  const kept = result.keptIdenticalRules ?? [];
  const keptBytes = kept.reduce((sum, one) => sum + one.bytes * (one.copies - 1), 0);
  const keptCopies = kept.reduce((sum, one) => sum + one.copies - 1, 0);
  console.log(
    `dsh-git: 移植面 ${result.surfaces} 个,作用域 ${PORT_SCOPES.join(' + ')},` +
      `逐字相同的定义式 at-rule / 空规则块删掉 ${result.dedupedRulesRemoved} 条` +
      `(${result.dedupedBytes} 字节${result.dedupedRuleHeads.length > 0 ? `:${result.dedupedRuleHeads.slice(0, 3).join(' / ')}` : ''})`,
  );
  console.log(
    `  保守留下「同作用域内逐字相同的样式规则」${keptCopies} 条 / ${keptBytes} 字节` +
      `(${kept.length} 组;删它们不保证层叠等价,所以只记账)` +
      `;跨作用域的逐字相同规则**不是**冗余,各面必须各留一份`,
  );
}



/**
 * 第 5 项预构建检查:**移植过来的 Desktop diff 渲染层必须能为浏览器打包**。
 *
 * 这条检查原本是「它还没接线,先单独打一次包免得错误要等接线那天才暴露」。
 * **现在它已经接线了**(`src/client/desktop-diff.tsx` 引用 `diff-ui.ts`),
 * 所以这条检查的意义变成:即使将来有人把 `DesktopDiff` 从视图里摘掉,
 * 这一层自身的错误仍然会在构建期暴露。`write: false` —— 只验证,不产出多余文件。
 */
async function checkDesktopDiffUiBundles() {
  try {
    const result = await build({
      entryPoints: ['src/client/diff-ui.ts'],
      bundle: true,
      write: false,
      format: 'cjs',
      platform: 'browser',
      target: ['es2022'],
      jsx: 'automatic',
      external: clientExternal,
      mainFields: ['browser', 'main'],
      alias: clientAlias,
      loader: clientLoader,
      inject: clientInject,
      logLevel: 'silent',
    });
    const bytes = result.outputFiles.reduce((sum, f) => sum + f.contents.length, 0);
    console.log(`dsh-git: 移植的 Desktop diff UI 浏览器包自检通过 (${Math.round(bytes / 1024)}KB)`);
  } catch (error) {
    console.warn('dsh-git: 移植的 Desktop diff UI 无法为浏览器打包:');
    console.warn(error.message ?? error);
    process.exitCode = 1;
  }
}

// 移植面样式先编译(产物是 src/ 下的字符串常量模块),后面的令牌检查与打包都要用它。
// 清单在 scripts/styles.mjs 的 PORT_SURFACES;这里不再有「每个移植面一段判定」。
const styleBuild = await buildPortStyles();

/*
 * **语法高亮的 worker 也要先打**(2026-10,上游 88 行 worker.ts + 690 行模式表那一族)。
 *
 * 它产出 `src/client/highlighter-worker.generated.ts`(worker 的**源码字符串**),
 * 而浏览器半的 `src/client/shim-node-url.ts` 的 `pathToFileURL` 静态 import 它 ⇒
 * 少了这一步,`checkDesktopDiffUiBundles()` 与 `lib/client.js` 都会在解析期报
 * `Could not resolve "./highlighter-worker.generated"`。
 *
 * ⚠️ 为什么不是"一条 esbuild 插件 + 虚拟模块":探针各自有自己的 esbuild 配置,
 * 它们**没有**这条插件;而 `pathToFileURL` 在任何挂 diff 的探针里都会被求值
 * (`lib/path.ts` 只是转发)⇒ 虚拟模块会把 30+ 条探针变成 `Could not resolve`。
 * 落成**普通文件**之后,`tsc`(相对 import)、`esbuild`(相对 import)、探针三方零配置。
 * 理由与两个实测坑(模式表的 `lib/codemirror` 重定向、`require.resolve` 垫片)
 * 都写在 `scripts/highlighter-worker.mjs` 的文件头。
 */
await writeHighlighterWorkerModule();

await checkJsxIdentifiers();
await checkInlineTokens();
await checkCssTemplate('src/client/styles.ts');
await checkDuplicateSelectors('src/client/styles.ts');
await checkDesktopDiffUiBundles();
await checkPortStyles(styleBuild);

// ---------- 构建 ----------

await rm('lib', { recursive: true, force: true });
await mkdir('lib', { recursive: true });

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  /*
   * `dugite` **必须** external(2026-10-08 实测,不是推断)。
   *
   * 为什么:dugite 的 `build/lib/*.js` 是 **CommonJS**,而本构建是
   * `format: 'esm' + platform: 'node'`。esbuild 内联它之后会把自己的
   * `__require` 垫片塞进产物,而那个垫片在 ESM 输出里没有 `require` ⇒
   * 产物**加载即崩**:`Error: Dynamic require of "child_process" is not supported`
   * (复现:入口一行 `import { exec } from 'dugite'`,内联构建 exit 0 / 28,504 B、
   * 运行 exit 1;加 `external: ['dugite']` 后产物里是 `import { exec } from "dugite"`、
   * 运行 exit 0 并且真跑出 `git version 2.53.0`)。读数见
   * `docs/host-mirror-adaptation.md` §1.4。
   *
   * 代价(已登记):`package.json` 的 `files` 只有 6 项、**不发 node_modules**,
   * 所以运行期必须在 profile 的 `node_modules` 里能找到 dugite —— 它是
   * `dependencies` 的第一项,由插件安装器装(另见 `src/host/dugite-env.ts`
   * 的 git 供给决策)。
   */
  external: ['@deepseek-ai/*', 'dugite'],
  alias: hostAlias,
  // alive 的四条**相对** import 按 importer 重定向(见 {@link aliveAliasPlugin})。
  plugins: [aliveAliasPlugin],
  /*
   * 宿主半也要 `inject` Desktop 的构建期全局(2026-10-08 实测必需)。
   *
   * 接线之后 `lib/index.js` 的模块图里有上游 `lib/feature-flag.ts`,它在**模块顶层**
   * 就走 `__RELEASE_CHANNEL__ === 'beta'` ⇒ 只补类型声明挡不住运行期:
   * `node -e "import('./lib/index.js')"` 报
   * `ReferenceError: __RELEASE_CHANNEL__ is not defined`(`lib/index.js:32489`)。
   * 取值与理由逐条写在 `src/host/desktop-globals.ts`。
   *
   * ⚠️ 与客户端半是**两份**全局(`clientInject` 是
   * `src/client/desktop-globals.ts`):合并会把 `navigator`/`process.platform`
   * 交叉拖进两个 bundle。它们各自与自己的 `.d.ts` 声明同形
   * (`types/desktop-globals.d.ts` + `types/host-shims.d.ts`)。
   */
  inject: ['./src/host/desktop-globals.ts'],
  /*
   * **宿主半的 `require` 垫片(2026-10-08 实测必需,不是预防性写法)。**
   *
   * 为什么:宿主产物是 `format: 'esm'`,而镜像层把几个 **CommonJS** 依赖打了进来
   * (`deep-equal` → `object-inspect` → `require('util')`;`semver` 同族)。
   * esbuild 对 CJS 里**动态/条件式**的 `require('node内置')` 只能发出它的
   * `__require` 垫片,而那个垫片在 ESM 里的兜底是
   * `throw Error('Dynamic require of "util" is not supported')`
   * ⇒ **`lib/index.js` 加载即崩**(实测:`node -e "import('./lib/index.js')"` →
   * `Dynamic require of "util" is not supported`,栈顶在 `object-inspect/util.inspect.js`)。
   *
   * 这与 `dugite` 那条是**同一类**问题、两个不同的解法:dugite 用 `external`
   * (它还需要自己包内那份 git 的相对路径),而这里的依赖**必须**打进产物
   * (它们不是 `dependencies`,发布时 `files` 里也没有 `node_modules`)。
   * 标准解法就是在 ESM 里造一个真的 `require`:`__require` 的第一支是
   * `typeof require !== "undefined" ? require : …`,所以只要这个名字存在且可用,
   * 整条链就走正常路径。
   *
   * ⚠️ 代价(如实记账):垫片之后,**产物里任何**残留的动态 `require` 都会**成功**,
   * 而不是响亮地失败。也就是说 `external` 那条「忘了标 external 就会崩」的
   * 早期信号在宿主半被削弱了 —— 换来的是「CJS 依赖能正常跑」。判据:
   * `docs/probes/host-mirror-wiring-probe.mjs` 会**真的加载** lib/index.js,
   * 所以「加载不了」这类回归仍然会被探针抓住。
   */
  banner: {
    js: [
      "import { createRequire as __dshCreateRequire } from 'node:module';",
      'const require = __dshCreateRequire(import.meta.url);',
    ].join('\n'),
  },
  define,
});

await build({
  entryPoints: ['src/client/index.ts'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['es2022'],
  jsx: 'automatic',
  // react / react-dom / react/jsx-runtime 都是浏览器半的**平台种子模块**
  // (证据:DSH 自己的客户端产物 lib/client.js 里就有 require("react-dom")),
  // 必须标 external,否则 esbuild 会把整份 react-dom 打进我们的包。
  // react-virtualized 则相反:平台不提供,所以要**打进**包里(见 docs/desktop-inventory.md)。
  external: ['react', 'react-dom', 'react-dom/*', 'react/jsx-runtime', '@deepseek-ai/*'],
  // 必须优先 CJS 入口。react-virtualized 的 ESM 构建(dist/es)是坏的:它把
  // `bpfrpt_proptype_WindowScroller` 这类**类型符号当值** import,而那个路径解析不了,
  // esbuild 会直接报错。走 main(dist/commonjs)就干净。
  // 实测产物 451KB,其中 react 与 react-dom 保持为外部 require(交平台解析),
  // 只有 react-virtualized 自己与它的依赖被内联。
  mainFields: ['browser', 'main'],
  // 与 checkDesktopDiffUiBundles() 同一套 alias/inject/loader:一旦 diff-ui.ts 被
  // changes-view/history-view 引用,这里的配置就已经就位,不需要再改。
  alias: clientAlias,
  loader: clientLoader,
  inject: clientInject,
  define,
  banner: { js: banner },
  footer: { js: footer },
  /*
   * 浏览器半也要 sourcemap —— 而且它**不只是一个本地文件**:DSH 的
   * `@deepseek-ai/dsh-client-modules` 原生支持客户端 sourcemap
   * (`lib/index.js` 的 `readSourceMap()`:`readFileSync(`${clientPath}.map`)`,
   * 校验必须是合法 v3,再由它自己把 `sourceMappingURL` 追加到产物上;文件不存在时
   * 返回 `undefined` ⇒ map 是**可选**的,缺了不报错)。所以这一行让浏览器 devtools
   * 能直接看到我们的 TS 源码。
   *
   * ⚠️ 它**不进 npm 包**:`package.json` 的 `files` 是显式清单(`lib/index.js` +
   * `lib/client.js`),`npm pack` 里 map 数为 0 —— 本地调试 / devtools 用,不发出去。
   */
  sourcemap: true,
});

console.log(`dsh-git: lib/index.js + lib/client.js 构建完成 (build ${BUILD_STAMP})`);
