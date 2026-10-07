/**
 * 纯函数 argv 构造:每个 git 调用集中在这里,便于单测与审计。
 * 约定(照 GitHub Desktop 的工程细节):
 *  - 一律 `--end-of-options` 之后才放用户给的 revision;
 *  - 用户给的路径用 `--` 结尾隔离;
 *  - diff 一律 `--no-ext-diff --no-color`,避免用户外部 diff 程序破坏解析;
 *  - status 用 `--no-optional-locks`,只读查询不抢 index.lock。
 * @module dsh-git/core/git-argv
 */

/** win32 用 git.exe 绕开 .cmd/.bat shim(dsh-subprocess 不过 shell)。 */
export function withGitBinary(platform: string, argv: readonly string[]): readonly string[] {
  return platform === 'win32' ? ['git.exe', ...argv] : ['git', ...argv];
}

/** 需要无仓库上下文的命令(discover / clone / init)。 */
export function versionArgv(): readonly string[] {
  return ['--version'];
}

export function statusArgv(): readonly string[] {
  return ['--no-optional-locks', 'status', '--untracked-files=all', '--branch', '--porcelain=2', '-z'];
}

export function headBranchArgv(): readonly string[] {
  return ['rev-parse', '--abbrev-ref', 'HEAD'];
}

export function headShaArgv(): readonly string[] {
  return ['rev-parse', 'HEAD'];
}

export function isInsideWorkTreeArgv(cwd: string): readonly string[] {
  return ['-C', cwd, 'rev-parse', '--is-inside-work-tree'];
}

export function topLevelArgv(cwd: string): readonly string[] {
  return ['-C', cwd, 'rev-parse', '--show-toplevel'];
}

export function repoRootArgv(): readonly string[] {
  return ['rev-parse', '--show-toplevel'];
}

export function remoteListArgv(): readonly string[] {
  return ['remote'];
}

export function remoteUrlArgv(name: string): readonly string[] {
  return ['remote', 'get-url', '--', name];
}

export function remoteSetUrlArgv(name: string, url: string): readonly string[] {
  return ['remote', 'set-url', '--', name, url];
}

export function remoteSetHeadArgv(name: string): readonly string[] {
  return ['remote', 'set-head', '-a', '--', name];
}

/**
 * 工作区改动(未暂存变更)= index → 工作区。
 *
 * 与 GitHub Desktop 的**有意分歧**:
 * Desktop 的 `getWorkingDirectoryDiff` 对普通文件传 `HEAD -- <path>`
 * (references/desktop/app/src/lib/git/diff.ts:393),那是配合它「一个文件一行 +
 * 三态复选框」的模型:一行里同时表达已暂存与未暂存,所以用 HEAD 做基准。
 * 我们的 Changes 是**两行制**(同一个文件在「已暂存」和「变更」各占一行),
 * 若未暂存那行也用 HEAD,已经把内容移进暂存区的改动会在两行里各出现一次。
 * 因此这里保持 index→工作区;需要 Desktop 语义时显式传 `againstHead: true`。
 * @param path - 仓库内相对路径。
 */
export function diffUnstagedArgv(
  path?: string,
  opts: { againstHead?: boolean; ignoreWhitespace?: boolean } = {},
): readonly string[] {
  // 注意:--no-ext-diff / --no-color 是 diff 的子命令选项,必须在 'diff' 之后。
  const base = ['diff', '--no-ext-diff', '--no-color'];
  // 「隐藏空白改动」是**重新用 -w 跑一次 git**,不是在界面里过滤:
  // 这样行为与 git 一致,而且行号不会错位。Desktop 在它每一条 diff 命令上都传 -w
  // (`lib/git/diff.ts:124,165,212,353,499`)。
  if (opts.ignoreWhitespace === true) {
    base.push('-w');
  }
  if (path === undefined) {
    return base;
  }
  return opts.againstHead === true ? [...base, 'HEAD', '--', path] : [...base, '--', path];
}

/** 暂存区 vs HEAD(已暂存变更)。 */
export function diffStagedArgv(path?: string, opts: { ignoreWhitespace?: boolean } = {}): readonly string[] {
  const base = ['diff', '--cached', '--no-ext-diff', '--no-color'];
  if (opts.ignoreWhitespace === true) {
    base.push('-w');
  }
  return path === undefined ? base : [...base, '--', path];
}

/** 未跟踪文件:与 /dev/null 做 --no-index 比较。 */
export function diffUntrackedArgv(path: string): readonly string[] {
  return ['diff', '--no-index', '--no-ext-diff', '--no-color', '--', '/dev/null', path];
}

/** 单个提交针对某文件的补丁(--first-parent + -m 避免合并提交歧义)。 */
export function diffCommitArgv(sha: string, path?: string, opts: { ignoreWhitespace?: boolean } = {}): readonly string[] {
  const base = [
    'log', '-m', '-1', '--first-parent', '--patch', '--format=',
    '--no-ext-diff', '--no-color', '--end-of-options', sha,
  ];
  if (opts.ignoreWhitespace === true) {
    base.push('-w');
  }
  return path === undefined ? base : [...base, '--', path];
}

/**
 * 取某个修订下某个文件的内容(blob)。
 *
 * 用途:语法高亮要按版本取「旧/新」两份文本;图片 diff 要 base64 二进制。
 * `--end-of-options` 之后 `rev:path` 整体是一个**操作数**,所以以 `-` 开头的
 * 修订名不会被当成选项。
 *
 * 注意:只走文本路径。runner 目前只回字符串(stdout: string),二进制内容会被
 * 破坏,所以二进制文件由调用方按 `kind` 报出而不返回内容。
 * @param rev - 修订(提交号、分支、`HEAD` 等)。
 * @param file - 仓库内相对路径。
 */
export function showFileArgv(rev: string, file: string): readonly string[] {
  return ['show', '--no-ext-diff', '--no-color', '--end-of-options', `${rev}:${file}`];
}

/** 修订名合法性:不能为空、不能以 `-` 开头、不能含空白或 `:`(避免构造出别的对象名)。 */
export function isSafeRev(rev: string): boolean {
  return rev !== '' && !rev.startsWith('-') && !/[\s:]/.test(rev);
}

/**
 * 对象名(blob sha)合法性。
 *
 * 为什么单独一条:内容读取走 `cat-file blob <sha>`,而 sha 是**上一步
 * `rev-parse` 的输出**,不是用户输入 —— 但仍要校验,因为一旦哪天有人把用户输入
 * 接到这里,`cat-file blob --batch` 这种「以 `-` 开头的对象名」就会变成选项注入。
 * 长度允许 7(缩写)到 64(sha256)。
 */
export function isSafeObjectName(sha: string): boolean {
  return /^[0-9a-f]{7,64}$/i.test(sha);
}

/**
 * 在某个修订下**精确匹配**一个路径(`ls-tree -z -l`)。
 *
 * ## 为什么不是 `rev-parse --verify '<rev>:<path>'`
 *
 * 那条路**分不开两件完全不同的事**,而且实测过:
 *
 * ```
 * git rev-parse --verify --end-of-options 'HEAD:a.txt'      -> 0   + sha
 * git rev-parse --verify --end-of-options 'HEAD:nope.txt'   -> 128 + "fatal: Needed a single revision"
 * git rev-parse --verify --end-of-options 'nosuchrev:a.txt' -> 128 + "fatal: Needed a single revision"
 * ```
 *
 * 「路径不在这个修订里」(应该是 `404`)与「修订名不存在」(应该是错误)给的是**同一句
 * stderr** —— 按消息判定必然误判一个(把 404 判成 500,或把 400 判成 404)。
 *
 * `ls-tree` 把三件事一次问清:**退出码**只反映修订是否可用;**空输出**才是路径不存在;
 * 输出的 `<type>` 还能挡住「这个路径是目录/子模块」这种请求。
 *
 * `-z`:NUL 分隔,含换行的路径安全。
 * `:(literal)`:**路径规范魔法**,强制字面匹配 —— 否则 `*`/`?`/`[` 会被当通配符,
 * 于是一个叫 `*.png` 的「路径」会匹配到别的文件。
 *
 * @param rev - 修订(调用方已用 {@link isSafeRev} 校验:非空、不以 `-` 开头、无空白/冒号)。
 * @param file - 仓库内相对路径(已过路径守卫,`/` 分隔)。
 */
export function blobTreeEntryArgv(rev: string, file: string): readonly string[] {
  return ['ls-tree', '-z', '-l', rev, '--', `:(literal)${file}`];
}

/**
 * 索引里精确匹配一个路径(`ls-files -s -z`):给出 mode / 对象名 / stage。
 *
 * 用 `ls-files` 而不是 `:path` 形态(`rev-parse --verify ':path'`)的理由与上面同源:
 * `:path` 里 `file` 会被 git 的**索引语法**再解释一遍(`:0:a.txt` 指的是另一个路径),
 * 而一个真的叫 `0:a.txt` 的文件会被静默换成 `a.txt`。`ls-files` 的输出带真实路径,
 * 调用方可以逐字比对。
 * @param file - 仓库内相对路径。
 */
export function blobIndexEntryArgv(file: string): readonly string[] {
  return ['ls-files', '-s', '-z', '--', `:(literal)${file}`];
}

/** 按对象名取字节数(`cat-file -s`);不需要把内容读出来。 */
export function blobSizeArgv(sha: string): readonly string[] {
  return ['cat-file', '-s', sha];
}

/**
 * 按对象名取**原始字节**。
 *
 * 用 sha 而不是 `rev:path`:同一个 blob 在一份请求里被量过一次大小、又可能被
 * `Range` 分多次读取,每次重新解析 `rev:path` 会在引用移动时读到**不同的对象**
 * (量到的大小与内容不是同一份)。sha 是钉死的。
 */
export function blobContentArgv(sha: string): readonly string[] {
  return ['cat-file', 'blob', sha];
}

/** numstat 统计(与 patch 分开取,避免解析 patch 头)。 */
export function diffNumstatArgv(
  staged: boolean,
  path?: string,
  opts: { ignoreWhitespace?: boolean } = {},
): readonly string[] {
  // -z:记录以 NUL 分隔,路径含换行也能解析。
  const base = ['diff', '--numstat', '-z', '--no-ext-diff', '--no-color'];
  if (staged) {
    base.push('--cached');
  }
  // -w 也必须带上:否则「隐藏空白」时计数取自未忽略空白的 numstat,
  // 而补丁来自 -w,两者不一致(实测:git diff -w 输出 0 行,计数却仍是 +1/-1)。
  if (opts.ignoreWhitespace === true) {
    base.push('-w');
  }
  return path === undefined ? base : [...base, '--', path];
}

export function diffCommitNumstatArgv(
  sha: string,
  path?: string,
  opts: { ignoreWhitespace?: boolean } = {},
): readonly string[] {
  const base = [
    'log', '-m', '-1', '--first-parent', '--numstat', '-z', '--format=',
    '--no-ext-diff', '--no-color', '--end-of-options', sha,
  ];
  if (opts.ignoreWhitespace === true) {
    base.push('-w');
  }
  return path === undefined ? base : [...base, '--', path];
}

/** 文件级暂存(NUL 分隔路径走 stdin,Windows argv 长度也安全)。 */
export function addArgv(paths: readonly string[]): readonly string[] {
  return ['add', '--', ...paths];
}

export function resetPathsArgv(paths: readonly string[]): readonly string[] {
  return ['reset', '--', ...paths];
}

/** 丢弃工作区改动(未跟踪文件要先删;调用方决定)。 */
export function checkoutPathsArgv(paths: readonly string[]): readonly string[] {
  return ['checkout', '--', ...paths];
}

/** 丢弃未跟踪文件。 */
export function cleanArgv(paths: readonly string[]): readonly string[] {
  return ['clean', '-f', '--', ...paths];
}

/** 部分暂存:把选区重建的补丁应用到索引。 */
export function applyCachedArgv(): readonly string[] {
  return ['apply', '--cached', '--unidiff-zero', '--whitespace=nowarn', '-'];
}

/** 部分丢弃:把选区重建的补丁反向应用到工作区。 */
export function applyReverseArgv(): readonly string[] {
  return ['apply', '--reverse', '--unidiff-zero', '--whitespace=nowarn', '-'];
}

/**
 * `git commit` 的 argv。
 *
 * `messageFile` 缺省是 `'-'`(消息走 stdin);host 侧提交时传**仓库内消息文件的
 * 绝对路径**。两种形态在同一个参数位生成,避免「先写 `-F -` 再事后 filter/strip」
 * 那种做法 —— 后者在带 `--amend` 等 flag 时会漏掉替换,产生两个 `-F`。
 */
export function commitArgv(opts: {
  amend?: boolean;
  noVerify?: boolean;
  signoff?: boolean;
  allowEmpty?: boolean;
  messageFile?: string;
}): readonly string[] {
  const argv = ['commit', '-F', opts.messageFile ?? '-'];
  if (opts.amend) {
    argv.push('--amend');
  }
  if (opts.noVerify) {
    argv.push('--no-verify');
  }
  if (opts.signoff) {
    argv.push('--signoff');
  }
  if (opts.allowEmpty) {
    argv.push('--allow-empty');
  }
  return argv;
}

/** 日志格式:字段用 %x1f 分隔,记录用 %x1e 分隔;消息里的换行不会破坏解析。 */
const LOG_SEP = '%x1f';
const LOG_EOR = '%x1e';
export const LOG_FIELD_SEP = '\x1f';
export const LOG_RECORD_SEP = '\x1e';
export const LOG_FORMAT = [
  '%H', '%h', '%s', '%b', '%an', '%ae', '%aI', '%cn', '%ce', '%cI', '%P', '%D',
].join(LOG_SEP);

export function logArgv(opts: { ref?: string; limit: number; skip?: number }): readonly string[] {
  const argv = [
    'log',
    `--max-count=${opts.limit}`,
    '--date=iso-strict',
    `--format=${LOG_FORMAT}${LOG_EOR}`,
    '--no-show-signature',
    '--no-color',
  ];
  // 以上都是 log 的有效选项;若 --format/--max-count 写在 'log' 之前会被当成
  // 顶层选项而报错,因此这里保持 'log' 在最前。
  if (opts.skip !== undefined && opts.skip > 0) {
    argv.push(`--skip=${opts.skip}`);
  }
  argv.push('--end-of-options', opts.ref ?? 'HEAD', '--');
  return argv;
}

export function commitDetailStatArgv(sha: string): readonly string[] {
  // -C 必须在 -M 之前:反了的话副本不会被识别为副本(Desktop 的注释明确写了)。
  // --no-show-signature:用户的 log.showSignature=true 会往输出里插签名块,破坏解析。
  return [
    'log', '-m', '-1', '--first-parent', '-C', '-M', '--numstat', '-z', '--format=',
    '--no-show-signature', '--no-color', '--end-of-options', sha, '--',
  ];
}

export function branchListArgv(): readonly string[] {
  return [
    'for-each-ref',
    '--format=%(refname)%1f%(refname:short)%1f%(upstream:short)%1f%(objectname)%1f%(symref)%1f%(HEAD)',
    'refs/heads', 'refs/remotes',
  ];
}

export function branchCreateArgv(name: string, startPoint?: string): readonly string[] {
  const argv = ['branch', '--no-track', '--', name];
  if (startPoint !== undefined && startPoint !== '') {
    argv.push(startPoint);
  }
  return argv;
}

export function branchDeleteArgv(name: string): readonly string[] {
  return ['branch', '-D', '--', name];
}

export function branchRenameArgv(oldName: string, newName: string): readonly string[] {
  return ['branch', '-m', '--', oldName, newName];
}

/**
 * 切换分支。
 *
 * 注意(实测):`git checkout -- <branch>` 会被当成 **pathspec restore**,
 * 报 `pathspec '<branch>' did not match any file(s)` 且**不会**切分支。
 * 分支名必须出现在 `--` 之前,`--` 只用来隔离后面的文件路径。
 */
export function checkoutBranchArgv(branch: string): readonly string[] {
  return ['checkout', branch, '--'];
}

/**
 * 从远端分支建本地跟踪分支。
 * 同上:起点 ref 必须在 `--` 之前,否则它只是一个不存在的 pathspec。
 */
export function checkoutRemoteArgv(localName: string, remoteRef: string): readonly string[] {
  return ['checkout', '-b', localName, remoteRef, '--'];
}

/**
 * `git fetch`。
 *
 * `opts.progress` 加 `--progress` —— 上游 `lib/git/push.ts:78` 同形(在那三支里
 * 都是「有进度回调才加」)。**为什么必须显式加**:git 只在 stderr 是 tty 时才自己
 * 报进度,而我们的 stderr 是管道 ⇒ 不加这个开关,`--progress` 一族的 stderr 行
 * **一条都不会有**(进度条就永远是空的)。
 */
export function fetchArgv(remote: string, opts: { progress?: boolean } = {}): readonly string[] {
  return [
    'fetch',
    ...(opts.progress === true ? ['--progress'] : []),
    '--prune',
    '--no-recurse-submodules',
    '--',
    remote,
  ];
}

export function fetchAllArgv(opts: { progress?: boolean } = {}): readonly string[] {
  return [
    'fetch',
    ...(opts.progress === true ? ['--progress'] : []),
    '--prune',
    '--no-recurse-submodules',
    '--all',
  ];
}

export function pullArgv(opts: { remote: string; rebase: boolean; ffOnly: boolean; progress?: boolean }): readonly string[] {
  const argv = ['pull'];
  if (opts.rebase) {
    argv.push('--rebase');
  }
  else if (opts.ffOnly) {
    argv.push('--ff-only');
  }
  argv.push('--no-recurse-submodules', '--', opts.remote);
  return argv;
}

/**
 * `git push`。
 *
 * `opts.progress` 加 `--progress`：位置与上游 `lib/git/push.ts:77-79` **逐字同**——
 * 三处 `--set-upstream` / `--force-with-lease` / `--no-verify` 之后、`--` 之前。
 * 理由同 {@link fetchArgv}：不显式加，管道 stderr 上一条进度行都没有。
 */
export function pushArgv(opts: {
  remote: string;
  branch: string;
  remoteBranch?: string;
  setUpstream?: boolean;
  forceWithLease?: boolean;
  noVerify?: boolean;
  progress?: boolean;
  tags?: readonly string[];
}): readonly string[] {
  const argv = ['push'];
  if (opts.setUpstream) {
    argv.push('--set-upstream');
  }
  else if (opts.forceWithLease) {
    argv.push('--force-with-lease');
  }
  if (opts.noVerify) {
    argv.push('--no-verify');
  }
  if (opts.progress === true) {
    argv.push('--progress');
  }
  argv.push('--', opts.remote);
  if (opts.setUpstream) {
    // 无 upstream 时 refspec 退化为分支名,由 --set-upstream 建立跟踪。
    argv.push(opts.branch);
  } else {
    const target = opts.remoteBranch !== undefined && opts.remoteBranch !== opts.branch
      ? `${opts.branch}:${opts.remoteBranch}`
      : opts.branch;
    argv.push(target);
  }
  for (const tag of opts.tags ?? []) {
    argv.push(tag);
  }
  return argv;
}

export function aheadBehindArgv(local: string, upstream: string): readonly string[] {
  return ['rev-list', '--left-right', '--count', '--end-of-options', `${local}...${upstream}`, '--'];
}

export function cloneArgv(opts: { url: string; path: string; branch?: string }): readonly string[] {
  const argv = [
    '-c', 'protocol.ext.allow=never',
    '-c', 'protocol.ext.exe.allow=never',
    'clone', '--no-recurse-submodules',
  ];
  if (opts.branch !== undefined && opts.branch !== '') {
    argv.push('-b', opts.branch);
  }
  // `--` 是被支持的(实测:git clone -- <url> <path> 正常工作),比抛错更安全。
  argv.push('--', opts.url, opts.path);
  return argv;
}

export function initArgv(defaultBranch: string): readonly string[] {
  return ['-c', `init.defaultBranch=${defaultBranch}`, 'init'];
}

export function configGetArgv(key: string, scope: 'local' | 'global' = 'local'): readonly string[] {
  return ['config', scope === 'global' ? '--global' : '--local', '--get', key];
}

/**
 * `git config --get <key>` —— **不带作用域**,读的是 git 自己那条合并链
 * (system → global → local → worktree → command)。
 *
 * ## 为什么需要它(而不是复用 {@link configGetArgv})
 *
 * 那条 argv **带** `--local`,只读仓库自己的配置。上游 `getConfigValue(repository, key)`
 * 的 `onlyLocal` 默认是 **false**(`references/desktop/app/src/lib/git/config.ts:11-23`)
 * ⇒ 它读的是**合并**结果,全局设了 `core.autocrlf=true` 的仓库能被正确识别。
 *
 * 唯一的调用点是 `.gitignore` 的行尾规整
 * (`references/desktop/app/src/lib/git/gitignore.ts:200-231` 的
 * `formatGitIgnoreContents`):用 `--local` 去读,会在「仓库没设、全局设了」这个最常见的
 * 档上拿到 `null` ⇒ 落进上游那条「`autocrlf == null` ⇒ 走 git 默认 `\n`」的兜底,
 * 于是 `core.autocrlf=true` 的用户拿到 LF 而不是 CRLF —— 而 `core.safecrlf=true` 时
 * 那正是让 `git add` 直接失败的那个形状(上游在 `:190-198` 的注释里写明了这层因果)。
 *
 * @param key - 配置键(例如 `core.autocrlf`)。
 */
export function configGetEffectiveArgv(key: string): readonly string[] {
  return ['config', '--get', key];
}

export function configSetArgv(key: string, value: string, global = false): readonly string[] {
  return ['config', global ? '--global' : '--local', '--replace-all', key, value];
}

export function configUnsetArgv(key: string, global = false): readonly string[] {
  return ['config', global ? '--global' : '--local', '--unset-all', key];
}

/** 已跟踪文件的相对路径列表(用于「忽略」判断与 diff 兜底)。 */
/**
 * 列出工作区里的文件(用于 Code 页签的本地文件树)。
 *
 * `--cached`(已跟踪)+ `--others`(未跟踪)+ `--exclude-standard`(遵守
 * .gitignore 与 .git/info/exclude)三者缺一不可:
 *  - 只要 `--cached`,未提交/未跟踪的文件全看不见 —— 而那恰恰是本地 Code 页签最该显示的东西
 *    (实测同一个仓库 `ls-tree -r` 只给 3 个路径,这个 argv 给 58 个);
 *  - 加大 `--directory` 会把**未跟踪**目录折叠成 `dir/` 而跟踪文件仍是逐个路径,输出变成两种形状,
 *    反而更难解析;
 *  - 不加 `-z` 时 git 会给含特殊字符的路径加引号并做八进制转义(实测 en-dash 变成
 *    `\342\200\223`),含换行的路径还会被拆成两行。
 * 不要改用 `fs.readdir`:那会走进 node_modules 之类被 .gitignore 排除的目录。
 */
export function lsFilesArgv(): readonly string[] {
  return ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--'];
}

export function nameStatusUnstagedArgv(): readonly string[] {
  return ['diff', '--name-status', '-z', '--no-ext-diff', '--'];
}

export function nameStatusStagedArgv(): readonly string[] {
  return ['diff', '--cached', '--name-status', '-z', '--no-ext-diff', '--'];
}

/**
 * 单提交的文件列表。用 log -m --first-parent 而不是 diff <sha>^ <sha>:
 * 后者在根提交上会失败,而且合并提交会给出「相对第一父」之外的噪音。
 */
export function nameStatusCommitArgv(sha: string): readonly string[] {
  return [
    'log', '-m', '-1', '--first-parent', '-C', '-M', '--name-status', '-z', '--format=',
    '--no-show-signature', '--no-color', '--end-of-options', sha, '--',
  ];
}

export function lsRemoteUrlArgv(url: string): readonly string[] {
  return ['ls-remote', '--get-url', '--', url];
}

export function revParseVerifyArgv(ref: string): readonly string[] {
  return ['rev-parse', '--verify', '--end-of-options', ref];
}

/** 撤销提交:`reset --mixed <ref>`(改动回到工作区,不留在暂存区)。 */
export function resetMixedArgv(ref: string): readonly string[] {
  return ['reset', '--mixed', '--end-of-options', ref];
}

/**
 * 删除一个 ref(撤销「第一次提交」时用)。
 * Desktop 的 `deleteRef` 就是 `update-ref -d <ref> -m <reason>`。
 */
export function updateRefDeleteArgv(ref: string, reason: string): readonly string[] {
  return ['update-ref', '-d', ref, '-m', reason];
}

/** 清空索引(撤销第一次提交后让所有文件回到未跟踪)。 */
export function rmCachedAllArgv(): readonly string[] {
  return ['rm', '--cached', '-r', '-f', '.'];
}

export function tagListArgv(): readonly string[] {
  return ['tag', '-l'];
}

// ---------- 历史 / 提交操作(本次新增) ----------
//
// 这一组全部照 GitHub Desktop 的上游实现,行号是**这个仓库里的**
// `references/desktop/app/src/…` 的真实位置(先读过再写,不是猜的)。
// 与上游的每一处有意分歧都写在对应函数上方。

/** reset 的模式(上游是 `GitResetMode` 枚举,`lib/git/reset.ts:6-25`)。 */
export type ResetMode = 'soft' | 'mixed' | 'hard';

/**
 * `git reset` 到某个提交。
 *
 * 上游:`resetModeToArgs`(`references/desktop/app/src/lib/git/reset.ts:27-38`)——
 * `Hard → ['reset','--hard',ref]`、`Mixed → ['reset',ref]`、`Soft → ['reset','--soft',ref]`;
 * 调用方见 `ui/dispatcher/dispatcher.ts:960-967` 与 `lib/stores/app-store.ts:5856-5889`。
 *
 * 两条**有意分歧**(都是加固,不改语义):
 *  1. 上游的 mixed 就是裸 `reset <ref>`(mixed 是 git 的默认模式),这里复用既有的
 *     {@link resetMixedArgv} 显式写 `--mixed` —— 同一个 argv 已经在 `undoCommit` 里用了;
 *  2. 多一个 `--end-of-options`:上游把 ref 直接放在选项后面,以 `-` 开头的 ref 会被当成
 *     选项;这里让 ref 永远落在操作数位置(仓内既有约定,见本文件顶部)。
 *
 * ⚠️ `hard` 会**丢弃工作区与索引里的全部未提交改动**(上游注释:
 * `GitResetMode.Hard` = "Any changes to tracked files in the working tree since
 * <commit> are discarded.")。调用方必须在动手前让用户确认,见 `git-service.ts` 的
 * `resetToCommit` 与 `routes.ts` 的 `reset-to-commit` 路由。
 * @param mode - reset 模式。
 * @param ref - 目标修订(提交号/`HEAD~1` 等)。
 */
export function resetToCommitArgv(mode: ResetMode, ref: string): readonly string[] {
  if (mode === 'mixed') {
    return resetMixedArgv(ref);
  }
  return ['reset', mode === 'hard' ? '--hard' : '--soft', '--end-of-options', ref];
}

/**
 * 检出某个提交(分离头)。
 *
 * 上游:`checkoutCommit`(`references/desktop/app/src/lib/git/checkout.ts:165-187`)——
 * 它拼的是 `[...getCheckoutArgs(), commit.sha]`,即裸 `git checkout <sha>`
 * (调用链 `ui/dispatcher/dispatcher.ts:736-741` → `lib/stores/app-store.ts:4808-4838`)。
 *
 * **有意分歧**:这里显式加 `--detach`。上游靠「参数是 sha 时 git 自己分离头」,
 * 但那条性质对**不是 sha 的输入**不成立 —— 传进来一个分支名时裸 `checkout <branch>`
 * 会**切分支**而不是分离头。路由名是 checkout-commit,语义必须钉死在「分离头」上。
 */
export function checkoutDetachArgv(ref: string): readonly string[] {
  return ['checkout', '--detach', '--end-of-options', ref];
}

/**
 * revert 一个提交。
 *
 * 上游:`revertCommit`(`references/desktop/app/src/lib/git/revert.ts:22-55`)——
 * `['revert']`,`commit.parentSHAs.length > 1` 时补 `-m 1`(合并提交必须给出以哪一支为准),
 * 最后 push 提交号。
 *
 * **有意分歧**:多一个 `--no-edit`。上游不带它,靠执行环境的 `GIT_EDITOR` 非交互
 * (`lib/git/cherry-pick.ts:426` 就是显式把 `GIT_EDITOR` 设成 `:` 的),
 * 而我们的 runner 是纯子进程、没有编辑器,不带 `--no-edit` 会**卡死或失败**。
 * 消息用 git 自己生成的 `Revert "<subject>"`。
 * @param ref - 要 revert 的提交。
 * @param opts.merge - true ⇒ 目标提交有多个父提交,补 `-m 1`(照上游,取第一父)。
 */
export function revertArgv(ref: string, opts: { merge?: boolean } = {}): readonly string[] {
  const argv = ['revert', '--no-edit'];
  if (opts.merge === true) {
    argv.push('-m', '1');
  }
  argv.push('--end-of-options', ref);
  return argv;
}

/**
 * cherry-pick 一个提交。
 *
 * 上游:`cherryPick`(`references/desktop/app/src/lib/git/cherry-pick.ts:141-182`)——
 * `['cherry-pick', ...shas, '--empty=keep', '-m 1']`。
 *
 * **有意分歧**(按冻结的接口契约):只 pick 一个提交、不带上游那两个开关。
 * `-m 1` 在上游是**无条件**给的(它服务的是「一次 pick 多个提交」那条流程),
 * 对单个非合并提交无用;`--empty=keep` 影响的是「pick 出一个空提交」的边界情形,
 * 而本路由的契约就是 `git cherry-pick <sha>`。冲突行为见 `git-service.ts`。
 */
export function cherryPickArgv(ref: string): readonly string[] {
  return ['cherry-pick', '--end-of-options', ref];
}

/**
 * 建标签。
 *
 * 上游:`createTag`(`references/desktop/app/src/lib/git/tag.ts:13-21`)——
 * `['tag','-a','-m','',name,sha]`,即**附注标签 + 空消息**。
 *
 * **有意分歧**(按冻结的接口契约):这里是 `git tag <name> [<sha>]`,即**轻量标签**。
 * 两者的差别是可查的:`-a` 会多建一个 tag 对象(`git cat-file -t <name>` 是 `tag`),
 * 轻量标签直接指向提交(是 `commit`)。契约写的是后者,所以按后者实现。
 *
 * `--end-of-options` 让名字/目标永远落在操作数位置。**注意它必须写在位置参数之前**,
 * `git tag <name> --end-of-options <sha>` 是不成立的。
 * @param name - 标签名(调用方已过 ref 名校验)。
 * @param sha - 目标提交;缺省 = 当前 HEAD。
 */
export function tagCreateArgv(name: string, sha?: string): readonly string[] {
  const argv = ['tag', '--end-of-options', name];
  if (sha !== undefined && sha !== '') {
    argv.push(sha);
  }
  return argv;
}

/** 删标签。上游:`deleteTag`(`references/desktop/app/src/lib/git/tag.ts:29-36`)= `git tag -d <name>`。 */
export function tagDeleteArgv(name: string): readonly string[] {
  return ['tag', '-d', '--end-of-options', name];
}

/**
 * **「本地有、远端没有」的标签问询** —— History 右键 `Delete tag <name>` 的启用判据。
 *
 * ## 上游的真身与它的 argv(`references/desktop/app/src/lib/git/tag.ts:86-137`)
 *
 * 上游把这个问询叫 **`fetchTagsToPush(repository, remote, branchName)`**(**不是**
 * `loadTagsToPush` —— 全仓 `grep -rn loadTagsToPush references/` = **0 命中**),
 * 它的 argv 逐字是:
 *
 * ```ts
 * const args = [
 *   'push', '--follow-tags', '--dry-run', '--no-verify', '--porcelain',
 *   '--', remote.name, branchName,
 * ]
 * const result = await git(args, repository.path, 'fetchTagsToPush', {
 *   env: await envForRemoteOperation(remote.url),
 *   successExitCodes: new Set([0, 1, 128]),
 * })
 * ```
 *
 * 解析规则(上游 `:118-137`,逐字):stdout 从**第 2 行**开始扫(`currentLine = 1`,
 * 第 1 行是 `To <url>`),遇到行 `Done` 停下;每行按 `\t` 切三段,
 * `parts[0] === '*' && parts[2] === '[new tag]'` 时取 `parts[1].split(':')[0]`
 * 并去掉 `refs/tags/` 前缀。
 *
 * ## 本函数与上游的**一处有意分歧**(以及为什么必须分)
 *
 * | | 上游 | 这里 |
 * |---|---|---|
 * | 选标签的开关 | `--follow-tags` | **`--tags`** |
 * | 位置参数 | `<remote.name> <branchName>` | `<remote>` |
 *
 * **理由是可实测的,不是口味**:`--follow-tags` 只推**附注标签**
 * (git 文档 `--follow-tags`:「push annotated tags … that are missing from the remote
 * but are pointing at commit-ish that are reachable from the refs being pushed」),
 * 而本仓的冻结契约建的是**轻量标签**(`tagCreateArgv` 的
 * `git tag <name> [<sha>]`,`docs/discard-lines-contract.md` §6)。
 * 实测(`/tmp` 里真仓库 + 真裸远端,本探针复现的正是这一档):
 *
 * ```
 * 本地标签:v1.0.0(已推送)、v2.0.0(轻量,未推送,指向**已推送**的提交)、
 *          v3.0.0(轻量,未推送,指向未推送的提交)、a1(附注,未推送)
 *
 * 上游 argv  `push --follow-tags … -- origin main` ⇒ 只认到 `a1`(漏掉两个轻量标签)
 * 本函数 argv `push --tags … -- origin`          ⇒ 三个未推送标签一个不漏
 * ```
 *
 * ⇒ 照抄上游 argv 的话,**我们自己建出来的标签永远不会被判成「未推送」**,
 * 那个菜单项会永远灰着 —— 也就是「镜像了 argv、功能却是死的」。
 * `--tags` 与上游的**解析规则**仍然逐字相同(输出格式一样,`Porcelain v1`),
 * 所以 `parseUnpushedTags` 那份实现是上游原文的逐字搬运。
 *
 * 另一处记账:上游的 `successExitCodes` 是 `{0,1,128}` 且在 **128** 时
 * `throw result.gitError`(即「不把这些码当成可解析的成功」)。这里把
 * `{0,1}` 交给 `must` 的 `allow`,其余(含 128)走既有的 `classifyGitFailure`
 * —— 与上游同向(128 不是可解析的成功),差别只是错误被命名成可操作的中文提示
 * (本仓既有约定,`git-service.ts` 的 `classifyGitFailure`)。
 *
 * ⚠️ `--tags` **必须写在 `--` 之前**:`--` 之后的 `--tags` 会被当成 refspec
 * (实测 `git push --dry-run --porcelain -- origin --tags` 报
 * `src refspec --tags does not match any`)。
 * @param remote - 远端名(**不是** URL);调用方负责确认它在 `git remote` 清单里。
 */
export function unpushedTagsArgv(remote: string): readonly string[] {
  return ['push', '--tags', '--dry-run', '--no-verify', '--porcelain', '--', remote];
}

/**
 * 删**远端**分支。
 *
 * 上游:`deleteRemoteBranch`(`references/desktop/app/src/lib/git/branch.ts:119-143`)——
 * 它拼的是 `['push','--',remote.name,':'+branch]`(refspec 的「推送空到远端」写法)。
 *
 * **有意分歧**:按冻结的接口契约用 `git push <remote> --delete <branch>`。
 * 两种写法在 git 里等价(都是删远端 ref),实测都回 rc=0。
 * `--` 是为了让 remote/branch 永远落在操作数位置:**push 不支持 `--end-of-options`**
 * (实测 `git push --end-of-options origin --delete feature` 会把 `--delete` 当 refspec,
 * 报 `src refspec --delete does not match any`)。
 */
export function pushDeleteRemoteBranchArgv(remote: string, branch: string): readonly string[] {
  return ['push', '--delete', '--', remote, branch];
}
