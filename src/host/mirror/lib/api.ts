/**
 * **dsh-git 手写替身(host 半)** —— 上游 `lib/api.ts`(2,499 行的 GitHub REST 客户端)。
 *
 * ## 为什么宿主半要有这一份
 *
 * 宿主半**一个 GitHub REST 请求都不发**(认证在 DSH 的 provider 里、仓库数据面在
 * `src/host/repo-registry.ts`),但上游**不是**按这个边界分层的:
 * `models/account.ts:1`、`models/owner.ts:1`、`models/dot-com-bots.ts:1`、
 * `models/publish-settings.ts:1`、`lib/repository-matching.ts:6` 都直接
 * `from '../lib/api'` / `'./api'` —— 而 `models/account.ts` 是 `Repository` 的
 * 传递依赖,`Repository` 是 `GitStore` 的构造参数 ⇒ **只要接线 git-store,
 * api.ts 就必然进入宿主的模块图**。
 *
 * 上游那一份的闭包在宿主半**没有落点**:`./copilot-commit-message`、
 * `./copilot-error`(`@github/copilot-sdk`)、`./http` → `../ui/lib/app-proxy`(Electron)、
 * `./suppress-certificate-error`(Electron `session`)、
 * `../ui/secret-scanning/bypass-push-protection-dialog`(React 对话框)。
 * 实测:esbuild **不会**因为「只用三个导出」就把它们树摇掉 —— 未解析的 import
 * 直接**构建失败**(`Could not resolve "./http"` 等 5 条)。
 *
 * ## 本替身与 `src/core/desktop/lib/api.ts`(client 根的同类替身)的关系
 *
 * **同因、同形、各自独立**:client 根那份是 2026-10-07 为「仓库列表不需要网络」
 * 写的(632 行,`verify-mirror` 的 `EXPECTED` 有它);宿主这份是 2026-10-08 为
 * 「git 编排层不经过 REST」写的。两份**都不能**合并 ——
 * 合并就是跨根 import,而「host→client 的跨根 import = 0」是一条现有读数。
 * 它们的**分工**也不同:client 那份必须让 CI/check-runs 那几个面**真能调用**
 * (它带一个可注入的 `IGitHubTransport`);宿主这份**没有任何调用方**,
 * 所以它的 REST 面**刻意不实现**。
 *
 * ## 哪些是逐字真的、哪些是 `any`(逐条,别混)
 *
 * | 面 | 这一份 |
 * |---|---|
 * | `getHTMLURL` / `getEnterpriseAPIURL` / `getDotComAPIEndpoint` / `getAPIEndpoint` / `getEndpointForRepository` / `getAccountForEndpoint` | **逐字取自上游**(`lib/api.ts:2273-2355`),`isDotCom`/`isGHE` 用**逐字镜像的** `./endpoint-capabilities`(它自带 semver 版本表) |
 * | `GitHubAccountType` / `APICheckConclusion` | 按上游的**值**声明(见下),既能当类型也能当值 |
 * | `MaxResultsError` | 逐字(`class MaxResultsError extends Error {}`) |
 * | `API` 与全部 `IAPI*` 类型 | **`any` 别名** —— 上游那 2,499 行里绝大部分是它们。这不是新造的静默:接线之前它们**本来就是 `any`**(模块找不到 ⇒ TS2307 + `any`) |
 * | `fetchUser` / `deleteToken` / `requestOAuthToken` / `getOAuthAuthorizationURL` | **抛错**(宿主没有 OAuth / token 池)。刻意**不**返回空值:那会把「没接」伪装成「做成了」 |
 *
 * ⚠️ **`any` 那一档是这条线上最大的一处诚实缺口**:凡是经 `models/account.ts`
 * 进入宿主程序的 GitHub 面(账户、组织、PR、Issue 的类型)**都没有类型检查**。
 * 它**不减少**任何既有信号(接线前同样是 `any`),但它意味着
 * 「宿主半的 GitHub 面是类型干净的」这句话**今天不成立**。
 * 退役条件:宿主真的接 GitHub REST(那时换成真实现或真依赖)的那一天。
 *
 * @module dsh-git/host-mirror/lib/api
 */

// ⚠️ 命名成 `NodeUrl`:全局的 `URL`(WHATWG)在这一份里要用(上游那句
// `new window.URL(...)`),而 `import * as URL from 'url'` 会把全局的 `URL` **遮住**
// ⇒ `new URL(x)` 变成「对命名空间做 new」,TS2351。
import * as NodeUrl from 'url';
import { Account } from '../models/account';
import {
  getEndpointVersion,
  isDotCom,
  isGHE,
  updateEndpointVersion,
} from './endpoint-capabilities';

/**
 * 上游 `lib/api.ts:319` 的 `MaxResultsError`,逐字。
 */
export class MaxResultsError extends Error {}

/**
 * 上游 `lib/api.ts:326` 的 `EmailVisibility`(type-only,上游也是 type)。
 */
export type EmailVisibility = 'public' | 'private' | null;

/**
 * 上游的 `GitHubAccountType`。上游那份在 `models/owner.ts` 侧被当**值**用,
 * 所以这里声明成「值 + 同名类型」。
 */
export enum GitHubAccountType {
  User = 'User',
  Organization = 'Organization',
}

/**
 * 上游 `lib/api.ts:350-354` 的 `APICheckStatus`,值逐字。
 *
 * ⚠️ **2026-10-08 补齐**:本替身原来漏了这个名字,而 `APICheckStatus` 是
 * **运行期用的 enum**(`lib/ci-checks/ci-checks.ts` 里 `APICheckStatus.Completed`
 * 这类成员访问有 10 处)⇒ 不能像 `IAPI*` 载荷那样退化成 `any`,必须逐字搬值。
 * 漏它的原因不是裁决,是**替身抄得不全**:上一条 `APICheckConclusion` 抄了,
 * 紧挨着它上一条的这个没抄。`ci-checks.ts` 逐字复制进 host 根时暴露出来
 * (client 根那份替身有它 ⇒ 客户端程序里看不出来)。
 */
export enum APICheckStatus {
  Queued = 'queued',
  InProgress = 'in_progress',
  Completed = 'completed',
}

/**
 * 上游 `lib/api.ts:357-366` 的 `APICheckConclusion`,值逐字。
 */
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

/**
 * GitHub.com 的 API 端点。上游 `lib/api.ts:2336-2347`,逐字
 * (含 `DESKTOP_GITHUB_DOTCOM_API_ENDPOINT` 那个开发用覆盖口)。
 *
 * @returns API 端点 URL。
 */
export function getDotComAPIEndpoint(): string {
  const envEndpoint = process.env['DESKTOP_GITHUB_DOTCOM_API_ENDPOINT'];
  if (envEndpoint !== undefined && envEndpoint.length > 0) {
    return envEndpoint;
  }
  return 'https://api.github.com';
}

/**
 * 把一个 **HTML** URL 折成 **API** URL。上游 `lib/api.ts:2273-2280`,逐字。
 *
 * @param url - HTML URL(`https://github.com/…` 或 GHES 的站点 URL)。
 * @returns API 端点 URL。
 */
export function getEndpointForRepository(url: string): string {
  const parsed = NodeUrl.parse(url);
  if (parsed.hostname === 'github.com') {
    return getDotComAPIEndpoint();
  }
  return `${parsed.protocol}//${parsed.hostname}/api`;
}

/**
 * 把一个 **API** endpoint 折成 **HTML** URL。上游 `lib/api.ts:2288-2316`,逐字
 * (唯一改动:上游那句 `new window.URL(...)` 在宿主半写成 `new URL(...)` ——
 * node 里 `window` 不存在,而 `URL` 是全局)。
 *
 * @param endpoint - API endpoint(`https://api.github.com` / GHES 的 `.../api/v3`)。
 * @returns HTML 站点 URL。
 */
export function getHTMLURL(endpoint: string): string {
  const envHTMLURL = process.env['DESKTOP_GITHUB_DOTCOM_HTML_URL'];
  if (envHTMLURL !== undefined) {
    return envHTMLURL;
  }

  if (
    endpoint === getDotComAPIEndpoint() &&
    process.env['DESKTOP_GITHUB_DOTCOM_API_ENDPOINT'] === undefined
  ) {
    return 'https://github.com';
  }

  if (isGHE(endpoint)) {
    const url = new URL(endpoint);
    url.pathname = '/';
    if (url.hostname.startsWith('api.')) {
      url.hostname = url.hostname.replace(/^api\./, '');
    }
    return url.toString();
  }

  const parsed = NodeUrl.parse(endpoint);
  return `${parsed.protocol}//${parsed.hostname}`;
}

/**
 * 把 **HTML** URL 折成 GHES 的 API URL。上游 `lib/api.ts:2326-2330`,逐字。
 *
 * @param endpoint - HTML 站点 URL。
 * @returns API 端点 URL。
 */
export function getEnterpriseAPIURL(endpoint: string): string {
  const { host } = new URL(endpoint);
  return isGHE(endpoint) ? `https://api.${host}/` : `https://${host}/api/v3`;
}

/**
 * 上游 `lib/api.ts:2332-2333` 的 `getAPIEndpoint`,逐字。
 *
 * @param endpoint - API 或 HTML 端点。
 * @returns 规范化后的 API 端点。
 */
export const getAPIEndpoint = (endpoint: string): string =>
  isDotCom(endpoint) ? getDotComAPIEndpoint() : getEnterpriseAPIURL(endpoint);

/**
 * 上游 `lib/api.ts:2350-2355`,逐字。
 *
 * @param accounts - 已知账号。
 * @param endpoint - 待匹配的 endpoint。
 * @returns 匹配的账号,或 null。
 */
export function getAccountForEndpoint(
  accounts: ReadonlyArray<Account>,
  endpoint: string
): Account | null {
  return accounts.find(a => a.endpoint === endpoint) || null;
}

/** 宿主半**没有** OAuth / token 池,所以这几个一律抛错(见文件头表格)。 */
function unsupported(capability: string): Error {
  return new Error(
    `dsh-git host:lib/api.ts 的 GitHub ${capability} 在宿主半不可用` +
      '(宿主半不发任何 GitHub REST 请求;见 src/host/mirror/lib/api.ts 的文件头)。'
  );
}

/**
 * 上游 `lib/api.ts` 的 OAuth 授权 URL 构造 —— 宿主半没有 OAuth,**抛错**。
 *
 * @param _endpoint - API endpoint。
 * @param _state - OAuth state。
 * @returns 永不返回。
 */
export function getOAuthAuthorizationURL(
  _endpoint: string,
  _state: string
): string {
  throw unsupported('OAuth 授权');
}

/**
 * 上游 `lib/api.ts:2370` 的令牌交换 —— 宿主半没有 OAuth,**抛错**。
 *
 * ⚠️ **签名修正(2026-10-08)**:本替身原来写的是 `requestOAuthToken(_code)`,
 * 而上游是 `requestOAuthToken(endpoint, code)`。那是**我们写错了**,不是刻意偏离:
 * 上游唯一的调用方 `lib/stores/sign-in-store.ts:357` 传的是
 * `(endpoint, action.code)`,于是这个替身让**上游自己逐字的那一行**报
 * TS2554「Expected 1 arguments, but got 2」。改成上游的形参表之后,调用面
 * 一个字节都不用动。**返回类型也照上游**:`Promise<string | null>`
 * (上游失败时 `return null`;调用方 `sign-in-store.ts:357-362` 正是按 null 处理的)。
 *
 * @param _endpoint - API endpoint(宿主半不用)。
 * @param _code - 授权码(宿主半不用)。
 * @returns 永不返回(拒绝)。
 */
export function requestOAuthToken(
  _endpoint: string,
  _code: string
): Promise<string | null> {
  return Promise.reject(unsupported('OAuth 令牌交换'));
}

/**
 * 上游 `lib/api.ts:2214` 的令牌删除 —— 宿主半的令牌在 DSH 的凭据服务里,**抛错**。
 *
 * ⚠️ **签名修正(2026-10-08)**:本替身原来写的是 `deleteToken(_endpoint, _token)`,
 * 而上游是 `deleteToken(account: Account)`(按**账户**删,不按裸字符串)。
 * 上游唯一的调用方 `lib/stores/app-store.ts:8145` 传的是 `deleteToken(account)`,
 * 于是这个替身让**上游自己逐字的那一行**报 TS2554「Expected 2 arguments, but got 1」。
 * 改成上游的形参表之后,调用面一个字节都不用动。**返回类型照上游**:
 * `Promise<boolean>`(上游 `response.status === 204`,失败 `false`);
 * 本替身**拒绝**而不是返回 `false` —— 那一条偏离不变(见文件头)。
 *
 * @param _account - 要删除令牌的账户(宿主半不用)。
 * @returns 永不返回(拒绝)。
 */
export function deleteToken(_account: Account): Promise<boolean> {
  return Promise.reject(unsupported('令牌删除'));
}

/**
 * 上游 `lib/api.ts:1237` 的 `fetchUser` —— 宿主半**抛错**。
 *
 * @param _endpoint - API endpoint。
 * @param _token - 令牌。
 * @returns 永不返回。
 */
export function fetchUser(_endpoint: string, _token: string): Promise<never> {
  return Promise.reject(unsupported('用户查询'));
}

/**
 * 上游的 REST 客户端类。
 *
 * ⚠️ 宿主半**刻意不实现它的方法**:它没有调用方,而一份「看起来实现了、
 * 其实返回空」的客户端正是本仓反复付学费的假绿。所以整个值就是 `any` ——
 * 与接线前(模块找不到 ⇒ `any`)**一致**,不减少任何既有类型信息。
 */
export const API: any = {
  /**
   * 上游 `lib/api.ts:842` 的 `API.fromAccount`。
   *
   * @param _account - 账号。
   * @returns 永不返回(宿主半没有 REST 客户端)。
   */
  fromAccount: (_account: Account): never => {
    throw unsupported('客户端');
  },
};

/**
 * 见 {@link API}。
 *
 * ⚠️ `API` **同时**是值与类型,这是上游的形状(上游是一个 `class`,而 class 自带
 * 两个名字空间)。本替身刻意**不用** class:host 半不实现任何方法,一个空壳 class
 * 只会让调用方以为它在(REST 面在文件头表格里写明了是 `any`)。
 *
 * 代价:`const` + `type` 同名会撞 `@typescript-eslint/no-redeclare`
 * (该规则的 `ignoreDeclarationMerge` 只认 enum/namespace 那几种合并)。
 * 所以这一处**显式豁免并写明理由** —— 不是为了让闸门变绿,而是因为
 * 「同名值+类型」在这里是**唯一**能同时满足 `API.fromAccount(...)`(值用法)
 * 与 `api: API`(`lib/stores/pull-request-store.ts:106`,类型用法)的写法。
 */
// eslint-disable-next-line @typescript-eslint/no-redeclare -- 见上:`API` 必须同时是值与类型(上游是 class,自带两个名字空间)。
export type API = any;

/*
 * ---------------------------------------------------------------------------
 * 其余导出:**按 `any` 声明**(见文件头表格最后两行)
 *
 * 它们全部是「接线前本来就是 `any`」的名字 —— 上游那份文件在宿主里找不到时,
 * 所有这些名字都是 `any`。这里逐字保留**名字**,不假装有形状。
 * ---------------------------------------------------------------------------
 */

/** 上游 `lib/api.ts:331` 的用户邮箱载荷。 */
export type IAPIEmail = any;
/** 上游 `lib/api.ts` 的仓库载荷。 */
export type IAPIRepository = any;
/** 上游 `lib/api.ts` 的完整仓库载荷。 */
export type IAPIFullRepository = any;
/** 上游 `lib/api.ts` 的身份载荷。 */
export type IAPIIdentity = any;
/** 上游 `lib/api.ts` 的分支载荷。 */
export type IAPIBranch = any;
/** 上游 `lib/api.ts` 的评论载荷。 */
export type IAPIComment = any;
/** 上游 `lib/api.ts` 的 Issue 载荷。 */
export type IAPIIssue = any;
/** 上游 `lib/api.ts` 的组织载荷。 */
export type IAPIOrganization = any;
/** 上游 `lib/api.ts` 的 PR 载荷。 */
export type IAPIPullRequest = any;
/**
 * 上游 `lib/api.ts:650` 的 PR review 载荷。
 *
 * 补这一条(2026-10-08,通知切片)的理由:`lib/valid-notification-pull-request-review.ts`
 * 是**逐字镜像**进来的(上游 25 行),它唯一 import 的就是这个名字;而它被
 * `lib/stores/{notifications-store,notifications-debug-store}.ts` 与 `app-store.ts`
 * 三处引用。不补 ⇒ 镜像里那个文件自带 1 条 TS2724 新诊断(棘轮里就是一次「新文件诊断」回归)。
 * 加在这里而不是给它写偏离:本替身的口径本来就是「REST 面按 `any` 声明」
 * (见上方注释与 `scripts/verify-mirror.mjs` 的 HOST_EXPECTED `lib/api.ts` 条目)。
 */
export type IAPIPullRequestReview = any;
/** 上游 `lib/api.ts` 的仓库规则集。 */
export type IAPIRepoRuleset = any;
/** 上游 `lib/api.ts` 的仓库规则集(瘦)。 */
export type IAPISlimRepoRuleset = any;
/** 上游 `lib/api.ts` 的推送保护绕过载荷。 */
export type IAPICreatePushProtectionBypassResponse = any;
/** 上游 `lib/api.ts` 的 check suite 载荷。 */
export type IAPICheckSuite = any;
/** 上游 `lib/api.ts` 的 check runs 载荷。 */
export type IAPIRefCheckRuns = any;
/** 上游 `lib/api.ts` 的 workflow run 载荷。 */
export type IAPIWorkflowRun = any;
/** 上游 `lib/api.ts` 的 workflow job 载荷。 */
export type IAPIWorkflowJob = any;
/**
 * 上游 `lib/api.ts:450` 的 workflow jobs 载荷(复数形态)。
 *
 * ⚠️ **2026-10-08 补齐**:与 `APICheckStatus` 同一批、同一个原因 —— 替身漏抄了
 * 上游这一个名字,而 `lib/ci-checks/ci-checks.ts:10` 逐字 import 它
 * (`Map<number, IAPIWorkflowJobs | null>`)。它在替身里**只作类型用**,所以与
 * 周围 30 多个 `IAPI*` 一样记成 `any`(不动那条既定策略)。
 */
export type IAPIWorkflowJobs = any;
/** 上游 `lib/api.ts` 的 workflow job step 载荷。 */
export type IAPIWorkflowJobStep = any;
/** 上游 `lib/api.ts` 的 ref status 载荷。 */
export type IAPIRefStatus = any;
/** 上游 `lib/api.ts` 的 ref status item 载荷。 */
export type IAPIRefStatusItem = any;
/** 上游 `lib/api.ts` 的 push control 载荷。 */
export type IAPIPushControl = any;
/** 上游 `lib/api.ts` 的 check run 载荷。 */
export type IAPIRefCheckRun = any;
/** 上游 `lib/api.ts` 的 check suite 载荷(复数形态,`models/popup.ts` 用)。 */
export type IAPICheckSuites = any;

/*
 * 下面这几个是上游**同一个文件里以值出现**的名字(endpoint 版本一族的转发),
 * 逐字转发给 `./endpoint-capabilities`。
 */
export { getEndpointVersion, isDotCom, isGHE, updateEndpointVersion };
