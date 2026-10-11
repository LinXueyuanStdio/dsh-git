/*
 * ============================================================================
 * dsh-git 登记偏离 —— 见 `scripts/verify-mirror.mjs` 的 EXPECTED,
 * 键名 `ui/autocompletion/build-autocompletion-providers.ts`
 * ============================================================================
 *
 * 本文件与上游
 * `references/desktop/app/src/ui/autocompletion/build-autocompletion-providers.ts`
 * (61 行)**逐字一致**,只有**一处**不同:
 *
 * 上游 `:14` 的 `import { GitHubUserStore, IssuesStore } from '../../lib/stores'`
 * 换成两条**直指定义点**的 import(`GitHubUserStore` 真身 + `IssuesStore` 结构类型)。
 *
 * **为什么**:上游那个 `lib/stores/index.ts` 是 `export *` 桶,re-export 13 个模块
 * (`accounts-store` / `app-store` / `cloning-repositories-store` / `copilot-store` /
 * `git-store` / `github-user-store` / `issues-store` / `repositories-store` /
 * `sign-in-store` / `token-store` / `pull-request-store` / `pull-request-coordinator` /
 * `helpers/find-upstream-remote`)。本仓 client 根只有其中 4 个,**逐字补桶 =
 * 一次带进 9 个不存在的模块**(其中 7 个是 §1.3 排除的应用层,`token-store` 还要
 * keytar、`repositories-store` 要 GitHub API + dexie);
 *  · `GitHubUserStore` 本轮**已经补进 client 根**
 *    (`src/core/desktop/lib/stores/github-user-store.ts`,镜像,偏离登记在它自己头上)
 *    ⇒ 直接 import 真身,不再就地声明结构类型(这是 `user-autocompletion-provider.tsx`
 *    偏离②的**部分回收**:那一份仍留着自己的结构类型,因为它与本文件的消费面不同 ——
 *    见下面「刻意不做」);
 *  · `IssuesStore` 在 client 根**不存在**(它的上游原文要 dexie + GitHub REST)
 *    ⇒ 从 `./issues-autocompletion-provider` 取那一份**已经就地声明并登记过**的
 *    结构类型 —— **只有一处声明**,不在两个文件里各写一遍(否则就是第二份真源)。
 *
 * ⚠️ **刻意不做**(别下一个人当成抄漏):`user-autocompletion-provider.tsx` 的
 * 就地声明它**仍然保留**。回收它要把那一份的 `GitHubUserStore` 换成真身 import +
 * 把 `IMentionableUser` 从 `github-user-store.ts` 取出来 —— 那是**动的文件多、
 * 收益为零**的一步(两个文件都在同一棵镜像树里,都由本探针逐字节比对上游),
 * 而本轮的任务面是「补缺件 + 接线」。它的回收条件写在它自己的偏离块里,一个字没改。
 *
 * ⚠️ `:12` 的 `from '.'`(`./index` 桶)**保留**:本轮把三个缺件补齐之后,
 * 那个桶 re-export 的六个模块**全部在树里**(见 `issues-autocompletion-provider.tsx`
 * 偏离块的同一条说明)。
 *
 * **退役条件**:client 根出现**完整的** `lib/stores/index.ts`(即那 13 个模块全部可解析,
 * 或本仓决定给它一份登记过的**缩减版**桶)⇒ `:14` 还原成上游原文,并删除本文件的
 * EXPECTED 条目。
 */

import {
  getNonForkGitHubRepository,
  isRepositoryWithGitHubRepository,
  Repository,
} from '../../models/repository'
import {
  CoAuthorAutocompletionProvider,
  EmojiAutocompletionProvider,
  IAutocompletionProvider,
  IssuesAutocompletionProvider,
  UserAutocompletionProvider,
} from '.'
import { Dispatcher } from '../dispatcher'
import { GitHubUserStore } from '../../lib/stores/github-user-store'
/*
 * `IssuesStore` 的结构类型来自**定义它的那个文件**(那里就地声明并登记过;
 * 见本文件头偏离块与 `issues-autocompletion-provider.tsx` 的偏离块)。
 * 这里**只取类型**:`import type` ⇒ 不产生运行期 import 边。
 */
import type { IssuesStore } from './issues-autocompletion-provider'
import { Account } from '../../models/account'
import { Emoji } from '../../lib/emoji'

export function buildAutocompletionProviders(
  repository: Repository,
  dispatcher: Dispatcher,
  emoji: Map<string, Emoji>,
  issuesStore: IssuesStore,
  gitHubUserStore: GitHubUserStore,
  accounts: ReadonlyArray<Account>
): IAutocompletionProvider<any>[] {
  const autocompletionProviders: IAutocompletionProvider<any>[] = [
    new EmojiAutocompletionProvider(emoji),
  ]

  // Issues autocompletion is only available for GitHub repositories.
  const gitHubRepository = isRepositoryWithGitHubRepository(repository)
    ? getNonForkGitHubRepository(repository)
    : null

  if (gitHubRepository !== null) {
    autocompletionProviders.push(
      new IssuesAutocompletionProvider(
        issuesStore,
        gitHubRepository,
        dispatcher
      )
    )

    const account = accounts.find(a => a.endpoint === gitHubRepository.endpoint)

    autocompletionProviders.push(
      new UserAutocompletionProvider(
        gitHubUserStore,
        gitHubRepository,
        account
      ),
      new CoAuthorAutocompletionProvider(
        gitHubUserStore,
        gitHubRepository,
        account
      )
    )
  }

  return autocompletionProviders
}
