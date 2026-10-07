/**
 * 路径显示的纯算法 —— **逐字复制** GitHub Desktop 的 `ui/lib/path-text.tsx`
 * 的四个函数:`truncateMid` / `truncatePath` / `extract` / `createPathDisplayState`。
 *
 * Desktop 的文件行把路径拆成「目录(变暗)+ 文件名(正常)」两个 span,空间不够时做
 * **保留文件名的中段截断**:文件名优先完整,`…/` 从目录部分吃掉。
 * 这比「整条路径交给 CSS ellipsis」好得多 —— 后者会把文件名本身截掉,
 * 而文件名恰恰是用户最需要看清的部分。
 *
 * 未搬的部分:React 组件 `PathText` 的像素测量与二分收敛(依赖 Desktop 的
 * Tooltip/HighlightText/observable-ref 原语)。这里按**字符数**决定长度。
 *
 * **偏离上游 2 处**(都是为了能在浏览器半里跑 —— 浏览器半不允许 import node 内置模块):
 *  1. `Path.basename` 换成下面自带的 POSIX 实现。
 *     git 输出的路径恒为 POSIX 相对路径(`a/b/c`),所以 POSIX 语义就是正确语义。
 *     (`Path.normalize` **不需要替身**:上游 `ui/lib/path-text.tsx` 从不调用它 ——
 *     归一化发生在调用方,prop 名 `normalizedPath` 就是这个意思。这里曾经写过一个
 *     本地 `normalize` 但**没有任何调用点**,已删除;理由见 `docs/lint-layer.md` §8.1。)
 *  2. `createPathDisplayState` 加上 `export`(上游是模块私有),便于无测量场景直接取两段。
 * @module dsh-git/core/desktop/lib/path-display
 */

/**
 * POSIX `basename` —— 只保留最后一个分隔符之后的部分。
 * (等价于 `node:path` 的 `basename` 在 POSIX 模式下的行为。)
 * @param p - 路径。
 */
function basename(p: string): string {
  const end = p.endsWith(SEP) ? p.length - 1 : p.length;
  const cut = p.lastIndexOf(SEP, end - 1);
  return p.slice(cut + 1, end);
}

/** Desktop 用 `Path.sep`;git 的路径输出恒为 `/`,所以固定用它。 */
const SEP = '/';

/**
 * Truncates the given string to the number of characters given by
 * the length parameter. The value is truncated (if necessary) by
 * removing characters from the middle of the string and inserting
 * an ellipsis in their place until the value fits within the alloted
 * number of characters.
 */
export function truncateMid(value: string, length: number) {
  if (value.length <= length) {
    return value
  }

  if (length <= 0) {
    return ''
  }

  if (length === 1) {
    return '…'
  }

  const mid = (length - 1) / 2
  const pre = value.substring(0, Math.floor(mid))
  const post = value.substring(value.length - Math.ceil(mid))

  return `${pre}…${post}`
}

/**
 * String truncation for paths.
 *
 * This method takes a path and returns it truncated (if necessary)
 * to the exact number of characters specified by the length
 * parameter.
 */
export function truncatePath(path: string, length: number) {
  if (path.length <= length) {
    return path
  }

  if (length <= 0) {
    return ''
  }

  if (length === 1) {
    return '…'
  }

  const lastSeparator = path.lastIndexOf(SEP)

  // No directory prefix, fall back to middle ellipsis
  if (lastSeparator === -1) {
    return truncateMid(path, length)
  }

  const filenameLength = path.length - lastSeparator - 1

  // File name prefixed with …/ would be too long, fall back
  // to middle ellipsis.
  if (filenameLength + 2 > length) {
    return truncateMid(path, length)
  }

  const pre = path.substring(0, length - filenameLength - 2)
  const post = path.substring(lastSeparator)

  return `${pre}…${post}`
}

/**
 * Extract the filename and directory from a given normalized path
 *
 * @param normalizedPath The normalized path (i.e. no '.' or '..' characters in path)
 */
export function extract(normalizedPath: string): {
  normalizedFileName: string
  normalizedDirectory: string
}

/**
 * Extract the filename and directory from a given normalized path
 *
 * @param normalizedPath The normalized path (i.e. no '.' or '..' characters in path)
 */
export function extract(normalizedPath: string): {
  normalizedFileName: string
  normalizedDirectory: string
} {
  // for untracked submodules the status entry is returned as a path with a
  // trailing path separator which causes the directory to be trimmed in a weird
  // way below. let's try to resolve this here
  normalizedPath = normalizedPath.endsWith(SEP)
    ? normalizedPath.substring(0, normalizedPath.length - 1)
    : normalizedPath

  const normalizedFileName = basename(normalizedPath)
  const normalizedDirectory = normalizedPath.substring(
    0,
    normalizedPath.length - normalizedFileName.length
  )

  return { normalizedFileName, normalizedDirectory }
}

/**
 * dsh-git 偏离上游 1 处:上游把它写成模块私有函数(`path-text.tsx` 里只有
 * `truncateMid` / `truncatePath` / `extract` 是导出的),这里加上 `export` 以便
 * 在无测量的场景下直接取「目录文本 / 文件文本」两段。算法本身逐字未改。
 */
export function createPathDisplayState(
  normalizedPath: string,
  length?: number
): IPathDisplayState {
  length = length === undefined ? normalizedPath.length : length

  if (length <= 0) {
    return { normalizedPath, directoryText: '', fileText: '', length }
  }

  const { normalizedFileName, normalizedDirectory } = extract(normalizedPath)

  // Happy path when it already fits, we already know the length of the directory
  if (length >= normalizedPath.length) {
    return {
      normalizedPath,
      directoryText: normalizedDirectory,
      fileText: normalizedFileName,
      length,
    }
  }

  const truncatedPath = truncatePath(normalizedPath, length)
  let directoryLength = 0

  // Attempt to determine how much of the truncated path is the directory prefix
  // vs the filename (basename). It does so by comparing each character in the
  // normalized directory prefix to the truncated path, as long as it's a match
  // we know that it's a directory name.
  for (
    let i = 0;
    i < truncatedPath.length && i < normalizedDirectory.length;
    i++
  ) {
    const normalizedChar = normalizedDirectory[i]
    const truncatedChar = truncatedPath[i]

    if (normalizedChar === truncatedChar) {
      directoryLength++
    } else {
      // We're no longer matching the directory prefix but if the following
      // characters is '…' or '…/' we'll count those towards the directory
      // as well, this is purely an aesthetic choice.
      if (truncatedChar === '…') {
        directoryLength++
        const nextTruncatedIx = i + 1

        // Do we have one more character to read? Is is a path separator?
        if (truncatedPath.length > nextTruncatedIx) {
          if (truncatedPath[nextTruncatedIx] === SEP) {
            directoryLength++
          }
        }
      }
      break
    }
  }

  const fileText = truncatedPath.substring(directoryLength)
  const directoryText = truncatedPath.substring(0, directoryLength)

  return { normalizedPath, directoryText, fileText, length }
}
