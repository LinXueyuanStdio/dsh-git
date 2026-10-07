/**
 * **dsh-git 替身(partial shim + 与上游一致的纯函数)** —— 上游
 * `lib/custom-integration.ts`(230 行)。
 *
 * ⚠️ 本文件**已经不只是 shim**:`WindowsExecutableExtensions` /
 * `TargetPathArgument` / `checkTargetPathArgument` / `parseCustomIntegrationArguments`
 * 几段是从上游**与上游一致**的纯函数,**会真的在浏览器半执行**(以前这个文件
 * 只被 `lib/app-state.ts` 做 **type-only** import,esbuild 会整份剥掉,所以它
 * 从来没进过打包图;Preferences 接线后 `ui/preferences/*` 是**值级** import
 * ⇒ 它现在真的进包、真的会被调用)。**不要把它当成「零运行期代码的替身」**。
 *
 * ## 上游那份为什么不能整份沿用
 *
 * 上游这一份是**探测并启动外部自定义集成**的宿主能力:
 * `:1-6` import `child_process`/`fs`/`fs/promises`/`path`/`util`/`string-argv`/
 * `windows-argv-parser`,函数体里 `exec`/`readFile`/`pathExists`/`lstat`/`access`/`spawn`,
 * 并且读 `__DARWIN__`/`__WIN32__` 构建期全局量。**浏览器半禁止 node 内置**
 * (目标文档 §2.3,`tsconfig.json` 的 `types: []` 就是这条的机器检查;
 * 而 client 侧 `paths` 只 alias 了 `path`/`url`/`fs/promises`,**没有 `child_process`**)。
 * 这些是 §2.4「host 取代」的职责,不是浏览器半该有的东西。
 *
 * ## 本文件必须保住的名字(两批,第二批是 Preferences 接线时补的)
 *
 * **第一批**(仓库列表 lane,`lib/app-state.ts:69`):`ICustomIntegration`(上游 `:22`,逐字)。
 *
 * **第二批**(Preferences ▸ Integrations 接线,2 个调用点):
 *
 * | 名字 | 上游 | 谁用 |
 * |---|---|---|
 * | `WindowsExecutableExtensions` | `:17` | `ui/preferences/custom-integration-form.tsx:9` |
 * | `TargetPathArgument` | `:20` | 同上 |
 * | `parseCustomIntegrationArguments` | `:36` | 同上 + `integrations.tsx` |
 * | `checkTargetPathArgument` | `:98` | 同上 |
 * | `validateCustomIntegrationPath` | `:121` | `custom-integration-form.tsx` |
 * | `isValidCustomIntegration` | `:158` | `ui/preferences/preferences.tsx:58`(onSave) |
 *
 * 其中 `WindowsExecutableExtensions` / `TargetPathArgument` /
 * `checkTargetPathArgument` 是**纯常量与纯函数**,与上游一致。
 *
 * ## 依赖账(这里是本项目唯一一处新增的三方依赖)
 *
 * | 包 | 状态 | 依据 |
 * |---|---|---|
 * | `string-argv` | **已装**,`package.json:93` = `^0.3.2` | 版本**取自上游** `references/desktop/app/package.json:66`(同样是 `^0.3.2`),不是随手挑的 |
 * | `windows-argv-parser` | **刻意不装** | 上游写的是 `file:../vendor/windows-argv-parser`(`references/desktop/vendor/` 里那份是**原生 C++ 插件**:`binding.gyp` + `main.cc`,`main` 指向需要 node-gyp 编译的 `build/index.js`)。我们只在下面那一处用到它的 Windows 分支,见下 |
 *
 * ⚠️ **教训(值得留在这里)**:上一次我写这份文件时,第 41 行的注释断言
 * 「`string-argv` 是真实依赖(`package.json` 已装)」—— **当时那句是假的**,
 * 而且正因为这个值级 import 第一次进了打包图,全仓 `node scripts/build.mjs`
 * 一度 `exit 1`(`Could not resolve "string-argv"`)。这正是目标文档 §3 失败模式 4/9
 * 「注释声称的行为 ≠ 代码实际行为」。**顺序必须是「先确认/装依赖,再让值级 import
 * 进打包图」**,反过来会挡住所有并发泳道。
 *
 * ## 一处必需的替代:`parseCustomIntegrationArguments` 的 Windows 分支
 *
 * 上游是 `__WIN32__ ? parseCommandLineArgv(args) : stringArgv(args)`。
 * 我们**不装** `windows-argv-parser`(理由见上表),所以两个分支都走
 * `stringArgv` —— 与上游 Linux/macOS 分支**同一实现**。差别只在「Windows 下用户
 * 写了 `windows-argv-parser` 独有引号语法」这一类输入上;而
 * `enableCustomIntegration()` 在我们的 feature-flag shim 里恒 `false`,
 * 这条输入路径当前不可达。**如实记录,不假装逐字等价。**
 *
 * ## 两处刻意省略(不假装实现)
 *
 * - `expandTargetPathArgument` / `migratedCustomIntegration` / `spawnCustomIntegration`:
 *   启动外部程序(`spawn`)属 host;前两个是纯函数但**当前零调用方**,
 *   需要时按 §10.3 补,而不是现在写一份没人测的实现。
 * - `validateCustomIntegrationPath` 的**磁盘检查**:上游要 `lstat` + `access(X_OK)`
 *   + macOS 的 `mdls` 取 bundle ID —— 浏览器半没有文件系统。这里保留**上游签名**,
 *   只做能在浏览器里真判断的部分(路径非空)。
 * @module dsh-git/core/desktop/lib/custom-integration
 */

import stringArgv from 'string-argv'

/**
 * File extensions that can be invoked directly by `spawn` on Windows. Other
 * common Windows launcher types (e.g. `.bat`, `.cmd`, `.ps1`) require a shell
 * to execute and are intentionally excluded.
 * —— 上游 `:17`,逐字。
 */
export const WindowsExecutableExtensions: ReadonlyArray<string> = ['exe', 'com']

/** The string that will be replaced by the target path in the custom integration arguments —— 上游 `:20`,逐字。 */
export const TargetPathArgument = '%TARGET_PATH%'

/** The interface representing a custom integration (external editor or shell) —— 上游 `:22`,逐字(含文档注释)。 */
export interface ICustomIntegration {
  /** The path to the custom integration */
  readonly path: string
  /** The arguments to pass to the custom integration */
  readonly arguments: string
  /** The bundle ID of the custom integration (macOS only) */
  readonly bundleID?: string
}

/**
 * Parse the arguments string of a custom integration into an array of strings.
 * —— 上游 `:36`;Windows 分支的替代见文件头。
 * @param args - The arguments string to parse.
 */
export function parseCustomIntegrationArguments(
  args: string
): ReadonlyArray<string> {
  return stringArgv(args)
}

/**
 * Check if the custom integration arguments contain the target path placeholder.
 * —— 上游 `:98`,逐字。
 * @param args - The custom integration arguments.
 */
export function checkTargetPathArgument(args: ReadonlyArray<string>): boolean {
  return args.some(arg => arg.includes(TargetPathArgument))
}

/**
 * Validate the path of a custom integration.
 * —— 上游 `:121` 的**浏览器等价签名版**(磁盘检查省略,见文件头)。
 * @param path - The path to the custom integration.
 */
export function validateCustomIntegrationPath(
  path: string
): Promise<{ isValid: boolean; bundleID?: string }> {
  return Promise.resolve({ isValid: path.length > 0 })
}

/**
 * Check if a custom integration is valid (meaning both the path and the
 * arguments are valid). —— 上游 `:158`(路径部分见上)。
 * @param customIntegration - The custom integration to validate.
 */
export async function isValidCustomIntegration(
  customIntegration: ICustomIntegration
): Promise<boolean> {
  const pathResult = await validateCustomIntegrationPath(
    customIntegration.path
  )
  const argv = parseCustomIntegrationArguments(customIntegration.arguments)
  return pathResult.isValid && checkTargetPathArgument(argv)
}
