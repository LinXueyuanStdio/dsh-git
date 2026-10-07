/**
 * `log` 全局的最小替身。
 *
 * GitHub Desktop 把 `log` 声明为全局(`app/src/lib/globals.d.ts:135`),由 Electron
 * 主进程注入;被复制过来的 `patch-formatter.ts` 在一条防御分支里调用
 * `log.debug`。这里提供一个同形对象,让复制来的文件保持原样。
 * @module dsh-git/core/desktop/lib/log
 */

/**
 * 命名带 `I` 前缀:上游 `.eslintrc.yml` 的 `@typescript-eslint/naming-convention`
 * 要求 interface 匹配 `^I[A-Z]`(本仓库 `.eslintrc.yml` 与上游一致了这条)。
 */
interface ILoggerLike {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}

export const log: ILoggerLike = {
  debug(message: string): void { console.debug(`[dsh-git] ${message}`); },
  info(message: string): void { console.info(`[dsh-git] ${message}`); },
  warn(message: string): void { console.warn(`[dsh-git] ${message}`); },
  error(message: string, error?: unknown): void { console.error(`[dsh-git] ${message}`, error ?? ''); },
};
