#!/usr/bin/env node
/**
 * 接线完成度自检 —— 三个**不可能自欺**的判据。
 *
 * 起因:移植来的 Desktop diff 渲染层(131 个文件)一开始是**零引用**的,而
 * `node scripts/build.mjs` 照常绿 —— 因为没人 import,esbuild 根本不编译它们。
 * 「构建绿」因此完全不能证明接线完成。这份脚本给三个可量化的判据:
 *
 *  1. **产物跃升** —— `lib/client.js` 必须显著大于「接线前」的基准。
 *     接入虚拟滚动 + 移植 UI 后本应涨到 ~800KB–1.4MB;停在 36x KB 就是没接上。
 *  2. **可达文件数** —— 从应用入口静态走 import 图,镜像文件里有多少真可达。
 *     接线前是 17(全是早期沿用的纯逻辑),接线后 `ui/diff/**` 及其原语闭包必须变可达。
 *  3. **类名覆盖率** —— 移植组件实际用到的 Desktop 类名,有多少出现在产出的 CSS 里。
 *     光有组件没有样式,渲染出来是裸 DOM。
 *
 * ## 输出契约(与 `scripts/check-all.mjs` 文件头一致)
 *
 * - 退出码 **0** = 三条判据全达标;**1** = 有判据未达标(或 `--baseline` 棘轮被越过);
 *   **2** = 探针自身出错(未捕获异常;改前那种情况是栈回溯 + exit 1);
 * - `--json` 时 stdout 是**纯 JSON**,警告一律走 stderr;
 * - **绝不写任何文件**:没有 `--write-baseline`(见下)。
 *
 * 用法:
 *
 *     node scripts/check-integration.mjs                       # 人看
 *     node scripts/check-integration.mjs --json                # 机器可读(stdout 纯 JSON)
 *     node scripts/check-integration.mjs --baseline=<path>     # 额外做一次**只读**棘轮对比
 *     node scripts/check-integration.mjs --help
 *
 * ## 为什么要有「失去可达的模块名单」(本文件 2026-10 的改动)
 *
 * 判据 2 原来**只打印总数**(`可达: 221(71%)`)。2026-10 实测吃过一次亏:
 * 可达率从 **231 掉到 221**(删掉「外观」「集成」两个页面导致 10 个镜像模块失去可达),
 * 而闸门打印的只是两个不同的总数 —— **从闸门本身看不出是哪些模块变的**,
 * 只能人工复刻闸门的 `reachable()` 规则重算一遍。
 *
 * 所以现在**永远**打印当前不可达的镜像模块清单(`unreachable`,JSON 里是数组)。
 * 名单只是**可观测性**:判据 2 的判定条件(产物跃升 / `side-by-side-diff` 可达 /
 * 占比 ≥ 50%)一个字没改。
 *
 * ### `--baseline=<path>`:只读棘轮(可选,默认不参与)
 *
 * 把**上一次**的 `--json` 输出(或一行一个路径的文本)喂给 `--baseline=`,
 * 它就会打印 delta,并且**只在「不可达变多」时**让本闸门失败(exit 1)。
 * 少了(`fixed`)只报告、不失败。它**只读**:本文件没有任何写盘路径,
 * **故意没有** `--write-baseline` —— 把 `221/310` 这种状态"写成已接受"正是这一轮
 * 要修的病(进度条会瞎)。
 *
 * 例:
 *
 *     node scripts/check-integration.mjs --json > /tmp/before.json     # 改之前
 *     node scripts/check-integration.mjs --baseline=/tmp/before.json   # 改之后:打印 delta
 *
 * ## 已知盲区(`reachable()` 是**静态近似**,名单因此有假阳性)
 *
 * `reachable()` 只顺着两种写法走:字符串里出现 `from '<相对路径>'` 的 import
 * (`import … from` / `export … from` 都算)。它**看不见**:
 *
 * - **副作用 import**(`import './polyfills.ts';` —— 没有 `from`,现在全仓库只有
 *   `src/client/index.ts:16` 一处,而且它不在镜像目录里,所以今天不影响镜像计数);
 * - 双引号说明符 `from "./x"`(今天 0 处)、动态 `import('./x')`(今天 0 处,仅注释里出现)、
 *   `require('./x')`;
 * - 别名 / 路径映射(仓库没有配)。
 *
 * ⇒ 名单上的路径是「**按本闸门的规则**不可达」,不是「全世界都不可达」的证明。
 * 排查时先用 `grep` 确认它真的没被引用,再下结论。
 *
 * 用法:`node scripts/check-integration.mjs`(只读;判据 1/2 不达标时非零退出)
 * @module dsh-git/scripts/check-integration
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createWarnings, parseArgs, rel } from './gates-lib.mjs';

const REPO = resolve(import.meta.dirname, '..');
const TOOL = 'dsh-git/scripts/check-integration.mjs';

/** 接线前的产物大小(实测基准)。明显低于它才算「接上了」。 */
const PRE_WIRING_CLIENT_BYTES = 366_940;
/** 判「已跃升」的倍数门槛:至少翻一倍(虚拟滚动本身就 451KB)。 */
const GROWTH_FACTOR = 2;
/** 镜像根(**只读**):判据 2 的分子/分母都来自它。 */
const MIRROR_ROOT = 'src/core/desktop';
/** 可达占比参考线。 */
const RATIO_FLOOR = 0.5;

const HELP = `用法: node scripts/check-integration.mjs [--json] [--baseline=<path>]

  接线完成度自检:产物跃升 / 镜像可达文件数 / 类名覆盖率,并**列出**当前
  失去可达的镜像模块。退出码 0 = 三条判据全达标;1 = 有判据未达标(或
  --baseline 棘轮被越过);2 = 探针自身出错。

  --json              stdout 输出机器可读 JSON(警告走 stderr)
  --baseline=<path>   只读对比:上一次 --json 的输出,或一行一个路径的文本。
                      **只在不可达"变多"时**失败。本闸门没有 --write-baseline。
  --help              显示本帮助
`;

/** 递归收集某目录下的 .ts/.tsx。 */
async function listFiles(root, out = []) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) await listFiles(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * 从入口静态走相对 import,返回可达文件集合(相对仓库根的 posix 路径)。
 * ⚠️ 这是**静态近似**,盲区见文件头「已知盲区」。这里**不改**它的规则:
 * 改规则等于改判据 2 的数字,而那个数字是进度条(要变必须在报告里写明理由)。
 * @param entries - 入口文件(相对仓库根)。
 */
async function reachable(entries) {
  const seen = new Set();
  const stack = [...entries];
  while (stack.length > 0) {
    let cur = stack.pop();
    if (cur === undefined || seen.has(cur)) continue;
    if (!/\.tsx?$/.test(cur)) {
      // 无扩展名的说明符:逐个试后缀
      let hit = null;
      for (const ext of ['.ts', '.tsx', '/index.ts', '/index.tsx']) {
        try {
          if ((await stat(join(REPO, cur + ext))).isFile()) { hit = cur + ext; break; }
        } catch { /* 继续试 */ }
      }
      if (hit === null) continue;
      cur = hit;
    }
    if (seen.has(cur)) continue;
    seen.add(cur);
    let text;
    try {
      text = await readFile(join(REPO, cur), 'utf8');
    } catch {
      continue;
    }
    for (const m of text.matchAll(/from\s+'(\.[^']+)'/g)) {
      const spec = m[1];
      if (spec === undefined) continue;
      const base = join(cur, '..', spec).split('\\').join('/');
      // 归一化掉 ./ 与 ../
      const parts = [];
      for (const seg of base.split('/')) {
        if (seg === '.' || seg === '') continue;
        if (seg === '..') parts.pop();
        else parts.push(seg);
      }
      stack.push(parts.join('/'));
    }
  }
  return seen;
}

/**
 * 读 `--baseline=<path>` 里的「不可达清单」。
 *
 * 接受三种形状(全部**只读**),任一种都行:
 *  1. 本文件 `--json` 的完整输出 ⇒ 取 `unreachable` 数组;
 *  2. `{ "unreachable": { "<path>": "<说明>" } }`(登记式的对象);
 *  3. 一行一个路径的纯文本(`#` 开头的行忽略)。
 *
 * 读不到 / 坏 / 形状不认识 ⇒ **警告并返回 null**(当没有基线,绝不抛)。
 * @param {string} file 基线文件路径(命令行给的)。
 * @param {(message: string) => void} warn 警告函数。
 * @returns {Promise<Set<string>|null>} 不可达集合;不可用时 null。
 */
async function readUnreachableBaseline(file, warn) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    warn(`基线读不到,按"没有基线"处理: ${file} (${/** @type {NodeJS.ErrnoException} */ (err)?.code ?? err})`);
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return new Set(parsed.map(String));
    }
    const bucket = parsed?.unreachable;
    if (Array.isArray(bucket)) {
      return new Set(bucket.map(String));
    }
    if (bucket !== null && typeof bucket === 'object') {
      return new Set(Object.keys(bucket));
    }
    warn(`基线形状不认识(要 unreachable 数组 / 对象,或一行一个路径的文本): ${file}`);
    return null;
  } catch {
    /* 不是 JSON ⇒ 当成纯文本清单 */
    const lines = text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('#'));
    if (lines.length === 0) {
      warn(`基线是空的(既不是 JSON 也没有一行一个路径): ${file}`);
      return null;
    }
    return new Set(lines);
  }
}

/** 主流程。 */
async function main() {
  const { warn, warnings } = createWarnings();

  /* `--baseline=<path>` 在 parseArgs 之前摘出来(parseArgs 只认裸开关)。 */
  const argv = process.argv.slice(2);
  let baselinePath = null;
  const rest = [];
  for (const arg of argv) {
    const m = /^--baseline=(.*)$/.exec(arg);
    if (m === null) {
      rest.push(arg);
      continue;
    }
    if (m[1] === '') {
      warn('--baseline= 后面没有路径,忽略');
      continue;
    }
    baselinePath = m[1];
  }
  if (argv.includes('--write-baseline')) {
    warn('本闸门**故意没有** --write-baseline:不可达清单是只读观测,把当前状态"写成已接受"正是这一轮要修的病(要对比请用 --baseline=<path>,只读)');
  }
  const opts = parseArgs(rest, ['--json'], warn);
  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }

  let failed = false;

  /* ---- 判据 1:产物跃升 ---- */
  let clientBytes = 0;
  try {
    clientBytes = (await stat(join(REPO, 'lib', 'client.js'))).size;
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err)?.code === 'ENOENT') {
      warn('lib/client.js 不存在 —— 判据 1 按"未构建"记失败(先跑 node scripts/build.mjs)');
    } else {
      warn(`lib/client.js 读不到(${/** @type {NodeJS.ErrnoException} */ (err)?.code ?? err})—— 判据 1 按 0 字节处理`);
    }
  }
  const grew = clientBytes >= PRE_WIRING_CLIENT_BYTES * GROWTH_FACTOR;
  const judgement1 = {
    id: 1,
    name: '产物跃升',
    ok: grew,
    baselineBytes: PRE_WIRING_CLIENT_BYTES,
    clientBytes,
    growthFactor: GROWTH_FACTOR,
    ratio: clientBytes / PRE_WIRING_CLIENT_BYTES,
  };
  if (!opts.json) {
    console.log('判据 1 · 产物跃升');
    console.log(`  接线前基准: ${PRE_WIRING_CLIENT_BYTES} bytes`);
    console.log(`  当前:       ${clientBytes} bytes(${(clientBytes / PRE_WIRING_CLIENT_BYTES).toFixed(2)}×)`);
    console.log(`  ${grew ? '✓' : '✗'} 门槛 ${GROWTH_FACTOR}× —— ${grew ? '已跃升,说明移植的 UI + 虚拟滚动进了包' : '未跃升 = 仍未接线(构建绿不算)'}`);
  }
  if (!grew) failed = true;

  /* ---- 判据 2:镜像可达文件数 ---- */
  const mirror = (await listFiles(join(REPO, MIRROR_ROOT)))
    .map((p) => p.slice(REPO.length + 1).split('\\').join('/'));
  const reach = await reachable(['src/client/index.ts', 'src/index.ts']);
  const used = mirror.filter((p) => reach.has(p));
  const ratio = mirror.length === 0 ? 0 : used.length / mirror.length;
  /* 失去可达的镜像模块:**排序**输出,便于两次运行之间直接 diff(本文件 2026-10 新增)。 */
  const unreachable = mirror.filter((p) => !reach.has(p)).sort();

  /* `--baseline=<path>`:只读棘轮 —— **只有"变多"才失败**。 */
  let baselineReport = { path: baselinePath, loaded: false, unreachable: null, newlyUnreachable: [], fixed: [] };
  if (baselinePath !== null) {
    const baseline = await readUnreachableBaseline(baselinePath, warn);
    if (baseline === null) {
      baselineReport = { path: baselinePath, loaded: false, unreachable: null, newlyUnreachable: [], fixed: [] };
    } else {
      const current = new Set(unreachable);
      const newlyUnreachable = unreachable.filter((p) => !baseline.has(p));
      const fixed = [...baseline].filter((p) => !current.has(p)).sort();
      baselineReport = {
        path: baselinePath,
        loaded: true,
        unreachable: baseline.size,
        newlyUnreachable,
        fixed,
      };
      /* 棘轮:不可达**变多** ⇒ 未登记的回退 ⇒ 失败(少了不失败)。 */
      if (newlyUnreachable.length > 0) {
        failed = true;
      }
    }
  }

  // 接线完成的标志:diff 渲染层进入 import 图
  const diffReachable = used.some((p) => p.includes('/ui/diff/side-by-side-diff'));
  const judgement2 = {
    id: 2,
    name: '镜像可达文件数',
    ok: diffReachable,
    mirrorTotal: mirror.length,
    reachable: used.length,
    unreachable: unreachable.length,
    ratio,
    ratioFloor: RATIO_FLOOR,
    diffReachable,
    unreachableList: unreachable,
  };
  if (!opts.json) {
    console.log('');
    console.log('判据 2 · 镜像可达文件数');
    console.log(`  镜像总数: ${mirror.length}`);
    console.log(`  可达:     ${used.length}(${(ratio * 100).toFixed(0)}%)`);
    console.log(`  ${diffReachable ? '✓' : '✗'} ui/diff/side-by-side-diff 可达`);
    console.log(`  ${ratio >= RATIO_FLOOR ? '✓' : '·'} 可达占比 ${(ratio * 100).toFixed(0)}%(参考线 ${RATIO_FLOOR * 100}%)`);
    console.log('');
    console.log(`  **失去可达的镜像模块(${unreachable.length})** —— 数量变化时直接看这份名单:`);
    for (const p of unreachable) {
      console.log(`    ${p}`);
    }
    if (baselineReport.loaded) {
      console.log('');
      console.log(`  --baseline 对比(${baselineReport.path}):`);
      console.log(`    基线不可达 ${baselineReport.unreachable} → 当前 ${unreachable.length};新增 ${baselineReport.newlyUnreachable.length};恢复 ${baselineReport.fixed.length}`);
      for (const p of baselineReport.newlyUnreachable) {
        console.log(`    + 新增不可达(棘轮:这会让本闸门失败)  ${p}`);
      }
      for (const p of baselineReport.fixed) {
        console.log(`    - 恢复可达  ${p}`);
      }
    }
  }
  if (!diffReachable) failed = true;

  /* ---- 判据 3:样式类名覆盖 ---- */
  const CSS_PROBES = [
    'side-by-side-diff', 'diff-header', 'diff-options', 'ReactVirtualized__Grid',
    'hunk-handle', 'line-number', 'diff-add', 'diff-delete', 'diff-hunk',
  ];
  let css = '';
  for (const candidate of ['src/client/desktop-diff-styles.generated.ts', 'src/client/desktop-diff-styles.ts']) {
    try {
      css += await readFile(join(REPO, candidate), 'utf8');
    } catch { /* 没有就算了 */ }
  }
  /** @type {{id: number, name: string, ok: boolean, [k: string]: unknown}} */
  let judgement3;
  if (css === '') {
    warn(`没有产出的样式模块(试过 ${['src/client/desktop-diff-styles.generated.ts', 'src/client/desktop-diff-styles.ts'].map((p) => rel(join(REPO, p))).join(' / ')})—— 判据 3 记失败(先跑 node scripts/build.mjs)`);
    judgement3 = { id: 3, name: '类名覆盖率', ok: false, cssBytes: 0, missing: CSS_PROBES, tokens: 0 };
    if (!opts.json) {
      console.log('');
      console.log('判据 3 · 类名覆盖率');
      console.log('  ✗ 没有产出的样式模块(desktop-diff-styles*.ts)');
    }
    failed = true;
  } else {
    const missing = CSS_PROBES.filter((c) => !css.includes(c));
    const tokens = (css.match(/--dsw-alias-[a-z0-9-]+/g) ?? []).length;
    const ok = missing.length === 0 && tokens > 0;
    judgement3 = { id: 3, name: '类名覆盖率', ok, cssBytes: css.length, probes: CSS_PROBES.length, missing, tokens };
    if (!opts.json) {
      console.log('');
      console.log('判据 3 · 类名覆盖率');
      console.log(`  样式模块: ${css.length} bytes`);
      console.log(`  ${missing.length === 0 ? '✓' : '✗'} 抽样 ${CSS_PROBES.length} 个类名,缺 ${missing.length} 个`);
      if (missing.length > 0) console.log(`    缺: ${missing.join(', ')}`);
      console.log(`  ${tokens > 0 ? '✓' : '✗'} 使用 DSH 主题令牌 ${tokens} 处(0 表示还在用上游硬编码色值)`);
    }
    if (missing.length > 0 || tokens === 0) failed = true;
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({
      tool: TOOL,
      ok: !failed,
      mirror: { root: MIRROR_ROOT, total: mirror.length, reachable: used.length, unreachable: unreachable.length, ratio },
      unreachable,
      baseline: baselineReport,
      judgements: [judgement1, judgement2, judgement3],
      warnings,
    }, null, 2)}\n`);
  } else {
    console.log('');
    console.log(failed
      ? 'dsh-git: 接线**未完成** —— 以上带 ✗ 的判据未达标(或 --baseline 棘轮被越过)。'
      : 'dsh-git: 接线三条判据全部达标 ✓');
    /* 警告已由 createWarnings() 即时写到 stderr,这里不再重复。 */
  }
  if (failed) process.exitCode = 1;
}

try {
  await main();
} catch (err) {
  /* 契约:绝不抛异常 —— 未预期错误 = 探针自身出错 = exit 2(不是"通过")。 */
  process.stderr.write(`警告: check-integration 探针自身出错: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exitCode = 2;
}
