/**
 * **dsh-git 手写替身(host 半)** —— 上游 `lib/trampoline/trampoline-environment.ts`(222 行)。
 *
 * ## 上游那份在做什么
 *
 * 它是 GitHub Desktop **自带的一份 git 凭据助手**的入口:
 * `trampolineServer` 起一个本地 http 服务,`withTrampolineEnv` 把
 * `DESKTOP_PORT` / `DESKTOP_TRAMPOLINE_TOKEN` / `GIT_ASKPASS=''` /
 * `GIT_CONFIG_PARAMETERS='credential.helper=' 'credential.helper=desktop'` /
 * `GIT_USER_AGENT` 注进 git 子进程的环境里,于是 `git fetch/push` 会回来问
 * Electron 主进程要凭据。它还管 SSH askpass 与 passphrase 的暂存。
 *
 * 它的闭包是 `desktop-trampoline`(一个**原生二进制**)、`../ssh/*`、
 * `dugite` 的 `resolveGitBinary`、`memoize-one` —— 宿主半**一样都没有**,
 * 而且**不该有**:本仓的凭据注入是另一套,已经存在
 * (`src/host/credential-bridge.ts` + `src/host/git-service.ts` 的 `credentialEnv()`,
 * 它给的是 `GIT_ASKPASS` / `GIT_TERMINAL_PROMPT` 一族的环境变量)。
 *
 * ## 本替身怎么「接线」而不是「静默返回空」
 *
 * 一个静默返回 `{}` 的替身会让**每一次**远端操作都退化成「无凭据」,
 * 而那是**看不出来**的(私有仓库会报认证失败,公开仓库照样成功)。
 * 所以这里给一个**显式的注入点** {@link setTrampolineEnvProvider}:
 * 宿主启动时把自己的凭据环境注册进来,`withTrampolineEnv` 每次调用都问它。
 * 没有注册时,退回 `customEnv`(上游签名里的第 4 参)。
 *
 * ## 诚实边界(逐条)
 *
 * 1. **不复现 SSH askpass**:上游的 `SSH_ASKPASS` / `DESKTOP_TRAMPOLINE_*`
 *    一个都不设。宿主半今天也不设 —— 依赖系统 ssh agent / 系统 askpass。
 * 2. **不复现 passphrase 暂存**:那是 trampoline token 的配套状态,宿主没有。
 * 3. **不复现 `GIT_ASKPASS=''`**:上游把它设成空串以禁用 askpass(改走
 *    credential helper)。本替身**不**设它 —— 宿主半要的正是**相反的**行为
 *    (用 `git-service` 注入的 `GIT_ASKPASS` 脚本)。这是**刻意的语义差异**,
 *    不是遗漏:谁要 trampoline 的语义,谁就得把整个 trampoline 抄进来。
 * 4. `isBackgroundTask` 参数**接受但不使用**(上游用它决定失败时是否杀凭据);
 *    宿主没有那套状态。
 *
 * ## 退役条件
 *
 * 宿主半把凭据注入统一到一条机制上(要么全走 `credentialEnv`,要么做一份真的
 * 原生凭据助手)之后,本文件应当消失 —— 也就是 `core.ts` 不再需要「trampoline」
 * 这个名字的那一天。判据:私有远端(需要 token)的 fetch/push 能成功,
 * 且 `git` 子进程的环境里**没有** `DESKTOP_TRAMPOLINE_TOKEN`。
 *
 * @module dsh-git/host-mirror/lib/trampoline/trampoline-environment
 */

/** 宿主的凭据环境提供者:给定仓库路径与是否后台任务,返回要注入 git 的环境变量。 */
export type TrampolineEnvProvider = (
  path: string,
  isBackgroundTask: boolean
) => Promise<Record<string, string | undefined>>;

let provider: TrampolineEnvProvider | null = null;

/**
 * 注册宿主的凭据环境提供者(宿主启动时调一次)。
 *
 * @param next - 提供者;传 `null` 注销(探针用它做阴性对照)。
 */
export function setTrampolineEnvProvider(
  next: TrampolineEnvProvider | null
): void {
  provider = next;
}

/**
 * 当前是否已经接上一个真实的凭据环境提供者。
 *
 * 为什么要有这个读数:探针要能**在同一帧**里区分「宿主接上了」与
 * 「替身静默返回空」两档 —— 只看 fetch 成功是分不出来的(公开远端两档都成功)。
 *
 * @returns 是否已注册。
 */
export function hasTrampolineEnvProvider(): boolean {
  return provider !== null;
}

/**
 * 上游签名的宿主版本:算出要注入 git 子进程的环境变量。
 *
 * @param fn - 接收 env 的续体(上游在 `lib/git/core.ts` 里把它并进 dugite 的 `env`)。
 * @param path - 仓库路径(交给 {@link TrampolineEnvProvider})。
 * @param isBackgroundTask - 是否后台任务(交给 provider;未注册时忽略)。
 * @param customEnv - 上游的第 4 参:调用方已经算好的环境(优先级**低于** provider)。
 * @returns `fn` 的返回值。
 */
export async function withTrampolineEnv<T>(
  fn: (env: object) => Promise<T>,
  path: string,
  isBackgroundTask = false,
  customEnv?: Record<string, string | undefined>
): Promise<T> {
  const injected = provider === null ? {} : await provider(path, isBackgroundTask);
  return fn({ ...customEnv, ...injected });
}
