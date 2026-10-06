/**
 * dsh-git —— host 半。
 *
 * 职责:
 *  1. 用自己的 storage domain 持久化「添加过的本地仓库」清单、GitHub 令牌与
 *     辅助生成偏好(GitHub 令牌只存在 host,浏览器拿不到完整值);
 *  2. 在共享 webServer 上注册 /dsh-git/* 路由(只允许 loopback):
 *     本地 git 全部动作 + DSH 模型生成提交信息 + GitHub 设备码登录;
 *  3. 提供目录选择(添加本地仓库时用宿主能力,拿不到就让前端手输路径)。
 *
 * 浏览器半(exports "./client")由 client-modules 依据 package.json 的
 * dsh.client 声明加载,注册官方右侧栏 tab。
 * @module dsh-git
 */

import { z } from 'zod';
import schemastery from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import { CommitMessageGenerator, type LlmModelChoice } from './host/commit-message.ts';
import { GithubAuth } from './host/auth.ts';
import { GitService } from './host/git-service.ts';
import { RepoRegistry, type DomainLike, type PrefsPatch } from './host/repo-registry.ts';
import {
  createCredentialBridge, GITHUB_TOKEN_REF,
  type CredentialService, type TokenHome,
} from './host/credential-bridge.ts';
import { createGitHandler, ROUTE_PREFIX } from './host/routes.ts';
import { SystemService } from './host/system-service.ts';
import { subprocessRunner, type SubprocessLike } from './host/git-runner.ts';
import { createHooksEnvProvider } from './host/hooks-env.ts';

/** 插件名(loader 诊断用)。 */
export const name = 'dsh-git';

/** 需要的宿主服务:webServer(路由)、subprocess(跑 git)、storageDomain(持久化)。 */
export const inject = ['webServer', 'subprocess', 'storageDomain'];

/**
 * 插件配置 —— **宿主设置面板的数据源**。
 *
 * 这是 DSH「插件声明一次、宿主渲染」那条机制的两半之一(host 半):宿主
 * `SettingsForms.describe()` 读 `entry.fiber.runtime.Config`
 * (`packages/settings/settings/src/index.ts:425-428`),要求它是**有 `toJSON()` 的
 * schemastery schema**,并只把标了 `.volatile()` 的字段投影成设置表单。
 * 判据与 cookbook 见 `references/deepseek-harness/docs/cookbook/adding-a-settings-card.md`。
 *
 * 两条不同的语义,不要混:
 *  - `clientId` —— **部署期**配置(这个部署用哪个 GitHub OAuth App),
 *    **刻意不标 volatile** ⇒ 不进设置表单。它由 profile 的 `cordis.patch.yml`
 *    的 `config:` 填,这里是它的**声明与激活期校验**。
 *  - `autoSec` —— **用户偏好**(Pulls 页签的自动刷新周期,秒;0 = 关闭),
 *    标 `.volatile()` ⇒ 在宿主的「设置 ▸ 插件」里可编辑,值落进 profile patch。
 *    它接的是老的 `gw.autoSec` 孤儿:那个键在 `src/client/pulls-view.tsx` 只有
 *    读点、全仓 0 个写点 ⇒ 自动刷新恒关且用户改不了(见
 *    `docs/plugin-settings.md` §6 桶 (i))。
 *
 * 命名是**扁平**的:宿主的表单模型按**单段路径**编辑字段
 * (`packages/client/ui-primitives/src/settings-form/form-model.ts:342` 的
 * `path: [field]`),`gw.autoSec` 那种带点的键名不能作为一段路径。所以字段名取
 * `autoSec`,插件命名空间(`dsh-git`)已经承担了 `gw.` 那层前缀。
 */
export const Config = schemastery.object({
  clientId: schemastery.string().default(''),
  autoSec: schemastery.number().step(1).min(0).max(600).default(0).volatile(),
});

/**
 * 插件**收到**的配置值 —— 从上面那份 schema 推导,**不另写一份 interface**。
 *
 * 理由:`apply` 的参数类型与 schema 若各写一遍就会漂移(那正是下面
 * `selfCheck()` 想防的同一类问题)。推导出来还顺带带上 volatile 字段的正确类型
 * (`.volatile()` 的字段在这里是 `Volatile<number>` 引用,不是裸 number)。
 */
export type PluginConfig = ReturnType<typeof Config>;

/** 宿主 ctx 的最小结构切面(只用到的几个服务)。 */
interface HostCtx {
  effect(fn: () => (() => void) | void, label?: string): void;
  inject?(deps: readonly string[], fn: (injected: { get(name: string): unknown }) => (() => void) | void): { dispose?: () => void };
  /**
   * 可选服务访问。**必须用 get() 而不是 ctx.foo** —— cordis 的 Context 代理会拒绝
   * 访问未在 inject 里声明的服务(实测报错:`cannot get property "x" without inject`)。
   */
  get?(name: string): unknown;
  /**
   * 事件总线(cordis 把 `EventsService` 的方法混进 ctx,见
   * `references/deepseek-harness/vendor/cordis/src/context.ts:22-24`)。
   * 用来在凭据值被外部改动后重取 —— 宿主对 `.credentials.yaml` 的热发布就是
   * `credentials/reference-updated`(`credentials/src/types.ts:87`)。
   */
  on?(event: string, listener: (subject: string) => void): (() => void) | undefined;
  webServer?: {
    register(route: { kind: 'prefix' | 'exact'; path: string; handler: (req: unknown, res: unknown) => void }): () => void;
  };
  subprocess?: unknown;
  storageDomain?: { open(spec: unknown): Promise<DomainLike> };
  directoryPickerController?: { pick(signal: AbortSignal): Promise<string | null> };
  logger?: { warn(message: string): void; info?(message: string): void };
}

/** ctx.llm 的结构切面(与 host/commit-message.ts 的同名接口一致)。 */
interface LlmServiceLike {
  listProviders(): readonly { id: string; name: string }[];
  listModels(provider: string): Promise<readonly { id: string; name: string; provider: string }[]>;
  stream(options: Record<string, unknown>): AsyncIterable<unknown>;
}

/**
 * storage domain 描述:一个 global 承载全部状态(仓库清单 + 偏好)。
 * zod schema 照 dsh-storage-domain 的约定;null 不被接受(它是「从未写入」的哨兵)。
 * `tables: {}` 不可省:descriptorOf() 会对 spec.tables 做 Object.keys。
 *
 * **令牌不在这个 schema 里**(它在宿主凭据缝,见 `host/credential-bridge.ts`)。
 * `z.object` 会 strip 未声明键,所以即使某个文件里还留着令牌键,读进来也会被丢掉,
 * 此后任何一次 persist() 都不会把它写回 JSON。
 */
/** global 的初值;`.default()` 与 `initial` 共用它,避免两处漂移。 */
const INITIAL_GLOBAL = {
  version: 1 as const,
  entries: [] as {
    path: string; name: string; alias?: string; remote: string | null;
    addedAt: number; missing?: boolean; branch?: string;
  }[],
  hiddenRemotes: [] as string[],
  /**
   * 当前账号的 GitHub API 基址(企业实例)。
   *
   * 空串 = 默认 `https://api.github.com`(旧数据 / 从未配过端点):
   * `RepoRegistry.githubEndpoint()` 负责这个默认值。
   * **必须同时声明在下面的 zod schema 里** —— `z.object` 会 strip 未声明键,
   * 只加在这里会让端点写盘成功、下次 open 解析时丢掉(`lastSelected` 的同一族教训)。
   */
  githubEndpoint: '',
  deviceId: '',
  prefs: {} as PrefsPatch,
  remoteCache: null as null | { fetchedAt: number; repos: { fullName: string; isPrivate: boolean; pushedAt: string; description?: string }[] },
  lastFetchedAt: {} as Record<string, string>,
  lastSelected: '',
};

/** 构建时间戳(由 scripts/build.mjs 通过 esbuild define 注入)。 */
declare const __BUILD_STAMP__: string | undefined;

/**
 * `prefs` 里**用户偏好**的全部键。
 *
 * 存在的理由:`selfCheck()` 原来只核对 `INITIAL_GLOBAL` 的**顶层**键,而 `prefs`
 * 是一个整体 —— 里面少声明一个键(比如本轮的 `hooksEnvEnabled`)顶层检查
 * **发现不了**,表现却与 `githubEndpoint` 那次的完全相同:写盘成功、下次 open 被 strip。
 * 这份清单让那条检查覆盖到嵌套层;加偏好键时**三处一起改**
 * (`PrefsPatch` / zod schema / 这里)。
 */
const PREFS_KEYS = [
  'model', 'stagedOnly', 'systemPrompt',
  'hooksEnvEnabled', 'cacheHooksEnv', 'hookEnvShell',
] as const;

/** 本产物的构建时间;未注入时回退为「未知」。 */
const BUILD_STAMP: string = typeof __BUILD_STAMP__ === 'string' ? __BUILD_STAMP__ : '未知';

export const DOMAIN_SPEC = {
  // storage domain 名只允许 [a-z][a-z0-9_]*(不允许连字符),品牌名 dsh-git 在这里写作 dsh_git。
  name: 'dsh_git',
  version: 1,
  tables: {},
  global: {
    schema: z.object({
      version: z.literal(1).default(1),
      entries: z.array(z.object({
        path: z.string().min(1),
        name: z.string().min(1),
        alias: z.string().optional(),
        remote: z.string().nullable(),
        addedAt: z.number(),
        missing: z.boolean().optional(),
        branch: z.string().optional(),
      })).default([]),
      hiddenRemotes: z.array(z.string()).default([]),
      /** 见 `INITIAL_GLOBAL.githubEndpoint`:空串 = github.com(旧数据的默认)。 */
      githubEndpoint: z.string().default(''),
      deviceId: z.string().default(''),
      prefs: z.object({
        model: z.string().optional(),
        stagedOnly: z.boolean().optional(),
        systemPrompt: z.string().optional(),
        /*
         * Hooks 环境偏好(2026-10)的三个键,形状见 `RepoRegistry` 的 `PrefsPatch`。
         *
         * **必须声明在这里**:`z.object` 默认 strip 未知键,而这三个键是**嵌套**在
         * `prefs` 里的 —— `selfCheck()` 原来只核对 `INITIAL_GLOBAL` 的**顶层**键,
         * 嵌套层少声明一个键它发现不了(这正是 `githubEndpoint` / `lastSelected`
         * 那一族教训的嵌套版本)。⇒ 同一次改动给 selfCheck 补了一条 `prefs`
         * 往返检查,见下面那一段。
         */
        hooksEnvEnabled: z.boolean().optional(),
        cacheHooksEnv: z.boolean().optional(),
        hookEnvShell: z.string().optional(),
      }).default({}),
      remoteCache: z.object({
        fetchedAt: z.number(),
        repos: z.array(z.object({
          fullName: z.string(),
          isPrivate: z.boolean(),
          pushedAt: z.string(),
          description: z.string().optional(),
        })),
      }).nullable().default(null),
      lastFetchedAt: z.record(z.string(), z.string()).default({}),
      /**
       * 上次选中的仓库路径。
       *
       * **必须在这里声明**:zod 的 z.object 默认 strip 未知键,所以只在
       * RepoRegistry 的 TS 接口上加字段是不够的 —— 写盘会成功、下次 open 解析时
       * 被悄悄丢掉(已用 zod 4.6.5 实测复现)。TS 接口和这份 schema 必须同步改。
       */
      lastSelected: z.string().default(''),
    }).default(INITIAL_GLOBAL),
    /**
     * 新域的 global 初值。`DomainGlobalSpec.initial` 是**必填**的:
     * 缺了它,新域上 `global.get()` 会返回 undefined 而不是默认值。
     * 已有域仍走 schema 的 .default(),两处都指向同一份常量以免漂移。
     */
    initial: INITIAL_GLOBAL,
  },
};

/**
 * 加载期自检。
 *
 * esbuild **不做类型检查**(`npm run check` 只有 `node --check`),所以
 * 「TS 接口加了字段但 zod schema 忘了加」这类结构性错误编译期完全看不见 ——
 * `tables:{}`、缺 `initial`、缺 `lastSelected` 三个 bug 都是这样溜进产物的。
 * 这里在模块加载时主动跑一遍:
 *   1. defineDomain 校验 name/version/tables 等结构约束;
 *   2. 用一份「全字段填充」的状态做一次 parse 往返,检查有没有字段被 zod strip。
 */
function selfCheck(): string[] {
  const problems: string[] = [];

  // 结构约束复刻自 dsh-storage-domain 的 defineDomain。
  //
  // **刻意不 import 那个包**:本插件是软链接在 profile 的 node_modules 下的,真实路径
  // 在 @deepseek-ai/ 之外,Node 从那里向上找不到该包 —— 一条静态 import 解析失败就会让
  // 整个 host 插件加载失败。而 storageDomain **服务**只暴露 open/get/closeAll,没有
  // defineDomain。所以这里内联这几条检查,零依赖、零风险。
  if (!/^[a-z][a-z0-9_]*$/.test(DOMAIN_SPEC.name)) {
    problems.push(`domain 名 ${DOMAIN_SPEC.name} 必须匹配 /^[a-z][a-z0-9_]*$/`);
  }
  if (!Number.isInteger(DOMAIN_SPEC.version) || DOMAIN_SPEC.version < 0) {
    problems.push(`domain 版本必须是非负整数,当前 ${DOMAIN_SPEC.version}`);
  }
  if (typeof DOMAIN_SPEC.tables !== 'object' || DOMAIN_SPEC.tables === null) {
    problems.push('domain 缺 tables(descriptorOf 会对它做 Object.keys)');
  }
  if (DOMAIN_SPEC.global.initial === undefined) {
    problems.push('global 缺 initial(DomainGlobalSpec.initial 是必填)');
  }

  try {
    const probe = DOMAIN_SPEC.global.schema.parse({ ...INITIAL_GLOBAL, lastSelected: '/probe' });
    const missing = Object.keys(INITIAL_GLOBAL).filter((key) => !(key in probe));
    if (missing.length > 0) {
      problems.push(`schema 会丢弃这些字段(落盘成功但读回即丢): ${missing.join(', ')}`);
    }
    if ((probe as { lastSelected?: string }).lastSelected !== '/probe') {
      problems.push('lastSelected 没有在 parse 后保留');
    }
    /*
     * 嵌套层:上面那条只看 `INITIAL_GLOBAL` 的顶层键,`prefs` 里少声明一个键它
     * 查不出来 —— 而「写盘成功、下次 open 被 strip」的表现与顶层那次一模一样。
     * 这里按 `PREFS_KEYS` 逐键核对(每个键都给一个**非默认**值,顺带证明它能被
     * 原样带过去,而不只是「键还在」)。
     */
    const prefProbe = DOMAIN_SPEC.global.schema.parse({
      ...INITIAL_GLOBAL,
      prefs: {
        model: 'probe/model', stagedOnly: false, systemPrompt: 'probe-prompt',
        hooksEnvEnabled: true, cacheHooksEnv: false, hookEnvShell: 'pwsh',
      },
    }).prefs as Record<string, unknown>;
    const missingPrefs = PREFS_KEYS.filter((key) => !(key in prefProbe));
    if (missingPrefs.length > 0) {
      problems.push(`schema 会丢弃这些偏好字段(落盘成功但读回即丢): ${missingPrefs.join(', ')}`);
    }
    if (prefProbe.hooksEnvEnabled !== true || prefProbe.cacheHooksEnv !== false || prefProbe.hookEnvShell !== 'pwsh') {
      problems.push('prefs 的 Hooks 三键没有在 parse 后原样保留');
    }
  } catch (error) {
    problems.push(`global schema 往返自检抛错: ${messageOf(error)}`);
  }
  return problems;
}

export function apply(ctx: Context, config?: PluginConfig): () => void {
  const host = ctx as unknown as HostCtx;
  const log = (message: string): void => {
    try { host.logger?.warn(message); } catch { /* logger 缺失:忽略 */ }
  };

  // ---------- 清单与存储 ----------
  const registry = new RepoRegistry(null);
  const domainHolder: { domain: DomainLike | null } = { domain: null };

  // 落盘失败要留下**日志证据**。以前这条通道从没接通过(`onPersistError`
  // 字段都没声明),写盘失败只留在 `lastWriteError` 里、只反映在 health 的
  // 「仅内存」上 —— 事后查日志只能看到「存储 持久化」那一行,看不出中间失败过。
  // 界面已经拿到了原因(`storageStatus().error`),这里补的是**可排查性**。
  registry.onPersistError = (message) => {
    log(`[dsh-git] 存储写入失败(本次运行的数据只在内存里,重启会丢): ${message}`);
  };

  // ---------- 服务 ----------
  const auth = new GithubAuth({ registry, clientId: (config?.clientId ?? '').trim(), log });
  // 系统动作的目标路径限制在同一份 allowedRoots 内(与 git 服务一致)。
  const system = new SystemService(host, () => registry.allowedRoots());

  /*
   * Hooks 的环境注入(2026-10):偏好读宿主存储域,环境由**用户 shell** 捕获一次
   * (`host/hooks-env.ts`)。接在 runner 上而不是 GitService 上,是因为注入点就是
   * 「spawn 之前的 env 槽」—— 与凭据注入同一条缝,但凭据走调用方显式给的 `opts.env`
   * (`git-service.ts:242`),**显式项赢**(见 `git-runner.ts` 的 `mergeSpawnEnv`)。
   *
   * 惰性读 `host.subprocess`:apply 时服务可能还没挂上,而 provider 每次 spawn 前
   * 才解析(与 `subprocessRunner` 内部 `service()` 的写法一致)。
   */
  const hooksEnv = createHooksEnvProvider({
    service: () => (host as { subprocess?: unknown }).subprocess as SubprocessLike | undefined,
    prefs: () => registry.prefHooksEnv(),
    log,
  });

  const git = new GitService(
    subprocessRunner(host as { subprocess?: unknown }, process.platform, hooksEnv),
    {
      allowedRoots: () => registry.allowedRoots(),
      credentialEnv: () => auth.credentialEnv(),
      /*
       * 与路由层共用**同一个**日志器(`:548` 的 `log` ⇒ `host.logger?.warn`)。
       * 唯一用途:配置里 `pull.rebase` 是个不可识别的值时,照上游
       * `lib/stores/git-store.ts:464` 记一条警告(见 `GitService.warn`)。
       * 不接它不会坏功能,但那条警告会静默消失。
       */
      log,
    },
  );

  // llm 是可选的:懒等待,缺它时生成功能返回可读错误而不是崩。
  const llmHolder: { service?: LlmServiceLike } = {};
  const generator = new CommitMessageGenerator({
    llm: () => llmHolder.service,
    registry,
    defaultModel: () => pinnedModel(registry),
  });
  let llmInjection: { dispose?: () => void } | undefined;
  if (typeof host.inject === 'function') {
    try {
      llmInjection = host.inject(['llm'], (injected) => {
        const service = injected.get('llm') as LlmServiceLike | undefined;
        if (service !== undefined) llmHolder.service = service;
      });
    } catch (error) {
      log(`[dsh-git] llm 服务等待失败,提交信息生成不可用: ${messageOf(error)}`);
    }
  }

  for (const problem of selfCheck()) {
    log(`[dsh-git] 自检问题: ${problem}`);
  }

  // ---------- 目录选择(宿主能力,拿不到就返回 null) ----------
  /** 宿主是否真的提供了目录选择服务(apply 时探一次)。 */
  const hasHostPicker = (): boolean => {
    try {
      const candidate = host.get?.('directoryPickerController') as { pick?: unknown } | undefined;
      return candidate !== undefined && typeof candidate.pick === 'function';
    } catch {
      return false;
    }
  };

  const pickDirectory = async (): Promise<string | null> => {
    // 注意:directoryPickerController **不在** inject 里(并非所有 profile 都有),
    // 直接读 ctx.directoryPickerController 会被 cordis 拒绝:
    //   `cannot get property "directoryPickerController" without inject`
    // 这正是「点击 + 添加 没反应」的原因。可选服务必须走 ctx.get()。
    let picker: { pick(signal: AbortSignal): Promise<string | null> } | undefined;
    try {
      picker = host.get?.('directoryPickerController') as typeof picker;
    } catch (error) {
      log(`[dsh-git] 读取 directoryPickerController 失败: ${messageOf(error)}`);
      return null;
    }
    if (picker === undefined || typeof picker.pick !== 'function') {
      log('[dsh-git] 宿主未提供目录选择服务,请在界面上手动输入仓库路径。');
      return null;
    }
    try {
      return (await picker.pick(new AbortController().signal)) ?? null;
    } catch (error) {
      log(`[dsh-git] 目录选择失败: ${messageOf(error)}`);
      return null;
    }
  };

  /**
   * 当前会话所在的工作区路径(宿主 workspaceRegistry)。
   * 用于把「正在编辑的项目」自动登记进仓库清单并选中它。
   * @param sessionId - 当前会话 id;空串表示按「最近使用」取。
   */
  const currentWorkspace = async (sessionId: string): Promise<string | null> => {
    let workspaces: {
      list(): readonly { path: string; updatedAt: string; sessionIds: readonly string[] }[];
    } | undefined;
    try {
      workspaces = host.get?.('workspaceRegistry') as typeof workspaces;
    } catch (error) {
      log(`[dsh-git] 读取 workspaceRegistry 失败: ${messageOf(error)}`);
      return null;
    }
    if (workspaces === undefined || typeof workspaces.list !== 'function') return null;
    try {
      const all = workspaces.list();
      if (all.length === 0) return null;
      const mine = sessionId === '' ? undefined : all.find((w) => w.sessionIds.includes(sessionId));
      if (mine !== undefined) return mine.path;
      return [...all].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0].path;
    } catch (error) {
      log(`[dsh-git] 读取工作区列表失败: ${messageOf(error)}`);
      return null;
    }
  };

  // ---------- 生命周期 ----------
  // 资源在 ctx.effect 里登记(cordis 卸载时会调用),同时把同一个 teardown
  // 作为 apply 的返回值交出去 —— 两条路都能清理,测试也能直接驱动它。
  let disposed = false;
  const disposers: (() => void)[] = [];

  // ---------- 令牌的存放位置:宿主凭据缝 ----------
  //
  // 令牌走宿主的凭据缝:`ctx.credentials` + 引用名 `GITHUB_TOKEN`
  // (`host/credential-bridge.ts` 有完整说明)。插件的 storage domain 里没有它。
  //
  // ⚠️ **这不是钥匙串加密**,不许对外这么讲:宿主的本地凭据域就是一份 0600 的
  // **明文 YAML**,它自述「an OS-keychain provider is deferred」
  // (`packages/credentials/credentials-local/README.md:199`)。
  //
  // 注入是 **fail-soft** 的:凭据服务缺席(profile 没挂
  // `@deepseek-ai/dsh-credentials-local`)时 `ctx.inject` 的回调**永远不跑**,
  // 令牌只留在进程内存里(本次运行可用,重启后需要重新登录)—— 严格策略:
  // 本插件不自己持久化明文令牌。**绝不能**把 `credentials` 写进模块顶部的硬
  // `inject` 数组 —— 那个数组里少任何一个服务整个插件都不加载,本仓库已经为此
  // 付出过代价。
  const tokenBridge: { service: CredentialService | null; started: boolean } = { service: null, started: false };

  /**
   * 接线令牌的存放位置(只跑一次;需要凭据服务可用)。
   *
   *  1. 建桥(初始缓存为空,`bootstrap()` 之后才有值);
   *  2. 安装到 registry;
   *  3. `bootstrap()`:取凭据服务里的值;
   *  4. 挂上热发布监听:外部改了 `.credentials.yaml` 之后不用重启。
   */
  const startTokenHome = async (): Promise<void> => {
    const service = tokenBridge.service;
    if (service === null || tokenBridge.started) {
      return;
    }
    tokenBridge.started = true;
    const home: TokenHome = createCredentialBridge({ service, log });
    registry.useTokenHome(home);
    await home.bootstrap();
    if (disposed) {
      return;
    }
    // 令牌**来源层**的唯一一行日志,刻意放在 `bootstrap()` **之后**:放在激活那行
    // (它先于本函数执行)只会报出「还没接上」的状态。**永不打印值**。
    const settled = home.source();
    log(`[dsh-git] GitHub 令牌来源 ${settled}(引用 ${GITHUB_TOKEN_REF})`
      + (settled === 'memory' ? ' —— 只在本次运行的内存里,重启后需要重新登录' : ''));
    ctx.effect(() => {
      const off = host.on?.('credentials/reference-updated', (ref) => {
        if (ref === GITHUB_TOKEN_REF) {
          void home.refresh();
        }
      });
      return () => { off?.(); };
    }, 'dsh-git: github token refresh');
  };

  let credentialInjection: { dispose?: () => void } | undefined;
  if (typeof host.inject === 'function') {
    try {
      credentialInjection = host.inject(['credentials'], (injected) => {
        const service = injected.get('credentials') as CredentialService | undefined;
        if (service === undefined || typeof service.resolve !== 'function') {
          log(`[dsh-git] 宿主声明了 credentials 但没有可用的凭据服务(引用 ${GITHUB_TOKEN_REF}),`
            + 'GitHub 令牌只在内存里(重启后需要重新登录)。');
          return;
        }
        tokenBridge.service = service;
        void startTokenHome().catch((error) => {
          log(`[dsh-git] 凭据服务接线失败(GitHub 令牌只在内存里,重启后需要重新登录): ${messageOf(error)}`);
        });
      });
    } catch (error) {
      log(`[dsh-git] credentials 服务等待失败,GitHub 令牌留在插件 storage(明文): ${messageOf(error)}`);
    }
  } else {
    log('[dsh-git] 宿主没有 ctx.inject,GitHub 令牌留在插件 storage(明文)。');
  }

  ctx.effect(() => {
    void (async () => {
      if (host.storageDomain !== undefined) {
        try {
          const opened = await host.storageDomain.open(DOMAIN_SPEC);
          if (disposed) {
            await opened.close?.();
            return;
          }
          domainHolder.domain = opened;
          // 把 domain 挂到**同一个** registry 上并装载已存状态。
          // (曾经改用「另一个实例 + adopt(state)」,结果 domain 没搬过去,
          //  persist() 静默空转,清单与令牌重启即丢。)
          await registry.useDomain(opened);
        } catch (error) {
          log(`[dsh-git] storage domain 打开失败,本次运行只在内存里(重启会丢清单): ${messageOf(error)}`);
        }
      }
      await registry.whenReady();
      if (disposed) return;

      // 凭据服务接线。**刻意不 await**:`bootstrap()` 要读凭据文件、可能还要等
      // 跨进程写锁(宿主给的是 30 秒的上限,见 `credentials-local/src/index.ts:112`),
      // 而路由必须尽快挂上。这段时间 `githubToken()` 读到的是空(还没接上),接上
      // 之后由 `bootstrap()` 补齐 —— 令牌不在别处,没有第二个来源可读。
      void startTokenHome().catch((error) => {
        log(`[dsh-git] 凭据服务接线失败(GitHub 令牌只在内存里,重启后需要重新登录): ${messageOf(error)}`);
      });

      const webServer = host.webServer;
      if (webServer === undefined || typeof webServer.register !== 'function') {
        log('[dsh-git] webServer 不可用,/dsh-git 路由未注册。');
        return;
      }
      disposers.push(webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: createGitHandler({
          git, registry, llm: generator, auth,
          // 只有宿主真的拿得到选择服务时才把 pickDirectory 交给路由 ——
          // 否则 health/repos 会谎报 canPickDirectory:true,界面就会把按钮渲染成可用。
          ...(hasHostPicker() ? { pickDirectory } : {}),
          system, currentWorkspace, buildStamp: BUILD_STAMP, log,
        }) as unknown as (req: unknown, res: unknown) => void,
      }));
      const storage = registry.storageStatus();
      // 带上构建时间戳(UTC):排查时一眼看出运行中的是不是最新产物 —— 上一轮就是
      // 因为旧实例的注册行没有任何版本信息,白费了很多时间。
      // `自动刷新`/`clientId` 两项是**声明了 Config 之后**才有的可读回证据:
      // 它们证明 schema 真的被 `resolveConfig()` 求值过(默认值也生效),而不是只被导出。
      //
      // ⚠️ **这一行刻意不报令牌来源**:它先于 `startTokenHome()` 完成,那时还没有值
      // 可报。来源由 `startTokenHome()` 在 `bootstrap()` **之后**单独记一行。
      log(`[dsh-git] 已注册 ${ROUTE_PREFIX}/* (build ${BUILD_STAMP} UTC;本地仓库 ${registry.list().length} 个,`
        + `存储 ${storage.persistent ? '持久化' : '仅内存'}${storage.error === null ? '' : `,存储错误: ${storage.error}`};`
        + `Pulls 自动刷新 ${config?.autoSec.get() ?? 0} 秒;clientId ${(config?.clientId ?? '') === '' ? '未配置(仅 PAT 可用)' : '已配置'})`);
      if (tokenBridge.service === null) {
        // 这里 `service` 仍为 null 通常只是**时序**:路由不等凭据接线,而 `ctx.inject`
        // 的回调要到稍后才跑 —— 实测同一秒内:`已注册` → 这一行 → `令牌来源
        // credentials-file`,相隔约 4ms。所以这一行**不能**写成终局判断,只报「暂时」;
        // 真正的结算行是 `startTokenHome()` 在 `bootstrap()` 之后记的那一条。
        log(`[dsh-git] 还没接上 credentials 服务(引用 ${GITHUB_TOKEN_REF}):令牌暂时只在`
          + '内存里;接上之后会自动切过去,届时再记一行来源。');
      }
    })();
  }, 'dsh-git: storage + routes');

  return () => {
    disposed = true;
    for (const dispose of disposers.reverse()) {
      try { dispose(); } catch { /* 已清理 */ }
    }
    disposers.length = 0;
    llmInjection?.dispose?.();
    credentialInjection?.dispose?.();
    const domain = domainHolder.domain;
    if (domain !== null) {
      void domain.close?.().catch(() => undefined);
      domainHolder.domain = null;
    }
  };
}

/** 设置里钉住的模型 `provider/model`。 */
function pinnedModel(registry: RepoRegistry): LlmModelChoice | undefined {
  const pinned = registry.prefModel();
  const idx = pinned.indexOf('/');
  if (idx <= 0 || idx === pinned.length - 1) return undefined;
  return { provider: pinned.slice(0, idx), model: pinned.slice(idx + 1) };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
