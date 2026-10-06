/**
 * 统一 diff 结构化解析 —— **算法移植自 GitHub Desktop**
 * (`references/desktop/app/src/lib/diff-parser.ts`,见 vendor/desktop/diff-parser.ts)。
 *
 * 为什么移植:我们原来的 `splitPatch` 只按行首字符上色,拿不到
 *   1. **旧侧行号**(删除行只显示空白,对比时看不出原始行);
 *   2. hunk 头里的 `-l,s +l,s`(部分暂存重建补丁必须要);
 *   3. `\ No newline at end of file` 标记(会影响重建补丁的正确性);
 *   4. `originalLineNumber`——Desktop 用它做「行级选择」的绝对索引,M2 要用。
 *
 * 与上游的差异:省略 `expansionType`(展开上下文属于「展开 diff」功能,不在 M1/M2),
 * 其余记账逻辑逐行对应。
 * @module dsh-git/core/diff-parse
 */

/** 行在 diff 里的角色(对应 Desktop 的 DiffLineType)。 */
export type DiffLineType = 'Context' | 'Add' | 'Delete' | 'Hunk';

/** diff 里的一行。 */
export interface DiffLine {
  /** 原始文本,**含**行首标记字符。 */
  text: string;
  type: DiffLineType;
  /** 在整个 patch 里的行序号(0 基),部分暂存按它做选区。 */
  originalLineNumber: number | null;
  /** 旧文件里的行号;新增行为 null。 */
  oldLineNumber: number | null;
  /** 新文件里的行号;删除行为 null。 */
  newLineNumber: number | null;
  /** 该行是文件末尾且原文件没有换行符(`\ No newline at end of file`)。 */
  noTrailingNewLine: boolean;
}

/** hunk 头的 `-l,s +l,s`。 */
export interface DiffHunkHeader {
  oldStartLine: number;
  oldLineCount: number;
  newStartLine: number;
  newLineCount: number;
}

/** 一个 hunk。 */
export interface DiffHunk {
  header: DiffHunkHeader;
  lines: readonly DiffLine[];
  /** 该 hunk 在整个 patch 文本里的起止行(0 基,含头)。 */
  unifiedDiffStart: number;
  unifiedDiffEnd: number;
}

/** 一次解析的完整结果。 */
export interface ParsedDiff {
  /** `+++` 之前的头部原文。 */
  header: string;
  /**
   * 上游用它做「展开上下文」;本移植版不做该功能,因此恒为 ''。
   * 保留字段是为了让移植关系一目了然,不要据此判断 diff 内容。
   */
  contents: string;
  hunks: readonly DiffHunk[];
  isBinary: boolean;
  /** patch 里出现过的最大行号(旧侧/新侧取大)。 */
  maxLineNumber: number;
  /** 含不可见双向控制字符(上游同样只做标记)。 */
  hasHiddenBidiChars: boolean;
}

// @@ -l,s +l,s @@ 可选标题;缺失的 ,s 默认 1
const diffHeaderRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
/** 不可见双向 Unicode 字符。 */
export const HIDDEN_BIDI_CHARS_RE = /[\u202A-\u202E]|[\u2066-\u2069]/;

const PREFIX_ADD = '+';
const PREFIX_DELETE = '-';
const PREFIX_CONTEXT = ' ';
const PREFIX_NO_NEWLINE = '\\';
const PREFIX_CHARS = new Set<string>([PREFIX_ADD, PREFIX_DELETE, PREFIX_CONTEXT, PREFIX_NO_NEWLINE]);

function numberFromGroup(match: RegExpExecArray, group: number, fallback: number | null = null): number {
  const raw = match[group];
  if (raw === undefined || raw === '') {
    if (fallback === null) throw new Error(`diff: 捕获组 ${group} 缺失且没有默认值`);
    return fallback;
  }
  const num = Number.parseInt(raw, 10);
  if (Number.isNaN(num)) throw new Error(`diff: 捕获组 ${group} 不是数字: ${raw}`);
  return num;
}

/**
 * 解析统一 diff 文本。
 *
 * 与上游一致地**抛错**而不是猜:畸形 hunk(只有头没有行)会抛,因为「猜」会让
 * 后续的行号与暂存补丁全部错位。
 * @param text - `git diff` / `git log --patch` 产生的统一 diff。
 */
export function parseRawDiff(text: string): ParsedDiff {
  const empty: ParsedDiff = {
    header: '', contents: '', hunks: [], isBinary: false, maxLineNumber: 0, hasHiddenBidiChars: false,
  };
  if (text === '') return empty;

  const lines = text.split('\n');

  // ---- 头部:从开头扫到 `+++`,中途遇到二进制标记就返回 ----
  let index = 0;
  let isBinary = false;
  let foundHeaderEnd = false;
  for (; index < lines.length; index++) {
    const line = lines[index];
    if (line.startsWith('Binary files ') && line.endsWith('differ')) {
      isBinary = true;
      break;
    }
    if (line.startsWith('+++')) {
      foundHeaderEnd = true;
      index += 1;
      break;
    }
  }
  if (isBinary) {
    return { ...empty, header: lines.slice(0, index).join('\n'), isBinary: true, hasHiddenBidiChars: HIDDEN_BIDI_CHARS_RE.test(text) };
  }
  if (!foundHeaderEnd) {
    // 空 diff(例如只有 `diff --git` 头、没有 +++):与上游一样不算错误。
    return { ...empty, header: text, hasHiddenBidiChars: HIDDEN_BIDI_CHARS_RE.test(text) };
  }

  const header = lines.slice(0, index).join('\n');
  const body = lines.slice(index);
  const hunks: DiffHunk[] = [];
  let cursor = 0;
  let linesConsumed = 0;

  while (cursor < body.length) {
    const headerLine = body[cursor];
    if (!headerLine.startsWith('@@')) {
      // 头部之后、hunk 之外的内容(例如 `\ No newline` 已处理,或下一文件的头):
      // 上游在这里会进入 parseHunk 并抛错,但上游的 body 是被 hunk 循环精确切分的。
      // 这里跳过非 hunk 行以免整段 diff 因为一行噪声而不可渲染。
      cursor += 1;
      continue;
    }
    const match = diffHeaderRe.exec(headerLine);
    if (match === null) throw new Error(`diff: hunk 头格式非法: ${headerLine.slice(0, 120)}`);
    const headerInfo: DiffHunkHeader = {
      oldStartLine: numberFromGroup(match, 1),
      oldLineCount: numberFromGroup(match, 2, 1),
      newStartLine: numberFromGroup(match, 3),
      newLineCount: numberFromGroup(match, 4, 1),
    };

    const hunkLines: DiffLine[] = [{
      text: headerLine,
      type: 'Hunk',
      originalLineNumber: linesConsumed,
      oldLineNumber: null,
      newLineNumber: null,
      noTrailingNewLine: false,
    }];

    let rollingOld = headerInfo.oldStartLine;
    let rollingNew = headerInfo.newStartLine;
    let diffLineNumber = linesConsumed;
    cursor += 1;

    while (cursor < body.length) {
      const line = body[cursor];
      const prefix = line.length > 0 ? line[0] : '';
      if (!PREFIX_CHARS.has(prefix)) break;

      if (prefix === PREFIX_NO_NEWLINE) {
        // 末尾无换行标记:标记在**上一行**上,自己不计入行号也不入组。
        const previous = hunkLines[hunkLines.length - 1];
        if (previous === undefined) throw new Error('diff: 末尾无换行标记前面没有行');
        hunkLines[hunkLines.length - 1] = { ...previous, noTrailingNewLine: true };
        cursor += 1;
        continue;
      }

      diffLineNumber += 1;
      if (prefix === PREFIX_ADD) {
        hunkLines.push({
          text: line, type: 'Add', originalLineNumber: diffLineNumber,
          oldLineNumber: null, newLineNumber: rollingNew, noTrailingNewLine: false,
        });
        rollingNew += 1;
      } else if (prefix === PREFIX_DELETE) {
        hunkLines.push({
          text: line, type: 'Delete', originalLineNumber: diffLineNumber,
          oldLineNumber: rollingOld, newLineNumber: null, noTrailingNewLine: false,
        });
        rollingOld += 1;
      } else {
        hunkLines.push({
          text: line, type: 'Context', originalLineNumber: diffLineNumber,
          oldLineNumber: rollingOld, newLineNumber: rollingNew, noTrailingNewLine: false,
        });
        rollingOld += 1;
        rollingNew += 1;
      }
      cursor += 1;
    }

    if (hunkLines.length === 1) {
      throw new Error('diff: 畸形 hunk(只有头没有内容)');
    }

    hunks.push({
      header: headerInfo,
      lines: hunkLines,
      unifiedDiffStart: linesConsumed,
      unifiedDiffEnd: linesConsumed + hunkLines.length - 1,
    });
    linesConsumed += hunkLines.length;
  }

  let maxLineNumber = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      maxLineNumber = Math.max(maxLineNumber, line.oldLineNumber ?? 0, line.newLineNumber ?? 0);
    }
  }

  return {
    header,
    contents: '',
    hunks,
    isBinary: false,
    maxLineNumber,
    hasHiddenBidiChars: HIDDEN_BIDI_CHARS_RE.test(text),
  };
}

/** 展开成渲染用的扁平行(界面直接 map)。 */
export function flattenDiff(diff: ParsedDiff): DiffLine[] {
  const out: DiffLine[] = [];
  for (const hunk of diff.hunks) for (const line of hunk.lines) out.push(line);
  return out;
}

/** 统计增删行数(与 --numstat 互为兜底)。 */
export function countDiffLines(diff: ParsedDiff): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const hunk of diff.hunks) {
    for (const line of hunk.lines) {
      if (line.type === 'Add') additions += 1;
      else if (line.type === 'Delete') deletions += 1;
    }
  }
  return { additions, deletions };
}
