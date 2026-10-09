#!/usr/bin/env node
/**
 * 类型检查**棘轮(ratchet)** —— 把 `tsc --noEmit` 的诊断按**文件**计数,
 * 与 `scripts/type-baseline.json` 比对:**只拦「变多」,不拦「存量」**。
 *
 * ## 1. 它补的是上游天然有、我们丢掉的那道关卡
 *
 * 上游 GitHub Desktop 用 **`ts-loader`**(`references/desktop/app/webpack.common.ts:32,203`,
 * 全仓无 `transpileOnly`)编译 TS ⇒ 类型错误在上游**就是构建失败**,CI 也会红。
 * 我们保留 esbuild 打包,而 `scripts/build.mjs:206` 自己写明
 * **esbuild 不做类型检查**,`checkJsxIdentifiers`(`:210`)又只断言
 * 「大写 JSX 标签能解析到定义或导入」—— **从不看 props / prop 类型 / 参数个数**。
 *
 * 后果有实证:`src/client/diff-ui.ts` 本地重声明的 `ISeamlessDiffSwitcherProps`
 * 把上游真名 `externalFileContents` 写成了 `fileContents`(语义相反)、漏了 3 个真实
 * prop、把一个回调的返回类型加严 —— **全部无声通过**,因为从来没有编译器跑过。
 *
 * 所以本脚本 **不是** 我们的发明,而是把上游 ts-loader 的关卡用
 * `tsc --noEmit` 的最低成本形式补回来(不换构建器,只加一道检查)。
 *
 * ## 2. 三个程序(client / host / hostMirror)
 *
 * 两半的硬约束相反,所以是**两个 tsconfig**;2026-10 加的第三段镜像再单开一个:
 *
 *   - `tsconfig.json`      —— 浏览器半(`src/client/**` + 与上游一致的 `src/core/desktop/**`)。
 *     `types: []`,于是 `import ... from 'os'` / `setImmediate` / `Buffer` / `process`
 *     会**报错** —— 这是「浏览器半禁止 node 内置」(`docs/goal-port-desktop.md` §2.3)
 *     第一次有了机器检查。
 *   - `tsconfig.host.json` —— host 半(`src/index.ts` + `src/host/**` + `src/core/*.ts`)。
 *     沿用上游的 `types: ["node"]`。**不含** `src/host/mirror/**`(显式 exclude)。
 *   - `tsconfig.host-mirror.json` —— host 镜像(`src/host/mirror/**`):Desktop 编排层
 *     (`lib/stores/**` + `lib/api.ts` + `lib/databases/**` + `lib/git/**` + `models/**`)
 *     的**逐字副本**,带 dugite 依赖,只能在宿主半跑。它是**尚未适配的存量**,
 *     所以单独成一个程序、存量钉在基线里,而不是混进 host 把真回归淹掉。
 *     见 `docs/host-mirror-adaptation.md`。
 *
 * 基线按 `程序 + 文件` 计数:`{ "client": { "src/…": 3 }, "host": { … }, "hostMirror": { … } }`。
 * 同一个文件同时出现在两个程序里时,两边的计数**独立** —— 那是两个不同的
 * 编译现场,合并没有意义。
 *
 * ## 3. 棘轮语义(与 `scripts/check-base-recipes.mjs` 同形)
 *
 *   - 某文件诊断数 **变多** ⇒ **失败**(退出码 1),报告里点名该文件;
 *   - **新文件**出现诊断 ⇒ **失败**(基线里没有 = 0,任何正数都是变多);
 *   - 某文件诊断数 **变少** ⇒ **通过**,报告为「可改进」,提示把该条目从基线里
 *     收紧/删掉(`--write-baseline` 会用当前值重写);
 *   - 基线里**已经不存在的文件** ⇒ 报为 stale。
 *
 * ## 4. 健壮性(仓库随时可能被其它 agent 并发编辑)
 *
 *   - **没有 `typescript`** ⇒ 警告并**跳过**(退出码 0)。绝不因此让构建/安装失败。
 *   - **基线缺失 / 不是合法 JSON / 结构不对** ⇒ 警告,按**空基线**处理
 *     (于是存量全部算「新出现」而失败 —— 这是刻意的:没有基线就无法证明
 *     「没有回归」,`--write-baseline` 一条命令即可钉住)。
 *   - **tsc 自身崩了 / 配置错(TS5xxx、TS18003)** ⇒ 正常报告,不抛异常。
 *
 * 用法:
 *
 *     node scripts/check-types.mjs                  # 人读报告
 *     node scripts/check-types.mjs --json           # 机器可读(stdout 是纯 JSON)
 *     node scripts/check-types.mjs --write-baseline # 用当前诊断数重写基线(棘轮)
 *     node scripts/check-types.mjs --program client # 只跑其中一个程序
 *
 * 退出码:0 = 无回归;1 = 有文件诊断数变多 / 出现新文件诊断。
 *
 * @module dsh-git/scripts/check-types
 */

import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 仓库根(从脚本位置反推,与 cwd 无关)。 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 基线(棘轮)文件。 */
const BASELINE_PATH = join(ROOT, 'scripts/type-baseline.json');

/** 三个编译程序:键名 → tsconfig 文件名。 */
const PROGRAMS = [
  { name: 'client', config: 'tsconfig.json', title: '浏览器半(src/client + 镜像 src/core/desktop)' },
  { name: 'host', config: 'tsconfig.host.json', title: 'host 半(src/index.ts + src/host + src/core)' },
  {
    name: 'hostMirror',
    config: 'tsconfig.host-mirror.json',
    title: 'host 镜像(src/host/mirror:Desktop 编排层逐字副本,**尚未适配**)',
  },
];

/** TypeScript 入口候选(优先 lib/tsc.js:用 node 直接跑,不依赖 .bin 的可执行位)。 */
const TSC_CANDIDATES = [
  join(ROOT, 'node_modules/typescript/lib/tsc.js'),
  join(ROOT, 'node_modules/typescript/bin/tsc'),
];

/** tsc 诊断行:`<file>(<line>,<col>): error TS<code>: <message>`。 */
const DIAGNOSTIC_RE = /^(?<file>.+?)\((?<line>\d+),(?<col>\d+)\): error TS(?<code>\d+): (?<message>.*)$/;

/** 没有文件位置的诊断(配置错等),归到这个伪文件名下。 */
const CONFIG_PSEUDO_FILE = '(tsconfig)';

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 运行期警告(统一 stderr + 报告)。 */
const warnings = [];

/**
 * 记一条警告。绝不抛异常。
 * @param {string} message 内容。
 */
function warn(message) {
  warnings.push(message);
  process.stderr.write(`dsh-git/check-types: 警告: ${message}\n`);
}

/** 仓库相对路径(统一 `/`);已是相对路径就原样。 */
function rel(p) {
  const r = p.startsWith(ROOT) ? relative(ROOT, p) : p;
  return r.split(sep).join('/');
}

/**
 * 读文件;失败返回 null(调用方决定语义)。
 * @param {string} file 绝对路径。
 * @returns {Promise<string|null>} 内容或 null。
 */
async function readIfExists(file) {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/** 判断文件是否存在(不抛)。 */
async function exists(file) {
  return (await readIfExists(file)) !== null;
}

/**
 * 跑一次 tsc,返回 {stdout, stderr, code, spawnError}。绝不抛。
 * @param {string} tscPath tsc 入口(绝对路径)。
 * @param {string} config tsconfig 文件名(相对 ROOT)。
 * @returns {Promise<{stdout: string, stderr: string, code: number|null, spawnError: string|null}>}
 */
function runTsc(tscPath, config) {
  return new Promise((resolvePromise) => {
    const args = [tscPath, '-p', config, '--pretty', 'false'];
    let child;
    try {
      child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolvePromise({ stdout: '', stderr: '', code: null, spawnError: String(err?.message ?? err) });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', (err) => {
      resolvePromise({ stdout, stderr, code: null, spawnError: String(err?.message ?? err) });
    });
    child.on('close', (code) => {
      resolvePromise({ stdout, stderr, code, spawnError: null });
    });
  });
}

/**
 * 把 tsc 的 stdout 解析成 `文件 → 诊断数`,并保留每个文件的前几条原文。
 *
 * 额外统计 **TS1xxx(语法错)** —— 它不是普通诊断:实测(2026-10-06,其它 agent
 * 正在写 `src/client/styles.ts`,保存到一半时)只要程序里有一个语法错,
 * tsc 就**跳过整个程序的语义诊断**,总数从 356 塌到 5。此时「某文件诊断变少」
 * 是**假象**,基线会被写坏。调用方据此拒绝判定/拒绝写基线。
 * @param {string} stdout 原始输出。
 * @returns {{counts: Map<string, number>, samples: Map<string, string[]>, syntaxCount: number, syntaxSamples: string[]}} 计数与样例。
 */
function parseDiagnostics(stdout) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  /** @type {Map<string, string[]>} */
  const samples = new Map();
  let syntaxCount = 0;
  /** @type {string[]} */
  const syntaxSamples = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line === '' || /^\s/.test(line)) continue; // 缩进的续行不是诊断头
    const m = DIAGNOSTIC_RE.exec(line);
    if (m === null) continue;
    const file = rel(m.groups.file);
    counts.set(file, (counts.get(file) ?? 0) + 1);
    const list = samples.get(file);
    if (list === undefined) samples.set(file, [line]);
    else if (list.length < 4) list.push(line);
    const code = Number(m.groups.code);
    if (Number.isFinite(code) && code >= 1000 && code < 2000) {
      syntaxCount++;
      if (syntaxSamples.length < 4) syntaxSamples.push(line);
    }
  }
  return { counts, samples, syntaxCount, syntaxSamples };
}

// ---------------------------------------------------------------------------
// 基线
// ---------------------------------------------------------------------------

/**
 * 读基线。不存在 / 不合法 / 结构不对 → 空基线(只警告,不抛)。
 * @returns {Promise<Record<string, Record<string, number>>>} 程序名 → 文件 → 计数。
 */
async function readBaseline() {
  const text = await readIfExists(BASELINE_PATH);
  if (text === null) {
    warn(`基线不存在,按空基线处理(存量会全部算作新出现): ${rel(BASELINE_PATH)}`);
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    warn(`基线不是合法 JSON,按空基线处理: ${rel(BASELINE_PATH)} (${err?.message ?? err})`);
    return {};
  }
  const programs = parsed?.programs;
  if (programs === null || typeof programs !== 'object' || Array.isArray(programs)) {
    warn(`基线结构不是 { "programs": { "<程序>": { "<文件>": <计数> } } },按空基线处理`);
    return {};
  }
  /** @type {Record<string, Record<string, number>>} */
  const out = {};
  for (const [name, files] of Object.entries(programs)) {
    if (files === null || typeof files !== 'object' || Array.isArray(files)) {
      warn(`基线里程序 "${name}" 不是对象,已忽略`);
      continue;
    }
    /** @type {Record<string, number>} */
    const entry = {};
    for (const [file, count] of Object.entries(files)) {
      const n = Number(count);
      if (!Number.isFinite(n) || n < 0) {
        warn(`基线里 ${name} / ${file} 的计数不是非负数(${String(count)}),已忽略该条`);
        continue;
      }
      entry[file] = Math.trunc(n);
    }
    out[name] = entry;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/** 解析命令行。 */
function parseArgs(argv) {
  const opts = { json: false, writeBaseline: false, help: false, program: 'all' };
  for (const arg of argv) {
    if (arg === '--json') opts.json = true;
    else if (arg === '--write-baseline') opts.writeBaseline = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg.startsWith('--program=')) opts.program = arg.slice('--program='.length);
    else if (arg === '--program') opts.program = '';
    else warn(`忽略未知参数: ${arg}`);
  }
  return opts;
}

const HELP = `用法: node scripts/check-types.mjs [--json] [--write-baseline] [--program client|host|hostMirror|all]

  类型检查棘轮:tsc --noEmit 的诊断按**文件**计数,与 scripts/type-baseline.json 比对。
  某文件诊断变多 / 出现新文件 ⇒ 退出码 1;变少 ⇒ 报告为可改进项。
  没有 typescript 时警告并跳过(退出码 0)。

  安全阀:程序里出现**语法错(TS1xxx)**时,tsc 会跳过整个程序的语义诊断、
  计数会塌成假的小数字 —— 此时本脚本**不判定回归、也拒绝写基线**(退出码 1)。

  --json            stdout 输出机器可读 JSON
  --write-baseline  用当前诊断数重写 scripts/type-baseline.json(棘轮)
  --program NAME    只跑一个程序:client(默认 tsconfig.json)/ host(tsconfig.host.json)/ hostMirror(tsconfig.host-mirror.json)

  三个程序:
    client      src/client/** + src/core/desktop/**  (types: [],禁止 node 内置)
    host        src/index.ts + src/host/** + src/core/*.ts  (types: ["node"])
    hostMirror  src/host/mirror/**  (types: ["node"])—— Desktop 编排层的逐字副本,
                **尚未适配**,存量诊断全部钉在基线里;适配一个搬一个(client/host)。
`;

/** 主流程。 */
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }

  // --- 1. 找 tsc -----------------------------------------------------------
  let tscPath = null;
  for (const candidate of TSC_CANDIDATES) {
    if (await exists(candidate)) {
      tscPath = candidate;
      break;
    }
  }
  if (tscPath === null) {
    warn(
      '找不到 typescript(node_modules/typescript/lib/tsc.js)。' +
        '类型检查已跳过。安装:`npm install --save-dev typescript@5`',
    );
    process.stdout.write('dsh-git: 类型检查棘轮 —— typescript 未安装,已跳过。\n');
    process.exitCode = 0;
    return;
  }
  let tsVersion = 'unknown';
  const tsPkg = await readIfExists(join(ROOT, 'node_modules/typescript/package.json'));
  if (tsPkg !== null) {
    try {
      tsVersion = JSON.parse(tsPkg).version ?? 'unknown';
    } catch {
      /* 版本读不到不影响检查 */
    }
  }

  // --- 2. 跑每个程序 -------------------------------------------------------
  const selected =
    opts.program === 'all' || opts.program === ''
      ? PROGRAMS
      : PROGRAMS.filter((p) => p.name === opts.program);
  if (selected.length === 0) {
    warn(`--program 只接受 client / host / hostMirror / all,收到 "${opts.program}";按 all 处理`);
  }
  const programsToRun = selected.length === 0 ? PROGRAMS : selected;

  /** @type {{name: string, title: string, config: string, exitCode: number|null, counts: Map<string, number>, samples: Map<string, string[]>, total: number, ranOk: boolean}[]} */
  const results = [];
  for (const program of programsToRun) {
    const configPath = join(ROOT, program.config);
    if (!(await exists(configPath))) {
      warn(`配置文件不存在,跳过该程序: ${program.config}`);
      continue;
    }
    const run = await runTsc(tscPath, program.config);
    if (run.spawnError !== null) {
      warn(`${program.name}: 无法启动 tsc(${run.spawnError}),跳过`);
      continue;
    }
    if (run.stderr.trim() !== '') {
      warn(`${program.name}: tsc 写到了 stderr: ${run.stderr.trim().split('\n')[0]}`);
    }
    const { counts, samples, syntaxCount, syntaxSamples } = parseDiagnostics(run.stdout);
    let total = 0;
    for (const n of counts.values()) total += n;
    // tsc 退出码:0 = 无诊断;1 = 有诊断;2 = **有诊断但没产出**(`--noEmit` 的正常路径)。
    // 只有 >2 才是配置/内部错误。
    if (run.code !== null && run.code > 2) {
      warn(`${program.name}: tsc 退出码 ${run.code}(配置或内部错误),结果可能不完整`);
    } else if (run.code !== null && run.code !== 0 && total === 0) {
      warn(`${program.name}: tsc 退出码 ${run.code},但没有解析到任何诊断 —— 输出格式可能变了`);
    }
    if (syntaxCount > 0) {
      warn(
        `${program.name}: 有 ${syntaxCount} 条**语法错**(TS1xxx)⇒ tsc 会跳过整个程序的语义诊断,` +
          `本程序的计数**不可信**(实测会从数百条塌到个位数)。先修语法,再跑本检查。`,
      );
    }
    results.push({
      name: program.name,
      title: program.title,
      config: program.config,
      exitCode: run.code,
      counts,
      samples,
      total,
      syntaxCount,
      syntaxSamples,
      ranOk: true,
    });
  }

  if (results.length === 0) {
    warn('一个程序都没跑成,视作跳过。');
    process.stdout.write('dsh-git: 类型检查棘轮 —— 没有可运行的程序,已跳过。\n');
    process.exitCode = 0;
    return;
  }

  // --- 3. 与基线比对 -------------------------------------------------------
  let baseline = await readBaseline();

  /**
   * 拿当前诊断与一份基线算「回归 / 改进 / 基线里已消失的文件」。
   * @param {typeof results} results 本次跑出来的程序结果。
   * @param {Record<string, Record<string, number>>} baseline 基线。
   * @returns {any[]} 每个程序的报告。
   */
  function compareAgainstBaseline(results, baseline) {
    /** @type {any[]} */
    const out = [];
    for (const result of results) {
      const base = baseline[result.name] ?? {};
      /** 有语法错的程序:语义诊断被 tsc 跳过,计数不可信 ⇒ 不做回归/改进判定。 */
      const degraded = result.syntaxCount > 0;
      const regressions = [];
      const improvements = [];
      if (!degraded) {
        for (const [file, now] of result.counts) {
          const was = base[file] ?? 0;
          if (now > was) regressions.push({ file, now, was });
          else if (now < was) improvements.push({ file, now, was });
        }
        for (const [file, was] of Object.entries(base)) {
          if (!result.counts.has(file) && was > 0) improvements.push({ file, now: 0, was });
        }
      }
      const stale = degraded ? [] : Object.keys(base).filter((f) => !result.counts.has(f));
      const sortByNow = (a, b) => b.now - a.now || a.file.localeCompare(b.file);
      regressions.sort(sortByNow);
      improvements.sort(sortByNow);
      out.push({
        name: result.name,
        title: result.title,
        config: result.config,
        total: result.total,
        files: result.counts.size,
        degraded,
        syntaxCount: result.syntaxCount,
        syntaxSamples: result.syntaxSamples,
        regressions,
        improvements,
        stale,
        samples: result.samples,
        counts: result.counts,
      });
    }
    return out;
  }

  // --- 4. 写基线(棘轮)----------------------------------------------------
  if (opts.writeBaseline) {
    const degraded = results.filter((r) => r.syntaxCount > 0);
    if (degraded.length > 0) {
      // 拒绝写:有语法错时 tsc 跳过语义诊断,把数百条塌成个位数,基线一旦写下就是
      // 「永久豁免」一个依赖/整个程序的类型检查 —— 棘轮最危险的失效模式。
      warn(
        `拒绝写基线:${degraded.map((r) => r.name).join(', ')} 有语法错(TS1xxx)。` +
          `此时 tsc 会跳过语义诊断,计数会塌成一个假的小数字。先修语法,再跑 --write-baseline。`,
      );
    } else {
      /** @type {Record<string, Record<string, number>>} */
      const next = {};
      for (const result of results) {
        const entry = {};
        for (const file of [...result.counts.keys()].sort()) entry[file] = result.counts.get(file);
        next[result.name] = entry;
      }
      const payload = {
        $comment:
          '类型检查棘轮基线:程序 → 文件 → 诊断数。由 `node scripts/check-types.mjs --write-baseline` 生成。' +
          '修好某个文件后重跑本脚本,用 --write-baseline 把它收紧;不要为了让检查通过而手动调大某个数字。',
        generatedBy: 'scripts/check-types.mjs --write-baseline',
        typescript: tsVersion,
        programs: next,
      };
      try {
        await writeFile(BASELINE_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
        process.stderr.write(
          `dsh-git/check-types: 已写入基线 ${rel(BASELINE_PATH)}(` +
            results.map((r) => `${r.name}: ${r.total}`).join(', ') +
            ')\n',
        );
      } catch (err) {
        warn(`基线写入失败: ${rel(BASELINE_PATH)} (${err?.code ?? err})`);
      }
      // 写完立刻重读:--write-baseline 的语义是「用现在钉住现在」,所以
      // 本次运行必须按**刚写下**的基线判定(否则它自己会报成一次全量回归)。
      baseline = await readBaseline();
    }
  }

  // compareAgainstBaseline 需要在上面的写基线之后调用,才能反映最新基线。
  const reports = compareAgainstBaseline(results, baseline);
  const totalRegressions = reports.reduce((n, r) => n + r.regressions.length, 0);
  const degradedCount = reports.filter((r) => r.degraded).length;

  // --- 5. 输出 -------------------------------------------------------------
  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          tool: 'dsh-git/scripts/check-types.mjs',
          typescript: tsVersion,
          baselinePath: rel(BASELINE_PATH),
          totalRegressions,
          degradedPrograms: degradedCount,
          programs: reports.map((r) => ({
            name: r.name,
            config: r.config,
            total: r.total,
            files: r.files,
            degraded: r.degraded,
            syntaxErrors: r.syntaxCount,
            syntaxSamples: r.syntaxSamples,
            regressions: r.regressions,
            improvements: r.improvements,
            staleBaseline: r.stale,
            topFiles: [...r.counts.entries()]
              .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
              .slice(0, 10)
              .map(([file, count]) => ({ file, count, samples: r.samples.get(file) ?? [] })),
          })),
          warnings,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    printReport({ reports, tsVersion, baseline, opts, totalRegressions, degradedCount });
  }

  process.exitCode = totalRegressions > 0 || degradedCount > 0 ? 1 : 0;
}

/** 人读报告。 */
function printReport(ctx) {
  const { reports, tsVersion, baseline, opts, totalRegressions, degradedCount } = ctx;
  const out = (s = '') => process.stdout.write(`${s}\n`);
  out('dsh-git: 类型检查棘轮(type-check ratchet)—— 补上游 ts-loader 的那道关卡');
  out(`  typescript : ${tsVersion}`);
  out(`  基线       : ${rel(BASELINE_PATH)}${opts.writeBaseline ? '(本次已重写)' : ''}`);
  out('');

  for (const r of reports) {
    const baseTotal = Object.values(baseline[r.name] ?? {}).reduce((a, b) => a + b, 0);
    const baseFiles = Object.keys(baseline[r.name] ?? {}).length;
    out(`  ── ${r.name}  ${r.title}`);
    out(`     配置 ${r.config}   诊断 ${r.total} 条 / ${r.files} 个文件` + `   (基线 ${baseTotal} 条 / ${baseFiles} 个文件)`);
    if (r.degraded) {
      out(`     ⚠ 不可信:本程序有 ${r.syntaxCount} 条**语法错(TS1xxx)**。`);
      out('       tsc 在有语法错时会**跳过整个程序的语义诊断** ⇒ 计数会塌成一个假的小数字,');
      out('       本程序**不做回归/改进判定**,也**拒绝写基线**。先修语法。');
      for (const sample of r.syntaxSamples) out(`         ${sample}`);
      out('');
      continue;
    }
    if (r.regressions.length === 0) {
      out('     回归: 无 ✓');
    } else {
      out(`     回归: ${r.regressions.length} 个文件诊断**变多**(这就是失败原因):`);
      for (const item of r.regressions) {
        const tag = item.was === 0 ? 'NEW ' : 'FAIL';
        out(`       ${tag} ${item.file.padEnd(58)} ${item.was} → ${item.now}`);
        for (const sample of (r.samples.get(item.file) ?? []).slice(0, 3)) out(`              ${sample}`);
      }
    }
    if (r.improvements.length > 0) {
      out(`     可改进: ${r.improvements.length} 个文件诊断变少 —— 跑 --write-baseline 收紧基线:`);
      for (const item of r.improvements.slice(0, 12)) {
        out(`       ↓    ${item.file.padEnd(58)} ${item.was} → ${item.now}`);
      }
      if (r.improvements.length > 12) out(`       … 另有 ${r.improvements.length - 12} 个`);
    }
    if (r.stale.length > 0) {
      out(`     基线里已不存在的文件(${r.stale.length} 个,建议 --write-baseline 清理):`);
      for (const file of r.stale.slice(0, 8)) out(`       -    ${file}`);
    }
    const top = [...r.counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10);
    out(`     top ${top.length} 文件:`);
    for (const [file, n] of top) out(`       ${String(n).padStart(4)}  ${file}`);
    out('');
  }

  if (degradedCount > 0) {
    out(`  → ⚠ 有 ${degradedCount} 个程序处于「有语法错」状态,本次**不判定回归、不写基线**。`);
    out('      原因:tsc 在有语法错时跳过语义诊断,计数会塌成假的小数字 ——');
    out('      这正是棘轮最危险的失效模式(会把整个程序的类型检查当债务永久豁免)。');
    out('      先修语法,再重跑。');
  } else if (totalRegressions > 0) {
    out(`  → 有 ${totalRegressions} 个文件诊断变多。修掉后重跑;确属存量就:`);
    out('      node scripts/check-types.mjs --write-baseline');
  } else {
    out('  → 无回归 ✓(存量已全部登记在基线里)');
  }

  if (warnings.length > 0) {
    out('');
    out(`  警告 ${warnings.length} 条:`);
    for (const w of warnings) out(`    - ${w}`);
  }
}

await main();
