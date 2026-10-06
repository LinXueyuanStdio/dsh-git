/**
 * Desktop 的**构建期全局**在浏览器半的替身 —— 通过 `scripts/build.mjs` 的
 * esbuild `inject` 接进来(不是 `define`:`define` 只接受 JSON 字面量或单个标识符,
 * 而平台判断必须**运行期**做)。
 *
 * 上游这些名字来自 Desktop 的构建脚本:
 *  - `__DEV__`      —— 开发构建为 `true`(上游 `lib/globals.d.ts`);
 *  - `__DARWIN__` / `__WIN32__` / `__LINUX__` —— 打包时按平台替换为字面量;
 *  - `__dirname`    —— Electron 渲染进程的 node 全局。
 *
 * 镜像里**逐字复制**的文件直接引用它们(实证):`ui/lib/id-pool.ts:35,61`(2 处
 * `__DEV__`)、`ui/diff/index.tsx` / `side-by-side-diff.tsx` / `diff-options.tsx` /
 * `submodule-diff.tsx` / `ui/dialog/ok-cancel-button-group.tsx` / `ui/dialog/dialog.tsx`
 * (共 17 处 `__DARWIN__`)、`ui/dialog/dialog.tsx`(1 处 `__WIN32__`)、
 * `ui/diff/index.tsx:38`(1 处 `__dirname`)。
 *
 * 平台判断用 `navigator`,与 `lib/get-os.ts` 的替身同口径。
 * `__dirname` 给一个固定前缀:`ui/diff/index.tsx:38` 用它定位「无法渲染的 diff」
 * 占位图 `static/ufo-alert.svg` —— 见 `docs/desktop-ui-port.md` 的已知缺口一节,
 * 这个 SVG 在网页宿主里不存在,只有那一张占位图会 404,不影响其余渲染。
 * @module dsh-git/client/desktop-globals
 */

const ua =
  typeof navigator === 'undefined'
    ? ''
    : `${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`

/** 上游开发构建里是 `true`;我们按正式版处理。`ui/lib/id-pool.ts:35,61` 用它做重复 id 告警。 */
export const __DEV__ = false

/** 上游 `__DARWIN__`。 */
export const __DARWIN__ = /Mac|iPhone|iPad/.test(ua)

/** 上游 `__WIN32__`。 */
export const __WIN32__ = /Win/.test(ua)

/** 上游 `__LINUX__`。 */
export const __LINUX__ = /Linux/.test(ua) && !/Android/.test(ua)

/**
 * Electron 的 `__dirname`。浏览器里没有当前脚本目录,
 * 给一个不会与真实路径混淆的固定前缀。
 */
export const __dirname = '/dsh-git-diff'
