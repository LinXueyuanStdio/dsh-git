/**
 * 设置页的【账号】分组 —— 登录态 / 退出登录 / 设备码登录 / 令牌登录。
 *
 * ## 状态机与偏好弹窗**共用同一份**(不是「长得像」)
 *
 * 两个状态机都从 `./account-emails.tsx` / `./preferences-pages.tsx` 来,与本仓那条
 * 「一个概念一个实现」的纪律一致:
 *
 * | 状态机 | 管什么 | 弹窗里的用法 | 这里的用法 |
 * |---|---|---|---|
 * | `useDeviceSignIn`(`preferences-pages.tsx`) | 设备码的 `idle → starting → waiting → done/error` 与轮询 | 账号页的设备码面板 | 同一份,`device.state` |
 * | `useEnterpriseSignIn`(`account-emails.tsx`) | 端点文本 / 规范化、令牌表单的展开收起(`patOpen`)、令牌提交、结果行与语气 | `Accounts` 的企业 CTA + `PatSignInAction` / `PatSignInForm` 两个插槽 | 同一份,`signIn.*` |
 *
 * ⚠️ 2026-10-13 用户反馈「状态机没和 preference dialog 保持一致」—— 改前的这一组是**另写**
 * 的一条简化链:端点与令牌两个输入框**无条件常驻**,而 `patOpen` 那套「默认收起、点了才展开」
 * 的可见性,以及 `onEnterpriseSignIn` 在非 github.com 上「不开设备码、改为展开令牌表单并
 * 说明原因」那条裁决,**都没有**。现在全部走共用状态机 ⇒ 两边行为逐条相同。
 *
 * ## 信息面与弹窗那一页对齐(2026-10-13 用户反馈「还是缺了很多东西」)
 *
 * 弹窗账号页是**三段**(设备码面板 → 账号清单/两个 CTA → 安装与邮箱提示),本页逐条对齐:
 *
 * | 弹窗里的东西 | 本页的对应物 |
 * |---|---|
 * | 头像 + 账号名 + `@login` | 身份行(头像 40px + `@login`,已登录时右侧是**两个**按钮) |
 * | 「退出登录」与「PAT 令牌登录」两个按钮 | 同一行两个按钮(已登录时也在 —— 换账号要用它) |
 * | GitHub.com 的登录 CTA | 「登录 GitHub.com」行 → `device.start` |
 * | 「GitHub Enterprise」小节 + 说明 + CTA | 「GitHub Enterprise」行 → `signIn.onEnterpriseSignIn` |
 * | PAT 表单(端点 + 令牌) | 同一份状态机的表单(默认收起) |
 * | `AccountNotice`:邮箱读失败 / App 未安装 | {@link WarnNote} 两条(信息与链接同源:`useAccountEmails` / `useAppInstallation`) |
 *
 * ⚠️ 两个提示读的是**同一份真源**(`account-emails.tsx` 的钩子),文案也照那两句的意思写;
 * 但**渲染**是本页自己的宿主风格行,不复用 `AccountNotice`(它是 `.gw-prefs` 作用域里的
 * 移植面组件 —— 那正是「不能复用别人的 CSS」那条约束)。
 *
 * ## 登录面的「聪明」之处(与弹窗同一套规则)
 *
 *  - **已登录**:只有一行身份(头像 + `@login` + 非 dot-com 实例的端点),右边「退出登录」。
 *    登录表单整块**不出现** —— 改前同屏既有「已登录 @x」又摆着「请输入访问令牌」。
 *  - **未登录**:一行主操作「登录 GitHub.com」(`onEnterpriseSignIn`:端点是 github.com 时
 *    走设备码,否则**不静默登 github.com**,改为展开令牌表单并说明原因),
 *    下面一行「令牌登录」(展开 / 收起),展开后才是端点 + 令牌 + 提交。
 *  - 设备码进行中:多两行(用户码 + 授权链接提示);失败与结果由各自的提示行说话。
 *
 * @module dsh-git/client/settings-account
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { getDotComAPIEndpoint } from '../core/desktop/lib/api.ts';
import {
  avatarUrlFor, useAccountEmails, useAppInstallation, useEnterpriseSignIn,
} from './account-emails.tsx';
import type { Translate } from './i18n.ts';
import { hostAuthOf, startDeviceSignIn, useDeviceSignIn } from './preferences-pages.tsx';
import type { IDshGitSettingsStoreLike } from './settings-controller.ts';
import {
  ActionRow, LiveInputRow, NoteRow, SettingsGroup, WarnNote,
} from './settings-rows.tsx';

/**
 * 【账号】分组。
 * @param props - 文案、全局 store 与「偏好变了」回调。
 * @returns 那一组。
 */
export function SettingsAccountGroup(props: {
  readonly t: Translate;
  readonly store: IDshGitSettingsStoreLike;
  readonly onPreferencesChanged: () => void;
}): ReactNode {
  const { t, store, onPreferencesChanged } = props;
  /** store 里那一份**原始**登录态(引用稳定,可直接当 `getSnapshot` 的返回值)。 */
  const rawAuth = useSyncExternalStore(
    store.subscribe,
    useCallback(() => store.snapshot().auth, [store]),
  );
  const auth = hostAuthOf(rawAuth);
  const [loadFailed, setLoadFailed] = useState(false);
  /**
   * 账号邮箱与 GitHub App 安装状态 —— 与弹窗那一页**同一对钩子**。
   *
   * 只在已登录时发请求(`enabled`;未登录时 host 会回 `not-signed-in`,省掉一次往返)。
   * 它们的失败/未安装就是用户截图里那句「读取账号邮箱失败:Token 已失效,请重新登录。」——
   * 2026-10-13 之前设置页**完全没有**这块信息(用户反馈的「缺了很多东西」)。
   */
  const emails = useAccountEmails(auth !== null);
  const installation = useAppInstallation(auth !== null);
  const reloadEmails = emails.reload;
  const reloadInstallation = installation.reload;

  /* 挂载后拉一次登录态;失败只记一条(不抛、不把整页带走)。 */
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        await store.loadAuth();
      } catch {
        if (live) {
          setLoadFailed(true);
        }
      }
    })();
    return () => { live = false; };
  }, [store]);

  /**
   * 设备码状态机从弹窗那条链路**借来**(`preferences-pages.tsx:623-719`),本页只喂 store。
   *
   * ⚠️ `useDeviceSignIn` 的形参是**窄的** `IDeviceSignInStore`(`setAuth` / `loadRemoteRepos` /
   * `toast`),本页拿到的 store 面正好有这三条 ⇒ 直接传,不需要任何断言。
   * 那条窄接口是 2026-10-13 为了这一处**从 `IPreferencesStore` 收窄出来**的。
   */
  const device = useDeviceSignIn(store, startDeviceSignIn);
  /**
   * 端点 + 令牌状态机(**与弹窗同一个钩子**)。
   *
   * `onSignedIn` 里的四件事与弹窗的 `onEnterpriseSignedIn`
   * (`preferences-pages.tsx:1068-1074`)**逐条同形**:写登录态 → 刷新远端清单 → 轻提示
   * (文案走字典的 `settings.account.signedInAs`)→ 让本页重渲染。
   * `onDeviceSignIn` 就是上面那条设备码链路的起点。
   */
  const onSignedIn = useCallback((state: { readonly login: string } & Parameters<IDshGitSettingsStoreLike['setAuth']>[0]) => {
    store.setAuth(state);
    void store.loadRemoteRepos(true);
    store.toast(t('settings.account.signedInAs', { login: state.login }));
    // 换账号之后邮箱与安装状态都可能不同 ⇒ 两个都重拉(与弹窗的 `onEnterpriseSignedIn` 同四件事)。
    reloadEmails();
    reloadInstallation();
    onPreferencesChanged();
  }, [store, t, reloadEmails, reloadInstallation, onPreferencesChanged]);
  const signIn = useEnterpriseSignIn({ onSignedIn, onDeviceSignIn: device.start });

  /**
   * 退出登录:host 删令牌,然后**重新读**登录态(登录态只有一个真源)。
   *
   * 两条失败各自兜住:登出失败只记一条(界面会因 re-read 如实显示仍然登录);
   * 读失败复用挂载时那条加载失败文案(字典里没有「登出失败」的键,不新造)。
   */
  const onLogout = useCallback((): void => {
    void (async () => {
      try {
        await store.logout();
      } catch (error) {
        console.warn(`[dsh-git] 退出登录失败:${String(error)}`);
      }
      try {
        await store.loadAuth();
      } catch {
        setLoadFailed(true);
      }
      // 登出后邮箱与安装状态也要跟着重读(登出 ⇒ 两个钩子的 `enabled` 变 false,自然清空)。
      reloadEmails();
      reloadInstallation();
    })();
  }, [store, reloadEmails, reloadInstallation]);

  /** 设备码那条链路的失败(设备码状态机自己的 `error` 态)。 */
  const deviceFailure = device.state.kind === 'error'
    ? t('settings.account.signInFailed', { message: device.state.message })
    : null;
  /** 设备码进行中(要显示用户码与授权链接)。 */
  const deviceWaiting = device.state.kind === 'waiting' ? device.state : null;

  return (
    <SettingsGroup id="gw-plugin-settings-account" title={t('settings.group.account')}>
      {/*
        身份行:登录态的唯一真源是 store 快照。
        ⭐ 头像(2026-10-13 用户反馈「账户部分缺失了信息,应该有头像的」):地址来自
        `avatarUrlFor(login)`,与镜像 `Accounts` 页(`ui/preferences/accounts.tsx:86-101`
        的 `Avatar` + `Account.avatarURL`)用的是**同一个函数** ⇒ 两处头像必然一致。
        `alt=""`:登录名就在旁边,读屏再念一遍图片是噪音。
        退出登录放在**同一行**的右侧(改前它单独占一行,与身份行之间空一大截)。
      */}
      <div className="gw-plugin-settings-row">
        {auth === null ? null : (
          <img className="gw-plugin-settings-avatar" src={avatarUrlFor(auth.login)} alt="" />
        )}
        <div className="gw-plugin-settings-rowtext">
          <span className="gw-plugin-settings-rowlabel">
            {auth === null ? t('settings.account.signedOut') : `@${auth.login}`}
          </span>
          {auth === null
            ? <span className="gw-plugin-settings-rowhint">{t('settings.account.identity')}</span>
            : auth.endpoint === undefined || auth.endpoint === getDotComAPIEndpoint()
              ? null
              : <span className="gw-plugin-settings-rowhint">{auth.endpoint}</span>}
        </div>
        {/*
          两个按钮**同一行**(与弹窗那一行的信息量对齐):
          「退出登录」只在已登录时有;「PAT 令牌登录」**两种状态都在** ——
          它就是 `patOpen` 的唯一开关,已登录时用来**换账号**(弹窗里那两个按钮也是并排的)。
        */}
        <div className="gw-plugin-settings-actions">
          {auth === null ? null : (
            <button type="button" className="gw-plugin-settings-button" onClick={onLogout}>
              {t('settings.account.signOut')}
            </button>
          )}
          <button type="button" className="gw-plugin-settings-button" onClick={signIn.onTogglePat}>
            {signIn.patOpen
              ? t('settings.account.patHide')
              : t('settings.account.patShow')}
          </button>
        </div>
      </div>

      {/*
        登录面**只在未登录时出现** —— 这就是「聪明一点」那一条:
        改前已登录也照样摆着端点输入框与令牌输入框,同屏自相矛盾。
        「登录 GitHub.com」接的是 `device.start`(与弹窗的 `onDotComSignIn` 同一处接线)。
      */}
      {auth === null ? (
        <ActionRow
          label={t('settings.account.signIn')}
          hint={t('settings.account.signIn.hint')}
          actionLabel={t('settings.account.signInAction')}
          disabled={device.state.kind === 'starting'}
          onAction={device.start}
        />
      ) : null}

      {/* 设备码进行中:用户码 + 授权链接(与弹窗的设备码面板同一份状态)。 */}
      {deviceWaiting === null ? null : (
        <>
          <NoteRow>
            {t('settings.account.device.code')}: <b>{deviceWaiting.userCode}</b>
          </NoteRow>
          <NoteRow>
            {t('settings.account.device.hint', { uri: deviceWaiting.verificationUri })}
          </NoteRow>
        </>
      )}

      {/*
        GitHub Enterprise:弹窗那一页的小节标题 + 说明 + CTA,这里收成**一行**
        (标题 = 行标签、说明 = 提示、CTA = 右侧按钮)。
        ⚠️ 接的是 `signIn.onEnterpriseSignIn`(**不是** `device.start`):端点不是
        github.com 时它会展开令牌表单并说明原因,而 `device.start` 只会静默登 github.com。
      */}
      <ActionRow
        label={t('settings.account.enterprise')}
        hint={t('settings.account.enterprise.hint')}
        actionLabel={t('settings.account.enterpriseSignIn')}
        onAction={signIn.onEnterpriseSignIn}
      />

      {signIn.patOpen ? (
        /*
         * 整块就是一个 `<form>`:提交处理器直接接状态机的 `onSubmit`
         * (与弹窗的 `PatSignInForm` 同结构 —— 那里也是把块包在 form 里),
         * 于是「按回车」与「点登录」走同一条路,两个输入框里回车都算提交。
         */
        <form className="gw-plugin-settings-form" onSubmit={signIn.onSubmit}>
          <LiveInputRow
            id="gw-plugin-settings-account-endpoint"
            label={t('settings.account.endpoint')}
            hint={t('settings.account.endpoint.hint')}
            value={signIn.endpoint}
            placeholder="github.example.com"
            disabled={signIn.busy}
            onChange={signIn.onEndpointInput}
          />
          <LiveInputRow
            id="gw-plugin-settings-account-token"
            label={t('settings.account.token')}
            hint={t('settings.account.token.hint')}
            value={signIn.pat}
            type="password"
            disabled={signIn.busy}
            inputRef={signIn.patInputRef}
            onChange={signIn.onPatInput}
          />
          <ActionRow
            label={t('settings.account.tokenSignIn')}
            actionLabel={t('settings.account.signInAction')}
            disabled={signIn.busy}
            submit={true}
          />
        </form>
      ) : null}

      {/*
        两条**提示行**(弹窗里由 `AccountNotice` 渲染的那两条),读的是同一对钩子:
        ① 邮箱读失败(截图上那句就是它);② GitHub App 未安装(带安装链接)。
        文案按同一意思写,但**渲染**是本页自己的宿主风格行 —— 不复用移植面的
        `AccountNotice`(那会同时违«不复用别人的 CSS»与探针的阴性判据)。
      */}
      {emails.result !== null && emails.result.kind === 'error' ? (
        <WarnNote alert={true}>
          {t('settings.account.emailsFailed', { message: emails.result.message })}
        </WarnNote>
      ) : null}
      {installation.status !== null && installation.status.kind === 'not-installed' ? (
        <WarnNote alert={true}>
          {t('settings.account.appNotInstalled')}
          {installation.status.installUrl === '' ? (
            <> {t('settings.account.appInstallNoUrl')}</>
          ) : (
            <>
              {' '}{t('settings.account.appInstall')}{' '}
              <a href={installation.status.installUrl} target="_blank" rel="noreferrer noopener">
                {installation.status.installUrl}
              </a>
            </>
          )}
        </WarnNote>
      ) : null}

      {/* 结果行:端点 + 令牌那条链路自己给的文案与语气(与弹窗同一份)。 */}
      {signIn.status === null ? null : (
        <NoteRow>
          <span className={`gw-plugin-settings-status gw-plugin-settings-status-${signIn.statusKind}`}>
            {signIn.status}
          </span>
        </NoteRow>
      )}
      {deviceFailure === null ? null : (
        <p className="gw-plugin-settings-gerror" role="status">{deviceFailure}</p>
      )}
      {loadFailed ? (
        <p className="gw-plugin-settings-gerror" role="status">{t('settings.account.loadFailed')}</p>
      ) : null}
    </SettingsGroup>
  );
}
