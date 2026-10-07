/**
 * **dsh-git 手写替身(shim)** —— 上游 `app/src/lib/git/log.ts`(383 行)。
 *
 * ## 它替的是谁、为什么必须替
 *
 * 上游那份是**宿主侧 git 能力**:`import { git } from './core'`(`lib/git/core.ts:1`
 * 就 `import * as dugite from 'dugite'`),再加 `assert`/`Commit`/`CommitIdentity`/
 * `git-delimiter-parser`,整族都走 dugite + node 内置。浏览器半**不能有**
 * dugite / node 内置(goal 文档 §2.3),所以这一层按 §10.3 归类为
 * **`由 host 取代`**(§2.4:git 操作一律走 `/dsh-git/*` HTTP 到 host)。
 *
 * ## 为什么只实现 `getAuthors`(上游导出名与签名逐字保留)
 *
 * 实测:**整个镜像里只有 `ui/branches/branch-list.tsx:23` 一个 importer**,
 * 它只取 `getAuthors`(`references/desktop/app/src/ui/branches/branch-list.tsx:239`)。
 * 上游另外 5 个导出(`getCommits:120` / `IChangesetData:215` / `getChangedFiles:227` /
 * `parseRawLogWithNumstat:283` / `getCommit:344`)今天**零 importer**,所以刻意省略
 * —— 引进来只会让「看起来接上了」而实际不可达(§3 失败模式 1)。
 *
 * ## `getAuthors` 为什么返回空数组而不是打桩成功
 *
 * 上游实现是 `git log --format=... --no-walk=unsorted --stdin`(按**给定 sha 列表**
 * 取作者与日期)。我们 host 侧**没有**这条路由:
 * `src/host/routes.ts` 只有 `log`(`:466` → `git-service.ts:629`),它是
 * **按 ref 从新到旧分页**的,形状是 `{commits, hasMore}`,**不能**用来回答
 * 「这 N 个 sha 的作者是谁」——拿它硬凑会给出**错误的日期**(分支行的相对时间),
 * 那正是 §3 失败模式「静默给出坏数据」。
 *
 * ⇒ 这里返回 `[]`,**只让调用方少一个显示细节**,不伪造数据:
 * 唯一消费方 `branch-list.tsx:238-246` 用它填**分支行的 commit 日期缓存**,
 * 而它把失败路径写成 `.catch(e => log.error(...))`,
 * 且 `BranchListItem` 的 `authorDate === undefined` 是**合法输入**
 * (`branch-list-item.tsx:116` 起只在有日期时才渲染 `<RelativeTime>`),
 * 所以分支列表的所有按钮/过滤/勾选行为**一个都不受影响**。
 *
 * **需要补的宿主能力(不在本泳道所有权内,已登记报告)**:一条
 * `log/authors` 路由,参数 `{path, shas: string[]}` → `{authors: {name,email,date}[]}`
 * (host 侧即上游那条 `git log --no-walk=unsorted --stdin`)。补上之后,
 * 把本函数的 `return []` 换成对那条路由的调用即可,签名不用动。
 *
 * @module dsh-git/core/desktop/lib/git/log
 */

import { CommitIdentity } from '../../models/commit-identity'
import { Repository } from '../../models/repository'

/**
 * 上游 `:357` 的签名**逐字保留**:
 * `export async function getAuthors(repository: Repository, shas: string[])`。
 *
 * @param repository - 上游取 `repository.path` 去跑 git;这里**不使用**(见文件头)。
 * @param shas       - 要查作者的提交 sha 列表(上游用 `--stdin` 逐行喂给 git)。
 * @returns 空数组 —— 理由见文件头「为什么返回空数组而不是打桩成功」。
 */
export async function getAuthors(
  repository: Repository,
  shas: string[]
): Promise<CommitIdentity[]> {
  // 参数刻意保留(与上游签名一致),但避免 noUnusedLocals/死代码误报:显式 void。
  void repository
  void shas
  return []
}
