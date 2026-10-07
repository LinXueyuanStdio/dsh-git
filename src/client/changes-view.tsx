/**
 * Changes 视图:已暂存/未暂存分组 + diff 预览 + 提交区(含 DSH 模型生成)。
 * 布局与交互对齐 GitHub Desktop 的 Changes 页。
 * @module dsh-git/client/changes-view
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from './api.ts';
import { Icon } from './icons.ts';
import { ConfirmDialog, Empty, GenerateFailureDialog } from './bits.tsx';
import { DiffSettings } from './diff-settings.tsx';
import { DesktopDiff } from './desktop-diff.tsx';
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
import { commitPlaceholderOf, includeStateOf, prepopulateCommitSummaryOf, summaryOrPlaceholderOf } from './store.ts';
import type { CommitForm, GitStore, IncludeState, Snapshot } from './store.ts';
import { supportsLineSelection } from './file-kind.ts';
import type { ChangedFile } from '../core/types.ts';
import type { LineSelectionSpec } from '../core/partial-stage.ts';
import { conflictSummaryText } from '../core/status-porcelain.ts';
import { isEmptyOrWhitespace } from '../core/desktop/lib/is-empty-or-whitespace.ts';
import { createPathDisplayState } from '../core/desktop/lib/path-display.ts';
import { Checkbox, CheckboxValue } from '../core/desktop/ui/lib/checkbox.tsx';
import { ForcePushBranchState } from '../core/desktop/lib/rebase.ts';
import { TipState } from '../core/desktop/models/tip.ts';
import { formatNumber } from '../core/desktop/lib/format-number.ts';
import { HiddenChangesWarning, isCommittingFileHiddenByFilter } from './hidden-changes-warning.tsx';
import type { IFileListFilterState } from '../core/desktop/lib/app-state.ts';
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
   * **刻意不传** `appendIgnoreFile` / `appendIgnorePattern` / `stashAll`:
   * 宿主没有那两条路由(见 `changes-file-menu.ts` 的 `GITIGNORE_ROUTE_AVAILABLE` /
   * `STASH_ROUTE_AVAILABLE`),缺动作 ⇒ 那几项**在列但诚实禁用**(不是假装能点)。
   */
  const menuActions = useMemo(() => ({
    discard: (targets: readonly ChangedFile[]) => { setConfirmDiscard([...targets]); },
    setFilesIncluded: (paths: readonly string[], included: boolean) => { store.setFilesIncluded(paths, included); },
    revealInFileManager: (absolutePath: string) => { void store.revealInFileManager(absolutePath); },
    openInExternalEditor: (absolutePath: string, appId?: string) => {
      void store.openInExternalEditor(absolutePath, appId);
    },
    copyText: (text: string) => { void navigator.clipboard?.writeText(text); },
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
      hasStash: false, // 没有 stash 路由 ⇒ 恒 false(标签因此恒不带省略号,与上游 `:563` 同形)
    }, {
      discardAll: (targets: readonly ChangedFile[]) => { setConfirmDiscard([...targets]); },
    });
  }, [store]);
  const onDiscardLinesSelected = useCallback(
    (file: string, spec: LineSelectionSpec) => { setConfirmDiscardLines({ file, spec }); },
    [],
  );
  /** 左栏宽度(变更列表 + 提交区 | diff),持久化到 `dsh-git.sidebar-width`。 */
  const split = useSplitWidth(SIDEBAR_WIDTH_STORAGE_KEY);

  const status = snap.status;
  const files = status?.files ?? [];
  /**
   * 一个文件的**纳入状态**(三态)。真值在 `store.includeState`(客户端模型),
   * 缺失 = 默认纳入(上游 `DiffSelection.fromInitialSelection(All)`)。
   */
  const stateOf = (file: ChangedFile): IncludeState => includeStateOf(snap.includeState[file.path]);
  const listed = new Set(files.map((f) => f.path));

  const selected = new Set(snap.selectedFiles);

  // ---- 筛选(照 Desktop 的 Filter Options)----
  //
  // Desktop 的**五项**就是这些(`ui/changes/changes-list-filter-options.tsx:179,188`):
  //   Included in commit / Excluded from commit / New / Modified / Deleted。
  // 我们以前的前两项是「已暂存 / 未暂存」—— 那是把索引这个**实现细节**当成 UI 主轴,
  // 本轮连同两行制一起去掉。
  const [filterText, setFilterText] = useState('');
  const [activeOptions, setActiveOptions] = useState<FilterKey[]>([]);
  const [filterOpen, setFilterOpen] = useState(false);

  /** 选项谓词。 */
  const optionPredicates: Record<FilterKey, (f: ChangedFile) => boolean> = {
    included: (f) => stateOf(f) !== 'none',
    excluded: (f) => stateOf(f) === 'none',
    new: (f) => f.untracked === true || f.staged === 'A' || f.unstaged === 'A',
    modified: (f) => f.staged === 'M' || f.unstaged === 'M',
    deleted: (f) => f.staged === 'D' || f.unstaged === 'D',
  };
  const FILTER_KEYS: FilterKey[] = ['included', 'excluded', 'new', 'modified', 'deleted'];
  const FILTER_LABELS: Record<FilterKey, string> = {
    included: '纳入提交', excluded: '排除提交', new: '新文件', modified: '已修改', deleted: '已删除',
  };
  /** 按文字 + 选项过滤。文字只匹配路径(不匹配状态字母),且**保持原顺序**(不做模糊重排)。 */
  const passes = (f: ChangedFile): boolean => {
    const query = filterText.trim().toLowerCase();
    if (query !== '' && !f.path.toLowerCase().includes(query)) { return false; }
    if (activeOptions.length === 0) { return true; }
    return activeOptions.every((key) => optionPredicates[key](f)); // 选项之间是 AND
  };
  const shown = files.filter(passes);
  /** 计数**只统计当前可见集合**(与 Desktop 的 getFilterCounts 一致,不是总数)。 */
  const optionCounts = Object.fromEntries(
    FILTER_KEYS.map((key) => [key, files.filter((f) => passes(f) && optionPredicates[key](f)).length]),
  ) as Record<FilterKey, number>;
  const visible = { total: shown.length };
  const includedCount = files.filter((f) => stateOf(f) !== 'none').length;
  const shownIncludedCount = shown.filter((f) => stateOf(f) !== 'none').length;
  /** 头部三态复选框:全部纳入 → 选中;一个都没 → 未选;部分 → 混合。 */
  const allShownIncluded = shown.length > 0 && shownIncludedCount === shown.length;
  const checkAllRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = checkAllRef.current;
    if (el === null) { return; }
    // 三态用原生 indeterminate(与 Desktop 的 Checkbox 同一套语义)
    el.indeterminate = shownIncludedCount > 0 && shownIncludedCount < shown.length;
  });

  /** 键盘导航按**界面上的顺序**走(单一列表 = 就是 filtered 顺序)。 */
  const flat: { file: ChangedFile }[] = shown.map((file) => ({ file }));

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
  const includedPaths = files.filter((f) => stateOf(f) !== 'none').map((f) => f.path);
  const visibleItems = new Map(shown.map((f) => [f.path, f]));
  const filterState: IFileListFilterState = {
    filterText,
    isIncludedInCommit: activeOptions.includes('included'),
    isExcludedFromCommit: activeOptions.includes('excluded'),
    isNewFile: activeOptions.includes('new'),
    isModifiedFile: activeOptions.includes('modified'),
    isDeletedFile: activeOptions.includes('deleted'),
  };
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

  const toggle = (file: ChangedFile, event: React.MouseEvent): void => {
    store.toggleFile(file.path, event.metaKey || event.ctrlKey || event.shiftKey);
  };

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
              <button className={`gw-filter-btn${activeOptions.length > 0 ? ' active' : ''}`}
                title={activeOptions.length > 0 ? `筛选选项(${activeOptions.length} 项生效)` : '筛选选项'}
                aria-expanded={filterOpen} onClick={() => setFilterOpen((v) => !v)}>
                <Icon name="filter" size={12} />
                <Icon name="chevron-down" size={10} />
              </button>
              <input className="gw-filter-input" placeholder="Filter"
                value={filterText} onChange={(event) => setFilterText(event.target.value)} />
              {filterOpen && (
                <FilterOptionsPopover
                  counts={optionCounts}
                  active={activeOptions}
                  labels={FILTER_LABELS}
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

          {/* 列表语义 + roving tabindex:行是可选项,不是普通 div。 */}
          <div className="gw-files" role="listbox" aria-multiselectable="true"
            aria-label="变更文件" onKeyDown={(event) => onListKeyDown(event, flat, store, selected)}>
            {files.length === 0 && (
              <Empty icon="check-circle" title="没有本地变更" body="工作区是干净的。" />
            )}
            {files.length > 0 && visible.total === 0 && (
              <Empty icon="filter" title="没有匹配的文件"
                body="没有文件符合当前的筛选条件。清掉筛选就能看到全部变更。" />
            )}
            {shown.map((file) => (
              <FileRow key={file.path} file={file} include={stateOf(file)} selected={selected.has(file.path)}
                focused={flat[0]?.file.path === file.path}
                store={store} onSelect={(event) => toggle(file, event)}
                onDiscard={discardRow}
                onStage={stageRow}
                onUnstage={unstageRow}
                onContextMenu={rowMenu}
              />
            ))}
          </div>

          {/* 告警条插在**列表与提交区之间**,与上游同一位置:
              `{this.renderStashedChanges()} {this.renderHiddenChangesWarning()} {this.renderCommitMessageForm()}`
              (`ui/changes/filter-changes-list.tsx:1387-1389`)。 */}
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
          <CommitBox store={store} snap={snap} onOpenPreferences={props.onOpenPreferences} />
          </SplitPane>
        </div>

        <div className="right">
          {files.length === 0
            ? <NoChanges store={store} snap={snap} />
            : (
              <DiffPane
                store={store}
                snap={snap}
                /*
                 * 行/块级丢弃的**确认闸门在页这一层**(上游 `ui/changes/changes.tsx:75-97`):
                 * `DiffPane` 只把「用户右键点了拿几行」交上来,弹不弹框、弹什么框由
                 * 这里决定 —— 与整文件丢弃(`confirmDiscard`)同一条分工。
                 */
                onDiscardLines={onDiscardLinesSelected}
              />
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
  onSelect: (event: React.MouseEvent) => void;
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
}): ReactNode {
  const { file, include } = props;
  /**
   * 行尾三颗图标的**事件回调**。`FileRow` 是**模块作用域**的组件,但它内部仍然算
   * 「组件作用域」给 `react/jsx-no-bind` 记账 —— 所以这里必须包 `useCallback`
   * (JSX 上挂具名引用),不能写 `onClick={(event) => …}`。
   * 三个回调都只是「停冒泡 + 转发给 props 上的那个动词」,没有别的逻辑。
   */
  const { onDiscard, onStage, onUnstage, onContextMenu } = props;
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
  // 状态图标取**工作区**那一侧(没有就用索引侧),与 Desktop 的文件行同一口径。
  const letter = file.conflicted === true ? 'U' : (file.unstaged ?? file.staged) ?? 'M';
  const meta = STATUS_META[letter] ?? { icon: 'diff-modified', kind: 'modified', label: '已修改' };
  // 目录 / 文件名分离:目录变暗,文件名保持正常色(空间不足时由 CSS 省略)
  const split = createPathDisplayState(file.path, file.path.length);
  const shown = file.oldPath !== undefined ? `${file.oldPath} → ${file.path}` : file.path;
  // 读屏文本照 Desktop(`ui/changes/changed-file.tsx:70-74`):included / partially included / not included。
  const includeLabel = include === 'all' ? '已纳入提交' : include === 'none' ? '未纳入提交' : '部分纳入提交';

  return (
    <div className={`gw-frow file${props.selected ? ' on' : ''}`} role="option"
      aria-selected={props.selected} tabIndex={props.focused ? 0 : -1}
      aria-label={`${file.path} ${meta.label} ${includeLabel}${file.conflicted === true ? ' (有冲突)' : ''}`}
      data-path={file.path} data-included={include}
      onContextMenu={contextMenuSelf} data-gw-ctx="file"
      onClick={props.onSelect} title={shown}>
      {/*
        勾选控件**是上游的 `<Checkbox>`**(`ui/lib/checkbox.tsx`,与上游一致;`changed-file.tsx:78-90`
        渲染的就是它):`<div class="checkbox-component"><input type="checkbox" tabindex="-1">`。
        三态走它的 `value`(On/Off/Mixed),由它自己在 ref 上写 `checked`/`indeterminate`。
        `tabIndex={-1}` 与上游一致:行本身响应空格键,勾选框不进 tab 序。
        **点它只改客户端纳入状态,一个 git 命令都不发**(勾选 ≠ 暂存);索引在提交时才写。
        不再传 `title` / `onClick`:上游的 `Checkbox` 没有这两个 prop,上游的提示语由
        `TooltippedContent` 提供、单击也**照常冒泡到行**(`checkbox.tsx:107` 只在双击时
        `stopPropagation`)。本面拿不到 tooltip 样式(Changes 面板不在任何 `.tooltip-host`
        子树里,见 goal 文档 §11.13),所以这里不自造 title。
      */}
      <Checkbox
        tabIndex={-1}
        value={include === 'all' ? CheckboxValue.On : include === 'none' ? CheckboxValue.Off : CheckboxValue.Mixed}
        onChange={(event) => { props.store.setFileIncluded(file.path, event.currentTarget.checked); }} />

      <span className="path-label-component">
        <span className="path-text-component" title={shown}>
          {file.oldPath !== undefined ? (
            <>
              <span className="dirname">{file.oldPath}</span>
              <Icon name="arrow-left" size={9} className="rename-arrow" />
              <span className="filename">{split.fileText}</span>
            </>
          ) : (
            <>
              {split.directoryText !== '' && <span className="dirname">{split.directoryText}</span>}
              <span className="filename">{split.fileText}</span>
            </>
          )}
        </span>
      </span>

      {file.conflict !== undefined && (
        <span className="gw-num" title={`${conflictSummaryText(file.conflict.action)}(我方 ${file.conflict.us} / 对方 ${file.conflict.them})`}>
          {conflictSummaryText(file.conflict.action)}
        </span>
      )}

      {/* statusWidth = 16,与 Desktop 的 Octicon 列一致 */}
      <span className={`status status-${meta.kind}`} title={meta.label}>
        <Icon name={meta.icon} size={13} />
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
 * 筛选选项弹层,照 Desktop 的 ui/changes/changes-list-filter-options.tsx:161-222:
 * 标题行(Filter Options + 关闭)→ 五个带计数的复选框 → 底部「清除筛选」(仅当有筛选生效)。
 * Desktop 用它的 Popover 组件(依赖 floating-ui + focus-trap);这里用绝对定位的 div,
 * 换来零依赖。计数**只统计当前可见集合**,与 Desktop 的 getFilterCounts 一致。
 * 每次点选项就关掉弹层,也是照 Desktop 的行为。
 */
function FilterOptionsPopover(props: {
  counts: Record<FilterKey, number>;
  active: readonly FilterKey[];
  labels: Record<FilterKey, string>;
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
  return (
    <div className="gw-filter-pop" role="dialog" aria-label="筛选选项">
      <div className="gw-filter-pop-head">
        <h3>筛选选项</h3>
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
      {props.active.length > 0 && (
        <div className="gw-filter-pop-foot">
          <button className="gw-btn" onClick={props.onClear}>清除筛选</button>
        </div>
      )}
    </div>
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
 * 右侧 diff 面板。三个空态:没选文件 / 读取中 / 没有可显示的差异。
 *
 * **diff 正文由移植过来的 Desktop `Diff` 渲染**(`./desktop-diff.tsx`),
 * 全插件只有这一条渲染路径;二进制也交给它(上游 `DiffType.Binary` 分支)。
 * 这里只负责它不负责的部分:空态文案与 Diff Settings 弹层。
 */
function DiffPane(props: {
  store: GitStore;
  snap: Snapshot;
  /**
   * 行/块级丢弃:把「哪几行」交给页那一层去弹确认框(上游 `ui/changes/changes.tsx`
   * 的 `onDiscardChanges` 同样是「先弹 `PopupType.ConfirmDiscardSelection`」)。
   */
  onDiscardLines: (file: string, spec: LineSelectionSpec) => void;
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
  const head = (
    <div className="gw-diff-head">
      <span className="gw-path" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        title={headPath}>{headPath}</span>
      <span className="grow" />
      {diff !== null && diff.additions > 0 && <span className="gw-diff-stat add">+{diff.additions}</span>}
      {diff !== null && diff.deletions > 0 && <span className="gw-diff-stat del">-{diff.deletions}</span>}
      <DiffSettings
        sideBySide={props.snap.sideBySide}
        onSideBySideChange={(value) => props.store.setSideBySide(value)}
        hideWhitespace={props.snap.hideWhitespace}
        onHideWhitespaceChange={(value) => { void props.store.setHideWhitespace(value); }}
        interactive
      />
    </div>
  );

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
   * 重新读配置的时机:换仓库、以及 HEAD 变了(提交 / 修改上一次提交 / 撤销提交)。
   * 上游对应的触发是 app-state 的 `commitAuthor` 变化 + `onRefreshAuthor()`
   * (`ui/changes/commit-message.tsx:492-499,798`)。**不挂** `snap` 全量:那会在每次
   * 输入摘要时打四发 host 调用。
   */
  const headSha = snap.status?.headSha ?? '';

  useEffect(() => {
    if (path === '') {
      setAuthor(null);
      return;
    }
    let dead = false;
    void (async () => {
      const [localName, localEmail, globalName, globalEmail] = await Promise.all([
        api.configGet(path, 'user.name', 'local'),
        api.configGet(path, 'user.email', 'local'),
        api.configGet(path, 'user.name', 'global'),
        api.configGet(path, 'user.email', 'global'),
      ]);
      if (dead) {
        return;
      }
      const firstNonEmpty = (
        local: typeof localName,
        global: typeof globalName,
      ): string => {
        const fromLocal = local.ok ? local.value.value : null;
        if (fromLocal !== null && fromLocal !== '') {
          return fromLocal;
        }
        const fromGlobal = global.ok ? global.value.value : null;
        return fromGlobal ?? '';
      };
      setAuthor({
        name: firstNonEmpty(localName, globalName),
        email: firstNonEmpty(localEmail, globalEmail),
      });
    })();
    return () => { dead = true; };
  }, [path, headSha]);

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
  const commit = toCommit(entry);
  if (commit.tags.length !== 0) {
    return null;
  }
  if (snap.commitForm.amend) {
    return null;
  }
  return commit;
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

/**
 * 「模型」按钮**收起时**显示的文字 —— **只有模型名**(用户 2026-10-07 第二轮裁决:
 * 「当前选中模型只用显示模型名称,不用显示 provider 名称」)。
 *
 * 找不到(宿主落盘的 pin 不在可用清单里 / 清单还没到)时退回原始 `provider/id` ——
 * 宁可显示一个丑但真实的值,也不假装它可用、更不显示空。
 * @param models - 宿主可用模型清单(`snap.models`)。
 * @param model - 当前 `provider/id`。
 */
export function modelButtonText(
  models: readonly { provider: string; id: string; name: string }[],
  model: string,
): string {
  const found = models.find((m) => `${m.provider}/${m.id}` === model);
  if (found !== undefined) {
    return found.name;
  }
  return model === '' ? '未选模型' : model;
}

/**
 * **模型选择器**的菜单项 —— 每一项是 `name · providerName`,**provider 名在末尾**
 * (用户裁决:下拉列表保持原设计)。
 *
 * ## 为什么不是原生 `<select>` + `<option label>`(实测过的,别再走回头路)
 *
 * `<option>` 的 `label` 属性看起来正好是「收起时短、列表里长」的机制,而且**在 Chromium 里
 * 收起状态确实用它**(本机 headless Chrome 实测:`Accessibility.getPartialAXTree` 里
 * combobox 的 `value` 是 `label`「Model OK」,而不是文本内容
 * 「Model OK · Provider AAAA」;截图里渲染出来的也是短的)。
 * **但同一次实测也证明下拉列表里每一项用的还是 `label`**:AX 树里两个 `option` 节点的
 * `name` 分别是 `Model OK` / `Model B` ⇒ 一旦挂上 `label`,**列表里就再也看不到 provider 名**。
 * 用户的两条要求(收起只显示模型名 / 列表里 provider 名在末尾)**互相冲突**,
 * 原生 `<select>` 满足不了 ⇒ 这里的下拉用本仓**已有的**菜单宿主
 * (`context-menu-host.tsx` 的 in-browser 菜单,与齿轮同一个机制),两处文案各自可控。
 *
 * `checked` 标出当前模型(宿主菜单会画一个 ✓)—— 这是原生 select 的「选中项高亮」的等价物。
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
}): ReactNode {
  /*
   * `onOpenPreferences` 在这里**解构出来**(而不是在回调里写 `props.onOpenPreferences`):
   * `react-hooks/exhaustive-deps` 对「依赖数组里写 `props.x`、回调里读 `props.y`」
   * 一律要求把整个 `props` 放进依赖,而 `props` 每次渲染都是新对象 ⇒ 回调恒变,
   * `useCallback` 也就白写了。解构之后依赖是**具体的那个函数**。
   */
  const { store, snap, onOpenPreferences } = props;
  const form = snap.commitForm;
  const status = snap.status;
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [confirmGenerate, setConfirmGenerate] = useState(false);
  const [confirmUndo, setConfirmUndo] = useState(false);

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


  const onKey = (event: React.KeyboardEvent): void => {
    // Cmd/Ctrl+Enter 提交(照 commit-message.tsx:693-726)
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && canCommit) {
      event.preventDefault();
      void store.commit();
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
   */
  const openGitSettings = useCallback((): void => {
    if (onOpenPreferences !== undefined) {
      onOpenPreferences();
      return;
    }
    store.toast(GIT_SETTINGS_ENTRY_NOT_WIRED);
  }, [onOpenPreferences, store]);

  const openRepositorySettings = useCallback((): void => {
    store.toast(
      `${REPOSITORY_SETTINGS_UNAVAILABLE}\n` +
      '⚠️ 注意作用域:偏好设置里的 Git 页改的是**全局** gitconfig,不会改这个仓库的身份;'
    );
  }, [store]);

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
        <button type="button" className="gw-btn ghost gw-model-select" aria-haspopup="menu"
          style={{ maxWidth: 132, minWidth: 0, flexShrink: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={`生成用的模型:${snap.model === '' ? '未选' : snap.model}(点击选择;会被记住,与设置页的「默认模型」是同一个偏好)`}
          onClick={() => { void showModelMenu(store, snap.models, snap.model); }}>
          {modelButtonText(snap.models, snap.model)}
        </button>
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
        onClick={() => { if (canCommit) void store.commit(); }}>
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

      {form.amend && hasPreviousCommit && (
        <div className="gw-hint" style={{ padding: 0 }}>
          这些改动会改写你**最近一次提交**。
          <button className="gw-btn ghost" style={{ padding: '0 4px' }}
            onClick={() => store.setCommitField('amend', false)}>停止修改</button>
          以新建一个提交。
        </div>
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
        改前这条失败走 `store.fail()` —— 对 `code === 'internal'` **不附 `detail`**、
        而且只是一条 7 秒的 toast;现在失败原样进快照(`store.generateFailure`),
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
 * 空态建议卡的**稳定标识**(探针按它断言在场/缺席,渲染成 `data-gw-suggested`)。
 *
 * 取值与上游 `ui/changes/no-changes.tsx` 的分支一一对应:
 * `publish-repo`(`:453`)`publish-branch`(`:491`)`pull`(`:540`)`push`(`:592`)
 * 四个主卡 + `open-editor`(`:305`)`reveal`(`:266`)`view-github`(`:280`)三个次卡。
 * 上游没有这个键 —— 它的「哪张卡」是由 `renderActions()` 的调用链决定的;
 * 我们把它显式化,只为了让**判据**能点名一张卡。
 */
type SuggestedKey =
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
 * | 「View your stashed changes」卡 | `:398-448` | **诚实缺席**(没有 stash UI,与顶栏同一条已登记取舍) |
 * | 推送条件的 `tagsToPush` 一半 | `:379-384` | **缺席**(宿主没有「未推送的标签」路由;不用 `tagCount` 冒充) |
 * | 编辑器清单 | `applications(path)` 读本机 `.app` | 宿主 `system/apps` 探测(`routes.ts:400`);**改选它的写侧今天 0 调用点**(`prefs.ts:162`) |
 * | 插图 `paper-stack.svg` | `:54` 的 `encodePathAsUrl` | 不渲染(我们没有该静态资源的浏览器侧分发;缺的是资产,不是逻辑) |
 */
function NoChanges(props: { store: GitStore; snap: Snapshot }): ReactNode {
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

  /** 主组要渲染哪一支(上游那一串 `if` 的结果)。`null` = 上游也不渲染任何主卡。 */
  let primary: SuggestedKey | null = null;
  if (tip.kind === TipState.Valid) {
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

  /** 主卡:上游 `renderRemoteAction()` 的五个可达分支 + 三个「无主卡」分支。 */
  const primaryCard = (): ReactNode => {
    switch (primary) {
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
