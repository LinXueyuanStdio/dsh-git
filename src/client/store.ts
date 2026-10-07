/**
 * 跨视图状态:一份不可变快照 + 订阅,React 侧用 useSyncExternalStore 读取。
 * 所有 host 调用都从这里出,视图只读快照与调方法。
 * @module dsh-git/client/store
 */

import { api, unwrap, waitForRoutes, type AuthStatePayload, type HealthPayload, type RemoteRepo } from './api.ts';
import { fileStatusKindOf, supportsLineSelection } from './file-kind.ts';
import { RepoStateCache, noopStatsStore, type RepoScopedSnapshot } from './repo-state-cache.ts';
import { appFileStatusOf, buildPartialPatchFromRaw, toDiffSelection, type FileStatusKind, type LineSelectionSpec } from '../core/partial-stage.ts';
/*
 * **上游那份状态机**(2026-10 采纳,`docs/changes-state-adoption.md` §4.3 第 1 步)。
 *
 * `applyChangesStatus` 是 `src/core/desktop/lib/stores/app-store.ts` 里的**接缝纯函数**,
 * 它逐字合成上游 `_loadStatus` 对 `changesState` 的两处写入
 * (`app-store.ts:2999-3004` → `updates/changes-state.ts` 的 `updateChangedFiles` /
 * `updateConflictState`)。在它接通之前,同一个规则由本文件的 `clearPartialAfterCommit`
 * 在跑 —— 也就是**同一件事的两份实现**。现在产品这条链走它。
 *
 * 为什么 import 用别的模块的**类实例**(`WorkingDirectoryFileChange` /
 * `DiffSelection`):上游那条规则按 `FileChange.id`(`kind+path`)合并,且**只**认
 * `WorkingDirectoryFileChange.selection`(DiffSelection)。所以走它就必须把我们的扁平
 * `includeState` 投影成那两个类型 —— 这是本文件 `mirroredClearPartial` 存在的唯一理由,
 * 也是文档 §4.3 记的「第 1 步的代价」。
 */
import { applyChangesStatus } from '../core/desktop/lib/stores/app-store.ts';
import {
  WorkingDirectoryFileChange, WorkingDirectoryStatus,
} from '../core/desktop/models/status.ts';
import { DiffSelection, DiffSelectionType } from '../core/desktop/models/diff/index.ts';
import { ChangesSelectionKind } from '../core/desktop/lib/app-state.ts';
import { DefaultCommitMessage } from '../core/desktop/models/commit-message.ts';
import { RepoRulesInfo } from '../core/desktop/models/repo-rules.ts';
import type { IChangesState } from '../core/desktop/lib/app-state.ts';
import type { IStatusResult } from '../core/desktop/lib/git/index.ts';
/*
 * `parsePatch` 是**客户端**那份解析器(`src/client/diff-rows.ts`,内部就是镜像的
 * `DiffParser`)—— 行级丢弃的补丁必须由与屏幕上**同一份**解析结果构造,因为
 * `buildPartialPatchFromRaw` 吃的 hunk 下标就是 DiffSelection 的行号空间
 * (`hunk.unifiedDiffStart + 行内下标`)。用另一份解析器会让「屏幕上选的那几行」与
 * 「补丁里的那几行」错位,而 `git apply` **不会报错**。
 */
import { parsePatch } from './diff-rows.ts';
/*
 * 上游 `models/progress.ts`（与上游一致，140 行，零 import）。**只作类型**使用 ——
 * `import type` 不产生运行期边，所以它不会把镜像的任何东西拉进客户端包。
 * 为什么用上游那个类型而不是自己写一个:同步按钮的 `progress` prop 收的就是它
 * (`ui/toolbar/push-pull-button.tsx:54`),两处必须**同一个**类型,否则
 * 「我们以为给了进度、上游认不出」这类错会静默发生在类型边界上。
 */
import type { Progress } from '../core/desktop/models/progress.ts';
/*
 * 读侧投影的**唯一一份**判据(`networkActionInProgress`)与**唯一一份**远端名判定
 * (`remoteNameOf`,上游 `ui/app.tsx:3620-3633`)。方向是 store → sync-state,
 * 而 `sync-state.ts` 只用 `import type` 引 `Snapshot` ⇒ **不构成运行期环**
 * (`import type` 在打包时被抹掉)。这样「谁算网络动作在跑」「同步面显示哪个远端名」
 * 各只有一处定义:写入侧的互斥与视图侧的转圈用同一个判据,进度标题与按钮标题
 * 用同一个远端名。
 */
import { networkActionInProgress, remoteNameOf } from './sync-state.ts';
import type {
  BranchEntry, ChangedFile, CommitEntry, DiffResult, GitError, RepoEntry, RepoStatus, SyncState,
} from '../core/types.ts';
import {
  getHideWhitespaceInChangesDiff, getHideWhitespaceInHistoryDiff, getShowSideBySideDiff,
  setHideWhitespaceInChangesDiff, setHideWhitespaceInHistoryDiff, setShowSideBySideDiff,
} from './diff-mode.ts';

/**
 * 网络动作在飞期间**轮询宿主进度**的间隔(ms)。
 *
 * 为什么是轮询而不是流:我们的 host 是请求/响应路由,而 `push` 那条请求
 * **一直阻塞到推完**(它的响应就是「推完了」),进度搭不了自己的车 ⇒ 走一条
 * 便宜的旁路路由(`api.syncProgress`,只查宿主内存里一张 Map、不跑子进程)。
 *
 * 250ms 的依据:git 自己把进度行节流到「每秒最多几条」(`progress.c` 的
 * `progress_update`),所以比这更密不会多拿到信息,只会白发请求;
 * 而 ~3s 的一次推送能拿到 ~10 个采样点,足够让进度条看起来在动。
 */
const SYNC_PROGRESS_POLL_MS = 250;

/** 页签。 */
export type TabId = 'changes' | 'history' | 'code' | 'issues' | 'pulls' | 'actions';

export const TAB_ORDER: readonly { id: TabId; label: string }[] = [
  { id: 'changes', label: 'Changes' },
  { id: 'history', label: 'History' },
  { id: 'code', label: 'Code' },
  { id: 'issues', label: 'Issues' },
  { id: 'pulls', label: 'Pull requests' },
  { id: 'actions', label: 'Actions' },
];

/** 提交表单状态。 */
export interface CommitForm {
  summary: string;
  description: string;
  amend: boolean;
  signoff: boolean;
  noVerify: boolean;
  allowEmpty: boolean;
  generating: boolean;
  generatedBy: string;
}

/** 一个可撤销的提示。 */
export interface Toast {
  id: number;
  message: string;
  kind: 'ok' | 'err';
  actionLabel?: string;
  action?: () => void;
}

/** 一个文件当前的纳入状态(三态)。 */
export type IncludeState = 'all' | 'none' | 'partial';

/**
 * `LineSelectionSpec` → 三态。
 *
 * **不变式**(由 `desktop-diff.tsx` 的 `selectionToSpec` 保证,探针里逐例验过):
 * `diverging.length === 0` 时 `kind` 一定是 `all`(全选)或 `none`(全不选);
 * 有任何 diverging 行就是 `partial`。所以这个判据是精确的,不是近似。
 *
 * 为什么不用 `DiffSelection.getSelectionType()`:那是镜像里的类,要 import
 * `models/diff`;这个判据只需要 spec 自身,store 不该为一个纯判定拖进渲染层。
 * 反证方式:若有人能让 `selectionToSpec` 产生 `{kind:'all', diverging:[…]}` 且
 * diverging 覆盖**全部**可选行(= 真实类型 None),这里就会误判成 partial ——
 * 探针 A 组正是盯着这个不变式。
 * @param spec - 该文件的纳入状态;缺失 = 默认全选。
 */
export function includeStateOf(spec: LineSelectionSpec | undefined): IncludeState {
  if (spec === undefined) {
    return 'all';
  }
  if (spec.diverging.length === 0) {
    return spec.kind === 'all' ? 'all' : 'none';
  }
  return 'partial';
}

/**
 * `DiffSelection` → 我们的 `LineSelectionSpec`(**`desktop-diff.tsx:502` 的
 * `selectionToSpec` 的同一个口径**)。
 *
 * 为什么这里**不**直接 import `selectionToSpec`:那个函数住在 `desktop-diff.tsx`,
 * 而那个模块 import 整个 diff 渲染层(`side-by-side-diff` 一族、虚拟列表、
 * 上下文菜单宿主)。store 引它会把渲染层拖进**每一个**打包 store 的探针与
 * `changes-cache` 那条链;而这 6 行本身就是纯数据变换。⇒ 两处必须同口径,
 * 判据把它们逐例比对(`docs/probes/changes-state-adoption-probe.mjs` 的 P5)。
 * @param selection - 镜像回来的一份选择。
 * @param selectable - 该文件的可选中行(**只有调用方知道**;投影里就是原 spec 的那一份)。
 */
function specOfMirrorSelection(
  selection: DiffSelection,
  selectable: readonly number[] | undefined,
): LineSelectionSpec {
  const kind: 'all' | 'none' =
    selection.getSelectionType() === DiffSelectionType.None ? 'none' : 'all';
  if (selectable === undefined) {
    // 没有可选中行清单时**如实不写这个键**(不编一个 `[]`:那会让
    // `includeStateOf` 的「diverging 覆盖全部可选行 ⇒ 真实 All/None」那条判据失真)。
    return { kind, diverging: [] };
  }
  const diverging = selectable.filter((index) =>
    kind === 'all' ? !selection.isSelected(index) : selection.isSelected(index));
  return { kind, diverging, selectable: [...selectable] };
}

/** 宿主 `ChangedFile` → `fileStatusKindOf` 要的那个形状(与 store 里既有的两处调用同口径)。 */
function statusLikeOf(file: ChangedFile): { status?: ChangedFile['unstaged']; untracked?: boolean; conflicted?: boolean } {
  return {
    ...(file.unstaged !== undefined ? { status: file.unstaged } : {}),
    ...(file.untracked !== undefined ? { untracked: file.untracked } : {}),
    ...(file.conflicted !== undefined ? { conflicted: file.conflicted } : {}),
  };
}

/**
 * **扁平的纳入状态 → 上游状态机**(`docs/changes-state-adoption.md` §4.3 的**第 1 步**,2026-10 已落地)。
 *
 * ## 它做什么
 *
 * 「状态刷新 / 提交成功之后,每个文件的纳入状态怎么变」这条规则在上游**只有一份实现**:
 * `lib/stores/updates/changes-state.ts` 的 `updateChangedFiles(state, status, clearPartialState)`
 * —— 那份 353 行**逐字镜像**已在树里(`cmp` 无输出),`app-store.ts:2999-3004` 是它唯一的
 * 上游调用点。本函数把我们的扁平数据投影成它要求的两个入参、调它、再把结果投影回来:
 *
 * ```
 * includeState + RepoStatus ──投影──▶ IChangesState + IStatusResult
 *        │                                      │
 *        │                    applyChangesStatus(state, status, noopStatsStore, /* clearPartialState *\/ true)
 *        │                                      │
 *        └────────── 投影回来 ◀── IChangesState.workingDirectory.files[i].selection
 * ```
 *
 * 上游为什么要求那两个类型(以及这层投影为什么不可省):
 *  - `updateChangedFiles` 按 **`WorkingDirectoryFileChange.id`** 合并 ——
 *    id 是 `${status.kind}+${path}`(`models/status.ts:262-273`),所以「同一个文件」的判定
 *    依赖 kind,而不是只看路径(`repo-state-cache.ts` 文件头的偏差 1 说的是同一件事);
 *  - 它读的是 **`DiffSelection`**(`file.selection.getSelectionType()` /
 *    `file.withSelection(...)` / `file.withIncludeAll(false)`),不是我们的三态字符串。
 *
 * ## 语义(逐条对应上游,判据 `docs/probes/changes-state-adoption-probe.mjs`)
 *
 * | 旧状态 | 结果 | 上游依据 |
 * |---|---|---|
 * | `Partial`(有 diverging) | `{kind:'none', diverging:[]}` | `changes-state.ts:47-54` 的 `withIncludeAll(false)` |
 * | `All` | **原样**(同一份 selection) | `:56` 的 `file.withSelection(existingFile.selection)` |
 * | `None` | **原样** | 同上 —— 这是「用户显式取消勾选」被记住的那条路 |
 * | status 里新出现的文件 | 不写键(缺失 = 默认 All) | `:57-59` 走 `else` 分支,该文件出厂就是 All |
 *
 * ## 与退役的 `clearPartialAfterCommit` 的关系
 *
 * 两者**逐例同值**(判据 P4 用四档夹具逐个比对过),但**真源不同**:上面那张表才是规则,
 * 本函数只是把我们的形状喂进那份真源。旧的那份**保留但不再被调用**(用户裁决「不删」),
 * 退役条件写在它自己的 JSDoc 上。
 *
 * ## 诚实边界
 *
 * 1. 我们的 `RepoStatus` **没有** `rebaseInternalState` / `squashMsgFound` 这些字段
 *    (它们在宿主载荷里、客户端没投影),所以 `IStatusResult` 的这两项如实填
 *    `null` / `false`;`updateConflictState` 的**返回**被本函数丢弃(我们的快照里没有
 *    `conflictState` 这个槽)。投影的**输入**够用,是因为这条链只关心 `workingDirectory`。
 * 2. `statsStore` 是 no-op(遥测不在本插件范围内),所以 `performEffectsFor*` 的计数不产生
 *    任何可观察后果 —— 与 `stats-store.ts` 文件头核实过的结论一致(除计数外零副作用)。
 * @param includeState - 变换前的纳入状态表(键 = 仓库内相对路径)。
 * @param status - 当前 `RepoStatus`;**`null`(还没刷新过)时按「只有 includeState 这些文件」投影**,
 *   绝不因此把整张表抹掉(那是本仓咬过的「静默丢选区」缺陷)。
 * @returns 新的表,键集与入参**完全相同**(不新增、不删除)。
 */
export function mirroredClearPartial(
  includeState: Record<string, LineSelectionSpec>,
  status: RepoStatus | null,
): Record<string, LineSelectionSpec> {
  const paths = Object.keys(includeState);
  if (paths.length === 0) {
    return {};
  }

  const files = status?.files ?? [];
  const kindByPath = new Map<string, FileStatusKind>();
  for (const file of files) {
    kindByPath.set(file.path, fileStatusKindOf(statusLikeOf(file)));
  }
  const kindOf = (path: string): FileStatusKind => kindByPath.get(path) ?? 'modified';

  // ---- 旧状态:每个键一条 file,选择由我们的 spec 投影而来 ----
  const state: IChangesState = {
    workingDirectory: WorkingDirectoryStatus.fromFiles(paths.map((path) =>
      new WorkingDirectoryFileChange(path, appFileStatusOf(kindOf(path)), toDiffSelection(includeState[path])))),
    commitMessage: DefaultCommitMessage,
    showCoAuthoredBy: false,
    coAuthors: [],
    conflictState: null,
    stashEntry: null,
    selection: {
      kind: ChangesSelectionKind.WorkingDirectory as ChangesSelectionKind.WorkingDirectory,
      selectedFileIDs: [],
      diff: null,
    },
    currentBranchProtected: false,
    currentRepoRulesInfo: new RepoRulesInfo(),
    fileListFilter: {
      filterText: '', isIncludedInCommit: false, isExcludedFromCommit: false,
      isNewFile: false, isModifiedFile: false, isDeletedFile: false,
    },
  };

  // ---- 新 status:工作区那一批(默认 All)+ 「在 includeState 里但不在 status 里」的补集 ----
  const statusPaths = files.map((file) => file.path);
  const inStatus = new Set(statusPaths);
  const allNewPaths = [...statusPaths, ...paths.filter((path) => !inStatus.has(path))];
  const nextStatus: IStatusResult = {
    exists: true,
    mergeHeadFound: status?.operation === 'merge',
    squashMsgFound: false,
    rebaseInternalState: null,
    isCherryPickingHeadFound: status?.operation === 'cherry-pick',
    doConflictedFilesExist: files.some((file) => file.conflicted === true),
    workingDirectory: WorkingDirectoryStatus.fromFiles(allNewPaths.map((path) =>
      new WorkingDirectoryFileChange(
        path,
        appFileStatusOf(kindOf(path)),
        DiffSelection.fromInitialSelection(DiffSelectionType.All),
      ))),
    ...(status !== null
      ? {
        currentBranch: status.branch,
        currentTip: status.headSha,
        currentUpstreamBranch: status.upstream ?? undefined,
        branchAheadBehind: { ahead: status.ahead, behind: status.behind },
      }
      : {}),
  };

  // ---- 调**上游那条规则**,再把结果投影回来 ----
  const result = applyChangesStatus(state, nextStatus, noopStatsStore, true);
  const byPath = new Map(result.workingDirectory.files.map((file) => [file.path, file]));
  const out: Record<string, LineSelectionSpec> = {};
  for (const path of paths) {
    const file = byPath.get(path);
    out[path] = file === undefined
      ? includeState[path]
      : specOfMirrorSelection(file.selection, includeState[path].selectable);
  }
  return out;
}

/**
 * 状态刷新/提交之后对既有纳入状态的**唯一**变换 —— 上游 `clearPartialState: true`。
 *
 * > ⚠️ **2026-10 已退役(不再被调用,但按用户裁决「不删」保留在这棵树上)。**
 * > 它当年是本插件对同一条规则的**第二份实现**。现在产品两个调用点
 * > (`setHideWhitespace` 与 `commit()` 的 emit)都走
 * > {@link mirroredClearPartial} → 镜像的 `applyChangesStatus`
 * > (`src/core/desktop/lib/stores/app-store.ts`,逐字合成上游 `app-store.ts:2999-3004`)。
 * > **退役条件(满足后即可删除本函数)**:① `docs/probes/changes-state-adoption-probe.mjs`
 * > 的等价性判据(P4)不再需要这一份对照物(例如 `Snapshot.includeState` 被容器切换
 * > 换成 `IChangesState` 本身 —— 即 `docs/changes-state-adoption.md` §4.3 的第 2 步);
 * > ② 且没有任何探针/文档再引用它(实证命令:`grep -rn clearPartialAfterCommit src/ docs/` 只剩本注释)。
 * > 在那之前留着它,是因为**删掉它就少一个能证明新链等价的对照物**(而且用户明确说「不删」)。
 *
 * **为什么它是 `export` 的**:退役之后它在本文件里**零调用点**,而 `tsconfig.base.json`
 * 开着 `noUnusedLocals` —— 不导出就编译不过(TS6133),而删掉它违反「不删」。导出还带来
 * 一件真事:新链的判据需要一个**对照物**来证明「换实现之后四档结果逐例不变」
 * (`docs/probes/changes-state-adoption-probe.mjs` 的 P4 直接 import 本函数当 oracle),
 * 所以这个导出是**判据用的**,不是预留 API。
 *
 * 上游把这条规则写成纯函数 `updateChangedFiles(state, status, clearPartialState)`
 * (`lib/stores/updates/changes-state.ts:32-116`),三条依据逐字核过:
 *  - `:47-54`:仅当 `clearPartialState` 为真**且**既有选择是 `Partial` 时,
 *    才 `file.withIncludeAll(false)`(⇒ 不含);
 *  - `:56` 的 `file.withSelection(existingFile.selection)`:其余情况
 *    (`All` / `None`)**原样保留** —— 这正是「用户显式取消勾选」能被记住的那条路径;
 *  - 两处调用方都传 `true`:**提交成功后** `lib/stores/app-store.ts:3756-3759`
 *    (真值在 `:3758`),**隐藏空白开关** `:7954-7957`(真值在 `:7956`)。
 *
 * **为什么不能整张抹掉**(这里以前写的就是 `includeState: {}`):本仓「缺失 = 默认 All」
 * (`includeStateOf`),抹表等于把所有文件改回「纳入提交」⇒ 用户明确排除的文件会在
 * **下一次提交**里被带上;而 `includedFiles()` 同时是生成提交信息的真源
 * (`commit()` 里那段注释)⇒ 生成的提交信息也会与实际提交内容不一致。
 *
 * 判据:`docs/probes/commit-include-state-probe.mjs` 的 P1/P2/P3(修前 2/5 红,修后 5/5)。
 * @param state - 变换前的纳入状态表(键 = 仓库内相对路径)。
 * @returns 新的表:`partial` → `none`,其余**原样**(含 `selectable`)。
 */
export function clearPartialAfterCommit(
  state: Record<string, LineSelectionSpec>,
): Record<string, LineSelectionSpec> {
  const next: Record<string, LineSelectionSpec> = {};
  for (const [file, spec] of Object.entries(state)) {
    next[file] = includeStateOf(spec) === 'partial'
      ? { kind: 'none', diverging: [], ...(spec.selectable === undefined ? {} : { selectable: spec.selectable }) }
      : spec;
  }
  return next;
}

/**
 * **单文件提交时用「占位摘要」代替空摘要** —— 上游 `prepopulateCommitSummary`。
 *
 * 逐字对上游(`ui/changes/filter-changes-list.tsx:935-936`):
 * ```ts
 * const prepopulateCommitSummary =
 *   filesSelected.length === 1 && !repository.isTutorialRepository
 * ```
 * `filesSelected` 是**纳入提交**的那些文件(`:925-928` 的
 * `f.selection.getSelectionType() !== DiffSelectionType.None`),在我们的模型里就是
 * `includedFiles()`(`includeState !== 'none'`,含 `partial`)。
 *
 * **唯一不复现的一项**是 `!repository.isTutorialRepository`:那是 Desktop 的
 * onboarding 教程仓库(我们产品里没有教程仓库这个概念)⇒ 这一项恒为真,与上游
 * 默认(非教程仓库)完全一致。这是**有意的**、写在 `docs/changes-commit-parity.md` 的差异。
 * @param files - **纳入提交**的文件清单(不是工作区全部文件)。
 * @returns true = 摘要可以为空,提交时改用占位摘要。
 */
export function prepopulateCommitSummaryOf(files: readonly ChangedFile[]): boolean {
  return files.length === 1;
}

/**
 * 提交摘要输入框的占位文本 —— 上游 `getPlaceholderMessage`
 * (`ui/changes/filter-changes-list.tsx:859-883` 逐行):
 *
 * ```ts
 * if (!prepopulateCommitSummary) return 'Summary (required)'
 * const fileName = basename(firstFile.path)
 * switch (firstFile.status.kind) {
 *   case New: case Untracked: return `Create ${fileName}`
 *   case Deleted:             return `Delete ${fileName}`
 *   default:                  return `Update ${fileName}`
 * }
 * ```
 *
 * 两处**已登记**的取舍:
 *  1. 非单文件时的文案按仓库既有约定(goal §11.9「用户可见文案本地化」)写成
 *     `摘要(必填)`,对应上游的 `Summary (required)`;单文件那三种是
 *     `Create/Delete/Update <basename>` 的**逐字**上游文案(它们是拼出来的标题,不是 UI 文案)。
 *  2. 上游按解析后的 `AppFileStatusKind` 分流,我们按 porcelain 字母分流
 *     (`A`/`untracked` → Create、`D` → Delete、其余 → Update)。两边的分流在
 *     `New|Untracked / Deleted / Modified / Renamed / Copied / Conflicted` 六档上
 *     **逐例实测等价**(判据:`docs/probes/commit-form-parity-probe.mjs` 的
 *     R23(未跟踪 ⇒ Create)、R24(删除 ⇒ Delete)、R27–R29(重命名 / 复制 / 冲突 ⇒ Update),夹具形状逐字照
 *     `src/core/parse.ts:68-90` 的产出)。**没有**实测的只有「上游把 New 与 Untracked
 *     分成两个 kind」这一点 —— 我们的模型用**一个** `untracked` 标志表示它们,两档都归 Create。
 * @param files - **纳入提交**的文件清单。
 * @returns 占位文本(它**不是**装饰:见 `summaryOrPlaceholderOf`)。
 */
export function commitPlaceholderOf(files: readonly ChangedFile[]): string {
  if (!prepopulateCommitSummaryOf(files)) {
    return '摘要(必填)';
  }
  const only = files[0];
  const name = only.path.split('/').pop() ?? only.path;
  const letter = only.unstaged ?? only.staged ?? 'M';
  if (letter === 'A' || only.untracked === true) {
    return `Create ${name}`;
  }
  if (letter === 'D') {
    return `Delete ${name}`;
  }
  return `Update ${name}`;
}

/**
 * **真正会被提交的摘要** —— 上游 `commit-message.tsx:587-592` 的 `summaryOrPlaceholder`:
 *
 * ```ts
 * get summaryOrPlaceholder() {
 *   return this.props.prepopulateCommitSummary && !this.state.commitMessage.summary
 *     ? this.props.placeholder
 *     : this.state.commitMessage.summary
 * }
 * ```
 *
 * 三个必须逐字保留的细节(少一个就会与上游分叉,判据都在
 * `docs/probes/commit-form-parity-probe.mjs`):
 *  1. `!summary` 是**空串判定**,不是 `isEmptyOrWhitespace` ⇒ **全空白**的摘要
 *     (`'   '`)**不会**被占位取代 ⇒ 它算「空白摘要」⇒ 按钮**禁用**(R02);
 *  2. 这条替换既喂 `buttonEnabled` 里的 `!isSummaryBlank`(`:1602`),**也喂提交载荷**
 *     (`:620` 的 `summary: this.summaryOrPlaceholder`)⇒ 单文件 + 空摘要点下去,
 *     提交标题就是 `Update <文件名>`,**不是空字符串**(R01/R10/R20/R23/R24);
 *  3. 它按**纳入提交的文件数**算(1 个才算单文件),与工作区文件总数无关(R10)。
 * @param summary - 表单里用户实际输入的摘要(可能是空串)。
 * @param files - **纳入提交**的文件清单。
 * @returns 界面判定与提交载荷共用的那条摘要。
 */
export function summaryOrPlaceholderOf(summary: string, files: readonly ChangedFile[]): string {
  return prepopulateCommitSummaryOf(files) && !summary ? commitPlaceholderOf(files) : summary;
}

/**
 * 「当前这份 diff 对应哪个目标」的**唯一**一处定义 —— 请求序号与陈旧判定都靠它。
 *
 * 为什么必须抽出来(而不是留在 `loadDiff()` 里):这个 key 有两个消费方 ——
 * `loadDiff()` 自己(守卫 2:`:760-762`),以及任何需要判断「屏幕上这份 diff 还是不是
 * 当前目标的」的地方(例如以后要在状态刷新时决定**复用还是清空**,上游同义的规则在
 * `lib/stores/updates/changes-state.ts:90-95`)。写在两处必然漂移,而漂移的后果是
 * **把另一个文件的行选区留在屏幕上**(见 `loadDiff()` 上方的说明)。
 * @param file - 仓库内相对路径。
 * @param staged - true = 取索引与工作区之间的 diff(我们模型里的「已暂存」)。
 * @param hideWhitespace - 隐藏空白改动(**必须进 key**:它是重跑 `git diff -w`,
 *   标志变了而 key 不变 ⇒ 缓存命中、不会重取)。
 * @param headSha - 当前 HEAD;切分支/提交后靠它作废旧 diff。
 * @returns 形如 `路径:s|u:w|:sha` 的 key。
 */
function diffKeyOf(file: string, staged: boolean, hideWhitespace: boolean, headSha: string): string {
  return `${file}:${staged ? 's' : 'u'}:${hideWhitespace ? 'w' : ''}:${headSha}`;
}

/** 完整快照。 */
export interface Snapshot {
  ready: boolean;
  /** 服务端返回的错误(仓库清单等全局错误)。 */
  globalError: GitError | null;
  /**
   * 最近一次**推送失败**的原始错误;`null` = 没有尚未关闭的失败弹窗。
   *
   * 为什么原样放 `GitError` 而不在这里折成「弹窗种类」:种类是**表现层**的判断
   * (`bits.tsx` 的 `pushFailureKindOf`,判据照上游
   * `ui/dispatcher/error-handlers.ts`),放两份必然分叉。这里只搬运宿主的机器可读错误
   * (`code` + `message` + `detail`)。
   *
   * 上游对应物:`app-store.ts:5005-5010` 的 `_pushError` → `PopupManager.addErrorPopup`
   * (`lib/popup-manager.ts:131`)把错误推进**弹窗队列**;关闭 = 把队首 pop 掉。
   */
  pushFailure: GitError | null;
  /**
   * 最近一次**生成提交信息失败**的原始错误;`null` = 没有尚未关闭的失败弹窗。
   *
   * 用户 2026-10-07 报:「Changes 页面左下角点击生成的时候,**如果出现生成错误,
   * 错误通知里缺失具体信息**」。改前这条失败走 `store.fail()`,而那个方法对
   * `code === 'internal'` **刻意不附 `detail`**(`fail()` 的 suffix 判据),
   * 于是宿主放在信封里的原始证据(生成 diff 失败时的 git stderr、
   * 见 `git-service.ts` 的 `classifyGitFailure`)在客户端被**丢掉**;
   * 而且它只是一条 7 秒后消失、无法选中的 toast。
   *
   * 这里照推送失败那条已经落地的模式(`pushFailure` 字段 + `bits.tsx` 的弹窗,
   * 见 `docs/push-failure-surfaces.md` §10)原样搬运宿主的机器可读错误:
   * **不在这里折成文案、不在这里截断**,弹窗逐字播 `message`、把 `detail` 放进
   * 可滚可选的 `<pre>`、并附一行 `错误码:<code>`。
   */
  generateFailure: GitError | null;
  repos: RepoEntry[];
  hidden: string[];
  canPickDirectory: boolean;
  current: string;
  tab: TabId;
  status: RepoStatus | null;
  sync: SyncState | null;
  /**
   * **本地有、远端没有的标签名**(宿主路由 `tag-unpushed` 的读数)。
   *
   * 它存在的唯一理由是 History 右键菜单那一项:`ui/history/commit-list.tsx:373-377` 的
   * `getUnpushedTags` 把 `commit.tags` 与它取交集,`:893-899` 再用交集决定
   * `Delete tag <name>` 的 `enabled`。**`[]` 与 `undefined` 在这里等价**
   * (那份实现是 `new Set(this.props.tagsToPush ?? [])`)—— 所以「拿不到数据」时回 `[]`
   * 的净效果是「项在列但灰」,不会误报可删(那才是危险的:删掉一个**已推送**的标签只删
   * 本地、远端还在)。
   *
   * **不是按仓库缓存的字段**(照 `status`/`sync`/`branches` 的处置):它由宿主现算、
   * 切仓库时清空,`refreshAll()` / 打开 History 页签立刻拿回来。
   */
  tagsToPush: string[];
  branches: BranchEntry[];
  selectedFiles: string[];
  /**
   * **每个变更文件的「提交纳入状态」**(= Desktop 的
   * `WorkingDirectoryFileChange.selection` / `DiffSelection`)。
   *
   * 这是**客户端模型**,不是索引的镜像:
   *  - 勾选/取消勾选**只改这里**,一个 git 命令都不发;
   *  - 索引只在 `commit()` 那一刻按它 materialize(照上游
   *    `lib/git/commit.ts:24-31` 的 `unstageAll` + `stageFiles`,再按
   *    `lib/git/update-index.ts:109-175` 分流整文件 / 部分补丁);
   *  - 键是**路径**;缺失 = 默认 `All`(上游每个 `WorkingDirectoryFileChange`
   *    出厂就是 `DiffSelection.fromInitialSelection(All)`,即**默认纳入提交**)。
   *
   * 值用 `LineSelectionSpec` 而不是 `DiffSelection` 实例:它是纯数据(能进快照、
   * 能直接喂 `api.stageLines`),而且 `desktop-diff.tsx` 的 `selectionToSpec` /
   * `specToSelection` 与它互逆(探针里对 host 的 `toDiffSelection` 做过逐行等价比对)。
   */
  includeState: Record<string, LineSelectionSpec>;
  diff: DiffResult | null;
  diffKey: string;
  log: CommitEntry[];
  logHasMore: boolean;
  logLoading: boolean;
  selectedCommit: string;
  commitDetailFiles: { path: string; status: string; additions: number; deletions: number }[];
  commitForm: CommitForm;
  auth: AuthStatePayload | null;
  remoteRepos: RemoteRepo[];
  remoteReposLoading: boolean;
  models: { provider: string; providerName: string; id: string; name: string }[];
  model: string;
  stagedOnly: boolean;
  /** Unified(false)还是 Split(true)。键名照 Desktop。 */
  sideBySide: boolean;
  /** Changes 页签是否隐藏空白改动。 */
  hideWhitespace: boolean;
  /** History 页签是否隐藏空白改动(Desktop 是两个独立开关)。 */
  hideWhitespaceHistory: boolean;
  /** 远端页签的角标计数。 */
  counts: Partial<Record<TabId, number>>;
  /** 本地工作区文件清单(Code 页签用;按仓库缓存,切仓库时清空)。 */
  repoFiles: { path: string; files: string[]; truncated: boolean } | null;
  /** 本机可用的外部编辑器(懒加载)。 */
  externalApps: { id: string; label: string }[];
  /** 生成前需要用户确认「覆盖已写内容」时为 true。 */
  pendingGenerateConfirm: boolean;
  /** host 的存储是否持久化;null = 还没探到。 */
  storagePersistent: boolean | null;
  storageError: string | null;
  busy: string;
  /**
   * **进行中的网络动作的进度**(抓取 / 拉取 / 推送 / 强推)。
   *
   * 上游的载体是 `IRepositoryState.pushPullFetchProgress`(`lib/app-state.ts:632`),
   * 由 `AppStore.updatePushPullFetchProgress`(`lib/stores/app-store.ts:5168`)写入;
   * 同步按钮直接吃它(`ui/app.tsx:3622` 的 `const progress = state.pushPullFetchProgress`
   * → `push-pull-button.tsx:54` 的 `progress` prop)。
   *
   * **这是真数据源,不是装饰**:写入点是**真实的动作边界**——
   *  1. 动作开始前,上游 `lib/git/{fetch,pull,push}.ts` 各自发的**初始进度**
   *     (`fetch.ts:84` / `pull.ts:100` / `push.ts:102-106`),标题/远端/分支都取自
   *     真实输入;
   *  2. 动作返回后进入**刷新阶段**,上游 `app-store.ts:5983-6000`(fetch)、
   *     `:5350-5366`(push)、`:5608-5617`(pull)各自发的几条 `kind:'generic'`,
   *     `value` 用上游自己的权重常量算(`fetchWeight` / `pullWeight` /
   *     `pushWeight` / `refreshWeight`),不是拍的数;
   *  3. 结束时置回 `null`(`finally`)。
   *
   * ⚠️ **唯一缺的那一段是「网络进行中」的百分比**(上游 `lib/progress/git.ts` 把
   * `git --progress` 的 stderr 逐行解析成 0→1)。那需要宿主把 git 的 stderr 逐行
   * 吐出来,而 `src/host/git-runner.ts` 的 `run()` 是**收集到结束**
   * (`open()` 那条流只开 stdout,stderr 是 `{maxBytes}` 收集态),路由又是
   * 一问一答的 JSON 信封(`routes.ts` 的 `writeJson` 只在 handler 返回后写一次)。
   * 所以中间段今天只能停在初始值;详见 `sync-state.ts` 的文件头与交付说明。
   */
  progress: Progress | null;
  /**
   * **「被我们重写过历史、因此建议强推」的分支表** —— 上游
   * `IBranchesState.forcePushBranches`(`lib/app-state.ts:736`,类型
   * `ReadonlyMap<string, string>`:分支短名 → 重写后的 tip sha)。
   *
   * 上游只在两处写入(`AppStore._addBranchToForcePushList`,`app-store.ts:9676`):
   *  1. **修订(amend)** 提交后,新 sha ≠ 被修订的 sha(`app-store.ts:3779-3797`);
   *  2. 多提交操作(rebase / squash / reorder,**不含** cherry-pick)成功后
   *     (`ui/dispatcher/dispatcher.ts:3845-3854`)。
   * 我们这一侧只有第 1 条有对应的真实动作(`commit()` 的 `form.amend`);第 2 条
   * 依赖的 rebase/squash/reorder 界面在本插件里**还没有**,所以不伪造。
   *
   * 消费点是上游 `lib/rebase.ts:39` 的 `getCurrentBranchForcePushState()`:
   * 表里有当前分支**且值等于当前 tip sha** ⇒ `ForcePushBranchState.Recommended`
   * (按钮变「强推」);否则 `Available`(按钮是「拉取」,强推作为下拉项)。
   * 见 `src/client/sync-state.ts`。
   *
   * 用普通对象而不是 `Map`:快照必须是可比较的纯数据(`useSyncExternalStore` 的
   * 读取入口),`Map` 的引用相等语义在这里只会制造「同内容不同对象 ⇒ 白重渲染」。
   * 唯一需要 `Map` 的地方(`getCurrentBranchForcePushState`)在投影层转一次。
   */
  forcePushBranches: Record<string, string>;
  toasts: Toast[];
}

function initial(): Snapshot {
  return {
    ready: false,
    globalError: null,
    pushFailure: null,
    generateFailure: null,
    repos: [],
    hidden: [],
    canPickDirectory: false,
    current: '',
    tab: 'changes',
    status: null,
    sync: null,
    tagsToPush: [],
    branches: [],
    selectedFiles: [],
    includeState: {},
    diff: null,
    diffKey: '',
    log: [],
    logHasMore: false,
    logLoading: false,
    selectedCommit: '',
    commitDetailFiles: [],
    commitForm: {
      summary: '',
      description: '',
      amend: false,
      signoff: false,
      noVerify: false,
      allowEmpty: false,
      generating: false,
      generatedBy: '',
    },
    auth: null,
    remoteRepos: [],
    remoteReposLoading: false,
    models: [],
    model: '',
    stagedOnly: true,
    sideBySide: getShowSideBySideDiff(),
    hideWhitespace: getHideWhitespaceInChangesDiff(),
    hideWhitespaceHistory: getHideWhitespaceInHistoryDiff(),
    counts: {},
    repoFiles: null,
    externalApps: [],
    pendingGenerateConfirm: false,
    storagePersistent: null,
    storageError: null,
    busy: '',
    progress: null,
    forcePushBranches: {},
    toasts: [],
  };
}

/**
 * 从一份快照里挑出**属于某个仓库**的那些字段(`RepoStateCache` 的入参/初值)。
 *
 * 返回值类型是 `RepoScopedSnapshot = Pick<Snapshot, …>`,所以**少挑一个字段就是编译错误** ——
 * 这正是要的:否则「切一次仓库静默丢一个字段」会再次发生(`logHasMore` / `commitDetailFiles`
 * 那一类正是这样丢的)。
 * @param snap - 来源快照。
 * @returns 只含按仓库字段的那一份。
 */
function repoScopedOf(snap: Snapshot): RepoScopedSnapshot {
  return {
    selectedFiles: snap.selectedFiles,
    includeState: snap.includeState,
    diff: snap.diff,
    diffKey: snap.diffKey,
    log: snap.log,
    logHasMore: snap.logHasMore,
    selectedCommit: snap.selectedCommit,
    commitDetailFiles: snap.commitDetailFiles,
    forcePushBranches: snap.forcePushBranches,
    commitForm: snap.commitForm,
  };
}

/** 订阅式 store。 */
/** 本前端产物的构建时间戳(由构建脚本注入)。 */
declare const __BUILD_STAMP__: string | undefined;
const BUILD_STAMP: string = typeof __BUILD_STAMP__ === 'string' ? __BUILD_STAMP__ : '未知';

export class GitStore {
  private state: Snapshot = initial();
  /** `loadDiff()` 的请求序号:只让最新一次的响应落地(见该方法上的说明)。 */
  private diffSeq = 0;

  /**
   * **按仓库**的视图状态(上游 `RepositoryStateCache` 与上游一致的容器 + 我们自己的形状)。
   *
   * 上游事实与理由写在 `./repo-state-cache.ts` 的文件头;判据是
   * `docs/probes/changes-cache-probe.mjs`(切走再切回:选中 / 草稿 / 纳入状态 / diff)。
   *
   * 初值取自本文件的 `initial()`(经 `repoScopedOf`)—— **不在这里再写一份字面量**,
   * 否则「默认值」就有了第二份真源。
   */
  private readonly repoStates = new RepoStateCache({ initial: () => repoScopedOf(initial()) });

  /**
   * 定时器:**网络动作在飞期间**的进度轮询(见 {@link startSyncProgressPolling})。
   *
   * 与 `pollTimer`(`:503`,每 5s 一次完整 `refreshStatus`)刻意**分开**:
   * 这个每 250ms 只查一张宿主内存表,合成一个会让工作区刷新变成 4 次/秒。
   *
   * ⚠️ 声明位置上为什么在这里而不挨着 `pollTimer`:那一带的几个字段都在
   * **constructor 之后**(存量 `member-ordering` 违规 4 条),再往那儿加一个就是
   * 第 5 条新增违规(`check-lint` 会红)。本字段放在 constructor 之前。
   */
  private syncProgressTimer: ReturnType<typeof setInterval> | undefined;

  /**
   * @param sessionId - 当前会话 id;用于问宿主「这个会话在哪个工作区」,
   *   从而把正在编辑的项目自动登记进仓库清单。
   */
  constructor(private readonly sessionId: string = '') {}

  /** 目录选择器:由插件的 apply() 注入(客户端原生弹窗优先)。 */
  /** 返回 null 表示「没有选择器」,不是「用户取消」。 */
  private pickDirectory: (() => Promise<string | null> | null) | undefined;

  setDirectoryPicker(fn: () => Promise<string | null> | null): void {
    this.pickDirectory = fn;
  }
  private readonly listeners = new Set<() => void>();
  private toastSeq = 0;
  /** 定时器:工作区自动刷新。 */
  private pollTimer: ReturnType<typeof setInterval> | undefined;

  /** React 读取入口(必须引用稳定)。 */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  snapshot = (): Snapshot => this.state;

  private emit(patch: Partial<Snapshot>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) {
      try { listener(); } catch { /* 单个订阅者异常不影响其他 */ }
    }
  }

  // ---------- 提示 ----------

  toast(message: string, kind: 'ok' | 'err' = 'ok', action?: { label: string; run: () => void }): void {
    const id = ++this.toastSeq;
    const entry: Toast = {
      id,
      message,
      kind,
      ...(action !== undefined ? { actionLabel: action.label, action: action.run } : {}),
    };
    this.emit({ toasts: [...this.state.toasts, entry] });
    setTimeout(() => {
      this.emit({ toasts: this.state.toasts.filter((t) => t.id !== id) });
    }, kind === 'err' ? 7000 : 3600);
  }

  dismissToast(id: number): void {
    this.emit({ toasts: this.state.toasts.filter((t) => t.id !== id) });
  }

  private fail(error: GitError): void {
    const suffix = error.detail !== undefined && error.detail !== '' && error.code !== 'internal'
      ? `（${error.detail.split('\n')[0] ?? ''}）`
      : '';
    this.toast(`${error.message}${suffix}`, 'err');
  }

  // ---------- 启动 ----------

  async start(): Promise<void> {
    if (this.state.ready) {
      return;
    }
    // 路由是异步挂载的(等 storage domain),先探活再取清单。
    const readiness = await waitForRoutes();
    if (!readiness.ok) {
      this.emit({
        ready: true,
        globalError: { code: 'internal', message: 'dsh-git 服务未就绪:host 侧插件可能未激活,或需要重启 DSH。' },
      });
      return;
    }
    this.emit({
      storagePersistent: readiness.health.persistent,
      storageError: readiness.health.storageError,
    });
    // 版本错配检测:host 半不参与热重载,刷新页面只会拿到新的前端。
    // 不检测的话,旧 host 的旧行为会被当成「新代码的 bug」,极难排查。
    //
    // 这里的**就地收窄**是必要的:`api.ts` 的 `HealthPayload` 还没声明 `build`
    // (那个文件由另一条线持有,本次不改),但 host **确实**在回它 ——
    // `host/routes.ts:141` 的 `build: deps.buildStamp ?? ''`。所以这不是「读一个
    // 不存在的字段」,而是「声明落后于载荷」;`as` 让读取保持真实,且在
    // `HealthPayload` 补上 `build: string` 之后可以直接删掉(见交付说明)。
    const hostBuild = (readiness.health as HealthPayload & { build?: string }).build;
    if (BUILD_STAMP === '未知') {
      // 前端自己都没有戳(构建脚本没注入),就没法比对,别误报。
    } else if (hostBuild !== undefined && hostBuild !== '' && hostBuild !== BUILD_STAMP) {
      this.toast(
        `host 半是旧构建(${hostBuild}),页面是 ${BUILD_STAMP}:行为可能不一致。请重启 DSH 让 host 重新加载。`,
        'err',
      );
    } else if (hostBuild === undefined) {
      this.toast(
        `host 半没有上报构建号(说明它早于当前前端):请重启 DSH。当前前端 build ${BUILD_STAMP}。`,
        'err',
      );
    }

    if (!readiness.health.persistent) {
      // 存储降级必须让用户知道:否则「加了仓库、重启就没了」看起来像 bug。
      // storageError 可能是 undefined(旧 host 没这个字段),所以只在它是
      // **非空字符串**时才拼出来 —— 否则会出现「…会丢失(undefined)」这种提示。
      const reason = typeof readiness.health.storageError === 'string' && readiness.health.storageError !== ''
        ? `原因:${readiness.health.storageError}`
        : 'host 没有给出原因(可能是旧构建,先重启 DSH 再试)。';
      this.toast(`存储不可用,本次运行的仓库清单与登录态重启后会丢失。${reason}`, 'err');
    }
    const repos = await api.repos();
    if (repos.ok) {
      let list = repos.value.repos;

      // 1) **总是**检查当前会话所在的工作区项目:是 git 仓库就登记进清单。
      //    (以前只在清单为空时才探测,于是已经加过几个仓库的用户,在新项目里
      //     打开页签永远不会看到当前项目。)
      let workspacePath: string | null = null;
      let autoAdded = false;
      let detectReason = '';
      const detected = await api.autodetect(this.sessionId);
      if (detected.ok) {
        workspacePath = detected.value.path;
        autoAdded = detected.value.added === true;
        detectReason = detected.value.reason ?? '';
        // `curly` 是硬闸门(见 `.eslintrc.yml` 的 BUILTIN 段):单行 if 也必须带花括号。
        if (detected.value.repos.length > 0) { list = detected.value.repos; }
      }

      // 2) 选中优先级:当前工作区项目 → 宿主持久化的上次选中 → 清单第一个。
      //    页签是**按会话**的,所以「当前项目」优先于全局记忆是符合直觉的。
      let current = '';
      if (workspacePath !== null && workspacePath !== '') {
        current = workspacePath;
      } else {
        current = this.pickInitial(list, repos.value.lastSelected);
        // 工作区不是 git 仓库时,至少别让用户看着空白:把原因说清楚。
        if (list.length === 0 && detectReason !== '') {
          this.toast(`没有找到可用的 git 项目:${detectReason}`, 'err');
        }
      }

      this.emit({
        ready: true,
        repos: list,
        hidden: repos.value.hidden,
        canPickDirectory: repos.value.canPickDirectory,
        current,
        globalError: null,
      });

      if (autoAdded) {
        this.toast(`已自动加入当前项目:${current.split('/').pop() ?? current}`);
      }
      if (current !== '') {
        if (current !== repos.value.lastSelected) { void api.selectRepo(current); }
        await this.refreshAll();
      }
    } else {
      this.emit({ ready: true, globalError: repos.error });
    }
    // 顺序是**契约**不是风格:`loadPrefs()` 先读回 host 落盘的模型 pin,
    // `loadModels()` 再按 pin 校验清单;反过来 loadModels 会用 models[0] 占掉
    // `state.model`,pin 就进不去了(两者都是 emit,后写的赢)。
    void (async () => {
      await this.loadPrefs();
      await this.loadModels();
    })();
    void this.loadAuth();
  }

  /**
   * 选择要展示的仓库。
   * @param repos - 当前清单。
   * @param preferred - 宿主记住的上次选中路径(可选)。
   */
  private pickInitial(repos: readonly RepoEntry[], preferred?: string): string {
    // `curly` 是硬闸门:三个提前 return 都带花括号(见 `.eslintrc.yml` 的 BUILTIN 段)。
    if (this.state.current !== '' && repos.some((r) => r.path === this.state.current)) {
      return this.state.current;
    }
    if (preferred !== undefined && preferred !== '' && repos.some((r) => r.path === preferred)) {
      return preferred;
    }
    return repos[0]?.path ?? '';
  }

  /**
   * 定时刷新工作区。
   *
   * ⚠️ **不再是「只刷 status + sync」**(2026-10 改了,旧注释留在这里会让下一个人
   * 按错的成本模型做决定):`refreshStatus()` 现在照上游 `_loadStatus` 的末尾
   * (`app-store.ts:3018`)**连当前选中文件的 diff 一起重取** —— 那正是「外部改了文件
   * 之后界面能自愈」的唯一路径。代价是每轮一次 `git diff -- <一个文件>`
   * (`loadDiff` 在没选文件时早退,不发请求);`busy !== ''` 时整轮跳过。
   */
  startPolling(intervalMs = 5000): () => void {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      if (this.state.current === '' || this.state.busy !== '') { return; }
      void this.refreshStatus();
    }, intervalMs);
    return () => this.stopPolling();
  }

  stopPolling(): void {
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  // ---------- 仓库 ----------

  /** 重新拉取仓库清单(克隆/外部改动后)。 */
  async refreshRepos(): Promise<void> {
    const result = await api.repos();
    if (!result.ok) {
      this.fail(result.error);
      return;
    }
    this.emit({
      repos: result.value.repos,
      hidden: result.value.hidden,
      canPickDirectory: result.value.canPickDirectory,
      current: this.pickInitial(result.value.repos, result.value.lastSelected),
    });
  }

  async addRepo(path: string): Promise<boolean> {
    const result = await api.addRepo(path);
    if (!result.ok) {
      this.fail(result.error);
      return false;
    }
    if (!result.value.added) {
      // 以前这里是静默 return,用户看到的就是「点了没反应」。
      this.toast(
        '没有选到目录。若宿主未提供目录选择,请用「手动输入路径」直接填写仓库绝对路径。',
        'err',
      );
      return false;
    }
    this.emit({ repos: result.value.repos, current: this.pickInitial(result.value.repos) });
    this.toast('已添加仓库');
    await this.refreshAll();
    return true;
  }

  /**
   * **添加一个仓库,并在它不是 git 仓库时允许显式 `git init`** ——
   * 上游 `PopupType.AddRepository` / `CreateRepository` 两条路的**共同落点**。
   *
   * ## 为什么需要它(缺口逐条)
   *
   * 在这条之前,「添加仓库」只有 `store.addRepo`(`:698`)一条路,而它打的
   * `repos/add`(`src/host/routes.ts:475-505`)对**不是 git 仓库的目录**只有一个结局:
   * `throw new GitServiceError('not-a-repository', '<path> 不是 git 仓库(可以先初始化)。')`。
   * 宿主那句话里的「可以先初始化」在本插件里**没有对应入口** ——
   * `repos/add-existing`(`routes.ts:503`)带 `init: true` 的分支**已经实现**、
   * `api.addExisting`(`api.ts:794`)**已经导出**,全仓 **0 个调用点**(审计
   * `docs/dead-code-and-missing-state-audit.md` §2.3 第 8 项)。于是用户挑了一个
   * 还没 `git init` 的目录,只得到一句「不是 git 仓库」,然后无处可去。
   *
   * ## 为什么**先试不 init、失败才提示**(而不是无条件 init)
   *
   * `git init` 会在用户挑的目录里**写东西**(`.git/`)。对已经存在的仓库它是无害的,
   * 但对一个用户只是「想加进来」的普通目录,静默初始化就是替用户做了一个他没要求的
   * 决定。所以:
   *
   *  1. `init = false` 先走一遍(等价于 `addRepo`,但**不吞错误**,把 `GitError` 原样
   *     交回调用方);
   *  2. 只有调用方**显式**带着 `init = true` 再调一次时,才让宿主执行 `git init`
   *     (`routes.ts:508-512` 的 `deps.git.init({ path, defaultBranch: 'main' })`)。
   *
   * ## 调用方是谁(必须自己先确认过)
   *
   * `repo-bar.tsx` 的 `RepositoryPanel`:`not-a-repository` 时弹一次确认框
   * (「这里还没有 git 仓库,要在这里 `git init` 吗?」),确认后才用 `init = true`
   * 重调。**本方法自己从不问用户** —— 与宿主 `git-service.ts:1127` 那条
   * 「调用方必须自己确认过再调」是同一条纪律。
   * @param path - 用户给的**绝对路径**(宿主会自行 `repoRoot()` 归一化)。
   * @param init - true ⇒ 目录不是 git 仓库时允许 `git init` 建一个。
   * @returns `null` = 成功(仓库已加入清单并已刷新);否则是宿主的原始 `GitError`,
   *   **由调用方决定怎么呈现**(本方法不 toast,因为它没法区分「先试」与「确认后重试」)。
   */
  public async addRepoWithInit(path: string, init: boolean): Promise<GitError | null> {
    const result = await api.addExisting(path, init);
    if (!result.ok) {
      return result.error;
    }
    this.emit({ repos: result.value.repos, current: this.pickInitial(result.value.repos) });
    this.toast(init ? '已在此目录初始化 git 仓库并加入清单' : '已添加仓库');
    await this.refreshAll();
    return null;
  }

  /**
   * 点「Add / + 添加」时选目录。
   *
   * 优先用**客户端**的原生弹窗(`uiWorkspace.pickDirectory`),它拿到的是绝对路径;
   * 拿不到再回退到 host 侧的 `directoryPickerController`(走 `@pick` 由 host 弹窗)。
   * 两条路都不通时给出可读提示,而不是静默无反应。
   */
  async addRepoViaDialog(): Promise<boolean> {
    if (this.pickDirectory !== undefined) {
      const attempt = this.pickDirectory();
      // null = 这个客户端没有选择器 → 回退到 host 侧弹窗
      if (attempt === null) { return this.addRepo('@pick'); }
      let chosen: string | null;
      try {
        chosen = await attempt;
      } catch (error) {
        // 远端/SSH 部署下 native 选择器不可用,host 侧同样可能不行 —— 给出可操作提示。
        this.toast(
          `目录选择不可用:${error instanceof Error ? error.message : String(error)}。请用「手动输入路径」直接填写仓库绝对路径。`,
          'err',
        );
        return false;
      }
      if (chosen !== null && chosen !== '') { return this.addRepo(chosen); }
      return false; // 用户取消:静默(取消不是错误)
    }
    return this.addRepo('@pick');
  }

  /**
   * 只**选一个目录**（不添加仓库）—— 克隆弹窗「Choose…」那一条。
   *
   * 为什么要走 store 而不是在弹窗里直接 `api.pickDirectory()`（改前就是那样）：
   * 目录选择有**两条**通道，而它们的可用性互不相同：
   *  1. `uiWorkspace.pickDirectory`（**客户端原生**弹窗，由 `src/client/index.ts:115-117`
   *     从注入的服务里取到，拿到的是绝对路径）—— 只有它能在宿主没装
   *     `directoryPickerController` 的 profile 里工作；
   *  2. 宿主路由 `pick-directory`（`src/index.ts:381-400`，只有 `hasHostPicker()` 为真时才
   *     交给路由，否则路由恒回 `{path:null}`）。
   * 改前克隆弹窗只走第 2 条：宿主没有那个可选服务时，点「Choose…」**毫无反应、也不报错**
   * ——上游 `clone-repository.tsx:593-646` 的 `onChooseDirectory` 至少还会返回
   * `undefined`（用户取消）而不是静默失败。这里与同文件的 `addRepoViaDialog()` 用**同一份**
   * 优先级与同一条错误文案（一处策略、两处调用点）。
   *
   * @returns 选中的**绝对路径**；`null` 表示「用户取消」或「两条通道都不可用」
   *   （后者已经用一条可读 toast 说清，见下）。
   */
  public async pickCloneDirectory(): Promise<string | null> {
    if (this.pickDirectory !== undefined) {
      const attempt = this.pickDirectory();
      if (attempt !== null) {
        try {
          const chosen = await attempt;
          return chosen === null || chosen === '' ? null : chosen;
        } catch (error) {
          this.toast(
            `目录选择不可用:${error instanceof Error ? error.message : String(error)}。请直接在「Local path」里填写绝对路径。`,
            'err',
          );
          return null;
        }
      }
    }
    const result = await api.pickDirectory();
    if (!result.ok) {
      this.fail(result.error);
      return null;
    }
    if (result.value.path === null) {
      // 宿主也没有选择服务：给出可操作提示，而不是让按钮看起来「点了没反应」。
      this.toast('这个环境没有目录选择器:请直接在「Local path」里填写绝对路径。', 'err');
      return null;
    }
    return result.value.path;
  }

  async removeRepo(path: string): Promise<void> {
    const result = await api.removeRepo(path);
    if (!result.ok) {
      this.fail(result.error);
      return;
    }
    const current = this.state.current === path ? this.pickInitial(result.value.repos) : this.state.current;
    this.emit({ repos: result.value.repos, current, status: current === '' ? null : this.state.status });
    if (current !== path) await this.refreshAll();
  }

  async renameRepo(path: string, alias: string): Promise<void> {
    const result = await api.renameRepo(path, alias);
    if (!result.ok) {
      this.fail(result.error);
      return;
    }
    this.emit({ repos: result.value.repos });
  }

  async selectRepo(path: string): Promise<void> {
    if (path === this.state.current) { return; }
    // 宿主侧持久化,重开页签/重启后恢复
    void api.selectRepo(path);
    /*
     * **切出**:把属于**上一个仓库**的字段写回它的槽。
     *
     * 上游切仓库只是「刷新」,`_selectRepositoryRefreshTasks`
     * (`lib/stores/app-store.ts:2237-2241` 的 `_refreshRepository`)**不重置**任何状态 ——
     * 因为每个仓库各有一份 `IRepositoryState`(`lib/stores/repository-state-cache.ts:31`
     * 的 `Map<string, IRepositoryState>`,key = `repository.hash`),草稿另有一份
     * `GitStore`(`lib/stores/git-store-cache.ts:6-31` + `git-store.ts:136`)。
     *
     * 我们以前把下面这 10 个字段整块清空 ⇒ **切走再切回,选中 / 草稿 / 每个文件的
     * 纳入状态 / diff 全丢**。现在按仓库留起来。判据:
     * `docs/probes/changes-cache-probe.mjs`(改前 **2/6**、改后 **6/6**)。
     */
    this.repoStates.stash(this.state.current, this.state);
    /*
     * **切入**:命中 ⇒ 带着那个仓库上次的状态;未命中 ⇒ 干净初值
     * (镜像 `get()` 的未命中分支,`repository-state-cache.ts:36-45`)。
     *
     * `status` / `sync` / `branches` **刻意不缓存**(理由写在 `repo-state-cache.ts` 文件头):
     * 显示上一个仓库的文件列表比「一帧空列表」更危险(用户会对着一份不属于当前仓库的
     * 列表点勾选),而这三样 `refreshAll()` 立刻就能拿回来 ⇒ 它们照旧清空。
     */
    const restored = this.repoStates.restore(path);
    this.emit({
      current: path,
      status: null,
      sync: null,
      // 同上:`tagsToPush` 是**上一个仓库**的标签身份清单,留着会让菜单项按错仓库判定
      // (`Delete tag` 会对着 B 的标签问 A 的未推送集合)。`refreshAll()` 立刻重取。
      tagsToPush: [],
      branches: [],
      // 进行中的进度属于「上一个仓库的网络动作」:切仓库时它已经无意义。
      progress: null,
      // `stagedOnly` **刻意不在这里重置**:它是全局生成偏好(落在 host 的
      // `prefs.stagedOnly`,由设置面板的勾选框写),不是按仓库的状态。
      // 以前这里写 `stagedOnly: true`,于是切一次仓库就把用户的偏好覆盖掉 ——
      // 与「刷新后弹回默认」是同一类静默丢失,只是触发动作不同(切仓库 vs 刷新)。
      ...restored,
    });
    await this.refreshAll();
  }

  async refreshAll(): Promise<void> {
    await Promise.all([this.refreshStatus(), this.refreshBranches(), this.refreshLog(true)]);
  }

  /**
   * **刷新「本地有、远端没有」的标签名**(宿主路由 `tag-unpushed`)。
   *
   * 上游把这份清单**记在本地**(`lib/stores/git-store.ts:144` 的 `_tagsToPush` +
   * `helpers/tags-to-push-storage.ts` 落 localStorage,`addTagToPush`/`removeTagToPush`/
   * `clearTagsToPush` 三处维护),而它的**权威来源**是问一次远端
   * (`lib/git/tag.ts:86` 的 `fetchTagsToPush` —— 一次 `git push --dry-run --porcelain`;
   * 注意那份上游实现在 `references/desktop` 里**零调用点**,是上游自己的死代码)。
   * 我们直接问宿主(它真的跑那次 dry-run),因为「记在本地」会在
   * 「用户从命令行建的标签」「在别处推过」这两种情况下说谎。
   *
   * **失败一律静默**:远端不可达、没认证、仓库没有远端 —— 这些都是**正常状态**,
   * 而这条问询只服务一个菜单项的启用判定 ⇒ 保留旧值、不弹 toast、不写 `globalError`
   * (`api.ts` 的 `tagUnpushed` 注释里写明调用方必须能接受它失败)。
   *
   * ## 为什么**只**在切页签时调(而不是挂在 `refreshAll()` / 轮询上)
   *
   * 它**要碰网络**(一次真 `git push --dry-run`),所以调用点必须贵得有理:
   *  - 挂在 `refreshLog(true)` 上 ⇒ 每次暂存/取消暂存/丢弃一个文件都多一次网络往返
   *    (`afterIndexChange()` 就走它);
   *  - 挂在 `refreshAll()` 上 ⇒ 每次提交 / 切分支 / reset / revert / cherry-pick 都多一次
   *    (而那些动作**都不改变标签集合**),并且会让既有的 `history-commit-actions-probe.mjs`
   *    的 Z2 实测转红(它的 fetch 桩没有这一档 ⇒ 载荷被拒);
   *  - **5 秒轮询不经过这里** —— 实测 `startPolling` 的 `setInterval` 体只调
   *    `refreshStatus()`(`src/client/store.ts:922-929`),所以这条问询**不会**每 5 秒发一次;
   *  - 两个消费者都在页签里(History 的 `Delete tag` 菜单项 / Changes 空态的推送卡)⇒
   *    `setTab('history')` 与 `setTab('changes')` 各问一次(见 `setTab` 里那段注释)。
   *
   * ⚠️ **与 Changes 侧的一处已知耦合**(写在这里免得接手的人误判):`snap.tagsToPush`
   * 在**进入过 Changes 或 History 之前**恒为 `[]`。对 Change 空态的推送卡来说那只意味着
   * 「只有未推送标签」那一档**少一次机会**,不会**错报**(空表 ⊂ 真表);而 `Delete tag`
   * 那一项在空表下是**灰的**,与「没接」等价,不会误报可删。
   *
   * 三处**不需要**重问(逐条给理由,不是漏了):
   *  1. **push 之后**:本仓的 `push()` 走 `pushArgv` 且**从不传 `tags`**
   *     (`git-service.ts` 的 `push()` 只推分支)⇒ 一次推送**不会**改变未推送标签集合;
   *  2. **createTag 之后**:我们在本地**增量**加一条(上游 `git-store.ts:501-507` 的
   *     `addTagToPush`)—— 而且因为 push 从不推标签,刚建的标签**按定义**就是未推送;
   *  3. **deleteTag 之后**:同理本地减一条(上游 `:509-515` 的 `removeTagToPush`)。
   * 第 2/3 条是上游的本地记账手法(`_tagsToPush` + `helpers/tags-to-push-storage.ts`),
   * 这里只借用「增量维护」这一半(权威读数仍然是本条路由,下次切进 History 会覆盖它)。
   */
  public async refreshTagsToPush(): Promise<void> {
    const path = this.state.current;
    if (path === '') { return; }
    const result = await api.tagUnpushed(path);
    if (result.ok) {
      this.emit({ tagsToPush: result.value.tags });
    }
  }

  async refreshStatus(): Promise<void> {
    const path = this.state.current;
    if (path === '') { return; }
    const [status, sync] = await Promise.all([api.status(path), api.syncState(path)]);
    if (status.ok && sync.ok) {
      // 纳入状态按**路径**存:文件不再是变更文件(提交掉了 / 被丢弃 / 被撤销)时
      // 必须一起清掉,否则同一路径下次出现会带着上一次的选区冒出来。
      // `?? []`:宿主一定回 files,但这条守卫的成本是 0 —— 载荷畸形时不该把整个 store 打崩。
      const present = new Set((status.value.files ?? []).map((f) => f.path));
      const includeState = Object.fromEntries(
        Object.entries(this.state.includeState).filter(([file]) => present.has(file)),
      );
      /*
       * **选中集合也要跟着过滤** —— 上游 `updateChangedFiles`
       * (`lib/stores/updates/changes-state.ts:80-88`):
       * 已提交/已丢弃的文件要**从 `selectedFileIDs` 里滤掉**;一个都不剩而列表非空时
       * **回落到第一个文件**。
       *
       * 我们以前完全不动 `selectedFiles`,后果有两条(见
       * `docs/changes-cache-gaps-vs-desktop.md` 的 #5):
       *  1. 提交/丢弃之后右栏停在一个**已不在变更列表里**的路径上,显示
       *     「没有可显示的差异」——用户以为改动丢了;
       *  2. 紧随其后的 `loadDiff()` 还会对那个**已消失的路径**白发一次 `diff` 请求。
       *
       * 顺手对齐的另一条上游行为:切仓库后上游会**自动选中第一个变更文件**
       * (同 `:86-88`,以及 `_selectWorkingDirectoryFiles` 的「没有选中就挑第一个」),
       * 而我们此前显示的是「选择一个文件查看 diff」。
       *
       * `:90-95` 那条「同一个文件仍被选中 ⇒ 复用已加载的 diff,否则清成 null」
       * **不在这里重写**:紧随其后的 `this.loadDiff()` 的守卫 2(`:777-780`)做的就是
       * 同一件事(`diffKey` 变了才清),两处都写会变成第二份必然漂移的真源。
       */
      const files = status.value.files ?? [];
      const keptSelection = this.state.selectedFiles.filter((file) => present.has(file));
      const selectedFiles =
        keptSelection.length > 0 ? keptSelection : files[0] !== undefined ? [files[0].path] : [];
      this.emit({
        status: status.value,
        sync: sync.value,
        globalError: null,
        includeState,
        selectedFiles,
      });
      /*
       * **重取当前选中文件的 diff** —— 上游 `_loadStatus` 的**末尾**就是这么做的
       * (`lib/stores/app-store.ts:3018` 的 `this.updateChangesWorkingDirectoryDiff(repository)`),
       * 而 `_loadStatus` 是**每一条**刷新路径的必经之地:窗口焦点、切仓库、切分支、
       * 提交后、点刷新都走它。所以上游的 diff 永远不会「外部改了却一直显示旧的」。
       *
       * 我们以前**只**在 `afterIndexChange()` 里重取,于是:
       *  - 5s 轮询(外部改了文件)只更新列表,diff 一直陈旧;
       *  - `refreshAll()`(点「刷新状态与历史」、切分支、commit/pull 收尾)也不重取;
       *  - 即 diff **永远不会自愈**,除非用户重新点一次文件。
       *
       * 位置照上游放在**状态落地之后**:`loadDiff` 读 `this.state.status.files` 判
       * `staged` 与 `headSha` 组 key(`:696-698`),状态没落地就会用旧的 key。
       * 上游那一行是 fire-and-forget,这里 **`await`**:我们的 `loadDiff` 已经有请求
       * 序号守卫(`:269`、`:711-713`),await 不会让陈旧响应落地,但能让
       * 「刷新完成 ⇒ diff 已是最新」成为一个**可断言**的契约
       * (`docs/probes/commit-include-state-probe.mjs` 的 P4/P5)。
       */
      await this.loadDiff();
      return;
    }
    if (!status.ok) this.emit({ globalError: status.error });
  }

  async refreshBranches(): Promise<void> {
    const path = this.state.current;
    if (path === '') { return; }
    const result = await api.branches(path);
    if (result.ok) this.emit({ branches: result.value });
  }

  async refreshLog(reset: boolean): Promise<void> {
    const path = this.state.current;
    if (path === '') { return; }
    if (this.state.logLoading) { return; }
    this.emit({ logLoading: true });
    const skip = reset ? 0 : this.state.log.length;
    const result = await api.log(path, 50, skip);
    if (result.ok) {
      this.emit({
        log: reset ? result.value.commits : [...this.state.log, ...result.value.commits],
        logHasMore: result.value.hasMore,
        logLoading: false,
      });
    } else {
      this.emit({ logLoading: false });
      this.fail(result.error);
    }
  }

  setTab(tab: TabId): void {
    this.emit({ tab });
    /*
     * 切到 Changes 页签 ⇒ 刷新一次。
     *
     * 上游 `_changeRepositorySection`(`lib/stores/app-store.ts:3362-3391`)在切到
     * Changes 时调 `refreshChangesSection({includingStatus: true, clearPartialState: false})`
     * (`:3377-3381`)。两个参数都要沿用:
     *  - `includingStatus: true` ⇒ 会发现外部改动;
     *  - `clearPartialState: **false**` ⇒ 切页签**不**动行级选区(只有「提交成功」与
     *    「隐藏空白开关」才传 true,见 `clearPartialAfterCommit`)。
     *
     * 以前这里只有 `emit({tab})`,于是切回页签既看不到外部改动、也没把当前选中文件的
     * diff 提上来 —— 而 `refreshStatus()` 现在自己会重取 diff(照 `_loadStatus` 末尾
     * `:3018`),所以这一句同时补上两件事。
     *
     * 只在切到 `changes` 时发:上游切到 History 走的是 `refreshHistorySection`。
     * 唯一的调用方是页签栏(`workbench.tsx:285` 的 `onSelect`),不会在启动时触发。
     */
    if (tab === 'changes') void this.refreshStatus();
    /*
     * 切到 **History** 或 **Changes** ⇒ 重取「哪些标签还没推送」。
     *
     * ## 为什么是这两个页签(而不是 `refreshLog` / `refreshAll` / 轮询)
     *
     * 这条问询**要碰网络**(一次 `git push --dry-run --porcelain`,`refreshTagsToPush` 的
     * JSDoc 有完整成本表)。它的两个消费者**都在页签里**:
     *  - `Delete tag <name>` 的 `enabled`(`ui/history/commit-list.tsx:373-377,889-924`)⇒ History;
     *  - Changes 空态那张「推送未推送的标签」卡(`ui/changes/no-changes.tsx:379-384` 的
     *    `aheadBehind.ahead > 0 || (tagsToPush !== null && tagsToPush.length > 0)`)⇒ Changes。
     * 所以「用户**进入**这两个页签时问一次」正好覆盖两个消费面,而且频率是**用户点击级**的。
     *
     * **被排除的三处(逐条给理由,免得下一个人以为漏了)**:
     *  1. `refreshAll()` —— 它是提交 / 切分支 / reset / revert / cherry-pick / 换仓库的收尾,
     *     挂上去等于给每一个**都不改变标签集合**的动作加一次网络往返;而且本仓既有的
     *     `history-commit-actions-probe.mjs` 的 fetch 桩当时**没有** `tag-unpushed` 这一档,
     *     挂 `refreshAll()` 会让它的 Z2(零载荷被拒)**实测转红 30/31**;
     *  2. **5 秒轮询** —— 实测它**不**经过 `refreshAll()`:`startPolling` 的
     *     `setInterval` 体只调 `refreshStatus()`(本文件 `:922-929`)。这一条要写下来,
     *     因为「`refreshAll` 被轮询」这个印象曾被当成成本模型用过;
     *  3. **暂存/取消暂存/丢弃** —— `afterIndexChange()` 只走 `refreshStatus()` + `refreshLog(true)`。
     *
     * ## 没有做 TTL / 去重(以及什么时候该做)
     *
     * 频率是**用户点击级**(切页签),不是自动级;重复点击同一页签确实会重复问一次。
     * 没有加 TTL 的原因:那会引入一个「最长 N 秒的陈旧窗口」用于一个**启用判定**,
     * 而收益只在高频来回切页签时显现。**该做的信号**:若真机上观察到切页签时的
     * 网络往返有感知,就在 `refreshTagsToPush` 里加「同仓库 N 秒内不重复读」——
     * 那时的判据应当写成「连续切两次只发一次请求」(本文件的探针已经能读请求流水)。
     */
    if (tab === 'history' || tab === 'changes') void this.refreshTagsToPush();
  }

  /** 远端页签回填角标计数。 */
  setCount(tab: TabId, value: number): void {
    if (this.state.counts[tab] === value) { return; }
    this.emit({ counts: { ...this.state.counts, [tab]: value } });
  }

  // ---------- 文件选择与 diff ----------

  toggleFile(file: string, additive: boolean): void {
    const current = this.state.selectedFiles;
    if (additive) {
      this.emit({
        selectedFiles: current.includes(file) ? current.filter((f) => f !== file) : [...current, file],
      });
    } else {
      this.emit({ selectedFiles: [file] });
    }
    void this.loadDiff();
  }

  selectFiles(files: string[]): void {
    this.emit({ selectedFiles: files });
    void this.loadDiff();
  }

  /**
   * 取当前选中文件的 diff。
   *
   * **两次守卫(2026-10 补)** —— 这一层以前只有「请求 → 落地」,没有序号、也没有把
   * 旧 diff 撤掉,于是快速点两个文件时,**先发后到的那份 diff 会盖住后发先到的那份**:
   *
   *  1. `diffSeq`:每次调用 +1,响应回来时只有仍是**最新**那次才允许落地。
   *     否则界面会停在「选中的是 B、显示的却是 A」。
   *  2. 目标变了(`diffKey` 不等)就先把 `diff` 撤成 null。**这一条不只是观感**:
   *     `DiffPane` 传给 diff 渲染层的选区是 `includeState[diff.path]`,而行号勾选框
   *     又由它驱动 ⇒ 留着 A 的 diff 会让用户对着 A 的行勾选、却以为在改 B,
   *     勾选会落到**另一个文件**上。撤成 null 时 diff 面板显示「读取 diff…」。
   *
   * 为什么必须在这里:所有入口(`toggleFile` / `selectFiles` / `setHideWhitespace` /
   * `afterIndexChange`)都汇到这一个方法,守卫放在这一层只需一份。
   */
  async loadDiff(): Promise<void> {
    const path = this.state.current;
    const file = this.state.selectedFiles[0];
    const seq = (this.diffSeq += 1);
    if (path === '' || file === undefined) {
      this.emit({ diff: null, diffKey: '' });
      return;
    }
    const entry = this.state.status?.files.find((f) => f.path === file);
    const staged = entry !== undefined && entry.staged !== undefined && entry.unstaged === undefined;
    // key 的公式只有 `diffKeyOf()` 一份(`-w` 标志必须进 key 的理由写在那里)。
    const key = diffKeyOf(file, staged, this.state.hideWhitespace, this.state.status?.headSha ?? '');
    // 守卫 2:目标与当前已加载的那份不是同一个 ⇒ 先撤掉,别让另一个文件的行勾选留在屏幕上。
    if (this.state.diffKey !== key) {
      this.emit({ diff: null, diffKey: '' });
    }
    const result = await api.diff({
      path,
      file,
      ...(staged ? { staged: true } : {}),
      ...(entry?.untracked === true ? { untracked: true } : {}),
      ...(this.state.hideWhitespace ? { ignoreWhitespace: true } : {}),
    });
    // 守卫 1:期间用户又切了文件 / 仓库 / 隐藏空白 ⇒ 这次响应已经没有意义。
    if (seq !== this.diffSeq) {
      return;
    }
    if (result.ok) this.emit({ diff: result.value, diffKey: key });
  }



  // ---------- 提交纳入状态(客户端模型;**绝不写 git 索引**) ----------

  /** 当前应该被提交的文件(纳入状态 ≠ none)。 */
  public includedFiles(): ChangedFile[] {
    return (this.state.status?.files ?? []).filter(
      (f) => includeStateOf(this.state.includeState[f.path]) !== 'none',
    );
  }

  /**
   * 勾选 / 取消勾选**一个文件**(Desktop 的 `withIncludeAll`)。
   *
   * 只改客户端模型,不发任何 git 命令 —— 这是用户两次驳回的那一点:
   * 「勾选应该只是勾选,不是暂存」。索引的写入统一发生在 `commit()`。
   * @param file - 仓库内相对路径。
   * @param included - true = 纳入提交(All),false = 排除(None)。
   */
  public setFileIncluded(file: string, included: boolean): void {
    const previous = this.state.includeState[file];
    // 保留已知的可选行集合:整文件切换不该把「这个文件哪些行可选」的信息丢掉。
    const selectable = previous?.selectable;
    this.emit({
      includeState: {
        ...this.state.includeState,
        [file]: {
          kind: included ? 'all' : 'none',
          diverging: [],
          ...(selectable === undefined ? {} : { selectable }),
        },
      },
    });
  }

  /**
   * 行级选区变化(diff 面板回传)→ 写进客户端模型。
   *
   * **不调用 `api.stageLines`**:那是旧模型(勾选即写索引)的行为。
   * @param file - 仓库内相对路径。
   * @param spec - `desktop-diff.tsx` 的 `selectionToSpec()` 输出。
   */
  public setFileSelection(file: string, spec: LineSelectionSpec): void {
    this.emit({ includeState: { ...this.state.includeState, [file]: spec } });
  }

  /**
   * 头部的「全选 / 全不选」三态复选框(作用在**当前可见**的文件上)。
   * @param files - 目标文件路径。
   * @param included - true = 全部纳入,false = 全部排除。
   */
  public setFilesIncluded(files: readonly string[], included: boolean): void {
    const next = { ...this.state.includeState };
    for (const file of files) {
      const previous = next[file];
      const selectable = previous?.selectable;
      next[file] = {
        kind: included ? 'all' : 'none',
        diverging: [],
        ...(selectable === undefined ? {} : { selectable }),
      };
    }
    this.emit({ includeState: next });
  }

  // ---------- 暂存动作 ----------

  /**
   * 「暂存/取消暂存」的目标文件集合 —— **选区优先,空则全量**。
   *
   * `selectedFiles` 来自左栏文件行的点选/多选(`store.selectFiles`),它是**用户意图**;
   * 没有选区时退回「当前全部变更文件」,这正是 Desktop 上「没有选中任何文件时
   * 暂存全部」的行为。
   */
  private targetedFiles(): string[] {
    const selected = this.state.selectedFiles;
    if (selected.length > 0) { return selected; }
    return (this.state.status?.files ?? []).map((f) => f.path);
  }

  /**
   * 「暂存 / 取消暂存」两条方向的**共用落点**。
   *
   * 为什么单开一个私有辅助:`stageSelected` / `unstageSelected` / `stageFile` /
   * `unstageFile` 四个公开入口的**差别只有「文件集合」与「方向」**,
   * 而 `busy` 标签、失败呈现、`afterIndexChange()` 三件事必须完全一致
   * (否则一条路刷状态、另一条不刷 ⇒ 界面残留旧文件列表,这正是本仓反复出现的缺陷类)。
   * @param files - 目标文件(仓库内相对路径);空集 = 直接返回,不发请求。
   * @param direction - `'stage'` 走 `api.stage`;`'unstage'` 走 `api.unstage`。
   */
  private async applyIndexAction(files: readonly string[], direction: 'stage' | 'unstage'): Promise<void> {
    const path = this.state.current;
    if (path === '' || files.length === 0) { return; }
    this.emit({ busy: direction });
    const result = direction === 'stage'
      ? await api.stage(path, [...files])
      : await api.unstage(path, [...files]);
    this.emit({ busy: '' });
    if (!result.ok) {
      this.fail(result.error);
      return;
    }
    await this.afterIndexChange();
  }

  /**
   * **暂存**选中的文件(`git add`)—— 对应 Desktop 的「全部暂存」入口。
   *
   * 上游对应物:`lib/git/update-index.ts:109-175` 的 `stageFiles`(由
   * `app-store.ts` 的 `_stageFiles` 驱动,UI 是 Changes 列表的
   * `ChangesListFilterOptions` / 文件行右键 **Stage file**)。上游没有把
   * `stageSelected` 这个名字给某个导出的 store 方法,但语义是同一个:
   * **把选区里的文件整份写进索引**。
   *
   * ⚠️ **与本仓的「勾选 ≠ 暂存」模型的关系(必须说清,否则会以为它是第二份真源)**:
   *
   * 本仓的提交模型是「勾选是客户端模型、索引只在 `commit()` 那一刻 materialize」
   * (`includeState` + `setFileIncluded`,见 `Snapshot.includeState` 的注释)。
   * `stageSelected` 走的是**另一条**路:它**立刻写索引**(`api.stage`),
   * 与「勾选」互不取代 ——
   *
   * | 入口 | 写索引的时机 | 载体 |
   * |---|---|---|
   * | 文件行勾选框 / 头部三态 | **提交那一刻**(`commit()` 的 materialize 段) | `includeState` |
   * | `stageSelected` / `stageFile` | **点击那一刻** | git 索引本身 |
   *
   * 两条都保留(用户 2026-10 裁决:「先做,不删」):前者是 Desktop 的模型,
   * 后者是「我想现在就 `git add`」这个真实诉求。落点见
   * `changes-view.tsx` 的 Changes 工具条(两个按钮)与
   * `branches-view`/文件行的右键。
   */
  async stageSelected(): Promise<void> {
    await this.applyIndexAction(this.targetedFiles(), 'stage');
  }

  /**
   * **取消暂存**选中的文件(`git reset`)—— 上游 `lib/git/reset.ts` 的 `unstageAll`
   * 一族(`app-store.ts` 的 `_unstageFiles`)。
   *
   * 与 {@link stageSelected} 的差别不只是方向:没有选区时,它只取**索引里真的有内容**
   * 的文件(`staged !== undefined`),而不是全部变更文件 —— 否则会对一堆未暂存文件
   * 白跑一次 `git reset`,而且 `afterIndexChange()` 会白刷一次状态。
   * 两条路共用 {@link applyIndexAction},所以 `busy` 标签、失败呈现、刷新时机一致。
   */
  async unstageSelected(): Promise<void> {
    const selected = this.state.selectedFiles;
    const files = selected.length > 0
      ? selected
      : (this.state.status?.files ?? []).filter((f) => f.staged !== undefined).map((f) => f.path);
    await this.applyIndexAction(files, 'unstage');
  }

  /**
   * **单文件暂存**。上游的调用点是文件行右键菜单的 **Stage file**
   * (`ui/changes/changed-file.tsx` 那条),与 {@link stageSelected} 同一个落点
   * (`api.stage`),只是文件集合固定成一个。
   *
   * 与 {@link stageSelected} 走同一个私有辅助:以前这里是**第二份实现**(自己 emit busy、
   * 自己 fail、自己 refresh),与 `stageSelected` 三处细节不一致 ——
   * 现在两处只有「文件集合」这一个差别。
   */
  async stageFile(file: string): Promise<void> {
    await this.applyIndexAction([file], 'stage');
  }

  /**
   * **单文件取消暂存**。上游对应 `lib/git/reset.ts` 的 `resetPaths(repository, Mixed,
   * 'HEAD', [path])`(`app-store.ts` 的 `_unstageFiles` 对单文件走这一支)——
   * 我们落点是宿主既有的 `unstage` 路由(它内部就是 `git reset -- <paths>`)。
   */
  async unstageFile(file: string): Promise<void> {
    await this.applyIndexAction([file], 'unstage');
  }

  /**
   * 丢弃这些文件的改动。
   * @param files - 全部目标路径。
   * @param untrackedPaths - 其中属于未跟踪的子集(走 `git clean`);混批必须分开传。
   */
  async discardFiles(files: string[], untrackedPaths: string[]): Promise<void> {
    const path = this.state.current;
    if (path === '' || files.length === 0) { return; }
    this.emit({ busy: 'discard' });
    const result = await api.discard(path, files, untrackedPaths);
    this.emit({ busy: '' });
    if (!result.ok) {
      this.fail(result.error);
      return;
    }
    const allUntracked = untrackedPaths.length === files.length;
    this.toast(allUntracked ? '已删除未跟踪文件' : '已丢弃改动');
    await this.afterIndexChange();
  }

  private async afterIndexChange(): Promise<void> {
    // `refreshStatus()` 现在自己就会重取当前选中文件的 diff(照上游
    // `_loadStatus` 末尾 `app-store.ts:3018`),所以这里**不再**单独调 `loadDiff()` ——
    // 否则暂存/取消暂存/丢弃一个文件会打**两个** diff 请求。
    // 判据:`docs/probes/commit-include-state-probe.mjs` 的 P6(恰好 1 次)。
    await Promise.all([this.refreshStatus(), this.refreshLog(true)]);
  }

  // ---------- 提交 ----------

  setCommitField<K extends keyof CommitForm>(key: K, value: CommitForm[K]): void {
    this.emit({ commitForm: { ...this.state.commitForm, [key]: value } });
  }

  /**
   * 生成提交信息。
   *
   * 已经手写过摘要/描述时**不直接覆盖**:调用方应先弹确认再传 `force: true`
   * (Desktop 用 `Commit message override` 弹窗做同一件事)。
   * @param opts.force - true 表示用户已确认覆盖现有文本。
   */
  async generateCommitMessage(opts: { force?: boolean } = {}): Promise<void> {
    const path = this.state.current;
    if (path === '') { return; }
    if (opts.force !== true && this.state.commitForm.summary.trim() !== '') {
      // 交给界面弹确认;这里只标记「待确认」,不发起请求。
      this.emit({ pendingGenerateConfirm: true });
      return;
    }
    this.emit({ pendingGenerateConfirm: false });
    const status = this.state.status;
    if (status === null) { return; }
    // 生成依据的真源 = **纳入提交的文件/行选区**(`includedFiles()` / `includeState`),
    // 不是「索引里有什么」(那是两行制时代的模型,已下线)。
    //
    // `stagedOnly` 这个偏好保留、但语义已经换过:它现在表示
    // 「**只**依据纳入提交的变更生成」。旧名字不改(避免 `prefs` 迁移),
    // 旧语义(读 git 索引的 staged 位)已经废弃 —— host 侧 `collectDiffText`
    // 以前按 `file.staged` 过滤,在我们这套「勾选 = 纳入、不写索引」的模型下
    // **恒筛出 0 个文件**,所以这里曾经硬编码 `false` 绕过它。
    // 现在两边都按「纳入提交的文件清单」走。
    const included = this.includedFiles().map((f) => f.path);
    if (included.length === 0) {
      this.toast('请先勾选一个或多个文件', 'err');
      return;
    }
    // 勾选「只依据纳入提交的变更生成」时,送进模型的是**纳入的文件清单**;
    // 取消勾选时送**全部工作区变更**的清单(`status.files`)。
    // 两者都要送清单而不是送空数组 —— 送空数组会让 host 端 prompt 里的「涉及文件」
    // 退化成 `(见 diff)`,而 `collectDiffText` 又会回退成「全部变更」,
    // 于是「文件清单」与「diff 覆盖范围」不一致(模型会看到边界的差异)。
    const files = this.state.stagedOnly
      ? included
      : (status.files ?? []).map((f) => f.path);
    const [provider, ...rest] = this.state.model.split('/');
    const model = rest.join('/');
    if (provider === undefined || provider === '' || model === '') {
      this.toast('请先在设置里选择生成用的模型', 'err');
      return;
    }
    this.setCommitField('generating', true);
    const result = await api.generate({ path, files, stagedOnly: this.state.stagedOnly, provider, model });
    this.setCommitField('generating', false);
    if (!result.ok) {
      /*
       * 生成失败 ⇒ **弹窗**(带 `detail` 与错误码),不是一条只播一行的 toast。
       *
       * 为什么不能继续用 `this.fail()`:
       *  1. `fail()` 对 `code === 'internal'` **不附 `detail`** —— 而生成路线上
       *     「取 diff 失败」正是 `internal`(`classifyGitFailure` 兜底),宿主明明把
       *     git 原始 stderr 放进了 `detail`,客户端却把它丢了;
       *  2. toast 是**一条**,`Toast` 原语只吃一个 `text` 字符串 ⇒ 放不下
       *     限高可滚、可选中复制的 `<pre>`,也放不下 `错误码:` 那一行;
       *  3. 用户 2026-10-07 的硬要求是「生成错误必须给出具体信息」,
       *     这与推送失败那轮(`docs/push-failure-surfaces.md` §10)是同一条契约。
       *
       * `fail()` 一个字没删:它仍然是其它 30 处失败路径的出口(那里没有 detail 可播,
       * 或者 detail 已经在 suffix 里播了)。
       */
      this.emit({ generateFailure: result.error });
      return;
    }
    const hasUserText = this.state.commitForm.summary.trim() !== '';
    this.emit({
      commitForm: {
        ...this.state.commitForm,
        summary: result.value.title,
        description: result.value.description,
        generatedBy: `${result.value.provider}/${result.value.model}`,
      },
    });
    this.toast(hasUserText ? '已用生成结果覆盖了原来的摘要/描述' : '已生成提交信息');
  }

  /**
   * 撤销最近一次提交:`reset --mixed` 到父提交,改动回到工作区,并把提交信息回填表单。
   * (Desktop 的 undo-commit 条;第一个提交走 host 的 update-ref 分支。)
   * @param sha - 要撤销的提交。
   */
  async undoCommit(sha: string): Promise<void> {
    const path = this.state.current;
    if (path === '') { return; }
    this.emit({ busy: 'undo' });
    const result = await api.undoCommit(path, sha);
    this.emit({ busy: '' });
    if (!result.ok) {
      this.fail(result.error);
      return;
    }
    /*
     * ⚠️ **宿主这条路由回的是 `{ subject, description }`**(`src/host/git-service.ts:612`
     * 的返回类型逐字如此),而 `api.ts:818` 把它声明成了 `{ subject, body }`
     * —— **声明与宿主不一致**(`api.ts` 由另一条线持有,本次只上报、不改)。
     *
     * 以前这里只读 `.body` ⇒ 描述恒 `undefined`(上游 `git-store.ts:734-738` 回填的是
     * `commit.body`,即**描述**)。后果不只是「描述丢了」:`commitForm.description`
     * 变成 `undefined` 之后,下一次 `commit()` 里的 `form.description.trim()`
     * (`store.ts` 的 `...(form.description.trim() !== '' ? …)`)会直接抛 TypeError。
     * 所以按**宿主真实载荷**取,并对两个名字都兜底、再兜一次空串 ——
     * `docs/probes/undo-commit-strip-probe.mjs` 的段 A 桩回的是 `body`(与旧声明一致),
     * 段 B 走真 host 回 `description`,两段都必须绿。
     */
    const undone = result.value as { subject?: string; description?: string; body?: string };
    this.emit({
      commitForm: {
        ...initial().commitForm,
        summary: undone.subject ?? '',
        description: undone.description ?? undone.body ?? '',
      },
    });
    this.toast('已撤销提交,改动保留在工作区');
    await this.refreshAll();
  }

  /**
   * 进入**修订(amend)态** —— 上游 History 提交右键菜单的第一项。
   *
   * 上游链路:`ui/history/commit-list.tsx:731,752-758` 的菜单项 ⇒
   * `ui/history/compare.tsx:258,615` 的 `onAmendCommit` ⇒ `ui/repository.tsx:659-665`
   * 的 `dispatcher.startAmendingRepository(repository, commit, isLocalCommit)` ⇒
   * `lib/stores/app-store.ts:5760-5797` 的 `_startAmendingRepository`,它按顺序做四件事:
   *
   *  1. **强推警告闸门**(`:5767-5787`):`askForConfirmationOnForcePush && !isLocalCommit &&
   *     tip.kind === Valid` ⇒ 先弹 `WarnForcePush`(`operation: 'Amend'`)。
   *     那一层留在**视图层**(它要弹窗),本方法只管「闸门已放行」之后的三步;
   *  2. `await this._changeRepositorySection(repository, RepositorySectionTab.Changes)`
   *     (`:5788-5791`)⇒ 切到 Changes 页签;
   *  3. `await gitStore.prepareToAmendCommit(commit)`(`:5793` →
   *     `lib/stores/git-store.ts:744-758`):**无条件**把该提交的 summary/body 写进提交表单
   *     (覆盖草稿);带 GitHub 远端时还会试图恢复 co-author —— 我们没有
   *     `interpret-trailers`(见 `history-view.tsx` 的 `toCommit` 注释),这一半不伪造;
   *  4. `setRepositoryCommitToAmend(repository, commit)`(`:5795` → `:5801-5811`):
   *     置上「正在修订」这份仓库级状态。我们的等价物是 `commitForm.amend`
   *     (`repo-state-cache.ts` 的文件头记了为什么它不进镜像的槽:上游的载体是
   *     `commitToAmend: Commit | null`,而我们只有布尔)。
   *
   * **为什么必须校验 `sha === status.headSha`**:宿主的 amend 语义就是
   * `git commit --amend`,改的必然是本仓库的当前 HEAD;上游把这一项只挂在
   * **第 0 行**(`commit-list.tsx:732` 的 `row === 0`),而我们的 `log` 与 `status`
   * 在极端时序下可能不同步(`changes-view.tsx` 的 `undoableCommitOf` 为此专门比过
   * `entry.sha !== status.headSha`)。不是 HEAD 就拒绝并**明说**,不静默改写别的提交。
   *
   * **退役条件**:等我们把 `commitToAmend` 真的放进镜像的槽
   * (`repository-state-cache.ts:60-71` 那条不变量会接管「HEAD 变了就退出修订态」),
   * 本方法的第 4 步改写成 `setRepositoryCommitToAmend`,并删掉 `checkout()` 里那条补偿。
   * @param sha - 要修订的提交(**必须是当前 HEAD**)。
   * @returns 是否真的进入了修订态。
   */
  public startAmendingCommit(sha: string): boolean {
    const status = this.state.status;
    if (status === null) {
      return false;
    }
    const entry = this.state.log.find((commit) => commit.sha === sha);
    if (entry === undefined) {
      this.toast('这条提交不在已加载的历史里,无法修改。', 'err');
      return false;
    }
    if (status.headSha !== sha) {
      // 见方法头注释:只有 HEAD 能被 amend,别改写别的提交。
      this.toast('只能修改最近一次提交(HEAD)。', 'err');
      return false;
    }
    this.emit({
      commitForm: {
        ...this.state.commitForm,
        amend: true,
        // 上游 `git-store.ts:744-758` 无条件覆盖表单。
        summary: entry.subject,
        description: entry.body,
      },
    });
    // 上游 `app-store.ts:5788-5791` 的 `_changeRepositorySection(…, Changes)`。
    this.setTab('changes');
    return true;
  }

  /** 退出修订态(上游 `_stopAmendingRepository`,`app-store.ts:5798-5800`)。 */
  public stopAmendingCommit(): void {
    if (!this.state.commitForm.amend) {
      return;
    }
    this.setCommitField('amend', false);
  }

  /* ==========================================================================
   * 历史动作:Reset to Commit / Checkout Commit / Revert / Cherry-pick / Tag
   *
   * 这一族在 2026-10 之前**宿主路由 + api 包装全在、客户端 0 调用点**,于是
   * `ui/history/commit-list.tsx:773-847` 那六个菜单项**永远灰着**(审计
   * `docs/dead-code-and-missing-state-audit.md` §2.3 第 1-6 项)。
   *
   * 三条纪律,整个族共用:
   *
   *  1. **确认留在视图层**(`history-view.tsx`),与上游一致 ——
   *     `ui/dispatcher/dispatcher.ts:960-967` 只是转发,真正的闸门在
   *     `ui/history/compare.tsx` 的 `onCheckoutCommit` 与 `WarningBeforeReset`。
   *     本文件的方法只管「闸门已放行」之后的动作;
   *  2. **`worktreeDiscarded` 必须读**(`resetToCommit`):`hard` 会丢工作区改动,
   *     宿主如实回了这个字段(`routes.ts:792`),契约与可回收条件见
   *     `docs/discard-lines-contract.md` §5。不读它就是「成功返回 + 破坏性后果 + 零反馈」;
   *  3. **`merge-conflicts` 必须被翻译成人话**(`revertCommit` / `cherryPickCommit`):
   *     宿主的 `must()` 把冲突折成 `code: 'merge-conflicts'`
   *     (`git-service.ts:87`),仓库会**留在** `REVERT_HEAD` / `CHERRY_PICK_HEAD`,
   *     而且本插件**没有** `--continue` / `--abort` 路由(`git-service.ts:1213-1237`
   *     明写「要在命令行里做」)⇒ 界面必须把这件事说清楚,不能只回显一句
   *     「遇到冲突,请在 Changes 里解决后重试」(那句在 revert/cherry-pick 场景下
   *     **是错的**:Changes 页签没有 continue/abort)。
   * ========================================================================== */

  /**
   * reset 到某个提交(上游 History 右键「Reset to Commit…」)。
   *
   * 上游链路:`ui/history/commit-list.tsx:773-781` 的菜单项 ⇒
   * `ui/history/compare.tsx:619-621` 的 `onResetToCommit` ⇒
   * `ui/dispatcher/dispatcher.ts:959-967` ⇒ `app-store.ts:5856-5889` 的
   * `_resetToCommit`。上游那一版**只走 mixed**(`:5884` 的
   * `reset(repository, GitResetMode.Mixed, commit.sha)`),三个模式是我们的扩展
   * (宿主 `reset-to-commit` 路由按冻结契约支持 soft/mixed/hard),
   * 模式 → argv 的映射在 `core/git-argv.ts:566-572`。
   *
   * 上游的确认闸门与本插件不同,如实记下来**不假装**:
   * `_resetToCommit` 的条件是 `showConfirmationDialog && !isWorkingDirectoryClean`
   * —— 也就是「**只在工作区脏时**弹」,而 `WarningBeforeReset`
   * (`ui/reset/warning-before-reset.tsx`)的正文只说「可能丢改动」。
   * 我们这里改成**每次 reset 都确认**(理由:我们额外提供了 `hard` 这一档,
   * 而 `hard` 会**无条件**丢弃工作区改动 —— 上游那一版没有这个风险面),
   * 按钮文案与危险色照上游那个对话框的 `destructive` 形状。
   * @param sha - 目标提交。
   * @param mode - `'soft' | 'mixed' | 'hard'`;界面上由用户选,缺省 `'mixed'`(= 上游)。
   */
  public async resetToCommit(sha: string, mode: 'soft' | 'mixed' | 'hard' = 'mixed'): Promise<void> {
    const path = this.state.current;
    if (path === '') { return; }
    this.emit({ busy: 'reset' });
    const result = await api.resetToCommit(path, sha, mode);
    this.emit({ busy: '' });
    if (!result.ok) {
      this.fail(result.error);
      return;
    }
    /*
     * ⚠️ 这一句就是 `docs/discard-lines-contract.md` §5 要求的「明确反馈」:
     * `hard` 会丢掉工作区里**未提交**的改动,而 git 会安静地成功。不说出来,
     * 用户看到的就是「点了一下,改动没了,界面说成功」。
     */
    if (result.value.worktreeDiscarded === true) {
      this.toast('已硬重置:工作区里未提交的改动已被丢弃,无法恢复。', 'err');
    } else {
      this.toast(`已重置到 ${sha.slice(0, 7)}(${mode})`);
    }
    /*
     * HEAD 变了 ⇒ 修订态必须退出。这条补偿的**来源与退役条件**写在
     * `startAmendingCommit` 的文件头:镜像 `repository-state-cache.ts:59-71` 的
     * amend 不变量在我们这里恒算 false(`branchesState.tip` 停在 `TipState.Unknown`),
     * 所以「HEAD 变了就退出修订态」得我们自己补。
     * `checkout()`(`:1892` 那一版)对切分支做了同一件事,这里对 reset 补上。
     */
    this.stopAmendingCommit();
    await this.refreshAll();
  }

  /**
   * 检出某个提交 —— **分离头**(上游 History 右键「Checkout Commit」)。
   *
   * 上游链路:`commit-list.tsx:783-789` ⇒ `compare.tsx:633-645` 的
   * `onCheckoutCommit` ⇒ `dispatcher.checkoutCommit`(`dispatcher.ts:736-741`)⇒
   * `app-store.ts:4808-4838` ⇒ `lib/git/checkout.ts:165-187`。
   *
   * 上游那半有一个偏好门:`askForConfirmationOnCheckoutCommit`
   * (`compare.tsx:635`,为真才弹 `PopupType.ConfirmCheckoutCommit`)。
   * **本插件没有这个偏好项** —— 与 `askForConfirmationOnForcePush` /
   * `confirmUndoCommit` 是同一处已登记的缺口(`history-view.tsx:939-944` 记过同族)。
   * 这里按上游**默认值**(`false`)处理:不弹框,但**必须**有一条说得清楚的 toast,
   * 否则用户不知道自己已经不在任何分支上了(分离头,提交会「丢掉」)。
   *
   * 落点是 `checkout --detach`(`core/git-argv.ts:582-584` 显式加 `--detach`,
   * 理由写在那里:上游靠「参数是 sha ⇒ git 自己分离头」,那条性质对非 sha 输入不成立)。
   * @param sha - 目标提交。
   */
  public async checkoutCommit(sha: string): Promise<void> {
    const path = this.state.current;
    if (path === '') { return; }
    this.emit({ busy: 'checkout' });
    const result = await api.checkoutCommit(path, sha);
    this.emit({ busy: '' });
    if (!result.ok) {
      this.fail(result.error);
      return;
    }
    this.toast(
      `已检出 ${sha.slice(0, 7)},现在是分离头状态(不在任何分支上)。要回到分支,请切一个分支。`,
      'err',
    );
    // HEAD 变了 ⇒ 退出修订态(理由同 `resetToCommit`)。
    this.stopAmendingCommit();
    await this.refreshAll();
  }

  /**
   * revert 一个提交(生成一个新的反向提交)。
   *
   * 上游:`commit-list.tsx:799-811` 的菜单项(`onRevertCommit` 由
   * `compare.tsx:259-263` 的 `ableToRevertCommit` 决定是否**下传**,见
   * `compare.tsx:745-756`;我们在纯 History 模式下恒满足那一条)⇒
   * `lib/git/revert.ts:22-55`。
   *
   * **冲突回执是本方法的重点**(用户裁决点名):宿主 `revertCommit` 冲突时
   * `git revert` 退出码非 0、**不建提交**,仓库留在 `REVERT_HEAD`
   * (`git-service.ts:1198-1218`),`must()` 抛 `merge-conflicts`。宿主那句默认文案
   * 「请在 Changes 里解决后重试」在这里**不完整**:解决完冲突之后还需要
   * `git revert --continue`,而本插件**没有**这条路由 ⇒ 必须点名「去命令行」。
   * @param sha - 要还原的提交。
   */
  public async revertCommit(sha: string): Promise<void> {
    const path = this.state.current;
    if (path === '') { return; }
    this.emit({ busy: 'revert' });
    const result = await api.revertCommit(path, sha);
    this.emit({ busy: '' });
    if (!result.ok) {
      if (result.error.code === 'merge-conflicts') {
        this.toast(
          `还原 ${sha.slice(0, 7)} 遇到冲突:改动没有撤销,仓库停在 REVERT_HEAD。` +
            '本插件没有「继续/放弃还原」的命令,请在终端里解决冲突后用 `git revert --continue`(或 `git revert --abort`)。',
          'err',
        );
      } else {
        this.fail(result.error);
      }
      /*
       * 冲突时索引与工作区**已经变了**(冲突标记写进了文件),所以状态必须重取 ——
       * 否则 Changes 页签还画着冲突之前那份文件列表,用户会以为什么都没发生。
       */
      await this.refreshAll();
      return;
    }
    this.toast(`已还原 ${sha.slice(0, 7)},改动保留在工作区`);
    await this.refreshAll();
  }

  /**
   * cherry-pick 一个提交(把它的改动搬到当前分支)。
   *
   * 上游:`commit-list.tsx:843-847`(enabled 判据 = `canCherryPick()`,
   * `commit-list.tsx:867-872`:`onCherryPick !== undefined &&
   * isMultiCommitOperationInProgress === false`)⇒ `lib/git/cherry-pick.ts:141-182`。
   *
   * 该做的与 {@link revertCommit} 逐条同构(理由那里写全了):成功一条 toast,
   * `merge-conflicts` 时报**带 `--continue`/`--abort` 出路的**回执,两种结局都重取状态。
   * 唯一的差别是宿主留在 `CHERRY_PICK_HEAD`(还可能带 `.git/sequencer/`)。
   * @param sha - 要拣选的提交。
   */
  public async cherryPickCommit(sha: string): Promise<void> {
    const path = this.state.current;
    if (path === '') { return; }
    this.emit({ busy: 'cherry-pick' });
    const result = await api.cherryPickCommit(path, sha);
    this.emit({ busy: '' });
    if (!result.ok) {
      if (result.error.code === 'merge-conflicts') {
        this.toast(
          `拣选 ${sha.slice(0, 7)} 遇到冲突:改动没有落地,仓库停在 CHERRY_PICK_HEAD。` +
            '本插件没有「继续/放弃拣选」的命令,请在终端里解决冲突后用 `git cherry-pick --continue`(或 `--abort`)。',
          'err',
        );
      } else {
        this.fail(result.error);
      }
      await this.refreshAll();
      return;
    }
    this.toast(`已拣选 ${sha.slice(0, 7)}`);
    await this.refreshAll();
  }

  /**
   * 建标签(上游 History 右键「Create Tag…」)。
   *
   * 上游:`commit-list.tsx:823-827`(enabled = `onCreateTag !== undefined`)⇒
   * `compare.tsx:607-613` 的 `onCreateTag` ⇒ `dispatcher.showCreateTagDialog` ⇒
   * `ui/create-tag/create-tag-dialog.tsx`。上游那个对话框有两个要点,我们**沿用一半、如实报一半**:
   *
   *  - **名字输入**:`RefNameTextBox`,`okButtonDisabled = error !== null || tagName.length === 0`,
   *    还有 `MaxTagNameLength = 245` 的上限。这两条我们在视图层照做
   *    (`history-view.tsx` 的 `tagFor` 对话框);
   *  - ⚠️ **上游建的是附注标签**(`lib/git/tag.ts:13-21` 的 `tag -a -m '' <name> <sha>`),
   *    而本仓库的冻结契约建**轻量标签**(`git tag <name> [<sha>]`,
   *    `core/git-argv.ts` 的 `tagCreateArgv`)。差别是**不可逆的数据差异**:
   *    轻量标签没有 tagger / 日期 / 消息,事后无法补(`docs/discard-lines-contract.md` §6)。
   *    所以对话框里那一档必须**明确不可用**,不能画一个点了没反应的选项。
   * @param name - 标签名(宿主会过 `assertValidRefName`)。
   * @param sha - 目标提交;缺省 = 当前 HEAD。
   */
  public async createTag(name: string, sha?: string): Promise<void> {
    const path = this.state.current;
    if (path === '') { return; }
    this.emit({ busy: 'tag' });
    const result = await api.tagCreate(path, name, sha);
    this.emit({ busy: '' });
    if (!result.ok) {
      this.fail(result.error);
      return;
    }
    this.toast(`已创建标签 ${name}(轻量标签:没有 tagger / 日期 / 消息)`);
    /*
     * 本地**增量**记账 —— 上游 `lib/stores/git-store.ts:501-507` 的 `addTagToPush`
     * (`_tagsToPush = [..._tagsToPush, tagName]`)。
     *
     * 这里不需要重新问一次宿主(`refreshTagsToPush`):刚建出来的标签**按定义**就是
     * 「本地有、远端没有」—— 而且本仓的 `push()` 走 `pushArgv` 且**从不传 `tags`**
     * (只推分支)⇒ 没有任何别的路径能把它推上去。权威读数仍然归 `tag-unpushed` 路由
     * (下次切进 History 时覆盖这一条)。
     */
    if (!this.state.tagsToPush.includes(name)) {
      this.emit({ tagsToPush: [...this.state.tagsToPush, name] });
    }
    await this.refreshAll();
  }

  /**
   * 删标签(上游 History 右键菜单的 `Delete tag <name>` / `Delete tag…` 子菜单)。
   *
   * 上游:`commit-list.tsx:889-924` 的 `getDeleteTagsMenuItem` —— 项**只有在
   * `onDeleteTag !== undefined` 且该提交有**未推送**的标签时才入列
   * (`:893-899`),而且每条 tag 自己还有一个 `enabled: unpushedTags.includes(tagName)`。
   * 落点是 `lib/git/tag.ts:29-36` 的 `git tag -d <name>`(仅本地,远端标签不动)。
   * @param name - 标签名。
   */
  public async deleteTag(name: string): Promise<void> {
    const path = this.state.current;
    if (path === '') { return; }
    this.emit({ busy: 'tag' });
    const result = await api.tagDelete(path, name);
    this.emit({ busy: '' });
    if (!result.ok) {
      this.fail(result.error);
      return;
    }
    this.toast(`已删除本地标签 ${name}(远端上的同名标签没有被删除)`);
    /** 本地增量记账的另一半 —— 上游 `git-store.ts:509-515` 的 `removeTagToPush`。 */
    this.emit({ tagsToPush: this.state.tagsToPush.filter((tag) => tag !== name) });
    await this.refreshAll();
  }

  /**
   * 删**远端**分支(上游 `lib/git/branch.ts:119-143`,argv 等价于
   * `git push <remote> --delete <branch>`)。
   *
   * 在这条之前,`api.deleteRemoteBranch`(`api.ts:944`)与宿主路由
   * `remote-branch-delete`(`routes.ts:977`)双双存在而**全仓 0 调用点**,
   * 而 `branches-view.tsx:249` 的 toast 却告诉用户「删远端分支要 host 的
   * deleteRemoteBranch 路由,**今天还没有**」—— 那句话是**假的**(路由早就有了)。
   * 视图层那句已改;这里补上它指向的能力。
   *
   * 失败一律回显宿主原话:宿主把「远端 ref 已经不在了」按上游折成**成功**
   * (顺手清掉本地过期的 remote-tracking ref),所以真的走到 `fail()` 的都是
   * 有意义的原因(远端不存在、没权限、非快进保护…)。
   * @param remote - 远端名(必须是 `git remote` 里存在的名字)。
   * @param branch - 远端上的分支短名(**不带** `<remote>/` 前缀)。
   */
  public async deleteRemoteBranch(remote: string, branch: string): Promise<void> {
    const path = this.state.current;
    if (path === '') { return; }
    this.emit({ busy: 'branch-delete' });
    const result = await api.deleteRemoteBranch(path, remote, branch);
    this.emit({ busy: '' });
    if (!result.ok) {
      this.fail(result.error);
      return;
    }
    this.toast(`已删除远端分支 ${remote}/${branch}`);
    await this.refreshAll();
  }

  /**
   * **行级/块级丢弃**:把 diff 里选中的那几行从**工作区**撤掉(索引不动)。
   *
   * 上游:`app-store.ts:5748-5757` 的 `_discardChangesFromSelection` ⇒
   * `git-store.discardChangesFromSelection` ⇒ `lib/git/apply.ts:102-120`。
   *
   * ## 方向契约(**这条缺陷类是静默的,必须写死在代码旁边**)
   *
   * 送出去的补丁必须是 `git diff` **正向**的那份(新内容在 `+` 侧):
   *
   * ```
   * 客户端:  git diff 正向   →  buildPartialPatch(与 stageLines 同一族)
   * host:    git apply --reverse --unidiff-zero --whitespace=nowarn -   (git-argv.ts)
   * 净效果:  选中的 hunk 从工作区消失,index 一个字节不动
   * ```
   *
   * ⚠️ **绝不要用镜像里的 `formatPatchToDiscardChanges()`
   * (`desktop/lib/patch-formatter.ts:251`)** —— 它已经把 `+`/`-` 两侧交换过
   * (上游那么写是因为它的调用点**不带** `--reverse`)。把它的产物喂给我们这条
   * `--reverse` 路由,两侧会被翻两次 ⇒ **改动被写回工作区**,而 `git apply`
   * 不会报错。完整裁决见 `docs/discard-lines-contract.md` §2/§3。
   *
   * ## 与「整文件丢弃」的分工
   *
   * `discardFiles`(`:1133`)走 `api.discard`(整文件 + `git clean` 未跟踪);
   * 本方法只处理**行级选区**,落点是 `api.discardLines`。两者都在,不互相取代。
   * @param file - 仓库内相对路径。
   * @param spec - 要丢弃的选区(`desktop-diff.tsx` 的 `selectionToSpec()` 输出)。
   */
  public async discardLines(file: string, spec: LineSelectionSpec): Promise<void> {
    const path = this.state.current;
    if (path === '') { return; }
    const diff = this.state.diff;
    /*
     * 基准守卫:补丁必须由**屏幕上这一份 diff** 解析而来,否则行号与 host 重新
     * 取的那份对不上(与 `stageLines` 的陈旧选区守卫同族,见 `desktop-diff.tsx`
     * 文件头「陈旧选区守卫」)。这里能拿到的是 store 当前那份 diff,而调用方
     * (`changes-view.tsx` 的 `DiffPanel`)渲染的正是它。
     */
    if (diff === null || diff.path !== file || diff.patch.trim() === '') {
      this.toast('这份 diff 不是当前文件的,已取消丢弃(请重试)。', 'err');
      return;
    }
    const entry = (this.state.status?.files ?? []).find((f) => f.path === file);
    if (entry === undefined) {
      this.toast('这个文件已经不在变更列表里了,丢弃没有执行。', 'err');
      return;
    }
    /*
     * 行级丢弃的**能力边界**比行级暂存更硬:
     *  - 未跟踪文件在 `git diff` 下没有输出(宿主 `discard-lines` 会以 bad-request 失败),
     *    而且它的「丢弃」语义是**删文件**,那是 `discardFiles`(走 `git clean`)的事;
     *  - 已暂存文件(索引里已有内容)显示的可能是 HEAD→索引 的 diff,下标空间不同。
     * 两者都**明确拒绝并说清去哪儿**,不静默失败。
     * (`supportsLineSelection` 是这两条的既有判据,与行级暂存共用一处定义。)
     */
    if (!supportsLineSelection(entry)) {
      this.toast(
        entry.untracked === true
          ? '未跟踪文件没有行级补丁:整文件丢弃请用文件行上的「丢弃」按钮。'
          : '这个文件在索引里已经有内容,行级丢弃的行号无法对齐:请用整文件丢弃。',
        'err',
      );
      return;
    }
    let patch: string;
    try {
      patch = buildPartialPatchFromRaw(
        file,
        fileStatusKindOf(entry.unstaged !== undefined ? { status: entry.unstaged } : {}),
        parsePatch(diff.patch),
        spec,
      );
    } catch (error) {
      // `formatPatch` 在选区为空时抛错(上游同)—— 这不是故障,是「没什么可丢的」。
      this.toast(`没有可丢弃的行:${error instanceof Error ? error.message : String(error)}`, 'err');
      return;
    }
    this.emit({ busy: 'discard' });
    const result = await api.discardLines(path, file, patch);
    this.emit({ busy: '' });
    if (!result.ok) {
      this.fail(result.error);
      return;
    }
    this.toast(`已丢弃 ${file} 里选中的改动`);
    await this.afterIndexChange();
  }

  /**
 * 切换 Unified/Split(照 Desktop 的 setShowSideBySideDiff,持久化到 localStorage)。
 * @param value - true 为并排。
 */
setSideBySide(value: boolean): void {
  setShowSideBySideDiff(value);
  this.emit({ sideBySide: value });
}

/**
 * 切换「隐藏空白改动」,并**重新取 diff**。
 *
 * 这不是界面过滤而是重跑 `git diff -w`:实测 hunk 头会从 `@@ -1,5 +1,6 @@`
 * 变成 `@@ -3,3 +3,4 @@`,行号与真实补丁不再对应。所以旧 diff 必须作废,
 * 而隐藏期间**禁止行级暂存**(界面里也这么解释)。
 * @param value - true 为隐藏。
 */
async setHideWhitespace(value: boolean): Promise<void> {
  setHideWhitespaceInChangesDiff(value);
  this.emit({
    hideWhitespace: value,
    diff: null,
    diffKey: '',
    // 上游 `_setHideWhitespaceInChangesDiff`(`lib/stores/app-store.ts:7947-7957`,
    // 真值在 `:7956`)传的也是 `clearPartialState: true`。理由是同一个:隐藏空白是
    // **重跑 `git diff -w`**(键名与理由见本文件 `:979-982` 的注释),hunk 头会从
    // `@@ -1,5 +1,6 @@` 变成别的形状 ⇒ **行号空间变了**,旧的 partial 选区对新 diff
    // 没有意义。以前这里只撤 diff、不动 `includeState`,于是模型里留下一个按**旧行号**
    // 记着的 partial,提交时 `commit()` 会拿它去 materialize ⇒ 可能提交到错误的行。
    //
    // 2026-10:这条变换改由**镜像那份规则**执行(见 `mirroredClearPartial`);
    // 原来的本地实现 `clearPartialAfterCommit` 已退役、不再被调用。
    includeState: mirroredClearPartial(this.state.includeState, this.state.status),
  });
  await this.loadDiff();
}

/** 切换 History 的同一开关(Desktop 里两个开关独立);同样作废旧 diff 重取。 */
async setHideWhitespaceHistory(value: boolean): Promise<void> {
  setHideWhitespaceInHistoryDiff(value);
  this.emit({ hideWhitespaceHistory: value, diff: null, diffKey: '' });
  await this.loadDiff();
}

/**
   * 拉取本地工作区文件清单(Code 页签用)。
   *
   * 按仓库缓存:文件清单在一次浏览里不会变,重复展开目录不该反复起 git 进程。
   * 用户点刷新时传 force。
   * @param force - 忽略缓存重新拉取。
   */
  async loadRepoFiles(force = false): Promise<void> {
    const path = this.state.current;
    if (path === '') { return; }
    const cached = this.state.repoFiles;
    if (force !== true && cached !== null && cached.path === path) { return; }
    const result = await api.repoTree(path);
    if (!result.ok) { this.fail(result.error); return; }
    this.emit({ repoFiles: { path, files: result.value.files, truncated: result.value.truncated } });
  }

  /** 拉取本机可用的外部编辑器清单(只在需要时请求一次)。 */
  async loadExternalApps(): Promise<void> {
    if (this.state.externalApps.length > 0) { return; }
    const result = await api.systemApps();
    if (result.ok) this.emit({ externalApps: result.value.apps });
  }

  /**
   * 在文件管理器中显示该路径(Desktop 的 Show in Finder)。
   * @param path - 绝对路径;host 会校验它落在已添加的仓库内。
   */
  async revealInFileManager(path: string): Promise<void> {
    const result = await api.systemReveal(path);
    if (!result.ok) { this.fail(result.error); return; }
    if (!result.value.ok) this.toast('无法在文件管理器中打开该位置。', 'err');
  }

  /**
   * 用外部编辑器打开该路径(Desktop 的 Open in <editor>)。
   * @param path - 绝对路径。
   * @param appId - `externalApps` 里的 id;省略用系统默认应用。
   */
  async openInExternalEditor(path: string, appId?: string): Promise<void> {
    const result = await api.systemOpenInApp(path, appId);
    if (!result.ok) { this.fail(result.error); return; }
    if (!result.value.ok) this.toast('无法用外部编辑器打开。', 'err');
  }

  async commit(): Promise<void> {
    const path = this.state.current;
    const status = this.state.status;
    if (path === '' || status === null) { return; }
    const form = this.state.commitForm;
    /*
     * 提交哪些文件由**客户端的纳入状态**决定(上游 `app-store.ts:3702-3705`:
     * `file.selection.getSelectionType() !== DiffSelectionType.None`)。
     *
     * ⚠️ `included` 必须在**下面这条摘要守卫之前**算出来:摘要本身要用它
     * (单文件提交时,空摘要会被**占位摘要**取代 —— 见 `summaryOrPlaceholderOf`)。
     */
    const included = this.includedFiles();
    /*
     * **摘要的真实取值** —— 上游 `commit-message.tsx:620` 的
     * `summary: this.summaryOrPlaceholder`(定义在 `:587-592`)。
     *
     * 以前这里判的是 `form.summary.trim() === ''`,而且载荷发的是 `form.summary`
     * ⇒ 单文件 + 空摘要被**两道**都挡住:按钮 `aria-disabled`(changes-view 的旧条件)
     * 与这条守卫。上游两条都不是这样:单文件时摘要用 `Create/Delete/Update <文件名>`,
     * 而且它**真的**被提交上去。判据:`docs/probes/commit-form-parity-probe.mjs`
     * 的 R01/R10/R20/R23/R24(改前 message 是 `null`/`''`,改后是占位摘要)。
     *
     * 守卫改成「解析后的摘要为空」:这样 amend + 多文件 + 空摘要(界面上已经禁用,
     * 但 `commit()` 是公开 API)也走同一条早退,而不是把一条空消息交给 git
     * (那会以 `Aborting commit due to empty commit message` 失败)。
     */
    const message = summaryOrPlaceholderOf(form.summary, included);
    if (message.trim() === '') {
      this.toast('请填写提交摘要', 'err');
      return;
    }
    if (status.conflictedCount > 0) {
      this.toast('还有未解决的冲突,解决后再提交', 'err');
      return;
    }
    const files = included.map((f) => f.path);
    if (files.length === 0 && !form.amend && !form.allowEmpty) {
      this.toast('请先勾选一个或多个文件', 'err');
      return;
    }
    this.emit({ busy: 'commit' });

    // ---------- materialize:把客户端模型写进索引 ----------
    //
    // 照上游 `lib/git/commit.ts:24-31` 的顺序:
    //   1) `unstageAll`  —— 先把变更文件的索引位清空(索引 == HEAD)。上游注释写得很直白:
    //      「我们的 diff 反映的是工作区与上一次提交的差别,所以提交也该这么做」;
    //   2) `stageFiles` —— 按每个文件的 selection 分流:`All` 走整文件 `git add`,
    //      `Partial` 走 `apply --cached --unidiff-zero`(上游 `update-index.ts:109-175`)。
    //
    // 我们在这里**用客户端自己的三条已有路由**做同一件事,而不是新增一条宿主路由:
    // 语义完全一致(同一串 git 命令、同一顺序),但不需要等重启,也不会出现
    // 「界面已经用新模型、宿主还按旧索引提交」那种会提交错内容的窗口。
    // 宿主 `git-service.ts:341-348` 的「不要重建索引」注释在**宿主侧**依然成立:
    // 它接手时索引已经等于用户的勾选,它只管 commit。
    const unstage = await api.unstage(path, status.files.map((f) => f.path));
    if (!unstage.ok) { this.emit({ busy: '' }); this.fail(unstage.error); return; }

    const wholeFiles = included
      .filter((f) => includeStateOf(this.state.includeState[f.path]) === 'all')
      .map((f) => f.path);
    if (wholeFiles.length > 0) {
      // 一条 `git add -- <paths>` 覆盖所有整文件纳入的路径(上游 `stageFiles` 也是批量)。
      const stage = await api.stage(path, wholeFiles);
      if (!stage.ok) { this.emit({ busy: '' }); this.fail(stage.error); return; }
    }

    const partialFiles = included.filter(
      (f) => includeStateOf(this.state.includeState[f.path]) === 'partial',
    );
    for (const file of partialFiles) {
      const spec = this.state.includeState[file.path];
      if (spec === undefined) { continue; }
      // 兜底:`stageLines` 的补丁基准是**索引→工作区**,而索引刚被清空成 HEAD。
      // 对「未跟踪/新增」文件那条命令输出为空(host 会以 bad-request 失败),
      // 对索引里原本就有内容的文件则下标空间可能对不上。这两种情况退回整文件纳入,
      // 并**明确告诉用户**(不静默)。
      if (file.untracked === true || file.staged !== undefined) {
        const fallback = await api.stage(path, [file.path]);
        if (!fallback.ok) { this.emit({ busy: '' }); this.fail(fallback.error); return; }
        this.toast(`${file.path} 暂不支持行级选择,已按整文件纳入提交`, 'err');
        continue;
      }
      // 走到这里已经排除了 untracked(上面那条兜底)与 staged(索引已有内容),
      // 所以 kind 只需要工作区那一侧的状态字母。
      const partial = await api.stageLines(
        path, file.path,
        fileStatusKindOf(file.unstaged !== undefined ? { status: file.unstaged } : {}),
        spec,
      );
      if (!partial.ok) {
        this.emit({ busy: '' });
        this.fail(partial.error);
        this.toast('部分暂存失败,提交已中止(索引里现在只有已成功暂存的部分)', 'err');
        await this.refreshStatus();
        return;
      }
    }

    const result = await api.commit({
      path,
      message,
      ...(form.description.trim() !== '' ? { description: form.description } : {}),
      files,
      amend: form.amend,
      signoff: form.signoff,
      noVerify: form.noVerify,
      allowEmpty: form.allowEmpty,
    });
    this.emit({ busy: '' });
    if (!result.ok) {
      this.fail(result.error);
      return;
    }
    /*
     * 上游 `app-store.ts:3779-3797` 的 `_refreshRepositoryAfterCommit`:
     * **修订**（amend）之后如果新 sha 与被修订的那个 sha 不同，就把当前分支记进
     * 「建议强推」表 —— 因为远端上那条被改写的提交还在，本地与远端**必然分叉**，
     * 这时上游的同步按钮会变成「Force push」而不是「Pull」。
     *
     * `status` 是本方法开头取的那份**提交前**的快照，它的 `headSha` 正是被修订的
     * 那个提交（amend 改的就是 HEAD）⇒ 与上游传进去的 `amendedCommit.sha` 同义。
     */
    if (form.amend) {
      this.addBranchToForcePushList(status.branch, status.headSha, result.value.sha);
    }
    // 提交成功后重置表单,但**只重置这一批**(照 Desktop 的 app-store.ts:3743-3748):
    // 只把 allowEmptyCommit 强制回 false,而 signoff / noVerify 要保留 ——
    // 连续提交时用户不必每次都重新勾「签名」和「绕过钩子」。
    const base = initial().commitForm;
    this.emit({
      commitForm: {
        ...base,
        signoff: form.signoff,
        noVerify: form.noVerify,
      },
      selectedCommit: result.value.sha,
      // 提交完成后**只**把行级部分选(partial)降级成不含;`All` 与用户
      // **显式取消勾选**的 `None` 原样保留 —— 照上游 `clearPartialState: true`
      // (`lib/stores/app-store.ts:3756-3759`,真值在 `:3758`
      //  → `lib/stores/updates/changes-state.ts:47-56`)。
      // 以前这里是 `includeState: {}`(整张抹掉),而本仓「缺失 = 默认 All」,
      // 于是用户明确排除的文件会在下一次提交里被静默带上。
      //
      // 2026-10:这条变换改由**镜像那份规则**执行(见 `mirroredClearPartial`);
      // 原来的本地实现 `clearPartialAfterCommit` 已退役、不再被调用。
      includeState: mirroredClearPartial(this.state.includeState, this.state.status),
    });
    this.toast(form.amend ? '已修改上一次提交' : `已提交 ${result.value.sha.slice(0, 7)}`);
    await this.refreshAll();
    await this.loadCommitDetail(result.value.sha);
  }

  // ---------- 历史 ----------

  async selectCommit(sha: string): Promise<void> {
    this.emit({ selectedCommit: sha, commitDetailFiles: [] });
    await this.loadCommitDetail(sha);
  }

  async loadCommitDetail(sha: string): Promise<void> {
    const path = this.state.current;
    if (path === '' || sha === '') { return; }
    const result = await api.commitDetail(path, sha);
    if (result.ok) {
      this.emit({ commitDetailFiles: result.value.files });
    }
  }

  // ---------- 同步 ----------
  //
  // 这一段是上游两层的**合成**,每一处都对着上游的行号:
  //
  //   | 上游 | 是什么 |
  //   |---|---|
  //   | `lib/git/fetch.ts:40` / `pull.ts:26` / `push.ts:47` | 一次网络动作:发**初始进度**,再跑 git |
  //   | `lib/stores/app-store.ts:5949`(performFetch)/ `:5484`(performPull)/ `:5216`(performPush) | 权重合成 + 刷新阶段 + `finally` 置空 |
  //   | `lib/stores/app-store.ts:5452`(withPushPullFetch) | 网络动作互斥(`isPushPullFetchInProgress`) |
  //
  // **为什么合成而不是按子类分别沿用**:上游把「谁在跑」放在 `AppStore`+`GitStore` 两层,
  // 而浏览器半只有这一层(host 才是 git 那一层)。行为面逐条对齐,命名保持可对照。

  /**
   * 网络动作的**远端名** —— 判定只有一份,在 `sync-state.ts` 的 `remoteNameOf()`
   * (它是上游 `ui/app.tsx:3620-3633` 的逐条移植,含「上游分支名 ≠ 本地分支名 ⇒ 给全名」
   * 那个看着像笔误但确实是上游行为的分支)。`performPush`(`app-store.ts:5243`)同源。
   *
   * 单一真源:进度标题、按钮标题(`toolbar.tsx` 的 `remoteName` prop)、
   * `dropCurrentBranchFromForcePushList` 都不用各自再判一次。
   */
  private networkRemoteName(): string {
    return remoteNameOf(this.state) ?? '';
  }

  /**
   * 上游 `app-store.ts:5168` 的 `updatePushPullFetchProgress`。
   *
   * 上游多一个 `if (this.selectedRepository === repository) this.emitUpdate()` —— 那是
   * 「选中仓库才重渲染」的优化,我们只有一个快照,`emit` 本身就是那个语义。
   */
  private updateSyncProgress(progress: Progress | null): void {
    if (this.state.progress === null && progress === null) {
      return;
    }
    this.emit({ progress });
  }

  /**
   * **开始按 ~250ms 轮询宿主侧的 git 进度** —— 上游那半边「百分比」的接法。
   *
   * ## 上游在这里是什么形状(以及我们为什么不能沿用那三行)
   *
   * 上游是 Electron 的主进程 + 渲染进程:`lib/git/push.ts:82-99` 把
   * `PushProgressParser` 挂在子进程的 stderr 上,解析出的 `percent` 经
   * `app-store.ts:5323-5329` 乘上本动作的权重,直接写进
   * `IRepositoryState.pushPullFetchProgress`;渲染进程**订阅**那个状态。
   * 也就是说上游**没有轮询** —— 进程内回调。
   *
   * 我们是 HTTP 两半,而且 `push` 那条请求**一直阻塞到推完**:它的响应就是
   * 「推完了」,进度**搭不了自己的车**。所以宿主把进度留在内存里
   * (`GitService.syncProgressByRoot`,就是上游那份状态的宿主等价物),
   * 客户端在动作在飞期间轮询一条只查 Map 的旁路路由。
   *
   * ## 三条纪律(每条都有理由)
   *
   * 1. **只在 `progress !== null` 的窗口里跑**:`syncProgressTimer` 由
   *    fetch/pull/push 各自在 `finally` 里停掉;`updateSyncProgress(null)` 之后
   *    任何一条迟到的响应都会被下面第 2 条挡掉。
   * 2. **跨动作不合并**:宿主那一份带 `kind`。若它与我当前这一条不是同一个
   *    `kind`(动作已经结束、或进到了 `generic` 刷新阶段),就**丢弃** ——
   *    否则一次推送的百分比会盖到下一次拉取上(最坏的表现是进度倒退)。
   * 3. **拿不到就当没有**:路由失败(老 host 没有这条路由 / 传输错)一律静默返回。
   *    「没有进度」是正常状态,不是错误;把 4 次/秒的失败写进诊断/日志会淹没真正的问题。
   *
   * @param actionWeight - 本动作的**权重**。宿主给的是解析器自己的 `percent`(0..1),
   *   上限是「网络阶段」在整条动作里占的比例(三支都是 0.9,给刷新阶段留 0.1)——
   *   与上游 `app-store.ts:5324-5328` 的 `value: pushWeight * progress.value` 同一处乘法。
   *   调用方传的就是它自己稍后交给 `refreshAfterNetworkAction()` 的那个起点,
   *   所以「进度最高到 0.9、然后跳到刷新阶段」在两边是同一个数。
   */
  private startSyncProgressPolling(actionWeight: number): void {
    this.stopSyncProgressPolling();
    const tick = async (): Promise<void> => {
      const path = this.state.current;
      if (path === '') {
        return;
      }
      const result = await api.syncProgress(path);
      if (!result.ok) {
        return;
      }
      const next = result.value.progress;
      if (next === null) {
        return;
      }
      const current = this.state.progress;
      if (current === null || current.kind !== next.kind) {
        return;
      }
      this.updateSyncProgress({
        ...current,
        description: next.description,
        value: actionWeight * next.value,
      });
    };
    this.syncProgressTimer = setInterval(() => { void tick(); }, SYNC_PROGRESS_POLL_MS);
  }

  /** 停掉进度轮询(三个网络动作的 `finally` 里各一次;可重复调用)。 */
  private stopSyncProgressPolling(): void {
    if (this.syncProgressTimer !== undefined) {
      clearInterval(this.syncProgressTimer);
      this.syncProgressTimer = undefined;
    }
  }

  /**
   * 上游 `app-store.ts:9676` 的 `_addBranchToForcePushList`。
   *
   * 判据与上游一致(`:9681-9683`):**sha 没变就不进表** —— 那正是「amend 只是改了
   * 信息、历史没变」的情况,这时不该建议强推。
   */
  private addBranchToForcePushList(branch: string, beforeChangeSha: string, afterChangeSha: string): void {
    if (branch === '' || afterChangeSha === '' || afterChangeSha === beforeChangeSha) {
      return;
    }
    if (this.state.forcePushBranches[branch] === afterChangeSha) {
      return;
    }
    this.emit({ forcePushBranches: { ...this.state.forcePushBranches, [branch]: afterChangeSha } });
  }

  /**
   * 上游 `ui/dispatcher/dispatcher.ts:1327` 的 `dropCurrentBranchFromForcePushList`。
   *
   * 调用点也是沿用的:`pushWithOptions`(`dispatcher.ts:748-752`)在
   * `forceWithLease` 时**先**把当前分支从表里删掉,再推 —— 强推成功之后
   * 「建议强推」的根据就不存在了(本地与远端又一致了)。
   */
  private dropCurrentBranchFromForcePushList(): void {
    const branch = this.state.status?.branch ?? '';
    if (branch === '' || this.state.forcePushBranches[branch] === undefined) {
      return;
    }
    const next = { ...this.state.forcePushBranches };
    delete next[branch];
    this.emit({ forcePushBranches: next });
  }

  /**
   * 网络动作返回后的**刷新阶段**进度。
   *
   * 上游在 fetch / pull / push 三支里各写了一遍(标题 + 两条 generic 进度),
   * 形状与**权重来源**逐字对齐:
   *
   * ```text
   * fetch : fetchWeight 0.9(不缩放),refreshWeight 0.1      (app-store.ts:5968-6000)
   * pull  : pullWeight  2, fetchWeight 1, refreshWeight 0.1  (app-store.ts:5535-5618)
   * push  : pushWeight  2.5, fetchWeight 1, refreshWeight 0.1(app-store.ts:5246-5367)
   *         pull/push 才做 `scale = (1/(w1+w2)) * (1-refreshWeight)` 的两次重标定;
   *         fetch 直接用 0.9(`lib/git/fetch.ts:84` 之后 updater 里 `value * fetchWeight`)。
   *         三支的 `refreshStartProgress = w1 + w2`(重标定后)都等于 0.9。
   * ```
   *
   * 我们这一侧 host 的每条同步路由只跑**一条** git 命令(pull 的 fast-forward 由 git
   * 自己完成,没有上游那个 `fastForwardBranches` + `_refreshRepository` 的后续),
   * 所以「刷新阶段」在这里就是 `refreshAll()`。进度值取上游在该阶段的**起始**权重 ——
   * 与上游同义(「网络阶段已经跑完了」),不是估的。
   *
   * @param title - 上游 fetch/pull/push 三支都写同一个标题(`Refreshing repository`)。
   * @param completedWeight - 上游该支的 `refreshStartProgress`。
   */
  private async refreshAfterNetworkAction(title: string, completedWeight: number): Promise<void> {
    const refreshWeight = 0.1;
    this.updateSyncProgress({
      kind: 'generic',
      title,
      // 上游 `:5991` / `:5360` / `:5612` 的 `description: 'Fast-forwarding branches'`。
      // 它会被 `push-pull-button.tsx:521` 当作 `tooltip` 渲染(用户可见)⇒ 按 §11.9 用中文。
      description: '正在快进分支',
      value: completedWeight,
    });
    await this.refreshAll();
    this.updateSyncProgress({
      kind: 'generic',
      title,
      value: completedWeight + refreshWeight * 0.5,
    });
  }

  /**
   * 按同步按钮**算好的动作**执行,而不是在这里重新判断一次条件 ——
   * 两处各判一次会让「按钮显示发布分支、点击却去拉取」这类不一致发生。
   *
   * 三个分支现在**只转发**到下面三个同名的上游动作上,不再各写一遍 ——
   * 否则 `progress` 的初始值/置空会在两处实现里漂移(上一版正是这样:
   * `runSyncAction` 与 `fetch`/`pull`/`push` 各有一套)。
   * @param action - 由 `syncPresentation` 决定:fetch / pull / push / none。
   */
  public async runSyncAction(action: 'fetch' | 'pull' | 'push' | 'none'): Promise<void> {
    switch (action) {
      case 'fetch':
        return this.fetch();
      case 'pull':
        return this.pull();
      case 'push':
        return this.push(false);
      case 'none':
      default:
        return;
    }
  }

  /**
   * 抓取 —— 上游 `lib/git/fetch.ts:40` + `app-store.ts:5949` 的 `performFetch`。
   * @param remote - 只抓一个远端(上游 `fetchRemotes` 那一支);省略 = 全部。
   */
  public async fetch(remote?: string): Promise<void> {
    const path = this.state.current;
    if (path === '') {
      return;
    }
    const remoteName = remote ?? this.networkRemoteName();
    // 上游 `withPushPullFetch`(`app-store.ts:5452-5461`):已经在跑就直接返回,
    // 不允许并发网络动作 —— 这也是「进度不会互相盖掉」的前提。
    if (this.isNetworkActionInProgress()) {
      return;
    }
    this.emit({ busy: 'fetch' });
    /*
     * 上游 `lib/git/fetch.ts:83-84` 的**初始进度**:
     *   progressCallback({ kind, title, value: 0, remote: remote.name })
     * 标题是 `` `Fetching ${remote.name}` ``(`:52`),我们这层按 §11.9 用中文。
     */
    this.updateSyncProgress({ kind: 'fetch', title: `正在抓取 ${remoteName}`, value: 0, remote: remoteName });
    // 上游 `:5968-5971` 的权重:fetchWeight 0.9 / refreshWeight 0.1(**不做两次重标定**)。
    const fetchWeight = 0.9;
    this.startSyncProgressPolling(fetchWeight);
    try {
      const result = await api.fetch(path, remote);
      if (!result.ok) {
        this.fail(result.error);
        return;
      }
      await this.refreshAfterNetworkAction('正在刷新仓库', fetchWeight);
      this.toast('已抓取远端');
    } finally {
      this.stopSyncProgressPolling();
      this.updateSyncProgress(null);
      this.emit({ busy: '' });
    }
  }

  /**
   * 拉取 —— 上游 `lib/git/pull.ts:26` + `app-store.ts:5484` 的 `performPull`。
   *
   * @param rebase - 这个仓库**生效**的 `pull.rebase`,也就是渲染按钮文案的同一个值
   *   (`SyncState.pullWithRebase`)。上游是同一个形状:顶栏把
   *   `pullWithRebase || false` 交给 `pullButton(...)` 的 `onClick`
   *   (`ui/toolbar/push-pull-button.tsx:497`),于是**一个值**同时决定文案与动作。
   *
   *   **省略 = 不表态**,由宿主自己读配置 —— 这不是「两种行为」,
   *   而是**同一个** git 配置的第二次读取:省略的那几个调用点
   *   (`workbench.tsx:726` 的「更多 ▸ 拉取」、`runSyncAction('pull')`)本来就没有
   *   「按钮文案」要与执行对齐。顶栏那条路径**必须**给值,否则文案与执行又分家。
   */
  public async pull(rebase?: boolean): Promise<void> {
    const path = this.state.current;
    if (path === '') {
      return;
    }
    const remoteName = this.networkRemoteName();
    if (this.isNetworkActionInProgress()) {
      return;
    }
    this.emit({ busy: 'pull' });
    /* 上游 `lib/git/pull.ts:99-100` 的初始进度(标题在 `:67`)。 */
    this.updateSyncProgress({ kind: 'pull', title: `正在拉取 ${remoteName}`, value: 0, remote: remoteName });
    /*
     * 上游 `:5535-5547` 的权重重标定,逐字:
     *   let pullWeight = 2; let fetchWeight = 1; const refreshWeight = 0.1
     *   const scale = (1 / (pullWeight + fetchWeight)) * (1 - refreshWeight)
     *   pullWeight *= scale; fetchWeight *= scale   ⇒ 起点 = (2+1)*scale = 0.9
     *
     * ⚠️ 这段**必须在 `try` 之前**:同一个 `pullWeight` 有两个消费点 ——
     * 进度轮询的乘法(`startSyncProgressPolling`)与刷新阶段的起点
     * (`refreshAfterNetworkAction`)。分两处各算一遍就是两份真源。
     */
    const scale = (1 / (2 + 1)) * (1 - 0.1);
    const pullWeight = 2 * scale;
    this.startSyncProgressPolling(pullWeight);
    try {
      const result = await api.pull(path, rebase);
      if (!result.ok) {
        this.fail(result.error);
        return;
      }
      await this.refreshAfterNetworkAction('正在刷新仓库', (2 + 1) * scale);
      this.toast('已拉取');
    } finally {
      this.stopSyncProgressPolling();
      this.updateSyncProgress(null);
      this.emit({ busy: '' });
    }
  }

  /**
   * 推送 / 强推 —— 上游 `lib/git/push.ts:47` + `app-store.ts:5216` 的 `performPush`,
   * 强推那一支的「先删表项再推」照 `ui/dispatcher/dispatcher.ts:748-752`。
   * @param force - true = `--force-with-lease`(上游 `forceWithLease`)。
   */
  public async push(force: boolean): Promise<void> {
    const path = this.state.current;
    if (path === '') {
      return;
    }
    const remoteName = this.networkRemoteName();
    const branch = this.state.status?.branch ?? '';
    if (this.isNetworkActionInProgress()) {
      return;
    }
    // 上游 `pushWithOptions`:`forceWithLease` 时先 drop(`dispatcher.ts:748-752`),
    // 顺序也是契约 —— 推完再 drop 会让「推成功了但按钮还写着强推」出现一帧。
    if (force) {
      this.dropCurrentBranchFromForcePushList();
    }
    this.emit({ busy: 'push' });
    /*
     * 上游 `app-store.ts:5244-5250` 的初始进度(**推送唯一一条会带 branch 的**):
     *   { kind:'push', title: `Pushing to ${remoteName}`, value: 0, remote, branch }
     * 上游标题里的 `remoteName` 是 `branch.upstreamRemoteName || remote.name`(`:5243`),
     * 与本方法的 `networkRemoteName()` 同源。
     */
    this.updateSyncProgress({
      kind: 'push',
      title: `正在推送到 ${remoteName}`,
      value: 0,
      remote: remoteName,
      branch,
    });
    /*
     * 上游 `:5246-5248` + `:5255-2575` 的权重重标定,逐字:
     *   let pushWeight = 2.5; let fetchWeight = 1; const refreshWeight = 0.1
     *   const scale = (1 / (pushWeight + fetchWeight)) * (1 - refreshWeight)
     *   pushWeight *= scale; fetchWeight *= scale   ⇒ 起点 = (2.5+1)*scale = 0.9
     *
     * `pushWeight` 的两个消费点与 pull 那支同理(进度轮询的乘法 + 刷新阶段起点),
     * 所以提到 `try` 之前 —— 只算一次。
     */
    const scale = (1 / (2.5 + 1)) * (1 - 0.1);
    const pushWeight = 2.5 * scale;
    this.startSyncProgressPolling(pushWeight);
    try {
      const result = await api.push(path, force);
      if (!result.ok) {
        // 推送失败 ⇒ **弹窗**,不是 toast。上游从不用 toast 报推送失败:
        // `performPush`(`app-store.ts:5310-5372`)把错误交给
        // `performFailableOperation` → `emitError` → `Dispatcher.postError`
        // (`ui/dispatcher/dispatcher.ts:797-813`)→ 处理器链 → 三种弹窗
        // (判据表见 `bits.tsx` 的 `pushFailureKindOf`)。
        this.emit({ pushFailure: result.error });
        return;
      }
      await this.refreshAfterNetworkAction('正在刷新仓库', (2.5 + 1) * scale);
      this.toast(force ? '已强推(--force-with-lease)' : '已推送');
    } finally {
      this.stopSyncProgressPolling();
      this.updateSyncProgress(null);
      this.emit({ busy: '' });
    }
  }

  /**
   * 关闭推送失败弹窗 —— 上游 `app.tsx` 的 `onPopupDismissedFn` 把弹窗队列队首 pop 掉。
   */
  public clearPushFailure(): void {
    if (this.state.pushFailure === null) {
      return;
    }
    this.emit({ pushFailure: null });
  }

  /**
   * 关闭**生成提交信息失败**弹窗(与 {@link clearPushFailure} 同形)。
   *
   * 关闭路径是契约的一部分:没有它,弹窗会**永远关不掉** —— 快照里那场失败还在,
   * 下一次重渲染它就复活(`push-failure-workbench-wiring-probe.mjs` 的 R2 判的正是这条:
   * 「DOM 藏了、快照还留着错误」比不弹更坏)。
   */
  public clearGenerateFailure(): void {
    if (this.state.generateFailure === null) {
      return;
    }
    this.emit({ generateFailure: null });
  }

  /**
   * 上游 `withPushPullFetch`(`app-store.ts:5452-5475`)的互斥判据 —— 已经有网络动作在跑。
   *
   * 读侧投影(**视图层要看的那一条**)在 `src/client/sync-state.ts` 的
   * `networkActionInProgress(snap)` —— **判据只有那一份**,这里直接调它,
   * 免得「写入侧允不允许并发」与「按钮转不转圈」在某天悄悄分叉。
   * 判据是 `progress !== null` 而不是 `busy !== ''`:`busy` 里还有
   * `commit` / `stage` / `checkout` 等**非网络**动作(`lib/app-state.ts:597` 的
   * `isPushPullFetchInProgress` 是同义的收窄)。
   */
  private isNetworkActionInProgress(): boolean {
    return networkActionInProgress(this.state);
  }

  // ---------- 分支 ----------

  async checkout(branch: string, createFromRemote?: string): Promise<void> {
    const path = this.state.current;
    if (path === '') { return; }
    this.emit({ busy: 'checkout' });
    const result = await api.checkout(path, branch, createFromRemote);
    this.emit({ busy: '' });
    if (!result.ok) {
      this.fail(result.error);
      return;
    }
    this.toast(`已切到 ${branch}`);
    /*
     * 切分支 ⇒ **退出修订态**。
     *
     * 上游把这件事写成 `RepositoryStateCache.update()` 里的一条**不变量**
     * (`src/core/desktop/lib/stores/repository-state-cache.ts:59-71`):
     * `commitToAmend` 只在「HEAD 未变、且等于被修订的那个 sha、且没有冲突态」时保留,
     * 否则强制置 `null`。理由是硬的:amend 改的是 HEAD,HEAD 换了之后那个「正在修订」
     * 的意图已经指向**另一个提交**,带着它去提交就会用旧提交的信息改写新 HEAD。
     *
     * ⚠️ **那条不变量在本仓库是失效的**(2026-10 逐行核过):它读
     * `branchesState.tip`,`newTip.kind === TipState.Valid` 是它成立的前提;而
     * `src/client/repo-state-cache.ts` 从不写 `tip`(只写 `forcePushBranches`),
     * 镜像初值是 `{ kind: TipState.Unknown }`(`repository-state-cache.ts:399`)
     * ⇒ 前提恒假 ⇒ 一旦有人把 amend 放进镜像的槽,它会被**每一轮** `update()` 清掉。
     * 这就是我们今天把 amend 放在 `extras` 里的代价,所以这条补偿必须**显式**写在这里。
     *
     * 退役条件:与 `startAmendingCommit` 的头注释同一条 —— 等 `commitToAmend` 真的
     * 进镜像的槽(并且 `tip` 被写),本句删除、由那条不变量接管。
     */
    this.stopAmendingCommit();
    await this.refreshAll();
  }

  async createBranch(name: string, startPoint?: string): Promise<void> {
    const path = this.state.current;
    if (path === '') { return; }
    const result = await api.createBranch(path, name, startPoint);
    if (!result.ok) {
      this.fail(result.error);
      return;
    }
    this.toast(`已创建分支 ${name}`);
    await this.checkout(name);
  }

  // ---------- 设置 ----------

  setModel(model: string): void {
    this.emit({ model });
  }

  /**
   * 默认模型;同时落盘(与 {@link setStagedOnlyPersisted} 同形)。
   *
   * 为什么需要它:设置面板的「默认模型」下拉一直调的是这个**不存在**的方法
   * (`settings.tsx:357`),运行期 `TypeError: store.setModelPersisted is not a
   * function` —— 换模型这个动作从来没生效过。host 侧本来就完整支持这条链路:
   * `api.setPrefs({ model })`(`api.ts:130`)→ `prefs/set`(`host/routes.ts:305`)
   * → `registry.setPrefs`(`repo-registry.ts:271`);而 `prefModel()` 是 host 生成
   * 提交信息时**真正使用**的模型(`src/index.ts:364` 的 `pinnedModel`)。
   *
   * **`await` 落盘结果再改界面**:以前是 `void api.setPrefs(...)` + 立刻 emit ——
   * 写盘失败(磁盘满 / 权限变化)时界面照样显示新值,而 host 还是旧值 ⇒
   * 下一次刷新又弹回去,用户看到的是「设置存不住」。这类「乐观更新掩盖写入失败」
   * 与只写不读是同一族静默缺陷。现在失败就**回滚**并报错。
   * @returns 落盘成功时为 true(界面无需回滚)。
   */
  async setModelPersisted(model: string): Promise<boolean> {
    const previous = this.state.model;
    this.setModel(model);
    const result = await api.setPrefs({ model });
    if (!result.ok) {
      this.setModel(previous);
      this.fail(result.error);
      return false;
    }
    return true;
  }

  /**
   * 生成范围偏好(「只依据纳入提交的变更生成」);同时落盘。
   *
   * 语义在 2026-10-06 由人类裁决换过:键名仍是 `stagedOnly`(避免 `prefs` 迁移),
   * 但载体从「git 索引的 staged 位」换成「纳入提交的文件清单」——
   * 旧载体在「勾选 = 纳入、不写索引」的模型下已经不存在。
   * 详见 `docs/design.md` §17.4 与 `host/routes.ts` 的 `collectDiffText`。
   * @returns 落盘成功时为 true。
   */
  async setStagedOnlyPersisted(value: boolean): Promise<boolean> {
    const previous = this.state.stagedOnly;
    this.setStagedOnly(value);
    const result = await api.setPrefs({ stagedOnly: value });
    if (!result.ok) {
      this.setStagedOnly(previous);
      this.fail(result.error);
      return false;
    }
    return true;
  }

  setStagedOnly(value: boolean): void {
    this.emit({ stagedOnly: value });
  }

  /**
   * 读回 host 已落盘的生成偏好(模型 pin / 生成范围)。
   *
   * **这条读回路以前完全不存在**,是「存储有问题」这条报告的根因:
   *  - `prefs.model` 只写不读 ⇒ 刷新后 `loadModels()` 把下拉重置成 `models[0]`,
   *    而 host 生成提交信息用的是 `prefs.model`(磁盘上的 pin)——
   *    界面显示的模型与真正生效的模型**静默分叉**;
   *  - `prefs.stagedOnly` 只写不读 ⇒ 勾选框每次刷新/重启都弹回默认 `true`。
   *
   * 实测证据(真 HTTP + 真 store,`scripts/probe-prefs-roundtrip.mjs`):
   * 修前「选 provB/model-b → 刷新」显示 provA/model-a;
   * 「取消勾选 → 刷新」显示 true。
   *
   * 调用时机:必须在 {@link loadModels} **之前** await,否则 loadModels 会先
   * 用 `models[0]` 占掉 `state.model`,这里的 pin 就再也进不去(两者都是 emit,
   * 后写的赢)。
   *
   * 不在这里校验 pin 是否仍在模型清单里:清单是异步拿的,校验交给
   * {@link loadModels} 的现有判据(model 不在清单里就退回 models[0])。
   */
  async loadPrefs(): Promise<void> {
    const result = await api.prefs();
    if (!result.ok) { return; }
    const patch: Partial<Snapshot> = {};
    const { model, stagedOnly } = result.value;
    if (model !== undefined && model !== '') patch.model = model;
    if (stagedOnly !== undefined) patch.stagedOnly = stagedOnly;
    if (Object.keys(patch).length > 0) this.emit(patch);
  }

  async loadModels(): Promise<void> {
    const result = await api.models();
    if (!result.ok) { return; }
    const models = result.value.models;
    const current = this.state.model !== '' && models.some((m) => `${m.provider}/${m.id}` === this.state.model)
      ? this.state.model
      : (models[0] !== undefined ? `${models[0].provider}/${models[0].id}` : '');
    this.emit({ models, model: current });
  }

  async loadAuth(): Promise<void> {
    const result = await api.authState();
    if (result.ok) this.emit({ auth: result.value });
  }

  /**
   * 拉取可克隆的远程仓库清单。
   *
   * **未登录时不发请求**:以前每个打开下拉/克隆弹窗的动作都会打一次 host,
   * host 只能回「未登录」,于是日志被 `未登录 GitHub,无法列出远程仓库。` 刷屏
   * (实测一次运行 20+ 条),把真正要看的 `已注册 /dsh-git/*` 和自检结果淹掉。
   * 未登录是**正常状态**,不是错误。
   * @param force - true 表示用户显式点了刷新,忽略 5 分钟缓存。
   */
  async loadRemoteRepos(force = false): Promise<void> {
    // 把判定先读进一个**局部常量**,再进分支。
    //
    // 为什么不能直接写 `if (this.state.auth?.signedIn !== true) { … await …;
    // if (this.state.auth?.signedIn !== true) return }`:tsc 会把第一层 guard 的
    // 收窄(`false | undefined`)一直带到 `await` 之后,**不认** `loadAuth()` 里
    // `emit()` 换掉整个快照这件事 —— 于是第二条判定被当成「`false|undefined`
    // 与 `true` 无交集」的恒假比较(TS2367),那个「重新读一次登录态」的分支
    // 会被当成死代码。判定本身在运行期是**有意义**的(await 期间 snapshot 可能
    // 已经从「未登录」变成「已登录」),所以这里保留语义、只换个写法让编译器
    // 能看见第二次读取。
    const signedIn = this.state.auth?.signedIn === true;
    if (!signedIn) {
      // 还没拿到登录态:先读一次 auth,再决定要不要发请求。
      await this.loadAuth();
      if (this.state.auth?.signedIn !== true) { return; }
    }
    this.emit({ remoteReposLoading: true });
    const result = await api.remoteRepos(force);
    this.emit({ remoteReposLoading: false });
    if (!result.ok) {
      this.fail(result.error);
      return;
    }
    this.emit({ remoteRepos: result.value.repos, hidden: result.value.hidden });
  }

  async hideRemote(fullName: string): Promise<void> {
    const result = await api.hideRemote(fullName);
    if (result.ok) this.emit({ hidden: result.value.hidden });
  }

  async unhideRemote(fullName: string): Promise<void> {
    const result = await api.unhideRemote(fullName);
    if (result.ok) this.emit({ hidden: result.value.hidden });
  }

  async setPat(token: string): Promise<boolean> {
    const result = await api.setPat(token);
    if (!result.ok) {
      this.fail(result.error);
      return false;
    }
    this.emit({ auth: result.value });
    this.toast(result.value.signedIn ? `已登录 @${result.value.login}` : '已退出登录');
    await this.loadRemoteRepos(true);
    return true;
  }

  async logout(): Promise<void> {
    const result = await api.logout();
    if (!result.ok) {
      this.fail(result.error);
      return;
    }
    /*
     * 登出后的「空账号」字面量。
     *
     * ⚠️ `endpoint` 是必填(host 线的 `AuthStatePayload` 扩展,用于多端点账号):
     * 登出后回到默认端点 `https://api.github.com`。不要把它改回可选 ——
     * 那会让「消费方忘了兜底」变成静默的空字符串,而端点为空时
     * `accountEmails` / 头像判定都会打到错误的 host 上。
     */
    this.emit({ auth: { signedIn: false, login: '', tokenTail: '', endpoint: 'https://api.github.com', deviceFlow: this.state.auth?.deviceFlow ?? false, viaDeviceFlow: false }, remoteRepos: [] });
    this.toast('已退出登录');
  }

  setAuth(state: AuthStatePayload): void {
    this.emit({ auth: state });
  }
}

export { unwrap };
export type { ChangedFile, RepoStatus, SyncState, BranchEntry, CommitEntry, DiffResult };
