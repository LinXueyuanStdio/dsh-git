/**
 * 构建期把资源 import 成值的那几条的**类型声明**。
 *
 * ## 为什么必须有这个文件
 *
 * `scripts/build.mjs` 的 `clientLoader` 让 esbuild 把资源当**值**处理:
 *
 * | 扩展名 | loader | 产物 |
 * |---|---|---|
 * | `.svg` | `dataurl` | `data:image/svg+xml;base64,…` 字符串 |
 * | `.css` | `text` | 文件原文(字符串) |
 *
 * esbuild **不做类型检查**,所以这些 `import` 在构建期一直是好的;但 `tsc` 看到
 * `import markdownCss from './static/markdown.css'` 只会报 **TS2307** ——
 * 而那不是产品缺陷,是「构建器的约定没有镜像到类型层」。
 * 这份文件就是那面镜子。
 *
 * ## 只声明真的在用的那两条
 *
 * 不写通配的 `declare module '*'`。每加一条 loader 就加一行,并且**写明它的产物
 * 类型**(`string`),这样「哪天有人把 `.css` 的产物当对象用」会在类型层被挡住。
 *
 * ⚠️ 它不是「什么都收」的兜底:本仓的 `check-types` 会把**新增**诊断判红,
 * 所以一份过宽的声明会让真正的 TS2307 从此不再出现 —— 那比不写更糟。
 *
 * @module dsh-git/client/asset-modules
 */

/** `.svg` ⇒ `clientLoader` 的 `dataurl` 产出的 data URL 字符串。 */
declare module '*.svg' {
  const dataUrl: string
  export = dataUrl
}

/** `.css` ⇒ `clientLoader` 的 `text` 产出的文件原文。 */
declare module '*.css' {
  const text: string
  export = text
}
