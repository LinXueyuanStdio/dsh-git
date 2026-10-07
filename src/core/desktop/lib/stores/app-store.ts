/**
 * **dsh-git 手写替身(shim)** —— 上游 `lib/stores/app-store.ts`(**10935 行**)。
 *
 * 本文件同时承担**两个角色**,刻意放在一起(它们在上游本来就是同一个文件):
 *
 * 1. **常量替身**(原有):Preferences 的 Appearance 页
 *    (`ui/preferences/appearance.tsx:13`)取的 `tabSizeDefault`;
 * 2. **状态机采纳接缝(adoption seam)**(2026-10 新增):把上游
 *    `lib/stores/updates/changes-state.ts` 那 353 行**失效/合并规则**从镜像里接出来。
 *
 * ---
 *
 * ## 一、为什么接缝落在**这个文件**(不是随便找的地方)
 *
 * 上游 `lib/stores/updates/changes-state.ts` 的 importer **全仓库只有一处**
 * —— `app-store.ts:302-306`:
 *
 * ```ts
 * import {
 *   updateChangedFiles,
 *   updateConflictState,
 *   selectWorkingDirectoryFiles,
 * } from './updates/changes-state'
 * ```
 *
 * （实证:`grep -rn "updates/changes-state" references/desktop/app/src/` 只命中
 * `lib/stores/app-store.ts:306`,以及 `lib/git/index.ts` 里那句注释。
 * `src/` 这边此前**零 importer** ⇒ 它一直躺在 `check-integration` 的
 * 「失去可达的镜像模块」名单里 —— **在树里,没被用上**。)
 *
 * 而上游那份 `app-store.ts` 我们**不能**直接沿用:它 import `lib/api`、`lib/git/**`、
 * `lib/stores/**`、`lib/databases/**`、`lib/notifications/**`、`lib/trampoline/**`、
 * `main-process/**`、`dugite`、`dexie`、`keytar`,并且方法体大量是编排(弹窗 / 菜单 /
 * 遥测 / Copilot)。目标文档 §1.3 把它列为**不沿用的第一名**。
 *
 * ⇒ 于是**同一个路径**上的这份替身,就是上游那条 import 边在浏览器半的**唯一合法落点**。
 * 这也是本仓已经在用的方法(见 `lib/stats/stats-store.ts`、`lib/git/index.ts`):
 * **保留上游导出名与签名,把不纯的部分收到我们这一层**。
 *
 * ## 二、这里**只**复刻了状态迁移那一条链,没有复刻 AppStore
 *
 * ### 2.1 `applyChangesStatus()` —— 上游 `_loadStatus` 的那两行,逐字对应
 *
 * 上游 `app-store.ts:2985-3021` 的 `_loadStatus` 里,对 `changesState` 只有**两处**写入:
 *
 * ```ts
 * // app-store.ts:2999-3001
 * this.repositoryStateCache.updateChangesState(repository, state =>
 *   updateChangedFiles(state, status, clearPartialState)
 * )
 * // app-store.ts:3002-3004
 * this.repositoryStateCache.updateChangesState(repository, state => ({
 *   conflictState: updateConflictState(state, status, this.statsStore),
 * }))
 * ```
 *
 * `repositoryStateCache.updateChangesState()` 是 `merge(state, patch)`
 * (`lib/stores/repository-state-cache.ts:86-99` + `lib/merge.ts:2-11` 的
 * `Object.assign({}, obj)` 再逐键赋值),所以那两次调用**合起来**等价于下面这一个
 * 浅拷贝 —— 第二个回调拿到的 `state` 已经是第一次合并后的对象,
 * 因此 `updateConflictState` 的入参是 `updateChangedFiles` 的**返回值**。
 *
 * ### 2.2 本接缝**不复现**什么(逐条,别读成「AppStore 已经复现了」)
 *
 * 1. **没有 AppStore 类**,没有 `repositoryStateCache` / `gitStoreCache` /
 *    `emitUpdate`。`applyChangesStatus` 是一个**纯函数**:状态进、状态出。
 *    容器(存进哪个 Map、什么时候 `emitUpdate`)在 `src/client/store.ts` 那一侧。
 * 2. **`status` 不是本函数取的**。上游 `_loadStatus` 第一步是
 *    `gitStore.loadStatus()`(`app-store.ts:2993`,一次真 git 调用 ⇒ host),
 *    本函数要求调用方把结果传进来。
 * 3. **`_loadStatus` 末尾的 `updateChangesWorkingDirectoryDiff(repository)`
 *    (`app-store.ts:3018`)不在本函数里** —— 那是「重取当前选中文件的 diff」,
 *    属另一条链(我们已按 §S2 落在 `src/client/store.ts` 的 `refreshStatus()` 末尾)。
 * 4. **`statsStore` 只是转发**:`updateConflictState` 的第三个参数是遥测接口
 *    (`IStatsStore`),本仓的替身是 no-op(`lib/stats/stats-store.ts`,
 *    已登记 EXPECTED)。它**只影响计数,不影响返回的状态** ——
 *    实证见那份 EXPECTED 的文字:`repository-state-cache.ts` 里两个
 *    `record*IfNeeded()` 除计数外没有任何副作用。
 * 5. **`clearPartialState` 的默认值 `false`** 与上游 `_loadStatus` 的形参默认值
 *    逐字一致(`app-store.ts:2989`)。提交后那条路径**必须显式传 `true`**
 *    (`app-store.ts:3756-3759`,真值在 `:3758`),本函数不替调用方决定。
 *
 * ## 三、退役条件(与 `docs/changes-state-adoption.md` 的 apply-cold 计划同源)
 *
 * `src/client/store.ts` 的授权模型换成镜像的
 * `WorkingDirectoryFileChange.selection` 之后,它会**直接** import
 * `src/core/desktop/lib/stores/updates/changes-state.ts` 并丢掉自己的
 * `clearPartialAfterCommit`。那一刻:
 *
 * · 本文件的 `applyChangesStatus` 与那三条 re-export **变成第二份入口** ⇒
 *   **必须删掉**(否则就是本仓反复付代价的「第二份必然漂移的真源」);
 * · 同时 `lib/git/index.ts` 那条 EXPECTED 的 `IStatusResult` 也要删
 *   (它没有别的消费方)。
 *
 * 换句话说:**本接缝的存在理由是「现在还不能改 store.ts」,不是长期架构。**
 *
 * @module dsh-git/core/desktop/lib/stores/app-store
 */

import type { IStatusResult } from '../git'
import type { IChangesState } from '../app-state'
import type { IStatsStore } from '../stats'
import { merge } from '../merge'
import {
  selectWorkingDirectoryFiles,
  updateChangedFiles,
  updateConflictState,
} from './updates/changes-state'

/** 上游 `lib/stores/app-store.ts:532`,逐字。 */
export const tabSizeDefault: number = 4

/**
 * **上游 `_loadStatus` 对 `changesState` 的那两处写入,合成一个纯函数。**
 *
 * 语义逐字来自 `lib/stores/updates/changes-state.ts:32-116`(`updateChangedFiles`)
 * 与 `:263-311`(`updateConflictState`),调用顺序逐字来自
 * `app-store.ts:2999-3004`(见文件头 §2.1)。
 *
 * @param state - 该仓库当前的 `IChangesState`(上游取自 `repositoryStateCache.get(repository).changesState`)。
 * @param status - `gitStore.loadStatus()` 的结果(**本函数不取**,见文件头 §2.2 第 2 条)。
 * @param statsStore - 遥测接口;本仓替身是 no-op,不影响返回值。
 * @param clearPartialState - 与上游 `_loadStatus` 的形参同名同默认值(`false`)。
 *   提交成功后传 `true`(`app-store.ts:3758`);
 *   切仓库 / 切页签传 `false`(`:4130`、`:3377-3381`)。
 * @returns **新的** `IChangesState`(浅拷贝;入参不被修改)。
 */
export function applyChangesStatus(
  state: IChangesState,
  status: IStatusResult,
  statsStore: IStatsStore,
  clearPartialState: boolean = false
): IChangesState {
  // 两次 `merge` 逐字对应 `repository-state-cache.ts:86-99` 的 `updateChangesState`
  // (它内部就是 `merge(changesState, fn(changesState))`)。`updateChangedFiles` / 
  // `updateConflictState` 返回的都是 **patch**(`Pick<IChangesState, …>`),不是整份状态。
  const withFiles = merge(state, updateChangedFiles(state, status, clearPartialState))
  return merge(withFiles, {
    conflictState: updateConflictState(withFiles, status, statsStore),
  })
}

/**
 * 上游 `app-store.ts:302-306` 的**原样转出**。
 *
 * 与 `applyChangesStatus` 分开是刻意的:那三条是**上游的**入口(名字与签名逐字不动),
 * 本接缝必须让它们像在上游那样从这个路径可解析;`applyChangesStatus` 是**我们**的合成入口。
 * 两者都从同一个模块实例出来(`./updates/changes-state.ts` 在打包图里只有一份),
 * 所以不存在「两份实现」的问题。
 */
export { selectWorkingDirectoryFiles, updateChangedFiles, updateConflictState }
