/**
 * **History 页签的 Dispatcher 门面** —— 把宿主能力接到上游
 * `ui/history/selected-commits.tsx` 需要的 7 个方法上。
 *
 * ## 为什么需要它(而不是继续在适配层复刻容器的 render())
 *
 * 上游 History 的容器是 `ui/history/selected-commits.tsx`(473 行),它不直接操作数据,
 * 而是经由 `Dispatcher` 的 7 个方法与应用层对话。我们树里
 * `src/core/desktop/ui/dispatcher/index.ts` 原本只声明了仓库列表用到的 5 个方法
 * ⇒ 容器**编译不过**,于是 `src/client/history-view.tsx` 曾经**逐行复刻**了它的
 * `render()`(同一份 DOM、同一批类名、同一批 props)。
 *
 * 那份复刻是一条**影子实现**:上游那个文件一改,我们的复刻不会跟着动,
 * 而且**没有任何检查会警告**。所以改成:给 dispatcher 替身补上那 7 个**类型面**
 * (2026-10-06 补,登记在 `scripts/verify-mirror.mjs` 的 EXPECTED 里),
 * 在这里写一个约 60 行的门面把宿主接上,容器本体直接渲染。
 *
 * ## 边界:门面只做「转发」,不放业务
 *
 * 每个方法的**语义**都留在适配层(`history-view.tsx` 的回调):
 *  - `changeFileSelection` → 改「选中哪个变更文件」;
 *  - `updateShasToHighlight` → 改提交列表高亮;
 *  - `setCommitSummaryWidth` / `resetCommitSummaryWidth` → 写文件列表那条分隔线的宽度
 *    (真值仍是 `useSplitWidth()` 的 state,门面只转发);
 *  - `onHideWhitespaceInHistoryDiffChanged` / `onShowSideBySideDiffChanged` → 写 store;
 *  - `showUnreachableCommits` → **未接线**(见下)。
 *
 * ## 一处**故意不实现**(不假装)
 *
 * `showUnreachableCommits(selectedTab)` 上游是
 * `statsStore.increment(...)` + `showPopup({type: PopupType.UnreachableCommits, selectedTab})`,
 * 即打开应用层的弹窗宿主。我们这个插件**没有应用层弹窗宿主**(没有 `ui/app.tsx`、
 * `ui/dispatcher` 是替身),`ui/dialog/**` 的 `_dialog.scss` 也不在任何作用域面的闭包里。
 * 所以门面里它只把请求交给 `host.showUnreachableCommits`,由适配层决定 —— 今天是
 * 「什么都不做」。**注册成已知缺口**,等弹窗面接线。它只在「选中多个提交」时可达,
 * 而多选区间 diff 我们今天本来也不做。
 *
 * @module dsh-git/client/desktop-dispatcher
 */

import { Dispatcher } from '../core/desktop/ui/dispatcher/index.ts';
import type { Repository } from '../core/desktop/models/repository.ts';
import type { CommittedFileChange } from '../core/desktop/models/status.ts';
import type { UnreachableCommitsTab } from '../core/desktop/ui/history/unreachable-commits-dialog.tsx';

/**
 * 适配层提供的宿主能力。**全部是转发**,不做判断 —— 判断留在视图里
 * (那里才拿得到 store 与 React state)。
 */
export interface IHistoryDispatcherHost {
  /** 用户在文件列表里换了一个文件。 */
  readonly selectFile: (repository: Repository, file: CommittedFileChange) => void;
  /** 勾/取消「隐藏空白改动」(History 的那个独立开关)。 */
  readonly setHideWhitespaceInHistoryDiff: (value: boolean) => void;
  /** 统一 ↔ 并排。 */
  readonly setSideBySide: (value: boolean) => void;
  /** 拖文件列表分隔线 → 新宽度(px)。 */
  readonly setCommitSummaryWidth: (width: number) => void;
  /** 双击分隔线 → 复位。 */
  readonly resetCommitSummaryWidth: () => void;
  /** 摘要头点了某个协作者 → 高亮那些 sha。 */
  readonly highlightShas: (shas: ReadonlyArray<string>) => void;
  /** 「N 个提交不在 diff 里」→ 上游开不可达提交对话框(本插件没有弹窗宿主,见文件头)。 */
  readonly showUnreachableCommits: (tab: UnreachableCommitsTab) => void;
}

/**
 * `Dispatcher` 的 History 子集实现。
 *
 * **继承**而不是 `implements`:上游传的是类实例(`import { Dispatcher }`),
 * 而基类替身里已经有仓库列表那 5 个方法的空实现 —— 继承让「门面只管 History 这 7 个」
 * 这件事在类型上也成立,不需要把另外 5 个再写一遍。
 */
export class HistoryDispatcher extends Dispatcher {
  public constructor(private readonly host: IHistoryDispatcherHost) {
    super();
  }

  /** 上游 `dispatcher.ts:288`。 */
  public async changeFileSelection(
    repository: Repository,
    file: CommittedFileChange,
  ): Promise<void> {
    this.host.selectFile(repository, file);
  }

  /** 上游 `:4117`。上游没有声明返回类型,这里保持 `void`。 */
  public showUnreachableCommits(selectedTab: UnreachableCommitsTab): void {
    this.host.showUnreachableCommits(selectedTab);
  }

  /** 上游 `:273`。 */
  public updateShasToHighlight(
    _repository: Repository,
    shasToHighlight: ReadonlyArray<string>,
  ): void {
    this.host.highlightShas(shasToHighlight);
  }

  /** 上游 `:2401`。 */
  public async onHideWhitespaceInHistoryDiffChanged(
    hideWhitespaceInDiff: boolean,
    _repository: Repository,
    _file: CommittedFileChange | null = null,
  ): Promise<void> {
    this.host.setHideWhitespaceInHistoryDiff(hideWhitespaceInDiff);
  }

  /** 上游 `:2427`。 */
  public async onShowSideBySideDiffChanged(
    showSideBySideDiff: boolean,
  ): Promise<void> {
    this.host.setSideBySide(showSideBySideDiff);
  }

  /** 上游 `:1139`。 */
  public async setCommitSummaryWidth(width: number): Promise<void> {
    this.host.setCommitSummaryWidth(width);
  }

  /** 上游 `:1147`。 */
  public async resetCommitSummaryWidth(): Promise<void> {
    this.host.resetCommitSummaryWidth();
  }
}
