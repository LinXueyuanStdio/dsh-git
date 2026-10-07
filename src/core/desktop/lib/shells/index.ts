/**
 * **dsh-git 手写替身(shim,纯类型)** —— 上游 `lib/shells/index.ts`(2 行)。
 *
 * ## 上游那份为什么不能直接沿用
 *
 * 上游 index 只有两行 `export *`:
 *
 * ```
 * export * from './shared'
 * export { ShellError } from './error'
 * ```
 *
 * 于是「能不能直接沿用」取决于被转出的 `./shared`(`lib/shells/shared.ts`,183 行):
 * 它 `import { ChildProcess } from 'child_process'`、import `./darwin`|`./win32`|`./linux`
 * (三者又各自 `exec-file`/`is-git-on-path`/`registry-js`/`app-path`)、`../path-exists`、
 * `../custom-integration`,并且用 `__DARWIN__`/`__WIN32__`/`__LINUX__` 构建期全局量。
 * **`child_process`/`app-path`/`registry-js` 在浏览器半不存在**(目标文档 §2.3),
 * 引进来会立刻制造 3 条 TS2307。所以这里只保留 app-state 需要的那一个名字。
 *
 * ## 本 shim 必须保住的名字
 *
 * 实证:镜像 `lib/app-state.ts:46` 写的是 `import { Shell } from './shells'`,
 * 只取 **`Shell`**(用在 `readonly selectedShell: Shell | null` 一类的字段上)。
 * 上游 `Shell` 的定义是 `lib/shells/shared.ts:10`:
 *
 * ```
 * export type Shell = Darwin.Shell | Win32.Shell | Linux.Shell
 * ```
 *
 * 所以本文件必须给出**三个平台枚举的并集**,而不是一个字符串字面量联合 ——
 * TypeScript 的字符串 enum 是**名义类型**,把 `Shell` 写成 `'Terminal' | …`
 * 会让上游代码里 `Darwin.Shell.Terminal` 这类赋值**改语义**(字面量可赋值 vs 不可)。
 * 下面三个 enum 的成员与值**与上游一致**自上游
 * `lib/shells/darwin.ts:13` / `win32.ts:22` / `linux.ts:13`,
 * 只把三个同名 `Shell` 改成局部名以避免冲突(它们上游分属三个模块)。
 *
 * **刻意省略**:`FoundShell`、`Default`、`launchShell`、`launchCustomShell`
 * (都依赖 `child_process`/`path-exists`)与 `ShellError`(上游 `./error`
 * 是 `class ShellError extends Error`,app-state 不需要)。
 * **除三个 enum 外零运行期代码**;`Shell` 之外无导出。
 *
 * ## 2026-10 追加(Preferences ▸ Integrations 页接线)
 *
 * 上游 `ui/preferences/integrations.tsx:6` 取 `{ Shell, parse as parseShell }`
 * 并把它用在**用户换 shell** 的事件里(`:188`)。缺 `parse` 不是「少个控件」,
 * 而是那个 `<Select>` 一改就 `parseShell is not a function`(运行期崩溃),
 * 所以这里按「保留上游导出名与签名」补上它 —— 见下面的实现说明。
 * `getAvailableShells` 同时补上(上游同文件 `:53`),返回空表(浏览器半探测不到
 * 本机 shell),与上游「一个都没找到」的分支一致。
 * @module dsh-git/core/desktop/lib/shells
 */

/** 上游 `lib/shells/darwin.ts:13`(成员与值逐字)。 */
enum DarwinShell {
  Terminal = 'Terminal',
  Hyper = 'Hyper',
  iTerm2 = 'iTerm2',
  PowerShellCore = 'PowerShell Core',
  Kitty = 'Kitty',
  Alacritty = 'Alacritty',
  Tabby = 'Tabby',
  WezTerm = 'WezTerm',
  Warp = 'Warp',
  Ghostty = 'Ghostty',
}

/** 上游 `lib/shells/win32.ts:22`(成员与值逐字)。 */
enum Win32Shell {
  Cmd = 'Command Prompt',
  PowerShell = 'PowerShell',
  PowerShellCore = 'PowerShell Core',
  Hyper = 'Hyper',
  GitBash = 'Git Bash',
  Cygwin = 'Cygwin',
  WSL = 'WSL',
  WindowsTerminal = 'Windows Terminal',
  FluentTerminal = 'Fluent Terminal',
  Alacritty = 'Alacritty',
  Warp = 'Warp',
}

/** 上游 `lib/shells/linux.ts:13`(成员与值逐字)。 */
enum LinuxShell {
  Gnome = 'GNOME Terminal',
  GnomeConsole = 'GNOME Console',
  Ptyxis = 'Ptyxis',
  Mate = 'MATE Terminal',
  Tilix = 'Tilix',
  Terminator = 'Terminator',
  Urxvt = 'URxvt',
  Konsole = 'Konsole',
  Xterm = 'XTerm',
  Terminology = 'Terminology',
  Deepin = 'Deepin Terminal',
  Elementary = 'Elementary Terminal',
  XFCE = 'XFCE Terminal',
  Alacritty = 'Alacritty',
  Kitty = 'Kitty',
  LXTerminal = 'LXDE Terminal',
  Warp = 'Warp',
  Ghostty = 'Ghostty',
}

/** 上游 `lib/shells/shared.ts:10` —— `Shell = Darwin.Shell | Win32.Shell | Linux.Shell`。 */
export type Shell = DarwinShell | Win32Shell | LinuxShell

/**
 * 上游 `lib/shells/shared.ts:38` —— 把下拉框里显示的**友好名**解析回 `Shell`。
 *
 * 上游按平台分派到 `Darwin.parse` / `Win32.parse` / `Linux.parse`,那三份各自
 * `switch` 一张「枚举值 → 枚举值」的表(见 `lib/shells/darwin.ts` 等)。
 * 而 `Shell` 是三个 enum 的**并集**,三个 enum 的**值与友好名逐字相同**
 * (本文件上面那三个 enum 就是从上游与上游一致的)⇒ 等价于在并集里查值。
 *
 * 为什么必须有这条:上游 `ui/preferences/integrations.tsx:6` 取
 * `{ Shell, parse as parseShell }`,并在用户换 shell 时(`:188`)调用它。
 * 缺了它就是 `parseShell is not a function`(运行期崩溃),不是「少个控件」。
 *
 * 与上游的**唯一**语义差异:查不到时上游抛
 * `Platform not currently supported for resolving shells` —— 那说的是**平台**
 * 不存在;这里平台是确定的(浏览器),查不到只能是「值不在枚举里」。
 * @param label - 下拉框的 value(= 上游的友好名)。
 */
export function parse(label: string): Shell {
  const all: ReadonlyArray<string> = [
    ...Object.values(DarwinShell),
    ...Object.values(Win32Shell),
    ...Object.values(LinuxShell),
  ]
  if (all.includes(label)) {
    return label as Shell
  }

  throw new Error(`Unknown shell: ${label}`)
}

/**
 * 上游 `lib/shells/shared.ts:53` —— 探测本机可用的 shell 列表。
 *
 * 浏览器半没有 `child_process` / `path-exists` / `registry-js`,**探测不到**
 * (不是「假装有一个」)。返回空表与上游「一个都没找到」的分支一致:
 * `ui/preferences/integrations.tsx:303` 的 `options.map` 渲染 0 个 `<option>`,
 * 用户仍可走 `enableCustomIntegration()` 的「Configure Custom Shell…」分支
 * (`lib/feature-flag.ts` 的 `enableCustomIntegration` 在我们这里恒 `true`)。
 */
export function getAvailableShells(): Promise<ReadonlyArray<Shell>> {
  return Promise.resolve([])
}
