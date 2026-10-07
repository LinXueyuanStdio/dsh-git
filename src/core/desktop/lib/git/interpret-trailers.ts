/**
 * **dsh-git 手写替身(shim)** —— 上游 `app/src/lib/git/interpret-trailers.ts`(176 行)。
 *
 * 上游把**纯解析**与**跑 git** 混在一个文件里:
 *  - 纯: `ITrailer`、`isCoAuthoredByTrailer`、`parseRawUnfoldedTrailers`、
 *    `parseSingleUnfoldedTrailer` —— 逐字保留(下面三段与上游 :12-70 一致);
 *  - 需要 git: `getTrailerSeparatorCharacters`(读 `trailer.separators` 配置)、
 *    `parseTrailers`(跑 `git interpret-trailers`)、`mergeTrailers`(同上)。
 *    这三条走 dugite,浏览器半拿不到,因此**保留同名同签名**,改为抛出可识别的
 *    错误,由宿主(我们已有 `src/host/git-runner.ts`)实现。功能没删,调用点不变。
 *
 * 被谁用到(实证):`models/commit.ts:2` 只取 `ITrailer`(类型)与
 * `isCoAuthoredByTrailer`(纯谓词),所以本文件的 git 部分当前无 UI 调用者。
 * @module dsh-git/core/desktop/lib/git/interpret-trailers
 */

export interface ITrailer {
  readonly token: string
  readonly value: string
}

/**
 * Gets a value indicating whether the trailer token is
 * Co-Authored-By. Does not validate the token value.
 */
export function isCoAuthoredByTrailer(trailer: ITrailer) {
  return trailer.token.toLowerCase() === 'co-authored-by'
}

export function parseRawUnfoldedTrailers(trailers: string, separators: string) {
  const lines = trailers.split('\n')
  const parsedTrailers = new Array<ITrailer>()

  for (const line of lines) {
    const trailer = parseSingleUnfoldedTrailer(line, separators)

    if (trailer) {
      parsedTrailers.push(trailer)
    }
  }

  return parsedTrailers
}

export function parseSingleUnfoldedTrailer(
  line: string,
  separators: string
): ITrailer | null {
  for (const separator of separators) {
    const ix = line.indexOf(separator)
    if (ix > 0) {
      return {
        token: line.substring(0, ix).trim(),
        value: line.substring(ix + 1).trim(),
      }
    }
  }

  return null
}

/** 浏览器半跑不了 git,统一抛这个可识别的错误。 */
function requiresHost(command: string): never {
  throw new Error(
    `[dsh-git] ${command} 需要跑 git,浏览器半不可用;请由宿主(src/host/git-runner.ts)实现。`
  )
}

/** 上游签名:`(repository: Repository) => Promise<string>`。 */
export async function getTrailerSeparatorCharacters(
  _repository: unknown
): Promise<string> {
  // 默认分隔符是 ':'(上游在无配置时也返回 ':'),这条**不**抛错,保持可用。
  return ':'
}

/** 上游签名:`(repository, message, trailers) => Promise<string>`。 */
export async function parseTrailers(
  _repository: unknown,
  _message: string,
  _trailers: ReadonlyArray<ITrailer>
): Promise<string> {
  requiresHost('git interpret-trailers')
}

/** 上游签名:`(repository, message, trailers) => Promise<string>`。 */
export async function mergeTrailers(
  _repository: unknown,
  _message: string,
  _trailers: ReadonlyArray<ITrailer>
): Promise<string> {
  requiresHost('git interpret-trailers --if-exists addIfDifferent')
}
