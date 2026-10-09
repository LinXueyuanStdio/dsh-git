/**
 * /dsh-git/* 客户端:同源相对路径 fetch(harness 的 GUI 用 <base href="./">,
 * 子路径部署也解析得到,根绝对路径会逃出前缀),信封解包为 ApiResult。
 * @module dsh-git/client/api
 */

import type {
  BranchEntry, ClonePathKind, CommitDetail, CommitEntry, DiffResult, GitError, RepoEntry, RepoStatus, SyncProgressPayload, SyncState,
} from '../core/types.ts';
import { MAX_BLOB_BYTES, isTextContentType } from '../core/blob.ts';
import { payloadError, noteNormalized, narrowed } from './payload.ts';
import type { Shape } from './payload.ts';

/** 路由前缀(相对,不带前导斜杠)。 */
const BASE = 'dsh-git';

export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: GitError };

/**
 * `prefs/set` 的载荷 / `prefs/get` 的回显形状 —— **宿主侧 `PrefsPatch` 的客户端副本**
 * (`src/host/repo-registry.ts`,那边是存储域的形状;两边逐字段对齐)。
 *
 * 这里**不能 import** 宿主那份:那会把 `src/host/**` 拉进浏览器包(host 半用 node)。
 * 契约由 `scripts/check-integration.mjs` 与探针两侧核对。
 *
 * | 这里的键 | 谁在用 |
 * |---|---|
 * | `model` / `stagedOnly` / `systemPrompt` | 生成偏好(`store.ts` 的 `setModelPersisted` 等) |
 * | `hooksEnvEnabled` / `cacheHooksEnv` / `hookEnvShell` | Hooks 环境偏好(镜像的三个 localStorage 键) |
 *
 * 用 `type` 而不是 `interface` 是**必须的**:`call()` 的载荷参数是
 * `Record<string, unknown>`,而 TS 只给**类型别名**隐式索引签名(`interface` 没有)
 * ⇒ 写成 interface 会在这里多出一条 TS2345。
 */
export type PrefsPatch = {
  model?: string;
  stagedOnly?: boolean;
  systemPrompt?: string;
  /**
   * Hooks:是否把用户 shell 的环境注入 git 子进程。
   *
   * 客户端那一半是镜像 `lib/hooks/config.ts` 的 `localStorage['git-hooks-env-enabled']`;
   * 这一半由 `src/client/git-page.tsx` 在同一个回调里补推(浏览器与宿主是两个进程,
   * localStorage 到不了宿主)。
   */
  hooksEnvEnabled?: boolean;
  /** Hooks:环境是否缓存(镜像键 `git-cache-hooks-env`,默认 true)。 */
  cacheHooksEnv?: boolean;
  /** Hooks:用哪个 shell(镜像键 `git-hook-env-shell`;**枚举** `git-bash`/`pwsh`/`powershell`/`cmd`)。 */
  hookEnvShell?: string;
};

const TRANSPORT: GitError = { code: 'internal', message: '无法连接到 dsh-git 服务,请确认插件已在 host 侧激活。' };

// ---------- 原始字节端点(/dsh-git/blob) ----------
//
// 为什么不复用上面的 `call()`:那条路把响应当 JSON 信封解包,内容只能以 base64
// 字符串的形式穿过去(膨胀 33%、整份进 JS 字符串、没有 Range、没有缓存语义)。
// 内容是**字节**,所以这里直接拿 `Response`。

/**
 * blob 路由给自己打的标记头。
 *
 * 为什么需要:老 host(host 半不热重载)对未知路由回 **404 + JSON 信封**,
 * 而「这个版本里没有这个文件」也是 404 —— 只看状态码分不开。带上这个头以后,
 * **没有它 = 这个 host 还没有 blob 路由**(客户端据此走 base64 兜底),
 * 有它才按状态码解释。
 */
const BLOB_MARKER = 'x-dsh-git-blob';

/** 首段探测的字节数:先拿 8KB 判断文本/二进制并读出总长,再决定要不要继续取。 */
const BLOB_PROBE_BYTES = 8 * 1024;

/**
 * 一条 blob 请求的 URL(**相对路径**)。
 *
 * 相对是必需的:harness 的 GUI 用 `<base href="./">`,子路径部署时绝对路径会逃出前缀
 * (与 `call()` 同一条理由)。`<img src>` 拿这个字符串也能正确解析。
 * @param repoPath - 仓库绝对路径。
 * @param rev - 修订;`undefined` = 工作区磁盘,`'index'` = 索引。
 * @param file - 仓库内相对路径。
 */
export function blobUrl(repoPath: string, rev: string | undefined, file: string): string {
  const params = new URLSearchParams();
  params.set('path', repoPath);
  if (rev !== undefined && rev !== '') {
    params.set('rev', rev);
  }
  params.set('file', file);
  return `${BASE}/blob?${params.toString()}`;
}

/** `blob` 的元数据(HEAD 的结果)。 */
export type BlobHeadResult =
  | {
    ok: true;
    /** 实体总字节数。 */
    size: number;
    contentType: string;
    etag: string;
    /** true ⇒ 响应可在本地无限期缓存(完整 sha 的内容)。 */
    immutable: boolean;
  }
  | {
    ok: false;
    /**
     * `missing` 这个版本里没有该路径;`too-big` 超过单次上限(带真实大小与上限);
     * `unavailable` 这个 host 没有 blob 路由(老构建,需重启应用)/ 网络不通;
     * `error` 其它。
     */
    reason: 'missing' | 'too-big' | 'unavailable' | 'error';
    message: string;
    size?: number;
    limit?: number;
  };

/** 从响应头里读真实总长度(优先 `x-dsh-git-size`,其次 `Content-Range`)。 */
function totalSizeOf(response: Response): number | null {
  const marked = response.headers.get('x-dsh-git-size');
  if (marked !== null && marked !== '') {
    const value = Number(marked);
    if (Number.isFinite(value)) {
      return value;
    }
  }
  const contentRange = response.headers.get('content-range');
  if (contentRange !== null) {
    const match = /\/(\d+)\s*$/.exec(contentRange);
    if (match !== null) {
      return Number(match[1]);
    }
  }
  const length = response.headers.get('content-length');
  if (length !== null && length !== '') {
    const value = Number(length);
    if (Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

/**
 * 只问元数据(`HEAD`)。
 *
 * 用途:图片路径**先量后画** —— 超过上限时界面能说「3.2 MB,上限 2 MB」,
 * 而不是画一张裂图;也是「这个 host 有没有 blob 路由」的探针。
 * @param repoPath - 仓库绝对路径。
 * @param rev - 修订(见 {@link blobUrl})。
 * @param file - 仓库内相对路径。
 */
export async function blobHead(repoPath: string, rev: string | undefined, file: string): Promise<BlobHeadResult> {
  let response: Response;
  try {
    response = await fetch(blobUrl(repoPath, rev, file), { method: 'HEAD' });
  } catch {
    return { ok: false, reason: 'unavailable', message: TRANSPORT.message };
  }
  if (!response.headers.has(BLOB_MARKER)) {
    return {
      ok: false,
      reason: 'unavailable',
      message: '当前 host 还没有 blob 路由(host 半不热重载,需要重启 DSH Desktop)。',
    };
  }
  if (response.status === 404) {
    return { ok: false, reason: 'missing', message: '这个版本里没有这个文件。' };
  }
  if (response.status === 413) {
    const size = Number(response.headers.get('x-dsh-git-size') ?? '0');
    const limit = Number(response.headers.get('x-dsh-git-limit') ?? String(MAX_BLOB_BYTES));
    return {
      ok: false,
      reason: 'too-big',
      message: `超过单次上限(${Math.round(limit / 1024 / 1024)} MB)。`,
      size: Number.isFinite(size) ? size : 0,
      limit: Number.isFinite(limit) ? limit : MAX_BLOB_BYTES,
    };
  }
  if (response.status !== 200 && response.status !== 206) {
    return { ok: false, reason: 'error', message: `blob 返回 HTTP ${response.status}。` };
  }
  const size = totalSizeOf(response);
  if (size === null) {
    return { ok: false, reason: 'error', message: 'blob 响应没有长度信息。' };
  }
  return {
    ok: true,
    size,
    contentType: response.headers.get('content-type') ?? 'application/octet-stream',
    etag: response.headers.get('etag') ?? '',
    immutable: (response.headers.get('cache-control') ?? '').includes('immutable'),
  };
}

/**
 * 一次「取文本头部」的结果。
 *
 * 为什么是**三态**而不是 `T | null`:`null` 会把两件完全不同的事混在一起 ——
 * 「这台 host 没有 blob 路由(要退回 JSON 兜底)」与「这内容根本不是文本(兜底也没用)」。
 * 混在一起的代价是**每个二进制文件都白跑一次 JSON 请求**,而且「走了哪条路」在
 * 调用方看不出来。
 */
export type BlobBytesResult =
  | {
    readonly kind: 'text';
    readonly bytes: Uint8Array;
    /** 实体总字节数(不是拿到多少)。 */
    readonly total: number;
    /** true ⇒ `bytes` 只是**头部**(文件比拿到的多)。 */
    readonly truncated: boolean;
    readonly contentType: string;
    readonly etag: string;
  }
  /** 内容不是文本(`Content-Type` 判的):不要再试 JSON 兜底。 */
  | { readonly kind: 'binary' }
  /** 这条路不可用(老 host 没有 blob 路由 / 网络失败 / 读不到)⇒ 调用方走 JSON 兜底。 */
  | { readonly kind: 'unavailable' };

/**
 * 取字节(**默认最多 `MAX_BLOB_BYTES`**,并且只取真正需要的那些字节)。
 *
 * 分两段请求是刻意的:先 8KB 探针判断文本/二进制并拿到总长,是文本才继续取余下部分。
 * 于是「点开一个 300MB 的二进制文件」不会把 2MB 拉下来再丢掉,而文本文件仍然一次
 * 拿到 1MB 上限内的完整头部。**任何一段的响应体都不超过单次上限**。
 *
 * 返回 `null` 表示「拿不到可解码的文本」(二进制、超限、老 host、读失败)——
 * 调用方据此走各自的降级分支。
 * @param repoPath - 仓库绝对路径。
 * @param rev - 修订(见 {@link blobUrl})。
 * @param file - 仓库内相对路径。
 * @param opts.maxBytes - 最多取多少字节(默认 `MAX_BLOB_BYTES`,不允许超过它)。
 */
export async function blobBytes(
  repoPath: string,
  rev: string | undefined,
  file: string,
  opts: { maxBytes?: number } = {},
): Promise<BlobBytesResult> {
  const requested = typeof opts.maxBytes === 'number' && opts.maxBytes > 0 ? opts.maxBytes : MAX_BLOB_BYTES;
  const maxBytes = Math.min(requested, MAX_BLOB_BYTES);
  const url = blobUrl(repoPath, rev, file);
  const probe = await getRange(url, 0, BLOB_PROBE_BYTES - 1);
  if (probe === null || probe.bytes === null) {
    return { kind: 'unavailable' };
  }
  if (!probe.response.headers.has(BLOB_MARKER)) {
    return { kind: 'unavailable' };
  }
  const contentType = probe.response.headers.get('content-type') ?? 'application/octet-stream';
  if (!isTextContentType(contentType)) {
    return { kind: 'binary' };
  }
  const total = totalSizeOf(probe.response) ?? probe.bytes.length;
  const etag = probe.response.headers.get('etag') ?? '';
  const wanted = Math.min(total, maxBytes);
  if (wanted <= probe.bytes.length) {
    return {
      kind: 'text',
      bytes: probe.bytes.subarray(0, wanted),
      total,
      truncated: wanted < total,
      contentType,
      etag,
    };
  }
  /*
   * ⚠️ **续取的起点是「真的拿到了多少」,不是 `BLOB_PROBE_BYTES`。**
   *
   * 2026-10-10 实测(探针 `docs/probes/changes-oversized-warning-probe.mjs` 的 Z1,
   * 真宿主 + 真 git + 真 Chrome):浏览器可能把一次 `Range: bytes=0-8191` 用**更小的
   * 缓存分片**满足 —— 那一帧的实际响应是
   *
   * ```
   * range: bytes=0-8191   206   bytes: 5   content-length: 5
   * x-dsh-git-size: 14    content-range: bytes 0-4/14    etag: "<HEAD 的 blob sha>"
   * ```
   *
   * 也就是说 `probe.bytes` 只有 5 字节(而不是请求的 8192),而 `total` 是 14。
   * 旧写法接着问 `bytes=8192-13`(从常量起算)⇒ 起点 8192 ≥ 实体长度 14 ⇒
   * 宿主按 RFC 回 **416**,`getRange` 把 416 当「不可用」⇒ 语法高亮/上下文展开
   * 退回 JSON 老路(多一趟请求),控制台每次留一条 416。
   *
   * 改成从 `probe.bytes.length` 续取:在**正常**路径上(第一段就是 0..8191)
   * 它与常量逐字同值 ⇒ 行为不变;在被缓存分片满足的那条路上,它问的是**真正缺的那一段**。
   * 残余边界(如实记):若浏览器再给一个**不连续**的分片,这里仍会把两段拼在一起 ——
   * 那条路要 `Content-Range` 逐段校验才挡得住,不在本次改动范围。
   */
  const rest = await getRange(url, probe.bytes.length, wanted - 1);
  if (rest === null || rest.bytes === null) {
    return { kind: 'unavailable' };
  }
  const bytes = new Uint8Array(probe.bytes.length + rest.bytes.length);
  bytes.set(probe.bytes, 0);
  bytes.set(rest.bytes, probe.bytes.length);
  return { kind: 'text', bytes, total, truncated: bytes.length < total, contentType, etag };
}

/**
 * 一次带 `Range` 的 GET。
 *
 * 只把「路由给的、可解释的状态」当结果返回;网络异常回 `null`。
 * `404/413/416` 也带着 `Response` 返回 —— 调用方从**头**里读真实大小/上限,
 * 这正是「拒绝也要说实话」的那条。
 * @param url - blob URL。
 * @param start - 起始字节(闭区间)。
 * @param end - 结束字节(闭区间)。
 */
async function getRange(
  url: string,
  start: number,
  end: number,
): Promise<{ response: Response; bytes: Uint8Array | null } | null> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { range: `bytes=${start}-${end}` } });
  } catch {
    return null;
  }
  const hasBody = response.status === 200 || response.status === 206;
  if (!hasBody && response.status !== 404 && response.status !== 413 && response.status !== 416) {
    return { response, bytes: null };
  }
  if (!hasBody) {
    return { response, bytes: null };
  }
  try {
    return { response, bytes: new Uint8Array(await response.arrayBuffer()) };
  } catch {
    return null;
  }
}

async function call<T>(route: string, payload: Record<string, unknown> = {}): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(`${BASE}/${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    return { ok: false, error: TRANSPORT };
  }
  let envelope: unknown;
  try {
    envelope = await response.json();
  } catch {
    return { ok: false, error: { code: 'internal', message: `dsh-git 路由返回了非 JSON 响应(HTTP ${response.status})。` } };
  }
  if (typeof envelope !== 'object' || envelope === null) {
    return { ok: false, error: TRANSPORT };
  }
  const record = envelope as Record<string, unknown>;
  if (record.ok === true) {
    /*
     * **唯一**的载荷收窄点(见下面 `SHAPES` 的表头)。
     *
     * 表里没有的路由保持旧行为(信静态声明)—— 但那是**可观测**的:
     * `docs/probes/payload-shape-probe.mjs` 会核对「api.ts 里出现的每个路由名都在表里」,
     * 所以漏写形状会被探针抓住,而不是静默退化。
     */
    const shape = SHAPES[route];
    if (shape === undefined) {
      return { ok: true, value: record.value as T };
    }
    const checked = narrowed<T>(record.value, shape);
    if (!checked.ok) {
      // 形状不对 ⇒ 可读的失败,**绝不**把畸形值放过去当合法值。
      return { ok: false, error: payloadError(route, checked.message) };
    }
    const normalize = NORMALIZERS[route];
    if (normalize === undefined) {
      return { ok: true, value: checked.value };
    }
    return { ok: true, value: normalize(checked.value as Record<string, unknown>) as T };
  }
  const error = record.error as GitError | undefined;
  return { ok: false, error: error ?? TRANSPORT };
}

/*
 * ==========================================================================
 * **载荷收窄表** —— 这个文件里每一条路由的形状,只在这一处校验
 * ==========================================================================
 *
 * `call<T>()` 的 `T` 是**静态声明**,不是运行时保证:HTTP 信封只保证
 * 「`ok:true`」,不保证 `value` 的形状。版本偏斜(host 半要重启才更新)、
 * 路由改名、或任何桩/代理回了 `{}`,都会让消费方拿到 `undefined`,
 * 然后在**渲染期**炸掉一整块界面(这个缺陷族一天内发生过两次:
 * `auth/emails` 打没了整个偏好设置弹窗、`system/apps` 打没了整个 Changes 面板)。
 *
 * ⇒ 校验放在 `call()` 里(**唯一的**边界),形状写在这张表里:
 *
 * | 结果 | 行为 |
 * |---|---|
 * | 形状对 | 原样通过(**不重建对象**,不丢字段) |
 * | 形状不对 | 返回**可读的** `{ok:false,error}`,并记一条诊断 + `console.error` |
 * | 老 host 缺某个新字段 | `{optional: …}` 放行,再由 `NORMALIZERS` 兜底并记「载荷被兜底」 |
 *
 * 为什么是**表**而不是逐条改 60 个包装函数:包装函数有 60 个,`call()` 只有一个。
 * 表同时也是「每条路由的契约」的唯一清单 —— 探针会核对
 * 「api.ts 里出现的每个路由名都在表里」(见 `docs/probes/payload-shape-probe.mjs`),
 * 于是新加路由**忘了写形状**会被探针抓住,而不是静默退回「信静态声明」。
 */

/** 一条可读文本载荷(`show-file` / `file-text`)。`kinds` 是该路由的 kind 枚举。 */
function textPayloadShape(kinds: readonly string[]): Shape {
  return {
    record: {
      kind: { literal: kinds },
      text: 'string',
      size: 'number',
      truncated: 'boolean',
      // 老 host 不返回 encoding(见 `fileText` 的 JSDoc),缺失即按文本处理。
      encoding: 'string?',
    },
  };
}

/** `RepoEntry`(`core/types.ts:179`)。只列**会被解引用**的字段。 */
const RepoEntryShape: Shape = {
  record: { path: 'string', name: 'string', remote: 'string|null', addedAt: 'number' },
};

const RepoEntryListShape: Shape = { array: RepoEntryShape };

/** 写动作的统一回执(`{ok:true}`)。`{}` 或 `{ok:false}` 都必须被拒。 */
const OkTrueShape: Shape = { record: { ok: { literal: [true] } } };

/** `CommitEntry`(`core/types.ts:125`)。 */
const CommitEntryShape: Shape = {
  record: {
    sha: 'string', shortSha: 'string', subject: 'string', body: 'string',
    authorName: 'string', authorEmail: 'string', authorDate: 'string',
    committerName: 'string', committerEmail: 'string', committerDate: 'string',
    parents: { array: 'string' }, refs: { array: 'string' },
  },
};

/** `AuthStatePayload`(`api.ts` 下方)。`endpoint` 老 host 不返回 ⇒ 可缺省。 */
const AuthStateShape: Shape = {
  record: {
    signedIn: 'boolean', login: 'string', tokenTail: 'string',
    deviceFlow: 'boolean?', viaDeviceFlow: 'boolean?', endpoint: 'string?',
  },
};

/** 每条路由的形状。**键就是 `call()` 的第一个参数**。 */
const SHAPES: Readonly<Record<string, Shape>> = {
  // ---------- 长连接(上游 AliveStore)----------
  // 只登记**宿主能保证**的键:`event` 是上游契约(见 `gh-api.ts` 的 `GH_PROXY_SHAPE` 注释)。
  'alive/status': {
    record: {
      listening: 'boolean', supported: 'boolean', endpoint: 'string?',
      received: 'number?', cursor: 'number?', lastError: 'string|null?',
    },
  },
  // `events` 的元素形状由 `client/alive.ts` 的 `asAliveEvent` 守卫逐条收窄
  // (`Shape` 里没有「数组元素是任意对象」这一档,这里只钉「是数组」)。
  'alive/events': { record: { events: { array: { record: {} } }, cursor: 'number' } },

  // ---------- 就绪 / 仓库清单 ----------
  'health': {
    record: {
      ready: 'boolean', repos: 'number', signedIn: 'boolean',
      persistent: 'boolean', storageError: 'string|null',
    },
  },
  /*
   * `repos`:`hidden` / `canPickDirectory` / `lastSelected` / `tokenTail` 是
   * remote-repos 之后加进这条**既有**路由的字段。老 host(不热重载)可能不返回
   * ⇒ 用 `optional` 放行,再由 `NORMALIZERS` 兜底(不兜底的话
   * `repo-bar.tsx` 的 `snap.hidden.includes(...)` 会抛,而那个文件不在本轮所有权内)。
   */
  'repos': {
    record: {
      repos: RepoEntryListShape,
      hidden: { optional: { array: 'string' } },
      tokenTail: 'string?',
      canPickDirectory: 'boolean?',
      lastSelected: 'string?',
    },
  },
  'pick-directory': { record: { path: 'string|null' } },
  'repos/autodetect': {
    record: {
      detected: 'boolean', path: 'string|null', repos: RepoEntryListShape,
      added: 'boolean?', reason: 'string?',
    },
  },
  'repos/select': OkTrueShape,
  'repos/add': { record: { added: 'boolean', repos: RepoEntryListShape } },
  'repos/add-existing': { record: { added: 'boolean', repos: RepoEntryListShape } },
  'repos/remove': { record: { repos: RepoEntryListShape } },
  'repos/rename': { record: { repos: RepoEntryListShape } },

  // ---------- 文件内容 / 清单 ----------
  // `kind` 必须是枚举里的一员:写错一个字母会被消费方当成「非 text」而**静默降级**。
  'show-file': textPayloadShape(['text', 'binary', 'too-big', 'missing']),
  'file-text': textPayloadShape(['text', 'binary', 'too-big']),
  'repo/tree': { record: { files: { array: 'string' }, truncated: 'boolean' } },
  /*
   * 作者身份(上游 `lib/git/var.ts` 的 `getAuthorIdentity`,`git var GIT_AUTHOR_IDENT`)。
   *
   * ⚠️ `ident` **必须**是 `string|null`:`null` 是**一条真实结局**
   * (`user.useConfigOnly` 且没配 name/email ⇒ git 退出码 128 ⇒ 上游回 `null`,`var.ts:33-35`),
   * 把它收窄成 `string` 会让那一档被**载荷守卫**判成畸形 —— 而那正是 `undo-commit`
   * 已经付过一次代价的缺陷类(见 `docs/probes/api-declaration-vs-host-probe.mjs`):
   * 宿主明明成功了,客户端却拿到 `ok:false`。
   *
   * 解析(姓名/邮箱)不在这里:用镜像里那份 `CommitIdentity.parseIdentity`。
   */
  'repo/author-ident': { record: { ident: 'string|null' } },

  // ---------- 多提交操作(squash / reorder)----------
  /*
   * `result` 收窄成 `'string'` —— 理由与 `repo/author-ident` 的 `ident` 同一条:
   * 它是 `RebaseResult` 的枚举值,宿主回的就是**字符串**;声明成字面量联合会让守卫
   * 在宿主将来加枚举值时把**成功**判成畸形(那正是 `undo-commit` 付过代价的缺陷类)。
   * 消费方自己按 `src/core/desktop/lib/git/rebase.ts:36-69` 的 6 个值分支。
   */
  'multi-commit/squash': { record: { result: 'string' } },
  'multi-commit/reorder': { record: { result: 'string' } },
  // 续跑变基(2026-10-10):与上面两条同一形状 —— `RebaseResult` 的字符串值。
  'rebase/continue': { record: { result: 'string' } },

  // ---------- 系统动作 ----------
  // ⭐ 缺陷现场 #2:少了 apps ⇒ `snap.externalApps.filter` 抛 ⇒ 整个 Changes 面板不渲染。
  'system/apps': { record: { apps: { array: { record: { id: 'string', label: 'string' } } } } },
  'system/reveal': { record: { ok: 'boolean' } },
  'system/open-in-app': { record: { ok: 'boolean' } },

  // ---------- 偏好 ----------
  'prefs/set': OkTrueShape,
  // 空对象 = 「从未设置过」,所以每个字段都可缺省;但整体必须是对象。
  'prefs/get': { record: {} },

  // ---------- 状态 / 同步 ----------
  'status': {
    record: {
      root: 'string', branch: 'string', headSha: 'string', detached: 'boolean', unborn: 'boolean',
      upstream: 'string|null', ahead: 'number', behind: 'number',
      // ⭐ 数组 + 元素形状:消费方 `.map((f) => f.path)` 直接解引用。
      files: { array: { record: { path: 'string' } } },
      stagedCount: 'number', unstagedCount: 'number', untrackedCount: 'number', conflictedCount: 'number',
      operation: { literal: ['rebase', 'merge', 'cherry-pick', 'revert', null] },
    },
  },
  'sync-state': {
    record: {
      ahead: 'number', behind: 'number', upstream: 'string|null',
      remotes: { array: 'string' }, canForcePush: 'boolean',
      lastFetchedAt: 'string|null', tagCount: 'number',
      /*
       * **可选**(`'boolean?'`):老 host(不热重载)不返回它,那不是载荷畸形 ——
       * 而 `SyncState.pullWithRebase` 的缺省语义本来就是「走 git 自己的默认行为」,
       * 正好是老 host 的行为。写成必填会让刷新页面后整条 `sync-state` 被拒,
       * 工具栏的 ↑↓ 与按钮状态机**全部**消失(over-strict 在这里比漏检更贵)。
       */
      pullWithRebase: 'boolean?',
    },
  },

  // ---------- diff ----------
  // `patch` 少了 ⇒ diff 渲染器 `.split` 抛(整块 diff 面板白掉)。
  'diff': {
    record: {
      path: 'string', patch: 'string', additions: 'number', deletions: 'number',
      binary: 'boolean', untracked: 'boolean', oldPath: 'string?',
    },
  },

  // ---------- 变更动作 ----------
  'stage': OkTrueShape,
  'stage-lines': { record: { staged: 'boolean' } },
  'unstage': OkTrueShape,
  'discard': OkTrueShape,
  // `sha.slice(0,7)` / `selectedCommit: sha` 都直接用它。
  'commit': { record: { sha: 'string', subject: 'string' } },
  // ⚠️ 返回的是 `description`,**不是** `body`:宿主 `git-service.ts:612` 逐字是
  // `{ subject: string; description: string }`。写错名字的后果见下面 `undoCommit` 的注释
  // ——`record` 字段默认必填 ⇒ 真载荷会被这里拒掉(git 撤完了、界面报失败)。
  'undo-commit': { record: { subject: 'string', description: 'string' } },

  // ---------- 历史 ----------
  'log': { record: { commits: { array: CommitEntryShape }, hasMore: 'boolean' } },
  'commit-detail': {
    record: {
      commit: CommitEntryShape,
      files: { array: { record: { path: 'string', status: 'string', additions: 'number', deletions: 'number', oldPath: 'string?' } } },
      additions: 'number', deletions: 'number',
    },
  },

  // ---------- 分支 ----------
  // 顶层就是数组:少了 ⇒ `snap.branches.filter` 抛。
  'branches': {
    array: {
      record: {
        name: 'string', ref: 'string', isRemote: 'boolean',
        upstream: 'string|null', current: 'boolean', sha: 'string',
      },
    },
  },
  'checkout': OkTrueShape,
  'branch-create': OkTrueShape,
  'branch-rename': OkTrueShape,
  'branch-delete': OkTrueShape,

  // ---------- 同步 ----------
  'fetch': OkTrueShape,
  'pull': OkTrueShape,
  'push': OkTrueShape,
  /*
   * 在飞的网络动作进度。`progress` 允许 `null`(没有动作在跑 / 不是这个仓库 ——
   * **正常状态**),所以用 `anyOf` 而不是必填 record:写成必填会让「空闲」这一
   * 最常见的情形被判成载荷畸形,而那条失败会被记成 `console.error`(本仓的探针
   * 有「0 console.error」这一档,于是产品会被自己的守卫弄红)。
   */
  'sync-progress': {
    record: {
      progress: {
        anyOf: [
          { record: { kind: { literal: ['push', 'fetch', 'pull'] }, description: 'string', value: 'number', done: 'boolean' } },
          { literal: [null] },
        ],
      },
    },
  },
  'clone': { record: { root: 'string', repos: RepoEntryListShape } },
  /*
   * 克隆目标路径的预检(`clone/validate-path`)。`kind` 是**闭集**:
   * `ClonePathKind` 的五档穷尽了上游 `validateClonePath()` 的结局,写成闭集是为了
   * 新 host 回了第六种取值时**当场失败**而不是让未知取值静默走进某个 `default` 分支。
   */
  'clone/validate-path': {
    record: {
      kind: { literal: ['absent', 'empty', 'non-empty', 'not-a-directory', 'unreadable'] },
    },
  },

  // ---------- 配置 ----------
  'config-get': { record: { key: 'string', scope: 'string', value: 'string|null' } },
  'config-set': OkTrueShape,
  'config-unset': OkTrueShape,
  'config-file-info': {
    record: { path: 'string|null', exists: 'boolean', lockPath: 'string|null', lockExists: 'boolean' },
  },
  'config-file-open': OkTrueShape,

  /*
   * `remotes` / `remote-set-url` —— **宿主早就有、客户端一直没有包装**的两条
   * (`src/host/routes.ts:1022-1031`)。仓库设置弹窗的 Remote 页是它们的第一个调用点:
   * 快照里只有 `sync.remotes: string[]`(**只有名字**,`core/types.ts:213`),
   * 而那一页要显示**地址**(上游 `IRemote = { name, url }`)。
   *
   * 两条都不新增宿主能力,也不改任何既有契约 —— 这里只是把既有的信封**声明**出来
   * (本条是被 `payload-shape-probe.mjs` 的 A7 棘轮要求的:api.ts 里出现的路由名
   * 必须在形状表里)。
   */
  'remotes': { record: { remotes: { array: { record: { name: 'string', url: 'string' } } } } },
  'remote-set-url': OkTrueShape,

  /*
   * 仓库根 `.gitignore` 的三条(纯文件 I/O,见 `src/host/gitignore.ts`)。
   *
   * `gitignore/read` 的 `text` **必须**是 `string|null`:`null` = 这个仓库根没有
   * `.gitignore` 文件,与「文件存在但是空的」是**两种不同的状态** —— 设置弹窗靠这个区分
   * 决定要不要在保存时删文件(`repository-settings.tsx:316`),把它收窄成 `string`
   * 会让上游那条分支不可达。
   */
  'gitignore/read': { record: { text: 'string|null' } },
  'gitignore/save': OkTrueShape,
  'gitignore/append': OkTrueShape,

  // ---------- 模型与生成 ----------
  'commit-message/models': {
    record: {
      models: { array: { record: { provider: 'string', providerName: 'string', id: 'string', name: 'string' } } },
    },
  },
  'commit-message/generate': {
    record: { title: 'string', description: 'string', provider: 'string', model: 'string' },
  },

  // ---------- 登录 ----------
  'auth/state': AuthStateShape,
  'auth/device-start': {
    record: {
      deviceCode: 'string', userCode: 'string', verificationUri: 'string',
      expiresIn: 'number', interval: 'number',
    },
  },
  /*
   * 三态判别联合:消费方按 `status` 分支后**直接解引用**那一支的字段
   * (`value.state.login`)⇒ 每一支的字段都必须校验,不能只校验 `status`。
   */
  'auth/device-poll': {
    anyOf: [
      { record: { status: { literal: ['pending'] }, slowDown: 'boolean?' } },
      { record: { status: { literal: ['done'] }, state: AuthStateShape } },
      { record: { status: { literal: ['error'] }, message: 'string' } },
    ],
  },
  'auth/pat': AuthStateShape,
  'auth/logout': OkTrueShape,
  // ⭐ 缺陷现场 #1:`emails` 少了 ⇒ `emails.map(...)` 抛 ⇒ 整个偏好设置弹窗被卸载。
  'auth/emails': {
    record: {
      emails: {
        array: {
          record: { email: 'string', verified: 'boolean', primary: 'boolean', visibility: 'string|null' },
        },
      },
    },
  },

  // ---------- 远程仓库 ----------
  'remote-repos': { record: { repos: { array: { record: { fullName: 'string' } } }, hidden: { array: 'string' } } },
  'remote-repos/hide': { record: { hidden: { array: 'string' } } },
  'remote-repos/unhide': { record: { hidden: { array: 'string' } } },

  // ---------- 历史 / 提交操作 ----------
  'discard-lines': OkTrueShape,
  'reset-to-commit': { record: { ok: { literal: [true] }, worktreeDiscarded: 'boolean?' } },
  'checkout-commit': OkTrueShape,
  'revert-commit': OkTrueShape,
  'cherry-pick-commit': OkTrueShape,
  'tag-create': OkTrueShape,
  'tag-delete': OkTrueShape,
  // `tags` 是**身份清单**(不是个数):History 右键 `Delete tag <name>` 的 enabled 判据。
  // 少这个键 ⇒ 载荷被拒 ⇒ 客户端静默保留旧值 ⇒ 那一项**恒灰**,与没接这条路由一样。
  'tag-unpushed': { record: { tags: { array: 'string' } } },
  'remote-branch-delete': OkTrueShape,

  // ---------- stash 族(上游 `lib/git/stash.ts`) ----------
  /*
   * `desktopEntries` 的形状与宿主 `IStashEntryPayload`(=`IStashEntry` 的 JSON 投影)
   * 逐字对齐:`name` / `branchName` / `stashSha` / `tree` / `parents`。
   * 少写任何一个键 ⇒ 载荷被**拒** ⇒ `stashEntry` 恒 `null` ⇒
   * 「贮藏全部改动」恒灰、空态 stash 卡永不出现(与没接这条路由一样)。
   */
  'stash/list': {
    record: {
      desktopEntries: {
        array: {
          record: {
            name: 'string', branchName: 'string', stashSha: 'string', tree: 'string',
            parents: { array: 'string' },
          },
        },
      },
      stashEntryCount: 'number',
    },
  },
  // `created` 是**上游同一个函数的返回值**:`false` = `No local changes to save`。
  'stash/push': { record: { ok: { literal: [true] }, created: 'boolean' } },
  'stash/pop': OkTrueShape,
  'stash/drop': OkTrueShape,
  // `status` 是 `AppFileStatus` 的 JSON 投影(`core/parse.ts` 的 `IStashFileStatusJson`)。
  // `linesAdded`/`linesDeleted` 是整条 stash 的**总量**(上游 `parseRawLogWithNumstat` 的返回值)。
  'stash/show': {
    record: {
      files: {
        array: {
          record: {
            path: 'string',
            status: {
              record: {
                kind: 'string',
                oldPath: 'string?',
                renameIncludesModifications: 'boolean?',
                submoduleStatus: {
                  optional: {
                    record: {
                      commitChanged: 'boolean', untrackedChanges: 'boolean', modifiedChanges: 'boolean',
                    },
                  },
                },
              },
            },
            commitish: 'string',
            parentCommitish: 'string',
          },
        },
      },
      linesAdded: 'number',
      linesDeleted: 'number',
    },
  },
  'stash/move': { record: { sha: 'string' } },
};

/**
 * 通过形状校验之后**就地补**可缺省字段。
 *
 * 只用于「新字段 + 老 host」这一种情况(host 半不热重载,刷新页面后新前端可能
 * 面对旧 host)。补出来的值会记一条「载荷被兜底」诊断 —— **兜底不是静默**。
 *
 * @param route - 路由名。
 * @param value - 已经通过形状校验的载荷。
 * @param fill - 键 → 缺省值;只在 `undefined` 时写入。
 */
function fillOptional<T extends object>(
  route: string,
  value: T,
  fill: Record<string, unknown>,
): T {
  const missing = Object.keys(fill).filter(
    (key) => (value as Record<string, unknown>)[key] === undefined,
  );
  if (missing.length === 0) {
    return value;
  }
  noteNormalized(route, `老 host 没返回这些字段,已兜底:${missing.join(' / ')}`);
  return { ...value, ...fill };
}

/** 每条路由的「缺省兜底」;没有条目 = 不缺省任何字段。 */
const NORMALIZERS: Readonly<Record<string, (value: Record<string, unknown>) => unknown>> = {
  'repos': (value) => fillOptional('repos', value, {
    hidden: [], canPickDirectory: false, lastSelected: '', tokenTail: '',
  }),
};

/** 诊断出口:表里有没有这条路由(探针与自检读它)。 */
export function declaredRouteShapes(): readonly string[] {
  return Object.keys(SHAPES);
}

/** health 路由的返回。 */
export interface HealthPayload {
  ready: boolean;
  repos: number;
  signedIn: boolean;
  /** false = storage domain 没打开成功:功能可用,但重启会丢清单与登录态。 */
  persistent: boolean;
  storageError: string | null;
}

/** 路由就绪探测的结果。 */
export type RouteReadiness =
  | { ok: true; health: HealthPayload }
  | { ok: false };

/**
 * 等 host 路由就绪:host 半在 storage domain 打开后才注册 /dsh-git/*,而浏览器
 * 半可能更早挂载。这里轮询 health,最多等 ~6s。
 * @returns 就绪时带回 health(调用方据此判断存储是否持久化)。
 */
export async function waitForRoutes(timeoutMs = 6000): Promise<RouteReadiness> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await call<HealthPayload>('health');
    if (result.ok) {
      return { ok: true, health: result.value };
    }
    if (Date.now() >= deadline) {
      return { ok: false };
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

/** 同步等待时抛可读错误(视图里用 try/catch 或 result 判定)。 */
export function unwrap<T>(result: ApiResult<T>): T {
  if (result.ok) {
    return result.value;
  }
  throw new Error(result.error.message);
}

// ---------- 仓库清单 ----------

export interface ReposPayload {
  repos: RepoEntry[];
  hidden: string[];
  tokenTail: string;
  canPickDirectory: boolean;
  /** 上次选中的仓库路径(宿主持久化)。 */
  lastSelected: string;
}

export interface RemoteRepo {
  fullName: string;
  isPrivate: boolean;
  pushedAt: string;
  description?: string;
}

export const api = {
  health: () => call<HealthPayload>('health'),
  repos: () => call<ReposPayload>('repos'),
  pickDirectory: () => call<{ path: string | null }>('pick-directory'),
  /**
   * 原始字节端点(`GET /dsh-git/blob`)—— **内容取数的新路径**。
   *
   * 三个都是同一层的门面:`blobUrl` 造 URL(可直接喂 `<img src>`),
   * `blobHead` 只量元数据,`blobBytes` 取文本头部(内部可能分两段 Range)。
   */
  blobUrl,
  blobHead,
  blobBytes,
  /** 自动登记当前工作区项目。 */
  autodetect: (sessionId: string) => call<{
    detected: boolean; path: string | null; added?: boolean; repos: RepoEntry[]; reason?: string;
  }>('repos/autodetect', { sessionId }),
  /**
   * 读**某个修订下**某个文件的内容(blob)—— **老 host 兜底**。
   *
   * ⚠️ 新代码用 {@link blobUrl} / {@link blobBytes}(原始字节、`Range`、`ETag`/`304`、
   * 一个上限)。这条 JSON 路由只在「host 还是旧构建」时才有用(host 半不热重载),
   * 而且它的 base64 上限已经收窄到 256 KiB(`core/blob.ts` 的
   * `BLOB_JSON_FALLBACK_MAX_BYTES`)—— 因为 base64 会膨胀 33% 且整份进 JS 字符串。
   * `rev` 也接受 `'index'`(读暂存区)。
   */
  showFile: (path: string, rev: string, file: string) => call<{
    kind: 'text' | 'binary' | 'too-big' | 'missing'; text: string; size: number; truncated: boolean;
    /** 只有 binary 是 'base64'(text 里载的是图片/二进制像素);其余为 utf8 文本。 */
    encoding?: 'utf8' | 'base64';
  }>('show-file', { path, rev, file }),
  /** 本地工作区文件清单(遵守 .gitignore);远端 Code 页签不用它。 */
  repoTree: (path: string) => call<{ files: string[]; truncated: boolean }>('repo/tree', { path }),
  /**
   * 「git 这次提交会用谁当作者」—— 上游 `lib/git/var.ts:20-42` 的 `getAuthorIdentity`。
   *
   * 唯一调用点:`src/client/changes-view.tsx` 的 `CommitAuthorAvatar`(提交区左下角头像 /
   * 「Committing as」浮层)。返回的是**原始那一行** `Name <email> <ts> <tz>`,
   * 由调用方交给镜像里的 `CommitIdentity.parseIdentity` —— 不在这里解析。
   * `ident === null` = `user.useConfigOnly` 且没配 name/email(上游此时也回 `null`,
   * 「这次提交注定失败」),**不是**传输失败。
   */
  repoAuthorIdent: (path: string) => call<{ ident: string | null }>('repo/author-ident', { path }),

  /**
   * **多提交操作 · squash** —— 上游 `lib/git/squash.ts`(宿主侧 `GitService.squashCommits`)。
   *
   * `result` 是镜像 `src/core/desktop/lib/git/rebase.ts:36-69` 那个 `RebaseResult`
   * 枚举的**字符串值**(wired 之后由 `lib/rebase.ts` 的 `formatRebaseValue` 同族消费):
   * `'CompletedWithoutError' | 'AlreadyUpToDate' | 'ConflictsEncountered' |
   *  'OutstandingFilesNotStaged' | 'Aborted' | 'Error'`。
   *
   * ⚠️ **冲突是 `ok:true`**:`ConflictsEncountered` 走的是成功信封(上游
   * `parseRebaseResult` 也是**返回**它,不是抛)。把它当失败会骗用户。
   * ⚠️ **冲突的出路在 2026-10-10 接通了**:`ConflictsEncountered` 之后走
   * {@link continueRebase}(宿主 `rebase/continue` 路由)接着跑,不再需要用户去命令行。
   */
  multiCommitSquash: (input: {
    path: string;
    toSquash: readonly string[];
    squashOnto: string;
    lastRetainedCommitRef: string | null;
    commitMessage: string;
    noVerify?: boolean;
  }) => call<{ result: string }>('multi-commit/squash', { ...input }),

  /**
   * **继续变基** —— 上游 `ui/dispatcher/dispatcher.ts:1473-1512` 的 `continueRebase`
   * → `app-store.ts:7535-7553` → `lib/git/rebase.ts:444-546`;宿主侧
   * `GitService.continueRebase`。
   *
   * 请求只有 `path`(与可选 `noVerify`):上游还要一个 `manualResolutions`
   * (客户端「手工标记为已解决」状态机),而它整个不在本仓 —— 到达这条请求的前提是
   * 「冲突文件已经没有了」(`ContinueRebase` 那颗按钮在同帧被禁用)。
   *
   * `result` 与 {@link multiCommitSquash} 同一套 `RebaseResult` 字符串值;
   * `Aborted` = `.git/REBASE_HEAD` 读不到(变基已经不在进行中,上游同样回它)。
   */
  continueRebase: (input: { path: string; noVerify?: boolean }) =>
    call<{ result: string }>('rebase/continue', { ...input }),

  /**
   * **多提交操作 · reorder** —— 上游 `lib/git/reorder.ts`(宿主侧 `GitService.reorderCommits`)。
   *
   * `beforeCommit: null` = 移到最前(上游 `reorder.ts:120-126`)。
   * 响应与 `multiCommitSquash` 同一套。
   */
  multiCommitReorder: (input: {
    path: string;
    toMove: readonly string[];
    beforeCommit: string | null;
    lastRetainedCommitRef: string | null;
    noVerify?: boolean;
  }) => call<{ result: string }>('multi-commit/reorder', { ...input }),

  /**
   * 读工作区文件文本(**老 host 兜底**,同 `showFile`)。
   *
   * 新的原始字节路径见 {@link blobUrl};二进制 base64 的兜底上限是 256 KiB。
   */
  fileText: (path: string, file: string) => call<{
    kind: 'text' | 'binary' | 'too-big'; text: string; size: number; truncated: boolean;
    /**
     * `binary` 时为 `'base64'`(载的是图片/二进制像素,与 `showFile` 同形),
     * 其余为 utf8 文本。**可选**:旧 host 不返回这个字段,缺失即按文本处理。
     */
    encoding?: 'utf8' | 'base64';
  }>('file-text', { path, file }),
  /**
   * 工作区文件的**字节数** —— `fs.promises.stat` 的客户端包装。
   *
   * 唯一消费者是 `src/client/history-view.tsx` 安装的 `IFsPromisesHost.stat`
   * (`src/client/shim-node-fs-promises.ts` 的注入点),而它的调用方是**逐字镜像**的
   * 上游 `lib/large-files.ts`(`src/core/desktop/lib/large-files.ts`,100 MiB 阈值
   * 在那一份里)。所以这条包装**不判任何阈值**,只搬数字。
   *
   * `size === null` = 不是工作区里的普通文件(缺失/目录):调用方按 `ENOENT` 处理,
   * 与 node `fs.promises.stat` 对缺失文件的语义对齐(见 `GitService.fileSize` 的边界表:
   * 符号链接报**链接自身**的大小,链接指向仓库外时被守卫拒绝)。
   */
  fileSize: (path: string, file: string) => call<{ size: number | null }>('file-size', { path, file }),
  /**
   * 这批路径里哪些**没有被 LFS 跟踪** —— 上游 `lib/git/lfs.ts:107` 的
   * `filesNotTrackedByLFS`(逐文件 `git check-attr filter <path>`)。
   *
   * `unsupported: true` = 这个 host 没有注入 LFS 能力(旧 host,或探针的
   * `createGitHandler` 没传 `deps.lfs`)⇒ 调用方必须**说实话并照常提交**,
   * 不许把空名单当成「都被 LFS 覆盖了」(那是凭空消失的告警)。
   */
  lfsUntracked: (path: string, files: ReadonlyArray<string>) =>
    call<{ untracked: string[]; unsupported: boolean }>('lfs/untracked', { path, files: [...files] }),
  /** 本机可用的外部编辑器(Desktop 的 Open in <editor>)。 */
  systemApps: () => call<{ apps: { id: string; label: string }[] }>('system/apps'),
  /** 在文件管理器中显示(Desktop 的 Show in Finder / Show in Explorer)。 */
  systemReveal: (path: string) => call<{ ok: boolean }>('system/reveal', { path }),
  /** 用外部编辑器打开(Desktop 的 Open in <editor>)。 */
  systemOpenInApp: (path: string, app?: string) =>
    call<{ ok: boolean }>('system/open-in-app', app === undefined ? { path } : { path, app }),
  /** 保存生成偏好(落盘)。 */
  setPrefs: (patch: PrefsPatch) =>
    call<{ ok: true }>('prefs/set', patch),
  /**
   * 读回已落盘的生成偏好。
   *
   * 为什么必须有这条读回路:以前只有 `prefs/set` 而没有 get,于是
   * `prefs.model` **只写不读** —— host 端 `pinnedModel()` 用它生成提交信息,
   * 界面却在 `loadModels()` 里把下拉重置成 `models[0]`
   * (见本文件 §「模型 pin 的往返」)。实测(真 HTTP + 真 store):
   * 选了 provB/model-b、刷新页面后下拉显示 provA/model-a。
   * `stagedOnly` 同族:写进去、重启后读不回,勾选框每次都弹回默认。
   *
   * 返回空对象表示「从未设置过」,调用方按下沉默认值处理。
   */
  prefs: () => call<PrefsPatch>('prefs/get', {}),
  /** 记住选中的仓库。 */
  selectRepo: (path: string) => call<{ ok: true }>('repos/select', { path }),
  addRepo: (path: string) => call<{ added: boolean; repos: RepoEntry[] }>('repos/add', { path }),
  addExisting: (path: string, init: boolean) => call<{ added: boolean; repos: RepoEntry[] }>('repos/add-existing', { path, init }),
  removeRepo: (path: string) => call<{ repos: RepoEntry[] }>('repos/remove', { path }),
  renameRepo: (path: string, alias: string) => call<{ repos: RepoEntry[] }>('repos/rename', { path, alias }),

  // ---------- 状态 / 同步 ----------
  status: (path: string) => call<RepoStatus>('status', { path }),
  syncState: (path: string) => call<SyncState>('sync-state', { path }),

  // ---------- diff ----------
  diff: (input: { path: string; file: string; staged?: boolean; untracked?: boolean; commit?: string; ignoreWhitespace?: boolean }) =>
    call<DiffResult>('diff', input),

  // ---------- 变更动作 ----------
  stage: (path: string, files: string[]) => call<{ ok: true }>('stage', { path, files }),
  /** 按行暂存:选区索引 = patch 内的绝对行号(与 core/diff-parse 的 originalLineNumber 一致)。 */
  stageLines: (path: string, file: string, kind: string, selection: {
    kind: 'all' | 'none'; diverging: number[]; selectable?: number[];
  }) => call<{ staged: boolean }>('stage-lines', { path, file, kind, selection }),
  unstage: (path: string, files: string[]) => call<{ ok: true }>('unstage', { path, files }),
  discard: (path: string, files: string[], untrackedPaths: string[]) =>
    call<{ ok: true }>('discard', { path, files, untrackedPaths }),
  commit: (input: {
    path: string; message: string; description?: string; files: string[];
    amend?: boolean; signoff?: boolean; noVerify?: boolean; allowEmpty?: boolean;
  }) => call<{ sha: string; subject: string }>('commit', input),

  /**
   * 撤销一次提交(reset --mixed 到父提交或删除 ref)。
   *
   * ⚠️ **返回的是 `description`,不是 `body`** —— 宿主 `git-service.ts:612` 的返回类型
   * 逐字是 `Promise<{ subject: string; description: string }>`。改前这里(以及上面
   * `SHAPES['undo-commit']`)写的是 `{subject, body}`,后果**不是**「类型标注不准」:
   * `SHAPES` 的 `record` 字段默认**必填**,于是宿主回的真载荷被 `narrowed` 拒掉
   * (诊断逐字:`载荷形状不对:body 期望 string,实到 undefined(实到 对象{键=[subject,description]})`)
   * ⇒ `store.undoCommit` 拿到 `ok:false` ⇒ **git 已经撤完了,界面却报失败、横幅不消失**。
   * 真读数见 `docs/probes/undo-commit-strip-probe.mjs` 段 A(A10c/A10d 改前红)。
   */
  undoCommit: (path: string, sha: string) =>
    call<{ subject: string; description: string }>('undo-commit', { path, sha }),

  // ---------- 历史 ----------
  log: (path: string, limit: number, skip?: number) => call<{ commits: CommitEntry[]; hasMore: boolean }>('log', { path, limit, ...(skip !== undefined ? { skip } : {}) }),
  commitDetail: (path: string, sha: string) => call<CommitDetail>('commit-detail', { path, sha }),

  // ---------- 分支 ----------
  branches: (path: string) => call<BranchEntry[]>('branches', { path }),
  checkout: (path: string, branch: string, createFromRemote?: string) =>
    call<{ ok: true }>('checkout', { path, branch, ...(createFromRemote !== undefined ? { createFromRemote } : {}) }),
  createBranch: (path: string, name: string, startPoint?: string) => call<{ ok: true }>('branch-create', { path, name, ...(startPoint !== undefined ? { startPoint } : {}) }),
  renameBranch: (path: string, oldName: string, newName: string) => call<{ ok: true }>('branch-rename', { path, oldName, newName }),
  deleteBranch: (path: string, name: string) => call<{ ok: true }>('branch-delete', { path, name }),

  // ---------- 同步 ----------
  fetch: (path: string, remote?: string) => call<{ ok: true }>('fetch', { path, ...(remote !== undefined ? { remote } : {}) }),
  /**
   * 拉取。
   *
   * `rebase` 省略 = 宿主自己读 `pull.rebase`(老行为,「更多 ▸ 拉取」与
   * `runSyncAction('pull')` 走这一支);
   * 给了值 = **用这个值**,它必须正是渲染按钮文案的那一个
   * (`SyncState.pullWithRebase`)。顶栏那条路径给的就是它,于是「文案说变基、
   * 执行却 `--ff-only`」不可能发生(上游 `push-pull-button.tsx:497` 的同一形状)。
   */
  pull: (path: string, rebase?: boolean) =>
    call<{ ok: true }>('pull', { path, ...(rebase !== undefined ? { rebase } : {}) }),
  push: (path: string, force: boolean) => call<{ ok: true }>('push', { path, force }),
  /**
   * **在飞的网络动作进度**（`git --progress` 的 stderr 解析结果）。
   *
   * 为什么是**独立**的一条路由而不是搭 `push` 的响应：推送请求**一直阻塞到推完**，
   * 它的响应就是「推完了」——进度搭不了自己的车。所以宿主把进度放在内存里
   * （`GitService.syncProgressByRoot`），这条路由只查一次 Map、不跑子进程，
   * 客户端才敢按 ~250ms 轮询（见 `store.ts` 的 `startSyncProgressPolling`）。
   *
   * `progress === null` = 没有动作在跑 / 不是这个仓库：**正常状态，不是错误**。
   */
  syncProgress: (path: string) =>
    call<{ progress: SyncProgressPayload | null }>('sync-progress', { path }),
  clone: (url: string, path: string, branch?: string) => call<{ root: string; repos: RepoEntry[] }>('clone', { url, path, ...(branch !== undefined ? { branch } : {}) }),
  /**
   * **克隆目标路径的预检**（宿主 `clone/validate-path` → `GitService.inspectClonePath`）。
   *
   * 上游是在用户边打字时校验目标路径的（`ui/clone-repository/clone-repository.tsx:570-591`
   * 的 `validatePath()`，由 `onPathChanged` / `updateUrl` / 切页签 / 窗口 focus 触发），
   * 错误当场显示并把 Clone 按钮禁掉。这条路由就是那个校验的宿主半 ——
   * 浏览器半没有 `readdir`，判定必须在能看见磁盘的一侧做（详见 `ClonePathKind` 的注释）。
   *
   * `kind === 'absent' | 'empty'` 表示**可以克隆**；其余三档各自对应上游一句文案。
   */
  cloneValidatePath: (path: string) =>
    call<{ kind: ClonePathKind }>('clone/validate-path', { path }),

  // ---------- 配置 ----------
  configGet: (path: string, key: string, scope: 'local' | 'global') => call<{ key: string; scope: string; value: string | null }>('config-get', { path, key, scope }),
  configSet: (path: string, key: string, value: string, scope: 'local' | 'global') => call<{ ok: true }>('config-set', { path, key, value, scope }),

  /**
   * 删掉一条配置(`git config [--global] --unset-all <key>`,上游 `removeConfigValue`)。
   *
   * 唯一调用点:仓库设置弹窗 ▸ Git Config 页把作用域从 Local 切回 Global —— 上游那时
   * 删掉**本地**的 `user.name` / `user.email` 让 git 回落全局
   * (`references/desktop/app/src/ui/repository-settings/repository-settings.tsx:353-356`)。
   * 键不存在时 git 返回非零 ⇒ `ok:false`(与上游一样不吞)。
   */
  configUnset: (path: string, key: string, scope: 'local' | 'global') =>
    call<{ ok: true }>('config-unset', { path, key, scope }),

  // ---------- 远端清单与远端地址(仓库设置弹窗 ▸ Remote 页) ----------

  /**
   * 远端清单(`name` + `url`)。
   *
   * 客户端此前**零调用点** ⇒ 宿主那条 `remotes` 路由一直没有包装(见
   * `docs/unported-master-ledger.md` §3.3 的口径:路由在、包装不在)。
   */
  remotes: (path: string) =>
    call<{ remotes: { name: string; url: string }[] }>('remotes', { path }),

  /**
   * 改远端地址(上游 `dispatcher.setRemoteURL`)。
   *
   * ⚠️ 与上游一样**不校验 URL 的形状**:`git remote set-url` 接受任意字符串,
   * 真正的失败(例如不存在的远端名)由 git 的退出码变成 `ok:false`。
   */
  setRemoteUrl: (path: string, name: string, url: string) =>
    call<{ ok: true }>('remote-set-url', { path, name, url }),

  // ---------- 仓库根 .gitignore(纯文件 I/O;宿主 `src/host/gitignore.ts`) ----------

  /**
   * 读仓库根 `.gitignore` 全文。
   *
   * `text === null` ⇒ **这个仓库根没有 `.gitignore` 文件**(不是「空文件」)。
   * 符号链接 ⇒ `ok:false`(`bad-request`)—— 与上游 `readGitIgnoreAtRoot` 同一条规则。
   */
  gitignoreRead: (path: string) => call<{ text: string | null }>('gitignore/read', { path }),

  /**
   * 把全文写回仓库根 `.gitignore`(上游 `saveGitIgnore`)。
   *
   * `text === ''` ⇒ 宿主**删掉**这个文件(上游 `gitignore.ts:110-116` 的既有语义,
   * 不是我们的发明)。行尾由宿主按 `core.autocrlf` / `core.safecrlf` 规整。
   */
  gitignoreSave: (path: string, text: string) => call<{ ok: true }>('gitignore/save', { path, text }),

  /**
   * 追加规则。`escape=false` ⇒ 上游 `appendIgnoreRule`(「忽略此模式」,原样);
   * `escape=true` ⇒ 上游 `appendIgnoreFile`(文件路径,先过
   * `escapeGitSpecialCharacters` 那张 `/[[\]!*#?]/g` 表)。
   */
  gitignoreAppend: (path: string, patterns: readonly string[], escape: boolean) =>
    call<{ ok: true }>('gitignore/append', { path, patterns: [...patterns], escape }),

  // ---------- 全局 gitconfig 文件(两处「edit global Git config」链接 + 锁文件) ----------
  /** 全局 gitconfig 的路径与存在性;锁文件同理。 */
  gitConfigFileInfo: () => call<{
    path: string | null;          // 解析出来的全局 gitconfig 绝对路径;解析不出 ⇒ null
    exists: boolean;
    lockPath: string | null;      // 约定为 <path>.lock
    lockExists: boolean;
  }>('config-file-info'),

  /** 用系统默认应用打开全局 gitconfig。不存在 ⇒ bad-request。 */
  openGitConfigFile: () => call<{ ok: true }>('config-file-open'),

  // ---------- 模型与生成 ----------
  models: () => call<{ models: { provider: string; providerName: string; id: string; name: string }[] }>('commit-message/models'),
  generate: (input: {
    path: string; files: string[]; stagedOnly: boolean; provider: string; model: string; systemPrompt?: string;
  }) => call<{ title: string; description: string; provider: string; model: string }>('commit-message/generate', input),

  // ---------- 登录 ----------
  authState: () => call<AuthStatePayload>('auth/state'),
  deviceStart: () => call<{ deviceCode: string; userCode: string; verificationUri: string; expiresIn: number; interval: number }>('auth/device-start'),
  devicePoll: (deviceCode: string) => call<
    | { status: 'pending'; slowDown?: boolean }
    | { status: 'done'; state: AuthStatePayload }
    | { status: 'error'; message: string }
  >('auth/device-poll', { deviceCode }),
  /**
   * PAT 登录。
   *
   * `endpoint` = GitHub **API 基址**(企业实例;`https://ghe.example.com` 这类 HTML 地址
   * 由 host 归一化成 `<host>/api/v3`,见 `host/auth.ts` 的 `normalizeGithubEndpoint`)。
   * 省略 ⇒ 沿用当前账号的端点(令牌轮换不改变账号身份);登出后回到默认
   * `https://api.github.com`。
   */
  setPat: (token: string, endpoint?: string) =>
    call<AuthStatePayload>('auth/pat', endpoint === undefined ? { token } : { token, endpoint }),
  logout: () => call<{ ok: true }>('auth/logout'),

  // ---------- 账号邮箱(Author 邮箱下拉 + misattribution 告警) ----------
  /** 用宿主令牌拉 GitHub /user/emails。未登录 ⇒ 空数组(不是错误)。 */
  accountEmails: () => call<{
    emails: { email: string; verified: boolean; primary: boolean; visibility: string | null }[];
  }>('auth/emails'),

  // ---------- 远程仓库 ----------
  remoteRepos: (force: boolean) => call<{ repos: RemoteRepo[]; hidden: string[] }>('remote-repos', { force }),
  hideRemote: (fullName: string) => call<{ hidden: string[] }>('remote-repos/hide', { fullName }),
  unhideRemote: (fullName: string) => call<{ hidden: string[] }>('remote-repos/unhide', { fullName }),

  // ---------- 历史 / 提交操作(本次新增) ----------
  /** 行级/块级丢弃:把 patch 反向应用到工作区(非 index)。 */
  discardLines: (path: string, file: string, patch: string) => call<{ ok: true }>('discard-lines', { path, file, patch }),
  /**
   * reset 到某个提交。`mode` 默认 `'mixed'`。
   *
   * ⚠️ **`worktreeDiscarded` 必须读**:`hard` 会**丢弃工作区改动** —— 本批 8 条路由里唯一一条
   * 破坏用户未提交数据的。host 侧如实返回了它(`src/host/routes.ts:792`,说明注释在 `:776`;
   * `src/host/git-service.ts:1127` 写明「调用方必须自己确认过再调」),上游的做法是真正 reset
   * 之前先弹 `PopupType.WarningBeforeReset`
   * (`references/desktop/app/src/ui/dispatcher/dispatcher.ts:960-967`)。
   *
   * 这个字段**原先没有出现在返回类型里** ⇒ 调用方在类型层看不到它,而当时也确实没有任何
   * 消费方(`grep -rn worktreeDiscarded src/client/` = 0 命中)。**接线时必须**:①读这个字段;
   * ②它为 `true` 时给出明确反馈(至少一条醒目 toast)—— 否则就是「成功返回 + 破坏性后果 +
   * 零反馈」,与本文件 `discardLines` 那个「补丁方向反了却不报错」是同一族缺陷。
   * 完整裁决与可回收条件见 `docs/discard-lines-contract.md` §5。
   */
  resetToCommit: (path: string, sha: string, mode: 'soft'|'mixed'|'hard' = 'mixed') =>
    call<{ ok: true; worktreeDiscarded?: boolean }>('reset-to-commit', { path, sha, mode }),
  /** 切到某个提交(分离头)。 */
  checkoutCommit: (path: string, sha: string) => call<{ ok: true }>('checkout-commit', { path, sha }),
  /** revert 某个提交。 */
  revertCommit: (path: string, sha: string) => call<{ ok: true }>('revert-commit', { path, sha }),
  /** cherry-pick 某个提交。 */
  cherryPickCommit: (path: string, sha: string) => call<{ ok: true }>('cherry-pick-commit', { path, sha }),
  tagCreate: (path: string, name: string, sha?: string) => call<{ ok: true }>('tag-create', { path, name, ...(sha !== undefined ? { sha } : {}) }),
  tagDelete: (path: string, name: string) => call<{ ok: true }>('tag-delete', { path, name }),
  /**
   * 「本地有、远端没有」的标签名 —— History 右键 `Delete tag <name>` 的 enabled 判据。
   *
   * 宿主侧是一次 `git push --dry-run --porcelain`(只问不推),**要碰网络**:
   * 调用方必须能接受它失败(远端不可达 / 没认证 / 根本没远端),并在失败时**保留旧值**,
   * 而不是把错误抛到界面上 —— 它是给一个菜单项做启用判定的辅助问询。
   * 形状见 `SHAPES['tag-unpushed']`;`remote` 一般不给(宿主按 `push()` 同一顺序选)。
   */
  tagUnpushed: (path: string, remote?: string) =>
    call<{ tags: string[] }>('tag-unpushed', { path, ...(remote !== undefined ? { remote } : {}) }),
  /** 删远端分支(git push <remote> --delete <branch>)。 */
  deleteRemoteBranch: (path: string, remote: string, branch: string) =>
    call<{ ok: true }>('remote-branch-delete', { path, remote, branch }),

  // ---------- stash 族(上游 `lib/git/stash.ts`,298 行) ----------

  /**
   * 列 stash。上游:`getStashes`(`lib/git/stash.ts:45-88`)。
   *
   * `desktopEntries` **只含** Desktop 建的条目(消息带 `!!GitHub_Desktop<branch>`);
   * `stashEntryCount` 是 `refs/stash` reflog 的总条数 ——
   * 与上游 `entries.length - 1` 的**已实测偏离**写在
   * `src/host/git-service.ts` 的 `stashList` JSDoc 上。
   */
  stashList: (path: string) =>
    call<{ desktopEntries: IStashEntryPayload[]; stashEntryCount: number }>('stash/list', { path }),

  /**
   * 建 stash。上游:`createDesktopStashEntry`(`lib/git/stash.ts:143-207`)。
   *
   * ⚠️ `untrackedFiles` **必须传**(调用方从 `status.files` 里挑 `untracked === true` 的那些):
   * 宿主会先把它们整份 `git add` 再 `stash push` —— 少了这一步,未跟踪文件
   * **不会被存进 stash**,切分支后它们会原地留下(上游注释直指 desktop/desktop#8085)。
   * @param branch - 当前分支名(进 stash 消息;detached/unborn 时调用方**不该**调它)。
   * @returns `created:false` = git 回了 `No local changes to save`(不是失败)。
   */
  stashPush: (path: string, branch: string, untrackedFiles: readonly string[]) =>
    call<{ ok: true; created: boolean }>('stash/push', { path, branch, untrackedFiles: [...untrackedFiles] }),

  /** 把一条 stash 应用回工作区并删掉它。上游:`popStashEntry`(`lib/git/stash.ts:238-271`)。 */
  stashPop: (path: string, sha: string) => call<{ ok: true }>('stash/pop', { path, sha }),

  /** 丢弃一条 stash(只动 reflog,不动工作区)。上游:`dropDesktopStashEntry`(`:219-229`)。 */
  stashDrop: (path: string, sha: string) => call<{ ok: true }>('stash/drop', { path, sha }),

  /**
   * 某条 stash 改了哪些文件。上游:`getStashedFiles`(`lib/git/stash.ts:279-297`)。
   * 每个 `status` 是 `AppFileStatus` 的 JSON 投影(见 `core/parse.ts` 的
   * `mapRawStatusToAppFileStatus`),`kind` 的取值与镜像 `models/status.ts` 的
   * `AppFileStatusKind` **逐字相同**。
   */
  stashShow: (path: string, sha: string) =>
    call<{ files: IStashFilePayload[]; linesAdded: number; linesDeleted: number }>('stash/show', { path, sha }),

  /**
   * 把一条 stash 挪到别的分支名下。上游:`moveStashEntry`(`lib/git/stash.ts:95-116`)。
   *
   * ⚠️ **今天没有产品调用点**:触发它的上游弹窗
   * (`ui/stash-changes/stash-and-switch-branch-dialog.tsx`)属于切分支那条面,
   * 本泳道没有接。包装先落地,接线时直接调它。
   */
  stashMove: (path: string, sha: string, branch: string) =>
    call<{ sha: string }>('stash/move', { path, sha, branch }),
  /*
   * ---------- 长连接(上游 `AliveStore`)----------
   *
   * 见 `src/client/alive.ts` 与 `docs/alive-connection-port.md`。**两条都是读**,
   * 令牌与 WS 地址都留在宿主(浏览器拿不到)。
   *
   * ⚠️ 这两条包在这里**不是风格问题**:浏览器半有一条 `no-restricted-syntax`
   * 明令**禁止直接调 `fetch()`**(它的报错文本就是说明书:「走 `api.ts` 或
   * `gh-api.ts` 这两条类型化传输层」)。第一版把 `fetch('dsh-git/alive/…')` 写在
   * `alive.ts` 里 ⇒ `check-lint` 新增 1 条违规。
   */
  aliveStatus: () => call<IAliveStatusPayload>('alive/status'),
  aliveEvents: (since: number) => call<IAliveEventsPayload>('alive/events', { since }),
};

/**
 * 宿主 `alive/status` 的载荷(`src/host/routes.ts` 的 `alive/status`)。
 *
 * `supported` 是**部署判据**:老 host 没有这条路由 ⇒ `ok:false`;
 * 有路由但**连接没建立** ⇒ `supported:true, listening:false`。
 * 客户端只信后者为「可以停轮询」——两者混淆会让通知彻底不来。
 */
export interface IAliveStatusPayload {
  /**
   * **宿主真的有那条长连接会话吗**(不是「宿主要求订阅了」)。
   *
   * 语义自 2026-10-08 起是**结果**:上游 `AliveStore` 里 `sessionPerEndpoint.size > 0`
   * **且** `subscriptions.length > 0`。404/403 那一档(端点没开 Alive)恒 `false`
   * ⇒ 客户端**维持轮询**。见 `docs/alive-connection-port.md` §12。
   */
  listening: boolean;
  /** 宿主有没有接长连接(`false` = 老宿主)。 */
  supported: boolean;
  /** 当前 endpoint。 */
  endpoint?: string;
  /** 收到过多少条事件。 */
  received?: number;
  /** 游标最大值。 */
  cursor?: number;
  /** 最近一次失败原因。 */
  lastError?: string | null;
}

/** 宿主 `alive/events` 的载荷。 */
export interface IAliveEventsPayload {
  /** 增量事件(`event` 是逐字的 `DesktopAliveEvent`,上游契约,不在这里逐字段声明)。 */
  events: ReadonlyArray<{ id: number; event: unknown; receivedAt: number }>;
  /** 下一次要用的游标。 */
  cursor: number;
}

/**
 * 一条 Desktop 建的 stash 条目 —— 宿主 `IStashEntryPayload`
 * (= 上游 `IStashEntry`,`references/desktop/app/src/models/stash-entry.ts:3-22`)的 JSON 投影。
 *
 * 字段名与上游**逐字相同**;`files` 那一段**不在这里**:上游也是两段式
 * (`getStashes` 只给条目,文件清单由 `getStashedFiles` 单独取、经
 * `loadFilesForCurrentStashEntry` 装进 `StashedChangesLoadStates` 状态机)。
 */
export interface IStashEntryPayload {
  /** 上游 `IStashEntry.name` = `%gD`,`refs/stash@{N}`。 */
  name: string;
  /** 上游 `IStashEntry.branchName`(从 stash 消息里解出来的分支名)。 */
  branchName: string;
  /** 上游 `IStashEntry.stashSha` = `%H`。 */
  stashSha: string;
  /** 上游 `IStashEntry.tree` = `%T`。 */
  tree: string;
  /** 上游 `IStashEntry.parents` = `%P`。 */
  parents: string[];
}

/**
 * 一条 stash 里的文件 —— 上游 `CommittedFileChange`(`models/status.ts:342-353`)的 JSON 投影。
 *
 * `status` 的 `kind` 取值与镜像的 `AppFileStatusKind` **逐字相同**
 * (`New` / `Modified` / `Deleted` / `Copied` / `Renamed` / `Untracked`),
 * 因此 `store.ts` 可以零映射地把它当成 `AppFileStatus` 构造 `CommittedFileChange`。
 */
export interface IStashFilePayload {
  path: string;
  status: {
    kind: string;
    oldPath?: string;
    renameIncludesModifications?: boolean;
    submoduleStatus?: {
      commitChanged: boolean;
      untrackedChanges: boolean;
      modifiedChanges: boolean;
    };
  };
  /** 上游 `CommittedFileChange.commitish` = 那条 stash 的 sha。 */
  commitish: string;
  /** 上游 `CommittedFileChange.parentCommitish` = `<sha>^`。 */
  parentCommitish: string;
}

/** 登录状态(仅尾 4 位)。 */
export interface AuthStatePayload {
  signedIn: boolean;
  login: string;
  tokenTail: string;
  /**
   * 当前账号的 GitHub **API 基址**(默认 `https://api.github.com`,企业账号是
   * 归一化后的企业 API 基址)。
   *
   * ⚠️ **老 host 不返回这个字段**(host 半不热重载,刷新页面只会拿到新前端):
   * 消费时必须按 `snap.auth.endpoint ?? 'https://api.github.com'` 兜底,
   * 不能直接把 `undefined` 显示出去 —— 与 `fileText` 的 `encoding`
   * (`api.ts:404-407` 那段「旧 host 不返回这个字段」)是同一条纪律。
   */
  endpoint: string;
  deviceFlow: boolean;
  viaDeviceFlow: boolean;
}

export type { BranchEntry, CommitDetail, CommitEntry, DiffResult, RepoEntry, RepoStatus, SyncState };
