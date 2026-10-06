/// <reference path="./client-platform-shims.d.ts" />

/**
 * **镜像引用、但我们没有镜像过来的上游全局**(client / host 两个程序共用)。
 *
 * 本文件**没有 import/export** ⇒ 是 script(全局作用域),里面的 `declare`
 * 直接成为全局声明。这一点是刻意的:镜像里这些名字是**自由标识符**;一旦本文件
 * 变成 module(哪怕只有一行 `import`),声明就只在本模块内可见,全部失效。
 *
 * ## 来源一:esbuild `inject`(`scripts/build.mjs:55` `clientInject`)
 *
 * `src/client/desktop-globals.ts` 的导出被 esbuild 替换到镜像里的同名自由标识符上。
 * 类型层没有 `inject` 概念,所以在这里同名声明。
 * 类型必须与 `src/client/desktop-globals.ts` 一致,否则镜像里
 * `__DEV__ ? a : b` 这类分支会被判定成恒真/恒假而**掩盖代码**。
 *
 * ## 来源二:上游 `references/desktop/app/src/lib/globals.d.ts`
 *
 * 这个 `.d.ts` **没有**被镜像进 `src/core/desktop/**`(镜像只收 `.ts` / `.tsx`),
 * 但镜像文件**逐字**引用了它声明的 `log`(实证:上游 `globals.d.ts:135`
 * `declare const log: IDesktopLogger`,镜像 `ui/changes/no-changes.tsx` 有 20 处
 * `log.error(...)`)。
 *
 * 这里**只沿用镜像实际引用的那一个**(`log` + 它的接口,方法签名逐个对齐上游),
 * 不整份复制上游 `globals.d.ts`:那份还有 `__APP_VERSION__` / `__RELEASE_CHANNEL__` /
 * `__OAUTH_CLIENT_ID__` 等我们这个插件根本不注入的名字,声明了反而会掩盖
 * 「镜像沿用了一个不存在的全局」。
 *
 * `__dirname` **不在**本文件 —— 它只给 client 程序(`types/desktop-globals-client.d.ts`),
 * 因为 host 程序的 `@types/node` 已经声明了同名全局,两边都声会撞成 TS2451。
 *
 * @module dsh-git/types/desktop-globals
 */

/** 上游开发构建标记(`ui/lib/id-pool.ts` 用它做重复 id 告警)。我们按正式版处理。 */
declare const __DEV__: boolean;

/** 平台标记(上游打包时替换成字面量;见 `src/client/desktop-globals.ts`)。 */
declare const __DARWIN__: boolean;
declare const __WIN32__: boolean;
declare const __LINUX__: boolean;

/**
 * 上游 `app/src/lib/globals.d.ts` 的 `IDesktopLogger`。
 * 四个级别的方法签名逐字对齐上游(都接受可选 `Error`)。
 */
interface IDesktopLogger {
  /** 上游 `error(message: string, error?: Error): void`。 */
  error(message: string, error?: Error): void;
  /** 上游 `warn(message: string, error?: Error): void`。 */
  warn(message: string, error?: Error): void;
  /** 上游 `info(message: string, error?: Error): void`。 */
  info(message: string, error?: Error): void;
  /** 上游 `debug(message: string, error?: Error): void`。 */
  debug(message: string, error?: Error): void;
}

/**
 * 上游 `globals.d.ts:135` 的全局日志器。
 *
 * ⚠️ 这只让**镜像通过类型检查**,不代表运行期有实现。镜像里唯一引用它的
 * `ui/changes/no-changes.tsx` 目前不可达;一旦接线,`log` 在浏览器里是
 * `undefined`,必须在 `src/client/desktop-globals.ts` 补真实实现。
 * **本声明发现不了那个运行期缺口** —— 那是 `scripts/check-integration.mjs`
 * 的可达性判据的事(见 `docs/type-check.md` §4 的「抓不到」清单)。
 */
declare const log: IDesktopLogger;
