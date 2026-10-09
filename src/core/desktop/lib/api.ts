/**
 * **dsh-git 手写替身(shim)** —— 上游 `lib/api.ts`(2499 行)。
 *
 * 上游是 Desktop 的 **GitHub REST 客户端**:`API` 类 + `IAPIRepository` 等模型 +
 * `request()` 走 `./http`(Electron `net`/`fetch` + token 池),并且 import 了
 * `lib/copilot-*`、`lib/databases/**`、`ui/secret-scanning/**` ——
 * 目标文档 §1.3 明确**不沿用**那一坨应用层。整个文件引进来会把闭包从 130
 * 涨到 340+ 文件,而移植的仓库列表**一个网络请求都不需要**。
 *
 * 因此这里只保留**仓库列表闭包与 app-state 契约真正用到的**导出,
 * 且实现/声明逐字取自上游同名位置:
 *
 * | 本 shim 的导出 | 上游位置 | 使用者(实证) |
 * |---|---|---|
 * | `getHTMLURL(endpoint)` | `lib/api.ts:2288` | `ui/repositories-list/group-repositories.ts:9`(分组时给每个 GitHub 仓库算 HTML 地址) |
 * | `getDotComAPIEndpoint()` | `lib/api.ts:2336` | 同上经由 `lib/endpoint-capabilities.ts:2` |
 * | `GitHubAccountType`(类型) | `lib/api.ts:141` | `models/owner.ts:1`(镜像里**早已存在**且字节一致,之前一直是悬空 import) |
 *
 * 下面四个**纯类型**是随镜像 `lib/app-state.ts`(逐字引入)**新补**的 ——
 * 该文件 `:68` 取 `IAPIRepoRuleset`,而它的 `IAccountRepositories`(`:49`)链上
 * `IAPIRepository` → `IAPIIdentity`。**类型声明与上游一致自上游,零运行期代码**:
 *
 * | 本 shim 的导出 | 上游位置 | 引入理由(逐条可追) |
 * |---|---|---|
 * | `IAPIRepoRuleset` | `lib/api.ts:580` | `lib/app-state.ts:68` 直接 import |
 * | `IAPISlimRepoRuleset` | `lib/api.ts:573` | 上面那个 `extends` 的基接口 |
 * | `IAPIRepository` | `lib/api.ts:149` | `lib/stores/api-repositories-store.ts:71`(`IAccountRepositories.repositories`) |
 * | `IAPIIdentity` | `lib/api.ts:244` | 上面那个的 `owner` 字段 |
 *
 * 下面两个是 **2026-10 A2 批次**新补的 —— 它们是两条被 A2 判为「可与上游一致」的
 * 上游文件的**直接 import**,没有它们那两份文件连编译都过不去(实测 `check-types`
 * 各报 1 条 TS2305,见 `docs/changes-state-adoption.md` §2.2 的更正):
 *
 * | 本 shim 的导出 | 上游位置 | 引入理由(逐条可追) |
 * |---|---|---|
 * | `getAccountForEndpoint(accounts, endpoint)` | `lib/api.ts:2350` | `lib/get-account-for-repository.ts:3`(整份文件唯一的不纯 import);实现与上游一致,零依赖,不碰 `API`/`./http` |
 * | `IAPIPushControl`(纯类型) | `lib/api.ts:478` | `lib/helpers/push-control.ts:1` 只取它的 4 个字段;纯类型,零运行期代码 |
 *
 * **刻意偏离上游两处**(都不改语义,只把 Electron 的环境变量换成常量):
 *  - `process.env['DESKTOP_GITHUB_DOTCOM_HTML_URL']` → `undefined`。
 *    上游只有在调试本地 GitHub 网站时才设置它;未设置时 `getHTMLURL` 走正常分支,
 *    与这里完全一致。
 *  - `process.env['DESKTOP_GITHUB_DOTCOM_API_ENDPOINT']` → `undefined`,同理,
 *    于是 `getDotComAPIEndpoint()` 返回上游的默认值 `'https://api.github.com'`。
 *
 * 其余分支(`isGHE` / `URL.parse`)与上游逐字一致。
 * `lib/endpoint-capabilities.ts` 是**与上游一致**,与本文件互相 import ——
 * 上游也是如此(上游 `lib/api.ts:23` 就 import 它的 `isDotCom/isGHE/isGHES`)。
 * 注意它需要真的 `semver` 包(已装,上游 `references/desktop/package.json:98`
 * 是 `^7.6.3`),不是手写替代品。
 * @module dsh-git/core/desktop/lib/api
 */

import * as URL from 'url'
import { isGHE } from './endpoint-capabilities'
import type { Account } from '../models/account'

/** 上游 `lib/api.ts:33/34` 的构建期环境变量;浏览器半没有 `process.env`,按「未设置」处理。 */
const envHTMLURL: string | undefined = undefined
const envEndpoint: string | undefined = undefined

/** 上游 `lib/api.ts:141`。 */
export type GitHubAccountType = 'User' | 'Organization'

/**
 * Get the URL for the HTML site. For example:
 *
 * https://api.github.com -> https://github.com
 * http://github.mycompany.com/api -> http://github.mycompany.com/
 *
 * 上游 `lib/api.ts:2288`,除上面说明的两个环境变量外逐字相同。
 */
export function getHTMLURL(endpoint: string): string {
  if (envHTMLURL !== undefined) {
    return envHTMLURL
  }

  // In the case of GitHub.com, the HTML site lives on the parent domain.
  //  E.g., https://api.github.com -> https://github.com
  //
  // Whereas with Enterprise, it lives on the same domain but without the
  // API path:
  //  E.g., https://github.mycompany.com/api/v3 -> https://github.mycompany.com
  //
  // We need to normalize them.
  if (endpoint === getDotComAPIEndpoint() && !envEndpoint) {
    return 'https://github.com'
  } else {
    if (isGHE(endpoint)) {
      const url = new window.URL(endpoint)

      url.pathname = '/'

      if (url.hostname.startsWith('api.')) {
        url.hostname = url.hostname.replace(/^api\./, '')
      }

      return url.toString()
    }

    const parsed = URL.parse(endpoint)
    return `${parsed.protocol}//${parsed.hostname}`
  }
}

/** Get github.com's API endpoint. 上游 `lib/api.ts:2336`。 */
export function getDotComAPIEndpoint(): string {
  // NOTE:
  // `DESKTOP_GITHUB_DOTCOM_API_ENDPOINT` only needs to be set if you are
  // developing against a local version of GitHub the Website, and need to debug
  // the server-side interaction. For all other cases you should leave this
  // unset.
  if (envEndpoint && envEndpoint.length > 0) {
    return envEndpoint
  }

  return 'https://api.github.com'
}

/**
 * Get the account for the endpoint.
 *
 * 上游 `lib/api.ts:2350`,**逐字相同** —— 它不碰 `API` 类、不碰 `./http`,
 * 只是一个 `Array.prototype.find`,所以可以整份搬进来而**不是**降级替身。
 * 唯一的外部名是 `Account`(纯类型,`import type` 引入 ⇒ 无运行期环)。
 */
export function getAccountForEndpoint(
  accounts: ReadonlyArray<Account>,
  endpoint: string
): Account | null {
  return accounts.find(a => a.endpoint === endpoint) || null
}

// ---------------------------------------------------------------------------
// app-state 契约所需的纯类型(逐字取自上游,见文件头的表)
// ---------------------------------------------------------------------------

/**
 * Information about a repository as returned by the GitHub API.
 */
export interface IAPIRepository {
  readonly clone_url: string
  readonly ssh_url: string
  readonly html_url: string
  readonly name: string
  readonly owner: IAPIIdentity
  readonly private: boolean
  readonly fork: boolean
  readonly default_branch: string
  readonly pushed_at: string
  readonly has_issues: boolean
  readonly archived: boolean
}

/**
 * Minimum subset of an identity returned by the GitHub API
 */
export interface IAPIIdentity {
  readonly id: number
  readonly login: string
  readonly avatar_url: string
  readonly html_url: string
  readonly type: GitHubAccountType
}

/**
 * A ruleset returned from the GitHub API's "get all rulesets for a repo" endpoint.
 * This endpoint returns a slimmed-down version of the full ruleset object, though
 * only the ID is used.
 */
export interface IAPISlimRepoRuleset {
  readonly id: number
}

/**
 * A ruleset returned from the GitHub API's "get a ruleset for a repo" endpoint.
 */
export interface IAPIRepoRuleset extends IAPISlimRepoRuleset {
  /**
   * Whether the user making the API request can bypass the ruleset.
   */
  readonly current_user_can_bypass: 'always' | 'pull_requests_only' | 'never'
}

/** Protected branch information returned by the GitHub API. 上游 `lib/api.ts:478`,逐字。 */
export interface IAPIPushControl {
  /**
   * What status checks are required before merging?
   *
   * Empty array if user is admin and branch is not admin-enforced
   */
  required_status_checks: Array<string>

  /**
   * How many reviews are required before merging?
   *
   * 0 if user is admin and branch is not admin-enforced
   */
  required_approving_review_count: number

  /**
   * Is user permitted?
   *
   * Always `true` for admins.
   * `true` if `Restrict who can push` is not enabled.
   * `true` if `Restrict who can push` is enabled and user is in list.
   * `false` if `Restrict who can push` is enabled and user is not in list.
   */
  allow_actor: boolean

  /**
   * Currently unused properties
   */
  pattern: string | null
  required_signatures: boolean
  required_linear_history: boolean
  allow_deletions: boolean
  allow_force_pushes: boolean
}

// ---------------------------------------------------------------------------
// History 面新增:avatar 需要的 `API` 类(只补这一个导出,见下面的说明)
// ---------------------------------------------------------------------------

/**
 * 上游 `lib/api.ts:827` 的 `API` —— Desktop 的 GitHub REST 客户端。
 *
 * **为什么这里必须有这个名字**:镜像的 `ui/lib/avatar.tsx:4` 写的是
 * `import { API, getDotComAPIEndpoint, getHTMLURL } from '../../lib/api'`,
 * 而 `avatar.tsx` 是 `avatar-stack.tsx` → `commit-list-item.tsx` /
 * `expandable-commit-summary.tsx` 的依赖 —— 也就是 History 页签的提交列表与摘要头。
 * esbuild 对**具名导入缺失**是硬错(`No matching export in "src/core/desktop/lib/api.ts"
 * for import "API"`),所以没有这个名字,整条 History 列都进不了包。
 *
 * **只保留 `avatar.tsx` 真正用到的三个成员**,名字与签名逐字取自上游:
 *  - `constructor(endpoint: string, token: string)`(`lib/api.ts:857`);
 *  - `getAvatarToken()`(`lib/api.ts:1580`);
 *  - `fetchUser(login)`(`lib/api.ts:1237`)。
 *
 * **两个调用点在我们在的这条路径上不可达,真被走到就抛错**:
 *  - `avatar.tsx:36-39`:先 `accounts.find(a => a.endpoint === endpoint)`,
 *    找不到就 `throw new Error('No account found for endpoint')`;
 *  - `avatar.tsx:78-81`:先 `getBotLogin(user)`,而它对
 *    `user.endpoint === null` 直接返回 `undefined` ⇒ 下一行就 `throw`
 *    (我们的 `getAvatarUserFromAuthor` 在 `gitHubRepository === null` 时正是给 `null`)。
 *  两个调用点的**上游下文**都是 `if (!account) throw`,而 History 适配层传
 *  `accounts={[]}` ⇒ 构造客户端的语句永远到不了。
 *
 * **刻意不实现真请求**:真实现要走 `./http`(Electron `net` + token 池)与
 * `lib/copilot-*`,那是 §1.3 排除的应用层。这里抛错而不是静默返回假数据 ——
 * 返回假头像 URL 会让界面画出一个**错的**头像,那比一个明确的异常难查得多。
 */
export class API {
  /**
   * @param endpoint - 上游的 `endpoint`(api.github.com 或 GHES 的 `.../api/v3`)。
   * @param token - 账号 token;本替身从不使用它(不发任何请求)。
   */
  /**
   * 上游 `lib/api.ts:842`:
   * ```ts
   * public static fromAccount(account: Account): API {
   *   return new API(account.endpoint, account.token, account.copilotEndpoint)
   * }
   * ```
   * 我们的构造器只有两个参数(copilot 属于 §1.3 排除的应用层)⇒ 第三项不传。
   * **这是抄进来的 `lib/stores/commit-status-store.ts:283` 唯一的取客户端入口**
   * (`API.fromAccount(account)`),所以它必须存在,否则整条链在类型上就断了。
   * @param account - 账号(令牌不再使用:请求经宿主代理,令牌只存在宿主)。
   */
  public static fromAccount(account: Account): API {
    return new API(account.endpoint, account.token)
  }

  public constructor(
    public readonly endpoint: string,
    public readonly token: string,
  ) {}

  /** 上游 `lib/api.ts:1580`。 */
  public async getAvatarToken(): Promise<string | null> {
    throw new Error(
      `GitHub API 在浏览器半不可用(lib/api.ts 的最小替身,只覆盖 avatar 的 import):${this.endpoint}`,
    )
  }

  /**
   * 上游 `lib/api.ts:1237` 返回 `IAPIUser`(上游 `:839` 那个 20 多字段的接口)。
   * 本 shim 不搬那个接口,**只保留 `avatar.tsx:83` 真正读的一个字段**(`avatar_url`)——
   * 结构类型足以让调用点类型正确,也不会凭空造一个与上游必填/可选性不同的接口。
   */
  public async fetchUser(_login: string): Promise<{ readonly avatar_url: string } | null> {
    throw new Error(
      `GitHub API 在浏览器半不可用(lib/api.ts 的最小替身,只覆盖 avatar 的 import):${this.endpoint}`,
    )
  }

  // -------------------------------------------------------------------------
  // CI 面(2026-10-07「抄优先」):check-runs / 老式 commit status
  // -------------------------------------------------------------------------

  /**
   * 把注入的传输拿过来;没注入就抛——**不静默返回假数据**。
   * @param what - 出错信息里点名的上游方法。
   */
  private transportOf(what: string): IGitHubTransport {
    if (githubTransport === null) {
      throw new Error(
        `GitHub 传输层未注入(lib/api.ts 的 ${what};浏览器半应由 src/client/ci-transport.ts 注入 gh-api.ts)`,
      )
    }
    return githubTransport
  }

  /**
   * 上游 `lib/api.ts:1409-1436`(`fetchRefCheckRuns`,含 `Accept: antiope-preview`)。
   * 路径与分页逐字:`repos/{owner}/{name}/commits/{encodeURIComponent(ref)}/check-runs?per_page=100`。
   * @returns `{total_count, check_runs}`;失败回 `null`(上游同样 `return null` 而不是抛)。
   */
  public async fetchRefCheckRuns(owner: string, name: string, ref: string): Promise<IAPIRefCheckRuns | null> {
    const transport = this.transportOf('fetchRefCheckRuns')
    const safeRef = encodeURIComponent(ref)
    try {
      return (await transport.request(
        `repos/${owner}/${name}/commits/${safeRef}/check-runs?per_page=100`,
        { accept: 'application/vnd.github.antiope-preview+json' },
      )) as IAPIRefCheckRuns
    } catch {
      return null
    }
  }

  /**
   * 上游 `lib/api.ts:1383-1406`(`fetchCombinedRefStatus`)。
   * 路径与分页逐字:`repos/{owner}/{name}/commits/{encodeURIComponent(ref)}/status?per_page=100`。
   */
  public async fetchCombinedRefStatus(owner: string, name: string, ref: string): Promise<IAPIRefStatus | null> {
    const transport = this.transportOf('fetchCombinedRefStatus')
    const safeRef = encodeURIComponent(ref)
    try {
      return (await transport.request(
        `repos/${owner}/${name}/commits/${safeRef}/status?per_page=100`,
      )) as IAPIRefStatus
    } catch {
      return null
    }
  }

  /**
   * 上游 `lib/api.ts` 的 `rerequestCheckSuite`(`POST repos/{o}/{r}/check-suites/{id}/rerequest`)。
   * 被 `commit-status-store.ts:538-550` 的 `rerequestCheckSuite` 调用。
   */
  public async rerequestCheckSuite(owner: string, name: string, checkSuiteId: number): Promise<boolean> {
    const transport = this.transportOf('rerequestCheckSuite')
    return this.postOk(transport, `repos/${owner}/${name}/check-suites/${checkSuiteId}/rerequest`)
  }

  /** 上游 `rerunJob`(`POST repos/{o}/{r}/actions/jobs/{id}/rerun`;`commit-status-store.ts:552-564`)。 */
  public async rerunJob(owner: string, name: string, jobId: number): Promise<boolean> {
    const transport = this.transportOf('rerunJob')
    return this.postOk(transport, `repos/${owner}/${name}/actions/jobs/${jobId}/rerun`)
  }

  /** 上游 `rerunFailedJobs`(`POST repos/{o}/{r}/actions/runs/{id}/rerun-failed-jobs`;`commit-status-store.ts:566-578`)。 */
  public async rerunFailedJobs(owner: string, name: string, workflowRunId: number): Promise<boolean> {
    const transport = this.transportOf('rerunFailedJobs')
    return this.postOk(transport, `repos/${owner}/${name}/actions/runs/${workflowRunId}/rerun-failed-jobs`)
  }

  /** 上游 `fetchCheckSuite`(`GET repos/{o}/{r}/check-suites/{id}`;`commit-status-store.ts:580-592`)。 */
  public async fetchCheckSuite(owner: string, name: string, checkSuiteId: number): Promise<IAPICheckSuite | null> {
    const transport = this.transportOf('fetchCheckSuite')
    try {
      return (await transport.request(`repos/${owner}/${name}/check-suites/${checkSuiteId}`)) as IAPICheckSuite
    } catch {
      return null
    }
  }

  /**
   * 上游 `fetchWorkflowRunJobs`(`GET repos/{o}/{r}/actions/runs/{id}/jobs`)。
   * 被 `lib/ci-checks/ci-checks.ts:340` 的 `getLatestPRWorkflowRunsLogsForCheckRun` 调用
   * (拿 job 的 `html_url` 与 `steps`)。
   */
  public async fetchWorkflowRunJobs(owner: string, name: string, id: number): Promise<IAPIWorkflowJobs | null> {
    const transport = this.transportOf('fetchWorkflowRunJobs')
    try {
      return (await transport.request(`repos/${owner}/${name}/actions/runs/${id}/jobs`)) as IAPIWorkflowJobs
    } catch {
      return null
    }
  }

  /**
   * 上游 `fetchPRActionWorkflowRunByCheckSuiteId`
   * (`GET repos/{o}/{r}/actions/runs?check_suite_id={id}` ⇒ 取 `.workflow_runs[0]`)。
   * 被 `ci-checks.ts:451` 走「按 check suite」那条分支时调用。
   */
  public async fetchPRActionWorkflowRunByCheckSuiteId(owner: string, name: string, checkSuiteId: number): Promise<IAPIWorkflowRun | null> {
    const transport = this.transportOf('fetchPRActionWorkflowRunByCheckSuiteId')
    try {
      const page = (await transport.request(
        `repos/${owner}/${name}/actions/runs?check_suite_id=${checkSuiteId}`,
      )) as IAPIWorkflowRuns
      return page.workflow_runs[0] ?? null
    } catch {
      return null
    }
  }

  /**
   * 上游 `fetchPRWorkflowRunsByBranchName`
   * (`GET repos/{o}/{r}/actions/runs?branch={branch}`;GHES 的回落路径,`ci-checks.ts:482`)。
   */
  public async fetchPRWorkflowRunsByBranchName(owner: string, name: string, branchName: string): Promise<IAPIWorkflowRuns | null> {
    const transport = this.transportOf('fetchPRWorkflowRunsByBranchName')
    try {
      return (await transport.request(
        `repos/${owner}/${name}/actions/runs?branch=${encodeURIComponent(branchName)}`,
      )) as IAPIWorkflowRuns
    } catch {
      return null
    }
  }

  /** `POST` 成功即 `true`(上游那三个 `rerun*`/`rerequest*` 的返回语义)。 */
  private async postOk(transport: IGitHubTransport, path: string): Promise<boolean> {
    try {
      await transport.request(path, { method: 'POST' })
      return true
    } catch {
      return false
    }
  }
}

/**
 * 上游 `lib/api.ts:2350-2355` 的 `getAccountForEndpoint` **已经在上面 `:127` 有了**
 * (那是为 `lib/get-account-for-repository.ts` 补的,实现与上游逐字一致)——
 * CI 这一族(`lib/stores/commit-status-store.ts:541,555,571,585`)复用它,不另起一份。
 */

// ---------------------------------------------------------------------------
// 传输注入点(浏览器半把 `gh-api.ts` 装进来;`core` 不 import `client`)
// ---------------------------------------------------------------------------

/**
 * 一次 GitHub REST 调用的最小契约。与 `src/client/gh-api.ts` 的 `gh<T>()` 同形:
 * 成功回**解开的 JSON**,失败**抛**。
 *
 * 为什么是注入而不是直接在 `lib/api.ts` 里 import `gh-api.ts`:
 *  - `lib/api.ts` 在 `src/core/desktop/**`(镜像层),`gh-api.ts` 在 `src/client/**`
 *    (适配层);core → client 的反向依赖会让 host 半的类型程序也把浏览器传输拖进去;
 *  - 注入点让**探针**可以装一个内存桩(本仓的探针纪律:`api.github.com` 一次都不碰)。
 */
export interface IGitHubTransport {
  request(
    path: string,
    init?: { readonly method?: string; readonly body?: unknown; readonly accept?: string },
  ): Promise<unknown>
}

let githubTransport: IGitHubTransport | null = null

/** 装入/清空传输(浏览器半 `src/client/ci-transport.ts` 调用;传 `null` 复原)。 */
export function setGitHubTransport(next: IGitHubTransport | null): void {
  githubTransport = next
}

// ---------------------------------------------------------------------------
// CI 面的类型(逐字取自上游 `lib/api.ts`,每条标了上游行号)
// ---------------------------------------------------------------------------

/** 上游 `lib/api.ts:346`,逐字。 */
export type APIRefState = 'failure' | 'pending' | 'success' | 'error'

/** 上游 `lib/api.ts:350-354`,逐字。 */
export enum APICheckStatus {
  Queued = 'queued',
  InProgress = 'in_progress',
  Completed = 'completed',
}

/** 上游 `lib/api.ts:357-366`,逐字。 */
export enum APICheckConclusion {
  ActionRequired = 'action_required',
  Canceled = 'cancelled',
  TimedOut = 'timed_out',
  Failure = 'failure',
  Neutral = 'neutral',
  Success = 'success',
  Skipped = 'skipped',
  Stale = 'stale',
}

/** 上游 `lib/api.ts:372-378`,逐字。 */
export interface IAPIRefStatusItem {
  readonly state: APIRefState
  readonly target_url: string | null
  readonly description: string
  readonly context: string
  readonly id: number
}

/** 上游 `lib/api.ts:381-385`,逐字。 */
export interface IAPIRefStatus {
  readonly state: APIRefState
  readonly total_count: number
  readonly statuses: ReadonlyArray<IAPIRefStatusItem>
}

/** 上游 `lib/api.ts:402-404`,逐字。 */
export interface IAPIRefCheckRunApp {
  readonly name: string
}

/** 上游 `lib/api.ts:407-411`,逐字。 */
export interface IAPIRefCheckRunOutput {
  readonly title: string | null
  readonly summary: string | null
  readonly text: string | null
}

/** 上游 `lib/api.ts:413-415`,逐字。 */
export interface IAPIRefCheckRunCheckSuite {
  readonly id: number
}

/**
 * 上游 `lib/api.ts:387-399`,逐字。
 * ⚠️ 注意 `pull_requests` 的元素类型上游是 `IAPIPullRequest`(上游 `:636-647`)——
 * 这里**照抄那个引用**,因为 `getLatestCheckRunsById` 只读它的 `length`。
 */
export interface IAPIRefCheckRun {
  readonly id: number
  readonly url: string
  readonly status: APICheckStatus
  readonly conclusion: APICheckConclusion | null
  readonly name: string
  readonly check_suite: IAPIRefCheckRunCheckSuite
  readonly app: IAPIRefCheckRunApp
  readonly completed_at: string
  readonly started_at: string
  readonly html_url: string
  readonly pull_requests: ReadonlyArray<IAPIPullRequest>
}

/** 上游 `lib/api.ts:636-647`,逐字(类型引用需要,运行期用不到)。 */
export interface IAPIPullRequest {
  readonly number: number
  readonly title: string
  readonly created_at: string
  readonly updated_at: string
  readonly user: IAPIIdentity
  readonly head: IAPIPullRequestRef
  readonly base: IAPIPullRequestRef
  readonly body: string
  readonly state: 'open' | 'closed'
  readonly draft?: boolean
}

/** 上游 `lib/api.ts` 的 `IAPIPullRequestRef`(只保留 `sha`/`ref`/`label`,被 check run 那条链引用)。 */
export interface IAPIPullRequestRef {
  readonly sha: string
  readonly ref: string
  readonly label: string
}

/** 上游 `lib/api.ts:417-423`,逐字。 */
export interface IAPICheckSuite {
  readonly id: number
  readonly rerequestable: boolean
  readonly runs_rerequestable: boolean
  readonly status: APICheckStatus
  readonly created_at: string
}

/** 上游 `lib/api.ts:425-428`,逐字。 */
export interface IAPIRefCheckRuns {
  readonly total_count: number
  readonly check_runs: IAPIRefCheckRun[]
}

/** 上游 `lib/api.ts:430-433`(`interface IAPIWorkflowRuns`,非导出 ⇒ 这里导出给注入层用)。 */
export interface IAPIWorkflowRuns {
  readonly total_count: number
  readonly workflow_runs: ReadonlyArray<IAPIWorkflowRun>
}

/** 上游 `lib/api.ts:435-448`,逐字。 */
export interface IAPIWorkflowRun {
  readonly id: number
  /**
   * The workflow_id is the id of the workflow not the individual run.
   **/
  readonly workflow_id: number
  readonly cancel_url: string
  readonly created_at: string
  readonly logs_url: string
  readonly name: string
  readonly rerun_url: string
  readonly check_suite_id: number
  readonly event: string
}

/** 上游 `lib/api.ts:450-453`,逐字。 */
export interface IAPIWorkflowJobs {
  readonly total_count: number
  readonly jobs: ReadonlyArray<IAPIWorkflowJob>
}

/** 上游 `lib/api.ts:456-465`,逐字。 */
export interface IAPIWorkflowJob {
  readonly id: number
  readonly name: string
  readonly status: APICheckStatus
  readonly conclusion: APICheckConclusion | null
  readonly completed_at: string
  readonly started_at: string
  readonly steps: ReadonlyArray<IAPIWorkflowJobStep>
  readonly html_url: string
}

/** 上游 `lib/api.ts:467-475`,逐字。 */
export interface IAPIWorkflowJobStep {
  readonly name: string
  readonly number: number
  readonly status: APICheckStatus
  readonly conclusion: APICheckConclusion | null
  readonly completed_at: string
  readonly started_at: string
  readonly log: string
}
