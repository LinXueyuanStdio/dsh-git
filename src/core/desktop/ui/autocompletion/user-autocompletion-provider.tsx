/*
 * ⚠️ **登记偏离 ④**:上游 `:1` 的 `import * as React from 'react'` 在这里**删掉了**。
 *
 * **为什么**:上游的 `tsconfig` 是 `jsx: "react"`(经典 JSX 运行时),所以那个 import
 * 是 JSX 的**必需**依赖;我们的是 `jsx: "react-jsx"`(自动运行时,
 * `scripts/build.mjs:440` 的 esbuild `jsx: 'automatic'` 与 `tsconfig.base.json:53` 同源),
 * JSX 走 `react/jsx-runtime` ⇒ `React` 这个名字在本文件里**一次都没被用到**,
 * 而 `tsconfig.base.json` 开着 `noUnusedLocals` ⇒ 实测
 * `TS6133: 'React' is declared but its value is never read`。
 *
 * **为什么不能像 `branch-autocompletion-provider.tsx` 那样留着**:那一个文件与本文件
 * 同形(它也报同一条 TS6133),但它是**存量**文件,那条诊断**早就登记在**
 * `scripts/type-baseline.json` 里;本文件是**新文件**,留一个未登记的诊断就是
 * `check-types` 的「回归」判据(棘轮只拦上升),而 `--write-baseline` 是明令禁止的动作。
 * ⇒ 删掉这一行是**唯一**不新增诊断、又不动基线的做法。
 *
 * **它不是行为改动**:JSX 的编译目标由 `tsconfig`/esbuild 决定,与有没有这个 import 无关
 * (删掉前后产出的元素树逐字相同)。
 *
 * **退役条件**:① 本仓回到 `jsx: "react"`(或)② `noUnusedLocals` 关掉 ——
 * 两条任一成立即可还原成上游原文,并删除 `verify-mirror.mjs` 上本文件的 EXPECTED 条目。
 */

import { IAutocompletionProvider } from './autocompletion-provider'
import { GitHubRepository } from '../../models/github-repository'
import { Account } from '../../models/account'
import { Avatar } from '../lib/avatar'
import { IAvatarUser } from '../../models/avatar'
import memoizeOne from 'memoize-one'
import { copilotSweAgentBot } from '../../models/dot-com-bots'
import { getStealthEmailForUser } from '../../lib/email'
import { isDotCom } from '../../lib/endpoint-capabilities'

/*
 * ============================================================================
 * dsh-git 登记偏离 —— 见 `scripts/verify-mirror.mjs` 的 EXPECTED,
 * 键名 `ui/autocompletion/user-autocompletion-provider.tsx`
 * ============================================================================
 *
 * 本文件与上游
 * `references/desktop/app/src/ui/autocompletion/user-autocompletion-provider.tsx`
 * **逐字一致**,只有下面两处不同,且都只是 import 说明符:
 *
 * 1. 上游 `:4` `import { GitHubUserStore } from '../../lib/stores'`
 *    上游 `:7` `import { IMentionableUser } from '../../lib/databases/index'`
 *    —— 这两个模块在**本仓 client 根不存在**(实测:`src/core/desktop/lib/stores/`
 *    没有 `index.ts`;`src/core/desktop/lib/databases/` 整个目录不存在)。真身在
 *    **host 根**的镜像里(`src/host/mirror/lib/stores/github-user-store.ts:34`、
 *    `src/host/mirror/lib/databases/github-user-database.ts:4`),两个根之间不能互相
 *    import。⇒ 这里把**本文件真正用到的成员**就地声明成结构类型(签名逐字抄自上面
 *    那两个 host 镜像文件),而不是 `any`。于是「替身与真契约静默分家」仍然会在
 *    **编译期**炸:真身签名一变,调用点(`getMentionableUsersMatching` / `getByLogin`)
 *    就对不上。
 *
 * 2. 上游 `:3` 的 `'./index'` → `'./autocompletion-provider'`。
 *    上游 `ui/autocompletion/index.ts` 是 `export *` 桶文件(与上游字节一致),esbuild
 *    会把整份桶拉进客户端包、连带它 re-export 的模块 —— 而其中 `emoji` / `issues` /
 *    `build-autocompletion-providers` 三个模块**不在**本仓树里。同一个理由、同一种改法
 *    已经登记在 `ui/autocompletion/autocompleting-text-input.tsx` 与
 *    `ui/lib/ref-name-text-box.tsx` 两条 EXPECTED 上(不是本轮新发明的口径)。
 *
 * **退役条件(两条同时满足就删掉本块、还原成上游原文,并删掉本文件的 EXPECTED 条目)**:
 *   ① client 根补上 `lib/stores/index.ts` 与 `lib/databases/index.ts`(真类型);
 *   ② `ui/autocompletion/index.ts` 不再是 `export *` 桶,或打包器能 tree-shake 掉桶。
 */

/**
 * 上游 `lib/databases/github-user-database.ts:4-30` 的 `IMentionableUser`,逐字
 * (含注释)。为什么就地声明:见上面的偏离块。
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

/**
 * 上游 `lib/stores/github-user-store.ts` 的 `GitHubUserStore` 里**本文件真正用到**的
 * 两个成员,签名逐字(`:53` 的 `getByLogin`、`:166` 的 `getMentionableUsersMatching`;
 * 上游第三个形参带默认值 `maxHits: number = DefaultMaxHits`,这里保持可选)。
 */
export type GitHubUserStore = {
  /** 上游 `github-user-store.ts:53`。 */
  getByLogin(account: Account, login: string): Promise<IMentionableUser | null>
  /** 上游 `github-user-store.ts:166`。 */
  getMentionableUsersMatching(
    repository: GitHubRepository,
    query: string,
    maxHits?: number
  ): Promise<ReadonlyArray<IMentionableUser>>
}

/** An autocompletion hit for a user. */
export type KnownUserHit = {
  readonly kind: 'known-user'

  /** The username. */
  readonly username: string

  /**
   * The user's name or null if the user
   * hasn't entered a name in their profile
   */
  readonly name: string | null

  /**
   * The user's public email address. If the user
   * hasn't selected a public email address this
   * field will be an empty string.
   */
  readonly email: string

  readonly endpoint: string
}

export type UnknownUserHit = {
  readonly kind: 'unknown-user'

  /** The username. */
  readonly username: string
}

export type UserHit = KnownUserHit | UnknownUserHit

function userToHit(
  repository: GitHubRepository,
  user: IMentionableUser
): UserHit {
  return {
    kind: 'known-user',
    username: user.login,
    name: user.name,
    email: user.email,
    endpoint: repository.endpoint,
  }
}

/** The autocompletion provider for user mentions in a GitHub repository. */
export class UserAutocompletionProvider
  implements IAutocompletionProvider<UserHit>
{
  public readonly kind = 'user'

  private readonly gitHubUserStore: GitHubUserStore
  private readonly repository: GitHubRepository
  private readonly account: Account | null

  // We need to memoize this function so that we don't create a new array
  // on every render which would cause the Avatar component to re-render
  // unnecessarily
  private getAccountsFromAccount = memoizeOne((account: Account | null) => {
    return account ? [account] : []
  })

  public constructor(
    gitHubUserStore: GitHubUserStore,
    repository: GitHubRepository,
    account?: Account
  ) {
    this.gitHubUserStore = gitHubUserStore
    this.repository = repository
    this.account = account || null
  }

  public getRegExp(): RegExp {
    return /(?:^|\n| )(?:@)([a-z\d\\+-][a-z\d_-]*)?/g
  }

  protected async getUserAutocompletionItems(
    text: string,
    includeUnknownUser: boolean
  ): Promise<ReadonlyArray<UserHit>> {
    const users = await this.gitHubUserStore.getMentionableUsersMatching(
      this.repository,
      text
    )

    // dotcom doesn't let you autocomplete on your own handle
    const account = this.account
    const filtered = account
      ? users.filter(x => x.login !== account.login)
      : users

    const hits = filtered.map(x => userToHit(this.repository, x))

    if (includeUnknownUser && text.length > 0) {
      const exactMatch = hits.some(
        hit => hit.username.toLowerCase() === text.toLowerCase()
      )

      if (!exactMatch) {
        hits.push({
          kind: 'unknown-user',
          username: text,
        })
      }
    }

    return hits
  }

  public async getAutocompletionItems(
    text: string
  ): Promise<ReadonlyArray<UserHit>> {
    return this.getUserAutocompletionItems(text, false)
  }

  public renderItem(item: UserHit): JSX.Element {
    if (item.kind === 'known-user' && this.account) {
      const user: IAvatarUser = {
        name: item.name ?? item.username,
        email: item.email,
        avatarURL: undefined,
        endpoint: item.endpoint,
      }

      return (
        <div className="user" key={item.username}>
          <Avatar
            accounts={this.getAccountsFromAccount(this.account)}
            user={user}
            aria-hidden={true}
          />
          <span className="username">{item.username}</span>
          <span className="name">{item.name}</span>
        </div>
      )
    }

    return item.kind === 'known-user' ? (
      <div className="user" key={item.username}>
        <span className="username">{item.username}</span>
        <span className="name">{item.name}</span>
      </div>
    ) : (
      <div className="user unknown" key={item.username}>
        <span className="username">{item.username}</span>
        <span className="description">Search for user</span>
      </div>
    )
  }

  public getCompletionText(item: UserHit): string {
    return `@${item.username}`
  }

  /**
   * Retrieve a user based on the user login name, i.e their handle.
   *
   * If the user is already cached no additional API requests
   * will be made. If the user isn't in the cache but found in
   * the API it will be persisted to the database and the
   * intermediate cache.
   *
   * @param login   The login (i.e. handle) of the user
   */
  public async exactMatch(login: string): Promise<UserHit | null> {
    if (this.account === null) {
      return null
    }

    if (
      login.toLowerCase() === 'copilot' &&
      isDotCom(this.repository.endpoint)
    ) {
      const { userId, login, endpoint } = copilotSweAgentBot
      return {
        kind: 'known-user',
        username: login,
        name: login,
        email: getStealthEmailForUser(userId, login, endpoint),
        endpoint,
      }
    }

    const user = await this.gitHubUserStore.getByLogin(this.account, login)

    if (!user) {
      return null
    }

    return userToHit(this.repository, user)
  }
}

export class CoAuthorAutocompletionProvider extends UserAutocompletionProvider {
  public getRegExp(): RegExp {
    return /(?:^|\n| )(?:@)?([a-z\d\\+-][a-z\d_-]*)?/g
  }

  public async getAutocompletionItems(
    text: string
  ): Promise<ReadonlyArray<UserHit>> {
    return super.getUserAutocompletionItems(text, true)
  }
}
