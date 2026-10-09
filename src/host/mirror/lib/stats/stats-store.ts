/**
 * **接缝文件(seam)** —— 上游 `lib/stats/stats-store.ts`(1,486 行)在 host 根的
 * **同名单入口**,转发到 host 根**唯一**的遥测替身 `./index.ts`(104 行)。
 *
 * ## 这条接缝是谁造的(实测,不是推断)
 *
 * `docs/host-mirror-wiring.md` 的接线批次把上游 `lib/stats/index.ts`(上游是 2 行桶:
 * `export ... from './stats-database'`(dexie)+ `'./stats-store'`(Central/CAFE 遥测))
 * **整份替换**成了 104 行的宿主替身 —— 于是 host 根**只有** `stats/index.ts`,
 * **没有** `stats/stats-store.ts`。而上游原文里有**两个**文件名同时被 import:
 *
 * | 说明符 | 引用方(host 根) | 上游指向 |
 * |---|---|---|
 * | `../stats` | `git-store.ts:95` · `repository-state-cache.ts:26` · `git-store-cache.ts:4` · `app-store.ts:271` · `notifications-store.ts:25` | `stats/index.ts` |
 * | `../../stats/stats-store` | **`updates/changes-state.ts:18`** | `stats/stats-store.ts` |
 *
 * ⇒ 我们替换桶的时候**只补了一个入口**,漏了第二个 ⇒ `changes-state.ts` 报
 * `TS2307: Cannot find module '../../stats/stats-store'`。这是**我们自己造的**接缝冲突,
 * 不是上游缺件(上游那个文件在,只是我们没抄 —— 抄它等于把 1,486 行遥测 + dexie 抄回来,
 * 与已决的**选项 B** 冲突)。
 *
 * ## 为什么转发到 `./index`(而**不是**转发到 client 根那份 765 行纯类型替身)
 *
 * 这是本文件唯一重要的决定,写下来:**「一份真相源」的判据是
 * 「`StatsStore`/`IStatsStore` 在 host 程序里只有一个声明」**。
 *
 * - 若转发到 `src/core/desktop/lib/stats/stats-store.ts`(765 行**纯类型**替身),
 *   宿主程序里就会同时存在 **两个** `IStatsStore` 声明:一个来自 `stats/index.ts`
 *   (`git-store.ts` / `repository-state-cache.ts` 用的是它),一个来自 client 根
 *   (`changes-state.ts` 会用后者)⇒ 同一个 `StatsStore` 实例在两条边上是**两种类型**,
 *   那正是「第二个真相源」,而且它不会报错 —— 只会让将来某次传参变成假错或漏检。
 * - 转发到 `./index` 之后:`changes-state.ts` 与 `git-store.ts` 拿到的是
 *   **同一个** `IStatsStore`(同一个 file symbol)。
 *
 * **判据(可复跑)**:`grep -rn "from '../../stats/stats-store'\|from '../stats'" src/host/mirror/`
 * 在本文件落地后,两条边都落在 `src/host/mirror/lib/stats/index.ts` 这一个文件上。
 *
 * ## 诚实边界
 *
 * 1. **它不是遥测。** 上游 `stats-store.ts` 会向 Central/CAFE 上报;`./index` 只把
 *    `increment` 记进**进程内**留痕(`takeRecordedStats()` 读得到),不落盘、不上报。
 *    这是选项 B 的既定语义,本文件**不改变**它。
 * 2. 本转发**只补名字**,不补 `stats-store.ts` 上游另外导出、而 `index.ts` 没有的名字
 *    (例如 `getHasOptedOutOfStats`)。今天 host 闭包里没有第二个引用方,需要时再补 ——
 *    而「补哪些」取决于「宿主半要不要遥测」这个仍未裁的裁决。
 *
 * ## 退役条件
 *
 * ① 决定「宿主半要遥测」时:用真的 `stats-store.ts` 实现替换 `./index`,`stats-store.ts`
 * 变成逐字副本、`index.ts` 回归上游那个 2 行桶;
 * ② 决定「不要遥测」时:把 `StatsStore`/`ILaunchStats` 从 `app-store` 的构造里删掉,
 * 本文件与 `./index` 一起消失。
 *
 * @module dsh-git/host-mirror/lib/stats/stats-store
 */

export * from './index.ts';
