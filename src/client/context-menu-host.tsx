/**
 * **右键菜单宿主** —— 把 `src/core/desktop/lib/menu-item.ts` 的注入点接上真正的菜单。
 *
 * ## 为什么必须手写(而不是「沿用上游」)
 *
 * Desktop 的右键菜单是 **Electron 原生菜单**:渲染层把 `IMenuItem[]` 序列化后经 IPC
 * 交给主进程(`references/desktop/app/src/main-process/menu/build-context-menu.ts`),
 * 再把用户选中的**下标路径**回传。浏览器半没有原生菜单,`references/desktop/app/src/ui/**`
 * 里也**没有**任何 in-app 的上下文菜单渲染器(`ui/lib/context-menu.ts` 只有标签常量)。
 * ⇒ 这一层必然是手写的适配器,性质与已登记的 shim(`lib/menu-item.ts`)完全相同。
 * 这是本项目「对齐优先」原则的**例外**,理由写在这里,不必再找上游文件。
 *
 * ## 谁在用
 *
 * `showContextualMenu()` 的调用点(实测):
 *  - `ui/diff/side-by-side-diff.tsx:61,1438,1467,1553,1567` —— diff 正文(Copy /
 *    Select All / Expand Whole File / Collapse Expanded Lines)与行号/hunk 手柄
 *    (Discard line(s),该功能要 Phase 2 的 host 路由);
 *  - `ui/lib/text-box.tsx`、`ui/lib/text-area.tsx` —— 输入框自己的菜单;
 *  - 仓库列表那条线(共用本模块,不重复实现)。
 *
 * ## 契约(与 `menu-item.ts` 的 `ContextualMenuHost` 一致)
 *
 * 输入已**序列化**的菜单项(`action` 被剥掉,`submenu` 递归保留),输出被选中项的
 * **下标路径**;`null` = 用户取消。`showContextualMenu` 负责按路径找回原项并调 `action()`。
 *
 * ## 三个必须在此层处理的细节(否则「点了没反应」)
 *
 *  1. **`role: 'copy'` 那一项没有 `action`**。`side-by-side-diff.tsx:1424-1430` 的 Copy 项
 *     用 `role: selectionLength > 0 ? 'copy' : undefined` 表达「执行原生复制」,因为
 *     Electron 认这个 role。序列化后 `action` 是 `undefined`,所以 `showContextualMenu`
 *     **永远不会**替它做任何事 ⇒ 宿主必须自己执行这个角色(`document.execCommand('copy')`;
 *     它是唯一还能触发原生复制的同步 API,已标记废弃但主流浏览器仍支持)。
 *     执行完 resolve `null`(没有下标可回传)。
 *  2. **抑制浏览器的原生菜单**。上游 diff 的 `onContextMenuText` **从不调用
 *     `preventDefault`**(`side-by-side-diff.tsx:1407-1440`),而 Electron 渲染进程默认
 *     **不显示**原生上下文菜单 ⇒ 在 Desktop 上「只有应用菜单」;在浏览器里原生的那个会
 *     **同时**弹出来压在我们的菜单上。抑制它只能在事件层做,所以由**调用方**
 *     (`desktop-diff.tsx` 的容器)加捕获阶段的 `contextmenu` 处理器 ——
 *     本模块不替所有调用方做,否则会把别人故意保留的原生菜单一并杀掉。
 *  3. **焦点**:菜单打开时焦点进第一个可用项,Esc 收掉,关闭时把焦点**归还**给打开前的
 *     元素(上游 `ui/lib/popover.tsx` 的 `trapFocus` 默认开,这里是同一语义的最小实现)。
 *
 * ## 已知未做(报告里记账)
 *
 *  - `addSpellCheckMenu === true` 时上游会追加操作系统的拼写检查子菜单
 *    (走 `webFrame`/`spellChecker`),浏览器半没有等价能力 ⇒ 忽略该参数。
 *  - 上游菜单项可以带 `accelerator`;序列化形状里没有它,所以这里也不画快捷键提示。
 *
 * @module dsh-git/client/context-menu-host
 */

import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { setContextualMenuHost } from '../core/desktop/lib/menu-item.ts';
import type {
  ContextualMenuHost,
  ISerializableMenuItem,
} from '../core/desktop/lib/menu-item.ts';

/** 菜单层压在所有宿主浮层之上(宿主 Tooltip/Popover 的量级都在 1e6 以下)。 */
const LAYER_Z_INDEX = '2147483000';
const MENU_MIN_WIDTH = 180;
const VIEWPORT_MARGIN = 4;

/**
 * 菜单层与菜单项的内联样式。
 *
 * **刻意用真实存在的宿主令牌**(`checkInlineTokens` 会让宿主里没有的 `--dsw-alias-*`
 * 构建失败);之所以内联而不是新增 CSS:`src/client/scss/**` 有单独的 owner,
 * 本轮只**上报**需求(见报告),不写 CSS。等那条线补上 `.gw-ctxmenu` 一族规则后,
 * 这里可以退化成类名。
 */
const LAYER_STYLE: Partial<CSSStyleDeclaration> = {
  position: 'fixed',
  inset: '0',
  zIndex: LAYER_Z_INDEX,
};

const MENU_STYLE: Partial<CSSStyleDeclaration> = {
  position: 'fixed',
  minWidth: `${MENU_MIN_WIDTH}px`,
  maxWidth: '320px',
  padding: '4px',
  margin: '0',
  background: 'var(--dsw-alias-bg-layer-3, #ffffff)',
  border: '1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.35))',
  borderRadius: '6px',
  boxShadow: '0 6px 24px rgba(0, 0, 0, 0.24)',
  color: 'var(--dsw-alias-label-primary, inherit)',
  fontSize: '12px',
  lineHeight: '1.4',
};

const ITEM_STYLE: Partial<CSSStyleDeclaration> = {
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  width: '100%',
  padding: '5px 8px',
  border: '0',
  borderRadius: '4px',
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

const SEPARATOR_STYLE: Partial<CSSStyleDeclaration> = {
  height: '1px',
  margin: '4px 6px',
  background: 'var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.35))',
  border: '0',
};

const HOVER_BACKGROUND = 'var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.15))';
const DISABLED_COLOR = 'var(--dsw-alias-label-dimmed, rgba(127, 127, 127, 0.8))';

let installed = false;

/** 把样式表对象写到元素上(逐键赋值需要 cast,这里写出来表示是有意的)。 */
function style(el: HTMLElement, values: Partial<CSSStyleDeclaration>): void {
  for (const [key, value] of Object.entries(values)) {
    (el.style as unknown as Record<string, string>)[key] = value as string;
  }
}

/** 执行 Electron role 里浏览器半能做到的那一部分;返回 true 表示已处理。 */
function runRole(item: ISerializableMenuItem): boolean {
  if (item.role === 'copy') {
    try {
      document.execCommand('copy');
    } catch {
      // 忽略:没有可复制内容或浏览器拒绝执行
    }
    return true;
  }
  return false;
}

/**
 * 记录最近一次指针位置。
 *
 * 为什么需要:`ContextualMenuHost` 的签名**不含事件对象**(上游是 IPC,主进程按自己的
 * 屏幕坐标弹菜单),所以「在哪儿弹」只能靠记录。菜单全部由鼠标手势触发,记录
 * `contextmenu`/`mousedown` 就够;`mousemove` 是给「先移动、再从别处触发」的兜底。
 */
const lastPointer = { x: 0, y: 0, valid: false };

if (typeof document !== 'undefined') {
  const remember = (event: MouseEvent): void => {
    lastPointer.x = event.clientX;
    lastPointer.y = event.clientY;
    lastPointer.valid = true;
  };
  document.addEventListener('mousedown', remember, true);
  document.addEventListener('contextmenu', remember, true);
  document.addEventListener('mousemove', remember, true);
}

/**
 * 打开一个上下文菜单,resolve 用户选择的下标路径(或 `null`)。
 *
 * 实现是**命令式 DOM**,刻意不用 React:
 *  - 任何 lane 只要 `import` 本模块就能用,不必在共享组件树里找挂载点(那是别人的文件);
 *  - 每个消费者各挂一个 `<ContextMenuHost />` 也不会出现多份菜单 —— 菜单层的唯一实例
 *    由本模块管。
 * @param items - 已序列化的菜单项。
 */
export const openContextMenu: ContextualMenuHost = (items) =>
  new Promise<ReadonlyArray<number> | null>((resolve) => {
    if (typeof document === 'undefined') {
      resolve(null);
      return;
    }

    const previouslyFocused = document.activeElement;
    const layer = document.createElement('div');
    layer.setAttribute('data-dsh-git-context-menu', '');
    style(layer, LAYER_STYLE);
    document.body.appendChild(layer);

    /** 已打开的菜单栈(下标 0 = 根菜单)。 */
    const stack: { element: HTMLDivElement; indices: ReadonlyArray<number> }[] = [];
    let settled = false;

    const finish = (result: ReadonlyArray<number> | null): void => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('mousedown', onDocumentMouseDown, true);
      layer.remove();
      // 焦点归还:菜单关掉后键盘用户不该掉到 body。
      if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) {
        previouslyFocused.focus();
      }
      resolve(result);
    };

    /** 收掉比 `depth` 更深的菜单层。 */
    const closeDeeperThan = (depth: number): void => {
      while (stack.length > depth + 1) {
        stack.pop()?.element.remove();
      }
    };

    /** 量完尺寸再夹进视口(离屏量不到,所以先插入再量)。 */
    const position = (el: HTMLElement, x: number, y: number): void => {
      const rect = el.getBoundingClientRect();
      const left = Math.max(VIEWPORT_MARGIN, Math.min(x, window.innerWidth - rect.width - VIEWPORT_MARGIN));
      const top = Math.max(VIEWPORT_MARGIN, Math.min(y, window.innerHeight - rect.height - VIEWPORT_MARGIN));
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
    };

    const paint = (el: HTMLElement, hovered: boolean): void => {
      el.style.background = hovered ? HOVER_BACKGROUND : 'transparent';
    };

    /**
     * 建一层菜单并插进 layer。
     * @param menuItems - 这一层的项。
     * @param indices - 到这一层为止的下标路径。
     * @param depth - 层级(0 = 根)。
     * @param anchor - 位置(根菜单是鼠标点,子菜单是父项右缘)。
     */
    const buildMenu = (
      menuItems: ReadonlyArray<ISerializableMenuItem>,
      indices: ReadonlyArray<number>,
      depth: number,
      anchor: { x: number; y: number },
    ): HTMLDivElement => {
      const menu = document.createElement('div');
      menu.setAttribute('role', 'menu');
      style(menu, MENU_STYLE);

      const focusables: HTMLButtonElement[] = [];

      /** 打开某项的子菜单(鼠标悬停与键盘 → 都走这里)。 */
      const openSubmenuOf = (item: ISerializableMenuItem, path: ReadonlyArray<number>, button: HTMLButtonElement): void => {
        if (item.submenu === undefined) {
          closeDeeperThan(depth);
          return;
        }
        closeDeeperThan(depth);
        const parent = button.getBoundingClientRect();
        const child = buildMenu(item.submenu, path, depth + 1, {
          x: parent.right - 2,
          y: parent.top - 4,
        });
        stack.push({ element: child, indices: path });
      };

      menuItems.forEach((item, index) => {
        const path = [...indices, index];

        if (item.type === 'separator') {
          const separator = document.createElement('div');
          separator.setAttribute('role', 'separator');
          style(separator, SEPARATOR_STYLE);
          menu.appendChild(separator);
          return;
        }

        const enabled = item.enabled !== false;
        const button = document.createElement('button');
        button.type = 'button';
        button.setAttribute('role', item.type === 'checkbox' ? 'menuitemcheckbox' : 'menuitem');
        if (item.type === 'checkbox') {
          button.setAttribute('aria-checked', item.checked === true ? 'true' : 'false');
        }
        style(button, ITEM_STYLE);
        if (!enabled) {
          button.setAttribute('aria-disabled', 'true');
          button.disabled = true;
          button.style.color = DISABLED_COLOR;
          button.style.cursor = 'default';
        }

        if (item.type === 'checkbox') {
          const mark = document.createElement('span');
          mark.style.width = '10px';
          mark.style.flex = '0 0 auto';
          mark.textContent = item.checked === true ? '✓' : '';
          button.appendChild(mark);
        }

        const text = document.createElement('span');
        text.style.flex = '1 1 auto';
        // 永远用 textContent,不用 innerHTML。
        text.textContent = item.label ?? '';
        button.appendChild(text);

        if (item.submenu !== undefined) {
          const chevron = document.createElement('span');
          chevron.style.flex = '0 0 auto';
          chevron.style.opacity = '0.7';
          chevron.textContent = '›';
          button.appendChild(chevron);
        }

        button.addEventListener('mouseenter', () => {
          if (!enabled) return;
          paint(button, true);
          openSubmenuOf(item, path, button);
        });
        button.addEventListener('mouseleave', () => { paint(button, false); });

        button.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!enabled) return;
          // role 类的项没有 action,由宿主代执行;不返回下标(上游也没得可调)。
          if (runRole(item)) {
            finish(null);
            return;
          }
          finish(path);
        });

        menu.appendChild(button);
        if (enabled) focusables.push(button);
      });

      layer.appendChild(menu);
      position(menu, anchor.x, anchor.y);

      // 键盘可达:根菜单把焦点送进第一个可用项(上游 Popover 的 trapFocus 默认开)。
      if (depth === 0) focusables[0]?.focus();
      return menu;
    };

    const onDocumentMouseDown = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      for (const entry of stack) {
        if (entry.element.contains(target)) return;
      }
      finish(null);
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      const owner = stack.at(-1);
      if (owner === undefined) return;

      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        // Esc 一次收一层;根菜单收掉就是取消(与 Electron 一致)。
        if (stack.length > 1) {
          stack.pop()?.element.remove();
          stack.at(-1)?.element.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
        } else {
          finish(null);
        }
        return;
      }

      const buttons = [...owner.element.querySelectorAll<HTMLButtonElement>('button:not([disabled])')];
      if (buttons.length === 0) return;
      const active = document.activeElement;
      const at = active instanceof HTMLButtonElement ? buttons.indexOf(active) : -1;

      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        const next = at < 0 ? 0 : (at + step + buttons.length) % buttons.length;
        buttons[next]?.focus();
        return;
      }
      if (event.key === 'Tab') {
        // 焦点陷阱:Tab 不逃到宿主界面去。
        event.preventDefault();
        const step = event.shiftKey ? -1 : 1;
        const next = at < 0 ? 0 : (at + step + buttons.length) % buttons.length;
        buttons[next]?.focus();
        return;
      }
      if (event.key === 'ArrowRight' && at >= 0) {
        event.preventDefault();
        buttons[at]?.dispatchEvent(new MouseEvent('mouseenter'));
      }
    };

    document.addEventListener('mousedown', onDocumentMouseDown, true);
    document.addEventListener('keydown', onKeyDown, true);

    // 根菜单:位置取最近一次指针;没有指针记录(纯键盘触发)时退回 (0,0) 再由
    // `position()` 夹进视口左上角。
    const root = buildMenu(items, [], 0, { x: lastPointer.x, y: lastPointer.y });
    stack.push({ element: root, indices: [] });
  });

/**
 * 装上真正的右键菜单渲染器。**幂等**。
 *
 * `import` 本模块时已自动调用一次,所以消费方只要
 * `import { installContextMenuHost } from './context-menu-host.tsx'`
 * (或裸 `import './context-menu-host.tsx'`)就已经生效。
 */
export function installContextMenuHost(): void {
  if (installed) return;
  if (typeof document === 'undefined') return;
  installed = true;
  setContextualMenuHost(openContextMenu);
}

// 模块被 import 即生效:仓库列表那条线只需 import 本模块,不需要改共享组件树。
installContextMenuHost();

/**
 * 给「想在组件树里显式挂一次」的消费方准备的惰性组件:本身不渲染任何东西,
 * 只在挂载时确保宿主已装上(与模块导入同一个幂等函数)。
 *
 * 之所以**不是**菜单的渲染器:若每个消费者各挂一份,同一时刻会出现多份菜单;
 * 菜单层的唯一实例由本模块管理。挂它只是让「谁在用右键菜单」在渲染树里可见。
 */
export function ContextMenuHost(): ReactNode {
  useEffect(() => { installContextMenuHost(); }, []);
  return null;
}

/** 让别的 lane 可以自测「宿主装上了没」。 */
export function isContextMenuHostInstalled(): boolean {
  return installed;
}
