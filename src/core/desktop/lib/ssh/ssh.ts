/**
 * **dsh-git 手写替身(shim,纯函数)** —— 上游 `lib/ssh/ssh.ts`(87 行)。
 *
 * ## 上游那份为什么不能直接沿用
 *
 * 上游 import `memoize-one`、`../path-exists`(node `fs/promises`)、
 * `../local-storage` 与 **`../trampoline/trampoline-environment`**。
 * 最后那个是 Desktop 的 SSH askpass 蹦床(生成临时脚本、写磁盘、注入
 * `SSH_ASKPASS`),依赖 `fs`/`path`/`child_process` —— 目标文档 §1.3 明确把
 * `lib/trampoline` 列为**不沿用**;浏览器半也没有文件系统(§2.3)。
 *
 * ## 本 shim 必须保住的名字
 *
 * 实证:Preferences 的 Advanced 页(`ui/preferences/advanced.tsx:6`)只取
 * **一个**名字:`isWindowsOpenSSHAvailable()`。
 *
 * | 本 shim 的导出 | 上游位置 | 语义 |
 * |---|---|---|
 * | `UseWindowsOpenSSHKey` | `:11` | localStorage 键名,逐字 |
 * | `isWindowsOpenSSHAvailable` | `:13` | 浏览器半恒 `false` |
 * | `getSSHEnvironment` | `:44` | 浏览器半恒 `{}`(无蹦床路径可注入) |
 * | `parseAddSSHHostPrompt` | `:72` | 纯正则函数,**与上游一致** |
 *
 * **为什么 `isWindowsOpenSSHAvailable` 恒 `false` 是**正确语义**而不是降级**:
 * 上游的实现第一步就是
 * `if (!__WIN32__) { return false }`(`:14-16`),然后 `process.arch === 'arm64'`
 * 再返回 false,最后才去 `pathExists('C:/Windows/System32/OpenSSH/ssh.exe')`。
 * 浏览器半既没有 Windows 主机路径探测能力、也没有 `process.arch`,
 * 所以「探测不到」= `false` 与上游在非 Windows 上的行为**逐字一致**。
 * 于是 Advanced 页的「Use system OpenSSH」那一栏在浏览器里**本来就不渲染**
 * (上游 `advanced.tsx:158` 的 `if (!this.state.canUseWindowsSSH) return null`),
 * 这是上游自己的分支,不是我们遮掉了控件。
 * @module dsh-git/core/desktop/lib/ssh/ssh
 */

/** 上游 `:11` —— `useWindowsOpenSSH` 的 localStorage 键,逐字。 */
export const UseWindowsOpenSSHKey: string = 'useWindowsOpenSSH'

/**
 * 上游 `:13` —— 「这台机器有没有系统 OpenSSH 可执行文件」。
 * 浏览器半没有平台探测能力,恒 `false`(与上游非 Windows 分支一致,见文件头)。
 */
export function isWindowsOpenSSHAvailable(): Promise<boolean> {
  return Promise.resolve(false)
}

/**
 * 上游 `:44` —— 返回 SSH 相关的环境变量。
 * 浏览器半没有蹦床 askpass 路径可注入,返回空环境(调用方按「无附加变量」处理)。
 */
export function getSSHEnvironment(): Promise<Record<string, string>> {
  return Promise.resolve({})
}

/**
 * 上游 `:72` —— 从 `ssh` 的交互提示里解析出要追加的 host key。
 * **纯函数,与上游一致**(无任何 node/Electron 依赖)。
 * @param prompt - ssh 进程输出里的提示文本。
 */
export function parseAddSSHHostPrompt(prompt: string) {
  const promptRegex =
    /^The authenticity of host '([^ ]+) \(([^\)]+)\)' can't be established[^.]*\.\n([^ ]+) key fingerprint is ([^.]+)\./

  const matches = promptRegex.exec(prompt)
  if (matches === null || matches.length < 5) {
    return null
  }

  return {
    host: matches[1],
    ip: matches[2],
    keyType: matches[3],
    fingerprint: matches[4],
  }
}
