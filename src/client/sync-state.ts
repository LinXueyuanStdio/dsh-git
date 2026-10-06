/**
 * **同步段（推送/拉取/抓取）的读侧投影** —— 把 dsh-git 的 `Snapshot` 翻译成上游
 * `lib/rebase.ts` / `models/progress.ts` **直接吃**的形状。
 *
 * ## 为什么需要这一层
 *
 * 上游同步按钮的 `forcePushBranchState` 不是「领先/落后」的直接函数，而是
 * `ui/app.tsx:3642-3645`：
 *
 * ```ts
 * const forcePushBranchState = getCurrentBranchForcePushState(branchesState, aheadBehind)
 * ```
 *
 * 也就是说它读的是**仓库状态**（`IBranchesState`）里的 `forcePushBranches`
 * （`lib/app-state.ts:736`：分支短名 → 被我们重写过的 tip sha），而不只是数字。
 * 我们的 `Snapshot` 里没有 `IBranchesState`，所以这里做一次**显式投影**，
 * 而不是在视图里重新实现一遍 `rebase.ts:39-68` 的那段判定（那会变成第二份真源）。
 *
 * ## 只投影上游真正读到的部分（**不为凑形状造假值**）
 *
 * `getCurrentBranchForcePushState` 的签名收整个 `IBranchesState`（10 个字段），
 * 但函数体**只读两个**：
 *
 * | 上游行 | 读了什么 |
 * |---|---|
 * | `lib/rebase.ts:55` | `const { tip, forcePushBranches } = branchesState` |
 * | `:58-62` | `tip.kind === TipState.Valid`、`tip.branch.nameWithoutRemote`、`tip.branch.tip.sha`、`forcePushBranches.get(...)` |
 *
 * 所以我们**不**给 `allBranches` / `recentBranches` / `currentPullRequest` … 填 `[]` / `null`
 * 来凑出一个「完整的」`IBranchesState` —— 那会让「没有这份数据」看起来像「有，只是空的」，
 * 正是本项目反复纠正的那类静默谎报（`branches-view.tsx` 的文件头为同一件事选择了不接
 * `BranchesContainer`）。这里用一次**写明理由的窄化 cast**：只提供那两个真实字段，
 * 其余字段在类型上被排除。探针里对同一个输入同时跑「窄化版」与「按上游形状填满的版」，
 * 断言两者结果逐字相同 —— 那份等价性是这条 cast 的验收条件。
 *
 * ## 边界：这里只投影，不造数
 *
 * - `tip` 完全来自 `snap.status`（`branch` / `headSha` / `detached` / `unborn`），
 *   没有一处是估的；
 * - `forcePushBranches` 来自 `GitStore`（写入点见 `store.ts` 的
 *   `addBranchToForcePushList`，对应上游 `app-store.ts:9676`）；
 * - `progress` 就是 `snap.progress`（写入点见 `store.ts` 的 `updateSyncProgress`）。
 *
 * @module dsh-git/client/sync-state
 */

import { Branch, BranchType } from '../core/desktop/models/branch.ts';
import type { IAheadBehind } from '../core/desktop/models/branch.ts';
import { TipState } from '../core/desktop/models/tip.ts';
import type { Tip } from '../core/desktop/models/tip.ts';
import {
  ForcePushBranchState,
  getCurrentBranchForcePushState,
} from '../core/desktop/lib/rebase.ts';
import type { IBranchesState } from '../core/desktop/lib/app-state.ts';
import type { Progress } from '../core/desktop/models/progress.ts';
import type { Snapshot } from './store.ts';

/**
 * 当前 HEAD 的上游 `Tip`（`models/tip.ts:12`）。
 *
 * 四种形态与 `snap.status` 的对应关系是**一一枚举完的**，没有兜底猜测：
 *
 * | `models/tip.ts` | 判据 | 我们的字段 |
 * |---|---|---|
 * | `Valid` | 在分支上且有提交 | `detached === false && unborn === false` |
 * | `Detached` | 分离头 | `detached === true` |
 * | `Unborn` | 分支还没有第一次提交 | `unborn === true` |
 * | `Unknown` | 还没有读到仓库状态 | `snap.status === null` |
 *
 * `Unborn` 的 `ref` 用 `refs/heads/<branch>`：上游那个字段是「unborn 分支指向的符号引用」
 * （`models/tip.ts:20-26` 的文档），而 git 在未出生分支上的 HEAD 就是它。
 */
export function tipOf(snap: Snapshot): Tip {
  const status = snap.status;
  if (status === null) {
    return { kind: TipState.Unknown };
  }
  if (status.unborn) {
    return { kind: TipState.Unborn, ref: `refs/heads/${status.branch}` };
  }
  if (status.detached) {
    return { kind: TipState.Detached, currentSha: status.headSha };
  }
  /*
   * `upstream` 直接给 `Branch`：上游 `app-store.ts:3620-3633` 那一段就是拿
   * `tip.branch.upstream` 与 `upstreamRemoteName` 当远端名的来源，
   * 所以这里也必须在构造时就带上（否则 `Branch.upstreamRemoteName` 会回 null，
   * 与 `pushPull-button.tsx` 的 `remoteName` 显示不一致）。
   */
  return {
    kind: TipState.Valid,
    branch: new Branch(
      status.branch,
      status.upstream,
      { sha: status.headSha },
      BranchType.Local,
      `refs/heads/${status.branch}`,
    ),
  };
}

/**
 * 领先/落后（上游 `models/branch.ts:13` 的 `IAheadBehind`）。
 *
 * 上游在 `app.tsx:3661` 直接把 `state.aheadBehind` 传给按钮；我们这一侧
 * `snap.sync` 为 `null`（还没读到）时没有可用的数，返回 `null` ——
 * 上游 `getCurrentBranchForcePushState` 对 `null` 的语义正是
 * 「没有 tracking branch」⇒ `NotAvailable`（`lib/rebase.ts:43-46`）。
 */
export function aheadBehindOf(snap: Snapshot): IAheadBehind | null {
  const sync = snap.sync;
  if (sync === null) {
    return null;
  }
  return { ahead: sync.ahead, behind: sync.behind };
}

/**
 * `forcePushBranches` 的 `Map` 视图（上游类型是 `ReadonlyMap<string, string>`）。
 *
 * 快照里存普通对象（理由见 `store.ts` 的字段注释），这里转一次。
 */
export function forcePushBranchesOf(snap: Snapshot): ReadonlyMap<string, string> {
  return new Map(Object.entries(snap.forcePushBranches));
}

/**
 * **同步面显示的远端名** —— 上游 `ui/app.tsx:3620-3633` 那一段判定,逐条沿用:
 *
 * ```ts
 * let remoteName = state.remote ? state.remote.name : null
 * if (tip.kind === TipState.Valid && tip.branch.upstreamRemoteName !== null) {
 *   remoteName = tip.branch.upstreamRemoteName
 *   if (tip.branch.upstreamWithoutRemote !== tip.branch.name) {
 *     remoteName = tip.branch.upstream          // ← 「上游分支名 ≠ 本地分支名」时给**全名**
 *   }
 * }
 * ```
 *
 * ⚠️ 第二个分支**看起来像笔误**(它给出的会是 `origin/other` 而不是 `origin`),
 * 但它是上游的**实际行为**,顶栏标题、`PushPullButton` 的进度标题、以及
 * `app-store.ts:5243` 那条 `branch.upstreamRemoteName || remote.name` 的回落都由它决定。
 * 我们**沿用**,不「顺手修正」—— 修正会变成第二份真源(见 `docs/goal-port-desktop.md` §2.1)。
 *
 * 第三个来源(`state.remote.name`)在快照里是 `sync.remotes[0]`。
 *
 * @returns 远端名;没有远端时为 `null`(上游那一支渲染「发布仓库」按钮)。
 */
export function remoteNameOf(snap: Snapshot): string | null {
  const upstream = snap.status?.upstream;
  const branch = snap.status?.branch;
  if (upstream !== null && upstream !== undefined && upstream !== '') {
    const slash = upstream.indexOf('/');
    if (slash > 0) {
      const upstreamRemoteName = upstream.slice(0, slash);
      const upstreamWithoutRemote = upstream.slice(slash + 1);
      return upstreamWithoutRemote !== branch ? upstream : upstreamRemoteName;
    }
  }
  return snap.sync?.remotes[0] ?? null;
}

/**
 * 把快照投影成 `getCurrentBranchForcePushState` 需要的**那两个字段**。
 *
 * ⚠️ 这里的 cast **不是**「假装有数据」：它把类型收窄到函数体真正读到的面，
 * 理由是文件头那张表（`lib/rebase.ts:55` / `:58-62`）。另一条路是给另外 8 个字段
 * 填假值（`allBranches: []` …），那才是谎报。回收条件：我们的 `Snapshot`
 * 真的持有完整 `IBranchesState` 时（例如 `ui/branches/**` 的 PR 那一半接上），
 * 直接传那个对象、删掉本函数。
 */
function branchesStateOf(snap: Snapshot): IBranchesState {
  return {
    tip: tipOf(snap),
    forcePushBranches: forcePushBranchesOf(snap),
  } as unknown as IBranchesState;
}

/**
 * **按钮到底该不该是「强推」** —— 上游 `ui/app.tsx:3642-3645` 那一行的等价物。
 *
 * 三档语义（`lib/rebase.ts:6-24`）：
 *  - `NotAvailable`：没有 tracking branch，或没有分叉（`behind === 0 || ahead === 0`）；
 *  - `Available`：分叉了，但**不是**我们重写出来的（例如别人推了新提交）⇒ 按钮是「拉取」，
 *    强推作为下拉里的一项；
 *  - `Recommended`：分叉了，而且 `forcePushBranches` 里当前分支的值**恰好等于当前 tip**
 *    ⇒ 是我们自己 rebase/amend 出来的，按钮直接变「强推」。
 */
export function forcePushBranchStateOf(snap: Snapshot): ForcePushBranchState {
  return getCurrentBranchForcePushState(branchesStateOf(snap), aheadBehindOf(snap));
}

/**
 * 进行中的网络动作进度（上游 `IRepositoryState.pushPullFetchProgress`，
 * `lib/app-state.ts:632`；消费点 `ui/app.tsx:3622`）。
 *
 * 就是快照字段本身 —— 这里包一层是为了让视图**只 import 一处**，将来载体换掉时
 * 不用去改视图。
 */
export function syncProgressOf(snap: Snapshot): Progress | null {
  return snap.progress;
}

/**
 * 上游 `IRepositoryState.isPushPullFetchInProgress`（`lib/app-state.ts:597`，
 * 消费点 `ui/app.tsx:3663` 的 `networkActionInProgress`）。
 *
 * 判据是「有进度在跑」而不是 `snap.busy !== ''`：后者把 `commit` / `stage` /
 * `checkout` 也算进来，会让进度按钮上的转圈在提交时也转 —— 语义不同。
 * （写入侧的一致性由 `store.ts` 的 `updateSyncProgress` 保证：进度只在三个网络动作
 * 里非空。）
 */
export function networkActionInProgress(snap: Snapshot): boolean {
  return snap.progress !== null;
}
