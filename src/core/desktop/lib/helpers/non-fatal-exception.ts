/**
 * **dsh-git 手写替身(shim)** —— 上游 `lib/helpers/non-fatal-exception.ts`(64 行)。
 *
 * 上游的语义是「把一个被捕获(但非致命)的异常送进非致命错误桶」,
 * 实现上做两件事:
 *  1. `getHasOptedOutOfStats()` 取自 `../stats/stats-store` —— 那是 Desktop 的
 *     遥测存储,属于目标文档 §1.3 明确**不沿用**的应用层
 *     (`lib/stores/**`、`lib/stats`),浏览器半也没有遥测后端;
 *  2. 真正的投递是 `process.emit('send-non-fatal-exception', ...)`,
 *     由主进程的监听者转发 —— 浏览器半没有 `process`。
 *
 * 这里保留上游的**导出名与调用签名**(`ExceptionKinds` 联合类型、
 * `sendNonFatalException(kind, error)`),语义降级为:
 *  - 仍然做上游那条**每分钟最多一条**的节流(`minIntervalBetweenNonFatalExceptions`),
 *    因为节流是这段代码自己的逻辑,与遥测无关;
 *  - 投递改成可替换的宿主钩子 `setNonFatalExceptionHost()`,默认实现只调
 *    `console.warn`。宿主(或以后接上真实上报)可以注入真正的消费者。
 *
 * 被谁用到(实证):`ui/lib/list/list.tsx:25`、`ui/lib/list/section-list.tsx:33`
 * —— 都是 `sendNonFatalException('invalidListSelection', ...)`,
 * 即「选区算不出下一行」这种不该崩整个列表的情况。
 * @module dsh-git/core/desktop/lib/helpers/non-fatal-exception
 */

let lastNonFatalException: number | undefined = undefined

/** Max one non fatal exeception per minute */
const minIntervalBetweenNonFatalExceptions = 60 * 1000

/** 上游逐字保留的类型联合。 */
export type ExceptionKinds =
  | 'invalidListSelection'
  | 'TooManyPopups'
  | 'remoteNameMismatch'
  | 'tutorialRepoCreation'
  | 'multiCommitOperation'
  | 'PullRequestState'
  | 'trampolineCommandParser'
  | 'trampolineServer'
  | 'PopupNoId'
  | 'FailedToStartPullRequest'
  | 'unhandledRejection'
  | 'rebaseConflictsWithBranchAlreadyUpToDate'
  | 'forkCreation'
  | 'NoSuggestedActionsProvided'
  | 'NoSuggestedActionsProvided'
  | 'resizeObserverLoopCompleted'
  | 'copilotConflictResolution'

/** 非致命异常的消费者签名,替代上游 `process.emit` 的监听者。 */
export type NonFatalExceptionHost = (
  kind: ExceptionKinds,
  error: Error
) => void

let host: NonFatalExceptionHost | null = null

/**
 * 注入非致命异常消费者(浏览器半没有主进程,所以由宿主决定怎么记)。
 * @param next - 新的消费者;传 `null` 恢复默认(只 `console.warn`)。
 */
export function setNonFatalExceptionHost(next: NonFatalExceptionHost | null) {
  host = next
}

/** 上游 `:41` —— 保留上游的节流,投递改为宿主钩子。 */
export function sendNonFatalException(kind: ExceptionKinds, error: Error) {
  const now = Date.now()

  if (
    lastNonFatalException !== undefined &&
    now - lastNonFatalException < minIntervalBetweenNonFatalExceptions
  ) {
    return
  }

  lastNonFatalException = now

  if (host !== null) {
    host(kind, error)
    return
  }

  console.warn(`[dsh-git] non-fatal exception (${kind})`, error)
}
