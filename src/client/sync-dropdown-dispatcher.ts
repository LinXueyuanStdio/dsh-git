/**
 * **顶栏同步面(推送/拉取下拉)的 Dispatcher 门面** —— 把宿主能力接到上游
 * `ui/toolbar/push-pull-button.tsx` 需要的 7 个方法上。
 *
 * ## 为什么需要它
 *
 * 上游那个文件是**与上游一致**(`verify-mirror` 要求字节一致),它不直接操作数据,
 * 而是经由 `Dispatcher` 的 7 个方法与同步面之外的世界对话:
 *
 * | 上游调用点 | 方法 | 上游落点 |
 * |---|---|---|
 * | `push-pull-button.tsx:271` | `closeFoldout(FoldoutType.PushPull)` | `appStore._closeFoldout` |
 * | `:276` | `push(repository)` | `appStore._push` |
 * | `:356` | `pull(repository)` | `appStore._pull` |
 * | `:362` | `fetch(repository, FetchType.UserInitiatedTask)` | `appStore._fetch` |
 * | `:349` | `confirmOrForcePush(repository)` | `askForConfirmationOnForcePush` 分支 → 强推 |
 * | `:375` | `setPushPullButtonWidth(width)` | `appStore._setPushPullButtonWidth` |
 * | `:383` | `resetPushPullButtonWidth()` | `appStore._resetPushPullButtonWidth` |
 *
 * 镜像里的 `src/core/desktop/ui/dispatcher/index.ts` 是**替身**(上游 4356 行命令总线
 * 属于目标文档 §1.3 排除的应用层),它只提供**类型面**;行为必须由我们这层给 ——
 * 与 History 面的 `src/client/desktop-dispatcher.ts`、
 * 仓库列表面的 `RepoListDispatcher`(`repo-bar.tsx`)是**同一形状**:
 * 替身声明方法,门面 `extends Dispatcher` 覆盖要接的那几个,其余**逐字继承**它的 no-op。
 *
 * ⚠️ 这个文件**刻意不放进 `repo-bar.tsx`**:那个文件当时被另一条泳道持有。
 * 门面是**新文件**,所以两条泳道不会在同一处落笔(goal §9「同时只允许一个写入者」)。
 *
 * ## 边界:门面只做「转发」,不放业务
 *
 * 每个方法的**语义**都留在适配层(它拿得到 `GitStore` 与 React state):
 *  - `closeFoldout(FoldoutType.PushPull)` → 适配层把「同步段下拉」置为关闭;
 *  - `push` / `pull` / `fetch` → 适配层调 store 的同步动作;
 *  - `confirmOrForcePush` → 适配层决定「弹确认框还是直接强推」(上游这一步由
 *    `askForConfirmationOnForcePush` 状态决定,而那个状态在宿主);
 *  - `setPushPullButtonWidth` / `resetPushPullButtonWidth` → 适配层的宽度 state。
 *
 * ## 两条**已知缺口**,写在这里免得被当成「已支持」
 *
 * 1. **按钮宽度没有持久化载体。** 上游那两条宽度方法落到 `appStore` 的
 *    `pushPullButtonWidth: IConstrainedValue`(`lib/app-state.ts:216`),而本插件的
 *    `GitStore` **没有**这个字段(全仓 grep `pushPullButtonWidth` 只命中镜像)。
 *    同类需要的持久化载体**已有先例**可沿用:`src/client/sidebar-width.ts`
 *    用 `localStorage['dsh-git.sidebar-width']` 存一个数 + 一个 `clamp` 纯函数。
 *    ⇒ 适配层必须自己持一个 `useState<IConstrainedValue>`(拖动手柄改它、
 *    双击复位回默认),**不要把这两个 handler 传成空函数** —— 上游
 *    `ui/resizable/resizable.tsx:31-32` 自己写着「本组件是纯的,消费者必须订阅
 *    onResize/onReset 并更新 width prop」,传空函数的结果是「手柄能拖、松手弹回」,
 *    属于「看着能点、点了没反应」那一类缺陷。
 * 2. **`confirmOrForcePush` 的「确认」那一步在宿主。** 上游读的是
 *    `appStore.getState().askForConfirmationOnForcePush`;本插件今天没有那个偏好项
 *    (`src/client/store.ts` 的 prefs 里没有),所以适配层的落点是
 *    `store.push(true)`(= `--force-with-lease`,与「更多」菜单里的强推项
 *    **同一个调用**,不新增能力)。要复刻上游那个确认弹窗,得先有那个偏好项。
 *
 * ## 不做假:其余方法保持继承来的 no-op
 *
 * 替身里另外 12 个方法(`showPopup` / `selectRepository` / `changeFileSelection` …)
 * 本门面**一个都不覆盖**,因为 `ui/toolbar/push-pull-button.tsx` 的
 * render 与全部回调里**没有任何一处**调用它们(逐条核对过上面那张表的 7 个之外零命中)。
 * 覆盖它们只会制造「我们支持了」的错觉。
 *
 * @module dsh-git/client/sync-dropdown-dispatcher
 */

import { Dispatcher } from '../core/desktop/ui/dispatcher/index.ts';
import type { FoldoutType } from '../core/desktop/lib/app-state.ts';
import type { FetchType } from '../core/desktop/models/fetch.ts';
import type { Repository } from '../core/desktop/models/repository.ts';

/**
 * 适配层提供的宿主能力。**全部是转发**,不做判断 —— 判断留在视图里
 * (那里才拿得到 `GitStore` 与 React state)。
 */
export interface ISyncDropdownDispatcherHost {
  /** 关掉同步段的 foldout(上游 `FoldoutType.PushPull`)。 */
  readonly closeFoldout: (foldout: FoldoutType) => void;
  /** 推送当前分支。 */
  readonly push: (repository: Repository) => void;
  /** 拉取当前分支。`pullWithRebase` 省略 = 宿主自己读 `pull.rebase`(见 `pull` 的注释)。 */
  readonly pull: (repository: Repository, pullWithRebase?: boolean) => void;
  /** 抓取(参数是上游 `models/fetch.ts` 的 `FetchType`)。 */
  readonly fetch: (repository: Repository, fetchType: FetchType) => void;
  /** 强推(上游 `confirmOrForcePush`;确认那一步在宿主,见文件头缺口 2)。 */
  readonly confirmOrForcePush: (repository: Repository) => void;
  /** 拖「推送/拉取」按钮的宽度手柄 → 新宽度(px)。 */
  readonly setPushPullButtonWidth: (width: number) => void;
  /** 双击宽度手柄 → 复位(见文件头缺口 1)。 */
  readonly resetPushPullButtonWidth: () => void;
}

/**
 * `Dispatcher` 的**同步面子集**实现。
 *
 * **继承**而不是 `implements`:上游传的是类实例(`import { Dispatcher }`),
 * 而基类替身里已经有另外 12 个方法的 no-op —— 继承让「门面只管同步面这 7 个」
 * 这件事在类型上也成立,不必把其余方法再写一遍。
 */
export class SyncDropdownDispatcher extends Dispatcher {
  public constructor(private readonly host: ISyncDropdownDispatcherHost) {
    super();
  }

  /** 上游 `dispatcher.ts:436`。 */
  public async closeFoldout(foldout: FoldoutType): Promise<void> {
    this.host.closeFoldout(foldout);
  }

  /** 上游 `:744`。 */
  public async push(repository: Repository): Promise<void> {
    this.host.push(repository);
  }

  /**
   * 上游 `:757`。拉取当前分支。
   *
   * `pullWithRebase` 是**本次新增的可选参数**(理由与退役条件见
   * `src/core/desktop/ui/dispatcher/index.ts` 的 `pull`):值必须与渲染按钮文案的
   * 那一个相同。上游 `ui/toolbar/push-pull-button.tsx:356` 只传 `repository` ——
   * 它读不到宿主配置,而宿主那一读**正是**文案的来源,所以这里由适配层把它带下去。
   */
  public async pull(repository: Repository, pullWithRebase?: boolean): Promise<void> {
    this.host.pull(repository, pullWithRebase);
  }

  /** 上游 `:770`。 */
  public async fetch(
    repository: Repository,
    fetchType: FetchType,
  ): Promise<void> {
    this.host.fetch(repository, fetchType);
  }

  /**
   * 上游 `:2608` —— 上游写的是 `public async confirmOrForcePush(repository)`
   * (返回类型未声明,推导为 `Promise<void>`)。调用点不 await 它。
   */
  public async confirmOrForcePush(repository: Repository): Promise<void> {
    this.host.confirmOrForcePush(repository);
  }

  /** 上游 `:1082`。 */
  public async setPushPullButtonWidth(width: number): Promise<void> {
    this.host.setPushPullButtonWidth(width);
  }

  /** 上游 `:1090`。 */
  public async resetPushPullButtonWidth(): Promise<void> {
    this.host.resetPushPullButtonWidth();
  }
}
