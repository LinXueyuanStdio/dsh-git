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
import { lstat, mkdir, mkdtemp, open as openFd, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import {
  BLOB_JSON_FALLBACK_MAX_BYTES, INDEX_REV, MAX_BLOB_BYTES, contentTypeFor, formatByteSize,
  isImmutableRev, looksBinary, parseRangeHeader,
} from '../core/blob.ts';
import type {
  BranchEntry, ClonePathKind, CommitDetail, CommitEntry, DiffResult, GitError, RepoStatus, SyncState,
} from '../core/types.ts';
import {
  addArgv, applyCachedArgv, applyReverseArgv, authorIdentArgv, blobContentArgv, blobIndexEntryArgv, blobSizeArgv, blobTreeEntryArgv, branchCreateArgv, branchDeleteArgv, branchListArgv,
  branchRenameArgv, checkoutBranchArgv, checkoutDetachArgv, checkoutPathsArgv, checkoutRemoteArgv, cherryPickArgv,
  cleanArgv, cloneArgv, commitArgv, commitDetailStatArgv, configGetArgv, configGetEffectiveArgv, configSetArgv, configUnsetArgv, diffCommitArgv,
  diffCommitNumstatArgv, diffNumstatArgv, diffStagedArgv, diffUnstagedArgv, diffUntrackedArgv,
  fetchArgv, initArgv, logArgv, nameStatusCommitArgv, pullArgv, pushArgv, pushDeleteRemoteBranchArgv,
  lsFilesArgv, remoteListArgv, remoteSetUrlArgv, remoteUrlArgv, resetMixedArgv, resetPathsArgv, resetToCommitArgv,
  rebaseInteractiveArgv,
  revertArgv, rmCachedAllArgv,
  statusArgv, tagCreateArgv, tagDeleteArgv, tagListArgv, topLevelArgv, unpushedTagsArgv, updateRefDeleteArgv,
  createDesktopStashMessage, extractBranchFromStashMessage, isSafeStashName, stashCommitTreeArgv, stashDropArgv,
  stashLogArgv, stashPopArgv, stashPushArgv, stashShowFilesArgv, stashStoreArgv, STASH_LOG_FIELDS,
  isSafeObjectName, isSafeRev, type ResetMode } from '../core/git-argv.ts';
import {
  buildRepoStatus, operationFromMarkers, parseBranches, parseConfigValue, parseGithubRemoteText,
  parseLog, parseNameStatus, parseNumstat, parseRawLogWithNumstat, parseRemotes, parseStatus, parseTags,
  parseUnpushedTags, type IStashFileEntry,
} from '../core/parse.ts';
// stash 列表的解析**逐字**用镜像那份上游 parser(`createLogParser`),不再写第二份;
// 它用 `Buffer` ⇒ 只能进 host 半(浏览器半没有 `Buffer`,见 `lib/git/index.ts` 的同类理由)。
import { createLogParser } from '../core/desktop/lib/git/git-delimiter-parser.ts';
import type { GitRunner, GitRunResult } from './git-runner.ts';
import { DEFAULT_TIMEOUT_MS, OUTPUT_CAP_BYTES } from './git-runner.ts';
import {
  createSyncProgressLineSink, createSyncProgressParser,
  type SyncProgressKind, type SyncProgressSnapshot,
} from './sync-progress.ts';
import { buildPartialPatch, isSelectionEmpty, type FileStatusKind, type LineSelectionSpec } from '../core/partial-stage.ts';
import { reorderTodoLines, squashTodoLines, type ITodoCommit } from '../core/rebase-todo.ts';
import { parseRawDiff } from '../core/diff-parse.ts';
import { testForInvalidChars } from '../core/desktop/lib/sanitize-ref-name.ts';
import * as gitignore from './gitignore.ts';

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
  /**
   * ★ **推送成功之后刷新远端** —— 上游 `app-store.ts:5341-5347`
   * (`gitStore.fetchRemotes([safeRemote], false, …)`)的宿主注入点。
   *
   * ## 为什么是**注入**而不是在这里 `import`
   *
   * 实现是**镜像的那份上游编排层**(`src/host/mirror-git.ts` →
   * `mirror/lib/stores/git-store.ts` 的 `GitStore.fetchRemotes`)。如果本文件直接
   * `import` 它,那么**每一个**打包 `git-service.ts` 的东西都会连带把整片
   * `src/host/mirror/**` 拉进自己的 bundle —— 实测:仓里 **24 个探针**各自
   * `esbuild` 一份宿主入口,它们就都要跟着复制宿主产物的
   * `external: ['dugite']` / `inject`(Desktop 构建期全局)/ `alias`(byline)/
   * `banner`(CJS 依赖的 `require`)四条构建参数。**一份实现不该有 25 份构建配置。**
   *
   * 注入还买到一件更要紧的事:探针可以**只换这一个函数**来量
   * 「有它 / 没它」两档(见 `docs/probes/host-mirror-wiring-probe.mjs` 的
   * B 组阴性对照),而不用去改 `src/**`。
   *
   * 生产接线在 `src/index.ts`(那里 `import { fetchRemotesAfterPush }`)。
   *
   * ## 语义契约(照上游)
   *
   *   · **只在推送成功之后**调用(推送失败不会调);
   *   · **失败不致命**:实现自己吞掉网络错误(上游 `performFailableOperation`
   *     就是这么做的),所以它 reject 只会被折成一条警告,**不会**把成功的推送
   *     判成失败;
   *   · 进度经 `onProgress` 回灌到**同一个** `syncProgressByRoot`(不是另起一条)。
   */
  afterPushFetch?: (
    root: string,
    remote: { readonly name: string; readonly url: string },
    onProgress?: (progress: { readonly description?: string; readonly value: number }) => void,
  ) => Promise<void>;
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
  /*
   * libcurl 的 HTTP/2 帧层错误。
   *
   * 为什么要单独认它(而不是让它掉进兜底):它是一条**有标准解法**的网络层失败
   * (git 走 HTTP/2 时被代理/中间设备打断),而兜底只会把 libcurl 的英文原句当原因播出去
   * —— 用户拿到事实但拿不到下一步。这里两样都给:原句在 `detail` 里(逐字),`message`
   * 给出可操作的那一句。
   *
   * ⚠️ **可操作性提示的判据是 stderr 本身**(`/http2/i` + 「framing layer」),
   * 判据不成立时一句都不提 —— 用户的要求是「别编:只在确定判据成立时才提示」。
   * ⚠️ 边界:`docs/probes/push-failure-detail-probe.mjs` 的 A11 档**本地造不出来**
   * (试过:本地 TCP 服务回 `101 Switching Protocols` + 垃圾字节 ⇒ git 只是**挂住**
   * 直到超时、stderr 为空)。所以这条规则只有「把 libcurl 那句原文喂进分类器」这一级判据,
   * 真句子只有带 HTTP/2 的真远端/代理能产出。
   */
  if (/http2 framing layer|error in the http2|http\/2/.test(s)) {
    const first = detail.split('\n').find((line) => line.trim() !== '') ?? '';
    return new GitServiceError(
      'git-failed',
      `${context}失败:HTTP/2 连接中途断了(${first === '' ? 'libcurl 报 HTTP/2 帧层错误' : first})。`
      + '这条是 libcurl 的帧层报错,常见解法是把 git 走 HTTP/1.1:'
      + 'git config --global http.version HTTP/1.1,然后重试。',
      detail,
    );
  }
  const first = detail.split('\n').find((line) => line.trim() !== '') ?? '未知错误';
  return new GitServiceError('internal', `${context}失败:${first}`, detail);
}

/**
 * 命令行的可读形态(带 `git ` 前缀,含空白的参数加引号)。
 *
 * 上限 400 字符是**明确标注**的截断:这条只用于「被终止的命令」这一行,而 argv 在
 * 本服务里都很短(`push -- origin main`);真出现过长的 argv 时宁可标出来,也不假装完整。
 */
function commandLineOf(argv: readonly string[]): string {
  const line = `git ${argv.map((one) => (/\s/.test(one) ? JSON.stringify(one) : one)).join(' ')}`;
  return line.length <= 400 ? line : `${line.slice(0, 400)}…(命令过长,已截断)`;
}

/**
 * 失败信封里的 `detail`(给「超时 / 被终止」这两档用)。
 *
 * 用户要求「如果宿主载荷里另有**失败命令 / 退出码**之类字段,一并显示;没有就别编」
 * —— 这一份就是宿主**真的**知道的那几样:被终止的命令、超时上限(仅超时时)、
 * 以及 git 在死之前写出来的 stderr(**逐字**,不做任何加工)。退出码在这里**故意不写**:
 * 它的值本来就是 `null`(见 `GitRunResult.timedOut` 的三条成因),写个「退出码: null」
 * 只会让读者以为拿到了信息。
 */
function commandDetail(
  argv: readonly string[],
  extra: { timeoutMs?: number; stderr: string },
): string {
  const trimmed = extra.stderr.trim();
  return [
    `被终止的命令: ${commandLineOf(argv)}`,
    ...(extra.timeoutMs === undefined
      ? []
      : [`超时上限: ${extra.timeoutMs}ms(${Math.round(extra.timeoutMs / 1000)} 秒)`]),
    '宿主已终止该进程: 是',
    'git 在被终止前写出的输出(stderr,逐字):',
    trimmed === '' ? '(一个字节都没有)' : trimmed,
  ].join('\n');
}

/**
 * **超时**这一档的失败 —— 已知条件,不许折成「未知错误」。
 *
 * 2026-10 用户报「推送失败居中弹窗里,出现未知错误」:真因是宿主按 `timeoutMs` 把
 * `git push` 杀掉(`exitCode=null` + stderr 为空),而当时那条路只能落
 * `classifyGitFailure` 的占位符兜底。超时**是知道的**:时间和命令都在手上,所以
 * ①给专属 `code: 'timeout'`;②`message` 明说「超时(N 秒),已终止」并给出常见成因;
 * ③`detail` 带上被终止的命令、超时值与已经收到的 stderr。
 *
 * 上游对照(为什么文案是我们自己写的):GitHub Desktop **没有** git 命令超时这个概念
 * —— `grep -rn 'killed|timed out|SIGTERM' app/src/lib/stores/git-store.ts
 * app/src/lib/git/core.ts` 命中 **0**,`performFailableOperation` 也不设超时
 * (整个 Desktop 里唯一一个 `timeoutMs` 是 LLM 请求的,`app-store.ts` 的
 * `provider.requestTimeoutSeconds`),而且本 checkout 里没有 dugite。
 * 上游唯一相关的那条**原则**在 `lib/git/core.ts:161-172`:没有 stderr/stdout 时它播
 * **机器事实**(`Unknown error (exit code ${result.exitCode})`),而不是宣称「未知」。
 * 本文案照那条原则办(给出我们知道的事实),落点仍是上游那个通用 `AppError` 表面
 * (`ui/app-error.tsx:168` 的 `return <p>{e.message}</p>`)—— 这条**不对应**任何新的上游表面。
 */
export function timeoutFailure(
  argv: readonly string[],
  context: string,
  timeoutMs: number,
  stderr: string,
): GitServiceError {
  const seconds = Math.round(timeoutMs / 1000);
  return new GitServiceError(
    'timeout',
    `${context}超时(${seconds} 秒),宿主已终止这次 git 调用。`
    + '常见成因是网络把连接挂住(git 一直没有返回),也可能是凭据提示在等待输入。',
    commandDetail(argv, { timeoutMs, stderr }),
  );
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

/**
 * 一条 **Desktop 建的** stash 条目 —— 上游 `IStashEntry`
 * (`references/desktop/app/src/models/stash-entry.ts:3-22`)的 JSON 投影。
 *
 * 字段名与上游**逐字相同**(`name` / `branchName` / `stashSha` / `tree` / `parents`),
 * 所以客户端拿到它之后可以直接当成 `IStashEntry` 用(只差 `files` 那一段,
 * 由 `stash/show` 单独装载 —— 与上游 `getStashes` → `loadFilesForCurrentStashEntry`
 * 的两段式一致)。
 */
export interface IStashEntryPayload {
  /** 上游 `IStashEntry.name` = `%gD`,`refs/stash@{N}`。 */
  readonly name: string;
  /** 上游 `IStashEntry.branchName` = 从消息里解出来的分支名。 */
  readonly branchName: string;
  /** 上游 `IStashEntry.stashSha` = `%H`。 */
  readonly stashSha: string;
  /** 上游 `IStashEntry.tree` = `%T`。 */
  readonly tree: string;
  /** 上游 `IStashEntry.parents` = `%P` 按空格切开。 */
  readonly parents: readonly string[];
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

  /**
   * **在飞的网络动作进度**(仓库根 → 最后一条解析出来的 git 进度)。
   *
   * 上游的等价物是 `IRepositoryState.pushPullFetchProgress`
   * (`lib/app-state.ts:632`,由 `app-store.ts:5168` 的 `updatePushPullFetchProgress`
   * 写)—— 那是**主进程内存里的一份状态**,由渲染层订阅。我们是 HTTP 两半,
   * 所以这份状态留在宿主,由 `sync-progress` 路由读出去,客户端在动作在飞期间轮询它。
   *
   * 键是 {@link gate} 解析出的**仓库根**:客户端两次请求(`push` 与 `sync-progress`)
   * 带的是同一个 `state.current`,所以在路由里**不再**解析一次 —— 那会让每次轮询
   * 多跑一条 `git rev-parse` 子进程(250ms 一次)。
   *
   * 生命周期:动作开始时写入、`finally` 里删除。**不**跨动作残留(否则一次推送结束后
   * 的轮询会读到上一条,界面会回跳)。
   */
  private readonly syncProgressByRoot = new Map<string, SyncProgressSnapshot>();

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
    opts: {
      input?: string;
      /**
       * `undefined` 是**墓碑**(删掉父环境里的同名项)—— 语义与
       * `GitRunOptions.env` 逐字相同,见 `git-runner.ts` 的注释。
       * 唯一使用者是 `multi-commit/*`:上游 `lib/git/rebase.ts:585` 的
       * `GIT_SEQUENCE_EDITOR: undefined`。
       */
      env?: Readonly<Record<string, string | undefined>>;
      timeoutMs?: number;
      allow?: readonly number[];
      /**
       * 逐行观察 stderr(进度源)。见 {@link syncProgressOptions} —— 这里**必须**
       * 显式搬过去:`must()` 是逐字段构造 spec 的,漏一个字段的表现是
       * 「`--progress` 加了、stderr 却仍是收集模式 ⇒ 一条进度都没有」,
       * 而那看起来完全像「git 没报进度」(第一版就是这么静的)。
       */
      onStderrLine?: (line: string) => void;
    } = {},
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
    if (opts.onStderrLine !== undefined) {
      spec.onStderrLine = opts.onStderrLine;
    }
    const res = await this.runner.run(argv, cwd, spec);
    /*
     * 失败分类的**顺序**是契约(2026-10,用户报「弹窗里出现未知错误」):
     *
     * 1. **超时优先**:`timedOut === true` 是**已知**条件 ⇒ 直接给 `timeout` 档,
     *    **不**走 `classifyGitFailure`。理由:超时那一刻 stderr 可能已经有半截输出
     *    (git 的进度行),按 stderr 分类要么命不中任何模式(⇒ 占位符)、要么指向一个
     *    **次要**原因(比如把「传到一半被掐断」认成 auth)。超时就是这次失败的**原因**,
     *    而已经收到的 stderr 一个字都不丢 —— 它连同**被终止的命令**与**超时值**
     *    一起进 `detail`(见 {@link timeoutFailure})。
     * 2. **没有退出码但不是超时**:进程被外部信号/宿主回收打断。stderr 有内容就用它分类
     *    (那可能是真因);一个字节都没有时给一句**命名过的事实**,而不是占位符。
     * 3. 其余照旧:交给 `classifyGitFailure`。
     *
     * ⚠️ 这三条只做一件事:让**已知**的条件不再冒充未知。真正的兜底
     * (`classifyGitFailure` 的 `?? '未知错误'`)**没有删** —— 它仍然接住「git 以非零码退出
     * 且一个字节都没写」这种我们确实不知道的情况(用户总指令:先做,不删)。
     */
    const allow = opts.allow ?? [0];
    if (res.timedOut === true) {
      throw timeoutFailure(argv, context, spec.timeoutMs ?? DEFAULT_TIMEOUT_MS, res.stderr);
    }
    if (res.exitCode === null) {
      if (firstLine(res.stderr) === '') {
        throw new GitServiceError(
          'internal',
          `${context}失败:进程在写出任何输出之前就被终止了(宿主没有拿到它的退出码)。`,
          commandDetail(argv, { stderr: res.stderr }),
        );
      }
      throw classifyGitFailure(res.stderr, context);
    }
    if (!allow.includes(res.exitCode)) {
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

  /**
   * **在飞的网络动作进度** —— `sync-progress` 路由的唯一读点。
   *
   * 只查一次 Map,**不跑任何子进程**:客户端在动作在飞期间按 ~250ms 轮询它
   * (见 `docs/proposals/push-progress.md` 的选型)。取不到 ⇒ `null`
   * (没有动作在跑、或这个仓库不是这次动作的目标)。
   *
   * @param path - 客户端传来的仓库路径;与 `push`/`fetch`/`pull` 同一个 `state.current`。
   */
  public syncProgressOf(path: string): SyncProgressSnapshot | null {
    return this.syncProgressByRoot.get(path) ?? null;
  }

  /**
   * 给一次网络动作装上**进度源** —— 上游 `lib/progress/from-process.ts:19-46` 的
   * `executionOptionsWithProgress()` 的宿主等价物。
   *
   * 做了两件事,两件都必要:
   *  1. 挑本动作的解析器(`createSyncProgressParser`:push / fetch / pull 三支的步骤
   *     权重表是**逐字镜像**的上游文件);
   *  2. 把 `onStderrLine` 挂上去(`git-runner.ts` 会因此把 stderr 改成管道并逐行切,
   *     同时**仍然**缓存尾部交给 `must()` 做失败分类)。
   *
   * `--progress` 由各自的 `*Argv()` 加(调用方传 `progress: true`)—— 上游
   * `lib/git/push.ts:78` 的位置逐字同:三个开关之后、`--` 之前。
   *
   * @param kind - push / fetch / pull。
   * @param root - 仓库根(进度表的键)。
   * @param opts - 原本要交给 runner 的选项(env / timeoutMs);原样透传。
   */
  private syncProgressOptions(
    kind: SyncProgressKind,
    root: string,
    opts: { env?: Readonly<Record<string, string>>; timeoutMs?: number } = {},
  ): Parameters<GitRunner['run']>[2] {
    const parser = createSyncProgressParser(kind);
    return {
      ...opts,
      onStderrLine: createSyncProgressLineSink(kind, parser, (snapshot) => { this.syncProgressByRoot.set(root, snapshot); }),
    };
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

  // ---------- 作者身份(上游 `lib/git/var.ts`) ----------

  /**
   * 「git 这一次提交真正会用的作者身份」—— 上游 `lib/git/var.ts:20-42`
   * 的 `getAuthorIdentity`。
   *
   * ## 为什么把它放在宿主(而不是客户端读 `config-get`)
   *
   * 这是**一条 git 命令**(`git var GIT_AUTHOR_IDENT`),按本仓的四层分工
   * (`docs/goal-port-desktop.md` §2.4)命令的实现在 host;而且它的**成功码是
   * `{0, 128}`** 两档,只有真正跑过子进程的一侧才知道自己拿到的是哪一档。
   *
   * ## 三档结局(逐档对着上游,不合并)
   *
   * | git 退出码 | stdout | 上游 | 这里 |
   * |---|---|---|---|
   * | 0 | `Name <email> <ts> <tz>` | `CommitIdentity.parseIdentity(stdout)`(`:38`) | `{ ident: <trim 后的 stdout> }` |
   * | 128(`user.useConfigOnly` 且没配 name/email) | 空 | **回 `null`**(`:33-35`) | `{ ident: null }` |
   * | 其它非零 | — | `git()` 直接抛 | `must()` 分类上抛(信封 `ok:false`) |
   *
   * ⚠️ **不在这里解析**(不调 `CommitIdentity`):解析器是客户端镜像里那一份
   * (`src/core/desktop/models/commit-identity.ts` 的 `parseIdentity`,逐字上游),
   * 在宿主再写一份正则就是第二份会漂移的真源。宿主只交**原始那一行**。
   *
   * ⚠️ `trim()` 只去掉 git 结尾的换行:`parseIdentity` 的正则没有 `$` 锚定,
   * 上游传的是带换行的 stdout;trim 让「同一份身份」在任何消费方眼里都是同一个字符串
   * (对解析结果**零影响**,已由 `docs/probes/repo-author-ident-probe.mjs` 的 A3 钉住)。
   *
   * @param path - 仓库内任意路径(只用来过 `gate` 定位仓库根)。
   */
  public async authorIdent(path: string): Promise<{ ident: string | null }> {
    const root = await this.gate(path);
    const res = await this.must(authorIdentArgv(), root, '读取作者身份', { allow: [0, 128] });
    // 128 = `user.useConfigOnly` 且没有可用的 name/email ⇒ 上游 `var.ts:33-35` 回 null。
    // 它**不是**失败:上游此时也照旧让界面渲染(头像用户为 `undefined`)。
    if (res.exitCode !== 0) {
      return { ident: null };
    }
    return { ident: res.stdout.trim() };
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
   * 工作区文件的**字节数** —— `fs.promises.stat` 在浏览器半的数据面。
   *
   * ## 它是谁的宿主半边
   *
   * 客户端 `src/client/shim-node-fs-promises.ts` 的 `IFsPromisesHost.stat` 是
   * **唯一的注入点**,它自己的 JSDoc 就写着「宿主侧一旦提供 `stat`(例如走
   * `repo/tree` 的 blob 大小),即可无改动接上」。这条方法 + `file-size` 路由
   * 就是那半边;消费方是**逐字镜像**的上游 `lib/large-files.ts`
   * (`src/core/desktop/lib/large-files.ts`,100 MiB 门限也在它里面,不在宿主)。
   *
   * ## 为什么**不建** `file/large` 路由
   *
   * `docs/probes/README-probe-index.md` §八 已裁决:门限逻辑住在客户端的镜像件里,
   * 再开一条「宿主替你判 >100MB」的路由就是**第二份机制**(两处门限必然漂移)。
   * 所以这里只给**通用的大小**,一个阈值都不判。
   *
   * ## 语义边界(如实记,因为它与 node 的 `fs.stat` 不完全同)
   *
   * | | node `fs.stat`(上游 `lib/large-files.ts` 用的) | 本条 |
   * |---|---|---|
   * | 普通文件 | `size` | 同 |
   * | 缺失 / 目录 / 非法路径 | 抛 ENOENT 等 | **回 `{ size: null }`**(调用方按缺失处理) |
   * | 符号链接 | 跟随链接(报**目标**大小) | `worktreeFile` 用 **`lstat`**,报**链接自身**大小;且链接指向仓库外时**拒绝**(守卫优先) |
   *
   * 第三条是刻意保留的守卫(`worktreeFile` 的三道闸),代价是「指向仓库内大文件的符号
   * 链接」会被判成小文件 ⇒ 超大文件告警会**漏**它一个。今天不为此放宽守卫:
   * 放宽意味着允许仓库里的链接把仓库外任意文件的**大小**读出来。
   * @param path - 仓库根(过 gate)。
   * @param file - 仓库内相对路径。
   * @returns `size` 为 `null` = 不是工作区里的普通文件(缺失/目录)。
   */
  public async fileSize(path: string, file: string): Promise<{ size: number | null }> {
    const root = await this.gate(path);
    const info = await this.worktreeFile(root, file);
    return { size: info === null ? null : info.size };
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

  // ---------- 多提交操作:squash / reorder(上游 `lib/git/{squash,reorder}.ts`)----------

  /**
   * 生成交互式 rebase 的 todo 与（可选的）提交消息文件，跑**那一条** argv，按上游
   * `parseRebaseResult` 的语义把结果折成 `RebaseResult` 的字符串值。
   *
   * ## 为什么这一层是完整的（不是「半接线」）
   *
   * 上游 `rebaseInteractive`(`lib/git/rebase.ts:576-633`)本来就**只有一条 argv**，
   * 与 `continueRebase`(`:444-546`,先 stage、再自己选 `--skip`/`--continue`)不同。
   * 本方法逐字复刻它：`-c sequence.editor=cat "<todoPath>" >` + `rebase [-–no-verify] -i <ref|--root>`,
   * env `GIT_SEQUENCE_EDITOR` **不存在**、`GIT_EDITOR` = 消息文件或 `':'`。
   *
   * ## 但「一条 argv」不等于「一次操作就完了」（必须说清）
   *
   * `parseRebaseResult` 在冲突时**成功返回** `ConflictsEncountered`(`rebase.ts:425-427`)，
   * 仓库此时停在 rebase 中途。要接着跑只能靠 `continueRebase`，而它**不是一条 argv**。
   * **2026-10-10 起那条出路存在**：`GitService.continueRebase` + 路由 `'rebase/continue'`
   * (此前「不建」的裁决被用户「都做」推翻;历史记在
   * `docs/probes/README-probe-index.md` §八 与 §十七)。
   * ⇒ 冲突档的调用方拿到 `ConflictsEncountered` 之后应当接着调 `rebase/continue`。
   *
   * ## 判定逐条对着上游
   *
   * | 现场 | 上游 | 这里 |
   * |---|---|---|
   * | 退出码 0 且 stdout 匹配 `/^Current branch [^ ]+ is up to date.$/im` | `AlreadyUpToDate`(`:418-420`) | 同 |
   * | 退出码 0 | `CompletedWithoutError`(`:422`) | 同 |
   * | 非 0 且仓库**已经进入 rebase 中途** | dugite 的 `GitError.RebaseConflicts` ⇒ `ConflictsEncountered`(`:425-427`) | 用 `operationMarkers` 读 `.git/rebase-merge`／`rebase-apply` 判「真在 rebase 中途」（**比匹配 stderr 硬**：git 的冲突文案随版本/语言变） |
   * | 非 0 且 stderr 是 `Unresolved conflicts` | `OutstandingFilesNotStaged`(`:429-431`) | 按 stderr 逐字认这一句 |
   * | 其它 | `parseRebaseResult` **抛** ⇒ `squash.ts`/`reorder.ts` 的 `catch` 折成 `RebaseResult.Error`（`:159-161`,`:143-145`） | 回 `'Error'`（**成功响应**，不是错误信封 —— 上游把它当返回值） |
   *
   * ## 一处**刻意的加固**（上游没有，写在这里以免被当成偏离）
   *
   * `sequence.editor` 的值会经 `sh -c` 执行，所以 todo 路径里若含 `"` 或换行，
   * 拼出来的命令就**不是**我们要的那条（上游用 `os.tmpdir()` 起临时文件，同样有这条
   * 暴露面）。这里改成**显式报错**而不是让它去跑一条错命令。
   * @param root - 仓库根（已过 `gate`）。
   * @param todo - todo 全文。
   * @param commitMessage - squash 的提交消息；`''` ⇒ 不写消息文件（走 `':'`，上游 `squash.ts:139-146`）。
   * @param lastRetainedCommitRef - 区间下界；`null` ⇒ `--root`。
   * @param noVerify - 上游 `RebaseInteractiveOptions.noVerify`。
   */
  private async runInteractiveRebase(
    root: string,
    todo: string,
    commitMessage: string,
    lastRetainedCommitRef: string | null,
    noVerify: boolean,
  ): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-git-rebase-'));
    const todoPath = join(dir, 'todo');
    let messagePath: string | undefined;
    try {
      if (/["\n\r]/.test(todoPath)) {
        throw new GitServiceError(
          'internal',
          '临时目录路径里有引号或换行,交互式 rebase 的 `sequence.editor` 无法安全拼接。',
        );
      }
      await writeFile(todoPath, todo, 'utf8');
      // 上游:squash 的消息文件只在 commitMessage 非空时写(`squash.ts:139-142`);
      // `gitEditor` 与它同生共死(`:145-146`)—— 没有消息文件就交给 `':'`(no-op)。
      if (commitMessage.trim() !== '') {
        messagePath = join(dir, 'message');
        await writeFile(messagePath, commitMessage, 'utf8');
      }
      const gitEditor = messagePath !== undefined ? `cat "${messagePath}" >` : ':';
      /*
       * env 的两项**逐字**来自上游 `rebase.ts:582-588`。
       * `GIT_SEQUENCE_EDITOR: undefined` 是宿主 subprocess 服务的**墓碑**语义
       * (见 `git-runner.ts` 的 `GitRunOptions.env` 注释),它让这个键在子进程里
       * **不存在** —— 空串不等价(git 会去执行空命令)。
       */
      const env: Record<string, string | undefined> = {
        GIT_SEQUENCE_EDITOR: undefined,
        GIT_EDITOR: gitEditor,
        ...(this.credentialEnv() ?? {}),
      };
      /*
       * 「冲突」的硬判据 = **这次调用把仓库带进了 rebase 中途**。
       * 先记一次调用前的标记,再记一次调用后的 —— 只有「前:不在 rebase / 后:在」才算
       * 本次的冲突。单看「后:在 rebase」会把「仓库本来就有一个没跑完的 rebase」
       * 误判成冲突档(`git rebase` 那时报的是 `a rebase is already in progress`,
       * 上游 dugite 对它没有匹配 ⇒ `parseRebaseResult` 抛 ⇒ `RebaseResult.Error`)。
       */
      const rebaseBefore = (await this.operationMarkers(root)) === 'rebase';
      const res = await this.runner.run(
        rebaseInteractiveArgv(todoPath, lastRetainedCommitRef, { noVerify }),
        root,
        { env, timeoutMs: 180_000 },
      );
      if (res.timedOut === true) {
        throw timeoutFailure(
          rebaseInteractiveArgv(todoPath, lastRetainedCommitRef, { noVerify }),
          '多提交操作',
          180_000,
          res.stderr,
        );
      }
      if (res.exitCode === 0) {
        return /^Current branch [^ ]+ is up to date\.$/im.test(res.stdout)
          ? 'AlreadyUpToDate'
          : 'CompletedWithoutError';
      }
      if (/unresolved conflicts?/i.test(res.stderr)) {
        return 'OutstandingFilesNotStaged';
      }
      /*
       * 「仓库现在真的在 rebase 中途」= 最硬的冲突判据。
       * 它比匹配 stderr 强:git 的冲突文案随版本与语言变,而 `.git/rebase-merge`
       * 是 git 自己的状态文件。前一刻不在、这一刻在 ⇒ 就是**这次**调用造成的。
       */
      if (!rebaseBefore && (await this.operationMarkers(root)) === 'rebase') {
        return 'ConflictsEncountered';
      }
      /*
       * 上游这条路会 `log.error(e)` 之后回 `RebaseResult.Error`(`squash.ts:159-161`)。
       * 我们这里只留一行诊断 —— `stderr` 的原句必须留下,否则「操作出错了」这句话
       * 在现场是不可追的(与 `gitDebugEnabled()` 那条同一条纪律)。
       */
      this.options.log?.(`[multi-commit] git 既没成功也没进入 rebase 中途:${firstLine(res.stderr)}`);
      return 'Error';
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * 读**一次** `lastRetainedCommitRef..HEAD` 区间里的提交(log 顺序 = 新 → 旧)。
   *
   * 上游走 `getCommits(repository, revRange(ref,'HEAD'))`(`lib/git/index.ts`),
   * 我们走**同一条** `logArgv`(sha + subject 取自同一次 `git log`)。
   *
   * ⚠️ **不静默截断**:todo 少一条 = 那个提交被丢掉。所以多要一条,
   * 一旦真拿到 `limit + 1` 条就**抛错**,而不是交出一份悄悄变短的 todo。
   * @param root - 仓库根。
   * @param lastRetainedCommitRef - 区间下界;`null` ⇒ 整条 HEAD 历史。
   */
  private async commitsForTodo(root: string, lastRetainedCommitRef: string | null): Promise<CommitEntry[]> {
    const limit = 10_000;
    const ref = lastRetainedCommitRef === null ? undefined : `${lastRetainedCommitRef}..HEAD`;
    const argv = logArgv({ limit: limit + 1, ...(ref !== undefined ? { ref } : {}) });
    const res = await this.must(argv, root, '读取要重放的提交');
    const all = parseLog(res.stdout);
    if (all.length > limit) {
      throw new GitServiceError(
        'internal',
        `这次操作要重放的提交超过 ${limit} 条,超出本路由的安全上限(拒绝以防 todo 被静默截断)。`,
      );
    }
    return all;
  }

  /**
   * **squash 若干提交到一个提交上**(上游 `lib/git/squash.ts` 的 `squash` 函数)。
   *
   * 分工与上游逐条对齐(上游步骤表见 `docs/changes-state-adoption.md` §2.4.3):
   *  - todo 拼装 = {@link squashTodoLines}(上游 `:72-135`,纯逻辑);
   *  - 临时文件 + `writeFile(messagePath)` = 宿主(`:71,84,108,126,131`,`:139-141`);
   *  - 执行 = `rebaseInteractive`(`:148-158`)⇒ {@link runInteractiveRebase};
   *  - `finally` 删临时目录(`:162-170`)。
   *
   * ⚠️ 上游 `squash.ts` 把**任何**异常折成 `RebaseResult.Error`(`:159-161`)。
   * 这里只把 git 的意外结果折成 `'Error'`;`bad-request`(非法 sha、区间读不出来、
   * todo 拼装失败)仍然走错误信封 —— 那是**请求本身不成立**,与「git 跑失败了」
   * 不是同一件事,混成一个值会让界面把参数错误说成「操作出错」。
   * @param input.path - 仓库路径。
   * @param input.toSquash - 要被压进去的提交 sha(**不含** `squashOnto`)。
   * @param input.squashOnto - 压到哪一条上。
   * @param input.lastRetainedCommitRef - 区间下界;`null` ⇒ `--root`。
   * @param input.commitMessage - 压完后的提交消息;`''` ⇒ 让 git 用默认(`':'`)。
   * @param input.noVerify - 上游 `RebaseInteractiveOptions.noVerify`。
   */
  public async squashCommits(input: {
    path: string;
    toSquash: readonly string[];
    squashOnto: string;
    lastRetainedCommitRef: string | null;
    commitMessage: string;
    noVerify?: boolean;
  }): Promise<{ result: string }> {
    this.assertValidRev(input.squashOnto, '被压到的提交号');
    for (const sha of input.toSquash) {
      this.assertValidRev(sha, '要压入的提交号');
    }
    if (input.lastRetainedCommitRef !== null) {
      this.assertValidRev(input.lastRetainedCommitRef, '区间下界');
    }
    const root = await this.gate(input.path);
    const commits = await this.commitsForTodo(root, input.lastRetainedCommitRef);
    const todo = squashTodoLines(
      toTodoCommits(commits),
      new Set(input.toSquash),
      input.squashOnto,
    );
    const result = await this.runInteractiveRebase(
      root,
      todo,
      input.commitMessage,
      input.lastRetainedCommitRef,
      input.noVerify === true,
    );
    return { result };
  }

  /**
   * **把若干提交移动到某个提交之前**(上游 `lib/git/reorder.ts` 的 `reorder` 函数)。
   *
   * 与 {@link squashCommits} 同一条流水线,只有两处不同(逐字对着上游):
   * todo 全部是 `pick`(`reorder.ts:63-131`),且**没有**消息文件
   * (重排不改消息,`reorder.ts:133-142` 的 `opts` 里没有 `gitEditor`)。
   * @param input.path - 仓库路径。
   * @param input.toMove - 要移动的提交 sha。
   * @param input.beforeCommit - 移到它之前;`null` = 移到最前(上游 `:120-126`)。
   * @param input.lastRetainedCommitRef - 区间下界;`null` ⇒ `--root`。
   * @param input.noVerify - 上游 `RebaseInteractiveOptions.noVerify`。
   */
  public async reorderCommits(input: {
    path: string;
    toMove: readonly string[];
    beforeCommit: string | null;
    lastRetainedCommitRef: string | null;
    noVerify?: boolean;
  }): Promise<{ result: string }> {
    for (const sha of input.toMove) {
      this.assertValidRev(sha, '要移动的提交号');
    }
    if (input.beforeCommit !== null) {
      this.assertValidRev(input.beforeCommit, '移动到的位置');
    }
    if (input.lastRetainedCommitRef !== null) {
      this.assertValidRev(input.lastRetainedCommitRef, '区间下界');
    }
    const root = await this.gate(input.path);
    const commits = await this.commitsForTodo(root, input.lastRetainedCommitRef);
    const todo = reorderTodoLines(
      toTodoCommits(commits),
      new Set(input.toMove),
      input.beforeCommit,
    );
    const result = await this.runInteractiveRebase(
      root,
      todo,
      '',
      input.lastRetainedCommitRef,
      input.noVerify === true,
    );
    return { result };
  }

  /**
   * **继续变基** —— 上游 `lib/git/rebase.ts:444-546` 的 `continueRebase`
   * (`multi-commit` 的冲突档走到一半之后的**唯一**出路)。
   *
   * ## 为什么它不是一个「一条 argv」的动作(以及为什么以前没有这条路由)
   *
   * 上游那 100 行的顺序是:
   *
   * ```ts
   * for (const [path, resolution] of manualResolutions) { stageManualConflictResolution(…) }
   * const otherFiles = trackedFiles.filter(f => !manualResolutions.has(f.path))
   * await stageFiles(repository, otherFiles)                 // :468
   * const status = await getStatus(repository, false)         // :470
   * if (status == null) return RebaseResult.Aborted           // :471-476
   * const rebaseCurrentCommit = await readRebaseHead(repository)   // :478
   * if (rebaseCurrentCommit === null) return RebaseResult.Aborted  // :479-481
   * const trackedFilesAfter = status.workingDirectory.files
   *   .filter(f => f.status.kind !== Untracked)               // :483-485
   * if (trackedFilesAfter.length === 0) {
   *   const result = await git(['rebase','--skip', …])        // :522-535
   *   return parseRebaseResult(result)
   * }
   * const result = await git(['rebase','--continue', …])      // :537-542
   * return parseRebaseResult(result)
   * ```
   *
   * 2026-10-10 之前本插件**没有**这条路由(裁决记在 `README-probe-index.md` §八);
   * 用户随后裁决「都做」,于是按上面那张表逐跳落在这里。**没有** import 宿主镜像
   * `src/host/mirror/lib/git/rebase.ts`:那会把镜像的编排层拉进宿主包
   * (理由与 `mirror-git.ts` 的门缝同源 —— 宿主包只为一件事付那份字节)。
   * 逐跳的落地见下面每一段的注释。
   *
   * ## `manualResolutions` 那一跳为什么是空循环(如实说明)
   *
   * 上游的「手工标记为已解决(用我方/用对方)」状态机(`MultiCommitOperation*`)
   * **整个不在本仓**(`README-probe-index.md` §八)。客户端传上来的
   * `RebaseConflictState.manualResolutions` 因此恒为空 `Map`
   * (`changes-view.tsx` 的 `rebaseConflictState`),而 `ContinueRebase` 那颗按钮在
   * **还有冲突文件时本来就被禁用**(`continue-rebase.tsx:38-46` 的
   * `getConflictedFiles(...).length > 0`)⇒ 到达这里的前提就是「用户已经在命令行/编辑器里
   * 解决并 `git add` 过,或本来就没有冲突」。这一跳因此不做事,但**保留位置**,
   * 将来接上那套状态机时它就在这里。
   *
   * ## 与 `runInteractiveRebase` 的关系
   *
   * 失败档的判定**逐字复用**同一条口径(退出码 0 / `unresolved conflicts` /
   * `.git/rebase-merge` 标记 / 其它 ⇒ `'Error'`),理由见那边的方法注释:
   * 匹配 stderr 会随 git 版本与语言变,磁盘标记不会。
   * @param input.path - 仓库路径。
   * @param input.noVerify - 上游 `RebaseInteractiveOptions.noVerify`(`:528`/`:538`)。
   * @returns `{ result }` —— `RebaseResult` 的字符串值(与 `multi-commit/*` 同一形状)。
   */
  public async continueRebase(input: { path: string; noVerify?: boolean }): Promise<{ result: string }> {
    const root = await this.gate(input.path);
    const dir = await this.gitDir(root);
    if (dir === null) {
      throw new GitServiceError('bad-request', '读不到 .git 目录,无法继续变基。');
    }

    /*
     * ① 逐文件 stage(上游 `:450-468`)。
     *
     * 上游把 `files` 里**非未跟踪**的那些交给 `stageFiles`;manualResolutions 里的那些
     * 已经单独 stage 过(那一跳在本仓为空,见方法注释)。我们这里取的是**宿主自己的
     * status**(而不是客户端传的文件清单):两边必须是同一份事实,否则会出现
     * 「客户端说 stage 了、索引里没有」这种静默分叉。
     */
    const before = await this.status(root);
    const trackedBefore = before.files.filter((file) => file.untracked !== true).map((file) => file.path);
    if (trackedBefore.length > 0) {
      await this.must(addArgv(trackedBefore), root, '暂存手工解决的冲突');
    }

    /*
     * ② `.git/REBASE_HEAD` 读不到 ⇒ 变基已经不在进行中(上游 `:478-481` 回 `Aborted`;
     * 上游那 3 行 `log.warn` 的理由是「接着跑不安全」,我们照旧**不抛错** ——
     * `Aborted` 是 `RebaseResult` 的合法值,不是失败信封)。
     */
    let rebaseHead: string;
    try {
      rebaseHead = (await readFile(join(dir, 'REBASE_HEAD'), 'utf8')).trim();
    } catch {
      return { result: 'Aborted' };
    }
    if (rebaseHead === '') {
      return { result: 'Aborted' };
    }

    /*
     * ③ stage 之后的 tracked 文件(上游 `:483-485`)。`--skip` 与 `--continue` 的判据
     * 就是「这个提交还有没有内容要提交」:空 ⇒ `--skip`(否则 git 会因为空提交而停)。
     */
    const after = await this.status(root);
    const trackedAfter = after.files.filter((file) => file.untracked !== true);
    const skip = trackedAfter.length === 0;
    const argv: readonly string[] = skip
      ? ['rebase', '--skip', ...(input.noVerify === true ? ['--no-verify'] : [])]
      : ['rebase', '--continue', ...(input.noVerify === true ? ['--no-verify'] : [])];

    const timeoutMs = 180_000;
    const res = await this.runner.run(argv, root, {
      /*
       * `GIT_EDITOR: ':'`(no-op)—— 上游 `:492-495` 的 `baseOptions.env`。
       * 不设它时 `git rebase --continue` 会去开编辑器(交互式挂死)。
       */
      env: { GIT_EDITOR: ':', ...(this.credentialEnv() ?? {}) },
      timeoutMs,
    });
    if (res.timedOut === true) {
      throw timeoutFailure(argv, '继续变基', timeoutMs, res.stderr);
    }
    if (res.exitCode === 0) {
      return {
        result: /^Current branch [^ ]+ is up to date\.$/im.test(res.stdout)
          ? 'AlreadyUpToDate'
          : 'CompletedWithoutError',
      };
    }
    if (/unresolved conflicts?/i.test(res.stderr)) {
      return { result: 'OutstandingFilesNotStaged' };
    }
    if ((await this.operationMarkers(root)) === 'rebase') {
      return { result: 'ConflictsEncountered' };
    }
    this.options.log?.(`[continueRebase] git 既没成功也没停在变基中途:${firstLine(res.stderr)}`);
    return { result: 'Error' };
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

  /**
   * **哪些本地标签还没到远端** —— History 右键 `Delete tag <name>` 的启用判据。
   *
   * 上游的真身是 `lib/git/tag.ts:86` 的 `fetchTagsToPush(repository, remote, branchName)`:
   * 一次 `git push --dry-run --porcelain`(**只问、不推**),再从 porcelain 输出里认出
   * `[new tag]`。argv 的逐字对照、本仓与上游**唯一**那处有意分歧(`--tags` 取代
   * `--follow-tags`,因为我们的契约建轻量标签、而 `--follow-tags` 只认附注标签)、
   * 以及失败码的归属,全部写在 `unpushedTagsArgv` 的 JSDoc 上 —— 这里是它的宿主侧调用。
   *
   * **只读性**:`--dry-run` 不写远端(判据 `docs/probes/unpushed-tags-route-probe.mjs`
   * 的 A4:调用前后 `git ls-remote --tags` 的读数字节相同)。但它**要碰网络** ——
   * 远端不可达时按既有分类抛错,由路由转成信封;客户端那侧**静默保留旧值**
   * (不弹错:这是一个给菜单项用的辅助问询,不该打断用户)。
   *
   * **远端怎么选**:与 `push()` 同一套顺序(上游 remote 名 ⇒ 否则清单里的第一个),
   * 所以「问哪个远端」与「推送会推到哪里」是同一个答案,不会出现
   * 「按 origin 判可删、实际推到 upstream」那种错位。没有远端 ⇒ 回 `[]`
   * (没有远端就没有「推没推过」这回事,菜单项保持灰)。
   *
   * @param path - 仓库路径(过 `gate` 的白名单)。
   * @param remoteName - 可选的远端名(客户端一般不给,由宿主按上面那条顺序定)。
   * @returns 远端还没有的标签名(不含 `refs/tags/` 前缀);无远端时 `[]`。
   */
  public async unpushedTags(path: string, remoteName?: string): Promise<string[]> {
    const root = await this.gate(path);
    const names = parseRemotes((await this.must(remoteListArgv(), root, '读取远端')).stdout);
    if (names.length === 0) {
      return [];
    }
    const status = await this.status(root);
    const upstreamRemote =
      status.upstream !== null && status.upstream.includes('/')
        ? status.upstream.slice(0, status.upstream.indexOf('/'))
        : '';
    const remote = remoteName ?? (names.includes(upstreamRemote) ? upstreamRemote : names[0]);
    if (!names.includes(remote)) {
      throw new GitServiceError('bad-request', `这个仓库没有名为 ${remote} 的远端。`);
    }
    /*
     * `allow: [0, 1]` 对应上游 `successExitCodes: new Set([0, 1, 128])` 里**可解析**的那两个
     * (128 上游也是直接 `throw result.gitError`,只是它抛原始对象、我们走既有的分类器)。
     * 60s 超时:这是一次网络往返(远端不可达时 git 自己也要等 TCP),而菜单只是灰着等它。
     */
    const res = await this.must(unpushedTagsArgv(remote), root, '读取未推送的标签', {
      allow: [0, 1],
      ...(this.credentialEnv() !== undefined
        ? { env: this.credentialEnv() as Readonly<Record<string, string>> }
        : {}),
      timeoutMs: 60_000,
    });
    return parseUnpushedTags(res.stdout);
  }

  // ---------- stash 族(上游 `lib/git/stash.ts`,298 行) ----------

  /**
   * **列 stash**(上游 `getStashes`,`lib/git/stash.ts:45-88`)。
   *
   * 解析用的是镜像那份上游 parser(`createLogParser`),字段表来自
   * `STASH_LOG_FIELDS` —— 与 `stashLogArgv()` 用的是**同一份**,不可能漂移。
   *
   * 退出码 `128` = 这个仓库没有 `refs/stash` 引用(从没 stash 过,或根本不是仓库):
   * 上游把它当**空结果**而不是错误(`:58` 的 `successExitCodes: new Set([0, 128])`、
   * `:63-65`),这里同向。其余非 0 ⇒ 走既有分类器。
   *
   * ⚠️ **一处已实测的登记偏离**:上游在 `:87` 返回
   * `stashEntryCount: entries.length - 1`。用真仓库量过(见 `docs/probes/stash-probe.mjs`
   * 的 A 组):3 条 stash 时上游那条表达式的值是 **2**,而 `git stash list | wc -l` 是 **3**
   * —— 也就是说它是**上游自己的 off-by-one**(那个字段只喂遥测
   * `stashEntryCount - desktopStashEntryCount`,`app-store.ts:4165-4176`)。
   * 本函数返回**真总数**(`entries.length`):我们这一侧没有遥测,
   * 与其逐字搬一个已知会少 1 的数字(那属于「静默给坏数据」),不如如实返回并在
   * 这里写明分歧。消费方(客户端)判「有没有 stash」用的是 `desktopEntries`,
   * 与这个数字无关。
   * @param path - 仓库路径(过 `gate` 白名单)。
   * @returns `desktopEntries` = **只有带 `!!GitHub_Desktop<…>` 前缀**的那些条目
   *   (顺序 = git 的默认 reflog 顺序,LIFO,最新在前);
   *   `stashEntryCount` = `refs/stash` reflog 里的总条数(真值,见上)。
   */
  public async stashList(path: string): Promise<{
    desktopEntries: IStashEntryPayload[];
    stashEntryCount: number;
  }> {
    const root = await this.gate(path);
    const { parse } = createLogParser(STASH_LOG_FIELDS);
    const res = await this.runner.run(stashLogArgv(), root, {});
    if (res.exitCode !== 0 && res.exitCode !== 128) {
      throw classifyGitFailure(res.stderr, '读取贮藏条目');
    }
    if (res.exitCode === 128) {
      return { desktopEntries: [], stashEntryCount: 0 };
    }
    const entries = parse(res.stdout);
    const desktopEntries: IStashEntryPayload[] = [];
    for (const { name, message, stashSha, tree, parents } of entries) {
      const branchName = extractBranchFromStashMessage(message);
      if (branchName !== null) {
        desktopEntries.push({
          name,
          stashSha,
          branchName,
          tree,
          parents: parents.length > 0 ? parents.split(' ') : [],
        });
      }
    }
    return { desktopEntries, stashEntryCount: entries.length };
  }

  /**
   * **建 stash**(上游 `createDesktopStashEntry`,`lib/git/stash.ts:143-207`)。
   *
   * 两步,**顺序不能反**:
   *  1. 未跟踪文件先整份 `git add`(`:148-155` 的
   *     `stageFiles(repository, untrackedFilesToStage.map(x => x.withIncludeAll(true)))`。
   *     `withIncludeAll(true)` 的含义就是「这一行按整份文件纳入」,而我们的
   *     `addArgv` 是把整个文件加进索引 ⇒ 语义等价)。理由见
   *     `git-argv.ts` 的 `stashPushArgv` JSDoc(desktop/desktop#8085);
   *  2. `git stash push -m '!!GitHub_Desktop<branch>'`。
   *
   * **失败语义(逐字照抄上游 `:161-199`)**:`git stash push` 在**退出码 1** 时,
   * 上游去看 stderr 里有没有 `^error: ` 开头的行 ——
   *  - 有 ⇒ 真的失败,`reject`(我们 ⇒ 走既有分类器抛);
   *  - 没有 ⇒ 上游认为「stash 其实建成了」并**继续**(`log.info` 后返回 `e.result`)。
   *    实测有一档确实如此(见探针 B 组),也有一档**不是**:
   *    unborn 仓库里 `git stash push` 也是退出码 1 且 stderr 无 `error: `,但
   *    **没有**任何 stash 被建出来(上游 `:164-177` 的注释自己承认了这件事)。
   *    我们照上游的判据返回 `true`,但**不**因此发「成功」语义的假数据:
   *    客户端的动作收尾一律重新拉一次 `stash/list`,所以那种情况下
   *    `stashEntry` 仍为 `null`,空态卡不会出现。
   *
   * `stdout === 'No local changes to save\n'` ⇒ 返回 `false`(上游 `:202-204`:
   * 「没有本地改动可存」在 git 眼里不是错误)。
   * @param path - 仓库路径。
   * @param branch - 建 stash 时所在的分支名(进消息,决定它属于哪个分支)。
   * @param untrackedFiles - 工作区里的**未跟踪**文件路径(仓库内相对路径)。
   * @returns 是否认为「建成了一条 stash」。
   */
  public async createStashEntry(
    path: string,
    branch: string,
    untrackedFiles: readonly string[],
  ): Promise<boolean> {
    const root = await this.gate(path);
    if (untrackedFiles.length > 0) {
      await this.must(addArgv(untrackedFiles), root, '暂存未跟踪文件(贮藏前)');
    }
    const message = createDesktopStashMessage(branch);
    const res = await this.runner.run(stashPushArgv(message), root, {});
    if (res.exitCode !== 0) {
      if (res.exitCode === 1) {
        // 只看**行首**的 `error: `(上游 `:181` 的 `/^error: /m`)。
        if (/^error: /m.exec(res.stderr) !== null) {
          throw classifyGitFailure(res.stderr, '贮藏改动');
        }
        // 没有 error: ⇒ 按上游认为「stash 建成了」,继续。
      } else {
        throw classifyGitFailure(res.stderr, '贮藏改动');
      }
    }
    if (res.stdout === 'No local changes to save\n') {
      return false;
    }
    return true;
  }

  /**
   * **丢弃一条 stash**(上游 `dropDesktopStashEntry`,`lib/git/stash.ts:219-229`)。
   *
   * 上游是「按 sha 重新列一遍、找到那条条目、用它的 `name` 去 drop」——
   * **不是**直接用调用方给的 sha 拼引用。这样做的好处是:sha 已经不在 reflog 里
   * (比如刚被 pop 掉)时**安静地什么都不做**,而不是报一个用户看不懂的 git 错误。
   * 这里照抄这段判断。
   *
   * ⚠️ **一处加固(与上游的差)**:`stashSha` 先过 {@link assertStashSha}。
   * 上游对「sha 不在 reflog 里」是**安静地什么都不做**,这里保持那个语义(有效 sha、
   * 只是已经不在清单里 ⇒ no-op);但**形状不对的对象名**(比如 `--all`)一律
   * `bad-request` —— 否则「传错了 sha」与「这条 stash 已经不在了」在回执上无法区分,
   * 而调用方(客户端)会以为丢弃成功了。产品路径传的是列表里拿到的 sha,不受影响。
   * @param path - 仓库路径。
   * @param stashSha - stash 那条提交的 sha(不是引用名)。
   */
  public async dropStashEntry(path: string, stashSha: string): Promise<void> {
    const sha = this.assertStashSha(stashSha);
    const root = await this.gate(path);
    const entry = await this.stashEntryMatchingSha(root, sha);
    if (entry !== null) {
      await this.must(stashDropArgv(this.assertStashName(entry.name)), root, '丢弃贮藏');
    }
  }

  /**
   * **把一条 stash 应用回工作区并删掉它**(上游 `popStashEntry`,`lib/git/stash.ts:238-271`)。
   *
   * argv 逐字:`git stash pop --quiet <name>`(`:248`)。名字同样来自
   * 「按 sha 重新列一遍」(`:245` 的 `getStashEntryMatchingSha`)。
   *
   * **冲突语义(逐字照抄 `:251-269`)**:上游把 `MergeConflicts` 列进 `expectedErrors`
   * —— 也就是「pop 出冲突」**不算**要弹给用户的错误。git 在那种情况下退出码 1、
   * 且**不会**把 stash 删掉(用户还得留着它);而上游的兜底是:
   * **退出码 1 且 stderr 为空 ⇒ 其实已经应用成功、只是没自动 drop ⇒ 手工 drop**。
   * 两件事的分界就是 `stderr` 空不空,所以这里必须把 stderr 原样拿到手再判。
   * 其余失败(冲突带 stderr、别的退出码)⇒ 走既有分类器(冲突会落 `merge-conflicts`)。
   *
   * ⚠️ 与 {@link dropStashEntry} 同一处加固:sha 形状不对 ⇒ `bad-request`(理由写在那边)。
   * @param path - 仓库路径。
   * @param stashSha - stash 那条提交的 sha。
   */
  public async popStashEntry(path: string, stashSha: string): Promise<void> {
    const sha = this.assertStashSha(stashSha);
    const root = await this.gate(path);
    const entry = await this.stashEntryMatchingSha(root, sha);
    if (entry === null) {
      return;
    }
    const res = await this.runner.run(stashPopArgv(this.assertStashName(entry.name)), root, {});
    if (res.exitCode === 0) {
      return;
    }
    if (res.exitCode === 1 && res.stderr.length === 0) {
      /*
       * ⚠️ **一处有意分歧(2026-10 实测,带读数;这是本族唯一一处不逐字照抄的地方)**
       *
       * 上游原文是**直接** `dropDesktopStashEntry(repository, stashSha)`
       * (`lib/git/stash.ts:262-266`),它的判据是「退出码 1 且 **stderr 为空** ⇒
       * pop 其实成功了、只是没自动 drop」。**实测这个判据会把冲突档误判成成功**:
       *
       * ```
       * $ git stash pop --quiet refs/stash@{0}     # 故意让 a.txt 冲突
       * exit=1
       * stdout(51B) = "The stash entry is kept in case you need it again."
       * stderr(0B)                                  ← 冲突信息走的是 **stdout**
       * $ git rev-parse refs/stash                  # git **特意**把存底留着
       * 03346ce7…   (退出码 0)
       * ```
       *
       * ⇒ 照抄那三行 = 把用户**唯一的一份**存底删掉,而界面上只看到「恢复成功」。
       * `--quiet` 恰恰是上游自己加的(`:248`),所以这不是偶发:凡是 pop 出冲突就命中。
       *
       * 这里把「pop 到底成没成」的判据换成**索引里有没有未合并条目**
       * (`git ls-files -u`,冲突时它逐条列出 stage 1/2/3;干净应用时为空)。
       * 还有未合并条目 ⇒ **不 drop**,抛 `merge-conflicts`(叫用户解决后可以再恢复一次)。
       * 判据是「有没有冲突」,不是「stderr 空不空」—— 其余语义一个字没改。
       *
       * **退役条件**:哪天本仓放弃「保留存底」这条取舍(或上游改了那段判据),
       * 可以回到逐字照抄;在那之前,**不要**把这三行删掉换回裸 drop。
       */
      const unmerged = await this.runner.run(['ls-files', '-u'], root, {});
      if (unmerged.stdout.trim() !== '') {
        throw new GitServiceError(
          'merge-conflicts',
          '恢复贮藏时遇到冲突:这条贮藏**已保留**,解决冲突后可以再恢复一次。',
        );
      }
      // 上游 `:257-266`:pop 成功但没自动 drop ⇒ 手工 drop(判据换成了「索引里没有未合并条目」)。
      await this.dropStashEntry(root, sha);
      return;
    }
    throw classifyGitFailure(res.stderr, '恢复贮藏');
  }

  /**
   * **某条 stash 改了哪些文件**(上游 `getStashedFiles`,`lib/git/stash.ts:279-297`)。
   *
   * argv 逐字见 `stashShowFilesArgv`;解析是 `parseRawLogWithNumstat` 的逐字搬运。
   * 上游传的父提交是 `` `${stashSha}^` ``(`:297`)。
   * @param path - 仓库路径。
   * @param stashSha - stash 那条提交的 sha。
   * @returns 文件清单(含 `AppFileStatus` 形状的状态)与增删总量。
   */
  public async getStashedFiles(
    path: string,
    stashSha: string,
  ): Promise<{ files: IStashFileEntry[]; linesAdded: number; linesDeleted: number }> {
    const root = await this.gate(path);
    const sha = this.assertStashSha(stashSha);
    const res = await this.must(stashShowFilesArgv(sha), root, '读取贮藏的文件清单');
    return parseRawLogWithNumstat(res.stdout, sha, `${sha}^`);
  }

  /**
   * **把一条 stash 挪到另一个分支名下**(上游 `moveStashEntry`,`lib/git/stash.ts:95-116`)。
   *
   * 三步(argv 逐字):
   *  1. `git commit-tree <原 stash 的父>… -m 'On <branch>: !!GitHub_Desktop<<branch>>'
   *     --no-gpg-sign <原 stash 的 tree>`(`:104`);
   *  2. `git stash store -m <同一条消息> <新提交>`(`:110`);
   *  3. `dropDesktopStashEntry(原 sha)`(`:115`)。
   *
   * 消息里那句 `On <branch>: ` 是**必须的**:`extractBranchFromStashMessage` 的正则
   * 没有 `^` 锚(`stash.ts:27`),因为它就是为这种消息写的;少了那一截,
   * 「哪些条目属于哪个分支」仍然能解析,但和 git 自己 `stash store` 出来的消息形状
   * 不一致(上游 `:100` 逐字如此)。
   *
   * ⚠️ **触发点在界面上还没有**(诚实登记):用它的上游弹窗是
   * `ui/stash-changes/stash-and-switch-branch-dialog.tsx`(切分支时
   * 「把改动带到新分支」那一档),而那条流程属于**检出/切分支**面,
   * 不在本泳道接线范围内。本路由先把机制建好,权限/分支校验与其它路由同源。
   * @param path - 仓库路径。
   * @param stashSha - 原 stash 的 sha。
   * @param branchName - 目标分支名(进消息)。
   * @returns 新建的那条 stash 提交的 sha。
   */
  public async moveStashEntry(
    path: string,
    stashSha: string,
    branchName: string,
  ): Promise<string> {
    const root = await this.gate(path);
    const sha = this.assertStashSha(stashSha);
    const entry = await this.stashEntryMatchingSha(root, sha);
    if (entry === null) {
      throw new GitServiceError('bad-request', `找不到贮藏条目 ${sha}。`);
    }
    const message = `On ${branchName}: ${createDesktopStashMessage(branchName)}`;
    const { stdout: commitId } = await this.must(
      stashCommitTreeArgv(entry.parents, message, entry.tree),
      root,
      '把贮藏挪到分支',
    );
    await this.must(stashStoreArgv(message, commitId.trim()), root, '把贮藏挪到分支');
    await this.dropStashEntry(root, sha);
    return commitId.trim();
  }

  /**
   * 按 sha 找一条 **Desktop 建的** stash(上游 `getStashEntryMatchingSha`,`stash.ts:209-212`)。
   * @param root - **已过 `gate`** 的仓库根(调用方不要再 gate 一次)。
   * @param sha - stash 提交的 sha。
   */
  private async stashEntryMatchingSha(root: string, sha: string): Promise<IStashEntryPayload | null> {
    const { desktopEntries } = await this.stashList(root);
    return desktopEntries.find((e) => e.stashSha === sha) ?? null;
  }

  /**
   * stash 的 sha 守卫(上游把 sha 直接拼进 `stash show <sha>`,见 `stash.ts:283-293`)。
   * 这里只放行十六进制对象名(长度 7–64,兼容 sha256 仓库),
   * 否则 `stash show --all` 这种「以 `-` 开头的东西」会变成选项注入。
   * @param sha - 调用方给的 sha。
   * @returns 校验通过的原值。
   */
  private assertStashSha(sha: string): string {
    if (!isSafeObjectName(sha)) {
      throw new GitServiceError('bad-request', '贮藏条目的提交号不合法。');
    }
    return sha;
  }

  /**
   * stash **引用名**守卫 —— 列表里那条 `%gD` 的输出(`refs/stash@{N}`)在拼进
   * `stash pop` / `stash drop` 之前过一遍 {@link isSafeStashName}。
   *
   * 这条守卫**不是**「因为 git 不接受 `--end-of-options`」(实测它是接受的,
   * 见 `git-argv.ts` 的 `isSafeStashName` JSDoc),而是纵深防御:
   * 名字来自我们自己跑的 `git log -g`,理论上永远是那个形状 ——
   * 万一解析路径将来变了,这里会**响亮地报内部错误**,而不是把一段任意字符串
   * 拼进 git 的 argv。
   * @param name - 待校验的 stash 全名。
   */
  private assertStashName(name: string): string {
    if (!isSafeStashName(name)) {
      throw new GitServiceError('internal', `贮藏引用名不是预期形状:${name}`);
    }
    return name;
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

  /**
   * `--global` 配置读写用的工作目录。
   *
   * ## 为什么不能沿用「调用方给的 path」
   *
   * `git config --global` 与工作树**无关**,但 `config()` / `setConfig()` 原先无条件过
   * `gate(path)`(`:206-214`,`allowedRoots` 白名单)。而客户端读全局身份时传的 path 是
   * **`'.'`**(`src/core/desktop/lib/git/config.ts:203` 的 `getConfigValueInPath(name, null, …)`
   * ⇒ `path ?? '.'`),于是「宿主进程 cwd 不在任何已登记仓库里」时这条读**必然**失败:
   *
   * ```
   * config-get 失败: 这个目录不是 git 仓库。      ← 2026-10 探针实测原文
   * ```
   *
   * 后果是 Git 页的三个字段(姓名 / 邮箱 / 默认分支)与『编辑全局 Git 配置』那行链接
   * **永远空着**,而客户端 `getGlobalConfigValue()` 把 `!ok` 吞成 `null`
   * (`config.ts:204-206`)⇒ 界面上一个字的错误都没有。
   *
   * ## 为什么这不是放宽安全边界
   *
   * `--global` 从不读写任何仓库:`gate` 要守的是「git 只能碰用户显式添加过的仓库」,
   * 而全局配置文件在用户主目录里,是**设置界面本来就要编辑的东西**。而且能力上没有多一分
   * ——任何**已登记**仓库路径本来就能执行同一件事(`path` 只当 cwd 用)。
   *
   * 取目录的顺序:全局 gitconfig 所在目录(`homedir()`,由
   * {@link globalGitConfigPath} 算出,一定存在且与 `--global` 语义一致)
   * → 第一个已登记仓库 → `process.cwd()`。
   * @returns 一个存在的工作目录。
   */
  private globalConfigCwd(): string {
    const configPath = globalGitConfigPath();
    if (configPath !== null) {
      return dirname(configPath);
    }
    const roots = this.options.allowedRoots();
    return roots[0] ?? process.cwd();
  }

  async config(path: string, key: string, scope: 'local' | 'global' = 'local'): Promise<string | null> {
    // 见 `globalConfigCwd()`:全局作用域不读工作树,所以**不过** gate。
    const root = scope === 'global' ? this.globalConfigCwd() : await this.gate(path);
    const res = await this.optional(configGetArgv(key, scope), root);
    return res.exitCode === 0 ? parseConfigValue(res.stdout) : null;
  }

  async setConfig(path: string, key: string, value: string, global = false): Promise<void> {
    // 同上;读与写必须走同一条 cwd 规则,否则会出现「读得到、写不进」。
    const root = global ? this.globalConfigCwd() : await this.gate(path);
    await this.must(configSetArgv(key, value, global), root, `写入配置 ${key}`);
  }

  /**
   * 删掉一条配置(`git config [--global] --unset-all <key>`)—— 上游
   * `lib/git/config.ts:279-297` 的 `removeConfigValueInPath` **逐字同一条 argv**
   * (argv 早已在 `git-argv.ts` 的 `configUnsetArgv`,这里只是把它接到路由上)。
   *
   * 唯一的调用点是仓库设置弹窗 ▸ Git Config 页把作用域从 Local 切回 Global 时
   * (`repository-settings.tsx:353-356`):上游删掉**仓库本地**的 `user.name` /
   * `user.email`,让 git 回落到全局身份。
   *
   * ⚠️ 与上游一样**不吞**退出码:键本来就不存在时 `--unset-all` 返回非零,
   * 于是弹窗的 `errors` 里会出现一条(上游同样如此)。
   * @param path - 仓库内任意路径(过 `gate`)。
   * @param key - 配置键。
   * @param global - `true` 时删全局配置。
   */
  public async unsetConfig(path: string, key: string, global = false): Promise<void> {
    const root = global ? this.globalConfigCwd() : await this.gate(path);
    await this.must(configUnsetArgv(key, global), root, `删除配置 ${key}`);
  }

  /**
   * `git config --get <key>`,**不带作用域** —— 读的是 git 的合并链
   * (`system → global → local → worktree → command`)。
   *
   * 为什么不是 `config(path, key, 'local')`:后者的 argv 带 `--local`。上游
   * `getConfigValue(repository, key)` 的 `onlyLocal` 默认 **false**
   * (`references/desktop/app/src/lib/git/config.ts:11-23`),唯一消费方是
   * `.gitignore` 的行尾规整(`lib/git/gitignore.ts:204-205`)。argv 的出处与
   * 「为什么 `--local` 在这里是错的」写在 `git-argv.ts` 的
   * `configGetEffectiveArgv` 上。
   *
   * ⚠️ 这是**私有**的:它不构成新的产品能力面,只服务 `.gitignore` 的格式化。
   * @param root - **已过 gate** 的仓库根(调用方负责,避免二次 gate)。
   * @param key - 配置键。
   */
  private async configEffective(root: string, key: string): Promise<string | null> {
    const res = await this.optional(configGetEffectiveArgv(key), root);
    return res.exitCode === 0 ? parseConfigValue(res.stdout) : null;
  }

  /** `.gitignore` 三个操作的公共输入:已过 gate 的根 + 配置读取接缝。 */
  private gitIgnoreIo(root: string): gitignore.IGitIgnoreIo {
    return { root, readConfig: (key) => this.configEffective(root, key) };
  }

  /**
   * 读仓库根 `.gitignore` 的全文(上游 `lib/git/gitignore.ts:81-96`)。
   *
   * 文件不存在 ⇒ `null`;符号链接 ⇒ `bad-request`(**不**折成 `null`)。
   * @param path - 仓库内任意路径(只用来过 `gate` 定位仓库根,与上游同口径)。
   */
  public async readGitIgnore(path: string): Promise<string | null> {
    const root = await this.gate(path);
    return gitignore.readGitIgnoreAtRoot(root);
  }

  /**
   * 把全文写回仓库根 `.gitignore`(上游 `gitignore.ts:104-135`)。
   *
   * 文本为 `''` ⇒ 删文件。行尾按 `core.autocrlf` / `core.safecrlf` 规整。
   * @param path - 仓库内任意路径(过 `gate`)。
   * @param text - 全文。
   */
  public async saveGitIgnore(path: string, text: string): Promise<void> {
    const root = await this.gate(path);
    await gitignore.saveGitIgnore(this.gitIgnoreIo(root), text);
  }

  /**
   * 往 `.gitignore` 追加规则。
   *
   * `escape=false` ⇒ 上游 `appendIgnoreRule`(`gitignore.ts:138-154`,**原样**追加,
   * 供「忽略此模式」);`escape=true` ⇒ 上游 `appendIgnoreFile`(`:161-175`,
   * 先过 `escapeGitSpecialCharacters`)。
   * @param path - 仓库内任意路径(过 `gate`)。
   * @param patterns - 一条或多条规则 / 文件路径。
   * @param escape - 是否按上游的文件路径转义表处理。
   */
  public async appendGitIgnore(path: string, patterns: readonly string[], escape: boolean): Promise<void> {
    const root = await this.gate(path);
    const io = this.gitIgnoreIo(root);
    // 展开成可变数组:上游那两个函数的签名是 `string | string[]`
    // (`gitignore.ts:140`/`:163`),`Array.isArray` 对 `readonly T[]` 不产生收窄。
    const list = [...patterns];
    if (escape) {
      await gitignore.appendIgnoreFile(io, list);
    } else {
      await gitignore.appendIgnoreRule(io, list);
    }
  }

  async fetch(path: string, remote?: string): Promise<void> {
    const root = await this.gate(path);
    const names = parseRemotes((await this.must(remoteListArgv(), root, '读取远端')).stdout);
    if (names.length === 0) {
      throw new GitServiceError('no-upstream', '这个仓库还没有远端。');
    }
    const targets = remote !== undefined && remote !== '' ? [remote] : names;
    try {
      for (const name of targets) {
        // `progress: true` + `syncProgressOptions` ⇒ 与上游 `lib/git/fetch.ts:52-84`
        // 同形:一条 `--progress`,stderr 逐行喂给 `FetchProgressParser`。
        await this.must(fetchArgv(name, { progress: true }), root, `抓取 ${name}`, this.syncProgressOptions('fetch', root, {
          ...(this.credentialEnv() !== undefined ? { env: this.credentialEnv() as Readonly<Record<string, string>> } : {}),
          timeoutMs: 120_000,
        }));
        // 抓取后同步远端默认分支指向;失败不致命(照 Desktop)。
        await this.optional(['remote', 'set-head', '-a', '--', name], root);
      }
    } finally {
      // 动作结束 ⇒ 进度立刻作废(上游 `performFetch` 的 `finally` 里
      // `updatePushPullFetchProgress(repository, null)`,`app-store.ts:6004`)。
      this.syncProgressByRoot.delete(root);
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
    try {
      // 上游 `lib/git/pull.ts:26` 的 `--progress`(位置同 fetch/push)。
      await this.must(pullArgv({ remote, rebase, ffOnly, progress: true }), root, '拉取', this.syncProgressOptions('pull', root, {
        ...(this.credentialEnv() !== undefined ? { env: this.credentialEnv() as Readonly<Record<string, string>> } : {}),
        timeoutMs: 180_000,
      }));
    } finally {
      this.syncProgressByRoot.delete(root);
    }
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
    try {
      /*
       * `progress: true` + `syncProgressOptions` —— 上游 `lib/git/push.ts:77-99`
       * 与 `app-store.ts:5313-5329` 的宿主侧等价物:
       * `git push --progress` 的 stderr 逐行喂给 `PushProgressParser`,
       * 解析结果落进 `syncProgressByRoot`,由 `sync-progress` 路由读出去。
       */
      await this.must(pushArgv({
        remote,
        branch: status.branch,
        ...(remoteBranch !== undefined && remoteBranch !== '' ? { remoteBranch } : {}),
        setUpstream: needUpstream,
        forceWithLease: opts.force === true,
        noVerify: opts.noVerify === true,
        progress: true,
      }), root, opts.force === true ? '强推' : '推送', this.syncProgressOptions('push', root, {
        ...(this.credentialEnv() !== undefined ? { env: this.credentialEnv() as Readonly<Record<string, string>> } : {}),
        timeoutMs: 180_000,
      }));

      /*
       * ★ **推送之后的远端刷新** —— 上游 `app-store.ts:5338-5369` 那一步,今天缺的就是它。
       *
       * 上游的 `performPush` 在 `pushRepo(...)` 返回、且 `aborted` 检查之后有**四步**:
       * `fetchRemotes([safeRemote])`(`:5341-5347`)→ `fastForwardBranches`(`:5357`)
       * → `refreshBranchProtectionState`(`:5363`)→ `_refreshRepository`(`:5369`)。
       * 我们的 `refreshAfterNetworkAction` 只 `refreshAll()`(**零 fetch**)⇒
       * 实测缺口是 `refs/remotes/origin/*` 在推送之后**仍然是陈旧的**
       * (另一个 clone 推过的提交不出现)。见 `docs/push-origin-chain-mirror-audit.md` §5。
       *
       * 这一步**走上游那份代码**:`src/host/mirror-git.ts` 的
       * `fetchRemotesAfterPush` → 镜像 `lib/stores/git-store.ts:1042` 的
       * `GitStore.fetchRemotes` → `fetch()`(`lib/git/fetch.ts`,逐字)→
       * `updateRemoteHEAD`(`lib/git/remote.ts`,逐字)。**没有一行是我们重写的。**
       *
       * 时序与失败语义**照上游**:
       *   · 排在 `push` 之后、同一个 `try` 里 ⇒ 推送失败**不会**触发 fetch;
       *   · `fetchRemote` 走 `performFailableOperation` ⇒ **fetch 失败不把推送判成失败**
       *     (推送已经成功了),错误经 `GitStore.onDidError` 播进宿主日志;
       *   · 进度落进**同一个** `syncProgressByRoot`(`kind: 'fetch'`),
       *     所以客户端那条 `busy` 轮询会看到「推送 → 刷新」连续的一条时间线,
       *     而不是另起一条。
       */
      await this.refreshRemotesAfterPush(root, remote);
    } finally {
      // 上游 `performPush` 的 `updatePushPullFetchProgress(repository, null)`
      // (`app-store.ts:5374`)—— 放在 `finally` 里,失败路径同样作废。
      this.syncProgressByRoot.delete(root);
    }
  }

  /**
   * **推送之后把远端刷新一遍** —— 上游 `app-store.ts:5341-5347` 那一步的宿主入口。
   *
   * 实现全在 `src/host/mirror-git.ts`(它去调**镜像的那份** `GitStore.fetchRemotes`);
   * 这里只做两件宿主才做得了的事:
   *   1. 把 `git remote get-url <name>` 的**结果 URL** 交给上游 —— 上游的
   *      `IRemote` 是 `{name, url}`,而它拿 `url` 去 `envForRemoteOperation` 里
   *      解析代理,所以给一个猜的 URL 是错的;
   *   2. 把上游的 `IFetchProgress` 折成宿主那条进度契约
   *      (`SyncProgressPayload`,`kind: 'fetch'`)。
   *
   * ⚠️ **吞掉异常是刻意的,不是偷懒**:推送**已经成功**了。上游的
   * `GitStore.fetchRemote` 内部就把失败折成 `undefined` + 一条 `did-error`
   * (那一条已被 `mirror-git.ts` 接到宿主日志),所以正常路径根本不会抛;
   * 这里的 catch 只为挡住「模块加载 / 读远端 URL」这类**与网络无关**的意外,
   * 免得把一个成功的推送报成失败。
   *
   * @param root - 仓库工作区根(已过 `gate`)。
   * @param remote - 刚推的那个远端名。
   */
  private async refreshRemotesAfterPush(root: string, remote: string): Promise<void> {
    const afterPushFetch = this.options.afterPushFetch;
    if (afterPushFetch === undefined) {
      /*
       * **未注入 ⇒ 不做**(与接线前的行为逐字相同)。
       *
       * 这不是「默默跳过」:调用方(生产是 `src/index.ts`)没接这条能力,
       * 而探针依赖这个默认值来量「没接它」那一档。判据见
       * `docs/probes/host-mirror-wiring-probe.mjs` 的 B 组阴性对照。
       */
      return;
    }
    try {
      const url = firstLine((await this.must(remoteUrlArgv(remote), root, '读取远端地址')).stdout);
      if (url === '') {
        this.warn(`远端 ${remote} 没有可用的 URL,推送后的刷新跳过`);
        return;
      }
      await afterPushFetch(root, { name: remote, url }, progress => {
        this.syncProgressByRoot.set(root, {
          kind: 'fetch',
          // 上游 `IProgress.description` 是**可选**的(`models/progress.ts:24`),
          // 而宿主那条契约的 `description` 是必填的字符串 ⇒ 缺席折成空串。
          description: progress.description ?? '',
          value: progress.value,
          done: false,
        });
      });
    } catch (error) {
      this.warn(`推送后的远端刷新失败(推送本身已成功):${String(error)}`);
    }
  }

  /**
   * **克隆目标路径的预检** —— 上游 `ui/clone-repository/clone-repository.tsx:687-733` 的
   * `validateClonePath()` 在宿主侧的等价物。
   *
   * ## 为什么必须落在宿主半(不是「顺手放这边」)
   *
   * 上游那个函数体就是 `await readdir(path)` + `catch (error.code)`;而**浏览器半没有
   * 文件系统**:`src/client/shim-node-fs-promises.ts` 只有 `access` / `stat` / `readFile`
   * (且都靠注入式宿主钩子),**没有 `readdir`**;路由表里也没有任何「列一个任意目录」
   * 的端点(`repo/tree` 需要一个**已登记仓库**的路径,而克隆目标按定义还不是仓库)。
   * ⇒ 判定只能发生在能看见磁盘的一侧。
   *
   * ## 逐档对齐(消息在客户端,见 `src/client/clone-dialog.tsx` 的 `clonePathMessage`)
   *
   * 先 `stat` 再 `readdir`,而不是直接 `readdir` 再读 errno —— **语义等价**,但两种
   * 「不是目录」的分岔(路径是一个文件 / 路径中间有一段是文件)都会先被 `stat` 归到
   * `isDirectory() === false` 这一支,不必依赖 `readdir` 的 errno 风味。
   *
   * 未知 errno **一律折成 `'unreadable'`**(绝不放行):上游那一支也是「记日志 + 报
   * 『读不到这个路径』」,而不是当成可以克隆。
   *
   * @param path - 用户输入的克隆目标绝对路径。
   * @returns 上游那五种结局的分类(见 `ClonePathKind`)。
   */
  public async inspectClonePath(path: string): Promise<ClonePathKind> {
    try {
      const info = await stat(path);
      if (!info.isDirectory()) {
        // 上游 `readdir` 对文件路径抛 ENOTDIR ⇒ 'There is already a file with this name…'。
        return 'not-a-directory';
      }
      const entries = await readdir(path);
      return entries.length === 0 ? 'empty' : 'non-empty';
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      // 目录不存在 ⇒ 上游返回 null(允许克隆,git 自己建)。
      if (code === 'ENOENT') {
        return 'absent';
      }
      // 路径中间有一段是文件 ⇒ 上游同样归到 ENOTDIR 那一句。
      if (code === 'ENOTDIR') {
        return 'not-a-directory';
      }
      return 'unreadable';
    }
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

/**
 * `CommitEntry[]`(**log 顺序 = 新 → 旧**)→ todo 拼装需要的两列。
 *
 * 上游 `squash.ts:74` / `reorder.ts:64` 也是「从 `commits.length - 1` 往 0 走」,
 * 所以这里**不排序** —— 保持 `git log` 给的顺序就是上游那份 `getCommits` 的顺序。
 * `summary` 取 `subject`(同一次 `git log` 的 `%s`)。
 * @param commits - `logArgv` + `parseLog` 的结果。
 */
function toTodoCommits(commits: readonly CommitEntry[]): ITodoCommit[] {
  return commits.map((c) => ({ sha: c.sha, summary: c.subject }));
}

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
