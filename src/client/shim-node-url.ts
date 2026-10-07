/**
 * `node:url` 的浏览器替身 —— 实现镜像里逐字复制的 Desktop 文件用到的三个导出:
 * `pathToFileURL`、`parse` 与 `fileURLToPath`(`fileURLToPath` 是 2026-10 为
 * `lib/markdown-filters/**` 集群补的;它的边界写在自己的 JSDoc 里)。
 *
 * 1. `pathToFileURL`(上游 `lib/path.ts:3` 用)
 *
 *    上游 `lib/path.ts:10` 的 `encodePathAsUrl(...)` 是
 *    `pathToFileURL(Path.resolve(...)).toString()`,被 `ui/diff/index.tsx:38` 用来定位
 *    「无法渲染的 diff」占位图。浏览器里既没有 file:// 也没有那个静态资源,
 *    因此这里返回**普通相对 URL 字符串**(`Path.resolve` 的结果),让调用点保持
 *    一个可用的字符串,而不是抛错。
 *
 * 2. `parse`(上游 `lib/api.ts:2` 的 `import * as URL from 'url'`,用在 `:2319`)
 *
 *    上游 `getHTMLURL()` 的最后一个分支是
 *    `const parsed = URL.parse(endpoint); return \`${parsed.protocol}//${parsed.hostname}\``。
 *    浏览器里没有 `node:url`,而这个分支在点 com 之外**是会被走的**
 *    (仓库分组时 `group-repositories.ts` 对每个 GitHub 仓库调 `getHTMLURL`);
 *    同一份 `group-repositories.ts` 还用 `URL.parse(...).host` 给企业版仓库分组。
 *
 *    这里**不是打桩,而是真实实现**:用 WHATWG `URL` 解析,取出同样的
 *    `protocol` / `hostname` / `host` 三个字段。对 `http(s)://host/...` 这类
 *    `getHTMLURL` 会遇到的输入,两者的结果一致(已实测 3 组:
 *    `https://api.github.com`、`http://github.mycompany.com/api/v3`、
 *    `https://example.com/x`)。
 *
 *    与上游的差异:输入非法 URL 时这里**不抛**,而是退回 `node:url` 的 legacy 形状
 *    (`protocol` / `hostname` / `host` 全是 `null`)—— 因为上游**逐字依赖**这个形状:
 *    `lib/stores/updates/update-remote-url.ts:34-39` 的注释写着
 *    「If protocol is null that implies the url is a ssh url of the format
 *    `git@github.com:octocat/Hello-World.git`, which can't be parsed by URL.parse.
 *    In this case we assume the user manually configured their remote to use this
 *    format and we don't want to change what they've done just to be safe」——
 *    也就是说 `protocol === null` 就是「ssh 形状 ⇒ 安静地不改 remote」这条**早退**分支的判据。
 *    改前这里抛 `TypeError: Invalid URL`,那条分支在我们树里**根本走不到**
 *    (实测与 `node:url` 的 legacy 读数见 `docs/probes/shim-node-url-parse-probe.mjs`;
 *    在此之前它被 `docs/probes/changes-state-seam-probe.mjs` 的 P10 钉成「已知偏离」)。
 * @module dsh-git/client/shim-node-url
 */

/** 返回一个 URL 对象形状的最小替代(只需 `.toString()`)。 */
class SimpleUrl {
  public constructor(private readonly value: string) {}
  public toString() {
    return this.value
  }
}

export function pathToFileURL(p: string) {
  return new SimpleUrl(p) as unknown as URL
}

/**
 * `node:url` 的 `fileURLToPath` 在浏览器里的最小替身。
 *
 * **唯一调用点**:镜像 `lib/markdown-filters/emoji-filter.ts:134` 的
 * `readFile(fileURLToPath(emoji.url))`(`Emoji.url` 在上游是 gemoji 的 `file://` 图片地址)。
 * 该调用在 `:104-127` 的 `createEmojiNode` 里,**外层有 `catch (e) {}` 吞掉一切失败**
 * 并返回 `null`(⇒ 该 emoji 被跳过),所以这里的行为边界不会变成未捕获异常。
 *
 * **它是恒等函数**,即 `fileURLToPath(x) === x`:
 *  - 与同文件 `pathToFileURL` 互逆(`pathToFileURL` 在浏览器里就返回普通路径字符串);
 *  - **不复刻** `node:url.fileURLToPath` 的这三件事(逐条点名,别误读成"等价"):
 *    ① 输入不是 `file:` scheme 时 node 抛 `ERR_INVALID_URL_SCHEME`,这里**不抛**;
 *    ② node 会做百分号解码(`%20` → 空格),这里**不做**;
 *    ③ node 会处理 `file://host/...`(UNC)与 Windows 盘符(`/C:/…` → `C:\…`),这里**不做**。
 *  ⇒ 真的接了宿主 `readFile` 钩子的人必须先自己把 `file://` 前缀剥掉并解码 ——
 *  这段边界写在这里是因为**静默给出一个错路径**比抛错难查得多。
 * @param u - 上游传进来的是 `Emoji.url`(gemoji 的 `file://` 图片地址)。
 * @returns 原样返回 `u`(见上面的边界清单)。
 */
export function fileURLToPath(u: string): string {
  return u
}

/**
 * `node:url` 的 `parse` 在浏览器里的真实实现。
 *
 * 上游两个调用点用到的字段都在这里:
 *  - `lib/api.ts:2319` 的 `getHTMLURL()` 取 `protocol` / `hostname`;
 *  - `ui/repositories-list/group-repositories.ts:62` 的 `getHostForRepository()`
 *    取 `host`(用来给企业版仓库分组做去重键)。
 *
 * 其余字段(`pathname` 等)按需再加 —— 加了就要有调用点,否则是死代码。
 *
 * ⚠️ **非法输入不抛**:WHATWG `URL` 会对 `git@github.com:o/r.git` 这种 ssh 形状抛
 * `TypeError: Invalid URL`,而 `node:url` 的 legacy `parse` 会安静地返回
 * `{protocol: null, hostname: null, host: null}`(实测读数:
 * `url.parse('git@github.com:o/r.git')` ⇒ `protocol: null`)。
 * 上游 `update-remote-url.ts:34-39` **正是靠这个 `null`** 判「手动配置的 ssh remote ⇒
 * 什么都别改」⇒ 这里必须镜像 legacy,否则那条早退分支永远走不到、
 * 「改名后的仓库」会把用户手配的 ssh remote 覆写成 API 的 clone_url。
 *
 * 边界(别读成「完整复刻 legacy」):其余**同样非法**的输入(如 `http://`、`C:\x`)
 * 这里也一律回三个 `null`,而 legacy 会从 `http://` 里嗅出 `protocol: 'http:'`、
 * 从 `C:\x` 嗅出 `'c:'`。本仓的调用点只传仓库 endpoint,而 ssh 形状需要的恰好就是
 * `protocol === null` ⇒ 不为此再复刻一遍 legacy 的协议嗅探(复刻等于第三份真源)。
 * 读数与阴/阳对照见 `docs/probes/shim-node-url-parse-probe.mjs`。
 * @param url - 待解析的 URL 字符串(合法绝对 URL,或 ssh 形状 `git@host:owner/repo.git`)。
 */
export function parse(url: string): {
  protocol: string | null
  hostname: string | null
  host: string | null
  toString(): string
} {
  let parsed: URL
  try {
    parsed = new globalThis.URL(url)
  } catch {
    // legacy 形状 —— 上游按 `protocol === null` 分派(见上面那段注释)。
    return { protocol: null, hostname: null, host: null, toString: () => url }
  }
  return {
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    host: parsed.host,
    toString: () => parsed.toString(),
  }
}

export default { pathToFileURL, parse, fileURLToPath }
