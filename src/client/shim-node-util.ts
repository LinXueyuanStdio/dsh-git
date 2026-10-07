/**
 * 浏览器半的 `node:util` 替身 —— **只**转出上游用到的那一个函数。
 *
 * ## 为什么需要它(以及为什么不是「为了一个 import 造一个大替身」)
 *
 * 上游解析器 `src/core/desktop/lib/progress/git.ts:1` 的第一行是
 *
 * ```ts
 * import { stripVTControlCharacters } from 'util'
 * ```
 *
 * 那是宿主主进程(Node)的能力,而镜像文件必须**一字不改**。浏览器半的
 * `tsconfig.json` 同时是「禁止 node 内置」的机器检查(`types: []`,见该文件头),
 * 所以镜像里每个 node 内置 import 都要么有一条 `paths` 替身(`path` / `url` /
 * `fs/promises`),要么落进基线(`os` / `electron` / `dugite` 那几条)。
 * 不补这条替身 ⇒ 镜像目录里多一个 TS2307、type-check 棘轮多一个文件,
 * 而那条红**不是**产品缺陷(解析器根本不在客户端包里)。
 *
 * 替换掉的是 `util` 的**一个**函数,不是整个模块:文件里只有这一个导出,
 * 而且它**没有任何依赖**(`size` 约 4 行)。
 *
 * ## 它复现什么
 *
 * `stripVTControlCharacters(str)` 的语义(Node ≥16.11):把 ANSI 控制序列从
 * 字符串里去掉。用的是 Node 内部**同一个** `ansi` 正则(也就是 `ansi-regex` 那条),
 * 逐字取自 Node `lib/internal/util/inspect.js` 的 `ansi` 常量:
 *
 * ```js
 * '[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)'
 * + '|' + '(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))'
 * ```
 *
 * 等价性由 `docs/probes/shim-node-util-probe.mjs` 拿本机**真 `node:util`**
 * 在一组语料上逐字比对(含 DCS 那种**不**被剥掉的怪序列 —— 判据是「与真身同值」,
 * 不是「看起来像去了色」)。**漂移会红,不会静默。**
 *
 * ## 它**不**复现什么(诚实边界)
 *
 * 1. **不做运行期类型校验**。Node 的真身先 `validateString(str, 'str')`,传数字会抛
 *    `ERR_INVALID_ARG_TYPE`;这里靠 TS 的类型,传错类型时行为未定义。上游那唯一一个
 *    调用点(`lib/progress/git.ts:219`)传的一定是 `string`(`parse(line: string)`),
 *    所以这条差异不在可达路径上。探针因此只比对**字符串**语料,并单独把
 *    「真身对非字符串抛错」记成**已知差异**,不判它。
 * 2. **不转出 `util` 的其它任何东西**(`format` / `inspect` / `promisify` / `TextDecoder`…)。
 *    镜像里今天只有这一个 `util` import;将来真需要别的,应当**再判一次要不要**,
 *    而不是往本文件里塞。
 * 3. **不承诺跟随未来 Node 版本**:Node 若改了那条正则,这里不会自动同步;
 *    探针比对的是本机真身,所以那一天探针会红。
 * 4. 与所有替身同一条纪律:**不静默返回假数据**。本文件是纯函数,没有「宿主没接上」
 *    这一态(它不读文件、不 spawn、不联网)。
 *
 * ⚠️ **这条替身会同时被 tsc 与 esbuild 用上**(实测,2026-10):esbuild 会读
 * `tsconfig.json` 的 `paths`,所以「类型层有替身、打包层没有」这种不对称**不存在**。
 * `scripts/build.mjs` 的 `clientAlias` 里也显式列了同一条(冗余但让解析不依赖
 * 「esbuild 恰好读 paths」这个隐式事实)。⇒ 万一有人把 `lib/progress/**` 真的
 * import 进 `src/client/**`,它会**成功**打包(实测 5,297 B / 4 个模块)并带上本替身,
 * 与 `path` / `url` / `fs/promises` / `os` 四条同形 —— 所以本替身的**正确性**
 * 才需要那条探针钉住(它错,进度文本就会带着 ANSI 垃圾进界面)。
 *
 * @module dsh-git/client/shim-node-util
 */

/** Node `lib/internal/util/inspect.js` 的 `ansi` 常量(逐字)。 */
const ANSI_PATTERN = new RegExp(
  '[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)'
  + '|'
  + '(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))',
  'g',
);

/**
 * 去掉字符串里的 ANSI 转义序列(等价于 Node 的 `util.stripVTControlCharacters`)。
 *
 * 上游调用点:`src/core/desktop/lib/progress/git.ts:219` —— 它先剥控制字符再解析,
 * 好让 `IGitProgress` 里的文本能直接进 tooltip(`git.ts:216-218`)。
 * @param text - 待处理文本。
 * @returns 去掉控制序列后的文本。
 */
export function stripVTControlCharacters(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}
