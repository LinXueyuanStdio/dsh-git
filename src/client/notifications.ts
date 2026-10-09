/**
 * **高信号通知的数据面** —— 上游 `lib/stores/notifications-store.ts`(571 行)在我们这半的替身。
 *
 * ## 上游是什么,这里为什么不能照抄运行期
 *
 * 上游的事件**不是我们拉的**,是 GitHub 推的:
 *
 * ```
 * alive.github.com ──WebSocket──▶ AliveStore(@github/alive-client, 268 行)
 *                                    │  onAliveEventReceived
 *                                    ▼
 *                    NotificationsStore.handleAliveEvent(e, skip)
 *                       ├─ 'pr-checks-failed' → handleChecksFailedEvent
 *                       ├─ 'pr-review-submit' → handlePullRequestReviewSubmitEvent
 *                       └─ 'pr-comment'       → handlePullRequestCommentEvent
 * ```
 *
 * `@github/alive-client` **没有安装**(任务书明说:需要就报告,不许装),而且宿主半
 * **没有长连接**(前一条车道的读数:`docs/host-mirror-adaptation.md` §4.2 把
 * `alive-store.ts` 记成「浏览器宿主没有长连接」)。所以「事件从哪来」这一层必须换。
 *
 * ## 换成了什么:**轮询**,以及它的代价(必须知道)
 *
 * 用**已有的**那一条传输面(`src/client/gh-api.ts` → 宿主 `dsh-git/gh` 代理 → `api.github.com`,
 * 令牌只在宿主)。**没有**第二个传输层、**没有**新的 npm 依赖。
 *
 * 一次轮询的请求数是**可以算出来的**:
 *
 * ```
 * 1 次 Search        listPulls(ref, 'open')       ← Search API(独立限额:30 次/分钟)
 * 每个 PR 5 次 Core   getPull / listComments / listReviews / listCheckRuns / listCommitStatuses
 * ```
 *
 * ⚠️ **`getPull` 那一趟不是多余的**:`listPulls` 走 Search API,而 Search 的载荷里
 * **没有 PR 的 head sha**(`gh-api.ts:363` 的 `searchIssueToPull` 只能写
 * `head: { ref:'', label:'', sha:'' }`)⇒ 不取 PR 详情就**发不出** check-runs 请求
 * (`/commits//check-runs`)。这是本替代物真实成本的一部分,不是可省的优化。
 *
 * 取 {@link MAX_PULLS} = 3 ⇒ **每轮 16 次请求**;默认间隔 {@link DEFAULT_INTERVAL_MS} = 60s
 * ⇒ **16 次/分钟 ≈ 960 次/小时**,占已认证 Core 限额(5,000/小时)的 **≈19%**,
 * 另加 Search 的 1 次/分钟(30/分钟限额的 ≈3%)。
 * ⚠️ 上游那条路是 **0 次请求**(服务端推送)⇒ 这是**替代物的真实代价**,不是等价物。
 * 窗口不可见时{@link NotificationsStream} **不停**(通知的意义就在于你不在看的时候),
 * 但页签/仓库切换会 `setTarget` 并重新建立基线。
 *
 * ## 逐字镜像的那几件真的**接上了**(不是「抄了没接」)
 *
 * | 上游文件 | 在本模块里的职责 | 复现程度 |
 * |---|---|---|
 * | `lib/valid-notification-pull-request-review.ts:17`(`isValidNotificationPullRequestReview`) | 「这条 review 值得通知吗」的闸门(只认 APPROVED / CHANGES_REQUESTED / COMMENTED) | **运行期逐字**(函数体是上游那一份) |
 * | `ui/notifications/pull-request-review-helpers.ts:7`(`getVerbForPullRequestReview`) | review 通知标题里的动词(`approved` / `requested changes on` / `reviewed`) | **运行期逐字** |
 * | `lib/truncate-with-ellipsis.ts:2`(`truncateWithEllipsis`) | 正文里评论/review 摘要的截断 | **运行期逐字** |
 * | `models/commit.ts:6`(`shortenSHA`) | checks failed 正文里的 7 位 sha | **运行期逐字**(上游 `notifications-store.ts:335` 同一处用法) |
 *
 * ## 与上游的**语义差**(逐条写清,别读成「一样」)
 *
 * 1. **只看当前仓库**。上游也只看当前仓库(`this.repository` + `isValidRepositoryForEvent`),
 *    所以这一条**一致**;但上游的「recent repositories」只用于统计,我们**没有**统计面。
 * 2. **`pr-checks-failed` 的判据收窄**:上游还要求
 *    「失败 check 的 commit 作者邮箱 ∈ 当前账号邮箱」(过滤掉别人推的提交)。
 *    我们这半拿不到账号邮箱清单(宿主只回 `signedIn`/`login`),所以只判
 *    「PR 的 head sha 上有失败的 check run」⇒ **会比上游多报**别人推的失败。
 *    这是**已知的多报方向**,写成 `reason` 字段让界面能说出来。
 * 3. **首次轮询只建基线,一条都不发**(`baselined` 标记)。否则「打开页面」等于
 *    「历史上所有评论一次性轰炸」。上游靠服务端只推新事件天然没有这个问题。
 * 4. **没有 `dismiss` / 去重的跨会话记忆**:`seen*` 集合在内存里,刷新页面即重建基线。
 * 5. **`pr-comment` 只看 issue comments**(`/issues/{n}/comments`),不看
 *    review 的行内评论(`/pulls/{n}/comments`)。上游按事件 subtype 分开取,
 *    我们只取得到前者(少一次请求/PR)。
 *
 * ## 退役条件
 *
 * 宿主提供长连接(WebSocket / SSE)时:把 {@link pollOnce} 换成订阅,`AliveStore`
 * 那一份镜像就能真接线;`NotificationsStream` 只保留「快照 + 投递」两件事。
 *
 * @see src/client/notify.ts —— 投递面(偏好 / 权限 / Web Notification)的唯一出口
 * @see src/client/notifications-view.tsx —— 唯一的渲染方
 * @module dsh-git/client/notifications
 */

import {
  getPull,
  listCheckRuns,
  listComments,
  listCommitStatuses,
  listPulls,
  listReviews,
  type GhCheckRun,
  type GhComment,
  type GhPull,
  type GhReview,
} from './gh-api.ts';
import type { GhRef } from '../core/lib.ts';
import { deliverNotification, getNotificationsEnabled } from './notify.ts';
import { truncateWithEllipsis } from '../core/desktop/lib/truncate-with-ellipsis.ts';
import { isValidNotificationPullRequestReview } from '../core/desktop/lib/valid-notification-pull-request-review.ts';
import { getVerbForPullRequestReview } from '../core/desktop/ui/notifications/pull-request-review-helpers.ts';
import { shortenSHA } from '../core/desktop/models/commit.ts';

/** 上游 `notifications-store.ts:87/110/219` 的三类事件的本地名字。 */
export type HighSignalKind = 'pr-comment' | 'pr-review-submit' | 'pr-checks-failed';

/**
 * 一条高信号通知(界面与投递共用同一个对象)。
 *
 * `title` / `body` **由本模块按上游的三条模板拼好**,界面与浏览器通知显示的是
 * **同一个字符串** —— 两条路径各拼一次就是两份真源。
 */
export interface IHighSignalNotification {
  /** 去重键(轮询幂等靠它)。 */
  readonly id: string;
  readonly kind: HighSignalKind;
  readonly owner: string;
  readonly repo: string;
  readonly pullRequestNumber: number;
  readonly pullRequestTitle: string;
  /** 触发者登录名(`@` 后面那一段)。 */
  readonly actor: string;
  /** 上游标题模板的产物(如 `@alice approved your pull request`)。 */
  readonly title: string;
  /** 上游正文模板的产物(PR 标题 + `#号` + 摘要)。 */
  readonly body: string;
  readonly htmlUrl: string;
  readonly createdAt: string;
  /**
   * 与上游的**语义差**说明(见文件头第 2 条);空串 = 与上游同口径。
   * 界面必须显示它 —— 「多报了」这件事不许静默。
   */
  readonly caveat: string;
}

/** 界面读的那一份投影。 */
export interface INotificationsSnapshot {
  /** 最新的在前。 */
  readonly notifications: readonly IHighSignalNotification[];
  /** 未读条数(顶栏角标用)。 */
  readonly unread: number;
  /** 正在轮询吗。 */
  readonly polling: boolean;
  /** 当前轮询间隔(ms)。 */
  readonly intervalMs: number;
  /** 上一次轮询的时刻(`null` = 还没成功过一轮)。 */
  readonly lastPollAt: number | null;
  /** 上一次轮询的**请求数**(读数,界面显示成本)。 */
  readonly lastRequestCount: number;
  /** 上一次失败的原因(`null` = 最近一轮没失败)。 */
  readonly lastError: string | null;
  /** 已经建过基线了吗(没建过 ⇒ 下一轮只记录、不发)。 */
  readonly baselined: boolean;
  /** 当前目标的 `owner/repo`(`null` = 没有 GitHub 远端)。 */
  readonly target: string | null;
  /**
   * 现在**谁**在生产通知。
   *
   * - `'polling'` = 我们按秒拉 GitHub REST(见文件头;`1 + 5×PR` 次/轮);
   * - `'alive'` = 宿主的长连接(上游 `AliveStore` + 真 `@github/alive-client`)在推;
   *   此时轮询**已停**(两者同时跑会双报同一条评论 —— 见 `docs/alive-connection-port.md`);
   * - `'none'` = 没有 GitHub 远端,谁都没在跑。
   */
  readonly transport: 'alive' | 'polling' | 'none';
}

/** 轮询间隔(ms)。60s 是「13 次/分钟」这个成本数字的来源(见文件头)。 */
export const DEFAULT_INTERVAL_MS = 60_000;

/** 一轮最多看几个 PR(成本是 `1 + 5 × MAX_PULLS`)。 */
export const MAX_PULLS = 3;

/** 上游 `notifications-store.ts:335` 的 `pluralChecks` 选择。 */
function pluralChecks(n: number): string {
  return n === 1 ? 'check was' : 'checks were';
}

/**
 * 上游 `notifications-store.ts:202-208` 的标题/正文模板(逐字)。
 *
 * @param kind - 事件类型。
 * @param pr - PR(标题与编号进正文)。
 * @param actor - 触发者登录名。
 * @param verb - review 的动词(只有 `pr-review-submit` 用)。
 * @param summary - 评论/review 的正文摘要(**已截断**)。
 * @param sha - 提交 sha(只有 `pr-checks-failed` 用)。
 * @param failed - 失败的 check 条数。
 */
export function composeTitle(kind: HighSignalKind, actor: string, verb: string): string {
  switch (kind) {
    case 'pr-comment':
      return `@${actor} commented on your pull request`;
    case 'pr-review-submit':
      return `@${actor} ${verb} your pull request`;
    case 'pr-checks-failed':
      return 'Pull Request checks failed';
    default:
      return 'GitHub 通知';
  }
}

/** 上游正文的行 1(`PR 标题 #编号`),三条模板共用。 */
function prLine(pr: GhPull): string {
  return `${pr.title} #${pr.number}`;
}

/* ------------------------------------------------------------------------- *
 * 纯判据层:把 3 种 GitHub 载荷变成「值得通知的候选」
 * ------------------------------------------------------------------------- */

/**
 * 一处**拉到的**原始状态(一轮轮询的全部输入)。
 *
 * 拆成这个形状是为了让「派生」这一步**不碰网络** —— 探针可以逐条喂它
 * (含阴性对照),而不需要重新发明一遍 HTTP。
 */
export interface IRepoPoll {
  readonly ref: GhRef;
  readonly pulls: readonly GhPull[];
  /** `PR 编号 → 评论列表`。 */
  readonly comments: ReadonlyMap<number, readonly GhComment[]>;
  /** `PR 编号 → review 列表`。 */
  readonly reviews: ReadonlyMap<number, readonly GhReview[]>;
  /** `PR 编号 → 该 PR head 上失败的 check 名`。 */
  readonly failedChecks: ReadonlyMap<number, readonly string[]>;
}

/**
 * 派生候选:每个元素都是「若没见过,就该通知」的一条。
 *
 * 三种事件的**闸门**:
 *  - `pr-comment`:上游没有额外的有效性闸门(任何 issue comment 都算),这里沿用;
 *  - `pr-review-submit`:过**逐字镜像的** `isValidNotificationPullRequestReview`
 *    (上游 `notifications-store.ts:243` 同一处);
 *  - `pr-checks-failed`:该 PR 的 head sha 上**至少一条** check 不是 success
 *    (上游 `notifications-store.ts:311-325`,差别见文件头第 2 条)。
 *
 * @param poll - 一轮拉到的原始状态。
 * @returns 候选(顺序稳定:`comments` → `reviews` → `checks`,按 PR 编号升序)。
 */
export function deriveCandidates(poll: IRepoPoll): IHighSignalNotification[] {
  const { ref, pulls } = poll;
  const out: IHighSignalNotification[] = [];

  for (const pr of [...pulls].sort((a, b) => a.number - b.number)) {
    for (const comment of poll.comments.get(pr.number) ?? []) {
      const actor = comment.user?.login ?? 'ghost';
      out.push({
        id: `c:${ref.owner}/${ref.repo}#${pr.number}:${comment.id}`,
        kind: 'pr-comment',
        owner: ref.owner,
        repo: ref.repo,
        pullRequestNumber: pr.number,
        pullRequestTitle: pr.title,
        actor,
        title: composeTitle('pr-comment', actor, ''),
        body: `${prLine(pr)}\n${truncateWithEllipsis(comment.body ?? '', 50)}`,
        htmlUrl: comment.html_url,
        createdAt: comment.created_at,
        caveat: '',
      });
    }

    for (const review of poll.reviews.get(pr.number) ?? []) {
      /*
       * ⚠️ 这一行就是「逐字镜像的那一份真的承重」:闸门函数来自
       * `src/core/desktop/lib/valid-notification-pull-request-review.ts`(上游 25 行)。
       * 上游 `notifications-store.ts:243` 写的是
       * `if (review === null || !isValidNotificationPullRequestReview(review)) return`。
       */
      if (!isValidNotificationPullRequestReview(review)) {
        continue;
      }
      const actor = review.user?.login ?? 'ghost';
      const verb = getVerbForPullRequestReview(review) ?? 'reviewed';
      out.push({
        id: `r:${ref.owner}/${ref.repo}#${pr.number}:${review.id}`,
        kind: 'pr-review-submit',
        owner: ref.owner,
        repo: ref.repo,
        pullRequestNumber: pr.number,
        pullRequestTitle: pr.title,
        actor,
        title: composeTitle('pr-review-submit', actor, verb),
        body: `${prLine(pr)}\n${truncateWithEllipsis(review.body ?? '', 50)}`,
        htmlUrl: review.html_url,
        createdAt: review.submitted_at ?? pr.updated_at,
        caveat: '',
      });
    }

    const failed = poll.failedChecks.get(pr.number) ?? [];
    if (failed.length > 0) {
      const sha = pr.head.sha;
      out.push({
        id: `k:${ref.owner}/${ref.repo}#${pr.number}:${sha}:${[...failed].sort().join('|')}`,
        kind: 'pr-checks-failed',
        owner: ref.owner,
        repo: ref.repo,
        pullRequestNumber: pr.number,
        pullRequestTitle: pr.title,
        actor: pr.user?.login ?? 'ghost',
        title: composeTitle('pr-checks-failed', '', ''),
        body: `${prLine(pr)} (${shortenSHA(sha)})\n${failed.length} ${pluralChecks(failed.length)} not successful.`,
        htmlUrl: pr.html_url,
        createdAt: new Date().toISOString(),
        caveat: '未按「失败提交的作者必须是当前账号」过滤(宿主没给邮箱清单)⇒ 可能多报别人推的失败',
      });
    }
  }

  return out;
}

/**
 * 「成功」才算通过的 check 结论。
 *
 * 上游 `notifications-store.ts:316-319` 数的是 `conclusion === 'failure'`;
 * 这里放宽到「**不是** success / neutral / skipped」—— 理由:`listCommitStatuses`
 * 那一路的老式 status 用的是 `state`(`failure`/`error`/`pending`),上游另外用
 * `apiStatusToRefCheck` 折成同一个 `IRefCheck`。我们不做那层折算,所以直接按
 * 「结论不表示通过」判,**多报** pending 一类;这一点写进 {@link analyzeChecks} 的注释。
 */
function isFailing(conclusion: string | null | undefined): boolean {
  if (conclusion === null || conclusion === undefined || conclusion === '') {
    return false;
  }
  return conclusion !== 'success' && conclusion !== 'neutral' && conclusion !== 'skipped';
}

/**
 * 从一个 PR head 上的 check runs + 老式 statuses 里挑出**失败**的名字。
 *
 * ⚠️ 与上游的两处差别(都写在这里,不藏着):
 *  1. 上游要求 `conclusion === APICheckConclusion.Failure`;这里 {@link isFailing}
 *     按「不表示通过」判 ⇒ 包含 `cancelled` / `timed_out` / `action_required`;
 *  2. 老式 status 的 `state` 与 check run 的 `conclusion` 是两套词表,这里用同一个
 *     判断函数 ⇒ `pending` 会被算成「没通过」。**pending 会被多报**。
 *
 * @param runs - `/commits/{ref}/check-runs` 的载荷。
 * @param statuses - `/commits/{ref}/status` 的载荷(可为空)。
 * @returns 失败项的名字(去重、升序,保证 id 稳定)。
 */
export function analyzeChecks(
  runs: readonly GhCheckRun[],
  statuses: readonly { context: string; state: string }[],
): string[] {
  const names = new Set<string>();
  for (const run of runs) {
    if (isFailing(run.conclusion)) {
      names.add(run.name ?? `check#${run.id}`);
    }
  }
  for (const status of statuses) {
    if (isFailing(status.state)) {
      names.add(status.context);
    }
  }
  return [...names].sort();
}

/* ------------------------------------------------------------------------- *
 * 拉取层(唯一碰网络的一处)
 * ------------------------------------------------------------------------- */

/**
 * 真拉一轮(每轮 {@link MAX_PULLS} 个 PR)。
 *
 * 请求数 = `1 + 5 × min(open PRs, MAX_PULLS)`(`getPull` 那一趟是为 head sha,见文件头)。**任何一个 PR 的子请求失败**
 * 只丢那一个 PR 的那一类数据(其余照旧)—— 一次 403 不该让整轮空掉。
 *
 * @param ref - 仓库。
 * @returns 派生用的原始状态。
 */
export async function pollRepo(ref: GhRef): Promise<IRepoPoll> {
  const page = await listPulls(ref, 'open');
  const pulls = page.items.slice(0, MAX_PULLS);
  const comments = new Map<number, readonly GhComment[]>();
  const reviews = new Map<number, readonly GhReview[]>();
  const failedChecks = new Map<number, readonly string[]>();
  const pullsWithSha: GhPull[] = [];

  for (const pr of pulls) {
    /*
     * 先取 PR 详情 —— Search 载荷里没有 head sha(见文件头的成本说明)。
     * 拿不到 sha 就**不发** check-runs / statuses 请求(否则是 `/commits//check-runs`
     * 这种必然 404 的请求,白花配额还污染 lastError)。
     */
    const detail = await getPull(ref, pr.number).catch(() => null);
    const withSha = detail !== null && detail.head.sha !== '' ? detail : pr;
    const [prComments, prReviews, runs, statuses] = await Promise.all([
      listComments(ref, pr.number).catch(() => null),
      listReviews(ref, pr.number).catch(() => null),
      withSha.head.sha === ''
        ? Promise.resolve(null)
        : listCheckRuns(ref, withSha.head.sha).catch(() => null),
      withSha.head.sha === ''
        ? Promise.resolve(null)
        : listCommitStatuses(ref, withSha.head.sha).catch(() => null),
    ]);
    pullsWithSha.push(withSha);
    if (prComments !== null) {
      comments.set(pr.number, prComments.items);
    }
    if (prReviews !== null) {
      reviews.set(pr.number, prReviews);
    }
    failedChecks.set(pr.number, analyzeChecks(runs ?? [], statuses ?? []));
  }

  /*
   * `pulls` 回的是**带 sha 的**那一版(`withSha` 已经逐条并进去),这样
   * `deriveCandidates` 里的 `pr.head.sha` 才不是空串。
   */
  return { ref, pulls: pullsWithSha, comments, reviews, failedChecks };
}

/* ------------------------------------------------------------------------- *
 * 流:唯一的状态所有者
 * ------------------------------------------------------------------------- */

const EMPTY: INotificationsSnapshot = {
  notifications: [],
  unread: 0,
  polling: false,
  intervalMs: DEFAULT_INTERVAL_MS,
  lastPollAt: null,
  lastRequestCount: 0,
  lastError: null,
  baselined: false,
  target: null,
  transport: 'none',
};

/**
 * 轮询流。**模块级单例**由 {@link notificationsStream} 持有 ——
 * `workbench.tsx`(启动方)与 `notifications-view.tsx`(渲染方)读的是**同一份**状态。
 *
 * 快照引用稳定(`snapshot()` 返回缓存对象,只在 `emit` 时替换)⇒ React 侧
 * `useSyncExternalStore`/`useState(订阅)` 都不会空转。
 */
/**
 * 投递一批通知。**轮询与长连接共用这一份**(顺序照上游:先查偏好,再查权限)。
 *
 * `deliverNotification` 的第一句就是查偏好,这里再查一次是上游
 * `notifications-store.ts:92` 的 `setEnabled(getNotificationsEnabled())` 那一层
 * (偏好关掉 ⇒ 一条都不构造;`ignoreVisibility = true` 与上游一致:上游
 * `show-notification.ts:18-41` **没有**「你在不在看窗口」这条判据)。
 *
 * @param notifications - 已经进列表的那些(按展示顺序)。
 */
function deliverAll(notifications: readonly IHighSignalNotification[]): void {
  if (!getNotificationsEnabled()) {
    return;
  }
  for (const n of notifications) {
    deliverNotification({ title: n.title, body: n.body, tag: n.id }, true);
  }
}

/**
 * 轮询流。**模块级单例**由 {@link notificationsStream} 持有 ——
 * `workbench.tsx`(启动方)与 `notifications-view.tsx`(渲染方)读的是**同一份**状态。
 *
 * 快照引用稳定(`snapshot()` 返回缓存对象,只在 `emit` 时替换)⇒ React 侧
 * `useSyncExternalStore`/`useState(订阅)` 都不会空转。
 */
export class NotificationsStream {
  private state: INotificationsSnapshot = EMPTY;
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private target: GhRef | null = null;
  /** 见过的候选 id(`baselined` 之前只写不发)。 */
  private readonly seen = new Set<string>();
  private baselined = false;
  private inFlight = false;
  /**
   * 长连接是不是**当前的生产者**。
   *
   * 这是「两条不许同时跑」的**唯一开关**:{@link start} 在它打开时**不建定时器**
   * (`start()` 的其他语义逐字不变)。设置它的是 `src/client/alive.ts` 的
   * `applyAliveMode()`,依据是宿主 `alive/status` 的读数。
   */
  private alive = false;

  /** 订阅变更。@param listener - 变更回调。@returns 退订函数。 */
  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 当前快照(引用稳定)。@returns 快照。 */
  public snapshot(): INotificationsSnapshot {
    return this.state;
  }

  /** 现在轮询的是哪个仓库。@returns `owner/repo` 或 `null`。 */
  public currentTarget(): string | null {
    return this.target === null ? null : `${this.target.owner}/${this.target.repo}`;
  }

  /**
   * 换目标仓库。**仓库一变就重建基线**(`seen` 清空、`baselined = false`):
   * 否则 A 仓的评论 id 会压住 B 仓的同 id 候选。列表**不清** —— 用户切仓库时
   * 历史通知应当还在(上游的通知是 OS 级的,本来就会跨仓库累积)。
   *
   * @param ref - 新的目标(`null` = 没有 GitHub 远端,停止轮询)。
   */
  public setTarget(ref: GhRef | null): void {
    const next = ref === null ? null : `${ref.owner}/${ref.repo}`;
    if (this.currentTarget() === next) {
      return;
    }
    this.target = ref;
    this.seen.clear();
    this.baselined = false;
    this.patch({ target: next, baselined: false });
  }

  /**
   * 开始轮询(幂等)。第一轮**立刻**跑一次。
   *
   * ⚠️ **长连接在场时不建定时器**(2026-10-08):两条生产者同时跑会把同一条评论
   * 报两次(`pr-comment` 的 id 前缀分别是 `c:` 与 `a:`,`seen` **挡不住**交叉重复)
   * ⇒ 这里直接返回。这是「两条不许同时跑」的**唯一执行点**。
   *
   * @param intervalMs - 间隔(ms),默认 {@link DEFAULT_INTERVAL_MS}。
   */
  public start(intervalMs: number = DEFAULT_INTERVAL_MS): void {
    if (this.alive) {
      // 长连接在推:轮询**一个请求都不发**(见文件头与 `docs/alive-connection-port.md`)。
      this.patch({ polling: false, intervalMs, transport: 'alive' });
      return;
    }
    if (this.timer !== null) {
      return;
    }
    this.patch({ polling: true, intervalMs, transport: 'polling' });
    void this.pollNow();
    this.timer = setInterval(() => {
      void this.pollNow();
    }, intervalMs);
  }

  /** 停止轮询(幂等)。已收到的通知**不**清。 */
  public stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.state.polling) {
      this.patch({ polling: false });
    }
  }

  /**
   * **切换生产者**(2026-10-08)。
   *
   * `true` ⇒ 停掉轮询、把 transport 记成 `'alive'`;`false` ⇒ 回到轮询
   * (调用方随后会 `start()`,因为 `stop()` 之后定时器是空)。
   *
   * 刻意**不**在同一个方法里改 `seen`:两类 id 前缀不同(`c:`/`r:`/`k:` 与 `a:`),
   * 清与不清都不影响去重,而清掉会让「长连接掉线回落到轮询」时把**已经报过的**
   * 评论再报一遍(上游同样不重报)。
   *
   * @param on - 长连接是不是当前的生产者。
   */
  public setAlive(on: boolean): void {
    if (this.alive === on) {
      return;
    }
    this.alive = on;
    if (on) {
      this.stop();
      this.patch({ transport: this.target === null ? 'none' : 'alive' });
    } else {
      this.patch({ transport: this.target === null ? 'none' : 'polling' });
    }
  }

  /** 长连接是不是当前的生产者。@returns `true` = {@link start} 不会建定时器。 */
  public isAliveMode(): boolean {
    return this.alive;
  }

  /** 正在轮询吗。@returns `true` = 定时器在跑。 */
  public isPolling(): boolean {
    return this.timer !== null;
  }

  /** 全部标为已读(用户打开页签时调)。 */
  public markAllRead(): void {
    if (this.state.unread === 0) {
      return;
    }
    this.patch({ unread: 0 });
  }

  /** 清空列表并重建基线。 */
  public clear(): void {
    this.seen.clear();
    this.baselined = false;
    this.patch({ notifications: [], unread: 0, baselined: false });
  }

  /**
   * **立刻**拉一轮(生产:定时器;探针:直接调)。
   *
   * @returns 本轮新产生的通知(空数组 = 没有新的;**首轮必然是空**,见文件头第 3 条)。
   */
  public async pollNow(): Promise<readonly IHighSignalNotification[]> {
    const ref = this.target;
    if (ref === null || this.inFlight) {
      return [];
    }
    this.inFlight = true;
    try {
      const poll = await pollRepo(ref);
      return this.ingest(poll, 1 + 5 * poll.pulls.length);
    } catch (error) {
      this.patch({
        lastError: error instanceof Error ? error.message : String(error),
        lastPollAt: Date.now(),
      });
      return [];
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * 把一轮结果**喂进来**(与拉取分开:探针可以逐帧喂载荷,不必发明 HTTP)。
   *
   * @param poll - 原始状态。
   * @param requestCount - 这一轮花了几次请求(读数;探针会与桩的请求日志对数)。
   * @returns 新产生的通知。
   */
  public ingest(poll: IRepoPoll, requestCount: number): readonly IHighSignalNotification[] {
    const candidates = deriveCandidates(poll);
    const fresh = candidates.filter((c) => !this.seen.has(c.id));
    for (const c of candidates) {
      this.seen.add(c.id);
    }

    const isBaseline = !this.baselined;
    this.baselined = true;

    /*
     * 首轮只建基线:一条都不发、也不进列表。`baselined` 是**快照字段**,
     * 所以界面能说出「基线已建立 / 这是第一批」,而不是让用户猜。
     */
    if (isBaseline || fresh.length === 0) {
      this.patch({ lastError: null, lastPollAt: Date.now(), lastRequestCount: requestCount, baselined: true });
      return [];
    }

    const ordered = [...fresh].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    this.patch({
      notifications: [...ordered, ...this.state.notifications],
      unread: this.state.unread + ordered.length,
      lastError: null,
      lastPollAt: Date.now(),
      lastRequestCount: requestCount,
      baselined: true,
    });

    deliverAll(ordered);
    return ordered;
  }

  /**
   * **长连接的一条事件** ⇒ 通知(2026-10-08)。
   *
   * 与 {@link ingest} 的差别只有一条,而它是**承重**的:
   * 这里**没有基线轮**。上游 `AliveStore` 的订阅只会推**连接之后**发生的事件
   * (`AliveSession` 的 `offset` 是订阅那一刻的 ack),所以「第一件事就是新事」——
   * 轮询需要「首轮只建基线」是因为它一次会看到**历史上所有**评论。
   *
   * 去重仍然走同一个 `seen`(`a:` 前缀与轮询的 `c:`/`r:`/`k:` 不撞;
   * 同一 `comment_id` 重复到达时第二次是 0 条)。
   *
   * @param notification - 由 {@link aliveEventToCandidate} 拼好的一条(已带上游模板文案)。
   * @returns 真的进了列表的那一条(`null` = 重复/无效)。
   */
  public ingestAliveNotification(notification: IHighSignalNotification): IHighSignalNotification | null {
    if (this.seen.has(notification.id)) {
      return null;
    }
    this.seen.add(notification.id);
    this.patch({
      notifications: [notification, ...this.state.notifications],
      unread: this.state.unread + 1,
      lastError: null,
      lastPollAt: Date.now(),
    });
    deliverAll([notification]);
    return notification;
  }

  /** 写快照并广播(引用替换 ⇒ 订阅方一定看得到变化)。 */
  private patch(next: Partial<INotificationsSnapshot>): void {
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) {
      listener();
    }
  }
}

/** 模块级单例:`workbench.tsx` 启动它,`notifications-view.tsx` 渲染它。 */
export const notificationsStream = new NotificationsStream();

/**
 * 给 React 的 observable 面(与 `prefs-bus.ts:114-120` 的 `fontScaleStore` 同形)。
 *
 * 为什么要有这一层而不是直接把 `notificationsStream.subscribe` 交给
 * `useSyncExternalStore`:类是原型方法,`instance.subscribe` 虽然**引用稳定**,
 * 但 React 会以 `subscribe(cb)` 调用它 ⇒ `this` 丢失。对象字面量的箭头属性
 * 每个属性都是**绑定到实例**的稳定函数,两个要求同时满足。
 */
export const notificationsStore = {
  getSnapshot: (): INotificationsSnapshot => notificationsStream.snapshot(),
  subscribe: (listener: () => void): (() => void) => notificationsStream.subscribe(listener),
};

