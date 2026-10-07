/**
 * **只给浏览器半**(`tsconfig.json`)的全局:Electron 的 `__dirname`。
 *
 * 镜像 `ui/diff/index.tsx:38` 用 `__dirname` 定位「无法渲染的 diff」占位图;
 * 上游是 Electron 渲染进程,我们的替身在 `src/client/desktop-globals.ts:47`
 * 给了一个固定前缀(`/dsh-git-diff`)。
 *
 * ## 为什么单独一个文件,而不是并进 `types/desktop-globals.d.ts`
 *
 * host 程序(`tsconfig.host.json`)设了 `types: ["node"]`,而 `@types/node`
 * 自己在全局声明了 `var __dirname: string`(实证 `@types/node/module.d.ts:853`)。
 * 一个 `declare var` 与一个 `declare const` 同名会撞成 TS2451,而 host 半
 * **根本不需要**这个替身(host 跑在真 node 里,`__dirname` 是真实的)。
 * 所以按程序拆分:host 用 @types/node 的真声明,client 用这个替身。
 *
 * 本文件无 import/export ⇒ script,`declare const` 直接进全局作用域。
 *
 * @module dsh-git/types/desktop-globals-client
 */

/** Electron 的 `__dirname` 替身;值见 `src/client/desktop-globals.ts` 的同名导出。 */
declare const __dirname: string;

// ---------------------------------------------------------------------------
// 构建期被内联的静态资产(`scripts/build.mjs` 的 `loader: { '.svg': 'dataurl' }`)
// ---------------------------------------------------------------------------

/**
 * `.svg` 的**静态 import** 在浏览器半解析成一个 `data:image/svg+xml,…` 字符串。
 *
 * ## 为什么需要这条声明
 *
 * 上游 `ui/preferences/appearance.tsx` 原本用
 * `encodePathAsUrl(__dirname, 'static/ghd_light.svg')` 在**运行期**拼路径,而浏览器半
 * 那条链(`shim-node-path` + `shim-node-url`)产出的是**根相对 HTTP 路径**
 * `/dsh-git-diff/static/ghd_light.svg` —— 宿主没有这条路由 ⇒ 三张主题色板图
 * `naturalWidth === 0`(用户报的裂图)。
 * 改成**静态 import** + esbuild 的 `dataurl` loader 之后,**类型层必须跟上**:
 * 否则每个 import 就是一条 `TS2307: Cannot find module '…svg'`,而那正是
 * `scripts/check-types.mjs` 棘轮会拦下的回归(实测:补这条之前 `appearance.tsx` 7 → 9)。
 *
 * ## 为什么它落在**这个**文件
 *
 * 它是 client 专属的「构建期被替换掉的东西」,与 `__dirname` 同一个性质
 * (都是 esbuild 在打包时处理的,而 host 程序里它们要么不存在、要么是真值)。
 * 两个附带约束把它钉在这里,而不是并进 `types/client-platform-shims.d.ts`:
 *  1. `tsconfig.json` 的 `include` 里**没有** `client-platform-shims.d.ts`(它靠
 *     `desktop-globals.d.ts:1` 的 `/// <reference>` 才进程序);
 *  2. 本仓 ESLint 的 `no-restricted-syntax` **禁止 default export**
 *     (`eslint-rules/**`,实测在 `client-platform-shims.d.ts` 里写 `export default`
 *     会让 `check-lint` 新增 1 条),而 esbuild 的 `dataurl` loader 产出的**只有**
 *     默认导出(对 `.svg` 取**命名**导出会直接打包失败:
 *     `No matching export … for import "dataUrl"`)。
 *     `desktop-globals-client.d.ts` 在 `check-lint` 的基线里是 **0 条**,所以
 *     `export default` 这句不会新增违规;放在 `client-platform-shims.d.ts` 就会。
 *
 * ## 它为什么不会放宽「浏览器半禁止 import `@deepseek-ai/*`」
 *
 * 通配模块 `'*.svg'` 只匹配以 `.svg` 结尾的说明符,`@deepseek-ai/*` 一个都匹配不上
 * ⇒ 那条约束仍然由 TS2307 守着(`tsconfig.json` 的 `types: []`)。这条声明也
 * **不引入任何运行期值**:esbuild 把 import 换成内联字符串,浏览器半不多一条 `require`。
 *
 * ⚠️ **别**写成 `declare module '*.svg';`(无 body):那会把导出推成 `any`,
 * 于是「谁把 `<img src>` 接到非字符串上」这类错误会静默通过。
 *
 * ## ⚠️ 这里为什么必须 `eslint-disable-next-line`(不是为了让闸门变绿的随手压掉)
 *
 * `.eslintrc.yml:195-201` 的 C16(`no-restricted-syntax` 的
 * `ExportDefaultDeclaration`)是**全局**规则,而它的**意图**是「实现模块不许用
 * default export」——**`.d.ts` 里没有实现**,它只是在描述一个**已经存在**的导出形状。
 * 而 esbuild 的 `dataurl` loader 对 `.svg` **只**产出默认导出(取命名导出会
 * `No matching export … for import "dataUrl"` ⇒ 打包失败)。两边同时成立时,
 * **唯一**能让产物与闸门都正确的写法就是下面这一行 + 这一条豁免。
 * 本仓已有 37 处 `eslint-disable-next-line`(`src/core/desktop/ui/diff/*` 等),
 * 用的是同一种「单行、有理由」的形态。
 *
 * 判据:`docs/probes/appearance-theme-swatch-probe.mjs` 的 A1/A2 量的是这条 import
 * 真在产物里变成了 `data:` 且**解码成功**(`naturalWidth = 228 × 120`),
 * 不是「类型能否解析」。
 */
declare module '*.svg' {
  /** 该 SVG 的内联 data URL。 */
  const dataUrl: string;
  // eslint-disable-next-line no-restricted-syntax -- C16 面向实现模块;.d.ts 里只有声明,且 esbuild 的 dataurl loader 只产出默认导出(见上方说明)
  export default dataUrl;
}
