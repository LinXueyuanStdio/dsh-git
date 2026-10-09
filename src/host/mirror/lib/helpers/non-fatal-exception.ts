/**
 * **跨根转发(host 根 → client 根)** —— 上游 `lib/helpers/non-fatal-exception.ts`
 * (64 行)。⚠️ client 根那一份是**登记偏离**(85 行,**不是**逐字副本)。
 *
 * ## 为什么转发到「偏离的那一份」而不是复制上游原文
 *
 * 上游原文第 22 行是 `import { getHasOptedOutOfStats } from '../stats/stats-store'`,
 * 而 host 根的 `stats/stats-store.ts` **不存在**(host 根的遥测面是 104 行的
 * `stats/index.ts` 替身,按已决的**选项 B** 只实现 `increment`)⇒ 照抄上游原文
 * 会立刻带进一条新的 TS2307/TS2305,即「修一个缺件、造一个缺件」。
 *
 * client 根那一份逐条写明了它替换了什么:去掉遥测 opt-out 查询,投递改成可注入的
 * 宿主钩子 `setNonFatalExceptionHost()`(默认 `console.warn`),**节流逻辑逐字保留**。
 * 它自己**没有任何 import** ⇒ 转发不会拉进别的 client 模块。⇒ 这里共享那一份,
 * 使「非致命异常怎么投递」在整棵树里只有**一个**实现。
 *
 * ## 诚实边界(必须一起读)
 *
 * 1. host 半**今天没有**任何人调用 `setNonFatalExceptionHost()` —— 宿主入口的
 *    import 图**到不了**这个文件(`repository-state-cache.ts` 不在 `tsconfig.host.json`
 *    的闭包里,实测 `--listFiles`)。所以宿主半一次都不会走到这里;
 *    转发只是让**类型面**解析,不是「接上了投递」。
 * 2. 默认投递是 `console.warn`,不是 host 的 logger。真接线时应当在宿主启动处注入。
 *
 * ## 引用方
 *
 * `lib/stores/repository-state-cache.ts:25`(::213 / ::312 调用)。
 *
 * ## 退役条件
 *
 * ① host 补上遥测/日志投递面时,把这一条换成 host 自己的实现并在宿主启动处注入;
 * ② 或 `getHasOptedOutOfStats` 真的进了 host 的 stats 替身时改回上游原文逐字复制。
 *
 * @module dsh-git/host-mirror/lib/helpers/non-fatal-exception
 */

export * from '../../../../core/desktop/lib/helpers/non-fatal-exception.ts';
