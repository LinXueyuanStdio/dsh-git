/**
 * Changes 视图:已暂存/未暂存分组 + diff 预览 + 提交区(含 DSH 模型生成)。
 * 布局与交互对齐 GitHub Desktop 的 Changes 页。
 * @module dsh-git/client/changes-view
 */

import { createElement, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { api } from './api.ts';
import { Icon } from './icons.ts';
import { ConfirmDialog, Empty, GenerateFailureDialog } from './bits.tsx';
import { DesktopDiff } from './desktop-diff.tsx';
/*
 * **镜像的 diff 头部**(2026-10-08 接线)—— 上游 `ui/changes/changes.tsx:105-117`
 * 在 Changes 右栏渲染的就是它(`PathLabel` + `DiffOptions` + 状态 Octicon)。
 *
 * 我们以前用**手写**的 `.gw-diff-head`(`.gw-path` 纯文本 + `+n/-n` + 手写
 * `DiffSettings`),差别与理由见 `docs/changes-diff-header-adoption-plan.md`。
 * 手写那两件(头部 JSX 与 `diff-settings.tsx`)**停止使用但不删除**:
 * `src/client/diff-settings.tsx` 一个字没动,`.gw-diff-head` / `.gw-path` /
 * `.gw-diffopt*` 的 CSS 也全部留在 `src/client/styles.ts` 里(退役条件写在上面那份文档里)。
 */
import { DiffHeader } from '../core/desktop/ui/diff/diff-header.tsx';
import { getPreferredExternalEditor } from './prefs.ts';
/*
 * **Changes 列表的右键菜单**(逐文件菜单 + 表头菜单)。
 *
 * 上游那一份 item 列表住在 `ui/changes/filter-changes-list.tsx:535-570`(表头)与
 * `:657-857`(逐文件),而它**一个产品 importer 都没有**(那个文件在
 * `check-integration` 的 unreachable 名单里)⇒ 用户右键变更项**什么都不弹**。
 * 判定逐条抄在上面的模块里;机制复用仓库里**已有的**那一个
 * (`context-menu-host.tsx` 的 in-browser 菜单,由 `desktop-diff.tsx` 装上)—— 见该模块文件头。
 */
import {
  resolvePrimaryExternalEditor,
  showChangesFileMenu,
  showChangesListMenu,
} from './changes-file-menu.ts';
/*
 * **提交选项(齿轮)的菜单** —— 上游 `ui/changes/commit-message.tsx:1053-1130`:
 * 齿轮按钮 `onClick` 里现拼 `IMenuItem[]`(三项 `type:'checkbox'`)再交给
 * `showContextualMenu()`(`:29` 的 import)。上游那个 `showContextualMenu` 是
 * Electron 主进程能力,浏览器里默认只打印;本仓**已有的**宿主是
 * `src/client/context-menu-host.tsx`(纯命令式 DOM 的 in-browser 菜单),
 * 逐文件菜单与仓库列表菜单走的是同一条链 —— 这里**复用同一个**,不新建第二套。
 */
import { installContextMenuHost } from './context-menu-host.tsx';
/*
 * **模型选择器**(按钮 + 可滚动下拉列表)在它自己的模块里 —— 见 `model-select.tsx` 的文件头:
 * ① 原生 `<select>` 满足不了用户那两条文案要求(headless Chrome 的 AX 实测,
 *    `<option label>` 同时决定收起文案与列表项名字);
 * ② 第一版复用的右键菜单宿主**没有滚动**(用户当场报「列表太长,无法上下滚动」)。
 */
import { ModelSelect, modelButtonText } from './model-select.tsx';
import { showContextualMenu } from '../core/desktop/lib/menu-item.ts';
import type { IMenuItem } from '../core/desktop/lib/menu-item.ts';
import { SplitPane, toCommit, useSplitWidth, SIDEBAR_WIDTH_STORAGE_KEY } from './history-view.tsx';
import {
  aheadBehindOf,
  forcePushBranchStateOf,
  networkActionInProgress,
  remoteNameOf,
  tipOf,
} from './sync-state.ts';
import { commitPlaceholderOf, getCoAuthorTrailers, includeStateOf, prepopulateCommitSummaryOf, summaryOrPlaceholderOf } from './store.ts';
import type { CommitForm, GitStore, IncludeState, Snapshot } from './store.ts';
import { supportsLineSelection } from './file-kind.ts';
import type { ChangeStatus, ChangedFile, DiffResult } from '../core/types.ts';
import type { LineSelectionSpec } from '../core/partial-stage.ts';
import { conflictSummaryText } from '../core/status-porcelain.ts';
import { isEmptyOrWhitespace } from '../core/desktop/lib/is-empty-or-whitespace.ts';
import { Checkbox, CheckboxValue } from '../core/desktop/ui/lib/checkbox.tsx';
import { ForcePushBranchState } from '../core/desktop/lib/rebase.ts';
import { TipState } from '../core/desktop/models/tip.ts';
import { formatNumber } from '../core/desktop/lib/format-number.ts';
import { HiddenChangesWarning, isCommittingFileHiddenByFilter } from './hidden-changes-warning.tsx';
import type { IFileListFilterState } from '../core/desktop/lib/app-state.ts';
/*
 * **变更文件列表体 = 镜像的虚拟列表**(`changes-file-list.tsx` 的文件头写了全部理由)。
 *
 * 审计 `docs/changes-file-list-gap-audit.md` §2.2 的读数:镜像 `ui/lib/list/**`(4,604 行)
 * + `ui/lib/section-filter-list.tsx`(808 行)= **5,412 行已经在产物里却没有渲染方**,
 * 而我们这里是 `{shown.map(...)}` 的 O(N) 全渲染。本文件现在把列表体交给它。
 */
import { ChangesFileList, appFileStatusOfChange, changesRowItemsOf, filterChangesRows } from './changes-file-list.tsx';
import type { IChangesRowItem } from './changes-file-list.tsx';
import { getRememberedScrollTop, setRememberedScrollTop } from './changes-file-list.tsx';
// `SelectionSource` 必须从 `filter-list` 取:`filter-list.tsx:199` 把它**加宽**成
// `ListSelectionSource | IFilterSelectionSource`,而镜像列表收的是那个加宽版。
import type { SelectionSource } from '../core/desktop/ui/lib/filter-list.tsx';
/*
 * 行内容的镜像件(逐个 `file:line` 见各组件自己的文件头):
 *  · `PathLabel`(`ui/lib/path-label.tsx:37-71`):目录/文件名分段 + 重命名时
 *    `arrowRight` **朝右**的箭头 + 按**实测宽度**截断(`PathText`);
 *  · `Octicon` + `iconForStatus`(`ui/octicons/status.ts:16-38`):冲突走 `octicons.alert`
 *    (我们以前是手写 `x-circle`,`STATUS_META.U`);
 *  · `AriaLiveContainer`(`ui/accessibility/aria-live-container.tsx`):勾选变化时读屏宣告
 *    (行文本变动的**唯一**出口,`changed-file.tsx:106`);
 *  · `mapStatus`(`lib/status.ts`):宣告文本里的状态词。
 */
import { PathLabel } from '../core/desktop/ui/lib/path-label.tsx';
import { Octicon, iconForStatus } from '../core/desktop/ui/octicons/index.ts';
import { AriaLiveContainer } from '../core/desktop/ui/accessibility/aria-live-container.tsx';
/*
 * 筛选的两件镜像纯函数:`getNoResultsMessage`(逐条说出**是哪几个筛选**把行筛没了,
 * 上游 `filter-changes-logic.ts:77-126`)/ `hasActiveFilters`(**包含 filterText**,
 * 上游 `:147-149`)—— `Clear filters` 的可见性就按它。
 */
import {
  applyFilters,
  getNoResultsMessage,
  hasActiveFilters,
} from '../core/desktop/ui/changes/filter-changes-logic.ts';
// 右栏多选空态(上游 `ui/changes/multiple-selection.tsx`,26 行;渲染点 `ui/repository.tsx:563-567`)。
import { MultipleSelection } from '../core/desktop/ui/changes/multiple-selection.tsx';
import type { IMatches } from '../core/desktop/lib/fuzzy-find.ts';
// 「发布仓库」缺什么的**唯一文案源** —— 顶栏 `toolbar.tsx` 的同一支按钮用逐字同一份,
// 所以这句用户可见的话只有一处真源(见那个文件的文件头与可回收条件)。
import { PUBLISH_REPOSITORY_UNAVAILABLE } from './unsupported-notices.ts';
// 「Committing as」卡两条缺口的**文案真源**(本泳道;回收条件写在该文件里)。
import {
  GIT_SETTINGS_ENTRY_NOT_WIRED,
  REPOSITORY_SETTINGS_UNAVAILABLE,
} from './commit-avatar-notices.ts';
// 与上游一致的提交者头像组件(`ui/changes/commit-message-avatar.tsx`)+ 它要的三个模型。
// 组件本体一个字不改 —— 所以下面**必须**按上游的形状把它要的 prop 逐条喂对,
// 拿不到的那几条见 `CommitAuthorAvatar` 的注释(不假装能拿到)。
import { CommitMessageAvatar } from '../core/desktop/ui/changes/commit-message-avatar.tsx';
import { getAvatarUserFromAuthor } from '../core/desktop/models/avatar.ts';
import { CommitIdentity } from '../core/desktop/models/commit-identity.ts';
import type { Commit } from '../core/desktop/models/commit.ts';
import { Repository } from '../core/desktop/models/repository.ts';
// 撤销提交条 —— **上游组件与上游一致,我们不重写**(见 `UndoCommitStrip` 的文件头):
// `ui/changes/undo-commit.tsx` 本体 + 它要的 `ui/relative-time.tsx`(`Committed 3 minutes ago`
// 那一段相对时间,自带按 duration 排的 `setTimeout` 刷新)。
import { UndoCommit } from '../core/desktop/ui/changes/undo-commit.tsx';
// 只是类型:`Emoji` 是 `UndoCommit.emoji` 的元素类型(`ui/changes/undo-commit.tsx:7,14`)。
import type { Emoji } from '../core/desktop/lib/emoji.ts';
// `TransitionGroup`/`CSSTransition` 是上游那 500ms 进出动画的实现
// (`sidebar.tsx:373-381`);`react-transition-group@4.4.5` 已在 package.json 里,
// 没有新增依赖(进出动画的 CSS 由 `desktop-changes.scss` 已经在编译的
// `ui/changes/_changes-list.scss:234-254` 提供 —— 与上游同一个 partial)。
import CSSTransition from 'react-transition-group/CSSTransition';
import TransitionGroup from 'react-transition-group/TransitionGroup';
/*
 * **stash 族**(2026-10 接线;上游 `lib/git/stash.ts` + `ui/stashing/**`)。
 *
 * `models/stash-entry.ts` 此前是「逐字在树、零消费」(`docs/unported-master-ledger.md`
 * §1.1.2 的读数):本文件与 `store.ts` 现在是它的**真消费方** ——
 * `IStashEntry` 是快照字段的类型,`StashedChangesLoadStates` 是那个三态状态机的
 * **运行期**判据(空态卡严格要求 `Loaded`,见上游 `no-changes.tsx:398-407`)。
 */
import { StashedChangesLoadStates } from '../core/desktop/models/stash-entry.ts';
import type { IStashEntry } from '../core/desktop/models/stash-entry.ts';
import { AppFileStatusKind, WorkingDirectoryStatus } from '../core/desktop/models/status.ts';
import type { AppFileStatus } from '../core/desktop/models/status.ts';
/*
 * ---------------------------------------------------------------------------
 * 提交流的**三件镜像件**(2026-10-09;用户规则:「除左下角提交信息生成器以外,
 * 上游 Changes 的每一项功能都必须存在」)
 * ---------------------------------------------------------------------------
 *
 * 三件都是**字节一致的镜像**(`cmp` 无输出),此前树里有、**0 个 importer**
 * (审计 `docs/changes-view-component-tree-audit.md` §2 的旁挂段与 §5 第 7/8 项):
 *
 * | 镜像件 | 上游渲染点 | 本文件的接线点 |
 * |---|---|---|
 * | `ui/changes/continue-rebase.tsx`(75 行) | `filter-changes-list.tsx:905-920` 的**整表单替换** | `CommitBox` 的 rebase 分支 |
 * | `ui/changes/commit-warning.tsx`(56 行) | `commit-message.tsx:1256-1262`(amend 提示)等 7 支 | `CommitBox` 的 amend 提示 |
 * | `ui/changes/confirm-commit-filtered-changes-dialog.tsx`(95 行) | `ui/app.tsx:2809`(`PopupType.ConfirmCommitFilteredChanges`) | `ChangesView` 的提交流(触发点在 `CommitBox`) |
 *
 * **裁决 B(没有 popup 宿主 ⇒ 不从宿主渲染)**:本插件没有应用层弹窗宿主(实测:全仓
 * 只有 `repo-bar.tsx:711` 一个收窄的 `showPopup` 替身,客户端 `PopupDetail` 联合里
 * **没有**这两个 dialog 的型别,两件都不在产物里)⇒ 三件一律**由流程所有者渲染**,
 * 与 `CloneDialog` / `SquashDialog` 完全同形,**零新机制**。
 */
import { ContinueRebase } from '../core/desktop/ui/changes/continue-rebase.tsx';
import { CommitWarning, CommitWarningIcon } from '../core/desktop/ui/changes/commit-warning.tsx';
import { ConfirmCommitFilteredChanges } from '../core/desktop/ui/changes/confirm-commit-filtered-changes-dialog.tsx';
/*
 * ---------------------------------------------------------------------------
 * 共同作者行(`Co-Authored-By`)—— 2026-10-10 **挂载**(用户规则:「上游 Changes 的
 * 每一项功能都必须存在」;实现件本身由另一条泳道落成)
 * ---------------------------------------------------------------------------
 *
 * 上游 `ui/changes/commit-message.tsx:1806` 的 `{this.renderCoAuthorInput()}` 落在
 * **提交按钮之前、`.action-bar` 那一行之后**(`renderAmendCommitNotice` 与
 * `renderSubmitButton` 之间)。我们的 `CommitBox` 是**手写壳**,所以这一行只能由
 * 本文件挂上去 —— 组件本体(`./co-authors-row.tsx`)一个字不改。
 *
 * ⚠️ **它今天在产品里渲染 `null`,而且这是已知的正确行为**(两条上游闸门都关着:
 * `repository.gitHubRepository === null`、`store.coAuthorAutocompletionProviders()`
 * 返回 `[]`)。本文件**不**伪造 `gitHubRepository`、**不**把开关硬写成 `true` ——
 * 探针 `docs/probes/changes-co-authors-mount-probe.mjs` 把这两条做成同帧读数。
 *
 * **退役条件**:① 客户端接上 GitHub 仓库身份;② client 根补上 `GitHubUserStore`
 * 与三个类型模块(见 `co-authors-row.tsx` 的文件头)。两条都满足时这四行编辑继续有效。
 */
import { CoAuthorsRow } from './co-authors-row.tsx';
/*
 * ---------------------------------------------------------------------------
 * 筛选选项弹层换**镜像 `Popover`**(2026-10-10;上游
 * `ui/changes/changes-list-filter-options.tsx:151-224` 用的就是它)
 * ---------------------------------------------------------------------------
 *
 * 改前是我们**手写**的一个绝对定位 `div.gw-filter-pop`(styles.ts):有关闭按钮与
 * 「点选项即关」,但**没有** Escape、没有 FocusTrap、关闭后焦点不回触发按钮 ——
 * 与 `docs/goal-port-desktop.md` §10.9 记的「手写弹层通病」同一族,
 * 审计 `docs/changes-file-list-gap-audit.md` §3.3 #28/#12 各记过一条。
 *
 * 镜像 `Popover` 自己就带 `focus-trap-react`(`escapeDeactivates: true` +
 * `returnFocusOnDeactivate` 的默认值)与 `onClickOutside`/`onMousedownOutside`,
 * 所以换成它**不是**换一层皮:三条行为(点外面关 / Esc 关 / 焦点归还)由它提供。
 */
import { Popover, PopoverAnchorPosition, PopoverDecoration } from '../core/desktop/ui/lib/popover.tsx';
/*
 * ---------------------------------------------------------------------------
 * 超大文件告警(`OversizedFiles`)—— 2026-10-10 接线(用户规则:「上游 Changes 的
 * 每一项功能都必须存在」)
 * ---------------------------------------------------------------------------
 *
 * 上游那一条链是**三跳**,逐条对着源码读出来:
 *
 * | 上游 | 位置 | 内容 |
 * |---|---|---|
 * | 触发点 | `ui/changes/sidebar.tsx:159-183`(`onCreateCommit` 的第一件事) | `getLargeFilePaths(repository, workingDirectory)` ⇒ `filesNotTrackedByLFS(repository, overSizedFiles)` ⇒ 非空则 `showPopup({ type: PopupType.OversizedFiles, … })` 并 **`return false`**(不提交) |
 * | 判定(阈值) | `lib/large-files.ts:7,28-35` | `stat(join(repository.path, file.path)).size > 100 * 1024 * 1024`,`selection.getSelectionType() !== None` 的**纳入提交**文件才量 |
 * | 弹窗 | `ui/changes/oversized-files-warning.tsx`(90 行) | `Dialog id="oversized-files"` + 标题「Files too large」+ 那句「If you commit these files, you will no longer be able to push this repository to GitHub.com.」+ `PathText` 列表 + `OkCancelButtonGroup destructive okButtonText="Commit Anyway"`;`onSubmit` 自己调 `dispatcher.commitIncludedChanges(repository, context)` 然后 `setCommitMessage(repository, DefaultCommitMessage)` |
 *
 * **两半都是镜像件**:阈值判定是 `src/core/desktop/lib/large-files.ts`(逐字,`cmp` 无输出),
 * 「是否被 LFS 覆盖」由宿主 `lfs/untracked` 路由**复用**镜像
 * `src/host/mirror/lib/git/lfs.ts:107` 的 `filesNotTrackedByLFS`。本文件只做**接线**
 * (裁决 B:没有 popup 宿主 ⇒ 由流程所有者渲染,与 `CloneDialog` / `SquashDialog` /
 * `ConfirmCommitFilteredChanges` 完全同形)。
 *
 * ⚠️ **本项含宿主半改动**(`file-size` 与 `lfs/untracked` 两条路由 + `GitService.fileSize`
 * + `src/host/lfs-check.ts`)⇒ **要重启 DSH** 才生效;只刷新页面时 `file-size` 404,
 * 镜像 `getLargeFilePaths` 会把那个 ENOENT 逐文件吞掉(它自己的 `catch`),告警**不出现**。
 * 这正是 `src/client/store.ts:1034-1039` 那条「host 半是旧构建 … 请重启 DSH」存在的理由。
 */
import { OversizedFiles } from '../core/desktop/ui/changes/oversized-files-warning.tsx';
import { getLargeFilePaths } from '../core/desktop/lib/large-files.ts';
import type { ICommitContext } from '../core/desktop/models/commit.ts';
/*
 * 镜像 `Dialog` 的 `DialogStackContext` —— **不是可选装饰**:它的默认值是
 * `{ isTopMost: false }`(`ui/dialog/dialog.tsx:37-39`),而 `Dialog.componentDidMount`
 * 只在 `isTopMost` 为真时才 `dialogElement.showModal()`(`:394-404`)。
 * 没有 Provider 的话原生 `<dialog>` **永远不会打开**(UA 默认 `display:none`)——
 * 那正是「面板从没打开过」那一类空绿。上游由 `ui/app.tsx` 的 popup 栈提供它,
 * 我们由**流程所有者**提供一个单元素栈(`value={{ isTopMost: true }}`)。
 */
import { DialogStackContext } from '../core/desktop/ui/dialog/dialog.tsx';
import { LinkButton } from '../core/desktop/ui/lib/link-button.tsx';
import type { RebaseConflictState } from '../core/desktop/lib/app-state.ts';
// `ContinueRebase` 的 `onSubmit` 把 `MultiCommitOperationKind.Rebase` 交给门面
// (`continue-rebase.tsx:25`);门面的签名要与上游逐字 ⇒ 这里也要那个类型。
// 上游它是个 `const enum`(`models/multi-commit-operation.ts:13`),`import type`
// 不产生运行期边(我们不读它的值,只放在参数类型位置)。
import type { MultiCommitOperationKind } from '../core/desktop/models/multi-commit-operation.ts';
import { Dispatcher } from '../core/desktop/ui/dispatcher/index.ts';
import {
  CONFIRM_COMMIT_FILTERED_CHANGES_KEY,
  getConfirmCommitFilteredChanges,
  setConfirmCommitFilteredChanges,
  subscribePreference,
} from './prefs.ts';

/*
 * ⚠️ 这个**门面类必须定义在 `ChangesView` 之前**:`no-use-before-define` 会把
 * 「先用在 `useMemo` 里、类在后面」记成新增违规(实测 `check-lint` 的 6 条新增之一)。
 * 它只依赖 import 进来的镜像 `Dispatcher`,放在模块顶部没有任何副作用。
 */
/**
 * `OversizedFiles` 要的那两个 `Dispatcher` 方法 —— 它的 `onSubmit` 逐字是
 * (`ui/changes/oversized-files-warning.tsx:77-89`):
 *
 * ```ts
 * this.props.onDismissed()
 * await this.props.dispatcher.commitIncludedChanges(this.props.repository, this.props.context)
 * this.props.dispatcher.setCommitMessage(this.props.repository, DefaultCommitMessage)
 * ```
 *
 * 也就是说**「Commit Anyway」真的要提交一次**(它不是「关掉弹窗就完事」)——
 * 这条闸门与 `ConfirmCommitFilteredChanges` 那条同形(那边是
 * `onCommitAnyway` 回调,这边是 dispatcher 方法,因为上游就是这么分的)。
 *
 * ## `setCommitMessage` 为什么是**空实现**(如实记这一处偏离)
 *
 * 上游 `_setCommitMessage(repository, DefaultCommitMessage)` 是**无条件**清空提交信息
 * (提交成功、失败都清)。我们**不**照做,因为:
 *  · 我们这层的 `store.commit()` 在**成功**路径上已经重置了表单
 *    (`src/client/store.ts:3120-3138` 的 `commitForm: {...base, signoff, noVerify}`),
 *    所以成功时这一句本来就是多余的;
 *  · 失败时清空会把用户刚写的提交信息**删掉**(上游那条无条件清理的后果),
 *    而本仓没有任何理由复刻这个副作用。
 * ⇒ 这里是**一条有意的行为偏离**,不是漏做;要复刻上游只需在这里调
 * `store.setCommitField('summary', '')` + `('description', '')`。
 */
class OversizedFilesDispatcher extends Dispatcher {
  public constructor(private readonly onCommitAnyway: () => Promise<void>) {
    super();
  }
  public async commitIncludedChanges(): Promise<boolean> {
    await this.onCommitAnyway();
    return true;
  }
  public async setCommitMessage(): Promise<void> {
    // 见类注释:成功时的重置已经由 `store.commit()` 自己做,失败时**故意不清**。
  }
}

export function ChangesView(props: {
  store: GitStore;
  snap: Snapshot;
  /**
   * 打开偏好设置弹窗(**已接线**,2026-10)。
   *
   * `WorkbenchApp` 在 `workbench.tsx` 里传的是 `openGitSettings`
   * (`openPreferencesAt('git')`)⇒ 落到 **Git 页**,与上游
   * `ui/changes/commit-message.tsx:809-814` 的
   * `PopupType.Preferences` + `PreferencesTab.Git` 同义。
   * 绑定关系留在 `workbench.tsx` 那一处(本组件只知道「要开偏好设置」)。
   *
   * **仍然可选**:直接挂 `ChangesView` 的探针(如
   * `docs/probes/commit-avatar-driver.tsx` 的 `mode=direct`)可以自己传一个 spy;
   * 缺它时那条按钮给一条**说实话**的 toast(`commit-avatar-notices.ts` 的
   * `GIT_SETTINGS_ENTRY_NOT_WIRED`),不是静默 no-op。
   * ⚠️ 那条常量在**产品路径上**已经不可达(workbench 一定传),它的持有者可以按
   * 那份文件里写的回收条件删掉;本文件保留兜底是为了让「漏传 prop」仍然可见。
   */
  onOpenPreferences?: () => void;
  /**
   * 打开**仓库设置**弹窗(2026-10 接线;此前那两处链接是一条点名缺什么的 toast)。
   *
   * 上游两个入口都落在这里:
   *  - `ui/changes/commit-message-avatar.tsx:260-263` / `:312-316` 的两处
   *    `repository settings` 链接 ⇒ `onOpenRepositorySettings`;
   *  - `ui/changes/commit-message.tsx:801-807` 派发
   *    `PopupType.RepositorySettings` + **`RepositorySettingsTab.GitConfig`**
   *    ⇒ 所以 `workbench.tsx` 传进来的回调**预选 Git 配置页**。
   *
   * **仍然可选**:直接挂 `ChangesView` 的探针可以自己传 spy;缺它时那两处链接
   * 给一条**说实话**的 toast(`commit-avatar-notices.ts` 的
   * `REPOSITORY_SETTINGS_UNAVAILABLE`),不是静默 no-op。
   * ⚠️ 那条常量在本轮落地后于产品路径上**已经不可达**(workbench 一定传),
   * 回收条件写在它自己的文件头里。
   */
  onOpenRepositorySettings?: () => void;
}): ReactNode {
  const { store, snap } = props;
  const [confirmDiscard, setConfirmDiscard] = useState<ChangedFile[] | null>(null);
  /**
   * **行/块级丢弃**的待确认项(上游 `PopupType.ConfirmDiscardSelection`,
   * `ui/changes/changes.tsx:84-89`)。
   *
   * 与整文件丢弃(`confirmDiscard`)是**两条不同的路**,刻意分开存:
   *  - 整文件 ⇒ `store.discardFiles` ⇒ 宿主 `discard` 路由(`git checkout -- <paths>` /
   *    未跟踪走 `git clean`);
   *  - 行/块 ⇒ `store.discardLines` ⇒ 宿主 `discard-lines` 路由
   *    (`git apply --reverse`,索引一个字节不动)。
   * 两者共用一句话的措辞不行 —— 一个是「文件没了」,一个是「文件里那几行没了」。
   */
  const [confirmDiscardLines, setConfirmDiscardLines] = useState<{ file: string; spec: LineSelectionSpec } | null>(null);
  /**
   * **覆盖贮藏**的确认闸门(上游 `PopupType.ConfirmOverwriteStash`,
   * `ui/stash-changes/overwrite-stashed-changes-dialog.tsx`)。
   *
   * 上游的措辞是 `warning` + destructive 的 `Overwrite` 按钮
   * (`:37-55`:正文「This will overwrite your existing stash with your current changes.」)。
   * 我们复用仓库里**已有的**对话框壳(`bits.tsx` 的 `ConfirmDialog`),不新建第二套
   * —— 与 `confirmDiscard` / `confirmDiscardLines` 同一条分工。
   */
  const [confirmStashOverwrite, setConfirmStashOverwrite] = useState(false);
  /** stash 面板里「丢弃这条贮藏」的确认闸门(上游 `PopupType.ConfirmDiscardStash`)。 */
  const [confirmDiscardStash, setConfirmDiscardStash] = useState(false);
  /**
   * **Changes 页签现在显示的是工作区还是 stash** —— 上游是
   * `changesState.selection.kind`(`ChangesSelectionKind.WorkingDirectory` ↔
   * `ChangesSelectionKind.Stash`,`lib/app-state.ts:790-810`),
   * 由 `Dispatcher.selectStashedFile` / `selectWorkingDirectoryFiles` 切换
   * (`app-store.ts:3569` 的 `_selectStashedFile`),`filter-changes-list.tsx:1095-1105`
   * 的 `onStashEntryClicked` 就是那个开关。
   *
   * ⚠️ **本仓用一个组件内的布尔量顶替那份状态**,理由是它今天只服务这一棵子树
   * (上游那份在 `repositoryStateCache` 里,因为我们还没有把 Changes 容器整体切到
   * `ui/changes/**`)。**退役条件**:Changes 容器接线那一刻,这个 boolean 应当搬进
   * `repo-state-cache.ts` 的 `selection.kind`(`models/` 那一侧的类型已经在了),
   * 否则同一个判断会有两份真源。
   */
  const [showStashedChanges, setShowStashedChanges] = useState(false);

  /**
   * 行尾两颗单文件按钮(暂存 / 取消暂存 / 丢弃)的**具名回调**。
   *
   * **为什么不能写成 JSX 内联箭头**:`react/jsx-no-bind`(`scripts/lint-baseline.json`
   * 是**只拦上升**的棘轮)会把组件作用域里的内联箭头记成新增违规。
   * 这几个回调的依赖只有 `store`(引用稳定),所以身份稳定,不会让下游行白白重渲染。
   *
   * ⚠️ 2026-10:**顶部那两颗「全部暂存 / 取消暂存」已按用户指令移除**
   * (上游 `ui/changes/**` 与 `ui/diff/**` 里 `Staged|staged|Stage |Unstage` 命中 **0**,
   * 见 `docs/goal-port-desktop.md` §11.4 ⇒ 那两颗是我们发明的入口,不是抄漏)。
   * 与之配套的 `onStageAll` / `onUnstageAll` 两个 `useCallback` 一起删掉了(它们只服务那两颗按钮);
   * **`store.stageSelected` / `store.unstageSelected` 一个字没删**(「先做,不删」),
   * 只是今天没有产品调用点了(探针仍会直接调 `store` 的那两条,见
   * `docs/probes/changes-discard-lines-probe.mjs` 的 D 组)。
   */
  /**
   * `FileRow` 那三颗行尾按钮的**行内**回调工厂。
   *
   * 为什么用「工厂 + 具名引用」而不是 JSX 内联箭头:`react/jsx-no-bind` 只认
   * `useCallback` 这类 CallExpression,不认组件作用域里的箭头 —— 而 `FileRow` 是
   * **模块作用域**的组件,它自己那三个 `onClick` 也是同一个问题。
   * 所以这里按「行」生成三个稳定的回调(依赖只有 store 与那个路径)。
   */
  const stageRow = useCallback((path: string) => { void store.stageFile(path); }, [store]);
  const unstageRow = useCallback((path: string) => { void store.unstageFile(path); }, [store]);
  const discardRow = useCallback((file: ChangedFile) => { setConfirmDiscard([file]); }, []);

  /**
   * 外部编辑器清单**早加载**。
   *
   * ⚠️ 为什么必须有这一条:`store.loadExternalApps()` 此前**只有空态卡**
   * (`NoChanges`,本文件 `:1906`)调 —— 而那个组件只在 `files.length === 0` 时渲染。
   * 于是「有变更」的时候 `snap.externalApps` 恒 `[]`,右键菜单里
   * 「在 <编辑器> 中打开」就永远回落到上游的兜底文案 `Open in External Editor`
   * (`ui/lib/context-menu.ts:11-13`)。上游是在应用启动时加载一次
   * (`app-store` 的 `_initializeExternalEditors`),与「有没有变更」无关。
   *
   * 幂等:`store.ts:2217` 开头 `if (this.state.externalApps.length > 0) { return; }`
   * ⇒ 与空态卡那一条同时存在也**只发一条** `system/apps` 请求。
   */
  useEffect(() => { void store.loadExternalApps(); }, [store]);

  /**
   * 右键菜单的**动作面** —— 与行尾三颗图标、表头勾选框是**同一批真动作**
   * (没有为菜单新开第二条路):
   *  · `discard` ⇒ 走**同一个**确认框状态(与行尾垃圾桶同一条路);
   *  · `setFilesIncluded` ⇒ `store.setFilesIncluded`(与表头三态勾选框同一个,只改客户端纳入状态,不发 git 命令);
   *  · `revealInFileManager` / `openInExternalEditor` ⇒ `store.*`(`system/reveal` / `system/open-in-app`);
   *  · `copyText` ⇒ `navigator.clipboard`(`bits.tsx:799` 的 SHA 胶囊用的是同一个 API)。
   *
   * **本轮变更(2026-10)**:`appendIgnoreFile` / `appendIgnorePattern` **接上了** ——
   * 宿主那两条路由已经建好(`gitignore/save` / `gitignore/append`,见
   * `src/host/gitignore.ts`),`store.appendIgnoreFile` / `appendIgnorePattern` 写完之后
   * 会 `refreshStatus()` ⇒ 文件**当场**从列表里消失(不是刷新页面之后)。
   * `stashAll` **仍然刻意不传**:`STASH_ROUTE_AVAILABLE` 还是 `false`(没有 stash 路由,
   * 已登记的取舍),缺动作 ⇒ 「贮藏全部改动」那一项**在列但诚实禁用**。
   */
  const menuActions = useMemo(() => ({
    discard: (targets: readonly ChangedFile[]) => { setConfirmDiscard([...targets]); },
    setFilesIncluded: (paths: readonly string[], included: boolean) => { store.setFilesIncluded(paths, included); },
    revealInFileManager: (absolutePath: string) => { void store.revealInFileManager(absolutePath); },
    openInExternalEditor: (absolutePath: string, appId?: string) => {
      void store.openInExternalEditor(absolutePath, appId);
    },
    copyText: (text: string) => { void navigator.clipboard?.writeText(text); },
    appendIgnoreFile: (paths: readonly string[]) => { void store.appendIgnoreFile(paths); },
    appendIgnorePattern: (pattern: string) => { void store.appendIgnorePattern(pattern); },
  }), [store]);

  /** 逐文件右键 ⇒ 上游 `onItemContextMenu`(`filter-changes-list.tsx:839-857`)。 */
  const rowMenu = useCallback((event: React.MouseEvent, file: ChangedFile) => {
    // 上游 `event.preventDefault()`(`:849`)+ 浏览器里还要挡住原生菜单
    // (`context-menu-host.tsx` 的文件头第 2 条:`desktop-diff.tsx` 的容器是加**捕获阶段**
    // 处理器的;本面在冒泡阶段 preventDefault 就够 —— 原生菜单在事件到达目标后、
    // 没有 preventDefault 时才弹,命中行冒泡到这里就已被挡住)。
    event.preventDefault();
    const current = store.snapshot();
    void showChangesFileMenu({
      repositoryPath: current.current,
      file,
      selectedPaths: current.selectedFiles,
      files: current.status?.files ?? [],
      externalEditor: resolvePrimaryExternalEditor(current.externalApps, getPreferredExternalEditor()),
      rebaseConflict: current.status?.operation === 'rebase',
      committing: current.busy === 'commit',
    }, menuActions);
  }, [store, menuActions]);

  /** 表头右键 ⇒ 上游 `onContextMenu`(`filter-changes-list.tsx:535-570`)。 */
  const headerMenu = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    const current = store.snapshot();
    const currentFiles = current.status?.files ?? [];
    void showChangesListMenu({
      files: currentFiles,
      branch: current.status === null || current.status.detached === true || current.status.unborn === true
        ? null
        : current.status.branch,
      hasConflictedFiles: currentFiles.some((f) => f.conflicted === true),
      conflictState: (current.status?.operation ?? null) !== null,
      committing: current.busy === 'commit',
      rebaseConflict: current.status?.operation === 'rebase',
      /*
       * `hasStash` 的上游出处:`filter-changes-list.tsx:544` 读
       * `changesState.stashEntry`,`:549-554,563` 用它决定标签带不带省略号
       * (「贮藏全部改动…」= 还会再问一次要不要覆盖)。
       * 改前这里是写死的 `false`,于是那一项**恒不带省略号**。
       */
      hasStash: current.stashEntry !== null,
    }, {
      discardAll: (targets: readonly ChangedFile[]) => { setConfirmDiscard([...targets]); },
      /*
       * **`stashAll` 2026-10 接上了**。确认闸门留在本层(与 `discardAll` 同一条分工):
       * 上游 `AppStore._createStashForCurrentBranch(repository, true)`
       * (`lib/stores/app-store.ts:4849-4886`)在 `hasExistingStash` 时**不建 stash**,
       * 而是弹 `PopupType.ConfirmOverwriteStash`(`:4865-4871`);
       * 确认之后才走 `createStashAndDropPreviousEntry`(`:8980-9000`)——
       * 那一步就是 `store.stashAllChanges()`。
       */
      stashAll: () => {
        if (store.snapshot().stashEntry !== null) { setConfirmStashOverwrite(true); return; }
        void store.stashAllChanges();
      },
    });
  }, [store]);
  const onDiscardLinesSelected = useCallback(
    (file: string, spec: LineSelectionSpec) => { setConfirmDiscardLines({ file, spec }); },
    [],
  );
  /**
   * 打开 stash 面板(空态那两处入口 —— 卡片按钮与左下角那颗按钮 —— 用的是**同一个**回调)。
   *
   * 为什么不是「onClick 里内联一个 setState」:`react/jsx-no-bind` 只认 CallExpression,
   * 组件作用域里的内联箭头会被记成新增 lint 违规(本文件那几条存量就是这么来的)。
   */
  const onViewStash = useCallback(() => { setShowStashedChanges(true); }, []);
  /**
   * 左下角那颗按钮的**开关** —— 上游 `onStashEntryClicked`
   * (`filter-changes-list.tsx:1094-1105`):已经显示着 stash ⇒ 切回工作区列表
   * (`dispatcher.selectWorkingDirectoryFiles`);否则切到 stash
   * (`dispatcher.selectStashedFile`)。
   */
  const onToggleStashView = useCallback(() => { setShowStashedChanges((showing) => !showing); }, []);
  /**
   * stash 面板里那颗「丢弃」按钮 —— 上游 `StashDiffHeader.onDiscardClick`
   * (`ui/stashing/stash-diff-header.tsx:79-103`)的**判定那一半**:
   * `askForConfirmationOnDiscardStash` 为真时弹 `PopupType.ConfirmDiscardStash`,
   * 否则**直接**丢。
   *
   * 那个偏好(`confirmDiscardStash`,`lib/stores/app-store.ts:245` / `:4635` 一族)今天
   * **没有写侧**(我们没有那个「Do not show this message again」复选框的落点),
   * 所以它按**默认值 `true` 走确认框** —— 与上游出厂设置一致,不是我们发明的拦截。
   * 探针把两条分支都量过(见 `docs/probes/stash-ui-probe.mjs` 的 D 组)。
   */
  const onDiscardStashClick = useCallback(() => { setConfirmDiscardStash(true); }, []);
  /** 左栏宽度(变更列表 + 提交区 | diff),持久化到 `dsh-git.sidebar-width`。 */
  const split = useSplitWidth(SIDEBAR_WIDTH_STORAGE_KEY);
  /**
   * 给镜像 `PathLabel` → `PathText` 的**实测可用宽度**(上游 `changed-file.tsx:57-67` 的同一套算术:
   * `listItemPadding 10*2` + `checkboxWidth 20` + `filePadding 5` + `statusWidth 16` = **51**)。
   *
   * `undefined` 是**刻意**的兜底(jsdom 没有布局引擎,`split.width` 是 0):
   * `PathText` 在不给宽度时渲染**完整文本**(`path-text.tsx:344-347`),给了才会按实测截断。
   * ⇒ 真实浏览器里拿到真实宽度(截断位置与 Desktop 一致),测不到宽度时不假装截断。
   */
  const pathWidth = split.width > 120 ? split.width - 51 : undefined;

  const status = snap.status;
  /**
   * **`files` 必须是一个稳定引用**(2026-10 修 `react-hooks/exhaustive-deps`):
   * `status?.files ?? []` 里那个 `[]` 字面量**每次渲染都是一个新数组** ⇒ 它的下游
   * `useCallback`(`onListItemContextMenu` / `toggleIncludeOf` / `filtered` 一族)
   * 依赖数组**每帧都变** ⇒ 那些 memo 全部失效。`useMemo` 不是性能装饰,是这条
   * 依赖链成立的前提;`status` 变(真刷新)时它照旧重算。
   */
  const files = useMemo(() => status?.files ?? [], [status]);
  /**
   * 一个文件的**纳入状态**(三态)。真值在 `store.includeState`(客户端模型),
   * 缺失 = 默认纳入(上游 `DiffSelection.fromInitialSelection(All)`)。
   */
  const stateOf = (file: ChangedFile): IncludeState => includeStateOf(snap.includeState[file.path]);
  const listed = new Set(files.map((f) => f.path));

  /**
   * **`selected` 同理必须稳定**(2026-10 修 `react-hooks/exhaustive-deps`):
   * `new Set(...)` 每次渲染都是新对象 ⇒ `onPlainKeyDown` / `renderRow` 的依赖数组
   * 每帧都变。`store.selectFiles` / `toggleFile` / 每次 `refreshStatus` 的过滤都
   * **重新分配** `selectedFiles` 数组(`store.ts:1724-1731`、`:1845-1857`)⇒
   * 用它的引用做 dep 不会漏更新。
   */
  const selected = useMemo(() => new Set(snap.selectedFiles), [snap.selectedFiles]);

  // ---- 筛选(照 Desktop 的 Filter Options)----
  //
  // Desktop 的**五项**就是这些(`ui/changes/changes-list-filter-options.tsx:179,188`):
  //   Included in commit / Excluded from commit / New / Modified / Deleted。
  // 我们以前的前两项是「已暂存 / 未暂存」—— 那是把索引这个**实现细节**当成 UI 主轴,
  // 本轮连同两行制一起去掉。
  const [filterText, setFilterText] = useState('');
  const [activeOptions, setActiveOptions] = useState<FilterKey[]>([]);
  const [filterOpen, setFilterOpen] = useState(false);

  /**
   * 五项筛选的**单一真源** —— 镜像 `IFileListFilterState`(`lib/app-state.ts:873-...`)。
   * 上游它是 app-state 字段(由六个 `dispatcher.set*Filter*` 写);我们是 `useState`,
   * 但**只有这一处**(`filterText` + `activeOptions` 两者)。
   */
  const filterState: IFileListFilterState = {
    filterText,
    isIncludedInCommit: activeOptions.includes('included'),
    isExcludedFromCommit: activeOptions.includes('excluded'),
    isNewFile: activeOptions.includes('new'),
    isModifiedFile: activeOptions.includes('modified'),
    isDeletedFile: activeOptions.includes('deleted'),
  };
  const FILTER_KEYS: FilterKey[] = ['included', 'excluded', 'new', 'modified', 'deleted'];
  const FILTER_LABELS: Record<FilterKey, string> = {
    included: '纳入提交', excluded: '排除提交', new: '新文件', modified: '已修改', deleted: '已删除',
  };
  /**
   * ⭐ **可见行 = 镜像的筛选结果**:`filterChangesRows` 用的是镜像 `match`
   * (模糊匹配 + 匹配下标 + 按分数排序,`lib/fuzzy-find.ts:24-53`)与镜像 `applyFilters`
   * (五个选项,`filter-changes-logic.ts:155-166`)。
   * 我们原来那份 `passes()`(子串匹配、无下标、保持原顺序)**已退役** ——
   * 它给不出 `<mark>` 需要的位置,也不做上游那种重排。
   *
   * `useMemo` 的 dep 只列**值**的依赖:`filterState` / `stateOf` 每次渲染都是新对象,
   * 把它们列进去等于没有 memo(审计 §3.4 #38 记的就是这条「输入筛选词时全量重建」)。
   */
  const filtered = useMemo(
    () => filterChangesRows(files, filterState, true, stateOf),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [files, filterText, activeOptions, snap.includeState],
  );
  /**
   * 可见的**文件**那一列 —— 由 `filtered` 派生,所以只在筛选结果真的变时重建
   * (2026-10-09:以前每次渲染都 `map` 一遍 500 行,而它的下游是
   * `flat` / `visibleItems` / `invalidationProps` 一族 —— 每帧换身份会让
   * `changes-file-list.tsx` 的失效闸门恒为「变了」,那次接线就等于没接)。
   */
  const shown = useMemo(() => filtered.rows.map((row) => row.file), [filtered]);
  /**
   * 计数**只统计当前可见集合**(与 Desktop 的 `getFilterCounts` 同口径,不是总数)。
   * 谓词用的是**镜像的** `applyFilters`(单项打开),所以计数与列表**不可能**分叉
   * —— 这正好收掉审计 §3.3 #29 那处细微差(上游 `included` 的判据是
   * `selection.getSelectionType() === All`,我们原来是 `!== 'none'`)。
   */
  const singleOptionFilter = (key: FilterKey): IFileListFilterState => ({
    filterText: '',
    isIncludedInCommit: key === 'included',
    isExcludedFromCommit: key === 'excluded',
    isNewFile: key === 'new',
    isModifiedFile: key === 'modified',
    isDeletedFile: key === 'deleted',
  });
  const optionCounts = useMemo(() => Object.fromEntries(
    FILTER_KEYS.map((key) => [key, filtered.rows.filter((row) => applyFilters(row, true, singleOptionFilter(key))).length]),
    // `FILTER_KEYS` 是组件内的常量数组(内容恒定);`singleOptionFilter` 每帧新建但只读闭包。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ) as Record<FilterKey, number>, [filtered]);
  const visible = { total: filtered.rows.length };
  const includedCount = useMemo(
    () => files.filter((f) => includeStateOf(snap.includeState[f.path]) !== 'none').length,
    [files, snap.includeState],
  );
  const shownIncludedCount = useMemo(
    () => filtered.rows.filter((row) => includeStateOf(snap.includeState[row.file.path]) !== 'none').length,
    [filtered, snap.includeState],
  );
  /** 头部三态复选框:全部纳入 → 选中;一个都没 → 未选;部分 → 混合。 */
  const allShownIncluded = shown.length > 0 && shownIncludedCount === shown.length;
  /**
   * `.diff-container` 的 ref(我们渲染的那一层,`ui/changes/changes.tsx:104`)。
   * `DiffPane` 要拿它量两件事,见那边 `useLayoutEffect` 的注释 —— 都只服务
   * `+n/-n` 回到 header 行里这一条布局(用户 2026-10-09 的裁决)。
   */
  const diffContainerRef = useRef<HTMLDivElement>(null);
  const checkAllRef = useRef<HTMLInputElement>(null);
  /**
   * 筛选按钮的 ref —— 镜像 `Popover` 的 `anchor`(上游
   * `changes-list-filter-options.tsx:157,225-227` 用 `filterOptionsButtonRef` 同一个用途)。
   * 弹层定位(floating-ui)与「Esc/点外面关闭之后焦点回到触发按钮」都以它为锚。
   */
  const filterButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const el = checkAllRef.current;
    if (el === null) { return; }
    // 三态用原生 indeterminate(与 Desktop 的 Checkbox 同一套语义)
    el.indeterminate = shownIncludedCount > 0 && shownIncludedCount < shown.length;
  });

  /** 键盘导航按**界面上的顺序**走(单一列表 = 就是 filtered 顺序)。 */
  const flat: { file: ChangedFile }[] = useMemo(() => shown.map((file) => ({ file })), [shown]);

  // ---- 「被隐藏的改动仍会被提交」告警条(`hidden-changes-warning`)----
  //
  // 上游 `filter-changes-list.tsx:1393-1422` 的四个输入,在这里逐个对应(顺序同上游):
  //   · `filesSelected.map(f => f.id)`(`:1396-1398`)⇒ 纳入提交的那些文件的 path;
  //   · `this.state.filteredItems`(`:1403`)           ⇒ 当前可见的行(`shown`);
  //   · `files.length`(`:1404`)                        ⇒ **全部**文件数;
  //   · `this.props.fileListFilter`(`:1405`)           ⇒ 五项选项 + 文字。
  // 谓词本身是上游导出的 `isCommittingFileHiddenByFilter`(`filter-changes-logic.ts:49-72`,
  // 镜像里字节一致),**不是**我们重写的等价物 —— 见 `./hidden-changes-warning.tsx`。
  //
  // 为什么必须接:提交走的是 `store.commit()` → `includedFiles()`,也就是
  // **全部** `includeState !== 'none'` 的文件(`src/client/store.ts:984-985,1008-1010`),
  // 跟这里的筛选**毫无关系** ⇒ 筛选生效时被藏起来的改动照样被提交,而界面一个字都不说。
  const includedPaths = useMemo(
    () => files.filter((f) => includeStateOf(snap.includeState[f.path]) !== 'none').map((f) => f.path),
    [files, snap.includeState],
  );
  const visibleItems = useMemo(() => new Map(shown.map((f) => [f.path, f])), [shown]);
  /**
   * 上游 `showFilesToBeCommitted`(`filter-changes-list.tsx:1207-1221`)的四步筛选动作,
   * 逐步对应:`clearFilter()` ⇒ `setFilterText('')`;
   * `setFilterExcludedFiles/NewFiles/ModifiedFiles/DeletedFiles(..., false)` ⇒ 这四个键不在
   * `activeOptions` 里;`setIncludedChangesInCommitFilter(..., true)` ⇒ 只留 `'included'`。
   * 上游最后那句 `incrementMetric('adjustedFiltersForHiddenChangesCount')` 属
   * `lib/stats`(§1.3 排除),刻意不做。
   */
  const showFilesToBeCommitted = (): void => {
    setFilterText('');
    setActiveOptions(['included']);
  };

  /*
   * ---------------------------------------------------------------------------
   * 「提交被筛选隐藏的改动」的确认闸门(2026-10-09)
   * ---------------------------------------------------------------------------
   *
   * 上游这一条链有三个节点,**逐条逐字**对着镜像读出来:
   *
   * | 上游 | 位置 | 内容 |
   * |---|---|---|
   * | 触发谓词 | `filter-changes-list.tsx:943-951` | `askForConfirmationOnCommitFilteredChanges && isCommittingFileHiddenByFilter(filesSelected.map(f=>f.id), this.state.filteredItems, fileCount, this.props.fileListFilter)` |
   * | 传递 | 同文件 `:1011` → `commit-message.tsx:201` | prop `showPromptForCommittingFileHiddenByFilter` |
   * | 真正的闸门 | `commit-message.tsx:626-637` | `if (options?.warnFilesNotVisible !== false && this.props.showPromptForCommittingFileHiddenByFilter === true && this.props.onFilesToCommitNotVisible) { onFilesToCommitNotVisible(() => this.createCommit({ …warnFilesNotVisible: false })); return }` |
   * | 弹窗载荷 | `filter-changes-list.tsx:1195-1201` | `dispatcher.showPopup({ type: PopupType.ConfirmCommitFilteredChanges, onCommitAnyway, showFilesToBeCommitted })` |
   *
   * **我们这边怎么落**:本插件**没有 popup 宿主**(全仓只有 `repo-bar.tsx:711` 一个收窄的
   * `showPopup` 替身),所以按裁决 B —— 由**流程所有者**(本组件,它同时是提交动作与这个
   * 弹窗的持有者)渲染镜像 `ConfirmCommitFilteredChanges`,与 `CloneDialog` / `SquashDialog`
   * 完全同形。**没有新增机制**:弹窗状态就是我们自己的一个 `useState`。
   *
   * 谓词用的是**镜像那个纯函数本人**(`isCommittingFileHiddenByFilter`,与告警条同一份代码),
   * 不是重写的等价物;`visibleItems` 的键就是 `filesSelected` 里用的那个 id(`file.path`,
   * 与 `IChangesRowItem.id` 同源,见 `changes-file-list.tsx:214`)。
   */
  /**
   * 那偏好的**读侧**(React 侧写法见 `src/client/prefs.ts` 里那个键的注释:
   * 这个键刻意不用 `useSyncExternalStore` —— 20+ 条 jsdom 探针直接挂本组件、
   * 跑的是 React 17,那条 18-only 的导出会让整棵树被卸载,判据失真)。
   * 用 prefs 模块本来就导出的两个原语:读一次当**初值**,再订阅同一个广播。
   */
  const [askForConfirmationOnCommitFilteredChanges, setAskForConfirmation] =
    useState(getConfirmCommitFilteredChanges);
  useEffect(
    () => subscribePreference(
      CONFIRM_COMMIT_FILTERED_CHANGES_KEY,
      () => { setAskForConfirmation(getConfirmCommitFilteredChanges()); },
    ),
    [],
  );
  const showPromptForCommittingFileHiddenByFilter =
    askForConfirmationOnCommitFilteredChanges &&
    isCommittingFileHiddenByFilter(includedPaths, visibleItems, files.length, filterState);
  /**
   * 弹窗在场时的**回调载荷** —— 上游 `PopupType.ConfirmCommitFilteredChanges` 的
   * `onCommitAnyway`(`commit-message.tsx:632-636` 那个闭包:`createCommit({warnFilesNotVisible:false})`)。
   * `null` = 弹窗不在场(不是「有一个空的弹窗」)。
   */
  const [commitFilteredAnyway, setCommitFilteredAnyway] = useState<(() => void) | null>(null);
  const onFilesToCommitNotVisible = useCallback((onCommitAnyway: () => void): void => {
    setCommitFilteredAnyway(() => onCommitAnyway);
  }, []);
  const onDismissCommitFiltered = useCallback((): void => { setCommitFilteredAnyway(null); }, []);
  /*
   * ---------------------------------------------------------------------------
   * 超大文件告警(>100 MiB)**在场时的载荷** —— 上游
   * `ui/changes/sidebar.tsx:170-180` 的 `showPopup({type: PopupType.OversizedFiles, …})`
   * ---------------------------------------------------------------------------
   *
   * `null` = 弹窗不在场(不是「有一个空的弹窗」)。载荷三件与上游那个 popup 变体逐字同
   * (`models/popup.ts` 的 `OversizedFiles`: `oversizedFiles` + `context` + `repository`),
   * 由**触发它的那一层**(`CommitBox` 的提交流,它手里才有 `summaryOrPlaceholder` 与
   * `Repository`)算好了交上来 —— 与上游 `commit-message.tsx` 造 `commitContext` 再交给
   * `onCreateCommit` 的分工一致。
   *
   * **为什么载荷里带 `repository` 而不是在这一层现造**:镜像 `OversizedFiles.onSubmit`
   * 要把它原样交给 `dispatcher.commitIncludedChanges(repository, context)`;本视图
   * 已经有两处 `new Repository(...)`(`CommitAuthorAvatar` 与 `CommitBox`),再在这里
   * 造第三份就是**第二个真源**(`branch`/`alias` 一漂,弹窗与提交流就会读不同的仓库)。
   */
  const [oversizedWarning, setOversizedWarning] = useState<{
    readonly oversizedFiles: ReadonlyArray<string>;
    readonly context: ICommitContext;
    readonly repository: Repository;
  } | null>(null);
  const onOversizedFiles = useCallback((payload: {
    readonly oversizedFiles: ReadonlyArray<string>;
    readonly context: ICommitContext;
    readonly repository: Repository;
  }): void => { setOversizedWarning(payload); }, []);
  const onDismissOversized = useCallback((): void => { setOversizedWarning(null); }, []);
  /**
   * 「Commit Anyway」那一跳的宿主门面 —— 与 `ContinueRebaseDispatcher` 同一形状
   * (替身给类型面,这里给行为),业务仍然全部由**镜像那份** `OversizedFiles` 执行。
   */
  const oversizedDispatcher = useMemo(
    () => new OversizedFilesDispatcher(() => store.commit()),
    [store],
  );
  /**
   * 「把镜像里那个**不冒泡**的 `submit` / `reset` 重新以冒泡形态派发一遍」的转发垫片。
   * 完整事实与退役条件写在下面那个 `div` 的注释里(一句话:镜像 `ok-cancel-button-group.tsx`
   * 用 `new Event('submit')` 手动派发,`bubbles` 默认 false,而 React 把 `submit` 委托在
   * **根容器**上 ⇒ 镜像 `Dialog.onSubmit` 永远收不到 ⇒ 「Commit Anyway」点下去没反应)。
   *
   * 捕获阶段监听能收到不冒泡的事件(DOM 规范的捕获阶段照样经过全部祖先),
   * 所以这里只需要在**自己的包装元素**上挂一次,不需要动镜像一个字节。
   * 只在弹窗在场时挂;卸载时摘掉(没有依赖数组 ⇒ 每次渲染重建一次,节点身份不变、无副作用)。
   */
  const dialogFormSubmitShimRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const holder = dialogFormSubmitShimRef.current;
    if (holder === null) { return; }
    const form = holder.querySelector('form');
    if (form === null) { return; }
    const forward = (event: Event): void => {
      // 已经是冒泡的那一份不再转发(否则自激:克隆体也会走这里)。
      if (event.bubbles) { return; }
      const clone = new Event(event.type, { bubbles: true, cancelable: true });
      if (event.target !== null) { (event.target as Element).dispatchEvent(clone); }
    };
    form.addEventListener('submit', forward, true);
    form.addEventListener('reset', forward, true);
    return () => {
      form.removeEventListener('submit', forward, true);
      form.removeEventListener('reset', forward, true);
    };
  });

  /**
   * 行内容依赖的那张表(上游 `filter-changes-list.tsx:1367-1377` 的同名 prop)。
   * 逐键理由写在 `<ChangesFileList invalidationProps={…}>` 那一处;
   * `useMemo` 的依赖就是那些值的**身份**,所以「一次无关的 store emit」不会换掉这个对象
   * ⇒ 列表的失效闸门(浅比较)为真 ⇒ 网格**不重渲** ⇒ 行不重建。
   */
  const invalidationProps = useMemo(() => ({
    status,
    includeState: snap.includeState,
    selectedPaths: snap.selectedFiles,
    matches: filtered.matchesOf,
    pathWidth,
    isCommitting: snap.busy === 'commit',
    focusedRow: flat[0]?.file.path ?? null,
  }), [status, snap.includeState, snap.selectedFiles, filtered, pathWidth, snap.busy, flat]);

  const toggle = (file: ChangedFile, event: React.MouseEvent): void => {
    store.toggleFile(file.path, event.metaKey || event.ctrlKey || event.shiftKey);
  };

  /**
   * 列表体的四个回调 —— 分工**照上游**(`FilterChangesList` + `ui/changes/sidebar.tsx`):
   *
   * · **鼠标点选** ⇒ 由镜像 `SectionList` 自己算选择(`section-list.tsx:1589-1610` 的
   *   `shift` = 「从锚点到这一行」的**范围**选择、`meta/ctrl` = 逐个追加),
   *   结果进 `onSelectionChanged` ⇒ `store.selectFiles(...)`(**右栏多选**的输入);
   *   上游同一分工:`filter-changes-list.tsx:1188-1193` 的 `onFileSelectionChanged`。
   * · **键盘(空格/回车)** ⇒ 切换「纳入提交」,`sidebar.tsx:336-349` 的
   *   `onChangedItemClick` **只**处理 `source.kind === 'keyboard'`。勾选 ≠ 暂存(零 git)。
   * · **双击** ⇒ 外部编辑器(`filter-changes-list.tsx:1132-1134`)。我们此前**没有**这条。
   * · **右键** ⇒ 我们那份 11 项菜单(`changes-file-menu.ts`;探针 49×3 守的就是它)。
   */
  const onListSelectionChanged = useCallback((paths: ReadonlyArray<string>): void => {
    store.selectFiles([...paths]);
  }, [store]);
  const toggleIncludeOf = useCallback((path: string): void => {
    const file = files.find((f) => f.path === path);
    if (file === undefined) { return; }
    // 上游 `onToggleInclude`(`sidebar.tsx:314-330`):`None` ⇒ 纳入,其它 ⇒ 取消。
    store.setFileIncluded(path, stateOf(file) === 'none');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, files, snap.includeState]);
  const onListItemClick = useCallback((path: string, source: SelectionSource): void => {
    if (source.kind === 'keyboard') { toggleIncludeOf(path); }
  }, [toggleIncludeOf]);
  const onListItemDoubleClick = useCallback((path: string): void => {
    void store.openInExternalEditor(path);
  }, [store]);
  const onListItemContextMenu = useCallback((path: string, event: React.MouseEvent<HTMLDivElement>): void => {
    const file = files.find((f) => f.path === path);
    if (file === undefined) { return; }
    rowMenu(event, file);
  }, [files, rowMenu]);
  /**
   * 回填给镜像列表的**位置**(上游 `changesListScrollTop` ⇒
   * `AugmentedSectionFilterList` 的 `setScrollTop`,`filter-changes-list.tsx:1354`)。
   * 我们的 `ChangesView` 在页签切换时会被卸载,组件内的 `useState` 留不住 ⇒
   * **初值**从模块作用域取(`changes-file-list.tsx` 的 `getRememberedScrollTop`)。
   *
   * ⚠️ **它必须是「跟着走」的,不能只当初值用**(2026-10-08,用户报「左边虚拟列表无法滚动」)。
   * 这个值原样喂给 `react-virtualized` 的 `Grid` 的 `scrollTop` prop,而 `Grid` 把**数值**
   * 的 `scrollTop` 当**权威**:`Grid.js` 的 `getDerivedStateFromProps` 会把它抄进 state
   * (`:1040-1046`),`componentDidUpdate` 在 `scrollPositionChangeReason === REQUESTED` 时
   * 把它写回 DOM(`:538-539`)。于是**只要这个 prop 冻在挂载那一刻的值**,
   * 每一次滚动(Grid 自己的 `_onScroll` 触发的重渲也算)都会被回弹到那个旧值 ——
   * 表现就是「列表滚不动」。上游正是靠**同一个值跟着 `onScroll` 走**才没有这个问题:
   * `ui/repository.tsx:199-201` 的 `onChangesListScrolled = (scrollTop) => this.setState({changesListScrollTop: scrollTop})`。
   * 下面 {@link onChangesListScrolled} 里那句 `setChangesListScrollTop(top)` 就是它在我们的层里的等价物。
   * 读数(改前红 / 改后绿,真 Chrome、500 文件、宿主祖先链复刻):
   * `docs/probes/changes-list-scroll-probe.mjs` 的 `S1c`/`S1d` 与红证 `R1`。
   */
  const [changesListScrollTop, setChangesListScrollTop] = useState(() => getRememberedScrollTop());
  /**
   * 滚动位置:模块作用域记着(上游存在 `IRepositoryState`,`repository.tsx:199-201`),
   * **同时**回写上面那个 state —— 两者各司其职:
   *  · 模块作用域负责**跨挂载**记住(切页签再切回来时给出初值);
   *  · state 负责让喂给 `Grid` 的 `scrollTop` prop **与真实位置一致**(否则会回弹,见上)。
   */
  const onChangesListScrolled = useCallback((top: number): void => {
    setRememberedScrollTop(top);
    setChangesListScrollTop(top);
  }, []);
  /**
   * **平铺路径**上的键盘导航(虚拟路径由镜像 `SectionList` 自己管,见列表体的注释)。
   * 这里保留我们那份 `onListKeyDown`(↑/↓/Home/End/空格/回车),探针读的就是它。
   */
  const onPlainKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>): void => {
    onListKeyDown(event, flat, store, selected);
  }, [flat, store, selected]);

  const openRowInExternalEditor = useCallback((path: string): void => {
    void store.openInExternalEditor(path);
  }, [store]);
  /** 平铺路径上「单击整行」的稳定回调(虚拟路径不传,见 `FileRow.onSelect` 的注释)。 */
  const onRowSelect = useCallback((event: React.MouseEvent, file: ChangedFile): void => {
    toggle(file, event);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store]);

  /**
   * 一行(两条渲染路径**共用**)。`virtual` 只影响两件事:
   *  · 虚拟路径上外层 `ListRow` **已经**是 `role="option"`(`section-list.tsx:1245`)
   *    ⇒ 我们的行不再重复声明 `role="option"`(嵌套 option 对读屏是错的);
   *  · 虚拟路径上行不需要 `tabIndex`(焦点由镜像列表管)。
   */
  const renderRow = useCallback((row: IChangesRowItem, matches: IMatches | undefined, virtual: boolean) => (
    <FileRow key={row.id} file={row.file} include={stateOf(row.file)} selected={selected.has(row.file.path)}
      focused={!virtual && flat[0]?.file.path === row.file.path}
      virtual={virtual} matches={matches} pathWidth={pathWidth}
      store={store} onSelect={virtual ? undefined : onRowSelect}
      onDiscard={discardRow}
      onStage={stageRow}
      onUnstage={unstageRow}
      onContextMenu={rowMenu}
      onOpenInExternalEditor={openRowInExternalEditor}
    />
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [store, selected, flat, pathWidth, discardRow, stageRow, unstageRow, rowMenu, openRowInExternalEditor, snap.includeState]);

  /** 0 行时的空态(**两条路径共用**;上游 `renderNoItems`)。 */
  const renderNoItems = useCallback((): JSX.Element => (
    <>
      {files.length === 0 && (
        <Empty icon="check-circle" title="没有本地变更" body="工作区是干净的。" />
      )}
      {files.length > 0 && (
        <Empty icon="filter" title="没有匹配的文件"
          body={getNoResultsMessage(filterState) ?? '没有文件符合当前的筛选条件。清掉筛选就能看到全部变更。'} />
      )}
    </>
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [files.length, filterText, activeOptions]);

  if (status === null) {
    return <Empty icon="git-branch" title="读取仓库状态…" />;
  }

  return (
    /*
     * ⚠️ `gw-desktop-changes` 不是装饰,是**移植面作用域根**,而且它是本视图目前**唯一**
     * 能拿到 Changes 面样式的方式。为什么必须在这里补,以及它的退役条件,都写在下面。
     *
     * ## 事实(真 Chrome A/B 实测,2026-10)
     *
     * `scripts/styles.mjs` 的 `PORT_SURFACES` 里,Changes 面的作用域根是 `.gw-desktop-changes`
     * (`scripts/styles.mjs:278-292`,`requires` 里从 `.changes-list-container` 到
     * `.hidden-changes-warning` 一共 12 条)。而**全仓没有任何 className 发出这个类** ——
     * `src/client/styles.ts:619-627` 早就为 `.checkbox-component` 记过同一件事。
     * 后果:该面编译出来的每一条规则都**永不匹配**。
     *
     * 对照实验(同一份告警条 DOM、同一份产物 CSS、同一份宿主主题,真 headless Chrome,
     * 浅色):挂在 `.gw-desktop-changes` 下 vs 挂在本视图的真实祖先链
     * (`.gw-pane > .gw-split > .left > .resizable-component`)下 ——
     *
     * | 量 | `.gw-desktop-changes` 下 | 我们的真实链下 |
     * |---|---|---|
     * | `background-color` | `rgb(254, 245, 231)`(amber-100) | `rgba(0, 0, 0, 0)` |
     * | `padding` | `5px 10px` | `0px` |
     * | `border-top` | `1px solid rgb(247, 173, 49)` | `0px none` |
     * | 图标 `fill` | `rgb(221, 134, 41)`(=告警色) | `rgb(0, 0, 0)`(黑) |
     * | 链接 | `--dsw-alias-link` / 无下划线 | UA `rgb(0, 0, 238)` + 下划线 |
     * | `.sr-only` | 隐藏 | 隐藏(这一条靠 `.gw-split .sr-only` 兜住) |
     *
     * 也就是说:告警条**会出现**(正确性缺口已修),但它会长成**一行没有底色的裸文本 + 一条
     * 蓝色下划线链接**。那比不显示更糟 —— 用户会以为那是个无关的链接。
     *
     * ## 为什么是加在**视图根**上,而不是给告警条包一层
     *
     * 1. 结构上这就是 Changes 页签的根,与上游 `ui/changes/**` 服务的表面**同一个**;
     *    包一层会多出一个上游没有的 DOM 节点,而 `.hidden-changes-warning` 的
     *    `margin-bottom:-1px` + `z-index:1` 正是为了压住提交框的上边框(上游
     *    `_changes-list.scss:257-276`),多一层就多一个 margin 折叠变量。
     * 2. **碰撞审计已做**:产物里 `.gw-desktop-changes` 开头的 184 条选择器,逐条与本视图
     *    实际发出的类名对照,命中的只有本该命中的那些(`.hidden-changes-warning`、
     *    `.octicon`、`.link-button-component`、`.sr-only`)。
     *    看着像风险的 `.file` / `.row` **在该面底下 0 条**;`.header`(17 条)/
     *    `.summary`(10 条)/ `.description`(2 条)/ `.content`(2 条)全部嵌在
     *    `.changes-list-container` / `.commit-message-component` / `.changes-interstitial`
     *    之下,本视图没有这些祖先。
     * 3. 各移植面 import 的是**同一批上游 partial**,同名跨面规则**声明逐字相同**
     *    (`.gw-desktop-diff svg.octicon` 与 `.gw-desktop-changes svg.octicon` 都是
     *    `fill:currentColor;flex-shrink:0`),而作用域元素上的变量更近的一层赢 ⇒
     *    把本类加在这里**不会改变 diff 面板现有的任何一条声明**。
     *
     * ## §10.9 的记账(这不是「假祖先」)
     *
     * 一个类名只有在上游**确实**会渲染它时才算真祖先。`.gw-desktop-changes` 的上游渲染方是
     * `ui/changes/changes.tsx`(`scripts/styles.mjs` 的 `bootstrap` 字段写的就是它)——
     * 也就是说,今天它确实是**临时对齐**:我们用它把「Changes 面」的样式接到「Changes 页签」上,
     * 而不是接到了上游那棵具体的子树。
     *
     * **退役条件(接线那一刻必须做)**:上游容器接线后,`.gw-desktop-changes` 由
     * `ui/changes/changes.tsx` 自己渲染 ⇒ **删掉本行的这个类**,否则同一个作用域根会同时挂在
     * 两棵不同的树上(上游那棵 + 我们这棵手写壳),样式归属不再唯一。
     * 判据:`check-unreachable-ancestors` 里 `.gw-desktop-changes` 这一条**必须重新出现**
     * (它现在因为本类而消失,见交付报告 (c) 的 before/after),因为那时手写壳已经不是那个表面了。
     *
     * **已知副作用(必须记账)**:本类一进 DOM,`check-unreachable-ancestors` 就不再报
     * `.gw-desktop-changes` 这个祖先(它压着约 184~200 条选择器)。那 184 条里**绝大多数**
     * 仍然打不到任何节点(它们的后代类属于上游容器的 DOM),而这一点该检查器**另有条目**
     * 逐条报出来(`commit-message-component` 68 条、`changes-list-container` 30 条、
     * `filtered-changes-list` 25 条 …)—— 也就是说进度条**没有瞎**,只是从「作用域根缺了」
     * 前进到「容器内部缺了」。这个前进是真实的,不是把红抹绿。
     */
    <div className="gw-pane gw-desktop-changes">
      {/* 左右两栏,照 Desktop 的仓库视图:左 = 列表 + 底部提交区;右 = diff / 空态。
          宽度由 `useSplitWidth()` 驱动:横排时把左栏轨道的像素宽写成行内
          `grid-template-columns`,竖排(<420px)时不写、交给 `styles.ts` 的容器查询。 */}
      <div className="gw-split" ref={split.attachContainerRef} style={split.containerStyle}>
        <div className="left">
          {/* 左栏整体包进移植过来的 `<Resizable>`(Desktop `repository.tsx:410-421`)。 */}
          <SplitPane split={split} id="dsh-git-changes-split" description="Changes 变更列表">
          {/*
            表头,照 Desktop 的变更列表(`ui/changes/filter-changes-list.tsx:1235-1311`):
            第一行是**组合控件**[筛选按钮][输入框];第二行是**纳入三态复选框** + 计数文案。
            计数文案的语义照 Desktop(`:1263-1266`):筛选后可见数 ≠ 总数时显示「V of N」。

            两层右键菜单都挂在这一面(上游同一分工):
             · `.gw-chead`(这里)⇒ 上游 `renderFilterRow` 的 `.header.filter-field-row`
               (`filter-changes-list.tsx:1234-1243`)的 `onContextMenu`,两项:丢弃全部 / 贮藏全部;
             · 每一行(`FileRow`)⇒ 上游 `onItemContextMenu`(`:839-857`),11 项。
            `data-gw-ctx` 是**探针标记**(ASCII 唯一字面量):
            `docs/probes/changes-file-menu-probe.mjs` 拿它做「接线在场」的**同帧阳性对照**
            (缺席读数必须与它一起取),同时它是产物里「这段代码真的进了包」的可 grep 证据
            —— 中文标签在 esbuild 的 `charset: 'ascii'` 下会被转义成 `\\uXXXX`,裸串 grep 会得到假阴性。
          */}
          <div className="gw-chead" onContextMenu={headerMenu} data-gw-ctx="list">
            <div className="gw-filter-box">
              {/*
                筛选按钮。上游 `changes-list-filter-options.tsx:239-265`:
                `.filter-button`(带 `active` 类)+ 图标 + **生效数小圆点**(`active-badge`)
                + `triangleDown` 图标;tooltip/aria-label 是
                `Filter Options (N applied)`。

                ⚠️ **2026-10-10 修的那一条**(审计 §3.3 #26):改前生效数**只**写在 `title`
                里(要 hover 才看得见),按钮上没有那颗小圆点。现在照上游渲染
                `span.active-badge > div.badge-bg > div.badge`(`:242-249`)——
                类名逐字,配方补在 `styles.ts` 的 `.gw-filter-btn .active-badge` 一族
                (上游那条配方挂在 `.filter-button` 下,我们的按钮类名是 `gw-filter-btn`,
                所以**必须**补一份;不补就是「DOM 在、5px 的圆点一个都看不见」)。
                读数:`docs/probes/changes-filter-popover-probe.mjs` 的 `B1`–`B4`。
              */}
              <button className={`gw-filter-btn${activeOptions.length > 0 ? ' active' : ''}`}
                ref={filterButtonRef}
                title={activeOptions.length > 0 ? `筛选选项(${activeOptions.length} 项生效)` : '筛选选项'}
                aria-label={activeOptions.length > 0 ? `筛选选项(${activeOptions.length} 项生效)` : '筛选选项'}
                aria-expanded={filterOpen} onClick={() => setFilterOpen((v) => !v)}>
                <Icon name="filter" size={12} />
                {activeOptions.length > 0 && (
                  <span className="active-badge">
                    <div className="badge-bg">
                      <div className="badge" />
                    </div>
                  </span>
                )}
                <Icon name="chevron-down" size={10} />
              </button>
              <input className="gw-filter-input" placeholder="Filter"
                value={filterText} onChange={(event) => setFilterText(event.target.value)} />
              {filterOpen && (
                <FilterOptionsPopover
                  counts={optionCounts}
                  active={activeOptions}
                  labels={FILTER_LABELS}
                  showClear={hasActiveFilters(filterState)}
                  anchor={filterButtonRef.current}
                  onToggle={(key) => {
                    const next = new Set(activeOptions);
                    if (next.has(key)) next.delete(key); else next.add(key);
                    setActiveOptions([...next]);
                    setFilterOpen(false); // Desktop:每次点选项都关掉弹层
                  }}
                  onClear={() => { setActiveOptions([]); setFilterText(''); }}
                  onClose={() => setFilterOpen(false)} />
              )}
            </div>

            <div className="gw-checkall">
              <label className="gw-chk">
                <input type="checkbox" ref={checkAllRef}
                  checked={allShownIncluded}
                  disabled={shown.length === 0}
                  title="把这些文件纳入 / 排除本次提交(不写索引)"
                  onChange={(event) => {
                    // 三态:indeterminate 时原生 checkbox 的 checked 会是 true,
                    // 所以「从混合态点击」= 全选(与 Desktop 的 2 种点击结果一致)
                    store.setFilesIncluded(shown.map((f) => f.path), event.target.checked);
                  }} />
                <span>
                  {visible.total !== files.length ? `${visible.total} / ${files.length} 个变更文件` : `${files.length} 个变更文件`}
                  {` · 纳入 ${includedCount}`}
                </span>
              </label>
              {/* 兜底:仍有文件没落进列表时显式暴露,不要静默丢文件 */}
              {files.some((f) => !listed.has(f.path)) && (
                <span className="gw-chead-warn"
                  title={files.filter((f) => !listed.has(f.path)).map((f) => f.path).join('\n')}>
                  {files.filter((f) => !listed.has(f.path)).length} 个未分类
                </span>
              )}
              {status.conflictedCount > 0 && (
                <span className="gw-chead-warn"
                  title={files.filter((f) => f.conflicted === true)
                    .map((f) => `${f.path} — ${f.conflict === undefined ? '冲突' : conflictSummaryText(f.conflict.action)}`)
                    .join('\n')}>
                  {status.conflictedCount} 个冲突
                </span>
              )}
              {/*
                ⚠️ 2026-10:**这里原先有「全部暂存 / 取消暂存」两颗按钮,已按用户指令移除**
                (用户原话:「Changes 页面里左边列表怎么多了【全部暂存】【取消暂存】这两个按钮?
                原来的 `references/desktop` 是没有这两个按钮的」)。

                上游确实没有:审计 `docs/goal-port-desktop.md` §11.4 的机器证据是
                ```
                grep -rn "Staged\|staged\|Stage \|Unstage" \
                  references/desktop/app/src/ui/changes references/desktop/app/src/ui/diff --include='*.tsx'
                → 0 命中
                ```
                上游 Changes 列表行只有 **纳入勾选框 + 路径 + 状态 octicon**
                (`ui/changes/changed-file.tsx:80-118`),列表头只有「N changed files」+ 三态全选框,
                **没有任何 stage/unstage 动作** —— 索引只在 `createCommit` 那一刻被 materialize。

                ⇒ 那两颗按钮是审计第 4 项接线时**我们发明的入口**,不是抄漏;
                **移除的是按钮**,`store.stageSelected` / `store.unstageSelected` 一个字没删
                (「先做,不删」)。行尾的单文件「暂存 / 取消暂存」图标**保留**
                (用户只点名了顶部这两颗)。
              */}
            </div>
          </div>

          {/*
            列表体 = **镜像的虚拟列表**(见 `changes-file-list.tsx` 的文件头)。
            `.gw-files` 这个容器类名与每行的 `.gw-frow[data-path]` **刻意保留**:
            既有探针(`changes-file-menu-probe` / `stash-probe` / `changes-discard-lines-probe` /
            `changes-path-bidi-probe`)与 `styles.ts` 的手写配方都认它们;虚拟路径上行仍然由
            `renderRow` 画(同一份数据、同一个行组件),只是外面多了一层镜像 `ListRow`。

            键盘导航分工:虚拟路径由镜像 `SectionList` 管(`section-list.tsx:584-651`,
            含 `shift` 的**范围**选择),平铺路径(测不到高度时)仍由我们那份 `onListKeyDown` 管
            —— 两条路径**不会同时**接管(`onPlainKeyDown` 只在非虚拟时挂上)。
          */}
          <ChangesFileList
            rows={filtered.rows}
            matchesOf={filtered.matchesOf}
            renderRow={renderRow}
            selectedPaths={snap.selectedFiles}
            onSelectionChanged={onListSelectionChanged}
            onItemClick={onListItemClick}
            onItemDoubleClick={onListItemDoubleClick}
            onItemContextMenu={onListItemContextMenu}
            onScroll={onChangesListScrolled}
            scrollTop={changesListScrollTop}
            renderNoItems={renderNoItems}
            postNoResultsMessage={getNoResultsMessage(filterState)}
            ariaLabel="变更文件"
            isCommitting={snap.busy === 'commit'}
            onPlainKeyDown={onPlainKeyDown}
            /*
             * **`invalidationProps`** —— 上游同名的那个 prop
             * (`filter-changes-list.tsx:1367-1377` 那张表),语义逐条对齐:
             * 列表对它做**浅比较**,只有变了才把虚拟网格 `forceUpdate()` 一遍
             * (机制与「为什么需要它」写在 `changes-file-list.tsx` 的 `cellRenderer` 注释里)。
             *
             * 我们这张表 = **行内容真的会读的每一样**,逐键给出理由(照上游那张表的粒度):
             *   · `status`        —— 路径 / 状态字母 / 冲突标记(行左半边与图标);
             *   · `includeState`  —— 三态勾选框(上游那头的 `workingDirectory`,因为上游把
             *                        selection 挂在 `WorkingDirectoryFileChange` 上);
             *   · `selectedPaths` —— 选中高亮(`.gw-frow` 的 selected 类);
             *   · `matchesOf`     —— `<mark>` 高亮位置(上游 `renderItem(item, matches)`);
             *   · `pathWidth`     —— `PathText` 的可用宽度(上游 `changed-file.tsx:57-67` 同一件事);
             *   · `isCommitting`  —— 提交中行内动作不可点(`filter-changes-list.tsx:1136-1150` 同源);
             *   · `focusedRow`    —— **平铺路径**上那一行的 focus 标记(虚拟路径由 Grid 自己管)。
             *
             * ⚠️ 每个值时必须是**原语或身份稳定**的对象,否则浅比较恒为假、闸门等于没接:
             * `snap.includeState` / `snap.selectedFiles` / `filtered` 都是 store 或 `useMemo`
             * 的产物(只在真变时才换身份),`pathWidth` 是数,`status` 是原对象。
             * `useMemo` 在这里不是为了省几次比较,而是为了让**本来就不该变的帧**不换身份。
             */
            invalidationProps={invalidationProps}
          />

          {/*
            **左下角的「Stashed Changes」按钮** —— 上游 `renderStashedChanges()`
            (`ui/changes/filter-changes-list.tsx:1105-1130`),位置也在同一处:
            `{this.renderStashedChanges()} {this.renderHiddenChangesWarning()} {this.renderCommitMessageForm()}`
            (`:1387-1389`)。空态的 stash 卡那句提示行
            (「When a stash exists, access it at the bottom of the Changes tab to the left.」,
            `ui/changes/no-changes.tsx:422-427`)**指的就是这一颗按钮** ——
            少了它,那张卡的提示行就是一句指不到东西的话。
          */}
          <StashedChangesButton
            stashEntry={snap.stashEntry}
            showing={showStashedChanges}
            onToggle={onToggleStashView}
          />
          <HiddenChangesWarning
            fileIdsIncludedInCommit={includedPaths}
            filteredItems={visibleItems}
            fileCount={files.length}
            filters={filterState}
            onAdjustFilters={showFilesToBeCommitted}
          />
          {/*
            告警条的**机器可查读数**(探针用;`hidden` 不占布局,与 DiffPane 里那个
            `data-gw-include-probe`(`:690-700`)同一套做法)。

            为什么要它:这个告警条是这个项目最怕的那类缺陷的现场 ——
            「只由谓词决定出现与否」的 UI,一旦谓词成了常量,界面**不会报错**,
            只会**永远不出现**(或永远出现)。把四条输入与判定结果一起暴露出来,
            一条 DevTools 表达式就能同时读到「输入 / 判定 / DOM 是否真的在」:
            三者必须一致。判定用的是**上游那个纯函数本人**,与告警条内部同一份代码
            (`src/client/hidden-changes-warning.tsx:229`),不存在第二份真源。
          */}
          <div hidden data-gw-hidden-changes-probe={JSON.stringify({
            fileCount: files.length,
            visibleCount: visibleItems.size,
            includedCount: includedPaths.length,
            includedPaths,
            visiblePaths: [...visibleItems.keys()],
            filters: filterState,
            hidden: isCommittingFileHiddenByFilter(includedPaths, visibleItems, files.length, filterState),
          })} />

          {/* 提交区固定在左栏底部(Desktop 的 ChangesSidebar 也是这样) */}
          <CommitBox store={store} snap={snap} onOpenPreferences={props.onOpenPreferences}
            onOpenRepositorySettings={props.onOpenRepositorySettings}
            showPromptForCommittingFileHiddenByFilter={showPromptForCommittingFileHiddenByFilter}
            onFilesToCommitNotVisible={onFilesToCommitNotVisible}
            onOversizedFiles={onOversizedFiles} />
          </SplitPane>
        </div>

        <div className="right">
          {/*
            **右栏四态**,次序照上游 `ui/repository.tsx:555-597` 的
            `renderContentForChanges`:
              ① 选中 stash ⇒ `StashDiffViewer`;
              ② **选中的文件 > 1 ⇒ `MultipleSelection`**(`:563-567`,26 行镜像件);
              ③ 0 文件 ⇒ `NoChanges`(`:569-584`);
              ④ 否则 diff 面板。
            ②这一态是审计 §3.2 #45 记的那条**内容错**类缺陷:「选 3 个文件时右栏显示第 1 个
            文件的 diff,用户以为只选了 1 个」—— 现在与上游同一条判据。
            `stashEntry.files.kind === Loaded` 是硬条件(上游 `StashDiffViewer` 的
            `getFiles()` 只在 `Loaded` 时返回文件,`:88-92`)—— 还在装载时**不**画一个空面板。
          */}
          {showStashedChanges
            && snap.stashEntry !== null
            && snap.stashEntry.files.kind === StashedChangesLoadStates.Loaded
            ? (
              <StashDiffViewer
                store={store}
                stashEntry={snap.stashEntry}
                onDiscardClick={onDiscardStashClick}
              />
            )
            : snap.selectedFiles.length > 1
              ? <MultipleSelection count={snap.selectedFiles.length} />
              : files.length === 0
                ? <NoChanges store={store} snap={snap} onViewStash={onViewStash} />
                : (
                  /*
                   * **`.diff-container` 那一层(2026-10-08 接线)**
                   *
                   * 上游 `ui/changes/changes.tsx:105-117` 的右栏就是这个形状:
                   * `.diff-container` 里第一件事是 `<DiffHeader>`,后面才是 diff 正文。
                   * 镜像 `DiffHeader` 的根是 `.header`,而它的**全部**样式都写在
                   * `ui/_diff.scss:899-945` 的 `.diff-container .header{…}` 里
                   * (状态 Octicon 的 7 条 `@include octicon-status` 也在那里面)
                   * ⇒ 没有这层祖先,头部就是一根裸 `<div>`。
                   *
                   * ⚠️ `gw-desktop-diff` 这个类在这里**不是**装饰:`.diff-container`
                   * 那组规则所在的作用域根就是它(`scripts/styles.mjs` 的 `PORT_SURFACES`
                   * 里 diff 面的 `scope`),而我们原来把这个类的根放在**更里面**
                   * (`desktop-diff.tsx` 的 `DesktopDiff` 根)。这一层只是把作用域
                   * 提到头部也能落在里面的高度 —— DOM 里因此有**两个** `.gw-desktop-diff`
                   * (外层是本层,内层仍是 `DesktopDiff` 自己的根),样式规则两边都命中、
                   * 取值相同,不冲突。
                   *
                   * 为什么不把头部塞进 `DesktopDiff`:那会让「失败/读取中/没有差异」
                   * 三条早退分支(它们**不**渲染 `DesktopDiff`)丢掉头部。
                   */
                  <div className="gw-desktop-diff gw-diff-pane">
                    <div className="diff-container" ref={diffContainerRef}>
                      <DiffPane
                        store={store}
                        snap={snap}
                        /*
                         * 行/块级丢弃的**确认闸门在页这一层**(上游 `ui/changes/changes.tsx:75-97`):
                         * `DiffPane` 只把「用户右键点了拿几行」交上来,弹不弹框、弹什么框由
                         * 这里决定 —— 与整文件丢弃(`confirmDiscard`)同一条分工。
                         */
                        onDiscardLines={onDiscardLinesSelected}
                        /*
                         * `+n/-n` 要**回到 header 那一行**里(用户 2026-10-09 的裁决),
                         * 而镜像 `DiffHeader` 的根是它自己产出的、**没有插槽** ⇒ 布局只能在
                         * 我们的包装层做。`DiffPane` 因此要拿到 `.diff-container` 这个元素:
                         * 它量 header 的高度(统计行与 header 等高 + 负上边距 ⇒ 同一行)
                         * 与统计行的宽度(给 header 留出 `--gw-diff-stat-reserve` 的右内边距)。
                         * 详情见 `DiffPane` 里那两处注释;`.diff-container` 本身是我们渲染的
                         * (`ui/changes/changes.tsx:104`),不是镜像件。
                         */
                        containerRef={diffContainerRef}
                      />
                    </div>
                  </div>
                )}
        </div>
      </div>

      {confirmDiscard !== null && (
        <ConfirmDialog
          title={confirmDiscard.some((f) => f.untracked === true) ? '删除未跟踪文件?' : '丢弃这些改动?'}
          body={
            /*
             * 「全部」那一档说清是全部:表头右键的 `Discard All Changes…`
             * (上游 `filter-changes-list.tsx:556-561`)与行尾垃圾桶共用这一个确认框状态,
             * 而上游那个弹窗有一个 `discardingAllChanges` 变体
             * (`ui/discard-changes/confirm-discard-changes-dialog.tsx`)。
             * 我们按「确认集合是否覆盖了整个变更集」分流 —— 这在两条入口上都是**真话**
             * (行尾垃圾桶只带一个文件,所以只有回落到逐条列举那一边)。
             */
            confirmDiscard.length === files.length && files.length > 1
              ? `这会丢弃全部 ${files.length} 个文件的改动。\n\n丢弃后无法从 dsh-git 恢复(已提交的内容不受影响)。`
              : `${confirmDiscard.map((f) => f.path).join('\n')}\n\n丢弃后无法从 dsh-git 恢复(已提交的内容不受影响)。`
          }
          confirmText="丢弃"
          danger
          onDone={(okay) => {
            const target = confirmDiscard;
            setConfirmDiscard(null);
            if (!okay) { return; }
            void store.discardFiles(
              target.map((f) => f.path),
              target.filter((f) => f.untracked === true).map((f) => f.path),
            );
          }}
        />
      )}

      {/*
        **「你确定要提交被筛选隐藏的改动吗」确认框** —— 镜像
        `ui/changes/confirm-commit-filtered-changes-dialog.tsx`(95 行,字节一致)
        **由流程所有者(本组件)渲染**:本插件没有应用层弹窗宿主
        (上游由 `ui/app.tsx:2809` 的 `PopupType.ConfirmCommitFilteredChanges` 分支渲染),
        所以按裁决 B 用与 `CloneDialog` / `SquashDialog` 同一条路 —— 零新机制。
        触发链与判据见上面 `showPromptForCommittingFileHiddenByFilter` 的注释。

        ⚠️ `DialogStackContext.Provider` **不是可选装饰**:镜像 `Dialog` 只在
        `context.isTopMost === true` 时才 `showModal()`(它的默认值是 `false`,
        见上面 import 处的注释)⇒ 没有这个单元素栈,原生 `<dialog>` 永远不开。
        上游那个栈由 app 的 popup 层维护;这里弹窗同时最多一个,所以给一个**身份稳定**的
        常量对象(与 `NOOP` 同一处置:别每帧新建对象)。
      */}
      {commitFilteredAnyway !== null && (
        /*
         * ⚠️ **这个 `div` 不是装饰**:它挂 `dialogFormSubmitShimRef` —— 一个「把镜像里
         * 那个**不冒泡**的 `submit` / `reset` 重新以冒泡形态派发一遍」的**转发小垫片**。
         *
         * 事实(逐条可查):
         *  · 镜像 `ui/dialog/ok-cancel-button-group.tsx:107-115`(与 `:135-142`)在
         *    `destructive === true` 时把「确定」按钮渲染成 `type="button"`,点它之后
         *    **手动** `form.dispatchEvent(new Event('submit'))` —— 而 `new Event(...)`
         *    的 `bubbles` **默认是 `false`**;
         *  · React 17/18 把 `submit` 归在**根容器上的委托监听**里,不冒泡的事件到不了根;
         *  · 于是镜像 `Dialog` 自己的 `onSubmit`(`ui/dialog/dialog.tsx:830-834`)
         *    **永远不会被调用** ⇒ 「Commit Anyway」点下去**什么都不发生**
         *    (实测:`docs/probes/changes-commit-flow-probe.mjs` 的 D2 —— 弹窗仍在、0 条提交请求)。
         *
         * 为什么用**捕获阶段**监听(本组件这一层,不动镜像一个字节):
         *  DOM 规范里**捕获阶段照样经过全部祖先**(只有冒泡阶段对 `bubbles:false` 的事件
         *  提前结束)⇒ 在祖先上 `addEventListener('submit', h, true)` 能收到那个事件,
         *  再把它**原样、冒泡地**重新派发一次 ⇒ 镜像自己那个 `onSubmit` 就跑了。
         *
         * **这里没有复制任何业务逻辑**:持久化偏好、`onCommitAnyway`、`onDismissed`
         * 仍然全部由镜像那份 `ConfirmCommitFilteredChanges` 自己执行(单一真源);
         * 垫片只补了「事件看不见」这一处集成缝。
         * **退役条件**:镜像那份改成 `new Event('submit', { bubbles: true })`
         * (或 `form.requestSubmit()`)之后,连同这个 `div` 与那段 effect 一起删。
         */
        <div ref={dialogFormSubmitShimRef}>
          <DialogStackContext.Provider value={DIALOG_STACK_SINGLE}>
            <ConfirmCommitFilteredChanges
              onCommitAnyway={commitFilteredAnyway}
              onDismissed={onDismissCommitFiltered}
              showFilesToBeCommitted={showFilesToBeCommitted}
              setConfirmCommitFilteredChanges={setConfirmCommitFilteredChanges}
            />
          </DialogStackContext.Provider>
        </div>
      )}

      {/*
        **「你要提交的文件里有没有 >100 MiB 的」告警** —— 镜像
        `ui/changes/oversized-files-warning.tsx`(90 行,字节一致)
        **由流程所有者(本组件)渲染**:上游由 `ui/app.tsx:2157` 的
        `PopupType.OversizedFiles` 分支渲染,本插件没有 popup 宿主 ⇒ 与上面那份
        `ConfirmCommitFilteredChanges` **完全同一条路**(同一个
        `DialogStackContext.Provider`、同一段 `dialogFormSubmitShimRef` 垫片、
        零新机制)。

        触发链在 `CommitBox`(上游是 `ui/changes/sidebar.tsx:159-183` 的
        `onCreateCommit` 第一件事),逐条写在那个 `createCommitGate` 的注释里。

        ⚠️ 那份**不冒泡的 `submit`** 的坑这里同样存在:镜像
        `ok-cancel-button-group.tsx:107-115` 在 `destructive === true` 时手动
        `new Event('submit')`,所以「Commit Anyway」必须靠上面那个捕获阶段垫片
        才走得通 —— 这也是为什么这个弹窗要放在**同一个** `dialogFormSubmitShimRef`
        包装元素里(两个弹窗互斥,同一时刻只有一个 `form`)。

        ⚠️ 这个弹窗**不在场**时不能有容器:下面那个 `&&` 是「载荷为 null ⇒ 整棵不渲染」,
        于是「弹窗关掉了」与「弹窗从没开过」在 DOM 上都读得出区别(探针的缺席判据依赖它)。
      */}
      {oversizedWarning !== null && (
        <div ref={dialogFormSubmitShimRef}>
          <DialogStackContext.Provider value={DIALOG_STACK_SINGLE}>
            <OversizedFiles
              oversizedFiles={oversizedWarning.oversizedFiles}
              context={oversizedWarning.context}
              repository={oversizedWarning.repository}
              dispatcher={oversizedDispatcher}
              onDismissed={onDismissOversized}
            />
          </DialogStackContext.Provider>
        </div>
      )}

      {/*
        行/块级丢弃的确认框(上游 `PopupType.ConfirmDiscardSelection`,
        `ui/changes/changes.tsx:84-89` + `ui/discard-changes/confirm-discard-changes-dialog.tsx`)。
        措辞与**整文件**那条刻意不同:那条说「扣弃这些改动」会让人以为文件没了,
        而这一条只丢选中的那几行,**文件本身留在变更列表里**。
      */}
      {confirmDiscardLines !== null && (
        <ConfirmDialog
          title={`丢弃 ${confirmDiscardLines.file} 里选中的改动?`}
          body={
            '只丢你选中的那几行,文件里的其它改动都留着;索引(已暂存的内容)一个字节都不动。\n\n' +
            '丢弃是反向应用补丁,无法从 dsh-git 恢复。'
          }
          confirmText="丢弃选中的行"
          danger={true}
          onDone={(okay) => {
            const target = confirmDiscardLines;
            setConfirmDiscardLines(null);
            if (!okay || target === null) { return; }
            void store.discardLines(target.file, target.spec);
          }}
        />
      )}

      {/*
        **覆盖贮藏**的确认框 —— 上游 `PopupType.ConfirmOverwriteStash`
        (`ui/stash-changes/overwrite-stashed-changes-dialog.tsx`)。
        触发条件逐字照上游 `AppStore._createStashForCurrentBranch`
        (`lib/stores/app-store.ts:4865-4871`):`showConfirmationDialog && hasExistingStash`。
        措辞照那条正文(「This will overwrite your existing stash with your current changes.」),
        destructive 按钮 = `Overwrite`。
      */}
      {confirmStashOverwrite && (
        <ConfirmDialog
          title="覆盖已有的贮藏?"
          body={
            '这个分支已经有一条贮藏。继续会用**当前**的改动建一条新的贮藏,'
            + '并丢掉那一条旧的(旧贮藏里的内容不会进新的这一条)。\n\n'
            + '已经提交的内容不受影响。'
          }
          confirmText="覆盖"
          danger={true}
          onDone={(okay) => {
            setConfirmStashOverwrite(false);
            if (!okay) { return; }
            void store.stashAllChanges();
          }}
        />
      )}

      {/*
        **丢弃贮藏**的确认框 —— 上游 `PopupType.ConfirmDiscardStash`
        (`ui/stashing/confirm-discard-stash.tsx`)。
        判据是 `askForConfirmationOnDiscardStash`(默认 `true`),见
        `onDiscardStashClick` 的注释。
      */}
      {confirmDiscardStash && (
        <ConfirmDialog
          title="丢弃这条贮藏?"
          body={'确定要丢弃这些贮藏的改动吗?\n\n丢弃后无法从 dsh-git 恢复(工作区与提交都不受影响)。'}
          confirmText="丢弃"
          danger={true}
          onDone={(okay) => {
            setConfirmDiscardStash(false);
            if (!okay) { return; }
            // 丢完就把面板切回工作区(否则会停在一个已经不存在的 stash 上)。
            void store.dropStash().then((dropped) => { if (dropped) { setShowStashedChanges(false); } });
          }}
        />
      )}
    </div>
  );
}
/**
 * 一行变更文件 —— 结构照 GitHub Desktop 的 `ui/changes/changed-file.tsx:78-121`:
 *
 *   `<div class="file">` = 复选框(20px) + 路径(占满剩余) + 状态图标(16px)
 *
 * 宽度算术也沿用(`changed-file.tsx:57-66`)。路径用 `createPathDisplayState` 把目录与
 * 文件名拆成两个 span(目录用次要色、文件名用正常色)—— 这是 Desktop 行好读的关键。
 *
 * **复选框的三态与右侧 diff 的勾选列是同一个数据源**(`include`),就是
 * Desktop 的 `WorkingDirectoryFileChange.selection`:
 *   `All` ⇒ 行上打勾 + diff 每行都勾;`None` ⇒ 都不勾;`Partial` ⇒ 行上横杠。
 * 点它**只改客户端纳入状态,不发任何 git 命令**;索引在提交时才写。
 *
 * 与 Desktop 的差异:丢弃入口保留为行尾垃圾桶(Desktop 只有右键菜单),带确认框。
 *
 * **勾选控件用上游的 `<Checkbox>`**(2026-10 修):以前这里是裸 `<input class="gw-cb">`,
 * 于是控件被我们手写的 `.gw-cb{width:20px;height:20px}`(styles.ts:560)直接撑成 20×20
 * —— 原生复选框被**放大**,而 Desktop 的 20px 是**外层槽位**(`.file .checkbox-component
 * {width:20px}`,`_file-list.scss:36-39`)的宽度,里面的 input 保持原生 13×13。
 * 真 Chrome 实测(真 WorkbenchApp + 真产物 CSS + 宿主主题):
 *   · 修前 `.gw-cb` = **20×20**(`input` 自身)、margin `3px 3px 3px 4px`(UA 默认,我们的
 *     `.gw-cb` 没有 `margin:0`);
 *   · 上游 `<Checkbox>` 在配方**(不)**在场时 = 外层 `div.checkbox-component` 20×22 **block**、
 *     `input` 13×13 + UA margin `3px 3px 3px 4px`(配方不在本面作用域内,见下);
 *   · 上游 `<Checkbox>` + `.checkbox-component` 配方在场 = `input` **13×13、margin 0**、
 *     在 29px 行里垂直居中(y=8)。
 * 配方为什么不在:`src/client/scss/desktop-changes.scss` 的闭包里**没有** `ui/_checkbox.scss`
 * 与 `_file-list.scss` 的 `.file` 段,而 `.gw-desktop-changes` 这个作用域根**目前没有任何
 * 渲染方**(产物里 `.checkbox-component` 只出现在 `.gw-desktop-diff` / `.gw-repo-list` /
 * `.gw-desktop-history` 三个作用域下)。所以本文件只负责**结构与上游一致**;
 * 缺的那两条槽位规则按所有权交给 `src/client/styles.ts` 那条线(见交付报告)。
 */
function FileRow(props: {
  file: ChangedFile;
  /** 这个文件的**纳入状态**(三态);与右侧 diff 的勾选列同源。 */
  include: IncludeState;
  selected: boolean;
  focused: boolean;
  store: GitStore;
  /**
   * 单击整行(**只**在平铺路径上挂):换「在看哪个 diff」那个游标。
   * 虚拟路径上**不挂** —— 那里由镜像 `SectionList` 自己算选择(含 `shift` 范围选择)
   * 并走 `onSelectionChanged`;再挂一层会两边同时改游标,而且 `shift` 会被这一层
   * 当成 additive,把刚算好的范围打散。
   * 签名收 `file` 是**为了不写内联箭头**(`react/jsx-no-bind`):调用点传一个具名回调。
   */
  onSelect?: (event: React.MouseEvent, file: ChangedFile) => void;
  /**
   * 行尾三颗图标的动词。**签名收 `file` 而不是零参**:这样调用点可以不写内联箭头
   * (`onDiscard={onDiscardRow}`),同时组件内部仍然用 `file` 去调它 ——
   * `react/jsx-no-bind` 对「多传一个实参」这种写法会判违规,所以只能让 props
   * 自己收参数。
   */
  onDiscard: (file: ChangedFile) => void;
  /**
   * **单文件暂存** —— `store.stageFile`(`git add -- <path>`)。
   *
   * ⚠️ 这与「行首那个勾选框」**不是**同一件事,两者都留(「先做,不删」):
   *  - 勾选框改的是**客户端纳入状态**(`includeState`,提交那一刻才 materialize 索引);
   *  - 这两条按钮**立刻写 git 索引**(`api.stage` / `api.unstage`)。
   * 上游 Desktop 只有前者(它没有「现在就把这个文件加进索引」这个交互);
   * 这两条是「我要现在就 `git add`」这个真实诉求的落点,也是审计第 4 项
   * (`store.stageFile` / `store.unstageFile` 此前 0 调用点)的接线处。
   * 两条都在时**不冲突**:索引与客户端模型本就是两个东西(见 `Snapshot.includeState`
   * 那段注释里的那张表)。
   */
  onStage: (path: string) => void;
  /** **单文件取消暂存** —— `store.unstageFile`(`git reset -- <path>`)。 */
  onUnstage: (path: string) => void;
  /**
   * **行右键** —— 上游 `ui/changes/filter-changes-list.tsx:839-857` 的
   * `onItemContextMenu`(`list.tsx:1218` → `list-row.tsx:229-230` 的
   * `onContextMenu(rowIndex, e)` 那一层)。
   *
   * 与 `onDiscard` / `onStage` / `onUnstage` 同样是「组件把 `file` 自己补上」的签名:
   * 调用点可以不写内联箭头(`onContextMenu={rowMenu}`),行内不出现 `react/jsx-no-bind`
   * 会记账的箭头函数。
   *
   * 行元素上还有一个**探针标记** `data-gw-ctx="file"`(表头那个是 `"list"`,理由写在
   * `.gw-chead` 上方):探针用它 + 菜单层在不在,在**同一帧**里一起读 ——
   * 「菜单缺席」的读数必须有这一半在场陪绑,否则分不开「没接线」与「整张表没渲染」。
   */
  onContextMenu: (event: React.MouseEvent, file: ChangedFile) => void;
  /**
   * 这一行是不是画在**镜像虚拟列表**里(`AugmentedSectionFilterList` → `ListRow`)。
   *
   * 影响两件事,都是**结构正确性**而不是样式:
   *  · 外层 `ListRow` 已经是 `role="option"`(`section-list.tsx:1245`)⇒ 本行**不再**
   *    声明 `role="option"`(嵌套 option 会被读屏当成两层列表);
   *  · 焦点由镜像列表管 ⇒ 本行不写 `tabIndex`。
   */
  virtual: boolean;
  /** 这一行的匹配下标(`<mark>` 高亮);来自镜像 `match`(见 `changes-file-list.tsx`)。 */
  matches?: IMatches;
  /**
   * 给镜像 `PathLabel` 的可用宽度(px)。`undefined` = 不截断
   * (`PathText` 在不给宽度时渲染完整文本)。
   */
  pathWidth?: number;
  /** **双击** = 用外部编辑器打开(上游 `filter-changes-list.tsx:1132-1134`)。 */
  onOpenInExternalEditor: (path: string) => void;
}): ReactNode {
  const { file, include } = props;
  /**
   * 行尾三颗图标的**事件回调**。`FileRow` 是**模块作用域**的组件,但它内部仍然算
   * 「组件作用域」给 `react/jsx-no-bind` 记账 —— 所以这里必须包 `useCallback`
   * (JSX 上挂具名引用),不能写 `onClick={(event) => …}`。
   * 三个回调都只是「停冒泡 + 转发给 props 上的那个动词」,没有别的逻辑。
   */
  const { onDiscard, onStage, onUnstage, onContextMenu, onOpenInExternalEditor, onSelect } = props;
  const discardSelf = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    onDiscard(file);
  }, [onDiscard, file]);
  const stageSelf = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    onStage(file.path);
  }, [onStage, file.path]);
  const unstageSelf = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    onUnstage(file.path);
  }, [onUnstage, file.path]);
  /**
   * 行右键。**不 stopPropagation**:表头那一层的 `onContextMenu` 挂在 `.gw-chead` 上,
   * 而行不在它里面(行住在 `.gw-files`),所以冒泡不会把两级菜单同时打开
   * (上游的层级也一样:行菜单挂在 `list-row` 上、表头菜单挂在 `.filter-field-row` 上)。
   */
  const contextMenuSelf = useCallback((event: React.MouseEvent) => {
    onContextMenu(event, file);
  }, [onContextMenu, file]);
  /**
   * **双击 = 用外部编辑器打开**(2026-10 接线)。
   *
   * 上游 `onChangedFileDoubleClick`(`ui/changes/filter-changes-list.tsx:1132-1134`,由
   * `List` 的 `onRowDoubleClick` 转发)⇒ `onOpenItemInExternalEditor` ⇒
   * `sidebar.tsx:304-306`;`store.openInExternalEditor` 我们**早就有**
   * (`src/client/store.ts:2985`,右键菜单的「在 <编辑器> 中打开」走的就是它)。
   * 审计 §3.2 #20 记的是「双击行**没有任何反应**」——这一条现在闭合。
   */
  const doubleClickSelf = useCallback(() => {
    onOpenInExternalEditor(file.path);
  }, [onOpenInExternalEditor, file.path]);
  /** 单击整行(只认平铺路径上的 `onSelect`;虚拟路径不传)。 */
  const selectSelf = useCallback((event: React.MouseEvent) => {
    onSelect?.(event, file);
  }, [onSelect, file]);
  // 状态图标取**工作区**那一侧(没有就用索引侧),与 Desktop 的文件行同一口径。
  const letter = file.conflicted === true ? 'U' : (file.unstaged ?? file.staged) ?? 'M';
  const meta = STATUS_META[letter] ?? { icon: 'diff-modified', kind: 'modified', label: '已修改' };
  /*
   * **镜像的 `AppFileStatus`**(判别联合)—— `PathLabel` / `iconForStatus` / `mapStatus`
   * 三件镜像件都吃它,而不是吃 porcelain 字母。适配点写在
   * `changes-file-list.tsx` 的 `appFileStatusOfChange`。
   */
  const appStatus = appFileStatusOfChange(file);
  // 目录 / 文件名分段、按实测宽度截断、`<mark>` 高亮、重命名箭头 —— **全在镜像 `PathLabel` 里**
  // (`ui/lib/path-label.tsx:37-71` + `ui/lib/path-text.tsx`)。我们那两段手写 span 退役。
  const shown = file.oldPath !== undefined ? `${file.oldPath} → ${file.path}` : file.path;
  /*
   * 子模块的勾选框语义 —— 上游 `filter-changes-list.tsx:427-470` 那 44 行的**逐条搬运**
   * (审计 §4 第 9 项的落点就是这里)。判据是镜像 `SubmoduleStatus` 的三个布尔位,
   * 而我们的 `ChangedFile.submodule`(`src/core/types.ts:83-88`)字段**同名同义** ⇒ 直接对。
   */
  const submoduleStatus = file.submodule;
  const isUncommittableSubmodule =
    submoduleStatus !== undefined &&
    appStatus.kind === AppFileStatusKind.Modified &&
    !submoduleStatus.commitChanged;
  const isPartiallyCommittableSubmodule =
    submoduleStatus !== undefined &&
    (submoduleStatus.commitChanged || appStatus.kind === AppFileStatusKind.New) &&
    (submoduleStatus.modifiedChanges || submoduleStatus.untrackedChanges);
  const includeAll = include === 'all' ? true : include === 'none' ? false : null;
  const effectiveInclude = isUncommittableSubmodule ? false : includeAll;
  const checkboxTooltip = isUncommittableSubmodule
    ? 'This submodule change cannot be added to a commit in this repository because it contains changes that have not been committed.'
    : isPartiallyCommittableSubmodule
      ? 'Only changes that have been committed within the submodule will be added to this repository. You need to commit any other modified or untracked changes in the submodule before including them in this repository.'
      : undefined;
  // 上游 `disableSelection = isCommitting || rebaseConflictState !== null || isUncommittableSubmodule`
  // (`filter-changes-list.tsx:453-454`);我们这边前两项的等价物是「提交进行中」
  // (`snap.busy === 'commit'`)与「rebase 冲突进行中」(`file.conflicted`)。
  const disableSelection =
    props.store.snapshot().busy === 'commit' || file.conflicted === true || isUncommittableSubmodule;
  /*
   * ⚠️ **三态 Mixed 接在 `include` 上,不是接在 `effectiveInclude` 上。**
   *
   * 上游 `filter-changes-list.tsx:463-470` 逐字是:
   *
   * ```tsx
   * <Checkbox
   *   value={
   *     isPartiallyCommittableSubmodule && include ? null : include   // null ⇒ Mixed
   *   }
   * ```
   *
   * 也就是说:**部分可提交的子模块**在「纳入(include === true)」这一档上画**三态 Mixed**
   * (因为只有子模块内部**已提交**的那部分会被带进来),而在「排除(false)」档上照旧画 Off。
   * 我们此前只用 `effectiveInclude` 算 ⇒ 那一档被画成**实心勾**(与上游的语义相反:
   * 看着像「全都会进来」,实际只有一部分)。
   *
   * `isUncommittableSubmodule` 那一半仍然走 `effectiveInclude`(上游 `:453-456` 的
   * `effectiveInclude = isUncommittableSubmodule ? false : include`),所以这里只覆盖
   * **部分可提交**这一支,不动另一支。
   *
   * 判据:`docs/probes/changes-submodule-include-probe.mjs`(5/7 → 7/7;`--pre-fix` 恰红
   * `{S2,S3,S4,S6}`),差值读数在 `{S2,S6}` —— S3/S4 在默认夹具下本来就红。
   */
  const checkboxInclude = isPartiallyCommittableSubmodule && effectiveInclude === true
    ? null
    : effectiveInclude;
  const checkboxValue = checkboxInclude === true
    ? CheckboxValue.On
    : checkboxInclude === false
      ? CheckboxValue.Off
      : CheckboxValue.Mixed;
  /*
   * 读屏宣告 —— 上游 `changed-file.tsx:69-78, 106` 的**唯一**出口:
   * `$'{path} {mapStatus(status)} {included|partially included|not included}'`
   * 交给 `AriaLiveContainer`(它内部是 `aria-live`,静态 `aria-label` **不会重播**)。
   */
  const includedText = effectiveInclude === true
    ? '已纳入提交'
    : effectiveInclude === undefined || effectiveInclude === null
      ? '部分纳入提交'
      : '未纳入提交';
  const ariaLiveMessage = `${file.path} ${meta.label} ${includedText}`;

  return (
    <div className={`gw-frow file${props.selected ? ' on' : ''}`}
      /*
       * ⚠️ `role="option"` **两条路径都挂**(`data-path` / `data-gw-ctx` 同理)。
       *
       * 虚拟路径上外层镜像 `ListRow` **已经**是 `role="option"`
       * (`section-list.tsx:1245`),所以这里会形成一层**嵌套 option**。这是**刻意**的:
       *  · 既有探针的行定位契约是 `.gw-files [role="option"][data-path="…"]`
       *    ——**同一个元素**上两个属性(`docs/probes/changes-file-menu-probe.mjs:675`);
       *    把角色拆到外层就等于把 4 条探针(147 + 50 + 50 + 21 条判据)的契约一起改掉;
       *  · 嵌套 option 的代价只是「读屏可能忽略内层」,而内层**本来**不该承担 option 语义
       *    (真正的 option 由外层承担)⇒ 视觉与功能无损。
       * 退役条件:那 4 条探针改成「外层 `ListRow` 定位 + 内层读内容」的那一天,
       * 这一行回到 `role={props.virtual ? undefined : 'option'}`。
       */
      role="option"
      aria-selected={props.selected}
      tabIndex={props.focused ? 0 : -1}
      aria-label={`${file.path} ${meta.label} ${includedText}${file.conflicted === true ? ' (有冲突)' : ''}`}
      data-path={file.path} data-included={include}
      /*
       * ⚠️ **虚拟路径上右键由外面那一格收**(`changes-file-list.tsx` 的 `VirtualCell`):
       * `react-virtualized` 的 `Grid` 不支持 `onRowContextMenu`,所以那里改成在
       * per-cell 的包装 div 上挂 `onContextMenu`;这一层若**同时**挂着,一次右键会把
       * 菜单开两遍(`showContextualMenu` 被两条链各调一次)。
       * 平铺路径(测不到高度)没有那一格 ⇒ 仍然由这里挂。
       * 判据:两侧都在 `docs/probes/changes-file-menu-probe.mjs` 的 49×3(F1–F13
       * 走的就是右键,虚拟路径)与 `changes-discard-lines-probe.mjs` 的 B1。
       */
      onContextMenu={props.virtual ? undefined : contextMenuSelf} data-gw-ctx="file"
      onDoubleClick={props.virtual ? undefined : doubleClickSelf}
      onClick={props.onSelect === undefined ? undefined : selectSelf} title={shown}>
      {/*
        勾选控件**是上游的 `<Checkbox>`**(`ui/lib/checkbox.tsx`,与上游一致;`changed-file.tsx:78-90`
        渲染的就是它):`<div class="checkbox-component"><input type="checkbox" tabindex="-1">`。
        三态走它的 `value`(On/Off/Mixed),由它自己在 ref 上写 `checked`/`indeterminate`。
        `tabIndex={-1}` 与上游一致:行本身响应空格键,勾选框不进 tab 序。
        **点它只改客户端纳入状态,一个 git 命令都不发**(勾选 ≠ 暂存);索引在提交时才写。
        `disabled` 是**子模块语义**(见上);`title` 是那两条 tooltip 文案 ——
        上游用 `TooltippedContent`(可视化 tooltip),我们的 tooltip 宿主还没接到 Changes 面
        (goal §11.13),所以先落在原生 `title` 上(审计 §3.1 #9 的已知差)。
      */}
      <span className="gw-cb-slot" title={checkboxTooltip}>
        <Checkbox
          tabIndex={-1}
          value={checkboxValue}
          disabled={disableSelection}
          onChange={(event) => { props.store.setFileIncluded(file.path, event.currentTarget.checked); }} />
      </span>

      {/* 路径:**镜像 `PathLabel`**(分段 + 按实测宽度截断 + `<mark>` + 重命名 `arrowRight`)。 */}
      <PathLabel path={file.path} status={appStatus} availableWidth={props.pathWidth}
        ariaHidden={true} matches={props.matches} />

      {/* 读屏宣告:`path + 状态 + 纳入` 变化时说一次(上游 `changed-file.tsx:106`)。 */}
      <AriaLiveContainer message={ariaLiveMessage} />

      {file.conflict !== undefined && (
        <span className="gw-num" title={`${conflictSummaryText(file.conflict.action)}(我方 ${file.conflict.us} / 对方 ${file.conflict.them})`}>
          {conflictSummaryText(file.conflict.action)}
        </span>
      )}

      {/*
        statusWidth = 16,与 Desktop 的 Octicon 列一致。
        图标**换成镜像的** `iconForStatus`(`ui/octicons/status.ts:16-38`):冲突走
        `octicons.alert`(marker > 0)或 `octicons.check` —— 我们以前手写 `x-circle`
        (审计 §3.1 #4 那条「冲突图标不同」)。类名仍是 `status status-<kind>`(按种类上色)。
      */}
      <span className={`status status-${meta.kind}`} title={meta.label}>
        <Octicon symbol={iconForStatus(appStatus)} />
      </span>

      <span className="gw-x" title="丢弃此文件的改动"
        onClick={discardSelf}>
        <Icon name="trash" size={10} />
      </span>

      {/*
        ⭐ 单文件「暂存 / 取消暂存」(2026-10 接线;审计第 4 项)。
        两条按钮的**出现条件**是各自的 git 事实,不是同一个开关:
          · 「暂存」:工作区里还有未暂存的内容(`unstaged !== undefined`,含未跟踪 `?`)
            —— 这也是「已暂存」的按钮不该出现的时候(索引已经等于工作区);
          · 「取消暂存」:索引里真的有这个文件(`staged !== undefined`)。
        一个文件**两边都有**(既 `staged` 又 `unstaged`,= 部分暂存)时两颗按钮同时在列 ——
        这正是要区分两个动作的场景。用 `title` 与 aria 文案区分(图标本身很接近)。
      */}
      {file.conflicted !== true && file.unstaged !== undefined && (
        <span className="gw-x" title="暂存此文件(git add -- 立刻写索引)"
          onClick={stageSelf}>
          <Icon name="plus" size={10} />
        </span>
      )}
      {file.conflicted !== true && file.staged !== undefined && (
        <span className="gw-x" title="取消暂存此文件(git reset -- 立刻改索引)"
          onClick={unstageSelf}>
          <Icon name="check" size={10} />
        </span>
      )}
    </div>
  );
}

/**
 * 状态字母 → 图标 / CSS 类后缀 / 中文说明。
 *
 * 类后缀必须是**英文 kind**(照 Desktop 的 `status-<kind>`,见
 * `styles/mixins/_octicon-status.scss:1-24`),因为按种类上色靠的是这几个类名;
 * 中文只用于 title 与 aria。
 */
/** 筛选选项的键 —— 与 Desktop 的**五项**一一对应(`changes-list-filter-options.tsx:179,188`)。 */
type FilterKey = 'included' | 'excluded' | 'new' | 'modified' | 'deleted';

/**
 * 筛选弹层给读屏的标签 id(上游 `changes-list-filter-options.tsx:152` 的
 * `ariaLabelledby="filter-options-header"` + `:174` 的 `<h3 id="filter-options-header">`)。
 * 带 `gw-` 前缀是为了在产物里**唯一**(探针按它取标题元素)。
 */
const FILTER_POPOVER_LABEL_ID = 'gw-filter-options-header';

/**
 * 筛选选项弹层 —— 载体**换成镜像 `Popover`**(上游
 * `ui/changes/changes-list-filter-options.tsx:151-224` 用的就是它;
 * 它的三条行为:点外面关 / Esc 关 / 焦点归还触发按钮)。
 *
 * 内容仍是我们的五项复选框 + 计数 + 「清除筛选」,但结构照上游那三段
 * (`.filter-popover-header` → `.filter-options` → `.filter-options-footer` 的**语义**;
 * 我们的类名是 `gw-filter-pop-head` / `gw-filter-opts` / `gw-filter-pop-foot`,
 * 因为这一件的样式在 `styles.ts` 里,不在上游 partial 的编译闭包内)。
 *
 * ⚠️ 为什么用 `createElement(Popover, …)` 而不是 JSX `<Popover>…</Popover>`:
 * 镜像 `IPopoverProps` **没有声明 `children`**(`popover.tsx:70-97`),JSX 的子元素检查
 * 会报 TS2322。`workbench.tsx` 的 `MenuPopover` 已经为同一原因用了同一条手法
 * (那一段的注释逐条列了上游 5 个调用点各自也报这条诊断)⇒ 这里**沿用**,不新造理由。
 *
 * ⚠️ `decoration={PopoverDecoration.Balloon}`:上游传的就是它(`:161`)。它给外壳加
 * `popover-component` 类,而 `.gw-desktop-changes .popover-component` 的基底配方
 * (圆角/边框/阴影/padding)在产物里**已有**——所以弹层不是裸的。
 * @param props - 见下;`anchor` 是筛选按钮(镜像 Popover 用它定位与归还焦点)。
 */
function FilterOptionsPopover(props: {
  counts: Record<FilterKey, number>;
  active: readonly FilterKey[];
  labels: Record<FilterKey, string>;
  /**
   * 「清除筛选」的可见性 —— **镜像 `hasActiveFilters`**(`filter-changes-logic.ts:147-149`),
   * 它**包含 `filterText`**。我们以前只看 `active.length > 0` ⇒
   * 「只输入了筛选词」时弹层里没有清空按钮(审计 §3.3 #30)。判据在调用点算,
   * 因为这个组件不该知道 `IFileListFilterState` 的形状。
   */
  showClear: boolean;
  /** 触发按钮 —— `Popover` 的 `anchor`(上游 `filterOptionsButtonRef`)。 */
  anchor: HTMLElement | null;
  onToggle: (key: FilterKey) => void;
  onClear: () => void;
  onClose: () => void;
}): ReactNode {
  const rows: [FilterKey, string][] = [
    ['included', props.labels.included],
    ['excluded', props.labels.excluded],
    ['new', props.labels.new],
    ['modified', props.labels.modified],
    ['deleted', props.labels.deleted],
  ];
  return createElement(
    Popover,
    {
      className: 'gw-filter-pop',
      anchor: props.anchor,
      anchorPosition: PopoverAnchorPosition.BottomRight,
      decoration: PopoverDecoration.Balloon,
      onMousedownOutside: props.onClose,
      onClickOutside: props.onClose,
      ariaLabelledby: FILTER_POPOVER_LABEL_ID,
    },
    <>
      <div className="gw-filter-pop-head">
        <h3 id={FILTER_POPOVER_LABEL_ID}>筛选选项</h3>
        <button className="gw-hbtn" aria-label="关闭" onClick={props.onClose}>
          <Icon name="x-circle" size={12} />
        </button>
      </div>
      <div className="gw-filter-opts">
        {rows.map(([key, label]) => (
          <label className="gw-chk" key={key}>
            <input type="checkbox" checked={props.active.includes(key)}
              onChange={() => props.onToggle(key)} />
            {label} ({props.counts[key]})
          </label>
        ))}
      </div>
      {props.showClear && (
        <div className="gw-filter-pop-foot">
          <button className="gw-btn" onClick={props.onClear}>清除筛选</button>
        </div>
      )}
    </>,
  );
}

const STATUS_META: Record<string, { icon: string; kind: string; label: string }> = {
  M: { icon: 'diff-modified', kind: 'modified', label: '已修改' },
  A: { icon: 'diff-added', kind: 'new', label: '新增' },
  '?': { icon: 'diff-added', kind: 'new', label: '未跟踪' },
  D: { icon: 'diff-removed', kind: 'deleted', label: '已删除' },
  R: { icon: 'diff-renamed', kind: 'renamed', label: '重命名' },
  C: { icon: 'diff-renamed', kind: 'copied', label: '复制' },
  U: { icon: 'x-circle', kind: 'conflicted', label: '有冲突' },
  T: { icon: 'diff-modified', kind: 'modified', label: '类型变更' },
};

/**
 * 列表键盘操作。
 *
 * 照 GitHub Desktop 的**点击/空格分工**(`ui/changes/sidebar.tsx:308-349`):
 *  - 点击只移动「diff 游标」(看哪个文件的 diff);
 *  - 空格/回车才是**切换「纳入提交」**(客户端模型,不写索引);
 *  - ↑/↓ 在行间移动焦点,Home/End 跳到两端。
 * 以前行是纯 `<div onClick>`,键盘完全不可达。
 */
function onListKeyDown(
  event: React.KeyboardEvent<HTMLDivElement>,
  flat: readonly { file: ChangedFile }[],
  store: GitStore,
  selected: ReadonlySet<string>,
): void {
  if (flat.length === 0) { return; }
  const rows = [...(event.currentTarget.querySelectorAll<HTMLElement>('[role="option"]'))];
  const currentIndex = rows.findIndex((row) => row === document.activeElement);
  const focusRow = (index: number): void => {
    const clamped = Math.max(0, Math.min(flat.length - 1, index));
    rows[clamped]?.focus();
  };

  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault();
      focusRow(currentIndex + 1);
      return;
    case 'ArrowUp':
      event.preventDefault();
      focusRow(currentIndex - 1);
      return;
    case 'Home':
      event.preventDefault();
      focusRow(0);
      return;
    case 'End':
      event.preventDefault();
      focusRow(flat.length - 1);
      return;
    case ' ':
    case 'Enter': {
      event.preventDefault();
      const index = currentIndex < 0 ? 0 : currentIndex;
      const entry = flat[index];
      if (entry === undefined) { return; }
      // 切换**纳入提交**(三态取反:全选→排除,其余→全选),与鼠标点复选框同一入口。
      const included = includeStateOf(store.snapshot().includeState[entry.file.path]) === 'all';
      store.setFileIncluded(entry.file.path, !included);
      // 同时把它设为 diff 游标,键盘用户不必再点一次。
      // ⚠️ 2026-10 修正:这里原本写的是 `store.loadDiff(entry.file.path)`,而
      // `loadDiff()` **不接受参数**(它读 `selectedFiles[0]`)—— 实参被静默忽略,
      // 于是空格切换的那一行**不会**成为 diff 游标:右栏继续显示上一个文件的 diff
      // 与它的行勾选,用户看到自己刚勾的行毫无变化。改用与点击同一个入口
      // (`toggleFile(path, false)` = 只移游标、不动纳入状态)。
      if (!selected.has(entry.file.path)) {
        store.toggleFile(entry.file.path, false);
      }
      return;
    }
    case 'Backspace':
    case 'Delete':
      // 不做破坏性操作:丢弃必须走显式按钮/确认框
      return;
    default:
      return;
  }
}

/**
 * 「取 diff 失败」那一帧的证据排版权重(纯内联样式,**不加新 CSS 类**)。
 *
 * 为什么不落进 `src/client/styles.ts`:那份文件整份是**一个**模板字符串
 * (多一个反引号就会截断整份 CSS,`scripts/check-template-literals.mjs` 管这条),
 * 而这里只要三个属性。语义与推送/生成失败弹窗的 `.gw-dialog pre` 逐条相同
 * (`max-height:180px; overflow:auto; user-select:text`),
 * **不共用**那个选择器只是因为它被 `.gw-dialog` 作用域锁住(那是个对话框)。
 *
 * `user-select:text`:与推送失败那轮的用户要求同一条 —— 这段原文必须能选中复制。
 */
const DIFF_FAILURE_DETAIL_STYLE: CSSProperties = {
  maxHeight: 180, overflow: 'auto', padding: 8, margin: '0 0 6px', borderRadius: 6,
  background: 'rgba(127,127,127,.14)', textAlign: 'left',
  fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace', fontSize: 11,
  lineHeight: 1.5, whiteSpace: 'pre-wrap', userSelect: 'text',
};
/** 「错误码:<code>」那一行:它是证据行,不该抢正文的注意力(与弹窗那份同口径)。 */
const DIFF_FAILURE_CODE_STYLE: CSSProperties = {
  margin: 0, fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace', fontSize: 11, opacity: 0.8,
};

/**
 * `+n/-n` 那一行的容器样式(见 `head` 里那段注释)。
 *
 * **刻意写成行内 style,不写进 `src/client/styles.ts`**:样式表那一份是
 * `check-template-literals` 管的模板字面量(整份 CSS 在一个反引号里,多一个反引号就截断),
 * 而这里只要那几条属性;而且这一行是「我们自己那条数字」的落点,退役时应当连同这个常量
 * 一起消失,不该在样式表里留下孤儿规则。
 *
 * ⚠️ **2026-10-09 起它不再是「头部下面那一行」**:用户裁决
 * 「Changes 右边的 diff header 下面有 + / -,请挪到 header 里面」,
 * 随后追加「+n / -n 应该在 header 内的设置按钮的左侧,并且要有红绿着色」。
 * 实现方式见 `DiffPane` 里那段注释(把这一行**挪回 header 那一行**:
 * 负上边距 + 与 header 等高 + 行盒贴容器右边缘、**内容推到齿轮左侧**),
 * 几何/配色判据由 `docs/probes/changes-diff-stat-gear-probe.mjs` 在真 Chrome 里量。
 */
const DIFF_STAT_ROW_STYLE: CSSProperties = {
  display: 'flex', justifyContent: 'flex-end', alignItems: 'center',
  flex: 'none', padding: '0 8px 2px',
};

/**
 * 那一行被**挪进 header 那一行的齿轮左侧**之后的样式(2026-10-09 用户两次裁决)。
 *
 * 它是 `DIFF_STAT_ROW_STYLE` 的**同一条配方**再改两处(`padding` 去掉 —— 两段数字自己的
 * 内边距已经给了呼吸位,见 `src/client/styles.ts:816-818`;加 `marginLeft:auto` 把**行盒**
 * 贴到 `.diff-container` 的右边缘),所以直接展开那个常量 —— 两处共用的四条
 * (display / justifyContent / alignItems / flex)只写一遍。
 *
 * 几何部分由 `DiffPane` 再补三个**量出来**的数值:
 *  · `marginTop = -headerHeight` 与 `height = headerHeight`(必须逐帧成对出现)⇒ 落进
 *    header 的矩形里、与 header 的既有孩子**同一行**(竖直那一半);
 *  · `paddingRight = 行盒右边缘 − 齿轮左边缘 + 一个呼吸位` ⇒ 把**内容**从容器最右推到
 *    **齿轮左边**(水平那一半)。
 *
 * ⚠️ 为什么水平位置要靠**行自己的 `paddingRight`**:行盒被 `marginLeft:auto` 钉在容器
 * 右边缘,`paddingRight` 是唯一能在**不移动行盒右边缘**的前提下把**内容**往左推的量 ——
 * 于是数字落在齿轮左侧,而行盒本身透明、`pointer-events:none`,盖不住任何东西
 * (它仍然横跨齿轮与状态图标那一带,所以那一条不能省)。
 *
 * 为什么用负上边距而不是 `position:absolute`:`.diff-container` 是 flex 列容器,
 * 绝对定位会要求给它加 `position:relative` —— 那会给**它内部**已有的绝对定位元素
 * (diff 搜索框、空格提示浮层…)换一个包含块。负边距只动我们自己这一行,零副作用。
 */
const DIFF_STAT_IN_HEADER_STYLE: CSSProperties = {
  ...DIFF_STAT_ROW_STYLE,
  padding: '0',
  marginLeft: 'auto',
  pointerEvents: 'none',
};

/**
 * `+n/-n` 每一段自己的行内覆盖 —— **只有一条**:去掉 `.gw-diff-stat` 的 `border-bottom`。
 *
 * 那条边框是 `.gw-diff-stat` 在「单独一行」形态下的分隔线(`src/client/styles.ts:816-818`),
 * 挪进 header 之后会变成数字下面的一小段横线。**值与颜色一个字都没动**
 * (`.add`/`.del` 的类名与文本照旧),只去掉这一条属于「行容器」的装饰。
 */
const DIFF_STAT_SPAN_STYLE: CSSProperties = { borderBottom: 'none' };

/**
 * 镜像 `ui/dialog/dialog.tsx:37-39` 的 `DialogStackContext` 值。
 *
 * **身份必须稳定**(每帧新建 `{isTopMost:true}` 会让 Context 消费者每帧收到新值);
 * 本插件同时最多一个弹窗,所以就是一个单元素栈 —— 与 `NOOP` 同一处置。
 * 为什么必须提供它:见上面 import 处那条注释(默认值是 `false` ⇒ `showModal()` 永不调用)。
 */
const DIALOG_STACK_SINGLE = { isTopMost: true };

/**
 * ⚠️ **退役(2026-10-10)**:这里原本是本文件唯一的「点名缺口」常量
 * `CONTINUE_REBASE_UNAVAILABLE`(「本插件没有 rebase/continue 路由」)。
 * 用户裁决「都做」之后宿主补上了那条路由(`src/host/routes.ts` 的 `'rebase/continue'`
 * → `GitService.continueRebase`),常量与它的门面分支一起**删除**(不是留着不用 ——
 * 留一句「做不到」的文案会让下一个人以为仍然做不到)。
 * 历史读数与那次裁决见 `docs/probes/README-probe-index.md` §十七 与本节新增的登记。
 */

/**
 * 超大文件闸门的**第二道**(LFS 覆盖检查)拿不到答案时的实话。
 *
 * 只有在宿主缺 `lfs/untracked` 时才会出现 —— 真实产品里 `src/index.ts` 一定注入了
 * `deps.lfs`,所以它对应的是**页面刷新了、宿主还是旧构建**(host 半不热重载,
 * 启动时 `health.build` 那条提示已经先说过一次,见 `src/client/store.ts:1034-1039`)。
 *
 * 为什么**不**直接放行、也不直接拦下:
 *  · 放行 = 把「超大且未被 LFS 覆盖」的告警**静默吞掉**(用户以为检查过了);
 *  · 拦下 = 把提交按钮永久堵死(这条闸门在上游本身也只是「拦住 + 让你 Commit Anyway」)。
 * ⇒ 给一条**点名缺口**的 toast,然后照常提交(见 `createCommitGate` 的注释)。
 * **退役条件**:宿主产物与页面产物永远同版本(或这条路由进了 host 的能力握手清单)之后,
 * 这个分支连同常量一起删。
 */
const OVERSIZED_LFS_UNCHECKED =
  '无法确认超大文件是否被 Git LFS 覆盖:宿主没有 lfs/untracked 路由(通常是宿主还是旧构建)。'
  + '这次提交照常进行,但「超过 100MB 且未用 LFS」的告警可能没有出现;'
  + '重启 DSH 让宿主重新加载后再提交一次可拿到完整检查。';

/**
 * `ContinueRebase` 唯一需要应用层提供的东西:上游 `ui/dispatcher/dispatcher.ts:1473-1512` 的
 * `continueRebase(kind, repository, workingDirectory, rebaseConflictState)`。
 *
 * 它是**门面**(与 `desktop-dispatcher.ts` 给 History 面接的那一批同形)。**2026-10-10
 * 起它真的干活**:宿主 `rebase/continue` 路由(`src/host/routes.ts` →
 * `GitService.continueRebase`,逐跳对着上游 `lib/git/rebase.ts:444-546` 写)
 * —— 用户裁决「都做」,此前「不建这条路由」的裁决作废。
 *
 * ## 三处如实收窄(都不是「差一点点」)
 *
 * 1. **返回类型是 `Promise<void>`**:上游回 `RebaseResult`(6 个值),而
 *    `ContinueRebase` 的 `onSubmit` **忽略**它的返回值(只 `await`)。类型面因此收窄成
 *    `void`;要拿到 6 个值就得从 `lib/git/rebase.ts` 里 import `RebaseResult` ——
 *    那是**一个会把整个 git 编排层拉进客户端包**的 import(该模块 import 了
 *    `./git` 一族),所以**不 import**,值的判定留在宿主侧
 *    (`api.continueRebase` 的 `result` 是字符串)。
 * 2. **`workingDirectory` / `rebaseConflictState` 只用于签名**:宿主那一跳自己读
 *    status/`REBASE_HEAD`(上游也是,`rebase.ts:470-485`),客户端的
 *    `manualResolutions` 在本仓恒为空(见 `GitService.continueRebase` 的注释),
 *    所以这两件不参与请求。
 * 3. **`kind` 参数照样声明**(上游是 `MultiCommitOperationKind`):`kind` 只用于上游的
 *    统计(`dispatcher.ts:1497-1499`),我们没有那个统计;声明它是为了**签名逐字**,
 *    下一个人不必再补一遍类型。
 *
 * ## 失败/成功都**如实播报**(不假装)
 *
 * · 传输失败 ⇒ `store.toast(hostError.message, 'err')`(点名宿主原话);
 * · `result === 'CompletedWithoutError'` ⇒ 播报「变基已完成」并**真的刷新**
 *   (上游 `dispatcher.ts:1501` 的 `appStore._loadStatus` 在这一侧的等价物是
 *   `store.refreshAll()` —— 提交区要从「ContinueRebase 表单」回到正常提交表单,
 *   靠的就是这次刷新把 `status.operation` 从 `'rebase'` 变回 `null`);
 * · 其它值(`ConflictsEncountered` / `OutstandingFilesNotStaged` / `Aborted` / `Error`)
 *   ⇒ 播报**这个值本身**(而不是「成功」),同样刷新(仓库状态确实变了)。
 */
class ContinueRebaseDispatcher extends Dispatcher {
  public constructor(private readonly store: GitStore) {
    super();
  }
  /**
   * 上游 `ui/dispatcher/dispatcher.ts:1473-1512` 的签名逐字
   * (`kind: MultiCommitOperationKind, repository: Repository, workingDirectory:
   * WorkingDirectoryStatus, conflictsState: RebaseConflictState`),只在返回类型上收窄
   * (理由见这个类的 JSDoc 第 1 条)。
   */
  public async continueRebase(
    _kind: MultiCommitOperationKind,
    repository: Repository,
    _workingDirectory: WorkingDirectoryStatus,
    _conflictsState: RebaseConflictState,
  ): Promise<void> {
    const res = await api.continueRebase({ path: repository.path });
    if (!res.ok) {
      this.store.toast(res.error.message, 'err');
      return;
    }
    const { result } = res.value;
    this.store.toast(
      result === 'CompletedWithoutError'
        ? '变基已完成。'
        : result === 'Aborted'
          ? '变基已经不在进行中了(读不到 .git/REBASE_HEAD)。'
          : `变基未完成:${result}(仓库状态已刷新)。`,
      result === 'CompletedWithoutError' ? 'ok' : 'err',
    );
    // 上游 `dispatcher.ts:1501` 的 `await this.appStore._loadStatus(repository)`。
    await this.store.refreshAll();
  }
}


/**
 * `DiffHeader` 的 `onDiffOptionsOpened`(上游 `changes.tsx:113` 传的是
 * `this.onDiffOptionsOpened` —— 它只用来让 AppStore 知道「弹层开过」,做一次性引导)。
 * 我们**没有**那个引导状态,所以照 History 面的同一处置(`history-view.tsx:1860`)
 * 传一个**模块作用域**的空函数:身份稳定,不会让头部每次都重挂。
 */
const NOOP = (): void => {};

/**
 * 「status 还没落地」那一帧的兜底状态(与 `desktop-diff.tsx:419-420` 的 `default` 同口径)。
 * 只在 `headPath === ''`(切仓库的首帧)时用得上。
 */
const FALLBACK_APP_FILE_STATUS: AppFileStatus = { kind: AppFileStatusKind.Modified };

/**
 * 右侧 diff 面板。四个表面:没选文件 / 读取中 / 没有可显示的差异 / **取 diff 失败**
 * (最后一个 2026-10 补,理由见下面那个 `snap.diffFailure` 分支)。
 *
 * **diff 正文由移植过来的 Desktop `Diff` 渲染**(`./desktop-diff.tsx`),
 * 全插件只有这一条渲染路径;二进制也交给它(上游 `DiffType.Binary` 分支)。
 *
 * **头部也是移植过来的**:**镜像 `DiffHeader`**(`ui/diff/diff-header.tsx` →
 * `PathLabel` + `DiffOptions` + 状态 Octicon),2026-10-08 接线,与上游
 * `ui/changes/changes.tsx:105-117` 同形。这一层因此只剩两件它自己负责的事:
 * 空态文案、以及 `+n/-n`(我们自己那条,不是上游的)。
 * 手写的 `diff-settings.tsx` **停止使用但文件保留**(见接线处那段注释与
 * `docs/changes-diff-header-adoption-plan.md`)。
 */
function DiffPane(props: {
  store: GitStore;
  snap: Snapshot;
  /**
   * 行/块级丢弃:把「哪几行」交给页那一层去弹确认框(上游 `ui/changes/changes.tsx`
   * 的 `onDiscardChanges` 同样是「先弹 `PopupType.ConfirmDiscardSelection`」)。
   */
  onDiscardLines: (file: string, spec: LineSelectionSpec) => void;
  /**
   * 我们渲染的 `.diff-container`(`ui/changes/changes.tsx:104`)。
   *
   * 只为 `+n/-n` 回到 header 那一行服务:`.header` 是**镜像** `DiffHeader` 的根
   * (它没有插槽、也不许改),所以布局必须做在**包装层**上,而包装层要量两个数:
   *   · `.header` 的高度 —— 统计行与它等高 + 负上边距,才落在**同一行**;
   *   · 统计行自己的宽度 —— 写给 `.header` 的 `--gw-diff-stat-reserve` 右内边距,
   *     这样状态 Octicon 不会被那两段数字盖住。
   */
  containerRef: React.RefObject<HTMLDivElement>;
}): ReactNode {
  const { onDiscardLines } = props;
  /**
   * 「当前屏幕上画的是哪个文件的 diff」。
   *
   * ⚠️ 为什么要一个 **ref** 而不是把 `shownDiff.path` 直接写进依赖:这个 hook 必须
   * 待在本组件**所有 `return` 之前**(Hooks 的调用顺序规则,
   * `react-hooks/rules-of-hooks` 会拦「早退之后再调 Hook」),而 `shownDiff` 是在
   * 那几处早退**之后**才解析出来的。ref 的回调身份因此保持稳定,而每次渲染都会把
   * 最新的路径写进去 —— 丢弃时读到的一定是**当下这一份** diff 对应的文件,
   * 不会错到上一个文件上(那正是「选中的行」与「被丢弃的行」错位那类静默缺陷)。
   */
  const shownPathRef = useRef<string>('');
  /**
   * 行/块级丢弃那一条回调 —— **具名**,理由同 `FileRow` 里那三个:
   * `react/jsx-no-bind` 会把组件作用域里的内联箭头记成新增违规。
   */
  const onDiscardLinesForShown = useCallback((spec: LineSelectionSpec): void => {
    const path = shownPathRef.current;
    if (path === '') { return; }
    onDiscardLines(path, spec);
  }, [onDiscardLines]);
  /**
   * 镜像 `DiffHeader` → `DiffOptions` 的两个回调(**具名 + `useCallback`**:
   * `react/jsx-no-bind` 会把作用域里的内联箭头记成新增违规,而这两个回调
   * 以前就是写成内联箭头的 —— 换成镜像头部**不**顺手把那两条记账带回来)。
   *
   * 语义与手写 `DiffSettings` 那两处逐条相同(同一个 store 方法、同一族 localStorage 键):
   *  - `onShowSideBySideDiffChanged` → `store.setSideBySide`(上游 `ui/lib/diff-mode.tsx`
   *    的 `show-side-by-side-diff`);
   *  - `onHideWhitespaceInDiffChanged` → `store.setHideWhitespace`
   *    (`hide-whitespace-in-changes-diff`,**Changes 面那一档**,与 History 那档不同键)。
   */
  const onSideBySideChange = useCallback((value: boolean): void => {
    props.store.setSideBySide(value);
  }, [props.store]);
  const onHideWhitespaceChange = useCallback((value: boolean): Promise<void> => {
    return props.store.setHideWhitespace(value);
  }, [props.store]);
  const { snap } = props;
  /*
   * ⚠️ **这个 `useRef` 必须在任何提前 return 之前** —— 它是「换文件时不要把 diff 区清空」
   * 那份缓存的载体(完整理由见下面那段注释),而它下面紧跟着
   * `snap.selectedFiles.length === 0` 的提前 return。
   *
   * 2026-10 修正:`useRef` 原先写在那个提前 return **之后**,于是「没选文件 → 选中文件」
   * 这一次渲染里 hook 的调用**多了一个** —— `react-hooks/rules-of-hooks` 报的就是这个
   * (`React Hook "useRef" is called conditionally`)。React 要求同一次挂载内每个 hook
   * 的调用顺序完全一致,`useRef` 不是那种「条件不成立就不需要」的东西:
   * `lastShownRef` 的语义是「跨渲染记住上一份 diff」,而这个组件**本来就会**在
   * 「有选中文件」与「没有选中文件」两种 props 下反复重渲染(切换仓库、清空选择、
   * 过滤后列表变空都会走到那条空态)⇒ 顺序错位是真实可达的,不是理论问题。
   *
   * 提到最上面之后**行为不变**:两条提前 return 只影响「渲染什么」,
   * 不影响这次 `useRef`(空态分支里它不会被读)。不要为了「看起来有条件」把它改成
   * 惰性初始化或 `useState` —— 那会换掉「只建一次、换文件时复用」的语义。
   */
  const lastShownRef = useRef<{ diff: NonNullable<Snapshot['diff']>; entry: ChangedFile | undefined } | null>(null);
  /**
   * `+n/-n` 那一行的 ref 与它量出来的三个数(用户 2026-10-09 两次裁决:
   * 「diff header 下面有 + / -,请挪到 header 里面」→
   * 「+n / -n 应该在 header 内的设置按钮的左侧,并且要有红绿着色」)。
   *
   * ## 为什么要量(而不是纯 CSS)
   *
   * 镜像 `DiffHeader` 的根 `.header` 是它**自己产出的输出**,没有 `children` 插槽
   * (`ui/diff/diff-header.tsx:36-51` 逐字如此,而 `scripts/verify-mirror.mjs` 要求那份
   * 文件**逐字节**),所以那两段数字只能是 `.header` 的**兄弟**。要同时满足「落在 header
   * 的矩形内 + 与 header 的既有孩子同一行 + 在齿轮左侧」,这个兄弟必须是:
   *
   * ```
   * .header        ┌──────────────────────────────────────────────┐  ← 第 1 行
   *                │ PathLabel …        [+n −m]  [齿轮]  [状态图标] │
   * .gw-diff-stat  └──────────────────────────────────────────────┘
   *                 ↑ marginTop = -headerH(与 header 等高 ⇒ 同一行)
   *                              ↑ paddingRight 把**内容**推到齿轮左边
   * ```
   *
   *  · **竖直**:`.header` 的高度由 `padding: var(--spacing-half) var(--spacing)` 与里面
   *    三件(PathText 的行盒 / DiffOptions 按钮 / 状态 Octicon)里**最高**的那件决定 ——
   *    那是上游配方的产物,**不能写死**(写死一个数就是第二份真源,字号一变就错位)。
   *  · **水平**:行盒由 `marginLeft:auto` 钉在 `.diff-container` 的右边缘,
   *    `paddingRight = 行盒右边缘 − 齿轮左边缘 + 呼吸位` ⇒ 内容的右边缘正好落在齿轮左边。
   *    齿轮左边缘**也只能量**:它左边是 `flex-grow:1` 的路径标签(位置随内容变),右边是
   *    状态 Octicon 与右内边距,没有一条 `calc()` 能表达它。
   *  · **让位宽度**:数字占的那一段从**路径标签**的右边距里让出来(消费它的规则在
   *    `src/client/scss/desktop-changes.scss`),量到的数字宽度写给容器上的
   *    `--gw-diff-stat-w`。
   *
   * ## 为什么不用 `position:absolute`
   *
   * `.diff-container` 是 flex 列容器且**没有** `position`(`ui/_diff.scss:899-905`)。
   * 给它加 `position:relative` 会**换掉它内部所有绝对定位元素的包含块**
   * (diff 搜索框、空格提示浮层……),那是别人的布局;负上边距只动我们自己这一行。
   *
   * ## 三个数值的写入点
   *
   * · 高度 / 负边距 / 行右内边距:走 React(`statBox`),于是同一帧内成对出现;
   * · 数字宽度:一个 CSS **自定义属性**写在 `.diff-container` 上行内 —— 它必须落在容器上
   *   (自定义属性沿 DOM 向下继承,写在兄弟节点上到不了 `.header` 里的路径标签)。
   *
   * ⚠️ 呼吸位 `--gw-diff-stat-gap` **由 CSS 提供、由这里读**(`getComputedStyle`),
   * 于是「数字与齿轮之间那个缝」只有**一份真源**。
   */
  const statRowRef = useRef<HTMLDivElement>(null);
  const [statBox, setStatBox] = useState<{ headHeight: number; statWidth: number; rowInset: number }>(
    { headHeight: 0, statWidth: 0, rowInset: 0 },
  );
  /**
   * `useLayoutEffect`(不是 `useEffect`):三个数值要在**浏览器绘制之前**落到 DOM 上,
   * 否则用户会先看到「数字还贴在最右边」的那一帧。
   *
   * ⚠️ 它必须在**所有早退之前**(Hooks 顺序规则,与上面 `lastShownRef` 同一条),
   * 而它读的节点可能不在场(空态/失败态没有统计行)⇒ 第一句就是空值检查。
   * 依赖里那三个值是「数字变了 / 换了文件要重量」的判据;`props` 本身不进依赖
   * (每帧都是新对象 ⇒ 等于没 memo),所以逐项列出。
   *
   * **一次测量就够,不需要第二遍布局**:这里读的四个量里,只有路径标签的盒宽会被
   * `--gw-diff-stat-w` 影响,而**齿轮与状态图标的位置与它无关** —— 路径标签是
   * `flex-grow:1`,它变窄多少,富余空间就多多少,齿轮照旧贴着右侧。所以「量齿轮左边缘」
   * 与「写让位宽度」之间没有反馈回路,不会来回震荡。
   */
  useLayoutEffect(() => {
    const container = props.containerRef.current;
    const row = statRowRef.current;
    if (container === null || row === null) { return; }
    /*
     * `.header` 是**直接子元素**(镜像 `DiffHeader` 的根),选择器用 `:scope >`
     * 而不是后代:`.diff-container` 里面还会出现别的 `.header`(diff 正文里没有,
     * 但这条断言不该依赖「正文里恰好没有」)。
     * 齿轮取的是 `.diff-options-component`(镜像 `DiffOptions` 的根,
     * `ui/diff/diff-options.tsx:87`),不是它里面那颗按钮 —— 裁决要的是「数字在设置按钮
     * 左侧」,而那个组件的左边缘就是那条线(它的 `margin-right: var(--spacing-half)`
     * 让按钮与状态图标之间也有缝)。
     */
    const header = container.querySelector(':scope > .header');
    const gear = header === null ? null : header.querySelector('.diff-options-component');
    const headHeight = header === null ? 0 : header.getBoundingClientRect().height;
    /*
     * 数字那一段**自己的**宽度 = 两段 `span` 的并集(不含行盒的内边距)。
     * 用 `.at()` 而不是 `[0]`:它的类型是 `Element | undefined`,不用假装「一定有两段」。
     * 读不到(空态 / 首帧还没渲染)时是 0 ⇒ 不写变量,路径标签于是和上游一样占满 ——
     * **不假装量到了**。
     */
    const spans = Array.from(row.querySelectorAll('.gw-diff-stat'));
    const firstSpan = spans.at(0);
    const lastSpan = spans.at(-1);
    const statWidth = firstSpan === undefined || lastSpan === undefined
      ? 0
      : lastSpan.getBoundingClientRect().right - firstSpan.getBoundingClientRect().left;
    /*
     * 呼吸位从 CSS 里读(理由见上面那段注释)。读不到那个自定义属性(jsdom 没有布局引擎 /
     * 首帧样式还没落地)时用 0 —— 那时 `statWidth` 也是 0,整段水平写入都会被跳过。
     */
    const gapRaw = Number.parseFloat(getComputedStyle(container).getPropertyValue('--gw-diff-stat-gap'));
    const gap = Number.isFinite(gapRaw) ? gapRaw : 0;
    /*
     * 行右内边距 = 行盒右边缘 → 齿轮左边缘 的距离 + 呼吸位。
     * `marginLeft:auto` 把行盒钉在容器右边缘,`paddingRight` **不会**移动那条边缘
     * (自动外边距把富余全吸收掉)⇒ 这个值在同一次测量里是稳定的。
     * 齿轮不在场时留 0:数字退回容器最右,那是**改前**的落点,也是「没量到就不假装」
     * 的另一种说法(产品里这一档到不了:这一帧给镜像 `DiffHeader` 的 `diff` 恒为 `null`
     * ⇒ `renderDiffOptions` 一定画齿轮)。
     */
    const rowInset = gear === null
      ? 0
      : Math.ceil(row.getBoundingClientRect().right - gear.getBoundingClientRect().left + gap);
    if (statWidth > 0) {
      container.style.setProperty('--gw-diff-stat-w', `${Math.ceil(statWidth)}px`);
    } else {
      container.style.removeProperty('--gw-diff-stat-w');
    }
    setStatBox((prev) => (prev.headHeight === headHeight && prev.statWidth === statWidth
      && prev.rowInset === rowInset
      ? prev
      : { headHeight, statWidth, rowInset }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.containerRef, props.snap.selectedFiles, props.snap.diff]);
  if (snap.selectedFiles.length === 0) {
    return <Empty icon="file" title="选择一个文件查看 diff" body="在左侧列表里点一个文件。" />;
  }
  const diff = snap.diff;
  /*
   * **换文件时不要把 diff 区清空** —— 上游 `SeamlessDiffSwitcher` 的 `propSnapshot`
   * (`ui/diff/seamless-diff-switcher.tsx:206`,`:380` 读它)在加载期间渲染的是
   * **上一次成功的 props(含上一次的 diff)** + `.loading-indicator`;那个类的注释自己写着
   * 目的是「avoiding flickering when rapidly switching between files」(`:178-182`)。
   *
   * 我们以前在 `diff === null` 时**提前 return** 一个「读取 diff…」空态 ⇒ `DesktopDiff`
   * 整个被卸载 ⇒ 换文件那一瞬 diff 区**整个消失**。这在真 Chrome 里量到过
   * (`docs/probes/changes-diff-switch-probe.mjs`,改前:`hasDesktopDiff=false`、
   * `class=null`、`空态「读取 diff…」=true`）。
   *
   * 修法:**保留上一份**渲染所需的输入,加载期间照旧渲染它(头部路径换成**新选中的**文件,
   * 与上游一致 —— `changes.tsx` 的 `DiffHeader` 拿的是新 `file.path`,而正文由 switcher
   * 的 propSnapshot 撑着)。只有**首次**加载(还没有任何上一份)才显示那个空态。
   *
   * 为什么保留在这一层:上游的 switcher **收的是** `IDiff`+`ChangedFile`,所以它自己就能留;
   * 我们这一层收的是宿主原始 `patch`(`IDiff` 由 `DesktopDiff` 现解析),所以「留一份上一个
   * 文件的结果」只能在这里做 —— 这是**同一语义在适配层的落点**,不是第二份真源。
   */
  if (diff !== null) {
    lastShownRef.current = {
      diff,
      entry: (snap.status?.files ?? []).find((f) => f.path === diff.path),
    };
  }
  const shown = lastShownRef.current;
  // 头部**始终**渲染:隐藏空白时纯缩进改动会整个消失,此时用户更需要能点回开关
  // (Desktop 的 DiffHeader 也是常驻的)。
  // 路径取**当前选中**的文件(加载中也是新文件),上游 `changes.tsx:110` 就是这么传的。
  const headPath = diff?.path ?? snap.selectedFiles[0] ?? '';
  /*
   * 头部状态位 —— `DiffHeader` 要的是**镜像的** `AppFileStatus` 判别联合
   * (`PathLabel` / `iconForStatus` / `mapStatus` 三件镜像件都吃它)。
   * 投影函数是**既有**的 `appFileStatusOfChange`(`changes-file-list.tsx:130`,
   * 左栏每一行用的就是它)⇒ 头部与列表行读的是**同一个**状态,不会出现
   * 「列表说重命名、头部说修改」那种两份真源。
   *
   * `headEntry === undefined` 只可能出现在「status 还没落地」那一帧(切仓库的首帧),
   * 那时 `headPath` 也是 `''`;兜底 `Modified` 与 `appFileStatusFor` 的 `default` 同口径
   * (`desktop-diff.tsx:419-420`)。
   */
  const headEntry = (snap.status?.files ?? []).find((f) => f.path === headPath);
  const head = (
    <>
      <DiffHeader
        /*
         * ⚠️ `diff` 这一个 prop **只**被 `diff-header.tsx:57` 用来判
         * 「子模块时不画 DiffOptions」。我们这一帧手上只有宿主的原始 `patch`
         * (`IDiff` 由 `DesktopDiff` 现解析),为这一个判断再 `parsePatch` 一遍
         * 是纯浪费 ⇒ 传 `null`(= 「不是子模块」)。
         * **退役条件**:等 `desktopDiffFromPatch` 真的产出 `DiffType.Submodule`
         * 那一档(审计 §5 第 8 项),这一行必须跟着改成那个 `IDiff`,
         * 否则子模块的头部会多画一个齿轮。
         */
        diff={null}
        path={headPath}
        status={headEntry === undefined ? FALLBACK_APP_FILE_STATUS : appFileStatusOfChange(headEntry)}
        showSideBySideDiff={props.snap.sideBySide}
        onShowSideBySideDiffChanged={onSideBySideChange}
        hideWhitespaceInDiff={props.snap.hideWhitespace}
        onHideWhitespaceInDiffChanged={onHideWhitespaceChange}
        onDiffOptionsOpened={NOOP}
      />
      {/*
       * `+n/-n` 是**我们自己的**(上游头部没有这一格,见审计 §4 第 16 行)。
       * 「先做,不删」:换成镜像头部**不**顺手丢掉这条信息,所以它留在同一棵子树里。
       *
       * ⚠️ **位置(2026-10-09 按用户两次裁决)**:第一次原话「Changes 右边的 diff header
       * 下面有 + / -,请挪到 header 里面」;第二次原话「+n / -n 应该在 header 内的设置按钮
       * 的左侧,并且要有红绿着色」。接线时它一度被挪到 `.diff-container` 的第二行(右对齐),
       * 理由是镜像 `DiffHeader` 的根 `.header` 是它自己产出的、**没有插槽**。裁决是
       * 「挪进去、并且落在齿轮左侧」,而**镜像件保持逐字节** ⇒ 实现只在我们这一层:
       *   ①这一行与 `.header` **等高**,再用**负上边距**上移一个 header 高度 ⇒ 落进 header
       *     的矩形、与既有孩子同一行;
       *   ②行盒贴容器右边缘(`marginLeft:auto`),再用**行自己的 `paddingRight`** 把内容
       *     左推到齿轮左边(量法与理由见上面 `statBox` 那段注释);
       *   ③数字占的那段宽度由 `desktop-changes.scss` 里 `.path-label-component` 的
       *     右边距让出来 —— 否则数字会压在路径尾巴上;
       *   ④`.add` / `.del` 的红绿同样在那份 scss 里(宿主语义令牌,不写死色值)。
       * 几何与配色判据由 `docs/probes/changes-diff-stat-gear-probe.mjs` 在真 Chrome 里量。
       *
       * `.gw-diff-stat` 的 `<span>` 上按需去掉那条 `border-bottom`:它是给「单独一行」
       * 设计的分隔线,挪进 header 之后会变成数字下面的一小段横线(值与文本一个字没动)。
       *
       * **退役条件**:若裁决要 100% 上游头部(不要这行数字),删掉这个块 +
       * `DIFF_STAT_ROW_STYLE` / `DIFF_STAT_IN_HEADER_STYLE` / `statBox` 与那份 scss 里
       * 三条 `.gw-diff-stat*` / `.path-label-component` 规则即可。
       */}
      {diff !== null && (diff.additions > 0 || diff.deletions > 0) && (
        <div className="gw-diff-stat-row" ref={statRowRef} data-gw-diff-stat-row="1"
          style={{ ...DIFF_STAT_IN_HEADER_STYLE, marginTop: -statBox.headHeight, height: statBox.headHeight, paddingRight: statBox.rowInset }}>
          {diff.additions > 0 && <span className="gw-diff-stat add" style={DIFF_STAT_SPAN_STYLE}>+{diff.additions}</span>}
          {diff.deletions > 0 && <span className="gw-diff-stat del" style={DIFF_STAT_SPAN_STYLE}>-{diff.deletions}</span>}
        </div>
      )}
    </>
  );

  /*
   * **取 diff 失败也要有落点**(2026-10;判据 `docs/probes/diff-too-large-probe.mjs`)。
   *
   * 修的是审计点名的那个缺陷(`docs/diff-view-gap-audit.md` §4 第 8 行):
   * 补丁大于宿主收集器上限(`OUTPUT_CAP_BYTES = 4 << 20`,`git-runner.ts:155`)时,
   * 宿主**响亮拒绝**(`BlobTooLargeError` → 信封 `ok:false` + `code/message/detail`),
   * 而客户端以前把这一声喊叫丢在地上 ⇒ 这一帧会走下面那条「沿用上一份」的路,
   * 把**上一个文件**的 diff 画在新文件的表头下(实测:8,130,113 B 的真补丁,
   * 头部 = `big.txt`,面板正文逐字是 `small.txt` 的内容);首帧就是大文件时则永久
   * 停在「读取 diff…」(那不是「加载中」,是骗人)。
   *
   * 为什么落在这里,而不是照推送/生成失败那样弹窗、也不是只 `store.fail()` 一条 toast:
   *  1. 弹窗与 toast **都不换掉正文** —— 而错的那一半正是正文(上一份 diff 还在原地),
   *     所以它们单独用**修不掉**这个缺陷;
   *  2. 这个面板对「拿不到 diff」本来就有自己的表面(下面那两处 `Empty`:
   *     「读取 diff…」/「没有可显示的差异」)⇒ 失败放进同一张表面,一个面板一种空态载体,
   *     不新增外壳、不新增 CSS 类;
   *  3. `store.fail()` **今天不再丢 `detail`** —— 2026-10 已修:`fail()`(`store.ts:983-995`)
   *     对**任何**码都附 `（detail）` 与 `错误码:<code>`(`internal` 也是),所以这里的取舍
   *     **不是**「fail() 会吞证据」,而是另外两条仍然成立的差异:①它把 `detail` 的换行
   *     **压成空格**(`fail()` 里那条「把空白里夹的换行折成单空格」的 `replace`),而这里的
   *     证据契约是 `detail` **逐字**(保留换行);②它只是 7 秒后消失的一行 toast,
   *     **换不掉正文** —— 而错的那一半正是正文。`fail()` 一个字没删 —— 它仍是其它
   *     失败路径的出口。
   *     (改前这句话写的是「对 `code === 'internal'` 刻意不附 `detail`」,那条已经不成立。)
   *
   * `lastShownRef.current = null`:失败**不是**「还在加载」,沿用下去就是本缺陷;
   * 清掉之后,下一次切文件时那一帧给的是诚实的「读取 diff…」而不是又一份陈旧内容。
   */
  if (snap.diffFailure !== null) {
    const failure = snap.diffFailure;
    lastShownRef.current = null;
    return (
      <>
        {head}
        <Empty icon="x-circle" title={failure.message}>
          {failure.detail !== undefined && failure.detail !== ''
            ? <pre style={DIFF_FAILURE_DETAIL_STYLE}>{failure.detail}</pre>
            : null}
          <p style={DIFF_FAILURE_CODE_STYLE}>错误码:{failure.code}</p>
        </Empty>
      </>
    );
  }

  // 只有**首次**加载(`shown === null`)才给空态;此后加载期间沿用上一份。
  if (shown === null) { return <>{head}<Empty icon="file" title="读取 diff…" /></>; }
  const shownDiff = shown.diff;
  // binary 也走移植的 Diff(它的 BinaryFile 分支画「这个二进制文件变了」+ 外部程序打开)。
  if (shownDiff.patch.trim() === '' && shownDiff.binary !== true) {
    return (
      <>
        {head}
        <Empty icon="check" title="没有可显示的差异"
          body={props.snap.hideWhitespace
            // 这一句很关键:否则用户会以为改动丢了
            ? '当前隐藏了空白改动,所以只有缩进/空格变化的改动不会显示。要看到它们,请在右上角的 Diff 设置里取消「隐藏空白改动」。'
            : shownDiff.untracked === true ? '这是新文件,内容尚未进入 diff。' : '改动已被暂存或撤销。'} />
      </>
    );
  }

  // 状态字母与冲突分类来自变更列表里的那一条(而不是 diff 自己),用于上游
  // 「重命名但没改动」/「冲突需在命令行解决」等按文件状态分派的文案。
  const entry = shown.entry;

  /**
   * 这个文件的行级选区能不能被 host **按行**兑现(见 `file-kind.ts`)。
   *
   * 以前它同时被当成 `DesktopDiff.selectable` 传下去,而那个 prop 在上游控制的是
   * `canSelect(file)`(`diff-helpers.tsx:366-370`,实现是
   * `instanceof WorkingDirectoryFileChange`)⇒ 一旦为 false,`CommittedFileChange`
   * 会让 `showDiffCheckMarks && isDiffSelectable` 恒假
   * (`side-by-side-diff-row.tsx:269,803`)⇒ **整条行勾选列连 DOM 都不渲染**。
   *
   * 真 Chrome 实测(同一份 7 类文件的夹具,面板 420×700):
   *   · 已修改文件(`unstaged:'M'`)→ 8 行、**4 个**行勾选框、勾选列 20px 宽;
   *   · **未跟踪**(`.eslintignore`)/ **索引里已有内容**(`staged:'M'`)→
   *     行照渲染,**行勾选框 0 个、勾选列 0 条**。
   * 于是左栏文件行的勾选在右边**大多数文件上都没有可联动的对象** —— 这正是用户报的
   * 「明明有勾选但 diff view 没联动」。
   *
   * ⇒ 现在它**只**作为「host 能不能按行兑现」的事实,记录在下面那个
   * `data-gw-include-probe` 的 `lineSelectable` 字段里(给探针做三处读数用的
   * 机器可查点),**不再**参与任何渲染判定。
   */
  const lineSelectable = entry !== undefined && supportsLineSelection(entry);
  // 把「当下这一份 diff 是哪个文件」写进 ref(供上面那个早退之前的 hook 读)。
  shownPathRef.current = shownDiff.path;

  return (
    <>
      {head}
      {/*
        机器可查的联动读数(探针用,`display:none` 不占布局)。
        为什么要有:用户报的这个 bug 的本质是「同一件事有三处读数」——
          ① `store.includeState[path]`(真值;左栏行的勾选框读它)
          ② 传给 `DesktopDiff` 的 `selection`(右栏勾选列读它)
          ③ 左栏行自己渲染出来的勾
        写「已验证」之前必须把三处一起量。这里让 ② 直接可从 DOM 读到,
        免得再去猜它传了什么(以前只能靠「右栏有没有画勾」反推)。
      */}
      <div hidden data-gw-include-probe={JSON.stringify({
        path: shownDiff.path,
        selection: snap.includeState[shownDiff.path] ?? null,
        lineSelectable,
      })} />
      <DesktopDiff
        input={{
          repositoryPath: snap.current,
          path: shownDiff.path,
          ...(shownDiff.oldPath !== undefined ? { oldPath: shownDiff.oldPath } : {}),
          patch: shownDiff.patch,
          binary: shownDiff.binary,
          ...(entry?.staged !== undefined ? { status: entry.staged } : {}),
          ...(entry?.staged === undefined && entry?.unstaged !== undefined ? { status: entry.unstaged } : {}),
          ...(entry?.untracked === true ? { untracked: true } : {}),
          ...(entry?.conflicted === true ? { conflicted: true } : {}),
          ...(entry?.conflict !== undefined ? { conflict: entry.conflict } : {}),
        }}
        showSideBySideDiff={snap.sideBySide}
        hideWhitespaceInDiff={snap.hideWhitespace}
        onHideWhitespaceInDiffChanged={(value) => { void props.store.setHideWhitespace(value); }}
        onOpenBinaryFile={(fullPath) => { void props.store.openInExternalEditor(fullPath); }}
        // 只有 Changes 页签是**可交互** diff(History 不传:历史 diff 只读,上游同)。
        // **选区真值来自 store 的纳入状态**,所以右侧的勾选列与左栏文件行永远一致。
        //
        // ⚠️ 这里**恒为 true**(2026-10 修正,真 Chrome 实测):
        //  · **必须 true**,否则上游 `changedFileFor()` 会造 `CommittedFileChange`
        //    ⇒ `canSelect()` 为假 ⇒ 整条行勾选列**连 DOM 都不渲染**
        //    (`side-by-side-diff-row.tsx:269,803`),左栏的勾选在右边没有任何可联动的对象;
        //  · 它同时让 `showDiffCheckMarks` 为真(`desktop-diff.tsx` 里由同一个值驱动),
        //    这正是「勾选状态可见」的前提;
        //  · 行级勾选**只写客户端模型**(`store.setFileSelection`),一个 git 命令都不发;
        //    「这个文件的行级补丁能不能交给 host」由 `supportsLineSelection` 在**提交期**
        //    决定(store 里那条兜底会按整文件纳入并明确提示),不再由这里决定**可见性**。
        // 反证方式:把这一行改成 `selectable={lineSelectable}`,未跟踪文件的 diff 勾选列
        // 立刻消失(探针 `docs/probes/browser-probe.tsx` 的 B1 就是这个断言)。
        selectable={true}
        selection={snap.includeState[shownDiff.path]}
        onSelectionChanged={(spec) => props.store.setFileSelection(shownDiff.path, spec)}
        /*
         * ⭐ 行/块级丢弃(2026-10 接线)。以前**整个 props 面都不存在**
         * (`desktop-diff.tsx` 的 `IDesktopDiffProps` 没有 `onDiscardChanges`)⇒ 上游
         * `side-by-side-diff.tsx:1458` 的 `if (this.props.onDiscardChanges === undefined) return`
         * 恒真 ⇒ **行号 gutter 右键连菜单都不弹**,选中的行只能暂存、不能丢。
         * 宿主侧那时已经端到端验过 79 条断言(`docs/discard-lines-contract.md` §4)。
         *
         * 这里只**收**选区:确认框由下面的 `confirmDiscardLines` 负责渲染
         * (上游 `ui/changes/changes.tsx:75-97` 就是「先弹 `ConfirmDiscardSelection`,
         * 确认后才 `discardChangesFromSelection`」)。确认框里再调
         * `store.discardLines`,补丁方向那一侧由 store 保证(见那个方法的注释)。
         */
        onDiscardChanges={onDiscardLinesForShown}
      />
    </>
  );
}

/**
 * **「Committing as」头像按钮 + 提交者身份浮层**(GitHub Desktop 的
 * `ui/changes/commit-message-avatar.tsx`,与上游一致,一个字不改)。
 *
 * ## 上游是什么,我们接在哪
 *
 * 上游把它渲染在提交表单 `.summary` 行的**第一个子节点**
 * (`ui/changes/commit-message.tsx:1779-1780` 的 `{this.renderAvatar()}`),点开是一个
 * `RightBottom` + `Balloon` 的浮层(`commit-message-avatar.tsx:419-436`),内容是
 * `Committing as <name>`(`:380-398`,标题字符串在 `:392`)、`Email: <email>`
 * (`:250`)与 `Cancel` / `Open Git Settings` 两个按钮(`:266-272` + `:246`)。
 *
 * ## prop 面:哪几条是真的,哪几条**拿不到**(逐条如实,不假装)
 *
 * | prop | 上游来源(`ui/changes/commit-message.tsx`) | 我们 |
 * |---|---|---|
 * | `user` / `email` | `:731-734,753` `commitAuthor`(app-state 的 `getAuthorIdentity()`) | **真**:读 git 配置(见下 `readEffectiveAuthor`),local 优先、global 兜底 |
 * | `repository` | `:790` | **真**:`new Repository(path, 0, null, false, alias)`——`gitHubRepository = null` 是上游「没有 GitHub 远端」的合法取值 |
 * | `branch` | `:780` | **真**:`snap.status.branch`(只有 disallowedEmail 分支会读它) |
 * | `onUpdateEmail` | `:787` / `:796-799` `setGlobalConfigValue('user.email', …)` | **真**(真写全局配置),但**今天不可达**:入口在告警浮层里,而 `warningType` 恒 `'none'` |
 * | `onOpenGitSettings` | `:789` / `:809-814` `PopupType.Preferences` + `PreferencesTab.Git` | **真回调**,但目标弹窗的入口在 `workbench.tsx`(见 `CommitBox` 的 `openGitSettings`) |
 * | `onOpenRepositorySettings` | `:788` / `:801-807` `RepositorySettings` + `GitConfig` 页 | **没有落点** ⇒ 一条点名缺什么的 toast(`REPOSITORY_SETTINGS_UNAVAILABLE`) |
 * | `warningType` / `emailRuleFailures` | `:755-769,779` | **恒 `'none'`**。两条判据今天都拿不到:`disallowedEmail` 要 repo rules(上游 `lib/helpers/repo-rules.ts` 依赖 `re2js`,本仓**没有**这个依赖、也不许加),`misattribution` 要账号邮箱 |
 * | `accountEmails` / `preferredAccountEmail` / `isEnterpriseAccount` | `:737-751,775-777,782-786` | **空/缺省**。它们要 `Account.emails`(GitHub `GET /user/emails`),而 `api.AuthStatePayload` 只有 `signedIn/login/tokenTail/deviceFlow/viaDeviceFlow`(`api.ts:544-550`)⇒ 要**新开一条 host 路由**,本轮裁决为**不开** |
 * | `accounts` | `:791` | **`[]`**。`Avatar`(`ui/lib/avatar.tsx:216-275`)在 `endpoint === null` 时不查 API、也不要 token,直接用 email 候选(gravatar)——所以空数组是**功能完整**的,不是降级 |
 *
 * ⚠️ **`warningType` 恒 `'none'` 的后果要说清**:不是「藏了一个恒 false 的分区」,
 * 而是**压根不给它输入** —— 于是 `renderWarningPopover()`(`:277-378`)与
 * `renderWarningBadge()`(`:189-207`)整块**不渲染**,`accountEmails` /
 * `preferredAccountEmail` / `isEnterpriseAccount` / `emailRuleFailures` 与
 * `onUpdateEmail` 的消费点全部落在那里。等账号邮箱面落地后再谈 misattribution。
 *
 * ## 生效值为什么是「local 优先、global 兜底」
 *
 * 宿主 `config-get` 的 `scope` 是**严格作用域**(`src/core/git-argv.ts:458-460`:
 * `git config --local|--global --get`),**没有**「合并读取」这一档。而 git 自己给提交
 * 定作者用的是**完整配置链**(local 覆盖 global),所以这里必须读四次再按
 * local → global 取第一个非空值 —— 少读一次就会出现「全局设了作者、浮层却显示
 * 空」的假缺口。system 级配置(**不在**这两档里)是已知的、与上游**等价**的窄化:
 * Desktop 的 `getAuthorIdentity()` 也只看 user.name/user.email 这两个键。
 */
function CommitAuthorAvatar(props: {
  snap: Snapshot;
  onOpenGitSettings: () => void;
  onOpenRepositorySettings: () => void;
}): ReactNode {
  const { snap } = props;
  const path = snap.current;
  /** 生效的作者身份;`null` = 还没读到(或没有仓库)。 */
  const [author, setAuthor] = useState<{ name: string; email: string } | null>(null);
  /**
   * 重新读**作者身份**的时机:换仓库、HEAD 变了(提交 / 修改上一次提交 / 撤销提交),
   * 以及 `snap.gitConfigRevision` 变。
   *
   * ## 上游的触发是 `dispatcher.refreshAuthor(repository)`
   *
   * `ui/repository-settings/repository-settings.tsx:380-382` 在写完 `user.name` /
   * `user.email` 之后调它 ⇒ `app-store` 重跑 `getAuthorIdentity` 并把新的
   * `commitAuthor` 写进状态 ⇒ 头像浮层换成新身份。我们的仓库设置弹窗与这个组件
   * **没有共同祖先可传回调**,所以那个重读信号走快照上的一个计数器:
   * `GitStore.saveGitConfig` 每次写成功就 `gitConfigRevision + 1`
   * (`store.ts` 的 `Snapshot.gitConfigRevision` 那一段把理由与差异写全了)。
   *
   * ## 计数器的现状(2026-10 本批更新:路由已建)
   *
   * `POST /dsh-git/repo/author-ident`(`git var GIT_AUTHOR_IDENT`)已经存在,本组件的
   * **值**就来自它 —— 也就是说计数器**不再是**「缺路由的替代品」,它现在只剩一件事:
   * **跨组件通知这一次重读**(上游那半由 `dispatcher.refreshAuthor` 承担)。
   * 两条都在:`gitConfigRevision` 触发,`repo/author-ident` 取值。
   *
   * **不挂** `snap` 全量:那会在每次输入摘要时都打一发 host 调用。
   */
  const headSha = snap.status?.headSha ?? '';
  const gitConfigRevision = snap.gitConfigRevision ?? 0;

  useEffect(() => {
    if (path === '') {
      setAuthor(null);
      return;
    }
    let dead = false;
    void (async () => {
      /*
       * ## 数据面:2026-10 起走 `repo/author-ident`(`git var GIT_AUTHOR_IDENT`)
       *
       * 上游这条链是 `app-store.commitAuthor` = `getAuthorIdentity(repository)`
       * (`lib/git/var.ts:20-42`)⇒ 由 `dispatcher.refreshAuthor` 刷新;`commit-message.tsx`
       * 再把它交给 `CommitMessageAvatar`。我们以前**没有**这条路由,于是用四次
       * `config-get`(local+global × name/email)临时拼一个「local 优先、global 兜底」的值 ——
       * 那份拼法与 `git var` **不等价**(上游 `var.ts:5-18` 的注释写明了差别:没配
       * name/email 时 git 自己会造一个 `user@hostname` 身份,而配置读取只会回 `null`;
       * system 级配置与 `GIT_AUTHOR_*` 环境同样只有 `git var` 看得到)。
       * 现在**值**来自路由,拼法不再存在于此。
       *
       * ## 解析用镜像里那一份,不在这里写正则
       *
       * `CommitIdentity.parseIdentity`(`src/core/desktop/models/commit-identity.ts`,
       * 与上游 `models/commit-identity.ts` 逐字)就是上游 `var.ts:38` 用的那个解析器。
       */
      const result = await api.repoAuthorIdent(path);
      if (dead) {
        return;
      }
      if (!result.ok) {
        /*
         * 读失败**不静默**:把码与原句打出来(宿主侧同一次失败已经有过信封,
         * 这里只是不让它在浏览器半消失)。**不**发 toast:这条读在任何一次切仓库 /
         * 提交 / 保存仓库设置后都会跑,一次基础设施抖动变成一串 7 秒通知会淹没真正的失败;
         * 而它的可见后果(头像没有姓名首字母)本身就是症状。
         */
        console.warn('[dsh-git] 读取作者身份失败:', result.error.code, result.error.message);
        setAuthor({ name: '', email: '' });
        return;
      }
      const { ident } = result.value;
      if (ident === null) {
        // 上游 `var.ts:33-35`:`user.useConfigOnly` 且没配 name/email ⇒ `null`。
        // 界面照旧渲染头像(空身份)—— 与改动前「四次配置读取全空」的形态逐字相同,
        // 免得把「git 说没有身份」变成「头像整个消失」。
        setAuthor({ name: '', email: '' });
        return;
      }
      try {
        const parsed = CommitIdentity.parseIdentity(ident);
        setAuthor({ name: parsed.name, email: parsed.email });
      } catch {
        // 上游 `var.ts:37-41` 的 `catch { return null }` —— 解析不了就是「没有身份」。
        setAuthor({ name: '', email: '' });
      }
    })();
    return () => { dead = true; };
  }, [path, headSha, gitConfigRevision]);

  const repository = useMemo(() => {
    const alias = snap.repos.find((entry) => entry.path === path)?.name ?? null;
    // `id` 传 0:上游它是仓库清单里的自增 id,本视图只用 `path`(组件内部
    // `getConfigValue(repository, …)` 也只读 `repository.path`)。
    return path === '' ? null : new Repository(path, 0, null, false, alias);
  }, [path, snap.repos]);

  /*
   * 上游 `commit-message.tsx:796-799` 的 `onUpdateUserEmail`:
   * `await setGlobalConfigValue('user.email', email)` + `onRefreshAuthor()`。
   * 我们用同义的 `config-set`(`scope: 'global'`)写上,再靠上面那个 effect 重读
   * (host 路由没有 `env`/HOME 参数,写的是宿主进程能看到的那个全局配置)。
   * ⚠️ 今天**不可达**(`warningType` 恒 `'none'` ⇒ 「Update Email」按钮不渲染),
   * 所以这条路径**没有真浏览器验收**;写在这里是为了让 prop 面不撒谎。
   *
   * ⚠️ 这个 hook **必须留在下面那个 `if (… ) return null` 之前**:Hook 不能出现在
   * 提前 return 之后(`react-hooks/rules-of-hooks` 会报,而且真的会错位 ——
   * `author === null` 的首帧调用次数会与后续帧不同)。
   */
  const onUpdateEmail = useCallback((email: string): void => {
    void (async () => {
      await api.configSet(path, 'user.email', email, 'global');
      const next = await api.configGet(path, 'user.email', 'global');
      if (next.ok) {
        setAuthor((previous) => (previous === null ? previous : { ...previous, email: next.value.value ?? email }));
      }
    })();
  }, [path]);

  if (repository === null || author === null) {
    return null;
  }

  return (
    <CommitMessageAvatar
      user={getAvatarUserFromAuthor(new CommitIdentity(author.name, author.email, new Date()), null)}
      email={author.email}
      warningType="none"
      branch={snap.status?.branch ?? null}
      isEnterpriseAccount={false}
      accountEmails={[]}
      preferredAccountEmail=""
      repository={repository}
      accounts={[]}
      onUpdateEmail={onUpdateEmail}
      onOpenRepositorySettings={props.onOpenRepositorySettings}
      onOpenGitSettings={props.onOpenGitSettings}
    />
  );
}

/**
 * 「最近一次提交能不能撤销」—— **上游 `sidebar.tsx:359-393` 那三条判据的唯一真源**。
 *
 * 上游(`references/desktop/app/src/ui/changes/sidebar.tsx:359-368`):
 *
 * ```ts
 * const commit = this.props.mostRecentLocalCommit
 * if (commit && commit.tags.length === 0 && this.props.commitToAmend === null) { … }
 * ```
 *
 * 而 `mostRecentLocalCommit` 本身是 `repository.tsx:258-266` 从
 * **`localCommitSHAs`**(= `git log <upstream>..HEAD --not --remotes`,`git-store.ts:608-657`)
 * 的**第一项**取出来的 —— 也就是说它不只是「HEAD 有提交」,而是
 * **「HEAD 是一条还没被 push 的本地提交」**。这一条正是用户报的那条
 * 「已提交 14 小时前」的根因:旧实现的条件只有「`snap.log.length > 0`」,
 * 于是一条**早就推上去的**老提交也会挂着一条「撤销提交」。
 *
 * 四条判据的映射(每条都写清出处,不要凭感觉加条件):
 *
 * | 上游 | 这里 | 说明 |
 * |---|---|---|
 * | `commit != null` | `log.length > 0 && entry.sha === headSha` | 取 `snap.log[0]`;并要求它**就是 HEAD**(`status.headSha`),否则 `log` 与 `status` 不同步时会把旧提交当成 tip |
 * | (隐含)`mostRecentLocalCommit` 是**本地**提交 | `ahead > 0` | `snap.sync.ahead` 是 `git rev-list --count <upstream>..HEAD` 的**个数**(`git-service.ts:310` 取自 `status.ahead`)。`log` 是新→旧排序,所以「未 push 的条数」正好等于**头部 N 条** —— 与 History 侧 `localCommitSHAsFrom`(`history-view.tsx:757-767`)同一口径 |
 * | `commit.tags.length === 0` | 同一表达式 | 上游注释(`sidebar.tsx:361-363`):**有 tag 指向的提交不能撤** —— 撤了提交本身还在(tag 仍指着它),用户会以为没撤掉 |
 * | `commitToAmend === null` | `!form.amend` | 「正在修订上一次提交时,不许再撤销它」。上游的 `commitToAmend` 由 History 右键菜单写入(`app-store.ts:5791`);我们的入口是 `commitForm.amend` |
 * | (无对应判据) | `!status.detached` | **我们比上游严的一处**,理由见下 |
 *
 * **`!status.detached` 是刻意加的一条(不是遗漏)**。上游在 detached HEAD 下
 * `refreshRepository`(`app-store.ts:4360-4373`)的 `tip.kind` 是 `Detached`,
 * 既不是 `Valid` 也不是 `Unborn` ⇒ **`gitStore.loadLocalCommits()` 两条分支都不走**,
 * `_localCommitSHAs` 保留**分离头之前**的那一份(`git-store.ts:134` 初始化成 `[]`,
 * 只有 `loadLocalCommits` 会改它)。于是上游会拿一条**早已不是 HEAD 的**提交去渲染
 * 「Committed …」,点 Undo 时 `git-store.ts:718` 又会拿它的 `parentSHAs[0]` 去
 * `reset --mixed` —— 那是**另一个位置**。我们的宿主路由自己拦了这一刀
 * (`git-service.ts:569-571`:`status.headSha !== sha` ⇒ `bad-request`),
 * 所以这里干脆**不显示**,与宿主的拒绝保持一致(否则用户点下去只会拿到一条报错)。
 *
 * **上游「本地」这一条的边界(如实记)**:`git log --not --remotes` 会把**任何一个**
 * 远端独有的提交也算成「已在远端」。我们只有 `ahead` 这个计数,所以用的是同一个近似 ——
 * 差别只会在「未跟踪的第二个远端」这种情形下出现,且方向是**少显示**(不会误报已推送)。
 *
 * 另外**不要**在这里加「rebase 冲突时不显示」这条 —— 它在上游的**上一级**
 * (`sidebar.tsx:391-397` 的 `renderUndoCommit`),见 `UndoCommitStrip`。
 */
function undoableCommitOf(snap: Snapshot): Commit | null {
  const commit = mostRecentLocalCommitOf(snap);
  if (commit === null) {
    return null;
  }
  if (commit.tags.length !== 0) {
    return null;
  }
  if (snap.commitForm.amend) {
    return null;
  }
  return commit;
}

/**
 * **上游的 `mostRecentLocalCommit`**(`ui/repository.tsx:258-266`):
 *
 * ```ts
 * const mostRecentLocalCommitSHA = localCommitSHAs.length > 0 ? localCommitSHAs[0] : null
 * const mostRecentLocalCommit = mostRecentLocalCommitSHA ? commitLookup.get(...) : null || null
 * ```
 *
 * 而 `localCommitSHAs` = `git log <upstream>..HEAD --not --remotes`(`git-store.ts:608-657`)
 * 的 sha 列表 ⇒ 它就是「HEAD 是一条**还没被 push** 的本地提交」时那一条。
 *
 * ## 为什么要单独抽出来(2026-10-10)
 *
 * 上游有**两个**消费者,它们的前四层判据**完全相同**:
 *  1. 撤销提交条:再用 `tags.length === 0 && commitToAmend === null` 收窄
 *     (`sidebar.tsx:359-368`) ⇒ 就是 {@link undoableCommitOf};
 *  2. 读屏宣告:提交成功后念
 *     `Committed Just now - <summary> (Sha: <shortSha>)`
 *     (`commit-message.tsx:401-412`),**只要** `mostRecentLocalCommit` 换了 sha 就念
 *     —— 它**没有** tag / amend 那两个收窄。
 *
 * 抽出来之前,第 2 条没有落点:照抄一份「HEAD + ahead>0」的判据就是**第二份真源**
 * (两处迟早对「detached / log 不同步 / ahead 口径」给出不同答案)。这里两个消费者
 * 共用一个函数,{@link undoableCommitOf} 只加它自己那两条收窄 —— 语义与改前**逐字相同**。
 *
 * 五条判据的依据见 `undoableCommitOf` 的文件头(detached 那条是本仓**比上游严**的一处,
 * 理由写在那边),它们现在都住在这里。
 * @param snap - 当前快照。
 * @returns 那条提交;`null` = 没有「未 push 的 HEAD」。
 */
function mostRecentLocalCommitOf(snap: Snapshot): Commit | null {
  const entry = snap.log[0];
  const status = snap.status;
  if (entry === undefined || status === null || status.unborn || status.detached) {
    return null;
  }
  if (entry.sha !== status.headSha) {
    return null;
  }
  if ((snap.sync?.ahead ?? 0) <= 0) {
    return null;
  }
  return toCommit(entry);
}

/**
 * Changes 左栏底部那条「Committed <when> · <摘要> · [Undo]」—— **上游组件的薄包装**。
 *
 * ## 为什么是包装,而不是继续手写
 *
 * 2026-10 之前这里是手写的 `div.gw-undo-commit` + `formatWhen(iso)`:
 *
 * ```tsx
 * {snap.log.length > 0 && status?.unborn !== true && !form.amend && (
 *   <div className="gw-undo-commit" …>已提交 {formatWhen(…)}:{…}</div>
 * )}
 * ```
 *
 * 它有三个上游没有的缺陷,全部是「只沿用了可见的一段文字」造成的:
 *
 *  1. **条件错**:`snap.log.length > 0` 对**任何**提交都成立 ⇒ 一条 14 小时前、
 *     早已 push 的提交也会挂着「撤销提交」(用户报的那条)。
 *     上游要的是「HEAD 是**本会话之外也可能存在**的、**还没 push** 的本地提交」,
 *     见 `undoableCommitOf`;
 *  2. **时间不刷新**:`formatWhen` 读一次 `Date.now()` 就定死。上游
 *     `ui/relative-time.tsx:57-89` 的 `RelativeTime` 会按 `getRelativeTimeInfoFromDate`
 *     返回的 `duration` **排下一次 `setTimeout`**(<1 分钟 → 排到整分、<1 小时 → 每分、
 *     <1 天 → 每时、<7 天 → 每 6 小时),并带**绝对日期的 tooltip**;
 *  3. **没有进出动画**:上游 `sidebar.tsx:373-381` 把 `UndoCommit` 包在
 *     `CSSTransition classNames="undo" appear timeout={UndoCommitAnimationTimeout}` 里。
 *
 * ## 上游的三层条件,逐层对齐
 *
 * | 上游 | 出处 | 这里 |
 * |---|---|---|
 * | `rebaseConflictState !== null` → `null` | `sidebar.tsx:391-397` | `isRebaseConflict` |
 * | `commit && tags.length === 0 && commitToAmend === null` | `sidebar.tsx:359-368` | `undoableCommitOf(snap)` |
 * | `disabled = isPushPullFetchInProgress \|\| isCommitting` | `undo-commit.tsx:29-31` | 见下 |
 *
 * ⚠️ **只有 rebase 冲突藏、merge 冲突不藏** —— 上游算的是
 * `isRebaseConflictState(conflictState) ? conflictState : null`(`sidebar.tsx:429-434`),
 * 所以 merge / cherry-pick / revert 冲突期间那条撤销条**照旧显示**。别顺手把它一起藏了。
 *
 * `disabled` 的两个输入在宿主里的对应物:
 *  - `isPushPullFetchInProgress` → `networkActionInProgress(snap)`(`sync-state.ts:178`,
 *    判据是 `snap.progress !== null` —— 把 `commit`/`stage`/`checkout` 排在外面,
 *    与上游 `lib/app-state.ts:597` 同名同义);
 *  - `isCommitting` → `snap.busy === 'commit'`(我们这里 `busy` 是**字符串**,
 *    取值集合见 `store.ts`;上游把它拆成布尔)。
 *
 * ## 动画的 500ms 是怎么来的(两处必须一致)
 *
 * 上游在**两个地方**写 500,注释明确要求它们相等:
 *  - `sidebar.tsx:38-43` 的 `UndoCommitAnimationTimeout = 500`
 *    (注释:「*must* match the duration specified for the `undo` transitions in
 *    `_changes-list.scss`」);
 *  - `styles/_variables.scss:462` 的 `--undo-animation-duration: 500ms`,
 *    被 `_changes-list.scss:244/254` 的 `transition: max-height var(--undo-animation-duration)` 消费。
 *  `desktop-changes.scss` 已经逐字绑了 `--undo-animation-duration: 500ms`
 *  (`desktop-changes.scss:66`)⇒ 这里沿用上游常量 500,两边不会漂。
 *
 * ## tooltip 的前置条件(需要知道,但今天已满足)
 *
 * `UndoCommit` 给的 `tooltip='Undo is disabled while the repository is being updated'`
 * 只有走 `Button`(`ui/lib/button.tsx` → `TooltippedContent` → `Tooltip` 的 portal)时才可见,
 * 而 portal 目标取自 `target.closest('.tooltip-host') ?? document.body`
 * (`ui/lib/tooltip.tsx`)—— Changes 页签的祖先链上有 `workbench.tsx` 的 `.gw-body.tooltip-host`,
 * 所以能拿到 `scss/tooltips.scss` 那一面的样式与变量(见 `workbench.tsx:251-296` 的记录)。
 */
function UndoCommitStrip(props: { snap: Snapshot; onUndo: () => void }): ReactNode {
  const { snap, onUndo } = props;

  // 只有 rebase 冲突才藏(`sidebar.tsx:391-397`)。
  const isRebaseConflict = snap.status?.operation === 'rebase';

  const commit = undoableCommitOf(snap);
  const child =
    !isRebaseConflict && commit !== null ? (
      <CSSTransition classNames="undo" appear={true} timeout={UNDO_COMMIT_ANIMATION_TIMEOUT}>
        <UndoCommit
          commit={commit}
          onUndo={onUndo}
          /*
           * 空 emoji 表 —— `RichText`(`ui/lib/rich-text.tsx`)拿它把 `:smile:` 换成字形或图片。
           * 上游的数据集在**这个 checkout 里是空的**(`references/desktop/gemoji/` 是未初始化的
           * submodule,`docs/goal-port-desktop.md` §1.3 已记),所以拿不到。
           * 后果**只有一条**:提交摘要里的 `:shortcode:` 不会被替换成 emoji(其余文本照常
           * 渲染,token 化本身不受影响 —— 见 `lib/text-token-parser.ts`)。
           * 空表的第二处后果:`sidebar.tsx:144-152` 会每次 receiveProps 重建补全 provider;那条
           * 路径属于提交信息输入框,不在这条链上。
           */
          emoji={NO_EMOJI}
          isPushPullFetchInProgress={networkActionInProgress(snap)}
          isCommitting={snap.busy === 'commit'}
        />
      </CSSTransition>
    ) : null;

  return <TransitionGroup>{child}</TransitionGroup>;
}

/** `ui/changes/sidebar.tsx:43` 的 `UndoCommitAnimationTimeout`,逐字。 */
const UNDO_COMMIT_ANIMATION_TIMEOUT = 500;

/**
 * 空 emoji 表。**必须是模块级常量**:每次渲染新建一个 `Map` 会让
 * `UndoCommit`/`RichText` 的 memo 输入恒变(上游 `ui/lib/rich-text.tsx` 用
 * `memoizeOne` 缓存 token 化结果)。
 */
const NO_EMOJI: Map<string, Emoji> = new Map();

/**
 * 提交区(左栏底部)。
 *
 * 纵向顺序与按钮语义照 GitHub Desktop 的 ui/changes/commit-message.tsx。
 * 三处**沿用**的行为:
 *  1. **单个文件时的占位摘要**(filter-changes-list.tsx:859-883):按状态给出
 *     Create/Delete/Update <文件名>,而且它**真的会作为提交摘要**使用
 *     (summaryOrPlaceholder, commit-message.tsx:587-592)—— 不是纯装饰;
 *  2. **按钮文案**(:1496-1577):提交 N 个文件到 <分支>;Amend 时是
 *     「修改上一次提交」(不带分支与数量);tooltip 里不带数量;
 *  3. **禁用原因链**(:1579-1598):未填摘要 → 「提交前必须填写摘要」;没有可提交文件 →
 *     「请先暂存一个或多个文件」;其余给通用原因。用 aria-disabled 而不是 disabled,
 *     这样禁用时 tooltip 仍然弹得出来(Desktop 的 Button 就是这么做的)。

 *
 * ## 4. **Amend 勾选框已删除**(用户指令,2026-10;一处**有意为之**的删减)
 *
 * 那里原本是本文件手写的一个 `<label class="gw-chk"><input type=checkbox>Amend</label>`,
 * 紧贴在提交按钮**左边**。用户明确要求去掉它。三条事实必须先钉住,免得后来者
 * 把它当成「遗漏了」再补回来:
 *
 *  1. **它不是镜像里的东西。** `src/core/desktop/ui/changes/commit-message.tsx` 与上游
 *     **字节一致**,而**上游没有**任何 amend 勾选框(`grep -rni amend app/src/ui | grep checkbox`
 *     上游零命中)。上游进入修订态的唯一入口是 **History 的提交右键菜单**
 *     「Amend commit」(`ui/history/commit-list.tsx:732,757` ← `ui/repository.tsx:659`
 *     ← `app-store.ts:5791` 的 `prepareToAmendCommit`),进入后提交表单才多出一条
 *     `CommitWarning` 提示条 + 「Stop amending」链接(`ui/changes/commit-message.tsx:1251-1269`),
 *     按钮文案变成「Amend last commit」(`:1496-1503,1567-1577`)。
 *     ⇒ 所以删它**不需要**任何镜像偏离机制:不碰 `src/core/desktop/**`,
 *     `scripts/verify-mirror.mjs` 的 EXPECTED 表**不需要**登记,也不需要
 *     `pref-adapt.ts` 那套「渲染后隐藏」的适配删除表(那张表是为了**不修改镜像**而存在的;
 *     这里没有镜像可保护 —— 要删的就是我们自己的手写控件)。
 *  2. **`form.amend` 这条状态链**保留**(`store.ts` 的 `commit({amend})`)**:它是
 *     `GitStore.commit()` 的真实语义,而且**已有探针在用**
 *     (`docs/probes/sync-progress-force-push-probe.mjs:503` 直接
 *     `store.setCommitField('amend', true)` 验强推表项 P9)。删勾选框 ≠ 删 amend 能力。
 *  3. **副作用(如实记账)**:本项目**没有** History 的「Amend commit」右键菜单,
 *     所以删掉勾选框之后 `form.amend` 在**界面上不可达** ——
 *     `buttonText` 的「修改上一次提交」分支与下面那条 `form.amend` 提示条
 *     (`renderAmendCommitNotice` 的对应物)都成了**只有程序化入口**才走得到的路径。
 *     这不是缺陷,而是「补 History 右键菜单之前」的中间态;真要接时,
 *     路径就是上游那条(`ui/history/commit-list.tsx:757` 的菜单项)。
 *     退役条件:History 那条菜单项接线后,本条注释改写成「已由 History 菜单进入」。
 */

/**
 * **提交选项(齿轮)菜单的项** —— 上游 `ui/changes/commit-message.tsx:1082-1128`
 * 的 `onCommitOptionsButtonClick` 里现拼的那三行。
 *
 * 上游逐字(每一项都是 `type: 'checkbox'`,选中态就是那个提交选项本身):
 *
 * | 上游顺序 | 标签(上游原文) | 出现条件 | `checked` | 动作 |
 * |---|---|---|---|---|
 * | 1 | `Bypass Commit Hooks`(`__DARWIN__`)/ `Bypass Commit hooks`(`:1090`) | **只在** `enableHooksEnvironment()` 为真时 push(`:1084`) | `skipCommitHooks` | `onUpdateCommitOptions(repository, { skipCommitHooks: !… })`(`:1091-1095`) |
 * | 2 | `Add Signed-off-by Trailer` / `Add Signed-off-by trailer`(`:1105`) | **无条件**(`items.push` 直接在条件块外,`:1099`) | `signOffCommits` | 同上换成 `signOffCommits`(`:1106-1110`) |
 * | 3 | `Allow Empty Commit` / `Allow empty commit`(`:1119`) | 只在 `showAllowEmptyCommitOption` 为真时(`:1114`;Changes 页恒真,`filter-changes-list.tsx:1018`) | `allowEmptyCommit` | 同上换成 `allowEmptyCommit`(`:1120-1124`) |
 * | — | (三项全关时齿轮按钮多一个 `.default-options` 类,`:1066-1071`) | — | — | 纯外观 |
 *
 * **三个选项在本插件里仍然都在列**(与改前的内联面板逐项一致:面板三项无条件渲染),
 * 所以上游那两条「出现条件」在这里恒真 —— 这不是漏抄判据,而是我们的能力面本来就有
 * 这三项(`skipCommitHooks`/`signOffCommits` 由 `store.setCommitField` 写进提交载荷,
 * `filter-changes-list.tsx:1018` 的 `showAllowEmptyCommitOption` 在 Changes 页恒真)。
 *
 * **文案**:上游是英文 + `__DARWIN__` 两档,本插件按既有裁决**中文化**
 * (`goal-port-desktop.md` §11.9),并保留上游原文在括号里,便于逐条对照。
 * 这三条标签与改前内联面板里的**逐字相同**(用户看到的文字没变,只是从面板搬进了菜单)。
 *
 * ⚠️ **上游没有 disabled 语义**:三项都是纯 checkbox,任何状态下都可点
 * (`commit-message.tsx:1082-1128` 里 `enabled` 零命中)。所以这里也不造一个
 * `enabled` 判据 —— 那会是我们自己发明的语义。
 */
export function commitOptionsMenuItems(store: GitStore, form: CommitForm): IMenuItem[] {
  return [
    {
      type: 'checkbox',
      checked: form.noVerify,
      label: '绕过提交钩子(Bypass Commit Hooks)',
      action: () => { store.setCommitField('noVerify', !form.noVerify); },
    },
    {
      type: 'checkbox',
      checked: form.signoff,
      label: '追加 Signed-off-by(Auto Signed-off-by Trailer)',
      action: () => { store.setCommitField('signoff', !form.signoff); },
    },
    {
      type: 'checkbox',
      checked: form.allowEmpty,
      label: '允许空提交(Allow Empty Commit)',
      action: () => { store.setCommitField('allowEmpty', !form.allowEmpty); },
    },
  ];
}

/**
 * 打开齿轮菜单。上游 `onCommitOptionsButtonClick`(`:1079-1128`)的第一句是
 * `e.preventDefault()`,然后 `showContextualMenu(items)`。
 *
 * @returns 菜单关闭后 resolve(与上游 `showContextualMenu` 同形)。
 */
export async function showCommitOptionsMenu(store: GitStore, form: CommitForm): Promise<void> {
  installContextMenuHost();
  await showContextualMenu(commitOptionsMenuItems(store, form));
}

/*
 * `modelButtonText` 的**真源**搬到了 `model-select.tsx`(下拉控件自己的模块),
 * 这里**转发导出**一次:老的消费方与他人写好的探针 import 路径不变(先做,不删)。
 */
export { modelButtonText };

/**
 * **已被下拉控件取代**的菜单形态:把模型清单做成**右键菜单**的项列表。
 *
 * ⚠️ **产品里现在 0 个调用点** —— 2026-10-07 用户当场指出那个形态的缺陷:
 * 「模型选择器的右键菜单的列表太长,**无法上下滚动**」(菜单宿主是给短菜单写的,
 * 没有 `max-height`/滚动容器)。现在产品走 `model-select.tsx` 的 `ModelSelect`
 * (按钮 + 可滚动 `role="listbox"`,max-height + overflow-y:auto,按空间向上/向下弹)。
 *
 * 保留它的理由(「先做,不删」):它把「项文案 = `name · providerName`、provider 在末尾、
 * 当前项 `checked`」这三条钉成一个**纯函数**,无渲染读数比渲染整棵树便宜。
 * **退役条件**:确认不再需要这个形态(或探针改读 `ModelSelect` 的项)之后,
 * 连同 `showModelMenu` 一起删。
 * @param store - store(选中一项就写偏好)。
 * @param models - 宿主可用模型清单。
 * @param model - 当前 `provider/id`。
 */
export function modelMenuItems(
  store: GitStore,
  models: readonly { provider: string; providerName: string; id: string; name: string }[],
  model: string,
): IMenuItem[] {
  return models.map((entry) => ({
    type: 'checkbox' as const,
    checked: `${entry.provider}/${entry.id}` === model,
    label: `${entry.name} · ${entry.providerName}`,
    action: () => { void store.setModelPersisted(`${entry.provider}/${entry.id}`); },
  }));
}

/**
 * 打开模型菜单。写的是**同一个偏好**(`store.setModelPersisted` → `api.setPrefs({model})`),
 * 也就是设置页「默认模型」那个下拉的同一个键 —— 不新增第二份偏好存储。
 * @param store - store。
 * @param models - 宿主可用模型清单。
 * @param model - 当前 `provider/id`。
 * @returns 菜单关闭后 resolve。
 */
export async function showModelMenu(
  store: GitStore,
  models: readonly { provider: string; providerName: string; id: string; name: string }[],
  model: string,
): Promise<void> {
  installContextMenuHost();
  await showContextualMenu(modelMenuItems(store, models, model));
}

function CommitBox(props: {
  store: GitStore;
  snap: Snapshot;
  /**
   * 打开**我们自己的**偏好设置弹窗(**Git 页**)。
   *
   * 上游这条链是 `commit-message.tsx:809-814` 的
   * `onShowPopup({ type: PopupType.Preferences, initialSelectedTab: PreferencesTab.Git })`。
   * 2026-10 已接通:`workbench.tsx` 传 `openGitSettings` = `openPreferencesAt('git')`,
   * 而那个 `initialSelectedTab` 由弹窗自己的 `useState` 当**初值**读(见
   * `preferences-dialog.tsx` 的 prop JSDoc 与 `docs/probes/preferences-modal-probe.mjs`)。
   *
   * 仍然可选:缺它时 `openGitSettings` 给一条点名缺口的 toast(不是静默 no-op、
   * 也不把按钮藏起来),文案见 `commit-avatar-notices.ts` 的
   * `GIT_SETTINGS_ENTRY_NOT_WIRED`(产品路径已不可达,只服务直接挂载的探针)。
   */
  onOpenPreferences?: () => void;
  /**
   * 打开**仓库设置**弹窗(Git 配置页)—— 2026-10 接通,落点在 `workbench.tsx`。
   * 与上游 `commit-message.tsx:801-807` 同义;缺它时那两处链接给一条点名缺口的
   * toast(`REPOSITORY_SETTINGS_UNAVAILABLE`),不是静默 no-op。
   */
  onOpenRepositorySettings?: () => void;
  /**
   * 上游 `commit-message.tsx:197` 的 `showPromptForCommittingFileHiddenByFilter`
   * (由 `filter-changes-list.tsx:943-951` 算出:偏好 **且** 谓词为真)。
   * 本组件只**读**它 —— 判定留在页那一层,因为 `filteredItems` / `fileListFilter`
   * 都在那边(与上游同一分工)。
   */
  showPromptForCommittingFileHiddenByFilter: boolean;
  /**
   * 上游 `commit-message.tsx:201` 的 `onFilesToCommitNotVisible?`。提交按钮点下去时,
   * 若上面那条为真,就把「真的提交」这个闭包交上去(`commit-message.tsx:626-637`),
   * 由弹窗的持有者(页那一层)决定什么时候调它。
   */
  onFilesToCommitNotVisible: (onCommitAnyway: () => void) => void;
  /**
   * 上游 `ui/changes/sidebar.tsx:170-180` 那个
   * `showPopup({type: PopupType.OversizedFiles, oversizedFiles, context, repository})`。
   *
   * 载荷的**三件**都在这一层算好(它们是这一层的:纳入文件、`summaryOrPlaceholder`
   * 组成的 `commitContext`、以及那个 `Repository`)—— 与上游
   * `commit-message.tsx` 造 `commitContext` 再交给 `onCreateCommit` 的分工一致。
   * 持有者(页那一层)只负责渲染镜像 `OversizedFiles`(裁决 B:没有 popup 宿主)。
   */
  onOversizedFiles: (payload: {
    readonly oversizedFiles: ReadonlyArray<string>;
    readonly context: ICommitContext;
    readonly repository: Repository;
  }) => void;
}): ReactNode {
  /*
   * `onOpenPreferences` 在这里**解构出来**(而不是在回调里写 `props.onOpenPreferences`):
   * `react-hooks/exhaustive-deps` 对「依赖数组里写 `props.x`、回调里读 `props.y`」
   * 一律要求把整个 `props` 放进依赖,而 `props` 每次渲染都是新对象 ⇒ 回调恒变,
   * `useCallback` 也就白写了。解构之后依赖是**具体的那个函数**。
   */
  const {
    store, snap, onOpenPreferences, onOpenRepositorySettings,
    showPromptForCommittingFileHiddenByFilter, onFilesToCommitNotVisible, onOversizedFiles,
  } = props;
  const form = snap.commitForm;
  const status = snap.status;
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [confirmGenerate, setConfirmGenerate] = useState(false);
  const [confirmUndo, setConfirmUndo] = useState(false);
  /**
   * **读屏宣告的当前文本** —— 上游 `commit-message.tsx:258` 的
   * `isCommittingStatusMessage`(`:318` 初值 `''`、`:1848-1850` 渲染成
   * `<span className="sr-only" aria-live="polite" aria-atomic="true">`)。
   *
   * 空串是**有含义的初态**:上游那条 setter 在 `:397-402` 明确要求
   * `this.state.isCommittingStatusMessage === ''` 才写第一次 ⇒ 同一个提交里
   * 「开始」只宣告一次;之后由「最近一次本地提交的 sha 变了」(`:404-412`)覆盖成结果句。
   */
  const [isCommittingStatusMessage, setCommittingStatusMessage] = useState('');

  // 提交的是**纳入提交的文件**(客户端模型),不是「索引里有什么」。
  const includedFiles = (status?.files ?? []).filter(
    (f) => includeStateOf(snap.includeState[f.path]) !== 'none',
  );
  const stagedCount = includedFiles.length;
  /**
   * **上游 `prepopulateCommitSummary`**(`filter-changes-list.tsx:935-936`):
   * 纳入提交的文件**恰好 1 个** ⇒ 摘要可以是空的,提交时改用**占位摘要**。
   *
   * 这是用户报的那条的直接原因(「只勾选一个文件的情况下,commit msg 可以留空,
   * 提交按钮仍然可以点击」):上游确实如此,而且它由**一条**规则管住三处 ——
   * 输入框的 placeholder、按钮的 enablement、以及**提交载荷里的标题**。
   */
  const prepopulateSummary = prepopulateCommitSummaryOf(includedFiles);
  const placeholder = commitPlaceholderOf(includedFiles);
  /**
   * **真正会被提交的那条摘要** —— 上游 `commit-message.tsx:587-592` 的
   * `summaryOrPlaceholder`。注意 `!summary` 是**空串**判定:全空白的摘要
   * (`'   '`)**不**被占位取代 ⇒ 它仍然是「空白摘要」⇒ 按钮禁用。
   */
  const summaryOrPlaceholder = summaryOrPlaceholderOf(form.summary, includedFiles);
  const summaryBlank = isEmptyOrWhitespace(summaryOrPlaceholder);
  const hasPreviousCommit = snap.log.length > 0 && status?.unborn !== true;
  /**
   * ⚠️ 上游的闸门是 **`isCommitting`**(`commit-message.tsx:1605`),
   * 由 `AppStore.withIsCommitting` 只在**提交**期间写真值(`app-store.ts:5395-5410`)。
   * 我们以前用的是 `snap.busy !== ''` —— 那是**所有**后台操作的总线(fetch/pull/push/
   * checkout/stage…),会把提交按钮在抓取期间也禁掉,而上游那时是**可以提交**的。
   * 判据:`docs/probes/commit-form-parity-probe.mjs` 的 R15(busy=commit ⇒ 禁)与
   * R16(busy=fetch ⇒ **可点**)。
   */
  const isCommitting = snap.busy === 'commit';
  /**
   * **rebase 进行中**。上游此时**整个提交表单都不渲染** ——
   * `filter-changes-list.tsx:905-920`:`if (rebaseConflictState !== null) return <ContinueRebase …/>`
   * ⇒ 按钮**不存在**。我们**还没有**移植 `ContinueRebase`(`docs/goal-port-desktop.md`
   * §1.2 E.8 已登记为未迁移面),所以退而求其次:**把它对提交按钮的后果照做** ——
   * 按钮禁用 + 说清原因。**残留缺口(明确记账)**:ContinueRebase 那套 UI 本身仍然是
   * 缺失的功能面,归那条移植线,不在本文件里伪造。
   *
   * ⚠️ **只对 rebase** —— merge 冲突解决之后就是要用一次提交来收尾,上游同样只对
   * rebase 换表单(`sidebar.tsx:391-397` 的 `isRebaseConflictState` 判据)。
   * 判据:探针的 R17(rebase ⇒ 禁)/ R18(merge ⇒ 可点)。
   */
  const isRebaseInProgress = status?.operation === 'rebase';
  /**
   * 撤销提交条要显示的那条提交(`null` = **整条不渲染**)。判据见
   * `undoableCommitOf` 的文件头 —— 这里只做取值,不重复判。
   */
  const undoCommit = undoableCommitOf(snap);
  /**
   * 点 Undo 之后的**确认条件** —— 逐字对着上游 `app-store.ts:5830-5843`:
   *
   * ```ts
   * // Warn the user if there are changes in the working directory
   * // This warning can be disabled, except when the user tries to undo a merge commit.
   * if (showConfirmationDialog &&
   *     ((this.confirmUndoCommit && !isWorkingDirectoryClean) || commit.isMergeCommit)) { …弹出… }
   * ```
   *
   * 三点必须说清:
   *  1. 上游**不是每次都弹框**。`showConfirmationDialog` 的默认值是 `true`
   *     (`dispatcher.ts:951-955`),`confirmUndoCommit` 的默认值也是 `true`
   *     (`app-store.ts:495`)⇒ 判据化简成「**工作区脏 OR 是合并提交**」才弹。
   *     工作区干净、又不是合并提交时,上游**直接撤**,没有中间那一步。
   *  2. `confirmUndoCommit` 这条偏好我们**没有**(`grep confirmUndoCommit src/client` = 0 命中,
   *     上游的开关在 Preferences ▸ Prompts,`ui/preferences/prompts.tsx:298-302`),
   *     所以按上游默认值 `true` 处理。等 Prompts 页接线时把这一条换成真偏好。
   *  3. `isMergeCommit` 在**关掉确认偏好时也仍然弹** —— 上游注释写死了这一条
   *     (撤合并提交会丢掉一整条父线,破坏性远大于普通提交)。所以它**不能**被
   *     第 2 点那个默认值带走:那是 `||`,不是 `&&`。
   */
  const requestUndo = () => {
    if (undoCommit === null) { return; }
    const isWorkingDirectoryClean = (status?.files.length ?? 0) === 0;
    if (isWorkingDirectoryClean && !undoCommit.isMergeCommit) {
      void store.undoCommit(undoCommit.sha);
      return;
    }
    setConfirmUndo(true);
  };
  const branch = status === null || status.detached || status.unborn ? '' : status.branch;

  /**
   * 按钮的 enablement —— **逐项**对着上游 `ui/changes/commit-message.tsx:1600-1607`:
   *
   * ```ts
   * const buttonEnabled =
   *   (this.canCommit() || this.canAmend()) &&
   *   !isCommitting &&
   *   !isSummaryBlank &&
   *   !isGeneratingCommitMessage
   * ```
   *
   * 右边四项的来源(同一文件):
   *  · `:652-659` `canCommit()` = `(((anyFilesSelected || allowEmptyCommit) && summary.length > 0) || prepopulateCommitSummary)`(&& `!hasRepoRuleFailure()`);
   *  · `:662-669` `canAmend()` = `commitToAmend !== null && (summary.length > 0 || prepopulateCommitSummary)`;
   *  · `:1602` `isSummaryBlank` = `isEmptyOrWhitespace(summaryOrPlaceholder)`;
   *  · `:1607` `!isGeneratingCommitMessage`。
   *
   * ⚠️ **注意 `summary.length > 0` 用的是「用户输入的原始摘要」,而 `isSummaryBlank`
   * 用的是 `summaryOrPlaceholder`** —— 上游两处故意的不同:单文件时前者可以是空
   * (靠 `prepopulateCommitSummary` 那一支兜住),后者被占位摘要填成非空。
   *
   * 三处上游**没有**的项(逐条记账,不装作没有):
   *  1. `!(form.amend && !hasPreviousCommit)`:上游的修订态是 `commitToAmend !== null`,
   *     它**不可能**在没有 HEAD 时为真(只能从 History 右键菜单进,
   *     `app-store.ts:5760-5800`);我们的 `form.amend` 是可以被程序化置真的布尔 ⇒
   *     补一条**只会更严**的表征兜底(判据:探针的 R19/R20/R21 覆盖 amend 三档);
   *  2. `!isRebaseInProgress`:上游那一条挂在**父组件**上(整表单换成 `ContinueRebase`),
   *     见上面 `isRebaseInProgress` 的注释;
   *  3. repo rules(上游 `:658,667` 的 `!hasRepoRuleFailure()`)我们**没有**移植
   *     (`repoRulesEnabled` 恒 false,`hasRepoRuleFailure()` 恒 false)⇒ 与上游未启用
   *     repo rules 时逐字等价。
   */
  const canCommitByFiles =
    ((stagedCount > 0 || form.allowEmpty) && form.summary.length > 0) || prepopulateSummary;
  const canAmendNow =
    form.amend && hasPreviousCommit && (form.summary.length > 0 || prepopulateSummary);
  const canCommit = (canCommitByFiles || canAmendNow)
    && !isCommitting
    && !summaryBlank
    && !form.generating
    && !isRebaseInProgress
    && !(form.amend && !hasPreviousCommit);

  /**
   * 禁用理由 —— 顺序对着上游 `getButtonTooltip`(`commit-message.tsx:1579-1598`):
   * 摘要空白 → 没有可提交文件 → 正在提交;其余给按钮标题。**文案本地化**(goal §11.9),
   * 上游原文留在注释里。
   *
   * `生成中` 与 `变基中` 两条的出处:上游 `:1610-1613` 用 `generatingCommitDetailsMessage`
   * 直接顶掉 tooltip(`Generating commit details…`),而变基中上游根本渲染不出这个按钮
   * ⇒ 这一条是我们**多**出来的(它只解释「为什么点不了」,不改变 enablement)。
   */
  const disabledReason = (() => {
    if (form.generating) { return '正在生成提交信息…'; }
    if (isRebaseInProgress) { return '正在变基:先完成或中止变基再提交(上游此时整表单换成 ContinueRebase)'; }
    if (summaryBlank) { return '提交前必须填写摘要'; }
    if (stagedCount === 0 && (status?.files.length ?? 0) > 0 && !form.allowEmpty) {
      return '请先勾选一个或多个文件';
    }
    if (isCommitting) { return '正在提交…'; }
    if (form.amend && !hasPreviousCommit) { return '还没有上一次提交,无法修改提交'; }
    return branch === '' ? '提交' : `提交到 ${branch}`;
  })();

  const buttonText = form.amend
    ? (isCommitting ? '正在修改…' : '修改上一次提交')
    : `${isCommitting ? '正在提交' : '提交'}${stagedCount > 0 ? ` ${stagedCount} 个文件` : ''}${branch === '' ? '' : `到 ${branch}`}`;
  // 按钮文案照 Desktop(`commit-message.tsx:1496-1577`):「提交 N 个文件到 <分支>」。

  /*
   * 「正在生成」这件事**上游不是用一条通知说的,而是长在提交按钮自己身上** ——
   * 逐字对着 `ui/changes/commit-message.tsx:1601-1629` 的 renderSubmitButton():
   *
   *   const loading = isCommitting || isGeneratingCommitMessage ? <Loading /> : undefined
   *   const generatingCommitDetailsMessage = isGeneratingCommitMessage
   *     ? 'Generating commit details…' : null
   *   const commitButton = generatingCommitDetailsMessage ?? this.getButtonText()
   *
   * 三件事一起发生:文案被「Generating commit details…」**顶掉**、按钮里多一个转圈图标
   * (`ui/lib/loading.tsx:4-9` = `<Octicon className="spin" symbol={syncClockwise} />`,
   * `.spin` 的配方在 `ui/toolbar/_toolbar.scss:80-82`)、并且被 `disabled`
   * (`:1606-1609` 的 buttonEnabled 里含 `!isGeneratingCommitMessage`)。
   *
   * ⇒ 这正是用户报的那条「生成后的通知挡住提交按钮」的**上游答案**:进度就地长在
   * **用户正在看的那个按钮**上,不需要往界面上盖任何东西。本轮通知那半边按上游的
   * toast 形状改了(见 `styles.ts` 的 toast 段);这半边把按钮补成上游的样子。
   *
   * 三处**有意偏离**(都在我们这层,上游文件一个字没改):
   *  1. 文案**本地化**(仓库既有约定,例如上面 buttonText 的中文与
   *     `disabledReason` 的「正在生成提交信息…」);上游原文逐字留在本注释里。
   *  2. 转圈图标用 `name="sync"`(`icons.ts` 的 `SYMBOLS.sync` = `octicons.sync`)+
   *     我们已有的 `.gw-spin`(styles.ts,与上游同为 `rotate(360deg)`)。
   *     上游 `Loading` 用的是 `syncClockwise`,而 `icons.ts` 的 `SYMBOLS` 表里
   *     **没有**这个键(它只在那个文件的头部注释里被提过一次,import 进来的值没人用)
   *     —— 那是图标表既有的边界,不在这里新增符号(否则就是绕过那份表的真源)。
   *  3. 只在 `form.generating` 时加,不跟 `busy`:上游这里是 `isCommitting ||
   *     isGeneratingCommitMessage`,而我们的 `busy` 是**所有**后台操作的总线
   *     (fetch/push/clone…),把转圈挂在它上面会在拉取时也转;`buttonText` 里
   *     busy 的那半边是既有行为,本轮不动。
   */
  const generatingLabel = form.generating ? '正在生成提交详情…' : null;
  const commitButtonText = generatingLabel ?? buttonText;

  /*
   * ===========================================================================
   * **提交状态的读屏宣告**(2026-10-10)—— 上游 `ui/changes/commit-message.tsx`
   * ===========================================================================
   *
   * ## 上游那两条转换(逐字)
   *
   * ```ts
   * // componentDidUpdate
   * if (prevProps.isCommitting !== this.props.isCommitting &&
   *     this.props.isCommitting &&
   *     this.state.isCommittingStatusMessage === '') {
   *   this.setState({ isCommittingStatusMessage: this.getButtonTitle() })
   * }
   * if (prevProps.mostRecentLocalCommit?.sha !== this.props.mostRecentLocalCommit?.sha &&
   *     this.props.mostRecentLocalCommit !== null) {
   *   this.setState({ isCommittingStatusMessage:
   *     `Committed Just now - ${mostRecentLocalCommit.summary} (Sha: ${mostRecentLocalCommit.shortSha})` })
   * }
   * ```
   *
   * 而 `getButtonTitle()` 在提交进行中是 `` `${getButtonVerb()} to ${branch}` ``
   * (`:1493-1552`,amend 那一档是 `Amending last commit`)。
   *
   * ## 这里的移植方式(以及两处**如实**说明)
   *
   *  · 用 `useRef` 记住「上一次的值」而不是 `componentDidUpdate`;**首次渲染不比**
   *    (`previous === null` 那一支直接跳过)—— 这正是 `componentDidUpdate` 的语义
   *    (挂载时不跑),否则页面一打开就会把「上一条本地提交」念一遍;
   *  · 文案**中文化**(仓库既有裁决,goal §11.9;上游英文原文逐字留在上面);
   *  · `prevProps` 里**没有** `isCommittingStatusMessage`,只有 `props` 两个字段;
   *    这里读的是**当前** state,与上游那一句同义(它读的也是 `this.state`)。
   *
   * ⚠️ **没有 `hookProgress` 那一半**:上游同一个 `componentDidUpdate` 旁边还有
   * `renderCommitProgress()`(`:1699-1731`,钩子进度条 + 「Show commit progress」按钮),
   * 它要 `props.hookProgress`(`HookProgress`:hookName + started/finished/failed)与
   * `props.onShowCommitProgress`(打开 `PopupType.CommitProgress` 终端)。本仓**两者都没有生产者**
   * (宿主提交走 `git-service.ts` 的 argv,从不解析钩子生命周期;也没有终端输出流通道)
   * ⇒ 不伪造,读数与缺口写在 `docs/probes/changes-oversized-warning-probe.mjs` 的 H 组。
   */
  const committingStatusTitle = form.amend
    ? '正在修改上一次提交'
    : (branch === '' ? '正在提交' : `正在提交到 ${branch}`);
  /**
   * 「最近一次**本地**(未 push 的)提交」—— 与撤销提交条**同一份判据**
   * ({@link mostRecentLocalCommitOf};上游也是同一个 prop:`mostRecentLocalCommit`)。
   */
  const mostRecentLocalCommit = mostRecentLocalCommitOf(snap);
  const previousCommittingRef = useRef<boolean | null>(null);
  const previousMostRecentShaRef = useRef<string | null>(null);
  useEffect(() => {
    const previousCommitting = previousCommittingRef.current;
    const previousSha = previousMostRecentShaRef.current;
    const sha = mostRecentLocalCommit === null ? null : mostRecentLocalCommit.sha;
    if (previousCommitting !== null) {
      if (previousCommitting !== isCommitting && isCommitting && isCommittingStatusMessage === '') {
        setCommittingStatusMessage(committingStatusTitle);
      }
      if (previousSha !== sha && mostRecentLocalCommit !== null) {
        setCommittingStatusMessage(
          `刚刚提交 - ${mostRecentLocalCommit.summary}(Sha: ${mostRecentLocalCommit.shortSha})`,
        );
      }
    }
    previousCommittingRef.current = isCommitting;
    previousMostRecentShaRef.current = sha;
    /*
     * 依赖数组**就是那两条转换的判据**(上游 `componentDidUpdate` 每次更新都跑,但那两条
     * `if` 只在这几个值变化时才可能成立):
     *  · `isCommitting` ⇒ 第一态(「正在提交到 …」);
     *  · `mostRecentLocalCommit` ⇒ 第二态(「刚刚提交 - …」);
     *  · 另外两个进依赖是**收敛所需**:写完第一态后本效果会再跑一次,而那时
     *    `previousCommitting === isCommitting`、`previousSha === sha` ⇒ 一次 setState
     *    都不会发生(不是无限链;`react-hooks/exhaustive-deps` 那条警告要的正是这份声明)。
     */
  }, [isCommitting, mostRecentLocalCommit, isCommittingStatusMessage, committingStatusTitle]);

  /*
   * `snap.current` **先取出来当局部量**再进依赖数组:`react-hooks/exhaustive-deps`
   * 不接受 `snap.current` 这种「可变值的属性」当依赖(它会说那不是一个能触发重渲的依赖)。
   * 语义不变:`snap` 是不可变快照,`current` 就是一个字符串。
   *
   * ⚠️ 2026-10-10:这一块从下面(rebase 分支之上)**搬到了** `onSubmitCommit` 之上 ——
   * 超大文件闸门需要它,而闸门是提交动作的一部分。搬家**不改行为**(hook 顺序在每次
   * 渲染里都一致;下面那条 rebase 提前 return 读的还是同一个 `repository`)。
   */
  const repoPath = snap.current;
  const repository = useMemo(() => {
    const alias = snap.repos.find((entry) => entry.path === repoPath)?.name ?? null;
    // `id` 传 0:与 `CommitAuthorAvatar` 同一处置(本视图只用 `path`)。
    return repoPath === '' ? null : new Repository(repoPath, 0, null, false, alias);
  }, [repoPath, snap.repos]);
  /**
   * 这一帧的 `WorkingDirectoryStatus` —— 上游 `lib/large-files.ts` 的**入参类型**
   * (`ui/changes/sidebar.tsx:162` 传的是 `this.props.changes.workingDirectory`)。
   *
   * 与 rebase 分支**同一份构造**(`changesRowItemsOf` + `WorkingDirectoryStatus.fromFiles`):
   * 那是本仓把「porcelain 行 → 镜像 `WorkingDirectoryFileChange`」收敛成一处的地方
   * (`changes-file-list.tsx:210`),这里的纳入状态也走同一份 `includeStateOf`。
   * 不做第二份映射 —— 那正是「镜像函数读到与我们列表不同的选择」这类静默缺陷的温床。
   */
  const workingDirectory = useMemo(() => WorkingDirectoryStatus.fromFiles(
    changesRowItemsOf(
      status?.files ?? [],
      (file) => includeStateOf(snap.includeState[file.path]),
    ).map((row) => row.change),
  ), [status?.files, snap.includeState]);
  /**
   * 这一帧的 `ICommitContext` —— 上游 `commit-message.tsx:614-626` 造的那个
   * `commitContext`,也是 `PopupType.OversizedFiles` 载荷里的 `context`
   * (`ui/changes/sidebar.tsx:176`)。
   *
   * 三处**如实**说明:
   *  1. `trailers`:上游是 `this.getCoAuthorTrailers()`(`commit-message.tsx:577-585`),
   *     这里用**同一个投影函数本人**(`store.ts` 的 `getCoAuthorTrailers`,逐字抄的那 9 行)。
   *     第二个实参就是上游那条闸门 `isCoAuthorInputEnabled`
   *     (`commit-message.tsx:815-817`:`repository.gitHubRepository !== null`)——
   *     **不写死 `true`**:非 GitHub 仓库里共同作者一个都不进 commit message,这是上游语义。
   *     ⚠️ 2026-10-10 **仍然只说一半**:`store.commit()` 的载荷里**没有** `trailers`
   *     字段、宿主 `commit` 路由也不收它(见 `getCoAuthorTrailers` 的 JSDoc)⇒
   *     这个数组今天是**签名的一部分 + 探针读数**,不是「提交里真的有那一行」。
   *  2. 不传可选的 `messageGeneratedByCopilot`:我们的 `form.generatedBy` 是
   *     **provider/模型名**(字符串),与上游那个「是不是 Copilot 生成的」布尔不是同一件事,
   *     硬映射会造出一个错的语义;
   *  3. 这个 context 目前**只被搬运**:`OversizedFiles` 把它原样交给
   *     `dispatcher.commitIncludedChanges(repository, context)`,而我们的门面就是
   *     `store.commit()`(它自己从 `commitForm` 取摘要/描述)。之所以照样逐字段填好,
   *     是因为它是**签名的一部分** —— 填一个空对象会让下一个接线的人读到假信息。
   */
  const commitContext: ICommitContext = useMemo(() => ({
    summary: summaryOrPlaceholder,
    description: form.description === '' ? null : form.description,
    trailers: [...getCoAuthorTrailers(
      snap.coAuthors,
      repository !== null && repository.gitHubRepository !== null,
    )],
    amend: form.amend,
  }), [summaryOrPlaceholder, form.description, form.amend, snap.coAuthors, repository]);

  /**
   * 提交按钮 / `Cmd(Ctrl)+Enter` 的**唯一**入口 —— 逐条对着上游
   * `commit-message.tsx:573-575`(`onSubmit = () => this.createCommit()`)与
   * `:626-637` 的那道闸门:
   *
   * ```ts
   * if (options?.warnFilesNotVisible !== false &&
   *     this.props.showPromptForCommittingFileHiddenByFilter === true &&
   *     this.props.onFilesToCommitNotVisible) {
   *   this.props.onFilesToCommitNotVisible(() =>
   *     this.createCommit({ …, warnFilesNotVisible: false }))
   *   return
   * }
   * ```
   *
   * 两条输入**都**走这里:上游 `onKeyDown`(`:713-722`)调的也是 `this.createCommit()`
   * —— 键盘快捷键**同样**会被那道闸门拦下(不是「只有点按钮才问」)。
   *
   * ---------------------------------------------------------------------------
   * **超大文件闸门(2026-10-10 接线)** —— 上游 `ui/changes/sidebar.tsx:159-183`
   * ---------------------------------------------------------------------------
   *
   * 顺序与上游**逐字一样**:筛选隐藏那条闸门在 `commit-message.tsx` 里、
   * **先于** `onCreateCommit`;而超大文件闸门是 `onCreateCommit` 的**第一件事**
   * (`sidebar.tsx:161-181`),冲突文件那条排在它**后面**。所以:
   *
   * ```ts
   * const overSizedFiles = await getLargeFilePaths(repository, workingDirectory)
   * const filesIgnoredByLFS = await filesNotTrackedByLFS(repository, overSizedFiles)
   * if (filesIgnoredByLFS.length !== 0) { showPopup({type: OversizedFiles, …}); return false }
   * ```
   *
   * 本插件里这两跳的落点:
   *  · `getLargeFilePaths` = **镜像那一份本人**(`src/core/desktop/lib/large-files.ts`,
   *    逐字,100 MiB 阈值在它里面),它 `import { stat } from 'fs/promises'` ⇒ esbuild 的
   *    alias 把它接到 `src/client/shim-node-fs-promises.ts` 的注入点,宿主实现是
   *    `src/client/history-view.tsx` 装的 `IFsPromisesHost.stat`(走 `file-size` 路由);
   *  · `filesNotTrackedByLFS` = 宿主 `lfs/untracked` 路由(宿主侧**逐字复用**镜像
   *    `src/host/mirror/lib/git/lfs.ts:107`)—— 客户端**没有**这一份镜像
   *    (`src/core/desktop/lib/git/lfs.ts` 不在树里),所以它只能由宿主提供。
   *
   * **失败语义(明确决定,不是漏做)**:`lfs/untracked` 不可用(`unsupported: true`,
   * 例如刷新了页面但宿主还是旧构建)时**不把空名单当成「都被 LFS 覆盖」**,而是给一条
   * 点名缺口的 toast 并**照常提交** —— 这条闸门在上游本身也只是「拦住 + 让你 Commit Anyway」,
   * 不是硬门;把用户永久堵在提交按钮前面才是更坏的行为。
   */
  const createCommitGate = useCallback(async (): Promise<void> => {
    if (repository !== null) {
      const overSizedFiles = await getLargeFilePaths(repository, workingDirectory);
      if (overSizedFiles.length > 0) {
        const lfs = await api.lfsUntracked(repository.path, overSizedFiles);
        if (!lfs.ok) {
          store.toast(`${OVERSIZED_LFS_UNCHECKED}\n${lfs.error.message}`, 'err');
        } else if (lfs.value.unsupported) {
          store.toast(OVERSIZED_LFS_UNCHECKED, 'err');
        } else if (lfs.value.untracked.length > 0) {
          onOversizedFiles({
            oversizedFiles: lfs.value.untracked,
            context: commitContext,
            repository,
          });
          return;
        }
      }
    }
    await store.commit();
  }, [repository, workingDirectory, commitContext, onOversizedFiles, store]);

  const onSubmitCommit = useCallback((): void => {
    if (!canCommit) { return; }
    if (showPromptForCommittingFileHiddenByFilter) {
      onFilesToCommitNotVisible(() => { void createCommitGate(); });
      return;
    }
    void createCommitGate();
  }, [canCommit, showPromptForCommittingFileHiddenByFilter, onFilesToCommitNotVisible, createCommitGate]);

  const onKey = (event: React.KeyboardEvent): void => {
    // Cmd/Ctrl+Enter 提交(照 commit-message.tsx:693-726;上游走同一个 onSubmit)
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && canCommit) {
      event.preventDefault();
      onSubmitCommit();
    }
  };

  /*
   * 浮层两个回调 —— 逐条对着上游 `ui/changes/commit-message.tsx:801-814` 写。
   *
   * ## `onOpenGitSettings`(2026-10 **已接线**)
   *
   * 上游 `:809-814` 派发 `PopupType.Preferences` + `PreferencesTab.Git` ⇒ 我们打开
   * 自己的偏好设置弹窗并**预选 Git 页**(`workbench.tsx` 的 `openGitSettings`
   * ⇒ `openPreferencesAt('git')`,绑定关系在那边一处可见)。没接上 prop 时说实话 ——
   * 那条兜底今天只在「直接挂本组件、没传 prop」的探针路径上可达。
   *
   * ## `onOpenRepositorySettings`(**刻意仍然是一条 toast** —— 这是决定,不是漏做)
   *
   * 上游 `:801-807` 派发 `PopupType.RepositorySettings` +
   * `RepositorySettingsTab.GitConfig`,即**仓库设置弹窗的 Git Config 页**;上游那一支
   * 有 4 个页签(`ui/repository-settings/repository-settings.tsx` 的
   * `Remote / IgnoredFiles / GitConfig / ForkSettings`),而且 GitConfig 页**自己**
   * 带 local / global 两个作用域(`git-config.tsx`),因为它改的是**这个仓库的** git 配置。
   *
   * **我们没有任何一页能承接它**,所以这里保持 toast 而不是「随便跳一页」:
   *   - `ui/repository-settings/**` 在目标文档 §1.3 是**明确排除**的范围(6 个文件);
   *   - 偏好设置弹窗的 `git` 页**不是它的替身**:那一页按上游
   *     `preferences.tsx:277-278` / `:1041/:1046` 读写的是**全局** gitconfig
   *     (`src/client/git-page.tsx` 的文件头把这点写死了,并点名「旧的 local 实现是错的」);
   *     把「仓库设置」跳到一个会改**全局身份**的页面上,是**误导**,比一条 toast 更坏;
   *   - `repositories` 页只有仓库清单 / 切换 / 移除 / 字号,**没有** per-repo 的
   *     `user.name` / `user.email` 控件。
   *
   * 因此这条 toast 必须**点名缺什么**(而不是「暂不支持」),并且**不能**把用户指向
   * 一个作用域不对的页面 —— 那句「请用顶栏的偏好设置页」是**错的**(它会改全局身份),
   * 2026-10 在这里就地更正。文案真源仍是 `commit-avatar-notices.ts` 的
   * `REPOSITORY_SETTINGS_UNAVAILABLE`(那句只说「缺什么」,是对的),作用域警告是
   * 本调用点补的一句。
   *
   * ## `onOpenRepositorySettings`(2026-10 **已接线** —— 上面那段「刻意仍然是一条 toast」
   * 的历史理由**已作废,留痕**)
   *
   * 上游 `:801-807` 派发 `PopupType.RepositorySettings` +
   * `RepositorySettingsTab.GitConfig` ⇒ 我们打开 `RepositorySettingsDialog`
   * 并**预选 Git 配置页**(`workbench.tsx` 的 `openRepositorySettings`)。那个弹窗
   * (`src/client/repository-settings-dialog.tsx`)有 **3 个页签**
   * (远程 / 忽略的文件 / Git 配置),上游第 4 个 `Fork Behavior` 因为缺 fork 状态而不渲染
   * (理由写在那个文件头的「六.1」)。
   *
   * 上面那条「偏好设置 Git 页改的是全局,所以不能拿它当替身」的论断**仍然成立** ——
   * 也正是新弹窗必须自己带 local / global 两个作用域的原因
   * (上游 `git-config.tsx:25-28` 的 `GitConfigLocation`)。
   *
   * 没接上 prop 时说实话:一条点名缺什么的 toast(产品路径已不可达,只服务直接挂载的探针)。
   */
  const openGitSettings = useCallback((): void => {
    if (onOpenPreferences !== undefined) {
      onOpenPreferences();
      return;
    }
    store.toast(GIT_SETTINGS_ENTRY_NOT_WIRED);
  }, [onOpenPreferences, store]);

  const openRepositorySettings = useCallback((): void => {
    if (onOpenRepositorySettings !== undefined) {
      onOpenRepositorySettings();
      return;
    }
    store.toast(
      `${REPOSITORY_SETTINGS_UNAVAILABLE}\n` +
      '⚠️ 注意作用域:偏好设置里的 Git 页改的是**全局** gitconfig,不会改这个仓库的身份;'
    );
  }, [onOpenRepositorySettings, store]);

  /** 上游 `commit-message.tsx:1258` 的 `onStopAmending`(我们这里就是清掉 amend 态)。 */
  const stopAmending = useCallback((): void => {
    store.setCommitField('amend', false);
  }, [store]);

  /*
   * ===========================================================================
   * rebase 冲突 ⇒ **整个提交表单换成镜像 `ContinueRebase`**(用户规则 + 上游判据)
   * ===========================================================================
   *
   * 上游 `filter-changes-list.tsx:889-905` 的 `renderCommitMessageForm` 第一句就是:
   *
   * ```tsx
   * if (rebaseConflictState !== null) { return <ContinueRebase … /> }
   * ```
   *
   * ⇒ 判据是 **`rebaseConflictState !== null`**,不是「operation 是 rebase」这条我们自己
   * 发明的条件;而本仓对它的既有映射就是 `isRebaseInProgress`
   * (`snap.status.operation === 'rebase'`,同一个映射已经被撤销提交条与右键菜单用了,
   * 见 `UndoCommitStrip` 的注释与 `changes-file-menu.ts` 的 rebase 变体)——
   * 这里**沿用同一处映射**,不新造第二份判据。
   *
   * ## `RebaseConflictState` 的五个字段:哪几个是真的,哪两个拿不到(逐条如实)
   *
   * | 字段(上游 `lib/app-state.ts:500-529`) | 上游来源 | 这里 |
   * |---|---|---|
   * | `kind: 'rebase'` | `isRebaseConflictState(conflictState)` | 真(我们只有 rebase 这一档) |
   * | `currentTip` | `gitStore.rebaseConflictState`(`.git/rebase-merge/…` 里的 HEAD) | **真**:`status.headSha`(rebase 期间 HEAD 就是那个在飞的提交) |
   * | `targetBranch` | 用户选来被 rebase 的分支 | **真**:`status.branch`(正在 rebase 的就是当前分支) |
   * | `baseBranch?` | 可选的基线分支名 | 不传(可选字段) |
   * | `originalBranchTip` / `baseBranchTip` | `.git/rebase-merge/orig-head`、`onto` | ⚠️ **拿不到**:我们的 `RepoStatus` 没有 `rebaseInternalState` 那一族字段(`src/client/store.ts:225` 已登记)⇒ 传空串,并**如实标注**「这两个值本插件不知道」 |
   * | `manualResolutions` | `rebaseConflictState.manualResolutions`(用户逐文件选的「用我方/用对方」) | **空 `Map`**:我们没有那套手工解决状态(上游的 `MultiCommitOperation*` 状态机整个不在本仓,`README-probe-index.md` §八)⇒ 于是 `getConflictedFiles()` 会把**所有**未解决的冲突都算进来,`ContinueRebase` 因此给出「Resolve all conflicts before continuing」并把按钮禁用 —— 这在**我们**的能力下是正确的行为(我们确实没有「手工标记为已解决」这个动作) |
   *
   * ## 那个按钮点下去会怎样(**2026-10-10 起是真的**)
   *
   * 上游 `dispatcher.continueRebase(...)` 的动作**已接通**:宿主 `rebase/continue` 路由
   * ⇒ `GitService.continueRebase`(逐跳对着上游 `lib/git/rebase.ts:444-546`)。
   * 门面(`ContinueRebaseDispatcher`,本文件)负责调用 + 播报 + 刷新。
   * 改前的读数(点下去只念「本插件没有 rebase/continue 路由」)与红证见
   * `docs/probes/changes-commit-flow-probe.mjs` 与
   * `docs/probes/rebase-continue-route-probe.mjs`。
   */
  const rebaseConflictState: RebaseConflictState = useMemo(() => ({
    kind: 'rebase',
    currentTip: status?.headSha ?? '',
    targetBranch: branch,
    originalBranchTip: '',
    baseBranchTip: '',
    manualResolutions: new Map(),
  }), [status?.headSha, branch]);
  const continueRebaseDispatcher = useMemo(
    () => new ContinueRebaseDispatcher(store),
    [store],
  );
  if (isRebaseInProgress && repository !== null) {
    const untracked = (status?.files ?? []).some(
      (file) => appFileStatusOfChange(file).kind === AppFileStatusKind.Untracked,
    );
    return (
      <ContinueRebase
        dispatcher={continueRebaseDispatcher}
        repository={repository}
        /*
         * 上游 `filter-changes-list.tsx:893-897` 传的是 `this.props.workingDirectory`
         * (那头是 app-store 的 `WorkingDirectoryStatus`)。
         *
         * 2026-10-10:这里原本是**第二份**内联构造(`changesRowItemsOf(...) +
         * WorkingDirectoryStatus.fromFiles(...)`),现在改用上面那个 `workingDirectory`
         * —— 同一帧里两处必须是同一个对象,否则「超大文件闸门看到的纳入状态」与
         * 「ContinueRebase 看到的」会各自演化(那正是静默漂移的温床)。
         */
        workingDirectory={workingDirectory}
        rebaseConflictState={rebaseConflictState}
        isCommitting={isCommitting}
        hasUntrackedChanges={untracked}
      />
    );
  }

  return (
    <div className="gw-commit">
      {/*
        摘要行:照上游 `.summary`(`ui/changes/commit-message.tsx:1779-1804`)——
        **头像在最左、输入在右**,`column-gap: var(--spacing-half)`(上游
        `styles/ui/changes/_commit-message.scss:83-87`)。类名用 `.gw-cm-summary`
        而不是上游的 `.summary`:上游那条规则挂在 `.commit-message-component` 之下
        (那个容器我们没有),蹭不上;`.gw-cm-summary` 是本泳道新加的适配类
        (写在 `src/client/scss/desktop-changes.scss`)。
        ⚠️ **一处有意偏离**:上游那条 50 字长度提示(`:1801-1803`)在 `.summary` **内部**,
        但它是 `position:absolute` 的浮标、不参与 flex 流;我们的是**块级**提示
        (在输入框下方独占一行),放进 flex 行会被挤成第三列 ⇒ 保持在本行**之后**。
      */}
      <div className="gw-cm-summary">
        <CommitAuthorAvatar
          snap={snap}
          onOpenGitSettings={openGitSettings}
          onOpenRepositorySettings={openRepositorySettings}
        />
        <input className="gw-input" placeholder={placeholder}
          value={form.summary} readOnly={form.generating}
          onChange={(event) => store.setCommitField('summary', event.target.value)} onKeyDown={onKey} />
      </div>
      {form.summary.length > 50 && (
        <div className="gw-hint" style={{ padding: 0 }}>
          好的摘要通常在 50 个字符以内(Desktop 的 IdealSummaryLength);更详细的内容放到描述里。
        </div>
      )}
      <textarea className="gw-area" placeholder="描述(可选)"
        value={form.description} readOnly={form.generating}
        onChange={(event) => store.setCommitField('description', event.target.value)} onKeyDown={onKey} />

      {/*
        操作行 —— **三项必须同一行,齿轮右对齐,生成与模型选择器依次左对齐**
        (用户 2026-10-07 第三轮裁决)。

        改前的两个问题(都是布局,不是数据):
         1. `.gw-commit .row{display:flex;…;flex-wrap:wrap}`(`styles.ts:466`)⇒ 空间紧时
            **齿轮会被挤到第二行**;这里用**行内** `flexWrap:'nowrap'` 顶掉它
            (不动那个共享规则 —— 它还给别的行用);
         2. 行里那个 `<span className="grow" />` 在本面**是个空操作**:全仓只有
            `.gw-toolbar .grow{flex:1}`(`styles.ts:416`)与 `.gw-pitem .grow{…}`
            (`:608`),**没有** `.gw-commit .row .grow` 的规则 ⇒ 齿轮一直贴在模型选择器
            右边,不是右对齐。所以右对齐改由齿轮自己的 `marginLeft:'auto'` 兑现
            (span 保留:先做不删,而且它将来若被补上规则也不冲突)。

        ⚠️ **与上游不同,而且这一次是用户裁决压过上游**:上游
        `ui/changes/commit-message.tsx:1235-1245` 的 `.action-bar` 是
        `display:flex`(无 `justify-content`、无 `margin-left:auto`),齿轮**紧跟**
        生成按钮左对齐(`_commit-message.scss:252-257`)。用户明确要求齿轮右对齐 ⇒
        按用户的来;**不要**把这一条读成「抄漏了」。
      */}
      <div className="row" style={{ flexWrap: 'nowrap' }}>
        <button className="gw-btn" aria-disabled={form.generating || status === null || stagedCount === 0}
          style={{ flexShrink: 0, whiteSpace: 'nowrap' }}
          title={stagedCount === 0
            ? '请先勾选一个或多个文件(生成只依据纳入提交的变更)'
            : '用 DSH 模型列表里的模型生成提交信息'}
          onClick={() => {
            if (form.generating || status === null || stagedCount === 0) { return; }
            if (form.summary.trim() !== '') setConfirmGenerate(true);
            else void store.generateCommitMessage({ force: true });
          }}>
          <Icon name="sparkle" size={11} />
          {form.generating ? '生成中…' : '生成'}
        </button>
        {/*
          模型**选择器**(用户 2026-10-07:「生成按钮右边的模型应该是模型选择器,
          要读取宿主可用的模型列表,允许用户选择不同的模型来生成 commit msg」)。

          改前这里是一个只读的 `<span>{snap.model.split('/').pop()}</span>` ——
          它显示的就是**真正会被发出去**的那个模型(生成请求的 `provider`/`model`
          由 `store.generateCommitMessage` 从 `snap.model` 拆出来),但用户改不了它:
          想换模型必须去设置弹窗的「默认模型」。

          数据源是**宿主的模型清单** `snap.models`(`api.models()` → 宿主
          `commit-message/models` → `ctx.llm.listProviders()` + `listModels()`,
          由 `store.start()` 的 `loadPrefs() → loadModels()` 读回)。

          选中项直接写进**同一个偏好**(`store.setModelPersisted`),也就是设置页
          「默认模型」那个下拉写的**同一个键** —— 不新增第二份偏好存储。
          值用 `provider/id`(与 `snap.model` 和 `store.loadModels` 的判据同形)。

          **两处文案(用户 2026-10-07 第二轮裁决)**:
           · **收起时只显示模型名**(`modelButtonText()`,用户原话「当前选中模型只用显示
             模型名称,不用显示 provider 名称」);
           · **下拉列表里保持原设计**:每一项 `name · providerName`,provider 名在**末尾**。
          这两条**原生 `<select>` 满足不了**(`<option label>` 会把两处一起改短 ——
          本机 headless Chrome 实测的 AX 树读数与理由写在 `modelMenuItems()` 的 JSDoc 里),
          所以下拉用本仓已有的菜单宿主,与齿轮同一个机制。

          **宽度**(用户第二轮追加:「宽度可缩小一点」):`maxWidth: 132`;超长模型名按
          `text-overflow:ellipsis` 截断,完整 `provider/id` 仍在 `title` 与菜单里。
          观感(截断是否好看、宽度是否合适)只能由用户截图判定 —— jsdom 没有布局引擎。
        */}
        <ModelSelect
          models={snap.models}
          value={snap.model}
          onSelect={(next) => { void store.setModelPersisted(next); }} />
        {/* 空操作 span:本面没有 `.gw-commit .row .grow` 规则(见上面操作行的注释),右对齐靠齿轮的 marginLeft。 */}
        <span className="grow" />
        <button className="gw-btn ghost" title="提交选项" aria-expanded={optionsOpen}
          style={{ marginLeft: 'auto', flexShrink: 0 }}
          onClick={() => {
            /*
             * 上游 `commit-message.tsx:1079-1128`:`e.preventDefault()` 之后现拼
             * `IMenuItem[]` 交给 `showContextualMenu`。`optionsOpen` 只用来表达
             * 「菜单正开着」(aria-expanded),菜单关闭后复位 —— 面板已经不在了
             * (用户要求:设置项进菜单而不是出现在下面),但状态位保留。
             */
            setOptionsOpen(true);
            void showCommitOptionsMenu(store, form).finally(() => { setOptionsOpen(false); });
          }}>
          <Icon name="gear" size={12} />
        </button>
      </div>

      {/*
        **共同作者行**(上游 `ui/changes/commit-message.tsx:1806` 的
        `{this.renderCoAuthorInput()}`;实现件 `./co-authors-row.tsx`)。
        位置照上游:`renderAmendCommitNotice()` **之后**、`renderSubmitButton()` **之前**
        —— 在我们的手写壳里就是「`.row` 之后、提交按钮之前」。
        ⚠️ 今天它渲染 `null`(两条上游闸门,见文件的 import 注释),这是**已知的正确行为**。
      */}
      {repository !== null && (
        <CoAuthorsRow
          store={store}
          repository={repository}
          showCoAuthoredBy={snap.showCoAuthoredBy}
          coAuthors={snap.coAuthors}
          isCommitting={isCommitting}
          isAmending={form.amend}
          autocompletionProviders={store.coAuthorAutocompletionProviders()}
        />
      )}

      {/*
        提交按钮 —— 与上游 `ui/changes/commit-message.tsx:1613-1631` 的
        `<Button type="submit" className="commit-button">` **同一套类名与本意**:
        `Button` 渲出来的就是 `<button class="button-component commit-button" type="submit">`
        (`ui/lib/button.tsx:234-241`),所以这里直接写这两个类名,让**上游已经编进
        Changes 移植面的配方**打到自己身上 —— 高度/内边距/圆角/hover/focus/
        `[aria-disabled=true]`/省略号一条都不重复(见
        `src/client/scss/desktop-changes.scss` 的「提交按钮」段)。

        两处**必要**的差别(都在我们这层解决,上游文件一个字没改):
         · 类名多一个 `gw-commit-button`:上游那条 `.commit-button`
           (`ui/changes/_commit-message.scss:321`)嵌在 `.commit-message-component`
           里面,而我们的提交区是手写壳(`.gw-commit`),没有那个祖先 ⇒ 必须是
           **更具体、且只针对这一个按钮**的选择器;
         · 它从 `.row` 里**搬了出来**:上游它是 `.commit-message-component`
           (flex column)的**直接子级** ⇒ 靠默认的 `align-items:stretch` 通栏
           (`_commit-message.scss:5-11`)。我们的 `.gw-commit` 同样是
           `display:flex;flex-direction:column`(`styles.ts:374`)⇒ 同一机制。
      */}
      <button type="submit" className="button-component gw-commit-button"
        aria-disabled={!canCommit} title={disabledReason}
        /*
         * 上游把告警条的 id 关联给提交按钮:`submitButtonAriaDescribedBy={'hidden-changes-warning'}`
         * (`ui/changes/filter-changes-list.tsx:1014`),由 `commit-message.tsx:1626` 落到
         * `<button aria-describedby=…>` 上。**它是无条件传的常量** ⇒ 告警不出现时这是一个
         * **悬空引用**;`docs/changes-parity/E-upstream-changes-inventory.md:980` 明确写
         * 「复刻请**保留**该行为」,所以这里同样无条件写死,不做条件化。
         */
        aria-describedby="hidden-changes-warning"
        onClick={onSubmitCommit}>
        {/*
          转圈图标与文案一起,照上游 `commit-message.tsx:1626-1628` 的
          `{loading}{commitButton}`。类名 extra `octicon` 是刻意的:上游 `Octicon`
          自己会带上它,而它的 `vertical-align:middle` 正好在**本面已有的**
          `ui/_button.scss:34-35` 的 `.button-component .octicon` 里;
          `.gw-spin` 提供旋转动画(`styles.ts` 的 `@keyframes gw-spin`)。
        */}
        {form.generating && <Icon name="sync" size={12} className="octicon gw-spin" />}
        {commitButtonText}
      </button>

      {/*
        **读屏宣告**(上游 `commit-message.tsx:1848-1850`,**逐字同形**):

        ```tsx
        <span className="sr-only" aria-live="polite" aria-atomic="true">
          {this.state.isCommittingStatusMessage}
        </span>
        ```

        位置也照上游:提交按钮之后(上游那一段的顺序是 submit button → 进度条 →
        这一行;进度条那一半本仓没有生产者,见 `committingStatusTitle` 上面的注释)。

        ⚠️ **`className="sr-only"` 是真的在起作用**:它的配方在本面
        (`src/client/scss/desktop-changes.scss:141-143` 的 `.sr-only { @include sr-only-recipe }`)
        —— 缺配方时这段文字会**可见地**挤进提交区(那是本仓最贵的一次返工,
        `docs/goal-port-desktop.md` §7)。探针 H 组同帧读 `getComputedStyle` 断言它被裁掉。

        ⚠️ `aria-live` 的语义:**文本内容变化**才会被念;初值空串 ⇒ 页面加载时静默。
      */}
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {isCommittingStatusMessage}
      </span>

      {/*
        提交选项的**内联面板已删除**(用户 2026-10-07:「生成按钮右边的设置按钮,
        点击后的设置项内容应该在菜单里(右键菜单)而不是出现在下面」)。
        上游的形状本来就是一个上下文菜单:`ui/changes/commit-message.tsx:1053-1130`
        的 `renderCommitOptionsButton` + `onCommitOptionsButtonClick` → `showContextualMenu(items)`。
        **只删了这一个面板**:三个选项的状态(`form.noVerify` / `form.signoff` /
        `form.allowEmpty`)与动作(`store.setCommitField`)一个字没动,现在由
        `commitOptionsMenuItems()` 渲染成菜单里的三个 checkbox
        (项序/checked 语义逐条照上游,见那个函数的注释)。
        ⚠️ 旧类名 `.gw-commit-options` 的 CSS 规则**故意保留**在 `styles.ts`(「先做,不删」;
        退役条件:确认全仓再没有第二个消费方时,连那条规则一起删)。
      */}

      {/*
        ------------------------------------------------------------------
        amend 提示 —— **整体交给镜像 `CommitWarning`**(2026-10-09)
        ------------------------------------------------------------------
        上游 `commit-message.tsx:1250-1267` 的 `renderAmendCommitNotice`:

        ```tsx
        <CommitWarning icon={CommitWarningIcon.Information}>
          Your changes will modify your <strong>most recent commit</strong>.{' '}
          <LinkButton onClick={this.props.onStopAmending}>Stop amending</LinkButton>{' '}
          to make these changes as a new commit.
        </CommitWarning>
        ```

        接线前这里是一根手写的 `div.gw-hint`(同一条信息、另一套 DOM),于是
        `ui/changes/commit-warning.tsx`(56 行,字节一致)**在树里、0 个 importer**
        (审计 §2 树 2 的 `:1256-1429 CommitWarning ×7 支` 那一行)。
        现在这一支与上游同一件:图标(`information-icon`)、`warning-message` 容器、
        以及**镜像 `LinkButton`**(`.link-button-component`,与告警条同一件)。
        其余 6 支(repo rules / 分支保护)依赖 `repoRulesInfo` / `showNoWriteAccess`
        那些我们**没有**的状态(`repoRulesEnabled` 恒 false)⇒ 不伪造,理由已在
        `canCommit` 的注释里(与「上游未启用 repo rules 时」逐字等价)。

        文案按仓库既有裁决**中文化**(goal §11.9),上游原文逐字留在上面;
        `strong` 的那一段刻意保留(上游也把「最近一次提交」加粗)。
      */}
      {form.amend && hasPreviousCommit && createElement(
        CommitWarning,
        { icon: CommitWarningIcon.Information },
        '这些改动会改写你',
        createElement('strong', null, '最近一次提交'),
        '。',
        /*
         * `LinkButton` 与 `CommitWarning` 都用 `createElement` 而不是 JSX ——
         * 理由与 `hidden-changes-warning.tsx:258-269` **逐字相同**:镜像那两个组件的
         * props(`ILinkButtonProps` / `FunctionComponent<{icon}>`)**没有声明 `children`**
         * (上游跑 `@types/react@^16`,那一代类组件/FC 隐式接受 children;我们钉的是 18.3.31,
         * 它要求显式声明)⇒ 写成 `<CommitWarning>…</CommitWarning>` 会多出 TS2322/TS2769。
         * `createElement` 的 children 走第三个**可变参数**重载 ⇒ 类型成立,
         * 产出的 DOM 与 JSX **逐字相同**;本文件对 `check-types` 棘轮因此是 **±0**。
         *
         * 中文不需要上游那两处 `{' '}`(同 `hidden-changes-warning.tsx` 的处置)。
         */
        createElement(LinkButton, { onClick: stopAmending }, '停止修改'),
        '以新建一个提交。',
      )}

      {/*
        ------------------------------------------------------------------
        撤销提交条 —— **整体交给上游组件**(2026-10;此前是手写的
        `div.gw-undo-commit` + `formatWhen`,见下面 `UndoCommitStrip` 的文件头)
        ------------------------------------------------------------------
      */}
      <UndoCommitStrip
        snap={snap}
        onUndo={requestUndo}
      />

      {confirmGenerate && (
        <ConfirmDialog
          title="覆盖已写的提交信息?"
          body="你输入的摘要与描述会被生成结果覆盖。对应 Desktop 的 Commit message override 提示。"
          confirmText="覆盖" danger
          onDone={(okay) => { setConfirmGenerate(false); if (okay) void store.generateCommitMessage({ force: true }); }} />
      )}
      {/*
        **生成失败**的弹窗(用户 2026-10-07:「如果出现生成错误,错误通知里缺失具体信息」)。
        改前这条失败走 `store.fail()` —— 那时它对 `code === 'internal'` **不附 `detail`**
        (2026-10 已修:`fail()` 现在对任何码都附 `（detail）` + `错误码:<code>`),
        而且只是一条 7 秒的 toast、还不换掉正文;现在失败原样进快照(`store.generateFailure`),
        由 `bits.tsx` 的 `GenerateFailureDialog` 逐字播 `message` + 可滚可选的
        `<pre>{detail}</pre>` + `错误码:<code>`(与推送失败那条已经落地的模式同形,
        见 `docs/push-failure-surfaces.md` §10)。
      */}
      {snap.generateFailure !== null && (
        <GenerateFailureDialog
          error={snap.generateFailure}
          onDismiss={() => { store.clearGenerateFailure(); }} />
      )}
      {confirmUndo && undoCommit !== null && (
        <ConfirmDialog
          title="撤销最近一次提交?"
          body={`${undoCommit.summary}\n\n提交会被撤销,改动保留在工作区(不会丢失),但不再处于暂存状态。`}
          confirmText="撤销提交" danger
          onDone={(okay) => { setConfirmUndo(false); if (okay) void store.undoCommit(undoCommit.sha); }} />
      )}
    </div>
  );
}

/**
 * `AppFileStatus`(`models/status.ts:20-30` 的判别联合)→ `DesktopDiff` 要的**状态字母**。
 *
 * 为什么需要它:`stash/show` 回来的是 `AppFileStatus`(为选图标设计的判别联合),
 * 而 `DesktopDiff.input.status` 收的是 porcelain 字母(`core/types.ts` 的 `ChangeStatus`)。
 * 这一份映射只服务 stash 面板;**不**复用 `history-view.tsx` 的 `toChangeStatus`
 * (那个函数的输入是 `git log --name-status` 的字母,方向相反 —— 反向映射不是同一件事)。
 * @param status - 镜像模型里的文件状态。
 */
function stashStatusLetterOf(status: AppFileStatus): ChangeStatus {
  switch (status.kind) {
    case AppFileStatusKind.New:
      return 'A';
    case AppFileStatusKind.Deleted:
      return 'D';
    case AppFileStatusKind.Renamed:
      return 'R';
    case AppFileStatusKind.Copied:
      return 'C';
    case AppFileStatusKind.Untracked:
      return '?';
    case AppFileStatusKind.Conflicted:
      return 'U';
    case AppFileStatusKind.Modified:
    default:
      return 'M';
  }
}

/** 重命名 / 复制的**旧路径**(判别联合上只有那两支有 `oldPath`)。 */
function stashOldPathOf(status: AppFileStatus): string | undefined {
  return status.kind === AppFileStatusKind.Renamed || status.kind === AppFileStatusKind.Copied
    ? status.oldPath
    : undefined;
}

/**
 * **左下角的「贮藏的改动」开关** —— 上游 `renderStashedChanges()`
 * (`ui/changes/filter-changes-list.tsx:1105-1130`)。
 *
 * 上游逐条:`stashEntry === null` ⇒ `return null`(`:1106-1108`);
 * 按钮带 `aria-expanded={isShowingStashEntry}` 与
 * `aria-controls={isShowingStashEntry ? StashDiffViewerId : undefined}`(`:1120-1124`);
 * 类名 `stashed-changes-button` + 选中态 `selected`(`:1112-1115`);
 * 内容 = 图标(`stack-icon`)+ `Stashed Changes` + 右箭头(`:1125-1127`)。
 */
function StashedChangesButton(props: {
  stashEntry: IStashEntry | null;
  showing: boolean;
  onToggle: () => void;
}): ReactNode {
  const { stashEntry, showing, onToggle } = props;
  if (stashEntry === null) {
    return null;
  }
  return (
    <button
      className={`gw-stash-button${showing ? ' selected' : ''}`}
      data-gw-stash-button={showing ? 'selected' : 'idle'}
      onClick={onToggle}
      aria-expanded={showing}
      aria-controls={showing ? 'stash-diff-viewer' : undefined}
    >
      <Icon name="stash" size={14} className="stack-icon" />
      <span className="text">贮藏的改动</span>
      <Icon name="chevron-right" size={12} />
    </button>
  );
}

/**
 * stash 文件列表里的一行 —— 上游 `ui/history/file-list.tsx` 的行
 * (它渲染的是 `CommittedFileChange`,stash 视图与 History 共用同一个 `FileList`)。
 *
 * 这里只画 **状态字母 + 路径**:上游那一行还有文件图标与虚拟滚动,而我们这一版
 * 面板是手写的(见 `StashDiffViewer` 的文件头「与上游的差异」)。
 * 行本身是 `<button role="option">`,与左栏 `.gw-files` 的 roving tabindex 同形。
 */
function StashFileRow(props: {
  file: { path: string; status: AppFileStatus };
  selected: boolean;
  onSelect: (path: string) => void;
}): ReactNode {
  const { file, selected, onSelect } = props;
  const onClick = useCallback(() => { onSelect(file.path); }, [onSelect, file.path]);
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      className={`gw-stash-file${selected ? ' selected' : ''}`}
      data-gw-stash-file={file.path}
      onClick={onClick}
    >
      <span className="gw-stash-letter">{stashStatusLetterOf(file.status)}</span>
      <span className="gw-stash-path">{file.path}</span>
    </button>
  );
}

/**
 * **stash 的只读视图** —— 上游 `ui/stashing/stash-diff-viewer.tsx`(160 行)
 * + `ui/stashing/stash-diff-header.tsx`(115 行)的**判定移植**。
 *
 * ## 抄了什么(逐条给上游行号)
 *
 *  - 容器 `<section id="stash-diff-viewer">`(`stash-diff-viewer.tsx:127`);
 *  - 头部 = `<h3>Stashed changes</h3>` + `Restore` / `Discard` 两颗按钮 +
 *    一句解释(「**Restore** will move your stashed files to the Changes list.」)
 *    (`stash-diff-header.tsx:47-67`);
 *  - 两颗按钮在**任一颗在飞**时都禁用(`:52-58` 的 `isRestoring || isDiscarding`);
 *  - `Discard` 的判定:`askForConfirmationOnDiscardStash` ⇒ 交给页面弹
 *    `ConfirmDiscardStash`,否则直接丢(`:79-103`)。我们那一侧默认走确认框,见
 *    `onDiscardStashClick`;
 *  - 文件清单取自 `stashEntry.files`,**只在 `Loaded` 时**有内容
 *    (`getFiles()`,`:88-92`);选中文件变了就按 `commit: stashSha` 取 diff
 *    —— 与 History 的 `CommitDiff`(`history-view.tsx:1080-1097`)走**同一条**
 *    `api.diff` 链,没有第二条取 diff 的路。
 *
 * ## 与上游的**诚实差异**(不在 UI 里假装)
 *
 * | 项 | 上游 | 我们 |
 * |---|---|---|
 * | 文件列表 | `ui/history/file-list.tsx`(虚拟滚动 + 图标) | 手写的行(状态字母 + 路径),无虚拟滚动 |
 * | 文件列表宽度可拖 | `Resizable` + `stashedFilesWidth` 偏好 | 固定宽度(没有那个偏好项) |
 * | 缩进/几何 | `_stash-diff-viewer.scss` 一族 | 未接(jsdom 无布局引擎 ⇒ 本探针不判几何) |
 * | 「Do not show this message again」 | `confirm-discard-stash.tsx:60-72` 的复选框 + 偏好写侧 | **没有写侧** ⇒ 恒走确认框(照上游默认值 `true`) |
 */
function StashDiffViewer(props: {
  store: GitStore;
  stashEntry: IStashEntry;
  onDiscardClick: () => void;
}): ReactNode {
  const { store, stashEntry, onDiscardClick } = props;
  const files = stashEntry.files.kind === StashedChangesLoadStates.Loaded ? stashEntry.files.files : [];
  const [selectedPath, setSelectedPath] = useState('');
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [busy, setBusy] = useState(false);
  /** 当前选中项:名字命中就用命中项,否则回落到第一项(上游 `_selectStashedFile` 的回落)。 */
  const selectedFile = files.find((file) => file.path === selectedPath) ?? files[0] ?? null;
  const selectedPathResolved = selectedFile?.path ?? '';

  /*
   * 取 diff:与 History 的 `CommitDiff` 同一条 `api.diff({path, file, commit})`。
   * `dead` 守卫防的是「快速切换文件时后一个响应被前一个覆盖」(`history-view.tsx:1086-1096`
   * 的同一套写法)。
   */
  useEffect(() => {
    if (selectedFile === null) {
      setDiff(null);
      return;
    }
    let dead = false;
    void api.diff({
      path: store.snapshot().current,
      file: selectedFile.path,
      commit: stashEntry.stashSha,
    }).then((result) => {
      if (dead) { return; }
      setDiff(result.ok ? result.value : null);
    });
    return () => { dead = true; };
  }, [selectedFile, stashEntry.stashSha, store]);

  const onSelectFile = useCallback((path: string) => { setSelectedPath(path); }, []);
  const onOpenBinary = useCallback((fullPath: string): void => {
    void store.openInExternalEditor(fullPath);
  }, [store]);
  const onHideWhitespace = useCallback((): void => { /* stash diff 不带 -w 开关(上游 StashDiffViewer 恒传 hideWhitespaceInDiff={false},`:110`) */ }, []);
  /**
   * **「恢复」成功之后这个组件会被卸载**(`stashEntry` 变 `null` ⇒ 右栏换回 Changes),
   * 而 `popStash()` 的 `finally` 还要 `setBusy(false)` —— 那就是一条
   * 「在已卸载组件上 setState」的 React 警告(`console.error`),
   * 也正是本仓探针的 Z 组（零 `console.error`）会抓的东西。
   *
   * ⚠️ 这条**不是**上游的写法:上游的 `StashDiffHeader` 是**类组件**,`finally` 里的
   * `this.setState` 在 React 17 的类组件上**不会**报这条警告(那套警告只针对函数组件的
   * hook 更新)。我们用了 hook ⇒ 必须自己拿一个 ref 挡住。
   * 判据:`docs/probes/stash-probe.mjs` 的 D6 会在**真点击**之后读 `console.error`。
   */
  const aliveRef = useRef(true);
  useEffect(() => () => { aliveRef.current = false; }, []);
  const onRestore = useCallback(() => {
    setBusy(true);
    void store.popStash().finally(() => { if (aliveRef.current) { setBusy(false); } });
  }, [store]);
  const onDiscard = useCallback(() => { onDiscardClick(); }, [onDiscardClick]);

  return (
    <section className="gw-stash-view" id="stash-diff-viewer" data-gw-stash-view={stashEntry.stashSha}>
      <div className="header">
        <h3>贮藏的改动</h3>
        <div className="row">
          <button
            type="button"
            className="gw-btn primary"
            data-gw-stash-action="restore"
            disabled={busy}
            onClick={onRestore}
          >恢复</button>
          <button
            type="button"
            className="gw-btn"
            data-gw-stash-action="discard"
            disabled={busy}
            onClick={onDiscard}
          >丢弃</button>
          {/*
            上游这里的类名是 `.explanatory-text`(它住在
            `styles/ui/_stash-diff-viewer.scss:35`),但那是**上游 partial 里的名字**:
            我们没 import 那份 partial(理由写在 `styles.ts` 的 `.gw-stash-*` 段),
            用了它就会进 `check-base-recipes` 的「outside 有、inside 没有」清单
            —— 实测那一版把该闸门从 23 顶到 **24**。所以用我们自己的 `.gw-stash-hint`。
          */}
          <span className="gw-stash-hint">「恢复」会把贮藏的文件放回变更列表。</span>
        </div>
      </div>
      <div className="gw-stash-body">
        <div className="gw-files" role="listbox" aria-label="贮藏的文件">
          {files.length === 0 && (
            <Empty icon="check-circle" title="这条贮藏没有文件" body="它的提交里没有任何改动。" />
          )}
          {files.map((file) => (
            <StashFileRow
              key={file.path}
              file={file}
              selected={file.path === selectedPathResolved}
              onSelect={onSelectFile}
            />
          ))}
        </div>
        <div className="gw-stash-diff">
          {selectedFile === null || diff === null
            ? <Empty icon="file" title="没有可显示的差异" body="选一个文件看它的改动。" />
            : (
              <DesktopDiff
                input={{
                  repositoryPath: store.snapshot().current,
                  path: selectedFile.path,
                  ...(stashOldPathOf(selectedFile.status) !== undefined
                    ? { oldPath: stashOldPathOf(selectedFile.status) as string }
                    : {}),
                  patch: diff.patch,
                  binary: diff.binary,
                  status: stashStatusLetterOf(selectedFile.status),
                  commitish: selectedFile.commitish,
                  parentCommitish: selectedFile.parentCommitish,
                }}
                showSideBySideDiff={store.snapshot().sideBySide}
                hideWhitespaceInDiff={false}
                onHideWhitespaceInDiffChanged={onHideWhitespace}
                onOpenBinaryFile={onOpenBinary}
              />
            )}
        </div>
      </div>
    </section>
  );
}

/**
 * 空态建议卡的**稳定标识**(探针按它断言在场/缺席,渲染成 `data-gw-suggested`)。
 *
 * 取值与上游 `ui/changes/no-changes.tsx` 的分支一一对应:
 * `view-stash`(`:398-448`,**优先级最高**)`publish-repo`(`:453`)`publish-branch`(`:491`)
 * `pull`(`:540`)`push`(`:592`)五个主卡
 * + `open-editor`(`:305`)`reveal`(`:266`)`view-github`(`:280`)三个次卡。
 * 上游没有这个键 —— 它的「哪张卡」是由 `renderActions()` 的调用链决定的;
 * 我们把它显式化,只为了让**判据**能点名一张卡。
 */
type SuggestedKey =
  | 'view-stash'
  | 'publish-repo'
  | 'publish-branch'
  | 'pull'
  | 'push'
  | 'open-editor'
  | 'reveal'
  | 'view-github';

/**
 * 「没有本地变更」空态,照 GitHub Desktop 的 `ui/changes/no-changes.tsx`。
 *
 * Desktop 的结构(`no-changes.tsx:763-785`):
 *   `<div className="changes-interstitial"><div className="content">` +
 *   头部(`<h1>No local changes</h1>` + 说明段 + 插图)+ 两组建议动作。
 * 每组动作是一张卡片(`ui/suggested-actions/suggested-action.tsx:70-92`):
 * **标题句** + 描述 + 一个按钮,按钮文字是菜单项标签。
 *
 * 建议动作(Desktop 的 `renderActions`,`:735-747`):
 *  - 主组:有 stash 就看 stash,否则 `renderRemoteAction()` 按远端状态给
 *    **发布仓库 / 发布分支 / 拉取 N 个提交 / 推送本地提交** 四张卡之一(也可能一张都不给);
 *  - 次组:`Open in <编辑器>` / `Show in Finder` / `View on GitHub`。
 *
 * ## 为什么这是一个**手写**组件,而不是渲染镜像的那一个
 *
 * 镜像 `src/core/desktop/ui/changes/no-changes.tsx`(**785 行,`cmp` 无输出**)在树里,
 * 但今天**零 importer**。它**不能**被直接渲染,两半都缺:
 *
 * 1. **它要的 prop 里有两样我们没有**:`appMenu: IMenu`(Electron 应用菜单)与
 *    `repositoryState: IRepositoryState`(完整 `IBranchesState`/`IChangesState`)。
 *    前者更致命:`renderMenuBackedAction()`(`:240-264`)在 `getMenuItemInfo(id)`
 *    为 `undefined` 时**直接 `return null`** ⇒ 没有 `appMenu` 时**四张卡一张都不出现**。
 * 2. **它的按钮全部是「菜单代理」**:`MenuBackedSuggestedAction`(`:94-102`)点下去执行
 *    `executeMenuItemById(menuItemId)`,而我们树里那个导出是
 *    `ui/main-process-proxy.ts:66` 的 `sendProxy('execute-menu-item-by-id', 1)`
 *    —— 浏览器半没有主进程,它是 **no-op**。照抄渲染 = **四张看得见、点不动的卡**。
 *
 * ⇒ 我们保留手写实现(与 `toolbar.tsx` / `history-view.tsx` 同一条路线),
 * 但**判定级联逐支照上游**:见下面 `primary` 那一段的逐行注释。
 *
 * ## 我们与上游的**诚实差异**(逐条;不在 UI 里假装)
 *
 * | 项 | 上游 | 我们 |
 * |---|---|---|
 * | 卡的按钮怎么生效 | 执行应用菜单项(`executeMenuItemById`) | 直接调 `store.*` 的真动作(`runSyncAction` / `openInExternalEditor` / `revealInFileManager` / `window.open`) |
 * | 每张卡的「菜单/快捷键」提示行 | `renderDiscoverabilityElements()`(`:220-229`)从菜单项取「File menu or ⇧⌘P」 | **没有应用菜单、也没有快捷键**,所以只有主组那三张卡给出**真实的**替代入口(顶栏同步段);次组三张卡**不给提示行** —— 编一条不存在的菜单路径就是撒谎 |
 * | 「Create a Pull Request」卡 | `:386-393`(要 `currentPullRequest` + `defaultBranch`) | **诚实缺席**(快照里没有这两样数据) |
 * | 「View your stashed changes」卡 | `:398-448`(最高优先,`:742` 的 `\|\|`) | **2026-10 落地**:`primary = 'view-stash'` 走同一条短路,按钮真的打开 stash 面板(数据源 `store.stashEntry`,stash 族路由已建) |
 * | 推送条件的 `tagsToPush` 一半 | `:379-384` | **在场**(`snap.tagsToPush` ⬅ 宿主 `tag-unpushed` 路由) |
 * | 编辑器清单 | `applications(path)` 读本机 `.app` | 宿主 `system/apps` 探测(`routes.ts:400`);**改选它的写侧今天 0 调用点**(`prefs.ts:162`) |
 * | 插图 `paper-stack.svg` | `:54` 的 `encodePathAsUrl` | 不渲染(我们没有该静态资源的浏览器侧分发;缺的是资产,不是逻辑) |
 */
function NoChanges(props: {
  store: GitStore;
  snap: Snapshot;
  /**
   * **看 stash** —— 主组 stash 卡那颗按钮的动作(上游 `View stash` ⇒
   * `MenuBackedSuggestedAction` 执行 `toggle-stashed-changes` 菜单项)。
   *
   * 由 `ChangesView` 传进来(`onViewStash` 的 `useCallback`),因为它要改的是**页一级**的
   * `showStashedChanges`(上游那个状态住在 `changesState.selection.kind`)。
   * **不是**可选:漏传会让那张卡变成「点了没反应」—— 那正是本仓最贵的一类缺陷。
   */
  onViewStash: () => void;
}): ReactNode {
  const { store, snap } = props;
  const repoPath = snap.current;
  const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform ?? '');
  const fileManager = isMac ? 'Finder' : 'your File Manager';

  // 编辑器清单懒加载(只请求一次)
  useEffect(() => { void store.loadExternalApps(); }, [store]);

  const editors = snap.externalApps.filter((app) => app.id !== 'default');
  /*
   * 主编辑器由 **Preferences ▸ 外部集成 ▸ External editor** 决定(授权范围内的一处最小改动):
   * 以前这里是 `const primaryEditor = editors[0]`,所以那个下拉选了谁都不会影响这一行
   * ——「可见但无作用」的控件。偏好存的是 host 的 app **id**(`getPreferredExternalEditor`),
   * 没设过时回落到探测到的第一个(与上游 `integrations.tsx:78-85` 的「选中第一个」一致)。
   */
  const preferredEditorId = getPreferredExternalEditor();
  /*
   * 主编辑器与**行右键菜单**读同一份投影(`resolvePrimaryExternalEditor`)——
   * 两处各写一遍这三行必然漂移(改了空态卡、忘了菜单)。
   */
  const primaryEditor = resolvePrimaryExternalEditor(snap.externalApps, preferredEditorId);
  const branch = snap.status?.branch ?? '';
  /** GitHub 的 `owner/repo`(`RepoEntry.remote`,`core/types.ts:186`);无 GitHub 远端为 null。 */
  const gitHubRepo = snap.repos.find((r) => r.path === repoPath)?.remote ?? null;

  /*
   * ==========================================================================
   * 主组(primary)的**判定级联** —— 逐支照上游 `ui/changes/no-changes.tsx:347-396`
   * ==========================================================================
   *
   * 上游那一支读的是 `this.props.repositoryState`
   * (`{ remote, aheadBehind, branchesState, tagsToPush }`,`:348-350`),
   * 由 `IRepositoryState` 携带(`lib/app-state.ts`)。我们的快照里**没有** `IRepositoryState`
   * (`Snapshot` 是扁平投影,见 `store.ts` 的 `interface Snapshot`),所以**不在这里重新推导**
   * 「怎么从 git 状态算出 ahead/behind」—— 那件事已经有一处真源:`sync-state.ts` 的
   * 四个投影函数,它们是上游 `ui/app.tsx:3620-3665` 的镜像,顶栏同步段
   * (`repo-bar.tsx` 的 `syncPresentation`)用的也是同一批输入。
   *
   * 每一支的**上游行号**逐条注在下面;这条 `if / else if` 链的**次序就是上游的次序**
   * (次序本身是判据:behind 优先于 ahead,见 N04)。
   */
  const tip = tipOf(snap);
  const remotes = snap.sync?.remotes ?? [];
  const upstream = snap.sync?.upstream ?? null;
  const aheadBehind = aheadBehindOf(snap);
  const ahead = aheadBehind?.ahead ?? 0;
  const behind = aheadBehind?.behind ?? 0;
  const forcePushState = forcePushBranchStateOf(snap);
  const remoteName = remoteNameOf(snap);
  /**
   * **未推送的标签身份清单**(`store.ts` 的 `Snapshot.tagsToPush`;上游 `IRepositoryState.tagsToPush`,与
   * `no-changes.tsx:348` 解构出来的那个同义)。它只进推送卡的条件与文案 ——
   * 「有没有标签可推」不是这张卡的**唯一**理由(有本地提交也一样给卡)。
   */
  const tagsToPush = snap.tagsToPush;
  /**
   * **当前分支的 stash 条目**(`store.ts` 的 `Snapshot.stashEntry`;上游
   * `changesState.stashEntry`,`lib/app-state.ts:845-848`)。
   *
   * 它是主组**优先级最高**那一支的输入(`no-changes.tsx:742` 的
   * `renderViewStashAction() || renderRemoteAction()`)。
   */
  const stashEntry = snap.stashEntry;
  /** stash 是否**装载完成**(`Loaded`)—— 空态卡严格要这一档(`no-changes.tsx:408-410`)。 */
  const stashLoaded = stashEntry !== null && stashEntry.files.kind === StashedChangesLoadStates.Loaded;
  const stashFileCount = stashEntry !== null && stashEntry.files.kind === StashedChangesLoadStates.Loaded
    ? stashEntry.files.files.length
    : 0;

  /** 主组要渲染哪一支(上游那一串 `if` 的结果)。`null` = 上游也不渲染任何主卡。 */
  let primary: SuggestedKey | null = null;
  /*
   * **stash 卡优先级最高**(上游 `:742` 的 `||` 短路;`renderViewStashAction()` 自己
   * 三条早退:`tip.kind !== TipState.Valid`(`:399-401`)、`stashEntry === null`(`:404-406`)、
   * `files.kind !== Loaded`(`:408-410`))。所以它**不是** `else if` 链里的一支,
   * 而是链**之前**的一次短路 —— 次序本身就是判据(有 stash 时**不**给远端卡)。
   */
  if (tip.kind === TipState.Valid && stashLoaded) {
    primary = 'view-stash';
  } else if (tip.kind === TipState.Valid) {
    // 上游 `:352-354`:`if (tip.kind !== TipState.Valid) return null`
    if (remotes.length === 0) {
      primary = 'publish-repo'; // 上游 `:356-358`
    } else if (upstream === null) {
      primary = 'publish-branch'; // 上游 `:361-363`
    } else if (forcePushState === ForcePushBranchState.Recommended) {
      /*
       * 上游 `:365-373`:刚 rebase / amend 过(分叉且是我们自己重写出来的)时
       * **刻意不渲染主卡** —— 原注释写明了理由(此时按钮的默认行为是拉取,会把人带进
       * 更混乱的历史)。这是一条**故意的缺席**,N09 用真实 amend 路径写出的
       * `forcePushBranches` 验它。
       */
      primary = null;
    } else if (behind > 0) {
      primary = 'pull'; // 上游 `:375-377`
    } else if (ahead > 0 || tagsToPush.length > 0) {
      /*
       * 上游 `:379-384`:`aheadBehind.ahead > 0 || (tagsToPush !== null && tagsToPush.length > 0)`。
       *
       * **两半都在**:`snap.tagsToPush`(快照字段 `string[]`,由 `refreshTagsToPush()`
       * 走宿主 `tag-unpushed` 路由填)与上游 `IRepositoryState.tagsToPush` 同义 ——
       * 都是「**身份清单**,不是个数」。
       * ⚠️ **刷新时机今天不由我们决定**:`store.ts` 的 `setTab()` 只在切到 **History**
       * 页签时问一次宿主(那是 `Delete tag <name>` 那条线的落点),`refreshAll()` **不**含它。
       * ⇒ 用户一次都没打开过 History 时,这个数组是 `[]`,推送卡退回「只看 `ahead`」那一半
       * (只会**少**一档,不会**错**)。这是「数据源的刷新时机」问题,记在
       * `docs/no-changes-suggestions-inventory.md` §4 与探针文件头。
       * ⚠️ 别用 `snap.sync.tagCount`:那是**本地标签总数**,与「未推送」无关
       * (`tag-unpushed` 的 JSDoc 也写了这条边界)。
       * ⚠️ 旧宿主没有那条路由时,这个数组保持 `[]`(= 优雅降级成改前那一半),
       * **不会**把它读成「没有标签可推」之外的任何东西。
       */
      primary = 'push';
    }
    /*
     * 上游 `:386-393` 的最后一支是 `Create a Pull Request`(条件:`isGitHub &&
     * currentPullRequest === null && !isDefaultBranch`)。我们快照里**没有**
     * `currentPullRequest`,也**没有** `defaultBranch`(PR 数据源是缺的
     * `pull-request-store.ts` / `branchesState.defaultBranch`)⇒ 这一支**诚实缺席**:
     * 不拿「非默认分支」猜一个 PR 卡出来(猜错会让用户以为 PR 已存在)。
     */
  }

  const action = (
    key: SuggestedKey,
    title: string,
    button: string,
    onClick: () => void,
    description?: string,
    hint?: string,
  ): ReactNode => (
    /*
     * `data-gw-suggested` 是**探针取卡片的稳定标识**(与 `hidden-changes-warning.tsx`
     * 的 `data-gw-*`、本文件 `:690-700` 的 `data-gw-include-probe` 同一做法):
     * 建议卡是「只由谓词决定出现与否」的 UI —— 谓词一旦成常量,界面**不报错**,
     * 只是永远不出现。探针必须能**按名字**断言在场/缺席,而不是数 `.gw-suggested` 的个数。
     */
    <div className="gw-suggested" key={key} data-gw-suggested={key}>
      <div className="text">
        <h2>{title}</h2>
        {description !== undefined && <p className="desc">{description}</p>}
        {hint !== undefined && <p className="desc" data-gw-suggested-hint={key}>{hint}</p>}
      </div>
      <button className="gw-btn" onClick={onClick}>{button}</button>
    </div>
  );

  /** 主卡:上游 `renderViewStashAction()` + `renderRemoteAction()` 的五个分支 + 三个「无主卡」分支。 */
  const primaryCard = (): ReactNode => {
    switch (primary) {
      /*
       * **「查看你贮藏的改动」** —— 上游 `renderViewStashAction()`
       * (`no-changes.tsx:398-448`),`renderActions()` 里**第一优先**的那一支
       * (`:742`)。逐条对照:
       *   · 标题 `View your stashed changes`(`:437`);
       *   · 描述 `You have {N} {N === 1 ? 'change' : 'changes'} in progress that you have
       *     not yet committed.`(`:412-420`)—— N 是 `stashEntry.files.files.length`;
       *   · 按钮 `View stash`(`:443`),`type="primary"`(`:444`);
       *   · 提示行 `When a stash exists, access it at the bottom of the Changes tab to
       *     the left.`(`:422-427`)—— 我们那颗按钮**真的**在左下角
       *     (`StashedChangesButton`),所以这句话在我们这里也是**真话**。
       *
       * 上游按钮是个 `MenuBackedSuggestedAction`(`menuItemId='toggle-stashed-changes'`),
       * 点下去执行应用菜单项;我们**没有应用菜单**,于是接**同一个动作的落点**
       * (`Dispatcher.selectStashedFile` ⇒ 显示 stash 视图)—— 与其它卡「直接调真动作」
       * 同一取舍,写在 `NoChanges` 的头注释里。
       */
      case 'view-stash':
        return action('view-stash',
          '查看你贮藏的改动',
          '查看贮藏',
          props.onViewStash,
          `你有 ${formatNumber(stashFileCount)} 个改动尚未提交。`,
          '有贮藏时,可以在 Changes 页签左下角随时访问它。');
      case 'publish-repo':
        return action('publish-repo',
          '把这个仓库发布到 GitHub',
          '发布仓库',
          () => store.toast(PUBLISH_REPOSITORY_UNAVAILABLE),
          '还没有配置任何远端。',
          '顶栏的同步段也一直可以发布。');
      case 'publish-branch':
        return action('publish-branch',
          `把 ${branch} 分支发布到 ${remoteName ?? '远端'}`,
          `发布 ${remoteName ?? '分支'}`,
          () => { void store.runSyncAction('push'); },
          '这个分支还没有跟踪关系,推送后会自动建立。',
          '顶栏的同步按钮也一直可以发布。');
      case 'pull':
        return action('pull',
          `拉取 ${remoteName ?? '远端'} 上的 ${formatNumber(behind)} 个提交`,
          `拉取 ${remoteName ?? '远端'}`,
          () => { void store.runSyncAction('pull'); },
          `当前分支(${branch})在 ${remoteName ?? '远端'} 上有 ${formatNumber(behind)} 个提交是本地没有的。`,
          '有远端改动时,顶栏的同步按钮一直可用。');
      case 'push': {
        /*
         * 标题/描述按上游 `renderPushBranchAction`(`no-changes.tsx:608-644`)**合并**两样:
         * 有提交就写「本地提交」、有标签就写「标签」,两样都有时用「和」连起来
         * (上游 `itemsToPushTypes.join(' and ')` / `itemsToPushDescriptions.join(' and ')`)。
         * 标题里的**类型**与描述里的**条数**分开算 —— 上游标题恒为复数名词
         * (`Push commits to the origin remote`),条数只在描述里出现。
         */
        const kinds: string[] = [];
        const counts: string[] = [];
        if (ahead > 0) {
          kinds.push('本地提交');
          counts.push(`${formatNumber(ahead)} 个本地提交`);
        }
        if (tagsToPush.length > 0) {
          kinds.push('标签');
          counts.push(`${formatNumber(tagsToPush.length)} 个标签`);
        }
        const remote = remoteName ?? '远端';
        return action('push',
          `把${kinds.join('和')}推送到 ${remote} 远端`,
          `推送 ${remote}`,
          () => { void store.runSyncAction('push'); },
          `你有 ${counts.join('和')}等待推送到 ${remote}。`,
          '有本地提交待推送时,顶栏的同步按钮一直可用。');
      }
      default:
        return null;
    }
  };

  return (
    <div className="gw-interstitial">
      {/*
        判定输入 / 判定结果 / DOM 三者必须一致的**机器可查读数**(探针用;`hidden` 不占布局)。
        为什么要有它:这一组卡片是本项目最怕的那类缺陷的现场 ——「只由谓词决定出现与否」,
        谓词成了常量时界面不会报错,只会永远不出现。把四条真输入与**最终那支**一起暴露出来,
        一条 DevTools 表达式就能同时读到「输入 / 判定 / DOM 是否真的在」。
      */}
      <div hidden={true} data-gw-no-changes-probe={JSON.stringify({
        tip: tip.kind,
        remotes,
        upstream,
        ahead,
        behind,
        forcePush: ForcePushBranchState[forcePushState],
        remoteName,
        gitHubRepo,
        /* 未推送的标签**身份清单**(不是个数):推送卡的另一半条件就是它。 */
        tagsToPush,
        /*
         * stash 的判定输入(`loaded` 是那个三态状态机、`count` 是描述里的 N、
         * `sha` 用来证明「这张卡说的是哪一条 stash」)。与 `primary` 一起读,
         * 就能判「输入 / 判定 / DOM」三者是否一致。
         */
        stash: stashEntry === null
          ? null
          : { sha: stashEntry.stashSha, branchName: stashEntry.branchName, kind: stashEntry.files.kind, count: stashFileCount },
        primary,
      })} />
      <div className="content">
        <div className="interstitial-header">
          <h1>没有本地变更</h1>
          <p>这个仓库没有未提交的改动。下面是几个可以接着做的事。</p>
        </div>

        {primary !== null && (
          <div className="gw-suggested-group primary">
            {primaryCard()}
          </div>
        )}

        <div className="gw-suggested-group">
          {primaryEditor !== undefined && action('open-editor',
            '用外部编辑器打开这个仓库',
            `在 ${primaryEditor.label} 中打开`,
            () => { void store.openInExternalEditor(repoPath, primaryEditor.id); },
            editors.length > 1 ? `已检测到 ${editors.map((e) => e.label).join('、')}` : undefined)}
          {action('reveal',
            `在 ${fileManager} 中查看仓库文件`,
            isMac ? '在 Finder 中显示' : '在文件管理器中显示',
            () => { void store.revealInFileManager(repoPath); })}
          {gitHubRepo !== null && action('view-github',
            '在浏览器中打开这个仓库的 GitHub 页面',
            '在 GitHub 上查看',
            () => { window.open(`https://github.com/${gitHubRepo}`, '_blank', 'noopener'); })}
        </div>
      </div>
    </div>
  );
}
