/**
 * dugite 的**运行期 git 供给**:决定它到底跑哪一个 `git`。
 *
 * ## 为什么需要这个文件(实测,不是推断)
 *
 * dugite **不会**回落到 `PATH` 上的 git。它的
 * `node_modules/dugite/build/lib/git-environment.js` 写死了:
 *
 * ```
 * resolveGitDir(localGitDir = process.env.LOCAL_GIT_DIRECTORY)   // 有变量用它,否则用包内 <dugite>/git
 * resolveGitBinary()   → <gitDir>/bin/git                        // Windows 是 <gitDir>/cmd/git.exe
 * resolveGitExecPath() → GIT_EXEC_PATH ?? <gitDir>/libexec/git-core
 * setupEnvironment()   → GIT_CONFIG_SYSTEM / GIT_TEMPLATE_DIR 也从 <gitDir> 推
 * ```
 *
 * 所以在**没有** `LOCAL_GIT_DIRECTORY` 的情况下,dugite 只会去找它自己那份
 * postinstall 下载的 `node_modules/dugite/git`(本机 149 MB)。四档实测
 * (`docs/host-mirror-adaptation.md` §1.3):
 *
 * | 环境变量 | 结果 |
 * |---|---|
 * | (无) | **FAIL** `ENOENT: Git failed to execute…` |
 * | `LOCAL_GIT_DIRECTORY=<发行版前缀>` | **OK** `git version 2.50.1 (Apple Git-155)` |
 * | 上式 + `GIT_EXEC_PATH=…/libexec/git-core` | **OK**(与上一行逐字相同) |
 * | 只 `GIT_EXEC_PATH=…` | **FAIL**(二进制路径仍取自包内目录) |
 *
 * ⇒ **一个变量就够**,而且 `GIT_EXEC_PATH` **不必**给:dugite 自己从
 * `LOCAL_GIT_DIRECTORY` 推出 `libexec/git-core`。要注意它要的是**一个发行版前缀**
 * (`bin/git` + `libexec/git-core` + `share/git-core/templates`),不是「PATH 上的一个 git」。
 *
 * ## 本仓的选择(要写进报告的那一句)
 *
 * **走 `LOCAL_GIT_DIRECTORY` 路线,不打包 dugite 自带的那份 git。**
 * 理由:宿主本来就在跑系统 git(`src/host/git-runner.ts` 的 `ctx.subprocess`),
 * 而 `git --exec-path` 的 `../..` 就是一个现成的发行版前缀 —— 于是 dugite 买的
 * 是 **API 面**(`exec` 的选项面 / `GitProcess` 式子进程回调 / `parseError` /
 * `GitError` / `IGitResult`),不是「自带 git」。代价:`dugite` 仍然要在 profile 的
 * `node_modules` 里(它现在是 `dependencies` 第一项),但**那份 149 MB 的
 * `node_modules/dugite/git` 与 62 MB 的缓存 tar.gz 都不是运行期必需品**。
 *
 * ⚠️ **本模块不做删除**:`node_modules/dugite/git` 与 `$(os.tmpdir())/dugite-native-*.tar.gz`
 * 今天仍在树上,是否清理是**用户裁决**(见报告「诚实边界」)。
 *
 * ## 解析顺序(每一步都可单独观察)
 *
 * 1. `process.env.LOCAL_GIT_DIRECTORY` —— 已经有人设了就不覆盖(**显式项赢**)。
 * 2. `process.env.DSH_GIT_LOCAL_DIRECTORY` —— 本仓的显式覆盖口(测试夹具用它钉死)。
 * 3. `git --exec-path` 的 `../..` —— 宿主**实际在用的**那个 git 的发行版前缀。
 * 4. 常见前缀表(`/Library/Developer/CommandLineTools/usr`、`/usr`、`/usr/local`、
 *    `/opt/homebrew`、Windows 的 `%ProgramFiles%\Git`)。
 * 5. 都不成立 ⇒ **什么都不设**,让 dugite 用它自带的 `git/`(包内兜底)。
 *
 * 第 3/4 步都要求前缀同时含 `bin/git`(Windows `cmd/git.exe`)**且**含
 * `libexec/git-core`(Windows 的 mingw 变体按 dugite 的规则试)——
 * `/usr` 这种「`git --exec-path` 指到别处」的前缀因此会被跳过,不会给出一个
 * 「找得到二进制、找不到 dashed 子命令」的半残环境。
 *
 * ## 谁调用它
 *
 * `src/host/mirror-runtime.ts` 在**第一次**用 dugite 之前调用
 * {@link ensureDugiteGitDirectory}(幂等)。它**不在模块顶层执行**:宿主启动路径上
 * 不该为了一个可能用不到的能力去 fork 一个 `git --exec-path`。
 *
 * @module dsh-git/host/dugite-env
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** 一次供给解析的结果。 */
export interface IDugiteGitEnv {
  /**
   * 最终交给 dugite 的发行版前缀;**`null` 表示「什么都不设」**
   * (dugite 会用包内 `git/`,拿不到就抛 ENOENT)。
   */
  readonly prefix: string | null;
  /** 这一档是哪来的(用于探针与日志,取值见 {@link DugiteGitEnvSource})。 */
  readonly source: DugiteGitEnvSource;
  /** 人类可读的一句话,直接进日志。 */
  readonly reason: string;
}

/** {@link IDugiteGitEnv.source} 的取值。 */
export type DugiteGitEnvSource =
  | 'already-set'
  | 'DSH_GIT_LOCAL_DIRECTORY'
  | 'git-exec-path'
  | 'known-prefix'
  | 'none';

/** 进程级缓存:解析只做一次。 */
let cached: IDugiteGitEnv | null = null;

/**
 * 一个目录是不是**完整**的 git 发行版前缀。
 *
 * `bin/git`(Windows `cmd/git.exe`)是 dugite 取二进制的位置;
 * `libexec/git-core`(Windows 三个 mingw 变体)是它推 `GIT_EXEC_PATH` 的位置。
 * 两者缺一,dugite 就变成一个「命令找得到、dashed 子命令找不到」的半残环境 ——
 * 实测 `git submodule status` 就落在这一类上,所以两件事必须同时成立。
 *
 * @param dir - 待检目录(绝对路径)。
 * @returns 是否可作为 `LOCAL_GIT_DIRECTORY`。
 */
export function isGitDistributionPrefix(dir: string): boolean {
  const binary =
    process.platform === 'win32' ? join(dir, 'cmd', 'git.exe') : join(dir, 'bin', 'git');
  if (!existsSync(binary)) {
    return false;
  }
  if (process.platform === 'win32') {
    return (
      existsSync(join(dir, 'mingw64', 'libexec', 'git-core')) ||
      existsSync(join(dir, 'clangarm64', 'libexec', 'git-core')) ||
      existsSync(join(dir, 'mingw32', 'libexec', 'git-core'))
    );
  }
  return existsSync(join(dir, 'libexec', 'git-core'));
}

/**
 * 跑 `git --exec-path` 并把它折成发行版前缀。
 *
 * 为什么用它而不是 `which git`:PATH 上那个 `git` 可能是个**转发器**
 * (macOS 的 `/usr/bin/git` 就是),而 `--exec-path` 报的是**真正在跑的那个**
 * git 的 libexec 目录。取它的 `../..` 就得到发行版前缀。
 *
 * 任何一步失败都返回 `null`(不抛):宿主**没有** git 时这条链不能把插件带崩,
 * 它只是让 dugite 落到包内兜底那一档。
 *
 * @returns 通过 {@link isGitDistributionPrefix} 的前缀,或 null。
 */
function prefixFromHostGit(): string | null {
  try {
    const execPath = execFileSync('git', ['--exec-path'], {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (execPath.length === 0) {
      return null;
    }
    // <prefix>/libexec/git-core → ../.. = <prefix>
    const prefix = execPath.replace(/[\\/](libexec|lib)[\\/]git-core[\\/]?$/, '');
    if (prefix === execPath) {
      return null;
    }
    return isGitDistributionPrefix(prefix) ? prefix : null;
  } catch {
    return null;
  }
}

/**
 * 常见安装前缀(第 4 档)。
 *
 * ⚠️ 这一档是**兜底**,不是主路:第 3 档(`git --exec-path`)在任何正常安装上
 * 都会先命中。列出它们是因为「宿主用了自己那套 PATH,`git` 不在里面」是可能的
 * (DSH 的 subprocess 服务用自己的 env)。每一条都要过
 * {@link isGitDistributionPrefix},所以列错不会有后果。
 */
function knownPrefixes(): ReadonlyArray<string> {
  if (process.platform === 'win32') {
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
    return [
      join(programFiles, 'Git'),
      join(programFiles, 'Git', 'mingw64'),
      'C:\\Program Files (x86)\\Git',
    ];
  }
  return [
    // macOS:Apple Git 的发行版根(/usr/bin/git 是转发器)
    '/Library/Developer/CommandLineTools/usr',
    // Homebrew(Intel / Apple Silicon)
    '/usr/local',
    '/opt/homebrew',
    // 大多数 Linux 发行版
    '/usr',
    // Linux 上手装的 git
    '/usr/local/git',
  ];
}

/**
 * 解析 dugite 该用哪个 git 并(第一次调用时)写进 `process.env`。
 *
 * 幂等:第二次直接返回缓存。它**只**设 `LOCAL_GIT_DIRECTORY` ——
 * `GIT_EXEC_PATH` 实测不必给(dugite 自己从前缀推),多设一个反而会在
 * 「前缀换掉但变量留着」时给出一个指向旧 git 的假环境。
 *
 * @returns 本次(或上次)的解析结果。
 */
export function ensureDugiteGitDirectory(): IDugiteGitEnv {
  if (cached !== null) {
    return cached;
  }

  const result = resolveDugiteGitDirectory();
  if (result.prefix !== null) {
    process.env.LOCAL_GIT_DIRECTORY = result.prefix;
  }
  cached = result;
  return result;
}

/**
 * {@link ensureDugiteGitDirectory} 的**纯函数**部分:只算,不写环境变量。
 *
 * 拆出来是为了让探针能在**同一帧**里比较「有这个前缀 / 没有这个前缀」两档,
 * 而不会互相污染(探针要的是读数,不是副作用)。
 *
 * @returns 解析结果(可能 `prefix === null`)。
 */
export function resolveDugiteGitDirectory(): IDugiteGitEnv {
  const preset = process.env.LOCAL_GIT_DIRECTORY;
  if (preset !== undefined && preset.length > 0) {
    return {
      prefix: preset,
      source: 'already-set',
      reason: `LOCAL_GIT_DIRECTORY 已由外部设定,原样保留:${preset}`,
    };
  }

  const override = process.env.DSH_GIT_LOCAL_DIRECTORY;
  if (override !== undefined && override.length > 0) {
    return isGitDistributionPrefix(override)
      ? {
          prefix: override,
          source: 'DSH_GIT_LOCAL_DIRECTORY',
          reason: `DSH_GIT_LOCAL_DIRECTORY 指定且形态完整:${override}`,
        }
      : {
          prefix: null,
          source: 'none',
          reason:
            `DSH_GIT_LOCAL_DIRECTORY=${override} 形态不完整(缺 bin/git 或 libexec/git-core)` +
            ' ⇒ 不设变量,交给 dugite 包内兜底',
        };
  }

  const fromHost = prefixFromHostGit();
  if (fromHost !== null) {
    return {
      prefix: fromHost,
      source: 'git-exec-path',
      reason: `由 \`git --exec-path\` 的 ../.. 推出:${fromHost}`,
    };
  }

  for (const candidate of knownPrefixes()) {
    if (isGitDistributionPrefix(candidate)) {
      return {
        prefix: candidate,
        source: 'known-prefix',
        reason: `常见前缀表命中:${candidate}`,
      };
    }
  }

  return {
    prefix: null,
    source: 'none',
    reason: '没有找到完整的 git 发行版前缀 ⇒ 不设 LOCAL_GIT_DIRECTORY(dugite 用包内 git/ 兜底)',
  };
}

/**
 * 供测试复位(探针需要在同一进程里重跑两档)。
 *
 * @internal
 */
export function resetDugiteGitDirectoryCacheForTests(): void {
  cached = null;
}
