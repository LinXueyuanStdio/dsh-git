/**
 * **dsh-git 手写替身(shim)** —— 上游 `app/src/lib/menu-item.ts`(134 行)。
 *
 * 上游把菜单项序列化后经 IPC 交给 Electron 主进程弹出原生右键菜单,再把选中的
 * 下标回传、回调对应 `action()`。浏览器半没有原生菜单。
 *
 * 这里**完整保留数据结构与选择语义**:
 *  - `IMenuItem` / `ISerializableMenuItem` / `getPlatformSpecificNameOrSymbolForModifier`
 *    与上游逐字相同(后者是纯函数);
 *  - `showContextualMenu()` 换成**一个可替换的宿主钩子**:默认实现把菜单项
 *    打印出来并立即返回(不误触任何 `action`),宿主可以 `setContextualMenuHost()`
 *    注入真正的渲染器,从而把功能接回来。
 *
 * 被谁用到(实证):`ui/diff/side-by-side-diff.tsx:61` 取 `showContextualMenu`,
 * `:69` 取 `IMenuItem`(类型);`ui/lib/text-box.tsx:4`、`ui/lib/text-area.tsx:3` 同上。
 * @module dsh-git/core/desktop/lib/menu-item
 */

export interface IMenuItem {
  /** The user-facing label. */
  readonly label?: string

  /** The action to invoke when the user selects the item. */
  readonly action?: () => void

  /** The type of item. */
  readonly type?: 'separator' | 'checkbox'

  /** Is the menu item checked? Only applies to checkbox type. */
  readonly checked?: boolean

  /** Is the menu item enabled? Defaults to true. */
  readonly enabled?: boolean

  /** 上游是 Electron 的 `MenuItemConstructorOptions['role']`,这里保留字符串形状。 */
  readonly role?: string

  /**
   * Submenu that will appear when hovering this menu item.
   */
  readonly submenu?: ReadonlyArray<this>
}

/**
 * A menu item data structure that can be serialized and sent via IPC.
 */
export interface ISerializableMenuItem extends IMenuItem {
  readonly action: undefined
}

/**
 * Converts Electron accelerator modifiers to their platform specific
 * name or symbol.
 *
 * Example: CommandOrControl becomes either '⌘' or 'Ctrl' depending on platform.
 */
export function getPlatformSpecificNameOrSymbolForModifier(
  modifier: string
): string {
  switch (modifier.toLowerCase()) {
    case 'cmdorctrl':
    case 'commandorcontrol':
      return isDarwin() ? '⌘' : 'Ctrl'

    case 'ctrl':
    case 'control':
      return isDarwin() ? '⌃' : 'Ctrl'

    case 'shift':
      return isDarwin() ? '⇧' : 'Shift'
    case 'alt':
      return isDarwin() ? '⌥' : 'Alt'

    // Mac only
    case 'cmd':
    case 'command':
      return '⌘'
    case 'option':
      return '⌥'

    // Special case space because no one would be able to see it
    case ' ':
      return 'Space'
  }

  // Not a known modifier, likely a normal key
  return modifier
}

/**
 * 宿主注入点:给定已序列化的菜单项,返回被选中项的下标路径(与上游 IPC 的回传
 * 形状一致),或 `null` 表示用户取消了菜单。
 */
export type ContextualMenuHost = (
  items: ReadonlyArray<ISerializableMenuItem>,
  addSpellCheckMenu: boolean
) => Promise<ReadonlyArray<number> | null>

let host: ContextualMenuHost | null = null

/** 装上真正的右键菜单渲染器(宿主/渲染层调用)。 */
export function setContextualMenuHost(next: ContextualMenuHost | null) {
  host = next
}

/** Show the given menu items in a contextual menu. */
export async function showContextualMenu(
  items: ReadonlyArray<IMenuItem>,
  addSpellCheckMenu = false
) {
  const serialized = serializeMenuItems(items)

  if (host === null) {
    console.info(
      `[dsh-git] showContextualMenu:尚未注入右键菜单渲染器,已忽略 ${serialized.length} 项(未触发任何 action)。`
    )
    return
  }

  const indices = await host(serialized, addSpellCheckMenu)

  if (indices !== null) {
    const menuItem = findSubmenuItem(items, indices)

    if (menuItem !== undefined && menuItem.action !== undefined) {
      menuItem.action()
    }
  }
}

/**
 * Remove the menu items properties that can't be serializable in
 * order to pass them via IPC.
 */
function serializeMenuItems(
  items: ReadonlyArray<IMenuItem>
): ReadonlyArray<ISerializableMenuItem> {
  return items.map(item => ({
    ...item,
    action: undefined,
    submenu: item.submenu ? serializeMenuItems(item.submenu) : undefined,
  }))
}

/**
 * Traverse the submenus of the context menu until we find the appropriate index.
 */
function findSubmenuItem(
  currentContextualMenuItems: ReadonlyArray<IMenuItem>,
  indices: ReadonlyArray<number>
): IMenuItem | undefined {
  let foundMenuItem: IMenuItem | undefined = {
    submenu: currentContextualMenuItems,
  }

  for (const index of indices) {
    if (foundMenuItem === undefined || foundMenuItem.submenu === undefined) {
      return undefined
    }

    foundMenuItem = foundMenuItem.submenu[index]
  }

  return foundMenuItem
}

/** 取宿主平台;与 `lib/get-os.ts` 同口径,但这里只用 Mac/非 Mac。 */
function isDarwin(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    /Mac|iPhone|iPad/.test(navigator.platform ?? navigator.userAgent)
  )
}
