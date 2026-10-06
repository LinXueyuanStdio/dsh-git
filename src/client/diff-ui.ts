/**
 * **移植后的 Desktop diff 渲染层 —— 浏览器半入口(薄)。**
 *
 * **已接线**:真实调用方是 `src/client/desktop-diff.tsx`(它把宿主 `DiffResult` 翻成
 * Desktop 的 `IDiff` / `ChangedFile` / `Repository`,再由 `changes-view.tsx` 与
 * `history-view.tsx` 挂载)。`scripts/build.mjs` 的 `checkDesktopDiffUiBundles()` 仍然
 * 单独给这个入口打一次包,防止将来有人把它从视图里摘掉后错误重新变成隐形。
 *
 * 这一层只做两件事:
 *  1. 把 `src/core/desktop/ui/diff/**`(与上游一致)里的组件与纯逻辑**收成一个出口**,
 *     渲染层不必知道 Desktop 的镜像目录布局;
 *  2. 把上游**模块私有**的 props 形状补成导出类型 —— 上游 `IDiffProps` /
 *     `ISeamlessDiffSwitcherProps` / `IDiffHeaderProps` 都是 `interface X`(未导出),
 *     渲染层拿不到。这里按上游逐字段对齐成 `IDiffProps` 等,字段名与顺序一致,
 *     这样渲染层能**类型安全**地构造 props,而不需要改动镜像文件。
 *
 * 镜像侧的目录布局与上游 `app/src` 一一对应,所以那些文件里的相对导入
 * (`../../models/diff`、`../lib/tooltip` …)一个字都不用改。
 * @module dsh-git/client/diff-ui
 */

import type {
  DiffSelection,
  IDiff,
  IImageDiff,
  ImageDiffType,
  ILargeTextDiff,
  ISubmoduleDiff,
  ITextDiff,
} from '../core/desktop/models/diff/index.ts'
import type {
  AppFileStatus,
  CommittedFileChange,
  WorkingDirectoryFileChange,
} from '../core/desktop/models/status.ts'
import type { Repository } from '../core/desktop/models/repository.ts'
import type { IFileContents } from '../core/desktop/ui/diff/syntax-highlighting/index.ts'

// ---------- 组件(与上游一致的 Desktop 实现) ----------

export { Diff } from '../core/desktop/ui/diff/index.tsx'
export { SeamlessDiffSwitcher } from '../core/desktop/ui/diff/seamless-diff-switcher.tsx'
export { DiffHeader } from '../core/desktop/ui/diff/diff-header.tsx'
export { DiffOptions } from '../core/desktop/ui/diff/diff-options.tsx'
export { SideBySideDiff } from '../core/desktop/ui/diff/side-by-side-diff.tsx'
export { SideBySideDiffRow } from '../core/desktop/ui/diff/side-by-side-diff-row.tsx'
export { BinaryFile } from '../core/desktop/ui/diff/binary-file.tsx'
export { SubmoduleDiff } from '../core/desktop/ui/diff/submodule-diff.tsx'
export { DiffSearchInput } from '../core/desktop/ui/diff/diff-search-input.tsx'
export { WhitespaceHintPopover } from '../core/desktop/ui/diff/whitespace-hint-popover.tsx'
export { DiffContentsWarning } from '../core/desktop/ui/diff/diff-contents-warning.tsx'
export {
  NewImageDiff,
  ModifiedImageDiff,
  DeletedImageDiff,
} from '../core/desktop/ui/diff/image-diffs/index.ts'
export { ImageContainer } from '../core/desktop/ui/diff/image-diffs/image-container.tsx'

export {
  getFileContents,
  highlightContents,
  getLineFilters,
  MaxDiffExpansionNewContentLength,
} from '../core/desktop/ui/diff/syntax-highlighting/index.ts'
export type { IFileContents, ILineFilters } from '../core/desktop/ui/diff/syntax-highlighting/index.ts'

// ---------- 纯逻辑(与 `src/client/diff-rows.ts` 同源,这里再导出便于一处引入) ----------

export * from './diff-rows.ts'

// ---------- props 形状(上游同名字段,逐条对应) ----------

type ChangedFile = WorkingDirectoryFileChange | CommittedFileChange

/**
 * 上游 `ui/diff/index.tsx:43` 的 `IDiffProps`(未导出,这里补齐)。
 * 字段与顺序逐条对应上游。
 */
export interface IDiffProps {
  readonly repository: Repository
  /** 历史 diff 为 `true`(不可选行);工作区改动为 `false`。 */
  readonly readOnly: boolean
  readonly file: ChangedFile
  readonly onIncludeChanged?: (diffSelection: DiffSelection) => void
  readonly diff: IDiff
  readonly fileContents: IFileContents | null
  readonly imageDiffType: ImageDiffType
  readonly hideWhitespaceInDiff: boolean
  readonly showSideBySideDiff: boolean
  readonly askForConfirmationOnDiscardChanges?: boolean
  readonly showDiffCheckMarks: boolean
  readonly onOpenBinaryFile: (fullPath: string) => void
  readonly onOpenSubmodule?: (fullPath: string) => void
  readonly onChangeImageDiffType: (type: ImageDiffType) => void
  readonly onDiscardChanges?: (
    diff: ITextDiff,
    diffSelection: DiffSelection
  ) => void
  readonly onHideWhitespaceInDiffChanged: (checked: boolean) => void
}

/**
 * 上游 `ui/diff/seamless-diff-switcher.tsx:33` 的 `ISeamlessDiffSwitcherProps`(未导出)。
 *
 * **逐字段取自镜像里的真实 interface**(16 个字段),不再只沿用一部分 —— 上一版
 * (只沿用 14 个)有 5 处字段级缺陷,而且方向是危险的(审计 D §8):
 *
 *  - 它把 `externalFileContents` 写成了 **`fileContents`** —— 那个字段**不存在**,
 *    而且两个名字的语义**相反**:`externalFileContents` 一旦被定义(**包括 `null`**)
 *    就表示「不要自己去 git 取内容,用我给的这个」;不传才是「照常去取」
 *    (`seamless-diff-switcher.tsx:56-70,290-299`)。照那份错接口写调用方会
 *    「以为在喂内容,实际被当成没喂」,于是走 `getFileContents()`,而它下面两个叶子
 *    是替身(`lib/git/show.ts` 恒 null、`lib/file-system.ts` 抛错)——
 *    又回到「内容永远没有、展开与高亮永远不发生」。
 *  - 它漏了 `askForConfirmationOnDiscardChanges` 与 `onDiscardChanges`;
 *  - 它把 `onHideWhitespaceInDiffChanged` 放宽成 `=> Promise<void>`(真实是 `=> void`)。
 *
 * 注意别搞混:`Diff` 自己的 prop **确实**叫 `fileContents`(`IDiffProps` 是对的),
 * 只有 switcher 这份叫 `externalFileContents`。
 */
export interface ISeamlessDiffSwitcherProps {
  readonly repository: Repository
  /** 历史 diff 为 `true`(不可选行);工作区改动为 `false`。 */
  readonly readOnly: boolean
  readonly file: ChangedFile
  readonly onIncludeChanged?: (diffSelection: DiffSelection) => void
  readonly diff: IDiff | null
  /**
   * 外部提供的新旧文件内容。**定义为 `null` 也等于「外部提供」**(表示还没准备好,
   * switcher 会保持加载态);`undefined` 才是「自己去取」。我们永远传定义值,
   * 数据由 `desktop-diff.tsx` 用宿主的 `file-text` / `show-file` 组装。
   */
  readonly externalFileContents?: IFileContents | null
  readonly imageDiffType: ImageDiffType
  readonly hideWhitespaceInDiff: boolean
  readonly showSideBySideDiff: boolean
  readonly showDiffCheckMarks: boolean
  readonly askForConfirmationOnDiscardChanges?: boolean
  readonly onOpenBinaryFile: (fullPath: string) => void
  readonly onOpenSubmodule?: (fullPath: string) => void
  readonly onChangeImageDiffType: (type: ImageDiffType) => void
  readonly onDiscardChanges?: (
    diff: ITextDiff,
    diffSelection: DiffSelection
  ) => void
  readonly onHideWhitespaceInDiffChanged: (checked: boolean) => void
}

/**
 * 上游 `ui/diff/diff-header.tsx:9` 的 `IDiffHeaderProps`(未导出)。
 */
export interface IDiffHeaderProps {
  readonly path: string
  readonly status: AppFileStatus
  readonly diff: IDiff | null
  readonly showSideBySideDiff: boolean
  readonly onShowSideBySideDiffChanged: (checked: boolean) => void
  readonly hideWhitespaceInDiff: boolean
  readonly onHideWhitespaceInDiffChanged: (checked: boolean) => Promise<void>
  readonly onDiffOptionsOpened: () => void
}

/** 便捷别名:渲染层常常只需要这两个。 */
export type { ChangedFile, IDiff, IImageDiff, ILargeTextDiff, ISubmoduleDiff, ITextDiff }
