/**
 * 静态闸门共用工具(零依赖,Node stdlib)。
 *
 * ## 为什么有这个模块
 *
 * 本仓库的静默缺陷有一个共同的形状:**规则在、但没生效**,而构建全绿。
 * `scripts/check-base-recipes.mjs`、`scripts/check-scope-roots.mjs`、
 * `scripts/check-sass-leaks.mjs`、`scripts/check-unreachable-ancestors.mjs`
 * 是同一个家族的四个探针,都用「读**编译产物**、按选择器/声明判定」这一套。
 * 把它们共同的部分放在这里,是为了让「编译产物怎么读」只有一份定义 ——
 * 这份定义错了会**同时**让四个探针失明(这本身就是一类静默失败)。
 *
 * ## 约定(每个闸门都遵守)
 *
 * - 只读仓库里的文件;**读不到就警告并跳过,绝不抛异常**(文件树会被多条线并发编辑);
 * - `--json` 时 stdout 必须是**纯 JSON**(警告一律走 stderr);
 * - 有已知债务的闸门用 `--write-baseline` 落一份棘轮基线;
 * - 退出码:0 = 干净或只有已登记债务;1 = 有未登记缺陷;2 保留给「连输入都读不到」。
 *
 * ## 已知盲区(所有探针共有)
 *
 * - 只看**编译产物里的选择器文本**:运行期拼出来的类名(`'gw-' + x`)看不见;
 * - 不跑浏览器:判定「能匹配」是静态近似,真正的布局仍需 `docs/goal-port-desktop.md` §5.5 的视觉通道;
 * - 生成物是 `src/client/desktop-diff-styles.generated.ts`,若那条线换了产物形状,
 *   `readCompiledCss()` 会**警告并返回空**,闸门会以「跳过」而不是「通过」结束。
 *
 * @module dsh-git/scripts/gates-lib
 */

import { readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根(由脚本位置反推,与 cwd 无关)。 */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 编译后的样式模块(生成物)。它是**所有** CSS 探针的输入。
 * 由 `scripts/styles.mjs` 写出,导出名见下。
 */
export const STYLE_MODULE = join(ROOT, 'src/client/desktop-diff-styles.generated.ts');

/** 生成物里 CSS 字符串的导出名(`scripts/styles.mjs` 的 `CSS_EXPORT_NAME`)。 */
export const CSS_EXPORT_NAME = 'DESKTOP_DIFF_CSS';

/** 移植面清单模块:作用域白名单与移植面入口都从它读(**只读,不修改**)。 */
const STYLES_MODULE = './styles.mjs';

/**
 * 仓库相对路径(统一 `/`)。
 * @param {string} p 绝对路径。
 * @returns {string} 仓库相对路径。
 */
export function rel(p) {
  return relative(ROOT, p).split(sep).join('/');
}

/**
 * 是否是普通文件(不抛)。
 * @param {string} p 路径。
 * @returns {Promise<boolean>} 是否普通文件。
 */
export async function isFile(p) {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

/**
 * 建一个「警告收集器」。所有闸门共用这个形状:
 * 立即写 stderr(人看得到),同时收进数组(进 `--json` 报告)。
 * @returns {{warn: (message: string) => void, warnings: string[], write: (prefix: string) => void}}
 */
export function createWarnings() {
  /** @type {string[]} */
  const warnings = [];
  return {
    warnings,
    warn(message) {
      warnings.push(message);
      process.stderr.write(`警告: ${message}\n`);
    },
    write(prefix) {
      for (const w of warnings) process.stderr.write(`${prefix}: 警告: ${w}\n`);
    },
  };
}

/**
 * 通用参数解析。未知参数只警告,不抛。
 * @param {string[]} argv 参数(不含 node 与脚本名)。
 * @param {string[]} flags 该闸门认识的开关(如 `['--json','--write-baseline']`)。
 * @param {(message: string) => void} warn 警告函数。
 * @returns {Record<string, boolean>} 开关 → 是否出现(`--help`/`-h` 恒有)。
 */
export function parseArgs(argv, flags, warn) {
  /**
   * `--write-baseline` → `writeBaseline`,与其他脚本里 `opts.writeBaseline` 的写法一致。
   * @param {string} flag 原始开关(如 `--write-baseline`)。
   * @returns {string} camelCase 键。
   */
  const keyOf = (flag) => flag.replace(/^--/, '').replace(/-([a-z])/g, (/** @type {string} */ _, c) => c.toUpperCase());
  /** @type {Record<string, boolean>} */
  const opts = { help: false };
  for (const flag of flags) opts[keyOf(flag)] = false;
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
      continue;
    }
    if (flags.includes(arg)) {
      opts[keyOf(arg)] = true;
      continue;
    }
    warn(`忽略未知参数: ${arg}`);
  }
  return opts;
}

/**
 * 读棘轮基线。文件不存在 / 读不到 / JSON 坏 / 形状不对 → **空基线 + 警告**,绝不抛。
 * @param {string} file 基线绝对路径。
 * @param {string} key 顶层键(如 `split`、`selectors`)。
 * @param {(message: string) => void} warn 警告函数。
 * @returns {Promise<Record<string, unknown>>} 键 → 值。
 */
export async function readBaseline(file, key, warn) {
  let text = null;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err)?.code !== 'ENOENT') {
      warn(`基线读取失败,按空基线处理: ${rel(file)} (${/** @type {NodeJS.ErrnoException} */ (err)?.code ?? err})`);
    }
    return {};
  }
  try {
    const parsed = JSON.parse(text);
    const bucket = parsed?.[key];
    if (bucket === null || typeof bucket !== 'object' || Array.isArray(bucket)) {
      warn(`基线格式不是 { "${key}": { ... } },按空基线处理: ${rel(file)}`);
      return {};
    }
    return bucket;
  } catch (err) {
    warn(`基线不是合法 JSON,按空基线处理: ${rel(file)} (${err instanceof Error ? err.message : String(err)})`);
    return {};
  }
}

/**
 * 读移植面清单(作用域白名单 + 每个面的入口)。
 * 读不到就退回 `null` 并警告 —— 调用方必须**报告「白名单未知」而不是假装通过**。
 * @param {(message: string) => void} warn 警告函数。
 * @returns {Promise<{scopes: string[], surfaces: {id: string, scope: string, entry: string}[]}|null>}
 */
export async function readPortSurfaces(warn) {
  try {
    const mod = await import(STYLES_MODULE);
    const surfaces = mod.PORT_SURFACES;
    if (!Array.isArray(surfaces) || surfaces.length === 0) throw new Error('PORT_SURFACES 不是非空数组');
    /** @type {{id: string, scope: string, entry: string}[]} */
    const out = [];
    for (const surface of surfaces) {
      if (surface === null || typeof surface !== 'object') continue;
      if (typeof surface.scope !== 'string' || typeof surface.entry !== 'string') continue;
      out.push({ id: String(surface.id ?? surface.scope), scope: surface.scope, entry: surface.entry });
    }
    if (out.length === 0) throw new Error('PORT_SURFACES 里没有可用的 { scope, entry }');
    return { scopes: out.map((s) => s.scope), surfaces: out };
  } catch (err) {
    warn(
      `读不到 scripts/styles.mjs 的 PORT_SURFACES(${err instanceof Error ? err.message : String(err)});` +
        '作用域白名单未知 —— 相关判定将跳过,不会假装通过',
    );
    return null;
  }
}

/**
 * 读**编译产物**里的 CSS 字符串。
 *
 * 生成物是一行 `export const DESKTOP_DIFF_CSS: string = "<JSON 字符串>";`,
 * 所以用「定位赋值 + 按 JSON 解码」而不是正则硬解转义。形状不符 → 警告 + null。
 * @param {string} file 生成物绝对路径。
 * @param {(message: string) => void} warn 警告函数。
 * @returns {Promise<string|null>} CSS 文本。
 */
export async function readCompiledCss(file, warn) {
  let raw = null;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    warn(`读不到编译产物: ${rel(file)} (${/** @type {NodeJS.ErrnoException} */ (err)?.code ?? err})`);
    return null;
  }
  const marker = `export const ${CSS_EXPORT_NAME}`;
  const at = raw.indexOf(marker);
  if (at === -1) {
    warn(`编译产物里找不到 \`${marker}\`(产物形状变了?): ${rel(file)}`);
    return null;
  }
  const eq = raw.indexOf('=', at);
  if (eq === -1) {
    warn(`编译产物的导出没有赋值: ${rel(file)}`);
    return null;
  }
  let i = eq + 1;
  while (i < raw.length && /\s/.test(raw[i])) i++;
  if (raw[i] !== '"') {
    warn(`编译产物的导出不是双引号字符串(形状变了?): ${rel(file)}`);
    return null;
  }
  const start = i;
  i++;
  while (i < raw.length) {
    const c = raw[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '"') break;
    i++;
  }
  if (i >= raw.length) {
    warn(`编译产物的字符串没有结束引号: ${rel(file)}`);
    return null;
  }
  try {
    return JSON.parse(raw.slice(start, i + 1));
  } catch (err) {
    warn(`编译产物里的字符串不是合法 JSON 字符串: ${rel(file)} (${err instanceof Error ? err.message : String(err)})`);
    return null;
  }
}

/**
 * 把 CSS 注释换成空格(**保留换行**,行号因此仍然有效),字符串字面量原样保留。
 * @param {string} src CSS 文本。
 * @returns {string} 等长文本。
 */
export function stripCssComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '*') {
      out += '  ';
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < n) {
        out += '  ';
        i += 2;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      out += c;
      i++;
      while (i < n) {
        out += src[i];
        if (src[i] === '\\') {
          out += src[i + 1] ?? '';
          i += 2;
          continue;
        }
        if (src[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** `@keyframes` / `@font-face` 等块:块内不是选择器,必须整体跳过。 */
const NON_SELECTOR_AT_RULES = ['@keyframes', '@-webkit-keyframes', '@-moz-keyframes', '@font-face', '@counter-style', '@property', '@page'];

/**
 * 抽「选择器组」。返回的每一项是一次规则的**选择器列表**(已按顶层逗号拆开),
 * 以及它在 CSS 文本里的 1 基行号。`@media` / `@container` / `@supports` 块内的规则照收
 * (`@keyframes` / `@font-face` 整体跳过)。
 * @param {string} css 已剥注释的 CSS。
 * @returns {{selectors: string[], line: number}[]} 选择器组。
 */
export function listSelectorGroups(css) {
  let text = css;
  // 挖空非选择器 at-rule 的整块(用空格保持长度不变,行号仍有效)
  for (const at of NON_SELECTOR_AT_RULES) {
    let idx = text.indexOf(at);
    while (idx !== -1) {
      const open = text.indexOf('{', idx);
      if (open === -1) break;
      let depth = 0;
      let i = open;
      for (; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}') {
          depth--;
          if (depth === 0) break;
        }
      }
      const blank = text.slice(idx, i + 1).replace(/[^\n]/g, ' ');
      text = text.slice(0, idx) + blank + text.slice(i + 1);
      idx = text.indexOf(at, idx + at.length);
    }
  }

  /** @type {{selectors: string[], line: number}[]} */
  const groups = [];
  let depth = 0;
  let buf = '';
  let line = 1;
  let bufLine = 1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\n') {
      line++;
      buf += c;
      continue;
    }
    if (c === '{') {
      if (depth === 0) {
        const prelude = buf.trim().replace(/\s+/g, ' ');
        if (prelude !== '' && !prelude.startsWith('@')) {
          groups.push({ selectors: splitTopLevelCommas(prelude), line: bufLine });
        }
      }
      depth++;
      buf = '';
      bufLine = line;
      continue;
    }
    if (c === '}') {
      depth = Math.max(0, depth - 1);
      buf = '';
      bufLine = line;
      continue;
    }
    if (depth === 0) {
      if (buf.trim() === '' && !/\s/.test(c)) bufLine = line;
      buf += c;
    }
  }
  return groups;
}

/**
 * 按**顶层**逗号切分选择器列表(忽略 `:is(a,b)` / `:not(a,b)` / 属性选择器里的逗号)。
 * @param {string} text 选择器列表。
 * @returns {string[]} 单条选择器(已 trim)。
 */
export function splitTopLevelCommas(text) {
  const out = [];
  let cur = '';
  let depth = 0;
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote !== null) {
      cur += c;
      if (c === '\\') {
        cur += text[++i] ?? '';
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth = Math.max(0, depth - 1);
    if (c === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur.trim());
  return out.filter((s) => s !== '');
}

/**
 * 抽一条选择器里的**类名**(跳过 `:not()` / `:has()` 内部 —— 那里的类不是「要求存在」)。
 * @param {string} selector 单条选择器。
 * @returns {string[]} 类名。
 */
export function classesInSelector(selector) {
  const stripped = selector.replace(/:(not|has)\((?:[^()]|\([^()]*\))*\)/g, ' ');
  const out = [];
  for (const m of stripped.matchAll(/\.(-?[A-Za-z_][A-Za-z0-9_-]*)/g)) {
    if (m[1].endsWith('-')) continue;
    out.push(m[1]);
  }
  return out;
}

/**
 * 抽一条选择器里的 **id**(跳过 `:not()` / `:has()`)。
 * @param {string} selector 单条选择器。
 * @returns {string[]} id 名(不含 `#`)。
 */
export function idsInSelector(selector) {
  const stripped = selector.replace(/:(not|has)\((?:[^()]|\([^()]*\))*\)/g, ' ');
  const out = [];
  for (const m of stripped.matchAll(/#(-?[A-Za-z_][A-Za-z0-9_-]*)/g)) {
    if (m[1].endsWith('-')) continue;
    out.push(m[1]);
  }
  return out;
}

/**
 * 把一条选择器按**顶层组合子**拆成「复合选择器」序列。
 * `>` / `+` / `~` 与后代空格都算组合子;`+`/`~` 的结果仍然是「前面的兄弟」,
 * 调用方对它们要求的祖先要更保守(见 `check-unreachable-ancestors.mjs` 的说明)。
 * @param {string} selector 单条选择器。
 * @returns {{compound: string, combinator: string}[]} 第一项的 combinator 为 `''`。
 */
export function splitCompounds(selector) {
  /** @type {{compound: string, combinator: string}[]} */
  const out = [];
  let cur = '';
  let depth = 0;
  let quote = null;
  let pendingCombinator = '';
  const flush = () => {
    const t = cur.trim();
    if (t !== '') out.push({ compound: t, combinator: pendingCombinator });
    cur = '';
  };
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i];
    if (quote !== null) {
      cur += c;
      if (c === '\\') {
        cur += selector[++i] ?? '';
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    if (c === '(' || c === '[') {
      depth++;
      cur += c;
      continue;
    }
    if (c === ')' || c === ']') {
      depth = Math.max(0, depth - 1);
      cur += c;
      continue;
    }
    if (depth === 0 && (c === '>' || c === '+' || c === '~')) {
      flush();
      pendingCombinator = c;
      continue;
    }
    if (depth === 0 && /\s/.test(c)) {
      if (cur.trim() !== '') {
        flush();
        pendingCombinator = ' ';
      }
      continue;
    }
    cur += c;
  }
  flush();
  return out;
}

/**
 * 统计一条选择器里每个**作用域根**出现了几次(按完整类名 token 匹配,
 * `.gw-split` 不会被 `.gw-split-x` 误计)。
 * @param {string} selector 单条选择器。
 * @param {string[]} scopes 作用域根白名单(如 `.gw-desktop-diff`)。
 * @returns {{scope: string, count: number}[]} 只含 count>0 的项。
 */
export function countScopeRoots(selector, scopes) {
  const out = [];
  for (const scope of scopes) {
    const cls = scope.startsWith('.') ? scope.slice(1) : scope;
    let count = 0;
    for (const m of selector.matchAll(/\.(-?[A-Za-z_][A-Za-z0-9_-]*)/g)) {
      if (m[1] === cls) count++;
    }
    if (count > 0) out.push({ scope, count });
  }
  return out;
}

/** 目录扩展名提示(给报告用)。 */
export const KNOWN_GENERATED = [join(ROOT, 'lib/index.js'), join(ROOT, 'lib/client.js'), STYLE_MODULE];
