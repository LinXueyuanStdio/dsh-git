/**
 * **通知详情对话框要的上游模型** —— `Gh*`(我们 `gh-api.ts` 的 REST 形状)→
 * 上游 `models/**` / `lib/api.ts` 的**转换层**(2026-10-09)。
 *
 * ## 为什么需要这一层(以及为什么它必须是「我们的层」)
 *
 * 上游的通知链是:
 *
 * ```
 * alive 事件(只有 id)──▶ notifications-store.ts ──补一次取数──▶ 上游 API 对象
 *                                                     │
 *                                                     ▼
 *                      dispatcher.showPopup({ type: PopupType.PullRequestComment, … })
 *                                                     │
 *                                                     ▼
 *                              ui/app.tsx:2773  <PullRequestComment repository={…} pullRequest={…} comment={…} …/>
 * ```
 *
 * 也就是说上游那三个对话框拿的是**上游自己的模型**(`PullRequest` 类、
 * `IAPIComment`、`ValidNotificationPullRequestReview`、`IRefCheck`),
 * 而它们全都经由 `models/github-repository.ts` 里的 `RepositoryWithGitHubRepository`
 * 落在一个真实的 GitHub 仓库上。
 *
 * 我们这半的数据是 `src/client/gh-api.ts` 的 `Gh*` 形状(**同一份 REST 载荷**,
 * 只是我们自己的类型)。两者**不能**互相冒充,所以这里逐条转换 ——
 * **这是适配层该待的地方**(镜像根里那三个对话框一个字都不改)。
 *
 * ## 三条纪律(写下来因为它决定每一行的取舍)
 *
 * 1. **能复用上游的转换就不手写**。`IRefCheck` 不是我自己拼的:
 *    先 `GhCheckRun → IAPIRefCheckRun`(纯形状),再调**逐字镜像**的
 *    `lib/ci-checks/ci-checks.ts:169` 的 `apiCheckRunToRefCheck`。上游那一段算
 *    「描述文案 / 时长」的逻辑因此**逐字生效**,而不是我另写一份近似的。
 * 2. **判据收窄用镜像那一份**。`review.state` 只有三种值得通知 ——
 *    这个判断不是我写的,是 `lib/valid-notification-pull-request-review.ts:17` 的
 *    `isValidNotificationPullRequestReview`(逐字镜像,已被
 *    `src/client/notifications.ts` 在运行期调用)。这里**再调一次**它,
 *    让「那条 review 值不值得弹对话框」与「值不值得发通知」是**同一个函数**。
 * 3. **令牌绝不进浏览器半**。`Account` 的 `token` 恒 `''`
 *    (令牌只在宿主,见 `src/host/auth.ts`);对话框里任何需要真令牌的动作
 *    (checkout / 合并)都会走我们的宿主路由,而不是直接拿这个 `Account` 用。
 *    ⚠️ 这带来一条**已知退化**:`accounts` 里的账号没有令牌,所以对话框
 *    「切到那个仓库并 checkout PR 分支」那条链在本插件里**不完整** ——
 *    登记在文件末尾的诚实边界里。
 *
 * @module dsh-git/client/notification-dialog-models
 */

import { Account } from '../core/desktop/models/account.ts'
import { GitHubRepository } from '../core/desktop/models/github-repository.ts'
import { Owner } from '../core/desktop/models/owner.ts'
import { PullRequest, PullRequestRef } from '../core/desktop/models/pull-request.ts'
import { Repository } from '../core/desktop/models/repository.ts'
import type { RepositoryWithGitHubRepository } from '../core/desktop/models/repository.ts'
import {
  APICheckConclusion,
  APICheckStatus,
  type IAPIComment,
  type IAPIIdentity,
  type IAPIPullRequestReview,
  type IAPIRefCheckRun,
} from '../core/desktop/lib/api.ts'
import { apiCheckRunToRefCheck, type IRefCheck } from '../core/desktop/lib/ci-checks/ci-checks.ts'
import {
  isValidNotificationPullRequestReview,
  type ValidNotificationPullRequestReview,
} from '../core/desktop/lib/valid-notification-pull-request-review.ts'
import { getDotComAPIEndpoint } from '../core/desktop/lib/api.ts'
import type { Emoji } from '../core/desktop/lib/emoji.ts'
import type { GhCheckRun, GhComment, GhPull, GhReview, GhUser } from './gh-api.ts'

/** 本插件只认 dotcom(与 `gh-api.ts` 的远端解析同一口径)。 */
const ENDPOINT = getDotComAPIEndpoint()

/**
 * `GhUser` → `IAPIIdentity`。
 *
 * ⚠️ `GhUser` 的**类型**只声明了 `login`,但 GitHub 的真实载荷里
 * `id` / `avatar_url` / `html_url` / `type` 都在(见 `gh-api.ts` 里 `GhUser` 的
 * 可选字段与那段说明)。这里按**运行期真的有没有**取值:缺了就退回一个
 * 明确的中性值,而不是编一个假 URL。
 *
 * @param user - `gh-api.ts` 的用户对象(可能为 `null`)。
 * @returns 上游身份对象。
 */
export function toIdentity(user: GhUser | null): IAPIIdentity {
  return {
    id: user?.id ?? 0,
    login: user?.login ?? '',
    avatar_url: user?.avatar_url ?? '',
    html_url: user?.html_url ?? '',
    type: 'User',
  }
}

/**
 * `GhComment` → `IAPIComment`(`ui/notifications/pull-request-comment.tsx` 的 `comment` prop)。
 *
 * @param comment - `gh-api.ts` 的评论。
 * @returns 上游形状的评论。
 */
export function toIAPIComment(comment: GhComment): IAPIComment {
  return {
    id: comment.id,
    body: comment.body,
    html_url: comment.html_url,
    user: toIdentity(comment.user),
    created_at: comment.created_at,
  }
}

/**
 * `GhReview` → `IAPIPullRequestReview`(纯形状,不判闸门)。
 *
 * 闸门在**调用点**用逐字镜像的 `isValidNotificationPullRequestReview`
 * (`lib/valid-notification-pull-request-review.ts:17`);`notifications.ts` 与
 * `alive.ts` 两条生产路都走它,所以「哪三种状态值得通知」只有一处定义。
 *
 * @param review - `gh-api.ts` 的评审(`state` 是裸串,见那个类型的注释)。
 * @returns 上游形状的评审。
 */
export function toIAPIReview(review: GhReview): IAPIPullRequestReview {
  return {
    id: review.id,
    user: toIdentity(review.user),
    body: review.body ?? '',
    html_url: review.html_url,
    submitted_at: review.submitted_at ?? '',
    /*
     * `state` 在我们的 `GhReview` 里是裸串,而上游是五值联合 —— 这里**不**做判别,
     * 只做形状搬运:值原样带过去,由调用点的
     * `isValidNotificationPullRequestReview`(逐字镜像)判「是不是值得通知的那三个」。
     * 在**这一层**判会把「数据形状」和「业务闸门」混在一起,而且会让镜像那份闸门
     * 的两个调用点(轮询 / 长连接)各自看到不同的语义。
     */
    state: review.state as IAPIPullRequestReview['state'],
  }
}

/**
 * `GhReview` → 收窄后的上游评审,**不值得通知就回 `null`**。
 *
 * @param review - `gh-api.ts` 的评审。
 * @returns 收窄后的评审,或 `null`。
 */
export function toValidReview(review: GhReview): ValidNotificationPullRequestReview | null {
  const candidate = toIAPIReview(review)
  return isValidNotificationPullRequestReview(candidate) ? candidate : null
}

/** `GhCheckRun.status` 的裸串 → `APICheckStatus`。 */
function toCheckStatus(status: string): APICheckStatus {
  return status === 'queued' ? APICheckStatus.Queued
    : status === 'in_progress' ? APICheckStatus.InProgress
      : status === 'completed' ? APICheckStatus.Completed
        : APICheckStatus.Queued
}

/** `GhCheckRun.conclusion` 的裸串 → `APICheckConclusion | null`。 */
function toCheckConclusion(conclusion: string | null): APICheckConclusion | null {
  switch (conclusion) {
    case 'success': return APICheckConclusion.Success
    case 'failure': return APICheckConclusion.Failure
    case 'neutral': return APICheckConclusion.Neutral
    case 'cancelled': return APICheckConclusion.Canceled
    case 'timed_out': return APICheckConclusion.TimedOut
    case 'action_required': return APICheckConclusion.ActionRequired
    case 'skipped': return APICheckConclusion.Skipped
    case 'stale': return APICheckConclusion.Stale
    default: return null
  }
}

/**
 * `GhCheckRun` → `IAPIRefCheckRun`(**纯形状**)。
 *
 * 为什么要有这一跳而不是直接拼 `IRefCheck`:拼 `IRefCheck` 就得自己写
 * 「描述文案」(上游 `getCheckRunShortDescription(…, getCheckDurationInMilliseconds(…))`)。
 * 走一趟 `IAPIRefCheckRun` 之后那段逻辑由镜像的
 * `apiCheckRunToRefCheck`(`ci-checks.ts:169`)负责,我只负责形状。
 *
 * @param run - `gh-api.ts` 的 check run。
 * @returns 上游 `lib/api.ts:387-399` 的形状。
 */
export function toIAPIRefCheckRun(run: GhCheckRun): IAPIRefCheckRun {
  return {
    id: run.id,
    url: '',
    status: toCheckStatus(run.status),
    conclusion: toCheckConclusion(run.conclusion),
    name: run.name ?? '',
    check_suite: { id: run.check_suite?.id ?? 0 },
    app: { name: run.app?.name ?? '' },
    completed_at: run.completed_at ?? '',
    started_at: run.started_at ?? '',
    html_url: run.html_url,
    /*
     * ⚠️ **空数组,而且是故意的**:`IAPIRefCheckRun.pull_requests` 的元素类型是完整的
     * `IAPIPullRequest`(我们的替身 `lib/api.ts:588-599` 逐字照抄了它),而
     * `GhCheckRun.pull_requests` 只有 `{ id? }`。要凑出一个 `IAPIPullRequest`
     * 就得**编** `title` / `head` / `base` / `user` 等一堆字段 —— 那是拿假数据
     * 去满足类型,比留空难查得多。
     *
     * **留空是安全的,因为这条路径不读它**:我们调的是
     * `apiCheckRunToRefCheck`(`lib/ci-checks/ci-checks.ts:169`),它只读
     * `id` / `name` / `status` / `conclusion` / `app.name` / `check_suite.id` /
     * `html_url` / `started_at` / `completed_at`,**没有一处碰 `pull_requests`**。
     * 真正读它的 `getLatestCheckRunsById`(`:289`)是「按 id 在完整 check-runs
     * 响应里找回最新同名 run」用的,那条链不经过本模块。
     */
    pull_requests: [],
  }
}

/**
 * `GhCheckRun[]` → `IRefCheck[]`(经镜像的 `apiCheckRunToRefCheck`)。
 *
 * @param runs - 一次 check-runs 响应的 `check_runs`。
 * @returns 上游 CI 面用的检查列表。
 */
export function toRefChecks(runs: readonly GhCheckRun[]): readonly IRefCheck[] {
  return runs.map((run) => apiCheckRunToRefCheck(toIAPIRefCheckRun(run)))
}

/**
 * 造一个**上游形状**的 `RepositoryWithGitHubRepository`。
 *
 * `dbID` 用 `0`:`GitHubRepository` 的 `dbID` 是「**本应用本地数据库**里的 id」,
 * 与 GitHub 的 API id **没有关系**(该字段自己的 JSDoc 就是这么写的)。
 * 我们这半没有那个数据库,所以 `0` 是「没有本地行」的诚实取值 ——
 * **不是**丢了一个可用信息。
 *
 * @param repoPath - 工作区里的绝对路径(上游 `Repository.path`)。
 * @param owner - `owner/repo` 的那一半。
 * @param name - 仓库名。
 * @param htmlUrl - 远端 HTML 地址(`https://github.com/o/r`)。
 * @returns 上游仓库对象,或 `null`(参数不完整时)。
 */
export function toRepositoryWithGitHubRepository(
  repoPath: string,
  owner: string,
  name: string,
  htmlUrl: string | null,
): RepositoryWithGitHubRepository | null {
  if (repoPath === '' || owner === '' || name === '') {
    return null
  }
  const ownerModel = new Owner(owner, ENDPOINT, 0)
  const ghRepo = new GitHubRepository(name, ownerModel, 0, null, htmlUrl)
  const repository = new Repository(repoPath, 0, ghRepo, false)
  /*
   * `isRepositoryWithGitHubRepository` 判的是 `gitHubRepository instanceof GitHubRepository`
   * —— 上面刚构造的正是那一类,所以这个收窄**有据**,不是我硬转。
   */
  return repository.gitHubRepository === null ? null : (repository as RepositoryWithGitHubRepository)
}

/**
 * 造一个 `Account`。
 *
 * ⚠️ **`token` 恒空串**:令牌只在宿主(`src/host/auth.ts`),浏览器半拿不到、
 * 也不该拿到。用 `login` + endpoint 建一个「知道是谁、但没有凭据」的账号 ——
 * 对话框拿它主要做「这个仓库属于哪个账号」的展示与 endpoint 比对。
 *
 * @param login - 当前登录名(`''` = 未登录)。
 * @param avatarUrl - 头像地址(可选)。
 * @param id - 账号 id(可选;拿不到就 `-1`,与上游 `Account.anonymous()` 同一取值)。
 * @returns 上游账号对象。
 */
export function toAccount(login: string, avatarUrl = '', id = -1): Account {
  return new Account(login, ENDPOINT, '', [], avatarUrl, id, login, undefined)
}

/**
 * 上游 `app.tsx` 给这三个对话框传的 `emoji` prop。
 *
 * ⚠️ **恒空 Map,而且是故意的**:上游那份是启动时从 `gemoji` 数据集加载的
 * (响应里的 `:+1:` 之类的**短代码** → 图片路径),而本 checkout 的
 * `references/desktop/gemoji/` 是**空的**(已登记的事实)⇒ 我们没有那份数据可加载。
 * 空 Map 的**可见后果**:markdown 正文里的 emoji 短代码**不会被替换成图片**
 * (会以原文 `:+1:` 显示)。这是**已登记的退化**,不是静默失败 ——
 * 它不会让对话框崩,也不会渲染出坏图。
 */
export function emptyEmoji(): Map<string, Emoji> {
  /*
   * **每次都新建一个**。上游把 `this.state.emoji` 那一份**共享**给三个对话框
   * (`app.tsx:2591` 等),因为它是启动时加载一次的数据集;而我们是**空**的,
   * 新建一个的成本是一次 `new Map()` —— 拿它换掉「某个对话框哪天 `.set()`
   * 一下就把别人的表改了」这个隐患,是划算的。
   */
  return new Map<string, Emoji>()
}

/**
 * `GhPull` → 上游 `PullRequest` 模型。
 *
 * 逐字段对照(左=上游 `models/pull-request.ts:33-42`):
 *
 * | 上游 | 这里 |
 * |---|---|
 * | `created: Date` | `new Date(ghPull.created_at)` |
 * | `title` / `pullRequestNumber` / `draft` | 同名 |
 * | `head: PullRequestRef` | `ref`/`sha` 取自 `ghPull.head`;`gitHubRepository` 用同一份 `ghRepo` |
 * | `base: PullRequestRef` | `ref` 同名;`sha` 上游**不读**(`base.sha` 在我们类型里也没有)⇒ 空串 |
 * | `author` | `ghPull.user?.login ?? ''` |
 * | `body` | `ghPull.body ?? ''` |
 *
 * @param pull - Search/REST 回来的 PR。
 * @param repository - 上面造的那个上游仓库对象。
 * @returns 上游 PR 模型。
 */
export function toPullRequestModel(
  pull: GhPull,
  repository: RepositoryWithGitHubRepository,
): PullRequest {
  const ghRepo = repository.gitHubRepository
  return new PullRequest(
    new Date(pull.created_at),
    pull.title,
    pull.number,
    new PullRequestRef(pull.head.ref, pull.head.sha, ghRepo),
    new PullRequestRef(pull.base.ref, '', ghRepo),
    pull.user?.login ?? '',
    pull.draft,
    pull.body ?? '',
  )
}

/* ------------------------------------------------------------------------- *
 * 诚实边界(与上面三条纪律配套;读读数之前先读这一段)
 * ------------------------------------------------------------------------- */

/**
 * 1. **`base.sha` 是空串**:上游 `PullRequestRef` 要一个 sha,而 `GhPull.base`
 *    在我们的类型里没有它。上游三个对话框**都不读** `base.sha`
 *    (它们只读 `pullRequestNumber` / `head`),所以这是**未使用的缺口**,
 *    而不是伪装成有的值。
 * 2. **`Account.token` 恒空**:见 {@link toAccount}。因此对话框里「切仓库并
 *    checkout PR 分支」那条链在本插件里**不完整** —— 它需要真令牌。
 *    ⚠️ 这条**没有**被本轮隐藏:对话框那个按钮若被按到,会走我们的宿主路由
 *    (或明确失败),不会静默什么都不做。这一条仍是**未验证**的(本轮没有
 *    真跑过那条交互),登记在此。
 * 3. **`EMPTY_EMOJI` 让 emoji 短代码不替换成图片**:见它的注释。
 * 4. **`IAPIIdentity.type` 恒 `'User'`**:我们没取 `type`(GitHub 可能回
 *    `'Bot'`)。影响面:上游用 `type` 区分机器人与人的**极少数**展示分支。
 */
export const NOTIFICATION_DIALOG_MODEL_CAVEATS = [
  'base.sha 为空串(上游不读)',
  'Account.token 恒空(令牌只在宿主)',
  'emoji 短代码不替换成图片(gemoji 数据集在本 checkout 为空)',
  "IAPIIdentity.type 恒 'User'",
] as const
