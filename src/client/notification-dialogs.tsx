/**
 * **通知详情对话框的 flow owner**(2026-10-09)—— 上游 `ui/app.tsx` 那三个 `PopupType`
 * 在我们这半的**唯一渲染方**。
 *
 * ## 上游的形状(逐条,带 `file:line`)
 *
 * ```
 * alive 事件 ──▶ notifications-store.ts:192-208
 *                  const onClick = () => { this.statsStore.increment(…); this.onPullRequestCommentCallback?.(repository, pullRequest, comment) }
 *                  showNotification({ title, body, userInfo: event, onClick })   ← :203
 *                                     │
 *                                     ├─ 有 desktop-notifications ⇒ 原生通知 + notificationCallbacks
 *                                     └─ 没有 ⇒ show-notification.ts:18-27 的 **HTML5 分支**
 *                                                 notification.onclick = () => { focusWindow(); options.onClick() }
 *                                     │
 *                                     ▼ 用户点了那条通知
 *                          ui/app.tsx:2587 / :2644 / :2773
 *                          case PopupType.PullRequestChecksFailed / PullRequestReview / PullRequestComment
 *                                     │
 *                                     ▼
 *                          <PullRequestChecksFailed|PullRequestReview|PullRequestComment … />
 * ```
 *
 * ## 我们这半照搬了什么、换了什么
 *
 * | 上游 | 这里 | 说明 |
 * |---|---|---|
 * | `showNotification` 的 `onClick` | **照搬** | `src/client/notify.ts` 的 `INotificationRequest.onClick` 挂到 `notification.onclick`;`notifications.ts` 的 `deliverAll` 传 `() => stream.requestDialog(n)` |
 * | 「点了才弹」 | **照搬** | 对话框**不自动弹** —— 上游也不是自动弹的(`onClick` 才走),这一点与「一有通知就糊一个模态」有本质区别 |
 * | `app.tsx` 的三个 case | **照搬** | 本文件的 `switch`,`props` 逐条对齐 |
 * | `PopupType` 那个联合 | **换成** `dialogRequest` | 上游的 popup 载荷存在 `AppStore` 里;我们只有一个 `IHighSignalNotification`,它的 `payload` 字段就是那三个 case 各自要的原始对象 |
 * | Electron 的 modal 壳 | **换成** `DialogStackContext` | 镜像的三个对话框**自己**渲染 `Dialog`(`.gw-dialog` 那一族),所以本文件只负责「挂上去 / 拆下来」 |
 *
 * ## 诚实边界(读之前先读这段)
 *
 * 1. **只接了「点系统通知」这一条入口**。上游还有一条 `skipNotification === true`
 *    的档(`notifications-store.ts:198-201`:不显示通知、**直接** `onClick()`)——
 *    那条在我们的轮询路里没有对应物(**不**做,因为我们的轮询一次可能带好几条,
 *    全弹出来就是糊屏)。所以 `dialogRequest` 只有「用户点了通知」一个写入方。
 * 2. **`emoji` 恒空 Map**:见 `notification-dialog-models.ts` 的 `EMPTY_EMOJI`。
 * 3. **`accounts` 里没有令牌**:见 `toAccount`。对话框里「切仓库 + checkout PR 分支」
 *    那条链**不完整**(它要真令牌)。这一点**没有**被本轮隐藏,但**也没有**真跑过。
 * 4. **`shouldChangeRepository` / `shouldCheckoutBranch` 恒 `false`**:
 *    上游由 popup 的构造方(dispatcher)按「那个 PR 是不是当前仓库的」算;
 *    我们只有当前仓库的通知,所以「换仓库」恒不需要。**`shouldCheckoutBranch`
 *    恒 `false` 是保守取舍** —— 打开 checkout 那条链要真令牌(见第 3 条),
 *    开着它会让用户按到一个必然失败的分支。
 *
 * @module dsh-git/client/notification-dialogs
 */

import * as React from 'react'

import { PullRequestChecksFailed } from '../core/desktop/ui/notifications/pull-request-checks-failed.tsx'
import { PullRequestComment } from '../core/desktop/ui/notifications/pull-request-comment.tsx'
import { PullRequestReview } from '../core/desktop/ui/notifications/pull-request-review.tsx'
import { Dispatcher } from '../core/desktop/ui/dispatcher/index.ts'
/*
 * ⚠️ **副作用 import,而且是本轮修掉的一个真缺陷**(2026-10-09)。
 *
 * `lib/api.ts` 替身有一条「GitHub 传输层未注入」的硬失败,注入它的是一个
 * **模块级副作用**:`src/client/ci-transport.ts:63` 的 `setGitHubTransport({...})`。
 * 而在本轮之前,那个文件**只有一个 importer** —— `pulls-view.tsx`。
 *
 * 于是 `PullRequestChecksFailed.componentDidMount` → `loadCheckRunLogs`
 * → `getCheckRunActionsWorkflowRuns` → `API.fetchPRActionWorkflowRunByCheckSuiteId`
 * 会**抛**「GitHub 传输层未注入」—— 只要用户**没先打开过 Pull requests 页**就点那条
 * 检查失败通知(实测:本探针第一次跑到 W3 就是这么崩的,栈逐字在上面那个提交里)。
 *
 * 这条缺陷在 ③ 之前**不可能发生**:那个对话框当时**零渲染方**
 * (`grep -rn "PullRequestChecksFailed" src/` 只命中 `models/popup.ts` 的枚举)。
 * 是 ③ 把它接上之后才成为可达路径的 —— 所以修它属于 ③ 的一部分,不是顺手改。
 *
 * 为什么放在**本文件**(而不是 workbench):本文件由 `workbench.tsx` 静态 import
 * ⇒ 插件注册时就加载 ⇒ 注入时机从「看运气(取决于用户点过什么)」变成**确定**。
 * 它**不**引入新的可达性:`ci-transport.ts` 早已经 `pulls-view.tsx` 在包里。
 */
import './ci-transport.ts'
import type { IHighSignalNotification } from './notifications.ts'
import {
  emptyEmoji,
  toAccount,
  toIAPIComment,
  toPullRequestModel,
  toRefChecks,
  toRepositoryWithGitHubRepository,
  toValidReview,
} from './notification-dialog-models.ts'

/**
 * 那三个对话框对 `Dispatcher` 的**全部**需求。
 *
 * 上游 `app.tsx` 从 props 收一个 `this.props.dispatcher`(在 `ui/index.tsx:295`
 * 构造的**真** Dispatcher)。我们这半没有那个对象 —— 我们的
 * `ui/dispatcher/index.ts` 是**手写窄门面**(用户裁决「走窄门面,不用整个
 * Dispatcher」),里面只有被真正调用过的方法。
 *
 * **已量**:这三个对话框加起来只调用它 **3** 个方法 ——
 * `incrementMetric`(埋点)/ `openInBrowser`(把 PR、check run 用系统浏览器打开)/
 * `showPopup`(「Committing as」那类浮层的入口),三个都在替身里。
 *
 * ⚠️ 所以这是一个**真的有实现**的实例,不是 `{} as Dispatcher` 那种空壳:
 * 空壳会让「点一下打开 PR」变成 `undefined is not a function`。
 * `ci-transport.ts` 的 `ciDispatcher` 是同一套做法。
 */
const dispatcher = new Dispatcher()

/**
 * 三个对话框共用的那一份「外界」。
 *
 * 上游从 `this.props.dispatcher` + `this.state.accounts` + `this.state.emoji` +
 * `this.state.underlineLinks` 各取一处(`app.tsx:2587/2644/2773`),这里合成一份,
 * 免得三个 `case` 各写一遍。
 */
export interface INotificationDialogEnv {
  /** 当前仓库在磁盘上的绝对路径(构造 `RepositoryWithGitHubRepository` 用)。 */
  readonly repositoryPath: string
  /** 当前登录名(`''` = 未登录)。 */
  readonly login: string
  /** 头像地址(可选)。 */
  readonly avatarUrl?: string
  /** 账号 id(可选;拿不到就 `-1`)。 */
  readonly accountId?: number
}

/**
 * 渲染 `notification` 对应的那一个上游对话框。
 *
 * `onDismissed` 与 `onSubmit` **都**是「关掉它」—— 上游同一处也是这么传的
 * (`app.tsx:2596-2597` 等:`onSubmit={onPopupDismissedFn}` / `onDismissed={onPopupDismissedFn}`,
 * 同一个函数)。
 *
 * ⚠️ **返回 `null` 的三种情况都是「有话说」的**,不是静默失败:
 *  - `env.repositoryPath === ''` ⇒ 还没有仓库,构造不出上游的 `Repository`(调用方不该渲染本组件);
 *  - `toRepositoryWithGitHubRepository` 回 `null` ⇒ `owner`/`name` 解析不出来;
 *  - `toValidReview` 回 `null` ⇒ 那条 review 不在**逐字镜像**的那个闸门里
 *    (`APPROVED` / `CHANGES_REQUESTED` / `COMMENTED`)。理论上到不了这里
 *    (通知本身就是过闸门才建的),所以这是一条**纵深防御**,不是主判据。
 *
 * @param props - 要显示的那条通知 + 环境。
 * @returns 对话框元素,或不渲染。
 */
export function NotificationDialog(props: {
  notification: IHighSignalNotification
  env: INotificationDialogEnv
  onClose: () => void
}): React.ReactElement | null {
  const { notification, env, onClose } = props

  const repository = toRepositoryWithGitHubRepository(
    env.repositoryPath,
    notification.owner,
    notification.repo,
    `https://github.com/${notification.owner}/${notification.repo}`,
  )
  if (repository === null) {
    return null
  }
  const accounts = [toAccount(env.login, env.avatarUrl ?? '', env.accountId ?? -1)]
  const pullRequest = toPullRequestModel(notification.payload.pull, repository)

  /*
   * `payload` 的判别式与通知自己的 `kind` 同值(`NotificationPayload` 的定义里
   * 就是这么钉的),所以这里按 `payload.kind` 收窄即可 —— 不必再信外面的 `kind`。
   */
  const payload = notification.payload
  switch (payload.kind) {
    case 'pr-comment':
      return React.createElement(PullRequestComment, {
        key: notification.id,
        dispatcher,
        shouldCheckoutBranch: false,
        shouldChangeRepository: false,
        repository,
        pullRequest,
        comment: toIAPIComment(payload.comment),
        emoji: emptyEmoji(),
        onSubmit: onClose,
        onDismissed: onClose,
        underlineLinks: false,
        accounts,
      })
    case 'pr-review-submit': {
      const review = toValidReview(payload.review)
      if (review === null) {
        return null
      }
      return React.createElement(PullRequestReview, {
        key: notification.id,
        dispatcher,
        shouldCheckoutBranch: false,
        shouldChangeRepository: false,
        repository,
        pullRequest,
        review,
        emoji: emptyEmoji(),
        onSubmit: onClose,
        onDismissed: onClose,
        underlineLinks: false,
        accounts,
      })
    }
    case 'pr-checks-failed':
      return React.createElement(PullRequestChecksFailed, {
        key: notification.id,
        dispatcher,
        shouldChangeRepository: false,
        accounts,
        repository,
        pullRequest,
        checks: toRefChecks(payload.checks),
        onSubmit: onClose,
        onDismissed: onClose,
      })
    default:
      /*
       * 穷尽性检查:`payload.kind` 只有三支。多出一支时这一行**编译不过**
       * (下面那个赋值把 `never` 赋给具体类型),而不是运行期静默什么都不画。
       */
      return assertNever(payload)
  }
}

/**
 * 联合穷尽性检查(编译期)。
 *
 * @param value - 应当是 `never` 的那一支。
 * @returns 永不返回。
 */
function assertNever(value: never): never {
  throw new Error(`未处理的通知载荷:${JSON.stringify(value)}`)
}
