/**
 * **通知偏好 + 通知生产者**(本插件唯一的「真的会弹出通知」的一处)。
 *
 * ## 为什么这一页需要「生产者」才算做完
 *
 * 上游 `ui/preferences/notifications.tsx` 只有一个 Checkbox,真正发通知的是
 * `lib/stores/notifications-store.ts`(GitHub 的 alive 事件:检查失败 / PR review /
 * PR 评论)。那个服务在我们的替身里**不存在**。本仓的硬纪律是
 * 「不留看到了但不生效的控件」⇒ 一个只有开关的 Notifications 页**不算做完**,
 * 必须同时有一条**真的会响**的路径。
 *
 * 我们的生产者(裁决与理由):
 *
 * | # | 触发 | 为什么选它 |
 * |---|---|---|
 * | 1 | `fetch` / `pull` / `push` / `clone` **完成**时,且用户**不在看这个窗口** | 这是本插件今天最接近上游「高信号事件」的东西:它由用户自己的动作发起、耗时、结果重要,而「完成后你正好切走了」是最需要通知的时刻。选它还有一个决定性理由:**它不需要改任何别人持有的文件**(见下) |
 *
 * ## ⚠️ 生产者是怎么接上的(以及为什么是这样接的)
 *
 * 上游在 `store.ts` 的 `_fetch` / `_pull` 里直接调 `showNotification`。我们的
 * `store.ts` **不在本泳道的可改文件里**(另两条泳道正在改它),所以本文件改走
 * 「**给 `api` 的四条同步路由套一层**」:
 *
 * ```
 * index.ts → host-settings-card.tsx → preferences-pages.tsx → notifications-panel.tsx → 本文件
 * ```
 *
 * `index.ts:31` 静态 import 了卡片外壳,卡片外壳静态 import 了页面正文,页面正文
 * (阶段 2 起)import 本面板 ⇒ **本模块在插件注册时就加载**,`ensureSyncNotificationBridge()`
 * 在那一刻装好包装。于是「用户在设置里打开开关」与「拦截器在不在」互不依赖 ——
 * 开关一开,**当场生效**,不必等谁再去接一根线。
 *
 * 包装是**精确**的:只包 `api` 的四个方法(不碰全局 `fetch` —— 那会被
 * `.eslintrc.yml` 的 `no-restricted-syntax` 拦下,而且会连宿主别的请求一起管)。
 *
 * ### 回收条件
 *
 * `store.ts` 或 `toolbar.tsx` 的持有者愿意在 `_fetch` / `_pull` / `_push` / `_clone`
 * 的完成处直接调 {@link notifySyncFinished} 时:
 *  1. 删掉 {@link ensureSyncNotificationBridge} 与文件末尾那一次调用;
 *  2. 保留本文件其余部分(偏好、权限三态、`deliver()` 都不变)。
 * 在那之前,**不许**把这条包装当成临时脚手架删掉 —— 删了开关就重新变成假开关。
 *
 * ## 偏好键与默认值(与上游一致上游)
 *
 * `references/desktop/app/src/lib/stores/notifications-store.ts:63,66-67`:
 *
 * ```
 * const NotificationsEnabledKey = 'high-signal-notifications-enabled'
 * export function getNotificationsEnabled() {
 *   return getBoolean(NotificationsEnabledKey, true)
 * }
 * ```
 *
 * ⇒ 键名 {@link NOTIFICATIONS_ENABLED_KEY}、默认值 **true**
 * ({@link NOTIFICATIONS_ENABLED_DEFAULT})都与上游一致。默认开是**故意**的:
 * 上游就是默认开,而「默认开 + 浏览器权限还没给」在这边**不会静默**:权限提示
 * (`notifications-panel.tsx` 的三态)会明说「还没授权,所以不会弹」,并给一个
 * 真正会调 `Notification.requestPermission()` 的按钮。
 *
 * ## 读写用的是**同一套**机制,不是第三套
 *
 * 订阅走 `prefs.ts` 的 {@link subscribePreference},写入广播同一个
 * `PREFERENCE_CHANGED_EVENT`(键名放 `detail`)。**为什么这里自己写了 6 行
 * `localStorage` 读写**:`prefs.ts` 的 `readRaw` / `writeRaw` **没有导出**,
 * 而 `prefs.ts` 不在本泳道的可改文件里。这 6 行与 `prefs.ts:45-64` 的两条原语
 * **逐字同形**(同样的 try/catch 兜底、同样的事件名与 `detail`),所以它不是
 * 「另一种模式」,而是同一个模式在缺一个导出时的就地展开。
 *
 * ### 回收条件
 *
 * `prefs.ts` 的持有者导出 `readRaw` / `writeRaw`(或直接在本文件里加一对
 * `getNotificationsEnabled()` / `setNotificationsEnabled()`)⇒ 删掉下面那 6 行。
 *
 * @see src/client/notifications-panel.tsx —— 这一层的界面(权限三态 + 测试按钮)
 * @module dsh-git/client/notify
 */

import { useSyncExternalStore } from 'react';

import { api } from './api.ts';
import type { ApiResult } from './api.ts';
import { PREFERENCE_CHANGED_EVENT, subscribePreference } from './prefs.ts';

// ---------------------------------------------------------------------------
// 偏好(键名与默认值与上游一致上游)
// ---------------------------------------------------------------------------

/** 上游 `notifications-store.ts:63` 的 `NotificationsEnabledKey`。 */
export const NOTIFICATIONS_ENABLED_KEY = 'high-signal-notifications-enabled';

/** 上游 `notifications-store.ts:67` 的默认值。 */
export const NOTIFICATIONS_ENABLED_DEFAULT = true;

/**
 * 读「启用通知」。
 *
 * `localStorage` 被禁用(隐私模式)或键不存在时回 {@link NOTIFICATIONS_ENABLED_DEFAULT}
 * —— **不许**在 read 里写回默认值,否则「探测一次」就会把默认值固化进存储,
 * 与 `prefs.ts` 的取合同(那条也只在 `set` 时才写)。
 */
export function getNotificationsEnabled(): boolean {
  try {
    const raw = window.localStorage.getItem(NOTIFICATIONS_ENABLED_KEY);
    if (raw === null) {
      return NOTIFICATIONS_ENABLED_DEFAULT;
    }
    return raw === 'true' || raw === '1';
  } catch {
    // 隐私模式/被禁用时 localStorage 会抛;退回默认值而不是崩。
    return NOTIFICATIONS_ENABLED_DEFAULT;
  }
}

/**
 * 写「启用通知」并**广播**(只写不广播 = 同页其它组件要刷新才看到,那是假接线)。
 * 与 `prefs.ts:53-64` 的 `writeRaw` 逐字同形,包括「写不进去也照广播」那条兜底。
 */
export function setNotificationsEnabled(value: boolean): void {
  try {
    window.localStorage.setItem(NOTIFICATIONS_ENABLED_KEY, value ? 'true' : 'false');
  } catch {
    // 写不进去就只在本次会话内生效。
  }
  try {
    window.dispatchEvent(new CustomEvent(PREFERENCE_CHANGED_EVENT, { detail: NOTIFICATIONS_ENABLED_KEY }));
  } catch {
    // 没有 window(SSR / 探针)时只持久化,不广播。
  }
}

/** 订阅「启用通知」的 React 钩子(与 `prefs.ts` 的三个钩子同一套)。 */
export function useNotificationsEnabled(): boolean {
  return useSyncExternalStore(
    (onChange) => subscribePreference(NOTIFICATIONS_ENABLED_KEY, onChange),
    getNotificationsEnabled,
    () => NOTIFICATIONS_ENABLED_DEFAULT,
  );
}

// ---------------------------------------------------------------------------
// 浏览器权限(这一层取代上游的 Electron `main-process-proxy`)
// ---------------------------------------------------------------------------

/**
 * 通知权限状态。
 *
 * `unsupported` 是**第四态**:上游 `supportsNotifications()` 也是先问
 * 「这个环境有没有通知能力」再问权限;浏览器里对应的是 `typeof Notification === 'undefined'`
 * (老 Safari / 被策略禁用的上下文)。少了这一态,界面会显示一个永远点不动的
 * 「授予权限」。
 */
export type NotificationPermissionState = 'unsupported' | 'default' | 'granted' | 'denied';

/** 本浏览器/上下文是否提供 Web Notifications API。 */
export function notificationsSupported(): boolean {
  return typeof Notification !== 'undefined';
}

/** 读当前权限(上游 `getNotificationsPermission()` 的浏览器对应物)。 */
export function getNotificationPermission(): NotificationPermissionState {
  if (!notificationsSupported()) {
    return 'unsupported';
  }
  const permission = Notification.permission;
  if (permission === 'granted' || permission === 'denied') {
    return permission;
  }
  return 'default';
}

/**
 * 请求权限(上游 `requestNotificationsPermission()` 的浏览器对应物)。
 *
 * ⚠️ 浏览器只在**用户手势**里接受这次调用;面板里那个按钮就是手势。失败不抛到
 * 调用方 —— 无论成败都**回读真实状态**,界面说的是浏览器给的事实,不是我们的期望。
 */
export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  if (!notificationsSupported()) {
    return 'unsupported';
  }
  try {
    await Notification.requestPermission();
  } catch {
    // 非用户手势里调用会被拒;下面回读真实状态即可。
  }
  return getNotificationPermission();
}

// ---------------------------------------------------------------------------
// 生产者
// ---------------------------------------------------------------------------

/** 会被通知的同步动作。 */
export type SyncKind = 'fetch' | 'pull' | 'push' | 'clone';

/** 每种动作完成后的说法。 */
const SYNC_LABELS: Readonly<Record<SyncKind, string>> = {
  fetch: '已获取远端更新',
  pull: '已拉取远端更新',
  push: '已推送本地提交',
  clone: '克隆完成',
};

/** 发一条通知时要的东西。 */
export interface INotificationRequest {
  /** 通知标题(浏览器里通常只显示这一行的粗体)。 */
  readonly title: string;
  /** 正文。 */
  readonly body: string;
  /** 去重标记:同一个 tag 的新通知会替换旧的,避免刷屏。 */
  readonly tag?: string;
}

/**
 * 一次投递的结果。**每一种都对应界面上一句不同的话** ——
 * 「点了没反应」在这一页是不允许的。
 */
export type NotificationOutcome =
  | { readonly kind: 'sent' }
  | { readonly kind: 'disabled' }
  | { readonly kind: 'no-permission'; readonly permission: NotificationPermissionState }
  | { readonly kind: 'skipped-visible' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'failed'; readonly message: string };

/** 已成功发出的条数(探针与界面用它证明「真的响过」)。 */
let sentCount = 0;

/** @returns 本次会话里成功构造过多少条通知。 */
export function getNotificationsSent(): number {
  return sentCount;
}

/**
 * 用户此刻**不在看这个窗口**吗。
 *
 * 两条判据都要:`visibilityState !== 'visible'` 是负责人指定的那条;
 * `document.hasFocus() === false` 覆盖「窗口露着但被别的应用盖住 / 在另一块屏上」——
 * 那同样是「你看不见结果」,而后台标签页在 Chrome 里 `visibilityState` 才是 hidden。
 * 两条都只描述「看不见」,**不判断**用户想不想收(那是偏好开关的事)。
 */
export function shouldNotifyForBackgroundResult(): boolean {
  if (typeof document === 'undefined') {
    return false;
  }
  return document.visibilityState !== 'visible' || document.hasFocus() === false;
}

/**
 * 投递一条通知(所有生产者的唯一出口)。
 *
 * 顺序刻意如此:**先**查偏好(用户说不收就一条都不构造),**再**查权限
 * (没授权就**不**构造 —— `new Notification()` 在 `denied` 下会抛 `TypeError`,
 * 那是能避开的异常),最后才是浏览器调用。
 *
 * @param request - 标题 / 正文 / 去重标记。
 * @param ignoreVisibility - `true` = 跳过「你在不在看」那一条,给面板的测试按钮用
 *   (那是用户**当面**点的,不存在「看不见」)。
 */
export function deliverNotification(
  request: INotificationRequest,
  ignoreVisibility: boolean,
): NotificationOutcome {
  if (!getNotificationsEnabled()) {
    return { kind: 'disabled' };
  }
  if (!notificationsSupported()) {
    return { kind: 'unavailable' };
  }
  const permission = getNotificationPermission();
  if (permission !== 'granted') {
    return { kind: 'no-permission', permission };
  }
  if (!ignoreVisibility && !shouldNotifyForBackgroundResult()) {
    return { kind: 'skipped-visible' };
  }
  try {
    const options: NotificationOptions = { body: request.body };
    if (request.tag !== undefined) {
      options.tag = request.tag;
    }
    // 构造即显示 —— 这就是 Web Notifications 的语义(不需要也不该保留返回值)。
    new Notification(request.title, options);
    sentCount += 1;
    return { kind: 'sent' };
  } catch (error) {
    return { kind: 'failed', message: String(error) };
  }
}

/** 从仓库绝对路径取一个给人看的短名(通知正文里用)。 */
export function repositoryLabel(repoPath: string): string {
  const trimmed = repoPath.replace(/[\\/]+$/, '');
  const parts = trimmed.split(/[\\/]/);
  const last = parts[parts.length - 1];
  return last === undefined || last === '' ? repoPath : last;
}

/**
 * 「某个同步动作在后台完成了」——**真正的生产者入口**。
 *
 * @param kind - fetch / pull / push / clone。
 * @param repoPath - 仓库绝对路径(只用来取显示名)。
 * @param detail - 失败时的原因;成功时省略。
 * @returns 投递结果(调用方不必处理,但探针与面板要用)。
 */
export function notifySyncFinished(
  kind: SyncKind,
  repoPath: string,
  detail?: string,
): NotificationOutcome {
  const repo = repositoryLabel(repoPath);
  const body = detail === undefined
    ? `${repo}:${SYNC_LABELS[kind]}`
    : `${repo}:${SYNC_LABELS[kind]}失败 —— ${detail}`;
  return deliverNotification({ title: 'dsh-git', body, tag: `dsh-git-sync-${kind}` }, false);
}

// ---------------------------------------------------------------------------
// 把生产者接到 `api` 的四条同步路由上
// ---------------------------------------------------------------------------

/** 包装是不是装上了(面板与探针据此判「开关打开后到底有没有人在发」)。 */
let bridgeInstalled = false;

/** @returns 同步通知包装当前是否生效。 */
export function isSyncNotificationBridgeInstalled(): boolean {
  return bridgeInstalled;
}

/**
 * 给 `api` 的 `fetch` / `pull` / `push` / `clone` 套一层完成回调(**只套一次**)。
 *
 * ## 为什么不改 `store.ts`
 *
 * 见文件头「生产者是怎么接上的」。这里补两条**实现约束**:
 *  1. **纯 pass-through**:包装把原 promise **原样返回**给调用方,自己只在旁边挂一个
 *     `then`。于是「谁 await 了它、什么时候 await」与原来逐字一致,宿主/调用方
 *     观察不到差异;
 *  2. **不许吞掉调用方的错误路径**:`api` 的路由从不 reject(传输错误也包成
 *     `ApiResult`),但仍然挂了一个 reject 处理器,免得将来某条路由变成会 reject 时
 *     多出一个 unhandled rejection。
 *
 * @returns 还原函数(回去之后 `bridgeInstalled` 变回 `false`)。已经装过时返回一个
 *   **不做任何事**的函数 —— 不返回「上一次的还原函数」,免得两个调用方互相拆台。
 */
export function ensureSyncNotificationBridge(): () => void {
  if (bridgeInstalled) {
    return () => {
      // 已经装过:这一次调用不拥有它,所以不拆。
    };
  }
  // `api` 是被 forbid 的文件导出的常量对象;如果它哪天被 `Object.freeze` 了,
  // 我们**不**偷偷降级成"什么都不做还说自己装上了"。
  if (Object.isFrozen(api)) {
    return () => {
      // 冻结了 ⇒ 装不上;`isSyncNotificationBridgeInstalled()` 会如实返回 false。
    };
  }

  const originalFetch = api.fetch;
  const originalPull = api.pull;
  const originalPush = api.push;
  const originalClone = api.clone;

  api.fetch = (path: string, remote?: string) => observe('fetch', path, originalFetch(path, remote));
  /*
   * ⚠️ `rebase` **必须原样转发**。这一层是「纯 pass-through」的包装,签名要与
   * `api.pull`(`api.ts`,新增了可选的 `rebase`)逐字对齐 —— 少写一个参数就是
   * **静默把它丢掉**(包装只把自己声明过的参数传下去),而类型检查不会报错:
   * 赋值给 `api.pull` 的箭头函数**参数更少**是合法的。
   *
   * 症状极难查(2026-10 实测):顶栏文案正确显示「变基拉取 origin」,而请求体里
   * 没有 `rebase` ⇒ 宿主只能自己去读配置(恰好同值时看起来一切正常)。
   * `docs/probes/pull-rebase-probe.mjs` 的 (1c2)/(2c2)/(e) 就是钉这个的。
   */
  api.pull = (path: string, rebase?: boolean) => observe('pull', path, originalPull(path, rebase));
  api.push = (path: string, force: boolean) => observe('push', path, originalPush(path, force));
  api.clone = (url: string, path: string, branch?: string) =>
    observe('clone', path, originalClone(url, path, branch));

  bridgeInstalled = true;
  return () => {
    api.fetch = originalFetch;
    api.pull = originalPull;
    api.push = originalPush;
    api.clone = originalClone;
    bridgeInstalled = false;
  };
}

/**
 * 在旁边观察一个同步 promise 的结果,**原样**把它还给调用方。
 *
 * 泛型是必须的:`api.clone` 返回 `{root, repos}`、另外三条返回 `{ok:true}`,而包装后的
 * 类型必须与 `api` 上的**逐字相同**(包装是运行时行为,不能在类型层改变别人看到的 api)。
 * @param kind - 动作类型。
 * @param repoPath - 仓库路径(clone 时是目标目录)。
 * @param pending - 原方法返回的 promise。
 */
function observe<T>(
  kind: SyncKind,
  repoPath: string,
  pending: Promise<ApiResult<T>>,
): Promise<ApiResult<T>> {
  void pending.then(
    (result) => {
      if (result.ok) {
        notifySyncFinished(kind, repoPath);
      } else {
        notifySyncFinished(kind, repoPath, result.error.message);
      }
    },
    () => {
      // 路由从不 reject;真 reject 了也由调用方那一侧的 await 处理,这里不重复报。
    },
  );
  return pending;
}

/** 面板的测试按钮:走**与真实通知完全相同**的投递路径(只跳过「你在不在看」)。 */
export function notifyTest(): NotificationOutcome {
  return deliverNotification(
    { title: 'dsh-git', body: '测试通知:如果你看到这一条,通知链是通的。', tag: 'dsh-git-test' },
    true,
  );
}

/*
 * **装上**。模块被 import 的那一刻就装 —— 这正是「开关一开就当场生效」的前提。
 * 没有 `window`(SSR / 纯 node 探针)时两件事都跳过。
 */
if (typeof window !== 'undefined') {
  ensureSyncNotificationBridge();
}
