/**
 * **dsh-git 手写替身(host 半)** —— 上游 `lib/hooks/with-hooks-env.ts`(105 行)。
 *
 * ## 上游那份在做什么
 *
 * 当 `opts.interceptHooks` 为真时,它把仓库里的 git hooks 抄到一个临时目录、
 * 起一个 `process-proxy` 原生进程替它们执行,并把 hooks 的 shell 环境
 * (`get-shell-env` → 用户偏好的 shell)注进 git 子进程。用到的都是宿主半
 * 没有的东西:`process-proxy`(原生二进制)、`net`/`fs/promises` 起本地服务、
 * `memoize-one` 的全局缓存。
 *
 * ## 宿主半今天怎么做 hooks
 *
 * `src/host/hooks-env.ts` + `src/host/git-runner.ts` 的 `mergeSpawnEnv()`:
 * 宿主在**执行缝**上给每次 git 调用合并一个 shell 环境(hooks 偏好),
 * 规则写在 `git-runner.ts` 的文件头(显式项赢、provider 抛错降级成不注入)。
 * 也就是说:**hooks 环境这件事宿主已经有了**,只是不在这个文件里。
 *
 * ## 本替身做什么
 *
 * 逐字保留上游签名,直接 `fn(opts?.env)` —— 也就是「本层不加任何东西」。
 * 这与上游在 `!opts?.interceptHooks || !getHooksEnvEnabled()` 时的**早退分支
 * 逐字相同**(上游 `:34-36`),所以它不是「编出来的行为」,而是上游那条
 * 早退路径本身。
 *
 * ⚠️ **诚实的缺口(必须记账)**:`interceptHooks` 为真时,宿主半**不会**
 * 拦截 hooks,git 会直接执行仓库里的 hook 脚本。宿主今天的行为**就是这样**
 * (没有 hook 拦截),所以这条接线**没有**让它变差;但它意味着
 * 「上游那套 hooks 沙箱」仍然是**未移植**的一块。
 *
 * ## 退役条件
 *
 * 宿主提供「拦截并代理仓库 hooks」的能力时,把本文件换回上游原文。
 * 判据:一个带 `pre-commit` hook 的仓库,`opts.interceptHooks` 为真时
 * hook 里能读到宿主注入的 shell 环境变量。
 *
 * @module dsh-git/host-mirror/lib/hooks/with-hooks-env
 */

import type { IGitExecutionOptions } from '../git/core'

/**
 * 上游签名的宿主版本:不做 hooks 拦截,只把调用方的 env 交下去。
 *
 * ⚠️ `IGitExecutionOptions` 是**从 `../git/core` 取的类型**,不是本文件重声明的:
 * 重声明会造出一个结构上「看起来一样」的别名,而 `core.ts:385` 传进来的那个
 * 是 dugite 扩展过的版本 —— 实测两者不互相可赋值(TS2345),那是替身自己造出来的
 * 假错。类型循环(`core` ⇄ `with-hooks-env`)在 TS 里是允许的,而且**只在类型层**。
 *
 * @param fn - 接收 hooks 环境(或 `undefined`)的续体。
 * @param _path - 仓库路径(上游用它找 hooks;宿主半不使用)。
 * @param opts - 上游的 git 执行选项。
 * @returns `fn` 的返回值。
 */
export async function withHooksEnv<T>(
  fn: (env: Record<string, string | undefined> | undefined) => Promise<T>,
  _path: string,
  opts: IGitExecutionOptions | undefined
): Promise<T> {
  return fn(opts?.env);
}
