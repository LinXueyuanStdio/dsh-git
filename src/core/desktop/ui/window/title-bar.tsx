/**
 * **dsh-git 手写替身(shim)** —— 上游 `app/src/ui/window/title-bar.tsx`(约 300 行)。
 *
 * 上游这个文件是**无边框 Electron 窗口的自绘标题栏**:`TitleBar` React 组件 +
 * 最小化/最大化/关闭按钮(经 `ui/main-process-proxy` 发 IPC)+ `WindowState` 模型。
 * 本插件是宿主网页里的一个侧栏面板,**没有自己的窗口**,所以整个组件不搬。
 *
 * 唯一被 diff 子系统用到的导出是 `getTitleBarHeight()`
 * (实证:`ui/dialog/dialog.tsx:5` 导入、`:57` 调用),它是**纯函数**,
 * 这里逐字保留(上游 :17-31),只把 `__DARWIN__` 换成 `lib/get-os.ts` 的同口径判断。
 *
 * 有意不导出:`TitleBar`。它在浏览器里没有对应物;留着「什么都不画的 TitleBar」
 * 比让引用它的代码编译失败更糟(会静默得到一个空标题栏)。
 * @module dsh-git/core/desktop/ui/window/title-bar
 */

import { isMacOSBigSurOrLater, isMacOSTahoeOrLater } from '../../lib/get-os'

function isDarwin(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    /Mac|iPhone|iPad/.test(navigator.platform ?? navigator.userAgent)
  )
}

/** Get the height (in pixels) of the title bar depending on the platform */
export function getTitleBarHeight() {
  if (isDarwin()) {
    if (isMacOSTahoeOrLater()) {
      // Tahoe also has taller title bars, see #21135
      return 32
    } else if (isMacOSBigSurOrLater()) {
      // Big Sur has taller title bars, see #10980
      return 26
    } else {
      return 22
    }
  }

  return 28
}
