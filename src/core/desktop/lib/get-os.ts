/**
 * **dsh-git 手写替身(shim)** —— 上游 `app/src/lib/get-os.ts`(109 行)。
 *
 * 上游用 `node:os` 的 `release()` 与 Electron 的 `process.getSystemVersion()` 取系统版本,
 * 再用 `compare-versions` 做区间判断,喂给一堆 `isMacOS<名字>` 谓词。浏览器半
 * 既没有 `os` 也没有 Electron,但**有 `navigator.userAgent`** —— 而这一族谓词
 * 唯一的用途就是「这台的 macOS 够不够新」,UA 里的 `Mac OS X 10_15_7` 足以判断。
 *
 * 因此这里保留**全部同名导出**:
 *  - `getOS()`:UA 里认出 macOS / Windows / Linux,与上游字符串口径一致;
 *  - `isMacOS*`:按 UA 的 Darwin 主版本判断(macOS 11 = Darwin 20,依此类推);
 *  - `isWindows*`:UA 里认 Windows,版本拿不到时返回 `false`(不误报);
 *  - `is*NoLongerSupportedByElectron`:恒 `false`(我们不是 Electron)。
 *
 * 调用点不变(实证:`ui/lib/popover.tsx:20` 取 `isMacOSSequoia/isMacOSSonoma/
 * isMacOSVentura`;`ui/dialog/dialog.tsx:7` 取 `isMacOSSonomaOrLater/isMacOSVentura`)。
 * @module dsh-git/core/desktop/lib/get-os
 */

/** 从 UA 里抽出 macOS 的 Darwin 主版本(拿不到返回 0)。 */
function darwinMajorVersion(): number {
  if (typeof navigator === 'undefined') return 0
  const ua = navigator.userAgent
  const m = /Mac OS X (\d+)[._](\d+)/.exec(ua)
  if (m === null) return 0
  const major = Number(m[1])
  // 第二个捕获组(小版本)刻意不取:macOS 10.x 的 Darwin 主版本恒为 10,
  // 11 起只看主版本(+9)。曾经写过 `const minor = Number(m[2])` 但从未使用,
  // 已删除(理由见 docs/lint-layer.md §8.1)。
  // macOS 11 起 Darwin 主版本 = macOS 主版本 + 9;10.x 则 Darwin = 10.x
  return major >= 11 ? major + 9 : 10
}

function isMac(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    /Mac|iPhone|iPad/.test(navigator.platform ?? navigator.userAgent)
  )
}

function isWindows(): boolean {
  return typeof navigator !== 'undefined' && /Win/.test(navigator.platform ?? '')
}

function isLinux(): boolean {
  return typeof navigator !== 'undefined' && /Linux/.test(navigator.platform ?? '')
}

/**
 * 上游 :30 —— 返回人类可读的系统名。上游用的是 `os.platform()` 的映射,
 * 这里用 UA 的同义判断。
 */
export function getOS(): string {
  if (isMac()) return 'macOS'
  if (isWindows()) return 'Windows'
  if (isLinux()) return 'Linux'
  return 'Unknown'
}

/** Darwin 20 = macOS 11 Big Sur;24 = macOS 15 Sequoia;25 = macOS 26 Tahoe。 */
const macAtLeast = (darwinMajor: number) => () => isMac() && darwinMajorVersion() >= darwinMajor

export const isMacOSVentura = macAtLeast(22)
export const isMacOSSonoma = macAtLeast(23)
export const isMacOSSequoia = macAtLeast(24)
export const isMacOSSonomaOrLater = macAtLeast(23)
export const isMacOSCatalinaOrEarlier = () => isMac() && darwinMajorVersion() <= 19
export const isMacOSMojaveOrLater = macAtLeast(18)
export const isMacOSBigSurOrLater = macAtLeast(20)
export const isMacOSTahoeOrLater = macAtLeast(25)

// 上游这几个都基于 Windows 的具体 build 号,UA 里拿不到 → 不误报,返回 false。
export const isWindows10And1809Preview17666OrLater = () => false
export const isWindowsAndNoLongerSupportedByElectron = () => false
export const isMacOSAndNoLongerSupportedByElectron = () => false
export const isOSNoLongerSupportedByElectron = () => false
