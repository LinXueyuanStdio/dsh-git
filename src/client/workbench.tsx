/**
 * dsh-git 主应用:顶栏(仓库/同步/分支/设置)+ 六个页签 + 视图路由 + 弹层与提示。
 * 根节点 .gw-root 撑满右侧栏的 tab 正文;本地页签走 host /dsh-git/* 路由,
 * 远端页签沿用从 workbench 移植来的 GitHub REST 视图。
 * @module dsh-git/client/workbench
 */

import { createElement, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
/*
 * `import * as ReactDOM` 而不是 `import { createPortal }` —— 与镜像
 * `core/desktop/ui/lib/tooltip.tsx:2` 逐字同形。`react-dom` 是宿主 loader 提供的
 * **平台种子模块**(`scripts/build.mjs:67` 的 `clientExternal` 里它是 external),
 * 命名导入在产物里要经过宿主那一侧的 CJS→ESM 互操作,而 tooltip 那条路径
 * (同样打 portal)已经在产物里跑通了 ⇒ 照它写,不引入第二套互操作假设。
 */
import * as ReactDOM from 'react-dom';
import { Icon } from './icons.ts';
import { GitStore, TAB_ORDER, type TabId } from './store.ts';
import { WorkbenchToolbar, menuAnchorElement } from './toolbar.tsx';
import { ChangesView } from './changes-view.tsx';
import { HistoryView } from './history-view.tsx';
import { CodeView } from './code-view.tsx';
import { LocalCodeView } from './local-code-view.tsx';
import { IssuesView } from './issues-view.tsx';
import { PullsView } from './pulls-view.tsx';
import { ActionsView } from './actions-view.tsx';
import { PreferencesDialog } from './preferences-dialog.tsx';
import type { PreferencesTabId } from './preferences-dialog.tsx';
import { hostSettingsShortcutKeys, openHostSettings } from './host-settings-open.ts';
/*
 * 「更多」菜单改用的**上游原语**:`src/core/desktop/ui/lib/popover.tsx`(GitHub Desktop
 * `ui/lib/popover.tsx` 的与上游一致,`verify-mirror` 盯着它 —— 我们**只能调用**,不能改)。
 * 它自带 floating-ui 的 `computePosition` + `offset/shift/flip/size`。
 */
import { Popover, PopoverAnchorPosition } from '../core/desktop/ui/lib/popover.tsx';
import { ensurePrefAdaptations } from './pref-adapt.ts';
import { useUnderlineLinks } from './prefs.ts';
/*
 * **运行期偏好总线**(`prefs-bus.ts`)—— 宿主设置卡片与 `WorkbenchApp` 是**两棵
 * 互不相邻的树**(卡片 portal 到宿主自己的设置弹窗里),所以「字号」与「显示类偏好变了」
 * 这两件事不能再用 prop 传,必须经由一份两边都能看见的真源。
 *
 * 改前这里持有的是**自己的一份 `useState`**(`fontScale` / `prefsRevision`,旧 `:146`
 * 与 `:157`)⇒ 卡片里改字号**侧栏不当场变**(要刷新页面),而
 * `bumpPreferencesRevision` 全仓**零订阅者** ⇒ 卡片写的日期/时间/数字格式要刷新才生效。
 * 两处都不是「值没写进去」,而是「写进去没人听」—— 所以修法是**订阅**,不是再复制一份 state。
 */
import {
  bumpPreferencesRevision,
  fontScaleStore,
  getFontScale,
  getPreferencesRevision,
  setFontScale,
  subscribePreferencesRevision,
} from './prefs-bus.ts';
import { PopupType } from '../core/desktop/models/popup.ts';
import { CloneDialog } from './clone-dialog.tsx';
import { ConfirmDialog, Empty, PushFailureDialog, registerToastSource } from './bits.tsx';
import { ErrorBoundary } from './error-boundary.tsx';
import { UICtx, type ConfirmOptions } from './gh.ts';
import * as ghApi from './gh-api.ts';
import { parseRepoInput } from '../core/lib.ts';
import type { RepoEntry } from '../core/types.ts';

export interface WorkbenchAppProps {
  store: GitStore;
  sessionId: string;
}

/**
 * 注入 Preferences 的**适配层样式表**(隐藏我们产品无法兑现的控件 + 「Underline links」
 * 那条规则,逐条理由见 `src/client/pref-adapt.ts`)。
 *
 * 为什么要**在模块加载时**调,而不是 `apply(ctx)` 里跟 `ensureStyles()` 一起:
 * `src/client/index.ts`(调用 `apply` 的那个文件)**不在本轮所有权内**,而这一层必须
 * 早于第一次渲染(否则被删掉的控件会先画一帧)。`ensure*` 幂等,模块级调用是确定性的:
 * workbench 由 index.ts 静态 import,所以它在第一次渲染之前一定跑过。
 * 等所有权合并时,这一行应当搬进 `apply(ctx)` 的 `ensureBaseStyles()/ensureStyles()/
 * ensureDesktopDiffStyles()` 那一串里。
 */
ensurePrefAdaptations();

/** 读取 store 快照(useSyncExternalStore:store 的 snapshot 引用稳定)。 */
function useSnapshot(store: GitStore): ReturnType<GitStore['snapshot']> {
  return useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
}

/**
 * 每个页签的**面板名** —— 回退文案里要指名道姓地说清「哪一块坏了」。
 *
 * 用中文而不是 `TAB_ORDER` 的英文标签:文案本地化是人类裁决的
 * (目标文档 §11.9「界面文案统一中文;结构/行为与上游一致」),而这个字符串是
 * **我们这层**的文案,不属于镜像文件。页签标签本身仍是上游原文(另一条线的事)。
 */
const PANEL_LABELS: Readonly<Record<TabId, string>> = {
  changes: '变更面板',
  history: '历史面板',
  code: '代码面板',
  issues: 'Issue 面板',
  pulls: 'Pull request 面板',
  actions: 'Actions 面板',
};

/**
 * 当前选中仓库在 `snap.repos` 里的那一项。
 *
 * 快照只存 `current`(路径),远端/别名都在 `repos` 数组里 —— 与 `repo-bar.tsx`
 * 的查法一致。**`Snapshot` 没有 `currentEntry` 字段**:以前这里(与 `MenuPopover`)
 * 直接读 `snap.currentEntry`,运行期恒为 `undefined`,于是 `ghRef` 永远是 null、
 * 「在浏览器打开」拿不到 origin 只能降级到 `snap.current` 路径。
 */
function currentEntryOf(snap: ReturnType<GitStore['snapshot']>): RepoEntry | undefined {
  return snap.repos.find((entry) => entry.path === snap.current);
}

export function WorkbenchApp(props: WorkbenchAppProps): ReactNode {
  const { store } = props;
  const snap = useSnapshot(store);
  /**
   * **设置弹窗的状态来源 = 上游的 `PopupType.Preferences`**(目标文档 §11.3)。
   *
   * 上游打开它只有一条路径:`app.tsx:496` 的
   * `dispatcher.showPopup({ type: PopupType.Preferences })`,渲染分支在同文件
   * `:1726` 的 `case PopupType.Preferences`。
   *
   * 我们没有 dispatcher(§1.3 排除),但**那个枚举值本身是逐字保留的**
   * (`models/popup.ts` 的 shim 里 `PopupType.Preferences = 'Preferences'`),
   * 所以这里直接用它做「当前打开的是哪个弹窗」的判别,而不是新造一个布尔量 ——
   * 「齿轮 → Preferences 弹窗」这条路径走的仍是上游那个值。
   */
  const [popup, setPopup] = useState<PopupType | null>(null);
  /**
   * **弹窗打开时预选哪一页** —— 两个入口靠它落到不同页签(2026-10)。
   *
   * | 入口 | 预选 | 依据 |
   * |---|---|---|
   * | 齿轮回退 / 「更多」菜单的「dsh-git 偏好设置」 | `'accounts'`(省略时的默认) | 那是这三页的**主入口**,账号页是默认页 |
   * | 「Committing as」浮层的 `Open Git Settings` | `'git'` | 上游 `ui/changes/commit-message.tsx:809-814` 派发的是 `PopupType.Preferences` + **`PreferencesTab.Git`** |
   *
   * ⚠️ 语义是**初始值**(见 `IPreferencesDialogProps.initialSelectedTab`):弹窗已经打开时
   * 再触发另一个入口**不会**切页。这不是缺陷 —— 上游 `preferences.tsx:221-222` 也是
   * `useState` 初值,而「打开着的时候被别的事件切页」会直接把用户正在编辑的页拽走。
   */
  const [preferencesTab, setPreferencesTab] = useState<PreferencesTabId>('accounts');
  const openPreferencesAt = (tab: PreferencesTabId): void => {
    setPreferencesTab(tab);
    setPopup(PopupType.Preferences);
    setMenuOpen(false);
  };
  /** 「设置」那条(齿轮回退 / 菜单项):账号页 —— 与改前逐字同义。 */
  const openPreferences = (): void => { openPreferencesAt('accounts'); };
  /**
   * 「Committing as」浮层的 `Open Git Settings` ⇒ **Git 页**。
   *
   * 具名回调(不是 JSX 里的内联箭头):本仓 `react/jsx-no-bind` 连行内箭头都拦。
   */
  const openGitSettings = (): void => { openPreferencesAt('git'); };
  const closePopup = (): void => { setPopup(null); };
  const preferencesOpen = popup === PopupType.Preferences;
  const [cloneOpen, setCloneOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialog, setDialog] = useState<null | { opts: ConfirmOptions; resolve: (value: boolean) => void }>(null);
  /*
   * 界面缩放(px;`0` = 跟随宿主)—— **订阅** `prefs-bus` 的那一份,不再自己 `useState`。
   *
   * 为什么必须是 `useSyncExternalStore` 而不是「再 `useState` 一份 + 让卡片设法 setState」:
   * 卡片与这里不是同一棵树,拿不到这里的 setter;而**两份 state 就是两份真源**,
   * 迟早分叉(这正是改前那半个缺陷的成因)。
   *
   * `fontScaleStore.subscribe` 是**跨渲染稳定**的模块级函数(`prefs-bus.ts:114-120` 的
   * 对象字面量只求值一次),所以 `useSyncExternalStore` 不会每帧重订阅。
   * 第三个参数(服务端/首次渲染快照)传同一个读取器:值都是原始值,`Object.is` 天然稳定。
   */
  const fontScale = useSyncExternalStore(fontScaleStore.subscribe, getFontScale, getFontScale);
  /**
   * **显示类偏好的重渲染计数器**。
   *
   * 日期/时间/数字格式、首选外部编辑器都是**渲染时直读** localStorage 的
   * (`lib/format-date.ts` / `lib/format-number.ts` / `changes-view.tsx`),而写 localStorage
   * 不会通知同页组件 ⇒ 只写不重渲染 = 「设置了,界面要刷新才变」。Preferences 弹窗每次
   * 写这类偏好就把它加一,于是这棵子树(顶栏 / 列表 / 变更区)全部重读。
   * 同一个值也写到根节点的 `data-prefs-revision` 上 —— 真 Chrome 探针据此断言
   * 「写入真的触发了重渲染」,而不是只看 localStorage。
   *
   * ⚠️ 改前这里是自己的一份 `useState`,于是**只有同一个弹窗里的写入**能通知到它;
   * 宿主设置卡片那条路走的是 `prefs-bus.bumpPreferencesRevision()`,而它当时
   * **零订阅者**(`prefs-bus.ts:148-151` 的注释自认了这一点)⇒ 卡片里改的格式
   * 要刷新页面才生效。现在订阅的就是那个同一份计数器。
   */
  const prefsRevision = useSyncExternalStore(
    subscribePreferencesRevision, getPreferencesRevision, getPreferencesRevision,
  );
  /**
   * 偏好弹窗里任一「显示类偏好」被写之后的回调 —— 转交给**总线**里同一个计数器
   * (`prefs-bus.ts:143` 的 `bumpPreferencesRevision`),于是「弹窗写的」与
   * 「宿主设置卡片写的」走的是同一条通知链。
   *
   * 具名回调(不是 JSX 里的行内箭头):本仓 `react/jsx-no-bind` 连行内箭头都拦。
   */
  const onPreferencesChanged = useCallback((): void => { bumpPreferencesRevision(); }, []);
  /** 「Underline links」偏好:挂在根节点上,规则见 `pref-adapt.ts` 第 6 条。 */
  const underlineLinks = useUnderlineLinks();

  // 首次挂载:装载仓库清单 + 定时刷新工作区。
  useEffect(() => {
    void store.start();
    const stop = store.startPolling(5000);
    return () => {
      stop();
      store.stopPolling();
    };
    // `store` 来自 `storeFor(sessionId)`(`src/client/index.ts` 的 `stores` Map 按
    // session 记忆化)⇒ 一个面板实例内身份恒定,列进依赖不会重跑。
    // 列它的意义:万一将来同一实例被换上另一个 store,清理函数会先停掉旧的那个,
    // 而不是留下两个轮询器。原来这里是空理由的 `eslint-disable-next-line`。
  }, [store]);

  /*
   * **通知面搬到宿主的 `shell.overlay` 席位**(2026-10,用户裁决「右下角气泡」)。
   *
   * 改前 `Toasts` 是**这一棵树**的最后一个子级(`<ErrorBoundary label="提示条">` 里)。
   * 现在由 `src/client/index.ts` 注册的 `shell.overlay` 条目渲染(`FrameToasts`),因为:
   *  1. 那是宿主给「帧级浮层」的**正典席位**(`ui-layout/src/client/index.ts:95-103`),
   *     它的文档里点名了 toast stack;宿主自己那些通知都注册在那儿
   *     (`ui-chat` 的 quota notice、`ui-schedule` 的 DeleteToast、`ui-workspace` 的
   *     RowActionToast…,清单见 `cordis-client-runner/src/client/slot-catalog.ts:2845` 起的
   *     `occupants`),理由是「通知要活过报出它的面板」;
   *  2. 宿主原语把横幅 portal 到 `document.body`,所以席位那一棵树**不占**任何 DOM
   *     (它不会挡住帧里任何东西),几何由 `bits.tsx` 的 clamp 变量 + `styles.ts` 那条
   *     带门控的规则决定。
   *
   * 席位不带 sessionId,所以这里把**本面板这颗 store** 登记成「帧级通知来源」——
   * 哪个 session 报出通知就显示哪一条(多颗同时活着时后到的赢,见 `bits.tsx` 的规则)。
   */
  useEffect(() => registerToastSource(store), [store]);

  // GitHub token 同步:登录后远端页签要用同一个令牌。
  //
  // 依赖表刻意**只列 effect 体真正读到的值**(`hasAuth` / `store`)+ 登录身份的
  // 两个标量:这样既满足 exhaustive-deps,又**不会**因为 `snap.auth` 的其它字段
  // (`deviceFlow` / `tokenTail`)变化而多打一次 `loadRemoteRepos()`。
  // `snap.auth` 的对象身份只在 `loadAuth`/`setPat`/`setAuth` 里被替换(轮询只发
  // `status`/`sync`),所以直接依赖它也不会成环,但那样触发面更大。
  // 原来这里是空理由的 `eslint-disable-next-line`(见 docs/lint-layer.md §8.5)。
  const hasAuth = snap.auth !== null;
  const authSignedIn = snap.auth?.signedIn;
  const authLogin = snap.auth?.login;
  useEffect(() => {
    if (!hasAuth) return;
    // 浏览器侧不发令牌;远端视图走 host 的 remote-repos 缓存与 gh-api 的 token。
    // 这里只在登录状态变化时刷新远端视图的令牌缓存,避免首次渲染 401。
    void store.loadRemoteRepos();
  }, [store, hasAuth, authSignedIn, authLogin]);

  const currentEntry = useMemo(() => currentEntryOf(snap), [snap.repos, snap.current]);
  const ghRef = useMemo(() => parseRepoInput(currentEntry?.remote ?? ''), [currentEntry?.remote]);

  // 远端视图需要的 token:host 只在 remote-repos 里回缓存,不吐令牌。
  // 因此远端写操作要求用户仍处于登录态;读公开仓无需令牌。
  useEffect(() => {
    ghApi.setToken(snap.auth?.signedIn === true ? ghApi.getToken() : '');
  }, [snap.auth?.signedIn]);

  const ui = useMemo(() => ({
    confirm: (opts: ConfirmOptions) => new Promise<boolean>((resolve) => setDialog({ opts, resolve })),
    toast: (message: string, kind: 'ok' | 'err' = 'ok') => store.toast(message, kind),
  }), [store]);

  /**
   * 面板级错误边界的**次级上报通道**(`ErrorBoundary` 的 `onError`)。
   *
   * 主要上报是 `error-boundary.tsx` 自己的 `console.error` + 诊断环;这一条让
   * 用户**当场**看见「哪一块坏了」。刻意用 `store.toast` 而不是 `ui.toast`:
   * `ui` 是给子树用的 context 值,而这里在 `UICtx.Provider` **外层**就很清楚。
   *
   * ⚠️ 必须用 `useCallback` 包一层,不能写成 `const reportPanelError = () => …`:
   * 本仓开着的 `react/jsx-no-bind`(eslint-plugin-react 7.37 的实现)会把
   * **块作用域里 `const X = 箭头函数`** 记下来,然后**每一个** `onError={X}` 都报一条
   * (实测:8 个包装器 ⇒ +8 条)。`useCallback(...)` 的初始化是 CallExpression,
   * 不在它的违规类型里 —— 这也是本仓既有的做法(如 `preferences-pages.tsx`)。
   */
  const reportPanelError = useCallback((message: string): void => {
    store.toast(message, 'err');
  }, [store]);

  /*
   * **推送失败弹窗**的三个出口(`store.pushFailure` 是唯一入口)。
   *
   * 为什么这一层必须有:探针 `push-failure-dialog-probe.mjs` 只证明
   * 「真信封 ⇒ 真 `PushFailureDialog` 的 DOM/事件」,它的诚实边界 #2 写明
   * **不证明**整棵 `WorkbenchApp` 挂载后同样 —— 那正是下面这三行 + 渲染位的事。
   */
  const pushFailure = snap.pushFailure;
  /** 关闭弹窗 —— 上游 `app.tsx` 的 `onPopupDismissedFn` 把弹窗队列队首 pop 掉。 */
  const dismissPushFailure = useCallback((): void => { store.clearPushFailure(); }, [store]);
  /**
   * 「抓取」出口 —— 上游 `push-needs-pull-warning.tsx:56-64` 的 `onFetch`:
   * `await dispatcher.fetch(…)` **之后**才 `onDismissed()`。**顺序是契约**:
   * 抓取在飞的时候弹窗必须还在(否则用户点完就只看到一个消失的框、不知道抓没抓);
   * 上游那 9 行里 `setState({isLoading:true})` 的作用就是这个,我们没有 loading 态,
   * 靠「先 fetch 后 dismiss」表达同一件事。
   *
   * 第二个 rejected 分支是**防御**:`store.fetch()` 自己把失败交给 `fail()`(toast),
   * 正常不会抛;万一抛了,弹窗也不该变成关不掉的模态。
   */
  const fetchAfterPushFailure = useCallback((): void => {
    void store.fetch().then(dismissPushFailure, dismissPushFailure);
  }, [store, dismissPushFailure]);

  const counts = snap.counts;
  const tabCount = (id: TabId): number | undefined => {
    if (id === 'changes') {
      const n = snap.status?.files.length ?? 0;
      return n > 0 ? n : undefined;
    }
    return counts[id];
  };

  return (
    <UICtx.Provider value={ui}>
      <div
        className={underlineLinks ? 'gw-root gw-underline-links' : 'gw-root'}
        data-prefs-revision={prefsRevision}
        style={fontScale === 0 ? undefined : { fontSize: `${fontScale}px` }}
      >
        {/*
         * 顶栏:上游 GitHub Desktop 的 `Toolbar` + 三个 `ToolbarDropdown`
         * (镜像在 `src/core/desktop/ui/toolbar/**`,接线层是 `src/client/toolbar.tsx`)。
         * 移植前这里是手写的 `RepoBar`(`.gw-header` + 三个裸 button)。
         *
         * ⚠️ 2026-10(用户当面纠正后)三个入口的分工**改了**:
         *  - **齿轮 → 直接打开宿主的设置面板**(`host-settings-open.ts`;拿不到就回退到
         *    我们自己的弹窗) —— 用户原话「应该直接弹出弹窗,而不是有下拉 popup」;
         *  - **kebab(`⋮`)→ 「更多」菜单**(仓库操作 + 设置 + dsh-git 偏好设置,**一项不少**);
         *  - **「更多」菜单里的「dsh-git 偏好设置」→ 我们自己的弹窗**(宿主表达不了
         *    账号 / 仓库 / 无障碍三页,那个入口必须留着 —— `docs/host-settings-card.md` §4)。
         */}
        <ErrorBoundary label="顶栏" resetKey={snap.current} onError={reportPanelError}>
          <WorkbenchToolbar store={store} snap={snap}
            onOpenMenu={() => setMenuOpen((v) => !v)}
            onOpenSettings={openPreferences}
            onOpenClone={() => { setCloneOpen(true); setMenuOpen(false); }} />
        </ErrorBoundary>

        {snap.ready && snap.globalError !== null && snap.current === '' && (
          <div className="gw-errbox">{snap.globalError.message}</div>
        )}

        {snap.current === '' ? (
          <ErrorBoundary label="空状态" resetKey={snap.ready} onError={reportPanelError}>
            <Empty icon="folder" title="还没有仓库"
              body={snap.canPickDirectory
                ? '用左上角下拉里的「添加」选择本地仓库,或手动输入路径。'
                : '用左上角下拉手动输入本地仓库路径。'}>
              <div style={{ display: 'flex', gap: 6, justifyContent: 'center', flexWrap: 'wrap' }}>
                <button className="gw-btn primary" disabled={!snap.canPickDirectory}
                  onClick={() => { void store.addRepoViaDialog(); }}>
                  <Icon name="plus" size={11} /> 添加本地仓库
                </button>
                {/* Desktop 的 File ▸ Clone Repository… */}
                <button className="gw-btn" onClick={() => setCloneOpen(true)}>Clone a repository</button>
              </div>
            </Empty>
          </ErrorBoundary>
        ) : (
          <>
            <div className="gw-tabs" role="tablist">
              {TAB_ORDER.map((tab) => (
                <TabButton key={tab.id} id={tab.id} label={tab.label}
                  active={snap.tab === tab.id} count={tabCount(tab.id)}
                  onSelect={() => store.setTab(tab.id)} />
              ))}
            </div>
            {/*
              * **`.gw-body` 是 `tooltip-host`(2026-10,真 Chrome 实测定死的那一条)**
              *
              * 上游 `ui/lib/tooltip.tsx:838-839` 的 portal 目标是
              * `target.closest('.tooltip-host') ?? document.body`;而全部 tooltip 规则与
              * 变量桥都在 `src/client/scss/tooltips.scss` 的 `.tooltip-host` 那一面里
              * (入口选择器 `.tooltip-host > .tooltip`)。⇒ **触发点不在任何
              * `.tooltip-host` 子树里 ⇒ 浮层是 `body > .tooltip` ⇒ 一条规则都不匹配**,
              * 计算值退回 UA 默认(`display:block; position:static; background:transparent;
              * z-index:auto`),于是它落在 `<body>` 的正常流末尾、**视口之外**。
              *
              * 实测(探针 `docs/probes/tooltip-paint-probe.mjs`,真 headless Chrome,
              * 插件盒 420×820;`Element.prototype.closest` 间谍枚举出 14 个触发点):
              *   · 悬停 diff 里的 `[aria-label="Expand Down"]`(Changes 页签)
              *     → portal 目标 `document.body`,浮层 rect `y=1308`(视口高 813)、
              *     命中测试在该点返回 `null` ⇒ 用户看到的就是**「hover 没出来」**;
              *   · 悬停仓库行(`.gw-app-toolbar` 那个 host)→ 4 条规则匹配、引用的 10 个
              *     变量全部解析、底色 `rgb(44,44,46)`、命中栈里在最上面 ⇒ 正常。
              *
              * 为什么挂在 `.gw-body` 而不是别的元素:
              *  1. **必须是「覆盖所有页签内容、又不覆盖顶栏」的那一层**。顶栏
              *     (`.gw-app-toolbar`)已经是 host,挂在这里不会改变它的最近 host;
              *     History 面板自带 `.gw-pane.gw-desktop-history.tooltip-host`,最近 host
              *     同样不变(实测三者 portal 目标逐条不变)。而 diff 面板
              *     (`.gw-desktop-diff{overflow:hidden}`)与 `.gw-split>.right{overflow:hidden}`
              *     都**会裁**浮层,所以不能挂在它们上面;`.gw-pane`(Changes 的面板根)才是
              *     最窄的等价位置,但它属于 `changes-view.tsx`(**本轮由另一条并行线持有,
              *     不许写**)⇒ 取上一层 `.gw-body`(它没有 `overflow`,不裁任何东西)。
              *  2. **不新增 DOM 元素**:goal 文档 §11.1.1 量过「多一层包裹元素」会把上游
              *     没有的元素变成 64px 高的 flex 容器、几何整体偏移。这里只加一个类名。
              *  3. 变量桥的所有权**一个字都没变**:仍然只有
              *     `src/client/scss/tooltips.scss` 的 `.tooltip-host { … }` 一份
              *     (见该文件顶部「变量:绑在作用域元素自己身上」一节)。
              *
              * ⚠️ **代价(必须知道,不要当成免费的)**:`.tooltip-host` 那一面同时声明了
              * 17 个 Desktop 通用变量名(`--spacing` / `--font-size` / `--border-radius` /
              * `--color-new|modified|deleted|renamed` …)。挂到 `.gw-body` 上,这些名字就
              * 会覆盖**页签内容的整棵子树**。今天**不改变任何计算值**,判据有两条:
              *   · 产物里引用这些名字的规则,全部落在**自己声明了同一组变量**的面里
              *     (`.gw-app-toolbar` / `.gw-desktop-history` / `.gw-desktop-diff` /
              *     `.gw-repo-list` / `.gw-prefs` 各自 `@include dsh-desktop-bridge`),
              *     局部声明赢过继承;
              *   · 我们手写的 `styles.ts` / `styles-base.ts` 里 `var(--spacing*|--font-size*|
              *     --border-radius|--color-*)` 的命中**只有注释**(grep 可复核)。
              * 残余风险是**将来**有人手写一条 `var(--font-size)` —— 那会静默吃到 Desktop 的
              * 12px。**退役条件**:等 `scripts/styles.mjs` 的 `portalHost` 断言能表达
              * 「变量声明在浮层自己身上」(`.tooltip-host > .tooltip`),就把变量从 host 挪到
              * 浮层,然后 `.gw-body` 上的 `tooltip-host` 只剩「portal 落点」这一个作用。
              */}
            <div className="gw-body tooltip-host">
              {/*
                * **每个页签一个边界**(不是插件根一个、也不是每个组件一个):
                * 一次渲染期抛错只废掉**当前这一块**,顶栏 / 页签栏 / 底部状态条
                * 与其它页签照常可用。`resetKey` 绑「页签 + 仓库」⇒ 切页签或换仓库
                * 会自动复位,不会永久停在回退上。理由见 `src/client/error-boundary.tsx`。
                */}
              <ErrorBoundary
                label={PANEL_LABELS[snap.tab]}
                resetKey={`${snap.tab}::${snap.current}`}
                onError={reportPanelError}
              >
                <ViewPort store={store} snap={snap} ghRef={ghRef} onOpenGitSettings={openGitSettings} />
              </ErrorBoundary>
            </div>
          </>
        )}

        <div className="gw-footer">
          <span>{snap.current !== '' ? shorten(snap.current) : '未选择仓库'} · 已添加 {snap.repos.length} 个</span>
          <span>
            {snap.status?.detached === true ? '分离头' : (snap.status?.branch ?? '—')}
            {snap.sync !== null && snap.sync.remotes.length > 0 ? ` · ${snap.sync.remotes.join(',')}` : ''}
            {snap.storagePersistent === false ? ' · 存储仅内存' : ''}
            {snap.busy !== '' ? ` · ${snap.busy}…` : ''}
          </span>
        </div>

        {/*
          * 浮层各自一个边界。它们的**共同点**是都挂在 DOM 的另一处(portal),
          * 而**不同点**是彼此独立 ⇒ 一个坏了不该把其余的也带走。
          */}
        {cloneOpen && (
          <ErrorBoundary label="Clone a repository 弹窗" resetKey={cloneOpen} onError={reportPanelError}>
            <CloneDialog store={store} onClose={() => setCloneOpen(false)} />
          </ErrorBoundary>
        )}
        {/*
         * **dsh-git 偏好设置模态**(目标文档 §11.3 的验收:
         * 居中模态 + 遮罩 + Esc 可关 + 焦点被 trap + 页面都在)。
         *
         * 移植前这里是手写的 `SettingsPopover`(`.gw-pop right`,一个下拉框),
         * 那正是用户指出的差距。现在渲染的是上游 `ui/preferences/**` 的页面
         * (字节一致)+ 本地化的外壳,见 `preferences-dialog.tsx`。
         *
         * ⚠️ 2026-10:**入口不再是「设置」那一项** —— 那一项改成开**宿主的**设置面板,
         * 这个弹窗由下面独立的「dsh-git 偏好设置」项打开(理由:宿主表达不了无障碍 /
         * 仓库 / 账号三页,删掉入口等于删掉那三页)。逐页裁决见
         * `docs/host-settings-card.md` §4。
         *
         * ⚠️ 页面数从 7 收敛到 **3**(账号 / 仓库 / 无障碍):外观与外部集成已按裁决删除
         * (重复 / 死代码),`prompts` 与 `advanced` 更早已删。
         */}
        {preferencesOpen && (
          /*
           * ⭐ **缺陷现场 #1 的兜底**:`loadAccountEmails` 曾经把畸形载荷透传成
           * `emails: undefined`,消费方的 `emails.map(...)` 抛 TypeError ⇒ 没有边界时
           * **整个设置弹窗被卸载**,现场只剩「探针的 #probe-result 不存在」。
           * 有边界之后:这里变成一块**说得出原因**的回退,而插件其余部分照常。
           *
           * 注意边界包在**外面**:宿主 `Modal` 走 portal,而错误边界是按
           * **React 树**的位置算的(不是 DOM 位置),所以 portal 里的抛错照样被它接住。
           */
          <ErrorBoundary label="dsh-git 偏好设置" resetKey={preferencesTab} onError={reportPanelError}>
            <PreferencesDialog
            /*
             * ⚠️ `endpoint` 必须传(2026-10 补):宿主 `auth/state` 一直返回它,而这里
             * 构造「自建模态」时曾经只给 `login` / `tokenTail` ⇒
             * `preferences-pages.tsx:790` 的 `identity.endpoint` 恒 `undefined`,
             * 账号页只能退回「上次用过的端点」,于是**卡片显示的端点与宿主实际用的端点
             * 可能不一致**(`account-emails.tsx` 的 `IAuthIdentity.endpoint` 文件头
             * 把这条点名记了很久)。
             */
            auth={snap.auth === null ? null : {
              login: snap.auth.login,
              tokenTail: snap.auth.tokenTail,
              endpoint: snap.auth.endpoint,
            }}
            store={store}
            snap={snap}
            fontScale={fontScale}
            /* 直接给总线那个写入口(`prefs-bus.ts:99` 的 `setFontScale`):弹窗与卡片
               写的是**同一份**值,于是「弹窗改字号」与「卡片改字号」不再各写各的。 */
            onFontScale={setFontScale}
            onPreferencesChanged={onPreferencesChanged}
            /*
             * 打开时预选哪一页。`preferencesTab` 只在**打开的那一次**被读 ——
             * 语义是初值,见下面 `openPreferencesAt` 的注释与那个 prop 的 JSDoc。
             */
            initialSelectedTab={preferencesTab}
            onClose={closePopup}
            />
          </ErrorBoundary>
        )}
        {pushFailure !== null && (
          <ErrorBoundary label="推送失败" resetKey={`${pushFailure.code}:${pushFailure.message}`}
            onError={reportPanelError}>
            <PushFailureDialog
              error={pushFailure}
              onFetch={fetchAfterPushFailure}
              onOpenPreferences={openPreferences}
              onDismiss={dismissPushFailure}
            />
          </ErrorBoundary>
        )}
        {menuOpen && (
          <ErrorBoundary label="「更多」菜单" resetKey={menuOpen} onError={reportPanelError}>
            <MenuPopover store={store} snap={snap} onClose={() => setMenuOpen(false)}
              onOpenSettings={openPreferences}
              onOpenClone={() => { setMenuOpen(false); setCloneOpen(true); }} />
          </ErrorBoundary>
        )}
        {dialog !== null && (
          <ErrorBoundary label="确认对话框" resetKey={dialog !== null} onError={reportPanelError}>
            <ConfirmDialog title={dialog.opts.title} body={dialog.opts.body}
              confirmText={dialog.opts.confirmText} danger={dialog.opts.danger}
              onDone={(okay) => { dialog.resolve(okay); setDialog(null); }} />
          </ErrorBoundary>
        )}
        {/*
          提示条**不再挂在这里**:通知面搬到宿主的 `shell.overlay` 席位
          (`src/client/index.ts` 的 `dsh-git.toasts` 条目 → `bits.tsx` 的 `FrameToasts`),
          本组件只把 `store` 登记成通知来源(见上面那个 effect)。错误边界跟着搬到席位
          条目那一层(index.ts 里包着 `FrameToasts`)。
        */}
      </div>
    </UICtx.Provider>
  );
}

/** 一个页签按钮。 */
function TabButton(props: {
  id: TabId;
  label: string;
  active: boolean;
  count?: number;
  onSelect: () => void;
}): ReactNode {
  return (
    <button className={`gw-tab${props.active ? ' on' : ''}`} role="tab" aria-selected={props.active}
      onClick={props.onSelect}>
      {props.label}
      {props.count !== undefined && props.count > 0 && <span className="gw-count">{props.count}</span>}
    </button>
  );
}

/** 视图路由。 */
function ViewPort(props: {
  store: GitStore;
  snap: ReturnType<GitStore['snapshot']>;
  ghRef: { owner: string; repo: string } | null;
  /**
   * 「Committing as」浮层的 `Open Git Settings` ⇒ 打开偏好设置并**预选 Git 页**。
   *
   * 由 `WorkbenchApp` 的 `openGitSettings` 提供(`ChangesView` 的 prop 名是通用的
   * `onOpenPreferences`,因为那个组件只知道「要开偏好设置」,不知道自己的调用方
   * 绑定的是哪一页 —— 绑定关系留在 **这一处**):
   * 上游 `ui/changes/commit-message.tsx:809-814` 派发的是
   * `PopupType.Preferences` + `PreferencesTab.Git`。
   */
  onOpenGitSettings: () => void;
}): ReactNode {
  const { store, snap, ghRef } = props;

  // Code 在没有 GitHub 远端时退化为本地工作区视图(仍然有用);
  // Issues / PR / Actions 必须有远端,给可读说明。
  if (snap.tab === 'code' && ghRef === null) {
    return <LocalCodeView store={store} snap={snap} />;
  }
  if (snap.tab !== 'changes' && snap.tab !== 'history' && ghRef === null) {
    return (
      <Empty icon="git-branch" title="这个仓库没有 GitHub 远端"
        body="Issues / Pull requests / Actions 需要 origin 指向 github.com;Code 已切换为本地工作区视图。">
        <button className="gw-btn" onClick={() => { void store.refreshAll(); }}>重新读取</button>
      </Empty>
    );
  }

  const branch = snap.status?.branch !== undefined && snap.status.branch !== '' ? snap.status.branch : 'HEAD';
  const branchNames = snap.branches.filter((b) => !b.isRemote).map((b) => ({ name: b.name }));

  switch (snap.tab) {
    case 'changes':
      return <ChangesView store={store} snap={snap} onOpenPreferences={props.onOpenGitSettings} />;
    case 'history':
      return <HistoryView store={store} snap={snap} />;
    case 'code':
      return <CodeView ghRef={ghRef as { owner: string; repo: string }} branch={branch} />;
    case 'issues':
      return (
        <IssuesView ghRef={ghRef as { owner: string; repo: string }}
          visible={true}
          onCount={(n: number) => store.setCount('issues', n)}
          initialDetail={null}
          onConsumeDeep={() => undefined} />
      );
    case 'pulls':
      return (
        <PullsView ghRef={ghRef as { owner: string; repo: string }}
          branches={branchNames as never}
          visible={true}
          onCount={(n: number) => store.setCount('pulls', n)}
          initialDetail={null}
          onConsumeDeep={() => undefined} />
      );
    case 'actions':
      return (
        <ActionsView ghRef={ghRef as { owner: string; repo: string }}
          visible={true}
          onCount={(n: number) => store.setCount('actions', n)} />
      );
    default:
      return null;
  }
}

/*
 * ==========================================================================
 * 「更多」(kebab `⋮`)菜单 —— 换成**上游 `Popover` 原语**
 * ==========================================================================
 *
 * 用户原话:「`.gw-pop` 相关的不太对吧,你看下 `references/dekstop` 是怎么实现的」。
 * 他是对的:改前这里是**手写**的一层 `.gw-scrim` + `.gw-pop` + 一整套自算锚点的数学
 * (`./menu-anchor.ts`,本文件曾是它唯一的调用方,现已整个删除),而上游
 * `ui/lib/popover.tsx` **与上游一致在本仓、已经打进产物**(`lib/client.js` 里
 * `popover-component` 45 处、`computePosition` 4 处),它自带 floating-ui 的
 * `computePosition` + `offset/shift/flip/size`(`popover.tsx:162-185`)。
 *
 * ## 改前 / 改后各自负责什么
 *
 * | 职责 | 改前(自算) | 改后(上游 `Popover`) |
 * |---|---|---|
 * | 锚点 | 量 kebab 的 `getBoundingClientRect()`,算出 `top` / `right` | `anchor` prop = **那个 `<button>` 本身** |
 * | 定位 | 手算 + 手写行内 style(`position:fixed` + `top`/`right`) | floating-ui `computePosition`(`strategy:'fixed'`,`popover.tsx:191`) |
 * | 宽度 | `width:max-content` + 手算 `maxWidth`(防越过插件根左缘) | 内容决定 + CSS `max-width:min(360px,100%)`(包含块就是 `.gw-root`,见 `styles.ts`) |
 * | 视口溢出 | **无**(只有「插件根左缘」那条手算上限) | `shift` / `flip` / `size` 三个中间件 + **真的消费** `--available-height` |
 * | 点外面关闭 | 自己铺一层 `.gw-scrim` 接点击(第一下点击被遮罩吃掉) | `Popover` 自己的 `onClickOutside` / `onMousedownOutside`(点击同时到达目标) |
 * | Esc 关闭 | **没有** | 有(`FocusTrap` 的 `escapeDeactivates` → `onDeactivate`) |
 *
 * ## `anchorPosition` 为什么取 `BottomRight`
 *
 * 契约与改前**逐字相同**:菜单在 kebab **下方**、**右边缘与 kebab 右边缘重合**。
 * 枚举是两个维度各取一维(`popover.tsx:29-31`:第一维 = 锚点的哪条**边**,第二维 =
 * 贴锚点的哪一**侧**),`BottomRight` → floating-ui `bottom-end`(`:450-451`)。
 * 上游最接近我们的调用点是「工具栏上的一个按钮 → 一列选项」那两处,都取它:
 * `ui/changes/changes-list-filter-options.tsx:156`、`ui/diff/diff-options.tsx:117`。
 *
 * ## `isDialog` / `trapFocus` 为什么不传(= 用上游默认的 `true` / `true`)
 *
 * 上面那两个最接近的调用点**都不传**这两个 prop(`diff-options.tsx:114-121` /
 * `changes-list-filter-options.tsx:152-160`)。照它的**实测收益**是两条:
 *   · Esc 能关菜单(`escapeDeactivates` → `onDeactivate` = `onMousedownOutside` = `onClose`);
 *   · Tab 不会跑到菜单背后的界面上去(改前会 —— `.gw-scrim` 不 trap 焦点)。
 * 代价是 `role="dialog"` 这个语义:所以补一个 `.sr-only` 的可达名字(`ariaLabelledby`)。
 * ⚠️ 若评审更想要「菜单不是对话框」的语义,上游另一个调用点给了现成模板:
 * `ui/autocompletion/autocompleting-text-input.tsx:307-309` 的
 * `trapFocus={false} isDialog={false}` —— 代价是上面那两条能力一起没有。
 *
 * ## 为什么 portal 到**锚点自己那一层包装**(`.toolbar-button`)
 *
 * 上游判「点在外面」用的是 `!ref.parentElement.contains(target)`
 * (`popover.tsx:232` / `:247`)—— 也就是说 **Popover 渲染在哪里,决定了什么算「外面」**。
 * 上游的调用点把 Popover 渲染在**按钮同一个组件包装 div 里**(`diff-options.tsx:87-107`),
 * 于是「点触发按钮不算外面」天然成立。
 *
 * 我们沿用这个形状(`toolbar.tsx` 本轮不许动,所以只能 portal):portal 到
 * `anchor.parentElement`(= `ToolbarButton` 的 `.toolbar-button` div)之后,那个容器里
 * **只有 kebab 这一个可点元素** ⇒
 *   · 再点一次 kebab:不算外面 ⇒ 由 React 的 toggle 关掉(`workbench.tsx` 的
 *     `onOpenMenu={() => setMenuOpen((v) => !v)}`);
 *   · 点界面里**任何别的地方**:算外面 ⇒ `onClose`。
 * 若直接渲染在 `.gw-root` 下(不 portal),`parentElement` 就是整个 `.gw-root`,于是
 * 「点页签 / 点文件行」都**不算外面**,菜单会赖着不走 —— 那不是上游的语义,是渲染位置的锅。
 *
 * ## 判据
 *
 * 真 Chrome、三个宿主宽 520 / 620 / 900,外加两个「必需求助中间件」的变体
 * (窄视口逼出 `shift`、矮视口逼出 `size`+`--available-height`)与一个
 * **插件根不在原点**的变体(证明包含块算对了):
 * `docs/probes/menu-anchor-probe.mjs` + `docs/probes/menu-anchor-driver.tsx`。
 */

/** 菜单与 kebab 之间的垂直缝隙 —— 旧 CSS `top: calc(100% + 4px)` 的 4px,逐字沿用。 */
const MORE_MENU_ANCHOR_OFFSET = 4;

/**
 * 菜单的层级。
 *
 * `Popover` 自己写死 `zIndex: 17`(`popover.tsx:317`,注释说等于上游 `--foldout-z-index`)。
 * 菜单 DOM 现在挂在 `.toolbar-button` 里,**参与 `.gw-root` 那个层叠上下文**
 * (`styles.ts` 的 `.gw-root{contain:layout paint}`,paint containment 会建上下文),
 * 而菜单往下盖住的正是 `.gw-body` 那一块内容(`.gw-inbox` 28 / `.gw-diffopt-pop` 45 /
 * 旧的 `.gw-pop` 50)。取 50:高于插件内容,**低于**对话框遮罩(`.gw-dialog-scrim` 60)
 * 与 toast(`.gw-toasts` 70)—— 与改前 `.gw-pop` 同层。
 * 必须**行内**给:`Popover` 的默认值是它自己 `style` 里的 17,样式表压不过行内。
 */
const MORE_MENU_Z_INDEX = 50;

/** 菜单卡片自己的类名(样式在 `styles.ts`;`Popover` 把它放在容器 div 上)。 */
const MORE_MENU_CLASS = 'gw-more-menu';

/**
 * `role="dialog"` 需要一个可达名字(`ariaLabelledby`);这个名字挂在菜单里那个
 * `.sr-only` 的 div 上(`.sr-only` 的配方由顶栏面提供,toolbar 面 `requires` 里点名了)。
 */
const MORE_MENU_LABEL_ID = 'gw-more-menu-label';

function MenuPopover(props: {
  store: GitStore;
  snap: ReturnType<GitStore['snapshot']>;

  onClose: () => void;
  onOpenSettings: () => void;
  onOpenClone: () => void;
}): ReactNode {
  const { store, snap } = props;
  const remote = currentEntryOf(snap)?.remote ?? '';
  /*
   * 「设置」那一项带上**宿主自己**的键位(从 `ctx.shortcuts.catalog` 的 `settings.open`
   * 行读回来;用户改键位这里跟着变)。读不到就只写「设置」两个字 —— **不编一个假的快捷键**。
   */
  const settingsKeys = hostSettingsShortcutKeys();
  const settingsLabel = settingsKeys.length > 0 ? `设置(${settingsKeys.join('')})` : '设置';
  /*
   * 锚点 = kebab(`更多`)按钮 —— 由 `toolbar.tsx` 导出的 `menuAnchorElement()` 从
   * **动作组的 ref** 里取(不是 `document.querySelector('[aria-label="更多"]')`:
   * 那种按文案找元素的做法在文案一改或多实例共存时会静默失配,而失配的表现正是
   * 「菜单跑到别处」,与用户报的现象一样,无从归因)。
   *
   * ⚠️ `menuAnchorElement()` 给的是**真正生成盒子的那个 `<button>`**(不是
   * `display:contents` 的包装层 —— 那个的 rect 恒为全 0,理由见 `toolbar.tsx:187-191` 与
   * `:242-251`)。`instanceof HTMLElement` 这一步只是把 `Element | null` 收成
   * `Popover` 要求的 `HTMLElement | null` —— 不用 `as`:拿不到 `HTMLElement` 时
   * 菜单**不渲染**,而不是锚到 (0,0) 上。
   */
  const anchorCandidate = menuAnchorElement();
  const anchor = anchorCandidate instanceof HTMLElement ? anchorCandidate : null;
  /* portal 目标 = 锚点自己那一层包装(`ToolbarButton` 的 `.toolbar-button` div);
     为什么是它、不是什么,见上面文件头「为什么 portal 到锚点自己那一层包装」。 */
  const portalHost = anchor === null ? null : anchor.parentElement;
  const item = (label: string, run: () => void, disabled = false): ReactNode => (
    <button className="gw-pitem" disabled={disabled} onClick={() => { props.onClose(); run(); }}>
      <span className="grow">{label}</span>
    </button>
  );
  if (anchor === null || portalHost === null) {
    return null;
  }
  return ReactDOM.createPortal(
    /*
     * 为什么是 `createElement` 而不是 JSX 的 `<Popover>…</Popover>`(实测,不是风格):
     * 镜像的 `IPopoverProps`(`popover.tsx:70-97`)**没有声明 `children`**,于是 JSX 的
     * 子元素检查会报 TS2322 —— 上游**每一个** `Popover` 调用点都带着这条诊断
     * (`diff-options.tsx(114,8)` / `changes-list-filter-options.tsx(152,8)` /
     * `whitespace-hint-popover.tsx(21,8)` / `commit-list.tsx(642,8)`,镜像自己也报
     * `popover.tsx(300,7): Property 'children' does not exist on type 'Readonly<IPopoverProps>'`)。
     * 本轮判据是「改过的文件 tsc 不许变多」,而 `createElement` 的重载把子元素当
     * `...children` 收下、不要求 props 里有 `children` ⇒ 这条**属于镜像的**历史诊断不会
     * 被我复制进 `workbench.tsx`(换一个容器不该顺手搬一条别人的错过来)。
     */
    createElement(
      Popover,
      {
        className: MORE_MENU_CLASS,
        anchor,
        anchorPosition: PopoverAnchorPosition.BottomRight,
        anchorOffset: MORE_MENU_ANCHOR_OFFSET,
        onMousedownOutside: props.onClose,
        onClickOutside: props.onClose,
        ariaLabelledby: MORE_MENU_LABEL_ID,
        style: { zIndex: MORE_MENU_Z_INDEX },
      },
      /*
       * 这一层 `.gw-more-menu-items` **不是**装饰:上游 `Popover` 把
       * `--available-height` / `--available-width` 写在 `.popover-content` 的**行内**
       * (`popover.tsx:173-181`),而 `.popover-content` 自己的 `overflow:hidden` 同样是
       * **行内**的(`:322`,样式表压不过它)。自定义属性**会继承**,所以把 `max-height`
       * 与滚动放在这一层子元素上:上游 `size()` 中间件给出的「可用高度」真的被消费,
       * 而 `.popover-content` 里没有任何东西需要被裁 ⇒ 既不需要 `!important`,
       * 菜单在矮宿主里也是**能滚**的(而不是齐膝剪掉最后几项)。
       * 规则在 `styles.ts` 的 `.gw-more-menu .gw-more-menu-items`。
       */
      <div className="gw-more-menu-items">
        {/*
         * `role="dialog"` 的可达名字(`ariaLabelledby` 指过来)。
         * `.sr-only` 的配方由**顶栏面**提供(`scripts/styles.mjs` 的 toolbar 面
         * `requires['.sr-only']`),而菜单 DOM 正是 portal 进顶栏那一棵子树里的。
         */}
        <div className="sr-only" id={MORE_MENU_LABEL_ID}>更多菜单</div>
        <div className="gw-pop-title">仓库</div>
        {item('Clone a repository…', () => props.onOpenClone())}
        <div className="gw-pop-title">仓库操作</div>
        {/*
         * ⚠️ 这两项的 `disabled` 条件是 2026-10 **从顶栏搬过来的**,不是新加的:
         *  「刷新状态与历史」原来是顶栏上一个 `ToolbarBtn`,当时带 `disabled={busy}`
         *  (图标还会转 `spin`);「在浏览器打开仓库」原来是顶栏上一个 `ToolbarBtn`,
         *  当时带 `disabled={remote === ''}`。
         *  按用户要求把两个按钮收进菜单之后,那两个条件**必须跟着搬** —— 否则:
         *   · 同步进行中还能再点一次刷新 ⇒ 丢掉「一次只跑一个网络动作」的约束
         *     (`snap.busy !== ''` 与 `toolbar.tsx` 里 `const busy = snap.busy !== ''` 同口径);
         *   · 没有远端时「在浏览器打开仓库」会拼出 `https://github.com/` 这种空链接。
         */}
        {item('刷新状态与历史', () => { void store.refreshAll(); }, snap.busy !== '')}
        {item('抓取远端(fetch)', () => { void store.fetch(); }, (snap.sync?.remotes.length ?? 0) === 0)}
        {item('拉取(pull)', () => { void store.pull(); }, snap.sync?.upstream == null)}
        {/*
         * ⚠️ 这两项的 `disabled` 判据 2026-10 补齐(用户报「推送失败没有弹窗」这一轮
         * 顺带查出来的**同一族**缺陷:入口没接上,点下去没反应/报错)。
         *
         * 上游在「没有远端」时**根本不推**:`performPush` 第一件事就是
         * `if (remote === null) { _showPopup({type: PopupType.PublishRepository}) }`
         * (`lib/stores/app-store.ts:5222-5229`),而 `ui/toolbar/push-pull-button.tsx:527-539`
         * 在那个状态下渲染的是 **Publish repository** 按钮(标题 `Publish this repository to GitHub`)。
         * 我们的顶栏那条路已经按同一判据截住了(`toolbar.tsx:646-651` 的
         * `remotes.length === 0 ⇒ toast + return`),但**菜单这两项当时漏了** ⇒
         * 它会把一个没有远端的仓库推到宿主,拿到 `no-upstream` 错(`git-service.ts:1614-1615`)。
         * 两条入口判据不一致,用户看到的就是「同一个动作,一个入口说不支持、另一个入口直接报错」。
         *
         * 同时补上 `snap.busy !== ''`:宿主侧的网络动作是**互斥**的
         * (`store.ts:1804-1806` 的 `isNetworkActionInProgress()` 直接 return),
         * 而 `store.push` 的提前 return **不产生任何反馈** ⇒ 那就是「点了没反应」。
         * 菜单项显式禁用,与「刷新状态与历史」那一项同口径。
         */}
        {item('推送(push)', () => { void store.push(false); },
          snap.status?.unborn === true || (snap.sync?.remotes.length ?? 0) === 0 || snap.busy !== '')}
        {item('强推(--force-with-lease)', () => { void store.push(true); },
          snap.sync?.canForcePush !== true || (snap.sync?.remotes.length ?? 0) === 0 || snap.busy !== '')}
        <div className="gw-pop-title">打开</div>
        {item('在浏览器打开仓库', () => {
          if (remote !== '') window.open(`https://github.com/${remote}`, '_blank', 'noopener');
        }, remote === '')}
        {item(settingsLabel, () => {
          /*
           * ⭐ 「设置」= **宿主的**设置面板(2026-10 用户报「点击右上角的设置出的是我们自己
           * 的弹窗,我期望是弹出宿主的」)。
           *
           * 宿主**没有**可编程打开设置的服务 —— 四条候选通路(Service / command / slot /
           * overlay)逐条走死的证据链见 `./host-settings-open.ts` 的文件头与
           * `docs/host-settings-card.md` §1。所以这里驱动的是**宿主自己渲染的**设置控件:
           * 点它自己的按钮 / 菜单项 ⇒ 走它自己的 `onClick` ⇒ 它自己的 `actions.open()`。
           * 拿不到宿主控件时返回 `'unavailable'`,回退到我们自己的弹窗 ⇒ **不会点了没反应**。
           *
           * 注:`item()` 先 `onClose()` 再 `run()`,所以菜单(浮层,z-index 50)不会压在
           * 宿主刚拉起来的模态层上;`openHostSettings()` 内部也先等一帧再找控件。
           */
          void openHostSettings().then((result) => {
            if (result === 'unavailable') {
              props.onOpenSettings();
            }
          });
        })}
        {/*
         * 我们自己那份 GitHub-Desktop 形状的偏好弹窗**必须仍然可达**:无障碍
         * (`diff-check-marks-visible` 要真的驱动 diff 勾选列)、仓库(仓库清单/别名/默认分支
         * 是本插件的产品面)、账号(设备码面板接的是本插件 host 半的 `auth/device-*`)
         * 这三页宿主表达不了 —— 删掉这个入口就等于删掉那三页。逐页保留/删除的裁决与理由
         * 见 `docs/host-settings-card.md` §4。
         */}
        {item('dsh-git 偏好设置(登录 / 模型 / 仓库)', () => props.onOpenSettings())}
      </div>,
    ),
    portalHost,
  );
}

function shorten(path: string): string {
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= 3) return path;
  return `…/${parts.slice(-2).join('/')}`;
}
