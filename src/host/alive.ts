/**
 * **长连接的宿主生命周期** —— 把上游 `AliveStore`(`src/host/mirror/lib/stores/alive-store.ts`,
 * 268 行,**逐字**)真的跑起来,并把它的事件交出去。
 *
 * ## 数据面的位置(一句话)
 *
 * 生产者的**唯一**所有者是宿主:`AliveStore.setEnabled(true)` ⇒ `AliveSession`
 * (真 `@github/alive-client` 1.2.0)用**真 WebSocket** 连上服务端;事件经
 * `onAliveEventReceived` 到 {@link AliveService.onEvent}。**上游一行传输层代码都没重写。**
 *
 * ## 这一层负责什么、不负责什么
 *
 * | 归上游(逐字/真依赖) | 归本文件 |
 * |---|---|
 * | `AliveSession` 的握手、`subscribe`/`unsubscribe` 帧、ack 的 offset、重连退避、presence(`@github/alive-client` 289 行) | **生命周期**:随插件激活启动、随 dispose 停止(`%start` / `%stop`) |
 * | `AliveStore` 的端点/账号/频道编排、`setEnabled` 语义、按 endpoint 建 session、事件类型白名单(268 行) | **参数与天气**:端点/令牌/票据从哪来(`GithubAuth`)、`self`/`location` 的宿主替身、事件环形缓冲 |
 * | `lib/api.ts:865/885` 那两个端点的**语义**(404 ⇒ 关掉) | 那两次请求经 `GithubAuth.ghProxy`(令牌不出宿主) |
 *
 * ## `self` / `location` 为什么要在**进入 store 之前**垫
 *
 * `@github/stable-socket` 与 `AliveSession` 是**浏览器**代码:`AliveSession.getUrlWithPresenceId()`
 * 读 `self.location.origin`,stable-socket 全程用 `self.setTimeout` / `self.clearTimeout`,
 * `AliveSession.shutdown()` 用 `self.close()`。宿主进程里 `self` **不存在**
 * ⇒ 构造 `AliveSession` 的**那一行**就 `ReferenceError`(实测见 `docs/alive-connection-port.md`)。
 *
 * `esbuild` 的 `inject` **不改进程全局**、`globalThis.self = …` 会改(宿主是 DSH 进程里的插件,
 * 往进程写通用名会与 DSH 或别的插件撞)⇒ 本模块在**模块作用域**里声明 `self`:
 * 镜像与 alive-client 都被打进 `lib/index.js` 的**同一个模块作用域**,
 * 自由标识符 `self` 因此解析到这里,进程全局**一个字节都不动**。
 *
 * ## 诚实边界
 *
 * 1. **`maxReconnectBackoff` 用上游默认值 600000ms**(`AliveSession` 构造参数,上游
 *    `alive-store.ts:180-185` 不传)。要缩短只能改镜像那一行 ⇒ 那时它就不再是逐字副本。
 * 2. **多账号不可达**:宿主凭据缝只有一个引用,见 `src/host/shims/alive-lib.ts` 文件头第 1 条。
 * 3. **`getUrlWithPresenceId()` 的偏移是零**:宿主只连**一个** endpoint 的一条 session。
 * 4. **事件缓冲有上限**:{@link MAX_BUFFERED_EVENTS} 条,超出丢**最旧**的
 *    (与上游不同:上游直接弹 OS 通知,没有队列)。
 *
 * @module dsh-git/host/alive
 */

import { AliveStore, type DesktopAliveEvent } from './mirror/lib/stores/alive-store.ts';
import {
  configureAliveAPI,
  createAliveAccounts,
  createAliveAPI,
  type AliveEndpointProvider,
  type AliveProxy,
  type AliveTokenProvider,
} from './shims/alive-lib.ts';
/*
 * ---------------------------------------------------------------------------
 * `self` 必须在**进入 alive-client 之前**存在(实测两次教训,别退回)
 *
 * 1. **不能**在这里写 `const self = {…}`:esbuild 会把本模块的 `self` 改名
 *    (`var self2 = {…}`),而 `@github/alive-client` 里那句 `self.location.origin`
 *    仍是**自由的 `self`** ⇒ 打包之后它解析到进程全局(没有就是
 *    `ReferenceError: self is not defined`,探针环境实测)。
 * 2. **不能**交给 esbuild 的 `inject`(宿主构建现在的做法):`inject` 要求被注入的
 *    名字在文件里是**自由标识符**,而本模块一旦声明 `self` 就变成已绑定 ⇒ 注入失效
 *    (`log` / `location` 能注入,正因为镜像里的它们是自由的)。
 *
 * ⇒ 唯一可靠的做法:**在模块加载时补进程全局的 `self`**(只补 alive-client 真正
 * 用的三样),然后**不复用这个名字**。`self.close()` 只在 `shutdown()` 里、且**仅在**
 * `inSharedWorker === true` 时被调用,我们恒传 `false`,所以不需要它。
 * 代价如实记账:这是本仓唯一一处写进程通用名,而它是长连接能跑起来的必要条件。
 * ---------------------------------------------------------------------------
 */

/** `AliveSession.getUrlWithPresenceId()` 需要 `origin`;`stable-socket` 需要两个定时器。 */
interface IAliveSelf {
  /** `@github/stable-socket` 的定时器(`timeout` / `wait` / `retry`)。 */
  setTimeout: (handler: (...args: unknown[]) => void, timeout?: number) => unknown;
  /** `@github/stable-socket` 的定时器。 */
  clearTimeout: (handle: unknown) => void;
  /** `AliveSession.getUrlWithPresenceId()` 的基址。 */
  location: { origin: string };
}

/** 本模块装上去的那个对象(消费方是**打包进来的** `@github/alive-client`)。 */
const aliveSelf: IAliveSelf = {
  setTimeout: (handler: (...args: unknown[]) => void, timeout?: number) => setTimeout(handler, timeout),
  clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  // 先给上游真实主机;`AliveService.start()` 拿到 WebSocket 地址后会改成**那个地址**的
  // origin(所以对照用的本地替身不会被写成 alive.github.com)。
  location: { origin: 'https://alive.github.com' },
};

/** 进程里的 `self`(可能不存在;读写一律走这个口)。 */
const globalScope = globalThis as unknown as { self?: IAliveSelf };

/*
 * 只在**没有** `self` 时补(浏览器里本来就有 ⇒ 不动;Node 25 实测没有 ⇒ 补上)。
 * `try/catch`:极少数环境里 `globalThis` 是冻结的,那时 alive 会以
 * 「`self` 未定义」的形式失败并记日志,而不是把整个插件拖崩。
 */
try {
  if (globalScope.self === undefined) {
    globalScope.self = aliveSelf;
  }
} catch {
  // 装不上就算了:`AliveService.start()` 那条路会失败并记一条日志(不静默)。
}

/** 事件缓冲的上限(超出丢最旧的,见文件头第 4 条)。 */
export const MAX_BUFFERED_EVENTS = 200;

/** 一条已收到的事件 + 它的游标。 */
export interface IBufferedAliveEvent {
  /** 单调递增的游标(客户端按它增量取,`since=0` 取全部)。 */
  readonly id: number;
  /** **逐字**的 `DesktopAliveEvent`(镜像的类型,不是第二份)。 */
  readonly event: DesktopAliveEvent;
  /** 宿主收到的时刻(ms;上游的事件体里也有 `timestamp`,那是服务端的)。 */
  readonly receivedAt: number;
}

/** `AliveService` 需要的全部外部依赖。 */
export interface IAliveServiceOptions {
  /** GitHub API 基址(实现是 `auth.endpoint()`)。 */
  endpoint: AliveEndpointProvider;
  /** 当前令牌(实现是 `registry.githubToken()`)。 */
  token: AliveTokenProvider;
  /** 当前登录名(实现是 `auth.state().login`;可为空)。 */
  login: AliveEndpointProvider;
  /** 带令牌的 REST 调用(实现是 `auth.ghProxy`)。 */
  proxy: AliveProxy;
  /** 一行日志(实现是 `src/index.ts` 的 `log`)。 */
  log(message: string): void;
}

/** 状态投影(路由 `alive/status` 的载荷)。 */
export interface IAliveStatus {
  /**
   * **真的有会话吗** —— 不是「我们要求订阅了」。
   *
   * 语义是**结果**:上游 `AliveStore` 里既有一条按 endpoint 建的 session
   * (`sessionPerEndpoint.size > 0`)、又有一条真的订阅帧
   * (`subscriptions.length > 0`)。404/403 那一档(`getAliveWebSocketURL()` 回
   * `null` ⇒ `createSessionForAccount` 在 `alive-store.ts:176-178` 直接返回)
   * 在这里恒 `false`。
   *
   * ⚠️ 它**不**表示「socket 此刻是打开的」:上游 `AliveSession` 自己重连
   * (`stable-socket` 的退避),而 `sessionPerEndpoint` 不会因为一次掉线被移除。
   * 这一点如实写在 `docs/alive-connection-port.md` §12 的诚实边界里。
   */
  readonly listening: boolean;
  /** 当前 endpoint(空串 = 没拿到)。 */
  readonly endpoint: string;
  /** 收到过多少条事件(**累计**,不受环形缓冲上限影响)。 */
  readonly received: number;
  /** 游标的最大值(客户端用它做 `since`)。 */
  readonly cursor: number;
  /** 最近一次失败原因(`null` = 没失败过)。 */
  readonly lastError: string | null;
}

/**
 * 长连接的生命周期所有者。**一个进程一个**(宿主半只有一个令牌引用)。
 *
 * 生命周期:`new`(只装配,不联网)⇒ {@link start}(联网 + 订阅)⇒ {@link stop}(退订 + 关 socket)。
 */
export class AliveService {
  private readonly store: AliveStore;
  private readonly options: IAliveServiceOptions;
  /**
   * **意图**:`start()` 已经要求订阅(`stop()` 撤销)。
   *
   * 只给 {@link start} / {@link stop} / {@link refresh} 做**幂等**判断。
   * ⚠️ **绝不要**把它投影成 {@link IAliveStatus.listening} ——
   * 「我们要求订阅了」不等于「连接建立了」;2026-10-08 修掉的正是这条
   * (`docs/alive-connection-port.md` §11.5 是它的读数,§12 是修法)。
   */
  private enabled = false;
  private readonly buffered: IBufferedAliveEvent[] = [];
  private cursor = 0;
  private receivedTotal = 0;
  private lastError: string | null = null;

  /**
   * @param options - 端点/令牌/登录名/代理/日志(见 {@link IAliveServiceOptions})。
   */
  public constructor(options: IAliveServiceOptions) {
    this.options = options;
    const accounts = createAliveAccounts({
      endpoint: options.endpoint,
      token: options.token,
      login: options.login,
    });
    /*
     * `AliveStore` 的构造参数在镜像里标的是 `AccountsStore`(那个 store 在宿主缺
     * `../auth`,见 `docs/host-mirror-adaptation.md` 的登记行)。这里传的是**同形**的
     * 最窄适配层(`shims/alive-lib.ts`):它只实现 `AliveStore` 真正引用的两个方法
     * (`getAll` / `onDidUpdate`)。运行期形状由
     * `docs/probes/alive-connection-probe.mjs` 的**真**握手钉住。
     */
    this.store = new AliveStore(accounts as never);
    this.store.onAliveEventReceived(this.onEvent);
  }

  /** 上游事件 ⇒ 环形缓冲 + 游标。**不做去重/过滤**:白名单在 `AliveStore.notify` 里(上游那一行)。 */
  private readonly onEvent = (event: DesktopAliveEvent): void => {
    this.receivedTotal += 1;
    this.cursor += 1;
    this.buffered.push({ id: this.cursor, event, receivedAt: Date.now() });
    while (this.buffered.length > MAX_BUFFERED_EVENTS) {
      this.buffered.shift();
    }
  };

  /**
   * 启动(幂等)。**这是「宿主半有生命周期」的那一行**:它调的是上游的
   * `AliveStore.setEnabled(true)`(`alive-store.ts:84`),由此产生 `subscribeToAllAccounts`
   * ⇒ `getAliveWebSocketURL` ⇒ `new AliveSession` ⇒ 真 WebSocket。
   */
  public start(): void {
    if (this.enabled) {
      return;
    }
    this.enabled = true;
    /*
     * ★ **注入 REST 面**。镜像的 `AliveStore.createSessionForAccount`(`alive-store.ts:166`)
     * 直接写 `API.fromAccount(...)` —— 那是**模块级值绑定**,不是构造参数,
     * 所以只能在这一刻把它接到本进程的代理上(令牌/端点都在
     * {@link IAliveServiceOptions} 里,模块顶层拿不到)。
     */
    configureAliveAPI(createAliveAPI(this.options.proxy));
    void this.probeOrigin();
    this.store.setEnabled(true);
    this.options.log('[dsh-git] alive 长连接已启动(订阅上游 AliveStore)');
  }

  /**
   * 停止(幂等)。调上游的 `setEnabled(false)`:`unsubscribeFromAllAccounts`
   * ⇒ 每个订阅 `session.unsubscribe([...])` + `session.offline()`(`alive-store.ts:84-96, 197-220`)。
   */
  public stop(): void {
    if (!this.enabled) {
      return;
    }
    this.enabled = false;
    this.store.setEnabled(false);
    this.options.log('[dsh-git] alive 长连接已停止');
  }

  /**
   * 拿一次 WebSocket 地址,把 {@link self}`.location.origin` 对齐到它。
   *
   * 为什么必须对齐:`AliveSession.getUrlWithPresenceId()` 用 `new URL(this.url, origin)` 拼
   * `?shared=false&p=<presenceId>.<connectionCount>`,origin 与 url **不同源**时
   * 那个查询串就加不到真地址上(上游在浏览器里有真的 `self.location`,所以它不需要这一步)。
   *
   * **失败不抛**:这里只影响 presenceId 查询串;真正的连接由 `AliveStore` 那条路负责,
   * 它自己的失败会在 store 的 `catch` 里记日志(见 `alive-store.ts:169-178`)。
   */
  private async probeOrigin(): Promise<void> {
    try {
      const api = createAliveAPI(this.options.proxy);
      const account = (await createAliveAccounts({
        endpoint: this.options.endpoint,
        token: this.options.token,
        login: this.options.login,
      }).getAll())[0];
      if (account === undefined) {
        this.lastError = '未登录(宿主凭据缝里没有 GitHub 令牌)';
        this.options.log(`[dsh-git] ${this.lastError},alive 长连接不可用。`);
        return;
      }
      const url = await api.fromAccount(account).getAliveWebSocketURL();
      if (url === null) {
        this.lastError = 'GitHub 没有给这个端点开通 Alive(websocket-url 回 404)';
        this.options.log(`[dsh-git] ${this.lastError},长连接不建立(不重试,数据面维持轮询)。`);
        return;
      }
      const origin = originOf(url);
      if (origin !== null) {
        aliveSelf.location.origin = origin;
      }
      this.lastError = null;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.options.log(`[dsh-git] 读取 Alive WebSocket 地址失败:${this.lastError}`);
    }
  }

  /**
   * 取 `since` 之后的事件(增量)。
   *
   * @param since - 上一次拿到的游标(`0` = 从头)。
   * @returns 事件与**下一次**要用的游标。
   */
  public eventsSince(since: number): { events: IBufferedAliveEvent[]; cursor: number } {
    const from = Number.isFinite(since) && since > 0 ? since : 0;
    return {
      events: this.buffered.filter((entry) => entry.id > from),
      cursor: this.cursor,
    };
  }

  /**
   * 上游 `AliveStore` 里**真的有**一条 session 与一条订阅吗。
   *
   * 为什么按**运行期形状**读它的两个私有字段:那一份 `alive-store.ts` 是**逐字**
   * 副本(`verify-mirror` 判字节一致,`570` 一致里的一条)⇒ 不能给它加 getter;
   * 而这两个字段就是**结果**本身:
   *
   * - `sessionPerEndpoint` 只在 `createSessionForAccount` **拿到非 `null` 的 WS 地址
   *   之后**才写(`alive-store.ts:187-192`),404 那一档在 `:176-178` 就返回了;
   * - `subscriptions` 只在真的调过 `session.subscribe([...])` 之后才 push
   *   (`alive-store.ts:244-249`),`unsubscribeFromAccount` 会把它与 session 一起删。
   *
   * 两件都要真:`sessionPerEndpoint` 里那条 session 是**构造出来**的(地址已签),
   * 而订阅帧是**发出去**的那一步 —— 只看其中一个都会把「地址拿到了」或
   * 「对象建了但没订阅」报成「连接建立了」。
   *
   * @returns `true` = 会话与订阅都在(客户端据此停轮询)。
   */
  private hasSession(): boolean {
    const store = this.store as unknown as {
      readonly sessionPerEndpoint?: { readonly size: number };
      readonly subscriptions?: readonly unknown[];
    };
    const sessions = store.sessionPerEndpoint;
    const subscriptions = store.subscriptions;
    return sessions !== undefined && sessions.size > 0
      && subscriptions !== undefined && subscriptions.length > 0;
  }

  /** 状态投影。@returns {@link IAliveStatus}。 */
  public status(): IAliveStatus {
    return {
      listening: this.hasSession(),
      endpoint: this.options.endpoint(),
      received: this.receivedTotal,
      cursor: this.cursor,
      lastError: this.lastError,
    };
  }

  /**
   * 令牌换值(或拿到登录名)之后重启 session。
   *
   * 为什么是**重启**而不是热更新:`AliveStore.createSessionForAccount` 建 session 时才会
   * 调 `api.getAliveWebSocketURL()`,而那个地址是**按令牌签发的**;`getAll()` 每次现造
   * `Account` 只能改 `Account.token`,不改已经连上的那条 socket。上游的做法是
   * `accountsStore.onDidUpdate` ⇒ `subscribeToAccounts`,而宿主没有那个通知面
   * ⇒ 这里用**同一个**上游入口(`setEnabled`)显式重启。
   */
  public refresh(): void {
    if (!this.enabled) {
      return;
    }
    this.store.setEnabled(false);
    this.store.setEnabled(true);
  }
}

/**
 * 从 WebSocket 地址里取 `origin`。
 *
 * @param url - `wss://alive.github.com/u/12/ws` 或对照用的 `ws://127.0.0.1:PORT/u/1/ws`。
 * @returns origin(如 `https://alive.github.com`);解析不了 ⇒ `null`。
 */
function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol === 'wss:' ? 'https:' : 'http:'}//${parsed.host}`;
  } catch {
    return null;
  }
}
