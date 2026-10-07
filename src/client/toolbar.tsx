/**
 * 顶栏(Toolbar)—— **上游 GitHub Desktop 三段式工具栏的接线层**。
 *
 * ## 这个文件是什么 / 不是什么
 *
 * 外壳与交互全部来自与上游一致的上游文件:
 *
 * | 上游 | 本文件怎么用 |
 * |---|---|
 * | `ui/toolbar/toolbar.tsx` | `<Toolbar id="desktop-app-toolbar">` 容器;类名 `toolbar` 由它自己给 |
 * | `ui/toolbar/button.tsx` | `ToolbarButton`(两行结构 `.text > .description + .title`、`.icon`、`.progress`、badge 槽) |
 * | `ui/toolbar/dropdown.tsx` | `ToolbarDropdown`(foldout / multi-option 两种形态、chevron、FocusTrap、Escape、点击遮罩关闭、按自身实测盒子定位) |
 * | `ui/octicons/index.ts` | `iconForRepository`(上游的仓库图标判定)与 `syncClockwise` |
 *
 * **本文件只做三件事**:
 *  1. 把 dsh-git 的仓库/分支/同步数据翻译成上游那三个组件的 props(与 `ui/app.tsx:3536-3549`
 *     的 `renderRepositoryToolbarButton()`、`ui/toolbar/branch-dropdown.tsx:200-262`、
 *     `ui/toolbar/push-pull-button.tsx:598-688` 逐条对照);
 *  2. **文案本地化**(goal 文档 §11.9:用户可见文案统一中文,这是**有意为之**的偏离);
 *  3. 三处无法 import 上游文件时的最小替代(每一处都在下面就地写明理由)。
 *
 * 上游**没有被修改一个字**:`node scripts/verify-mirror.mjs` 对 `ui/toolbar/**` 与
 * `ui/branches/**` 报 25/25 字节一致。
 *
 * ## 为什么不能直接 import `ui/toolbar/index.tsx`
 *
 * 那个桶文件 `export *` 会把整个 toolbar 子树拉进编译图,而其中几个文件依赖我们树里
 * 没有的模块(esbuild 解析不到 ⇒ **整个构建失败**,不是警告):
 *
 * | 上游文件 | 解析不到的 import | 归属 |
 * |---|---|---|
 * | `toolbar/push-pull-button.tsx` | `../../lib/rebase`、`../../models/fetch` | 别的泳道(models/** 等) |
 * | `toolbar/worktree-dropdown.tsx` | `../worktrees/worktree-list`、`../worktrees/worktree-list-item-context-menu` | 未开面 |
 * | `toolbar/branch-dropdown.tsx` | `../check-runs/ci-check-run-popover` + `../branches` 桶(见 `repo-bar.tsx` 末尾的缺口清单) | 未开面 |
 *
 * 所以这里**精确 import 三个能解析的文件**(`toolbar.tsx` / `dropdown.tsx` /
 * `button.tsx`,后者由 dropdown 内部 import)。这三个文件的依赖全部在镜像里
 * (`lib/fatal-error`、`lib/clamp`、`lib/feature-flag`、`ui/lib/{button,tooltip,rect,aria-types,observable-ref}`、
 * `ui/octicons/**`、`focus-trap-react`、`focus-trap`),这是本面唯一可达的子集。
 *
 * ## 三处「不改镜像」的适配(逐条理由)
 *
 * 1. **children 的类型适配**(下面 `ToolbarEl` / `Dropdown` / `ToolbarBtn` 三个 cast):
 *    上游的 props 接口**没有声明 `children`** —— 上游用 React 17 的类型,children 是隐式的;
 *    而它自己的 `render()` 里就在渲染 `{this.props.children}`(`button.tsx:230`、
 *    `dropdown.tsx:505`,顶栏那个 ↑N/↓N badge 正是从 children 传进去的)。
 *    我们这层是 React 18 的类型 ⇒ 直接传 children 会报 TS2322,而
 *    `scripts/check-types.mjs` 对**新文件**的任何诊断都算回归。所以在这里做**交叉类型**
 *    适配(真实 props 一字不改,只**增加** `children?`),不动镜像。
 * 2. **`forcePushIcon` 就地复制**(下面是那个常量):它导出在
 *    `ui/toolbar/push-pull-button.tsx:166-181`,而那个文件顶部就 import `lib/rebase`
 *    ⇒ 一旦 import 它,构建会因为解析不到而失败(feature-flag/树摇都救不了)。
 *    按 goal 文档 §2.1 规则 4「只缺一个纯函数/常量时沿用那一个,别沿用整个文件」处理。
 * 3. **同步下拉的菜单项**就地渲染(见 `renderSyncItems`):上游那份是
 *    `ui/toolbar/push-pull-button-dropdown.tsx`(129 行),它 `import { DropdownItem,
 *    DropdownItemType, forcePushIcon } from './push-pull-button'` ⇒ 与 2 同一个阻塞。
 *    这里只复刻**渲染形状**(`.push-pull-dropdown` / `.push-pull-dropdown-item` /
 *    `.text-container > .title + .detail`,即 `styles/ui/toolbar/_push-pull-button.scss`
 *    的类名),不碰状态机。
 * 4. **面板 = foldout 本身**(2026-10 收敛,不再是「锚点 + `.gw-pop` 卡片」):
 *    上游把下拉内容**直接**放进 `.foldout`(`dropdown.tsx:436-443`),而 `.foldout` 是
 *    `position:absolute; top:0; height:100%; marginLeft:rect.left`(`:381-407`),
 *    外层 `#foldout-container` 是 `position:fixed; top:rect.bottom;
 *    height:calc(100% - rect.bottom)`(`:366-379`)⇒ 它天然就是「从工具栏底边铺到视口
 *    底边」的那块面板 —— 这正是 Desktop 仓库下拉的样子(不是浮卡片)。
 *
 *    所以:
 *      · `RepositoryPanel` **去掉 `.gw-pop` 类**(高度契约改为 `height:100%`,写在它自己那段
 *        行内 `<style>` 的第 ① 条里);
 *      · 宽度由本文件的 `foldoutStyleOverrides`(仓库段=实测左栏宽 / 分支段=365px)给,
 *        不再依赖 `pop-width.scss` 的 `.gw-pop{width:var(--gw-pop-width)}`;
 *      · 背景由上游 `ui/_foldout.scss` 给(`--background-color`),层级由
 *        `--foldout-z-index` 给;
 *      · 原先那层**零高度定位锚已删除**(它存在的唯一理由是让 `.gw-pop` 的
 *        `top:calc(100% + 4px)` 落在 4px 上;面板不再是绝对定位卡片就不需要它了)。
 *
 * @module dsh-git/client/toolbar
 */

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ComponentType, CSSProperties, ReactNode } from 'react';

import { Toolbar } from '../core/desktop/ui/toolbar/toolbar.tsx';
import {
  ToolbarDropdown,
} from '../core/desktop/ui/toolbar/dropdown.tsx';
import type { DropdownState, IToolbarDropdownProps } from '../core/desktop/ui/toolbar/dropdown.tsx';
import { ToolbarButton } from '../core/desktop/ui/toolbar/button.tsx';
import type { IToolbarButtonProps } from '../core/desktop/ui/toolbar/button.tsx';
/*
 * ③ 同步段的**真身**:上游 `ui/toolbar/push-pull-button.tsx`(688 行,与上游一致)。
 *
 * 2026-10-06 的换装把这里从「手写的 `renderSyncSegment()` 复刻它的状态机」改成
 * **直接渲染上游组件**。此前不能这么做的阻塞(它 import 的 `../lib/rebase` 与
 * `../../models/fetch` 在我们树里不存在)已经由前置工作消掉:两个文件都字节一致地进了
 * 镜像,`ui/dispatcher/index.ts` 的替身补了它真正调用的 7 个方法,行为由
 * `src/client/sync-dropdown-dispatcher.ts` 的门面接上。
 */
import { PushPullButton } from '../core/desktop/ui/toolbar/push-pull-button.tsx';
import * as octicons from '../core/desktop/ui/octicons/octicons.generated.ts';
import { RepositoryPanel, iconForRepoEntry, repositoryForEntry } from './repo-bar.tsx';
/*
 * 宽度**不再**用 `repo-bar.tsx` 的 `useLeftPaneWidth()`:它量「当前页签的 `.gw-split`」
 * 且只在挂载时装一次观察器,页签一切换那个元素就被卸载 ⇒ 宽度变 0 且**永远回不来**
 * (真 Chrome 实测:Changes 250 → History 117 → 切回 Changes 仍是 117)。新 hook 以
 * **存储值**为真源(Desktop `app.tsx:3921` 的 `clamp(sidebarWidth)` 同模型),
 * 与哪个页签在前面无关。实测表与理由见 `sidebar-width.ts` 的文件头。
 */
import { useSidebarWidth } from './sidebar-width.ts';
/*
 * 同步段宽的**持久化载体**(用户 2026-10-06 裁决:采纳上游「固定 `clamp(230,200,350)`
 * + 可拖拽」)。上游那一半在 `app-store.ts:484/648/6249-6262`;理由与两处有意差别
 * 写在这个文件的文件头。
 */
import { usePushPullButtonWidth } from './push-pull-button-width.ts';
import { BranchDropdownContent } from './branches-view.tsx';
// 能力缺口的提示语(单一真源):`publishRepository` 这一支与 `changes-view.tsx`
// 的空态「发布仓库」共用**逐字同一份**文案,见那个文件的文件头。
import { PUBLISH_REPOSITORY_UNAVAILABLE } from './unsupported-notices.ts';
/*
 * 同步面的**门面**:把宿主能力接到上游 `PushPullButton` 需要的那 7 个方法上
 * (上游经由 `Dispatcher` 与应用层对话;替身只给类型面,行为在这里)。
 */
import { SyncDropdownDispatcher } from './sync-dropdown-dispatcher.ts';
/*
 * 同步面的**读侧投影**:真数据源(进度 / 建议强推表 / tip / 远端名)只有一份判定,
 * 都在 `sync-state.ts`。三个都是上游同名概念的直接等价物:
 * `syncProgressOf` = `IRepositoryState.pushPullFetchProgress`、
 * `networkActionInProgress` = `isPushPullFetchInProgress`、
 * `forcePushBranchStateOf` = `ui/app.tsx:3642` 的 `getCurrentBranchForcePushState(...)`。
 */
import {
  forcePushBranchStateOf,
  networkActionInProgress,
  remoteNameOf,
  syncProgressOf,
  tipOf,
} from './sync-state.ts';
import type { GitStore, Snapshot } from './store.ts';

/* ---------- 1. children 的类型适配(理由见文件头 §1) ---------- */

/** 上游 props + React 18 里必须显式声明的 children。 */
type WithChildren<P> = P & { readonly children?: ReactNode };

/** `toolbar.tsx` 的 `IToolbarProps` 没有导出,这里按上游 :3-5 的两个字段沿用。 */
const ToolbarEl = Toolbar as unknown as ComponentType<{ readonly id?: string } & { readonly children?: ReactNode }>;
const Dropdown = ToolbarDropdown as unknown as ComponentType<WithChildren<IToolbarDropdownProps>>;
const ToolbarBtn = ToolbarButton as unknown as ComponentType<WithChildren<IToolbarButtonProps>>;

/* ---------- 顶栏本体 ---------- */

/** 哪一段的下拉是打开的(上游对应 `FoldoutType.Repository` / `FoldoutType.Branch` / `FoldoutType.PushPull`)。 */
type OpenSegment = 'repository' | 'branch' | 'sync' | null;

/**
 * 绿点(本插件的登录指示,上游顶栏的 `renderAccountToolbarButton()` 占了那个位置)。
 *
 * 上游 `#desktop-app-toolbar` 的 flex 基线是 `align-items` 的初始值 `stretch`
 * (`_toolbar.scss:8-9` 只写了 `display:flex;flex-direction:row`),而这段里其余成员
 * 都是 `.toolbar-button`,它们自己带 `align-items:center`(`_button.scss:89-91`)。
 * 裸 `<span>` 没有那条,所以必须 `alignSelf:'center'` —— 否则它被拉伸对齐到条子**顶边**
 * (探针实测 `y=0,h=8`;居中后 `y=21,h=8`),在 50px 的条子旁边看起来就是「逃到条子上方」。
 */
const GW_DOT_STYLE: CSSProperties = { alignSelf: 'center' };

/**
 * 「零布局」包装层的样式 —— 只给**同步段**那个 `ref` 载体用(见它的注释)。
 *
 * `display:contents` 让这个 `div` **不生成盒子**:它既不是 flex 项、也不参与
 * `#desktop-app-toolbar` 的排版,于是顶栏的几何与「没有这层」逐像素一致。
 *
 * ⚠️ 代价(本轮实测踩到过):**`display:contents` 元素自己的 rect 恒为全 0**
 * (`{left:0,right:0,bottom:0}`)⇒ 拿它当几何参照会静默算出 0。所以凡是要量盒子的
 * 地方,都必须先 `querySelector` 到里面**真正生成盒子**的那个元素
 * (`syncFoldoutOverride` / `menuAnchorElement` 都这么做了)。
 */
const GW_CONTENTS_STYLE: CSSProperties = { display: 'contents' };

/**
 * ⚠️ 动作组容器(`.gw-toolbar-actions`)的布局**不在这里**了 —— 2026-10 第二轮搬到了
 * `src/client/scss/desktop-toolbar.scss` 的 `.gw-toolbar-actions` 那一段
 * (`display:flex` / `align-items:center` / `gap` / `margin-left:auto` / `flex:none`
 * 加上「成员之间没有竖线」与「图标右侧不留死空白」两条)。
 *
 * 搬家的理由不是风格,是**正确性**:`margin-left:auto` 与**同步段**的 `margin-right`
 * 是一对必须一起理解的东西(留白从哪里来 —— 见那个文件里「留白是真实盒子」一段),
 * 拆在两个文件里只会让人看到一半。行内样式还有一个硬问题:它除 `!important` 之外
 * 无法被样式表覆盖,而那两条新要求(去竖线 / 收紧凑)**必须**按作用域覆盖上游配方。
 */

/**
 * 同步段的**身份类** —— 它挂在那层「零布局」包装层上(见 `GW_CONTENTS_STYLE`),
 * 本地的布局覆盖全部以它为锚(规则在 `scss/desktop-toolbar.scss` 末尾那一段,
 * 理由与实测数字写在规则旁边)。
 *
 * ## ⚠️ 2026-10-06 换装后为什么**仍然**需要一个类名,而不是 `:has()`
 *
 * 换装前段根是 `.toolbar-dropdown` 或 `.toolbar-button`(手写的 `renderSyncSegment`
 * 直接渲染它们)。换装后段根变成上游 `Resizable` 的 **`.resizable-component`**
 * (`push-pull-button.tsx:404-433` 恒把按钮包进它),而:
 *   · `PushPullButton` 的 17 个 prop 里**没有** `className`(`:37-111`),
 *     `defaultButtonProps()` / `defaultDropdownProps()` 把类名**写死**成
 *     `'push-pull-button'`(`:246-268`)⇒ 我们**没有**任何注入口能给它加类;
 *   · 那层包装层是我们自己的 DOM,类名挂得上,而且 `display:contents` 不改 DOM 父子关系
 *     ⇒ CSS 的 `>` 仍然成立:`.gw-sync-segment > .resizable-component` 命中段根。
 *
 * 所以身份**留在包装层**,规则落到它里面的段根上。另一个好处是可测:阴性对照
 * (`toolbar-gap-probe.mjs --asis`)仍然是「把这个类从 DOM 上摘掉」——
 * 与上一版同一个机制,不需要 `:has()` 那种没法在 DOM 上撤销的选择器。
 *
 * ## 历史(为什么会先有一个 `.toolbar-dropdown`/`.toolbar-button` 的版本)
 *
 * 上一版只在 **MultiOption 下拉**那一支传了这个类,而同一个函数还有**四条裸
 * `ToolbarButton` 支路**(`busy` / `publish-repository` / `detached` / `fetch`)。
 * 真 Chrome 实测(宿主宽 756 / 侧栏 250 / 插件根 (480,63)):
 *
 * | 形状 | 段根元素 | 上一版有没有这个类 | 结果 |
 * |---|---|---|---|
 * | MultiOption 下拉(`push`) | `.toolbar-dropdown.push-pull-button` | 有 | 宽 **196.52** = 内容宽;空隙 **105.82px** ✅ |
 * | 裸按钮(`fetch`) | `.toolbar-button.push-pull-button` | **没有** | 宽 **363.14**(内容只需 199.38,被拉长 **+163.76**);空隙 **0px** ❌ |
 *
 * 换装后两种形状的段根**统一**是 `.resizable-component` ⇒ 那一类「漏掉一种形状」的
 * 缺陷在结构上消失了。判据与实测表见 `docs/probes/toolbar-gap-probe.mjs`。
 */
const GW_SYNC_SEGMENT_CLASS = 'gw-sync-segment';

/**
 * 同步段 `display:contents` 包装层的元素(模块级;见组件里那段注释的理由)。
 *
 * 只可能在**一个**顶栏实例上非空 —— 本插件的顶栏在界面上只有一个。
 */
let SYNC_DROPDOWN_WRAPPER: HTMLDivElement | null = null;

/** 同步段包装层的 `ref` 回调(模块级,理由见 `SYNC_DROPDOWN_WRAPPER` 的注释)。 */
function setSyncDropdownRef(element: HTMLDivElement | null): void {
  SYNC_DROPDOWN_WRAPPER = element;
}

/** 右侧动作组的元素(模块级;用途与理由同 `SYNC_DROPDOWN_WRAPPER`)。 */
let TOOLBAR_ACTIONS: HTMLDivElement | null = null;

/**
 * 右侧动作组的 `ref` 回调 —— 把组里那个 **kebab 按钮**(不是组容器)交给调用方。
 *
 * 为什么是按钮:`display:contents` 之类不生成盒子的元素 rect 恒为全 0,量错一次就会
 * 让「更多」菜单锚到左上角。这里在**源头**就 `querySelector` 到真正生成盒子的
 * `<button aria-label="更多">`,调用方拿不到错的那个。
 */
function setToolbarActionsRef(element: HTMLDivElement | null): void {
  TOOLBAR_ACTIONS = element;
}

/**
 * 取「更多」菜单的锚点(动作组里的 kebab 按钮;组还没挂上时返回 `null`)。
 *
 * 导出给 `workbench.tsx` 的 `MenuPopover` 用 —— 这样「锚点」只有**一个**真源,
 * 不必经一个 `onMenuAnchor` prop 把元素传来传去
 * (那样每个实例都要一个回调,而回调在组件体里就是一条 `react/jsx-no-bind` 违规)。
 */
export function menuAnchorElement(): Element | null {
  return TOOLBAR_ACTIONS === null ? null : TOOLBAR_ACTIONS.querySelector('button[aria-label="更多"]');
}

/*
 * ==========================================================================
 * ⚠️ 顺序依赖:这个 div 的**类名**必须与 `scripts/styles.mjs` 的 `scope` 一致
 * ==========================================================================
 *
 * 本文件最外层这个 div 是顶栏那一面的**作用域根**,而它的类名**由样式泳道持有**
 * (`scripts/styles.mjs` 的 `PORT_SURFACES` 里 `id:'toolbar'` 的 `scope:`,本文件只读)。
 * 产物里的每一条顶栏规则都被前缀成 `scope 后代`,所以**两边必须同时改**:
 *
 * | 本文件最外层的类 | `styles.mjs` 的 `scope` | 结果 |
 * |---|---|---|
 * | `.gw-toolbar` | `.gw-toolbar` | ✅ 今天的状态 |
 * | `.gw-app-toolbar` | `.gw-toolbar` | ❌ **整面失效**:`#desktop-app-toolbar` 退回 `display:block`、`.toolbar-button` 不再两行、`.foldout` 拿不到背景、`--toolbar-*` 全部 unresolved |
 * | `.gw-toolbar` | `.gw-app-toolbar` | ❌ 同上(静态闸门的 `findUnboundVariables` 会先报一批变量未绑定,产物仍然写出来) |
 *
 * 这个坑**实测发生过一次**(2026-10-06):`scope` 先改、tsx 没跟上,产物里 205 条规则
 * 全部打在 `.gw-app-toolbar` 上,而 DOM 里那个元素数 = **0** ⇒ 整个顶栏没有底色、三个
 * 下拉竖着叠、药丸变方角。**换根这类改动是跨两个所有者的改动**,派活时必须一次说清
 * 「谁先谁后、后一个由谁触发」,或者两边一次改完。
 *
 * 2026-10-06 的**第一步**已经落地:入口 SCSS 用 `&:has(> #desktop-app-toolbar)`
 * 中和了共用类 `.gw-toolbar` 带来的 padding / align / justify / wrap / gap
 * (特异性 (1,1,0) > `styles.ts` 的 (0,1,0)),所以**样式表是唯一真源** ——
 * 本文件**不再**用行内 style 中和包装层(那段 `TOOLBAR_WRAPPER_STYLE` 已删)。
 * 第二步(换成顶栏独占类)落地时,改这里一个词 **并同时** 改 `styles.mjs` 的 `scope`。
 */

export interface WorkbenchToolbarProps {
  readonly store: GitStore;
  readonly snap: Snapshot;
  /**
   * 「更多」菜单(上游顶栏没有这个入口,是本插件的产品面)。
   *
   * ⚠️ 2026-10(用户当面纠正后):它**不再挂在齿轮上**,而是挂在齿轮左边那个
   * **kebab(`⋮`)按钮**上 —— 齿轮改成**直接打开宿主的设置面板**。
   * 菜单内容一个不少(Clone / 刷新 / 抓取 / 拉取 / 推送 / 强推 / 在浏览器打开 /
   * 设置 / dsh-git 偏好设置),用户原话:「那些仓库操作可以放在另一个按钮里」。
   */
  readonly onOpenMenu: () => void;
  readonly onOpenClone: () => void;
  /**
   * 打开**我们自己的** GitHub-Desktop 形状偏好弹窗。
   *
   * 两个用处:① 齿轮拿不到宿主设置控件时的**回退**(绝不允许点了没反应);
   * ② 「更多」菜单里的「dsh-git 偏好设置」项(宿主表达不了账号 / 仓库 / 无障碍三页,
   * 那个入口必须留着 —— 见 `docs/host-settings-card.md` §4)。
   */
  readonly onOpenSettings: () => void;
}

/**
 * 面板宽度(`--gw-pop-width` / `foldoutStyleOverrides`)说明 —— 见文件头 §4。
 *
 * 这里**不再有零高度锚**:面板就是 `.foldout` 的直接子节点(2026-10 改),
 * 所以仓库段的宽度由下面的 `foldoutStyleOverrides` 给,而不是靠 `pop-width.scss`
 * 的 `.gw-pop{width:var(--gw-pop-width)}`(`RepositoryPanel` 已经不是 `.gw-pop`)。
 */

/** 顶栏:三段式(当前仓库 / 当前分支 / 推送)+ 我方的设置与登录指示。 */
export function WorkbenchToolbar(props: WorkbenchToolbarProps): ReactNode {
  const { store, snap } = props;
  const [open, setOpen] = useState<OpenSegment>(null);
  /**
   * 同步段(`MultiOption` 下拉)的 foldout 定位 —— **触发按钮相对插件根**的偏移与面板宽。
   *
   * 为什么必须是**量出来的**:上游 `dropdown.tsx:401` 给的是 `marginLeft: rect.left`,
   * 而 `rect.left` 是**视口**坐标;我们的 `#foldout-container` 被
   * `scss/desktop-toolbar.scss` 重新锚到**插件根**(`left:0 !important`)——
   * 两个坐标系差一个「插件根左边界」。实测(宿主宽 620):面板 x=0、chevron x=437.56,
   * 差 **−437.56px**;宿主宽 900 时差 **−572px**(数字见 `docs/probes/menu-anchor-probe.mjs`)。
   *
   * 修法:量出按钮相对插件根的偏移,三段都把它写成**插件根相对**的 `left`。
   * `rect.left - toolbarRect.left` 对「插件根在视口哪里」不敏感 —— 这是三段共同的契约。
   * ⚠️ 2026-10 第二次修正前这里回填的是 `marginLeft`,而 SCSS 那条
   * `margin-left:0 !important` 会把它**静默**清零 ⇒ 同步段的面板一直贴在插件根左边缘。
   *
   * ⚠️ **2026-10-06 换装后三段的载体不再统一**:仓库段 / 分支段仍走
   * `foldoutStyleOverrides.left`(那两个段渲染的是我们直接控制的 `ToolbarDropdown`),
   * 而同步段渲染的是上游 `PushPullButton` —— 它的 props 里**没有**
   * `foldoutStyleOverrides`(逐条理由见下面 effect 的文档注释),所以同步段改成把
   * `left` **写成 `.foldout` 的行内属性**。两者的真源仍是同一个
   * `syncFoldoutOverride()` / 同一个语义(「段左缘相对插件根左缘」)。
   */
  /*
   * ⚠️ 同步段的触发元素**存在模块级持有者里**(`SYNC_DROPDOWN_WRAPPER`),不在组件体里
   * `useRef`:本文件里的 `useLayoutEffect` 要用它,而那个 effect 的依赖数组必须稳定 ——
   * 走模块级引用就不必把 ref 对象塞进依赖,也不会因为组件重渲染换对象。
   *
   * ⚠️ 挂它的回调也**定义在模块级**(不在组件体里写箭头函数):`react/jsx-no-bind`
   * 会把「BlockStatement 里用 `const` 绑定的函数」与「行内箭头函数」都登记成违规名,
   * 而本仓棘轮基线里 `toolbar.tsx` 的 `jsx-no-bind` 是 12 条存量 —— 新增一条就超基线。
   * 模块级函数不进那张表(rule 的 visitor 都要求 `blockAncestors.length > 0`)。
   */
  /*
   * 仓库段与仓库下拉面板的宽度。真源是 `dsh-git.sidebar-width`(两个页签的
   * `useSplitWidth()` 共用同一个键),所以**切页签不会改变它** —— 这正是修掉用户报的
   * 「点 Changes / History 切换时 header 的当前仓库宽度有问题」的那一处。
   * `0` = 还没量到可用宽 ⇒ 不写行内 width(回落内容宽)。
   */
  const panelWidth = useSidebarWidth();
  /*
   * 同步段宽度的**持久化载体**(用户 2026-10-06 裁决:采纳上游的固定宽 + 可拖拽)。
   * 这两个 handler 交给门面,门面再交给上游 `PushPullButton` 的
   * `onResize` / `onReset`(`push-pull-button.tsx:374-384`)—— 上游
   * `resizable.tsx:31-32` 明写「本组件是纯的,消费者必须订阅并更新 width prop」,
   * 传空函数的结果是「手柄能拖、松手弹回」。
   */
  const pushPullButtonWidth = usePushPullButtonWidth();

  const entryIndex = snap.repos.findIndex((entry) => entry.path === snap.current);
  const currentEntry = entryIndex >= 0 ? snap.repos[entryIndex] : undefined;
  const signedIn = snap.auth?.signedIn === true;

  const repoTitle =
    currentEntry !== undefined
      ? currentEntry.alias ?? currentEntry.name
      : snap.current !== ''
        ? snap.current.split('/').filter(Boolean).pop() ?? snap.current
        : snap.repos.length > 0
          ? '选择仓库'
          : '还没有仓库';

  const state = (segment: Exclude<OpenSegment, null>): DropdownState =>
    open === segment ? 'open' : 'closed';
  const onStateChanged =
    (segment: Exclude<OpenSegment, null>) =>
    (next: DropdownState): void => {
      setOpen(next === 'open' ? segment : null);
    };

  /**
   * foldout 的宽度与**水平位置**:上游 `ui/app.tsx:3521` 是
   * `const foldoutWidth = clamp(this.state.sidebarWidth)` —— 同一个**存储值**,
   * 所以面板与段宽**逐像素一致**且与页签无关。
   *
   * `left: 0` 是**插件根相对**的偏移(仓库段就是顶栏第一个段,结构上它的左边缘 = 插件根左边缘)。
   * 为什么必须显式给:上游行内那个 `marginLeft: rect.left` 是**视口**坐标,已被
   * `scss/desktop-toolbar.scss` 的 `#foldout-container > .foldout{margin-left:0 !important}`
   * 清零 ⇒ 面板的水平位置**只能**由这里的 `left` 决定。三段一律如此(仓库段 0 / 分支段 = 段宽 /
   * 同步段 = 量出来的偏移),这样「被压掉的值」与「生效的值」永远不在同一个属性上。
   */
  const repoFoldout: CSSProperties | undefined =
    panelWidth > 0 ? { left: 0, width: panelWidth, minWidth: panelWidth, maxWidth: panelWidth } : undefined;

  const close = (): void => setOpen(null);

  /*
   * 同步段的 foldout 定位:打开的那一刻量一次触发按钮相对**顶栏**的偏移。
   *
   * ## 为什么是 `requestAnimationFrame`,不是同步量(这条有实测依据)
   *
   * 第一版在 `useLayoutEffect` 里**同步**量,拿到的却是**陈旧的盒子**:
   * 真 Chrome、宿主宽 620 下,同一个节点(用 `data-gw-sync-trigger` 标记核对过是同一个)
   * 在提交阶段量到 `width=209.8125`,**下一帧**量到 `width=142.28125` —— 差 67.53px。
   * 而面板宽度就直接写成了 209.81,右边缘越过段尾 41.63px。
   *
   * 试过两条同步的补救都没用(两条都实测过):
   *   · `void toolbar.offsetWidth` 强制重排后再量 —— **仍然是 209.8125**;
   *   · 换 `document.body` / 顶栏自己的 rect 做参照 —— 同样陈旧。
   *
   * 所以位置改成**下一帧**量:`requestAnimationFrame` 的回调在**绘制之前**跑。
   * 上游 `dropdown.tsx:354-360` 用 class 组件的 `componentDidMount/Update` +
   * `setState` 也是「提交之后再量」,与本条同一族做法。
   *
   * 只有 `open === 'sync'` 才量:那正是 `.foldout` 存在的时刻
   * (`dropdown.tsx:416-419` 在 `dropdownState !== 'open'` 时返回 null),量不到就
   * **什么都不写** ⇒ 退回上游原来的定位,不写任何错的值。
   *
   * ## ⚠️ 2026-10-06 换装后的改动:载体从 prop 变成**行内 `left`**
   *
   * 换装前这一段的落点是 `setSyncFoldout(computed)` → `foldoutStyleOverrides` prop。
   * 换装后这条 prop **传不进去了**:`PushPullButton` 的 17 个 prop 里没有
   * `foldoutStyleOverrides`(`push-pull-button.tsx:37-111`),它内部
   * `<ToolbarDropdown {...this.defaultDropdownProps()}>`,而
   * `defaultDropdownProps()`(`:254-268`)也不含这个字段 ⇒ 同步段的面板只能拿到
   * `dropdown.tsx:381-407` 的上游默认值(`marginLeft: rect.left` + `width: rect.width`),
   * 而 `scss/desktop-toolbar.scss` 的 `#foldout-container > .foldout{margin-left:0 !important}`
   * 会把那个**视口坐标**清零 ⇒ 面板回到插件根左边缘(宿主宽 620 时差约 437px)。
   *
   * 所以这里直接把量出来的偏移写成 `.foldout` 的**行内 `left`** —— 与仓库段/分支段
   * 走 `foldoutStyleOverrides.left` 是**同一个语义、同一个真源**(`syncFoldoutOverride()`),
   * 只是载体不同。
   *
   * **为什么 `left` 是空着的**(逐条核对过,不是假设):
   *   · `dropdown.tsx:381-407` 的 `getFoldoutStyle()` 只写
   *     `position/marginLeft/top/maxHeight|height/width` + overrides —— **没有 `left`**;
   *   · `src/client/scss/upstream/ui/_foldout.scss:19-22` 对 `.foldout` 只写
   *     `background` / `color`;
   *   · 本仓 SCSS 对 `.foldout` 只有那一条 `margin-left: 0 !important`
   *     (`desktop-toolbar.scss`,grep 过全仓:没有第二处写 `left`)。
   *
   * **失效窗口**:`left` 是行内属性,React 只在自己那批 style props 变化时改写它,
   * 而 `.foldout` 的 style props 在量测完成后不变 ⇒ 不会被覆盖。重新打开(切段)会
   * 再跑一次本 effect;窗口尺寸变化时面板宽度由上游自己的 `updateClientRectIfNecessary`
   * 跟随,而 `left` 是「段相对顶栏的偏移」,只有段自身位置变才需要复量(与换装前同一档)。
   */
  useLayoutEffect(() => {
    if (open !== 'sync') {
      return;
    }
    /*
     * 为什么**连续两帧**:
     *  ① 第一帧只**标记**那个触发元素(`data-gw-sync-trigger`)—— 让探针能证明
     *     「提交阶段量与稳定后量量的是同一个节点」。这是本条排障的关键证据:
     *     第一版把陈旧盒子当成了真值,还以为「量错了元素」。
     *  ② 第二帧**才量**并写回。提交阶段量到的是陈旧盒子(实测 209.8125),
     *     稳定值是 142.28125。
     *
     * 为什么不一次 rAF 就够:第一帧的 rAF 仍然可能落在布局尚未稳定的窗口里
     * (实测过 209.8125 会在 rAF 的第一帧里再出现一次)。两帧是**实测选出来的最小
     * 稳定值**,不是随手写的常数。
     */
    let marked: Element | null = null;
    /*
     * ⚠️ 触发元素的选择器变了:换装后段根是 `.resizable-component`,里面才是上游的
     * `.toolbar-dropdown`。仍然量 `.toolbar-dropdown`(`syncFoldoutOverride` 用的是
     * **面板要对齐的那个盒子** = 段根,它取 `.toolbar-dropdown` 优先、否则第一个子元素
     * —— 见那个函数)。这里保持一致:`Resizable` 的盒子与 `.toolbar-dropdown` 同宽
     * (后者是前者的唯一子盒),量哪一个都得到同一个 left。
     */
    const triggerSelector = '.resizable-component, .toolbar-dropdown, .toolbar-button';
    const first = requestAnimationFrame(() => {
      const wrapper = SYNC_DROPDOWN_WRAPPER;
      marked = wrapper === null ? null : wrapper.querySelector(triggerSelector);
      marked?.setAttribute('data-gw-sync-trigger', '1');
    });
    const second = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const wrapper = SYNC_DROPDOWN_WRAPPER;
        const trigger = wrapper === null ? null : wrapper.querySelector(triggerSelector);
        const computed = syncFoldoutOverride(wrapper, document.querySelector('#desktop-app-toolbar'));
        /*
         * 落点:**给 `.foldout` 写行内 `left`**(理由见本 effect 的文档注释)。
         * 面板此刻还没渲染出来时不写 —— 不猜。
         */
        const panel = wrapper === null
          ? null
          : wrapper.querySelector<HTMLElement>('#foldout-container > .foldout');
        const applied = panel === null || computed === null ? null : panel.style.left;
        if (panel !== null && computed !== null) {
          panel.style.left = `${computed.left}px`;
        }
        /* 诊断(探针读它):量到的到底是哪个元素、算出了什么、写进去了什么。 */
        (window as unknown as { __GW_SYNC_FOLDOUT__?: unknown }).__GW_SYNC_FOLDOUT__ = {
          wrapperDisplay: wrapper === null ? null : getComputedStyle(wrapper).display,
          triggerSameAsMarked: trigger !== null && trigger === marked,
          trigger: trigger === null ? null : { className: trigger.className, rect: trigger.getBoundingClientRect().toJSON() },
          computed,
          panelFound: panel !== null,
          appliedBefore: applied,
          appliedAfter: panel === null ? null : panel.style.left,
        };
      });
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [open]);

  /*
   * ⚙ = **直接打开我们自己的「dsh-git 偏好设置」弹窗**(2026-10 用户明确指令:
   * 「【设置】按钮**不要**打开宿主设置页面了,直接打开【dsh-git 偏好设置】那个弹窗吧」)。
   *
   * ## 改前 / 改后(只动这一个调用点)
   *
   * 改前:先 `openHostSettings()` —— 驱动**宿主自己渲染的**设置控件(点它的按钮 /
   * 菜单项 ⇒ 走它自己的 `onClick`),拿不到才回退 `props.onOpenSettings()`。
   * 改后:**直接**用原来那条回退分支。`openHostSettings()` 在本文件里的这个调用点
   * 与它的 import 一起删掉(留着就是未使用的 import)。
   *
   * ## 为什么 `./host-settings-open.ts` 与它那套 DOM 驱动**一个字节都没删**
   *
   * 它仍然是「打开宿主设置入口」这件事的**唯一**实现。⚠️ 2026-10 更正下面这一句:
   * 「更多」菜单里那一项「设置(⌘,)」**已按用户指令移除**(见 `workbench.tsx` 的
   * `MenuPopover` 头注释),所以 `openHostSettings()` **今天在 `src/**` 里没有调用点**了
   * —— 这是**如实记账**,不是「它还在被使用」。模块本身与它的 4 条候选通路证据链
   * (`docs/host-settings-card.md` §1)照旧保留,宿主的设置面板仍可从宿主的侧栏/账号菜单进入。
   *
   * **可回收条件**:若哪天要让齿轮改回开宿主设置,把本函数体换回
   * `void openHostSettings().then((result) => { if (result === 'unavailable') { props.onOpenSettings(); } })`
   * 并补回上面那一行 import 即可 —— 那一版逐字保存在 `docs/host-settings-card.md` §1.4。
   * (要不要回滚由产品决定,不由代码结构决定。)
   *
   * ## tooltip 为什么**不再带宿主键位**(这是同一处改动的必然结果,不是顺手改样式)
   *
   * 改前 tooltip 读 `hostSettingsShortcutKeys()`(宿主 `settings.open` 命令的 `⌘,`)写成
   * 「设置(⌘,)」。那个快捷键按下去触发的**仍然是宿主自己的设置面板**(它由宿主
   * `ui-settings-general` 的快捷键命令实现,我们既没改也改不了),而本按钮现在打开的是
   * **我们自己的弹窗** ⇒ 留着那串键位就是一条**会骗人的提示**(按提示按键得到另一个界面)。
   * 我们自己的弹窗今天**没有**快捷键可写(也没有注册快捷键的席位),所以只写「设置」。
   * ⇒ 宁可少写一段提示,也不留一条对不上的。
   */
  const onSettingsClick = (): void => {
    props.onOpenSettings();
  };
  /* tooltip 只写「设置」—— 理由见上(宿主键位 ≠ 本按钮现在的行为)。 */
  const settingsTooltip = '设置';

  /*
   * ⚠️ 这里原来有两个**局部**实现:`openInBrowser`(外链)与一个内联的刷新回调,
   * 服务于顶栏上那两个 `ToolbarBtn`。2026-10 按用户要求**把两个按钮收进了「更多」菜单**,
   * 于是它们的能力搬到了 `src/client/workbench.tsx` 的 `MenuPopover`:
   *   · 外链:菜单项「在浏览器打开仓库」,`remote` 从 `currentEntryOf(snap)` 取,
   *     `remote === ''` 时 `disabled`;
   *   · 刷新:菜单项「刷新状态与历史」,`store.refreshAll()`,`busy` 时 `disabled`。
   * **不跨文件传函数**(MenuPopover 自己就能从 `store` / `snap` 拿到这两样),
   * 所以这两个局部实现连同它们的 `remoteForLink` 一起删除 —— 留着就是死代码,
   * 而且会让「能力的真源」变成两处。
   *
   * 顺带记一笔**没有**复刻的东西:参照实现
   * `references/dsh-github-workbench/src/workbench.tsx:277` 的 `private` 徽标与
   * `:289-296` 的收件箱计数角标 —— 缺数据源,不画点了/看着没反应的假控件
   * (缺什么见 `docs/host-settings-card.md` §7)。
   */

  /**
   * 「发布仓库」按钮的点击 —— 上游 `ui/toolbar/push-pull-button.tsx:527-539` 的
   * `publishRepositoryButton` 在 Desktop 里会打开 `ui/publish-repository/**`
   * (建库向导:仓库名 / 描述 / 私有公开 / 组织 / 首提交),而浏览器半**没有**那条通路:
   * `src/host/**` 没有 `publishRepository` 路由,2026-10 本次改动时
   * `src/client/api.ts` 里也**没有** `api.publishRepo`(逐字核对过,报告里写明)。
   *
   * ⚠️ **换装后这条必须走门面的 `push`,不能再挂在自己的回调上**:
   * 上游那个按钮的 `onClick` 就是 `this.push`(`:455`),而 `push` 是私有方法
   * `push = () => { this.closeDropdown(); this.props.dispatcher.push(repository) }`
   * (`:274-277`)—— **没有**第二条「发布」通路。所以这里把能力挂到
   * `SyncDropdownDispatcher` 的 `push` 上:`remotes.length === 0` 时给这条 toast 并
   * return,否则 `store.push(false)`。不这么做的话:
   *   · 上游按钮点下去会去推一个**没有远端**的仓库(host 会回 `no-upstream` 错),
   *     而 `PUBLISH_REPOSITORY_UNAVAILABLE` 变成**死代码**。
   *
   * 可回收条件:host 出现 `publishRepository` 路由(`api.publishRepo`)后,把下面那个
   * 分支换成真实调用 + 成功/失败 toast,并删掉 `unsupported-notices.ts` 的
   * `PUBLISH_REPOSITORY_UNAVAILABLE`。
   *
   * 这一段**不再单独定义一个回调**、而是直接写在门面的 `push` 里:那个回调只被
   * `useMemo` 的依赖数组引用,而它在组件体里每次渲染都换引用 ⇒ 门面**每帧重建**,
   * 上游组件的 props 引用跟着变(白重渲染)。写进 `push` 之后依赖只剩
   * `store` / `remotes.length` / 两个稳定 handler。
   */
  /*
   * 同步面的门面:`PushPullButton` 只经由 `Dispatcher` 的 7 个方法与外部对话,
   * 这里把宿主能力逐条接上(与 History 面的 `HistoryDispatcher` 同形)。
   */

  /*
   * **「按钮文案」与「拉取动作」必须是同一个值** —— 上游的做法与我们这里的对应关系:
   *
   * | 上游 | 这里 |
   * |---|---|
   * | `ui/app.tsx:3630` 从 `branchesState` 解构出 `pullWithRebase` | `snap.sync.pullWithRebase`(宿主 `syncState` 的唯一一次读取) |
   * | `:3666` 传进 `PushPullButton`(决定文案) | 下面那个 `pullWithRebase` prop(**同一个字段**) |
   * | `push-pull-button.tsx:497` 把 `pullWithRebase \|\| false` 交给 `pullButton` 的 `onClick` | 这里把同一个值交给 `store.pull(...)`,再随 `api.pull` 回到宿主**覆盖**它自己的读取 |
   *
   * 用一个**可变盒子**而不是把值并进 `useMemo` 的依赖:门面必须保持稳定引用,
   * 否则每次快照更新都会换一个新 `Dispatcher` 实例、`PushPullButton` 白白重渲染
   * (那条理由写在上面 `push` 的注释里)。盒子在每次 render 时被刷新,所以点击时读到的是
   * **当前正在显示的那份** `snap` —— 这比「点击时冻结一个旧值」更正确:
   * 下拉里的值来自上一帧,而上一帧正是用户看到文案的那一帧。
   *
   * ⚠️ **2026-10 修正:这个盒子必须是真正的 `useRef`,不能是每次渲染新建的普通对象。**
   *
   * 改前写的是 `const pullWithRebaseRef: { current: boolean | undefined } = { current: undefined }`
   * —— 一个**普通字面量对象**。它在组件体里每次渲染都换身份,而 `pullWithRebaseRef` 进了
   * 下面 `useMemo` 回调的闭包 ⇒ `react-hooks/exhaustive-deps` 报
   * 「missing dependency: 'pullWithRebaseRef'」。那条报错在这里是**在理的**:
   * 它是一个被闭包捕获的**每次渲染都可能不同的值**,规则分不清「故意要最新的」还是「写漏了」。
   *
   * 用 `useRef` 之后两件事同时成立:
   *   · `.current` 仍然每次渲染被刷新(语义与改前**逐字相同**);
   *   · ref **对象本身**是跨渲染稳定的 ⇒ `exhaustive-deps` 认可它,不必进依赖数组,
   *     所以门面仍然**每帧都不重建**(这是上面那条「不能并进依赖」的理由要守的东西)。
   *
   * 换句话说:这不是「给规则让路」,而是把「这个盒子跨渲染稳定」从**注释里的约定**
   * 变成**类型能表达的承诺** —— 改前那句注释说的稳定性,代码里其实并不成立。
   */
  const pullWithRebaseRef = useRef<boolean | undefined>(undefined);
  pullWithRebaseRef.current = snap.sync?.pullWithRebase;

  const syncDispatcher = useMemo(
    () => new SyncDropdownDispatcher({
      closeFoldout: () => { setOpen(null); },
      push: () => {
        if ((snap.sync?.remotes.length ?? 0) === 0) {
          store.toast(PUBLISH_REPOSITORY_UNAVAILABLE, 'err');
          return;
        }
        void store.push(false);
      },
      /*
       * `store.pull` 收到的是 `snap.sync?.pullWithRebase` —— **与文案同一个字段**
       * (`undefined` 时它省略该参数,宿主自己读配置;那正是「没配置」的意思)。
       *
       * `_repository` 用不上:动作一律落在 `store` 当前选中的那个仓库上
       * (`store.pull` 内部读 `this.state.current`),与其余 6 个 handler 同形。
       */
      pull: (_repository) => { void store.pull(pullWithRebaseRef.current); },
      fetch: () => { void store.fetch(); },
      // 上游 `confirmOrForcePush`(`dispatcher.ts:2608`)在浏览器半没有「确认弹窗」
      // 那一步(我们没有那个偏好项)⇒ 直接 `--force-with-lease`,与「更多」菜单里的
      // 强推项**同一个调用**,不新增能力。理由与可回收条件见
      // `src/client/sync-dropdown-dispatcher.ts` 的文件头缺口 2。
      confirmOrForcePush: () => { void store.push(true); },
      setPushPullButtonWidth: pushPullButtonWidth.setWidth,
      resetPushPullButtonWidth: pushPullButtonWidth.resetWidth,
    }),
    [store, snap.sync?.remotes.length, pushPullButtonWidth.setWidth, pushPullButtonWidth.resetWidth],
  );

  return (
    <div className="gw-app-toolbar tooltip-host">
      <ToolbarEl id="desktop-app-toolbar">
        {/* ① 当前仓库 —— 上游 `ui/app.tsx:3536-3549` 的 <div className="sidebar-section"> */}
        <div className="sidebar-section" style={panelWidth > 0 ? { width: panelWidth } : undefined}>
          <Dropdown
            icon={iconForRepoEntry(currentEntry, entryIndex)}
            title={repoTitle}
            /* §11.9 的本地化:上游这里是 `__DARWIN__ ? 'Current Repository' : 'Current repository'`,
               而那是**调用点的 description prop** ⇒ 我们这层直接给中文,镜像一个字不用改。 */
            description="当前仓库"
            tooltip={currentEntry !== undefined && open !== 'repository' ? currentEntry.path : undefined}
            dropdownState={state('repository')}
            onDropdownStateChanged={onStateChanged('repository')}
            dropdownContentRenderer={() =>
              open === 'repository' ? (
                /*
                 * **直接**作为 `.foldout` 的子节点(上游 `dropdown.tsx:436-443` 就是这么渲染
                 * `dropdownContentRenderer()` 的返回值)。原先那层「零高度定位锚」是给
                 * `.gw-pop` 卡片的 `top:calc(100% + 4px)` 用的,面板改回「foldout 即面板」
                 * 之后它就是多余的一层,已删(理由见文件头 §4)。
                 */
                <RepositoryPanel
                  store={store}
                  snap={snap}
                  onClose={close}
                  onOpenClone={props.onOpenClone}
                />
              ) : null
            }
            foldoutStyleOverrides={repoFoldout}
          />
        </div>

        {/* ② 当前分支 —— 上游 `ui/toolbar/branch-dropdown.tsx:200-262` 的 ToolbarDropdown。
            面板内容走上游 `ui/branches/**`(`BranchList` + `renderDefaultBranch` + `groupBranches`,
            见 `src/client/branches-view.tsx`)。
            ⚠️ 上游的 `BranchesContainer`(Branches / Pull requests 两个页签)今天接不上:
            它要 `ui/check-runs/**` + `ui/pull-request-quick-view.tsx` + `lib/ci-checks/**`,
            而那三个面还没有镜像;缺口清单见交付说明。⭐ 上游的 `BranchDropdown` 本体
            (`ui/toolbar/branch-dropdown.tsx`)也因此**不可达** —— 它的 `description` 是
            文件内局部变量,所以今天的标签由我们这层给(中文,§11.9)。 */}
        <Dropdown
          icon={snap.status?.detached === true ? octicons.gitCommit : octicons.gitBranch}
          title={
            snap.status?.detached === true
              ? `位于 ${(snap.status.headSha ?? '').slice(0, 7)}`
              : snap.status?.branch !== undefined && snap.status.branch !== ''
                ? snap.status.branch
                : '—'
          }
          description={snap.status?.detached === true ? '分离头' : '当前分支'}
          tooltip={snap.status?.detached === true ? '当前处于分离头状态' : (snap.status?.branch ?? undefined)}
          dropdownState={state('branch')}
          onDropdownStateChanged={onStateChanged('branch')}
          disabled={snap.current === ''}
          /*
           * 浮层宽度 = 上游 `BranchesContainer` 的宽度契约:
           * `styles/ui/_branches.scss:5` 的 `width: 365px`,而 Desktop 传的是
           * `{width: branchDropdownWidth.value, maxWidth: max, minWidth: 365}`
           * (`ui/toolbar/branch-dropdown.tsx:245-249`)。我们不做可拖拽宽度,
           * 就固定 365;不给上限的话 `#foldout-container` 是 `width:100%`(视口宽),
           * 浮层的背景会横铺整个窗口(见交付说明里样式表项的 `#foldout-container` 一条)。
           *
           * `left` = **本段左边缘相对插件根左边缘**的偏移,也就是仓库段(它前面唯一一段)的
           * **外框宽** —— 与 `.sidebar-section` 的行内 `width` 同源(`useSidebarWidth()`),
           * 不是第二次量出来的数字。为什么要给:上游行内是 `marginLeft: rect.left`
           * (**视口**坐标),而它被 SCSS 的 `margin-left:0 !important` 清零 ⇒ 不给 `left`
           * 面板就会落在插件根左边缘,与自己的按钮差整整一个仓库段宽
           * (真 Chrome 实测:宿主宽 755 / 侧栏 250 / 插件根 x=480 时,改前面板 x=1200、
           * 段 x=730;**改后 730**,差 0)。同一个坑在同步段那次也踩过,见 `syncFoldoutOverride`。
           */
          foldoutStyleOverrides={{ left: panelWidth, width: 365, minWidth: 365, maxWidth: 365 }}
          dropdownContentRenderer={() =>
            open === 'branch' ? <BranchDropdownContent store={store} snap={snap} onClose={close} /> : null
          }
        />

        {/*
         * ③ 推送/拉取 —— **上游 `ui/toolbar/push-pull-button.tsx` 本体**(2026-10-06 换装)。
         *
         * ## 外面这层包装层是什么、为什么还在
         *
         * 它有两个用处,都与「上游组件不接受 className / 定位 prop」有关:
         *  1. `ref` 载体(`setSyncDropdownRef`):面板的水平偏移要**量**,量的是
         *     「段左缘相对顶栏左缘」;而 `PushPullButton` 没有注入口把它传进去,
         *     所以量出来的值由 `useLayoutEffect` 写成 `.foldout` 的行内 `left`
         *     (逐条理由在那个 effect 的文档注释里)。
         *  2. **身份类** `gw-sync-segment`:本地布局覆盖(`margin-right` 地板留白、
         *     去竖线、允许收缩)全部以它为锚。`PushPullButton` 的 17 个 prop 里没有
         *     `className`,而那层包装层是我们自己的 DOM ⇒ 类名挂这里,
         *     规则用 `>` 落到里面的段根 `.resizable-component`(理由见
         *     `GW_SYNC_SEGMENT_CLASS` 的文档注释)。
         *
         * 包装层零布局(`display:contents`),所以它不影响任何几何 —— 它的两个子节点
         * (`.resizable-component` 与 `span#push-pull-button-state`)直接成为
         * `#desktop-app-toolbar` 的 flex 项(与上游 `ui/app.tsx` 里的那一份同构)。
         *
         * ## props 逐条对上游 `ui/app.tsx:3610-3680` 的 `renderPushPullToolbarButton()`
         *
         * | prop | 上游 | 我们 |
         * |---|---|---|
         * | `aheadBehind` | `state.aheadBehind` | `snap.sync`(null = 没有 tracking branch,与上游同义) |
         * | `remoteName` | `:3620-3633` 那一段判定 | `remoteNameOf(snap)`(**同一个**判定,也是进度标题的真源) |
         * | `networkActionInProgress` | `state.isPushPullFetchInProgress` | `networkActionInProgress(snap)`(**本次新增的真数据源**) |
         * | `lastFetched` | `state.lastFetched`(Date) | `snap.sync.lastFetchedAt`(ISO ⇒ `new Date`) |
         * | `progress` | `state.pushPullFetchProgress` | `syncProgressOf(snap)`(**本次新增的真数据源**) |
         * | `tipState` | `tip.kind` | `tipOf(snap).kind`(四态一一对应) |
         * | `rebaseInProgress` | `conflictState.kind === 'rebase'` | `snap.status.operation === 'rebase'`(host 读 `.git/rebase-*`) |
         * | `forcePushBranchState` | `getCurrentBranchForcePushState(branchesState, aheadBehind)` | `forcePushBranchStateOf(snap)`(**同一个镜像函数**,含 `Recommended`) |
         * | `askForConfirmationOnForcePush` | 应用偏好 | 我们没有那个偏好项 ⇒ 恒 `false`(与上游默认一致;代价是下拉里会显示警告段,更保守) |
         * | `enableFocusTrap` | `currentPopup === null` | 浏览器半没有弹窗栈 ⇒ 恒 `true` |
         * | `shouldNudge` | 引导教程步 | 引导教程面未注册 ⇒ 恒 `false` |
         * | `pushPullButtonWidth` | `state.pushPullButtonWidth` | `usePushPullButtonWidth()`(localStorage + clamp 的持久化载体) |
         * | `pullWithRebase` | `branchesState.pullWithRebase`(`ui/app.tsx:3630` → `:3666`) | `snap.sync.pullWithRebase` —— 宿主 `syncState` 读出**生效**的 `git config pull.rebase`(`git-service.ts` 的 `readPullWithRebase`,四路判定对齐上游 `git-store.ts:454-466`),经 `api.ts` 的 `sync-state` 形状、`Snapshot.sync` 一路到这里。**同一个值**同时决定文案(`push-pull-button.tsx:615-617`)与拉取参数(我们这层的 `store.pull(...)` ⇒ `api.pull` 的 `rebase` ⇒ `git-service.ts` 的 `pull(opts.rebase)`),对应上游 `:497` 的 `pullWithRebase \|\| false` |
         *
         * ⚠️ **没有当前仓库时整段不渲染**:上游 `ui/app.tsx:3604-3607` 在
         * `selection.type !== SelectionType.Repository` 时直接 `return null`,
         * 而不是传一个假仓库进去。这里同形(下面那个三元)。
         */}
        {currentEntry !== undefined ? (
          <div className={GW_SYNC_SEGMENT_CLASS} style={GW_CONTENTS_STYLE} ref={setSyncDropdownRef}>
            <PushPullButton
              dispatcher={syncDispatcher}
              repository={repositoryForEntry(currentEntry, entryIndex)}
              aheadBehind={snap.sync === null ? null : { ahead: snap.sync.ahead, behind: snap.sync.behind }}
              numTagsToPush={snap.sync?.tagCount ?? 0}
              remoteName={remoteNameOf(snap)}
              lastFetched={snap.sync?.lastFetchedAt == null ? null : new Date(snap.sync.lastFetchedAt)}
              networkActionInProgress={networkActionInProgress(snap)}
              progress={syncProgressOf(snap)}
              tipState={tipOf(snap).kind}
              rebaseInProgress={snap.status?.operation === 'rebase'}
              forcePushBranchState={forcePushBranchStateOf(snap)}
              shouldNudge={false}
              isDropdownOpen={open === 'sync'}
              askForConfirmationOnForcePush={false}
              onDropdownStateChanged={onStateChanged('sync')}
              enableFocusTrap={true}
              pushPullButtonWidth={pushPullButtonWidth.value}
              /* 与门面的 `pull` 读的是**同一个** `snap.sync?.pullWithRebase`(见那个盒子)。 */
              pullWithRebase={snap.sync?.pullWithRebase}
            />
          </div>
        ) : null}

        {/*
         * ④ 我方的动作按钮组(上游顶栏没有这一组,是本插件的产品面)。
         *
         * ## 顺序与成员(2026-10 用户当面纠正)
         *
         * 用户原话:「这些按钮应该放一个格子里,在【推送到 origin | v】按钮右边留空白,
         * 然后才是这些按钮……【在浏览器中打开当前仓库】、【刷新】收进【更多】里。
         * 排序改为:【登录状态】【设置】【更多】」。
         *
         * ⇒ 成员 = **绿点(登录状态) → ⚙ 设置 → ⋮ 更多**;
         *    原来的 `octicons.linkExternal`(外链)与 `octicons.sync`(刷新)两个
         *    `ToolbarBtn` **已删除**,能力**逐字保留**在「更多」菜单里
         *    (`workbench.tsx` 的 `MenuPopover`:「在浏览器打开仓库」/「刷新状态与历史」,
         *    各自的 `disabled` 条件也在那里 —— 外链在 `remote === ''` 时禁用、
         *    刷新在 `busy` 时禁用)。
         *
         * ⚠️ **更正一条已经过时的注释**(旧版这里写着「齿轮是**最右**那个动作按钮,
         * 正是用户说的『右上角的设置』」):**最右现在是 kebab(⋮)**。用户那条语义
         * 没有变 —— ⚙ 仍然**直接弹出设置弹窗**(`onSettingsClick`),不是菜单。
         * (2026-10 第二轮更正:**弹的是我们自己的**「dsh-git 偏好设置」,**不是**宿主的
         * 设置面板 —— 理由与可回收条件写在 `onSettingsClick` 上面那一段。
         * 宿主设置面板的入口在「更多」菜单的「设置(⌘,)」那一项,`workbench.tsx:532`。)
         *
         * ## 为什么是「一个 flex 包裹 + `margin-left:auto`」,不是「空占位 + 组外按钮」
         *
         * 两种都能做出「同步段与这组按钮之间留白、这组靠最右」:
         *   (a) 中间插一个 `flex:1` 的空占位元素;
         *   (b) 把这组包进一个 `display:flex` 的 div,并给它 `margin-left:auto`。
         *
         * 选 (b),两条理由:
         *  1. **用户要的是「一个格子」**(原话)。包裹元素本身就是那个格子,同时解决
         *     「成组」与「靠最右」两件事;(a) 只解决后者,按钮之间仍然没有共同的盒子;
         *  2. `margin-left:auto` 的正确性依赖 flex 的**自动外边距**语义:它吸收掉
         *     主轴上的全部剩余空间 ⇒ 组被推到最右,且**不需要**额外插入一个
         *     只为了撑开的元素(少一个 DOM 节点、少一处可能被别的规则改宽的地方)。
         *
         * ⚠️ **2026-10 第二轮实测更正 —— `margin-left:auto` 单独**做不出留白**。**
         * 自动外边距分配的是**自由空间的正数部分**:弹性行一旦放不下,自由空间就是 0,
         * 它解析成 `0px`。真 Chrome 实测(宿主宽 520 / 620,`docs/probes/
         * toolbar-layout-probe.mjs`):这条 `margin-left:auto` 的**计算值就是 `0px`**,
         * 同步段右缘与组左缘**贴死**,用户第二次说的「留白到底有没有做,我看了是没有」
         * 就是这个。留白现在由**同步段右侧一条真实外边距**(`margin-right:var(--spacing)`)
         * 保证 —— 它是布局的一部分,自由空间为 0 时**也还在**;
         * `margin-left:auto` 只负责把**剩余**空间也吸进那**同一个**空隙。
         * 两条必须一起看,规则在 `scss/desktop-toolbar.scss`(不再是行内样式)。
         *
         * ## 上游有没有现成的「按钮组」类?——查过了,**没有**
         *
         * `src/client/scss/upstream/ui/toolbar/_toolbar.scss` 里只有:
         *   · `#desktop-app-toolbar{display:flex;flex-direction:row}`(`:8-9`,基线);
         *   · `.sidebar-section{display:flex;flex-direction:row;flex-shrink:0}`(`:24-26`);
         *   · 按钮的 `width:230px` / chevron `width:39px`(`:39-70`)。
         * 没有 `.toolbar-button-group` 一类的分组容器。`_toolbar.scss:112,117` 那两条
         * `margin-left` 是 `.ahead-behind` 徽标内部的(与我们这组无关)。
         * ⇒ 用 `display:flex` 包裹 + **现有**间距令牌(间距一律取 `_dsh-bridge.scss` 里
         * 已有的 `--spacing` / `--spacing-half` / `--spacing-third`,**不发明新的尺寸**)。
         *
         * ## ⚠️ 必须留在 `#desktop-app-toolbar` 里面
         *
         * 上游顶栏的基线是 `display:flex;flex-direction:row`。把这一组挪到外层包装
         * (`.gw-app-toolbar`)上会让它落进**另一个 flex 容器**:实测齿轮被居中在 64px 的
         * 包装里、绿点被挤到第二行/贴顶边(用户报过的「点跑到条子上方」)。
         * 所以这里只在该容器**内部**做伸缩。
         */}
        <div className="gw-toolbar-actions" ref={setToolbarActionsRef}>
          <span
            /*
             * ⚠️ 这里**刻意写成两个完整字面量**,不用 `` `gw-dot${signedIn ? ' ok' : ''}` ``:
             * 类名覆盖率的提取器(`scripts/build.mjs` 的 `classNamesUsedIn`)会把模板字面量里的
             * 插值当成类名的一部分,产出 `gw-dot${signedIn` 这种**永远找不到的 token**
             * (styles.mjs 的账本里已有两条同类登记)。写成字面量后提取到的是
             * `gw-dot` 与 `ok`,两条都在产物里(`styles.ts` 的 `.gw-dot` / `.gw-dot.ok`)。
             */
            className={signedIn ? 'gw-dot ok' : 'gw-dot'}
            style={GW_DOT_STYLE}
            title={signedIn ? `已登录 @${snap.auth?.login ?? ''}` : '未登录 GitHub(本地 git 仍可用)'}
          />
          <ToolbarBtn
            icon={octicons.gear}
            tooltip={settingsTooltip}
            ariaLabel="设置"
            onClick={onSettingsClick}
          />
          {/*
           * kebab(⋮ = 「更多」菜单的入口)。
           *
           * 它外面**不再**需要 `display:contents` 的 ref 载体 —— 它现在本来就在
           * `.gw-toolbar-actions` 这个真实盒子里,那一层 div 的 ref 直接
           * `querySelector('button[aria-label="更多"]')` 就把真正生成盒子的按钮交出去了
           * (⚠️ `display:contents` 的元素 rect 恒为全 0,第一版就栽在它上面;
           *  这里顺带把那层包装删掉,少一个坑)。
           */}
          <ToolbarBtn
            icon={octicons.kebabHorizontal}
            tooltip="更多"
            ariaLabel="更多"
            onClick={props.onOpenMenu}
          />
        </div>
      </ToolbarEl>
    </div>
  );
}

/* ---------- ③ 同步段 ---------- */

/**
 * 同步段 foldout 的**位置与宽度覆盖**(行内 style,经 `foldoutStyleOverrides` 回填)。
 *
 * ## 为什么必须覆盖
 *
 * `#foldout-container` 被 `scss/desktop-toolbar.scss` 重新锚到**插件根**
 * (`left:0 !important`),而 `.gw-root` 上有 `contain:layout paint` ⇒ 面板的包含块就是插件根;
 * 上游给面板的 `marginLeft: rect.left`(`dropdown.tsx:401`)却是**视口**坐标。
 * 两者相差一个「插件根左边界」:对**插件根在 (0,0)** 的 fixture 恒等于 0(所以那些年份里
 * 探针全绿),对真实宿主则整整差一个 `gwRoot.x`(实测插件根 x=480 时,仓库段的面板 x=960)。
 *
 * > 历史数据(可查):这一节的旧表记的是「面板 x 恒为 0」——那是**更早**一版
 * > (CSS 那条清零规则当时还会打到同步段)的读数。2026-10 第二次修正实测的**改前**状态是:
 * > 宿主宽 755 / 插件根 x=480 时,同步段面板 x=**847** = 段 x(**同步段本来就是对的**,
 * > 因为它走下面这条 JS 测量),而仓库段 +480、分支段 +470(= 双重计了一次 `gwRoot.x`)。
 *
 * ## 契约(探针断言的就是这几条)
 *
 * ```text
 * left  = 段按钮.left  − 顶栏.left     // 面板左边缘 == 段按钮左边缘 == chevron 左侧
 * width = 段按钮.right − 段按钮.left   // 面板宽 == 段按钮宽(上游 MultiOption 的契约)
 * ```
 *
 * ⚠️ 属性必须是 `left`(不是 `marginLeft`):`marginLeft` 是上游那个**视口坐标**的载体,
 * 被 SCSS 的 `margin-left:0 !important` 清零;两者共用同一属性时,测量值会被静默吃掉。
 *
 * **面板左边缘对齐的是 chevron 的左边缘**:MultiOption 形态下面板本来就从「整个
 * `.toolbar-dropdown`」起(`dropdown.tsx:394` 的 `width: rect.width`),而 chevron 是那个
 * 盒子的**右半部分**;两条一起成立时,面板的右边缘与段按钮的右边缘重合。
 *
 * ⚠️ 宽度**不**等于 chevron 的 39px:MultiOption 的 `.push-pull-dropdown-item` 里有
 * `.title + .detail` 两行中文,39px 会把它们全部截断。上游契约是 `rect.width`,这里逐字沿用。
 *
 * ⚠️ **`wrapper` 是 `display:contents` 的包装层,它的 rect 恒为全 0**
 * (实测 `{left:0,right:0,bottom:0}`)—— 所以这里必须先取出里面那个真正生成盒子的
 * `.toolbar-dropdown`。第一版直接量包装层,结果偏移算成 0、面板纹丝不动,
 * 现象与不修**一模一样**。这一条是本轮踩过的坑,写在这里免得再踩。
 *
 * @param wrapper - 同步段外面那层 `display:contents` 包装(包装层的 ref)。
 * @param toolbar - `#desktop-app-toolbar`;两个坐标的**同一个参照系**,少一个就退回
 *   `null`(不写任何错的值,面板回到上游原来的位置)。
 */
function syncFoldoutOverride(wrapper: HTMLElement | null, toolbar: Element | null): CSSProperties | null {
  const trigger = wrapper === null
    ? null
    : wrapper.querySelector('.toolbar-dropdown') ?? wrapper.firstElementChild;
  if (trigger === null || toolbar === null) {
    return null;
  }
  const rect = trigger.getBoundingClientRect();
  const toolbarRect = toolbar.getBoundingClientRect();
  if (rect.width <= 0) {
    return null;
  }
  /*
   * 不四舍五入:两个值都要落在**同一套**子像素坐标里,取整会白送 0.5px 误差。
   *
   * ⚠️ **给的是 `left`(插件根相对),不是 `marginLeft`** —— 这是 2026-10 第二次修正的
   * 契约:`marginLeft` 是上游用来装**视口坐标**的属性,而 SCSS 里
   * `#foldout-container > .foldout{margin-left:0 !important}` 会把它清零
   * (**含 `!important`,压过行内**)。若把量出来的坐标也写进 `marginLeft`,它会被
   * **静默**清零、现象与不修一模一样 —— 上一版就是这么坏掉的。
   * 三段现在一律用 `left`:仓库段 = 0、分支段 = 仓库段宽、同步段 = 这里的量。
   */
  const left = rect.left - toolbarRect.left;
  return { left, width: rect.width };
}
