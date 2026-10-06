/**
 * `node:url` 的浏览器替身 —— 实现镜像里逐字复制的 Desktop 文件用到的两个导出:
 * `pathToFileURL` 与 `parse`。
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
 *    与上游的差异:输入非法 URL 时这里**抛 `TypeError`**(WHATWG 语义),
 *    而 `node:url` 的 `parse` 会返回一个带 `null` 字段的对象。调用方只可能传
 *    仓库的 endpoint,不存在非法输入,故不额外兜底。
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
 * `node:url` 的 `parse` 在浏览器里的真实实现。
 *
 * 上游两个调用点用到的字段都在这里:
 *  - `lib/api.ts:2319` 的 `getHTMLURL()` 取 `protocol` / `hostname`;
 *  - `ui/repositories-list/group-repositories.ts:62` 的 `getHostForRepository()`
 *    取 `host`(用来给企业版仓库分组做去重键)。
 *
 * 其余字段(`pathname` 等)按需再加 —— 加了就要有调用点,否则是死代码。
 * @param url - 待解析的绝对 URL 字符串。
 */
export function parse(url: string): {
  protocol: string
  hostname: string
  host: string
  toString(): string
} {
  const parsed = new globalThis.URL(url)
  return {
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    host: parsed.host,
    toString: () => parsed.toString(),
  }
}

export default { pathToFileURL, parse }
