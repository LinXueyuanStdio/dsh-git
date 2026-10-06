/**
 * **冻结的 host 路由的客户端单点适配层**(本轮四个新功能全都经这里取数)。
 *
 * ## 为什么要有这一层,而不是各处直接 `api.xxx()`
 *
 * 本轮的四个功能(Notifications / 全局 gitconfig 链接 + 锁文件 / 多企业账号 / 账号邮箱)
 * 依赖 host 半新增的四条路由。它们的接口形状在 `src/client/api.ts` 里已经落地
 * (本文件写完之后核对过,**逐字对得上**):
 *
 * | 成员 | `api.ts` 位置 | 形状 |
 * |---|---|---|
 * | `api.accountEmails()` | `:528-530` | `call<{ emails: { email; verified; primary; visibility: string \| null }[] }>('auth/emails')`;**未登录 ⇒ 空数组(不是错误)** |
 * | `api.gitConfigFileInfo()` | `:490-495` | `call<{ path: string \| null; exists: boolean; lockPath: string \| null; lockExists: boolean }>('config-file-info')` |
 * | `api.openGitConfigFile()` | `:498` | `call<{ ok: true }>('config-file-open')`;**不存在 ⇒ bad-request** |
 * | `api.setPat(token, endpoint?)` | `:522-523` | 第二个参数是端点 |
 * | `AuthStatePayload.endpoint` | `:584` | **必填字段**,但注释明写「老 host 不返回」 |
 *
 * 既然接口已在,这一层就不再是「等 host 线」的临时脚手架,而是三件**别人不该各写一遍**
 * 的事:
 *
 *  1. **把「路由失败」翻成调用方要用的话**。`call()` 把传输错误、404(老 host)、
 *     业务错误统一成 `ApiResult.error`;`config-file-open` 的 `bad-request` 更是
 *     **可预期的用户状态**(还没配过全局 gitconfig),必须单独一档,否则界面会把
 *     「你还没配过」说成「出错了」。
 *  2. **端点的规范化与比较**。host 会把企业 HTML 地址归一化成 API 基址
 *     (`api.ts:517-519` 原话:`https://ghe.example.com` ⇒ `<host>/api/v3`),
 *     所以「用户填的」与「宿主回报的」**字面不相等是正常的** ——
 *     逐字比较会造出一堆假警报。判据见 {@link sameEndpointInstance}。
 *  3. **`visibility` 的收窄**(见 {@link toDesktopApiMail})。
 *
 * @see src/client/account-emails.tsx —— 端点与邮箱的消费方
 * @see src/client/git-config-links.tsx —— gitconfig 两个路由的消费方
 * @module dsh-git/client/host-api-bridge
 */

import { api } from './api.ts';
import type { AuthStatePayload } from './api.ts';
import { narrowed } from './payload.ts';
import type { Shape } from './payload.ts';
import { getDotComAPIEndpoint } from '../core/desktop/lib/api.ts';
import { isDotCom } from '../core/desktop/lib/endpoint-capabilities.ts';

/**
 * 一条账号邮箱。字段与 `api.ts:528-530` 的内联类型**逐字相同**。
 *
 * ⚠️ `visibility` 在宿主侧是 `string | null`(上游 `IAPIEmail` 是
 * `'public' | 'private' | null`,但企业版旧版可能给别的值)。消费方要按
 * `'public' | 'private' | null` **收窄**再用 —— 见 {@link toDesktopApiMail}。
 */
export interface IAccountEmail {
  readonly email: string;
  readonly verified: boolean;
  readonly primary: boolean;
  readonly visibility: string | null;
}

/** `config-file-info` 的载荷(全局 gitconfig 的路径/存在性/锁文件)。 */
export interface IGitConfigFileInfo {
  /** 全局 gitconfig 的绝对路径;`null` = 宿主解析不出来。 */
  readonly path: string | null;
  /** 那个文件是否**存在**。 */
  readonly exists: boolean;
  /** 锁文件路径(约定为 `<path>.lock`);`null` = 宿主没给出。 */
  readonly lockPath: string | null;
  /** 锁文件是否**存在**(存在 ⇒ 写配置会失败,上游 `ConfigLockFileExists` 的场景)。 */
  readonly lockExists: boolean;
}

// ---------------------------------------------------------------------------
// 账号邮箱
// ---------------------------------------------------------------------------

/** `auth/emails` 的载荷(`api.accountEmails()` 的 `value`)。 */
interface IAccountEmailsPayload {
  readonly emails: ReadonlyArray<IAccountEmail>;
}

/** `auth/emails` 的形状说明(与 `api.ts` 的 `SHAPES['auth/emails']` 同义,见上面注释)。 */
const ACCOUNT_EMAILS_SHAPE: Shape = {
  record: {
    emails: {
      array: {
        record: { email: 'string', verified: 'boolean', primary: 'boolean', visibility: 'string|null' },
      },
    },
  },
};

/**
 * `auth/emails` 的结果。
 *
 * **两态而非三态**:「未登录」由 host 如实表达成**空数组**(冻结接口原话),
 * 所以它落在 `ok` 那一边、由消费方按「0 条已验证邮箱 ⇒ 不渲染下拉」处理;
 * `error` 只留给真正的失败(网络断了 / 老 host 没有这条路由 / 令牌失效)。
 * 把「未登录」塞进 `error` 会让未登录用户看到一个红色报错。
 */
export type AccountEmailsResult =
  | { readonly kind: 'ok'; readonly emails: ReadonlyArray<IAccountEmail> }
  | { readonly kind: 'error'; readonly message: string };

/**
 * 拉账号邮箱;永不抛(`call()` 自己已经把传输错误包成 `ApiResult`)。
 *
 * ## ⚠️ 为什么这里必须**校验载荷**,不能直接透传(2026-10-06,由一次真故障定案)
 *
 * 原来这一行是 `return { kind: 'ok', emails: result.value.emails }` —— 它**信任**
 * 宿主一定给了数组。而 HTTP 信封只保证「`ok:true`」,不保证 `value` 的形状:
 * 版本偏斜(host 半要重启才更新,client 半刷新页面就换)、路由改名、或**任何**
 * 桩/代理回了 `{}`,都会让 `result.value.emails` 是 `undefined`。
 *
 * 下游会立刻**炸在渲染期**:`preferences-pages.tsx` 的
 * `emailList = result.kind === 'ok' ? result.emails : []` 拿到 `undefined`
 * (它只判了 `kind`,没判形状),接着 `accountsWithEmails(identity, undefined)`
 * 的 `emails.map(...)` 抛 TypeError。React 没有 error boundary ⇒ **整棵设置弹窗
 * 被卸载**,现场只剩「#probe-result 不存在」。`preferences-geometry-probe.mjs`
 * 三个 variant 全灭,就是这一条。
 *
 * ⇒ 边界上**收窄**:形状不对时返回**可读的 `error`**(而不是让 `undefined` 流进
 * React 渲染),这样用户看到的是「读取账号邮箱失败:<原因>」,探针看到的是
 * **一条有名有姓的断言失败**。判据仍然是「未登录 ⇒ 空数组 ⇒ 不渲染下拉」那段
 * (`AccountEmailsResult` 的注释),这里**不**改语义,只拒绝畸形载荷。
 */
export async function loadAccountEmails(): Promise<AccountEmailsResult> {
  try {
    const result = await api.accountEmails();
    if (!result.ok) {
      return { kind: 'error', message: result.error.message };
    }
    /*
     * `value` 的静态类型是 `{ emails: …[] }`,但那是**我们自己的声明**,不是运行时
     * 保证。这里用**共享**的收窄助手(`payload.ts`);它失败时说的话包含
     * 「哪个字段、期望什么、实到什么、顶层实到形状」——
     * 也就是这次故障里最缺的那一句(`键=[…]` 那条)。
     *
     * ⚠️ 这是**第二道**(第一道在 `api.ts` 的 `call()` 里,按路由统一收窄)。
     * 两道都留是刻意的:这里是 `auth/emails` 的**消费方**,而消费方不该假设
     * 「上游一定被收窄过了」—— 那正是原来这一行 `return {... result.value.emails}`
     * 的错法。判据(未登录 ⇒ 空数组 ⇒ 不渲染下拉)一个字没改。
     */
    const checked = narrowed<IAccountEmailsPayload>(result.value, ACCOUNT_EMAILS_SHAPE);
    if (!checked.ok) {
      return { kind: 'error', message: `auth/emails 的${checked.message}` };
    }
    return { kind: 'ok', emails: checked.value.emails };
  } catch (error) {
    return { kind: 'error', message: `读取账号邮箱时出错:${String(error)}` };
  }
}

/**
 * 把宿主给的 `string | null` 可见性**收窄**成上游 `IAPIEmail` 的三值。
 *
 * 为什么必须收窄而不是原样透传:上游 `lib/email.ts` 的 `isEmailPublic()` 判的是
 * `visibility === 'public' || !visibility` —— 一个企业旧版回出来的未知字符串
 * (`'internal'` 之类)在那边**既不是 public 也不是 falsy**,于是主邮箱会被判成
 * 「非公开」而被跳过,`lookupPreferredEmail` 静默换一个邮箱。收窄成 `null` 走的是
 * 上游注释里写明的「没有可见性概念 ⇒ 当作公开」那条老企业版语义。
 * @param email - 宿主给的一条邮箱。
 */
export function toDesktopApiMail(email: IAccountEmail): {
  readonly email: string;
  readonly verified: boolean;
  readonly primary: boolean;
  readonly visibility: 'public' | 'private' | null;
} {
  const raw = email.visibility;
  return {
    email: email.email,
    verified: email.verified,
    primary: email.primary,
    visibility: raw === 'public' || raw === 'private' ? raw : null,
  };
}

// ---------------------------------------------------------------------------
// 全局 gitconfig
// ---------------------------------------------------------------------------

/** `config-file-info` 的结果(`error` 里含老 host 没这条路由的情况)。 */
export type GitConfigFileInfoResult =
  | { readonly kind: 'ok'; readonly info: IGitConfigFileInfo }
  | { readonly kind: 'error'; readonly message: string };

/** 读全局 gitconfig 的路径/存在性/锁文件;永不抛。 */
export async function loadGitConfigFileInfo(): Promise<GitConfigFileInfoResult> {
  try {
    const result = await api.gitConfigFileInfo();
    if (!result.ok) {
      return { kind: 'error', message: result.error.message };
    }
    return { kind: 'ok', info: result.value };
  } catch (error) {
    return { kind: 'error', message: `读取全局 Git 配置路径时出错:${String(error)}` };
  }
}

/**
 * `config-file-open` 的结果。
 *
 * `missing` 单独一档,因为冻结接口**明写**「文件不存在 ⇒ bad-request」——
 * 那是**可预期的用户状态**(还没配过全局 gitconfig),不是故障,文案必须不一样。
 */
export type OpenGitConfigFileResult =
  | { readonly kind: 'ok' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'error'; readonly message: string };

/** 请宿主用系统默认应用打开全局 gitconfig;永不抛。 */
export async function openGitConfigFile(): Promise<OpenGitConfigFileResult> {
  try {
    const result = await api.openGitConfigFile();
    if (result.ok) {
      return { kind: 'ok' };
    }
    if (result.error.code === 'bad-request') {
      return { kind: 'missing' };
    }
    return { kind: 'error', message: result.error.message };
  } catch (error) {
    return { kind: 'error', message: `打开全局 Git 配置时出错:${String(error)}` };
  }
}

// ---------------------------------------------------------------------------
// 端点(多企业账号)
// ---------------------------------------------------------------------------

/** GitHub.com 的 REST 端点。取自镜像 `getDotComAPIEndpoint()`(不另写一份字面量)。 */
export const DOTCOM_ENDPOINT: string = getDotComAPIEndpoint();

/**
 * 把用户敲的端点字符串规范化成**可以直接当 `endpoint` 用**的形状。
 *
 * 规则(每一条都有上游对应物):
 *  - 少了 scheme 就补 `https://`(`api.github.com` ⇒ `https://api.github.com`);
 *  - 只接受 `http` / `https` —— 上游 `isDotCom`/`isGHES` 一律 `new URL(ep)`,
 *    其它 scheme 会在那边抛出来;
 *  - 去掉尾部斜杠:上游把端点当**字符串键**用(`endpointVersionKey` 的
 *    `endpoint-version:${ep}`、`Account` 的相等判断)⇒ `https://x/` 与 `https://x`
 *    会被当成两个账号;
 *  - **保留路径**(`https://github.mycompany.com/api/v3` 是 GHES 的标准形态,
 *    上游 `getHTMLURL` 专门有一段处理它;host 侧 `host/auth.ts` 的
 *    `normalizeGithubEndpoint` 也会把纯 HTML 地址补成 `/api/v3`)。
 *
 * @param raw - 用户输入或已存的原始串。
 * @returns 规范化后的端点;`null` = 不像一个端点(调用方必须**拒绝**而不是猜)。
 */
export function normalizeEndpoint(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return null;
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return null;
  }
  if (parsed.hostname === '') {
    return null;
  }
  const path = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.protocol}//${parsed.host}${path}`;
}

/**
 * 这个端点是不是 GitHub.com。
 *
 * **不自己判 hostname**:镜像 `lib/endpoint-capabilities.ts` 的 `isDotCom()` 才是真源
 * (它还认 `github.com` 这个 HTML 主机名)。端点非法时它内部会抛,所以必须先规范化。
 * @param endpoint - 已规范化的端点。
 */
export function isDotComEndpoint(endpoint: string): boolean {
  return isDotCom(endpoint);
}

/**
 * ⚠️ **设备码(device flow)只对 GitHub.com 有效**。
 *
 * 依据:`api.deviceStart()`(`api.ts:508`)打的是 `auth/device-start`,
 * **没有端点参数**(host 侧 `src/host/auth.ts:173` 走的是 github.com 的
 * `login/device/code`)。所以「选了企业端点却仍然走设备码」就等于**偷偷登 github.com**
 * —— 那正是负责人点名不许出现的界面。
 *
 * 这个函数是那条规则**唯一的真源**:等 host 半给 `auth/device-start` 加上端点参数,
 * 只改这里。
 * @param endpoint - 已规范化的端点。
 */
export function deviceFlowSupportsEndpoint(endpoint: string): boolean {
  return isDotComEndpoint(endpoint);
}

/**
 * 用户填的端点与宿主回报的端点**是不是同一个实例**。
 *
 * ⚠️ **不能逐字比较**。`api.ts:517-519` 写明:host 会把
 * `https://ghe.example.com` 这类 **HTML 地址归一化成 `<host>/api/v3`**;而
 * `github.com` 与 `api.github.com` 也会互认(`isDotCom` 认两个主机名)。
 * 逐字比较的失败形态是**:一次成功的登录被判成「端点不一致」**,用户照着假警报
 * 去改一个本来就对的输入。
 *
 * 判据(从宽到窄):
 *  1. 两边都是 GitHub.com ⇒ 同一个实例(两个主机名指的是同一家);
 *  2. 否则比 **host**(含端口)—— 路径差异是 host 归一化的产物,不算不同实例。
 *
 * @param requested - 用户填的(已规范化)。
 * @param reported - 宿主回报的(已规范化)。
 */
export function sameEndpointInstance(requested: string, reported: string): boolean {
  if (isDotComEndpoint(requested) && isDotComEndpoint(reported)) {
    return true;
  }
  try {
    return new URL(requested).host === new URL(reported).host;
  } catch {
    return false;
  }
}

/** 一次 PAT 登录的原始结果。 */
export interface IPatSignInOutcome {
  /** 宿主给的登录态(原样,给 `store.setAuth`)。 */
  readonly state: AuthStatePayload;
  /** 宿主**回报**的端点;`null` = 它没回这个字段(老 host)。 */
  readonly reportedEndpoint: string | null;
  /** 本次**请求**的端点。 */
  readonly requestedEndpoint: string;
}

/** PAT 登录的结果。 */
export type PatSignInResult =
  | { readonly kind: 'ok'; readonly outcome: IPatSignInOutcome }
  | { readonly kind: 'error'; readonly message: string };

/**
 * 提交 PAT,并**把端点一起交给宿主**。
 *
 * `api.setPat` 的第二个参数是可选的,`api.ts:519-520` 写明语义:
 * 「省略 ⇒ 沿用当前账号的端点;登出后回到默认」。我们**总是显式传**——
 * 「沿用当前账号」在用户刚改完端点输入框时是错的。
 *
 * @param token - 用户粘贴的访问令牌。
 * @param endpoint - 目标端点(已规范化)。
 */
export async function submitPat(token: string, endpoint: string): Promise<PatSignInResult> {
  try {
    const result = await api.setPat(token, endpoint);
    if (!result.ok) {
      return { kind: 'error', message: result.error.message };
    }
    /*
     * `AuthStatePayload.endpoint` 类型上是**必填**,但 `api.ts:579-582` 明写
     * 「老 host 不返回这个字段,消费时必须兜底」。所以这里读出来先当 `string | undefined`
     * 处理,不用 `??` 直接骗自己。
     */
    const reported: string | undefined = result.value.endpoint;
    return {
      kind: 'ok',
      outcome: {
        state: result.value,
        reportedEndpoint: typeof reported === 'string' && reported !== '' ? reported : null,
        requestedEndpoint: endpoint,
      },
    };
  } catch (error) {
    return { kind: 'error', message: `提交访问令牌时出错:${String(error)}` };
  }
}
