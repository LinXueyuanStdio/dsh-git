/**
 * **共同作者行(Co-Authored-By)** —— 上游 `ui/changes/commit-message.tsx:827-848`
 * 的 `renderCoAuthorInput()` 在我们这一侧的**唯一**落点。
 *
 * ## 一、它为什么必须是一个**新文件**(而不是往 `changes-view.tsx` 里塞一段 JSX)
 *
 * 上游那一行不是「一个输入框」,它有三条**独立**的可见性/取值条件,而且那三条
 * 分散在 `CommitMessage` 的三个成员上:
 *
 * | 上游 | 内容 | 位置 |
 * |---|---|---|
 * | `isCoAuthorInputEnabled` | `repository.gitHubRepository !== null` | `commit-message.tsx:815-817` |
 * | `isCoAuthorInputVisible` | `showCoAuthoredBy && isCoAuthorInputEnabled` | `:819-821` |
 * | `findCoAuthorAutoCompleteProvider` | 从提供者清单里挑出 `CoAuthorAutocompletionProvider` | `:271-281` |
 * | `renderCoAuthorInput()` | 上面三条 ∧ `<AuthorInput …>` | `:827-848` |
 * | 「刚打开就聚焦输入框」 | `componentDidUpdate` 里 `prevProps.showCoAuthoredBy === false && isCoAuthorInputVisible && 同一个仓库 && 同一个 amend 态` ⇒ `coAuthorInputRef.current?.focus()` | `:382-392` |
 * | 「加/减人」 | `onAuthorsUpdated` → `onCoAuthorsUpdated` → `filter-changes-list.tsx:1028-1029` → `dispatcher.setCoAuthors` | `:824-825` |
 * | 「显示/隐藏」 | `onShowCoAuthoredByChanged(!showCoAuthoredBy)`(`getAddRemoveCoAuthorsMenuItem`) | `:849-874` |
 *
 * ⚠️ **我们**渲染的不是上游的 `CommitMessage`:`src/client/changes-view.tsx` 的
 * `CommitBox` 是**手写壳**(它自己的文件头写着这一点)。所以这一行只能由我们这一层
 * 挂上去;把它塞进 `CommitBox` 的 JSX 里会让那 6 条语义散落在手写壳的中间,
 * 下一次改 `CommitBox` 就会把某一条碰掉。
 *
 * ## 二、与上游**逐字相同**的部分
 *
 * · 三条可见性判定(上面表格的前三行)**逐字**搬过来,一行没改;
 * · 渲染的那一件**就是**上游那件:`ui/lib/author-input/author-input.tsx`
 *   (镜像原文,`verify-mirror.mjs` 里登记的偏离只有一处 import 说明符 ——
 *   绕开 `export *` 桶,见那个文件的文件头)。**没有**第二份「作者输入框」的实现。
 * · 加/减人**只有一条**出口:`AuthorInput` 的 `onAuthorsUpdated` →
 *   `props.onCoAuthorsUpdated`。上游也是这一条(`:824-825`),
 *   不额外提供「直接改列表」的入口。
 *
 * ## 三、与上游**不同**的两处(以及为什么)
 *
 * 1. **类组件 → 函数组件**(上游 `CommitMessage` 是 `React.Component`)。后果只有一处:
 *    上游用 `coAuthorInputRef = React.createRef<AuthorInput>()` 记引用,这里用
 *    `useRef` + `useEffect` **逐条复刻** `componentDidUpdate` 里那条聚焦规则
 *    (判据是同一个:`prev.showCoAuthoredBy === false` ∧ 可见 ∧ 同一个仓库 ∧
 *    同一个 amend 态)。**没有**用任何 React-18 专有 API ——
 *    本仓磁盘上是 React **17.0.2**(`node_modules/react/package.json`),
 *    `useSyncExternalStore` / `useId` 那类 18-only 导出在这里会让整棵树卸掉。
 * 2. **提供者清单由调用方传**(`autocompletionProviders`),而不是像上游那样从
 *    `sidebar.tsx:143-152` 的 `buildAutocompletionProviders(...)` 现建 —— 那一份构造器
 *    在本仓**不在树里**(缺 3 个类型模块 + `dispatcher.refreshIssues`,逐条证据写在
 *    `src/client/store.ts` 的 `coAuthorAutocompletionProviders()` 的 JSDoc 里)。
 *
 * ## 四、⚠️ 今天它**渲染出 `null`**,而且这是**已知的正确行为**(不是失败)
 *
 * 两条**互相独立**的闸门今天都关着,`renderCoAuthorInput()` 就会像上游那样
 * `return null`:
 *
 * | 闸门 | 上游 | 我们的现状(证据) |
 * |---|---|---|
 * | `repository.gitHubRepository !== null` | `:815-817` | **恒 false** —— `src/client/changes-view.tsx:3380-3384` 的 `CommitBox` 与 `src/client/repo-state-cache.ts:210` 的 `repoFor()` 都按 `new Repository(path, 0, null, false[, alias])` 构造,而本插件客户端**没有** GitHub API / 认证集成 |
 * | 清单里能找到 `CoAuthorAutocompletionProvider` | `:832-838` | **恒 null** —— `store.coAuthorAutocompletionProviders()` 今天返回 `[]`(缺 `GitHubUserStore` + `GitHubRepository` + `Account`) |
 *
 * ⇒ **「挂上去看不见」不是本文件没接好,是上面两样前置不存在。**
 * 判据 `docs/probes/co-authors-row-probe.mjs` 把这两条**当成读数量**(而不是绕过它们):
 * 生产形状的挂载 ⇒ 行**不在**;注入夹具(真 `Repository` + 真
 * `CoAuthorAutocompletionProvider` over 桩 `GitHubUserStore`)⇒ 行**在**,
 * 且加/减人真的走完 `AuthorInput → onAuthorsUpdated → store` 那条链。
 *
 * **退役条件**(两条闸门各自):① 客户端接上 GitHub 仓库身份 ⇒
 * `currentRepository()` 返回带 `gitHubRepository` 的实例;② client 根补上
 * `GitHubUserStore` 与三个类型模块 ⇒ `coAuthorAutocompletionProviders()` 改成
 * `build-autocompletion-providers.ts` 的逐字调用。两条都满足时,本文件**不需要改**。
 *
 * @module dsh-git/client/co-authors-row
 */

import { useCallback, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
/*
 * ⚠️ **不**从 `../core/desktop/ui/autocompletion/index.ts` import(那是 `export *`
 * 桶,会把三个本仓不存在的模块拉进客户端包)。直接指向定义它们的模块 ——
 * 与 `autocompleting-text-input.tsx` / `ref-name-text-box.tsx` /
 * `author-input.tsx` 三处**已经登记**的偏离同一条口径。
 */
import { CoAuthorAutocompletionProvider } from '../core/desktop/ui/autocompletion/user-autocompletion-provider.tsx';
import type { IAutocompletionProvider } from '../core/desktop/ui/autocompletion/autocompletion-provider.ts';
import { AuthorInput } from '../core/desktop/ui/lib/author-input/author-input.tsx';
import type { Author } from '../core/desktop/models/author.ts';
import type { Repository } from '../core/desktop/models/repository.ts';
/*
 * **写侧**的类型来自镜像替身(`lib/stores/git-store.ts`),不是我们自己的形状 ——
 * 见 `ICoAuthorsRowProps.store` 的 JSDoc(只取 `Pick`,理由也写在那里)。
 */
import type { GitStore as MirrorGitStore } from '../core/desktop/lib/stores/git-store.ts';

/**
 * 上游 `ui/changes/commit-message.tsx:271-281` 的**逐字**副本(那 11 行一段没改):
 *
 * ```ts
 * function findCoAuthorAutoCompleteProvider(
 *   providers: ReadonlyArray<IAutocompletionProvider<any>>
 * ) {
 *   for (const provider of providers) {
 *     if (provider instanceof CoAuthorAutocompletionProvider) {
 *       return provider
 *     }
 *   }
 *   return null
 * }
 * ```
 *
 * 为什么用 `instanceof` 而不是 `provider.kind === 'user'`:上游那么写是有理由的 ——
 * `CoAuthorAutocompletionProvider`(`user-autocompletion-provider.tsx:208-218`)
 * **继承** `UserAutocompletionProvider` 但**只改了两条**:`getRegExp()` 少了 `@` 强制
 * (`:209-211`)、`getAutocompletionItems()` 允许 `unknown-user` 命中(`:213-217`)。
 * 两者的 `kind` **都是 `'user'`**(`UserAutocompletionProvider.kind = 'user'`,`:64`),
 * 所以按 `kind` 挑会挑中普通的 `UserAutocompletionProvider` —— 那样共同作者输入框
 * 会**丢掉**「不加 `@` 也能补」「搜不到的人也能先加进来」这两条行为,而**界面看起来一样**。
 *
 * @param providers - 提供者清单(生产来源见 `store.coAuthorAutocompletionProviders()`)。
 * @returns 挑中的那一个;清单里没有 ⇒ `null`(上游此时 `return null`,整行不渲染)。
 */
function findCoAuthorAutoCompleteProvider(
  providers: ReadonlyArray<IAutocompletionProvider<unknown>>,
): CoAuthorAutocompletionProvider | null {
  for (const provider of providers) {
    if (provider instanceof CoAuthorAutocompletionProvider) {
      return provider;
    }
  }

  return null;
}

/**
 * 上游 `commit-message.tsx` 那一行读/写的**全部**输入(逐条给出上游来源)。
 *
 * ⚠️ 这里**没有** `onShowCoAuthoredByChanged` —— 开关那一项在我们这侧属于
 * `CommitBox` 的提交选项菜单(`changes-view.tsx` 的 `commitOptionsMenuItems`),
 * 不在这一行里;上游也是分开的两处(`:849-874` 是菜单项,`:827-848` 是这一行)。
 */
export interface ICoAuthorsRowProps {
  /**
   * **写侧唯一入口** —— 取的是**镜像替身** `lib/stores/git-store.ts` 的
   * `setCoAuthors`(上游 `git-store.ts:1448-1451`,名字与签名逐字)。
   *
   * 为什么是 `Pick<…, 'setCoAuthors'>` 而不是整个 `GitStore`:那份替身还声明着
   * `defaultRemote` / `setRemoteURL`(宿主侧 git 能力,见它的文件头),我们的
   * `src/client/store.ts` 的类**没有**它们 ⇒ 整体结构性满足做不到;
   * 这里只钉共同作者那一个写方法(它是这一行唯一需要的)。
   *
   * 为什么写侧**不**像上游那样走一个 `onCoAuthorsUpdated` 回调 prop:
   * 上游那个 props 回调最终也是落到 `dispatcher.setCoAuthors(repository, coAuthors)`
   * (`filter-changes-list.tsx:1028-1029` → `app-store.ts:8858`)—— 而我们这一层
   * 没有 dispatcher 那条总线,`store.setCoAuthors` **就是**那个终点。
   * 直接钉镜像类型的好处是**编译期**:`src/client/store.ts` 的类少一个同名方法,
   * 调用点(报告里给出的 `changes-view.tsx` 编辑)就在这里报 TS2741。
   *
   * ⚠️ **读侧**(`showCoAuthoredBy` / `coAuthors`)**不走** store 而走 props:
   * 快照才是 React 的重渲染来源,直接读 `store.coAuthors` 会拿到**不重渲的旧值**
   * (本仓的 `useState` + `subscribe` 模式见 `changes-view.tsx` 的 `Probe`/`Workbench`)。
   */
  readonly store: Pick<MirrorGitStore, 'setCoAuthors'>

  /**
   * 当前仓库(镜像 `models/repository.ts`)—— 上游 `commit-message.tsx:815-817`
   * 的闸门读它的 `gitHubRepository`。
   */
  readonly repository: Repository

  /** 上游 `commit-message.tsx:133` 的 `showCoAuthoredBy`(来自 `IChangesState:826`)。 */
  readonly showCoAuthoredBy: boolean

  /** 上游 `commit-message.tsx:147` 的 `coAuthors`(来自 `IChangesState:835`)。 */
  readonly coAuthors: ReadonlyArray<Author>

  /** 上游 `:838` 的 `readOnly={this.props.isCommitting === true}`。 */
  readonly isCommitting: boolean

  /**
   * 上游 `componentDidUpdate` 那条聚焦规则里的第二个守卫
   * (`:389` 的 `!!prevProps.commitToAmend === !!this.props.commitToAmend`)。
   * 我们的载体是 `snap.commitForm.amend`(上游那半边是 `commitToAmend: Commit | null`)。
   */
  readonly isAmending: boolean

  /** 上游 `:115` 的 `autocompletionProviders`(由 `:832-838` 挑一个出来)。 */
  readonly autocompletionProviders: ReadonlyArray<IAutocompletionProvider<unknown>>
}

/**
 * 渲染共同作者那一行(或 `null`)。
 *
 * 与上游 `renderCoAuthorInput()` 的三条判定**逐条对应**,顺序也一样
 * (先 `visible`,再 `provider`;两个都是 `return null`)——
 * 顺序不能换:上游的 `:1806` 是 `{this.renderCoAuthorInput()}`,它在
 * `renderAmendCommitNotice()` 与 `renderSubmitButton()` **之前**,所以「行不出现」
 * 不会影响后面两件的布局。
 * @param props - 见 {@link ICoAuthorsRowProps}。
 * @returns `AuthorInput` 元素,或 `null`。
 */
export function CoAuthorsRow(props: ICoAuthorsRowProps): ReactNode {
  const {
    store, repository, showCoAuthoredBy, coAuthors, isCommitting, isAmending,
    autocompletionProviders,
  } = props;

  const coAuthorInputRef = useRef<AuthorInput>(null);

  /**
   * 上游 `commit-message.tsx:824-825` 的 `onCoAuthorsUpdated` ——
   * 我们这一侧的终点是镜像替身那个 `setCoAuthors`(理由见 `ICoAuthorsRowProps.store`)。
   *
   * 为什么用 `useCallback` 而不是 JSX 内联箭头:`react/jsx-no-bind`
   * (`scripts/lint-baseline.json` 是只拦上升的棘轮)会把组件作用域里的内联箭头
   * 记成**新增**违规;`store` 的引用是稳定的,所以这里身份也稳定。
   */
  const onCoAuthorsUpdated = useCallback((authors: ReadonlyArray<Author>) => {
    store.setCoAuthors(authors);
  }, [store]);

  /** 上游那两条 getter(`:815-821`),逐字。 */
  const isCoAuthorInputEnabled = repository.gitHubRepository !== null;
  const isCoAuthorInputVisible = showCoAuthoredBy && isCoAuthorInputEnabled;

  /*
   * 上游 `componentDidUpdate`(`:382-392`)那条「刚从隐藏变可见 ⇒ 把焦点给输入框」:
   *
   * ```ts
   * if (
   *   prevProps.showCoAuthoredBy === false &&
   *   this.isCoAuthorInputVisible &&
   *   prevProps.repository.id === this.props.repository.id &&
   *   !!prevProps.commitToAmend === !!this.props.commitToAmend
   * ) {
   *   this.coAuthorInputRef.current?.focus()
   * }
   * ```
   *
   * 两个守卫为什么在:`repository.id` 那条排除「切仓库时顺手聚焦」(用户没点开关);
   * `commitToAmend` 那条排除「进出 amend 态」引起的重渲染。两条都**逐字保留**。
   *
   * ⚠️ 首次渲染**不聚焦**(与上游一致:`componentDidUpdate` 不在 mount 时跑)——
   * 所以 `prevRef` 的初值就是本次渲染的值,于是 `!prev.showCoAuthoredBy` 在
   * 「一上来就可见」的那一帧为假。
   */
  const prevRef = useRef({
    showCoAuthoredBy,
    repositoryId: repository.id,
    isAmending,
  });
  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = {
      showCoAuthoredBy,
      repositoryId: repository.id,
      isAmending,
    };
    if (
      prev.showCoAuthoredBy === false &&
      isCoAuthorInputVisible &&
      prev.repositoryId === repository.id &&
      prev.isAmending === isAmending
    ) {
      coAuthorInputRef.current?.focus();
    }
  }, [isCoAuthorInputVisible, showCoAuthoredBy, repository.id, isAmending]);

  if (!isCoAuthorInputVisible) {
    return null;
  }

  /*
   * 上游 `:832-838`:拿不到那个**专用**提供者就整行不渲染。
   *
   * ⚠️ 刻意**不**回落到「随便一个 `kind === 'user'` 的提供者」:见
   * `findCoAuthorAutoCompleteProvider` 的 JSDoc(`kind` 判别不了这两者,
   * 回落会让「不加 @ 也能补」「搜不到的人也能先加」两条行为静默消失)。
   */
  const autocompletionProvider = findCoAuthorAutoCompleteProvider(autocompletionProviders);

  if (!autocompletionProvider) {
    return null;
  }

  return (
    <AuthorInput
      ref={coAuthorInputRef}
      onAuthorsUpdated={onCoAuthorsUpdated}
      authors={coAuthors}
      autoCompleteProvider={autocompletionProvider}
      readOnly={isCommitting === true}
    />
  );
}
