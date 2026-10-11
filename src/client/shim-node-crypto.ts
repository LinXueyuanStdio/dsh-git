/**
 * `node:crypto` 的浏览器替身 —— 覆盖镜像 `ui/lib/object-id.ts:1` 的
 * `randomBytes(8).toString('base64url')`,以及 `ui/lib/sandboxed-markdown.tsx` 那条链上
 * 需要对象 id 的地方(同 `getObjectId`)。
 *
 * ## 为什么需要它(以及为什么不是「随便给个 id」)
 *
 * `object-id.ts`(逐字镜像,21 行)是:
 *
 * ```ts
 * const idMap = new WeakMap<object, string>()
 * export function getObjectId(obj: object): string {
 *   let id = idMap.get(obj)
 *   if (id === undefined) { id = randomBytes(8).toString('base64url'); idMap.set(obj, id) }
 *   return id
 * }
 * ```
 *
 * 它给每个对象发一个**进程内唯一**的字符串,用来在 DOM 上挂 `aria-labelledby` /
 * `id`(`ui/lib/sandboxed-markdown.tsx` 的 iframe 标题就是靠它)。
 * 所以这里的契约是「**同一次运行里不重复**」,不是密码学强度。
 *
 * 那为什么还是走真随机、而不是一个自增计数器?
 * **因为 `WeakMap` 的键是对象、值是字符串,而字符串会进 DOM。** 计数器是**可预测**
 * 而且**跨组件实例递增**的 —— 一旦哪天有人拿它当「渲染次数」或依赖它的顺序,
 * 那个假设会在别处悄悄破掉。用 `crypto.getRandomValues` 一行就够,
 * 不给自己留这个坑;强度上 8 字节随机在 2^64 空间里碰撞概率可忽略。
 *
 * ## 诚实边界(它**不是** node 的 `crypto`)
 *
 * 只实现**被真正调用过**的那一个方法。编码没实现就**抛** —— 本文件与
 * `shim-node-fs-promises.ts` 同一约定:**不许编一个看起来对的值**。
 * 一个静默返回错编码的 `toString('hex')` 会产出**无法用眼睛看出错**的 id,
 * 那比明确的失败难查得多。
 *
 * @module dsh-git/client/shim-node-crypto
 */

/**
 * `randomBytes(n).toString(enc)` 的返回值。
 *
 * 形状刻意**只声明上游/镜像真正用过的那一个方法**,与
 * `shim-node-fs-promises.ts` 的 `IReadFileBuffer` 同一理由:不假装我们提供了
 * `Buffer` 的其余部分(`slice` / `readUInt32BE` / `equals` …)。
 */
export interface IRandomBytes {
  /**
   * 把字节编码成字符串。
   * @param encoding - 支持的编码:{@link SUPPORTED_ENCODINGS}。
   * @throws {Error} 传了没实现的编码时**抛**,不静默回别的编码。
   */
  toString(encoding?: SupportedEncoding): string
}

/** 本替身**真的**实现的编码(`object-id.ts` 用的是 `base64url`)。 */
export type SupportedEncoding = 'base64url' | 'base64' | 'hex';

/** 给错误消息与探针用的名单。 */
export const SUPPORTED_ENCODINGS: readonly SupportedEncoding[] = ['base64url', 'base64', 'hex'];

/** RFC 4648 的字母表(`base64url` 与 `base64` 只差最后两个字符与填充)。 */
const B64_STANDARD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * 逐字节做 base64(不依赖 `btoa`,因为 `btoa` 只吃 latin1 字符串,
 * 而我们手上是任意字节 —— 直接把字节塞进 `String.fromCharCode` 再 `btoa`
 * 在 >255 或代理对上是**错的**)。
 *
 * @param bytes - 原始字节。
 * @param urlSafe - `true` ⇒ `+/` 换成 `-_` 并去掉 `=` 填充(RFC 4648 §5)。
 * @returns 编码后的字符串。
 */
function toBase64(bytes: Uint8Array, urlSafe: boolean): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64_STANDARD[b0 >> 2];
    out += B64_STANDARD[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 === undefined) {
      if (!urlSafe) {
        out += '==';
      }
      break;
    }
    out += B64_STANDARD[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 === undefined) {
      if (!urlSafe) {
        out += '=';
      }
      break;
    }
    out += B64_STANDARD[b2 & 0x3f];
  }
  return urlSafe ? out.replace(/\+/g, '-').replace(/\//g, '_') : out;
}

/** 逐字节做十六进制。 */
function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) {
    out += b.toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * 取 `size` 个密码学随机字节。
 *
 * ⚠️ **`crypto.getRandomValues` 的 `size` 上限是 65536**:超过就抛
 * `QuotaExceededError`。这里**分批**取,让「大 size」不至于变成一个
 * 只有在大文件上才出现的运行期异常。上游调用点是 8 字节,分批是防御,不是需求。
 *
 * @param size - 字节数。
 * @returns {@link IRandomBytes}(`NodeJS.Buffer` 的那个最小子集)。
 * @throws {Error} 浏览器不给 `crypto.getRandomValues` 时**抛**,不退化到 `Math.random()`
 *   —— 后者是可预测的,而这里的 id 会进 DOM。
 */
export function randomBytes(size: number): IRandomBytes {
  if (!Number.isInteger(size) || size < 0) {
    throw new TypeError(`randomBytes: size 必须是非负整数,收到 ${String(size)}`);
  }
  const globalCrypto = (globalThis as { crypto?: Crypto }).crypto;
  if (globalCrypto === undefined || typeof globalCrypto.getRandomValues !== 'function') {
    throw new Error('crypto.getRandomValues 在宿主里不可用 ⇒ 拒绝用 Math.random() 兜底(它可预测)');
  }
  const bytes = new Uint8Array(size);
  const CHUNK = 65_536;
  for (let offset = 0; offset < size; offset += CHUNK) {
    globalCrypto.getRandomValues(bytes.subarray(offset, Math.min(offset + CHUNK, size)));
  }
  return {
    toString(encoding: SupportedEncoding = 'base64url'): string {
      if (encoding === 'base64url') {
        return toBase64(bytes, true);
      }
      if (encoding === 'base64') {
        return toBase64(bytes, false);
      }
      if (encoding === 'hex') {
        return toHex(bytes);
      }
      throw new Error(
        `randomBytes().toString(${String(encoding)}) 在浏览器替身里没有实现;` +
          `已实现的是 ${SUPPORTED_ENCODINGS.join(' / ')}。`,
      );
    },
  };
}

/**
 * 一个 v4 UUID(`node:crypto.randomUUID` 的对应物)。
 *
 * 当前**没有调用方**(`grep -rn "randomUUID" src/client src/core` = 0 命中),
 * 放在这里是为了:一旦镜像里出现第二个 `node:crypto` 用法,它不必再改 alias 表。
 * 版本位与变体位照 RFC 4122 打,不是「随便填两个字节」。
 *
 * @returns `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`。
 */
export function randomUUID(): string {
  const bytes = new Uint8Array(16);
  const globalCrypto = (globalThis as { crypto?: Crypto }).crypto;
  if (globalCrypto === undefined || typeof globalCrypto.getRandomValues !== 'function') {
    throw new Error('crypto.getRandomValues 在宿主里不可用 ⇒ 拒绝用 Math.random() 兜底');
  }
  globalCrypto.getRandomValues(bytes);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = toHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

