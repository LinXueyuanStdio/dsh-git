/**
 * **仓库设置弹窗**(对应 GitHub Desktop 的 Repository Settings)。
 *
 * 上游:`references/desktop/app/src/ui/repository-settings/**`(8 文件 / 730 行),
 * 外壳是 `repository-settings.tsx`(438 行)。本文件此前**整支缺席** ——
 * `docs/unported-master-ledger.md` §3.8 与 §4 把 `ui/repository-settings/**`
 * 登记为「有意排除 (d)」,而用户 2026-10 明确要求把它做出来 ⇒ 这条登记**就此翻转**
 * (翻转记录写在本节末尾,别按旧版读那份台账)。
 *
 * ---
 *
 * ## 一、四个页签:上游有什么、我们渲染什么(逐条,带 file:line)
 *
 * | # | 上游页签 | 上游 `file:line` | 我们 |
 * |---|---|---|---|
 * | 0 | `Remote` | `repository-settings.tsx:186-189`(图标 `octicons.server`) | ✅ 渲染。有远端 ⇒ 地址输入框;没有 ⇒ `NoRemote` 那一支 |
 * | 1 | `Ignored Files`(`Ignored files`) | `:190-193`(图标 `octicons.file`) | ✅ 渲染。说明段 + `TextArea`(`git-ignore.tsx:17-35`) |
 * | 2 | `Git Config`(`Git config`) | `:194-197`(图标 `octicons.gitCommit`) | ✅ 渲染。两个单选框 + 姓名/邮箱 |
 * | 3 | `Fork Behavior`(`Fork behavior`) | `:198-203`(图标 `octicons.repoForked`) | ❌ **不渲染,且拿不到输入** —— 见下「三」 |
 *
 * 页签**顺序与下标**与上游 `RepositorySettingsTab` 枚举一致(`:44-49`:
 * `Remote=0, IgnoredFiles, GitConfig, ForkSettings`),这是 TabBar 的
 * `selectedIndex` 语义所要求的。
 *
 * ## 二、保存语义(上游 `onSubmit`,`:292-389`;逐条对照)
 *
 * | 上游写什么 | 条件 | 落点 | 我们 |
 * |---|---|---|---|
 * | `dispatcher.setRemoteURL(repo, name, trimmedUrl)` | `remote` 存在 **且** `trimmedUrl !== props.remote.url` | `git remote set-url` | `store.saveRemoteUrl` ⇒ 宿主 `remote-set-url`(**该路由早已存在**,`routes.ts:1023`;客户端包装此前 0 调用点 —— 本轮补上) |
 * | `dispatcher.saveGitIgnore(repo, ignoreText)` | `ignoreTextHasChanged && ignoreText !== null` | 写/删仓库根 `.gitignore` | `store.saveGitIgnore` ⇒ 宿主 `gitignore/save`(本轮新建) |
 * | `removeConfigValue(repo,'user.name'/'user.email')` | 作用域**从 Local 切到 Global** | `git config --local --unset-all` | `store.saveGitConfig([{unset}])` ⇒ 宿主 `config-unset`(本轮新建;argv 早已在 `git-argv.ts:498`) |
 * | `setConfigValue(repo,'user.name'/'user.email',…)` | 作用域是 Local **且** 与初值不同 | `git config --local --replace-all` | `store.saveGitConfig` ⇒ 既有 `config-set` |
 * | `dispatcher.refreshAuthor(repo)` | 上面任一写发生 | 重读 `git var GIT_AUTHOR_IDENT` | **宿主没有 `repo/author-ident` 路由**(§10.10 待建第 9 项)⇒ 用 {@link GitStore.saveGitConfig} 里的 `gitConfigRevision` 计数器顶替:它只触发**重读 git 配置**,效果同形(见 `store.ts` 那段注释)。**这不是等价物,是替代品**,差异写在「六」 |
 *
 * **上游有、我们刻意不写的三处**:
 *  1. `forkContributionTarget` 的写(`:332-343`,条件是它变了)⇒ 需要
 *     `updateRepositoryWorkflowPreferences`(localStorage 里的 workflow-preferences store),
 *     我们**没有那份状态**,也不渲染那个页签 ⇒ 不可达。
 *  2. 任何**立即写入**:上游这个弹窗里**一个字段都不立即写**(`onRemoteUrlChanged` /
 *     `onIgnoreTextChanged` / `onCommitterNameChanged` 都只 `setState`),全部汇到
 *     `onSubmit`。我们也一样 —— 所以「取消」是真的丢弃修改。
 *  3. 遥测(`incrementMetric`)与 `log.error`;**失败文案的口径照抄**
 *     (`Failed setting the remote URL: ${e}` / `Failed saving the .gitignore file: ${e}`,
 *     `:311`/`:327`,中文化)。
 *
 * ## 三、校验与错误路径(**上游只有三条**,逐条;「remote 已存在」不在这张表里)
 *
 * | # | 上游规则 | 上游 `file:line` | 我们的行为 |
 * |---|---|---|---|
 * | 1 | **作者姓名**:`gitAuthorNameIsValid(name)` 为假 ⇒ `saveDisabled = true` **且**当场把 `Name is invalid, it consists only of disallowed characters.` 推进 `errors` | `:422-433` + `ui/lib/identifier-rules.ts:20-24` | 逐字同一函数(镜像 `ui/lib/identifier-rules.ts` 已在树)、逐字同一句(中文化后见 {@link REPO_SETTINGS_INVALID_AUTHOR_NAME})。**空串算合法**(上游注释写明) |
 * | 2 | **远端地址**:只在 `trim()` 后**与初值不同**时才写;**没有任何 URL 形状校验**(写失败由 git 的退出码变成错误) | `:296-314` | 同。失败 ⇒ `设置远端地址失败:<git message>` |
 * | 3 | **`.gitignore`**:仅在「改过」且「能读到(非 null)」时写;**没有任何语法校验**(它是一个自由文本框) | `:316-329` | 同。失败 ⇒ `保存 .gitignore 失败:<message>`。读失败(符号链接 / EACCES)⇒ 打开弹窗时就把 `无法读取根 .gitignore:<message>` 放进错误区(`:103-109`) |
 *
 * ⚠️ **`error` 的清除时机也是上游行为**:`onSubmit` 开头 `setState({ disabled: true, errors: undefined })`
 * (`:293`)—— 即**每次点保存先把上一次的错误清掉**,只有这次真的又错了才重新出现。
 * 我们照做(`setErrors([])` + `setDisabled(true)`)。
 *
 * ⚠️ **上游没有的两条**(免得下一个人以为漏了):
 *  - **没有「远端已存在」这条错误** —— 那是 `ui/upstream-already-exists/`(fork 场景)
 *    与 `lib/stores/upstream-already-exists-error.ts` 的事,本弹窗**不**碰 remote 的增删,
 *    只改**已有**远端的地址(`state.remote` 为 null 时整页换成 `NoRemote`)。
 *  - **没有邮箱校验**(`:435-437` 只 `setState`)。姓名与邮箱不对称是上游原样,我们不改。
 *
 * ## 四、Ignored Files 页的读写机制(用户点名要的那一节)
 *
 * | 问题 | 上游答案 | 出处 |
 * |---|---|---|
 * | 规则存在**哪里** | **仓库根 `.gitignore`**。`Path.join(repository.path, '.gitignore')` —— **不是** `.git/info/exclude`(上游这一页从不碰它) | `lib/git/gitignore.ts:84`、`:108` |
 * | **怎么读** | `openExistingGitIgnore(path, O_RDONLY)`:先 `lstat` 挡符号链接、`open` 带 `O_NOFOLLOW`、再把 `file.stat()` 与 `lstat` 的 `dev`/`ino` 比对(挡 TOCTOU);**文件不存在 ⇒ `null`**(与「空文件」区分) | `:30-96` |
 * | **怎么改** | 整个文本框**整体写回**(`saveGitIgnore`):`''` ⇒ `unlink`;否则 `truncate(0)` + `writeFile(规整后的文本)` | `:104-135` |
 * | **怎么加一条规则**(文件行右键那条路) | `appendIgnoreRule` = 读全文 → 规整 → 拼 `\n` + 新规则 → 规整 → `saveGitIgnore` | `:138-154` |
 * | **转义** | `appendIgnoreFile` 先过 `escapeGitSpecialCharacters`:`/[[\]!*#?]/g`,命中字符前缀 `\`。**`appendIgnoreRule` 不转义** —— 两条路不能合并 | `:161-184` |
 * | **行尾** | `formatGitIgnoreContents`:按 `core.autocrlf` / `core.safecrlf` 四档规整(含那条看着反直觉的「`false`/`input` ⇒ `\r\n`」)。读的是**合并作用域**(`getConfigValue` 的 `onlyLocal` 默认 false) | `:200-231` |
 * | **一条新规则怎么到达文件列表** | 无「推送」这一步:三个写入口写完都 `return this._refreshRepository(repository)`(`app-store.ts:7774`/`:8042`/`:8050`),而它内部会 `_loadStatus` ⇒ 文件清单重取(而 `.gitignore` 正是 `git status` 的输入) | 同左 |
 *
 * 我们的对应物逐条落在 `src/host/gitignore.ts`(纯文件 I/O,零 git argv,见那个文件头)
 * 与 `GitStore.saveGitIgnore` / `appendGitIgnore`(写后 `refreshStatus()`)。
 *
 * ## 五、上游从哪里打开它(三个入口;我们的入口见「七」)
 *
 * | 入口 | 上游 | 我们 |
 * |---|---|---|
 * | Repository 菜单 ▸ `Repository Settings…`(`id: 'show-repository-settings'`,**没有加速键**) | `main-process/menu/build-default-menu.ts:414-419` → `ui/app.tsx:515` → `showRepositorySettings()`(`:1329-1339`) | ❌ 浏览器半没有应用菜单(§3.6 已登记) |
 * | 提交区的「Committing as / 邮箱」浮层 ▸ `repository settings` 链接 → **Git Config 页** | `ui/changes/commit-message-avatar.tsx:260-263`/`:312-316` → `commit-message.tsx:801-807`(`initialSelectedTab: GitConfig`) | ✅ **本轮接线**:`ChangesView` 的 `onOpenRepositorySettings`(它此前是一条点名缺什么的 toast) |
 * | Create Branch 弹窗 ▸ fork 用途 → **Fork Behavior 页** | `ui/create-branch/create-branch-dialog.tsx:572-575` | ❌ 我们没有 fork 状态(见「三」),那个页签也不渲染 |
 *
 * ## 六、如实边界(不假装)
 *
 * 1. **`Fork Behavior` 页签不渲染,而且不可能渲染**:上游条件是
 *    `isRepositoryWithForkedGitHubRepository(repository)`
 *    (`models/repository.ts`,= `gitHubRepository.parent !== null`)。我们的
 *    `RepoEntry` 只有 `path`/`name`/`remote`(`owner/repo`)/`addedAt`,
 *    **没有 parent**;宿主也没有任何路由供它 ⇒ 这是**状态缺口**,不是「藏了一个控件」。
 *    上游那 100 行(`fork-settings.tsx` 59 + `fork-contribution-target-description.tsx` 41)
 *    因此仍未移植,归因「needs-new-state」。
 * 2. **`NoRemote` 页的 `Publish` 按钮**:上游开 `PopupType.PublishRepository`。
 *    我们没有建库能力(`unsupported-notices.ts` 的 `PUBLISH_REPOSITORY_UNAVAILABLE`
 *    说得比这里细)⇒ 这颗按钮接的是**同一条实话 toast**(与顶栏「发布仓库」按钮
 *    **同一句**、同一个 `store.toast`),不是静默 no-op。
 * 3. **`refreshAuthor` 是替代品不是等价物**:上游读 `git var GIT_AUTHOR_IDENT`
 *    (会做 system 级与 `EMAIL` 环境变量的解析),我们的计数器只触发**重读
 *    `user.name` / `user.email`**。差异面:`EMAIL` 环境变量与 system 级 user.name
 *    这两档我们本来就看不到(`CommitAuthorAvatar` 的文件头已如实写过同一条窄化)。
 * 4. **jsdom 不证几何**:本弹窗的判据跑在 jsdom(`docs/probes/repository-settings-dialog-probe.mjs`),
 *    只证结构 / 行为 / 请求载荷,**不证**观感。
 *
 * ## 七、本轮翻转的台账条目(留痕)
 *
 * - `docs/unported-master-ledger.md` §3.8 / §4 把 `ui/repository-settings/**` 记成
 *   「有意排除 (d)」—— **本轮起不再成立**:三个页签已实现,第四个是状态缺口(needs-new-state)。
 * - `docs/goal-port-desktop.md` §10.10 的待建路由第 8 条(`gitignore/append`)本轮**落地**
 *   (外加读 / 整体写两条);第 9 条 `repo/author-ident` **仍未建**(见「六.3」)。
 * - `src/client/commit-avatar-notices.ts` 的 `REPOSITORY_SETTINGS_UNAVAILABLE`
 *   的回收条件**已满足**(弹窗有渲染分支了)⇒ 该常量在本文件落地后**不可达**,
 *   由它的持有者按那份文件里写的回收条件删除(本轮不动那个文件的所有权边界)。
 *
 * @see src/host/gitignore.ts —— 三条路由的真身
 * @see docs/probes/repository-settings-dialog-probe.mjs —— 判据
 * @module dsh-git/client/repository-settings-dialog
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { TabBarType } from '../core/desktop/ui/tab-bar-type.ts';
import { DialogFooter } from '../core/desktop/ui/dialog/footer.tsx';
import { OkCancelButtonGroup } from '../core/desktop/ui/dialog/ok-cancel-button-group.tsx';
import { Octicon } from '../core/desktop/ui/octicons/index.ts';
import * as octicons from '../core/desktop/ui/octicons/octicons.generated.ts';
import { gitAuthorNameIsValid } from '../core/desktop/ui/lib/identifier-rules.ts';
import { PluginDialog, TabBar, DialogContent } from './host-modal.tsx';
import { api } from './api.ts';
import type { GitError } from '../core/types.ts';
import type { GitStore } from './store.ts';

/**
 * 上游 `InvalidGitAuthorNameMessage`(`ui/lib/identifier-rules.ts:26-27`)的中文化。
 *
 * 为什么要单独一个常量而不是散在 JSX 里:上游那两个消费点(姓名输入的 `onChange`
 * 与错误区)**必须是同一句话**,写两遍必然漂移;而且判据按整句断言。
 */
export const REPO_SETTINGS_INVALID_AUTHOR_NAME =
  '姓名无效:它完全由被 git 禁止的字符组成(至少需要一个有效字符)。';

/** `.gitignore` 说明段里那句链接的目标(上游 `repository-settings.tsx:288-290`)。 */
const GITIGNORE_DOCS_URL = 'https://git-scm.com/docs/gitignore';

/** 上游 `ui/repository-settings/no-remote.tsx:6` 的 HelpURL。 */
const REMOTE_DOCS_URL = 'https://help.github.com/articles/about-remote-repositories/';

/** 页签标识 —— 与上游 `RepositorySettingsTab`(`:44-49`)逐位对应(下标即语义)。 */
export const REPOSITORY_SETTINGS_TABS: ReadonlyArray<{
  id: 'remote' | 'ignored-files' | 'git-config';
  label: string;
  symbol: typeof octicons.server;
  domId: string;
}> = [
  { id: 'remote', label: '远程', symbol: octicons.server, domId: 'gw-rs-tab-remote' },
  { id: 'ignored-files', label: '忽略的文件', symbol: octicons.file, domId: 'gw-rs-tab-ignored-files' },
  { id: 'git-config', label: 'Git 配置', symbol: octicons.gitCommit, domId: 'gw-rs-tab-git-config' },
];

/** 页签 id。 */
export type RepositorySettingsTabId = (typeof REPOSITORY_SETTINGS_TABS)[number]['id'];

/** 作者身份的作用域(上游 `GitConfigLocation`,`git-config.tsx:25-28`)。 */
export type GitConfigLocation = 'global' | 'local';

/** 上游 `IWorkspaceRepositorySettingsProps`(`:35-42`)的我们的形状。 */
export interface IRepositorySettingsDialogProps {
  /** 真 store —— 写 `.gitignore` / 远端地址 / git 配置都经由它(写后刷新在那一侧)。 */
  readonly store: GitStore;
  /** 当前仓库路径(`snap.current`)。空串 ⇒ 调用点不该渲染本弹窗。 */
  readonly path: string;
  /**
   * **主远端名**(上游 `state.remote.name` 的那一半)。
   *
   * 由调用点用 `sync-state.ts` 的 `remoteNameOf(snap)` 算好传进来 —— 那是本仓
   * 「哪个远端是主远端」的**唯一**投影(`ui/app.tsx:3620-3633` 的镜像),
   * 弹窗里不重算。地址由本弹窗自己从 `remotes` 路由取(快照里只有名字,没有地址)。
   */
  readonly remoteName: string | null;
  /** 预选页签(上游 `initialSelectedTab`);语义是**初值**。 */
  readonly initialSelectedTab?: RepositorySettingsTabId;
  /**
   * `NoRemote` 那一支的 `Publish` 动作。
   *
   * 上游开 `PopupType.PublishRepository`(`repository-settings.tsx:281-286`);
   * 我们没有建库能力 ⇒ 调用点传的是「与顶栏同一句的实话 toast」。**必传**:
   * 少传就等于留一颗点了没反应的按钮,而本仓那条「点了必须有反应、反应必须是实话」
   * 的约束正是为此写的。
   */
  readonly onPublish: () => void;
  /** 关闭(Esc / 点遮罩 / 取消 / 保存成功)。 */
  readonly onClose: () => void;
}

/**
 * 仓库设置弹窗。见文件头的保真度账本。
 * @param props - 见 {@link IRepositorySettingsDialogProps}。
 */
export function RepositorySettingsDialog(props: IRepositorySettingsDialogProps): ReactNode {
  const { store, path } = props;

  const initialTabIndex = useMemo(() => {
    const index = REPOSITORY_SETTINGS_TABS.findIndex((tab) => tab.id === props.initialSelectedTab);
    // 上游 `this.props.initialSelectedTab || RepositorySettingsTab.Remote`(`:80`)
    // ⇒ 没传 / 传了不认识的值都落回第 0 页。
    return index < 0 ? 0 : index;
  }, [props.initialSelectedTab]);

  const [selectedTab, setSelectedTab] = useState<number>(initialTabIndex);
  const [disabled, setDisabled] = useState(false);
  const [saveDisabled, setSaveDisabled] = useState(false);
  const [errors, setErrors] = useState<readonly string[]>([]);

  /* ---- Remote 页 ---- */
  /** 远端清单(`name` + `url`);空 = 没有远端(渲染 `NoRemote` 那一支)。 */
  const [remotes, setRemotes] = useState<{ name: string; url: string }[] | null>(null);
  /** 输入框里的地址(受控)。 */
  const [remoteUrl, setRemoteUrl] = useState('');
  /** 初值 —— 上游判「改没改」用的是 `props.remote.url`(`:299`)。 */
  const [initialRemoteUrl, setInitialRemoteUrl] = useState('');
  /** 生效的远端名:主远端名在清单里 ⇒ 用它,否则退第一个(上游 `_defaultRemote` 那一支)。 */
  const [remoteName, setRemoteName] = useState<string | null>(props.remoteName);

  /* ---- Ignored Files 页 ---- */
  /** `.gitignore` 全文;`null` = 读不到 / 这个仓库根没有这个文件(上游 `ignoreText`)。 */
  const [ignoreText, setIgnoreText] = useState<string | null>(null);
  /** 用户改过没有(上游 `ignoreTextHasChanged`,`:55`)。**只**由输入触发。 */
  const [ignoreTextHasChanged, setIgnoreTextHasChanged] = useState(false);

  /* ---- Git Config 页 ---- */
  const [gitConfigLocation, setGitConfigLocation] = useState<GitConfigLocation>('global');
  const [initialGitConfigLocation, setInitialGitConfigLocation] = useState<GitConfigLocation>('global');
  const [committerName, setCommitterName] = useState('');
  const [committerEmail, setCommitterEmail] = useState('');
  const [globalCommitterName, setGlobalCommitterName] = useState('');
  const [globalCommitterEmail, setGlobalCommitterEmail] = useState('');
  const [initialCommitterName, setInitialCommitterName] = useState<string | null>(null);
  const [initialCommitterEmail, setInitialCommitterEmail] = useState<string | null>(null);
  const [isLoadingGitConfig, setIsLoadingGitConfig] = useState(true);

  /**
   * 打开时的装载(上游 `componentWillMount`,`:99-150`)。
   *
   * 顺序与上游一致:①读根 `.gitignore`(失败往错误区推一句、**不**中断装载);
   * ②读本地 + 全局的 `user.name` / `user.email`;③本地两项**都是 null** ⇒ 作用域
   * Global,否则 Local;④作用域 Local 时输入框显示本地值,否则显示全局值。
   *
   * ⚠️ 多出来的一件上游没有的活:**远端地址**。上游的 `remote` 是 `props`
   * (`ui/app.tsx:1845-1852` 从 `repositoryStateManager` 取),而我们的快照里
   * `sync.remotes` **只有名字**(`core/types.ts:213`)⇒ 地址必须现取一次
   * `remotes` 路由。这是**唯一的**信息源差异,记在文件头「六」以外的这一处。
   */
  useEffect(() => {
    let dead = false;
    void (async () => {
      /* ① 根 .gitignore */
      const ignore = await store.readGitIgnore();
      if (dead) { return; }
      if ('error' in ignore) {
        setErrors([`无法读取根 .gitignore:${ignore.error.message}`]);
      } else {
        setIgnoreText(ignore.text);
      }

      /* ①b 远端清单 + 主远端地址 */
      const list = await store.readRemotes();
      if (dead) { return; }
      setRemotes(list);
      const preferred = props.remoteName !== null
        ? list.find((entry) => entry.name === props.remoteName)
        : undefined;
      const chosen = preferred ?? list[0];
      setRemoteName(chosen?.name ?? null);
      setRemoteUrl(chosen?.url ?? '');
      setInitialRemoteUrl(chosen?.url ?? '');

      /* ② 四个配置值 */
      const [localName, localEmail, globalName, globalEmail] = await Promise.all([
        api.configGet(path, 'user.name', 'local'),
        api.configGet(path, 'user.email', 'local'),
        api.configGet(path, 'user.name', 'global'),
        api.configGet(path, 'user.email', 'global'),
      ]);
      if (dead) { return; }
      const valueOf = (
        result: { ok: true; value: { value: string | null } } | { ok: false; error: GitError },
      ): string | null => (result.ok ? result.value.value : null);
      const localNameValue = valueOf(localName);
      const localEmailValue = valueOf(localEmail);
      const globalNameValue = valueOf(globalName) ?? '';
      const globalEmailValue = valueOf(globalEmail) ?? '';

      // 上游 `:126-129`:本地两项**都是 null** 才算「用全局」。
      const location: GitConfigLocation =
        localNameValue === null && localEmailValue === null ? 'global' : 'local';

      setGitConfigLocation(location);
      setInitialGitConfigLocation(location);
      setGlobalCommitterName(globalNameValue);
      setGlobalCommitterEmail(globalEmailValue);
      setCommitterName(location === 'local' ? (localNameValue ?? '') : globalNameValue);
      setCommitterEmail(location === 'local' ? (localEmailValue ?? '') : globalEmailValue);
      setInitialCommitterName(localNameValue);
      setInitialCommitterEmail(localEmailValue);
      setIsLoadingGitConfig(false);
    })();
    return () => { dead = true; };
  }, [path, props.remoteName, store]);

  /* ---- 事件处理(与上游同名同义) ---- */

  const onTabClicked = useCallback((index: number): void => { setSelectedTab(index); }, []);

  const onRemoteUrlChanged = useCallback((event: { target: { value: string } }): void => {
    setRemoteUrl(event.target.value);
  }, []);

  const onIgnoreTextChanged = useCallback((event: { target: { value: string } }): void => {
    setIgnoreText(event.target.value);
    setIgnoreTextHasChanged(true);
  }, []);

  const onGitConfigLocationChanged = useCallback((value: GitConfigLocation): void => {
    setGitConfigLocation(value);
  }, []);

  const onCommitterNameChanged = useCallback((event: { target: { value: string } }): void => {
    const value = event.target.value;
    /*
     * 上游 `:422-433`:校验发生在**输入时**,并且把错误**当场写进 errors**
     * (不是只在保存时)。禁用「保存」与显示那句话是同一件事的两半。
     *
     * ⚠️ 上游这里有个自己造的小毛病:`setState({saveDisabled})` 与
     * `setState({committerName, errors})` 是**两次** `setState`(后者会把前者刚写的
     * `errors` 覆盖成同一个值 —— 因为两次都在同一个同步块里,React 会合并)。
     * 行为上等价于我们这一次 `setState`;照行为抄,不照那个实现细节抄。
     */
    const valid = gitAuthorNameIsValid(value);
    setSaveDisabled(!valid);
    setErrors(valid ? [] : [REPO_SETTINGS_INVALID_AUTHOR_NAME]);
    setCommitterName(value);
  }, []);

  const onCommitterEmailChanged = useCallback((event: { target: { value: string } }): void => {
    setCommitterEmail(event.target.value);
  }, []);

  /**
   * 两个单选框共用一个 handler(上游 `GitConfig` 的 `RadioGroup` 给的是**值**
   * 而不是事件,我们这里从事件里取值 —— 语义相同,少一个包装)。
   *
   * ⚠️ 它必须声明在 `renderGitConfigTab` **之前**:那是本仓 lint 的
   * `no-use-before-define` 口径(`renderGitConfigTab` 是同一作用域里的箭头函数,
   * 声明顺序可读性差就是 lint 违规)。
   */
  const onGitConfigLocationRadio = useCallback((event: { target: { value: string } }): void => {
    onGitConfigLocationChanged(event.target.value === 'local' ? 'local' : 'global');
  }, [onGitConfigLocationChanged]);

  const onShowGitIgnoreExamples = useCallback((): void => {
    // 上游 `:288-290` 的 `dispatcher.openInBrowser` ⇒ 浏览器半的 `window.open`
    // (与 `actions-view.tsx:86` / `changes-view.tsx:2461` 同一写法)。
    window.open(GITIGNORE_DOCS_URL, '_blank', 'noopener');
  }, []);

  /**
   * 保存(上游 `onSubmit`,`:292-389`)。逐条顺序与上游**完全一致** ——
   * 顺序有语义:错误按「远端 → gitignore → git 配置」累积,全部成功才关窗。
   */
  const onSubmit = useCallback((): void => {
    void (async () => {
      // 上游 `:293`:先把上一次的错误清掉、并禁用整窗。
      setDisabled(true);
      setErrors([]);
      const nextErrors: string[] = [];

      /* ① 远端地址(仅当真的改了) */
      if (remoteName !== null && remoteUrl.trim() !== initialRemoteUrl) {
        const error = await store.saveRemoteUrl(remoteName, remoteUrl.trim());
        if (error !== null) {
          nextErrors.push(`设置远端地址失败:${error.message}`);
        }
      }

      /* ② .gitignore(仅当改过且读得到) */
      if (ignoreTextHasChanged && ignoreText !== null) {
        const error = await store.saveGitIgnore(ignoreText);
        if (error !== null) {
          nextErrors.push(`保存 .gitignore 失败:${error.message}`);
        }
      }

      /* ③ git 配置 */
      const locationChanged = gitConfigLocation !== initialGitConfigLocation;
      const entries: (
        | { key: string; value: string; scope: 'local' | 'global' }
        | { key: string; unset: true; scope: 'local' | 'global' }
      )[] = [];
      if (locationChanged && gitConfigLocation === 'global') {
        // 上游 `:349-358`:切回全局 ⇒ 删掉仓库本地的两项。
        entries.push({ key: 'user.name', unset: true, scope: 'local' });
        entries.push({ key: 'user.email', unset: true, scope: 'local' });
      } else if (gitConfigLocation === 'local') {
        // 上游 `:359-378`:只在**与本地初值不同**时才写。
        if (committerName !== (initialCommitterName ?? '')) {
          entries.push({ key: 'user.name', value: committerName, scope: 'local' });
        }
        if (committerEmail !== (initialCommitterEmail ?? '')) {
          entries.push({ key: 'user.email', value: committerEmail, scope: 'local' });
        }
      }
      if (entries.length > 0) {
        const error = await store.saveGitConfig(entries);
        if (error !== null) {
          nextErrors.push(`写入 git 配置失败:${error.message}`);
        }
      }

      /* ④ 上游 `:384-388`:一条错都没有才关窗,否则留在原地把错误显示出来。 */
      if (nextErrors.length === 0) {
        props.onClose();
      } else {
        setDisabled(false);
        setErrors(nextErrors);
      }
    })();
  }, [
    committerEmail, committerName, gitConfigLocation, ignoreText, ignoreTextHasChanged,
    initialCommitterEmail, initialCommitterName, initialGitConfigLocation, initialRemoteUrl,
    props, remoteName, remoteUrl, store,
  ]);

  /* ---- 三个页签的正文 ---- */

  const renderRemoteTab = (): ReactNode => {
    if (remotes !== null && remotes.length === 0) {
      /* 上游 `no-remote.tsx` 整支。 */
      return (
        <DialogContent>
          <div className="gw-rs-noremote" data-gw-rs-noremote="">
            <p>
              把这个仓库发布到 GitHub。需要帮助?{' '}
              <a
                href={REMOTE_DOCS_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                了解远端仓库
              </a>
              。
            </p>
            <button type="button" className="gw-btn primary" onClick={props.onPublish}>
              发布
            </button>
          </div>
        </DialogContent>
      );
    }
    return (
      <DialogContent>
        <label className="gw-rs-field" htmlFor="gw-rs-remote-url">
          {`主远端仓库(${remoteName ?? '—'})地址`}
        </label>
        <input
          id="gw-rs-remote-url"
          className="gw-rs-input"
          type="text"
          placeholder="远端地址"
          value={remoteUrl}
          onChange={onRemoteUrlChanged}
          disabled={remotes === null}
        />
      </DialogContent>
    );
  };

  const renderIgnoredFilesTab = (): ReactNode => (
    <DialogContent>
      <p id="ignored-files-description" className="gw-rs-desc">
        正在编辑 <code>.gitignore</code>。这个文件列出有意不跟踪的文件,
        git 会忽略它们;已经被 git 跟踪的文件不受影响。{' '}
        <button type="button" className="gw-linkbtn" onClick={onShowGitIgnoreExamples}>
          了解 gitignore 文件的写法
        </button>
      </p>
      <textarea
        id="gw-rs-gitignore"
        className="gw-rs-textarea"
        aria-label="忽略的文件"
        aria-describedby="ignored-files-description"
        placeholder="忽略的文件"
        value={ignoreText ?? ''}
        onChange={onIgnoreTextChanged}
      />
    </DialogContent>
  );

  const renderGitConfigTab = (): ReactNode => {
    const usingGlobal = gitConfigLocation === 'global';
    const shownName = usingGlobal ? globalCommitterName : committerName;
    const shownEmail = usingGlobal ? globalCommitterEmail : committerEmail;
    return (
      <DialogContent>
        <div className="gw-rs-advanced">
          <h2 id="git-config-heading">对这个仓库,我希望</h2>
          <div className="gw-rs-radio" role="radiogroup" aria-labelledby="git-config-heading">
            <label>
              <input
                type="radio"
                name="gw-rs-git-config-location"
                value="global"
                checked={usingGlobal}
                onChange={onGitConfigLocationRadio}
              />
              使用我的全局 Git 配置
            </label>
            <label>
              <input
                type="radio"
                name="gw-rs-git-config-location"
                value="local"
                checked={!usingGlobal}
                onChange={onGitConfigLocationRadio}
              />
              使用这个仓库自己的 Git 配置
            </label>
          </div>
          <label className="gw-rs-field" htmlFor="gw-rs-committer-name">姓名</label>
          <input
            id="gw-rs-committer-name"
            className="gw-rs-input"
            type="text"
            value={shownName}
            disabled={usingGlobal || isLoadingGitConfig}
            placeholder="姓名"
            onChange={onCommitterNameChanged}
          />
          <label className="gw-rs-field" htmlFor="gw-rs-committer-email">邮箱</label>
          <input
            id="gw-rs-committer-email"
            className="gw-rs-input"
            type="text"
            value={shownEmail}
            disabled={usingGlobal || isLoadingGitConfig}
            placeholder="邮箱"
            onChange={onCommitterEmailChanged}
          />
        </div>
      </DialogContent>
    );
  };

  /**
   * 两个单选框共用一个 handler(上游 `GitConfig` 的 `RadioGroup` 给的是**值**
   * 而不是事件,我们这里从事件里取值 —— 语义相同,少一个包装)。
   */
  /**
   * 表单的两个事件处理器。
   *
   * ⚠️ **不能写成 JSX 里的内联箭头**:本仓的 `react/jsx-no-bind` 是**只拦上升**的棘轮
   * (`scripts/lint-baseline.json`),行内箭头会被记成新增违规。具名 → 稳定 → 也不白重渲染。
   * 它们和 `preferences-dialog.tsx:513-521` 那层 `<form>` 是同一份语义。
   */
  const onFormSubmit = useCallback((event: { preventDefault: () => void }): void => {
    event.preventDefault();
    if (!disabled) {
      onSubmit();
    }
  }, [disabled, onSubmit]);

  const onFormReset = useCallback((event: { preventDefault: () => void }): void => {
    event.preventDefault();
    props.onClose();
  }, [props]);

  const activeTab = REPOSITORY_SETTINGS_TABS[selectedTab]?.id ?? 'remote';
  const body = activeTab === 'remote'
    ? renderRemoteTab()
    : activeTab === 'ignored-files'
      ? renderIgnoredFilesTab()
      : renderGitConfigTab();

  return (
    <PluginDialog className="gw-repo-settings" labelledBy="repository-settings-title" onClose={props.onClose}>
      <h4 id="repository-settings-title">仓库设置</h4>

      {errors.length > 0 && (
        <div className="gw-errbox" data-gw-rs-errors="">
          {errors.map((message) => (
            <div className="gw-rs-error" role="alert" key={message}>{message}</div>
          ))}
        </div>
      )}

      <div className="gw-rs-container">
        <TabBar
          onTabClicked={onTabClicked}
          selectedIndex={selectedTab}
          type={TabBarType.Vertical}
        >
          {REPOSITORY_SETTINGS_TABS.map((tab) => (
            <span key={tab.id} id={tab.domId}>
              <Octicon className="icon" symbol={tab.symbol} />
              {tab.label}
            </span>
          ))}
        </TabBar>

        <div
          className="tab-container"
          role="tabpanel"
          aria-labelledby={REPOSITORY_SETTINGS_TABS[selectedTab]?.domId}
        >
          {body}
        </div>
      </div>

      {/*
        页脚那个 `<form>` 不是装饰:`OkCancelButtonGroup` 的「保存」是
        `<button type="submit">`、「取消」是 `<button type="reset">`
        (`ok-cancel-button-group.tsx:150`/`:168`),真正处理它们的是这一层 ——
        与 `preferences-dialog.tsx:513-521` 同一个理由、同一份写法。
        `disabled`(上游 `Dialog` 的 `disabled` prop)在这里体现为保存按钮的禁用 +
        提交期的早退(见 `onSubmit` 开头的 `setDisabled(true)`)。
      */}
      <form
        className="gw-rs-form"
        onSubmit={onFormSubmit}
        onReset={onFormReset}
      >
        <DialogFooter>
          <OkCancelButtonGroup
            okButtonText="保存"
            cancelButtonText="取消"
            okButtonDisabled={saveDisabled || disabled}
          />
        </DialogFooter>
      </form>
    </PluginDialog>
  );
}
