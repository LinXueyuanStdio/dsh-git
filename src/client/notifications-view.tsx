/**
 * **通知入口** —— 右下角状态条那颗带未读角标的铃(`.gw-btn` + `.gw-count`)。
 *
 * ## 2026-10-09:这一层原来还有「一份可回看的列表」,已按用户裁决删掉
 *
 * 用户逐字:「**这个通知界面在 references/desktop 明明是没有的,你为什么一定要留着?**」
> 以及「**删 `.gw-inbox` 列表与那条诊断状态条,文字搬进 `docs/`,右下角只留「通知 N」入口**」。
 *
 * 他说得对,而且当时的实现比「多做了」更糟 —— 它把**开发读数**摆在了用户面前:
 *
 * | 删掉的东西 | 它当时显示什么 | 为什么它不该在界面上 |
 * |---|---|---|
 * | 状态行(`data-gw-notif-status`) | `owner/repo · 每 60s 轮询 · 已启用(通知权限:已授权) · 轮询中 · 上一轮 15:23:57(49s 前)· 1 次请求 · 基线已建立` | 那是**替代物的自证**,不是产品信息。成本与两条腿的取舍写在 [`docs/notifications-transport.md`](../../docs/notifications-transport.md) |
 * | 成本行(`data-gw-notif-cost`) | `成本:每轮 1 次 Search + 每 PR 5 次 Core × 最多 3 个 PR = 最多 16 次请求;上游是服务端推送(0 次)` | 同上 |
 * | 三个按钮 | `立即检查` / `清空并重建基线` / 全部标为已读 | 前两个是**开发按钮**;第三个随列表一起去掉(没有列表就没有「已读的列表项」) |
 * | 列表本体(`.gw-inbox` + `.gw-row.gw-notif-row`) | 每条通知一行 | **上游没有任何列表**:上游的详情面是 `ui/notifications/**` 的三个对话框(`ui/app.tsx:2587/2644/2773`)。那三个现在**已经接上**了(见 `notification-dialogs.tsx`) |
 *
 * `源码里那句「上游没有的那一层」的自述,连同它一起删了。`
 *
 * ## 那现在这颗铃是干什么的
 *
 * ⚠️ **上游没有这颗铃**(它的入口是你桌面的通知中心)。这颗铃是**我们自己的**,
 * 用户裁决给了它位置与形态(原话「右下角气泡,类似于 vscode」)。删掉列表之后,
 * 它必须有一个**真的**行为(本仓禁止「可见但无作用的控件」),所以:
 *
 * > **点它 ⇒ 打开「最新一条未读通知」上面那个对话框,并把它标为已读。**
 * > 没有未读 ⇒ 什么都不做(`disabled`)。
 *
 * 也就是说:详情面**只有**上游那三个对话框(与上游同形),铃是它们的**第二条入口**
 * (第一条是点系统通知,见 `notify.ts` 的 `INotificationRequest.onClick`)。
 * 未读角标因此有了真实含义 —— 它是「还没点开看过的条数」。
 *
 * @module dsh-git/client/notifications-view
 */

import type { ReactNode } from 'react';

import { notificationsStream, type INotificationsSnapshot } from './notifications.ts';

/**
 * 通知入口(底部状态条右端)。
 *
 * ⚠️ 2026-10 用户裁决(逐字):「**那你做错了,不应该在页签里。**」
 *
 * 它原先复用 `.gw-tab` / `.gw-count` 挂在**页签行**里,于是页签行出现了第 7 颗
 * `role="tab"` —— 而**上游的仓库页签栏只有两页签**
 * (`references/desktop/app/src/ui/repository.tsx:217-233` 的 `renderTabs()` 只渲染
 * `#changes-tab` / `#history-tab`)。现在这一颗:
 *
 *  · 类名是 `.gw-btn`(不再借 `.gw-tab`;页签行的类名与角色**只属于真页签**);
 *  · 落在**底部状态条右端**(理由见文件头);
 *  · **不带 `role="tab"` / `aria-selected`**,不是任何 `role=tablist` 的成员
 *    (改用 `aria-expanded`:它开合的是一层覆盖,不是一个页签)。
 *
 * ⚠️ `data-gw-notif-toggle` / `data-gw-notif-unread` 两个钩子属性**一个字没改**:
 * `docs/probes/notifications-stream-probe.mjs` 的 B0/B2b 与
 * `docs/probes/notifications-entry-placement-probe.mjs` 的 T1–T5 就是靠它们
 * 点这颗真按钮、读那个真角标的。
 *
 * `aria-expanded` 在 2026-10-09 起**恒为 `false`**:它原来表示「那个覆盖层开着吗」,
 * 而覆盖层已经删了 —— 留着一个恒 `true`/说谎的 `aria-expanded` 比删掉更糟。
 * 它现在准确表达的是「这颗按钮没有可展开的面」,而可点性由 `disabled` 表达。
 *
 * @param props - `unread` / `onOpenNewest` / `disabled`。
 */
export function NotificationsInboxButton(props: {
  /** 未读条数(角标;`0` ⇒ 不渲染角标)。 */
  unread: number;
  /** 点它:打开最新一条未读通知的对话框(没有未读时不会被调用)。 */
  onOpenNewest: () => void;
  /** 没有未读 ⇒ 真的 `disabled`(不是「点了没反应」)。 */
  disabled: boolean;
}): ReactNode {
  return (
    <button className="gw-btn" type="button" data-gw-notif-toggle="1"
      aria-expanded={false}
      {...(props.disabled ? { disabled: true } : {})}
      onClick={props.onOpenNewest}>
      通知
      {props.unread > 0 && <span className="gw-count" data-gw-notif-unread={props.unread}>{props.unread}</span>}
    </button>
  );
}

/**
 * 从快照里取「最新一条未读」。
 *
 * 列表是**最新在前**(`NotificationsStream.ingest` 的 `ordered` 就是 `createdAt` 降序,
 * 且 `patch` 时 `[...ordered, ...this.state.notifications]`)⇒ 第一条未读就是它。
 *
 * 为什么用「未读」而不是「最新一条」:角标数的是未读,铃的作用是**把它们看完**;
 * 用「最新一条」会让角标永远不清零 ⇒ 那颗角标会变成一个说谎的装饰。
 *
 * @param snap - 当前快照。
 * @returns 那一条,或 `null`(没有未读)。
 */
export function newestUnread(snap: INotificationsSnapshot): INotificationsSnapshot['notifications'][number] | null {
  for (const n of snap.notifications) {
    if (!snap.read.has(n.id)) {
      return n;
    }
  }
  return null;
}

/**
 * 点铃:打开最新一条未读的对话框(顺带把它标为已读)。
 *
 * 抽成函数(而不是写进 `workbench.tsx` 的 `useCallback` 里)的理由:
 * 它**有分支**(没有未读就什么都不做),而那种东西写在 JSX 旁边很难被单独读到;
 * 这里也让两个探针可以直接调它、不必模拟整个 workbench。
 *
 * @returns 是否真的打开了(`false` = 没有未读)。
 */
export function openNewestUnread(): boolean {
  const target = newestUnread(notificationsStream.snapshot());
  if (target === null) {
    return false;
  }
  // 先标已读再开:顺序反过来的话,`dismissDialog` 与 `markRead` 会在同一帧里
  // 各自 `patch` 一次,角标会闪一下。
  notificationsStream.markRead(target.id);
  notificationsStream.requestDialog(target);
  return true;
}
