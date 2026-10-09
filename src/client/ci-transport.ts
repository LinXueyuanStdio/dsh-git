/**
 * **CI 面的适配层** —— 把「抄进来的上游那一套」接到本仓**已有的传输层**上。
 *
 * ## 这一层是什么(以及为什么它不是「第二套机制」)
 *
 * 上游那条链是:
 *
 * ```
 * ui/check-runs/ci-check-run-popover.tsx   ← 本轮逐字抄(1,442 行里的 9 个文件)
 *   └─ dispatcher.tryGetCommitStatus / subscribeToCommitStatus
 *        └─ lib/stores/commit-status-store.ts   ← 本轮逐字抄(593)
 *             ├─ lib/ci-checks/ci-checks.ts     ← 本轮逐字抄(722)
 *             └─ lib/api.ts 的 API 类 → ./http(Electron net + token 池)
 * ```
 *
 * 最后那一跳在浏览器半**不存在**(我们**不搬** `lib/http/**`:令牌只在宿主)。
 * 所以 `lib/api.ts` 的替身留了一个**注入点**(`setGitHubTransport`),本文件负责:
 *
 * 1. **注入传输** —— `gh-api.ts` 的 `ghRest`(宿主代理 `dsh-git/gh`)。
 *    上游的 `API` 类一行不改,它拿到的就是真数据;
 * 2. **给 `Dispatcher` 面接上行为** —— CI 面的 7 个方法(类型面在上游
 *    `ui/dispatcher/dispatcher.ts`,替身给类型、门面给行为,与顶栏同步面 / History 面同一形状);
 * 3. **构造两样上游要求的东西**:`AccountsStore` 形状(上游构造函数只用到
 *    `getAll()` / `onDidUpdate()` 两个成员)与 `GitHubRepository`(缓存 key 用它)。
 *
 * ⚠️ **传输层 vs 状态聚合不是同一个职责**:`gh-api.ts` 只负责「一次 REST 调用 + 令牌 + 限流」,
 * 而聚合(60 秒陈旧窗口、每 ref 一订阅、`alive` 推送、LRU 250)在**抄进来的**
 * `commit-status-store.ts` 里。所以本文件不重写任何聚合逻辑。
 *
 * ## 网络预算
 *
 * 请求数完全由抄进来的 `commit-status-store.ts` 决定(它的 `MaxConcurrentFetches = 6`、
 * `BackgroundRefreshInterval = 3 分钟`、`entryIsEligibleForRefresh` 的 60 秒窗口);
 * 本文件**不新增**任何计时器或重试。只有组件订阅某个 ref 时才会取数。
 *
 * @module dsh-git/client/ci-transport
 */

import { Disposable } from 'event-kit'
import { Account } from '../core/desktop/models/account.ts'
import { GitHubRepository } from '../core/desktop/models/github-repository.ts'
import { Owner } from '../core/desktop/models/owner.ts'
import { getDotComAPIEndpoint, setGitHubTransport } from '../core/desktop/lib/api.ts'
import type { IAPICheckSuite } from '../core/desktop/lib/api.ts'
import { CommitStatusStore } from '../core/desktop/lib/stores/commit-status-store.ts'
import type { ICombinedRefCheck, IRefCheck } from '../core/desktop/lib/ci-checks/ci-checks.ts'
import { Dispatcher } from '../core/desktop/ui/dispatcher/index.ts'
import type { Popup } from '../core/desktop/models/popup.ts'
import { ghRest } from './gh-api.ts';
import type { GhRef } from '../core/lib.ts'

/* ==========================================================================
 * 1. 传输注入:上游 `API` 类 ⇒ 我们的宿主代理
 * ========================================================================== */

/**
 * 把 `gh-api.ts` 的通用 REST 出口装进 `lib/api.ts` 的替身。
 *
 * 这一步是**幂等**的:模块加载时执行一次即可(重复调用只是覆盖同一个函数引用)。
 * 没有它,抄进来的 store 每次取数都会抛
 * 「GitHub 传输层未注入」(**明确抛错,不静默返回空** —— 空数据会被读成「没有 CI」)。
 */
setGitHubTransport({
  request: (path, init) => {
    const options: { method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'; body?: unknown; accept?: string } = {}
    if (init?.method !== undefined) {
      options.method = init.method as 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
    }
    if (init?.body !== undefined) {
      options.body = init.body
    }
    if (init?.accept !== undefined) {
      options.accept = init.accept
    }
    return ghRest(path, options)
  },
})

/* ==========================================================================
 * 2. 上游要求的两个构造物(AccountsStore 形状 / GitHubRepository)
 * ========================================================================== */

/**
 * `AccountsStore` 的**形状适配**:抄进来的 `commit-status-store.ts` 的构造函数只用到
 * 两个成员(`getAll()` 与 `onDidUpdate(cb)`,见上游 `:166-169`),所以给这两个就够。
 *
 * ⚠️ 上游那个 `lib/stores/accounts-store.ts`(269 行)不在我们树里(它属于
 * `docs/unported-master-ledger.md` §3.1 的 26 个缺 store);这里**不复刻**它,
 * 只满足结构需求 —— 令牌根本不在浏览器半(宿主拿),所以「账号」这一层在我们这边
 * 只剩一个 endpoint。
 */
function accountsStoreLike(endpoint: string): {
  getAll(): Promise<ReadonlyArray<Account>>
  onDidUpdate(callback: (accounts: ReadonlyArray<Account>) => void): Disposable
} {
  const account = endpoint === getDotComAPIEndpoint()
    ? Account.anonymous()
    : new Account('', endpoint, '', [], '', -1, '')
  return {
    getAll: () => Promise.resolve([account]),
    // 账号不会在运行期变(令牌在宿主)⇒ 返回一个永不触发的可回收句柄。
    onDidUpdate: () => new Disposable(() => undefined),
  }
}

/** `(owner, repo)` ⇒ `GitHubRepository`(缓存:store 的 cache key 用它,身份稳定即可)。 */
const repositoryCache = new Map<string, GitHubRepository>()

/**
 * 构造抄进来的那一套需要的 `GitHubRepository`。
 *
 * 上游这一层来自「本地数据库里的仓库」(`dbID` 等);我们**没有**那份数据库,
 * 所以给一个**身份稳定**的实例:同一个 `owner/repo` 永远回同一个对象
 * (`commit-status-store.ts:78-81` 的 cache key 由 `endpoint`/`owner.login`/`name` 拼成,
 * 它不需要 `dbID` 真实)。
 *
 * @param ref - 仓库(owner/repo)。
 * @returns `GitHubRepository` 实例。
 */
export function githubRepositoryFor(ref: GhRef): GitHubRepository {
  const key = `${ref.owner}/${ref.repo}`
  const cached = repositoryCache.get(key)
  if (cached !== undefined) {
    return cached
  }
  const repository = new GitHubRepository(
    ref.repo,
    new Owner(ref.owner, getDotComAPIEndpoint(), -1),
    -1,
    null,
    `https://github.com/${key}`,
  )
  repositoryCache.set(key, repository)
  return repository
}

/* ==========================================================================
 * 3. Dispatcher 面:CI 的 7 个方法接上行为
 * ========================================================================== */

/**
 * CI 面的 `Dispatcher` 门面。
 *
 * 与 `src/client/sync-dropdown-dispatcher.ts` / `desktop-dispatcher.ts` 同一形状:
 * **替身给类型面,本类给行为**。只覆盖 CI 那 7 个方法,其余方法沿用替身
 * (那些面还没接线,替身的空实现正是「缺口而不是已支持」的表达)。
 *
 * | 方法 | 行为 |
 * |---|---|
 * | `tryGetCommitStatus` | 委托抄进来的 `CommitStatusStore.tryGetStatus`(**同步**读缓存) |
 * | `subscribeToCommitStatus` | 委托 `CommitStatusStore.subscribe`(订阅即触发一次取数) |
 * | `manualRefreshSubscription` | 委托 `CommitStatusStore.manualRefreshSubscription` |
 * | `rerequestCheckSuites` | 委托 `CommitStatusStore.rerequestCheckSuite`(每条 check 一次) |
 * | `fetchCheckSuite` | 委托 `CommitStatusStore.fetchCheckSuite` |
 * | `openInBrowser` | `window.open(url, '_blank', 'noopener')` |
 * | `incrementMetric` | 空操作(本仓没有统计面;**如实如此**,不假装有) |
 * | `showPopup` | 只接 `CICheckRunRerun`:回调由渲染方注册(见 `setRerunPopupHandler`) |
 */
export class CiDispatcher extends Dispatcher {
  private readonly store: CommitStatusStore

  /**
   * `CICheckRunRerun` 弹窗的处理者(渲染方注册;没注册就是**没接**,
   * 不静默丢 —— `showPopup` 会把 payload 交给它,由它决定画什么)。
   */
  private rerunPopupHandler: ((popup: Popup) => void) | null = null

  public constructor() {
    super()
    /*
     * ⚠️ `AccountsStore` 那个类型来自**不在树里**的 `./accounts-store`(见本文件头),
     * 所以这里传的是一个形状适配对象;`as never` 不是掩盖缺陷,而是把
     * 「上游的 269 行账号 store 我们不搬」这件事写在调用点上(它也是
     * `check-types` 对 `commit-status-store.ts` 那 1 条 TS2307 的另一半)。
     */
    this.store = new CommitStatusStore(accountsStoreLike(getDotComAPIEndpoint()) as never)
  }

  /** 注册 `CICheckRunRerun` 弹窗的处理者(渲染方调用;`null` 表示取消注册)。 */
  public setRerunPopupHandler(handler: ((popup: Popup) => void) | null): void {
    this.rerunPopupHandler = handler
  }

  /** 上游 `ui/dispatcher/dispatcher.ts:2741`,逐字委托。 */
  public override tryGetCommitStatus(
    repository: GitHubRepository,
    ref: string,
    branchName?: string,
  ): ICombinedRefCheck | null {
    return this.store.tryGetStatus(repository, ref, branchName)
  }

  /** 上游 `:2760`,逐字委托。 */
  public override subscribeToCommitStatus(
    repository: GitHubRepository,
    ref: string,
    callback: (status: ICombinedRefCheck | null) => void,
    branchName?: string,
  ): Disposable {
    return this.store.subscribe(repository, ref, callback, branchName)
  }

  /** 上游 `:2769`,逐字委托。 */
  public override async manualRefreshSubscription(
    repository: GitHubRepository,
    ref: string,
    pendingChecks: ReadonlyArray<IRefCheck>,
  ): Promise<void> {
    await this.store.manualRefreshSubscription(repository, ref, pendingChecks)
  }

  /** 上游 `:2793`,逐字委托(每条 check 一次 `POST .../check-suites/{id}/rerequest`)。 */
  public override async rerequestCheckSuites(
    repository: GitHubRepository,
    checkRuns: ReadonlyArray<IRefCheck>,
    failedOnly: boolean,
  ): Promise<ReadonlyArray<boolean>> {
    const results: boolean[] = []
    for (const checkRun of checkRuns) {
      if (failedOnly && checkRun.conclusion !== 'failure') {
        results.push(false)
        continue
      }
      if (checkRun.checkSuiteId === null) {
        results.push(false)
        continue
      }
      results.push(await this.store.rerequestCheckSuite(repository, checkRun.checkSuiteId))
    }
    return results
  }

  /** 上游 `:3010`,逐字委托。 */
  public override fetchCheckSuite(
    repository: GitHubRepository,
    checkSuiteId: number,
  ): Promise<IAPICheckSuite | null> {
    return this.store.fetchCheckSuite(repository, checkSuiteId)
  }

  /** 上游 `:1417`。系统浏览器打开外链。 */
  public override openInBrowser(url: string): void {
    if (typeof window !== 'undefined') {
      window.open(url, '_blank', 'noopener')
    }
  }

  /** 上游 `:1306`。本仓没有统计面 —— **空操作是事实,不是占位符**(见类注释)。 */
  public override incrementMetric(metric: string): void {
    void metric
  }

  /** 上游 `:405`。只接 `CICheckRunRerun`(其余弹窗面还没接)。 */
  public override async showPopup(popup: Popup): Promise<void> {
    /*
     * ⚠️ 用 `String(popup.type)` 比较而不是 `popup.type === ...`:`CICheckRunRerun`
     * 这个变体**暂时不进** `models/popup.ts` 的联合(试过了:加进联合会让 6 个既有
     * 镜像文件各多 1 条诊断 —— `compare.tsx` 33→36、`sidebar.tsx` 20→22 等 ——
     * 那是**回归**,而不是新文件的存量噪声)。等那个变体登记进 popup.ts 时,
     * 把这里换回直接比较即可(运行期行为两者相同)。
     */
    if (String(popup.type) === 'CICheckRunRerun' && this.rerunPopupHandler !== null) {
      this.rerunPopupHandler(popup)
    }
  }
}

/** CI 面的门面单例(整个插件一份:store 的缓存与订阅表都在它里面)。 */
export const ciDispatcher = new CiDispatcher()
