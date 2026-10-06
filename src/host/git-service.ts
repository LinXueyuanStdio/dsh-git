/**
 * host 侧 git 服务:一次 git 调用 = 一条 argv,解析交给 core/parse。
 * 语义照 GitHub Desktop 的工程经验:
 *  - 只读查询不抢锁(status --no-optional-locks)、diff 不带外部 diff 程序;
 *  - 提交走 `-F <tmpfile>`(消息不进 argv,避免 ps 可见与转义问题);
 *  - 强推只允许 --force-with-lease;
 *  - 无 upstream 时 push 自动 --set-upstream;
 *  - pull 尊重用户的 pull.rebase / pull.ff 配置。
 * @module dsh-git/host/git-service
 */

import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open as openFd, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import {
  BLOB_JSON_FALLBACK_MAX_BYTES, INDEX_REV, MAX_BLOB_BYTES, contentTypeFor, formatByteSize,
  isImmutableRev, looksBinary, parseRangeHeader,
} from '../core/blob.ts';
import type {
  BranchEntry, CommitDetail, CommitEntry, DiffResult, GitError, RepoStatus, SyncState,
} from '../core/types.ts';
import {
  addArgv, applyCachedArgv, applyReverseArgv, blobContentArgv, blobIndexEntryArgv, blobSizeArgv, blobTreeEntryArgv, branchCreateArgv, branchDeleteArgv, branchListArgv,
  branchRenameArgv, checkoutBranchArgv, checkoutDetachArgv, checkoutPathsArgv, checkoutRemoteArgv, cherryPickArgv,
  cleanArgv, cloneArgv, commitArgv, commitDetailStatArgv, configGetArgv, configSetArgv, diffCommitArgv,
  diffCommitNumstatArgv, diffNumstatArgv, diffStagedArgv, diffUnstagedArgv, diffUntrackedArgv,
  fetchArgv, initArgv, logArgv, nameStatusCommitArgv, pullArgv, pushArgv, pushDeleteRemoteBranchArgv,
  lsFilesArgv, remoteListArgv, remoteSetUrlArgv, remoteUrlArgv, resetMixedArgv, resetPathsArgv, resetToCommitArgv,
  revertArgv, rmCachedAllArgv,
  statusArgv, tagCreateArgv, tagDeleteArgv, tagListArgv, topLevelArgv, updateRefDeleteArgv,
  isSafeObjectName, isSafeRev, type ResetMode } from '../core/git-argv.ts';
import {
  buildRepoStatus, operationFromMarkers, parseBranches, parseConfigValue, parseGithubRemoteText,
  parseLog, parseNameStatus, parseNumstat, parseRemotes, parseStatus, parseTags,
} from '../core/parse.ts';
import type { GitRunner, GitRunResult } from './git-runner.ts';
import { OUTPUT_CAP_BYTES } from './git-runner.ts';
import { buildPartialPatch, isSelectionEmpty, type FileStatusKind, type LineSelectionSpec } from '../core/partial-stage.ts';
import { parseRawDiff } from '../core/diff-parse.ts';
import { testForInvalidChars } from '../core/desktop/lib/sanitize-ref-name.ts';

/** 服务级选项:仓库白名单与凭据环境由插件决定。 */
export interface GitServiceOptions {
  /** 允许操作的仓库根路径(canonical);不在其中的路径一律拒绝。 */
  allowedRoots: () => readonly string[];
  /** push/pull/fetch/clone 时注入的环境变量(令牌等)。 */
  credentialEnv?: () => Readonly<Record<string, string>>;
  /**
   * 诊断日志(上游 `log.warn` 的宿主等价物)。
   *
   * 唯一调用点:配置里出现不可识别的 `pull.rebase` 值时,照上游
   * `lib/stores/git-store.ts:464` 记一条 `Unexpected value found for pull.rebase …`。
   * 由 `src/index.ts` 接上 `RouteDeps.log`(即宿主的 logger,自带 `[dsh-git]` 前缀)。
   */
  log?: (message: string) => void;
}

/** 结构化失败:服务内部统一抛它,路由层转成信封。 */
export class GitServiceError extends Error {
  readonly code: GitError['code'];
  readonly detail: string | undefined;
  constructor(code: GitError['code'], message: string, detail?: string) {
    super(message);
    this.name = 'GitServiceError';
    this.code = code;
    this.detail = detail;
  }
  toError(): GitError {
    return this.detail === undefined || this.detail === ''
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, detail: this.detail };
  }
}

/** git 的 stderr → 可操作的中文提示 + 稳定错误码。 */
export function classifyGitFailure(stderr: string, context: string): GitServiceError {
  const s = stderr.toLowerCase();
  const detail = stderr.trim().slice(0, 2000);
  if (/authentication failed|could not read username|terminal prompts disabled|permission denied \(publickey\)/.test(s)) {
    return new GitServiceError('auth-failed', `${context}需要 GitHub 凭据:请在 ⚙ 设置里登录或填 Token。`, detail);
  }
  if (/not possible to fast-forward|non-fast-forward|fetch first|updates were rejected/.test(s)) {
    return new GitServiceError('not-fast-forward', `${context}被拒绝:远端有新提交,请先拉取(或在推送菜单里选择强推)。`, detail);
  }
  if (/conflict|would be overwritten|unmerged/.test(s)) {
    return new GitServiceError('merge-conflicts', `${context}遇到冲突,请在 Changes 里解决后重试。`, detail);
  }
  if (/nothing to commit|no changes added to commit/.test(s)) {
    return new GitServiceError('nothing-to-commit', '没有可提交的变更。', detail);
  }
  if (/not a git repository/.test(s)) {
    return new GitServiceError('not-a-repository', '这个目录不是 git 仓库。', detail);
  }
  if (/(rebase|merge|cherry-pick|revert).*(in progress)|already in progress/.test(s)) {
    return new GitServiceError('operation-in-progress', `${context}失败:仓库里有进行中的操作,请先完成或中止。`, detail);
  }
  const first = detail.split('\n').find((line) => line.trim() !== '') ?? '未知错误';
  return new GitServiceError('internal', `${context}失败:${first}`, detail);
}

/**
 * 内容超过**单次响应上限**:拒绝时带上真实大小与上限。
 *
 * 为什么单独一个类(而不是一个 `GitServiceError` 加一句话):路由要把它转成
 * 机器可读的 HTTP 形状(`413` + `X-Dsh-Git-Size` / `X-Dsh-Git-Limit`),
 * 界面才能说「3.2 MB,上限 2 MB」而不是把上限当大小播出去。
 */
export class BlobTooLargeError extends GitServiceError {
  public readonly size: number;
  public readonly limit: number;
  public constructor(size: number, limit: number, what: string) {
    super(
      'bad-request',
      `${what}有 ${formatByteSize(size)},超过单次上限 ${formatByteSize(limit)}。`,
      `size=${size} limit=${limit}`,
    );
    this.name = 'BlobTooLargeError';
    this.size = size;
    this.limit = limit;
  }
}

/** 内容所在的位置:工作区磁盘上的文件,还是某个对象(rev/index)。 */
export type BlobLocation =
  | { readonly kind: 'worktree'; readonly target: string; readonly mtimeMs: number }
  | { readonly kind: 'revision'; readonly sha: string };

/** 一次内容请求的**元数据**(不含内容字节)。 */
export interface IBlobInfo {
  readonly location: BlobLocation;
  readonly size: number;
  /** `ETag` 的裸值(不含引号):修订 = blob sha;工作区 = `size-mtime`。 */
  readonly etag: string;
  /** 只有「完整对象名」才是不可变的(见 `core/blob.ts` 的 `isImmutableRev`)。 */
  readonly immutable: boolean;
  readonly contentType: string;
}

/**
 * 一次内容请求的**游标**:响应头已经定好,字节还没取。
 *
 * 分成「先算头、再取字节」两段是刻意的:`HEAD` 与 `304` 走到这里就返回,
 * **一个字节都不读**(包括不读超大文件)。
 */
export interface IBlobRead {
  readonly info: IBlobInfo;
  /** 实体总字节数。 */
  readonly total: number;
  /** 本次要回的闭区间。 */
  readonly start: number;
  readonly end: number;
  /** true ⇒ 回 `206`(请求带了合法的 `Range`)。 */
  readonly partial: boolean;
  /** true ⇒ 回 `416`(区间落在实体之外);`read()` 会抛错,不要调用。 */
  readonly unsatisfiable: boolean;
  /** 真正把字节取出来(≤ `MAX_BLOB_BYTES`);只能调用一次。 */
  read(): Promise<Uint8Array>;
}

/** 一次提交请求。 */
export interface CommitRequest {
  message: string;
  description?: string;
  amend?: boolean;
  noVerify?: boolean;
  signoff?: boolean;
  allowEmpty?: boolean;
  /** 参与提交的路径;空数组 = 直接提交当前索引。 */
  paths: readonly string[];
}

export class GitService {
  /**
   * 内容类型的**记忆表**:同一个 blob sha / 同一个 worktree 版本只嗅探一次。
   *
   * 为什么需要:每个响应都要 `Content-Type`,而嗅探要读内容开头 —— 不缓存的话
   * `Range` 的每一段都会多一次 git 调用。上限 256 条(本地仓库里同时打开的
   * diff 数量级),满了就丢最早的一条。
   */
  private readonly contentTypeCache = new Map<string, string>();

  constructor(
    private readonly runner: GitRunner,
    private readonly options: GitServiceOptions,
  ) {}

  // ---------- 基础设施 ----------

  /** 目录 → 仓库根;不是仓库返回 null。 */
  async repoRoot(path: string): Promise<string | null> {
    // 类型守卫:repoRoot 是公开方法且位于 gate 之前,调用方传错类型时不该一路
    // 走到 spawn 报 ERR_INVALID_ARG_TYPE(那个错误完全看不出是哪个参数错了)。
    if (typeof path !== 'string' || path.trim() === '') {
      return null;
    }
    const res = await this.runner.run(topLevelArgv(path), path, {});
    if (res.exitCode !== 0) {
      return null;
    }
    const root = firstLine(res.stdout);
    return root === '' ? null : root;
  }

  /** 门:路径必须落在用户显式添加过的仓库清单里。 */
  private async gate(path: string): Promise<string> {
    const root = await this.repoRoot(path);
    if (root === null) {
      throw new GitServiceError('not-a-repository', '这个目录不是 git 仓库。');
    }
    if (!this.options.allowedRoots().includes(root)) {
      throw new GitServiceError('workspace-unknown', '这个仓库还没有添加到 dsh-git,请先在仓库下拉里添加它。');
    }
    return root;
  }

  /**
   * 记一条**可诊断的**警告 —— 上游 `log.warn` 的宿主等价物。
   *
   * 为什么需要这个接缝而不是直接 `console.warn`:本仓 host 半的日志只走一条路
   * (`src/index.ts:296` 的 `host.logger?.warn`),那条路会带上 `[dsh-git]` 前缀并可被
   * 宿主转发/落盘;`console.warn` 绕开它,在真实部署里既没有前缀也不一定可见。
   * 而探针正是靠这个接缝**证明警告真的产生了**(见 `docs/probes/pull-rebase-probe.mjs`
   * 的 4d:把 `deps.log` 换成记录器,断言拿到那条上游原文)。
   *
   * 省略 `log` 时**静默**丢弃:与上游「日志器缺席」同义,不是为了掩盖 ——
   * 目前唯一的调用点是「配置里有个不可识别的 pull.rebase 值」,丢日志不影响功能。
   */
  private warn(message: string): void {
    try {
      this.options.log?.(message);
    } catch {
      /* 日志器自己抛错不该把拉取带崩(与 src/index.ts:297 同一取舍)。 */
    }
  }

  private async must(
    argv: readonly string[],
    cwd: string,
    context: string,
    opts: { input?: string; env?: Readonly<Record<string, string>>; timeoutMs?: number; allow?: readonly number[] } = {},
  ): Promise<GitRunResult> {
    const spec: Parameters<GitRunner['run']>[2] = {};
    if (opts.input !== undefined) {
      spec.input = opts.input;
    }
    if (opts.env !== undefined) {
      spec.env = opts.env;
    }
    if (opts.timeoutMs !== undefined) {
      spec.timeoutMs = opts.timeoutMs;
    }
    const res = await this.runner.run(argv, cwd, spec);
    const allow = opts.allow ?? [0];
    if (res.exitCode === null || !allow.includes(res.exitCode)) {
      throw classifyGitFailure(res.stderr, context);
    }
    return res;
  }

  /** 允许失败的可选调用(读配置、探测等)。 */
  private async optional(
    argv: readonly string[],
    cwd: string,
    opts: { binary?: boolean } = {},
  ): Promise<GitRunResult> {
    return this.runner.run(argv, cwd, opts.binary === true ? { binary: true } : {});
  }

  private credentialEnv(): Readonly<Record<string, string>> | undefined {
    return this.options.credentialEnv?.();
  }

  private async gitDir(root: string): Promise<string | null> {
    const res = await this.optional(['rev-parse', '--git-dir'], root);
    if (res.exitCode !== 0) {
      return null;
    }
    const p = firstLine(res.stdout);
    if (p === '') {
      return null;
    }
    return isAbsolute(p) ? p : join(root, p);
  }

  /**
   * 修订名(提交号 / `HEAD~1` / 分支名)的字符串层校验。
   *
   * 用既有的 {@link isSafeRev}:非空、不以 `-` 开头、无空白与 `:`。
   * 这一道是**纵深防御**而不是唯一防线 —— argv 里每个 ref 都同时落在
   * `--end-of-options` 之后(`core/git-argv.ts` 顶部约定),所以「以 `-` 开头的名字」
   * 本来就进不了选项位置。这里挡的是更早、更可读的报错(`bad-request` 而不是 git 的
   * `unknown revision`)。
   * @param rev - 用户给的修订名。
   * @param what - 报错里用的名字(「提交号」「标签目标」等)。
   */
  private assertValidRev(rev: string, what: string): void {
    if (!isSafeRev(rev)) {
      throw new GitServiceError('bad-request', `${what}不合法:${rev}`);
    }
  }

  // ---------- 状态 ----------

  async status(path: string): Promise<RepoStatus> {
    const root = await this.gate(path);
    const statusRes = await this.must(statusArgv(), root, '读取状态');
    const parsed = parseStatus(statusRes.stdout);
    return buildRepoStatus({ root, parsed, operation: await this.operationMarkers(root) });
  }

  /** rebase/merge/cherry-pick/revert 标记读磁盘(照 Desktop,不依赖 git 命令输出)。 */
  private async operationMarkers(root: string): Promise<RepoStatus['operation']> {
    const dir = await this.gitDir(root);
    if (dir === null) {
      return null;
    }
    const [mergeHead, rebaseHead, rebaseMerge, rebaseApply, cherryPickHead, revertHead] = await Promise.all([
      exists(join(dir, 'MERGE_HEAD')),
      exists(join(dir, 'REBASE_HEAD')),
      exists(join(dir, 'rebase-merge')),
      exists(join(dir, 'rebase-apply')),
      exists(join(dir, 'CHERRY_PICK_HEAD')),
      exists(join(dir, 'REVERT_HEAD')),
    ]);
    return operationFromMarkers({
      mergeHead, rebaseHead, rebaseMerge: rebaseMerge || rebaseApply, cherryPickHead, revertHead,
    });
  }

  async syncState(path: string): Promise<SyncState> {
    const status = await this.status(path);
    const remotesRes = await this.must(remoteListArgv(), status.root, '读取远端');
    const remotes = parseRemotes(remotesRes.stdout);
    const tagsRes = await this.optional(tagListArgv(), status.root);
    const tagCount = tagsRes.exitCode === 0 ? parseTags(tagsRes.stdout).length : 0;
    /*
     * 唯一的 `pull.rebase` 读取点(照上游 `git-store.ts:406` 在 status/refresh 路径上
     * 调一次 `checkPullWithRebase()`)。`readPullWithRebase` **自己**就是那条四路判定,
     * 所以这里没有第二处解释(改前 `pull()` 那条 `pullPrefersRebase` 的 git 真值表
     * 已并入它,见那个方法的注释)。
     */
    const pullWithRebase = await this.readPullWithRebase(status.root);
    return {
      ahead: status.ahead,
      behind: status.behind,
      upstream: status.upstream,
      remotes,
      canForcePush: status.upstream !== null && !status.detached && !status.unborn,
      lastFetchedAt: await this.lastFetchedAt(status.root),
      tagCount,
      /*
       * 「按钮文案与执行同源」的**上半**:这一次读出的值随载荷回到客户端,
       * 客户端既用它渲染 `PushPullButton` 的 `pullWithRebase` prop,也把它随拉取
       * 请求带回来(`api.pull` 的 `rebase` ⇒ 本文件 `pull()` 的 `opts.rebase`)。
       * 于是「文案」与「执行」不可能各自读到一个不同的值。
       *
       * `undefined`(没配置 / 值不可识别)时**刻意省略这个键**,而不是写 `false` ——
       * 见 `core/types.ts` 的 `SyncState.pullWithRebase` 注释(上游 `app-state.ts:733`
       * 的 `undefined` 语义是「走 git 自己的默认行为」,不是「明确不要变基」)。
       */
      ...(pullWithRebase === undefined ? {} : { pullWithRebase }),
    };
  }

  /** 上次抓取时间:FETCH_HEAD 的 mtime。 */
  private async lastFetchedAt(root: string): Promise<string | null> {
    const dir = await this.gitDir(root);
    if (dir === null) {
      return null;
    }
    try {
      const s = await stat(join(dir, 'FETCH_HEAD'));
      return new Date(s.mtimeMs).toISOString();
    } catch {
      return null;
    }
  }

  // ---------- diff ----------

  async diff(input: {
    path: string;
    file: string;
    staged?: boolean;
    untracked?: boolean;
    commit?: string;
    /** 用 `git diff -w` 重跑,忽略纯空白改动。 */
    ignoreWhitespace?: boolean;
  }): Promise<DiffResult> {
    const root = await this.gate(input.path);
    const ws = input.ignoreWhitespace === true;
    const argv = input.commit !== undefined
      ? diffCommitArgv(input.commit, input.file, { ignoreWhitespace: ws })
      : input.untracked === true
        ? diffUntrackedArgv(input.file)
        : input.staged === true
          ? diffStagedArgv(input.file, { ignoreWhitespace: ws })
          // 未暂存 = index → 工作区(两行制;与 Desktop 的分歧见 git-argv 注释)
          : diffUnstagedArgv(input.file, { ignoreWhitespace: ws });
    // --no-index 对未跟踪文件在「无差异」时返回 1,不是错误,故用 optional。
    const res = await this.optional(argv, root);
    // **收集器截尾 = 静默错内容**:它保留的是尾部,于是「>4MiB 的补丁」会以
    // 「从中间开始的合法补丁」交出去 —— 渲染层不会报错,只是显示了错的差异
    // (docs/design.md §10.8 记过这条:解析异常又被吞掉 ⇒ 用户看到「没有可显示的差异」)。
    // 现在响亮度由 `stdoutTruncated` 决定,而它在文本路径上也如实上报了。
    if (res.stdoutTruncated === true) {
      throw new BlobTooLargeError(res.stdoutTotalBytes ?? res.stdout.length, OUTPUT_CAP_BYTES, '这个文件的差异');
    }
    const patch = res.stdout;
    const statsArgv = input.commit !== undefined
      ? diffCommitNumstatArgv(input.commit, input.file, { ignoreWhitespace: ws })
      : diffNumstatArgv(input.staged === true, input.file, { ignoreWhitespace: ws });
    const statsRes = await this.optional(statsArgv, root);
    const row = parseNumstat(statsRes.stdout).find((r) => r.path === input.file);
    return {
      path: input.file,
      patch,
      additions: row?.additions ?? countPatchLines(patch, '+'),
      deletions: row?.deletions ?? countPatchLines(patch, '-'),
      binary: row?.binary ?? /^Binary files /m.test(patch),
      untracked: input.untracked === true,
    };
  }

  // ---------- 暂存 / 丢弃 / 提交 ----------

  async stage(path: string, files: readonly string[]): Promise<void> {
    if (files.length === 0) {
      return;
    }
    const root = await this.gate(path);
    await this.must(addArgv(files), root, '暂存文件');
  }

  async unstage(path: string, files: readonly string[]): Promise<void> {
    if (files.length === 0) {
      return;
    }
    const root = await this.gate(path);
    await this.must(resetPathsArgv(files), root, '取消暂存');
  }

  /**
   * 丢弃改动,**按文件分流**。
   *
   * 以前只按「整批是否全是未跟踪」二选一,混批(1 个已跟踪 + 1 个未跟踪)会走
   * `checkout --`,于是未跟踪文件**原地留下**,界面却提示「已丢弃改动」。
   * 现在逐个文件按各自的状态选择 `git clean` 或 `checkout --`。
   * @param path - 仓库根路径。
   * @param files - 要丢弃的仓库内相对路径。
   * @param opts.untrackedPaths - 其中属于未跟踪的那些路径(`git clean` 分支)。
   */
  async discard(path: string, files: readonly string[], opts: { untrackedPaths?: readonly string[] } = {}): Promise<void> {
    if (files.length === 0) {
      return;
    }
    const root = await this.gate(path);
    const untracked = new Set(opts.untrackedPaths ?? []);
    const cleaner = files.filter((f) => untracked.has(f));
    const tracker = files.filter((f) => !untracked.has(f));
    if (cleaner.length > 0) {
      await this.must(cleanArgv(cleaner), root, '删除未跟踪文件');
    }
    if (tracker.length > 0) {
      await this.must(checkoutPathsArgv(tracker), root, '丢弃改动');
    }
  }

  /**
   * 行级/块级部分暂存。
   *
   * 流程照 GitHub Desktop:取该文件的 diff → 解析 → 按选区**重建补丁**
   * (用从 Desktop 复制的 `patch-formatter`,见 core/partial-stage.ts)
   * → `apply --cached --unidiff-zero --whitespace=nowarn -`。
   *
   * 补丁由 host 自己重新取,不接受客户端上传的补丁文本。
   * @param path - 仓库根路径。
   * @param input.file - 仓库内相对路径。
   * @param input.kind - 文件状态(决定新文件/未跟踪的补丁头)。
   * @param input.selection - 行选区(索引 = patch 内的绝对行号)。
   */
  async stageLines(path: string, input: {
    file: string;
    kind: FileStatusKind;
    selection: LineSelectionSpec;
  }): Promise<{ staged: boolean }> {
    const root = await this.gate(path);
    if (isSelectionEmpty(input.selection)) {
      // 什么都没选:先取消暂存这个文件,避免留下上一次的选区状态
      await this.must(resetPathsArgv([input.file]), root, '取消暂存');
      return { staged: false };
    }
    const diff = await this.diff({ path: root, file: input.file });
    const parsed = parseRawDiff(diff.patch);
    if (parsed.isBinary) {
      throw new GitServiceError('bad-request', '二进制文件不能按行暂存,请整文件暂存。');
    }
    if (parsed.hunks.length === 0) {
      throw new GitServiceError('bad-request', '这个文件没有可选的改动行。');
    }
    const patch = buildPartialPatch(input.file, input.kind, parsed, input.selection);
    await this.must(applyCachedArgv(), root, '暂存所选行', { input: patch });
    return { staged: true };
  }

  /** 部分暂存:重建的补丁走 stdin。 */
  async applyPatchToIndex(path: string, patch: string): Promise<void> {
    const root = await this.gate(path);
    await this.must(applyCachedArgv(), root, '暂存所选行', { input: patch });
  }

  /**
   * 行级/块级**丢弃**:把补丁**反向**应用到工作区(不是 index)。
   *
   * 与 {@link applyPatchToIndex} 是同一个操作的两个方向:
   *  - 暂存 = 把「工作区 → index」这段改动**正向**写进 index(`apply --cached`);
   *  - 丢弃 = 把同一段改动**反向**从工作区里撤掉(`apply --reverse`,**不带 `--cached`**)。
   *
   * 上游:`discardChangesFromSelection`(`references/desktop/app/src/lib/git/apply.ts:102-120`)。
   * 上游**不带** `--reverse` —— 它在 `formatPatchToDiscardChanges`
   * (`lib/patch-formatter.ts:251-328`)里就把 `+`/`-` 两侧交换好了,于是正向 `apply` 等于反向应用。
   * 我们按冻结的接口契约收**客户端上传的补丁文本**并在 host 侧反向应用,两条路等价;
   * 复用仓内**既有的** {@link applyReverseArgv}(`core/git-argv.ts`,此前无人调用)。
   *
   * ⚠️ **方向是调用方的责任**:送进来的补丁必须是 `git diff` **正向**的那份
   * (新内容在 `+` 侧)。若调用方送了已经交换过两侧的补丁,这里的 `--reverse`
   * 会把它**再改回来**(等于把改动写回去而不是丢弃),而 `git apply` 不会报错。
   * host 无法从文本判断方向,所以这条只能由契约约束。
   *
   * 安全性:`git apply` 自己就拒绝仓库外的路径(实测 `../` 与绝对路径都回 rc=1
   * `error: …: No such file or directory`,除非显式 `--unsafe-paths`,我们不给),
   * `file` 再过一道 {@link assertRepoRelativePath},并核对补丁头确实提到这个文件。
   * @param path - 仓库路径。
   * @param file - 仓库内相对路径(补丁头里应以 `a/<file>` / `b/<file>` 出现)。
   * @param patch - `git diff` 正向的统一 diff 文本。
   */
  async discardLines(path: string, file: string, patch: string): Promise<void> {
    // 顺序与 `showFile` / `stageLines` 一致:先过 gate(仓库必须在清单里),再做路径校验。
    const root = await this.gate(path);
    this.assertRepoRelativePath(file);
    // 补丁头一致性:补丁自带 `+++ b/<路径>`,git 只认它 —— `file` 不参与应用。
    // 于是「丢弃 A 却传了 B 的补丁」会**静默丢掉 B 的改动**。丢弃是不可逆动作,
    // 宁可在这一步响亮地拒绝。比对范围只取 `@@` 之前的头部(正文里出现同名字符串
    // 不算数),且只要求「提到过这个文件」——对新增/删除文件(`/dev/null` 一侧)
    // 同样成立,不引入格式假设。
    const bodyStart = patch.indexOf('\n@@');
    const head = bodyStart < 0 ? patch : patch.slice(0, bodyStart);
    if (!head.includes(file)) {
      throw new GitServiceError('bad-request', '补丁与要丢弃的文件对不上,已拒绝执行。');
    }
    await this.must(applyReverseArgv(), root, '丢弃所选行', { input: patch });
  }

  /** 提交:索引先与勾选状态对齐,再用临时文件承载消息。 */
  async commit(path: string, request: CommitRequest): Promise<{ sha: string; subject: string }> {
    const root = await this.gate(path);
    // **不要**在这里 reset + add 重建索引。
    //
    // 客户端的「已暂存」集合本来就来自索引(porcelain 的 X 位),所以索引已经等于用户
    // 的意图;再 `reset .` + `add <paths>` 只会把行级/块级的部分暂存放在索引里的内容
    // 按整文件重新快照一遍 —— 用户精心挑的那几行会被静默改成整个文件。
    // (GitHub Desktop 之所以要重建,是因为它的勾选状态是客户端模型而非索引;
    //  见 app/src/lib/git/commit.ts:15-31。我们的模型是索引即真相,所以直接提交。)
    void request.paths;
    const message = [request.message.trim(), (request.description ?? '').trim()]
      .filter((s) => s !== '')
      .join('\n\n');
    if (message === '' && request.amend !== true) {
      throw new GitServiceError('bad-request', '提交摘要不能为空。');
    }
    // 消息文件必须落在仓库内:git 拒绝读取仓库外的 -F 文件。
    // 放在 .git 目录并传绝对路径:既不会被工作区状态看到,也不会被 git 当成 pathspec。
    const gitDir = await this.gitDir(root);
    if (gitDir === null) {
      throw new GitServiceError('not-a-repository', '找不到 .git 目录。');
    }
    const stamp = randomBytes(6).toString('hex');
    const file = join(gitDir, `.dsh-git-msg-${stamp}.txt`);
    try {
      await writeFile(file, `${message}\n`, 'utf8');
      // commitArgv 收尾是 ['-F', '-'];换成绝对路径,消息内容不进 argv。
      // 直接从构造器拿带文件路径的 argv(不再「先 -F - 再 strip」,那样在带
      // --amend 等 flag 时会漏替换,留下两个 -F)。
      const argv = commitArgv({
        amend: request.amend === true,
        noVerify: request.noVerify === true,
        signoff: request.signoff === true,
        allowEmpty: request.allowEmpty === true,
        messageFile: file,
      });
      await this.must(argv, root, '提交');
      const sha = firstLine((await this.must(['rev-parse', 'HEAD'], root, '读取提交')).stdout);
      const subject = firstLine((await this.optional(['log', '-1', '--format=%s'], root)).stdout);
      return { sha, subject };
    } finally {
      await rm(file, { force: true });
    }
  }

  /**
   * 撤销一次提交。
   *
   * 行为照 GitHub Desktop 的 undo-commit:
   *  - 非首个提交 → `reset --mixed <parent>`:改动回到工作区,**不留在暂存区**;
   *  - 首个提交 → 先 checkout 回被它删掉的文件,再 `update-ref -d HEAD`(让分支回到
   *    未出生),最后 `rm --cached -r -f .` 让所有文件变回未跟踪(`git-store.ts:673-711`)。
   * @param path - 仓库根路径。
   * @param sha - 要撤销的提交(必须是 HEAD)。
   * @returns 被撤销提交的摘要与描述,供界面回填表单。
   */
  async undoCommit(path: string, sha: string): Promise<{ subject: string; description: string }> {
    const root = await this.gate(path);
    const status = await this.status(root);
    if (status.headSha !== sha) {
      throw new GitServiceError('bad-request', '只能撤销最近一次提交(HEAD)。');
    }
    const commits = parseLog((await this.must(
      logArgv({ limit: 1, ref: 'HEAD' }), root, '读取提交',
    )).stdout);
    const commit = commits[0];
    const subject = commit?.subject ?? '';
    const description = commit?.body ?? '';

    const parents = (await this.must(['rev-list', '--parents', '-n', '1', 'HEAD'], root, '读取父提交')).stdout.trim().split(' ');
    const parent = parents[1];

    if (parent === undefined) {
      // 第一个提交:把被删掉的文件恢复到工作区,再删 ref、清空索引
      const deletedStatus = await this.must(
        ['diff', '--name-only', '--diff-filter=D', '-z', '--end-of-options', 'HEAD', '--'],
        root, '查找被删除的文件',
      );
      // `must()` 返回的是整条运行结果(`GitRunResult`),不是 stdout 字符串 ——
      // 这里漏了 `.stdout`,运行期是 `undefined.split`,即「撤销第一个提交」时
      // 抛 TypeError(而它恰好是 `--diff-filter=D` 有删除文件的那条路径)。
      const deleted = deletedStatus.stdout.split('\0').filter((x) => x !== '');
      if (deleted.length > 0) {
        await this.must(checkoutPathsArgv(deleted), root, '恢复被删除的文件');
      }
      await this.must(updateRefDeleteArgv('HEAD', 'Reverting first commit'), root, '删除首次提交');
      await this.must(rmCachedAllArgv(), root, '清空索引');
    } else {
      await this.must(resetMixedArgv(parent), root, '撤销提交');
    }
    return { subject, description };
  }

  // ---------- 本地文件树(Code 页签) ----------

  /**
   * 列出工作区里的全部文件路径(仓库内相对路径,遵守 .gitignore)。
   *
   * @param path - 仓库路径。
   * @param limit - 最多返回多少条(超出即标记 truncated)。默认 10000:10k 路径约 400KB
   *   JSON,走本机回环没有压力,而客户端只渲染展开的行。
   * @returns 文件路径列表与是否被截断。
   */
  async listFiles(path: string, limit = 10_000): Promise<{ files: string[]; truncated: boolean }> {
    const root = await this.gate(path);
    const res = await this.must(lsFilesArgv(), root, '列出文件');
    const all = res.stdout.split('\0').filter((entry) => entry !== '');
    // git 的输出顺序是「先全部未跟踪、再全部已跟踪」,**不是**全局有序。
    // 先排序再截断,否则截断会系统性地只保留未跟踪文件、丢掉已跟踪文件。
    const sorted = [...all].sort();
    const files = sorted.slice(0, limit);
    // 两道截断信号:条数超限,或 stdout 撞上 git-runner 的输出上限。
    // 后者以前用 `stdout.length >= 4MiB` 当代理(保留的尾部正好等于上限),
    // 现在直接用收集器如实上报的 `stdoutTruncated` —— 上限值变了它也不会失准。
    const truncated = sorted.length > limit || res.stdoutTruncated === true;
    return { files, truncated };
  }

  // ---------- 内容取数路径(唯一的上限、唯一的真相) ----------

  /**
   * 内容取数的**共享路径守卫**(第一道闸)。
   *
   * 绝对路径、`..` 穿越、`.git/` 一律拒绝。`fileText` 走磁盘、`showFile` 走对象,
   * 但**字符串层面的守卫是同一份** —— 写在两处必然漂移(上一版就是这样:
   * `fileText` 只按 `/` 切、`showFile` 按 `[\\/]+` 切,Windows 分隔符上不一致)。
   * @param file - 仓库内相对路径。
   */
  private assertRepoRelativePath(file: string): void {
    if (typeof file !== 'string' || file === '' || isAbsolute(file)) {
      throw new GitServiceError('bad-request', '需要一个仓库内的相对文件路径。');
    }
    const parts = file.split(/[\\/]+/).filter((one) => one !== '');
    if (parts.includes('..')) {
      throw new GitServiceError('bad-request', '该路径不在仓库内。');
    }
    if (parts[0] === '.git') {
      throw new GitServiceError('bad-request', '不能读取 .git 目录内的文件。');
    }
  }

  /**
   * 工作区文件的**磁盘三道闸**:词法包含 → 普通文件 → `realpath` 仍在仓库内。
   *
   * `realpath` 那一道是必需的:词法包含挡不住仓库内的符号链接指向仓库外
   * (`SystemService.guard` 只做词法比较,那里够用,这里不够)。
   * @param root - 仓库根(canonical)。
   * @param file - 仓库内相对路径(已过 {@link assertRepoRelativePath})。
   * @returns 目标绝对路径与 stat;文件不存在时回 `null`(调用方按 missing 处理)。
   */
  private async worktreeFile(
    root: string,
    file: string,
  ): Promise<{ target: string; size: number; mtimeMs: number } | null> {
    this.assertRepoRelativePath(file);
    const target = resolve(root, file);
    if (target !== root && !target.startsWith(root + sep)) {
      throw new GitServiceError('bad-request', '该路径不在仓库内。');
    }
    let info;
    try {
      info = await lstat(target);
    } catch {
      return null;
    }
    if (!info.isFile()) {
      throw new GitServiceError('bad-request', '只能读取普通文件。');
    }
    const realRoot = await realpath(root);
    const realTarget = await realpath(target);
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
      throw new GitServiceError('bad-request', '该路径经符号链接指向了仓库外,拒绝读取。');
    }
    return { target, size: info.size, mtimeMs: info.mtimeMs };
  }

  /** 只读文件开头 `count` 字节(**不整份读进内存**)。 */
  private async readWorktreeHead(target: string, count: number): Promise<Uint8Array> {
    if (count <= 0) {
      return new Uint8Array(0);
    }
    const fd = await openFd(target, 'r');
    try {
      const buffer = Buffer.alloc(count);
      let offset = 0;
      while (offset < count) {
        const { bytesRead } = await fd.read(buffer, offset, count - offset, offset);
        if (bytesRead <= 0) {
          break;
        }
        offset += bytesRead;
      }
      return buffer.subarray(0, offset);
    } finally {
      await fd.close();
    }
  }

  /**
   * 只读**精确区间**(工作区):`fd.read` 带偏移,不把大文件整份读进来。
   * @param target - 绝对路径。
   * @param start - 起始字节。
   * @param length - 要读多少字节。
   */
  private async readWorktreeRange(target: string, start: number, length: number): Promise<Buffer> {
    if (length <= 0) {
      return Buffer.alloc(0);
    }
    const fd = await openFd(target, 'r');
    try {
      const buffer = Buffer.alloc(length);
      let offset = 0;
      while (offset < length) {
        const { bytesRead } = await fd.read(buffer, offset, length - offset, start + offset);
        if (bytesRead <= 0) {
          break;
        }
        offset += bytesRead;
      }
      return buffer.subarray(0, offset);
    } finally {
      await fd.close();
    }
  }

  /**
   * 按对象名**流式**取一段区间:跳过 `skip` 字节,只留 `take` 字节。
   *
   * 为什么不走 `run()` 的收集模式:收集是「先把整份输出收进内存、并在 4MiB 处
   * 保留尾部」—— 对 500MB 的 blob 既白读又**错**(尾部不是我们要的区间)。
   * 管道模式下 `git cat-file blob` 的字节按顺序流过来,我们在收够之后立刻
   * 销毁管道并终止进程,内存只按区间增长。
   *
   * 宿主不提供 `'pipe'` 时**回落到拒绝**,而不是退回收集结果:宁可报「读不了这段」,
   * 也不把「从中间开始的一段」当成第 N 字节之后的内容。
   * @param root - 仓库根。
   * @param sha - blob 对象名。
   * @param skip - 跳过的字节数。
   * @param take - 要留下的字节数。
   */
  private async readRevisionRange(root: string, sha: string, skip: number, take: number): Promise<Buffer> {
    if (take <= 0) {
      return Buffer.alloc(0);
    }
    const open = this.runner.open;
    if (typeof open !== 'function') {
      throw new GitServiceError(
        'internal',
        '这个宿主不支持流式读取 blob,无法只取所需的一段(不会退回截断的内容)。',
      );
    }
    const stream = await open.call(this.runner, blobContentArgv(sha), root, { timeoutMs: 60_000 });
    if (stream === null) {
      throw new GitServiceError(
        'internal',
        '这个宿主不支持流式读取 blob,无法只取所需的一段(不会退回截断的内容)。',
      );
    }
    try {
      return await collectStreamRange(stream.stdout, skip, take);
    } finally {
      stream.close();
    }
  }

  private rememberContentType(key: string, value: string): string {
    this.contentTypeCache.set(key, value);
    while (this.contentTypeCache.size > 256) {
      const oldest = this.contentTypeCache.keys().next();
      if (oldest.done === true) {
        break;
      }
      this.contentTypeCache.delete(oldest.value);
    }
    return value;
  }

  /** 工作区文件的内容类型:读开头 512 字节嗅探(按 size+mtime 缓存)。 */
  private async contentTypeForWorktree(target: string, file: string, size: number, mtimeMs: number): Promise<string> {
    if (size <= 0) {
      return contentTypeFor(file, new Uint8Array(0));
    }
    const key = `w:${target}:${size}:${Math.floor(mtimeMs)}`;
    const hit = this.contentTypeCache.get(key);
    if (hit !== undefined) {
      return hit;
    }
    const head = await this.readWorktreeHead(target, 512);
    return this.rememberContentType(key, contentTypeFor(file, head));
  }

  /** 修订 blob 的内容类型:读开头 512 字节嗅探(按 sha 缓存,sha 不可变)。 */
  private async contentTypeForRevision(root: string, sha: string, file: string, size: number): Promise<string> {
    if (size <= 0) {
      return contentTypeFor(file, new Uint8Array(0));
    }
    const key = `r:${sha}`;
    const hit = this.contentTypeCache.get(key);
    if (hit !== undefined) {
      return hit;
    }
    const head = await this.readRevisionRange(root, sha, 0, Math.min(size, 512));
    return this.rememberContentType(key, contentTypeFor(file, head));
  }

  /**
   * **量大小**(不取内容)—— 「太大」必须在**任何内容被读进内存之前**决定。
   *
   * 这是整个设计的枢纽。旧代码是「先取完内容、再判大小」,于是判定权实际落在
   * runner 的收集器上,而它保留**尾部** ⇒ 超限时交回的是「从中间开始的残缺内容」。
   *
   * @param path - 仓库路径(过 gate)。
   * @param rev - `undefined`/`''` = 工作区磁盘;`'index'` = 索引;其余 = 修订名。
   * @param file - 仓库内相对路径。
   * @returns 元数据;该版本下不存在这个路径时回 `null`(正常结果,不是错误)。
   */
  public async blobInfo(path: string, rev: string | undefined, file: string): Promise<IBlobInfo | null> {
    return this.resolveBlob(await this.gate(path), rev, file);
  }

  /**
   * 量大小的**内部实现**(root 已 gate)。
   *
   * 分成两半是为了让一次请求只 gate 一次 —— `git rev-parse --show-toplevel`
   * 每次都要跑一个子进程,一条内容请求里跑三遍是纯浪费。
   * @param root - 已 gate 的仓库根。
   * @param rev - 修订(见 {@link blobInfo})。
   * @param file - 仓库内相对路径。
   */
  private async resolveBlob(root: string, rev: string | undefined, file: string): Promise<IBlobInfo | null> {
    if (rev === undefined || rev === '') {
      const info = await this.worktreeFile(root, file);
      if (info === null) {
        return null;
      }
      return {
        location: { kind: 'worktree', target: info.target, mtimeMs: info.mtimeMs },
        size: info.size,
        etag: `${info.size}-${Math.floor(info.mtimeMs)}`,
        immutable: false,
        contentType: await this.contentTypeForWorktree(info.target, file, info.size, info.mtimeMs),
      };
    }
    if (rev !== INDEX_REV && !isSafeRev(rev)) {
      throw new GitServiceError('bad-request', '修订名不合法。');
    }
    // 路径规范化:git 的路径规范一律用 `/`(客户端从 porcelain 拿到的也是 `/`)。
    const target = file.split('\\').join('/');
    let sha: string;
    let size: number;
    if (rev === INDEX_REV) {
      const listed = await this.optional(blobIndexEntryArgv(target), root);
      if (listed.exitCode !== 0) {
        throw new GitServiceError('git-failed', '读取索引失败。', listed.stderr.trim().slice(0, 400));
      }
      const entry = parseIndexEntry(listed.stdout);
      if (entry === null || entry.path !== target) {
        return null;
      }
      sha = entry.sha;
      if (!isSafeObjectName(sha)) {
        throw new GitServiceError('internal', 'git 没有给出可用的对象名。');
      }
      const sized = await this.optional(blobSizeArgv(sha), root);
      if (sized.exitCode !== 0) {
        throw new GitServiceError('git-failed', '读取该版本的文件大小失败。', sized.stderr.trim().slice(0, 400));
      }
      size = Number(firstLine(sized.stdout));
    } else {
      // 退出码只反映「修订是否可用」;空输出才是「这个版本里没有这个路径」。
      const listed = await this.optional(blobTreeEntryArgv(rev, target), root);
      if (listed.exitCode !== 0) {
        throw new GitServiceError('git-failed', `找不到修订 ${rev}。`, listed.stderr.trim().slice(0, 400));
      }
      const entry = parseTreeEntry(listed.stdout);
      if (entry === null || entry.path !== target) {
        return null;
      }
      if (entry.type !== 'blob') {
        throw new GitServiceError('bad-request', '这个路径在这个版本里不是普通文件。');
      }
      sha = entry.sha;
      size = entry.size;
    }
    if (!Number.isFinite(size) || size < 0) {
      throw new GitServiceError('internal', `git 给出了非法的大小:${String(size)}`);
    }
    return {
      location: { kind: 'revision', sha },
      size,
      etag: sha,
      immutable: isImmutableRev(rev),
      contentType: await this.contentTypeForRevision(root, sha, file, size),
    };
  }

  /**
   * 打开一次内容请求:**先算响应头,再(可选)取字节**。
   *
   * 为什么做成「游标」而不是「先 `blobInfo` 再 `readBlob`」:后者要把
   * `rev:path` 解析、量大小、嗅探类型各做两遍(每条内容请求多 3 个子进程),
   * 而两份元数据之间引用还可能移动(量到的大小与读到的内容不是同一份)。
   *
   * 三条不变量:
   *  1. **没有 `Range`** 且 `size > MAX_BLOB_BYTES` ⇒ 抛 {@link BlobTooLargeError}
   *     (带真实大小与上限),**一个字节都不读**;
   *  2. **有 `Range`** ⇒ 只读那一段;请求的段长超过上限也拒绝(响应体永远 ≤ 上限);
   *  3. `read()` 只在真的要回实体时被调用 —— `HEAD` 与 `304` **一个字节都不读**。
   *
   * 于是**永远不存在「截断的响应体」**:要么完整、要么区间精确、要么带数字拒绝。
   *
   * @param path - 仓库路径。
   * @param rev - 见 {@link blobInfo}。
   * @param file - 仓库内相对路径。
   * @param rangeHeader - 原始 `Range` 头的值(没有就传 null)。解析在**这里**做,
   *   因为只有这里知道实体总长度。
   * @returns 游标;路径不存在回 `null`。
   */
  public async openBlob(
    path: string,
    rev: string | undefined,
    file: string,
    rangeHeader: string | null = null,
  ): Promise<IBlobRead | null> {
    const root = await this.gate(path);
    const info = await this.resolveBlob(root, rev, file);
    if (info === null) {
      return null;
    }
    const total = info.size;
    const parsed = parseRangeHeader(rangeHeader, total);
    if (parsed !== null && parsed.kind === 'unsatisfiable') {
      return {
        info,
        total,
        start: 0,
        end: Math.max(total - 1, 0),
        partial: false,
        unsatisfiable: true,
        read: () => Promise.reject(new GitServiceError('bad-request', '请求的区间超出文件长度。')),
      };
    }
    // 语法不合法的 Range 按 RFC 当「没有 Range」(回 200 整份)。
    // 但整份仍然受上限约束,下面那条判定照旧生效。
    const okRange = parsed !== null && parsed.kind === 'ok' ? parsed : null;
    const ranged = okRange !== null;
    if (!ranged && total > MAX_BLOB_BYTES) {
      // 决策点在**取内容之前** —— 收集器的尾部截断因此根本无从发生。
      throw new BlobTooLargeError(total, MAX_BLOB_BYTES, '这个文件');
    }
    const start = okRange === null ? 0 : okRange.start;
    const end = okRange === null ? Math.max(total - 1, 0) : okRange.end;
    const length = total === 0 ? 0 : end - start + 1;
    if (length > MAX_BLOB_BYTES) {
      throw new BlobTooLargeError(length, MAX_BLOB_BYTES, '这一次要取的范围');
    }
    return {
      info,
      total,
      start,
      end: total === 0 ? 0 : end,
      partial: ranged,
      unsatisfiable: false,
      read: async (): Promise<Uint8Array> => {
        if (total === 0) {
          return new Uint8Array(0);
        }
        // 走哪条路按「要不要整份」决定,不按大小猜:
        //  - 整份且 ≤ 上限 ⇒ 收集模式(snapshot 的字节,任何宿主都支持,一次调用);
        //  - 否则 ⇒ 精确区间(工作区 `fd.read` 带偏移 / 修订走 stdout 管道)。
        const bytes = !ranged && total <= MAX_BLOB_BYTES
          ? await this.readWhole(root, info)
          : info.location.kind === 'worktree'
            ? await this.readWorktreeRange(info.location.target, start, length)
            : await this.readRevisionRange(root, info.location.sha, start, length);
        if (bytes.length !== length) {
          throw new GitServiceError(
            'git-failed',
            `只读到 ${bytes.length} 字节,期望 ${length} 字节(内容可能正在变化,请重试)。`,
          );
        }
        return bytes;
      },
    };
  }

  /** 整份内容(调用方必须已经确认 `size ≤ MAX_BLOB_BYTES`)。 */
  private async readWhole(root: string, info: IBlobInfo): Promise<Buffer> {
    if (info.location.kind === 'worktree') {
      return this.readWorktreeRange(info.location.target, 0, info.size);
    }
    const res = await this.optional(blobContentArgv(info.location.sha), root, { binary: true });
    if (res.exitCode !== 0) {
      throw new GitServiceError('git-failed', '读取该版本的文件失败。', res.stderr.trim().slice(0, 400));
    }
    // 上限(2MiB)严格小于收集器上限(4MiB),所以这里**不可能**被截断;
    // 仍然判一次:万一将来谁的收集器上限变小,这行会把「残缺内容」拦成错误,
    // 而不是把它当成合法字节交出去。
    if (res.stdoutTruncated === true) {
      throw new BlobTooLargeError(res.stdoutTotalBytes ?? info.size, MAX_BLOB_BYTES, '这个文件');
    }
    const bytes = Buffer.from(res.stdoutBase64 ?? '', 'base64');
    if (bytes.length !== info.size) {
      throw new GitServiceError('git-failed', `读到 ${bytes.length} 字节,期望 ${info.size} 字节。`);
    }
    return bytes;
  }

  /**
   * 读一个工作区文件的文本内容(Code 页签右侧 / 老 host 兜底的 JSON 形状)。
   *
   * **与旧版的三点不同(都是这次传输重构的直接结果)**:
   *  1. 上限只有**一个**(`MAX_BLOB_BYTES`),不再有「文本 900KB + 二进制 2MB」两个数;
   *  2. 超限时**不读内容**、**不交截断文本**,而是回 `too-big` + 真实大小;
   *     旧的 `text.slice(0, maxBytes)` 看起来像内容,拿去做行号推导会**静默错位**;
   *  3. 二进制 base64 只剩**迁移期兜底**(`BLOB_JSON_FALLBACK_MAX_BYTES`,256KiB):
   *     新路径是 `GET /dsh-git/blob` 的原始字节(不膨胀、可 Range、可缓存)。
   *
   * `maxLines` 保留:它是**显示**上限(前 N 行 + `truncated`),不是字节上限,
   * 且返回的永远是**头部**、偏移明确。
   * @param path - 仓库根(过 gate)。
   * @param file - 仓库内相对路径。
   * @param opts.maxLines - 超过即只回前 N 行并标记,默认 3000。
   */
  async fileText(
    path: string,
    file: string,
    opts: { maxLines?: number } = {},
  ): Promise<{ kind: 'text' | 'binary' | 'too-big'; text: string; size: number; truncated: boolean; encoding?: 'utf8' | 'base64' }> {
    const root = await this.gate(path);
    this.assertRepoRelativePath(file);
    const info = await this.worktreeFile(root, file);
    if (info === null) {
      throw new GitServiceError('bad-request', '这个文件不在工作区里。');
    }
    const maxLines = opts.maxLines ?? 3000;
    if (info.size > MAX_BLOB_BYTES) {
      return { kind: 'too-big', text: '', size: info.size, truncated: true };
    }
    const head = await this.readWorktreeHead(info.target, Math.min(info.size, 8192));
    if (looksBinary(head)) {
      if (info.size > BLOB_JSON_FALLBACK_MAX_BYTES) {
        return { kind: 'too-big', text: '', size: info.size, truncated: true };
      }
      const bytes = await readFile(info.target);
      return {
        kind: 'binary',
        text: bytes.toString('base64'),
        size: bytes.length,
        truncated: false,
        encoding: 'base64',
      };
    }
    const text = await readFile(info.target, 'utf8');
    const lines = text.split('\n');
    if (lines.length > maxLines) {
      return { kind: 'text', text: lines.slice(0, maxLines).join('\n'), size: info.size, truncated: true };
    }
    return { kind: 'text', text, size: info.size, truncated: false };
  }

  /**
   * 读某个修订下的文件内容(blob)—— **老 host 契约**(JSON + base64),
   * 新代码请用 {@link openBlob}(原始字节、`Range`、缓存)。
   *
   * 与 `fileText` 的关系:后者读**工作区磁盘上的当前内容**,这里读**某个版本的内容** ——
   * 被删除的文件在磁盘上根本不存在,所以这里**刻意不做**存在性/软链检查
   * (那两项是「读磁盘」才需要的)。但**路径字符串层面的守卫必须保留**(见
   * {@link assertRepoRelativePath})。
   * @param path - 仓库根(过 gate)。
   * @param rev - 修订;`'index'` 读索引,其余用 {@link isSafeRev} 校验。
   * @param file - 仓库内相对路径。
   * @param opts.maxLines - 文本的显示上限(前 N 行 + `truncated`),默认 3000。
   */
  async showFile(
    path: string,
    rev: string,
    file: string,
    opts: { maxLines?: number } = {},
  ): Promise<{ kind: 'text' | 'binary' | 'too-big' | 'missing'; text: string; size: number; truncated: boolean; encoding?: 'utf8' | 'base64' }> {
    const root = await this.gate(path);
    const info = await this.resolveBlob(root, rev, file);
    if (info === null) {
      return { kind: 'missing', text: '', size: 0, truncated: false };
    }
    if (info.size > MAX_BLOB_BYTES) {
      return { kind: 'too-big', text: '', size: info.size, truncated: true };
    }
    const bytes = await this.readWhole(root, info);
    if (looksBinary(bytes.subarray(0, 8192))) {
      if (bytes.length > BLOB_JSON_FALLBACK_MAX_BYTES) {
        return { kind: 'too-big', text: '', size: bytes.length, truncated: true };
      }
      return { kind: 'binary', text: bytes.toString('base64'), size: bytes.length, truncated: false, encoding: 'base64' };
    }
    const text = bytes.toString('utf8');
    const maxLines = opts.maxLines ?? 3000;
    const lines = text.split('\n');
    if (lines.length > maxLines) {
      return { kind: 'text', text: lines.slice(0, maxLines).join('\n'), size: bytes.length, truncated: true };
    }
    return { kind: 'text', text, size: bytes.length, truncated: false };
  }

  // ---------- 历史 / 提交操作(本次新增) ----------
  //
  // 与「只读历史」(log / commitDetail)分开:这一组**会改仓库状态**,
  // 其中 `reset --hard` 与 revert/cherry-pick 的冲突路径还会留下副作用。
  // 每条命令的上游位置写在 `core/git-argv.ts` 的对应 argv 函数上,这里只写
  // 「上游没有、而我们这里必须处理」的那部分(校验 / 冲突状态 / 远端兜底)。

  /**
   * reset 到某个提交(`soft` / `mixed` / `hard`)。
   *
   * ⚠️ `mode: 'hard'` 会**丢弃工作区与索引里的全部未提交改动**,不可恢复。
   * 上游把确认放在界面层(`ui/dispatcher/dispatcher.ts:960-967` 只是转发),
   * 这里照做:host 不做「猜用户想不想」的事,但**把风险算出来交给路由**
   * (`routes.ts` 因此会回 `worktreeDiscarded: true`),调用方必须自己确认过再调。
   * @param path - 仓库路径。
   * @param sha - 目标修订。
   * @param mode - reset 模式(无默认值:`routes.ts` 负责把缺省解析成 `mixed`,语义不含糊)。
   */
  async resetToCommit(path: string, sha: string, mode: ResetMode): Promise<void> {
    this.assertValidRev(sha, '提交号');
    const root = await this.gate(path);
    await this.must(
      resetToCommitArgv(mode, sha),
      root,
      mode === 'hard' ? '硬重置(会丢工作区改动)' : '重置到提交',
    );
  }

  /**
   * 检出某个提交,**分离头**(`checkout --detach`)。
   *
   * 与 {@link checkout}(切分支)的区别就是「HEAD 会不会跟到一个分支上」。
   * 工作区有会被覆盖的改动时 git 自己拒绝(`would be overwritten`),
   * `classifyGitFailure` 把它折成 `merge-conflicts`。
   * @param path - 仓库路径。
   * @param sha - 目标提交。
   */
  async checkoutCommit(path: string, sha: string): Promise<void> {
    this.assertValidRev(sha, '提交号');
    const root = await this.gate(path);
    await this.must(checkoutDetachArgv(sha), root, '检出提交');
  }

  /**
   * revert 一个提交(生成一个新的反向提交)。
   *
   * 合并提交要给出「以哪一支为准」,上游取第一父(`lib/git/revert.ts:28-33`),
   * 这里靠 `rev-list --parents -n 1` 数父提交,是合并才补 `-m 1`
   * (同一个 argv 形态在 {@link undoCommit} 里已经在用)。
   *
   * **冲突时的行为**(必须说清):`git revert` 冲突时**退出码非 0**、**不建提交**,
   * 并把仓库留在 `REVERT_HEAD` 状态 —— 索引里是带冲突标记的内容。我们**不自动**
   * `--abort`(那样会把用户已经开始的手工解决一起扔掉,上游 Desktop 同样留给界面处理),
   * 于是 `must()` 抛 `merge-conflicts`,而 `status.operation` 会如实报 `revert`
   * (读 `.git/REVERT_HEAD`,见 `operationMarkers`)。收敛要靠 `git revert --continue`
   * 或 `--abort`:本插件**没有**这两条路由,得在命令行里做。
   * @param path - 仓库路径。
   * @param sha - 要 revert 的提交。
   */
  async revertCommit(path: string, sha: string): Promise<void> {
    this.assertValidRev(sha, '提交号');
    const root = await this.gate(path);
    const parents = (await this.must(
      ['rev-list', '--parents', '-n', '1', '--end-of-options', sha], root, '读取父提交',
    )).stdout.trim().split(' ');
    // 第一列是提交自身;> 2 列 ⇒ 至少两个父提交 ⇒ 合并提交。
    const merge = parents.length > 2;
    await this.must(revertArgv(sha, { merge }), root, '还原提交');
  }

  /**
   * cherry-pick 一个提交(把它的改动搬到当前分支)。
   *
   * **冲突时的行为**:与 {@link revertCommit} 同族 —— 退出码非 0、不建提交、
   * 仓库留在 `CHERRY_PICK_HEAD`(可能还有 `.git/sequencer/`),`must()` 抛
   * `merge-conflicts`,`status.operation` 如实报 `cherry-pick`。不自动 `--abort`,
   * 因为 pick 到一半的仓库里可能已经有用户手工解决的内容;`--continue` / `--abort`
   * 本插件没有路由,要在命令行里做。
   *
   * 上游会额外给 `--empty=keep`/`-m 1`(`lib/git/cherry-pick.ts:174-178`),
   * 本路由按冻结契约只 pick 一个提交,理由写在 `cherryPickArgv` 上。
   * @param path - 仓库路径。
   * @param sha - 要 pick 的提交。
   */
  async cherryPickCommit(path: string, sha: string): Promise<void> {
    this.assertValidRev(sha, '提交号');
    const root = await this.gate(path);
    await this.must(cherryPickArgv(sha), root, '拣选提交');
  }

  /**
   * 建标签。
   *
   * 上游建的是**附注标签**(`tag -a -m ''`),本路由按冻结契约建**轻量标签**,
   * 两者的可查差别写在 `tagCreateArgv` 上。
   * @param path - 仓库路径。
   * @param name - 标签名(过 ref 名校验:`assertValidRefName`)。
   * @param sha - 目标提交;缺省 = 当前 HEAD。
   */
  async createTag(path: string, name: string, sha?: string): Promise<void> {
    this.assertValidRefName(name, '标签名');
    if (sha !== undefined) {
      this.assertValidRev(sha, '标签目标');
    }
    const root = await this.gate(path);
    await this.must(tagCreateArgv(name, sha), root, '新建标签');
  }

  /**
   * 删标签(只删本地;远端标签不动)。
   * @param path - 仓库路径。
   * @param name - 标签名。
   */
  async deleteTag(path: string, name: string): Promise<void> {
    this.assertValidRefName(name, '标签名');
    const root = await this.gate(path);
    await this.must(tagDeleteArgv(name), root, '删除标签');
  }

  // ---------- 历史 ----------

  async log(
    path: string,
    opts: { limit: number; skip?: number; ref?: string },
  ): Promise<{ commits: CommitEntry[]; hasMore: boolean }> {
    const root = await this.gate(path);
    const limit = Math.min(Math.max(1, opts.limit), 200);
    const argv = logArgv({
      limit: limit + 1,
      ...(opts.skip !== undefined ? { skip: opts.skip } : {}),
      ...(opts.ref !== undefined ? { ref: opts.ref } : {}),
    });
    const res = await this.runner.run(argv, root, {});
    if (res.exitCode !== 0) {
      if (/unknown revision|does not have any commits|ambiguous argument|bad revision/i.test(res.stderr)) {
        return { commits: [], hasMore: false };
      }
      throw classifyGitFailure(res.stderr, '读取历史');
    }
    const all = parseLog(res.stdout);
    return { commits: all.slice(0, limit), hasMore: all.length > limit };
  }

  async commitDetail(path: string, sha: string): Promise<CommitDetail> {
    const root = await this.gate(path);
    const one = parseLog((await this.must(logArgv({ limit: 1, ref: sha }), root, '读取提交')).stdout);
    const commit = one[0];
    if (commit === undefined) {
      throw new GitServiceError('bad-request', `找不到提交 ${sha}。`);
    }
    const [numstatRes, nameStatusRes] = await Promise.all([
      this.optional(commitDetailStatArgv(sha), root),
      this.optional(nameStatusCommitArgv(sha), root),
    ]);
    const stats = new Map(parseNumstat(numstatRes.stdout).map((r) => [r.path, r]));
    const names = nameStatusRes.exitCode === 0 ? parseNameStatus(nameStatusRes.stdout) : [];
    const files = names.map((n) => {
      const s = stats.get(n.path);
      return {
        path: n.path,
        ...(n.oldPath !== undefined ? { oldPath: n.oldPath } : {}),
        status: n.status,
        additions: s?.additions ?? 0,
        deletions: s?.deletions ?? 0,
      };
    });
    return {
      commit,
      files,
      additions: files.reduce((sum, f) => sum + f.additions, 0),
      deletions: files.reduce((sum, f) => sum + f.deletions, 0),
    };
  }

  // ---------- 分支 / 远端 / 同步 ----------

  async branches(path: string): Promise<BranchEntry[]> {
    const root = await this.gate(path);
    return parseBranches((await this.must(branchListArgv(), root, '读取分支')).stdout);
  }

  async checkout(path: string, branch: string, opts: { createFromRemote?: string } = {}): Promise<void> {
    const root = await this.gate(path);
    if (opts.createFromRemote !== undefined) {
      await this.must(checkoutRemoteArgv(branch, opts.createFromRemote), root, '检出分支');
      return;
    }
    await this.must(checkoutBranchArgv(branch), root, '切换分支');
  }

  /**
   * 校验分支名。
   *
   * 规则来自 Desktop 的 `lib/sanitize-ref-name.ts`(它对齐 git 的
   * `git check-ref-format`):控制字符/空格/DEL/`~^:?*[\\|"<>`、`@{`、连续点、
   * 首尾点、结尾 `.lock`、结尾 `/` 都非法。以前这里**完全没有校验**,非法名要等
   * git 报错才知道。
   * @param name - 用户输入的分支名。
   * @throws GitServiceError 名字非法时。
   */
  private assertValidBranchName(name: string): void {
    this.assertValidRefName(name, '分支名');
  }

  /**
   * ref 名(分支 / 标签 / 远端分支)的公共校验。
   *
   * 与 `assertValidBranchName` 是同一套规则 —— git 对 `refs/heads/**` 与
   * `refs/tags/**` 用同一条 `check-ref-format`。抽出来只是为了报错里能说清是
   * **哪一类**名字不合法,同时让既有的分支报错文案逐字不变。
   * @param name - 用户输入的名字。
   * @param what - 报错里用的类别名(「分支名」「标签名」…)。
   */
  private assertValidRefName(name: string, what: string): void {
    if (name.trim() === '') {
      throw new GitServiceError('bad-request', `${what}不能为空。`);
    }
    if (testForInvalidChars(name)) {
      throw new GitServiceError(
        'bad-request',
        `${what} ${name} 含非法字符。Git 不允许空格与 ~ ^ : ? * [ \\ | " < > 等,也不能有连续点、首尾点或结尾的 .lock。`,
      );
    }
  }

  async createBranch(path: string, name: string, startPoint?: string): Promise<void> {
    this.assertValidBranchName(name);
    const root = await this.gate(path);
    await this.must(branchCreateArgv(name, startPoint), root, '新建分支');
  }

  async renameBranch(path: string, oldName: string, newName: string): Promise<void> {
    this.assertValidBranchName(newName);
    const root = await this.gate(path);
    await this.must(branchRenameArgv(oldName, newName), root, '重命名分支');
  }

  async deleteBranch(path: string, name: string): Promise<void> {
    const root = await this.gate(path);
    await this.must(branchDeleteArgv(name), root, '删除分支');
  }

  /**
   * 删**远端**分支(`git push <remote> --delete <branch>`)。
   *
   * 上游:`deleteRemoteBranch`(`references/desktop/app/src/lib/git/branch.ts:119-143`)。
   * 两处沿用上游:
   *  1. **远端名必须在清单里**。上游拿的是 `IRemote` 对象,我们只能收字符串,
   *     所以对着 `git remote` 逐个比对 —— 这样拼进 argv 的 remote 一定是配置里的名字,
   *     而不是任意串(push 不支持 `--end-of-options`,见 `pushDeleteRemoteBranchArgv`);
   *  2. **远端 ref 已经不在了 ⇒ 当作成功**。上游把 `BranchDeletionFailed` 列为
   *     expectedErrors,并顺手删掉本地过期的 remote-tracking ref(`branch.ts:137-140`)。
   *     这里按 stderr 判定同一种情形(`unable to delete '…': remote ref does not exist`),
   *     用既有的 {@link updateRefDeleteArgv} 删本地 ref,再返回成功 —— 用户想要的
   *     「这个远端分支没了」已经达成,报错只会误导。
   *
   * 网络动作:带凭据环境与 180s 超时,与 {@link push} 同规格。
   * @param path - 仓库路径。
   * @param remote - 远端名(必须是配置里的)。
   * @param branch - 远端分支名。
   */
  async deleteRemoteBranch(path: string, remote: string, branch: string): Promise<void> {
    this.assertValidRefName(branch, '远端分支名');
    const root = await this.gate(path);
    const names = parseRemotes((await this.must(remoteListArgv(), root, '读取远端')).stdout);
    if (!names.includes(remote)) {
      throw new GitServiceError('bad-request', `没有名为 ${remote} 的远端。`);
    }
    const env = this.credentialEnv();
    const res = await this.runner.run(pushDeleteRemoteBranchArgv(remote, branch), root, {
      ...(env !== undefined ? { env } : {}),
      timeoutMs: 180_000,
    });
    if (res.exitCode === 0) {
      return;
    }
    if (/remote ref does not exist|unable to delete/i.test(res.stderr)) {
      await this.optional(updateRefDeleteArgv(`refs/remotes/${remote}/${branch}`, 'dsh-git: 远端分支已不存在'), root);
      return;
    }
    throw classifyGitFailure(res.stderr, '删除远端分支');
  }

  async remotes(path: string): Promise<{ name: string; url: string }[]> {
    const root = await this.gate(path);
    const names = parseRemotes((await this.must(remoteListArgv(), root, '读取远端')).stdout);
    const out: { name: string; url: string }[] = [];
    for (const name of names) {
      const res = await this.optional(remoteUrlArgv(name), root);
      out.push({ name, url: firstLine(res.stdout) });
    }
    return out;
  }

  async setRemoteUrl(path: string, name: string, url: string): Promise<void> {
    const root = await this.gate(path);
    await this.must(remoteSetUrlArgv(name, url), root, '修改远端地址');
  }

  async config(path: string, key: string, scope: 'local' | 'global' = 'local'): Promise<string | null> {
    const root = await this.gate(path);
    const res = await this.optional(configGetArgv(key, scope), root);
    return res.exitCode === 0 ? parseConfigValue(res.stdout) : null;
  }

  async setConfig(path: string, key: string, value: string, global = false): Promise<void> {
    const root = await this.gate(path);
    await this.must(configSetArgv(key, value, global), root, `写入配置 ${key}`);
  }

  async fetch(path: string, remote?: string): Promise<void> {
    const root = await this.gate(path);
    const names = parseRemotes((await this.must(remoteListArgv(), root, '读取远端')).stdout);
    if (names.length === 0) {
      throw new GitServiceError('no-upstream', '这个仓库还没有远端。');
    }
    const targets = remote !== undefined && remote !== '' ? [remote] : names;
    for (const name of targets) {
      await this.must(fetchArgv(name), root, `抓取 ${name}`, {
        ...(this.credentialEnv() !== undefined ? { env: this.credentialEnv() as Readonly<Record<string, string>> } : {}),
        timeoutMs: 120_000,
      });
      // 抓取后同步远端默认分支指向;失败不致命(照 Desktop)。
      await this.optional(['remote', 'set-head', '-a', '--', name], root);
    }
  }

  /**
   * 拉取当前分支。
   *
   * `opts.rebase` **覆盖**宿主自己的 `pull.rebase` 读取 —— 上游同形:
   * 顶栏那条路径的值来自 `IBranchesState.pullWithRebase`(即 `syncState` 回给客户端的
   * 同一份数据),而不是在执行时重读一次配置。省略 `opts.rebase` 时才自己读
   * (`src/client/workbench.tsx:726` 的「更多 ▸ 拉取」与 `store.runSyncAction('pull')`
   * 走的就是这一支)。
   *
   * 这条「谁决定变基」只有一个来源,正是本轮要修的那处:以前文案与执行**各读一次**,
   * 于是 `pull.rebase=merges`(不可识别值)会出现「文案说变基、执行却 `--ff-only`」。
   */
  async pull(path: string, opts: { rebase?: boolean } = {}): Promise<void> {
    const root = await this.gate(path);
    const status = await this.status(root);
    if (status.upstream === null) {
      throw new GitServiceError('no-upstream', '当前分支没有跟踪远端分支,无法拉取。');
    }
    const remote = status.upstream.includes('/') ? status.upstream.slice(0, status.upstream.indexOf('/')) : 'origin';
    /*
     * `??` 与 `===` 的优先级要写清楚:`===` 先算,`??` 后算 —— 于是这一行的语义是
     * 「显式给了就用它,否则把三态读成布尔(`undefined` ⇒ 不主动加 `--rebase`,
     * 让 git 按它自己的配置决定)」。两者的判定已经是**同一个** `readPullWithRebase`,
     * 所以不存在第二份真源。
     */
    const rebase = opts.rebase ?? ((await this.readPullWithRebase(root)) === true);
    const ffOnly = rebase ? false : await this.pullAllowsFfOnly(root);
    await this.must(pullArgv({ remote, rebase, ffOnly }), root, '拉取', {
      ...(this.credentialEnv() !== undefined ? { env: this.credentialEnv() as Readonly<Record<string, string>> } : {}),
      timeoutMs: 180_000,
    });
  }

  /**
   * 读**生效**的 `pull.rebase`(不带 `--local`/`--global` ⇒ git 自己按作用域优先级合成),
   * 判定照上游 `lib/stores/git-store.ts:454-466` 的 `checkPullWithRebase()` **逐字**:
   *
   * ```
   * null/'' → undefined        // 没配置:交给 git 的默认行为
   * 'true'  → true             // 只有这两个**精确**字符串产生布尔
   * 'false' → false
   * 其它    → undefined + 警告 // 例如 'merges' / '1' / 'yes' / 'interactive'
   * ```
   *
   * ⚠️ **这里有上一版的一处偏差,已按上游纠正**(本文件 `:1456` 改前是
   * `pullPrefersRebase()`,它按 git 的**布尔真值表**把 `'1' / 'yes' / 'interactive'`
   * 都判成真,并把「没配置」判成 `false`)。上游是**四路**的:只有精确的
   * `'true'`/`'false'` 产生布尔,其余(含 `interactive` 这种 git 认为等价于 true 的写法)
   * 一律 `undefined` + 一条警告。
   *
   * 为什么必须统一到上游那一路(而不是保留两套):这个值现在**同时**决定按钮文案与
   * 执行参数。若保留「git 真值表」,`pull.rebase=interactive` 会显示「变基拉取」并真的
   * `--rebase`,而上游显示「拉取」并走 git 自己的配置 —— 那就是第二份真源,
   * 恰好是这次要消灭的东西。统一之后两者只可能一起变。
   */
  private async readPullWithRebase(root: string): Promise<boolean | undefined> {
    const res = await this.optional(['config', '--get', 'pull.rebase'], root);
    const raw = res.exitCode === 0 ? firstLine(res.stdout) : '';
    if (raw === '') {
      return undefined;
    }
    if (raw === 'true') {
      return true;
    }
    if (raw === 'false') {
      return false;
    }
    this.warn(`Unexpected value found for pull.rebase in config: '${raw}'`);
    return undefined;
  }

  /** 只在用户没配 pull.ff 时才自己决定 --ff-only(照 Desktop)。 */
  private async pullAllowsFfOnly(root: string): Promise<boolean> {
    const res = await this.optional(['config', '--get', 'pull.ff'], root);
    return !(res.exitCode === 0 && firstLine(res.stdout) !== '');
  }

  async push(path: string, opts: { force?: boolean; noVerify?: boolean } = {}): Promise<void> {
    const root = await this.gate(path);
    const status = await this.status(root);
    if (status.detached || status.branch === '') {
      throw new GitServiceError('bad-request', '分离头状态下无法推送,请先切到分支。');
    }
    if (status.unborn) {
      throw new GitServiceError('bad-request', '这个分支还没有提交,无法推送。');
    }
    const names = parseRemotes((await this.must(remoteListArgv(), root, '读取远端')).stdout);
    if (names.length === 0) {
      throw new GitServiceError('no-upstream', '这个仓库还没有远端,请先发布到 GitHub。');
    }
    const needUpstream = status.upstream === null;
    const upstreamRemote = status.upstream !== null && status.upstream.includes('/')
      ? status.upstream.slice(0, status.upstream.indexOf('/'))
      : '';
    const remote = names.includes(upstreamRemote) ? upstreamRemote : names[0];
    let remoteBranch: string | undefined;
    if (status.upstream !== null && status.upstream.includes('/')) {
      remoteBranch = status.upstream.slice(status.upstream.indexOf('/') + 1);
    }
    await this.must(pushArgv({
      remote,
      branch: status.branch,
      ...(remoteBranch !== undefined && remoteBranch !== '' ? { remoteBranch } : {}),
      setUpstream: needUpstream,
      forceWithLease: opts.force === true,
      noVerify: opts.noVerify === true,
    }), root, opts.force === true ? '强推' : '推送', {
      ...(this.credentialEnv() !== undefined ? { env: this.credentialEnv() as Readonly<Record<string, string>> } : {}),
      timeoutMs: 180_000,
    });
  }

  async clone(input: { url: string; path: string; branch?: string }): Promise<string> {
    // 目标路径黑名单:克隆到 ~/.ssh 这类目录会把凭据/配置写坏(照 Desktop clone.ts:18-49)。
    const denied = denyCloneDestination(input.path);
    if (denied !== null) {
      throw new GitServiceError('bad-request', `不能克隆到 ${denied}:请选择一个普通目录。`);
    }
    // 目标目录还不存在,子进程 cwd 必须落在一个真实存在的目录上。
    const parent = dirname(input.path);
    await mkdir(parent, { recursive: true }).catch(() => undefined);
    await this.must(cloneArgv({
      url: input.url,
      path: input.path,
      ...(input.branch !== undefined ? { branch: input.branch } : {}),
    }), parent, '克隆仓库', {
      ...(this.credentialEnv() !== undefined ? { env: this.credentialEnv() as Readonly<Record<string, string>> } : {}),
      timeoutMs: 600_000,
    });
    return input.path;
  }

  async init(input: { path: string; defaultBranch: string }): Promise<void> {
    await this.must(initArgv(input.defaultBranch), input.path, '初始化仓库');
  }

  /** 从远端 URL 解析 GitHub owner/repo(仓库下拉里显示)。 */
  async githubRemote(path: string): Promise<string | null> {
    const root = await this.repoRoot(path);
    if (root === null) {
      return null;
    }
    const names = parseRemotes((await this.optional(remoteListArgv(), root)).stdout);
    const ordered = names.includes('origin') ? ['origin', ...names.filter((n) => n !== 'origin')] : names;
    for (const name of ordered) {
      const res = await this.optional(remoteUrlArgv(name), root);
      if (res.exitCode !== 0) {
        continue;
      }
      const ref = parseGithubRemoteText(firstLine(res.stdout));
      if (ref !== null) {
        return `${ref.owner}/${ref.repo}`;
      }
    }
    return null;
  }

  /** 当前 HEAD 的短名(仓库清单副标题用),失败返回空串。 */
  async headBranch(path: string): Promise<string> {
    const root = await this.repoRoot(path);
    if (root === null) {
      return '';
    }
    const res = await this.optional(['rev-parse', '--abbrev-ref', 'HEAD'], root);
    if (res.exitCode !== 0) {
      return '';
    }
    const v = firstLine(res.stdout);
    return v === 'HEAD' ? '' : v;
  }
}

// ---------- 小工具 ----------

function firstLine(out: string): string {
  for (const line of out.split('\n')) {
    const t = line.replace(/\r$/, '').trim();
    if (t !== '') {
      return t;
    }
  }
  return '';
}

function countPatchLines(patch: string, prefix: string): number {
  let n = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith(prefix) && !line.startsWith(`${
      prefix}${prefix}${prefix}`)) {n += 1;
    }
  }
  return n;
}

/**
 * `git ls-tree -z -l` 的一条记录 → 类型 / 对象名 / 字节数 / 路径。
 *
 * 记录形状(`-z` 时以 NUL 结尾,`-l` 给出右对齐的字节数,非 blob 的字节数是 `-`):
 *
 * ```
 * 100644 blob 94954abda49de8615a048f8d2e64b5de848e27a1      12\ta.txt\0
 * ```
 *
 * 只取**第一条**:`:(literal)` 保证最多只可能有一条。没有记录(空输出)=
 * 「这个版本里没有这个路径」,回 `null`(调用方折成 404)。
 * @param stdout - `ls-tree` 的输出。
 */
function parseTreeEntry(stdout: string): { type: string; sha: string; size: number; path: string } | null {
  const record = stdout.split('\0').find((one) => one !== '');
  if (record === undefined) {
    return null;
  }
  const tab = record.indexOf('\t');
  if (tab < 0) {
    return null;
  }
  const head = record.slice(0, tab);
  const path = record.slice(tab + 1);
  const fields = /^(\d+)\s+(\S+)\s+([0-9a-f]+)\s+(-|\d+)$/.exec(head);
  if (fields === null) {
    return null;
  }
  const type = fields[2] ?? '';
  const sha = fields[3] ?? '';
  const rawSize = fields[4] ?? '-';
  const size = rawSize === '-' ? -1 : Number(rawSize);
  if (!isSafeObjectName(sha)) {
    return null;
  }
  return { type, sha, size, path };
}

/**
 * `git ls-files -s -z` 的一条记录 → 对象名 / 路径。
 *
 * 形状:`100644 614dd470b67c937bc00fcf322ccc8e6c59d29aa6 0\ts.txt\0`
 * (索引没有字节数列,大小另问 `cat-file -s`)。
 * @param stdout - `ls-files -s` 的输出。
 */
function parseIndexEntry(stdout: string): { sha: string; path: string } | null {
  const record = stdout.split('\0').find((one) => one !== '');
  if (record === undefined) {
    return null;
  }
  const tab = record.indexOf('\t');
  if (tab < 0) {
    return null;
  }
  const head = record.slice(0, tab);
  const path = record.slice(tab + 1);
  const fields = /^(\d+)\s+([0-9a-f]+)\s+(\d+)$/.exec(head);
  if (fields === null) {
    return null;
  }
  const sha = fields[2] ?? '';
  if (!isSafeObjectName(sha)) {
    return null;
  }
  return { sha, path };
}

/**
 * 从一条 stdout 字节流里**跳过 `skip` 字节、只留下 `take` 字节**。
 *
 * 内存只按 `take` 增长(上限就是 `MAX_BLOB_BYTES`);收够就 `break`,由调用方
 * `close()` 销毁管道并终止 `git cat-file` —— 一个 500MB 的 blob 因此只被读到
 * 「需要的区间结束」为止。
 *
 * 流被提前销毁、进程被杀、或 blob 比预期短:返回**已收到的字节数**,由调用方
 * 与期望长度比对后报错 —— 绝不返回「不足但不报错」的区间。
 * @param source - 原始 stdout 字节流。
 * @param skip - 跳过的字节数。
 * @param take - 要留下的字节数。
 */
async function collectStreamRange(
  source: AsyncIterable<Uint8Array>,
  skip: number,
  take: number,
): Promise<Buffer> {
  const out = Buffer.alloc(take);
  let written = 0;
  let seen = 0;
  try {
    for await (const chunk of source) {
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayBufferLike);
      const chunkStart = seen;
      seen += bytes.length;
      if (seen <= skip) {
        continue;
      }
      const from = Math.max(0, skip - chunkStart);
      const room = take - written;
      if (room <= 0) {
        break;
      }
      const slice = bytes.subarray(from, from + Math.min(room, bytes.length - from));
      out.set(slice, written);
      written += slice.length;
      if (written >= take) {
        break;
      }
    }
  } catch {
    // 管道被销毁 / 进程被终止:按已收到的字节数返回,差额由调用方判错。
  }
  return out.subarray(0, written);
}

/**
 * 全局 gitconfig 的绝对路径(`git config --global` 的写入目标)。
 *
 * **这是全仓唯一一处构造这个路径的地方**:两处「edit your global Git config」链接、
 * 锁文件检测(`host/git-config-file.ts`)与克隆目标的敏感路径清单
 * ({@link denyCloneDestination})都走它。这段构造以前只存在于 {@link denyCloneDestination}
 * 的敏感项里(那一行 `join(home, '.gitconfig')`,即任务里说的 1708-1716 那一段)——
 * 抽出来复用而不是再写一份,是为了让「全局配置文件在哪」只有一个答案。
 *
 * 顺序与 git 自己一致:
 *  1. `GIT_CONFIG_GLOBAL` —— 设了它,`git config --global` 就写那里,且 git **不再读**
 *     `~/.gitconfig`(`git help config` 的 ENVIRONMENT 一节);
 *  2. `$HOME/.gitconfig`。
 *
 * ⚠️ **不认** `$XDG_CONFIG_HOME/git/config`:git 会**读**它,但 `--global` 的写入目标仍是
 * `~/.gitconfig`,而上游 Desktop 的 `getGlobalConfigPath()`
 * (`references/desktop/app/src/lib/git/config.ts:133-140`)把这件事整个交给
 * `git config --edit --global` 去解析。这是**已知偏差**,不是疏忽。
 * @returns 绝对路径;读不到主目录(且没有 GIT_CONFIG_GLOBAL)⇒ null。
 */
export function globalGitConfigPath(): string | null {
  const override = (process.env.GIT_CONFIG_GLOBAL ?? '').trim();
  if (override !== '') {
    return resolve(override);
  }
  try {
    const home = homedir();
    return home === '' ? null : join(home, '.gitconfig');
  } catch {
    // os.homedir() 在拿不到主目录时可能抛(或返回空串):这两种都折成 null,
    // 交给调用方按「解析不出」处理。
    return null;
  }
}

/**
 * 拒绝敏感的克隆目标(照 Desktop `lib/git/clone.ts:18-49`)。
 * 返回被拒的原因,或 null 表示允许。
 * @param target - 目标绝对路径。
 */
export function denyCloneDestination(target: string): string | null {
  const home = homedir();
  const normalized = resolve(target);
  const sensitive: [string, string][] = [
    [home, '主目录本身'],
    [join(home, '.ssh'), '~/.ssh'],
    [join(home, '.gnupg'), '~/.gnupg'],
    [join(home, '.config'), '~/.config'],
    [join(home, '.config', 'git'), '~/.config/git'],
  ];
  // 全局 gitconfig 的路径走 {@link globalGitConfigPath}(唯一出处)。
  // 没设 GIT_CONFIG_GLOBAL 时它**就是** `~/.gitconfig`,与改动前逐字一致;
  // 设了的时候真正的全局配置文件只有那一个(`~/.gitconfig` 已不被 git 读取),
  // 所以拒它一个才是对的。
  const gitConfig = globalGitConfigPath();
  if (gitConfig !== null) {
    sensitive.push([gitConfig, '~/.gitconfig']);
  }
  const appData = process.env.APPDATA;
  if (appData !== undefined && appData !== '') {
    sensitive.push([appData, '%APPDATA%']);
  }
  for (const [path, label] of sensitive) {
    if (normalized === resolve(path)) {
      return label;
    }
  }
  return null;
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}
