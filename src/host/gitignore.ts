/**
 * 仓库根 `.gitignore` 的**纯文件 I/O** —— 上游
 * `references/desktop/app/src/lib/git/gitignore.ts`(232 行)的宿主半移植。
 *
 * ## 为什么这块必须在宿主
 *
 * 浏览器半没有 `fs`。上游那 232 行里**一条 git 命令都没有**:它就是
 * `lstat` / `open(O_NOFOLLOW)` / `truncate` / `writeFile` / `unlink`。
 * 而客户端只能经 `/dsh-git/*` 路由要能力 ⇒ 这三条操作(`read` / `save` / `append`)
 * 必须落在这里。
 *
 * ## 三个消费方(同一份实现,不是三份)
 *
 * | 消费方 | 上游对应物 | 它要的操作 |
 * |---|---|---|
 * | 仓库设置弹窗 ▸ Ignored Files 页 | `ui/repository-settings/git-ignore.tsx` + `repository-settings.tsx:101,316-329` | **读**根 `.gitignore`(全文本)与**整体写回**(空文本 ⇒ 删文件) |
 * | Changes 文件行右键「忽略此文件 / 文件夹 / 全部 .ts」 | `ui/changes/filter-changes-list.tsx:657-857` → `sidebar.tsx:270-287` 的 `onIgnoreFile` | **追加已转义的文件路径**(`appendIgnoreFile`) |
 * | 同上,「忽略此模式」 | `sidebar.tsx:279-287` 的 `onIgnorePattern` | **追加原样规则**(`appendIgnoreRule`,**不**转义) |
 *
 * ## ⚠️ 对上一泳道那份规格的两处更正(实测上游源码后改的,不是口味问题)
 *
 * 上一泳道给的规格是「`appendIgnoreFile`/`appendIgnoreRule` = 读 → 转义 `/[[\]!*#?]/g`
 * → 按 `core.autocrlf` 规整 → 写回」。逐行读上游后有两处需要修正:
 *
 *  1. **`appendIgnoreRule` 不转义,`appendIgnoreFile` 才转义**
 *     (`gitignore.ts:138-154` vs `:161-175`)。把两者合成一条「总是转义」的路由,
 *     会让「忽略此模式」(用户输入 `*.log` 这种**正则/通配**语义)被写成 `\*.log`
 *     —— 那是一条**匹配不到任何东西**的规则,而 git **不报错**。所以路由带
 *     `escape` 开关,默认 `false`(上游 `appendIgnoreRule` 的语义)。
 *  2. **「纯文件 I/O、零 argv」只对文件本身成立**:`formatGitIgnoreContents`
 *     (`:200-231`)**必须**读 `core.autocrlf` / `core.safecrlf`,而上游读的是
 *     **合并作用域**(`getConfigValue(repository, key)` 的 `onlyLocal` 默认 false)
 *     ⇒ 这里经 {@link IGitIgnoreIo.readConfig} 交给 `GitService.configEffective()`,
 *     它跑 `git config --get <key>`(**不带** `--local`)。写文件本身仍然零 argv。
 *
 * ## 符号链接:上游怎么拒、我们怎么拒(逐条一一对应)
 *
 * | 上游 | 这里 |
 * |---|---|
 * | `openExistingGitIgnore` 的 `O_NOFOLLOW`(`:37`) | 同一常量 |
 * | `ELOOP` ⇒ 指名符号链接的错误(`:45-47`) | 同一分支 |
 * | `ENOENT` ⇒ 先 `lstat` 确认**不是**悬空符号链接再回 null(`:40-43` + `:15-28`) | 同一顺序 |
 * | `file.stat()` 与 `lstat` 的 `dev`/`ino` 比对(`:53-66`,挡「打开后被换成链接」的 TOCTOU) | 同一比对 |
 * | `saveGitIgnore('')` 前也要 `ensureGitIgnoreIsNotSymbolicLink`(`:110-116`) | 同一道 |
 *
 * `core.symlinks` 关掉的 Windows 上 `O_NOFOLLOW` 的行为与 macOS/Linux 不同 ——
 * 这一条**没有**被本模块的探针覆盖(探针只在 macOS 上跑,判据见
 * `docs/probes/repository-settings-dialog-probe.mjs` 的诚实边界)。
 *
 * @see references/desktop/app/src/lib/git/gitignore.ts
 * @module dsh-git/host/gitignore
 */

import * as FS from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { GitServiceError } from './git-service.ts';

/** 根 `.gitignore` 是符号链接时的拒绝理由(上游 `gitignore.ts:8-9` 的原文语义)。 */
export const GITIGNORE_SYMLINK_MESSAGE =
  '仓库根的 .gitignore 是一个符号链接,dsh-git 拒绝通过它读写(上游 gitignore.ts:8-28 同一条规则)。';

/**
 * 三个操作的公共输入:一个**已过 gate** 的仓库根,加一条读 git 配置的接缝。
 *
 * `root` 由 `GitService` 的 `gate()` 算出来(它在 `allowedRoots` 白名单里),
 * 所以本模块自己**不**再校验路径 —— 这是刻意的:门只有一道,写在 `git-service.ts`。
 */
export interface IGitIgnoreIo {
  /** 仓库根(`gate()` 的返回值)。 */
  readonly root: string;
  /** `git config --get <key>`(合并作用域)。 */
  readConfig(key: string): Promise<string | null>;
}

function symlinkError(): GitServiceError {
  return new GitServiceError('bad-request', GITIGNORE_SYMLINK_MESSAGE);
}

function ioError(action: string, error: unknown): GitServiceError {
  const message = error instanceof Error ? error.message : String(error);
  return new GitServiceError('internal', `${action}失败:${message}`);
}

function isErrno(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string';
}

/** 上游 `gitignore.ts:15-28` 的 `ensureGitIgnoreIsNotSymbolicLink`。 */
async function ensureGitIgnoreIsNotSymbolicLink(ignorePath: string): Promise<void> {
  try {
    const stats = await lstat(ignorePath);
    if (stats.isSymbolicLink()) {
      throw symlinkError();
    }
  } catch (error) {
    if (error instanceof GitServiceError) {
      throw error;
    }
    // `ENOENT`(文件不存在)是**正常**的 —— 上游只在这一档吞掉。
    if (!isErrno(error) || error.code !== 'ENOENT') {
      throw error;
    }
  }
}

/** 上游 `gitignore.ts:30-72` 的 `openExistingGitIgnore`。文件不存在 ⇒ `null`。 */
async function openExistingGitIgnore(
  ignorePath: string,
  flags: number,
): Promise<FileHandle | null> {
  let file: FileHandle;

  try {
    file = await open(ignorePath, flags | FS.constants.O_NOFOLLOW);
  } catch (error) {
    if (isErrno(error)) {
      if (error.code === 'ENOENT') {
        await ensureGitIgnoreIsNotSymbolicLink(ignorePath);
        return null;
      }
      if (error.code === 'ELOOP') {
        throw symlinkError();
      }
    }
    throw error;
  }

  try {
    const [fileStats, pathStats] = await Promise.all([file.stat(), lstat(ignorePath)]);
    if (
      pathStats.isSymbolicLink()
      || fileStats.dev !== pathStats.dev
      || fileStats.ino !== pathStats.ino
    ) {
      throw symlinkError();
    }
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}

/**
 * 读仓库根 `.gitignore` 的全文。文件不存在 ⇒ `null`(上游 `gitignore.ts:81-96`)。
 *
 * ⚠️ 与上游一样**不吞**符号链接:那是 `bad-request` 而不是 `null` ——
 * 把「有链接但读不了」折成「没有这个文件」会让设置弹窗显示一个空文本框,
 * 用户一保存就把链接**换成**普通文件(静默毁掉用户刻意做的链接)。
 * @param root - 已过 gate 的仓库根。
 */
export async function readGitIgnoreAtRoot(root: string): Promise<string | null> {
  const ignorePath = join(root, '.gitignore');
  let file: FileHandle | null;
  try {
    file = await openExistingGitIgnore(ignorePath, FS.constants.O_RDONLY);
  } catch (error) {
    if (error instanceof GitServiceError) {
      throw error;
    }
    throw ioError('读取根 .gitignore', error);
  }

  if (file === null) {
    return null;
  }

  try {
    return await file.readFile('utf8');
  } catch (error) {
    throw ioError('读取根 .gitignore', error);
  } finally {
    await file.close();
  }
}

/**
 * 把给定文本整体写进仓库根 `.gitignore`(上游 `gitignore.ts:104-135` 的 `saveGitIgnore`)。
 *
 * - 文本为 `''` ⇒ **删掉文件**(上游 `:110-116`);文件本来就不存在时上游会
 *   `unlink` 抛 `ENOENT`,这里照样报错(不静默成功)—— 客户端只在
 *   「文本框真的改过」时才调它(`repository-settings.tsx:316`),所以正常路径到不了这档。
 * - 否则按 `core.autocrlf` / `core.safecrlf` 规整行尾后 `truncate(0)` + 写回。
 * @param io - 仓库根 + 配置读取接缝。
 * @param text - 用户文本框里的全文。
 */
export async function saveGitIgnore(io: IGitIgnoreIo, text: string): Promise<void> {
  const ignorePath = join(io.root, '.gitignore');

  if (text === '') {
    await ensureGitIgnoreIsNotSymbolicLink(ignorePath);
    try {
      await FS.promises.unlink(ignorePath);
    } catch (error) {
      throw ioError('删除根 .gitignore', error);
    }
    return;
  }

  const fileContents = await formatGitIgnoreContents(text, io);
  let file: FileHandle | null;
  try {
    file = (await openExistingGitIgnore(ignorePath, FS.constants.O_WRONLY))
      ?? (await open(
        ignorePath,
        FS.constants.O_CREAT
        | FS.constants.O_EXCL
        | FS.constants.O_WRONLY
        | FS.constants.O_NOFOLLOW,
      ));
  } catch (error) {
    if (error instanceof GitServiceError) {
      throw error;
    }
    throw ioError('写入根 .gitignore', error);
  }

  try {
    await file.truncate(0);
    await file.writeFile(fileContents);
  } catch (error) {
    throw ioError('写入根 .gitignore', error);
  } finally {
    await file.close();
  }
}

/**
 * 追加**原样**规则(上游 `appendIgnoreRule`,`:138-154`)。**不转义** ——
 * 「忽略此模式」走的就是这条。
 * @param io - 仓库根 + 配置读取接缝。
 * @param patterns - 一条或多条规则(多条用 `\n` 连接,与上游同一写法)。
 */
export async function appendIgnoreRule(
  io: IGitIgnoreIo,
  patterns: string | string[],
): Promise<void> {
  const text = (await readGitIgnoreAtRoot(io.root)) ?? '';
  const currentContents = await formatGitIgnoreContents(text, io);
  const newPatternText = Array.isArray(patterns) ? patterns.join('\n') : patterns;
  const newText = await formatGitIgnoreContents(`${currentContents}${newPatternText}`, io);
  await saveGitIgnore(io, newText);
}

/**
 * 追加**已转义**的文件路径(上游 `appendIgnoreFile`,`:161-175`)。
 * 转义表见 {@link escapeGitSpecialCharacters}。
 * @param io - 仓库根 + 配置读取接缝。
 * @param filePath - 一条或多条仓库内相对路径。
 */
export async function appendIgnoreFile(
  io: IGitIgnoreIo,
  filePath: string | string[],
): Promise<void> {
  if (Array.isArray(filePath)) {
    return appendIgnoreRule(io, filePath.map((path) => escapeGitSpecialCharacters(path)));
  }
  return appendIgnoreRule(io, escapeGitSpecialCharacters(filePath));
}

/**
 * 上游 `gitignore.ts:178-184` 的 `escapeGitSpecialCharacters` —— **逐字**同一张表
 * `/[[\]!*#?]/g`,命中字符前面加一个 `\`。
 *
 * 为什么必须是这张表:`.gitignore` 里 `*` / `?` / `[...]` 是通配、`!` 是取反、
 * `#` 是注释。一个名叫 `a[1].txt` 的文件不加转义会被写成一条**匹配别的东西**的规则;
 * 而 `git` 对语法错误**不报错**,只是静默不匹配 ⇒ 用户看到「点了忽略,文件还在」。
 * @param pattern - 原始文件路径或规则。
 * @returns 转义后的文本(可直接写进 `.gitignore`)。
 */
export function escapeGitSpecialCharacters(pattern: string): string {
  const specialCharacters = /[[\]!*#?]/g;
  return pattern.replace(specialCharacters, (match) => `\\${match}`);
}

/**
 * 上游 `gitignore.ts:200-231` 的 `formatGitIgnoreContents` —— 行尾规整。
 *
 * 四种情况(与上游逐条对应):
 *  1. `core.autocrlf === 'true'` 且 `core.safecrlf === 'true'` ⇒ 全部折成 CRLF 并**追加**一个 CRLF;
 *  2. 文本为空**或**已经以 `\n` 结尾 ⇒ 原样;
 *  3. `core.autocrlf` 读不到 ⇒ 走 git 默认行为,追加 `\n`;
 *  4. 否则 `autocrlf === 'true'` ⇒ 追加 `\n`,其余(含 `false` / `input`)⇒ 追加 `\r\n`。
 *
 * ⚠️ 第 4 条那个「其余 ⇒ `\r\n`」**看起来反直觉但是上游原文**(`:224-229`):
 * `input` 与 `false` 都落进 `\r\n` 那一支。照抄是对的 —— 本函数的判据
 * (`repository-settings-dialog-probe.mjs` 的 A 组)就是按上游这条分支表逐档取的读数。
 * @param text - 待规整的文本。
 * @param io - 提供 `core.autocrlf` / `core.safecrlf` 的读取接缝。
 */
async function formatGitIgnoreContents(text: string, io: IGitIgnoreIo): Promise<string> {
  const autocrlf = await io.readConfig('core.autocrlf');
  const safecrlf = await io.readConfig('core.safecrlf');

  if (autocrlf === 'true' && safecrlf === 'true') {
    const normalizedText = text.replace(/\r\n|\n\r|\n|\r/g, '\r\n');
    return `${normalizedText}\r\n`;
  }

  if (text === '' || text.endsWith('\n')) {
    return text;
  }

  if (autocrlf == null) {
    return `${text}\n`;
  }

  const linesEndInCRLF = autocrlf === 'true';
  return linesEndInCRLF ? `${text}\n` : `${text}\r\n`;
}
