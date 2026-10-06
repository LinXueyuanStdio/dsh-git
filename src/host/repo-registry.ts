/**
 * 「添加过的本地仓库」清单 + host 侧凭据/偏好:持久化在插件自己的 storage domain。
 *
 * 存储形状(照 dsh-schedule 的用法):`defineDomain({ name, version, global })`,
 * 打开后读 `domain.global.get()`(同步)、写 `domain.global.set(value)`(异步、
 * 先落盘再改内存)。domain 不可用时退化为纯内存模式,功能不中断。
 *
 * 令牌只存在 host:浏览器拿不到完整值,界面只看尾 4 位;git 通过环境变量拿到它。
 *
 * ## 令牌不在这个 storage domain 里
 *
 * 令牌归 host 入口装上的 {@link TokenHome}(宿主凭据缝,见
 * `host/credential-bridge.ts`):`githubToken()` 与 `setGithubToken()` 都走那里,
 * 本类持久化的只有仓库清单与偏好。凭据服务不可用时(`tokenHome === null`)令牌
 * 只活在 {@link memoryToken} 里过完这一次运行,重启后需要重新登录 —— 这是有意的
 * 严格策略:本插件在任何情况下都不自己持久化明文令牌。
 * @module dsh-git/host/repo-registry
 */

import { stat } from 'node:fs/promises';
import type { RepoEntry } from '../core/types.ts';
import type { TokenHome, TokenSource } from './credential-bridge.ts';
import {
  DEFAULT_HOOK_ENV_SHELL, isHooksEnvShell,
  type HooksEnvPrefs,
} from './hooks-env.ts';

/**
 * 默认 GitHub 端点(github.com 的 REST API 基址)。
 *
 * 「旧数据不许炸」这条兼容要求落在这里:存储里没有 `githubEndpoint` 的账号
 * (加这个字段之前登录的)读出来就是它 —— 见 {@link RepoRegistry.githubEndpoint}。
 */
export const DEFAULT_GITHUB_ENDPOINT = 'https://api.github.com';

/**
 * 宿主存储域 `prefs` 的**全部键**,同时也是 `prefs/set` 的载荷形状。
 *
 * 前三个键服务「提交信息生成 / 生成范围」;后三个是本轮补的 **Hooks 环境偏好**
 * (客户端三个 localStorage 键的宿主侧落点):
 *
 * | 这里的键 | 客户端镜像的 localStorage 键 | 默认值 |
 * |---|---|---|
 * | `hooksEnvEnabled` | `git-hooks-env-enabled` | `false`(`enableHooksByDefault()`) |
 * | `cacheHooksEnv` | `git-cache-hooks-env` | `true` |
 * | `hookEnvShell` | `git-hook-env-shell` | `'git-bash'` |
 *
 * ⚠️ 加字段时**必须同时改 `src/index.ts` 的 zod schema**:`z.object` 会 strip
 * 未声明的键,写盘会成功、下次 open 解析时被悄悄丢掉(`githubEndpoint` /
 * `lastSelected` 的同一族教训)。嵌套对象不在 `selfCheck()` 的顶层检查里 ——
 * 那里现在补了一条针对 `prefs` 的往返检查(见 `src/index.ts`)。
 *
 * 用 `type` 而不是 `interface`:本仓 ESLint 的 `naming-convention` 要求 interface 名
 * 以 `I[A-Z]` 开头(`.eslintrc.yml:67-74`),而这个名字在宿主侧读起来不该带那个前缀。
 */
export type PrefsPatch = {
  model?: string;
  stagedOnly?: boolean;
  systemPrompt?: string;
  /** Hooks:是否把 shell 环境注入 git 子进程。 */
  hooksEnvEnabled?: boolean;
  /** Hooks:shell 环境是否跨操作复用(上游 `memoizeOne` 的 cacheKey 开关)。 */
  cacheHooksEnv?: boolean;
  /** Hooks:用哪个 shell 捕获环境(仅 Windows 有效,非法值在读侧折回默认)。 */
  hookEnvShell?: string;
}

/** domain.global 的最小子集。 */
export interface GlobalHandle<T> {
  get(): T | undefined;
  set(value: T): Promise<void>;
}

/** storage domain 的最小子集。 */
export interface DomainLike {
  readonly global: GlobalHandle<StoredState>;
  close?(): Promise<void>;
}

/** 落盘的完整状态:一个 global,避免多表迁移。 */
export interface StoredState {
  version: 1;
  entries: RepoEntry[];
  hiddenRemotes: string[];
  /**
   * 当前账号的 GitHub **API 基址**(企业实例用;归一化规则见 `host/auth.ts` 的
   * `normalizeGithubEndpoint`)。
   *
   * 缺席 = 旧数据 / 从未配过端点 ⇒ 读的时候按
   * {@link DEFAULT_GITHUB_ENDPOINT}(github.com)。**必须同时加进
   * `src/index.ts` 的 zod schema**:`z.object` 会 strip 未声明键,只在这里加字段
   * 的话写盘会成功、下次 open 解析时被悄悄丢掉(`lastSelected` 那条教训的同一族,
   * 见 `src/index.ts:175-182`)。
   */
  githubEndpoint?: string;
  deviceId: string;
  prefs: PrefsPatch;
  remoteCache: { fetchedAt: number; repos: RemoteRepoLite[] } | null;
  lastFetchedAt: Record<string, string>;
  /** 上次选中的仓库路径:重开页签/重启后据此恢复选中项。 */
  lastSelected?: string;
}

/** 远程仓库缓存条目(GitHub 列表用)。 */
export interface RemoteRepoLite {
  fullName: string;
  isPrivate: boolean;
  pushedAt: string;
  description?: string;
}

function emptyState(): StoredState {
  return {
    version: 1,
    entries: [],
    hiddenRemotes: [],
    deviceId: '',
    prefs: {},
    remoteCache: null,
    lastFetchedAt: {},
  };
}

/** 仓库清单控制器:内存镜像 + 每次写入落盘。 */
export class RepoRegistry {
  private state: StoredState = emptyState();
  private domain: DomainLike | null = null;
  /** 装载完成(挂 domain 之后才有意义)。 */
  private ready: Promise<void>;
  /** 存储不可用时的原因;非 null 表示本次运行不落盘。 */
  private storageError: string | null = null;
  /**
   * 最近一次**写入**失败的消息(打开成功但写不进去)。
   *
   * 这个字段以前只被 `storageStatus()` 读、**从来没被声明也从来没被赋值** ——
   * 于是 `this.lastWriteError` 恒为 `undefined`,而判断写的是 `!== null`,
   * `undefined !== null` 为 true,导致只要存储打开成功就**永远谎报**
   * 「写入失败: undefined」。实测:磁盘上的 dsh_git.json 内容完全正确,
   * 界面却一直说「只在内存里、重启就丢」。
   */
  private lastWriteError: string | null = null;
  /**
   * 没有凭据服务时的令牌副本(**只在内存里**,永不落盘)。
   *
   * 存在的理由:那种 profile 里登录仍要能用完这一次运行;代价是重启后需要重新
   * 登录。刻意不做任何形式的明文持久化(见类头注释)。
   */
  private memoryToken = '';

  /**
   * 落盘失败时的可选**观察者**(host 入口接线用,见 {@link persist} 的 catch)。
   *
   * 这条字段以前**从来没被声明过**,而 `persist()` 里一直在用
   * `this.onPersistError?.(...)`:
   *
   *  - 编译期:TS2339 `Property 'onPersistError' does not exist on type 'RepoRegistry'`;
   *  - 运行期:**不崩**(可选调用 `undefined?.()` 是静默空操作)——
   *    但这正是它难被发现的原因:「落盘失败时通知观察者」这条通道**从来没有接通过**,
   *    写盘失败只会留在 `lastWriteError` 里。
   *
   * 所以修法是**把契约补出来**(可选属性,与 `?.` 的写法一致),而不是删掉调用点:
   * 删掉等于把作者写的通知点也一起扔掉。接线与否是 host 入口的决定
   * (`src/index.ts:192` 有现成的 `log()` 可以接上;那个文件不在本次改动范围内)。
   * **没接线也不会出错**,`storageStatus()`/`health` 已经把 `lastWriteError`
   * 交给界面了。
   */
  onPersistError?: (message: string) => void;

  /**
   * 令牌的存放位置,由 host 入口在 apply 里装上(见 `src/index.ts` 的
   * `startTokenHome()`)。`null` = 这个 profile 没有可用的凭据服务:令牌只留在
   * {@link memoryToken} 里过完本次运行。
   *
   * 与上面的 {@link onPersistError} 同样是**可选公开字段**:装上与否是 host
   * 入口的决定,没装上也必须能正常工作。
   */
  public tokenHome: TokenHome | null = null;

  /**
   * @param domain - storage domain;apply 里是异步打开的,所以允许先传 null 再
   *   用 {@link useDomain} 挂上。**必须挂上**,否则 persist() 会静默空转。
   */
  constructor(domain: DomainLike | null = null) {
    this.domain = domain;
    this.ready = this.load();
  }

  private async load(): Promise<void> {
    if (this.domain === null) return;
    try {
      const stored = this.domain.global.get();
      if (stored !== undefined && typeof stored === 'object' && stored !== null) {
        this.state = { ...emptyState(), ...stored, version: 1 };
        if (!Array.isArray(this.state.entries)) this.state.entries = [];
        if (!Array.isArray(this.state.hiddenRemotes)) this.state.hiddenRemotes = [];
        // 端点的空值同理:`load()` 删掉它,免得每次 persist() 都把一个空串写回 JSON。
        if ((this.state.githubEndpoint ?? '') === '') {
          delete this.state.githubEndpoint;
        }
      }
      this.storageError = null;
    } catch (error) {
      // 读失败退化为空清单;用户重新添加即可。
      this.storageError = error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * 挂上 storage domain 并装载已存状态。
   *
   * 时序:git 服务需要提前拿到 registry 实例(构造时还没有 domain),因此
   * apply 打开 domain 之后调用这里把它接上。之前用「另一个实例 + adopt(state)」
   * 的做法**搬了 state 却漏了 domain**,导致主实例的 persist() 永远空转 ——
   * 清单与令牌重启即丢。现在 domain 与 state 一起挂。
   * @param domain - 已打开的 storage domain。
   */
  async useDomain(domain: DomainLike): Promise<void> {
    this.domain = domain;
    this.ready = this.load();
    await this.ready;
  }

  /** 首次装载完成。 */
  async whenReady(): Promise<void> {
    await this.ready;
  }

  /** 存储状态:persistent=false 表示本次运行只在内存里(重启丢数据)。 */
  storageStatus(): { persistent: boolean; error: string | null } {
    // 打开成功但写失败也算不可持久化 —— 否则 health 会谎报。
    if (this.domain !== null && this.lastWriteError !== null) {
      return { persistent: false, error: `写入失败: ${this.lastWriteError}` };
    }
    return { persistent: this.domain !== null && this.storageError === null, error: this.storageError };
  }

  // ---------- 仓库清单 ----------

  list(): RepoEntry[] {
    return [...this.state.entries].sort((a, b) => b.addedAt - a.addedAt);
  }

  /** 安全门:只有清单里的根路径允许跑 git。 */
  allowedRoots(): readonly string[] {
    return this.state.entries.map((e) => e.path);
  }

  find(path: string): RepoEntry | undefined {
    return this.state.entries.find((e) => e.path === path);
  }

  async add(entry: RepoEntry): Promise<RepoEntry[]> {
    this.state.entries = [entry, ...this.state.entries.filter((e) => e.path !== entry.path)];
    await this.persist();
    return this.list();
  }

  async remove(path: string): Promise<RepoEntry[]> {
    this.state.entries = this.state.entries.filter((e) => e.path !== path);
    const { [path]: _dropped, ...rest } = this.state.lastFetchedAt;
    this.state.lastFetchedAt = rest;
    await this.persist();
    return this.list();
  }

  async rename(path: string, alias: string): Promise<RepoEntry[]> {
    this.state.entries = this.state.entries.map((e) => {
      if (e.path !== path) return e;
      if (alias === '') {
        const { alias: _a, ...rest } = e;
        return { ...rest, name: e.path.split('/').pop() ?? e.path };
      }
      return { ...e, alias, name: alias };
    });
    await this.persist();
    return this.list();
  }

  /** 上次选中的仓库路径(可能已被移除,调用方需自行校验存在性)。 */
  lastSelected(): string {
    return this.state.lastSelected ?? '';
  }

  /** 记住当前选中的仓库(用于重开页签/重启后恢复)。 */
  async setLastSelected(path: string): Promise<void> {
    if (this.state.lastSelected === path) return;
    this.state.lastSelected = path;
    await this.persist();
  }

  /**
   * 重新检查每个仓库目录是否还在,更新 `missing` 标记。
   *
   * 对应 Desktop 的 `Repository.missing`(列表里显示「Can't find <name>」,
   * 并把 Open in shell / Reveal / 编辑器 三项菜单置灰)。标记变化才落盘,避免每次
   * 打开下拉都写一次。
   * @returns 有变化时为 true。
   */
  async refreshMissing(): Promise<boolean> {
    let changed = false;
    for (const entry of this.state.entries) {
      let missing = false;
      try {
        missing = !(await stat(entry.path)).isDirectory();
      } catch {
        missing = true;
      }
      if ((entry.missing === true) !== missing) {
        entry.missing = missing;
        changed = true;
      }
    }
    if (changed) await this.persist();
    return changed;
  }

  /** 更新派生字段(远端 owner/repo、当前分支),不改排序时间。 */
  async touch(path: string, patch: Partial<Pick<RepoEntry, 'remote' | 'branch' | 'missing'>>): Promise<void> {
    this.state.entries = this.state.entries.map((e) => (e.path === path ? { ...e, ...patch } : e));
    await this.persist();
  }

  hidden(): string[] {
    return this.state.hiddenRemotes;
  }

  async hideRemote(fullName: string): Promise<void> {
    this.state.hiddenRemotes = [fullName, ...this.state.hiddenRemotes.filter((x) => x !== fullName)];
    await this.persist();
  }

  async unhideRemote(fullName: string): Promise<void> {
    this.state.hiddenRemotes = this.state.hiddenRemotes.filter((x) => x !== fullName);
    await this.persist();
  }

  // ---------- 凭据 ----------

  /**
   * 装上令牌的存放位置(宿主凭据缝)。
   * @param home - 凭据桥(见 `host/credential-bridge.ts`)。
   */
  public useTokenHome(home: TokenHome): void {
    this.tokenHome = home;
  }

  /** 令牌当前来自哪一层(界面与日志用,**永不**返回值本身)。 */
  public githubTokenSource(): TokenSource {
    if (this.tokenHome !== null) {
      return this.tokenHome.source();
    }
    return this.memoryToken === '' ? 'none' : 'memory';
  }

  githubToken(): string {
    return this.tokenHome !== null ? this.tokenHome.read() : this.memoryToken;
  }

  /** 界面展示用:只给尾 4 位,永不回传完整令牌。 */
  githubTokenTail(): string {
    const t = this.githubToken();
    return t === '' ? '' : t.slice(-4);
  }

  /**
   * 当前账号的 GitHub **API 基址**。
   *
   * 旧数据(加这个字段之前登录的账号)没有这个键 ⇒ 回
   * {@link DEFAULT_GITHUB_ENDPOINT}。这条默认是**兼容契约**的一部分:
   * 已有的登录态绝不允许因为多了一个字段而被判成「未登录」或指向错误的 host。
   */
  githubEndpoint(): string {
    const stored = (this.state.githubEndpoint ?? '').trim();
    return stored === '' ? DEFAULT_GITHUB_ENDPOINT : stored;
  }

  /**
   * 记下当前账号的端点(登录时与令牌一起写)。
   * @param endpoint - 已归一化的 API 基址;`''` = 清掉(登出),此后读回默认端点。
   */
  async setGithubEndpoint(endpoint: string): Promise<void> {
    const next = endpoint.trim();
    if (next === '') {
      delete this.state.githubEndpoint;
    } else {
      this.state.githubEndpoint = next;
    }
    await this.persist();
  }

  deviceId(): string {
    return this.state.deviceId;
  }

  /**
   * 换令牌(登录 / 登出都走这里)。
   *
   * 交给凭据桥落盘;没有桥(profile 缺凭据服务)时只记在 {@link memoryToken} 里,
   * 并报一条诊断 —— 本次运行照常可用,重启后需要重新登录,明文不写到任何地方。
   * @param token - 新令牌;`''` = 登出。
   * @param deviceId - 一并记下的设备 id(设备码流程用)。
   */
  async setGithubToken(token: string, deviceId?: string): Promise<void> {
    if (this.tokenHome !== null) {
      await this.tokenHome.write(token);
    } else {
      this.memoryToken = token;
      this.onPersistError?.(
        '凭据服务不可用:GitHub 令牌只在本次运行有效(重启后需要重新登录),未写入任何明文位置。',
      );
    }
    if (deviceId !== undefined) this.state.deviceId = deviceId;
    await this.persist();
  }

  // ---------- 辅助生成偏好 ----------

  prefModel(): string {
    return this.state.prefs.model ?? '';
  }

  prefStagedOnly(): boolean {
    return this.state.prefs.stagedOnly !== false;
  }

  /**
   * 存储里**原样**的 stagedOnly:未设置过是 `undefined`,明确设成 `false` 是 `false`。
   *
   * 为什么不能只用 {@link prefStagedOnly}:它把「从未设置」和「明确设成 false」
   * 都折成 `true`/`false` 里的一个值(那是 host 生成时的默认值判定,没问题),
   * 但 `prefs/get` 要把这个区别交给客户端 —— 否则客户端每次都拿到一个具体值,
   * 「从未设置 → 用默认」这条分支就再也走不到了。
   */
  prefStagedOnlyRaw(): boolean | undefined {
    return this.state.prefs.stagedOnly;
  }

  prefSystemPrompt(): string {
    return this.state.prefs.systemPrompt ?? '';
  }

  // ---------- Hooks 环境偏好(三个键,见 PrefsPatch)----------

  /**
   * Hooks 三个偏好的**生效值**:未设置过就用与镜像 `lib/hooks/config.ts` 一致的默认值。
   *
   * 这是 `host/hooks-env.ts` 的**唯一**输入(它每次 spawn 前都重读 ⇒ 用户一改立刻生效,
   * 不需要重启;偏好的写入是 `prefs/set` 路由)。
   * @returns 生效的三元组。
   */
  public prefHooksEnv(): HooksEnvPrefs {
    const shell = this.state.prefs.hookEnvShell;
    return {
      // 默认值三个与镜像的同名默认值一致,理由见 PrefsPatch 的表。
      enabled: this.state.prefs.hooksEnvEnabled ?? false,
      cache: this.state.prefs.cacheHooksEnv ?? true,
      shell: isHooksEnvShell(shell) ? shell : DEFAULT_HOOK_ENV_SHELL,
    };
  }

  /**
   * 三个键**原样**的值(未设置过 = `undefined`)。
   *
   * 与 {@link prefStagedOnlyRaw} 同一条理由:`prefs/get` 要让客户端分得清
   * 「从没设置过」与「明确设成了默认值」,不然那种区分在载荷里就消失了。
   */
  public prefHooksEnvRaw(): { enabled?: boolean; cache?: boolean; shell?: string } {
    const out: { enabled?: boolean; cache?: boolean; shell?: string } = {};
    const { hooksEnvEnabled, cacheHooksEnv, hookEnvShell } = this.state.prefs;
    if (hooksEnvEnabled !== undefined) {
      out.enabled = hooksEnvEnabled;
    }
    if (cacheHooksEnv !== undefined) {
      out.cache = cacheHooksEnv;
    }
    if (hookEnvShell !== undefined) {
      out.shell = hookEnvShell;
    }
    return out;
  }

  public async setPrefs(patch: PrefsPatch): Promise<void> {
    this.state.prefs = { ...this.state.prefs, ...patch };
    await this.persist();
  }

  // ---------- 远程仓库缓存与抓取时间 ----------

  cachedRemoteRepos(maxAgeMs: number): RemoteRepoLite[] | null {
    const cache = this.state.remoteCache;
    if (cache === null) return null;
    if (Date.now() - cache.fetchedAt > maxAgeMs) return null;
    return cache.repos;
  }

  async setRemoteRepos(repos: RemoteRepoLite[]): Promise<void> {
    this.state.remoteCache = { fetchedAt: Date.now(), repos };
    await this.persist();
  }

  lastFetched(path: string): string | null {
    return this.state.lastFetchedAt[path] ?? null;
  }

  async markFetched(path: string): Promise<void> {
    this.state.lastFetchedAt = { ...this.state.lastFetchedAt, [path]: new Date().toISOString() };
    await this.persist();
  }

  private async persist(): Promise<void> {
    if (this.domain === null) return;
    try {
      await this.domain.global.set(this.state);
      // 成功即清掉上一次的错误 —— 否则一次瞬时失败会把状态永久钉在「不可持久化」。
      this.lastWriteError = null;
    } catch (error) {
      // 落盘失败不阻断内存态(下一次写入会再试),但必须**记下来**,
      // 否则 storageStatus() 会谎报持久化正常。
      this.lastWriteError = error instanceof Error ? error.message : String(error);
      this.onPersistError?.(this.lastWriteError);
    }
  }
}
