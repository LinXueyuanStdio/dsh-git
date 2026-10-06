/**
 * 适配层:把 dsh-git 自己的解析结果接到**从 GitHub Desktop 复制的**部分暂存逻辑上
 * (`src/core/desktop/lib/patch-formatter.ts`)。
 *
 * 为什么需要这一层:Desktop 的 `formatPatch` 要求 `IRawDiff`——里面的 hunk/行是
 * **类实例**(`DiffHunk` / `DiffHunkHeader` / `DiffLine`),而我们自己的
 * `diff-parse.ts` 输出的是纯对象(便于 JSON 传输)。这里负责构造实例。
 *
 * 索引空间是**刻意对齐**的:`hunk.unifiedDiffStart + 行内下标` 等于
 * `DiffLine.originalLineNumber`(两边都是这样定义的),因此客户端传来的选区索引
 * 可以直接喂给 `DiffSelection`。
 * @module dsh-git/core/partial-stage
 */

import {
  DiffHunk, DiffHunkExpansionType, DiffHunkHeader,
} from './desktop/models/diff/raw-diff.ts';
// `DiffType` 与 `ITextDiff` 在 models/diff/diff-data.ts(由 models/diff/index.ts 汇总导出)。
import { DiffType, type ITextDiff } from './desktop/models/diff/diff-data.ts';
// DiffLine 在 diff-line.ts(由 models/diff/index.ts 汇总导出)
import { DiffLine, DiffLineType } from './desktop/models/diff/diff-line.ts';
import { DiffSelection, DiffSelectionType } from './desktop/models/diff/diff-selection.ts';
import { WorkingDirectoryFileChange, AppFileStatusKind } from './desktop/models/status.ts';
import { formatPatch } from './desktop/lib/patch-formatter.ts';
import type { ParsedDiff as OurParsedDiff } from './diff-parse.ts';

/** 客户端提交的行选区。索引 = patch 内的绝对行号(`originalLineNumber`)。 */
export interface LineSelectionSpec {
  /**
   * 初始态:`all` = 默认全选,只列出被取消的行;`none` = 默认不选,只列出被选中的行。
   * 对应 Desktop 的 `DiffSelectionType.All` / `.None`。
   */
  kind: 'all' | 'none';
  /** 与初始态相反的行索引。 */
  diverging: number[];
  /** 全部可选中行(Add/Delete)。用于精确判定 all/none,避免误判成 Partial。 */
  selectable?: number[];
}

/** 我们对一个文件的分类(对应 Desktop 的 AppFileStatusKind)。 */
export type FileStatusKind = 'new' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'conflicted' | 'untracked';

const KIND_MAP: Record<FileStatusKind, AppFileStatusKind> = {
  new: AppFileStatusKind.New,
  modified: AppFileStatusKind.Modified,
  deleted: AppFileStatusKind.Deleted,
  renamed: AppFileStatusKind.Renamed,
  copied: AppFileStatusKind.Copied,
  conflicted: AppFileStatusKind.Conflicted,
  untracked: AppFileStatusKind.Untracked,
};

const LINE_TYPE_MAP: Record<string, DiffLineType> = {
  Context: DiffLineType.Context,
  Add: DiffLineType.Add,
  Delete: DiffLineType.Delete,
  Hunk: DiffLineType.Hunk,
};

/**
 * 把纯对象形态的解析结果转成 Desktop 的 **`ITextDiff`**(不是 `IRawDiff`)。
 *
 * 为什么是 `ITextDiff`:下游是 `formatPatch(file, diff)`,它的形参类型是
 * `ITextDiff | ILargeTextDiff`(`lib/patch-formatter.ts:131-134`),而这两个类型
 * 比 `IRawDiff` 多两件事 —— `kind` 判别式与 `text`。以前这里返回 `IRawDiff`
 * 形状(只有 `header`/`contents`/`isBinary`),类型上就说不通:
 * `Argument of type 'IRawDiff' is not assignable to parameter of type
 * 'ITextDiff | ILargeTextDiff'`。运行期 `formatPatch` 只读 `diff.hunks`,
 * 所以这个缺陷**不崩**,但没有一个字段是对的 —— 任何别的上游消费者
 * (它们都按 `IDiff` 联合分派)拿到它都会走错分支。
 *
 * 两个字段照上游的构造方式逐字对应(`references/desktop/app/src/lib/git/diff.ts:539-546`):
 *
 * ```
 * { kind: DiffType.Text, text: diff.contents, hunks: diff.hunks,
 *   maxLineNumber: diff.maxLineNumber, hasHiddenBidiChars: diff.hasHiddenBidiChars }
 * ```
 *
 * **注意 `text` 取的是 raw diff 的 `contents`(hunk 之后的正文),不是 `header`** ——
 * 这是上游的原样,别按名字猜。
 *
 * `expansionType` 固定为 `None`:它是「展开上下文」功能用的,`formatPatch` 不读它,
 * 而展开功能不在我们的范围内。
 * @param parsed - `core/diff-parse.ts` 的输出。
 */
export function toDesktopDiff(parsed: OurParsedDiff): ITextDiff {
  const hunks = parsed.hunks.map((hunk) => {
    const lines = hunk.lines.map((line) => new DiffLine(
      line.text,
      LINE_TYPE_MAP[line.type] ?? DiffLineType.Context,
      line.originalLineNumber,
      line.oldLineNumber,
      line.newLineNumber,
      line.noTrailingNewLine,
    ));
    const header = new DiffHunkHeader(
      hunk.header.oldStartLine,
      hunk.header.oldLineCount,
      hunk.header.newStartLine,
      hunk.header.newLineCount,
    );
    return new DiffHunk(
      header,
      lines,
      hunk.unifiedDiffStart,
      hunk.unifiedDiffEnd,
      DiffHunkExpansionType.None,
    );
  });

  return {
    kind: DiffType.Text,
    // 上游取的是 raw diff 的 **contents**(`lib/git/diff.ts:542` `text: diff.contents`),
    // 不是 header —— 与上游一致,别按名字猜。
    text: parsed.contents,
    hunks,
    maxLineNumber: parsed.maxLineNumber,
    hasHiddenBidiChars: parsed.hasHiddenBidiChars,
  };
}

/** 由客户端的选区描述构造 Desktop 的 `DiffSelection`。 */
export function toDiffSelection(spec: LineSelectionSpec): DiffSelection {
  const initial = spec.kind === 'all' ? DiffSelectionType.All : DiffSelectionType.None;
  const selectable = spec.selectable === undefined ? null : new Set(spec.selectable);
  let selection = selectable === null
    ? DiffSelection.fromInitialSelection(initial)
    : DiffSelection.fromInitialSelection(initial).withSelectableLines(selectable);

  // diverging 集合是「与初始态相反」的行;逐行 toggle 是最直白的映射,
  // 且 withToggleLineSelection 内部会做 isSelectable 校验。
  for (const index of spec.diverging) {
    if (selectable !== null && !selectable.has(index)) continue;
    selection = selection.withToggleLineSelection(index);
  }
  return selection;
}

/**
 * 为一个文件生成「只暂存选中行」的补丁。
 * @param path - 仓库内相对路径。
 * @param kind - 文件状态。
 * @param parsed - 该文件的 diff 解析结果。
 * @param spec - 行选区。
 * @returns 可直接交给 `git apply --cached --unidiff-zero` 的补丁文本。
 * @throws 当选区什么都没选中时(上游 `formatPatch` 也是抛错)。
 */
export function buildPartialPatch(
  path: string,
  kind: FileStatusKind,
  parsed: OurParsedDiff,
  spec: LineSelectionSpec,
): string {
  const file = new WorkingDirectoryFileChange(
    path,
    { kind: KIND_MAP[kind] } as never,
    toDiffSelection(spec),
  );
  return formatPatch(file, toDesktopDiff(parsed));
}

/** 选区是否「什么都没选」——调用方据此决定是否需要 staging。 */
export function isSelectionEmpty(spec: LineSelectionSpec): boolean {
  return toDiffSelection(spec).getSelectionType() === DiffSelectionType.None;
}

/** 导出枚举,方便调用方判断选区类型。 */
export { DiffSelectionType };
