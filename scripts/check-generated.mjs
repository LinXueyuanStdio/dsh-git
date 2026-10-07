#!/usr/bin/env node
/**
 * 生成物同步检查(generated-artifact / clean-working-tree check)
 * —— 抓「**生成物与它的源码不同步**」这一整类。
 *
 * ## 1. 它防的是什么,以及动机案例(逐字来自仓库自己的记录)
 *
 * 上游 GitHub Desktop 的 CI 只有一行覆盖这一类:
 * `references/desktop/.github/workflows/ci.yml:73-74` 的
 * **"Ensure a clean working directory"** = `git diff --name-status --exit-code` ——
 * 跑完 lint/校验后工作区必须干净,任何「codegen 漂移」立刻失败。
 * 本次工具链审计(`docs/toolchain-adoption.md` F2)把它列为**性价比最高的一条**。
 *
 * 我们**没有** CI,而且这个仓库当前只有 3 个被 git 跟踪的文件 ⇒ `git diff` 这条路不存在。
 * 所以等价判据必须换一个载体:**把「构建产物」记成一份清单(manifest),再断言磁盘上的
 * 生成物与它一致**。
 *
 * 动机案例(`scripts/verify-mirror.mjs` 文件头逐字记录):一个子代理把
 * `ui/octicons/octicons.generated.ts` 从 **379 个符号砍到 11 个**,而**构建绿、4 条检查全过**
 * —— 因为没人 import 它。`verify-mirror.mjs` 只覆盖 `src/core/desktop/**` 镜像树;
 * 它**不覆盖** `lib/*.js` 与 `src/client/desktop-diff-styles.generated.ts` 的**过期/被手改**。
 *
 * ## 2. 被检查的生成物与它们的输入
 *
 * | 生成物 | 由谁生成 | 输入 |
 * |---|---|---|
 * | `lib/index.js` + `lib/index.js.map` | `scripts/build.mjs`(host 半) | `src/**`、`package.json`、`scripts/build.mjs` |
 * | `lib/client.js` | `scripts/build.mjs`(浏览器半) | 同上 + `src/client/desktop-diff-styles.generated.ts` |
 * | `src/client/desktop-diff-styles.generated.ts` | `scripts/styles.mjs`(Dart Sass) | `src/client/scss/**`、`references/desktop/app/styles/**`、`scripts/styles.mjs` |
 *
 * ## 3. 两种模式(为什么默认**不**重跑构建)
 *
 * 一次构建要跑 Dart Sass + 两次 esbuild(主产物约 2 MB),而且**另一条线随时可能在构建**
 * (`scripts/build.mjs` 由别的 lane 持有)。所以:
 *
 * - **默认(快)**:只读磁盘 —— 把 4 个生成物的规范化 hash 与清单比对。
 *   判定刻意分两种「不一致」(多 lane 并发下实测出的必要区分):
 *     · **输入也没变、产物却变了** ⇒ 判**失败**(生成物被手改,或被一段不来自这些源码的构建覆盖);
 *     · **输入也变了** ⇒ 只**提示**「清单过期,跑 --rebuild --write-baseline 重记」
 *       (`--strict` 时才判失败)。否则任何一个 lane 正常重建都会让闸门变红,
 *       闸门会因为**正常行为**天天响 —— 然后被人关掉(那正是上游 markdownlint 的下场)。
 * - **`--rebuild`(慢,真正的干净工作区闸门)**:记录构建前 hash → 跑
 *   `node scripts/build.mjs` → 再记录一次 → **要求逐字节一致**(规范化时间戳之后)。
 *   这就是上游 `ci.yml:73-74` 的等价物:**再跑一次构建不产生任何变化**。
 *
 * ## 4. 已知盲区(必须连同结论一起读)
 *
 * - **构建时间戳**:`scripts/build.mjs` 把 `__BUILD_STAMP__`(ISO 时间)编译进两个 bundle,
 *   所以「字节一致」必须先**规范化时间戳**(`YYYY-MM-DD HH:MM:SS` → `<BUILD_STAMP>`)。
 *   规范化本身是盲区:若将来产物里出现别的每次构建都变的内容,本检查会**误报**(方向是吵,
 *   不是漏)。`lib/index.js.map` 实测不含时间戳,但仍一起规范化;
 * - **输入摘要是粗粒度的**:它把 `src/**` 全部文件进去,所以「改了一个不可达文件的注释」
 *   也会让 `--strict` 提示重建 —— 方向是**多报**,不会漏;
 * - **`--rebuild` 不检测并发**:它**检测得到**别的构建进程就**跳过**(退出码 2),
 *   但若那个进程在我们两次取样之间启动/结束,仍可能读到中间态。要绝对干净就在没有别的
 *   lane 构建设时跑;
 * - ebuild 失败时**不覆盖输出** ⇒ 本检查用「构建退出码 + 生成物存在 + mtime 晚于构建开始」
 *   三条一起判,而不是只看文件在不在(goal 文档 §3 失败模式 12 记的就是这个坑)。
 *
 * 用法:
 *
 *     node scripts/check-generated.mjs                    # 快:比对清单
 *     node scripts/check-generated.mjs --strict           # 快 + 输入变化也判失败
 *     node scripts/check-generated.mjs --json             # 机器可读
 *     node scripts/check-generated.mjs --rebuild          # 慢:重跑构建并比对(干净工作区闸门)
 *     node scripts/check-generated.mjs --rebuild --write-baseline   # 重建后重写清单
 *     node scripts/check-generated.mjs --force            # 有别的构建在跑时也强行 --rebuild
 *     node scripts/check-generated.mjs --help
 *
 * 退出码:0 = 一致(或只有「输入变了」的提示);1 = 有差异/缺文件;2 = 跳过(清单缺失、
 * 有并发构建、构建入口不存在)。
 *
 * @module dsh-git/scripts/check-generated
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ROOT, createWarnings, isFile, parseArgs, rel } from './gates-lib.mjs';

const execFileAsync = promisify(execFile);

/** 清单(基线)文件。 */
const MANIFEST_PATH = join(ROOT, 'scripts/generated-manifest.json');

/**
 * 被检查的生成物(顺序 = 报告顺序)。
 * `lib/` 在 `.gitignore` 里,所以「git 干净」这条路走不通 —— 这份清单就是替代品。
 */
const ARTIFACTS = [
  'src/client/desktop-diff-styles.generated.ts',
  'lib/index.js',
  'lib/index.js.map',
  'lib/client.js',
  // 浏览器半的 sourcemap:宿主 `dsh-client-modules` 会读它并喂给 devtools,
  // 所以它和别的生成物一样要进清单(否则被手改/被别的构建覆盖都没人发现)。
  'lib/client.js.map',
];

/** 构建入口(别的 lane 持有,这里只调用、不修改)。 */
const BUILD_ENTRY = 'scripts/build.mjs';

/** 除 `src/**` 之外的输入(相对仓库根)。 */
const EXTRA_INPUTS = ['package.json', 'scripts/build.mjs', 'scripts/styles.mjs'];

/**
 * 输入扫描根(相对仓库根)。
 *
 * 只有 `src`。上游样式表**已移植进** `src/client/scss/upstream/**`(183 个文件,
 * 与 `references/desktop/app/styles/**` 逐字节相同),所以构建的全部输入都在 `src` 下。
 *
 * 这里有两条**踩过的坑**,别再写回去:
 *  - `references/desktop/app/styles` —— 开发者本机的上游 checkout,`.gitignore:221`
 *    把 `/references/` 整个排除 ⇒ CI 检出里不存在,输入摘要对不上基线,闸门恒红;
 *  - `vendor/desktop/styles` —— 一样被 `.gitignore:224` 的 `/vendor/` 排除,
 *    「本地能跑」是假绿。
 * 判据:**输入根只能指向仓库里真的会被提交的文件**。
 */
const INPUT_DIRS = ['src'];

/** 规范化:构建时间戳每次构建都变,不是「不同步」。 */
const STAMP_RE = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/g;

/**
 * 读文件并规范化(失败返回 null,由调用方决定跳过还是失败)。
 * @param {string} file 绝对路径。
 * @returns {Promise<Buffer|null>} 内容。
 */
async function readNormalized(file) {
  try {
    const raw = await readFile(file);
    /* 只对文本类产物做替换;二进制直接按字节。 */
    if (/\.(js|map|ts|css)$/.test(file)) {
      return Buffer.from(raw.toString('utf8').replace(STAMP_RE, '<BUILD_STAMP>'), 'utf8');
    }
    return raw;
  } catch {
    return null;
  }
}

/**
 * 规范化 hash(缺失返回 null)。
 * @param {string} file 绝对路径。
 * @returns {Promise<string|null>} `sha256:<hex>`。
 */
async function hashArtifact(file) {
  const content = await readNormalized(file);
  if (content === null) return null;
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

/**
 * 递归列文件(不抛;跳过 node_modules/.git)。
 * @param {string} dir 目录。
 * @param {string[]} exts 后缀白名单。
 * @param {string[]} out 收集数组。
 * @param {(message: string) => void} warn 警告函数。
 */
async function collectFiles(dir, exts, out, warn) {
  /** @type {import('node:fs').Dirent[]} */
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    warn(`读不到目录(输入摘要可能不全): ${rel(dir)} (${/** @type {NodeJS.ErrnoException} */ (err)?.code ?? err})`);
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      await collectFiles(full, exts, out, warn);
      continue;
    }
    if (exts.length > 0 && !exts.some((x) => entry.name.endsWith(x))) continue;
    out.push(full);
  }
}

/**
 * 算输入摘要:`sha256(排序后的 "相对路径\0内容sha")`。
 * 粗粒度是**故意的** —— 宁可可报「该重建了」,也不要漏掉一次真实的 codegen 漂移。
 * @param {(message: string) => void} warn 警告函数。
 * @returns {Promise<{digest: string, files: number}>} 摘要与参与文件数。
 */
async function inputDigest(warn) {
  /** @type {string[]} */
  const files = [];
  for (const dir of INPUT_DIRS) {
    await collectFiles(join(ROOT, dir), [], files, warn);
  }
  for (const extra of EXTRA_INPUTS) {
    const full = join(ROOT, extra);
    if (await isFile(full)) files.push(full);
    else warn(`输入清单里的文件不存在: ${extra}`);
  }
  files.sort();
  const outer = createHash('sha256');
  let hashed = 0;
  for (const file of files) {
    let content;
    try {
      content = await readFile(file);
    } catch (err) {
      warn(`输入读不到(摘要会变): ${rel(file)} (${/** @type {NodeJS.ErrnoException} */ (err)?.code ?? err})`);
      continue;
    }
    const inner = createHash('sha256').update(content).digest('hex');
    outer.update(`${rel(file)}\u0000${inner}\n`);
    hashed++;
  }
  return { digest: `sha256:${outer.digest('hex')}`, files: hashed };
}

/**
 * 列出正在运行的构建进程(不抛)。返回命中的命令行。
 * @returns {Promise<string[]>} 命中的命令行(已排除自身与 grep)。
 */
async function findConcurrentBuild() {
  try {
    const { stdout } = await execFileAsync('ps', ['-eo', 'pid,command'], { maxBuffer: 8 << 20 });
    const self = process.pid;
    const hits = [];
    for (const line of stdout.split('\n')) {
      if (!/esbuild|build\.mjs/.test(line)) continue;
      if (/\bgrep\b/.test(line)) continue;
      const pid = Number.parseInt(line.trim().split(/\s+/)[0] ?? '', 10);
      if (pid === self) continue;
      // 本进程自己的命令行里不会有 build.mjs;但 ps 行含 check-generated 时也不算构建
      if (line.includes('check-generated.mjs')) continue;
      hits.push(line.trim());
    }
    return hits;
  } catch (err) {
    return [`ps 不可用(${/** @type {NodeJS.ErrnoException} */ (err)?.code ?? err})`];
  }
}

/**
 * 给 4 个生成物打一次快照。
 * @returns {Promise<Record<string, {hash: string|null, mtimeMs: number|null, size: number|null}>>} 快照。
 */
async function snapshotArtifacts() {
  /** @type {Record<string, {hash: string|null, mtimeMs: number|null, size: number|null}>} */
  const out = {};
  for (const artifact of ARTIFACTS) {
    const full = join(ROOT, artifact);
    const hash = await hashArtifact(full);
    let mtimeMs = null;
    let size = null;
    try {
      const info = await stat(full);
      mtimeMs = info.mtimeMs;
      size = info.size;
    } catch {
      /* 缺失:hash 已是 null */
    }
    out[artifact] = { hash, mtimeMs, size };
  }
  return out;
}

const HELP = `用法: node scripts/check-generated.mjs [--json] [--strict] [--rebuild] [--write-baseline] [--force]

  生成物同步检查:断言 lib/*.js 与 src/client/*.generated.ts 与它们的源码一致
  (等价于 GitHub Desktop CI 的 "Ensure a clean working directory",见 docs/toolchain-adoption.md F2)。
  退出码 0 = 一致(或只有「输入变了」的提示);1 = 有差异;2 = 跳过。

  --json             stdout 输出机器可读 JSON
  --strict           输入摘要变化也判失败(完整语义:构建后工作区必须干净)
  --rebuild          记录 hash → 跑 node scripts/build.mjs → 再记录 → 要求逐字节一致
  --write-baseline   用当前磁盘状态重写 scripts/generated-manifest.json
  --force            检测到别的构建在跑时也强行 --rebuild
  --help             显示本帮助
`;

/** 主流程。 */
async function main() {
  const { warn, warnings } = createWarnings();
  const opts = parseArgs(process.argv.slice(2), ['--json', '--strict', '--rebuild', '--write-baseline', '--force'], warn);
  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }

  const emit = (/** @type {Record<string, unknown>} */ payload) => {
    process.stdout.write(`${JSON.stringify({ tool: 'dsh-git/scripts/check-generated.mjs', ...payload }, null, 2)}\n`);
  };
  const skip = (/** @type {string} */ reason) => {
    if (opts.json) emit({ skipped: true, reason, warnings });
    else process.stdout.write(`check-generated: SKIP(${reason})\n`);
    process.exitCode = 2;
  };

  const before = await snapshotArtifacts();
  /** @type {{digest: string, files: number}|null} */
  let inputs = null;
  /** @type {{exitCode: number, stdout: string, stderr: string, startedAt: number, ms: number}|null} */
  let buildResult = null;
  /** @type {Record<string, {hash: string|null, mtimeMs: number|null, size: number|null}>|null} */
  let after = null;

  if (opts.rebuild) {
    if (!(await isFile(join(ROOT, BUILD_ENTRY)))) {
      skip(`构建入口不存在: ${BUILD_ENTRY}`);
      return;
    }
    const concurrent = await findConcurrentBuild();
    const realConcurrent = concurrent.filter((line) => !line.startsWith('ps 不可用'));
    if (realConcurrent.length > 0 && !opts.force) {
      warn(`检测到别的构建在跑(${realConcurrent.length} 个),按约定跳过而不是抢构建:`);
      for (const line of realConcurrent.slice(0, 3)) warn(`  ${line}`);
      skip('有并发构建(--force 可强行)');
      return;
    }
    const startedAt = Date.now();
    let stdout = '';
    let stderr = '';
    let exitCode = 0;
    try {
      const result = await execFileAsync(process.execPath, [BUILD_ENTRY], { cwd: ROOT, maxBuffer: 64 << 20 });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (err) {
      exitCode = typeof (/** @type {any} */ (err)?.code) === 'number' ? /** @type {any} */ (err).code : 1;
      stdout = String(/** @type {any} */ (err)?.stdout ?? '');
      stderr = String(/** @type {any} */ (err)?.stderr ?? '');
    }
    buildResult = { exitCode, stdout, stderr, startedAt, ms: Date.now() - startedAt };
    after = await snapshotArtifacts();
  }

  inputs = await inputDigest(warn);

  /* ---------- 判定 ---------- */
  /** @type {{artifact: string, kind: string, before: string|null, after: string|null}[]} */
  const changes = [];
  /** @type {{artifact: string, kind: string, detail: string}[]} */
  const problems = [];
  /** @type {{artifact: string, mtimeMs: number|null}[]} */
  const staleWarnings = [];

  if (after !== null) {
    let changedCount = 0;
    for (const artifact of ARTIFACTS) {
      const b = before[artifact];
      const a = after[artifact];
      if (a.hash === null) {
        problems.push({ artifact, kind: 'missing-after-build', detail: '构建后生成物不存在(esbuild 失败时不覆盖输出,见 goal §3 失败模式 12)' });
        continue;
      }
      if (b.hash === null) {
        changes.push({ artifact, kind: 'created', before: null, after: a.hash });
        problems.push({ artifact, kind: 'created-by-rebuild', detail: '重建前这个产物不存在,构建把它补上了 —— 说明此前的工作区是不完整的' });
        continue;
      }
      if (b.hash !== a.hash) {
        changes.push({ artifact, kind: 'changed', before: b.hash, after: a.hash });
        changedCount++;
        problems.push({
          artifact,
          kind: 'changed-by-rebuild',
          detail: `重跑构建把这个产物改成了别的字节(规范化时间戳之后)⇒ 磁盘上的产物**不是**当前源码的构建结果`,
        });
        continue;
      }
      /* 一致 —— 再看它是不是**这次构建**写的(时间戳规范化后一致,可能是残留) */
      if (buildResult !== null && a.mtimeMs !== null && a.mtimeMs < buildResult.startedAt - 2000) {
        staleWarnings.push({ artifact, mtimeMs: a.mtimeMs });
      }
    }
    if (buildResult !== null && buildResult.exitCode !== 0) {
      problems.push({ artifact: '-', kind: 'build-failed', detail: `node ${BUILD_ENTRY} 退出码 ${buildResult.exitCode}` });
    }
    if (changedCount > 0) warn(`${changedCount} 个生成物在重跑构建后被改写 ⇒ 「工作区必须干净」不成立(upstream ci.yml:73-74 的等价判据)`);
  } else {
    /* 默认模式:与清单比对 */
    let manifest;
    try {
      manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
    } catch (err) {
      const code = /** @type {NodeJS.ErrnoException} */ (err)?.code;
      if (code === 'ENOENT') skip(`清单不存在(${rel(MANIFEST_PATH)})—— 先跑: node scripts/check-generated.mjs --rebuild --write-baseline`);
      else skip(`清单不可读/不是合法 JSON: ${rel(MANIFEST_PATH)} (${code ?? /** @type {any} */ (err)?.message ?? err})`);
      return;
    }
    const recordedArtifacts = manifest?.artifacts;
    if (recordedArtifacts === null || typeof recordedArtifacts !== 'object') {
      skip(`清单形状不对(缺 artifacts): ${rel(MANIFEST_PATH)}`);
      return;
    }
    /*
     * 判定分两种「不一致」,因为它们的含义完全不同(2026-10 在多 lane 并发下实测出的语义):
     *
     *  A. **输入也变了** ⇒ 生成物是被**另一次合法构建**从新源码里写出来的。
     *     默认只提示「清单过期了,跑 --rebuild --write-baseline」,`--strict` 才判失败。
     *     不这样分的话,任何一个 lane 重新构建都会让本闸门变红 —— 闸门会因为**正常行为**
     *     天天响,然后被人关掉(那正是上游 markdownlint 的下场)。
     *  B. **输入没变、产物却变了** ⇒ 这才是真缺陷:生成物被**手改**,或者被一段
     *     不来自这些源码的构建覆盖了。永远判失败。
     */
    const inputsChanged = typeof manifest?.inputsDigest === 'string' && manifest.inputsDigest !== inputs.digest;
    /** @type {{artifact: string, kind: string, detail: string}[]} */
    const manifestWarnings = [];
    for (const artifact of ARTIFACTS) {
      const recorded = /** @type {Record<string, unknown>} */ (recordedArtifacts)[artifact];
      const now = before[artifact].hash;
      if (typeof recorded !== 'string') {
        problems.push({ artifact, kind: 'not-in-manifest', detail: '清单里没有这个生成物(清单过期)' });
        continue;
      }
      if (now === null) {
        problems.push({ artifact, kind: 'missing', detail: '生成物不存在' });
        continue;
      }
      if (now === recorded) continue;
      const detail =
        `磁盘 hash ${now.slice(0, 19)}… ≠ 清单 ${recorded.slice(0, 19)}…` +
        (inputsChanged
          ? '(输入也变了 ⇒ 多半是另一次合法构建写的新产物;清单过期,跑 --rebuild --write-baseline 重记)'
          : '(输入**没变** ⇒ 生成物被手改,或被一段不来自这些源码的构建覆盖了)');
      if (inputsChanged && !opts.strict) manifestWarnings.push({ artifact, kind: 'rebuilt-with-new-inputs', detail });
      else problems.push({ artifact, kind: 'hash-mismatch', detail });
    }
    for (const w of manifestWarnings) warn(`${w.artifact}: ${w.detail}`);
    if (inputsChanged) {
      const detail =
        `源码/输入自上次记录以来变了(输入摘要 ${inputs.digest.slice(0, 19)}… ≠ 清单 ${manifest.inputsDigest.slice(0, 19)}…);` +
        '生成物可能已过期 —— 跑 node scripts/check-generated.mjs --rebuild 验证';
      const staleArtifacts = ARTIFACTS.filter((a) => before[a].hash === /** @type {Record<string, string>} */ (recordedArtifacts)[a]);
      if (staleArtifacts.length > 0) warn(`${detail}(其中 ${staleArtifacts.length} 个生成物的 hash 与清单一致 ⇒ 它们没跟着新源码重建:${staleArtifacts.join(', ')})`);
      else warn(detail);
      if (opts.strict) problems.push({ artifact: '-', kind: 'inputs-changed', detail });
    }
  }

  /* ---------- 写清单 ---------- */
  const manifestAfter = after ?? before;
  /*
   * **构建红了就不许记清单**:`--write-baseline` 的语义是「把这次**成功**构建的产物
   * 钉成期望状态」。若 `node scripts/build.mjs` 退出码非 0,产物可能只写了一半
   * (esbuild 失败不覆盖输出,而 build.mjs 的预构建检查失败时**仍会继续构建**),
   * 把它记成期望状态等于把一次坏构建固化成「正确」。要强行记就显式 `--force`。
   */
  const buildRed = after !== null && buildResult !== null && buildResult.exitCode !== 0;
  if (opts.writeBaseline && buildRed && !opts.force) {
    warn(`构建退出码 ${buildResult?.exitCode}(不是成功构建)⇒ **不写清单**。修好构建后重跑,或显式 --force`);
  } else if (opts.writeBaseline) {
    /** @type {Record<string, string>} */
    const artifacts = {};
    for (const artifact of ARTIFACTS) {
      const hash = manifestAfter[artifact].hash;
      if (hash !== null) artifacts[artifact] = hash;
    }
    try {
      await writeFile(
        MANIFEST_PATH,
        `${JSON.stringify(
          {
            note: '由 node scripts/check-generated.mjs --write-baseline 生成。artifacts 是**规范化构建时间戳之后**的 sha256;inputsDigest 是 src/** 等输入的摘要。',
            recordedAt: new Date().toISOString(),
            inputsDigest: inputs.digest,
            inputFiles: inputs.files,
            artifacts,
          },
          null,
          2,
        )}\n`,
        'utf8',
      );
      process.stderr.write(`check-generated: 已写入清单 ${rel(MANIFEST_PATH)}(${Object.keys(artifacts).length} 个生成物)\n`);
    } catch (err) {
      warn(`清单写入失败: ${rel(MANIFEST_PATH)} (${/** @type {NodeJS.ErrnoException} */ (err)?.code ?? err})`);
    }
  }

  const counts = {
    artifacts: ARTIFACTS.length,
    inputFiles: inputs.files,
    rebuild: after !== null,
    buildExitCode: buildResult?.exitCode ?? null,
    buildMs: buildResult?.ms ?? null,
    changes: changes.length,
    problems: problems.length,
    staleWarnings: staleWarnings.length,
  };

  if (opts.json) {
    emit({
      counts,
      mode: after !== null ? 'rebuild' : opts.strict ? 'manifest-strict' : 'manifest',
      inputsDigest: inputs.digest,
      artifacts: ARTIFACTS.map((artifact) => ({
        path: artifact,
        before: before[artifact].hash,
        after: after === null ? null : after[artifact].hash,
        mtimeMs: (after ?? before)[artifact].mtimeMs,
        size: (after ?? before)[artifact].size,
      })),
      changes,
      problems,
      staleWarnings,
      build: buildResult === null ? null : { exitCode: buildResult.exitCode, ms: buildResult.ms, stderrTail: buildResult.stderr.trim().split('\n').slice(-5) },
      warnings,
    });
  } else {
    const out = (s = '') => process.stdout.write(`${s}\n`);
    out('dsh-git: 生成物同步检查(generated-artifact / clean-working-tree)');
    out(`  模式:${after !== null ? '--rebuild(重跑构建并比对)' : opts.strict ? '清单比对(--strict)' : '清单比对'}`);
    out(`  输入:${counts.inputFiles} 个文件(hash ${inputs.digest.slice(0, 19)}…)`);
    out(`  生成物:${counts.artifacts} 个`);
    if (buildResult !== null) out(`  构建:exit ${buildResult.exitCode},${buildResult.ms}ms`);
    out('');
    for (const artifact of ARTIFACTS) {
      const b = before[artifact];
      const a = after === null ? null : after[artifact];
      const sizeText = a?.size ?? b.size;
      const hashText = (a?.hash ?? b.hash)?.slice(0, 19) ?? '(缺失)';
      const mark = a === null ? '' : a.hash === b.hash ? ' (未变)' : b.hash === null ? ' (新建)' : ' (**变了**)';
      out(`    ${artifact.padEnd(44)} ${String(sizeText ?? '-').padStart(9)} B  ${hashText}…${mark}`);
    }
    if (changes.length > 0) {
      out('');
      out('  重跑构建**改变**了这些生成物(它们与源码不同步):');
      for (const c of changes) out(`    ${c.kind.padEnd(8)} ${c.artifact}`);
    }
    if (problems.length > 0) {
      out('');
      out(`  问题 ${problems.length} 条:`);
      for (const p of problems) out(`    ${p.kind.padEnd(18)} ${p.artifact}  ${p.detail}`);
    }
    if (staleWarnings.length > 0) {
      out('');
      out('  警告:以下生成物 hash 一致但 mtime 早于本次构建开始(可能不是这次构建写的):');
      for (const s of staleWarnings) out(`    ${s.artifact}`);
    }
    if (warnings.length > 0) {
      out('');
      out(`  警告 ${warnings.length} 条:`);
      for (const w of warnings.slice(0, 10)) out(`    ! ${w}`);
    }
    out('');
    out(`  结论:${problems.length === 0 ? 'PASS' : `FAIL(${problems.length} 条)`}  退出码 ${problems.length === 0 ? 0 : 1}`);
  }

  process.exitCode = problems.length > 0 ? 1 : 0;
}

await main();
