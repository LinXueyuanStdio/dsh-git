/**
 * /dsh-git/* 路由层:JSON 信封(ok/value 或 error.code+message),HTTP 形状与
 * 访问门都在这里,业务在 GitService / 生成器里。
 *
 * 访问门:只允许 loopback(本机桌面/浏览器经 127.0.0.1 访问)。远程/局域网
 * 访问一律拒绝 —— 这层是安全边界,因为下面的路由能跑任意已登记仓库的 git。
 * @module dsh-git/host/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GitEnvelope } from '../core/types.ts';
import type { ResetMode } from '../core/git-argv.ts';
import { GitService, GitServiceError, BlobTooLargeError } from './git-service.ts';
import { gitConfigFileInfo } from './git-config-file.ts';
import type { RepoEntry } from '../core/types.ts';
import type { PrefsPatch, RepoRegistry, RemoteRepoLite } from './repo-registry.ts';
import { isHooksEnvShell } from './hooks-env.ts';
import type { CommitMessageGenerator, LlmModelChoice } from './commit-message.ts';
import type { GithubAuth } from './auth.ts';

/** 路由前缀。 */
export const ROUTE_PREFIX = '/dsh-git';

/** 单请求 body 上限。 */
const BODY_LIMIT = 1 << 20;

/** 路由依赖。 */
export interface RouteDeps {
  git: GitService;
  registry: RepoRegistry;
  llm: CommitMessageGenerator;
  auth: GithubAuth;
  /** 目录选择(添加本地仓库时用);没有则前端只能手输路径。 */
  pickDirectory?: () => Promise<string | null>;
  /** 系统动作(在文件管理器显示 / 用编辑器打开);目标路径会被限制在仓库清单内。 */
  system?: {
    reveal(target: string): Promise<boolean>;
    openInApp(target: string, appId?: string): Promise<boolean>;
    listApps(): Promise<{ id: string; label: string }[]>;
    /**
     * 用系统默认应用打开**全局 gitconfig**。
     *
     * 刻意**不**收路径参数:要打开的文件由宿主自己算出来
     * (`git-service.ts` 的 `globalGitConfigPath()`),调用方无法借它打开任意文件 ——
     * 这也是它不能复用 `openInApp` 的原因(`openInApp` 的 guard 只放行已登记的仓库路径)。
     * 可选:老接线或探针里的替身没有这个方法时,`config-file-open` 回可读的 bad-request。
     */
    openGlobalGitConfig?(): Promise<boolean>;
  };
  /** 当前会话所在的工作区路径(自动登记正在编辑的项目)。 */
  currentWorkspace?: (sessionId: string) => Promise<string | null>;
  /**
   * 本 host 产物的构建时间戳。
   * 放进 health 是为了让**客户端能自己发现版本错配** —— host 半不参与热重载,
   * 刷新页面只会拿到新的前端,于是很容易出现「界面是新的、host 是旧的」,
   * 表现为一堆莫名其妙的旧行为(曾经为此白查了很久)。
   */
  buildStamp?: string;
  /** 大文件上限提示用。 */
  log?: (message: string) => void;
}

function isLoopback(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress ?? '';
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1'
    || address === '';
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > BODY_LIMIT) {
      throw new GitServiceError('bad-request', '请求体过大。');
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new GitServiceError('bad-request', '请求体必须是 JSON 对象。');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof GitServiceError) {
      throw error;
    }
    throw new GitServiceError('bad-request', '请求体不是合法 JSON。');
  }
}

function writeJson(response: ServerResponse, envelope: GitEnvelope<unknown>, status = 200): void {
  const body = JSON.stringify(envelope);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  response.end(body);
}

function fail(response: ServerResponse, error: unknown): void {
  if (error instanceof GitServiceError) {
    writeJson(response, { ok: false, error: error.toError() });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  writeJson(response, { ok: false, error: { code: 'internal', message } });
}

// ---------- 二进制端点:GET/HEAD /dsh-git/blob ----------

/** `blob` 的参数(两种写法,见 {@link readBlobQuery})。 */
interface BlobQuery {
  readonly repoPath: string;
  readonly rev: string | undefined;
  readonly file: string;
}

/**
 * 解析 `blob` 的查询参数。
 *
 * 两种写法都收,而且**由 `repo` 是否存在决定**,不做猜测:
 *
 * | 写法 | 仓库 | 文件 | 说明 |
 * |---|---|---|---|
 * | A(客户端在用) | `path` | `file` | 与其它 56 条路由同一套命名(`path` 一向是仓库) |
 * | B(简短式) | `repo` | `path` | 便于手写/粘地址栏 |
 *
 * 为什么不只留 B:这个仓库里 `path` **一直**是「仓库路径」,`blob` 单独换个含义
 * 会让「照既有路由写一个」的人踩坑。两种写法同时存在不是含糊 —— `repo` 一出现
 * 就锁定 B,没有第二种解释。
 * @param url - 请求 URL。
 */
function readBlobQuery(url: URL): BlobQuery {
  const revRaw = url.searchParams.get('rev');
  const rev = revRaw === null || revRaw === '' ? undefined : revRaw;
  const repoAlias = url.searchParams.get('repo');
  if (repoAlias !== null && repoAlias !== '') {
    return { repoPath: repoAlias, rev, file: url.searchParams.get('path') ?? '' };
  }
  return { repoPath: url.searchParams.get('path') ?? '', rev, file: url.searchParams.get('file') ?? '' };
}

/** `ETag` 比对:支持 `*`、逗号列表与 `W/` 弱前缀。 */
function etagMatches(header: string, etag: string): boolean {
  const wanted = etag.replace(/^W\//, '');
  for (const raw of header.split(',')) {
    const one = raw.trim();
    if (one === '*') {
      return true;
    }
    if (one.replace(/^W\//, '') === wanted) {
      return true;
    }
  }
  return false;
}

/**
 * 「内容太大」的判据。
 *
 * **为什么不是单纯的 `instanceof`**:`BlobTooLargeError` 的定义在 `git-service.ts`,
 * 而 `instanceof` 只在**同一个模块实例**里成立。生产构建是一条 bundle(单实例,
 * `instanceof` 够用),但任何人把 host 半拆成两个入口,`instanceof` 就会静默失败 ——
 * 后果是「太大」被降级成 `500 internal`,而 `500` 恰好也是「我们没想到的错误」,
 * 排查时会指向错误的方向。
 *
 * 所以再按**结构**认一次:只有 `BlobTooLargeError` 同时带**数值**的 `size`/`limit`。
 * 这不是猜测 —— 那两个字段是它唯一的、专门为这条响应准备的东西。
 * @param error - 路由捕获到的错误。
 */
function isTooLarge(error: unknown): error is { readonly size: number; readonly limit: number } {
  if (error instanceof BlobTooLargeError) {
    return true;
  }
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { size?: unknown; limit?: unknown };
  return typeof candidate.size === 'number' && typeof candidate.limit === 'number';
}

/** 错误 → 这个端点的 HTTP 状态码。 */
function blobStatusFor(error: unknown): number {
  if (isTooLarge(error)) {
    return 413;
  }
  if (error instanceof GitServiceError) {
    if (error.code === 'bad-request') {
      return 400;
    }
    if (error.code === 'not-a-repository' || error.code === 'workspace-unknown') {
      return 404;
    }
    // `git-failed` 在这条端点上**只**由「请求的 (仓库, 修订, 路径) 让 git 报错」造成
    // (仓库不存在是 404、路径不在这个版本是 404、修订不存在是这一条)⇒ 它是**客户端
    // 给错了参数**,不是服务端故障。旧的 JSON 路由保留 `git-failed` 语义不动
    // (那里靠这个码把 git 的 stderr 透给界面)。
    if (error.code === 'git-failed') {
      return 400;
    }
    return 500;
  }
  return 500;
}

/**
 * `GET`/`HEAD /dsh-git/blob`:回**原始字节**(不是 JSON、不是 base64)。
 *
 * | 关注点 | 做法 |
 * |---|---|
 * | 类型 | `blobInfo` 里按**魔数 + 扩展名**定(`core/blob.ts` 的 `contentTypeFor`) |
 * | 长度 | 永远带 `Content-Length`;`206` 时另带 `Content-Range` |
 * | 缓存 | `ETag`(修订 = blob sha;工作区 = `size-mtime`);**完整 sha 才** `immutable`,会动的引用(`HEAD`/分支/`index`)与工作区都是 `no-cache` + `304` 再验证 |
 * | 区间 | `Range: bytes=a-b` ⇒ `206`;越界 ⇒ `416` + `Content-Range: bytes *​/总长` |
 * | 太大 | `413` + JSON 信封 + `X-Dsh-Git-Size`/`X-Dsh-Git-Limit`(**先量后取**,不返回截断体) |
 *
 * `If-None-Match` 命中时回 `304`,而且那时**一个字节都不读**(`openBlob` 已经把
 * 响应头算好了)。`HEAD` 同理。
 *
 * 两个安全头:`x-content-type-options: nosniff` 与
 * `content-security-policy: default-src 'none'; sandbox` —— 仓库里的 HTML/SVG
 * 可能带脚本,而 blob URL 与宿主同源;这条 CSP 让「把 blob 地址粘到浏览器地址栏」
 * 也执行不了脚本,而 `<img src>` 完全不受影响。
 * @param deps - 路由依赖。
 * @param request - 请求。
 * @param response - 响应。
 */
async function serveBlob(deps: RouteDeps, request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, {
      allow: 'GET, HEAD',
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(JSON.stringify({ ok: false, error: { code: 'bad-request', message: 'blob 只支持 GET/HEAD。' } }));
    return;
  }
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const query = readBlobQuery(url);
  if (query.repoPath === '') {
    throw new GitServiceError('bad-request', '缺少仓库路径。');
  }
  if (query.file === '') {
    throw new GitServiceError('bad-request', '缺少文件路径。');
  }
  const rangeHeader = typeof request.headers.range === 'string' ? request.headers.range : null;
  const blob = await deps.git.openBlob(query.repoPath, query.rev, query.file, rangeHeader);
  if (blob === null) {
    // 404 也用**标记头**:老 host 对未知路由同样回 404(JSON 信封),没有标记头
    // 客户端就分不开「文件不在这个版本里」和「这个 host 没有 blob 路由」。
    response.writeHead(404, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-cache',
      'x-dsh-git-blob': '1',
      'referrer-policy': 'no-referrer',
    });
    response.end(JSON.stringify({ ok: false, error: { code: 'bad-request', message: '这个版本里没有这个文件。' } }));
    return;
  }
  const etag = `"${blob.info.etag}"`;
  const common: Record<string, string> = {
    // 这个头是客户端识别「这台 host 真的有 blob 路由」的唯一判据(见上)。
    'x-dsh-git-blob': '1',
    'content-type': blob.info.contentType,
    etag,
    'cache-control': blob.info.immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'accept-ranges': 'bytes',
    'content-security-policy': "default-src 'none'; sandbox",
    'x-content-type-options': 'nosniff',
    // 真实大小**每个响应都带**:界面据此说「3.2 MB,上限 2 MB」,不用再问一次。
    'x-dsh-git-size': String(blob.total),
    'referrer-policy': 'no-referrer',
  };
  if (blob.unsatisfiable) {
    response.writeHead(416, { ...common, 'content-range': `bytes */${blob.total}`, 'content-length': '0' });
    response.end();
    return;
  }
  const ifNoneMatch = request.headers['if-none-match'];
  if (typeof ifNoneMatch === 'string' && etagMatches(ifNoneMatch, etag)) {
    response.writeHead(304, common);
    response.end();
    return;
  }
  const status = blob.partial ? 206 : 200;
  const length = blob.total === 0 ? 0 : blob.end - blob.start + 1;
  const headers: Record<string, string> = {
    ...common,
    'content-length': String(length),
    ...(blob.partial ? { 'content-range': `bytes ${blob.start}-${blob.end}/${blob.total}` } : {}),
  };
  if (request.method === 'HEAD') {
    response.writeHead(status, headers);
    response.end();
    return;
  }
  const bytes = await blob.read();
  response.writeHead(status, headers);
  response.end(Buffer.from(bytes));
}

/** `blob` 的失败响应:带状态码与机器可读的大小/上限头。 */
function failBlob(response: ServerResponse, error: unknown): void {
  const status = blobStatusFor(error);
  const envelope: GitEnvelope<unknown> = error instanceof GitServiceError
    ? { ok: false, error: error.toError() }
    : { ok: false, error: { code: 'internal', message: error instanceof Error ? error.message : String(error) } };
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    // 失败响应也带标记头:`413 太大` 必须与「未知路由」区分得开。
    'x-dsh-git-blob': '1',
  };
  if (isTooLarge(error)) {
    headers['x-dsh-git-size'] = String(error.size);
    headers['x-dsh-git-limit'] = String(error.limit);
    headers['accept-ranges'] = 'bytes';
  }
  response.writeHead(status, headers);
  response.end(JSON.stringify(envelope));
}

// ---------- 入参读取 ----------

function str(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function strList(body: Record<string, unknown>, key: string): string[] {
  const v = body[key];
  if (!Array.isArray(v)) {
    return [];
  }
  return v.filter((x): x is string => typeof x === 'string' && x !== '');
}

function num(body: Record<string, unknown>, key: string, fallback: number): number {
  const v = body[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function bool(body: Record<string, unknown>, key: string): boolean {
  return body[key] === true;
}

/**
 * 建路由处理器:调用方把它注册到 webServer 的 prefix 路由上。
 * @param deps - 依赖集合。
 */
export function createGitHandler(deps: RouteDeps): (request: IncomingMessage, response: ServerResponse) => void {
  const log = deps.log ?? ((): void => undefined);

  /** 逐个路由表:path(相对前缀) → 处理函数。 */
  const handlers: Record<string, (body: Record<string, unknown>) => Promise<unknown>> = {
    // ---------- 就绪探针 ----------
    // 路由是在 storage domain 打开之后才注册的,客户端启动时先轮询它,
    // 避免首次请求撞上「路由还没挂好」的窗口。
    'health': async () => ({
      ready: true,
      repos: deps.registry.list().length,
      signedIn: deps.registry.githubToken() !== '',
      // 令牌**来自哪一层**(`env` / `credentials-file` / `dotenv` / `memory` /
      // `none`),**永不**是值本身。`memory` = 只在本次运行的进程内存里
      // (凭据服务缺席或写入失败);界面与排查都读它。
      tokenSource: deps.registry.githubTokenSource(),
      // persistent=false 表示 storage domain 没打开成功:功能可用,但重启会丢清单/令牌。
      persistent: deps.registry.storageStatus().persistent,
      storageError: deps.registry.storageStatus().error,
      build: deps.buildStamp ?? '',
    }),

    // ---------- 仓库清单 ----------
    'repos': async () => {
      await deps.registry.whenReady();
      // 每次列清单都核对目录是否还在(Desktop 会把找不到的仓库单独标出来;
      // 我们也据此把 Open in shell / Reveal / 编辑器 三项置灰)。
      await deps.registry.refreshMissing();
      return {
        repos: deps.registry.list(),
        hidden: deps.registry.hidden(),
        tokenTail: deps.registry.githubTokenTail(),
        canPickDirectory: deps.pickDirectory !== undefined,
        lastSelected: deps.registry.lastSelected(),
      };
    },
    // ---------- 系统动作(Desktop 的 Show in Finder / Open in <editor>) ----------

    /** 列出本机可用的外部编辑器(没有 system 服务时只返回默认项)。 */
    'system/apps': async () => ({
      apps: deps.system === undefined
        ? [{ id: 'default', label: '系统默认应用' }]
        : (await deps.system.listApps()).map((a) => ({ id: a.id, label: a.label })),
    }),

    /** 在文件管理器中显示该路径(Show in Finder)。 */
    'system/reveal': async (body) => {
      if (deps.system === undefined) {
        throw new GitServiceError('bad-request', '宿主未提供系统动作能力。');
      }
      return { ok: await deps.system.reveal(str(body, 'path') ?? '') };
    },

    /** 用外部编辑器打开该路径(Open in <editor>)。 */
    'system/open-in-app': async (body) => {
      if (deps.system === undefined) {
        throw new GitServiceError('bad-request', '宿主未提供系统动作能力。');
      }
      const app = str(body, 'app');
      return { ok: await deps.system.openInApp(str(body, 'path') ?? '', app) };
    },

    // ---------- 本地文件树(Code 页签) ----------

    /**
     * 列出工作区文件(遵守 .gitignore)。
     * 远端 Code 页签走 GitHub 的 `git/trees?recursive=1`,本地这条走 `git ls-files`。
     */
    'repo/tree': async (body) => deps.git.listFiles(requirePath(body)),

    /**
     * 读**某个修订下**某个文件的内容(blob)—— **老 host 契约**(JSON)。
     *
     * 与 `file-text` 的区别:后者读工作区磁盘上的当前内容,这里读某个版本的内容。
     * `rev` 现在也接受 `index`(读暂存区),这是新的 `blob` 端点带来的能力。
     *
     * ⚠️ **新代码请用 `GET /dsh-git/blob`**:原始字节、`Range`、`ETag`/`304`、
     * 一个上限(2 MiB)、超限带真实大小拒绝。这条 JSON 路由只保留给**老 host**:
     * 前端与 host 的构建戳可能不一致(host 不热重载),刷新页面后新前端必须还能
     * 从旧 host 取到内容。它的 base64 上限已收窄到 256 KiB(理由见
     * `core/blob.ts` 的 `BLOB_JSON_FALLBACK_MAX_BYTES`)。
     */
    'show-file': async (body) => {
      const file = str(body, 'file');
      const rev = str(body, 'rev');
      if (file === undefined) {
        throw new GitServiceError('bad-request', '缺少文件路径。');
      }
      if (rev === undefined) {
        throw new GitServiceError('bad-request', '缺少修订名。');
      }
      return deps.git.showFile(requirePath(body), rev, file);
    },

    /**
     * 读一个工作区文件的内容;守卫见 `GitService.fileText`。
     *
     * 二进制仍回 base64(`encoding:'base64'`),但上限收窄到 256 KiB ——
     * 这条路径每个字节都要穿 JSON 且没有 `Range`/缓存,只作为老 host 兜底
     * (新路径:`GET /dsh-git/blob`)。文本上限与二进制判定仍全在 service 里,
     * 但只有**一个**字节上限(`MAX_BLOB_BYTES`,2 MiB)。
     */
    'file-text': async (body) => {
      const file = str(body, 'file');
      if (file === undefined) {
        throw new GitServiceError('bad-request', '缺少文件路径。');
      }
      return deps.git.fileText(requirePath(body), file);
    },

    /** 目录选择:克隆目标、添加仓库都用它(宿主能力,没有则返回 null)。 */
    'pick-directory': async () => ({ path: deps.pickDirectory === undefined ? null : await deps.pickDirectory() }),

    'repos/add': async (body) => {
      const path = str(body, 'path');
      if (path === undefined) {
        throw new GitServiceError('bad-request', '缺少仓库路径。');
      }
      const chosen = path === '@pick' && deps.pickDirectory !== undefined
        ? await deps.pickDirectory()
        : path;
      if (chosen === null || chosen === undefined) {
        return { added: false, repos: deps.registry.list() };
      }
      const root = await deps.git.repoRoot(chosen);
      if (root === null) {
        throw new GitServiceError('not-a-repository', `${chosen} 不是 git 仓库(可以先初始化)。`);
      }
      const [remote, branch] = await Promise.all([
        deps.git.githubRemote(root),
        deps.git.headBranch(root),
      ]);
      const entry: RepoEntry = {
        path: root,
        name: root.split('/').pop() ?? root,
        remote,
        addedAt: Date.now(),
        ...(branch !== '' ? { branch } : {}),
      };
      const repos = await deps.registry.add(entry);
      return { added: true, repos };
    },
    'repos/add-existing': async (body) => {
      // 语义同 add,但允许显式初始化一个空目录。
      const path = str(body, 'path');
      if (path === undefined) {
        throw new GitServiceError('bad-request', '缺少仓库路径。');
      }
      const chosen = path === '@pick' ? await deps.pickDirectory?.() : path;
      if (chosen === null || chosen === undefined) {
        return { added: false, repos: deps.registry.list() };
      }
      let root = await deps.git.repoRoot(chosen);
      if (root === null && bool(body, 'init')) {
        await deps.git.init({ path: chosen, defaultBranch: 'main' });
        root = await deps.git.repoRoot(chosen);
      }
      if (root === null) {
        throw new GitServiceError('not-a-repository', `${chosen} 不是 git 仓库。`);
      }
      const entry: RepoEntry = {
        path: root,
        name: root.split('/').pop() ?? root,
        remote: await deps.git.githubRemote(root),
        addedAt: Date.now(),
      };
      return { added: true, repos: await deps.registry.add(entry) };
    },
    /**
     * 自动登记「当前工作区项目」:宿主从 workspaceRegistry 找出本会话所在工作区,
     * 若是 git 仓库且还没登记,就加进清单并返回其路径供前端选中。
     */
    'repos/autodetect': async (body) => {
      const sessionId = str(body, 'sessionId') ?? '';
      if (deps.currentWorkspace === undefined) {
        return { detected: false, path: null, repos: deps.registry.list(), reason: 'host 未提供工作区信息' };
      }
      const path = await deps.currentWorkspace(sessionId);
      if (path === null || path === '') {
        return { detected: false, path: null, repos: deps.registry.list(), reason: '没有找到工作区' };
      }
      const root = await deps.git.repoRoot(path);
      if (root === null) {
        return { detected: false, path: null, repos: deps.registry.list(), reason: `${path} 不是 git 仓库` };
      }
      const existing = deps.registry.find(root);
      if (existing !== undefined) {
        return { detected: true, path: root, added: false, repos: deps.registry.list() };
      }
      const entry: RepoEntry = {
        path: root,
        name: root.split('/').pop() ?? root,
        remote: await deps.git.githubRemote(root),
        addedAt: Date.now(),
        branch: await deps.git.headBranch(root),
      };
      const repos = await deps.registry.add(entry);
      return { detected: true, path: root, added: true, repos };
    },

    /** 记住当前选中的仓库(重开页签/重启后据此恢复)。 */
    'repos/select': async (body) => {
      const path = str(body, 'path') ?? '';
      await deps.registry.setLastSelected(path);
      return { ok: true };
    },

    /** 保存生成相关的偏好(模型 / 生成范围 / 自定义 system prompt / Hooks 环境)。 */
    'prefs/set': async (body) => {
      const patch: PrefsPatch = {};
      const model = str(body, 'model');
      if (model !== undefined) {
        patch.model = model;
      }
      if (typeof body.stagedOnly === 'boolean') {
        patch.stagedOnly = body.stagedOnly;
      }
      const prompt = str(body, 'systemPrompt');
      if (prompt !== undefined) {
        patch.systemPrompt = prompt;
      }
      /*
       * Hooks 环境的三个键。客户端镜像 `lib/hooks/config.ts` 写的是 **localStorage**
       * (`git-hooks-env-enabled` / `git-cache-hooks-env` / `git-hook-env-shell`),
       * 而消费方(spawn git 时注入 shell 环境)在宿主侧 —— 所以
       * `src/client/git-page.tsx` 在那三个回调里**多发一次**这条路由(见它的文件头)。
       *
       * shell 是**枚举**,不是自由字符串:客户端只能从那四个里选
       * (`git.tsx` 的 `select` 用 `shellFriendlyNames` 的键)。非法值**响亮报错** ——
       * 与 stagedOnly 那种「类型不对就静默忽略」不同,因为字符串没有天然边界,
       * 静默忽略会让「下拉点了没反应」又回来一次。
       */
      if (typeof body.hooksEnvEnabled === 'boolean') {
        patch.hooksEnvEnabled = body.hooksEnvEnabled;
      }
      if (typeof body.cacheHooksEnv === 'boolean') {
        patch.cacheHooksEnv = body.cacheHooksEnv;
      }
      const hookEnvShell = str(body, 'hookEnvShell');
      if (hookEnvShell !== undefined) {
        if (!isHooksEnvShell(hookEnvShell)) {
          throw new GitServiceError('bad-request', `不支持的 shell:${hookEnvShell}。`);
        }
        patch.hookEnvShell = hookEnvShell;
      }
      await deps.registry.setPrefs(patch);
      // 偏好是**用户明确表达的选择**,写不进去必须响亮报错(见 assertPersisted)。
      assertPersisted('设置');
      return { ok: true };
    },

    /**
     * 读回已落盘的生成偏好。
     *
     * 这条读回路是后来补的,原因是 `prefs/set` **只写不读**:host 端
     * `pinnedModel()`(`src/index.ts:363`)拿 `prefs.model` 去生成提交信息,
     * 而界面刷新后由 `loadModels()` 把下拉重置成 `models[0]` ——
     * 于是「设置里选的模型」与「真正用来生成的模型」会静默分叉。
     * 实测(真 HTTP + 真 client store):选 provB/model-b、刷新后下拉显示
     * provA/model-a,而磁盘上 `prefs.model` 一直是 provB/model-b。
     *
     * 逐字段回显而不是回整个 `prefs`,是为了让「从未设置过」与「设成了默认值」
     * 在客户端可区分:没设置过的键不出现在载荷里。
     */
    'prefs/get': async () => {
      const out: PrefsPatch = {};
      const model = deps.registry.prefModel();
      if (model !== '') {
        out.model = model;
      }
      // stagedOnly 有「从未设置」与「明确设成 false」两种状态,必须分开回:
      // `prefStagedOnly()` 把两者都折成 true(它是给 host 生成用的默认值判定)。
      const stagedOnly = deps.registry.prefStagedOnlyRaw();
      if (stagedOnly !== undefined) {
        out.stagedOnly = stagedOnly;
      }
      const prompt = deps.registry.prefSystemPrompt();
      if (prompt !== '') {
        out.systemPrompt = prompt;
      }
      /*
       * Hooks 三键走**原样**回显(与 stagedOnly 同一条理由):`prefHooksEnv()` 是给
       * 宿主消费用的**生效值**(带默认值),而这条读回路要给的是「用户到底设过没有」。
       * 「从来没设过」与「设成了默认值」在客户端是两种状态 —— 前者要按默认值走。
       */
      const hooks = deps.registry.prefHooksEnvRaw();
      if (hooks.enabled !== undefined) {
        out.hooksEnvEnabled = hooks.enabled;
      }
      if (hooks.cache !== undefined) {
        out.cacheHooksEnv = hooks.cache;
      }
      if (hooks.shell !== undefined) {
        out.hookEnvShell = hooks.shell;
      }
      return out;
    },

    'repos/remove': async (body) => {
      const path = str(body, 'path');
      if (path === undefined) {
        throw new GitServiceError('bad-request', '缺少仓库路径。');
      }
      return { repos: await deps.registry.remove(path) };
    },
    'repos/rename': async (body) => {
      const path = str(body, 'path');
      if (path === undefined) {
        throw new GitServiceError('bad-request', '缺少仓库路径。');
      }
      return { repos: await deps.registry.rename(path, str(body, 'alias') ?? '') };
    },
    'repos/scan': async (body) => {
      // 探测若干候选路径里哪些是仓库(添加前预览用)。
      const candidates = strList(body, 'paths');
      const out: { path: string; root: string | null; remote: string | null }[] = [];
      for (const candidate of candidates.slice(0, 32)) {
        const root = await deps.git.repoRoot(candidate);
        out.push({
          path: candidate,
          root,
          remote: root === null ? null : await deps.git.githubRemote(root),
        });
      }
      return { candidates: out };
    },

    // ---------- 状态 / 同步 ----------
    'status': async (body) => deps.git.status(requirePath(body)),
    'sync-state': async (body) => deps.git.syncState(requirePath(body)),
    /*
     * **在飞的网络动作进度**(`git --progress` 的 stderr 解析结果)。
     *
     * 为什么需要一条**独立**的路由:推送本身是一条**一直阻塞到结束**的请求,
     * 进度不可能搭它自己的响应回来(响应就是 `{ok:true}`,那时已经推完了)。
     * 所以进度走**旁路** —— 推送请求照旧(信封、错误码、`detail` 全部不变,
     * 见 `docs/push-failure-surfaces.md`),这条路由只查宿主内存里的一份 Map。
     *
     * 代价刻意压到最低:一次 Map 查询,**不跑任何子进程**(路径不做 `gate()`,
     * 理由见 `GitService.syncProgressOf` 的注释),所以客户端可以按 ~250ms 轮询。
     *
     * 取不到 ⇒ `{ progress: null }`(没有动作在跑 / 不是这个仓库);**不报错** ——
     * 「没有进度」是正常状态,把它做成 4xx 会让客户端每一轮都记一条诊断。
     */
    'sync-progress': async (body) => ({ progress: deps.git.syncProgressOf(requirePath(body)) }),

    // ---------- diff ----------
    'diff': async (body) => {
      const file = str(body, 'file');
      if (file === undefined) {
        throw new GitServiceError('bad-request', '缺少文件路径。');
      }
      const commit = str(body, 'commit');
      return deps.git.diff({
        path: requirePath(body),
        file,
        ...(bool(body, 'staged') ? { staged: true } : {}),
        ...(bool(body, 'untracked') ? { untracked: true } : {}),
        ...(commit !== undefined ? { commit } : {}),
        // 「隐藏空白改动」= 重跑一次 git diff -w(不是界面过滤)
        ...(bool(body, 'ignoreWhitespace') ? { ignoreWhitespace: true } : {}),
      });
    },

    // ---------- 暂存 / 丢弃 / 提交 ----------
    'stage': async (body) => {
      await deps.git.stage(requirePath(body), strList(body, 'files'));
      return { ok: true };
    },
    'unstage': async (body) => {
      await deps.git.unstage(requirePath(body), strList(body, 'files'));
      return { ok: true };
    },
    'discard': async (body) => {
      // 兼容旧的 untracked 整批标志,同时支持更精确的 untrackedPaths。
      const files = strList(body, 'files');
      const explicit = strList(body, 'untrackedPaths');
      const untrackedPaths = explicit.length > 0
        ? explicit
        : (bool(body, 'untracked') ? files : []);
      await deps.git.discard(requirePath(body), files, { untrackedPaths });
      return { ok: true };
    },
    /** 行级/块级部分暂存(选区索引 = patch 内的绝对行号)。 */
    'stage-lines': async (body) => {
      const file = str(body, 'file');
      if (file === undefined) {
        throw new GitServiceError('bad-request', '缺少文件路径。');
      }
      const raw = body.selection;
      if (typeof raw !== 'object' || raw === null) {
        throw new GitServiceError('bad-request', '缺少行选区。');
      }
      const selection = raw as { kind?: unknown; diverging?: unknown; selectable?: unknown };
      const kind = selection.kind === 'all' ? 'all' : 'none';
      const diverging = Array.isArray(selection.diverging)
        ? selection.diverging.filter((x): x is number => typeof x === 'number' && Number.isFinite(x))
        : [];
      const selectable = Array.isArray(selection.selectable)
        ? selection.selectable.filter((x): x is number => typeof x === 'number' && Number.isFinite(x))
        : undefined;
      const fileKind = (str(body, 'kind') ?? 'modified') as 'new' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'conflicted' | 'untracked';
      return deps.git.stageLines(requirePath(body), {
        file,
        kind: fileKind,
        selection: { kind, diverging, ...(selectable === undefined ? {} : { selectable }) },
      });
    },

    'commit': async (body) => {
      const message = str(body, 'message') ?? '';
      const paths = strList(body, 'files');
      return deps.git.commit(requirePath(body), {
        message,
        ...(str(body, 'description') !== undefined ? { description: str(body, 'description') as string } : {}),
        amend: bool(body, 'amend'),
        noVerify: bool(body, 'noVerify'),
        signoff: bool(body, 'signoff'),
        allowEmpty: bool(body, 'allowEmpty'),
        paths,
      });
    },
    'commit-detail': async (body) => {
      const sha = str(body, 'sha');
      if (sha === undefined) {
        throw new GitServiceError('bad-request', '缺少提交号。');
      }
      return deps.git.commitDetail(requirePath(body), sha);
    },

    /** 撤销一次提交(改动保留在工作区)。 */
    'undo-commit': async (body) => {
      const sha = str(body, 'sha');
      if (sha === undefined) {
        throw new GitServiceError('bad-request', '缺少提交号。');
      }
      return deps.git.undoCommit(requirePath(body), sha);
    },

    // ---------- 历史 / 提交操作(本次新增) ----------
    //
    // 每条都写清「对照的上游 Desktop 命令 + 上游文件:行号」。
    // 参数的**缺失**一律 `bad-request`(绝不静默取默认值);argv 的构造全部在
    // `core/git-argv.ts`(每个 ref 都落在 `--end-of-options` 之后),这里不拼 shell。

    /**
     * 行级/块级丢弃:把客户端送来的补丁**反向**应用到工作区(**不是** index)。
     *
     * 对照上游:`references/desktop/app/src/lib/git/apply.ts:102-120` 的
     * `discardChangesFromSelection`(+ 补丁构造 `lib/patch-formatter.ts:251-328`)。
     * 上游靠「先把 `+`/`-` 两侧交换好」实现反向;我们按冻结契约收补丁文本,
     * 在 host 侧用 `git apply --reverse`(既有的 `applyReverseArgv`)反向应用。
     *
     * `file` 不是装饰:它用来核对补丁头(`git-service.ts` 的 `discardLines`)——
     * 「丢弃 A 却送来了 B 的补丁」会静默丢掉 B 的改动,而丢弃不可逆,所以宁可拒绝。
     * 空补丁也拒绝(`str()` 把 `''` 当缺参):没有内容可丢弃本身就是调用方的 bug。
     */
    'discard-lines': async (body) => {
      const file = str(body, 'file');
      if (file === undefined) {
        throw new GitServiceError('bad-request', '缺少文件路径。');
      }
      const patch = str(body, 'patch');
      if (patch === undefined) {
        throw new GitServiceError('bad-request', '缺少补丁内容。');
      }
      await deps.git.discardLines(requirePath(body), file, patch);
      return { ok: true };
    },

    /**
     * reset 到某个提交。
     *
     * 对照上游:`ui/dispatcher/dispatcher.ts:960-967` 的 `resetToCommit` →
     * `lib/stores/app-store.ts:5856-5889` → `lib/git/reset.ts:41-46`;
     * 模式到 argv 的映射在 `lib/git/reset.ts:27-38`。
     *
     * `mode` 缺省 = `mixed`(与冻结的客户端签名 `mode = 'mixed'` 一致);
     * 但**非法值一律拒绝**,不悄悄降级成 mixed。
     *
     * ⚠️ 返回值里的 `worktreeDiscarded` 就是「`hard` 会丢工作区改动」这件事的
     * 机器可读表达(上游在界面上弹警告:`references/desktop/app/src/ui/reset/warning-before-reset.tsx`;
     * host 不做确认交互,但必须把风险说出来)。客户端契约是 `{ ok: true }`,
     * 多出来的字段会被忽略,所以这是**加法**而不是破坏。
     */
    'reset-to-commit': async (body) => {
      const sha = str(body, 'sha');
      if (sha === undefined) {
        throw new GitServiceError('bad-request', '缺少提交号。');
      }
      const raw = str(body, 'mode') ?? 'mixed';
      if (raw !== 'soft' && raw !== 'mixed' && raw !== 'hard') {
        throw new GitServiceError('bad-request', `不认识的 reset 模式:${raw}`);
      }
      const mode: ResetMode = raw;
      await deps.git.resetToCommit(requirePath(body), sha, mode);
      return { ok: true, worktreeDiscarded: mode === 'hard' };
    },

    /**
     * 切到某个提交(**分离头**)。
     *
     * 对照上游:`ui/dispatcher/dispatcher.ts:736-741` 的 `checkoutCommit` →
     * `lib/stores/app-store.ts:4808-4838` → `lib/git/checkout.ts:165-187`。
     * 上游拼的是裸 `git checkout <sha>`(靠「参数是 sha ⇒ git 自己分离头」),
     * 我们显式 `--detach`,理由见 `core/git-argv.ts` 的 `checkoutDetachArgv`。
     */
    'checkout-commit': async (body) => {
      const sha = str(body, 'sha');
      if (sha === undefined) {
        throw new GitServiceError('bad-request', '缺少提交号。');
      }
      await deps.git.checkoutCommit(requirePath(body), sha);
      return { ok: true };
    },

    /**
     * revert 某个提交。
     *
     * 对照上游:`lib/git/revert.ts:22-55` 的 `revertCommit`
     * (`git revert [ -m 1 ] <sha>`,合并提交补第一父)。
     * 冲突时 git 退出码非 0、**不建提交**,仓库留在 `REVERT_HEAD`;
     * 这里报 `merge-conflicts`,详见 `git-service.ts` 的 `revertCommit`。
     */
    'revert-commit': async (body) => {
      const sha = str(body, 'sha');
      if (sha === undefined) {
        throw new GitServiceError('bad-request', '缺少提交号。');
      }
      await deps.git.revertCommit(requirePath(body), sha);
      return { ok: true };
    },

    /**
     * cherry-pick 某个提交。
     *
     * 对照上游:`lib/git/cherry-pick.ts:141-182` 的 `cherryPick`
     * (上游是 `cherry-pick <sha>… --empty=keep -m 1`;本路由按冻结契约只 pick 一个,
     * 理由见 `core/git-argv.ts` 的 `cherryPickArgv`)。
     * 冲突时留在 `CHERRY_PICK_HEAD`,报 `merge-conflicts`。
     */
    'cherry-pick-commit': async (body) => {
      const sha = str(body, 'sha');
      if (sha === undefined) {
        throw new GitServiceError('bad-request', '缺少提交号。');
      }
      await deps.git.cherryPickCommit(requirePath(body), sha);
      return { ok: true };
    },

    /**
     * 建标签。对照上游:`lib/git/tag.ts:13-21` 的 `createTag`
     * (上游是附注标签 `tag -a -m '' <name> <sha>`;本路由按冻结契约为轻量标签
     * `git tag <name> [<sha>]`,差别见 `core/git-argv.ts` 的 `tagCreateArgv`)。
     * `sha` 是**可选**的(缺省 = 当前 HEAD),所以这里用 `undefined` 表示「没给」,
     * 与「给了空串」不同 —— 后者被 `str()` 折成缺参。
     */
    'tag-create': async (body) => {
      const name = str(body, 'name');
      if (name === undefined) {
        throw new GitServiceError('bad-request', '缺少标签名。');
      }
      await deps.git.createTag(requirePath(body), name, str(body, 'sha'));
      return { ok: true };
    },

    /** 删标签。对照上游:`lib/git/tag.ts:29-36` 的 `deleteTag` = `git tag -d <name>`。 */
    'tag-delete': async (body) => {
      const name = str(body, 'name');
      if (name === undefined) {
        throw new GitServiceError('bad-request', '缺少标签名。');
      }
      await deps.git.deleteTag(requirePath(body), name);
      return { ok: true };
    },

    /**
     * **哪些本地标签还没到远端** —— History 右键 `Delete tag <name>` 的启用判据。
     *
     * 这条路由补的是审计文 `docs/dead-code-and-missing-state-audit.md` §2.3 记的
     * 「`Delete tag` 的数据缺口」:那一项在菜单里恒灰,因为
     * 「哪些 tag 未推送」当时只有**个数**(`sync-state.tagCount`)没有**身份**。
     *
     * 真身与 argv 见 `git-service.ts` 的 `unpushedTags()` 与 `core/git-argv.ts` 的
     * `unpushedTagsArgv()`(上游 `lib/git/tag.ts:86` 的 `fetchTagsToPush`,一次
     * `git push --dry-run --porcelain`,**只问不推**)。
     *
     * 语义边界(照实写,免得被读成「远端标签清单」):
     *  - 它回答的是「**把标签推到那个远端**会发生什么」,所以**只**看远端 refs;
     *  - 没有远端 ⇒ `[]`(没有「推没推过」这回事 ⇒ 菜单项保持灰);
     *  - 远端不可达 / 认证失败 ⇒ 走既有错误信封(客户端对这条问询**静默保留旧值**)。
     * `remote` 可选:缺省时宿主按 `push()` 同一套顺序选(上游 remote ⇒ 否则第一个)。
     */
    'tag-unpushed': async (body) => ({
      tags: await deps.git.unpushedTags(requirePath(body), str(body, 'remote')),
    }),

    // ---------- 历史 ----------
    'log': async (body) => deps.git.log(requirePath(body), {
      limit: num(body, 'limit', 50),
      ...(body.skip !== undefined ? { skip: num(body, 'skip', 0) } : {}),
      ...(str(body, 'ref') !== undefined ? { ref: str(body, 'ref') as string } : {}),
    }),

    // ---------- 分支 / 远端 ----------
    'branches': async (body) => deps.git.branches(requirePath(body)),
    'checkout': async (body) => {
      const branch = str(body, 'branch');
      if (branch === undefined) {
        throw new GitServiceError('bad-request', '缺少分支名。');
      }
      const from = str(body, 'createFromRemote');
      await deps.git.checkout(requirePath(body), branch, from !== undefined ? { createFromRemote: from } : {});
      return { ok: true };
    },
    /** 新建分支;名字由 host 用 Desktop 的规则校验(sanitize-ref-name)。 */
    'branch-create': async (body) => {
      const name = str(body, 'name');
      if (name === undefined) {
        throw new GitServiceError('bad-request', '缺少分支名。');
      }
      await deps.git.createBranch(requirePath(body), name, str(body, 'startPoint'));
      return { ok: true };
    },
    'branch-rename': async (body) => {
      const oldName = str(body, 'oldName');
      const newName = str(body, 'newName');
      if (oldName === undefined || newName === undefined) {
        throw new GitServiceError('bad-request', '缺少分支名。');
      }
      await deps.git.renameBranch(requirePath(body), oldName, newName);
      return { ok: true };
    },
    'branch-delete': async (body) => {
      const name = str(body, 'name');
      if (name === undefined) {
        throw new GitServiceError('bad-request', '缺少分支名。');
      }
      await deps.git.deleteBranch(requirePath(body), name);
      return { ok: true };
    },
    /**
     * 删**远端**分支。
     *
     * 对照上游:`references/desktop/app/src/lib/git/branch.ts:119-143` 的
     * `deleteRemoteBranch`(上游 argv 是 `push -- <remote> :<branch>`;
     * 本路由按冻结契约用 `git push <remote> --delete <branch>`,两者等价)。
     * `remote` 必须是**配置里存在的远端名**(服务内部比对 `git remote` 的输出),
     * 所以拼进 argv 的不是任意串;push 不支持 `--end-of-options`,理由见
     * `core/git-argv.ts` 的 `pushDeleteRemoteBranchArgv`。
     * 「远端 ref 已经不在了」按上游折成成功(顺手清掉本地过期的 remote-tracking ref)。
     */
    'remote-branch-delete': async (body) => {
      const remote = str(body, 'remote');
      const branch = str(body, 'branch');
      if (remote === undefined || branch === undefined) {
        throw new GitServiceError('bad-request', '缺少远端名或分支名。');
      }
      await deps.git.deleteRemoteBranch(requirePath(body), remote, branch);
      return { ok: true };
    },
    'remotes': async (body) => ({ remotes: await deps.git.remotes(requirePath(body)) }),
    'remote-set-url': async (body) => {
      const name = str(body, 'name');
      const url = str(body, 'url');
      if (name === undefined || url === undefined) {
        throw new GitServiceError('bad-request', '缺少远端名或地址。');
      }
      await deps.git.setRemoteUrl(requirePath(body), name, url);
      return { ok: true };
    },

    // ---------- 同步动作 ----------
    'fetch': async (body) => {
      const path = requirePath(body);
      await deps.git.fetch(path, str(body, 'remote'));
      await deps.registry.markFetched(path);
      return { ok: true };
    },
    'pull': async (body) => {
      const path = requirePath(body);
      /*
       * `rebase` 来自 `sync-state` 的 `pullWithRebase`(**同一个**读,客户端原样带回),
       * 见 `GitService.pull` 的 `opts.rebase`。缺省(老客户端「更多 ▸ 拉取」、
       * `runSyncAction('pull')`)时**不传** ⇒ 宿主自己读配置,行为与改前逐字一致。
       *
       * `bool()` 只认真正的布尔:字符串 "false" 会被当成「没给」而不是 false ——
       * 这个方向是刻意的,「把 'false' 解析成 false」会让一个畸形载荷**反转**用户的
       * git 配置(它本该走宿主自己那一读)。
       */
      const rebase = body.rebase;
      await deps.git.pull(
        path,
        typeof rebase === 'boolean' ? { rebase } : {},
      );
      await deps.registry.markFetched(path);
      return { ok: true };
    },
    'push': async (body) => {
      await deps.git.push(requirePath(body), { force: bool(body, 'force'), noVerify: bool(body, 'noVerify') });
      return { ok: true };
    },
    'clone': async (body) => {
      const url = str(body, 'url');
      const path = str(body, 'path');
      if (url === undefined || path === undefined) {
        throw new GitServiceError('bad-request', '缺少 URL 或目标路径。');
      }
      await deps.git.clone({ url, path, ...(str(body, 'branch') !== undefined ? { branch: str(body, 'branch') as string } : {}) });
      const root = await deps.git.repoRoot(path);
      if (root === null) {
        throw new GitServiceError('internal', '克隆完成但无法定位仓库。');
      }
      await deps.registry.add({
        path: root,
        name: root.split('/').pop() ?? root,
        remote: await deps.git.githubRemote(root),
        addedAt: Date.now(),
      });
      return { root, repos: deps.registry.list() };
    },

    // ---------- 配置(作者信息) ----------
    'config-get': async (body) => {
      const key = str(body, 'key');
      if (key === undefined) {
        throw new GitServiceError('bad-request', '缺少配置键。');
      }
      const scope = str(body, 'scope') === 'global' ? 'global' : 'local';
      return { key, scope, value: await deps.git.config(requirePath(body), key, scope) };
    },
    'config-set': async (body) => {
      const key = str(body, 'key');
      const value = str(body, 'value');
      if (key === undefined) {
        throw new GitServiceError('bad-request', '缺少配置键。');
      }
      await deps.git.setConfig(requirePath(body), key, value ?? '', str(body, 'scope') === 'global');
      return { ok: true };
    },

    // ---------- 全局 gitconfig 文件(两处「edit your global Git config」链接 + 锁文件) ----------

    /**
     * 全局 gitconfig 的路径 / 存在性 / 锁文件路径与存在性。
     *
     * 上游对照:
     *  - 两个链接 `ui/preferences/git.tsx:214`、`ui/lfs/attribute-mismatch.tsx:32`;
     *  - `ConfigLockFileExists` 的渲染分支 `ui/preferences/preferences.tsx:609-619`
     *    (它消费的 `existingLockFilePath` 由 `:1088-1099` + `lib/git/core.ts:422-444` 解析);
     *  - 锁文件的形状 `<配置文件>.lock` 见 `host/git-config-file.ts` 的文件头。
     * 路径解析**复用** `git-service.ts` 的 `globalGitConfigPath()`,不另写一份。
     */
    'config-file-info': async () => gitConfigFileInfo(),

    /**
     * 用系统默认应用打开全局 gitconfig。
     *
     * 上游对照:`AppStore._editGlobalGitConfig()`(`lib/stores/app-store.ts:7664-7668`):
     * 先解析路径,再用外部编辑器打开 —— 差别是上游用用户配置的编辑器,我们用
     * **系统默认应用**(契约里就是这么定的)。
     *
     * 打开动作走**已有的**系统动作能力(`deps.system`,见 `system/open-in-app`),
     * 不新写平台命令;路径由宿主自己算,不收调用方的路径。
     * 文件不存在 ⇒ `bad-request`(上游会先创建它;我们的契约是报错,见
     * `host/git-config-file.ts` 的「只读」一节)。
     */
    'config-file-open': async () => {
      const info = await gitConfigFileInfo();
      if (info.path === null) {
        throw new GitServiceError('bad-request', '无法确定全局 git 配置文件的路径(读不到用户主目录)。');
      }
      if (!info.exists) {
        throw new GitServiceError('bad-request', `全局 git 配置文件还不存在:${info.path}`);
      }
      if (deps.system?.openGlobalGitConfig === undefined) {
        throw new GitServiceError('bad-request', '宿主未提供系统动作能力。');
      }
      const opened = await deps.system.openGlobalGitConfig();
      if (!opened) {
        throw new GitServiceError('internal', `系统没能打开 ${info.path}(可能没有可用的默认应用)。`);
      }
      return { ok: true as const };
    },

    // ---------- 生成提交信息 ----------
    'commit-message/models': async () => ({ models: await deps.llm.listModels() }),
    'commit-message/generate': async (body) => {
      const path = requirePath(body);
      const patch = str(body, 'patch');
      const files = strList(body, 'files');
      const provider = str(body, 'provider') ?? '';
      const model = str(body, 'model') ?? '';
      if (provider === '' || model === '') {
        throw new GitServiceError('bad-request', '请先在设置里选择生成用的模型。');
      }
      const stagedOnly = bool(body, 'stagedOnly');
      // 「只依据纳入提交的变更生成」必须有纳入清单 —— 否则会拿着空 diff 去问模型,
      // 然后**静默**写回一条空泛的提交信息。宁可响亮地拒绝。
      if (stagedOnly && files.length === 0) {
        throw new GitServiceError('bad-request', '没有纳入提交的文件,无法只依据纳入的变更生成。');
      }
      let diffText = patch ?? '';
      if (diffText === '') {
        // 没带 patch 时由 host 自己取。stagedOnly=true = 只取 files 里那些(纳入提交的);
        // false = 全部工作区变更。判据与语义见 collectDiffText 的注释。
        diffText = await collectDiffText(deps.git, path, stagedOnly, files);
      }
      const choice: LlmModelChoice = { provider, model };
      return deps.llm.generate({
        path,
        diff: diffText,
        files,
        stagedOnly,
        choice,
        systemPrompt: str(body, 'systemPrompt'),
      });
    },

    // ---------- GitHub 登录 ----------
    // `auth/state` 与 `auth/pat` 都带 `endpoint`(多端点:企业实例):
    //  `auth/pat` 收端点(省略 ⇒ 沿用当前账号端点),`auth/state` 回当前端点。
    // 设备码流程**只支持 github.com**(理由见 `auth.ts` 文件头),
    // `auth/device-start` / `auth/device-poll` 因此不收端点参数。
    'auth/state': async () => deps.auth.state(),
    'auth/device-start': async () => deps.auth.startDeviceFlow(),
    'auth/device-poll': async (body) => deps.auth.pollDeviceFlow(str(body, 'deviceCode') ?? ''),
    'auth/pat': async (body) => deps.auth.setPat(str(body, 'token') ?? '', str(body, 'endpoint')),
    /**
     * 当前账号的邮箱列表(Author 邮箱下拉 + misattribution 告警)。
     *
     * 必须在 host 半:浏览器拿不到完整令牌,而 `GET /user/emails` 需要 `user:email` 权限。
     * 未登录 ⇒ `{ emails: [] }`(**不是错误**);无权限/网络错 ⇒ 可读错误。
     * 上游对照:`references/desktop/app/src/lib/api.ts:1081-1090` 的 `fetchEmails`
     * (上游在渲染进程直接调,我们只能借宿主令牌)。
     */
    'auth/emails': async () => deps.auth.accountEmails(),
    'auth/logout': async () => {
      await deps.auth.logout();
      return { ok: true };
    },

    // ---------- GitHub REST 代理(令牌留在 host) ----------
    'gh': async (body) => {
      const path = str(body, 'path');
      if (path === undefined) {
        throw new GitServiceError('bad-request', '缺少 GitHub 路径。');
      }
      const method = str(body, 'method') ?? 'GET';
      const accept = str(body, 'accept');
      const payload = body.body;
      try {
        const result = await deps.auth.ghProxy({
          method,
          path,
          ...(payload === undefined ? {} : { body: payload }),
          ...(accept !== undefined ? { accept } : {}),
        });
        return { status: result.status, json: result.json, link: result.link, remaining: result.remaining };
      } catch (error) {
        // GitHub 的 4xx 也要把 message 交给界面,而不是折成 internal。
        throw new GitServiceError('internal', error instanceof Error ? error.message : String(error));
      }
    },
    'gh/rate': async () => ({ remaining: deps.auth.rateRemaining() }),

    // ---------- 远程仓库列表(令牌在 host,不打浏览器) ----------
    'remote-repos': async (body) => {
      const force = bool(body, 'force');
      const repos = await deps.auth.listRemoteRepos(force);
      return { repos, hidden: deps.registry.hidden() };
    },
    'remote-repos/hide': async (body) => {
      const fullName = str(body, 'fullName');
      if (fullName === undefined) {
        throw new GitServiceError('bad-request', '缺少仓库名。');
      }
      await deps.registry.hideRemote(fullName);
      return { hidden: deps.registry.hidden() };
    },
    'remote-repos/unhide': async (body) => {
      await deps.registry.unhideRemote(str(body, 'fullName') ?? '');
      return { hidden: deps.registry.hidden() };
    },
  };

  /**
   * 写盘之后必须核对「真的落盘了吗」。
   *
   * 为什么:`RepoRegistry.persist()` **故意不把写失败抛出来**(它要保住内存态,
   * 让功能不中断)。这个设计对内存态是对的,但它让路由层**无法区分**
   * 「写成功」与「写失败」—— 于是 `prefs/set` 在磁盘满 / 权限变化时**照样回
   * `{ok:true}`**,客户端把界面切到新值、刷新后又弹回旧值。
   * 实测(真 HTTP + 真 client store,`scripts/probe-prefs-roundtrip.mjs` §11b):
   * 用一个 `set()` 必抛的 domain 打 `prefs/set` ⇒ 修前回 `{ok:true}`,
   * 而 `health` 同时报 `persistent:false` —— 两条通道自相矛盾。
   *
   * 现在**凡是等于「用户偏好」的写入**都过这道核对:失败就响亮报错,
   * 客户端据此回滚界面。清单等派生字段的写入仍走原路(它们会在下一次
   * 刷新时自愈,不该把一次瞬时失败弹给用户)。
   * @param context - 出错信息里的动作名(「保存设置」等)。
   */
  function assertPersisted(context: string): void {
    const status = deps.registry.storageStatus();
    if (status.persistent) {
      return;
    }
    throw new GitServiceError('internal', `${context}没有写入磁盘,重启后会丢失。${status.error ?? '存储不可用'}`);
  }

  return (request, response) => {
    void (async () => {
      if (!isLoopback(request)) {
        writeJson(response, { ok: false, error: { code: 'workspace-unknown', message: 'dsh-git 只允许本机访问。' } }, 403);
        return;
      }
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const route = url.pathname.startsWith(`${ROUTE_PREFIX}/`)
        ? url.pathname.slice(ROUTE_PREFIX.length + 1)
        : '';
      // 二进制端点**不套 JSON 信封**(JSON.stringify 的 `value` 会把字节变成
      // 数字数组或 base64),所以它在信封处理器之前分流。
      if (route === 'blob') {
        try {
          await serveBlob(deps, request, response);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log(`[dsh-git] blob 失败: ${message}`);
          failBlob(response, error);
        }
        return;
      }
      const handler = handlers[route];
      if (handler === undefined) {
        writeJson(response, { ok: false, error: { code: 'bad-request', message: `未知路由 ${route}` } }, 404);
        return;
      }
      try {
        const body = request.method === 'POST' ? await readJson(request) : {};
        const value = await handler(body);
        writeJson(response, { ok: true, value });
      } catch (error) {
        // 「未登录」是正常状态而不是故障:按 info 记。刷屏会淹没真正要看的
        // `已注册 /dsh-git/*` 与自检结果。
        const message = error instanceof Error ? error.message : String(error);
        const expected = error instanceof GitServiceError && error.code === 'not-signed-in';
        log(expected ? `[dsh-git] ${route}: ${message}` : `[dsh-git] ${route} 失败: ${message}`);
        fail(response, error);
      }
    })();
  };
}

function requirePath(body: Record<string, unknown>): string {
  const path = str(body, 'path');
  if (path === undefined) {
    throw new GitServiceError('bad-request', '缺少仓库路径。');
  }
  return path;
}

/**
 * 没带 patch 时由 host 取 diff 文本。
 *
 * **`stagedOnly` 的语义在这里换过一次,注释必须跟着改(否则就是「注释声称的行为
 * ≠ 代码实际行为」那种坑)**:
 *
 *  - 旧语义:按 git 索引的 `staged` 位过滤(`if (stagedOnly && !staged) continue`)。
 *    那是「两行制(已暂存/未暂存分组)」时代的模型 —— 勾选会真的写索引。
 *  - 现状:`src/client/changes-view.tsx` 的勾选**只改客户端模型**
 *    (`includeState`),索引只在 `commit()` 那一刻 materialize
 *    (见 `docs/goal-port-desktop.md` §11.4 的人类裁决)。于是 `file.staged`
 *    与「用户纳入提交了什么」**没有关系** —— 旧判据恒筛出 0 个文件,
 *    客户端因此长期硬编码 `stagedOnly: false` 绕过它,那个偏好也就成了死设置。
 *  - 新语义:`stagedOnly=true` ⇒ 只取**调用方给的纳入文件清单**;
 *    `stagedOnly=false` ⇒ 取全部工作区变更。判据从「索引位」换成「文件清单」。
 *
 * `file.staged !== undefined` 仍然保留 —— 它现在**不是过滤条件,而是取 diff 的方向**:
 * 文件已进索引时按 `git diff --cached` 取(否则对已暂存文件会得到空 patch)。
 *
 * @param git - git 服务。
 * @param path - 仓库根。
 * @param stagedOnly - true = 只依据纳入提交的变更。
 * @param files - 纳入提交的文件路径;stagedOnly=true 时必填(空数组是调用方的 bug)。
 */
async function collectDiffText(
  git: GitService,
  path: string,
  stagedOnly: boolean,
  files: readonly string[],
): Promise<string> {
  const status = await git.status(path);
  const targets = stagedOnly
    ? status.files.filter((f) => files.includes(f.path))
    : (files.length > 0 ? status.files.filter((f) => files.includes(f.path)) : status.files);
  const parts: string[] = [];
  for (const file of targets.slice(0, 40)) {
    const staged = file.staged !== undefined;
    const diff = await git.diff({
      path,
      file: file.path,
      ...(staged ? { staged: true } : {}),
      ...(file.untracked === true ? { untracked: true } : {}),
    });
    parts.push(`### ${file.path}\n${diff.patch}`);
  }
  return parts.join('\n');
}

/** 供 add 路由复用的远程缓存形状。 */
export type { RemoteRepoLite };
