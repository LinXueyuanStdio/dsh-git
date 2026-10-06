/**
 * **顶栏「当前仓库」段 + 仓库下拉面板的宽度** —— 以**存储值**为真源。
 *
 * ## 为什么需要它(真 Chrome 实测,不是从代码推的)
 *
 * 这一段原先用 `repo-bar.tsx` 的 `useLeftPaneWidth()`(只读观察 `.gw-split` 与其
 * `> .left`)。那个 hook 有**两个**结构性问题,而它们在真实界面里合成用户报的
 * 「切页签时当前仓库的宽度有问题」:
 *
 * | 问题 | 机制 |
 * |---|---|
 * | **量的是「当前页签」的 DOM** | `.gw-split` 是**每个页签各自渲染**的容器(`changes-view.tsx:104` / `history-view.tsx:1011`),而 `workbench.tsx:296-300` 的 `switch` 让两个视图**互斥挂载** |
 * | **观察器只在挂载时装一次** | `useLeftPaneWidth` 的 `useLayoutEffect(…, [])` 里 `MutationObserver` 一旦找到 `.gw-split` 就 `disconnect()`,而 `ResizeObserver` 盯着的还是**那个即将被卸载的元素** |
 *
 * 于是切页签时:被观察的元素被卸载 ⇒ `ResizeObserver` 回调里它的盒子是 0×0 ⇒
 * `setWidth(0)`;新的 `.gw-split` **永远不会被观察**,宽度也**永远回不来**。
 *
 * 实测(`docs/probes/toolbar-width-probe.mjs`,620px 面板,真 Chrome):
 *
 * | 采样点 | `.sidebar-section` 宽(行内 width) | 左栏实测 | `.gw-split` 轨道 |
 * |---|---|---|---|
 * | Changes(初始) | **250**(`250px`) | 250 | `250px 1fr` |
 * | Changes(拖分隔条 +120px) | **370**(`370px`) | 370 | `370px 1fr` |
 * | 切到 History | **117**(**行内 width 变空**) | 370 | `370px 1fr` |
 * | 切回 Changes | **117**(仍然空) | 370 | `370px 1fr` |
 * | History 展开仓库下拉 | 段 117 / 面板 **310**(不再跟着段走) | 370 | — |
 *
 * ⇒ 两个页签的左栏**是同一个数**(都来自同一个持久化键,见下),所以「两个左栏宽度不同」
 * 这条**不成立**;真正「页签相关」的是**观察器生命周期**。宽度掉到 117 = 段塌回
 * **内容宽**(`.toolbar-button` 的固有宽),因为 `state.width` 变成 0 之后
 * `toolbar.tsx` 就不写行内 `width` 了。
 *
 * ## 修法 = 沿用 Desktop 的模型
 *
 * Desktop 的仓库段宽**不是量出来的**,是**存出来的**:
 * `references/desktop/app/src/ui/app.tsx:3921` 的
 * `<div className="sidebar-section" style={{ width: clamp(this.state.sidebarWidth) }}>`
 * (下拉面板同源:`:3521` `const foldoutWidth = clamp(this.state.sidebarWidth)`)。
 * `sidebarWidth` 是应用状态里的**一个数**,由分隔条写入并持久化
 * (`lib/stores/app-store.ts:6034-6035`),**与哪个页签在前面无关**。
 *
 * 我们这边对应的「一个数」已经存在:`dsh-git.sidebar-width`
 * (`history-view.tsx:332`)——**两个页签共用同一个键**
 * (`changes-view.tsx:28` 与 `history-view.tsx:783` 都传 `SIDEBAR_WIDTH_STORAGE_KEY`);
 * 而左栏轨道的渲染值就是同一个纯函数
 * `clampSplitWidth(storedWidth, paneWidth)`(`history-view.tsx:395-512` 的
 * `useSplitWidth`)。所以这里**复用那个纯函数与那个键**,不新增第二份可写状态:
 *
 * ```text
 * 段宽 = clampSplitWidth(localStorage['dsh-git.sidebar-width'], 两栏容器可用宽)
 * ```
 *
 * 它与左栏轨道**逐像素相等**(同函数、同输入),但**不依赖「当前页签的 DOM 在不在」**:
 * 页签切走时用的还是同一个存储值。
 *
 * ## 为什么还要三个观察器
 *
 * | 观察器 | 盯什么 | 为什么必须有 |
 * |---|---|---|
 * | `ResizeObserver` on `.gw-split` | 两栏容器可用宽 | 宿主侧栏可被拖动 / 切全屏 ⇒ `paneWidth` 变,夹紧上限跟着变 |
 * | `ResizeObserver` on `.gw-root` | 宿主盒尺寸 | 同上;`.gw-root` 是**永远存在**的那个盒子 |
 * | `MutationObserver` on `document.body`(`childList` + `subtree`) | `.gw-split` 的**出现与替换** | `.gw-split` 是**晚到**的(`workbench.tsx:173` 的工具栏先挂,仓库选中后 `.gw-body`/`.gw-split` 才出现),页签切换还会把它整体换掉 —— 只在挂载时找一次就会**永远绑不上** |
 * | 同一个观察器的 `attributes:[style]`,只认 `target === 当前 .gw-split` | 拖分隔条 | 拖动经 `useSplitWidth.commit()` **同步**写 localStorage + 改这个元素的 `style` |
 *
 * ⚠️ 第一条实测教训:第一版把「出现与替换」的观察器挂在 `.gw-root` 上且**不开 `subtree`**
 * —— `.gw-split` 出现时变的是 `.gw-root` 的**孙节点**(`.gw-body` 里面),观察器一次都不响;
 * 于是段宽停在挂载时的 250,拖分隔条也不跟(实测:轨道 `370px 1fr` 而段宽仍 250)。
 * `subtree` 观察器的回调因此必须**按帧合并**(`requestAnimationFrame` 里最多查一次),
 * 否则虚拟列表每次渲染都会触发一次查询。
 *
 * ⚠️ 两条**都不能**在「量到 0」时把宽度写成 0:量到 0 只说明**这个元素已经不在了**,
 * 而不是「侧栏宽 0」。这正是旧 hook 的失效点。
 *
 * @module dsh-git/client/sidebar-width
 */

import { useLayoutEffect, useState } from 'react';

import {
  SIDEBAR_WIDTH_STORAGE_KEY,
  SPLIT_DEFAULT_WIDTH,
  clampSplitWidth,
} from './history-view.tsx';

/** 读持久化的侧栏宽(`useSplitWidth` 的 `readStoredSplitWidth` 同口径;读不到回落默认 250)。 */
function readStoredSidebarWidth(): number {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    const parsed = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(parsed) ? parsed : SPLIT_DEFAULT_WIDTH;
  } catch {
    // 隐私模式 / localStorage 被禁用:用默认值,不影响任何交互
    return SPLIT_DEFAULT_WIDTH;
  }
}

/**
 * 侧栏宽(像素)。`0` = 还没量到可用宽 ⇒ 调用方**不要**写行内宽度(回落到内容宽)。
 *
 * 值 = `clampSplitWidth(存储值, 两栏容器可用宽)`,与两个页签各自 `useSplitWidth()`
 * 渲染出来的左栏轨道**同一个数**,但**与当前是哪个页签无关**。
 */
export function useSidebarWidth(): number {
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    let disposed = false;
    /** 两栏容器的可用宽(与 `useSplitWidth` 量的是同一个元素的同一个字段)。 */
    let paneWidth = 0;

    let split: HTMLElement | null = null;
    let splitResize: ResizeObserver | null = null;
    let domObserver: MutationObserver | null = null;
    let hostResize: ResizeObserver | null = null;
    /** `.gw-split` 的出现/替换检查按帧合并(`subtree` 观察器的回调极其频繁)。 */
    let attachScheduled = false;

    /**
     * **永远存在**的宿主盒:插件根 `.gw-root`(`workbench.tsx:159`)。
     * `.gw-body` 更贴近两栏容器,但它在「没有选中仓库」时不存在,而这里需要一个
     * 从挂载起就能观察的对象。
     */
    function stableHost(): HTMLElement | null {
      return document.querySelector<HTMLElement>('.gw-body')
        ?? document.querySelector<HTMLElement>('.gw-root');
    }

    /** 重算宽度。`paneWidth` 未知时退到稳定宿主盒的宽度;仍然未知就保持 0。 */
    function recompute(): void {
      if (disposed) {
        return;
      }
      const pane = paneWidth > 0 ? paneWidth : (stableHost()?.clientWidth ?? 0);
      if (pane <= 0) {
        return;
      }
      const next = clampSplitWidth(readStoredSidebarWidth(), pane);
      setWidth((prev) => (prev === next ? prev : next));
    }

    /** 把针对 `.gw-split` 的观察器摘掉(元素要换了 / 组件要销毁了)。 */
    function detachSplit(): void {
      splitResize?.disconnect();
      splitResize = null;
      split = null;
    }

    /**
     * (重新)绑定当前页签的 `.gw-split`。
     *
     * `.gw-split` 是**晚到**的:工具栏(`workbench.tsx:173`)先挂,仓库选中之后
     * `.gw-body` 才出现;`changes-view.tsx` 在 `status === null` 时还不渲染两栏容器。
     * 所以这里必须能被反复调用(由 `domObserver` 按帧触发),而不是「挂载时找一次」。
     */
    function attachSplit(): void {
      if (disposed) {
        return;
      }
      const next = document.querySelector<HTMLElement>('.gw-split');
      if (next === split) {
        return;
      }
      detachSplit();
      split = next;
      if (split === null) {
        recompute();
        return;
      }
      if (split.clientWidth > 0) {
        paneWidth = split.clientWidth;
      }
      if (typeof ResizeObserver !== 'undefined') {
        splitResize = new ResizeObserver(() => {
          if (split !== null && split.clientWidth > 0) {
            paneWidth = split.clientWidth;
          }
          recompute();
        });
        splitResize.observe(split);
      }
      recompute();
    }

    /** 按帧合并的 `attachSplit()`(见 `domObserver` 的注释)。 */
    function scheduleAttach(): void {
      if (disposed || attachScheduled) {
        return;
      }
      attachScheduled = true;
      const run = (): void => {
        attachScheduled = false;
        if (!disposed) {
          attachSplit();
        }
      };
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(run);
      } else {
        setTimeout(run, 16);
      }
    }

    attachSplit();

    /*
     * **一个**观察器管两件事(都必须在**整个 body** 的 `subtree` 上看):
     *   · `childList` —— `.gw-split` 出现 / 页签切换把它换掉(实测:挂在 `.gw-root`
     *     且不开 `subtree` 时,`.gw-split` 出现一次都不响);
     *   · `attributes:[style]` 且 `target` 是**当前那个** `.gw-split` —— 拖分隔条。
     */
    if (typeof MutationObserver !== 'undefined') {
      domObserver = new MutationObserver((mutations) => {
        let splitStyleChanged = false;
        for (const mutation of mutations) {
          if (mutation.type === 'attributes' && mutation.target === split) {
            splitStyleChanged = true;
          }
        }
        if (splitStyleChanged) {
          recompute();
        }
        scheduleAttach();
      });
      domObserver.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['style'],
      });
    }

    /* 宿主侧栏被拖动 / 全屏切换:稳定宿主盒自己的大小变化。 */
    const host = stableHost();
    if (host !== null && typeof ResizeObserver !== 'undefined') {
      hostResize = new ResizeObserver(() => { recompute(); });
      hostResize.observe(host);
    }

    /* 没有 ResizeObserver 的环境(旧 WebView / 探针):至少跟一次窗口 resize。 */
    const onWindowResize = (): void => { recompute(); };
    window.addEventListener('resize', onWindowResize);

    return () => {
      disposed = true;
      detachSplit();
      domObserver?.disconnect();
      hostResize?.disconnect();
      window.removeEventListener('resize', onWindowResize);
    };
  }, []);

  return width;
}
