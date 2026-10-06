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

/** Device Flow 轮询结果。 */
export type DeviceFlowPoll =
  | { status: 'pending'; slowDown?: boolean }
  | { status: 'done'; state: AuthState }
  | { status: 'error'; message: string };

export interface AuthDeps {
  registry: RepoRegistry;
  /** OAuth App Client ID;缺省 = 不提供设备码登录。 */
  clientId: string;
  log?: (message: string) => void;
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

export class GithubAuth {
  private login = '';
  private viaDeviceFlow = false;
  /** 最近一次 GitHub 响应的 core 限额剩余(页脚展示)。 */
  private lastRemaining: number | null = null;

  constructor(private readonly deps: AuthDeps) {}

  rateRemaining(): number | null {
    return this.lastRemaining;
  }

  /**
   * 代理一次 GitHub REST 调用:令牌留在 host,浏览器不接触它,
   * 顺带绕开 CORS 与匿名限额。
   * @param input - 方法、路径(或完整 URL)、可选 body 与 Accept。
   */
  async ghProxy(input: {
    method?: string;
    path: string;
    body?: unknown;
    accept?: string;
  }): Promise<{ status: number; json: unknown; link: string | null; remaining: number | null }> {
    const token = this.deps.registry.githubToken();
    const url = input.path.startsWith('http') ? input.path : `${this.endpoint()}${input.path}`;
    const headers: Record<string, string> = githubHeaders(token, input.accept ?? 'application/vnd.github+json');
    if (input.body !== undefined) headers['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await fetch(url, {
        method: input.method ?? 'GET',
        headers,
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      });
    } catch (error) {
      throw new GithubApiError(`GitHub 请求失败:${messageOf(error)}`, 502);
    }
    const remaining = res.headers.get('x-ratelimit-remaining');
    const resource = res.headers.get('x-ratelimit-resource');
    const remainingNumber = remaining === null ? null : Number(remaining);
    if (remainingNumber !== null && Number.isFinite(remainingNumber) && resource !== 'search') {
      this.lastRemaining = remainingNumber;
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
    return { status: res.status, json, link: res.headers.get('link'), remaining: remainingNumber };
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
    const token = this.deps.registry.githubToken();
    let res: Response;
    try {
      res = await fetch(`${state.endpoint}/user/emails`, { headers: githubHeaders(token) });
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
      throw new GithubApiError('host 未配置 GitHub OAuth App Client ID,无法使用设备码登录。', 400);
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
    const token = typeof json.access_token === 'string' ? json.access_token : '';
    if (token !== '') {
      await this.deps.registry.setGithubToken(token);
      // 设备码流程**只可能**产出 github.com 的令牌(端点见文件头的 DEVICE_CODE_URL
      // 说明),所以这里把端点显式写回默认值 —— 否则「先登企业账号、再走设备码」
      // 会把 github.com 的令牌拿去打企业端点。
      await this.deps.registry.setGithubEndpoint(DEFAULT_GITHUB_ENDPOINT);
      this.viaDeviceFlow = true;
      const login = await this.fetchLogin(token, DEFAULT_GITHUB_ENDPOINT);
      this.login = login ?? '';
      return { status: 'done', state: await this.state() };
    }
    const error = typeof json.error === 'string' ? json.error : '';
    if (error === 'authorization_pending') return { status: 'pending' };
    if (error === 'slow_down') return { status: 'pending', slowDown: true };
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
      const res = await fetch(url, { headers: githubHeaders(token) });
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

  private async fetchLogin(token: string, endpoint: string): Promise<string | null> {
    try {
      const res = await fetch(`${endpoint}/user`, { headers: githubHeaders(token) });
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

/** GitHub 错误 → 可操作中文提示。 */
function mapGithubMessage(status: number, upstream: string): string {
  if (status === 401) return 'Token 无效或已过期,请在设置里重新登录。';
  if (status === 403 && /rate limit/i.test(upstream)) return 'GitHub 限额用尽,请稍后再试。';
  if (status === 403) return `没有权限执行该操作:${upstream}`;
  if (status === 404) return '找不到该资源(可能是私有仓未授权,或已被删除)。';
  if (status === 422) return `请求被 GitHub 拒绝:${upstream}`;
  return upstream;
}
