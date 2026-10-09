/**
 * 交互式 rebase 的 **todo 清单拼装**(纯函数,零依赖)。
 *
 * ## 这是谁的代码
 *
 * **逐行对着上游搬过来的**(不是「照意思写」):
 *
 * | 这里 | 上游 | 行 |
 * |---|---|---|
 * | {@link squashTodoLines} | `lib/git/squash.ts` 的 `for (let i = commits.length - 1; …)` 循环体 | `:72-137` |
 * | {@link reorderTodoLines} | `lib/git/reorder.ts` 的同形循环体 | `:63-131` |
 *
 * 上游那两段是 `appendFile(todoPath, …)` 一条条写盘;这里把同样的字节**收进一个
 * 字符串**返回,由调用方一次写盘 —— 字节完全相同(每行都以 `\n` 收尾,包括最后一行)。
 * 判据:`docs/probes/multi-commit-route-probe.mjs` 的 A 组把这里的输出与
 * 「同一组提交喂给镜像 `lib/git/squash.ts` 那套循环」的期望逐字比对。
 *
 * ## 为什么**必须**在这里重写一遍(而不是 host 直接 import 镜像那份)
 *
 * 镜像 `src/core/desktop/lib/git/squash.ts`(173 行)是**逐字抄进来的上游文件**,
 * 但它的第 1-2 行就是 `import { appendFile, rm, writeFile } from 'fs/promises'` 与
 * `import { getCommits, revRange } from '.'`,第 8 行 `from './rebase'` —— 而
 * `./rebase`(633 行)**整个是 dugite**:`import { GitError } from 'dugite'`、
 * `import { git } from './core'`。dugite 与 node 内置在宿主半**不存在**
 * (`tsconfig.host.json` 的 program 是 `src/index.ts + src/host/** + src/core/**`),
 * 所以那份文件在宿主半**永远 import 不了**。
 *
 * ⇒ 纯逻辑这一层只能有两份。这是本仓「命令的实现在 host」那条分工
 * (`docs/goal-port-desktop.md` §2.4)的直接代价,和 `lib/git/lfs.ts` 那一族同因。
 *
 * **退役条件**(两条任一成立就删本文件、改用镜像那一份):
 *  1. 镜像 `lib/git/{squash,reorder}.ts` 被改造成「纯逻辑 + 注入式 git 端口」两段
 *     (上游没有这么切,所以这是**我们的**结构改动,必须登记成 EXPECTED 偏离);
 *  2. 宿主半改用能在 Node 里跑的 dugite 替身,于是镜像那两份可以原样进宿主 program。
 *
 * @module dsh-git/core/rebase-todo
 */

/** 拼 todo 需要的**最少**提交信息(上游用的是完整 `Commit`,这里只取用到的两列)。 */
export interface ITodoCommit {
  readonly sha: string;
  /** 上游 `commit.summary`;git 的 todo 解析只看第一个空格前的 sha,后面是给人看的。 */
  readonly summary: string;
}

/** todo 里一行:`<action> <sha> <summary>`(上游逐字格式,末尾 `\n`)。 */
function todoLine(action: 'pick' | 'squash', commit: ITodoCommit): string {
  return `${action} ${commit.sha} ${commit.summary}\n`;
}

/**
 * squash 的 todo。
 *
 * 上游 `lib/git/squash.ts:72-137`。语义(上游注释逐条):
 *  - **从新到旧反向遍历**,于是写出的是「旧 → 新」的回放顺序;
 *  - `toSquash` 里的提交在**遇到 `squashOnto` 之前**先攒进 `toReplayAtSquash`
 *    (不信任调用方给的顺序,按 log 顺序重排);
 *  - 遇到 `squashOnto` 那一条:它自己 `pick`,它前面攒下的都是 `squash`;
 *  - `squashOnto` 之后的 `toSquash` 直接写 `squash`;
 *  - 其它提交在 `squashOnto` 之前照旧 `pick`,之后**先攒着**(`toReplayAfterSquash`)
 *    等扫完再补 —— 上游的理由逐字:「We can't just replay a pick in case there is a
 *    commit from the toSquash commits further up in history that need to be replayed
 *    with the squashes.」
 *  - 扫完还没遇到 `squashOnto` ⇒ **抛错**(继续下去会**丢掉** `toSquash` 里的提交)。
 * @param commits - **log 顺序(新 → 旧)**;空数组 ⇒ 抛错(上游在 `:63-67` 就拦)。
 * @param toSquashShas - 要压进 `squashOnto` 的提交 sha。
 * @param squashOnto - 压到哪一条上(它自己变成 `pick`)。
 * @returns todo 全文(每条以 `\n` 结尾)。
 */
export function squashTodoLines(
  commits: ReadonlyArray<ITodoCommit>,
  toSquashShas: ReadonlySet<string>,
  squashOnto: string,
): string {
  if (commits.length === 0) {
    throw new Error('[squash] Could not find commits in log for last retained commit ref.');
  }

  let out = '';
  let foundSquashOntoCommitInLog = false;
  const toReplayAtSquash: ITodoCommit[] = [];
  const toReplayAfterSquash: ITodoCommit[] = [];

  // Traversed in reverse so we do oldest to newest (replay commits)
  for (let i = commits.length - 1; i >= 0; i--) {
    const commit = commits[i];
    if (toSquashShas.has(commit.sha)) {
      if (foundSquashOntoCommitInLog) {
        out += todoLine('squash', commit);
      } else {
        toReplayAtSquash.push(commit);
      }
      continue;
    }

    if (commit.sha === squashOnto) {
      foundSquashOntoCommitInLog = true;
      toReplayAtSquash.push(commit);
      for (let j = 0; j < toReplayAtSquash.length; j++) {
        out += todoLine(j === 0 ? 'pick' : 'squash', toReplayAtSquash[j]);
      }
      continue;
    }

    if (foundSquashOntoCommitInLog) {
      toReplayAfterSquash.push(commit);
      continue;
    }

    out += todoLine('pick', commit);
  }

  for (let i = 0; i < toReplayAfterSquash.length; i++) {
    out += todoLine('pick', toReplayAfterSquash[i]);
  }

  if (!foundSquashOntoCommitInLog) {
    throw new Error(
      '[squash] The commit to squash onto was not in the log. Continuing would result in dropping the commits in the toSquash array.',
    );
  }

  return out;
}

/**
 * reorder 的 todo。
 *
 * 上游 `lib/git/reorder.ts:63-131`。与 squash 同形,差别只有两处(逐字):
 *  - 全是 `pick`(重排**只改行序**,不改 action);
 *  - 基准是 `beforeCommit`,而且**允许为 `null`**(= 移到最前面):
 *    `null` 时把攒下的 `toReplayBeforeBaseCommit` 直接补在**末尾**(`:120-126`)。
 * @param commits - **log 顺序(新 → 旧)**。
 * @param toMoveShas - 要移动的提交 sha。
 * @param beforeCommit - 移到它**之前**;`null` = 移到最前。
 * @returns todo 全文。
 */
export function reorderTodoLines(
  commits: ReadonlyArray<ITodoCommit>,
  toMoveShas: ReadonlySet<string>,
  beforeCommit: string | null,
): string {
  if (commits.length === 0) {
    throw new Error('[reorder] Could not find commits in log for last retained commit ref.');
  }

  let out = '';
  let foundBaseCommitInLog = false;
  const toReplayBeforeBaseCommit: ITodoCommit[] = [];
  const toReplayAfterReorder: ITodoCommit[] = [];

  // Traversed in reverse so we do oldest to newest (replay commits)
  for (let i = commits.length - 1; i >= 0; i--) {
    const commit = commits[i];
    if (toMoveShas.has(commit.sha)) {
      if (foundBaseCommitInLog) {
        out += todoLine('pick', commit);
      } else {
        toReplayBeforeBaseCommit.push(commit);
      }
      continue;
    }

    if (beforeCommit !== null && commit.sha === beforeCommit) {
      foundBaseCommitInLog = true;
      toReplayAfterReorder.push(commit);
      for (let j = 0; j < toReplayBeforeBaseCommit.length; j++) {
        out += todoLine('pick', toReplayBeforeBaseCommit[j]);
      }
      continue;
    }

    if (foundBaseCommitInLog) {
      toReplayAfterReorder.push(commit);
      continue;
    }

    out += todoLine('pick', commit);
  }

  for (let i = 0; i < toReplayAfterReorder.length; i++) {
    out += todoLine('pick', toReplayAfterReorder[i]);
  }

  if (beforeCommit === null) {
    for (let i = 0; i < toReplayBeforeBaseCommit.length; i++) {
      out += todoLine('pick', toReplayBeforeBaseCommit[i]);
    }
  } else if (!foundBaseCommitInLog) {
    throw new Error(
      '[reorder] The base commit onto was not in the log. Continuing would result in dropping the commits in the toMove array.',
    );
  }

  return out;
}
