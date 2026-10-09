/**
 * **语法高亮 worker 的打包 + 内联**(2026-10,用户指令「语法高亮 也要做。语法高亮上游也有啊」)。
 *
 * ## 它做的是哪件事
 *
 * 上游 GitHub Desktop 把高亮拆成**两个**产物:
 *  1. `app/src/lib/highlighter/worker.ts`(88 行)—— 主线程这一半,起一个 Web Worker、
 *     5 秒超时、空闲 worker 池;它只做 `new Worker(workerUri)`,不碰 CodeMirror;
 *  2. `app/src/highlighter/index.ts`(690 行)—— **worker 里**那一半: CodeMirror 的
 *     「扩展名/文件名 → mime → 模式」表 + `runMode` 式的逐行分词,回 `ITokens`。
 *     上游用 webpack 的**第二个 entry**(`webpack.common.ts:137-195`,
 *     `target: 'webworker'`)把它打成 `highlighter.js`(+ 懒加载 chunk `highlighter/*.js`)。
 *
 * 我们的宿主是 DSH 的客户端模块系统(`@deepseek-ai/dsh-client-modules`):它只服务
 * **一个** 包内入口(`lib/client.js`)+ 名字必须叫 `client.<x>.js` 的包内 chunk,而
 * `worker.ts` 是**逐字照抄**的上游文件(它的 `new Worker(encodePathAsUrl(__dirname, 'highlighter.js'))`
 * 不接受任何我们的说明符)⇒ 不能"在中间塞一层加载器"。
 *
 * ## 所以 worker 源码怎么到浏览器里
 *
 * 打成**一个自足 IIFE**(不切片:`splitting:false`,动态 `import()` 由 esbuild 内联成
 * `Promise.resolve().then(() => init_x())`),再把它的**源码字符串**写进
 * `src/client/highlighter-worker.generated.ts`;浏览器半在**运行期**用
 * `new Blob([源码])` + `URL.createObjectURL` 换成 blob URL,交给上游那行
 * `new Worker(workerUri)`(`src/client/shim-node-url.ts` 的 `pathToFileURL` 是那条链上
 * 唯一的同步 hook,映射写在那个文件里,理由也写在那里)。
 *
 * 为什么不落一个 `lib/highlighter.js` 让宿主发?——宿主只有两条路:包内入口
 * `lib/client.js`、包内 chunk `/plugins/<id>/client.<name>.js?rev=<sha1>`;
 * 后者要求**在运行期知道那一次构建的 rev**,而 `worker.ts` 是逐字上游、不能自己去查 ——
 * 唯一的办法是改宿主(chunk 路由/静态路由)⇒ 要重启 DSH,而且探针就没法在
 * `file://` 页面里复现"产品那条解析路径"了。blob URL 不需要宿主任何改动,
 * 也不需要重启,而且**探针测的就是产品那条路径**(真 `lib/path.ts` → 真 shim → 真 Worker)。
 *
 * ## ⚠️ 两个非踩不可的坑(都是实测出来的,不是预防性写法)
 *
 * 1. **`codemirror$` 必须重定向到 `runmode.node.js`**。CodeMirror 5 的每一个模式都写
 *    `require('../../lib/codemirror')`,而 `codemirror/lib/codemirror.js` 是**整个编辑器**
 *    (要 DOM、要 `document`)。worker 里没有 DOM。上游 webpack 用 4 条 `resolve.alias`
 *    (`webpack.common.ts:188-193`)把它们换成 `addon/runmode/runmode.node.js`
 *    —— 这里逐条复刻那 4 条(不是"顺手写个正则"):
 *    `codemirror` / `../lib/codemirror` / `../../lib/codemirror` / `../../addon/runmode/runmode`。
 *    **反例(实测)**:不重定向时产物里同时进了 `lib/codemirror.js`(**要 DOM**),
 *    而且体积从 405 KB 涨到 593 KB。
 * 2. **`require.resolve` / `require.cache` 要有一个垫片**。`runmode.node.js:243-244`
 *    在**模块顶层**就写 `require.cache[require.resolve("../../lib/codemirror")] = …`
 *    —— webpack 的模块壳提供这两个成员,esbuild 的 `__require` 不提供 ⇒ 实测 worker
 *    一启动就 `TypeError: __require.resolve is not a function`(真 Chrome 里表现为
 *    `Pe.resolve is not a function`)。banner 里那 4 行给出最小等价物:
 *    `resolve` 恒等回原串、`cache` 是个空对象。**它今天没有活的消费者**
 *    (所有 模式→codemirror 的边都被上面那 4 条 alias 静态重定向了),存在的唯一理由是
 *    不让那个上游模块在求值期抛错。
 *
 * ## ❌ 明确不做的事
 *
 * - **不手写词法器**(用户指令原话:「语法高亮上游也有啊,你还问我」)。这里只有打包;
 *   模式表逐字来自上游 `highlighter/index.ts`;
 * - **不新增第二份真源**:依赖版本对齐上游 `app/package.json`
 *   (`codemirror@5.65.17` / `codemirror-mode-{elixir,luau,zig}`),模式表本身不复制。
 *
 * @module dsh-git/scripts/highlighter-worker
 */

import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** 仓库根(本文件在 `scripts/` 下)。 */
const REPO = resolve(import.meta.dirname, '..');

/** worker 那一半的入口(上游 `app/src/highlighter/index.ts`,在镜像里同构同路径)。 */
export const HIGHLIGHTER_ENTRY = 'src/core/desktop/highlighter/index.ts';

/** 生成物:worker 源码字符串,由浏览器半的 shim 消费。 */
export const HIGHLIGHTER_GENERATED = 'src/client/highlighter-worker.generated.ts';

/** 上游 `webpack.common.ts:188-193` 的 4 条 alias,逐条复刻。 */
const CODEMIRROR_ALIASES = new Set([
  'codemirror',
  '../lib/codemirror',
  '../../lib/codemirror',
  '../../addon/runmode/runmode',
]);

/** `codemirror/addon/runmode/runmode.node.js` —— 唯一能进 worker 的 CodeMirror 子集。 */
const RUNMODE_NODE = resolve(REPO, 'node_modules/codemirror/addon/runmode/runmode.node.js');

/**
 * `require` 的最小垫片(见文件头坑 2)。它必须是 **banner**(在 IIFE 之前),
 * 因为 esbuild 的 `__require` 初始化成 `typeof require !== "undefined" ? require : …`
 * 是在**模块体求值之前**跑的。
 */
const REQUIRE_BANNER = [
  'var require = (function () {',
  '  var r = function (id) { throw new Error("Dynamic require of " + id + " is not supported"); };',
  '  r.resolve = function (id) { return id; };',
  '  r.cache = {};',
  '  return r;',
  '})();',
].join('\n');

/**
 * 把 CodeMirror 的 4 条 `lib/codemirror` 说明符重定向到 node runmode 子集。
 * @returns {import('esbuild').Plugin} esbuild 插件。
 */
function codemirrorRunModePlugin() {
  return {
    name: 'dsh-git-codemirror-runmode',
    setup(build_) {
      build_.onResolve({ filter: /^[./A-Za-z]+$/ }, (args) => {
        if (!CODEMIRROR_ALIASES.has(args.path)) {
          return null;
        }
        /*
         * `namespace: 'file'` 是必需的:onResolve 的返回值默认落在**本插件**的
         * namespace 里,esbuild 会拿它去问下一个 onLoad ⇒ 实测
         * `ERROR: No loader is configured for ".js" files`。
         * （同 `scripts/build.mjs` 的 `aliveAliasPlugin` 里记的那一条。）
         */
        return { path: RUNMODE_NODE, namespace: 'file' };
      });
    },
  };
}

/**
 * 打一次 worker 产物,返回它的**源码文本**(IIFE)。
 *
 * 关键选项与理由:
 *  - `format: 'iife'`:worker 脚本不能用 ESM 输出(blob URL 走 classic worker),
 *    而且上游那半文件本来就是「模块顶层 `onmessage = …`」的脚本语义;
 *  - `splitting: false`(默认):`install: () => import('…')` 那 58 条懒加载会被内联成
 *    同步 require 的 Promise 壳 —— blob URL 里没有相对路径可言,切片必然 404;
 *  - `minify: true`:产物从 1,277 KB 降到 **405 KB**(实测),内联进 `lib/client.js`
 *    的代价就是这个字符串;
 *  - `platform: 'browser'` + `target: 'es2022'`:与浏览器半同档。
 *
 * @returns {Promise<string>} worker 的 IIFE 源码。
 */
export async function buildHighlighterWorkerSource() {
  const result = await build({
    absWorkingDir: REPO,
    entryPoints: [HIGHLIGHTER_ENTRY],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: ['es2022'],
    minify: true,
    legalComments: 'none',
    logLevel: 'warning',
    plugins: [codemirrorRunModePlugin()],
    banner: { js: REQUIRE_BANNER },
  });
  return result.outputFiles.map((file) => file.text).join('\n');
}

/**
 * 生成 `src/client/highlighter-worker.generated.ts`。
 *
 * **幂等**:产物里不含时间戳/绝对路径(esbuild 的输出对同一份输入逐字节稳定),
 * 所以「重跑一次构建不产生变化」这条(上游 CI 的 clean-working-tree 等价物,
 * 见 `scripts/check-generated.mjs`)对它是成立的。
 *
 * @param {{quiet?: boolean}} [options] - `quiet` 时不打印。
 * @returns {Promise<{bytes: number, workerBytes: number, unchanged: boolean}>} 读数。
 */
export async function writeHighlighterWorkerModule(options = {}) {
  const source = await buildHighlighterWorkerSource();
  const contents = renderGeneratedModule(source);
  const file = resolve(REPO, HIGHLIGHTER_GENERATED);
  let previous = null;
  try {
    previous = await readFile(file, 'utf8');
  } catch {
    /* 第一次生成 */
  }
  const unchanged = previous === contents;
  await writeFile(file, contents, 'utf8');
  if (!(options.quiet ?? false)) {
    console.log(
      `dsh-git: ${HIGHLIGHTER_GENERATED} 就绪(worker ${Math.round(source.length / 1024)}KB,` +
        `模块 ${Math.round(contents.length / 1024)}KB${unchanged ? ',与磁盘上逐字节相同' : ''})`,
    );
  }
  return { bytes: contents.length, workerBytes: source.length, unchanged };
}

/**
 * 生成物的**正文**(表头 + 一行 `export const`)。
 *
 * 刻意用 `JSON.stringify` 而不是模板字面量:模板字面量会把 worker 源码里的
 * `${` / 反引号变成转义雷区,而 `scripts/check-template-literals` 那条闸门也就不用
 * 为这个文件开洞(它一个反引号都不含)。
 *
 * @param {string} source - worker IIFE 源码。
 * @returns {string} TypeScript 模块文本。
 */
function renderGeneratedModule(source) {
  const header = [
    '/**',
    ' * **生成物,不要手改。**',
    ' *',
    ' * 由 `scripts/build.mjs` 调 `scripts/highlighter-worker.mjs` 生成:把上游',
    ' * `app/src/highlighter/index.ts`(690 行,CodeMirror 模式表 + 逐行分词)**打成',
    ' * 一个自足的 worker IIFE**,以字符串形式内联在这里。',
    ' *',
    ' * 为什么是字符串:`lib/highlighter/worker.ts`(上游 88 行,逐字照抄)只做',
    ' * `new Worker(encodePathAsUrl(__dirname, \'highlighter.js\'))` —— 它必须保持与上游',
    ' * 字节一致,不能改成一个我们的加载器说明符;而宿主只服务包内入口与',
    ' * `client.<name>.js` 包内 chunk(后者要运行期 rev)⇒ 浏览器半用',
    ' * `URL.createObjectURL(new Blob([本字符串]))` 换成 blob URL 交给那行 `new Worker`。',
    ' * 完整理由与两个实测坑见 `scripts/highlighter-worker.mjs` 的文件头。',
    ' *',
    ' * 改高亮请改上游那一半(`src/core/desktop/highlighter/index.ts`,与上游逐字一致);',
    ' * 改打包请改 `scripts/highlighter-worker.mjs`。',
    ' *',
    ' * @module dsh-git/client/highlighter-worker.generated',
    ' */',
    '',
  ].join('\n');
  return `${header}export const HIGHLIGHTER_WORKER_SOURCE = ${JSON.stringify(source)}\n`;
}
