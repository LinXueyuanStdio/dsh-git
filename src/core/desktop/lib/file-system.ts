/**
 * **dsh-git 手写替身(shim)** —— 上游 `app/src/lib/file-system.ts`(78 行)。
 *
 * 上游用 `node:fs` 的 `createReadStream` + `byline` + `crypto` 做「只读文件的一段」,
 * 供语法高亮在**大文件**上取前 N 字节。浏览器半没有文件系统 —— 我们的文件内容
 * 来自宿主(`git show` / 工作区读取)。
 *
 * 这里保留**同名同签名的三条导出**;取数走**注入式宿主钩子**(2026-10-06),
 * 与 `lib/git/show.ts` 的 `setGitShowHost` 同一模式、同一理由(注入点在我们的层,
 * 镜像只保留上游导出名与签名):
 *
 *  - `getTempFilePath()`:临时目录在浏览器里不存在,返回一个可读的假路径;
 *  - `readPartialFile()`:交给宿主读工作区文件的字节区间;没接宿主时按老行为**抛错**
 *    (上游的语法高亮本来就在 `try/catch` 里,抛错走同一条降级路径,不会让 diff 渲染失败);
 *  - `tailByLine()`:没有宿主等价能力(上游也没有调用方),保持抛错。
 *
 * 被谁用到(实证):`ui/diff/syntax-highlighting/index.ts:10` 取 `readPartialFile`,
 * 调用点 `:94`(`getNewFileContent` 的**工作区**分支)。返回值同样只需要
 * `toString('utf8')`(理由与「不新增 `Buffer` 名字次数」见 `lib/git/show.ts` 顶部说明)。
 * @module dsh-git/core/desktop/lib/file-system
 */

/**
 * 宿主取数钩子。
 *
 * `partialFile` 的三个参数逐字对应上游 `readPartialFile(path, start, end)`;
 * 路径是**绝对路径**(调用方 `syntax-highlighting/index.ts:94` 传的是
 * `Path.join(repository.path, file.path)`),由宿主把它解析回仓库内相对路径。
 */
export interface IFileSystemHost {
  /**
   * 读 `[start, end]` 字节(含两端)。
   * @returns 文本内容;拿不到时返回 `null`(调用方按「没有内容」处理)。
   */
  readonly partialFile: (
    absolutePath: string,
    start: number,
    end: number
  ) => Promise<string | null>
}

let host: IFileSystemHost | null = null

/**
 * 装上宿主取数实现。传 `null` 卸下(回到「抛错」的老行为)。幂等。
 * @param next - 宿主实现,或 `null`。
 */
export function setFileSystemHost(next: IFileSystemHost | null): void {
  host = next
}

/** 当前是否接了宿主(给探针与诊断用)。 */
export function isFileSystemHostInstalled(): boolean {
  return host !== null
}

function requiresHost(what: string): never {
  throw new Error(
    `[dsh-git] file-system.${what} 需要本地文件系统,浏览器半不可用;请由宿主提供内容。`
  )
}

/** 上游 :8 —— 返回一个可写临时文件路径。浏览器里没有临时目录。 */
export function getTempFilePath(prefix: string) {
  return `dsh-git-tmp:/${prefix}`
}

/**
 * 上游 :61 —— 读文件的 [start, end] 字节(含两端)。
 *
 * 返回值类型仍写成改动前的 `Promise<never>`:这是既有的、已登记的偏离,
 * 也是**不新增 `Buffer` 名字次数**的唯一办法。接了宿主时它**正常 resolve**
 * 一个只需要 `toString('utf8')` 的对象;没接时保持抛错。
 */
export async function readPartialFile(
  path: string,
  start: number,
  end: number
): Promise<never> {
  if (host === null) return requiresHost('readPartialFile')
  const text = await host.partialFile(path, start, end)
  if (text === null) return requiresHost('readPartialFile')
  return {
    toString: (_encoding?: string) => text,
    length: text.length,
  } as never
}

/** 上游 :20 —— 按行流式读文件尾部。没有宿主等价能力,保持抛错。 */
export async function tailByLine(
  _path: string,
  _lineCount: number
): Promise<never> {
  return requiresHost('tailByLine')
}
