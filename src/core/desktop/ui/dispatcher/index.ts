/**
 * **dsh-git 手写替身(shim)** —— 上游 `ui/dispatcher/index.ts` + `ui/dispatcher/dispatcher.ts`
 * (后者 4356 行)。
 *
 * 上游的 `Dispatcher` 是 Desktop 的**应用级命令总线**:每一个用户动作
 * (选仓库、切分支、弹窗、提交、同步……)都变成它的一个方法,方法体几乎全是
 * `this.appStore._xxx(...)` —— 而 `lib/stores/**`(含 10936 行的 `app-store.ts`)
 * 属于目标文档 §1.3 明确**不沿用**的应用层。沿用它会把闭包从 130 文件推到 340+。
 *
 * 浏览器半这边也没有那个 store:仓库列表的状态由 dsh-git 自己的
 * `src/client/**` 持有。
 *
 * 因此这里只声明**移植的仓库列表面、History 面与顶栏同步面真正调用的 19 个方法**,
 * 名字与签名逐字取自上游:
 *
 * | 方法 | 上游位置 | 调用点 |
 * |---|---|---|
 * | `showPopup(popup: Popup): Promise<void>` | `ui/dispatcher/dispatcher.ts:405` | `repositories-list.tsx:442,449,453,457,468` |
 * | `changeRepositoryAlias(repository, newAlias: string \| null): Promise<void>` | 同上 `:868` | `repositories-list.tsx:464` |
 * | `selectRepository(repository)` | 同上 `:301` | `repositories-list.tsx:475` |
 * | `showWorktreesFoldout(): Promise<void>` | 同上 `:441` | `repositories-list.tsx:476` |
 * | `recordRepoClicked(repoHasIndicator: boolean)` | 同上 `:2709` | `repositories-list.tsx:280` |
 * | `changeFileSelection(repository, file: CommittedFileChange): Promise<void>` | 同上 `:288` | `ui/history/selected-commits.tsx:116` |
 * | `showUnreachableCommits(selectedTab: UnreachableCommitsTab)` | 同上 `:4117` | `selected-commits.tsx:218` |
 * | `updateShasToHighlight(repository, shasToHighlight)` | 同上 `:273` | `selected-commits.tsx:223` |
 * | `onHideWhitespaceInHistoryDiffChanged(hide, repository, file?)` | 同上 `:2401` | `selected-commits.tsx:230` |
 * | `onShowSideBySideDiffChanged(showSideBySideDiff): Promise<void>` | 同上 `:2427` | `selected-commits.tsx:241` |
 * | `setCommitSummaryWidth(width: number): Promise<void>` | 同上 `:1139` | `selected-commits.tsx:249` |
 * | `resetCommitSummaryWidth(): Promise<void>` | 同上 `:1147` | `selected-commits.tsx:245` |
 * | `closeFoldout(foldout: FoldoutType): Promise<void>` | 同上 `:436` | `toolbar/push-pull-button.tsx:271` |
 * | `push(repository): Promise<void>` | 同上 `:744` | `toolbar/push-pull-button.tsx:276` |
 * | `pull(repository): Promise<void>` | 同上 `:757` | `toolbar/push-pull-button.tsx:356` |
 * | `fetch(repository, fetchType: FetchType): Promise<void>` | 同上 `:770` | `toolbar/push-pull-button.tsx:362` |
 * | `confirmOrForcePush(repository): Promise<void>` | 同上 `:2608` | `toolbar/push-pull-button.tsx:349` |
 * | `setPushPullButtonWidth(width: number): Promise<void>` | 同上 `:1082` | `toolbar/push-pull-button.tsx:375` |
 * | `resetPushPullButtonWidth(): Promise<void>` | 同上 `:1090` | `toolbar/push-pull-button.tsx:383` |
 *
 * **最后 7 个是本轮(2026-10-06)为顶栏同步面补的**:上游
 * `ui/toolbar/push-pull-button.tsx` 只经由这 7 个方法与同步面之外的世界对话
 * (`closeFoldout` / `push` / `pull` / `fetch` / `confirmOrForcePush` /
 * `setPushPullButtonWidth` / `resetPushPullButtonWidth`)。在这之前,该文件的
 * 13 条 tsc 错误里有 **7 条**就是「Property 'x' does not exist on type 'Dispatcher'」。
 * 宿主实现由 `src/client/sync-dropdown-dispatcher.ts` 的门面接上(与 History 的
 * `src/client/desktop-dispatcher.ts` 同一形状:替身给**类型面**,门面给**行为**)。
 * 未声明的方法一律保持**不存在** —— 门面接不上的东西不在类型上假装存在,
 * 它是「接线缺口」而不是「已支持」。
 *
 * **后 7 个是本轮为 History 面补的**(2026-10-06):上游 History 的容器
 * `ui/history/selected-commits.tsx` 只经由这 7 个方法与应用层对话。不声明它们,
 * 就只能在我们这层**复刻一份 render()**(曾经就是这样,那是一条会静默漂移的影子实现);
 * 声明成类型面之后,容器本身可以直接渲染,宿主能力由
 * `src/client/desktop-dispatcher.ts` 的门面接上。
 * 两处**必需的收窄**(都在下面逐条注明):上游 `showUnreachableCommits` 的返回类型
 * 未声明(`void`),这里保持;`onHideWhitespaceInHistoryDiffChanged` 的第三参数
 * 上游默认 `null`,这里保留默认值。
 *
 * 声明成 `class`(而不是 `interface`)也是为了与上游 `import { Dispatcher }` 的形状
 * 一致 —— 上游用的是类。宿主接入时把真实实现赋值给 `props.dispatcher` 即可,
 * 本 shim 的方法体不参与运行期(客户端门面 `DesktopDispatcher` 覆盖它们)。
 * @module dsh-git/core/desktop/ui/dispatcher
 */

import { Disposable } from 'event-kit'
import { CloningRepository } from '../../models/cloning-repository'
import { Popup } from '../../models/popup'
import { Repository } from '../../models/repository'
import { CommittedFileChange } from '../../models/status'
import type { UnreachableCommitsTab } from '../history/unreachable-commits-dialog'
/*
 * 顶栏同步面(2026-10-06 补)的两个参数类型。
 * 都用 `import type` 引入:它们**只出现在参数类型位置**,于是这两条
 * **不产生运行期 import 边** —— 与 `UnreachableCommitsTab` 同一处理
 * (理由见那个 import 上面 showUnreachableCommits 的注释,方向是反的:
 * 不能让 dispatcher 替身把 app-state / models 拉进包)。
 */
import type { FoldoutType } from '../../lib/app-state'
import type { FetchType } from '../../models/fetch'
/*
 * CI 面(2026-10-07)的三个类型 —— 都是 `import type`(只出现在签名位置,
 * 不产生运行期 import 边):
 *  - `GitHubRepository`:CIStatus / CICheckRunPopover 传的仓库;
 *  - `ICombinedRefCheck` / `IRefCheck`:合成状态与单条 check(来自**本轮抄进来的**
 *    `lib/ci-checks/ci-checks.ts`);
 *  - `IAPICheckSuite`:`fetchCheckSuite` 的返回(来自上面的 `lib/api.ts` 替身)。
 */
import type { GitHubRepository } from '../../models/github-repository'
import type { ICombinedRefCheck, IRefCheck } from '../../lib/ci-checks/ci-checks'
import type { IAPICheckSuite } from '../../lib/api'

/**
 * 上游 `ui/dispatcher/dispatcher.ts:405` —— 把一个弹窗压入栈。
 * 浏览器半没有那个栈,签名保持不变。
 */
export class Dispatcher {
  /** 上游 `:405`。 */
  public showPopup(popup: Popup): Promise<void> {
    void popup
    return Promise.resolve()
  }

  /** 上游 `:868`。 */
  public changeRepositoryAlias(
    repository: Repository,
    newAlias: string | null
  ): Promise<void> {
    void repository
    void newAlias
    return Promise.resolve()
  }

  /** 上游 `:301`。 */
  public selectRepository(
    repository: Repository | CloningRepository
  ): Promise<Repository | null> {
    void repository
    return Promise.resolve(null)
  }

  /** 上游 `:441`。 */
  public showWorktreesFoldout(): Promise<void> {
    return Promise.resolve()
  }

  /** 上游 `:2709`。 */
  public recordRepoClicked(repoHasIndicator: boolean) {
    void repoHasIndicator
  }

  // -------------------------------------------------------------------------
  // History 面(2026-10-06 补):`ui/history/selected-commits.tsx` 调用的 7 个
  // -------------------------------------------------------------------------

  /** 上游 `:288`。History 里选中变更文件。 */
  public changeFileSelection(
    repository: Repository,
    file: CommittedFileChange
  ): Promise<void> {
    void repository
    void file
    return Promise.resolve()
  }

  /**
   * 上游 `:4117` —— 打开「不可达提交」对话框。
   *
   * 上游方法体是 `statsStore.increment(...)` + `this.showPopup({type: PopupType.UnreachableCommits, selectedTab})`,
   * 且**没有声明返回类型**(即 `void`,不是 `Promise<void>`)—— 这里逐字保持。
   * 参数类型是 `ui/history/unreachable-commits-dialog.tsx` 的数值 enum;用
   * `import type` 引入,于是这一条**不产生运行期 import 边**(否则会让
   * `ui/history/**` 因为 dispatcher 而进包,方向是反的)。
   */
  public showUnreachableCommits(selectedTab: UnreachableCommitsTab) {
    void selectedTab
  }

  /** 上游 `:273`。把一组 sha 在提交列表里高亮(`ExpandableCommitSummary` 点协作者时用)。 */
  public updateShasToHighlight(
    repository: Repository,
    shasToHighlight: ReadonlyArray<string>
  ) {
    void repository
    void shasToHighlight
  }

  /** 上游 `:2401`。第三个参数上游有默认值 `null`,沿用。 */
  public onHideWhitespaceInHistoryDiffChanged(
    hideWhitespaceInDiff: boolean,
    repository: Repository,
    file: CommittedFileChange | null = null
  ): Promise<void> {
    void hideWhitespaceInDiff
    void repository
    void file
    return Promise.resolve()
  }

  /** 上游 `:2427`。统一 ↔ 并排。 */
  public onShowSideBySideDiffChanged(
    showSideBySideDiff: boolean
  ): Promise<void> {
    void showSideBySideDiff
    return Promise.resolve()
  }

  /** 上游 `:1139`。拖文件列表那条分隔线时写宽度。 */
  public setCommitSummaryWidth(width: number): Promise<void> {
    void width
    return Promise.resolve()
  }

  /** 上游 `:1147`。双击分隔线复位。 */
  public resetCommitSummaryWidth(): Promise<void> {
    return Promise.resolve()
  }

  // -------------------------------------------------------------------------
  // 顶栏同步面(2026-10-06 补):`ui/toolbar/push-pull-button.tsx` 调用的 7 个
  // -------------------------------------------------------------------------

  /**
   * 上游 `:436`。关闭指定的 foldout。
   *
   * 上游是 `closeCurrentFoldout` 的收窄版(`this.appStore._closeFoldout(foldout)`),
   * 同步面只用 `FoldoutType.PushPull`。宿主实现见
   * `src/client/sync-dropdown-dispatcher.ts`(门面把它接到「关掉同步段下拉」)。
   */
  public closeFoldout(foldout: FoldoutType): Promise<void> {
    void foldout
    return Promise.resolve()
  }

  /** 上游 `:744`。推送当前分支。 */
  public push(repository: Repository): Promise<void> {
    void repository
    return Promise.resolve()
  }

  /**
   * 上游 `:757`。拉取当前分支。
   *
   * ⚠️ **一处有意的签名扩展(不是上游原文)**:多了一个**可选**的
   * `pullWithRebase?: boolean`。上游这里只有 `(repository)` —— 因为上游的
   * `_pull`(`app-store.ts:5484`)自己从 `gitStore.pullWithRebase` 取值,
   * 那个 store 在浏览器半不存在(`lib/stores/**` 属 §1.3 排除)。
   *
   * 扩展走的正是上游的语义:值来自 `IBranchesState.pullWithRebase`
   * (`ui/app.tsx:3630` 解构、`:3666` 传进 `PushPullButton`,与按钮文案**同一个**字段),
   * 只是在我们这里经参数显式传,因为**没有**那个应用层 store 可以回头去读。
   * 省略它 = 让宿主自己读配置(上游 `pullRepo` 也是让 git 自己看 `pull.rebase`)。
   *
   * 改动只有**多一个可选参数**,没有增删任何一行已有逻辑,所以已有的调用点
   * (`push-pull-button.tsx:356` 与各门面)全部不需要动。已在
   * `scripts/verify-mirror.mjs` 的 EXPECTED 里登记理由与退役条件。
   */
  public pull(repository: Repository, pullWithRebase?: boolean): Promise<void> {
    void repository
    void pullWithRebase
    return Promise.resolve()
  }

  /**
   * 上游 `:770`。抓取。
   *
   * `fetchType` 是上游 `models/fetch.ts` 那个 2 成员 enum
   * (`FetchType.BackgroundTask` / `FetchType.UserInitiatedTask`),
   * 顶栏只发后者(`push-pull-button.tsx:364`)。
   */
  public fetch(repository: Repository, fetchType: FetchType): Promise<void> {
    void repository
    void fetchType
    return Promise.resolve()
  }

  /**
   * 上游 `:2608` —— 上游写的是 `public async confirmOrForcePush(repository)`,
   * **没有声明返回类型**(推导为 `Promise<void>`)。这里显式写出 `Promise<void>`,
   * 语义逐字相同(调用点 `push-pull-button.tsx:349` 不 await 它)。
   */
  public confirmOrForcePush(repository: Repository): Promise<void> {
    void repository
    return Promise.resolve()
  }

  /** 上游 `:1082`。拖「推送/拉取」按钮的宽度手柄时写宽度。 */
  public setPushPullButtonWidth(width: number): Promise<void> {
    void width
    return Promise.resolve()
  }

  /** 上游 `:1090`。双击宽度手柄复位。 */
  public resetPushPullButtonWidth(): Promise<void> {
    return Promise.resolve()
  }

  /*
   * =====================================================================
   * CI 面(2026-10-07「抄优先」):`ui/check-runs/**` 经由这 7 个方法与
   * 应用层对话。**只给类型面**,行为在 `src/client/ci-dispatcher.ts` 的门面上
   * (与顶栏同步面 / History 面同一形状:替身给类型,门面给行为)。
   *
   * | 方法 | 上游位置 | 调用点 |
   * |---|---|---|
   * | `tryGetCommitStatus(repository, ref, branchName?)` | `ui/dispatcher/dispatcher.ts:2741` | `ui/branches/ci-status.tsx:44,78`、`ci-check-run-popover.tsx:92,105` |
   * | `subscribeToCommitStatus(repository, ref, callback, branchName?)` | 同上 `:2760` | `ci-status.tsx:57`、`ci-check-run-popover.tsx:122` |
   * | `openInBrowser(url)` | 同上 `:1417` | `ci-check-run-popover.tsx:167,180` |
   * | `incrementMetric(metric)` | 同上 `:1306` | `ci-check-run-popover.tsx:168,181`、`ci-check-run-rerun-dialog.tsx:77` |
   * | `rerequestCheckSuites(repository, checkSuiteId)` | 同上 `:2992` | `ci-check-run-rerun-dialog.tsx:67` |
   * | `manualRefreshSubscription(repository, ref, pendingChecks)` | 同上 `:2769` | `ci-check-run-rerun-dialog.tsx:72` |
   * | `fetchCheckSuite(repository, checkSuiteId)` | 同上 `:3010` | `ci-check-run-rerun-dialog.tsx:100` |
   *
   * 两条**必需的收窄**(逐条说明,与前面 19 个方法同一纪律):
   *  - `tryGetCommitStatus` 的上游签名第三参是 `branchName?: string`;`ci-status.tsx:44`
   *    只传两个参数 ⇒ 这里保留默认参;
   *  - `incrementMetric` 的上游参数是一个巨大的 `IMetricName` 联合(上游 `:1306`
   *    那个 `keyof` 表,我们没搬)⇒ 这里收窄成 `string`,**只放宽参数类型**,
   *    调用点的字面量仍然逐个可读;真正的统计面在本仓不存在,门面里是空操作。
   */

  /**
   * 上游 `:2741`。**同步**取缓存里的合成状态(没有就回 `null`,组件据此先渲染旧值)。
   * 行为在 `src/client/ci-dispatcher.ts`(委托给抄进来的 `CommitStatusStore.tryGetStatus`)。
   */
  public tryGetCommitStatus(
    repository: GitHubRepository,
    ref: string,
    branchName?: string
  ): ICombinedRefCheck | null {
    void repository
    void ref
    void branchName
    return null
  }

  /**
   * 上游 `:2760-2768`,签名逐字(含 `event-kit` 的 `Disposable` 返回类型 ——
   * `ci-check-run-popover.tsx:87` 把它存成 `Disposable | null`,结构替身少一个
   * `disposed` 字段都会是 `TS2741`)。
   */
  public subscribeToCommitStatus(
    repository: GitHubRepository,
    ref: string,
    callback: (status: ICombinedRefCheck | null) => void,
    branchName?: string
  ): Disposable {
    void repository
    void ref
    void callback
    void branchName
    return new Disposable(() => undefined)
  }

  /** 上游 `:1417`。在系统浏览器里打开一个 URL。 */
  public openInBrowser(url: string): void {
    void url
  }

  /** 上游 `:1306`。统计打点(本仓没有统计面;门面里是空操作)。 */
  public incrementMetric(metric: string): void {
    void metric
  }

  /**
   * 上游 `:2793-2797`,签名逐字:`(repository, checkRuns, failedOnly)` ⇒
   * 每条 check 一个布尔(是否请求成功)。`ci-check-run-rerun-dialog.tsx:67` 传**三个**
   * 参数(第二参是 `this.state.rerunnable`,即 `ReadonlyArray<IRefCheck>`)。
   */
  public rerequestCheckSuites(
    repository: GitHubRepository,
    checkRuns: ReadonlyArray<IRefCheck>,
    failedOnly: boolean
  ): Promise<ReadonlyArray<boolean>> {
    void repository
    void checkRuns
    void failedOnly
    return Promise.resolve([])
  }

  /**
   * 上游 `:2769`。把给定的几条 check 手动置回 pending(重跑后立刻反馈)。
   */
  public manualRefreshSubscription(
    repository: GitHubRepository,
    ref: string,
    pendingChecks: ReadonlyArray<IRefCheck>
  ): Promise<void> {
    void repository
    void ref
    void pendingChecks
    return Promise.resolve()
  }

  /** 上游 `:3010`。取一个 check suite 的详情(rerun 弹窗判可用性)。 */
  public fetchCheckSuite(
    repository: GitHubRepository,
    checkSuiteId: number
  ): Promise<IAPICheckSuite | null> {
    void repository
    void checkSuiteId
    return Promise.resolve(null)
  }
}
