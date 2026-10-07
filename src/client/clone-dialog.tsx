/**
 * 「Clone a repository」弹窗 —— 上游 `ui/clone-repository/**` 的移植。
 *
 * ## 结构与字段顺序(逐条对齐上游)
 *
 * | 上游 | 这里 |
 * |---|---|
 * | `clone-repository.tsx:263-291` 标题 / `TabBar` / `DialogError` / tabpanel / footer | 同顺序(`Title` → `.gw-clone-tabs` → `.gw-errbox` → `.gw-dialog-body` → `.gw-dialog-actions`) |
 * | `clone-repository.tsx:273-280` 三个页签(GitHub.com / GitHub Enterprise / URL) | **两个**(GitHub / URL)—— 见「已登记的偏离 1」 |
 * | `clone-generic-repository.tsx:32-63` URL 页签的两个字段 | 同:URL 字段(`autoFocus`)+ Local Path 字段 + `Choose…` |
 * | `clone-github-repository.tsx:100-131` GitHub 页签(可选 AccountPicker + 可过滤列表 + Local Path 行) | 同(没有 AccountPicker,见「偏离 2」;**Local Path 行在 2026-10 之前是缺的**) |
 * | `cloneable-repository-filter-list.tsx:169-310` 过滤框 / 分组 / 刷新 / 三档空态 / 行 | 同(分组规则见 `groupRepositories`) |
 *
 * ## 校验(用户说的「很多逻辑」就是这一段)
 *
 * 上游把校验做成**边打字边跑**,并把错误写进当前页签的 state:
 *
 * | 上游 | 触发点 | 这里 |
 * |---|---|---|
 * | `:570-591` `validatePath()` | 挂载 / 切页签(`:218-220`)/ 改 path(`:338-340`)/ 改 url(`updateUrl`)/ `Choose…` / 窗口重新获得焦点(`:819-824`)| 同(挂载与切页签在同一个 effect 里;`window` 的 `focus` 事件) |
 * | `:687-733` `validateClonePath()` | 上面每一处 | 同,**判定在宿主**(见 `ClonePathKind` 的注释:浏览器半没有 `readdir`) |
 * | `:301-314` `checkIfCloningDisabled()` | footer 的 Clone 按钮 | 逐字同条件(`url.length===0 \|\| path.length===0 \|\| loading \|\| error!==null`) |
 * | `:316-332` `renderFooter()` | 非 URL 页签且该页签没有账号 ⇒ **整个 footer 不渲染** | 同(GitHub 页签未登录 ⇒ 没有 Clone 按钮,只有登录引导) |
 * | `:648-684` `updateUrl()` | url 每变一次就**重算目标路径** | 同(`deriveClonePath`)—— 这是改前最缺的一条:以前粘一个 `owner/name` 之后 Local path 永远空着 |
 * | `:771-810` `clone()` | 按下 Clone:再校验一次 → 报错 → 调用 | 同(并多显示 `detail`,见「偏离 5」) |
 * | `:812-817` `cloneImpl()` | `dispatcher.clone(...)` + `onDismissed()` + `setDefaultDir(dirname(path))` | 同(宿主 `clone` 路由 + `onClose` + 记住 `last-clone-location`) |
 *
 * ## 文案:中文(按 `goal-port-desktop.md` §11.9 的人类裁决「先统一中文」)
 *
 * 每条中文都在代码里并排给出**上游原句**,免得以后有人「照中文回译」再漂一次。
 * 上游 `ui/clone-repository/**` 在本仓**没有镜像**(`src/core/desktop/ui/` 下没有这个目录)
 * ⇒ 这些字符串**不进** `scripts/verify-mirror.mjs` 的 `EXPECTED`(那个表只管镜像文件的偏离)。
 *
 * ## 已登记的偏离(逐条写清「为什么」与「回收条件」)
 *
 * 1. **没有 GitHub Enterprise 页签。** 上游 `:273-280` 有三个;我们的登录态只有一个端点
 *    (`auth/state` 的 `endpoint`,设备码流程也只认 github.com 的 OAuth App),没有
 *    「添加企业账号」的入口,所以那个页签只会渲染出 `renderSignIn` 的空白
 *    (上游 `:358-392` 在 `getAccountForTab` 为 null 时**连 footer 都不渲染**)。
 *    回收条件:宿主支持多端点账号(`accounts-store` 那一族)之后按上游加回来。
 * 2. **没有 AccountPicker。** 上游 `clone-github-repository.tsx:103-105` 只在
 *    `accounts.length > 1` 时渲染它;我们只有一个账号 ⇒ 与上游**在同一条件下**的可见结果一致。
 * 3. **目标路径的默认值不是 `<Documents>/GitHub`。** 上游 `ui/lib/default-dir.ts:7-12` 是
 *    `localStorage['last-clone-location'] || join(await getDocumentsPath(), 'GitHub')`,而
 *    `getDocumentsPath` 是 Electron 的 `app.getPath`,浏览器半没有对等物(宿主也没有
 *    「我的文档」这条路由)。我们保留**同一个 localStorage 键**,拿不到时依次回落到
 *    「当前仓库的父目录」→ 空(见 `defaultCloneDir`)。
 * 4. **`Choose…` 的两条通道。** 上游在 macOS 上用**保存**对话框(`buttonLabel:'Select'`,
 *    `nameFieldLabel:'Clone As:'`)、其它平台用**打开目录**对话框
 *    (`clone-repository.tsx:593-646`);我们的宿主只有一条 `pick-directory`
 *    (只回一个目录路径,**不回「用的是哪种对话框」**)⇒ 只能照非 macOS 那一支
 *    (选完目录后拼仓库名)。回收条件:宿主路由带上对话框种类。
 * 5. **克隆失败多显示 `detail`。** 上游 `:282` 只渲染 `error.message`;我们的宿主把
 *    git 的 stderr 放在信封的 `detail` 里(见 `push-failure-surfaces.md`),
 *    只显示 `message` 会丢掉「git 到底说了什么」—— 所以这里 message + detail 都给。
 * 6. **列表行的图标没有 fork 那一档,也没有 Archived 徽标。** 宿主的 `remote-repos`
 *    只回 `fullName / isPrivate / pushedAt / description`(`RemoteRepo`),而且**把
 *    `archived` 的仓库整个过滤掉了**(`src/host/auth.ts:489`)。上游是按
 *    `private / fork / 其它` 三选一 + `archived` 徽标渲染的
 *    (`group-repositories.ts:32-41`、`cloneable-repository-filter-list.tsx:255`)。
 *    回收条件:宿主载荷补 `fork` / `archived`。
 * 7. **`hidden` 的远端仓库照样列出。** `hidden` 是我们**仓库下拉**的显示偏好
 *    (用户点过「从列表隐藏」),而上游这个页签的语义是「你有权限访问的全部仓库」
 *    —— 因为「在下拉里收起来」不等于「不想克隆它」。
 * 8. **`initialURL` 没接。** 上游有 `initialURL` prop(`:41-42`,`:229-236`),由
 *    「从剪贴板/命令行打开」那条路给值;我们的 `PopupType.CloneRepository`
 *    (`repo-bar.tsx` 的 `showPopup`)不带这个字段,所以没有调用方能提供它。
 *    回收条件:有入口携带初始 URL 时补一个 prop。
 *
 * ## 这个文件**不**负责的
 *
 * 关闭语义(点外面 / Esc / 焦点 trap / 焦点归还)在共享外壳 `PluginDialog`
 * (`./host-modal.tsx`)里 —— 与 Preferences 弹窗同一份实现,由
 * `docs/probes/clone-dialog-dismiss-probe.mjs` 钉着。**不要**把那段逻辑引回本文件。
 *
 * @module dsh-git/client/clone-dialog
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import * as Path from 'path';
import { Icon } from './icons.ts';
import { api } from './api.ts';
import type { RemoteRepo } from './api.ts';
import type { GitStore } from './store.ts';
import { PluginDialog } from './host-modal.tsx';
import { __DARWIN__ } from './desktop-globals.ts';
import { HighlightText } from '../core/desktop/ui/lib/highlight-text.tsx';
import { caseInsensitiveEquals, caseInsensitiveCompare } from '../core/desktop/lib/compare.ts';
import type { ClonePathKind } from '../core/types.ts';
import {
  parseRepositoryIdentifier,
  sanitizeCloneName,
  type IRepositoryIdentifier,
} from '../core/desktop/lib/remote-parsing.ts';

/** 克隆来源页签(上游 `models/clone-repository-tab.ts` 的子集:没有 `Enterprise`)。 */
type CloneTab = 'github' | 'url';

/**
 * 一个页签自己的持久状态 —— 上游 `clone-repository.tsx:113-129` 的 `IBaseTabState`。
 *
 * 上游为**每个页签**各留一份(`dotComTabState` / `enterpriseTabState` / `urlTabState`),
 * 所以「填一半的 URL + 目标路径」在切页签来回之后**还在**。我们也按页签各留一份 ——
 * 共用一份会让 GitHub 页签选中的仓库把 URL 页签手打的地址冲掉(那是改前的形态)。
 */
type UrlTabState = {
  /** 当前错误(上游 `error`,渲染成 `DialogError`)。 */
  readonly error: string | null;
  /** 上一次从 URL 里解析出来的 `owner/name`(路径派生的判据,上游 `:117-120`)。 */
  readonly lastParsedIdentifier: IRepositoryIdentifier | null;
  /** 本地目标路径。 */
  readonly path: string;
  /** 用户输入(或从列表选中带过来的)URL。 */
  readonly url: string;
};

/** GitHub 页签的状态 —— 上游 `IGitHubTabState`(`:138-152`)。 */
type GitHubTabState = UrlTabState & {
  /** 过滤框内容(上游 `filterText`)。 */
  readonly filterText: string;
  /** 当前选中的仓库(上游存 `IAPIRepository`,我们按 `fullName` 认身份)。 */
  readonly selectedItem: string | null;
};

/**
 * 上游 `ui/lib/default-dir.ts:4` 的键名 —— **逐字沿用**。
 * 同一个浏览器里两边读写同一个值(这样「上次克隆到哪儿」不会因为我们换实现而丢)。
 */
const CLONE_LOCATION_KEY = 'last-clone-location';

/** 「你的仓库」这一组的标识(上游 `group-repositories.ts:10` 的 `YourRepositoriesIdentifier`)。 */
const YOUR_REPOSITORIES = 'your-repositories';

/**
 * 上游 `clone-repository.tsx:686-733` 四句错误文案的中文对应。
 *
 * 每一句的**条件**都是上游的(不是我们另立的);英文原句写在旁边,免得以后回译漂移。
 */
const PATH_MESSAGE_NON_EMPTY =
  '这个文件夹里已经有文件了。git 只能克隆到空文件夹。'; // 'This folder contains files. Git can only clone to empty folders.'
const PATH_MESSAGE_NOT_A_DIRECTORY =
  '这里已经有一个同名的文件了。git 只能克隆到文件夹里。'; // 'There is already a file with this name. Git can only clone to a folder.'
const PATH_MESSAGE_UNREADABLE =
  '读不到这个路径。请检查路径后重试。'; // 'Unable to read path on disk. Please check the path and try again.'
const PATH_MESSAGE_DARWIN_APP =
  '在 macOS 上,本地路径不能以 .app 结尾。请换一个文件夹名,避免把克隆结果变成一个应用包。'; // 'The local path cannot end in .app on macOS. …'
/** 上游 `:776-780`(按下 Clone 之后才发现 path 为空时那一句)。 */
const MESSAGE_DIRECTORY_NOT_CREATED =
  '没法在这个路径上创建目录。'; // 'Directory could not be created at this path.'

/**
 * 一个人可读的输入框默认值。
 *
 * 顺序(每一档的理由见文件头「偏离 3」):
 *  1. `localStorage['last-clone-location']`(与上游同一个键);
 *  2. `dirname(当前仓库)` —— 宿主能告诉我们的、语义最接近「你平时把仓库放哪儿」的东西;
 *  3. `''`(问不出来就留空,与改前一致:由用户填或点 `Choose…`)。
 * @param store - 客户端 store(读当前仓库路径)。
 * @returns 目标路径的初始值。
 */
function defaultCloneDir(store: GitStore): string {
  try {
    const remembered = window.localStorage.getItem(CLONE_LOCATION_KEY);
    if (remembered !== null && remembered !== '') {
      return remembered;
    }
  } catch {
    // 隐私模式 / 沙箱里 localStorage 可能直接抛:记住位置是**尽力而为**,不该拖垮弹窗。
  }
  const current = store.snapshot().current;
  return current === undefined || current === '' ? '' : Path.dirname(current);
}

/** 把「上次克隆到哪儿」记下来(上游 `clone-repository.tsx:816` 的 `setDefaultDir`)。 */
function rememberCloneDir(dir: string): void {
  try {
    window.localStorage.setItem(CLONE_LOCATION_KEY, dir);
  } catch {
    // 同上:写不进去不影响这一次克隆已经成功的事实。
  }
}

/**
 * 把宿主给的分类译成用户看到的那句话。
 * @param kind - `clone/validate-path` 的分类。
 * @returns 错误文案;`null` 表示这个路径可以克隆。
 */
function clonePathMessage(kind: ClonePathKind): string | null {
  switch (kind) {
    case 'absent':
    case 'empty':
      return null;
    case 'non-empty':
      return PATH_MESSAGE_NON_EMPTY;
    case 'not-a-directory':
      return PATH_MESSAGE_NOT_A_DIRECTORY;
    case 'unreadable':
      return PATH_MESSAGE_UNREADABLE;
  }
}

/**
 * 从仓库全名造克隆地址。
 *
 * ⚠️ 上游用的是 GitHub API 回的 `clone_url`(`group-repositories.ts:48`),而且会经
 * `resolveCloneInfo()`(`clone-repository.tsx:740-761`)按用户偏好解析成 SSH —— 我们的
 * `remote-repos` 载荷**没有** `clone_url`(只有 `fullName`),所以这里按 github.com 的
 * 惯例拼。回收条件:宿主载荷补 `clone_url`(顺带能让企业端点也正确)。
 * @param fullName - `owner/name`。
 * @returns https 形式的克隆地址。
 */
function cloneUrlOf(fullName: string): string {
  return `https://github.com/${fullName}.git`;
}

/**
 * 过滤框命中的**字符下标**(喂给镜像的 `HighlightText`,它要的是下标数组)。
 *
 * 上游的命中来自 `FilterList` 的模糊匹配(`ui/lib/fuzzy-find.ts`);我们退化成
 * **大小写不敏感的子串**匹配 —— 差别是「`chr` 能匹配 `chore`」这种首字母缩写不再命中。
 * 回收条件:把模糊匹配器接上(它会同时改这里的**筛选**与**高亮**,两处必须同一判据)。
 * @param text - 行的显示文本(`owner/name`)。
 * @param query - 过滤框内容。
 * @returns 命中的下标;查询为空时返回空数组。
 */
function matchedIndices(text: string, query: string): number[] {
  if (query === '') {
    return [];
  }
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) {
    return [];
  }
  return Array.from({ length: query.length }, (_, i) => at + i);
}

/** 分组:一组仓库 + 它的组头(上游 `ifilter-list` 的 `IFilterListGroup` 的最小形状)。 */
type RepoGroup = {
  readonly identifier: string;
  readonly items: RemoteRepo[];
};

/**
 * 按 owner 分组,「你的仓库」永远第一 —— 上游 `group-repositories.ts:55-76`。
 *
 * 上游用 lodash 的 `groupBy` / `entries`,并以 `caseInsensitiveEquals(owner.login, login)`
 * 判定「是不是你自己的」(那个登录名来自 API 账号对象)。我们的 `remote-repos` 只回
 * `fullName`,`owner` 就是它 `/` 之前那一段 —— 判据相同,**不引入新依赖**
 * (lodash 不在本仓,`require-family` 不变式也不允许新增 npm 依赖)。
 * @param repositories - 远端仓库清单。
 * @param login - 当前登录名(空串表示不知道)。
 * @returns 分组后的清单(组内按名字排序,「你的仓库」在最前)。
 */
function groupRepositories(repositories: readonly RemoteRepo[], login: string): RepoGroup[] {
  const byOwner = new Map<string, RemoteRepo[]>();
  for (const repo of repositories) {
    const owner = repo.fullName.split('/')[0] ?? '';
    const identifier =
      login !== '' && caseInsensitiveEquals(owner, login) ? YOUR_REPOSITORIES : owner;
    const list = byOwner.get(identifier);
    if (list === undefined) {
      byOwner.set(identifier, [repo]);
    } else {
      list.push(repo);
    }
  }
  return Array.from(byOwner.entries())
    .map(([identifier, items]) => ({
      identifier,
      // 上游 `:53` 按 `compare(x.name, y.name)` 排序(名字 = `fullName` 的最后一段)。
      items: [...items].sort((x, y) => caseInsensitiveCompare(nameOfRepo(x), nameOfRepo(y))),
    }))
    .sort((x, y) => {
      // 上游 `:67-75`:`YourRepositoriesIdentifier` 恒排第一,其余按标识符比。
      if (x.identifier === YOUR_REPOSITORIES) {
        return -1;
      }
      if (y.identifier === YOUR_REPOSITORIES) {
        return 1;
      }
      return x.identifier.localeCompare(y.identifier);
    });
}

/** 仓库名(`owner/name` 的最后一段;上游 `group-repositories.ts:50` 的 `repo.name`)。 */
function nameOfRepo(repo: RemoteRepo): string {
  return repo.fullName.split('/').pop() ?? repo.fullName;
}

export function CloneDialog(props: {
  store: GitStore;
  onClose: () => void;
  /**
   * 未登录时那条引导的落点(上游 `:549-555` 的 `signInDotCom` 会弹登录对话框)。
   *
   * 可选:没有调用方提供时**不渲染那颗按钮**(而不是渲染一颗点了没反应的按钮)。
   */
  onOpenSettings?: () => void;
}): ReactNode {
  const { store } = props;
  const [tab, setTab] = useState<CloneTab>('url');
  /*
   * 默认目标目录**同步**取(上游是 `initializePath()` 里的 `await getDefaultDir()`)。
   * 差别只是上游在 await 那一小段里 `path` 还是 `null`(Clone 因此禁着),我们是立刻就位
   * —— 用户可见的结果相同(两种情况按钮都不可点),少一次状态跳变。
   */
  const [initialPath] = useState<string>(() => defaultCloneDir(store));
  const [urlTab, setUrlTab] = useState<UrlTabState>(() => ({
    error: null,
    lastParsedIdentifier: null,
    path: initialPath,
    url: '',
  }));
  const [githubTab, setGithubTab] = useState<GitHubTabState>(() => ({
    error: null,
    lastParsedIdentifier: null,
    path: initialPath,
    url: '',
    filterText: '',
    selectedItem: null,
  }));
  const [loading, setLoading] = useState(false);
  /** GitHub 页签是否已经发起过拉取(用来把「还没开始」与「拉完是空」分开,见 `renderNoItems`)。 */
  const [remoteRequested, setRemoteRequested] = useState(false);

  /*
   * 两个页签的**最新值**放在 ref 里,有两个用途(都不能用 state 顶替):
   *  1. 改 path 之后要立刻校验,而 `validateTab` 是 `await` 过的 —— 落盘前要拿**当前**值
   *     比一次(上游 `:584-589` 的竞态守卫:「只在这个 path 期间没变过时才落盘」);
   *  2. 窗口 focus / 切页签那两个 effect 里要读最新值,而它们的依赖表刻意只有
   *     `[tab, validateTab]`(把 state 列进去会变成「改一次校验一次 → 改状态 → 再校验」的环)。
   */
  const tabStatesRef = useRef({ url: urlTab, github: githubTab });
  const tabRef = useRef<CloneTab>(tab);
  useEffect(() => {
    tabRef.current = tab;
  }, [tab]);

  const snap = store.snapshot();
  const signedIn = snap.auth?.signedIn === true;
  const login = snap.auth?.login ?? '';

  /** 写当前页签的**基础**字段(两个页签都有的那四个),并同步更新 ref。 */
  const applyUrlTab = useCallback((patch: Partial<UrlTabState>): UrlTabState => {
    const merged = { ...tabStatesRef.current.url, ...patch };
    tabStatesRef.current.url = merged;
    setUrlTab(merged);
    return merged;
  }, []);

  const applyGithubTab = useCallback((patch: Partial<GitHubTabState>): GitHubTabState => {
    const merged = { ...tabStatesRef.current.github, ...patch };
    tabStatesRef.current.github = merged;
    setGithubTab(merged);
    return merged;
  }, []);

  const applyBase = useCallback(
    (which: CloneTab, patch: Partial<UrlTabState>): UrlTabState =>
      which === 'url' ? applyUrlTab(patch) : applyGithubTab(patch),
    [applyUrlTab, applyGithubTab],
  );

  /**
   * 落一条错误到指定页签(上游 `setSelectedTabState({ error })`,不过是按页签派发)。
   * @param which - 页签。
   * @param error - 错误文案;`null` 表示清除。
   */
  const applyError = useCallback(
    (which: CloneTab, error: string | null): void => {
      if (which === 'url') {
        applyUrlTab({ error });
      } else {
        applyGithubTab({ error });
      }
    },
    [applyUrlTab, applyGithubTab],
  );

  /**
   * 上游 `:687-733` 的 `validateClonePath()`。
   *
   * 两段:**`.app` 是纯字符串判断**(上游 `:694-701`,留在客户端),其余交给宿主
   * (`clone/validate-path` —— 浏览器半没有 `readdir`)。
   * @param path - 目标路径。
   * @returns 错误文案;`null` 表示可以克隆。
   */
  const validateClonePath = useCallback(async (path: string): Promise<string | null> => {
    if (path === '') {
      // 上游 `:688-692` 的 `path === null` 一档(我们这边空串就是「还没定」)。
      return PATH_MESSAGE_UNREADABLE;
    }
    if (__DARWIN__ && Path.basename(Path.resolve(path)).toLowerCase().endsWith('.app')) {
      return PATH_MESSAGE_DARWIN_APP;
    }
    const result = await api.cloneValidatePath(path);
    if (!result.ok) {
      /*
       * **拿不到宿主的答案 ⇒ 放行(不报错、不禁用按钮)。**
       *
       * 这一条分辨的是「**宿主给了一个确定的答案**」与「**根本没拿到答案**」:
       *  - 确定的答案是 `kind`(下面 `clonePathMessage` 那五档),其中包括 `'unreadable'`
       *    —— 那是宿主真的试过 `stat`/`readdir` 并失败了,**照样报错 + 禁用**(与
       *    `git-service.ts` 把未知 errno 折成 `'unreadable'` 同向);
       *  - 拿不到答案的情况有两类,而它们都必须放行:
       *    ① **宿主还没重启**(`src/host/**` 是 Node 模块,新路由要重启才在)——旧宿主对
       *       这条路由回 404/非 JSON ⇒ 若在这里报错并禁用,弹窗会**永久不可用**
       *       (用户看到「读不到这个路径」,而其实什么都还没试过);
       *    ② 传输层抖动(一次请求失败)。
       * 放行的代价只是回到改前的行为:git 自己会因为非空目录失败,那句话在
       * `detail` 里(见上面 `cloneRepository` 的失败分支)。**这比「界面锁死」好。**
       */
      return null;
    }
    return clonePathMessage(result.value.kind);
  }, []);

  /**
   * 上游 `:570-591` 的 `validatePath()`(针对**某一个**页签的状态跑一次)。
   * @param which - 页签。
   * @param candidate - 要校验的那一份状态(调用方刚算出来的新值)。
   */
  const validateTab = useCallback(
    async (which: CloneTab, candidate: UrlTabState): Promise<void> => {
      const isDefaultPath = initialPath === candidate.path;
      const isURLNotEntered = candidate.url === '';
      if (isDefaultPath && isURLNotEntered) {
        // 上游 `:577-580`:默认路径 + URL 还空着 ⇒ 只清错误,不去问磁盘。
        if (candidate.error !== null) {
          applyError(which, null);
        }
        return;
      }
      const error = await validateClonePath(candidate.path);
      // 竞态守卫(上游 `:584-589`):await 期间 path 变过就丢弃这一次结果。
      const latest = which === 'url' ? tabStatesRef.current.url : tabStatesRef.current.github;
      if (latest.path !== candidate.path) {
        return;
      }
      applyError(which, error);
    },
    [applyError, initialPath, validateClonePath],
  );

  /** 读某个页签的最新状态(两处 effect 与几个 handler 共用)。 */
  const stateOf = useCallback(
    (which: CloneTab): UrlTabState =>
      which === 'url' ? tabStatesRef.current.url : tabStatesRef.current.github,
    [],
  );

  /*
   * 挂载 + 切页签各校验一次 —— 上游 `componentDidMount`(`:229-236`)与
   * `componentDidUpdate` 的 `selectedTab` 分支(`:218-220`)。
   * ⚠️ 依赖表刻意**不含** state:含了就会变成「校验 → 落 error → state 变 → 再校验」的环。
   */
  useEffect(() => {
    void validateTab(tab, stateOf(tab));
  }, [stateOf, tab, validateTab]);

  /*
   * 窗口重新获得焦点时再校验 —— 上游 `:159-167` 的 `isTopMostDialog` + `:819-824`。
   * 理由(上游原话):用户可能在别的程序里把那个目录建出来 / 塞满 / 删掉。
   * 我们只有一个弹窗层,所以「是不是最上层」恒为真,不再有那一层判定。
   */
  useEffect(() => {
    const onWindowFocus = (): void => {
      const which = tabRef.current;
      void validateTab(which, stateOf(which));
    };
    window.addEventListener('focus', onWindowFocus);
    return () => {
      window.removeEventListener('focus', onWindowFocus);
    };
  }, [stateOf, validateTab]);

  /*
   * 进 GitHub 页签就拉一次清单(上游 `cloneable-repository-filter-list.tsx:141-154`:
   * 挂载时 `repositories === null` 就 `refreshRepositories()`)。
   * `store` 由 `src/client/index.ts` 的 `storeFor()` 按 session 记忆化(身份恒定),
   * 所以列进依赖不会造成重跑,而是把「这个 effect 依赖什么」写实。
   */
  useEffect(() => {
    if (tab !== 'github') {
      return;
    }
    setRemoteRequested(true);
    void store.loadRemoteRepos();
  }, [store, tab]);

  /**
   * 上游 `:648-684` 的 `updateUrl()` —— **URL 变一次就重算目标路径**。
   *
   * 三种分岔逐条照抄(注意判据用的是**上一次**解析出来的标识符,不是这一次的):
   *  - 之前解析到过标识符 ⇒ 把路径的**最后一段换掉**(用户是在改仓库名);
   *  - 之前没有、这次有 ⇒ 把新名字**拼**到当前目录后面;
   *  - 都没有 ⇒ 只更新 URL。
   * @param which - 页签。
   * @param nextUrl - 新的 URL / `owner/name`。
   */
  const updateUrl = useCallback(
    (which: CloneTab, nextUrl: string): void => {
      const state = stateOf(which);
      const parsed = parseRepositoryIdentifier(nextUrl);
      if (state.path === '') {
        // 上游 `:653-657`:目标路径还不知道 ⇒ 只更新 URL(派生无从谈起)。
        const merged = applyBase(which, { url: nextUrl });
        void validateTab(which, merged);
        return;
      }
      const safeName = parsed === null ? null : sanitizeCloneName(parsed.name);
      const dirPath = state.path;
      let nextPath: string;
      if (state.lastParsedIdentifier !== null) {
        nextPath = safeName !== null ? Path.join(Path.dirname(dirPath), safeName) : Path.dirname(dirPath);
      } else if (safeName !== null) {
        nextPath = Path.join(dirPath, safeName);
      } else {
        nextPath = dirPath;
      }
      const merged = applyBase(which, {
        url: nextUrl,
        lastParsedIdentifier: parsed,
        path: nextPath,
      });
      void validateTab(which, merged);
    },
    [applyBase, stateOf, validateTab],
  );

  /**
   * 上游 `:593-646` 的 `onChooseDirectory()` —— 选目录,然后(非 macOS 那一支)
   * 把仓库名拼上去。
   *
   * 目录选择**必须**走 store(`store.pickCloneDirectory()`):它先试客户端原生弹窗
   * (`uiWorkspace.pickDirectory`)、再回落到宿主路由,而两条通道的可用性不同 ——
   * 改前这里直接 `api.pickDirectory()`,宿主没有那个可选服务时点「Choose…」**毫无反应**。
   */
  const chooseDirectory = useCallback((): void => {
    void (async (): Promise<void> => {
      const which = tabRef.current;
      const chosen = await store.pickCloneDirectory();
      if (chosen === null) {
        // 用户取消(或两条通道都不可用,那条路 store 已经给了可读 toast)⇒ 什么都不做。
        return;
      }
      const state = stateOf(which);
      const parsed = state.lastParsedIdentifier;
      const safeName = parsed === null ? null : sanitizeCloneName(parsed.name);
      const directory = safeName !== null ? Path.join(chosen, safeName) : chosen;
      const merged = applyBase(which, { path: directory, error: null });
      await validateTab(which, merged);
    })();
  }, [applyBase, stateOf, store, validateTab]);

  /*
   * 下面这几个事件处理器刻意用 `useCallback` 包起来(而不是 `const f = () => …` 或
   * `function f() {}`):本仓的 `react/jsx-no-bind` 会把**两种**声明形式的函数名记进它自己的
   * 变量表(报的文案分别是「arrow functions」与「functions」),于是任何 `onClick={f}`
   * 都会被判违规 —— 实测 10 处全中。`useCallback(...)` 的初值是 CallExpression,不进那张表。
   */
  /** 本地路径输入框:与上游 `onPathChanged`(`:338-340`)同 —— 改了就重新校验。 */
  const onPathInput = useCallback((event: { target: { value: string } }): void => {
    const which = tabRef.current;
    const merged = applyBase(which, { path: event.target.value });
    void validateTab(which, merged);
  }, [applyBase, validateTab]);

  /** URL 输入框 —— 走 `updateUrl`(顺带派生目标路径),与上游 `:353` 同一入口。 */
  const onUrlInput = useCallback((event: { target: { value: string } }): void => {
    updateUrl('url', event.target.value);
  }, [updateUrl]);

  /** 过滤框 —— 上游 `:557-561` 的 `onFilterTextChanged`。 */
  const onFilterInput = useCallback((event: { target: { value: string } }): void => {
    applyGithubTab({ filterText: event.target.value });
  }, [applyGithubTab]);

  /** 页签切换 —— 上游 `:334-336`。切回来时那个页签自己的 URL / 路径 / 错误都还在。 */
  const onGitHubTabClick = useCallback((): void => {
    setTab('github');
    applyGithubTab({ error: null });
  }, [applyGithubTab]);
  const onUrlTabClick = useCallback((): void => {
    setTab('url');
    applyUrlTab({ error: null });
  }, [applyUrlTab]);

  /** 手动刷新远端清单(上游 `renderPostFilter` 那颗刷新按钮)。 */
  const onRefreshRepositories = useCallback((): void => {
    setRemoteRequested(true);
    void store.loadRemoteRepos(true);
  }, [store]);

  /** 未登录那条引导的落点(上游 `:549-555` 的 `signInDotCom`)。 */
  const onSignInClick = useCallback((): void => {
    if (props.onOpenSettings !== undefined) {
      props.onOpenSettings();
    }
  }, [props]);

  const repositories = snap.remoteRepos;
  const filterText = githubTab.filterText;
  const groups = useMemo(() => {
    const query = filterText.trim();
    const hit =
      query === ''
        ? repositories
        : repositories.filter((repo) => matchedIndices(repo.fullName, query).length > 0);
    return groupRepositories(hit, login);
  }, [filterText, login, repositories]);

  /** 选中一个仓库 ⇒ 填 URL(上游 `:563-568` 的 `onSelectionChanged`)。 */
  const onSelectRepository = useCallback(
    (fullName: string): void => {
      applyGithubTab({ selectedItem: fullName });
      updateUrl('github', cloneUrlOf(fullName));
    },
    [applyGithubTab, updateUrl],
  );

  /** 行被点击 / 键盘激活:上游把两种来源分成 `ClickSource`(`:763-769` + `:197-212`)。 */
  const onRowClick = useCallback(
    (fullName: string): void => {
      onSelectRepository(fullName);
    },
    [onSelectRepository],
  );

  /**
   * 本页签当前该不该禁用 Clone —— 上游 `:301-314` 的 `checkIfCloningDisabled()`,逐字同条件。
   *
   * ⚠️ 上游用的是 `url.length === 0`(**不 trim**),所以「只有空白字符的 URL」在两边都是
   * 「可点」。这是上游的行为,不是我们的判断 —— 照抄,免得「我们比上游多一条规则」。
   */
  const currentState = tab === 'url' ? urlTab : githubTab;
  const cloneDisabled =
    currentState.url.length === 0 ||
    currentState.path.length === 0 ||
    loading ||
    currentState.error !== null;

  /**
   * 上游 `:771-810` 的 `clone()`。
   *
   * 顺序逐条对齐:先再校验一次目标路径(上游 `:783-788`)、再调宿主、成功则记住目录并关闭。
   */
  const cloneRepository = useCallback((): void => {
    void (async (): Promise<void> => {
      setLoading(true);
      const which = tabRef.current;
      const state = stateOf(which);
      if (state.path === '') {
        // 上游 `:776-780`。
        applyError(which, MESSAGE_DIRECTORY_NOT_CREATED);
        setLoading(false);
        return;
      }
      const pathError = await validateClonePath(state.path);
      if (pathError !== null) {
        // 上游 `:783-788`:按下之后再验一次(上一次校验之后磁盘可能变了)。
        applyError(which, pathError);
        setLoading(false);
        return;
      }
      const result = await api.clone(state.url.trim(), state.path);
      setLoading(false);
      if (!result.ok) {
        /*
         * 上游把克隆失败交给 app 级错误横幅(它 `clone()` 之后就 `onDismissed()`,弹窗
         * 早关了)。我们是「请求在飞、弹窗还开着」的模型,所以就地显示 —— 而且**多显示
         * `detail`**(宿主把 git 的 stderr 放在那里,只显示 message 会丢掉原因,见文件头「偏离 5」)。
         */
        const detail = result.error.detail;
        applyError(
          which,
          detail === undefined || detail === '' ? result.error.message : `${result.error.message}\n${detail}`,
        );
        return;
      }
      // 上游 `:812-817` 的 `setDefaultDir(Path.resolve(path, '..'))`。
      rememberCloneDir(Path.resolve(state.path, '..'));
      store.toast(`已克隆到 ${result.value.root}`);
      props.onClose();
      await store.refreshRepos();
    })();
  }, [applyError, props, stateOf, store, validateClonePath]);

  /** footer 那颗 Clone 按钮。 */
  const onCloneClick = useCallback((): void => {
    cloneRepository();
  }, [cloneRepository]);

  /**
   * 上游 `:763-769` 的 `onItemClicked` 键盘分支 + `:197-212` 的 `onItemClick`。
   *
   * 上游的 `ClickSource` 区分指针与键盘;我们按同一判据分:**Enter** 在「可以克隆」时
   * 直接开克隆(`:764-768`),**空格**只选中(`:197-212` 的选中语义)。
   * @param fullName - 行对应的仓库。
   * @param key - 按键名。
   */
  const onRowKeyDown = useCallback(
    (fullName: string, key: string): void => {
      if (key === 'Enter') {
        onSelectRepository(fullName);
        if (!cloneDisabled) {
          cloneRepository();
        }
        return;
      }
      if (key === ' ') {
        onSelectRepository(fullName);
      }
    },
    [cloneDisabled, cloneRepository, onSelectRepository],
  );

  /** Cancel —— 上游 `OkCancelButtonGroup` 的取消(`onDismissed`)。 */
  const onCancelClick = useCallback((): void => {
    props.onClose();
  }, [props]);

  /**
   * 空态三档 —— 上游 `cloneable-repository-filter-list.tsx:278-310` 的 `renderNoItems()`。
   *
   * 上游按 `loading` / `filterText.length !== 0` / 其余 三档分别给三句话,我们逐档对应;
   * `data-gw-clone-empty` 把「当前是哪一档」变成机器可读读数(探针按它判)。
   */
  function renderNoItems(): ReactNode {
    const loadingRepos = snap.remoteReposLoading || !remoteRequested;
    if (loadingRepos && repositories.length === 0) {
      return (
        <div className="gw-hint" data-gw-clone-empty="loading">
          正在从 GitHub 读取你的仓库…
        </div>
      );
    }
    if (filterText.length !== 0) {
      return (
        <div className="gw-hint" data-gw-clone-empty="no-results">
          找不到匹配 “{filterText}” 的仓库。
        </div>
      );
    }
    return (
      <div className="gw-hint" data-gw-clone-empty="none">
        看起来 @{login} 在 GitHub 上还没有仓库。如果刚刚新建了仓库,
        <button className="gw-link" onClick={onRefreshRepositories}>刷新这个列表</button>。
      </div>
    );
  }

  /**
   * GitHub 页签未登录时的引导 —— 上游 `:519-547` 的 `renderSignIn()`。
   *
   * 上游那颗按钮弹的是登录对话框;我们的登录页在偏好设置里,由 `onOpenSettings` 提供。
   */
  function renderSignIn(): ReactNode {
    return (
      <div className="gw-hint" data-gw-clone-signin="">
        登录你的 GitHub 账号后,这里会列出你有权限访问的仓库。
        {props.onOpenSettings !== undefined && (
          <div style={{ marginTop: 8 }}>
            <button className="gw-btn primary" onClick={onSignInClick}>登录</button>
          </div>
        )}
      </div>
    );
  }

  /** GitHub 页签的仓库列表(上游 `CloneableRepositoryFilterList`)。 */
  function renderGitHubTab(): ReactNode {
    return (
    <>
      <div className="gw-field">
        <input
          className="gw-input"
          placeholder="过滤你的仓库"
          aria-label="过滤你的仓库"
          value={filterText}
          onChange={onFilterInput}
        />
        {/*
          * 上游 `renderPostFilter`(`:260-276`):一颗刷新按钮、loading 时 disabled 且图标转。
          * 文案是上游的 `ariaLabel` / `tooltip`:'Refresh the list of repositories'。
          */}
        <button
          className="gw-btn"
          data-gw-clone-refresh=""
          disabled={snap.remoteReposLoading}
          onClick={onRefreshRepositories}
          title="刷新仓库清单"
          aria-label="刷新仓库清单"
        >
          <Icon name="sync" size={12} className={snap.remoteReposLoading ? 'gw-spin' : undefined} />
        </button>
      </div>
      {groups.length === 0 ? renderNoItems() : (
        <div className="gw-clone-list" role="listbox" aria-label="仓库">
          {groups.map((group) => (
            <div key={group.identifier} data-gw-clone-group={group.identifier}>
              <div className="gw-hint" data-gw-clone-group-header={group.identifier}>
                {group.identifier === YOUR_REPOSITORIES ? '你的仓库' : group.identifier}
              </div>
              {group.items.map((repo) => (
                <CloneRepoRow
                  key={repo.fullName}
                  repo={repo}
                  selected={githubTab.selectedItem === repo.fullName}
                  highlight={matchedIndices(repo.fullName, filterText.trim())}
                  onRowClick={onRowClick}
                  onRowKeyDown={onRowKeyDown}
                />
              ))}
            </div>
          ))}
        </div>
      )}
      {renderLocalPathField()}
    </>
    );
  }

  /**
   * Local Path 行 —— 上游**两个页签都有**它
   * (`clone-generic-repository.tsx:52-60` 与 `clone-github-repository.tsx:120-128`)。
   *
   * ⚠️ 改前 GitHub 页签上**没有**这一行 ⇒ 从列表里选完仓库之后没有地方设目标路径,
   * 只能切回 URL 页签 —— 那是这条弹窗与上游差距里最容易被用户撞到的一条。
   */
  function renderLocalPathField(): ReactNode {
    return (
      <div className="gw-field">
        <label htmlFor="gw-clone-path">Local path</label>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            id="gw-clone-path"
            className="gw-input"
            style={{ flex: 1 }}
            placeholder="repository path"
            value={currentState.path}
            onChange={onPathInput}
          />
          <button className="gw-btn" onClick={chooseDirectory}>Choose…</button>
        </div>
      </div>
    );
  }

  return (
    /*
     * 卡片类名 `gw-clone` 与可达名字 `aria-labelledby="gw-clone-title"` 是**探针契约**
     * (`docs/probes/clone-dialog-dismiss-probe.mjs` 的 A1-A6 组),不要改。
     * 标题也保持上游非 macOS 那一支的原文('Clone a repository')。
     */
    <PluginDialog className="gw-clone" labelledBy="gw-clone-title" onClose={props.onClose}>
      <h4 id="gw-clone-title">Clone a repository</h4>

      {/* 上游 `:273-280` 的 TabBar(GitHub.com / GitHub Enterprise / URL);我们不做 Enterprise。 */}
      <div className="gw-clone-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === 'github'}
          className={`gw-clone-tab${tab === 'github' ? ' on' : ''}`}
          onClick={onGitHubTabClick}
        >
          <Icon name="git-branch" size={12} /> GitHub
        </button>
        <button
          role="tab"
          aria-selected={tab === 'url'}
          className={`gw-clone-tab${tab === 'url' ? ' on' : ''}`}
          onClick={onUrlTabClick}
        >
          <Icon name="external-link" size={12} /> URL
        </button>
      </div>

      {/*
        * 上游 `:282` 的 `DialogError` —— 错误**跨两个页签共用一个位置**,但内容取自
        * **当前页签**自己的 state(切页签会换成那个页签的错误/无错误)。
        * `detail` 是 git 的原话,放进 `<p class="gw-dialog-code">`(styles.ts:273 有规则)。
        */}
      {currentState.error !== null && (
        <div className="gw-errbox" data-gw-clone-error="">
          <p className="gw-dialog-code">{currentState.error}</p>
        </div>
      )}

      <div role="tabpanel" className="gw-dialog-body">
        {tab === 'url' ? (
          <>
            <div className="gw-field">
              <label htmlFor="gw-clone-url">
                Repository URL or GitHub username and repository
                <span className="gw-hint" style={{ padding: '0 0 0 4px' }}>(hubot/cool-repo)</span>
              </label>
              <input
                id="gw-clone-url"
                className="gw-input"
                autoFocus={true}
                placeholder="URL or username/repository"
                value={urlTab.url}
                onChange={onUrlInput}
              />
            </div>
            {renderLocalPathField()}
          </>
        ) : signedIn ? (
          renderGitHubTab()
        ) : (
          renderSignIn()
        )}
      </div>

      {/*
        * 上游 `:316-332` 的 `renderFooter()`:非 URL 页签且那个页签没有账号 ⇒
        * **整个 footer 都不渲染**(不是「渲染一颗禁用的 Clone」)。
        */}
      {(tab === 'url' || signedIn) && (
        <div className="gw-dialog-actions">
          <button className="gw-btn" onClick={onCancelClick}>Cancel</button>
          <button className="gw-btn primary" disabled={cloneDisabled} onClick={onCloneClick}>
            {loading ? 'Cloning…' : 'Clone'}
          </button>
        </div>
      )}
    </PluginDialog>
  );
}

/**
 * 仓库列表的一行 —— 上游 `cloneable-repository-filter-list.tsx:240-258` 的 `renderItem`。
 *
 * 上游那三样(图标 / 高亮的 `owner/name` / `Archived` 徽标)里,我们只能给前两样:
 * 宿主的载荷没有 `fork` / `archived`(见文件头「偏离 6」)。
 *
 * 单独一个组件而不是内联进 map,是为了让 `onClick` / `onKeyDown` 都是**具名**处理器
 * (本仓 `react/jsx-no-bind` 连行内箭头都拦)。
 */
function CloneRepoRow(props: {
  repo: RemoteRepo;
  selected: boolean;
  highlight: number[];
  onRowClick: (fullName: string) => void;
  onRowKeyDown: (fullName: string, key: string) => void;
}): ReactNode {
  const { repo } = props;
  const { onRowClick, onRowKeyDown } = props;
  // 同样用 `useCallback` 而不是箭头常量/函数声明 —— 理由见主组件里那段注释(`react/jsx-no-bind`)。
  const onClick = useCallback((): void => {
    onRowClick(repo.fullName);
  }, [onRowClick, repo.fullName]);
  const onKeyDown = useCallback((event: { key: string }): void => {
    onRowKeyDown(repo.fullName, event.key);
  }, [onRowKeyDown, repo.fullName]);
  return (
    <div
      role="option"
      aria-selected={props.selected}
      tabIndex={0}
      data-gw-clone-repo={repo.fullName}
      className={`gw-pitem${props.selected ? ' cur' : ''}`}
      onClick={onClick}
      onKeyDown={onKeyDown}
      title={repo.description ?? repo.fullName}
    >
      {/* 上游 `group-repositories.ts:32-41` 的 `getIcon`:private ⇒ 锁,否则仓库图标。 */}
      <Icon name={repo.isPrivate ? 'lock' : 'git-branch'} size={11} />
      <span className="grow">
        <HighlightText text={repo.fullName} highlight={props.highlight} />
      </span>
      <span className="tail">{repo.pushedAt.slice(0, 10)}</span>
    </div>
  );
}
