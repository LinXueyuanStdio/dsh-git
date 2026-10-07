/**
 * **dsh-git 手写替身(shim,纯类型)** —— 上游 `lib/stores/api-repositories-store.ts`(239 行)。
 *
 * ## 上游那份为什么不能直接沿用
 *
 * 上游的主体是 **`ApiRepositoriesStore` 类**(`:87`):`extends BaseStore`、
 * 走 `../api` 的 `API` 类(Desktop 的 GitHub REST 客户端 + token 池)、
 * `./accounts-store`、`../merge` —— 全是 §1.3 明确不沿用的应用层,
 * 而且会连带 `lib/copilot-*`、`lib/databases/**`、`ui/secret-scanning/**`。
 * 我们已有的 `lib/api.ts` 替身只需要 `getHTMLURL`/`getDotComAPIEndpoint`,
 * 一个网络请求都不发。
 *
 * ## 本 shim 必须保住的名字
 *
 * 实证:镜像 `lib/app-state.ts:49` 写的是
 * `import { IAccountRepositories } from './stores/api-repositories-store'`,
 * 只取 **`IAccountRepositories`** —— 上游 `:66`,声明**与上游一致**自上游
 * (含文档注释),两个字段一个不多一个不少。
 * **刻意省略**:`ApiRepositoriesStore` 类(`:87`)。
 * **零运行期代码**:本文件只有类型,没有任何值导出。
 *
 * 它引用的 `IAPIRepository` 来自上游 `lib/api.ts:149`,已按同一理由补进
 * 我们已有的 `lib/api.ts` 替身(那里是本仓库唯一登记过的 api 替身)。
 * @module dsh-git/core/desktop/lib/stores/api-repositories-store
 */

import { IAPIRepository } from '../api'

export interface IAccountRepositories {
  /**
   * The list of repositories that a particular account
   * has explicit permissions to access.
   */
  readonly repositories: ReadonlyArray<IAPIRepository>

  /**
   * Whether or not the list of repositories is currently
   * being loaded for the first time or refreshed.
   */
  readonly loading: boolean
}
