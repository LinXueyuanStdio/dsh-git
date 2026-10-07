/**
 * 顶栏的两个**面板**(仓库下拉 / 分支下拉)与它们的状态适配。
 *
 * ⚠️ **顶栏外壳已经不在这里** —— 从 2026-10 起,「当前仓库 / 当前分支 / 推送」那三段
 * 是上游 GitHub Desktop 的 `Toolbar` + `ToolbarDropdown`(`src/client/toolbar.tsx`,
 * 镜像在 `src/core/desktop/ui/toolbar/**`)。本文件只负责:
 *
 *  1. `RepositoryPanel` —— 仓库下拉的**内容**:上游 `ui/repositories-list/**` 的
 *     props 适配层(把 dsh-git 的 `RepoEntry` 翻译成 Desktop 的 `Repository`),
 *     外加本插件自己的「远程仓库」段(Desktop 没有的产品能力);
 *  2. `BranchPanel` —— 分支下拉的内容(手写,见文件末尾的缺口清单);
 *  3. `syncPresentation()` —— 上游 `ui/toolbar/push-pull-button.tsx:441-532`
 *     `renderButton()` 的状态机移植(优先级链逐条对照,顺序不能变)。
 *
 * 本地仓库来自 host 清单,已登录时叠加远程仓库与公开搜索。
 * @module dsh-git/client/repo-bar
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Icon } from './icons.ts';
import { ConfirmDialog } from './bits.tsx';
// 竖排断点必须与两栏布局用**同一个常量**,否则两处会静默漂移
// (`history-view.tsx:163` 的 `stacked` 用的就是它)。
import { SPLIT_STACK_BREAKPOINT } from './history-view.tsx';
import type { GitStore, Snapshot } from './store.ts';
import { api } from './api.ts';
import type { RemoteRepo } from './api.ts';
import type { RepoEntry } from '../core/types.ts';
// 能力缺口的提示语(单一真源)。为什么是 toast 而不是静默 no-op:见那个文件的文件头。
import { WORKTREE_UNAVAILABLE } from './unsupported-notices.ts';
import { caseInsensitiveCompare } from '../core/desktop/lib/compare.ts';
// 上游 GitHub Desktop 的仓库列表本体(逐字镜像,见 docs/desktop-ui-port.md §10)。
// 这个文件里的 RepositoryPanel 是它的 **props 适配层** —— 把 dsh-git 的仓库模型
// (RepoEntry:path/remote/alias)翻译成 Desktop 的 Repository 模型。
// 适配放在**我们的层**,是为了不改上游那 5 个文件一个字。
import { RepositoriesList } from '../core/desktop/ui/repositories-list/index.ts';
import { Repository } from '../core/desktop/models/repository.ts';
import { GitHubRepository } from '../core/desktop/models/github-repository.ts';
import { Owner } from '../core/desktop/models/owner.ts';
import { Dispatcher } from '../core/desktop/ui/dispatcher/index.ts'
import { PopupType } from '../core/desktop/models/popup.ts';
import type { ILocalRepositoryState } from '../core/desktop/models/repository.ts';
import type { Repositoryish } from '../core/desktop/ui/repositories-list/group-repositories.ts';
// `testForInvalidChars` 曾只被已删除的手写 `BranchPanel` 使用,随之删掉;
// `sanitizedRefName` 是**移植前就存在**的死 import(不在本次删除范围,保持不动,诊断数与基线一致)。
import { sanitizedRefName } from '../core/desktop/lib/sanitize-ref-name.ts';
// 上游的仓库图标判定(`ui/octicons/repository.ts`,逐字镜像):用真身,不自己写一份。
import { iconForRepository } from '../core/desktop/ui/octicons/index.ts';
import type { OcticonSymbol } from '../core/desktop/ui/octicons/index.ts';
import * as octicons from '../core/desktop/ui/octicons/octicons.generated.ts';

function basename(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * 事件目标是不是本组件渲染出来的确认框(别名 / 移除)里面的东西?
 *
 * 用于 `RepositoryPanel` 的「点外面关闭」判定:那两个 `ConfirmDialog` 与面板是
 * fragment 里的**兄弟节点**(`panelRef` 只包住面板那一层 div),而关闭逻辑只看
 * `panelRef`,所以不补这一条的话,用户在确认框里按下鼠标就会被判成「点外面」——
 * foldout 立刻卸载,「保存 / 移除」的 click 永远到不了(理由与实证链见调用点注释)。
 *
 * 为什么用类名而不是再挂一个 ref:对话框是 `bits.tsx` 的**共享组件**(本文件不持有它),
 * 而 `.gw-dialog-scrim` 是本项目所有确认框的唯一根类(`bits.tsx:32`),
 * 从事件目标 `closest()` 上去正好命中它。`Element` 判断是为了 `closest` 的可用性
 * (mousedown 的 target 也可能是 Document 一类没有 `closest` 的节点)。
 */
function isInsideConfirmDialog(target: Node): boolean {
  return target instanceof Element && target.closest('.gw-dialog-scrim') !== null;
}

/**
 * 选中仓库在顶栏上显示的图标 —— 走**上游** `iconForRepository`
 * (`ui/octicons/repository.ts`,逐字镜像)。
 *
 * 上游按 `Repository` 实例判定(missing → alert;无 GitHub 远端 → deviceDesktop;
 * 私有 → lock;fork → repoForked;否则 repo)。我们只有 `missing` 与 `owner/repo`
 * 两类信息,所以 `lock` / `repoForked` 两条分支今天**取不到真值**
 * (远端清单里的 `isPrivate` 没有落到 `RepoEntry` 上)——这是**数据缺口**,
 * 不是代码缺口,已登记在交付说明里。
 *
 * 这里只为「选中的那一个」造实例:列表那边的实例缓存带身份契约
 * (`toDesktopRepositories` 的 memoize 依赖引用相等),而这里只读
 * `.missing` 与 `.gitHubRepository`,不需要稳定身份。
 */
export function iconForRepoEntry(entry: RepoEntry | undefined, index: number): OcticonSymbol {
  if (entry === undefined) { return octicons.repo; }
  return iconForRepository(repositoryForEntry(entry, index)) as OcticonSymbol;
}

/**
 * `RepoEntry` → 上游 `Repository` 的**单件**适配(与列表那批共用同一个
 * `buildGitHubRepository`,所以 `owner/repo` 的解析只有一份)。
 *
 * 与 `toDesktopRepositories` 的区别:那份带**实例缓存**(列表的 memoize 依赖引用相等),
 * 这份给「只需要一个配好字段的 Repository」的消费方用(顶栏图标、分支列表的
 * `repository` prop)。**不要**在列表里用它 —— 每轮新建实例会让 memoize 永远失效。
 */
export function repositoryForEntry(entry: RepoEntry, index: number): Repository {
  return new Repository(
    entry.path,
    index,
    buildGitHubRepository(entry, index),
    entry.missing === true,
    entry.alias ?? null,
  );
}

/**
 * 同步段的状态机 —— 上游 `ui/toolbar/push-pull-button.tsx:441-532` 的 `renderButton()`
 * **逐条对照**。
 *
 * 顺序不能变:无远端 → 未出生 → 分离头 → **无 upstream(发布分支)**
 * → 0/0(抓取) → 分叉(推荐强推) → behind>0(拉取) → 否则推送。
 * 之前的实现把 `behind > 0` 排在 `upstream === null` 之前,于是「没有 upstream 且
 * behind>0」的分支会去拉取,而不是先发布分支 —— 与 Desktop 相反,已修。
 *
 * 与上游的差异(都是**数据/文案**层,不是结构层,逐条登记在交付说明里):
 *  - 上游 `progressButton` 有真实百分比;我们的 `busy` 只有字符串,所以只显示转圈;
 *  - 上游 `lastFetched` 用 `<RelativeTime>` 渲染;相对时间那条线今天还没接线,
 *    所以退化成 ISO 前 16 个字符;
 *  - 文案全部中文(goal 文档 §11.9)。
 */
export type SyncButtonKind =
  /** 上游 `:487` progressButton */
  | 'progress'
  /** 上游 `:526` publishRepositoryButton(无远端) */
  | 'publish-repository'
  /** 上游 `:590` fetchButton */
  | 'fetch'
  /** 上游 `:553` publishBranchButton(无 upstream) */
  | 'publish-branch'
  /** 上游 `:541` detachedHeadButton */
  | 'detached'
  /** 上游 `:672` forcePushButton(分叉且可强推) */
  | 'force-push'
  /** 上游 `:606` pullButton */
  | 'pull'
  /** 上游 `:655` pushButton */
  | 'push';

/** 主按钮点击要执行的动作。`force-push` 不在 `runSyncAction` 的联合里,单独走 `store.push(true)`。 */
export type SyncAction = 'fetch' | 'pull' | 'push' | 'force-push' | 'none';

/** 同步段的完整呈现(由 `syncPresentation()` 产出,由 `toolbar.tsx` 渲染成上游组件)。 */
export interface SyncPresentation {
  /** 对应上游 `renderButton()` 的哪一个分支。 */
  readonly kind: SyncButtonKind;
  /** 上游 `title`(Subtitle 风格下的**粗体大字**,如 `Push origin`)。 */
  readonly title: string;
  /** 上游 `description`(小字副文案;上游是 `renderLastFetched()`)。 */
  readonly description: string;
  /** 上游 `tooltip`。 */
  readonly tooltip: string;
  /** 远端名(`Push <remote>` 里的那个)。 */
  readonly remoteName: string | null;
  readonly up: number;
  readonly down: number;
  /** 主按钮点击执行的动作。 */
  readonly action: SyncAction;
  /** 上游 `disabled`。 */
  readonly disabled: boolean;
  /** 下拉内容要列出的项(上游 `getDropdownContentRenderer` 的 `itemTypes`)。 */
  readonly items: ReadonlyArray<'fetch' | 'force-push'>;
}

/** `从未抓取` / `上次抓取 <ISO 前 16 位>`(上游是 `Never fetched` + `<RelativeTime>`)。 */
function lastFetchedText(lastFetchedAt: string | null): string {
  return lastFetchedAt === null
    ? '从未抓取'
    : `上次抓取 ${lastFetchedAt.slice(0, 16).replace('T', ' ')}`;
}

/** 同步段状态机入口(名字保持与上游 `renderButton` 的语义一一对应)。 */
export function syncPresentation(snap: Snapshot): SyncPresentation {
  const empty: SyncPresentation = {
    kind: 'fetch',
    title: '同步',
    description: '先选择仓库',
    tooltip: '先选择仓库',
    remoteName: null,
    up: 0,
    down: 0,
    action: 'none',
    disabled: true,
    items: [],
  };

  if (snap.current === '') { return empty; }

  const sync = snap.sync;
  const status = snap.status;
  if (sync === null) {
    return { ...empty, description: '读取中…', tooltip: '读取中…' };
  }

  const remoteName =
    sync.remotes[0] ?? (sync.upstream !== null ? sync.upstream.split('/')[0] ?? null : null);
  const up = sync.ahead;
  const down = sync.behind;
  const base = { remoteName, up, down };
  const fetched = lastFetchedText(sync.lastFetchedAt);

  /*
   * 1) 没有远端 → 上游 `publishRepositoryButton`(`push-pull-button.tsx:526-538`)。
   *
   * ⚠️ `disabled` 从 `true` 改成 `false`(2026-10),理由两条,都是实据:
   *  1. **上游这一支没有 `disabled`**(`publishRepositoryButton` 只有
   *     `{...defaultButtonProps()}` + title/description/icon/onClick,而
   *     `defaultButtonProps()` 只给 className/style)⇒ 它是**能点**的,点了打开
   *     `ui/publish-repository/**` 的建库向导;`true` 是我们在「没有那个向导」时期的
   *     自我偏离,而偏离的代价正是用户报的「看着能点 / 或者看着不能点,总之没有实话」。
   *  2. 现在这一支有**真实动作**了:`toolbar.tsx` 的 `publish-repository` case 会 toast
   *     一条点名缺什么(host 没有 `publishRepository` 路由)的说明。真 `disabled` 会让
   *     `onClick` 永远不触发 ⇒ 那条 toast 等于白写。
   * 对照上游 `detachedHeadButton`(`:541-555`)那个分支:上游**写死** `disabled={true}`,
   * 所以本状态机给 `detached` 的 `disabled: true` 才是与上游一致的。
   */
  if (sync.remotes.length === 0) {
    return {
      ...base,
      kind: 'publish-repository',
      title: '发布仓库',
      description: '这个仓库还没有远端',
      tooltip: '这个仓库还没有远端;请先在 GitHub 上建库并用 git remote add 关联',
      action: 'none',
      disabled: false,
      items: [],
    };
  }

  // 2) 未出生的分支 → 上游 `fetchButton`(:493-495)
  if (status?.unborn === true) {
    return {
      ...base,
      kind: 'fetch',
      title: `抓取 ${remoteName ?? ''}`.trim(),
      description: fetched,
      tooltip: '还没有提交,先抓取远端',
      action: 'fetch',
      disabled: false,
      items: [],
    };
  }

  // 3) 分离头 → 上游 `detachedHeadButton`(:497-499)
  if (status?.detached === true) {
    return {
      ...base,
      kind: 'detached',
      title: '无法同步',
      description: '分离头状态下不能推送',
      tooltip: '分离头状态下不能推送,请先切到分支',
      action: 'none',
      disabled: true,
      items: [],
    };
  }

  // 4) 无 upstream → 上游 `publishBranchButton`(:502-508)
  if (sync.upstream === null) {
    return {
      ...base,
      kind: 'publish-branch',
      title: '发布分支',
      description: `推到 ${remoteName ?? '远端'} 并建立跟踪关系`,
      tooltip: '把这个分支推到远端并建立跟踪关系',
      action: 'push',
      disabled: false,
      items: ['fetch'],
    };
  }

  // 5) 与远端一致 → 上游 `fetchButton`(:509-511)
  if (up === 0 && down === 0) {
    return {
      ...base,
      kind: 'fetch',
      title: `抓取 ${remoteName ?? ''}`.trim(),
      description: fetched,
      tooltip: fetched,
      action: 'fetch',
      disabled: false,
      items: [],
    };
  }

  // 6) 分叉 → 上游 `forcePushButton`(:513-519)当 `forcePushBranchState === Recommended`;
  //    不可强推时退到 `pullButton`(与上游 :520-522 的判断一致)。
  if (up > 0 && down > 0) {
    if (sync.canForcePush) {
      return {
        ...base,
        kind: 'force-push',
        title: `强推到 ${remoteName ?? '远端'}`,
        description: `领先 ${up}、落后 ${down}`,
        tooltip: `本地领先 ${up} 个、落后 ${down} 个提交;强推会用本地历史覆盖远端分支`,
        action: 'force-push',
        disabled: false,
        items: ['fetch', 'force-push'],
      };
    }
    return {
      ...base,
      kind: 'pull',
      title: `拉取 ${remoteName ?? ''}`.trim(),
      description: `落后 ${down} 个提交`,
      tooltip: `本地领先 ${up} 个、落后 ${down} 个提交;当前不能强推,只能先拉取`,
      action: 'pull',
      disabled: false,
      items: ['fetch'],
    };
  }

  // 7) 落后 → 上游 `pullButton`(:520-522)
  if (down > 0) {
    return {
      ...base,
      kind: 'pull',
      title: `拉取 ${remoteName ?? ''}`.trim(),
      description: `落后 ${down} 个提交`,
      tooltip: `落后远端 ${down} 个提交`,
      action: 'pull',
      disabled: false,
      items: sync.canForcePush ? ['fetch', 'force-push'] : ['fetch'],
    };
  }

  // 8) 领先 → 上游 `pushButton`(:530-532)
  return {
    ...base,
    kind: 'push',
    title: `推送到 ${remoteName ?? '远端'}`,
    description: fetched,
    tooltip: `领先远端 ${up} 个提交 · ${fetched}`,
    action: 'push',
    disabled: false,
    items: ['fetch'],
  };
}

// ---------- 仓库下拉 ----------

/** 每个仓库的行内指示器(照 Desktop 的 renderRepoIndicators)。 */
interface RepoIndicators {
  ahead: number;
  behind: number;
  changedFiles: number;
}

/**
 * 「最近用过的仓库」——照 Desktop 的 `recentRepositories: number[]`。
 *
 * Desktop 把这份清单存在它自己的应用数据库里;我们没有那个库,用 localStorage 顶替。
 * **只影响 Recent 组是否出现**:Desktop 的规则是仓库数 ≤ 7 时根本不建 Recent 组
 * (`ui/repositories-list/group-repositories.ts:60` 的 `recentRepositoriesThreshold`),
 * 所以这份状态丢了也只是少一个分组,不会让列表出错。
 */
const RECENT_REPOS_KEY = 'dsh-git:recent-repositories';

/** 读取最近选过的仓库 path(最近在前,最多 8 个)。 */
function readRecentRepoPaths(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_REPOS_KEY);
    if (raw === null) { return []; }
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    // localStorage 被禁用(隐私模式 / 权限)时只是没有 Recent 组,不该让下拉打不开
    return [];
  }
}

/** 把一个 path 记到最近列表最前面。 */
function rememberRepoPath(path: string): void {
  try {
    const next = [path, ...readRecentRepoPaths().filter((x) => x !== path)].slice(0, 8);
    window.localStorage.setItem(RECENT_REPOS_KEY, JSON.stringify(next));
  } catch {
    // 同上:记不住就算了
  }
}

/**
 * 量「Changes 列表(左栏)」的**实际像素宽** —— 仓库下拉的宽度契约。
 *
 * 上游 `styles/ui/_repository-list.scss` 的注释写明:下拉「始终与 ToolbarDropdown 的
 * 按钮同宽」。我们的对应物就是它下面那两栏里的**左栏**(Changes 列表 / History 提交列表),
 * 而左栏宽度是用户可拖的 `useSplitWidth()`(`history-view.tsx:133`)驱动的 ——
 * 所以这里必须是**绑定**,不能是常量。
 *
 * ## 为什么**不**复制一份宽度状态
 *
 * 宽度状态已经有一份了(`useSplitWidth` 的 `width`),再建一份就是同一个事实两个来源,
 * 迟早不一致。但那份 state 在 `changes-view.tsx` / `history-view.tsx` 内部,
 * 而那两个文件**不归本文件所有**(改它们要动别人的线)。
 *
 * 折中:`.gw-split` 容器**已经**把左栏轨道宽写成了行内
 * `grid-template-columns`(见 `changes-view.tsx:116` 的 `split.containerStyle`),
 * 所以 DOM 里就有这个事实。这里用 `ResizeObserver` 观察 `.gw-split` 与它的 `.left`,
 * **只读**地把它取出来 —— 不新增第二份可写状态,也就不存在两个来源打架。
 * 本插件里 `.gw-split` 只有一处(Changes/History 同一容器),所以选择器是确定的。
 *
 * 竖排时(`< SPLIT_STACK_BREAKPOINT`)左栏不是左右轨道而是上下两行,那时不该用它的宽度
 * —— 折到竖排(`stacked`)时返回 0,让 `.gw-pop` 回落到自己的默认宽度。
 *
 * @returns 左栏像素宽;没有两栏布局(空态、竖排、首帧)时返回 0。
 */
export function useLeftPaneWidth(): number {
  const [width, setWidth] = useState(0);

  /*
   * 这里刻意**不用 `[]` 依赖只量一次**:`.gw-split` 只在「选了仓库且该页签有内容」时
   * 才存在。如果 `RepoBar` 先挂载(空态 / 首帧),一次性测量会量到 null 然后**永远**
   * 绑不上宽度 —— 表现为「下拉还是默认宽度,直到刷新页面」,属于最难发现的那种静默失效。
   * 所以在量不到时挂一个 `MutationObserver` 等它出现,量到就断开。
   */
  useLayoutEffect(() => {
    let resizeObserver: ResizeObserver | null = null;
    let mutationObserver: MutationObserver | null = null;
    let disposed = false;

    const measure = (split: HTMLElement, left: HTMLElement): void => {
      const stacked = split.clientWidth > 0 && split.clientWidth < SPLIT_STACK_BREAKPOINT;
      const next = stacked ? 0 : Math.round(left.getBoundingClientRect().width);
      setWidth((prev) => (prev === next ? prev : next));
    };

    /** 找到 `.gw-split` 与它的左栏,接上 ResizeObserver;找不到就等它出现。 */
    const attach = (): void => {
      if (disposed) { return; }
      const split = document.querySelector<HTMLElement>('.gw-split');
      const left = split?.querySelector<HTMLElement>(':scope > .left') ?? null;
      if (split === null || left === null) {
        if (mutationObserver === null && typeof MutationObserver !== 'undefined') {
          mutationObserver = new MutationObserver(() => {
            const nextSplit = document.querySelector<HTMLElement>('.gw-split');
            if (nextSplit?.querySelector(':scope > .left') != null) {
              mutationObserver?.disconnect();
              mutationObserver = null;
              attach();
            }
          });
          mutationObserver.observe(document.body, { childList: true, subtree: true });
        }
        return;
      }
      measure(split, left);
      if (typeof ResizeObserver === 'undefined') {
        window.addEventListener('resize', () => { measure(split, left); });
        return;
      }
      resizeObserver = new ResizeObserver(() => { measure(split, left); });
      resizeObserver.observe(split);
      resizeObserver.observe(left);
    };

    attach();
    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
    };
  }, []);

  return width;
}

/**
 * `RepoEntry` → Desktop `Repository`(带 `GitHubRepository` / `Owner`)。
 *
 * **必须保持实例身份**:`RepositoriesList` 用 `memoizeOne` 按**引用相等**判断要不要
 * 重算分组(`ui/repositories-list/repositories-list.tsx:121-134`),而且
 * `findMatchingListItem` 用 `item.repository.id === selectedRepository.id` 找当前选中项
 * (`:100`)。每轮渲染都新建对象的话,memoize 永远失效、选中态也会飘。
 * 所以缓存只在真需要时**逐条增删**,已有的实例原样复用。
 *
 * Desktop 的 `Repository.id` 是它数据库里的主键,我们没有那个库 —— 用**在清单里的下标**
 * 顶替:同一个 path 在同一个清单位置上永远得到同一个 id,而 Recent 组只需要
 * 「稳定且唯一」,不需要跨会话稳定。
 *
 * ⚠️ **缓存必须按「映射输入」失效,不能只按 path 命中**(2026-10 修):
 * `Repository` 的 `alias` / `missing` / `gitHubRepository` 都是 `readonly`,
 * 而缓存键只有 path ⇒ 一旦 `RepoEntry` 的别名或远端变了(用户改别名、刷新时新发现远端),
 * 命中的**旧实例**会继续把旧别名 / 旧 GitHub 信息喂给列表 —— 表现是「别名改了但列表
 * 显示不变」「右键菜单里还是 Create alias」,正是本轮在治的那一类「控件看着生效其实没生效」。
 * 修法是命中前先比一次**我们映射过去的那几个字段**(`isRepositoryCacheFresh`)。
 * 这不违反上面的身份契约:输入的**值**没变时仍返回同一个实例(引用相等),
 * 只有值真的变了才重建 —— 那正是应该重建的时候。
 *
 * @param repos - 快照里的仓库清单。
 * @param cache - path → 实例;会被就地更新(增/删/失效重建)。
 */
function toDesktopRepositories(
  repos: ReadonlyArray<RepoEntry>,
  cache: Map<string, Repository>,
): Repository[] {
  const alive = new Set(repos.map((r) => r.path));
  for (const path of [...cache.keys()]) if (!alive.has(path)) cache.delete(path);

  return repos.map((entry, index) => {
    const cached = cache.get(entry.path);
    if (cached !== undefined && isRepositoryCacheFresh(cached, entry)) { return cached; }

    const repository = new Repository(
      entry.path,
      index,
      buildGitHubRepository(entry, index),
      entry.missing === true,
      entry.alias ?? null,
    );
    cache.set(entry.path, repository);
    return repository;
  });
}

/**
 * 缓存的实例是否仍然逐字段反映 `RepoEntry`(只比**会变的那三个**;
 * `path` 就是缓存键本身,`id` 由下标给出、与别名无关)。
 *
 * `remote` 的比较走 `parseRemoteFullName`(与 `buildGitHubRepository` 同一份解析),
 * 所以 `owner/repo` 之外的形状不会被误判成「永远不新鲜」而每轮重建实例。
 */
function isRepositoryCacheFresh(cached: Repository, entry: RepoEntry): boolean {
  if (cached.alias !== (entry.alias ?? null)) {
    return false;
  }
  if (cached.missing !== (entry.missing === true)) {
    return false;
  }
  const parsed = parseRemoteFullName(entry.remote);
  const expected = parsed === null ? null : `${parsed.ownerLogin}/${parsed.name}`;
  const actual = cached.gitHubRepository === null ? null : cached.gitHubRepository.fullName;
  return actual === expected;
}

/**
 * `RepoEntry.remote`(形如 `owner/repo`)→ 它的两段。
 *
 * **唯一一份解析**:`buildGitHubRepository`(造实例)与 `isRepositoryCacheFresh`
 * (判断缓存要不要失效)都走这里,所以两边不可能对「什么算合法的 owner/repo」有分歧。
 */
function parseRemoteFullName(remote: string | null): { ownerLogin: string; name: string } | null {
  if (remote === null || !remote.includes('/')) {
    return null;
  }
  const [ownerLogin, ...rest] = remote.split('/');
  const name = rest.join('/');
  if (ownerLogin === '' || name === '') {
    return null;
  }
  return { ownerLogin, name };
}

/**
 * 从 `RepoEntry.remote` 造一个 Desktop `GitHubRepository`。
 *
 * 没有远端(或远端不是 `owner/repo`)时返回 `null` —— 那正是 Desktop 里
 * `repository.gitHubRepository === null` 的情形,`groupRepositories` 会把它归到
 * `3:other` 组,`repository-list-item` 也不渲染 owner 前缀。
 */
function buildGitHubRepository(entry: RepoEntry, index: number): GitHubRepository | null {
  const parsed = parseRemoteFullName(entry.remote);
  if (parsed === null) {
    return null;
  }
  // endpoint 用点 com:我们的远端解析目前只认 github.com(`removeRemotePrefix` 同口径)
  const owner = new Owner(parsed.ownerLogin, 'https://api.github.com', index);
  return new GitHubRepository(parsed.name, owner, index, null, `https://github.com/${entry.remote}`);
}

/**
 * **props 适配层**:dsh-git 的仓库快照 → 上游 `RepositoriesList` 要的形状。
 *
 * 上游那份组件要什么(逐条对着 `ui/repositories-list/repositories-list.tsx:33-78`):
 *
 * | 上游要的 | 我们怎么给 |
 * |---|---|
 * | `repositories: Repositoryish[]` | `RepoEntry` → `Repository`(见 `toDesktopRepositories`) |
 * | `recentRepositories: number[]` | localStorage 里的 path 列表 → 映射成 id,再过滤掉已不存在的 |
 * | `localRepositoryStateLookup` | 复用下拉已经拉好的 `indicators`(↑↓ 与改动数) |
 * | `selectedRepository` | `snap.current` 命中的那个实例 |
 * | `dispatcher` | `new Dispatcher()` —— 上游那份替身,声明了列表真正调用的 5 个方法 |
 * | `onSelectionChanged` | `store.selectRepo(path)` + 记进最近列表 |
 * | `onRemoveRepository` | `setConfirmRemove(entry)` → 确认框 → `store.removeRepo(path)`(上游 `askForConfirmationOnRemoveRepository={true}` 的文案是 `Remove…`,确认由应用层弹;见下面那条 ⚠️) |
 * | `onShowRepository` | `store.revealInFileManager(path)` |
 * | `onViewOnGitHub` | `window.open('https://github.com/<owner>/<repo>')` |
 * | `onOpenInShell` / `onOpenInExternalEditor` | `store.revealInFileManager` / `store.openInExternalEditor` |
 * | `onFilterTextChanged` / `filterText` | 由 RepoPopover 持有的受控输入 |
 *
 * **不接的部分(如实记录,不假装)**:
 *  - `showContextualMenu` —— 上游 `repository-list-item-context-menu.ts` 生成的菜单
 *    交给 `lib/menu-item.ts` 的 `showContextualMenu()`,而那个函数默认只打印、不渲染。
 *    真正的宿主注入(`setContextualMenuHost`)按主代理的裁决归 **diff 那条线**
 *    (`src/client/context-menu-host.tsx`),本文件**不自己造一个替代品**;
 *    它落地后这里通过消费那个模块接上,不需要改本文件的结构。
 *  - `PopupType.CloneRepository` / `AddRepository` / `CreateRepository` /
 *    `ChangeRepositoryAlias` / `AddWorktree` ——
 *    上游的 `Add ▾`(`ui/repositories-list/repositories-list.tsx:417-454`)与仓库条目右键菜单
 *    都把这些交给 `dispatcher.showPopup(...)` / `dispatcher.changeRepositoryAlias(...)`,
 *    而 `ui/dispatcher/index.ts:58-71` 的两个方法都是**显式 no-op**(浏览器半没有那个弹窗栈)。
 *    所以列表必须拿一个**收窄过的** dispatcher:见下面的 `RepoListDispatcher`。
 *    这里曾经只留一句「见下面的 `onAddRepository` 实现」的注释 —— 而那个实现**从来没写下过**,
 *    于是三项都是点了没反应(2026-10-06 用户实测报告)。
 */
/**
 * 只给 `RepositoriesList` 用的 dispatcher —— **收窄 `showPopup` 与
 * `changeRepositoryAlias` 两条**,其余方法逐字继承 `ui/dispatcher/index.ts` 的替身。
 *
 * ## 为什么必须收窄(而不是改上游)
 *
 * `ui/repositories-list/repositories-list.tsx` 是**逐字镜像**(`verify-mirror` 要求
 * 字节一致),`Add ▾` 的三项在 `:441-454` 全部走 `this.props.dispatcher.showPopup(...)`,
 * 仓库条目右键菜单的别名两条走 `:456-465`,worktree 两条走 `:467-477`。
 * 替身的 `showPopup` / `changeRepositoryAlias` 是 no-op ⇒ **菜单渲染得出来、点了什么都不发生**。
 * 收窄点因此只能在**我们的层**:也就是注入 dispatcher 的这一个位置。
 *
 * ## 每个上游 action 各自接到哪里(逐条对照)
 *
 * | 上游发什么 | 上游 `repositories-list.tsx` | 上游真正的落点 | 我们的落点 |
 * |---|---|---|---|
 * | `PopupType.CloneRepository` | `:441-446` `onCloneRepository` | Clone 弹窗 | `props.onOpenClone()`(`CloneDialog`,已在 `workbench.tsx:275` 渲染) |
 * | `PopupType.AddRepository` | `:448-450` `onAddExistingRepository` | 选目录 | `props.onOpenAdd()`(`store.addRepoViaDialog()`,宿主目录选择器) |
 * | `PopupType.CreateRepository` | `:452-454` `onCreateNewRepository` | 新建向导 | **没有这个流程** ⇒ 只报清楚,不开空窗 |
 * | `PopupType.ChangeRepositoryAlias` | `:456-461` `onChangeRepositoryAlias` | `ui/rename-branch`… 同族的别名弹窗 | `props.onChangeAlias(path)` ⇒ `RepositoryPanel` 的 `ConfirmDialog`(`aliasFor` 那条) |
 * | `PopupType.AddWorktree` | `:467-472` `onCreateWorktree` | `ui/toolbar/worktree-dropdown.tsx` | **host 没有 worktree 路由** ⇒ toast 点名缺什么 |
 * | `dispatcher.changeRepositoryAlias(repo, null)` | `:463-465` `onRemoveRepositoryAlias` | 清空别名并落库 | `props.onSetAlias(path, null)` ⇒ `store.renameRepo(path, '')`(host `:224-227` 空别名=删别名) |
 * | `dispatcher.showWorktreesFoldout()` | `:475-477` `onShowWorktrees` | 切到 worktree 下拉 | **同上没有 worktree 能力** ⇒ 同一条 toast(见下面 `showWorktreesFoldout`) |
 *
 * ## `CreateRepository` 为什么是「报缺」而不是「画一个」
 *
 * 新建仓库的**能力**在 host 半是有的(`src/host/git-service.ts` 的 `git init`,
 * 由 `src/host/routes.ts` 的 `init:true` 分支调用),但**客户端没有那个向导**
 * (Desktop 的是 `ui/add-repository/create-repository.tsx` 一整套:目录、名字、
 * README/.gitignore/License 选项、创建后立即提交)。在半截流程上画一个能点的菜单项,
 * 就是用户这次报的同一类缺陷。所以这里给一条**明确的 toast**,而不是静默 no-op ——
 * **点了必须有反应,反应必须是实话**。
 *
 * ## 别名两条为什么走 `path` 而不是实例身份
 *
 * `ChangeRepositoryAlias` 携带的是上游 `Repository` **实例**。我们**只取 `.path`**:
 * `toDesktopRepositories` 的缓存按 path 复用实例,而缓存**会在别名变化时失效重建**
 * (见那个函数的注释)—— 也就是说实例上的 `alias` 可能是旧的,`path` 则一直是对的。
 * 所以别名回显一律从 `snap.repos[path].alias` 读,不读 `popup.repository.alias`。
 *
 * ## `default` 分支为什么留着
 *
 * `PopupType` 枚举**逐字保留了上游全部成员**(没有裁剪),所以不写 `default` 类型也完备;
 * 保留它是**刻意的防线**(将来别的调用点进来时不至于静默)。可达闭包里 `showPopup` 只有
 * 上面 5 个构造点(`ui/history/compare.tsx` 里另有 3 个,但那个模块**不在活跃闭包**,
 * 所以 `default` 今天接不到东西)—— 这句话写在这里,免得下一个人以为那里是活的。
 *
 * ## 可回收条件
 *
 * - `CreateRepository` 的客户端向导镜像落地后,把那个 case 换成 `props.onOpenCreateNew()`,
 *   并删掉它的 toast 与这一段说明;
 * - 别名弹窗镜像(`ui/repositories-list/**` 里那个弹窗本体,上游在
 *   `ui/dispatcher/dispatcher.ts:868` 落到 `appStore._changeRepositoryAlias`)落地后,
 *   把 `ChangeRepositoryAlias` 这一条换成渲染那个组件本体,并删掉 `RepositoryPanel` 里的
 *   `aliasFor` 状态与 `ConfirmDialog`;
 * - host 出现 worktree 路由(`git worktree list/add/remove`)后,删掉 worktree 那条 toast
 *   与 `unsupported-notices.ts` 的 `WORKTREE_UNAVAILABLE`,改走真实流程。
 */
class RepoListDispatcher extends Dispatcher {
  private readonly onClone: () => void

  /**
   * 「手动输入路径」那条入口(`RepositoryPanel` 的 `addingPath`)。
   *
   * ⚠️ 与 `onAdd` **不是**同一件事,虽然上游把两者都归在 `Add ▾` 下:
   * `onAdd` 是宿主目录选择器(`store.addRepoViaDialog`,拿到路径后走
   * `repos/add`,对非 git 仓库只会报错);这一条是**能填路径 + 能 offer `git init`**
   * 的那条路(审计第 3 项)。两个入口都留,由 `showPopup` 的 `PopupType.AddRepository`
   * 分派到 `onEnterPath`(上游那一项的名字就是「Add **Existing** Repository…」,
   * 而「已存在」正是这一条要处理的情形:目录在,仓库还不一定在)。
   */
  private readonly onEnterPath: () => void

  private readonly notifyUnsupported: (message: string) => void

  private readonly onChangeAlias: (path: string) => void

  private readonly onSetAlias: (path: string, alias: string | null) => void

  public constructor(
    onClone: () => void,
    onEnterPath: () => void,
    notifyUnsupported: (message: string) => void,
    onChangeAlias: (path: string) => void,
    onSetAlias: (path: string, alias: string | null) => void,
  ) {
    super()
    this.onClone = onClone
    this.onEnterPath = onEnterPath
    this.notifyUnsupported = notifyUnsupported
    this.onChangeAlias = onChangeAlias
    this.onSetAlias = onSetAlias
  }

  /**
   * 上游 `ui/dispatcher/dispatcher.ts:405` —— 这里**接住五条**,其余交给父类的 no-op。
   * @param popup - 上游压栈的弹窗描述(只看 `type`,别名两条再看 `repository.path`)。
   */
  public override showPopup(popup: { type: PopupType }): Promise<void> {
    switch (popup.type) {
      case PopupType.CloneRepository:
        this.onClone()
        return Promise.resolve()
      case PopupType.AddRepository:
        /*
         * 上游那一项叫 `Add Existing Repository…`(`repositories-list.tsx:448-450`,
         * 落点 `dispatcher.showPopup({ type: PopupType.AddRepository })`)。
         * 我们把它接到**能填路径**的那条入口 —— 因为它是唯一能处理
         * 「目录存在、但还不是 git 仓库」的入口(宿主 `repos/add` 对那种目录
         * 只会抛 `not-a-repository`)。面板上另有一颗「选择目录」按钮走
         * 宿主选择器(`this.onAdd`),两条并列,不互相取代。
         */
        this.onEnterPath()
        return Promise.resolve()
      case PopupType.CreateRepository:
        this.notifyUnsupported(
          '「新建仓库」还没有客户端向导(host 半能 init,但缺选址/README/首提交那一整套流程);' +
            '现在请先在终端 git init,再用「Add Existing Repository…」加入。',
        )
        return Promise.resolve()
      case PopupType.ChangeRepositoryAlias: {
        const path = repositoryPathOf(popup)
        if (path === null) {
          this.notifyUnsupported('这个仓库已经不在清单里了,别名没有改动。')
          return Promise.resolve()
        }
        this.onChangeAlias(path)
        return Promise.resolve()
      }
      case PopupType.AddWorktree:
        // 上游这里会切到 `ui/toolbar/worktree-dropdown.tsx`;我们**没有 worktree 能力**
        // (host 没有路由),所以点「New worktree…」必须有一条实话说出来。
        this.notifyUnsupported(WORKTREE_UNAVAILABLE)
        return Promise.resolve()
      default:
        return super.showPopup(popup as Parameters<Dispatcher['showPopup']>[0])
    }
  }

  /**
   * 上游 `ui/dispatcher/dispatcher.ts:868` —— 右键菜单的 `Remove Alias` 走这条
   * (`repositories-list.tsx:464`,传 `newAlias = null`)。上游这里落到
   * `appStore._changeRepositoryAlias`;我们落到同一套落库调用(`renameRepo`)。
   *
   * `newAlias !== null` 的分支今天**没有调用点**(唯一调用点是 `Remove Alias`),
   * 但签名是上游的,所以照样实现 —— 让「能清空也能设置」只有一个真源。
   */
  public override changeRepositoryAlias(
    repository: Repository,
    newAlias: string | null,
  ): Promise<void> {
    this.onSetAlias(repository.path, newAlias)
    return Promise.resolve()
  }

  /**
   * 上游 `ui/dispatcher/dispatcher.ts:441` —— 右键菜单的 `Show worktrees`
   * (`repositories-list.tsx:476`;**上游全仓也就这一个调用点**,已 grep 核对)。上游会在
   * 工具栏上打开 `ui/toolbar/worktree-dropdown.tsx`;我们没有那个下拉
   * (host 也没有 worktree 路由),所以与 `AddWorktree` 用**同一条**说明。
   *
   * 这个收窄只作用于**仓库列表**这一个 dispatcher 实例:`RepositoriesList` 是我们唯一
   * 注入收窄版 dispatcher 的地方,别的面(分支下拉等)将来即使发同名 worktree 请求,
   * 拿到的也是它们自己的 dispatcher,不会误吃这条 toast。
   */
  public override showWorktreesFoldout(): Promise<void> {
    this.notifyUnsupported(WORKTREE_UNAVAILABLE)
    return Promise.resolve()
  }
}

/**
 * 从上游 popup 里取 `repository.path`(见 `RepoListDispatcher` 那段「为什么走 path」)。
 *
 * 只读一个字段,所以用一个**结构化**的窄化而不是 import `Popup` 联合:镜像里的
 * `Popup` 会把 `models/popup.ts` 的整个联合拖进本文件的类型面,而这里只需要
 * 「它可能带一个 `repository: { path }`」。返回 `null` = 拿不到可用路径。
 */
function repositoryPathOf(popup: { type: PopupType }): string | null {
  const repository = (popup as { repository?: { path?: unknown } }).repository
  const path = repository?.path
  return typeof path === 'string' && path !== '' ? path : null
}

function DesktopRepositoriesList(props: {
  store: GitStore;
  snap: Snapshot;
  indicators: Record<string, RepoIndicators>;
  filterText: string;
  onFilterTextChanged: (text: string) => void;
  onClose: () => void;
  onOpenClone: () => void;
  /** 右键 `Create/Change alias…` → 打开别名弹窗(`RepositoryPanel` 持有那个 `ConfirmDialog`)。 */
  onChangeAlias: (path: string) => void;
  /** 右键 `Remove alias` / `dispatcher.changeRepositoryAlias(…, null)` → 落库(空串 = 删别名)。 */
  onSetAlias: (path: string, alias: string | null) => void;
  /** 右键 `Remove…` → 打开移除确认框(上游 `askForConfirmationOnRemoveRepository` 的真意)。 */
  onConfirmRemove: (path: string) => void;
  /**
   * 「手动输入路径」→ 打开输入框(`RepositoryPanel` 的 `addingPath`)。
   *
   * 这是审计第 3 项那条路的入口:宿主 `repos/add` 对非 git 仓库只会抛
   * `not-a-repository`,而 `repos/add-existing` 的 `init:true` 分支
   * (`api.addExisting`)此前 0 调用点 —— 用户挑了一个还没 `git init` 的目录,
   * 只得到一句「不是 git 仓库」然后无处可去。
   */
  onEnterPath: () => void;
}): ReactNode {
  const { store, snap, indicators } = props;
  const dispatcher = useMemo(
    () =>
      new RepoListDispatcher(
        props.onOpenClone,
        props.onEnterPath,
        (message) => store.toast(message, 'err'),
        props.onChangeAlias,
        props.onSetAlias,
      ),
    [props.onOpenClone, props.onEnterPath, props.onChangeAlias, props.onSetAlias, store],
  );
  const cache = useRef(new Map<string, Repository>());

  const repositories = toDesktopRepositories(snap.repos, cache.current);

  const stateLookup = useMemo(() => {
    const map = new Map<number, ILocalRepositoryState>();
    for (const repository of repositories) {
      const entry = snap.repos[repository.id];
      if (entry === undefined) { continue; }
      const indicator = indicators[entry.path];
      if (indicator === undefined) { continue; }
      map.set(repository.id, {
        aheadBehind: { ahead: indicator.ahead, behind: indicator.behind },
        changedFilesCount: indicator.changedFiles,
      });
    }
    return map;
    // repositories 的身份由 cache 保证稳定,所以这个 memo 的依赖就是「哪些条目有指标」
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.repos, indicators]);

  const selected = useMemo(
    () => repositories.find((r) => r.path === snap.current) ?? null,
    [repositories, snap.current],
  );

  const recent = useMemo(() => {
    const byPath = new Map(repositories.map((r) => [r.path, r.id]));
    return readRecentRepoPaths()
      .map((path) => byPath.get(path))
      .filter((id): id is number => id !== undefined);
  }, [repositories]);

  const onSelectionChanged = useCallback(
    (repository: Repositoryish): void => {
      rememberRepoPath(repository.path);
      void store.selectRepo(repository.path);
      props.onClose();
    },
    [store, props],
  );

  /*
   * ⚠️ `Remove…` 必须**先弹确认框**(2026-10 修)。
   *
   * 上游的文案由 `askForConfirmationOnRemoveRepository` 决定
   * (`repository-list-item-context-menu.ts:75`):`true` ⇒ `Remove…`(带省略号),
   * 而**确认框由应用层弹**(Desktop 在 `app-store` 的 `_removeRepository` 里问)。
   * 我们这一层以前直接把 `onRemoveRepository` 接成 `store.removeRepo(path)` ——
   * 菜单项写着「Remove…」、点下去**没有任何确认**,与省略号承诺的语义相反。
   * 现在改走 `props.onConfirmRemove`(`RepositoryPanel` 的 `setConfirmRemove`),
   * 也就是本文件里那条已经写好、此前**零调用点**的确认框。
   */
  const onRemoveRepository = useCallback(
    (repository: Repositoryish): void => {
      props.onConfirmRemove(repository.path);
    },
    [props],
  );

  const onShowRepository = useCallback(
    (repository: Repositoryish): void => {
      void store.revealInFileManager(repository.path);
    },
    [store],
  );

  const onOpenInShell = useCallback(
    (repository: Repositoryish): void => {
      void store.revealInFileManager(repository.path);
    },
    [store],
  );

  const onOpenInExternalEditor = useCallback(
    (repository: Repositoryish): void => {
      void store.openInExternalEditor(repository.path);
    },
    [store],
  );

  const onViewOnGitHub = useCallback(
    (repository: Repositoryish): void => {
      const gitHub = repository instanceof Repository ? repository.gitHubRepository : null;
      if (gitHub === null) { return; }
      window.open(gitHub.htmlURL ?? `https://github.com/${gitHub.fullName}`, '_blank', 'noopener');
    },
    [],
  );

  return (
    <RepositoriesList
      dispatcher={dispatcher}
      repositories={repositories}
      recentRepositories={recent}
      localRepositoryStateLookup={stateLookup}
      selectedRepository={selected}
      onSelectionChanged={onSelectionChanged}
      askForConfirmationOnRemoveRepository={true}
      onRemoveRepository={onRemoveRepository}
      onShowRepository={onShowRepository}
      onViewOnGitHub={onViewOnGitHub}
      onOpenInShell={onOpenInShell}
      onOpenInExternalEditor={onOpenInExternalEditor}
      onFilterTextChanged={props.onFilterTextChanged}
      filterText={props.filterText}
    />
  );
}

/**
 * 仓库下拉。**从 2026-06 起这里不再是手写实现** —— 列表本体是上游
 * `ui/repositories-list/**`(逐字镜像,见 `docs/desktop-ui-port.md` §10),
 * 本文件只负责:
 *
 *  1. `DesktopRepositoriesList` 的 **props 适配**(仓库模型 / 选中态 / 指示器);
 *  2. 面板的**定位与层级** —— `.gw-pop` 必须是 `.gw-header`(position:relative)
 *     的直接子元素,由 CSS 相对 header 定位。**不要**再套一层
 *     `position:absolute; inset:0` 的覆盖层:那个覆盖层只有 header 那么高,
 *     面板的 `max-height:calc(100% - …)` 会算成负数 → 面板塌成 16px、列表完全看不见。
 *     这是真 Chrome 实测出来的根因(见 `docs/desktop-ui-port.md` 的实测记录),
 *     不是猜的。
 *  3. 过滤输入框的**受控状态**(上游 `SectionFilterList` 自己渲染输入框,
 *     但过滤文本由我们持有,这样打开时能保持上次的关键词)。
 *  4. 两个模态框:**别名**(右键 `Create/Change alias…` 与 `Remove alias`,后者经
 *     `dispatcher.changeRepositoryAlias`)与**移除确认**(右键 `Remove…`)。
 *     它们替的是 Desktop 应用层的弹窗 + 确认,所以写在这里而不是上游组件里 ——
 *     上游那 5 个文件一个字都不能动。
 */
export function RepositoryPanel(props: {
  store: GitStore;
  snap: Snapshot;
  onClose: () => void;
  onOpenClone: () => void;
  onOpenAdd: () => void;
}): ReactNode {
  const { store, snap } = props;
  const panelRef = useRef<HTMLDivElement>(null);
  const leftPaneWidth = useLeftPaneWidth();
  const [filter, setFilter] = useState('');
  const [indicators, setIndicators] = useState<Record<string, RepoIndicators>>({});
  const [confirmRemove, setConfirmRemove] = useState<RepoEntry | null>(null);
  const [aliasFor, setAliasFor] = useState<{ repo: RepoEntry; value: string } | null>(null);
  /** 远程仓库段是否展开。**默认折叠** —— 它不得占据本地列表的位置(见下面那段注释)。 */
  const [remoteOpen, setRemoteOpen] = useState(false);

  /*
   * 点外面关闭。**不能**再靠「一个包住一切的 inset:0 覆盖层」来判:那个覆盖层是
   * 这个下拉塌成 16px 的根因(它只有 `.gw-header` 那么高,而面板的
   * `max-height:calc(100% - 64px)` 是相对它算的 → 负数 → 夹到 0)。现在面板是
   * `.gw-header` 的直接子元素,所以只判面板这一个 ref。详见 `styles.ts` 的
   * `.gw-pop` 注释。
   *
   * ⚠️ 2026-10 更正上一版注释里「别名/移除确认框是 portal 到 document.body 的模态框,
   * 不受影响」那句 —— **那句是错的**:`bits.tsx` 的 `ConfirmDialog` **没有** portal,
   * 它就渲染在本组件的 fragment 里,而且是 `panelRef` 那棵树的**兄弟**。只判 panelRef
   * 的后果是:用户在确认框里按下鼠标 ⇒ 被判成「点外面」⇒ `props.onClose()` 把
   * dropdown 关掉 ⇒ `dropdown.tsx:416-420` 在 `dropdownState !== 'open'` 时把整棵
   * foldout 返回 `null` ⇒ 确认框与「保存」按钮一起被卸载,click 永远到不了
   * ⇒ **别名改了但没保存**(又一类「点了没反应」)。所以下面补一条判定。
   */
  useEffect(() => {
    const close = (event: MouseEvent): void => {
      if (!(event.target instanceof Node)) { return props.onClose(); }
      if (panelRef.current?.contains(event.target) === true) { return; }
      if (isInsideConfirmDialog(event.target)) {
        return;
      }
      props.onClose();
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [props]);

  // 每行的 ahead/behind 与改动数:Desktop 用后台缓存,我们按需取(限量 20 个)
  useEffect(() => {
    let dead = false;
    void (async () => {
      const next: Record<string, RepoIndicators> = {};
      for (const repo of props.snap.repos.slice(0, 20)) {
        if (repo.missing === true) { continue; }
        const [status, sync] = await Promise.all([api.status(repo.path), api.syncState(repo.path)]);
        if (dead) { return; }
        if (status.ok) {
          next[repo.path] = {
            ahead: sync.ok ? sync.value.ahead : 0,
            behind: sync.ok ? sync.value.behind : 0,
            changedFiles: status.value.files.length,
          };
        }
      }
      if (!dead) setIndicators(next);
    })();
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * 右键 `Create/Change alias…` → 把上游 `Repository` **映射回我们的 `RepoEntry`**
   * 并打开下面那个别名框(`aliasFor`)。
   *
   * 为什么从 `snap.repos` 按 path 回查、而不是用传进来的实例:上游 `ChangeRepositoryAlias`
   * 携带的 `Repository` 由 `toDesktopRepositories` 的缓存给出,缓存只在「映射输入变了」
   * 时才重建(别名一改就重建),所以实例上的 `alias` 可能是**旧的**;`path` 则一直是对的。
   * 这正是主代理点名的那条(#1/#2)。
   *
   * 查不到(仓库刚被移除)= 说一句实话,不要静默:否则又是一次「点了没反应」。
   */
  const onChangeAlias = useCallback(
    (path: string): void => {
      const entry = snap.repos.find((r) => r.path === path);
      if (entry === undefined) {
        store.toast('这个仓库已经不在清单里了,别名没有改动。', 'err');
        return;
      }
      setAliasFor({ repo: entry, value: entry.alias ?? '' });
    },
    [snap.repos, store],
  );

  /**
   * 右键 `Remove alias`(走 `dispatcher.changeRepositoryAlias(repo, null)`)→ 落库。
   *
   * 空串 = 删别名,这是 host 的既定语义(`src/host/repo-registry.ts:224-227`:
   * `alias === ''` 时把 `alias` 字段整个删掉并把 `name` 还原成目录名),
   * 所以这里**不需要**另开一条「删除别名」的接口。
   */
  const onSetAlias = useCallback(
    (path: string, alias: string | null): void => {
      void store.renameRepo(path, alias ?? '');
    },
    [store],
  );

  /**
   * 右键 `Remove…` → 打开下面那个移除确认框(`confirmRemove`)。
   *
   * 上游的 `askForConfirmationOnRemoveRepository={true}` 只决定**菜单文案**
   * (`Remove…`,带省略号),真正的确认在应用层;我们这一层此前直接 `store.removeRepo`,
   * 于是省略号在说谎。改走 `setConfirmRemove` 之后,确认框(本文件早已写好、此前
   * **零调用点**)才真正复活。
   */
  const onConfirmRemove = useCallback(
    (path: string): void => {
      const entry = snap.repos.find((r) => r.path === path);
      if (entry === undefined) {
        store.toast('这个仓库已经不在清单里了。', 'err');
        return;
      }
      setConfirmRemove(entry);
    },
    [snap.repos, store],
  );

  /*
   * 「添加仓库」那条路(2026-10 补 **init 分支**)。
   *
   * ## 缺口是什么(逐条,不假装)
   *
   * 上游 `Add ▾` 的两个 entry 是**两件事**:
   *   · `Add Existing Repository…`(`ui/repositories-list/repositories-list.tsx:448-450`,
   *     发 `PopupType.AddRepository`)—— 加入一个**已经是** git 仓库的目录;
   *   · `Create New Repository…`(`:452-454`,发 `PopupType.CreateRepository`)
   *     —— 上游那是一个**完整向导**(`ui/add-repository/create-repository.tsx`:
   *     目录、名字、README/.gitignore/License 选项、创建后立即提交)。
   *
   * 本插件此前只有第一条的前半段(挑目录),而宿主对**不是 git 仓库**的目录只有
   * 一句 `not-a-repository`(「<path> 不是 git 仓库(**可以先初始化**)。」,
   * `src/host/routes.ts:490`)。那句「可以先初始化」在界面上**没有任何入口** ——
   * 因为 `repos/add-existing` 的 `init:true` 分支(`routes.ts:508-512`,
   * 内部就是 `deps.git.init({ path, defaultBranch: 'main' })`)与
   * `api.addExisting`(`api.ts:794`)**都已经写好、全仓 0 调用点**
   * (审计 `docs/dead-code-and-missing-state-audit.md` §2.3 第 8 项)。
   *
   * ## 这里接的是哪一半(以及为什么不接整份向导)
   *
   * 接的是「**已经有一个目录,想把它变成受管理的仓库**」这一半:
   * 输入/粘贴一个绝对路径 ⇒ 先按「已存在的仓库」加(`init=false`,
   * 等价于原来的 `api.addRepo`,但**不吞错误**)⇒ 宿主回 `not-a-repository` 时
   * 弹一次确认「要在这里 `git init` 吗」⇒ 确认后才用 `init=true` 重调。
   *
   * **不接**的是上游那个向导的另外三样(README / .gitignore / License 模板 +
   * 创建后立即提交):它们需要逐份模板文件与那套表单,画一个只有一半的向导就是
   * 用户这次报的同一类缺陷(「看着能点、实际少一半」)。所以这里**不画**那三样,
   * 也不假装能选;`PopupType.CreateRepository` 那一条仍然给一句实话(见
   * `RepoListDispatcher.showPopup` 的 `case`)。
   *
   * ## 为什么用「输入路径」而不是直接弹宿主目录选择器
   *
   * 两条路都留着,刻意**不取代**:
   *   · `store.addRepoViaDialog()`(原生/host 目录选择器)仍是工具栏那个 `+` 的行为
   *     —— 它快,而且拿到的是绝对路径;
   *   · `ConfirmDialog` 的单行输入框是给「我要填/粘一个路径」以及
   *     **「选择器不可用」**(远端/SSH 部署下 native 选择器会抛,
   *     见 `store.addRepoViaDialog` 的 catch)那两种情形的。
   *     `addRepo` 原来那句兜底提示就是让人「用『手动输入路径』直接填写」——
   *     而那个入口**从来不存在**,这句话也一直在指一个没有的按钮。
   *     ⇒ 这就是它。
   */
  const [addingPath, setAddingPath] = useState<string | null>(null);
  /** 已经试过一次、宿主说是「不是 git 仓库」的那个路径 ⇒ 弹 init 确认。 */
  const [initOffer, setInitOffer] = useState<{ path: string; reason: string } | null>(null);

  const onAddingPathChange = useCallback((value: string) => {
    setAddingPath(value);
  }, []);

  /**
   * 「打开输入路径框」的具名引用。
   *
   * **为什么不能写成 JSX 内联箭头**:`react/jsx-no-bind`(`scripts/lint-baseline.json`
   * 是**只拦上升**的棘轮)会把组件作用域里的内联箭头记成新增违规 ——
   * 与 `history-view.tsx` 记过的是同一条纪律。`setAddingPath` 本身引用稳定,
   * 所以这个 `useCallback` 的依赖数组是空的。
   */
  const openPathEntry = useCallback(() => {
    setAddingPath('');
  }, []);

  /**
   * 第一步:按「已存在的仓库」加(`init = false`)。
   *
   * 失败时**不吞**:`not-a-repository` 且路径是具体的(不是 `@pick`)⇒ 换成
   * `initOffer` 那一档;其余错误原话回显(不在这一层重写措辞)。
   */
  const onAddingPathDone = useCallback((okay: boolean) => {
    const target = addingPath;
    setAddingPath(null);
    /*
     * ⚠️ **同时收掉上一次的 init 提议**。不收的话会留下一个**过期对话框**:
     * 用户上一次被问「要在这里 `git init` 吗」之后按了取消(或又开了一次输入框),
     * 那个 `initOffer` 仍在 state 里 ⇒ 对话框还画着,而它指向的是**上一个路径**。
     * 下一次尝试失败时会被**换掉**(setInitOffer),但「取消之后它还在」这一段时间里
     * 用户点它就会对一个已经不打算处理的目录执行 `git init`。
     * 探针实测(`add-existing-repo-probe.mjs` 第一次跑 D2):`bad-request` 那一档
     * 读到 `dialogs=这个目录还不是 git 仓库` —— 那是**上一个夹具**留下的。
     */
    setInitOffer(null);
    if (!okay || target === null) {
      return;
    }
    const path = target.trim();
    if (path === '') {
      store.toast('请填写一个目录的绝对路径。', 'err');
      return;
    }
    void store.addRepoWithInit(path, false).then((error) => {
      if (error === null) {
        props.onClose();
        return;
      }
      if (error.code === 'not-a-repository') {
        setInitOffer({ path, reason: error.message });
        return;
      }
      store.toast(error.message, 'err');
    });
  }, [addingPath, props, store]);

  /** 第二步:`git init` 那一档的确认 / 取消(与 `onConfirmRemove` 同一条纪律:先取值再清空)。 */
  const onInitOfferDone = useCallback((okay: boolean) => {
    const target = initOffer;
    setInitOffer(null);
    if (!okay || target === null) {
      return;
    }
    void store.addRepoWithInit(target.path, true).then((error) => {
      if (error !== null) {
        store.toast(error.message, 'err');
        return;
      }
      props.onClose();
    });
  }, [initOffer, props, store]);

  const query = filter.trim().toLowerCase();
  const linkedRemotes = new Set(
    snap.repos
      .map((r) => r.remote)
      .filter((x): x is string => x !== null && x !== undefined),
  );
  const remoteHits = snap.remoteRepos
    .filter((r) => !snap.hidden.includes(r.fullName))
    .filter((r) => query === '' || r.fullName.toLowerCase().includes(query))
    .slice(0, 40);

  return (
    <>
      {/*
       * ⚠️ **面板不再是 `.gw-pop` 卡片** —— 从 2026-10 起它是 Desktop 的 **foldout 本身**
       * (上游 `ui/toolbar/dropdown.tsx:430-443` 把下拉内容直接放进 `.foldout`,
       * Desktop 的仓库下拉就是「一整块从工具栏底边铺到视口底边的面板」,不是浮卡片)。
       *
       * 为什么必须去掉这个类:浮层(`#foldout-container > .foldout`)已经有自己的背景
       * (`ui/_foldout.scss`)、宽度(`toolbar.tsx` 的 `foldoutStyleOverrides`)与层级
       * (`--foldout-z-index`),再套一层 `.gw-pop` 就变成「浮层带 + 卡片」**两层**,
       * 而且 `.gw-pop` 的 `height:min(70vh,520px)` 会把面板按在 520px、它那 8px 内边距
       * 与圆角阴影都不是 Desktop 的样子。
       *
       * 去掉它以后,面板的高度契约改由行内那段 `<style>` 的第 ① 条给
       * (`height:100%` = foldout 的高度 = 工具栏底边 → 视口底边),其余三条**原样不动**。
       *
       * 保留 `gw-repo-list`(上游列表作用域根)、`gw-repo-pop`(本插件的身份类)、
       * `data-gw-repo-pop`(样式键,另一条线加的)与下面那段行内 `<style>`。
       */}
      <div
        ref={panelRef}
        className="gw-repo-pop gw-repo-list"
        // 这段样式的选择器键(见上面那段 <style>)。用它而不是 `.gw-repo-pop`,
        // 避免与 styles.ts 里那条(以及未来任何一条)同名规则打架。
        data-gw-repo-pop=""
        /*
         * ⚠️ **这一行已失效(2026-10),退役待批 —— 不要当成活的契约读。**
         *
         * `--gw-pop-width` 的**唯一消费者**是 `src/client/scss/pop-width.scss` 里那条
         * `.gw-pop{width:var(--gw-pop-width,auto);max-width:none}`,而面板从「`.gw-pop`
         * 卡片」改成「foldout 本身」之后就**不再是 `.gw-pop`** ⇒ 那条规则打不到这个元素,
         * 变量写在这里没有任何效果。面板宽度现在来自 `toolbar.tsx` 传给
         * `ToolbarDropdown` 的 `foldoutStyleOverrides`(仓库段 = 实测左栏宽)。
         *
         * 全仓其余 `.gw-pop` 使用者(`MenuPopover` 的 `.gw-pop.right`、设置弹层)
         * **从不写**这个变量,所以那条 `var(--gw-pop-width, auto)` 只会永远回落到 `auto`。
         *
         * 处置(按主代理裁决,分两步):
         *  1. **本轮只登记 + 就地标注**(就是这段注释)。同一处归属还要在
         *     `scripts/styles.mjs` 的两个地方各标一句(那边归样式线,已回报):
         *     `PORT_SURFACES` 里 `id: 'pop-width'` 的表项、`VARIABLE_EXCEPTIONS` 里
         *     `'--gw-pop-width'` 那条;
         *  2. **退役**(删这一行 style + 删 `pop-width.scss` + 删那条 exception +
         *     删表项)由样式线在「确认全仓零 `.gw-pop` 写入方」之后一次做完 ——
         *     并发期做会把「暂时没写入方」和「真死了」混起来。
         *
         * 为什么留而不删:`useLeftPaneWidth()` 还被 `toolbar.tsx` 用来给 foldout 定宽,
         * 所以那个 hook 本身**不是**死代码,只有这一行行内变量是。
         */
        style={leftPaneWidth > 0 ? ({ '--gw-pop-width': `${leftPaneWidth}px` } as CSSProperties) : undefined}
      >
        {/*
         * `gw-repo-list` 必须是**上游列表的祖先**,所以加在这个面板上 —— 上面那个类
         * 串是本插件渲染出来的最外层容器,它里面就是 `RepositoriesList` 的
         * `<div className="repository-list">`。
         *
         * 为什么:整个 `repository-list` 移植面(`src/client/scss/repository-list.scss`,
         * 由 `scripts/styles.mjs` 的 `PORT_SURFACES` 编译成 `.gw-repo-list …` 前缀)
         * **只有落在 `.gw-repo-list` 子树里才生效**。本文件以前只把该类挂在下方的
         * 手写远端仓库段(`snap.auth.signedIn` 那一段),于是上游列表整棵树都在作用域
         * **之外** —— 那一面的 CSS 全部是死的。真 Chrome 实测(与
         * `repositories-list.tsx` / `section-filter-list.tsx` / `list-row.tsx` 同构的 DOM
         * + 构建产物里的真实 CSS):
         *
         * | 量 | 加之前 | 加之后 |
         * |---|---|---|
         * | `.repository-list-item` 有 `.gw-repo-list` 祖先 | **false** | true |
         * | `.filter-field-row`(`Row` 原语)computed `display` | **block** | flex |
         * | 过滤输入框 / `Add ▾` | 上下堆叠(各占整行) | 同一行:输入框 289px + 按钮 65px |
         * | `.repository-list-item` 高度 | **75px**(图标/名字/指示器竖排堆叠) | 18px(行高 29px) |
         * | `.list-item` computed `display` | **block** | flex |
         * | `.repo-indicators` | 独占一行,`display:block` | 推到行右,`display:flex` |
         * | 选中行底色 | **`transparent`** | `--box-selected-background-color` |
         * | 组头 `padding` / 字重 | **`0px` / 400** | `10px 10px 0` / 600 |
         * | `.gw-repo-list` 上的 `--list-item-hover-background-color` | **空** | `#2e2e2e` |
         *
         * 这正是 goal 文档 §7.1 那条判据的又一实例:**类名在产物里 ≠ 规则生效**。
         * 三道旧守卫(构建、类名覆盖、基底配方)全绿,因为 `.gw-repo-list …` 那些规则
         * **确实在产物里** —— 缺的是它们要求的那个祖先元素(§10.9 同一族)。
         *
         * 为什么不新包一层 `<div className="gw-repo-list">`:那样面板里就会多出一个
         * flex 层,而 `.gw-repo-list` 在 `styles.ts:639` 是 `flex:1;min-height:0;
         * overflow:auto`(手写远端段要的容器契约)—— 多包一层会同时改掉上游列表
         * **和**远端段的尺寸传导。挂在这个已经存在的祖先上,布局零新增、作用域最紧
         * (远端段那个 `gw-repo-list` 原样保留,它自己也要这一面的变量与
         * `.gw-pitem` 容器规则)。
         */}
        {/*
         * 本地列表的**尺寸契约**。
         *
         * ⚠️ 这是「列表看不见」的**必然那一层**根因,不是「位置差了几像素」:
         * 上游 `.repository-list` 只有 `display:flex`(`_repository-list.scss:1-5`),
         * **既没有 `flex` 也没有高度** —— 上游靠 app 外壳给它高度。我们的面板里它
         * 只有**内容高度 45px**,而下面 `.filter-list` 又是 `flex:1`,于是
         * `.filter-list-container` 分到 **0** ⇒ `.list` 0 ⇒ memo 出来的
         * `.ReactVirtualized__Grid` 内联 `height: 0px` ⇒ **一行都不渲染**
         * (react-virtualized 按测得高度裁,不报错)。
         *
         * 真 Chrome 实测(面板 250×157):`.repository-list` 45 / `.filter-list-container` 0 /
         * `.list` 0 / Grid 0 / `.repository-list-item` **0 行**;
         * 用户看到的就是「打开下拉只有手写远端仓库、本地列表根本看不到」。
         *
         * ⚠️ 顺序上要澄清一件事(避免沿用 §8.2 的旧结论):**本地 DOM 本来就排在远端段之前**
         * (`repo-bar.tsx` 里 `DesktopRepositoriesList` 在远端段之前)。所以「远端段在前」
         * 不是本次的原因,**被压成 0 高度**才是。这一点是用真 Chrome 量的
         * (`docs/probes/browser-probe.tsx`),不是从截图反推的。
         *
         * 为什么用行内式 `<style>` 而不是改 `repository-list.scss`:
         * scss 不归本文件所有。这段规则自带 `data-gw-*` 作用域键,只可能命中本组件
         * 渲染的这两个盒子;等样式所有者把它收进 `repository-list.scss`(规则见交付说明)
         * 之后这里可以整段删掉。
         */}
        <style>{[
          /*
           * ① 面板的**高度契约**(2026-10 改过一次,理由见上:面板不再是 `.gw-pop`)。
           *
           * 旧版是 `.gw-pop[data-gw-repo-pop]{height:min(70vh,520px)}` —— 那时面板是浮卡片,
           * 需要自己封顶。现在面板**就是 foldout**:`.foldout` 拿到的是
           * `dropdown.tsx:381-407` 的行内 `position:absolute; top:0; height:100%`
           * (容器 `:366-379` 是 `position:fixed; top:rect.bottom; height:calc(100% - rect.bottom)`),
           * 所以它的高度天然就是「工具栏底边 → 视口底边」。
           * ⇒ 面板要 `height:100%` 去接这个**确定高度**,再 `display:flex;column` 把剩余高度
           * 交给第 ② 条(否则 `.gw-repo-local` 的 `flex:1` 无处可分,列表又会被压成 0 ——
           * 那正是「仓库列表一行都不渲染」的机制,见下面那段)。
           *
           * ⚠️ 这一条是**唯一被改动的行**:选择器由 `.gw-pop[data-gw-repo-pop]` 变成
           * `[data-gw-repo-pop]`,声明由 `height:min(70vh,520px)` 变成
           * `height:100%;display:flex;flex-direction:column;min-height:0`。
           * 下面 ②③ 两条**逐字未动**(属另一条线的样式键化迁移)。
           */
          '[data-gw-repo-pop]{height:100%;display:flex;flex-direction:column;min-height:0}',
          /* ② 本地段拿走剩余高度(上游 `.repository-list` 自己没有 flex/height)。 */
          '.gw-repo-local[data-gw-repo-local]{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;min-width:0}',
          '.gw-repo-local[data-gw-repo-local] > .repository-list{flex:1 1 auto;min-height:0}',
          /* ③ 远端段是**固定高度**的页脚(折叠=一行开关),不参与抢高度。 */
          '.gw-remote-section[data-gw-remote-section]{flex:0 0 auto;min-height:0;border-top:1px solid var(--dsw-alias-border-l1);margin-top:4px}',
        ].join('')}</style>
        <div className="gw-repo-local" data-gw-repo-local>
          {/*
            上游没有这一行(`Add ▾` 只有三个菜单项),所以这里**如实标注**它是我们补的:
            审计第 3 项那条路(「目录还不是 git 仓库」)需要一个**能填路径**的入口 ——
            `store.addRepo` 原有的兜底提示一直在指「用『手动输入路径』直接填写」,
            而那个入口从来不存在。位置放在列表上方(与工具栏 `+` 那条目录选择器并列),
            因为它做的是**同一件事的另一种输入方式**,不是列表的一部分。
          */}
          <div className="gw-repo-addbar" style={{ display: 'flex', gap: 6, padding: '0 8px 6px' }}>
            <button
              className="gw-btn ghost"
              style={{ flex: 1, minWidth: 0 }}
              title="填写/粘贴一个目录的绝对路径;如果它还不是 git 仓库,可以在这里 git init"
              onClick={openPathEntry}
            >
              输入路径添加仓库…
            </button>
            <button
              className="gw-btn ghost"
              title="用系统的目录选择器挑一个已经在 git 里的仓库"
              onClick={props.onOpenAdd}
            >
              选择目录
            </button>
          </div>
          <DesktopRepositoriesList
            store={store}
            snap={snap}
            indicators={indicators}
            filterText={filter}
            onFilterTextChanged={setFilter}
            onClose={props.onClose}
            onOpenClone={props.onOpenClone}
            /*
             * ⭐ 手动输入路径(以及「不是 git 仓库 ⇒ 要不要 `git init`」那条路)。
             * 上游那一项是 `Add Existing Repository…`(`repositories-list.tsx:448-450`),
             * 我们在这里补的是它**缺的另一半**:见上面那段长注释。
             * 与面板上那颗「选择目录」(⇒ `props.onOpenAdd` ⇒ 宿主目录选择器)是
             * **两条并列入口**,后者不删(「先做,不删」)。
             */
            onEnterPath={openPathEntry}
            onChangeAlias={onChangeAlias}
            onSetAlias={onSetAlias}
            onConfirmRemove={onConfirmRemove}
          />
        </div>

        {/*
         * 远程仓库(可选登录)。**这不是 Desktop 的一部分** —— 上游的
         * `RepositoriesList` 只列本地仓库。这一段是本插件原有的产品能力
         * (列出你账号下未隐藏的仓库,可一键隐藏),换成上游实现后如果直接删掉就是
         * **功能回归**,所以保留 —— 但**收在本地列表下面、默认折叠**。
         *
         * ## 为什么必须收起来(真 Chrome 实测,不是审美)
         *
         * 这里以前是「分隔线 + 组头 + `.gw-repo-list` 的行」三块平铺,而
         * `.gw-repo-list` 在 `repository-list.scss` 里是 `flex:1 1 auto`(那是给
         * **面板自己**写的容器契约)。于是**同一个 flex:1 同时落在本地段的祖先和远端段上**,
         * 两者抢面板高度,而远端段是后写的、又带 `overflow:auto`,结果把本地列表挤到 0:
         *
         * | 量(真 Chrome,面板 250×157) | 修前 | 修后 |
         * |---|---|---|
         * | `.repository-list`(上游列表根) | 45px | 占满剩余 |
         * | `.filter-list-container` | **0px** | >0 |
         * | `.ReactVirtualized__Grid` 内联 `height` | **0px** | >0 |
         * | 渲染出来的 `.repository-list-item` | **0 行** | 全部仓库 |
         * | 远端段 | 157px(吃掉整个面板) | 折叠成一行的开关 |
         *
         * Grid 高度 0 ⇒ **一行都不渲染**(react-virtualized 按测得高度裁),于是用户
         * 看到的是「打开下拉只有手写远端仓库、本地仓库列表根本看不到」—— 与截图一致。
         * **注意:本地的 DOM 其实排在远端段之前**,所以这不是「顺序错了」,而是
         * 「本地那段被压成 0 高度」;§8.2 那句「位置基准错」只解释了面板整体偏位,
         * 没有解释列表消失。
         *
         * 为什么不是「干脆删掉远端段」:那是**功能回归**(多仓库清单是 Desktop 没有的
         * 产品能力)。为什么不是「挪进 Add ▾ 菜单」:`Add ▾` 的三项目前由本文件已有的
         * 回调实现、且是**创建/添加仓库**的动作,把「你账号下的仓库清单」塞进去会同时
         * 改掉那个菜单的语义与上游文案。收成**一个默认折叠的开关**是改动最小、
         * 又不丢能力的做法,并且**绝不占据本地列表的位置**。
         *
         * 折叠态本身也承载信息(数量 / 拉取中),所以折叠不等于藏起来。
         */}
        {snap.auth?.signedIn === true && (
          <div className="gw-remote-section" data-gw-remote-section>
            {/*
             * ⚠️ `gw-pitem` 是**必须的**,不是装饰 —— 这个按钮此前**一条规则都没有**
             * (`gw-remote-toggle` 在 `styles.ts` 与全部 scss 里 **0 命中**),于是它按
             * **浏览器默认按钮 chrome** 渲染。真 Chrome 实测(2026-10,`/tmp/j2-repofid`):
             *
             * | 量 | 裸 `<button>` 实测 | 加 `gw-pitem` 之后 |
             * |---|---|---|
             * | `background-color` | `rgb(239,239,239)`(buttonface) | `rgba(0,0,0,0)` |
             * | `border` | `2px outset rgb(0,0,0)` | `0px none` |
             * | `border-radius` | `0px` | `7px` |
             * | `font` | `13.3333px Arial` | `inherit`(12px) |
             * | `color` | `rgb(0,0,0)` | `--dsw-alias-label-primary` |
             * | `display` | `inline-block` | `flex`(子元素才排得开) |
             * | 三个子元素 | 全 `display:inline`,挤成 `GitHub · @LinXueyuanStdio2 个仓库` | `.grow` 撑满 / `.tail` 靠右 |
             *
             * 为什么复用 `gw-pitem` 而不是新写一条 CSS:它就是**同一张表里的行原语**
             * (图标 + `.grow` + `.tail`,与本段下面的 `RemoteRow` 同构),而
             * `styles.ts:369-377` 已经为它写好 `.gw-pitem` 本体与 `.gw-pitem .grow` /
             * `.gw-pitem .tail` 三条。加一个类名 = 零新增样式(「优先复刻结构、不叠声明」)。
             * `gw-remote-toggle` 保留为身份类,将来要单独调时还有抓手。
             */}
            <button
              type="button"
              className="gw-pitem gw-remote-toggle"
              aria-expanded={remoteOpen}
              title={remoteOpen ? '收起远程仓库列表' : '展开你账号下的远程仓库'}
              onClick={() => setRemoteOpen((v) => !v)}
            >
              {/*
               * `gw-remote-chevron` / `.open` 在 CSS 里同样**零规则**(类名在 DOM 上、
               * 产物里一条都没有),所以「展开时朝上」只能由本文件给。包一层 `span` 是
               * 因为 `Icon` 的 props 里**没有** `style`(`src/client/icons.ts:136` 只有
               * name/size/className/title),而那个文件不归本文件所有 —— 不为一行旋转改它。
               */}
              <span
                className={remoteOpen ? 'gw-remote-chevron open' : 'gw-remote-chevron'}
                style={{ display: 'inline-flex', flex: 'none',
                  transform: remoteOpen ? 'rotate(180deg)' : undefined }}
              >
                <Icon name="chevron-down" size={10} />
              </span>
              <span className="grow">GitHub · @{snap.auth.login}</span>
              <span className="tail">
                {snap.remoteReposLoading ? '拉取中…' : `${remoteHits.length} 个仓库`}
              </span>
            </button>
            {/*
              * ⚠️ **`maxHeight` 不是审美,是防「本地列表再次整段消失」。**
              *
              * 实测(同一个真 Chrome 探针,`/tmp/j2-repofid/result-many.json`,40 个远程仓库):
              * 展开后 `.gw-remote-list` 按内容长到 **1124px**,而面板只有 **735px**;
              * `.gw-remote-section` 是 `flex:0 0 auto`(不收缩)⇒ 收缩的只能是有
              * `min-height:0` 的 `.gw-repo-local` ⇒ 它被压成 **0**,`react-virtualized`
              * 再次 memo 出 `height: 0px`,**三行本地仓库一行都不渲染**
              * (`16_reopen_and_selection.rows` = `[]`,截图 `/tmp/j2-repofid/shot-many.png`
              * 里左栏只剩远程行)。这正是上一轮花整条线修掉的那个塌陷,只是触发者换成了
              * 我们自己的远端段 —— 所以**上限必须写在列表自己身上**:
              * 远端段再怎么长,也只能吃掉面板的一部分,本地列表永远拿得到高度。
              *
              * 为什么是 `min(40vh, 320px)` 而不是 `40%`:百分比 `max-height` 对
              * **auto 高度**的父盒(`.gw-remote-section` 是 `display:block`,高度由内容决定)
              * 无法解析,按规范退化成 `none` —— 那等于没写。视口单位与父盒是否确定无关。
              *
              * ⚠️ 这段注释的**形态**本身是个坑:它必须是 JSX children 位置的「花括号 + 块注释」
              * (本行上方就是这个形态),**不能**把块注释裸着塞进 `remoteOpen && (` 的括号里 ——
              * 实测 esbuild 报 `Unexpected "}"`(与 goal 文档 §11.13 记的那次同族)。
              * 而且注释正文里也**不能**写出那个块的结束定界符,否则它会把本注释提前关掉
              * (我第一版就是这么把构建弄红的,§7.2「注释里的同名 token 会被命中」同一课)。
              */}
            {remoteOpen && (
              <div className="gw-repo-list gw-remote-list" style={{ maxHeight: 'min(40vh, 320px)' }}>
                {remoteHits.length === 0 && (
                  <div className="gw-hint">
                    {snap.remoteReposLoading ? '正在拉取你的仓库…' : '没有匹配的远程仓库。'}
                  </div>
                )}
                {remoteHits.map((repo) => (
                  <RemoteRow
                    key={repo.fullName}
                    repo={repo}
                    linked={linkedRemotes.has(repo.fullName)}
                    onHide={() => { void store.hideRemote(repo.fullName); }}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {snap.auth?.signedIn !== true && snap.repos.length > 0 && (
          <div className="gw-hint">未登录:只显示本地仓库。登录后会列出你有权限的全部仓库。</div>
        )}
      </div>

      {/*
       * 别名框(上游 `ui/repositories-list/repositories-list.tsx:456-461` 的
       * `ChangeRepositoryAlias` 在我们这一层的**替身**)。
       *
       * ⚠️ 2026-10 之前这块是**死代码**:`setAliasFor` 全仓 0 个调用点 ⇒ 永不渲染。
       * 现在由 `RepoListDispatcher.showPopup` 的 `ChangeRepositoryAlias` 一条驱动
       * (见那个类的表格)。回显用 `snap.repos[path].alias`(不是 popup 携带的实例,
       * 理由见 `onChangeAlias` 的注释)。
       *
       * 可回收条件:上游 `ChangeRepositoryAlias` 的弹窗组件本体
       * (`ui/rename-branch`… 同族的那个 `RepositoryAlias` 对话框)镜像落地后,
       * 换回组件本体并删掉这里的状态与这段注释。
       */}
      {aliasFor !== null && (
        <ConfirmDialog
          title={aliasFor.repo.alias === undefined ? '创建别名' : '修改别名'}
          body="别名只影响 dsh-git 里的显示,不会改动磁盘上的目录名。留空即移除别名。"
          confirmText="保存"
          input={{ value: aliasFor.value, placeholder: aliasFor.repo.name,
            onChange: (value) => setAliasFor({ repo: aliasFor.repo, value }) }}
          onDone={(okay) => {
            const target = aliasFor;
            setAliasFor(null);
            if (okay) void store.renameRepo(target.repo.path, target.value.trim());
          }}
        />
      )}

      {/*
       * 移除确认框 —— 承接上游 `askForConfirmationOnRemoveRepository={true}` 那半语义。
       *
       * ⚠️ 2026-10 之前同样是**死代码**(`setConfirmRemove` 0 个调用点):菜单文案是
       * `Remove…`(省略号承诺一次确认),而 `onRemoveRepository` 直接 `store.removeRepo`
       * —— 点了就没了,没有确认也没有撤销。现在由 `props.onConfirmRemove` 驱动。
       *
       * 可回收条件:等上游「移除仓库」那套确认(Desktop 在应用层
       * `app-store._removeRepository`,带 `askForConfirmationOnRemoveRepository` 偏好)
       * 在浏览器半有真实落点后,换掉这条自造确认框。
       */}
      {confirmRemove !== null && (
        <ConfirmDialog
          title="移除这个仓库?"
          body={`${confirmRemove.alias ?? confirmRemove.name}\n${confirmRemove.path}\n\n只从 dsh-git 的清单里移除,磁盘上的仓库不会被删除。`}
          confirmText="移除"
          danger
          onDone={(okay) => {
            const target = confirmRemove;
            setConfirmRemove(null);
            if (okay) void store.removeRepo(target.path);
          }}
        />
      )}

      {/*
        第 1 步:**输入目录的绝对路径**(审计第 3 项的入口)。
        形状与 `aliasFor` 那条一致(`ConfirmDialog` 的单行输入框),
        措辞里点明「已经是 git 仓库就加进来,不是的话下一步会问你要不要 init」——
        否则用户填一个空目录、被问「要不要 git init」时会不知道为什么。
      */}
      {addingPath !== null && (
        <ConfirmDialog
          title="用路径添加仓库"
          body={
            '填写(或粘贴)一个目录的**绝对路径**。\n\n' +
            '如果这个目录已经是 git 仓库,会直接加进清单;' +
            '如果它还不是,下一步会问你**要不要在这里执行 `git init`**。'
          }
          confirmText="添加"
          input={{ value: addingPath, placeholder: '/home/me/project', onChange: onAddingPathChange }}
          onDone={onAddingPathDone}
        />
      )}

      {/*
        第 2 步:**`git init` 的确认**。
        上游那一半在上游是 `Create New Repository…` 的**完整向导**
        (`ui/add-repository/create-repository.tsx`:目录 / 名字 / README / .gitignore /
        License / 首个提交)—— 我们**没有**那套模板与表单,所以这里只做**承诺得住**的
        那一件事:在这个目录里 `git init`(宿主 `routes.ts:508-512` →
        `git-service.ts` 的 `init({ path, defaultBranch: 'main' })`),
        并**明确写出默认分支是 `main`**、以及「不会替你写 README/.gitignore/LICENSE、
        也不会替你提交」这三件事 —— 不画一个点了没反应的选项。
      */}
      {initOffer !== null && (
        <ConfirmDialog
          title="这个目录还不是 git 仓库"
          body={
            `${initOffer.reason}\n\n` +
            `要在 ${initOffer.path} 里执行 \`git init\` 吗?\n` +
            '初始分支名用 `main`。\n\n' +
            '⚠️ 这个流程只做 `git init` 这一件事:不会替你创建 README / .gitignore / LICENSE,' +
            '也不会替你提交(上游那个「新建仓库」向导有那几项,本插件还没有接)。'
          }
          confirmText="在这里 git init"
          onDone={onInitOfferDone}
        />
      )}
    </>
  );
}

function RemoteRow(props: { repo: RemoteRepo; linked: boolean; onHide: () => void }): ReactNode {
  const { repo } = props;
  return (
    <div className="gw-pitem" style={{ cursor: 'default' }} title={repo.description ?? repo.fullName}>
      <Icon name={repo.isPrivate ? 'lock' : 'git-branch'} size={10} />
      <span className="grow">{repo.fullName}</span>
      <span className="tail">{props.linked ? '已关联' : repo.pushedAt.slice(0, 10)}</span>
      {!props.linked && (
        <span className="gw-x" title="从列表隐藏" onClick={props.onHide}><Icon name="x-circle" size={10} /></span>
      )}
    </div>
  );
}

/* ---------- 分支下拉 ----------
 *
 * 这里曾经是 180 行手写的 `BranchPanel`(过滤/新建/键盘/远端分支)。从 2026-10 起
 * 分支下拉的内容是**上游** `ui/branches/**`:`src/client/branches-view.tsx` 渲染
 * `BranchList` + `renderDefaultBranch` + `groupBranches`(+ `BranchListItem`),
 * 面板根用上游类名 `.branches-container`。手写那一份**已无调用方**,由主代理批准删除
 * (它引用的 `removeRemotePrefix` / `testForInvalidChars` 两个 import 一并删掉)。
 *
 * ⚠️ 若要回退到刚才那份手写实现,请从本仓库历史里取 —— 不要凭记忆重写:
 * 它的键盘契约(↓/↑ 进出过滤框、零匹配回车即新建、远端分支用 `removeRemotePrefix`
 * 剥前缀而不是切第一个 `/`)是照着 `ui/lib/section-filter-list.tsx` 与
 * `ui/branches/branches-container.tsx` 逐条对齐过的。
 */

/** 仓库条目 → 展示名。 */
export function repoLabel(entry: RepoEntry | undefined, fallbackPath: string): string {
  if (entry === undefined) { return fallbackPath === '' ? '选择仓库' : basename(fallbackPath); }
  return entry.alias ?? entry.name;
}

export { api };
