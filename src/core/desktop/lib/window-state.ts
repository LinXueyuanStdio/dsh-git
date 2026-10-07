/**
 * **dsh-git 手写替身(shim,纯类型)** —— 上游 `lib/window-state.ts`(64 行)。
 *
 * ## 上游那份为什么不能直接沿用
 *
 * 上游 `:1` 就 `import * as ipcWebContents from '../main-process/ipc-webcontents'`,
 * 两个导出函数 `getWindowState(window: Electron.BrowserWindow)` /
 * `registerWindowStateChangedEvents(window)` 签名里直接写着 **`Electron.BrowserWindow`**,
 * 并调用 `window.isFullScreen()`/`window.on('maximize', …)`/`webContents.send`。
 * `main-process/**` 与 **Electron** 都是目标文档 §1.3 明确不沿用的部分,
 * 而且浏览器半连 `Electron` 这个全局命名空间都没有(§2.3)。
 *
 * ## 本 shim 必须保住的名字
 *
 * 实证:镜像 `lib/app-state.ts:45` 写的是 `import { WindowState } from './window-state'`,
 * 只取 **`WindowState`** —— 上游 `:3-8` 的**纯字符串字面量联合**,与上游一致如下。
 *
 * **刻意省略**:`getWindowState` 与 `registerWindowStateChangedEvents`(Electron + ipc);
 * 以及它们在 `docs/storage-tables-design.md` §2.3 F 的结论里本就登记为
 * 「窗口几何不存在(浏览器 half)」的那一族状态。
 * **零运行期代码**,只有这一个类型导出。
 * @module dsh-git/core/desktop/lib/window-state
 */

/** 上游 `lib/window-state.ts:3-8`,逐字。 */
export type WindowState =
  | 'minimized'
  | 'normal'
  | 'maximized'
  | 'full-screen'
  | 'hidden'
