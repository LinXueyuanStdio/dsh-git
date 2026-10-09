/**
 * **Changes 文件列表的右键菜单** —— 上游 `ui/changes/filter-changes-list.tsx` 的
 * 那份 item 列表在浏览器半的落点。
 *
 * ## 这一条是什么形状的缺陷(先读,它决定了本文件的写法)
 *
 * 用户报:「Changes 的列表里,现在**变更项的右键菜单缺失了**。」
 * 本仓的同一族缺陷有三种形状(props 没喂 / 生产者那一半没抄 / 机制不可移植)。
 * 这一条**不是**前两种,判据在两侧:
 *
 * | 事实 | 证据 |
 * |---|---|
 * | 上游的菜单是**主进程**能力 | `lib/menu-item.ts:82` `showContextualMenu` → `ui/main-process-proxy.ts:404` 的 `invokeContextualMenu`(IPC)→ Electron 原生菜单 |
 * | 镜像里的 item 列表**一个产品 importer 都没有** | `src/core/desktop/ui/changes/filter-changes-list.tsx` 在 `check-integration` 的 **unreachable** 名单里;`src/**` 里指向它的 3 条 `from` 全在**同一个死簇**内(`filter-changes-logic.ts:2`、`changes-list-filter-options.tsx:18`、`sidebar.tsx:34`),`src/client/**` **0** 条 |
 * | 我方的列表是**手写**的 | `src/client/changes-view.tsx` 的 `FileRow` 此前**没有** `onContextMenu`(0 命中) |
 *
 * ⇒ **是「从未移植」,而它从未被移植的原因是机制不可移植(第三种形状)**:
 * 上游那份 item 列表是围着 `showContextualMenu` 写的,而那个函数在浏览器里默认只打印
 * 一行日志。与 `ui/changes/no-changes.tsx` 四张建议卡**同一条机制、同一个 shim**
 * (`ui/main-process-proxy.ts` 的 `executeMenuItemById`),只是那一族的镜像**渲染了**,
 * 这一族的镜像**根本没被渲染**。
 *
 * ## 所以这里的写法是「抄判定,不抄机制」
 *
 * - **判定逐条照抄**:项序、`paths.length === 1 / > 1` 的分岔、扩展名逐项、
 *   `.gitignore` 自身的排除、`Deleted` 文件的三项禁用、rebase 变体、`isCommitting` 的早退、
 *   多选命中规则(`selectedFileIDs.includes(id) ? 全部选中项 : 只有这一个`)——
 *   每一条都在下面标了上游 `filter-changes-list.tsx` 的行号。
 * - **机制用仓库里已有的那一个**:`src/core/desktop/lib/menu-item.ts` 的 `showContextualMenu`
 *   + 已注入的宿主 `src/client/context-menu-host.tsx`(纯命令式 DOM 的 in-browser 菜单)。
 *   **没有第三个菜单系统**:顶栏那颗「更多」是 React `Popover`(`workbench.tsx` 的
 *   `.gw-more-menu`),不是上下文菜单面;上游 diff(`side-by-side-diff.tsx`)、
 *   提交行(`history/commit-list.tsx`)、仓库列表(`repositories-list.tsx`)走的都是
 *   `showContextualMenu` ⇒ 本文件与它们同一条链。
 *
 * ## 缺能力的那几项:**在列但诚实禁用**,不假装能点
 *
 * 启用条件**不是**写死的布尔量,而是**动作在不在**:
 * 「加入 .gitignore」那 4 类项与「贮藏全部改动」的 `enabled` 直接读
 * `actions.appendIgnoreFile !== undefined` / `actions.stashAll !== undefined`。
 * 调用方(产品路径)**不传**这两个动作 ⇒ 4 + 1 项**在列但恒禁用**;
 * 探针**传**它们 ⇒ 同一份 item 列表**当场变成可点**。这两条读数一起构成
 * 「禁用是能力缺口驱动的、不是写死的」的判据。
 *
 * ⚠️ **2026-10 起只剩「加入 .gitignore」那 4 项是这一族** —— 见下表第二行后面那段。
 *
 * | 上游动作 | 为什么禁用 | 缺什么 |
 * |---|---|---|
 * | `Ignore file / folder / N selected / all <ext> files (Add to .gitignore)` | 宿主没有写 `.gitignore` 的路由 | 一条 `gitignore/append` 路由 + `api` 包装。上游那个动作**不跑 git 子进程**,是纯文件读写:`references/desktop/app/src/lib/git/gitignore.ts:138-181`(读 `<repo>/.gitignore` → 转义 `/[[\]!*#?]/g` → 按 `core.autocrlf` 规整行尾 → 写回;符号链接要拒,`:16-45` 的 `O_NOFOLLOW` / `ELOOP`) |
 * | `Stash All Changes…` | ~~没有 stash 路由,是**已登记的刻意排除**~~ ⇒ **这条登记已于 2026-10 撤回并落地**:stash 族路由已建(`routes.ts` 的 `stash/list|push|pop|drop|show|move`),`ChangesView` 真的把 `stashAll` 传了下来 | ~~stash 族路由(整族 v1 排除)~~ ⇒ **不再缺**。撤回理由:goal 文档 §1.3 的**排除清单里没有 stash**,而 §1.2 E.8 / §10.10 把它列为**必须补**的路由(`docs/unported-master-ledger.md` §1.1.4 的更正) |
 *
 * 「Open with Default Program」**不在此列** —— 它走的是已有的 `system/open-in-app`,
 * 只是**不带 `app`**:宿主那一支的 argv 就是 `['open', path]`
 * (`src/host/system-service.ts:143-144`),与上游 `shell.openPath` 同义。
 *
 * @module dsh-git/client/changes-file-menu
 */

import * as Path from 'path';
import { installContextMenuHost } from './context-menu-host.tsx';
import { EOL } from './shim-node-os.ts';
import { showContextualMenu } from '../core/desktop/lib/menu-item.ts';
import type { IMenuItem } from '../core/desktop/lib/menu-item.ts';
import type { ChangedFile } from '../core/types.ts';

/**
 * 宿主有没有「往 `.gitignore` 追加规则」的能力。
 *
 * ⚠️ **2026-10 起是 `true`** —— 宿主那两条路由已经建好(`src/host/routes.ts` 的
 * `gitignore/append` + `gitignore/save`,真身 `src/host/gitignore.ts`:上游
 * `lib/git/gitignore.ts` 的逐条移植,**纯文件 I/O、零 git argv**),
 * 客户端包装在 `api.ts` 的 `gitignoreAppend` / `gitignoreSave`,产品调用点是
 * `ChangesView` 的 `menuActions.appendIgnoreFile` / `appendIgnorePattern`。
 *
 * 改前的读数(**留痕,不是现状**):这个常量是 `false`,宿主 67 条路由里没有任何
 * gitignore 路由、`api.ts` 里也没有包装 ⇒ 那 4 类菜单项**在列但诚实禁用**。
 * 现在它们**可用**,而且写完 `store.appendGitIgnore` 会 `refreshStatus()`
 * ⇒ 文件**当场**从 Changes 列表里消失(不需要刷新页面)。
 *
 * ⚠️ 它仍然只是**给人读的事实声明**;`changesFileMenuItems` 的 `enabled` **不读它**,
 * 读的是 `actions.appendIgnoreFile !== undefined`。两者必须一致 —— 探针的
 * I 组会同时量「不传动作 ⇒ 禁用」与「传了动作 ⇒ 可用」,所以这条常量漂了会被抓住。
 */
export const GITIGNORE_ROUTE_AVAILABLE = true;

/**
 * 宿主有没有 stash 路由。**2026-10 起是 `true`**。
 *
 * ## 改前的原文(**留痕,不是现状**)
 *
 * ```ts
 * /**
 *  * 宿主有没有 stash 路由。**今天是 `false`**,是**已登记的刻意排除**
 *  * (`docs/no-changes-suggestions-inventory.md` §2.1 第 6 项:「没有 stash UI /
 *  * 没有 stash 路由(已登记取舍,与顶栏同一条)」)。同上:判据读的是动作在不在。
 *  *\/
 * export const STASH_ROUTE_AVAILABLE = false;
 * ```
 *
 * ## 为什么这条登记是错的(它的撤回是任务的一部分)
 *
 * 那两句引的是 `docs/no-changes-suggestions-inventory.md` **§2.1 第 6 项**,
 * 而被引的那一项说的是**空态的 stash 卡**,不是「文件列表表头右键的
 * `Stash All Changes…`」—— **引用对象错位**。更要紧的是它与 goal 文档自相矛盾:
 *
 *  · `docs/goal-port-desktop.md` §1.3 的**排除清单**里**没有 stash**
 *    (`lib/stores/**`、`lib/stats`、`lib/ssh`、`lib/trampoline`、`lib/api.ts`、
 *    `ui/dispatcher`、`main-process/**`、`ui/secret-scanning`、`ui/repository-settings`);
 *  · §1.2 E.8 把 `stashed-changes-button` 列为「尚未迁移的 Changes 面」;
 *  · §10.10 把 **stash 族**列为「**必须补**的 6 条宿主路由」之一;
 *  · `docs/completion-audit.md` U10 记成「**没有**(整族)」。
 *
 * ⇒ 正确分类是 **partially ported(UI 骨架)+ needs host route(能力)**,
 * **不是** deliberate exclusion(`docs/unported-master-ledger.md` §1.1.4 的更正)。
 *
 * ## 现状(与 `GITIGNORE_ROUTE_AVAILABLE` 同一种契约)
 *
 * 宿主那 6 条路由已建(`src/host/routes.ts` 的 `stash/list|push|pop|drop|show|move`,
 * 真身 `src/host/git-service.ts` 的六个方法,argv 逐字来自上游 `lib/git/stash.ts`),
 * 客户端包装在 `api.ts` 的 `stashList` / `stashPush` / `stashPop` / `stashDrop` /
 * `stashShow` / `stashMove`,产品调用点是 `ChangesView` 的
 * `menuActions.stashAll`(表头右键)。
 *
 * ⚠️ 它仍然只是**给人读的事实声明**:`changesListMenuItems` 的 `enabled` **不读它**,
 * 读的是 `actions.stashAll !== undefined`。两者必须一致 —— 探针同时量
 * 「不传动作 ⇒ 那一项禁用」与「传了动作 ⇒ 可用」,所以这条常量漂了会被抓住。
 */
export const STASH_ROUTE_AVAILABLE = true;

/**
 * `.gitignore` 的文件名(仓库根)。
 *
 * 上游 `filter-changes-list.tsx` 用的是 `GitIgnoreFileName`
 * (`:699`、`:739`、`:744`)。本文件只用一个字面量,因为它**只用于一条比较**
 * (「命中的是不是 `.gitignore` 自己」),不参与任何读写。
 */
const GIT_IGNORE_FILE_NAME = '.gitignore';

/** 右键命中的位置与它的上下文(全部是**只读**输入)。 */
export interface IChangesFileMenuTarget {
  /** 仓库根(**绝对**路径)。行菜单要它把相对路径拼成绝对路径(上游 `:587`)。 */
  readonly repositoryPath: string;
  /** 右键命中的那个文件。 */
  readonly file: ChangedFile;
  /**
   * 当前多选集合(仓库内相对路径)。
   *
   * 上游的判据是 `selectedFileIDs.includes(id)`(`:684`):
   * **命中项在选区里 ⇒ 菜单作用于全部选中项;不在选区里 ⇒ 只作用于这一个**
   * (这是 Desktop 的既有交互,不是我们发明的)。
   */
  readonly selectedPaths: readonly string[];
  /** 全部工作区文件(用来把选中的 path 还原成 `WorkingDirectoryFileChange`)。 */
  readonly files: readonly ChangedFile[];
  /** 已解析出的外部编辑器;没有就是 `undefined`(上游 `externalEditorLabel`,`:644`)。 */
  readonly externalEditor?: { readonly id: string; readonly label: string } | undefined;
  /** 是否处于 rebase 冲突态(上游 `rebaseConflictState !== null`,`:852`)。 */
  readonly rebaseConflict: boolean;
  /** 是否正在提交(上游 `isCommitting`,`:845`)。 */
  readonly committing: boolean;
}

/** 菜单项要做的事 —— 由调用方(`ChangesView`)把真动作传进来。 */
export interface IChangesFileMenuActions {
  /**
   * 丢弃这些文件的改动。**调用方负责弹确认框**(上游是
   * `PopupType.ConfirmDiscardChanges`,`:262-267`),与行尾垃圾桶走**同一条**路。
   */
  readonly discard: (files: readonly ChangedFile[]) => void;
  /** 批量改「纳入提交」状态(上游 `onIncludeChanged(file, true/false)`,`:767/:775`)。 */
  readonly setFilesIncluded: (paths: readonly string[], included: boolean) => void;
  /** 在文件管理器中显示绝对路径。 */
  readonly revealInFileManager: (absolutePath: string) => void;
  /** 用外部编辑器打开绝对路径;`appId` 省略 = 系统默认应用。 */
  readonly openInExternalEditor: (absolutePath: string, appId?: string | undefined) => void;
  /** 写剪贴板(上游 `writeClipboardText`,走 IPC;浏览器半是 `navigator.clipboard`)。 */
  readonly copyText: (text: string) => void;
  /**
   * 往仓库根 `.gitignore` 追加**文件路径**(上游 `onIgnoreFile` → `appendIgnoreFile`)。
   * **缺省**:宿主没有这条路由 ⇒ 对应的 3 类项在列但禁用。
   */
  readonly appendIgnoreFile?: (paths: readonly string[]) => void;
  /**
   * 往仓库根 `.gitignore` 追加**规则**(上游 `onIgnorePattern`,例如 `*.log`)。
   * **缺省**:同上。
   */
  readonly appendIgnorePattern?: (pattern: string) => void;
}

/**
 * 文件的状态字母 —— **与 `src/client/store.ts:416`、`src/client/changes-view.tsx:603`
 * 用的是同一个表达式**(`unstaged ?? staged ?? 'M'`,冲突统一 `U`)。
 *
 * 为什么不抽成共享函数:那两处各自在一个函数的局部里,而这个表达式是
 * 「porcelain 字母」这个既有口径的直接读法;抽出去会动到两个不属于本轮的落点。
 * **它与那两处的漂移会被探针的 D 组(删除文件 ⇒ 尾部三项禁用)当场抓住。**
 */
function statusLetterOf(file: ChangedFile): string {
  return file.conflicted === true ? 'U' : (file.unstaged ?? file.staged) ?? 'M';
}

/** 上游 `AppFileStatusKind.Deleted` 在我们模型里的等价物(porcelain 的 `D`)。 */
function isDeleted(file: ChangedFile): boolean {
  return statusLetterOf(file) === 'D';
}

/** 仓库内相对路径 → 绝对路径(上游 `Path.join(this.props.repository.path, file.path)`,`:587`)。 */
function absolutePathOf(repositoryPath: string, relativePath: string): string {
  return Path.join(repositoryPath, relativePath);
}

/**
 * 平台上「在文件管理器中显示」的文案。
 *
 * 上游是 `ui/lib/context-menu.ts:19-23` 的 `RevealInFileManagerLabel`
 * (`Reveal in Finder` / `Show in Explorer` / `Show in your File Manager`)。
 * 那三句在**逐字镜像**的那个文件里(不能改);本文件是我们自己的面,
 * 按仓库惯例用中文,并保留上游那三档平台分岔(中文没有大小写之分,
 * 与 `scripts/verify-mirror.mjs` 里已登记的那几处 `__DARWIN__ ? a : b` 同形)。
 */
function revealLabel(): string {
  if (__DARWIN__) {
    return '在访达中显示';
  }
  if (__WIN32__) {
    return '在资源管理器中显示';
  }
  return '在文件管理器中显示';
}

/**
 * 「在外部编辑器中打开」的文案。
 *
 * 上游 `:638-647`:有解析出的编辑器 ⇒ `` `Open in ${externalEditorLabel}` ``,
 * 否则 ⇒ `DefaultEditorLabel`(`ui/lib/context-menu.ts:11-13` 的
 * `Open in External Editor`)。
 */
function openInEditorLabel(externalEditor: IChangesFileMenuTarget['externalEditor']): string {
  return externalEditor === undefined ? '在外部编辑器中打开' : `在 ${externalEditor.label} 中打开`;
}

/**
 * 上游 `isSafeFileExtension`(`ui/lib/context-menu.ts:31-36`)的等价物。
 *
 * 它**只在 Windows 上**排除四个可执行扩展名(`.cmd` / `.exe` / `.bat` / `.sh`),
 * 其余平台恒真 —— 这条平台分岔逐字保留(判据:探针的 D 组用 `--platform=win32`
 * 跑同一张表,见 `changes-file-menu-probe.mjs`)。
 */
const RESTRICTED_FILE_EXTENSIONS = ['.cmd', '.exe', '.bat', '.sh'];
function isSafeFileExtension(extension: string): boolean {
  if (!__WIN32__) {
    return true;
  }
  return RESTRICTED_FILE_EXTENSIONS.indexOf(extension.toLowerCase()) === -1;
}

/**
 * 把「右键命中项」解析成上游那两个数组:`selectedFiles` 与 `paths`。
 *
 * 逐字照抄 `filter-changes-list.tsx:665-692`:
 * 命中项**在选区里** ⇒ 遍历**选区**(按选区的顺序,不是按文件表顺序);
 * **不在选区里** ⇒ 只有命中项自己。
 */
function resolveTargets(
  target: IChangesFileMenuTarget,
): { readonly selectedFiles: ChangedFile[]; readonly paths: string[] } {
  const { file, selectedPaths, files } = target;
  const selectedFiles: ChangedFile[] = [];
  const paths: string[] = [];

  const addByPath = (path: string): void => {
    const found = files.find((candidate) => candidate.path === path);
    if (found !== undefined) {
      selectedFiles.push(found);
      paths.push(found.path);
    }
  };

  if (selectedPaths.includes(file.path)) {
    for (const path of selectedPaths) {
      addByPath(path);
    }
  } else {
    addByPath(file.path);
  }

  return { selectedFiles, paths };
}

/**
 * 上游 `getDiscardChangesMenuItemLabel`(`:515-533`)的等价物。
 *
 * 三个必须保留的细节:
 *  1. 单文件是 `Discard Changes`(不带数量),多文件是 `Discard N Selected Changes`;
 *  2. `askForConfirmationOnDiscardChanges` 为真时**加省略号**表示「还会再问一次」
 *     —— 上游默认值就是真(`app-store.ts:490` 的 `confirmDiscardChangesDefault`),
 *     我们的产品路径也**总是**弹确认框(行尾垃圾桶同一条路)⇒ 恒带省略号;
 *  3. 那一位设置**只为这一项**服务。
 */
function discardLabelOf(paths: readonly string[]): string {
  return paths.length === 1 ? '丢弃改动…' : `丢弃选中的 ${paths.length} 个文件的改动…`;
}

/**
 * **逐文件**右键菜单 —— 上游 `getDefaultContextMenu`(`filter-changes-list.tsx:657-803`)
 * 的移植。项序、分岔、启用条件逐条对应,注释里给的是上游行号。
 */
export function changesFileMenuItems(
  target: IChangesFileMenuTarget,
  actions: IChangesFileMenuActions,
): IMenuItem[] {
  const { file, repositoryPath, externalEditor } = target;
  const { selectedFiles, paths } = resolveTargets(target);

  /** 命中的路径(单文件时就是 `file.path`)。 */
  const hitPath = file.path;
  const extension = Path.extname(hitPath);
  const isSafeExtension = isSafeFileExtension(extension);

  /*
   * 扩展名集合:从**解析出来的那些文件**上取(`:677-681`),空扩展名不入集合
   * (`if (extension.length)`),后面最多取 5 个(`:748-749` 的 "Five menu items
   * should be enough for everyone")。
   */
  const extensions = new Set<string>();
  for (const selected of selectedFiles) {
    const selectedExtension = Path.extname(selected.path);
    if (selectedExtension.length) {
      extensions.add(selectedExtension);
    }
  }

  /* 「加入 .gitignore」那一族共用一个能力判据(见文件头)。 */
  const canIgnore = actions.appendIgnoreFile !== undefined;
  const canIgnorePattern = actions.appendIgnorePattern !== undefined;

  const items: IMenuItem[] = [
    /* :694-697 —— 丢弃 + 分隔符。这一项**总是**在列、总是启用。 */
    {
      label: discardLabelOf(paths),
      action: () => actions.discard(selectedFiles),
    },
    { type: 'separator' },
  ];

  if (paths.length === 1) {
    /* :698-729 —— 单文件分支:忽略此文件 + 忽略此文件夹(子菜单)。 */
    const notSelf = Path.basename(hitPath) !== GIT_IGNORE_FILE_NAME;

    items.push({
      label: '忽略此文件(写入 .gitignore)',
      action: () => actions.appendIgnoreFile?.([hitPath]),
      enabled: canIgnore && notSelf,
    });

    /*
     * `:708-710`:路径分隔符**恒为 `/`**(git 用的就是 `/`,不能用 `Path.sep`)。
     * 子菜单的次序是**由深到浅**(`:712-720` 的 `slice(0, length - index)`):
     * `src/lib/a.ts` ⇒ `/src/lib` 在前、`/src` 在后。
     */
    const pathComponents = hitPath.split('/').slice(0, -1);
    if (pathComponents.length > 0) {
      const submenu: IMenuItem[] = pathComponents.map((_, index) => {
        const label = `/${pathComponents.slice(0, pathComponents.length - index).join('/')}`;
        return {
          label,
          action: () => actions.appendIgnoreFile?.([label]),
        };
      });

      items.push({
        label: '忽略此文件夹(写入 .gitignore)',
        submenu,
        enabled: canIgnore && notSelf,
      });
    }
  } else if (paths.length > 1) {
    /* :730-746 —— 多选分支:一条「忽略选中的 N 个文件」。 */
    items.push({
      label: `忽略选中的 ${paths.length} 个文件(写入 .gitignore)`,
      action: () => actions.appendIgnoreFile?.(paths),
      /*
       * `:742-744`:只要选中项里**有一个**不是 `.gitignore` 就启用
       * (忽略 `.gitignore` 自己没有意义)。
       */
      enabled: canIgnore && paths.some((path) => Path.basename(path) !== GIT_IGNORE_FILE_NAME),
    });
  }

  /* :747-757 —— 「忽略全部 <扩展名> 文件」,最多 5 条,按 Set 的插入序。 */
  for (const selectedExtension of [...extensions].slice(0, 5)) {
    items.push({
      label: `忽略全部 ${selectedExtension} 文件(写入 .gitignore)`,
      action: () => actions.appendIgnorePattern?.(`*${selectedExtension}`),
      enabled: canIgnorePattern,
    });
  }

  if (paths.length > 1) {
    /*
     * :759-781 —— 多选:纳入 / 排除 + 「复制路径」(复数)。
     *
     * ⚠️ 上游这两个动作**逐文件**调 `onIncludeChanged`
     * (`selectedFiles.map(file => this.props.onIncludeChanged(file, true))`,`:767`),
     * 我们批调 `setFilesIncluded(paths, …)` —— 落到 `store.setFilesIncluded`
     * (`store.ts:1442`),它就是对同一张 `includeState` 表逐个写,语义等价。
     */
    items.push(
      { type: 'separator' },
      {
        label: '纳入选中的文件',
        action: () => actions.setFilesIncluded(paths, true),
      },
      {
        label: '排除选中的文件',
        action: () => actions.setFilesIncluded(paths, false),
      },
      { type: 'separator' },
      {
        label: '复制路径',
        action: () => actions.copyText(
          selectedFiles.map((selected) => absolutePathOf(repositoryPath, selected.path)).join(EOL),
        ),
      },
      {
        label: '复制相对路径',
        action: () => actions.copyText(
          selectedFiles.map((selected) => Path.normalize(selected.path)).join(EOL),
        ),
      },
    );
  } else {
    /* :782-788 —— 单文件:两条单数「复制路径」。 */
    items.push(
      { type: 'separator' },
      {
        label: '复制路径',
        action: () => actions.copyText(absolutePathOf(repositoryPath, hitPath)),
      },
      {
        label: '复制相对路径',
        action: () => actions.copyText(Path.normalize(hitPath)),
      },
    );
  }

  /*
   * :790-800 —— 尾部三项。
   *
   * `enabled` 的**两档不是同一个判据**:
   *  · 「在文件管理器中显示」与「在 <编辑器> 中打开」禁用的唯一条件是
   *    **文件被删除**(`:790`,`status.kind !== Deleted`)—— 磁盘上没有这个东西;
   *  · 「用系统默认程序打开」在这之上**再叠一层** `.exe` 那一族
   *    (`:798`,`enabled && isSafeFileExtension`)。
   */
  const notDeleted = !isDeleted(file);
  items.push(
    { type: 'separator' },
    {
      label: revealLabel(),
      action: () => actions.revealInFileManager(absolutePathOf(repositoryPath, hitPath)),
      enabled: notDeleted,
    },
    {
      label: openInEditorLabel(externalEditor),
      action: () => actions.openInExternalEditor(
        absolutePathOf(repositoryPath, hitPath),
        externalEditor?.id,
      ),
      enabled: notDeleted,
    },
    {
      label: '用系统默认程序打开',
      /*
       * ⭐ 这一项**不需要新路由**:`store.openInExternalEditor(abs)` 不带 `appId`
       * ⇒ `api.systemOpenInApp(path)` 的 body 只有 `{path}`(`api.ts:792-793`)
       * ⇒ 宿主 `SystemService.openInApp(path, undefined)` 的 argv 是
       * `['open', path]`(`src/host/system-service.ts:143-144`)—— 与上游
       * `shell.openPath(fullPath)`(`ui/lib/open-file.ts:8`)同一件事:
       * **用该文件类型的默认程序打开**,不是「编辑器」。
       */
      action: () => actions.openInExternalEditor(absolutePathOf(repositoryPath, hitPath)),
      enabled: notDeleted && isSafeExtension,
    },
  );

  return items;
}

/**
 * **rebase 冲突态**下的逐文件菜单 —— 上游 `getRebaseContextMenu`
 * (`filter-changes-list.tsx:805-837`)的移植。
 *
 * 差别只有两处,但都是语义:
 *  1. **只有未跟踪文件**才给「丢弃改动」(`:815-819`;冲突中的已跟踪文件丢不得);
 *  2. 没有「忽略 / 纳入 / 排除」—— rebase 中改 `.gitignore` 与改纳入状态都没有意义。
 */
export function changesFileRebaseMenuItems(
  target: IChangesFileMenuTarget,
  actions: IChangesFileMenuActions,
): IMenuItem[] {
  const { file, repositoryPath, externalEditor } = target;
  const notDeleted = !isDeleted(file);
  const isSafeExtension = isSafeFileExtension(Path.extname(file.path));

  const items: IMenuItem[] = [];

  if (file.untracked === true) {
    items.push(
      {
        label: '丢弃改动…',
        action: () => actions.discard([file]),
      },
      { type: 'separator' },
    );
  }

  items.push(
    {
      label: '复制路径',
      action: () => actions.copyText(absolutePathOf(repositoryPath, file.path)),
    },
    {
      label: '复制相对路径',
      action: () => actions.copyText(Path.normalize(file.path)),
    },
    { type: 'separator' },
    {
      label: revealLabel(),
      action: () => actions.revealInFileManager(absolutePathOf(repositoryPath, file.path)),
      enabled: notDeleted,
    },
    {
      label: openInEditorLabel(externalEditor),
      action: () => actions.openInExternalEditor(
        absolutePathOf(repositoryPath, file.path),
        externalEditor?.id,
      ),
      enabled: notDeleted,
    },
    {
      label: '用系统默认程序打开',
      action: () => actions.openInExternalEditor(absolutePathOf(repositoryPath, file.path)),
      enabled: notDeleted && isSafeExtension,
    },
  );

  return items;
}

/**
 * 打开逐文件菜单。上游 `onItemContextMenu`(`:839-857`)的**早退条件逐字保留**:
 * `isCommitting` 为真时**连菜单都不弹**(`:845-847`)。
 *
 * @returns 菜单关闭后 resolve(与上游 `showContextualMenu` 同形)。
 */
export async function showChangesFileMenu(
  target: IChangesFileMenuTarget,
  actions: IChangesFileMenuActions,
): Promise<void> {
  installContextMenuHost();
  if (target.committing) {
    return;
  }
  const items = target.rebaseConflict
    ? changesFileRebaseMenuItems(target, actions)
    : changesFileMenuItems(target, actions);
  await showContextualMenu(items);
}

/** 列表**表头**右键菜单的输入(上游 `:543-547`)。 */
export interface IChangesListMenuTarget {
  /** 工作区文件(上游 `workingDirectory.files`,判 `hasLocalChanges`)。 */
  readonly files: readonly ChangedFile[];
  /** 当前分支名;`null` = 游离头 / unborn(上游 `branch !== null`)。 */
  readonly branch: string | null;
  /** 是否有冲突文件(上游 `hasConflictedFiles(workingDirectory)` 那一半)。 */
  readonly hasConflictedFiles: boolean;
  /** 是否有进行中的冲突操作(上游 `conflictState !== null` 那一半)。 */
  readonly conflictState: boolean;
  /** 是否正在提交(上游 `isCommitting` 的早退)。 */
  readonly committing: boolean;
  /** 是否处于 rebase 冲突态(上游 `rebaseConflictState !== null` 的早退)。 */
  readonly rebaseConflict: boolean;
  /** 是否已经有 stash(决定标签带不带省略号,`:544`、`:563`)。 */
  readonly hasStash: boolean;
}

/** 表头菜单的动作(上游 `onDiscardAllChanges` / `onStashChanges`)。 */
export interface IChangesListMenuActions {
  /** 丢弃**全部**工作区改动(调用方弹确认框,`discardingAllChanges: true`)。 */
  readonly discardAll: (files: readonly ChangedFile[]) => void;
  /** 贮藏全部改动(上游 `onStashChanges`)。**缺省** ⇒ 那一项在列但禁用。 */
  readonly stashAll?: () => void;
}

/**
 * **列表表头**右键菜单 —— 上游 `onContextMenu`(`filter-changes-list.tsx:535-570`)的移植。
 *
 * 上游挂在 `.header.filter-field-row` 上(`:1234-1243` 的 `renderFilterRow`),
 * 也就是「筛选框 + N changed files 那一行」——在我们的面里就是 `.gw-chead`。
 */
export function changesListMenuItems(
  target: IChangesListMenuTarget,
  actions: IChangesListMenuActions,
): IMenuItem[] {
  const hasLocalChanges = target.files.length > 0;
  /*
   * 上游 :543-547:`hasConflicts = conflictState !== null || hasConflictedFiles(workingDirectory)`。
   * 我们这两半分别由 `status.operation !== null` 与 `files` 里的 `conflicted` 供。
   */
  const hasConflicts = target.conflictState || target.hasConflictedFiles;

  return [
    {
      label: '丢弃全部改动…',
      action: () => actions.discardAll(target.files),
      enabled: hasLocalChanges,
    },
    {
      /* `:549-554,563` —— 已经有 stash 时标签带省略号(表示「还会再问一次」)。 */
      label: target.hasStash ? '贮藏全部改动…' : '贮藏全部改动',
      action: () => actions.stashAll?.(),
      enabled: actions.stashAll !== undefined
        && hasLocalChanges
        && target.branch !== null
        && !hasConflicts,
    },
  ];
}

/**
 * 打开表头菜单。上游的早退条件(`:539-541`)**比逐文件那一条多一个**
 * (`rebaseConflictState !== null` 也算):rebase 冲突中连「丢弃全部」都不给。
 */
export async function showChangesListMenu(
  target: IChangesListMenuTarget,
  actions: IChangesListMenuActions,
): Promise<void> {
  installContextMenuHost();
  if (target.committing || target.rebaseConflict) {
    return;
  }
  await showContextualMenu(changesListMenuItems(target, actions));
}

/**
 * 已解析的**主外部编辑器** —— 上游 `externalEditorLabel`
 * (`filter-changes-list.tsx:642`,值来自 `app-store` 的 `getResolvedExternalEditor`)。
 *
 * ⚠️ 这是**同一份投影的第二处出现**:`src/client/changes-view.tsx` 的空态卡
 * (`NoChanges`)自己算过一模一样的三行。抽到这里是为了让**行菜单与空态卡不可能分家**
 * (两处都改读本函数;`preferredEditorId` 仍由调用方从 `getPreferredExternalEditor()` 取
 * —— 那是偏好的唯一读侧,本文件不重读)。
 *
 * @param apps - `snap.externalApps`。
 * @param preferredEditorId - 用户在设置里选过的编辑器 id;
 *   `null`/`undefined` = 没有偏好(那正是 `getPreferredExternalEditor()`(`prefs.ts:156`)
 *   的返回形状:`string | null`)。
 */
export function resolvePrimaryExternalEditor(
  apps: readonly { readonly id: string; readonly label: string }[],
  preferredEditorId: string | null | undefined,
): { readonly id: string; readonly label: string } | undefined {
  const editors = apps.filter((app) => app.id !== 'default');
  return editors.find((app) => app.id === preferredEditorId) ?? editors[0];
}
