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

/*
 * **Node 的定时器全局**:`setImmediate` / `clearImmediate`。
 *
 * 为什么需要(2026-10 实测):镜像的虚拟列表 `ui/lib/list/section-list.tsx` 在
 * **ResizeObserver 回调**里就用了 `setImmediate`(`:488`,`clearImmediate` 在 `:485`),
 * 卸载路径在 `:1128`;`ui/lib/list/list.tsx:451-454, 1082` 同形。浏览器里没有这两个全局
 * ⇒ `ReferenceError: setImmediate is not defined` ⇒ **React 17 把整棵 ChangesView 卸掉**
 * (现场:`docs/probes/changes-discard-lines-probe.mjs` 报 `rows: 0` 而 `lineLabels: 8` ——
 * 右栏还在、左栏整块没了)。
 *
 * 语义:Node 的 `setImmediate` 是「本轮 I/O 之后、定时器之前」;浏览器里最接近的等价物是
 * `setTimeout(fn, 0)`(上游自己也只在 `ResizeObserver` 回调里用它做「尺寸稳定后再量一次」),
 * 句柄类型是 `number`,所以 `clearImmediate` 直接接 `clearTimeout` —— 两边配对,
 * 不会出现「clear 一个 set 的句柄类型不匹配」。
 *
 * 这两个名字进 `clientInject`(`scripts/build.mjs:103` 注入的是**整个文件**的导出),
 * 所以镜像文件保持一字不改。
 * @param handler - 回调。
 */
export const setImmediate = (handler: (...args: Array<unknown>) => void, ...args: Array<unknown>): number =>
  (globalThis as { setTimeout: (fn: () => void, ms?: number) => number }).setTimeout(() => { handler(...args) }, 0)

/** @param handle - `setImmediate` 的返回句柄。 */
export const clearImmediate = (handle: number): void => {
  (globalThis as { clearTimeout: (id: number) => void }).clearTimeout(handle)
}

/*
 * **Node 的 `Buffer`(最小子集)** —— 2026-10-09 补,理由是实测出来的**两个缺陷**。
 *
 * ## 为什么需要它(这两条都是「接上 ③ 之后才可达」的)
 *
 * 1. **`ui/lib/sandboxed-markdown.tsx:173`**:
 *
 *    ```ts
 *    const b64src = Buffer.from(src, 'utf8').toString('base64')
 *    this.frameRef.src = `data:text/html;charset=utf-8;base64,${b64src}`
 *    ```
 *
 *    浏览器里没有 `Buffer` ⇒ 这一行**抛** `ReferenceError`,`renderMarkdown` 的
 *    promise 被拒 ⇒ **沙箱 markdown 的正文永远不渲染**。这条在 ③ 之前不可能发生:
 *    那个组件当时**零渲染方**(`grep -rn "SandboxedMarkdown" src/client` 只命中
 *    本文件的 import)。实测现场:本仓
 *    `docs/probes/notification-dialog-wiring-probe.mjs` 第一次跑到 W1 时,
 *    弹出的 `#pull-request-comment` 里**只有作者行、没有 iframe**。
 * 2. **`lib/git/git-delimiter-parser.ts:23`**:`Buffer.isBuffer(value) ? … : value.split('\0')`。
 *    同上,缺 `Buffer` 就是 `ReferenceError`(那条链今天只由宿主半走,但镜像文件
 *    是同一份)。
 *
 * ## 它**不是** Node 的 `Buffer`
 *
 * 只实现**被真正调用过**的那两个成员,而且:
 *  - `from` 只接受**字符串**输入(两个调用点都是),编码只认 `'utf8'`;
 *    其余**抛** —— 与 `shim-node-crypto.ts` / `shim-node-fs-promises.ts` 同一约定:
 *    **不许静默回一个看起来对的值**。
 *  - `isBuffer` 恒 `false`:浏览器半**没有**任何一个真 `Buffer` 实例
 *    (`git-delimiter-parser` 的另一个分支要的是「值已经是 Buffer 就按字节切」,
 *    而在浏览器里那个分支本来就到不了;恒 `false` 让它走 `value.split('\0')`,
 *    也就是**正确**的那一支)。
 *
 * 进 `clientInject`(与上面 `setImmediate` 同一机制),所以镜像文件保持一字不改。
 * ⚠️ **tsc 看不见 `inject`** —— 那两条 TS2591 要靠
 * `src/client/node-globals.d.ts` 里的 `declare const Buffer` 才消;两份必须同源,
 * 动一份就要动另一份。
 */
export const Buffer = {
  /**
   * 字符串 → 一个能 `toString('base64')` 的最小对象。
   * @param input - 输入字符串。
   * @param encoding - 只支持 `'utf8'`(省略即 utf8)。
   * @throws {TypeError} 传了别的编码时**抛**,不静默按 utf8 处理。
   */
  from(input: string, encoding: string = 'utf8'): { toString(enc: string): string } {
    if (encoding !== 'utf8') {
      throw new TypeError(`Buffer.from 的浏览器最小替身只实现了 'utf8',收到 ${JSON.stringify(encoding)}`)
    }
    return {
      toString(enc: string): string {
        if (enc !== 'base64') {
          throw new TypeError(`Buffer#toString 的浏览器最小替身只实现了 'base64',收到 ${JSON.stringify(enc)}`)
        }
        return utf8ToBase64(input)
      },
    }
  },
  /**
   * 恒 `false`(见上面那段「不是 Node 的 Buffer」的理由)。
   * @param _value - 被检查的值。
   */
  isBuffer(_value: unknown): boolean {
    return false
  },
}

/** RFC 4648 的标准字母表。 */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/**
 * `utf8 → base64`。
 *
 * 用 `TextEncoder` 取字节(它按 UTF-8 编码,与 Node 的 `Buffer.from(s,'utf8')` 一致),
 * 再手工做 base64。**不**用 `btoa`:它只吃 latin1,把多字节字符直接塞进去是错的
 * (`sandboxed-markdown.tsx:171-172` 的注释写的正是上游为什么绕开 `btoa`)。
 * @param text - 输入文本。
 */
function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0
    const b1 = bytes[i + 1]
    const b2 = bytes[i + 2]
    out += B64[b0 >> 2]
    out += B64[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)]
    if (b1 === undefined) {
      out += '=='
      break
    }
    out += B64[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)]
    if (b2 === undefined) {
      out += '='
      break
    }
    out += B64[b2 & 0x3f]
  }
  return out
}
