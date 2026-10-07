/**
 * **网络动作在飞时的 git 进度源**（宿主半）—— 上游 `lib/progress/**` 的采纳点。
 *
 * ## 为什么解析在宿主半
 *
 * 上游把这件事放在 Electron 主进程里：`lib/progress/from-process.ts:19-46` 的
 * `executionOptionsWithProgress()` 拿一个**解析器**去读子进程的 stderr，
 * 逐行 `parser.parse(line)`，把结果交给 `app-store.ts` 的
 * `updatePushPullFetchProgress()`（`:5168`）。
 *
 * 我们这一侧的子进程也在宿主半（`ctx.subprocess`），所以**解析必须在这儿**。这不是
 * 口味问题，是一条硬约束：
 *
 * - 上游解析器 `src/core/desktop/lib/progress/git.ts:1` 有
 *   `import { stripVTControlCharacters } from 'util'`；
 * - 浏览器半产物只允许 4 个 require 家族（`path` / `url` / `fs/promises` / `os`
 *   四个 shim，见 `scripts/build.mjs` 的 `clientAlias`）。
 *
 * 把解析器搬进客户端会给产物加第 5 个家族。所以宿主只把**解析好的那一行**送出去
 * （`description` + `value`），客户端继续持有它自己的 `Progress` 形状与中文标题
 * （`src/client/store.ts` 的 `updateSyncProgress`）—— 标题只有一份，就是客户端那份。
 *
 * ## 与上游的逐条对照
 *
 * | 上游 | 这里 |
 * |---|---|
 * | `lib/progress/push.ts:7-11` 的三步权重 | {@link createSyncProgressParser} 的 `push` 一档（**与上游一致**，未改） |
 * | `lib/progress/fetch.ts:7-11` | `fetch` 一档 |
 * | `lib/progress/pull.ts:11-16` | `pull` 一档 |
 * | `lib/git/push.ts:77-99` 的 `progressCallback` | {@link createSyncProgressLineSink}：`kind==='progress'` 取 `details.text`，`context` 取 `text`；`value` 取 `percent` |
 * | `lib/git/push.ts:78` 的 `args.push('--progress')` | 各 `*Argv()` 的 `progress: true`（`src/core/git-argv.ts`） |
 * | `lib/progress/from-process.ts:91` 的 `byline(process.stderr).on('data', …)` | `src/host/git-runner.ts` 的 `onStderrLine`（分词规则逐条对齐 byline，见那里的注释） |
 *
 * ## 不复现什么（诚实边界）
 *
 * - **LFS 进度**：上游 `from-process.ts:26-86` 会写 `GIT_LFS_PROGRESS` 临时文件并
 *   `tailByLine` 它（`lib/progress/lfs.ts`）。我们不做 LFS 进度 —— 那需要临时文件 +
 *   轮询，而本仓的 LFS 路径没有镜像。影响：装了 LFS 的仓库在 LFS 过滤阶段仍然显示
 *   git 自己的 `Filtering content` 行，而不是 LFS 的字节百分比。
 * - **`--progress` 之外的进度**：上游 clone/checkout/revert 各有解析器
 *   （`lib/progress/{clone,checkout,revert}.ts`），我们只采纳同步面这三支。
 * - 上游 `IGitOutput.percent`（`git.ts:223` 用的是 `lastPercent`）在我们这里是
 *   `context` 行的 `percent`，语义相同。
 *
 * @module dsh-git/host/sync-progress
 */

import type { IGitOutput, IGitProgress, IGitProgressParser } from '../core/desktop/lib/progress/git.ts';
import { PushProgressParser } from '../core/desktop/lib/progress/push.ts';
import { FetchProgressParser } from '../core/desktop/lib/progress/fetch.ts';
import { PullProgressParser } from '../core/desktop/lib/progress/pull.ts';
import type { SyncProgressKind, SyncProgressPayload } from '../core/types.ts';

export type { SyncProgressKind, SyncProgressPayload };

/**
 * 宿主侧的旧名 —— 与 `core/types.ts` 的 {@link SyncProgressPayload} 是**同一个**类型。
 *
 * 保留它只是为了让 `GitService` 的签名读起来像「宿主读出的那一份」;
 * **不要**在这里再写一遍字段(那会变成第二份真源)。
 */
export type SyncProgressSnapshot = SyncProgressPayload;

/** 按动作挑解析器 —— 上游是三支各自 `new XProgressParser()`（`push.ts:19` / `fetch.ts:20` / `pull.ts:25`）。 */
export function createSyncProgressParser(kind: SyncProgressKind): IGitProgressParser {
  switch (kind) {
    case 'push':
      return new PushProgressParser();
    case 'fetch':
      return new FetchProgressParser();
    case 'pull':
      return new PullProgressParser();
  }
}

/**
 * 把「解析出来的一行」折成 {@link SyncProgressSnapshot} 并交出去。
 *
 * 上游那一层（`lib/git/push.ts:85-98`）对 `progress` 与 `context` 两种结果都发
 * 回调：`kind === 'progress'` 时描述取 `details.text`、`percent` 是它自己算出来的；
 * `context` 时描述取 `text`、`percent` 是**上一条**的百分比（`git.ts:223`）。
 * 这里逐条沿用 —— 包括「`context` 也刷新描述」这一点（用户看到的是 git 正在说什么）。
 *
 * @param kind - 本次动作（写在快照上，客户端据此拒绝跨动作合并）。
 * @param parser - 本动作的解析器（**一个解析器只能喂一条 stderr 流**，`git.ts:167-169`）。
 * @param record - 收到快照时的落点（`GitService` 那边的 Map）。
 * @returns 可以直接挂到 `GitRunOptions.onStderrLine` 上的回调。
 */
export function createSyncProgressLineSink(
  kind: SyncProgressKind,
  parser: IGitProgressParser,
  record: (snapshot: SyncProgressSnapshot) => void,
): (line: string) => void {
  return (line: string): void => {
    const progress: IGitProgress | IGitOutput = parser.parse(line);
    if (progress.kind === 'progress') {
      record({
        kind,
        description: progress.details.text,
        value: progress.percent,
        done: progress.details.done,
      });
      return;
    }
    record({
      kind,
      description: progress.text,
      value: progress.percent,
      done: false,
    });
  };
}
