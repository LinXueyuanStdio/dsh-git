/**
 * **dsh-git 手写替身(shim)—— 纯类型级** —— 上游 `lib/stores/git-store.ts`(**1777 行**)。
 *
 * ## 上游那份为什么不能直接沿用(逐条证据)
 *
 * 上游 `lib/stores/git-store.ts:1-101` 的 import 表:最外层是 `path`、`fs/promises`、
 * `dugite`,里面是 `../git`(整个 `lib/git/**`,每一支都 `import { git } from './core'`
 * → dugite)、`../git/stash`、`./helpers/find-forked-remotes-to-prune`、
 * `../find-default-branch`。也就是说这 1777 行**整个是宿主侧 git 能力**:
 * 它把 `dugite` 的进程调用包成 store 的读写方法。
 * 目标文档 §2.3/§2.4 的两条硬约束(`client` 禁止 node 内置;git 一律走 host 的
 * `/dsh-git/*` 路由)合起来 ⇒ 这一层在浏览器半**不存在**,而且**不应该**存在。
 *
 * ## 本替身是什么、不是什么(边界写死,别读成「已经复现了」)
 *
 * | 项 | 取值 |
 * |---|---|
 * | **保留的上游导出名** | `GitStore`(上游 `git-store.ts:112` 的 `export class GitStore extends BaseStore`) |
 * | **kind 被窄化** | 上游是 **class**,这里是 **interface** —— 这是**有意的** |
 * | **成员** | 只声明「当前镜像里**已经逐字落地**且处于类型位置的消费方」用到的那几个 |
 * | **运行期代码** | **零**(`interface` 被 tsc/esbuild 整体擦除) |
 * | **产物字节** | **0**(本文件不可达,esbuild 从不编译它) |
 *
 * ### kind 为什么必须是「类型」,而不是 `declare class` 或一个 no-op class
 *
 * 本仓最贵的缺陷类是「**替身与真契约静默分家**」(目标文档 §3 失败模式 7/9、`docs/type-check.md` §4)。
 * 三种写法在这一条上的表现**完全不同**:
 *
 * 1. **no-op class**(`export class GitStore { onDidUpdate(){} setRemoteURL(){…} }`)——
 *    **最坏**:上游 `lib/stores/git-store-cache.ts:34` 会 `new GitStore(...)` 成功,
 *    得到一个**什么都不做**的 store,`git-store-cache` 照常编译、照常返回对象,
 *    错误推迟到用户点下去那一刻,而且**没有任何一层会报错**。
 * 2. `declare class` —— `new GitStore()` 在**编译期合法**、运行期是
 *    `TypeError: GitStore is not a constructor`(esbuild 把 `declare` 抹掉后 `GitStore`
 *    是未绑定标识符)。比 1 好(响亮),但**错误漏到了运行期**。
 * 3. **纯类型声明**(本文件)——
 *    `new GitStore()` 是 **TS2693「'GitStore' only refers to a type, but is being used
 *    as a value here」**,在 `check-types` 那一刻就红。**这是唯一让错误停在编译期的写法。**
 *
 * ⚠️ **为什么写成 `type` 而不是 `interface`**:`.eslintrc.yml:67-75` 的
 * `@typescript-eslint/naming-convention` 对 `selector: interface` 强制 `/^I[A-Z]/`
 * —— 写成 `interface GitStore` 会**新增一条 lint 违规**(实测:`check-lint` 0 → 1),
 * 而改名成 `IGitStore` 就**不是上游的导出名**了(上游那份 1777 行里它就是 `GitStore`)。
 * `type` 选择器**不在**那条规则里,所以 `type GitStore = { … }` 同时满足
 * 「保留上游导出名」与「lint 无新增违规」。两者在类型检查上的行为完全一样
 * (`new` 都是 TS2693),不能声明合并 —— 本文件不需要合并。
 *
 * ⇒ 代价是:任何与上游一致过来的、把 `GitStore` 当值用的上游文件(最先会是
 * `lib/stores/git-store-cache.ts`)会**编译失败**。这正是我们要的 ——
 * 它逼下一个人去面对「GitStore 需要一份真实的宿主门面」,而不是拿到一个静默的假 store。
 *
 * ### 本替身**不复现**什么(逐条)
 *
 * 1. **不发起任何 git 调用**。上游那些方法(`loadStatus` / `loadBranches` /
 *    `setRemoteURL` / `fetch` / `pull` / `push` / …)一个都没有,连签名都不在这里 ——
 *    只声明**已落地消费方真正碰过**的成员(见下)。
 * 2. **没有 `TypedBaseStore<string>` 的事件面**。上游 `onDidUpdate` / `onDidError`
 *    来自 `./base-store`(`BaseStore`),本替身不声明它们。
 * 3. **不是 class ⇒ 不可实例化、不可继承**(见上一条的取舍)。
 * 4. **窄化会随消费方增长而漂移**:每多一个消费方就可能要加成员。
 *    这是**有意的方向** —— 加成员是「有人真的要用它」的证据;而漏成员会**编译报错**,
 *    不会静默。若哪一天本文件的成员表长到接近上游,正确做法是把它换成真实的宿主门面
 *    (即 §2.4 的 `git-argv.ts` → `git-service.ts` → `routes.ts` → `api.ts` 四层),
 *    而不是继续在这里补类型。
 *
 * ### 当前唯一的消费方
 *
 * `lib/stores/updates/update-remote-url.ts`(上游逐字,45 行,已落在同目录
 * `updates/update-remote-url.ts`):它只用两个成员 ——
 *   · `defaultRemote`(上游 `git-store.ts:1406` 的 `public get defaultRemote(): IRemote | null`,字段 `_defaultRemote` 在 `:148`、在 `loadRemotes()` 的 `:1292` 被赋值);
 *   · `setRemoteURL(name, url)`(上游 `git-store.ts:1534`)。
 *
 * @module dsh-git/core/desktop/lib/stores/git-store
 */

import { IRemote } from '../../models/remote'

/**
 * 上游 `lib/stores/git-store.ts:112` 的 `export class GitStore extends BaseStore`。
 *
 * ⚠️ **这里是 type alias,不是 class 也不是 interface**(理由见文件头)。成员逐条给出
 * 上游 `file:line`,签名逐字;没有实现,也不会有实现。
 */
export type GitStore = {
  /**
   * 上游 `git-store.ts:1406` —— `public get defaultRemote(): IRemote | null`。
   * 后备字段 `_defaultRemote`(`:148`)在 `loadRemotes()`(`:1292`)里被赋值。
   */
  readonly defaultRemote: IRemote | null
  /**
   * 上游 `git-store.ts:1534` ——
   * `public async setRemoteURL(name: string, url: string): Promise<boolean>`。
   * 实现走 `lib/git/remote.ts` 的 `setRemoteURL`(即一条 `git remote set-url` 命令)
   * 再 `loadRemotes()` + `emitUpdate()` ⇒ **一次真的 git 调用** ⇒ 归 host(见文件头第 1 条)。
   */
  setRemoteURL(name: string, url: string): Promise<boolean>
}
