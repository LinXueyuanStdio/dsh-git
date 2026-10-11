/*
 * ============================================================================
 * dsh-git 登记偏离 —— 见 `scripts/verify-mirror.mjs` 的 EXPECTED,
 * 键名 `ui/autocompletion/issues-autocompletion-provider.tsx`
 * ============================================================================
 *
 * 本文件与上游
 * `references/desktop/app/src/ui/autocompletion/issues-autocompletion-provider.tsx`
 * (83 行)**逐字一致**,只有**两处**不同:
 *
 * ① 上游 `:3` 的 `import { IssuesStore, IIssueHit } from '../../lib/stores/issues-store'`
 *    换成**就地声明的两个结构类型**(见下面 `IIssueHit` / `IssuesStore`)。
 *    那个模块在 **client 根不存在**(`src/core/desktop/lib/stores/issues-store.ts` 没有),
 *    而它的上游原文 `:1` 是 `import { IssuesDatabase, IIssue } from '../databases/issues-database'`
 *    ⇒ 逐字抄进来要连 `lib/databases/**`(dexie,不在 `package.json`、也不在
 *    `node_modules`,实测)一起补,而本仓**明令禁止** `npm install` 与新增依赖。
 *    真身在 **host 根**的镜像里(`src/host/mirror/lib/stores/issues-store.ts`),
 *    两个根之间不能互相 import(见 `scripts/verify-mirror.mjs` 文件头)。
 *    ⇒ 只把本文件**真正用到**的成员(一个 `IIssueHit` 的字段集 + `IssuesStore`
 *    的 `getIssuesMatching` 一个签名)就地声明成结构类型,**不是 `any`**:
 *    真契约一旦漂移,调用点 `this.issuesStore.getIssuesMatching(...)` 会在编译期报错。
 *    同一手法、同一理由已经登记在 `user-autocompletion-provider.tsx` 的偏离②③上。
 *
 * ② `renderItem` 里那个 `<TooltippedContent …>{item.title}</TooltippedContent>` 换成
 *    `React.createElement(TooltippedContent, props, item.title)`。**类型层的原因**:
 *    本仓钉 `@types/react@18`,那一代**类组件不再有隐式的 `children` prop**
 *    (`ITooltippedContentProps` 里没有声明它),而镜像件 `render()` 又读
 *    `this.props.children`(`ui/lib/tooltipped-content.tsx`)⇒ JSX 写法直接 TS2769
 *    (`Property 'children' does not exist …`,实测)。**同一条诊断今天已经在存量文件
 *    `ui/branches/branch-list-item.tsx:116` 上**(它登记在 `scripts/type-baseline.json`
 *    里);而本文件是**新文件**,留一条未登记诊断就是 `check-types` 的回归判据,
 *    而 `--write-baseline` 是明令禁止的动作。
 *    `createElement` 的 children 走第三个可变参数重载 ⇒ 类型成立、产出的 DOM 逐字相同
 *    (类名/属性/文本一字不差)。同一手法已登记在
 *    `ui/lib/author-input/author-input.tsx` 的 EXPECTED 上(它也是为一个类组件的
 *    `children` 做的同一件事)。
 *    ⇒ 上游 `:1` 的 `import * as React from 'react'` 因此**保留**(它现在是**被用到**的,
 *    所以**没有** `emoji-autocompletion-provider.tsx` 那条 TS6133)。
 *
 * ⚠️ **另外两条刻意「不」偏离**(别下一个人当成抄漏):
 *  · `:2` 的 `import { IAutocompletionProvider } from './index'` **保留**:那个 `export *`
 *    桶(`ui/autocompletion/index.ts`,与上游字节一致)在 2026-10 之后**六个模块全部在树里**
 *    (本轮补了 emoji / issues / build 三个),所以它不再把不存在的模块拉进包 ——
 *    这正是 `autocompleting-text-input.tsx` / `ref-name-text-box.tsx` /
 *    `author-input.tsx` / `user-autocompletion-provider.tsx` 四条既有偏离的**回收条件**;
 *    那四条本轮**刻意不动**(见报告:动它们会把桶拉进 Git 页等无关 bundle,收益为 0)。
 *  · `:6` 的 `import { Dispatcher } from '../dispatcher'` **保留**:`Dispatcher` 是
 *    本仓的**手写替身**(`ui/dispatcher/index.ts`,已在 EXPECTED 里登记),
 *    本轮为它补了 `refreshIssues`(本文件 `:48` 唯一用到的那一个成员) —— 见那份登记的说明。
 *
 * **退役条件(两条同时满足就删掉本块与下面两个声明,还原成上游原文,并删除本文件的
 * EXPECTED 条目)**:① client 根补上 `lib/stores/issues-store.ts` + `lib/databases/**`
 * (真身:含 dexie 依赖);② 本仓的 `@types/react` 让**类组件的隐式 `children`** 回来
 * (或 `ITooltippedContentProps` 显式声明 `children`)—— 那一条只为消掉偏离②。
 */

/**
 * 上游 `lib/stores/issues-store.ts:9-15` 的 `IIssueHit`,逐字(含注释)。
 */
import * as React from 'react'

export interface IIssueHit {
  /** The title of the issue. */
  readonly title: string

  /** The issue's number. */
  readonly number: number
}

/**
 * 上游 `lib/stores/issues-store.ts` 的 `IssuesStore` 里**本文件真正用到**的成员,
 * 名字与签名逐字(`:156-160` 的 `getIssuesMatching`;上游第三个形参带默认值
 * `maxHits = DefaultMaxHits`,这里保持可选)。
 */
export type IssuesStore = {
  /** 上游 `lib/stores/issues-store.ts:156`。 */
  getIssuesMatching(
    repository: GitHubRepository,
    text: string,
    maxHits?: number
  ): Promise<ReadonlyArray<IIssueHit>>
}

import { IAutocompletionProvider } from './index'
import { Dispatcher } from '../dispatcher'
import { GitHubRepository } from '../../models/github-repository'
import { ThrottledScheduler } from '../lib/throttled-scheduler'
import { TooltippedContent } from '../lib/tooltipped-content'

/** The interval we should use to throttle the issues update. */
const UpdateIssuesThrottleInterval = 1000 * 60

/** The autocompletion provider for issues in a GitHub repository. */
export class IssuesAutocompletionProvider
  implements IAutocompletionProvider<IIssueHit>
{
  public readonly kind = 'issue'

  private readonly issuesStore: IssuesStore
  private readonly repository: GitHubRepository
  private readonly dispatcher: Dispatcher

  /**
   * The scheduler used to throttle calls to update the issues for
   * autocompletion.
   */
  private readonly updateIssuesScheduler = new ThrottledScheduler(
    UpdateIssuesThrottleInterval
  )

  public constructor(
    issuesStore: IssuesStore,
    repository: GitHubRepository,
    dispatcher: Dispatcher
  ) {
    this.issuesStore = issuesStore
    this.repository = repository
    this.dispatcher = dispatcher
  }

  public getRegExp(): RegExp {
    return /(?:^|\n| )(?:#)([a-z\d\\+-][a-z\d_]*)?/g
  }

  public getAutocompletionItems(
    text: string
  ): Promise<ReadonlyArray<IIssueHit>> {
    this.updateIssuesScheduler.queue(() => {
      this.dispatcher.refreshIssues(this.repository)
    })

    return this.issuesStore.getIssuesMatching(this.repository, text)
  }

  public renderItem(item: IIssueHit, selected: boolean): JSX.Element {
    // Keyboard users never focus the list itself, they move the selection with
    // the arrow keys while focus stays in the input, so the selected item is
    // what stands in for focus here. There's no pointer to anchor to in that
    // case, hence positioning the tooltip relative to the title instead.
    return (
      <div className="issue" key={item.number}>
        <span className="number">#{item.number}</span>&nbsp;
        {React.createElement(
          TooltippedContent,
          {
            className: 'title',
            tagName: 'span',
            tooltip: item.title,
            onlyWhenOverflowed: true,
            ancestorFocused: selected,
            positionRelativeToTarget: selected,
          },
          item.title
        )}
      </div>
    )
  }

  public getItemAriaLabel(item: IIssueHit): string {
    return `#${item.number} ${item.title}`
  }

  public getCompletionText(item: IIssueHit): string {
    return `#${item.number}`
  }
}
