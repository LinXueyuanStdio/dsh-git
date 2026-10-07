/**
 * **dsh-git 手写替身(shim,纯类型 + 一个 enum)** —— 上游 `ui/lib/update-store.ts`(378 行)。
 *
 * ## 上游那份为什么不能直接沿用
 *
 * 上游是**自动更新器的 store**:`:15` import `../main-process-proxy`
 * (`checkForUpdates`/`quitAndInstallUpdate`/`onAutoUpdater*` 一整套 **Electron 自动更新 IPC**),
 * 还 import `../../lib/error-with-metadata`、`../../lib/squirrel-error-parser`、
 * `../../lib/release-notes`、`../../lib/local-storage`、`../../lib/http`、
 * `../../lib/feature-flag`、`./app-proxy`(**这些文件我们树里都没有**,
 * 且不在 app-state 的闭包内——实测本文件的缺失闭包是 9 个文件),
 * 以及 `event-kit`/`semver`/`mem`/`quick-lru`/`fs/promises`/`date-fns`/`path`/`url`。
 * Desktop 的自更新由 **DSH Desktop 自己管**(`docs/storage-tables-design.md` §2.3 F:
 * `updateState`/`isUpdateAvailableBannerVisible` → 「Desktop 自更新;DSH Desktop 自己管」)。
 *
 * ## 本 shim 必须保住的名字
 *
 * 实证:镜像 `lib/app-state.ts:71` 写的是
 * `import { IUpdateState } from '../ui/lib/update-store'`,只取 **`IUpdateState`**
 * —— 上游 `:49`,6 个字段与上游一致如下;它引用的 `UpdateStatus`(`:32`)与
 * `ReleaseSummary`(上游 `models/release-notes.ts:22`,**我们树里已字节一致**)一并保留。
 *
 * | 本 shim 的导出 | 上游位置 |
 * |---|---|
 * | `UpdateStatus` | `:32`(数值 enum,**有运行期值**) |
 * | `IUpdateState` | `:49` |
 *
 * **刻意省略**:`UpdateStore` 类与其余全部函数(自动更新 IPC)。
 * @module dsh-git/core/desktop/ui/lib/update-store
 */

import { ReleaseSummary } from '../../models/release-notes'

/** 上游 `ui/lib/update-store.ts:32`,逐字(数值 enum,成员顺序即取值)。 */
export enum UpdateStatus {
  /** The auto updater is checking for updates. */
  CheckingForUpdates,

  /** An update is available and will begin downloading. */
  UpdateAvailable,

  /** No update is available. */
  UpdateNotAvailable,

  /** An update has been downloaded and is ready to be installed. */
  UpdateReady,

  /** We have not checked for an update yet. */
  UpdateNotChecked,
}

/** 上游 `ui/lib/update-store.ts:49`,逐字。 */
export interface IUpdateState {
  status: UpdateStatus
  lastSuccessfulCheck: Date | null
  isX64ToARM64ImmediateAutoUpdate: boolean
  newReleases: ReadonlyArray<ReleaseSummary> | null
  prioritizeUpdate: boolean
  prioritizeUpdateInfoUrl: string | undefined
}
