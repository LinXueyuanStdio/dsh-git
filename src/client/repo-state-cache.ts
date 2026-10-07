/**
 * **per-repo 视图状态缓存** —— 把「属于某个仓库」的 Changes 页状态按仓库留起来。
 *
 * ## 为什么需要它(上游事实)
 *
 * 上游 GitHub Desktop **每个仓库各有一份完整状态**,key 是 `repository.hash`:
 *
 * | 上游 | 行 | 作用 |
 * |---|---|---|
 * | `RepositoryStateCache.repositoryState = new Map<string, IRepositoryState>()` | `lib/stores/repository-state-cache.ts:31` | 按 hash 一份 |
 * | `get()`:未命中就建初值并写进 Map | `:36-45` | 首次访问 = 干净初值;之后命中 = 带着上次的状态 |
 * | `updateChangesState()` | `:86-99` | 写这份状态 |
 * | `GitStoreCache.gitStores = new Map<string, GitStore>()` | `lib/stores/git-store-cache.ts:6-31` | 草稿等也按仓库留 |
 * | `GitStore._commitMessage` | `lib/stores/git-store.ts:136` | 草稿的载体 |
 * | `_selectRepositoryRefreshTasks` | `lib/stores/app-store.ts:2237-2241` | 切仓库只是**刷新**,**不重置**状态 |
 *
 * ⇒ 用户可见契约:**在 A 里选中文件、写了一半提交信息、勾/取消勾选几个文件,切到 B 再切回 A,
 * 这些都应该还在。** 我们以前只有一份扁平快照,`selectRepo()` 把 14 个字段整块清空
 * ⇒ 全丢。判据:`docs/probes/changes-cache-probe.mjs`(改前 **2/6**,改后 **6/6**)。
 *
 * ## 本模块怎么用那份镜像(**逐字,不改一个字节**)
 *
 * `RepositoryStateCache` 是**上游文件与上游一致**(476 行,`verify-mirror` 无偏离),
 * 我们把它当**真容器**用,不重写、不包装它的字段语义:
 *
 * | 我们的字段 | 落到镜像的哪个槽 | 类型是否精确 |
 * |---|---|---|
 * | `selectedFiles` | `changesState.selection.selectedFileIDs`(`app-state.ts:798`) | ✅ `ReadonlyArray<string>` |
 * | `commitForm.summary/description` | `changesState.commitMessage`(`:820`,`ICommitMessage`) | ✅ |
 * | `commitForm.signoff` | `IRepositoryState.signOffCommits`(`:661`) | ✅ |
 * | `commitForm.noVerify` | `IRepositoryState.skipCommitHooks`(`:655`) | ✅ |
 * | `commitForm.allowEmpty` | `IRepositoryState.allowEmptyCommit`(`:668`) | ✅ |
 * | `commitForm.generating` | `IRepositoryState.isGeneratingCommitMessage`(`:603`) | ✅ |
 * | `forcePushBranches` | `branchesState.forcePushBranches`(`:736`) | ✅(Record ↔ `ReadonlyMap`) |
 * | 当前页签 | `IRepositoryState.selectedSection`(`:553`) | ✅(只映射 changes/history) |
 *
 * **两处必须记账的语义偏差**(不是「差不多」,是明确的取舍):
 *
 *  1. **`selectedFileIDs` 里装的是路径,不是上游的 `FileChange.id`。**
 *     上游的 id 是 `status.kind + path`(`models/status.ts:255-275`);我们的
 *     `ChangedFile`(`src/core/types.ts:38-60`)是宿主载荷,**没有 id**。
 *     路径在单一仓库内**唯一**且与我们的 `includeState` 键一致,所以功能等价;
 *     退役条件:我们的文件模型若补上 `id`(照镜像的 `FileChange.id`),这里应改用它。
 *  2. **`commitMessage.timestamp` 恒为 `0`。** 上游用它判「新消息是否比草稿新」;
 *     我们没有这个比较,填 0 是**如实**的空值,不是伪造的时间戳。
 *
 * ## 哪些字段**不**进镜像(为什么)
 *
 * 下面这些**没有可用的槽**,放在本模块的兄弟表 `extras` 里 —— 每一个都注明了原因与退役条件:
 *
 *  - `includeState`:上游把它建模成 `DiffSelection`、**挂在 `workingDirectory.files[i].selection` 上**。
 *    要装进去就得先造 `WorkingDirectoryFileChange`(要 `AppFileStatus` 判别联合)与
 *    `DiffSelection`(要该文件**当前 diff** 的 `selectable` 集合)。对**当前没在显示**的文件
 *    拿不到 `selectable` ⇒ 往返**有损**。⇒ 留在我们自己的形状里。
 *    退役条件:Changes 容器整体切到 `ui/changes/**`(见 `docs/changes-container-switch.md`)时一并搬。
 *  - `diff` / `diffKey`:上游槽是 `IDiff`(`app-state.ts:799`),我们是宿主的 `DiffResult`
 *    (`src/core/types.ts:112-122`,带 `additions/deletions/binary/untracked`)。
 *    把 `DiffResult` 塞进 `IDiff` 要丢字段 ⇒ 不装。
 *  - `log` / `logHasMore`:上游是 `commitLookup: Map<string,Commit>` + `localCommitSHAs`;
 *    我们的 `CommitEntry`(`types.ts:125+`)是另一个形状。
 *  - `selectedCommit` / `commitDetailFiles`:上游是 `commitSelection.shas` + `changesetData`。
 *  - `commitForm.amend` / `generatedBy`:上游的载体是 `commitToAmend: Commit | null`
 *    (要整个 commit)与 Copilot 专用的 `generatedByCopilot` —— 我们只有布尔与一个标签。
 *
 * ## 刻意**不**缓存的东西(以及为什么)
 *
 * `status` / `sync` / `branches` **故意不进缓存**。上游会把「上次已知的工作区」
 * 立刻画出来再刷新;我们判断**显示上一个仓库的文件列表**比「一帧空列表」更危险
 * (用户会对着一份不属于当前仓库的列表点勾选),而这三样都是 `refreshAll()` 立刻
 * 就能拿回来的宿主载荷。⇒ 切仓库时它们照旧清空,由 `refreshAll()` 填。
 * @module dsh-git/client/repo-state-cache
 */

import { RepositoryStateCache } from '../core/desktop/lib/stores/repository-state-cache.ts';
import { Repository } from '../core/desktop/models/repository.ts';
import { ChangesSelectionKind, RepositorySectionTab } from '../core/desktop/lib/app-state.ts';
import type { IStatsStore } from '../core/desktop/lib/stats/stats-store.ts';
import type { LineSelectionSpec } from '../core/partial-stage.ts';
import type { CommitEntry, DiffResult } from '../core/types.ts';
import type { Snapshot } from './store.ts';

/**
 * `IStatsStore` 的 no-op 实现。
 *
 * `repository-state-cache.ts:131,159` 只在一个地方用它记**两条 submodule diff 遥测计数**,
 * 而那两个 `private record*IfNeeded()` 除计数外**零副作用**(不写状态、不返回值、不决定分支)
 * ⇒ 对界面与状态**零影响**。逐条核实写在 `src/core/desktop/lib/stats/stats-store.ts` 的文件头。
 */
const noopStatsStore: IStatsStore = {
  increment: async () => { /* 遥测:本插件没有上报端点,§1.3 不沿用 lib/stats */ },
};

/**
 * 属于某个仓库、但镜像里没有对应槽的那部分(原因逐条写在本文件头)。
 *
 * ⚠️ 名字带 `I` 前缀是**本仓闸门的要求**,不是风格偏好:`.eslintrc.yml` 的
 * `@typescript-eslint/naming-convention` 对 `selector: interface` 钉了
 * `regex: '^I[A-Z]'`(逐字沿用上游 `references/desktop/.eslintrc.yml:35-104`)。
 * 原先叫 `RepoExtras` 时 `scripts/check-lint.mjs` 会把它算成**新增**违规;
 * 改名是让闸门变绿的正解,不是给它加豁免,也不是去改基线。
 */
interface IRepoExtras {
  includeState: Record<string, LineSelectionSpec>;
  diff: DiffResult | null;
  diffKey: string;
  log: CommitEntry[];
  logHasMore: boolean;
  selectedCommit: string;
  commitDetailFiles: { path: string; status: string; additions: number; deletions: number }[];
  amend: boolean;
  generatedBy: string;
}

/**
 * 切仓库时要**带过去/带回来**的字段集合。
 *
 * 用 `Pick<Snapshot, …>` 而不是另写一个形状:这样 `Snapshot` 改名/增删字段时,
 * 这里会**编译期报错**,而不是静默漏带一个字段(那正是「切一次仓库丢一个字段」的病根)。
 */
export type RepoScopedSnapshot = Pick<
  Snapshot,
  | 'selectedFiles'
  | 'includeState'
  | 'diff'
  | 'diffKey'
  | 'log'
  | 'logHasMore'
  | 'selectedCommit'
  | 'commitDetailFiles'
  | 'forcePushBranches'
  | 'commitForm'
>;

/**
 * 首次访问某个仓库时的初值(镜像 `get()` 的未命中分支给的就是这个语义)。
 *
 * ⚠️ 同上:`selector: interface` 要求 `I` 前缀,所以真身叫 `IRepoStateCacheFallback`。
 * 调用方(以及本文件的构造参数)用下面的**类型别名**读它,名字与改前一致。
 */
export interface IRepoStateCacheFallback {
  /** `Snapshot` 那一份初值(由 `store.ts` 的 `initial()` 提供,避免第二份真源)。 */
  initial: () => RepoScopedSnapshot;
}

/**
 * 上游风格的公开名(`RepoStateCacheFallback`)—— 与 `types/client-platform-shims.d.ts`
 * 里 `ISettingsFormProps` → `SettingsFormProps` 是同一手法:接口真身守本仓命名约定,
 * 再用别名把不带前缀的名字留给调用方。**别名与真身是同一个类型**,不产生第二份真源。
 */
export type RepoStateCacheFallback = IRepoStateCacheFallback;

export class RepoStateCache {
  /** 上游那份「按 hash 一份 `IRepositoryState`」的容器,与上游一致,本模块不改它。 */
  private readonly inner = new RepositoryStateCache(noopStatsStore);

  /**
   * 路径 → `Repository` 实例(只为拿到稳定的 `hash`)。
   *
   * 为什么要 memo:`Repository.hash` 是 `createEqualityHash(path, id, …)`
   * (`models/repository.ts:72`),同一个路径每次 `new` 出来的 hash **相同** ——
   * 但 memo 掉可以省掉反复构造,并且让「一个路径 = 一个身份」显式可读。
   */
  private readonly repos = new Map<string, Repository>();

  /** 路径 → 上游没有槽的那部分(见本文件头)。 */
  private readonly extras = new Map<string, IRepoExtras>();

  public constructor(private readonly fallback: RepoStateCacheFallback) {}

  /** 取(必要时创建)某个路径的仓库身份。 */
  private repoFor(path: string): Repository {
    const existing = this.repos.get(path);
    if (existing !== undefined) {
      return existing;
    }
    // 构造参数照 `src/client/desktop-diff.tsx:731` 的既有用法(同一份镜像模型)。
    const created = new Repository(path, 0, null, false);
    this.repos.set(path, created);
    return created;
  }

  /**
   * 把一个快照里**属于那个仓库**的字段写回它的槽。
   * @param path - 仓库路径;空串(未选中任何仓库)时什么都不做。
   * @param snap - 当前快照。
   */
  public stash(path: string, snap: Snapshot): void {
    if (path === '') {
      return;
    }
    const repo = this.repoFor(path);

    // ---- 进镜像的槽(类型精确,见文件头的对照表)----
    this.inner.updateChangesState(repo, (state) => ({
      selection: {
        kind: ChangesSelectionKind.WorkingDirectory as ChangesSelectionKind.WorkingDirectory,
        // ⚠️ 装的是**路径**:我们的 `ChangedFile` 没有上游的 `FileChange.id`(文件头偏差 1)。
        selectedFileIDs: snap.selectedFiles,
        // 上游槽是 `IDiff`,我们的是宿主载荷 `DiffResult` ⇒ **不装**,留在 extras 里
        // (文件头「不进修镜像」第 2 条)。这里如实置空,不塞一个假对象。
        diff: null,
      },
      commitMessage: {
        summary: snap.commitForm.summary,
        description: snap.commitForm.description,
        // 我们没有「草稿时间戳」的比较(文件头偏差 2)⇒ 如实填 0。
        timestamp: 0,
      },
      conflictState: state.conflictState,
    }));
    this.inner.update(repo, () => ({
      signOffCommits: snap.commitForm.signoff,
      skipCommitHooks: snap.commitForm.noVerify,
      allowEmptyCommit: snap.commitForm.allowEmpty,
      isGeneratingCommitMessage: snap.commitForm.generating,
      selectedSection:
        snap.tab === 'history' ? RepositorySectionTab.History : RepositorySectionTab.Changes,
    }));
    this.inner.updateBranchesState(repo, () => ({
      forcePushBranches: new Map(Object.entries(snap.forcePushBranches)),
    }));

    // ---- 上游没有槽的部分(原因逐条在文件头)----
    this.extras.set(path, {
      includeState: snap.includeState,
      diff: snap.diff,
      diffKey: snap.diffKey,
      log: snap.log,
      logHasMore: snap.logHasMore,
      selectedCommit: snap.selectedCommit,
      commitDetailFiles: snap.commitDetailFiles,
      amend: snap.commitForm.amend,
      generatedBy: snap.commitForm.generatedBy,
    });
  }

  /**
   * 读出某个仓库的字段。
   *
   * 未命中 ⇒ 镜像 `get()` 会建一份**干净初值**(`repository-state-cache.ts:36-45`),
   * 我们这边回落到 `initial()` —— **首次进入一个仓库仍然是干净的**,不会带别的仓库的东西。
   * @param path - 仓库路径。
   * @returns 可直接展开进 `emit()` 的那部分快照字段。
   */
  public restore(path: string): RepoScopedSnapshot {
    const repo = this.repoFor(path);
    const state = this.inner.get(repo);
    const extras = this.extras.get(path);

    const selection =
      state.changesState.selection.kind === ChangesSelectionKind.WorkingDirectory
        ? state.changesState.selection
        : null;

    const fallback = this.fallback.initial();
    if (extras === undefined) {
      // 首次访问:**只**用镜像里那份初值里的「选中集合」与提交信息,
      // 其余一律回落到 `initial()`(等价于「干净的仓库」)。
      return {
        ...fallback,
        selectedFiles: selection === null ? fallback.selectedFiles : [...selection.selectedFileIDs],
      };
    }

    return {
      selectedFiles: selection === null ? fallback.selectedFiles : [...selection.selectedFileIDs],
      includeState: extras.includeState,
      diff: extras.diff,
      diffKey: extras.diffKey,
      log: extras.log,
      logHasMore: extras.logHasMore,
      selectedCommit: extras.selectedCommit,
      commitDetailFiles: extras.commitDetailFiles,
      forcePushBranches: Object.fromEntries(state.branchesState.forcePushBranches),
      commitForm: {
        ...fallback.commitForm,
        summary: state.changesState.commitMessage.summary,
        description: state.changesState.commitMessage.description ?? '',
        amend: extras.amend,
        signoff: state.signOffCommits,
        noVerify: state.skipCommitHooks,
        allowEmpty: state.allowEmptyCommit,
        generating: state.isGeneratingCommitMessage,
        generatedBy: extras.generatedBy,
      },
    };
  }
}
