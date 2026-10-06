/**
 * 「生成依据」端到端探针:真 git 仓库 + 真 GitService + 真路由 + 真 client store。
 *
 * 钉住的是 `stagedOnly` 换语义之后那条链:
 *   勾选「只依据纳入提交的变更生成」⇒ 送进模型的 diff **只含纳入的文件**;
 *   取消勾选 ⇒ 含工作区**全部**未提交改动;
 *   一个文件都没纳入 ⇒ **响亮报错**,绝不静默生成一条空泛信息。
 *
 * 为什么要真 git:旧实现按 `file.staged`(git 索引位)过滤,而我们的勾选
 * **不写索引** ⇒ 旧判据恒筛出 0 个文件。这个缺陷只有跑真 git 才能证伪。
 *
 * 用法:`node scripts/probe-generate-scope.mjs`
 * @module dsh-git/scripts/probe-generate-scope
 */

import { mkdtemp, rm, writeFile, readFile, mkdir, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';

const run = promisify(execFile);
const REPO = new URL('..', import.meta.url);

const failures = [];
/** 断言并记账。 */
function check(label, ok, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  if (!ok) failures.push(label);
}

const work = await mkdtemp(join(tmpdir(), 'dsh-git-scope-'));
// 浏览器半的替身:store.ts → diff-mode.ts 在模块初始化时就读 localStorage。
const ls = new Map();
globalThis.localStorage = {
  getItem: (k) => (ls.has(k) ? ls.get(k) : null),
  setItem: (k, v) => { ls.set(k, String(v)); },
  removeItem: (k) => { ls.delete(k); },
  clear: () => ls.clear(),
  key: (i) => [...ls.keys()][i] ?? null,
  get length() { return ls.size; },
};
globalThis.window = globalThis;
globalThis.document = { title: '', hasFocus: () => true };
await mkdir(join(work, 'repo'), { recursive: true });
// macOS 上 /var 是 /private/var 的符号链接,而 `git rev-parse --show-toplevel`
// 回的是**规范路径**。GitService 的门是 `allowedRoots().includes(root)`
// (`git-service.ts:122`),所以清单里必须存规范路径,否则会误报「不是 git 仓库」。
const repo = await realpath(join(work, 'repo'));

/** 在临时仓库里跑 git。 */
const git = (...args) => run('git', args, { cwd: repo });

await git('init', '-q', '-b', 'main');
await git('config', 'user.email', 'probe@example.com');
await git('config', 'user.name', 'Probe');
await writeFile(join(repo, 'a.txt'), 'a1\na2\na3\n');
await writeFile(join(repo, 'b.txt'), 'b1\nb2\nb3\n');
await git('add', '.');
await git('commit', '-q', '-m', 'init');

// a.txt 改动、b.txt 改动、c.txt 未跟踪 ⇒ 三种状态各一个。
await writeFile(join(repo, 'a.txt'), 'a1\nA2-CHANGED\na3\n');
await writeFile(join(repo, 'b.txt'), 'b1\nB2-CHANGED\nb3\n');
await writeFile(join(repo, 'c.txt'), 'c-NEW\n');

// ---------- 真 host 路由(打包后跑) ----------

const routesPath = join(work, 'routes.mjs');
const gitServicePath = join(work, 'git-service.mjs');
const commitMessagePath = join(work, 'commit-message.mjs');
const storePath = join(work, 'store.mjs');
// 这些也走 esbuild:Node 25 的 strip-only 模式不支持 TS 的「构造器参数属性」
// (`constructor(private readonly runner: GitRunner, …)`),直接 import .ts 会报
// ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX。打包之后就能在探针里用**真实现**。
await build({
  entryPoints: [
    new URL('src/host/routes.ts', REPO).pathname,
    new URL('src/host/git-service.ts', REPO).pathname,
    new URL('src/host/commit-message.ts', REPO).pathname,
  ],
  bundle: true, format: 'esm', platform: 'node', target: 'node20',
  outdir: work, outExtension: { '.js': '.mjs' },
  logLevel: 'warning', external: ['@deepseek-ai/*'],
});

// 真 client store(浏览器半)单独打包:把 api.ts 的相对 BASE 换成探针的绝对前缀。
const basePlugin = {
  name: 'probe-base',
  setup(b) {
    b.onLoad({ filter: /client[\\/]api\.ts$/ }, async (args) => {
      const text = await readFile(args.path, 'utf8');
      const replaced = text.replace(/const BASE = 'dsh-git';/, 'const BASE = globalThis.__PROBE_BASE__;');
      if (replaced === text) throw new Error("探针:api.ts 里没找到 `const BASE = 'dsh-git';` —— 上游改名了,探针已失效。");
      return { contents: replaced, loader: 'ts' };
    });
  },
};
await build({
  entryPoints: [new URL('src/client/store.ts', REPO).pathname],
  bundle: true, format: 'esm', platform: 'neutral', target: 'es2022',
  outfile: storePath, plugins: [basePlugin],
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

const { createGitHandler } = await import(pathToFileURL(routesPath).href);
const { GitService } = await import(pathToFileURL(gitServicePath).href);
const { RepoRegistry } = await import(new URL('src/host/repo-registry.ts', REPO).href);
const { CommitMessageGenerator } = await import(pathToFileURL(commitMessagePath).href);

/**
 * 探针用的 runner:直接 fork 真 `git`。
 *
 * 刻意**不用** `subprocessRunner`(那是宿主 `ctx.subprocess` 的适配器),这里要的
 * 是把「真 git 的输出」喂给真 `GitService`,绕开宿主服务。
 *
 * ⚠️ 注意 argv 约定:`GitRunner.run(argv)` 里的 argv **不含 `git` 本身** ——
 * `topLevelArgv()` 回的是 `['-C', cwd, 'rev-parse', '--show-toplevel']`
 * (`src/core/git-argv.ts:37`)。所以这里固定 exec `git` + argv,
 * 而不是把 `argv[0]` 当可执行文件(踩过一次:`spawn -C ENOENT`,表现为
 * 「这个目录不是 git 仓库」,极容易误判成被测代码的 bug)。
 */
const execRunner = {
  async run(argv, cwd, opts = {}) {
    try {
      const { stdout, stderr } = await run('git', argv, {
        cwd,
        maxBuffer: 32 << 20,
        ...(opts.input === undefined ? {} : {}),
      });
      return { exitCode: 0, stdout, stderr };
    } catch (error) {
      return {
        exitCode: typeof error.code === 'number' ? error.code : 1,
        stdout: typeof error.stdout === 'string' ? error.stdout : '',
        stderr: typeof error.stderr === 'string' ? error.stderr : String(error.message),
      };
    }
  },
};

const registry = new RepoRegistry(null);
await registry.whenReady();
await registry.add({ path: repo, name: 'repo', remote: null, addedAt: Date.now() });
// 「索引即真相」的路径守卫需要仓库在 allowedRoots 里 —— 上面 add 就是干这个。

/** 记录最后一次真正送进模型的输入。 */
let captured = null;
const llm = {
  listProviders: () => [{ id: 'p', name: 'P' }],
  listModels: async () => [{ provider: 'p', providerName: 'P', id: 'm', name: 'M' }],
  stream: async function* () {
    yield { type: 'text-delta', text: '{"title":"probe","description":""}' };
  },
};

const gitService = new GitService(execRunner, {
  allowedRoots: () => registry.allowedRoots(),
});
const generator = new CommitMessageGenerator({
  llm: () => ({
    listProviders: llm.listProviders,
    listModels: llm.listModels,
    stream: (options) => {
      captured = options;
      return llm.stream();
    },
  }),
  registry,
});
const auth = { state: () => ({}), credentialEnv: () => undefined };
const handler = createGitHandler({ git: gitService, registry, llm: generator, auth, buildStamp: 'probe' });
const server = createServer((req, res) => handler(req, res));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

/** 打一次真路由,返回信封。 */
async function post(route, body) {
  const response = await fetch(`http://127.0.0.1:${port}/dsh-git/${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return response.json();
}

/** 从送进模型的 messages 里取出用户 prompt 文本。 */
function promptText() {
  const content = captured?.messages?.[0]?.content ?? [];
  return content.map((c) => c.text ?? '').join('\n');
}

console.log('1) stagedOnly=false ⇒ diff 覆盖工作区全部未提交改动');
{
  const result = await post('commit-message/generate', {
    path: repo, files: ['a.txt', 'b.txt', 'c.txt'], stagedOnly: false,
    provider: 'p', model: 'm',
  });
  check('路由成功', result.ok === true, JSON.stringify(result).slice(0, 200));
  const text = promptText();
  check('prompt 含 a.txt 的改动', text.includes('A2-CHANGED'), text.includes('A2-CHANGED') ? undefined : text.slice(0, 300));
  check('prompt 含 b.txt 的改动', text.includes('B2-CHANGED'));
  check('prompt 含 c.txt(未跟踪文件)', text.includes('c-NEW'));
  check('prompt 文案是「所有未提交的改动」', text.includes('所有未提交的改动'), text.split('\n')[0]);
}

console.log('\n2) stagedOnly=true + 只纳入 a.txt ⇒ diff 只含 a.txt');
{
  captured = null;
  const result = await post('commit-message/generate', {
    path: repo, files: ['a.txt'], stagedOnly: true, provider: 'p', model: 'm',
  });
  check('路由成功', result.ok === true, JSON.stringify(result).slice(0, 200));
  const text = promptText();
  check('prompt 含 a.txt 的改动', text.includes('A2-CHANGED'));
  check('prompt **不含** b.txt 的改动', !text.includes('B2-CHANGED'), text.includes('B2-CHANGED') ? '仍然含 b.txt —— 旧判据没删干净' : undefined);
  check('prompt **不含** c.txt', !text.includes('c-NEW'));
  check('prompt 文案是「纳入本次提交的改动」', text.includes('纳入本次提交的改动'), text.split('\n')[0]);
}

console.log('\n3) stagedOnly=true + 空文件清单 ⇒ 响亮报错(不静默生成)');
{
  captured = null;
  const result = await post('commit-message/generate', {
    path: repo, files: [], stagedOnly: true, provider: 'p', model: 'm',
  });
  check('路由**失败**而不是成功', result.ok === false, JSON.stringify(result));
  check('错误码是 bad-request', result?.error?.code === 'bad-request', String(result?.error?.code));
  check('没有向模型发过请求', captured === null, captured === null ? undefined : '竟然发了请求');
}

console.log('\n4) 旧行为反证:勾选**不写 git 索引**,所以旧判据(file.staged)必然筛空');
{
  const { stdout: indexNames } = await git('diff', '--cached', '--name-only');
  check('git 索引里没有任何已暂存文件', indexNames.trim() === '', JSON.stringify(indexNames));
  const { stdout: status } = await git('status', '--porcelain');
  check('工作区确实有 3 个未提交变更', status.trim().split('\n').length === 3, JSON.stringify(status));

  // 复刻旧判据 `if (stagedOnly && !staged) continue` 所依赖的那个事实:
  // 「哪些文件算 staged」来自 git status 的 XY 码第一列(X 非空格/非 ?)。
  const plus = await git('status', '--porcelain', '-z');
  const stagedEntries = plus.stdout.split('\0').filter((r) => r !== '').filter((r) => r[0] !== ' ' && r[0] !== '?');
  check('按旧判据,「已暂存」的条目数 = 0 ⇒ 旧实现会向模型送空 diff', stagedEntries.length === 0, JSON.stringify(stagedEntries));
}

console.log('\n5) 端到端 client → host:偏好为「只依据纳入」时,送进模型的就是纳入文件');
{
  // 真 client store(打包)打在同一个 host 上,走真 HTTP。
  globalThis.__PROBE_BASE__ = `http://127.0.0.1:${port}/dsh-git`;
  const { GitStore } = await import(pathToFileURL(storePath).href);
  const store = new GitStore('scope');
  // 不调 start()(那会去问工作区/仓库清单),直接把状态摆成「正在看这个仓库」。
  store.state = {
    ...store.snapshot(),
    ready: true,
    current: repo,
    repos: [{ path: repo, name: 'repo', remote: null, addedAt: Date.now() }],
    status: await gitService.status(repo),
    model: 'p/m',
    stagedOnly: true,
    // `LineSelectionSpec` = `{kind, diverging}`(`src/core/partial-stage.ts:28`)。
    includeState: {
      'a.txt': { kind: 'all', diverging: [] },
      'b.txt': { kind: 'none', diverging: [] },
      'c.txt': { kind: 'none', diverging: [] },
    },
  };
  captured = null;
  await store.generateCommitMessage({ force: true });
  const text = promptText();
  check('client 发起的生成里含 a.txt', text.includes('A2-CHANGED'), text.slice(0, 200));
  check('client 发起的生成里**不含** b.txt', !text.includes('B2-CHANGED'));
  check('摘要被写回表单', store.snapshot().commitForm.summary === 'probe', JSON.stringify(store.snapshot().commitForm.summary));
}

await server.close();
await rm(work, { recursive: true, force: true });
void readFile;

console.log('');
if (failures.length === 0) {
  console.log('生成依据探针:全部通过。');
  process.exit(0);
}
console.log(`生成依据探针:${failures.length} 项失败:`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(1);
