#!/usr/bin/env node
/**
 * 祖先不可达检查(unreachable-ancestor check)—— 抓「**规则在,但它要求的祖先元素我们从不渲染**」。
 *
 * ## 1. 它防的是什么(第三类静默缺失)
 *
 * `scripts/check-base-recipes.mjs` 按**类名**判定:「这个类的规则在不在包里」。
 * 它抓不到的一类是:类名**有**规则、配方也**在**包里,但那条规则写成
 * 「`X` 之下的 `Y`」,而**祖先 `X` 我们的 DOM 里从来不存在** ⇒ 规则永远匹配不到。
 *
 * 与 goal 文档 §7 的 `.sr-only` 是**同一句话的第二次**:「类名存在 ≠ 规则生效」。
 * §10.9 把这一类明确记为「我的新检查器抓不到它」,并点名了两组实例:
 *   - `diff-contents-warning*` 的**全部** 4 条规则挂在 `.seamless-diff-switcher` 之下
 *     ⇒ 双向 Unicode 告警渲染成**贴在 diff 顶部的裸文本**(逻辑在、外观全丢);
 *   - `.panel.empty/.renamed/.binary` 的 6 条 `justify-content/align-items` 同样要求
 *     `.seamless-diff-switcher` ⇒ 二进制面板与文本空态**失去垂直居中**。
 *
 * 那 10 条选择器是本检查的**基准真值**。⚠️ 注意:在本次落地期间,另一条线已经
 * **真的把 `<SeamlessDiffSwitcher>` 挂进了 `src/client/desktop-diff.tsx`**(见该文件
 * 头部「2026-10 第二轮」),所以今天这 10 条**已经可达**、本检查**不再**对它们报警 ——
 * 这是修复生效的正确表现,不是检查失灵。证明它会响用的是 `/tmp` 夹具(见报告)。
 *
 * ## 2. 它怎么判定
 *
 * 1. 读编译产物,逐条选择器按**顶层组合子**拆成复合选择器(`gates-lib.splitCompounds`);
 * 2. **祖先** = 从末尾(主体)往前,凡是靠**后代空格**或**子选择器 `>`**连上来的复合选择器;
 *    一旦遇到兄弟组合子(`+` / `~`)就停止(见 §4 盲区);
 * 3. 每个祖先里要求的**类名**与 **id** 必须能在**渲染树**里发出 —— 渲染树 = 从 live 入口
 *    (`src/client/index.ts` + `src/client/diff-ui.ts`)沿**相对 import** 可达的模块,
 *    用与 `check-base-recipes.mjs` **同一份** `computeLiveModules` / `collectLiveClasses`
 *    (直接 import 那个模块,确保「活跃」只有一份定义);
 * 4. 祖先类(或 id)发不出来 ⇒ 记一条 finding,按**祖先**聚合(一条祖先可能压着几十条选择器)。
 *
 * ## 3. 为什么是**棘轮**而不是硬门禁
 *
 * 静态判定必然有假阳:**一个类可能由我们解析不到的组件发出**(动态 className、
 * 第三方库内部渲染、portal)。所以本检查用 `--write-baseline` 把「已知不可达的祖先」
 * 连同**逐条理由**钉进 `scripts/unreachable-ancestors-baseline.json`;之后**新增**的
 * 不可达祖先会让退出码变 1。要声明一个祖先「其实可达」,必须写清理由,而不是放宽判定。
 *
 * ## 4. 已知盲区(必须连同结论一起读)
 *
 * - **只看类名与 id**:祖先由**别的选择器形状**产生(元素名 `dialog`、属性
 *   `[data-x]`、`:nth-child`)时本检查看不见;`.label` 那种「要求 `body >` 祖先」的
 *   规则同样看不见;
 * - **可达 ≠ 已渲染**:类名出现在可达模块里就算「能发出」。一个组件可以被 import
 *   却从不被 `<JSX>` 实例化(§10.9 的 `.seamless-diff-switcher` 一度正是如此)——
 *   本检查会把这种情况判为「可达」。这是**已知的漏报方向**,不是假阳;
 * - **兄弟组合子之后不再往前追溯**:`A B + C` 里 `A` 实际上也是 `C` 的祖先
 *   (B 与 C 同父),本检查在 `+` 处停止 ⇒ 少报,不会多报;
 * - **portal**:挂在 `document.body` 的组件(tooltip/popover)拿不到作用域内的变量,
 *   它们的祖先链在作用域外,本检查只统计**作用域内**的选择器。
 *
 * 用法:
 *
 *     node scripts/check-unreachable-ancestors.mjs                  # 人读报告
 *     node scripts/check-unreachable-ancestors.mjs --json           # 机器可读
 *     node scripts/check-unreachable-ancestors.mjs --write-baseline # 钉住当前不可达祖先
 *     node scripts/check-unreachable-ancestors.mjs --help
 *
 * 退出码:0 = 没有未登记的不可达祖先;1 = 有;2 = 输入读不到(跳过)。
 *
 * @module dsh-git/scripts/check-unreachable-ancestors
 */

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ROOT,
  STYLE_MODULE,
  classesInSelector,
  createWarnings,
  idsInSelector,
  listSelectorGroups,
  parseArgs,
  readBaseline,
  readCompiledCss,
  readPortSurfaces,
  rel,
  splitCompounds,
  stripCssComments,
} from './gates-lib.mjs';

/** 基线(棘轮)文件。 */
const BASELINE_PATH = join(ROOT, 'scripts/unreachable-ancestors-baseline.json');

/** 基线顶层键。 */
const BASELINE_KEY = 'ancestors';

/** 活跃代码的扫描根(与 check-base-recipes 一致)。 */
const LIVE_ROOTS = [join(ROOT, 'src/core/desktop'), join(ROOT, 'src/client')];

/** 生成物/纯样式文件不参与类名采集(与 check-base-recipes 一致)。 */
const GENERATED_RE = /\.generated\.(ts|tsx)$/;
const STYLE_ONLY_RE = /^(styles|styles-base|desktop-diff-styles)\.ts$/;

const HELP = `用法: node scripts/check-unreachable-ancestors.mjs [--json] [--write-baseline]

  祖先不可达检查:编译产物里那些「要求的祖先类/id 我们的渲染树永远发不出来」的选择器
  (规则在、配方在,但祖先元素不存在 ⇒ 永不匹配)。
  退出码 0 = 没有未登记的不可达祖先;1 = 有;2 = 输入读不到(跳过)。

  --json             stdout 输出机器可读 JSON
  --write-baseline   用当前 finding 集合重写 scripts/unreachable-ancestors-baseline.json
  --help             显示本帮助
`;

/**
 * 从一条选择器里取出「祖先复合选择器」。
 * 从主体往前,只在**后代(空格)**与**子选择器(`>`)**上继续;遇到 `+`/`~` 停止。
 * @param {string} selector 单条选择器。
 * @returns {string[]} 祖先复合选择器(自外向内)。
 */
function ancestorCompounds(selector) {
  const compounds = splitCompounds(selector);
  if (compounds.length < 2) return [];
  /** @type {string[]} */
  const out = [];
  for (let i = compounds.length - 2; i >= 0; i--) {
    const combinator = compounds[i + 1].combinator;
    if (combinator !== ' ' && combinator !== '>') break;
    out.unshift(compounds[i].compound);
  }
  return out;
}

/** 主流程。 */
async function main() {
  const { warn, warnings } = createWarnings();
  const opts = parseArgs(process.argv.slice(2), ['--json', '--write-baseline'], warn);
  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }

  /*
   * 动态 import:`check-base-recipes.mjs` 是「活跃树」定义的唯一来源,但它**可能正被
   * 并发编辑**(语法错/半写状态)。静态 import 会让本脚本直接抛异常 ——
   * 闸门必须「读不到就跳过并警告」,不许把别人的中间态变成自己的崩溃。
   */
  /** @type {typeof import('./check-base-recipes.mjs')|null} */
  let base = null;
  try {
    base = await import('./check-base-recipes.mjs');
  } catch (err) {
    warn(`读不到 check-base-recipes.mjs(活跃树定义缺失): ${err instanceof Error ? err.message : String(err)}`);
  }

  const surfaces = await readPortSurfaces(warn);
  const css = await readCompiledCss(STYLE_MODULE, warn);
  if (surfaces === null || css === null || base === null) {
    process.stdout.write(
      opts.json
        ? `${JSON.stringify({ tool: 'dsh-git/scripts/check-unreachable-ancestors.mjs', skipped: true, warnings }, null, 2)}\n`
        : 'check-unreachable-ancestors: SKIP(输入读不到)\n',
    );
    process.exitCode = 2;
    return;
  }

  const clean = stripCssComments(css);
  const groups = listSelectorGroups(clean);
  const allSelectors = groups.flatMap((g) => g.selectors.map((s) => ({ selector: s, line: g.line })));

  /** CSS 里出现过的所有类名 —— 与 check-base-recipes 同一约定,用作「松候选」的过滤器。 */
  const universe = new Set();
  for (const m of clean.matchAll(/\.(-?[A-Za-z_][A-Za-z0-9_-]*)/g)) {
    if (m[1].endsWith('-')) continue;
    universe.add(m[1]);
  }

  /** 从 live 入口可达的模块(与 check-base-recipes 同一份实现)。 */
  const liveModules = await base.computeLiveModules(base.LIVE_ENTRIES);
  const missingEntries = base.LIVE_ENTRIES.filter((e) => !liveModules.has(e));
  for (const entry of missingEntries) warn(`活跃入口不可达(可达图可能不完整): ${rel(entry)}`);

  /** 渲染树里**能发出**的类名与 id。 */
  const emitted = new Set();
  const emittedIds = new Set();
  let liveFileCount = 0;
  for (const root of LIVE_ROOTS) {
    /** @type {string[]} */
    const files = [];
    /**
     * @param {string} dir 目录。
     */
    const walk = async (dir) => {
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
        if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) files.push(full);
      }
    };
    await walk(root);
    for (const file of files) {
      if (GENERATED_RE.test(file)) continue;
      if (STYLE_ONLY_RE.test(file.slice(file.lastIndexOf('/') + 1))) continue;
      if (!liveModules.has(file)) continue;
      let text;
      try {
        text = await readFile(file, 'utf8');
      } catch (err) {
        warn(`读不到活跃模块(可达类集可能不全): ${rel(file)} (${/** @type {NodeJS.ErrnoException} */ (err)?.code ?? err})`);
        continue;
      }
      liveFileCount++;
      for (const m of text.matchAll(/\bid\s*=\s*\{?\s*['"`]([A-Za-z][\w-]*)['"`]/g)) emittedIds.add(m[1]);
      for (const name of base.collectLiveClasses(text, file, universe, file.endsWith('.tsx')).keys()) emitted.add(name);
    }
  }

  /** 类名与 id 分开统计:它们的修法不同(补类名 vs 改选择器)。 */
  /** @type {Map<string, {ancestor: string, kind: string, selectors: {selector: string, line: number}[]}>} */
  const byAncestor = new Map();
  let selectorsWithAncestors = 0;
  for (const { selector, line } of allSelectors) {
    const ancestors = ancestorCompounds(selector);
    if (ancestors.length === 0) continue;
    selectorsWithAncestors++;
    for (const compound of ancestors) {
      /** @type {{name: string, kind: string}[]} */
      const requirements = [
        ...classesInSelector(compound).map((name) => ({ name, kind: 'class' })),
        ...idsInSelector(compound).map((name) => ({ name, kind: 'id' })),
      ];
      for (const requirement of requirements) {
        /* id 与类名分属两个集合:上游大量规则挂在宿主窗口的 id 下(`#repository` /
         * `#commit-list` / `#choose-branch`),那些 id 我们确实不渲染,所以必须真的判定,
         * 不能像早先那样「一律算可达」(那会漏报)或「一律算不可达」(那会满屏假阳)。 */
        const reachable = requirement.kind === 'id' ? emittedIds.has(requirement.name) : emitted.has(requirement.name);
        if (reachable) continue;
        const key = requirement.kind === 'id' ? `#${requirement.name}` : requirement.name;
        const existing = byAncestor.get(key);
        if (existing === undefined) {
          byAncestor.set(key, { ancestor: key, kind: requirement.kind, selectors: [{ selector, line }] });
        } else if (!existing.selectors.some((s) => s.selector === selector)) {
          existing.selectors.push({ selector, line });
        }
      }
    }
  }
  const findings = [...byAncestor.values()].sort((a, b) => b.selectors.length - a.selectors.length || a.ancestor.localeCompare(b.ancestor));
  const affectedSelectors = new Set(findings.flatMap((f) => f.selectors.map((s) => s.selector))).size;

  const baseline = await readBaseline(BASELINE_PATH, BASELINE_KEY, warn);
  if (opts.writeBaseline) {
    /** @type {Record<string, unknown>} */
    const next = {};
    for (const f of findings) {
      const previous = baseline[f.ancestor];
      const reason =
        previous !== null && typeof previous === 'object' && typeof (/** @type {Record<string, unknown>} */ (previous).reason) === 'string'
          ? String(/** @type {Record<string, unknown>} */ (previous).reason)
          : 'TODO: 说明这个祖先为什么发不出来(或它由哪个我们解析不到的组件发出);确认后写清理由,或补上那个祖先元素后从基线删除。';
      next[f.ancestor] = { reason, kind: f.kind, selectors: f.selectors.map((s) => s.selector) };
    }
    try {
      await writeFile(BASELINE_PATH, `${JSON.stringify({ [BASELINE_KEY]: next }, null, 2)}\n`, 'utf8');
      process.stderr.write(`check-unreachable-ancestors: 已写入基线 ${rel(BASELINE_PATH)}(${findings.length} 个祖先)\n`);
    } catch (err) {
      warn(`基线写入失败: ${rel(BASELINE_PATH)} (${/** @type {NodeJS.ErrnoException} */ (err)?.code ?? err})`);
    }
  }
  const baselineNow = opts.writeBaseline ? await readBaseline(BASELINE_PATH, BASELINE_KEY, warn) : baseline;
  const known = findings.filter((f) => Object.hasOwn(baselineNow, f.ancestor));
  const failing = findings.filter((f) => !Object.hasOwn(baselineNow, f.ancestor));
  const stale = Object.keys(baselineNow).filter((k) => !findings.some((f) => f.ancestor === k));

  const counts = {
    selectorGroups: groups.length,
    selectors: allSelectors.length,
    selectorsWithAncestors,
    emittedClasses: emitted.size,
    liveModulesReachable: liveModules.size,
    liveFilesScanned: liveFileCount,
    findings: findings.length,
    affectedSelectors,
    known: known.length,
    failing: failing.length,
    staleBaseline: stale.length,
  };

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          tool: 'dsh-git/scripts/check-unreachable-ancestors.mjs',
          counts,
          findings: findings.map((f) => ({
            ancestor: f.ancestor,
            kind: f.kind,
            known: Object.hasOwn(baselineNow, f.ancestor),
            reason: baselineNow[f.ancestor] ?? null,
            selectorCount: f.selectors.length,
            selectors: f.selectors.map((s) => s.selector),
          })),
          staleBaseline: stale,
          warnings,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    const out = (s = '') => process.stdout.write(`${s}\n`);
    out('dsh-git: 祖先不可达检查(unreachable-ancestor check)');
    out(
      `  输入:${counts.selectorGroups} 个规则 / ${counts.selectors} 条单选择器;` +
        `其中 ${counts.selectorsWithAncestors} 条带后代/子选择器祖先`,
    );
    out(
      `  渲染树:从 ${base.LIVE_ENTRIES.map((e) => rel(e)).join(' + ')} 可达 ${counts.liveModulesReachable} 个模块` +
        `(扫了 ${counts.liveFilesScanned} 个),能发出 ${counts.emittedClasses} 个类名`,
    );
    out(`  不可达祖先:**${counts.findings}** 个,压着 ${counts.affectedSelectors} 条选择器`);
    out(`    已登记 ${counts.known};未登记 ${counts.failing}`);
    out('');
    if (findings.length === 0) {
      out('  没有「祖先发不出来」的选择器。✓');
    } else {
      for (const f of findings) {
        const tag = Object.hasOwn(baselineNow, f.ancestor) ? 'known' : 'FAIL ';
        out(`    ${tag} ${f.ancestor} (${f.kind}) — ${f.selectors.length} 条选择器`);
        for (const s of f.selectors.slice(0, 3)) out(`           css:${s.line}  ${s.selector}`);
        if (f.selectors.length > 3) out(`           … 其余 ${f.selectors.length - 3} 条省略`);
      }
      if (failing.length > 0) {
        out('');
        out(`  → 未登记 ${failing.length} 个。补上那个祖先元素,或在确属可接受时:`);
        out('      node scripts/check-unreachable-ancestors.mjs --write-baseline');
      }
    }
    out('');
    if (stale.length > 0) {
      out(`  基线里已失效(${stale.length} 个祖先现在可达了,建议删除):`);
      for (const s of stale.slice(0, 12)) out(`    ${s}`);
      out('');
    }
    if (warnings.length > 0) {
      out(`  警告 ${warnings.length} 条:`);
      for (const w of warnings.slice(0, 10)) out(`    ! ${w}`);
      out('');
    }
    out(`  基线:${rel(BASELINE_PATH)}(${Object.keys(baselineNow).length} 个祖先)`);
    out(`  结论:${failing.length === 0 ? 'PASS' : `FAIL(${failing.length} 个未登记)`}  退出码 ${failing.length === 0 ? 0 : 1}`);
  }

  process.exitCode = failing.length > 0 ? 1 : 0;
}

await main();
