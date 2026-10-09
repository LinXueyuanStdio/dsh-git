/**
 * **长连接的客户端一半** —— 从宿主的长连接里增量取事件,喂进通知流。
 *
 * ## 数据面的分工(与 `docs/alive-connection-port.md` 一致)
 *
 * ```
 * GitHub  ──WS──▶  宿主 `AliveStore`(逐字镜像)+ 真 `@github/alive-client`
 *                        │  环形缓冲(游标)
 *                        ▼
 *                 路由 `dsh-git/alive/{status,events}`
 *                        │  本文件按 {@link ALIVE_POLL_MS} 增量取
 *                        ▼
 *            `notificationsStream.ingestAliveNotification`
 *                        │
 *                        ▼
 *               列表(.gw-inbox)+ Web Notification
 * ```
 *
 * 为什么长连接在**宿主**而不是浏览器:alive 的两个端点都要令牌,而令牌只在宿主
 * (`src/client/gh-api.ts` 的 `getToken()` 实测恒 `''`)。所以浏览器拿不到 WS 地址,
 * 也不该拿到 —— 它只读宿主那两条路由。
 *
 * ## 与轮询的互斥(**承重**)
 *
 * 长连接**就绪**时({@link AlivePuller.probe} 说 `listening === true`)
 * 调用 `notificationsStream.setAlive(true)` ⇒ `start()` **不建定时器** ⇒
 * GitHub 请求为 **0**。两条同时跑会把同一条评论报两次
 * (`pr-comment` 的 id 前缀分别是 `a:` 与 `c:`,`seen` 挡不住交叉重复)。
 *
 * ## 诚实边界
 *
 * 1. **`ALIVE_POLL_MS` 是对宿主路由的轮询**,不是 GitHub 请求 —— 它不花限额,
 *    但它意味着事件到达列表有最多 {@link ALIVE_POLL_MS} 的延迟
 *    (上游是同一帧内到 OS 通知)。想做到零延迟要上 SSE/long-poll,本轮没做。
 * 2. **事件的正文要补一次 GitHub 请求**(`a:` 那一条):alive 事件体里只有 id
 *    (`comment_id` / `review_id` / `commit_sha`),没有标题与正文 ——
 *    上游 `notifications-store.ts:170-215` **同样**要再取一次
 *    (`api.fetchIssueComment(...)`)。这不是我们多花的。
 * 3. **不判事件是不是本仓库的**:上游还有 `isValidRepositoryForEvent` 一层过滤
 *    (它要求事件落在**当前选中**的仓库上)。宿主按频道订阅(整个账号的 Desktop 频道),
 *    所以这里按事件里的 `owner/repo` **自行收窄**到当前目标仓库
 *    ({@link AlivePuller.ingestEvent} 的第一句)—— 与上游同结果、实现更窄。
 *
 * @module dsh-git/client/alive
 */

import {
  analyzeChecks,
  composeTitle,
  notificationsStream,
  type IHighSignalNotification,
} from './notifications.ts';
import { truncateWithEllipsis } from '../core/desktop/lib/truncate-with-ellipsis.ts';
import {
  getPull,
  listCheckRuns,
  listComments,
  listReviews,
  type GhPull,
} from './gh-api.ts';
import type { GhRef } from '../core/lib.ts';
import { api, type IAliveStatusPayload, type ApiResult } from './api.ts';
import { shortenSHA } from '../core/desktop/models/commit.ts';
import { isValidNotificationPullRequestReview } from '../core/desktop/lib/valid-notification-pull-request-review.ts';
import { getVerbForPullRequestReview } from '../core/desktop/ui/notifications/pull-request-review-helpers.ts';

/**
 * 取宿主事件缓冲的间隔(ms)。
 *
 * 5000 是**权衡**:延迟上限 5s(上游 0s),而请求数是 `1 次/5s` = 720 次/小时,
 * 全部打在**本机**路由上(`dsh-git/alive/events`,不碰 GitHub、不花限额)。
 */
export const ALIVE_POLL_MS = 5_000;

/**
 * 兜底检查「长连接还在不在」的间隔(ms)。
 *
 * 为什么需要它:`socket` 可能在**首次探测之后**才掉线(网络切换、服务端 redeploy),
 * 而 `AliveService.status().listening` 是**那一刻**的读数。没有这个兜底的话
 * 「连接断了」就等于「通知永远不来了」。60s 一次,打的是本机路由。
 */
export const ALIVE_WATCHDOG_MS = 60_000;

/**
 * 只问一次宿主的 `alive/status`(**不动**流的开关)。
 *
 * {@link AlivePuller.probe} 与 `workbench.tsx` 的兜底都用它,避免两份形状解析。
 *
 * @returns 状态;路由不可用 ⇒ `null`。
 */
export async function callAliveStatus(): Promise<IAliveStatusPayload | null> {
  return callAlive(() => api.aliveStatus());
}

/**
 * 上游 `DesktopAliveEvent` 的三类事件。
 *
 * ⚠️ **手写这一份是刻意的**:镜像那一份在 `src/host/mirror/**`,而
 * 「host→client 跨根 import = 0」是一条现有读数(`host-mirror-adaptation-probe`
 * 的 `crossHalf` 为空)⇒ 浏览器半不能 import 它。这里逐字照
 * `alive-store.ts:13-41` 的三个接口声明 `type` 的**结构**,不是第二份实现
 * (没有一行逻辑)。判据:`docs/probes/alive-connection-probe.mjs` 的 C 组
 * 把宿主真收到的**逐字**事件体喂给这条派生路径。
 */
export type AliveEvent =
  | {
      readonly type: 'pr-checks-failed';
      readonly timestamp: number;
      readonly owner: string;
      readonly repo: string;
      readonly pull_request_number: number;
      readonly check_suite_id: number;
      readonly commit_sha: string;
    }
  | {
      readonly type: 'pr-review-submit';
      readonly timestamp: number;
      readonly owner: string;
      readonly repo: string;
      readonly pull_request_number: number;
      readonly state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED';
      readonly review_id: string;
    }
  | {
      readonly type: 'pr-comment';
      readonly subtype: 'review-comment' | 'issue-comment';
      readonly timestamp: number;
      readonly owner: string;
      readonly repo: string;
      readonly pull_request_number: number;
      readonly comment_id: string;
    };

/** 宿主 `alive/status` 的载荷。 */
/**
 * 打 `dsh-git/alive/*` 两条路由中的一条。
 *
 * ⚠️ **必须走 `src/client/api.ts`**,不能在这里直接 `fetch`(浏览器半的
 * `no-restricted-syntax` 明令禁止,而且那条规则的理由是真的:信封收窄、
 * 错误归一化、URL 拼装都在 `api.ts` 的 `call()` 里)。
 *
 * @param run - 一次 `api.aliveStatus()` / `api.aliveEvents()`。
 * @returns 解开的 `value`;路由不存在 / 载荷被拒 ⇒ `null`(**不抛**,调用方按 null 回落)。
 */
async function callAlive<T>(run: () => Promise<ApiResult<T>>): Promise<T | null> {
  const result = await run();
  return result.ok ? result.value : null;
}

/** 事件的 JSON 形状守卫(宿主把它们原样存过,但跨 HTTP 之后必须有检查)。 */
function asAliveEvent(value: unknown): AliveEvent | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const type = record.type;
  if (type !== 'pr-comment' && type !== 'pr-review-submit' && type !== 'pr-checks-failed') {
    return null;
  }
  if (typeof record.owner !== 'string' || typeof record.repo !== 'string') {
    return null;
  }
  if (typeof record.pull_request_number !== 'number') {
    return null;
  }
  return value as AliveEvent;
}

/**
 * 长连接的取事件器:一个目标仓库一条。
 *
 * 由 `workbench.tsx` 的 effect 建/拆(与 `notificationsStream.setTarget` 同一处),
 * 这样切仓库时游标与目标一起重建。
 */
export class AlivePuller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private cursor = 0;
  private inFlight = false;
  private readonly target: GhRef;
  /** `PR 编号 → PR`(同一事件风暴里不重复取)。 */
  private readonly pullCache = new Map<number, GhPull>();
  /** 最近一次失败原因(`null` = 没失败过)。 */
  private lastError: string | null = null;

  /**
   * @param target - 当前目标仓库(事件里 owner/repo 不匹配的一律丢掉)。
   */
  public constructor(target: GhRef) {
    this.target = target;
  }

  /**
   * 探一次宿主的长连接**是否真的在推**,并据此切生产者的开关。
   *
   * ⚠️ 判据是 `listening === true` 而**不是** `supported === true`:
   * 「宿主有这条路由」不等于「连接已建立」。后者会让客户端在**订阅失败**时
   * 也把轮询停掉 ⇒ 通知彻底不来了(这正是「绿得空心」的一种形状)。
   *
   * ⚠️ **2026-10-08:这个判据的含义变严了。** 它此前信的是宿主那个「我们要求订阅了」
   * 的布尔(404 档也是 `true`)⇒ 端点没开 Alive 时**两条生产者都不跑**。
   * 现在 `listening` 是**结果**(真的有 session + 订阅)⇒ 这一条读数的意思从
   * 「宿主要订阅」变成「宿主有一条真的会话」。探针:
   * `docs/probes/alive-status-outcome-probe.mjs`(404 档与 200 档成对)。
   *
   * @returns 宿主状态(拿不到 ⇒ `null`,调用方保持轮询)。
   */
  public async probe(): Promise<IAliveStatusPayload | null> {
    const status = await callAlive(() => api.aliveStatus());
    if (status === null) {
      notificationsStream.setAlive(false);
      return null;
    }
    notificationsStream.setAlive(status.listening === true);
    return status;
  }

  /** 开始取事件(幂等)。第一帧**立刻**取一次。 */
  public start(): void {
    if (this.timer !== null) {
      return;
    }
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, ALIVE_POLL_MS);
  }

  /** 停止取事件(幂等)。**不**动 `notificationsStream`(那由 `applyAliveMode` 管)。 */
  public stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 最近一次失败原因。@returns 原因或 `null`。 */
  public error(): string | null {
    return this.lastError;
  }

  /** 取一帧:增量拉 + 逐条派生 + 喂流。 */
  private async tick(): Promise<void> {
    if (this.inFlight) {
      return;
    }
    this.inFlight = true;
    try {
      const payload = await callAlive(() => api.aliveEvents(this.cursor));
      if (payload === null) {
        this.lastError = '宿主没有回 alive/events(老宿主或路由未注册)';
        return;
      }
      this.cursor = payload.cursor;
      this.lastError = null;
      for (const entry of payload.events) {
        const event = asAliveEvent(entry.event);
        if (event === null) {
          continue;
        }
        const candidate = await this.derive(event);
        if (candidate !== null) {
          notificationsStream.ingestAliveNotification(candidate);
        }
      }
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * 一条 alive 事件 ⇒ 一条通知(或 `null` = 丢掉)。
   *
   * 丢掉的三类:别人的仓库、取不到 PR、闸门不过(评审的 `DISMISSED` 等)。
   *
   * @param event - 逐字的 `DesktopAliveEvent`。
   * @returns 通知;丢弃 ⇒ `null`。
   */
  public async derive(event: AliveEvent): Promise<IHighSignalNotification | null> {
    if (event.owner !== this.target.owner || event.repo !== this.target.repo) {
      return null;
    }
    const pull = await this.pullOf(event.pull_request_number);
    if (pull === null) {
      return null;
    }
    const base = {
      owner: event.owner,
      repo: event.repo,
      pullRequestNumber: event.pull_request_number,
      pullRequestTitle: pull.title,
    };
    const prLine = `${pull.title} #${pull.number}`;

    if (event.type === 'pr-comment') {
      /*
       * 正文与作者都要再取一次(上游 `notifications-store.ts:184-215` 同):
       * 事件体里只有 `comment_id`。`subtype` 决定取哪一族 —— 上游也是两路
       * (`fetchIssueComment` / `fetchPullRequestReviewComment`),而我们**只接**
       * issue comments 那一族(行内评论要 `/pulls/{n}/comments`,今天没接,
       * 如实登记在 `docs/alive-connection-port.md`)。
       */
      if (event.subtype !== 'issue-comment') {
        return null;
      }
      const page = await listComments(this.target, event.pull_request_number);
      const comment = page.items.find((c) => String(c.id) === event.comment_id);
      if (comment === undefined) {
        return null;
      }
      const actor = comment.user?.login ?? 'ghost';
      return {
        ...base,
        id: `a:c:${event.owner}/${event.repo}#${event.pull_request_number}:${event.comment_id}`,
        kind: 'pr-comment',
        actor,
        title: composeTitle('pr-comment', actor, ''),
        body: `${prLine}\n${truncateWithEllipsis(comment.body ?? '', 50)}`,
        htmlUrl: comment.html_url,
        createdAt: comment.created_at,
        caveat: '',
      };
    }

    if (event.type === 'pr-review-submit') {
      const reviews = await listReviews(this.target, event.pull_request_number);
      const review = reviews.find((r) => String(r.id) === event.review_id);
      // 闸门是**逐字镜像**的那一个(上游 `notifications-store.ts:243` 同一处)。
      if (review === undefined || !isValidNotificationPullRequestReview(review)) {
        return null;
      }
      const actor = review.user?.login ?? 'ghost';
      const verb = getVerbForPullRequestReview(review) ?? 'reviewed';
      return {
        ...base,
        id: `a:r:${event.owner}/${event.repo}#${event.pull_request_number}:${event.review_id}`,
        kind: 'pr-review-submit',
        actor,
        title: composeTitle('pr-review-submit', actor, verb),
        body: `${prLine}\n${truncateWithEllipsis(review.body ?? '', 50)}`,
        htmlUrl: review.html_url,
        createdAt: review.submitted_at ?? pull.updated_at,
        caveat: '',
      };
    }

    const runs = await listCheckRuns(this.target, event.commit_sha);
    const failed = analyzeChecks(runs, []);
    if (failed.length === 0) {
      return null;
    }
    const plural = failed.length === 1 ? 'check was' : 'checks were';
    return {
      ...base,
      id: `a:k:${event.owner}/${event.repo}#${event.pull_request_number}:${event.commit_sha}`,
      kind: 'pr-checks-failed',
      actor: '',
      title: composeTitle('pr-checks-failed', '', ''),
      body: `${prLine} (${shortenSHA(event.commit_sha)})\n${failed.length} ${plural} not successful.`,
      htmlUrl: pull.html_url,
      createdAt: new Date(event.timestamp).toISOString(),
      caveat: '未按「失败提交的作者必须是当前账号」过滤(宿主拿不到账号邮箱清单)⇒ 可能多报。',
    };
  }

  /**
   * 取一个 PR(**同一帧内缓存**)。
   *
   * @param prNumber - PR 编号。
   * @returns PR;取不到 ⇒ `null`(事件被丢掉,不是伪造一条)。
   */
  private async pullOf(prNumber: number): Promise<GhPull | null> {
    const cached = this.pullCache.get(prNumber);
    if (cached !== undefined) {
      return cached;
    }
    try {
      const pull = await getPull(this.target, prNumber);
      this.pullCache.set(prNumber, pull);
      return pull;
    } catch {
      return null;
    }
  }
}

/**
 * 把「长连接模式」应用到通知流,并返回要保留的取事件器。
 *
 * **这是两条生产者互斥的唯一入口**:只有 `probe()` 读到 `listening === true`
 * 才会 `setAlive(true)` ⇒ 轮询不建定时器。
 *
 * @param target - 当前目标仓库(`null` = 没有 GitHub 远端)。
 * @returns 取事件器(`null` = 没起长连接,调用方保持轮询)。
 */
export async function applyAliveMode(target: GhRef | null): Promise<AlivePuller | null> {
  if (target === null) {
    notificationsStream.setAlive(false);
    return null;
  }
  const puller = new AlivePuller(target);
  const status = await puller.probe();
  if (status === null || status.listening !== true) {
    return null;
  }
  puller.start();
  return puller;
}
