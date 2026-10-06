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
