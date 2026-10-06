#!/usr/bin/env node
/**
 * `scripts/**` 的**类型检查程序**(checkJs)—— 给承重脚本自己上类型。
 *
 * ## 1. 它防的是什么
 *
 * `scripts/*.mjs` 是这个仓库的**承重结构**:构建、样式编译、四条静态闸门都在这里。
 * 而它们此前**一行类型检查也没有**(`check-base-recipes.mjs` 已 1700+ 行 / 60+ 处 JSDoc)。
 * 一个判错样式的**检查器**会静默放过样式缺陷 —— 这是**元级别**的静默失败:
 * 闸门本身坏了,而「闸门通过」被当成「代码没问题」。
 *
 * 这次落地给 `scripts/` 建了一个**独立的** tsconfig(`scripts/tsconfig.json`,
 * `allowJs + checkJs + noEmit + strict + types:["node"]`),对应 Desktop 的两处实证:
 * `references/desktop/script/tsconfig.json`(构建脚本自己的程序)与
 * `references/desktop/eslint-rules/tsconfig.json`(`allowJs + checkJs`,给用 JS 写的
 * lint 规则上类型,靠 `// @ts-check` + JSDoc)。审计见 `docs/toolchain-adoption.md` B2/B3。
 *
 * **刻意不 extends 根 `tsconfig.json`**(那三个程序由另一条线持有):
 * Desktop 也是「一个程序一个 tsconfig」,不是一个根配置管到底。
 *
 * ## 2. 为什么是棘轮而不是硬门禁
 *
 * 首次运行会报出一批**既有的** JSDoc 缺口(实测 186 条,全部是 `implicitly has an 'any' type`
 * 这一类:老文件的 `@param` 没写类型)。一次性还清会阻塞在飞线,所以本脚本用
 * `scripts/scripts-types-baseline.json` 把现状钉住:**只拦新增**。
 * 指纹刻意**不含行号** —— 文件被并发编辑导致行号平移时,棘轮不会误报。
 *
 * 本次落地新增的 5 个脚本 + `gates-lib.mjs` **零错误**(2026-10 实测),
 * 也就是说新增代码不会让这个基线长大;要长大的只有「改老文件时新引入的类型错」。
 *
 * ## 3. 已知盲区
 *
 * - `checkJs` 只在 JSDoc 写对时才有意义:没有注解的参数就是 `any`,检查器**不会**
 *   因此报错(那是 TS7006,已在基线里)。要真正收紧,得逐个给老文件补 `@param`;
 * - 指纹按 `文件::错误码::消息` 聚合,**不追行号**:同一个文件里把同一个错误复制一份
 *   (计数从 1 → 2)会被抓住,但把一个错误挪到另一行不会重新计数;
 * - `typescript` 不在时**跳过**(退出码 2),不会假装通过。
 *
 * 用法:
 *
 *     node scripts/check-scripts-types.mjs                  # 人读报告
 *     node scripts/check-scripts-types.mjs --json           # 机器可读
 *     node scripts/check-scripts-types.mjs --write-baseline # 钉住当前错误集合(棘轮)
 *     node scripts/check-scripts-types.mjs --list           # 列出全部错误(默认只列新错误)
 *     node scripts/check-scripts-types.mjs --help
 *
 * 退出码:0 = 没有未登记的(新增)错误;1 = 有;2 = 跳过(typescript / tsconfig 缺失)。
 *
 * @module dsh-git/scripts/check-scripts-types
 */

import { execFile } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ROOT, createWarnings, isFile, parseArgs, readBaseline, rel } from './gates-lib.mjs';

const execFileAsync = promisify(execFile);

/** 脚本自己的类型程序。 */
const TSCONFIG = join(ROOT, 'scripts/tsconfig.json');

/** 基线(棘轮)。 */
const BASELINE_PATH = join(ROOT, 'scripts/scripts-types-baseline.json');

/** 基线顶层键。 */
const BASELINE_KEY = 'errors';

/** `typescript` 的候选入口(第二条是本仓库 node_modules 的真实位置)。 */
const TSC_CANDIDATES = [join(ROOT, 'node_modules/typescript/lib/tsc.js'), join(ROOT, 'node_modules/.bin/tsc')];

const HELP = `用法: node scripts/check-scripts-types.mjs [--json] [--list] [--write-baseline]

  scripts/** 的 checkJs 程序(scripts/tsconfig.json)跑一遍 tsc,只拦**新增**错误。
  退出码 0 = 没有未登记错误;1 = 有;2 = 跳过(typescript / tsconfig 缺失)。

  --json             stdout 输出机器可读 JSON
  --list             列出全部错误(默认只列新增与前若干条)
  --write-baseline   用当前错误集合重写 scripts/scripts-types-baseline.json(棘轮)
  --help             显示本帮助
`;

/**
 * 找一个可用的 tsc 入口。
 * @returns {Promise<string|null>} 绝对路径。
 */
async function findTsc() {
  for (const candidate of TSC_CANDIDATES) {
    if (await isFile(candidate)) return candidate;
  }
  return null;
}

/**
 * 数一下程序里有多少个 `.mjs`(用来证明「闸门真的扫到了东西」——
 * 上游 `package.json:41` 的 eslint glob 指向不存在的 `app/typings/` 就是这个教训)。
 * @returns {Promise<number>} 文件数。
 */
async function countProgramFiles() {
  try {
    const entries = await readdir(join(ROOT, 'scripts'), { withFileTypes: true });
    return entries.filter((e) => e.isFile() && e.name.endsWith('.mjs')).length;
  } catch {
    return 0;
  }
}

/** 主流程。 */
async function main() {
  const { warn, warnings } = createWarnings();
  const opts = parseArgs(process.argv.slice(2), ['--json', '--list', '--write-baseline'], warn);
  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }

  const emit = (/** @type {Record<string, unknown>} */ payload) => {
    process.stdout.write(`${JSON.stringify({ tool: 'dsh-git/scripts/check-scripts-types.mjs', ...payload }, null, 2)}\n`);
  };
  const skip = (/** @type {string} */ reason) => {
    if (opts.json) emit({ skipped: true, reason, warnings });
    else process.stdout.write(`check-scripts-types: SKIP(${reason})\n`);
    process.exitCode = 2;
  };

  if (!(await isFile(TSCONFIG))) {
    skip(`类型程序不存在: ${rel(TSCONFIG)}`);
    return;
  }
  const tsc = await findTsc();
  if (tsc === null) {
    skip('找不到 typescript(不安装;请由负责依赖的那条线装好后再跑)');
    return;
  }

  let stdout = '';
  let exitCode = 0;
  const startedAt = Date.now();
  try {
    const result = await execFileAsync(process.execPath, [tsc, '-p', rel(TSCONFIG), '--pretty', 'false'], {
      cwd: ROOT,
      maxBuffer: 64 << 20,
    });
    stdout = result.stdout;
  } catch (err) {
    const code = /** @type {any} */ (err)?.code;
    stdout = String(/** @type {any} */ (err)?.stdout ?? '');
    if (typeof code === 'number') exitCode = code;
    else {
      skip(`tsc 起不来: ${/** @type {any} */ (err)?.message ?? err}`);
      return;
    }
  }
  const ms = Date.now() - startedAt;

  /** @type {{file: string, line: number, col: number, code: string, message: string, fingerprint: string}[]} */
  const errors = [];
  const unparsed = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trimEnd();
    if (line === '') continue;
    const m = /^(.*)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(line);
    if (m === null) {
      if (/error TS/.test(line)) unparsed.push(line);
      continue;
    }
    const file = m[1].split('\\').join('/');
    errors.push({
      file,
      line: Number.parseInt(m[2], 10),
      col: Number.parseInt(m[3], 10),
      code: m[4],
      message: m[5],
      fingerprint: `${file}::${m[4]}::${m[5]}`,
    });
  }
  if (unparsed.length > 0) warn(`${unparsed.length} 行 tsc 输出没解析出行号(棘轮可能失真): ${unparsed[0].slice(0, 120)}`);

  /** @type {Map<string, number>} */
  const current = new Map();
  for (const e of errors) current.set(e.fingerprint, (current.get(e.fingerprint) ?? 0) + 1);

  const baseline = await readBaseline(BASELINE_PATH, BASELINE_KEY, warn);
  if (opts.writeBaseline) {
    /** @type {Record<string, number>} */
    const next = {};
    for (const [fingerprint, count] of [...current.entries()].sort()) next[fingerprint] = count;
    try {
      await writeFile(BASELINE_PATH, `${JSON.stringify({ [BASELINE_KEY]: next }, null, 2)}\n`, 'utf8');
      process.stderr.write(`check-scripts-types: 已写入基线 ${rel(BASELINE_PATH)}(${Object.keys(next).length} 条指纹)\n`);
    } catch (err) {
      warn(`基线写入失败: ${rel(BASELINE_PATH)} (${/** @type {NodeJS.ErrnoException} */ (err)?.code ?? err})`);
    }
  }
  const baselineNow = opts.writeBaseline ? await readBaseline(BASELINE_PATH, BASELINE_KEY, warn) : baseline;

  const baselineCounts = new Map();
  for (const [fingerprint, value] of Object.entries(baselineNow)) {
    const n = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
    baselineCounts.set(fingerprint, Number.isFinite(n) ? n : 1);
  }
  /** 新增(指纹不在基线里)与「同一指纹次数变多」的错误。 */
  const added = errors.filter((e) => !baselineCounts.has(e.fingerprint));
  const grown = errors.filter((e) => baselineCounts.has(e.fingerprint) && (current.get(e.fingerprint) ?? 0) > (baselineCounts.get(e.fingerprint) ?? 0));
  const newFingerprints = [...new Set([...added, ...grown].map((e) => e.fingerprint))];
  const stale = [...baselineCounts.keys()].filter((f) => !current.has(f));
  const filesWithErrors = new Set(errors.map((e) => e.file)).size;
  const programFiles = await countProgramFiles();

  const counts = {
    programFiles,
    tscMs: ms,
    errors: errors.length,
    fingerprints: current.size,
    filesWithErrors,
    knownFingerprints: baselineCounts.size,
    newFingerprints: newFingerprints.length,
    staleBaseline: stale.length,
  };

  if (opts.json) {
    emit({
      counts,
      skipped: false,
      errors: errors.map((e) => ({ ...e, known: baselineCounts.has(e.fingerprint) })),
      newFingerprints,
      staleBaseline: stale,
      warnings,
    });
  } else {
    const out = (s = '') => process.stdout.write(`${s}\n`);
    out('dsh-git: scripts/** 的类型检查(checkJs 程序)');
    out(`  程序:${rel(TSCONFIG)}(覆盖 ${programFiles} 个 .mjs);tsc ${ms}ms,退出码 ${exitCode}`);
    out(`  错误:${counts.errors} 条,分布在 ${counts.filesWithErrors} 个文件 / ${counts.fingerprints} 个指纹`);
    out(`  基线:${rel(BASELINE_PATH)}(${counts.knownFingerprints} 个指纹);**新增 ${counts.newFingerprints}**`);
    out('');
    if (errors.length === 0) {
      out('  没有任何类型错误。✓');
    } else {
      const show = opts.list ? errors : [...added, ...grown];
      if (show.length === 0) {
        out('  (没有新增错误;用 --list 看全部)');
      } else {
        out(`  逐条(前 ${Math.min(show.length, 40)} 条):`);
        for (const e of show.slice(0, 40)) {
          const tag = baselineCounts.has(e.fingerprint) ? 'grown' : 'NEW  ';
          out(`    ${tag} ${e.file}(${e.line},${e.col}): ${e.code} ${e.message}`);
        }
        if (show.length > 40) out(`    … 其余 ${show.length - 40} 条省略`);
      }
      if (newFingerprints.length > 0) {
        out('');
        out('  → 新增错误必须修掉(不要往基线里塞);确属无法立刻修的既有缺口才用 --write-baseline:');
        out('      node scripts/check-scripts-types.mjs --write-baseline');
      }
    }
    if (stale.length > 0) {
      out('');
      out(`  基线里已失效(${stale.length} 个指纹现在不报了,建议重写基线):`);
      for (const s of stale.slice(0, 5)) out(`    ${s}`);
    }
    if (warnings.length > 0) {
      out('');
      out(`  警告 ${warnings.length} 条:`);
      for (const w of warnings.slice(0, 10)) out(`    ! ${w}`);
    }
    out('');
    out(`  结论:${newFingerprints.length === 0 ? 'PASS' : `FAIL(${newFingerprints.length} 个新增指纹)`}  退出码 ${newFingerprints.length === 0 ? 0 : 1}`);
  }

  process.exitCode = newFingerprints.length > 0 ? 1 : 0;
}

await main();
