/**
 * **「Committing as」卡(提交者身份浮层)的能力缺口文案** —— 本泳道的单一真源。
 *
 * ## 为什么不写进 `unsupported-notices.ts`
 *
 * 那个文件**就是**为这类「点了必须有反应、反应必须是实话」的文案建的(它的文件头
 * 写得比这里更细),所以这里的常量**本该**住在它里面。但那张卡的可改文件白名单
 * 只有 `src/client/changes-view.tsx` / `src/client/scss/**` / `docs/probes/**` 与本
 * 泳道**新增**的文件 —— `unsupported-notices.ts` 不在其中。
 *
 * ⇒ 折中:文案放这里,**逐条写回收条件**,并请 `unsupported-notices.ts` 的持有者
 * 在下一次碰那条泳道时把这两条搬过去(搬完删本文件)。这不是「另起一个真源」的
 * 借口:本文件只有两个字符串常量、零运行期依赖(与 `unsupported-notices.ts` 同形),
 * 且**没有任何第二处**复述这两句话。
 *
 * @module dsh-git/client/commit-avatar-notices
 */

/**
 * 浮层里那个 `repository settings` 链接(`ui/changes/commit-message-avatar.tsx:260-263`
 * 的 `LinkButton`)没有落点 —— 上游它派发
 * `PopupType.RepositorySettings` + `RepositorySettingsTab.GitConfig`
 * (`ui/changes/commit-message.tsx:801-807`),即**仓库设置弹窗的 Git Config 页**。
 * 浏览器半**没有**这个弹窗:上游 `ui/repository-settings/**` 整支不在镜像渲染路径上,
 * 我们的 `PopupType` 也没有对应的渲染分支。
 *
 * 所以这里**点名缺什么**,并给出今天真能走的两条路(不写「暂不支持」这种没信息量的话)。
 *
 * 回收条件:仓库设置弹窗接线(出现 `RepositorySettings` 渲染分支 + Git Config 页)
 * ⇒ 删掉这条常量,`changes-view.tsx` 的 `onOpenRepositorySettings` 改去打开它。
 */
export const REPOSITORY_SETTINGS_UNAVAILABLE =
  '「仓库设置」弹窗还没有实现:上游 ui/repository-settings/**(含 Git Config 页)在浏览器半没有落点。' +
  '今天要改本仓库的作者信息,请用顶栏的偏好设置页,或在终端执行 ' +
  'git config --local user.name / user.email。';

/**
 * `Open Git Settings` 按钮的**临时**兜底:偏好设置弹窗的入口还没从 workbench 接到
 * 变更区。
 *
 * ## 为什么会有这条(以及它不是「假装」)
 *
 * 上游 `ui/changes/commit-message.tsx:809-814` 的 `onOpenGitSettings` 派发
 * `PopupType.Preferences` + `PreferencesTab.Git`。用户已明确「Git 页就是偏好设置页」,
 * 所以这条按钮的**目标是我们自己的 `PreferencesDialog`**(`preferences-dialog.tsx`)——
 * 而它的开合状态活在 `workbench.tsx` 的 `popup` state 里(`openPreferences` 是该文件
 * 内部的闭包,不是导出物,`ChangesView` 的 props 只收 `{store, snap}`)。
 *
 * ⇒ 那条**一行**的接线(`<ChangesView … onOpenPreferences={openPreferences} />`)必须由
 * `workbench.tsx` 的持有者做;在它落地之前,这里给一条**说实话**的 toast,而不是
 * 一个静默 no-op、也不是把按钮藏起来(藏了将来补 Git 页还得记得挖回来)。
 *
 * 回收条件:`workbench.tsx` 把 `openPreferences` 作为 `onOpenPreferences` 传进
 * `ChangesView`(或另一条线把 `initialSelectedTab` 落地后一次接成 Git 页)
 * ⇒ 删掉这条常量,`changes-view.tsx` 里那段兜底分支一并删掉。
 */
export const GIT_SETTINGS_ENTRY_NOT_WIRED =
  '偏好设置弹窗的入口还没从 workbench 接到变更区(ChangesView 的 props 里没有' +
  ' onOpenPreferences)。现在请用顶栏的齿轮打开偏好设置。';
