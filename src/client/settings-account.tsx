/**
 * 设置页的【账号】分组 —— 登录态 / 退出登录 / 设备码登录 / 令牌(PAT)登录。
 *
 * ## 契约(由 `settings-page.tsx` 传入)
 *
 * | prop | 说明 |
 * |---|---|
 * | `t` | 命名空间 `dsh-git` 的文案函数(键见 `i18nZh.ts` 的 `settings.account.*`) |
 * | `store` | 本插件的**全局 store**(`IDshGitSettingsStoreLike`):`subscribe` / `snapshot` / `loadAuth` / `setAuth` / `loadRemoteRepos` / `toast` / `logout` |
 * | `onPreferencesChanged` | 让设置页重渲染 |
 *
 * ⚠️ 登录态**必须从 store 的订阅里读**(不要只在挂载时 `store.snapshot()` 拍一张):
 * 同一条链路上别处也会改它(设备码轮询成功、弹窗里登录)。用
 * `useSyncExternalStore(store.subscribe, () => store.snapshot().auth)` —— 返回的是
 * store 快照里那个**字段**,引用稳定;然后再 `hostAuthOf(raw)` 收窄(每次调用会新建对象,
 * **不能**直接当 `getSnapshot` 的返回值,那会无限重渲染)。
 *
 * 读不到 auth 时(宿主半没起来 / 还没读过)在挂载后触发一次 `store.loadAuth()`,
 * 并且**兜住失败**(卡片是附加能力,不能因为一次路由失败把整页带走)。
 *
 * ## 这一组有哪几行(顺序即上屏顺序)
 *
 * | 行 | 什么时候出现 | 动作落点 |
 * |---|---|---|
 * | 当前账号 | 总是 | 只读(已登录 `@login` / 未登录文案) |
 * | 退出登录 | 已登录 | `store.logout()` → `store.loadAuth()` |
 * | 登录 GitHub.com | 未登录 | 设备码状态机(`device.start`) |
 * | 设备码面板 | 状态机 `waiting` | 用户码 + 授权链接提示 |
 * | 企业实例地址 + 登录 GitHub Enterprise | 总是 | `api.setPat(token, endpoint)` |
 * | 个人访问令牌(PAT) + 用令牌登录 | 总是 | 同上 |
 *
 * 设备码那半**借的是弹窗那条链路**(`preferences-pages.tsx` 的 `useDeviceSignIn` /
 * `startDeviceSignIn`),这里不写第二份轮询;PAT 成功后的三件事与弹窗的
 * `onEnterpriseSignedIn`(`preferences-pages.tsx:1068-1074`)对齐。
 *
 * ⚠️ `api.authPat(...)` 在 `./api.ts` 里**不存在**:PAT 登录的真名是
 * `api.setPat(token, endpoint?)`(`api.ts:1262-1263`),本文件按真名调。
 *
 * @module dsh-git/client/settings-account
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { api } from './api.ts';
import type { Translate } from './i18n.ts';
import { hostAuthOf, startDeviceSignIn, useDeviceSignIn } from './preferences-pages.tsx';
import type { IDshGitSettingsStoreLike } from './settings-controller.ts';
import { ActionRow, FlashNote, NoteRow, SettingsGroup, TextRow } from './settings-rows.tsx';

/**
 * 【账号】分组(登录态 / 退出登录 / 设备码 / 企业端点 + PAT)。
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
  /** 一次性的失败回声(设备码 / PAT;`null` = 不上屏)。 */
  const [failure, setFailure] = useState<string | null>(null);
  /** 企业实例端点的**原始输入**(规范化由 host 做:`api.ts:1254-1261`)。 */
  const [endpoint, setEndpoint] = useState('');
  /** PAT 输入框的内容;提交时才读(`TextRow` 失焦 / 回车才提交)。 */
  const [token, setToken] = useState('');
  /** 正在提交 PAT(同时禁掉两个输入与两个按钮,避免重复提交)。 */
  const [busy, setBusy] = useState(false);

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

  /*
   * 设备码状态机从弹窗那条链路**借来**(`preferences-pages.tsx:623-719`),本页只喂 store。
   *
   * ⚠️ `useDeviceSignIn` 的形参是**窄的** `IDeviceSignInStore`(`setAuth` / `loadRemoteRepos` /
   * `toast`),本页拿到的 store 面正好有这三条 ⇒ 直接传,不需要任何断言。
   * 那条窄接口是 2026-10-13 为了这一处**从 `IPreferencesStore` 收窄出来**的
   * (第一版写的是 `store as unknown as IPreferencesStore`,而断言是「类型面在说谎」的开端)。
   */
  const device = useDeviceSignIn(store, startDeviceSignIn);

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
    })();
  }, [store]);

  /**
   * PAT 登录 —— **两个按钮共用这一条实现**(企业按钮只是把端点一起带上)。
   *
   * 端点为空 ⇒ 传 `undefined`(`api.setPat` 省略 `endpoint` = 沿用当前账号端点,
   * `api.ts:1259-1260`);非空 ⇒ 原样交给 host 归一化。
   *
   * 成功后三件事与 `preferences-pages.tsx` 的 `onEnterpriseSignedIn`(`:1068-1074`)
   * 逐字同形:`setAuth` → `loadRemoteRepos(true)` → `toast(signedInAs)`;设置页没有
   * 邮箱 / 安装状态那两个面板,所以第四件换成「让本页重渲染」。
   */
  const signInWithToken = useCallback((): void => {
    void (async () => {
      const pat = token.trim();
      if (pat === '') {
        return;
      }
      const target = endpoint.trim();
      setBusy(true);
      setFailure(null);
      try {
        const result = await api.setPat(pat, target === '' ? undefined : target);
        if (!result.ok) {
          setFailure(t('settings.account.signInFailed', { message: result.error.message }));
          return;
        }
        const state = result.value;
        store.setAuth(state);
        void store.loadRemoteRepos(true);
        store.toast(t('settings.account.signedInAs', { login: state.login }));
        setToken('');
        onPreferencesChanged();
      } catch (error) {
        console.warn(`[dsh-git] 令牌登录失败:${String(error)}`);
        setFailure(t('settings.account.signInFailed', { message: String(error) }));
      } finally {
        setBusy(false);
      }
    })();
  }, [endpoint, onPreferencesChanged, store, t, token]);

  /** 端点输入提交(只在提交时固化,与 `TextRow` 的失焦/回车语义一致)。 */
  const onEndpointCommit = useCallback((value: string): void => { setEndpoint(value); }, []);
  /** 令牌输入提交。 */
  const onTokenCommit = useCallback((value: string): void => { setToken(value); }, []);

  /** 设备码面板只在 `waiting` 有内容(码 + 授权链接;`starting` 一瞬而过)。 */
  const deviceWaiting = device.state.kind === 'waiting' ? device.state : null;
  /** 设备码失败态也走同一句 `signInFailed`。 */
  const deviceFailure = device.state.kind === 'error'
    ? t('settings.account.signInFailed', { message: device.state.message })
    : null;

  return (
    <SettingsGroup id="gw-settings-account" title={t('settings.group.account')}>
      {/* 只读的身份行:登录态的唯一真源是 store 快照,这一行不带控件。 */}
      <div className="gw-settings-row">
        <div className="gw-settings-rowtext">
          <span className="gw-settings-rowlabel">{t('settings.account.identity')}</span>
          <span className="gw-settings-rowhint">
            {auth === null ? t('settings.account.signedOut') : `@${auth.login}`}
          </span>
        </div>
      </div>

      {/*
        「登录 GitHub.com」直接接状态机的 `start`(成员表达式,`react/jsx-no-bind` 放行):
        它内部就是 `startDeviceSignIn(accept, onError)`(`preferences-pages.tsx:648-658`),
        所以 `start` → `accept(started)` 这条线不需要在本页重写。
      */}
      {auth === null ? (
        <ActionRow
          label={t('settings.account.signIn')}
          hint={t('settings.account.signIn.hint')}
          actionLabel={t('settings.account.signInAction')}
          onAction={device.start}
        />
      ) : (
        <ActionRow
          label={t('settings.account.signOut')}
          actionLabel={t('settings.account.signOut')}
          onAction={onLogout}
        />
      )}

      {deviceWaiting === null ? null : (
        <>
          <NoteRow>
            {t('settings.account.device.code')}: <b>{deviceWaiting.userCode}</b>
          </NoteRow>
          {/* 提示里带 `{uri}`(授权链接);浏览器弹窗被拦时它就指路。 */}
          <NoteRow>{t('settings.account.device.hint', { uri: deviceWaiting.verificationUri })}</NoteRow>
        </>
      )}

      <TextRow
        id="gw-settings-account-endpoint"
        label={t('settings.account.endpoint')}
        hint={t('settings.account.endpoint.hint')}
        value={endpoint}
        placeholder="github.example.com"
        disabled={busy}
        onCommit={onEndpointCommit}
      />
      <ActionRow
        label={t('settings.account.enterpriseSignIn')}
        actionLabel={t('settings.account.signInAction')}
        disabled={busy}
        onAction={signInWithToken}
      />

      <TextRow
        id="gw-settings-account-token"
        label={t('settings.account.token')}
        hint={t('settings.account.token.hint')}
        value={token}
        disabled={busy}
        onCommit={onTokenCommit}
      />
      <ActionRow
        label={t('settings.account.tokenSignIn')}
        actionLabel={t('settings.account.signInAction')}
        disabled={busy}
        onAction={signInWithToken}
      />

      {/* 一次性反馈:设备码失败与 PAT 失败共用一行(两者不会同时是新的)。 */}
      <FlashNote message={failure ?? deviceFailure} />
      {loadFailed ? <p className="gw-settings-gerror" role="status">{t('settings.account.loadFailed')}</p> : null}
    </SettingsGroup>
  );
}
