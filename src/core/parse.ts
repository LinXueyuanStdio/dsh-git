/**
 * 纯解析函数:git 的机器可读输出 → 结构化快照。
 * 一切按 NUL / 记录分隔符顺序消费,路径含换行也不会出错。
 * 无 DOM、无 node API,便于 node:test 单测。
 * @module dsh-git/core/parse
 */

import type {
  BranchEntry, ChangeStatus, ChangedFile, CommitEntry, RepoStatus,
} from './types.ts';
import { LOG_FIELD_SEP, LOG_RECORD_SEP } from './git-argv.ts';
import {
  branchInfoFromHeaders, mapStatus, parsePorcelainStatus,
  type FileEntry,
} from './status-porcelain.ts';
// 远程 URL 解析沿用 Desktop(以前是自己写的正则,只认 github.com)
import { parseRemote, parseRepositoryIdentifier } from './desktop/lib/remote-parsing.ts';

export interface ParsedStatus {
  files: ChangedFile[];
  branch: string;
  headSha: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  unborn: boolean;
  detached: boolean;
}

/**
 * 原始 XY 两位码 → 暂存区/工作区状态字母。
 *
 * **刻意不用** Desktop 的 `mapStatus` 表来推这两个字段:那张表是为了选图标而写的
 * 「单一 kind」,对 `MM`(已暂存后又改)这类两侧都有值的组合会退化成
 * `index:'Unchanged'`,于是「已暂存+又改了」的文件会**只出现在「变更」组**,
 * 提交时还会被判成「没有已暂存的改动」。我们的界面是两行制,必须两侧都如实表达。
 * `mapStatus` 仍然用于冲突分类(那是它的强项)。
 */
function lettersFromXy(xy: string): { staged?: ChangeStatus; unstaged?: ChangeStatus } {
  const map = (c: string): ChangeStatus | undefined => {
    if (c === '.' || c === ' ' || c === '') return undefined;
    return c === '?' ? '?' : (c as ChangeStatus);
  };
  return { staged: map(xy[0] ?? '.'), unstaged: map(xy[1] ?? '.') };
}

/** 把分类后的 FileEntry 转成本插件的 ChangedFile。 */
function toChangedFile(
  path: string,
  entry: FileEntry,
  xy: string,
  oldPath?: string,
  renameScore?: number,
): ChangedFile {
  const base = {
    path,
    ...(oldPath !== undefined && oldPath !== '' ? { oldPath } : {}),
    ...(renameScore !== undefined ? { renameScore } : {}),
  };
  const sub = entry.submoduleStatus;
  const withSub = sub !== undefined
    ? {
      ...base,
      submodule: {
        commitChanged: sub.commitChanged,
        modifiedChanges: sub.modifiedChanges,
        untrackedChanges: sub.untrackedChanges,
      },
    }
    : base;

  if (entry.kind === 'untracked') {
    return { ...withSub, untracked: true, unstaged: '?' };
  }
  if (entry.kind === 'conflicted') {
    return {
      ...withSub,
      conflicted: true,
      conflict: { action: entry.action, us: entry.us, them: entry.them },
      // 冲突文件统一显示 U;两侧具体状态由 conflict 字段表达
      unstaged: 'U',
    };
  }
  // ordinary / renamed / copied:两侧都按原始 XY 如实给出
  const { staged, unstaged } = lettersFromXy(xy);
  return {
    ...withSub,
    ...(staged !== undefined ? { staged } : {}),
    ...(unstaged !== undefined ? { unstaged } : {}),
  };
}

/**
 * 解析 `status --porcelain=2 -z`。
 *
 * 解析与分类都走 core/status-porcelain(算法移植自 GitHub Desktop):那边有正则
 * 校验、重命名分数与完整的冲突分类表,这里只负责组装成 RepoStatus 需要的形状。
 * @param out - git 原始 stdout(必须来自带 -z 的调用)。
 */
export function parseStatus(out: string): ParsedStatus {
  const items = parsePorcelainStatus(out);
  const info = branchInfoFromHeaders(items);
  const files: ChangedFile[] = [];
  for (const item of items) {
    if (item.kind !== 'entry') continue;
    const entry = mapStatus(item.statusCode, item.submoduleStatusCode, item.renameOrCopyScore);
    files.push(toChangedFile(item.path, entry, item.statusCode, item.oldPath, item.renameOrCopyScore));
  }
  return {
    files,
    branch: info.head,
    headSha: info.oid,
    upstream: info.upstream,
    ahead: info.ahead,
    behind: info.behind,
    unborn: info.unborn,
    detached: info.detached,
  };
}

/** 磁盘标记 → 进行中的操作(与 git 本身无关,照 Desktop 的做法)。 */
export function operationFromMarkers(markers: {
  mergeHead: boolean;
  rebaseHead: boolean;
  rebaseMerge: boolean;
  cherryPickHead: boolean;
  revertHead: boolean;
}): RepoStatus['operation'] {
  if (markers.rebaseMerge || markers.rebaseHead) return 'rebase';
  if (markers.cherryPickHead) return 'cherry-pick';
  if (markers.revertHead) return 'revert';
  if (markers.mergeHead) return 'merge';
  return null;
}

/** 解析 `log --format=<LOG_FORMAT>%x1e` 的输出。 */
export function parseLog(out: string): CommitEntry[] {
  const commits: CommitEntry[] = [];
  for (const record of out.split(LOG_RECORD_SEP)) {
    const trimmed = record.replace(/^\n+/, '');
    if (trimmed.trim() === '') continue;
    const f = trimmed.split(LOG_FIELD_SEP);
    if (f.length < 12) continue;
    commits.push({
      sha: f[0],
      shortSha: f[1],
      subject: f[2],
      body: f[3].replace(/\n+$/, ''),
      authorName: f[4],
      authorEmail: f[5],
      authorDate: f[6],
      committerName: f[7],
      committerEmail: f[8],
      committerDate: f[9],
      parents: f[10].split(' ').filter((s) => s !== ''),
      refs: f[11].split(',').map((s) => s.trim()).filter((s) => s !== ''),
    });
  }
  return commits;
}

export interface NumstatRow {
  path: string;
  oldPath?: string;
  additions: number;
  deletions: number;
  binary: boolean;
}

/**
 * 解析 `--numstat -z`。
 * 形态:`<add>\t<del>\t<path>`;重命名时为 `<add>\t<del>\t\0<old>\0<new>`。
 */
export function parseNumstat(out: string): NumstatRow[] {
  const tokens = out.split('\0');
  const rows: NumstatRow[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '') continue;
    const firstTab = token.indexOf('\t');
    if (firstTab === -1) continue;
    const secondTab = token.indexOf('\t', firstTab + 1);
    if (secondTab === -1) continue;
    const addRaw = token.slice(0, firstTab);
    const delRaw = token.slice(firstTab + 1, secondTab);
    let path = token.slice(secondTab + 1);
    let oldPath: string | undefined;
    if (path === '') {
      oldPath = tokens[i + 1];
      path = tokens[i + 2] ?? '';
      i += 2;
    }
    const binary = addRaw === '-' || delRaw === '-';
    rows.push({
      path,
      ...(oldPath !== undefined && oldPath !== '' ? { oldPath } : {}),
      additions: binary ? 0 : Number(addRaw) || 0,
      deletions: binary ? 0 : Number(delRaw) || 0,
      binary,
    });
  }
  return rows;
}

/**
 * 解析 `--name-status -z`。
 * git 在 -z 下把状态与路径写成两个连续分段(不是 tab 分隔):
 *   `M\0a.txt\0`、`R100\0old.ts\0new.ts\0`、`D\0gone.ts\0`
 * 兼容带 tab 的实现(某些 git 版本/包装):先按 tab 切,再回退到分段配对。
 */
export function parseNameStatus(out: string): { path: string; oldPath?: string; status: ChangeStatus }[] {
  const tokens = out.split('\0').filter((token) => token !== '');
  const rows: { path: string; oldPath?: string; status: ChangeStatus }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const tab = token.indexOf('\t');
    const status = tab === -1 ? token : token.slice(0, tab);
    const inlinePath = tab === -1 ? '' : token.slice(tab + 1);
    const letter = (status[0] ?? 'M') as ChangeStatus;
    if (letter === 'R' || letter === 'C') {
      const oldPath = inlinePath !== '' ? inlinePath : (tokens[i + 1] ?? '');
      const next = inlinePath !== '' ? (tokens[i + 1] ?? '') : (tokens[i + 2] ?? '');
      rows.push({ oldPath, path: next, status: letter });
      i += inlinePath !== '' ? 1 : 2;
      continue;
    }
    const path = inlinePath !== '' ? inlinePath : (tokens[i + 1] ?? '');
    if (inlinePath === '') i += 1;
    rows.push({ path, status: letter });
  }
  return rows;
}

/** 解析 `for-each-ref --format=...%1f...`(symref 非空 = 符号引用,跳过)。 */
export function parseBranches(out: string): BranchEntry[] {
  const rows: BranchEntry[] = [];
  for (const raw of out.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.trim() === '') continue;
    const f = line.split('\x1f');
    if (f.length < 6) continue;
    const ref = f[0];
    const isRemote = ref.startsWith('refs/remotes/');
    if (isRemote && f[4] !== '') continue;
    rows.push({
      ref,
      name: f[1],
      isRemote,
      upstream: f[2] === '' ? null : f[2],
      sha: f[3],
      current: f[5] === '*',
    });
  }
  return rows;
}

/** `remote` 输出 → 名字列表。 */
export function parseRemotes(out: string): string[] {
  return out.split('\n').map((s) => s.trim()).filter((s) => s !== '');
}

/** `tag -l` 输出 → 标签列表。 */
export function parseTags(out: string): string[] {
  return out.split('\n').map((s) => s.trim()).filter((s) => s !== '');
}

/** 结构化 status 结果 + 磁盘标记 → 供界面直接消费的快照。 */
export function buildRepoStatus(input: {
  root: string;
  parsed: ParsedStatus;
  operation: RepoStatus['operation'];
}): RepoStatus {
  const { parsed } = input;
  let stagedCount = 0;
  let unstagedCount = 0;
  let untrackedCount = 0;
  let conflictedCount = 0;
  for (const file of parsed.files) {
    if (file.conflicted) conflictedCount += 1;
    if (file.untracked) untrackedCount += 1;
    if (file.staged !== undefined) stagedCount += 1;
    if (file.unstaged !== undefined && !file.untracked) unstagedCount += 1;
  }
  return {
    root: input.root,
    branch: parsed.branch,
    headSha: parsed.headSha,
    detached: parsed.detached,
    unborn: parsed.unborn,
    upstream: parsed.upstream,
    ahead: parsed.ahead,
    behind: parsed.behind,
    files: parsed.files,
    stagedCount,
    unstagedCount,
    untrackedCount,
    conflictedCount,
    operation: input.operation,
  };
}

/** 从 diff 头里剥掉 a/ b/ 前缀。 */
export function stripDiffPrefix(path: string): string {
  return path.replace(/^[ab]\//, '');
}

/** 解析 `git config --get` 的输出(未设置返回 null)。 */
export function parseConfigValue(out: string): string | null {
  const v = out.replace(/\n$/, '');
  return v === '' ? null : v;
}

/** 解析 `git remote get-url` 可能的多行(取第一行非空)。 */
export function firstLine(out: string): string {
  for (const line of out.split('\n')) {
    const t = line.trim();
    if (t !== '') return t;
  }
  return '';
}

/**
 * 把 `.git/config` 或 remote URL 解析成 GitHub 的 owner/repo。
 * 支持 https://github.com/o/r(.git)、git@github.com:o/r.git、ssh://git@github.com/o/r。
 */
/**
 * 从 `git remote -v` 的一行里解析 GitHub 仓库的 owner/repo。
 *
 * 实现**沿用 GitHub Desktop** 的 `lib/remote-parsing.ts`:先按远程 URL 解析
 * (`parseRemote`,支持 https / ssh / git:// 与可选凭据前缀),失败再按
 * `owner/name` 简写解析(`parseRepositoryIdentifier`)。
 * 我们以前自己写了个正则,只认 github.com,而且漏了 `git://` 与带凭据的形态。
 * @param text - 例如 `origin\thttps://github.com/o/r.git (fetch)`。
 * @returns owner/repo;不是 GitHub 仓库时返回 null。
 */
export function parseGithubRemoteText(text: string): { owner: string; repo: string } | null {
  // 取第一个词(URL)之前的冒号/制表符切分交给调用方,这里只挑出 URL 片段。
  const url = text.split(/\s+/).find((piece) => piece.includes('/') || piece.startsWith('git@')) ?? text.trim();
  const parsed = parseRemote(url);
  if (parsed !== null && parsed.owner !== '' && parsed.name !== '') {
    return { owner: parsed.owner, repo: parsed.name };
  }
  const shortcut = parseRepositoryIdentifier(url);
  if (shortcut !== null && shortcut.hostname === null) {
    return { owner: shortcut.owner, repo: shortcut.name };
  }
  return null;
}
