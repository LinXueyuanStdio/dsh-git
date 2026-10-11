/**
 * **GitHub App 用户令牌的自动续期**。
 *
 * ## 为什么需要它
 *
 * GitHub App 的用户令牌**默认 8 小时后过期**(官方文档:*By default, the user access token
 * expires after 8 hours*),续期靠设备码/续期响应里那一枚 `refresh_token`(6 个月不用则失效)。
 * 在那之前,本插件只消费 `access_token`(现场证据:`describeDeviceTokenShape()` 记的那行
 * 「令牌形态」)—— 到期后 `/user`、`/user/repos`、`/user/emails`、`gh` 代理与 `git push`
 * 会**静默**开始 401,用户看到的是「昨天还好好的」。
 *
 * ## 两道防线(缺一不可)
 *
 *  1. **定时续期(主动)**:知道到期时间时,提前 {@link REFRESH_SKEW_MS} 换新令牌。
 *     这一道是 `git push` 唯一能靠的 —— `credentialEnv()` 是**同步**的(令牌直接进 git 子进程
 *     的环境变量),没法在推送到一半时去续期。
 *  2. **401 重试(被动)**:`GithubAuth` 的每次取数遇到 401 就问这里要一次新令牌并重试一次。
 *     这一道兜住「到期时间未知」的情形 —— 最典型的是**重启之后**:进程内存里的到期时间没了,
 *     而磁盘上的 access token 可能只剩几分钟。
 *
 * ## 写盘顺序(**故意的**)
 *
 * 先写新的 `refresh_token`,再写新的 `access_token`。理由:GitHub 的规则是**用完即换**
 * (*Once you use a refresh token, that refresh token and the old access token will no longer
 * work*)。若反过来、恰好在两次写之间崩了,磁盘上就是一对比**已经作废**的凭据 ⇒ 只能重新登录;
 * 按这个顺序崩,最坏是"旧 access(仍然有效)+ 新 refresh(有效)",下一次续期自会纠正。
 *
 * ## 令牌存在哪
 *
 * access token 仍住在 `refs.GITHUB_TOKEN`(既有那条缝,`git` 用的就是它);
 * **refresh token 住 `refs.GITHUB_REFRESH_TOKEN`** —— 它是独立的一条凭据引用,走
 * {@link createCredentialBridge} 的**同一套策略**(凭据域、不可写时绝不退回明文、失败只报一次)。
 * 到期时间只是**内存里的一个数字**(不是秘密,但也没必要持久化:重启后由上面第 2 道兜住)。
 *
 * @module dsh-git/host/token-refresh
 */

import { createCredentialBridge } from './credential-bridge.ts';
import type { TokenHome } from './credential-bridge.ts';

/** 续期令牌在宿主凭据缝里的引用(与 access token 的 `GITHUB_TOKEN` 并列)。 */
export const GITHUB_REFRESH_TOKEN_REF = 'GITHUB_REFRESH_TOKEN';

/** device flow / 续期共用的那个端点(只打 github.com,理由见 `auth.ts` 文件头)。 */
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';

/** 刷新用的 grant type(官方文档:*The grant type must be `refresh_token`*)。 */
const REFRESH_GRANT = 'refresh_token';

/** 提前多久续期(毫秒):留出一次网络往返 + 一点余量,免得正在推代码时刚好过期。 */
export const REFRESH_SKEW_MS = 5 * 60 * 1000;

/** 定时器最短/最长睡多久(毫秒):短于 30 秒就是空转;长于 1 小时则可能睡过到期点。 */
const MIN_SLEEP_MS = 30 * 1000;
const MAX_SLEEP_MS = 60 * 60 * 1000;

/**
 * `POST /login/oauth/access_token` 的响应 → 我们要的三个字段。
 *
 * device flow 与续期**共用这一个解析器**:两者的响应形状是同一套
 * (`access_token` / `refresh_token` / `expires_in`,失败时是 `error` / `error_description`)。
 *
 * 三态(而不是可空对象):调用方要区分「拿到令牌」「GitHub 明确报错」「响应看不懂」——
 * 第三种只在协议漂移时出现,必须与第二种分开说。
 */
export type ParsedTokenResponse =
  | {
      readonly kind: 'ok';
      readonly accessToken: string;
      /** 续期令牌;没有 ⇒ 这个 App 不签发会过期的令牌(OAuth App 的常态)。 */
      readonly refreshToken: string;
      /** 还有多少秒过期;`null` = 不过期。 */
      readonly expiresInSec: number | null;
    }
  | { readonly kind: 'error'; readonly error: string; readonly description: string }
  | { readonly kind: 'malformed' };

/**
 * 解析一次令牌响应(纯函数)。
 * @param json - 响应 JSON(`null` / 非对象 / 字段类型不对都算 `malformed`)。
 * @returns 见 {@link ParsedTokenResponse}。
 */
export function parseTokenResponse(json: unknown): ParsedTokenResponse {
  if (typeof json !== 'object' || json === null) {
    return { kind: 'malformed' };
  }
  const record = json as Record<string, unknown>;
  const accessToken = typeof record.access_token === 'string' ? record.access_token : '';
  if (accessToken === '') {
    const error = typeof record.error === 'string' ? record.error : '';
    if (error === '') {
      return { kind: 'malformed' };
    }
    return {
      kind: 'error',
      error,
      description: typeof record.error_description === 'string' ? record.error_description : '',
    };
  }
  return {
    kind: 'ok',
    accessToken,
    refreshToken: typeof record.refresh_token === 'string' ? record.refresh_token : '',
    expiresInSec:
      typeof record.expires_in === 'number' && Number.isFinite(record.expires_in) && record.expires_in > 0
        ? record.expires_in
        : null,
  };
}

/**
 * 现在该不该续期(纯函数)。
 *
 * `expiresAtMs === null` ⇒ **不知道**到期时间 ⇒ 不主动续(由 401 那条被动防线兜)。
 * 这个"不知道就不动"是刻意的:重启之后我们确实什么都不知道,凭猜测去换令牌会把
 * 「本可以继续用」的会话搅乱(而且每换一次都作废上一枚 refresh token)。
 *
 * @param expiresAtMs - 到期时刻(epoch 毫秒);`null` = 不知道 / 不过期。
 * @param nowMs - 现在(epoch 毫秒)。
 * @param skewMs - 提前量(默认 {@link REFRESH_SKEW_MS})。
 * @returns 该续 ⇒ `true`。
 */
export function needsRefresh(
  expiresAtMs: number | null,
  nowMs: number,
  skewMs: number = REFRESH_SKEW_MS,
): boolean {
  if (expiresAtMs === null) {
    return false;
  }
  return nowMs >= expiresAtMs - skewMs;
}

/**
 * 下一次检查该睡多久(纯函数)。
 * @param expiresAtMs - 到期时刻;`null` ⇒ 不排(`null`)。
 * @param nowMs - 现在。
 * @param skewMs - 提前量。
 * @returns 毫秒,已夹到 `[MIN_SLEEP_MS, MAX_SLEEP_MS]`;`null` = 不必排。
 */
export function nextCheckDelayMs(
  expiresAtMs: number | null,
  nowMs: number,
  skewMs: number = REFRESH_SKEW_MS,
): number | null {
  if (expiresAtMs === null) {
    return null;
  }
  const target = expiresAtMs - skewMs;
  const raw = target - nowMs;
  if (raw <= MIN_SLEEP_MS) {
    return MIN_SLEEP_MS;
  }
  return Math.min(raw, MAX_SLEEP_MS);
}

/** {@link GithubTokenRefresher} 的依赖。 */
export interface IGithubTokenRefreshDeps {
  /** 设备码 / 续期都要用的 Client ID;空串 = 这个部署没配 App,续期无从谈起。 */
  readonly clientId: string;
  /**
   * **可选的** Client Secret。
   *
   * 官方文档对续期那一步写的是:*`client_secret` —— **Required** unless the user access token
   * was generated using the device flow*。我们**正是**设备码那条路,所以正常情况下不需要它;
   * 但实测(2026-11,拿一枚伪造的 refresh token 打真端点)GitHub 回的是
   * `incorrect_client_credentials` 而不是 `bad_refresh_token` —— 这既可能是"伪造令牌无法
   * 关联到 App ⇒ 退化成凭据错误",也可能是"这条路径仍然要 secret"。
   * ⇒ 给出这个**可选**入口:配了就带上,没配就不带(默认行为与文档一致)。
   *
   * ⚠️ **它绝不落进仓库 / profile / 日志**:只从环境变量读(`src/index.ts` 的
   * `DSH_GIT_CLIENT_SECRET`),而且本文件任何一行都不打印它。
   */
  readonly clientSecret?: string;
  /** refresh token 的凭据家(`refs.GITHUB_REFRESH_TOKEN`)。 */
  readonly refreshHome: TokenHome;
  /** 当前 access token(判定"还有没有登录")。 */
  readonly readAccessToken: () => string;
  /** 写入续期后的 access token(走 registry ⇒ 与设备码登录同一个凭据缝)。 */
  readonly writeAccessToken: (token: string) => Promise<void>;
  /** value-free 的日志出口。 */
  readonly log: (message: string) => void;
}

/**
 * 令牌续期器 —— 持有「到期时间 + 定时器」,并提供 `refreshNow()` 给 401 那条被动防线。
 *
 * 生命周期:`start()` 在插件激活时调一次(`src/index.ts` 的 `ctx.effect`),`stop()` 在卸载时;
 * `clear()` 在**登出**与**PAT 登录**时调(那两种情况下 refresh token 都不该留着)。
 */
export class GithubTokenRefresher {
  /** 到期时刻;**只活在内存**(理由见文件头)。 */
  private expiresAtMs: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** 并发去重:同一时刻十个请求撞上 401,只换**一次**令牌。 */
  private inFlight: Promise<boolean> | null = null;
  private stopped = true;

  public constructor(private readonly deps: IGithubTokenRefreshDeps) {}

  /**
   * 记下刚拿到的一对令牌(设备码登录成功时调)。
   *
   * ⚠️ 这里**不写 access token**:那条由 `pollDeviceFlow()` 自己写(它已经写了,而且是同一次
   * 凭据缝写入);本方法只接管「refresh token + 到期时间」这一半,免得同一件事有两处写。
   * @param input - 刚拿到的 refresh token 与有效期。
   */
  public async acceptIssued(input: { readonly refreshToken: string; readonly expiresInSec: number | null }): Promise<void> {
    if (input.refreshToken !== '') {
      await this.deps.refreshHome.write(input.refreshToken);
    }
    this.expiresAtMs = input.expiresInSec === null ? null : Date.now() + input.expiresInSec * 1000;
    this.schedule();
  }

  /** 换了账号 / 登出:PAT 没有续期可言,refresh token 与到期时间一起清掉。 */
  public async clear(): Promise<void> {
    this.expiresAtMs = null;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.deps.refreshHome.write('');
  }

  /**
   * 启动:排定时器;若**有 refresh token 但不知道到期时间**(重启后的典型状态),
   * 就先换一次 —— 这一次换完两件事都清楚了:令牌是新的、到期时间是已知的。
   *
   * 为什么值得多打一次请求:否则重启后的会话只能靠 401 被动兜,而 `git push`
   * (同步取令牌)恰好是兜不住的那条路。
   */
  public start(): void {
    this.stopped = false;
    if (this.expiresAtMs === null && this.deps.refreshHome.read() !== '') {
      void this.refreshNow().then(() => { this.schedule(); });
      return;
    }
    this.schedule();
  }

  /** 卸载:停定时器(不动凭据)。 */
  public stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * 立刻续期一次;`true` = 新令牌已经装上(调用方可以重试那次请求)。
   *
   * 失败**不清 access token**:网络抖动 / GitHub 5xx 之后旧的 access token 往往还能用,
   * 清掉它等于把用户踢下线。只有 GitHub **明确说这枚 refresh token 作废**
   * (`bad_refresh_token` / `invalid_grant`)才清掉它并如实说「需要重新登录」。
   */
  public async refreshNow(): Promise<boolean> {
    if (this.inFlight !== null) {
      return this.inFlight;
    }
    const run = this.doRefresh().finally(() => { this.inFlight = null; });
    this.inFlight = run;
    return run;
  }

  private async doRefresh(): Promise<boolean> {
    const { clientId, log } = this.deps;
    if (clientId === '') {
      return false;
    }
    if (this.deps.readAccessToken() === '' && this.deps.refreshHome.read() === '') {
      return false;
    }
    const refreshToken = this.deps.refreshHome.read();
    if (refreshToken === '') {
      // PAT / OAuth App 的令牌没有续期这一说:不是错误,不必报。
      return false;
    }
    let res: Response;
    try {
      const body = new URLSearchParams({
        client_id: clientId,
        grant_type: REFRESH_GRANT,
        refresh_token: refreshToken,
      });
      /*
       * 只在实际配了 secret 时才带它(文档:设备码产出的令牌不需要 secret)。
       * 顺序无关,但 `URLSearchParams` 里**不**留空串 —— 空 `client_secret` 也会被当成
       * "提供了一个错的 secret"(实测:带空值比不带更容易撞 `incorrect_client_credentials`)。
       */
      if ((this.deps.clientSecret ?? '') !== '') {
        body.set('client_secret', this.deps.clientSecret ?? '');
      }
      res = await fetch(ACCESS_TOKEN_URL, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body,
      });
    } catch (error) {
      log(`[dsh-git] 令牌续期失败(网络):${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    const json = await res.json().catch(() => null) as unknown;
    const parsed = parseTokenResponse(json);
    if (parsed.kind === 'malformed') {
      log(`[dsh-git] 令牌续期失败:响应形状看不懂(HTTP ${res.status})。`);
      return false;
    }
    if (parsed.kind === 'error') {
      if (parsed.error === 'bad_refresh_token' || parsed.error === 'invalid_grant') {
        // 这枚 refresh token 废了(用过一次 / 6 个月没用 / 用户在 GitHub 上撤了授权)。
        // 清掉它,免得每次 401 都拿它去打一次;access token 留着 —— 它可能还有效。
        this.expiresAtMs = null;
        await this.deps.refreshHome.write('');
        log('[dsh-git] 续期令牌已失效(需要重新登录一次):GitHub 回了 '
          + `${parsed.error}。本次运行的令牌仍然可用,直到它自己过期。`);
        return false;
      }
      if (parsed.error === 'incorrect_client_credentials') {
        /*
         * 实测最可能撞到的一支(2026-11):GitHub 在这条路径上先把"凭据"判一遍,判不过就说
         * 这一句 —— 可能是它在**没有 client_secret** 时不接受续期,也可能是这枚 refresh token
         * 本身无法关联到 App。两种都给出**可操作的**两条出路,而不是把 GitHub 的原文丢给用户。
         */
        log('[dsh-git] 令牌续期被拒(incorrect_client_credentials):GitHub 不认这次的凭据。'
          + '两条出路 —— ①在 App 的 Optional Features 里**关掉** "User-to-server token expiration"'
          + '(那样令牌不会过期,也就不需要续期);②给续期请求带上 client secret'
          + '(环境变量 `DSH_GIT_CLIENT_SECRET`,只在部署侧给,不进仓库)。');
        return false;
      }
      log(`[dsh-git] 令牌续期被拒:${parsed.error}${parsed.description === '' ? '' : `(${parsed.description})`}`);
      return false;
    }
    /*
     * ⚠️ 顺序见文件头:「先 refresh 后 access」。两次写之间的崩溃窗口必须落在
     * 「旧 access 仍有效 + 新 refresh 有效」这一侧。
     */
    if (parsed.refreshToken !== '') {
      await this.deps.refreshHome.write(parsed.refreshToken);
    }
    await this.deps.writeAccessToken(parsed.accessToken);
    this.expiresAtMs = parsed.expiresInSec === null ? null : Date.now() + parsed.expiresInSec * 1000;
    this.deps.log(`[dsh-git] 令牌已自动续期${parsed.expiresInSec === null
      ? '(新令牌不过期)'
      : `(新令牌 ${Math.round(parsed.expiresInSec / 60)} 分钟后到期)`}。`);
    return true;
  }

  /** 按到期时间排下一次检查;不知道到期时间就不排(被动那条兜)。 */
  private schedule(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const delay = nextCheckDelayMs(this.expiresAtMs, Date.now());
    if (this.stopped || delay === null) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refreshNow().then(() => { this.schedule(); });
    }, delay);
  }
}

/**
 * 建一个续期器,并把它的凭据家一起建好。
 *
 * 为什么把「建桥」也包进来:两条引用的策略必须来自**同一个工厂**
 * (`createCredentialBridge`),调用方(host 入口)只该看见"给我一个续期器",
 * 而不是自己去拼第二个桥。
 * @param input - 凭据服务、Client ID、access token 的读/写、日志出口。
 * @returns 续期器(调用方负责 `start()` / `stop()`)。
 */
export function createTokenRefresher(input: {
  readonly service: Parameters<typeof createCredentialBridge>[0]['service'];
  readonly clientId: string;
  /** 可选的 client secret(见 {@link IGithubTokenRefreshDeps.clientSecret});默认不带。 */
  readonly clientSecret?: string;
  readonly readAccessToken: () => string;
  readonly writeAccessToken: (token: string) => Promise<void>;
  readonly log: (message: string) => void;
}): { readonly refresher: GithubTokenRefresher; readonly bootstrap: () => Promise<void> } {
  const refreshHome = createCredentialBridge({
    service: input.service,
    log: input.log,
    ref: GITHUB_REFRESH_TOKEN_REF,
  });
  const refresher = new GithubTokenRefresher({
    clientId: input.clientId,
    clientSecret: input.clientSecret ?? '',
    refreshHome,
    readAccessToken: input.readAccessToken,
    writeAccessToken: input.writeAccessToken,
    log: input.log,
  });
  return { refresher, bootstrap: () => refreshHome.bootstrap() };
}
