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

/**
 * `git push --dry-run --porcelain` 的输出 → 「远端还没有的那些标签」。
 *
 * **逐字搬运上游** `references/desktop/app/src/lib/git/tag.ts:118-137`
 * (`fetchTagsToPush` 的解析段),只把 `let currentLine = 1; while (…)` 那条下标循环
 * 换成 `for`,其余(从第 2 行开始、遇 `Done` 停、按 `\t` 切三段、只认
 * `parts[0] === '*' && parts[2] === '[new tag]'`、取 `parts[1].split(':')[0]`
 * 并剥 `refs/tags/` 前缀)**一字不改**。
 *
 * 为什么从**第 2 行**开始:porcelain 的第 1 行永远是 `To <url-or-path>`
 * (实测输出形状 —— 见 `unpushedTagsArgv` 的注释);从第 1 行开始扫时
 * `parts[2]` 恒 undefined ⇒ 幸运地不误报,但那是**巧合**而不是判据,
 * 所以照上游保留这个偏移。
 *
 * 已推送的标签在同一份输出里是 `=\trefs/tags/v1:…\t[up to date]`(实测),
 * 第一段是 `=` 而不是 `*` ⇒ 天然被过滤(这就是「已推送的标签不许出现在结果里」
 * 那条阴性对照在**解析层**上的保证)。
 * @param out - `git push --dry-run --porcelain` 的 stdout。
 */
export function parseUnpushedTags(out: string): string[] {
  const lines = out.split('\n');
  const unpushedTags: string[] = [];
  for (let currentLine = 1; currentLine < lines.length && lines[currentLine] !== 'Done'; currentLine++) {
    const parts = lines[currentLine].split('\t');
    if (parts[0] === '*' && parts[2] === '[new tag]') {
      const [tagName] = parts[1].split(':');
      if (tagName !== undefined) {
        unpushedTags.push(tagName.replace(/^refs\/tags\//, ''));
      }
    }
  }
  return unpushedTags;
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

// ---------- stash:文件清单(`git stash show <sha> --raw --numstat -z …`) ----------

/**
 * 子模块的文件模式。git 用它标记 submodule(取值依据见上游
 * `lib/git/log.ts:20-21` 的注释与它给的 git 源码链接)。
 */
const SUBMODULE_FILE_MODE = '160000';

/**
 * `AppFileStatus` 的 **JSON 投影** —— 字段名与取值和镜像的
 * `models/status.ts`(`AppFileStatusKind` / `SubmoduleStatus`)**逐字相同**,
 * 所以客户端可以零映射地把它当成 `AppFileStatus` 用。
 *
 * 为什么不在 host 侧构造 `CommittedFileChange` 实例:那是客户端模型类,
 * 而 HTTP 信封只能带纯 JSON。把**判别联合**原样搬过线,比在两端各写一份
 * 「字母 → kind」的映射安全(一份映射,一个真源)。
 */
export interface IStashFileStatusJson {
  readonly kind: string;
  readonly oldPath?: string;
  readonly renameIncludesModifications?: boolean;
  readonly submoduleStatus?: {
    readonly commitChanged: boolean;
    readonly untrackedChanges: boolean;
    readonly modifiedChanges: boolean;
  };
}

/** {@link parseRawLogWithNumstat} 的一项 —— 上游 `CommittedFileChange` 的 JSON 投影。 */
export interface IStashFileEntry {
  readonly path: string;
  readonly status: IStashFileStatusJson;
  /** 上游 `CommittedFileChange.commitish` = 传进来的 `sha`。 */
  readonly commitish: string;
  /** 上游 `CommittedFileChange.parentCommitish` = 传进来的 `<sha>^`。 */
  readonly parentCommitish: string;
}

/**
 * 上游 `mapSubmoduleStatusFileModes`(`lib/git/log.ts:23-42`,逐字搬运)。
 *
 * 只有三种组合会被认成「子模块状态」:两侧都是 160000 且 `M`(子模块的提交被换过),
 * 或 `D`/`A` 的一侧是 160000。其余一律 `undefined`(普通文件)。
 */
function mapSubmoduleStatusFileModes(
  status: string,
  srcMode: string,
  dstMode: string,
):
  | { commitChanged: boolean; untrackedChanges: boolean; modifiedChanges: boolean }
  | undefined {
  return srcMode === SUBMODULE_FILE_MODE
    && dstMode === SUBMODULE_FILE_MODE
    && status === 'M'
    ? { commitChanged: true, untrackedChanges: false, modifiedChanges: false }
    : (srcMode === SUBMODULE_FILE_MODE && status === 'D')
      || (dstMode === SUBMODULE_FILE_MODE && status === 'A')
      ? { commitChanged: false, untrackedChanges: false, modifiedChanges: false }
      : undefined;
}

/**
 * 原始状态字母 → `AppFileStatus` 形状(上游 `mapStatus`,`lib/git/log.ts:50-115`,逐字搬运)。
 *
 * 与 `status-porcelain.ts` 的 `mapStatus` **不是**同一个东西:那一份的输入是
 * `git status --porcelain` 的**两位码**,输出是我们的两行制 `ChangedFile`;这一份的输入是
 * `--raw` 的**单字母**,输出是 Desktop 的 `AppFileStatus` 判别联合(为选图标而设计)。
 * 两者的输入输出都不同,合并不了。
 * @param rawStatus - `--raw` 的状态字段(可能带重命名相似度,如 `R100`)。
 * @param oldPath - 重命名/复制的**源**路径(`R`/`C` 才有)。
 * @param srcMode - 源文件模式(八进制字符串,如 `100644` / `160000`)。
 * @param dstMode - 目标文件模式。
 */
export function mapRawStatusToAppFileStatus(
  rawStatus: string,
  oldPath: string | undefined,
  srcMode: string,
  dstMode: string,
): IStashFileStatusJson {
  const status = rawStatus.trim();
  const submoduleStatus = mapSubmoduleStatusFileModes(status, srcMode, dstMode);

  if (status === 'M') {
    return { kind: 'Modified', submoduleStatus };
  }
  if (status === 'A') {
    return { kind: 'New', submoduleStatus };
  }
  if (status === '?') {
    return { kind: 'Untracked', submoduleStatus };
  }
  if (status === 'D') {
    return { kind: 'Deleted', submoduleStatus };
  }
  if (status === 'R' && oldPath !== undefined) {
    return { kind: 'Renamed', oldPath, submoduleStatus, renameIncludesModifications: false };
  }
  if (status === 'C' && oldPath !== undefined) {
    return { kind: 'Copied', oldPath, submoduleStatus, renameIncludesModifications: false };
  }
  // `git log -M --name-status` 会给出 `RXXX`(XXX = 相似度百分比)。
  if (/R[0-9]+/.test(status) && oldPath !== undefined) {
    return { kind: 'Renamed', oldPath, submoduleStatus, renameIncludesModifications: status !== 'R100' };
  }
  // `git log -C --name-status` 会给出 `CXXX`。
  if (/C[0-9]+/.test(status) && oldPath !== undefined) {
    return { kind: 'Copied', oldPath, submoduleStatus, renameIncludesModifications: false };
  }
  return { kind: 'Modified', submoduleStatus };
}

/** 上游 `isCopyOrRename`(`lib/git/log.ts:117-121`)。 */
function isCopyOrRename(status: IStashFileStatusJson): boolean {
  return status.kind === 'Copied' || status.kind === 'Renamed';
}

/**
 * 上游 `forceUnwrap`(`lib/fatal-error.ts`)在本模块的等价物:拿不到就**抛**,
 * 绝不把 `undefined` 当成合法值混过去(那会变成「清单里凭空少一个文件」)。
 */
function forceUnwrap<T>(message: string, value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error(message);
  }
  return value;
}

/**
 * 解析 `diff -z --raw --numstat` 的输出(上游 `parseRawLogWithNumstat`,
 * `lib/git/log.ts:283-328`,逐字搬运)。
 *
 * 上游注释里的样例(那里按行写开,实际全以 `\0` 分隔):
 *
 * ```
 * :100644 100644 5716ca5 db3c77d M\0file_one_path\0:100644 100644 0835e4f 28096ea M\0file_two_path\0
 * 1\t0\tfile_one_path\0
 * 1\t0\tfile_two_path\0
 * ```
 *
 * **重命名/复制是两段**:`--raw` 段把 `oldPath` 与 `path` 放在**两条**记录里
 * (`R`/`C` 才有),numstat 段同样两个路径各占一条。这就是 `lines.at(++i)` 与
 * `i += 2` 的来历。
 *
 * ⚠️ **它返回的是「文件」,不是「每个文件的增删数」**:上游只用 numstat 段累加
 * **总量**(`linesAdded` / `linesDeleted`)并推进游标;单个文件的增删数由
 * **取 diff 的那条路由**给(`diffNumstatArgv`)。我们的 stash 文件清单消费方只需要
 * path + status(文件行的渲染不显示增删数),所以这里与上游同形。
 * @param out - `git stash show <sha> --raw --numstat -z --format=format: --no-show-signature --` 的 stdout。
 * @param sha - stash 那条提交的 sha(上游 `getStashedFiles` 传的是参数 `stashSha`)。
 * @param parentCommitish - 上游传 `` `${stashSha}^` ``。
 */
export function parseRawLogWithNumstat(
  out: string,
  sha: string,
  parentCommitish: string,
): { files: IStashFileEntry[]; linesAdded: number; linesDeleted: number } {
  const files: IStashFileEntry[] = [];
  let linesAdded = 0;
  let linesDeleted = 0;
  let numStatCount = 0;
  const lines = out.split('\0');

  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i];
    if (line.startsWith(':')) {
      const lineComponents = line.split(' ');
      const srcMode = forceUnwrap('Invalid log output (srcMode)', lineComponents[0]?.replace(':', ''));
      const dstMode = forceUnwrap('Invalid log output (dstMode)', lineComponents[1]);
      const status = forceUnwrap('Invalid log output (status)', lineComponents.at(-1));
      const oldPath = /^R|C/.test(status)
        ? forceUnwrap('Missing old path', lines.at(++i))
        : undefined;

      const path = forceUnwrap('Missing path', lines.at(++i));

      files.push({
        path,
        status: mapRawStatusToAppFileStatus(status, oldPath, srcMode, dstMode),
        commitish: sha,
        parentCommitish,
      });
    } else {
      const match = /^(\d+|-)\t(\d+|-)\t/.exec(line);
      const [, added, deleted] = forceUnwrap('Invalid numstat line', match);
      linesAdded += added === '-' ? 0 : parseInt(added, 10);
      linesDeleted += deleted === '-' ? 0 : parseInt(deleted, 10);

      // 重命名/复制的 numstat 段把两个路径放成两条独立记录,跳过它们。
      const first = files[numStatCount];
      if (first !== undefined && isCopyOrRename(first.status)) {
        i += 2;
      }
      numStatCount++;
    }
  }

  return { files, linesAdded, linesDeleted };
}
