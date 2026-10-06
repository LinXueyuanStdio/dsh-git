#!/usr/bin/env node
/**
 * 作用域根重复检查(scope-root duplicate check)—— 抓「**单条选择器里作用域根出现 >1 次**」
 * 这一类**永不匹配**的死规则。
 *
 * ## 1. 它防的是什么(新发现的一类静默缺失)
 *
 * 本插件的样式是「**嵌套 `@import` + 作用域根**」编译出来的:入口 SCSS 把上游 partial
 * 包在 `.gw-desktop-diff { … }`(嵌套导入)里,于是每条选择器都带上一个作用域根前缀。
 *
 * 上当的写法是**一条选择器里出现两个 `&`**:
 *
 *     // references/desktop/app/styles/ui/_tab-bar.scss:33
 *     .tab-bar {
 *       &.tabs &-item { … }        // 第二个 `&` 被展开成**完整父选择器**(含作用域根)
 *     }
 *
 * Dart Sass 把第二个 `&` 替换成**完整父选择器**,产物长成:
 *
 *     .gw-desktop-diff .tab-bar.tabs .gw-desktop-diff .tab-bar-item { … }
 *                    ^^^^^^^^^^^^^^^^ 第一个根          ^^^^^^^^^^^^^^^^ 第二个根
 *
 * 这条规则要求「`.tab-bar.tabs` **里面**再有一个 `.gw-desktop-diff`」—— 我们的 DOM 里
 * 不存在嵌套的作用域根,所以它**永远匹配不到任何一个节点**。产物里有 42 条这样的选择器
 * (19 个规则块),它们贡献的全部样式(选中下划线 / switch 选中底 / vertical 排布)
 * **静默消失**。
 *
 * ## 2. 为什么现有三道守卫全放它过去
 *
 * - 类名覆盖率:`.tab-bar` / `.tab-bar-item` / `.tab-bar-separator` **都在**产物里 ⇒ 绿;
 * - `scripts/check-base-recipes.mjs`:基础配方那三个选择器**是对的**(单前缀),
 *   所以它判 `ok`;真正死掉的是**变体**规则;
 * - 构建:CSS 语法完全合法,不报任何错。
 *
 * 又是一次「**类名存在 ≠ 规则生效**」(goal 文档 §7 的 `.sr-only` 是同一句话的第一次)。
 *
 * ## 3. 它怎么判定
 *
 * 读编译产物 `src/client/desktop-diff-styles.generated.ts` → 逐条**单选择器**统计
 * 白名单作用域根(`scripts/styles.mjs` 的 `PORT_SCOPES`,**只读**)出现的次数;
 * `总次数 > 1` ⇒ 记一条 finding。按完整类名 token 匹配,`.gw-split` 不会被
 * `.gw-split-x` 误计。
 *
 * ## 4. 已知盲区
 *
 * - 它只看**编译产物**,看不到运行期拼出来的类名(与本仓库其它 CSS 探针一样);
 * - 「作用域根出现两次」在**理论上**可以合法(某个移植面真的嵌套在自己的作用域里)。
 *   今天没有这种面;真出现时应当在基线里写明理由,而不是放宽判定;
 * - 「来源」是**提示**不是证明:它列出上游 `& … &` 形状的选择器(≥2 个 `&`),
 *   需要人工核对是否就是那条死规则的来源。
 *
 * ## 5. 修法(不在本脚本职责内)
 *
 * 死规则的根因是**上游 partial 的写法 × 我们的作用域技术**。可选修法(都在
 * `src/client/scss/**`,由样式那条线持有):
 *   a. 入口 SCSS 不再整份导入 `ui/_tab-bar.scss`,而是把那 3 个变体规则
 *      **手写到作用域内**(代价:偏离「逐字编译上游 SCSS」);
 *   b. 或在编译后用 `scripts/styles.mjs` 的规则改写步骤把第二段作用域根去掉
 *      (产物正确,但改的是编译结果,不容易审计);
 *   c. 或接受这些变体规则不可用,**在样式层为需要的变体补一条等价规则**
 *      (与 `.sr-only` 的 local compensation 同一套路)。
 * 本脚本只负责**把这类规则永久钉住**,不替样式线做选择。
 *
 * ## 6. 棘轮,不是硬门禁(诚实交代)
 *
 * 今天产物里**确实有** 42 条死选择器,所以本脚本**不是**干净通过的硬门禁:
 * 它跑 `--write-baseline` 之后把这些钉进 `scripts/scope-roots-baseline.json`,
 * 之后**任何新增**的作用域根重复都会让退出码变成 1。修掉一条就从基线里删一条。
 *
 * 用法:
 *
 *     node scripts/check-scope-roots.mjs                 # 人读报告
 *     node scripts/check-scope-roots.mjs --json          # 机器可读(stdout 纯 JSON)
 *     node scripts/check-scope-roots.mjs --write-baseline # 用当前 finding 重写基线
 *
 * 退出码:0 = 没有未登记的作用域根重复;1 = 有未登记的。
 * 健壮性:产物读不到 / 形状变了 / 白名单读不到 → 警告并以退出码 **2(SKIP)** 结束,
 * 绝不抛异常,也绝不假装通过。
 *
 * @module dsh-git/scripts/check-scope-roots
 */

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ROOT,
  STYLE_MODULE,
  createWarnings,
  countScopeRoots,
  isFile,
  listSelectorGroups,
  parseArgs,
  readBaseline,
  readCompiledCss,
  readPortSurfaces,
  rel,
  stripCssComments,
} from './gates-lib.mjs';

/** 基线(棘轮)文件。 */
const BASELINE_PATH = join(ROOT, 'scripts/scope-roots-baseline.json');

/** 基线顶层键。 */
const BASELINE_KEY = 'selectors';

/**
 * 「来源提示」的扫描根:只有一个 `src/client/scss`。
 *
 * 上游样式表已移植进 `src/client/scss/upstream/**`,所以这里**不需要**第二条根:
 * 以前那条 `references/desktop/app/styles`(本机上游 checkout)被 `.gitignore:221`
 * 排除 ⇒ CI 里不存在;换成 `vendor/desktop/styles` 一样被 `.gitignore:224` 排除。
 * 扫描面与**构建实际编译**的文件集合现在是同一棵树。
 */
const SCSS_ROOTS = [join(ROOT, 'src/client/scss')];

/**
 * 默认基线理由(写基线时用;已有理由会被保留)。
 * @param {string} selector 死选择器。
 * @returns {string} 理由。
 */
function defaultReason(selector) {
  return (
    '嵌套 @import 把第二个 `&` 展开成**完整父选择器(含作用域根)**,产物里作用域根出现两次 ⇒ 永不匹配。' +
    '机制与修法见 `scripts/check-scope-roots.mjs` 头部;上游来源多为 `ui/_tab-bar.scss:33,93,127`。' +
    `死选择器:${selector}`
  );
}

/**
 * 找「& … &」形状的上游选择器(≥2 个 `&`),作为死规则的**来源提示**。
 * 不抛;读不到的目录/文件跳过。
 * @param {(message: string) => void} warn 警告函数。
 * @returns {Promise<{file: string, line: number, selector: string}[]>} 提示列表。
 */
async function findDoubleAmpersandSites(warn) {
  /** @type {{file: string, line: number, selector: string}[]} */
  const out = [];
  /**
   * @param {string} dir 目录。
   */
  async function walk(dir) {
    /** @type {import('node:fs').Dirent[]} */
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
        continue;
      }
      if (!entry.name.endsWith('.scss')) continue;
      let text;
      try {
        text = await readFile(full, 'utf8');
      } catch (err) {
        warn(`读不到 SCSS(来源提示可能不全): ${rel(full)} (${/** @type {NodeJS.ErrnoException} */ (err)?.code ?? err})`);
        continue;
      }
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const withoutComment = raw.replace(/\/\/.*$/, '');
        const trimmed = withoutComment.trim();
        // 跳过块注释里的行(`* …`):它们只是**说明文字**(本仓库的 SCSS 注释里就引用了
        // `&.tabs &-item` 这个形状),不是真的选择器 —— 误收会让「来源提示」变成噪声。
        if (trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
        if (withoutComment.indexOf('&') === -1) continue;
        const ampersands = (withoutComment.match(/&/g) ?? []).length;
        if (ampersands < 2) continue;
        // 只认「像选择器」的行:以 & . # 字母开头,且不是纯声明
        if (trimmed.includes(':') && !trimmed.startsWith('&') && !trimmed.startsWith('.') && !trimmed.startsWith('#')) continue;
        out.push({ file: full, line: i + 1, selector: trimmed });
      }
    }
  }
  for (const root of SCSS_ROOTS) {
    if (!(await isFile(root)) && !(await isDirectory(root))) {
      warn(`来源提示的扫描根不存在(跳过): ${rel(root)}`);
      continue;
    }
    await walk(root);
  }
  return out;
}

/**
 * 是否是目录(不抛)。
 * @param {string} p 路径。
 * @returns {Promise<boolean>} 是否目录。
 */
async function isDirectory(p) {
  try {
    const { stat } = await import('node:fs/promises');
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

const HELP = `用法: node scripts/check-scope-roots.mjs [--json] [--write-baseline]

  作用域根重复检查:找「单条选择器里作用域根出现 >1 次」的死规则
  (嵌套 @import 把第二个 & 展开成含作用域根的完整父选择器 ⇒ 永不匹配)。
  退出码 0 = 没有未登记的重复;1 = 有未登记的;2 = 输入读不到(跳过)。

  --json             stdout 输出机器可读 JSON
  --write-baseline   用当前 finding 集合重写 scripts/scope-roots-baseline.json(棘轮)
  --help             显示本帮助
`;

/** 主流程。 */
async function main() {
  const { warn, warnings } = createWarnings();
  const opts = parseArgs(process.argv.slice(2), ['--json', '--write-baseline'], warn);
  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }

  const surfaces = await readPortSurfaces(warn);
  const css = await readCompiledCss(STYLE_MODULE, warn);
  if (surfaces === null || css === null) {
    process.stdout.write(
      opts.json
        ? `${JSON.stringify({ tool: 'dsh-git/scripts/check-scope-roots.mjs', skipped: true, warnings }, null, 2)}\n`
        : `check-scope-roots: SKIP(输入读不到:${surfaces === null ? 'PORT_SCOPES ' : ''}${css === null ? rel(STYLE_MODULE) : ''})\n`,
    );
    process.exitCode = 2;
    return;
  }

  const clean = stripCssComments(css);
  const groups = listSelectorGroups(clean);
  const allSelectors = groups.flatMap((g) => g.selectors.map((s) => ({ selector: s, line: g.line })));

  /**
   * 按**选择器文本**聚合:同一条死选择器在产物里可能出现多次
   * (实证:19 个唯一选择器出现 42 次 —— `desktop-diff.scss` 同时是 `diff` 与 `split`
   * 两个移植面的入口,tab-bar partial 因此被编译了两遍)。基线按**唯一选择器**登记,
   * 这样同一形状被复制多少次都只算一条债。
   * @type {Map<string, {selector: string, lines: number[], scopes: {scope: string, count: number}[], occurrences: number}>}
   */
  const bySelector = new Map();
  for (const { selector, line } of allSelectors) {
    const scopes = countScopeRoots(selector, surfaces.scopes);
    const total = scopes.reduce((sum, s) => sum + s.count, 0);
    if (total <= 1) continue;
    const existing = bySelector.get(selector);
    if (existing === undefined) {
      bySelector.set(selector, { selector, lines: [line], scopes, occurrences: 1 });
    } else {
      existing.lines.push(line);
      existing.occurrences++;
    }
  }
  const findings = [...bySelector.values()].sort((a, b) => a.selector.localeCompare(b.selector));
  const occurrences = findings.reduce((sum, f) => sum + f.occurrences, 0);

  const baseline = await readBaseline(BASELINE_PATH, BASELINE_KEY, warn);
  if (opts.writeBaseline) {
    /** @type {Record<string, string>} */
    const next = {};
    for (const f of findings) {
      next[f.selector] = typeof baseline[f.selector] === 'string' ? String(baseline[f.selector]) : defaultReason(f.selector);
    }
    try {
      await writeFile(BASELINE_PATH, `${JSON.stringify({ [BASELINE_KEY]: next }, null, 2)}\n`, 'utf8');
      process.stderr.write(`check-scope-roots: 已写入基线 ${rel(BASELINE_PATH)}(${findings.length} 条)\n`);
    } catch (err) {
      warn(`基线写入失败: ${rel(BASELINE_PATH)} (${/** @type {NodeJS.ErrnoException} */ (err)?.code ?? err})`);
    }
  }
  const baselineNow = opts.writeBaseline ? await readBaseline(BASELINE_PATH, BASELINE_KEY, warn) : baseline;
  const known = findings.filter((f) => Object.hasOwn(baselineNow, f.selector));
  const failing = findings.filter((f) => !Object.hasOwn(baselineNow, f.selector));
  const stale = Object.keys(baselineNow).filter((s) => !findings.some((f) => f.selector === s));

  /* 没有 finding 时不必扫来源提示:提示是给「这条死规则从哪来」用的。 */
  const originHints = findings.length > 0 ? await findDoubleAmpersandSites(warn) : [];

  const counts = {
    selectorGroups: groups.length,
    selectors: allSelectors.length,
    scopeRoots: surfaces.scopes.length,
    findings: findings.length,
    occurrences,
    known: known.length,
    failing: failing.length,
    staleBaseline: stale.length,
    originHints: originHints.length,
  };

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          tool: 'dsh-git/scripts/check-scope-roots.mjs',
          counts,
          scopes: surfaces.scopes,
          findings: findings.map((f) => ({
            selector: f.selector,
            cssLines: f.lines,
            occurrences: f.occurrences,
            scopes: f.scopes,
            known: Object.hasOwn(baselineNow, f.selector),
            reason: baselineNow[f.selector] ?? null,
          })),
          originHints: originHints.map((h) => ({ file: rel(h.file), line: h.line, selector: h.selector })),
          staleBaseline: stale,
          warnings,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    const out = (s = '') => process.stdout.write(`${s}\n`);
    out('dsh-git: 作用域根重复检查(scope-root duplicate check)');
    out(
      `  扫描:${counts.selectorGroups} 个规则 / ${counts.selectors} 条单选择器 / ` +
        `${counts.scopeRoots} 个作用域根(${surfaces.scopes.join(' ')})`,
    );
    out(
      `  作用域根出现 >1 次:${counts.findings} 条**唯一**选择器,在产物里共出现 ${counts.occurrences} 次` +
        `(产物里同一条被复制多次 ⇒ 每一个都是死规则)`,
    );
    out(`    已登记 ${counts.known};**未登记 ${counts.failing}**`);
    out('');
    if (findings.length === 0) {
      out('  没有作用域根重复的选择器。✓');
    } else {
      out('  逐条(known = 已登记基线;xN = 在产物里出现 N 次;scopes 是每个根出现的次数):');
      for (const f of findings) {
        const tag = Object.hasOwn(baselineNow, f.selector) ? 'known' : 'FAIL ';
        const scopeText = f.scopes.map((s) => `${s.scope}×${s.count}`).join(' ');
        out(`    ${tag} x${String(f.occurrences).padEnd(2)} css:${f.lines.join(',').padEnd(12)} ${scopeText.padEnd(24)} ${f.selector}`);
      }
      if (failing.length > 0) {
        out('');
        out(`  → 未登记 ${failing.length} 条。修掉,或在确属可接受时:`);
        out('      node scripts/check-scope-roots.mjs --write-baseline');
      }
    }
    out('');
    if (stale.length > 0) {
      out(`  基线里已失效(${stale.length} 条,建议删除):`);
      for (const s of stale.slice(0, 10)) out(`    ${s}`);
      out('');
    }
    if (originHints.length > 0) {
      out(`  「& … &」来源提示(上游有 ${originHints.length} 处选择器含 ≥2 个 &,需人工核对):`);
      for (const h of originHints) out(`    ${rel(h.file)}:${h.line}   ${h.selector}`);
      out('');
    }
    out(`  基线:${rel(BASELINE_PATH)}(${Object.keys(baselineNow).length} 条)`);
    if (warnings.length > 0) {
      out('');
      out(`  警告 ${warnings.length} 条:`);
      for (const w of warnings.slice(0, 10)) out(`    ! ${w}`);
    }
    out('');
    out(`  结论:${failing.length === 0 ? 'PASS' : `FAIL(${failing.length} 条未登记)`}  退出码 ${failing.length === 0 ? 0 : 1}`);
  }

  process.exitCode = failing.length > 0 ? 1 : 0;
}

await main();
