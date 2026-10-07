/**
 * **dsh-git 手写替身(shim)** —— 上游 `app/src/lib/git/show.ts`(113 行)。
 *
 * 上游用 dugite 跑 `git show <rev>:<path>` 取旧/新版本的文件内容(语法高亮要用),
 * 还带「路径不在该 ref 里」的两条 catch 变体。浏览器半不能跑 git。
 *
 * 这里保留**三条同名同签名导出**。取数走**注入式宿主钩子**(2026-10-06):
 * 文件内容由宿主给,镜像只保留上游的导出名与签名 —— 与
 * `lib/helpers/non-fatal-exception.ts` 的 `setNonFatalExceptionHost`、
 * `ui/lib/context-menu.ts` 的 `installContextMenuHost` **同一条被认可的模式**:
 * 注入点在**我们的层**(`src/client/history-view.tsx` 模块作用域安装),
 * 这个文件一行业务都不多写。
 *
 * ## 为什么返回值是「鸭子类型」而不是真的 `Buffer`
 *
 * 上游返回 `Buffer | null`,而浏览器半 `types: []` **没有 `Buffer`** ——
 * 这本来就是这个文件被登记为偏离的原因之一。唯一的调用方
 * `ui/diff/syntax-highlighting/index.ts:128-129` 只做一件事:
 *
 * ```ts
 * oldContents?.toString('utf8').split(/\r?\n/) ?? []
 * ```
 *
 * 所以宿主钩子交回**字符串**,这里包一个只实现 `toString()` 的最小对象即可
 * (已 grep 全仓确认这两个 `toString('utf8')` 是仅有的用法)。函数签名仍写上
 * 游原样的 `Promise<Buffer | null>`(与改动前逐字一致),值用 `as unknown as` 转换
 * —— **不新增任何 `Buffer` 名字的出现次数**,否则会抬高 `scripts/type-baseline.json`
 * 里这个文件的诊断数(棘轮只许降)。
 *
 * 宿主没接上时**逐字保持**改动前的行为:三个导出返回 `null`
 * (= 上游「路径不在该 ref 里」的返回值),调用方走它原有的 null 分支:不高亮,
 * 但 diff 照常渲染。
 * @module dsh-git/core/desktop/lib/git/show
 */

/**
 * 宿主取数钩子。
 *
 * `partialBlob` 的前四个参数逐字对应上游 `getPartialBlobContents` 的
 * `(repository, commitish, path, length)`;`repository` 只用到 `.path`,
 * 这里收窄成字符串,免得宿主实现要构造一个 `Repository`。
 */
export interface IGitShowHost {
  /**
   * 取 `<commitish>:<path>` 的内容(最多 `length` 字节)。
   * @returns 文本内容;拿不到(二进制 / 超大 / 路径不在该 ref 里)返回 `null`。
   */
  readonly partialBlob: (
    repositoryPath: string,
    commitish: string,
    path: string,
    length: number
  ) => Promise<string | null>
}

let host: IGitShowHost | null = null

/**
 * 装上宿主取数实现。传 `null` 卸下(回到「永远拿不到内容」)。幂等。
 * @param next - 宿主实现,或 `null`。
 */
export function setGitShowHost(next: IGitShowHost | null): void {
  host = next
}

/** 当前是否接了宿主(给探针与诊断用)。 */
export function isGitShowHostInstalled(): boolean {
  return host !== null
}

/**
 * 把宿主交回的字符串包成调用方需要的最小形状(只需要 `toString('utf8')`)。
 * @param text - 宿主给的文本;`null` 表示拿不到。
 */
function asContents(text: string | null) {
  if (text === null) return null
  return {
    toString: (_encoding?: string) => text,
    length: text.length,
  }
}

/** 从宿主拿内容;没接宿主、或 repository 没有 path 时返回 `null`。 */
async function read(
  repository: unknown,
  commitish: string,
  path: string,
  length: number
): Promise<ReturnType<typeof asContents>> {
  const repositoryPath =
    typeof repository === 'object' && repository !== null && 'path' in repository
      ? String((repository as { path: unknown }).path)
      : ''
  if (host === null || repositoryPath === '') return null
  try {
    return asContents(await host.partialBlob(repositoryPath, commitish, path, length))
  } catch {
    // 与上游 `getPartialBlobContentsCatchPathNotInRef` 同语义:取不到就当没有,
    // 不让高亮把 diff 渲染拖垮(上游那一层本来就在 try/catch 里)。
    return null
  }
}

/**
 * 上游 :79 —— 取 `<commitish>:<path>` 的前 `length` 字节。
 * 返回 `null` 表示「拿不到」(上游在路径不在 ref 里时也返回 null)。
 */
export async function getPartialBlobContents(
  repository: unknown,
  commitish: string,
  path: string,
  length: number
): Promise<Buffer | null> {
  // `as never`:满足 `Buffer | null` 的返回类型,又**不新增 `Buffer` 名字的出现次数**
  // (棘轮按文件计诊断数,多写一个 `Buffer` 就多一条 TS2591)。
  return (await read(repository, commitish, path, length)) as never
}

/** 上游 :93 —— 路径不在 ref 里时不抛错的版本。 */
export async function getPartialBlobContentsCatchPathNotInRef(
  repository: unknown,
  commitish: string,
  path: string,
  length: number
): Promise<Buffer | null> {
  return (await read(repository, commitish, path, length)) as never
}

/** 上游 :40 —— 取整个 blob 的文本内容;拿不到返回 null。 */
export async function getBlobContents(
  repository: unknown,
  commitish: string,
  path: string
): Promise<string | null> {
  const contents = await read(repository, commitish, path, Number.MAX_SAFE_INTEGER)
  return contents === null ? null : contents.toString('utf8')
}
