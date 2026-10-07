/**
 * History 视图 —— **上游 `ui/history/**` 的适配层**。
 *
 * ## 这一版与上一版的根本区别
 *
 * 上一版是整个页签**手写**的(520 行:自己的提交列表、自己的摘要头、自己的文件列表),
 * 上游 `src/core/desktop/ui/history/**`(12 文件 / 4,022 行)一行都没沿用。这一版把
 * 三件事**换成上游组件**,本文件只做「宿主数据 → 上游 props」的翻译:
 *
 * | 区域 | 上游组件(与上游一致) | 上游 DOM |
 * |---|---|---|
 * | 提交列表 | `ui/history/commit-list.tsx` → `commit-list-item.tsx` | `#commit-list > List`(行高 **50px**,`commit-list.tsx:33`) |
 * | 提交摘要头 | `ui/history/expandable-commit-summary.tsx` | `#expandable-commit-summary`(subject / 短 SHA + `CopyButton` / `+N −M` / 展开正文) |
 * | 变更文件列表 | `ui/history/file-list.tsx` → `committed-file-item.tsx` | `.file-list-header` + `.file-list > List`(行高 **29px**) |
 * | diff 头部 | `ui/diff/diff-header.tsx` | `.diff-container > .header`(`PathLabel` + `DiffOptions` 齿轮 + 状态 Octicon) |
 * | diff 正文 | `ui/diff/seamless-diff-switcher.tsx`(经 `./desktop-diff.tsx`) | `.gw-desktop-diff` |
 * | 可拖拽分隔条 | `ui/resizable/resizable.tsx` | `.resizable-component` + `.resize-handle` |
 *
 * 布局也换成上游 `selected-commits.tsx:305-325` 的形状:
 *
 * ```
 * <div id="history" class="expanded|collapsed">        ← 上游 selected-commits.tsx:310
 *   {renderCommitSummary()}                            ← ExpandableCommitSummary,横跨整宽
 *   <div class="commit-details">                       ← 上游是「摘要在上 + 下面两栏」
 *     <Resizable>{renderFileList()}</Resizable>        ← 文件列表(窄、可拖、自己的滚动条)
 *     <div class="diff-container">…</div>              ← diff(宽)
 *   </div>
 * </div>
 * ```
 *
 * 上一版是「摘要 + 文件列表 + diff 三块**共用一个 `overflow:auto` 容器**」
 * (`docs/handwritten-vs-upstream/2-diff-and-history.md` §3.0 点的结构差异),长提交正文会把
 * 文件列表与 diff 一起挤出视口。这一版不再共用:文件列表有自己的 `Resizable` 与自己的
 * 滚动条,diff 在自己的列里。
 *
 * ## 数据从哪来 / 谁翻译
 *
 * 浏览器半没有任何本地 git 访问(§2.4),宿主给的是**扁平记录**:
 * `CommitEntry`(`src/core/types.ts:125`)、`commitDetailFiles`、`api.diff` 的 patch。
 * 上游组件要的是**模型实例**:`Commit` / `CommittedFileChange` / `Repository` /
 * `IChangesetData`。翻译全在下面 `toCommit` / `toAppFileStatus` / `toCommittedFileChange`
 * 三个纯函数里 —— 这是本项目唯一允许的适配形态(§2.1:**不改上游文件**,在我们这层包一层)。
 *
 * 三处刻意的映射(每处都在函数上写了理由):
 *  1. `CommitEntry.refs`(`['HEAD -> main', 'tag: v1.0', 'origin/main']`)→ 上游 `Commit.tags`
 *     (只挑 `tag: ` 前缀)。上游的 tag chip(`.tag-name` + `+N` 角)因此真的有数据;
 *  2. 宿主的单字母状态 → 上游 `AppFileStatus` 判别联合(上游要的是对象,不是字母);
 *  3. `localCommitSHAs`(哪些提交还没 push)→ 用 `snap.sync.ahead` 从 `snap.log` 头部数出来。
 *     **这是近似**(见 `localCommitSHAsFrom`)。
 *
 * ## 本版**没有**接的两块(写明,不假装)
 *
 * 1. **分支 / Compare 条**(`ui/history/compare.tsx` 的 `TabBar` + `BranchList` +
 *    ahead/behind + merge CTA)。它依赖 `ui/branches/**`(顶栏那条线在移植)与
 *    `lib/stores/ahead-behind-store.ts`(§1.3 排除的 `lib/stores/**`)。本轮按文件所有权
 *    留给 branches 线,**只交付「提交列表 + 提交项 + 可展开摘要 + 变更文件列表 + diff 列」**。
 *    交接说明见本文件末尾。
 * 2. **多选提交的区间 diff**。上游对**连续多选**算整段 changeset
 *    (`selected-commits.tsx:283` → 宿主的 `changesetData`),对**不连续多选**渲染
 *    `#multiple-commits-selected` 空态;宿主今天只有单提交 diff(`api.diff` 收一个
 *    `commit`,没有区间参数)⇒ 多选一律走空态并把原因写给用户,而不是显示一个**错的** diff。
 *
 * ## 文案(§11.9 人类裁决:先统一中文)
 *
 * - **从 props 传进去的**:本文件就是调用点,直接写中文(`加载更多`、「还没有提交」…)，
 *   镜像文件一个字不改。
 * - **写死在镜像文件内部的**:不改(会破坏字节一致这个头号不变式)。仍显示英文的条目
 *   逐条登记在 `docs/` 的清单里(见报告);`N changed files` 是其中一个 —— 它由
 *   `selected-commits.tsx:279-283` 渲染,本文件按上游同一 DOM(`.file-list-header`)
 *   输出**中文**文案,所以这条在我们这条路径上不会出现。
 *
 * @module dsh-git/client/history-view
 */

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode, RefObject } from 'react';
import { api } from './api.ts';
import type { GitStore, Snapshot } from './store.ts';
import type { ChangeStatus, CommitEntry, DiffResult, SyncState } from '../core/types.ts';
import { DesktopDiff, desktopDiffFromPatch } from './desktop-diff.tsx';
// 提交行右键菜单里「Create Branch from Commit」要一个名字输入框 —— 复用共享件,
// 不为这一项新造一个对话框(形状与 Desktop 的 Create Branch 一致:标题 + 单行输入)。
import { ConfirmDialog } from './bits.tsx';

/* ==========================================================================
 * 上游(与上游一致)的 import —— 一律带显式扩展名,与 `src/client/**` 其它文件的写法一致
 * ======================================================================== */
import { Commit } from '../core/desktop/models/commit.ts';
// 只是类型:`models/commit.ts` 已经在上面被 value-import 了,所以这里不新增任何模块边。
import type { CommitOneLine } from '../core/desktop/models/commit.ts';
import { CommitIdentity } from '../core/desktop/models/commit-identity.ts';
import { Repository } from '../core/desktop/models/repository.ts';
import {
  AppFileStatusKind,
  CommittedFileChange,
  GitStatusEntry,
  UnmergedEntrySummary,
} from '../core/desktop/models/status.ts';
import type { AppFileStatus } from '../core/desktop/models/status.ts';
import type { Emoji } from '../core/desktop/lib/emoji.ts';
import type { IChangesetData } from '../core/desktop/lib/git/index.ts';
import { CommitList } from '../core/desktop/ui/history/commit-list.tsx';
import { ExpandableCommitSummary } from '../core/desktop/ui/history/expandable-commit-summary.tsx';
import { FileList } from '../core/desktop/ui/history/file-list.tsx';
import { DiffHeader } from '../core/desktop/ui/diff/diff-header.tsx';
import { Resizable } from '../core/desktop/ui/resizable/index.ts';
import { setGitShowHost } from '../core/desktop/lib/git/show.ts';
import { setFileSystemHost } from '../core/desktop/lib/file-system.ts';
import { setFsPromisesHost } from './shim-node-fs-promises.ts';

/* ============================================================================
 * 宿主取数钩子(模块作用域安装,幂等)
 *
 * 上游 `ui/diff/syntax-highlighting/index.ts` 在**没有** `externalFileContents` 时
 * 会去问 `lib/git/show.ts` / `lib/file-system.ts` 要「旧/新文件内容」;
 * `ui/history/selected-commits.tsx` 的文件列表右键则问 `lib/path-exists.ts` 的
 * `access`。那三个镜像文件的取数原本都是打桩的(前两个恒 `null`,第三个抛错),
 * 所以上游那条路走不通 —— 2026-10-06 按「注入式宿主钩子」把它们接到宿主
 * (`setGitShowHost` / `setFileSystemHost` / `setFsPromisesHost`,与
 * `setNonFatalExceptionHost`、`installContextMenuHost` 同一条模式:
 * **注入点在我们的层,镜像只保留上游导出名与签名**)。
 *
 * 效果:上下文展开(`canBeExpanded`)与语法高亮的「旧/新内容」走**上游自己的**取数路径
 * 就能拿到真内容,不再依赖我们给 `SeamlessDiffSwitcher` 传 `externalFileContents`。
 * ========================================================================== */

/**
 * 已注册的仓库根(最长前缀匹配用),**由钩子自己懒加载**(缓存 60s)。
 *
 * 钩子拿到的都是**绝对路径**(上游 `Path.join(repository.path, file.path)`),
 * 而宿主路由要「仓库根 + 仓库内相对路径」两个参数。
 *
 * 为什么**不**依赖组件把当前仓库写进模块变量:钩子挂在模块作用域,而
 * 「当前是哪个仓库」只在渲染期知道 —— 那样首帧之前、或另一个页签触发的调用
 * 就会解析失败。这里直接问宿主要仓库清单(`api.repos()`,一次几十字节),语义完整
 * (含 `lastSelected`),也不受渲染时序影响。
 */
let repoRootsCache: { roots: ReadonlyArray<string>; at: number } | null = null;
const REPO_ROOTS_TTL_MS = 60_000;

/** 取已知仓库根(缓存 60s)。失败时返回空数组 ⇒ 钩子按「拿不到」处理。 */
async function repoRoots(): Promise<ReadonlyArray<string>> {
  const now = Date.now();
  if (repoRootsCache !== null && now - repoRootsCache.at < REPO_ROOTS_TTL_MS) {
    return repoRootsCache.roots;
  }
  const result = await api.repos();
  const roots = result.ok
    ? [result.value.lastSelected, ...result.value.repos.map((repo) => repo.path)].filter(
        (root) => root !== '',
      )
    : [];
  repoRootsCache = { roots, at: now };
  return roots;
}

/**
 * 把绝对路径拆成「仓库根 + 相对路径」。解析不出来返回 `null`
 * (那时钩子一律按「拿不到」处理,而不是猜一个仓库)。
 * @param absolutePath - 上游传来的绝对路径。
 */
async function splitRepoPath(
  absolutePath: string,
): Promise<{ root: string; relative: string } | null> {
  let best: string | null = null;
  for (const root of await repoRoots()) {
    if (root === '') { continue; }
    if (absolutePath === root) { continue; }
    const prefix = root.endsWith('/') ? root : `${root}/`;
    if (absolutePath.startsWith(prefix) && (best === null || root.length > best.length)) {
      best = root;
    }
  }
  if (best === null) { return null; }
  const prefix = best.endsWith('/') ? best : `${best}/`;
  return { root: best, relative: absolutePath.slice(prefix.length) };
}

/** `repo/tree` 的文件名集合缓存:仓库 → 文件名 Set。存在性判断的**零字节**通道。 */
const treeCache = new Map<string, { files: Set<string>; at: number }>();
/** 树缓存的存活时间。右键菜单在几十秒内反复打开不会重复拉列表。 */
const TREE_TTL_MS = 30_000;

/**
 * 取某仓库的文件名集合(缓存 30s)。
 *
 * 为什么用它而不是直接问 `file-text`:**宿主的 `file-text` 对存在的大文本文件会把整份
 * 读回**(`src/host/git-service.ts:917` 的 `readFile(target,'utf8')`),
 * 而 `repo/tree` 只是 `git ls-files` 的**文件名**(同一文件 `:511-524`),
 * **一个文件字节都不读**。真正缺失的文件在 `file-text` 那条回落路上也**不会读**
 * (宿主先 `lstat` 再抛,`:895-896`)。
 * @param root - 仓库根。
 */
async function treeFilesFor(root: string): Promise<Set<string> | null> {
  const cached = treeCache.get(root);
  const now = Date.now();
  if (cached !== undefined && now - cached.at < TREE_TTL_MS) { return cached.files; }
  const result = await api.repoTree(root);
  if (!result.ok) { return null; }
  const files = new Set(result.value.files);
  treeCache.set(root, { files, at: now });
  return files;
}

/** `access` 的结果记忆化(键 `仓库根\0相对路径`),避免右键菜单反复问同一路径。 */
const accessCache = new Map<string, { exists: boolean; at: number }>();
const ACCESS_TTL_MS = 30_000;

/** 造一个 `ENOENT`,与 node 的 `fs.promises.access` 同名同 `code`。 */
function enoent(path: string): Error & { code: string } {
  const error = new Error(`ENOENT: no such file or directory, access '${path}'`) as Error & {
    code: string;
  };
  error.code = 'ENOENT';
  return error;
}

let hooksInstalled = false;

/** 安装三个宿主钩子(幂等;本模块被 import 时执行一次)。 */
function installHostFileHooks(): void {
  if (hooksInstalled) { return; }
  hooksInstalled = true;

  /**
   * 上游 `lib/git/show.ts` 的取数:`<commitish>:<path>` 的文本内容。
   * 走宿主既有的 `show-file` 路由;非文本(二进制/超大/缺失)一律回 `null`,
   * 与上游「路径不在该 ref 里」的返回值同义。
   */
  setGitShowHost({
    partialBlob: async (repositoryPath, commitish, path, length) => {
      const result = await api.showFile(repositoryPath, commitish, path);
      if (!result.ok) { return null; }
      const value = result.value;
      if (value.kind !== 'text') { return null; }
      return value.text.slice(0, Math.min(length, value.text.length));
    },
  });

  /** 上游 `lib/file-system.ts` 的取数:工作区文件的字节区间(按字符近似,见下)。 */
  setFileSystemHost({
    partialFile: async (absolutePath, start, end) => {
      const split = await splitRepoPath(absolutePath);
      if (split === null) { return null; }
      const result = await api.fileText(split.root, split.relative);
      if (!result.ok || result.value.kind !== 'text') { return null; }
      // 上游给的是**字节**区间,这里按字符切:调用点 `syntax-highlighting/index.ts:94`
      // 传的是 `(0, MaxHighlightContentLength - 1)`(从文件头开始),UTF-8 多字节字符
      // 只会让「取到的前缀」比字节口径略短 —— 对「够不够做高亮」这件事没有影响。
      return result.value.text.slice(start, end + 1);
    },
  });

  /** 上游 `lib/path-exists.ts` 的 `access`:存在 → resolve,不存在 → reject(ENOENT)。 */
  setFsPromisesHost({
    access: async (absolutePath) => {
      const split = await splitRepoPath(absolutePath);
      if (split === null) throw enoent(absolutePath);

      const key = `${split.root}\u0000${split.relative}`;
      const now = Date.now();
      const cached = accessCache.get(key);
      if (cached !== undefined && now - cached.at < ACCESS_TTL_MS) {
        if (cached.exists) { return; }
        throw enoent(absolutePath);
      }

      // ① 零文件字节的通道:文件名集合(`git ls-files`,遵守 .gitignore)。
      const files = await treeFilesFor(split.root);
      if (files !== null && files.has(split.relative)) {
        accessCache.set(key, { exists: true, at: now });
        return;
      }

      // ② 回落:树里没有(被 .gitignore 挡掉、或真的不存在)时问宿主。
      //    **真缺失**的文件在这一步也是 0 字节:宿主先 lstat 再抛。
      const result = await api.fileText(split.root, split.relative);
      accessCache.set(key, { exists: result.ok, at: now });
      if (!result.ok) throw enoent(absolutePath);
    },
  });
}

installHostFileHooks();

/* ============================================================================
 * 可拖拽分隔条:宽度控制器(Changes 与 History 两个页签共用)
 *
 * 组件本体是**与上游一致**的 Desktop `ui/resizable/resizable.tsx`(见
 * `src/core/desktop/ui/resizable/`),交互语义完全由它决定:
 *   · 在手柄上按下鼠标 → 记下 `startX` 与当前宽度,监听 document 的 mousemove/mouseup,
 *     `新宽度 = 起始宽度 + (clientX − startX)`,**实时**回调 `onResize`;
 *   · 双击手柄 → `onReset`;
 *   · 键盘 → 监听容器上的自定义事件 `increase-active-resizable-width` /
 *     `decrease-active-resizable-width`,每次 **±5px**(上游 `resizable.tsx:136` 硬编码)。
 *
 * 这里补的是 Desktop 应用层那部分(**未移植**,也不打算移植 `lib/stores/app-store.ts`):
 * 宽度数值、约束、持久化,以及把键盘事件喂给上面那套 CustomEvent 契约。
 *
 * 为什么放在这个文件里:`changes-view.tsx` 已经 `import { SplitPane,
 * useSplitWidth, SIDEBAR_WIDTH_STORAGE_KEY, toCommit } from './history-view.tsx'`,方向一致、
 * 不产生循环依赖。控制器只有一份,避免两处漂移。
 * ========================================================================== */

/**
 * 宽度约束(纯数值,可单测)。
 *
 * Desktop 的约束在 `lib/stores/app-store.ts` 的 `updateResizableConstraints()`(应用层,
 * 未移植):仓库侧栏 **默认 250 / 最小 220 / 最大 = 可用宽 − 150**;History 的文件列表
 * **默认 250 / 最小 100 / 最大 = 可用宽 − 150**。
 *
 * **我们的插件长在 280–720px 的 DSH 侧栏里**(`styles.ts` 的 `.gw-root{min-width:280px}`,
 * 用户实测约 320–720),220 的最小值在 320px 面板上会把 diff 挤到 100px ——
 * `docs/desktop-inventory.md` §9.1.3/§F 已经点名这件事。所以三个数里只改**最小**:
 *
 * | 数值 | 取值 | 理由 |
 * |---|---|---|
 * | 默认 | **250** | 与 Desktop 逐字一致,只在极窄面板上被夹 |
 * | 给 diff 预留 | **150** | 沿用 Desktop 的 `max = 可用宽 − 150`(即 diff 至少 150px) |
 * | 最小 | **160** | 唯一改掉的数。320px 面板上 160 + 150 = 310 ≤ 320,两边同时满足;220 则要求面板 ≥ 370px |
 *
 * 面板比 `最小 + 150` 还窄时(极端情况),`max` 会被抬到 `min`,宽度**钉死在 160** ——
 * 这正是 Desktop 在窗口窄到 460 以下时的行为(「min 胜出、侧栏钉死」)。
 * 实际使用中不会走到:420px 以下两栏已经竖排,横向分隔条根本不存在。
 */
export const SPLIT_MIN_WIDTH = 160;
export const SPLIT_DEFAULT_WIDTH = 250;
export const SPLIT_DIFF_MIN_WIDTH = 150;

/** 与 `styles.ts` 里 `@container (max-width:420px)` 同一个断点:低于它两栏竖排、无分隔条。 */
export const SPLIT_STACK_BREAKPOINT = 420;

/** 还没量到容器宽度时用的兜底面板宽度(= DSH 侧栏宽度的上限 720)。 */
const SPLIT_FALLBACK_PANE_WIDTH = 720;

/** 持久化键(照 Desktop 的两个配置键命名,加插件前缀避免与宿主/其他插件撞)。 */
export const SIDEBAR_WIDTH_STORAGE_KEY = 'dsh-git.sidebar-width';
export const COMMIT_SUMMARY_WIDTH_STORAGE_KEY = 'dsh-git.commit-summary-width';

/** 上游 `resizable.tsx:151-166` 监听的两个自定义事件名,沿用。 */
const RESIZE_INCREASE_EVENT = 'increase-active-resizable-width';
const RESIZE_DECREASE_EVENT = 'decrease-active-resizable-width';

/**
 * 把宽度夹进「当前面板宽度」允许的区间。
 *
 * **纯函数**(`/tmp` 探针直接喂输入表验证:320px 面板、超大/超小拖拽量、负值都覆盖)。
 * 语义与上游 `Resizable.clampWidth()` 一致(`clamp(width, min, max)`),只是上下界
 * 随面板宽度变化。`paneWidth` 取面板的**可用宽**,`max` 因此是 `paneWidth − 150`。
 * @param width - 期望宽度。
 * @param paneWidth - 面板当前可用宽度。
 */
export function clampSplitWidth(width: number, paneWidth: number): number {
  const max = Math.max(SPLIT_MIN_WIDTH, paneWidth - SPLIT_DIFF_MIN_WIDTH);
  return Math.min(Math.max(width, SPLIT_MIN_WIDTH), max);
}

/** 读回持久化宽度。隐私模式/被禁用时 localStorage 会抛,退回默认值而不是崩。 */
function readStoredSplitWidth(key: string): number {
  try {
    const raw = window.localStorage.getItem(key);
    const parsed = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(parsed) ? parsed : SPLIT_DEFAULT_WIDTH;
  } catch {
    return SPLIT_DEFAULT_WIDTH;
  }
}

/** 写入持久化宽度。存不下就算了:宽度只在本次会话生效,不影响拖拽本身。 */
function writeStoredSplitWidth(key: string, width: number): void {
  try {
    window.localStorage.setItem(key, String(width));
  } catch {
    // 忽略
  }
}

/** `useSplitWidth()` 的返回值。 */
export interface SplitController {
  /**
   * 挂到 `.gw-split` 容器上(量宽度 + 键盘事件的边界)。
   *
   * ⚠️ **优先用 {@link SplitController.attachContainerRef}**;这个对象 ref 仍在(内部那些
   * `containerRef.current` 读法不变),但它**自身无法通知「节点出现了」**——见下面那条
   * 2026-10 的缺陷与修法。
   */
  readonly containerRef: RefObject<HTMLDivElement | null>;
  /**
   * 挂到 `.gw-split` 容器上的**回调 ref**(替代 `ref={containerRef}` 的写法)。
   *
   * 为什么必须有它(2026-10 实测的缺陷):`ChangesView` 在 `status === null` 时提前渲染
   * 「读取仓库状态…」,**那时 `.gw-split` 根本不存在**;而下面的量宽 `useLayoutEffect`
   * 依赖表原先写的是 `[]` ⇒ 它只在**第一次挂载**量一次,`containerRef.current === null`
   * 时直接 return 且**永不重试** ⇒ `paneWidth` 恒 0、`stacked` 恒 false:
   *
   * | 场景(实测) | 修前 | 应当是 |
   * |---|---|---|
   * | 宿主 380px **冷挂载** | 轨道 `330px 50px`(diff 栏塌成 50px、不竖排) | 竖排、左栏满宽 `380px` |
   * | 宿主 620px + 存储 900 **冷挂载** | 轨道 `570px 50px`(按回退值 720 夹) | `470px 150px`(按真实面板夹) |
   *
   * 回调 ref 在**提交阶段**被调用(先于布局 effect、先于绘制)⇒ `setContainer(node)` 触发的
   * 重渲染与量宽都在同一帧绘制之前完成,**不会先画错一帧再纠正**(见探针
   * `docs/probes/split-measure-probe.mjs` 判据 4)。
   */
  readonly attachContainerRef: (node: HTMLDivElement | null) => void;
  /** 内联到 `.gw-split` 的样式:横排时钉住左栏轨道;竖排时不写,交给容器查询。 */
  readonly containerStyle: CSSProperties | undefined;
  /** 当前生效宽度(已按可用宽度夹过)。 */
  readonly width: number;
  /** 当前最大宽度,随容器宽度变化。 */
  readonly maximumWidth: number;
  /** 容器是否已窄到竖排(< 420px)。 */
  readonly stacked: boolean;
  /** 交给 `<Resizable onResize>`。 */
  readonly onResize: (next: number) => void;
  /** 交给 `<Resizable onReset>`(双击手柄)。 */
  readonly onReset: () => void;
}

/**
 * 宽度状态机:量容器 → 夹紧 → 持久化 → 把键盘接进上游的事件契约。
 * @param storageKey - localStorage 键(两个页签各一个)。
 */
export function useSplitWidth(storageKey: string): SplitController {
  const containerRef = useRef<HTMLDivElement | null>(null);
  /**
   * 容器节点本身也是 state:量宽 effect 必须能**在节点出现之后**重跑。
   * 只留 `useRef` 时「节点从 null 变成非 null」这件事**不可观测**(ref 赋值不触发渲染),
   * 效果就是上面那条 `paneWidth` 恒 0 的缺陷。
   */
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [paneWidth, setPaneWidth] = useState(0);
  const [storedWidth, setStoredWidth] = useState<number>(() => readStoredSplitWidth(storageKey));

  /**
   * 回调 ref:两个都写。
   *
   * `containerRef.current` 保持有效(本文件里键盘 effect 等仍按老读法取它),
   * 而 `setContainer` 让量宽 effect 有一个**真实的依赖**。
   * `useCallback` 保证同一个函数身份 ⇒ React 不会在每次渲染时「卸载再挂载」这个 ref
   * (那会在 `container` 上制造抖动,进而让下面的 effect 反复重订阅 ResizeObserver)。
   */
  const attachContainerRef = useCallback((node: HTMLDivElement | null): void => {
    containerRef.current = node;
    setContainer(node);
  }, []);

  // ---- 量容器 ----
  // 用 ResizeObserver:宿主侧栏本身可以被用户拖动、DSH 也能切全屏,`window.resize`
  // 抓不到「容器变宽但窗口没变」的情况。没有 ResizeObserver(旧 WebView / 探针环境)
  // 时退回 window resize,至少不会完全不工作。
  //
  // 刻意用 `useLayoutEffect`:首帧还不知道面板宽度,`stacked` 只能是 false(会按横排画),
  // 而被动 effect 在**绘制之后**才跑 —— 320px 面板上会闪一帧错误布局。布局 effect 在
  // 浏览器绘制前跑完并同步重渲染,没有这一帧。
  //
  // ⚠️ 依赖是 **`[container]` 而不是 `[]`**(2026-10 修):`[]` 只量一次,而容器可能
  // **晚于组件挂载**才出现(ChangesView 的「读取仓库状态…」那一支),于是量宽永不发生。
  // 改成节点依赖之后,「节点出现」这一次重渲染会**重新量一次**并挂上 ResizeObserver。
  useLayoutEffect(() => {
    if (container === null) {
      return;
    }
    const measure = (): void => { setPaneWidth(container.clientWidth); };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => { window.removeEventListener('resize', measure); };
    }
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => { observer.disconnect(); };
  }, [container]);

  // 还没量到宽度时(首帧 / 探针里 clientWidth = 0)按侧栏上限算,免得用 Desktop 的
  // `DefaultMaxWidth = 350` 把用户存的宽度夹出一个假值。
  const effectivePaneWidth = paneWidth > 0 ? paneWidth : SPLIT_FALLBACK_PANE_WIDTH;
  const stacked = paneWidth > 0 && paneWidth < SPLIT_STACK_BREAKPOINT;
  const width = clampSplitWidth(storedWidth, effectivePaneWidth);
  const maximumWidth = Math.max(SPLIT_MIN_WIDTH, effectivePaneWidth - SPLIT_DIFF_MIN_WIDTH);

  /**
   * 提交一个**用户明确要求**的宽度:夹紧 → 落盘。
   *
   * 只在这里落盘(不在渲染时按当前面板宽度回写):宿主侧栏临时变窄不该把用户的选择
   * 永久改掉 —— 渲染时永远按当下宽度再夹一次,所以窄面板也不会溢出。
   */
  const commit = (next: number): void => {
    const clamped = clampSplitWidth(next, effectivePaneWidth);
    setStoredWidth(clamped);
    writeStoredSplitWidth(storageKey, clamped);
  };

  const onResize = (next: number): void => { commit(next); };

  const onReset = (): void => {
    // Desktop 的 onReset(`repository.tsx:handleSidebarWidthReset`)把宽度写回该面板的
    // **默认值**(约束层再夹一次),不是「拖之前的值」。
    setStoredWidth(SPLIT_DEFAULT_WIDTH);
    writeStoredSplitWidth(storageKey, clampSplitWidth(SPLIT_DEFAULT_WIDTH, effectivePaneWidth));
  };

  // ---- 键盘 ----
  // 上游只在容器 div 上监听两个自定义事件(`resizable.tsx:148-169`),谁派发它不管。
  // Desktop 由应用菜单派发(`ui/app.tsx:597-611`:`document.activeElement.dispatchEvent`,
  // 可冒泡 → 只有焦点所在的那个 Resizable 响应),快捷键是 **Cmd/Ctrl+9 加宽 / +8 收窄**
  // (`main-process/menu/build-default-menu.ts:265-275`)。我们这里照搬这条语义,并补一条
  // 上游没有的「焦点在手柄上时 ← / →」——因为插件没有菜单栏,手柄必须能自己走键盘。
  // 两条路径都**只派发事件**,±5 与夹紧仍然由上游组件自己算。
  useEffect(() => {
    const el = containerRef.current;
    if (el === null) {
      return;
    }

    // 上游把手柄写成 `tabIndex={-1}`(`resizable.tsx:207`):Desktop 靠菜单快捷键,
    // 手柄不进 Tab 序。这里在**我们的适配层**里打开 Tab 序并补一条 title,
    // 上游文件一行未改。
    const handle = el.querySelector<HTMLButtonElement>('button.resize-handle');
    if (handle !== null) {
      handle.tabIndex = 0;
      handle.title = '拖动调整宽度 · 双击重置 · ←/→ 每次 5px(Cmd/Ctrl+9 / 8)';
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      const focus = document.activeElement;
      // 照 app.tsx 的语义:只有焦点在**本面板内**才响应(事件从焦点元素冒泡上来)。
      if (!(focus instanceof Element) || !el.contains(focus)) {
        return;
      }

      const withModifier = event.metaKey || event.ctrlKey;
      const isHandle = focus instanceof HTMLButtonElement && focus.classList.contains('resize-handle');
      const byAccelerator = withModifier && (event.key === '9' || event.key === '8');
      const byArrow = isHandle && (event.key === 'ArrowRight' || event.key === 'ArrowLeft');
      if (!byAccelerator && !byArrow) {
        return;
      }

      const increase = event.key === '9' || event.key === 'ArrowRight';
      event.preventDefault();
      focus.dispatchEvent(new CustomEvent(increase ? RESIZE_INCREASE_EVENT : RESIZE_DECREASE_EVENT, {
        bubbles: true,
        cancelable: true,
      }));
    };

    window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('keydown', onKeyDown); };
    /*
     * 依赖 `stacked`:竖排与横排之间切换会重挂 `<Resizable>`(见下面的 SplitPane),
     * 手柄是新的 DOM 节点,适配要跟着重做一次。
     *
     * ⚠️ 依赖里**必须有 `container`**(2026-10 修,与上面量宽那条同因):
     * 容器可能**晚于组件挂载**才出现(ChangesView 的「读取仓库状态…」那一支),而
     * 宽面板上 `stacked` 从 false 到 false **不变** ⇒ 只依赖 `stacked` 时这条 effect
     * 在容器出现后**不会重跑**,手柄永远拿不到 `tabIndex`/`title`(键盘可达性丢了)。
     * 实测:`docs/probes/split-measure-probe.mjs` 判据 6 —— 冷挂载档修前
     * `tabindex="-1"` / `title=null`,修后 `tabindex="0"` + title。
     */
  }, [container, stacked]);

  return {
    containerRef,
    attachContainerRef,
    containerStyle: stacked ? undefined : { gridTemplateColumns: `${width}px 1fr` },
    width,
    maximumWidth,
    stacked,
    onResize,
    onReset,
  };
}

/**
 * 左栏容器:横排时是移植过来的 `<Resizable>`,竖排时直接渲染内容。
 *
 * **竖排为什么要拆掉 `Resizable`,而不是用 CSS 盖掉它的行内宽度**:组件把
 * `width / min-width / max-width` 写成**行内样式**,容器查询的类规则压不过行内样式;
 * 要么加 `!important` 和它对着干,要么在竖排时干脆不渲染 —— 后者语义更直白
 * (竖排没有横向分隔条,手柄被 CSS 藏掉只是因为「不渲染」在那一帧还没生效)。
 * 代价:拖拽途中跨越 420px 会卸载组件,而上游 `Resizable` **没有**
 * `componentWillUnmount` 清理(document 上的 mousemove/mouseup 监听会留到下一次
 * mouseup,那次 mouseup 会自己把两个监听都摘掉)—— 只影响「按住鼠标时容器宽度跨越
 * 断点」这一种情形,松手即恢复,不产生残留。
 */
export function SplitPane(props: {
  split: SplitController;
  id: string;
  description: string;
  children: ReactNode;
}): ReactNode {
  const { split } = props;
  if (split.stacked) {
    return <>{props.children}</>;
  }
  return (
    <Resizable
      id={props.id}
      width={split.width}
      minimumWidth={SPLIT_MIN_WIDTH}
      maximumWidth={split.maximumWidth}
      onResize={split.onResize}
      onReset={split.onReset}
      description={props.description}
    >
      {props.children}
    </Resizable>
  );
}

/* ============================================================================
 * 宿主数据 → 上游模型(三个纯函数)
 * ========================================================================== */

/** 空 emoji 表:`gemoji/` submodule 在本 checkout 里是空的(goal §1.3),没有数据源可建。 */
const EMPTY_EMOJI: Map<string, Emoji> = new Map<string, Emoji>();

/** ISO 字符串 → `Date`。宿主给的一定是合法 ISO;真拿不到就给 epoch,不让上游拿到 Invalid Date。 */
function parseDate(iso: string): Date {
  const time = Date.parse(iso);
  return new Date(Number.isFinite(time) ? time : 0);
}

/**
 * `CommitEntry.refs` → 上游 `Commit.tags`。
 *
 * 宿主 `git log --decorate` 的 refs 是**一个字符串数组**,元素形如
 * `HEAD -> main` / `origin/main` / `tag: v1.0`;上游 `Commit.tags` 只装**标签名**
 * (`commit-list-item.tsx:251-266` 用它渲染 `.tag-name` chip + `+N` 角)。
 * 所以只挑 `tag: ` 前缀并去掉它 —— 分支 refs 不是 tag,塞进去会画出一堆假 chip。
 */
export function tagsFromRefs(refs: ReadonlyArray<string>): ReadonlyArray<string> {
  const prefix = 'tag: ';
  return refs.filter((ref) => ref.startsWith(prefix)).map((ref) => ref.slice(prefix.length));
}

/**
 * `CommitEntry` → 上游 `Commit`。
 *
 * ⚠️ **本函数与 `tagsFromRefs` 都是导出的**,因为 Changes 页签底部的撤销提交条
 * (`changes-view.tsx` 的 `UndoCommitStrip`)要吃**同一个** `Commit` 实例 ——
 * 上游那条链是 `repository.tsx:258-266` 由 `commitLookup` 取出的 `Commit`
 * (`ui/changes/sidebar.tsx:53`)。两处各写一份适配必然漂移,所以只留这一份。
 *
 * 上游 `Commit` 的构造函数(`models/commit.ts:119-128`)要 9 个参数;宿主没有
 * `trailers`(那是 `git interpret-trailers` 的产物,`lib/git/interpret-trailers.ts`
 * 在 host 侧且未接线)⇒ 传空数组。后果:`Commit.coAuthors` 恒为空,摘要头里
 * 「+N people」的协作者头像栈只显示作者本人。这是**数据的缺口**,不是渲染的缺口。
 */
export function toCommit(entry: CommitEntry): Commit {
  return new Commit(
    entry.sha,
    entry.shortSha,
    entry.subject,
    entry.body,
    new CommitIdentity(entry.authorName, entry.authorEmail, parseDate(entry.authorDate)),
    new CommitIdentity(entry.committerName, entry.committerEmail, parseDate(entry.committerDate)),
    entry.parents,
    [], // trailers
    tagsFromRefs(entry.refs),
  );
}

/** 宿主的状态字母。`snap.commitDetailFiles[].status` 在 store 里的静态类型是 `string`。 */
function toChangeStatus(raw: string): ChangeStatus {
  switch (raw) {
    case 'A':
      return 'A';
    case 'D':
      return 'D';
    case 'R':
      return 'R';
    case 'C':
      return 'C';
    case 'U':
      return 'U';
    case '?':
      return '?';
    default:
      return 'M';
  }
}

/**
 * 上游 `AppFileStatus` → 宿主的单字母(`toAppFileStatus` 的逆)。
 *
 * 为什么要有逆函数:`DesktopDiff` 与它内部的 `Diff` 分派要的是**字母**(`input.status`,
 * `IDesktopDiffInput.status`),而上游文件列表里流动的是 `AppFileStatus`。两个方向的映射
 * 必须成对写在一起,否则加一个状态只会改一处 —— 上一版这里就写成了一句
 * 「New 就 A、否则 M」的猜测,那会让 `D`/`R`/`U` 在 diff 面板里全部退化成「已修改」。
 */
function changeStatusOf(status: AppFileStatus): ChangeStatus {
  switch (status.kind) {
    case AppFileStatusKind.New:
      return 'A';
    case AppFileStatusKind.Deleted:
      return 'D';
    case AppFileStatusKind.Renamed:
      return 'R';
    case AppFileStatusKind.Copied:
      return 'C';
    case AppFileStatusKind.Untracked:
      return '?';
    case AppFileStatusKind.Conflicted:
      return 'U';
    default:
      return 'M';
  }
}

/** 重命名/复制的旧路径(其余状态没有这个概念)。 */
function oldPathOf(status: AppFileStatus): string | undefined {
  return status.kind === AppFileStatusKind.Renamed || status.kind === AppFileStatusKind.Copied
    ? status.oldPath
    : undefined;
}

/**
 * 宿主的单字母状态 → 上游 `AppFileStatus` 判别联合。
 *
 * 上游要的是**对象**(`models/status.ts:104-109`),不是字母:`mapStatus`、`iconForStatus`、
 * `PathLabel`(重命名要画 `old → new`)都读它。`oldPath` 缺失时给空串:上游的
 * `CopiedOrRenamedFileStatus.oldPath` 是必填,而宿主对 `R`/`C` 一定会给 `oldPath`
 * (`CommitFile.oldPath`),空串只是类型兜底。
 *
 * `'U'`(冲突)在上游是 `ConflictedFileStatus`,它是个带 `entry` 的判别联合。
 * **已提交的**文件不该出现 `U`(冲突在提交前就解决了),这里的构造只为让类型成立:
 * `entry` 取 `both-modified` 那一支、`conflictMarkerCount: 0` ⇒ `mapStatus` 返回
 * `'Resolved'`(而不是 `'Conflicted'`),不会谎报「这个提交里还带着冲突标记」。
 */
function toAppFileStatus(status: ChangeStatus, oldPath?: string): AppFileStatus {
  switch (status) {
    case 'A':
      return { kind: AppFileStatusKind.New };
    case 'D':
      return { kind: AppFileStatusKind.Deleted };
    case 'R':
      return {
        kind: AppFileStatusKind.Renamed,
        oldPath: oldPath ?? '',
        renameIncludesModifications: false,
      };
    case 'C':
      return {
        kind: AppFileStatusKind.Copied,
        oldPath: oldPath ?? '',
        renameIncludesModifications: false,
      };
    case '?':
      return { kind: AppFileStatusKind.Untracked };
    case 'U':
      return {
        kind: AppFileStatusKind.Conflicted,
        entry: {
          kind: 'conflicted',
          action: UnmergedEntrySummary.BothModified,
          us: GitStatusEntry.UpdatedButUnmerged,
          them: GitStatusEntry.UpdatedButUnmerged,
        },
        conflictMarkerCount: 0,
      };
    default:
      return { kind: AppFileStatusKind.Modified };
  }
}

/**
 * `CommitFile` → 上游 `CommittedFileChange`。
 *
 * `commitish` / `parentCommitish` 不是装饰:上游 `SeamlessDiffSwitcher` 用它们按修订取
 * 「旧/新」两份文件内容来做**上下文展开**(我们的 `desktop-diff.tsx` 也照这条路走
 * `show-file`)。根提交没有父,给空串 —— 我们的 `desktopDiffFromPatch` 与宿主都按
 * 「空串 = 没有旧侧」处理。
 */
function toCommittedFileChange(
  file: { path: string; oldPath?: string | undefined; status: string },
  commitish: string,
  parentCommitish: string,
): CommittedFileChange {
  return new CommittedFileChange(
    file.path,
    toAppFileStatus(toChangeStatus(file.status), file.oldPath),
    commitish,
    parentCommitish,
  );
}

/**
 * 相对路径 → 绝对路径(宿主 `open-in-external-editor` / `system-open-in-app` 要绝对路径)。
 *
 * 上游是 `Path.join(repository.path, file.path)`(`selected-commits.tsx:303`),走的是
 * Electron 的 node `path`。浏览器半的 `path` 被 alias 到 `src/client/shim-node-path.ts`
 * (`scripts/build.mjs:56`),那里 **没有 `join`**(只有镜像真正用到的几个函数)。
 * 所以这里用最小拼接:宿主路径本机就是 POSIX 或 Windows,Windows 的 API 也接受 `/`
 * 作为分隔符(Node/Electron 一律接受),所以不引入第二个 path 实现。
 */
function toAbsolutePath(repositoryPath: string, relativePath: string): string {
  if (repositoryPath === '') {
    return relativePath;
  }
  return repositoryPath.endsWith('/')
    ? `${repositoryPath}${relativePath}`
    : `${repositoryPath}/${relativePath}`;
}

/**
 * 哪些提交**还没 push** —— 上游 `CommitList.localCommitSHAs` 的语义,用来点亮行首那个
 * `↑` 角(`commit-list-item.tsx:196-211` + `_commit-list.scss:176-183`),
 * **并且**是提交右键菜单里 `Undo Commit…` 那一项的**出现条件**
 * (`commit-list.tsx:730-731` 的 `isLocal = localCommitSHAs.includes(sha)`)。
 *
 * ## 上游是**集合**,我们只有**计数** —— 这是近似,不是等价(HYPOTHESIS)
 *
 * 上游 `git-store.ts:608-627` 的 `loadLocalCommits` 两条分支:
 *
 * | 上游分支 | 判据 | 行 |
 * |---|---|---|
 * | 有 upstream | `git log <upstream>..HEAD` | `:615-619` |
 * | **没有 upstream** | `git log HEAD --not --remotes` | `:620-626` |
 *
 * ⇒ **一个远端都没有时,`--not --remotes` 什么都不排除 ⇒ 全部提交都是「本地提交」**
 * (Desktop 上「撤销最近一次提交」在一个纯本地仓库里是可用的)。
 *
 * 我们只有 `snap.sync.ahead`(`git rev-list --count`,**个数**)与 `sync.remotes`
 * (**远端名清单**),所以:
 *
 *  - `sync.remotes.length === 0` ⇒ 按上游那一支,**全部提交**算本地。
 *    这一档 2026-10 才补上:此前一律按 `ahead` 数头部 N 条,而纯本地仓库的 `ahead`
 *    是 0 ⇒ **一条都不算本地** ⇒ 右键菜单里的 `Undo Commit…` 在本地仓库里永不出现
 *    (用户报的「History 右键缺 Undo」有这一层原因)。判据:
 *    `docs/probes/history-commit-menu-probe.mjs` 的 P9。
 *  - 有远端但**没有 upstream 分支**:上游用 `--not --remotes`,那个集合我们拿不到
 *    ⇒ 退回按 `ahead` 数头部 N 条(可能**少报**,方向是安全的:不会把已推送的提交
 *    说成本地)。**这是仍然存在的缺口**,要精确得让 host 加一条「哪些 sha 不在
 *    upstream」的路由。
 *  - 其余:按 `ahead` 从头部数。两个已知不一致点(`log` 是当前分支历史、`ahead` 是
 *    相对 upstream;`log` 分页加载)与上面同源,一并记在这里。
 * @param log - 当前已加载的提交(新 → 旧)。
 * @param sync - `sync-state` 载荷;`null` = 还没拿到 ⇒ 一个都不算本地。
 */
function localCommitSHAsFrom(
  log: ReadonlyArray<CommitEntry>,
  sync: SyncState | null,
): ReadonlyArray<string> {
  if (sync === null) {
    return [];
  }
  if (sync.upstream === null && sync.remotes.length === 0) {
    // 上游 `git-store.ts:620-626` 的 `--not --remotes`,而远端清单是空的。
    return log.map((commit) => commit.sha);
  }
  const count = sync.ahead;
  if (count <= 0) {
    return [];
  }
  return log.slice(0, count).map((commit) => commit.sha);
}

/* ============================================================================
 * History 页签本体
 * ========================================================================== */

/** 一次多选的结果:上游 `onCommitsSelected(commits, isContiguous)` 的原样搬运。 */
interface ICommitSelection {
  readonly shas: ReadonlyArray<string>;
  readonly contiguous: boolean;
}

export function HistoryView(props: { store: GitStore; snap: Snapshot }): ReactNode {
  const { store, snap } = props;

  /**
   * 外层分隔线:**提交列表 | 提交详情**,键与 Changes 页签**共用**
   * (`dsh-git.sidebar-width`)。
   *
   * 为什么改成共用:Desktop 的 History 页签里,提交列表就是**仓库侧栏**的内容
   * (`ui/history/compare.tsx` 由 `repository.tsx:277` 的 sidebar 渲染),所以它和
   * Changes 左栏是**同一条**分隔线、同一个宽度值。上一版给 History 单独一个键
   * (`commit-summary-width`),那是把上游的**文件列表**宽度键借来当侧栏键用了。
   */
  const split = useSplitWidth(SIDEBAR_WIDTH_STORAGE_KEY);

  /**
   * 内层分隔线:**变更文件列表 | diff**,键 `dsh-git.commit-summary-width`
   * —— 这才是 Desktop 的 `commitSummaryWidth`(`selected-commits.tsx:315-321` 那个
   * `Resizable` 的 `width/minimumWidth/maximumWidth` 全部来自它)。
   */
  const fileListSplit = useSplitWidth(COMMIT_SUMMARY_WIDTH_STORAGE_KEY);

  const [selection, setSelection] = useState<ICommitSelection>({ shas: [], contiguous: true });
  const [isExpanded, setIsExpanded] = useState(false);
  const [detailFile, setDetailFile] = useState<string>('');
  const [detailDiff, setDetailDiff] = useState<DiffResult | null>(null);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [shasToHighlight, setShasToHighlight] = useState<ReadonlyArray<string>>([]);
  /**
   * 「Create Branch from Commit」的输入框状态(2026-10 本轮补)。
   *
   * ## 为什么必须有它 —— 那是一个**渲染得出来、点了没反应**的菜单项
   *
   * 上游 `ui/history/commit-list.tsx:816-822` 往右键菜单里塞这一项时
   * **没有 `enabled` 守卫**(与它上下那些 `enabled: this.props.onX !== undefined` 的项
   * 形成对照),而 `action` 写的是 `if (this.props.onCreateBranch) { … }` ——
   * 于是只要调用方**不传** `onCreateBranch`,菜单里就会出现一个**看起来可点、点下去
   * 什么都不发生**的项。本文件此前正是没传(见下方 `<CommitList>` 的注释)。
   *
   * ## 落点(能力已经存在)
   *
   * `store.createBranch(name, startPoint)`(`store.ts:1190` → `api.createBranch` →
   * host `branch-create` 路由,`git branch --no-track -- <name> <startPoint>`)。
   * 上游那一项的意义就是「以这个提交为起点建分支」,正好对应第二个参数。
   *
   * ## 可回收条件
   *
   * 上游 `ui/create-branch/**`(本 checkout **没有镜像**)落地后,把下面的
   * `ConfirmDialog` 换成那个组件本体,并把 `onCreateBranch` 改走 dispatcher。
   * (`Create Branch from Commit` 在上游最终弹的就是那个对话框,不是 prompt。)
   */
  const [branchFrom, setBranchFrom] = useState<{ sha: string; name: string } | null>(null);

  /**
   * 提交右键菜单 ▸「Amend Commit…」的**强推警告**待确认项。
   *
   * 上游 `_startAmendingRepository`(`lib/stores/app-store.ts:5767-5787`)的第一件事就是
   * 这道闸门:
   *
   * ```ts
   * if (askForConfirmationOnForcePush && !continueWithForcePush &&
   *     !isLocalCommit && tip.kind === TipState.Valid) {
   *   return this._showPopup({ type: PopupType.WarnForcePush, operation: 'Amend', … })
   * }
   * ```
   *
   * 三点必须说清:
   *  1. **不是每次修订都弹**。只有「这条提交**已经在远端**」(`!isLocalCommit`)时才弹
   *     —— 修订一条已发布的提交必然要强推,而那会改写远端历史。本地未推送的提交
   *     **直接进入修订态**,没有中间那一步(判据 P4 vs P8b);
   *  2. `askForConfirmationOnForcePush` 上游**默认就是 `true`**
   *     (`app-store.ts:494` 的 `askForConfirmationOnForcePushDefault`),而本插件
   *     **没有这个偏好项**(`toolbar.tsx:787` 记了同一处缺口)⇒ 按上游默认值处理。
   *     等 Preferences ▸ Prompts 接线时把它换成真偏好;
   *  3. `tip.kind === TipState.Valid` 的等价物是「在分支上、有提交」
   *     (`sync-state.ts:66-67` 的映射表:`detached === false && unborn === false`)。
   */
  const [amendTarget, setAmendTarget] = useState<{ sha: string; summary: string } | null>(null);

  /**
   * 提交右键菜单 ▸「Undo Commit…」的**本地改动警告**待确认项。
   *
   * 上游 `_undoCommit`(`lib/stores/app-store.ts:5815-5853`)的判据是
   * (真值在 `:5830-5836`;`showConfirmationDialog` 由 dispatcher 默认传 `true`,
   * `ui/dispatcher/dispatcher.ts:951-955`):
   *
   * ```ts
   * if (showConfirmationDialog &&
   *     ((this.confirmUndoCommit && !isWorkingDirectoryClean) || commit.isMergeCommit))
   * ```
   *
   * ⇒ 化简成「**工作区脏 OR 是合并提交**」才弹。`confirmUndoCommit` 上游默认 `true`
   * (`app-store.ts:495`),我们同样没有这个偏好,按默认值处理。
   * 这条判据与 Changes 页签底部撤销条**共用**一份语义(`changes-view.tsx` 的
   * `requestUndo` 的文件头逐字列了同一段上游代码)—— 两个入口必须一起绿。
   */
  const [undoTarget, setUndoTarget] = useState<Commit | null>(null);

  /**
   * 提交右键菜单 ▸「Reset to Commit…」/「Checkout Commit」/「Create Tag…」三个待确认项。
   *
   * 三项都在 2026-10 之前**恒灰着** —— 不是缺管线(宿主路由 + `api.*` 包装 + argv 全在,
   * 见 `docs/dead-code-and-missing-state-audit.md` §2.3 第 1/2/5 项),而是
   * `history-view.tsx` **从来没给 `<CommitList>` 传过对应的 props** ⇒ `enabled` 里
   * `onX !== undefined` 那半边恒假。它们与 Amend/Undo 的区别只是**缺的是 prop 而不是项**。
   *
   * 三个确认框的上游对照逐条写在下面各自的注释里;共用的形状是「上游弹一个
   * `PopupType.X` 对话框,我们这一层没有应用层弹窗宿主,所以用 `ConfirmDialog` 等价物」。
   */
  const [resetTarget, setResetTarget] = useState<{ sha: string; mode: 'soft' | 'mixed' | 'hard' } | null>(null);
  /**
   * Reset 的**第二道**闸门(破坏性确认):
   *  - `mode === 'hard'` ⇒ 一定会走到这里(`git reset --hard` 无条件丢工作区改动);
   *  - 工作区**脏**且不是 hard ⇒ 也走这里(照上游 `WarningBeforeReset` 那一档,
   *    `app-store.ts:5866-5872` 的 `showConfirmationDialog && !isWorkingDirectoryClean`)。
   * 干净的工作区 + soft/mixed ⇒ 不弹第二道,直接执行(与上游一致)。
   */
  const [resetConfirm, setResetConfirm] = useState<{ sha: string; mode: 'soft' | 'mixed' | 'hard' } | null>(null);
  const [checkoutTarget, setCheckoutTarget] = useState<Commit | null>(null);
  /** 「Create Tag…」的名字输入框;`annotated` 那一档见对话框里的说明(不可用)。 */
  const [tagFor, setTagFor] = useState<{ sha: string; name: string } | null>(null);

  const repoPath = snap.current;
  const log = snap.log;

  /* ---- 上游模型(全部 memo:上游的 memoize-one 依赖这些身份)---- */
  const repository = useMemo(() => new Repository(repoPath, 0, null, false), [repoPath]);
  const commits = useMemo(() => log.map(toCommit), [log]);
  const commitLookup = useMemo(
    () => new Map(commits.map((commit) => [commit.sha, commit] as const)),
    [commits],
  );
  const commitSHAs = useMemo(() => commits.map((commit) => commit.sha), [commits]);
  const localCommitSHAs = useMemo(
    () => localCommitSHAsFrom(log, snap.sync),
    [log, snap.sync],
  );

  /**
   * 选中提交。`selectedSHAs` 由我们的 state 驱动(而不是 `snap.selectedCommit`),
   * 因为上游列表是**多选**控件:点一下 → `onCommitsSelected` → 我们记 state →
   * 同一个 state 又喂回去当 `selectedSHAs`,高亮才与我们的模型一致。
   * `snap.selectedCommit` 仍是 diff 的真值源(它决定下面拉哪个 patch)。
   */
  const selected =
    log.find((commit) => commit.sha === snap.selectedCommit) ?? log[0];
  const selectedCommit =
    selected === undefined
      ? undefined
      : commits.find((commit) => commit.sha === selected.sha);

  /** 首次进入自动选中最新提交(上游是 app-store 的默认选中,我们这层补)。 */
  useEffect(() => {
    if (snap.selectedCommit === '' && log.length > 0) {
      void store.selectCommit(log[0].sha);
    }
  }, [log, snap.selectedCommit, store]);

  /** 选中提交 → 清掉文件选中与上一份 diff(上游 `componentWillUpdate` 里做同样的事)。 */
  useEffect(() => {
    setDetailFile('');
    setDetailDiff(null);
    setIsExpanded(false);
  }, [snap.selectedCommit]);

  /** 选区同步到列表高亮:第一次渲染和外部改了 `selectedCommit` 时都要跟上。 */
  useEffect(() => {
    if (selected === undefined) {
      return;
    }
    setSelection((current) =>
      current.shas.length === 1 && current.shas[0] === selected.sha
        ? current
        : { shas: [selected.sha], contiguous: true },
    );
  }, [selected]);

  /* ---- 变更文件列表:上游 `IChangesetData`(`lib/git/log.ts:215`)---- */
  const files = useMemo(
    () =>
      selected === undefined
        ? []
        : snap.commitDetailFiles.map((file) =>
            toCommittedFileChange(file, selected.sha, selected.parents[0] ?? ''),
          ),
    [snap.commitDetailFiles, selected],
  );

  const changesetData: IChangesetData = useMemo(
    () => ({
      files,
      linesAdded: snap.commitDetailFiles.reduce((sum, file) => sum + file.additions, 0),
      linesDeleted: snap.commitDetailFiles.reduce((sum, file) => sum + file.deletions, 0),
    }),
    [files, snap.commitDetailFiles],
  );

  const selectedFile = useMemo(
    () => (detailFile === '' ? null : files.find((file) => file.path === detailFile) ?? null),
    [files, detailFile],
  );

  /**
   * 详情里的文件 diff 按需拉取。
   *
   * `ignoreWhitespace` 必须在这里传:「隐藏空白改动」对 History 是**重跑 `git diff -w`**
   * (Changes 那条链在 `store.loadDiff` 里就是这么做的,`-w` 一路走到
   * `git-argv.diffCommitArgv`),否则开关只改标志、patch 仍含空白改动 —— 看起来没生效。
   * 所以它也必须进 effect 依赖,不然切开关不会重取。
   */
  useEffect(() => {
    if (selectedFile === null || selected === undefined || repoPath === '') {
      return;
    }
    let dead = false;
    setLoadingDiff(true);
    void api.diff({
      path: repoPath,
      file: selectedFile.path,
      commit: selected.sha,
      ...(snap.hideWhitespaceHistory ? { ignoreWhitespace: true } : {}),
    }).then((result) => {
      if (dead) {
        return;
      }
      setLoadingDiff(false);
      setDetailDiff(result.ok ? result.value : null);
    });
    return () => { dead = true; };
  }, [selectedFile, selected, repoPath, snap.hideWhitespaceHistory]);

  /* ---- 回调(上游的每一个都照搬语义)---- */

  const onCommitsSelected = useCallback(
    (selectedCommits: ReadonlyArray<Commit>, isContiguous: boolean) => {
      setSelection({ shas: selectedCommits.map((commit) => commit.sha), contiguous: isContiguous });
      const newest = selectedCommits[selectedCommits.length - 1];
      if (newest !== undefined) {
        void store.selectCommit(newest.sha);
      }
    },
    [store],
  );

  const onSelectedFileChanged = useCallback((file: CommittedFileChange) => {
    setDetailFile(file.path);
  }, []);

  /** 双击文件行 → 用外部编辑器打开(上游 `selected-commits.tsx:119-124` → `onOpenInExternalEditor`)。 */
  const onRowDoubleClick = useCallback(
    (row: number) => {
      const file = files[row];
      if (file === undefined) {
        return;
      }
      void store.openInExternalEditor(toAbsolutePath(repoPath, file.path));
    },
    [files, repoPath, store],
  );

  /** 摘要头里的「+N 个提交不在 diff 里」点击 → 上游打开 `UnreachableCommitsDialog`。 */
  const showUnreachableCommits = useCallback(() => {
    /*
     * **未接线。** 上游走 `Dispatcher.showUnreachableCommits(tab)`
     * (`selected-commits.tsx:218-220`)→ `PopupType.UnreachableCommits` →
     * `ui/app.tsx` 的弹窗宿主(`ui/dialog/dialog.tsx` 渲染原生 `<dialog>` 并靠应用层的
     * Popover 布局)。我们这个插件**没有应用层弹窗宿主**(没有 `ui/app.tsx`、
     * `ui/dispatcher` 是替身),`ui/dialog/**` 的 `_dialog.scss` 也不在任何
     * 作用域面的闭包里。所以这里**不假装**能打开:注册成已知缺口,等弹窗面接线。
     *
     * ## 2026-10 本轮:空实现 → **明确反馈**
     *
     * 这个回调**今天不可达**:上游 `expandable-commit-summary.tsx:344-352` 的
     * `renderCommitsNotReachable` 在 `selectedCommits.length === 1` 时直接 `return`,
     * 而本文件永远只传一个提交(`selectedCommits={[selectedCommit]}`)。
     * 但它的落点此前是一个**彻底的静默 no-op** —— 一旦多选摘要接上,它立刻变成
     * 用户报的那类「点了没反应的链接」。所以这里给一句实话:
     * 没有能力可接时,反馈必须是明确的(与 `repo-bar.tsx` 给 Create New 加 toast 同一条规矩)。
     *
     * 处置不变:登记为缺口,等 `ui/dialog/**` + 弹窗面接线后换成真正的对话框。
     */
    store.toast('「不在 diff 里的提交」对话框还没有移植:它需要应用层的弹窗宿主。', 'err');
  }, [store]);

  const onHighlightShas = useCallback((shas: ReadonlyArray<string>) => {
    setShasToHighlight(shas);
  }, []);

  /*
   * 提交行右键 ▸「Create Branch from Commit」的三个回调。
   *
   * **写成具名引用而不是 JSX 内联箭头**:`react/jsx-no-bind` 会拦内联箭头,而
   * `scripts/lint-baseline.json` 是只拦上升的棘轮 —— 本轮不打算靠新增违规来接线。
   * 三个都是稳定的(依赖只有 `store` / 空),所以上游那两个类组件的 props 身份也稳定。
   */
  const onCreateBranchFromCommit = useCallback((commit: CommitOneLine) => {
    setBranchFrom({ sha: commit.sha, name: '' });
  }, []);

  const onBranchNameChange = useCallback((name: string) => {
    setBranchFrom((prev) => (prev === null ? null : { sha: prev.sha, name }));
  }, []);

  const onBranchDialogDone = useCallback((okay: boolean) => {
    // 直接读当前值再清空 —— **不要**把副作用写进 `setState` 的更新函数:
    // 那个函数必须是纯的(StrictMode 下会被调用两次 ⇒ 会建出两个分支)。
    const target = branchFrom;
    setBranchFrom(null);
    if (!okay || target === null) {
      return;
    }
    const name = target.name.trim();
    if (name === '') {
      // `ConfirmDialog` 的确认键在输入为空时**不会**自动禁用(它是通用件),
      // 所以这里必须自己给出可观察的反馈,而不是静默什么都不做。
      store.toast('分支名不能为空。', 'err');
      return;
    }
    void store.createBranch(name, target.sha);
  }, [branchFrom, store]);

  /*
   * 提交行右键 ▸「Amend Commit…」/「Undo Commit…」的两个回调。
   *
   * 上游都挂在 `ui/history/compare.tsx` 上:
   *   · `onAmendCommit={this.props.onAmendCommit}`(`:264`)⇒ `ui/repository.tsx:659-665`
   *     的 `dispatcher.startAmendingRepository(repository, commit, isLocalCommit)`;
   *   · `onUndoCommit={this.onUndoCommit}`(`:257`)⇒ `:615-617` 的
   *     `dispatcher.undoCommit(repository, commit)`(默认 `showConfirmationDialog = true`)。
   * 上游那两处都**只是转手**,闸门（强推警告 / 本地改动确认)在 `app-store.ts` 里 ——
   * 我们这边弹窗只能留在视图层,所以下面两个回调各自承担自己那道闸门,
   * 过了闸门再调 `store` 的方法。
   */
  const onAmendCommit = useCallback((commit: Commit, isLocalCommit: boolean) => {
    const status = snap.status;
    // `tip.kind === TipState.Valid` 的等价物:`sync-state.ts:66-67` 的映射表。
    const tipValid = status !== null && !status.detached && !status.unborn;
    if (!isLocalCommit && tipValid) {
      // 已推送 ⇒ 先弹强推警告(`app-store.ts:5767-5787`);确认后才进修订态。
      setAmendTarget({ sha: commit.sha, summary: commit.summary });
      return;
    }
    void store.startAmendingCommit(commit.sha);
  }, [snap.status, store]);

  const onAmendDialogDone = useCallback((okay: boolean) => {
    // 与 `onBranchDialogDone` 同一条纪律:先取值再清空,副作用不放进 setState 更新函数。
    const target = amendTarget;
    setAmendTarget(null);
    if (!okay || target === null) {
      return;
    }
    void store.startAmendingCommit(target.sha);
  }, [amendTarget, store]);

  const onUndoCommit = useCallback((commit: Commit) => {
    /*
     * 逐字对着上游 `app-store.ts:5830-5843`(与 `changes-view.tsx` 的 `requestUndo` 同一段):
     * 工作区**干净**且**不是**合并提交 ⇒ 直接撤,没有中间那一步。
     */
    const isWorkingDirectoryClean = (snap.status?.files.length ?? 0) === 0;
    if (isWorkingDirectoryClean && !commit.isMergeCommit) {
      void store.undoCommit(commit.sha);
      return;
    }
    setUndoTarget(commit);
  }, [snap.status, store]);

  const onUndoDialogDone = useCallback((okay: boolean) => {
    const target = undoTarget;
    setUndoTarget(null);
    if (!okay || target === null) {
      return;
    }
    void store.undoCommit(target.sha);
  }, [store, undoTarget]);

  /*
   * 提交右键菜单 ▸「Reset to Commit…」/「Checkout Commit」/「Create Tag…」/「Revert…」/
   * 「Cherry-pick…」/「Delete Tag」的一组回调。
   *
   * 上游的落点(`ui/history/compare.tsx`,逐个点名):
   *   · `onResetToCommit`(`:619-621`)⇒ `dispatcher.resetToCommit`
   *     —— 上游那个走 `app-store.ts:5856-5889` 的 `_resetToCommit`,**只走 mixed**;
   *   · `onCheckoutCommit`(`:633-645`)⇒ 问 `askForConfirmationOnCheckoutCommit`
   *     再决定弹 `PopupType.ConfirmCheckoutCommit` 还是直接 checkout;
   *   · `onCreateTag`(`:607-613`)⇒ `dispatcher.showCreateTagDialog`;
   *   · `onDeleteTag`(`:647-649`)⇒ `dispatcher.showDeleteTagDialog`;
   *   · `onCherryPick`(`:651-653`)⇒ `props.onCherryPick`(由 `ui/repository.tsx` 接)。
   * 上游的 `onRevertCommit` 由 `ableToRevertCommit`(`:749-756`)决定是否**下传**:
   * 纯 History 模式恒为真 ⇒ 恒下传。
   */

  /**
   * 「Reset to Commit…」→ 打开**模式选择**框(`soft` / `mixed` / `hard`)。
   *
   * ## 上游怎么做的(以及我们为什么多出一档)
   *
   * 上游那一项**不选模式**:`compare.tsx:620` 直接 `dispatcher.resetToCommit(...)`,
   * 而 `_resetToCommit`(`app-store.ts:5884`)写死 `GitResetMode.Mixed`。
   * 它的确认闸门是 `showConfirmationDialog && !isWorkingDirectoryClean`
   * —— **只在工作区脏时**弹 `WarningBeforeReset`
   * (`ui/reset/warning-before-reset.tsx`,正文「You have changes in progress.
   * Resetting to a previous commit might result in some of these changes being lost.
   * Do you want to continue anyway?」,`destructive` + 确认键 `Continue`)。
   *
   * 我们按 2026-10 的裁决额外提供 `soft` / `hard` 两档(宿主 `reset-to-commit` 路由
   * 与 `core/git-argv.ts:566-572` 都支持),所以**两种情况下都确认**:
   *
   *  - 选了 `hard`:`git reset --hard` 会**无条件丢弃工作区改动**(宿主
   *    `git-service.ts:1127` 明写「调用方必须自己确认过再调」,路由 `:792` 用
   *    `worktreeDiscarded` 如实回执)—— 上游没有这个风险面,这一档的确认是我们加的;
   *  - 工作区脏(不干净)且没选 `hard`:**照上游那一档**先确认
   *    (`WarningBeforeReset` 的等价物),因为 `mixed` 也会改索引。
   */
  const onResetToCommit = useCallback((commit: Commit) => {
    // 上游 `isResettableCommit = row > 0 && row <= localCommitSHAs.length` 那一半由
    // 镜像组件负责(`commit-list.tsx:736-739`);这里只做「打开选择框」。
    setCheckoutTarget(null);
    setResetTarget({ sha: commit.sha, mode: 'mixed' });
  }, []);

  /**
   * 模式选择框的确认。
   *
   * 两个闸门(见 `onResetToCommit` 的注释)任一成立就先弹**破坏性确认**,否则直接执行。
   * 「先取值再清空」是同一条纪律(副作用不写进 `setState` 更新函数:
   * StrictMode 下会跑两次,会 reset 两次)。
   */
  const onResetModeChosen = useCallback((okay: boolean) => {
    const target = resetTarget;
    setResetTarget(null);
    if (!okay || target === null) {
      return;
    }
    const dirty = (snap.status?.files.length ?? 0) > 0;
    if (target.mode === 'hard' || dirty) {
      setResetConfirm(target);
      return;
    }
    void store.resetToCommit(target.sha, target.mode);
  }, [resetTarget, snap.status, store]);

  const onResetConfirmed = useCallback((okay: boolean) => {
    const target = resetConfirm;
    setResetConfirm(null);
    if (!okay || target === null) {
      return;
    }
    void store.resetToCommit(target.sha, target.mode);
  }, [resetConfirm, store]);

  /**
   * 「Checkout Commit」→ 先确认**分离头**的后果,再执行。
   *
   * ⚠️ **这一档与上游不同,必须说清**:上游
   * `compare.tsx:633-645` 的 `askForConfirmationOnCheckoutCommit` **默认是 `false`**
   * (`app-store.ts:496` 的 `askForConfirmationOnCheckoutCommitDefault`),
   * 也就是说桌面版默认**不弹**这个框,直接 `git checkout <sha>`。
   * 我们这里**恒弹**:分离头是一个用户不容易自己发现的危险状态(在上面提交会变成
   * 悬空提交,切走就找不回来),而本插件**没有** Desktop 那条「你已经不在分支上」
   * 的常驻横幅(`ui/branches/**` 未镜像)。按 2026-10 的裁决:
   * **代价是多一次确认,换来的是用户知道自己在哪**。
   * 可回收条件:`ui/branches/**` 的分离头横幅落地后,把这里换成上游那条偏好门
   * (默认不弹,偏好打开才弹)。
   */
  const onCheckoutCommit = useCallback((commit: CommitOneLine) => {
    setResetTarget(null);
    setCheckoutTarget(
      commits.find((entry) => entry.sha === commit.sha) ?? null,
    );
  }, [commits]);

  const onCheckoutConfirmed = useCallback((okay: boolean) => {
    const target = checkoutTarget;
    setCheckoutTarget(null);
    if (!okay || target === null) {
      return;
    }
    void store.checkoutCommit(target.sha);
  }, [checkoutTarget, store]);

  /**
   * 「Create Tag…」→ 打开**名字输入**框。
   *
   * 上游 `ui/create-tag/create-tag-dialog.tsx:57-90` 的形状:标题 `Create a Tag`、
   * 一个 `RefNameTextBox`(label `Name`)、确认键 **在名字为空或名字非法时禁用**
   * (`:58` 的 `disabled = error !== null || tagName.length === 0`),
   * 还有一个 `MaxTagNameLength = 245` 的上限。我们的 `ConfirmDialog` 的确认键
   * **不会**自动禁用(它是通用件),所以「空名字」这一档由回调自己给出可观察反馈
   * (与 `onBranchDialogDone` 同一条规矩,不静默)。
   *
   * ⚠️ **轻量 vs 附注**:上游建的是**附注标签**(`lib/git/tag.ts:13-21` 的
   * `tag -a -m '' <name> <sha>`),而本仓库的冻结契约建**轻量标签**
   * (`core/git-argv.ts` 的 `tagCreateArgv`,`routes.ts:903-911` 的注释逐字记了这件事)。
   * 差别是不可逆的数据差异(轻量标签没有 tagger / 日期 / 消息,事后无法补),
   * 所以那一档在对话框里**明确标为不可用并写出原因**,不画一个点了没反应的选项
   * (`docs/discard-lines-contract.md` §6 是这条的契约文本)。
   */
  const onCreateTag = useCallback((sha: string) => {
    setTagFor({ sha, name: '' });
  }, []);

  const onTagNameChange = useCallback((name: string) => {
    setTagFor((prev) => (prev === null ? null : { sha: prev.sha, name }));
  }, []);

  const onTagDialogDone = useCallback((okay: boolean) => {
    const target = tagFor;
    setTagFor(null);
    if (!okay || target === null) {
      return;
    }
    const name = target.name.trim();
    if (name === '') {
      store.toast('标签名不能为空。', 'err');
      return;
    }
    // 上游 `create-tag-dialog.tsx:35` 的 `MaxTagNameLength`。
    if (name.length > 245) {
      store.toast('标签名不能超过 245 个字符。', 'err');
      return;
    }
    /*
     * 目标提交:上游把 `targetCommitSha` 传给对话框(`compare.tsx:609-612`),
     * 建标签时用它作 `<sha>`。**我们的 `store.createTag` 收得到它**
     * (宿主 `tag-create` 路由的 `sha` 是可选参数),所以不退回 HEAD —— 那会把标签
     * 打在错误的提交上,而且这是个**静默**的错误。
     */
    void store.createTag(name, target.sha);
  }, [store, tagFor]);

  /**
   * 「Revert Changes in Commit」→ 直接执行(没有确认框)。
   *
   * 上游那一项**没有**确认:菜单 `enabled` 就是 `onRevertCommit !== undefined`
   * (`commit-list.tsx:809`),`dispatcher.revertCommit`(`:968-970`)直通
   * `app-store._revertCommit`。它的「回执」在**冲突**那条路上
   * (`lib/git/revert.ts` 失败 ⇒ 上游弹错误框);我们这边同一件事由
   * `store.revertCommit` 的 `merge-conflicts` 分支给出带 `--continue`/`--abort`
   * 出路的 toast(见该方法的注释 —— 上游那句默认文案在 revert 场景下是不完整的)。
   */
  const onRevertCommit = useCallback((commit: Commit) => {
    void store.revertCommit(commit.sha);
  }, [store]);

  /**
   * 「Cherry-pick Commit…」→ 直接执行。
   *
   * 上游:菜单 `enabled = canCherryPick()`(`commit-list.tsx:867-872`:
   * `onCherryPick !== undefined && isMultiCommitOperationInProgress === false`),
   * `action` 把 `selectedCommits` 交给 `compare.tsx:651-653`。
   * 本插件按冻结契约**只 pick 一个提交**(宿主路由的注释写明了理由:
   * `core/git-argv.ts` 的 `cherryPickArgv`),所以这里只取第一个 ——
   * 多选时上游会一次 pick 一串,我们**不做**那种部分兑现(会静默少 pick 几个)。
   */
  const onCherryPick = useCallback((selectedCommits: ReadonlyArray<CommitOneLine>) => {
    const first = selectedCommits[0];
    if (first === undefined) {
      store.toast('没有要拣选的提交。', 'err');
      return;
    }
    if (selectedCommits.length > 1) {
      store.toast(`本插件一次只能拣选一个提交,已拣选 ${first.sha.slice(0, 7)}。`, 'err');
    }
    void store.cherryPickCommit(first.sha);
  }, [store]);

  /**
   * 「Delete tag <name>」→ 直接删本地标签。
   *
   * ⚠️ **今天这个菜单项不会出现**,原因不是没接:`commit-list.tsx:889-899` 的
   * `getDeleteTagsMenuItem` 要求「该提交有**未推送**的标签」,而
   * `getUnpushedTags`(`:373-377`)比的是 `props.tagsToPush`。我们**没有**这个数据:
   * `snap.sync.tagCount` 只是**个数**(`git-service.ts:336`),
   * 「哪些 tag 还没推送」需要 `git log --tags --not --remotes` 那类**新的宿主路由**。
   * 所以这里**不传一个假集合**(传 `[]` 会永远不出现、传全部会谎报「没推送」),
   * 按「缺什么说什么」登记为缺口;回调本身照样给上 —— 数据一到就立即生效。
   * (与 `history-view.tsx` 文件头那条「不接的部分如实记录」同一纪律。)
   */
  const onDeleteTag = useCallback((tagName: string) => {
    void store.deleteTag(tagName);
  }, [store]);

  /**
   * 顶部「加载更多」与 Reset 模式选择框的两个 `onModeChange` / 确认 / 取消 ——
   * **具名回调**。
   *
   * **为什么不能写成 JSX 内联箭头**:`react/jsx-no-bind`(只拦上升的棘轮)会把
   * 组件作用域里的内联箭头记成新增违规。`onResetModeChange` 用**函数式更新**
   * 读取最新的 sha(而不是闭包住某一帧的 `resetTarget`),所以依赖数组是空的。
   */
  const onLoadMore = useCallback(() => { void store.refreshLog(false); }, [store]);
  const onResetModeChange = useCallback((mode: 'soft' | 'mixed' | 'hard') => {
    setResetTarget((prev) => (prev === null ? null : { sha: prev.sha, mode }));
  }, []);

  const onHideWhitespaceInDiffChanged = useCallback(
    async (hide: boolean) => { await store.setHideWhitespaceHistory(hide); },
    [store],
  );

  const onShowSideBySideDiffChanged = useCallback(
    (value: boolean) => { void store.setSideBySide(value); },
    [store],
  );

  /* ---- 空态 ---- */

  if (log.length === 0) {
    // 列表空态由上游 `CommitList` 自己渲染(`commit-list.tsx:567-573` 的 `.panel.blankslate`)
    // —— 这里只把「为什么空」交给它。
    return (
      <div className="gw-pane gw-desktop-history tooltip-host">
        <CommitList
          gitHubRepository={null}
          commitSHAs={[]}
          commitLookup={new Map()}
          selectedSHAs={[]}
          emoji={EMPTY_EMOJI}
          localCommitSHAs={[]}
          isLocalRepository={true}
          accounts={[]}
          preferAbsoluteDates={false}
          emptyListMessage={
            snap.status?.unborn === true ? '这个分支还没有第一次提交。' : '读取历史…'
          }
        />
      </div>
    );
  }

  const multiSelected = selection.shas.length > 1;

  return (
    <div className="gw-pane gw-desktop-history tooltip-host">
      {/*
        顶部工具条是**我们的**插件外壳(Desktop 没有这一行:分支/Compare 条就是上游
        `ui/history/compare.tsx` 的 TabBar,**归 branches 线**,见文件头「没有接的两块」)。
        这里保留「当前分支 + 已加载条数 + 加载更多」,等 compare 条落地后由它取代。
      */}
      <div className="gw-toolbar">
        <span>当前分支</span>
        <span className="gw-badge gw-mono">
          {snap.status !== null && snap.status.branch !== '' ? snap.status.branch : '分离头'}
        </span>
        <span className="grow" />
        <span style={{ fontSize: 11 }}>已加载 {log.length}</span>
        <button className="gw-btn ghost" disabled={!snap.logHasMore || snap.logLoading}
          onClick={onLoadMore}>
          {snap.logLoading ? '读取中…' : '加载更多'}
        </button>
      </div>

      <div className="gw-split" ref={split.attachContainerRef} style={split.containerStyle}>
        <div className="left">
          {/* 外层分隔线 = Desktop 的仓库侧栏宽度(见 useSplitWidth 的注释)。 */}
          <SplitPane split={split} id="dsh-git-history-sidebar" description="History 提交列表">
            <CommitList
              gitHubRepository={null}
              commitSHAs={commitSHAs}
              commitLookup={commitLookup}
              selectedSHAs={selection.shas}
              emoji={EMPTY_EMOJI}
              localCommitSHAs={localCommitSHAs}
              shasToHighlight={shasToHighlight}
              isLocalRepository={snap.sync === null || snap.sync.remotes.length === 0}
              accounts={[]}
              preferAbsoluteDates={false}
              onCommitsSelected={onCommitsSelected}
              /*
               * ⭐ `canAmendCommits` / `canUndoCommits` 上游都写成
               * 「当前是不是 History 模式」(`ui/history/compare.tsx:251-253`:
               * `formState.kind === HistoryTabMode.History`)。我们的 HistoryView
               * **就是** History 模式(Compare 那条支路归 branches 线,见文件头),
               * 所以这里恒为 `true` —— 真正的行级判据在镜像组件里:
               * `commit-list.tsx:730-732` 的 `row === 0` 与 `isLocal`。
               *
               * ⚠️ 这两个 prop 以前**一个都没传** ⇒ `if (canBeAmended)` / `if (canBeUndone)`
               * 恒假 ⇒ 上游菜单里那两项**根本不入列**(不是「灰着」,是不存在)。
               * 这正是用户报的「History 的提交右键菜单里缺少 Amend 和 Undo」的第一层原因;
               * 判据 `docs/probes/history-commit-menu-probe.mjs` P1/P2/P2b。
               */
              canAmendCommits={true}
              canUndoCommits={true}
              onAmendCommit={onAmendCommit}
              onUndoCommit={onUndoCommit}
              /*
               * ⭐ 2026-10 第二轮:`Reset to Commit…` / `Checkout Commit` /
               * `Revert Changes in Commit` / `Create Tag…` / `Cherry-pick Commit…` /
               * 「Delete tag …」六项。
               *
               * 这六项与上面两项**缺的东西不同**:Amend/Undo 以前是**项都不入列**
               * (条件在 `if (canBeAmended)` / `if (canBeUndone)` 里),这六项是
               * **项在列、永远灰着** —— 因为它们的 `enabled` 判据里都有一半是
               * `this.props.onX !== undefined`(`commit-list.tsx:780,788,809,825,845`),
               * 而本文件以前一个都没传。管线(宿主路由 + `api.*` + argv + git-service)
               * 在这之前就全部就绪、全仓 0 调用点:
               * 见 `docs/dead-code-and-missing-state-audit.md` §2.3 第 1-6 项。
               *
               * 逐项的上游 `enabled` 判据(镜像里逐字如此,不在这里重写):
               *  · `Reset to Commit…`      = `canResetToCommits && row>0 &&
               *                              row<=localCommitSHAs.length && onResetToCommit`(`:780`)
               *  · `Checkout Commit`       = `row > 0 && onCheckoutCommit !== undefined`(`:788`)
               *  · `Revert Changes in Commit` = `onRevertCommit !== undefined`(`:809`)
               *  · `Create Tag…`           = `onCreateTag !== undefined`(`:825`)
               *  · `Cherry-pick Commit…`   = `canCherryPick()` = `onCherryPick &&
               *                              isMultiCommitOperationInProgress === false`(`:845,867-872`)
               *  · `Delete tag <name>`     = 入列要求「该提交有未推送的标签」(`:889-899`)
               * `canResetToCommits` 上游 = `formState.kind === HistoryTabMode.History`
               * (`compare.tsx:251`),我们就是 History 模式 ⇒ 恒 `true`(与
               * `canAmendCommits` / `canUndoCommits` 同一条依据,见上面那段注释)。
               *
               * ⚠️ **`Reorder Commit` 仍然是灰的,而且必须保持灰**:
               * 它的 `enabled = canReorder()`(`:867-872`)要求 `onKeyboardReorder`
               * **有值**且 `disableReordering === false`。键盘重排属于「多提交操作」
               * (rebase/reorder/squash 那一族),本插件**没有**那套界面
               * (`Snapshot.forcePushBranches` 的注释第 2 条登记了同一处缺口)。
               * 传一个 no-op 只会把一个「点了没反应的项」从灰变成亮 —— 更坏。
               * 所以**不接**(审计 §2.9 第 9 行把这一族归为需要产品裁决)。
               */
              canResetToCommits={true}
              onResetToCommit={onResetToCommit}
              onCheckoutCommit={onCheckoutCommit}
              onRevertCommit={onRevertCommit}
              onCreateTag={onCreateTag}
              onDeleteTag={onDeleteTag}
              onCherryPick={onCherryPick}
              /*
               * ⭐ `isMultiCommitOperationInProgress` **必须显式传 `false`**(探针实测:
               * 不传时它是 `undefined`,而 `canCherryPick()` 的判据逐字是
               * `isMultiCommitOperationInProgress === false`(`commit-list.tsx:867-872`)
               * —— `undefined === false` 是 **false** ⇒ **即使用 `onCherryPick` 传了,
               * 「Cherry-pick Commit…」仍然灰着**。这正是审计那一族缺陷的同一个形状:
               * 「props 传了、判据还有另一半没人给」。
               *
               * 为什么可以确定它是 `false`:上游的语义是「正在做多提交操作
               * (rebase / squash / reorder / cherry-pick 的冲突解决阶段)」,
               * 而本插件**没有那套界面**(同一条依据见 `Reorder Commit` 那一段),
               * 所以「没有多提交操作在进行」是**我们确实知道**的事实,不是猜的。
               * 它同时是 `canReorder()` 的第三个合取项 —— 那个仍因 `onKeyboardReorder`
               * 缺席而恒灰(`disableReordering === false` 也照上游默认给上)。
               */
              isMultiCommitOperationInProgress={false}
              disableReordering={false}
              /*
               * ⚠️ `tagsToPush` **必须保持 `undefined`(即:一个字都不传)** ——
               * 这一条是**实测定下来的**,不是从类型上猜的:
               *
               * `getUnpushedTags`(`commit-list.tsx:373-377`)逐字是
               * `if (tagsToPush === undefined) return undefined`,然后
               * `getDeleteTagsMenuItem`(`:893-899`)在 `unpushedTags === undefined` 时
               * **返回 null ⇒ 项根本不入列**。
               *
               * 而**传一个空数组**会走另一条路:`commit.tags.length === 1` 时它返回
               * `{ enabled: unpushedTags.includes(tagName) }` ⇒ 一个**在列但恒灰**的
               * `Delete tag v1.0.0`。本探针第一次跑就是这个读数(见
               * `history-commit-actions-probe.mjs` 的 N1),而它**是本轮引入的**:
               * 改前不传 `tagsToPush`,`getUnpushedTags` 回 `undefined` ⇒ 项不入列。
               *
               * ⇒ 结论:**不传**才是与改前一致、且不会多出一个假项的那一档。
               * 「传全部标签」更不可接受:那会谎报「都没推送」,让一个**已推送**的标签
               * 可以被本地删掉(与上游的守卫相反)。
               *
               * 缺口登记(要真正点亮这一项需要什么):一个「哪些 tag 还没推送」的数据源 ——
               * 上游 `lib/stores/git-store.ts` 的 `loadTagsToPush` 走
               * `git log --tags --not --remotes`;本插件**没有**这条路由,
               * 而 `sync.tagCount` 只是**个数**(`git-service.ts:336`)。
               */
              /*
               * ⭐ 必须传,否则上游 `commit-list.tsx:816-822` 的
               * 「Create Branch from Commit」是一个**没有 enabled 守卫、action 里却被
               * `if (this.props.onCreateBranch)` 包着**的菜单项 ⇒ 看着能点、点了没反应。
               * 落点:`store.createBranch(name, commit.sha)`(host `branch-create` 路由)。
               */
              onCreateBranch={onCreateBranchFromCommit}
              emptyListMessage="还没有提交"
            />
          </SplitPane>
        </div>

        <div className="right">
          <div id="history" className={isExpanded ? 'expanded' : 'collapsed'}>
            {selectedCommit !== undefined && (
              <ExpandableCommitSummary
                repository={repository}
                selectedCommits={[selectedCommit]}
                shasInDiff={[selectedCommit.sha]}
                changesetData={changesetData}
                emoji={EMPTY_EMOJI}
                isExpanded={isExpanded}
                onExpandChanged={setIsExpanded}
                onHighlightShas={onHighlightShas}
                showUnreachableCommits={showUnreachableCommits}
                accounts={[]}
              />
            )}

            {multiSelected ? (
              /*
                上游 `selected-commits.tsx:326-330` 对**不连续**多选渲染
                `renderMultipleCommitsBlankSlate()`。我们对**任何**多选都走这里,理由写在
                文件头第 2 条:宿主没有区间 diff(`api.diff` 只收一个 commit)⇒ 与其显示
                一个错的 diff,不如明确告诉用户。DOM 形状照上游(`#multiple-commits-selected`
                + `.panel.blankslate`,样式在 `ui/history/_multiple_commits_selected.scss`),
                文案按 §11.9 用中文。
              */
              <div id="multiple-commits-selected" className="blankslate">
                <div className="panel blankslate">
                  <div>
                    <p>选中多个提交时无法显示 diff。</p>
                    <div>你可以:</div>
                    <ul>
                      <li>只选一个提交来看它的 diff。</li>
                      <li>用分支比较条来选择一段提交(尚未接线)。</li>
                    </ul>
                  </div>
                </div>
              </div>
            ) : (
              <div className="commit-details">
                {/* 内层分隔线 = Desktop 的 `commitSummaryWidth`(文件列表宽度)。 */}
                <SplitPane
                  split={fileListSplit}
                  id="dsh-git-history-file-list"
                  description="选中提交的文件列表"
                >
                  {files.length === 0 ? (
                    // 上游 `selected-commits.tsx:258-260` 的同名分支(`.fill-window` 的配方
                    // 在 `ui/_commit-details.scss` 里)。
                    <div className="fill-window">这个提交没有文件</div>
                  ) : (
                    <>
                      {/*
                        上游 `selected-commits.tsx:277-285`:文案是 `N changed file(s)`,
                        写死在 `selected-commits.tsx` 里。**我们没有渲染那个容器**
                        (`SelectedCommits` 需要 Dispatcher + app-state,见文件头),
                        所以这一行由适配层按上游同一 DOM 输出 —— 正好是 §11.9 说的
                        「从 props 传进去的文案由我们本地化」。类名与上游逐字一致。
                      */}
                      <div className="file-list-header">
                        {files.length} 个文件已变更
                      </div>
                      <FileList
                        files={files}
                        selectedFile={selectedFile}
                        onSelectedFileChanged={onSelectedFileChanged}
                        onRowDoubleClick={onRowDoubleClick}
                        availableWidth={Math.max(0, fileListSplit.width - 1)}
                      />
                    </>
                  )}
                </SplitPane>

                {/*
                  diff 列。`.diff-container` 是上游 `selected-commits.tsx:283-287`
                  那层,`.header` 是上游 `DiffHeader` 的根 ——
                  `_diff.scss:899,906` 的配方要求 `.diff-container` 是 `.header` 的祖先,
                  所以两者必须套在一起(上游也是这么套的)。
                */}
                <div className="diff-container">
                  {selectedFile !== null && (
                    <DiffHeader
                      diff={
                        detailDiff === null
                          ? null
                          : desktopDiffFromPatch(detailDiff.patch, detailDiff.binary)
                      }
                      path={selectedFile.path}
                      status={selectedFile.status}
                      showSideBySideDiff={snap.sideBySide}
                      onShowSideBySideDiffChanged={onShowSideBySideDiffChanged}
                      hideWhitespaceInDiff={snap.hideWhitespaceHistory}
                      onHideWhitespaceInDiffChanged={onHideWhitespaceInDiffChanged}
                      onDiffOptionsOpened={noop}
                    />
                  )}
                  {selectedFile === null ? (
                    // 上游 `selected-commits.tsx:148-153`:没有选中文件时是空态面板,
                    // 且**只在文件列表非空时**才显示「未选择文件」(避免两句空态文案同时出现)。
                    <div className="panel blankslate" id="diff">
                      {files.length === 0 ? '' : '未选择文件'}
                    </div>
                  ) : loadingDiff ? (
                    <div className="panel blankslate">读取 diff…</div>
                  ) : detailDiff === null ? (
                    <div className="panel blankslate">没有可显示的差异</div>
                  ) : (
                    <CommitDiff
                      store={store}
                      repoPath={repoPath}
                      file={selectedFile.path}
                      status={changeStatusOf(selectedFile.status)}
                      oldPath={oldPathOf(selectedFile.status)}
                      patch={detailDiff.patch}
                      binary={detailDiff.binary}
                      sideBySide={snap.sideBySide}
                      hideWhitespace={snap.hideWhitespaceHistory}
                      commitish={selected.sha}
                      parentCommitish={selected.parents[0] ?? ''}
                      onHideWhitespaceInDiffChanged={onHideWhitespaceInDiffChanged}
                    />
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/*
        提交行右键 ▸ Create Branch from Commit 的对话框(状态与理由见上面的
        `branchFrom` 声明)。渲染在这个 `tooltip-host` 根里:`.gw-dialog-scrim` 是
        `position:absolute;inset:0`(`styles.ts:420`),而 `.tooltip-host` 是
        `position:relative`(`scss/tooltips.scss`)⇒ 遮罩正好盖住 History 面板本身。
      */}
      {branchFrom !== null && (
        <ConfirmDialog
          title={`从 ${branchFrom.sha.slice(0, 7)} 创建分支`}
          body="新分支会在这个提交处创建,并立即切换过去。"
          confirmText="创建"
          input={{
            value: branchFrom.name,
            placeholder: 'feature/xxx',
            onChange: onBranchNameChange,
          }}
          onDone={onBranchDialogDone}
        />
      )}

      {/*
        提交行右键 ▸ Amend Commit… 的**强推警告**(上游 `WarnForcePushDialog`,
        `ui/multi-commit-operation/dialog/warn-force-push-dialog.tsx:38-78`;
        文案是那一份的中文对应:`<operation> Will Require Force Push` +
        「Force pushing will alter the history on the remote …」)。

        只在「这条提交已经在远端」时出现 —— 理由与判据见上面 `amendTarget` 的注释。
        上游那个对话框还有一个「Do not show this message again」复选框(它写回
        `setConfirmForcePushSetting`);本插件**没有** `askForConfirmationOnForcePush`
        这个偏好项(`toolbar.tsx:787` 已登记的同一处缺口),所以不画一个**不落盘**的
        复选框(那会是一个「勾了没用」的假开关),按上游默认值恒为 `true` 处理。
      */}
      {amendTarget !== null && (
        <ConfirmDialog
          title="修改提交需要强推"
          body={`确定要修改提交 ${amendTarget.sha.slice(0, 7)} 吗?\n\n这条提交已经在远端。修改之后,你需要用「强推」把分支推上去;强推会改写远端的历史,可能给同样在这个分支上协作的人带来麻烦。`}
          confirmText="开始修改" danger={true}
          onDone={onAmendDialogDone}
        />
      )}

      {/*
        提交行右键 ▸ Undo Commit… 的**本地改动确认**(上游 `WarnLocalChangesBeforeUndo`,
        `ui/undo/warn-local-changes-before-undo.tsx`)。文案与 Changes 页签那条撤销条
        (`changes-view.tsx` 的 `confirmUndo` 分支)**逐字一致** —— 同一份上游对话框的
        同一个入口,不写第二份措辞。
      */}
      {undoTarget !== null && (
        <ConfirmDialog
          title="撤销最近一次提交?"
          body={`${undoTarget.summary}\n\n提交会被撤销,改动保留在工作区(不会丢失),但不再处于暂存状态。`}
          confirmText="撤销提交" danger={true}
          onDone={onUndoDialogDone}
        />
      )}

      {/*
        提交右键 ▸ Reset to Commit… 的**模式选择**框。

        上游没有这一档(它写死 `GitResetMode.Mixed`,`app-store.ts:5884`),所以文案没有
        直接对照物 —— 三档的解释逐字取自 git 自己的语义与 `core/git-argv.ts:543-552`
        的注释(Hard = 索引与工作区都重置、未提交改动丢弃;Soft = 只动 HEAD,
        改动全留在「已暂存」;Mixed = 动 HEAD 与索引,工作区保留)。
        形状照 `WarningBeforeReset`(`ui/reset/warning-before-reset.tsx`):`destructive`
        + 一个说得清楚「会丢什么」的正文。
      */}
      {resetTarget !== null && (
        <ResetModeDialog
          sha={resetTarget.sha}
          mode={resetTarget.mode}
          onModeChange={onResetModeChange}
          onDone={onResetModeChosen}
        />
      )}

      {/*
        第二道闸门:`hard` 或工作区脏 ⇒ 破坏性确认。
        正文照上游 `WarningBeforeReset` 的正文意译(它只说「可能丢改动」;
        我们在 hard 那一档可以说得更确定,因为 `reset --hard` 是无条件的)。
      */}
      {resetConfirm !== null && (
        <ConfirmDialog
          title="重置会丢掉未提交的改动"
          body={
            resetConfirm.mode === 'hard'
              ? `确定要硬重置到 ${resetConfirm.sha.slice(0, 7)} 吗?\n\n「硬重置」会把索引与工作区都退回那条提交:工作区里**所有**未提交的改动都会被丢弃,无法从 dsh-git 恢复。`
              : `工作区里还有未提交的改动,确定要重置到 ${resetConfirm.sha.slice(0, 7)} 吗?\n\n重置会改动索引,工作区里的改动可能不再属于任何一次提交。`
          }
          confirmText="继续重置" danger={true}
          onDone={onResetConfirmed}
        />
      )}

      {/*
        提交右键 ▸ Checkout Commit 的**分离头**确认(与上游的差别见 `onCheckoutCommit`)。
      */}
      {checkoutTarget !== null && (
        <ConfirmDialog
          title="检出这个提交?"
          body={
            `确定要检出 ${checkoutTarget.sha.slice(0, 7)}(${checkoutTarget.summary})吗?\n\n` +
            '检出某一条提交会让仓库进入**分离头(detached HEAD)**状态:你不在任何分支上。' +
            '这时新建的提交不属于任何分支,切到别的分支之后就很难再找回来。' +
            '只是想看看这个提交的话,直接点它看 diff 就好,不需要检出。'
          }
          confirmText="检出(分离头)" danger={true}
          onDone={onCheckoutConfirmed}
        />
      )}

      {/*
        提交右键 ▸ Create Tag… 的**名字输入**框(上游 `ui/create-tag/create-tag-dialog.tsx`)。
        「轻量 vs 附注」这一档在本仓是**冻结契约**造成的差异,所以明确标出不可用并写原因
        —— 不画一个点了没反应的选项(见 `onCreateTag` 的注释与
        `docs/discard-lines-contract.md` §6)。
      */}
      {tagFor !== null && (
        <ConfirmDialog
          title="新建标签"
          body={
            `会在提交 ${tagFor.sha.slice(0, 7)} 上建一个标签。\n\n` +
            '类型:**轻量标签(lightweight)** —— 本插件的宿主路由建的就是这一种,' +
            '它没有 tagger、没有创建日期、没有消息,而且事后无法补(只能删了重打)。\n' +
            '上游 GitHub Desktop 建的是附注标签(annotated,`git tag -a -m \'\' <name> <sha>`),' +
            '我们这条契约还没改,所以那一档**不可选**。'
          }
          confirmText="创建标签"
          input={{
            value: tagFor.name,
            placeholder: 'v1.0.0',
            onChange: onTagNameChange,
          }}
          onDone={onTagDialogDone}
        />
      )}
    </div>
  );
}

/** 上游 `onDiffOptionsOpened` 是可选的 UI 通知(它只为遥测/焦点管理存在),这里照原样给空实现。 */
function noop(): void {}

/** Reset 的三种模式,以及它们在 git 里的确切含义(给对话框里的选项用)。 */
const RESET_MODES: ReadonlyArray<{ mode: 'soft' | 'mixed' | 'hard'; label: string; detail: string }> = [
  {
    mode: 'soft',
    label: 'Soft',
    detail: '只把 HEAD 移到那条提交:所有改动都留在索引里,看起来全都「已暂存」。',
  },
  {
    mode: 'mixed',
    label: 'Mixed(默认)',
    detail: '移动 HEAD 并清空索引,工作区里的文件一个字节都不动 —— 改动变成「未暂存」。',
  },
  {
    mode: 'hard',
    label: 'Hard(危险)',
    detail: '索引与工作区一起退回那条提交:未提交的改动会被丢弃,无法从 dsh-git 恢复。',
  },
];

/**
 * **Reset to Commit 的模式选择框** —— 上游没有的等价物,所以这里逐条说明它为什么长这样。
 *
 * 上游那一项写死 `GitResetMode.Mixed`(`app-store.ts:5884`),所以桌面版**从不问模式**。
 * 本插件的宿主路由按冻结契约支持三档(`core/git-argv.ts:566-572`),而「Mixed 是唯一
 * 一档」这件事在界面上一旦不写清楚,用户点「Reset to Commit…」就无从知道自己的改动
 * 会不会被丢 —— 那正是 `docs/discard-lines-contract.md` §5 点名的缺陷族
 * (成功返回 + 破坏性后果 + 零反馈)的界面版。
 *
 * 形状**刻意与 `bits.tsx` 的 `ConfirmDialog` 一致**(同一个 `.gw-dialog-scrim` +
 * `.gw-dialog` + `.gw-dialog-actions` 外壳、同样的中文「取消」),唯一多出来的是三个
 * 选项 —— 因为 `ConfirmDialog` 的 props 面只有「单行输入框」这一种控件,
 * 而这里需要的是三选一。**不给 `bits.tsx` 加一个只有这里用的 props**:那是把
 * 一个共享件的接口为一个调用点撑大,以后别的线会以为它是通用能力。
 */
function ResetModeDialog(props: {
  sha: string;
  mode: 'soft' | 'mixed' | 'hard';
  onModeChange: (mode: 'soft' | 'mixed' | 'hard') => void;
  onDone: (okay: boolean) => void;
}): ReactNode {
  const titleId = useId();
  /**
   * 两个事件回调**必须包 `useCallback`**:`react/jsx-no-bind`
   * (`scripts/lint-baseline.json` 是**只拦上升**的棘轮)会把组件作用域里的内联箭头
   * 记成新增违规 —— 与 `branches-view.tsx` / `repo-bar.tsx` 记过的是同一条纪律。
   */
  const onKeyDown = useCallback((event: React.KeyboardEvent): void => {
    // Esc 取消:与 `ConfirmDialog` 同一条(对话框必须有键盘退出路径)。
    if (event.key === 'Escape') {
      event.stopPropagation();
      props.onDone(false);
    }
  }, [props]);
  const onScrimMouseDown = useCallback((event: React.MouseEvent): void => {
    if (event.target === event.currentTarget) { props.onDone(false); }
  }, [props]);
  /**
   * 三个单选项的 `onChange`。上游的 `<input type="radio">` 必须有一个具体回调,
   * 而每个选项的 `mode` 是 map 出来的 —— 所以这里按 `mode` 生成一个**具名**工厂,
   * 而不是在 JSX 里写 `onChange={() => …}`(那会新增 `jsx-no-bind` 违规)。
   */
  const cancelDialog = useCallback((): void => { props.onDone(false); }, [props]);
  const confirmDialog = useCallback((): void => { props.onDone(true); }, [props]);
  const changeTo = useCallback(
    (mode: 'soft' | 'mixed' | 'hard') => (): void => { props.onModeChange(mode); },
    [props],
  );
  return (
    <div
      className="gw-dialog-scrim"
      onKeyDown={onKeyDown}
      onMouseDown={onScrimMouseDown}
    >
      <div className="gw-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h4 id={titleId}>{`重置到 ${props.sha.slice(0, 7)}?`}</h4>
        <p>选一种重置方式。三种方式的区别就在「索引和工作区动不动」这两件事上:</p>
        {RESET_MODES.map((option) => (
          <label
            key={option.mode}
            style={{ display: 'flex', gap: 8, alignItems: 'flex-start', margin: '0 0 10px', cursor: 'pointer' }}
          >
            <input
              type="radio"
              name="gw-reset-mode"
              checked={props.mode === option.mode}
              onChange={changeTo(option.mode)}
              style={{ marginTop: 2 }}
            />
            <span style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' }}>
              <strong style={{ color: 'var(--dsw-alias-label-primary)' }}>{option.label}</strong>
              {` — ${option.detail}`}
            </span>
          </label>
        ))}
        <div className="gw-dialog-actions">
          <button className="gw-btn" onClick={cancelDialog}>取消</button>
          <button
            className={`gw-btn ${props.mode === 'hard' ? 'danger' : 'primary'}`}
            onClick={confirmDialog}
          >
            下一步
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 历史页签里的单文件 diff —— 走**同一个**移植过来的 Desktop `Diff`
 * (`./desktop-diff.tsx`),与 Changes 页签没有第二条路径。
 *
 * 与 Changes 的差别:
 *  - **不传 `bounded`**(用户报的「History 的 diffview 高度有问题」的**根因**):
 *    这一版 History 的容器链已经是上游 `selected-commits.tsx:305-325` 的形状
 *    (`#history{display:flex;flex-direction:column;flex:1}` → `.commit-details{flex:1}`
 *    两栏 → `.diff-container{flex:1}`),`.diff-container` 因此有**确定高度**,
 *    `.gw-desktop-diff{flex:1;min-height:0}` 直接生效。上一版之所以需要 `bounded`
 *    (`scss/desktop-diff.scss:331` 的 `flex:none;height:320px`),是因为那时摘要 +
 *    文件列表 + diff **三块共用一个 `overflow:auto` 容器**,`AutoSizer` 量不到高度;
 *    那个结构已经被换掉了,`bounded` 于是从「适配」退化成「常量高度」:
 *      · 高窗口:真 Chrome 实测 diff 正文 **320px**,而 `.diff-container` 减头部是
 *        **521.5px** ⇒ **201.5px 空白**;
 *      · 矮窗口:`.commit-details` 被 `min-height:150px` 顶在 **150px**,而正文仍是
 *        **320px** ⇒ 溢出 200px,被 `.commit-details{overflow:hidden}` **裁掉**(而虚拟
 *        列表还以为自己有 318px,于是既看不全也滚不到底)。
 *    证据与整条几何链见 `docs/probes/history-geometry-probe.mjs`(`--only=short` 这一档
 *    就是上面第二种情形)。
 *  - 用 `hideWhitespaceHistory`(Desktop 的 `hide-whitespace-in-diff` 键)而不是
 *    Changes 的那个键;
 *  - **不传 `selectable`**:历史 diff 只读(上游 `selected-commits.tsx:161`
 *    传 `readOnly={true}` 且不传 `onIncludeChanged`);
 *  - `commitish` / `parentCommitish` 是真实 sha:上下文展开要按修订取「旧/新」两份
 *    内容(`show-file`),空串会构造出 `git show :path` 这种不存在的对象名;
 *  - `onOpenBinaryFile` 必须传:缺省时 `desktop-diff.tsx` 会退化成 noop,
 *    二进制 diff 里那个「Open file in external program.」就成了**点了没反应的死按钮**
 *    (Changes 页签传了真实实现,所以只有这里坏 —— 审计 D §5.2)。
 */
function CommitDiff(props: {
  store: GitStore;
  repoPath: string;
  file: string;
  status: ChangeStatus;
  oldPath?: string | undefined;
  patch: string;
  binary: boolean;
  sideBySide: boolean;
  hideWhitespace: boolean;
  /** 该提交的 sha(`git log -m -1 --first-parent --patch` 的新侧)。 */
  commitish: string;
  /** 第一父提交(`--first-parent` 的旧侧);根提交传空串。 */
  parentCommitish: string;
  onHideWhitespaceInDiffChanged: (checked: boolean) => void;
}): ReactNode {
  /**
   * 两个具名回调。**必须包 `useCallback`**:`react/jsx-no-bind` 会把组件作用域里的
   * 内联箭头记成新增违规(本文件那两条存量就是这么来的,别再新增)。
   */
  const onOpenBinary = useCallback((fullPath: string): void => {
    void props.store.openInExternalEditor(fullPath);
  }, [props]);
  return (
    <DesktopDiff
      input={{
        repositoryPath: props.repoPath,
        path: props.file,
        ...(props.oldPath !== undefined ? { oldPath: props.oldPath } : {}),
        patch: props.patch,
        binary: props.binary,
        status: props.status,
        ...(props.commitish !== '' ? { commitish: props.commitish } : {}),
        ...(props.parentCommitish !== '' ? { parentCommitish: props.parentCommitish } : {}),
      }}
      showSideBySideDiff={props.sideBySide}
      hideWhitespaceInDiff={props.hideWhitespace}
      onHideWhitespaceInDiffChanged={props.onHideWhitespaceInDiffChanged}
      onOpenBinaryFile={onOpenBinary}
    />
  );
}

/**
 * ## 交给 branches 线的接口(比较/分支条)
 *
 * 上游 `ui/history/compare.tsx` 是 History 页签的**另一个模式**(TabBar:History / Compare),
 * 它渲染左栏的分支列表 + `CommitList`,并把 `selectedCommits` / `changesetData` 交给
 * `SelectedCommits`(本文件已经把后半段交付了)。它需要:
 *
 * ```
 * ui/history/compare.tsx            ← 未镜像(需要下面这些才能编译)
 * ui/branches/**                    ← 另一条线在移植(index.ts / branch-list / group-branches /
 *                                      branch-list-item / no-branches / pull-request-* …)
 * lib/stores/ahead-behind-store.ts  ← §1.3 排除的 lib/stores/**,要 shim(登记 EXPECTED)
 * ui/dropdown-select-button.tsx     ← 建议项,已批准但未沿用:它 import ./app-menu
 * ui/lib/update-branch.ts           ← 依赖上面那个
 * models/rebase.ts                  ← 已镜像(批准的第二批)
 * ui/lib/action-status-icon.tsx     ← 已镜像
 * ui/lib/fancy-text-box.tsx         ← 已镜像
 * lib/unique-coauthors-as-authors.ts / lib/squash/squashed-commit-description.ts ← 已镜像
 * ```
 *
 * 本文件已经建好、branches 线**必须消费**而不是重建的:
 *   · `toCommit` / `toAppFileStatus` / `toCommittedFileChange` / `tagsFromRefs` /
 *     `localCommitSHAsFrom`(宿主数据 → 上游模型,四个纯函数);
 *   · `#history` + `.commit-details` 这一段布局(上游 `selected-commits.tsx:305-325`);
 *   · `useSplitWidth`(两条分隔线的宽度状态机)。
 * 需要接缝的话,建议把上面那几个纯函数提到 `src/client/history-adapter.ts` 让两边共用 ——
 * 但那要动本文件的所有权,所以**先报给父代理**再动。
 */

export type { CommitEntry };
