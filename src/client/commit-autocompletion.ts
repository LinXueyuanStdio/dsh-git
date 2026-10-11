/**
 * **提交信息 / 共同作者输入框的自动补全提供者清单** —— 上游
 * `ui/autocompletion/build-autocompletion-providers.ts` 在本插件里的**唯一调用点**,
 * 以及它需要的**那几个「数据源接缝」**。
 *
 * ## 一、为什么这个文件存在(而不是在 `store.ts` 里现拼清单)
 *
 * 上游只在一个地方构造这份清单(`ui/changes/sidebar.tsx:143-152` 与
 * `ui/app.tsx:2412`),然后整份清单往下传,由两个**逐字**的过滤函数分流
 * (`ui/changes/commit-message.tsx:270-287`):
 *  · `findCommitMessageAutoCompleteProvider`(**去掉** `CoAuthorAutocompletionProvider`)
 *    ⇒ 摘要 / 描述两个输入框;
 *  · `findCoAuthorAutoCompleteProvider`(**只留** `CoAuthorAutocompletionProvider`)
 *    ⇒ 共同作者那一行。
 *
 * 我们这一侧把「构造」放在这里、「分流」放在 `store.ts` 的两个公开方法里,
 * 而**构造本身仍然只有一处** —— 就是那份**逐字镜像**的
 * `ui/autocompletion/build-autocompletion-providers.ts`。本文件不重写它的逻辑,
 * 只负责把它的六个形参**喂上**。
 *
 * ## 二、六个形参今天各自是什么(⚠️ 逐条如实,别读成「已经能用」)
 *
 * | 形参 | 上游来源 | 本仓今天 | 用户能看到补全吗 |
 * |---|---|---|---|
 * | `repository` | 当前仓库 | `Repository`(由 `repo-state-cache.ts` 的**同一个**实例提供) | — |
 * | `dispatcher` | `Dispatcher` 总线 | 镜像替身 `ui/dispatcher/index.ts` 的一个实例;它的 `refreshIssues` 是**登记过的 no-op** | — |
 * | `emoji: Map<string, Emoji>` | `app-store.loadEmoji()` 读 `emoji.json` | **空表**(见下 §三.1) | ❌ 补不出 |
 * | `issuesStore` | `IssuesStore`(dexie + `fetchIssues`) | **空数据源替身**(§三.2) | ❌ 补不出 |
 * | `gitHubUserStore` | `GitHubUserStore`(dexie + `fetchMentionables`) | 真类 + **空数据源数据库**(§三.3) | ❌ 补不出 |
 * | `accounts` | 已登录的 GitHub 账户 | **空数组**(§三.4) | — |
 *
 * 四类补全(`:emoji` / `#issue` / `@user` / 分支)今天**一类都补不出东西**,
 * 而且**没有任何一类是「发明」的**:三个 `kind` 各由上游那个类实现,数据的缺失
 * 是**真的**(下面逐条给出「缺的是什么」)。判据
 * `docs/probes/changes-commit-autocompletion-probe.mjs` 的 `A5` 把「每类都回 0 条」
 * 钉成读数,`A3` 用**注入的真 provider** 证明「有数据时弹层真的会出来」——
 * 两条一起才说明「今天静默是因为没有数据,而不是因为没接线」。
 *
 * ## 三、四个接缝各自缺什么(**退役条件**逐条写在这里)
 *
 * ### 1. emoji —— 数据集本身不在这个 checkout 里
 *
 * 上游 `lib/stores/app-store.ts:1186-1195` 的 `loadEmoji()` 走 `lib/read-emoji.ts`
 * 去读**应用根目录**下的 `emoji.json`(由构建期从 `gemoji` 抄进产物)。
 * 本仓实测:`references/desktop/gemoji/` 是**空目录**(0 个文件),
 * 全树 `find -name emoji.json` **0 命中**;`read-emoji.ts` 也不在 client 镜像里
 * (它 `import * as Fs from 'fs'`),`lib/markdown-filters/emoji-filter.ts` 的
 * `readFile` 走宿主钩子且**没有** `readEmoji` 的等价物。
 * ⇒ **空表**是如实的空值,不是「我不会写」。要让它有数据:把 gemoji 数据集
 * 接进构建产物(或加一条宿主路由 `emoji/list` 读宿主装的那份),再把它喂进
 * `buildChangesAutocompletionProviders` 的 `emoji` 形参。
 *
 * ### 2. issues —— 库、账户、REST 端点三件都缺
 *
 * `IssuesStore`(上游 `lib/stores/issues-store.ts`)构造要一个 `IssuesDatabase`
 * (dexie;不在 `package.json`、不在 `node_modules`);它的 `refreshIssues` 还要
 * `lib/api.ts` 的 `fetchIssues`,而本仓那份 `lib/api.ts` 替身**没有**这个方法
 * (它只有 avatar 面 + CI 面)。⇒ 这里给一个**结构类型**的替身,读方法回 `[]`。
 *
 * ### 3. user(含共同作者) —— 同上,而且**多一道闸门**
 *
 * `GitHubUserStore`(上游 `lib/stores/github-user-store.ts`)本轮**已经补进
 * client 根**(`src/core/desktop/lib/stores/github-user-store.ts`,镜像),
 * 它的**数据**来自 `database.getAllMentionablesForRepository()` —— 而那份数据库
 * 的真身要 dexie,且**只有** `updateMentionables()`(读 GitHub REST
 * `repos/{owner}/{name}/mentionables/users`,本 shim 里是抛错替身)才会往里写。
 * 上游那条写入来自 `app-store` 的仓库加载,属 §1.3 排除面;本仓没有对应调用点。
 * ⇒ 这里的数据库替身**每个读方法回 `[]` / `undefined`**(明确登记为「空」),
 * 于是 `GitHubUserStore.getMentionableUsers()` 必然回 `[]`。
 *
 * ⚠️ **即便如此它也到不了** —— `getMentionableUsers()` 里那句
 * `isDotCom(repository.endpoint) && !mentionables.some(...)` 会给 dotcom 仓库补一个
 * `Copilot` bot,但**整条链的外闸门**是 `repository.gitHubRepository !== null`
 * (`build-autocompletion-providers.ts:31`)而本仓客户端**恒为 null**
 * ⇒ 连 `UserAutocompletionProvider` / `CoAuthorAutocompletionProvider` 都**不会**被
 * 构造出来。这一条是整个 7.14 的真阻塞者,见 `docs/changes-function-points.md`。
 *
 * ### 4. accounts —— 没有 GitHub 账户模型
 *
 * 上游 `accounts.find(a => a.endpoint === gitHubRepository.endpoint)`;本插件
 * **没有**账户 store(client 根没有 `lib/stores/accounts-store.ts`),
 * 宿主只暴露一个「是否已登录」的状态。⇒ **空数组**。它的唯一后果是
 * `UserAutocompletionProvider` 拿不到 account(从而不去掉「自己的 handle」那一格),
 * 而那一条今天本来就因为闸门②不可达。
 *
 * ## 四、浏览器半的边界
 *
 * 本文件不 import node 内置模块、不 import `@deepseek-ai/*`(**没有** `fs` /
 * `path` / `dexie`):`GitHubUserDatabase` 在这里只是**结构类型**,数据库替身是一个
 * 纯对象字面量。`scripts/check-scope-roots.mjs` 与客户端构建都会盯着这一条。
 *
 * @module dsh-git/client/commit-autocompletion
 */

import { Emoji } from '../core/desktop/lib/emoji.ts';
import {
  GitHubUserStore,
  type GitHubUserDatabase,
  type IMentionableCacheEntry,
  type IMentionableUser,
} from '../core/desktop/lib/stores/github-user-store.ts';
import { Dispatcher } from '../core/desktop/ui/dispatcher/index.ts';
import { buildAutocompletionProviders } from '../core/desktop/ui/autocompletion/build-autocompletion-providers.ts';
import type { IssuesStore } from '../core/desktop/ui/autocompletion/issues-autocompletion-provider.ts';
import type { IAutocompletionProvider } from '../core/desktop/ui/autocompletion/autocompletion-provider.ts';
import type { Account } from '../core/desktop/models/account.ts';
import type { Repository } from '../core/desktop/models/repository.ts';

/**
 * **空 emoji 表**(§三.1)。
 *
 * 为什么是 `new Map()` 而不是「随便塞几个 emoji」:塞几个**发明**的条目会让弹层
 * 在用户敲 `:` 时列出几个**只有我们认得**的名字,而真数据一到位它们又会与上游那份
 * 合并/冲突 —— 那正是「看起来能用、其实在骗人」的形态。
 */
const EMPTY_EMOJI = new Map<string, Emoji>();

/**
 * **空 mentionables 数据库替身**(§三.3)—— 实现 `GitHubUserDatabase` 的**结构类型**,
 * 每个读方法回空。
 *
 * 为什么回空而不是「抛错」:这条链的**外闸门**(`gitHubRepository !== null`)今天关着,
 * 所以两个选择今天都不可达;而一旦闸门打开,**回空**表现为「补不出人」(用户看到
 * 一个空列表 = 没有建议,弹层根本不渲染 —— 见
 * `autocompleting-text-input.tsx` 的 `renderAutocompletions` 只画 `items.length > 0`),
 * 抛错表现为「每次敲 `@` 都一条未捕获异常」。前者是**如实**,后者是**噪声**。
 *
 * `updateMentionablesForRepository` / `touchMentionableCacheEntry` 是**写**方法:
 * 它们同样只是记录「什么都没写」——**不**假装写过(不 `emitUpdate`)。
 */
function createInertMentionablesDatabase(): GitHubUserDatabase {
  return {
    async getMentionableCacheEntry(
      _gitHubRepositoryID: number,
    ): Promise<IMentionableCacheEntry | undefined> {
      return undefined;
    },
    async touchMentionableCacheEntry(
      _gitHubRepositoryID: number,
      _eTag: string | undefined,
    ): Promise<void> {
      return undefined;
    },
    async updateMentionablesForRepository(
      _gitHubRepositoryID: number,
      _users: ReadonlyArray<IMentionableUser>,
      _eTag: string,
    ): Promise<void> {
      return undefined;
    },
    async getAllMentionablesForRepository(
      _gitHubRepositoryID: number,
    ): Promise<ReadonlyArray<IMentionableUser>> {
      return [];
    },
  };
}

/**
 * **空 issues 数据源替身**(§三.2)—— 实现 `issues-autocompletion-provider.tsx` 里
 * 那份就地声明的 `IssuesStore` 结构类型。
 *
 * 回 `[]` 而不是抛:理由与上面那份数据库替身逐字相同(不可达 + 「空」是如实的空值)。
 */
const INERT_ISSUES_STORE: IssuesStore = {
  async getIssuesMatching(
    _repository,
    _text,
    _maxHits,
  ): Promise<ReadonlyArray<{ readonly title: string; readonly number: number }>> {
    return [];
  },
};

/** **空账户清单**(§三.4)。 */
const NO_ACCOUNTS: ReadonlyArray<Account> = [];

/**
 * 那条 `Dispatcher` 总线(§二表格第二行)。
 *
 * 为什么可以直接用镜像替身:这份清单里唯一会碰 `dispatcher` 的是
 * `IssuesAutocompletionProvider` 的 `refreshIssues` 一跳,而替身那个方法的
 * **方法体就是 no-op**(理由与退役条件写在 `ui/dispatcher/index.ts` 里)。
 * 用 `new Dispatcher()` 与「另写一个 `{refreshIssues: () => Promise.resolve()}`」
 * 是同一件事,但前者**不是第二份类型** —— 它保证那个形参永远满足上游签名。
 */
const DISPATCHER = new Dispatcher();

/**
 * `GitHubUserStore` **一个实例**(它的 `queryCache` / `pruneQueryCacheTimeoutId` 是
 * 实例状态,多份会让「同一个仓库的 mentionable 查询」各缓存一份)。
 *
 * 惰性构造:模块被 import 时**不**建任何东西(与上游「`app-store` 构造时才建」同一
 * 个时机语义);构造本身只 new 一个 `Emitter` + 收下一个纯对象,没有 IO。
 */
let gitHubUserStore: GitHubUserStore | null = null;

/**
 * 取(必要时构造)那份共用的 `GitHubUserStore`。
 * @returns 唯一实例。
 */
function sharedGitHubUserStore(): GitHubUserStore {
  if (gitHubUserStore === null) {
    gitHubUserStore = new GitHubUserStore(createInertMentionablesDatabase());
  }
  return gitHubUserStore;
}

/**
 * 构造**整份**自动补全清单 —— 就是上游那个构造器本人,一个字节没重写。
 *
 * ⚠️ 返回值是**整份**(emoji + 可能有的 issues/user/co-author),分流由调用方做:
 * `store.ts` 的 `commitMessageAutocompletionProviders()`(去掉 co-author)与
 * `coAuthorAutocompletionProviders()`(只留 co-author),两条各对应上游
 * `commit-message.tsx:270-287` 的两个函数。
 *
 * @param repository - 当前仓库(镜像 `models/repository.ts`)。
 *   ⚠️ **不要**为了让它非空而伪造 `gitHubRepository` —— 那是本功能点明令禁止的动作,
 *   也是「看起来能用其实在骗人」的典型。今天 `lib/stores` 的 `gitHubRepository`
 *   由 `api.repos()` 的载荷决定,本仓客户端载荷里没有这个字段(永远是 `null`)。
 * @returns 上游 `buildAutocompletionProviders(...)` 的原样输出。
 */
export function buildChangesAutocompletionProviders(
  repository: Repository,
): ReadonlyArray<IAutocompletionProvider<unknown>> {
  return buildAutocompletionProviders(
    repository,
    DISPATCHER,
    EMPTY_EMOJI,
    INERT_ISSUES_STORE,
    sharedGitHubUserStore(),
    NO_ACCOUNTS,
  );
}
