/**
 * `node:fs/promises` 的浏览器替身 —— 覆盖 `lib/path.ts:2` 的 `realpath`、
 * `lib/path-exists.ts:1` 的 `access`、`lib/large-files.ts:4` 的 `stat`,
 * 以及 `lib/markdown-filters/emoji-filter.ts:3` 的 `readFile`(后两条的契约
 * 各写在自己的 JSDoc 里,`readFile` 有一条会静默产出坏图的坑,动之前必读)。
 *
 * ## 为什么会有 `access`(以及它的语义边界)
 *
 * `lib/path-exists.ts`(逐字镜像)是
 * `import { access } from 'fs/promises'` + `constant(true)`:
 *
 * ```ts
 * export const pathExists = (path: string) => access(path).then(constant(true), constant(false))
 * ```
 *
 * 也就是说**「抛错 = 不存在」**就是上游的判据。浏览器半没有文件系统,所以这里把
 * `access` 交给**注入式宿主钩子**(`setFsPromisesHost`,与 `lib/git/show.ts` 的
 * `setGitShowHost` 同一模式)。没接宿主时保持「不可用」:抛 `ENOENT`
 * —— 即 `pathExists` 恒为 `false`。
 *
 * ## 调用点只有一处,而且那是**上游容器**要的
 *
 * 唯一的调用者是 `ui/history/selected-commits.tsx:370`(`onContextMenu` 的第一句):
 *
 * ```ts
 * const fileExistsOnDisk = await pathExists(fullPath)
 * if (!fileExistsOnDisk) { showContextualMenu([{ label: 'File Does Not Exist on Disk', enabled: false }]); return }
 * ```
 *
 * 所以它必须**真的**反映工作区,不能恒 `false`(那会让右键菜单永远只有一句
 * 「File Does Not Exist on Disk」—— **错的 UI**)。宿主的 `file-text` 对**不存在**的
 * 文件会先 `lstat` 再抛(`src/host/git-service.ts:895-896`),**任何字节都不会读**;
 * 但对**存在的大文本文件**它会把整份读回来(`:917` 的 `readFile(target,'utf8')`)。
 * 所以客户端的实现(见 `src/client/history-view.tsx` 的 `installHostFileAccess`)
 * **先用 `repo/tree` 的文件名集合判存在(0 文件字节)**,只有「不在树里」时才回落到
 * `file-text` —— 那条回落路上真正缺失的文件依然是 0 字节。
 *
 * ## `realpath`
 *
 * 上游 `lib/path.ts` 的 `resolveWithin` 是**路径穿越防护**,用 `realpath` 解析符号
 * 链接。该函数在本插件的客户端图里没有任何调用者(唯一调用者
 * `ui/dispatcher/dispatcher.ts` 属于被 shim 掉的 Desktop 应用层),
 * 所以这里作为**恒等**实现:不改路径、不解析符号链接,并在第一次被调用时提示一次。
 * @module dsh-git/client/shim-node-fs-promises
 */

let warned = false

/**
 * 宿主文件访问钩子。
 *
 * `access` 必需(有真实调用方);`stat` / `readFile` 可选(它们的调用方当前都不可达);
 * `realpath` 刻意留作恒等实现(见文件头)。
 */
export interface IFsPromisesHost {
  /**
   * 对应 `fs.promises.access`:**存在就 resolve,不存在就抛**(抛出的值只要是个
   * `Error` 即可,调用方 `lib/path-exists.ts` 用 `.then(ok, fail)` 接)。
   * @param path - 绝对路径(调用方传的是 `Path.join(repository.path, file.path)`)。
   */
  readonly access: (path: string) => Promise<void>
  /**
   * 对应 `fs.promises.stat` —— **可选**,因为当前唯一调用方不可达(见文件头)。
   * 未提供时 `stat()` 抛 `ENOENT`(与 `access` 未接宿主时同一语义)。
   * @param path - 绝对路径。
   */
  readonly stat?: (path: string) => Promise<IStats>
  /**
   * 对应 `fs.promises.readFile`(**不带 encoding** 的那一种重载)——
   * **可选**,因为当前唯一调用方(`lib/markdown-filters/emoji-filter.ts`)不可达。
   * 未提供时 `readFile()` 抛 `ENOENT`(与 `stat` 同一语义)。
   *
   * ⚠️ **返回值必须是 `IReadFileBuffer`(字节),不能是字符串**:上游调用点是
   * `imageBuffer.toString('base64')`(`emoji-filter.ts:134-135`)。若这里回一个 `string`,
   * `String.prototype.toString` 会**忽略参数**并返回原字符串 ⇒ 产出的 data URI 是
   * `data:image/png;base64,<整份文件内容>` —— **一个静默的坏图**,正是本仓反复出现的
   * 「替身悄悄偏离真契约」缺陷类。所以类型上就把它钉住,而不是靠注释。
   * @param path - 绝对路径(见 `fileURLToPath` 的边界:调用方传进来的可能是 `file://` 地址)。
   */
  readonly readFile?: (path: string) => Promise<IReadFileBuffer>
}

/**
 * `fs.promises.readFile`(**无 encoding** 重载)返回值的最小形状 —— 即 node `Buffer`
 * 里上游**真正调用过**的那一个方法。
 *
 * 上游唯一调用点 `lib/markdown-filters/emoji-filter.ts:135` 是
 * `imageBuffer.toString('base64')`;这就是全部契约。声明成最小形状而不是完整 `Buffer`,
 * 是为了不假装我们提供了 `byteLength` / `subarray` / `write` 等浏览器半没有的东西。
 */
export interface IReadFileBuffer {
  /**
   * 与 `Buffer#toString` 同语义:按给定编码把字节解码成字符串。
   * @param encoding - 当前只声明上游用到的 `'base64'`。
   */
  toString(encoding: 'base64'): string
}


/**
 * `fs.promises.stat` 返回值的**最小形状**:只声明上游真正读的字段。
 *
 * 上游 `lib/large-files.ts` 只读 `size`,用来判「>100 MB 的超大文件」告警。
 * 声明成最小形状而不是完整 `Stats`,是为了不假装我们提供了时间戳/权限位等
 * 浏览器半根本拿不到的东西。
 */
export interface IStats {
  /** 文件字节数(上游 `lib/large-files.ts` 唯一的读取点)。 */
  readonly size: number
}

let host: IFsPromisesHost | null = null

/**
 * 装上宿主实现。传 `null` 卸下(回到「恒 ENOENT」)。幂等。
 * @param next - 宿主实现,或 `null`。
 */
export function setFsPromisesHost(next: IFsPromisesHost | null): void {
  host = next
}

/** 当前是否接了宿主(给探针与诊断用)。 */
export function isFsPromisesHostInstalled(): boolean {
  return host !== null
}

/**
 * 造一个与 node 同名同 `code` 的错误,方便调用方按 `err.code` 判断。
 * @param path - 出错的路径。
 * @param op - 出现在消息里的操作名(`access` / `stat`)。
 */
function enoent(path: string, op = 'access'): Error & { code: string } {
  const error = new Error(`ENOENT: no such file or directory, ${op} '${path}'`) as Error & {
    code: string
  }
  error.code = 'ENOENT'
  return error
}

/**
 * 上游 `fs/promises` 的 `access`。**存在 → resolve;不存在 → reject(ENOENT)**。
 * @param path - 绝对路径。
 */
export async function access(path: string): Promise<void> {
  if (host === null) {
    throw enoent(path)
  }
  return host.access(path)
}

/**
 * 上游 `fs/promises` 的 `stat`。**存在 → 返回最小 `IStats`;不存在 → reject(ENOENT)**。
 *
 * ## 为什么现在才补它
 *
 * `lib/large-files.ts`(逐字镜像,42 行)第 4 行是 `import { stat } from 'fs/promises'`,
 * 用来判「仓库里有 >100 MB 的超大文件」。此前本文件只导出 `access` / `realpath`,
 * 于是那个镜像文件带着 `TS2614`(具名导出不存在)。
 *
 * ## 为什么可以是「抛错的」
 *
 * 唯一调用方 `ui/changes/oversized-files-warning.tsx` 与 `ui/changes/sidebar.tsx`
 * **当前都不可达**(Changes 容器尚未接线),所以这条路径在真实界面里走不到。
 * 按本文件的既有约定:**没接宿主时保持「不可用」并抛 ENOENT**,而不是编一个
 * 假的大小 —— 假的大小会让「超大文件告警」在真实接线后**静默失灵**。
 * 宿主侧一旦提供 `stat`(例如走 `repo/tree` 的 blob 大小),即可无改动接上。
 * @param path - 绝对路径。
 */
export async function stat(path: string): Promise<IStats> {
  if (host === null || host.stat === undefined) {
    throw enoent(path, 'stat')
  }
  return host.stat(path)
}

export async function realpath(p: string): Promise<string> {
  if (!warned) {
    warned = true
    console.info(
      '[dsh-git] fs.realpath 在浏览器半是恒等实现(不解析符号链接);resolveWithin 的防护依赖宿主侧校验。'
    )
  }
  return p
}

/**
 * 上游 `fs/promises` 的 `readFile`(**无 encoding** 的那个重载)。
 *
 * ## 为什么现在才补它
 *
 * 镜像 `lib/markdown-filters/emoji-filter.ts:3` 是 `import { readFile } from 'fs/promises'`,
 * 用来把 emoji 图片读成 base64 data URI;此前本文件没有这个具名导出 ⇒ 整个
 * `lib/markdown-filters/**` 集群(14 文件,互相成环)**一条 TS2614 ×2 卡住**。
 *
 * ## 契约由调用点钉死(不是由我选)
 *
 * 调用点是 `imageBuffer.toString('base64')` ⇒ 返回**必须是字节**,不能是字符串
 * (见 `IFsPromisesHost.readFile` 的 ⚠️)。因此签名刻意**不带 `encoding` 参数**:
 * 上游调用点不传 encoding,而我若接受一个 `encoding` 却不按它分派,那才是真正的
 * 静默偏离 —— 需要 utf8 文本读取时应当另加一个**显式的**重载,而不是在这里假装。
 *
 * ## 为什么可以是「抛错的」
 *
 * 唯一调用链 `emoji-filter.ts:112` → `:134` 外面包着 `catch (e) {}`(`:127`),失败
 * 只是「这个 emoji 被跳过」。按本文件既有约定:**没接宿主时保持「不可用」并抛 ENOENT**,
 * 而不是编一份假字节 —— 假字节会渲染出一张**坏图**,比明确的失败难查得多。
 * (补充事实:`references/desktop/gemoji/` 在这个 checkout 里是**空的**,所以 emoji
 * 数据集本身也拿不到;这条链在接上宿主前不可能工作。)
 * @param path - 绝对路径(注意:上游传的是 `fileURLToPath(emoji.url)` 的结果,见那个函数的边界)。
 * @returns 一份能 `toString('base64')` 的字节。
 */
export async function readFile(path: string): Promise<IReadFileBuffer> {
  if (host === null || host.readFile === undefined) {
    throw enoent(path, 'readFile')
  }
  return host.readFile(path)
}

export default { realpath, access, stat, readFile }
