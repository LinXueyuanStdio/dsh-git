/**
 * GitHub 认证:OAuth Device Flow 为主、Personal Access Token 为兜底。
 *
 * 令牌只落 host;浏览器永远拿不到完整值(只回尾 4 位);`credentialEnv()` 把令牌
 * 交给 git 子进程时用环境变量而不是 URL/argv,避免它出现在 `ps` 与 reflog 里。
 *
 * **令牌的存放位置不在本文件里**:读写都经 {@link AuthDeps.registry} 的
 * `githubToken()` / `setGithubToken()`,而那个位置由 host 入口接上宿主的凭据缝
 * (引用名 `GITHUB_TOKEN`,见 `host/credential-bridge.ts`);凭据服务缺席时才退回
 * 插件 storage 的旧明文键。本文件因此**不需要**知道令牌存在哪 ——
 * 也正因如此,这里任何一行都不能把令牌值写进日志或错误文本。
 *
 * Device Flow 需要 OAuth App 的 Client ID(见 README)。没有 Client ID 时
 * `state().deviceFlow` 为 false,界面只显示 PAT 输入框。
 * @module dsh-git/host/auth
 */

import { DEFAULT_GITHUB_ENDPOINT } from './repo-registry.ts';
import type { RepoRegistry, RemoteRepoLite } from './repo-registry.ts';
// 路由层把 `GitServiceError.code` 当契约用(`routes.ts:624` 就按
// `code === 'not-signed-in'` 决定记 info 还是 warning),所以这里必须抛**同一个**
// 错误类。以前这里抛的是一个从未定义、也从未 import 的 `GitServiceError` ——
// 运行期一走到「未登录时列远程仓库」就 `ReferenceError`,而 routes 的 catch 把
// 它当成普通异常折成 internal;`not-signed-in` 这条「正常状态」因此永远走不到。
import { GitServiceError } from './git-service.ts';
/*
 * 令牌响应的**唯一**解析器(设备码与续期共用同一套字段)。
 * 反向依赖不存在:`token-refresh.ts` 只从 `credential-bridge.ts` 取类型/工厂,不 import 本文件。
 */
import { parseTokenResponse } from './token-refresh.ts';

/**
 * github.com 的 OAuth 端点。
 *
 * ⚠️ **设备码流程只打 github.com**(`DEVICE_CODE_URL` / `ACCESS_TOKEN_URL`):
 * host 的 `clientId` 是**一个**值(profile 的 `cordis.patch.yml` 配置),它是在
 * github.com 上注册的 OAuth App;GitHub Enterprise Server 的设备码流程必须用
 * **在该实例上注册**的 client id(http://HOSTNAME/login/device/code),
 * 所以同一个 clientId 打企业端点不会成功。
 * ⇒ **企业端点只支持 PAT 登录**(见 {@link GithubAuth.setPat})。
 * 设备码流程无法支持企业端点这件事是**已知限制**,不是待办。
 */
const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

/**
 * GitHub REST 要求的 `User-Agent`。
 *
 * GitHub 对**没有** `User-Agent` 的请求直接回 `403`(它们的 REST 文档如此规定)。
 * 之前几条调用没带它,而 Node 的 fetch(undici)会补一个自己的 UA,所以一直没暴露 ——
 * 依赖运行期的隐式补全不是契约,这里显式写上。
 */
const USER_AGENT = 'dsh-git';

/** 远程仓库缓存有效期(与 workbench 的 5 分钟一致)。 */
const REMOTE_CACHE_MS = 5 * 60_000;

/** 认证状态(界面用;不含令牌本身)。 */
export interface AuthState {
  signedIn: boolean;
  login: string;
  tokenTail: string;
  /**
   * 当前账号的 GitHub **API 基址**。
   *
   * 默认 `https://api.github.com`;企业账号是归一化后的企业 API 基址
   * (见 {@link normalizeGithubEndpoint})。客户端据此显示「登录到哪个实例」,
   * 也可以据此拼自己的请求。
   */
  endpoint: string;
  /** host 是否配置了 OAuth App Client ID。 */
  deviceFlow: boolean;
  /** 令牌是否通过 Device Flow 获得。 */
  viaDeviceFlow: boolean;
}

/**
 * 账号邮箱(GitHub `GET /user/emails` 的一行)。
 *
 * 字段映射**原样**:上游 Desktop 的 `IAPIEmail` 就是这四个
 * (`references/desktop/app/src/lib/api.ts:331-336`),客户端的 Author 邮箱下拉与
 * misattribution 告警按同一形状消费。
 */
export interface AccountEmail {
  email: string;
  verified: boolean;
  primary: boolean;
  visibility: string | null;
}

/** Device Flow 启动结果。 */
export interface DeviceFlowStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

/**
 * Device Flow 轮询结果。
 *
 * ⚠️ `pending` 这一支有两个字段,是因为 GitHub 的 `slow_down` **必须**被遵守(2026-11 实测):
 * 它除了让我们放慢,还会给出**新的 `interval`**;不照办的话下一次还是 `slow_down`、
 * 而且每次再加 5 秒,令牌**永远**不会下发(现场就是"浏览器里授权了,界面一直停在等待授权")。
 *  - `slowDown` —— 这一轮收到了 `slow_down`(客户端据此退避);
 *  - `interval` —— GitHub 明确要求的下一个间隔(秒)。**只在 `slow_down` 时给**,
 *    缺失时由客户端按「+5 秒」的规则自增。
 */
export type DeviceFlowPoll =
  | { status: 'pending'; slowDown?: boolean; interval?: number }
  | { status: 'done'; state: AuthState }
  | { status: 'error'; message: string };

export interface AuthDeps {
  registry: RepoRegistry;
  /** OAuth App / GitHub App 的 Client ID;缺省 = 不提供设备码登录。 */
  clientId: string;
  /**
   * **内置 App 的 slug**(`github.com/apps/<slug>`)—— 只在生效的 Client ID 就是内置那一份时给,
   * 用来拼「安装入口」。用户自带 App 时必须是空串:我们不知道他的 slug,编一个链接等于骗人。
   */
  appSlug?: string;
  log?: (message: string) => void;
}

/**
 * 令牌续期器的**结构切面**(实现是 `token-refresh.ts` 的 `GithubTokenRefresher`)。
 *
 * 为什么在本文件里只认这个形状、而不是 import 那个类:续期器要等**凭据服务**到位才能建
 * (它要往 `refs.GITHUB_REFRESH_TOKEN` 写),而本类在那之前就构造好了 ⇒ 用
 * {@link GithubAuth.useTokenRefresher} 事后装进来。与 `RepoRegistry.useTokenHome()` 同一个形状。
 */
export interface IAuthTokenRefresher {
  /** 立刻续期一次;`true` = 新令牌已装上(调用方可以重试那次请求)。 */
  refreshNow(): Promise<boolean>;
  /** 设备码登录拿到新令牌时登记 refresh token 与有效期。 */
  acceptIssued(input: {
    readonly refreshToken: string;
    readonly expiresInSec: number | null;
  }): Promise<void>;
  /** 换账号 / 登出:清掉 refresh token 与到期时间。 */
  clear(): Promise<void>;
}

/**
 * **GitHub App 的安装状态** —— 「授权」与「安装」是两件事,这个类型就是那个区分。
 *
 * 现场(2026-11):设备码**授权成功**、令牌也拿到了,但 `GET /user/installations` 回
 * `total_count: 0` ⇒ 之后**所有仓库级**端点一律 403,而 GitHub 只回一句
 * `Resource not accessible by integration`(不解释、也不说下一步)。界面因此只能在各个页签里
 * 各报一次同样的错。这一支就是把它翻成「你该去点 Install」。
 */
export type AuthInstallationStatus =
  /** 没有令牌。 */
  | { readonly kind: 'not-signed-in' }
  /**
   * 登录了,但令牌不是 **GitHub App 的用户令牌**(`ghu_`)⇒ 没有"安装"这个概念
   * (PAT 与 OAuth App 令牌都归这里)。界面**不提示**,免得对着 PAT 用户喊"去安装"。
   */
  | { readonly kind: 'not-app-token' }
  /** 查不动(网络 / 端点不支持 / 非 200)⇒ 一律**不提示**:不确定的事不许当结论。 */
  | { readonly kind: 'unknown' }
  /** 已安装(至少一处)。`count` = 安装数,给文案用。 */
  | { readonly kind: 'installed'; readonly count: number }
  /** 查询成功但**一处都没装** —— 这就是要引导的那一档。`installUrl` 可能为空(用户自带 App)。 */
  | { readonly kind: 'not-installed'; readonly installUrl: string };

/**
 * 这枚令牌是不是 **GitHub App 的用户令牌**。
 *
 * 判据是**前缀**(GitHub 的公开约定):`ghu_` = GitHub App user-to-server、
 * `gho_` = OAuth App、`ghp_` / `github_pat_` = PAT、`ghs_` = 安装令牌。
 * 为什么不能只看"有没有令牌":只有 App 令牌才有"安装"这一步,拿 PAT 去问 `/user/installations`
 * 得到的答案与"要不要点 Install"无关(而且我们根本没发那次请求,见 {@link installationStatusOf})。
 * @param token - 宿主里的令牌(只在 host 半,永不进浏览器)。
 */
export function isGithubAppUserToken(token: string): boolean {
  return token.startsWith('ghu_');
}

/**
 * 「安装状态」的**唯一判据**(纯函数)—— 从「发了没有 / 回了什么」翻成界面要的那一支。
 *
 * 为什么把这件事抽出来:它有 5 种结果,而其中**只有一种**该在界面上说话。混在一起的典型
 * 后果是「查询失败」被当成「没安装」,于是用户被送去装一个可能已经装好的 App。
 *
 * | 输入 | 结果 |
 * |---|---|
 * | 没登录 | `not-signed-in` |
 * | 不是 App 令牌(PAT / OAuth App) | `not-app-token`(从**不**发请求) |
 * | 请求失败(异常 / 非 200 / 没有 `total_count`) | `unknown` |
 * | 200 且 `total_count > 0` | `installed` |
 * | 200 且 `total_count === 0` | `not-installed`(带安装入口) |
 *
 * @param input - 见类型里的字段说明。
 * @returns 界面可直接分支的状态。
 */
export function installationStatusOf(input: {
  readonly signedIn: boolean;
  readonly appUserToken: boolean;
  /** 实际拿到的 HTTP 状态;`null` = 没发请求 / 请求抛了。 */
  readonly httpStatus: number | null;
  /** 响应里的 `total_count`;拿不到就是 `null`。 */
  readonly totalCount: number | null;
  /** 内置 App 的安装入口;用户自带 App 时是空串。 */
  readonly installUrl: string;
}): AuthInstallationStatus {
  if (!input.signedIn) {
    return { kind: 'not-signed-in' };
  }
  if (!input.appUserToken) {
    return { kind: 'not-app-token' };
  }
  if (input.httpStatus !== 200 || input.totalCount === null) {
    return { kind: 'unknown' };
  }
  return input.totalCount > 0
    ? { kind: 'installed', count: input.totalCount }
    : { kind: 'not-installed', installUrl: input.installUrl };
}

/** GitHub API 错误(带状态码与可操作文案)。 */
export class GithubApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'GithubApiError';
    this.status = status;
  }
}

/**
 * 把一个端点归一化成 **API 基址**。
 *
 * 为什么需要它:客户端拿到的是用户在设置里填的东西,可能是
 *  - `https://api.github.com`(API 基址,github.com),
 *  - `https://github.com`(HTML 站点),
 *  - `https://ghe.example.com`(企业实例的 HTML 地址),
 *  - `https://ghe.example.com/api/v3`(已经填成 API 基址)。
 * 这四种必须落到**同一个**基址上,否则 `/user` 与 `/user/emails` 会打到错误的 URL。
 *
 * 规则(对照上游 GitHub Desktop 的同族函数)
 *  1. 空 ⇒ {@link DEFAULT_GITHUB_ENDPOINT};
 *  2. 只接受 http/https,且不许带用户名/密码(否则报可读的 `bad-request`);
 *  3. github.com / www.github.com / api.github.com ⇒ `https://api.github.com`
 *     (上游 `getAPIEndpoint` 的 isDotCom 分支,`references/desktop/app/src/lib/api.ts:2332-2333`);
 *  4. `*.ghe.com`(GitHub Enterprise Cloud,数据驻留)⇒ API 在 `api.<host>`
 *     (上游 `lib/api.ts:2329` 的 `getEnterpriseAPIURL` + `lib/endpoint-capabilities.ts:62` 的 `isGHE`);
 *  5. 已经带 `/api/…` 路径、或主机名本身就是 `api.<host>`(子域隔离的企业实例)
 *     ⇒ 原样使用(只去掉尾部斜杠);
 *  6. 其余(GitHub Enterprise Server 的 HTML 地址)⇒ `<host>/api/v3`
 *     (上游 `getEnterpriseAPIURL` 的 GHES 分支)。
 * @param raw - 用户/客户端给的端点;`undefined` 或空串 = 默认端点。
 * @returns 归一化后的 API 基址(无尾斜杠)。
 * @throws GitServiceError `bad-request` 端点不是合法的 http(s) URL 时。
 */
export function normalizeGithubEndpoint(raw?: string): string {
  const trimmed = (raw ?? '').trim().replace(/\/+$/, '');
  if (trimmed === '') {
    return DEFAULT_GITHUB_ENDPOINT;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new GitServiceError('bad-request', `端点不是合法的 URL:${trimmed}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new GitServiceError('bad-request', `端点只支持 http/https:${trimmed}`);
  }
  if (url.username !== '' || url.password !== '') {
    // 端点会进错误消息与界面,**绝不**允许它携带凭据。
    throw new GitServiceError('bad-request', '端点里不许带用户名/密码。');
  }
  const host = url.hostname.toLowerCase();
  if (host === 'github.com' || host === 'www.github.com' || host === 'api.github.com') {
    return DEFAULT_GITHUB_ENDPOINT;
  }
  if (host.endsWith('.ghe.com')) {
    return `${url.protocol}//${host.startsWith('api.') ? url.host : `api.${url.host}`}`;
  }
  const path = url.pathname.replace(/\/+$/, '');
  if (path.startsWith('/api/') || host.startsWith('api.')) {
    return `${url.protocol}//${url.host}${path}`;
  }
  return `${url.protocol}//${url.host}/api/v3`;
}

/**
 * 令牌对应的 **git 远端主机**(`credentialEnv()` 里 `insteadOf` 的左侧)。
 *
 * 从 API 基址反推 HTML 主机:去掉 `api.` 子域(上游 `getHTMLURL`
 * `references/desktop/app/src/lib/api.ts:2288-2317` 做的就是这件事)。
 * github.com 回 `github.com`(与 `credentialEnv()` 改造前的行为**逐字一致**)。
 * @param endpoint - 已归一化的 API 基址。
 */
export function gitCredentialHost(endpoint: string): string {
  if (normalizeGithubEndpoint(endpoint) === DEFAULT_GITHUB_ENDPOINT) {
    return 'github.com';
  }
  return new URL(endpoint).hostname.replace(/^api\./, '');
}

/** GitHub REST 的公共请求头(`Authorization` 只在有令牌时加)。 */
function githubHeaders(token: string, accept = 'application/vnd.github+json'): Record<string, string> {
  return {
    accept,
    'x-github-api-version': '2022-11-28',
    'user-agent': USER_AGENT,
    ...(token === '' ? {} : { authorization: `Bearer ${token}` }),
  };
}

/** 错误 → 一行文本(**不碰令牌**)。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 设备码响应里的令牌**形态** —— 给日志的一句事实(2026-11:为「OAuth App 还是 GitHub App」取证)。
 *
 * ## 为什么必须先把这件事钉住
 *
 * 两种 App 在这一步**只差 JSON 字段**:
 *  - OAuth App 的令牌默认**不过期** ⇒ 响应里只有 `access_token`,存下来就完了;
 *  - GitHub App 的用户令牌**默认 8 小时后过期**(官方文档:*By default, the user access
 *    token expires after 8 hours*,配 `refresh_token` 续期)⇒ 响应里还有 `expires_in` 与
 *    `refresh_token`。而 {@link GithubAuth.pollDeviceFlow} **只消费 `access_token`**、
 *    没有任何续期逻辑 ⇒ 8 小时后 `/user`、`/user/repos`、`/user/emails` 与 `git push`
 *    会**静默**开始 401(用户看到的是「昨天还好好的」)。
 *
 * 所以先记一行事实,再决定「在 host 里实现续期」还是「在 App 的设置里关掉 expiring tokens」
 * (后者是官方文档里的 optional feature,可 opt in / out)。令牌前缀是同一件事的第二份证据 ——
 * GitHub 的令牌前缀是稳定的公开约定(`gho_` = OAuth App 用户令牌、`ghu_` = GitHub App 用户令牌、
 * `ghp_` / `github_pat_` = PAT、`ghs_` = 安装令牌)。
 *
 * ⚠️ **只报形状,绝不报值**:令牌只报**前缀**,`refresh_token` 只说有/没有,`expires_in` 是秒数。
 *
 * @param json - `POST /login/oauth/access_token` 的 JSON 响应。
 * @returns 供日志使用的一句;`expires_in` 缺失 = 令牌不过期。
 */
export function describeDeviceTokenShape(json: Record<string, unknown>): string {
  const token = typeof json.access_token === 'string' ? json.access_token : '';
  const prefix = /^[a-z]+_/.exec(token)?.[0] ?? '(无前缀)';
  const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : null;
  const hasRefresh = typeof json.refresh_token === 'string' && json.refresh_token !== '';
  if (expiresIn === null) {
    return `前缀 ${prefix},令牌不过期(响应里没有 expires_in)`;
  }
  return `前缀 ${prefix},令牌 ${expiresIn} 秒后过期;refresh_token ${hasRefresh ? '有' : '没有'}`
    + (hasRefresh ? '' : ' ⚠️ 没有 refresh_token ⇒ 到期后只能重新登录一次');
}

export class GithubAuth {
  private login = '';
  private viaDeviceFlow = false;
  /** 最近一次 GitHub 响应的 core 限额剩余(页脚展示)。 */
  private lastRemaining: number | null = null;
  /**
   * 续期器;**凭据服务到位之后**才装上(`useTokenRefresher`)。
   * `null` = 这个 profile 没有可用的凭据服务 ⇒ 没有续期可言,401 原样抛给上层。
   */
  private refresher: IAuthTokenRefresher | null = null;

  constructor(private readonly deps: AuthDeps) {}

  /**
   * 装上续期器 —— 与 `RepoRegistry.useTokenHome()` 同一个形状与同一个时机
   * (凭据服务到位后由 `startTokenHome()` 调)。
   * @param refresher - 见 {@link IAuthTokenRefresher}。
   */
  public useTokenRefresher(refresher: IAuthTokenRefresher): void {
    this.refresher = refresher;
  }

  rateRemaining(): number | null {
    return this.lastRemaining;
  }

  /**
   * 代理一次 GitHub REST 调用:令牌留在 host,浏览器不接触它,
   * 顺带绕开 CORS 与匿名限额。
   *
   * ## 条件请求(`etag` / `ifModifiedSince`)—— 2026-10 追加
   *
   * 为什么必须支持:GitHub 的**条件请求命中 304 时不消耗主限额**
   * (`docs/probes/notifications-etag-free-probe.mjs` 实测:同一个头连续打 10 次,
   * `x-ratelimit-used` 差 **0**;同装置的**无条件**对照打 10 次差 **10** ⇒
   * 仪器能看见计费,「没涨」才有意义)。没有这一层,通知轮询每轮 16 次请求
   * 就是 16 次**真**消耗;有了它,稳态是「16 次 round-trip、0 额度」。
   *
   * ⚠️ **304 不是错误**:`Response.ok` 对 304 是 `false`(它只认 200-299),
   * 所以下面在 `!res.ok` 之前**先**把 304 单独分出来返回,否则每一次
   * 「内容没变」都会被折成 `GithubApiError`(浏览器半会把整轮当失败)。
   * 与 204 一样,304 **没有响应体**,不许去 `res.json()`。
   *
   * @param input - 方法、路径(或完整 URL)、可选 body / Accept / 条件头。
   */
  async ghProxy(input: {
    method?: string;
    path: string;
    body?: unknown;
    accept?: string;
    /** `If-None-Match`:上一轮的 ETag。 */
    etag?: string;
    /** `If-Modified-Since`:上一轮的 `Last-Modified`(RFC 1123)。 */
    ifModifiedSince?: string;
  }): Promise<{
    status: number;
    json: unknown;
    link: string | null;
    remaining: number | null;
    /** 这一轮的 ETag,下一轮原样回传。 */
    etag: string | null;
    /** 这一轮的 `Last-Modified`,下一轮原样回传。 */
    lastModified: string | null;
  }> {
    const url = input.path.startsWith('http') ? input.path : `${this.endpoint()}${input.path}`;
    /** 用给定令牌把这次调用的头部拼出来(重试时要用**新**令牌重算,见 `fetchWithRenewal`)。 */
    const initFor = (current: string): RequestInit => {
      const headers: Record<string, string> = githubHeaders(current, input.accept ?? 'application/vnd.github+json');
      if (input.body !== undefined) headers['content-type'] = 'application/json';
      if (input.etag !== undefined) {
        headers['if-none-match'] = input.etag;
      }
      if (input.ifModifiedSince !== undefined) {
        headers['if-modified-since'] = input.ifModifiedSince;
      }
      return {
        method: input.method ?? 'GET',
        headers,
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      };
    };
    let res: Response;
    try {
      res = await this.fetchWithRenewal(url, initFor);
    } catch (error) {
      throw new GithubApiError(`GitHub 请求失败:${messageOf(error)}`, 502);
    }
    const remaining = res.headers.get('x-ratelimit-remaining');
    const resource = res.headers.get('x-ratelimit-resource');
    const remainingNumber = remaining === null ? null : Number(remaining);
    if (remainingNumber !== null && Number.isFinite(remainingNumber) && resource !== 'search') {
      this.lastRemaining = remainingNumber;
    }
    /*
     * 304 先返回:它不是错误(条件请求命中),而且**没有响应体**。
     * 仍然把两个验证器带回去 —— 304 通常也带 `etag`,下一轮可以继续用它。
     */
    if (res.status === 304) {
      return {
        status: 304,
        json: null,
        link: res.headers.get('link'),
        remaining: remainingNumber,
        etag: res.headers.get('etag'),
        lastModified: res.headers.get('last-modified'),
      };
    }
    let json: unknown = undefined;
    if (res.status !== 204) {
      json = await res.json().catch(() => null);
    }
    if (!res.ok) {
      const message = typeof json === 'object' && json !== null && typeof (json as { message?: unknown }).message === 'string'
        ? (json as { message: string }).message
        : `HTTP ${res.status}`;
      throw new GithubApiError(mapGithubMessage(res.status, message), res.status);
    }
    return {
      status: res.status,
      json,
      link: res.headers.get('link'),
      remaining: remainingNumber,
      etag: res.headers.get('etag'),
      lastModified: res.headers.get('last-modified'),
    };
  }

  /** 当前状态(含当前账号的端点)。 */
  async state(): Promise<AuthState> {
    const endpoint = this.endpoint();
    const token = this.deps.registry.githubToken();
    if (token !== '' && this.login === '') {
      // 进程重启后首次询问:用 /user 认一次身份,失败就当未登录。
      const user = await this.fetchLogin(token, endpoint);
      if (user !== null) this.login = user;
    }
    const tail = this.deps.registry.githubTokenTail();
    return {
      signedIn: tail !== '' && this.login !== '',
      login: this.login,
      tokenTail: tail,
      endpoint,
      deviceFlow: this.deps.clientId !== '',
      viaDeviceFlow: this.viaDeviceFlow,
    };
  }

  /**
   * 用**宿主令牌**拉当前账号的邮箱列表(GitHub `GET /user/emails`)。
   *
   * 为什么必须在 host 半做:浏览器半拿不到完整令牌({@link AuthState} 只有尾 4 位),
   * 而 `/user/emails` 需要 `user:email` 权限。上游 Desktop 是在渲染进程直接调的
   * (`references/desktop/app/src/lib/api.ts:1081-1090` 的 `fetchEmails`),我们没有
   * 那个条件。
   *
   * - **未登录 ⇒ `{ emails: [] }`,不是错误**(客户端据此不渲染邮箱下拉);
   * - 401 ⇒ `not-signed-in`;403/404 ⇒ `bad-request` + 可读文案
   *   (404 就是令牌缺 `user:email` 权限 —— GitHub 对无权限的这条端点回 404);
   *   网络错/其它 ⇒ 可读错误;
   * - **错误消息与日志里永不出现令牌**(本仓 `docs/token-storage.md` 的纪律)。
   */
  async accountEmails(): Promise<{ emails: AccountEmail[] }> {
    const state = await this.state();
    if (!state.signedIn) {
      return { emails: [] };
    }
    let res: Response;
    try {
      res = await this.fetchWithRenewal(`${state.endpoint}/user/emails`, (current) => ({
        headers: githubHeaders(current),
      }));
    } catch (error) {
      throw new GitServiceError('internal', `无法连接 ${state.endpoint} 读取账号邮箱:${messageOf(error)}`);
    }
    if (!res.ok) {
      throw accountEmailError(res.status, state.endpoint);
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    if (!Array.isArray(json)) {
      throw new GitServiceError('internal', `账号邮箱响应不是列表(${state.endpoint})。`);
    }
    const emails: AccountEmail[] = [];
    for (const raw of json) {
      if (typeof raw !== 'object' || raw === null) continue;
      const record = raw as Record<string, unknown>;
      const email = typeof record.email === 'string' ? record.email : '';
      if (email === '') continue;
      emails.push({
        email,
        verified: record.verified === true,
        primary: record.primary === true,
        visibility: typeof record.visibility === 'string' ? record.visibility : null,
      });
    }
    return { emails };
  }

  /**
   * 「这个 GitHub App 装到我的账号上了吗」—— 账号页那条安装引导的数据源。
   *
   * ## 为什么要问这一句
   *
   * GitHub App 的**授权**(设备码 / OAuth)与**安装**是两件事:授权只给出"你是谁 + 这个 App
   * 被授予了哪些权限",而**仓库访问**要求 App 被**安装**到对应账号/组织。实测(2026-11):
   * 授权成功后 `GET /user/installations` 仍会回 `total_count: 0`,此时仓库级端点一律 403
   * 且 GitHub 只回一句 `Resource not accessible by integration` —— 用户完全无从下手。
   *
   * ## 只在**确实有资格问**的时候问
   *
   * 判据全在 {@link installationStatusOf}:不是 App 令牌(PAT / OAuth App)**根本不发请求**
   * (那个端点对它们没有"安装"语义),查询失败一律归 `unknown`(不许把不确定说成"没安装")。
   * 请求本身打 `/user/installations`(用户级端点,**不需要**任何仓库权限,所以未安装时它也回 200)。
   *
   * @returns 见 {@link AuthInstallationStatus}。
   */
  public async installationStatus(): Promise<AuthInstallationStatus> {
    const appSlug = this.deps.appSlug ?? '';
    // 安装入口只在**内置 App** 时给:用户自带 App 的 slug 我们不知道,编一个链接等于骗人。
    const installUrl = appSlug === '' ? '' : `https://github.com/apps/${appSlug}/installations/new`;
    const token = this.deps.registry.githubToken();
    const base = {
      signedIn: token !== '',
      appUserToken: isGithubAppUserToken(token),
      installUrl,
    };
    if (!base.signedIn || !base.appUserToken) {
      return installationStatusOf({ ...base, httpStatus: null, totalCount: null });
    }
    try {
      const res = await this.fetchWithRenewal(`${this.endpoint()}/user/installations?per_page=1`, (current) => ({
        headers: githubHeaders(current),
      }));
      const json = await res.json().catch(() => null) as unknown;
      const totalCount =
        typeof json === 'object' && json !== null && typeof (json as { total_count?: unknown }).total_count === 'number'
          ? (json as { total_count: number }).total_count
          : null;
      return installationStatusOf({ ...base, httpStatus: res.status, totalCount });
    } catch (error) {
      this.deps.log?.(`[dsh-git] 查询 GitHub App 安装状态失败(不影响登录): ${messageOf(error)}`);
      return installationStatusOf({ ...base, httpStatus: null, totalCount: null });
    }
  }

  /**
   * git 子进程用的凭据环境。
   *
   * 用 `url.<token>@<host>/.insteadOf`(经 GIT_CONFIG_KEY/VALUE 环境变量注入,
   * 不进 argv、不进 .git/config 落盘)把 https 远端改写为带令牌的地址。
   * 这是 GitHub Actions 等 CI 的标准做法;SSH 远端不走它,交给用户的 SSH key。
   *
   * 端点默认时**行为与加端点之前逐字一致**(host 就是 `github.com`);登录到企业实例后
   * host 换成该实例的 HTML 主机(由 {@link gitCredentialHost} 从 API 基址反推),
   * 否则 push/pull 会拿着企业令牌去打 github.com。
   */
  credentialEnv(): Readonly<Record<string, string>> {
    const token = this.deps.registry.githubToken();
    // 无令牌时也必须禁掉交互提示:没有 tty 的 git 会报错或**挂住**等输入。
    // 其余凭据项只在有令牌时注入。
    if (token === '') return { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '' };
    const host = gitCredentialHost(this.endpoint());
    return {
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `url.https://x-access-token:${token}@${host}/.insteadOf`,
      GIT_CONFIG_VALUE_0: `https://${host}/`,
    };
  }

  // ---------- Device Flow(github.com 专用;企业端点只支持 PAT,见文件头) ----------

  async startDeviceFlow(): Promise<DeviceFlowStart> {
    if (this.deps.clientId === '') {
      /*
       * 这句会**直接显示在设备码面板里**(2026-11 起失败不再静默),所以它必须说清"缺什么"。
       * 走到这里只有两种情形:被某层显式写成 `off`,或这个构建里没有内置值
       * (见 `src/index.ts` 的 `BUILTIN_CLIENT_ID`)。⚠️ 不写任何具体 Client ID。
       */
      throw new GithubApiError(
        'host 未配置 Client ID(被显式关闭,或本构建未内置),无法使用设备码登录:'
        + '可设 DSH_GIT_CLIENT_ID 环境变量,或在 profile 的 cordis.patch.yml 里填 config.clientId。'
        + '(Personal Access Token 登录不受影响。)',
        400,
      );
    }
    const body = new URLSearchParams({ client_id: this.deps.clientId, scope: 'repo' });
    const res = await fetch(DEVICE_CODE_URL, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    const json = await res.json().catch(() => null) as Record<string, unknown> | null;
    if (!res.ok || json === null) {
      throw new GithubApiError(`无法启动设备码登录(HTTP ${res.status})。`, res.status);
    }
    const deviceCode = typeof json.device_code === 'string' ? json.device_code : '';
    const userCode = typeof json.user_code === 'string' ? json.user_code : '';
    if (deviceCode === '' || userCode === '') {
      throw new GithubApiError(`设备码登录响应缺少字段:${String(json.error ?? 'unknown')}`, 500);
    }
    return {
      deviceCode,
      userCode,
      verificationUri: typeof json.verification_uri === 'string' ? json.verification_uri : 'https://github.com/login/device',
      expiresIn: typeof json.expires_in === 'number' ? json.expires_in : 900,
      interval: typeof json.interval === 'number' ? json.interval : 5,
    };
  }

  async pollDeviceFlow(deviceCode: string): Promise<DeviceFlowPoll> {
    if (deviceCode === '') return { status: 'error', message: '缺少 device code。' };
    const res = await fetch(ACCESS_TOKEN_URL, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.deps.clientId,
        device_code: deviceCode,
        grant_type: DEVICE_GRANT,
      }),
    });
    const json = await res.json().catch(() => null) as Record<string, unknown> | null;
    if (json === null) return { status: 'error', message: `轮询失败(HTTP ${res.status})。` };
    /*
     * 用**共用**的解析器(与续期那一步同一个:`src/host/token-refresh.ts` 的
     * `parseTokenResponse`)—— 响应形状是同一套,解析只该有一处。
     */
    const parsed = parseTokenResponse(json);
    if (parsed.kind === 'ok') {
      /*
       * 先记**令牌形态**(会不会过期、有没有 refresh_token),再落盘 —— 理由见
       * `describeDeviceTokenShape()`:GitHub App 的用户令牌默认 8 小时过期,这一行是现场
       * 唯一能回答"要不要靠续期"的证据(续期本身见 `token-refresh.ts`)。
       */
      this.deps.log?.(`[dsh-git] 设备码登录拿到的令牌形态:${describeDeviceTokenShape(json)}`);
      await this.deps.registry.setGithubToken(parsed.accessToken);
      // 设备码流程**只可能**产出 github.com 的令牌(端点见文件头的 DEVICE_CODE_URL
      // 说明),所以这里把端点显式写回默认值 —— 否则「先登企业账号、再走设备码」
      // 会把 github.com 的令牌拿去打企业端点。
      await this.deps.registry.setGithubEndpoint(DEFAULT_GITHUB_ENDPOINT);
      /*
       * 把 refresh token 与有效期交给续期器(它写 `refs.GITHUB_REFRESH_TOKEN` 并排定时器)。
       * access token 上面已经写过了 —— 同一件事不许两处写。
       */
      await this.refresher?.acceptIssued({
        refreshToken: parsed.refreshToken,
        expiresInSec: parsed.expiresInSec,
      });
      this.viaDeviceFlow = true;
      const login = await this.fetchLogin(parsed.accessToken, DEFAULT_GITHUB_ENDPOINT);
      this.login = login ?? '';
      return { status: 'done', state: await this.state() };
    }
    const error = parsed.kind === 'error' ? parsed.error : '';
    if (error === 'authorization_pending') return { status: 'pending' };
    if (error === 'slow_down') {
      /*
       * ⚠️ **必须把 GitHub 给的新 `interval` 带出去**(2026-11 实测):
       * `slow_down` 的响应里就带着它(实测 10 → 15 → 20 …每次 +5),客户端据此退避。
       * 旧实现把这一支压成裸 `{slowDown:true}`、客户端又完全忽略它 ⇒ 客户端继续按原节奏打,
       * GitHub 每次都回 `slow_down` 并继续加码,**令牌永远不下发**(现场表现:已经授权但界面
       * 一直停在「等待授权」,磁盘上也没有令牌)。缺失时才由客户端按 +5 秒自增。
       */
      const next = typeof json.interval === 'number' && Number.isFinite(json.interval) ? json.interval : undefined;
      return next === undefined ? { status: 'pending', slowDown: true } : { status: 'pending', slowDown: true, interval: next };
    }
    if (error === 'expired_token') return { status: 'error', message: '设备码已过期,请重新登录。' };
    if (error === 'access_denied') return { status: 'error', message: '你取消了授权。' };
    return { status: 'error', message: `登录失败:${error || 'unknown'}` };
  }

  /**
   * 用 PAT 登录(校验后落盘)。
   * @param token - 令牌;`''` = 登出。
   * @param endpoint - GitHub **API 基址**(企业实例用,见
   *   {@link normalizeGithubEndpoint});省略 ⇒ 沿用**当前账号**的端点
   *   (令牌轮换不该改变账号身份),登出后已回到默认 `https://api.github.com`。
   */
  async setPat(token: string, endpoint?: string): Promise<AuthState> {
    const trimmed = token.trim();
    if (trimmed === '') {
      await this.logout();
      return this.state();
    }
    const resolved = normalizeGithubEndpoint(endpoint ?? this.deps.registry.githubEndpoint());
    const login = await this.fetchLogin(trimmed, resolved);
    if (login === null) {
      throw new GithubApiError(`Token 无效或缺少读取用户信息的权限(需要能访问 ${resolved}/user)。`, 401);
    }
    await this.deps.registry.setGithubToken(trimmed);
    await this.deps.registry.setGithubEndpoint(resolved);
    /*
     * PAT 没有续期可言 ⇒ 让续期器把上一枚 refresh token 与到期时间清掉。
     * 不清的后果很具体:8 小时后台上的 access token 还是那枚 PAT,而续期器会拿着
     * **上一个账号**的 refresh token 去换一枚新令牌,把 PAT 悄悄顶掉。
     */
    await this.refresher?.clear();
    this.viaDeviceFlow = false;
    this.login = login;
    return this.state();
  }

  /**
   * 登出:令牌与端点一起清掉。
   *
   * 端点不清的话,下一次不带 `endpoint` 的 PAT 登录会**沿用上一个账号的企业实例** ——
   * 也就是拿新令牌去打旧 host。清掉之后读回默认端点(`github.com`)。
   */
  async logout(): Promise<void> {
    await this.deps.registry.setGithubToken('');
    await this.deps.registry.setGithubEndpoint('');
    /*
     * 登出 = 「别再留我的令牌」:refresh token 与到期时间一起清掉(同一条语义,
     * 见 `TokenHome.write('')` 的注释)。
     */
    await this.refresher?.clear();
    this.login = '';
    this.viaDeviceFlow = false;
  }

  // ---------- 远程仓库列表 ----------

  /** 列出令牌可见的仓库(5 分钟缓存;按推送时间倒序,滤 archived)。 */
  async listRemoteRepos(force: boolean): Promise<RemoteRepoLite[]> {
    const token = this.deps.registry.githubToken();
    if (token === '') {
      // 用稳定错误码 rather than 靠文案判断;routes 据此把它记成 info 而非 warning。
      throw new GitServiceError('not-signed-in', '未登录 GitHub,无法列出远程仓库。');
    }
    if (!force) {
      const cached = this.deps.registry.cachedRemoteRepos(REMOTE_CACHE_MS);
      if (cached !== null) return cached;
    }
    const repos: RemoteRepoLite[] = [];
    for (let page = 1; page <= 5; page++) {
      const url = `${this.endpoint()}/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member&page=${page}`;
      const res = await this.fetchWithRenewal(url, (current) => ({ headers: githubHeaders(current) }));
      if (!res.ok) {
        if (res.status === 401) throw new GithubApiError('Token 已失效,请重新登录。', 401);
        throw new GithubApiError(`列出远程仓库失败(HTTP ${res.status})。`, res.status);
      }
      const json = await res.json().catch(() => null) as unknown;
      if (!Array.isArray(json)) break;
      for (const raw of json) {
        if (typeof raw !== 'object' || raw === null) continue;
        const record = raw as Record<string, unknown>;
        if (record.archived === true) continue;
        const fullName = typeof record.full_name === 'string' ? record.full_name : '';
        if (fullName === '') continue;
        repos.push({
          fullName,
          isPrivate: record.private === true,
          pushedAt: typeof record.pushed_at === 'string' ? record.pushed_at : '',
          ...(typeof record.description === 'string' && record.description !== ''
            ? { description: record.description }
            : {}),
        });
      }
      if (json.length < 100) break;
    }
    // 本地已有同名的,列表里也能对上(界面据此显示「已关联」)。
    await this.deps.registry.setRemoteRepos(repos);
    return repos;
  }

  // ---------- 内部 ----------

  /**
   * 当前账号的端点(存储 → 默认)。
   *
   * 每次现读而不缓存:端点随登录变化(企业实例 ⇄ github.com),缓存会让
   * 「刚切到企业实例」的下一个请求还打在旧 host 上。
   */
  private endpoint(): string {
    return this.deps.registry.githubEndpoint();
  }

  /**
   * 带**一次**自动续期的取数:401 ⇒ 让 {@link AuthDeps.renewToken} 换新令牌 ⇒ 用新令牌重试一次。
   *
   * ## 为什么是"一次"
   *
   * 重试一次足够覆盖"令牌刚过期"这个唯一的正常场景;再多就是拿失效凭据反复打 GitHub
   * (而且 401 也意味着别的坏事,反复重试只会把真正的错因埋掉)。
   *
   * ## 为什么头部要用回调重建
   *
   * 重试时必须用**新**令牌重新算 `Authorization`(以及调用方那些 `if-none-match` /
   * `content-type`),所以这里接的是一个 `(token) => RequestInit` 工厂,而不是一个现成的 init。
   *
   * @param url - 完整 URL。
   * @param init - 用给定令牌构造请求头/体。
   * @returns 响应(**没有**续期可用时就是第一次的响应,原样交给上层判 401)。
   */
  private async fetchWithRenewal(
    url: string,
    init: (token: string) => RequestInit,
  ): Promise<Response> {
    const token = this.deps.registry.githubToken();
    const res = await fetch(url, init(token));
    if (res.status !== 401 || this.refresher === null) {
      return res;
    }
    const renewed = await this.refresher.refreshNow();
    if (!renewed) {
      return res;
    }
    this.deps.log?.('[dsh-git] 令牌已过期,自动续期后用新令牌重试这一次请求。');
    return await fetch(url, init(this.deps.registry.githubToken()));
  }

  private async fetchLogin(token: string, endpoint: string): Promise<string | null> {
    try {
      const res = await this.fetchWithRenewal(`${endpoint}/user`, (current) => ({
        headers: githubHeaders(current),
      }));
      if (!res.ok) return null;
      const json = await res.json().catch(() => null) as { login?: unknown } | null;
      return typeof json?.login === 'string' ? json.login : null;
    } catch (error) {
      this.deps.log?.(`[dsh-git] 校验 GitHub 身份失败: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }
}

/**
 * `/user/emails` 的失败分类 → 可读错误。
 *
 * 404 是**最常见的一种**,而且原因固定:GitHub 对**没有 `user:email` 权限**的令牌
 * 在这条端点上回 404(不是 403)。文案里必须说出来,否则用户只会看到「找不到」。
 * **永不包含令牌**。
 * @param status - HTTP 状态码。
 * @param endpoint - 打的是哪个端点(排查企业实例用;不是秘密)。
 */
function accountEmailError(status: number, endpoint: string): GitServiceError {
  if (status === 401) {
    return new GitServiceError('not-signed-in', 'Token 已失效,请重新登录。');
  }
  if (status === 403) {
    return new GitServiceError('bad-request', '没有权限读取账号邮箱(可能被组织策略 / SAML 授权限制)。');
  }
  if (status === 404) {
    return new GitServiceError(
      'bad-request',
      '读不到账号邮箱:令牌缺少 user:email 权限(生成令牌时请勾上 "Email addresses: read",经典令牌勾 user:email)。',
    );
  }
  return new GitServiceError('internal', `读取账号邮箱失败(HTTP ${status},端点 ${endpoint})。`);
}

/**
 * GitHub 错误 → 可操作中文提示。
 *
 * 导出是给探针用的(纯函数,判据只此一处):每一条都要能在离线用例里钉住。
 * @param status - HTTP 状态码。
 * @param upstream - GitHub 回的 `message` 原文。
 */
export function mapGithubMessage(status: number, upstream: string): string {
  if (status === 401) return 'Token 无效或已过期,请在设置里重新登录。';
  if (status === 403 && /rate limit/i.test(upstream)) return 'GitHub 限额用尽,请稍后再试。';
  if (status === 403 && /resource not accessible by integration/i.test(upstream)) {
    /*
     * GitHub App 的"授权 ≠ 安装"(2026-11 现场):未安装时 GitHub 只回这一句,不解释也不给下一步。
     * 这里补上**可操作**的三条(按现场出现频率排):没安装 / 权限没勾全 / 改过权限还没重新授权,
     * 外加最容易漏的第 4 条:装是装了、但**安装范围不含这个仓库**。
     * ⚠️ 文案里不许出现具体 Client ID 或 App 名字(用户可能自带 App);安装入口由账号页那条
     * 引导给(见 `installationStatus()`),那里才知道 slug。
     */
    return '这个 App 没有权限访问该资源(Resource not accessible by integration):'
      + '最常见的原因是它还没被"安装"到对应账号/仓库 —— GitHub App 的「授权」和「安装」是两件事;'
      + '其次要确认 App 的权限勾全了、改过权限之后重新登录授权过一次、且安装范围包含这个仓库。';
  }
  if (status === 403) return `没有权限执行该操作:${upstream}`;
  if (status === 404) return '找不到该资源(可能是私有仓未授权,或已被删除)。';
  if (status === 422) return `请求被 GitHub 拒绝:${upstream}`;
  return upstream;
}
