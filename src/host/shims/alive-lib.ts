/**
 * **宿主半的 alive 适配层** —— 让 `src/host/mirror/lib/stores/alive-store.ts`(**逐字**)
 * 能在宿主里编译并运行。
 *
 * ## 它替换掉的四个 import(逐条,都在同一个文件里)
 *
 * `alive-store.ts` 的四条相对 import 在宿主**没有落点**,而且都不是它的核心逻辑:
 *
 * | 逐字那一行 | 上游是什么 | 这一份是什么 |
 * |---|---|---|
 * | `import { AccountsStore } from './accounts-store'` | 271 行的账号 store | {@link IAliveAccounts} 的**最窄接口**(`getAll` / `onDidUpdate`),由 {@link createAliveAccounts} 供 |
 * | `import { Account, accountEquals } from '../../models/account'` | 账号模型 | **同一份** `Account`(本文件的 `Account` 即它)、`accountEquals` 由同一个模型模块导出(见 {@link accountEquals} 的 re-export) |
 * | `import { API } from '../api'` | 2,499 行 REST 客户端 | {@link createAliveAPI} —— 只做 alive 那**两个**端点,令牌走宿主凭据缝 |
 * | `import { supportsAliveSessions } from '../endpoint-capabilities'` | semver 端点能力表 | `endpoint === getDotComAPIEndpoint()`(逐字复刻那条约束的**结果**) |
 *
 * ## 为什么是这四个替身,而不是「照抄一个 alive 传输层」
 *
 * 长连接的**全部机制**——握手、`subscribe`/`unsubscribe` 帧、ack 的 offset、
 * 重连退避、presence——都在 `@github/alive-client` 的 `AliveSession`(289 行)与
 * 镜像的 `AliveStore`(268 行)里,**一个字节都没重写**。本文件只回答一个上游由
 * Electron/账号系统回答的问题:「**端点、订阅票据、令牌从哪来**」。
 *
 * ## 诚实边界(替身不复现什么)
 *
 * 1. **账号库**。上游 `AccountsStore` 支持**多账号**(每个 endpoint 一条 session、
 *    `onDidUpdate` 时增删订阅)。宿主的凭据缝只有**一个**引用(`GITHUB_TOKEN`,
 *    见 `src/host/credential-bridge.ts`),所以这里**恒为一个账号**(或零个)。
 *    `AliveStore` 的多账号分支(增删 + 按 endpoint 建 session)因此**不可达**。
 * 2. **`Account` 的其他字段**。宿主没有 `/user` 快照:`emails` 恒 `[]`、
 *    `avatarURL` 恒 `''`、`id` 恒 `0`、`login` 恒 `''`。它们只被用于
 *    `accountEquals`(endpoint + id)与日志,`AliveStore` 不读别的。
 * 3. **`endpoint-capabilities` 的版本表**。上游对 GHES 也走 semver 判断
 *    (`supportsAliveSessions = endpointSatisfies({dotcom:true})` ⇒ 只有 dotcom 为真,
 *    GHES 恒假)。这里直接比较端点,结果**逐字相同**。
 *
 * @module dsh-git/host/shims/alive-lib
 */

import { getDotComAPIEndpoint, getHTMLURL } from '../mirror/lib/api.ts';
import { Account, accountEquals } from '../mirror/models/account.ts';

export { Account, accountEquals, getDotComAPIEndpoint, getHTMLURL };
/**
 * `alive-store.ts` 里那一条 `import { API } from '../api'`。
 *
 * ⚠️ **它不是未使用的**:`AliveStore.createSessionForAccount`(`alive-store.ts:166`)
 * 真的写 `API.fromAccount(account)`(实测:给 `undefined` ⇒
 * `TypeError: Cannot read properties of undefined (reading 'fromAccount')`)。
 *
 * 而**不能**接成 `mirror/lib/api.ts` 的那一个:那一份的 `fromAccount` **抛错**
 * (宿主半刻意不实现 REST 客户端),实测错误是「宿主半不可用」。
 * 也**不能**在模块顶层直接调 {@link createAliveAPI} —— 令牌/代理是**运行期**注入的
 * (`AliveService` 的构造参数)。
 *
 * ⇒ 这里放一个**可配置的注入点**:{@link configureAliveAPI} 由 `AliveService.start()`
 * 填,`API.fromAccount` 转发给它。
 */
let aliveAPI: { fromAccount(account: Account): unknown } | null = null;

/**
 * 把 alive 的 REST 面注入给镜像的 `API`(由 `AliveService.start()` 调用)。
 *
 * @param next - `{ fromAccount }`(实现就是 {@link createAliveAPI})。
 */
export function configureAliveAPI(next: { fromAccount(account: Account): unknown }): void {
  aliveAPI = next;
}

/** 镜像里那个 `API` 值(`API.fromAccount` 转发给 {@link configureAliveAPI} 注入的实现)。 */
export const API: { fromAccount(account: Account): unknown } = {
  fromAccount: (account: Account): unknown => {
    if (aliveAPI === null) {
      throw new Error('dsh-git:alive 的 REST 面还没有注入(先调 `AliveService.start()`)');
    }
    return aliveAPI.fromAccount(account);
  },
};

/*
 * `../endpoint-capabilities` 的两个名字 —— **同一个实现**,从 `mirror/lib/api.ts` 转发。
 *
 * 为什么本文件要额外提供它们:`alive-store.ts` 的 `../endpoint-capabilities` 一条 import
 * 在 esbuild 里被按 importer 重定向到本文件(见 `scripts/build.mjs` 的 `aliveAliasPlugin`),
 * 而被重定向的那一条只取 `supportsAliveSessions`。多转这两个名字是为了让
 * 「走到同一条重定向」的调用方不至于拿到 undefined —— 它们是
 * `mirror/lib/api.ts` 自己逐字转发的那两个。
 */
export { isDotCom, isGHE, getEndpointVersion } from '../mirror/lib/api.ts';
/** `models/account.ts` 只把它当**类型**用(`import { …, IAPIEmail }`),运行期不取。 */
export type { IAPIEmail } from '../mirror/lib/api.ts';

/**
 * `alive-store.ts` 构造参数的类型名(`AccountsStore`)。
 *
 * **只是类型**:upstream 那一份是 271 行的真 store,而 `AliveStore` 对它的引用实测只有
 * `getAll()` 与 `onDidUpdate()` 两处(见 {@link IAliveAccounts})。运行期传进来的
 * 是 {@link createAliveAccounts} 的产物。
 */
export type AccountsStore = IAliveAccounts;

/** 上游 `endpoint-capabilities.supportsAliveSessions` 的**结果**(只有 dotcom 为真)。 */
export function supportsAliveSessions(endpoint: string): boolean {
  return endpoint === getDotComAPIEndpoint();
}

/** alive 那两个端点里的一个:签名频道。 */
export interface IAliveSignedChannel {
  /** 频道名(`AliveStore` 用它建 `Topic`)。 */
  readonly channel_name: string;
  /** 服务端签名的订阅票据(`subscribe` 帧的**键**)。 */
  readonly signed_channel: string;
}

/** 令牌来源 —— 宿主半**唯一**的取令牌口(实现是 `registry.githubToken()`)。 */
export type AliveTokenProvider = () => string;

/** API 基址(实现是 `auth.endpoint()`)。 */
export type AliveEndpointProvider = () => string;

/** 一次带令牌的 GitHub REST 调用(实现是 `auth.ghProxy`)。 */
export type AliveProxy = (input: {
  method?: string;
  path: string;
  body?: unknown;
  accept?: string;
}) => Promise<{ status: number; json: unknown }>;

/**
 * `AliveStore` 真正用到的账号面(**只有两个方法**)。
 *
 * `AliveStore` 里对 `accountsStore` 的引用实测只有 `:73`(`onDidUpdate`)与
 * `:104`(`getAll`)两处 —— 这正是本文件敢于用最窄接口顶替 271 行 store 的依据。
 */
export interface IAliveAccounts {
  /** 当前登录的账号(**零个或一个**,见文件头第 1 条)。 */
  getAll(): Promise<ReadonlyArray<Account>>;
  /** 账号变更通知。注意:宿主**今天不会**触发它(令牌换值时 `AliveStore` 由宿主自己重启)。 */
  onDidUpdate(callback: (accounts: ReadonlyArray<Account>) => void): void;
}

/**
 * 造一个「只有一个账号」的账号面。
 *
 * 注意 `Account` 是**每次调用现造**的:`AliveStore` 会把 `api` 闭包捕获进
 * `AliveSession`,而 `api` 读的是 {@link AliveTokenProvider} —— 所以令牌换值时
 * **不需要**重建账号对象(宿主仍然会重启 session,见 `alive.ts` 的 `setToken`)。
 *
 * @param options - 端点、令牌、登录名三个来源。
 * @returns 账号面(空令牌 ⇒ 返回**空列表**,让 `AliveStore` 什么都没有可订阅)。
 */
export function createAliveAccounts(options: {
  endpoint: AliveEndpointProvider;
  token: AliveTokenProvider;
  login: AliveEndpointProvider;
}): IAliveAccounts {
  return {
    getAll: async (): Promise<ReadonlyArray<Account>> => {
      const token = options.token();
      if (token === '') {
        return [];
      }
      return [new Account(options.login(), options.endpoint(), token, [], '', 0, '')];
    },
    onDidUpdate: (): void => {
      // 宿主只有一个令牌引用,没有「账号列表变了」这件事(见文件头第 1 条)。
    },
  };
}

/**
 * 从代理错误里读 HTTP 状态(`GithubApiError.status`)。
 *
 * 刻意**不用 `instanceof`**:`GithubApiError` 由 `src/host/auth.ts` 定义,
 * 而本文件是**类型面独立**的适配层(见 `tsconfig.host.json` 的 `paths` 注释)。
 * 结构判据 `typeof error.status === 'number'` 对两个类都成立。
 *
 * @param error - 捕获到的错误。
 * @returns 状态码;读不到 ⇒ `null`。
 */
function statusOf(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) {
    return null;
  }
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : null;
}

/**
 * `AliveStore` 用到的 `API` 面(**只有 `fromAccount` + 两个端点**)。
 *
 * 与 `mirror/lib/api.ts`(那份 `API` 是 `any` 且 `fromAccount` **抛错**)的关系:
 * 宿主半**没有** REST 客户端,但 alive 这件事**必须**发两个带令牌的请求
 * (`/alive_internal/websocket-url` 与 `/desktop_internal/alive-channel`)。
 * 这两个端点由 {@link AliveProxy} —— 也就是 `GithubAuth.ghProxy` —— 发出去,
 * **令牌一个字节都不出宿主**。
 *
 * 404 的语义照上游 `lib/api.ts:885-897` 的注释**逐字**:`getAliveWebSocketURL`
 * 回 `null`(Alive 在这个端点上被关掉了),而不是抛 —— 抛的话
 * `AliveSession.reconnect()` 的 `retry(…, Infinity, …)` 会**永远**退避重试。
 *
 * @param proxy - 一次带令牌的 REST 调用。
 * @returns `{ fromAccount }`。
 */
export function createAliveAPI(proxy: AliveProxy): {
  fromAccount(account: Account): {
    getAliveWebSocketURL(): Promise<string | null>;
    getAliveDesktopChannel(): Promise<IAliveSignedChannel | null>;
  };
} {
  return {
    fromAccount: (account: Account) => {
      // `AliveStore` 每次建 session 时都传当前账号;这里只用它的 `login` 记日志。
      void account;
      return {
        /** 上游 `lib/api.ts:885`。 */
        getAliveWebSocketURL: async (): Promise<string | null> => {
          try {
            const res = await proxy({
              method: 'GET',
              path: '/alive_internal/websocket-url',
              accept: 'application/vnd.github+json',
            });
            if (res.status === 404) {
              return null;
            }
            const url = (res.json as { url?: unknown } | null)?.url;
            return typeof url === 'string' ? url : null;
          } catch (error) {
            // 只有 404 是「Alive 关掉了」;其余交给 `AliveStore` 的 catch(它会记日志并放弃本次订阅)。
            if (statusOf(error) === 404) {
              return null;
            }
            throw error;
          }
        },
        /** 上游 `lib/api.ts:865`。 */
        getAliveDesktopChannel: async (): Promise<IAliveSignedChannel | null> => {
          try {
            const res = await proxy({
              method: 'GET',
              path: '/desktop_internal/alive-channel',
              accept: 'application/vnd.github+json',
            });
            const json = res.json as Partial<IAliveSignedChannel> | null;
            if (
              json === null ||
              typeof json.channel_name !== 'string' ||
              typeof json.signed_channel !== 'string'
            ) {
              return null;
            }
            return { channel_name: json.channel_name, signed_channel: json.signed_channel };
          } catch {
            return null;
          }
        },
      };
    },
  };
}
