/**
 * 行模型的**浏览器半入口** —— 把 `src/core/desktop/ui/diff/*` 的纯逻辑收成一个
 * 渲染层可以 `import` 的模块,并附一个把「我们现有的输入形状」翻成行数组的适配器。
 *
 * 为什么要有这一层(而不是让渲染层直接 import core/desktop):
 *  1. 路径只有一个:渲染层不必知道 Desktop 的镜像目录布局;
 *  2. 类型口径统一:core 里有**两套**行类型 —— 本插件手写的
 *     `core/diff-parse.ts`(`DiffLineType` 是字符串联合)与 Desktop 的
 *     `core/desktop/models/diff`(`DiffLineType` 是数字 enum、行/块是 class)。
 *     渲染层只从这里取 Desktop 那一套,避免混用;
 *  3. 浏览器半的约束(不得 import `@deepseek-ai/*` 与 node 内置模块)在这一层被
 *     一次性保证:下面全部来源都是纯 TS,只有 `core/desktop/lib/path.ts` 用了 node
 *     内置模块,而它不在本文件的依赖图里。
 *
 * 「我们现有的输入形状」= 宿主 `DiffResult`(`src/core/types.ts`)的子集:
 * `{ patch: string; binary?: boolean }`,即一条统一 diff 的原文 —— 也就是
 * `git diff` 打印出来的东西。接线后的真实路径是
 * `changes-view.tsx` / `history-view.tsx` → `desktop-diff.tsx` → `diff-ui.ts` → 移植的
 * `Diff`(见 `desktop-diff.tsx` 顶部的「为什么选客户端翻译」)。
 * @module dsh-git/client/diff-rows
 */

import { DiffParser } from '../core/desktop/lib/diff-parser.ts';
import { DiffType } from '../core/desktop/models/diff/index.ts';
import type { IRawDiff } from '../core/desktop/models/diff/raw-diff.ts';
import type { ITextDiff } from '../core/desktop/models/diff/diff-data.ts';
import {
  createFullRow,
  getDiffRows,
  getSelection,
} from '../core/desktop/ui/diff/diff-rows.ts';
import {
  getLineWidthFromDigitCount,
  getNumberOfDigits,
} from '../core/desktop/ui/diff/diff-helpers.tsx';
import type { IFullRowContext } from '../core/desktop/ui/diff/diff-rows.ts';
import type {
  ChangedFile,
  DiffRow,
  SimplifiedDiffRow,
} from '../core/desktop/ui/diff/diff-helpers.tsx';

/**
 * 行号槽宽度(px)。
 *
 * 这是**我们这一层**的函数,不在镜像里:上游把这两行算术内联在
 * `side-by-side-diff.tsx:888-889` 的渲染路径里(`getLineWidthFromDigitCount(
 * getNumberOfDigits(diff.maxLineNumber))`),没有导出。我们这里也需要它(行模型自检
 * 与探针要看行号宽度),所以在本层合一个同名函数,而不是去改上游文件 ——
 * 镜像的字节一致性比省两行代码值钱。
 * @param maxLineNumber - diff 里最大的行号。
 */
export function getLineNumberWidth(maxLineNumber: number): number {
  return getLineWidthFromDigitCount(getNumberOfDigits(maxLineNumber));
}

// ---------- 行模型本体(Desktop 逐字移植) ----------

export {
  createFullRow,
  getDiffRows,
  getDiffRowsFromHunk,
  calcSearchTokens,
  SearchResults,
  enumerateColumnContents,
  isInSelection,
  isInTemporarySelection,
  getSelection,
  DefaultRowHeight,
} from '../core/desktop/ui/diff/diff-rows.ts';

export type {
  IFullRowContext,
  ISelection,
  SearchDirection,
} from '../core/desktop/ui/diff/diff-rows.ts';

export {
  DiffColumn,
  DiffRowType,
  canSelect,
  getDiffTokens,
  getLargestLineNumber,
  getLineWidthFromDigitCount,
  getNumberOfDigits,
  getFirstAndLastClassesSideBySide,
  isRowChanged,
  textDiffEquals,
  MaxIntraLineDiffStringLength,
} from '../core/desktop/ui/diff/diff-helpers.tsx';

export type {
  ChangedFile,
  DiffRow,
  IDiffRowData,
  SimplifiedDiffRow,
  SimplifiedDiffRowData,
} from '../core/desktop/ui/diff/diff-helpers.tsx';

export { getTokens } from '../core/desktop/ui/diff/get-tokens.ts';

export { relativeChanges } from '../core/desktop/ui/diff/changed-range.ts';
export type { IRange } from '../core/desktop/ui/diff/changed-range.ts';

export {
  DiffRangeType,
  diffHunkForIndex,
  findInteractiveDiffRange,
  findInteractiveOriginalDiffRange,
  getLineInOriginalDiff,
} from '../core/desktop/ui/diff/diff-explorer.ts';

export {
  DefaultDiffExpansionStep,
  expandTextDiffHunk,
  expandWholeTextDiff,
  getHunkHeaderExpansionType,
  getTextDiffWithBottomDummyHunk,
} from '../core/desktop/ui/diff/text-diff-expansion.ts';
export type { DiffExpansionKind } from '../core/desktop/ui/diff/text-diff-expansion.ts';

export { DiffParser, HiddenBidiCharsRegex } from '../core/desktop/lib/diff-parser.ts';

export {
  DiffHunk,
  DiffHunkExpansionType,
  DiffHunkHeader,
  DiffLine,
  DiffLineType,
  DiffSelection,
  DiffType,
} from '../core/desktop/models/diff/index.ts';

export type { ITextDiff, IRawDiff } from '../core/desktop/models/diff/index.ts';

// ---------- 适配器:我们现有的输入形状 → 行 ----------

/** 我们现有的输入形状(宿主 `DiffResult` 的子集)。 */
export interface IDiffRowsInput {
  /** 原始统一 diff 文本。 */
  readonly patch: string;
  /** 二进制文件:不产生行,渲染层显示「二进制文件」。 */
  readonly binary?: boolean;
}

/** 行模型的开关,默认值与 Desktop 一致(`ShowSideBySideDiffDefault = false`)。 */
export interface IDiffRowsOptions {
  /** 并排(split)模式。默认 `false`,即统一视图。 */
  readonly showSideBySideDiff?: boolean;
  /** hunk 头是否可展开。默认 `false`(Desktop 里由是否工作区 diff 决定)。 */
  readonly enableDiffExpansion?: boolean;
  /** 语法高亮 / 搜索 / 选区上下文,可有可无。 */
  readonly context?: IFullRowContext;
}

/** 适配器的结果。 */
export interface IDiffRowsResult {
  /** 解析出的 Desktop 文本 diff(`getDiffRows` 的输入)。 */
  readonly diff: ITextDiff;
  /** 行号槽宽度(px),直接给渲染层的行号列用。 */
  readonly lineNumberWidth: number;
  /** 未注入 token / 选区的行。 */
  readonly rows: ReadonlyArray<SimplifiedDiffRow>;
  /** 已注入 token / 选区 / 命中高亮的行,渲染层直接 `map`。 */
  readonly fullRows: ReadonlyArray<DiffRow>;
}

/**
 * 用 Desktop 的解析器把统一 diff 解析成 `IRawDiff`。
 * 畸形 diff 会**抛错**(上游行为:畸形 hunk 不猜),调用方自行 try/catch。
 * @param patch - 统一 diff 原文。
 */
export function parsePatch(patch: string): IRawDiff {
  return new DiffParser().parse(patch);
}

/**
 * 统一 diff → Desktop `ITextDiff`。下面三种情况返回 `null`,让渲染层走
 * 「没有可显示的差异」/「二进制文件」分支,而不是渲染一个空表:
 *  - 解析抛错(畸形 diff);
 *  - `isBinary`(patch 里是 `Binary files ... differ`);
 *  - `hunks.length === 0`(只有 `diff --git` 头,没有内容)。
 * @param patch - 统一 diff 原文。
 */
export function textDiffFromPatch(patch: string): ITextDiff | null {
  if (patch.trim() === '') return null;
  let raw: IRawDiff;
  try {
    raw = parsePatch(patch);
  } catch {
    return null;
  }
  if (raw.isBinary || raw.hunks.length === 0) return null;
  return {
    kind: DiffType.Text,
    text: patch,
    hunks: raw.hunks,
    maxLineNumber: raw.maxLineNumber,
    hasHiddenBidiChars: raw.hasHiddenBidiChars,
  };
}

/**
 * 已经拿到 `ITextDiff` 时直接算行。
 * @param diff - Desktop 文本 diff。
 * @param options - 视图开关与 token/选区上下文。
 */
export function rowsFromTextDiff(
  diff: ITextDiff,
  options: IDiffRowsOptions = {}
): IDiffRowsResult {
  const showSideBySideDiff = options.showSideBySideDiff ?? false;
  const enableDiffExpansion = options.enableDiffExpansion ?? false;
  const context = options.context ?? {};
  const rows = getDiffRows(diff, showSideBySideDiff, enableDiffExpansion);
  return {
    diff,
    lineNumberWidth: getLineNumberWidth(diff.maxLineNumber),
    rows,
    fullRows: rows.map((row, index) => createFullRow(row, index, context)),
  };
}

/**
 * **适配器主入口**:吃我们现有的 `{ patch }` 输入形状,吐行。
 *
 * 与旧渲染路径的关系:`core/diff-parse.ts` 仍被 host 侧
 * (`src/host/git-service.ts`)用于统计增删;这里**不认识**那个模型,而是用
 * Desktop 的解析器重新解析 patch —— 因为行模型需要 class 形态的
 * `DiffHunk`(`.expansionType`、`.unifiedDiffStart/End`)与数字 enum 的
 * `DiffLineType`,那是 `core/diff-parse.ts` 的平行模型给不出的。
 *
 * @param input - `{ patch, binary? }`,与宿主 `DiffResult` 同形。
 * @param options - 视图开关与 token/选区上下文。
 * @returns 结果,或 `null`(空 patch / 二进制 / 畸形,见 `textDiffFromPatch`)。
 */
export function diffRowsFromInput(
  input: IDiffRowsInput,
  options: IDiffRowsOptions = {}
): IDiffRowsResult | null {
  if (input.binary === true) return null;
  const diff = textDiffFromPatch(input.patch);
  if (diff === null) return null;
  return rowsFromTextDiff(diff, options);
}

/**
 * 便捷版:给一个文件对象(可选择的文件才有选区)算出行。
 * 等价于 `rowsFromTextDiff(diff, { ...options, context: { ...options.context, selection: getSelection(file) } })`。
 * @param diff - Desktop 文本 diff。
 * @param file - 当前 diff 对应的文件。
 * @param options - 视图开关与 token/选区上下文。
 */
export function rowsFromTextDiffForFile(
  diff: ITextDiff,
  file: ChangedFile,
  options: IDiffRowsOptions = {}
): IDiffRowsResult {
  return rowsFromTextDiff(diff, {
    ...options,
    context: { ...options.context, selection: getSelection(file) },
  });
}
