import { ensureDugiteGitDirectory, type IDugiteGitEnv } from './dugite-env.ts';
/*
 * `localStorage` / `log` / `location`(以及 `__DEV__` 那几个构建期常量)
 * 由 **esbuild `inject`** 换成 `src/host/desktop-globals.ts` 的导出 ——
 * 见 `scripts/build.mjs` 宿主构建的 `inject`。
 *
 * ⚠️ **刻意不写 `globalThis`**:宿主是跑在 DSH 进程里的插件,往进程全局写
 * `log` 这种通用名会与 DSH 或别的插件撞。`inject` 只作用于被 esbuild 打包的
 * 文件,一个字节都不写进程全局。
 */
import { setMirrorLogger } from './desktop-globals.ts';
import { GitStore } from './mirror/lib/stores/git-store.ts';
import { Repository } from './mirror/models/repository.ts';
import type { IRemote } from './mirror/models/remote.ts';
import type { IFetchProgress } from './mirror/models/progress.ts';
import { StatsStore } from './mirror/lib/stats/index.ts';
import { shell } from './mirror/lib/app-shell.ts';
import {
  hasTrampolineEnvProvider,
  setTrampolineEnvProvider,
} from './mirror/lib/trampoline/trampoline-environment.ts';

/**
 * **宿主半的镜像编排层入口** —— 让上游 `lib/stores/git-store.ts` 真的跑起来。
 *
 * ## 这个文件解决的那条账
 *
 * `docs/push-origin-chain-mirror-audit.md` §5 量出来的缺口:
 * 上游 `app-store.ts:5341-5347` 在**推送成功之后**会
 * `fetchRemotes([safeRemote], …)`,而我们的 `refreshAfterNetworkAction`
 * 只 `refreshAll()`(**零 fetch**)⇒ 实测「一次推送之后
 * `refs/remotes/origin/main` 是陈旧的,真远端已经往前走了」。
 *
 * 本文件把那一步换成**上游那一份**:`GitStore.fetchRemotes`
 * (`lib/stores/git-store.ts:1042-1066`)→ `fetchRemote`(`:1069-1111`)
 * → `fetch()`(`lib/git/fetch.ts`,逐字镜像)→ `updateRemoteHEAD`
 * (`lib/git/remote.ts`,逐字镜像)。**没有一个字节是我们重写的**。
 *
 * ## 为什么是 `GitStore`,而不是「我们照抄一个 fetch 循环」
 *
 * `fetchRemotes` 看着只有 25 行,但它把三件事绑在一起:权重归一化
 * (`1 / remotes.length`)、`performFailableOperation` 的**失败不致命**
 * 语义(推送已经成功了,刷新失败不该把推送判成失败)、以及
 * `updateRemoteHEAD`。自己写一份就是**第二套机制**,而它的失败语义
 * 会与上游慢慢分叉 —— 那正是这条线反复踩的坑。
 *
 * ## `GitStore` 需要什么(逐条)
 *
 * | 构造参数 | 宿主给什么 |
 * |---|---|
 * | `repository: Repository` | {@link repositoryFor} —— 由仓库**路径**合成;`gitHubRepository: null`(宿主没有 GitHub 仓库数据面) |
 * | `shell: IAppShell` | `mirror/lib/app-shell.ts` 的**会抛错**替身。实测 `GitStore` **一次都没用过它**(`grep -n 'this\.shell' lib/stores/git-store.ts` = 0),所以这不影响 push/fetch |
 * | `statsStore: IStatsStore` | `mirror/lib/stats/index.ts` 的内存实现 |
 *
 * ## ⚠️ 标签清单:**刻意不接**(用户尚未裁决 A/B)
 *
 * 上游的 `_tagsToPush` 是「在 Desktop 里建过、还没推成功、本地还在」的**策展清单**,
 * 落 `localStorage`(按 `repository.id` 分仓)。本文件里有三件事是**刻意**的:
 *
 * 1. `GitStore` 的构造函数**会**读它(`getTagsToPush(repository)`)—— 宿主的
 *    `localStorage` 是 `src/host/desktop-globals.ts` 那份**内存空表**,
 *    所以读出来**恒为 `[]`**;
 * 2. 宿主**从不**调 `addTagToPush`(那要接 `createTag`),所以它**永远是空**;
 * 3. 因此本模块**不**导出 `tagsToPush`,推送路径也拿不到它
 *    —— 见 `src/host/git-service.ts` 的 `push()`,它**不传** tag refspec。
 *
 * ⇒ 结果是:**全仓只有一份「未推送标签」清单**(宿主现算的 `tag-unpushed` 路由
 * → `snap.tagsToPush`),显示与 argv 读的是**同一个**来源,
 * **不可能**出现「显示说 N、推送发 M」的混合版(那会复现用户报的
 * 「推完角标不掉到 0」)。等用户的 A/B 裁决下来,要么把 `tagsToPush` 从这里接出去
 * (B),要么把现算清单塞进 `pushRepo`(A)—— 两条路都必须**同时**改显示与 argv。
 *
 * ## 诚实边界
 *
 * 1. **推送命令本身没有换成上游 `lib/git/push.ts`**:那条路是
 *    `ctx.subprocess`(DSH 的受管子进程:超时、可中断、宿主的凭据注入),
 *    换掉它要同时换掉凭据与超时语义 ⇒ 属**另一条切片**,见
 *    `docs/host-mirror-wiring.md`。本文件换掉的是**推送之后那一步**。
 * 2. GIT 只用 dugite 一条路(它自己 spawn git),不走 `ctx.subprocess`;
 *    解析出的 git 发行版前缀见 `src/host/dugite-env.ts`。
 * 3. `updateRemoteHEAD` 失败时上游只 `log.error` —— 我们照做,但接了
 *    {@link setMirrorGitLogger} 就能把它播出去(默认走 console)。
 *
 * @module dsh-git/host/mirror-git
 */

/** 一个仓库的 `GitStore` 缓存(`fetchRemotes` 是无状态的,但上游 store 按仓库建)。 */
const storesByRoot = new Map<string, GitStore>();

/** 合成 `Repository` 的缓存 —— 上游的 `Repository.hash` 是结构哈希,同一路径应当拿到同一份。 */
const repositoriesByRoot = new Map<string, Repository>();

/** 当前已接上的凭据环境提供者(探针的阳性对照读它)。 */
let credentialEnvProvider:
  | (() => Readonly<Record<string, string>>)
  | undefined;

/** 宿主日志落点(默认 console;`src/index.ts` 可以换掉)。 */
let logSink: (message: string, error?: Error) => void = (message, error) => {
  console.warn(`[dsh-git/mirror-git] ${message}`, error ?? '');
};

/**
 * 由仓库根路径合成一个上游 `Repository`。
 *
 * 形状选择(每一条都影响行为,所以写下来):
 *   · `id`:按路径**稳定**派生(哈希),而不是自增 —— 上游用它做
 *     `localStorage` 的键与 `commitLookup` 的分仓,自增会让「同一个仓库在两次
 *     调用里拿到不同 id」;
 *   · `gitHubRepository: null`:宿主没有 GitHub 仓库数据面,所以
 *     `getFallbackUrlForProxyResolve` 会走 `currentRemote.url` 那一支
 *     (`lib/git/environment.ts` 的宿主偏离已注明);
 *   · `missing: false`:能走到这里说明路径刚被 gate 过。
 *
 * @param root - 仓库工作区根(绝对路径)。
 * @returns 合成(或缓存)的 `Repository`。
 */
export function repositoryFor(root: string): Repository {
  const cached = repositoriesByRoot.get(root);
  if (cached !== undefined) {
    return cached;
  }
  const created = new Repository(root, stableRepositoryId(root), null, false);
  repositoriesByRoot.set(root, created);
  return created;
}

/**
 * 由路径派生一个**稳定**的正整数 id(上游 `Repository.id` 是 number)。
 *
 * 为什么不用 `Map.size`:同一个仓库在进程内可能被创建多次(缓存被清、
 * 或两个子系统各自建),而 `tags-to-push-${id}` 那类键会因此**分叉**
 * (一份写进 `tags-to-push-1`、另一份读 `tags-to-push-3`)。
 *
 * @param root - 仓库工作区根。
 * @returns 稳定的正整数。
 */
function stableRepositoryId(root: string): number {
  let hash = 0;
  for (let i = 0; i < root.length; i++) {
    hash = (hash * 31 + root.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 2_147_483_647;
}

/**
 * 接上宿主的凭据环境(**必须调,否则私有远端会认证失败**)。
 *
 * 上游把这件事写在 `lib/trampoline/trampoline-environment.ts` 里(它起一个
 * trampoline 服务);宿主半的等价物就是 `GitServiceOptions.credentialEnv`
 * (`src/index.ts` 注入的那一份:`GIT_ASKPASS` / `GIT_TERMINAL_PROMPT` 一族)。
 * 这里把它注册进 `withTrampolineEnv` 的注入点,于是**上游 `lib/git/core.ts`
 * 里那条 `...env` 合并**会真的拿到宿主凭据。
 *
 * @param provider - 提供者;传 `undefined` 注销(探针的阴性对照用它)。
 */
export function setMirrorGitCredentialEnv(
  provider: (() => Readonly<Record<string, string>>) | undefined
): void {
  credentialEnvProvider = provider;
  if (provider === undefined) {
    setTrampolineEnvProvider(null);
    return;
  }
  setTrampolineEnvProvider(async () => ({ ...provider() }));
}

/**
 * 接上宿主的日志(可选;默认 console)。
 *
 * 它同时做两件事,缺一不可:
 *   1. 把 {@link logSink} 换掉(本模块自己的诊断);
 *   2. 把**镜像层**的 `log`(经 `inject` 换成 `desktop-globals.ts` 的导出)
 *      接到同一个落点上 —— 否则 `lib/git/core.ts` / `lib/stores/git-store.ts`
 *      里那些 `log.error` 会走默认 console,与宿主的日志面分家。
 *
 * @param sink - 落点。
 */
export function setMirrorGitLogger(
  sink: (message: string, error?: Error) => void
): void {
  logSink = sink;
  setMirrorLogger({
    error: (message, error) => sink(message, error),
    warn: (message, error) => sink(message, error),
    info: (message, error) => sink(message, error),
    debug: (message, error) => sink(message, error),
  });
}


/**
 * 取(或建)某个仓库的 `GitStore`,并把它的错误事件接到日志上。
 *
 * ⚠️ `onDidError` 那一条是**必须**的:`performFailableOperation` 捕获异常后
 * 只 `emitError`(`lib/stores/base-store.ts:13`),而 `event-kit` 的 `Emitter`
 * 在**没有监听者**时是**静默**的 ⇒ 不接就等于「推送后的 fetch 失败你永远不知道」。
 *
 * @param root - 仓库工作区根(绝对路径)。
 * @returns 该仓库的 `GitStore`。
 */
export function gitStoreFor(root: string): GitStore {
  const cached = storesByRoot.get(root);
  if (cached !== undefined) {
    return cached;
  }
  const store = new GitStore(repositoryFor(root), shell, new StatsStore());
  store.onDidError((error: Error) => {
    logSink(`上游 GitStore 报错(${root}):${error.message}`, error);
  });
  storesByRoot.set(root, store);
  return store;
}

/**
 * **★ 推送之后的远端刷新** —— 上游 `app-store.ts:5341-5347` 那一步。
 *
 * 逐字对应上游的 `await gitStore.fetchRemotes([safeRemote], false, fetchProgress => …)`:
 *   · `remotes` 恰好一个,就是刚推的那个远端(上游的 `safeRemote = {name: remoteName, url: remote.url}`);
 *   · `backgroundTask = false`(推送后的刷新是前台动作,失败要留痕);
 *   · `progressCallback` 可选 —— 传了才会加 `--progress`(上游也是这个条件,
 *     见 `lib/git/fetch.ts` 的 `if (progressCallback)` 那一支)。
 *
 * **失败不致命**:`fetchRemote` 走 `performFailableOperation`,抛出的错误被折成
 * `undefined` + 一条 `did-error` 事件(已接到 {@link setMirrorGitLogger})。
 * 这正是上游的语义 —— 推送已经成功了。
 *
 * @param root - 仓库工作区根(绝对路径)。
 * @param remote - 刚推的远端(`{name, url}`);`url` 必须是 git 能直接用的形状
 *                 (`file:///…` / `https://…` / `git@…`),见 `git remote get-url`。
 * @param onProgress - 可选进度回调(收到的是上游 `IFetchProgress`)。
 * @returns 完成的 Promise(fetch 失败**不** reject)。
 */
export async function fetchRemotesAfterPush(
  root: string,
  remote: IRemote,
  onProgress?: (progress: IFetchProgress) => void
): Promise<void> {
  ensureDugiteGitDirectory();
  const store = gitStoreFor(root);
  await store.fetchRemotes(
    [remote],
    false,
    onProgress === undefined ? undefined : progress => onProgress(progress)
  );
}

/**
 * 当前接线状态(**探针用的读数**,不是给产品路径用的)。
 *
 * 为什么要有它:探针必须能在**同一帧**里证明「凭据接上了 / 没接上」,
 * 因为公开远端在两档下都 fetch 成功 —— 只看结果分不出来。
 *
 * @returns 一份只读快照。
 */
export function mirrorGitStatus(): {
  readonly git: IDugiteGitEnv;
  readonly stores: number;
  readonly hasCredentialEnv: boolean;
  readonly hasTrampolineEnv: boolean;
} {
  return {
    git: ensureDugiteGitDirectory(),
    stores: storesByRoot.size,
    hasCredentialEnv: credentialEnvProvider !== undefined,
    hasTrampolineEnv: hasTrampolineEnvProvider(),
  };
}

/**
 * 清掉 `GitStore` 缓存(**测试/探针专用**)。
 *
 * ⚠️ 不要在产品路径上调用:上游 `GitStore` 里有 `commitLookup` 等缓存,
 * 清掉只会让下一次重建,不会「修复」任何东西。
 */
export function resetMirrorGitStoresForTests(): void {
  storesByRoot.clear();
  repositoriesByRoot.clear();
}
