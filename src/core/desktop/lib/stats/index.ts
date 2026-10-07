/**
 * **dsh-git 手写替身(shim)** —— 上游 `lib/stats/index.ts`(2 行 `export { … }`)。
 *
 * ## 上游那份为什么不能直接沿用
 *
 * 上游是遥测层的桶文件:
 *
 * ```
 * export { StatsDatabase, ILaunchStats } from './stats-database'   // import Dexie
 * export { StatsStore, IStatsStore, SamplesURL } from './stats-store'
 * ```
 *
 * `stats-database.ts` 是 **Dexie**(IndexedDB 之上的 ORM)数据库定义,
 * `stats-store.ts` 是 **1486 行**的遥测上报器(HTTP 上报 + localStorage 状态 +
 * `lib/get-architecture` / `lib/get-renderer-guid` / `lib/store` 一族)。
 * 目标文档 §1.3 明确把 `lib/stats` 列为**不沿用**的应用层。
 *
 * ## 本 shim 必须保住的名字
 *
 * 实证:Preferences 的 Advanced 页(`ui/preferences/advanced.tsx:5`)只取
 * **一个**名字:`SamplesURL`(用于「Learn more about usage data」链接)。
 *
 * | 本 shim 的导出 | 上游位置 | 形态 |
 * |---|---|---|
 * | `SamplesURL` | `lib/stats/stats-store.ts:69` | 字符串常量,**逐字** |
 *
 * `ILaunchStats` 也一并保留(逐字取自 `stats-database.ts:7`),因为它是上游这条
 * 公共路径的**类型面**,留着比删掉更接近「保留上游导出名与签名」。
 * `StatsDatabase` / `StatsStore` 两个类**刻意省略**:它们是 Dexie 与上报器的实现,
 * 浏览器半没有宿主遥测端点。
 *
 * ## 2026-10 修订:`IStatsStore` **不再**省略 —— 一条真实的移植需求推翻了原登记
 *
 * 原登记写的是「刻意省略 … IStatsStore」。**那条已作废**,理由是一条硬需求:
 * `lib/stores/repository-state-cache.ts:26` 写的是 `import { IStatsStore } from '../stats'`
 * —— **走的就是这个桶文件**。为了让那份镜像**逐字**落地(476 行,`cmp` 无输出),
 * 桶文件必须像上游一样转出这个名字;否则 476 行里唯一一个 import 解析不了,
 * 整份镜像就只能在「改上游文件」与「不镜像」之间二选一,而两者都违反 §10.3。
 *
 * 做法与上游逐字对齐:上游 `index.ts:2` 是
 * `export { StatsStore, IStatsStore, SamplesURL } from './stats-store'`,
 * 我们只砍掉 `StatsStore`(1486 行上报器,§1.3 排除),其余照写。
 * 类型本体在 `./stats-store.ts`(我们的纯类型替身;那里写了逐字区段的
 * `file:line` 来源,以及「no-op 的 `increment` 会不会让逻辑静默走偏」的核实结论)。
 *
 * ⚠️ 更正一处**本来就不准**的旧记述:上一版这里写「`ILaunchStats` / `IDailyMeasures`
 * 等类型也一并保留」,而 `IDailyMeasures` 当时**并不在本文件里**。现在它在
 * `./stats-store.ts`(它是 `NumericMeasures` 的基数,必须挨着它)。
 *
 * ⚠️ 与上游的**唯一**形状差异:上游 `index.ts:1` 还转出
 * `export { StatsDatabase, ILaunchStats } from './stats-database'`,我们**没有**
 * `./stats-database.ts` 这个文件(它是 Dexie 定义,§1.3 排除),所以 `ILaunchStats`
 * 就地声明在本文件、`IDailyMeasures` 落在 `./stats-store.ts`。
 * 这是**登记过的偏离**,不是遗漏。
 * @module dsh-git/core/desktop/lib/stats
 */

/**
 * The timing stats for app launch.
 * —— 上游 `lib/stats/stats-database.ts:7`,逐字。
 */
export interface ILaunchStats {
  /**
   * The time (in milliseconds) it takes from when our main process code is
   * first loaded until the app `ready` event is emitted.
   */
  readonly mainReadyTime: number

  /**
   * The time (in milliseconds) it takes from when loading begins to loading
   * end.
   */
  readonly loadTime: number

  /**
   * The time (in milliseconds) it takes from when our renderer process code is
   * first loaded until the renderer `ready` event is emitted.
   */
  readonly rendererReadyTime: number
}

/**
 * The URL to the stats samples page.
 * —— 上游 `lib/stats/stats-store.ts:69`,逐字(`SamplesURL` 的**唯一**使用方是
 * `ui/preferences/advanced.tsx` 的「usage data」说明链接)。
 */
export const SamplesURL =
  'https://github.com/desktop/desktop/blob/development/docs/process/usage-data.md'

/**
 * 上游 `lib/stats/index.ts:2` 的转出,沿用(只去掉 `StatsStore` 那个类)。
 *
 * 为什么需要它:`lib/stores/repository-state-cache.ts:26` 的
 * `import { IStatsStore } from '../stats'` **就是打在这里**。既然那份 476 行的镜像
 * 已经逐字落地,这个转出就是它存在的**唯一**理由(实证,不是预留)。
 */
export { IStatsStore } from './stats-store'
