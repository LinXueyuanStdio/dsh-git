/**
 * GitHub REST v3 客户端:浏览器直连 api.github.com(CORS 开放),
 * Bearer PAT 鉴权、限流/错误归一为中文可操作提示,全部端点类型化。
 */

import { qs, decodeBase64Utf8, parseLinkNext, parseGithubUrl, chunkRepoQualifiers, type GhRef, ghRefKey } from '../core/lib.ts';
import { narrowed, reportDiagnostic } from './payload.ts';
import type { Shape } from './payload.ts';

const API = 'https://api.github.com';
/** 兼容保留:令牌已迁到 host,浏览器不再保存。 */

/**
 * 令牌由 host 持有,浏览器不再保存它;这两个函数保留为兼容空操作
 * (移植来的视图会调用 setToken,这里只作缓存失效)。
 */
export function getToken(): string {
  return '';
}
export function setToken(token: string): void {
  repoCache = null;
  viewerCache = undefined;
  if (token === '') return;
}

let lastRemaining: number | null = null;
/** 最近一次响应的 core 限额剩余(页脚展示)。 */
export function rateRemaining(): number | null { return lastRemaining; }

export class GhError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'GhError';
    this.status = status;
  }
}

interface GhOpts {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** 覆盖 Accept(如 check-runs 的预览头)。 */
  accept?: string;
}

interface GhResponse {
  status: number;
  json: unknown;
  link: string | null;
}

/** `gh` 路由信封里 `value` 的形状(host 回 `{status, json, link, remaining}`)。 */
interface IGhProxyPayload {
  readonly status: number;
  readonly json: unknown;
  readonly link: string | null;
  readonly remaining: number | null;
}

/**
 * `gh` 代理载荷的形状说明。
 *
 * `json` **不列**:它是 GitHub REST 的**上游契约**(议题/PR/树的形状由 GitHub 定,
 * 逐条写 schema 会变成第二份真源),这里只保证「代理信封本身」的形状
 * (`status` 是数字、`json` 存在与否由调用方各自按上游语义处理)。
 * `link` / `remaining` 老 host 可能不返回 ⇒ 可缺省。
 */
const GH_PROXY_SHAPE: Shape = {
  record: { status: 'number', link: 'string|null?', remaining: 'number|null?' },
};

/**
 * 经 host 代理发一次 GitHub REST 调用。
 * 令牌只存在 host(浏览器不接触),顺带绕开 CORS 与匿名限额;
 * host 侧已把 401/403/404/422 归一成中文 message。
 */
async function ghRequest(path: string, opts: GhOpts = {}): Promise<GhResponse> {
  const payload: Record<string, unknown> = {
    path,
    method: opts.method ?? 'GET',
  };
  if (opts.accept !== undefined) payload.accept = opts.accept;
  if (opts.body !== undefined) payload.body = opts.body;

  let res: Response;
  try {
    res = await fetch('dsh-git/gh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new GhError('无法连接 dsh-git 服务(host 侧未激活?)', 0);
  }
  let envelope: unknown;
  try {
    envelope = await res.json();
  } catch {
    throw new GhError(`dsh-git 代理返回了非 JSON 响应(HTTP ${res.status})`, res.status);
  }
  if (typeof envelope !== 'object' || envelope === null) throw new GhError('dsh-git 代理响应异常', res.status);
  const record = envelope as Record<string, unknown>;
  if (record.ok !== true) {
    const error = record.error as { message?: string; code?: string } | undefined;
    throw new GhError(error?.message ?? 'GitHub 请求失败', res.status);
  }
  /*
   * ⚠️ **`value` 也要收窄**(2026-10,与 `api.ts` 的 `SHAPES` 同一族缺陷):
   * 原来这里是 `record.value as {...}` —— 一个**无检查的 cast**。`value` 是 `{}` 时
   * `status`/`json` 都是 `undefined`,于是 `gh<T>()` 把 `undefined` 当 GitHub 的 JSON
   * 交给上层,每个远端视图(Code / Issues / Pull requests / Actions)在 `.map` 上炸掉。
   * 现在形状不对就**抛** GhError:上层视图本来就在 `try/catch` 里按「请求失败」渲染,
   * 不会把畸形数据当成空数据。
   */
  const checked = narrowed<IGhProxyPayload>(record.value, GH_PROXY_SHAPE);
  if (!checked.ok) {
    reportDiagnostic('载荷被拒', 'gh', checked.message);
    throw new GhError(`dsh-git 代理回的${checked.message}`, res.status);
  }
  const value = checked.value;
  lastRemaining = value.remaining ?? lastRemaining;
  return { status: value.status, json: value.json, link: value.link ?? null };
}

/**
 * 一次调用只取 JSON 本体。
 *
 * ## 这两个函数是「遗漏了」,不是「esbuild 注入的全局」
 *
 * 本文件是从 `dsh-github-workbench` 整体复制的(`docs/design.md:420`:
 * 「`gh-api.ts`(← `api.ts`,**仅替换 `ghRequest` 传输层为 host 代理**)」)——
 * 也就是说那次改动的**唯一**意图是换传输层,`gh` / `ghList` 本该原样带过来。
 * 但复制时它们丢了:全仓库只剩 16 处 `gh(...)` + 2 处 `ghList(...)` 调用,
 * 没有任何定义,于是每一个远端视图(Code/Issues/Pull requests/Actions)在运行期
 * 都是 `ReferenceError: ghList is not defined`(`lib/client.js` 里实测同样只有调用、
 * 没有定义)。esbuild **不做标识符检查**,所以构建一直是绿的。
 *
 * 判断依据(为什么不是 `build.mjs` 的 `inject`):
 *   - `clientInject` 只列了 `src/client/desktop-globals.ts`,它导出的名字是
 *     `__DEV__`/`__DARWIN__`/`__WIN32__`/`__LINUX__`/`__dirname` —— 没有 `gh`;
 *   - `inject` 是「把自由标识符换成模块的同名导出」,注入一个**函数**是可能的,
 *     但那样注入源必须存在,而仓库里没有任何模块导出 `gh`/`ghList`;
 *   - 反证更直接:`ghRequest`(下面这个函数)与 `parseLinkNext`(文件顶部 import)
 *     在丢失之后**双双变成未使用**——它们唯一的使用者就是这两个包装。
 *
 * 参考实现是上游原件(同一份代码在
 * `~/.dsh/profiles/desktop/node_modules/dsh-github-workbench/lib/client.js`):
 *
 * ```js
 * async function gh(path, opts = {}) { const r = await ghRequest(path, opts); return r.json }
 * async function ghList(path, opts = {}) {
 *   const r = await ghRequest(path, opts)
 *   return { data: r.json, nextUrl: parseLinkNext(r.link) }
 * }
 * ```
 *
 * 这里逐行沿用,只补上泛型/返回类型。`nextUrl` 是 `Link` 头里 rel=next 的
 * **绝对 URL**,而 host 的代理明确接受它(`host/auth.ts` 的 `ghProxy`:
 * `input.path.startsWith('http') ? input.path : GITHUB_API + input.path`),
 * 所以 `getMyRepos()` 的翻页把 `nextUrl` 原样回传是成立的。
 * @param path - `/repos/...` 这样的 API 路径,或上一页 `nextUrl` 的绝对 URL。
 * @param opts - 方法 / body / 覆盖 Accept。
 */
async function gh<T>(path: string, opts: GhOpts = {}): Promise<T> {
  const r = await ghRequest(path, opts);
  return r.json as T;
}

/** 分页列表:本页数据 + `Link: rel=next`(`null` = 没有下一页)。 */
async function ghList<T>(path: string, opts: GhOpts = {}): Promise<{ data: T; nextUrl: string | null }> {
  const r = await ghRequest(path, opts);
  return { data: r.json as T, nextUrl: parseLinkNext(r.link) };
}

export interface GhUser { login: string }
export interface GhLabel { name: string; color: string }
export interface GhIssue {
  number: number; title: string; state: 'open' | 'closed'; html_url: string;
  user: GhUser | null; created_at: string; updated_at: string; closed_at: string | null;
  comments: number; labels: GhLabel[]; body: string | null; pull_url?: string;
  pull_request?: unknown;
}
export interface GhComment {
  id: number; user: GhUser | null; body: string; created_at: string; html_url: string;
}
export interface GhPull {
  number: number; title: string; state: 'open' | 'closed'; html_url: string; draft: boolean;
  user: GhUser | null; created_at: string; updated_at: string;
  head: { ref: string; label: string; sha: string };
  base: { ref: string; label: string }; body: string | null;
  merged_at?: string | null;
  additions?: number; deletions?: number; changed_files?: number;
  mergeable?: boolean | null; mergeable_state?: string;
}

export type ListSort = 'created' | 'updated';
export type IssueState = 'open' | 'closed';
export type PullFilter = 'open' | 'closed' | 'merged';

/** 一页列表:items 是本页,nextUrl 有值就能「加载更多」,totalCount 是仓库真实总数(Search 或并行计数)。 */
export interface ListPage<T> {
  items: T[];
  nextUrl: string | null;
  totalCount: number | null;
}
export interface GhCheckRun {
  id: number; name: string | null; status: string; conclusion: string | null; html_url: string;
}
export interface GhRun {
  id: number; name: string | null; display_title: string; status: string; conclusion: string | null;
  event: string; head_branch: string; html_url: string;
  created_at: string; updated_at: string; run_attempt: number;
  actor: GhUser | null;
}
export interface RepoMeta {
  fullName: string; description: string | null; defaultBranch: string;
  isPrivate: boolean; stars: number; htmlUrl: string;
}
export interface BranchLite { name: string }

// ---------- 读 ----------

interface RawRepo { full_name: string; description: string | null; default_branch: string; private: boolean; stargazers_count: number; html_url: string }

export async function getRepoMeta(ref: GhRef): Promise<RepoMeta> {
  const r = await gh<RawRepo>(`/repos/${ghRefKey(ref)}`);
  return {
    fullName: r.full_name, description: r.description, defaultBranch: r.default_branch,
    isPrivate: r.private, stars: r.stargazers_count, htmlUrl: r.html_url,
  };
}

export async function getBranches(ref: GhRef): Promise<BranchLite[]> {
  const arr = await gh<{ name: string }[]>(`/repos/${ghRefKey(ref)}/branches${qs({ per_page: 50 })}`);
  return arr.map((b) => ({ name: b.name }));
}

interface RawTree { tree: { path: string; type: 'blob' | 'tree'; size?: number }[]; truncated: boolean }

export async function getTree(ref: GhRef, branch: string): Promise<{ items: { path: string; type: 'blob' | 'tree'; size?: number }[]; truncated: boolean }> {
  const r = await gh<RawTree>(`/repos/${ghRefKey(ref)}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
  return { items: r.tree.filter((t) => t.type === 'blob' || t.type === 'tree'), truncated: r.truncated };
}

export interface ContentResult {
  kind: 'text' | 'binary' | 'too-big';
  text?: string; size: number; truncatedLines?: boolean; htmlUrl: string;
}

const MAX_INLINE = 900_000;
const MAX_LINES = 3000;

export async function getFileContent(ref: GhRef, path: string, branch: string): Promise<ContentResult> {
  const raw = await gh<{ name: string; size: number; encoding?: string; content?: string; html_url: string }>(
    `/repos/${ghRefKey(ref)}/contents/${path.split('/').map(encodeURIComponent).join('/')}${qs({ ref: branch })}`);
  if (raw.size > MAX_INLINE || raw.encoding !== 'base64' || typeof raw.content !== 'string') {
    return { kind: raw.size > MAX_INLINE ? 'too-big' : 'binary', size: raw.size, htmlUrl: raw.html_url };
  }
  const full = decodeBase64Utf8(raw.content);
  const lines = full.split('\n');
  return {
    kind: 'text', size: raw.size, htmlUrl: raw.html_url,
    text: lines.length > MAX_LINES ? lines.slice(0, MAX_LINES).join('\n') : full,
    truncatedLines: lines.length > MAX_LINES,
  };
}

const PAGE = 30;

function searchQ(parts: string[]): string {
  return parts.filter(Boolean).join(' ');
}

function searchIssueToGh(it: SearchIssue): GhIssue {
  return {
    number: it.number,
    title: it.title,
    state: it.state,
    html_url: it.html_url,
    user: it.user,
    created_at: it.created_at,
    updated_at: it.updated_at,
    closed_at: it.closed_at,
    comments: it.comments ?? 0,
    labels: it.labels ?? [],
    body: it.body,
    pull_request: it.pull_request,
  };
}

function searchIssueToPull(it: SearchIssue): GhPull {
  const pr = it.pull_request;
  return {
    number: it.number,
    title: it.title,
    state: it.state,
    html_url: it.html_url.replace('/issues/', '/pull/'),
    draft: it.draft === true,
    user: it.user,
    created_at: it.created_at,
    updated_at: it.updated_at,
    head: { ref: '', label: '', sha: '' },
    base: { ref: '', label: '' },
    body: it.body,
    merged_at: pr && typeof pr === 'object' && pr !== null && 'merged_at' in pr
      ? (pr as { merged_at?: string | null }).merged_at ?? null
      : null,
  };
}

interface SearchIssue {
  number: number; title: string; state: 'open' | 'closed'; html_url: string;
  user: GhUser | null; created_at: string; updated_at: string; closed_at: string | null;
  comments: number; labels: GhLabel[]; body: string | null; pull_request?: { url?: string; merged_at?: string | null } | unknown;
  draft?: boolean;
}

interface SearchPayload { total_count: number; incomplete_results?: boolean; items: SearchIssue[] }

function pageFromUrl(url: string | undefined, fallback = 1): number {
  if (!url) return fallback;
  try {
    const n = Number(new URL(url, API).searchParams.get('page') ?? String(fallback));
    return Number.isFinite(n) && n > 0 ? n : fallback;
  } catch {
    return fallback;
  }
}

async function searchPage(q: string, sort: ListSort, pageUrl?: string): Promise<{ items: SearchIssue[]; nextUrl: string | null; totalCount: number }> {
  const pageNum = pageFromUrl(pageUrl, 1);
  const path = `/search/issues${qs({ q, sort, order: 'desc', per_page: PAGE, page: pageNum })}`;
  const { data } = await ghList<SearchPayload>(path);
  const items = data.items ?? [];
  const total = data.total_count ?? 0;
  const cap = Math.min(total, 1000);
  const nextUrl = items.length > 0 && pageNum * PAGE < cap
    ? `/search/issues${qs({ q, sort, order: 'desc', per_page: PAGE, page: pageNum + 1 })}`
    : null;
  return { items, nextUrl, totalCount: total };
}

/** Issues 列表:Search API `is:issue`,不被 PR 占坑;默认按创建时间(网页 Newest)。 */
export async function listIssues(
  ref: GhRef,
  state: IssueState = 'open',
  sort: ListSort = 'created',
  pageUrl?: string,
): Promise<ListPage<GhIssue>> {
  const q = searchQ([`repo:${ghRefKey(ref)}`, 'is:issue', `is:${state}`]);
  const page = await searchPage(q, sort, pageUrl);
  return { items: page.items.map(searchIssueToGh), nextUrl: page.nextUrl, totalCount: page.totalCount };
}

export async function getIssue(ref: GhRef, n: number): Promise<GhIssue> {
  return gh<GhIssue>(`/repos/${ghRefKey(ref)}/issues/${n}`);
}

export async function listComments(ref: GhRef, n: number, pageUrl?: string): Promise<ListPage<GhComment>> {
  const pageNum = pageFromUrl(pageUrl, 1);
  const path = `/repos/${ghRefKey(ref)}/issues/${n}/comments${qs({ per_page: 60, page: pageNum })}`;
  const { data, nextUrl } = await ghList<GhComment[]>(path);
  const computed = data.length >= 60
    ? `/repos/${ghRefKey(ref)}/issues/${n}/comments${qs({ per_page: 60, page: pageNum + 1 })}`
    : null;
  return { items: data, nextUrl: data.length === 0 ? null : (nextUrl ?? computed), totalCount: null };
}

/** PR 列表:Search `is:pr`(+ is:unmerged / is:merged),closed 与 merged 分开;默认 Newest。 */
export async function listPulls(
  ref: GhRef,
  filter: PullFilter = 'open',
  sort: ListSort = 'created',
  pageUrl?: string,
): Promise<ListPage<GhPull>> {
  const extra = filter === 'merged' ? 'is:merged' : filter === 'closed' ? 'is:closed is:unmerged' : 'is:open';
  const q = searchQ([`repo:${ghRefKey(ref)}`, 'is:pr', extra]);
  const page = await searchPage(q, sort, pageUrl);
  return { items: page.items.map(searchIssueToPull), nextUrl: page.nextUrl, totalCount: page.totalCount };
}

export async function getPull(ref: GhRef, n: number): Promise<GhPull> {
  return gh<GhPull>(`/repos/${ghRefKey(ref)}/pulls/${n}`);
}

export async function listCheckRuns(ref: GhRef, sha: string): Promise<GhCheckRun[]> {
  const r = await gh<{ check_runs: GhCheckRun[] }>(`/repos/${ghRefKey(ref)}/commits/${sha}/check-runs?per_page=50`);
  return r.check_runs;
}

export async function listRuns(ref: GhRef): Promise<GhRun[]> {
  const r = await gh<{ workflow_runs: GhRun[] }>(`/repos/${ghRefKey(ref)}/actions/runs?per_page=20`);
  return r.workflow_runs;
}

// ---------- 自动拉取当前身份可见的仓库 ----------

export interface RepoLite {
  fullName: string;
  isPrivate: boolean;
  pushedAt: string;
  description: string | null;
  /** 仓库所有者登录名(判断"非本人的仓库"用)。 */
  ownerLogin: string;
}

interface RawUserRepo {
  full_name: string; private: boolean; pushed_at: string;
  description: string | null; fork: boolean; archived: boolean;
  owner: { login: string };
}

let repoCache: { at: number; data: RepoLite[]; truncated: boolean } | null = null;
const REPO_CACHE_TTL = 5 * 60_000;
const REPO_PAGE_CAP = 3;
const REPO_HARD_CAP = 300;

/** 当前 Token 可见的全部仓库(owner + 协作 + 组织成员),按最近推送排序;5 分钟缓存。跟分页,硬顶 300。 */
export async function getMyRepos(force = false): Promise<RepoLite[]> {
  if (!force && repoCache && Date.now() - repoCache.at < REPO_CACHE_TTL) return repoCache.data;
  const data: RepoLite[] = [];
  let path: string | null = '/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member';
  let pages = 0;
  let truncated = false;
  while (path && pages < REPO_PAGE_CAP) {
    const page: { data: RawUserRepo[]; nextUrl: string | null } = await ghList<RawUserRepo[]>(path);
    pages += 1;
    for (const r of page.data) {
      if (r.archived) continue;
      data.push({
        fullName: r.full_name, isPrivate: r.private, pushedAt: r.pushed_at,
        description: r.description, ownerLogin: r.owner?.login ?? '',
      });
    }
    path = page.nextUrl;
    if (path && pages >= REPO_PAGE_CAP) truncated = true;
  }
  data.sort((a, b) => b.pushedAt.localeCompare(a.pushedAt));
  if (data.length > REPO_HARD_CAP) {
    data.length = REPO_HARD_CAP;
    truncated = true;
  }
  repoCache = { at: Date.now(), data, truncated };
  return data;
}

/** 最近一次 getMyRepos 是否因 300 顶而截断。 */
export function myReposTruncated(): boolean {
  return repoCache?.truncated ?? false;
}

export interface GhSearchRepo {
  fullName: string;
  stars: number;
  description: string | null;
}

let searchSeq = 0;

/** 按名称搜索任意公开仓库(search API,限流 30 次/分;带 450ms 去抖由 UI 层负责)。 */
export async function searchPublicRepos(q: string): Promise<GhSearchRepo[]> {
  const seq = ++searchSeq;
  const r = await gh<{ items: { full_name: string; stargazers_count: number; description: string | null }[] }>(
    `/search/repositories${qs({ q: `${q} in:name`, per_page: 8, sort: 'stars' })}`);
  if (seq !== searchSeq) return []; // 过期响应丢弃
  return r.items.map((i) => ({ fullName: i.full_name, stars: i.stargazers_count, description: i.description }));
}

/** 清空仓库列表缓存(token 变更后调用)。 */
export function invalidateRepoCache(): void { repoCache = null; }

// ---------- 收件箱:跨仓新建 Issue/PR(一次 Search 再拆 kind) ----------

export type InboxHitKind = 'issue' | 'pr';

export interface InboxSearchHit {
  kind: InboxHitKind;
  owner: string;
  repo: string;
  number: number;
  title: string;
  htmlUrl: string;
  user: string;
  createdAt: string;
}

const INBOX_SEARCH_MAX_Q = 6;

function inboxSearchPrefix(createdSinceIso: string, viewer: string | null): string[] {
  const iso = createdSinceIso.replace(/\.\d{3}Z$/, 'Z');
  // 不写 is:issue / is:pr:Search /issues 同时返回两者,用 pull_request 字段拆开,省一轮配额。
  const parts = ['is:public', 'is:open', `created:>=${iso}`];
  if (viewer) parts.push(`-author:${viewer}`);
  return parts;
}

/**
 * 监视集里 created>=watermark 的公开 Issue 与新建 PR。
 * 优先 user:/org: 少打 Search,剩余 repo: OR 切批;每轮最多 6 次查询。
 */
export async function searchInboxCreatedSince(
  repos: readonly string[],
  createdSinceIso: string,
  viewer: string | null,
): Promise<{ hits: InboxSearchHit[]; queryTruncated: boolean }> {
  const prefix = inboxSearchPrefix(createdSinceIso, viewer);
  const leftover = new Set(repos.filter(Boolean));
  const queries: string[] = [];

  if (viewer) {
    queries.push(searchQ([...prefix, `user:${viewer}`]));
    for (const r of leftover) {
      if (r.startsWith(`${viewer}/`)) leftover.delete(r);
    }
  }

  const otherOwners = new Map<string, string[]>();
  for (const r of leftover) {
    const owner = r.split('/')[0] ?? '';
    const list = otherOwners.get(owner) ?? [];
    list.push(r);
    otherOwners.set(owner, list);
  }
  const orgOwners = [...otherOwners.entries()]
    .filter(([, list]) => list.length >= 2)
    .map(([owner]) => owner);

  for (const org of orgOwners) {
    if (queries.length >= INBOX_SEARCH_MAX_Q) break;
    queries.push(searchQ([...prefix, `org:${org}`]));
    for (const r of otherOwners.get(org) ?? []) leftover.delete(r);
  }

  for (const chunk of chunkRepoQualifiers([...leftover], 220)) {
    if (queries.length >= INBOX_SEARCH_MAX_Q) break;
    const orPart = chunk.map((n) => `repo:${n}`).join(' OR ');
    queries.push(searchQ([...prefix, `(${orPart})`]));
    for (const n of chunk) leftover.delete(n);
  }

  const hits: InboxSearchHit[] = [];
  const seen = new Set<string>();
  for (const q of queries) {
    const page = await searchPage(q, 'created');
    for (const it of page.items) {
      if (it.created_at < createdSinceIso) continue;
      const parsed = parseGithubUrl(it.html_url);
      if (!parsed) continue;
      const kind: InboxHitKind = it.pull_request ? 'pr' : 'issue';
      const key = `${kind}:${parsed.ref.owner}/${parsed.ref.repo}#${it.number}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const htmlUrl = kind === 'pr'
        ? it.html_url.replace('/issues/', '/pull/')
        : it.html_url;
      hits.push({
        kind,
        owner: parsed.ref.owner,
        repo: parsed.ref.repo,
        number: it.number,
        title: it.title,
        htmlUrl,
        user: it.user?.login ?? 'ghost',
        createdAt: it.created_at,
      });
    }
  }
  return { hits, queryTruncated: leftover.size > 0 };
}

/** 某仓 created>=since 的 workflow runs(Actions 无跨仓 Search,调用方限制仓数)。 */
export async function listRunsCreatedSince(ref: GhRef, sinceIso: string): Promise<GhRun[]> {
  const arr = await listRuns(ref);
  return arr.filter((r) => r.created_at >= sinceIso);
}

// ---------- 写(v0.1;破坏性动作由 UI 层二次确认后调用) ----------

export async function createIssue(ref: GhRef, title: string, body: string): Promise<GhIssue> {
  return gh<GhIssue>(`/repos/${ghRefKey(ref)}/issues`, { method: 'POST', body: { title, body } });
}

export async function patchIssue(ref: GhRef, n: number, patch: { title?: string; body?: string; state?: 'open' | 'closed' }): Promise<void> {
  await gh(`/repos/${ghRefKey(ref)}/issues/${n}`, { method: 'PATCH', body: patch });
}

export async function addComment(ref: GhRef, n: number, body: string): Promise<void> {
  await gh(`/repos/${ghRefKey(ref)}/issues/${n}/comments`, { method: 'POST', body: { body } });
}

export async function editComment(ref: GhRef, commentId: number, body: string): Promise<void> {
  await gh(`/repos/${ghRefKey(ref)}/issues/comments/${commentId}`, { method: 'PATCH', body: { body } });
}

export async function deleteComment(ref: GhRef, commentId: number): Promise<void> {
  await gh(`/repos/${ghRefKey(ref)}/issues/comments/${commentId}`, { method: 'DELETE' });
}

export async function createPull(ref: GhRef, p: { title: string; body: string; head: string; base: string }): Promise<GhPull> {
  return gh<GhPull>(`/repos/${ghRefKey(ref)}/pulls`, { method: 'POST', body: p });
}

export async function mergePull(ref: GhRef, n: number, method: 'merge' | 'squash' | 'rebase'): Promise<void> {
  await gh(`/repos/${ghRefKey(ref)}/pulls/${n}/merge`, { method: 'PUT', body: { merge_method: method } });
}

export async function rerunRun(ref: GhRef, runId: number): Promise<void> {
  await gh(`/repos/${ghRefKey(ref)}/actions/runs/${runId}/rerun`, { method: 'POST' });
}

export async function cancelRun(ref: GhRef, runId: number): Promise<void> {
  await gh(`/repos/${ghRefKey(ref)}/actions/runs/${runId}/cancel`, { method: 'POST' });
}

/** 当前鉴权身份(评论删除按钮的归属判断用;结果缓存)。 */
let viewerCache: string | null | undefined;
export async function getViewerLogin(): Promise<string | null> {
  if (viewerCache !== undefined) return viewerCache;
  try {
    const u = await gh<GhUser>('/user');
    viewerCache = u.login;
  } catch {
    viewerCache = null;
  }
  return viewerCache;
}
