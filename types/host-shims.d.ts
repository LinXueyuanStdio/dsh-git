/**
 * **只给 host 半**(`tsconfig.host.json`)的缺类型模块声明。
 *
 * 由 `types: ["node"]` 提供 node 内置与 node 全局,所以这里只补
 * 「存在但仓库里没有类型来源」的运行时模块。
 *
 * 简写 ambient module(`declare module 'x';`,无 body)对**命名导入**也返回
 * `any`,所以不用逐个猜导出名 —— `src/index.ts` 的
 * `import type { Context } from '@deepseek-ai/cordis'` 因此能通过。
 *
 * 显式给 `Context` 一个 `any` **类型别名**,而不是用空 body 的简写 ambient module
 * (`declare module 'x';`)。原因:`src/index.ts:190` 写的是
 * `export function apply(ctx: Context, …)` —— 简写形式让命名导入变成
 * 「值层面的 any」,**不能当类型用**,于是会报 TS2709
 * `Cannot use namespace 'Context' as a type`(连带 17 行的 import 被判成未使用)。
 * 那是**替身写法自己造出来的假错**,不是真实缺陷。
 *
 * `src/index.ts` 是**唯一**从该模块 import 的文件,而且只取 `Context` 一个名字,
 * 所以一个显式别名就够;将来宿主给了真实类型包,把这一行删掉即可。
 *
 * ## 代价(这条检查因此抓不到什么)
 *
 * `any` 是透明的:凡是从这里进来的值都不参与类型检查。具体是
 * **DSH 宿主注入的 `Context` 与插件 API 的形状完全不受检**。
 * 要恢复它只能等 DSH 提供类型包(或我们手写一份最小接口声明)。
 * 这是**已知且刻意**的取舍:本检查的目标是 prop 级缺陷可达性,
 * 不是给宿主编一套类型。见 `docs/type-check.md` §4。
 *
 * ## 为什么不给 client 程序也声明它
 *
 * `@deepseek-ai/*` 是**平台种子模块**,浏览器半**禁止静态 import**(`docs/goal-port-desktop.md`
 * §2.3)。client 程序故意不给它任何声明 —— 一旦有客户端文件 import 它,
 * 就会得到 TS2307。这是那条硬约束的机器检查的一部分。
 *
 * @module dsh-git/types/host-shims
 */

declare module '@deepseek-ai/cordis' {
  /** DSH 宿主注入的 cordis 插件上下文(`src/index.ts` 的 `apply(ctx, config)`)。 */
  export type Context = any;
}

/**
 * ## 只给宿主镜像的两个构建期常量(2026-10-08 新增)
 *
 * `src/host/mirror/**` 是上游原文,它引用了上游打包期由 webpack `DefinePlugin`
 * 替换掉的自由标识符。`types/desktop-globals.d.ts` 已经声明了 `__DEV__` /
 * `__DARWIN__` / `__WIN32__` / `__LINUX__`(client 与 host 共用),这里补上
 * **只有宿主镜像用到**的两个:
 *
 * | 名字 | 上游用在哪 | 宿主半的取值 |
 * |---|---|---|
 * | `__APP_NAME__` | `lib/git/clone.ts:81`(`clone --origin` 的默认目录名回落) | **没有真身** —— 见下 |
 * | `__RELEASE_CHANNEL__` | `lib/feature-flag.ts:30,42`(beta/test 通道判定) | **没有真身** —— 见下 |
 *
 * ⚠️ **声明不等于有实现**。宿主 bundle 目前**不** `define` 这两个名字
 * (我们的构建只有 `__BUILD_STAMP__`),所以它们在运行期是**未声明的自由标识符**:
 * `typeof __APP_NAME__` 会抛 `ReferenceError`。上游那两处的调用路径今天是
 * 「本仓未接线」的(`clone` 路由与 `feature-flag` 的 beta 判定都不在 push/fetch
 * 这条链上),所以这条**不会**在已接线的路径上炸;但它是一个**已知缺口**,
 * 退役条件写在 `docs/host-mirror-wiring.md` 的「未做的部分」一节:
 * 要么在 `scripts/build.mjs` 的 `define` 里补上真值,要么把那两处改成读宿主配置。
 *
 * **为什么不放进 `types/desktop-globals.d.ts`**:那个文件是 client 程序
 * **也**包含的。把只给宿主镜像的两个名字放进去,会让 client 程序里
 * 「镜像引用了一个我们没注入的全局」这条信号被静默满足
 * (与 `docs/type-check.md` §4 的取舍同形)。
 */

/** 上游打包期注入的应用名(宿主半**没有**真身,见上表)。 */
declare const __APP_NAME__: string;

/** 上游打包期注入的发布通道(`'development' | 'beta' | 'test' | 'production'`;宿主半**没有**真身)。 */
declare const __RELEASE_CHANNEL__: string;

/**
 * ## `byline-real`:**不是 npm 上的包**,是 `scripts/build.mjs` 的 `hostAlias` 里
 * 那第二条映射的名字(2026-10-08,byline 改成真依赖时新增)。
 *
 * ### 为什么需要这个名字
 *
 * esbuild 的 `alias` **对 alias 目标自己的 import 也生效**(实测):
 * `byline` 指向的替身 `src/host/shims/byline.ts` 若要 `import real from 'byline'`,
 * 打出来的是 `function wrap(stream){ return wrap(stream) }` —— **构建成功、
 * 运行期无限递归**;写成 `'byline/lib/byline.js'` 则构建直接失败
 * (`The path "byline/lib/byline.js" was remapped to "<替身>/lib/byline.js"`)。
 * ⇒ 替身必须用一个**不会被 alias 命中**的说明符去拿真包。
 *
 * ### 为什么用 ambient 声明而不是 `allowJs: true`
 *
 * 另一条路是让替身相对 import `../../node_modules/byline/lib/byline.js` 并打开
 * `allowJs`。那会**同时**改两个程序(`tsconfig.host.json` 与
 * `tsconfig.host-mirror.json`)的编译语义 —— `allowJs` 会让别处「import 一个 .js」
 * 从 TS2307 变成可解析,而那是一条现存的机器检查。这里的声明只覆盖
 * **我们真正用到的那一个签名**,语义面最小。
 *
 * ### 诚实边界
 *
 * 这一份声明是 byline API 的**第二份真源**(真身在
 * `node_modules/byline/lib/byline.js`)⇒ 所以只声明替身调用的形状。
 * **退役条件**:上游把 byline 从 `app/package.json` 摘掉(或我们不再需要那 4 处)时,
 * 删掉这一整段与 `scripts/build.mjs` 的 `byline` / `byline-real` 两条 alias。
 */
declare module 'byline-real' {
  /**
   * byline 的工厂:把一个可读流按行重新发射。
   *
   * ⚠️ 这里用 `export =` 而**不是** `export default` —— 两个原因:
   *  1. 真包是 **CommonJS**(`module.exports = function(readStream, options)`),
   *     `export =` 就是它的诚实形状(调用方 `import real from 'byline-real'` 在
   *     `esModuleInterop: true` 下照旧成立);
   *  2. `.eslintrc.yml:195-201` 的 `no-restricted-syntax` **全局**禁止
   *     `ExportDefaultDeclaration`(C16,逐字沿用上游)。写 `export default` 会
   *     新增一条 lint 违规 —— 而这条规则**不该**为一处 ambient 声明开口子。
   */
  function byline(
    readStream: NodeJS.ReadableStream,
    options?: { readonly encoding?: BufferEncoding; readonly keepEmptyLines?: boolean },
  ): NodeJS.ReadableStream;
  export = byline;
}
