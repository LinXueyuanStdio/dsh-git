/**
 * Changes 左栏「变更文件列表」的**列表体** —— 把镜像的虚拟列表接线进我们的壳。
 *
 * ## 为什么有这个文件(用户原话)
 *
 * > 「**我们是抄优先**,连同部分 ui 和状态机,然后再适配。很多东西抄过来都没接入,
 * > **也缺少对应的 UI**。」
 *
 * 审计 `docs/changes-file-list-gap-audit.md` §2.2 的读数:镜像的
 * `ui/lib/list/**`(4,604 行)+ `ui/lib/section-filter-list.tsx`(808 行)= **5,412 行
 * 已经在产物里、却没有任何 Changes 侧的渲染方**;而我们的列表是
 * `{shown.map(...)}` 的 O(N) 全量渲染(`src/client/changes-view.tsx` 的 `.gw-files`),
 * `react-virtualized` 一次都没被走。本模块就是那 5,412 行的**第一个渲染方**。
 *
 * ## 接的是谁(逐个 `file:line`)
 *
 * · 列表体 = `AugmentedSectionFilterList`(`ui/lib/augmented-filter-list.tsx:247`,925 行)
 *   —— 上游 `FilterChangesList.render()` 用的就是它(`filter-changes-list.tsx:1335-1385`,
 *   `id="changes-list"` / `rowHeight={RowHeight}` = **29** / `selectionMode="multi"`)。
 * · 筛选谓词 = 镜像 `applyFilters`(`ui/changes/filter-changes-logic.ts:155-166`);
 *   文字匹配 = 镜像 `match`(`lib/fuzzy-find.ts:24-53`,上游 `createStateUpdate` 用的同一个
 *   函数,`ui/lib/filter-list.tsx:615`)。⇒ 我们的 `passes()` 子串匹配**退役**:
 *   高亮(`<mark>`)、排序、`Filter Options` 的第二半现在与上游同一份代码。
 * · 多选/范围选择 = 镜像 `SectionList`(`ui/lib/list/section-list.tsx:608-612` 的
 *   `isRangeSelection` 键盘路径、`:1589-1610` 的鼠标 shift 路径),由 `selectionMode="multi"`
 *   打开 —— 我们以前把 `shift` 当 additive 切换(`changes-view.tsx` 的 `toggle`)。
 * · 滚动位置持久化 = 镜像的 `onScroll` / `setScrollTop`(`filter-changes-list.tsx:885-887`
 *   与 `:1354`),上游由 `ui/repository.tsx:199-201` 的 `changesListScrollTop` 存。
 *
 * ## 为什么**不是**整块 `FilterChangesList`
 *
 * `FilterChangesList.render()` 的返回是四件:列表 + `renderStashedChanges()` +
 * `renderHiddenChangesWarning()` + **`renderCommitMessageForm()`**(`:1235-1240` 一族)。
 * 最后那件是上游的 `CommitMessage`(1,854 行),它**没有** DSH 的模型选择器 / provider 生成入口
 * (用户 2026-10-07 亲自要的那两个控件,`docs/probes/commit-form-selector-and-options-probe.mjs`),
 * 也与我们**保留**的左下角提交区(`src/client/changes-view.tsx` 的 `CommitBox`)冲突。
 * ⇒ 本模块只接「列表 + 筛选 + 选择」这一半;**列表体本身逐字是镜像的**,
 * 壳(表头 / 提交区 / 右栏)仍是我们的。整块容器切换要等
 * `docs/changes-container-switch.md` §4 的五条前提(36 个 Dispatcher 方法 / 8 条缺失依赖 /
 * popup host / 状态层裁决 / 闭包)全部满足。
 *
 * ## 两条渲染路径(以及它们各自的边界)
 *
 * · **有版面**(`clientHeight > 0`)⇒ 走镜像虚拟列表。
 * · **测不到高度**(jsdom 没有布局引擎;真实环境里面板被折叠到底也一样)⇒ 走同一份数据
 *   的**平铺**渲染。这条不是「给探针开后门」:没有它,镜像列表在
 *   测不到高度的容器里会**一行都不画**(`_file-list.scss:3-5` 的上游注释自己写着
 *   「without it you'll see react-virtualized just skip rendering as the available
 *   vertical space is computed as zero」)。两条路径**共用同一个行组件与同一份筛选结果**
 *   (`rows` / `matchesOf` 都由本模块算,见 `filterRows`),所以不存在第二份行模型。
 *
 * @module dsh-git/client/changes-file-list
 */

import * as React from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  IFilterListItem,
  SelectionSource,
} from '../core/desktop/ui/lib/filter-list.tsx';
import {
  findLastSelectableRow,
  findNextSelectableRow,
} from '../core/desktop/ui/lib/list/selection.ts';
import type { SelectionDirection } from '../core/desktop/ui/lib/list/selection.ts';
import { Grid } from 'react-virtualized';
import { __DARWIN__ } from './desktop-globals.ts';
import { AriaLiveContainer } from '../core/desktop/ui/accessibility/aria-live-container.tsx';
import { match } from '../core/desktop/lib/fuzzy-find.ts';
import type { IMatches } from '../core/desktop/lib/fuzzy-find.ts';
// `invalidationProps` 的浅比较用**镜像那个函数本人**(上游 `section-list.tsx:4` /
// `list.tsx:4` import 的就是它):`lib/equality.ts:21` 的 `shallowEquals`。
import { shallowEquals } from '../core/desktop/lib/equality.ts';
import { applyFilters } from '../core/desktop/ui/changes/filter-changes-logic.ts';
import type { IFileListFilterState } from '../core/desktop/lib/app-state.ts';
import {
  AppFileStatusKind,
  WorkingDirectoryFileChange,
} from '../core/desktop/models/status.ts';
import type { AppFileStatus } from '../core/desktop/models/status.ts';
import {
  DiffSelection,
  DiffSelectionType,
} from '../core/desktop/models/diff/index.ts';
import type { ChangedFile } from '../core/types.ts';
import type { IncludeState } from './store.ts';

/*
 * **为什么没有「行数门槛」**(曾经有过一个 `VirtualizeThreshold = 40`,刻意去掉了):
 * 门槛会让**小列表**在真浏览器里走平铺路径,于是 `shift` 的范围选择在小列表上
 * 又退回 additive —— 同一个界面两套鼠标语义。今天的判据只有「量得到高度」,
 * 浏览器里一律虚拟化(见 `ChangesFileList` 里 `virtual` 的算式)。
 */

/**
 * 滚动位置的**记住**(上游由 `ui/repository.tsx:199-201` 的 `changesListScrollTop` 存在
 * `IRepositoryState` 里,所以切走页签再切回来还在)。我们的 `ChangesView` 在页签切换时会被
 * 卸载,组件内的 `useState` 留不住 ⇒ 存在**模块作用域**(同一个页面会话内有效)。
 * 这是「一份状态」而不是第二份真源:唯一的写方是列表的 `onScroll`,唯一的读方是初值。
 */
let rememberedScrollTop: number | undefined;

/** 读回记住的滚动位置(初值)。 */
export function getRememberedScrollTop(): number | undefined {
  return rememberedScrollTop;
}

/** 记下滚动位置。 */
export function setRememberedScrollTop(top: number): void {
  rememberedScrollTop = top;
}

/** 上游 `filter-changes-list.tsx:85` 的行高常量。 */
const RowHeight = 29;

/** 一个可筛选的列表项:镜像模型实例 + 我们的 porcelain 行。 */
export interface IChangesRowItem extends IFilterListItem {
  /** 镜像 `WorkingDirectoryFileChange`(`ChangedFile` 与镜像谓词都要它)。 */
  readonly change: WorkingDirectoryFileChange;
  /** 我们的 porcelain 行(行组件渲染要它)。 */
  readonly file: ChangedFile;
}

/**
 * 我们的 porcelain `ChangedFile` → **镜像的** `AppFileStatus` 判别联合
 * (`models/status.ts:26-70`)。
 *
 * 上游这份数据的来源是 `git status --porcelain=v2` 的映射(app-store 里那一大段),
 * 我们的是 porcelain v1 的两位码 + `conflict` / `submodule` 附加字段
 * (`src/core/parse.ts:62-71`)。两边**输入不同、输出同形**,所以要一处适配:
 * 与 `src/client/desktop-diff.tsx:393-401` 的 `appFileStatusFor` 是**同一件事的两个调用点**
 * (`desktop-diff` 那一份服务 diff 面板、这一份服务列表行),刻意不合并 ——
 * 它们的输入类型不同(`IDesktopDiffInput` vs `ChangedFile`)。
 *
 * `T`(类型变更)在 porcelain 里只是 `M`,所以落到 `Modified` —— 与上游
 * `AppFileStatusKind` 没有 `TypeChanged` 这一支一致(`docs/changes-file-list-gap-audit.md` §3.1 #4)。
 * @param file - 我们的变更文件。
 */
export function appFileStatusOfChange(file: ChangedFile): AppFileStatus {
  const submoduleStatus = file.submodule;
  if (file.submodule !== undefined) {
    // `submoduleStatus` 是镜像 `models/status.ts` 里 `AppFileStatus` 各支的公共可选字段。
  }
  if (file.conflicted === true) {
    /*
     * 与 `desktop-diff.tsx` 的 `conflictedAppFileStatus` 同一口径:刻意**不给**
     * `conflictMarkerCount`,于是上游 `isManualConflict = !hasOwnProperty('conflictMarkerCount')`
     * 走「必须在命令行解决」那一支 —— 与我们的能力相符。
     */
    return {
      kind: AppFileStatusKind.Conflicted,
      entry: { kind: 'conflicted' },
    } as unknown as AppFileStatus;
  }
  if (file.untracked === true) {
    return { kind: AppFileStatusKind.Untracked, submoduleStatus };
  }
  const letter = file.unstaged ?? file.staged ?? 'M';
  switch (letter) {
    case 'A':
      return { kind: AppFileStatusKind.New, submoduleStatus };
    case 'D':
      return { kind: AppFileStatusKind.Deleted, submoduleStatus };
    case 'R':
      return {
        kind: AppFileStatusKind.Renamed,
        oldPath: file.oldPath ?? file.path,
        renameIncludesModifications: file.renameScore !== 100,
        submoduleStatus,
      };
    case 'C':
      return {
        kind: AppFileStatusKind.Copied,
        oldPath: file.oldPath ?? file.path,
        renameIncludesModifications: false,
        submoduleStatus,
      };
    case '?':
      return { kind: AppFileStatusKind.Untracked, submoduleStatus };
    case 'M':
    default:
      return { kind: AppFileStatusKind.Modified, submoduleStatus };
  }
}

/**
 * 客户端的纳入状态(`store.includeState` 的三态)→ 镜像 `DiffSelection`。
 *
 * `partial` 造一个「有分歧行」的对象(`DiffSelection.fromInitialSelection(All)` +
 * `withLineSelection(0, false)`)⇒ `getSelectionType()` 回 `Partial`,
 * 与镜像 `ChangedFile` 的三态勾选框(Indeterminate)对上。行号本身不重要:
 * 列表只读 `getSelectionType()`,真正的行级选区仍在 `store.includeState` 里。
 * @param include - 我们的三态纳入状态。
 */
export function diffSelectionOfInclude(include: IncludeState): DiffSelection {
  if (include === 'all') {
    return DiffSelection.fromInitialSelection(DiffSelectionType.All);
  }
  if (include === 'none') {
    return DiffSelection.fromInitialSelection(DiffSelectionType.None);
  }
  return DiffSelection.fromInitialSelection(DiffSelectionType.All).withLineSelection(0, false);
}

/**
 * 把我们的变更文件列表变成镜像列表项。
 * @param files - 我们的 porcelain 行。
 * @param includeOf - 三态纳入状态的取值函数。
 */
export function changesRowItemsOf(
  files: ReadonlyArray<ChangedFile>,
  includeOf: (file: ChangedFile) => IncludeState,
): ReadonlyArray<IChangesRowItem> {
  return files.map((file) => {
    const status = appFileStatusOfChange(file);
    const change = new WorkingDirectoryFileChange(file.path, status, diffSelectionOfInclude(includeOf(file)));
    return { id: file.path, text: [file.path], change, file };
  });
}

/** 筛选的结果:可见行(**顺序 = 上游的匹配分数序**)与每行的匹配下标。 */
export interface IFilteredChangesRows {
  readonly rows: ReadonlyArray<IChangesRowItem>;
  readonly matchesOf: ReadonlyMap<string, IMatches>;
}

/**
 * 与上游 `createStateUpdate`(`ui/lib/filter-list.tsx:603-651`)的**同一套语义**:
 * 先按文字做模糊匹配(带评分排序 + 匹配下标),再按五个筛选选项做 AND。
 *
 * 为什么在本层算(而不是让镜像列表自己算):表头那行「N changed files」的三态全选框、
 * 以及「被筛选隐藏的改动仍会被提交」那条告警条,都要在**列表之外**读到同一个可见集
 * (`changes-view.tsx` 的 `visibleItems` / `shown`)。让镜像列表自己算就只能靠
 * `onFilterListResultsChanged` 回读,那会多一帧、且在测不到高度的那条路径上根本没有这个回调
 * ⇒ 两条路径的可见集可能不一致。所以**一处算、两处用**。
 * @param files - 全部变更文件。
 * @param filters - 五个选项 + 文字(`IFileListFilterState`)。
 * @param showChangesFilter - 关掉筛选时(`showChangesFilter === false`)一律认为是「可见」。
 */
export function filterChangesRows(
  files: ReadonlyArray<ChangedFile>,
  filters: IFileListFilterState,
  showChangesFilter: boolean,
  includeOf: (file: ChangedFile) => IncludeState,
): IFilteredChangesRows {
  const items = changesRowItemsOf(files, includeOf);
  const query = showChangesFilter ? (filters.filterText || '').toLowerCase() : '';

  const matched = query
    ? match(query, items, (item) => item.text)
    : items.map((item) => ({ item, matches: undefined as IMatches | undefined }));

  const rows: IChangesRowItem[] = [];
  const matchesOf = new Map<string, IMatches>();
  for (const entry of matched) {
    if (!applyFilters(entry.item, showChangesFilter, filters)) {
      continue;
    }
    rows.push(entry.item);
    if (entry.matches !== undefined) {
      matchesOf.set(entry.item.id, entry.matches);
    }
  }

  return { rows, matchesOf };
}

/**
 * 量一个元素的**内容盒高度**,并在它变化时重渲。
 *
 * jsdom 没有布局引擎(所有高度都是 0)且没有 `ResizeObserver` ⇒ 两条都单独兜住:
 * 缺 `ResizeObserver` 时只量一次,**绝不**抛 —— 一个未捕获异常会把整棵子树卸掉
 * (`docs/probes/add-existing-repo-probe.mjs` 记过同形的一次:上游 `section-list.tsx`
 * 在构造函数里就 `new ResizeObserver`,缺它整棵列表子树卸载)。
 * @param ref - 要量的元素。
 */
function useMeasuredBox(ref: React.RefObject<HTMLElement>): { height: number; width: number } {
  const [box, setBox] = useState({ height: 0, width: 0 });
  useEffect(() => {
    const element = ref.current;
    if (element === null) {
      return;
    }
    const measure = () => { setBox({ height: element.clientHeight, width: element.clientWidth }); };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => { observer.disconnect(); };
  }, [ref]);
  return box;
}

/** 变更文件列表体的 props。 */
export interface IChangesFileListProps {
  /** 可见行(已经过 `filterChangesRows`,见那个函数上方的注释)。 */
  readonly rows: ReadonlyArray<IChangesRowItem>;
  /** 每行的匹配下标(给 `<mark>`;上游 `renderItem(item, matches)` 的第二个实参)。 */
  readonly matchesOf: ReadonlyMap<string, IMatches>;
  /** 我们的 porcelain 行 → 行组件(由 `changes-view.tsx` 提供;两条路径共用)。 */
  readonly renderRow: (item: IChangesRowItem, matches: IMatches | undefined, virtual: boolean) => React.ReactNode;
  /** 当前「在看哪个 diff」的那些文件(上游 `selectedFileIDs`)。 */
  readonly selectedPaths: ReadonlyArray<string>;
  /** 多选/范围选择的结果(上游 `onFileSelectionChanged(rows)`)。 */
  readonly onSelectionChanged: (paths: ReadonlyArray<string>, source: SelectionSource) => void;
  /** 单击一行(上游 `onItemClick`,行菜单与 diff 游标都靠它)。 */
  readonly onItemClick: (path: string, source: SelectionSource) => void;
  /** 双击一行(上游 `onChangedFileDoubleClick`)。 */
  readonly onItemDoubleClick: (path: string) => void;
  /** 右键一行(上游 `onItemContextMenu`)。 */
  readonly onItemContextMenu: (path: string, event: React.MouseEvent<HTMLDivElement>) => void;
  /** 滚动位置变化(上游 `onChangesListScrolled`)。 */
  readonly onScroll: (scrollTop: number) => void;
  /** 要回填的滚动位置(上游 `changesListScrollTop`)。 */
  readonly scrollTop: number | undefined;
  /** 0 行时的空态(上游 `renderNoItems`)。 */
  readonly renderNoItems: () => JSX.Element | null;
  /**
   * 无结果时给**读屏**的补充文案(上游 `postNoResultsMessage`,
   * `filter-changes-list.tsx:1378` 传的就是 `getNoResultsMessage(fileListFilter)`)。
   */
  readonly postNoResultsMessage?: string;
  /** aria-label(上游 `getGroupAriaLabel`)。 */
  readonly ariaLabel: string;
  /** 是否允许键盘/鼠标选择(提交中上游会挡;见 `filter-changes-list.tsx:1136-1150`)。 */
  readonly isCommitting: boolean;
  /**
   * **平铺路径**上的键盘导航(`.gw-files` 容器上的 `onKeyDown`)。
   * 虚拟路径不需要它:镜像 `SectionList` 自己管 ↑/↓/Home/End/空格
   * (`section-list.tsx:584-651`),再挂一层会**两边都动**。
   */
  readonly onPlainKeyDown?: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  /**
   * **行内容依赖的那些值** —— 上游同名 prop(`ui/lib/list/section-list.tsx:317`、
   * `list.tsx:275`;调用点 `filter-changes-list.tsx:1367-1377`)。
   *
   * 语义与上游**两个字都不差**:列表对它做**浅比较**,只有变了才
   * `grid.forceUpdate()`(`section-list.tsx:1103-1118`)。所以这个对象里
   * **只许装行内容真的会读的东西**,而且装在里面的每个值都要么是原语、要么身份稳定 ——
   * 否则浅比较恒为假,闸门等于没接(调用点的注释逐键写了理由)。
   *
   * 用 `unknown` 而不是具体类型:与上游一致(`readonly invalidationProps?: any`),
   * 而且这一层**只看相等性、不看字段**;具体形状由调用点负责。
   */
  readonly invalidationProps: unknown;
}

/**
 * 虚拟路径上的**一格** —— 存在的唯一理由:
 * **`react-virtualized` 的 `Grid` 不支持 `onRowClick` / `onRowDoubleClick` /
 * `onRowContextMenu`**(那是 `Table` 的 API;`Grid` 只认 `onSectionRendered` /
 * `onScroll` / `onScrollbarPresenceChange` 这三个回调,见
 * `node_modules/react-virtualized/dist/commonjs/Grid/Grid.js` 的 `propTypes` 与
 * `render()` —— 它**不**把 `…props` 铺到 DOM 上)。
 *
 * ⇒ 改前那三行 `<Grid onRowClick={…} onRowDoubleClick={…} onRowContextMenu={…}>`
 * **一个都不会被调用**:真浏览器里(走得就是虚拟路径)点一行既不换 diff 游标、
 * 双击也不开编辑器。**机器读数**在
 * `docs/probes/changes-virtual-list-probe.mjs` 的 `V4`/`V4b`:
 * 改前点第 300 行 ⇒ `selectedFiles` 仍是 `["src/f0000.ts"]`、双击 ⇒
 * `system/open-in-app` **0 条**;而同一份数据走全量 `map` 那条路径(`N2`)是**能用**的
 * ⇒ 红只红在虚拟路径的接线。
 *
 * 每一格收 `index`(Grid 的 `rowIndex`)而不是做事件委托:委托要把 DOM 元素反查回
 * 行下标,那是第二份真源。
 *
 * 为什么三个处理函数都用 `useCallback`:它们要挂在 JSX 上,内联箭头会被
 * `react/jsx-no-bind` 记账(本文件的存量违规已经很多,这条不许再加)。
 *
 * 右键这一格会落到这里 ⇒ `changes-view.tsx` 的 `FileRow` 在**虚拟路径**上
 * 刻意**不**再挂自己的 `onContextMenu`(`onContextMenu={props.virtual ? undefined : …}`),
 * 否则一次右键会把菜单开两遍(两条链各自调一次 `showContextualMenu`)。
 */
function VirtualCell(props: {
  /** Grid 给的绝对定位样式(`top: index*rowHeight`)。 */
  style: React.CSSProperties;
  /** 这一格的行下标。 */
  index: number;
  onSelect: (index: number, event: React.MouseEvent) => void;
  onDoubleClick: (index: number) => void;
  onContextMenu: (index: number, event: React.MouseEvent<HTMLDivElement>) => void;
  children: React.ReactNode;
}): JSX.Element {
  const { index, onSelect, onDoubleClick, onContextMenu } = props;
  const handleClick = useCallback((event: React.MouseEvent) => { onSelect(index, event); }, [onSelect, index]);
  const handleDoubleClick = useCallback(() => { onDoubleClick(index); }, [onDoubleClick, index]);
  const handleContextMenu = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    onContextMenu(index, event);
  }, [onContextMenu, index]);
  return (
    <div style={props.style} onClick={handleClick}
      onDoubleClick={handleDoubleClick} onContextMenu={handleContextMenu}>
      {props.children}
    </div>
  );
}

/** 虚拟路径键盘导航的上下文(只收它真正要用的五件东西)。 */
interface IListKeyNav {
  /** 可见行(与渲染同一份)。 */
  readonly rows: ReadonlyArray<IChangesRowItem>;
  /** 当前「在看哪个 diff」的那些文件(上游 `selectedFileIDs` / `selectedRows`)。 */
  readonly selectedPaths: ReadonlyArray<string>;
  /** 列表可视高度(量出来的 `box.height`;上游取 `SectionList.state.height`,`:698`)。 */
  readonly listHeight: number;
  /** 选择变化(上游 `onSelectionChanged`)。 */
  readonly onSelectionChanged: (paths: ReadonlyArray<string>, source: SelectionSource) => void;
  /** 把某一行滚进视口(上游 `SectionList.scrollRowToVisible`,`:996-1020`)。 */
  readonly scrollRowToVisible: (index: number) => void;
}

/**
 * 上游 `SectionList.findNextPageSelectableRow`(`ui/lib/list/section-list.tsx:683-722`)的
 * **flat 等价物**:从 `fromRow` 沿 `direction` 走,**累计行高即将超过列表高度**时停,
 * 停之前的最后一行就是新选择。
 *
 * 上游按 section 嵌套两层循环(每个 section 的起点是 `fromRow.row` 或 0);我们的列表只有
 * 一段、行高恒为 `RowHeight`,所以退化成一维循环 —— 判据(`offset + h > listHeight` 就
 * `break`)与 `newSelection` 的更新时机(`:707-716`)**逐字保留**。
 * @param rowCount - 行数。
 * @param fromRow - 出发点(上游 `selectedRows.at(-1) ?? {row:0,section:0}`,`:691-694`)。
 * @param listHeight - 列表可视高度(px)。
 * @param direction - 方向。
 */
function findNextPageRow(rowCount: number, fromRow: number, listHeight: number, direction: SelectionDirection): number {
  if (listHeight <= 0) { return fromRow; }
  let offset = 0;
  let newSelection = fromRow;
  const delta = direction === 'up' ? -1 : 1;
  for (let i = fromRow; i < rowCount && i >= 0; i += delta) {
    if (offset + RowHeight > listHeight) { break; }
    offset += RowHeight;
    newSelection = i;
  }
  return newSelection;
}

/**
 * **虚拟路径的键盘导航** —— 逐条移植上游 `ui/lib/list/section-list.tsx:584-651` 的
 * `onKeyDown`,以及它调用的 `moveSelection`(`:925-940`)/`moveSelectionTo`(`:979-996`)/
 * `addSelection`(`:855-905`)/`moveSelectionToLastSelectableRow`(`:941-951`)/
 * `addSelectionToLastSelectableRow`(`:953-977`)/`moveSelectionByPage`(`:652-680`)。
 *
 * ## 为什么不是「再挂一层镜像 `SectionList`」而是「在同一个入口上重放上游判据」
 *
 * 我们这条虚拟路径用的是 `react-virtualized` 的 `Grid` **本体**(不是镜像的
 * `SectionList`;理由见本文件 `ChangesFileList` 上方那段「为什么是 `SectionList` 而不是
 * `AugmentedSectionFilterList`」—— 镜像那一层会在每行外面再包一层 `role="option"`,
 * 打散既有四条探针的「行 = `.gw-files [role="option"]`」计数契约)。而 `Grid` 自己
 * **不认**任何键盘语义(它只认 `onScroll` / `onSectionRendered` /
 * `onScrollbarPresenceChange`),所以上游那套导航必须由我们**在按键入口上按上游判据重放**
 * —— 不是发明新键位:键位、`shift` 的范围语义、`wrap` 的有无、`Home/End` 在 macOS 上是
 * `Cmd+↑/↓`,全部照抄。
 *
 * ## 与上游逐条对应(flat 化)
 *
 * 上游的行标识是 `RowIndexPath`(`{section,row}`),我们是**扁平下标**(列表只有一段)。
 * 因此:
 *  · `createSelectionBetween(origin, row)`(`ui/lib/list/section-list-selection.ts:158-200`)
 *    在这个一维空间里就是「两下标之间的**闭区间**」⇒ `rows.slice(min, max + 1)`
 *    (顺序 = 列表顺序,与上游一致);
 *  · `findNextSelectableRow` / `findLastSelectableRow` **直接用镜像函数**
 *    (`ui/lib/list/selection.ts:89-173`,已逐字在包里)⇒ 不抄第二份必然漂移的真源;
 *  · `canSelectRow` 恒为 `true`:我们每一行都可选(没有分组头、没有置灰行),
 *    与上游 `canSelectRow` 缺省值同义(`selection.ts:92-94`)。
 *
 * @param event - 容器上的 `keydown`。
 * @param nav - 导航上下文。
 * @returns 是否处理了这个按键(`true` ⇒ 调用方直接 `return`)。
 */
function handleListKeyDown(event: React.KeyboardEvent<HTMLDivElement>, nav: IListKeyNav): boolean {
  const { rows, selectedPaths } = nav;
  if (rows.length === 0) { return false; }
  const source: SelectionSource = { kind: 'keyboard', event };
  /** 上游 `this.props.selectedRows`(顺序 = 列表顺序)。 */
  const selected = rows
    .map((row, index) => (selectedPaths.includes(row.id) ? index : -1))
    .filter((index) => index >= 0);
  const firstSelected = selected.length > 0 ? selected[0] : -1;
  const lastSelected = selected.length > 0 ? selected[selected.length - 1] : -1;
  /** 上游 `this.canSelectRow`(`:866-868`)的替身。 */
  const canSelectRow = (): boolean => true;

  /** 上游 `moveSelectionTo`(`:979-996`):单选替换 + `scrollRowToVisible`。 */
  const moveTo = (index: number): void => {
    if (index < 0 || index >= rows.length) { return; }
    nav.onSelectionChanged([rows[index].id], source);
    nav.scrollRowToVisible(index);
  };
  /** 上游 `createSelectionBetween(origin, newRow, rowCount)`(`:895-900` / `:965-969`)。 */
  const extendTo = (origin: number, index: number): void => {
    if (index < 0 || index >= rows.length) { return; }
    const from = Math.max(0, Math.min(origin, index));
    const to = Math.min(rows.length - 1, Math.max(origin, index));
    nav.onSelectionChanged(rows.slice(from, to + 1).map((row) => row.id), source);
    nav.scrollRowToVisible(index);
  };

  /*
   * `Home` 在 macOS 上是 `Cmd+ArrowUp`,`End` 是 `Cmd+ArrowDown`(`section-list.tsx:594-601`,
   * 上游注释点名 `desktop/desktop#8644`)。**不要**写成 `event.key === 'Home'` 就完事。
   */
  const isHomeKey = __DARWIN__ ? event.metaKey && event.key === 'ArrowUp' : event.key === 'Home';
  const isEndKey = __DARWIN__ ? event.metaKey && event.key === 'ArrowDown' : event.key === 'End';

  if (isHomeKey || isEndKey) {
    // 上游 `:602-620`:`moveSelectionToLastSelectableRow` / `addSelectionToLastSelectableRow`。
    const direction: SelectionDirection = isHomeKey ? 'up' : 'down';
    const index = findLastSelectableRow(direction, rows.length, canSelectRow);
    if (index !== null) {
      if (event.shiftKey) {
        extendTo(firstSelected >= 0 ? firstSelected : 0, index);
      } else {
        moveTo(index);
      }
    }
    event.preventDefault();
    return true;
  }

  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    const direction: SelectionDirection = event.key === 'ArrowUp' ? 'up' : 'down';
    if (event.shiftKey) {
      // 上游 `addSelection`(`:855-905`):方向决定「起点」与「被延长的那一端」。
      if (selected.length === 0) {
        const index = findNextSelectableRow(rows.length, { direction, row: -1 }, canSelectRow);
        if (index !== null) { moveTo(index); }
      } else {
        const from = direction === 'down' ? lastSelected : firstSelected;
        const origin = direction === 'down' ? firstSelected : lastSelected;
        // `wrap: false` —— 范围选择到端点就停(上游 `:878-884`),不会绕回另一端。
        const index = findNextSelectableRow(rows.length, { direction, row: from, wrap: false }, canSelectRow);
        if (index !== null) { extendTo(origin, index); }
      }
    } else {
      // 上游 `moveSelection`(`:925-940`):**始终**从最后一个被选中的行出发(不看方向)。
      const index = findNextSelectableRow(rows.length, { direction, row: lastSelected }, canSelectRow);
      if (index !== null) { moveTo(index); }
    }
    event.preventDefault();
    return true;
  }

  if (event.key === 'PageUp' || event.key === 'PageDown') {
    // 上游 `:621-632`:`moveSelectionByPage` / `addSelectionByPage`(`:652-722`)。
    const direction: SelectionDirection = event.key === 'PageUp' ? 'up' : 'down';
    const index = findNextPageRow(rows.length, lastSelected >= 0 ? lastSelected : 0, nav.listHeight, direction);
    if (event.shiftKey) {
      extendTo(firstSelected >= 0 ? firstSelected : 0, index);
    } else {
      moveTo(index);
    }
    event.preventDefault();
    return true;
  }

  /*
   * ---------------------------------------------------------------------------
   * **全选**(上游 `ui/lib/list/section-list.tsx:531-566` 的 `onSelectAll`)
   * ---------------------------------------------------------------------------
   *
   * 上游那 35 行逐条搬过来(只有两处结构性适配,都写在下面):
   *
   * ```ts
   * const selectionMode = this.props.selectionMode            // 我们的列表恒为 'multi'
   * if (selectionMode !== 'range' && selectionMode !== 'multi') { return }
   * event.preventDefault()
   * if (this.totalRowCount <= 0) { return }
   * const source = { kind: 'select-all' }
   * const firstRow = { section: 0, row: 0 }
   * const lastRow = { section: rowCount.length - 1, row: rowCount.at(-1) - 1 }
   * if (this.props.onSelectionChanged) {
   *   this.props.onSelectionChanged(createSelectionBetween(firstRow, lastRow, rowCount), source)
   * }
   * if (selectionMode === 'range' && this.props.onSelectedRangeChanged) {
   *   this.props.onSelectedRangeChanged(firstRow, lastRow, source)
   * }
   * ```
   *
   * | 上游 | 这里 | 为什么 |
   * |---|---|---|
   * | `createSelectionBetween(firstRow, lastRow, rowCount)` | `rows.map(r => r.id)` | 我们的列表**只有一段**(见文件头「flat 化」),所以那两行 `RowIndexPath` 张开的就是**全部可见行**,顺序与列表一致 |
   * | `selectionMode === 'range'` 那半 | 不实现 | 我们的列表是 `multi`(镜像 `SectionList` 的调用点也是 `multi`),`onSelectedRangeChanged` 只有 range 模式才有消费者 |
   *
   * ## 上游有**两条**入口,而这里只能有其中一条的等价物(如实说明)
   *
   * 1. **Windows/Linux**:`onKeyDown` 的
   *    `else if (!__DARWIN__ && event.key === 'a' && event.ctrlKey) { this.onSelectAll(event) }`
   *    (`:603-609`)。上游注释写着「Windows 的 Chromium 会在 Electron 拿到之前抢走
   *    Ctrl+A,所以 Select all 菜单项在 Windows 上按不出快捷键」——**这条分支逐字保留**。
   * 2. **macOS**:上游 `onKeyDown` **没有** Cmd+A 分支;真正的来源是 Electron 应用菜单的
   *    Edit ▸ Select All,它派发一个 `select-all` **自定义 DOM 事件**,由
   *    `onRef`(`:568-582`)在列表元素上监听。
   *
   * ⇒ 本插件**没有那个应用菜单**(浏览器插件没有 Electron 菜单),所以那一半的唯一
   * 浏览器等价物就是**系统自己的 Select All 快捷键**(macOS 的 `Cmd+A` / 其它平台的
   * `Ctrl+A`,后者与上游第 1 条逐字同一个键)。
   * **这不是「发明键位」**:`event.key === 'a'` + 平台主修饰键与上游菜单项的
   * accelerator(`CmdOrCtrl+A`)是同一个键,只是我们必须在页面里自己接住它。
   *
   * **Windows 那条分支需要多做什么**:什么都不用加 —— 它本来就是「按下时直接调
   * `onSelectAll`」,而 `onSelectAll` 自己会 `preventDefault()`(上游那一句同时挡住
   * 「选中整页文字」)。这里唯一的差别是入口位置:上游的 `onKeyDown` 挂在列表元素上,
   * 我们的 `handleListKeyDown` 由 `.gw-files` 容器的 `onKeyDown` 调用,而 Grid
   * (`tabIndex`)是它的后代 ⇒ 按键会冒泡上来,同一个入口。
   *
   * ⚠️ **刻意不挂 `select-all` DOM 事件监听器**:本插件里**没有任何生产者**会派发它
   * (那是 Electron 应用菜单的事),挂一个永远不触发的监听器就是死代码。
   */
  const isSelectAllKey = __DARWIN__
    ? event.metaKey && event.key === 'a'
    : event.ctrlKey && event.key === 'a';
  if (isSelectAllKey) {
    event.preventDefault();
    if (rows.length <= 0) { return true; }
    const selectionSource: SelectionSource = { kind: 'select-all' };
    nav.onSelectionChanged(rows.map((row) => row.id), selectionSource);
    return true;
  }

  return false;
}

/**
 * 变更文件列表体。外部 DOM 契约(**探针与既有手写 CSS 都靠它**)保持不变:
 *  `.gw-files` 容器 + 每行 `.gw-frow[data-path][role=option]`。
 *
 * ## 为什么是 `SectionList` 而不是 `AugmentedSectionFilterList`
 *
 * `AugmentedSectionFilterList`(= 上游 `FilterChangesList` 用的那个,`filter-changes-list.tsx:1335`)
 * 会在每行外面再包一层 `ListRow`,而那一层**硬编码** `role="option"`
 * (`section-list.tsx:1245`)。于是行的 DOM 变成「外层 option > 内层 option」,并且
 * `.gw-files [role="option"]` 会**数出两倍** —— 既有 4 条探针的行定位契约与
 * 「夹具自证」判据(实测:`changes-file-menu-probe` 的 F1–F13 报「行数=2,期望 1」)
 * 都建立在这个选择器上。改用 `SectionList` 直连(上游那 1,818 行的**核心列表本体**,
 * `ui/lib/list/section-list.tsx`,虚拟化 / 范围选择 / 键盘 / `invalidationProps` 全在它里面),
 * 并把「每个文件一段、段首即该行」告诉它(`sectionHasHeader`),外层包装就会是
 * `role="presentation"` ⇒ 只有我们那一层是 option,数量与语义都正确。
 *
 * `AugmentedSectionFilterList` / `SectionFilterList` 的那两个「筛选 + 分组」层因此
 * **仍未接线**(它们提供的是:内置筛选输入框、`postNoResultsMessage` 的读屏宣告、
 * 分组头)。筛选与匹配我们已经在 `filterChangesRows` 里用**同一批镜像纯函数**
 * (`match` + `applyFilters`)算好了,所以这里不缺能力,只缺那两层壳。
 */
export function ChangesFileList(props: IChangesFileListProps): React.ReactNode {
  const { rows, matchesOf, renderRow, selectedPaths, onSelectionChanged, onItemClick, onItemDoubleClick, onItemContextMenu, onScroll, scrollTop, renderNoItems, postNoResultsMessage, ariaLabel, isCommitting, onPlainKeyDown, invalidationProps } = props;

  const containerRef = useRef<HTMLDivElement>(null);
  const box = useMeasuredBox(containerRef);
  /*
   * **判据只有「量得到高度」**(不是行数门槛,理由见上面的注释)。量的是**我们自己的**
   * `clientHeight`/`clientWidth`(`useMeasuredBox`,同步读取),不是镜像列表内部的
   * `ResizeObserver` —— 见文件头「为什么不是 SectionList 的测量」。
   */
  const virtual = box.height > 0 && box.width > 0;

  /**
   * `shift` 的**锚点**(上一次不带修饰键点的那一行)。
   *
   * 上游把锚点放在 `SectionList` 的 `selectedRows[0]`(`section-list.tsx:1589-1610`:
   * `selectionOrigin = this.props.selectedRows[0]`,`createSelectionBetween(origin, row, …)`)。
   * 我们的锚点就是「当前选区里的第一行下标」,与上游同一口径。
   */
  const clickAnchor = useRef<number | null>(null);

  const onRowClick = useCallback((index: number, event: React.MouseEvent): void => {
    const item = rows[index];
    if (item === undefined) { return; }
    const additive = event.metaKey || event.ctrlKey;
    if (event.shiftKey && clickAnchor.current !== null) {
      // **范围选择**(上游 `section-list.tsx:1589-1610`):锚点到这一行之间的全部行。
      const from = Math.min(clickAnchor.current, index);
      const to = Math.max(clickAnchor.current, index);
      onSelectionChanged(rows.slice(from, to + 1).map((row) => row.id), { kind: 'mouseclick', event });
    } else if (additive) {
      const next = selectedPaths.includes(item.id)
        ? selectedPaths.filter((path) => path !== item.id)
        : [...selectedPaths, item.id];
      clickAnchor.current = index;
      onSelectionChanged(next, { kind: 'mouseclick', event });
    } else {
      clickAnchor.current = index;
      onSelectionChanged([item.id], { kind: 'mouseclick', event });
    }
    // 键盘来源(空格/回车)由镜像的语义接管:上游 `sidebar.tsx:336-349` 只处理 keyboard。
    onItemClick(item.id, { kind: 'mouseclick', event });
  }, [rows, selectedPaths, onSelectionChanged, onItemClick]);

  const onRowDoubleClick = useCallback((index: number) => {
    const item = rows[index];
    if (item !== undefined) { onItemDoubleClick(item.id); }
  }, [rows, onItemDoubleClick]);

  const onRowContextMenu = useCallback((index: number, event: React.MouseEvent<HTMLDivElement>) => {
    const item = rows[index];
    if (item !== undefined) { onItemContextMenu(item.id, event); }
  }, [rows, onItemContextMenu]);

  /**
   * **虚拟化本体**:`react-virtualized` 的 `Grid`(上游 `ui/lib/list/list.tsx:3` 与
   * `section-list.tsx:3` import 的就是它),`rowHeight = 29`(`filter-changes-list.tsx:85`)。
   * 高度/宽度由我们量出来的 `box` **直接给**(不走 `AutoSizer`,理由见文件头):
   * `AutoSizer` 依赖 `ResizeObserver` 的通知,而那个通知在 CDP/headless 页面里实测**不投递**。
   *
   * ---------------------------------------------------------------------------
   * **行重渲的稳定性 + `invalidationProps` 失效闸门**(2026-10-09)
   * ---------------------------------------------------------------------------
   *
   * ## 改前是什么样(为什么这是一条**性能**缺陷而不是风格问题)
   *
   * `Grid` 是 `PureComponent`,它的 `shouldComponentUpdate` 对**全部** prop 做浅比较。
   * 改前这个 `cellRenderer` 的依赖里有 `rows` / `matchesOf` / `renderRow` ——
   * 后两个每次 store emit 都会换身份(`rows` 是新的数组、`renderRow` 的依赖里有
   * 每帧重建的 `flat`),于是**每一次 store emit** 都让 `Grid` 的 prop 变一次 ⇒
   * 网格重渲 ⇒ **可见的每一行(jsdom/小窗口下甚至是全部行)重建一次 React 元素**。
   * 审计 `docs/changes-file-list-gap-audit.md` §3.4 #38 记的就是这一条
   * (上游有 `invalidationProps`,我们没有)。
   *
   * ## 上游怎么做的(逐条照抄,不发明第二套 memo 方案)
   *
   * · `ui/lib/list/section-list.tsx:1103-1118`(与 `list.tsx:1037-1048` 同形):
   *   在 `componentDidUpdate` 里,当「本次更新**没有**顺带把 Grid 渲过一遍」时,
   *   拿 `shallowEquals(prevProps.invalidationProps, this.props.invalidationProps)`
   *   判断行内容依赖的那些值有没有变;**变了才** `grid.forceUpdate()`。
   * · `shallowEquals` 本身用**镜像那个函数本人**(`lib/equality.ts:21`,与上游同一份)。
   * · 给下游的契约是 `filter-changes-list.tsx:1367-1377` 那张表(workingDirectory /
   *   isCommitting / focusedRow / showChangesFilter / 四个筛选开关)——我们那张表在
   *   `changes-view.tsx` 的调用点,逐项对齐。
   *
   * ## 我们这边的三条
   *
   * 1. `cellRenderer` 的身份**恒定**(依赖 `[]`):它从**ref** 里读当下这一帧的数据
   *    (`stable.current`)⇒ `Grid` 的浅比较看不见「数据换了」,因此不会自己重渲;
   * 2. 行内容真的变了(勾选三态 / 选中高亮 / 匹配下标 / 路径宽度 / 提交中…)⇒
   *    `invalidationProps` 浅比较为假 ⇒ `forceUpdate()` 把网格重新渲一遍
   *    (**这一条保证「不重渲」不是「永远不重渲」** —— 没有它,勾选框会僵住);
   * 3. `rowCount` / `width` / `height` / `scrollTop` 仍然照旧直接传:它们变的时候
   *    `Grid` 自己就会重渲(与上游「已经渲过就不再 forceUpdate」那条判据同义)。
   *
   * ⚠️ **`invalidationProps` 的浅比较看得见的是「值」**:所以调用点必须传一个
   * **只装行内容依赖**的对象(每个键要么是原语、要么是身份稳定的对象)。传一个每帧
   * 新建的 `{...}` 而里面装着每帧新建的数组,浅比较就恒为假 —— 那等于没接
   * (调用点的注释写明了每个键为什么那样给)。
   */
  const stable = useRef({
    rows, matchesOf, renderRow, onRowClick, onRowDoubleClick, onRowContextMenu,
  });
  // 每帧把**当下**这一份写进去:cellRenderer 恒定,读的永远是最新值。
  stable.current = { rows, matchesOf, renderRow, onRowClick, onRowDoubleClick, onRowContextMenu };
  const cellRenderer = useCallback((params: { key: string; style: React.CSSProperties; rowIndex: number }): React.ReactNode => {
    const now = stable.current;
    const item = now.rows[params.rowIndex];
    return (
      <VirtualCell key={params.key} style={params.style} index={params.rowIndex}
        onSelect={now.onRowClick} onDoubleClick={now.onRowDoubleClick} onContextMenu={now.onRowContextMenu}>
        {now.renderRow(item, now.matchesOf.get(item?.id ?? ''), true)}
      </VirtualCell>
    );
  }, []);
  /*
   * `Grid` **不认**这三个回调(见 `VirtualCell` 的注释),但它的浅比较**认这三个 prop** ——
   * 所以它们也必须身份恒定,否则「稳定 `cellRenderer`」被它们仨废掉。走同一份 `stable`。
   */
  const onGridRowClick = useCallback((index: number, event: React.MouseEvent) => {
    stable.current.onRowClick(index, event);
  }, []);
  const onGridRowDoubleClick = useCallback((index: number) => {
    stable.current.onRowDoubleClick(index);
  }, []);
  const onGridRowContextMenu = useCallback((index: number, event: React.MouseEvent<HTMLDivElement>) => {
    stable.current.onRowContextMenu(index, event);
  }, []);

  /**
   * 失效闸门(上游 `section-list.tsx:1103-1118` 的机制,我们这一侧的执行体)。
   *
   * 用 `useLayoutEffect` 而不是 `useEffect`:行内容的更新(勾选框三态 / 选中高亮)
   * 必须在**绘制之前**落地,否则用户会看到一帧旧勾选。
   */
  const prevInvalidation = useRef(invalidationProps);
  useLayoutEffect(() => {
    if (shallowEquals(prevInvalidation.current, invalidationProps)) { return; }
    prevInvalidation.current = invalidationProps;
    gridRef.current?.forceUpdate();
  }, [invalidationProps]);

  const onScrollGrid = useCallback((info: { scrollTop: number; clientHeight: number }) => {
    onScroll(info.scrollTop);
  }, [onScroll]);

  /**
   * 虚拟列表本体的 **ref** —— 键盘导航要把新选中的行滚进视口
   * (上游 `SectionList.scrollRowToVisible`,`section-list.tsx:996-1020`),
   * 而 `Grid` 只有拿到实例才能 `scrollToPosition`。
   */
  const gridRef = useRef<Grid>(null);

  /**
   * 把某一行滚进视口 —— 上游 `SectionList.scrollRowToVisible`(`section-list.tsx:996-1020`)。
   *
   * 上游算的是**最小滚动量**:`newScrollTop = max(cellBottom - gridHeight, min(cellTop, scrollTop))`,
   * 也就是「这一行已经在视口里 ⇒ 一点都不滚;在下面 ⇒ 只滚到它的底边贴住视口底;
   * 在上面 ⇒ 只滚到它的顶边贴住视口顶」。我们的 `sectionOffset = 0`(只有一段)、
   * `rowOffsetInSection = index * RowHeight`(行高恒为 29)。
   *
   * 与镜像 `SectionList` 的差别只有一处、且是**结构性的**:上游在滚动之后还会
   * `rowRefs.get(indexPath)?.focus({preventScroll:true})`(焦点跟着行走)。我们的键盘入口
   * 挂在**容器**上、焦点一直留在 `Grid`(`.ReactVirtualized__Grid` 有 `tabIndex`),
   * 所以不需要搬焦点 —— 也**不能**搬:行本身没有 `tabIndex`(见 `renderRow` 的 `virtual` 分支)。
   */
  const scrollRowToVisible = useCallback((index: number): void => {
    const grid = gridRef.current;
    if (grid === null) { return; }
    const rowTop = index * RowHeight;
    const minOffset = rowTop + RowHeight - box.height;
    const maxOffset = rowTop;
    const current = grid.state.scrollTop;
    const newScrollTop = Math.max(minOffset, Math.min(maxOffset, current));
    grid.scrollToPosition({ scrollLeft: 0, scrollTop: newScrollTop });
    /*
     * ⚠️ **必须同时把新位置告诉父级**(与 `scrollToPosition` 同一帧)。
     *
     * 喂给 `Grid` 的 `scrollTop` 是**受控 prop**(`changes-view.tsx` 的
     * `changesListScrollTop`),而 `Grid.getDerivedStateFromProps`
     * (`react-virtualized/dist/commonjs/Grid/Grid.js:1040-1046`)会在 `scrollToRow < 0` 时
     * 用 prop 覆盖内部 state ⇒ 只调 `scrollToPosition` 的话,紧接着的重渲
     * (选择变化本身就触发一次)会把它**回弹到旧值**。
     *
     * 上游 `SectionList` 的滚动位置是**非受控**的(父级只在 `setScrollTop` 时推一次),
     * 所以上游没有这一句;这一句是我们的**结构性适配**,语义与上游
     * `ui/repository.tsx:199-201` 的 `onChangesListScrolled` 逐条一致:位置变了就回写。
     * 读数:`docs/probes/changes-list-keyboard-probe.mjs` 的 `K5`(End ⇒ 选择到末行 **且**
     * `scrollTop > 0`)。
     */
    onScroll(newScrollTop);
  }, [box.height, onScroll]);

  /** 键盘导航上下文(给模块作用域的 `handleListKeyDown`;`useMemo` 只是不让它每帧新建)。 */
  const nav = useMemo(() => ({
    rows, selectedPaths, listHeight: box.height, onSelectionChanged, scrollRowToVisible,
  }), [rows, selectedPaths, box.height, onSelectionChanged, scrollRowToVisible]);

  const onGridKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    /*
     * **多选 + 空格/回车 = 每一行都切一遍**(上游 `section-list.tsx:792-806` 的
     * `toggleSelection`,逐字):
     *
     * ```ts
     * private toggleSelection = (event) => {
     *   this.props.selectedRows.forEach(row => {
     *     if (!this.props.onRowClick) { return }
     *     if (!isValidRow(row, this.props.rowCount)) { log.debug(…); return }
     *     this.props.onRowClick(row, { kind: 'keyboard', event })
     *   })
     * }
     * ```
     *
     * ⚠️ 改前这里取的是 `rows.findIndex(selectedPaths.includes(...))` —— **只切第一行**。
     * 于是「shift 选 5 行、按空格」只改一行的纳入状态,而上游会改 5 行。这一条与
     * `:796-802` 的两个守卫逐条对应:
     *  · `selectedRows` 的顺序 = **列表顺序**(不是选择发生的顺序)⇒ 下面按 `rows`
     *    的顺序扫,与 `handleListKeyDown` 里那份 `selected` 同一口径;
     *  · `isValidRow` ⇒ 下标必在 `[0, rows.length)`(扫描出来的,天然成立)。
     */
    const selectedRowIndices = rows
      .map((row, index) => (selectedPaths.includes(row.id) ? index : -1))
      .filter((index) => index >= 0);
    if (isCommitting && (event.key === 'Enter' || event.key === ' ')) {
      // 上游 `FilterChangesList.onItemKeyDown`(`filter-changes-list.tsx:1136-1151`)。
      event.preventDefault();
      return;
    }
    if (event.key === ' ' || event.key === 'Enter') {
      /*
       * 上游 `section-list.tsx:750-762`(`onRowKeyDown`)+ `:792-806`(`toggleSelection`):
       * `Enter` / `Space` **无论有没有选中行都 `preventDefault`**,再对**每一行**选中的行调
       * `onRowClick(…, {kind:'keyboard'})`(我们这一层 ⇒ `sidebar.tsx:336-349` 的
       * 「切换纳入提交」)。
       *
       * ⚠️ 那一句 `preventDefault` **是承重的**:`Grid` 的内层滚动容器是
       * `overflow:auto` 且此刻有焦点 ⇒ 不拦的话浏览器会把这一个 `Space` 当成
       * **翻一页**(2026-10-08 实测:`scrollTop 0 → 553`,`clientHeight=593`),
       * 于是「切换纳入」与「列表跳走」同时发生。
       * 读数:`docs/probes/changes-list-keyboard-probe.mjs` 的 `S2`(Δ 必须为 0)
       * 与 `--pre-fix`(内存里摘掉这一句 ⇒ `S2` 恰好变红)。
       */
      event.preventDefault();
      for (const rowIndex of selectedRowIndices) {
        onItemClick(rows[rowIndex].id, { kind: 'keyboard', event });
      }
      return;
    }
    if (handleListKeyDown(event, nav)) {
      return;
    }
  }, [rows, selectedPaths, isCommitting, onItemClick, nav]);

  const empty = rows.length === 0 ? renderNoItems() : null;

  return (
    <div className={`gw-files${virtual ? ' gw-files-virtual' : ''}`} ref={containerRef}
      role={virtual ? undefined : 'listbox'} aria-multiselectable={virtual ? undefined : true}
      aria-label={ariaLabel} onKeyDown={virtual ? onGridKeyDown : onPlainKeyDown}
      style={virtual ? { overflow: 'hidden' } : undefined}>
      {virtual ? (
        rows.length === 0 ? empty : (
          <Grid
            id="changes-list"
            ref={gridRef}
            width={box.width}
            height={box.height}
            rowCount={rows.length}
            rowHeight={RowHeight}
            columnCount={1}
            columnWidth={box.width}
            /*
             * ⭐ **这一句是与上游对齐的那一句**:上游两个列表都显式打开
             * `autoContainerWidth`(`ui/lib/list/section-list.tsx:1484`,
             * `ui/lib/list/list.tsx:1403` 同样)。
             *
             * 不打开时 `Grid` 把**内层滚动容器**的宽度写成 `totalColumnsWidth`
             * (= `columnWidth` = 我们量到的 `box.width`)这个**固定像素**
             * (`Grid.js:709-716` 的 `width: autoContainerWidth ? 'auto' : totalColumnsWidth`),
             * 而它自己的 `clientWidth` 在竖向滚动条出现之后会**少掉一条滚动条的宽度**
             * ⇒ 内容比客户区宽 12px ⇒ `overflow-x` 被它自己的算式打开
             * (`Grid.js:693`,它把 `verticalScrollBarSize` 算进了横向判定)⇒ **真的画出一条
             * 水平滚动条**。这就是用户报的「宽度合适却有水平滑动条」。
             * 打开之后内层容器是 `width:auto`,缩到 `clientWidth`,横向永不溢出。
             *
             * **读数**(真 Chrome、经典滚动条 12px、500 文件,`docs/probes/changes-list-hscroll-probe.mjs`):
             * 改前 Grid `clientWidth=238 / scrollWidth=250`、`hBar=12`、可信横向滚轮 Δ=12;
             * 改后 `scrollWidth == clientWidth`、`hBar=0`、Δ=0(红证在内存里摘掉这一句 ⇒ 复现改前)。
             */
            autoContainerWidth={true}
            overscanRowCount={6}
            scrollTop={scrollTop}
            onScroll={onScrollGrid}
            cellRenderer={cellRenderer}
            onRowClick={onGridRowClick}
            onRowDoubleClick={onGridRowDoubleClick}
            onRowContextMenu={onGridRowContextMenu}
          />
        )
      ) : (
        <>
          {empty}
          {rows.map((row) => (
            <React.Fragment key={row.id}>
              {renderRow(row, matchesOf.get(row.id), false)}
            </React.Fragment>
          ))}
        </>
      )}
      {/* 无结果时给读屏的补充文案(上游 `postNoResultsMessage`)。 */}
      <AriaLiveContainer message={postNoResultsMessage ?? null} />
    </div>
  );
}
