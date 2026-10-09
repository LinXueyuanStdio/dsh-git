/**
 * Desktop 的**构建期全局**在**宿主半**的替身 —— 通过 `scripts/build.mjs` 宿主构建的
 * esbuild `inject` 接进来。
 *
 * ## 为什么是 `inject` 而不是 `define`
 *
 * `define` 只接受 JSON 字面量或单个标识符 ⇒ **平台判断必须是运行期**的
 * (产物是发布出去的 `lib/index.js`,构建机与运行机不一定是同一个平台)。
 * 这与客户端半的选择同因(见 `src/client/desktop-globals.ts` 的文件头)。
 *
 * ## 为什么必须垫(实测,不是预防性写法)
 *
 * 接线之后 `lib/index.js` 的模块图里出现了上游 `lib/feature-flag.ts`,它在
 * **模块顶层**就调用 `enableBetaFeatures()` → `__RELEASE_CHANNEL__ === 'beta'`。
 * 只补**类型声明**(`types/host-shims.d.ts`)挡不住运行期:
 *
 * ```
 * $ node --input-type=module -e "await import('./lib/index.js')"
 * ReferenceError: __RELEASE_CHANNEL__ is not defined
 *     at enableBetaFeatures (lib/index.js:32489:10)
 * ```
 *
 * ⇒ 「类型绿、加载即崩」正是本仓反复付学费的那一类。这份文件是它的运行期解。
 *
 * ## 逐条取值与理由
 *
 * | 名字 | 值 | 理由 |
 * |---|---|---|
 * | `__DEV__` | `false` | 我们发的是正式版;上游用它做重复 id 告警与开发菜单 |
 * | `__DARWIN__` / `__WIN32__` / `__LINUX__` | `process.platform` | 与 `src/core/git-argv.ts` 的 `withGitBinary` 同源(那里也是按平台选 `git.exe`) |
 * | `__APP_NAME__` | `'dsh-git'` | 上游用它做 `git clone` 的默认目录名回落(`lib/git/clone.ts:81`)。用**本插件**的名字,不用上游的 `'GitHub Desktop'` —— 否则会在用户的克隆目录名里凭空出现另一个产品名 |
 * | `__RELEASE_CHANNEL__` | `'production'` | 我们**没有** beta/test 通道 ⇒ `enableBetaFeatures()` 恒 `false`,与今天的宿主行为一致 |
 *
 * ⚠️ **不进 client 的 `inject`**:浏览器半有自己那份(`src/client/desktop-globals.ts`),
 * 两个 bundle 的全局来源必须各自独立 —— 合并就会把 `process.platform` 拖进浏览器包。
 *
 * @module dsh-git/host/desktop-globals
 */

/** 上游开发构建为 `true`;我们按正式版处理。 */
export const __DEV__ = false;

/** 上游打包期按平台替换;宿主半按**运行期**平台判断。 */
export const __DARWIN__ = process.platform === 'darwin';

/** 见 {@link __DARWIN__}。 */
export const __WIN32__ = process.platform === 'win32';

/** 见 {@link __DARWIN__}。 */
export const __LINUX__ = process.platform === 'linux';

/** 上游打包期注入的应用名(`lib/git/clone.ts:81` 用它做克隆目录名回落)。 */
export const __APP_NAME__ = 'dsh-git';

/** 上游打包期注入的发布通道。宿主半没有 beta/test 通道。 */
export const __RELEASE_CHANNEL__ = 'production';

/*
 * ---------------------------------------------------------------------------
 * 三样**不是构建期常量**、但同样必须垫的全局 —— 全部经由 `inject` 进来
 *
 * ## 为什么用 `inject` 而不是 `globalThis.xxx = …`(这是刻意的,不是顺手)
 *
 * 宿主是**跑在 DSH 进程里**的插件。往 `globalThis` 上写 `log` / `location`
 * 这种**通用名**,等于改整个宿主进程的全局环境,会与 DSH 自己或别的插件撞。
 * `inject` 只替换**由 esbuild 打包的那批文件**里的自由标识符,
 * 一个字节都不写进程全局 —— 这是唯一不越界的做法。
 *
 * ## 逐条
 *
 * | 名字 | 镜像里谁用 | 不垫的后果 |
 * |---|---|---|
 * | `localStorage` | `lib/git/authentication.ts:9`(`GIT_TRACE`)、`lib/local-storage.ts`、`lib/stores/helpers/tags-to-push-storage.ts` | node ≥22 **有** `globalThis.localStorage` 这个属性,但**不带方法**(实测 `typeof localStorage === 'object'` 而 `localStorage.setItem is not a function`)⇒ `TypeError`,而且是在**每一次远端操作**上(`envForRemoteOperation` → `envForAuthentication`) |
 * | `log` | `lib/git/core.ts`、`lib/stores/git-store.ts`(`updateRemoteHEAD` 失败时)、`lib/git/environment.ts`(代理日志) | `ReferenceError: log is not defined`,`types/desktop-globals.d.ts` 只给了**类型**,运行期没有实现 —— **只在失败路径上出现**,平时看不出来 |
 * | `location` | **只有** `models/formatting-preferences.ts:5`(实测:可达镜像里 `location.` 只此一处) | `ReferenceError: location is not defined`(**模块顶层**,所以是加载即崩) |
 *
 * ## `localStorage` 的语义:**内存、按进程、不落盘**
 *
 * 上游是浏览器的持久化面。这里是进程内的 `Map` ⇒ 宿主重启丢失。
 * ⚠️ 这对**标签清单**那笔账是**承重**的:`GitStore` 的构造函数会
 * `getTagsToPush(repository)`,在这份内存实现下**恒为空** ——
 * `src/host/mirror-git.ts` 的文件头解释了为什么宿主**故意不**用上游的策展清单。
 */

/** 宿主侧的最小日志接口 —— 与 `types/desktop-globals.d.ts` 的 `IDesktopLogger` 逐条同形。 */
export interface IMirrorLogger {
  /** 记一条错误。 */
  error(message: string, error?: Error): void;
  /** 记一条警告。 */
  warn(message: string, error?: Error): void;
  /** 记一条信息。 */
  info(message: string, error?: Error): void;
  /** 记一条调试。 */
  debug(message: string, error?: Error): void;
}

/**
 * 当前生效的 logger(默认 console 一族)。
 *
 * 刻意**不静默**:镜像里 `log.error('Failed updating remote HEAD', e)` 这类调用
 * 是诊断信息,吞掉它等于把「fetch 之后的 `remote set-head` 失败了」这种半失败
 * 状态藏起来。
 */
let logger: IMirrorLogger = {
  error: (message, error) => console.error(`[dsh-git/mirror] ${message}`, error ?? ''),
  warn: (message, error) => console.warn(`[dsh-git/mirror] ${message}`, error ?? ''),
  info: (message, error) => console.info(`[dsh-git/mirror] ${message}`, error ?? ''),
  debug: (message, error) => console.debug(`[dsh-git/mirror] ${message}`, error ?? ''),
};

/**
 * 把镜像层的日志接到宿主的 logger 上(宿主启动时调一次)。
 *
 * @param next - 宿主 logger;不调则用默认的 console 一族。
 */
export function setMirrorLogger(next: IMirrorLogger): void {
  logger = next;
}

/**
 * 上游 `log` 的宿主实现 —— esbuild `inject` 把镜像里的自由标识符 `log`
 * 替换成这个名字。
 */
export const log: IMirrorLogger = {
  error: (message: string, error?: Error) => logger.error(message, error),
  warn: (message: string, error?: Error) => logger.warn(message, error),
  info: (message: string, error?: Error) => logger.info(message, error),
  debug: (message: string, error?: Error) => logger.debug(message, error),
};

/** 一个 `Map` 支撑的 `Storage`。**不复现**浏览器的同源/配额/跨标签页同步。 */
class MemoryStorage implements Storage {
  private readonly items = new Map<string, string>();

  /** 当前键数(浏览器 `Storage` 的 `length`)。 */
  public get length(): number {
    return this.items.size;
  }

  /**
   * 取一个键。
   *
   * @param key - 键名。
   * @returns 值,或 `null`。
   */
  public getItem(key: string): string | null {
    return this.items.get(String(key)) ?? null;
  }

  /**
   * 写一个键。
   *
   * @param key - 键名。
   * @param value - 值。
   */
  public setItem(key: string, value: string): void {
    this.items.set(String(key), String(value));
  }

  /**
   * 删一个键。
   *
   * @param key - 键名。
   */
  public removeItem(key: string): void {
    this.items.delete(String(key));
  }

  /** 清空。 */
  public clear(): void {
    this.items.clear();
  }

  /**
   * 按下标取键名(浏览器语义:插入顺序)。
   *
   * @param index - 下标。
   * @returns 键名,或 `null`。
   */
  public key(index: number): string | null {
    return [...this.items.keys()][index] ?? null;
  }
}

/** 镜像里自由标识符 `localStorage` 的宿主实现(进程内、不落盘)。 */
export const localStorage: Storage = new MemoryStorage();

/**
 * 镜像里自由标识符 `location` 的宿主实现。
 *
 * 取值的后果**逐字等于「URL 里没有 `lc=`」**:上游那行是
 * `new URL(location.href).hash.match(/lc=([A-Z]{2})/)?.[1] ?? null`
 * ⇒ `localeCountryCode === null` ⇒ 12/24 小时制按系统/偏好回落。
 * 那个文件整片是**显示格式**偏好,不在 push/fetch 这条链上。
 *
 * ⚠️ 刻意**不**垫 `window` / `document`:可达的镜像里一个都没用到,
 * 垫上它们只会让将来真引用了浏览器的镜像文件**静默**跑在假对象上。
 */
export const location = { href: 'https://github.com/dsh-git' };
