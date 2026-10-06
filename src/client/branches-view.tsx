/**
 * **分支下拉的内容** —— 上游 `ui/branches/**` 的接线层。
 *
 * ## 接的是什么
 *
 * | 上游 | 本文件怎么用 |
 * |---|---|
 * | `ui/branches/branch-list.tsx`(441) | 分支列表本体(`SectionFilterList` + 30px 行高 + 分组 + 过滤框 + 右键菜单) |
 * | `ui/branches/branch-renderer.tsx`(51) | `renderDefaultBranch` / `getDefaultAriaLabelForBranch` —— 上游的行渲染与 aria 文案 |
 * | `ui/branches/branch-list-item.tsx`(139) | 行本体(当前分支标记 + `<RelativeTime>` + `TooltippedContent`) |
 * | `ui/branches/group-branches.ts`(74) | 分组:Default / Recent / Other(`branch-list` 内部 `memoizeOne(groupBranches)`) |
 * | `models/branch.ts` | `Branch` / `BranchType` —— 我们的 `BranchEntry` 翻译成它 |
 *
 * ## 与上游 `BranchesContainer` 的差别(**如实记录,不假装**)
 *
 * 上游那个下拉的面板是 `BranchesContainer`(`branches-container.tsx`,512 行):
 * `TabBar`(Branches / Pull Requests)+ 分支列表 + PR 列表 + `PullRequestQuickView`。
 * 本文件只接**分支列表**那一半,原因逐条:
 *
 *  1. `BranchesContainer` 需要 `dispatcher`(Delete/Rename/AddWorktree/Popup 十余个方法)
 *     与 `IBranchesState` 的全套字段(`recentBranches` / `defaultBranch` /
 *     `currentPullRequest` / `emoji` / `isLoadingPullRequests` …),而 PR 那一半依赖
 *     `lib/ci-checks/**` + `ui/pull-request-quick-view.tsx` + `ui/check-runs/**`
 *     —— 那三个面今天**还没有镜像**(缺口清单见交付说明);
 *  2. 我们的 `Snapshot` 里**没有**当前仓库的 PR 列表(只有 `remoteRepos`),
 *     所以 PR 页签今天无论如何都是空态 ⇒ 先接「有数据的那一半」;
 *  3. 上游面板的**布局契约**是 `.branches-container`(`_branches.scss:1-6`:
 *     `height:100%;display:flex;flex-direction:column;width:365px`),
 *     所以这里保留这个根类名(见下面的 `<div className="branches-container">`),
 *     等 PR 页签接上时整个面板会被 `BranchesContainer` 原样替换 —— 那时代码删掉本文件即可。
 *
 * ## 数据缺口(不是代码缺口,已登记)
 *
 *  - `defaultBranch`:我们的 host 没有「默认分支」这个概念(`Snapshot` 无此字段)
 *    ⇒ 传 `null`。`groupBranches` 对 `null` 有显式分支(`group-branches.ts:17`),不会出空组。
 *  - `recentBranches`:上游是 Desktop 数据库里的「最近用过」清单,我们没有
 *    ⇒ 传 `[]`。「Recent」组因此不出现(只影响分组,不影响任何交互)。
 *  - 分支行的 **commit 日期**:`branch-list.tsx:239` 用 `getAuthors` 取,
 *    而 host 没有按 sha 查作者的路由 ⇒ 日期缺失(见 `lib/git/log.ts` 的 shim 说明)。
 *
 * @module dsh-git/client/branches-view
 */

import { useCallback, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { BranchList } from '../core/desktop/ui/branches/branch-list.tsx';
import {
  getDefaultAriaLabelForBranch,
  renderDefaultBranch,
} from '../core/desktop/ui/branches/branch-renderer.tsx';
import { Branch, BranchType } from '../core/desktop/models/branch.ts';
import { removeRemotePrefix } from '../core/desktop/lib/remove-remote-prefix.ts';
import { repositoryForEntry } from './repo-bar.tsx';
import { api } from './api.ts';
import { ConfirmDialog } from './bits.tsx';
import type { GitStore, Snapshot } from './store.ts';

export interface BranchDropdownContentProps {
  readonly store: GitStore;
  readonly snap: Snapshot;
  readonly onClose: () => void;
}

/**
 * `BranchList` 的**本地包装**:关掉上游那个「按 sha 取提交日期」的调用。
 *
 * ## 为什么必须有它(真 Chrome 探针实测,不是从代码推的)
 *
 * 上游 `ui/branches/branch-list.tsx:215-246` 的 `populateCommitDates()` 是:
 *
 * ```text
 * missing = allBranches 里不在模块级 commitDateCache 里的 sha
 * getAuthors(repository, missing).then(x => { x.forEach(把日期写进缓存); this.populateCommitDates() })
 * ```
 *
 * 它**默认 `getAuthors` 对每个请求的 sha 都返回一条**(上游是 `git log --no-walk
 * --stdin`)。而我们的替身 `src/core/desktop/lib/git/log.ts` 返回 **`[]`**
 * (host 还没有 `log/authors` 路由)—— 于是一个 sha 都进不了缓存 ⇒ `missing` 永不缩小
 * ⇒ **无限微任务递归**;每一圈还 `setState({commitAuthorDates: new Map()})` 一次。
 *
 * 微任务队列因此**永远排不空**,事件循环**永远到不了 timer 阶段** —— 这正是用户报的
 * 「点开当前分支下拉框就卡死」(实测主线程再也回不到事件循环、`setTimeout` 再也不跑)。
 * 只有「仓库里一个分支都没有」时 `missing.length > 0` 不成立,才躲得过去。
 *
 * | 探针 variant(`docs/probes/branch-dropdown-probe.mjs`) | 结果 |
 * |---|---|
 * | `asis`(原样) | **卡死**(CDP `Runtime.evaluate` 连续 3s+6s 超时) |
 * | `no-click`(装好计数器但不点) | 正常(`interval` 100 tick、`maxGap` 6ms)⇒ 是**点击**触发的 |
 * | `no-focustrap` / `no-ro`(ResizeObserver 永不回调) | **仍然卡** ⇒ 排除焦点陷阱与 RO |
 * | `render-stub`(上游 `render()` 换成空 div、生命周期照跑) | **仍然卡** ⇒ 一次排除整棵 `List`/`AutoSizer`/过滤框 |
 * | `no-date-loop`(关掉 `missing.length > 0` 那个块) | **不卡**,面板可交互、计时器继续走 |
 * | `getauthors-filled` / `shim-reject`(每个 sha 一条 / 直接 reject) | **不卡** |
 * | `loop-proof`(在 `populateCommitDates` 入口插桩、500 圈抛错) | **不卡**,且读到 **502 次调用** ⇒ 递归无界被探针截断 |
 *
 * ## 为什么用「子类覆盖生命周期」而不是改上游或复制一份
 *
 * `populateCommitDates` 的**唯一**入口是 `componentDidMount` / `componentDidUpdate`
 * (上游 `:248` / `:209`),而它填的只是**分支行上的一个相对时间**(我们本来就没有这个
 * 数据:`lib/git/log.ts` 头部的说明写明了 host 缺 `log/authors`)。所以这里覆盖这两个
 * 生命周期,等于「关掉一个**取不到的**装饰」,**渲染/过滤/键盘/右键/选中一个字不改**,
 * 上游文件也一个字不改(goal 文档 §2.1 规则 3 的「在我们的层里包一层」)。
 *
 * 用「少一个取不到的日期」换「页面不再冻死」是**有意的、可退役的保真度让步**。
 *
 * ## 退役条件(满足即删掉本类,直接 `import { BranchList }` 使用)
 *
 * 1. `src/core/desktop/lib/git/log.ts` 的 `getAuthors` 遵守上游契约 —— 要么在 host
 *    补上 `log/authors {path, shas}` 路由后**对每个 sha 返回一条**,要么在拿不到时
 *    **reject**(上游调用方的 `.catch` 会终止递归,这才是「宁缺勿假」的正确失败通道);
 * 2. 并且 `log` 这个 Electron 注入的**全局**在浏览器半有真实实现(上游
 *    `lib/globals.d.ts:135` 是 `declare const log`;`branch-list.tsx:244` 的 catch 分支
 *    直接引用它 ⇒ 今天的它一旦执行就是 `ReferenceError: log is not defined`,
 *    探针 `shim-reject` variant 实测到 3 条这样的未处理拒绝。补法是
 *    `src/client/desktop-globals.ts` 导出真实 `log`,由 esbuild `inject` 接管)。
 *
 * 两条都满足后再删本类 —— 那时分支行会重新带上真实日期。
 */
class BranchListWithoutCommitDates extends BranchList {
  /**
   * 上游这里调 `this.populateCommitDates()`。**刻意不调**:见上面的机制说明。
   * 类型上无参覆盖是可以的(TS 允许方法少声明参数)。
   */
  public componentDidMount(): void {
    /* 有意为空 */
  }

  /**
   * 上游这里在 `allBranches` 变化时再调一次 `populateCommitDates()`。同样不调;
   * 否则换仓库 / 刷新分支会再一次走进那条无限递归。
   */
  public componentDidUpdate(): void {
    /* 有意为空 */
  }
}

/**
 * 分支下拉的面板内容(上游 `BranchList`)。
 *
 * 过滤词由本组件持有(与上游 `BranchesContainer` 的受控 `filterText` 同一形状),
 * 这样关掉再打开时保留上次的关键词 —— 与移植前的 `BranchPanel` 行为一致。
 */
/**
 * **分支右键菜单的接线**(2026-10 本轮补)—— 修的是「渲染得出来、点了没反应」。
 *
 * ## 缺口是什么(逐行追出来的)
 *
 * 上游 `ui/branches/branch-list.tsx:289-309` 的 `onBranchContextMenu` 第一句就是:
 *
 * ```text
 * if (onRenameBranch === undefined && onDeleteBranch === undefined &&
 *     onCheckoutInNewWorktree === undefined) { return }
 * ```
 *
 * 而本文件此前**三个都没传** ⇒ 右键分支行**连菜单都不弹**(不是「菜单项点了没反应」,
 * 而是整个右键手势完全没有可观察结果)。上游那三个回调最终落到
 * `BranchesContainer` → 应用层的 `PopupType.RenameBranch` / `DeleteBranch` /
 * `AddWorktree`(`ui/branches/branches-container.tsx:52-53` 就是 `onRenameBranch` /
 * `onDeleteBranch` 两个 prop)。
 *
 * ## 为什么这里能接(能力已经存在,只差接线)
 *
 * host 半**已经有**这两条路由,客户端 api 也**已经导出**(但全仓 0 个调用点 —— 这正是
 * 「能力已存在、UI 不可达」的典型):
 *   - `src/host/routes.ts:761` `branch-rename` → `git-service.ts:1152`
 *     (`git branch -m -- old new`);
 *   - `src/host/routes.ts:770` `branch-delete` → `git-service.ts:1158`
 *     (`git branch -D -- name`);
 *   - `src/client/api.ts:475-476` 的 `renameBranch` / `deleteBranch`。
 *
 * 所以没有发明任何新能力:只是把上游那两个回调接到**既有**api 上。
 *
 * ## 没有应用层弹窗宿主 ⇒ 用我们自己的 `ConfirmDialog`
 *
 * 上游弹的是 `ui/create-branch/…` / `ui/branches/delete-branch-dialog`(本 checkout
 * **没有镜像**,见交付报告),而 `PopupType` 那条路要应用层弹窗宿主。我们这层已有的
 * 等价形状就是 `bits.tsx` 的 `ConfirmDialog`(它本来就带单行输入框,文档里写明
 * 「Desktop 的 Create Alias / Rename 都是这个形状」)。**复用,不新造**。
 *
 * ## 可回收条件
 *
 * 上游 `RenameBranch` / `DeleteBranch` 两个弹窗**镜像落地**后:把下面两个 `ConfirmDialog`
 * 换成那两个组件本体,并让 `BranchList` 的两个回调改走 dispatcher
 * (`RenameBranch` / `DeleteBranch`),本文件的 `api.renameBranch` / `api.deleteBranch`
 * 直接调用随之删掉。
 *
 * ## 远端分支为什么只报缺、不假装
 *
 * `Delete…` 这一项**上游对远端分支也画**(`branch-list-item-context-menu.tsx:65-70`
 * 没有 `enabled` 守卫),而它走的是 `deleteRemoteBranch`(`git push <remote> --delete`);
 * 我们的 host **没有**那条路由(只有本地 `git branch -D`)。所以这里明确拒绝并说清原因,
 * 而不是让 `git branch -D origin/xxx` 去报一条让人看不懂的错。
 */
export function BranchDropdownContent(props: BranchDropdownContentProps): ReactNode {
  const { store, snap, onClose } = props;
  const [filter, setFilter] = useState('');
  /** 正在重命名的分支(`from` = 原名,`value` = 输入框当前值);`null` = 没有对话框。 */
  const [renaming, setRenaming] = useState<{ from: string; value: string } | null>(null);
  /** 正在确认删除的分支名;`null` = 没有对话框。 */
  const [removing, setRemoving] = useState<string | null>(null);

  const currentName = snap.status?.branch ?? '';
  /**
   * 当前仓库路径,**单独取成一个原始值**再进依赖数组。
   *
   * 为什么不是直接写 `snap.current`:`react-hooks/exhaustive-deps` 会把
   * 「可变值(`snap`)的成员」判成非法依赖(它会要求依赖写 `snap` 本身,而那会让
   * 每次轮询都换一次回调身份)。原文件在别处也踩过这一条(@212 那条存量告警),
   * 这里**不再新增**同类告警 —— 与 `pulls-view.tsx` 的 `onCountRef` 是同一类处理。
   */
  const repoPath = snap.current;
  const allBranches = useMemo(() => toDesktopBranches(snap.branches), [snap.branches]);
  const currentBranch = allBranches.find((b) => b.type === BranchType.Local && b.name === currentName) ?? null;

  // 仓库实例:分支列表要它做 `repository` prop(上游 :30 `readonly repository: Repository`)。
  // 找不到当前条目(空态/首帧)时退化成一个占位路径 —— 列表此时也不会渲染出内容。
  const entryIndex = snap.repos.findIndex((entry) => entry.path === snap.current);
  const entry = entryIndex >= 0 ? snap.repos[entryIndex] : undefined;
  const repository = useMemo(
    () => repositoryForEntry(entry ?? { path: snap.current, name: '', remote: null, addedAt: 0 }, Math.max(0, entryIndex)),
    [entry, entryIndex, snap.current],
  );

  const checkout = (branch: Branch): void => {
    if (branch.type === BranchType.Remote) {
      // 远端分支 → 本地名:上游 `BranchesContainer` 走 `dispatcher.checkoutBranch`
      // 的 createFromRemote 路径;我们沿用移植前 `BranchPanel` 的同一套
      // (`removeRemotePrefix` 把 `origin/thing/my-branch` 剥成 `thing/my-branch`,
      // 而不是只切第一个 `/`)。
      const local = removeRemotePrefix(branch.name) ?? branch.name;
      void store.checkout(local, branch.name);
    } else {
      void store.checkout(branch.name);
    }
    onClose();
  };

  /** 右键「Rename…」→ 打开输入框(改名前的守卫与落点说明见 `BranchDropdownContent` 的注释)。 */
  const beginRename = useCallback((name: string) => {
    setRemoving(null);
    setRenaming({ from: name, value: name });
  }, []);

  /** 右键「Delete…」→ 打开确认框;远端分支在这一步就明确拒绝(host 没有那条路由)。 */
  const beginDelete = useCallback((name: string) => {
    const branch = allBranches.find((b) => b.name === name);
    if (branch !== undefined && branch.type === BranchType.Remote) {
      store.toast(
        `「${name}」是远端分支:删除远端分支要 host 的 deleteRemoteBranch(push --delete)路由,今天还没有。`,
        'err',
      );
      return;
    }
    if (name === currentName) {
      // git 自己也会拒绝(`branch -D` 删不掉当前检出的分支),但那句话是英文且难懂。
      store.toast(`「${name}」是当前分支,不能删除。先切到别的分支。`, 'err');
      return;
    }
    setRenaming(null);
    setRemoving(name);
  }, [allBranches, currentName, store]);

  /*
   * 两个确认框的三个回调。
   *
   * **必须包 `useCallback`,不能只写成「具名引用」**:`react/jsx-no-bind`
   * (`eslint-plugin-react@7.37.5` 的 `JSXAttribute` 分支)会把**组件作用域里**的
   * 函数声明 / `const x = () => {}` 一并记进违规集合 —— 只有 `useCallback(...)`
   * 这类 CallExpression 它不认(见该规则 `getNodeViolationType`)。
   * `scripts/lint-baseline.json` 是只拦上升的棘轮,所以这里按规则的真实口味写。
   *
   * 副作用**不写进 `setState` 的更新函数**:那个函数必须纯(StrictMode 下会跑两次,
   * 会建出两个分支 / 删两次),所以读当前值 → 先清空 → 再执行。
   */
  const onRenameValueChange = useCallback((value: string) => {
    setRenaming((prev) => (prev === null ? null : { from: prev.from, value }));
  }, []);

  const onRenameDone = useCallback((okay: boolean) => {
    const target = renaming;
    setRenaming(null);
    if (!okay || target === null) {
      return;
    }
    void renameBranchInRepo(store, repoPath, target.from, target.value);
  }, [renaming, repoPath, store]);

  const onDeleteDone = useCallback((okay: boolean) => {
    const target = removing;
    setRemoving(null);
    if (!okay || target === null) {
      return;
    }
    void deleteBranchInRepo(store, repoPath, target);
  }, [removing, repoPath, store]);

  return (
    <div className="branches-container">
      {/*
       * ⚠️ 这里是 `BranchListWithoutCommitDates`(**本地包装**),不是上游 `BranchList`。
       * 覆盖两个生命周期以关掉「按 sha 取提交日期」那条不可满足的调用 —— 它就是用户报的
       * 「点开当前分支下拉框卡死」的根因。机制、实测表与**退役条件**都写在上面的类注释里。
       */}
      <BranchListWithoutCommitDates
        repository={repository}
        defaultBranch={null}
        currentBranch={currentBranch}
        allBranches={allBranches}
        recentBranches={[]}
        selectedBranch={currentBranch}
        filterText={filter}
        onFilterTextChanged={setFilter}
        canCreateNewBranch={true}
        onCreateNewBranch={(name) => {
          void store.createBranch(name);
          onClose();
        }}
        /*
         * ⭐ 这两条就是上面那段长注释修的东西:不传它们,上游
         * `branch-list.tsx:289-309` 的 `onBranchContextMenu` 会**直接 return**
         * ⇒ 右键分支行什么都不弹。传了之后菜单里会出现 `Rename…` / `Delete…`
         * (`branch-list-item-context-menu.tsx:27-33` / `:65-70`),
         * 且这两项现在**真的有落点**(`api.renameBranch` / `api.deleteBranch`)。
         */
        onRenameBranch={beginRename}
        onDeleteBranch={beginDelete}
        onItemClick={checkout}
        getBranchAriaLabel={getDefaultAriaLabelForBranch}
        renderBranch={(item, matches, authorDate) =>
          renderDefaultBranch(item, matches, currentBranch, authorDate)
        }
        noBranchesMessage="这个仓库还没有分支"
      />

      {/*
       * 两个对话框渲染在面板里(与 `repo-bar.tsx` 的别名 / 移除确认框同一形状):
       * `.gw-dialog-scrim` 是 `position:absolute;inset:0`(`styles.ts:420`),它最近的定位祖先
       * 是 `#foldout-container`(上游 `toolbar/dropdown.tsx:366-379` 给的
       * `position:absolute;top:rect.bottom`),所以遮罩正好盖住「工具栏以下」那块 ——
       * 也就是这个下拉面板自己占的区域。**刻意不用 portal**:本层还没有 portal 先例,
       * 而 repo-bar 那两个确认框也是这么渲染的,两处形状一致更重要。
       */}
      {renaming !== null && (
        <ConfirmDialog
          title="重命名分支"
          body={`把「${renaming.from}」改成新的名字。本地分支的改名不会改动远端。`}
          confirmText="重命名"
          input={{
            value: renaming.value,
            placeholder: renaming.from,
            onChange: onRenameValueChange,
          }}
          onDone={onRenameDone}
        />
      )}

      {removing !== null && (
        <ConfirmDialog
          title={`删除分支 ${removing}?`}
          body={'这是 `git branch -D`:没有合并的提交会一起丢掉。远端上还留着这个分支。'}
          confirmText="删除"
          danger={true}
          onDone={onDeleteDone}
        />
      )}
    </div>
  );
}

/**
 * 真正落库:重命名本地分支。**放在模块作用域**(不是组件里)有两个理由:
 *
 *  1. 它不依赖任何 React 状态 —— 只是「打一条 api + 刷一次库」;
 *  2. `react/jsx-no-bind` 只盯**组件作用域**里的函数绑定,模块作用域的函数引用是干净的
 *     (规则源码里 `getBlockStatementAncestors(node).length > 0` 那个条件)。
 *
 * 失败一律回显 host 的原话(`result.error.message`),不吞。
 * @param store - 用来弹 toast 与刷新。
 * @param repoPath - 当前仓库绝对路径。
 * @param from - 旧分支名。
 * @param next - 用户输入的新分支名(前后空白在这里裁掉)。
 */
async function renameBranchInRepo(store: GitStore, repoPath: string, from: string, next: string): Promise<void> {
  const name = next.trim();
  if (name === '') {
    store.toast('分支名不能为空。', 'err');
    return;
  }
  if (name === from) {
    return;
  }
  const result = await api.renameBranch(repoPath, from, name);
  if (!result.ok) {
    store.toast(result.error.message, 'err');
    return;
  }
  store.toast(`已把 ${from} 重命名为 ${name}`);
  // 分支清单、当前分支名(`status.branch`)与历史都可能变 ⇒ 一次刷全。
  await store.refreshAll();
}

/**
 * 真正落库:删除本地分支。走的就是 host 的 `git branch -D -- <name>`(强制删除,
 * 与上游 `DeleteBranch` 的语义一致:它先试 `-d`,再按用户确认走 `-D`)。
 * @param store - 用来弹 toast 与刷新。
 * @param repoPath - 当前仓库绝对路径。
 * @param name - 要删除的分支名。
 */
async function deleteBranchInRepo(store: GitStore, repoPath: string, name: string): Promise<void> {
  const result = await api.deleteBranch(repoPath, name);
  if (!result.ok) {
    store.toast(result.error.message, 'err');
    return;
  }
  store.toast(`已删除分支 ${name}`);
  await store.refreshAll();
}

/** `BranchEntry[]`(host 的形状)→ 上游 `Branch[]`(逐字段映射,不做别的推断)。 */
function toDesktopBranches(entries: Snapshot['branches']): Branch[] {
  return entries.map(
    (entry) =>
      new Branch(
        entry.name,
        entry.upstream,
        { sha: entry.sha },
        entry.isRemote ? BranchType.Remote : BranchType.Local,
        entry.ref,
      ),
  );
}
