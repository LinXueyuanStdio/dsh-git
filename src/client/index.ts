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
import { DICT_EN, DICT_ZH, LOCALE_NS, type Translate } from './i18n.ts';
import type { ClientCtx, SidebarRightTabsLike } from './types.ts';
import { ensureStyles } from './styles.ts';
import { ensureBaseStyles } from './styles-base.ts';
import { ensureDesktopDiffStyles } from './desktop-diff-styles.ts';
import { WorkbenchApp } from './workbench.tsx';
import { FrameToasts, registerToastSource } from './bits.tsx';
import { ErrorBoundary } from './error-boundary.tsx';
import { GitStore } from './store.ts';
import {
  DSH_GIT_NS, DshGitSettingsCardController,
  type IConfigFormsLike, type IDshGitSettings,
} from './host-settings-card.ts';
import { bumpPreferencesRevision } from './prefs-bus.ts';
import { bindAutoRefreshFromHost, type IHostSettingsSlice } from './host-settings.ts';
import { DshGitSettingsPage } from './settings-page.tsx';
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
 * 本插件在 profile 里的 **bundle 包名** —— `plugins.bundle.config` 席位的 `key`。
 *
 * ⚠️ **必须与 `package.json` 的 `name` 逐字相同**,而且它**不是**另外两个同名概念:
 *
 * | 名字 | 值 | 谁在用 |
 * |---|---|---|
 * | 包名(**本常量**) | `@linxueyuan/dsh-git` | profile 的 `dsh.profile.bundles`;`plugins.bundle.config` 的 key |
 * | 配置命名空间 / profile 行 id | `dsh-git`({@link DSH_GIT_NS}) | `ctx.configForms.get(...)` / `whileServed([...])` |
 * | 右侧栏 tab id | `dsh-git`({@link TAB_ID}) | sidebar 布局记录 |
 *
 * 判据(2026-10 实测):席位由 `PluginManagerPage.tsx:735` 的
 * `renderSlot('plugins.bundle.config', …, { entryKey: pkg.name })` 派发,而是否渲染由
 * `configured={ledger.bundles.has(openPkg.name)}` 决定 —— `ledger.bundles` 就是本席位的
 * **key 集合**(`config-ledger.ts:40` 的 `SLOTS` + `:66` 的 `keysOf(...)`)。
 * 所以写成 `'dsh-git'` 的后果是 **`section[data-plugin-config]` 整个节点不出现,且不报错**
 * —— 正是 `docs/host-settings-card.md` §2 记的那类静默形态。
 *
 * `scripts/verify-plugin.mjs` 有一条反向判据钉住「本常量 === `package.json` 的 `name`」。
 */
export const DSH_GIT_BUNDLE_NAME = '@linxueyuan/dsh-git';

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
 * `src/registry.ts`:数组形式 = 必需,对象形式的值是拦截配置)—— 声明了就**必须等到位**,
 * 而**等待本身会挡住整条客户端启动链**(2026-10 实测:整个 Web UI 只剩
 * "Failed to load plugins / 1 entry did not activate / @linxueyuan/dsh-git: pending")。
 *
 * 但「当可选服务」**不等于**「用 `ctx.get()` 采样一次」:右侧栏的服务是真的会来的,
 * 只是**比我们的 `apply` 晚**(2026-10-07 实测:同一 tick 里 `ctx.get()` 拿到 `undefined`,
 * 而 `ctx.inject(['sidebarRightTabs'], …)` 的回调随后被调用、拿到的是 `object` + `function`)。
 * 采样一次 ⇒ 在**所有**环境里都放弃注册,只是不再报错 —— 那是静默失败,不是兼容。
 *
 * 所以它走**动态 `ctx.inject`**:等到位再注册、服务不来就什么都不做,
 * 两种语义都要(见 `apply` 里那段注册代码)。
 *
 * ## `locale` 为什么**写进**数组(dsh-context 的形状)
 *
 * 与 `uiWorkspace` / `theme` 那几条可选服务不同:`dsh-client-locale` 是**web 组合的
 * 常驻行**(`references/deepseek-harness/packages/bundle/web-app/cordis.patch.yml:253`
 * 一条 `name: '@deepseek-ai/dsh-client-locale'`),不是「某些 profile 才装」的能力。
 * 参考实现 `references/dsh-context/src/client/index.ts` 也硬注入它
 * (`inject: ['slots', 'locale']`)—— 字典注册与 `t` 的绑定点都在 `apply` 里,
 * 拿不到服务就没有语言可言,那时候「整个插件不激活」比「界面全是中文」更诚实。
 */
export const inject = ['slots', 'locale'];

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

  /*
   * ---------- 语言:注册本插件的字典,并绑一个 `t` ----------
   *
   * 形状逐字照 `references/dsh-context/src/client/index.ts:57-62`:
   * `ctx.effect(() => ctx.locale.register(NS, { zh, en }))` + `ctx.locale.bind(NS)`。
   * `bind()` 返回的函数**在调用时**读当前语言(`ui-slots/src/renderer.ts:24`),
   * 所以同一个 `t` 引用在语言切换后照样给出新文案 —— 不需要重新注册席位。
   *
   * ⚠️ 只覆盖**我们自己写的**文案(`./i18nZh.ts` 的文件头写了边界):
   * `src/core/desktop/**` 那棵 GitHub Desktop 镜像树不在这条链路上。
   */
  const t: Translate = ctx.locale?.bind(LOCALE_NS)
    ?? ((key: string) => key);
  try {
    ctx.effect(() => ctx.locale?.register(LOCALE_NS, { zh: DICT_ZH, en: DICT_EN }), 'dsh-git: dictionaries');
  } catch (error) {
    console.warn(`[dsh-git] 语言字典注册失败(界面回落到键名):${String(error)}`);
  }

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

  registerHostSettingsCard(ctx, t);

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

  /*
   * tab 类型 + 正文 + 标题,三件都注册在**等到 `sidebarRightTabs` 之后**的子 fiber 里。
   *
   * 三种写法只有这一种同时对:
   *  · 静态 `inject: ['sidebarRightTabs']` —— 服务不来就**永远 pending**,而 pending
   *    会挡住整条客户端启动链(整个 Web UI 一起不可用)。**太硬**。
   *  · `ctx.get('sidebarRightTabs')` 采样一次 —— 服务**晚到**就永远放弃注册,
   *    界面上表现为「右侧栏在、别人的 tab 都在、就是没有 git」,而且不报错。**太早**。
   *  · `ctx.inject([...], cb)` —— 子 fiber 等服务:到了注册、不来就什么都不做,
   *    且**不阻塞**本插件自身的激活。**正好**。
   *
   * 这条也是宿主自己的写法:`dsh-github-workbench`、`dsh-context`、`dsh-remote`、
   * `dsh-better-sidebar` 全都用 `ctx.inject(['sidebarRightTabs'], …)` 接这一席。
   *
   * 子 fiber 的回调返回值即 disposer:cordis 在服务消失 / 插件卸载时按序清理,
   * 所以注册出来的 tab 类型与两个席位都不会留孤儿。
   */
  ctx.inject?.(['sidebarRightTabs'], function dshGitSidebarTab(injected) {
    const tabs = injected.get('sidebarRightTabs') as SidebarRightTabsLike | undefined;
    if (tabs === undefined || typeof tabs.register !== 'function') {
      console.warn('[dsh-git] sidebarRightTabs 到了但形状不符(没有 register),跳过 tab 注册;插件其余能力照常');
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
  });

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
     * 帧级通知来源。挂的是**全局 store**(`storeFor('')`)。
     *
     * ⚠️ 2026-10-13:它原先的驱动者是设置卡片那一棵树(卡片有账号页 / 仓库页,会跑动作、
     * 会报通知);卡片改成宿主风格的设置页之后**不再碰 store** ⇒ 这个来源今天没有生产者。
     * 保留它是因为「谁往全局 store 写通知谁就能上帧」这条**通道**本身与设置页无关
     * (侧栏那条走的是按 session 键的另一颗 store)。**没有顺手删**:删它要连带决定
     * 全局那颗 store 是否还需要存在,那是另一条泳道的边界,已登记在
     * `docs/host-settings-card.md` §14.4。
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
 * 把 dsh-git 的设置页面挂进**宿主自己的插件页**(那次二次迁移见下)。
 *
 * 这是 DSH 插件设置机制的 client 半(host 半是 `src/index.ts` 的 `export const Config`)。
 * 形状对齐 `packages/client/ui-settings-agent-loop/src/client/index.ts:40-49`,并逐字参考
 * `references/dsh-context/src/client/index.ts:141-158`:
 * `ctx.configForms.get(ns)` 拿表单 → `whileServed([ns], …)` 只看宿主真的服务该命名空间时
 * 才注册 → `ctx.slots.inject(<seat>, () => ctx.slots.register(…))` 注册页面。
 *
 * ## 2026-10 第 1 次修正:席位选错,卡片进不了设置弹窗
 *
 * 当时只注册了 `plugins.item`,并在 `docs/plugin-settings.md` §3.5 断言
 * 「注册 `plugins.item` ⇒ 设置 ▸ 插件里自动出现一张卡片」。**那条断言是错的**:
 * `plugins.item` 由 `ui-plugin-manager` 渲染在**侧栏的「插件」页**(主列面板
 * `PANEL_ID='plugins'`),而设置 ▸ 内置插件读的是另一个席位 `settings.plugins.tab`。
 * 当时的处置是**两个席位都注册**。
 *
 * ## 2026-10 第 2 次修正(本次):两个旧席位都退役,改挂 `plugins.bundle.config`
 *
 * 用户指令:「现在 dsh 插件使用的是 config form。但是这个其实不太建议使用。我们有新的位置,
 * 参考 `references/dsh-context` 的插件设置的位置」。参考实现用的是官方为「**bundle 自己的配置**」
 * 留的 keyed 席位 **`plugins.bundle.config`**(`ui-plugin-manager/src/client/slot-contract.ts:103-107`):
 *
 * | 席位 | 谁声明 / 谁渲染 | 出现在哪 | 现在 |
 * |---|---|---|---|
 * | `plugins.item` | `ui-plugin-manager`(`slot-contract.ts:92-101`;`PluginManagerPage.tsx:1461`) | **侧栏「插件」页**的**官方**组(契约逐字写它被 official settings pages *occupied*) | **退役** |
 * | `settings.plugins.tab` | `ui-settings-plugins`(`src/client/index.ts:76-83`;`PluginsSettingsSection.tsx:58,111`) | **设置 ▸ 内置插件**的一个页签(该分区的定位是「内置插件」清单) | **退役** |
 * | **`plugins.bundle.config`** | `ui-plugin-manager`(`slot-contract.ts:103-107`;`PluginManagerPage.tsx:735`) | 该 bundle 在**「插件」页**的**详情页**上,描述与行列表之间 | **现在的位置** |
 *
 * ⚠️ **本席位的 key 是包名({@link DSH_GIT_BUNDLE_NAME}),不是命名空间**:见那个常量的注释。
 * 两个旧席位都撤掉而不是并存 —— 同一个配置面出现两个入口比少一个入口更坏。
 * 完整方案与验收判据见 `docs/plugin-settings-seat-migration-plan.md`。
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
function registerHostSettingsCard(ctx: ClientCtx, t: Translate): void {
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
         * ⚠️ 2026-10-13 起这里**不再**构造仓库清单 / 登录态那份数据面:
         * 设置页已改成 DSH 宿主风格的行列表(`./settings-page.tsx`),只呈现插件自己的偏好;
         * 账号与 Git 身份仍在齿轮打开的偏好弹窗里,而弹窗自己拿 store。
         * ⇒ `storeFor('')` / `bootstrapCardStore` / `pages` 三样一起从这条链路上消失。
         */
        const card = new DshGitSettingsCardController(
          configForms.get<IDshGitSettings>(DSH_GIT_NS),
          bumpPreferencesRevision,
          t,
        );
        // 只读投影:同一个命名空间的另一个消费方(`pulls-view.tsx` 的自动刷新定时器)
        // 从这里拿值。绑定与卡片同生共死 —— 宿主停止服务该命名空间时,
        // 退订会把周期复位成 0(关闭),旧周期不会带着继续跑。
        const unbindAutoRefresh = bindAutoRefreshFromHost(configForms.get<IHostSettingsSlice>(DSH_GIT_NS));
        /*
         * ⭐ **一个席位**:bundle 自己的配置官方席位 `plugins.bundle.config`
         * (`ui-plugin-manager/src/client/slot-contract.ts:103-107`)。
         *
         * 它渲染在**「插件」页 ▸ 该 bundle 的详情页**上(描述与行列表之间,`PluginManagerPage.tsx:735`),
         * 由 `configured={ledger.bundles.has(openPkg.name)}` 决定整段是否存在 ——
         * 所以 **key 必须是包名**(`ledger.bundles` 是本席位 key 的集合),见
         * {@link DSH_GIT_BUNDLE_NAME} 的注释。写错 = 整段静默消失。
         *
         * 两个旧席位(`plugins.item` / `settings.plugins.tab`)已退役:前者是**官方设置页专用席**
         * (契约逐字说它被 official settings pages *occupied*,且第三方卡片会在「插件」页的
         * **官方**组里露出来);后者是「设置 ▸ 内置插件」的**清单**分区。迁移理由与判据见
         * `docs/plugin-settings-seat-migration-plan.md`。
         *
         * **传 `locale`**:本卡片的文案全部走本插件的字典(`./i18nZh.ts` / `./i18nEn.ts`),
         * 席位声明命名空间后,宿主的语言切换会立刻反映到这一页(dsh-context 同形)。
         * **不传 `label` / `order` / `id`**:那是 list 席位的形状,keyed 席位只要 `key`。
         */
        let seatRegistered = false;
        const disposeConfig = slots.inject('plugins.bundle.config', () => {
          seatRegistered = true;
          return slots.register({
            name: 'plugins.bundle.config',
            key: DSH_GIT_BUNDLE_NAME,
            // 声明本席位用哪个命名空间的文案(宿主渲染层据此注入 `t` 席位);
            // 卡片自己用的是 `apply` 里 bind 出来的那个 `t`(同一个命名空间,活值)。
            locale: LOCALE_NS,
            inject: () => card.inject(),
          }, DshGitSettingsPage);
        });
        /*
         * 席位**没被声明**时 `slots.inject` 什么都不做(不抛、不报),这正是
         * 「静默 no-op」。有界(3s)查一次席位是不是没落地,只打一次。
         * 计时器与卡片同生共死,不会在插件卸载后还活着。
         */
        const timer = setTimeout(() => {
          if (seatRegistered) {
            return;
          }
          noteSettingsCardOnce(
            'no-seat',
            'plugins.bundle.config 没有被声明(ui-plugin-manager 未激活?宿主版本过旧?)'
            + ' ⇒ 卡片注册为静默 no-op',
          );
        }, 3000);
        return () => {
          clearTimeout(timer);
          disposeConfig();
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
