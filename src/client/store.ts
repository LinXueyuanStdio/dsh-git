/**
 * 跨视图状态:一份不可变快照 + 订阅,React 侧用 useSyncExternalStore 读取。
 * 所有 host 调用都从这里出,视图只读快照与调方法。
 * @module dsh-git/client/store
 */

import { api, unwrap, waitForRoutes, type AuthStatePayload, type HealthPayload, type RemoteRepo } from './api.ts';
import { fileStatusKindOf } from './file-kind.ts';
import { RepoStateCache, type RepoScopedSnapshot } from './repo-state-cache.ts';
import type { LineSelectionSpec } from '../core/partial-stage.ts';
/*
 * 上游 `models/progress.ts`（与上游一致，140 行，零 import）。**只作类型**使用 ——
 * `import type` 不产生运行期边，所以它不会把镜像的任何东西拉进客户端包。
 * 为什么用上游那个类型而不是自己写一个:同步按钮的 `progress` prop 收的就是它
 * (`ui/toolbar/push-pull-button.tsx:54`),两处必须**同一个**类型,否则
 * 「我们以为给了进度、上游认不出」这类错会静默发生在类型边界上。
 */
import type { Progress } from '../core/desktop/models/progress.ts';
/*
 * 读侧投影的**唯一一份**判据(`networkActionInProgress`)与**唯一一份**远端名判定
 * (`remoteNameOf`,上游 `ui/app.tsx:3620-3633`)。方向是 store → sync-state,
 * 而 `sync-state.ts` 只用 `import type` 引 `Snapshot` ⇒ **不构成运行期环**
 * (`import type` 在打包时被抹掉)。这样「谁算网络动作在跑」「同步面显示哪个远端名」
 * 各只有一处定义:写入侧的互斥与视图侧的转圈用同一个判据,进度标题与按钮标题
 * 用同一个远端名。
 */
import { networkActionInProgress, remoteNameOf } from './sync-state.ts';
import type {
  BranchEntry, ChangedFile, CommitEntry, DiffResult, GitError, RepoEntry, RepoStatus, SyncState,
} from '../core/types.ts';
import {
  getHideWhitespaceInChangesDiff, getHideWhitespaceInHistoryDiff, getShowSideBySideDiff,
  setHideWhitespaceInChangesDiff, setHideWhitespaceInHistoryDiff, setShowSideBySideDiff,
} from './diff-mode.ts';

/** 页签。 */
export type TabId = 'changes' | 'history' | 'code' | 'issues' | 'pulls' | 'actions';

export const TAB_ORDER: readonly { id: TabId; label: string }[] = [
  { id: 'changes', label: 'Changes' },
  { id: 'history', label: 'History' },
  { id: 'code', label: 'Code' },
  { id: 'issues', label: 'Issues' },
  { id: 'pulls', label: 'Pull requests' },
  { id: 'actions', label: 'Actions' },
];

/** 提交表单状态。 */
export interface CommitForm {
  summary: string;
  description: string;
  amend: boolean;
  signoff: boolean;
  noVerify: boolean;
  allowEmpty: boolean;
  generating: boolean;
  generatedBy: string;
}

/** 一个可撤销的提示。 */
export interface Toast {
  id: number;
  message: string;
  kind: 'ok' | 'err';
  actionLabel?: string;
  action?: () => void;
}

/** 一个文件当前的纳入状态(三态)。 */
export type IncludeState = 'all' | 'none' | 'partial';

/**
 * `LineSelectionSpec` → 三态。
 *
 * **不变式**(由 `desktop-diff.tsx` 的 `selectionToSpec` 保证,探针里逐例验过):
 * `diverging.length === 0` 时 `kind` 一定是 `all`(全选)或 `none`(全不选);
 * 有任何 diverging 行就是 `partial`。所以这个判据是精确的,不是近似。
 *
 * 为什么不用 `DiffSelection.getSelectionType()`:那是镜像里的类,要 import
 * `models/diff`;这个判据只需要 spec 自身,store 不该为一个纯判定拖进渲染层。
 * 反证方式:若有人能让 `selectionToSpec` 产生 `{kind:'all', diverging:[…]}` 且
 * diverging 覆盖**全部**可选行(= 真实类型 None),这里就会误判成 partial ——
 * 探针 A 组正是盯着这个不变式。
 * @param spec - 该文件的纳入状态;缺失 = 默认全选。
 */
export function includeStateOf(spec: LineSelectionSpec | undefined): IncludeState {
  if (spec === undefined) {
    return 'all';
  }
  if (spec.diverging.length === 0) {
    return spec.kind === 'all' ? 'all' : 'none';
  }
  return 'partial';
}

/**
 * 状态刷新/提交之后对既有纳入状态的**唯一**变换 —— 上游 `clearPartialState: true`。
 *
 * 上游把这条规则写成纯函数 `updateChangedFiles(state, status, clearPartialState)`
 * (`lib/stores/updates/changes-state.ts:32-116`),三条依据逐字核过:
 *  - `:47-54`:仅当 `clearPartialState` 为真**且**既有选择是 `Partial` 时,
 *    才 `file.withIncludeAll(false)`(⇒ 不含);
 *  - `:56` 的 `file.withSelection(existingFile.selection)`:其余情况
 *    (`All` / `None`)**原样保留** —— 这正是「用户显式取消勾选」能被记住的那条路径;
 *  - 两处调用方都传 `true`:**提交成功后** `lib/stores/app-store.ts:3756-3759`
 *    (真值在 `:3758`),**隐藏空白开关** `:7954-7957`(真值在 `:7956`)。
 *
 * **为什么不能整张抹掉**(这里以前写的就是 `includeState: {}`):本仓「缺失 = 默认 All」
 * (`includeStateOf`),抹表等于把所有文件改回「纳入提交」⇒ 用户明确排除的文件会在
 * **下一次提交**里被带上;而 `includedFiles()` 同时是生成提交信息的真源
 * (`commit()` 里那段注释)⇒ 生成的提交信息也会与实际提交内容不一致。
 *
 * 判据:`docs/probes/commit-include-state-probe.mjs` 的 P1/P2/P3(修前 2/5 红,修后 5/5)。
 * @param state - 变换前的纳入状态表(键 = 仓库内相对路径)。
 * @returns 新的表:`partial` → `none`,其余**原样**(含 `selectable`)。
 */
function clearPartialAfterCommit(
  state: Record<string, LineSelectionSpec>,
): Record<string, LineSelectionSpec> {
  const next: Record<string, LineSelectionSpec> = {};
  for (const [file, spec] of Object.entries(state)) {
    next[file] = includeStateOf(spec) === 'partial'
      ? { kind: 'none', diverging: [], ...(spec.selectable === undefined ? {} : { selectable: spec.selectable }) }
      : spec;
  }
  return next;
}

/**
 * 「当前这份 diff 对应哪个目标」的**唯一**一处定义 —— 请求序号与陈旧判定都靠它。
 *
 * 为什么必须抽出来(而不是留在 `loadDiff()` 里):这个 key 有两个消费方 ——
 * `loadDiff()` 自己(守卫 2:`:760-762`),以及任何需要判断「屏幕上这份 diff 还是不是
 * 当前目标的」的地方(例如以后要在状态刷新时决定**复用还是清空**,上游同义的规则在
 * `lib/stores/updates/changes-state.ts:90-95`)。写在两处必然漂移,而漂移的后果是
 * **把另一个文件的行选区留在屏幕上**(见 `loadDiff()` 上方的说明)。
 * @param file - 仓库内相对路径。
 * @param staged - true = 取索引与工作区之间的 diff(我们模型里的「已暂存」)。
 * @param hideWhitespace - 隐藏空白改动(**必须进 key**:它是重跑 `git diff -w`,
 *   标志变了而 key 不变 ⇒ 缓存命中、不会重取)。
 * @param headSha - 当前 HEAD;切分支/提交后靠它作废旧 diff。
 * @returns 形如 `路径:s|u:w|:sha` 的 key。
 */
function diffKeyOf(file: string, staged: boolean, hideWhitespace: boolean, headSha: string): string {
  return `${file}:${staged ? 's' : 'u'}:${hideWhitespace ? 'w' : ''}:${headSha}`;
}

/** 完整快照。 */
export interface Snapshot {
  ready: boolean;
  /** 服务端返回的错误(仓库清单等全局错误)。 */
  globalError: GitError | null;
  repos: RepoEntry[];
  hidden: string[];
  canPickDirectory: boolean;
  current: string;
  tab: TabId;
  status: RepoStatus | null;
  sync: SyncState | null;
  branches: BranchEntry[];
  selectedFiles: string[];
  /**
   * **每个变更文件的「提交纳入状态」**(= Desktop 的
   * `WorkingDirectoryFileChange.selection` / `DiffSelection`)。
   *
   * 这是**客户端模型**,不是索引的镜像:
   *  - 勾选/取消勾选**只改这里**,一个 git 命令都不发;
   *  - 索引只在 `commit()` 那一刻按它 materialize(照上游
   *    `lib/git/commit.ts:24-31` 的 `unstageAll` + `stageFiles`,再按
   *    `lib/git/update-index.ts:109-175` 分流整文件 / 部分补丁);
   *  - 键是**路径**;缺失 = 默认 `All`(上游每个 `WorkingDirectoryFileChange`
   *    出厂就是 `DiffSelection.fromInitialSelection(All)`,即**默认纳入提交**)。
   *
   * 值用 `LineSelectionSpec` 而不是 `DiffSelection` 实例:它是纯数据(能进快照、
   * 能直接喂 `api.stageLines`),而且 `desktop-diff.tsx` 的 `selectionToSpec` /
   * `specToSelection` 与它互逆(探针里对 host 的 `toDiffSelection` 做过逐行等价比对)。
   */
  includeState: Record<string, LineSelectionSpec>;
  diff: DiffResult | null;
  diffKey: string;
  log: CommitEntry[];
  logHasMore: boolean;
  logLoading: boolean;
  selectedCommit: string;
  commitDetailFiles: { path: string; status: string; additions: number; deletions: number }[];
  commitForm: CommitForm;
  auth: AuthStatePayload | null;
  remoteRepos: RemoteRepo[];
  remoteReposLoading: boolean;
  models: { provider: string; providerName: string; id: string; name: string }[];
  model: string;
  stagedOnly: boolean;
  /** Unified(false)还是 Split(true)。键名照 Desktop。 */
  sideBySide: boolean;
  /** Changes 页签是否隐藏空白改动。 */
  hideWhitespace: boolean;
  /** History 页签是否隐藏空白改动(Desktop 是两个独立开关)。 */
  hideWhitespaceHistory: boolean;
  /** 远端页签的角标计数。 */
  counts: Partial<Record<TabId, number>>;
  /** 本地工作区文件清单(Code 页签用;按仓库缓存,切仓库时清空)。 */
  repoFiles: { path: string; files: string[]; truncated: boolean } | null;
  /** 本机可用的外部编辑器(懒加载)。 */
  externalApps: { id: string; label: string }[];
  /** 生成前需要用户确认「覆盖已写内容」时为 true。 */
  pendingGenerateConfirm: boolean;
  /** host 的存储是否持久化;null = 还没探到。 */
  storagePersistent: boolean | null;
  storageError: string | null;
  busy: string;
  /**
   * **进行中的网络动作的进度**(抓取 / 拉取 / 推送 / 强推)。
   *
   * 上游的载体是 `IRepositoryState.pushPullFetchProgress`(`lib/app-state.ts:632`),
   * 由 `AppStore.updatePushPullFetchProgress`(`lib/stores/app-store.ts:5168`)写入;
   * 同步按钮直接吃它(`ui/app.tsx:3622` 的 `const progress = state.pushPullFetchProgress`
   * → `push-pull-button.tsx:54` 的 `progress` prop)。
   *
   * **这是真数据源,不是装饰**:写入点是**真实的动作边界**——
   *  1. 动作开始前,上游 `lib/git/{fetch,pull,push}.ts` 各自发的**初始进度**
   *     (`fetch.ts:84` / `pull.ts:100` / `push.ts:102-106`),标题/远端/分支都取自
   *     真实输入;
   *  2. 动作返回后进入**刷新阶段**,上游 `app-store.ts:5983-6000`(fetch)、
   *     `:5350-5366`(push)、`:5608-5617`(pull)各自发的几条 `kind:'generic'`,
   *     `value` 用上游自己的权重常量算(`fetchWeight` / `pullWeight` /
   *     `pushWeight` / `refreshWeight`),不是拍的数;
   *  3. 结束时置回 `null`(`finally`)。
   *
   * ⚠️ **唯一缺的那一段是「网络进行中」的百分比**(上游 `lib/progress/git.ts` 把
   * `git --progress` 的 stderr 逐行解析成 0→1)。那需要宿主把 git 的 stderr 逐行
   * 吐出来,而 `src/host/git-runner.ts` 的 `run()` 是**收集到结束**
   * (`open()` 那条流只开 stdout,stderr 是 `{maxBytes}` 收集态),路由又是
   * 一问一答的 JSON 信封(`routes.ts` 的 `writeJson` 只在 handler 返回后写一次)。
   * 所以中间段今天只能停在初始值;详见 `sync-state.ts` 的文件头与交付说明。
   */
  progress: Progress | null;
  /**
   * **「被我们重写过历史、因此建议强推」的分支表** —— 上游
   * `IBranchesState.forcePushBranches`(`lib/app-state.ts:736`,类型
   * `ReadonlyMap<string, string>`:分支短名 → 重写后的 tip sha)。
   *
   * 上游只在两处写入(`AppStore._addBranchToForcePushList`,`app-store.ts:9676`):
   *  1. **修订(amend)** 提交后,新 sha ≠ 被修订的 sha(`app-store.ts:3779-3797`);
   *  2. 多提交操作(rebase / squash / reorder,**不含** cherry-pick)成功后
   *     (`ui/dispatcher/dispatcher.ts:3845-3854`)。
   * 我们这一侧只有第 1 条有对应的真实动作(`commit()` 的 `form.amend`);第 2 条
   * 依赖的 rebase/squash/reorder 界面在本插件里**还没有**,所以不伪造。
   *
   * 消费点是上游 `lib/rebase.ts:39` 的 `getCurrentBranchForcePushState()`:
   * 表里有当前分支**且值等于当前 tip sha** ⇒ `ForcePushBranchState.Recommended`
   * (按钮变「强推」);否则 `Available`(按钮是「拉取」,强推作为下拉项)。
   * 见 `src/client/sync-state.ts`。
   *
   * 用普通对象而不是 `Map`:快照必须是可比较的纯数据(`useSyncExternalStore` 的
   * 读取入口),`Map` 的引用相等语义在这里只会制造「同内容不同对象 ⇒ 白重渲染」。
   * 唯一需要 `Map` 的地方(`getCurrentBranchForcePushState`)在投影层转一次。
   */
  forcePushBranches: Record<string, string>;
  toasts: Toast[];
}

function initial(): Snapshot {
  return {
    ready: false,
    globalError: null,
    repos: [],
    hidden: [],
    canPickDirectory: false,
    current: '',
    tab: 'changes',
    status: null,
    sync: null,
    branches: [],
    selectedFiles: [],
    includeState: {},
    diff: null,
    diffKey: '',
    log: [],
    logHasMore: false,
    logLoading: false,
    selectedCommit: '',
    commitDetailFiles: [],
    commitForm: {
      summary: '',
      description: '',
      amend: false,
      signoff: false,
      noVerify: false,
      allowEmpty: false,
      generating: false,
      generatedBy: '',
    },
    auth: null,
    remoteRepos: [],
    remoteReposLoading: false,
    models: [],
    model: '',
    stagedOnly: true,
    sideBySide: getShowSideBySideDiff(),
    hideWhitespace: getHideWhitespaceInChangesDiff(),
    hideWhitespaceHistory: getHideWhitespaceInHistoryDiff(),
    counts: {},
    repoFiles: null,
    externalApps: [],
    pendingGenerateConfirm: false,
    storagePersistent: null,
    storageError: null,
    busy: '',
    progress: null,
    forcePushBranches: {},
    toasts: [],
  };
}

/**
 * 从一份快照里挑出**属于某个仓库**的那些字段(`RepoStateCache` 的入参/初值)。
 *
 * 返回值类型是 `RepoScopedSnapshot = Pick<Snapshot, …>`,所以**少挑一个字段就是编译错误** ——
 * 这正是要的:否则「切一次仓库静默丢一个字段」会再次发生(`logHasMore` / `commitDetailFiles`
 * 那一类正是这样丢的)。
 * @param snap - 来源快照。
 * @returns 只含按仓库字段的那一份。
 */
function repoScopedOf(snap: Snapshot): RepoScopedSnapshot {
  return {
    selectedFiles: snap.selectedFiles,
    includeState: snap.includeState,
    diff: snap.diff,
    diffKey: snap.diffKey,
    log: snap.log,
    logHasMore: snap.logHasMore,
    selectedCommit: snap.selectedCommit,
    commitDetailFiles: snap.commitDetailFiles,
    forcePushBranches: snap.forcePushBranches,
    commitForm: snap.commitForm,
  };
}

/** 订阅式 store。 */
/** 本前端产物的构建时间戳(由构建脚本注入)。 */
declare const __BUILD_STAMP__: string | undefined;
const BUILD_STAMP: string = typeof __BUILD_STAMP__ === 'string' ? __BUILD_STAMP__ : '未知';

export class GitStore {
  private state: Snapshot = initial();
  /** `loadDiff()` 的请求序号:只让最新一次的响应落地(见该方法上的说明)。 */
  private diffSeq = 0;

  /**
   * **按仓库**的视图状态(上游 `RepositoryStateCache` 与上游一致的容器 + 我们自己的形状)。
   *
   * 上游事实与理由写在 `./repo-state-cache.ts` 的文件头;判据是
   * `docs/probes/changes-cache-probe.mjs`(切走再切回:选中 / 草稿 / 纳入状态 / diff)。
   *
   * 初值取自本文件的 `initial()`(经 `repoScopedOf`)—— **不在这里再写一份字面量**,
   * 否则「默认值」就有了第二份真源。
   */
  private readonly repoStates = new RepoStateCache({ initial: () => repoScopedOf(initial()) });

  /**
   * @param sessionId - 当前会话 id;用于问宿主「这个会话在哪个工作区」,
   *   从而把正在编辑的项目自动登记进仓库清单。
   */
  constructor(private readonly sessionId: string = '') {}

  /** 目录选择器:由插件的 apply() 注入(客户端原生弹窗优先)。 */
  /** 返回 null 表示「没有选择器」,不是「用户取消」。 */
  private pickDirectory: (() => Promise<string | null> | null) | undefined;

  setDirectoryPicker(fn: () => Promise<string | null> | null): void {
    this.pickDirectory = fn;
  }
  private readonly listeners = new Set<() => void>();
  private toastSeq = 0;
  /** 定时器:工作区自动刷新。 */
  private pollTimer: ReturnType<typeof setInterval> | undefined;

  /** React 读取入口(必须引用稳定)。 */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  snapshot = (): Snapshot => this.state;

  private emit(patch: Partial<Snapshot>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) {
      try { listener(); } catch { /* 单个订阅者异常不影响其他 */ }
    }
  }

  // ---------- 提示 ----------

  toast(message: string, kind: 'ok' | 'err' = 'ok', action?: { label: string; run: () => void }): void {
    const id = ++this.toastSeq;
    const entry: Toast = {
      id,
      message,
      kind,
      ...(action !== undefined ? { actionLabel: action.label, action: action.run } : {}),
    };
    this.emit({ toasts: [...this.state.toasts, entry] });
    setTimeout(() => {
      this.emit({ toasts: this.state.toasts.filter((t) => t.id !== id) });
    }, kind === 'err' ? 7000 : 3600);
  }

  dismissToast(id: number): void {
    this.emit({ toasts: this.state.toasts.filter((t) => t.id !== id) });
  }

  private fail(error: GitError): void {
    const suffix = error.detail !== undefined && error.detail !== '' && error.code !== 'internal'
      ? `（${error.detail.split('\n')[0] ?? ''}）`
      : '';
    this.toast(`${error.message}${suffix}`, 'err');
  }

  // ---------- 启动 ----------

  async start(): Promise<void> {
    if (this.state.ready) {
      return;
    }
    // 路由是异步挂载的(等 storage domain),先探活再取清单。
    const readiness = await waitForRoutes();
    if (!readiness.ok) {
      this.emit({
        ready: true,
        globalError: { code: 'internal', message: 'dsh-git 服务未就绪:host 侧插件可能未激活,或需要重启 DSH。' },
      });
      return;
    }
    this.emit({
      storagePersistent: readiness.health.persistent,
      storageError: readiness.health.storageError,
    });
    // 版本错配检测:host 半不参与热重载,刷新页面只会拿到新的前端。
    // 不检测的话,旧 host 的旧行为会被当成「新代码的 bug」,极难排查。
    //
    // 这里的**就地收窄**是必要的:`api.ts` 的 `HealthPayload` 还没声明 `build`
    // (那个文件由另一条线持有,本次不改),但 host **确实**在回它 ——
    // `host/routes.ts:141` 的 `build: deps.buildStamp ?? ''`。所以这不是「读一个
    // 不存在的字段」,而是「声明落后于载荷」;`as` 让读取保持真实,且在
    // `HealthPayload` 补上 `build: string` 之后可以直接删掉(见交付说明)。
    const hostBuild = (readiness.health as HealthPayload & { build?: string }).build;
    if (BUILD_STAMP === '未知') {
      // 前端自己都没有戳(构建脚本没注入),就没法比对,别误报。
    } else if (hostBuild !== undefined && hostBuild !== '' && hostBuild !== BUILD_STAMP) {
      this.toast(
        `host 半是旧构建(${hostBuild}),页面是 ${BUILD_STAMP}:行为可能不一致。请重启 DSH 让 host 重新加载。`,
        'err',
      );
    } else if (hostBuild === undefined) {
      this.toast(
        `host 半没有上报构建号(说明它早于当前前端):请重启 DSH。当前前端 build ${BUILD_STAMP}。`,
        'err',
      );
    }

    if (!readiness.health.persistent) {
      // 存储降级必须让用户知道:否则「加了仓库、重启就没了」看起来像 bug。
      // storageError 可能是 undefined(旧 host 没这个字段),所以只在它是
      // **非空字符串**时才拼出来 —— 否则会出现「…会丢失(undefined)」这种提示。
      const reason = typeof readiness.health.storageError === 'string' && readiness.health.storageError !== ''
        ? `原因:${readiness.health.storageError}`
        : 'host 没有给出原因(可能是旧构建,先重启 DSH 再试)。';
      this.toast(`存储不可用,本次运行的仓库清单与登录态重启后会丢失。${reason}`, 'err');
    }
    const repos = await api.repos();
    if (repos.ok) {
      let list = repos.value.repos;

      // 1) **总是**检查当前会话所在的工作区项目:是 git 仓库就登记进清单。
      //    (以前只在清单为空时才探测,于是已经加过几个仓库的用户,在新项目里
      //     打开页签永远不会看到当前项目。)
      let workspacePath: string | null = null;
      let autoAdded = false;
      let detectReason = '';
      const detected = await api.autodetect(this.sessionId);
      if (detected.ok) {
        workspacePath = detected.value.path;
        autoAdded = detected.value.added === true;
        detectReason = detected.value.reason ?? '';
        if (detected.value.repos.length > 0) list = detected.value.repos;
      }

      // 2) 选中优先级:当前工作区项目 → 宿主持久化的上次选中 → 清单第一个。
      //    页签是**按会话**的,所以「当前项目」优先于全局记忆是符合直觉的。
      let current = '';
      if (workspacePath !== null && workspacePath !== '') {
        current = workspacePath;
      } else {
        current = this.pickInitial(list, repos.value.lastSelected);
        // 工作区不是 git 仓库时,至少别让用户看着空白:把原因说清楚。
        if (list.length === 0 && detectReason !== '') {
          this.toast(`没有找到可用的 git 项目:${detectReason}`, 'err');
        }
      }

      this.emit({
        ready: true,
        repos: list,
        hidden: repos.value.hidden,
        canPickDirectory: repos.value.canPickDirectory,
        current,
        globalError: null,
      });

      if (autoAdded) {
        this.toast(`已自动加入当前项目:${current.split('/').pop() ?? current}`);
      }
      if (current !== '') {
        if (current !== repos.value.lastSelected) void api.selectRepo(current);
        await this.refreshAll();
      }
    } else {
      this.emit({ ready: true, globalError: repos.error });
    }
    // 顺序是**契约**不是风格:`loadPrefs()` 先读回 host 落盘的模型 pin,
    // `loadModels()` 再按 pin 校验清单;反过来 loadModels 会用 models[0] 占掉
    // `state.model`,pin 就进不去了(两者都是 emit,后写的赢)。
    void (async () => {
      await this.loadPrefs();
      await this.loadModels();
    })();
    void this.loadAuth();
  }

  /**
   * 选择要展示的仓库。
   * @param repos - 当前清单。
   * @param preferred - 宿主记住的上次选中路径(可选)。
   */
  private pickInitial(repos: readonly RepoEntry[], preferred?: string): string {
    if (this.state.current !== '' && repos.some((r) => r.path === this.state.current)) return this.state.current;
    if (preferred !== undefined && preferred !== '' && repos.some((r) => r.path === preferred)) return preferred;
    return repos[0]?.path ?? '';
  }

  /**
   * 定时刷新工作区。
   *
   * ⚠️ **不再是「只刷 status + sync」**(2026-10 改了,旧注释留在这里会让下一个人
   * 按错的成本模型做决定):`refreshStatus()` 现在照上游 `_loadStatus` 的末尾
   * (`app-store.ts:3018`)**连当前选中文件的 diff 一起重取** —— 那正是「外部改了文件
   * 之后界面能自愈」的唯一路径。代价是每轮一次 `git diff -- <一个文件>`
   * (`loadDiff` 在没选文件时早退,不发请求);`busy !== ''` 时整轮跳过。
   */
  startPolling(intervalMs = 5000): () => void {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      if (this.state.current === '' || this.state.busy !== '') return;
      void this.refreshStatus();
    }, intervalMs);
    return () => this.stopPolling();
  }

  stopPolling(): void {
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  // ---------- 仓库 ----------

  /** 重新拉取仓库清单(克隆/外部改动后)。 */
  async refreshRepos(): Promise<void> {
    const result = await api.repos();
    if (!result.ok) {
      this.fail(result.error);
      return;
    }
    this.emit({
      repos: result.value.repos,
      hidden: result.value.hidden,
      canPickDirectory: result.value.canPickDirectory,
      current: this.pickInitial(result.value.repos, result.value.lastSelected),
    });
  }

  async addRepo(path: string): Promise<boolean> {
    const result = await api.addRepo(path);
    if (!result.ok) {
      this.fail(result.error);
      return false;
    }
    if (!result.value.added) {
      // 以前这里是静默 return,用户看到的就是「点了没反应」。
      this.toast(
        '没有选到目录。若宿主未提供目录选择,请用「手动输入路径」直接填写仓库绝对路径。',
        'err',
      );
      return false;
    }
    this.emit({ repos: result.value.repos, current: this.pickInitial(result.value.repos) });
    this.toast('已添加仓库');
    await this.refreshAll();
    return true;
  }

  /**
   * 点「Add / + 添加」时选目录。
   *
   * 优先用**客户端**的原生弹窗(`uiWorkspace.pickDirectory`),它拿到的是绝对路径;
   * 拿不到再回退到 host 侧的 `directoryPickerController`(走 `@pick` 由 host 弹窗)。
   * 两条路都不通时给出可读提示,而不是静默无反应。
   */
  async addRepoViaDialog(): Promise<boolean> {
    if (this.pickDirectory !== undefined) {
      const attempt = this.pickDirectory();
      // null = 这个客户端没有选择器 → 回退到 host 侧弹窗
      if (attempt === null) return this.addRepo('@pick');
      let chosen: string | null;
      try {
        chosen = await attempt;
      } catch (error) {
        // 远端/SSH 部署下 native 选择器不可用,host 侧同样可能不行 —— 给出可操作提示。
        this.toast(
          `目录选择不可用:${error instanceof Error ? error.message : String(error)}。请用「手动输入路径」直接填写仓库绝对路径。`,
          'err',
        );
        return false;
      }
      if (chosen !== null && chosen !== '') return this.addRepo(chosen);
      return false; // 用户取消:静默(取消不是错误)
    }
    return this.addRepo('@pick');
  }

  async removeRepo(path: string): Promise<void> {
    const result = await api.removeRepo(path);
    if (!result.ok) {
      this.fail(result.error);
      return;
    }
    const current = this.state.current === path ? this.pickInitial(result.value.repos) : this.state.current;
    this.emit({ repos: result.value.repos, current, status: current === '' ? null : this.state.status });
    if (current !== path) await this.refreshAll();
  }

  async renameRepo(path: string, alias: string): Promise<void> {
    const result = await api.renameRepo(path, alias);
    if (!result.ok) {
      this.fail(result.error);
      return;
    }
    this.emit({ repos: result.value.repos });
  }

  async selectRepo(path: string): Promise<void> {
    if (path === this.state.current) return;
    // 宿主侧持久化,重开页签/重启后恢复
    void api.selectRepo(path);
    /*
     * **切出**:把属于**上一个仓库**的字段写回它的槽。
     *
     * 上游切仓库只是「刷新」,`_selectRepositoryRefreshTasks`
     * (`lib/stores/app-store.ts:2237-2241` 的 `_refreshRepository`)**不重置**任何状态 ——
     * 因为每个仓库各有一份 `IRepositoryState`(`lib/stores/repository-state-cache.ts:31`
     * 的 `Map<string, IRepositoryState>`,key = `repository.hash`),草稿另有一份
     * `GitStore`(`lib/stores/git-store-cache.ts:6-31` + `git-store.ts:136`)。
     *
     * 我们以前把下面这 10 个字段整块清空 ⇒ **切走再切回,选中 / 草稿 / 每个文件的
     * 纳入状态 / diff 全丢**。现在按仓库留起来。判据:
     * `docs/probes/changes-cache-probe.mjs`(改前 **2/6**、改后 **6/6**)。
     */
    this.repoStates.stash(this.state.current, this.state);
    /*
     * **切入**:命中 ⇒ 带着那个仓库上次的状态;未命中 ⇒ 干净初值
     * (镜像 `get()` 的未命中分支,`repository-state-cache.ts:36-45`)。
     *
     * `status` / `sync` / `branches` **刻意不缓存**(理由写在 `repo-state-cache.ts` 文件头):
     * 显示上一个仓库的文件列表比「一帧空列表」更危险(用户会对着一份不属于当前仓库的
     * 列表点勾选),而这三样 `refreshAll()` 立刻就能拿回来 ⇒ 它们照旧清空。
     */
    const restored = this.repoStates.restore(path);
    this.emit({
      current: path,
      status: null,
      sync: null,
      branches: [],
      // 进行中的进度属于「上一个仓库的网络动作」:切仓库时它已经无意义。
      progress: null,
      // `stagedOnly` **刻意不在这里重置**:它是全局生成偏好(落在 host 的
      // `prefs.stagedOnly`,由设置面板的勾选框写),不是按仓库的状态。
      // 以前这里写 `stagedOnly: true`,于是切一次仓库就把用户的偏好覆盖掉 ——
      // 与「刷新后弹回默认」是同一类静默丢失,只是触发动作不同(切仓库 vs 刷新)。
      ...restored,
    });
    await this.refreshAll();
  }

  async refreshAll(): Promise<void> {
    await Promise.all([this.refreshStatus(), this.refreshBranches(), this.refreshLog(true)]);
  }

  async refreshStatus(): Promise<void> {
    const path = this.state.current;
    if (path === '') return;
    const [status, sync] = await Promise.all([api.status(path), api.syncState(path)]);
    if (status.ok && sync.ok) {
      // 纳入状态按**路径**存:文件不再是变更文件(提交掉了 / 被丢弃 / 被撤销)时
      // 必须一起清掉,否则同一路径下次出现会带着上一次的选区冒出来。
      // `?? []`:宿主一定回 files,但这条守卫的成本是 0 —— 载荷畸形时不该把整个 store 打崩。
      const present = new Set((status.value.files ?? []).map((f) => f.path));
      const includeState = Object.fromEntries(
        Object.entries(this.state.includeState).filter(([file]) => present.has(file)),
      );
      /*
       * **选中集合也要跟着过滤** —— 上游 `updateChangedFiles`
       * (`lib/stores/updates/changes-state.ts:80-88`):
       * 已提交/已丢弃的文件要**从 `selectedFileIDs` 里滤掉**;一个都不剩而列表非空时
       * **回落到第一个文件**。
       *
       * 我们以前完全不动 `selectedFiles`,后果有两条(见
       * `docs/changes-cache-gaps-vs-desktop.md` 的 #5):
       *  1. 提交/丢弃之后右栏停在一个**已不在变更列表里**的路径上,显示
       *     「没有可显示的差异」——用户以为改动丢了;
       *  2. 紧随其后的 `loadDiff()` 还会对那个**已消失的路径**白发一次 `diff` 请求。
       *
       * 顺手对齐的另一条上游行为:切仓库后上游会**自动选中第一个变更文件**
       * (同 `:86-88`,以及 `_selectWorkingDirectoryFiles` 的「没有选中就挑第一个」),
       * 而我们此前显示的是「选择一个文件查看 diff」。
       *
       * `:90-95` 那条「同一个文件仍被选中 ⇒ 复用已加载的 diff,否则清成 null」
       * **不在这里重写**:紧随其后的 `this.loadDiff()` 的守卫 2(`:777-780`)做的就是
       * 同一件事(`diffKey` 变了才清),两处都写会变成第二份必然漂移的真源。
       */
      const files = status.value.files ?? [];
      const keptSelection = this.state.selectedFiles.filter((file) => present.has(file));
      const selectedFiles =
        keptSelection.length > 0 ? keptSelection : files[0] !== undefined ? [files[0].path] : [];
      this.emit({
        status: status.value,
        sync: sync.value,
        globalError: null,
        includeState,
        selectedFiles,
      });
      /*
       * **重取当前选中文件的 diff** —— 上游 `_loadStatus` 的**末尾**就是这么做的
       * (`lib/stores/app-store.ts:3018` 的 `this.updateChangesWorkingDirectoryDiff(repository)`),
       * 而 `_loadStatus` 是**每一条**刷新路径的必经之地:窗口焦点、切仓库、切分支、
       * 提交后、点刷新都走它。所以上游的 diff 永远不会「外部改了却一直显示旧的」。
       *
       * 我们以前**只**在 `afterIndexChange()` 里重取,于是:
       *  - 5s 轮询(外部改了文件)只更新列表,diff 一直陈旧;
       *  - `refreshAll()`(点「刷新状态与历史」、切分支、commit/pull 收尾)也不重取;
       *  - 即 diff **永远不会自愈**,除非用户重新点一次文件。
       *
       * 位置照上游放在**状态落地之后**:`loadDiff` 读 `this.state.status.files` 判
       * `staged` 与 `headSha` 组 key(`:696-698`),状态没落地就会用旧的 key。
       * 上游那一行是 fire-and-forget,这里 **`await`**:我们的 `loadDiff` 已经有请求
       * 序号守卫(`:269`、`:711-713`),await 不会让陈旧响应落地,但能让
       * 「刷新完成 ⇒ diff 已是最新」成为一个**可断言**的契约
       * (`docs/probes/commit-include-state-probe.mjs` 的 P4/P5)。
       */
      await this.loadDiff();
      return;
    }
    if (!status.ok) this.emit({ globalError: status.error });
  }

  async refreshBranches(): Promise<void> {
    const path = this.state.current;
    if (path === '') return;
    const result = await api.branches(path);
    if (result.ok) this.emit({ branches: result.value });
  }

  async refreshLog(reset: boolean): Promise<void> {
    const path = this.state.current;
    if (path === '') return;
    if (this.state.logLoading) return;
    this.emit({ logLoading: true });
    const skip = reset ? 0 : this.state.log.length;
    const result = await api.log(path, 50, skip);
    if (result.ok) {
      this.emit({
        log: reset ? result.value.commits : [...this.state.log, ...result.value.commits],
        logHasMore: result.value.hasMore,
        logLoading: false,
      });
    } else {
      this.emit({ logLoading: false });
      this.fail(result.error);
    }
  }

  setTab(tab: TabId): void {
    this.emit({ tab });
    /*
     * 切到 Changes 页签 ⇒ 刷新一次。
     *
     * 上游 `_changeRepositorySection`(`lib/stores/app-store.ts:3362-3391`)在切到
     * Changes 时调 `refreshChangesSection({includingStatus: true, clearPartialState: false})`
     * (`:3377-3381`)。两个参数都要沿用:
     *  - `includingStatus: true` ⇒ 会发现外部改动;
     *  - `clearPartialState: **false**` ⇒ 切页签**不**动行级选区(只有「提交成功」与
     *    「隐藏空白开关」才传 true,见 `clearPartialAfterCommit`)。
     *
     * 以前这里只有 `emit({tab})`,于是切回页签既看不到外部改动、也没把当前选中文件的
     * diff 提上来 —— 而 `refreshStatus()` 现在自己会重取 diff(照 `_loadStatus` 末尾
     * `:3018`),所以这一句同时补上两件事。
     *
     * 只在切到 `changes` 时发:上游切到 History 走的是 `refreshHistorySection`。
     * 唯一的调用方是页签栏(`workbench.tsx:285` 的 `onSelect`),不会在启动时触发。
     */
    if (tab === 'changes') void this.refreshStatus();
  }

  /** 远端页签回填角标计数。 */
  setCount(tab: TabId, value: number): void {
    if (this.state.counts[tab] === value) return;
    this.emit({ counts: { ...this.state.counts, [tab]: value } });
  }

  // ---------- 文件选择与 diff ----------

  toggleFile(file: string, additive: boolean): void {
    const current = this.state.selectedFiles;
    if (additive) {
      this.emit({
        selectedFiles: current.includes(file) ? current.filter((f) => f !== file) : [...current, file],
      });
    } else {
      this.emit({ selectedFiles: [file] });
    }
    void this.loadDiff();
  }

  selectFiles(files: string[]): void {
    this.emit({ selectedFiles: files });
    void this.loadDiff();
  }

  /**
   * 取当前选中文件的 diff。
   *
   * **两次守卫(2026-10 补)** —— 这一层以前只有「请求 → 落地」,没有序号、也没有把
   * 旧 diff 撤掉,于是快速点两个文件时,**先发后到的那份 diff 会盖住后发先到的那份**:
   *
   *  1. `diffSeq`:每次调用 +1,响应回来时只有仍是**最新**那次才允许落地。
   *     否则界面会停在「选中的是 B、显示的却是 A」。
   *  2. 目标变了(`diffKey` 不等)就先把 `diff` 撤成 null。**这一条不只是观感**:
   *     `DiffPane` 传给 diff 渲染层的选区是 `includeState[diff.path]`,而行号勾选框
   *     又由它驱动 ⇒ 留着 A 的 diff 会让用户对着 A 的行勾选、却以为在改 B,
   *     勾选会落到**另一个文件**上。撤成 null 时 diff 面板显示「读取 diff…」。
   *
   * 为什么必须在这里:所有入口(`toggleFile` / `selectFiles` / `setHideWhitespace` /
   * `afterIndexChange`)都汇到这一个方法,守卫放在这一层只需一份。
   */
  async loadDiff(): Promise<void> {
    const path = this.state.current;
    const file = this.state.selectedFiles[0];
    const seq = (this.diffSeq += 1);
    if (path === '' || file === undefined) {
      this.emit({ diff: null, diffKey: '' });
      return;
    }
    const entry = this.state.status?.files.find((f) => f.path === file);
    const staged = entry !== undefined && entry.staged !== undefined && entry.unstaged === undefined;
    // key 的公式只有 `diffKeyOf()` 一份(`-w` 标志必须进 key 的理由写在那里)。
    const key = diffKeyOf(file, staged, this.state.hideWhitespace, this.state.status?.headSha ?? '');
    // 守卫 2:目标与当前已加载的那份不是同一个 ⇒ 先撤掉,别让另一个文件的行勾选留在屏幕上。
    if (this.state.diffKey !== key) {
      this.emit({ diff: null, diffKey: '' });
    }
    const result = await api.diff({
      path,
      file,
      ...(staged ? { staged: true } : {}),
      ...(entry?.untracked === true ? { untracked: true } : {}),
      ...(this.state.hideWhitespace ? { ignoreWhitespace: true } : {}),
    });
    // 守卫 1:期间用户又切了文件 / 仓库 / 隐藏空白 ⇒ 这次响应已经没有意义。
    if (seq !== this.diffSeq) {
      return;
    }
    if (result.ok) this.emit({ diff: result.value, diffKey: key });
  }



  // ---------- 提交纳入状态(客户端模型;**绝不写 git 索引**) ----------

  /** 当前应该被提交的文件(纳入状态 ≠ none)。 */
  public includedFiles(): ChangedFile[] {
    return (this.state.status?.files ?? []).filter(
      (f) => includeStateOf(this.state.includeState[f.path]) !== 'none',
    );
  }

  /**
   * 勾选 / 取消勾选**一个文件**(Desktop 的 `withIncludeAll`)。
   *
   * 只改客户端模型,不发任何 git 命令 —— 这是用户两次驳回的那一点:
   * 「勾选应该只是勾选,不是暂存」。索引的写入统一发生在 `commit()`。
   * @param file - 仓库内相对路径。
   * @param included - true = 纳入提交(All),false = 排除(None)。
   */
  public setFileIncluded(file: string, included: boolean): void {
    const previous = this.state.includeState[file];
    // 保留已知的可选行集合:整文件切换不该把「这个文件哪些行可选」的信息丢掉。
    const selectable = previous?.selectable;
    this.emit({
      includeState: {
        ...this.state.includeState,
        [file]: {
          kind: included ? 'all' : 'none',
          diverging: [],
          ...(selectable === undefined ? {} : { selectable }),
        },
      },
    });
  }

  /**
   * 行级选区变化(diff 面板回传)→ 写进客户端模型。
   *
   * **不调用 `api.stageLines`**:那是旧模型(勾选即写索引)的行为。
   * @param file - 仓库内相对路径。
   * @param spec - `desktop-diff.tsx` 的 `selectionToSpec()` 输出。
   */
  public setFileSelection(file: string, spec: LineSelectionSpec): void {
    this.emit({ includeState: { ...this.state.includeState, [file]: spec } });
  }

  /**
   * 头部的「全选 / 全不选」三态复选框(作用在**当前可见**的文件上)。
   * @param files - 目标文件路径。
   * @param included - true = 全部纳入,false = 全部排除。
   */
  public setFilesIncluded(files: readonly string[], included: boolean): void {
    const next = { ...this.state.includeState };
    for (const file of files) {
      const previous = next[file];
      const selectable = previous?.selectable;
      next[file] = {
        kind: included ? 'all' : 'none',
        diverging: [],
        ...(selectable === undefined ? {} : { selectable }),
      };
    }
    this.emit({ includeState: next });
  }

  // ---------- 暂存动作 ----------

  private targetedFiles(): string[] {
    const selected = this.state.selectedFiles;
    if (selected.length > 0) return selected;
    return (this.state.status?.files ?? []).map((f) => f.path);
  }

  async stageSelected(): Promise<void> {
    const path = this.state.current;
    if (path === '') return;
    const files = this.targetedFiles();
    if (files.length === 0) return;
    this.emit({ busy: 'stage' });
    const result = await api.stage(path, files);
    this.emit({ busy: '' });
    if (!result.ok) {
      this.fail(result.error);
      return;
    }
    await this.afterIndexChange();
  }

  async unstageSelected(): Promise<void> {
    const path = this.state.current;
    if (path === '') return;
    const selected = this.state.selectedFiles;
    const files = selected.length > 0
      ? selected
      : (this.state.status?.files ?? []).filter((f) => f.staged !== undefined).map((f) => f.path);
    if (files.length === 0) return;
    this.emit({ busy: 'unstage' });
    const result = await api.unstage(path, files);
    this.emit({ busy: '' });
    if (!result.ok) {
      this.fail(result.error);
      return;
    }
    await this.afterIndexChange();
  }

  async stageFile(file: string): Promise<void> {
    const path = this.state.current;
    if (path === '') return;
    const result = await api.stage(path, [file]);
    if (!result.ok) {
      this.fail(result.error);
      return;
    }
    await this.afterIndexChange();
  }

  async unstageFile(file: string): Promise<void> {
    const path = this.state.current;
    if (path === '') return;
    const result = await api.unstage(path, [file]);
    if (!result.ok) {
      this.fail(result.error);
      return;
    }
    await this.afterIndexChange();
  }

  /**
   * 丢弃这些文件的改动。
   * @param files - 全部目标路径。
   * @param untrackedPaths - 其中属于未跟踪的子集(走 `git clean`);混批必须分开传。
   */
  async discardFiles(files: string[], untrackedPaths: string[]): Promise<void> {
    const path = this.state.current;
    if (path === '' || files.length === 0) return;
    this.emit({ busy: 'discard' });
    const result = await api.discard(path, files, untrackedPaths);
    this.emit({ busy: '' });
    if (!result.ok) {
      this.fail(result.error);
      return;
    }
    const allUntracked = untrackedPaths.length === files.length;
    this.toast(allUntracked ? '已删除未跟踪文件' : '已丢弃改动');
    await this.afterIndexChange();
  }

  private async afterIndexChange(): Promise<void> {
    // `refreshStatus()` 现在自己就会重取当前选中文件的 diff(照上游
    // `_loadStatus` 末尾 `app-store.ts:3018`),所以这里**不再**单独调 `loadDiff()` ——
    // 否则暂存/取消暂存/丢弃一个文件会打**两个** diff 请求。
    // 判据:`docs/probes/commit-include-state-probe.mjs` 的 P6(恰好 1 次)。
    await Promise.all([this.refreshStatus(), this.refreshLog(true)]);
  }

  // ---------- 提交 ----------

  setCommitField<K extends keyof CommitForm>(key: K, value: CommitForm[K]): void {
    this.emit({ commitForm: { ...this.state.commitForm, [key]: value } });
  }

  /**
   * 生成提交信息。
   *
   * 已经手写过摘要/描述时**不直接覆盖**:调用方应先弹确认再传 `force: true`
   * (Desktop 用 `Commit message override` 弹窗做同一件事)。
   * @param opts.force - true 表示用户已确认覆盖现有文本。
   */
  async generateCommitMessage(opts: { force?: boolean } = {}): Promise<void> {
    const path = this.state.current;
    if (path === '') return;
    if (opts.force !== true && this.state.commitForm.summary.trim() !== '') {
      // 交给界面弹确认;这里只标记「待确认」,不发起请求。
      this.emit({ pendingGenerateConfirm: true });
      return;
    }
    this.emit({ pendingGenerateConfirm: false });
    const status = this.state.status;
    if (status === null) return;
    // 生成依据的真源 = **纳入提交的文件/行选区**(`includedFiles()` / `includeState`),
    // 不是「索引里有什么」(那是两行制时代的模型,已下线)。
    //
    // `stagedOnly` 这个偏好保留、但语义已经换过:它现在表示
    // 「**只**依据纳入提交的变更生成」。旧名字不改(避免 `prefs` 迁移),
    // 旧语义(读 git 索引的 staged 位)已经废弃 —— host 侧 `collectDiffText`
    // 以前按 `file.staged` 过滤,在我们这套「勾选 = 纳入、不写索引」的模型下
    // **恒筛出 0 个文件**,所以这里曾经硬编码 `false` 绕过它。
    // 现在两边都按「纳入提交的文件清单」走。
    const included = this.includedFiles().map((f) => f.path);
    if (included.length === 0) {
      this.toast('请先勾选一个或多个文件', 'err');
      return;
    }
    // 勾选「只依据纳入提交的变更生成」时,送进模型的是**纳入的文件清单**;
    // 取消勾选时送**全部工作区变更**的清单(`status.files`)。
    // 两者都要送清单而不是送空数组 —— 送空数组会让 host 端 prompt 里的「涉及文件」
    // 退化成 `(见 diff)`,而 `collectDiffText` 又会回退成「全部变更」,
    // 于是「文件清单」与「diff 覆盖范围」不一致(模型会看到边界的差异)。
    const files = this.state.stagedOnly
      ? included
      : (status.files ?? []).map((f) => f.path);
    const [provider, ...rest] = this.state.model.split('/');
    const model = rest.join('/');
    if (provider === undefined || provider === '' || model === '') {
      this.toast('请先在设置里选择生成用的模型', 'err');
      return;
    }
    this.setCommitField('generating', true);
    const result = await api.generate({ path, files, stagedOnly: this.state.stagedOnly, provider, model });
    this.setCommitField('generating', false);
    if (!result.ok) {
      this.fail(result.error);
      return;
    }
    const hasUserText = this.state.commitForm.summary.trim() !== '';
    this.emit({
      commitForm: {
        ...this.state.commitForm,
        summary: result.value.title,
        description: result.value.description,
        generatedBy: `${result.value.provider}/${result.value.model}`,
      },
    });
    this.toast(hasUserText ? '已用生成结果覆盖了原来的摘要/描述' : '已生成提交信息');
  }

  /**
   * 撤销最近一次提交:`reset --mixed` 到父提交,改动回到工作区,并把提交信息回填表单。
   * (Desktop 的 undo-commit 条;第一个提交走 host 的 update-ref 分支。)
   * @param sha - 要撤销的提交。
   */
  async undoCommit(sha: string): Promise<void> {
    const path = this.state.current;
    if (path === '') return;
    this.emit({ busy: 'undo' });
    const result = await api.undoCommit(path, sha);
    this.emit({ busy: '' });
    if (!result.ok) {
      this.fail(result.error);
      return;
    }
    this.emit({
      commitForm: {
        ...initial().commitForm,
        summary: result.value.subject,
        description: result.value.body,
      },
    });
    this.toast('已撤销提交,改动保留在工作区');
    await this.refreshAll();
  }

  /**
 * 切换 Unified/Split(照 Desktop 的 setShowSideBySideDiff,持久化到 localStorage)。
 * @param value - true 为并排。
 */
setSideBySide(value: boolean): void {
  setShowSideBySideDiff(value);
  this.emit({ sideBySide: value });
}

/**
 * 切换「隐藏空白改动」,并**重新取 diff**。
 *
 * 这不是界面过滤而是重跑 `git diff -w`:实测 hunk 头会从 `@@ -1,5 +1,6 @@`
 * 变成 `@@ -3,3 +3,4 @@`,行号与真实补丁不再对应。所以旧 diff 必须作废,
 * 而隐藏期间**禁止行级暂存**(界面里也这么解释)。
 * @param value - true 为隐藏。
 */
async setHideWhitespace(value: boolean): Promise<void> {
  setHideWhitespaceInChangesDiff(value);
  this.emit({
    hideWhitespace: value,
    diff: null,
    diffKey: '',
    // 上游 `_setHideWhitespaceInChangesDiff`(`lib/stores/app-store.ts:7947-7957`,
    // 真值在 `:7956`)传的也是 `clearPartialState: true`。理由是同一个:隐藏空白是
    // **重跑 `git diff -w`**(键名与理由见本文件 `:979-982` 的注释),hunk 头会从
    // `@@ -1,5 +1,6 @@` 变成别的形状 ⇒ **行号空间变了**,旧的 partial 选区对新 diff
    // 没有意义。以前这里只撤 diff、不动 `includeState`,于是模型里留下一个按**旧行号**
    // 记着的 partial,提交时 `commit()` 会拿它去 materialize ⇒ 可能提交到错误的行。
    includeState: clearPartialAfterCommit(this.state.includeState),
  });
  await this.loadDiff();
}

/** 切换 History 的同一开关(Desktop 里两个开关独立);同样作废旧 diff 重取。 */
async setHideWhitespaceHistory(value: boolean): Promise<void> {
  setHideWhitespaceInHistoryDiff(value);
  this.emit({ hideWhitespaceHistory: value, diff: null, diffKey: '' });
  await this.loadDiff();
}

/**
   * 拉取本地工作区文件清单(Code 页签用)。
   *
   * 按仓库缓存:文件清单在一次浏览里不会变,重复展开目录不该反复起 git 进程。
   * 用户点刷新时传 force。
   * @param force - 忽略缓存重新拉取。
   */
  async loadRepoFiles(force = false): Promise<void> {
    const path = this.state.current;
    if (path === '') return;
    const cached = this.state.repoFiles;
    if (force !== true && cached !== null && cached.path === path) return;
    const result = await api.repoTree(path);
    if (!result.ok) { this.fail(result.error); return; }
    this.emit({ repoFiles: { path, files: result.value.files, truncated: result.value.truncated } });
  }

  /** 拉取本机可用的外部编辑器清单(只在需要时请求一次)。 */
  async loadExternalApps(): Promise<void> {
    if (this.state.externalApps.length > 0) return;
    const result = await api.systemApps();
    if (result.ok) this.emit({ externalApps: result.value.apps });
  }

  /**
   * 在文件管理器中显示该路径(Desktop 的 Show in Finder)。
   * @param path - 绝对路径;host 会校验它落在已添加的仓库内。
   */
  async revealInFileManager(path: string): Promise<void> {
    const result = await api.systemReveal(path);
    if (!result.ok) { this.fail(result.error); return; }
    if (!result.value.ok) this.toast('无法在文件管理器中打开该位置。', 'err');
  }

  /**
   * 用外部编辑器打开该路径(Desktop 的 Open in <editor>)。
   * @param path - 绝对路径。
   * @param appId - `externalApps` 里的 id;省略用系统默认应用。
   */
  async openInExternalEditor(path: string, appId?: string): Promise<void> {
    const result = await api.systemOpenInApp(path, appId);
    if (!result.ok) { this.fail(result.error); return; }
    if (!result.value.ok) this.toast('无法用外部编辑器打开。', 'err');
  }

  async commit(): Promise<void> {
    const path = this.state.current;
    const status = this.state.status;
    if (path === '' || status === null) return;
    const form = this.state.commitForm;
    if (form.summary.trim() === '' && !form.amend) {
      this.toast('请填写提交摘要', 'err');
      return;
    }
    if (status.conflictedCount > 0) {
      this.toast('还有未解决的冲突,解决后再提交', 'err');
      return;
    }
    // 提交哪些文件由**客户端的纳入状态**决定(上游 `app-store.ts:3702-3705`:
    // `file.selection.getSelectionType() !== DiffSelectionType.None`)。
    const included = this.includedFiles();
    const files = included.map((f) => f.path);
    if (files.length === 0 && !form.amend && !form.allowEmpty) {
      this.toast('请先勾选一个或多个文件', 'err');
      return;
    }
    this.emit({ busy: 'commit' });

    // ---------- materialize:把客户端模型写进索引 ----------
    //
    // 照上游 `lib/git/commit.ts:24-31` 的顺序:
    //   1) `unstageAll`  —— 先把变更文件的索引位清空(索引 == HEAD)。上游注释写得很直白:
    //      「我们的 diff 反映的是工作区与上一次提交的差别,所以提交也该这么做」;
    //   2) `stageFiles` —— 按每个文件的 selection 分流:`All` 走整文件 `git add`,
    //      `Partial` 走 `apply --cached --unidiff-zero`(上游 `update-index.ts:109-175`)。
    //
    // 我们在这里**用客户端自己的三条已有路由**做同一件事,而不是新增一条宿主路由:
    // 语义完全一致(同一串 git 命令、同一顺序),但不需要等重启,也不会出现
    // 「界面已经用新模型、宿主还按旧索引提交」那种会提交错内容的窗口。
    // 宿主 `git-service.ts:341-348` 的「不要重建索引」注释在**宿主侧**依然成立:
    // 它接手时索引已经等于用户的勾选,它只管 commit。
    const unstage = await api.unstage(path, status.files.map((f) => f.path));
    if (!unstage.ok) { this.emit({ busy: '' }); this.fail(unstage.error); return; }

    const wholeFiles = included
      .filter((f) => includeStateOf(this.state.includeState[f.path]) === 'all')
      .map((f) => f.path);
    if (wholeFiles.length > 0) {
      // 一条 `git add -- <paths>` 覆盖所有整文件纳入的路径(上游 `stageFiles` 也是批量)。
      const stage = await api.stage(path, wholeFiles);
      if (!stage.ok) { this.emit({ busy: '' }); this.fail(stage.error); return; }
    }

    const partialFiles = included.filter(
      (f) => includeStateOf(this.state.includeState[f.path]) === 'partial',
    );
    for (const file of partialFiles) {
      const spec = this.state.includeState[file.path];
      if (spec === undefined) continue;
      // 兜底:`stageLines` 的补丁基准是**索引→工作区**,而索引刚被清空成 HEAD。
      // 对「未跟踪/新增」文件那条命令输出为空(host 会以 bad-request 失败),
      // 对索引里原本就有内容的文件则下标空间可能对不上。这两种情况退回整文件纳入,
      // 并**明确告诉用户**(不静默)。
      if (file.untracked === true || file.staged !== undefined) {
        const fallback = await api.stage(path, [file.path]);
        if (!fallback.ok) { this.emit({ busy: '' }); this.fail(fallback.error); return; }
        this.toast(`${file.path} 暂不支持行级选择,已按整文件纳入提交`, 'err');
        continue;
      }
      // 走到这里已经排除了 untracked(上面那条兜底)与 staged(索引已有内容),
      // 所以 kind 只需要工作区那一侧的状态字母。
      const partial = await api.stageLines(
        path, file.path,
        fileStatusKindOf(file.unstaged !== undefined ? { status: file.unstaged } : {}),
        spec,
      );
      if (!partial.ok) {
        this.emit({ busy: '' });
        this.fail(partial.error);
        this.toast('部分暂存失败,提交已中止(索引里现在只有已成功暂存的部分)', 'err');
        await this.refreshStatus();
        return;
      }
    }

    const result = await api.commit({
      path,
      message: form.summary,
      ...(form.description.trim() !== '' ? { description: form.description } : {}),
      files,
      amend: form.amend,
      signoff: form.signoff,
      noVerify: form.noVerify,
      allowEmpty: form.allowEmpty,
    });
    this.emit({ busy: '' });
    if (!result.ok) {
      this.fail(result.error);
      return;
    }
    /*
     * 上游 `app-store.ts:3779-3797` 的 `_refreshRepositoryAfterCommit`:
     * **修订**（amend）之后如果新 sha 与被修订的那个 sha 不同，就把当前分支记进
     * 「建议强推」表 —— 因为远端上那条被改写的提交还在，本地与远端**必然分叉**，
     * 这时上游的同步按钮会变成「Force push」而不是「Pull」。
     *
     * `status` 是本方法开头取的那份**提交前**的快照，它的 `headSha` 正是被修订的
     * 那个提交（amend 改的就是 HEAD）⇒ 与上游传进去的 `amendedCommit.sha` 同义。
     */
    if (form.amend) {
      this.addBranchToForcePushList(status.branch, status.headSha, result.value.sha);
    }
    // 提交成功后重置表单,但**只重置这一批**(照 Desktop 的 app-store.ts:3743-3748):
    // 只把 allowEmptyCommit 强制回 false,而 signoff / noVerify 要保留 ——
    // 连续提交时用户不必每次都重新勾「签名」和「绕过钩子」。
    const base = initial().commitForm;
    this.emit({
      commitForm: {
        ...base,
        signoff: form.signoff,
        noVerify: form.noVerify,
      },
      selectedCommit: result.value.sha,
      // 提交完成后**只**把行级部分选(partial)降级成不含;`All` 与用户
      // **显式取消勾选**的 `None` 原样保留 —— 照上游 `clearPartialState: true`
      // (`lib/stores/app-store.ts:3756-3759`,真值在 `:3758`
      //  → `lib/stores/updates/changes-state.ts:47-56`)。
      // 以前这里是 `includeState: {}`(整张抹掉),而本仓「缺失 = 默认 All」,
      // 于是用户明确排除的文件会在下一次提交里被静默带上。
      includeState: clearPartialAfterCommit(this.state.includeState),
    });
    this.toast(form.amend ? '已修改上一次提交' : `已提交 ${result.value.sha.slice(0, 7)}`);
    await this.refreshAll();
    await this.loadCommitDetail(result.value.sha);
  }

  // ---------- 历史 ----------

  async selectCommit(sha: string): Promise<void> {
    this.emit({ selectedCommit: sha, commitDetailFiles: [] });
    await this.loadCommitDetail(sha);
  }

  async loadCommitDetail(sha: string): Promise<void> {
    const path = this.state.current;
    if (path === '' || sha === '') return;
    const result = await api.commitDetail(path, sha);
    if (result.ok) {
      this.emit({ commitDetailFiles: result.value.files });
    }
  }

  // ---------- 同步 ----------
  //
  // 这一段是上游两层的**合成**,每一处都对着上游的行号:
  //
  //   | 上游 | 是什么 |
  //   |---|---|
  //   | `lib/git/fetch.ts:40` / `pull.ts:26` / `push.ts:47` | 一次网络动作:发**初始进度**,再跑 git |
  //   | `lib/stores/app-store.ts:5949`(performFetch)/ `:5484`(performPull)/ `:5216`(performPush) | 权重合成 + 刷新阶段 + `finally` 置空 |
  //   | `lib/stores/app-store.ts:5452`(withPushPullFetch) | 网络动作互斥(`isPushPullFetchInProgress`) |
  //
  // **为什么合成而不是按子类分别沿用**:上游把「谁在跑」放在 `AppStore`+`GitStore` 两层,
  // 而浏览器半只有这一层(host 才是 git 那一层)。行为面逐条对齐,命名保持可对照。

  /**
   * 网络动作的**远端名** —— 判定只有一份,在 `sync-state.ts` 的 `remoteNameOf()`
   * (它是上游 `ui/app.tsx:3620-3633` 的逐条移植,含「上游分支名 ≠ 本地分支名 ⇒ 给全名」
   * 那个看着像笔误但确实是上游行为的分支)。`performPush`(`app-store.ts:5243`)同源。
   *
   * 单一真源:进度标题、按钮标题(`toolbar.tsx` 的 `remoteName` prop)、
   * `dropCurrentBranchFromForcePushList` 都不用各自再判一次。
   */
  private networkRemoteName(): string {
    return remoteNameOf(this.state) ?? '';
  }

  /**
   * 上游 `app-store.ts:5168` 的 `updatePushPullFetchProgress`。
   *
   * 上游多一个 `if (this.selectedRepository === repository) this.emitUpdate()` —— 那是
   * 「选中仓库才重渲染」的优化,我们只有一个快照,`emit` 本身就是那个语义。
   */
  private updateSyncProgress(progress: Progress | null): void {
    if (this.state.progress === null && progress === null) {
      return;
    }
    this.emit({ progress });
  }

  /**
   * 上游 `app-store.ts:9676` 的 `_addBranchToForcePushList`。
   *
   * 判据与上游一致(`:9681-9683`):**sha 没变就不进表** —— 那正是「amend 只是改了
   * 信息、历史没变」的情况,这时不该建议强推。
   */
  private addBranchToForcePushList(branch: string, beforeChangeSha: string, afterChangeSha: string): void {
    if (branch === '' || afterChangeSha === '' || afterChangeSha === beforeChangeSha) {
      return;
    }
    if (this.state.forcePushBranches[branch] === afterChangeSha) {
      return;
    }
    this.emit({ forcePushBranches: { ...this.state.forcePushBranches, [branch]: afterChangeSha } });
  }

  /**
   * 上游 `ui/dispatcher/dispatcher.ts:1327` 的 `dropCurrentBranchFromForcePushList`。
   *
   * 调用点也是沿用的:`pushWithOptions`(`dispatcher.ts:748-752`)在
   * `forceWithLease` 时**先**把当前分支从表里删掉,再推 —— 强推成功之后
   * 「建议强推」的根据就不存在了(本地与远端又一致了)。
   */
  private dropCurrentBranchFromForcePushList(): void {
    const branch = this.state.status?.branch ?? '';
    if (branch === '' || this.state.forcePushBranches[branch] === undefined) {
      return;
    }
    const next = { ...this.state.forcePushBranches };
    delete next[branch];
    this.emit({ forcePushBranches: next });
  }

  /**
   * 网络动作返回后的**刷新阶段**进度。
   *
   * 上游在 fetch / pull / push 三支里各写了一遍(标题 + 两条 generic 进度),
   * 形状与**权重来源**逐字对齐:
   *
   * ```text
   * fetch : fetchWeight 0.9(不缩放),refreshWeight 0.1      (app-store.ts:5968-6000)
   * pull  : pullWeight  2, fetchWeight 1, refreshWeight 0.1  (app-store.ts:5535-5618)
   * push  : pushWeight  2.5, fetchWeight 1, refreshWeight 0.1(app-store.ts:5246-5367)
   *         pull/push 才做 `scale = (1/(w1+w2)) * (1-refreshWeight)` 的两次重标定;
   *         fetch 直接用 0.9(`lib/git/fetch.ts:84` 之后 updater 里 `value * fetchWeight`)。
   *         三支的 `refreshStartProgress = w1 + w2`(重标定后)都等于 0.9。
   * ```
   *
   * 我们这一侧 host 的每条同步路由只跑**一条** git 命令(pull 的 fast-forward 由 git
   * 自己完成,没有上游那个 `fastForwardBranches` + `_refreshRepository` 的后续),
   * 所以「刷新阶段」在这里就是 `refreshAll()`。进度值取上游在该阶段的**起始**权重 ——
   * 与上游同义(「网络阶段已经跑完了」),不是估的。
   *
   * @param title - 上游 fetch/pull/push 三支都写同一个标题(`Refreshing repository`)。
   * @param completedWeight - 上游该支的 `refreshStartProgress`。
   */
  private async refreshAfterNetworkAction(title: string, completedWeight: number): Promise<void> {
    const refreshWeight = 0.1;
    this.updateSyncProgress({
      kind: 'generic',
      title,
      // 上游 `:5991` / `:5360` / `:5612` 的 `description: 'Fast-forwarding branches'`。
      // 它会被 `push-pull-button.tsx:521` 当作 `tooltip` 渲染(用户可见)⇒ 按 §11.9 用中文。
      description: '正在快进分支',
      value: completedWeight,
    });
    await this.refreshAll();
    this.updateSyncProgress({
      kind: 'generic',
      title,
      value: completedWeight + refreshWeight * 0.5,
    });
  }

  /**
   * 按同步按钮**算好的动作**执行,而不是在这里重新判断一次条件 ——
   * 两处各判一次会让「按钮显示发布分支、点击却去拉取」这类不一致发生。
   *
   * 三个分支现在**只转发**到下面三个同名的上游动作上,不再各写一遍 ——
   * 否则 `progress` 的初始值/置空会在两处实现里漂移(上一版正是这样:
   * `runSyncAction` 与 `fetch`/`pull`/`push` 各有一套)。
   * @param action - 由 `syncPresentation` 决定:fetch / pull / push / none。
   */
  public async runSyncAction(action: 'fetch' | 'pull' | 'push' | 'none'): Promise<void> {
    switch (action) {
      case 'fetch':
        return this.fetch();
      case 'pull':
        return this.pull();
      case 'push':
        return this.push(false);
      case 'none':
      default:
        return;
    }
  }

  /**
   * 抓取 —— 上游 `lib/git/fetch.ts:40` + `app-store.ts:5949` 的 `performFetch`。
   * @param remote - 只抓一个远端(上游 `fetchRemotes` 那一支);省略 = 全部。
   */
  public async fetch(remote?: string): Promise<void> {
    const path = this.state.current;
    if (path === '') {
      return;
    }
    const remoteName = remote ?? this.networkRemoteName();
    // 上游 `withPushPullFetch`(`app-store.ts:5452-5461`):已经在跑就直接返回,
    // 不允许并发网络动作 —— 这也是「进度不会互相盖掉」的前提。
    if (this.isNetworkActionInProgress()) {
      return;
    }
    this.emit({ busy: 'fetch' });
    /*
     * 上游 `lib/git/fetch.ts:83-84` 的**初始进度**:
     *   progressCallback({ kind, title, value: 0, remote: remote.name })
     * 标题是 `` `Fetching ${remote.name}` ``(`:52`),我们这层按 §11.9 用中文。
     */
    this.updateSyncProgress({ kind: 'fetch', title: `正在抓取 ${remoteName}`, value: 0, remote: remoteName });
    try {
      const result = await api.fetch(path, remote);
      if (!result.ok) {
        this.fail(result.error);
        return;
      }
      // 上游 `:5968-5971` 的权重:fetchWeight 0.9 / refreshWeight 0.1(**不做两次重标定**)。
      const fetchWeight = 0.9;
      await this.refreshAfterNetworkAction('正在刷新仓库', fetchWeight);
      this.toast('已抓取远端');
    } finally {
      this.updateSyncProgress(null);
      this.emit({ busy: '' });
    }
  }

  /**
   * 拉取 —— 上游 `lib/git/pull.ts:26` + `app-store.ts:5484` 的 `performPull`。
   *
   * @param rebase - 这个仓库**生效**的 `pull.rebase`,也就是渲染按钮文案的同一个值
   *   (`SyncState.pullWithRebase`)。上游是同一个形状:顶栏把
   *   `pullWithRebase || false` 交给 `pullButton(...)` 的 `onClick`
   *   (`ui/toolbar/push-pull-button.tsx:497`),于是**一个值**同时决定文案与动作。
   *
   *   **省略 = 不表态**,由宿主自己读配置 —— 这不是「两种行为」,
   *   而是**同一个** git 配置的第二次读取:省略的那几个调用点
   *   (`workbench.tsx:726` 的「更多 ▸ 拉取」、`runSyncAction('pull')`)本来就没有
   *   「按钮文案」要与执行对齐。顶栏那条路径**必须**给值,否则文案与执行又分家。
   */
  public async pull(rebase?: boolean): Promise<void> {
    const path = this.state.current;
    if (path === '') {
      return;
    }
    const remoteName = this.networkRemoteName();
    if (this.isNetworkActionInProgress()) {
      return;
    }
    this.emit({ busy: 'pull' });
    /* 上游 `lib/git/pull.ts:99-100` 的初始进度(标题在 `:67`)。 */
    this.updateSyncProgress({ kind: 'pull', title: `正在拉取 ${remoteName}`, value: 0, remote: remoteName });
    try {
      const result = await api.pull(path, rebase);
      if (!result.ok) {
        this.fail(result.error);
        return;
      }
      // 上游 `:5535-5547` 的权重重标定,逐字:
      //   let pullWeight = 2; let fetchWeight = 1; const refreshWeight = 0.1
      //   const scale = (1 / (pullWeight + fetchWeight)) * (1 - refreshWeight)
      //   pullWeight *= scale; fetchWeight *= scale   ⇒ 起点 = (2+1)*scale = 0.9
      const scale = (1 / (2 + 1)) * (1 - 0.1);
      await this.refreshAfterNetworkAction('正在刷新仓库', (2 + 1) * scale);
      this.toast('已拉取');
    } finally {
      this.updateSyncProgress(null);
      this.emit({ busy: '' });
    }
  }

  /**
   * 推送 / 强推 —— 上游 `lib/git/push.ts:47` + `app-store.ts:5216` 的 `performPush`,
   * 强推那一支的「先删表项再推」照 `ui/dispatcher/dispatcher.ts:748-752`。
   * @param force - true = `--force-with-lease`(上游 `forceWithLease`)。
   */
  public async push(force: boolean): Promise<void> {
    const path = this.state.current;
    if (path === '') {
      return;
    }
    const remoteName = this.networkRemoteName();
    const branch = this.state.status?.branch ?? '';
    if (this.isNetworkActionInProgress()) {
      return;
    }
    // 上游 `pushWithOptions`:`forceWithLease` 时先 drop(`dispatcher.ts:748-752`),
    // 顺序也是契约 —— 推完再 drop 会让「推成功了但按钮还写着强推」出现一帧。
    if (force) {
      this.dropCurrentBranchFromForcePushList();
    }
    this.emit({ busy: 'push' });
    /*
     * 上游 `app-store.ts:5244-5250` 的初始进度(**推送唯一一条会带 branch 的**):
     *   { kind:'push', title: `Pushing to ${remoteName}`, value: 0, remote, branch }
     * 上游标题里的 `remoteName` 是 `branch.upstreamRemoteName || remote.name`(`:5243`),
     * 与本方法的 `networkRemoteName()` 同源。
     */
    this.updateSyncProgress({
      kind: 'push',
      title: `正在推送到 ${remoteName}`,
      value: 0,
      remote: remoteName,
      branch,
    });
    try {
      const result = await api.push(path, force);
      if (!result.ok) {
        // 推送被拒(远端有新提交)→ 给出可操作提示而不是干巴巴报错。
        if (result.error.code === 'not-fast-forward') {
          this.toast('推送被拒:远端有新提交,请先拉取(同步按钮会变成「拉取」)。', 'err');
        } else {
          this.fail(result.error);
        }
        return;
      }
      // 上游 `:5246-5248` + `:5255-2575` 的权重重标定,逐字:
      //   let pushWeight = 2.5; let fetchWeight = 1; const refreshWeight = 0.1
      //   const scale = (1 / (pushWeight + fetchWeight)) * (1 - refreshWeight)
      //   pushWeight *= scale; fetchWeight *= scale   ⇒ 起点 = (2.5+1)*scale = 0.9
      const scale = (1 / (2.5 + 1)) * (1 - 0.1);
      await this.refreshAfterNetworkAction('正在刷新仓库', (2.5 + 1) * scale);
      this.toast(force ? '已强推(--force-with-lease)' : '已推送');
    } finally {
      this.updateSyncProgress(null);
      this.emit({ busy: '' });
    }
  }

  /**
   * 上游 `withPushPullFetch`(`app-store.ts:5452-5475`)的互斥判据 —— 已经有网络动作在跑。
   *
   * 读侧投影(**视图层要看的那一条**)在 `src/client/sync-state.ts` 的
   * `networkActionInProgress(snap)` —— **判据只有那一份**,这里直接调它,
   * 免得「写入侧允不允许并发」与「按钮转不转圈」在某天悄悄分叉。
   * 判据是 `progress !== null` 而不是 `busy !== ''`:`busy` 里还有
   * `commit` / `stage` / `checkout` 等**非网络**动作(`lib/app-state.ts:597` 的
   * `isPushPullFetchInProgress` 是同义的收窄)。
   */
  private isNetworkActionInProgress(): boolean {
    return networkActionInProgress(this.state);
  }

  // ---------- 分支 ----------

  async checkout(branch: string, createFromRemote?: string): Promise<void> {
    const path = this.state.current;
    if (path === '') return;
    this.emit({ busy: 'checkout' });
    const result = await api.checkout(path, branch, createFromRemote);
    this.emit({ busy: '' });
    if (!result.ok) {
      this.fail(result.error);
      return;
    }
    this.toast(`已切到 ${branch}`);
    await this.refreshAll();
  }

  async createBranch(name: string, startPoint?: string): Promise<void> {
    const path = this.state.current;
    if (path === '') return;
    const result = await api.createBranch(path, name, startPoint);
    if (!result.ok) {
      this.fail(result.error);
      return;
    }
    this.toast(`已创建分支 ${name}`);
    await this.checkout(name);
  }

  // ---------- 设置 ----------

  setModel(model: string): void {
    this.emit({ model });
  }

  /**
   * 默认模型;同时落盘(与 {@link setStagedOnlyPersisted} 同形)。
   *
   * 为什么需要它:设置面板的「默认模型」下拉一直调的是这个**不存在**的方法
   * (`settings.tsx:357`),运行期 `TypeError: store.setModelPersisted is not a
   * function` —— 换模型这个动作从来没生效过。host 侧本来就完整支持这条链路:
   * `api.setPrefs({ model })`(`api.ts:130`)→ `prefs/set`(`host/routes.ts:305`)
   * → `registry.setPrefs`(`repo-registry.ts:271`);而 `prefModel()` 是 host 生成
   * 提交信息时**真正使用**的模型(`src/index.ts:364` 的 `pinnedModel`)。
   *
   * **`await` 落盘结果再改界面**:以前是 `void api.setPrefs(...)` + 立刻 emit ——
   * 写盘失败(磁盘满 / 权限变化)时界面照样显示新值,而 host 还是旧值 ⇒
   * 下一次刷新又弹回去,用户看到的是「设置存不住」。这类「乐观更新掩盖写入失败」
   * 与只写不读是同一族静默缺陷。现在失败就**回滚**并报错。
   * @returns 落盘成功时为 true(界面无需回滚)。
   */
  async setModelPersisted(model: string): Promise<boolean> {
    const previous = this.state.model;
    this.setModel(model);
    const result = await api.setPrefs({ model });
    if (!result.ok) {
      this.setModel(previous);
      this.fail(result.error);
      return false;
    }
    return true;
  }

  /**
   * 生成范围偏好(「只依据纳入提交的变更生成」);同时落盘。
   *
   * 语义在 2026-10-06 由人类裁决换过:键名仍是 `stagedOnly`(避免 `prefs` 迁移),
   * 但载体从「git 索引的 staged 位」换成「纳入提交的文件清单」——
   * 旧载体在「勾选 = 纳入、不写索引」的模型下已经不存在。
   * 详见 `docs/design.md` §17.4 与 `host/routes.ts` 的 `collectDiffText`。
   * @returns 落盘成功时为 true。
   */
  async setStagedOnlyPersisted(value: boolean): Promise<boolean> {
    const previous = this.state.stagedOnly;
    this.setStagedOnly(value);
    const result = await api.setPrefs({ stagedOnly: value });
    if (!result.ok) {
      this.setStagedOnly(previous);
      this.fail(result.error);
      return false;
    }
    return true;
  }

  setStagedOnly(value: boolean): void {
    this.emit({ stagedOnly: value });
  }

  /**
   * 读回 host 已落盘的生成偏好(模型 pin / 生成范围)。
   *
   * **这条读回路以前完全不存在**,是「存储有问题」这条报告的根因:
   *  - `prefs.model` 只写不读 ⇒ 刷新后 `loadModels()` 把下拉重置成 `models[0]`,
   *    而 host 生成提交信息用的是 `prefs.model`(磁盘上的 pin)——
   *    界面显示的模型与真正生效的模型**静默分叉**;
   *  - `prefs.stagedOnly` 只写不读 ⇒ 勾选框每次刷新/重启都弹回默认 `true`。
   *
   * 实测证据(真 HTTP + 真 store,`scripts/probe-prefs-roundtrip.mjs`):
   * 修前「选 provB/model-b → 刷新」显示 provA/model-a;
   * 「取消勾选 → 刷新」显示 true。
   *
   * 调用时机:必须在 {@link loadModels} **之前** await,否则 loadModels 会先
   * 用 `models[0]` 占掉 `state.model`,这里的 pin 就再也进不去(两者都是 emit,
   * 后写的赢)。
   *
   * 不在这里校验 pin 是否仍在模型清单里:清单是异步拿的,校验交给
   * {@link loadModels} 的现有判据(model 不在清单里就退回 models[0])。
   */
  async loadPrefs(): Promise<void> {
    const result = await api.prefs();
    if (!result.ok) return;
    const patch: Partial<Snapshot> = {};
    const { model, stagedOnly } = result.value;
    if (model !== undefined && model !== '') patch.model = model;
    if (stagedOnly !== undefined) patch.stagedOnly = stagedOnly;
    if (Object.keys(patch).length > 0) this.emit(patch);
  }

  async loadModels(): Promise<void> {
    const result = await api.models();
    if (!result.ok) return;
    const models = result.value.models;
    const current = this.state.model !== '' && models.some((m) => `${m.provider}/${m.id}` === this.state.model)
      ? this.state.model
      : (models[0] !== undefined ? `${models[0].provider}/${models[0].id}` : '');
    this.emit({ models, model: current });
  }

  async loadAuth(): Promise<void> {
    const result = await api.authState();
    if (result.ok) this.emit({ auth: result.value });
  }

  /**
   * 拉取可克隆的远程仓库清单。
   *
   * **未登录时不发请求**:以前每个打开下拉/克隆弹窗的动作都会打一次 host,
   * host 只能回「未登录」,于是日志被 `未登录 GitHub,无法列出远程仓库。` 刷屏
   * (实测一次运行 20+ 条),把真正要看的 `已注册 /dsh-git/*` 和自检结果淹掉。
   * 未登录是**正常状态**,不是错误。
   * @param force - true 表示用户显式点了刷新,忽略 5 分钟缓存。
   */
  async loadRemoteRepos(force = false): Promise<void> {
    // 把判定先读进一个**局部常量**,再进分支。
    //
    // 为什么不能直接写 `if (this.state.auth?.signedIn !== true) { … await …;
    // if (this.state.auth?.signedIn !== true) return }`:tsc 会把第一层 guard 的
    // 收窄(`false | undefined`)一直带到 `await` 之后,**不认** `loadAuth()` 里
    // `emit()` 换掉整个快照这件事 —— 于是第二条判定被当成「`false|undefined`
    // 与 `true` 无交集」的恒假比较(TS2367),那个「重新读一次登录态」的分支
    // 会被当成死代码。判定本身在运行期是**有意义**的(await 期间 snapshot 可能
    // 已经从「未登录」变成「已登录」),所以这里保留语义、只换个写法让编译器
    // 能看见第二次读取。
    const signedIn = this.state.auth?.signedIn === true;
    if (!signedIn) {
      // 还没拿到登录态:先读一次 auth,再决定要不要发请求。
      await this.loadAuth();
      if (this.state.auth?.signedIn !== true) return;
    }
    this.emit({ remoteReposLoading: true });
    const result = await api.remoteRepos(force);
    this.emit({ remoteReposLoading: false });
    if (!result.ok) {
      this.fail(result.error);
      return;
    }
    this.emit({ remoteRepos: result.value.repos, hidden: result.value.hidden });
  }

  async hideRemote(fullName: string): Promise<void> {
    const result = await api.hideRemote(fullName);
    if (result.ok) this.emit({ hidden: result.value.hidden });
  }

  async unhideRemote(fullName: string): Promise<void> {
    const result = await api.unhideRemote(fullName);
    if (result.ok) this.emit({ hidden: result.value.hidden });
  }

  async setPat(token: string): Promise<boolean> {
    const result = await api.setPat(token);
    if (!result.ok) {
      this.fail(result.error);
      return false;
    }
    this.emit({ auth: result.value });
    this.toast(result.value.signedIn ? `已登录 @${result.value.login}` : '已退出登录');
    await this.loadRemoteRepos(true);
    return true;
  }

  async logout(): Promise<void> {
    const result = await api.logout();
    if (!result.ok) {
      this.fail(result.error);
      return;
    }
    /*
     * 登出后的「空账号」字面量。
     *
     * ⚠️ `endpoint` 是必填(host 线的 `AuthStatePayload` 扩展,用于多端点账号):
     * 登出后回到默认端点 `https://api.github.com`。不要把它改回可选 ——
     * 那会让「消费方忘了兜底」变成静默的空字符串,而端点为空时
     * `accountEmails` / 头像判定都会打到错误的 host 上。
     */
    this.emit({ auth: { signedIn: false, login: '', tokenTail: '', endpoint: 'https://api.github.com', deviceFlow: this.state.auth?.deviceFlow ?? false, viaDeviceFlow: false }, remoteRepos: [] });
    this.toast('已退出登录');
  }

  setAuth(state: AuthStatePayload): void {
    this.emit({ auth: state });
  }
}

export { unwrap };
export type { ChangedFile, RepoStatus, SyncState, BranchEntry, CommitEntry, DiffResult };
