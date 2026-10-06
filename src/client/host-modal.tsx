/**
 * **插件自有模态外壳 + 共享的模态行为**(Preferences 与 Clone 两个弹窗共用一份)。
 *
 * ## ⚠️ 2026-10 第二次翻转:这个文件**不再**是「宿主 Modal 适配器」
 *
 * 文件名保留 `host-modal.tsx` 是**权宜之计**(改文件名的联动超出本次授权范围),但
 * 内容与职责已经反过来:它现在**不 import** 宿主 `Modal`,而是我们自己的一层
 * 「遮罩 + 卡片」。
 *
 * | | 改前(宿主 `Modal`) | 改后(本文件) |
 * |---|---|---|
 * | 遮罩/卡片是谁的 DOM | 宿主 `@deepseek-ai/dsh-client-ui-primitives` 的 `Modal`(走 `headless` 分支) | **我们自己的** `<div class="gw-dialog-scrim">` + `<div class="gw-dialog">` |
 * | 渲染在哪 | `createPortal(…, document.body)` —— **在插件根之外** | **就地渲染**,在 `.gw-root` 子树内(与 `clone-dialog.tsx` 同一结构) |
 * | Esc / Tab / 焦点进入 | 宿主 `useModalLayer`(宿主全局层栈) | 本文件的 {@link usePluginDialog}(语义沿用上游,见下) |
 * | 焦点归还 | 宿主 `useModalLayer` | 同上(而且**修掉了宿主那版在「卡片内有 autoFocus」时不归还**的缺口,见下) |
 *
 * **为什么用户要求改回来**:目标文档 §10 与 `docs/host-settings-card.md` 记录了宿主
 * **没有**「打开设置并直接跳到某个页签」的能力(`settings.plugins.tab` 的注册选项只有
 * `id`/`order`/`label`)。用户的原话是「要迁移到类似于 clone dialog 里弹出来,这样我们
 * 可以控制预选 tab」—— 由**插件自己**拥有那个弹窗,预选页签才是我们这一层说了算的事。
 *
 * ⚠️ **一条必须写清的边界(免得下一个人以为这里是深链的充分条件)**:宿主那条
 * 「不能深链到某个设置页签」的约束说的是**宿主自己的设置界面**(`settings.plugins.tab`),
 * 与本弹窗的页签预选**不是同一件事** —— 本弹窗的 `initialSelectedTab`
 * (`preferences-dialog.tsx`)在宿主 `Modal` 那一版里**也**是生效的(`useState` 初值)。
 * 改回自有外壳的真实收益是:①弹窗回到插件根内(作用域/层叠/裁剪都由我们掌控);
 * ②模态行为不再借宿主的全局层栈。**「深链本来不可能」这个说法用在我们的弹窗上是不准确的**,
 * 逐条记在 `docs/preferences-port.md` 的修订一节里。
 *
 * ## 模态行为的来源(沿用哪些、为什么)
 *
 * 1. **点外面关闭 = 上游 `ui/dialog/dialog.tsx` 的语义**,从 `clone-dialog.tsx` 原样
 *    搬进来(那个文件 2026-10 刚按上游逐条修过):判据挂在 `document` 上、用
 *    **mousedown** 登记、**mouseup** 才判、两侧都必须在卡片之外、
 *    `defaultPrevented` 直接返回。逐条行号引用见 {@link usePluginDialog} 里的注释。
 * 2. **Esc 关闭**:`dialog.tsx:788` 的 `event.key === 'Escape'`。⚠️ 上游 `:783-785`
 *    那条 `defaultPrevented` 闸门**刻意不沿用** —— 理由与 `clone-dialog.tsx` 原文一致:
 *    上游的监听挂在它自己的 `<dialog>` 上,而我们的挂在**宿主的 `document`** 上;
 *    沿用了它,宿主任何先注册并 `preventDefault()` 的 Escape 处理都会让本弹窗静默失效。
 * 3. **焦点 trap / 初始焦点 / 焦点归还 = 宿主 `useModalLayer.ts:56-126` 的等价实现**。
 *    为什么不直接 import 宿主的那个 hook:它是一个**没有导出到我们类型面**的成员
 *    (`types/client-platform-shims.d.ts` 只声明了我们真用到的那几个),而 `types/**`
 *    本次不在授权范围内 ⇒ 直接 import 会得到 TS2305。所以这里按**同一份语义**重写:
 *    · 可聚焦元素选择器与 `useModalLayer.ts:42` **逐字相同**;
 *    · 初始焦点:`[data-modal-autofocus]` ⇒ 第一个可聚焦元素 ⇒ 卡片自己(:73-75);
 *    · Tab / Shift+Tab 在首尾**环绕**,焦点在卡片外时拉回第一个(:104-112);
 *    · 关闭时把焦点还给**触发控件**(:118-121)。
 *    ⚠️ 这里比宿主那版**多修一处**:宿主在 `useLayoutEffect` 里读 `document.activeElement`
 *    当「触发控件」,而 React 的 `autoFocus`(clone 弹窗的 URL 输入框)在同一个提交阶段
 *    **先**跑完了 ⇒ 它记下的其实是卡片**内部**那个输入框,关闭时那个节点已被卸载,
 *    `isConnected` 为假 ⇒ **焦点归还静默失效**。本文件在**第一次渲染时**(卡片还没进 DOM)
 *    用 `useState` 惰性初值取触发控件,拿到的才是真正把弹窗叫出来的那个元素。
 *    这条属于「与上游实现有意的、有理由的偏离」,不是遗漏。
 *
 * ## DOM 结构(改这里的人必须先看这张图)
 *
 * ```
 * <div class="gw-dialog-scrim">              ← position:absolute;inset:0;z-index:60;grid 居中(styles.ts)
 *   <div class="gw-dialog <调用点类名>"       ← 卡片;clone 传 'gw-clone',preferences 传 'gw-prefs gw-prefs-card'
 *        role="dialog" aria-modal="true" tabIndex={-1}
 *        aria-label="…" 或 aria-labelledby="…">
 *     …调用点的内容…
 *   </div>
 * </div>
 * ```
 *
 * 两个调用点(`clone-dialog.tsx` / `preferences-dialog.tsx`)的**结构完全一致**,差别
 * 只在类名与可达名字的给法(它们各自的探针分别钉着 `.gw-dialog.gw-clone` 与
 * `.gw-dialog.gw-prefs` 两条结构判据)。
 *
 * ⚠️ **布局覆盖不在本文件**(本文件没有 CSS):`.gw-dialog` / `.gw-dialog-scrim` 来自
 * `src/client/styles.ts`(那是**别的泳道**持有的文件)。Preferences 卡片的
 * `width:min(600px,100%)` / `max-height:100%` 由那里的 `.gw-prefs-card` 给;
 * 「矮窗口里内容滚得动」也由它给(`.gw-prefs-card` 是竖向 flex 容器 + `.gw-prefs-body`
 * 用 `flex:1 1 auto;min-height:0`)—— 2026-10 之前这一条由调用点的**行内样式**兜着,
 * 现在布局只有 `styles.ts` 一处真源(回收记录见 `IPluginDialogProps` 上删掉 `cardStyle` 的注释)。
 *
 * @see docs/preferences-port.md —— 这一弹窗的移植记录与两次外壳翻转
 * @see docs/host-settings-card.md §10 —— 宿主**没有**深链到设置页签的能力(指的是宿主那一侧)
 * @module dsh-git/client/host-modal
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { TabBar as UpstreamTabBar } from '../core/desktop/ui/tab-bar.tsx';
import { TabBarType } from '../core/desktop/ui/tab-bar-type.ts';
import { DialogContent as UpstreamDialogContent } from '../core/desktop/ui/dialog/content.tsx';

/**
 * 卡片里「可聚焦」的元素 —— 与宿主 `useModalLayer.ts:42` 的选择器**逐字相同**。
 *
 * 逐字相同不是洁癖:探针(`docs/probes/preferences-dialog-probe.mjs` 的 S3 组)也用
 * 这一条选择器枚举首尾元素,两边一旦漂移,「Tab 在首尾环绕」的断言就会与实现错位。
 */
const FOCUSABLE =
  'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), ' +
  'select:not(:disabled), a[href], [tabindex="0"]';

/**
 * 卡片里**真的能 Tab 到**的元素 —— {@link FOCUSABLE} 再排掉 `tabindex="-1"`。
 *
 * ## 为什么必须有这一条(一条实测出来的缺陷,不是洁癖)
 *
 * 宿主 `useModalLayer.ts` 的「初始焦点」与「Tab 环绕」都直接用 {@link FOCUSABLE},
 * 而那个选择器**含 `tabindex="-1"` 的元素**(`button:not(:disabled)` 会命中它们)。
 * 典型的受害者就是上游 `ui/tab-bar-item.tsx:58`:`tabIndex={selected ? undefined : -1}`
 * —— **只有选中的页签**能 Tab 到,其余全是 `-1`。于是:
 *
 *  - 初始焦点会落在**第一个页签**(不管它选没选中)⇒ 我们以 `initialSelectedTab='git'`
 *    打开时,焦点跑到「账号」页签上(实测:`aria-selected=false`);
 *  - Tab 环绕的「首尾」也会被 `-1` 的元素带偏 ⇒ 从中间某个页签 `Shift+Tab`
 *    会**走出卡片**(浏览器按自己的 tab 序往前跳),焦点泄漏到弹窗背后的界面。
 *
 * ⇒ 判据改成「DOM 自己的 tab 序」:去掉 `-1`,再排掉 `[inert]` / `[hidden]` 子树。
 * `docs/probes/preferences-modal-probe.mjs` 的 C1(初始焦点落在**选中的**页签上)
 * 与 C2/C3(首尾环绕)就是钉这条的。
 * @param card - 模态卡片。
 * @returns 按 DOM 顺序排列的可 Tab 元素。
 */
function tabbables(card: HTMLElement): HTMLElement[] {
  return [...card.querySelectorAll<HTMLElement>(FOCUSABLE)]
    .filter((item) => item.getAttribute('tabindex') !== '-1'
      && item.closest('[inert], [hidden]') === null);
}

/**
 * 模态的共享行为:点外面关闭 / Esc 关闭 / 焦点 trap / 焦点归还。
 *
 * @param cardRef - **卡片**的 ref(不是遮罩的)。「点外面」的判据问的是
 *   「在不在卡片里」,判据必须落在卡片上 —— `clone-dialog.tsx` 曾经把 ref 挂在遮罩上,
 *   而遮罩**包含**卡片 ⇒ 点遮罩恒判为「在里面」⇒ 永不关闭(用户报过这个现象)。
 * @param onClose - 关闭回调。用 ref 取最新值,所以本 effect **只注册一次**:
 *   若在「按下」与「抬起」之间父组件重渲染,那条一次性的 `mouseup` 监听不会被摘掉。
 */
export function usePluginDialog(cardRef: RefObject<HTMLElement | null>, onClose: () => void): void {
  const close = useRef(onClose);
  close.current = onClose;

  /**
   * **触发控件** —— 在**第一次渲染**时取(`useState` 的惰性初值只跑一次,而且早于
   * 任何 DOM 提交)。取不到(焦点在 `body` 上,或没有焦点)就是 `null`,关闭时不做任何事。
   *
   * ⚠️ 为什么不能用 `useLayoutEffect` 里读 `document.activeElement` 的办法(宿主那样):
   * 卡片里若有 `autoFocus`,React 在同一个提交阶段**先**把焦点移进卡片 ⇒ 记下的是
   * 卡片内部节点 ⇒ 关闭时它已被卸载 ⇒ 焦点归还静默失效。见文件头第 3 条。
   */
  const [invoker] = useState<HTMLElement | null>(() => {
    const active = document.activeElement;
    return active instanceof HTMLElement && active !== document.body ? active : null;
  });

  /* ---- 初始焦点(照 `useModalLayer.ts:73-75`)---- */
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (card === null) {
      return;
    }
    // 卡片里已经有人拿着焦点(React 的 `autoFocus`,或调用点自己 focus 过)⇒ 不抢。
    if (!card.contains(document.activeElement)) {
      const initial = card.querySelector<HTMLElement>('[data-modal-autofocus]')
        ?? tabbables(card)[0]
        ?? card;
      initial.focus();
    }
  }, [cardRef]);

  /* ---- Esc + Tab 焦点环 ---- */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      /*
       * Esc:`dialog.tsx:788`。**不查** `defaultPrevented` —— 理由见文件头第 2 条
       * (与 `clone-dialog.tsx` 的原注释逐字同源)。
       */
      if (event.key === 'Escape') {
        close.current();
        return;
      }
      if (event.key !== 'Tab' || event.defaultPrevented) {
        return; // `useModalLayer.ts:85` 的 defaultPrevented 闸门(内层控件可以先处理)
      }
      if (event.ctrlKey || event.altKey || event.metaKey) {
        return; // `:86` —— 带修饰键的 Tab 不是焦点遍历
      }
      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLElement && activeElement.closest('[role="menu"]') !== null) {
        return; // `:91` —— 菜单浮层自己拥有遍历
      }
      const card = cardRef.current;
      if (card === null) {
        return;
      }
      const items = tabbables(card);
      const first = items[0] ?? card;
      const last = items[items.length - 1] ?? card;
      // `:104-112`:在首尾(或焦点根本不在卡片里)才介入,否则让浏览器正常走。
      const atEdge = event.shiftKey ? activeElement === first : activeElement === last;
      if (activeElement === card || !card.contains(activeElement) || atEdge) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('keydown', onKeyDown); };
  }, [cardRef]);

  /* ---- 点外面关闭(上游 `dialog.tsx` 的 mousedown/mouseup 语义)---- */
  useEffect(() => {
    const onMouseUp = (event: MouseEvent): void => {
      if (event.defaultPrevented) {
        return; // dialog.tsx:760
      }
      const target = event.target;
      const card = cardRef.current;
      if (target instanceof Node && card !== null && card.contains(target)) {
        return;
      }
      close.current(); // dialog.tsx:762 的 onDismiss()
    };

    const onMouseDown = (event: MouseEvent): void => {
      if (event.defaultPrevented) {
        return; // dialog.tsx:688-690
      }
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      const card = cardRef.current;
      // `:701-703` + `:726-751` —— 落在卡片(及卡片里的控件)上 ⇒ 这是对话框内部,不是 backdrop。
      if (card !== null && card.contains(target)) {
        return;
      }
      /*
       * `:705-723` —— 按下在 backdrop 上;抬起是否也在 backdrop 上由 `onMouseUp` 判定。
       * `{ once: true }` 与上游一致,所以**不**在 cleanup 里摘它:本 effect 只注册一次
       * (依赖只有 `cardRef`),但即便将来有人在「按下」与「抬起」之间把本组件卸载,
       * 那条监听也只会调用一次 `close.current()`(幂等)。
       */
      document.addEventListener('mouseup', onMouseUp, { once: true });
    };

    document.addEventListener('mousedown', onMouseDown);
    return () => { document.removeEventListener('mousedown', onMouseDown); };
  }, [cardRef]);

  /* ---- 焦点归还(照 `useModalLayer.ts:118-121`)---- */
  useLayoutEffect(() => () => {
    if (invoker !== null && invoker.isConnected) {
      invoker.focus();
    }
  }, [invoker]);
}

/** {@link PluginDialog} 的 prop 面(我们自己的形状,不沿用上游)。 */
export interface IPluginDialogProps {
  /**
   * 卡片的额外类名(与基底 `gw-dialog` 拼在一起)。
   *
   * ⚠️ **移植面的作用域根必须从这里进**:`.gw-prefs` 是 `scss/preferences.scss` 的
   * 作用域根,前缀化用的是**后代组合子** ⇒ 它必须加在**卡片自己**身上,而
   * `#preferences`(上游 SCSS 的 id 锚点)必须是它的**后代**、不能同元素
   * (同元素会产出永不匹配的选择器,见那个文件头)。
   */
  readonly className?: string;
  /** `role="dialog"` 的可达名字(与 {@link labelledBy} 二选一)。 */
  readonly label?: string;
  /** `role="dialog"` 的可达名字:指向卡片内部某个真实存在的 id。 */
  readonly labelledBy?: string;
  /*
   * ⚠️ 2026-10 删掉了 `cardStyle?`(卡片行内样式)。它唯一的调用点是
   * `preferences-dialog.tsx` 的 `PREFERENCES_CARD_STYLE = { overflowY: 'auto' }`
   * —— 一条「矮窗口里卡片自己滚」的权宜,而那条常量自己写明了回收条件
   * (布局搬进 `styles.ts` + `.gw-prefs-body` 的 `min-height` 改成与包含块无关的形式)。
   * 两条现在都成立(`.gw-prefs-card` 改成竖向 flex 容器、`.gw-prefs-body` 用
   * `flex:1 1 auto;min-height:0`)⇒ 行内样式与这个 prop 一起删除,避免留下
   * 「定义了但没人用」的 prop(`react/no-unused-prop-types` 正是为此报警)。
   * `clone-dialog.tsx` 从来没用过它,所以这是零行为变更。
   */
  /** 关闭(Esc / 点遮罩 / 点「取消」都汇到这里)。 */
  readonly onClose: () => void;
  readonly children?: ReactNode;
}

/**
 * 插件自有模态:遮罩 + 卡片,**就地**渲染在调用点所在的 DOM 树里(不 portal)。
 *
 * 结构与 `clone-dialog.tsx` 逐字同形 —— 那个弹窗是用户点名要的形态,也是本仓
 * 「点外面关闭」语义刚修好的那个实现;两者共用 {@link usePluginDialog} 一份行为。
 *
 * @param props - 见 {@link IPluginDialogProps}。
 */
export function PluginDialog(props: IPluginDialogProps): ReactNode {
  const card = useRef<HTMLDivElement>(null);
  usePluginDialog(card, props.onClose);
  const className = props.className === undefined ? 'gw-dialog' : `gw-dialog ${props.className}`;
  return (
    <div className="gw-dialog-scrim">
      {/*
        `tabIndex={-1}`:卡片自己要能接住 `focus()`。宿主那一版在「卡片里一个可聚焦元素
        都没有」时会把焦点给卡片本身(`useModalLayer.ts:73-75` 的 `?? element`),而一个
        没有 tabindex 的 div 调 `.focus()` 是**静默无效**的 —— 那是「模态打开了但焦点
        还在页面上」的静默失败。加 -1 后那条兜底才真的成立。
      */}
      <div
        className={className}
        ref={card}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-label={props.label}
        aria-labelledby={props.labelledBy}
      >
        {props.children}
      </div>
    </div>
  );
}

/** `TabBar` 的 prop 面 —— 逐字对齐上游 `tab-bar.tsx:11-22`，**外加**真实却被漏掉的 `children`。 */
export interface ITabBarProps {
  /** 当前选中的页签下标。 */
  readonly selectedIndex: number;
  /** 点某个页签时的回调(参数是**视觉**下标)。 */
  readonly onTabClicked: (index: number) => void;
  /** `TabBarType.Vertical` = 竖向页签(Preferences 用的就是它)。 */
  readonly type?: TabBarType;
  /** 允许拖拽经过时切换页签。 */
  readonly allowDragOverSwitching?: boolean;
  /** 页签项;上游 `:116` 用 `React.Children.toArray()` 逐个渲染。 */
  readonly children?: ReactNode;
}

/**
 * 上游 `TabBar`,但**构造函数签名补上 `children`**(见 `docs/preferences-port.md` §9.5)。
 *
 * 只改类型、不改行为:`as` 断言把同一个类实例交出去,运行期零包装(所以上游
 * `tab-bar.tsx:34` 的 `tabRefsByIndex` 与 `:36` 的 `mouseOverTimeoutId` 那些私有
 * 字段照旧在原实例上)。**不改镜像**是本仓的头号不变式。
 */
export const TabBar = UpstreamTabBar as unknown as (
  props: ITabBarProps
) => ReactNode;

/** `DialogContent` 的 prop 面 —— 逐字对齐上游 `ui/dialog/content.tsx:4-16`,**外加**真实却被漏掉的 `children`。 */
export interface IDialogContentProps {
  /** 追加在 `dialog-content` 之后的类名(上游 `content.tsx:29` 走 `classNames`)。 */
  readonly className?: string;
  /** 内容(上游 `content.tsx:32` 原样渲染 `this.props.children`)。 */
  readonly children?: ReactNode;
}

/**
 * 上游 `DialogContent`,但**prop 面补上 `children`** —— 与上面 `TabBar` **同一个根因**。
 *
 * 上游 `ui/dialog/content.tsx:27` 的 `IDialogContentProps` 只声明了 `className` 与 `onRef`,
 * 而 `:32` 明明渲染 `this.props.children`(它是个 `React.Component`)。
 * 自 2026-10 起「账号 / 仓库 / 通知」三个页面的内容盒**必须**由我们这层显式渲染
 * (见 `preferences-pages.tsx` 三处调用点的注释),于是这个类型缺口从「上游自己的问题」
 * 变成了**我们这里的编译错误**(TS2769 ×5)。
 *
 * 处置与本仓既有两例**完全一致**(`docs/preferences-port.md` §9.5 的 `TabBar`、
 * `src/client/diff-ui.ts` 的 `ISeamlessDiffSwitcherProps`):**镜像一字不改**,
 * 在适配层用 `as` 把同一个类**以正确的 prop 类型再导出**(运行期零包装 ——
 * `content.tsx` 的 `onRef` 与 `classNames` 行为逐字保留)。
 */
export const DialogContent = UpstreamDialogContent as unknown as (
  props: IDialogContentProps
) => ReactNode;
