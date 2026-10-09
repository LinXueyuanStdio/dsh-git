/**
 * **dsh-git 手写替身(host 半)** —— 上游 `lib/stats/index.ts`(2 行桶)+
 * `lib/stats/stats-store.ts` / `lib/stats/stats-database.ts`。
 *
 * ## 上游那份为什么不能沿用
 *
 * `lib/stats/index.ts` 只有两行 `export ... from './stats-database'` 与
 * `'./stats-store'`,而 `stats-database.ts` 的底座是 **dexie**(IndexedDB),
 * `stats-store.ts` 是**遥测上报**(Central → CAFE)。两者在宿主半都没有落点:
 * 宿主的持久化在 `src/host/repo-registry.ts` 一族,遥测面本仓**根本没有**
 * (`docs/host-mirror-adaptation.md` §4.2 把 dexie 记成「产品裁决 + 架构替换」)。
 *
 * ## 谁真的需要它
 *
 * 整片 host 镜像里对 `../stats` 的引用只有 **3 个名字**:
 *
 * | 名字 | 引用方 | 用途 |
 * |---|---|---|
 * | `IStatsStore` | `lib/stores/git-store.ts:95`、`git-store-cache.ts`、`repository-state-cache.ts` | 构造参数的类型 |
 * | `StatsStore` | `lib/stores/app-store.ts:271`、`notifications-store.ts:25` | 字段/构造参数的类型 |
 * | `ILaunchStats` | `lib/stores/app-store.ts:271`(`_recordLaunchStats(stats)`) | 参数类型 |
 *
 * 三者**都只作类型使用**,没有任何一处读它的字段(实测:`grep -n 'statsStore\.'`
 * 只有 `increment(...)` 一种调用)。所以一个「记录了但什么都不做」的实现
 * 在类型面与运行面都是自洽的 —— 而且它**不是静默**:每次 `increment` 都被
 * 记进 {@link getRecordedStats},探针可以断言「上游真的调了 recordPush」。
 *
 * ## 诚实边界
 *
 * 1. **不上报**任何东西(没有 Central/CAFE 面)。这是**今天的现状**:
 *    宿主半从来没有遥测。
 * 2. 计数**只在进程内**、**不落盘**(上游落 IndexedDB)。
 * 3. `StatsStore` 的构造签名是「收任意参数」—— 上游是 `(db, uiActivityMonitor, post)`。
 *    刻意不逐字复刻:那三个类型来自 dexie 与 Electron 面,复刻它们等于把
 *    整条链抄进来,而这里**一个字段都不读**。
 *
 * ## 退役条件
 *
 * 决定「宿主半要不要遥测」时:要 ⇒ 换一份走宿主存储/上报面的真实现;
 * 不要 ⇒ 把 `StatsStore`/`ILaunchStats` 从 app-store 的构造里删掉。
 * 两种结局都会让本文件消失。
 *
 * @module dsh-git/host-mirror/lib/stats
 */

/** 上游 `stats-store.ts` 的 `NumericMeasures` 键集在这半边**不逐字复刻**(见文件头第 3 条)。 */
export type NumericMeasures = Record<string, number>;

/**
 * 上游 `stats-store.ts:496` 的 `IStatsStore`,逐字保留唯一那个方法。
 *
 * 上游是 `increment: (k: keyof NumericMeasures, n?: number) => Promise<void>`。
 */
export interface IStatsStore {
  /** 记一次计数(宿主半只记在内存里)。 */
  increment: (k: keyof NumericMeasures, n?: number) => Promise<void>;
}

/** 上游 `stats-database.ts` 的 `ILaunchStats`(启动统计的载荷)。 */
export type ILaunchStats = Readonly<Record<string, number>>;

/** 进程内的计数留痕:`键 → 次数`。**只为探针与诊断存在**,不落盘。 */
const recorded = new Map<string, number>();

/**
 * 读走当前留痕并清空(探针用)。
 *
 * 为什么「读走 + 清空」而不是只读:探针要在**同一帧**里比较「推送前 / 推送后」,
 * 不叠加两次的计数。
 *
 * @returns 键 → 累计次数。
 */
export function takeRecordedStats(): ReadonlyMap<string, number> {
  const snapshot = new Map(recorded);
  recorded.clear();
  return snapshot;
}

/**
 * 上游 `stats-store.ts:647` 的 `StatsStore` 的宿主替身。
 *
 * 只实现 `increment`,并把它记进 {@link takeRecordedStats} 能读到的地方。
 * 其余成员(`recordPush`、`recordLaunchStats`…)上游都在 `app-store` 里,
 * 不在本文件 —— 需要它们时再补,而不是先把 1000 行遥测抄进来。
 */
export class StatsStore implements IStatsStore {
  /**
   * 上游签名是 `(db, uiActivityMonitor, post)`;这里接受任意参数(见文件头第 3 条)。
   *
   * @param _args - 忽略。
   */
  public constructor(..._args: ReadonlyArray<unknown>) {}

  /**
   * 记一次计数(内存留痕)。
   *
   * @param k - 计数键。
   * @param n - 增量,默认 1。
   * @returns 完成的 Promise。
   */
  public async increment(k: keyof NumericMeasures, n = 1): Promise<void> {
    recorded.set(String(k), (recorded.get(String(k)) ?? 0) + n);
  }
}
