/**
 * **Hooks 的 shell 环境注入**(宿主侧)——把「用户 shell 的环境」合并进 git 子进程。
 *
 * ## 为什么需要这个文件:上游把两半写在一个进程里
 *
 * 上游 `lib/hooks/with-hooks-env.ts`(104 行)在**每一次带钩子的 git 操作**前做三件事:
 *
 * | 步 | 上游实现 | 这一层 |
 * |---|---|---|
 * | 1 | 从 `lib/hooks/config.ts` 读三个偏好(**localStorage**) | 读宿主存储域(`repo-registry.ts` 的 `prefHooksEnv`) |
 * | 2 | `getShellEnv()`(`lib/hooks/get-shell-env.ts`)启动用户的 shell,跑 `printenvz`(**一个原生可执行文件**)把环境按 NUL 分隔打出来 | 同一步骤,但打印环境的是 shell 自己的 `env` / `set` / `Get-ChildItem Env:`(我们**不发原生二进制**) |
 * | 3 | `createHooksProxy()` + `process-proxy` 把钩子改道到临时 `core.hooksPath`,由代理**用第 2 步的环境**执行钩子,并上报进度/失败 | **没有做**(见下) |
 *
 * 第 1、2 步在本文件;第 2 步的结果不再交给「钩子代理」,而是由
 * `git-runner.ts` 直接合并进 **git 子进程的环境** —— git 自己 spawn 钩子,钩子继承
 * git 的环境,所以「钩子看到 shell 环境」这个**目标**达成,但读者必须知道:
 *
 *  - **这不是同一条实现**。上游是「用 shell 环境执行钩子」,我们是「让 git 带着
 *    shell 环境去执行钩子」。差别在 `core.hooksPath` 改道、进程代理、临时 hooks
 *    目录、钩子进度与失败上报(以及「钩子不可执行时替它执行」)这一族 ——
 *    **全部没有**。
 *  - 因此上游 `withHooksEnv` 里对**每个仓库**的钩子枚举(`getRepoHooks`)、
 *    `hooks-proxy.ts`(309 行)、`process-proxy` 二进制都**不在这条链上**。
 *    **未做清单**写在 `src/client/git-page.tsx` 的文件头(它给用户看的是「哪些设置
 *    已经真的被消费」),本文件不重复第二份。
 *
 * ## 与上游**逐条对照**的取舍(每条都写理由)
 *
 *  1. **marker 协议逐字沿用上游**(`--printenvz--begin` / `--printenvz--end`,
 *     `get-shell-env.ts:57-58` 的两个正则),因为读代码的人要能一眼把两边对上。
 *     变的只是**谁产出**这些 marker:上游是一个 Go/Rust 写的小原生程序
 *     (`printenvz`)按 NUL 分隔输出;我们不允许发原生二进制(也没有这个构建步骤),
 *     所以改用 shell 自己:
 *       - POSIX(bash/zsh/sh):`command env`(行分隔 `KEY=VALUE`);
 *       - Windows cmd:`set`;
 *       - Windows PowerShell / pwsh:`Get-ChildItem Env:`。
 *     ⇒ **代价(如实记录)**:行分隔在「值里含换行」时会被拆成多行,解析器用
 *     「只认 `^[A-Za-z_][A-Za-z0-9_]*=` 的行」把续行丢掉 —— 结果是那一个变量的值
 *     被截断,**不会**污染出别的键。上游用 NUL 分隔正是为了避开这件事。
 *  2. **`env: {}`(上游把 shell 的环境清空再让 rc 重建)我们做不到**:宿主的
 *     `subprocess` 服务的 `env` 是**在父环境之上覆盖**(实测 `dsh-subprocess-local`
 *     的 `childEnv(spec.env)`:先 `scrubbedParentEnv()` 再合显式项),没有「清空」这个
 *     语义。⇒ 我们捕获到的是**父环境 + shell init 的覆盖**。对「钩子要有 PATH/nvm」
 *     这个目的更安全,但也意味着**它删不掉**父环境里的变量。
 *  3. **失败一律降级为「不注入」**。上游在这里会 reject,由 git 执行链去处理;
 *     我们在 `git-runner` 里注入,一次 shell 失败**不允许**让每条 git 命令都炸,
 *     所以捕获失败只写日志并回 `undefined`(git 照跑,只是钩子拿不到 shell 环境)。
 *  4. **缓存粒度**:上游 `memoizeOne(shellKind, cwd, cacheKey)` 是「同一个 shell +
 *     同一个仓库目录」缓存最后一次结果,`getCacheHooksEnv()` 为真时 cacheKey 固定为
 *     `'global'`(即同一仓库内跨操作复用),为假时用每次操作一个 token(即每次重取)。
 *     我们没有「一次操作」这个边界(git 执行是逐条命令的),所以:
 *       - `cache` 为真 ⇒ 按 `shell + cwd` 缓存(与上游 `'global'` 同效);
 *       - `cache` 为假 ⇒ **每次 git 调用都重取**。⚠️ 这比上游更频繁
 *         (上游是「每次操作」,一次提交只取一次;我们是「每条命令」),是**已知的偏离**,
 *         默认值(`cache = true`)下不存在这个问题。
 *  5. **Windows 的 shell 定位不完整(未经实测)**:上游用 `which` + `registry-js`
 *     读注册表找 Git for Windows 的 `bash.exe`(`get-shell.ts:15-33`),两者都不是
 *     本仓的依赖(不许加新依赖)。⇒ 我们只按**可执行名**交给宿主解析
 *     (`bash.exe` / `<pwsh|powershell>.exe` / `%ComSpec%`),`git-bash` 在
 *     PATH 上没有 `bash.exe` 时捕获失败、退化成「不注入」。**本仓的开发机是 macOS,
 *     这条 Windows 分支没有实测证据**,只有 argv 形状的断言(探针里)。
 * @module dsh-git/host/hooks-env
 */

import type { SubprocessLike } from './git-runner.ts';
import { spawnCommand } from './git-runner.ts';

/**
 * 四个 shell 名 —— 上游 `lib/hooks/config.ts:49` 的 `SupportedHooksEnvShell`,逐字。
 *
 * 这份联合类型在客户端是**镜像文件**里的(`src/core/desktop/lib/hooks/config.ts`),
 * 宿主半不能 import 它(那个文件读 `localStorage`)。⇒ 这里重声明一份,
 * 并靠 `lib/hooks/config.ts` 的四个字面量与 {@link HOOKS_ENV_SHELLS} 一致来保证不分叉;
 * 路由写入时的校验用 {@link isHooksEnvShell}(见 `routes.ts` 的 `prefs/set`)。
 */
export type SupportedHooksEnvShell = 'git-bash' | 'pwsh' | 'powershell' | 'cmd';

/** 四个合法值(顺序 = 上游 `shellFriendlyNames` 的键序,注释用)。 */
export const HOOKS_ENV_SHELLS: readonly SupportedHooksEnvShell[] = ['git-bash', 'pwsh', 'powershell', 'cmd'];

/** 上游 `lib/hooks/config.ts:23` 的 `defaultGitHookEnvShell`。 */
export const DEFAULT_HOOK_ENV_SHELL: SupportedHooksEnvShell = 'git-bash';

/** 运行期守卫:字符串是否是四个 shell 之一。 */
export function isHooksEnvShell(value: unknown): value is SupportedHooksEnvShell {
  return typeof value === 'string' && (HOOKS_ENV_SHELLS as readonly string[]).includes(value);
}

/**
 * 宿主侧**生效**的三个偏好。
 *
 * 默认值必须与镜像 `lib/hooks/config.ts` 的三个默认值一致,否则「宿主从没被写过」
 * 与「界面显示的值」会分叉(那正是本轮要修的缺陷类型):
 *  - `enabled` ← `defaultHooksEnvEnabledValue = enableHooksByDefault() = false`;
 *  - `cache` ← `defaultCacheHooksEnvValue = true`;
 *  - `shell` ← `defaultGitHookEnvShell = 'git-bash'`。
 *
 * 用 `type` 而不是 `interface` 是刻意的:本仓 ESLint 的 `naming-convention` 要求
 * **interface** 名以 `I[A-Z]` 开头(`.eslintrc.yml:67-74`),而这三个名字在宿主侧
 * 读起来不该带那个前缀;类型别名不受该规则约束(`src/host/repo-registry.ts` 的
 * `PrefsPatch` 同理)。
 */
export type HooksEnvPrefs = {
  readonly enabled: boolean;
  readonly cache: boolean;
  readonly shell: SupportedHooksEnvShell;
};

/** 上游 `get-shell-env.ts:57` 的起始 marker。 */
const BEGIN_MARKER = '--printenvz--begin';

/** 上游 `get-shell-env.ts:58` 的结束 marker。 */
const END_MARKER = '--printenvz--end';

/**
 * shell 启动一次的**超时**(毫秒)。
 *
 * 上游没有超时(它 await 到进程结束)。我们的理由是:这段代码挡在**每条 git 命令**
 * 前面,用户的 rc 文件里若有一个等网络的 `nvm`/`conda` 钩子,没有上限就会把界面
 * 一起挂住。超时后由 `git-runner` 的既有路径 `terminate()` 结束它,并按「捕获失败」
 * 处理(不注入)。10s 足够任何正常 rc;真超过就是 rc 自己的问题。
 */
const SHELL_CAPTURE_TIMEOUT_MS = 10_000;

/**
 * POSIX 的捕获命令:打印 marker → 打环境 → 打印 marker。
 *
 * `command env` 而不是裸 `env`:交互式 shell 里 `env` 可能被用户的 alias / function
 * 覆盖(读 rc 的正是这种 shell),`command` 跳过两者。
 */
const POSIX_COMMAND =
  "printf '%s\\n' '" + BEGIN_MARKER + "'; command env; printf '%s\\n' '" + END_MARKER + "'";

/** Windows cmd 的捕获命令(`set` 不带参数即列出全部环境变量)。 */
const CMD_COMMAND = 'echo ' + BEGIN_MARKER + ' & set & echo ' + END_MARKER;

/** Windows PowerShell / pwsh 的捕获命令。 */
const POWERSHELL_COMMAND =
  "Write-Output '" + BEGIN_MARKER + "'; Get-ChildItem Env: | ForEach-Object { \"$($_.Name)=$($_.Value)\" }; Write-Output '" + END_MARKER + "'";

/** 一次捕获要执行什么(抽出来是为了让探针能对 argv **形状**下断言)。 */
export interface IShellCaptureCommand {
  /** 完整 argv(元素 0 = 可执行文件)。 */
  readonly argv: readonly string[];
}

/**
 * 按平台 + shell 种类给出「捕获环境」的 argv。
 *
 * POSIX 侧逐字照上游 `get-shell.ts:120-125`:`process.env.SHELL ?? '/bin/sh'` +
 * bash 风格的 `-ilc`(上游 `shell-escape.ts:22` 的 `bash.args`);
 * **shell 种类在非 Windows 上被忽略** —— 上游就是这样(那个下拉在 Windows 上才显示),
 * 不是我们的简写。
 * @param shell - 用户选的 shell 种类(仅 win32 有意义)。
 * @param platform - `process.platform`(探针可覆盖)。
 * @param environ - shell 定位要读的环境(`process.env` 的替身)。
 * @returns argv;对未知平台回 `null`(调用方按「捕获失败」处理)。
 */
export function shellCaptureCommand(
  shell: SupportedHooksEnvShell,
  platform: string,
  environ: Readonly<Record<string, string | undefined>>,
): IShellCaptureCommand | null {
  if (platform !== 'win32') {
    const chosen = (environ.SHELL ?? '').trim();
    return { argv: [chosen === '' ? '/bin/sh' : chosen, '-ilc', POSIX_COMMAND] };
  }
  if (shell === 'cmd') {
    const comspec = (environ.ComSpec ?? environ.COMSPEC ?? '').trim();
    return { argv: [comspec === '' ? 'cmd.exe' : comspec, '/d', '/s', '/c', CMD_COMMAND] };
  }
  if (shell === 'git-bash') {
    // 见文件头取舍 5:上游走 which + 注册表找 Git for Windows 的 bash.exe,我们只按名字。
    return { argv: ['bash.exe', '-ilc', POSIX_COMMAND] };
  }
  return { argv: [`${shell}.exe`, '-NonInteractive', '-Command', POWERSHELL_COMMAND] };
}

/** 环境变量名:与 shell 的 `KEY=VALUE` 输出逐字对应。 */
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * 从 shell 的 stdout 里解析出环境(上游 `get-shell-env.ts:60-85` 的同一段逻辑,
 * 只是分隔符从 NUL 换成换行 —— 见文件头取舍 1)。
 *
 * marker 之间的一切都是数据:shell 的 rc 可能在 marker **之前或之后**打印东西
 * (上游的注释就写着这件事),所以两端都取 marker 而不是整份 stdout。
 * @param stdout - shell 的 stdout。
 * @returns 环境;找不到 marker 时回 `null`(调用方按「捕获失败」处理)。
 */
export function parseShellEnv(stdout: string): Record<string, string> | null {
  const text = stdout.replace(/\r\n/g, '\n');
  const begin = text.indexOf(BEGIN_MARKER + '\n');
  if (begin < 0) {
    return null;
  }
  // 取**最后**一个结束 marker:rc 的收尾输出里若恰好出现同名串也不会截错(上游同义)。
  const end = text.lastIndexOf('\n' + END_MARKER);
  const start = begin + BEGIN_MARKER.length + 1;
  if (end < start) {
    return null;
  }
  const env: Record<string, string> = {};
  for (const line of text.slice(start, end).split('\n')) {
    const eq = line.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    const key = line.slice(0, eq);
    if (!ENV_KEY_RE.test(key)) {
      // 换行续行、cmd 的 `=C:=` 伪变量都落在这里(见文件头取舍 1)。
      continue;
    }
    env[key] = line.slice(eq + 1);
  }
  return env;
}

/** {@link captureShellEnv} 的输入(类型别名,理由见 {@link HooksEnvPrefs})。 */
export type CaptureShellEnvOptions = {
  /** `ctx.subprocess`(惰性,避免 apply 时服务还没挂上)。 */
  readonly service: () => SubprocessLike | undefined;
  /** 要捕获哪种 shell 的环境。 */
  readonly shell: SupportedHooksEnvShell;
  /** 在哪个目录跑这次 shell(上游把它当 rc 的 cwd)。 */
  readonly cwd: string;
  /** `process.platform` 的替身。 */
  readonly platform: string;
  /** shell 定位读的环境。 */
  readonly environ: Readonly<Record<string, string | undefined>>;
  /** 诊断日志。 */
  readonly log?: (message: string) => void;
};

/**
 * 启动一次用户的 shell 并把它的环境取回来。
 *
 * **永不抛错**:任何失败都回 `undefined` 并写一行日志(理由见文件头取舍 3)。
 * @param options - 见 {@link CaptureShellEnvOptions}。
 * @returns 环境;失败时为 `undefined`。
 */
export async function captureShellEnv(options: CaptureShellEnvOptions): Promise<Record<string, string> | undefined> {
  const log = options.log ?? ((): void => undefined);
  const service = options.service();
  if (service === undefined) {
    log('[dsh-git] hooks: 宿主没有 subprocess 服务,无法捕获 shell 环境。');
    return undefined;
  }
  const command = shellCaptureCommand(options.shell, options.platform, options.environ);
  if (command === null) {
    log(`[dsh-git] hooks: 平台 ${options.platform} 上不知道怎么启动 shell,跳过环境注入。`);
    return undefined;
  }
  const result = await spawnCommand(service, command.argv, options.cwd, {
    timeoutMs: SHELL_CAPTURE_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    log(`[dsh-git] hooks: 捕获 shell 环境失败(exitCode=${String(result.exitCode)}):${firstLine(result.stderr)}`);
    return undefined;
  }
  const env = parseShellEnv(result.stdout);
  if (env === null) {
    log(`[dsh-git] hooks: shell 输出里没有 ${BEGIN_MARKER} / ${END_MARKER} 标记,跳过环境注入。`);
    return undefined;
  }
  return env;
}

/**
 * spawn git 之前的**环境提供者**:`git-runner` 在每次 `run()` 之前问它一次。
 *
 * 签名与 `git-runner.ts` 的 `GitSpawnEnvProvider` **逐字相同**(只是那个是 type,
 * 这里是它的实现工厂):参数是 git 调用的 cwd,返回要合并进子进程环境的东西。
 */
export type HooksEnvProvider = (cwd: string) => Promise<Readonly<Record<string, string>> | undefined>;

/** {@link createHooksEnvProvider} 的输入(类型别名,理由见 {@link HooksEnvPrefs})。 */
export type HooksEnvProviderOptions = {
  /** `ctx.subprocess`(惰性)。 */
  readonly service: () => SubprocessLike | undefined;
  /** 三个偏好的**当前**值(每次调用都重读:用户一改就生效,不用重启)。 */
  readonly prefs: () => HooksEnvPrefs;
  /** `process.platform` 的替身。 */
  readonly platform?: string;
  /** shell 定位读的环境(`process.env` 的替身)。 */
  readonly environ?: Readonly<Record<string, string | undefined>>;
  /** 诊断日志。 */
  readonly log?: (message: string) => void;
};

/**
 * 建一个「按偏好返回 shell 环境」的提供者。
 *
 * 缓存语义见文件头取舍 4;并发合流(`inflight`)是额外的一层:缓存打开时,
 * 同一 `shell + cwd` 上并发的多条 git 命令**共用一次**捕获,不然一次界面刷新会
 * 同时打出好几个登录 shell。
 * @param options - 见 {@link HooksEnvProviderOptions}。
 * @returns provider(永不抛错)。
 */
export function createHooksEnvProvider(options: HooksEnvProviderOptions): HooksEnvProvider {
  const platform = options.platform ?? process.platform;
  const environ = options.environ ?? process.env;
  const log = options.log ?? ((): void => undefined);
  /** `shell\0cwd` → 已捕获的环境。只在 `cache` 为真时写入/读取。 */
  const cached = new Map<string, Record<string, string>>();
  /** 同一 key 上正在进行的捕获(只在 `cache` 为真时合流)。 */
  const inflight = new Map<string, Promise<Record<string, string> | undefined>>();

  const capture = async (shell: SupportedHooksEnvShell, cwd: string): Promise<Record<string, string> | undefined> => {
    const env = await captureShellEnv({ service: options.service, shell, cwd, platform, environ, log });
    if (env !== undefined) {
      log(`[dsh-git] hooks: 已捕获 ${shell} 的环境(${Object.keys(env).length} 个变量),注入 git 子进程。`);
    }
    return env;
  };

  return async (cwd: string): Promise<Readonly<Record<string, string>> | undefined> => {
    const prefs = options.prefs();
    if (!prefs.enabled) {
      return undefined;
    }
    const key = `${prefs.shell}\u0000${cwd}`;
    /*
     * **先看 cache 再看缓存表**(顺序反了会有一个真实的缺陷:用户把「缓存」从开切到关
     * 之后,同一个仓库上仍然会命中那一次已经缓存的旧环境 —— 开关等于失效。
     * 这条断言在 `docs/probes/hooks-env-probe.mjs` 的 3.3,它就是这么抓到的)。
     */
    if (!prefs.cache) {
      // 关掉缓存 = 每次调用都重取(上游的「每次操作一个 token」在这个粒度上的等价物)。
      return capture(prefs.shell, cwd);
    }
    const hit = cached.get(key);
    if (hit !== undefined) {
      return hit;
    }
    const running = inflight.get(key);
    if (running !== undefined) {
      return running;
    }
    const task = capture(prefs.shell, cwd);
    inflight.set(key, task);
    try {
      const env = await task;
      // **失败不入缓存**:一次瞬时失败(rc 里等网络超时)不该被永久记住。
      if (env !== undefined) {
        cached.set(key, env);
      }
      return env;
    } finally {
      inflight.delete(key);
    }
  };
}

/** 取 stderr/stdout 的第一行(日志要短)。 */
function firstLine(text: string): string {
  const line = text.split('\n').find((candidate) => candidate.trim() !== '');
  return line === undefined ? '(无输出)' : line.trim().slice(0, 200);
}
