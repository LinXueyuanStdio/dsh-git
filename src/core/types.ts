/**
 * dsh-git 共享契约:host 与 client 都只依赖这里的形状。
 * 保持纯数据,便于单测与跨 bundle 复制(客户端 bundle 会内联一份)。
 * @module dsh-git/core/types
 */

/** 结构化错误码:host 路由信封与界面文案都按它分派。 */
export type GitErrorCode =
  | 'workspace-unknown'
  | 'not-a-repository'
  | 'no-upstream'
  | 'auth-failed'
  /** 未登录 GitHub;这是**正常状态**而非故障,日志按 info 记。 */
  | 'not-signed-in'
  | 'not-fast-forward'
  | 'merge-conflicts'
  | 'operation-in-progress'
  | 'nothing-to-commit'
  | 'bad-request'
  | 'timeout'
  /**
   * 一条 git 命令失败了,但 `classifyGitFailure` 的几条已知模式都不匹配
   * (`git-service.ts:511` 的 `git show <rev>:<path>` 就是这种)。
   *
   * 为什么不是折成 `'internal'`:界面按 `error.code !== 'internal'` 决定要不要把
   * git 原始 stderr 附在提示后面(`store.ts` 的 `fail()`),折成 internal 等于把
   * 唯一有用的诊断信息丢掉。它是 `'internal'` 的**更具体**版本,不是新语义。
   */
  | 'git-failed'
  | 'internal';

/** 一条可展示给用户的 git 错误。 */
export interface GitError {
  code: GitErrorCode;
  message: string;
  /** git 原始 stderr(截断),供「详情」展开。 */
  detail?: string;
}

/** 路由信封:成功带 value,失败带 error;永不抛到 HTTP 层。 */
export type GitEnvelope<T> = { ok: true; value: T } | { ok: false; error: GitError };

/** 变更文件的暂存/工作区状态。 */
export type ChangeStatus = 'M' | 'A' | 'D' | 'R' | 'C' | 'U' | '?';

/** 一个文件在两个区(暂存区 / 工作区)里的状态。 */
export interface ChangedFile {
  /** 仓库内相对路径(重命名时是新路径)。 */
  path: string;
  /** 重命名的旧路径。 */
  oldPath?: string;
  /** 暂存区状态:已暂存才有。 */
  staged?: ChangeStatus;
  /** 工作区状态:未暂存才有。 */
  unstaged?: ChangeStatus;
  /** 冲突(既不在暂存也不在工作区可提交状态)。 */
  conflicted?: boolean;
  /** 是否未跟踪。 */
  untracked?: boolean;
  /**
   * 冲突的「谁对谁」分类(来自 Desktop 的 mapStatus 表)。
   * 只有 conflicted 时才有;界面据此给出可操作文案而不是干巴巴一个 U。
   */
  conflict?: ConflictDetail;
  /** 重命名/复制的相似度分数(0-100)。 */
  renameScore?: number;
  /** submodule 的变更位;普通文件为空。 */
  submodule?: SubmoduleDetail;
}

/** 冲突分类(与 core/status-porcelain 的 ConflictSummary 同名)。 */
export type ConflictKind =
  | 'BothDeleted' | 'AddedByUs' | 'DeletedByThem' | 'AddedByThem'
  | 'DeletedByUs' | 'BothAdded' | 'BothModified';

/** 冲突详情:我方的索引状态与对方的。 */
export interface ConflictDetail {
  action: ConflictKind;
  us: string;
  them: string;
}

/** submodule 变更位。 */
export interface SubmoduleDetail {
  commitChanged: boolean;
  modifiedChanges: boolean;
  untrackedChanges: boolean;
}

/** 仓库状态快照。 */
export interface RepoStatus {
  root: string;
  /** 当前分支名;分离头时为空字符串。 */
  branch: string;
  headSha: string;
  detached: boolean;
  /** 还没有第一次提交。 */
  unborn: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: ChangedFile[];
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  conflictedCount: number;
  /** 进行中的操作:rebase/merge/cherry-pick/revert。 */
  operation: 'rebase' | 'merge' | 'cherry-pick' | 'revert' | null;
}

/** 统一的 diff 表示:原始 unified diff 文本 + 统计。 */
export interface DiffResult {
  path: string;
  oldPath?: string;
  /** `git diff` 原始输出;界面按行前缀着色。 */
  patch: string;
  additions: number;
  deletions: number;
  binary: boolean;
  /** 文件未被追踪(用 --no-index 与 /dev/null 比较)。 */
  untracked: boolean;
}

/** 一条提交记录。 */
export interface CommitEntry {
  sha: string;
  shortSha: string;
  subject: string;
  body: string;
  authorName: string;
  authorEmail: string;
  /** ISO 8601。 */
  authorDate: string;
  committerName: string;
  committerEmail: string;
  committerDate: string;
  parents: string[];
  /** 装饰:分支/标签。 */
  refs: string[];
}

/** 一次提交触碰的文件(带增删行数)。 */
export interface CommitFile {
  path: string;
  oldPath?: string;
  status: ChangeStatus;
  additions: number;
  deletions: number;
}

/** 提交详情 = 记录 + 文件统计。 */
export interface CommitDetail {
  commit: CommitEntry;
  files: CommitFile[];
  additions: number;
  deletions: number;
}

/** 分支条目。 */
export interface BranchEntry {
  /** 短名(remotes 前缀已剥)。 */
  name: string;
  /** 完整 refname。 */
  ref: string;
  isRemote: boolean;
  upstream: string | null;
  /** HEAD 指向的分支。 */
  current: boolean;
  sha: string;
}

/** 远端条目。 */
export interface RemoteEntry {
  name: string;
  url: string;
}

/** 一个已登记的本地仓库。 */
export interface RepoEntry {
  /** 绝对路径(canonical)。 */
  path: string;
  /** 展示名:别名优先,否则目录名。 */
  name: string;
  /** 别名(用户改过才有)。 */
  alias?: string;
  /** 从远端解析出的 owner/repo(有 GitHub 远端才有)。 */
  remote: string | null;
  /** 登记时间戳。 */
  addedAt: number;
  missing?: boolean;
  /** 记录时看到的分支,用于列表副标题。 */
  branch?: string;
}

/** 同步状态(工具栏 ↑↓ 与按钮状态机)。 */
export interface SyncState {
  ahead: number;
  behind: number;
  upstream: string | null;
  /** 远端列表;空 = 需要「发布仓库」。 */
  remotes: string[];
  /** 是否可强推(--force-with-lease 的推荐态由 ahead/behind 推导)。 */
  canForcePush: boolean;
  /** 上次抓取时间(ISO);从未抓取为 null。 */
  lastFetchedAt: string | null;
  /** 本地标签数。 */
  tagCount: number;
  /**
   * 当前仓库**生效**的 `git config pull.rebase`,按上游 `lib/app-state.ts:733` 的
   * `pullWithRebase?: boolean` 三态呈现:
   *
   * | 值 | 含义 | 界面(**裁决后三态同形**) |
   * |---|---|---|
   * | `true` | 配置是 `true` | 「拉取 origin」 |
   * | `false` | 配置是 `false` | 「拉取 origin」 |
   * | **键不存在** | 从未配置(或值不可识别) | 「拉取 origin」 |
   *
   * ⚠️ **2026-10 用户裁决**:按钮文案**不再区分**这个三态(原话:「不要『变基拉取 origin』,
   * 请保留『拉取 origin』」)。⇒ `pull.rebase=true` 的仓库界面上也显示「拉取 origin」,
   * 而 git 仍按配置变基:**文案与行为不再一致,这是裁决的结果,不是修好的 bug**。
   * 该处镜像偏离登记在 `scripts/verify-mirror.mjs` 的 `EXPECTED`
   * (`ui/toolbar/push-pull-button.tsx` 那条,偏离范围仍限死为字符串字面量),
   * 判据在 `docs/probes/pull-rebase-probe.mjs`。
   *
   * 为什么缺省是**键不存在**而不是 `false`:上游 `app-state.ts:728-733` 的注释写明
   * 「If this value is not found in config, this will be `undefined` to indicate that
   * the default Git behaviour will occur」。两者在文案上恰好同形,但语义不同 ——
   * 把「不知道」折成「false」就是让未知冒充已知。
   *
   * **这个值现在是「动作」的载体**:同一个值既喂给按钮那个三元分支
   * (`core/desktop/ui/toolbar/push-pull-button.tsx:615-617` 的 `pullWithRebase` prop),
   * 也随拉取一起回到宿主(`api.pull` 的 `rebase`),**覆盖**宿主自己去读配置的那一次 ⇒
   * 点按钮后真正执行的策略只由它决定。裁决前它还同时决定**文案**,所以
   * 「文案说变基、执行却 `--ff-only`」在结构上不可能发生;现在文案恒为常量,
   * 值只走动作这一路 —— 那句不变式**已随裁决作废**,别再引用它。
   */
  pullWithRebase?: boolean;
}

/** 一次操作的进度事件(流式返回给客户端)。 */
export interface ProgressStep {
  kind: 'progress' | 'done' | 'error';
  label: string;
  percent?: number;
  detail?: string;
}
