/**
 * **通知面板**(`.gw-inbox` 覆盖层)—— 上游高信号通知在我们这半的**唯一渲染方**。
 *
 * ## 上游对应物是什么,这里为什么不是它
 *
 * 上游 `lib/stores/notifications-store.ts` 把事件交给 **OS 通知**(`desktop-notifications`,
 * 一个没装的原生包),点击后由 `ui/notifications/**` 的**四个对话框**呈现详情
 * (`pull-request-checks-failed` / `pull-request-review` / `pull-request-comment` /
 * `pull-request-comment-like`)。那四个对话框今天**没有**接线(它们要 `Dispatcher`、
 * 要 `ui/lib/sandboxed-markdown`(**缺**),而后者要 `marked`/`dompurify` —— 都是没装的包)。
 *
 * 所以这一层是**上游没有的那一层**:一份**可回看的列表**。它必须回答三个问题,
 * 而且三个都只能从真值里回答(本仓禁止「可见但无作用的控件」):
 *
 * | 问题 | 这一层怎么回答 | 依据 |
 * |---|---|---|
 * | 轮询在跑吗 | 「轮询中 / 已停止」+ 间隔 + **上一轮的时刻** | `snapshot().polling` / `lastPollAt` |
 * | 它花多少配额 | 「上一轮 N 次请求」+ 每轮公式 `1 + 4 × 同时看的 PR 数` | `snapshot().lastRequestCount` + `src/client/notifications.ts` 的文件头 |
 * | 为什么一条都没有 | 三种可分辨的原因各说一句话:没连 GitHub 远端 / **基线还没建立** / 基线之后确实没有新事件 | `target` / `baselined` / `lastPollAt` |
 *
 * ⚠️ **一处必须显示的不一样**:`pr-checks-failed` 那条**可能多报**
 * (我们拿不到账号邮箱清单,没法像上游那样过滤「失败提交的作者是不是你」)。
 * 多报的那一条自带 `caveat` 字段,这一层把它**逐条印出来** —— 静默多报就是假通知。
 *
 * ## 为什么挂 `.gw-inbox`(以及为什么**不改 CSS**)
 *
 * `.gw-inbox` / `.gw-inbox-bar` / `.gw-inbox-return` / `.gw-inbox-dot` /
 * `.gw-row.gw-inbox-unread` 这一族在 `src/client/styles.ts:124-132` **已经写好了**,
 * 而 `src/client/**` 里**零个写入方**(实测:`grep -rn "gw-inbox" src/client/*.tsx` 只命中
 * `workbench.tsx:817` 的一条**注释**)。它们本来就是为「页签正文之上的一层列表」写的
 * (`position:absolute;inset:0;z-index:28`)。用它有两个硬理由:
 *  1. **`styles.ts` 是一个巨型模板字面量**(`grep -c '\`' = 恰好 2`),动它要付
 *     `check-template-literals` 的账;复用现成的类**一行 CSS 都不用加**;
 *  2. 本仓反复点名的缺陷类是「类名存在 ≠ 规则生效」—— 这里反过来:**规则在、从来没人用**,
 *     正好由这一层把它变成「在用的规则」。
 *
 * ## 与上游的语义差(完整清单在 `src/client/notifications.ts` 的文件头)
 *
 * 一句话:**推送换成轮询、OS 通知换成 Web Notification、四个点击详情对话框没有接线**
 * (点击一行改为在浏览器里打开那个 PR/评论的 URL)。
 *
 * @see src/client/notifications.ts —— 数据面(本层只做渲染)
 * @module dsh-git/client/notifications-view
 */

import { useCallback, useEffect, useState } from 'react';
import type { MouseEvent, ReactNode } from 'react';

import {
  MAX_PULLS,
  notificationsStore,
  notificationsStream,
  type HighSignalKind,
  type IHighSignalNotification,
  type INotificationsSnapshot,
} from './notifications.ts';
import { getNotificationPermission, getNotificationsEnabled } from './notify.ts';

/** 三类事件的中文说法(与上游三条标题的语义一一对应)。 */
const KIND_LABELS: Readonly<Record<HighSignalKind, string>> = {
  'pr-comment': 'PR 评论',
  'pr-review-submit': 'PR 评审',
  'pr-checks-failed': '检查失败',
};

/** 浏览器通知权限的读法(与 `notify.ts` 的三态一一对应)。 */
const PERMISSION_LABELS: Readonly<Record<string, string>> = {
  unsupported: '此浏览器不提供通知',
  default: '尚未授权',
  granted: '已授权',
  denied: '已被浏览器拒绝',
};

/** `HH:MM:SS`,本地时区。 */
function clockOf(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** {@link NotificationsPanel} 的输入。 */
export interface INotificationsPanelProps {
  /** 「去 Pull requests 页签」—— 详情对话框缺席时,把人送去真正能看详情的地方。 */
  readonly onOpenPulls: () => void;
  /** 关掉这一层(回到原来的页签正文)。 */
  readonly onClose: () => void;
}

/**
 * 通知面板正文。
 *
 * @param props - 见 {@link INotificationsPanelProps}。
 */
export function NotificationsPanel(props: INotificationsPanelProps): ReactNode {
  const [snap, setSnap] = useState<INotificationsSnapshot>(() => notificationsStore.getSnapshot());
  const [now, setNow] = useState<number>(() => Date.now());

  /*
   * 订阅数据面。**不用 `useSyncExternalStore`**:本层在 jsdom 探针里会被**单独**挂载,
   * 而 `useState` + `useEffect` 不依赖 React 18 才有的那些 hook
   * (本仓磁盘上是 React 17.0.2,见 `docs/host-mirror-wiring.md` §8 第 9 条)。
   */
  useEffect(() => {
    const unsubscribe = notificationsStore.subscribe(() => {
      setSnap(notificationsStore.getSnapshot());
    });
    setSnap(notificationsStore.getSnapshot());
    return unsubscribe;
  }, []);

  /* 打开这一层 = 看到列表 ⇒ 未读清零(上游的通知是 OS 级的,没有这一层)。 */
  useEffect(() => {
    notificationsStream.markAllRead();
  }, []);

  /*
   * 「上一轮是多久之前」要每秒重画一次 —— 但**只在轮询中**才需要;
   * 停着的时候时钟不动(否则一个停掉的轮询也会看起来在走)。
   */
  useEffect(() => {
    if (!snap.polling) {
      return;
    }
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [snap.polling]);

  /*
   * 三个按钮的回调都用 `useCallback`:**不是风格洁癖** —— `.eslintrc.yml:125` 的
   * `react/jsx-no-bind: error` 会把「传进 JSX 的标识符解析到组件内的箭头函数」判成违规,
   * 而 `check-lint` 只拦**新增**违规。
   */
  const onPollNow = useCallback((): void => {
    void notificationsStream.pollNow();
  }, []);
  const onMarkRead = useCallback((): void => {
    notificationsStream.markAllRead();
  }, []);
  const onClear = useCallback((): void => {
    notificationsStream.clear();
  }, []);

  /*
   * 行点击:一个 `useCallback` 读 `data-url`,**不是**每行一个内联箭头(同一条规则)。
   */
  const onOpenRow = useCallback((event: MouseEvent<HTMLButtonElement>): void => {
    const url = event.currentTarget.dataset.url;
    if (url !== undefined && url !== '') {
      window.open(url, '_blank', 'noopener');
    }
  }, []);

  const onOpenPulls = props.onOpenPulls;
  const onClose = props.onClose;
  const enabled = getNotificationsEnabled();
  const permission: string = getNotificationPermission();
  const seconds = Math.round(snap.intervalMs / 1000);
  const maxRequests = 1 + 5 * MAX_PULLS;
  const ageSec = snap.lastPollAt === null ? null : Math.max(0, Math.round((now - snap.lastPollAt) / 1000));

  return (
    <div className="gw-inbox" data-gw-notifications="1">
      <div className="gw-inbox-bar">
        <strong>通知</strong>
        <span className="gw-muted" data-gw-notif-status="1">
          {snap.target === null
            ? '未连接 GitHub 远端'
            : `${snap.target} · ${snap.transport === 'alive' ? '长连接(服务端推送)' : `每 ${seconds}s 轮询`}`}
          {' · '}
          {enabled ? '已启用' : '已停用(不投递系统通知)'}
          {'(通知权限:'}{PERMISSION_LABELS[permission] ?? permission}{')'}
          {' · '}
          {snap.transport === 'alive'
            ? '长连接在推(0 次 GitHub 请求)'
            : snap.polling ? '轮询中' : '已停止'}
          {' · '}
          {snap.lastPollAt === null
            ? '还没跑过一轮'
            : `${snap.transport === 'alive' ? '上一条' : '上一轮'} ${clockOf(snap.lastPollAt)}${ageSec === null ? '' : `(${ageSec}s 前)`}`
              + (snap.transport === 'alive' ? '' : `·${snap.lastRequestCount} 次请求`)}
          {' · '}
          {snap.transport === 'alive'
            ? '长连接只推连接之后的事件(不需要基线)'
            : snap.baselined ? '基线已建立' : '基线未建立(下一轮只记录、不通知)'}
        </span>
        <span className="gw-muted" data-gw-notif-cost="1">
          {snap.transport === 'alive'
            ? '成本:0 次 GitHub 请求(宿主长连接推送;事件正文各补 1 次取数,与上游同一处)'
            : `成本:每轮 1 次 Search + 每 PR 5 次 Core × 最多 ${MAX_PULLS} 个 PR = 最多 ${maxRequests} 次请求;`
              + '上游是服务端推送(0 次)'}
        </span>
        <span>
          <button className="gw-btn" onClick={onPollNow}>立即检查</button>
          <button className="gw-btn" onClick={onMarkRead}>全部标为已读</button>
          <button className="gw-btn" onClick={onClear}>清空并重建基线</button>
          <button className="gw-btn" onClick={onOpenPulls}>去 Pull requests</button>
          <button className="gw-btn" onClick={onClose}>关闭</button>
        </span>
      </div>

      {snap.lastError !== null && (
        <div className="gw-inbox-return" data-gw-notif-error="1">
          <span className="gw-errbox">上一轮失败:{snap.lastError}</span>
        </div>
      )}

      {snap.notifications.length === 0
        ? renderEmpty(snap.target, snap.baselined)
        : (
          <div className="gw-list" data-gw-notif-rows={snap.notifications.length}>
            {snap.notifications.map((n) => (
              <NotificationRow key={n.id} item={n} onOpen={onOpenRow} />
            ))}
          </div>
        )}
    </div>
  );
}

/**
 * 空态 —— **三种原因各一句**,不许只说「暂无通知」。
 *
 * @param target - `owner/repo` 或 `null`。
 * @param baselined - 基线建立了吗。
 */
function renderEmpty(target: string | null, baselined: boolean): ReactNode {
  if (target === null) {
    return (
      <p className="gw-muted" data-gw-notif-empty="no-remote">
        这个仓库没有 GitHub 远端 ⇒ 没有可轮询的 PR 列表。
      </p>
    );
  }
  if (!baselined) {
    return (
      <p className="gw-muted" data-gw-notif-empty="no-baseline">
        还没有跑完第一轮:第一轮只建立基线(一条都不发,否则等于把历史评论一次性轰炸)。
        点「立即检查」马上跑一轮。
      </p>
    );
  }
  return (
    <p className="gw-muted" data-gw-notif-empty="no-new-events">
      基线之后没有新的高信号事件。这一层只认三类:当前仓库开放 PR 上的新评论、
      新评审(APPROVED / CHANGES_REQUESTED / COMMENTED)、以及 head 上失败的检查。
    </p>
  );
}

/** 一行。`data-url` 给外层那个唯一的 `onOpenRow` 读(理由见它的注释)。 */
function NotificationRow(props: {
  item: IHighSignalNotification;
  onOpen: (event: MouseEvent<HTMLButtonElement>) => void;
}): ReactNode {
  const { item } = props;
  return (
    <button
      className="gw-row gw-notif-row"
      data-url={item.htmlUrl}
      data-gw-notif-kind={item.kind}
      onClick={props.onOpen}
    >
      <span className="gw-inbox-dot on" />
      <span className="gw-rowmain">
        <span className="gw-rowtitle" data-gw-notif-title="1">{item.title}</span>
        <span className="gw-rowsub">{item.body.split('\n').join(' · ')}</span>
        {item.caveat !== '' && <span className="gw-rowsub gw-notif-caveat">⚠️ {item.caveat}</span>}
      </span>
      <span className="gw-meta">{KIND_LABELS[item.kind]}<br />{item.actor}</span>
    </button>
  );
}

/**
 * **通知入口** —— 底部状态条(`.gw-footer`)右端那颗带未读角标的开关。
 *
 * ⚠️ 2026-10 用户裁决(逐字):「**那你做错了,不应该在页签里。**」
 *
 * 它原先复用 `.gw-tab` / `.gw-count` 挂在**页签行**里(`workbench.tsx` 的 `.gw-tabs`),
 * 于是页签行出现了第 7 颗 `role="tab"` —— 而**上游的仓库页签栏只有两页签**
 * (`references/desktop/app/src/ui/repository.tsx:217-233` 的 `renderTabs()` 只渲染
 * `#changes-tab` / `#history-tab`),通知面在上游根本不是页签:内容由 `ui/app.tsx` 以
 * **popup** 呈现(`:2587` / `:2644` / `:2773` 的四个 `PopupType`),开关在
 * `ui/preferences/notifications.tsx`(偏好设置页)。
 *
 * 现在这一颗:
 *  · 类名是 `.gw-btn`(不再借 `.gw-tab`;页签行的类名与角色**只属于真页签**);
 *  · 落在**底部状态条右端** —— 用户对通知的裁决是「**右下角气泡,类似于 vscode**」
 *    (`docs/probes/toast-commit-button-probe.mjs` 文件头抄了原话),而 VSCode 的
 *    通知铃就在状态栏右端;
 *  · **不带 `role="tab"` / `aria-selected`**,不是任何 `role=tablist` 的成员
 *    (改用 `aria-expanded`:它开合的是一层覆盖,不是一个页签)。
 *
 * ⚠️ `data-gw-notif-toggle` / `data-gw-notif-unread` 两个钩子属性**一个字没改**:
 * `docs/probes/notifications-stream-probe.mjs` 的 B0/B2a/B2b 就是靠它们点这颗真按钮、
 * 读那个真角标的。判据在新家:
 * `docs/probes/notifications-entry-placement-probe.mjs`(T1–T5)。
 *
 * 单独导出仍然是为了让 `workbench.tsx` 的改动只有两处(import、一行 JSX):
 * 角标读的是与面板**同一份**快照。
 *
 * @param props - `active` / `unread` / `onToggle`。
 */
export function NotificationsInboxButton(props: {
  active: boolean;
  unread: number;
  onToggle: () => void;
}): ReactNode {
  return (
    <button className="gw-btn" type="button" data-gw-notif-toggle="1"
      aria-expanded={props.active} onClick={props.onToggle}>
      通知
      {props.unread > 0 && <span className="gw-count" data-gw-notif-unread={props.unread}>{props.unread}</span>}
    </button>
  );
}
