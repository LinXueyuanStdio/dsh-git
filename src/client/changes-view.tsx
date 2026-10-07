/**
 * Changes 视图:已暂存/未暂存分组 + diff 预览 + 提交区(含 DSH 模型生成)。
 * 布局与交互对齐 GitHub Desktop 的 Changes 页。
 * @module dsh-git/client/changes-view
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from './api.ts';
import { Icon } from './icons.ts';
import { ConfirmDialog, Empty } from './bits.tsx';
import { DiffSettings } from './diff-settings.tsx';
import { DesktopDiff } from './desktop-diff.tsx';
import { getPreferredExternalEditor } from './prefs.ts';
import { SplitPane, toCommit, useSplitWidth, SIDEBAR_WIDTH_STORAGE_KEY } from './history-view.tsx';
import { networkActionInProgress } from './sync-state.ts';
import { commitPlaceholderOf, includeStateOf, prepopulateCommitSummaryOf, summaryOrPlaceholderOf } from './store.ts';
import type { GitStore, IncludeState, Snapshot } from './store.ts';
import { supportsLineSelection } from './file-kind.ts';
import type { ChangedFile } from '../core/types.ts';
import type { LineSelectionSpec } from '../core/partial-stage.ts';
import { conflictSummaryText } from '../core/status-porcelain.ts';
import { isEmptyOrWhitespace } from '../core/desktop/lib/is-empty-or-whitespace.ts';
import { createPathDisplayState } from '../core/desktop/lib/path-display.ts';
import { Checkbox, CheckboxValue } from '../core/desktop/ui/lib/checkbox.tsx';
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
   * 顶部那颗「全部暂存 / 取消暂存」与行尾两颗单文件按钮的**具名回调**。
   *
   * **为什么不能写成 JSX 内联箭头**:`react/jsx-no-bind`(`scripts/lint-baseline.json`
   * 是**只拦上升**的棘轮)会把组件作用域里的内联箭头记成新增违规。
   * 这几个回调的依赖只有 `store`(引用稳定),所以身份稳定,不会让下游行白白重渲染。
   */
  const onStageAll = useCallback(() => { void store.stageSelected(); }, [store]);
  const onUnstageAll = useCallback(() => { void store.unstageSelected(); }, [store]);
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
          */}
          <div className="gw-chead">
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
                ⭐ **「全部暂存 / 取消暂存」入口**(2026-10 接线;审计第 4 项)。
                在这之前 `store.stageSelected` / `store.unstageSelected` 是**外部 0 + 内部 0**
                调用点的真死方法(`store.ts:1073/1088`)⇒ Changes 列表**没有任何「暂存」入口**,
                用户在界面上根本没法把改动写进索引(只有提交那一步会写)。

                落点与范围(两条都要说清,否则会以为它是第二份真源):
                 · `stageSelected()` = 对 `targetedFiles()`(有选区就是选区,否则**全部变更文件**)
                   打一条 `git add -- <paths>`;`unstageSelected()` = 有选区就是选区,
                   否则**索引里真的有内容的那些文件**,打 `git reset -- <paths>`;
                 · 它们**立刻写索引**,与上面那个三态勾选框(`includeState`,提交才写索引)
                   是两条并存的语义 —— 两条都留(用户裁决「先做,不删」),差别见
                   `store.stageSelected` 的 JSDoc 里那张表。
                按钮的 disabled 依据是 git 事实(有没有未暂存/已暂存的文件),
                不是勾选状态 —— 否则会出现「有文件可暂存但按钮灰着」的假禁用。
              */}
              <span className="gw-stagebar" style={{ display: 'inline-flex', gap: 4, marginLeft: 8 }}>
                <button className="gw-btn ghost" style={{ padding: '0 6px', fontSize: 11 }}
                  disabled={files.filter((f) => f.unstaged !== undefined).length === 0}
                  title="把选中的文件(没有选中就是全部变更文件)写进索引:git add"
                  onClick={onStageAll}>
                  全部暂存
                </button>
                <button className="gw-btn ghost" style={{ padding: '0 6px', fontSize: 11 }}
                  disabled={files.filter((f) => f.staged !== undefined).length === 0}
                  title="把选中的文件(没有选中就是所有已暂存文件)从索引里撤出:git reset"
                  onClick={onUnstageAll}>
                  取消暂存
                </button>
              </span>
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
          body={`${confirmDiscard.map((f) => f.path).join('\n')}\n\n丢弃后无法从 dsh-git 恢复(已提交的内容不受影响)。`}
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
}): ReactNode {
  const { file, include } = props;
  /**
   * 行尾三颗图标的**事件回调**。`FileRow` 是**模块作用域**的组件,但它内部仍然算
   * 「组件作用域」给 `react/jsx-no-bind` 记账 —— 所以这里必须包 `useCallback`
   * (JSX 上挂具名引用),不能写 `onClick={(event) => …}`。
   * 三个回调都只是「停冒泡 + 转发给 props 上的那个动词」,没有别的逻辑。
   */
  const { onDiscard, onStage, onUnstage } = props;
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

      <div className="row">
        <button className="gw-btn" aria-disabled={form.generating || status === null || stagedCount === 0}
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
        <span className="gw-hint gw-mono" style={{ padding: 0 }} title="生成用的模型(设置里可改)">
          {snap.model === '' ? '未选模型' : snap.model.split('/').pop()}
        </span>
        <span className="grow" />
        <button className="gw-btn ghost" title="提交选项" aria-expanded={optionsOpen}
          onClick={() => setOptionsOpen((v) => !v)}>
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

      {optionsOpen && (
        <div className="gw-commit-options">
          <label className="gw-chk">
            <input type="checkbox" checked={form.noVerify}
              onChange={(event) => store.setCommitField('noVerify', event.target.checked)} />
            绕过提交钩子(Bypass Commit Hooks)
          </label>
          <label className="gw-chk">
            <input type="checkbox" checked={form.signoff}
              onChange={(event) => store.setCommitField('signoff', event.target.checked)} />
            追加 Signed-off-by(Auto Signed-off-by Trailer)
          </label>
          <label className="gw-chk">
            <input type="checkbox" checked={form.allowEmpty}
              onChange={(event) => store.setCommitField('allowEmpty', event.target.checked)} />
            允许空提交(Allow Empty Commit)
          </label>
        </div>
      )}

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
 * 「没有本地变更」空态,照 GitHub Desktop 的 `ui/changes/no-changes.tsx`。
 *
 * Desktop 的结构(`no-changes.tsx:763-785`):
 *   `<div className="changes-interstitial"><div className="content">` +
 *   头部(`<h1>No local changes</h1>` + 说明段 + 插图)+ 两组建议动作。
 * 每组动作是一张卡片(`ui/suggested-actions/suggested-action.tsx:70-92`):
 * **标题句** + 描述 + 一个按钮,按钮文字是菜单项标签。
 *
 * 建议动作(Desktop 的 `renderActions`,`:735-747`):
 *  - 主组:有 stash 就看 stash,否则按远端状态给「发布仓库 / 发布分支」;
 *  - 次组:`Open in <编辑器>` / `Show in Finder` / `View on GitHub`。
 *
 * 我们的差异:编辑器列表由 host 探测本机 `.app` 得到(Desktop 读
 * `applications(path)`);没有 stash UI,所以主组只保留发布相关。
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
  const primaryEditor = editors.find((app) => app.id === preferredEditorId) ?? editors[0];
  const remote = snap.repos.find((r) => r.path === repoPath)?.remote ?? null;
  const branch = snap.status?.branch ?? '';
  const upstream = snap.sync?.upstream ?? null;
  // 主组:无远端 → 发布仓库;有远端但无 upstream → 发布分支
  const publishRepo = remote === null;
  const publishBranch = !publishRepo && upstream === null;

  const action = (key: string, title: string, button: string, onClick: () => void, description?: string): ReactNode => (
    <div className="gw-suggested" key={key}>
      <div className="text">
        <h2>{title}</h2>
        {description !== undefined && <p className="desc">{description}</p>}
      </div>
      <button className="gw-btn" onClick={onClick}>{button}</button>
    </div>
  );

  return (
    <div className="gw-interstitial">
      <div className="content">
        <div className="interstitial-header">
          <h1>没有本地变更</h1>
          <p>这个仓库没有未提交的改动。下面是几个可以接着做的事。</p>
        </div>

        {(publishRepo || publishBranch) && (
          <div className="gw-suggested-group primary">
            {publishRepo && action('publish-repo',
              '把这个仓库发布到 GitHub',
              '发布仓库',
              () => store.toast(PUBLISH_REPOSITORY_UNAVAILABLE),
              '还没有配置任何远端。')}
            {publishBranch && action('publish-branch',
              `把 ${branch} 分支发布到远端`,
              '发布分支',
              () => { void store.runSyncAction('push'); },
              '这个分支还没有跟踪关系,推送后会自动建立。')}
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
          {remote !== null && action('view-github',
            '在浏览器中打开这个仓库的 GitHub 页面',
            '在 GitHub 上查看',
            () => { window.open(`https://github.com/${remote}`, '_blank', 'noopener'); })}
        </div>
      </div>
    </div>
  );
}
