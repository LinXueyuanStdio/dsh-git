/**
 * **dsh-git 手写替身(shim)** —— 上游 `app/src/lib/app-shell.ts`(64 行)的浏览器版。
 *
 * 上游直接 `import { shell as electronShell } from 'electron'` 并把 `shell.beep` /
 * `shell.openPath` 接到 Electron;`moveItemToTrash` / `openExternal` /
 * `showItemInFolder` / `showFolderContents` 全部走 `ui/main-process-proxy` 的 IPC。
 * 浏览器半没有 Electron,所以这里**保留同名 API**,把「打开外部链接」接到
 * `window.open`(唯一浏览器里真能做的那个),其余降级为 no-op 并留下日志。
 *
 * 被谁用到(实证):`ui/lib/link-button.tsx:2` 只取 `shell`。
 * 功能没有被删除:调用点仍在,等宿主提供 `revealItem`/`openExternal` 的实现时
 * 只要在这里换成宿主回调即可。
 * @module dsh-git/core/desktop/lib/app-shell
 */

import type { Repository } from '../models/repository'

/** 与上游同形(上游 `lib/app-shell.ts:11-47` 的 `IAppShell`)。 */
export interface IAppShell {
  readonly moveItemToTrash: (path: string) => Promise<void>
  readonly beep: () => void
  readonly openExternal: (path: string) => Promise<boolean>
  readonly openPath: (path: string) => Promise<string>
  readonly showItemInFolder: (path: string) => void
  readonly showFolderContents: (path: string) => void
}

function logUnsupported(what: string, detail: string) {
  console.info(`[dsh-git] app-shell.${what} 在当前宿主里不可用(${detail}),已忽略。`)
}

export const shell: IAppShell = {
  moveItemToTrash: async (path: string) => {
    logUnsupported('moveItemToTrash', path)
  },
  beep: () => {},
  openExternal: async (path: string) => {
    // 浏览器里唯一真实等价物:新窗口/新标签打开。被 link-button 用于「在浏览器里打开」。
    try {
      const opened = window.open(path, '_blank', 'noopener,noreferrer')
      return opened !== null
    } catch {
      return false
    }
  },
  openPath: async (path: string) => {
    logUnsupported('openPath', path)
    return ''
  },
  showItemInFolder: (path: string) => {
    logUnsupported('showItemInFolder', path)
  },
  showFolderContents: (path: string) => {
    logUnsupported('showFolderContents', path)
  },
}

/**
 * 上游同名函数:把仓库内相对路径拼成绝对路径再交给文件管理器。
 * 浏览器里没有文件管理器,保留拼路径 + 转交 `shell.showItemInFolder` 的形状。
 */
export function revealInFileManager(repository: Repository, path: string) {
  const joined =
    repository.path.endsWith('/') || path.startsWith('/')
      ? `${repository.path}${path}`
      : `${repository.path}/${path}`
  return shell.showItemInFolder(joined)
}
