import { Account } from '../../models/account'
import { GitHubRepository } from '../../models/github-repository'
import { API } from '../api'
/*
 * ============================================================================
 * dsh-git 登记偏离 —— 见 `scripts/verify-mirror.mjs` 的 EXPECTED,
 * 键名 `lib/stores/github-user-store.ts`
 * ============================================================================
 *
 * 本文件与上游
 * `references/desktop/app/src/lib/stores/github-user-store.ts`
 * **逐字一致**,只有**一处**不同:
 *
 * 上游 `:4-7`:
 * ```ts
 * import {
 *   GitHubUserDatabase,
 *   IMentionableUser,
 * } from '../databases/github-user-database'
 * ```
 * ⇒ 这里把它换成**就地声明的两个结构类型**(声明块在本注释之后)。
 *
 * **为什么不能逐字**:那个模块在 client 根**不存在**(`src/core/desktop/lib/databases/`
 * 整个目录没有),而它的上游原文 `:1` 是 `import Dexie from 'dexie'` +
 * `:2` `import { BaseDatabase } from './base-database'` ⇒ 逐字抄进来要**两级**依赖
 * (`dexie` 这个 npm 包 + `lib/databases/base-database.ts`),而 `dexie` **不在**
 * `package.json`、也**不在** `node_modules`(实测)。本仓明令禁止 `npm install`
 * 与新增依赖 ⇒ 逐字那一份在客户端程序里**编译不过**。
 * 真身在 **host 根**的镜像里(`src/host/mirror/lib/databases/github-user-database.ts`),
 * 两个根之间不能互相 import(见 `scripts/verify-mirror.mjs` 文件头的「两段镜像根」)。
 *
 * **同一手法、同一理由**已经登记在 `ui/autocompletion/user-autocompletion-provider.tsx`
 * 的 EXPECTED 上(那一份也 import 了 `'../../lib/stores'` 与 `'../../lib/databases/index'`,
 * 也是把真正用到的成员就地声明成结构类型)—— **不是本轮新发明的口径**。
 *
 * **为什么用结构类型而不是 `any`**:真契约(host 根那份上游原文的方法名/签名)一旦漂移,
 * 调用点(`getMentionableCacheEntry` / `touchMentionableCacheEntry` /
 * `updateMentionablesForRepository` / `getAllMentionablesForRepository`)会在**编译期**
 * 报错,而不是静默分家。
 *
 * **运行期的诚实边界(不是「忘了实现」)**:这两个结构类型**只声明形状**;真正的实现由
 * 客户端接缝提供(`src/client/commit-autocompletion.ts` 的
 * `createInertMentionablesDatabase()` —— 它**明确登记为「空数据源」**:每个读方法返回
 * `[]` / `undefined`,因为浏览器半**没有** GitHub REST 客户端、也没有 dexie 库)。
 * ⇒ `GitHubUserStore.getMentionableUsers()` 今天必然返回 `[]`,共同作者输入框**一个
 * 用户都补不出来**。这不是替身偏离真契约,是**真的没有数据面**。
 *
 * **退役条件(两条同时满足就删掉本块与下面两个声明,还原成上游原文,并删除本文件的
 * EXPECTED 条目)**:
 *   ① client 根补上 `lib/databases/github-user-database.ts`(**真身**:含 dexie 依赖,
 *      即 `package.json` 里出现 `dexie`)与 `lib/databases/index.ts`;
 *   ② `GitHubUserStore` 的实例由宿主提供的真数据库构造(而不是
 *      `src/client/commit-autocompletion.ts` 的空数据源)。
 */

/**
 * 上游 `lib/databases/github-user-database.ts:4-30` 的 `IMentionableUser`,逐字(含注释)。
 */
export interface IMentionableUser {
  /**
   * The username or "handle" of the user.
   */
  readonly login: string

  /**
   * The real name (or at least the name that the user
   * has configured to be shown) or null if the user hasn't
   * specified a name.
   */
  readonly name: string | null

  /**
   * The user's attributable email address. If the
   * user doesn't have a public profile email address
   * this will instead contain an automatically generated
   * stealth email address based on the account endpoint
   * and login.
   */
  readonly email: string

  /**
   * A url to an avatar image chosen by the user
   */
  readonly avatarURL: string
}

/** 上游 `lib/databases/github-user-database.ts:46-60` 的 `IMentionableCacheEntry`,逐字。 */
export interface IMentionableCacheEntry {
  readonly gitHubRepositoryID: number
  readonly lastUpdated: number
  readonly eTag: string | undefined
}

/**
 * 上游 `lib/databases/github-user-database.ts` 的 `GitHubUserDatabase` 里
 * **本文件真正用到**的四个成员,名字与签名逐字(那个类本身 extends `BaseDatabase`
 * extends `Dexie`,所以这里只取本文件读到的四格 —— 不是 `any`)。
 */
export type GitHubUserDatabase = {
  /** 上游 `github-user-database.ts` 的 `getMentionableCacheEntry`。 */
  getMentionableCacheEntry(
    gitHubRepositoryID: number
  ): Promise<IMentionableCacheEntry | undefined>
  /** 上游 `github-user-database.ts` 的 `touchMentionableCacheEntry`。 */
  touchMentionableCacheEntry(
    gitHubRepositoryID: number,
    eTag: string | undefined
  ): Promise<void>
  /**
   * 上游 `github-user-database.ts:100-104` 的 `updateMentionablesForRepository`。
   *
   * ⚠️ 第三个形参是 `string | undefined`(不是 `string`):上游 `:103` 逐字如此,
   * 而调用点 `github-user-store.ts` 传的是 `fetchMentionables` 回的
   * `response.etag`(上游 `lib/api.ts:1275` 的 `response.headers.get('etag') || undefined`
   * ⇒ 类型就是 `string | undefined`)。写成 `string` 会在**编译期**炸在那一行上 ——
   * 这正是「结构类型必须逐字」那条规矩的一个具体例子。
   */
  updateMentionablesForRepository(
    gitHubRepositoryID: number,
    users: ReadonlyArray<IMentionableUser>,
    eTag: string | undefined
  ): Promise<void>
  /** 上游 `github-user-database.ts` 的 `getAllMentionablesForRepository`。 */
  getAllMentionablesForRepository(
    gitHubRepositoryID: number
  ): Promise<ReadonlyArray<IMentionableUser>>
}


import { compare } from '../compare'
import { BaseStore } from './base-store'
import { getStealthEmailForUser, getLegacyStealthEmailForUser } from '../email'
import { DefaultMaxHits } from '../../ui/autocompletion/common'
import { isDotCom } from '../endpoint-capabilities'
import { copilotSweAgentBot } from '../../models/dot-com-bots'

/** Don't fetch mentionables more often than every 10 minutes */
const MaxFetchFrequency = 10 * 60 * 1000

/**
 * The max time (in milliseconds) that we'll keep a mentionable query
 * cache around before pruning it.
 */
const QueryCacheTimeout = 60 * 1000

interface IQueryCache {
  readonly repository: GitHubRepository
  readonly users: ReadonlyArray<IMentionableUser>
}

/**
 * The store for GitHub users. This is used to match commit authors to GitHub
 * users and avatars.
 */
export class GitHubUserStore extends BaseStore {
  private queryCache: IQueryCache | null = null
  private pruneQueryCacheTimeoutId: number | null = null

  public constructor(private readonly database: GitHubUserDatabase) {
    super()
  }

  /**
   * Retrieve a public user profile from the API based on the
   * user login.
   *
   * @param account The account to use when querying the API
   *                for information about the user
   * @param login   The login (i.e. handle) of the user
   */
  public async getByLogin(
    account: Account,
    login: string
  ): Promise<IMentionableUser | null> {
    const api = API.fromAccount(account)
    const apiUser = await api.fetchUser(login).catch(e => null)

    if (!apiUser || apiUser.type !== 'User') {
      return null
    }

    const email =
      apiUser.email !== null && apiUser.email.length > 0
        ? apiUser.email
        : getStealthEmailForUser(apiUser.id, login, account.endpoint)

    return {
      avatarURL: apiUser.avatar_url,
      email,
      name: apiUser.name || apiUser.login,
      login: apiUser.login,
    }
  }

  /** Update the mentionable users for the repository. */
  public async updateMentionables(
    repository: GitHubRepository,
    account: Account
  ): Promise<void> {
    const api = API.fromAccount(account)

    const cacheEntry = await this.database.getMentionableCacheEntry(
      repository.dbID
    )

    if (
      cacheEntry !== undefined &&
      Date.now() - cacheEntry.lastUpdated < MaxFetchFrequency
    ) {
      return
    }

    const response = await api.fetchMentionables(
      repository.owner.login,
      repository.name,
      cacheEntry?.eTag
    )

    if (response === null) {
      await this.database.touchMentionableCacheEntry(
        repository.dbID,
        cacheEntry?.eTag
      )
      return
    }

    const { endpoint } = account

    const mentionables = response.users.map(u => {
      const { name, login, avatar_url: avatarURL } = u
      const email = u.email || getLegacyStealthEmailForUser(login, endpoint)
      return { name, login, email, avatarURL }
    })

    await this.database.updateMentionablesForRepository(
      repository.dbID,
      mentionables,
      response.etag
    )

    if (this.queryCache?.repository.dbID === repository.dbID) {
      this.queryCache = null
      this.clearCachePruneTimeout()
    }
  }

  /** Get the mentionable users in the repository. */
  public async getMentionableUsers(
    repository: GitHubRepository
  ): Promise<ReadonlyArray<IMentionableUser>> {
    const mentionables = await this.database.getAllMentionablesForRepository(
      repository.dbID
    )

    if (
      isDotCom(repository.endpoint) &&
      !mentionables.some(x => x.login === 'Copilot')
    ) {
      const { userId, login, avatarURL, endpoint } = copilotSweAgentBot
      const email = getStealthEmailForUser(userId, login, endpoint)
      return mentionables.concat({ login, name: login, email, avatarURL })
    }

    return mentionables
  }

  /**
   * Get the mentionable users which match the text in some way.
   *
   * Hit results are ordered by how close in the search string
   * they matched. Search strings start with username and are followed
   * by real name. Only the first substring hit is considered
   *
   * @param repository The GitHubRepository for which to look up
   *                   mentionables.
   *
   * @param text    A string to use when looking for a matching
   *                user. A user is considered a hit if this text
   *                matches any subtext of the username or real name
   *
   * @param maxHits The maximum number of hits to return.
   */
  public async getMentionableUsersMatching(
    repository: GitHubRepository,
    query: string,
    maxHits: number = DefaultMaxHits
  ): Promise<ReadonlyArray<IMentionableUser>> {
    const users =
      this.queryCache?.repository.dbID === repository.dbID
        ? this.queryCache.users
        : await this.getMentionableUsers(repository)

    this.setQueryCache(repository, users)

    return matchMentionableUsers(users, query, maxHits)
  }

  private setQueryCache(
    repository: GitHubRepository,
    users: ReadonlyArray<IMentionableUser>
  ) {
    this.clearCachePruneTimeout()
    this.queryCache = { repository, users }
    this.pruneQueryCacheTimeoutId = window.setTimeout(() => {
      this.pruneQueryCacheTimeoutId = null
      this.queryCache = null
    }, QueryCacheTimeout)
  }

  private clearCachePruneTimeout() {
    if (this.pruneQueryCacheTimeoutId !== null) {
      clearTimeout(this.pruneQueryCacheTimeoutId)
      this.pruneQueryCacheTimeoutId = null
    }
  }
}

/**
 * Filter and rank a set of mentionable users by how well they match the given
 * query.
 *
 * A user is considered a hit if the query appears as a substring of their
 * login or, when set, their real name. Hits are ordered primarily by how early
 * in the text the match was found and secondarily by login (alphabetically).
 *
 * Exported separately from the store so that the (pure) matching behavior can
 * be unit tested without a backing database.
 *
 * @param users   The mentionable users to filter and rank.
 * @param query   The text to search for. A user is a hit if this matches any
 *                substring of their login or real name.
 * @param maxHits The maximum number of hits to return.
 */
export function matchMentionableUsers(
  users: ReadonlyArray<IMentionableUser>,
  query: string,
  maxHits: number = DefaultMaxHits
): ReadonlyArray<IMentionableUser> {
  const hits: Array<{
    readonly user: IMentionableUser
    readonly ix: number
  }> = []
  const needle = query.toLowerCase()

  // Simple substring comparison on login and real name
  for (const user of users) {
    // Users without a configured real name have a `null` name. Coalesce to an
    // empty string before interpolating, otherwise the literal text "null"
    // ends up in the haystack and queries like "@null" (or even "@n")
    // spuriously match every user that hasn't set a name.
    const ix = `${user.login} ${user.name ?? ''}`
      .trim()
      .toLowerCase()
      .indexOf(needle)

    if (ix >= 0) {
      hits.push({ user, ix })
    }
  }

  // Sort hits primarily based on how early in the text the match
  // was found and then secondarily using alphabetic order. Ideally
  // we'd use the GitHub user id in order to match dotcom behavior
  // but sadly we don't have it handy here. The id property on IGitHubUser
  // refers to our internal database id.
  return hits
    .sort((x, y) => compare(x.ix, y.ix) || compare(x.user.login, y.user.login))
    .slice(0, maxHits)
    .map(h => h.user)
}
