/**
 * **dsh-git 手写替身(shim)** —— 上游 `app/src/lib/highlighter/worker.ts`(88 行)。
 *
 * 上游 `new Worker(...)` 起一个 Electron 渲染进程 worker,把 CodeMirror 模式的
 * 词法分析放到另一个线程;worker 文件 `lib/highlighter/worker.ts` 自己又 import
 * `node:path` 与 `./types`。浏览器半里起 worker 需要打包器支持 `new Worker(new URL(...))`,
 * 而我们没有把 CodeMirror 的词法表搬过来 —— 所以这里保留**同名同签名**的 `highlight()`,
 * 返回空 token 表 `{}`(= 上游 `worker.ts:39-41` 在「没有内容或没有需要的行」时的
 * 返回值,即**不高亮**),调用方 `syntax-highlighting/index.ts` 会走它原有的
 * 「没有 token」分支。
 *
 * 也就是说:接口保留、调用点保留、降级路径是上游自己的路径;只是当前不产出高亮。
 * 要接通真高亮,把 CodeMirror 模式表与 worker 打包进来后替换本文件即可。
 * @module dsh-git/core/desktop/lib/highlighter/worker
 */

import type { ITokens } from './types'

/**
 * 上游 :30 —— `(contentLines, basename, extension, tabSize, lines) => Promise<ITokens>`。
 * 返回 `{}` 表示这一行没有 token。
 */
export function highlight(
  contentLines: ReadonlyArray<string>,
  _basename: string,
  _extension: string,
  _tabSize: number,
  lines: Array<number>
): Promise<ITokens> {
  if (!contentLines.length || !lines.length) {
    return Promise.resolve({})
  }

  // 词法器尚未接进来:显式留一行日志,避免「高亮静默不生效」难以发现。
  console.info(
    `[dsh-git] highlighter.worker.highlight:词法器未接入,${lines.length} 行将不高亮。`
  )
  return Promise.resolve({})
}
