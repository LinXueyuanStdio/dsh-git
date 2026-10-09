#!/usr/bin/env node
/**
 * 上游(deepseek-harness)发布监视 —— 回答一个问题:**「要不要为上游的新版本做一次动作」**。
 *
 * ## 为什么不能用 Dependabot
 *
 * 本仓库对上游**没有真依赖**。浏览器半的 `@deepseek-ai/*` 全部是 esbuild 的
 * `external`(见 `scripts/build.mjs` 的 `clientExternal`),运行期由宿主 loader 提供;
 * `package.json` 里唯一写着上游的是**可选 peer**
 * `@deepseek-ai/dsh-client-ui-primitives` 的一个版本范围,以及
 * `types/client-platform-shims.d.ts` 里那份**手抄的**类型面。
 * ⇒ 没有 lockfile 可升,没有依赖可解析,Dependabot 在这个仓库里**什么都看不见**;
 * 它也**永远不会**去跑那段 40 分钟的 `scripts/e2e-deploy.mjs`。
 *
 * ## 判定「上游变了」的信号:发布线 **不是** `latest`
 *
 * 上游把 `latest` 留在了很老的地方 —— 实测 2026-10-03:
 *
 * | 包 | `latest` | `next` | `alpha` |
 * |---|---|---|---|
 * | `@deepseek-ai/dsh` | 0.2.0-rc.2 | 0.2.0-rc.2 | 0.2.1-alpha.1 |
 * | `dsh-base` / `dsh-web-app` / `dsh-client-ui-primitives` | **0.0.1-rc.1** | 0.2.0-rc.2 | 0.2.1-alpha.1 |
 *
 * 子包的 `latest` = `0.0.1-rc.1` 这件事本身就是 `scripts/e2e-deploy.mjs` 头注释里
 * 记的那条 version skew 的根因(也是 `.github/workflows/ci.yml` 里装 `@next` 的理由)。
 * 所以这里只认 **`next`**(rc 线)与 **`alpha`**(预览线),`latest` 一概不看。
 *
 * ## 「整列出齐」才认:比 `dsh` 单包更严的一道门
 *
 * 只盯 `@deepseek-ai/dsh` 是**不够的**:profile 里真正被锁版本的是
 * `@deepseek-ai/dsh-base` 与 `@deepseek-ai/dsh-web-app`(见 `e2e-deploy.mjs` 的
 * `pinBundleVersions`),而发布是**逐包推**的,中间存在「CLI 已经是新版、bundle 还是旧版」
 * 的窗口。实测历史上 30 个版本里,核心 5 包的发布窗口
 * **中位 0.4 分钟 / 最大 2.3 分钟**(0 个版本缺包),所以这里要求:
 *
 *  1. `@deepseek-ai/dsh` 的 `next` 指向 T;
 *  2. 核心 5 包(`CORE`)在 registry 上**都有** T;
 *  3. T 的最后一个包发布之后已经过了 `--settle` 分钟(默认 5,是历史最大窗口 2.3 分钟的两倍)。
 *
 * 三条都过才叫「T 可以拿去验」。没过就报 `incomplete` / `settling` 并**不动作** ——
 * 拿一列没出齐的版本去跑 e2e,红的是上游的发布时序,不是这个插件。
 *
 * ## 它**不**做什么(免责声明,写在这里而不是文档里)
 *
 * 它不做**语义**升级。宿主接缝改名/改签名时,要动的
 * `types/client-platform-shims.d.ts`(文件头就写着「签名要逐字对得上」)与各处调用点,
 * 是版本号**推导不出来**的。所以本脚本只负责两件机械事:
 *
 *  - peer 范围**没有覆盖** T 时,把 T 追加进那条「验过的线」清单(已经覆盖就一个字不改 ——
 *    见下面 `peerCovers()` 的注释);
 *  - 把「T 已在哪个 run 上验过」记进基线,并往 CHANGELOG 的 `[Unreleased]` 追加一条。
 *
 * 真正的语义修复由人(或一个被叫来写补丁的 agent)在 PR 上做;红了就开 issue 交出去。
 *
 * ## 退出码(与 `scripts/verify-plugin.mjs` 同一套,外加一个 10)
 *
 * - **0** = 无需动作(lane 上的目标版本就是基线里验过的那个),或 `--apply` / `--record-red` 成功;
 * - **10** = 上游变了,而**这只是检测**(没给 `--apply`)—— workflow 靠它决定去跑 e2e;
 * - **1** = 上游状态**暂时不可动作**:整列没出齐 / 还在 settle 窗口内 / 目标版本比基线里的旧
 *   (tag 被回滚)。**不是**错误,下次 cron 再看;
 * - **2** = 探针自身出错(registry 取不到、JSON 形状不认识、`--target` 非法)。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/upstream-watch.mjs                      # 人读:上游变了没有
 * node scripts/upstream-watch.mjs --json               # 机器读(stdout 纯 JSON)
 * node scripts/upstream-watch.mjs --lane=alpha         # 换预览线
 * node scripts/upstream-watch.mjs --settle=10          # 放宽出齐等待(分钟)
 * node scripts/upstream-watch.mjs --apply --target=0.2.0-rc.2 --run-url=https://…
 * node scripts/upstream-watch.mjs --record-red --target=0.2.0-rc.2 --run-url=https://…
 * ```
 *
 * `--apply` 与 `--record-red` 会**写仓库里的文件**(它们是 workflow 里那两个动作步),
 * 其余模式一律只读。
 *
 * @module dsh-git/scripts/upstream-watch
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..');

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 基线文件。放在 `scripts/` 下与 `lint-baseline.json` / `type-baseline.json` 同处。 */
const BASELINE = join(REPO, 'scripts/upstream-baseline.json');
const PKG_JSON = join(REPO, 'package.json');
const CHANGELOG = join(REPO, 'CHANGELOG.md');

/** 上游包名(scope 固定,方便统一拼 registry URL)。 */
const SCOPE = '@deepseek-ai/';

/**
 * **门槛用的核心 5 包** —— 缺任何一个都不认为「这个版本出齐了」。
 *
 * 这 5 个是 profile 真正要装/要解析的东西:CLI 本身 + 它的两个 bundle
 * (`dsh-base` / `dsh-web-app`,被 `e2e-deploy.mjs` 按 `dsh --version` 锁死)
 * + 客户端 bundle 加载器(`dsh-client-modules`)+ 我们唯一声明为 peer 的原语包。
 *
 * ⚠️ `dsh-client-ui-sidebar-right` **刻意不在**门槛里:它直到 0.1.5-alpha.1 才开始
 * 跟着整列发(此前 12 个版本都没有它),放进门槛会让历史回放里一半的版本永远「没出齐」。
 * 它仍然被**观察**(见 `WATCH`),出现在报告里,只是不决定「要不要动作」。
 */
const CORE = [
  'dsh',
  'dsh-base',
  'dsh-web-app',
  'dsh-client-modules',
  'dsh-client-ui-primitives',
];

/** 观察面 = 门槛 5 包 + 我们集成时真正依赖、但不适合当门槛的那几个。 */
const WATCH = [...CORE, 'dsh-client-ui-sidebar-right', 'dsh-client-store'];

/** 我们唯一声明为 peer 的上游包(peer 范围要对齐的就是它)。 */
const PEER_NAME = SCOPE + 'dsh-client-ui-primitives';

/** registry 请求超时与重试。CI 上一次网络抖动不该让整个 cron 变成红。 */
const TIMEOUT_MS = 20_000;
const RETRIES = 3;

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);

/**
 * 读一个 `--flag value` / `--flag=value` 形式的值;没有这个 flag 时返回 `fallback`。
 * @param {string} name
 * @param {any} [fallback] 没给这个 flag 时的默认值
 * @returns {any}
 */
function flag(name, fallback) {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (hit === undefined) {return fallback;}
  const eq = hit.indexOf('=');
  if (eq !== -1) {return hit.slice(eq + 1);}
  const next = argv[argv.indexOf(hit) + 1];
  return next === undefined || next.startsWith('--') ? true : next;
}
/** 有没有给这个开关(只判存在,不看值)。
 * @param {string} name
 * @returns {boolean}
 */
const has = (name) => argv.includes(`--${name}`);

const HELP = `用法: node scripts/upstream-watch.mjs [选项]

检测上游(deepseek-harness 的 npm 发布线)有没有变到需要动作的版本。
只读运行;--apply / --record-red 才写文件。

选项:
  --json               stdout 输出纯 JSON(警告仍走 stderr)
  --lane=<tag>         发布线,next(默认)| alpha
  --settle=<分钟>      「整列出齐」的等待窗口,默认 5
  --apply              对齐:peer 范围 + 基线(verified)+ CHANGELOG 的 [Unreleased]
  --record-red         只记失败(基线 lastFailure),不改 package.json / CHANGELOG
  --target=<版本>      --apply / --record-red 必需
  --run-url=<url>      --apply / --record-red / --render 用(Actions run 链接)
  --render             把 --report 的检测报告渲染成 PR / issue 正文
  --report=<路径>      --render 必需:检测报告 JSON
  --outcome=green|red  --render 用,默认 green
  --log=<路径>         --render 用:失败时附在正文里的日志(取尾部 80 行)
  --selftest           不联网自检判据逻辑(compareVersions / peerCovers)
  --help

退出码:0 无需动作或写入成功;10 上游变了(仅检测模式);1 上游状态暂不可动作;2 探针出错。
`;

if (has('help')) {
  process.stdout.write(HELP);
  process.exit(0);
}

const JSON_OUT = has('json');
const LANE = String(flag('lane', 'next'));
const SETTLE_MIN = Number(flag('settle', 5));
const APPLY = has('apply');
const RECORD_RED = has('record-red');
const TARGET_ARG = flag('target', undefined);
const RUN_URL = flag('run-url', undefined);

/** 警告一律走 stderr —— `--json` 时 stdout 必须是纯 JSON。
 * @param {string} msg
 * @returns {void}
 */
function warn(msg) {
  process.stderr.write(`⚠️  ${msg}\n`);
}

/** 探针自身出错:exit 2,并且**绝不**输出半份 JSON 让人以为读到了结论。
 * @param {string} msg
 * @returns {never}
 */
function die(msg) {
  process.stderr.write(`\n${JSON_OUT ? '' : '✗ '}${msg}\n`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// registry 读取
// ---------------------------------------------------------------------------

/**
 * 取一个包的完整 packument。
 *
 * 用**完整**文档而不是缩写的(`application/vnd.npm.install-v1+json`):缩写文档里
 * **没有 `time`**,而本脚本的 settle 判定完全建立在 `time[version]` 上 ——
 * 拿不到时间戳就只能盲等,那是另一套设计。完整文档约几百 KB × 8 个包,
 * 对一次 cron 来说不值得为省它换掉判据。
 */
/**
 * @param {string} name 完整包名(带 scope)
 * @returns {Promise<any>} packument
 */
async function packument(name) {
  const url = `https://registry.npmjs.org/${encodeURIComponent(name)}`;
  let lastError;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { accept: 'application/json' },
      });
      if (res.status === 404) {die(`registry 上没有 ${name}(404)—— 包名拼错了?`);}
      if (!res.ok) {throw new Error(`HTTP ${res.status}`);}
      return await res.json();
    } catch (err) {
      lastError = err;
      // 退避 1s / 2s;第 3 次失败才放弃。
      if (attempt < RETRIES) {await new Promise((r) => setTimeout(r, 1000 * attempt));}
    }
  }
  die(`取 ${name} 失败(${RETRIES} 次):${lastError?.message ?? lastError}`);
}

// ---------------------------------------------------------------------------
// 基线
// ---------------------------------------------------------------------------

const EMPTY_BASELINE = {
  $comment:
    '上游发布监视的状态。verified = 最后一次**通过端到端部署测试**的上游版本'
    + '(由 .github/workflows/upstream-watch.yml 写);lastFailure = 最后一次红。'
    + '人可以让它失效(把 verified 删掉)以强制重验一次。',
  lane: 'next',
  verified: null,
  lastFailure: null,
  history: [],
};

async function readBaseline() {
  try {
    const raw = await readFile(BASELINE, 'utf8');
    const parsed = JSON.parse(raw);
    return { ...EMPTY_BASELINE, ...parsed };
  } catch (err) {
    if (err.code === 'ENOENT') {return { ...EMPTY_BASELINE };}
    die(`基线读不懂(${BASELINE}):${err.message}`);
  }
}

/**
 * @param {any} next 整份基线对象
 * @returns {Promise<void>}
 */
async function writeBaseline(next) {
  await writeFile(BASELINE, JSON.stringify(next, null, 2) + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// 版本比较(只用 `X.Y.Z-pre.N` 这一种形状,所以不需要 semver 依赖)
// ---------------------------------------------------------------------------

/**
 * 把版本拆成可比较的段;形状不认识就抛(宁可 exit 2,不要静默按字符串比大小)。
 * @param {any} v
 * @returns {{major: number, minor: number, patch: number, pre: string[] | null}}
 */
function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v).trim());
  if (!m) {throw new Error(`版本号形状不认识:${JSON.stringify(v)}`);}
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ? m[4].split('.') : null, // rc.2 → ['rc','2']
  };
}

/** 版本里按数值比较的三段(`as const` 让 `A[key]` 保持字面量联合,而不是 `string` 索引)。 */
const NUMERIC_KEYS = /** @type {const} */ (['major', 'minor', 'patch']);

/**
 * -1 / 0 / 1。预发布版本的规则按 semver §11 的**近似**:数值段比字符串段小。
 * @param {any} a
 * @param {any} b
 * @returns {-1 | 0 | 1}
 */
function compareVersions(a, b) {
  const A = parseVersion(a);
  const B = parseVersion(b);
  for (const key of NUMERIC_KEYS) {
    if (A[key] !== B[key]) {return A[key] < B[key] ? -1 : 1;}
  }
  if (A.pre === null && B.pre === null) {return 0;}
  if (A.pre === null) {return 1;} // 正式版 > 预发布版
  if (B.pre === null) {return -1;}
  for (let i = 0; i < Math.max(A.pre.length, B.pre.length); i++) {
    const x = A.pre[i];
    const y = B.pre[i];
    if (x === undefined) {return -1;}
    if (y === undefined) {return 1;}
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      if (Number(x) !== Number(y)) {return Number(x) < Number(y) ? -1 : 1;}
    } else if (nx) {
      return -1; // 数值段 < 字符串段
    } else if (ny) {
      return 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// peer 范围
// ---------------------------------------------------------------------------

/**
 * 现在这条 peer 范围**已经接受** T 了吗?
 *
 * 为什么要问这个问题,而不是无脑追加:范围现在是
 * `>=0.2.0-rc.2 || >=0.3.0-rc.1 || >=0.4.0-rc.1 || >=0.5.0-rc.1` ——
 * **第一条 `>=` 就覆盖了后面所有条**(后三条是冗余的,它们的作用是当一份
 * 「这条线我验过」的清单)。所以对 `0.2.0-rc.2` 这样的目标,追加是**语义空的**改动。
 * 那就别改:`--apply` 只在**真的没被覆盖**时动 package.json,否则一个字不改并如实报告。
 * (要不要把这条无上界范围收紧成有上界的窗口,是**语义决定**,不该由一个 cron 替人做。)
 *
 * 解析范围用的是**足以读懂本仓库这一种写法**的最小实现:`&&` 连接的比较子句,
 * 子句之间 `||`。遇到读不懂的子句就**当作不覆盖**(保守:宁可多追加一条,不可漏)。
 */
/**
 * @param {string | null | undefined} range
 * @param {string} version
 * @returns {boolean}
 */
function peerCovers(range, version) {
  if (typeof range !== 'string' || range.trim() === '') {return false;}
  try {
    parseVersion(version);
  } catch {
    return false;
  }
  return range.split('||').some((clause) => {
    // ⚠️ 这里按**空白**切是不够的:npm 范围写成 `>=0.2.0-rc.2`(运算符与版本**粘连**),
    // 一个 token 就是「一个子句」。所以每个 token 再拆成 op + version,
    // 拆不出形状的(`^1.2.3` / `~1.2.3` / `x` / `*`)一律**当作不覆盖** ——
    // 保守方向是「多追加一条冗余子句」,不是「漏掉一次对齐」。
    const tokens = clause.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) {return false;}
    for (const token of tokens) {
      const m = /^(>=|<=|>|<|=)?(.+)$/.exec(token);
      if (!m) {return false;}
      const op = m[1] ?? '=';
      let cmp;
      try {
        cmp = compareVersions(version, m[2]);
      } catch {
        return false; // `^1.2.3` / `1.x` 之类:读不懂 ⇒ 不认为覆盖
      }
      const ok =
        (op === '>=' && cmp >= 0)
        || (op === '>' && cmp > 0)
        || (op === '<=' && cmp <= 0)
        || (op === '<' && cmp < 0)
        || (op === '=' && cmp === 0);
      if (!ok) {return false;}
    }
    return true;
  });
}

/** 追加一条 `|| >=T`。已经覆盖则不写。
 * @param {string} target
 * @returns {Promise<{changed: boolean, range: string | null | undefined}>}
 */
async function applyPeerRange(target) {
  const pkg = JSON.parse(await readFile(PKG_JSON, 'utf8'));
  const range = pkg.peerDependencies?.[PEER_NAME];
  if (peerCovers(range, target)) {return { changed: false, range };}

  const nextRange = range ? `${range} || >=${target}` : `>=${target}`;
  pkg.peerDependencies = { ...pkg.peerDependencies, [PEER_NAME]: nextRange };
  await writeFile(PKG_JSON, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  return { changed: true, range: nextRange };
}

// ---------------------------------------------------------------------------
// CHANGELOG
// ---------------------------------------------------------------------------

const CHANGELOG_HEADING = '### 兼容';

/** 往 `## [Unreleased]` 里插一条「已在 T 上验过」。幂等:同一条 bullet 只出现一次。
 * @param {string} target
 * @param {string | null | undefined} runUrl
 * @returns {Promise<{changed: boolean}>}
 */
async function applyChangelog(target, runUrl) {
  let text;
  try {
    text = await readFile(CHANGELOG, 'utf8');
  } catch {
    warn('没有 CHANGELOG.md,跳过');
    return { changed: false };
  }

  const where = runUrl ? `([run](${runUrl}))` : '';
  const bullet = `- 端到端部署测试已在 \`@deepseek-ai/dsh@${target}\` 上通过${where}。`;
  if (text.includes(bullet)) {return { changed: false };}

  const anchor = /^## \[Unreleased\]$/m.exec(text);
  if (!anchor) {
    warn('CHANGELOG.md 里找不到 `## [Unreleased]`,跳过');
    return { changed: false };
  }

  // [Unreleased] 这一段到哪里结束:下一个二级标题(或文件尾)。
  const afterAnchor = anchor.index + anchor[0].length;
  const nextH2 = text.slice(afterAnchor).search(/\n## /);
  const sectionEnd = nextH2 === -1 ? text.length : afterAnchor + nextH2 + 1;
  const section = text.slice(afterAnchor, sectionEnd);

  // 已有的 `### 兼容` 段就续在它末尾;没有就在段首新建一个。
  const headingAt = section.indexOf(CHANGELOG_HEADING);
  let out;
  if (headingAt !== -1) {
    const subStart = afterAnchor + headingAt + CHANGELOG_HEADING.length;
    const nextH3 = text.slice(subStart, sectionEnd).search(/\n### /);
    const subEnd = nextH3 === -1 ? sectionEnd : subStart + nextH3 + 1;
    const before = text.slice(0, subEnd).replace(/\s*$/, '');
    out = `${before}\n${bullet}\n\n${text.slice(subEnd)}`;
  } else {
    // 新建一段。尾部把原来紧跟在 `## [Unreleased]` 后的空行**收敛成一个**,
    // 否则会留下「bullet 与下一个 ### 之间空两行」这种噪音 diff。
    const tail = text.slice(afterAnchor).replace(/^\n+/, '\n');
    out = `${text.slice(0, afterAnchor)}\n\n${CHANGELOG_HEADING}\n\n${bullet}\n${tail}`;
  }

  await writeFile(CHANGELOG, out, 'utf8');
  return { changed: true };
}

// ---------------------------------------------------------------------------
// 检测
// ---------------------------------------------------------------------------

async function detect() {
  if (!Number.isFinite(SETTLE_MIN) || SETTLE_MIN < 0) {die(`--settle 不是分钟数:${flag('settle')}`);}

  const names = WATCH.map((n) => SCOPE + n);
  const packuments = new Map();
  await Promise.all(
    names.map(async (n) => {
      packuments.set(n, await packument(n));
    }),
  );

  const dsh = packuments.get(SCOPE + 'dsh');
  const target = dsh?.['dist-tags']?.[LANE];
  if (typeof target !== 'string' || target === '') {
    die(`@deepseek-ai/dsh 没有 dist-tag \`${LANE}\`(有的:${Object.keys(dsh?.['dist-tags'] ?? {}).join(', ')})`);
  }

  // 每个包在这个版本上的发布时刻;同时算出「整列出齐」的时间。
  const observed = [];
  let lastPublished = 0;
  let corePresent = 0;
  for (const short of WATCH) {
    const pack = packuments.get(SCOPE + short);
    const iso = pack?.time?.[target];
    const hasVersion = Boolean(pack?.versions?.[target]);
    if (hasVersion && iso) {lastPublished = Math.max(lastPublished, Date.parse(iso));}
    if (CORE.includes(short) && hasVersion) {corePresent++;}
    observed.push({
      name: SCOPE + short,
      core: CORE.includes(short),
      hasVersion,
      publishedAt: iso ?? null,
      // `latest` 顺手记下来:它是脏的这件事本身就是一条要盯着的事实。
      latest: pack?.['dist-tags']?.latest ?? null,
      laneTag: pack?.['dist-tags']?.[LANE] ?? null,
    });
  }

  const firstSeen = dsh?.time?.[target] ?? null;
  const settledAt = lastPublished ? new Date(lastPublished).toISOString() : null;
  const settleDone = lastPublished > 0 && Date.now() - lastPublished >= SETTLE_MIN * 60_000;

  const baseline = await readBaseline();
  const verified = baseline.verified?.version ?? null;
  const range = JSON.parse(await readFile(PKG_JSON, 'utf8')).peerDependencies?.[PEER_NAME] ?? null;

  let status;
  if (corePresent < CORE.length) {status = 'incomplete';}
  else if (!settleDone) {status = 'settling';}
  else if (verified === null) {status = 'unverified';}
  else if (verified === target) {status = 'same';}
  else if (compareVersions(target, verified) < 0) {status = 'rolled-back';}
  else {status = 'changed';}

  return {
    lane: LANE,
    target,
    status,
    // 只有 unverified / changed 是「该去跑 e2e」。
    shouldAct: status === 'changed' || status === 'unverified',
    verified,
    firstSeen,
    settledAt,
    settleMinutes: SETTLE_MIN,
    corePresent,
    coreTotal: CORE.length,
    packages: observed,
    peerRange: range,
    peerAlreadyCovers: peerCovers(range, target),
    baseline,
  };
}

// ---------------------------------------------------------------------------
// --render:把检测报告渲染成 PR / issue 的正文(workflow 里不写内联 JS)
// ---------------------------------------------------------------------------

/**
 * 用法:`--render --report=<report.json> --outcome=green|red [--run-url=<url>] [--log=<e2e.log>]`
 *
 * 把渲染放在脚本里而不是 workflow 的 `run: node -e "…"`:那段内联 JS 是**不可测**的,
 * 而 PR/issue 正文恰恰是唯一「给人看」的东西 —— 它错了没人会红。
 */
if (has('render')) {
  const reportPath = String(flag('report', ''));
  const outcome = String(flag('outcome', 'green'));
  const runUrl = RUN_URL ?? null;
  const logPath = flag('log', undefined);

  if (reportPath === '') {die('--render 必须给 --report=<检测报告的 JSON 路径>');}
  let rep;
  try {
    rep = JSON.parse(await readFile(reportPath, 'utf8'));
  } catch (err) {
    die(`报告读不懂(${reportPath}):${err.message}`);
  }

  let logTail = null;
  if (typeof logPath === 'string') {
    try {
      const text = await readFile(logPath, 'utf8');
      // 只留尾部:失败现场在最后 80 行里;整份日志走 Actions 的 artifact。
      logTail = text.split('\n').slice(-80).join('\n').trim();
    } catch {
      /* 日志没有就算了,正文不该因为一段可选内容而失败 */
    }
  }

  const L = [];
  const green = outcome !== 'red';
  L.push(`## 上游 deepseek-harness 有新版:\`@deepseek-ai/dsh@${rep.target}\``);
  L.push('');
  L.push(
    '本 PR/issue 由 [`.github/workflows/upstream-watch.yml`]('
    + 'https://github.com/' + (process.env.GITHUB_REPOSITORY ?? 'LinXueyuanStdio/dsh-git')
    + '/blob/main/.github/workflows/upstream-watch.yml) 自动产生。'
    + '它**只回答**一件事:这个插件在上游的新版本上还装得上、加载得起来、端到端还通吗。',
  );
  L.push('');
  L.push('| 项 | 值 |');
  L.push('|---|---|');
  L.push(`| 发布线 | \`${rep.lane}\` |`);
  L.push(`| 目标版本 | \`${rep.target}\` |`);
  L.push(`| 首次出现 | ${rep.firstSeen ?? '(未知)'} |`);
  L.push(`| 整列出齐 | ${rep.settledAt ?? '(未出齐)'}(窗口 ${rep.settleMinutes} 分钟) |`);
  L.push(`| 核心包 | ${rep.corePresent}/${rep.coreTotal} |`);
  L.push(`| 基线里上次验过的版本 | ${rep.verified ? `\`${rep.verified}\`` : '(无)'} |`);
  L.push(`| peer 范围是否已覆盖 | ${rep.peerAlreadyCovers ? '是(本 PR 不改 package.json)' : '**否** → 追加一条 `>=' + rep.target + '`'} |`);
  L.push(`| 端到端部署测试 | ${green ? '✅ 通过' : '❌ **失败**'}${runUrl ? ` — [run](${runUrl})` : ''} |`);
  L.push('');
  L.push('### 上游包清册');
  L.push('');
  L.push('| 包 | 门槛 | 该版本 | 发布时刻 | `latest` |');
  L.push('|---|---|---|---|---|');
  for (const p of rep.packages ?? []) {
    L.push(
      `| \`${p.name}\` | ${p.core ? '✔' : '—'} | ${p.hasVersion ? '✔' : '**缺**'} `
      + `| ${(p.publishedAt ?? '').slice(0, 16) || '—'} | \`${p.latest ?? '—'}\` |`,
    );
  }
  L.push('');
  L.push('> 上游子包的 `latest` 普遍停在很老的版本(实测 2026-10 时是 `0.0.1-rc.1`),'
    + '所以本监视只认 `dist-tags.next` / `alpha`,并把两个 bundle 按 `dsh --version` 锁死 —— '
    + '见 `scripts/e2e-deploy.mjs` 的头注释。');
  L.push('');

  if (green) {
    L.push('### 这次跑了什么');
    L.push('');
    L.push('与 `.github/workflows/ci.yml` 的 `plugin` + `e2e` job 同一套判据,只是把宿主换成**这个目标版本**:');
    L.push('');
    L.push('```');
    L.push('npm run build && npm run check && node scripts/verify-plugin.mjs   # 发布物本身');
    L.push('node scripts/e2e-deploy.mjs                                       # 干净 DSH_HOME + 真 Chrome + 真推 test 分支');
    L.push('```');
    L.push('');
    L.push('### 这个 PR 里有什么');
    L.push('');
    L.push('- `scripts/upstream-baseline.json` —— 记下「`' + rep.target + '` 已在哪个 run 上验过」;');
    L.push('- `CHANGELOG.md` —— `[Unreleased]` 追加一条;');
    L.push(
      rep.peerAlreadyCovers
        ? '- `package.json` —— **没动**。现有 peer 范围的第一条 `>=` 无上界,已经接受这个版本(范围读起来像一份「验过的线」清单,但语义上后几条是冗余的);要不要收紧成有上界的窗口是语义决定,不由机器人替你做。'
        : '- `package.json` —— peer 范围追加 `>=' + rep.target + '`。',
    );
    L.push('');
    L.push('⚠️ **它不做什么**:宿主接口改名/改签名时,真正要改的 `types/client-platform-shims.d.ts`'
      + '(文件头写着「签名要逐字对得上」)与各处调用点,是版本号**推导不出来**的。'
      + '那种情况这一轮会以 issue 的形式交出来,而不是硬凑一个「编译过、运行崩」的补丁。');
    L.push('');
    L.push('⚠️ **这张 PR 上的 `pull_request` CI 不会自己跑起来**:由 `GITHUB_TOKEN` 创建的 PR'
      + '所触发的事件会被 GitHub 有意拦掉(防递归)。判据不是没跑 —— 它**就是上面那个 run**,'
      + '跑在同一棵提交上,截图也在那个 run 的 artifact 里。合之前想要一个绿的勾,'
      + '往这条分支上推一个你自己的提交(空提交也行)即可 —— 事件是「你」触发的,CI 就会跑;'
      + '或者把 workflow 里的 `GH_TOKEN` 换成 PAT / GitHub App token。');
  } else {
    L.push('### 失败现场');
    L.push('');
    L.push('目标版本上**没有通过**端到端部署测试。判据本身没变(与 `ci.yml` 的 e2e job 同一条链),'
      + '变的只有宿主版本 —— 所以红的意思是「上游这一版和本插件的接缝对不上了」,而不是「本插件的代码坏了」。');
    L.push('');
    L.push('要查的东西,按命中率排序:');
    L.push('');
    L.push('1. `types/client-platform-shims.d.ts` 里手抄的宿主签名 vs `references/deepseek-harness/packages/client/ui-primitives/src/`;');
    L.push('2. 客户端注册用的 cordis 服务名(`sidebarRightTabs` / `slots` / `credentials` …)还在不在;');
    L.push('3. 宿主注入的 CSS 令牌(`--dsw-alias-*`)有没有被改名。');
    L.push('');
    if (logTail) {
      L.push('<details><summary>e2e 日志尾部(完整日志见 run 的 artifact)</summary>');
      L.push('');
      L.push('```');
      L.push(logTail);
      L.push('```');
      L.push('');
      L.push('</details>');
    }
  }
  L.push('');
  process.stdout.write(L.join('\n'));
  process.exit(0);
}

// ---------------------------------------------------------------------------
// --selftest:不联网的自检(判据逻辑本身)
// ---------------------------------------------------------------------------

/**
 * 为什么值得有这一段:本脚本的**全部**判断都压在 `compareVersions` 与 `peerCovers`
 * 上,而它们错了的表现是**安静**的 —— 版本比较错一位,结果是「每次都报告变了」或
 * 「永远报告没变」,两种都不会红。所以拿一组**表驱动**的断言把它们钉住,
 * workflow 在跑 e2e **之前**先跑这一段(不联网、毫秒级)。
 *
 * ⚠️ 这里钉的是**我们自己的**实现,不是 npm 的 semver。已知的**故意**差异:
 * `^` / `~` / `x` 范围一律判「不覆盖」(保守:多追加一条)。
 */
if (has('selftest')) {
  /** @type {string[]} */
  const failures = [];
  /**
   * @param {string} label
   * @param {any} got
   * @param {any} want
   * @returns {void}
   */
  const eq = (label, got, want) => {
    if (got !== want) {failures.push(`${label}:得到 ${JSON.stringify(got)},期望 ${JSON.stringify(want)}`);}
  };

  eq('parse 正式版', JSON.stringify(parseVersion('1.2.3')), JSON.stringify({ major: 1, minor: 2, patch: 3, pre: null }));
  eq('parse 预发布', JSON.stringify(parseVersion('0.2.0-rc.2').pre), JSON.stringify(['rc', '2']));
  for (const bad of ['1.2', 'v1.2.3', 'latest', '', '1.2.3.4']) {
    let threw = false;
    try {
      parseVersion(bad);
    } catch {
      threw = true;
    }
    eq(`parse 拒绝 ${JSON.stringify(bad)}`, threw, true);
  }

  /** @type {Array<[string, string, -1 | 0 | 1]>} */
  const cmpCases = [
    ['0.2.0-rc.2', '0.2.0-rc.2', 0],
    ['0.2.0-rc.1', '0.2.0-rc.2', -1],
    ['0.2.0-rc.10', '0.2.0-rc.9', 1],   // 数值段按数值比,不是字符串
    ['0.2.0', '0.2.0-rc.9', 1],          // 正式版 > 预发布
    ['0.2.1-alpha.1', '0.2.0-rc.2', 1],
    ['0.1.7-rc.2', '0.1.7-rc.1', 1],
    ['0.1.5-alpha.1', '0.1.5-rc.1', -1], // alpha < rc(同为字符串段,字典序)
    ['1.0.0', '0.99.99', 1],
  ];
  for (const [a, b, want] of cmpCases) {
    eq(`compare(${a}, ${b})`, compareVersions(a, b), want);
    eq(`compare(${b}, ${a}) 反向`, compareVersions(b, a), -want);
  }

  // 本仓库**真实**的那条 peer 范围(见 package.json)—— 它必须是「已覆盖」的。
  const REAL = '>=0.2.0-rc.2 || >=0.3.0-rc.1 || >=0.4.0-rc.1 || >=0.5.0-rc.1';
  /** @type {Array<[string, string, boolean]>} */
  const coverCases = [
    [REAL, '0.2.0-rc.2', true],
    [REAL, '0.2.1-alpha.1', true],
    [REAL, '0.5.0-rc.1', true],
    ['>=0.2.0-rc.2', '0.1.9', false],
    ['<0.3.0', '0.2.0-rc.2', true],
    ['<0.3.0', '0.3.0', false],
    ['>=0.3.0-rc.1 <0.4.0', '0.3.5', true],
    ['>=0.3.0-rc.1 <0.4.0', '0.4.0', false],
    ['^0.2.0', '0.2.0-rc.2', false], // 读不懂 ⇒ 保守判「不覆盖」
    ['~3.18.4', '3.18.4', false],
    ['', '0.2.0-rc.2', false],
    ['>=0.2.0-rc.2', 'not-a-version', false],
  ];
  for (const [range, v, want] of coverCases) {
    eq(`peerCovers(${JSON.stringify(range)}, ${v})`, peerCovers(range, v), want);
  }

  if (failures.length) {
    for (const f of failures) {process.stderr.write(`✗ ${f}\n`);}
    process.stderr.write(`\n✗ 自检失败:${failures.length} 条\n`);
    process.exit(1);
  }
  process.stdout.write(`✓ 自检通过(${cmpCases.length * 2 + coverCases.length + 7} 条断言)\n`);
  process.exit(0);
}

const report = await detect();

const { status, target } = report;

// ---- 写入模式 -------------------------------------------------------------

if (APPLY || RECORD_RED) {
  if (typeof TARGET_ARG !== 'string' || TARGET_ARG === '') {
    die(`--apply / --record-red 必须给 --target=<版本>(本次检测到的是 ${target})`);
  }
  let parsed;
  try {
    parsed = parseVersion(TARGET_ARG);
  } catch (err) {
    die(err.message);
  }
  // 传进来的 target 必须和本次检测的 lane 一致 —— 否则就是 workflow 把两个来源搞混了,
  // 那样写出来的基线会记着一个**没人验过**的版本。
  if (parsed && TARGET_ARG !== target) {
    warn(`--target=${TARGET_ARG} 与 lane \`${LANE}\` 上的 ${target} 不一致;仍按你给的版本记账。`);
  }

  const baseline = await readBaseline();
  const entry = { version: TARGET_ARG, at: new Date().toISOString(), runUrl: RUN_URL ?? null };
  const history = [...(baseline.history ?? []), { ...entry, outcome: RECORD_RED ? 'red' : 'green' }]
    // 只留最近 20 条:这是一份**状态**文件,不是审计日志(Actions 的运行记录才是日志)。
    .slice(-20);

  let peer = { changed: false, range: report.peerRange };
  let changelog = { changed: false };

  if (RECORD_RED) {
    await writeBaseline({ ...baseline, lane: LANE, lastFailure: entry, history });
  } else {
    peer = await applyPeerRange(TARGET_ARG);
    changelog = await applyChangelog(TARGET_ARG, RUN_URL);
    await writeBaseline({
      ...baseline,
      lane: LANE,
      verified: entry,
      // 同一个版本由红转绿时,把那条失败记录清掉 —— 它已经不成立了。
      lastFailure: baseline.lastFailure?.version === TARGET_ARG ? null : (baseline.lastFailure ?? null),
      history,
    });
  }

  const out = {
    ok: true,
    action: RECORD_RED ? 'record-red' : 'apply',
    target: TARGET_ARG,
    peerRangeChanged: peer.changed,
    peerRange: peer.range,
    changelogChanged: changelog.changed,
  };
  if (JSON_OUT) {process.stdout.write(JSON.stringify(out, null, 2) + '\n');}
  else if (RECORD_RED) {
    process.stdout.write(`✓ 已记下失败:${TARGET_ARG}(package.json / CHANGELOG 按设计未动)\n`);
  } else {
    process.stdout.write(
      `✓ apply ${TARGET_ARG}\n`
      + `  peer 范围:${peer.changed ? `已追加 → ${peer.range}` : '本来已覆盖,未改动'}\n`
      + `  CHANGELOG:${changelog.changed ? '已追加 [Unreleased] 条目' : '无需改动'}\n`,
    );
  }
  process.exit(0);
}

// ---- 只读模式 -------------------------------------------------------------

if (JSON_OUT) {process.stdout.write(JSON.stringify(report, null, 2) + '\n');}
else {
  const lines = [];
  lines.push(`上游发布线 ${LANE} → ${target}`);
  lines.push(
    `  核心 ${report.corePresent}/${report.coreTotal} 包已有该版本`
    + `;整列出齐于 ${report.settledAt ?? '(未出齐)'}`
    + `(等待窗口 ${SETTLE_MIN} 分钟)`,
  );
  lines.push(`  基线里验过的版本:${report.verified ?? '(无)'}`);
  lines.push(`  peer 范围${report.peerAlreadyCovers ? '已' : '未'}覆盖 ${target}`);
  for (const p of report.packages) {
    lines.push(
      `    ${p.core ? '•' : '○'} ${p.name.padEnd(46)}`
      + `${p.hasVersion ? (p.publishedAt ?? '').slice(0, 16) : '（该版本缺失）'}`
      + `${p.latest !== p.laneTag ? `   latest=${p.latest}(脏)` : ''}`,
    );
  }
  lines.push('');
  lines.push(`结论:${status}`);
  if (status === 'changed' || status === 'unverified') {
    lines.push('  ⇒ 需要动作:在 ' + target + ' 上跑一次端到端部署测试。');
  } else if (status === 'same') {
    lines.push('  ⇒ 无需动作:当前线上版本就是验过的那个。');
  } else if (status === 'incomplete') {
    lines.push('  ⇒ 暂不动作:整列还没出齐,现在验的是上游的发布时序,不是本插件。');
  } else if (status === 'settling') {
    lines.push(`  ⇒ 暂不动作:出齐还不到 ${SETTLE_MIN} 分钟,等下一次。`);
  } else if (status === 'rolled-back') {
    lines.push(`  ⇒ 暂不动作:${target} 比基线里的 ${report.verified} 还旧(tag 被回滚了?),交给人看。`);
  }
  process.stdout.write(lines.join('\n') + '\n');
}

// 退出码见文件头。10 只有「该动作」才给,workflow 靠它分流。
if (status === 'same') {process.exit(0);}
if (report.shouldAct) {process.exit(10);}
process.exit(1);
