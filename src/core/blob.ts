/**
 * **内容取数路径的唯一真相**:一个上限、一份 Range 解析、一份类型判定。
 *
 * ## 为什么需要这个模块(而不是把常量放在 git-service 里)
 *
 * 在这次改动之前,「一个文件能不能读」由**三个互不知情的魔数**在**三层**里决定:
 *
 * | 层 | 魔数 | 超限后的行为 |
 * |---|---|---|
 * | `git-service.fileText` / `showFile` | 文本 900_000 | 交回**截断的头部**,`truncated:true` |
 * | 同上(二进制) | 2_000_000 | 交回空内容 + `kind:'too-big'` |
 * | `git-runner`(子进程收集器) | `OUTPUT_CAP_BYTES` = 4<<20 | **静默保留尾部** |
 *
 * 三个数字各自都能单独变化,而**只有最后一道是隐式的**:收集器截断时保留的是
 * **尾部**,于是「超限」在调用方看来是**一段合法内容**(坏图 / 从中间开始的 diff),
 * 没有任何错误。设计文档 §15.5 修过一次(显式判 `stdoutTruncated`),但**形状没变**:
 * 仍然是「先取内容、再判大小」,仍然是三层各自决定。
 *
 * 这里把上限**收敛成一个常量**,并且规定它的语义是
 * **「一次响应的字节数」而不是「一个文件的字节数」**:
 *
 *  - 整份内容的请求(`GET blob`,无 `Range`)超过它 ⇒ **拒绝**(带真实大小与上限),
 *    绝不返回截断体;
 *  - `Range` 请求只受「请求到的切片长度」约束 ⇒ 100MB 的文件也能安全地取中间 64KB。
 *
 * 于是「超限」永远发生在**取内容之前**(`blobInfo` 先量大小),`truncated` 只可能是
 * **显式的头部截断**(带偏移),不可能是收集器那种「悄悄从中间开始」。
 *
 * @module dsh-git/core/blob
 */

/**
 * **一次响应允许的字节数上限(唯一一处定义)**。
 *
 * 取 2 MiB 的三个理由:
 *  1. **必须严格小于** runner 收集器的 `OUTPUT_CAP_BYTES`(4 MiB)。否则「我们自己的
 *     上限」永远轮不到触发,决定权就悄悄落回收集器 —— 而收集器保留的是尾部
 *     (design.md §15.5 记过一次「8MB 上限是死代码」)。
 *  2. 一张 1.4MB 的截图能整份通过(全屏 Retina 截图的常见量级);
 *     更大的图**响亮拒绝**,而不是画一张坏图。
 *  3. `Range` 让「比它大的文件」依然可用 —— 上限约束的是**一次响应**,不是文件。
 */
export const MAX_BLOB_BYTES = 2 * 1024 * 1024;

/**
 * **老 host 的 base64 兜底上限**(2026-10 迁移期,刻意小得多)。
 *
 * 为什么还留一条 base64 路径:`show-file` / `file-text` 是**旧 host 的契约**,
 * 而 host 半不热重载 —— 刷新页面拿到新前端、host 还是旧的时候,新前端必须还能
 * 显示图片 diff,否则「图片 diff 突然全没了」会被当成新引入的 bug。
 *
 * 为什么必须**小得多**(256 KiB 而不是 2 MiB):
 *  - base64 把内容放大 33%,而且**整份内容必须同时作为 JS 字符串存在**
 *    (这正是新路径要消灭的东西);
 *  - 这条路径**每个字节都要穿 JSON**,没有 `Range`、没有 `Cache-Control`;
 *  - 它只是迁移期的止损,不是一条要优化的路径。
 */
export const BLOB_JSON_FALLBACK_MAX_BYTES = 256 * 1024;

/** `rev=index` 的保留字:读**索引**(暂存区)里的 blob,而不是某个提交。 */
export const INDEX_REV = 'index';

/** 内容上限的人类可读形式(错误信息与界面提示共用,避免两处各写一遍)。 */
export function formatByteSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * 这个修订名是否**内容永不变**(可以 `Cache-Control: immutable`)。
 *
 * 只有**完整对象名**(sha1 40 位 / sha256 64 位十六进制)才是不可变的。
 * `HEAD`、分支名、`index` 都是**会动的引用** —— 对它们回 `immutable` 会让浏览器
 * 在引用移动后继续用旧的缓存(这正是「切了分支但 diff 是旧的」这类难查 bug 的来源)。
 * 它们的 `ETag` 仍然带 blob sha,所以 `If-None-Match` 能廉价地拿到 304。
 */
export function isImmutableRev(rev: string): boolean {
  return /^[0-9a-f]{40}$/i.test(rev) || /^[0-9a-f]{64}$/i.test(rev);
}

/** `Range` 头的解析结果。`null` = 没有 `Range`(整份内容)。 */
export type ParsedRange =
  | { readonly kind: 'ok'; readonly start: number; readonly end: number }
  /** 语法合法但落在实体之外(`start >= size`,或 `-0`)⇒ 416。 */
  | { readonly kind: 'unsatisfiable' }
  /** 语法不合法 ⇒ 忽略(按整份内容回 200),与 RFC 7233 的「不认识的 Range」一致。 */
  | { readonly kind: 'invalid' };

/**
 * 解析单区间 `Range` 头。
 *
 * 只支持**单区间**:多区间要回 `multipart/byteranges`,而我们的调用方(图片 `<img>`、
 * 文本头部)从来不需要它 —— 与其实现一个半吊子的 multipart,不如按 RFC 当语法不合法处理。
 *
 * @param header - `Range` 头的值(或 null)。
 * @param size - 实体总字节数。
 */
export function parseRangeHeader(header: string | null | undefined, size: number): ParsedRange | null {
  if (header === null || header === undefined || header.trim() === '') {
    return null;
  }
  const match = /^bytes=(.*)$/i.exec(header.trim());
  // 单位不是 bytes ⇒ 按 RFC **忽略**这个头(不能当错误)。
  if (match === null) {
    return null;
  }
  const spec = (match[1] ?? '').trim();
  if (spec === '' || spec.includes(',')) {
    return { kind: 'invalid' };
  }
  const one = /^(\d*)-(\d*)$/.exec(spec);
  if (one === null) {
    return { kind: 'invalid' };
  }
  const rawStart = one[1] ?? '';
  const rawEnd = one[2] ?? '';
  if (rawStart === '' && rawEnd === '') {
    return { kind: 'invalid' };
  }
  if (rawStart === '') {
    // `bytes=-N`:最后 N 个字节。
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) {
      return { kind: 'unsatisfiable' };
    }
    if (size === 0) {
      return { kind: 'unsatisfiable' };
    }
    const start = Math.max(0, size - suffix);
    return { kind: 'ok', start, end: size - 1 };
  }
  const start = Number(rawStart);
  if (!Number.isFinite(start)) {
    return { kind: 'invalid' };
  }
  if (start >= size) {
    return { kind: 'unsatisfiable' };
  }
  if (rawEnd === '') {
    return { kind: 'ok', start, end: size - 1 };
  }
  const end = Number(rawEnd);
  if (!Number.isFinite(end)) {
    return { kind: 'invalid' };
  }
  if (end < start) {
    return { kind: 'invalid' };
  }
  return { kind: 'ok', start, end: Math.min(end, size - 1) };
}

/** 扩展名 → 内容类型(小写,带点)。只列我们真的会遇到的。 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jpe': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.json': 'application/json; charset=utf-8',
  '.jsonc': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.diff': 'text/plain; charset=utf-8',
  '.patch': 'text/plain; charset=utf-8',
  '.yml': 'text/plain; charset=utf-8',
  '.yaml': 'text/plain; charset=utf-8',
  '.toml': 'text/plain; charset=utf-8',
  '.ini': 'text/plain; charset=utf-8',
};

/** 小写扩展名(带点);没有点或点是首字符则回空串(与 `Path.extname` 同口径)。 */
export function extensionOfPath(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const trimmed = base.slice(base.lastIndexOf('\\') + 1);
  const dot = trimmed.lastIndexOf('.');
  return dot <= 0 ? '' : trimmed.slice(dot).toLowerCase();
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) {
    return false;
  }
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[offset + index] !== signature[index]) {
      return false;
    }
  }
  return true;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let index = 0; index < length; index += 1) {
    const byte = bytes[offset + index];
    if (byte === undefined) {
      return out;
    }
    out += String.fromCharCode(byte);
  }
  return out;
}

/**
 * **魔数嗅探** —— 内容类型的第一判据(扩展名是第二判据)。
 *
 * 顺序刻意的:扩展名会撒谎(`.png` 里其实是一段 JSON、`.bin` 里其实是 PNG),
 * 而浏览器**只按内容类型解码**。对图片路径尤其要紧:扩展名说是图片、内容不是,
 * `<img>` 就裂图;内容真是图片、扩展名不是,`<img>` 反而不画。
 *
 * @param path - 仓库内路径(只用来取扩展名)。
 * @param head - 内容的开头若干字节(最少 16 字节就能覆盖下表全部签名)。
 */
export function sniffContentType(path: string, head: Uint8Array): string | null {
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png';
  }
  if (startsWith(head, [0xff, 0xd8, 0xff])) {
    return 'image/jpeg';
  }
  if (ascii(head, 0, 6) === 'GIF87a' || ascii(head, 0, 6) === 'GIF89a') {
    return 'image/gif';
  }
  if (startsWith(head, [0x42, 0x4d])) {
    return 'image/bmp';
  }
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'WEBP') {
    return 'image/webp';
  }
  if (startsWith(head, [0x00, 0x00, 0x01, 0x00])) {
    return 'image/x-icon';
  }
  if (ascii(head, 4, 4) === 'ftyp') {
    const brand = ascii(head, 8, 4);
    if (brand === 'avif' || brand === 'avis') {
      return 'image/avif';
    }
  }
  if (ascii(head, 0, 4) === '%PDF') {
    return 'application/pdf';
  }
  if (startsWith(head, [0x1f, 0x8b])) {
    return 'application/gzip';
  }
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) {
    return 'application/zip';
  }
  if (startsWith(head, [0x7f, 0x45, 0x4c, 0x46])) {
    return 'application/octet-stream';
  }
  // 没有魔数命中:扩展名优先,其次按「有没有 NUL」判文本/二进制。
  const byExtension = CONTENT_TYPES[extensionOfPath(path)];
  if (byExtension !== undefined) {
    return byExtension;
  }
  return null;
}

/** 前 8KB 出现 NUL 即判二进制(与 git 自己的判据、以及既有 `fileText` 同一口径)。 */
export function looksBinary(head: Uint8Array): boolean {
  return head.subarray(0, 8192).includes(0);
}

/**
 * 这个内容类型能不能按**文本**解码(客户端据此决定要不要把字节读成字符串)。
 *
 * 判据刻意宽:服务端的 `contentTypeFor` 对「没有魔数、不是已知二进制」的一律回
 * `text/plain; charset=utf-8`,而 `application/octet-stream` 是它的二进制兜底。
 * 所以这里只需要排除「明确不是文本」的那几类。
 * @param contentType - `Content-Type` 头(可带参数)。
 */
export function isTextContentType(contentType: string): boolean {
  const value = contentType.toLowerCase();
  if (value.startsWith('text/')) {
    return true;
  }
  return value.includes('json')
    || value.includes('xml')
    || value.includes('javascript')
    || value.includes('yaml')
    || value.includes('svg');
}

/**
 * 最终的内容类型:**魔数 > 扩展名 > 文本/二进制兜底**。
 * @param path - 仓库内路径。
 * @param head - 内容开头(没有内容时传空数组)。
 */
export function contentTypeFor(path: string, head: Uint8Array): string {
  const sniffed = sniffContentType(path, head);
  if (sniffed !== null) {
    return sniffed;
  }
  const byExtension = CONTENT_TYPES[extensionOfPath(path)];
  if (byExtension !== undefined) {
    return byExtension;
  }
  return looksBinary(head) ? 'application/octet-stream' : 'text/plain; charset=utf-8';
}
