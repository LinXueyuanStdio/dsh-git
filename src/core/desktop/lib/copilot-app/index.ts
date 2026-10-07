/**
 * **dsh-git 手写替身(shim)** —— 上游 `lib/copilot-app/index.ts`(155 行)。
 *
 * ## 上游那份为什么不能直接沿用
 *
 * 上游 import `path`(`isAbsolute`)、`../exec-file`(`child_process`)、
 * `../path-exists`(`fs/promises`)、`./darwin` / `./win32`(各自 `app-path` /
 * `registry-js` / `os` / `execFile`)。这些都是 node/Electron 能力,
 * 浏览器半按 §2.3 不存在;而且 Copilot 本身被用户明确排除(§1.3 + 本次任务书),
 * `lib/copilot*` 三处归另一条线所有。
 *
 * ## 本 shim 必须保住的名字
 *
 * 实证,两个调用点:
 *  - `ui/preferences/integrations.tsx:18` 取 `copilotAppMarketingUrl`(常量,
 *    渲染在 `enableCopilotAppHandoff()` 为真时的链接上);
 *  - `ui/preferences/preferences.tsx:87` 取 `validateCopilotAppPath`(`onSave` 里)。
 *
 * | 本 shim 的导出 | 上游位置 | 形态 |
 * |---|---|---|
 * | `copilotAppMarketingUrl` | `:8` | 字符串常量,**逐字** |
 * | `CopilotAppError` | `:15` | 错误类,逐字(纯 JS,无依赖) |
 * | `CopilotAppErrorKind` | `:10` | 字面量联合,逐字 |
 * | `ICopilotAppDependencies` | `:25` | 依赖注入接口,逐字 |
 * | `createCopilotAppIntegration` | `:61` | 纯函数工厂,**与上游一致** |
 * | `validateCopilotAppPath` | `:150` | 恒 `false`(见下) |
 * | `findCopilotApp` | `:147` | 恒 `null`(见下) |
 * | `openInCopilotApp` | `:153` | 抛 `not-found`(见下) |
 *
 * `createCopilotAppIntegration` 与上游一致:它本身就是**依赖注入**形状
 * (上游刻意把 OS 能力做成 `deps`),所以它不含任何 node 调用,可以整段保留字节。
 *
 * **为什么三个顶层导出返回「找不到」而不是降级成别的**:
 * 上游把「能不能用 Copilot App 交接」交给 `lib/feature-flag.ts` 的
 * `enableCopilotAppHandoff()`,我们的 shim 里它恒 **`false`**
 * (上游在非 `__DEV__` 时同样走 `enableDevelopmentFeatures()` ⇒ false)。
 * 于是 `preferences.tsx:1022-1035` 的整段校验分支**不可达**,
 * `integrations.tsx:388` 的 `renderCopilotAppHandoff()` 也直接 return null。
 * 「探测不到安装」正是这些不可达分支该有的返回值。
 * @module dsh-git/core/desktop/lib/copilot-app
 */

/** 上游 `:8`,逐字。 */
export const copilotAppMarketingUrl =
  'https://gh.io/app?utm_source=github_desktop_app'

/** 上游 `:10`,逐字。 */
type CopilotAppErrorKind = 'not-found' | 'launch-failed'

/** 上游 `:15`,逐字。 */
export class CopilotAppError extends Error {
  public constructor(
    public readonly kind: CopilotAppErrorKind,
    message: string
  ) {
    super(message)
    this.name = 'CopilotAppError'
  }
}

/** 上游 `:25`,逐字。 */
export interface ICopilotAppDependencies {
  readonly findAppCandidates: () => Promise<ReadonlyArray<string>>
  readonly getExecutable: (path: string) => string | null
  readonly isAbsolutePath: (path: string) => boolean
  readonly pathExists: (path: string) => Promise<boolean>
  readonly run: (
    executable: string,
    args: ReadonlyArray<string>,
    timeout: number
  ) => Promise<{ readonly stdout: string; readonly stderr: string }>
}

/**
 * 上游 `:61`,**与上游一致** —— 这个工厂只消费注入进来的 `deps`,自身不含
 * node/Electron 调用,所以浏览器半可以直接用(它正是上游为可测性做的拆层)。
 */
export function createCopilotAppIntegration(deps: ICopilotAppDependencies) {
  async function validateCopilotAppPath(path: string): Promise<boolean> {
    const executable = deps.getExecutable(path)
    return executable !== null && (await deps.pathExists(executable))
  }

  async function findCopilotApp(): Promise<string | null> {
    for (const candidate of await deps.findAppCandidates()) {
      if (await validateCopilotAppPath(candidate)) {
        return candidate
      }
    }
    return null
  }

  async function openInCopilotApp(
    appPath: string,
    repositoryPath: string
  ): Promise<void> {
    const executable = deps.getExecutable(appPath)
    if (executable === null || !(await deps.pathExists(executable))) {
      throw new CopilotAppError(
        'not-found',
        'GitHub Copilot could not be found.'
      )
    }
    if (!deps.isAbsolutePath(repositoryPath) || repositoryPath.includes('\0')) {
      throw new CopilotAppError(
        'launch-failed',
        'The repository path must be absolute.'
      )
    }

    try {
      await deps.run(executable, ['open', repositoryPath], 30000)
    } catch (error) {
      throw new CopilotAppError(
        isMissingExecutable(error) ? 'not-found' : 'launch-failed',
        `Could not open the repository in GitHub Copilot. ${errorDetail(error)}`
      )
    }
  }

  return { findCopilotApp, validateCopilotAppPath, openInCopilotApp }
}

/** 上游 `:47`,逐字。 */
function errorDetail(error: unknown): string {
  if (error instanceof Error) {
    if (
      'stderr' in error &&
      typeof error.stderr === 'string' &&
      error.stderr.trim()
    ) {
      return error.stderr.trim()
    }
    return error.message
  }
  return 'The command could not be completed.'
}

/** 上游 `:57`,逐字。 */
function isMissingExecutable(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

/**
 * 浏览器半没有「发现磁盘上的 GitHub Copilot App」的能力
 * (上游靠 `app-path` / `registry-js` 枚举安装位置)。
 */
const integration = createCopilotAppIntegration({
  findAppCandidates: () => Promise.resolve([]),
  getExecutable: () => null,
  isAbsolutePath: (path: string) => path.startsWith('/'),
  pathExists: () => Promise.resolve(false),
  run: () =>
    Promise.reject(new CopilotAppError('not-found', 'not available in browser')),
})

/** 上游 `:147` —— 浏览器半恒「找不到」。 */
export const findCopilotApp = integration.findCopilotApp

/**
 * 上游 `:150` —— 校验所选 `.app`/`.exe` 在磁盘上存在。
 * 浏览器半没有磁盘访问,恒 `false`;调用点被 `enableCopilotAppHandoff()`
 * 恒 `false` 挡住(见文件头),所以这个返回值不会变成用户可见的报错。
 */
export const validateCopilotAppPath = integration.validateCopilotAppPath

/** 上游 `:153` —— 把仓库交给 Copilot App;浏览器半保持 `not-found` 语义。 */
export const openInCopilotApp = integration.openInCopilotApp
