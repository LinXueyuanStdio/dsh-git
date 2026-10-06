/**
 * diff 的**行模型**:把 patch 的 hunk/行结构翻成渲染层直接 `map` 的行数组。
 *
 * 上游是 GitHub Desktop 的 `app/src/ui/diff/side-by-side-diff.tsx` —— 一个 2150 行的
 * React 类组件,行模型散落在类的私有方法与模块私有函数里。这里只搬**纯逻辑**,
 * 逐字保留算法,只做两类机械改动:
 *
 *  1. `this.state` 读取改显式参数。上游 `createFullRow` / `getRowDataPopulated` /
 *     `getSearchTokens` 从 `this.state` 拿 `beforeTokens`/`afterTokens`/`searchResults`/
 *     `selectedSearchResult`/`temporarySelection` 与 `this.getSelection()`
 *     (`this.props.file.selection`)。这些全部收进 `IFullRowContext`,算法一字未改。
 *  2. 两个第三方依赖换成内联实现(本插件不引它们):
 *     - `memoize-one` 的 `memoize` → 本文件的 `memoizeOne`(仍是「只缓存上一次参数」语义);
 *     - `lodash/escapeRegExp` → 本文件的 `escapeRegExp`。
 *
 * 上游行号对照(`references/desktop/app/src/ui/diff/side-by-side-diff.tsx`):
 *   :76   DefaultRowHeight          :78   ISelection
 *   :88   SearchDirection           :90   ModifiedLine
 *   :1021 getSelection              :1025 createFullRow
 *   :1097 getRowDataPopulated       :1127 getSearchTokens
 *   :1774 getDiffRows               :1806 getDiffRowsFromHunk
 *   :1883 getModifiedRows           :1989 getDataFromLine
 *   :2019 SearchResults             :2057 calcSearchTokens
 *   :2088 enumerateColumnContents   :2111 isInSelection
 *   :2134 isInTemporarySelection
 *
 * 上游这一段依赖 `react-virtualized`/`findDOMNode`/DOM 事件的部分(虚拟滚动、
 * 拖选、右键菜单、剪贴板、语法高亮订阅)一律不在这里 —— 见文件末尾「未搬」注释。
 * @module dsh-git/core/desktop/ui/diff/diff-rows
 */

import {
  DiffHunk,
  DiffLine,
  DiffLineType,
  DiffSelection,
  ITextDiff,
} from '../../models/diff'
import { DiffHunkExpansionType } from '../../models/diff/raw-diff'
import {
  assertNever,
  assertNonNullable,
  forceUnwrap,
} from '../../lib/fatal-error'
import { ITokens, ILineTokens, IToken } from '../../lib/highlighter/types'
import { getTokens } from './get-tokens.ts'
import {
  ChangedFile,
  DiffColumn,
  DiffRow,
  DiffRowType,
  IDiffRowData,
  MaxIntraLineDiffStringLength,
  SimplifiedDiffRow,
  SimplifiedDiffRowData,
  canSelect,
  getDiffTokens,
} from './diff-helpers.tsx'

/** 上游 :76 —— 虚拟滚动的一行高度,渲染层也用它做行高。 */
export const DefaultRowHeight = 20

export interface ISelection {
  /// Initial diff line number in the selection
  readonly from: number

  /// Last diff line number in the selection
  readonly to: number

  readonly isSelected: boolean
}

/** 搜索方向 —— 上游 :88。渲染层的「下一个/上一个」按钮用它。 */
export type SearchDirection = 'next' | 'previous'

type ModifiedLine = { line: DiffLine; diffLineNumber: number }

/**
 * `memoize-one` 的最小替身(本插件不引该包)。
 * 语义与 `memoize-one` 一致:只记住**上一次**调用的参数,逐参数 `===` 比较。
 * @param fn - 要被记忆的函数。
 */
function memoizeOne<A extends ReadonlyArray<unknown>, R>(
  fn: (...args: A) => R
): (...args: A) => R {
  let lastArgs: A | undefined
  let lastResult: R | undefined

  return (...args: A): R => {
    if (
      lastArgs !== undefined &&
      lastArgs.length === args.length &&
      lastArgs.every((value, index) => value === args[index])
    ) {
      return lastResult as R
    }

    lastArgs = args
    lastResult = fn(...args)
    return lastResult
  }
}

/** `lodash/escapeRegExp` 的最小替身(本插件不引 lodash)。 */
function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
}

/**
 * Memoized function to calculate the actual rows to display side by side
 * as a diff.
 *
 * @param diff                The diff to use to calculate the rows.
 * @param showSideBySideDiff  Whether or not show the diff in side by side mode.
 * @param enableDiffExpansion Whether hunk headers should advertise expansion.
 */
export const getDiffRows = memoizeOne(function (
  diff: ITextDiff,
  showSideBySideDiff: boolean,
  enableDiffExpansion: boolean
): ReadonlyArray<SimplifiedDiffRow> {
  const outputRows = new Array<SimplifiedDiffRow>()

  diff.hunks.forEach((hunk, index) => {
    for (const row of getDiffRowsFromHunk(
      index,
      hunk,
      showSideBySideDiff,
      enableDiffExpansion
    )) {
      outputRows.push(row)
    }
  })

  return outputRows
})

/**
 * Returns an array of rows with the needed data to render a side-by-side diff
 * with them.
 *
 * In some situations it will merge a deleted an added row into a single
 * modified row, in order to display them side by side (This happens when there
 * are consecutive added and deleted rows).
 *
 * @param hunk                The hunk to use to extract the rows data
 * @param showSideBySideDiff  Whether or not show the diff in side by side mode.
 */
export function getDiffRowsFromHunk(
  hunkIndex: number,
  hunk: DiffHunk,
  showSideBySideDiff: boolean,
  enableDiffExpansion: boolean
): ReadonlyArray<SimplifiedDiffRow> {
  const rows = new Array<SimplifiedDiffRow>()

  /**
   * Array containing multiple consecutive added/deleted lines. This
   * is used to be able to merge them into modified rows.
   */
  let modifiedLines = new Array<ModifiedLine>()

  for (const [num, line] of hunk.lines.entries()) {
    const diffLineNumber = hunk.unifiedDiffStart + num

    if (line.type === DiffLineType.Delete || line.type === DiffLineType.Add) {
      modifiedLines.push({ line, diffLineNumber })
      continue
    }

    if (modifiedLines.length > 0) {
      // If the current line is not added/deleted and we have any added/deleted
      // line stored, we need to process them.
      for (const row of getModifiedRows(modifiedLines, showSideBySideDiff)) {
        rows.push(row)
      }
      modifiedLines = []
    }

    if (line.type === DiffLineType.Hunk) {
      rows.push({
        type: DiffRowType.Hunk,
        content: line.text,
        expansionType: enableDiffExpansion
          ? hunk.expansionType
          : DiffHunkExpansionType.None,
        hunkIndex,
      })
      continue
    }

    if (line.type === DiffLineType.Context) {
      assertNonNullable(
        line.oldLineNumber,
        `No oldLineNumber for ${diffLineNumber}`
      )
      assertNonNullable(
        line.newLineNumber,
        `No newLineNumber for ${diffLineNumber}`
      )

      rows.push({
        type: DiffRowType.Context,
        content: line.content,
        beforeLineNumber: line.oldLineNumber,
        afterLineNumber: line.newLineNumber,
        beforeTokens: [],
        afterTokens: [],
      })
      continue
    }

    assertNever(line.type, `Invalid line type: ${line.type}`)
  }

  // Do one more pass to process the remaining list of modified lines.
  if (modifiedLines.length > 0) {
    for (const row of getModifiedRows(modifiedLines, showSideBySideDiff)) {
      rows.push(row)
    }
  }

  return rows
}

function getModifiedRows(
  addedOrDeletedLines: ReadonlyArray<ModifiedLine>,
  showSideBySideDiff: boolean
): ReadonlyArray<SimplifiedDiffRow> {
  if (addedOrDeletedLines.length === 0) {
    return []
  }
  const hunkStartLine = addedOrDeletedLines[0].diffLineNumber
  const addedLines = new Array<ModifiedLine>()
  const deletedLines = new Array<ModifiedLine>()

  for (const line of addedOrDeletedLines) {
    if (line.line.type === DiffLineType.Add) {
      addedLines.push(line)
    } else if (line.line.type === DiffLineType.Delete) {
      deletedLines.push(line)
    }
  }

  const output = new Array<SimplifiedDiffRow>()

  const diffTokensBefore = new Array<ILineTokens | undefined>()
  const diffTokensAfter = new Array<ILineTokens | undefined>()

  // To match the behavior of github.com, we only highlight differences between
  // lines on hunks that have the same number of added and deleted lines.
  const shouldDisplayDiffInChunk = addedLines.length === deletedLines.length

  if (shouldDisplayDiffInChunk) {
    for (let i = 0; i < deletedLines.length; i++) {
      const addedLine = addedLines[i]
      const deletedLine = deletedLines[i]

      if (
        addedLine.line.content.length < MaxIntraLineDiffStringLength &&
        deletedLine.line.content.length < MaxIntraLineDiffStringLength
      ) {
        const { before, after } = getDiffTokens(
          deletedLine.line.content,
          addedLine.line.content
        )
        diffTokensBefore[i] = before
        diffTokensAfter[i] = after
      }
    }
  }

  let indexModifiedRow = 0

  while (
    showSideBySideDiff &&
    indexModifiedRow < addedLines.length &&
    indexModifiedRow < deletedLines.length
  ) {
    const addedLine = forceUnwrap(
      'Unexpected null line',
      addedLines[indexModifiedRow]
    )
    const deletedLine = forceUnwrap(
      'Unexpected null line',
      deletedLines[indexModifiedRow]
    )

    // Modified lines
    output.push({
      type: DiffRowType.Modified,
      beforeData: getDataFromLine(
        deletedLine,
        'oldLineNumber',
        diffTokensBefore.shift()
      ),
      afterData: getDataFromLine(
        addedLine,
        'newLineNumber',
        diffTokensAfter.shift()
      ),
      hunkStartLine,
    })

    indexModifiedRow++
  }

  for (let i = indexModifiedRow; i < deletedLines.length; i++) {
    const line = forceUnwrap('Unexpected null line', deletedLines[i])

    output.push({
      type: DiffRowType.Deleted,
      data: getDataFromLine(line, 'oldLineNumber', diffTokensBefore.shift()),
      hunkStartLine,
    })
  }

  for (let i = indexModifiedRow; i < addedLines.length; i++) {
    const line = forceUnwrap('Unexpected null line', addedLines[i])

    // Added line
    output.push({
      type: DiffRowType.Added,
      data: getDataFromLine(line, 'newLineNumber', diffTokensAfter.shift()),
      hunkStartLine,
    })
  }

  return output
}

function getDataFromLine(
  { line, diffLineNumber }: { line: DiffLine; diffLineNumber: number },
  lineToUse: 'oldLineNumber' | 'newLineNumber',
  diffTokens: ILineTokens | undefined
): SimplifiedDiffRowData {
  const lineNumber = forceUnwrap(
    `Expecting ${lineToUse} value for ${line}`,
    line[lineToUse]
  )

  const tokens = new Array<ILineTokens>()

  if (diffTokens !== undefined) {
    tokens.push(diffTokens)
  }

  return {
    content: line.content,
    lineNumber,
    diffLineNumber: line.originalLineNumber,
    noNewLineIndicator: line.noTrailingNewLine,
    tokens,
  }
}

/**
 * Helper class that lets us index search results both by their row
 * and column for fast lookup durig the render phase but also by their
 * relative order (index) allowing us to efficiently perform backwards search.
 */
export class SearchResults {
  private readonly lookup = new Map<string, ILineTokens>()
  private readonly hits = new Array<[number, DiffColumn, number, number]>()

  private getKey(row: number, column: DiffColumn) {
    return `${row}.${column}`
  }

  public add(row: number, column: DiffColumn, offset: number, length: number) {
    const key = this.getKey(row, column)
    const existing = this.lookup.get(key)
    const token: IToken = { length, token: 'search-result' }

    if (existing !== undefined) {
      existing[offset] = token
    } else {
      this.lookup.set(key, { [offset]: token })
    }

    this.hits.push([row, column, offset, length])
  }

  public get length() {
    return this.hits.length
  }

  public get(index: number) {
    const hit = this.hits[index]
    return hit === undefined
      ? undefined
      : { row: hit[0], column: hit[1], offset: hit[2], length: hit[3] }
  }

  public getLineTokens(row: number, column: DiffColumn) {
    return this.lookup.get(this.getKey(row, column))
  }
}

export function calcSearchTokens(
  diff: ITextDiff,
  showSideBySideDiffs: boolean,
  searchQuery: string,
  enableDiffExpansion: boolean
): SearchResults | undefined {
  if (searchQuery.length === 0) {
    return undefined
  }

  const hits = new SearchResults()
  const searchRe = new RegExp(escapeRegExp(searchQuery), 'gi')
  const rows = getDiffRows(diff, showSideBySideDiffs, enableDiffExpansion)

  for (const [rowNumber, row] of rows.entries()) {
    if (row.type === DiffRowType.Hunk) {
      continue
    }

    for (const column of enumerateColumnContents(row, showSideBySideDiffs)) {
      for (const match of column.content.matchAll(searchRe)) {
        if (match.index !== undefined) {
          hits.add(rowNumber, column.type, match.index, match[0].length)
        }
      }
    }
  }

  return hits
}

export function* enumerateColumnContents(
  row: SimplifiedDiffRow,
  showSideBySideDiffs: boolean
): IterableIterator<{ type: DiffColumn; content: string }> {
  if (row.type === DiffRowType.Hunk) {
    yield { type: DiffColumn.Before, content: row.content }
  } else if (row.type === DiffRowType.Added) {
    yield { type: DiffColumn.After, content: row.data.content }
  } else if (row.type === DiffRowType.Deleted) {
    yield { type: DiffColumn.Before, content: row.data.content }
  } else if (row.type === DiffRowType.Context) {
    yield { type: DiffColumn.Before, content: row.content }
    if (showSideBySideDiffs) {
      yield { type: DiffColumn.After, content: row.content }
    }
  } else if (row.type === DiffRowType.Modified) {
    yield { type: DiffColumn.Before, content: row.beforeData.content }
    yield { type: DiffColumn.After, content: row.afterData.content }
  } else {
    assertNever(row, `Unknown row type ${row}`)
  }
}

export function isInSelection(
  diffLineNumber: number,
  selection: DiffSelection | undefined,
  temporarySelection: ISelection | undefined
) {
  const isInStoredSelection = selection?.isSelected(diffLineNumber) ?? false

  if (temporarySelection === undefined) {
    return isInStoredSelection
  }

  const isInTemporary = isInTemporarySelection(
    diffLineNumber,
    temporarySelection
  )

  if (temporarySelection.isSelected) {
    return isInStoredSelection || isInTemporary
  } else {
    return isInStoredSelection && !isInTemporary
  }
}

export function isInTemporarySelection(
  diffLineNumber: number,
  selection: ISelection | undefined
): selection is ISelection {
  if (selection === undefined) {
    return false
  }

  if (
    diffLineNumber >= Math.min(selection.from, selection.to) &&
    diffLineNumber <= Math.max(selection.to, selection.from)
  ) {
    return true
  }

  return false
}

/**
 * Everything the row-expansion step of the pipeline needs but which upstream
 * reads off `this.state` / `this.props`.
 */
export interface IFullRowContext {
  /** Syntax highlighting tokens for the previous contents of the file. */
  readonly beforeTokens?: ITokens
  /** Syntax highlighting tokens for the next contents of the file. */
  readonly afterTokens?: ITokens
  /** Current search results, if a search is active. */
  readonly searchResults?: SearchResults
  /** Index of the currently selected search result. */
  readonly selectedSearchResult?: number
  /** The stored (committed) diff selection, if the file is selectable. */
  readonly selection?: DiffSelection
  /** In-flight drag selection. */
  readonly temporarySelection?: ISelection
}

/**
 * `this.getSelection()`(上游 :1021)—— 只有可选择的文件(工作区改动)才有选区。
 * 上游写法是 `canSelect(this.props.file) ? this.props.file.selection : undefined`,
 * 这里逐字等价,只把 `this.props.file` 换成参数。
 * @param file - 当前 diff 对应的文件。
 */
export function getSelection(file: ChangedFile): DiffSelection | undefined {
  return canSelect(file) ? file.selection : undefined
}

/**
 * Turns a simplified row into the row the renderer consumes: syntax tokens
 * merged in, search hits merged in, and `isSelected` computed.
 *
 * 上游是类的私有方法 `createFullRow`(:1025)+ `getRowDataPopulated`(:1086)+
 * `getSearchTokens`(:1126),算法逐字保留,`this.state` 换成 `context`。
 *
 * @param row      Row produced by `getDiffRows`.
 * @param numRow   Index of the row in the full row array.
 * @param context  Tokens / search results / selections normally held in state.
 */
export function createFullRow(
  row: SimplifiedDiffRow,
  numRow: number,
  context: IFullRowContext = {}
): DiffRow {
  if (row.type === DiffRowType.Added) {
    return {
      ...row,
      data: getRowDataPopulated(row.data, numRow, DiffColumn.After, context),
    }
  }

  if (row.type === DiffRowType.Deleted) {
    return {
      ...row,
      data: getRowDataPopulated(row.data, numRow, DiffColumn.Before, context),
    }
  }

  if (row.type === DiffRowType.Modified) {
    return {
      ...row,
      beforeData: getRowDataPopulated(
        row.beforeData,
        numRow,
        DiffColumn.Before,
        context
      ),
      afterData: getRowDataPopulated(
        row.afterData,
        numRow,
        DiffColumn.After,
        context
      ),
    }
  }

  if (row.type === DiffRowType.Context) {
    const lineTokens =
      getTokens(row.beforeLineNumber, context.beforeTokens) ??
      getTokens(row.afterLineNumber, context.afterTokens)

    const beforeTokens = [...row.beforeTokens]
    const afterTokens = [...row.afterTokens]

    if (lineTokens !== null) {
      beforeTokens.push(lineTokens)
      afterTokens.push(lineTokens)
    }

    const beforeSearchTokens = getSearchTokens(
      numRow,
      DiffColumn.Before,
      context
    )
    if (beforeSearchTokens !== undefined) {
      beforeSearchTokens.forEach(x => beforeTokens.push(x))
    }

    const afterSearchTokens = getSearchTokens(numRow, DiffColumn.After, context)
    if (afterSearchTokens !== undefined) {
      afterSearchTokens.forEach(x => afterTokens.push(x))
    }

    return { ...row, beforeTokens, afterTokens }
  }

  return row
}

function getRowDataPopulated(
  data: SimplifiedDiffRowData,
  row: number,
  column: DiffColumn,
  context: IFullRowContext
): IDiffRowData {
  const searchTokens = getSearchTokens(row, column, context)
  const lineTokens = getTokens(data.lineNumber, tokensForColumn(column, context))
  const finalTokens = [...data.tokens]

  if (searchTokens !== undefined) {
    searchTokens.forEach(x => finalTokens.push(x))
  }
  if (lineTokens !== null) {
    finalTokens.push(lineTokens)
  }

  return {
    ...data,
    tokens: finalTokens,
    isSelected:
      data.diffLineNumber !== null &&
      isInSelection(
        data.diffLineNumber,
        context.selection,
        context.temporarySelection
      ),
  }
}

/** `this.state.beforeTokens` / `afterTokens` 的按列取值。 */
function tokensForColumn(
  column: DiffColumn,
  context: IFullRowContext
): ITokens | undefined {
  return column === DiffColumn.Before ? context.beforeTokens : context.afterTokens
}

function getSearchTokens(
  row: number,
  column: DiffColumn,
  context: IFullRowContext
): ReadonlyArray<ILineTokens> | undefined {
  const searchTokens = context.searchResults
  const selectedSearchResult = context.selectedSearchResult

  if (searchTokens === undefined) {
    return undefined
  }

  const lineTokens = searchTokens.getLineTokens(row, column)

  if (lineTokens === undefined) {
    return undefined
  }

  if (lineTokens !== undefined && selectedSearchResult !== undefined) {
    const selected = searchTokens.get(selectedSearchResult)

    if (row === selected?.row && column === selected.column) {
      if (lineTokens[selected.offset] !== undefined) {
        const selectedToken: ILineTokens = {
          [selected.offset]: { length: selected.length, token: 'selected' },
        }

        return [lineTokens, selectedToken]
      }
    }
  }

  return [lineTokens]
}

/*
 * ---- 有意未搬(上游同文件里,但不属于「纯行模型」) ----
 *
 * 上游 `side-by-side-diff.tsx` 里下列内容一律没搬,它们要么依赖 React/
 * react-virtualized/findDOMNode,要么是宿主 UI 状态机:
 *
 *  - React 组件本体 `SideBySideDiff`(:226-1749):虚拟滚动(`List`/`AutoSizer`/
 *    `CellMeasurer*`)、`findDOMNode`(:32 引入)、`componentDidMount` 里的
 *    document/window 监听、剪贴板、右键菜单、文本选择、aria-live;
 *  - `highlightParametersEqual`(:1752)与异步语法高亮订阅
 *    (`initDiffSyntaxMode`/`setState({beforeTokens,afterTokens})`)—— 高亮是
 *    worker + IPC 的事,行模型只**接收** token(`IFullRowContext`);
 *  - 搜索的**状态机**:`onSearch`/`continueSearch`/`selectSearchResult`/
 *    `search`(:1631-1720)与滚动定位(`scrollToRow`)。纯的部分
 *    (`calcSearchTokens`/`SearchResults`/`getSearchTokens`)已搬;
 *  - 选区状态机:`onStartSelection`/`onMouseEnterHunk`/`onClickHunk`/
 *    `getRowSelectableGroupDetails`/`getRowSelectableGroupHeight`/
 *    `IRowSelectableGroup`(定义在 `side-by-side-diff-row.tsx:45`)
 *    —— 我们的行级暂存 UI 还没做;
 *  - hunk 展开的**触发**:`onExpandHunk`/`expandHunk`/`canExpandDiff`
 *    (`text-diff-expansion.ts` 的纯算法已整体搬过去);
 *  - `getDiffLineNumber`/`onIncludeChanged`/`onDiscardChanges` 等把行映射回
 *    补丁行号再回调 host 的部分 —— 那属于 `diff-explorer.ts`(已搬)
 *    与 host 侧 `core/partial-stage.ts` 的组合。
 */
