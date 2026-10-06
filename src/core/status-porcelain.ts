/**
 * porcelain v2 状态解析 —— **算法移植自 GitHub Desktop**
 * (`references/desktop/app/src/lib/status-parser.ts`, 见 vendor/desktop/status-parser.ts)。
 *
 * 为什么移植而不是自己写:Desktop 这版有我们手写版缺的三样东西
 *   1. 三种记录类型都有**正则校验**,形状不符就报错,而不是静默错解路径;
 *   2. 解析重命名/复制的相似度分数(`<X><score>`)与 submodule 状态码(`SCM/U`);
 *   3. `mapStatus` 的**完整冲突分类表**(DD/AU/UD/UA/DU/AA/UU → 谁改谁删),
 *      我们那版只有一个 `conflicted: true` 布尔,连「我方删除/对方修改」都分不出来。
 *
 * 适配:Desktop 的 `FileEntry` 用它自己的 model 词表(见 models-status.ts),这里换成本
 * 插件的词表(见 ../core/types.ts);解析与分类逻辑保持一一对应。
 * @module dsh-git/core/status-porcelain
 */

/** 索引/工作区里某个条目的状态(对应 Desktop 的 GitStatusEntry)。 */
export type GitStatusEntryCode =
  | 'Unchanged'
  | 'Modified'
  | 'Added'
  | 'Deleted'
  | 'Renamed'
  | 'Copied'
  | 'UpdatedButUnmerged';

/** 冲突的「谁对谁」摘要(对应 Desktop 的 UnmergedEntrySummary)。 */
export type ConflictSummary =
  | 'BothDeleted'
  | 'AddedByUs'
  | 'DeletedByThem'
  | 'AddedByThem'
  | 'DeletedByUs'
  | 'BothAdded'
  | 'BothModified';

/** submodule 的变更位(对应 Desktop 的 SubmoduleStatus)。 */
export interface SubmoduleStatus {
  commitChanged: boolean;
  modifiedChanges: boolean;
  untrackedChanges: boolean;
}

/** 分类后的文件状态(对应 Desktop 的 FileEntry)。 */
export type FileEntry =
  | { kind: 'untracked'; submoduleStatus?: SubmoduleStatus }
  | {
    kind: 'ordinary';
    type: 'modified' | 'added' | 'deleted';
    index: GitStatusEntryCode;
    workingTree: GitStatusEntryCode;
    submoduleStatus?: SubmoduleStatus;
  }
  | {
    kind: 'renamed';
    index: GitStatusEntryCode;
    workingTree: GitStatusEntryCode;
    renameOrCopyScore?: number;
    submoduleStatus?: SubmoduleStatus;
  }
  | {
    kind: 'copied';
    index: GitStatusEntryCode;
    workingTree: GitStatusEntryCode;
    submoduleStatus?: SubmoduleStatus;
  }
  | {
    kind: 'conflicted';
    action: ConflictSummary;
    us: GitStatusEntryCode;
    them: GitStatusEntryCode;
    submoduleStatus?: SubmoduleStatus;
  };

/** 一条原始记录:头信息或文件条目。 */
export type StatusItem =
  | { kind: 'header'; value: string }
  | {
    kind: 'entry';
    path: string;
    statusCode: string;
    submoduleStatusCode: string;
    oldPath?: string;
    renameOrCopyScore?: number;
  };

const CHANGED = '1';
const RENAMED_OR_COPIED = '2';
const UNMERGED = 'u';
const UNTRACKED = '?';
const IGNORED = '!';

/**
 * 解析 `git status --porcelain=2 -z` 的输出。
 *
 * 注意 -z 的语义(Desktop 注释里也强调了):重命名记录的字段顺序是**反的**
 * (to from),`->` 被省略,每条记录后跟一个 NUL;因此重命名的新路径在本条,
 * 旧路径是**下一个**分段,必须显式消费掉。
 * @param output - git 原始 stdout。
 * @returns 头信息与文件条目,顺序与 git 输出一致。
 */
export function parsePorcelainStatus(output: string): StatusItem[] {
  const entries: StatusItem[] = [];
  const tokens = output.split('\0');

  for (let i = 0; i < tokens.length; i++) {
    const field = tokens[i];
    if (field === '') continue;

    if (field.startsWith('# ') && field.length > 2) {
      entries.push({ kind: 'header', value: field.substring(2) });
      continue;
    }

    const entryKind = field.substring(0, 1);
    if (entryKind === CHANGED) {
      entries.push(parseChangedEntry(field));
    } else if (entryKind === RENAMED_OR_COPIED) {
      // 旧路径是紧接着的下一个分段
      const oldPath = tokens[i + 1];
      i += 1;
      entries.push(parsedRenamedOrCopiedEntry(field, oldPath));
    } else if (entryKind === UNMERGED) {
      entries.push(parseUnmergedEntry(field));
    } else if (entryKind === UNTRACKED) {
      entries.push(parseUntrackedEntry(field));
    } else if (entryKind === IGNORED) {
      // 忽略的条目按 Desktop 的做法直接跳过
    }
  }

  return entries;
}

// 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
const changedEntryRe = /^1 ([MADRCUTX?!.]{2}) (N\.\.\.|S[C.][M.][U.]) (\d+) (\d+) (\d+) ([a-f0-9]+) ([a-f0-9]+) ([\s\S]*?)$/;

function parseChangedEntry(field: string): StatusItem {
  const match = changedEntryRe.exec(field);
  if (match === null) {
    // Desktop 在这里 log.debug 后 throw;我们没有 logger,直接抛出可定位的错误。
    throw new Error(`porcelain v2: 无法解析改动条目: ${field.slice(0, 200)}`);
  }
  return {
    kind: 'entry',
    statusCode: match[1],
    submoduleStatusCode: match[2],
    path: match[8],
  };
}

// 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path><sep><origPath>
const renamedOrCopiedEntryRe = /^2 ([MADRCUTX?!.]{2}) (N\.\.\.|S[C.][M.][U.]) (\d+) (\d+) (\d+) ([a-f0-9]+) ([a-f0-9]+) ([RC]\d+) ([\s\S]*?)$/;

function parsedRenamedOrCopiedEntry(field: string, oldPath: string | undefined): StatusItem {
  const match = renamedOrCopiedEntryRe.exec(field);
  if (match === null) {
    throw new Error(`porcelain v2: 无法解析重命名/复制条目: ${field.slice(0, 200)}`);
  }
  if (oldPath === undefined || oldPath === '') {
    throw new Error('porcelain v2: 重命名条目缺少旧路径分段');
  }
  return {
    kind: 'entry',
    statusCode: match[1],
    submoduleStatusCode: match[2],
    oldPath,
    renameOrCopyScore: Number.parseInt(match[8].substring(1), 10),
    path: match[9],
  };
}

// u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
const unmergedEntryRe = /^u ([DAU]{2}) (N\.\.\.|S[C.][M.][U.]) (\d+) (\d+) (\d+) (\d+) ([a-f0-9]+) ([a-f0-9]+) ([a-f0-9]+) ([\s\S]*?)$/;

function parseUnmergedEntry(field: string): StatusItem {
  const match = unmergedEntryRe.exec(field);
  if (match === null) {
    throw new Error(`porcelain v2: 无法解析冲突条目: ${field.slice(0, 200)}`);
  }
  return {
    kind: 'entry',
    statusCode: match[1],
    submoduleStatusCode: match[2],
    path: match[10],
  };
}

function parseUntrackedEntry(field: string): StatusItem {
  // Desktop 用 '??' 而不是 '?' 来配合 mapStatus 的分派,这里保持一致。
  return {
    kind: 'entry',
    statusCode: '??',
    submoduleStatusCode: '????',
    path: field.substring(2),
  };
}

function mapSubmoduleStatus(submoduleStatusCode: string): SubmoduleStatus | undefined {
  if (!submoduleStatusCode.startsWith('S')) return undefined;
  return {
    commitChanged: submoduleStatusCode[1] === 'C',
    modifiedChanges: submoduleStatusCode[2] === 'M',
    untrackedChanges: submoduleStatusCode[3] === 'U',
  };
}

/**
 * 把两位状态码映射成可用的文件状态。
 * 这张表逐条对应 Desktop 的 `mapStatus`,包括最后「无法归类就当 modified」的兜底。
 */
export function mapStatus(
  statusCode: string,
  submoduleStatusCode: string,
  renameOrCopyScore?: number,
): FileEntry {
  const submoduleStatus = mapSubmoduleStatus(submoduleStatusCode);

  if (statusCode === '??') return { kind: 'untracked', submoduleStatus };

  switch (statusCode) {
    case '.M':
      return { kind: 'ordinary', type: 'modified', index: 'Unchanged', workingTree: 'Modified', submoduleStatus };
    case 'M.':
      return { kind: 'ordinary', type: 'modified', index: 'Modified', workingTree: 'Unchanged', submoduleStatus };
    case '.A':
      return { kind: 'ordinary', type: 'added', index: 'Unchanged', workingTree: 'Added', submoduleStatus };
    case 'A.':
      return { kind: 'ordinary', type: 'added', index: 'Added', workingTree: 'Unchanged', submoduleStatus };
    case '.D':
      return { kind: 'ordinary', type: 'deleted', index: 'Unchanged', workingTree: 'Deleted', submoduleStatus };
    case 'D.':
      return { kind: 'ordinary', type: 'deleted', index: 'Deleted', workingTree: 'Unchanged', submoduleStatus };
    case 'R.':
      return { kind: 'renamed', index: 'Renamed', workingTree: 'Unchanged', renameOrCopyScore, submoduleStatus };
    case '.R':
      return { kind: 'renamed', index: 'Unchanged', workingTree: 'Renamed', renameOrCopyScore, submoduleStatus };
    case 'C.':
      return { kind: 'copied', index: 'Copied', workingTree: 'Unchanged', submoduleStatus };
    case '.C':
      return { kind: 'copied', index: 'Unchanged', workingTree: 'Copied', submoduleStatus };
    case 'AD':
      return { kind: 'ordinary', type: 'added', index: 'Added', workingTree: 'Deleted', submoduleStatus };
    case 'AM':
      return { kind: 'ordinary', type: 'added', index: 'Added', workingTree: 'Modified', submoduleStatus };
    case 'RM':
      return { kind: 'renamed', index: 'Renamed', workingTree: 'Modified', renameOrCopyScore, submoduleStatus };
    case 'RD':
      return { kind: 'renamed', index: 'Renamed', workingTree: 'Deleted', renameOrCopyScore, submoduleStatus };
    case 'DD':
      return { kind: 'conflicted', action: 'BothDeleted', us: 'Deleted', them: 'Deleted', submoduleStatus };
    case 'AU':
      return { kind: 'conflicted', action: 'AddedByUs', us: 'Added', them: 'UpdatedButUnmerged', submoduleStatus };
    case 'UD':
      return { kind: 'conflicted', action: 'DeletedByThem', us: 'UpdatedButUnmerged', them: 'Deleted', submoduleStatus };
    case 'UA':
      return { kind: 'conflicted', action: 'AddedByThem', us: 'UpdatedButUnmerged', them: 'Added', submoduleStatus };
    case 'DU':
      return { kind: 'conflicted', action: 'DeletedByUs', us: 'Deleted', them: 'UpdatedButUnmerged', submoduleStatus };
    case 'AA':
      return { kind: 'conflicted', action: 'BothAdded', us: 'Added', them: 'Added', submoduleStatus };
    case 'UU':
      return { kind: 'conflicted', action: 'BothModified', us: 'UpdatedButUnmerged', them: 'UpdatedButUnmerged', submoduleStatus };
    default:
      // 兜底:当成 ordinary/modified(与 Desktop 一致)
      return { kind: 'ordinary', type: 'modified', index: 'Unchanged', workingTree: 'Modified', submoduleStatus };
  }
}

/** 冲突摘要 → 中文文案(界面用;Desktop 用 i18n 字典)。 */
export function conflictSummaryText(action: ConflictSummary): string {
  switch (action) {
    case 'BothDeleted': return '双方都删除了';
    case 'AddedByUs': return '我方新增,对方也动过';
    case 'DeletedByThem': return '对方删除,我方修改';
    case 'AddedByThem': return '对方新增,我方也动过';
    case 'DeletedByUs': return '我方删除,对方修改';
    case 'BothAdded': return '双方都新增了同名文件';
    case 'BothModified': return '双方都修改了';
  }
}

/** 解析 `<XY> <sub> ...` 头里的分支信息(git status --branch 的 `# branch.*`)。 */
export interface BranchHeaderInfo {
  oid: string;
  head: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  detached: boolean;
  unborn: boolean;
}

/** 从状态头信息里提取分支信息(Desktop 在 lib/git/status.ts 里做同样的事)。 */
export function branchInfoFromHeaders(entries: readonly StatusItem[]): BranchHeaderInfo {
  const info: BranchHeaderInfo = {
    oid: '', head: '', upstream: null, ahead: 0, behind: 0, detached: false, unborn: false,
  };
  for (const entry of entries) {
    if (entry.kind !== 'header') continue;
    const space = entry.value.indexOf(' ');
    const key = space === -1 ? entry.value : entry.value.slice(0, space);
    const value = space === -1 ? '' : entry.value.slice(space + 1);
    if (key === 'branch.oid') {
      if (value === '(initial)') info.unborn = true;
      else info.oid = value;
    } else if (key === 'branch.head') {
      if (value === '(detached)') info.detached = true;
      else info.head = value;
    } else if (key === 'branch.upstream') {
      info.upstream = value;
    } else if (key === 'branch.ab') {
      const match = /^\+(\d+)\s+-(\d+)$/.exec(value);
      if (match !== null) {
        info.ahead = Number(match[1]);
        info.behind = Number(match[2]);
      }
    }
  }
  return info;
}
