/**
 * **宿主 diff → 移植后的 Desktop `SeamlessDiffSwitcher` + `Diff`**
 * —— 全插件唯一一条 diff 渲染路径。
 *
 * ## 为什么选「客户端翻译」(而不是改 host 路由 / 直接驱动 SideBySideDiff)
 *
 * 三种接法中这里选的是 **(a) 在客户端把宿主现有 payload 翻译成 Desktop 形状**:
 *
 *  1. **翻译是无损的、而且是重算而不是转换**。宿主的 `DiffResult` 里只有统一 diff
 *     原文(`patch`),而 Desktop 的 `ITextDiff` 里那些东西(`DiffHunk` / `DiffLine`
 *     是 class,带 `.expansionType`、`.unifiedDiffStart/End`)本来就**完全由 patch 决定** ——
 *     `DiffParser` 一跑就有。所以这里不需要「把 A 模型的字段搬到 B 模型」,只需要
 *     「用 Desktop 自己的解析器再解析一次」,不存在信息丢失。
 *
 *  2. **改 host 路由(方案 b)会把一个 class 模型塞进 JSON**。Desktop 的
 *     `DiffHunk`/`DiffLine` 是 class:`expansionType` 由构造函数按 hunk 在文件里的位置算,
 *     `unifiedDiffStart`/`unifiedDiffEnd` 是解析时记下的下标。序列化成 JSON 再在客户端
 *     还原,要么丢失这些派生字段、要么在 host 侧手写一份「扁平化」形状 —— 等于把
 *     同一套解析逻辑维护两遍。
 *
 *  3. **绕过 `Diff` 直接驱动 `SideBySideDiff`(方案 c)省不下东西**,见下。
 *
 * ## 2026-10 第二轮:挂上 `SeamlessDiffSwitcher`(之前是直接挂 `Diff`)
 *
 * 上一版直接渲染 `Diff` 并把 `fileContents` 写死成 `null`。三份审计(A/B/C)独立指向
 * 同一个结论:**`SeamlessDiffSwitcher` 就是 `fileContents` 的生产者**,它 424 行、
 * 与上游字节一致、`diff-ui.ts` 早就导出,却在全仓库零渲染方。绕过它一次丢掉五件事:
 *
 * | 丢掉的 | 机制 |
 * |---|---|
 * | 语法高亮的调用链 | `SideBySideDiff.initDiffSyntaxMode` 在 `fileContents === null` 时早退(`:987-989`) |
 * | 上下文展开的开关 | `canExpandDiff()` 要求 `fileContents.canBeExpanded` ⇒ 每个 hunk 的 `expansionType` 被强制 `None`(`:1841-1843`) |
 * | 文件末尾的「向下展开」 | `applyFileContents` 用 `getTextDiffWithBottomDummyHunk` 补一个假 hunk(`:328-343`) |
 * | 加载态 | `.loading-indicator` / `.seamless-diff-switcher.loading` 类 |
 * | **10 条要求 `.seamless-diff-switcher` 祖先的 CSS** | 4 条是 `diff-contents-warning*` 的全部规则(Bidi 告警的黄底/边框),6 条是 `.panel.empty/.renamed/.binary` 的垂直居中 |
 *
 * 最后一条是审计 C 新发现的**缺陷类别**:规则在产出 CSS 里、类名也对,但**那个祖先
 * 元素不在 DOM 里** ⇒ 静默破相。`scripts/check-base-recipes.mjs` 按类名判定,抓不到它。
 * **所以这里刻意不再补一个假的 `seamless-diff-switcher` 类名**,而是真的渲染上游组件。
 *
 * ## `fileContents` 从哪来(为什么不用镜像里的 `getFileContents`)
 *
 * 镜像的 `syntax-highlighting/index.ts:52-109` 会按修订去取旧/新两份文本,但它下面两个
 * 叶子都是替身:`lib/git/show.ts` 三个函数**恒定返回 null**、`lib/file-system.ts` 直接抛错。
 * 而我们走宿主**原始字节端点**的一条路由(`GET /dsh-git/blob`,可 `Range`):
 *
 * ```
 * 新侧 = 历史 diff → blob(rev = commitish)  / 工作区 diff → blob(工作区,不带 rev)
 * 旧侧 = 历史 diff → blob(rev = parentCommitish)
 *        工作区 diff → blob(rev = 'HEAD')
 * 且只取头部:Range: bytes=0-(MaxDiffExpansionNewContentLength-1)
 * oldContents / newContents = text.split(/\r?\n/)(与上游 `getFileContents` 同一口径)
 * ```
 *
 * **为什么只取头部而不再是整份 JSON**:高亮与上下文展开只需要开头一段,而
 * `MaxDiffExpansionNewContentLength` 就是上游对「多大的文件还值得展开」的既有答案。
 * 服务端把**真实总字节数**(`x-dsh-git-size`)与「这是不是头部」(`Content-Range`)
 * 一起回,所以 `canBeExpanded` 的判据不受影响 —— 而客户端不再需要「900KB 文本上限」
 * 这个只属于 JSON 传输层的数字(`core/blob.ts` 里现在只有一个上限)。
 * 老 host(没有 blob 路由)时退回 `file-text` / `show-file` 的 JSON 形状。
 *
 * 三个刻意的取舍,每一个都写在同处注释里:
 *
 *  1. **工作区 diff 的旧侧是索引,不是 HEAD**(我们的未暂存 diff 是 index→工作区,
 *     上游是 HEAD→工作区)。宿主没有读索引 blob 的路由(`isSafeRev` 拒绝空串),
 *     所以旧侧退化成 HEAD。**它只影响 `oldContents`**:`expandTextDiffHunk` 只用
 *     `newContentLines`(`text-diff-expansion.ts:204-214`),旧侧长度只进假 hunk 的
 *     header(不渲染),而高亮 worker 目前是替身。⇒ 今天**零可观察影响**,接高亮时要一起修。
 *  2. **`truncated` 必须参与 `canBeExpanded`**。宿主的 `file-text`/`show-file` 默认
 *     `maxLines = 3000`,超限返回**被截断的文本 + truncated:true**。拿截断内容去展开,
 *     `expandTextDiffHunk` 会按行号取不存在的行,**行号静默错位**。⇒ 截断即
 *     `canBeExpanded = false`(整个文件的展开手柄都不出现),这是「宁可没有,不可错位」。
 *  3. **1MB 门槛用响应里的字节数**(`size <= MaxDiffExpansionNewContentLength`)。
 *     上游拿 Buffer 的 `.length`(字节)比这个常量;我们的 `newContents` 是行数组,
 *     拿数组长度比会几乎恒真。
 *
 * ## 可选行:显式模式,不靠 `instanceof` 猜
 *
 * Desktop 用 `canSelect(file)`(`diff-helpers.tsx:366-370`,实现是
 * `file instanceof WorkingDirectoryFileChange`)决定能不能勾选行。上一版我们恒给
 * `CommittedFileChange`,于是**整簇勾选/拖选/块选被一个 instanceof 关掉**。
 * 现在由 `IDesktopDiffProps.selectable` 显式表达(语义正是上游 `readOnly` 的反面):
 * Changes 页签传 `true`、History 传 `undefined`(历史 diff 合法地只读,上游同)。
 *
 * 两个非显然的坑(审计 A §3.4 / §3.5):
 *
 *  1. **`withSelectableLines(...)` 不能省**。`DiffSelection.fromInitialSelection(All)`
 *     造出来的 `selectableLines` 是 `null`,`getSelectionType()` 在只有部分行被 toggle 时
 *     只会报 `Partial`(`diff-selection.ts:115-118`);而 `partial-stage.ts:141-143`
 *     的 `isSelectionEmpty()` 靠 `=== None` 判定 ⇒ 一旦误判,host 会走
 *     「先 `git reset` 取消暂存这个文件」的分支(`git-service.ts:316-320`)——
 *     **用户点两下就丢掉整个文件的暂存状态**。可选中行的推导逐字照
 *     `app-store.ts:3500-3510`:`hunk.unifiedDiffStart + 行内下标`,且只收
 *     `line.isIncludeableLine()`(Add/Delete)。
 *  2. **`DiffSelection` 没有任何 accessor 读回 default/diverging 集合**
 *     (private,`diff-selection.ts:78-84`),所以回给 host 的 `LineSelectionSpec` 只能
 *     用公开 API **重建**:`getSelectionType()` 定 `kind`,`isSelected(i)` 在可选中行集合上
 *     枚举出 `diverging`。见 `selectionToSpec()`。
 *
 * ## 陈旧选区守卫(重要)
 *
 * host 的 `stageLines` **不接受客户端上传的补丁**:它自己重新 `git diff` 再按索引重建补丁
 * (`git-service.ts:326-331`)。所以**客户端渲染的那份 patch 必须仍是 host 会看到的那一份**,
 * 否则会**静默暂存错行**(不报错)。四道闸门:
 *
 *  1. `props.staging === true` / 调用方的同步 ref → 丢弃新的选区回调
 *     (这替代了 `seamless-diff-switcher.tsx:410` 的 `isLoadingDiff ? noop : onIncludeChanged`);
 *  2. **`hideWhitespaceInDiff` 时一律丢弃**:此时 patch 来自 `git diff -w` 而 host 重新
 *     取的是不带 `-w` 的 patch,行号空间不同(上游也是靠「隐藏空白时点行号只弹提示」避免);
 *  3. 调用方在真正 `stageLines` 之前**再取一次 diff 并比对 patch 文本**,不一致就中止并
 *     重取(把「从页面加载起就陈旧」缩到「一个往返」);
 *  4. 首次选中前的 `getSelectionType()` 归一化(见上),保证「取消全部行」不会退化成
 *     `Partial` 而误触整文件 reset。
 * 残留 TOCTOU:第 3 步之后到 host 自己取 diff 之间仍有窗口。彻底消除需要 host 接受/
 * 校验补丁摘要(Phase 2,需重启应用)。
 *
 * ## 拖选监听器泄漏:在**我们这层**修(审计 A §3.2)
 *
 * 上游 `side-by-side-diff-row.tsx:773-778` 的 `.line-number` div **无条件**挂
 * `onMouseDown`,`onMouseDownLineNumber`(`:942-964`)先判「隐藏空白」、再判列/数据,
 * **从不问 `isDiffSelectable`**,于是只读 diff 里按下鼠标也会走父组件的
 * `onStartSelection`(`side-by-side-diff.tsx:1246-1260`)注册 `mousemove` + once `mouseup`。
 * 而 `onEndSelection`(`:1335-1341`)在 `getSelection()` 为 `undefined`(= `canSelect` 为假)
 * 时**提前 return**,`temporarySelection` 永不清空、`mousemove` 监听器只在
 * `componentWillUnmount`(`:423`)移除 ⇒ **之后每次移动鼠标都跑一遍全行高度累加 +
 * 必要时 `scrollToRow` + 一次 `setState`**。
 *
 * 上游文件一个字节都不能改(它是这一簇里最干净的资产)。修法是在**我们的容器**上加一个
 * **捕获阶段**的 `mousedown`:当这份 diff 不可选行、且没有在「隐藏空白」模式时,
 * 拦掉落在行号 gutter(`.line-number`)上的按下 ⇒ 拖选**根本不会开始**,也就没有监听器可留。
 *
 * 为什么不干脆用一个 `mouseup` 兜底:监听器是挂在 `document` 上的、清理逻辑在组件内部,
 * 外部拿不到那个 `temporarySelection`;能真正止损的只有「不让它注册」。
 * 为什么不拦「隐藏空白」模式:那种模式下 `onMouseDownLineNumber` 会**先**弹
 * `WhitespaceHintPopover` 并 return,根本不注册监听器,拦了反而杀掉一个正常的交互。
 *
 * @module dsh-git/client/desktop-diff
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { SeamlessDiffSwitcher } from './diff-ui.ts';
import type { ChangedFile, IDiff, IFileContents, ITextDiff } from './diff-ui.ts';
import { MaxDiffExpansionNewContentLength } from './diff-ui.ts';
import { parsePatch } from './diff-rows.ts';
import { api } from './api.ts';
import { installContextMenuHost } from './context-menu-host.tsx';
import {
  isRenderableImagePath,
  loadImageView,
} from './image-diff.ts';
import type { IImageView } from './image-diff.ts';
import { ImageDiffPanel } from './image-diff-view.tsx';
import { getImageDiffType, setImageDiffType } from './diff-mode.ts';
import { useShowDiffCheckMarks } from './diff-mode.ts';
import { useDiffTabSize } from './prefs.ts';
import { fileStatusKindOf } from './file-kind.ts';
import {
  DiffSelection,
  DiffSelectionType,
  DiffType,
  ImageDiffType,
} from '../core/desktop/models/diff/index.ts';
import type { IRawDiff } from '../core/desktop/models/diff/index.ts';
import {
  AppFileStatusKind,
  CommittedFileChange,
  GitStatusEntry,
  UnmergedEntrySummary,
  WorkingDirectoryFileChange,
} from '../core/desktop/models/status.ts';
import type { AppFileStatus } from '../core/desktop/models/status.ts';
import { Repository } from '../core/desktop/models/repository.ts';
import { getOldPathOrDefault } from '../core/desktop/lib/get-old-path.ts';
import type { FileStatusKind, LineSelectionSpec } from '../core/partial-stage.ts';
import type { ChangeStatus, ConflictDetail } from '../core/types.ts';

/** 渲染一个文件 diff 需要的**宿主侧**输入(`DiffResult` 的子集 + 文件元数据)。 */
export interface IDesktopDiffInput {
  /** 仓库工作区绝对路径(Desktop `Repository.path`)。 */
  readonly repositoryPath: string;
  /** 仓库内相对路径。 */
  readonly path: string;
  /** 重命名的旧路径。 */
  readonly oldPath?: string | undefined;
  /** 统一 diff 原文(`git diff` 输出)。 */
  readonly patch: string;
  /** 宿主判定为二进制。 */
  readonly binary?: boolean | undefined;
  /** 状态字母(`M`/`A`/`D`/`R`/`C`/`U`/`?`);缺省按已修改。 */
  readonly status?: ChangeStatus | undefined;
  /** 未跟踪(用 `--no-index` 与 /dev/null 比出来的 patch)。 */
  readonly untracked?: boolean | undefined;
  /** 冲突。 */
  readonly conflicted?: boolean | undefined;
  /** 冲突分类(`conflicted` 为 true 时才有)。 */
  readonly conflict?: ConflictDetail | undefined;
  /**
   * 新侧修订(`CommittedFileChange.commitish`)。
   *
   * 历史 diff 必须传真实 sha:镜像的 `getFileContents` 与我们的 `show-file` 都按它取
   * 「新」侧内容(空串会构造出 `git show :path` 这种不存在的对象名)。
   * 工作区 diff 不传。
   */
  readonly commitish?: string | undefined;
  /** 旧侧修订(`CommittedFileChange.parentCommitish`);历史 diff 的第一父提交。 */
  readonly parentCommitish?: string | undefined;
}

/** `DesktopDiff` 的 props。 */
export interface IDesktopDiffProps {
  readonly input: IDesktopDiffInput;
  /** Unified / Split(来自 Diff Settings 弹层,已持久化)。 */
  readonly showSideBySideDiff: boolean;
  /** 当前 diff 是不是用 `git diff -w` 取的。 */
  readonly hideWhitespaceInDiff: boolean;
  /** 用户在 Diff Settings 里改了「隐藏空白改动」→ 调用方重取 diff。 */
  readonly onHideWhitespaceInDiffChanged: (checked: boolean) => void;
  /** 二进制文件那个「用外部程序打开」按钮;缺省则不响应(上游 `BinaryFile` 仍然照画)。 */
  readonly onOpenBinaryFile?: ((fullPath: string) => void) | undefined;
  /**
   * **可交互模式**(上游 `readOnly === false`,见 `ui/diff/index.tsx:46-51`):
   * 行/块勾选、拖选、check-all 可用。**只有 Changes 页签传 `true`**;
   * History 是历史 diff,只读是正确语义(上游 `selected-commits.tsx:161` 传 `readOnly={true}`)。
   */
  readonly selectable?: boolean | undefined;
  /**
   * 这个文件当前的**提交纳入状态**(= Desktop 的 `WorkingDirectoryFileChange.selection`)。
   *
   * 这是**唯一真值源**:它同时驱动左栏文件行的勾选框(All/None/Partial 三态)
   * 与 diff 里每一行的勾选列。缺失 = `All`(上游默认纳入提交)。
   *
   * 为什么必须由外面传进来:勾选是**客户端模型**(勾选 ≠ 暂存),真值在 store 里;
   * 渲染层只是它的一个视图。以前这里恒造 `fromInitialSelection(All)`,于是
   * 「文件没勾选、diff 却全勾」——用户两次驳回的正是这一点。
   */
  readonly selection?: LineSelectionSpec | undefined;
  /**
   * 行/文件选区变化 → 调用方写**客户端模型**(`selectable` 为真时才可能被调用)。
   *
   * **不是**「写索引」:索引只在 `commit()` 那一刻按这个模型 materialize。
   */
  readonly onSelectionChanged?: ((spec: LineSelectionSpec) => void) | undefined;
  /**
   * 给一个有确定高度的框(320px),用于**没有可分配高度**的容器(History 页签里是滚动区)。
   * 缺省时容器 `flex:1;min-height:0`,由父级 flex 分配高度。
   *
   * 为什么这件事必须由组件负责:上游 `SideBySideDiff` 用 `react-virtualized` 的
   * `<AutoSizer>` 量父元素高度,量到 0 就一行都不画(不报错、只是空白)。
   */
  readonly bounded?: boolean | undefined;
}

/** 一个空的「可选中行」集合(二进制 / 空 diff 用)。 */
const NO_SELECTABLE_LINES: ReadonlySet<number> = new Set<number>();

/**
 * 装上右键菜单宿主(diff 正文的 Copy / Select All / Expand Whole File /
 * Collapse Expanded Lines 都靠它)。
 *
 * 在模块作用域调用:`side-by-side-diff.tsx:61` 是从 `lib/menu-item` 取的那个
 * `showContextualMenu`,默认实现只打印一行日志;必须在任何一次右键**之前**装好。
 * `installContextMenuHost()` 幂等,且 `context-menu-host.tsx` 自己 import 时也会装一次。
 */
installContextMenuHost();

/** 空 patch / 畸形 patch 时的降级:`ITextDiff` 但 0 个 hunk。 */
function emptyTextDiff(text: string): ITextDiff {
  return {
    kind: DiffType.Text,
    text,
    hunks: [],
    maxLineNumber: 0,
    hasHiddenBidiChars: false,
  };
}

/**
 * `patch` → Desktop `IDiff`。
 *
 * 只可能与 `DiffType.Text` / `DiffType.Binary` 两种:
 *  - **图片**不从这里走:`DesktopDiff` 在调它之前就按 `isRenderableImagePath` + 宿主
 *    的二进制判定分流到 `ImageDiffPanel`(URL 渲染,见 `image-diff-view.tsx`),
 *    所以 `DiffType.Image` 这条上游分支在本插件里仍不被走到;
 *  - `DiffType.Submodule` 需要 host 给出子模块状态,尚未接;
 *  - `DiffType.LargeText` / `Unrenderable` 需要 host 给出「太大」信号。
 *    **本轮补上了半个**:`diff` 路由现在会因 `stdoutTruncated` 响亮报错
 *    (真实大小 + 4MiB 收集器上限),而不是把截尾的补丁当完整内容交下来。
 * @param patch - 统一 diff 原文。
 * @param binary - 宿主对二进制的判定。
 */
export function desktopDiffFromPatch(patch: string, binary: boolean): IDiff {
  if (binary) {
    return { kind: DiffType.Binary };
  }
  if (patch.trim() === '') {
    return emptyTextDiff(patch);
  }

  let raw: IRawDiff;
  try {
    raw = parsePatch(patch);
  } catch {
    // 畸形 diff(最典型的是冲突文件的 `diff --cc` 组合 diff,以及被宿主 4MB 截尾的
    // 超大 patch):不给渲染层抛错,交给 `Diff` 自己的 0-hunk 分支按文件状态给文案。
    // 注意:后者今天会渲染成「没有可显示的差异」而**不告诉用户是太大**。
    return emptyTextDiff(patch);
  }
  if (raw.isBinary) {
    return { kind: DiffType.Binary };
  }

  return {
    kind: DiffType.Text,
    text: patch,
    hunks: raw.hunks,
    maxLineNumber: raw.maxLineNumber,
    hasHiddenBidiChars: raw.hasHiddenBidiChars,
  };
}

/** 我们记录的 `'M'|'A'|'D'|'R'|'C'|'U'|'?'` → Desktop 的 `GitStatusEntry`。 */
function toGitStatusEntry(letter: string | undefined): GitStatusEntry {
  switch (letter) {
    case 'A': return GitStatusEntry.Added;
    case 'D': return GitStatusEntry.Deleted;
    case 'R': return GitStatusEntry.Renamed;
    case 'C': return GitStatusEntry.Copied;
    case 'U': return GitStatusEntry.UpdatedButUnmerged;
    case '?': return GitStatusEntry.Untracked;
    default: return GitStatusEntry.Modified;
  }
}

/**
 * 冲突文件 → `AppFileStatusKind.Conflicted`。
 *
 * 刻意**不给** `conflictMarkerCount`:Desktop 的
 * `isManualConflict = !hasOwnProperty('conflictMarkerCount')`(`models/status.ts`),
 * 于是「没有 hunk 的冲突 diff」会走上游那条「必须在命令行解决」的分支 ——
 * 这与我们的能力相符(dsh-git 没有冲突解决界面)。
 * @param conflict - 宿主给出的冲突分类。
 */
function conflictedAppFileStatus(conflict: ConflictDetail | undefined): AppFileStatus {
  const action = conflict?.action ?? 'BothModified';
  return {
    kind: AppFileStatusKind.Conflicted,
    entry: {
      kind: 'conflicted',
      action: UnmergedEntrySummary[action],
      us: toGitStatusEntry(conflict?.us),
      them: toGitStatusEntry(conflict?.them),
    },
  } as unknown as AppFileStatus;
}

/**
 * 输入元数据 → `AppFileStatus`。
 * @param input - 当前文件。
 * @param hasHunks - 解析出来的 hunk 数是否为 0;只影响「重命名但没改动」那一句文案。
 */
function appFileStatusFor(input: IDesktopDiffInput, hasHunks: boolean): AppFileStatus {
  if (input.conflicted === true) {
    return conflictedAppFileStatus(input.conflict);
  }
  if (input.untracked === true) {
    return { kind: AppFileStatusKind.Untracked };
  }

  switch (input.status) {
    case 'A':
      return { kind: AppFileStatusKind.New };
    case 'D':
      return { kind: AppFileStatusKind.Deleted };
    case 'R':
      return {
        kind: AppFileStatusKind.Renamed,
        oldPath: input.oldPath ?? input.path,
        renameIncludesModifications: hasHunks,
      };
    case 'C':
      return {
        kind: AppFileStatusKind.Copied,
        oldPath: input.oldPath ?? input.path,
        renameIncludesModifications: false,
      };
    case 'U':
      return conflictedAppFileStatus(input.conflict);
    case '?':
      return { kind: AppFileStatusKind.Untracked };
    default:
      return { kind: AppFileStatusKind.Modified };
  }
}

/**
 * 构造 Desktop 的 `ChangedFile`。
 *
 * `selection === null` ⇒ `CommittedFileChange`(只读:`canSelect()` 为假)。
 * 否则 ⇒ `WorkingDirectoryFileChange`(`instanceof` 判定为真,整簇选区交互打开)。
 * @param input - 当前文件。
 * @param hasHunks - 解析出来的 hunk 数是否为 0。
 * @param selection - 可交互模式下的初始选区;只读模式传 `null`。
 */
function changedFileFor(
  input: IDesktopDiffInput,
  hasHunks: boolean,
  selection: DiffSelection | null,
): ChangedFile {
  const status = appFileStatusFor(input, hasHunks);
  if (selection === null) {
    return new CommittedFileChange(
      input.path,
      status,
      input.commitish ?? '',
      input.parentCommitish ?? '',
    );
  }
  return new WorkingDirectoryFileChange(input.path, status, selection);
}

/**
 * 全部**可选中行**的行号集合。
 *
 * 逐字照 `references/desktop/app/src/lib/stores/app-store.ts:3500-3510`:
 * 索引是 `hunk.unifiedDiffStart + 行内下标`,且只收 `line.isIncludeableLine()`
 * (= Add / Delete;hunk 头与 context 行都不是可选行)。
 *
 * **这是不踩 Trap 1 的唯一办法**:不给 `DiffSelection` 装这个集合,
 * `getSelectionType()` 在部分选中的情况下只会报 `Partial`,而 host 的
 * `isSelectionEmpty()` 靠 `=== None` 判定 ⇒ 用户取消全部行时反而会走
 * 「`git reset` 整个文件」的分支。
 * @param diff - 解析后的文本 diff(未展开的原始模型)。
 */
export function selectableLineIndicesIn(diff: ITextDiff): ReadonlySet<number> {
  const indices = new Set<number>();
  for (const hunk of diff.hunks) {
    hunk.lines.forEach((line, index) => {
      if (line.isIncludeableLine()) {
        indices.add(hunk.unifiedDiffStart + index);
      }
    });
  }
  return indices;
}

/**
 * `DiffSelection` → host 的 `LineSelectionSpec`(Trap 2)。
 *
 * 为什么只能「重建」:`DiffSelection` 的 `defaultSelectionType` / `divergingLines` /
 * `selectableLines` 全是 private 且**没有任何 getter**(`diff-selection.ts:78-84`)。
 * 不能为了拿它们去改镜像文件,所以走公开 API:
 *
 *  - `getSelectionType()` 定基准:只有 `None`(一个都没选)才用 `kind:'none'`,
 *    其余(`All` / `Partial`)都用 `kind:'all'` 并以 `diverging` 列出被**取消**的行;
 *  - `isSelected(i)` 在可选中行集合上枚举出与基准相反的那些行 = `diverging`。
 *
 * 结果恒等:`toDiffSelection(spec)` 先 `fromInitialSelection(kind).withSelectableLines(set)`
 * 再逐行 toggle diverging(`partial-stage.ts:101-115`),还原出同一个映射;
 * 且「全部行都不选」时 `getSelectionType()` 直接返回 `None`,`diverging` 为空,
 * `isSelectionEmpty()` 因此**不会**误判(那正是会触发整文件 `git reset` 的那条路)。
 *
 * **已知边界(上游同样存在,标 HYPOTHESIS 待真机确认)**:`SideBySideDiff` 内部向下/向上
 * 展开 hunk 后,行模型的下标会整体平移(`text-diff-expansion.ts:308-311` 把新上下文行
 * **插在**被展开行之前,而 `unifiedDiffStart` 不变)。此时点某一行算出来的下标落在
 * 「展开后的空间」里,而这里的 `selectable` 集合是**未展开**的空间 ⇒ `withRangeSelection`
 * 的 `isSelectable` 检查会把这次 toggle **丢掉**(点击看起来没反应),极端情况下撞上
 * 另一个可选行号则会**点错行**。上游 `app-store.ts:3500-3510` 的 selectable 集合同样取自
 * 未展开的 diff,所以这是**共有缺陷**;本层用「选区没变就不回调」把它降级成无声的空操作。
 * 彻底修法在 Phase 2(host 侧改吃「旧/新行号对」而不是补丁内绝对下标)。
 * 反证方式:展开一个 hunk 的上下文后点一条变更行的行号,看它是否进/出提交。
 * @param selection - 组件回传的选区。
 * @param selectable - 我们推导的可选中行集合(必须与选区构造时用的是同一个)。
 */
export function selectionToSpec(
  selection: DiffSelection,
  selectable: ReadonlySet<number>,
): LineSelectionSpec {
  const indexes = [...selectable].sort((a, b) => a - b);
  // 只有「一个都没选」才用 none 基准,其余用 all 基准并以 diverging 列出被取消的行。
  const kind: 'all' | 'none' =
    selection.getSelectionType() === DiffSelectionType.None ? 'none' : 'all';

  const diverging: number[] = [];
  for (const index of indexes) {
    const selected = selection.isSelected(index);
    if (kind === 'all' ? !selected : selected) {
      diverging.push(index);
    }
  }

  return { kind, diverging, selectable: indexes };
}

/**
 * `LineSelectionSpec` → `DiffSelection`(`selectionToSpec` 的逆)。
 *
 * 为什么不直接 import `core/partial-stage.ts` 的 `toDiffSelection`:
 * 那个模块还带着**宿主侧**的补丁生成器(`desktop/lib/patch-formatter.ts` 等),
 * 而浏览器半只需要这 6 行构造逻辑。两者必须互逆,所以探针里拿 host 的
 * `toDiffSelection` 与它做过**逐行等价比对**(而不是靠肉眼看)。
 * @param spec - 纳入状态(缺失 = 全选)。
 * @param selectable - 这个文件当前可选中的行号集合。
 */
export function specToSelection(
  spec: LineSelectionSpec | undefined,
  selectable: ReadonlySet<number>,
): DiffSelection {
  /*
   * ⚠️ 2026-10 修正(真 Chrome 实测,不是推断):缺省分支**原来写的是 `spec ?? {…}`** ——
   * 也就是说「这个文件还没有纳入状态」时,基准虽然是 `kind:'all'`,但
   * `specToSelection` 会去读 **`spec.selectable`**(`spec.selectable === undefined` ⇒
   * `withSelectableLines(new Set(undefined))` ⇒ **可选行集合为空**)。
   * 后果:页面刚加载时每个文件都走这一支 ⇒ **diff 的行勾选列一个勾都不画**,
   * 而左栏文件行的勾选框却是「已纳入」。这正是用户报的「明明有勾选但 diff view 没联动」
   * 的第一层机制(左栏读 `includeState` 的缺省语义,右栏读 `spec.selectable`)。
   *
   * 现在的语义:缺省 = `All`,且可选行集合用**调用方推导出来的那一份**
   * (`selectable` 参数),与「这个文件哪些行可选」只有一处来源。
   */
  const base = spec ?? { kind: 'all' as const, diverging: [], selectable: [...selectable] };
  /*
   * spec 自带的 `selectable`(store 里存的那份)只用于 `setFileIncluded` 的
   * 「保留已知集合」;真正构造 `DiffSelection` 时**一律用调用方当次推导的集合** ——
   * 因为那才是与屏幕上这份 patch 同一坐标系的集合(展开 hunk、隐藏空白、文件换了
   * 都会让它变),而 store 里那份是上一份 patch 留下的。
   */
  let selection = DiffSelection
    .fromInitialSelection(base.kind === 'all' ? DiffSelectionType.All : DiffSelectionType.None)
    .withSelectableLines(new Set(selectable));
  for (const index of base.diverging) {
    if (!selectable.has(index)) {
      continue;
    }
    selection = selection.withToggleLineSelection(index);
  }
  return selection;
}

/** 读一段文本内容的结果;`null` 表示「读不到 / 不是文本」。 */
interface ITextRead {
  readonly lines: string[];
  /** 服务端报的**字节数**(1MB 门槛按字节,见文件头取舍 3)。 */
  readonly size: number;
  readonly truncated: boolean;
}

/** `api.fileText` → 行数组(**老 host 兜底**:没有 blob 路由时才走)。 */
async function readLegacyWorktreeText(repoPath: string, file: string): Promise<ITextRead | null> {
  const result = await api.fileText(repoPath, file);
  if (!result.ok || result.value.kind !== 'text') {
    return null;
  }
  return {
    lines: result.value.text.split(/\r?\n/),
    size: result.value.size,
    truncated: result.value.truncated,
  };
}

/** `api.showFile`(某修订下的 blob)→ 行数组(**老 host 兜底**)。 */
async function readLegacyRevText(repoPath: string, rev: string, file: string): Promise<ITextRead | null> {
  const result = await api.showFile(repoPath, rev, file);
  if (!result.ok || result.value.kind !== 'text') {
    return null;
  }
  return {
    lines: result.value.text.split(/\r?\n/),
    size: result.value.size,
    truncated: result.value.truncated,
  };
}

/**
 * 读一段文本内容 —— 走 `GET /dsh-git/blob` 的**头部区间**,不再是整份 JSON。
 *
 * 为什么只取头部:高亮与上下文展开都只关心文件开头的一段,而
 * `MaxDiffExpansionNewContentLength`(上游 `syntax-highlighting/index.ts:31`,
 * 1MiB−1)**就是上游对「多大的文件还值得展开」的答案**。有了 `Range`,客户端只取
 * 这一段,host 连「读文件」都只读到这一段 —— 打开一个 300MB 的日志不再意味着
 * 把 300MB 读进内存再丢掉。
 *
 * `size` 是服务端报的**真实字节数**(`x-dsh-git-size`),`truncated` 表示只拿到头部;
 * 两者都由服务端给出,客户端不猜 —— 这正是「删掉 900KB 文本上限」之后
 * `canBeExpanded` 仍然不会失准的原因。
 *
 * 老 host(没有 blob 路由)时退回 `file-text` / `show-file` 的 JSON 形状。
 * @param repoPath - 仓库绝对路径。
 * @param rev - 修订;`undefined` = 工作区磁盘。
 * @param file - 仓库内相对路径。
 */
async function readTextHead(repoPath: string, rev: string | undefined, file: string): Promise<ITextRead | null> {
  const result = await api.blobBytes(repoPath, rev, file, { maxBytes: MaxDiffExpansionNewContentLength });
  if (result.kind === 'text') {
    const text = new TextDecoder('utf-8').decode(result.bytes);
    return { lines: text.split(/\r?\n/), size: result.total, truncated: result.truncated };
  }
  // 内容不是文本:JSON 兜底只会回 `kind:'binary'`(⇒ null),所以**不必**再跑一趟请求。
  if (result.kind === 'binary') {
    return null;
  }
  // 只有「这条路不可用」(老 host 没有 blob 路由 / 网络失败)才退回 JSON 形状。
  return rev === undefined
    ? readLegacyWorktreeText(repoPath, file)
    : readLegacyRevText(repoPath, rev, file);
}
/**
 * 按 diff 的两侧取内容,组装 Desktop 的 `IFileContents`。
 *
 * 语义逐条对齐上游 `syntax-highlighting/index.ts:52-133`(`getFileContents`):
 *  - 新增 / 未跟踪 → 旧侧不存在(`oldContents = []`);
 *  - 删除 → 新侧不存在(`newContents = []`,于是 `canBeExpanded` 必为假);
 *  - `canBeExpanded` 额外受 `truncated` 与**字节数**约束(见文件头取舍 2 / 3)。
 * @param input - 当前 diff 的宿主输入(决定修订)。
 * @param file - 已经构造好的 `ChangedFile`(必须与喂给渲染层的是同一个)。
 * @param kind - 文件状态。
 */
async function loadFileContents(
  input: IDesktopDiffInput,
  file: ChangedFile,
  kind: FileStatusKind,
): Promise<IFileContents> {
  const oldPath = getOldPathOrDefault(file);
  const readsNew = kind !== 'deleted';
  const readsOld = kind !== 'new' && kind !== 'untracked';
  const commitish = input.commitish;
  const parentCommitish = input.parentCommitish;

  const [newRead, oldRead] = await Promise.all([
    readsNew
      ? commitish !== undefined
        ? readTextHead(input.repositoryPath, commitish, file.path)
        : readTextHead(input.repositoryPath, undefined, file.path)
      : Promise.resolve(null),
    readsOld
      ? parentCommitish !== undefined && parentCommitish !== ''
        ? readTextHead(input.repositoryPath, parentCommitish, oldPath)
        : commitish !== undefined
          // 历史 diff 但没有父提交(根提交):旧侧确实不存在。
          ? Promise.resolve(null)
          // 工作区 diff:真实的旧侧是**索引**。`GET /dsh-git/blob` 现在**支持**
          // `rev=index`(blob 端点新增的能力),但「这一行是已暂存还是未暂存」
          // 只有 `changes-view.tsx` 知道,而它这一轮的文件所有权不在本线,所以这里
          // 仍然退化成 HEAD(与改动前**完全一致**,不引入新的静默不准确)。
          // 见文件头取舍 1 与报告 (d)。
          : readTextHead(input.repositoryPath, 'HEAD', oldPath)
      : Promise.resolve(null),
  ]);

  const newContents = newRead?.lines ?? [];
  const oldContents = oldRead?.lines ?? [];
  const canBeExpanded =
    newRead !== null &&
    newRead.truncated === false &&
    newRead.size <= MaxDiffExpansionNewContentLength &&
    newContents.length > 0;

  return { file, oldContents, newContents, canBeExpanded };
}

function noop(): void {
  // `SeamlessDiffSwitcher` 的必填回调。图片 diff 现在已经能画,而它的
  // 「2-up / Swipe / Onion skin / Difference」切换器由 `ImageDiffPanel` 自己渲染
  // (`image-diff-view.tsx`),所以这个入口只在**非图片**分支上被传给上游组件、
  // 永远不该被调用 —— 保留一个真实函数而不是 undefined,因为上游 props 是必填的。
}

/**
 * 渲染一个文件 diff。
 *
 * 空态(patch 为空 / 读取中)**不由这里负责** —— 调用方按自己的文案处理,
 * 这样 Diff Settings 里「隐藏空白后只剩空白改动」那句关键提示不会被上游的英文空态覆盖。
 * 二进制则交给这里:上游 `Diff` 的 `DiffType.Binary` 分支会画「This binary file has
 * changed.」+「Open file in external program.」(接到 `onOpenBinaryFile`)。
 * @param props - 见 `IDesktopDiffProps`。
 */
export function DesktopDiff(props: IDesktopDiffProps): ReactNode {
  const { input } = props;
  const selectable = props.selectable === true;
  /**
   * **逐字段解构 `input`**,后面的 hook 只用这个 memo 出来的字段包。
   *
   * 为什么不直接把 `input` 放进依赖数组:`input` 是调用方**每次渲染新建的对象字面量**
   * (`changes-view.tsx` / `history-view.tsx` 都是内联构造),把整个对象当依赖会让
   * `file` 与内容请求每次渲染都重建 —— 行选区被无谓重置、内容被反复重取。
   * `inputFields` 的依赖全是原始值/稳定对象,所以它的身份只在这些值真的变了才变。
   * (写成 memo 是让 `react-hooks/exhaustive-deps` 与我们**想要的行为**一致,
   * 而不是拿 disable 注释把闸门按掉。)
   */
  const {
    repositoryPath, path, oldPath, patch, binary, status, untracked, conflicted,
    conflict, commitish, parentCommitish,
  } = input;
  const inputFields = useMemo<IDesktopDiffInput>(() => ({
    repositoryPath, path, oldPath, patch, binary, status, untracked, conflicted,
    conflict, commitish, parentCommitish,
  }), [
    repositoryPath, path, oldPath, patch, binary, status, untracked, conflicted,
    conflict, commitish, parentCommitish,
  ]);
  const statusKind = fileStatusKindOf(inputFields);
  const diff = useMemo(
    () => desktopDiffFromPatch(patch, binary === true),
    [patch, binary],
  );
  const hasHunks = diff.kind === DiffType.Text && diff.hunks.length > 0;

  // 可选中行集合必须从**未展开的原始解析结果**推导:host 会用工作区当前内容重新解析,
  // 两侧的下标空间都是「patch 内绝对行号」。`SideBySideDiff` 内部展开 hunk 后行号会变,
  // 但它回传的选区索引仍来自这里的集合,所以两者不会错位。
  const selectableIndices = useMemo(
    () => (diff.kind === DiffType.Text && diff.hunks.length > 0
      ? selectableLineIndicesIn(diff)
      : NO_SELECTABLE_LINES),
    [diff],
  );
  // Trap 1:`withSelectableLines` 不能省(理由见文件头)。
  //
  // 基准来自 `props.selection`(= store 里的客户端纳入状态),**不是**恒 All:
  // 这样「文件行没勾选 ⇒ diff 一行都不勾」「只勾几行 ⇒ 文件行进三态」由同一份数据驱动。
  const selection = useMemo(
    () => specToSelection(props.selection, selectableIndices),
    [props.selection, selectableIndices],
  );
  const file = useMemo(
    () => changedFileFor(inputFields, hasHunks, selectable ? selection : null),
    [inputFields, hasHunks, selectable, selection],
  );
  const repository = useMemo(
    () => new Repository(repositoryPath, 0, null, false),
    [repositoryPath],
  );

  // ---- fileContents:展开 + 语法高亮的唯一数据源 ----
  /**
   * 最新一次渲染的 `ChangedFile`,供下面的 effect 读取。
   *
   * **为什么不能把 `file` 直接放进 effect 依赖**:`file` 里带着**选区**
   * (`WorkingDirectoryFileChange.selection`),所以每次勾选 / 取消勾选都会产生一个
   * 新的 `file` 对象。把 `file` 当依赖的后果是:**每勾一行都重跑一次内容加载** ——
   * 多打 2 个宿主请求(`file-text` + `show-file`,宿主真的会去跑 git / 读盘)、
   * 白跑一次 `highlightContents`,并把 `fileContents` 短暂置回 `null`。
   * 实测(探针 `docs/probes/include-state-probe.mjs` 的 S20,真 git 仓库):
   * 6 次勾选手势打出 **12 个请求**(0 个写索引);修好后是 **0 个**。
   *
   * 旧 `file` 对象安全吗?安全。镜像判「这份内容是不是当前文件的」用的是
   * `isSameFile(fileContents.file, props.file)`(`seamless-diff-switcher.tsx:161-163`,
   * 以及 `side-by-side-diff.tsx:1763`),实现是 **`id` 比对**,而
   * `FileChange.id = status.kind + path`(`models/status.ts:255-275`)**不含选区**。
   * 所以「选区变了、id 没变」的旧 `file` 不会被误判成另一个文件。
   */
  const latestFileRef = useRef<ChangedFile>(file);
  latestFileRef.current = file;

  const [fileContents, setFileContents] = useState<IFileContents | null>(null);
  useEffect(() => {
    // 只读最新那份(不放进依赖数组,理由见上)。
    const currentFile = latestFileRef.current;
    if (diff.kind !== DiffType.Text || diff.hunks.length === 0) {
      // 没有内容可展开 / 可高亮(二进制、空 patch、畸形 patch):立刻给一个空内容,
      // 否则 `SeamlessDiffSwitcher` 会永远停在 loading 态(它把 null 当「还没准备好」)。
      setFileContents({ file: currentFile, oldContents: [], newContents: [], canBeExpanded: false });
      return;
    }
    let dead = false;
    setFileContents(null);
    void loadFileContents(inputFields, currentFile, statusKind).then(
      (contents) => { if (!dead) {setFileContents(contents);} },
      () => { if (!dead) {setFileContents({ file: currentFile, oldContents: [], newContents: [], canBeExpanded: false });} },
    );
    return () => { dead = true; };
    // `inputFields` / `diff` 都是 memo 过的:memo 的依赖是原始值(路径、patch、状态…),
    // 所以这里的身份**只在真的换了文件 / 改了 patch 时才变** —— 选区变化不会命中。
  }, [diff, statusKind, inputFields]);

  // ---- 容器级事件守卫:原生右键菜单 + 拖选监听器泄漏 ----
  const rootRef = useRef<HTMLDivElement | null>(null);
  const blockDragSelection = !selectable && !props.hideWhitespaceInDiff;
  useEffect(() => {
    const el = rootRef.current;
    if (el === null) {
      return;
    }

    /**
     * **抑制浏览器的原生右键菜单。**
     *
     * 上游 `onContextMenuText`(`side-by-side-diff.tsx:1407-1440`)**从不**调用
     * `preventDefault` —— 因为 Electron 渲染进程默认不显示原生上下文菜单,那里只有
     * 应用自己的菜单(`showContextualMenu` 走 IPC 到主进程)。浏览器里没有这回事:
     * 不拦的话原生菜单会**压在我们的菜单上面**,用户看到的是两个菜单叠着。
     *
     * 用捕获阶段、且**不 stopPropagation**:diff 自己的 `contextmenu` 处理器照常跑
     * (它才是决定「这一处有没有菜单、菜单里是什么」的地方)。
     */
    const onContextMenuCapture = (event: MouseEvent): void => { event.preventDefault(); };
    el.addEventListener('contextmenu', onContextMenuCapture, true);

    /**
     * **拖选监听器泄漏守卫**(见文件头)。只在「不可选行、且没在隐藏空白」时挂:
     *  - 隐藏空白时 `onMouseDownLineNumber` 会先弹 `WhitespaceHintPopover` 并 return,
     *    根本不注册监听器 —— 拦了反而杀掉一个正常交互;
     *  - 可选行时 `onEndSelection` 能正常清空 `temporarySelection`,不需要拦。
     */
    const onMouseDownCapture = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      if (target.closest('.line-number') === null) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    };
    if (blockDragSelection) {
      el.addEventListener('mousedown', onMouseDownCapture, true);
    }

    return () => {
      el.removeEventListener('contextmenu', onContextMenuCapture, true);
      if (blockDragSelection) {
        el.removeEventListener('mousedown', onMouseDownCapture, true);
      }
    };
  }, [blockDragSelection]);

  // ---- 选区 → 调用方(写**客户端模型**,不写索引)----
  const { onSelectionChanged, hideWhitespaceInDiff } = props;

  const handleIncludeChanged = useCallback((next: DiffSelection): void => {
    if (!selectable || onSelectionChanged === undefined) {
      return;
    }
    // 守卫 1:隐藏空白时 patch 是 `git diff -w` 的,行号空间与提交期重新取的补丁不同。
    if (hideWhitespaceInDiff) {
      return;
    }
    /*
     * 守卫 2:选区没变就不回调(展开 hunk 后下标平移时,组件会把被丢掉的 toggle
     * 也回调出来;详见 `selectionToSpec` 的说明)。
     *
     * ⚠️ **2026-10 校正:基准是 store 里的当前选区(`selection`),不是「上一次发出的
     * spec」。** 原先用的是 `lastSpecRef`(上一次回调出去的那个 JSON 串),它只在
     * 「store 只可能被这个回调改动」时才等价;而 store 还会被**文件行勾选框**与
     * **头部三态全选**从外部改。于是下面这个真实序列会被静默吞掉一次手势:
     *
     *   ① 在 diff 里勾中一行          → 发出 spec S,`lastSpecRef = S`
     *   ② 用**文件行**勾选框排除该文件 → store 变 `none`(不经过这个回调)
     *   ③ 再勾同一行                  → 算出的 spec **又是 S** ⇒ 与基准相同 ⇒ 丢弃
     *      ⇒ store 仍是 `none` ⇒ 受控 checkbox 弹回「没勾」,用户点的勾**不生效**。
     *
     * 逐行比对 `selection`(它就是 `specToSelection(props.selection, …)`)既保住了这个
     * 守卫的本意(丢掉「被展开位移吃掉、选区其实没变」的回调),也不会吞掉真实变化:
     * `next` 与 store 等价 ⇒ 写进去没有任何可观察差别。
     */
    let changed = false;
    for (const index of selectableIndices) {
      if (selection.isSelected(index) !== next.isSelected(index)) {
        changed = true;
        break;
      }
    }
    if (!changed) {
      return;
    }
    onSelectionChanged(selectionToSpec(next, selectableIndices));
  }, [selectable, onSelectionChanged, hideWhitespaceInDiff, selectableIndices, selection]);

  // ---- 图片 diff(History:committed vs its parent / Changes:索引→工作区) ----
  /**
   * 候选判据:**宿主判了二进制** + **路径在上游的图片白名单里**。
   *
   * 两侧的取数路径不同,由 `commitish` 是否存在区分(与 `loadFileContents` 同一判据):
   *  - **History**(`commitish` 有值):两侧都按修订取;
   *  - **Changes**(`commitish` 缺省):新侧取**工作区磁盘**,旧侧退化到 `HEAD`
   *    (`changes-view.tsx` 没告诉这一层当前行是已暂存还是未暂存,而它这一轮不归本线;
   *    `blob` 端点已经支持 `rev=index`,接线留给那条线,见报告 (d))。
   *
   * **取数走 `GET /dsh-git/blob`**,而且顺序是「先量后画」:
   *  1. `api.blobHead`(HEAD,不取内容)问出**真实大小与内容类型**;
   *  2. 大小在上限内 ⇒ 交一个**指向端点的 URL** 给 `<img src>`,解码/内存/缓存全交给浏览器
   *     (`ETag` + 完整 sha 时 `immutable`);
   *  3. 超限 ⇒ **一个字节都不取**,界面拿 `reason` 说「3.2 MB,上限 2 MB」,
   *     渲染退回 `DiffType.Binary`;
   *  4. 老 host 没有 blob 路由 ⇒ 退回 256 KiB 上限的 base64 兜底(`image-diff.ts`)。
   *
   * 组装层在 `./image-diff.ts`,渲染层在 `./image-diff-view.tsx`(理由:镜像的
   * `image-container.tsx` 写死了 `data:…;base64,`,URL 渲染只能在我们这层做 ——
   * 见该文件头部)。
   */
  const imageCandidate = binary === true && isRenderableImagePath(path);
  const [imageView, setImageView] = useState<IImageView | null>(null);
  const [imageNote, setImageNote] = useState<string | null>(null);
  useEffect(() => {
    if (!imageCandidate) {
      setImageView(null);
      setImageNote(null);
      return;
    }
    let dead = false;
    setImageView(null);
    setImageNote(null);
    const loaded = commitish === undefined
      ? loadImageView(repositoryPath, file, statusKind, undefined, parentCommitish ?? 'HEAD')
      : loadImageView(repositoryPath, file, statusKind, commitish, parentCommitish ?? '');
    void loaded.then(
      (result) => {
        if (dead) {
          return;
        }
        setImageView(result.view);
        // 不能画时**说清原因**(超限带真实大小与上限)——「没有图片」和「图片太大」
        // 是两件事,后者用户能自己解决(压缩/换工具看)。
        setImageNote(result.view === null ? result.reason : null);
      },
      () => {
        if (dead) {
          return;
        }
        setImageView(null);
        setImageNote(null);
      },
    );
    return () => { dead = true; };
  }, [imageCandidate, repositoryPath, commitish, parentCommitish, file, statusKind]);

  // 图片 diff 的呈现方式(2-up / Swipe / Onion skin / Difference):照 Desktop 的
  // `image-diff-type` 键持久化,刷新后仍是用户选的那一档(以前是死回调 + 硬编码 TwoUp)。
  const [imageDiffType, setImageDiffTypeState] = useState<ImageDiffType>(() => getImageDiffType());
  const onChangeImageDiffType = useCallback((type: ImageDiffType): void => {
    setImageDiffTypeState(type);
    setImageDiffType(type);
  }, []);

  /**
   * 「在 diff 里显示勾选标记」—— **真偏好,不是常量**。
   *
   * 以前这里传的是 `showDiffCheckMarks={selectable}`,而调用方的 `selectable`
   * 恒为 `true` ⇒ 这个 prop 是常量。后果:Preferences ▸ Accessibility 里那条
   * 「Show check marks in the diff」即便画出来也**影响不到任何东西**,正是目标文档
   * 反复点名的「可见但无作用的控件」缺陷类(§10.5 把同一位置的
   * `showDiffCheckMarks={false}` 记成死 prop)。
   *
   * 现在它读 Desktop 的原键(`app-store.ts:565-566` 的
   * `showDiffCheckMarksDefault = true` / `showDiffCheckMarksKey =
   * 'diff-check-marks-visible'`,逐字搬进 `diff-mode.ts`),并订阅偏好变化 ——
   * 所以「在 Preferences 里关掉 → diff 立刻不画勾」与上游 `AppStore` 的订阅行为一致。
   *
   * 为什么不能每次渲染直读 localStorage:对话框写的是同一个键,而写 localStorage
   * **不会**让本组件重渲染(同页 `storage` 事件不触发,规范如此),那就还是
   * 「看着接上了、实际要刷新」。`diff-mode.ts` 因此额外广播一个 CustomEvent。
   */
  const showDiffCheckMarks = useShowDiffCheckMarks();

  /**
   * **Diff Tab Size** —— Preferences ▸ 外观 ▸ Miscellaneous 的那个下拉。
   *
   * 上游把它交给 CodeMirror(`tabSize`),我们这边**那段路径被硬编码**
   * (`ui/diff/side-by-side-diff.tsx:1000` 的 `const tabSize = 4`,而且只喂给语法高亮
   * worker,那个 worker 是不产出 token 的替身)⇒ 上游意义的消费方在我们这里不存在。
   *
   * Web 等价物是 CSS 的 `tab-size`(它正是「制表符渲染成多宽」这条属性),所以这里把它
   * 设在 diff 的根元素上:`tab-size` 是**可继承**属性,整棵 diff 子树(含行内容格)一起生效,
   * 行里的字面 TAB 会按用户选的宽度排版。这是**等价映射**,不是把设置降级成装饰 ——
   * 探针 `docs/probes/preferences-geometry-probe.mjs` 量 `.gw-desktop-diff` 的
   * computed `tab-size` 来证明。
   */
  const diffTabSize = useDiffTabSize();


  return (
    // 这一层是给 AutoSizer 的高度来源,见 IDesktopDiffProps.bounded 的说明。
    <div
      ref={rootRef}
      className={props.bounded === true ? 'gw-desktop-diff bounded' : 'gw-desktop-diff'}
      style={{ tabSize: diffTabSize }}
    >
      {/*
        图片 diff **不走 `SeamlessDiffSwitcher`**:它的 `Diff` 会把 `IImageDiff` 里的
        `Image` 交给镜像的 `image-container.tsx`,而那里写死了 `data:…;base64,`
        (`<img src>` 永远是 data URL ⇒ 浏览器缓存与「只取所需字节」都无从谈起)。
        URL 渲染只能在我们这层做,见 `image-diff-view.tsx` 头部。
        代价:镜像 `Diff.renderImage` 这条分支在**实时路径**上不再被走到(它的四个
        子组件仍是静态可达、样式仍在产出里,base64 兜底路径也用同一批类名)。
      */}
      {imageView !== null ? (
        <ImageDiffPanel
          previous={imageView.previous}
          current={imageView.current}
          diffType={imageDiffType}
          onChangeDiffType={onChangeImageDiffType}
        />
      ) : (
        <>
          {imageNote !== null ? (
            // 纯文本提示、不带类名(不进任何样式面);颜色用宿主已有的告警令牌。
            <div style={{ padding: '6px 10px', fontSize: 12, color: 'var(--dsw-alias-state-warn-primary)' }}>
              {imageNote}
            </div>
          ) : null}
          {/*
            渲染的是**上游的 `SeamlessDiffSwitcher`**(而不是直接渲染 `Diff`):
            它是 `fileContents` 的生产者(我们走 `externalFileContents` 入口喂数据),
            还负责底部假 hunk、加载态,并且是产出 CSS 里 10 条规则的祖先元素。
            见文件头「2026-10 第二轮」。
          */}
          <SeamlessDiffSwitcher
            repository={repository}
            readOnly={!selectable}
            file={file}
            diff={diff}
            externalFileContents={fileContents}
            onIncludeChanged={handleIncludeChanged}
            imageDiffType={imageDiffType}
            hideWhitespaceInDiff={props.hideWhitespaceInDiff}
            showSideBySideDiff={props.showSideBySideDiff}
            // 上游是两条约束**同时**成立才画勾:
            //  · `selectable` —— 工作区 diff 为 true、历史 diff 为 false
            //    (`selected-commits.tsx:163` 传 false);
            //  · 用户偏好 —— Desktop 的 `showDiffCheckMarksKey`(默认 true)。
            // 以前这里只有第一条(且调用方把 `selectable` 恒传 true),所以偏好那一半
            // **没有任何读取方** ⇒ Preferences 里那个开关必然无作用。
            showDiffCheckMarks={selectable && showDiffCheckMarks}
            onOpenBinaryFile={props.onOpenBinaryFile ?? noop}
            onChangeImageDiffType={onChangeImageDiffType}
            onHideWhitespaceInDiffChanged={props.onHideWhitespaceInDiffChanged}
          />
        </>
      )}
    </div>
  );
}
