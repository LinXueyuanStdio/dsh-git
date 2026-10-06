/**
 * **「被筛选隐藏的改动仍会被提交」告警条**(`hidden-changes-warning`)。
 *
 * ## 上游在哪里 —— **没有这个文件**(先纠正任务书里那句假设)
 *
 * 任务书假设上游有 `ui/changes/hidden-changes-warning.tsx`。实测**没有**:
 * `grep -rn "hidden-changes-warning" references/desktop/app/src` 只有两处命中,都在
 * `ui/changes/filter-changes-list.tsx` 里 ——
 *
 * | 上游 | 内容 |
 * |---|---|
 * | `filter-changes-list.tsx:1393-1422` | `private renderHiddenChangesWarning = () => { … }` —— 告警条**唯一的**渲染方,一段内联 JSX |
 * | `filter-changes-list.tsx:1014` | `submitButtonAriaDescribedBy={'hidden-changes-warning'}` —— 提交按钮引用它的 id |
 *
 * 也就是说「按同相对路径与上游一致进镜像」这一步**已经满足**:那段 JSX 所在的
 * `ui/changes/filter-changes-list.tsx` **本身**就是镜像里与上游**字节一致**的文件
 * (`src/core/desktop/ui/changes/filter-changes-list.tsx`,`diff` 为空;`verify-mirror.mjs`
 * 没有为它登记任何偏离)。再往镜像里塞一个自写的 `hidden-changes-warning.tsx` 只会
 * 破坏镜像目录的语义(「这里每个文件上游都有对应物」),并让
 * `docs/changes-container-switch.md` 那句「17 files / 6,308 lines byte-identical」失真。
 * ⇒ 本文件放在**我们的层**(§2.1.3:wrapper / props 适配器写在 `src/client/`),
 * **镜像一个字没动**。
 *
 * ## 为什么不能直接用上游那个类
 *
 * `FilterChangesList` 的 props 是 `IFilterChangesListProps`(`:230-267`),要
 * `workingDirectory: WorkingDirectoryStatus` / `dispatcher: Dispatcher` / `fileListFilter` /
 * `accounts` / `repositories` / `popupHost`…,渲染体里还挂着
 * `AugmentedSectionFilterList` + `TextBox` + `Button` + `StashedChanges` + `CommitMessage`
 * 整棵子树。**它本身**就是 `docs/changes-container-switch.md` 要裁决的那件大事
 * (容器切换),不属于本泳道。
 *
 * 所以这里只把 `renderHiddenChangesWarning` 那一段**搬出来**:
 * DOM / 类名 / id / 子节点顺序与上游一致 `:1411-1419`,可见性谓词用上游那个纯函数
 * 的**逐字副本**(见下)。
 *
 * ## 谓词:上游纯函数的逐字副本(§2.1.4「只缺一个纯函数时,就沿用那个函数」)
 *
 * 上游 `filter-changes-list.tsx:1399-1407` 调的是
 * `isCommittingFileHiddenByFilter(filesSelected.map(f => f.id), this.state.filteredItems, files.length, this.props.fileListFilter)`,
 * 函数体定义在 `ui/changes/filter-changes-logic.ts:49-72`(镜像里字节一致)。
 *
 * ### 为什么留本地副本而不是 `import` —— **这是一处有意的、可退役的选择**
 *
 * `filter-changes-logic.ts:2` 写的是 `import { IChangesListItem } from './filter-changes-list'`
 * —— 一个**只被用作类型**的具名 import(**没有** `type` 关键字)。esbuild 会正确地把它
 * 整条抹掉(实证:我用 esbuild `metafile` 走真图,产物里
 * **没有** `filter-changes-list.tsx`,而 `lib/client.js` 里
 * `adjustedFiltersForHiddenChangesCount`(该文件独有的字符串)**0 命中**)。
 * 但仓库里**三支静态 import 走查器**用的是正则 `from\s+'(\.[^']+)'`
 * (`scripts/check-integration.mjs:74`、`scripts/gates-lib.mjs` 的活跃模块走查),
 * **它们分不清类型导入** ⇒ 只要本文件 `import` 那个模块,`filter-changes-list.tsx`
 * 以及它的整棵闭包(commit-message / sidebar / no-changes / stashed-changes …)
 * 就会被算成「可达」,**它们那些从来没渲染过的祖先类名会被算成「已发出」**。
 *
 * 实测(2026-10,同一棵树):
 *   · `import` 版本 ⇒ `check-unreachable-ancestors` 的**未登记祖先 62 → 28**;
 *     那少掉的 34 个里,**只有 `hidden-changes-warning` 是真的**
 *     (本组件确实渲染它),其余 33 个是
 *     `changes-list-container` / `commit-message-component` / `stashed-changes-button` /
 *     `no-changes-filtered` / `filter-popover` / `#undo-commit` … ——
 *     **一个都没渲染**。那正是 goal 文档 §10.9 说的那类「假绿」。
 *   · 本副本版本 ⇒ 未登记祖先 **62 → 61**(只少掉告警条自己那一条,可逐条归因)。
 * ⇒ 这个数字是本项目**唯一**的「Changes 容器还有多少没接」进度条,而那个容器
 *   正是**当前最大的一块未完成工作**。让进度条一次性瞎掉 34 格,比多 24 行有出处的副本
 *   贵得多。**所以先留一份本地副本,把真值留住。**
 *
 * ### 退役条件(满足任一条就删掉下面的副本,改回 `import`)
 *
 * 1. `scripts/check-integration.mjs` / `scripts/gates-lib.mjs` 的走查改成**类型感知**
 *    (例如直接用 esbuild 的 `metafile`,或至少跳过 `import type` + 只在类型位置使用的具名绑定);
 * 2. 或者上游把 `filter-changes-logic.ts:2` 写成 `import type`;
 * 3. 或者 Changes 容器真的接线完成 —— 那时 `filter-changes-list.tsx` 本来就该可达,
 *    「假绿」也就不成立了(此时 W3,`docs/handwritten-vs-upstream/1-changes-surface.md:447`,
 *    要的「逐字 import」可以直接落地)。
 *
 * ### 副本的保真度
 *
 * 函数体、`memoizeOne` 包裹、JSDoc 全部逐字来自 `filter-changes-logic.ts:46-72`;
 * **唯一的**差异是第二个形参的类型注解从 `Map<string, IChangesListItem>` 放宽成
 * `ReadonlyMap<string, unknown>` —— 因为客户端半**没有** `WorkingDirectoryFileChange`
 * 实例(`IChangesListItem` 要求它,`filter-changes-list.tsx:79-82`),而那个类型 import
 * 又会把 `filter-changes-list.tsx` 拉进走查器的图里(正是上面要避开的东西)。
 * 运行期逻辑**零改动**:谓词只读 `filteredItems.size`(`:59`)与 `filteredItems.get(fId)`
 * 的真值(`:71`),我们传进去的就是「以文件 id 为键的可见行表」。
 *
 * ## 谓词不是常量(能出现,也能消失)
 *
 * 四条输入都是界面的实时状态,四条分支(`filter-changes-logic.ts:57-71`):
 *  1. `!hasActiveFilters(filters)` ⇒ false(没筛选,不可能藏东西);
 *  2. `filteredItems.size === fileCount` ⇒ false(筛选生效但**没有**行被藏);
 *  3. `fileIdsIncludedInCommit.length > filteredItems.size` ⇒ true(要被提交的比看得见的还多);
 *  4. 否则逐 id 找:有**任何一个**要被提交的文件不在可见行里 ⇒ true。
 * 用户清掉筛选、或把被藏的文件排除掉,告警**立刻消失**。
 *
 * ## 中文化(§11.9)
 *
 * 上游三条文案写死在方法体里(`:1414` 的 `Warning:`、`:1415` 的
 * `Hidden changes will be committed. `、`:1417-1418` 的 `Adjust the filters to see all N changes`)。
 * 按 §11.9 的处理顺序(**优先在我们这层给中文**),本文件直接写中文并逐条标注对应行;
 * 镜像里那三处英文**一个字没动**,继续登记在「仍是英文」清单里(i18n 项目的输入)。
 *
 * ## 必须一起带上的那个 aria 事实(上游的悬空引用,刻意保留)
 *
 * 提交按钮硬编码 `aria-describedby="hidden-changes-warning"`
 * (`filter-changes-list.tsx:1014` → `commit-message.tsx:1626`),而该元素**只在告警出现时**
 * 渲染 ⇒ 无告警时它是一条**悬空引用**。`docs/changes-parity/E-upstream-changes-inventory.md:980`
 * 明确写「复刻请**保留**该行为」,我们照做(`changes-view.tsx` 的提交按钮无条件带上它)。
 *
 * ## 与上游的两处**有意**偏离(记账)
 *
 * 1. **`filteredItems` 的来源**:上游是组件 **state**
 *    (`onFilterListResultsChanged`,`:1181-1185`),比本次渲染**滞后一帧**;
 *    我们用同一次渲染里算出来的 `shown`。形状契约(`size` + `get(id)`)一致,
 *    效果只会**更早**正确。
 * 2. **`onAdjustFilters`**(上游 `showFilesToBeCommitted`,`:1207-1221`):
 *    上游清文字 + 关四个选项 + 只打开「纳入提交」,外加一次遥测
 *    (`incrementMetric('adjustedFiltersForHiddenChangesCount')`)。`lib/stats` 属 §1.3
 *    排除范围,遥测**刻意不做**;筛选四步在 `changes-view.tsx` 的适配函数里逐步对应。
 *
 * @module dsh-git/client/hidden-changes-warning
 */

import { createElement } from 'react';
import type { ReactNode } from 'react';
import memoizeOne from 'memoize-one';
import { LinkButton } from '../core/desktop/ui/lib/link-button.tsx';
import { Octicon } from '../core/desktop/ui/octicons/index.ts';
import * as octicons from '../core/desktop/ui/octicons/octicons.generated.ts';
import { formatNumber } from '../core/desktop/lib/format-number.ts';
import type { IFileListFilterState } from '../core/desktop/lib/app-state.ts';

/**
 * 上游 `filter-changes-logic.ts:36-45` 的 `countActiveFilterOptions` —— **逐字副本**,
 * 只把 `filters` 的类型注解沿用镜像里那个(本文件已按类型 import)。
 *
 * 它是 `hasActiveFilters` 的构件;上游把两个都放在同一个文件里,这里也照放,
 * 免得只沿用一半、将来对不上。
 *
 * @param filters - 五项筛选选项 + 文字。
 */
function countActiveFilterOptions(filters: IFileListFilterState): number {
  return [
    filters.isIncludedInCommit,
    filters.isNewFile,
    filters.isModifiedFile,
    filters.isDeletedFile,
    filters.isExcludedFromCommit,
  ].filter(Boolean).length;
}

/**
 * 上游 `filter-changes-logic.ts:83-85` 的 `hasActiveFilters` —— **逐字副本**。
 *
 * @param filters - 五项筛选选项 + 文字。
 */
function hasActiveFilters(filters: IFileListFilterState): boolean {
  return filters.filterText !== '' || countActiveFilterOptions(filters) > 0;
}

/**
 * 上游 `filter-changes-logic.ts:46-72` 的 `isCommittingFileHiddenByFilter` —— **逐字副本**
 * (`memoizeOne` 包裹与 JSDoc 一并保留)。签名差异与退役条件见本文件头部。
 *
 * @param fileIdsIncludedInCommit - 会被提交的文件 id(上游 `fileIdsIncludedInCommit`)。
 * @param filteredItems - 当前**可见**的行,键是文件 id(上游 `filteredItems`)。
 * @param fileCount - **全部**变更文件数(不是筛选后的)。
 * @param filters - 五项筛选选项 + 文字。
 */
export const isCommittingFileHiddenByFilter = memoizeOne(
  (
    fileIdsIncludedInCommit: ReadonlyArray<string>,
    filteredItems: ReadonlyMap<string, unknown>,
    fileCount: number,
    filters: IFileListFilterState
  ): boolean => {
    // All possible files are present in the list (no active filters or all files match active filters)
    if (!hasActiveFilters(filters) || filteredItems.size === fileCount) {
      return false
    }

    // If filtered rows count is 1 and included for commit rows count is 2,
    // there is no way the included for commit rows are visible regardless of
    // what they are.
    if (fileIdsIncludedInCommit.length > filteredItems.size) {
      return true
    }

    // If we can find a file id included in the commit that does not exist in
    // the filtered items, then we are committing a hidden file.
    return fileIdsIncludedInCommit.some(fId => !filteredItems.get(fId))
  }
)

/**
 * 上游 `renderHiddenChangesWarning`(`filter-changes-list.tsx:1394-1407`)读的**四个**输入,
 * 加一个回调。名字与上游调用点逐字对应,顺序也一致。
 */
export interface IHiddenChangesWarningProps {
  /**
   * 上游 `filesSelected.map(f => f.id)`(`:1396-1398`)——
   * 选区不是 `DiffSelectionType.None` 的文件(即**会被提交**的那些)。
   */
  readonly fileIdsIncludedInCommit: ReadonlyArray<string>;

  /**
   * 上游 `this.state.filteredItems`(`:1403`)——
   * **当前界面上可见的行**,键是文件 id。
   */
  readonly filteredItems: ReadonlyMap<string, unknown>;

  /** 上游 `files.length`(`:1404`)—— **全部**变更文件数(不是筛选后的)。 */
  readonly fileCount: number;

  /** 上游 `this.props.fileListFilter`(`:1405`)—— 五项选项 + 文字筛选。 */
  readonly filters: IFileListFilterState;

  /** 上游 `this.showFilesToBeCommitted`(`:1207-1221`)。 */
  readonly onAdjustFilters: () => void;
}

/**
 * 告警条。不满足谓词时**返回 `null`**(与上游 `:1409-1410` 的 `return null` 同一行为)。
 *
 * @param props - 见 `IHiddenChangesWarningProps`。
 */
export function HiddenChangesWarning(props: IHiddenChangesWarningProps): ReactNode {
  const hidden = isCommittingFileHiddenByFilter(
    props.fileIdsIncludedInCommit,
    props.filteredItems,
    props.fileCount,
    props.filters,
  );

  if (!hidden) {
    return null;
  }

  // ↓↓↓ 结构与 `filter-changes-list.tsx:1411-1419` 逐字对应(只有文案是中文化)。
  return (
    <div className="hidden-changes-warning" id="hidden-changes-warning">
      {/* 上游 `:1413` `<Octicon symbol={octicons.alert} />`。 */}
      <Octicon symbol={octicons.alert} />
      {/* 上游 `:1414` `<span className="sr-only">Warning:</span>`。
          缺 `.sr-only` 配方会让它变成**可见文本**(goal 文档 §7 那次返工)——
          配方在 `src/client/scss/desktop-changes.scss` 的 `.gw-desktop-changes` 里 `@include`。 */}
      <span className="sr-only">警告:</span>
      {/* 上游 `:1415` `<span>Hidden changes will be committed. </span>`。 */}
      <span>有改动被隐藏,仍会被一起提交。</span>
      {/*
        上游 `:1416-1418`:
          `<LinkButton onClick={this.showFilesToBeCommitted}>Adjust the filters to see all {formatNumber(filesSelected.length)} changes</LinkButton>`
        `LinkButton` 是镜像里那个组件本人(`ui/lib/link-button.tsx`),
        `formatNumber` 也是上游那个函数(`lib/format-number.ts`)。三个子节点
        (前导文字 / 数字 / 后置文字)与上游的 `{formatNumber(…)}{' '}` 结构一致 ——
        中文不需要那个空格,所以是三个而不是四个。

        ⚠️ **这里用 `createElement` 而不是 JSX,不是为了风格**:镜像的 `ILinkButtonProps`
        (`ui/lib/link-button.tsx:8-36`)**没有声明 `children`**,而上游跑的是
        `@types/react@^16.14.62`(`references/desktop/package.json:136`)——
        那一代的类组件隐式接受 children。我们钉的是 `@types/react@18.3.31`
        (`docs/type-check.md:144` 记录的取舍),它要求显式声明 ⇒
        `<LinkButton>…</LinkButton>` 会多出一条 TS2769(`Property 'children' does not
        exist on type '… & Readonly<ILinkButtonProps>'`),与镜像里一大票
        `<Button>{…}</Button>`、`history-view.tsx:537` 的 `<Resizable>` **同因**。
        `createElement` 的 children 走的是第三个**可变参数**重载,类型上成立,
        且产出的 DOM 与 JSX **逐字相同**。这样本文件对 `check-types` 棘轮是 **±0**,
        不会在 47 个存量文件之外再添一条。
      */}
      {createElement(
        LinkButton,
        { onClick: props.onAdjustFilters },
        '调整筛选,查看全部 ',
        formatNumber(props.fileIdsIncludedInCommit.length),
        ' 个改动',
      )}
    </div>
  );
}
