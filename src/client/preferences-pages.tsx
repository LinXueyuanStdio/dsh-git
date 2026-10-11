/**
 * **Preferences 各页面的共用正文**(今天是 **6 页**:账号 / Git / 外观 / 通知 / 提示与确认 / 无障碍)。
 *
 * ⚠️ 标题里的「三个」是历史:本模块最初只承载账号 / 仓库 / 无障碍三页(见下面第 2 段),
 * 此后 Git、外观、通知各按自己的账本加进来,2026-10「仓库」页按用户指令移除、
 * 「提示与确认」按用户裁决加回来 ⇒ **真源永远只有下面那张 `TABS`**。
 *
 * ## 为什么要从 `preferences-dialog.tsx` 里拆出来
 *
 * 这些页面原来只在一个渲染面里出现:我们自己那个模态(`PreferencesDialog`)。
 * 2026-10 用户要求把它们**也**搬进**宿主设置 ▸ 内置插件 ▸ dsh-git**的页签
 * (`settings.plugins.tab` 席位,卡片见 `./host-settings-card.tsx`)。两个渲染面的
 * 页签外壳必须**不同**(模态里是上游竖向 `TabBar`,卡片里是宿主 `SegmentedTabs`
 * 横向页签 —— 后者是「别再手写一套页签控件」的裁决),但**正文、状态机与偏好接线
 * 只能有一份真源**:两份拷贝一定会漂移,而这正是本仓反复点名的静默缺陷类。
 *
 * 所以本模块只拥有**与外壳无关**的那一半:
 *
 * | 谁拥有 | 什么 |
 * |---|---|
 * | 本模块 | `TABS`(页面表)、`TAB_DOM_ID` / `PAGE_PANEL_ID`、各页面的正文(含各页的读写接线)、**设备码轮询状态机**、真偏好的读写回调 |
 * | 外壳(`preferences-dialog.tsx` / `host-settings-card.tsx`) | 「当前选中哪一页」的 state、页签控件本体、`role=tabpanel` 容器、**登录怎么起**(设备码那一半) |
 *
 * ## 依赖方向(不许成环)
 *
 * ```
 * preferences-dialog.tsx ─┐
 *                         ├─> preferences-pages.ts ─> core/desktop/ui/preferences/** + prefs.ts + diff-mode.ts
 * host-settings-card.tsx ─┘
 * ```
 *
 * 本模块**不认识**任何一个外壳(不 import 弹窗、不 import 卡片),所以两个外壳都能
 * 在不动对方的前提下各自演进。
 *
 * ## 三条不许越的线(与卡片同源)
 *
 * 1. **组件不碰 ctx**:数据与回调一律经 prop 进来,或者来自本插件自己的模块
 *    (`prefs.ts` / `diff-mode.ts` 的 localStorage 偏好层);
 * 2. **业务组件不自己造新订阅机制**:两条偏好用的是 `prefs.ts` / `diff-mode.ts`
 *    早就有的 `useSyncExternalStore` 钩子(`useUnderlineLinks` / `useShowDiffCheckMarks`),
 *    这里只是把「写 + 通知」包成具名回调;
 * 3. **不回写 props 的镜像 state**:`onPreferencesChanged` 只被调用,不产生本地副本。
 *
 * @see src/client/preferences-dialog.tsx —— 模态外壳(回退入口)
 * @see src/client/host-settings-card.tsx —— 宿主设置卡片外壳(新入口)
 * @module dsh-git/client/preferences-pages
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent, ReactNode } from 'react';

import { Accessibility } from '../core/desktop/ui/preferences/accessibility.tsx';
import { Accounts } from '../core/desktop/ui/preferences/accounts.tsx';
import { Appearance } from '../core/desktop/ui/preferences/appearance.tsx';
/*
 * **Prompts 页 —— 2026-10 用户裁决「可以加 Prompts 页」之后加回来的整页。**
 *
 * 它一直是**逐字节镜像**(`src/core/desktop/ui/preferences/prompts.tsx`,与上游
 * `references/desktop/app/src/ui/preferences/prompts.tsx` 一致;唯一一处已登记的偏离是
 * 用户「统一中文」裁决下的**字面量本地化**,登记在 `scripts/verify-mirror.mjs` 的
 * `EXPECTED`)—— 与 `accounts` / `appearance` / `git` / `accessibility` 四条同源。
 * 本模块只负责**接线**(哪些控件的动作真的落地在本插件里、其余由适配层删除),
 * 逐条账本见 `preferences-dialog.tsx` 文件头的「Prompts」一节。
 */
import { Prompts } from '../core/desktop/ui/preferences/prompts.tsx';
import { Account } from '../core/desktop/models/account.ts';
import { UncommittedChangesStrategy } from '../core/desktop/models/uncommitted-changes-strategy.ts';
import { ApplicationTheme } from '../core/desktop/ui/lib/application-theme.ts';
import {
  getDateFormatPreference,
  getNumberFormatPreference,
  getPreferAbsoluteDates,
  getTimeFormatPreference,
  setDateFormatPreference,
  setNumberFormatPreference,
  setPreferAbsoluteDates,
  setTimeFormatPreference,
  type DateFormat,
  type INumberFormat,
  type TimeFormat,
} from '../core/desktop/models/formatting-preferences.ts';
import * as octicons from '../core/desktop/ui/octicons/octicons.generated.ts';

import { api, type AuthStatePayload } from './api.ts';
/*
 * 账号邮箱 / 端点的接线层(本泳道新增)。
 *
 * `accountsWithEmails` 是**邮箱下拉**那一半:上游 `GitConfigUserForm` 的候选来自
 * `Account.emails`,而这里原来传的是空数组 ⇒ 镜像里那句
 * `accountEmails.length === 0 ⇒ return null` 永远命中,下拉永远不出现。
 *
 * `useEnterpriseSignIn` 是**多企业账号**那一半:它把端点输入、PAT 登录、以及
 * 「点企业登录按钮时如实说明设备码不支持企业端点」收在一处。
 */
import {
  AccountNotice,
  accountsWithEmails,
  PatSignInAction,
  PatSignInForm,
  useAccountEmails,
  useAppInstallation,
  useEnterpriseSignIn,
  type IAuthIdentity,
} from './account-emails.tsx';
import { setShowDiffCheckMarks, useShowDiffCheckMarks } from './diff-mode.ts';
import { DialogContent } from './host-modal.tsx';
// 「Git」页签的接线层 —— 页面本体是逐字节镜像的上游 `ui/preferences/git.tsx`。
import { GitPage } from './git-page.tsx';
/** 邮箱的**载荷类型**住在适配层(`auth/emails` 的载荷形状的唯一真源)。 */
import type { IAccountEmail } from './host-api-bridge.ts';
import {
  setHostThemePreference,
  useHostThemePreference,
  type HostThemePreference,
} from './host-theme.ts';
/*
 * `Notifications` 页(本泳道新增)。
 *
 * ⚠️ 它**不是**上游那个走 Electron 原生的页面 —— 那两样(desktop-notifications 插件、
 * main-process-proxy 的权限请求)在我们的替身里恒 false。这一页走**浏览器的**
 * Web Notifications API,并且带一个真的会响的生产者(见 `notify.ts`)。
 */
import { NotificationsPanel } from './notifications-panel.tsx';
import {
  CONFIRM_COMMIT_FILTERED_CHANGES_KEY,
  CONFIRM_DISCARD_CHANGES_KEY,
  CONFIRM_DISCARD_STASH_KEY,
  CONFIRM_UNDO_COMMIT_KEY,
  SHOW_COMMIT_LENGTH_WARNING_KEY,
  getConfirmCommitFilteredChanges,
  getConfirmDiscardChanges,
  getConfirmDiscardStash,
  getConfirmUndoCommit,
  getShowCommitLengthWarning,
  setConfirmCommitFilteredChanges,
  setConfirmDiscardChanges,
  setConfirmDiscardStash,
  setConfirmUndoCommit,
  setDiffTabSize,
  setShowCommitLengthWarning,
  setUnderlineLinks,
  subscribePreference,
  useDiffTabSize,
  useUnderlineLinks,
} from './prefs.ts';

/**
 * 本模块能渲染的分区。**6 页**(2026-10:`appearance` 与 `git` 按用户指令**加进来**;
 * 同月 **`repositories` 按用户指令移除**,**`prompts` 按用户裁决「可以加 Prompts 页」
 * 加回来** —— 见 `TABS` 上面那张表)。
 *
 * 类型从 `preferences-dialog.tsx` 搬来(那份逐页账本留在那边;这里是不含任何
 * 「宿主能表达什么」判断的机械类型)。
 */
export type PreferencesTabId =
  | 'accounts'
  | 'git'
  | 'appearance'
  | 'notifications'
  | 'prompts'
  | 'accessibility';

/**
 * 页签表 —— **6 页**。前 2 页各有一份「为什么必须是我们的 UI」的理由;另 3 页
 * (`appearance` / `git` / `prompts`)是 2026-10 用户裁决或明确要求加入的(见下)。
 *
 * | 页 | 为什么留 |
 * |---|---|
 * | `accessibility` | `docs/goal-port-desktop.md` §11.3 要求 `diff-check-marks-visible` **可达且真的驱动 diff 的勾选列**;宿主的 `Config` 表单模型是**单段路径 + 只认 volatile 字段**,表达不了「一个开关驱动客户端渲染」这种跨面行为 |
 * | `accounts` | **设备码面板**接的是本插件 host 半的 `auth/device-*`,宿主没有对应 UI |
 * | `git` | **2026-10 加入**(见下) |
 * | `appearance` | **2026-10 加回**(见下);同月**接手了原「仓库」页的「界面缩放」控件** |
 * | `prompts` | **2026-10 用户裁决「可以加 Prompts 页」之后加回来**(见下) |
 *
 * ## `repositories` 为什么被移除(2026-10 用户指令,**这是一次产品裁决**)
 *
 * > 用户原话:「现在偏好设置 dialog 里,可以移除【仓库】这个 tab。一方面,仓库的管理
 * > 应该在当前仓库的 repo list 里管理;另一方面,这个 tab 里的**字号设置应该移动到
 * > 【外观】**这个 tab。」
 *
 * 三条事实,免得下一个人把它当成「抄漏了一页」:
 * 1. **上游 Preferences 里根本没有「仓库」页**。Desktop 把仓库清单放在**左栏**
 *    (`ui/app.tsx` 的 `<RepositoriesList>`),`ui/preferences/**` 没有对应文件 ——
 *    这一页从一开始就是我们手写的产品面,不是镜像。
 * 2. **仓库管理今天仍然完整可达**,只是换了地方:顶栏「当前仓库」下拉
 *    (`repo-bar.tsx` 的 `RepositoryPanel`,本体是逐字镜像的
 *    `ui/repositories-list/**`)提供 **切换 / 右键改名 / 右键移除 / `Add ▾`(Clone /
 *    Create / Add existing)/ 过滤**;空态那屏还有一颗「添加本地仓库」
 *    (`workbench.tsx:357`)。⇒ **没有留下洞**。
 * 3. **被移除的是页面,不是能力**:`store.selectRepo` / `removeRepo` /
 *    `addRepoViaDialog` 与 `IPreferencesStore` 上对应的声明**一个字没删**
 *    (用户的长期规则是「先做,不删」,本轮的移除令只针对这四处 UI 添加)。
 *
 * ## `appearance` 的来龙去脉(两次裁决,都记下来)
 *
 * 1. **2026-10 上旬删过一次**,理由是「主题色板已经真接线到宿主 `theme` 服务,而宿主自己的
 *    General 段本来就有这一行 ⇒ 这一页在宿主那边是**重复**的」。
 * 2. **2026-10 用户明确要求加回来**(原话:「Appearance 要加入」)。这是**产品裁决**,
 *    覆盖上面那条「重复」的取舍,所以它回来了。
 *
 * 它**不是**靠运气才成立的:四条控件今天**全部有真落点**(逐条 `file:line`):
 *
 * | 控件 | 落点 | 证据 |
 * |---|---|---|
 * | Theme 色板(Light/Dark/System) | 宿主 `theme` 服务 | `host-theme.ts` 的 `get` / `set` / `subscribe`;`index.ts` 的 `apply()` 里 `attachHostTheme(ctx)` 可选注入。服务缺席时卡片挂 `gw-prefs-no-theme`,`scss/preferences.scss` 第 5 条把**整个主题分区删掉**(不会出现点了没反应的色板) |
 * | Formatting(日期/时间/数字格式) | `models/formatting-preferences.ts`(真 localStorage) | 消费方 `lib/format-date.ts:65-69`、`lib/format-number.ts:23`;`enableFormattingPreferences()` 在本仓是 `true`(`lib/feature-flag.ts:16`) |
 * | Prefer absolute dates | 同文件 `:342/350` | 消费方 `ui/branches/branch-list-item.tsx:126`、`pull-request-list-item.tsx:82`、`branch-renderer.tsx:49` |
 * | Diff Tab Size | `src/client/prefs.ts` 的 `KEY_DIFF_TAB_SIZE` | 消费方 `src/client/desktop-diff.tsx:970` 的 `useDiffTabSize()` → `:978 style={{ tabSize }}` ⇒ **改完 diff 当场变** |
 * | Always show worktree list | **无**(产品里没有 worktree) | 由适配层 `display:none !important` 删除(`scss/preferences.scss` 适配层第 1 条)⇒ 是**不可见**控件,不是死控件 |
 *
 * ## `prompts` 为什么**原来是整页删除、现在加回来了**(2026-10 用户裁决)
 *
 * 上游 `preferences.tsx:400-437` 里还有 `integrations` / `prompts` / `advanced` 三页。
 * 其中 **`integrations` 与 `advanced` 仍然整页删除** —— 保真度账本
 * (`preferences-dialog.tsx` 文件头)里已逐项证明它们的控件**无法兑现**,留着就是
 * 「可见但无作用」的静默缺陷类。**删除是取舍,不是遗漏**;两个文件都在镜像树里
 * (`ui/preferences/{integrations,advanced}.tsx`),要加随时是接线活。
 *
 * **`prompts` 不再是删除项**:用户 2026-10 裁决「可以加 Prompts 页」,而这条裁决
 * 是**有落点支撑**的 —— 12.16 的三个键、12.13 的闸门、以及「提交被筛选隐藏」那一条
 * 都已经真的接线(逐条见 `TABS` 里 `prompts` 那条注释)。
 * 页面本体是**镜像**;控件的取舍(哪些接线、哪些由适配层删除)写在
 * `preferences-dialog.tsx` 文件头的 Prompts 表里。
 */
/*
 * ==========================================================================
 * 外壳契约(两个渲染面都必须遵守的三条,写在这里免得下一个外壳漏掉)
 * ==========================================================================
 *
 * 1. **作用域根自带**:这些页面的样式全部住在 `src/client/scss/preferences.scss`
 *    这一面里,而那一面的作用域根是 `.gw-prefs`(`scripts/styles.mjs` 的
 *    `PORT_SURFACES`)。所以**每个外壳都必须让 `.gw-prefs` 成为正文的祖先** ——
 *    模态那边它由 `host-modal.tsx` 的 `PluginDialog` 加在**卡片自己**身上;卡片那边由
 *    `host-settings-card.tsx` 自己包一层 `<div className="gw-prefs">`。
 *    **不允许**把 `.gw-prefs` 与某个目标类加在同一个元素上(那会产出永不匹配的
 *    后代选择器,见 `scss/preferences.scss` 头注释)。
 * 2. **「Underline links」那一半由外壳挂类**:`useAccessibilityWiring` 只负责**写**偏好,
 *    真正让它生效的是作用域根元素上的 `gw-underline-links` 类
 *    (规则在 `scss/preferences.scss` 第 6 条:`&.gw-underline-links a …`)。
 *    所以外壳要读 {@link useUnderlineLinks}(本模块转出)并条件挂类 ——
 *    `PluginDialog` 的 `className` 与卡片那层 `<div>` 各挂各的。
 * 3. **正文放进 `role=tabpanel`**:`id` 用 {@link PAGE_PANEL_ID} 那一族,模态那边
 *    额外给 `aria-labelledby={TAB_DOM_ID[tab]}`。
 */

export const TABS: ReadonlyArray<{
  id: PreferencesTabId;
  label: string;
  symbol: typeof octicons.home;
}> = [
  { id: 'accounts', label: '账号', symbol: octicons.home },
  /*
   * **Git —— 2026-10 用户明确要求加入**(「Git 要加入」)。页面本体是**逐字节镜像**的
   * 上游 `ui/preferences/git.tsx`,接线层在 `src/client/git-page.tsx`(那个文件头
   * 逐项写了 Author / Default branch / Hooks 三个子页签的接线状态与缺口)。
   *
   * 位置照上游 `:414` —— Git 在 Appearance **之前**。图标同上游 `:415` 的
   * `octicons.gitCommit`。
   */
  { id: 'git', label: 'Git', symbol: octicons.gitCommit },
  /*
   * 位置照**上游相对顺序**:`preferences.tsx:400-437` 的 TabBar 是 Accounts →
   * Integrations → [Copilot] → Git → **Appearance** → Notifications → **Prompts** →
   * Advanced → **Accessibility**。我们今天的 6 页按该顺序的相对位置排 =
   * 账号 → Git → 外观 → 通知 → **提示与确认** → 无障碍(上游的 Integrations / Advanced
   * 两页仍是整页删除;Copilot 按用户指令排除)。
   * 图标同上游 `:419` 的 `octicons.paintbrush`。
   */
  { id: 'appearance', label: '外观', symbol: octicons.paintbrush },
  /*
   * **通知 —— 2026-10 新增**。上游 `preferences.tsx:420-425` 把它排在 Appearance
   * 之后、Prompts 之前,图标是 `octicons.bell`(`:423`),两者都沿用。
   *
   * ⚠️ 与上游**只有一处**不同,而且是刻意的:上游这一页的权限走 Electron 原生
   * (`desktop-notifications` + `ui/main-process-proxy.ts` 的
   * `requestNotificationsPermission`,两者在我们的替身里**恒 false**),沿用就是
   * 一个永远弹不出通知的死开关。这里换成**浏览器**的 Web Notifications API,
   * 并配一个真的生产者(`notify.ts` 把 `api` 的 fetch/pull/push/clone 四条同步路由
   * 包了一层完成回调)。页面本体见 `./notifications-panel.tsx`。
   */
  { id: 'notifications', label: '通知', symbol: octicons.bell },
  /*
   * ======================================================================
   * **提示与确认(Prompts)—— 2026-10 用户裁决「可以加 Prompts 页」之后加回来**
   * ======================================================================
   *
   * ## 位置(与上游逐条对齐,不是随手放的)
   *
   * 上游 `preferences.tsx:426-430` 的 `TabBar` 里,Prompts 排在 **Notifications 之后、
   * Advanced 之前**;图标是 `:429` 的 `octicons.question`(⚠️ **不是** gear —— 那是
   * Advanced 的)。我们的页签表没有 Advanced(整页删除),所以它的落点是
   * **通知与无障碍之间** —— 这就是上游的相对顺序在「去掉两页之后的表」上的投影。
   *
   * ## 这一页为什么现在能加(它原先为什么被整页删除)
   *
   * 它曾是保真度账本里三条「整页删除」之一(`integrations` / `prompts` / `advanced`)。
   * 但删除的**唯一有效理由**是「这一页上的控件一个都兑现不了」,而那条理由**早已过期**:
   *   · 12.16 已经把 `confirmDiscardChanges` / `confirmDiscardStash` / `confirmUndoCommit`
   *     接成了**真偏好**(消费方在 `changes-view.tsx`,判据 `changes-confirm-pref-probe`);
   *   · 12.13 的 `showCommitLengthWarning` **早就有真的闸门**(`changes-view.tsx` 的
   *     `CommitBox`),只缺设置面 —— 上一轮把它塞进「外观」页是**自造入口**,已按用户
   *     裁决删除,回收条件写的就是「若将来 Prompts 页真的落地,接在**这一页**」;
   *   · `confirmCommitFilteredChangesKey` **两侧都落了地**(写侧 = 镜像
   *     `ui/changes/confirm-commit-filtered-changes-dialog.tsx` 经 `prefs.ts`;
   *     读侧 = `changes-view.tsx` 的 `showPromptForCommittingFileHiddenByFilter`),
   *     而账本原先记的「真正缺的是确认对话框」**也已过期**(那个弹窗就在
   *     `changes-view.tsx:1631-1667`)。
   * ⇒ 三条有落点的控件 + 上游**同一节**的第六个控件合起来足够撑起一整页,而用户已裁决加页。
   *
   * ## 没落点的控件**不删页,也不留死开关**
   *
   * 上游这一页有 12 个控件(10 个复选框 + 1 组三选一 + 1 个复选框)。镜像**一字不改**,
   * 所以「不发车」的那 7 个由**适配层**删除(`scss/preferences.scss` 适配块第 12 条:
   * `display:none !important`,与 worktree 那条同一手法、同一条纪律),逐条理由与判据
   * 写在 `preferences-dialog.tsx` 文件头的 Prompts 表里。⇒ 可见的每一个控件都真的能兑现,
   * 隐藏的每一个都有**具名**理由(不是「没接完」)。
   */
  { id: 'prompts', label: '提示与确认', symbol: octicons.question },
  { id: 'accessibility', label: '无障碍', symbol: octicons.accessibility },
];

/** 上游 `preferences.tsx:447-482` 的 `getTabId` —— 决定 CSS 挂哪个 id。 */
export const TAB_DOM_ID: Readonly<Record<PreferencesTabId, string>> = {
  accounts: 'preferences-tab-accounts',
  git: 'preferences-tab-git',
  appearance: 'preferences-tab-appearance',
  notifications: 'preferences-tab-notifications',
  prompts: 'preferences-tab-prompts',
  accessibility: 'preferences-tab-accessibility',
};

/**
 * 每个页面的 `role=tabpanel` 容器 id —— 给宿主 `SegmentedTabs` 的 `items[].panelId` 用。
 *
 * 模态外壳不用它(`TabBar` 的 `aria-labelledby` 读的是 {@link TAB_DOM_ID});
 * 卡片外壳用它把宿主页签的 `aria-controls` 指向**真的存在**的那个面板(宿主
 * `SegmentedTabs` 把 `panelId` 原样放进 `aria-controls`,见
 * `packages/client/ui-primitives/src/SegmentedTabs.tsx:31` 附近的 `SegmentedTab` 契约)。
 */
export const PAGE_PANEL_ID: Readonly<Record<PreferencesTabId, string>> = {
  accounts: 'dsh-git-preferences-panel-accounts',
  git: 'dsh-git-preferences-panel-git',
  appearance: 'dsh-git-preferences-panel-appearance',
  notifications: 'dsh-git-preferences-panel-notifications',
  prompts: 'dsh-git-preferences-panel-prompts',
  accessibility: 'dsh-git-preferences-panel-accessibility',
};

/**
 * 账号页/设备码流程 + **原「仓库」页**需要的**最小** store 面(结构化类型,不是 `GitStore` 的别名)。
 *
 * 声明窄一点可以让「谁改了 store 的这几个方法」立刻在编译期报错,而不是拖到最后才发现。
 *
 * ⚠️ 前三条(`selectRepo` / `removeRepo` / `addRepoViaDialog`)是**原「仓库」页**的输入。
 * 那一页已按用户指令移除(见 `TABS` 上面那段),所以这三个成员今天在本模块里**没有消费点**;
 * 它们**故意留着**(长期规则「先做,不删」,且 `store.ts` 上那三个方法的真身也一个字没删)
 * ⇒ 将来任何一面要重新暴露仓库管理,契约还在。
 */
export interface IPreferencesStore {
  /** 切换当前仓库(`store.ts` 的 `selectRepo`)。 */
  selectRepo(path: string): Promise<void>;
  /** 移除仓库(`store.ts` 的 `removeRepo`)。 */
  removeRepo(path: string): Promise<void>;
  /** 弹目录选择器添加仓库(`store.ts` 的 `addRepoViaDialog`)。 */
  addRepoViaDialog(): Promise<boolean>;
  /** 退出登录(`store.ts` 的 `logout` → `auth/logout` 路由)。 */
  logout(): Promise<void>;
  /** 设备码登录成功后写入登录态(`store.ts` 的 `setAuth`)。 */
  setAuth(state: AuthStatePayload): void;
  /** 登录态变化后刷新远端仓库清单(`store.ts` 的 `loadRemoteRepos`)。 */
  loadRemoteRepos(force?: boolean): Promise<void>;
  /** 轻提示(`store.ts` 的 `toast`)。 */
  toast(message: string, kind?: 'ok' | 'err'): void;
}

/** 仓库清单里的最小一项(与 `store.ts` 的 `RepoEntry` 结构兼容)。 */
export interface IPreferencesRepoEntry {
  readonly path: string;
  readonly name: string;
}

/** 页面需要的快照部分(与 `store.ts` 的 `Snapshot` 结构兼容)。 */
export interface IPreferencesSnapshot {
  readonly current: string;
  readonly repos: ReadonlyArray<IPreferencesRepoEntry>;
}

/** 登录态(账号页)。`null` = 未登录。 */
export type PreferencesAuth =
  | {
    readonly login: string;
    readonly tokenTail: string;
    /**
     * 该账号的 GitHub **API 基址**;省略 = 未知(见 `account-emails.tsx` 的
     * {@link IAuthIdentity.endpoint}:两条渲染路径喂的东西不一样)。
     */
    readonly endpoint?: string;
  }
  | null;

/**
 * `auth/device-start` 成功后要交给面板的那几个值(与 `api.ts:496-501` 的载荷同形)。
 *
 * ⚠️ `expiresIn` 是**相对秒数**(host 原样给的就是它),绝对过期时刻由
 * {@link useDeviceSignIn} 自己算 —— 时钟只在一个地方读,调用点不必知道。
 */
export interface IDeviceCodeStart {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly interval: number;
  /** host 给的剩余有效秒数。 */
  readonly expiresIn: number;
}

/**
 * 「把设备码流程跑起来」—— **由外壳注入**的那一半。
 *
 * 为什么由外壳注入而不是本模块直接 `api.deviceStart()`:卡片与模态是两个渲染面,
 * 而这一步要做两件事(向 host 要设备码 + `window.open` 授权页)。放进 prop 面,
 * 「谁在什么时候打开浏览器」在调用点一眼可见;本模块只拥有**轮询状态机**。
 *
 * ## 失败通道(2026-11 接上,见下)
 *
 * `result.ok === false` 时(host 没配 Client ID、App 没开 Device Flow、网络不通…)
 * 必须把 `result.error.message` 交给面板 —— 否则状态机停在 `starting`,面板显示
 * 「正在向 GitHub 申请设备码…」而**什么都没在申请**,用户看到的是一句谎。
 * 这条通道是**可选参数**(`onError`),因为它的三个注入点(模态 / 卡片 / 卡片的另一半)
 * 都只关心「成功之后怎么办」;只有面板状态机需要知道失败。
 *
 * @param onStarted - 拿到设备码后调一次,把面板切到「等待授权」。
 * @param onError - 起不来时调一次(省略 = 保持「静默」的旧行为,只有探针会那样调)。
 */
export type StartDeviceSignIn = (
  onStarted: (started: IDeviceCodeStart) => void,
  onError?: (message: string) => void,
) => void;

/** 设备码登录面板的状态机。 */
export type DeviceFlowState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'starting' }
  | { readonly kind: 'waiting'; readonly deviceCode: string; readonly userCode: string; readonly verificationUri: string; readonly interval: number; readonly expiresAt: number }
  | { readonly kind: 'done'; readonly login: string }
  | { readonly kind: 'error'; readonly message: string };

/** {@link useDeviceSignIn} 的返回面。 */
export interface IDeviceSignIn {
  /** 当前状态。 */
  readonly state: DeviceFlowState;
  /** 点「登录 / 重试」:把状态切到 `starting` 并请外壳去要设备码。 */
  readonly start: () => void;
  /** 外壳拿到设备码之后调一次(状态:starting → waiting)。 */
  readonly accept: (started: IDeviceCodeStart) => void;
  /** 收起面板(回到 idle)。 */
  readonly dismiss: () => void;
}

/**
 * `slow_down` 的兜底自增步长(秒)。
 *
 * GitHub 的规则原文是 *5 extra seconds are added to the minimum interval*,并且响应里
 * 还会带**新的 `interval`**;后者优先(见 {@link nextDevicePollInterval})。这个常量只在
 * 响应没带 `interval` 时兜底(老 host 会把它丢掉,见 `src/host/auth.ts` 的 `DeviceFlowPoll`)。
 */
export const DEVICE_POLL_SLOW_DOWN_STEP_SEC = 5;

/**
 * 下一次轮询该等多少秒 —— 纯函数,判据只此一处(2026-11)。
 *
 * ## 为什么必须有它(这是"授权了却拿不到令牌"的现场原因)
 *
 * 旧实现把 `slow_down` 当普通 pending:**固定 `setInterval(interval)` 继续按原节奏打**。
 * 而 GitHub 的行为是「你打太快 ⇒ 我要求更慢」,而且**每次都再加码**,令牌始终不下发。
 * 真机实测(对 `POST /login/oauth/access_token` 每 1 秒打一次):
 *
 * ```
 * 第 1 次 authorization_pending            (响应里没有 interval)
 * 第 2 次 slow_down  interval=10
 * 第 3 次 slow_down  interval=15
 * 第 4 次 slow_down  interval=20    …      ← 令牌始终没有
 * ```
 *
 * 而**按要求的间隔等够之后再打,就恢复正常**:
 *
 * ```
 * (等 20 秒,≥ 最后要求的 15)
 * 下一次 authorization_pending             ← 退避解除
 * ```
 *
 * ⇒ 规则:**只增不减**,且**优先采用响应里给的 `interval`**(官方文档:*The error
 * response includes the new interval that you must use*)。
 *
 * @param current - 当前生效的间隔(秒)。
 * @param poll - host 给的轮询结果(只读 `slowDown` / `interval`)。
 * @returns 下一次轮询前要等的秒数;不是 `slow_down` 时**原样返回** `current`。
 */
export function nextDevicePollInterval(
  current: number,
  poll: { readonly slowDown?: boolean; readonly interval?: number },
): number {
  if (poll.slowDown !== true) {
    return current;
  }
  const fromServer =
    typeof poll.interval === 'number' && Number.isFinite(poll.interval) && poll.interval > 0
      ? poll.interval
      : current + DEVICE_POLL_SLOW_DOWN_STEP_SEC;
  // `Math.max`:GitHub 的间隔是单调递增的,任何"变小"的值都当作没听见,免得把节奏又打快。
  return Math.max(current, fromServer);
}

/**
 * 「去要一个设备码」—— **两个外壳共用**的那一半实现。
 *
 * 它做两件事:调本插件 host 半的 `auth/device-start`,以及把用户送到授权页
 * (`window.open`,浏览器可能拦截,所以面板里**也**给链接)。
 *
 * ## 为什么放在这里而不是各外壳各写一份
 *
 * 弹窗与卡片是两棵互不相邻的树,但「怎么向 host 要设备码」是**产品行为**、
 * 不是外壳行为:两处各写一份就是两份会漂移的实现(而且其中一份迟早会被漏改)。
 * 外壳要注入的只是**这一个函数**(`IPreferencesPageBodyProps.startDeviceSignIn`),
 * 于是「谁在什么时候打开浏览器」在调用点仍然一眼可见。
 *
 * ## ⚠️ 为什么必须在 `onError` 里说人话(2026-10 登记的弱点,2026-11 修掉)
 *
 * 改前这里 `result.ok === false` 时**什么都不做** —— 状态机停在 `starting`,面板显示
 * 「正在向 GitHub 申请设备码…」,而 `result.error.message` 其实可读(host 会明说
 * 「host 未配置 GitHub OAuth App Client ID」)。当初不改是因为那一轮的授权范围是
 * 「把三页搬进卡片」,加一条 prop 通道属于夹带改动。
 *
 * 2026-11 必须改的理由:包内开始内置一个 **GitHub App** 的 Client ID ⇒ 设备码按钮
 * **默认就会出现**,而这一步恰好是最可能失败的一步(App 没开 Device Flow、
 * 授权请求被拒、网络不通)。让「点了没反应」成为默认路径上的表现不可接受。
 *
 * @param onStarted - 拿到设备码后调一次,把面板切到「等待授权」。
 * @param onError - 起不来时调一次,把面板切到错误态(省略 = 旧行为:静默)。
 */
export function startDeviceSignIn(
  onStarted: (started: IDeviceCodeStart) => void,
  onError?: (message: string) => void,
): void {
  void (async () => {
    const result = await api.deviceStart();
    if (!result.ok) {
      onError?.(result.error.message);
      return;
    }
    const { deviceCode, userCode, verificationUri, interval, expiresIn } = result.value;
    onStarted({ deviceCode, userCode, verificationUri, interval, expiresIn });
    // 与 Desktop 一样把用户送到授权页;浏览器可能拦截弹窗,所以面板里**也**给链接。
    window.open(verificationUri, '_blank', 'noopener');
  })();
}

/**
 * 设备码轮询状态机。
 *
 * 宿主侧后端早就全在(`auth/device-start` / `auth/device-poll`),这一块是它唯一
 * 的 UI —— 细节与「为什么上游 `accounts.tsx` 的 CTA 不够用」写在
 * `preferences-dialog.tsx` 文件头的「登录为什么是真的」一节。
 *
 * ## 为什么是「上一次结束后再排下一次」而不是 `setInterval`(2026-11 重写)
 *
 * 旧实现用固定 `setInterval(interval)`,并把 `slow_down` 当成普通 pending **完全忽略**
 * —— 于是用户已经授权、令牌却永远拿不到:GitHub 每次都回 `slow_down`、每次把要求的
 * 间隔再加 5 秒,而客户端照旧按原节奏打(真机实测见 {@link nextDevicePollInterval})。
 * 现在:
 *  - 用 `setTimeout` **链**:下一次只在本轮 `await` 结束之后才排,永远不会叠加并发轮询;
 *  - `slow_down` 时按 GitHub 给的 `interval`(缺失才 +5 秒)退避,**只增不减**;
 *  - 退避只更新 `state.interval`(见下面那条注释),面板上「每 N 秒检查一次」因此与
 *    真实节奏是同一个数。
 *
 * 终止仍由状态机完成:成功 / 出错 / 过期都会把 `kind` 从 `waiting` 移走,这个 effect
 * 随之清理定时器(不会留下孤儿轮询,这是 §10.8 记的那类泄漏)。
 *
 * @param store - 登录成功后要同步登录态的那份 store 面。
 * @param startDeviceSignIn - 外壳给的「去要设备码」实现。
 * @returns 状态与四个写动作(全是具名成员,供组件写成 `onClick={device.start}`)。
 */
export function useDeviceSignIn(
  store: IPreferencesStore,
  startDeviceSignIn: StartDeviceSignIn,
): IDeviceSignIn {
  const [state, setState] = useState<DeviceFlowState>({ kind: 'idle' });
  /** 防止卸载后 setState(轮询是异步的)。 */
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  const accept = useCallback((started: IDeviceCodeStart) => {
    if (!aliveRef.current) { return; }
    setState({
      kind: 'waiting',
      deviceCode: started.deviceCode,
      userCode: started.userCode,
      verificationUri: started.verificationUri,
      interval: Math.max(3, started.interval),
      // 与旧实现逐字相同的两条夹逼:轮询不慢于 3 秒,有效期不短于 60 秒。
      expiresAt: Date.now() + Math.max(60, started.expiresIn) * 1000,
    });
  }, []);

  const start = useCallback(() => {
    setState({ kind: 'starting' });
    /*
     * 失败通道:host 起不来时面板必须**说话**(改前是静默 return ⇒ 永远停在
     * 「正在向 GitHub 申请设备码…」)。`aliveRef` 守卫与轮询那条同源:卸载后不再 setState。
     */
    startDeviceSignIn(accept, (message) => {
      if (!aliveRef.current) { return; }
      setState({ kind: 'error', message });
    });
  }, [startDeviceSignIn, accept]);

  useEffect(() => {
    if (state.kind !== 'waiting') { return; }
    const deviceCode = state.deviceCode;
    const expiresAt = state.expiresAt;
    /*
     * 本轮 effect 的存活标记:比 `aliveRef` 更严 —— 它连「同一次挂载里 effect 因
     * `state.interval` 变化而重排」也算作作废(`await` 之后的续体不许再动状态)。
     */
    let cancelled = false;
    let timer: number | undefined;

    const tick = async (): Promise<void> => {
      if (cancelled) { return; }
      if (Date.now() > expiresAt) {
        setState({ kind: 'error', message: '设备码已过期,请重新点击登录。' });
        return;
      }
      const result = await api.devicePoll(deviceCode);
      if (cancelled) { return; }
      if (!result.ok) {
        setState({ kind: 'error', message: result.error.message });
        return;
      }
      const poll = result.value;
      if (poll.status === 'pending') {
        const next = nextDevicePollInterval(state.interval, poll);
        /*
         * ⚠️ `slow_down` 时**只更新 state、不在这里排下一次**:effect 的依赖里有 `state`,
         * 它会用新间隔重排。若改成「自己排下一次 + 顺手 setState」,就会同时存在两条链
         * (effect 重排一条、本函数一条),间隔再也说不清 —— 而「面板显示的间隔」与
         * 「真实节奏」必须是同一个数。
         */
        if (next !== state.interval) {
          setState({ ...state, interval: next });
          return;
        }
        timer = window.setTimeout(() => { void tick(); }, next * 1000);
        return;
      }
      if (poll.status === 'error') {
        setState({ kind: 'error', message: poll.message });
        return;
      }
      // 成功:host 已经把令牌落盘,这里只把**登录态**同步进 store(并刷新远端清单)。
      store.setAuth(poll.state);
      void store.loadRemoteRepos(true);
      store.toast(`已登录 @${poll.state.login}`);
      setState({ kind: 'done', login: poll.state.login });
    };

    timer = window.setTimeout(() => { void tick(); }, state.interval * 1000);
    return () => {
      cancelled = true;
      if (timer !== undefined) { window.clearTimeout(timer); }
    };
  }, [state, store]);

  const dismiss = useCallback(() => { setState({ kind: 'idle' }); }, []);

  return { state, start, accept, dismiss };
}

/**
 * 设备码登录面板。
 *
 * 为什么不塞进上游 `accounts.tsx`:那个文件是**上游镜像**(只在镜像闸门里登记过
 * 少量偏离),而它开出来的两个插槽是给**PAT 入口**的窄口子(见 `patSignInAction` /
 * `patSignInForm`);设备码面板是**页级**结构(在 `Accounts` 之上),`AccountNotice` 在它之下 ——
 * 塞进「谁已登录」的清单里也不合理;
 * 而这是**我们产品**多出来的一条通道(宿主有设备码后端,Desktop 没有)。所以它渲染在
 * 页面容器里、上游页面**之上** —— 与「仓库」页同理:我们独有的 UI 放我们这层。
 * @param props - 状态机当前值 + 重试/关闭。
 */
export function DeviceFlowPanel(props: {
  state: DeviceFlowState;
  onRetry: () => void;
  onDismiss: () => void;
}): ReactNode {
  const { state } = props;
  if (state.kind === 'idle') { return null; }

  return (
    <div className="gw-device-flow" role="status" aria-live="polite">
      {state.kind === 'starting' && <p>正在向 GitHub 申请设备码…</p>}
      {state.kind === 'waiting' && (
        <>
          <p>
            在浏览器里打开{' '}
            <a href={state.verificationUri} target="_blank" rel="noreferrer noopener">
              {state.verificationUri}
            </a>
            ,输入下面的设备码:
          </p>
          <p className="gw-device-code">{state.userCode}</p>
          <p className="gw-device-hint">授权后本窗口会自动完成登录(每 {state.interval} 秒检查一次)。</p>
        </>
      )}
      {state.kind === 'done' && <p>已登录 @{state.login}。</p>}
      {state.kind === 'error' && (
        <>
          <p className="gw-device-error">登录失败:{state.message}</p>
          <button className="gw-btn" onClick={props.onRetry}>重试</button>
        </>
      )}
      {state.kind !== 'done' && (
        <button className="gw-btn ghost" onClick={props.onDismiss}>关闭提示</button>
      )}
    </div>
  );
}

/**
 * 「无障碍」页两条真偏好的写回调。
 *
 * ## 为什么需要 `latest` 这个 ref,而不是把 `onPreferencesChanged` 列进依赖
 *
 * `onPreferencesChanged` 是**调用点每次渲染新建的**闭包(两个外壳都这么传),把它列进
 * `useCallback` 的依赖表就等于「每渲染一次换一个新回调」。而我们**没有理由**制造那次
 * 重渲染:上游 `Accessibility` 是个 `React.Component`,它把回调接在 `onChange` 上。
 * 用 ref 把「最新那个」读出来,回调身份就与 props 无关。
 *
 * 回调体只有两件事:**写 localStorage 偏好 + 通知外壳重渲染**
 * (只写不通知 = 「设置看着改了、刷新才变」,那是假接线)。
 *
 * @param onPreferencesChanged - 外壳的「请重渲染」回调。
 * @returns 两条偏好各自的当前值与写回调。
 */
export function useAccessibilityWiring(onPreferencesChanged: () => void): {
  readonly underlineLinks: boolean;
  readonly showDiffCheckMarks: boolean;
  readonly onUnderlineLinksChanged: (value: boolean) => void;
  readonly onShowDiffCheckMarksChanged: (value: boolean) => void;
} {
  const latest = useRef(onPreferencesChanged);
  latest.current = onPreferencesChanged;

  // 「Underline links」是**真偏好**:写 localStorage 并广播,由根类消费。
  const underlineLinks = useUnderlineLinks();

  const onUnderlineLinksChanged = useCallback((value: boolean) => {
    setUnderlineLinks(value);
    latest.current();
  }, []);

  /**
   * 「在 diff 里显示勾选标记」—— **读同一个偏好源**。
   *
   * `useShowDiffCheckMarks()` 与 `desktop-diff.tsx` 用的是同一个 `useSyncExternalStore`
   * 订阅(`diff-mode.ts`),所以:打开页面时读到的就是**当前生效值**(不是硬编码);
   * 勾一下立刻广播,`desktop-diff.tsx` 同帧重渲染 ⇒ **diff 的勾选列当场变化**。
   * 这正是 §11.3 那条验收(「accessibility 页里能切换 diff 勾选列可见性并真的影响
   * diff 的勾选列」)的机制。
   */
  const showDiffCheckMarks = useShowDiffCheckMarks();

  const onShowDiffCheckMarksChanged = useCallback((value: boolean) => {
    setShowDiffCheckMarks(value);
    latest.current();
  }, []);

  return { underlineLinks, showDiffCheckMarks, onUnderlineLinksChanged, onShowDiffCheckMarksChanged };
}

/**
 * 宿主偏好字符串(`host-theme.ts` 的 `HostThemePreference`)→ 上游 `ApplicationTheme`。
 *
 * 两边取值**逐字相同**(`'light' | 'dark' | 'system'`),所以这是纯类型层面的映射 ——
 * 但仍然显式写出来:上游 `ApplicationTheme` 是**字符串 enum**(名义类型),直接互转会在
 * 类型上骗过编译器;写成 switch 之后,任一侧新增成员都会在这里编译报错。
 * @param pref - 宿主那边的偏好。
 * @returns 上游 enum 成员。
 */
function applicationThemeOf(pref: HostThemePreference): ApplicationTheme {
  switch (pref) {
    case 'light': return ApplicationTheme.Light;
    case 'dark': return ApplicationTheme.Dark;
    default: return ApplicationTheme.System;
  }
}

/**
 * {@link applicationThemeOf} 的反方向(色板 → 宿主 `setTheme`)。
 * @param theme - 上游 enum 成员。
 * @returns 宿主偏好字符串。
 */
function preferenceOfTheme(theme: ApplicationTheme): HostThemePreference {
  switch (theme) {
    case ApplicationTheme.Light: return 'light';
    case ApplicationTheme.Dark: return 'dark';
    default: return 'system';
  }
}

/**
 * 「外观」页四条真偏好的**读 / 写**。
 *
 * ## 每一条写回调都做两件事:写偏好 + 通知外壳重渲染
 *
 * 只写不通知 = 「设置看着改了、刷新才变」,那是假接线(与
 * {@link useAccessibilityWiring} 同一条纪律)。日期/时间/数字格式尤其明显:
 * `lib/format-date.ts` / `lib/format-number.ts` 是**渲染时直读**的,
 * 而写 localStorage 不会通知同页的其它组件。
 *
 * ## 为什么 Theme 走 `useHostThemePreference()` 而不是本地 state
 *
 * 宿主是**真源**:它可能被别的入口改(宿主自己的 General 段、系统主题变化),
 * `host-theme.ts` 的 `useSyncExternalStore` 订阅会把变化回显到色板。
 * 自己存一份 state 就会出现「两个真源谁赢」的问题。
 *
 * ## 为什么格式偏好要本地 state
 *
 * `models/formatting-preferences.ts`(与上游一致)只提供 `get*` / `set*`,
 * **没有订阅机制**,而 `Appearance` 是个受控的 `React.Component`
 * (`appearance.tsx:217-256`:值全部来自 props)。所以读写都在本钩子里:
 * 写进 localStorage、同时进本地 state 触发重渲染 —— 读点仍然只有
 * `getDateFormatPreference()` 一处(初值时读)。
 *
 * @param onPreferencesChanged - 外壳的「请重渲染」回调。
 * @returns 上游 `Appearance` 需要的 7 组 prop(值 + 写回调)。
 */
export function useAppearanceWiring(onPreferencesChanged: () => void): {
  readonly selectedTheme: ApplicationTheme;
  readonly onSelectedThemeChanged: (theme: ApplicationTheme) => void;
  readonly selectedTabSize: number;
  readonly onSelectedTabSizeChanged: (size: number) => void;
  readonly alwaysShowWorktreeList: boolean;
  readonly onAlwaysShowWorktreeListChanged: (value: boolean) => void;
  readonly selectedDateFormat: DateFormat;
  readonly onSelectedDateFormatChanged: (format: DateFormat) => void;
  readonly selectedTimeFormat: TimeFormat;
  readonly onSelectedTimeFormatChanged: (format: TimeFormat) => void;
  readonly selectedNumberFormat: INumberFormat;
  readonly onSelectedNumberFormatChanged: (format: INumberFormat) => void;
  readonly preferAbsoluteDates: boolean;
  readonly onPreferAbsoluteDatesChanged: (value: boolean) => void;
} {
  const latest = useRef(onPreferencesChanged);
  latest.current = onPreferencesChanged;

  /* ---------- 1. Theme(宿主 `theme` 服务 = 真源) ---------- */
  const selectedTheme = applicationThemeOf(useHostThemePreference());
  const onSelectedThemeChanged = useCallback((theme: ApplicationTheme) => {
    setHostThemePreference(preferenceOfTheme(theme));
    latest.current();
  }, []);

  /* ---------- 2. Diff Tab Size(`prefs.ts` 的 `diff-tab-size`) ---------- */
  const selectedTabSize = useDiffTabSize();
  const onSelectedTabSizeChanged = useCallback((size: number) => {
    setDiffTabSize(size);
    latest.current();
  }, []);

  /* ---------- 3. Formatting(三条,与上游一致的 localStorage 偏好) ---------- */
  const [selectedDateFormat, setSelectedDateFormatState] = useState<DateFormat>(getDateFormatPreference);
  const [selectedTimeFormat, setSelectedTimeFormatState] = useState<TimeFormat>(getTimeFormatPreference);
  const [selectedNumberFormat, setSelectedNumberFormatState] = useState<INumberFormat>(getNumberFormatPreference);
  const [preferAbsoluteDates, setPreferAbsoluteDatesState] = useState<boolean>(getPreferAbsoluteDates);

  const onSelectedDateFormatChanged = useCallback((format: DateFormat) => {
    setDateFormatPreference(format);
    setSelectedDateFormatState(format);
    latest.current();
  }, []);
  const onSelectedTimeFormatChanged = useCallback((format: TimeFormat) => {
    setTimeFormatPreference(format);
    setSelectedTimeFormatState(format);
    latest.current();
  }, []);
  const onSelectedNumberFormatChanged = useCallback((format: INumberFormat) => {
    setNumberFormatPreference(format);
    setSelectedNumberFormatState(format);
    latest.current();
  }, []);
  const onPreferAbsoluteDatesChanged = useCallback((value: boolean) => {
    setPreferAbsoluteDates(value);
    setPreferAbsoluteDatesState(value);
    latest.current();
  }, []);

  /**
   * 「Always show worktree list」—— **有意的 no-op**,而且它并不可见。
   *
   * 产品里**没有 worktree**(§1.3 排除),上游那个值也没有任何消费方;控件本身由适配层
   * 删掉(`scss/preferences.scss` 适配块第 1 条 `display:none !important`,探针的
   * `removed` 组会断言它 `0×0`)。上游 `appearance.tsx:291-300` 无条件渲染这个
   * `Checkbox`,所以 prop 必须给 —— 给一个**具名**空实现,并在调用点写清为什么,
   * 而不是塞一个 `() => {}` 让人猜。
   *
   * **可回收条件**:产品真有 worktree 列表时(宿主/我们任一侧),把它接到那个状态上并
   * 删掉适配层的删除规则。
   */
  const onAlwaysShowWorktreeListChanged = useCallback((_value: boolean): void => {
    // 故意为空:控件不可见(适配层 display:none),没有可兑现的语义。
  }, []);

  return {
    selectedTheme,
    onSelectedThemeChanged,
    selectedTabSize,
    onSelectedTabSizeChanged,
    alwaysShowWorktreeList: false,
    onAlwaysShowWorktreeListChanged,
    selectedDateFormat,
    onSelectedDateFormatChanged,
    selectedTimeFormat,
    onSelectedTimeFormatChanged,
    selectedNumberFormat,
    onSelectedNumberFormatChanged,
    preferAbsoluteDates,
    onPreferAbsoluteDatesChanged,
  };
}

/**
 * {@link PreferencesPageBody} 的全部输入。
 *
 * 这份 prop 面**刻意逐字保留** `IPreferencesDialogProps` 里被各页面读到的那些成员
 * (`store` / `auth` / `fontScale` / `onFontScale` / `onPreferencesChanged`),
 * 于是两个外壳各自从**自己的**数据源把同样的语义填进来即可。
 * (`snap` 原先也在这一行里 —— 它随「仓库」页一起移除,见下面 `store` 那条注释。)
 */
export interface IPreferencesPageBodyProps {
  /** 当前选中的页面。 */
  readonly tab: PreferencesTabId;
  /** 登录态(账号页)。`null` = 未登录。 */
  readonly auth: PreferencesAuth;
  /**
   * 本插件 store 的最小子面。
   *
   * ⚠️ 它原先是**两个**页面的数据源(「仓库」页 + 账号页的设备码流程);「仓库」页
   * 按用户指令移除之后,今天只有账号页在读它。**没有**顺手删掉
   * {@link IPreferencesStore} 的成员(「先做,不删」)。
   *
   * ⚠️ 2026-10:这里原有一个 `snap: IPreferencesSnapshot`(仓库清单 + 当前仓库),
   * 唯一消费者就是被移除的「仓库」页。它**必须一起删**:留着就是一个
   * `react/no-unused-prop-types` 的新增违规(`check-lint` 的棘轮只拦上升)——
   * 那也是「页面真没了」的机器证据之一。类型本身
   * ({@link IPreferencesSnapshot} / {@link IPreferencesRepoEntry})与 `store` 上
   * 那些方法**都保留**。
   */
  readonly store: IPreferencesStore;
  /** 界面缩放(px 字号)。`0` = 不覆盖,用宿主默认。 */
  readonly fontScale: number;
  /** 写入界面缩放。 */
  readonly onFontScale: (value: number) => void;
  /** 退出登录(`store.logout()`)。 */
  readonly onLogout: () => void;
  /** 见 {@link StartDeviceSignIn}。 */
  readonly startDeviceSignIn: StartDeviceSignIn;
  /**
   * **「某个显示类偏好变了,请让整棵 workbench 重新渲染一次」**。
   *
   * 日期/时间/数字格式与「首选编辑器」是**渲染时直读**的(`lib/format-date.ts` /
   * `lib/format-number.ts` 每次调用都读偏好;`changes-view.tsx` 在 render 里读
   * `getPreferredExternalEditor()`),而 localStorage 写入**不会**通知同页的其它组件。
   * 只写不通知 = 「设置看着改了、界面要刷新才变」,那还是假接线。
   */
  readonly onPreferencesChanged: () => void;
}

/**
 * 渲染当前选中那一页的正文(含账号页顶部那块设备码面板)。
 *
 * **不含页签控件、不含外层容器、不含页脚** —— 那三样属于外壳,理由见文件头那张表。
 * 调用方负责把这一坨放进自己的 `role=tabpanel` 容器里。
 *
 * @param props - 见 `IPreferencesPageBodyProps`。
 */
export function PreferencesPageBody(props: IPreferencesPageBodyProps): ReactNode {
  const device = useDeviceSignIn(props.store, props.startDeviceSignIn);
  const accessibility = useAccessibilityWiring(props.onPreferencesChanged);
  /*
   * 「外观」页的 7 组 prop。**必须无条件调用**(Rules of Hooks):下面的 `switch` 会
   * 按页签提前 `return`,所以钩子只能在这里调一次。
   */
  const appearance = useAppearanceWiring(props.onPreferencesChanged);
  /*
   * 「提示与确认」页的 5 条真偏好(其余 7 个控件由适配层删除,见 `case 'prompts'`)。
   * 与上面同一条理由:**必须无条件调用** —— `switch` 会按页签提前 `return`。
   */
  const prompts = usePromptsWiring(props.onPreferencesChanged);

  /*
   * ---- 账号邮箱(Author 邮箱下拉 / misattribution 告警的数据源)----
   *
   * `api.accountEmails()` 是 host 半的新路由(`auth/emails`,**未登录 ⇒ 空数组**)。
   * 未登录时不发请求(`enabled = props.auth !== null`),于是也不会有一条无意义的
   * 失败日志。三个消费方:**账号页**(`Accounts` 的邮箱候选 / 头像)、
   * **Git 页**(`GitPage` 的 `emailCandidates` → 上游 `GitConfigUserForm` 的下拉)、
   * 以及将来的提交者告警(`account-emails.tsx` 的 `commitAuthorWarning`)。
   */
  const emails = useAccountEmails(props.auth !== null);
  const reloadEmails = emails.reload;
  /*
   * GitHub App 的**安装状态**(「授权 ≠ 安装」)。与邮箱同一个形状:登录后才查,
   * 且只有 `not-installed` 会在页面上说话(`account-emails.tsx` 的 `AccountNotice` 里那句)。
   */
  const installation = useAppInstallation(props.auth !== null);
  const reloadInstallation = installation.reload;

  /*
   * 登录成功之后的回声。前三件与设备码那条路**逐字同形**(`useDeviceSignIn` 内部做的
   * 就是 `store.setAuth` → `loadRemoteRepos(true)` → `toast`;这里自己实现是因为
   * PAT 那条路不经过它)。第四件是新增的:重拉账号邮箱 —— 换账号(令牌轮换 / 换企业
   * 实例)之后下拉里的邮箱必须跟着换,否则用户可能把提交记到上一个账号的地址上。
   * 第五件同理:换账号之后**安装状态也可能不同**(PAT ↔ GitHub App、装了 A 没装 B)。
   */
  const onEnterpriseSignedIn = useCallback((state: AuthStatePayload) => {
    props.store.setAuth(state);
    void props.store.loadRemoteRepos(true);
    props.store.toast(`已登录 @${state.login}`);
    reloadEmails();
    reloadInstallation();
  }, [props.store, reloadEmails, reloadInstallation]);

  const emailList = emails.result !== null && emails.result.kind === 'ok' ? emails.result.emails : [];
  const identity: IAuthIdentity | null =
    props.auth === null
      ? null
      : { login: props.auth.login, endpoint: props.auth.endpoint };
  /*
   * ⚠️ **空数组时上游表单自己就不渲染下拉**(`git-config-user-form.tsx:181-186` 的
   * `accountEmails.length === 0 ⇒ return null`)。我们**不**在这里补任何「空下拉」——
   * 喂空数组就是那条判断,这正是要求的语义。
   */
  const emailCandidates = accountCandidatesFor(identity, emailList);

  /*
   * ⚠️ **Git 页拿到的是上面那份「未收窄」的候选**,收窄在 `git-page.tsx` 里做
   * (它在 `<Git accounts=…>` 那个调用点上经 `accountsUsableAsEmailCandidates`)。
   *
   * 为什么必须把收窄挪进去:同一个 `Account[]` 在 Git 页有**两个角色** ——
   * ①给镜像 `git-config-user-form.tsx` 当**邮箱下拉候选**(必须收窄:`:77-79` 会给
   * GitHub.com 账号无条件追加一条由 `account.id` 拼出来的 stealth 地址,而我们的 `id`
   * 只能是 `-1` ⇒ 一条**没有任何已验证邮箱**的账号会渲染出唯一一条**伪造地址**);
   * ②给**作者自动识别**当回退来源(上游 `preferences.tsx:267-275` 用的是**全部**
   * accounts)。两个角色原先分散在两个文件里,收窄发生在这里时,①的输入被裁掉之后
   * ②就再也拿不到「没有已验证邮箱但已登录」的那个账号了 —— 而那正是需要自动识别
   * 登录名、同时**不能**伪造邮箱的那一档。
   * 判据、证据与回收条件仍在 `account-emails.tsx` 的 `accountsUsableAsEmailCandidates`。
   */
  const gitAccounts = emailCandidates;

  /*
   * ---- 端点 + PAT 登录(多企业账号)----
   *
   * 端点必须在**这一个**钩子里持有,因为上游 `Accounts` 的 `onEnterpriseSignIn`
   * 与下面的面板读的是同一份状态(见 `account-emails.tsx` 的钩子注释)。
   */
  const signIn = useEnterpriseSignIn({
    onSignedIn: onEnterpriseSignedIn,
    onDeviceSignIn: device.start,
  });

  switch (props.tab) {
    /*
     * ⚠️ 2026-10:`case 'repositories'` **按用户指令整页移除**(理由与「仓库管理仍在
     * `repo-bar.tsx` 的仓库下拉里完整可达」的证据见 `TABS` 上面那一节)。
     * 原来它渲染的是 `RepositoriesSection`(手写)+ 上游 `DialogContent` 那一层内边距;
     * 两者一起删掉了 —— 页面没了,内边距也就没有承载体。
     */
    case 'accounts':
      return (
        <>
          {/*
            设备码面板(我们独有的 UI)也包进 `DialogContent` —— 与上游 `Accounts` 同一层
            内边距。它自带 `.gw-device-flow` 的 padding/边框,所以外观不变,但**内容左沿**
            与同页其余元素对齐(改前它是 `.dialog-content` 的**兄弟**,靠自己的 padding 撑着)。
          */}
          <DialogContent>
            <DeviceFlowPanel state={device.state} onRetry={device.start} onDismiss={device.dismiss} />
          </DialogContent>
          {/*
            **账号页从上到下就是三段(2026-11 用户给定)**:
              ① 设备码面板(只在流程进行中有内容)
              ② 上游 `Accounts`(谁已登录的清单 + 两个登录 CTA;**PAT 入口与表单也在这里**,
                 见它那两个插槽 `patSignInAction` / `patSignInForm`)
              ③ `AccountNotice`(安装检测与引导;邮箱**成功**时不再上屏)
            每块各包一层 `DialogContent`(内边距来源与理由见上面那一段;
            左边线是 `docs/preferences-port.md` §11 与节奏探针钉住的读数)。
          */}
          <Accounts
            accounts={emailCandidates}
            // 上游 `preferences.tsx:484-492`:登录先关弹窗,再交给 dispatcher。
            // 我们**不关弹窗** —— 设备码面板就在这一页里,关掉反而看不到码。
            onDotComSignIn={device.start}
            /*
             * ⚠️ **不能**把它接成 `device.start`(改前就是):`api.deviceStart()`
             * 没有端点参数,host 打的是 github.com 的设备码端点 ⇒ 选了企业实例再点
             * 「Sign in to GitHub Enterprise」会**静默登进 github.com**。
             * 端点不是 GitHub.com 时,`signIn.onEnterpriseSignIn` 会**把 PAT 表单打开**、
             * 把焦点移到令牌输入,并说清原因,而不是假装登录。
             */
            onEnterpriseSignIn={signIn.onEnterpriseSignIn}
            // 以前这里是空实现(`onLogout: () => {}`)⇒「Sign Out」点了没反应。
            // 现在走 store 的 `logout()`(`api.logout` → `auth/logout` 路由,host 删令牌)。
            onLogout={props.onLogout}
            /*
              ★ PAT 那两个插槽(2026-11,在上游镜像里登记过的**结构**偏离):按钮进
              GitHub.com 的动作行(与登录 / 退出登录并排),表单紧跟 GitHub.com 那一段。
              默认都关着 —— 只有点【PAT 令牌登录】或企业 CTA 才会出现输入框。
            */
            patSignInAction={<PatSignInAction signIn={signIn} />}
            patSignInForm={<PatSignInForm signIn={signIn} />}
          />
          <DialogContent>
            <AccountNotice installation={installation.status} emails={emails.result} />
          </DialogContent>
        </>
      );
    /*
     * ⚠️ 2026-10:`case 'integrations'`(外部集成)仍**不在**这里 —— 它的控件本来就
     * 已被适配层隐藏(`showOpenDialog` 是替身、`open-in-app` 只认探测到的 id),
     * 加它就是接一串死代码。文件在镜像树里,要加随时是接线活。
     */
    case 'git':
      /*
       * **上游页面逐字节镜像 + 我们的接线层。**
       *
       * `GitPage`(`src/client/git-page.tsx`)负责三件事:①读/写**全局** git config
       * (`user.name` / `user.email` / `init.defaultBranch`)—— 上游
       * `preferences.tsx:277-278` 与 `:1041/:1046` 用的就是 global 作用域;
       * ②把 Hooks 的三个偏好接到客户端镜像 `lib/hooks/config.ts`(与上游
       * `:262-264` / `:1079-1087` 逐字同形);③喂 `onEditGlobalGitConfig` 回调
       * (`git-config-links.tsx` 的 `useEditGlobalGitConfig`,含锁文件告警)。
       *
       * `gitAccounts` 就是**邮箱下拉的数据源**(未收窄;收窄在 `git-page.tsx` 里,
       * 理由见上面 `gitAccounts` 那段注释):上游 `GitConfigUserForm`
       * (`:168-170`)在 `accountEmails.length === 0` 时 `return null`,所以我们把
       * `api.accountEmails()` 的真邮箱经 `accountsWithEmails()` 喂进去。
       * **空数组时下拉照样不出现** —— 那条判断在上游镜像里,不是我们写死的。
       * 同一个数组还喂**作者自动识别**(登录名 / 首选邮箱),两件事的输入面因此只有一份。
       */
      return <GitPage toast={props.store.toast} emailCandidates={gitAccounts} />;
    case 'appearance':
      return (
        <>
          <Appearance
            selectedTheme={appearance.selectedTheme}
            onSelectedThemeChanged={appearance.onSelectedThemeChanged}
            selectedTabSize={appearance.selectedTabSize}
            onSelectedTabSizeChanged={appearance.onSelectedTabSizeChanged}
            // 见 `useAppearanceWiring` 里那条注释:控件被适配层删除(产品无 worktree),
            // 所以值是恒 `false` + 具名 no-op —— **不是**「点了没反应的开关」,
            // 而是一个**看不见**的控件(探针 `removed` 组会断言它 0×0)。
            alwaysShowWorktreeList={appearance.alwaysShowWorktreeList}
            onAlwaysShowWorktreeListChanged={appearance.onAlwaysShowWorktreeListChanged}
            selectedDateFormat={appearance.selectedDateFormat}
            onSelectedDateFormatChanged={appearance.onSelectedDateFormatChanged}
            selectedTimeFormat={appearance.selectedTimeFormat}
            onSelectedTimeFormatChanged={appearance.onSelectedTimeFormatChanged}
            selectedNumberFormat={appearance.selectedNumberFormat}
            onSelectedNumberFormatChanged={appearance.onSelectedNumberFormatChanged}
            preferAbsoluteDates={appearance.preferAbsoluteDates}
            onPreferAbsoluteDatesChanged={appearance.onPreferAbsoluteDatesChanged}
          />
          {/*
            ⭐ **「界面缩放」—— 2026-10 从原「仓库」页**搬到这里**(用户指令:
            「这个 tab 里的**字号设置应该移动到【外观】**这个 tab」)。

            ## 为什么是这一页、为什么在这个位置
            - **上游没有这个控件**,所以没有「上游的位置/文案」可以照抄。核对过:
              `references/desktop/app/src/ui/preferences/**` 里 `fontSize` / `font-size` /
              `zoom` 的命中数是 **0**;上游 `appearance.tsx` 的三节依次是
              Theme → Formatting → Miscellaneous(`:308-310`)。
            - 放在上游 `Appearance` **之后**,也就是紧接它最后一节 **Miscellaneous**
              (`appearance.tsx:272-303`,那一节装的正是不属于主题/格式的显示类偏好:
              Diff Tab Size / Always show worktree list)⇒ 语义上它属于那一节的续篇,
              与「外观 = 显示类偏好」的归属一致。
            - **文案保持中文**(「界面缩放」/「字号(px,0 = 跟随宿主)」):`docs/goal-port-desktop.md`
              §11.9 的裁决是「结构/行为照抄上游,用户可见文案本地化成中文」。
            - **外面这层 `DialogContent` 不是装饰**:我们的控件是手写的,不像上游页面
              自带那一层,少了它就会贴着页签栏的竖线(原「仓库」页的实测读数 1px vs 21px,
              `docs/probes/preferences-rhythm-probe.mjs`)。它与上游 `Appearance` 自己的
              `DialogContent` 是**兄弟**,各带各的内边距 —— 与账号页那三个 `.dialog-content`
              (设备码面板 / 上游 `Accounts` / `AccountNotice`)是同一形态。**不要**改成手写 `padding`(那是第二份真源)。
          */}
          <DialogContent>
            <FontScaleSection value={props.fontScale} onChange={props.onFontScale} />
          </DialogContent>
          {/*
            ⭐ **这里曾经有两块「上游控件搬来外观页」的手写内容 —— 2026-10 都已迁走**。

            ## 1. 「显示提交摘要长度提示」(功能点 **12.13**)—— 已删(上一轮)

            上游这个复选框住在 **Preferences ▸ Prompts ▸ `Commit Length`**
            (`ui/preferences/prompts.tsx:326-337`),我们当时整页删除了 Prompts
            ⇒ 上一轮把它放到「外观」页是**自造入口**(用户原话:「上游明明没有」),
            按裁决删除。

            ## 2. 三条「确认提示」开关(功能点 **12.16**)—— **本轮迁到 Prompts 页**

            它们**本来就是**上游 Prompts 页上的控件
            (`ui/preferences/prompts.tsx:236-303` 的 `show-confirm-dialog-heading` 那一组),
            放在「外观」页是同一个自造入口的另一处。2026-10 用户裁决「可以加 Prompts 页」
            之后,上一轮写下的两条**回收条件**都已满足:

              · 12.13 的:「若将来 Prompts 页真的落地(整页加回来 / 加第六个页签),
                把复选框接在**那一页**的 `Commit Length` 一节里」;
              · 12.16 的:同一个裁决下的另一处(上一轮只登记了「留给下一轮裁决」)。

            ⇒ 12.13 的复选框 + 12.16 的三条复选框**现在都在 Prompts 页上**
            (`case 'prompts'`,页面本体是镜像,不是手写的),本节连
            `CommitLengthWarningSection` / `ConfirmationPromptsSection` /
            `ConfirmPromptRow` 一起删除(删干净,不留「定义了但没人用」)。
            判据:`changes-summary-length-pref-probe`(S1/S2 按设计变更改写)与
            `changes-confirm-pref-probe`(S1/S4 改成渲染 **prompts** 页)。
          */}
        </>
      );
    /*
     * ========================================================================
     * **提示与确认(Prompts)—— 2026-10 用户裁决后加回来的整页**
     * ========================================================================
     *
     * 与 `git` / `appearance` / `accessibility` 同一形态:**页面本体是逐字节镜像**,
     * 本模块只喂 prop。`Prompts`(`ui/preferences/prompts.tsx`)自己渲染
     * `<DialogContent>`,所以这里**不再**包一层(包两层 = 双份内边距,
     * `preferences-rhythm-probe` 会当场量出来)。
     *
     * ## 上游这一页有 12 个控件,我们**发车 6 个、其余 7 个由适配层删除**
     *
     * 镜像一字不改 ⇒ 上游那 10 个复选框 / 1 组三选一**都会渲染**。凡是「动作在本插件里
     * 真的存在」的都接了线;**没有落点的那几个由 `scss/preferences.scss` 适配块第 12 条
     * 用 `display:none !important` 删除**(与外观页那条 worktree 同一手法、同一条纪律:
     * 删除落在渲染层,因为镜像不能删单个 `<Checkbox>`)。
     *
     * ⇒ 「可见的控件全都真能兑现」+「隐藏的控件各有具名理由」,没有第三种。
     * 逐条理由 / 消费方 `file:line` / 判据见 `preferences-dialog.tsx` 文件头的 Prompts 表。
     *
     * ## 为什么这条链必须在**本模块**里(而不是各外壳各写一份)
     *
     * `usePromptsWiring` 与 `useAppearanceWiring` 同源同形:读偏好 + 写偏好 + 通知外壳。
     * 两个渲染面(模态 / 宿主设置卡片)共用本函数,所以「Prompts 页接线了几条」只有
     * 一个答案。
     */
    case 'prompts':
      return (
        <Prompts
          /* ---------- 发车的 5 条(每一条都有真消费方)---------- */
          confirmDiscardChanges={prompts.confirmDiscardChanges}
          onConfirmDiscardChangesChanged={prompts.onConfirmDiscardChangesChanged}
          confirmDiscardStash={prompts.confirmDiscardStash}
          onConfirmDiscardStashChanged={prompts.onConfirmDiscardStashChanged}
          confirmUndoCommit={prompts.confirmUndoCommit}
          onConfirmUndoCommitChanged={prompts.onConfirmUndoCommitChanged}
          askForConfirmationOnCommitFilteredChanges={
            prompts.askForConfirmationOnCommitFilteredChanges
          }
          onAskForConfirmationOnCommitFilteredChanges={
            prompts.onAskForConfirmationOnCommitFilteredChanges
          }
          showCommitLengthWarning={prompts.showCommitLengthWarning}
          onShowCommitLengthWarningChanged={prompts.onShowCommitLengthWarningChanged}
          /*
           * ---------- 删除的那 7 个:值取上游默认,回调取**具名**空实现 ----------
           *
           * ⚠️ 这六对「恒 `false` + 空回调」(外加三选一那一组)**不是**「点了没反应的开关」
           * ——它们是**看不见**的控件:适配层 `display:none !important`,逐条 0×0 由
           * `docs/probes/preferences-prompts-probe.mjs` 的 `H1`/`H3` 在真 Chrome 里断言
           * (`H2` 是同帧阳性对照:发车的那 4 行仍然可见)。给**具名**空实现而不是内联
           * `() => {}`,是为了让「这里为什么没有行为」在调用点一眼可见(与
           * `onAlwaysShowWorktreeListChanged` 同一条纪律)。
           */
          confirmRepositoryRemoval={false}
          onConfirmRepositoryRemovalChanged={noopOmittedPrompt}
          confirmDiscardChangesPermanently={false}
          onConfirmDiscardChangesPermanentlyChanged={noopOmittedPrompt}
          confirmCheckoutCommit={false}
          onConfirmCheckoutCommitChanged={noopOmittedPrompt}
          confirmForcePush={false}
          onConfirmForcePushChanged={noopOmittedPrompt}
          confirmCommitMessageOverride={false}
          onConfirmCommitMessageOverrideChanged={noopOmittedPrompt}
          confirmWorktreeRemoval={false}
          onConfirmWorktreeRemovalChanged={noopOmittedPrompt}
          /*
           * 三选一那一组(切分支时未提交改动的去向)—— 产品里**没有切分支动作**
           * (分支面板只读),策略类型与 `app-store` 的策略都在 §1.3 排除面里。
           * 值取上游声明默认 `AskForConfirmation`(`models/uncommitted-changes-strategy.ts:7`)。
           */
          uncommittedChangesStrategy={UncommittedChangesStrategy.AskForConfirmation}
          onUncommittedChangesStrategyChanged={noopUncommittedChangesStrategy}
        />
      );
    case 'notifications':
      /*
       * 上游这一页只有 h2 + Checkbox + 权限提示(`notifications.tsx:51-70`);
       * 我们多的那一块(「本次会话已发出 N 条」+「发送测试通知」)是**生产者存在性**
       * 的证据 —— 详见 `notifications-panel.tsx` 文件头「为什么这一页不止一个开关」。
       *
       * ⚠️ 包 `DialogContent` 的理由与「仓库」那一支**完全一样**(上游这一页自己也渲染
       * `<DialogContent className="advanced-section">`,见 `notifications.tsx` 的骨架),
       * 只是我们这一页的实现是手写的、不自己渲染那一层,所以由调用点补。
       * 上游的 `<DialogContent>` 在这里是**页面自己**渲染的,我们放在调用点,
       * 等价且只有一份。
       */
      return (
        <DialogContent>
          <NotificationsPanel onPreferencesChanged={props.onPreferencesChanged} />
        </DialogContent>
      );
    case 'accessibility':
      return (
        <Accessibility
          underlineLinks={accessibility.underlineLinks}
          onUnderlineLinksChanged={accessibility.onUnderlineLinksChanged}
          // 上游 `appearance` 里这个值由 `app-store` 的订阅喂;我们读同一条偏好
          // (`diff-mode.ts` 的 `useShowDiffCheckMarks`),所以**关掉它 diff 立刻变**。
          showDiffCheckMarks={accessibility.showDiffCheckMarks}
          onShowDiffCheckMarksChanged={accessibility.onShowDiffCheckMarksChanged}
        />
      );
    default:
      return null;
  }
}

/**
 * 「界面缩放」——**从原「仓库」页搬来**(2026-10 用户指令)。
 *
 * ## 为什么它在这里,而不是照抄上游某处
 *
 * 上游 Preferences **没有**这个控件(核对过:`references/desktop/app/src/ui/preferences/**`
 * 里 `fontSize` / `font-size` / `zoom` 命中 0)。它是我们手写设置面固有的一个偏好,
 * 真落点在 `prefs.ts` 的 `fontScaleStore`(host 半 `prefs/get`/`prefs/set` 持久化,
 * `.gw-root` 的 `style.fontSize` 消费它)。⇒ 「位置」只能按语义定:它是**显示类**偏好,
 * 归「外观」,渲染在上游 `Appearance` 的 **Miscellaneous** 那一节之后。
 *
 * ## 为什么不并进上游 `Appearance`
 *
 * `ui/preferences/appearance.tsx` 是**逐字节镜像**(`verify-mirror` 要求),
 * 给它的 prop 面加一个 `fontScale` 会同时改镜像与它的 prop 类型 ——
 * 本项目最贵的一条纪律就是「镜像一字不改,适配放我们这层」。
 * ⇒ 以**兄弟节点**渲染:与账号页那三个 `.dialog-content` 是同一形态。
 *
 * ## 输入语义(与旧实现逐字相同)
 *
 * `Number(...) || 0`:空串 / 非数 ⇒ `0` = 跟随宿主(`workbench.tsx:325` 在 `0` 时不写行内字号)。
 * 经 ref 读 `onChange`:`PreferencesPageBody` 收到的 `props` 每次渲染都是新对象,
 * 直接依赖它等于每次换一个新回调(`react-hooks/exhaustive-deps` 也会要求列出整个 `props`)。
 * 用 ref 取最新那个,回调身份就与它无关。
 * @param props - `value` = 当前字号(px,`0` = 跟随宿主);`onChange` = 写回。
 */
function FontScaleSection(props: {
  value: number;
  onChange: (value: number) => void;
}): ReactNode {
  const latestFontScale = useRef(props.onChange);
  latestFontScale.current = props.onChange;
  const onFontScaleInput = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    latestFontScale.current(Number(event.currentTarget.value) || 0);
  }, []);

  return (
    <div className="gw-settings-section">
      <h3>界面缩放</h3>
      <p className="settings-description">
        只影响本插件的字号;宿主自己的界面不受影响。
      </p>
      <div className="gw-field">
        <label htmlFor="gw-prefs-font-scale">字号(px,0 = 跟随宿主)</label>
        <input
          id="gw-prefs-font-scale"
          className="gw-input"
          type="number"
          min={0}
          max={24}
          value={props.value}
          onChange={onFontScaleInput}
        />
      </div>
    </div>
  );
}

/**
 * **一个布尔偏好的「读 + 写 + 订阅」** —— Prompts 页 5 条开关共用的那一格。
 *
 * ## 为什么是 `useState` + `subscribePreference` 而不是 `useSyncExternalStore`
 *
 * 与 `src/client/prefs.ts` 里那几个键的 JSDoc 同一条,**实测过的**渲染路径约束:
 * 渲染本页的 jsdom 探针(`changes-confirm-pref-probe` / `changes-summary-length-pref-probe`)
 * 跑的是 **React 17.0.2**,而 `useSyncExternalStore` 是 18 才有的导出 ——
 * 用它会炸成 `TypeError: … is not a function`,整棵树被卸载,判据直接失真。
 * 存储、键名、广播机制一个字没换:读用 `prefs.ts` 的 getter,订阅用同一个
 * `subscribePreference`,`setValue` 也是同一个写函数。
 *
 * ## 「写偏好 + 通知外壳」两件事一件都不能少
 *
 * 只写不通知 = 「设置看着改了、要刷新才变」,那是本仓反复点名的假接线
 * (同 {@link useAppearanceWiring} / {@link useAccessibilityWiring})。
 * `onPreferencesChanged` 用 ref 取最新值:调用点每次渲染都会新建那个闭包,
 * 把它列进依赖表等于每帧换一个新回调。
 *
 * @param storageKey - 键名(喂 `subscribePreference`;`prefs.ts` 导出的 `*_KEY`)。
 * @param getValue - 读函数(**模块级稳定引用**,列在 `useEffect` 依赖里)。
 * @param setValue - 写函数(同上)。
 * @param onPreferencesChanged - 外壳的「请重渲染」回调。
 * @returns `[当前值, 写回调]`。
 */
function useBooleanPreference(
  storageKey: string,
  getValue: () => boolean,
  setValue: (value: boolean) => void,
  onPreferencesChanged: () => void,
): readonly [boolean, (value: boolean) => void] {
  const latest = useRef(onPreferencesChanged);
  latest.current = onPreferencesChanged;

  const [enabled, setEnabled] = useState(getValue);
  useEffect(
    () => subscribePreference(storageKey, () => { setEnabled(getValue()); }),
    [storageKey, getValue],
  );

  const onEnabledChanged = useCallback((value: boolean) => {
    setValue(value);
    latest.current();
  }, [setValue]);

  return [enabled, onEnabledChanged];
}

/**
 * **「提示与确认」页(上游 Prompts)发车的那 5 条偏好** —— 读 / 写 / 订阅。
 *
 * ## 为什么只有 5 条(逐条判据,不是「还没接」)
 *
 * 上游这一页有 12 个控件;本插件**只有当被守卫的动作真的存在、且读侧真的读这个键**时才发车:
 *
 * | 上游控件 | 键 | 我们的落点 |
 * |---|---|---|
 * | Discarding changes | `confirmDiscardChanges` | `changes-view.tsx` 的丢弃闸门(`gateOf`) |
 * | Discarding stash | `confirmDiscardStash` | 同文件 stash 面板那颗「丢弃」 |
 * | Undo commit | `confirmUndoCommit` | 同文件 `requestUndo`(工作区脏时) |
 * | Committing changes hidden by filter | `confirmCommitFilteredChangesKey` | 同文件 `showPromptForCommittingFileHiddenByFilter` ⇒ 镜像 `ConfirmCommitFilteredChanges` 弹窗 |
 * | Show commit length warning | `showCommitLengthWarning` | 同文件 `CommitBox` 的 `showCommitLengthWarning && form.summary.length > 50` |
 *
 * 其余 7 个**没有落点**(仓库移除确认框在 `repo-bar.tsx` 里恒弹、无偏好键;永久丢弃 /
 * checkout commit / force push / 生成信息覆盖 / worktree 移除 / 切分支策略在本插件里
 * 没有对应动作或没有偏好键)⇒ 由 `scss/preferences.scss` 适配块第 12 条
 * `display:none !important` 删除。**逐条理由与上游 `file:line` 在
 * `preferences-dialog.tsx` 文件头的 Prompts 表里**,这里不重复第二份。
 *
 * ## ⚠️ 12.16 那三条不改变默认行为
 *
 * 上游声明默认都是 `true`(`app-store.ts:490/492/495`)且**无迁移垫片**;
 * `confirmCommitFilteredChangesKey` 上游默认也是 `true`;只有 `showCommitLengthWarning`
 * 的**观测**默认是 `true`(声明 `false` + 迁移垫片,见 `prefs.ts` 那段 JSDoc)。
 *
 * ## ⚠️ 一条**与上游同形**的诚实边界:镜像页是 class 组件,props 只在挂载时快照一次
 *
 * `ui/preferences/prompts.tsx` 的 `constructor`(`:55-73`)把 props 抄进内部 state,之后
 * **只由它自己的 `onChange` 回写**。所以:
 *  · **模态外壳**(本仓的弹窗)每次切到这一页都会**重新挂载**(`PreferencesPageBody` 的
 *    `switch` 换掉子树)⇒ 复选框读到的是**当时**的偏好,与用户预期一致;
 *  · **宿主设置卡片**那一侧**所有面板同时挂载**、用 `hidden` 控偏好,于是这一页只在卡片
 *    首次渲染时读一次 —— 之后从**别处**改这 5 个键(另一个渲染面 / 直接写 `localStorage`)
 *    不会回显。
 *  这一档**与上游同形**(Desktop 的 `preferences.tsx` 也是把 app-store 的值快照进
 *  `state.selectedXxx`),所以本轮**刻意不**给镜像件加订阅:那要改镜像;要做就得在**我们这层**
 *  包一个受控包装(把 `Prompts` 用 `key` 重挂,或加一层 `useSyncExternalStore` 驱动的包装)。
 *  今天没有任何用户路径会踩到它(这一页的 5 个键**只有这一页**能写),所以登记而不实现。
 *  判据侧的写法(切走再切回再量)与理由写在 `changes-confirm-pref-probe` 的 `S1` 那一段。
 *
 * @param onPreferencesChanged - 外壳的「请重渲染」回调。
 * @returns 上游 `Prompts` 需要的 5 组 prop(值 + 写回调)。
 */
export function usePromptsWiring(onPreferencesChanged: () => void): {
  readonly confirmDiscardChanges: boolean;
  readonly onConfirmDiscardChangesChanged: (value: boolean) => void;
  readonly confirmDiscardStash: boolean;
  readonly onConfirmDiscardStashChanged: (value: boolean) => void;
  readonly confirmUndoCommit: boolean;
  readonly onConfirmUndoCommitChanged: (value: boolean) => void;
  readonly askForConfirmationOnCommitFilteredChanges: boolean;
  readonly onAskForConfirmationOnCommitFilteredChanges: (value: boolean) => void;
  readonly showCommitLengthWarning: boolean;
  readonly onShowCommitLengthWarningChanged: (value: boolean) => void;
} {
  const [confirmDiscardChanges, onConfirmDiscardChangesChanged] = useBooleanPreference(
    CONFIRM_DISCARD_CHANGES_KEY, getConfirmDiscardChanges, setConfirmDiscardChanges, onPreferencesChanged);
  const [confirmDiscardStash, onConfirmDiscardStashChanged] = useBooleanPreference(
    CONFIRM_DISCARD_STASH_KEY, getConfirmDiscardStash, setConfirmDiscardStash, onPreferencesChanged);
  const [confirmUndoCommit, onConfirmUndoCommitChanged] = useBooleanPreference(
    CONFIRM_UNDO_COMMIT_KEY, getConfirmUndoCommit, setConfirmUndoCommit, onPreferencesChanged);
  const [askForConfirmationOnCommitFilteredChanges, onAskForConfirmationOnCommitFilteredChanges] =
    useBooleanPreference(
      CONFIRM_COMMIT_FILTERED_CHANGES_KEY, getConfirmCommitFilteredChanges,
      setConfirmCommitFilteredChanges, onPreferencesChanged);
  const [showCommitLengthWarning, onShowCommitLengthWarningChanged] = useBooleanPreference(
    SHOW_COMMIT_LENGTH_WARNING_KEY, getShowCommitLengthWarning, setShowCommitLengthWarning,
    onPreferencesChanged);

  return {
    confirmDiscardChanges,
    onConfirmDiscardChangesChanged,
    confirmDiscardStash,
    onConfirmDiscardStashChanged,
    confirmUndoCommit,
    onConfirmUndoCommitChanged,
    askForConfirmationOnCommitFilteredChanges,
    onAskForConfirmationOnCommitFilteredChanges,
    showCommitLengthWarning,
    onShowCommitLengthWarningChanged,
  };
}

/*
 * ==========================================================================
 * 被删除的那 7 个控件的**具名**回调占位
 * ==========================================================================
 *
 * 镜像 `ui/preferences/prompts.tsx` 一字不改 ⇒ 那 7 个 `<Checkbox>` / `<RadioGroup>`
 * 照样渲染,prop 面必须给齐。它们**没有可兑现的语义**(每一条的理由见
 * `preferences-dialog.tsx` 文件头的 Prompts 表),所以:
 *
 *  1. 控件本体由 `scss/preferences.scss` 适配块第 12 条 `display:none !important` 删除
 *     ⇒ **不是**「点了没反应」的可见控件,而是**看不见**的控件(探针 geometry 的
 *     removed 组断言它们 `0×0`);
 *  2. 回调写成**模块级具名函数**(不是 JSX 里的内联 `() => {}`,也不是每帧新建的闭包)
 *     —— 于是「这里为什么没有行为」在调用点一眼可见,且身份恒定。
 *
 * 为什么必须**删得掉**:留着它们就是本仓反复点名的「可见但无作用的控件」那一类静默缺陷。
 */

/**
 * 被删除的 6 个复选框(仓库移除 / 永久丢弃 / checkout commit / force push /
 * 生成信息覆盖 / worktree 移除)的 `onChange` 占位。
 *
 * 它们**永远不会被调用**(控件是 `display:none`,不在命中区、也不在无障碍树里);
 * 参数以下划线开头,免得 lint 以为写漏了。
 * @param _checked - 上游 `Checkbox.onChange` 的载荷(我们不用)。
 */
function noopOmittedPrompt(_checked: boolean): void {
  // 故意为空:对应的动作在本插件里没有落点,控件已由适配层删除。
}

/**
 * 被删除的「If I have changes and I switch branches…」三选一的 `onSelectionChanged` 占位。
 *
 * 产品里**没有切分支动作**(分支面板只读),上游那个 `UncommittedChangesStrategy`
 * 也只有 `models/uncommitted-changes-strategy.ts` 的声明 + 镜像页渲染者,没有消费方。
 * @param _value - 上游 `RadioGroup.onSelectionChanged` 的载荷(我们不用)。
 */
function noopUncommittedChangesStrategy(_value: UncommittedChangesStrategy): void {
  // 故意为空:同上,控件已由适配层删除。
}

/**
 * 把宿主的登录态 + `api.accountEmails()` 的邮箱包成上游 `Account` ——
 * **账号页与 Git 页共用的那一份候选**。
 *
 * ## 为什么必须存在
 *
 * 上游 `accounts.tsx` 与 `ui/lib/git-config-user-form.tsx` 都只吃 `Account` 实例
 * (那份 `models/account.ts` 是**字节一致**的镜像,不许改成「我们的形状」)。
 * 而 `GitConfigUserForm` 的邮箱下拉有一句 `accountEmails.length === 0 ⇒ return null`
 * (`git-config-user-form.tsx:181-186`):**候选来自 `Account.emails`**。
 *
 * ⚠️ **改前这里构造的 `Account` 传的是空邮箱数组** ⇒ 那句判断永远命中 ⇒
 * **邮箱下拉永远不出现**。那是「控件在、数据没有」的静默缺陷,不是界面没写。
 * 现在邮箱来自 `api.accountEmails()`;**未登录、或该账号没有已验证邮箱时仍然是
 * 空数组,下拉照样不渲染** —— 这正是要求的语义,不是遗漏。
 *
 * `token` 传空串、`id` 传 `-1` 的理由写在 `account-emails.tsx` 的
 * `accountsWithEmails()` 上(浏览器半没有令牌;`AuthStatePayload` 没有数值 id,
 * 所以现代 stealth 邮箱**不猜**)。
 *
 * ## 诚实边界(2026-10 已收窄)
 *
 * `endpoint` 曾经在自建模态那条路径上拿不到(`workbench.tsx` 只传 `login`/`tokenTail`)
 * ⇒ `resolveAccountEndpoint()` 只能退回「上次用过的端点」。**这条已经修掉**:
 * `workbench.tsx` 现在把 `snap.auth.endpoint` 一起传进来(`AuthStatePayload.endpoint`,
 * 老 host 不返回时仍是 `undefined`,由同一个兜底覆盖)。剩下唯一的边界是
 * **旧 host**:它不返回那个字段,于是回退到「上次用过的端点」——
 * 与账号页上那个端点输入框**同一个值**,两处不会自相矛盾。
 *
 * @param identity - 登录身份;`null` = 未登录。
 * @param emails - `auth/emails` 给的邮箱。
 */
function accountCandidatesFor(
  identity: IAuthIdentity | null,
  emails: ReadonlyArray<IAccountEmail>,
): ReadonlyArray<Account> {
  if (identity === null) {
    return [];
  }
  return accountsWithEmails(identity, emails);
}

/*
 * `useUnderlineLinks` —— 为了让「Underline links」的**读点**与**写点**同源,这里把它
 * 转出给两个外壳(`preferences-dialog.tsx` / `host-settings-card.tsx`)。
 *
 * 本模块**不自己消费**它:类的落点是作用域根(`.gw-prefs`),而那个元素由外壳拥有
 * (模态是宿主卡片的 `className`,卡片是它自己包的那层 `<div>`)。
 * 详见文件头「外壳契约」第 2 条。
 */
export { useUnderlineLinks };
