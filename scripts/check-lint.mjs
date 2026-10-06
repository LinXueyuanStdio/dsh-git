#!/usr/bin/env node
/**
 * ESLint 棘轮(lint ratchet)—— 把 Desktop 的自定义规则接上,并**只拦新增违规**。
 *
 * ## 1. 它防的是什么
 *
 * 本插件最贵的三个缺陷全是**静默**的(`docs/gaps-vs-desktop.md` §1 逐字:
 * 「the class name exists」≠「the rule that gives it meaning is in effect」):
 *
 *   1. 样式表缺「基础配方」 → 由 `scripts/check-base-recipes.mjs` 管;
 *   2. 某个 prop 从没被传(死 prop) → 由 `scripts/check-types.mjs` 管;
 *   3. **拼错的生命周期方法名** → 在本脚本之前,**没有任何东西在管**。
 *
 * 第 3 类的机制:`componentDidUpdte()` 是合法的方法名,TypeScript 接受它,
 * React 只调用精确名字,于是这个方法**永远不会被调用** —— 没有异常、没有警告、
 * 类型系统完全满意,失败形态是「某个状态永远不刷新」。`tsc` 抓不到它;
 * `@typescript-eslint` 全家族也抓不到(它们不知道自己在一个 React 类里)。
 * 唯一抓得到的是 Desktop 的自定义规则 `react-proper-lifecycle-methods`
 * (`references/desktop/eslint-rules/`,移植在 `eslint-rules/`)。
 *
 * ## 2. 为什么是「棘轮」而不是「全绿」
 *
 * 上游的镜像树(`src/core/desktop/**`,130 个文件)是逐字沿用的,**基线为 0**;
 * 但我们自己的适配层(`src/client/**`、`src/host/**`、`scripts/**`)从来没有
 * 被 lint 过,首次跑必然一片红。**一次性修完既不可能也不该做**(另一条线持有
 * 那些文件)。所以判据与 `check-base-recipes.mjs` / `check-types.mjs` 同形:
 *
 *   · 基线 = 首次跑出来的 **(文件, 规则) → 命中数**;实现在 `scripts/lint-baseline.json`;
 *   · **只拦新增**:某个 (文件, 规则) 的命中数**上升** = 失败(退出码 1);
 *   · 命中数**下降** = 改进(报告里列出,提示重钉基线);
 *   · 基线里已消失的条目 = stale(列出,提示删掉)。
 *
 * 存**计数**而不是存行号:行号会随无关改动漂移,把「只是插了一行」误报成
 * 「新增违规」,那种闸门会被关掉。失败报告里才打印本次的**真实行号**。
 *
 * ## 3. 已知限制(不要假装没有)
 *
 *   · **不做类型感知检查**。本层全部规则都不需要 `parserOptions.project`
 *     (最快的路径,也不与在飞的类型检查争 `tsconfig`)。要类型信息得去
 *     `scripts/check-types.mjs`。
 *   · **不跑 Prettier**。`.prettierrc.yml` / `.prettierignore` 已就位(给编辑器
 *     与将来的格式棘轮用),但格式闸门需要一次全仓重排,本轮明确不做。
 *   · **不用 `--cache`**。ESLint 的缓存键**不含自定义规则文件的字节**,
 *     改了 `eslint-rules/*.js` 却命中旧缓存 ⇒ 假绿。棘轮的可信度高于几秒启动时间。
 *   · **不修任何存量违规**(本轮明确要求)。若是真 bug,只报告 `file:line`。
 *
 * ## 4. 用法
 *
 *     node scripts/check-lint.mjs                  # 棘轮判据,退出码 0/1
 *     node scripts/check-lint.mjs --write-baseline # 用当前计数重钉基线
 *     node scripts/check-lint.mjs --json           # stdout 是纯 JSON
 *     node scripts/check-lint.mjs --coverage       # 证明规则**真的访问到了**节点
 *
 * 退出码:0 = 无新增;1 = 有新增;2 = 工具/配置加载失败(不是 0,不能静默通过)。
 *
 * `--coverage` 的存在理由见 H16:上游 `package.json:41` 的 eslint glob 引用了
 * 一个**不存在**的目录(`app/typings/`),那种「闸门通过其实什么都没扫」是
 * 本仓库反复踩过的坑。所以本脚本**永远打印实际扫到的文件数**,并且
 * `--coverage` 会打印每条自定义规则实际访问到的节点数 ——
 * 一条静默访问 0 个节点的规则,等于没有这条规则。
 */

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const BASELINE_PATH = path.join(ROOT, 'scripts', 'lint-baseline.json');
const RULES_DIR = path.join(ROOT, 'eslint-rules');

/** lint 范围。刻意写死成显式 glob:范围必须能被证伪(见文件头 §4 / H16)。 */
const PATTERNS = [
  'src/**/*.ts',
  'src/**/*.tsx',
  'scripts/**/*.mjs',
  'eslint-rules/**/*.js',
  'types/**/*.d.ts',
];

/** ESLint 默认只认 `.js`;不显式给,`src/**` 会被静默跳过。 */
const EXTENSIONS = ['.ts', '.tsx', '.mjs', '.js'];

/**
 * 范围对账用的裸遍历根:必须覆盖 PATTERNS 命中的每一棵树。
 * 它刻意**不读** `.eslintignore` —— 它存在的意义就是和 ESLint 看到的东西对账。
 */
const SCOPE_ROOTS = ['src', 'scripts', 'eslint-rules', 'types'];
const LINTABLE_EXTS = new Set(['.ts', '.tsx', '.mjs', '.js']);

/**
 * 明知故犯地排除在 lint 之外的文件(必须逐条写理由)。
 * 默认空:本仓库没有任何一个源码文件应该逃过 lint。
 * @type {Map<string, string>}
 */
const SCOPE_EXEMPT = new Map();

/** 自定义规则名单(与 `.eslintrc.yml` 挂载的一致)。 */
const CUSTOM_RULES = [
  'react-proper-lifecycle-methods',
  'react-readonly-props-and-state',
  'insecure-random',
];

const warnings = [];
/** @param {string} message */
function warn(message) {
  warnings.push(message);
  process.stderr.write(`dsh-git/check-lint: 警告: ${message}\n`);
}

/** @param {string} p */
function rel(p) {
  return path.relative(ROOT, p) || p;
}

// ---------------------------------------------------------------------------
// 范围对账(死 glob / 被静默跳过的文件)
// ---------------------------------------------------------------------------

/**
 * 裸遍历源码树,返回所有**本应被 lint** 的相对路径。
 *
 * 为什么值得写:H16 记录了一条上游的死引用 —— `package.json:41` 的 eslint glob
 * 指着一个**不存在**的 `app/typings/` 目录,于是「检查通过」可能只是因为
 * 「什么都没扫到」。本仓库第一次跑本脚本时踩的是同一族坑的另一半:
 * `.eslintignore` 里写成 `lib/`(不带根锚定),`.gitignore` 式匹配把
 * `src/core/desktop/lib/**` 与 `src/core/desktop/ui/lib/**` 一并吞掉,
 * **81 个文件、25 个 class 组件、40 处生命周期方法**被静默跳过,闸门照样绿。
 * 这个函数就是为了让那种事第二次发生时**直接失败**。
 *
 * @returns {Promise<string[]>} 相对路径,已排序
 */
async function walkLintable() {
  /** @type {string[]} */
  const out = [];
  /** @param {string} dir */
  async function rec(dir) {
    /** @type {import('node:fs').Dirent[]} */
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // 目录不存在:不是本函数的错,交给 PATTERNS 的结果说话
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await rec(full);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (LINTABLE_EXTS.has(path.extname(entry.name))) {
        out.push(rel(full));
      }
    }
  }
  for (const root of SCOPE_ROOTS) {
    await rec(path.join(ROOT, root));
  }
  return out.sort();
}

// ---------------------------------------------------------------------------
// 工具加载(缺工具绝不能抛栈,也不能静默通过)
// ---------------------------------------------------------------------------

/**
 * 加载 eslint 的 Node API。
 * @returns {{ESLint: any}|{error: string}}
 */
function loadEslint() {
  try {
    const require = createRequire(import.meta.url);
    const { ESLint } = require('eslint');
    if (typeof ESLint !== 'function') {
      return { error: 'eslint 已安装但 Node API 里没有 ESLint 类(版本不对?)' };
    }
    return { ESLint };
  } catch (err) {
    return { error: `无法加载 eslint(${err?.code ?? err?.name ?? 'unknown'}: ${err?.message ?? err})` };
  }
}

/** `eslint-rules/` 里的规则文件是否齐(缺一个就说明移植不完整)。 */
async function checkRuleFiles() {
  const missing = [];
  for (const name of CUSTOM_RULES) {
    try {
      await readFile(path.join(RULES_DIR, `${name}.js`), 'utf8');
    } catch {
      missing.push(`${name}.js`);
    }
  }
  return missing;
}

// ---------------------------------------------------------------------------
// 一次 lint,压成 (文件, 规则) → 计数
// ---------------------------------------------------------------------------

/**
 * @typedef {{file: string, rule: string, line: number, column: number, message: string, severity: number}[]} Violations
 */

/**
 * 跑一轮 ESLint。
 * @param {any} ESLint
 * @param {{probePlugin?: Record<string, any>}} [opts]
 * @returns {Promise<{files: string[], violations: Violations, fatal: {file: string, message: string}[]}>}
 */
async function runLint(ESLint, opts = {}) {
  /** @type {any} */
  const config = {
    cwd: ROOT,
    // 与上游 `--rulesdir ./eslint-rules`(`references/desktop/package.json:41`)同一机制。
    rulePaths: [RULES_DIR],
    extensions: EXTENSIONS,
    // 不用 --cache:见文件头 §3 的假绿风险。
    cache: false,
  };
  if (opts.probePlugin) {
    config.plugins = { 'dsh-git-probe': opts.probePlugin };
    config.overrideConfig = {
      // 插件必须在这里也声明一次:eslintrc 里 `plugin/rule` 形式的规则要能解析,
      // 靠的是 plugins 列表,而不只是 Node API 的 preloadedPlugins。
      plugins: ['dsh-git-probe'],
      rules: {
        // 把真正要跑的那份关掉,换成按规则**同源**包装的探针版本。
        'react-proper-lifecycle-methods': 'off',
        'react-readonly-props-and-state': 'off',
        'insecure-random': 'off',
        'dsh-git-probe/react-proper-lifecycle-methods': 'error',
        'dsh-git-probe/react-readonly-props-and-state': 'error',
        'dsh-git-probe/insecure-random': 'error',
      },
    };
  }

  const eslint = new ESLint(config);

  /** @type {any[]} */
  let results;
  try {
    results = await eslint.lintFiles(PATTERNS);
  } catch (err) {
    // ⚠️ ESLint 在「PATTERNS 一个文件都匹配不到」时是**抛** NoFilesFoundError,
    // 不是返回空数组。不接住它,闸门会在该失败的时候**崩栈**(栈里全是 eslint
    // 内部帧,看不出病根)。实测踩到过 —— 见 docs/lint-layer.md §5.4。
    const wrapped = new Error(`lintFiles 失败:${err?.message ?? err}`);
    wrapped.cause = err;
    throw wrapped;
  }

  /** @type {string[]} */
  const files = [];
  /** @type {Violations} */
  const violations = [];
  /** @type {{file: string, message: string}[]} */
  const fatal = [];

  for (const result of results) {
    files.push(rel(result.filePath));
    for (const message of result.messages) {
      // 解析/配置类错误没有 ruleId(或 ruleId === null)。必须单独报,否则
      // 「文件根本没被解析」会被当成「没有违规」。
      if (message.fatal === true || message.ruleId === null) {
        fatal.push({
          file: rel(result.filePath),
          message: `${message.line ?? 0}:${message.column ?? 0} ${message.message}`,
        });
        continue;
      }
      violations.push({
        file: rel(result.filePath),
        rule: message.ruleId,
        line: message.line ?? 0,
        column: message.column ?? 0,
        message: message.message,
        severity: message.severity ?? 2,
      });
    }
  }

  files.sort();
  return { files, violations, fatal };
}

/**
 * 把违规列表压成 `{ "文件": { "规则": 计数 } }`(基线的形状)。
 * @param {Violations} violations
 */
function toCounts(violations) {
  /** @type {Record<string, Record<string, number>>} */
  const byFileRule = {};
  for (const v of violations) {
    const rules = (byFileRule[v.file] ??= {});
    rules[v.rule] = (rules[v.rule] ?? 0) + 1;
  }
  // 键排序:基线文件的 diff 才可读。
  /** @type {Record<string, Record<string, number>>} */
  const sorted = {};
  for (const file of Object.keys(byFileRule).sort()) {
    /** @type {Record<string, number>} */
    const rules = {};
    for (const rule of Object.keys(byFileRule[file]).sort()) {rules[rule] = byFileRule[file][rule];}
    sorted[file] = rules;
  }
  return sorted;
}

/**
 * 汇总。
 * @param {Violations} violations
 * @param {Record<string, Record<string, number>>} counts
 */
function summarize(violations, counts) {
  /** @type {Record<string, number>} */
  const byRule = {};
  /** @type {Record<string, number>} */
  const byBucket = {};
  /** @type {Record<string, number>} */
  const byExt = {};
  for (const v of violations) {
    byRule[v.rule] = (byRule[v.rule] ?? 0) + 1;
    byBucket[bucketOf(v.file)] = (byBucket[bucketOf(v.file)] ?? 0) + 1;
    const ext = path.extname(v.file) || '(none)';
    byExt[ext] = (byExt[ext] ?? 0) + 1;
  }
  // 「内联 disable 指向未安装的规则」单独成一类:它不是代码 bug,而是
  // 「作者以为有条规则在管」的证据 —— 上游 jsx-a11y 的注释逐字进了镜像,
  // 我们自己的 6 处 react-hooks disable 也是同一族。刻意保留在违规里(它确实
  // 是配置缺陷),但要单独说清是什么。
  const deadDisables = violations.filter((v) => v.message.startsWith('Definition for rule '));
  const topFiles = Object.entries(counts)
    .map(([file, rules]) => ({
      file,
      total: Object.values(rules).reduce((a, b) => a + b, 0),
      rules,
    }))
    .sort((a, b) => b.total - a.total || a.file.localeCompare(b.file));
  return {
    total: violations.length,
    distinctFiles: Object.keys(counts).length,
    distinctRules: Object.keys(byRule).length,
    byRule,
    byBucket,
    byExt,
    topFiles,
    deadDisables: {
      count: deadDisables.length,
      byRule: deadDisables.reduce((acc, v) => {
        acc[v.rule] = (acc[v.rule] ?? 0) + 1;
        return acc;
      }, /** @type {Record<string, number>} */ ({})),
      sites: deadDisables.map((v) => `${v.file}:${v.line}`),
    },
  };
}

/**
 * 三层分类:噪声到底来自镜像树还是我们的适配层?
 * 这是「能不能变成硬闸门」的唯一判据。
 * @param {string} file
 */
function bucketOf(file) {
  if (file.startsWith('src/core/desktop/')) {return 'mirror(src/core/desktop)';}
  if (file.startsWith('src/client/')) {return 'adaptation(src/client)';}
  if (file.startsWith('src/host/')) {return 'adaptation(src/host)';}
  if (file.startsWith('src/core/')) {return 'adaptation(src/core 其余)';}
  if (file.startsWith('src/')) {return 'adaptation(src 顶层)';}
  if (file.startsWith('scripts/') || file.startsWith('eslint-rules/')) {return 'tooling(scripts+eslint-rules)';}
  if (file.startsWith('types/')) {return 'types(宿主 shim 声明)';}
  return 'other';
}

// ---------------------------------------------------------------------------
// 基线(棘轮)
// ---------------------------------------------------------------------------

/**
 * 读基线。不存在/坏掉 → 当空基线(只警告,绝不抛)。
 * @returns {Promise<Record<string, Record<string, number>>>}
 */
async function readBaseline() {
  let text = null;
  try {
    text = await readFile(BASELINE_PATH, 'utf8');
  } catch (err) {
    if (err?.code !== 'ENOENT') {warn(`基线读取失败,按空基线处理: ${rel(BASELINE_PATH)} (${err?.code ?? err})`);}
    return {};
  }
  try {
    const parsed = JSON.parse(text);
    const byFileRule = parsed?.byFileRule;
    if (byFileRule === null || typeof byFileRule !== 'object' || Array.isArray(byFileRule)) {
      warn(`基线格式不是 { "byFileRule": { "文件": { "规则": 计数 } } },按空基线处理: ${rel(BASELINE_PATH)}`);
      return {};
    }
    /** @type {Record<string, Record<string, number>>} */
    const out = {};
    for (const [file, rules] of Object.entries(byFileRule)) {
      if (rules === null || typeof rules !== 'object' || Array.isArray(rules)) {
        warn(`基线里 ${file} 的规则表不是对象,已忽略该文件`);
        continue;
      }
      /** @type {Record<string, number>} */
      const clean = {};
      for (const [rule, count] of Object.entries(rules)) {
        const n = Number(count);
        if (!Number.isFinite(n) || n < 0) {
          warn(`基线里 ${file} / ${rule} 的计数不是非负数,已忽略`);
          continue;
        }
        clean[rule] = n;
      }
      out[file] = clean;
    }
    return out;
  } catch (err) {
    warn(`基线不是合法 JSON,按空基线处理: ${rel(BASELINE_PATH)} (${err?.message ?? err})`);
    return {};
  }
}

/**
 * 棘轮对比。
 * @param {Record<string, Record<string, number>>} baseline
 * @param {Record<string, Record<string, number>>} current
 * @param {Violations} violations
 */
function diffAgainstBaseline(baseline, current, violations) {
  /** @type {{file: string, rule: string, was: number, now: number, delta: number, sample: string[]}[]} */
  const added = [];
  /** @type {{file: string, rule: string, was: number, now: number, delta: number}[]} */
  const improved = [];
  /** @type {{file: string, rule: string, was: number}[]} */
  const stale = [];

  for (const [file, rules] of Object.entries(current)) {
    for (const [rule, now] of Object.entries(rules)) {
      const was = baseline[file]?.[rule];
      if (was === undefined) {
        added.push({ file, rule, was: 0, now, delta: now, sample: samplesOf(violations, file, rule) });
      } else if (now > was) {
        added.push({ file, rule, was, now, delta: now - was, sample: samplesOf(violations, file, rule) });
      } else if (now < was) {
        improved.push({ file, rule, was, now, delta: was - now });
      }
    }
  }

  for (const [file, rules] of Object.entries(baseline)) {
    for (const [rule, was] of Object.entries(rules)) {
      const now = current[file]?.[rule];
      if (now === undefined || now === 0) {stale.push({ file, rule, was });}
    }
  }

  const byTotal = (a, b) => b.delta - a.delta || a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule);
  added.sort(byTotal);
  improved.sort(byTotal);
  stale.sort((a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule));
  return { added, improved, stale };
}

/**
 * 某个 (文件, 规则) 的前几个真实位置 —— 只在失败报告里给行号。
 * @param {Violations} violations
 * @param {string} file
 * @param {string} rule
 */
function samplesOf(violations, file, rule) {
  return violations
    .filter((v) => v.file === file && v.rule === rule)
    .slice(0, 3)
    .map((v) => `${file}:${v.line}:${v.column}  ${v.message}`);
}

// ---------------------------------------------------------------------------
// --coverage:证明规则真的访问到了节点
// ---------------------------------------------------------------------------

/**
 * 用**内存里的探针插件**跑一轮:探针把真规则的 visitor 包一层再调用它,
 * 所以数出来的是真规则真正走到的地方。
 * @param {any} ESLint
 */
async function runCoverage(ESLint) {
  const require = createRequire(import.meta.url);
  const load = (name) => {
    try {
      return require(path.join(RULES_DIR, `${name}.js`));
    } catch (err) {
      warn(`探针无法加载 eslint-rules/${name}.js: ${err?.message ?? err}`);
      return null;
    }
  };

  const real = {
    lifecycle: load('react-proper-lifecycle-methods'),
    readonly: load('react-readonly-props-and-state'),
    insecure: load('insecure-random'),
  };

  // 「哪些 class 算 React 组件」的判据**从规则文件里取**,不在这里复制一份 ——
  // 复制就会漂移,而漂移出来的覆盖率报告正是「读数好看、实际没跑」。
  // 该判据由 eslint-rules/react-proper-lifecycle-methods.js 末尾显式导出。
  const isReactClass =
    typeof real.lifecycle?.extendsReactComponent === 'function' ? real.lifecycle.extendsReactComponent : null;
  if (isReactClass === null) {
    warn(
      'eslint-rules/react-proper-lifecycle-methods.js 没有导出 extendsReactComponent;' +
        '--coverage 的 React class 分类不可用(访问计数仍然有效)',
    );
  }

  /** @type {Record<string, any>} */
  const stats = {
    lifecycle: {
      classDeclarations: 0,
      reactClasses: 0,
      reactClassesInTs: 0,
      methodDefinitions: 0,
      reservedPrefixMethods: 0,
      gatedLifecycleMethods: 0,
      reports: 0,
    },
    readonly: { interfaceDeclarations: 0, propsOrStateInterfaces: 0, propsOrStateInterfacesInTs: 0, reports: 0 },
    insecure: { callExpressions: 0, mathRandom: 0, pseudoRandomBytes: 0, reports: 0 },
  };

  /** 每条规则每个文件一份的门控状态(真规则里是 create() 的闭包变量)。 */
  const gate = { lifecycleReactClassSeen: false };
  const isTs = (filename) => /\.tsx?$/.test(filename) && !/\.tsx$/.test(filename);

  /**
   * 把真规则的 visitor 包一层计数,再**原样**调用它。
   *
   * ⚠️ 不要去包 `context.report`:ESLint 8 把 rule context 用 `Object.freeze()`
   * 冻住(`linter.js:1020`),`report` 是原型上的不可写属性,赋值会直接抛
   * `Cannot assign to read only property 'report'`。报告计数改从 lint 结果里按
   * ruleId 取 —— 那是同一批数据,不必劫持。
   *
   * @param {any} rule
   * @param {(key: string, node: any, context: any) => void} onVisit
   */
  function instrument(rule, onVisit) {
    if (rule === null) {return undefined;}
    return {
      meta: rule.meta,
      create(context) {
        // 每个文件一次:重置门控(与真规则里 create() 的闭包生命周期一致)。
        gate.lifecycleReactClassSeen = false;
        const visitors = rule.create(context);
        /** @type {Record<string, any>} */
        const wrapped = {};
        for (const [key, fn] of Object.entries(visitors)) {
          if (typeof fn !== 'function') {
            wrapped[key] = fn;
            continue;
          }
          wrapped[key] = (node) => {
            onVisit(key, node, context);
            return fn(node);
          };
        }
        return wrapped;
      },
    };
  }

  const probePlugin = {
    rules: {
      'react-proper-lifecycle-methods': instrument(
        real.lifecycle,
        (key, node, context) => {
          if (key === 'ClassDeclaration') {
            stats.lifecycle.classDeclarations += 1;
            if (isReactClass !== null && isReactClass(node)) {
              stats.lifecycle.reactClasses += 1;
              if (isTs(context.getFilename())) {stats.lifecycle.reactClassesInTs += 1;}
              gate.lifecycleReactClassSeen = true;
            }
          } else if (key === 'MethodDefinition') {
            stats.lifecycle.methodDefinitions += 1;
            const name = node.key?.type === 'Identifier' ? node.key.name : '';
            if (name.startsWith('component') || name.startsWith('shouldComponent')) {
              stats.lifecycle.reservedPrefixMethods += 1;
              if (gate.lifecycleReactClassSeen) {stats.lifecycle.gatedLifecycleMethods += 1;}
            }
          }
        },
      ),
      'react-readonly-props-and-state': instrument(
        real.readonly,
        (key, node, context) => {
          if (key === 'TSInterfaceDeclaration') {
            stats.readonly.interfaceDeclarations += 1;
            const name = node.id?.name ?? '';
            if (name.endsWith('Props') || name.endsWith('State')) {
              stats.readonly.propsOrStateInterfaces += 1;
              if (isTs(context.getFilename())) {stats.readonly.propsOrStateInterfacesInTs += 1;}
            }
          }
        },
      ),
      'insecure-random': instrument(
        real.insecure,
        (key, node) => {
          if (key !== 'CallExpression') {return;}
          stats.insecure.callExpressions += 1;
          const { callee } = node;
          if (
            callee?.type === 'MemberExpression' &&
            callee.object?.type === 'Identifier' &&
            callee.object.name === 'Math' &&
            callee.property?.type === 'Identifier' &&
            callee.property.name === 'random'
          ) {
            stats.insecure.mathRandom += 1;
          }
          if (
            (callee?.type === 'MemberExpression' &&
              callee.property?.type === 'Identifier' &&
              callee.property.name === 'pseudoRandomBytes') ||
            (callee?.type === 'Identifier' && callee.name === 'pseudoRandomBytes')
          ) {
            stats.insecure.pseudoRandomBytes += 1;
          }
        },
      ),
    },
  };

  const result = await runLint(ESLint, { probePlugin });

  // 报告计数从 lint 结果里取(探针规则的 ruleId 前缀是 `dsh-git-probe/`)。
  for (const v of result.violations) {
    const match = /^dsh-git-probe\/(.+)$/.exec(v.rule);
    if (match === null) {continue;}
    if (match[1] === 'react-proper-lifecycle-methods') {stats.lifecycle.reports += 1;}
    else if (match[1] === 'react-readonly-props-and-state') {stats.readonly.reports += 1;}
    else if (match[1] === 'insecure-random') {stats.insecure.reports += 1;}
  }

  return { stats, files: result.files, fatal: result.fatal };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** 解析命令行。 */
function parseArgs(argv) {
  const opts = { json: false, writeBaseline: false, coverage: false, help: false };
  for (const arg of argv) {
    if (arg === '--json') {opts.json = true;}
    else if (arg === '--write-baseline') {opts.writeBaseline = true;}
    else if (arg === '--coverage') {opts.coverage = true;}
    else if (arg === '--help' || arg === '-h') {opts.help = true;}
    else {warn(`忽略未知参数: ${arg}`);}
  }
  return opts;
}

const HELP = `用法: node scripts/check-lint.mjs [--json] [--write-baseline] [--coverage]

  ESLint 棘轮:把 GitHub Desktop 的自定义规则(eslint-rules/)接上,只拦**新增**违规。
  存量违规钉在 scripts/lint-baseline.json 里;计数下降算改进,上升算失败。

  --json             stdout 输出机器可读 JSON
  --write-baseline   用当前 (文件, 规则) 计数重写 scripts/lint-baseline.json
  --coverage         打印每条自定义规则**实际访问到**的节点数,并按扩展名分组
                     (证明规则没有静默访问 0 个节点 —— 那是本仓库反复踩的坑)
  -h, --help         这份帮助

  退出码:0 = 无新增;1 = 有新增违规;2 = eslint / eslint-rules 加载失败
  (缺工具绝不静默通过)

  范围(写死在脚本里,故意显式,便于证伪):
    ${PATTERNS.join('\n    ')}
  排除规则见 .eslintignore;分档见 .eslintrc.yml 的 overrides。
`;

/** 主流程。 */
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }

  // --- 0. 工具与规则文件 ---------------------------------------------------
  const missingRules = await checkRuleFiles();
  if (missingRules.length > 0) {
    process.stderr.write(
      `dsh-git/check-lint: eslint-rules/ 缺文件: ${missingRules.join(', ')}\n` +
        `  移植不完整,闸门不能跑(缺检查比检查失败更危险)。\n`,
    );
    process.exitCode = 2;
    return;
  }

  const loaded = loadEslint();
  if ('error' in loaded) {
    process.stderr.write(
      `dsh-git/check-lint: ${loaded.error}\n` +
        `  lint 层需要 devDependencies 里的 eslint / @typescript-eslint/* / eslint-plugin-react / eslint-config-prettier。\n` +
        `  跑 \`npm install\` 后重试。**退出码 2,不当作通过。**\n`,
    );
    process.exitCode = 2;
    return;
  }
  const { ESLint } = loaded;

  // --- 1. 跑一轮 ----------------------------------------------------------
  /** @type {{files: string[], violations: Violations, fatal: {file: string, message: string}[]}} */
  let lintResult;
  try {
    lintResult = await runLint(ESLint);
  } catch (err) {
    process.stderr.write(
      `dsh-git/check-lint: 无法执行 lint:${err?.message ?? err}\n` +
        `  检查 PATTERNS(${PATTERNS.join(', ')})与该目录下的 .eslintignore。\n` +
        `  **退出码 2,不当作通过。**\n`,
    );
    process.exitCode = 2;
    return;
  }
  const { files, violations, fatal } = lintResult;

  if (files.length === 0) {
    // 死 glob:范围一个文件都没扫到。这正是 H16 的教训,必须失败而不是通过。
    process.stderr.write(
      'dsh-git/check-lint: 范围里一个文件都没扫到(死 glob?)。检查 PATTERNS 与 .eslintignore。\n',
    );
    process.exitCode = 2;
    return;
  }

  // --- 1b. 范围对账:有没有文件被 .eslintignore 静默吞掉? -------------------
  const walked = await walkLintable();
  const scannedSet = new Set(files);
  const unlinted = walked.filter((f) => !scannedSet.has(f) && !SCOPE_EXEMPT.has(f));
  // ESLint 扫到、而裸遍历没预料到的(说明 PATTERNS 伸出了 SCOPE_ROOTS 之外)。
  const walkedSet = new Set(walked);
  const extraScanned = files.filter((f) => !walkedSet.has(f));
  if (extraScanned.length > 0) {
    warn(
      `PATTERNS 扫到了 ${extraScanned.length} 个 SCOPE_ROOTS 之外的文件(前 3 个:${extraScanned
        .slice(0, 3)
        .join(', ')});范围对账没覆盖它们,请把根加进 SCOPE_ROOTS。`,
    );
  }
  if (unlinted.length > 0) {
    process.stderr.write(
      `dsh-git/check-lint: ${unlinted.length} 个源码文件**没有**被 lint(静默跳过)。\n` +
        `  这是死 glob 家族的问题(H16),闸门不能带着它对账通过。前 20 个:\n` +
        unlinted
          .slice(0, 20)
          .map((f) => `    ${f}\n`)
          .join('') +
        (unlinted.length > 20 ? `    … 其余 ${unlinted.length - 20} 个\n` : '') +
        `  常见原因:.eslintignore 里少了根锚定 —— 写 \`lib/\` 会匹配**任意深度**的\n` +
        `  \`lib/\` 目录(如 src/core/desktop/ui/lib/**);必须写 \`/lib/\`。\n` +
        `  若确实要排除某个文件,把它加进 scripts/check-lint.mjs 的 SCOPE_EXEMPT 并写明理由。\n`,
    );
    process.exitCode = 2;
    return;
  }

  // 解析/配置级错误:文件没被真正分析过,不能计入「无违规」。
  if (fatal.length > 0) {
    process.stderr.write(`dsh-git/check-lint: ${fatal.length} 处解析/配置错误(这些文件没被分析):\n`);
    for (const f of fatal.slice(0, 20)) {process.stderr.write(`  ${f.message}\n`);}
    if (fatal.length > 20) {process.stderr.write(`  … 其余 ${fatal.length - 20} 处省略\n`);}
    process.exitCode = 2;
    return;
  }

  const counts = toCounts(violations);
  const summary = summarize(violations, counts);

  // --- 2. 基线对比 --------------------------------------------------------
  const baseline = await readBaseline();
  const { added, improved, stale } = diffAgainstBaseline(baseline, counts, violations);
  const baselineEmpty = Object.keys(baseline).length === 0;

  // --- 3. 写基线 ----------------------------------------------------------
  // `--write-baseline` 是「我确认接受当前状态」的显式动作,所以写完即 0;
  // 但它**不是**「修好了」—— 报告里会把这一点喊出来,免得被当成绿灯。
  const wroteBaseline = opts.writeBaseline;
  if (opts.writeBaseline) {
    const payload = {
      tool: 'dsh-git/scripts/check-lint.mjs',
      version: 1,
      note:
        'ESLint 棘轮基线:每个 (文件, 规则) 的**命中计数**。只拦上升;下降算改进。' +
        '计数不含行号(行号会漂移,会把「插了一行」误报成新增违规)。' +
        '实证触发方式见 docs/lint-layer.md §5。',
      rules: CUSTOM_RULES,
      scannedFiles: files.length,
      total: violations.length,
      byFileRule: counts,
    };
    const text = `${JSON.stringify(payload, null, 2)}\n`;
    try {
      await writeFile(BASELINE_PATH, text, 'utf8');
    } catch (err) {
      process.stderr.write(`dsh-git/check-lint: 基线写入失败: ${rel(BASELINE_PATH)} (${err?.message ?? err})\n`);
      process.exitCode = 2;
      return;
    }
    process.stderr.write(
      `dsh-git/check-lint: 已重写基线 ${rel(BASELINE_PATH)}(${Object.keys(counts).length} 个文件 / ${violations.length} 处命中)\n`,
    );
  }

  // --- 4. --coverage ------------------------------------------------------
  let coverage = null;
  if (opts.coverage) {
    try {
      coverage = await runCoverage(ESLint);
    } catch (err) {
      warn(`--coverage 探针失败(不影响棘轮判据): ${err?.message ?? err}`);
    }
  }

  const exitCode = wroteBaseline ? 0 : added.length > 0 ? 1 : 0;

  // --- 5. 输出 ------------------------------------------------------------
  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          tool: 'dsh-git/scripts/check-lint.mjs',
          patterns: PATTERNS,
          scanned: {
            files: files.length,
            extensions: EXTENSIONS,
            rulesDir: rel(RULES_DIR),
            // 范围对账:裸遍历应当与 ESLint 实际扫到的一致。
            walked: walked.length,
            unlinted: unlinted.length,
            exempt: [...SCOPE_EXEMPT.keys()],
            extraScanned,
          },
          customRules: CUSTOM_RULES,
          summary,
          baseline: {
            path: rel(BASELINE_PATH),
            present: !baselineEmpty,
            entries: Object.keys(baseline).length,
          },
          added,
          improved,
          stale,
          coverage: coverage
            ? { stats: coverage.stats, scannedFiles: coverage.files.length }
            : { skipped: true },
          warnings,
          exitCode,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    printReport({
      files,
      walked,
      unlinted,
      extraScanned,
      summary,
      baseline,
      baselineEmpty,
      added,
      improved,
      stale,
      coverage,
      opts,
    });
  }

  process.exitCode = exitCode;
}

/**
 * 人读报告。
 * @param {{files: string[], summary: any, baseline: any, baselineEmpty: boolean, added: any[], improved: any[], stale: any[], coverage: any, opts: any}} ctx
 */
function printReport(ctx) {
  const { files, walked, unlinted, extraScanned, summary, baseline, baselineEmpty, added, improved, stale, coverage, opts } = ctx;
  const out = (s = '') => process.stdout.write(`${s}\n`);

  out('dsh-git: ESLint 棘轮(check-lint)');
  out(`  规则目录   : ${rel(RULES_DIR)}(自定义规则 ${CUSTOM_RULES.join(', ')})`);
  out(`  扫到文件   : ${files.length} 个  ← 这个数字必须非 0;为 0 说明 glob 死了(H16)`);
  out(`  范围对账   : 裸遍历 ${walked.length} 个,ESLint 实际 ${files.length} 个;漏 lint ${unlinted.length} 个` +
    `(SCOPE_EXEMPT ${SCOPE_EXEMPT.size} 条;非 0 = 已被静默跳过)`);
  if (extraScanned.length > 0) {
    out(`              另有 ${extraScanned.length} 个在 SCOPE_ROOTS 之外(前 3:${extraScanned.slice(0, 3).join(', ')})`);
  }
  out(`  违规总数   : ${summary.total} 处,分布在 ${summary.distinctFiles} 个文件 / ${summary.distinctRules} 条规则`);
  out('');

  out('  按规则:');
  for (const [rule, n] of Object.entries(summary.byRule).sort((a, b) => b[1] - a[1])) {
    out(`    ${String(n).padStart(5)}  ${rule}`);
  }
  out('');

  out('  按层(决定这能不能变成硬闸门):');
  for (const [bucket, n] of Object.entries(summary.byBucket).sort((a, b) => b[1] - a[1])) {
    out(`    ${String(n).padStart(5)}  ${bucket}`);
  }
  out('');

  out('  按扩展名:');
  for (const [ext, n] of Object.entries(summary.byExt).sort((a, b) => b[1] - a[1])) {
    out(`    ${String(n).padStart(5)}  ${ext}`);
  }
  out('');

  if (summary.topFiles.length > 0) {
    out(`  违规最多的文件(前 10 / 共 ${summary.topFiles.length} 个):`);
    for (const f of summary.topFiles.slice(0, 10)) {
      const rules = Object.entries(f.rules)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([r, n]) => `${r}×${n}`)
        .join(', ');
      out(`    ${String(f.total).padStart(5)}  ${f.file.padEnd(58)} ${rules}`);
    }
    out('');
  }

  if (coverage && coverage.stats) {
    const s = coverage.stats;
    out('  规则覆盖率(证明规则真的访问到了节点,不是静默返回空 visitor):');
    out(`    react-proper-lifecycle-methods: ClassDeclaration 访问 ${s.lifecycle.classDeclarations},其中 ` +
      `React.Component/PureComponent ${s.lifecycle.reactClasses}(.ts 里 ${s.lifecycle.reactClassesInTs})`);
    out(`      MethodDefinition 访问 ${s.lifecycle.methodDefinitions};名字以 component/shouldComponent 开头 ${s.lifecycle.reservedPrefixMethods};` +
      `过门控(即规则真正检查的)${s.lifecycle.gatedLifecycleMethods}`);
    out(`      报出:${s.lifecycle.reports} 处`);
    out(`    react-readonly-props-and-state: TSInterfaceDeclaration 访问 ${s.readonly.interfaceDeclarations},` +
      `其中名字以 Props/State 结尾 ${s.readonly.propsOrStateInterfaces}(.ts 里 ${s.readonly.propsOrStateInterfacesInTs})`);
    out(`      报出:${s.readonly.reports} 处`);
    out(`    insecure-random: CallExpression 访问 ${s.insecure.callExpressions};` +
      `Math.random 命中 ${s.insecure.mathRandom};pseudoRandomBytes 命中 ${s.insecure.pseudoRandomBytes}`);
    out(`      报出:${s.insecure.reports} 处`);
    out('');
  } else if (!opts.coverage) {
    out('  规则覆盖率:未测(加 --coverage;H16 的教训:闸门必须能证明自己扫到了东西)');
    out('');
  }

  if (summary.deadDisables.count > 0) {
    out(`  内联 disable 指向**未安装**的规则 ${summary.deadDisables.count} 处 —— 那些 \`eslint-disable-next-line\` 禁的是空气:`);
    for (const [rule, n] of Object.entries(summary.deadDisables.byRule).sort((a, b) => b[1] - a[1])) {
      out(`    ${String(n).padStart(3)}  ${rule}`);
    }
    out(`    位置:${summary.deadDisables.sites.slice(0, 12).join(', ')}${summary.deadDisables.sites.length > 12 ? ` … +${summary.deadDisables.sites.length - 12}` : ''}`);
    out('');
  }

  if (baselineEmpty && !opts.writeBaseline) {
    out(`  基线:无 ${rel(BASELINE_PATH)} —— 首次落地请先跑:`);
    out('      node scripts/check-lint.mjs --write-baseline');
    out('    (在那之前,下面的「新增」会是全部存量违规 —— 这是刻意的,不静默通过)');
    out('');
  } else {
    out(`  基线:${rel(BASELINE_PATH)}(${Object.keys(baseline).length} 个文件有存量)`);
    out('');
  }

  if (opts.writeBaseline) {
    out(`  ⚠️ 基线已重写:${summary.distinctFiles} 个文件 / ${summary.total} 处命中被**钉进**基线。`);
    out('     这不是「修好了」,只是「从这一版起不许再涨」。要减少存量就得真去修(见 --json 的 byRule)。');
    out('');
  } else if (added.length > 0) {
    out(`  ✗ 新增违规 ${added.length} 条(基线里没有,或计数上升):`);
    for (const a of added.slice(0, 30)) {
      out(`    ${a.file}  [${a.rule}]  ${a.was} → ${a.now}  (+${a.delta})`);
      for (const sample of a.sample) {out(`        ${sample}`);}
    }
    if (added.length > 30) {out(`    … 其余 ${added.length - 30} 条省略(--json 拿全量)`);}
    out('');
    out('    修掉它们;**不要**为了让闸门变绿而重钉基线(那等于关掉闸门)。');
    out('');
  }

  if (improved.length > 0) {
    out(`  ✓ 改进 ${improved.length} 条(命中数下降;可重钉基线把它固化):`);
    for (const i of improved.slice(0, 15)) {out(`    ${i.file}  [${i.rule}]  ${i.was} → ${i.now}  (-${i.delta})`);}
    if (improved.length > 15) {out(`    … 其余 ${improved.length - 15} 条省略`);}
    out('');
  }

  if (stale.length > 0) {
    out(`  · 失效基线 ${stale.length} 条(违规已消失 / 文件没了;建议重钉基线):`);
    for (const s of stale.slice(0, 15)) {out(`    ${s.file}  [${s.rule}](基线 ${s.was})`);}
    if (stale.length > 15) {out(`    … 其余 ${stale.length - 15} 条省略`);}
    out('');
  }

  if (warnings.length > 0) {
    out(`  警告 ${warnings.length} 条(见 stderr):`);
    for (const w of warnings.slice(0, 10)) {out(`    ! ${w}`);}
    if (warnings.length > 10) {out(`    … 其余 ${warnings.length - 10} 条省略`);}
    out('');
  }

  // 与 main() 里那一个判据同式(只有这一处,不抽函数)。
  const code = opts.writeBaseline ? 0 : added.length > 0 ? 1 : 0;
  out(
    `  结论:${opts.writeBaseline ? 'BASELINE-WRITTEN(不是 PASS)' : added.length === 0 ? 'PASS' : `FAIL(${added.length} 条新增)`}  ` +
      `退出码 ${code}`,
  );
}

await main();
