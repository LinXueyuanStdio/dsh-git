#!/usr/bin/env node
/**
 * 一条命令跑齐所有静态闸门(check-all)。
 *
 * ## 为什么必须有这个文件(它不是「方便」,是判据)
 *
 * 上游 GitHub Desktop 把 `markdownlint` 写成了 npm script(`package.json:37`),
 * 却**没有**接进 `lint`(`:35`)或 CI(`ci.yml:71` 只跑 `yarn lint`)—— 结果**没人跑它**。
 * 本次工具链审计把它记为反面教材(E3/A13),结论是一句话:
 *
 * > **没有闸门的工具 = 没人跑的工具。**
 *
 * 所以本仓库的每一条检查都必须能被**一条命令**跑到。这个文件就是那条命令:
 * 它**自动发现** `scripts/check-*.mjs`(除了自己),顺序执行,汇总退出码。
 * 新增一条闸门 = 新增一个 `scripts/check-*.mjs`,**不需要改这里**
 * (`scripts/build.mjs` 由另一条线持有,本文件**不碰它**)。
 *
 * ## 每条闸门的输出契约(本文件依赖它)
 *
 * - 退出码 **0** = 通过(可以带已登记债务)、**1** = 有未登记缺陷、**2** = 跳过(输入/工具不在);
 * - `--json` 时 stdout 是**纯 JSON**,警告走 stderr;
 * - 读不到输入时**跳过并警告**,绝不抛异常(文件树会被多条线并发编辑)。
 *
 * ## 已知限制
 *
 * - 只自动发现 `scripts/check-*.mjs`:名字不合约定的检查(例如 `verify-install.mjs`,
 *   它需要真实宿主环境)**故意**不在默认集合里 —— 那是环境探针,不是静态闸门;
 * - **不跑构建**:`scripts/build.mjs` 是另一条线的文件。真正的「干净工作区」闸门
 *   (`node scripts/check-generated.mjs --rebuild`)是本命令的 `--rebuild` 选项;
 * - 汇总退出码:**任一为 1 则 1**;全部 0/2 则 0;一个都没发现则 2(闸门不存在比闸门通过更值得知道)。
 *
 * 用法:
 *
 *     node scripts/check-all.mjs              # 跑齐所有静态闸门
 *     node scripts/check-all.mjs --json       # 机器可读汇总
 *     node scripts/check-all.mjs --rebuild    # 额外把 check-generated 切成 --rebuild(慢)
 *     node scripts/check-all.mjs --list       # 只列出会跑哪些闸门
 *     node scripts/check-all.mjs --help
 *
 * 退出码:0 = 全绿(含跳过);1 = 有闸门失败;2 = 一个闸门都没找到。
 *
 * @module dsh-git/scripts/check-all
 */

import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ROOT, createWarnings, parseArgs, rel } from './gates-lib.mjs';

const execFileAsync = promisify(execFile);

/** 本文件自己(不递归跑自己)。 */
const SELF = 'check-all.mjs';

/**
 * 需要真实宿主/网络环境、不属于「静态闸门」的脚本(名字即使匹配 `check-*` 也排除)。
 * `verify-install.mjs` 不匹配 `check-*`,这里只列将来可能的例外。
 */
const EXCLUDE = new Set();

const HELP = `用法: node scripts/check-all.mjs [--json] [--rebuild] [--list]

  一条命令跑齐 scripts/check-*.mjs(自动发现,不需要维护清单)。
  退出码 0 = 全绿(含跳过);1 = 有闸门失败;2 = 一个闸门都没找到。

  --json       stdout 输出机器可读汇总
  --rebuild    把 check-generated.mjs 切成 --rebuild(重跑构建并比对,慢)
  --list       只列出会跑哪些闸门
  --help       显示本帮助
`;

/**
 * 发现所有静态闸门。
 * @returns {Promise<string[]>} 文件名(排序)。
 */
async function discoverChecks() {
  /** @type {string[]} */
  const out = [];
  try {
    for (const entry of await readdir(join(ROOT, 'scripts'), { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!entry.name.startsWith('check-') || !entry.name.endsWith('.mjs')) continue;
      if (entry.name === SELF || EXCLUDE.has(entry.name)) continue;
      out.push(entry.name);
    }
  } catch {
    return [];
  }
  out.sort();
  return out;
}

/** 主流程。 */
async function main() {
  const { warn, warnings } = createWarnings();
  const opts = parseArgs(process.argv.slice(2), ['--json', '--rebuild', '--list'], warn);
  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }

  const checks = await discoverChecks();
  if (opts.list) {
    process.stdout.write(`${checks.map((c) => `scripts/${c}`).join('\n')}\n`);
    if (checks.length === 0) process.exitCode = 2;
    return;
  }
  if (checks.length === 0) {
    warn('一个 check-*.mjs 都没发现 —— 闸门不存在比闸门通过更值得知道');
    process.stdout.write(opts.json ? `${JSON.stringify({ tool: 'dsh-git/scripts/check-all.mjs', skipped: true, warnings }, null, 2)}\n` : 'check-all: SKIP(没有发现任何闸门)\n');
    process.exitCode = 2;
    return;
  }

  /** @type {{name: string, exitCode: number, ms: number, status: string, stdoutTail: string[], stderrTail: string[]}[]} */
  const results = [];
  for (const name of checks) {
    const args = [rel(join(ROOT, 'scripts', name))];
    if (opts.rebuild && name === 'check-generated.mjs') args.push('--rebuild');
    const startedAt = Date.now();
    let exitCode = 0;
    let stdout = '';
    let stderr = '';
    try {
      const result = await execFileAsync(process.execPath, args, { cwd: ROOT, maxBuffer: 64 << 20 });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (err) {
      const code = /** @type {any} */ (err)?.code;
      exitCode = typeof code === 'number' ? code : 1;
      stdout = String(/** @type {any} */ (err)?.stdout ?? '');
      stderr = String(/** @type {any} */ (err)?.stderr ?? '');
    }
    const status = exitCode === 0 ? 'PASS' : exitCode === 2 ? 'SKIP' : 'FAIL';
    const tail = (/** @type {string} */ s, /** @type {number} */ n) => s.trimEnd().split('\n').slice(-n).filter((x) => x.trim() !== '');
    results.push({ name, exitCode, ms: Date.now() - startedAt, status, stdoutTail: tail(stdout, 6), stderrTail: tail(stderr, 4) });
    if (opts.json) continue;
    const out = process.stdout.write.bind(process.stdout);
    out(`▶ scripts/${name} … `);
    out(`${status}${exitCode === 0 ? '' : ` (exit ${exitCode})`} ${results[results.length - 1].ms}ms\n`);
    if (status !== 'PASS') {
      for (const line of results[results.length - 1].stdoutTail) out(`    ${line}\n`);
      for (const line of results[results.length - 1].stderrTail) out(`    (stderr) ${line}\n`);
    }
  }

  const failed = results.filter((r) => r.status === 'FAIL');
  const skipped = results.filter((r) => r.status === 'SKIP');
  const counts = {
    checks: results.length,
    pass: results.filter((r) => r.status === 'PASS').length,
    fail: failed.length,
    skip: skipped.length,
    totalMs: results.reduce((sum, r) => sum + r.ms, 0),
  };

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ tool: 'dsh-git/scripts/check-all.mjs', counts, results, warnings }, null, 2)}\n`);
  } else {
    const out = process.stdout.write.bind(process.stdout);
    out('\n');
    out(`dsh-git: 静态闸门汇总 —— ${counts.checks} 条:${counts.pass} PASS / ${counts.fail} FAIL / ${counts.skip} SKIP,共 ${counts.totalMs}ms\n`);
    if (skipped.length > 0) out(`  跳过(输入/工具不在,不算通过):${skipped.map((r) => r.name).join(', ')}\n`);
    if (failed.length > 0) out(`  失败:${failed.map((r) => `${r.name}(exit ${r.exitCode})`).join(', ')}\n`);
    out(`  结论:${counts.fail === 0 ? 'PASS' : 'FAIL'}  退出码 ${counts.fail === 0 ? 0 : 1}\n`);
    if (warnings.length > 0) {
      out(`  警告 ${warnings.length} 条:\n`);
      for (const w of warnings.slice(0, 10)) out(`    ! ${w}\n`);
    }
  }

  process.exitCode = counts.fail === 0 ? 0 : 1;
}

await main();
