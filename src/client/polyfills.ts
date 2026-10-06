/**
 * 浏览器半的**全局替身**:目前只有 Node 的 `setImmediate` / `clearImmediate`。
 *
 * ## 为什么必须存在(实证,不是预防性补丁)
 *
 * 逐字镜像的 `src/core/desktop/ui/lib/list/section-list.tsx` 在 `ResizeObserver`
 * 回调里调 `setImmediate(this.onResized, target, contentRect)`(`:488`;`clearImmediate`
 * 在 `:485`),而 **`setImmediate` 不是浏览器全局** —— Chrome / Safari / Firefox
 * 都没有它(Node 专有),Chromium 只定义 `setTimeout`/`queueMicrotask`/
 * `requestAnimationFrame`/`MessageChannel`。
 *
 * 而且它不是 Node 全局能兜住的:本插件的页面跑在 Electron 的沙箱渲染进程里
 * (DSH Desktop 的 `electron-runtime-*.js`:`sandbox: true`、`contextIsolation: true`、
 * `nodeIntegration: false`),主世界**没有** `require`/`process`/`setImmediate`。
 * 所以没有替身时,下面的序列会抛 `ReferenceError: setImmediate is not defined`:
 *
 * ```
 *   src/client/index.ts
 *     → workbench.tsx:91 <RepoBar>
 *       → repo-bar.tsx:21 RepositoriesList(ui/repositories-list/index.ts)
 *         → repositories-list.tsx:34 SectionFilterList(ui/lib/section-filter-list.tsx)
 *           → ui/lib/list/section-list.tsx:478 ResizeObserver 回调(:488 setImmediate)
 * ```
 *
 * 触发动作就是**打开仓库下拉**(用户已截图的那一次):`ResizeObserver.observe()`
 * 之后浏览器会**立刻**投递一次初始 observation,之后每次尺寸变化(拖侧栏分隔条、
 * 改窗口宽度、容器查询换断点)都会再投一次。回调抛错 ⇒ `onResized` 永不执行
 * ⇒ `SectionList` 的 `state.width/height` 永远是 `undefined`(render 里
 * `this.state.width ?? 0`)⇒ **整个虚拟列表一行都不画**。
 *
 * ## 语义:为什么用 `setTimeout(fn, 0)`
 *
 * 镜像里那两处的**用意**写在注释里(上游原文):
 * 「We might end up causing a recursive update by updating the state when we're
 * reacting to a resize so we'll defer it until after react is done with this frame.」
 * 也就是「别在 ResizeObserver 回调这一帧里同步 setState,推到下一个宏任务」。
 * 两边的差别对这条语义没有影响:
 *
 * | | Node `setImmediate` | 本替身 `setTimeout(fn, 0)` |
 * |---|---|---|
 * | 时机 | check 阶段(同一轮 loop 的 I/O 之后) | timers 阶段(下一个宏任务) |
 * | 相对 `setTimeout(0)` | 先 | —— |
 * | 浏览器事件循环阶段 | 不存在 | 存在 |
 *
 * 浏览器没有 Node 的事件循环阶段,「下一个宏任务」是这里唯一可表达、也是 MDN
 * 与 WHATWG 都认可的等价物。两者都**不会**在调用栈内同步执行,都返回一个可以
 * 传给 `clear*` 的句柄,都支持**额外观数**(镜像传的是 `(fn, target, contentRect)`,
 * `setTimeout` 的 `...arguments` 正是同一语义)。
 *
 * 句柄身份:直接复用 `setTimeout` 的返回值(浏览器里是 number),`clearImmediate`
 * 原样转给 `clearTimeout`。镜像只做两件事 —— `!== null` 判断与 `clearImmediate(handle)`
 * —— 所以句柄只要「同一个值能来回传」即可,不需要额外的包装对象。
 *
 * ## 为什么只补缺失的那个(而不是无条件覆盖)
 *
 * `inject`/`define` 不是这里的选择:那要改 `scripts/build.mjs`(别人的文件),
 * 而且 `setImmediate` 需要运行期语义,不是值替换。这里做的是**只补浏览器缺失的**:
 * 宿主将来若真的提供了实现(例如某个 profile 的渲染进程带 node 集成),
 * 以宿主那份为准,不覆盖它。
 *
 * ## 刻意**没有**补的东西(每条都有理由)
 *
 * - **`Buffer`**:见 `docs/type-check.md` §8.2 第 12 条。逐字镜像里 `Buffer` 出现在
 *   4 个文件、8 处,但**运行期引用只有一个值是存在的**:`lib/git/git-delimiter-parser.ts:25`
 *   的 `Buffer.isBuffer(value)`。而该文件**零 import 方**(`split-buffer.ts` 只被它引用),
 *   所以它不在活路径、也不在产物里(实测:`lib/client.js` 里 63 处 `Buffer` 全部是
 *   依赖内部的 `ArrayBuffer`/`SharedArrayBuffer`/`deep-equal` 自己的 `isBuffer`/
 *   WebGL 的 `createBuffer`,没有一处是 `Buffer.isBuffer` 或 `Buffer.from`)。
 *   其余 3 个文件里的 `Buffer` 只出现在**类型位置**(`: Promise<Buffer | null>`),
 *   esbuild 直接擦除。⇒ **不补**:与其塞一个可能悄悄算错字节的假 Buffer
 *   (那些代码是**解析**用的,错了是数据损坏而不是崩溃),不如让它保持「缺」——
 *   `tsc` 的 client 程序会继续为它报 TS2591(`docs/type-check.md` §9 第 3 条:
 *   那正是这个问题目前唯一的机器证据)。
 * - **`process` / `global` / `__filename` / `require` / `module` / `exports`**:
 *   全仓库实测**没有任何值位置**的引用(镜像里只出现在注释与文案里);
 *   `__dirname` 是唯一真正被引用的 node 全局,它由 `scripts/build.mjs` 的
 *   `inject` 从 `src/client/desktop-globals.ts` 注入,不需要这里的替身。
 * @module dsh-git/client/polyfills
 */

/** 判定/赋值用到的全局面(只声明我们碰的两个键,避免污染 `globalThis` 的类型)。 */
interface ImmediatesGlobal {
  setImmediate?: (handler: (...args: unknown[]) => void, ...args: unknown[]) => number;
  clearImmediate?: (handle: number) => void;
}

/**
 * 用 `setTimeout(fn, 0, ...args)` 实现 Node 的 `setImmediate`。
 * @param handler - 要延迟到下一个宏任务执行的函数。
 * @param args - 透传给 `handler` 的额外观数(镜像传 `target` 与 `contentRect`)。
 * @returns 句柄(浏览器里就是 `setTimeout` 的 id),交给 `clearImmediate` 取消。
 */
function schedulerSetImmediate(handler: (...args: unknown[]) => void, ...args: unknown[]): number {
  return globalThis.setTimeout(handler, 0, ...args);
}

/**
 * 安装缺失的全局。**幂等**:已经有实现的宿主(或重复 import)不会被覆盖。
 *
 * 由 `src/client/index.ts` **第一行** import 触发;导出出来是为了让探针
 * (真实浏览器 / 直接调用)能显式装一次,而不必依赖模块图顺序。
 */
export function installGlobalPolyfills(): void {
  const scope = globalThis as unknown as ImmediatesGlobal;
  if (typeof scope.setImmediate !== 'function') {
    scope.setImmediate = schedulerSetImmediate;
  }
  if (typeof scope.clearImmediate !== 'function') {
    scope.clearImmediate = (handle: number): void => {
      globalThis.clearTimeout(handle);
    };
  }
}

// 模块级副作用:`import './polyfills.ts'` 即完成安装。
installGlobalPolyfills();
