/**
 * **账号邮箱 与 GitHub 端点(多企业账号)** —— 这两件事共用一个数据源,所以住在一起。
 *
 * ## 它解决的两个缺陷
 *
 * ### 1. 邮箱下拉是空的(账号邮箱没有数据源)
 *
 * 上游 `ui/lib/git-config-user-form.tsx:181-186` 的邮箱下拉有一句
 * `if (this.accountEmails.length === 0) { return null }` —— **空数组就不渲染下拉**,
 * 而候选来自 `account.emails`。本仓库那份镜像**逐字保留**了这条判断
 * (`src/core/desktop/ui/lib/git-config-user-form.tsx:180-186`),所以下拉缺的
 * 不是界面,是**数据**:`preferences-pages.tsx` 的 `accountsFromAuth()` 构造 `Account`
 * 时把 `emails` 写成了 `[]`。
 *
 * ⇒ 本文件用 `api.accountEmails()`(`auth/emails` 路由,已落地)把真邮箱喂进去
 * ({@link accountsWithEmails})。空数组时**什么都不发生**(就是那条 `return null`)。
 *
 * ### 2. 企业端点没有入口(登录永远登 github.com)
 *
 * 上游 `ui/preferences/accounts.tsx:59-61` 有「Add GitHub Enterprise account」。
 * 我们的登录走 host 的设备码 / PAT,而**设备码路由没有端点参数**
 * (`api.deviceStart()`)⇒ 「选了企业端点却仍然登 github.com」是这一块最容易造出来的
 * 假界面。本文件的裁决是:
 *
 *  - 端点**显式**让用户填,并**持久化**(键 `auth-endpoint`,与 `prefs.ts` 同一套
 *    `localStorage` + `PREFERENCE_CHANGED_EVENT` 机制,不是第三套);
 *  - 端点不是 GitHub.com 时,`Accounts` 的「Sign in to GitHub Enterprise」按钮
 *    **不启动设备码**,而是把焦点移到 PAT 输入并说清原因
 *    ({@link useEnterpriseSignIn} 的 `onEnterpriseSignIn`);
 *  - PAT 提交后**必须**核对宿主回报的端点({@link describePatOutcome});
 *    宿主没回报 ⇒ 说「无法确认」;**回报了但不是同一个实例** ⇒ 明确说
 *    「这次没有登进你选的实例」。
 *
 * ## 诚实边界(不许把下面两条读成已经做完了)
 *
 *  1. **现代 stealth 邮箱没有数据源**。上游 `lib/email.ts` 会补一条
 *     `<id>+<login>@users.noreply.github.com`,它需要**数值 id**;而
 *     `AuthStatePayload` 只给 `login` / `tokenTail` / `endpoint`,没有 id
 *     (现在 `Account.id` 只能填 `-1`)。我们**不猜、不伪造**这条地址 ——
 *     伪造一条用户其实没有的 noreply 邮箱会让「Other」之外的选项看起来可选,
 *     选中的后果是提交被记到别人头上。回收条件:host 线在 `AuthStatePayload` 里补
 *     `id`,或让 `/user/emails` 本来就把 noreply 那条地址带上(通常它就在)。
 *  2. **提交者告警(misattribution)的真正落点在 `changes-view.tsx`**,
 *     那个文件不在本泳道的可改文件里。本文件把判据({@link commitAuthorWarning})
 *     与文案准备好,接线是 `changes-view.tsx:891-900` 那三个 prop(见交付报告)。
 *
 * @see src/client/host-api-bridge.ts —— 四条路由的适配层
 * @module dsh-git/client/account-emails
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent, ReactNode } from 'react';

import { Account } from '../core/desktop/models/account.ts';
import { isAttributableEmailFor } from '../core/desktop/lib/email.ts';

import type { AuthInstallationPayload, AuthStatePayload } from './api.ts';
import {
  DOTCOM_ENDPOINT,
  deviceFlowSupportsEndpoint,
  loadAccountEmails,
  loadInstallationStatus,
  normalizeEndpoint,
  sameEndpointInstance,
  submitPat,
  toDesktopApiMail,
  type AccountEmailsResult,
  type IAccountEmail,
  type IPatSignInOutcome,
} from './host-api-bridge.ts';
import { PREFERENCE_CHANGED_EVENT } from './prefs.ts';

// ---------------------------------------------------------------------------
// 端点偏好(同一套 localStorage + 广播机制)
// ---------------------------------------------------------------------------

/** 端点偏好的键。**我们自己起的名字**(上游把账号存在数据库里,没有这个键)。 */
const KEY_AUTH_ENDPOINT = 'auth-endpoint';

/** 读上次用过的端点;缺失/非法/存储不可用时回 {@link DOTCOM_ENDPOINT}。 */
export function getStoredEndpoint(): string {
  try {
    const raw = window.localStorage.getItem(KEY_AUTH_ENDPOINT);
    if (raw === null) {
      return DOTCOM_ENDPOINT;
    }
    return normalizeEndpoint(raw) ?? DOTCOM_ENDPOINT;
  } catch {
    return DOTCOM_ENDPOINT;
  }
}

/** 写上次用过的端点(写入前规范化;非法值**不写**,免得把坏值固化进存储)。 */
export function setStoredEndpoint(endpoint: string): void {
  const normalized = normalizeEndpoint(endpoint);
  if (normalized === null) {
    return;
  }
  try {
    window.localStorage.setItem(KEY_AUTH_ENDPOINT, normalized);
  } catch {
    // 写不进去就只在本次会话内生效。
  }
  try {
    window.dispatchEvent(new CustomEvent(PREFERENCE_CHANGED_EVENT, { detail: KEY_AUTH_ENDPOINT }));
  } catch {
    // 没有 window(SSR / 探针)时只持久化,不广播。
  }
}

// ---------------------------------------------------------------------------
// 账号邮箱
// ---------------------------------------------------------------------------

/** 一次登录身份的**最小**面(我们只拿得到这些;没有数值 id,见文件头「诚实边界 1」)。 */
export interface IAuthIdentity {
  readonly login: string;
  /**
   * 该账号的 GitHub **API 基址**。
   *
   * ⚠️ 今天**两条渲染路径给的东西不一样**:宿主设置卡片那条
   * (`index.ts:289` 传 `globalStore.snapshot().auth`)在运行期**带**这个字段;
   * 自建模态那条(`workbench.tsx:308`)构造的是 `{login, tokenTail}`,**不带**。
   * 所以这里是可选的,缺少时由 {@link resolveAccountEndpoint} 兜底。
   */
  readonly endpoint?: string;
}

/**
 * 当前账号用的是哪个端点 —— **登录态没带就退回上次用过的那个**。
 *
 * 为什么兜底值是「上次用过的端点」而不是写死 GitHub.com:同一个「账号」页上,
 * 端点输入框显示的也是它({@link getStoredEndpoint})。两处**必须一致**,
 * 否则页面会自相矛盾(输入框写着企业地址,账号卡片说这是 GitHub.com)。
 *
 * @param identity - 当前登录身份;`null` = 未登录。
 */
export function resolveAccountEndpoint(identity: IAuthIdentity | null): string {
  const declared = identity?.endpoint;
  if (declared !== undefined) {
    const normalized = normalizeEndpoint(declared);
    if (normalized !== null) {
      return normalized;
    }
  }
  return getStoredEndpoint();
}

/**
 * 把宿主给的邮箱与登录身份拼成上游 `Account`(邮箱下拉 / 头像 / 归属判断的输入面)。
 *
 * `token` 传空串:`Account` 的这个字段只被 API 客户端用,而浏览器半**没有**令牌
 * (令牌只住在 host),传空串与本仓库既有做法(`accountsFromAuth`)逐字一致。
 * `id` 传 `-1`:`AuthStatePayload` 没有数值 id,**不猜**(见文件头)。
 *
 * @param identity - 当前登录身份。
 * @param emails - `auth/emails` 给的邮箱;空数组 ⇒ 上游表单不渲染下拉。
 */
/**
 * 已登录账号的头像地址。
 *
 * ⚠️ **单一真源**:镜像 `ui/preferences/accounts.tsx` 的头像走 `Account.avatarURL`
 * (`models/account.ts:51`),而那条 URL 是本插件**自己拼**的(Desktop 从 `/user` 的
 * `avatar_url` 拿,我们只拿得到 login)⇒ 设置页的头像行与 `accountsWithEmails` 必须用
 * **同一个函数**,否则两处显示的头像可能不是同一张(企业实例尤其)。
 * @param login - 登录名。
 * @returns 头像图片地址。
 */
export function avatarUrlFor(login: string): string {
  return `https://avatars.githubusercontent.com/${login}`;
}

export function accountsWithEmails(
  identity: IAuthIdentity,
  emails: ReadonlyArray<IAccountEmail>,
): ReadonlyArray<Account> {
  return [
    new Account(
      identity.login,
      resolveAccountEndpoint(identity),
      '',
      emails.map((email) => toDesktopApiMail(email)),
      avatarUrlFor(identity.login),
      -1,
      identity.login,
    ),
  ];
}

/**
 * 把 {@link accountsWithEmails} 的结果**收窄成「能安全当邮箱候选」的那一份**。
 *
 * ## 为什么必须有这一层(不是可选的净化)
 *
 * 上游 `ui/lib/git-config-user-form.tsx:77-79` 对 **GitHub.com** 账号**无条件**追加
 * `getStealthEmailForAccount(account)`,而那条地址是用 `account.id` 拼出来的
 * (`lib/email.ts:83-84` ⇒ `getStealthEmailForUser(account.id, …)`)。
 * Desktop 的 `id` 是**真的数值 id**(`/user` 回的),所以那条 stealth 地址是真的;
 * 我们只能传 `-1`(见文件头「诚实边界 1」)⇒ 一个**没有任何已验证邮箱**的账号会让
 * 上游表单渲染出**唯一一条伪造地址**:
 *
 * ```
 * -1+<login>@users.noreply.github.com
 * ```
 *
 * 更糟的两点:①它会作为**可选项**出现在偏好设置 ▸ Git 的邮箱下拉里,选中就写进
 * `user.email`;②`lib/email.ts:113-118` 的 `isAttributableEmailFor` 也用同一个 `account.id`
 * 重算 stealth 地址 ⇒ 这条假地址会被判成「属于该账号」,连 misattribution 告警都不弹。
 *
 * ⇒ **没有任何已验证邮箱的账号不进候选表**:候选为空时上游
 * `git-config-user-form.tsx:168-170` 自己就 `return null`(下拉不渲染),这正是
 * 「空结果保持 no-op,绝不伪造地址」。
 *
 * ## 仍未解决的一半(不许当成已修)
 *
 * 账号**有** ≥1 条已验证邮箱时,那条伪造地址依然会作为**额外选项**与真地址并列出现
 * —— 镜像是逐字节的,我们这层拦不住。证据:`docs/probes/git-page-probe.mjs` 的 E2 明细
 * (选项里能看见 `-1+ada@users.noreply.github.com`)。
 * 修法只有两条,都不在本泳道:host 在 `AuthStatePayload` 里补数值 `id`,或按
 * `docs/goal-port-desktop.md` §10.3 给镜像登记一条 EXPECTED 偏离。
 * **回收条件**:数值 `id` 落地(stealth 地址变真)之后删掉本函数,直接吃
 * {@link accountsWithEmails} 的输出。
 *
 * @param accounts - 上游 `Account[]`(通常就是 `accountsWithEmails(...)` 的输出)。
 */
export function accountsUsableAsEmailCandidates(
  accounts: ReadonlyArray<Account>,
): ReadonlyArray<Account> {
  return accounts.filter((account) => account.emails.some((email) => email.verified));
}

/** {@link useAccountEmails} 的返回面。 */
export interface IAccountEmailsState {
  /** `null` = 还在读(注意:`ok` + 空数组是**未登录**,不是「还在读」)。 */
  readonly result: AccountEmailsResult | null;
  /** 重新拉一次(登录/登出之后调)。 */
  readonly reload: () => void;
}

/**
 * 拉账号邮箱的 React 钩子(挂载时一次 + 显式 `reload`)。
 *
 * 为什么不做轮询:邮箱在会话内几乎不变,而登录态变化的那些时刻(设备码成功 /
 * PAT 成功 / 登出)调用方**知道**,显式调 `reload()` 更准。
 * @param enabled - `false` 时**不发请求**(未登录时没必要打 host)。
 */
export function useAccountEmails(enabled: boolean): IAccountEmailsState {
  const [result, setResult] = useState<AccountEmailsResult | null>(null);
  const [nonce, setNonce] = useState(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled) {
      setResult(null);
      return;
    }
    void (async () => {
      const next = await loadAccountEmails();
      if (alive.current) {
        setResult(next);
      }
    })();
  }, [enabled, nonce]);

  const reload = useCallback(() => {
    setNonce((value) => value + 1);
  }, []);

  return { result, reload };
}

/**
 * 账号页底部那块**提示**(用户给的界面契约:页面自上而下是
 * `DeviceFlowPanel` → 上游 `Accounts` → `AccountNotice`)。
 *
 * 它只说**两类**必须让人知道的事,其余一律闭嘴:
 *  1. **GitHub App 没安装**(`not-installed`)⇒ 这是我们唯一能替用户指出下一步的场合
 *     (安装入口),见 {@link AppInstallNotice} 的内容;
 *  2. **账号邮箱读失败** ⇒ GitHub App 少了 `Email addresses: Read`、或令牌没权限时会走到这里。
 *
 * ⚠️ **成功的那句不在这里**(2026-11 用户裁决):原来那行「邮箱候选来自你的 GitHub 账号(N 个已验证
 * 地址)」是纯信息,对用户没有动作可做 —— 邮箱数据本身照旧供 Git 页的下拉与账号卡头像用
 * (`useAccountEmails`),只是不再上屏。`AccountEmailSourceNotice` 这个组件因此被删掉。
 * @param props - 安装状态 + 邮箱读取结果(两者都可以是 `null` = 还没读到)。
 */
export function AccountNotice(props: {
  readonly installation: AuthInstallationPayload | null;
  readonly emails: AccountEmailsResult | null;
}): ReactNode {
  const emails = props.emails;
  return (
    <>
      <AppInstallNotice status={props.installation} />
      {emails !== null && emails.kind === 'error' && (
        <p className="settings-description">读取账号邮箱失败:{emails.message}</p>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// GitHub App 的安装状态(「授权 ≠ 安装」那条引导)
// ---------------------------------------------------------------------------

/** {@link useAppInstallation} 的返回面。 */
export interface IAppInstallationState {
  /** `null` = 还没读到 / 读不到 —— 两种都**不提示**(见 `loadInstallationStatus()`)。 */
  readonly status: AuthInstallationPayload | null;
  /** 重新查一次(登录 / 换账号之后调)。 */
  readonly reload: () => void;
}

/**
 * 查一次「这个 GitHub App 装到我账号上了吗」(挂载时一次 + 显式 `reload`)。
 *
 * 为什么不轮询:安装状态只在**用户在 GitHub 上点 Install 的那一刻**变,而那一刻之后他会
 * 回到这个页面;与 `useAccountEmails` 同一条理由(会话内几乎不变,变化的时刻调用方知道)。
 *
 * @param enabled - 未登录时不必查(host 会回 `not-signed-in`,但连请求都省掉更干净)。
 */
export function useAppInstallation(enabled: boolean): IAppInstallationState {
  const [status, setStatus] = useState<AuthInstallationPayload | null>(null);
  /** 防止卸载后 setState(查询是异步的)。 */
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  const reload = useCallback(() => {
    void (async () => {
      const next = await loadInstallationStatus();
      if (!aliveRef.current) { return; }
      setStatus(next);
    })();
  }, []);

  useEffect(() => {
    if (!enabled) { return; }
    reload();
  }, [enabled, reload]);

  return { status, reload };
}

/**
 * 「这个 App 还没安装」的引导 —— **只有 `not-installed` 会渲染出东西**。
 *
 * ## 它解决的问题(2026-11 现场)
 *
 * GitHub App 的「授权」与「安装」是两件事。用户走完设备码授权、令牌也拿到了,但
 * `GET /user/installations` 仍是 `total_count: 0` ⇒ 之后**所有仓库级**端点 403,而 GitHub
 * 只回一句 `Resource not accessible by integration`(不解释、不给下一步)。用户看到的是
 * 「登录成功了,但每个页签都说不不不」。
 *
 * 判据在 host 半(`installationStatusOf()`):PAT / OAuth App 令牌会回 `not-app-token`,
 * 查询失败回 `unknown` —— **两种都不提示**,所以这条引导不会对着 PAT 用户或一次网络抖动乱喊。
 *
 * ⚠️ `installUrl` 为空串时(用户自带的 App,我们不知道他的 slug)**不渲染链接**,
 * 只说明该做什么 —— 编一个链接等于把人送到别人的 App 上。
 * @param props - `useAppInstallation()` 的当前值。
 */
export function AppInstallNotice(props: {
  readonly status: AuthInstallationPayload | null;
}): ReactNode {
  const status = props.status;
  if (status === null || status.kind !== 'not-installed') {
    return null;
  }
  return (
    <p className="setting-hint-warning">
      ⚠️ 这个 GitHub App <strong>还没有安装</strong>到你的账号 —— 仓库里的功能
      (Code / Issues / Pull Requests / Actions,以及推送)会报
      「Resource not accessible by integration」。GitHub App 的「授权」与「安装」是两件事,两步都要做:
      {status.installUrl === '' ? (
        ' 到 GitHub 上这个 App 的页面点 Install 即可。'
      ) : (
        <>
          {' '}去<strong>安装页</strong>把它装到对应账号 ——{' '}
          <a href={status.installUrl} target="_blank" rel="noreferrer noopener">{status.installUrl}</a>
          {' '}(记得把要用的仓库选进安装范围)。
        </>
      )}
    </p>
  );
}

/**
 * 提交作者归属告警的判据(上游 `ui/changes/commit-message.tsx:755-769` 的那一条)。
 *
 * ## 为什么这是一个**纯函数**而不是组件
 *
 * 它今天没有渲染落点:`changes-view.tsx:891-900` 把 `CommitMessageAvatar` 的
 * `warningType` 写死成 `"none"`(那段注释也承认「`misattribution` 要账号邮箱」),
 * 而那个文件不在本泳道的可改文件里。把判据做成纯函数,接线方只需要:
 *
 * ```tsx
 * const warning = commitAuthorWarning(author.email, identity, emails);
 * <CommitMessageAvatar … warningType={warning} accountEmails={emails.map(e => e.email)} />
 * ```
 *
 * @param email - 当前提交者邮箱(上游 `commitAuthor?.email`)。
 * @param identity - 当前登录身份;`null` = 未登录 ⇒ 判不了,一律 `'none'`。
 * @param emails - `auth/emails` 给的邮箱。
 * @returns 上游 `CommitMessageAvatarWarningType` 里我们**能**判的那两个值之一。
 */
export function commitAuthorWarning(
  email: string | undefined,
  identity: IAuthIdentity | null,
  emails: ReadonlyArray<IAccountEmail>,
): 'none' | 'misattribution' {
  if (email === undefined || email.trim() === '' || identity === null) {
    return 'none';
  }
  const account = accountsWithEmails(identity, emails)[0];
  if (account === undefined) {
    return 'none';
  }
  return isAttributableEmailFor(account, email) ? 'none' : 'misattribution';
}

// ---------------------------------------------------------------------------
// 端点 + PAT 登录
// ---------------------------------------------------------------------------

/** {@link useEnterpriseSignIn} 的输入。 */
export interface IEnterpriseSignInOptions {
  /** 登录成功(调用方负责 `store.setAuth` / 刷新远端清单 / toast)。 */
  readonly onSignedIn: (state: AuthStatePayload) => void;
  /** 启动设备码流程(**只有端点是 GitHub.com 时**才会被调用)。 */
  readonly onDeviceSignIn: () => void;
}

/** 结果行的语气(决定挂哪组样式)。 */
export type EnterpriseSignInStatusKind = 'info' | 'ok' | 'warn';

/** {@link useEnterpriseSignIn} 的返回面(全是具名成员,JSX 里直接 `{x.y}` / `onX={x.y}`)。 */
export interface IEnterpriseSignIn {
  /** 输入框里的原始文本(可能是半截的,没规范化)。 */
  readonly endpoint: string;
  /** 规范化后的端点;`null` = 现在这串不合法。 */
  readonly normalizedEndpoint: string | null;
  /** 端点是否 GitHub.com(决定设备码可不可用、界面要不要如实说明)。 */
  readonly endpointIsDotCom: boolean;
  /** 访问令牌输入框内容。 */
  readonly pat: string;
  /** 正在提交。 */
  readonly busy: boolean;
  /** 结果行文案;`null` = 还没有结果。 */
  readonly status: string | null;
  /** 结果行的语气。 */
  readonly statusKind: EnterpriseSignInStatusKind;
  /**
   * **PAT 表单现在是开着还是关着** —— 面板默认关闭,只留一个「PAT 令牌登录」按钮。
   *
   * 为什么放钩子里而不是面板的局部 state(2026-11):**同一个可见性有两处入口** ——
   * 用户点那个按钮,以及上游 `Accounts` 的企业 CTA({@link IEnterpriseSignIn.onEnterpriseSignIn})。
   * 若各自持有一份(局部 `override` + 一个"被要求打开"的标志),就会出现「CTA 点过之后
   * 用户收起、再点 CTA 打不开」这种两真源打架的形态。现在只有这一个布尔量:
   * 两条入口都写它,{@link IEnterpriseSignIn.onTogglePat} 也是。
   */
  readonly patOpen: boolean;
  /** 切换 PAT 表单的展开/收起(「PAT 令牌登录」按钮的 onClick)。 */
  readonly onTogglePat: () => void;
  /** 挂到 PAT 输入框上的 **callback ref**(`react/jsx-no-bind` 只认 useCallback 结果)。 */
  readonly patInputRef: (element: HTMLInputElement | null) => void;
  /** 端点输入。 */
  readonly onEndpointInput: (event: ChangeEvent<HTMLInputElement>) => void;
  /** 令牌输入。 */
  readonly onPatInput: (event: ChangeEvent<HTMLInputElement>) => void;
  /** 提交表单(PAT 登录)。 */
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  /** 交给上游 `Accounts` 的 `onEnterpriseSignIn`(它**不会**盲启动设备码)。 */
  readonly onEnterpriseSignIn: () => void;
}

/**
 * 把一次 PAT 登录的结果翻成一句**核对过端点**的实话。
 *
 * 三种情况必须说三种话,因为它们的后果完全不同:
 *  - 宿主**没有回报**端点(老 host)⇒ 「无法确认」;
 *  - 回报了但**不是同一个实例** ⇒ 这次登录**没有**落在你选的实例上;
 *  - 同一个实例 ⇒ 确认(**注意**:宿主会把 HTML 地址归一化成 `<host>/api/v3`,
 *    所以字面不相等是正常的,判据是 {@link sameEndpointInstance})。
 * @param outcome - {@link submitPat} 的结果。
 */
export function describePatOutcome(outcome: IPatSignInOutcome): string {
  const requested = outcome.requestedEndpoint;
  const reported = outcome.reportedEndpoint;
  if (reported === null) {
    return '已用令牌登录。⚠️ 宿主没有回报实际端点(老 host 不返回 `AuthStatePayload.endpoint`),' +
      `所以**无法确认**这次登的是不是你填的 ${requested}。`;
  }
  if (!sameEndpointInstance(requested, normalizeEndpoint(reported) ?? reported)) {
    return `⚠️ 端点不一致:你填的是 ${requested},宿主实际回报的是 ${reported}。` +
      '这次登录**没有**落在你选的实例上,请检查端点写法(企业实例通常是 …/api/v3)。';
  }
  return `已登录 ${reported}。`;
}

/** 企业端点上点「Sign in to GitHub Enterprise」时的说明(与界面上的提示同一句话)。 */
export const ENTERPRISE_DEVICE_FLOW_UNAVAILABLE =
  '设备码登录只支持 GitHub.com:`api.deviceStart()` 没有端点参数。' +
  '企业实例请把访问令牌粘到下面的「访问令牌」里。';

/**
 * 端点 + PAT 登录的状态机(账号页用)。
 *
 * ## 为什么端点不是「受控 prop」而是这个钩子自己持有
 *
 * 端点要同时被三处读:面板里的输入框、`Accounts` 的按钮回调、以及提交时。
 * 抬到 `PreferencesPageBody` 会变成三个 prop 来回传;而这个钩子**只有一处**实例化
 * (`preferences-pages.tsx` 的 accounts 分支),状态与行为住在一起更好读。
 *
 * ## 回调为什么全部 `useCallback` 空依赖
 *
 * 本仓的 `react/jsx-no-bind` 只接受 `useCallback` 结果或成员表达式;而依赖表里放
 * `onSignedIn` / `onDeviceSignIn` 会让回调每次渲染换身份(调用点两个外壳都是内联闭包)。
 * 所以两个输入经 ref 读最新值,回调身份恒定。
 *
 * @param options - 见 {@link IEnterpriseSignInOptions}。
 */
export function useEnterpriseSignIn(options: IEnterpriseSignInOptions): IEnterpriseSignIn {
  const [endpoint, setEndpoint] = useState<string>(() => getStoredEndpoint());
  const [pat, setPat] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [statusKind, setStatusKind] = useState<EnterpriseSignInStatusKind>('info');
  /** 见 {@link IEnterpriseSignIn.patOpen}(两条入口共用的**唯一**一份可见性状态)。 */
  const [patOpen, setPatOpen] = useState(false);

  const patElement = useRef<HTMLInputElement | null>(null);
  /**
   * 待执行的「把焦点给令牌输入框」。
   *
   * 为什么需要它:面板在已登录时收起 ⇒ `onEnterpriseSignIn` 那一刻输入框**还没挂载**,
   * 直接 `focus()` 打在 `null` 上。挂载由 callback ref 触发,所以把这次意图存在 ref 里,
   * 等 `patInputRef` 拿到元素时兑现(见 {@link patInputRef})。
   */
  const patFocusPending = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const latestSignedIn = useRef(options.onSignedIn);
  latestSignedIn.current = options.onSignedIn;
  const latestDeviceSignIn = useRef(options.onDeviceSignIn);
  latestDeviceSignIn.current = options.onDeviceSignIn;

  const normalizedEndpoint = normalizeEndpoint(endpoint);
  const endpointIsDotCom =
    normalizedEndpoint !== null && deviceFlowSupportsEndpoint(normalizedEndpoint);

  const endpointIsDotComRef = useRef(endpointIsDotCom);
  endpointIsDotComRef.current = endpointIsDotCom;
  const latestEndpoint = useRef(endpoint);
  latestEndpoint.current = endpoint;
  const latestPat = useRef(pat);
  latestPat.current = pat;

  const patInputRef = useCallback((element: HTMLInputElement | null) => {
    patElement.current = element;
    /*
     * 兑现 {@link patFocusPending}:表单刚被顶开时元素这一刻才出现。
     * 只在首次拿到元素时兑现一次(`.current` 随即清掉),不抢用户之后的焦点操作。
     */
    if (element !== null && patFocusPending.current) {
      patFocusPending.current = false;
      element.focus();
    }
  }, []);

  const onEndpointInput = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setEndpoint(event.currentTarget.value);
  }, []);

  const onPatInput = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setPat(event.currentTarget.value);
  }, []);

  const onSubmit = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void (async () => {
      const requested = normalizeEndpoint(latestEndpoint.current);
      if (requested === null) {
        setStatus('这不是一个合法的 API 端点(例如 https://github.example.com/api/v3)。');
        setStatusKind('warn');
        return;
      }
      const token = latestPat.current.trim();
      if (token === '') {
        setStatus('请先粘贴一个访问令牌。');
        setStatusKind('warn');
        return;
      }
      setBusy(true);
      setStatus(null);
      // 只有在**提交**时才把端点固化进存储:边打字边规范化会让输入框自己跳字。
      setStoredEndpoint(requested);
      const result = await submitPat(token, requested);
      if (!alive.current) {
        return;
      }
      setBusy(false);
      if (result.kind === 'error') {
        setStatus(result.message);
        setStatusKind('warn');
        return;
      }
      latestSignedIn.current(result.outcome.state);
      setPat('');
      const reported = result.outcome.reportedEndpoint;
      const confirmed =
        reported !== null &&
        sameEndpointInstance(requested, normalizeEndpoint(reported) ?? reported);
      if (reported !== null) {
        /*
         * 记住了**宿主确认过的**端点,而不是用户敲的那个:`resolveAccountEndpoint()`
         * 与端点输入框都读存储 ⇒ 下次进这一页,两边显示的就是同一件已确认的事实。
         * (宿主会把 HTML 地址补成 `/api/v3`,所以这一步不是多余的。)
         */
        setStoredEndpoint(reported);
        setEndpoint(reported);
      }
      setStatus(describePatOutcome(result.outcome));
      setStatusKind(confirmed ? 'ok' : 'warn');
    })();
  }, []);

  const onEnterpriseSignIn = useCallback(() => {
    if (endpointIsDotComRef.current) {
      latestDeviceSignIn.current();
      return;
    }
    /*
     * ⚠️ 这里**故意不**启动设备码:那会静默登 github.com。改为如实说明 + 把用户
     * 送到真能用的那条路(PAT 输入框)。
     *
     * 2026-11:PAT 表单默认是**关着**的(只留一个入口按钮)⇒ 输入框可能根本不在 DOM 里。
     * 所以先把它打开(`patOpen`),再把焦点交给 `patInputRef` 在挂载时补上 —— 否则那句
     * 「请把访问令牌粘到『访问令牌』里」会指着一个不存在的输入框。
     */
    setPatOpen(true);
    patFocusPending.current = true;
    setStatus(ENTERPRISE_DEVICE_FLOW_UNAVAILABLE);
    setStatusKind('warn');
    patElement.current?.focus();
  }, []);

  const onTogglePat = useCallback(() => { setPatOpen((open) => !open); }, []);

  return {
    endpoint,
    normalizedEndpoint,
    endpointIsDotCom,
    pat,
    busy,
    status,
    statusKind,
    patOpen,
    onTogglePat,
    patInputRef,
    onEndpointInput,
    onPatInput,
    onSubmit,
    onEnterpriseSignIn,
  };
}

/**
 * PAT 登录的**入口按钮** —— 它会被塞进上游 `Accounts` 的 GitHub.com 动作行
 * (见那边 `patSignInAction` 插槽),所以这里必须用**上游的 `Button`**:
 * 行里那条 `.button-component{align-self:flex-end}` 规则只认它,用我们自己的 `gw-btn`
 * 会在行里顶到上边、字号与旁边的登录 / 退出登录按钮也不一致。
 *
 * 为什么拆成「按钮」与「表单」两个组件(2026-11,用户裁决):按钮要**横向**落在动作行里,
 * 而展开后的表单是**纵向**一整块 —— 把整块塞进 `Row` 会被 flex 挤成一条。
 * 两块共用同一个状态({@link IEnterpriseSignIn.patOpen}),所以拆的只是渲染,不是逻辑。
 * @param props - 钩子的返回值(见 {@link IEnterpriseSignIn})。
 */
export function PatSignInAction(props: { readonly signIn: IEnterpriseSignIn }): ReactNode {
  const signIn = props.signIn;
  /*
   * ⚠️ 这里用**裸 `<button className="button-component">`** 而不是上游 `Button` 组件:
   * 它的 `IButtonProps` 没有声明 `children`(`DialogContent` / `TabBar` 是同一处上游类型缺口),
   * 用它就得再往类型基线里登记一条诊断。而这个按钮要的只是**那一套样式**
   * (`.gw-prefs .button-component…`,以及动作行里 `.button-component{align-self:flex-end}`),
   * 类名给到就够 —— 行为(一个 onClick)由 React 原生按钮承担。
   */
  return (
    <button className="button-component" type="button" onClick={signIn.onTogglePat}>
      {signIn.patOpen ? '收起令牌登录' : 'PAT 令牌登录'}
    </button>
  );
}

/**
 * PAT 表单(端点 + 访问令牌 + 提交)—— 渲染在上游 `Accounts` 的 GitHub.com 那一段之后
 * (见那边 `patSignInForm` 插槽)。
 *
 * ## 为什么默认**完全关着**,只留一个入口按钮
 *
 * 这块表单原先无条件常驻,于是账号页同时出现「下面:已登录 @x」与「上面:请输入访问令牌」——
 * 两块说的是两件事(状态清单 vs 登录表单),但同屏并列就是自相矛盾。先前的修法是"已登录时
 * 默认收起";用户随后把界面定死为**三段**(设备码面板 → 上游 `Accounts` → `AccountNotice`),
 * 并要求这块只留一个入口按钮:【PAT 令牌登录】。
 *
 * 可见性只剩**一个布尔量**({@link IEnterpriseSignIn.patOpen}),两条入口都写它:
 *  1. 用户点那个按钮({@link IEnterpriseSignIn.onTogglePat});
 *  2. 上游 `Accounts` 的企业 CTA({@link IEnterpriseSignIn.onEnterpriseSignIn} ——
 *     企业端点用不了设备码,那条路上访问令牌是唯一出路,所以它会把表单打开并把焦点送进去)。
 *
 * 为什么不再写一个纯函数判"该不该展开":那个判据存在的理由是**自动展开**与用户手动收起会打架;
 * 现在没有自动展开这回事(企业 CTA 那一条也是用户的动作),一个布尔量就够。
 *
 * ⚠️ 结果行({@link IEnterpriseSignIn.status})**不跟着收起**:它是上一条动作的回执
 * (「已用令牌登录 …」/「端点不一致 …」)。特别是企业 CTA 那条 —— 它把表单打开之后用户
 * 又可能收起,「为什么让你粘令牌」这句话必须留着。
 * @param props - 钩子的返回值(见 {@link IEnterpriseSignIn})。
 */
export function PatSignInForm(props: { readonly signIn: IEnterpriseSignIn }): ReactNode {
  const signIn = props.signIn;

  return (
    <>
      {signIn.patOpen && (
        <>
          <h3>GitHub 端点</h3>
          <p className="settings-description">
            默认 GitHub.com。企业实例(GitHub Enterprise Server)填它的地址,
            例如 <code>https://github.example.com</code> 或 <code>https://github.example.com/api/v3</code>
            —— 宿主会把 HTML 地址归一化成 API 基址。
          </p>
          <div className="gw-field">
            <label htmlFor="gw-prefs-auth-endpoint">API 端点</label>
            <input
              id="gw-prefs-auth-endpoint"
              className="gw-input"
              type="url"
              value={signIn.endpoint}
              onChange={signIn.onEndpointInput}
            />
          </div>
          {signIn.normalizedEndpoint === null && (
            <p className="settings-description">⚠️ 这串还不是一个合法端点。</p>
          )}
          {!signIn.endpointIsDotCom && signIn.normalizedEndpoint !== null && (
            <p className="settings-description">⚠️ {ENTERPRISE_DEVICE_FLOW_UNAVAILABLE}</p>
          )}
          <form onSubmit={signIn.onSubmit}>
            <div className="gw-field">
              <label htmlFor="gw-prefs-auth-pat">访问令牌(PAT)</label>
              <input
                id="gw-prefs-auth-pat"
                ref={signIn.patInputRef}
                className="gw-input"
                type="password"
                autoComplete="off"
                value={signIn.pat}
                onChange={signIn.onPatInput}
              />
            </div>
            <div className="gw-formrow">
              <button className="gw-btn primary" type="submit" disabled={signIn.busy}>
                {signIn.busy ? '正在登录…' : '用令牌登录'}
              </button>
            </div>
          </form>
        </>
      )}
      {signIn.status !== null && (
        <p
          className={signIn.statusKind === 'warn' ? 'setting-hint-warning' : 'settings-description'}
          role="status"
          aria-live="polite"
        >
          {signIn.status}
        </p>
      )}
    </>
  );
}
