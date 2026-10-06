/**
 * 客户端**能力缺口**的提示文案 —— 单一真源。
 *
 * ## 为什么要有这个文件
 *
 * 本仓库有一条由用户实测报告逼出来的硬约束:**点了必须有反应,反应必须是实话**。
 * 当某个上游控件背后的能力在浏览器半**没有落点**时,正确的做法不是留一个静默
 * no-op(那正是「看着能点、点了没反应」),而是给一条**点名缺什么**的 toast。
 *
 * 这些提示语被**多处**消费,同一句用户可见的话写两遍必然漂移(本项目已有同因返工,
 * 见 `styles.ts` 里 `--sr-only` 基础配方那条注释),所以集中在这里:
 *
 * | 常量 | 消费点 |
 * |---|---|
 * | `PUBLISH_REPOSITORY_UNAVAILABLE` | `changes-view.tsx` 的「没有本地变更」空态(`发布仓库` 建议动作)与 `toolbar.tsx` 同步段的 `publishRepositoryButton` |
 * | `WORKTREE_UNAVAILABLE` | `repo-bar.tsx` 仓库行右键的 `New worktree…`(`PopupType.AddWorktree`)与 `Show worktrees`(`dispatcher.showWorktreesFoldout()`) |
 *
 * ## 可回收条件(逐条)
 *
 * - host 侧出现 `publishRepository` 路由(即 `src/client/api.ts` 出现 `api.publishRepo`)⇒
 *   删掉 `PUBLISH_REPOSITORY_UNAVAILABLE`,两处调用点改去调它并 toast 成功/失败;
 * - host 侧出现 worktree 路由(`git worktree list/add/remove`)且客户端接线 ⇒
 *   删掉 `WORKTREE_UNAVAILABLE`,`RepoListDispatcher` 的两个 case 改走真实流程。
 *
 * 本模块**只有两个字符串常量**,没有任何运行期依赖(不 import 任何东西),所以它不会
 * 把额外文件拉进编译闭包,也不会给样式面/作用域面带来任何新东西。
 * @module dsh-git/client/unsupported-notices
 */

/**
 * 「发布仓库」缺什么 —— 上游 `ui/toolbar/push-pull-button.tsx:526` 的
 * `publishRepositoryButton` 在 Desktop 里会打开 `ui/publish-repository/**` 那一整套
 * 建库向导(仓库名 / 描述 / 私有公开 / 组织 / 首提交),而浏览器半**没有**这条通路:
 * `src/host/**` 没有建库路由(`publishRepository` / `createRepository` 都没有),
 * 客户端也没有那个向导。
 *
 * 所以这里**点名缺的那一条**(host 路由),并给出今天真正可走的替代路径 ——
 * 不说「暂不支持」这种没信息量的话。
 */
export const PUBLISH_REPOSITORY_UNAVAILABLE =
  '「发布仓库」还没有实现:host 没有 publishRepository 路由(在 GitHub 上建库需要令牌与建库调用)。' +
  '现在请先在 GitHub 上建库,再对本地仓库执行 git remote add origin <url>,之后就能推送/发布分支。';

/**
 * 「worktree」缺什么 —— 上游 `ui/repositories-list/repositories-list.tsx:467-472`
 * 的 `New worktree…`(`PopupType.AddWorktree`)与 `:475-477` 的 `Show worktrees`
 * (`dispatcher.showWorktreesFoldout()`)在 Desktop 里会切到
 * `ui/toolbar/worktree-dropdown.tsx` 那一整套;浏览器半**没有** worktree 能力:
 * `src/host/**` 没有任何 worktree 路由(`git worktree list/add/remove` 一个都没有),
 * 客户端也没有那个下拉(见 `toolbar.tsx` 文件头的缺口表)。
 */
export const WORKTREE_UNAVAILABLE =
  '「worktree」还没有实现:host 没有 worktree 路由(git worktree list/add/remove 都没有),' +
  '客户端也没有那个下拉。要新建或管理 worktree,请先在终端执行 git worktree add。';
