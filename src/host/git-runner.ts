/**
 * host 侧的 git 执行缝:生产走 ctx.subprocess(受管子进程),测试可注入替身。
 *
 * ## 两种取输出的方式(这次改动把它们的语义**说清楚**了)
 *
 * | 方式 | 方法 | 语义 |
 * |---|---|---|
 * | 收集 | `run()` | 有界内存尾部;超限时**尾部**保留、头部丢弃,`stdoutTruncated` 为真 |
 * | 流 | `open()` | 原始 stdout 管道,调用方自己跳字节/取区间,内存只按**需要**增长 |
 *
 * **收集模式保留尾部**(宿主 `OutputCollector.push` 从头丢块),这对「诊断 stderr」
 * 是对的(错误在末尾),对**内容**是错的:一个大 patch / 大 blob 的尾部**看起来
 * 就是合法内容**,只是从中间开始。所以内容路径**一律不许**把收集结果当完整内容用:
 *
 *  - 上限(`MAX_BLOB_BYTES`,2 MiB)由 `core/blob.ts` 单点定义,并且**必须低于**
 *    {@link OUTPUT_CAP_BYTES}(4 MiB)—— 否则决定权会悄悄落回收集器;
 *  - 超过自己上限的请求**在取内容之前**就被拒(`git-service.blobInfo` 先量大小);
 *  - `Range` 走 {@link GitRunner.open} 的**流**,根本不经过收集器。
 *
 * 之前 `run()` 的文本读取把 `readFrom()` 的 `lossy` 标志**丢掉了**(只取 `.text`),
 * 于是「收集器截尾」在文本路径上完全不可见 —— `diff` 路由就是这么把 >4MiB 的补丁
 * 当成完整补丁交给渲染层的(docs/design.md §10.8 记过)。现在文本读取也如实上报。
 *
 * ## `env` 现在有**两个来源**(2026-10)
 *
 * 调用方的 `opts.env`(凭据注入,`git-service.ts:242` 的 `credentialEnv`)之外,
 * 还有第三参 {@link GitSpawnEnvProvider} 给的 **shell 环境**(hooks 偏好,
 * 见 `host/hooks-env.ts`)。合并规则写在 {@link mergeSpawnEnv}:显式项赢、
 * provider 抛错降级成「不注入」。`open()`(内容流)不接 provider —— 它读 blob、
 * 不跑钩子,而且那条 spec 本来就没有 env 槽。
 *
 * 关于 stdin:subprocess 服务的 stdio 契约只声明 'ignore',但 handle 在
 * 非 ignore 时确实带 .stdin 流(实现里 stdinMode === 'pipe' ? stdin : undefined)。
 * 因此需要喂 stdin 的调用(部分暂存的补丁、按 NUL 分隔的路径列表、提交消息)
 * 走 spec 里 stdin:'pipe' + handle.stdin.write/end,并保留降级路径。
 * @module dsh-git/host/git-runner
 */

import { withGitBinary } from '../core/git-argv.ts';

/** 一次 git 调用的结果。 */
export interface GitRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /**
   * `binary: true` 时的 base64 内容。
   *
   * 为什么是 base64 而不是 Buffer:结果要能穿过 HTTP JSON 到浏览器半,
   * 字节数组在 JSON 里会膨胀成数字数组。base64 是唯一稳妥的传输形态。
   * **新代码不该再用它取内容**:原始字节有专门的 `GET /dsh-git/blob` 路由
   * (不膨胀、能 Range、能缓存),base64 只剩「老 host 兜底」这一条路。
   */
  stdoutBase64?: string;
  /**
   * stdout **被收集器截断**时为 true(文本与二进制路径都上报)。
   *
   * 为什么必须暴露:收集器的上限是 `OUTPUT_CAP_BYTES`(4MB),超限时保留的是**尾部**。
   * 也就是说内容是**残缺**的 —— 若当成合法内容交出去,渲染层会拿到一段
   * 「从中间开始、但看起来合法」的文本或一张坏图。调用方必须据此走「太大」分支。
   */
  stdoutTruncated?: boolean;
  /**
   * stdout **观测到的总字节数**(不只是保留下来的那部分)。
   *
   * 有了它,「太大」可以报出**真实大小**(`3.2 MB, limit 2 MB`),而不是把上限
   * 当成大小报给用户(旧实现里 `size` 最多就是 4MB,因为它是「保留了多少」)。
   */
  stdoutTotalBytes?: number;
}

export interface GitRunOptions {
  signal?: AbortSignal;
  /** 写到子进程 stdin 的内容。 */
  input?: string;
  /** 额外环境变量(凭据注入用;显式给的会覆盖剥离结果)。 */
  env?: Readonly<Record<string, string>>;
  /** 超时毫秒;缺省 30s。 */
  timeoutMs?: number;
  /**
   * 取原始字节而不是文本。
   *
   * 文本路径会把字节按 utf8 解码,二进制内容因此被破坏(NUL 与非法序列都变了)。
   * 打开它时 `stdoutBase64` 才有值。用于图片/二进制 blob 的**老**路径;
   * 新的原始字节路径见 `GitRunner.open`。
   */
  binary?: boolean;
}

/**
 * 一条**流式** stdout 的句柄(宿主 stdio 的 `'pipe'` 模式)。
 *
 * 存在的理由:`Range` 请求要「只取第 3MB 到 3MB+64KB」,而收集模式**先把整份
 * 输出收进内存**再交给调用方 —— 对一个 500MB 的 blob 就是 500MB 的无用功,
 * 而且它在 4MB 处就截尾了。管道模式让我们**跳过**不需要的字节、只留下需要的区间。
 */
export interface IGitOutputStream {
  /** 原始 stdout 字节流(可 `for await`)。 */
  readonly stdout: AsyncIterable<Uint8Array>;
  /** 进程退出码。调用方提前 `close()` 时会是非 0 —— **那不是错误**(是我们不要了)。 */
  readonly exitCode: Promise<number | null>;
  /** 取够/放弃:销毁管道并终止子进程。幂等,可在任何时刻调用。 */
  close(): void;
}

/**
 * spawn 之前**额外**要注入子进程环境的变量(见 `host/hooks-env.ts`)。
 *
 * 参数是这次 git 调用的 cwd:上游按「shell 种类 + cwd」缓存 shell 环境
 * (`with-hooks-env.ts:24-34` 的 `memoizeOne`),key 里必须带仓库目录。
 * @param cwd - git 调用的工作目录。
 * @returns 要合并进子进程的环境;`undefined` = 这次不注入。
 */
export type GitSpawnEnvProvider = (cwd: string) => Promise<Readonly<Record<string, string>> | undefined>;

/** 执行缝。 */
export interface GitRunner {
  run(argv: readonly string[], cwd: string, opts?: GitRunOptions): Promise<GitRunResult>;
  /**
   * 打开一条原始 stdout 流(宿主不支持 pipe 时回 `null`,调用方据此降级)。
   * 可选:测试替身只实现 `run()` 时,内容路径会退化成「拒绝」而不是给出错内容。
   */
  open?(argv: readonly string[], cwd: string, opts?: { timeoutMs?: number }): Promise<IGitOutputStream | null>;
}

/** 单次输出上限(收集后截断,避免超大仓 diff 撑爆内存)。 */
export const OUTPUT_CAP_BYTES = 4 << 20;
const DEFAULT_TIMEOUT_MS = 30_000;

/** 收集模式的三种形态:管道 / 继承 / 有界收集(可选 spill 兜底)。 */
type CollectMode = { maxBytes: number; spill?: { maxBytes: number } };

/** ctx.subprocess 的最小结构切面(不 import 宿主类型,bundle 自洽)。 */
export interface SubprocessLike {
  spawn(spec: {
    argv: readonly string[];
    cwd: string;
    stdio: {
      stdin: 'ignore' | 'pipe';
      stdout: 'pipe' | 'inherit' | CollectMode;
      stderr: 'pipe' | 'inherit' | CollectMode;
    };
    graceMs: number;
    signal?: AbortSignal;
    env?: Readonly<Record<string, string>>;
  }): SpawnedHandle;
}

interface CollectedView {
  text: string;
  nextOffset?: number;
  lossy?: boolean;
  truncated?: boolean;
  spillPath?: string;
}

interface SpawnedHandle {
  stdin?: { write(data: string): boolean; end(): void; on?(event: string, cb: (...args: unknown[]) => void): void } | undefined;
  /** `stdio.stdout === 'pipe'` 时才有。 */
  stdout?: AsyncIterable<Uint8Array> & { destroy?(): void } | undefined;
  done?: Promise<{ exitCode: number | null }>;
  terminate?: () => void;
  collected?: {
    stdout?: {
      readFrom(offset: number): CollectedView;
      /**
       * 原始字节尾巴。宿主 `dsh-subprocess-local` 的 `OutputCollector` **确实提供**
       * (`lib/output.js:203`,返回 `{bytes: Buffer, totalBytes}`),只是本文件的接口
       * 之前没声明它 —— 所以「二进制拿不到」不是宿主不支持,而是我们没用。
       * 有了它才能读图片/二进制 blob(见 docs/design.md §15.4)。
       */
      snapshot?(): { bytes: Uint8Array; totalBytes: number };
    };
    stderr?: {
      readFrom(offset: number): CollectedView;
      snapshot?(): { bytes: Uint8Array; totalBytes: number };
    };
  };
}

/**
 * 生产 runner。
 * @param ctx - 携带 subprocess 服务的 host 上下文。
 * @param platform - process.platform(测试可覆盖)。
 * @param shellEnv - 可选:hooks 偏好的 shell 环境提供者(见 `host/hooks-env.ts`)。
 *   不传 = 与改动前完全一致(只有调用方显式给的 `opts.env`)。
 */
export function subprocessRunner(
  ctx: { subprocess?: unknown },
  platform: string = process.platform,
  shellEnv?: GitSpawnEnvProvider,
): GitRunner {
  const service = (): SubprocessLike | undefined => {
    const candidate = ctx.subprocess as SubprocessLike | undefined;
    return candidate !== undefined && typeof candidate.spawn === 'function' ? candidate : undefined;
  };
  return {
    async run(argv, cwd, opts = {}) {
      const svc = service();
      if (svc === undefined) {
        return { exitCode: 127, stdout: '', stderr: 'subprocess service unavailable' };
      }
      const bad = findNonStringArg(argv);
      if (bad !== null) {
        return { exitCode: 1, stdout: '', stderr: bad };
      }
      const env = await mergeSpawnEnv(shellEnv, cwd, opts.env);
      return spawnWith(svc, withGitBinary(platform, argv), cwd, env === undefined ? opts : { ...opts, env });
    },
    async open(argv, cwd, opts = {}) {
      const svc = service();
      if (svc === undefined) {
        return null;
      }
      if (findNonStringArg(argv) !== null) {
        return null;
      }
      return openStream(svc, withGitBinary(platform, argv), cwd, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    },
  };
}

/**
 * 通用命令执行(不限于 git)。
 *
 * 从 `spawnWith` 提出来的:`git-runner` 会自己加上 `withGitBinary`,而「在文件管理器里
 * 显示」这类系统动作要执行的是 `open` / `explorer` / `xdg-open`,不能套 git 的路径处理。
 * @param service - `ctx.subprocess`。
 * @param argv - 完整 argv(argv[0] 是**可执行文件**)。
 * @param cwd - 工作目录。
 * @param opts - 输入/超时/环境变量。
 */
export function spawnCommand(
  service: SubprocessLike,
  argv: readonly string[],
  cwd: string,
  opts: GitRunOptions,
): Promise<GitRunResult> {
  return spawnWith(service, argv, cwd, opts);
}

/**
 * 参数类型守卫:子进程 API 要求全字符串,混进数字/对象时会抛
 * ERR_INVALID_ARG_TYPE,而那个错误**完全看不出是哪个参数错了**。
 * 在这里拦下来并指名道姓,排查成本从「猜」变成「看一眼」。
 * @param argv - 待检查的 argv。
 * @returns 错误信息,或 null 表示全是字符串。
 */
function findNonStringArg(argv: readonly string[]): string | null {
  for (const [index, arg] of argv.entries()) {
    if (typeof arg !== 'string') {
      return `dsh-git 内部错误:argv[${index}] 不是字符串(${typeof arg})。`;
    }
  }
  return null;
}

/**
 * 把 provider 的 shell 环境与调用方**显式**给的环境合起来。
 *
 * 三条纪律(都有具体缺陷做理由):
 *  1. **显式项赢**。`opts.env` 是凭据注入(`git-service.ts:242` 的 `credentialEnv`),
 *     用户的 shell 环境里若也有 `GITHUB_TOKEN` / `GIT_ASKPASS`,**不许**把它盖掉 ——
 *     否则「登录了却推送失败」会变成一条查不出来的路。
 *  2. **provider 抛错不许拖垮 git**。它读的是宿主偏好 + 用户 shell(可能超时/rc 报错),
 *     git 本身必须照跑:异常一律降级成「不注入」。
 *  3. **没拿到东西就一个字段都不加**。`spec.env` 缺席与 `spec.env: {}` 在
 *     宿主 `subprocess` 服务里语义相同(都是「用父环境」),但**对拍性质**不同:
 *     探针要能区分「这次注入了」与「这次没注入」,所以缺席就是缺席。
 * @param provider - 可选的环境提供者。
 * @param cwd - git 调用的工作目录。
 * @param explicit - 调用方显式给的环境。
 * @returns 合并结果;两边都没有时 `undefined`。
 */
async function mergeSpawnEnv(
  provider: GitSpawnEnvProvider | undefined,
  cwd: string,
  explicit: Readonly<Record<string, string>> | undefined,
): Promise<Readonly<Record<string, string>> | undefined> {
  let extra: Readonly<Record<string, string>> | undefined;
  if (provider !== undefined) {
    try {
      extra = await provider(cwd);
    } catch {
      extra = undefined;
    }
  }
  if (extra === undefined || Object.keys(extra).length === 0) {
    return explicit;
  }
  return explicit === undefined ? extra : { ...extra, ...explicit };
}

function spawnWith(
  service: SubprocessLike,
  argv: readonly string[],
  cwd: string,
  opts: GitRunOptions,
): Promise<GitRunResult> {
  const bad = findNonStringArg(argv);
  if (bad !== null) {
    return Promise.resolve({ exitCode: 1, stdout: '', stderr: bad });
  }
  const wantsInput = opts.input !== undefined;
  let handle: SpawnedHandle;
  try {
    handle = service.spawn({
      argv,
      cwd,
      stdio: {
        stdin: wantsInput ? 'pipe' : 'ignore',
        stdout: { maxBytes: OUTPUT_CAP_BYTES },
        stderr: { maxBytes: OUTPUT_CAP_BYTES },
      },
      graceMs: 2_000,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      ...(opts.env !== undefined ? { env: opts.env } : {}),
    });
  } catch (error) {
    return Promise.resolve({ exitCode: 127, stdout: '', stderr: messageOf(error) });
  }

  if (wantsInput) {
    try {
      handle.stdin?.write(opts.input ?? '');
      handle.stdin?.end();
    } catch {
      /* 进程可能已退出;结果由 done 决定 */
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = Promise.resolve(handle.done).then(
    (d) => d ?? { exitCode: null },
    () => ({ exitCode: null }),
  );
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeout = new Promise<{ exitCode: number | null }>((resolve) => {
    timer = setTimeout(() => {
      try { handle.terminate?.(); } catch { /* 已退出 */ }
      resolve({ exitCode: null });
    }, timeoutMs);
  });

  return Promise.race([done, timeout]).then((result) => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    const out = read(handle, 'stdout');
    const err = read(handle, 'stderr');
    const binary = opts.binary === true ? readBinary(handle) : undefined;
    return {
      exitCode: result.exitCode,
      stdout: out.text,
      stderr: err.text,
      stdoutTotalBytes: out.totalBytes,
      // 二进制路径的判定**按字节**更准(snapshot 的 totalBytes vs bytes.length),
      // 所以它优先;文本路径用收集器自己报的 `lossy`。
      ...(binary !== undefined
        ? { stdoutBase64: binary.stdoutBase64, ...(binary.truncated ? { stdoutTruncated: true } : {}) }
        : (out.truncated ? { stdoutTruncated: true } : {})),
    };
  });
}

/**
 * 打开一条 stdout 管道。
 *
 * 宿主不支持 `'pipe'`(或该 provider 不实现)时返回 `null` —— 调用方**降级为拒绝**,
 * 而不是退回收集模式:收集模式在 4MB 处保留的是尾部,拿它当「第 N 字节之后的内容」
 * 会**静默错位**。
 * @param service - `ctx.subprocess`。
 * @param argv - 完整 argv。
 * @param cwd - 工作目录。
 * @param timeoutMs - 超时后终止进程(字节数不足由调用方判错)。
 */
async function openStream(
  service: SubprocessLike,
  argv: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<IGitOutputStream | null> {
  let handle: SpawnedHandle;
  try {
    handle = service.spawn({
      argv,
      cwd,
      stdio: {
        stdin: 'ignore',
        stdout: 'pipe',
        // stderr 只有诊断价值,给个小上限即可(它不该进内容路径)。
        stderr: { maxBytes: 64 * 1024 },
      },
      graceMs: 2_000,
    });
  } catch {
    return null;
  }
  const stream = handle.stdout;
  if (stream === undefined) {
    try { handle.terminate?.(); } catch { /* 已退出 */ }
    return null;
  }
  let closed = false;
  const timer = setTimeout(() => {
    try { handle.terminate?.(); } catch { /* 已退出 */ }
  }, timeoutMs);
  return {
    stdout: stream,
    exitCode: Promise.resolve(handle.done).then(
      (d) => d?.exitCode ?? null,
      () => null,
    ),
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      clearTimeout(timer);
      try { stream.destroy?.(); } catch { /* 已结束 */ }
      try { handle.terminate?.(); } catch { /* 已退出 */ }
    },
  };
}

/**
 * 取 stdout 的原始字节并 base64。宿主没提供 `snapshot()` 时返回空串
 * (调用方据此走「拿不到内容」分支,而不是拿到被 utf8 破坏的垃圾)。
 * @param handle - 子进程句柄。
 */
function readBinary(handle: SpawnedHandle): { stdoutBase64: string; truncated: boolean } {
  try {
    const collector = handle.collected?.stdout;
    const snapshot = collector?.snapshot;
    if (collector === undefined || typeof snapshot !== 'function') {
      // 宿主没提供原始字节:返回空 + 标记截断,让调用方走「拿不到内容」分支,
      // 而不是把被 utf8 破坏的文本当成二进制内容用。
      return { stdoutBase64: '', truncated: true };
    }
    const { bytes, totalBytes } = snapshot.call(collector);
    return {
      stdoutBase64: Buffer.from(bytes).toString('base64'),
      // 保留的字节数 < 观测到的总字节数 ⇒ 被截断。这就是那个「大图返回残缺 base64」的情形。
      truncated: totalBytes > bytes.length,
    };
  } catch {
    return { stdoutBase64: '', truncated: true };
  }
}

/** 收集模式的一次读取:文本 + **真实总量** + 截断标志。 */
function read(handle: SpawnedHandle, slot: 'stdout' | 'stderr'): { text: string; totalBytes: number; truncated: boolean } {
  try {
    const collector = handle.collected?.[slot];
    if (collector === undefined) {
      return { text: '', totalBytes: 0, truncated: false };
    }
    const view = collector.readFrom(0);
    const text = view.text ?? '';
    // nextOffset 是「全流字节坐标」里的下一个位置 = 观测到的总字节数。
    // 它缺失时退化成「保留了多少」,并把 truncated 交给 lossy/truncated 判定。
    const totalBytes = typeof view.nextOffset === 'number' ? view.nextOffset : text.length;
    return { text, totalBytes, truncated: view.lossy === true || view.truncated === true };
  } catch {
    return { text: '', totalBytes: 0, truncated: false };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
