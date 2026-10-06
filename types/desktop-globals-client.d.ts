/**
 * **只给浏览器半**(`tsconfig.json`)的全局:Electron 的 `__dirname`。
 *
 * 镜像 `ui/diff/index.tsx:38` 用 `__dirname` 定位「无法渲染的 diff」占位图;
 * 上游是 Electron 渲染进程,我们的替身在 `src/client/desktop-globals.ts:47`
 * 给了一个固定前缀(`/dsh-git-diff`)。
 *
 * ## 为什么单独一个文件,而不是并进 `types/desktop-globals.d.ts`
 *
 * host 程序(`tsconfig.host.json`)设了 `types: ["node"]`,而 `@types/node`
 * 自己在全局声明了 `var __dirname: string`(实证 `@types/node/module.d.ts:853`)。
 * 一个 `declare var` 与一个 `declare const` 同名会撞成 TS2451,而 host 半
 * **根本不需要**这个替身(host 跑在真 node 里,`__dirname` 是真实的)。
 * 所以按程序拆分:host 用 @types/node 的真声明,client 用这个替身。
 *
 * 本文件无 import/export ⇒ script,`declare const` 直接进全局作用域。
 *
 * @module dsh-git/types/desktop-globals-client
 */

/** Electron 的 `__dirname` 替身;值见 `src/client/desktop-globals.ts` 的同名导出。 */
declare const __dirname: string;
