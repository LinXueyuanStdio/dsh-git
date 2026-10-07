/**
 * dsh-git 浏览器半入口:注册官方右侧栏 tab 类型 + 正文席位。
 *
 * 注册路径(照 dsh-client-ui-sidebar-right 的公开两阶段):
 *   1. ctx.sidebarRightTabs.register({ id, kind, title, guide }) —— 类型声明;
 *   2. ctx.slots.register({ name: 'sidebar.right.pane.tab', key: id }, Body) —— 正文。
 * 标题席位可选,未注册时用打开时保存的文本。
 *
 * @module dsh-git/client
 */

// **必须是第一条 import**:见 src/client/polyfills.ts —— 上游
// ui/lib/list/section-list.tsx 在 ResizeObserver 回调里调 setImmediate,
// 而浏览器没有这个全局(打开仓库下拉即触发)。副作用导入放在最前面,
// 保证其余模块的模块级代码与后续回调都在替身装好之后才可能执行。
import './polyfills.ts';

import { createElement, Fragment, type ReactElement } from 'react';
import type { ClientCtx, SidebarRightTabsLike } from './types.ts';
import { ensureStyles } from './styles.ts';
import { ensureBaseStyles } from './styles-base.ts';
import { ensureDesktopDiffStyles } from './desktop-diff-styles.ts';
import { WorkbenchApp } from './workbench.tsx';
import { FrameToasts, registerToastSource } from './bits.tsx';
import { ErrorBoundary } from './error-boundary.tsx';
import { GitStore } from './store.ts';
import {
  bootstrapCardStore, cardAuthOf,
  DSH_GIT_NS, DshGitSettingsCardController,
  type IConfigFormsLike, type IDshGitCardPagesFace, type IDshGitSettings,
} from './host-settings-card.ts';
import { bumpPreferencesRevision } from './prefs-bus.ts';
import { bindAutoRefreshFromHost, type IHostSettingsSlice } from './host-settings.ts';
import { DshGitCard } from './host-settings-card.tsx';
import { attachHostTheme } from './host-theme.ts';
import { attachHostSettingsOpener } from './host-settings-open.ts';

/** Cordis 插件名。 */
export const name = 'dsh-git';

/** 构建时间戳(由 scripts/build.mjs 通过 esbuild define 注入)。 */
declare const __BUILD_STAMP__: string | undefined;

/** 本产物的构建时间;未注入时回退为「未知」。 */
const BUILD_STAMP: string = typeof __BUILD_STAMP__ === 'string' ? __BUILD_STAMP__ : '未知';

/** 本插件在右侧栏里的 tab 类型 id(全局唯一)。 */
export const TAB_ID = 'dsh-git';

/**
 * chip 上**显示**的 tab 名(不带 `dsh-` 前缀;用户 2026-10 裁决)。
 *
 * 与 {@link TAB_ID} 分开是刻意的:`TAB_ID` 是身份(席位 key、sidebar 布局记录里的键),
 * 改它等于让已存的布局认不出这个 tab;而这个常量只是给人看的名字。
 * 三处显示面(类型 `title()`、guide 条目、{@link GitTabTitle} 的兜底文案)都引它,
 * 免得三处各写一遍然后漂移。
 */
const TAB_TITLE = 'git';

/*
 * `sidebarRightTabs` **故意不在这里**。
 *
 * cordis 的静态 `inject` 只有「必需」一种语义(见 `@deepseek-ai/cordis` 的
 * `src/registry.ts`:数组形式 = 必需,对象形式的值是拦截配置)—— 声明了就**必须等到位**。
 * 而「右侧栏」并不是每个环境都有:普通 `dsh web` 的 profile 里,提供方
 * `@deepseek-ai/dsh-client-ui-sidebar-right` 只被 `dsh-web-app/cordis.patch.yml` 按名字引用、
 * 却不在公开 npm 的可用版本上(实测 0.1.5-alpha.1 vs 宿主 0.2.0-rc.2),服务因此永远不来。
 * 后果不是「我们的 tab 不出现」,而是**整个插件 pending、整个 Web UI 报
 * "Failed to load plugins / 1 entry did not activate"** —— 2026-10 实测踩到。
 *
 * 所以它按本仓 `types.ts:43` 的约定当**可选服务**:走 `ctx.get()`,拿不到就跳过注册。
 */
export const inject = ['slots'];

/** 每个会话共享一个 store(跨视图状态)。 */
const stores = new Map<string, GitStore>();

/**
 * store 的「选目录」入口。
 *
 * 返回 `null` 表示**本客户端没有可用选择器**(注意:不是「用户取消了」)——
 * 调用方必须据此回退到 host 侧的 `@pick` 路由。以前这里无脑返回
 * `Promise.resolve(null)`,把「没有选择器」和「用户取消」混成同一件事,
 * 于是回退分支永远不可达、点按钮彻底没反应。
 */
export function clientPickDirectory(): Promise<string | null> | null {
  return pickDirectoryViaClient === undefined ? null : pickDirectoryViaClient();
}

/**
 * 宿主提供的原生目录选择(客户端侧服务 `uiWorkspace.pickDirectory`)。
 *
 * 这是 Desktop「Choose…」的原生弹窗路径;它比 host 侧的
 * `directoryPickerController` 更可靠(后者在桌面端可能被 cordis 拒之门外,见
 * index.ts(host) 里那段注释)。拿不到就返回 null,由调用方降级。
 */
let pickDirectoryViaClient: (() => Promise<string | null>) | undefined;

function storeFor(sessionId: string): GitStore {
  const key = sessionId === '' ? '__global__' : sessionId;
  const existing = stores.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const created = new GitStore(key === '__global__' ? '' : key);
  created.setDirectoryPicker(clientPickDirectory);
  stores.set(key, created);
  return created;
}

export function apply(ctx: ClientCtx): void {
  // 顺序要紧:基底(与上游同源)→ 本插件补充/覆盖 → 从 Desktop 移植的 diff 样式表
  // (SCSS 按上游编译 + 作用域化,见 desktop-diff-styles.ts)。
  ensureBaseStyles();
  ensureStyles();
  ensureDesktopDiffStyles();

  // 前端产物同样会陈旧:刷新页面会重新拉 lib/client.js,但**不会**重新拉 host 半,
  // 于是容易出现「界面是新的、host 是旧的」。把构建时间打进控制台便于对照。
  console.info(`[dsh-git] client build ${BUILD_STAMP} UTC`);

  // 接上客户端的原生目录选择。
  // 用 ctx.inject(等待服务出现)而不是 ctx.get(可能还没挂载),并且不写进 inject:
  // 硬依赖会让本插件在没有该服务的 profile 里整个不激活。
  // 拿不到也没关系 —— store 会回退到 host 侧的 directoryPickerController。
  try {
    ctx.inject?.(['uiWorkspace'], (injected) => {
      const nav = injected.get('uiWorkspace') as { pickDirectory?: () => Promise<string | null> } | undefined;
      if (nav !== undefined && typeof nav.pickDirectory === 'function') {
        pickDirectoryViaClient = () => nav.pickDirectory!();
      }
      return undefined;
    });
  } catch (error) {
    console.warn(`[dsh-git] 无法接入 uiWorkspace.pickDirectory,将只用 host 侧目录选择:${String(error)}`);
  }

  registerHostSettingsCard(ctx);

  /*
   * 接上**宿主的主题服务**(Preferences ▸ 外观 的那个色板)。
   *
   * 与上面 `uiWorkspace` 同一套路子:可选服务注入、不进 `inject` 数组(硬依赖会让本插件
   * 在没有该服务的 profile 里整个不激活)。拿不到服务时弹窗会把主题分区**删掉**
   * (`gw-prefs-no-theme`,见 `scss/preferences.scss` 的适配块)—— 而不是画一个点了没反应的色板。
   * 细节与证据链见 `src/client/host-theme.ts` 的头注释。
   */
  try {
    attachHostTheme(ctx);
  } catch (error) {
    console.warn(`[dsh-git] 宿主主题服务未接入,外观页主题分区将不显示:${String(error)}`);
  }

  /*
   * 接上**宿主设置面板的入口**(⚙ 用)。
   *
   * 同上:可选服务注入、不进 `inject` 数组。这里只读宿主 `shortcuts` catalog 里
   * `settings.open` 那一行(宿主自己的键位真源)—— 宿主**没有**可编程打开设置的
   * 服务,所以打开动作走宿主自己的控件,细节与完整证据链见
   * `src/client/host-settings-open.ts` 与 `docs/host-settings-card.md` §1。
   */
  try {
    attachHostSettingsOpener(ctx);
  } catch (error) {
    console.warn(`[dsh-git] 宿主设置入口未接入(shortcuts 接不上),齿轮将回退到「更多」菜单:${String(error)}`);
  }

  ctx.effect(() => {
    /*
     * 可选服务:属性访问(`ctx.sidebarRightTabs`)对未声明的服务会被 cordis 拒绝,
     * 所以走 `ctx.get()`,并且连 `get` 抛错也要兜住 —— 拿不到就只是「这个环境没有右侧栏」,
     * 不该让插件加载失败。
     */
    let tabs: SidebarRightTabsLike | undefined;
    try {
      tabs = ctx.get?.('sidebarRightTabs') as SidebarRightTabsLike | undefined;
    } catch {
      tabs = undefined;
    }
    if (tabs === undefined || typeof tabs.register !== 'function') {
      console.warn('[dsh-git] 这个环境没有 sidebarRightTabs(右侧栏未组合),跳过 tab 注册;插件其余能力照常');
      return;
    }
    const slots = ctx.slots;
    if (slots === undefined) {
      console.warn('[dsh-git] slots 不可用,右侧栏正文未注册');
      return;
    }

    const disposeType = tabs.register({
      id: TAB_ID,
      kind: 'dsh-git',
      priority: 'extension',
      /*
       * chip 上的**名字**是 `git`,不带 `dsh-` 前缀 —— 见 {@link TAB_TITLE}。
       * 只有显示名去掉前缀:`id`/`kind` 仍是 `dsh-git`(身份),`/dsh-git/*` 路由与
       * npm 包名同样不动。
       */
      title: () => TAB_TITLE,
      guide: [{
        order: 55,
        title: () => TAB_TITLE,
        icon: (props: { size?: number }) => gitIcon(props?.size ?? 16),
      }],
    });

    const disposeBody = slots.inject('sidebar.right.pane.tab', () => slots.register({
      name: 'sidebar.right.pane.tab',
      key: TAB_ID,
      inject: (sessionId: string) => ({ sessionId }),
    }, (props: { sessionId?: string }) => createElement(WorkbenchApp, {
      store: storeFor(props?.sessionId ?? ''),
      sessionId: props?.sessionId ?? '',
    })));

    /*
     * chip 上的图标走**标题席位**,不是类型定义。
     *
     * 类型注册的字段只有 `{ id, kind, patterns?, priority?, canOpen?, title, guide?,
     * keepMounted? }` —— `icon` 只存在于 `guide` 的**条目**上(胶囊用)。chip 的图标
     * 归 `sidebar.right.pane.tab.title` 这一席:官方 `dsh-client-ui-sidebar-files`
     * 的 `FilesTitle` 就是这个形状(见下面 `GitTabTitle` 的注释)。不注册这一席时,
     * 宿主用的是打开时捕获的纯文本标题。
     */
    const disposeTitle = slots.inject('sidebar.right.pane.tab.title', () => slots.register({
      name: 'sidebar.right.pane.tab.title',
      key: TAB_ID,
    }, GitTabTitle));

    return () => {
      disposeTitle();
      disposeBody();
      disposeType();
    };
  }, 'dsh-git: sidebar tab type + body + title');

  registerToastSeat(ctx);
}

/**
 * 把**通知面**注册进宿主的 **`shell.overlay`** 席位(2026-10,用户裁决「右下角气泡」)。
 *
 * ## 席位出处(逐字核对过,不是推断)
 *
 * · **声明**:`references/deepseek-harness/packages/client/ui-layout/src/client/index.ts:95-103`
 *   —— `'shell.overlay': { kind: 'list'; scope: 'root' }`,文档原文点名了这个用途:
 *   「Frame-wide floating layer, above every column and outside their scroll containers.
 *   Deliberately generic and unowned by any feature: **a badge, a toast stack or a status
 *   pill all belong here**, and entries order among themselves. The layer itself is
 *   **click-through** — entries opt back into pointer events — so an occupant never blocks
 *   the app underneath. This is the additive seat for a frame-wide surface of your own:
 *   **a fresh `id` is added beside the shipped entries** instead of replacing them.」
 * · **宿主自己怎么用**(注册形状沿用的就是它们):
 *   `packages/client/ui-chat/src/client/apply.ts:268-279`(quota notice)、
 *   `packages/client/ui-schedule/src/client/index.ts:112-115`(DeleteToast)、
 *   `packages/client/ui-workspace/src/client/index.ts:297-309`(RowActionToast)、
 *   `packages/client/ui-plugin-manager/src/client/index.ts:103-109`(refresh toast)。
 *   形状都是 `ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name, id, … }, C))`,
 *   **每个功能一个自己的 id**(所以这里用 `dsh-git.toasts`,additive,不覆盖任何既有条目)。
 * · **帧这一侧**:`ui-layout/src/client/AppFrame.tsx:249,292-294` 渲染
 *   `renderSlot('shell.overlay', {})` 到 `.overlayLayer`
 *   (`AppFrame.module.css:281-290`:`position:absolute;inset:0;z-index:20;pointer-events:none`,
 *   `> * { pointer-events:auto }`)。
 *
 * ## 为什么 `inject` 而不是别的写法
 *
 * 与下面设置卡片同一条规矩:席位**没被声明**时 `slots.inject` 是**静默 no-op**,
 * 所以这里有一个有界(3s)一次性诊断,把「席位没落地」说清楚 —— 否则表现是
 * 「一条通知都不出现」,而没有任何一处会报错。
 *
 * ## 几何:席位不负责位置(必须知道)
 *
 * 宿主原语把横幅 portal 到 `document.body`(`ui-primitives/src/Toast.tsx:74-76`),
 * 所以席位那一格**不是**它的 DOM 祖先 —— 位置与夹宽由 `bits.tsx` 的
 * `useToastBandClamp`(实测右栏矩形 → 四个 CSS 变量)加 `styles.ts` 那条带门控的规则
 * 完成。这里注册的 `FrameToasts` 自己**不渲染任何本地 DOM**。
 * @param ctx - 浏览器插件上下文。
 */
function registerToastSeat(ctx: ClientCtx): void {
  ctx.effect(() => {
    const slots = ctx.slots;
    if (slots === undefined || typeof slots.register !== 'function') {
      console.warn('[dsh-git] slots 不可用,shell.overlay 通知席位未注册(通知不会出现)');
      return;
    }
    let landed = false;
    /*
     * `label` / `order` 都不传:`shell.overlay` 的 owner 不投影任何文字
     * (`slot-catalog.ts` 的该席位 `ownerProps: []`),而条目之间的顺序对「一个自己定位的
     * 浮层」没有意义 —— 宿主的四个先例也都只传 `name` / `id`(有的再传 `locale` / `inject`)。
     *
     * 外面那层 `ErrorBoundary` 是从 `workbench.tsx` 搬过来的(`label="提示条"`):通知面渲染
     * 抛错时**不能**带走宿主那一层浮层树(那是整个帧),而回退是可见的、指名道姓的 ——
     * 不静默渲染成空盒子。
     */
    const dispose = slots.inject('shell.overlay', () => {
      landed = true;
      return slots.register({
        name: 'shell.overlay',
        id: 'dsh-git.toasts',
      }, () => createElement(
        ErrorBoundary,
        { label: '提示条' },
        createElement(FrameToasts, null),
      ));
    });
    const timer = setTimeout(() => {
      if (landed) {
        return;
      }
      console.warn('[dsh-git] shell.overlay 席位没被声明 ⇒ 通知不会出现(宿主 ui-layout 未激活?)');
    }, 3000);
    /*
     * 设置卡片那棵树用的是**全局 store**(`storeFor('')`,与卡片同一个实例),它也可能报
     * 通知 ⇒ 一并登记成帧级通知来源。
     */
    const unregisterSource = registerToastSource(storeFor(''));
    return () => {
      clearTimeout(timer);
      unregisterSource();
      dispose();
    };
  }, 'dsh-git: shell.overlay toast seat');
}

/**
 * 有界一次性诊断:设置卡片这条链路上**每一步都可能静默不触发**
 * (`ctx.inject` 缺席、`configForms` 缺席、`whileServed` 不触发、席位没被声明),
 * 而「静默 no-op」是最坏的失败形态。这里把「哪一步掉了」留成一条只打一次的
 * `console.info`,给下一个人(以及下次的探针)一个可读的现场。
 */
const settingsCardNotes = new Set<string>();

function noteSettingsCardOnce(key: string, message: string): void {
  if (settingsCardNotes.has(key)) {
    return;
  }
  settingsCardNotes.add(key);
  console.info(`[dsh-git] 宿主设置卡片(${key}):${message}`);
}

/**
 * 把 dsh-git 的设置页面挂进**宿主自己的两个插件界面**。
 *
 * 这是 DSH 插件设置机制的 client 半(host 半是 `src/index.ts` 的 `export const Config`)。
 * 形状对齐 `packages/client/ui-settings-agent-loop/src/client/index.ts:40-49`:
 * `ctx.configForms.get(ns)` 拿表单 → `whileServed([ns], …)` 只看宿主真的服务该命名空间时
 * 才注册 → `ctx.slots.inject(<seat>, () => ctx.slots.register(…))` 注册页面。
 *
 * ## 2026-10 修正:**席位选错了,卡片进不了设置弹窗**(用户报的「设置里没有 dsh-git 卡片」)
 *
 * 上一轮只注册了 `plugins.item`,并在 `docs/plugin-settings.md` §3.5 断言
 * 「注册 `plugins.item` ⇒ 设置 ▸ 插件里自动出现一张卡片」。**那条断言是错的**:
 *
 * | 席位 | 谁声明 / 谁渲染 | 出现在哪 |
 * |---|---|---|
 * | `plugins.item` | `ui-plugin-manager`(`slot-contract.ts:91-96` + `PluginManagerPage.tsx:1399`) | **侧栏的「插件」页** —— 它是主列面板(`PANEL_ID='plugins'`),**不在设置弹窗里** |
 * | `settings.plugins.tab` | `ui-settings-plugins`(`src/client/index.ts:76-84`) | **设置 ▸ 内置插件**里的一个页签(`PluginsSettingsSection.tsx:56-70` 渲染) |
 *
 * 设置弹窗里那一节(`settings.section` id `plugins`,「内置插件」)只读
 * `settings.plugins.tab`(`ui-settings-plugins/src/client/index.ts:46-70`),所以
 * `plugins.item` 里注册的东西**在任何情况下都不会出现在设置里** —— 不是「某一步掉了」,
 * 而是**注册到了另一个界面**。现在两个席位都注册(它们本来就是两个不同界面),
 * 于是设置 ▸ 内置插件里也会出现一张 dsh-git 页。
 *
 * 完整证据链与「宿主还不能表达什么」见 `docs/host-settings-card.md`。
 *
 * ## 为什么是 `ctx.inject` 而不是把 `configForms` 写进 `inject` 数组(与 §7.3 第 8 步不同)
 *
 * `docs/plugin-settings.md` §7.3 第 8 步写的是「`inject` 追加 `'configForms'`」,
 * 而同一份文档 §8 第一行把「client 侧 `configForms` 此刻是否已提供」列为**未确定**
 * —— 它的 settle 测量(client Inspect `Service.listService`)一直超时
 * (文档 §3.4 也记着同一次超时;2026-10 已查明原因:这个 bundle **根本没有** client 侧的
 * Inspect provider,见 `docs/host-settings-card.md` §3)。把一个**未实测**的服务写进硬
 * `inject`,代价是这个 profile 里**整个插件**(含右侧栏 tab)一起不激活;那与本文档前面
 * `uiWorkspace` 那段注释立下的规矩直接冲突(「硬依赖会让本插件在没有该服务的 profile
 * 里整个不激活」)。所以:走 cordis 的**可选服务注入** `ctx.inject([...], cb)`
 * —— 它同样是「Cordis 服务注入」而不是模块 import,拿到服务才装卡片,拿不到只是少一张卡片。
 *
 * @param ctx - 浏览器插件上下文。
 */
function registerHostSettingsCard(ctx: ClientCtx): void {
  if (typeof ctx.inject !== 'function') {
    noteSettingsCardOnce('no-inject', 'ctx.inject 不可用 ⇒ 卡片链路整条不执行');
    return;
  }
  try {
    ctx.inject?.(['configForms'], (injected) => {
      const configForms = injected.get('configForms') as IConfigFormsLike | undefined;
      if (configForms === undefined || typeof configForms.get !== 'function'
        || typeof configForms.whileServed !== 'function') {
        noteSettingsCardOnce('no-configForms', 'configForms 未提供或形状不对 ⇒ 卡片链路整条不执行');
        return undefined;
      }
      ctx.effect(() => configForms.whileServed([DSH_GIT_NS], (served) => {
        /*
         * ⭐ 这一条是**给下一个人的现场**:`whileServed` 只保证「其中某一个」被服务,
         * 而我们只有一个候选。宿主实际服务哪些命名空间(以及我们的 `dsh-git` 在不在
         * 里面)只在这里能看见 —— 曾经「卡片不出现」的判断错在**席位选错**而不是这一步
         * (见 `docs/host-settings-card.md` §2),所以这条轨迹必须留下。
         */
        noteSettingsCardOnce(
          'whileServed-fired',
          `whileServed 已触发;宿主当前服务的命名空间 = [${[...served].join(', ')}],`
          + `其中包含 ${DSH_GIT_NS} = ${String(served.has(DSH_GIT_NS))}`,
        );
        if (!served.has(DSH_GIT_NS)) {
          return () => { /* 没有服务:不注册,也不留痕迹 */ };
        }
        const slots = ctx.slots;
        if (slots === undefined || typeof slots.inject !== 'function') {
          noteSettingsCardOnce('no-slots', 'ctx.slots 不可用 ⇒ 卡片无法注册');
          return () => { /* 没有席位系统:同上 */ };
        }
        /*
         * ⭐ **三个页面(账号 / 仓库 / 无障碍)现在也在这张卡片里。**
         *
         * 它们要的那几样东西全部来自**这里**能拿到的对象,没有编造的值:
         *  - `store`:`storeFor('')` 就是本插件的**全局** store(与
         *    `host-settings.ts` 那条 `bindAutoRefreshFromHost` 的消费方同一颗)。
         *    ⚠️ 为什么不是「当前 session 那一颗」:`settings.plugins.tab` 这个席位
         *    **不带 sessionId**(`sidebar.right.pane.tab` 才有,见下面 165-172 行),
         *    而 `storeFor()` 是按 session 记忆化的(`:72-82`)⇒ 卡片只能用全局那一个。
         *    这是本轮的已知边界,报告里如实登记。
         *  - `auth` / `snap`:从**同一颗 store** 的快照里读,所以「仓库」页列的就是
         *    侧栏那一份清单(全局 store 时两侧一致);
         *  - `onPreferencesChanged`:`prefs-bus.ts` 的计数器(卡片与 `WorkbenchApp`
         *    是两棵树,拿不到后者的 revision state)。
         */
        const globalStore = storeFor('');
        const pages: IDshGitCardPagesFace = {
          snap: globalStore.snapshot(),
          auth: cardAuthOf(globalStore.snapshot().auth),
          store: globalStore,
          /*
           * ⭐ **live**:卡片订阅的**真 store**。
           *
           * 没有这一条时,上面那两行(`snap` / `auth`)是**注册那一瞬间**的快照,而
           * 注册发生在 `apply()` 里(`WorkbenchApp` 还没挂载)⇒ 它们是空的、而且永不更新:
           * 仓库页永远「还没有仓库」、账号页永远未登录、添加/切换/移除点了界面不动。
           * 实测读数(改前)见 `docs/probes/host-settings-card-live-probe.mjs`。
           */
          live: globalStore,
        };
        /*
         * ⭐ **装载**:`settings.plugins.tab` 不带 sessionId,所以卡片用的是
         * `storeFor('')` 这颗**全局** store,而它**没有任何别的启动点**
         * (右侧栏那颗是按 session 键的另一颗,由 `workbench.tsx:163` 启动)。
         * 不装载 ⇒ 上面那个 live 订阅永远等不到数据。
         */
        void bootstrapCardStore(globalStore);
        const card = new DshGitSettingsCardController(
          configForms.get<IDshGitSettings>(DSH_GIT_NS),
          pages,
          bumpPreferencesRevision,
        );
        // 只读投影:同一个命名空间的另一个消费方(`pulls-view.tsx` 的自动刷新定时器)
        // 从这里拿值。绑定与卡片同生共死 —— 宿主停止服务该命名空间时,
        // 退订会把周期复位成 0(关闭),旧周期不会带着继续跑。
        const unbindAutoRefresh = bindAutoRefreshFromHost(configForms.get<IHostSettingsSlice>(DSH_GIT_NS));
        /*
         * ⭐ **两个席位,两个界面**,它们由**不同的宿主包**渲染,一个都不能少:
         *
         * | 席位 | 谁声明 / 谁渲染 | 出现在哪 |
         * |---|---|---|
         * | `plugins.item` | `ui-plugin-manager`(`slot-contract.ts:91-96`;`PluginManagerPage.tsx:1399`) | **侧栏的「插件」页**(`PANEL_ID='plugins'`,主列面板) |
         * | `settings.plugins.tab` | `ui-settings-plugins`(`src/client/index.ts:76-84`) | **设置 ▸ 内置插件**里的一个页签(`PluginsSettingsSection.tsx:56-70`) |
         *
         * 2026-10 用户报「设置里没有 dsh-git 卡片」的**根因**就是这里:原先只注册了
         * `plugins.item`,而那个席位**只在侧栏的「插件」页渲染**,永远进不了设置弹窗。
         * 证据与判据见 `docs/host-settings-card.md` §2。两个席位都注册,是因为它们
         * 本来就是两个不同的界面(不是重复注册)。
         */
        const seats = { pluginsItem: false, pluginsTab: false };
        const disposeEntry = slots.inject('plugins.item', () => {
          seats.pluginsItem = true;
          return slots.register({
            name: 'plugins.item',
            id: 'dsh-git',
            // 官方的几个是 shell 10 / agent-loop 20 / subagent 30 / web-search 40;
            // 60 让第三方插件稳定排在它们之后。
            order: 60,
            label: () => 'dsh-git',
            inject: () => card.inject(),
          }, DshGitCard);
        });
        const disposeTab = slots.inject('settings.plugins.tab', () => {
          seats.pluginsTab = true;
          return slots.register({
            name: 'settings.plugins.tab',
            id: 'dsh-git',
            order: 60,
            label: () => 'dsh-git',
            inject: () => card.inject(),
          }, DshGitCard);
        });
        /*
         * 席位**没被声明**时 `slots.inject` 什么都不做(不抛、不报),这正是
         * 「静默 no-op」。有界(3s)查一次「两个席位是不是都没落地」,只打一次。
         * 计时器与卡片同生共死,不会在插件卸载后还活着。
         */
        const timer = setTimeout(() => {
          if (seats.pluginsItem || seats.pluginsTab) {
            return;
          }
          noteSettingsCardOnce(
            'no-seat',
            'plugins.item 与 settings.plugins.tab 都没被声明(ui-plugin-manager / ui-settings-plugins 未激活?)'
            + ' ⇒ 卡片注册为静默 no-op',
          );
        }, 3000);
        return () => {
          clearTimeout(timer);
          disposeTab();
          disposeEntry();
          unbindAutoRefresh();
          card.dispose();
        };
      }), 'dsh-git: host settings card');
      return undefined;
    });
  } catch (error) {
    // 卡片是附加能力:接不上必须只影响卡片,不能影响右侧栏 tab。
    console.warn(`[dsh-git] 宿主设置卡片未注册(configForms 接不上):${String(error)}`);
  }
}

/**
 * 右侧栏 tab 图标:与包根 icon.svg 逐字同源的品牌标记
 * ——「干线 + 分支曲线 + 提交节点」的 git 分支记号。
 *
 * 细节:干线两端是实心提交节点(粗 2 的笔画 + r2.35 的圆头),
 * 分支末端是一个空心环(远端/未落地的提交),分支笔画在环前收住,环心留空。
 * 改这里必须同步改 icon.svg;颜色继承 currentColor,
 * 亮色主题落到品牌蓝,暗色主题随侧栏文字色自动变亮。
 */
function gitIcon(size: number): ReactElement {
  return createElement('svg', {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    'aria-hidden': 'true',
  },
    createElement('path', { d: 'M7.5 5.3v13.4' }),
    createElement('path', { d: 'M7.5 11.8c0 2.2 1.6 3.8 3.8 3.8h1.5' }),
    createElement('circle', { cx: 7.5, cy: 5, r: 2.35, fill: 'currentColor', stroke: 'none' }),
    createElement('circle', { cx: 7.5, cy: 19, r: 2.35, fill: 'currentColor', stroke: 'none' }),
    createElement('circle', { cx: 15.5, cy: 15.6, r: 2.05, fill: 'none', strokeWidth: 1.7 }),
  );
}

/**
 * 侧栏 tab chip 的标题 = **我们的图标 + 当前名字**。
 *
 * 形状照官方 `dsh-client-ui-sidebar-files` 的 `FilesTitle`:
 * `Fragment[图标, 文字]`,而**间距与垂直对齐由宿主的 chip 容器负责**
 * (`@deepseek-ai/dsh-client-ui-sidebar-right` 的 README §1:「停靠 tab 和浮窗标题中的
 * 图标间距与垂直对齐由 dockkit 控制」)。所以这里**不带自己的 margin** ——
 * 就算想带也不该带:我们的样式全部 scope 在 `.gw-*` 作用域里,进不到 chip 里去。
 *
 * 唯一的例外是颜色,用**内联**的宿主令牌:宿主自己给 chip 图标的是
 * `.bpGe8G_titleIcon { color: var(--dsw-alias-label-tertiary); flex: none }`,
 * 那是 CSS Module 的哈希类名,插件够不到 —— 用同一个令牌内联,是照它的角色取值,
 * 不是为了绕开作用域。
 *
 * ## ⚠️ 为什么**不**回显 `tab.title`(2026-10 实测踩到)
 *
 * 宿主把 title **在 tab 打开时捕获**,连布局一起写进 `localStorage`
 * (`${sidebarPersistence}.${sessionId}` 里的 `minted` 记录)。于是改名之后:重启、
 * 刷新都不会重算那条记录,chip 一直显示旧名 —— 用户看到的就是「我重启了,还是
 * `dsh-git`」。而契约里写着「**会变的标题只来自可选的标题席位**」,所以这一席就是
 * 权威:直接渲染 {@link TAB_TITLE},旧记录里捕获的文字不再参与。
 * (想走捕获值那条路也可以,代价是**每个用户都得把那个 tab 关掉再开一次**。)
 *
 * 因此本组件**不依赖任何 props**:宿主给不给 `useTabInfo` 都渲染同一个名字。
 * @returns 图标与标题文字两个兄弟节点。
 */
function GitTabTitle(): unknown {
  return createElement(Fragment, null,
    createElement('span', {
      style: { color: 'var(--dsw-alias-label-tertiary)', display: 'flex', flex: 'none' },
    }, gitIcon(16)),
    TAB_TITLE,
  );
}
