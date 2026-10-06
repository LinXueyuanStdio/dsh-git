/**
 * 端到端探针:**真 HTTP + 真 host 路由 + 真 client store**。
 *
 * 目的是把「设置里选的模型到底有没有生效」这条链一次走完,而不是靠读代码:
 *   1. `GitStore`(src/client/store.ts)—— 真的客户端状态机;
 *   2. `api.ts` —— 真的客户端传输层(只把相对 BASE 换成探针的绝对前缀);
 *   3. `createGitHandler`(src/host/routes.ts)—— 真的路由;
 *   4. `RepoRegistry`(src/host/repo-registry.ts)—— 真的持久化层,
 *      挂真 `JsonStorageBackend` 写临时目录。
 *
 * 「刷新页面」= 丢掉 store,用同一个 localStorage 与同一个 host 进程重建一个。
 * 「重启 app」= 关掉 storage unit,重新 open(host 侧状态由磁盘重建)。
 *
 * 用法:`node scripts/probe-prefs-roundtrip.mjs`
 * @module dsh-git/scripts/probe-prefs-roundtrip
 */

import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const REPO = new URL('..', import.meta.url);
const DSH = '/Applications/DSH Desktop.app/Contents/Resources/app/node_modules/@deepseek-ai';

const failures = [];
/** 断言并记账。 */
function check(label, ok, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  if (!ok) failures.push(label);
}

const work = await mkdtemp(join(tmpdir(), 'dsh-git-prefs-'));
const storePath = join(work, 'store.mjs');
const diffModePath = join(work, 'diff-mode.mjs');

/** 等到条件成立(默认 3s),用于等 fire-and-forget 的写入到达 host。 */
async function until(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate()) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  return predicate();
}

// ---------- 1. 打包真 client store(只改 BASE 为探针前缀) ----------

/** esbuild 插件:把 api.ts 的相对 BASE 常量换成探针前缀。 */
const basePlugin = {
  name: 'probe-base',
  setup(b) {
    b.onLoad({ filter: /client[\\/]api\.ts$/ }, async (args) => {
      const text = await readFile(args.path, 'utf8');
      const replaced = text.replace(
        /const BASE = 'dsh-git';/,
        "const BASE = globalThis.__PROBE_BASE__;",
      );
      if (replaced === text) throw new Error('探针:api.ts 里没找到 `const BASE = \'dsh-git\';` —— 上游改名了,探针已失效。');
      return { contents: replaced, loader: 'ts' };
    });
  },
};

await build({
  entryPoints: [
    new URL('src/client/store.ts', REPO).pathname,
    new URL('src/client/diff-mode.ts', REPO).pathname,
  ],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  outdir: work,
  outExtension: { '.js': '.mjs' },
  plugins: [basePlugin],
  alias: {
    path: new URL('src/client/shim-node-path.ts', REPO).pathname,
    url: new URL('src/client/shim-node-url.ts', REPO).pathname,
    'fs/promises': new URL('src/client/shim-node-fs-promises.ts', REPO).pathname,
    os: new URL('src/client/shim-node-os.ts', REPO).pathname,
  },
  inject: [new URL('src/client/desktop-globals.ts', REPO).pathname],
  external: ['react', 'react-dom', 'react/jsx-runtime', '@deepseek-ai/*'],
  logLevel: 'warning',
});

// ---------- 2. 打包真 host 路由 ----------

const routesPath = join(work, 'routes.mjs');
await build({
  entryPoints: [new URL('src/host/routes.ts', REPO).pathname],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  outfile: routesPath,
  logLevel: 'warning',
  external: ['@deepseek-ai/*'],
});

// ---------- 3. 浏览器环境替身 ----------

/** 内存 localStorage(按 key 存字符串)。 */
const ls = new Map();
const localStorageMock = {
  getItem: (k) => (ls.has(k) ? ls.get(k) : null),
  setItem: (k, v) => { ls.set(k, String(v)); },
  removeItem: (k) => { ls.delete(k); },
  clear: () => ls.clear(),
  key: (i) => [...ls.keys()][i] ?? null,
  get length() { return ls.size; },
};
globalThis.localStorage = localStorageMock;
globalThis.window = globalThis;
globalThis.document = { title: '', hasFocus: () => true };
// Node 25 的 navigator 是只读 getter;有就用它,没有才定义。
if (globalThis.navigator === undefined) {
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'probe' }, configurable: true });
}

// ---------- 4. 真 host:registry + 真后端 + 真路由 + 真 HTTP ----------

const { RepoRegistry } = await import(new URL('src/host/repo-registry.ts', REPO).href);
const { createGitHandler } = await import(pathToFileURL(routesPath).href);
const { defineDomain, descriptorOf } = await import(pathToFileURL(join(DSH, 'dsh-storage-domain/lib/index.js')).href);
const { JsonStorageBackend } = await import(pathToFileURL(join(DSH, 'dsh-storage-json/lib/index.js')).href);
const { z } = await import('zod');

/** storage root(临时);「重启」= 换一个 backend 重新 open 同一个目录。 */
const storageRoot = join(work, 'storages');
/** 与 src/index.ts 的 DOMAIN_SPEC 同构(只取 schema 校验)。 */
const spec = defineDomain({
  name: 'dsh_git',
  version: 1,
  tables: {},
  global: {
    schema: z.object({
      version: z.literal(1).default(1),
      entries: z.array(z.object({
        path: z.string().min(1), name: z.string().min(1), alias: z.string().optional(),
        remote: z.string().nullable(), addedAt: z.number(),
        missing: z.boolean().optional(), branch: z.string().optional(),
      })).default([]),
      hiddenRemotes: z.array(z.string()).default([]),
      githubToken: z.string().default(''),
      deviceId: z.string().default(''),
      prefs: z.object({
        model: z.string().optional(), stagedOnly: z.boolean().optional(), systemPrompt: z.string().optional(),
      }).default({}),
      remoteCache: z.object({
        fetchedAt: z.number(),
        repos: z.array(z.object({
          fullName: z.string(), isPrivate: z.boolean(), pushedAt: z.string(), description: z.string().optional(),
        })),
      }).nullable().default(null),
      lastFetchedAt: z.record(z.string(), z.string()).default({}),
      lastSelected: z.string().default(''),
    }).default({}),
  },
});

/** 打开存储并造一个挂好 domain 的 registry(等价于 index.ts apply 里的那段)。 */
async function bootRegistry() {
  const backend = new JsonStorageBackend(storageRoot);
  const unit = await backend.kv.open(descriptorOf(spec));
  await unit.loadAll();
  const domain = {
    global: {
      get: () => {
        const raw = unit.state.global;
        if (raw === undefined || raw === null) return undefined;
        return spec.global.schema.parse(raw);
      },
      set: (value) => unit.setGlobal(spec.global.schema.parse(value)),
    },
  };
  const registry = new RepoRegistry(domain);
  await registry.whenReady();
  return { registry, unit, backend };
}

/** 假的 git 服务:本探针只走 prefs/models/health/repos,不碰 git。 */
const gitStub = new Proxy({}, { get: () => async () => { throw new Error('探针未实现 git 操作'); } });

/** 可直接改的可选模型清单(替身 ctx.llm)。 */
const available = [
  { provider: 'provA', providerName: 'A', id: 'model-a', name: 'Model A' },
  { provider: 'provB', providerName: 'B', id: 'model-b', name: 'Model B' },
];

let boot = await bootRegistry();

/** 重建路由与 HTTP server(重启 app 时用)。 */
async function makeServer() {
  const llm = {
    listModels: async () => available,
    generate: async () => { throw new Error('探针未实现生成'); },
  };
  const handler = createGitHandler({
    git: gitStub,
    registry: boot.registry,
    llm,
    auth: { state: () => ({}), credentialEnv: () => undefined },
    buildStamp: 'probe',
  });
  const server = createServer((req, res) => handler(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return { server, port };
}

let { server, port } = await makeServer();
globalThis.__PROBE_BASE__ = `http://127.0.0.1:${port}/dsh-git`;
console.log(`探针 host: ${globalThis.__PROBE_BASE__}`);

// ---------- 5. 加载/重载真 client store ----------

let loadSeq = 0;
/**
 * 「刷新页面」:重新 import 打包产物(每次带唯一查询串,绕过 ESM 缓存),
 * 同一个 localStorage、同一个 host 进程。`start()` 走真调用链:
 * waitForRoutes → repos → loadModels / loadAuth。
 */
async function newStore(sessionId = 's1') {
  loadSeq += 1;
  const mod = await import(`${pathToFileURL(storePath).href}?n=${loadSeq}`);
  const store = new mod.GitStore(sessionId);
  await store.start();
  // loadModels() 是 `void this.loadModels()`(不 await),等它真的回来。
  await until(() => store.snapshot().models.length > 0 || !store.snapshot().ready, 3000);
  return store;
}

// ---------- 6. 场景 ----------

console.log('\n1) 冷启动:没有任何持久化偏好,client 与 host 的初值');
let store = await newStore();
check('模型清单拿到了', store.snapshot().models.length === 2, JSON.stringify(store.snapshot().models.map((m) => `${m.provider}/${m.id}`)));
check('无偏好时 client 落到 models[0]', store.snapshot().model === 'provA/model-a', `"${store.snapshot().model}"`);
check('host prefModel() 为空', boot.registry.prefModel() === '', `"${boot.registry.prefModel()}"`);

console.log('\n2) 在设置里选 provB/model-b(store.setModelPersisted)');
store.setModelPersisted('provB/model-b');
check('client 立刻切到所选模型', store.snapshot().model === 'provB/model-b', store.snapshot().model);
// setModelPersisted 是 fire-and-forget(`void api.setPrefs`),等它到达 host。
const wrote = await until(() => boot.registry.prefModel() === 'provB/model-b');
check('host 端 prefModel() 记下了 provB/model-b', wrote, `"${boot.registry.prefModel()}"`);
const healthNow = await (await fetch(`${globalThis.__PROBE_BASE__}/health`, { method: 'POST', body: '{}' })).json();
check('health.persistent 为 true', healthNow.value.persistent === true, JSON.stringify(healthNow.value));

console.log('\n3) 模型落盘内容(dsh_git.json 里的 prefs)');
{
  const disk = JSON.parse(await readFile(join(storageRoot, 'dsh_git.json'), 'utf8'));
  check('磁盘 prefs.model = provB/model-b', disk.global.prefs.model === 'provB/model-b', JSON.stringify(disk.global.prefs));
}

console.log('\n4) 「刷新页面」(新 store,同一 host):模型下拉显示什么?');
store = await newStore();
const shown = store.snapshot().model;
check('刷新后 client 显示的就是 host 钉住的模型(期望 provB/model-b)', shown === 'provB/model-b', `实际显示 ${shown === '' ? '(空)' : shown}`);
check('刷新后显示的不是 models[0]', shown !== 'provA/model-a', `models[0] = provA/model-a,实际显示 ${shown === '' ? '(空)' : shown}`);

console.log('\n5) 「重启 app」(重开 storage unit + 新 HTTP server + 新 store)');
await server.close();
await boot.unit.close();
await boot.backend.close();
boot = await bootRegistry();
({ server, port } = await makeServer());
globalThis.__PROBE_BASE__ = `http://127.0.0.1:${port}/dsh-git`;
check('重启后 host prefModel() 仍是 provB/model-b', boot.registry.prefModel() === 'provB/model-b', `"${boot.registry.prefModel()}"`);
store = await newStore();
check('重启后 client 显示钉住的模型', store.snapshot().model === 'provB/model-b', `"${store.snapshot().model}"`);

console.log('\n6) stagedOnly:设置里改一下,刷新后与重启后各是什么?');
store.setStagedOnlyPersisted(false);
check('client 立刻是 false', store.snapshot().stagedOnly === false, String(store.snapshot().stagedOnly));
check('host prefStagedOnly() 记下了 false', await until(() => boot.registry.prefStagedOnly() === false), String(boot.registry.prefStagedOnly()));
store = await newStore();
check('刷新后 client stagedOnly 与 host 一致(期望 false)', store.snapshot().stagedOnly === false, `client=${store.snapshot().stagedOnly} host=${boot.registry.prefStagedOnly()}`);

console.log('\n7) 「重启 app」后 client 的 stagedOnly');
await server.close();
await boot.unit.close();
await boot.backend.close();
boot = await bootRegistry();
({ server, port } = await makeServer());
globalThis.__PROBE_BASE__ = `http://127.0.0.1:${port}/dsh-git`;
store = await newStore();
check('重启后 client stagedOnly 与 host 一致(期望 false)', store.snapshot().stagedOnly === false, `client=${store.snapshot().stagedOnly} host=${boot.registry.prefStagedOnly()}`);

console.log('\n8) localStorage 键:写入后「刷新页面」是否读回');
const diffMode = await import(`${pathToFileURL(diffModePath).href}?n=dm`);
check('diff-mode 导出 setShowSideBySideDiff', typeof diffMode.setShowSideBySideDiff === 'function');
check('diff-mode 导出 setHideWhitespaceInChangesDiff', typeof diffMode.setHideWhitespaceInChangesDiff === 'function');
check('diff-mode 导出 setImageDiffType', typeof diffMode.setImageDiffType === 'function');
diffMode.setShowSideBySideDiff(true);
diffMode.setHideWhitespaceInChangesDiff(true);
check('写入了 show-side-by-side-diff', ls.get('show-side-by-side-diff') === 'true', JSON.stringify([...ls.entries()]));
{
  // 「刷新」后 diff-mode 的读取函数在新模块实例里读同一份 localStorage。
  const dm2 = await import(`${pathToFileURL(diffModePath).href}?n=dm2`);
  check('刷新后 getShowSideBySideDiff() 读回 true', dm2.getShowSideBySideDiff() === true, String(dm2.getShowSideBySideDiff()));
  check('刷新后 getHideWhitespaceInChangesDiff() 读回 true', dm2.getHideWhitespaceInChangesDiff() === true, String(dm2.getHideWhitespaceInChangesDiff()));
  check('新 store 的初始 sideBySide 用上了它', (await newStore()).snapshot().sideBySide === true, String((await newStore()).snapshot().sideBySide));
  // image-diff-type 是数字枚举(JSON 序列化)走的另一条读写函数。
  diffMode.setImageDiffType(2);
  check('image-diff-type 落成 JSON 数字', ls.get('image-diff-type') === '2', JSON.stringify(ls.get('image-diff-type')));
  check('刷新后 getImageDiffType() 读回 2', dm2.getImageDiffType() === 2, String(dm2.getImageDiffType()));
  check('hide-whitespace-in-diff(History 那个独立开关)也读得回', dm2.getHideWhitespaceInHistoryDiff() === false, String(dm2.getHideWhitespaceInHistoryDiff()));
}

console.log('\n8b) pin 的模型从清单里消失时,client 必须退回 models[0](而不是停在死值)');
{
  store.setModelPersisted('provB/model-b');
  await until(() => boot.registry.prefModel() === 'provB/model-b');
  // 让 host 的模型清单里不再有 provB/model-b,再「刷新页面」。
  available.length = 0;
  available.push({ provider: 'provA', providerName: 'A', id: 'model-a', name: 'Model A' });
  store = await newStore();
  check('pin 失效 → 退回 models[0]', store.snapshot().model === 'provA/model-a', `"${store.snapshot().model}"`);
  // 复原清单,免得影响后面的场景
  available.push({ provider: 'provB', providerName: 'B', id: 'model-b', name: 'Model B' });
}

console.log('\n9) 宽度键(history/changes 两个)是否「写而必读」');
{
  const hv = await readFile(new URL('src/client/history-view.tsx', REPO), 'utf8');
  const cv = await readFile(new URL('src/client/changes-view.tsx', REPO), 'utf8');
  // useSplitWidth 是读路径;两个常量各自要有一个 useSplitWidth 调用点。
  check('sidebar-width 有读取点(changes-view 的 useSplitWidth)', /useSplitWidth\(SIDEBAR_WIDTH_STORAGE_KEY\)/.test(cv));
  check('commit-summary-width 有读取点(history-view 的 useSplitWidth)', /useSplitWidth\(COMMIT_SUMMARY_WIDTH_STORAGE_KEY\)/.test(hv));
  check('useSplitWidth 内部真的读 localStorage', /window\.localStorage\.getItem\(key\)/.test(hv));
}

console.log('\n10) localStorage 键的「读 / 写配对」静态枚举');
{
  // 逐个 .ts/.tsx 抓 getItem / setItem 的**字面量**键(变量键由上面各场景覆盖)。
  const files = ['diff-mode.ts', 'history-view.tsx', 'repo-bar.tsx', 'pulls-view.tsx', 'store.ts', 'workbench.tsx', 'settings.tsx', 'changes-view.tsx', 'index.ts'];
  const readers = new Map();
  const writers = new Map();
  for (const name of files) {
    let text;
    try {
      text = await readFile(new URL(`src/client/${name}`, REPO), 'utf8');
    } catch { continue; }
    for (const m of text.matchAll(/localStorage\.getItem\(\s*['"]([^'"]+)['"]/g)) {
      readers.set(m[1], `${name}:${text.slice(0, m.index).split('\n').length}`);
    }
    for (const m of text.matchAll(/localStorage\.setItem\(\s*['"]([^'"]+)['"]/g)) {
      writers.set(m[1], `${name}:${text.slice(0, m.index).split('\n').length}`);
    }
  }
  // 常量形式的键(diff-mode 三个 + 两个宽度 + recent)也要算进来。
  const constText = (await readFile(new URL('src/client/diff-mode.ts', REPO), 'utf8'))
    + (await readFile(new URL('src/client/history-view.tsx', REPO), 'utf8'))
    + (await readFile(new URL('src/client/repo-bar.tsx', REPO), 'utf8'));
  const named = [...constText.matchAll(/const (?:KEY_)?[A-Z_]*(?:KEY|TYPE)\w* = '([^']+)'/g)].map((m) => m[1]);
  console.log(`  字面量读点: ${[...readers.keys()].join(', ') || '(无)'}`);
  console.log(`  字面量写点: ${[...writers.keys()].join(', ') || '(无)'}`);
  console.log(`  常量键:     ${named.join(', ')}`);
  // 常量键由 diff-mode / history-view / repo-bar 的读写函数成对使用,上面 8/9 已实测。
  check('gw.autoSec 是**只读无写**的孤儿(readers 有、writers 无)', readers.has('gw.autoSec') && !writers.has('gw.autoSec'), `readers=${JSON.stringify([...readers])} writers=${JSON.stringify([...writers])}`);
  check('dsh-git:recent-repositories 出现在常量键里(repo-bar 的读写都用它)', named.includes('dsh-git:recent-repositories'), named.join(', '));
}

console.log('\n11) 写盘失败时界面看到什么:真路由 + 真 HTTP 的 health 回什么');
{
  // 造一个「打开成功但 set() 抛错」的 registry(模拟磁盘满 / 权限变化),
  // 走真 createGitHandler + 真 HTTP,看 health 的载荷。
  const failing = new RepoRegistry({
    global: {
      get: () => undefined,
      set: async () => { throw new Error('ENOSPC: no space left on device, write'); },
    },
  });
  await failing.whenReady();
  const failingHandler = createGitHandler({
    git: gitStub,
    registry: failing,
    llm: { listModels: async () => available, generate: async () => { throw new Error('未实现'); } },
    auth: { state: () => ({}), credentialEnv: () => undefined },
    buildStamp: 'probe',
  });
  const failingServer = createServer((req, res) => failingHandler(req, res));
  await new Promise((resolve) => failingServer.listen(0, '127.0.0.1', resolve));
  const failingPort = failingServer.address().port;
  const post = async (route, body) => (await fetch(`http://127.0.0.1:${failingPort}/dsh-git/${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })).json();

  check('写失败之前 health.persistent 是 true(还没写过盘)',
    (await post('health', {})).value.persistent === true);
  check('写失败之前 health.storageError 是 null', (await post('health', {})).value.storageError === null);

  // 触发一次真正落盘的写(set 抛错)。
  await post('prefs/set', { model: 'p/a' });
  const failedHealth = (await post('health', {})).value;
  check('写失败之后 health.persistent 变成 false', failedHealth.persistent === false, JSON.stringify(failedHealth));
  check('health.storageError 带上「写入失败」与原因',
    /写入失败/.test(failedHealth.storageError ?? '') && /ENOSPC/.test(failedHealth.storageError ?? ''),
    JSON.stringify(failedHealth.storageError));

  // 修好之后(下一次写入成功)必须**清回**持久化 —— 否则一次瞬时失败会永久钉死界面。
  failing.constructor; // no-op,保持可读性
  await failing.setPrefs({ model: 'p/b' }).catch(() => {}); // 仍然失败
  check('仍然失败时保持 false', (await post('health', {})).value.persistent === false);
  // 把 domain 换成一个能成功的。
  await failing.useDomain({ global: { get: () => undefined, set: async () => undefined } });
  await failing.setPrefs({ model: 'p/c' });
  const recovered = (await post('health', {})).value;
  check('一次成功写入之后 health 清回持久化', recovered.persistent === true && recovered.storageError === null, JSON.stringify(recovered));

  await failingServer.close();
}

console.log('\n11b) 落盘失败时界面必须**回滚**并报错(不能乐观更新掩盖写入失败)');
{
  const bad = new RepoRegistry({
    global: { get: () => undefined, set: async () => { throw new Error('EACCES: permission denied'); } },
  });
  await bad.whenReady();
  const h3 = createGitHandler({
    git: gitStub, registry: bad,
    llm: { listModels: async () => available, generate: async () => { throw new Error('未实现'); } },
    auth: { state: () => ({}), credentialEnv: () => undefined }, buildStamp: 'probe',
  });
  const s3 = createServer((req, res) => h3(req, res));
  await new Promise((resolve) => s3.listen(0, '127.0.0.1', resolve));
  globalThis.__PROBE_BASE__ = `http://127.0.0.1:${s3.address().port}/dsh-git`;
  const mod3 = await import(`${pathToFileURL(storePath).href}?n=rollback`);
  const st = new mod3.GitStore('rollback');
  st.setModel('provA/model-a');
  st.setStagedOnly(true);
  // 先直接打一次路由:host 必须在**写盘失败**时回 ok:false(而不是 ok:true)。
  const direct = await (await fetch(`${globalThis.__PROBE_BASE__}/prefs/set`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'x/y' }),
  })).json();
  check('host 在写盘失败时回 ok:false(不再谎报成功)', direct.ok === false, JSON.stringify(direct));
  check('错误里说明「没有写入磁盘」', /没有写入磁盘/.test(direct?.error?.message ?? ''), JSON.stringify(direct?.error?.message));
  const okModel = await st.setModelPersisted('provB/model-b');
  check('写失败时 setModelPersisted 返回 false', okModel === false, String(okModel));
  check('模型**回滚**到旧值(不是停在没存住的新值)', st.snapshot().model === 'provA/model-a', st.snapshot().model);
  check('弹了错误提示', st.snapshot().toasts.length > 0, JSON.stringify(st.snapshot().toasts.map((t) => t.message)));
  const okStaged = await st.setStagedOnlyPersisted(false);
  check('写失败时 setStagedOnlyPersisted 返回 false', okStaged === false, String(okStaged));
  check('勾选状态**回滚**到旧值', st.snapshot().stagedOnly === true, String(st.snapshot().stagedOnly));
  await s3.close();
  globalThis.__PROBE_BASE__ = `http://127.0.0.1:${port}/dsh-git`;
}

console.log('\n12) prefs/get 的载荷:逐字段回显,未设置的键不出现,stagedOnly=false 能区分出来');
{
  const reg2 = new RepoRegistry({ global: { get: () => undefined, set: async () => undefined } });
  await reg2.whenReady();
  const h2 = createGitHandler({
    git: gitStub, registry: reg2,
    llm: { listModels: async () => available, generate: async () => { throw new Error('未实现'); } },
    auth: { state: () => ({}), credentialEnv: () => undefined }, buildStamp: 'probe',
  });
  const s2 = createServer((req, res) => h2(req, res));
  await new Promise((resolve) => s2.listen(0, '127.0.0.1', resolve));
  const p2 = s2.address().port;
  const post2 = async (route, body) => (await fetch(`http://127.0.0.1:${p2}/dsh-git/${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })).json();

  const empty = await post2('prefs/get', {});
  check('从未设置过 ⇒ 载荷是空对象(不是三个 undefined)', JSON.stringify(empty.value) === '{}', JSON.stringify(empty.value));

  await post2('prefs/set', { model: 'provB/model-b', stagedOnly: false, systemPrompt: 'SYS' });
  const full = await post2('prefs/get', {});
  check('model 被回显', full.value.model === 'provB/model-b', JSON.stringify(full.value));
  check('stagedOnly=false 被区分出来(不是被折成 true)', full.value.stagedOnly === false, JSON.stringify(full.value));
  check('systemPrompt 被回显', full.value.systemPrompt === 'SYS', JSON.stringify(full.value));
  check('原始存储里的 stagedOnly 确实是 false', reg2.prefStagedOnlyRaw() === false, String(reg2.prefStagedOnlyRaw()));
  check('prefStagedOnly() 仍是给 host 用的默认值判定', reg2.prefStagedOnly() === false, String(reg2.prefStagedOnly()));

  await s2.close();
}

// ---------- 清理 ----------

await server.close();
await boot.unit.close();
await boot.backend.close();
await rm(work, { recursive: true, force: true });

console.log('');
if (failures.length === 0) {
  console.log('偏好往返探针:全部通过。');
  process.exit(0);
}
console.log(`偏好往返探针:${failures.length} 项失败:`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(1);
