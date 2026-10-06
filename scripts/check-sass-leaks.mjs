#!/usr/bin/env node
/**
 * Sass 变量泄漏检查(`$var` leak check)—— 抓「编译产物里还残留没被编码的 `$变量`」。
 *
 * ## 1. 它防的是什么
 *
 * Sass 的 `$var` 应当**全部**在编译期被求值替换掉。产物 `.css` 里若还出现 `$foo`,
 * 说明某个环节把 Sass 变量原样漏进了 CSS。浏览器遇到不认识的 token 会
 * **静默丢弃整条声明**(甚至整条规则)—— 没有报错、没有警告、构建全绿,样式就是没生效。
 * 这与本项目已经付过代价的两类事故同族:
 *
 *   - 未定义的 `var()` 让整条声明失效(goal 文档 §3 失败模式 10:`--gw-mono` 被 4 处使用
 *     却从未定义,那些地方一直静默地不是等宽字体);
 *   - `--drag-overlay-z-index` 未定义 ⇒ `.resize-handle` 的 `z-index` 整条失效
 *     (见 `src/client/scss/desktop-diff.scss` 里那条就地补值的注释)。
 *
 * 上游 GitHub Desktop 有同一判据的检查器
 * (`references/desktop/script/validate-sass/validate-file.ts`,生产构建后调用),
 * 本次审计记录在 `docs/toolchain-adoption.md` H12。
 *
 * ## 2. 为什么不能沿用上游的实现(审计自己抓到的缺陷)
 *
 * 上游 `validate-file.ts:25` 是**裸 `line.indexOf('$')`** —— 注释里提到 `$var` 也判失败。
 * 我们产物的注释是中文散文,里面大量引用 Sass 变量名(例如
 * 「`$gray-300`:上游 `_repository-list.scss:115` 用它给 `<kbd>` 上边框色」),
 * 沿用会立刻产生一批假报,闸门随即变成噪声源、被人关掉。
 *
 * 所以本脚本**先剥 CSS 注释**(保留换行,行号仍有效)再扫描,并且把
 * 「出现在字符串字面量里的 `$`」单独列为**提示**(不是失败)—— Sass 泄漏出来的
 * `$var` 不会在字符串里(那需要显式插值),所以字符串里的 `$` 基本是 `content: "$"`
 * 这类合法内容。
 *
 * ## 3. 诚实交代:这是一条**前瞻性棘轮**,今天不响
 *
 * 实测当前产物里共 22 个 `$`,**全部在 `/* … *​/` 注释内**(例如 `$gray-300` ×2、`$x` ×2、
 * `$blue`、`$gray-100`、`$gray-200` 等,逐处核对过上下文)。剥掉注释后**真实泄漏数是 0**。
 * 也就是说:它不是修 bug,而是把「未来某次 Sass 改动能把变量漏进产物」这件事变成红灯。
 * 报告里会同时打印「原始 `$` 数」与「剥注释后的泄漏数」,这两个数字的差就是注释贡献的噪声,
 * 由脚本自己证明「必须剥注释」这个决定。
 *
 * ## 4. 已知盲区
 *
 * - 只看**编译产物**:`var(--x)` 未定义是**同族但不同**的失败模式,本脚本**不管**
 *   (令牌检查 `checkInlineTokens` 管内联的 `--dsw-alias-*`,CSS 里的 `var()` 解析仍无人管);
 * - 生成的模块是 TS 字符串常量,不是 `.css` 文件;若那条线换产物形状,
 *   `readCompiledCss()` 会警告并 SKIP(退出码 2),不会假装通过;
 * - 扫描目标 = `src/client/**` 下所有 `*.generated.ts`(当前只有 1 个),新增移植面自动纳入。
 *
 * 用法:
 *
 *     node scripts/check-sass-leaks.mjs                  # 人读报告
 *     node scripts/check-sass-leaks.mjs --json           # 机器可读(stdout 纯 JSON)
 *     node scripts/check-sass-leaks.mjs --write-baseline # 用当前泄漏集合重写基线(棘轮)
 *     node scripts/check-sass-leaks.mjs --help
 *
 * 退出码:0 = 没有未登记的泄漏;1 = 有未登记的泄漏;2 = 输入读不到(跳过)。
 *
 * @module dsh-git/scripts/check-sass-leaks
 */

import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ROOT,
  createWarnings,
  isFile,
  parseArgs,
  readBaseline,
  readCompiledCss,
  rel,
  stripCssComments,
} from './gates-lib.mjs';

/** 基线(棘轮)文件。当前应为空 —— 这条闸门今天不响。 */
const BASELINE_PATH = join(ROOT, 'scripts/sass-leaks-baseline.json');

/** 基线顶层键。 */
const BASELINE_KEY = 'leaks';

/** 扫描根:我们自己的客户端源码里所有生成物。 */
const SCAN_ROOT = join(ROOT, 'src/client');

/**
 * 列出所有编译产物模块(`*.generated.ts`)。
 * @param {(message: string) => void} warn 警告函数。
 * @returns {Promise<string[]>} 绝对路径(排序)。
 */
async function listGeneratedModules(warn) {
  /** @type {string[]} */
  const out = [];
  try {
    for (const entry of await readdir(SCAN_ROOT, { withFileTypes: true })) {
      if (entry.isDirectory()) continue;
      if (!entry.name.endsWith('.generated.ts')) continue;
      out.push(join(SCAN_ROOT, entry.name));
    }
  } catch (err) {
    warn(`读不到扫描目录(无法列出编译产物): ${rel(SCAN_ROOT)} (${/** @type {NodeJS.ErrnoException} */ (err)?.code ?? err})`);
  }
  out.sort();
  return out;
}

/**
 * 标出文本里所有**字符串字面量**区间(单/双引号,含转义)。
 * @param {string} text 文本。
 * @returns {{start: number, end: number}[]} 区间(闭区间)。
 */
function stringSpans(text) {
  /** @type {{start: number, end: number}[]} */
  const spans = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const start = i;
      i++;
      while (i < text.length) {
        if (text[i] === '\\') {
          i += 2;
          continue;
        }
        if (text[i] === c) {
          i++;
          break;
        }
        i++;
      }
      spans.push({ start, end: i - 1 });
      continue;
    }
    i++;
  }
  return spans;
}

/**
 * 取一段文本所在的整条声明(到 `;` / `{` / `}` / 换行为止),用于报告与基线键。
 * @param {string} text 已剥注释的文本。
 * @param {number} at `$` 的下标。
 * @returns {string} 归一化后的声明片段。
 */
function declarationAt(text, at) {
  let start = at;
  while (start > 0 && !/[;{}\n]/.test(text[start - 1])) start--;
  let end = at;
  while (end < text.length && !/[;{}\n]/.test(text[end])) end++;
  return text.slice(start, end).trim().replace(/\s+/g, ' ');
}

const HELP = `用法: node scripts/check-sass-leaks.mjs [--json] [--write-baseline]

  Sass 变量泄漏检查:编译产物里残留的 \`$变量\`(浏览器会静默丢弃整条声明)。
  先剥 CSS 注释再扫描,避免上游实现(\`line.indexOf('$')\`)的注释误报。
  退出码 0 = 没有未登记泄漏;1 = 有;2 = 输入读不到(跳过)。

  --json             stdout 输出机器可读 JSON
  --write-baseline   用当前泄漏集合重写 scripts/sass-leaks-baseline.json(棘轮)
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

  const modules = await listGeneratedModules(warn);
  if (modules.length === 0) {
    warn('一个编译产物模块都没找到 —— 结果不可信(闸门的 glob 必须能被证伪)');
    process.stdout.write(
      opts.json ? `${JSON.stringify({ tool: 'dsh-git/scripts/check-sass-leaks.mjs', skipped: true, warnings }, null, 2)}\n` : 'check-sass-leaks: SKIP(没有扫描到任何 *.generated.ts)\n',
    );
    process.exitCode = 2;
    return;
  }

  let rawDollarTotal = 0;
  let scannedBytes = 0;
  /** @type {{file: string, line: number, declaration: string, inString: boolean, context: string}[]} */
  const leaks = [];
  /** @type {{file: string, line: number, declaration: string, inString: boolean, context: string}[]} */
  const inStrings = [];
  let readFailures = 0;

  for (const file of modules) {
    const css = await readCompiledCss(file, warn);
    if (css === null) {
      readFailures++;
      continue;
    }
    scannedBytes += Buffer.byteLength(css, 'utf8');
    rawDollarTotal += (css.match(/\$/g) ?? []).length;
    const clean = stripCssComments(css);
    const spans = stringSpans(clean);
    let line = 1;
    let lineStart = 0;
    for (let i = 0; i < clean.length; i++) {
      if (clean[i] === '\n') {
        line++;
        lineStart = i + 1;
        continue;
      }
      if (clean[i] !== '$') continue;
      const inString = spans.some((s) => i >= s.start && i <= s.end);
      const entry = {
        file: rel(file),
        line,
        declaration: declarationAt(clean, i),
        inString,
        context: clean.slice(Math.max(lineStart, i - 40), i + 40).replace(/\s+/g, ' ').trim(),
      };
      if (inString) inStrings.push(entry);
      else leaks.push(entry);
    }
  }

  if (readFailures > 0 && leaks.length === 0) {
    warn(`${readFailures} 个产物读不到 —— 泄漏数 0 不可信`);
    process.exitCode = 2;
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ tool: 'dsh-git/scripts/check-sass-leaks.mjs', skipped: true, warnings }, null, 2)}\n`);
    } else {
      process.stdout.write('check-sass-leaks: SKIP(产物读不到,0 不可信)\n');
    }
    return;
  }

  const baseline = await readBaseline(BASELINE_PATH, BASELINE_KEY, warn);
  if (opts.writeBaseline) {
    /** @type {Record<string, string>} */
    const next = {};
    for (const leak of leaks) {
      const key = leak.declaration;
      next[key] = typeof baseline[key] === 'string' ? String(baseline[key]) : `TODO: 说明这条 \`$var\` 为什么还在产物里;修掉后从基线删除。出现于 ${leak.file}:${leak.line}`;
    }
    try {
      await writeFile(BASELINE_PATH, `${JSON.stringify({ [BASELINE_KEY]: next }, null, 2)}\n`, 'utf8');
      process.stderr.write(`check-sass-leaks: 已写入基线 ${rel(BASELINE_PATH)}(${leaks.length} 条)\n`);
    } catch (err) {
      warn(`基线写入失败: ${rel(BASELINE_PATH)} (${/** @type {NodeJS.ErrnoException} */ (err)?.code ?? err})`);
    }
  }
  const baselineNow = opts.writeBaseline ? await readBaseline(BASELINE_PATH, BASELINE_KEY, warn) : baseline;
  const known = leaks.filter((l) => Object.hasOwn(baselineNow, l.declaration));
  const failing = leaks.filter((l) => !Object.hasOwn(baselineNow, l.declaration));
  const stale = Object.keys(baselineNow).filter((k) => !leaks.some((l) => l.declaration === k));

  const counts = {
    modules: modules.length,
    scannedBytes,
    rawDollarTotal,
    leaks: leaks.length,
    known: known.length,
    failing: failing.length,
    inStringLiterals: inStrings.length,
    staleBaseline: stale.length,
  };

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          tool: 'dsh-git/scripts/check-sass-leaks.mjs',
          counts,
          modules: modules.map((m) => rel(m)),
          leaks: leaks.map((l) => ({ ...l, known: Object.hasOwn(baselineNow, l.declaration), reason: baselineNow[l.declaration] ?? null })),
          inStringLiterals: inStrings,
          staleBaseline: stale,
          warnings,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    const out = (s = '') => process.stdout.write(`${s}\n`);
    out('dsh-git: Sass 变量泄漏检查($var leak check)');
    out(`  扫描产物:${modules.map((m) => rel(m)).join(', ')} (${scannedBytes} 字节)`);
    out(`  原始 \`$\` 数:${counts.rawDollarTotal}   剥注释后的**泄漏**数:${counts.leaks}   字符串字面量里的 \`$\`(提示,不算失败):${counts.inStringLiterals}`);
    if (counts.rawDollarTotal !== counts.leaks + counts.inStringLiterals) {
      out(`  (= 注释里的 \`$\` ${counts.rawDollarTotal - counts.leaks - counts.inStringLiterals} 个 —— 上游裸 indexOf 的误报源)`);
    }
    out(`  已登记 ${counts.known};未登记 ${counts.failing}`);
    out('');
    if (leaks.length === 0) {
      out('  产物里没有未编码的 Sass 变量。✓');
      out('  说明:这是一条**前瞻性**棘轮,今天不响(注释里的 `$` 已按设计排除)。');
    } else {
      out('  逐条(declaration 是基线键):');
      for (const l of leaks) {
        const tag = Object.hasOwn(baselineNow, l.declaration) ? 'known' : 'FAIL ';
        out(`    ${tag} ${l.file}:${l.line}  ${l.declaration}`);
        out(`           …${l.context}…`);
      }
      if (failing.length > 0) {
        out('');
        out(`  → 未登记 ${failing.length} 条。修掉,或在确属可接受时:`);
        out('      node scripts/check-sass-leaks.mjs --write-baseline');
      }
    }
    if (inStrings.length > 0) {
      out('');
      out(`  字符串字面量里的 \`$\`(提示,不算失败,常见于 content:"$"):${inStrings.length} 处`);
      for (const s of inStrings.slice(0, 5)) out(`    ${s.file}:${s.line}  …${s.context}…`);
    }
    if (stale.length > 0) {
      out('');
      out(`  基线里已失效(${stale.length} 条,建议删除):`);
      for (const s of stale.slice(0, 10)) out(`    ${s}`);
    }
    if (warnings.length > 0) {
      out('');
      out(`  警告 ${warnings.length} 条:`);
      for (const w of warnings.slice(0, 10)) out(`    ! ${w}`);
    }
    out('');
    const baselineExists = await isFile(BASELINE_PATH);
    out(
      `  基线:${rel(BASELINE_PATH)}(${Object.keys(baselineNow).length} 条` +
        `${baselineExists ? '' : ';文件不存在 —— 今天没有债务,首次 --write-baseline 时创建'})`,
    );
    out(`  结论:${failing.length === 0 ? 'PASS' : `FAIL(${failing.length} 条未登记)`}  退出码 ${failing.length === 0 ? 0 : 1}`);
  }

  process.exitCode = failing.length > 0 ? 1 : 0;
}

await main();
