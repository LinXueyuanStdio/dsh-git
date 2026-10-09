#!/usr/bin/env node
/**
 * 基础配方缺失检查(base-recipe check)—— 抓「类名在、规则不在」这种**静默样式缺失**。
 *
 * ## 1. 它防的是什么
 *
 * 本插件不是手写 CSS,而是把上游 GitHub Desktop 的 SCSS 按 **`@import` 闭包**编译进包:
 * 闭包的根**不再是写死的单个入口**,而是 `scripts/styles.mjs` 的 `PORT_SURFACES` 里
 * 每个移植面的 `entry` 的并集(见 `computeClosureRoots()`)。**必须跟着真实构建走** ——
 * 写死单入口的那一版在仓库列表移植面接线后把 34 个类误报成「配方缺失」(2026-10)。
 * 于是有一类缺陷,现有的三道守卫**全都抓不到**:
 *
 *   某个类在**包内**只有一条**覆盖**规则(例如 `user-select: none`),
 *   而它真正的**基础配方**(定位 / 尺寸 / 裁剪 / 布局)写在上游某个**没有被 import**
 *   的 partial 里。
 *
 * 构建不报错(类名合法);`scripts/build.mjs` 的类名覆盖自检查的是「类名**存在**」——
 * 而它确实存在;`checkInlineTokens()` 只管 `--dsw-alias-*`。三道全绿,界面却是坏的。
 * 教训:**「类名存在」不等于「那条规则生效」。**
 *
 * ## 2. 动机案例:`.sr-only`(这个 bug 真的出过)
 *
 * 上游 `styles/ui/_side-by-side-diff.scss:20` 里只有一条覆盖
 * `.sr-only { user-select: none }`;真正的基础配方在
 * `styles/ui/_app.scss:115-123`:
 *
 *     clip: rect(0 0 0 0); clip-path: inset(50%); height: 1px;
 *     overflow: hidden; position: absolute; white-space: nowrap; width: 1px;
 *
 * `_app.scss` 是 Desktop 的**整个应用外壳**,不在闭包(也不该在)里。结果
 * `ui/diff/side-by-side-diff-row.tsx:646-649` 的
 * `<span className="sr-only">Lines N to M Added</span>` 以**可见文本**渲染、
 * 在窄列里折行,把行号格撑开 —— gutter 竖着堆叠、每条 diff 行变成正常高度的 2–3 倍。
 * 修复:在 `desktop-diff.scss` 里抽出 `@mixin sr-only-recipe` 就地补配方,并复用到
 * `.gw-desktop-diff`(diff 行)与 `.gw-split`(`AriaLiveContainer`)两处。
 *
 * 本脚本把「包内只有覆盖、配方在闭包之外」的类单独列成 **split** 桶并让运行失败
 * (除非它在基线里,见 §5)。这正是历史审计一次性找出 23 个 split 类的方法。
 *
 * ## 3. 已知限制:`&` 嵌套(SCSS nesting)
 *
 * 上游 ~50 个 partial 里 `&` 出现 600+ 次(`&-item` / `&.vertical` / `&:hover` …)。
 * 朴素的 `\.class` 正则**看不见** `&-suffix`:`.tab-bar { &-item {} }` 生成
 * `.tab-bar-item`,但正则只看到 `.tab-bar`。本脚本实现了一个**带父选择器栈的
 * 选择器解析器**,能正确展开绝大多数 `&`:
 *
 *   - `.tab-bar { &-item {} }`            → `.tab-bar-item`(被正确归位,不再算 orphan)
 *   - `.tab-bar { &.tabs &-item {} }`     → `.tab-bar.tabs .tab-bar-item`
 *   - `@media` / `@include` / `@if` 等**透明** at-rule:父选择器原样穿透;
 *   - `@mixin` / `@keyframes` / `@at-root` 等**屏障** at-rule:块内的 `&` 是
 *     **include 现场**的选择器,静态解析不出来 —— 这类选择器**不静默丢弃**,而是
 *     记进 `unresolved` 桶(见 §4 的 `unresolved`)。
 *
 * 也就是说「无法解析」会被**显式报告**,不会假装那个类不存在。仍然存在两个已知盲区:
 *   1. `#{$var}` 插值类名(如 `.octicon-#{$name}`):静态前缀不予采信,直接跳过;
 *   2. 只通过 `@extend` / 运行时拼字符串产生的类名,静态索引看不见。
 *
 * ## 4. 四个桶(每个活跃类**恰好**落一个)
 *
 * 「活跃」= 从**浏览器半的 esbuild 入口**(`src/client/index.ts` + `src/client/diff-ui.ts`,
 * 见 `scripts/build.mjs`)沿**相对 import** 可达的模块;纯类型导入(`import type …`)不算,
 * 所以 `src/core/desktop` 里「移植过来但还没接线」的组件不会污染结果(不可达的模块数会
 * 在报告里列出来)。类名证据分两级:`className=`/`classNames(...)` 一类**语法上就是类名**
 * 的上下文(strong,单字类名只在这里采信),以及 `.tsx` 里 kebab-case 且 CSS 里真的出现的
 * 裸字符串(loose);模板字面量 `${...}` 里比较运算符右侧的字符串是状态值,不算类名。
 *
 *   - `ok`         —— 有上游规则,且定义它的文件都在闭包内;
 *                     或者闭包内有一份**本插件自己写的基础配方**(local compensation,
 *                     例如 `desktop-diff.scss` 里的 `@mixin sr-only-recipe`)。
 *                     后者会额外进 `ok(local)` 复核列表。
 *   - `split`      —— **危险桶**:有上游规则**落在闭包之外**,而包内只有覆盖
 *                     (或根本没有),且我们**没有**就地补配方。= 下一个 `.sr-only`。
 *   - `orphan`     —— 活跃代码里用到,但**上游任何地方都没有这条规则**。
 *                     细分:`ours`(我们自己写了样式,典型是 `gw-*`)/
 *                     `bare`(连我们也没写 —— 上游也没有,通常无害,但值得看一眼:
 *                     `.add`/`.del` 就是这样被抓出来的死类名)。
 *   - `unresolved` —— 上游**可能有**这条规则,但因为 `&` 嵌套解析不出来,归属无法判定。
 *
 * 优先级:`split` > `unresolved`:只要已知有配方在闭包外,就是 split;`unresolved`
 * 只留给「连一条能归位的上游规则都没有」的类。注意 `split` 的 `inside` 允许为空
 * (`&-item` 这类整张表都没进闭包时,连覆盖都不在包里),它和「只有覆盖」是同一个 bug
 * 的两个阶段。
 *
 * ## 4.5 闭包之外的规则**到底算不算缺口**(2026-10 加的三道过滤器)
 *
 * 旧判据是「只要**闭包外存在**这条类的规则 ⇒ split」。它有一个结构性的误报源:
 * 泛用类名(`.list` / `.label` / `.panel` / `.selected` / `.header` …)在上游几十个
 * **我们根本不渲染的界面**(dialog / commit-list / account-picker / 宿主窗口)里也有规则。
 * 2026-10 仓库列表移植面接进 live 图后,这一源一口气爆出 **34 条假 split**。
 * 现在闭包外的定义要连过三道过滤器,才算是「我们缺的配方」:
 *
 *   A. **`:not()` / `:has()` 不算定义**(`classNamesInSelector`):`&:not(.x):hover` 不是在定义 `.x`。
 *   B. **规则必须可能匹配我们的 DOM**(`ruleCouldMatchUs`):选择器里要求的**每个类名**都要在
 *      live 类集里、**每个 id** 都要在 live id 集里。`dialog#choose-branch .dialog-content .list-item`
 *      要求的 `#choose-branch` 我们永不渲染 ⇒ 那条规则永远匹配不到我们,不是缺口。
 *   C. **闭包外必须真的缺一件结构性配方**(`rulePropertiesAt` + `isStructuralProperty`):
 *      把闭包内 / 外各自声明的属性求并集,只有「闭包外声明了、闭包内没有」的
 *      **定位/尺寸/裁剪/布局**属性才算缺口。`dialog .dialog-content .row-component:not(:last-child){margin-bottom}`
 *      只是边距覆盖,而 `.row-component` 的配方在闭包内 ⇒ 不算。
 *
 * 三道过滤器一起把 split 从 83 降到 22(其中 20 条已登记基线,2 条**真缺口**)。
 * **必须记住的反例**:`.sr-only` 那次三条全过 —— 裸 `.sr-only`(A/B 过)、
 * 闭包外声明 `clip/clip-path/position/width/height/overflow/white-space` 而闭包内只有
 * `user-select: none`(C 过)⇒ 仍然判 split。**不要把这三道过滤器当成放宽。**
 *
 * 已知限制(除了 §3 的 `&` 解析):**元素选择器祖先**不参与 B 的判定
 * (`dialog .foo` 里的 `dialog`、`body > .tooltip` 里的 `body` 看不见),
 * 所以「要求某个 HTML 元素祖先」的规则会被当成可用 —— 方向是**更严**(可能多报),
 * 而不是漏报。`.label` / `.list-item-tooltip` 今天就是靠这条被正确地留在失败里。
 *
 * ## 5. 这是**棘轮(ratchet)**,一开始不是硬门禁
 *
 * 读 `scripts/base-recipes-baseline.json`(若存在):`{ "split": { "<class>": "<理由>" } }`。
 * 基线里登记过的 split 类报为 `known`,**不让本次运行失败**(退出码仍为 0),
 * 于是可以先落地、再逐个修。运行 `--write-baseline` 用**当前** split 集合重写基线,
 * 把现状钉住 —— 之后任何**新增**的 split 都会失败。这就是棘轮。
 *
 * 用法:
 *
 *     node scripts/check-base-recipes.mjs                 # 人读报告
 *     node scripts/check-base-recipes.mjs --json          # 机器可读(stdout 是纯 JSON)
 *     node scripts/check-base-recipes.mjs --write-baseline # 用当前 split 集合重写基线
 *
 * 退出码:0 = 没有未登记的 split;1 = 有未登记的 split。
 * 健壮性:整棵文件树可能被其它 agent 并发编辑 —— 任何文件读不到/导入解析不到都只
 * **跳过并警告**,绝不抛异常。
 *
 * @module dsh-git/scripts/check-base-recipes
 */

import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// 常量:根目录、上游、闭包入口、活跃代码
// ---------------------------------------------------------------------------

/** 仓库根(从脚本位置反推,与 cwd 无关)。 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/*
 * 上游样式表根 —— **已移植进本仓库**,不是外部 checkout。
 *
 * `src/client/scss/upstream/**` 与 `references/desktop/app/styles/**` 逐字节相同
 * (183 个文件,移植手法同 `references/desktop/app/src/X → src/core/desktop/X`)。
 * 本闸门要判「配方在上游、但在我们的 @import 闭包之外」,所以它需要**完整**的上游
 * 样式表,而不只是被 import 的那 60 个 partial —— 这也正是当初整棵移植的理由。
 *
 * 本块刻意用 `/*` 而不是 JSDoc 的斜杠星号开头,理由是一个实测陷阱:
 * 多行 JSDoc 里**裸写** @import 时,TypeScript 会把它当成未知 JSDoc 标签去解析后面的
 * 文本,于是紧跟其后的全角右书名号会报 `TS1127: Invalid character`(最小复现:两行
 * JSDoc,第二行「见 @import 闭包」后接全角右书名号)。JSDoc 里给 @import 加反引号也能
 * 绕开,但最容易懂的做法是这一块干脆不用 JSDoc —— 那会让 `check-scripts-types.mjs`
 * 多出一条本来不存在的指纹:**注释也能弄红闸门**。
 *
 * 另有两条硬约束:
 *  - 不要再指回 `references/desktop/app` 或 `vendor/**` —— `.gitignore:221/224` 把两者
 *    都排除了,CI 检出里不存在,闸门会以「上游一个都没找到」的警告退化成假绿;
 *  - 本注释里**不能出现**结束注释的星号斜杠序列(写了就会提前关掉这一块,后面全变代码)。
 */
const UPSTREAM_ROOT = join(ROOT, 'src/client/scss/upstream');

/** 上游 SCSS 根:报告里用它把绝对路径缩短成 `ui/_app.scss`。 */
const UPSTREAM_PREFIX = 'src/client/scss/upstream/';

/**
 * 闭包入口的**兜底**值。
 *
 * 正常路径**不走这里**:真正的入口从 `scripts/styles.mjs` 的 `PORT_SURFACES` 读
 * (见 `computeClosureRoots()`),这样 build 每新增一个移植面,本检查自动跟上,
 * 不需要有谁记得改这个常量。
 *
 * 为什么必须改成「跟着构建走」(2026-10 实证):本常量曾写死 `desktop-diff.scss`,
 * 而同一时刻 `PORT_SURFACES` 已编译 **3** 个面。仓库列表面接进 live 图后,
 * `split` 从 49 涨到 **83**,其中 34 条**全部**是「闭包压根不含仓库列表 SCSS」造成的
 * **假 split** —— 一个写死的常量把「另一个面的类」报成了「配方缺失」。
 * 这正是本仓库反复付代价的那一类:检查跟着常量走,而不是跟着真实构建走。
 */
const CLOSURE_ROOT_FALLBACK = join(ROOT, 'src/client/scss/desktop-diff.scss');

/** 移植面清单模块(只读;它由 build/styles 那条线持有,这里只 import 它的表)。 */
const STYLES_MODULE = './styles.mjs';

/** 活跃模块:类名实际被使用的地方。 */
const LIVE_ROOTS = [join(ROOT, 'src/core/desktop'), join(ROOT, 'src/client')];

/**
 * 活跃**入口** = `scripts/build.mjs` 里浏览器半的 esbuild 入口。
 * 活跃代码 = 从这些入口沿**相对 import** 可达的模块 —— 这样 `src/core/desktop` 里
 * 「移植过来但还没接线」的组件(对话框、list、text-box、tooltip…)不会污染结果。
 */
export const LIVE_ENTRIES = [join(ROOT, 'src/client/index.ts'), join(ROOT, 'src/client/diff-ui.ts')];

/** 我们自己的样式源:SCSS + TS 里的 CSS 模板(用于「本插件是否就地补了配方」)。 */
const LOCAL_SCSS_ROOT = join(ROOT, 'src/client/scss');
const LOCAL_TS_ROOT = join(ROOT, 'src/client');

/** 基线(棘轮)文件。 */
const BASELINE_PATH = join(ROOT, 'scripts/base-recipes-baseline.json');

/** 生成物:不参与「本地配方」判定,也不参与类名采集(它是闭包的编译结果)。 */
const GENERATED_RE = /\.generated\.(ts|tsx)$/;

/** 纯样式定义文件:它们是 CSS,不是**使用**现场,所以不进活跃类清单。 */
const STYLE_ONLY_RE = /^(styles|styles-base|desktop-diff-styles)\.ts$/;

/** 一个 token 要像 CSS 类名才可能是类名。 */
const CLASS_TOKEN_RE = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;

/** `#{...}` 插值占位符(命中即视为动态类名,不采信)。 */
const DYN = '\u0001';

/** 透明 at-rule:块内选择器仍以**外层选择器**为父。 */
const TRANSPARENT_AT_RULES = new Set([
  'media',
  'supports',
  'include',
  'if',
  'else',
  'each',
  'for',
  'while',
  'container',
  'layer',
  'scope',
  'document',
  'starting-style',
]);

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 运行期收集的警告(并发编辑导致的读失败等),最后统一打印。 */
const warnings = [];

/**
 * 记一条警告(立即写 stderr,同时进报告)。绝不抛异常。
 * @param {string} message 内容。
 */
function warn(message) {
  warnings.push(message);
  process.stderr.write(`dsh-git/check-base-recipes: 警告: ${message}\n`);
}

/** 仓库相对路径(统一 `/`)。 */
function rel(p) {
  return relative(ROOT, p).split(sep).join('/');
}

/** 报告里用的短路径。 */
function shortPath(p) {
  const r = rel(p);
  if (r.startsWith(UPSTREAM_PREFIX)) return r.slice(UPSTREAM_PREFIX.length);
  if (r.startsWith('src/')) return r.slice(4);
  return r;
}

/** 计换行数。 */
function countNewlines(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

/**
 * 读文件;失败只警告并返回 null。
 * @param {string} file 绝对路径。
 * @returns {Promise<string|null>} 内容或 null。
 */
async function readIfExists(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    warn(`读取失败,已跳过: ${rel(file)} (${err?.code ?? err})`);
    return null;
  }
}

/** 是否是普通文件(不抛)。 */
export async function isFile(p) {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

/**
 * 递归列文件(不抛)。
 * @param {string} root 根目录。
 * @param {string[]} exts 后缀白名单。
 * @param {RegExp} [exclude] 文件名排除。
 * @returns {Promise<string[]>} 排序后的绝对路径。
 */
export async function listFiles(root, exts, exclude) {
  const out = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        await walk(full);
      } else if (exts.some((x) => entry.name.endsWith(x))) {
        if (exclude && exclude.test(entry.name)) continue;
        out.push(full);
      }
    }
  }
  await walk(root);
  out.sort();
  return out;
}

/**
 * 按**顶层**分隔符切分(忽略括号/方括号/字符串内部)。
 * @param {string} text 输入。
 * @param {string} separator 单字符分隔符。
 * @returns {string[]} 片段。
 */
function splitTopLevel(text, separator) {
  const parts = [];
  let depth = 0;
  let cur = '';
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote !== null) {
      cur += c;
      if (c === '\\') {
        if (i + 1 < text.length) cur += text[++i];
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
    if (c === separator && depth === 0) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  return parts;
}

// ---------------------------------------------------------------------------
// SCSS:注释剥离 / @import 扫描 / 选择器解析
// ---------------------------------------------------------------------------

/**
 * 把注释替换成空格(**保留换行**,行号因此仍然有效),字符串原样保留。
 * @param {string} src 源文本。
 * @returns {string} 等长文本。
 */
export function stripScssComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }
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
      out += c;
      i++;
      while (i < n) {
        if (src[i] === '\\') {
          out += src[i] + (src[i + 1] ?? '');
          i += 2;
          continue;
        }
        out += src[i];
        if (src[i] === c) {
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

/**
 * 找出 SCSS 里的 `@import` / `@use` / `@forward` **指令**(字符串内部的同名字样不算)。
 * @param {string} clean 已去注释的文本。
 * @returns {{kind: string, line: number, body: string}[]} 指令列表。
 */
function findScssImports(clean) {
  const out = [];
  let i = 0;
  let line = 1;
  const n = clean.length;
  let quote = null;
  while (i < n) {
    const c = clean[i];
    if (c === '\n') {
      line++;
      i++;
      continue;
    }
    if (quote !== null) {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      i++;
      continue;
    }
    if (c === '@') {
      const m = /^@(import|use|forward)\b/.exec(clean.slice(i, i + 16));
      const prev = i > 0 ? clean[i - 1] : '';
      if (m && !/[A-Za-z0-9_$-]/.test(prev)) {
        let j = i + m[0].length;
        while (j < n && clean[j] !== ';' && clean[j] !== '{') j++;
        const body = clean.slice(i + m[0].length, j);
        out.push({ kind: m[1], line, body });
        line += countNewlines(body);
        i = j;
        continue;
      }
    }
    i++;
  }
  return out;
}

/**
 * 从选择器文本里抽 **id**(`#foo`)。与 `classNamesInSelector` 同规则:跳过 `#{$var}`、
 * 跳过 `:not()` / `:has()` 内部(id 不是「定义」)。
 * @param {string} selector 选择器文本。
 * @returns {string[]} id 名(不含 `#`)。
 */
function idsInSelector(selector) {
  const text = selector.replace(/#\{[^}]*\}/g, DYN);
  const stripped = text.replace(/:(not|has)\((?:[^()]|\([^()]*\))*\)/g, ' ');
  const out = [];
  const re = /#(-?[A-Za-z_][A-Za-z0-9_-]*)/g;
  let m;
  while ((m = re.exec(stripped)) !== null) {
    if (stripped[m.index + m[0].length] === DYN) continue;
    if (m[1].endsWith('-')) continue;
    out.push(m[1]);
  }
  return out;
}

/**
 * 「结构属性」= 本脚本所说的**配方**(定位 / 尺寸 / 裁剪 / 布局 / 截断)。
 * 判据来自文件头 §2 对 `.sr-only` 那次事故的描述:缺失的是
 * `clip / clip-path / height / overflow / position / white-space / width`,
 * 而包内当时**只有**一条覆盖 `user-select: none`。
 * 颜色 / 字体 / margin-padding 之类的**覆盖**不算配方。
 * @param {string} name 属性名(小写,不含 `--` 自定义属性)。
 * @returns {boolean} 是否结构性。
 */
function isStructuralProperty(name) {
  if (name === 'position' || name === 'z-index' || name === 'float' || name === 'clear') return true;
  if (name === 'top' || name === 'right' || name === 'bottom' || name === 'left' || name === 'inset') return true;
  if (name === 'display' || name === 'order' || name === 'gap' || name === 'row-gap' || name === 'column-gap') return true;
  if (name === 'width' || name === 'height' || name === 'box-sizing' || name === 'aspect-ratio') return true;
  if (name.startsWith('min-') || name.startsWith('max-')) return true;
  if (name === 'overflow' || name === 'overflow-x' || name === 'overflow-y') return true;
  if (name === 'clip' || name === 'clip-path') return true;
  if (name === 'white-space' || name === 'text-overflow') return true;
  if (name === 'word-break' || name === 'overflow-wrap' || name === 'word-wrap') return true;
  if (name === 'flex' || name.startsWith('flex-')) return true;
  if (name === 'grid' || name.startsWith('grid-')) return true;
  if (name.startsWith('align-') || name.startsWith('justify-') || name.startsWith('place-')) return true;
  if (name.startsWith('column')) return true;
  return false;
}

/** SCSS 文本缓存(本进程只跑一次,但仍避免同一文件被反复读)。 */
const scssTextCache = new Map();

/**
 * 读 SCSS 并剥注释(带缓存)。读不到返回 null(不抛)。
 * @param {string} file 绝对路径。
 * @returns {Promise<string|null>} 剥注释后的文本。
 */
async function readScssCached(file) {
  if (scssTextCache.has(file)) return scssTextCache.get(file);
  const text = await readIfExists(file);
  const clean = text === null ? null : stripScssComments(text);
  scssTextCache.set(file, clean);
  return clean;
}

/**
 * 取「某个定义点所在行开始的那个规则块」在**第一层**声明的属性名集合。
 * 嵌套块里的声明不算(它们属于嵌套选择器)。
 * @param {string} file 绝对路径。
 * @param {number} line 1 基行号(与 `indexScss` 记录的一致)。
 * @returns {Promise<Set<string>>} 属性名(小写;跳过 `--custom-prop` 与 `@include` 等)。
 */
async function rulePropertiesAt(file, line) {
  /** @type {Set<string>} */
  const props = new Set();
  const clean = await readScssCached(file);
  if (clean === null) return props;
  let start = 0;
  for (let n = 1; n < line; n++) {
    const nl = clean.indexOf('\n', start);
    if (nl === -1) return props;
    start = nl + 1;
  }
  const open = clean.indexOf('{', start);
  if (open === -1) return props;
  let depth = 0;
  let body = '';
  for (let i = open; i < clean.length; i++) {
    const c = clean[i];
    if (c === '{') {
      depth++;
      if (depth === 1) continue;
    } else if (c === '}') {
      depth--;
      if (depth === 0) break;
    }
    if (depth === 1) body += c;
  }
  for (const decl of body.split(';')) {
    const t = decl.trim();
    if (t === '' || t.startsWith('@')) continue;
    const idx = t.indexOf(':');
    if (idx === -1) continue;
    const name = t.slice(0, idx).trim().toLowerCase();
    if (name === '' || name.startsWith('--')) continue;
    if (!/^[a-z][a-z0-9-]*$/.test(name)) continue;
    props.add(name);
  }
  return props;
}

/**
 * 解析一条 `@import`/`@use` 的说明符到实际文件(支持 `_name.scss` / `name.scss` /
 * `dir/_index.scss` / `dir/index.scss`)。
 * @param {string} importer 导入方文件绝对路径。
 * @param {string} spec 说明符(不含引号)。
 * @returns {Promise<string[]>} 命中的候选文件(通常 1 个)。
 */
async function resolveScssImport(importer, spec) {
  const base = resolve(dirname(importer), spec);
  const dir = dirname(base);
  const name = base.slice(dir.length + 1);
  const candidates = [
    join(dir, `_${name}.scss`),
    join(dir, `${name}.scss`),
    join(base, '_index.scss'),
    join(base, 'index.scss'),
  ];
  const found = [];
  for (const candidate of candidates) {
    if (await isFile(candidate)) found.push(candidate);
  }
  return found;
}

/**
 * 计算 `@import`/`@use` 闭包。注释里的 `@import` 不算(这个 bug 出过一次)。
 * 读不到的文件跳过并警告,绝不抛。
 * @param {string} rootFile 入口文件。
 * @returns {Promise<Map<string, string[]>>} 绝对路径 → 它导入的说明符。
 */
export async function computeClosure(rootFile) {
  /** @type {Map<string, string[]>} */
  const closure = new Map();
  const queue = [rootFile];
  while (queue.length > 0) {
    const file = queue.pop();
    if (closure.has(file)) continue;
    const text = await readIfExists(file);
    if (text === null) {
      closure.set(file, []);
      continue;
    }
    const specs = [];
    for (const directive of findScssImports(stripScssComments(text))) {
      for (const piece of splitTopLevel(directive.body, ',')) {
        const m = /['"]([^'"]+)['"]/.exec(piece);
        if (m === null) continue;
        const spec = m[1];
        if (spec.startsWith('sass:') || /^[a-z]+:\/\//i.test(spec)) continue;
        specs.push(spec);
      }
    }
    closure.set(file, specs);
    for (const spec of specs) {
      const resolved = await resolveScssImport(file, spec);
      if (resolved.length === 0) {
        warn(`导入解析不到,跳过: ${rel(file)} → '${spec}'`);
        continue;
      }
      for (const target of resolved) if (!closure.has(target)) queue.push(target);
    }
  }
  return closure;
}

/**
 * 闭包根 = `scripts/styles.mjs` 的 `PORT_SURFACES` 里每个面的 `entry`,去重。
 *
 * 这是本检查与**真实构建**之间的唯一耦合点,刻意做成动态读取:
 *  - 读不到模块 / 表是空的 / 表结构不符 → 退回 `CLOSURE_ROOT_FALLBACK` 并**警告**
 *    (仓库被多条线并发编辑,不能因为别人的文件暂时改坏就抛异常);
 *  - 永远不缓存、不写死,`--json` 报告里会打印本次真正用到的根。
 * @returns {Promise<string[]>} 绝对路径(排序,便于报告稳定)。
 */
export async function computeClosureRoots() {
  try {
    const mod = await import(STYLES_MODULE);
    const surfaces = mod.PORT_SURFACES;
    if (!Array.isArray(surfaces) || surfaces.length === 0) {
      throw new Error('PORT_SURFACES 不是非空数组');
    }
    /** @type {string[]} */
    const roots = [];
    for (const surface of surfaces) {
      if (surface === null || typeof surface !== 'object' || typeof surface.entry !== 'string') {
        warn('PORT_SURFACES 里有一条表项没有 entry,已跳过');
        continue;
      }
      const abs = resolve(ROOT, surface.entry);
      if (!roots.includes(abs)) roots.push(abs);
    }
    if (roots.length === 0) throw new Error('PORT_SURFACES 里没有可用的 entry');
    roots.sort();
    return roots;
  } catch (err) {
    warn(
      `读不到 ${STYLES_MODULE} 的 PORT_SURFACES(${err?.message ?? err});` +
        `退回单入口 ${rel(CLOSURE_ROOT_FALLBACK)} —— 多移植面时结果可能偏严`,
    );
    return [CLOSURE_ROOT_FALLBACK];
  }
}

/**
 * 从选择器文本里抽类名。
 * @param {string} selector 选择器文本。
 * @returns {string[]} 类名(跳过 `#{...}` 动态类名与悬空 `-` 前缀)。
 */
function classNamesInSelector(selector) {
  const text = selector.replace(/#\{[^}]*\}/g, DYN);
  /*
   * `:not()` / `:has()` 里的类名**不是**这条规则的定义。
   * 实证(2026-10):`_list.scss:108` 的 `&:not(.not-selectable):hover` 被算成
   * `.not-selectable` 的**包内定义**,于是 `.not-selectable` 的 inside/outside 归属整个错位;
   * `_commit-drag-element.scss:43` 的 `&:not(.in-keyboard-insertion-mode) .commit-box .count`
   * 被算成它的一条**上游定义**,让一个本来完全无关的类变成 split。
   * `:is()` / `:where()` 保留(那里面是可以匹配的候选)。
   */
  const stripped = text.replace(/:(not|has)\((?:[^()]|\([^()]*\))*\)/g, ' ');
  const out = [];
  const re = /\.(-?[A-Za-z_][A-Za-z0-9_-]*)/g;
  let m;
  while ((m = re.exec(stripped)) !== null) {
    const name = m[1];
    if (stripped[m.index + m[0].length] === DYN) continue; // .octicon-#{$name} → 动态
    if (name.endsWith('-')) continue;
    out.push(name);
  }
  return out;
}

/**
 * 把一个选择器列表按父选择器展开(处理 `&` / `&-suffix`)。
 * @param {string} text 选择器列表(逗号分隔)。
 * @param {string[]|null} parentSelectors 父选择器(空/null = 根或屏障)。
 * @returns {{selectors: string[], tainted: boolean}} 展开结果;tainted = 有 `&` 无法归位。
 */
function resolveSelectorList(text, parentSelectors) {
  const selectors = [];
  let tainted = false;
  const hasParent = Array.isArray(parentSelectors) && parentSelectors.length > 0;
  for (const raw of splitTopLevel(text, ',')) {
    const s = raw.replace(/\s+/g, ' ').trim();
    if (s === '') continue;
    if (!s.includes('&')) {
      if (!hasParent) selectors.push(s);
      else for (const p of parentSelectors) selectors.push(`${p} ${s}`.replace(/\s+/g, ' ').trim());
      continue;
    }
    if (!hasParent) {
      tainted = true;
      continue;
    }
    for (const p of parentSelectors) {
      selectors.push(s.split('&').join(p).replace(/\s+/g, ' ').trim());
    }
  }
  return { selectors, tainted };
}

/**
 * 索引一个 SCSS/CSS 文本:类名 → 定义位置(行号),以及无法归位的 `&` 选择器。
 * @param {string} text 文本。
 * @param {string} file 所属文件(绝对路径,仅作标记)。
 * @param {number} [lineOffset] 行号偏移(用于从 TS 模板字面量里切出来的 CSS)。
 * @returns {{defs: Map<string, {file: string, line: number, selector: string}[]>, unresolved: {file: string, line: number, selector: string, classes: string[]}[]}}
 */
export function indexScss(text, file, lineOffset = 0) {
  const clean = stripScssComments(text);
  /** @type {Map<string, {file: string, line: number, selector: string}[]>} */
  const defs = new Map();
  /** @type {{file: string, line: number, selector: string, classes: string[]}[]} */
  const unresolved = [];
  /** 选择器栈;根上下文 selectors=null(无父,`&` 无法归位)。 */
  const stack = [{ selectors: null }];
  let buf = '';
  let line = 1 + lineOffset;
  let bufLine = line;
  let i = 0;
  const n = clean.length;

  /**
   * 记一条「类名 → 定义点」。`selector` 是**已展开父选择器**的完整选择器文本,
   * 用于判断这条规则**是否可能匹配本插件的 DOM**(见 main 里的 `ruleCouldMatchUs`)。
   * @param {string} name 类名。
   * @param {number} ln 行号。
   * @param {string} selector 完整选择器。
   */
  const pushDef = (name, ln, selector) => {
    let arr = defs.get(name);
    if (arr === undefined) {
      arr = [];
      defs.set(name, arr);
    }
    if (!arr.some((d) => d.line === ln)) arr.push({ file, line: ln, selector });
  };

  while (i < n) {
    const c = clean[i];

    if (c === '\n') {
      line++;
      buf += c;
      i++;
      continue;
    }

    // `#{...}` 插值:整段吞掉,内部的 `}` 不是块结束。
    if (c === '#' && clean[i + 1] === '{') {
      let depth = 0;
      let j = i + 1;
      for (; j < n; j++) {
        if (clean[j] === '{') depth++;
        else if (clean[j] === '}') {
          depth--;
          if (depth === 0) {
            j++;
            break;
          }
        }
      }
      const chunk = clean.slice(i, j);
      if (buf.trim() === '') bufLine = line;
      buf += chunk;
      line += countNewlines(chunk);
      i = j;
      continue;
    }

    if (c === '{') {
      const prelude = buf.trim();
      const startLine = bufLine;
      buf = '';
      bufLine = line;
      const parent = stack[stack.length - 1];
      let ctx;
      if (prelude.startsWith('@')) {
        const at = (prelude.slice(1).match(/^[-\w]+/) ?? [''])[0].toLowerCase();
        ctx = TRANSPARENT_AT_RULES.has(at) ? { selectors: parent.selectors } : { selectors: [] };
      } else if (prelude === '') {
        ctx = { selectors: [] };
      } else {
        const resolved = resolveSelectorList(prelude, parent.selectors);
        ctx = { selectors: resolved.selectors };
        for (const selector of resolved.selectors) {
          for (const name of classNamesInSelector(selector)) pushDef(name, startLine, selector);
        }
        if (resolved.tainted) {
          unresolved.push({
            file,
            line: startLine,
            selector: prelude.replace(/\s+/g, ' ').trim(),
            classes: classNamesInSelector(prelude),
          });
        }
      }
      stack.push(ctx);
      i++;
      continue;
    }

    if (c === '}') {
      if (stack.length > 1) stack.pop();
      buf = '';
      bufLine = line;
      i++;
      continue;
    }

    if (c === ';') {
      buf = '';
      bufLine = line;
      i++;
      continue;
    }

    if (buf.trim() === '' && !/\s/.test(c)) bufLine = line;
    buf += c;
    i++;
  }

  return { defs, unresolved };
}

// ---------------------------------------------------------------------------
// 本插件自己的样式(SCSS + TS 里的 CSS 模板)
// ---------------------------------------------------------------------------

/**
 * 抽 TS/TSX 里的模板字面量内容(用于索引我们手写的 CSS)。
 * @param {string} text 源码。
 * @returns {{text: string, line: number}[]} 片段及其起始行。
 */
function templateLiterals(text) {
  const out = [];
  let line = 1;
  let i = 0;
  const n = text.length;
  let quote = null;
  while (i < n) {
    const c = text[i];
    if (c === '\n') {
      line++;
      i++;
      continue;
    }
    if (quote !== null) {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      i++;
      continue;
    }
    if (c === '`') {
      const startLine = line;
      let j = i + 1;
      while (j < n) {
        if (text[j] === '\\') {
          j += 2;
          continue;
        }
        if (text[j] === '`') break;
        j++;
      }
      out.push({ text: text.slice(i + 1, j), line: startLine });
      line += countNewlines(text.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    i++;
  }
  return out;
}

/**
 * 建立「本插件自己定义的类」索引。TS 里的 CSS 一律视为**已进包**(运行期注入);
 * SCSS 则要看它是否在闭包内。
 * @param {Set<string>} closure 闭包(绝对路径)。
 * @returns {Promise<Map<string, {file: string, line: number, inClosure: boolean}[]>>}
 */
export async function buildLocalIndex(closure) {
  /** @type {Map<string, {file: string, line: number, inClosure: boolean}[]>} */
  const classes = new Map();
  const record = (name, file, line, inClosure) => {
    let arr = classes.get(name);
    if (arr === undefined) {
      arr = [];
      classes.set(name, arr);
    }
    const already = arr.some((d) => d.file === file && d.line === line);
    if (!already) arr.push({ file, line, inClosure });
  };

  for (const file of await listFiles(LOCAL_SCSS_ROOT, ['.scss'])) {
    /*
     * 上游样式表现在**住在** `src/client/scss/upstream/**` 里(= LOCAL_SCSS_ROOT 的子目录),
     * 但它是「上游配方」,不是「我们自己的补偿」。两边都索引会让同一个定义同时出现在
     * `upstream` 与 `local` 里,`split` 桶的判据(上游在外、我们只有覆盖)就失真了。
     * 所以本地索引显式跳过上游子树 —— 它在 `upstream` 索引里有自己的一份。
     */
    if (file.startsWith(UPSTREAM_ROOT + sep)) continue;
    const text = await readIfExists(file);
    if (text === null) continue;
    const inClosure = closure.has(file);
    const { defs } = indexScss(text, file);
    for (const [name, sites] of defs) {
      for (const site of sites) record(name, file, site.line, inClosure);
    }
  }

  for (const file of await listFiles(LOCAL_TS_ROOT, ['.ts', '.tsx'], GENERATED_RE)) {
    const text = await readIfExists(file);
    if (text === null) continue;
    for (const tpl of templateLiterals(text)) {
      if (!/[.{]/.test(tpl.text)) continue;
      const { defs } = indexScss(tpl.text, file, tpl.line);
      for (const [name, sites] of defs) {
        for (const site of sites) record(name, file, site.line, true);
      }
    }
  }

  return classes;
}

// ---------------------------------------------------------------------------
// 活跃代码里的类名
// ---------------------------------------------------------------------------

/**
 * 抽出一个模块的 import/require 说明符。**纯类型导入**(`import type … from`)不算,
 * 它不产生运行时模块 —— 否则会把一堆「移植过来但没接线」的组件拉进可达图。
 * @param {string} clean 已去注释的源码。
 * @returns {Set<string>} 说明符。
 */
function collectModuleSpecifiers(clean) {
  const specs = new Set();
  for (const m of clean.matchAll(/\b(import|export)\b([^;]*?)\bfrom\s*['"]([^'"]+)['"]/g)) {
    if (/^\s*type\s/.test(m[2] ?? '')) continue; // import type / export type
    specs.add(m[3]);
  }
  for (const m of clean.matchAll(/\bimport\s+['"]([^'"]+)['"]/g)) specs.add(m[1]);
  for (const m of clean.matchAll(/\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]/g)) specs.add(m[1]);
  return specs;
}

/**
 * 「从 live view 可达」的模块图:只跟**相对** import,顺着 `.ts`/`.tsx` 解析。
 * 读不到/解析不到都只跳过(文件树可能正被并发编辑)。
 * @param {string[]} entries 入口文件(绝对路径)。
 * @returns {Promise<Set<string>>} 可达模块(绝对路径)。
 */
export async function computeLiveModules(entries) {
  const reachable = new Set();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop();
    if (reachable.has(file)) continue;
    reachable.add(file);
    const text = await readIfExists(file);
    if (text === null) continue;
    for (const spec of collectModuleSpecifiers(stripJsComments(text))) {
      if (!spec.startsWith('./') && !spec.startsWith('../')) continue;
      const base = resolve(dirname(file), spec);
      const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')];
      if (base.endsWith('.js')) candidates.push(`${base.slice(0, -3)}.ts`, `${base.slice(0, -3)}.tsx`);
      for (const candidate of candidates) {
        if ((await isFile(candidate)) && !reachable.has(candidate)) queue.push(candidate);
      }
    }
  }
  return reachable;
}

/** 把注释换成空格(保留换行与字符串内容)。 */
function stripJsComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }
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
    if (c === '"' || c === "'" || c === '`') {
      out += c;
      i++;
      while (i < n) {
        if (src[i] === '\\') {
          out += src[i] + (src[i + 1] ?? '');
          i += 2;
          continue;
        }
        out += src[i];
        if (src[i] === c) {
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

/**
 * 遍历文本里的字符串字面量与模板字面量(静态片段)。
 * @param {string} text 文本。
 * @param {(value: string, index: number) => void} cb 回调。
 */
function forEachStringLiteral(text, cb) {
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      let val = '';
      while (j < n) {
        if (text[j] === '\\') {
          val += text[j + 1] ?? '';
          j += 2;
          continue;
        }
        if (text[j] === c) break;
        val += text[j];
        j++;
      }
      cb(val, i);
      i = j + 1;
      continue;
    }
    if (c === '`') {
      let j = i + 1;
      let val = '';
      while (j < n) {
        if (text[j] === '\\') {
          val += text[j + 1] ?? '';
          j += 2;
          continue;
        }
        if (text[j] === '`') break;
        if (text[j] === '$' && text[j + 1] === '{') {
          // `${...}` 是**表达式**,不是类名文本:静态片段里挖掉它(否则
          // `branch.name === current` 里的 `current` 会被当成类名),但表达式**内部**的
          // 字符串字面量(`${cond ? 'danger' : 'primary'}`)要单独报出来。
          let depth = 0;
          let k = j + 1;
          for (; k < n; k++) {
            if (text[k] === '{') depth++;
            else if (text[k] === '}') {
              depth--;
              if (depth === 0) {
                k++;
                break;
              }
            }
          }
          const inner = text.slice(j + 2, Math.max(j + 2, k - 1));
          forEachStringLiteral(inner, (v, idx) => cb(v, j + 2 + idx));
          val += ' ';
          j = k;
          continue;
        }
        val += text[j];
        j++;
      }
      cb(val, i);
      i = j + 1;
      continue;
    }
    i++;
  }
}

/**
 * 从 `open` 处的开括号读到匹配的闭括号。
 * @param {string} text 文本。
 * @param {number} open 开括号下标。
 * @param {string} openCh 开括号字符。
 * @param {string} closeCh 闭括号字符。
 * @returns {{text: string, start: number}|null} 内部文本与起始下标。
 */
function readBalanced(text, open, openCh, closeCh) {
  if (text[open] !== openCh) return null;
  let depth = 0;
  let quote = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quote !== null) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      continue;
    }
    if (c === openCh) depth++;
    else if (c === closeCh) {
      depth--;
      if (depth === 0) return { text: text.slice(open + 1, i), start: open + 1 };
    }
  }
  return null;
}

/**
 * 采集一批模块里的活跃类名。
 *
 * 证据分两级:
 *  - **strong**:语法上就是类名(`className=`/`className:`、`classNames(...)`/`clsx(...)`、
 *    `classList.add(...)`);单字类名(`row`、`content`、`selected`)只在这里被采信。
 *   模板字面量 `${...}` 里的字符串也按 strong 处理,但**比较运算符右侧**的字符串除外
 *    —— `state === 'open' ? 'primary' : ''` 里 `'open'` 是状态值,`'primary'` 才是类名。
 *  - **loose**:其它位置的裸字符串字面量,只有**同时**满足「在 `.tsx` 里」+
 *    「kebab-case(含 `-`)」+「CSS 里真的出现过」才采信。`.ts` 里的 kebab 字符串
 *    多半是 menu id / 事件名(`models/menu-ids.ts` 的 `'clone-repository'` 就是这样),
 *    把它们当类名会把报告淹掉。
 * @param {string} text 源码。
 * @param {string} file 绝对路径。
 * @param {Set<string>} universe CSS 里出现过的全部类名。
 * @param {boolean} allowLoose 是否允许 loose 证据(只在 `.tsx` 里开)。
 * @returns {Map<string, {sites: {file: string, line: number, origin: string}[], strong: boolean}>}
 */
export function collectLiveClasses(text, file, universe, allowLoose) {
  const clean = stripJsComments(text);
  const lineOf = new Int32Array(clean.length + 1);
  {
    let line = 1;
    for (let i = 0; i < clean.length; i++) {
      lineOf[i] = line;
      if (clean[i] === '\n') line++;
    }
    lineOf[clean.length] = line;
  }

  /** @type {Map<string, {sites: {file: string, line: number, origin: string}[], strong: boolean}>} */
  const found = new Map();

  const add = (name, line, origin) => {
    let entry = found.get(name);
    if (entry === undefined) {
      entry = { sites: [], strong: origin !== 'literal' };
      found.set(name, entry);
    }
    if (origin !== 'literal') entry.strong = true;
    if (entry.sites.length < 24 && !entry.sites.some((s) => s.file === file && s.line === line)) {
      entry.sites.push({ file, line, origin });
    }
  };

  const addClassString = (value, idx, origin) => {
    const line = lineOf[Math.min(idx, clean.length)];
    for (const piece of value.split(/\s+/)) {
      if (piece === '' || !CLASS_TOKEN_RE.test(piece) || piece.length > 64) continue;
      add(piece, line, origin);
    }
  };

  /** 比较运算符右侧的字符串是状态值,不是类名。 */
  const isComparisonOperand = (source, idx) => /(?:===|!==|==|!=|<=|>=|<|>)\s*$/.test(source.slice(Math.max(0, idx - 10), idx));

  const addExpression = (range, origin) => {
    forEachStringLiteral(range.text, (value, idx) => {
      if (isComparisonOperand(range.text, idx)) return;
      addClassString(value, range.start + idx, origin);
    });
    if (origin === 'classNames') {
      for (const m of range.text.matchAll(/(?:^|[{,]\s*)([a-z][A-Za-z0-9]*)\s*:/g)) {
        const name = m[1];
        if (!CLASS_TOKEN_RE.test(name)) continue;
        add(name, lineOf[Math.min(range.start + m.index, clean.length)], 'classNames-key');
      }
    }
  };

  // (1) className="..." / className={'...'} / className={`...`}
  for (const m of clean.matchAll(/\bclassName\s*[:=]\s*/g)) {
    const start = m.index + m[0].length;
    const c = clean[start];
    if (c === '"' || c === "'") {
      let j = start + 1;
      let val = '';
      while (j < clean.length && clean[j] !== c) {
        if (clean[j] === '\\') {
          val += clean[j + 1] ?? '';
          j += 2;
          continue;
        }
        val += clean[j];
        j++;
      }
      addClassString(val, start, 'className');
    } else if (c === '{') {
      const range = readBalanced(clean, start, '{', '}');
      if (range !== null) addExpression(range, 'className');
    }
  }

  /*
   * (2) classNames('a b', { c: cond })
   *
   * 实参里出现的字符串字面量本来就算证据(内联的 `classNames(['handle', {focused}])`
   * 一直能采到)。这里补的是**同一文件里数组字面量借了个变量名**的那一种:
   *
   *     const classNamesArr: Array<any> = ['handle', { focused: isFocused }]
   *     return classNames(classNamesArr)          // ← 实参是裸标识符,字面量不在调用范围内
   *
   * 形状**故意写得很窄**:只认「实参整个就是一个裸标识符」+「同一文件里有
   * `const/let/var IDENT ... = [ ... ]`」。**不追**函数返回值、不追
   * `const x = classNames(...)` 的二次包装、不跨文件、不把裸标识符以外的形状
   * 的字符串当类名。放宽成「任意字符串都算」会把真正发不出来的类名一起洗绿 ——
   * 这正是本检查存在的意义(见文件头 §3:只许写理由,不许放宽判定)。
   */
  for (const m of clean.matchAll(/\b(?:classNames|classnames|clsx|cx)\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const range = readBalanced(clean, open, '(', ')');
    if (range === null) {
      continue;
    }
    addExpression(range, 'classNames');
    const sole = range.text.trim();
    if (!/^[A-Za-z_$][\w$]*$/.test(sole)) {
      continue;
    }
    const escaped = sole.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // `: Array<any>` 之类的类型注解里不含 `=` 与 `;`,写成可选片段。
    for (const decl of clean.matchAll(new RegExp(`\\b(?:const|let|var)\\s+${escaped}\\s*(?::[^=;]*)?=\\s*\\[`, 'g'))) {
      const bracket = clean.indexOf('[', decl.index);
      const literal = readBalanced(clean, bracket, '[', ']');
      if (literal !== null) addExpression(literal, 'classNames');
    }
  }

  // (3) classList.add/remove/toggle/contains('a b')
  for (const m of clean.matchAll(/classList\s*\.\s*(?:add|remove|toggle|contains)\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const range = readBalanced(clean, open, '(', ')');
    if (range !== null) addExpression(range, 'classList');
  }

  // (4) 兜底:看起来像类名(kebab-case)且 CSS 里真的有的裸字符串(只在 .tsx 里开)。
  if (allowLoose) {
    forEachStringLiteral(clean, (value, idx) => {
      if (isComparisonOperand(clean, idx)) return;
      for (const piece of value.split(/\s+/)) {
        if (piece === '' || !CLASS_TOKEN_RE.test(piece) || piece.length > 64) continue;
        if (!piece.includes('-')) continue;
        if (!universe.has(piece)) continue;
        add(piece, lineOf[Math.min(idx, clean.length)], 'literal');
      }
    });
  }

  return found;
}

// ---------------------------------------------------------------------------
// 基线(棘轮)
// ---------------------------------------------------------------------------

/**
 * 读基线。不存在/格式不对 → 当空基线(只警告,不抛)。
 * @returns {Promise<Record<string, string>>} class → 理由。
 */
async function readBaseline() {
  const text = await (async () => {
    try {
      return await readFile(BASELINE_PATH, 'utf8');
    } catch (err) {
      if (err?.code !== 'ENOENT') warn(`基线读取失败,按空基线处理: ${rel(BASELINE_PATH)} (${err?.code ?? err})`);
      return null;
    }
  })();
  if (text === null) return {};
  try {
    const parsed = JSON.parse(text);
    const split = parsed?.split;
    if (split === null || typeof split !== 'object' || Array.isArray(split)) {
      warn(`基线格式不是 { "split": { ... } },按空基线处理: ${rel(BASELINE_PATH)}`);
      return {};
    }
    /** @type {Record<string, string>} */
    const out = {};
    for (const [key, value] of Object.entries(split)) out[key] = String(value ?? '');
    return out;
  } catch (err) {
    warn(`基线不是合法 JSON,按空基线处理: ${rel(BASELINE_PATH)} (${err?.message ?? err})`);
    return {};
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/** 解析命令行。 */
function parseArgs(argv) {
  const opts = { json: false, writeBaseline: false, help: false };
  for (const arg of argv) {
    if (arg === '--json') opts.json = true;
    else if (arg === '--write-baseline') opts.writeBaseline = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else warn(`忽略未知参数: ${arg}`);
  }
  return opts;
}

const HELP = `用法: node scripts/check-base-recipes.mjs [--json] [--write-baseline]

  基础配方缺失检查:找出「包内只有覆盖规则、真正的基础配方在上游 @import 闭包之外」的类。
  退出码 0 = 没有未登记的 split;1 = 有未登记的 split。
  --json             stdout 输出机器可读 JSON
  --write-baseline   用当前 split 集合重写 scripts/base-recipes-baseline.json(棘轮)
`;

/** 主流程。 */
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }

  // --- 1. 上游索引 ---------------------------------------------------------
  /** @type {Map<string, {file: string, line: number, selector?: string}[]>} */
  const upstream = new Map();
  /** @type {Map<string, {file: string, line: number, selector: string}[]>} */
  const unresolvedRefs = new Map();
  /** @type {{file: string, line: number, selector: string}[]} */
  const unresolvedSites = [];

  const upstreamFiles = await listFiles(UPSTREAM_ROOT, ['.scss']);
  for (const file of upstreamFiles) {
    const text = await readIfExists(file);
    if (text === null) continue;
    const { defs, unresolved } = indexScss(text, file);
    for (const [name, sites] of defs) {
      let arr = upstream.get(name);
      if (arr === undefined) {
        arr = [];
        upstream.set(name, arr);
      }
      for (const site of sites) if (!arr.some((d) => d.file === file && d.line === site.line)) arr.push(site);
    }
    for (const site of unresolved) {
      unresolvedSites.push(site);
      for (const name of site.classes) {
        let arr = unresolvedRefs.get(name);
        if (arr === undefined) {
          arr = [];
          unresolvedRefs.set(name, arr);
        }
        if (!arr.some((d) => d.file === site.file && d.line === site.line)) {
          arr.push({ file: site.file, line: site.line, selector: site.selector });
        }
      }
    }
  }
  if (upstreamFiles.length === 0) {
    warn(`上游 SCSS 一个都没找到(${rel(UPSTREAM_ROOT)})—— 索引为空,结果不可信`);
  }

  // --- 2. 导入闭包(根 = scripts/styles.mjs 的 PORT_SURFACES,见 computeClosureRoots) --
  const closureRoots = await computeClosureRoots();
  /** @type {Map<string, string[]>} */
  const closure = new Map();
  for (const root of closureRoots) {
    const one = await computeClosure(root);
    if (!one.has(root)) warn(`闭包入口不存在: ${rel(root)}`);
    for (const [file, specs] of one) if (!closure.has(file)) closure.set(file, specs);
  }
  const closureSize = closure.size;
  if (closureRoots.length > 1) {
    process.stderr.write(
      `dsh-git/check-base-recipes: 闭包根 ${closureRoots.length} 个(来自 PORT_SURFACES):` +
        ` ${closureRoots.map((r) => rel(r)).join(', ')}\n`,
    );
  }

  // --- 3. 本插件自己的样式 + 活跃类名 -------------------------------------
  const local = await buildLocalIndex(closure);

  const universe = new Set([...upstream.keys(), ...local.keys()]);

  /** @type {Map<string, {sites: {file: string, line: number, origin: string}[], strong: boolean}>} */
  const live = new Map();
  /**
   * live 图里**真的会发出**的 id(`id="…"` / `id={'…'}`)。与类名同源、同一遍扫描。
   * 用途见 `ruleCouldMatchUs`:上游有大量规则挂在 `dialog#choose-branch` /
   * `#commit-list` / `#desktop-app-title-bar` 这类**宿主的 id** 之下,我们永不渲染那些 id,
   * 所以那些规则不可能是「我们缺的配方」。
   * 盲区:运行期拼出来的 id(`id={'x-' + n}`)看不见 ⇒ 判定偏宽松(少报),不会误报。
   * @type {Set<string>}
   */
  const liveIds = new Set();
  let liveFileCount = 0;
  let liveSkippedCount = 0;
  const liveModules = await computeLiveModules(LIVE_ENTRIES);
  for (const entry of LIVE_ENTRIES) {
    if (!(await isFile(entry))) warn(`活跃入口不存在(可达图可能不完整): ${rel(entry)}`);
  }
  for (const root of LIVE_ROOTS) {
    for (const file of await listFiles(root, ['.ts', '.tsx'], GENERATED_RE)) {
      if (STYLE_ONLY_RE.test(file.slice(file.lastIndexOf('/') + 1))) continue;
      if (!liveModules.has(file)) {
        liveSkippedCount++;
        continue;
      }
      const text = await readIfExists(file);
      if (text === null) continue;
      liveFileCount++;
      for (const m of text.matchAll(/\bid\s*=\s*\{?\s*['"`]([A-Za-z][\w-]*)['"`]/g)) liveIds.add(m[1]);
      const found = collectLiveClasses(text, file, universe, file.endsWith('.tsx'));
      for (const [name, entry] of found) {
        const existing = live.get(name);
        if (existing === undefined) {
          live.set(name, entry);
          continue;
        }
        existing.strong = existing.strong || entry.strong;
        for (const site of entry.sites) {
          if (existing.sites.length < 24 && !existing.sites.some((s) => s.file === site.file && s.line === site.line)) {
            existing.sites.push(site);
          }
        }
      }
    }
  }

  // --- 4. 分类 -------------------------------------------------------------
  /*
   * 移植后「闭包里的文件」与「上游索引里的文件」是**同一批路径**
   * (`src/client/scss/upstream/**`),直接判成员即可,不再需要路径折算。
   */
  const closureHas = (file) => closure.has(file);

  /**
   * 一条上游规则**是否可能落在本插件的 DOM 上**。
   *
   * 判据:这条规则要求的所有**类名**与 **id**,都必须是我们 live 图里真的能发出的
   * (`live` 的键集 / `liveIds`),否则它写的是**别的移植面 / 宿主窗口**的组件 ——
   * 例如 `.commit-list-item-tooltip.list-item-tooltip` 里的 `.commit-list-item-tooltip`、
   * `dialog#cherry-pick .dialog-content .list-item` 里的 `#cherry-pick`、
   * `#desktop-app-title-bar .resize-handle.top` 里的 `#desktop-app-title-bar`。
   * 无论 import 不 import,它们都不可能匹配我们的节点。
   *
   * 为什么需要它(2026-10 实证):旧判据是「只要闭包外**存在**这条类的规则 ⇒ split」,
   * 于是仓库列表移植面接进 live 图后爆出 **34 条假 split** —— 全是泛用类名
   * (`.list` / `.label` / `.filter-list*` / `.row-component` …)在 dialog / commit-list /
   * account-picker / 宿主窗口那些**我们不渲染的面**里的上下文规则。它们不是缺口。
   *
   * 反例(必须保住):`.sr-only` 的配方在上游 `_app.scss:115-123`,那条选择器就是
   * **裸 `.sr-only`** ⇒ 它要求的类与 id 都在 live 图里 ⇒ 仍然算 split。
   * 也就是说这条判据**只砍掉「要求我们不存在的祖先」的规则**,不砍真配方。
   *
   * 留下的是真缺口(实证):`repositories-list.tsx:208` 真的渲染
   * `<div className="repository-list-item-tooltip list-item-tooltip">`,而它的配方
   * (`display:flex` / `.label{min-width:60px}`)只写在 `ui/window/_tooltips.scss` 的
   * `body > .tooltip …` 之下 —— 那不在闭包里,也没有 id 挡着 ⇒ 仍然报 split。
   *
   * 盲区(写在文件头「已知限制」):live 类/id 集来自静态采集,动态拼出来的名字
   * (`classNames('platform-' + p)`)看不见 ⇒ 可能把一条真规则误判为「匹配不到」。
   * 方向是**更宽松**(少报),不会把好代码报成坏的。
   * @param {{file: string, line: number, selector?: string}} site 上游定义点。
   * @returns {boolean} 是否可能匹配我们的 DOM。
   */
  const ruleCouldMatchUs = (site) => {
    const selector = typeof site.selector === 'string' ? site.selector : '';
    if (selector === '') return true; // 没有选择器信息时保守:算可能匹配
    for (const name of classNamesInSelector(selector)) {
      if (!live.has(name)) return false;
    }
    for (const id of idsInSelector(selector)) {
      if (!liveIds.has(id)) return false;
    }
    return true;
  };

  /** @type {Map<string, string[]>} 类名 → 闭包外「结构性但闭包内没有」的属性(诊断用) */
  const contextOnlyMissingProps = new Map();
  /** @type {{class: string, bucket: string, subtype: string, strong: boolean, upstream: {file: string, line: number, selector?: string}[], inside: {file: string, line: number, selector?: string}[], outside: {file: string, line: number, selector?: string}[], outsideOtherSurface: number, outsideStructuralMissing: string[], local: {file: string, line: number, inClosure: boolean}[], unresolvedRefs: {file: string, line: number, selector: string}[], sites: {file: string, line: number, origin: string}[]}[]} */
  const entries = [];

  for (const [cls, usage] of live) {
    const up = upstream.get(cls) ?? [];
    const inside = up.filter((d) => closureHas(d.file));
    const outsideAll = up.filter((d) => !closureHas(d.file));
    // 只有「可能匹配我们」的闭包外规则才算缺口;其余是别的移植面的上下文规则。
    const outside = outsideAll.filter(ruleCouldMatchUs);
    const outsideOtherSurface = outsideAll.length - outside.length;
    const localDefs = local.get(cls) ?? [];
    const localInClosure = localDefs.filter((d) => d.inClosure);
    const refs = unresolvedRefs.get(cls) ?? [];

    let bucket;
    let subtype;
    if (up.length === 0) {
      // 上游任何地方都没有这条规则 —— 按定义就是 orphan,哪怕我们自己写了样式。
      bucket = refs.length > 0 ? 'unresolved' : 'orphan';
      subtype = refs.length > 0 ? 'no-home' : localInClosure.length > 0 ? 'ours' : 'bare';
    } else if (outside.length === 0) {
      bucket = 'ok';
      subtype = outsideOtherSurface > 0 ? 'upstream-other-surface' : 'upstream';
    } else if (localInClosure.length > 0) {
      bucket = 'ok';
      subtype = 'local-compensated';
    } else {
      /*
       * 最后一道判据(2026-10 加):**闭包外还剩的规则,到底是不是我们缺的那份配方?**
       *
       * 只看「闭包外有没有这条类的规则」会把**上下文覆盖**误判成缺口。实证:
       * `_dialog.scss:247` 的 `dialog .dialog-content .row-component:not(:last-child){margin-bottom}`,
       * 而 `.row-component` 的配方(`display:flex; flex-direction:row`)就在闭包的
       * `_row.scss:1` 里 —— 缺的只是一条 dialog 才需要的边距。那不是缺口。
       *
       * 判据:把闭包**内**与闭包**外**各自声明的属性求并集,若闭包外**没有任何**
       * 结构性属性是闭包内没有的,这条规则就是覆盖而不是配方 ⇒ ok(context-only)。
       *
       * **必须保住的失败模式**:`.sr-only` 那次包里只有 `user-select: none`(非结构性),
       * 而闭包外的配方有 `clip/clip-path/position/width/height/overflow/white-space`
       * ⇒ 一定仍然判 split。附带的好处:`@include` 不展开 ⇒ `@include` 无法伪造结构性。
       */
      const insideProps = new Set();
      for (const d of inside) for (const p of await rulePropertiesAt(d.file, d.line)) insideProps.add(p);
      const outsideStructuralMissing = new Set();
      for (const d of outside) {
        for (const p of await rulePropertiesAt(d.file, d.line)) {
          if (isStructuralProperty(p) && !insideProps.has(p)) outsideStructuralMissing.add(p);
        }
      }
      if (outsideStructuralMissing.size === 0) {
        bucket = 'ok';
        subtype = 'context-only';
      } else {
        bucket = 'split';
        subtype = 'no-recipe';
      }
      contextOnlyMissingProps.set(cls, [...outsideStructuralMissing].sort());
    }

    entries.push({
      class: cls,
      bucket,
      subtype,
      strong: usage.strong,
      upstream: up,
      inside,
      outside,
      outsideOtherSurface,
      outsideStructuralMissing: contextOnlyMissingProps.get(cls) ?? [],
      local: localDefs,
      unresolvedRefs: refs,
      sites: usage.sites,
    });
  }

  const byBucket = (bucket) => entries.filter((e) => e.bucket === bucket);
  const split = byBucket('split').sort((a, b) => a.class.localeCompare(b.class));
  const orphan = byBucket('orphan').sort((a, b) => {
    const aOurs = a.subtype === 'ours' ? 1 : 0;
    const bOurs = b.subtype === 'ours' ? 1 : 0;
    if (aOurs !== bOurs) return aOurs - bOurs; // bare 优先
    return a.class.localeCompare(b.class);
  });
  const unresolvedEntries = byBucket('unresolved').sort((a, b) => a.class.localeCompare(b.class));
  const ok = byBucket('ok');

  // --- 5. 基线 -------------------------------------------------------------
  let baseline = await readBaseline();
  if (opts.writeBaseline) {
    /** @type {Record<string, string>} */
    const next = {};
    for (const entry of split) {
      next[entry.class] = baseline[entry.class] ?? 'TODO: 说明这条 split 为什么现在可接受,或者补上基础配方后从基线里删掉';
    }
    try {
      await writeFile(BASELINE_PATH, `${JSON.stringify({ split: next }, null, 2)}\n`, 'utf8');
      process.stderr.write(`dsh-git/check-base-recipes: 已写入基线 ${rel(BASELINE_PATH)}(${split.length} 个 split)\n`);
    } catch (err) {
      warn(`基线写入失败: ${rel(BASELINE_PATH)} (${err?.code ?? err})`);
    }
    baseline = await readBaseline();
  }

  const known = split.filter((e) => Object.hasOwn(baseline, e.class));
  const failing = split.filter((e) => !Object.hasOwn(baseline, e.class));
  const staleBaseline = Object.keys(baseline).filter((cls) => !split.some((e) => e.class === cls));

  const compensated = ok.filter((e) => e.subtype === 'local-compensated');
  const orphanBare = orphan.filter((e) => e.subtype === 'bare');
  const orphanOurs = orphan.filter((e) => e.subtype === 'ours');

  const counts = {
    upstreamFiles: upstreamFiles.length,
    upstreamClasses: upstream.size,
    closureFiles: closureSize,
    liveFiles: liveFileCount,
    liveFilesSkipped: liveSkippedCount,
    liveClasses: live.size,
    localClasses: local.size,
    ok: ok.length,
    okCompensated: compensated.length,
    okOtherSurface: ok.filter((e) => e.subtype === 'upstream-other-surface').length,
    okContextOnly: ok.filter((e) => e.subtype === 'context-only').length,
    split: split.length,
    splitKnown: known.length,
    splitFailing: failing.length,
    orphan: orphan.length,
    orphanBare: orphanBare.length,
    orphanOurs: orphanOurs.length,
    unresolved: unresolvedEntries.length,
    unresolvedSites: unresolvedSites.length,
  };

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          tool: 'dsh-git/scripts/check-base-recipes.mjs',
          counts,
          closureRoots: closureRoots.map((r) => rel(r)),
          split: split.map((e) => ({
            class: e.class,
            known: Object.hasOwn(baseline, e.class),
            reason: baseline[e.class] ?? null,
            strong: e.strong,
            missingStructuralProps: e.outsideStructuralMissing,
            outside: e.outside.map((d) => ({ file: rel(d.file), line: d.line, selector: d.selector })),
            outsideOtherSurface: e.outsideOtherSurface,
            inside: e.inside.map((d) => ({ file: rel(d.file), line: d.line, selector: d.selector })),
            local: e.local.map((d) => ({ file: rel(d.file), line: d.line, inClosure: d.inClosure })),
            unresolvedRefs: e.unresolvedRefs.map((d) => ({ file: rel(d.file), line: d.line, selector: d.selector })),
            usedBy: e.sites.map((s) => ({ file: rel(s.file), line: s.line, origin: s.origin })),
          })),
          okLocalCompensated: compensated.map((e) => ({
            class: e.class,
            outside: e.outside.map((d) => ({ file: rel(d.file), line: d.line, selector: d.selector })),
            local: e.local.filter((d) => d.inClosure).map((d) => ({ file: rel(d.file), line: d.line })),
          })),
          orphan: orphan.map((e) => ({ class: e.class, kind: e.subtype, usedBy: e.sites.map((s) => `${rel(s.file)}:${s.line}`) })),
          unresolved: unresolvedEntries.map((e) => ({
            class: e.class,
            refs: e.unresolvedRefs.map((d) => ({ file: rel(d.file), line: d.line, selector: d.selector })),
          })),
          staleBaseline,
          warnings,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    printReport({ counts, split, known, failing, staleBaseline, compensated, orphan, orphanBare, orphanOurs, unresolvedEntries, unresolvedSites, baseline, opts, closureRoots });
  }

  process.exitCode = failing.length > 0 ? 1 : 0;
}

/** 人读报告。 */
function printReport(ctx) {
  const { counts, split, failing, staleBaseline, compensated, orphan, orphanBare, orphanOurs, unresolvedEntries, unresolvedSites, baseline, opts, closureRoots } = ctx;
  const out = (s = '') => process.stdout.write(`${s}\n`);
  const site = (d, n = 2) => {
    const list = d.slice(0, n).map((x) => `${shortPath(x.file)}:${x.line}`);
    const extra = d.length > n ? ` (+${d.length - n})` : '';
    return `${list.join(', ')}${extra}`;
  };
  const usedBy = (e) => {
    const first = e.sites[0];
    return first === undefined ? '—' : `${shortPath(first.file)}:${first.line}`;
  };

  out('dsh-git: 基础配方缺失检查(base-recipe check)');
  out(`  上游 SCSS 索引 : ${counts.upstreamFiles} 个文件 / ${counts.upstreamClasses} 个类选择器  (${UPSTREAM_PREFIX.replace(/\/$/, '')})`);
  out(`  导入闭包       : ${counts.closureFiles} 个文件  (根 ${closureRoots.map((r) => rel(r)).join(' + ')},来自 scripts/styles.mjs 的 PORT_SURFACES;注释里的 @import 已忽略)`);
  out(`  活跃模块       : ${counts.liveFiles} 个 TS/TSX / ${counts.liveClasses} 个类  (从 ${LIVE_ENTRIES.map((e) => rel(e)).join(' + ')} 沿相对 import 可达;另有 ${counts.liveFilesSkipped} 个模块不可达,已排除)`);
  out(`  本插件样式     : ${counts.localClasses} 个类定义(src/client/scss + src/client 的 CSS 模板)`);
  out('');
  out('  分类:');
  out(`    ok         ${String(counts.ok).padStart(4)}   (上游配方都在闭包内 ${counts.ok - counts.okCompensated};本插件就地补配方 ${counts.okCompensated})`);
  out(`    split      ${String(counts.split).padStart(4)}   ← 危险:基础配方在闭包之外  (已登记 ${counts.splitKnown};**未登记 ${counts.splitFailing}**)`);
  out(`    orphan     ${String(counts.orphan).padStart(4)}   (上游无此规则:本插件有样式 ${counts.orphanOurs};谁都没写 ${counts.orphanBare})`);
  out(`    unresolved ${String(counts.unresolved).padStart(4)}   (& 嵌套无法归位;另有 ${counts.unresolvedSites} 处上游选择器未解析)`);
  out('');

  if (split.length === 0) {
    out('  split: 0 —— 没有「只有覆盖、没有配方」的类。✓');
  } else {
    out(`  split(${split.length} 个;outside = 闭包之外的**基础配方**,inside = 包内已有的覆盖/规则,used@ = 活跃代码用点):`);
    for (const e of split) {
      const known = Object.hasOwn(baseline, e.class);
      const tag = known ? 'known' : 'FAIL ';
      const insideText = e.inside.length > 0 ? site(e.inside, 1) : '—';
      const localText = e.local.length > 0 ? site(e.local.filter((d) => d.inClosure), 1) : '—';
      out(
        `    ${tag} .${e.class.padEnd(30)} outside: ${site(e.outside).padEnd(38)} inside: ${insideText.padEnd(28)} local: ${localText.padEnd(20)} used@${usedBy(e)}`,
      );
      if (known) out(`          └ 基线理由: ${baseline[e.class]}`);
    }
    if (failing.length > 0) {
      out('');
      out(`  → 未登记的 split 有 ${failing.length} 个。修完(或就地补基础配方)后重跑;确属可接受就:`);
      out('      node scripts/check-base-recipes.mjs --write-baseline');
    }
  }
  out('');

  if (compensated.length > 0) {
    out(`  ok(local review) ${compensated.length} 个 —— 上游配方在闭包外,但本插件在包里**自己补了**规则,请人工确认补的确实是配方而不是又一条覆盖:`);
    for (const e of compensated) {
      out(`    ${('.' + e.class).padEnd(32)} outside: ${site(e.outside, 1).padEnd(34)} local: ${site(e.local.filter((d) => d.inClosure), 1)}`);
    }
    out('');
  }

  if (orphan.length > 0) {
    out(`  orphan(${orphan.length} 个 = ours ${orphanOurs.length}(我们自己的样式,典型是 gw-*) + bare ${orphanBare.length}(谁都没写);列出前 ${Math.min(orphan.length, 40)}):`);
    for (const e of orphan.slice(0, 40)) {
      out(`    [${e.subtype.padEnd(4)}] .${e.class.padEnd(30)} used@${usedBy(e)}`);
    }
    if (orphan.length > 40) out(`    … 其余 ${orphan.length - 40} 个省略`);
    if (orphanBare.length > 0) out(`    提示:${orphanBare.length} 个 bare orphan 上游也没有规则,通常无害;若是**移植过来的组件**在用,说明上游那张表没进闭包。`);
    out('');
  }

  if (unresolvedSites.length > 0) {
    const unresolvedClasses = [...new Set(unresolvedSites.flatMap((s) => s.classes))].sort();
    out(`  警告:${unresolvedSites.length} 处上游选择器的 & 无法静态归位(屏障 at-rule,如 @mixin/@at-root 里的 &;现场由 include 方决定):`);
    for (const s of unresolvedSites.slice(0, 10)) {
      const named = s.classes.length > 0 ? `   → ${s.classes.map((c) => `.${c}`).join(', ')}` : '';
      out(`    ${shortPath(s.file)}:${s.line}  ${s.selector}${named}`);
    }
    if (unresolvedSites.length > 10) out(`    … 其余 ${unresolvedSites.length - 10} 处省略`);
    out(`    涉及 ${unresolvedClasses.length} 个候选类:${unresolvedClasses.length > 0 ? unresolvedClasses.map((c) => `.${c}`).join(', ') : '(无 —— 全是 `&:pseudo`,不产生类名)'}`);
    if (unresolvedEntries.length > 0) {
      out(`    其中被活跃代码用到、因而归入 unresolved 桶的类:${unresolvedEntries.map((e) => `.${e.class}`).join(', ')}`);
    }
    out('');
  }

  if (Object.keys(baseline).length > 0) {
    out(`  基线:${rel(BASELINE_PATH)}(${Object.keys(baseline).length} 条)`);
    if (staleBaseline.length > 0) {
      out(`    已失效(不再是 split,建议从基线删除):${staleBaseline.map((c) => `.${c}`).join(', ')}`);
    }
    out('');
  } else if (!opts.writeBaseline) {
    out(`  基线:无 ${rel(BASELINE_PATH)}(首次落地请跑 --write-baseline 把现状钉住,之后只拦**新增**的 split)`);
    out('');
  }

  if (warnings.length > 0) {
    out(`  警告 ${warnings.length} 条(文件树可能正被并发编辑):`);
    for (const w of warnings.slice(0, 20)) out(`    ! ${w}`);
    if (warnings.length > 20) out(`    … 其余 ${warnings.length - 20} 条省略`);
    out('');
  }

  out(`  结论:${failing.length === 0 ? 'PASS' : `FAIL(${failing.length} 个未登记 split)`}  退出码 ${failing.length === 0 ? 0 : 1}`);
}

/*
 * 直接运行时才跑主流程;**被 import 时只导出函数**(`check-unreachable-ancestors.mjs`
 * 复用同一个 live 图定义 —— 「活跃模块/类名」这件事只允许有一份定义,两份必然漂移)。
 */
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
