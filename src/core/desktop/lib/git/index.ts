/**
 * **dsh-git 手写替身(shim,纯类型)** —— 上游 `lib/git/index.ts`(36 行)。
 *
 * ## 上游那份为什么不能直接沿用
 *
 * 上游 index 是 **36 行 `export * from './xxx'` 的桶文件**,把整个 git 层
 * (apply/branch/checkout/clone/commit/config/core/diff/fetch/log/pull/push/rebase/…)
 * 一次转出。而那一层的每一支都直接走 **`dugite`**
 * (例:`lib/git/core.ts:1-9` `import { exec, parseError, … } from 'dugite'`),
 * 并且依赖 `path`/`buffer`/`child_process`/`fs`。实测从本文件出发的朴素闭包 =
 * **`lib/git/**` 51 个文件 + dugite**(见 `docs/app-state-port.md` §3.2)——
 * 浏览器半**根本不可能**用 dugite,`lib/git/**` 正是**宿主已经取代**的那一层
 * (56 条路由 + `git-service.ts` + `git-argv.ts`,目标文档 §2.4)。
 *
 * ## 本 shim 必须保住的名字
 *
 * 实证:镜像 `lib/app-state.ts:61-65` 写的是
 * `import type { HookProgress, IChangesetData, TerminalOutputListener } from './git'`
 * —— **type-only**,恰好 3 个名字。三个声明与上游一致自上游:
 *
 * | 本 shim 的导出 | 上游位置 |
 * |---|---|
 * | `HookProgress` | `lib/git/core.ts:38` |
 * | `TerminalOutputListener` | `lib/git/core.ts:32` |
 * | `IChangesetData` | `lib/git/log.ts:215` |
 * | `IStatusResult` | `lib/git/status.ts:33-69`(**2026-10 补**,理由见下) |
 *
 * **一处必需的替代(已在下面注明)**:上游 `TerminalOutput`(`core.ts:30`)是
 * `string | Buffer | Buffer[]`,而浏览器半按 §2.3 是 `types: []` —— **没有 `Buffer`**
 * (写上去就是 TS2591)。`Buffer` 是 `Uint8Array` 的子类,所以这里是浏览器侧
 * 语义等价的写法 `string | Uint8Array | ReadonlyArray<Uint8Array>`。
 *
 * **2026-10 补 `IStatusResult`**:上游 `lib/stores/updates/changes-state.ts:5` 写的是
 * `import { IStatusResult } from '../../git'` —— 也是**走这个桶文件**。那份 353 行的
 * 「状态合并」纯函数(`updateChangedFiles` / `updateConflictState` /
 * `selectWorkingDirectoryFiles`)是 Changes 页**缓存失效规则**的上游原文,我们正在
 * **逐字落地**它(`src/core/desktop/lib/stores/updates/changes-state.ts`),
 * 所以这个类型名必须像上游一样从这里可解析。与上游一致,零运行期代码。
 *
 * **刻意省略**:其余 33 个 `export *`(及它们带来的全部函数/枚举)。
 * 除 `HookProgress` 里那对回调类型外**零运行期代码**。
 * @module dsh-git/core/desktop/lib/git
 */

import { CommittedFileChange, WorkingDirectoryStatus } from '../../models/status'
import { IAheadBehind } from '../../models/branch'
import { RebaseInternalState } from '../../models/rebase'

/**
 * 上游 `lib/git/core.ts:30` —— `string | Buffer | Buffer[]`。
 * 浏览器半没有 `Buffer`(§2.3 `types: []`),这里用它的超类 `Uint8Array`(语义等价)。
 */
export type TerminalOutput = string | Uint8Array | ReadonlyArray<Uint8Array>

/** 上游 `lib/git/core.ts:32`,逐字(只把 `TerminalOutput` 的定义换成上面的等价写法)。 */
export type TerminalOutputListener = (cb: (chunk: TerminalOutput) => void) => {
  unsubscribe: () => void
}

/** 上游 `lib/git/core.ts:38`,逐字。 */
export type HookProgress = {
  readonly hookName: string
} & (
  | {
      readonly status: 'started'
      readonly abort: () => void
    }
  | {
      readonly status: 'finished' | 'failed'
    }
)

/** 上游 `lib/git/log.ts:215`,逐字。 */
export interface IChangesetData {
  /** Files changed in the changeset. */
  readonly files: ReadonlyArray<CommittedFileChange>

  /** Number of lines added in the changeset. */
  readonly linesAdded: number

  /** Number of lines deleted in the changeset. */
  readonly linesDeleted: number
}

/** 上游 `lib/git/status.ts:33-69`,逐字。 */
export interface IStatusResult {
  /** The name of the current branch */
  readonly currentBranch?: string

  /** The name of the current upstream branch */
  readonly currentUpstreamBranch?: string

  /** The SHA of the tip commit of the current branch */
  readonly currentTip?: string

  /** How many commits ahead and behind
   *  the `currentBranch` is compared to the `currentUpstreamBranch`
   */
  readonly branchAheadBehind?: IAheadBehind

  /** true if the repository exists at the given location */
  readonly exists: boolean

  /** true if repository is in a conflicted state */
  readonly mergeHeadFound: boolean

  /** true merge --squash operation started */
  readonly squashMsgFound: boolean

  /** details about the rebase operation, if found */
  readonly rebaseInternalState: RebaseInternalState | null

  /** true if repository is in cherry pick state */
  readonly isCherryPickingHeadFound: boolean

  /** the absolute path to the repository's working directory */
  readonly workingDirectory: WorkingDirectoryStatus

  /** whether conflicting files present on repository */
  readonly doConflictedFilesExist: boolean
}
