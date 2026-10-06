/**
 * **dsh-git 手写替身(shim)** —— 上游 `ui/main-process-proxy.ts`(约 480 行)。
 *
 * 上游是「渲染进程 → Electron 主进程」的唯一出口:每个导出都是
 * `invokeProxy(channel, n)`(双工)或 `sendProxy(channel, n)`(单工),
 * 类型由 `lib/ipc-shared.ts` 的 `RequestChannels` 契约保证。
 *
 * 浏览器半没有主进程。这里保留**上游全部导出名与调用签名**,并:
 *  - `invokeProxy` / `sendProxy` 仍是**工厂函数**(形状与上游一致),但产出的函数
 *    不再发 IPC:`sendProxy` 返回 undefined,`invokeProxy` 返回 `Promise<undefined>`;
 *  - 少数几条在浏览器里**有真实等价物**的导出就地实现,而不是降级:
 *    `writeClipboardText()`(走 `navigator.clipboard`)、
 *    `shouldUseDarkColors()`(走 `matchMedia('(prefers-color-scheme: dark)')`);
 *  - `invokeContextualMenu()` 解析为 `null`(= 用户取消),这正是上游
 *    `lib/menu-item.ts` 里 `if (indices !== null)` 的那个分支,不会误触 action;
 *  - 事件订阅型导出(`onNativeThemeUpdated` 等)返回一个可用的退订函数,
 *    在浏览器里立即退订(不注册监听),调用方的 cleanup 逻辑照常工作。
 *
 * 被谁用到(实证):`lib/menu-item.ts`(上游版)、`ui/lib/app-proxy.ts:1-2`、
 * `ui/lib/application-theme.ts:6-9`、`ui/dialog/dialog.tsx:8`、`ui/copy-button.tsx`。
 * @module dsh-git/core/desktop/ui/main-process-proxy
 */

import type { ExecutableMenuItem } from '../models/app-menu'

/**
 * 上游的 `RequestChannels` / `RequestResponseChannels` 契约在
 * `lib/ipc-shared.ts` 里,那里又 import 了 `desktop-notifications`、`../main-process/menu`
 * 等主进程类型。这里用宽松签名代替 —— 这些只是**类型**,运行期无影响。
 */
type AnyFn = (...args: ReadonlyArray<any>) => any

/** 上游 :23 —— 造一个双工(请求/响应)代理。当前宿主下恒解析为 undefined。 */
export function invokeProxy<T extends string>(
  _channel: T,
  _numArgs: number
): AnyFn {
  return (..._args: ReadonlyArray<unknown>) => Promise.resolve(undefined)
}

/** 上游 :50 —— 造一个单工(单向)代理。当前宿主下是 no-op。 */
export function sendProxy<T extends string>(
  _channel: T,
  _numArgs: number
): AnyFn {
  return (..._args: ReadonlyArray<unknown>) => undefined
}

/** 上游 :65 */
export const selectAllWindowContents = sendProxy(
  'select-all-window-contents',
  0
)

/** 上游 :71 */
export const updateMenuState = sendProxy('update-menu-state', 1)

/** 上游 :74 */
export const sendReady = sendProxy('renderer-ready', 1)

/** 上游 :77 */
export const executeMenuItem = (item: ExecutableMenuItem) =>
  executeMenuItemById(item.id)

/** 上游 :81 */
export const executeMenuItemById = sendProxy('execute-menu-item-by-id', 1)

/** 上游 :86 —— 浏览器里「窗口是否聚焦」有真实等价物:`document.hasFocus()`。 */
export const isWindowFocused = () =>
  Promise.resolve(
    typeof document !== 'undefined' && typeof document.hasFocus === 'function'
      ? document.hasFocus()
      : true
  )

/** 上游 :89 */
export const focusWindow = sendProxy('focus-window', 0)

/** 上游 :94 */
export const showItemInFolder = (_path: string) =>
  Promise.resolve(undefined)

/** 上游 :106 —— 依赖注入形状保留,便于宿主替换。 */
export interface IShowFolderContentsDependencies {
  readonly isDarwin: boolean
  readonly stat: (path: string) => Promise<{ isDirectory: () => boolean }>
  readonly isApplicationBundle: (path: string) => Promise<boolean>
  readonly confirmReveal: () => Promise<boolean>
  readonly openDirectory: (path: string) => void
  readonly revealItem: (path: string) => Promise<void>
}

/** 上游 :153 —— 保留签名;浏览器里没有文件管理器,直接返回。 */
export async function showFolderContents(
  _path: string,
  _dependencies?: IShowFolderContentsDependencies
): Promise<void> {
  console.info(
    '[dsh-git] showFolderContents:当前宿主没有系统文件管理器,已忽略。'
  )
}

/** 上游 :212 —— 在浏览器里唯一真实等价物是 `window.open`。 */
export const openExternal = (path: string) => {
  try {
    const opened = window.open(path, '_blank', 'noopener,noreferrer')
    return Promise.resolve(opened !== null)
  } catch {
    return Promise.resolve(false)
  }
}

/** 上游 :213 */
export const moveItemToTrash = (_path: string) => Promise.resolve(undefined)

/** 上游 :217 —— 浏览器里**有**真实等价物,就地实现。 */
export async function writeClipboardText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/** 上游 :228 */
export const getCurrentWindowState = () =>
  Promise.resolve({
    windowState: 'normal' as const,
    windowZoomFactor: 1,
  })

/** 上游 :231 */
export const getCurrentWindowZoomFactor = () => Promise.resolve(1)

/** 上游 :237 —— 对话框打开了,主进程会据此暂停快捷键。这里 no-op。 */
export const sendDialogDidOpen = sendProxy('dialog-did-open', 0)

/** 上游 :240 */
export const setWindowZoomFactor = sendProxy('set-window-zoom-factor', 1)

/** 上游 :243 */
export const checkForUpdates = (_force: boolean) =>
  Promise.resolve(undefined)

/** 上游 :246 */
export const quitAndInstallUpdate = sendProxy('quit-and-install-updates', 0)

/** 上游 :249 */
export const quitApp = sendProxy('quit-app', 0)

/**
 * 事件订阅族的公共形态:返回退订函数。浏览器里不注册监听,退订是 no-op。
 * 上游这些函数返回 `Disposable`(event-kit);这里返回同形的
 * `{ dispose(): void }`,调用方的 cleanup 逻辑照常工作。
 */
type DisposableLike = { dispose(): void }
function subscribeNoop(
  _eventHandler: (...args: ReadonlyArray<unknown>) => void
): DisposableLike {
  return { dispose() {} }
}

/** 上游 :252 */
export const onAutoUpdaterError = subscribeNoop
/** 上游 :260 */
export const onAutoUpdaterCheckingForUpdate = subscribeNoop
/** 上游 :266 */
export const onAutoUpdaterUpdateAvailable = subscribeNoop
/** 上游 :272 */
export const onAutoUpdaterUpdateNotAvailable = subscribeNoop
/** 上游 :278 */
export const onAutoUpdaterUpdateDownloaded = subscribeNoop
/** 上游 :283 */
export const onNativeThemeUpdated = subscribeNoop
/** 上游 :289 */
export const onShowInstallingUpdate = subscribeNoop

/** 上游 :294 */
export const setNativeThemeSource = sendProxy('set-native-theme-source', 1)

/** 上游 :297 —— 浏览器里**有**真实等价物,就地实现。 */
export const shouldUseDarkColors = () => {
  const query =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)')
      : null
  return Promise.resolve(query?.matches ?? false)
}

/** 上游 :300-309 */
export const minimizeWindow = sendProxy('minimize-window', 0)
export const maximizeWindow = sendProxy('maximize-window', 0)
export const restoreWindow = sendProxy('unmaximize-window', 0)
export const closeWindow = sendProxy('close-window', 0)

/** 上游 :312 */
export const isWindowMaximized = () => Promise.resolve(false)

/** 上游 :316 */
export const getAppleActionOnDoubleClick = () => Promise.resolve(null)

/** 上游 :325 */
export const showCertificateTrustDialog = sendProxy(
  'show-certificate-trust-dialog',
  1
)

/** 上游 :333 —— 浏览器里没有应用路径;返回 null 与上游「取不到」一致。 */
export const getPath = (_name: string) => Promise.resolve(null)

/** 上游 :338 */
export const getAppArchitecture = () => Promise.resolve('unknown')

/** 上游 :343 */
export const getAppPathProxy = () => Promise.resolve('')

/** 上游 :349 */
export const isRunningUnderARM64Translation = () => Promise.resolve(false)

/** 上游 :361-384:同步「即将退出」通知;浏览器里 no-op。 */
export function sendWillQuitSync() {}
export function sendWillQuitEvenIfUpdatingSync() {}
export function sendCancelQuittingSync() {}

/** 上游 :392 */
export const moveToApplicationsFolder = () => Promise.resolve(false)

/** 上游 :402 */
export const getAppMenu = sendProxy('get-app-menu', 0)

/**
 * 上游 :404 —— 弹原生右键菜单并**返回被选中项的下标路径**,用户取消时返回 `null`。
 * 这里解析为 `null`,正是上游 `lib/menu-item.ts:66` 判定的「取消」分支。
 */
export const invokeContextualMenu = (
  _items: ReadonlyArray<unknown>,
  _addSpellCheckMenu: boolean
) => Promise.resolve(null as ReadonlyArray<number> | null)

/** 上游 :407 */
export const updatePreferredAppMenuItemLabels = sendProxy(
  'update-preferred-app-menu-item-labels',
  1
)

/** 上游 :420 */
export const _reportUncaughtException = sendProxy('uncaught-exception', 1)

/** 上游 :422 —— 浏览器里有真实等价物:控制台。 */
export function reportUncaughtException(error: Error) {
  console.error('[dsh-git] uncaught exception', error)
}

/** 上游 :428 */
export function sendErrorReport(
  _error: Error,
  _extra: Record<string, string> = {},
  _nonFatal: boolean = false
): Promise<boolean> {
  return Promise.resolve(false)
}

/** 上游 :436 */
export const updateAccounts = sendProxy('update-accounts', 1)

/** 上游 :439 */
export const resolveProxy = (_url: string) => Promise.resolve(null)

/** 上游 :447 */
export const isInApplicationFolder = () => Promise.resolve(false)

/** 上游 :452-457 —— 浏览器里可用 `<input type=file>`;当前保留 null。 */
export const showSaveDialog = (_options: unknown) => Promise.resolve(null)
export const showOpenDialog = (_options: unknown) => Promise.resolve(null)

/** 上游 :460-461 */
export const saveGUID = (_guid: string) => Promise.resolve(undefined)
export const getGUID = () => Promise.resolve('')

/** 上游 :464 —— 浏览器里可用 Notification API;当前保留 false。 */
export const showNotification = (
  _title: string,
  _body: string,
  _silent: boolean
) => Promise.resolve(false)

/** 上游 :467 */
export const getNotificationsPermission = () => Promise.resolve(false)

/** 上游 :473 */
export const requestNotificationsPermission = () => Promise.resolve(false)

/** 上游 :479-480 */
export const installWindowsCLI = sendProxy('install-windows-cli', 0)
export const uninstallWindowsCLI = sendProxy('uninstall-windows-cli', 0)
