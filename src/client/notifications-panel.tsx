/**
 * **Notifications 页**(偏好设置 ▸ 通知)。
 *
 * ## 上游是什么样,这里为什么不一样
 *
 * 上游 `references/desktop/app/src/ui/preferences/notifications.tsx`(149 行)的骨架是:
 *
 * ```
 * <DialogContent><div className="advanced-section">
 *   <h2>Notifications</h2>
 *   <Checkbox label="Enable notifications" … />
 *   <p className="settings-description">Allows the display of notifications …{hint}</p>
 * </div></DialogContent>
 * ```
 *
 * 其中 `hint` 是**权限三态**(`:89-148`):未授权 ⇒ 给一个 `grant permission` 链接;
 * 已拒绝 ⇒ 警告 + 去「通知设置」;已授权 ⇒ 「请确认系统里为它开了通知」。
 *
 * **不变的是**:页面结构、开关语义、权限三态那三分支、以及「开关关掉时 hint 一句都不显示」
 * (上游 `:92-94`)。
 *
 * **变的是**:权限的来源。上游走 Electron 原生插件(`desktop-notifications` +
 * `main-process-proxy` 的 `requestNotificationsPermission`),而那两样在我们的替身里
 * **恒 false** —— 沿用就是一个死开关。浏览器有真正的 Web Notifications API
 * (`Notification.requestPermission()` / `Notification.permission`),所以这里换成它。
 * 三态一一对应:`'default' | 'granted' | 'denied'`,外加一个上游也有的
 * 「环境不支持」态。
 *
 * ⚠️ **一处如实的不一样**:上游那两处 `LinkButton` 指向
 * `getNotificationSettingsUrl()`(Electron 能拿到系统通知设置的 deep link)。
 * 浏览器**没有**等价物 —— 网页不能深链到浏览器自己的站点权限页。所以这里
 * **不画链接**(画一个点了没反应的链接正是本仓禁止的那类控件),改成把路径写清楚:
 * 地址栏左侧的站点设置 → 通知 → 允许。
 *
 * ## 为什么这一页不止一个开关(本仓硬纪律)
 *
 * 「可见但无作用的控件」是本项目反复点名的静默缺陷类。一个只有 Checkbox 的通知页
 * 恰好是那个形状:**打开它,什么都不会发生**。所以这一页必须同时给出
 *  (a) 生产者真的存在(见 `notify.ts` 的 `ensureSyncNotificationBridge`)、
 *  (b) 一条**当场可验**的投递路径(下面的「发送测试通知」按钮,它走的是与真实通知
 *      **完全相同**的 `deliverNotification()`,只跳过「你在不在看窗口」那一条)。
 * 于是「开关开了但永不触发」有三种当场可辨的下场:权限没给 / 偏好是关的 / 拦截器没装上
 * —— 每一种都在这一页上有自己的一句话。
 *
 * @see src/client/notify.ts —— 偏好、权限、生产者(本页只做界面)
 * @module dsh-git/client/notifications-panel
 */

import { createElement, useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';

import { Checkbox, CheckboxValue } from '../core/desktop/ui/lib/checkbox.tsx';
import { LinkButton } from '../core/desktop/ui/lib/link-button.tsx';

import {
  getNotificationPermission,
  getNotificationsSent,
  isSyncNotificationBridgeInstalled,
  notifyTest,
  requestNotificationPermission,
  setNotificationsEnabled,
  useNotificationsEnabled,
  type NotificationOutcome,
  type NotificationPermissionState,
} from './notify.ts';

/** 权限三态(+ 不支持)的中文说法,给提示行与测试结果共用。 */
const PERMISSION_LABELS: Readonly<Record<NotificationPermissionState, string>> = {
  unsupported: '此浏览器不提供通知',
  default: '尚未授权',
  granted: '已授权',
  denied: '已被浏览器拒绝',
};

/** {@link NotificationsPanel} 的输入。 */
export interface INotificationsPanelProps {
  /**
   * 「某个显示类偏好变了,请让整棵 workbench 重新渲染一次」。
   *
   * 与 `preferences-pages.tsx` 的 `useAccessibilityWiring` 收到的是**同一条**信号,
   * 理由也相同:开关的写入方(本面板)与消费方(diff / 顶栏)不在同一棵子树里。
   * 这里经 ref 取最新那个,于是本面板的回调身份与 props 无关。
   */
  readonly onPreferencesChanged: () => void;
}

/** 把一次投递结果翻成一句**说清原因**的话(「没反应」在这一页不允许出现)。 */
export function describeNotificationOutcome(outcome: NotificationOutcome): string {
  switch (outcome.kind) {
    case 'sent':
      return '已发出。如果系统通知中心里没有,请检查系统的「勿扰 / 专注模式」。';
    case 'disabled':
      return '没有发出 —— 上面的「启用通知」是关的。打开它再试一次。';
    case 'no-permission':
      return `没有发出 —— 浏览器权限是「${PERMISSION_LABELS[outcome.permission]}」。先点上面的「授予权限」。`;
    case 'skipped-visible':
      return '没有发出 —— 你正在看着这个窗口;通知只在窗口不可见时发。';
    case 'unavailable':
      return '没有发出 —— 这个浏览器上下文不提供 Web Notifications API。';
    case 'failed':
      return `没有发出 —— 浏览器拒绝构造通知:${outcome.message}`;
    default:
      return '没有发出 —— 原因未知。';
  }
}

/**
 * Notifications 页的正文。
 *
 * 与上游的 `Notifications` 类组件同构,但它是函数组件 + 自己的偏好钩子
 * (上游的值经 props 从 `AppStore` 来;我们这边偏好住在 `notify.ts` 的
 * `useSyncExternalStore` 上,与无障碍页那两条是同一套机制)。
 *
 * @param props - 见 {@link INotificationsPanelProps}。
 */
export function NotificationsPanel(props: INotificationsPanelProps): ReactNode {
  const enabled = useNotificationsEnabled();
  const [permission, setPermission] = useState<NotificationPermissionState>(
    () => getNotificationPermission(),
  );
  const [outcome, setOutcome] = useState<NotificationOutcome | null>(null);
  const [sent, setSent] = useState<number>(() => getNotificationsSent());

  /** 卸载后不再 setState(权限请求与投递都是异步的)。 */
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /** `onPreferencesChanged` 的最新值(理由见 prop 的注释)。 */
  const latestChanged = useRef(props.onPreferencesChanged);
  latestChanged.current = props.onPreferencesChanged;

  /**
   * 权限可能在**这一页之外**被改(浏览器地址栏的站点设置、别的标签页)。
   * 窗口重新获得焦点或页面重新可见时回读一次真值,免得这里长期显示一个过期的三态。
   */
  useEffect(() => {
    const sync = (): void => {
      setPermission(getNotificationPermission());
    };
    window.addEventListener('focus', sync);
    document.addEventListener('visibilitychange', sync);
    return () => {
      window.removeEventListener('focus', sync);
      document.removeEventListener('visibilitychange', sync);
    };
  }, []);

  const onEnabledChanged = useCallback((event: FormEvent<HTMLInputElement>) => {
    setNotificationsEnabled(event.currentTarget.checked);
    latestChanged.current();
  }, []);

  const onGrantPermission = useCallback(() => {
    void (async () => {
      const next = await requestNotificationPermission();
      if (alive.current) {
        setPermission(next);
      }
    })();
  }, []);

  const onSendTest = useCallback(() => {
    const result = notifyTest();
    setOutcome(result);
    setSent(getNotificationsSent());
  }, []);

  const bridgeInstalled = isSyncNotificationBridgeInstalled();

  return (
    <div className="advanced-section">
      <h2>通知</h2>
      <Checkbox
        label="启用通知"
        value={enabled ? CheckboxValue.On : CheckboxValue.Off}
        onChange={onEnabledChanged}
      />
      <p className="settings-description">
        当你在别处、而当前仓库的后台同步(fetch / pull / push / clone)完成时,允许显示一条通知。
        {renderPermissionHint(enabled, permission, onGrantPermission)}
      </p>

      {/*
        下面这两行不是装饰:它们是「开关打开之后到底会不会响」的**当场可读证据**。
        上游没有这一段(上游的生产者是 alive 事件服务),所以我们自己给;
        文案里的「已装载 / 没装上」直接读 `isSyncNotificationBridgeInstalled()`,
        「已发出」直接读 `getNotificationsSent()` —— 都是真值,不是写死的。
      */}
      <p className="settings-description">
        浏览器权限:{PERMISSION_LABELS[permission]}。触发时机:后台完成 fetch / pull / push /
        clone,且本窗口不被看见时
        {bridgeInstalled
          ? '(已在四条同步路由上装载拦截器)。'
          : '(⚠️ 拦截器没装上 —— 开关是开的,但没有任何东西在发)。'}
      </p>
      <p className="settings-description">本次会话已发出 {sent} 条通知。</p>

      <div className="gw-formrow">
        <button className="gw-btn" onClick={onSendTest}>
          发送测试通知
        </button>
      </div>
      {outcome !== null && (
        <p
          className={outcome.kind === 'sent' ? 'settings-description' : 'setting-hint-warning'}
          role="status"
          aria-live="polite"
        >
          {describeNotificationOutcome(outcome)}
        </p>
      )}
    </div>
  );
}

/**
 * 权限提示 —— 逐条对应上游 `notifications.tsx:89-148` 的三个分支。
 *
 * 上游在开关**关掉**或环境不支持时直接 `return null`(`:92-94`),这里沿用:
 * 开关关着的时候不再拿权限的事烦用户。
 *
 * @param enabled - 「启用通知」当前值。
 * @param permission - 浏览器权限三态。
 * @param onGrant - 点「授予权限」时调(必须来自 `useCallback`,`react/jsx-no-bind`)。
 */
function renderPermissionHint(
  enabled: boolean,
  permission: NotificationPermissionState,
  onGrant: () => void,
): ReactNode {
  if (!enabled) {
    return null;
  }
  switch (permission) {
    case 'unsupported':
      return ' 这个浏览器上下文不提供 Web Notifications API,通知在此不可用。';
    case 'default':
      return (
        <>
          {' '}
          还需要你
          {/*
            ⚠️ **这里用 `createElement` 而不是 JSX,不是为了风格**:镜像的
            `ILinkButtonProps`(`ui/lib/link-button.tsx:8-36`)**没有声明 `children`**,
            而上游跑的是 `@types/react@^16.14.62`(那一代的类组件隐式接受 children)。
            我们钉的是 `@types/react@18.3.31`,它要求显式声明 ⇒
            `<LinkButton>…</LinkButton>` 会多出一条 TS2769。
            `createElement` 的 children 走第三个**可变参数**重载,类型上成立,
            且产出的 DOM 与 JSX **逐字相同**。同一处取舍与理由见
            `src/client/hidden-changes-warning.tsx:258-268`(那里也是这么写的)。
          */}
          {createElement(LinkButton, { onClick: onGrant }, '授予权限')}
          才能显示这些通知。
        </>
      );
    case 'denied':
      return (
        <span className="setting-hint-warning">
          <span className="warning-icon">⚠️</span> 浏览器已拒绝本站的通知权限,本插件无法再主动申请。
          请点地址栏左侧的站点设置图标,把「通知」改成「允许」,然后回到本页(权限栏会自动刷新)。
        </span>
      );
    case 'granted':
      return ' 浏览器已授权;若系统开了「勿扰 / 专注模式」,通知仍可能不显示。';
    default:
      return null;
  }
}
