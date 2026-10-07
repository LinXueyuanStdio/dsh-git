/**
 * **Preferences 弹窗**(对应 GitHub Desktop 的 Preferences / Options)。
 *
 * ## 这个文件为什么存在(以及它**不是**什么)
 *
 * 用户指令(目标文档 §11.3):齿轮要出**居中模态**,而不是手写的下拉框。
 * 上游那条路径是 `PopupType.Preferences` → `ui/preferences/preferences.tsx`(1241 行)。
 *
 * **`preferences.tsx` 本身没有被逐字移植**,原因写在 `docs/preferences-port.md`
 * 的「被排除的文件」一节,三条都是硬约束:
 *  1. 它把 **Copilot 页签**写死在**文件内部**(`:45`/`:46-52`/`:408-413`/`:580-607`/
 *     `:1224-1239`),而 Copilot 被用户明确排除 —— 镜像不许改,于是那三个
 *     `lib/copilot*` + `lib/stores/copilot-store` 必须留替身(见 `verify-mirror.mjs`);
 *  2. 它把**整个动作面**写死在 `this.props.dispatcher` 上(`:930`/`:994`/`:1108-1215`
 *     约 40 个 setter),而 `ui/dispatcher` 是 §1.3 排除的命令总线;
 *  3. 它的「Save」写 `lib/git/config` 的全局 git config。
 *
 * 所以本文件是**我们这层的适配器**:外壳按上游 `preferences.tsx:385-443` 的结构逐块照搬
 * (`.preferences-container` + **竖向** `TabBar` + `.tab-container[role=tabpanel]` +
 * `DialogFooter`),而**每一个页面都是上游的原文件**(`ui/preferences/*.tsx`,
 * 与上游**字节一致**),中文文案一律从**调用点以 prop 传进去**(§11.9 裁决)。
 *
 * 模态外壳 = **插件自有的遮罩 + 卡片**(`./host-modal.tsx` 的 `PluginDialog`,
 * 与 `clone-dialog.tsx` **同一份实现**:点外面关闭 / Esc / 焦点 trap / 焦点归还都在那里)。
 *
 * > ⚠️ **2026-10 第二次翻转(留档,别按旧版读)**:外壳先是手写 `Dialog` + 原生
 * > `<dialog>`,再改成**宿主** `@deepseek-ai/dsh-client-ui-primitives` 的 `Modal`
 * > (portal 到 `document.body`),现在按用户要求**改回插件自有、就地渲染**的形态
 * > (原话:「要迁移到类似于 clone dialog 里弹出来,这样我们可以控制预选 tab」)。
 * > 两次翻转的逐条理由与**边界**(宿主 §10 那条「不能深链设置页签」说的是宿主自己的
 * > 设置界面,与本弹窗的 `initialSelectedTab` 不是同一件事)见 `docs/preferences-port.md`
 * > 的修订一节。**不要再把「宿主 Modal」当成当前实现来读**。
 *
 * ---
 *
 * ## ⭐ 2026-10-06:三个页面的**正文**已搬到 `./preferences-pages.tsx`
 *
 * 同样的三页现在**也**渲染在**宿主设置 ▸ 内置插件 ▸ dsh-git**的卡片里
 * (`./host-settings-card.tsx`,席位 `settings.plugins.tab`)—— 那是用户这次的要求,
 * 逐页的搬迁记录见 `docs/host-settings-card.md` §4.0。
 *
 * 本文件从此只剩**模态专有**的那一半:
 *  - `PluginDialog` 外壳(遮罩 / 居中 / Esc / 焦点环 —— 实现全在 `host-modal.tsx`);
 *  - 卡片内那一层 `#preferences.gw-prefs-body`(上游 SCSS 的 id 锚点 + 我们的竖向布局层);
 *  - 上游**竖向** `TabBar`(卡片那一侧用的是宿主 `SegmentedTabs`,两边页签控件不同);
 *  - 页脚那个 `<form>`(`OkCancelButtonGroup` 靠它才有作用)。
 *
 * 为什么正文必须**一份**:三页里有一条跨面行为(无障碍页的勾选标记要真的驱动 diff 的
 * 勾选列),复制两份之后「哪一份才是生效的」将无法回答 —— 那是本仓反复踩过的形态。
 *
 * ---
 *
 * ## 保真度账本:每个控件「接线 / 删除」及证据(验收项)
 *
 * ⚠️ 这份表的用法:任何「为什么少了一页 / 为什么没有某个开关」的问题,答案必须能在这里
 * 追溯到**具体控件 + 证据**。删除是**产品取舍**(不是遗漏),接线是**真行为**。
 *
 * ### 页签级处置
 *
 * ⚠️ **2026-10 更正(表过期过一次,留痕)**:原表里有一行「**外部集成**| 保留,
 * 编辑器下拉接线」、还列了「提示与确认 / 高级」两行的**处置**却**没有 Git 与通知两行**。
 * 那三处都与实际渲染不符:
 *   - 「外部集成」**不在** `preferences-pages.tsx` 的 `TABS` 里,`case 'integrations'`
 *     也不在 `switch` 里 ⇒ **整页不渲染**;这条现在由 `docs/probes/preferences-geometry-probe.mjs`
 *     的一条硬断言钉住(「Integrations 页按设计账本整页删除(不在页签表 ⇒ 其 Shell 段
 *     不可能存在)」),把它加回页签表会立刻变红;
 *   - Git 与通知两页**在**表里(`TABS`),原表漏了。
 * 下表按 `TABS` 的**实际五页**重写(2026-10:**「仓库」页按用户指令移除**,
 * 见 `preferences-pages.tsx` 的 `TABS` 注释 —— 仓库管理回到顶栏的仓库下拉)。
 *
 * | 页签 | 处置 | 导致处置的控件 |
 * |---|---|---|
 * | **账号** | 保留,全部接线 | 登录 CTA → 宿主**设备码流程**(`api.deviceStart`/`devicePoll`,见下);`Sign Out` → `store.logout()`(`auth/logout` 路由) |
 * | ~~**仓库**~~ | **按用户指令整页移除**(2026-10) | 原先是切换/移除/添加仓库 + 字号,全部走 store 既有方法。现在:仓库管理在顶栏「当前仓库」下拉(`repo-bar.tsx` 的 `RepositoryPanel`,本体是逐字镜像的 `ui/repositories-list/**`);**字号搬到了「外观」页**(`FontScaleSection`)。`store.selectRepo`/`removeRepo`/`addRepoViaDialog` 与 `IPreferencesStore` 上的三个声明**都没删**(「先做,不删」) |
 * | **Git** | 保留:**三个子页签全部接线**,并补上上游的两条行为(自动识别 / 姓名校验) | Author:全局 `user.name`/`user.email` 读、写 + **按 GitHub 账号自动识别**(上游 `preferences.tsx:267-278`)+ **姓名校验**(`ui/lib/identifier-rules.ts` → `preferences.tsx:866-871/1004`);Default branch:`init.defaultBranch`(上游 `lib/helpers/default-branch.ts`);Hooks:客户端镜像 `lib/hooks/config.ts` + 写穿到宿主偏好域。全部细节在 `src/client/git-page.tsx` 的文件头 |
 * | **外观** | 保留:**Theme 接线**(宿主主题服务)、格式与 tab size 接线;worktree 开关**删除** | Theme:读 `theme.getTheme().preference` / 写 `theme.setTheme` / 订阅 `theme/change`(宿主 `ui-theme` 的 `ctx.provide('theme', …)`;桥在 `src/client/host-theme.ts`,由 `index.ts` 的 `apply()` 可选注入)。**服务缺席时**卡片带 `gw-prefs-no-theme`,由 `scss/preferences.scss` 的适配块**删掉该分区** —— 不会出现点了没反应的色板;worktree(`.always-show-worktree-list`):产品里**没有 worktree**(§1.3 排除),上游那个值也没有任何消费方 |
 * | **通知** | 保留,**换成浏览器通知**(不是上游那条 Electron 原生链) | 上游那两样(`desktop-notifications` 原生插件、`main-process-proxy` 的权限请求)在我们的替身里恒 false ⇒ 沿用就是死开关。这一页走 Web Notifications + 一个真的生产者(`notify.ts`),页面本体是手写的 `notifications-panel.tsx`(上游 `notifications.tsx` **不在镜像里**) |
 * | **提示与确认** | **整页删除** | 见下「Prompts 逐项」 |
 * | **高级** | **整页删除** | 见下「Advanced 逐项」 |
 * | **无障碍** | 保留,两条都接线 | `Underline links` → `prefs.ts` 的 `underline-links` + 根/卡片类(`.gw-root` 那半在 `pref-adapt.ts`,`gw-prefs` 那半在 `scss/preferences.scss`);`Show check marks in the diff` → Desktop 原键 `diff-check-marks-visible`(`diff-mode.ts`) |
 *
 * ### 上游有、我们**没有**的三个整页(结论,明细见下两节 + `docs/preferences-port.md` §13)
 *
 * `integrations` / `prompts` / `advanced` 三个上游页面**都在镜像树里**
 * (`src/core/desktop/ui/preferences/{integrations,prompts,advanced}.tsx`),但**都不渲染**。
 * ⇒ 它们是「整页删除」(产品取舍),不是遗漏;判据与回收条件逐条列在下两节。
 *
 * ### Prompts(13 项,整页删除 —— 逐项:它守卫什么 / 为什么在我们这里不存在)
 *
 * | 控件 | 它守卫什么(上游) | 为什么在这里不存在 |
 * |---|---|---|
 * | Removing repositories | 移除仓库前的确认框 | 我们**有**这个动作,但它今天**不在本弹窗里**:「仓库」页已按用户指令移除,移除仓库走顶栏仓库下拉的右键 `Remove…` ⇒ `repo-bar.tsx` 自己的 `ConfirmDialog`;上游那条 `dispatcher.confirmRepositoryRemoval` 路径不存在 ⇒ 该开关不会影响任何东西 |
 * | Discarding changes | 丢弃改动前的确认框 | 我们的丢弃确认写在 **`changes-view.tsx` 自己的** `ConfirmDialog` 里(无开关);接它要改那个文件的状态机,而本轮只授权了它的编辑器一处 |
 * | Discarding changes permanently | 「永久丢弃」(绕过回收站)确认框 | 我们只有一条丢弃路径(`api.discard` → `git checkout`/删未跟踪文件),**没有**「可恢复 vs 永久」两档 |
 * | Discarding stash | 丢弃 stash 确认框 | **没有 stash 界面**(host 也没有 stash 路由;§10.10 把 stash 族列为「必须补的宿主路由」) |
 * | Checking out a commit | 检出某提交确认框 | **没有检出提交的入口**(History 的 checkout 未接线) |
 * | Force pushing | 强推确认框 | 有强推动作(`repo-bar.tsx` 的 `force-push`),但确认框在 `repo-bar.tsx` 里、无开关;授权范围外的文件 |
 * | Undo commit | 撤销提交确认框 | **没有 undo commit** 动作(§10.10 已核实 `undoCommit` 是方法不是状态,我们没接) |
 * | Overriding commit message with generated message | 生成消息覆盖已填消息前确认 | 有生成能力(`commit-message/generate`),但覆盖确认要接在**提交区**(`changes-view.tsx`)里,授权范围外 |
 * | Removing worktrees | 移除 worktree 确认框 | **没有 worktree**(§1.3 排除) |
 * | Committing changes hidden by filter | 提交被筛选隐藏的改动前确认 | ⚠️ **本格原先的理由已过期,已更正**:它写「没有 hidden-changes 告警/筛选隐藏语义」,而 `changes-view.tsx:25` 现在 import 并渲染了 `HiddenChangesWarning`(`:348`,谓词 `isCommittingFileHiddenByFilter`)。真正缺的是**确认对话框**(提交前问一句),不是告警 ⇒ 该开关今天仍然没有落点,但理由是「确认流程未接线」而不是「语义不存在」 |
 * | If I have changes and I switch branches…(3 选 1) | 切分支时未提交改动的去向 | **没有切分支动作**(分支面板只读列表;`lib/stores` 的 app-store 与策略类型在 §1.3 排除) |
 * | Show commit length warning | 提交摘要过长时告警 | **没有「提交长度告警」**这个界面(只有手写的提交区) |
 *
 * ### Advanced(3 项渲染,整页删除 —— 逐项)
 *
 * | 控件 | 它守卫什么(上游) | 为什么删 |
 * |---|---|---|
 * | Show status icons in the repository list | 后台周期性抓取 + 仓库列表状态图标 | **宿主拥有抓取**:我们的仓库列表由 host 的状态轮询喂(`store.startPolling`),没有「周期性 fetch 未选中仓库」这回事;上游这个值只被 `app-state.ts:355` 声明、被 `advanced.tsx` 渲染,**零消费方**(`RepositoryIndicatorUpdater` 在 §1.3 排除) |
 * | Usage(opt out of usage tracking) | 关掉向 GitHub 上报使用统计 | **宿主已有自己的遥测设置**(DSH 的 `otel` / `session-telemetry-otel` 一族);我们在自己的弹窗里再做一遍就是**重复造宿主已有的东西** —— 与「手写 `Modal`」是同一类错误,已发生三次 |
 * | Use Git Credential Manager | 私有仓用 GCM 做凭据 | **宿主拥有凭据**:令牌只存在 host(`auth/pat`、`git-runner` 的 `credentialEnv` 用 `url.insteadOf` 注入),客户端既没有 git 也没有凭据存储 ⇒ 这个开关无从生效 |
 * | ~~Use system OpenSSH~~ | Windows 上的 OpenSSH | **上游自己就不渲染它**:`advanced.tsx:157-159` 在 `canUseWindowsSSH` 为假时 `return null`,而我们的 `lib/ssh/ssh.ts` 替身让 `isWindowsOpenSSHAvailable()` 恒 `false`(与上游非 Windows 分支一致) |
 *
 * ### 有意偏离上游的其它处(与上一轮一致,保留记账)
 *
 *  1. **没有 Copilot 页签**:用户明确排除;上游只在 `isCopilotSdkEnabled` 为真时渲染它,
 *     而我们的替身恒 `false` ⇒ 与上游在同一条件下的可见结果**一致**。
 *  2. **没有「Repositories」页签**:上游把它放在左栏(`ui/app.tsx` 的 `<RepositoriesList>`),
 *     我们**本来**在手写设置里放了一页 —— 2026-10 按用户指令**把它也移除了**
 *     (理由:「仓库的管理应该在当前仓库的 repo list 里管理」)。所以现在两边都不在
 *     Preferences 里,仓库管理只有一个落点:顶栏的仓库下拉。
 *  3. **没有 `onSave`**:页签里的开关**当场生效**(无障碍页的勾选标记、外观页的格式与
 *     tab size 都是写偏好并广播),而 `OkCancelButtonGroup` 的「保存 / 取消」都只是关闭。
 *     ⚠️ 这条**有两个已登记的后果**,不要读成「和上游一样」:
 *      - **Git 页的作者**:上游在 `onSave` 里写(`preferences.tsx:1041-1051`),我们改成
 *        「改动停下 600ms 写」(见 `git-page.tsx` 的 `WRITE_DEBOUNCE_MS`);
 *      - **上游在「取消」时会回滚的两个偏好**(theme / tab size,`preferences.tsx:374-380`),
 *        我们**不回滚** —— 理由与「要么全回滚要么都不回滚」的取舍写在
 *        `docs/preferences-port.md` §13 的「未实现」一节。
 *  4. **模态外壳是 `PluginDialog`(插件自有、就地渲染)而不是宿主 `Modal`**
 *     (见 `host-modal.tsx` 的头注释):宿主 `Modal` 已经撤掉,所以不存在
 *     「上游 `Dialog` + 宿主 `Modal` 两个 `role="dialog"` / 两套焦点 trap」的问题。
 *
 * ---
 *
 * ## 登录为什么是**真**的(设备码流程)
 *
 * 上游 `accounts.tsx` 的 CTA 只回调 `onDotComSignIn` / `onEnterpriseSignIn`,真正的 OAuth
 * 在 Desktop 的 main process 里。我们这边**宿主已经实现了设备码流程**:
 *
 *  - `auth/device-start` → `src/host/auth.ts:173`(`{deviceCode,userCode,verificationUri,expiresIn,interval}`);
 *  - `auth/device-poll` → `:201`(成功时**自己把令牌落盘**并回 `{status:'done',state}`;`authorization_pending`/`slow_down` 回 `{status:'pending'}`);
 *  - 客户端包装在 `src/client/api.ts:496-501`,而**在此之前没有任何调用方**
 *    (`store.ts` 里没有设备码方法)—— 所以这条链是「后端全在、只缺 UI」,与 §10.5 记录的那批
 *    「死 prop 但后端已就绪」是同一形态。
 *
 * 接线:点 CTA → `startDeviceSignIn()` → 弹窗里出现**设备码面板**(码 + 授权链接 + 轮询状态),
 * 轮询成功 → `store.setAuth(state)`(store 的公开方法)→ `store.loadRemoteRepos(true)`
 * (workbench 的 effect 也会因 `auth.signedIn` 变化再刷一次远端页签)。失败/过期 → 面板里
 * 显示 host 给的可读原因(hot 未配置 OAuth Client ID 时 `auth/device-start` 会直接报
 * 「host 未配置 GitHub OAuth App Client ID」,我们原样显示,不吞)。
 *
 * @module dsh-git/client/preferences-dialog
 */

import { useCallback, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { DialogFooter } from '../core/desktop/ui/dialog/footer.tsx';
import { OkCancelButtonGroup } from '../core/desktop/ui/dialog/ok-cancel-button-group.tsx';
import { TabBarType } from '../core/desktop/ui/tab-bar-type.ts';
import { Octicon } from '../core/desktop/ui/octicons/index.ts';

import { PluginDialog, TabBar } from './host-modal.tsx';
import { isHostThemeAvailable } from './host-theme.ts';
// 只给文件末尾那个 `currentDiffTabSize` 转出用(见那一段的注释)。
import { getDiffTabSize } from './prefs.ts';
import {
  PAGE_PANEL_ID,
  PreferencesPageBody,
  TAB_DOM_ID,
  TABS,
  startDeviceSignIn,
  useUnderlineLinks,
  type IPreferencesRepoEntry,
  type IPreferencesSnapshot,
  type IPreferencesStore,
  type PreferencesTabId,
} from './preferences-pages.tsx';

/*
 * ⚠️ 2026-10:三个页面(账号 / 仓库 / 无障碍)的**正文本身**已搬到
 * `./preferences-pages.tsx` —— 因为同样的三页现在**也**渲染在
 * **宿主设置 ▸ 内置插件 ▸ dsh-git** 的卡片里(`./host-settings-card.tsx`,
 * 席位 `settings.plugins.tab`)。留在本文件里的只有**模态专有**的那一半:
 * 本文件现在只剩**模态外壳**:`PluginDialog` + 上游竖向 `TabBar` + 页脚 `<form>`。
 *
 * 为什么必须拆而不是复制一份:「两份拷贝一定漂移」是本仓反复踩过的形态
 * (见 `docs/generated-css.md` 与 goal 文档 §3 的失败模式 10 那一族),
 * 而这三页里有一条**跨面行为**(无障碍页的勾选标记要真的驱动 diff 的勾选列),
 * 复制之后「哪一份才是生效的」将无法回答。
 *
 * 逐页的保真度账本(哪个控件接线 / 哪个页面删除 / 凭什么)仍留在本文件头上 ——
 * 它是**产品裁决**的记录,与「渲染在哪」无关。
 */

/** 本弹窗能渲染的分区(枚举真源在 `./preferences-pages.tsx`,这里只做转出)。 */
export type { PreferencesTabId };

/*
 * 下面这四个类型**不在这里定义,只在这里转出**:它们的真源是
 * `./preferences-pages.tsx`。骨架(`store` / `snap` / 设备码载荷)从本文件搬到那边,
 * 是因为那边才是「三个页面要什么」的定义处;留在两处 = 两份一定会漂移的契约。
 */
export type { IPreferencesRepoEntry, IPreferencesSnapshot, IPreferencesStore };

export interface IPreferencesDialogProps {
  /**
   * 登录态(账号页)。`null` = 未登录。
   *
   * 结构**逐字保留**原来那个匿名形状(而不是换成 `PreferencesAuth` 别名):`workbench.tsx`
   * 是它的调用方,而它的类型不该因为我们内部换了写法而变化。
   *
   * ⚠️ 2026-10 补 `endpoint?`:宿主 `auth/state` 一直返回它
   * (`api.ts:605-621` 的 `AuthStatePayload.endpoint`),而 `workbench.tsx` 构造这份
   * 自建模态时**只传了 `login` / `tokenTail`** ⇒ `preferences-pages.tsx:790` 的
   * `identity.endpoint` 恒 `undefined`,`resolveAccountEndpoint()` 只能退回「上次用过的
   * 端点」,于是**账号卡片显示的端点与宿主实际用的端点可能不一致**。可选是因为老 host
   * 不返回该字段,消费侧已经按 `undefined` 兜底(同 `api.ts:609-617` 那条纪律)。
   */
  readonly auth: {
    readonly login: string;
    readonly tokenTail: string;
    readonly endpoint?: string;
  } | null;
  /*
   * ⚠️ 2026-10:原先这里还有 `externalApps` 与 `onLoadExternalApps` 两个 prop ——
   * 它们**只**被已删除的外部集成页(`IntegrationsSection`)读,而那一页本来就是被适配层
   * 隐藏的死代码。一并删掉,免得留下「定义了但没人用」的 prop(`react/no-unused-prop-types`
   * 会为此报警 —— 这正是删除时要一起清干净的证据)。
   */
  /** 关闭弹窗。 */
  readonly onClose: () => void;
  /**
   * 界面缩放(px 字号)。`0` = 不覆盖,用宿主默认。
   *
   * 这一条以前只挂在**手写**设置弹窗的 Appearance 分区上;入口被本弹窗取代后,
   * 如果没人接它,`fontScale` 就永远停在 0 —— 也就是「没有可改的入口」。所以这里显式接过来
   * (§11.9:文案与入口都可以在我们这层适配,镜像文件一个字不改)。
   */
  readonly fontScale: number;
  readonly onFontScale: (value: number) => void;
  /**
   * **「某个显示类偏好变了,请让整棵 workbench 重新渲染一次」**。
   *
   * 为什么需要:日期/时间/数字格式与「首选编辑器」是**渲染时直读**的
   * (`lib/format-date.ts` / `lib/format-number.ts` 每次调用都读偏好;`changes-view.tsx`
   * 在 render 里读 `getPreferredExternalEditor()`),而 localStorage 写入**不会**通知
   * 同页的其它组件。只写不通知 = 「设置看着改了、界面要刷新才变」,那还是假接线。
   * workbench 收到这个回调就把自己的 revision state 加一,于是它下面的顶栏/列表/变更区
   * 全部重渲染并重读偏好。
   *
   * ⚠️ 宿主设置卡片那一侧的**语义等价物**在 `./prefs-bus.ts` 的
   * `bumpPreferencesRevision()`(那边没有 workbench 的 revision state 可加,
   * 卡片与 `WorkbenchApp` 是两棵树)。见 `./host-settings-card.ts` 的 `onPreferencesChanged`。
   */
  readonly onPreferencesChanged: () => void;
  /**
   * 本插件 store 的最小子面(账号页的设备码流程 / 退出登录读它)。
   *
   * 只声明本弹窗真正用到的成员(**结构化类型**),声明窄一点可以让「谁改了 store 的这几个
   * 方法」立刻在这里编译报错,而不是拖到最后才发现。
   *
   * ⚠️ 2026-10:这里原来还有一个 `snap: IPreferencesSnapshot` —— 它是被移除的
   * 「仓库」页的数据源,页面没了,prop 也一起删(留着就是一条
   * `react/no-unused-prop-types` 新增违规)。类型本身仍从本文件转出(见 `:205`)。
   */
  readonly store: IPreferencesStore;
  /**
   * **打开时预选哪一页**。省略 = 账号页(上游 `preferences.tsx:222` 的
   * `selectedIndex: this.props.initialSelectedTab || PreferencesTab.Accounts`)。
   *
   * ## 为什么需要它(不是「可选装饰」)
   *
   * 上游有**两个**调用点靠它跳到非默认页:
   *   - `ui/app.tsx:3220` ⇒ `PreferencesTab.Integrations`(集成错误对话框的「去设置」);
   *   - `ui/changes/commit-message.tsx:812` ⇒ `PreferencesTab.Git` ——
   *     就是「Committing as」卡片里那个 **`Open Git Settings`** 按钮
   *     (`ui/changes/commit-message-avatar.tsx:246/269`)。
   *
   * 我们这边以前**没有**这个 prop(硬编码 `'accounts'`)⇒「让用户直接落到某一页」
   * 这条路根本不存在。2026-10 补上之后,**两个入口都已接线**(都在 `workbench.tsx`):
   *   - 「Committing as」浮层的 `Open Git Settings` ⇒ `initialSelectedTab='git'`
   *     (上游 `commit-message.tsx:809-814`);
   *   - 弹窗的默认入口(齿轮回退 / 「更多」菜单那一项)⇒ 省略 = 账号页。
   *
   * ## 约束
   *
   * 上游语义是「**初始**值」—— 之后由组件自己的 state 接管。这里同样只当
   * `useState` 的初值用,所以**改这个 prop 不会切页**(要切页得换 `key` 或加受控通道;
   * 我们今天的调用方都是「打开时决定一次」)。这条语义有专门的探针断言
   * (`docs/probes/preferences-modal-probe.mjs` 的 C 组),不要把 `useState` 改成
   * 「跟随 props」—— 那会让用户在弹窗里点页签之后被一次无关的重渲染拽回去。
   */
  readonly initialSelectedTab?: PreferencesTabId;
}

/*
 * ⚠️ 2026-10:这里原来有一个 `PREFERENCES_CARD_STYLE = { overflowY: 'auto' }` 行内常量,
 * 用来兜住「矮窗口里卡片自己滚」。它的**回收条件**(写在那段注释里)是两条:
 *   ① `.gw-prefs-card` 自己带滚动相关布局;
 *   ② `.gw-prefs-body` 的 `min-height` 改成与包含块无关的形式。
 * 两条现在都成立了:`styles.ts` 的 `.gw-prefs-card` 改成竖向 flex 容器,
 * `.gw-prefs-body` 的 `calc(100vh - 150px)` 换成 `flex:1 1 auto;min-height:0`
 * ⇒ 超高时由 `.tab-container` 的 `overflow-y:auto` 在卡片**内部**滚,页脚仍钉在底部,
 * 卡片不需要自己滚。布局的真源回到 `styles.ts` 一处(行内样式本来只是权宜)。
 */

/**
 * 渲染 Preferences 模态。
 *
 * 三个页面的**正文**来自 `./preferences-pages.tsx`(`PreferencesPageBody`);
 * 本函数只负责**模态外壳**与**上游竖向 `TabBar`**。
 * @param props - 见 `IPreferencesDialogProps`。
 */
export function PreferencesDialog(props: IPreferencesDialogProps): ReactNode {
  /*
   * 上游 `preferences.tsx:221-222`:`selectedIndex: initialSelectedTab || Accounts`。
   *
   * 差异只有一处、而且是**有意的**:上游用 `||`,于是 `initialSelectedTab` 为
   * `PreferencesTab.Accounts`(枚举值 `0`)时也会落到 Accounts —— 结果一样。我们这里
   * 的 `PreferencesTabId` 是字符串联合,没有 `0` 这种 falsy 成员,所以用 `??` 更准确
   * (`undefined` 才回默认页);语义与上游**逐字等价**。
   */
  const [selected, setSelected] = useState<PreferencesTabId>(
    props.initialSelectedTab ?? 'accounts'
  );

  /**
   * 当前选中项在 `TABS` 里的下标。**保证 >= 0**。
   *
   * 上游 `TabBar` 的 `selectedIndex` 是 `number`(`tab-bar.tsx:12`),而
   * `Array.prototype.findIndex` 找不到时返回 `-1` —— 这里 `TABS` 一定包含 `selected`,
   * 所以用 `Math.max(0, …)` 把那个不可能的分支钉死。
   */
  const selectedIndex = useMemo(
    () => Math.max(0, TABS.findIndex((entry) => entry.id === selected)),
    [selected]
  );

  // 上游 `:1220-1222` 的 `onTabClicked` 是 `visualIndexToTab`;我们没有 Copilot 页签,
  // 视觉下标与枚举下标一一对应,所以直接按表取。
  const onTabClicked = useCallback((visualIndex: number) => {
    const entry = TABS[visualIndex];
    if (entry !== undefined) {
      setSelected(entry.id);
    }
  }, []);

  /**
   * **主题可用性 = 宿主 `theme` 服务是否接上**(不再是本地假值)。
   *
   * 服务没接上时:`hostThemeReady` 为假,弹窗给卡片挂 `gw-prefs-no-theme`,
   * `preferences.scss` 据此**把整个主题分区删掉**(而不是留一个点了没反应的色板)。
   *
   * ⚠️ 2026-10:上游 `Appearance` 页已删除,所以这里**不再读** `hostThemePreference`
   * (那个色板的回显值)。`host-theme.ts` 的桥本身保留 —— 它是「读宿主偏好」的能力,
   * 而 UI 在宿主自己的 General 段。
   */
  const hostThemeReady = isHostThemeAvailable();

  /**
   * 「Underline links」—— **读**在这一层,规则却打在 `PluginDialog` 的**卡片**上。
   *
   * 为什么:作用域根 `.gw-prefs` 就在那张卡片上,而 `scss/preferences.scss` 第 6 条把它写成
   * `&.gw-underline-links a …`(后代组合子)⇒ 类必须与 `.gw-prefs` **同一个元素**,
   * 且链接是它的后代。`PluginDialog` 的 `className` 正是那个落点。
   */
  const underlineLinks = useUnderlineLinks();

  /**
   * 「请让 workbench 重渲染」—— 上游 `Accounts` 与「无障碍」页都只需要一个
   * **无参回调**,`props.onPreferencesChanged` 正是那个形状,所以直接传。
   *
   * ⚠️ 为什么不再包一层 `useRef` 取「最新值」:`workbench.tsx` 传进来的那个箭头
   * (`() => setPrefsRevision((value) => value + 1)`)在依赖上只让两个 `useCallback`
   * 换一次身份(`onLogout` / 下面那三个页面回调),而它们接在上游的
   * `React.Component` 上、**不参与** `React.memo` 比较 ⇒ 没有可观测的代价。
   * 少一层包装 = 少一处「读的是哪个 props」的心智负担。
   */

  /**
   * 「退出登录」—— 上游 `Accounts` 只吃「无参回调」。
   * 用具名成员表达式(不是 JSX 里内联箭头):本仓 `react/jsx-no-bind` 连内联箭头都拦。
   */
  const onLogout = useCallback(() => { void props.store.logout(); }, [props]);

  /**
   * 「偏好变了」的**稳定**包装。
   *
   * `preferences-pages.tsx` 的 `useAccessibilityWiring` 把它读出来写进两条真偏好;
   * 包装一次是为了让身份与 `props` 的对象身份解耦(那个对象每次渲染都新)。
   */
  const onPreferencesChanged = useCallback(() => {
    props.onPreferencesChanged();
    // `props` 是每次渲染的新对象 ⇒ 这个 `useCallback` 事实上每次都重建。
    // 保留包装**不是**为性能,而是为了让「弹窗这一侧有哪些回调」在调用点一次可见。
  }, [props]);

  /** 三个页面要的那一份输入;只组装一次,免得每次渲染新建一个对象。 */
  const pageBody = (
    <PreferencesPageBody
      tab={selected}
      auth={props.auth}
      store={props.store}
      fontScale={props.fontScale}
      onFontScale={props.onFontScale}
      onLogout={onLogout}
      startDeviceSignIn={startDeviceSignIn}
      onPreferencesChanged={onPreferencesChanged}
    />
  );

  return (
    /**
     * **插件自有模态**(`host-modal.tsx` 的 `PluginDialog`)—— 遮罩、居中、`z-index`、
     * Esc、Tab 循环、焦点进入与归还**全部**由 `usePluginDialog` 一份实现提供
     * (与 `clone-dialog.tsx` 共用),本文件不再手写其中任何一条。
     *
     * ## 三个类名各自的职责(别再混)
     *
     * - `gw-prefs` —— **移植面的作用域根**。`prefixTopLevelSelectors()` 用**后代组合子**
     *   加前缀,所以 `scss/preferences.scss` 里的每条规则都必须是**卡片的后代**;
     *   它加在**卡片自己**身上。
     * - `gw-prefs-card` —— 覆盖 `.gw-dialog` 那套「小对话框」默认值(宽 360 / padding 14),
     *   定义在 `src/client/styles.ts`。
     * - `gw-prefs-body` —— 卡片内我们那一层(**带 `id="preferences"`**,本文件渲染):
     *   竖向排 `.preferences-container` 与 `.dialog-footer`,并给出**有效高度**。
     * - `gw-underline-links`(条件) —— 「Underline links」打开时挂上,规则在
     *   `pref-adapt.ts` 第 6 条(`.gw-root` 那一份)与 `scss/preferences.scss` 第 6 条
     *   (卡片那一份)两边都要挂:卡片就在 `.gw-root` 子树里,但 `.gw-prefs` 的规则要求
     *   类与 `.gw-prefs` **同元素**,`.gw-root` 上那个类到不了卡片。
     *
     * ## 初始焦点不需要我们操心
     *
     * `usePluginDialog` 先找 `[data-modal-autofocus]`,找不到才退到**卡片里第一个
     * 「真的能 Tab 到」的元素**(`host-modal.tsx` 的 `tabbables`:排掉
     * `tabindex="-1"`)。这里**刻意不打那个标记**:上游 `tab-bar-item.tsx:58` 只给
     * **选中的**页签 `tabIndex={selected ? undefined : -1}`,所以排掉 `-1` 之后
     * 第一个可 Tab 元素**就是当前选中的那一页**。
     *
     * ⚠️ 这一条**不是**「沿用宿主就有」的:宿主 `useModalLayer.ts:73-75` 直接
     * `querySelector('button:not(:disabled)')`,**不排 `-1`** ⇒ 以 `'git'` 打开时
     * 焦点会落在「账号」页签上(实测 `aria-selected=false`)。那是本次顺带修掉的一处
     * 真实缺陷,理由写在 `tabbables` 的 JSDoc 上。
     */
    <PluginDialog
      label="设置"
      onClose={props.onClose}
      className={[
        'gw-prefs gw-prefs-card',
        underlineLinks ? 'gw-underline-links' : '',
        hostThemeReady ? '' : 'gw-prefs-no-theme',
      ].filter(Boolean).join(' ')}
    >
      {/*
        `#preferences` —— 上游 `app/styles/ui/_preferences.scss` 整份以 `#preferences { … }`
        为根,编译+作用域化后产出 `.gw-prefs #preferences .preferences-container …`,
        **要求 `#preferences` 是 `.gw-prefs` 的后代**、且**不能同元素**
        (同元素时 `.gw-prefs #preferences X` 恒不匹配 —— 真 Chrome 用 `Element.matches`
        实测过,见 `docs/host-settings-card.md` §4.0.1)。所以它落在卡片内部这一层 wrapper 上,
        与设置卡片那一侧(`host-settings-card.tsx` 的 `<div id="preferences">`)扮演同一角色。

        它同时是 `.gw-prefs-body`(我们那层竖向布局),`usePluginDialog` 的焦点 trap
        与「Tab 首尾环绕」都在卡片这一层工作。
      */}
      <div id="preferences" className="gw-prefs-body">
        <div className="preferences-container">
          <TabBar
            onTabClicked={onTabClicked}
            selectedIndex={selectedIndex}
            type={TabBarType.Vertical}
          >
            {TABS.map((entry) => (
              <span key={entry.id} id={TAB_DOM_ID[entry.id]}>
                <Octicon className="icon" symbol={entry.symbol} />
                {entry.label}
              </span>
            ))}
          </TabBar>

          {/*
            上游 `preferences.tsx:773-781` 的 tabpanel 包装:
            `.tab-container[role=tabpanel][aria-labelledby=<tab id>]`。
            `ui/_preferences.scss:17` 的 `.preferences-container .tab-container`
            给它 `border-left: var(--base-border)` 与 `flex:1`。

            ⚠️ 这一层**故意**带 `id={PAGE_PANEL_ID[selected]}`:宿主 `SegmentedTabs` 会把
            `items[].panelId` 原样写进页签的 `aria-controls`,卡片那一侧因此必须让这个 id
            真的存在(否则 `aria-controls` 指向不存在的节点,是可达性缺陷)。模态这一侧
            顺带受益:两个外壳的面板 id 逐字相同,`aria-labelledby` 也同一个真源。
          */}
          <div
            className="tab-container"
            role="tabpanel"
            id={PAGE_PANEL_ID[selected]}
            aria-labelledby={TAB_DOM_ID[selected]}
          >
            {pageBody}
          </div>
        </div>

        {/*
          ## 这个 `<form>` 不是装饰 —— 页脚按钮**靠它**才有作用
          上游 `OkCancelButtonGroup` 刻意**不**自己接关闭回调:它的「保存」是
          `<button type="submit">`、「取消」是 `<button type="reset">`
          (`ok-cancel-button-group.tsx:150`/`:168`,非 destructive 分支),真正处理的是
          上游 `Dialog` 里那层 `<form onSubmit={this.onSubmit} onReset={this.onDismiss}>`
          (`dialog.tsx:949-951`)。我们撤掉 `Dialog`(后来也撤掉了宿主 `Modal`)之后必须
          把这层补回来,否则两个按钮**点了没反应**(探针 S7b 就是靠这条抓到的)。
          `.gw-prefs-form` 只是 `display:contents`,让 form 不参与布局。
        */}
        <form
          className="gw-prefs-form"
          onSubmit={(event) => { event.preventDefault(); props.onClose(); }}
          onReset={(event) => { event.preventDefault(); props.onClose(); }}
        >
          <DialogFooter>
            <OkCancelButtonGroup okButtonText="保存" cancelButtonText="取消" />
          </DialogFooter>
        </form>
      </div>
    </PluginDialog>
  );
}

/*
 * ⚠️ 2026-10:原先这里还有三个**本文件私有**的家伙,已随「三页搬进 `preferences-pages.tsx`」
 * 一起删除(留着就是第二份真源):
 *   · `DeviceFlowPanel`(设备码面板)—— 现在是 `preferences-pages.tsx` 的导出组件;
 *   · `RepositoriesSection`(「仓库」页正文)—— 同上,现在是那边的私有组件;
 *   · `accountsFromAuth()`(宿主登录态 → 上游 `Account`)—— 同上,现在是那边的私有函数。
 * 本文件现在只剩**模态外壳**:`PluginDialog` + 上游竖向 `TabBar` + 页脚 `<form>` +
 * `#preferences.gw-prefs-body` 那一层。
 */

/**
 * 「Diff Tab Size」的当前值。
 *
 * 单独导出是为了让探针/测试能拿到**与产品完全一致**的读法(默认值来自
 * `src/client/prefs.ts` 的 `DIFF_TAB_SIZE_DEFAULT = 4`,与上游 `tabSizeDefault` 一致)。
 * ⚠️ 它今天是**纯转出**(没有任何调用方):写点(外观页的 `selectedTabSize` 下拉)
 * 随那一页一起删掉了。调 `getDiffTabSize()` 必须 import 那个符号,否则本文件会
 * 变成一个「导出但立刻抛 ReferenceError」的陷阱。
 */
export const currentDiffTabSize = getDiffTabSize;

/*
 * ⚠️ 2026-10:`applicationThemeOf()` / `preferenceOf()`(宿主偏好字符串 ↔ 上游
 * `ApplicationTheme` 两个方向的映射)已随外观页一起删除 —— 那一页是它们**唯一**的调用点。
 * 主题的读写本身仍然在(`src/client/host-theme.ts`),宿主自己的 General 段就是它的 UI。
 */
