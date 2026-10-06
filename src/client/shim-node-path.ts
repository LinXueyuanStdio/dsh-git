/**
 * `node:path` 的浏览器替身(通过 `scripts/build.mjs` 的 esbuild `alias` 接进来)。
 *
 * 为什么需要:镜像里 6 个**逐字复制**的 Desktop 文件 `import * as Path from 'path'`
 * (`models/repository.ts:1`、`models/cloning-repository.ts:1`、`ui/lib/path-text.tsx:2`、
 * `ui/diff/binary-file.tsx:2`、`ui/diff/syntax-highlighting/index.ts:1`、`lib/path.ts:1`),
 * 而浏览器半不能有 node 内置模块。
 *
 * 只实现这些文件真正用到的成员(`basename` / `dirname` / `extname` / `join` /
 * `normalize` / `resolve` / `relative` / `isAbsolute` / `sep` / `posix` / `win32`),
 * 语义按 **POSIX** —— git 输出的路径恒为 `a/b/c`,所以 POSIX 就是正确语义
 * (这条约定与 `lib/path-display.ts` 里的内联 POSIX helper 一致)。
 * @module dsh-git/client/shim-node-path
 */

const SEP = '/'

export function normalize(p: string): string {
  const absolute = p.startsWith(SEP)
  const out: string[] = []
  for (const segment of p.split(SEP)) {
    if (segment === '' || segment === '.') continue
    if (segment === '..' && out.length > 0 && out[out.length - 1] !== '..') {
      out.pop()
      continue
    }
    out.push(segment)
  }
  const joined = out.join(SEP)
  return absolute ? SEP + joined : joined === '' ? '.' : joined
}

export function basename(p: string, ext?: string): string {
  const end = p.endsWith(SEP) ? p.length - 1 : p.length
  const cut = p.lastIndexOf(SEP, end - 1)
  const base = p.slice(cut + 1, end)
  if (ext !== undefined && ext !== '' && base.endsWith(ext) && base !== ext) {
    return base.slice(0, base.length - ext.length)
  }
  return base
}

export function dirname(p: string): string {
  if (p === '') return '.'
  const end = p.endsWith(SEP) ? p.length - 1 : p.length
  const cut = p.lastIndexOf(SEP, end - 1)
  if (cut === -1) return '.'
  if (cut === 0) return SEP
  return p.slice(0, cut)
}

export function extname(p: string): string {
  const base = basename(p)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot)
}

export function join(...parts: string[]): string {
  const joined = parts.filter((x) => x !== '').join(SEP)
  return joined === '' ? '.' : normalize(joined)
}

/** 浏览器里没有 cwd;`resolve` 只做「拼起来 + 归一化 + 补前导 /」。 */
export function resolve(...parts: string[]): string {
  const joined = parts.filter((x) => x !== '').join(SEP)
  if (joined === '') return SEP
  const normalized = normalize(joined)
  return normalized.startsWith(SEP) ? normalized : SEP + normalized
}

export function relative(from: string, to: string): string {
  const a = resolve(from).split(SEP).filter(Boolean)
  const b = resolve(to).split(SEP).filter(Boolean)
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  const up = new Array(a.length - i).fill('..')
  return [...up, ...b.slice(i)].join(SEP)
}

export function isAbsolute(p: string): boolean {
  return p.startsWith(SEP)
}

export const sep = SEP

/** 上游代码里 `Path.posix` / `Path.win32` 只在 `lib/path.ts` 的安全守卫里出现。 */
export const posix = {
  basename,
  dirname,
  extname,
  join,
  normalize,
  resolve,
  relative,
  isAbsolute,
  sep: SEP,
}

export const win32 = posix

export default { basename, dirname, extname, join, normalize, resolve, relative, isAbsolute, sep, posix, win32 }
