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
  /**
   * **这次调用是被 `timeoutMs` 到点后由本模块主动终止的**。
   *
   * 为什么必须有这个字段(2026-10,用户报「推送失败弹窗里出现未知错误」):
   * 超时之前只表达成 `exitCode: null`,而 `exitCode: null` 至少有**三种**成因 ——
   * ①本模块的定时器到点(我们**知道**原因);②`handle.done` 被外部信号/宿主回收打断;
   * ③`handle.done` reject。三种折成同一个形状 ⇒ `must()` 只能落
   * `classifyGitFailure('', …)`,而 stderr 为空时那句兜底是**占位符**
   * (`git-service.ts` 的 `?? '未知错误'`)⇒ 把「已知的超时」播成「未知错误」,
   * 并且**丢掉了唯一可诊断的信息**(超时值、被终止的命令)。
   *
   * 所以把**已知的那一种**单独标出来:只有本模块的 `setTimeout` 到点才置 `true`。
   * 它是 `exitCode: null` 的**子集**,不是替代 —— 没置 `true` 的 `null` 仍然是「不知道」。
   */
  timedOut?: boolean;
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
  /**
   * **逐行**观察子进程的 stderr(git 的进度写在这里)。
   *
   * 给了它 ⇒ 这一次 spawn 走 `stderr: 'pipe'`(而不是收集模式),回调随数据到达被调用;
   * `GitRunResult.stderr` **仍然照旧**有值(我们自己缓存尾部)—— 这是刻意的:
   * `must()` 的失败分类(`classifyGitFailure`)读的就是它,观察进度**不能**把
   * 「推送失败弹窗」那条链路的输入弄丢。
   *
   * 行边界与上游 `lib/progress/from-process.ts:91` 用的 `byline@5` **逐条对齐**
   * (见 {@link createLineSplitter})—— git 的进度行是 **`\r` 分隔**的,
   * 只按 `\n` 切会得到「0%…1%…2%…」一整行,解析器只认到第一段。
   */
  onStderrLine?: (line: string) => void;
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
/**
 * 没显式给 `timeoutMs` 时的默认上限。
 *
 * **导出**的理由:`GitService.must()` 要在超时文案里报出**真实的超时值**
 * (`git-service.ts` 的 `timeoutFailure`)。默认值若只活在这里,那句文案就只能写
 * 「超时」而不能写「超时(30 秒)」—— 而「超时值」正是这次要给出的可诊断信息之一。
 * 两处各写一个常量是第二份真源,漂移了没人会发现。
 */
export const DEFAULT_TIMEOUT_MS = 30_000;

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
  /**
   * `stdio.stderr === 'pipe'` 时才有。
   *
   * 宿主 `dsh-subprocess-local` **确实提供它**:`bindManagedProcess` 的返回对象里
   * `stderr: errMode === 'pipe' ? stderr : void 0`(`lib/runner-launch-*.js`),
   * 而底下的子进程从 `spawnSubprocess` 起 stderr 就是 `"pipe"`。
   * 本文件的接口之前没声明它,所以「读不到 git 进度」不是宿主不支持,是我们没用。
   */
  stderr?: AsyncIterable<Uint8Array> & { destroy?(): void } | undefined;
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
        /*
         * 服务缺席是**配置级**故障(整个 profile 里没有任何 git 操作能跑),
         * 而它在上层会被播成「这个目录不是 git 仓库」—— 必须在这里喊一声。
         */
        console.warn('[dsh-git] 宿主没有提供 subprocess 服务(ctx.subprocess):'
          + '所有 git 操作都会失败,并被上层报成「这个目录不是 git 仓库」');
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
  /*
   * **观察 stderr 时走管道,否则走收集**(逐字保留旧行为)。
   *
   * 两种模式不能同时要:宿主 `bindManagedProcess` 里 `stderr` 要么被
   * `collectStream()` 接走(`collected.stderr` 有值、`handle.stderr` 是 `void 0`),
   * 要么原样交出来(`handle.stderr` 有值、`collected.stderr` 没有)。
   */
  const observeStderr = opts.onStderrLine !== undefined;
  const onStderrLine = opts.onStderrLine;
  let handle: SpawnedHandle;
  try {
    handle = spawnOnce(service, argv, cwd, opts, wantsInput, observeStderr);
  } catch (error) {
    return Promise.resolve(spawnFailed(argv, cwd, error));
  }
  if (observeStderr && handle.stderr === undefined) {
    /*
     * 宿主这一版不暴露 stderr 管道 ⇒ **收掉这个进程,退回收集模式重来**。
     *
     * 为什么不能就这么继续:`must()` 的失败分类读的是 `res.stderr`,丢了它
     * 「推送失败弹窗」那条链路会**静默**失效(界面只会说一句没有 stderr 的通用错)。
     * 半途退化成「有进度但没有错误详情」比没有进度更坏 —— 那正是本仓反复付代价的
     * 那类「看起来能用」的降级。此时进程刚起来,还没写任何东西,收掉是安全的。
     */
    try { handle.terminate?.(); } catch { /* 已退出 */ }
    try {
      handle = spawnOnce(service, argv, cwd, { ...opts, onStderrLine: undefined }, wantsInput, false);
    } catch (error) {
      return Promise.resolve(spawnFailed(argv, cwd, error));
    }
  }

  if (wantsInput) {
    try {
      handle.stdin?.write(opts.input ?? '');
      handle.stdin?.end();
    } catch {
      /* 进程可能已退出;结果由 done 决定 */
    }
  }

  /*
   * stderr 管道:自己读、自己缓存尾部。
   *
   * 缓存是**必须**的 —— 它替掉了收集模式本来会给的那份 `res.stderr`
   * (`read(handle,'stderr')` 在管道模式下拿不到东西)。上限与收集模式同一个
   * `OUTPUT_CAP_BYTES`,并且与收集模式一样**保留尾部**(错误在末尾)。
   * 口径同上游 `lib/git/push-terminal-chunk.ts:21-40`:它数的是**字符**不是字节。
   */
  let pipedStderr: string | undefined;
  let stderrDrained: Promise<void> | undefined;
  const stderrStream = handle.stderr;
  if (observeStderr && stderrStream !== undefined && onStderrLine !== undefined) {
    const splitter = createLineSplitter(onStderrLine);
    pipedStderr = '';
    stderrDrained = (async () => {
      try {
        for await (const chunk of stderrStream) {
          const text = splitter.push(chunk);
          if (text !== '') {
            pipedStderr = appendTail(pipedStderr ?? '', text, OUTPUT_CAP_BYTES);
          }
        }
        const rest = splitter.flush();
        if (rest !== '') {
          pipedStderr = appendTail(pipedStderr ?? '', rest, OUTPUT_CAP_BYTES);
        }
      } catch {
        /* 流被销毁(超时 terminate / 宿主回收)⇒ 已读到的部分就是全部 */
      }
    })();
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = Promise.resolve(handle.done).then(
    (d) => d ?? { exitCode: null },
    () => ({ exitCode: null }),
  );
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  /*
   * ⚠️ 超时这一支**必须**把「是定时器到点」这件事带出去:它是「为什么没有退出码」的
   * 唯一区别(`{@link GitRunResult.timedOut}`)。少了它,`must()` 只能把超时和
   * 「句柄被外部打断」混成同一个形状,于是落回 `classifyGitFailure('')` 的占位符。
   *
   * 用一个闭包标志而不是给 resolve 值加字段:`Promise.race` 的成员类型会被收窄成
   * 字面量联合,多一个可选字段就会在读取处报 TS2339(实测)。标志的语义同样精确 ——
   * 它只在**本模块的定时器抢在 race 判定之前**触发时为 true,而定时器在 race 判定时
   * 会被 `clearTimeout`(微任务先于定时器回调),所以不存在「已判定完才置位」的假阳性。
   */
  let timedOut = false;
  const timeout = new Promise<{ exitCode: number | null }>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      try { handle.terminate?.(); } catch { /* 已退出 */ }
      resolve({ exitCode: null });
    }, timeoutMs);
  });

  return Promise.race([done, timeout]).then(async (result) => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    /*
     * 等管道读完再取结果。宿主的 `done` 本身要等 stderr 关闭
     * (`bindManagedProcess` 的 `outputStreamsClosed`),所以这里通常立刻返回;
     * 加一个有界的等待只是防一个不肯关流的实现把整次 git 调用挂住。
     */
    if (stderrDrained !== undefined) {
      await Promise.race([stderrDrained, delay(2_000)]);
    }
    const out = read(handle, 'stdout');
    const err = read(handle, 'stderr');
    const binary = opts.binary === true ? readBinary(handle) : undefined;
    return {
      exitCode: result.exitCode,
      stdout: out.text,
      // 管道模式:用我们缓存的那一份(收集器此时没有 stderr)。
      stderr: pipedStderr ?? err.text,
      stdoutTotalBytes: out.totalBytes,
      // 只有本模块的定时器到点才置 true(见 `GitRunResult.timedOut` 的三条成因)。
      ...(timedOut ? { timedOut: true } : {}),
      // 二进制路径的判定**按字节**更准(snapshot 的 totalBytes vs bytes.length),
      // 所以它优先;文本路径用收集器自己报的 `lossy`。
      ...(binary !== undefined
        ? { stdoutBase64: binary.stdoutBase64, ...(binary.truncated ? { stdoutTruncated: true } : {}) }
        : (out.truncated ? { stdoutTruncated: true } : {})),
    };
  });
}

/**
 * 一次 spawn(spawnWith 的两条路都用它:管道观察一次、降级收集一次)。
 *
 * **不吞异常**:`service.spawn` 抛出的错误要原样变成 `exitCode: 127` 的
 * `stderr`(`spawnWith` 的旧行为),把那句话换成一个笼统串会让「子进程起不来」
 * 变得无法诊断。收集模式的 `stderr` 上限在这里是**唯一**一处决定。
 */
function spawnOnce(
  service: SubprocessLike,
  argv: readonly string[],
  cwd: string,
  opts: GitRunOptions,
  wantsInput: boolean,
  observeStderr: boolean,
): SpawnedHandle {
  return service.spawn({
    argv,
    cwd,
    stdio: {
      stdin: wantsInput ? 'pipe' : 'ignore',
      stdout: { maxBytes: OUTPUT_CAP_BYTES },
      stderr: observeStderr ? 'pipe' : { maxBytes: OUTPUT_CAP_BYTES },
    },
    graceMs: 2_000,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
  });
}

/** 有界等待(只给「等 stderr 排空」那一处用;不引真定时器语义)。 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * spawn 起不来时的**唯一**出口:把现场打到宿主 stderr,再折成 `exitCode: 127`。
 *
 * 为什么要打日志:`127` 走到上层会被折成「这个目录不是 git 仓库」
 * (`GitService.repoRoot` 只看退出码),于是「宿主受管子进程起不来」这件完全不同的事
 * 在界面与日志里**一点痕迹都不留** —— 2026-10 在 Linux CI 上为此刻意白跑了好几轮
 * (同一路径用本机 git 看明明是仓库,插件的受管路径却说不是)。`argv` 与 `cwd` 必须
 * 一起打:少了任何一个都无法判断是「命令不对」还是「工作目录不对」。
 * @param argv - 完整 argv(argv[0] 是可执行文件)。
 * @param cwd - 子进程工作目录。
 * @param error - `service.spawn` 抛出的原始异常。
 * @returns 折给上层的失败结果。
 */
function spawnFailed(argv: readonly string[], cwd: string, error: unknown): GitRunResult {
  const message = messageOf(error);
  console.warn(`[dsh-git] 起不了子进程 ${argv.join(' ')}(cwd=${cwd}):${message}`);
  return { exitCode: 127, stdout: '', stderr: message };
}

/**
 * 保留**尾部**的有界拼接(与收集模式同一个口径)。
 *
 * 为什么保留尾部:错误在末尾。上游 `lib/git/push-terminal-chunk.ts:21-40` 做的是同一
 * 件事(并且同样注明了「数的是字符不是字节」)。
 */
function appendTail(current: string, chunk: string, cap: number): string {
  const next = current + chunk;
  return next.length <= cap ? next : next.slice(next.length - cap);
}

/** `byline@5.0.0` 的分隔符集合(`lib/byline.js` 的 `_transform`)。 */
const LINE_BREAK = /\r\n|[\n\v\f\r\u0085\u2028\u2029]/;

/**
 * 字节流 → 行(逐条对齐上游 `lib/progress/from-process.ts:91` 用的 `byline@5.0.0`)。
 *
 * 为什么必须自己写而不是装 `byline`:本仓不允许新增 npm 依赖,而这段规则很短。
 * 对齐的是 byline 的**四条**语义(少一条就会给解析器喂错行):
 *
 *  1. 分隔符 = `\r\n | \n | \v | \f | \r | \x85 | \u2028 | \u2029`
 *     (byline 的 `_transform` 用同一个字符类);
 *  2. **空行丢弃**(byline 的 `keepEmptyLines` 缺省 false)—— 而 git 的进度行恰好是
 *     连续 `\r`,切出来全是空行,不丢的话解析器要白跑几千次;
 *  3. `\r` 与 `\n` 落在**两块之间**时算一个分隔符(byline 的 `_lastChunkEndedWithCR`);
 *  4. 最后一段没有分隔符的内容**留到流结束**才交(byline 的 `_flush` → `_pushBuffer(…,0,…)`)。
 *
 * 一处**刻意**的改进:字节→字符串用流式 `TextDecoder`。byline 是每块各自
 * `chunk.toString('utf8')`,多字节字符跨块会坏(对 git 的进度行没有影响,但对
 * `remote:` 后面可能出现的中文分支名/路径有意义)。**行边界不变**。
 * @param onLine - 每切出一行(非空)时调用。
 * @returns `push(chunk)` 与 `flush()`;内部状态只在这里。
 */
function createLineSplitter(onLine: (line: string) => void): {
  push(chunk: Uint8Array): string;
  flush(): string;
} {
  const decoder = new TextDecoder();
  let carry = '';
  let lastEndedWithCR = false;
  return {
    /*
     * 返回值是**这一块原始文本**(要不要缓存尾部由调用方决定):行回调只负责解析,
     * 错误详情那份缓存必须是**原始字节序的全文**,不能只留切出来的行
     * (否则 `classifyGitFailure` 看到的东西与收集模式不一致)。
     */
    push(chunk: Uint8Array): string {
      const text = decoder.decode(chunk, { stream: true });
      if (text === '') {
        return '';
      }
      const parts = text.split(LINE_BREAK);
      // CRLF 跨块:后一块开头的 `\n` 属于前一块结尾的 `\r`。
      if (lastEndedWithCR && text.startsWith('\n')) {
        parts.shift();
      }
      if (carry !== '') {
        parts[0] = carry + (parts[0] ?? '');
        carry = '';
      }
      lastEndedWithCR = text.endsWith('\r');
      carry = parts.pop() ?? '';
      for (const part of parts) {
        if (part.length > 0) {
          onLine(part);
        }
      }
      return text;
    },
    flush(): string {
      const rest = decoder.decode();
      const tail = carry + rest;
      carry = '';
      if (tail.length > 0) {
        onLine(tail);
      }
      return rest;
    },
  };
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
