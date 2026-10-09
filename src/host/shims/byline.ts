/**
 * `byline` 的**边界适配器** —— 「真依赖 + 一处转换」(2026-10-08 重写)。
 *
 * ## 为什么要这一层(以及它**不再**是什么)
 *
 * 用户裁决(逐字):「**可以,使用 `@github/alive-client`、`byline`**」⇒
 * `byline@^5.0.0` 进了 `dependencies`。本文件**曾经**是一个手写的 8 行行切分器
 * (理由是「为它加一个 npm 依赖不划算」)—— 那个理由现在**不成立**,所以本文件
 * 重写成「调真包 + 一次类型转换」,手搓的行切分逻辑**没有保留**。
 *
 * ## 转的是哪一次,证据是什么(实测,不是推断)
 *
 * 上游 4 个消费方的类型标注**互相矛盾**:
 *
 * | 位置 | 标注 | 它拿这个值做什么 |
 * |---|---|---|
 * | `lib/progress/from-process.ts:91` | `(line: string)` | `parser.parse(line)` → `stripVTControlCharacters(line)` |
 * | `lib/git/rebase.ts:337` | `(line: string)` | 同上 |
 * | `lib/git/cherry-pick.ts:122` | `(line: string)` | 同上 |
 * | `lib/file-system.ts:33` | `(buffer: Buffer)` | `buffer.toString()` |
 *
 * 真 byline 发什么,取决于**输入流的 `_readableState.encoding`**
 * (`node_modules/byline/lib/byline.js:76-83` 的 `'pipe'` 处理器 + `:144-155` 的
 * `_reencode`)。在本机量过三档(真子进程 / 真 `process.std*`):
 *
 * ```
 * process.stdout._readableState.encoding = null
 * process.stderr._readableState.encoding = null
 * child.stdout._readableState.encoding  = null      ← spawn(stdio:'pipe')
 * real byline(child.stdout)               = ["Buffer"]
 * real byline(child.stdout + setEncoding)  = ["string"]
 * ```
 *
 * ⇒ **不转换 ⇒ 发 `Buffer`** ⇒ `stripVTControlCharacters(Buffer)` 抛
 * `ERR_INVALID_ARG_TYPE`(3 个消费方里 3 个中招,而第 4 个 `buffer.toString()`
 * 对 `string` 是恒等)。所以这里传 `{ encoding: 'utf8' }` —— **byline 自己的选项**,
 * 它让 `_reencode`(`:148-151`)原样返回字符串。
 *
 * ## 这一层现在**复现**什么(手搓版复现不了的那些,全都回来了)
 *
 * | 行为 | 来源 |
 * |---|---|
 * | 行边界按 Unicode `Line_Boundaries`(`\r\n` / `\n` / `\v` / `\f` / `\r` / `\x85` / `\u2028` / `\u2029`) | 真包 `:102-104` |
 * | 跨 chunk 的 CRLF(不把 `\r` / `\n` 拆成两行) | 真包 `:105-108` |
 * | 空行**默认丢弃**(`keepEmptyLines` 可开) | 真包 `:125` |
 * | **背压**(高水位时 `setImmediate` 续推,而不是无界 `write`) | 真包 `:126-133` |
 * | 对象模式输出(行不被重新拼接) | 真包 `:69` |
 *
 * 唯一**刻意**的偏离就是输出的**类型**:`string`(而不是来源编码决定的 `Buffer`)。
 *
 * ## 与上游的语义差(逐条)
 *
 * 1. 上游自己**没有**这一层。它那 3 处 `(line: string)` 标注在真 byline + 无编码流
 *    下是**运行期不成立**的 —— 那是上游的一处不自洽(本文件不修它,只在边界挡住);
 * 2. 本适配器**强制** `utf8`。若某天有调用点要二进制行(今天没有),
 *    必须走 `byline-real` 直连而不是这个模块。
 *
 * ## 退役条件
 *
 * ① 上游把那 4 处的标注统一(与自己传流的编码一致)时,删掉本文件与
 * `scripts/build.mjs` 的 `byline` alias,让镜像直接 `import 'byline'`;
 * ② 或本仓给那些流做流级 `setEncoding('utf8')` 时同理。
 *
 * @module dsh-git/host/shims/byline
 */

/*
 * ⚠️ `'byline-real'` **不是 npm 上的包**:它是 `scripts/build.mjs` 的 `hostAlias`
 * 里那第二条映射(指向 `node_modules/byline/lib/byline.js`),类型声明在
 * `types/host-shims.d.ts`。为什么不能直接写 `import real from 'byline'`:
 * esbuild 的 alias 对 alias 目标自己的 import **也生效** ⇒ 会打成
 * `function wrap(stream){ return wrap(stream) }`(构建成功、运行期无限递归);
 * 写成 `'byline/lib/byline.js'` 则构建直接失败。三条都实测过。
 */
import real from 'byline-real';

/**
 * 把一个可读流按行重新发射(**真 byline**,输出固定为 `string`)。
 *
 * @param input - 任意可读流(`process.stderr` / `process.stdout` / `fs.createReadStream` / 子进程 stdio)。
 * @returns 逐行发射的流(`'data'` 每次一整行,含行尾分隔符;类型是 `string`)。
 */
export default function byline(input: NodeJS.ReadableStream): NodeJS.ReadableStream {
  return real(input, { encoding: 'utf8' });
}
