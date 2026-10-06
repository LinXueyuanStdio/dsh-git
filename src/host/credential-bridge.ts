/**
 * GitHub 令牌的存放位置:DSH 宿主的凭据缝(`ctx.credentials`)。
 *
 * 令牌只存在于 `$DSH_HOME/.credentials.yaml` 的引用 `refs.GITHUB_TOKEN` 上,
 * **不在**插件自己的通用状态域(`~/.dsh/storages/dsh_git.json`)里 —— 那份文档
 * 装着仓库清单、界面偏好与 90 KB 的远程仓库缓存,任何一次整域读 / 写 / 导出 /
 * 备份都会把同文件里的东西一起带走,所以令牌不进去。
 *
 * ## ⚠️ 它不是钥匙串,别把它说成钥匙串
 *
 * 宿主自述「an OS-keychain provider is deferred」
 * (`references/deepseek-harness/packages/credentials/credentials-local/README.md:199`),
 * 实测 `packages/credentials/credentials-local/src/index.ts` 就是一份**明文 YAML**:
 * 保护手段是 `writeFileAtomic(…, { mode: 0o600 })`(`:691`、`:758`)
 * 加上读取前的 `assertOwnerOnly()`(`:127`,POSIX 上拒绝任何 group/other 位),
 * 没有 `safeStorage`/`keytar`(全仓 grep 为 0)。同一份 README 也明说
 * 「A same-UID process can read the document」。
 *
 * 这个位置给出的是四件事,**没有**「加密」:
 *  1. 值不进插件的通用状态域 —— 「为了读缓存而整域读/写/导出/备份」带不走它;
 *  2. 官方缝 —— 宿主自己管理文件权限、跨进程写锁与热发布;
 *  3. 值不进配置/界面 —— 配置里只出现引用名,`describe()` 的返回类型
 *     根本没有能装值的槽位,界面因此**不可能**误显示它;
 *  4. `GITHUB_TOKEN=… dsh` 只读覆盖 + 热发布 —— 换令牌不用改我们的代码,
 *     外部编辑 `.credentials.yaml` 也无需重启。
 *
 * ## 凭据服务缺席时:令牌只在内存
 *
 * profile 没挂 `@deepseek-ai/dsh-credentials-local`、或写入失败时,令牌**不会**
 * 被复制到别处:只更新内存缓存,并记一条不含值的诊断。代价是那个 profile
 * **重启后需要重新登录**;换来的是本插件在任何情况下都不自己持久化明文令牌。
 * (那种 profile 里 `RepoRegistry.tokenHome` 是 `null`,内存副本由它自己兜。)
 *
 * ## 读这份代码之前必须知道的另外两件事
 *
 * ### (1) 若将来把令牌从**引用**翻成**记录**,只有这一个文件要改
 *
 * 现在的键是 `CredentialRef`(`refs.GITHUB_TOKEN`,引用层)。若采用
 * `ctx.authorization`(Job B 的方向),令牌会变成 `CredentialKey` 记录
 * `records.dsh-git/github` —— **因为 `authorization` 靠监听
 * `credentials/record-updated` 确认 commit,再接 `describeRecord` 复核
 * (`packages/credentials/authorization/src/index.ts:386`、`:435`,
 * 未提交就抛 `NOT_COMMITTED`),所以它**只接受记录写入,不接受引用写入**。
 * 代价是**丢掉 `GITHUB_TOKEN=… dsh` 的环境分层**:记录层设计上不能分层
 * (「Nothing can layer here」,`credentials/src/index.ts:166-168`)。
 * 本插件的令牌读写**全部**经过本文件:翻成记录只需要改这里的
 * `resolve/set/unset` 三处 → `readRecord/modifyRecord/deleteRecord`,
 * 外加 `RepoRegistry` 与 `src/index.ts` 各一行接线;**别处没有第二个写者**。
 *
 * ### (2) 读的 vendored 源码与运行时安装的版本不逐字相同
 *
 * 本文件引用的行号来自 `references/deepseek-harness` 的 checkout,而运行的
 * DSH Desktop 2.0.17 装的是 `@deepseek-ai/dsh-credentials-local@0.2.0-rc.2` 与
 * `@deepseek-ai/dsh-authorization@0.2.0-rc.2`。已实测到一处差异:运行版的
 * `credentials/reference-updated` 文档多写了一条「`INVARIANT` 码的失败在全部监听器
 * 跑完后重抛(且只从同步监听器重抛)」。**本文件的监听器永不抛错、只调 `resolve`**,
 * 所以两种语义下都安全 —— 改这里时请保持「监听器不抛错」这条不变量。
 *
 * 全文件不变量:**日志与状态只出现引用名、来源层、计数与错误文本,永不出现令牌值**。
 * @module dsh-git/host/credential-bridge
 */

/**
 * 本插件存放 GitHub 令牌的**凭据引用名**(`CredentialRef`)。
 *
 * 用引用层(`CredentialRef`,文法 `/^[A-Za-z_][A-Za-z0-9_]*$/`)而不是记录层
 * (`CredentialKey`,文法 `<scope>/<id>`,见 `credentials/src/index.ts:69`),
 * 因为 GitHub 令牌就是一个不可拆的字符串,而引用层给出的三件事恰好是我们缺的:
 *  - 启动环境**只读优先**(`:609` 的 `resolve` 先看继承环境,`:774` 的
 *    `assertUnshadowed` 拒绝被遮住的写),这正是 git 生态对 `GH_TOKEN` /
 *    `GITHUB_TOKEN` 的既有约定;
 *  - `describe()` 只回 `{configured, source, writable}`(`:67`),**没有装值的槽位**;
 *  - `set` / `unset`(`:201`、`:209`)一对,正好是登录 / 登出。
 *
 * 记录层(`dsh-git/github` + `GrantRecord`)也能表达设备码流程的产物,但它存在的
 * 理由是「多字段 payload + 读-改-写轮换」(刷新令牌、AWS profile 环境值,
 * 见 `credentials/src/index.ts:166-168`),而 GitHub 设备码流程**不发刷新令牌**,
 * 我们两样都不需要,引入它只会多一份没有消费者的格式约定。
 */
export const GITHUB_TOKEN_REF = 'GITHUB_TOKEN';

/** `resolve()` 的返回切片(`credentials/src/index.ts:118` 的 `ResolvedCredential`)。 */
export type ResolvedCredential = {
  value: string;
  source: string;
};

/** `describe()` 的返回切片(`credentials/src/index.ts:67` 的 `CredentialInfo`)。 */
export type CredentialInfo = {
  configured: boolean;
  source?: string;
  writable: boolean;
};

/**
 * `ctx.credentials` 里本插件消费到的那一小片。
 *
 * 用**结构化切片**而不是 `import type { CredentialProvider }`:`@deepseek-ai/dsh-credentials`
 * 不在本插件的 `node_modules` 里(只有 `cosmokit` 与 `schemastery`),一条静态
 * import 解析失败就会让整个 host 插件加载失败 —— `src/index.ts:190` 的
 * `selfCheck()` 注释记的就是同一条教训(`dsh-storage-domain` 因此刻意不 import)。
 * 品牌类型(`CredentialRef`/`CredentialKey`)只在编译期存在,运行期就是字符串,
 * 所以传裸串与传品牌串是同一件事。
 */
export type CredentialService = {
  resolve(ref: string): Promise<ResolvedCredential | undefined>;
  describe(ref: string): Promise<CredentialInfo>;
  set(ref: string, value: string): Promise<void>;
  unset(ref: string): Promise<void>;
};

/** 令牌当前来自哪一层(只用于界面与日志,**永不**携带值)。 */
export type TokenSource =
  /** 启动环境(`GITHUB_TOKEN=… dsh`),只读且优先。 */
  | 'env'
  /** 宿主凭据域(`$DSH_HOME/.credentials.yaml`)。 */
  | 'credentials-file'
  /** 启动目录或 harness home 的 `.env`。 */
  | 'dotenv'
  /** 只在本次运行的进程内存里(凭据服务缺席或写入失败),重启后需要重新登录。 */
  | 'memory'
  /** 没有令牌。 */
  | 'none';

/**
 * 令牌的读/写/来源面。`RepoRegistry` 装上它之后,
 * `githubToken()` / `setGithubToken()` 都走凭据服务,不碰 storage。
 */
export type TokenHome = {
  /** 当前令牌,同步读(内存缓存)。 */
  read(): string;
  /**
   * 写令牌;`''` = 登出。
   *
   * **约定:不抛错。** 写入失败时只保留内存缓存并记一条不含值的日志 ——
   * 令牌不会因为一次写失败而消失,但也不会被复制到任何明文位置。
   */
  write(token: string): Promise<void>;
  /** 首次装载:取凭据服务里的值。 */
  bootstrap(): Promise<void>;
  /** 凭据服务里的值变了(外部编辑 `.credentials.yaml`)之后重取一次。 */
  refresh(): Promise<void>;
  /** 令牌当前来自哪一层。 */
  source(): TokenSource;
};

/** {@link createCredentialBridge} 的依赖。 */
export type CredentialBridgeOptions = {
  service: CredentialService;
  /** value-free 的日志出口。 */
  log(message: string): void;
};

/** `credentials-local` 的 `resolve().source` → 我们对外报的来源层。 */
function sourceOf(providerSource: string): TokenSource {
  if (providerSource === 'env') {
    return 'env';
  }
  if (providerSource === 'project-env' || providerSource === 'user-env') {
    return 'dotenv';
  }
  // `credentials-local` 只产出 env / file / project-env / user-env 四种
  // (`credentials-local/src/index.ts:609`,`:121`);换了 provider 报出别的
  // 层名时,最接近事实的归处就是「凭据域」—— 它是这条缝上唯一可写的一层。
  return 'credentials-file';
}

/**
 * 建一个凭据桥。
 *
 * 初始缓存是空串:调用方紧接着就 `await bootstrap()`,在那之前的读数一律按
 * 「还没接上凭据服务」处理(`src/index.ts` 刻意不 await 接线,好让路由先挂上)。
 * @param options - 凭据服务与日志出口。
 * @returns 读/写/装载/刷新/来源五件事。
 */
export function createCredentialBridge(options: CredentialBridgeOptions): TokenHome {
  const ref = GITHUB_TOKEN_REF;
  /** 同步缓存:唯一被 `read()` 返回的东西。 */
  let current = '';
  let layer: TokenSource = 'none';
  let booted = false;
  /** 每种失败原因**只报一次**,否则一次网络抖动会让日志变成刷屏。 */
  const warned = new Set<string>();

  function warnOnce(reason: string, message: string): void {
    if (warned.has(reason)) {
      return;
    }
    warned.add(reason);
    options.log(message);
  }

  function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  /** `describe()` 只用于给失败路径分类;它自身失败时按「可写」处理。 */
  async function describeSafely(): Promise<CredentialInfo | undefined> {
    try {
      return await options.service.describe(ref);
    } catch {
      return undefined;
    }
  }

  async function readFromService(): Promise<ResolvedCredential | undefined> {
    try {
      return await options.service.resolve(ref);
    } catch (error) {
      warnOnce(
        'read',
        `[dsh-git] 读取宿主凭据服务失败(${ref}): ${messageOf(error)}`,
      );
      return undefined;
    }
  }

  async function bootstrap(): Promise<void> {
    if (booted) {
      return;
    }
    booted = true;
    const existing = await readFromService();
    if (existing === undefined) {
      current = '';
      layer = 'none';
      return;
    }
    current = existing.value;
    layer = sourceOf(existing.source);
  }

  async function refresh(): Promise<void> {
    const hit = await readFromService();
    if (hit !== undefined) {
      current = hit.value;
      layer = sourceOf(hit.source);
      return;
    }
    // 没拿到值有两种可能,必须分开处理:
    //  · 引用**确实不存在**(外部删了令牌 / 登出)⇒ 清空,如实报未登录;
    //  · 服务本身读不动(抖动)⇒ 保留内存缓存,别让一次失败把人踢下线。
    const info = await describeSafely();
    if (info !== undefined && !info.configured) {
      current = '';
      layer = 'none';
      return;
    }
    warnOnce(
      'refresh',
      `[dsh-git] 重新读取 ${ref} 未拿到值,保留本次运行已缓存的令牌,未改变登录状态。`,
    );
  }

  async function write(token: string): Promise<void> {
    if (token === '') {
      current = '';
      layer = 'none';
      // 登出的语义就是「别再留我的令牌」:清内存 + 移除引用。移除失败也不回滚,
      // 因为「不再持有」是用户明确表达的意图。
      try {
        await options.service.unset(ref);
      } catch (error) {
        warnOnce('unset', `[dsh-git] 从凭据服务移除 ${ref} 失败: ${messageOf(error)}`);
      }
      return;
    }
    try {
      await options.service.set(ref, token);
      current = token;
      layer = 'credentials-file';
      return;
    } catch (error) {
      const info = await describeSafely();
      current = token;
      if (info !== undefined && !info.writable) {
        // 引用被只读的启动环境遮住了。这时**不能**退回明文:写进去也读不出来
        // (环境层优先),只会白白把令牌复制进通用状态域。
        layer = info.source === undefined ? 'env' : sourceOf(info.source);
        warnOnce(
          'readonly',
          `[dsh-git] ${ref} 由启动环境提供(只读),本次登录的令牌无法落盘;`
          + `若要在下次启动后仍然有效,请取消 shell 里的 ${ref} 再登录。`,
        );
        return;
      }
      // 严格策略:不写任何明文副本,令牌只活在本次运行的进程内存里。
      layer = 'memory';
      warnOnce(
        'write',
        `[dsh-git] 写入凭据服务失败,令牌只在本次运行有效(重启后需要重新登录): ${messageOf(error)}`,
      );
    }
  }

  return {
    read: () => current,
    write,
    bootstrap,
    refresh,
    source: () => layer,
  };
}
