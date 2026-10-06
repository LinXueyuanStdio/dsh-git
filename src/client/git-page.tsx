/**
 * 「Git」页签 —— 把上游 `ui/preferences/git.tsx` 接进我们的偏好设置弹窗。
 *
 * ## 这个文件是什么 / 不是什么
 *
 * 上游 `ui/preferences/preferences.tsx` 把**页面**与**数据**写死在同一个类里
 * (它直连 `lib/git/config`、`lib/hooks/config`、`lib/helpers/default-branch` 与
 * `dispatcher`)。我们**没有**移植那个外壳(见 `preferences-dialog.tsx` 的文件头账本),
 * 所以上游 `git.tsx` 是个**受控组件**:它只认 props。本文件就是喂它 props 的那一层 ——
 * 也就是上游 `preferences.tsx` 里与 Git 页有关的那几十行。
 *
 * 它放在 `src/client/`(而不是镜像树)是刻意的:镜像树里的东西必须与上游逐字节一致,
 * 而「谁来读写本插件的全局 git config」是**我们的适配决定**,不是上游的代码。
 *
 * ## 三个子页签各自的接线状态
 *
 * | 子页签 | 状态 | 证据 |
 * |---|---|---|
 * | Author | **真接线**(全局作用域)+ **自动识别** + **姓名校验** | 读 `getGlobalConfigValue('user.name' / 'user.email')`、写 `setGlobalConfigValue(...)`;上游 `preferences.tsx:277-278` / `:1041/:1046` 用的就是这两个函数、同一个 **global** 作用域。两件事分别照上游补上:自动识别见下「作者自动识别」一节,姓名校验见 {@link GIT_AUTHOR_NAME_INVALID_MESSAGE} |
 * | Default branch | **真接线**(全局作用域) | 同一个 `lib/git/config.ts`;键 `init.defaultBranch`(上游 `lib/helpers/default-branch.ts:15` 的 `DefaultBranchSettingName`) |
 * | Hooks | **真接线**(客户端镜像 + **写穿**到宿主偏好域;宿主侧注入见下) | 见下 |
 *
 * ### 为什么 Author 必须是 GLOBAL,而不是 local
 *
 * 上游 `preferences.tsx:277-278` 读的是 `getGlobalConfigValue`,`:1041/:1046` 写的是
 * `setGlobalConfigValue` —— 偏好设置弹窗里改的是**全局** git 身份。
 * (对比:仓库设置弹窗 `ui/repository-settings/` 才用仓库作用域。)
 * ⚠️ 本仓 `src/client/settings.tsx` 里那份**已废弃**的 `GitSection` 用的是 `local`,
 * **那是错的**,不要照它做。
 *
 * ### 邮箱下拉:今天是**真接线**(数据源已落地)
 *
 * 上游 `GitConfigUserForm` 的邮箱候选取自 `Account.emails`。链路今天完整:
 *
 * ```
 * host `auth/emails` ──> api.accountEmails() ──> loadAccountEmails()（host-api-bridge）
 *   ──> accountsWithEmails(identity, emails)（account-emails）──> Account.emails
 *   ──> preferences-pages.tsx 的 emailCandidates ──> GitPage 的 emailCandidates
 *   ──> 上游 git.tsx:175 accounts ──> GitConfigUserForm
 * ```
 *
 * 三件必须说清的事:
 *
 *  1. **空列表是 no-op,不是遗漏。** 镜像文件
 *     `git-config-user-form.tsx:168-170` 自己就写着 `accountEmails.length === 0 ⇒
 *     return null`,所以候选为空时下拉**根本不渲染** —— 这条判断在镜像里,
 *     我们一个字都没写死。`docs/probes/git-page-probe.mjs` 的 E1/E2 两条断言
 *     就是钉这两个方向(空 ⇒ 0 个 `select`;非空 ⇒ 真出现带候选的 `select`)。
 *  2. **不伪造 noreply 地址。** `accountsWithEmails` 只把宿主给的邮箱原样搬进来;
 *     现代 stealth 地址需要数值 `id`,而 `AuthStatePayload` 没有 ⇒ 不猜
 *     (理由在 `account-emails.tsx` 的文件头「诚实边界 1」)。
 *  3. **上游的预填兜底以前刻意不做,2026-10 已补上**(用户点名的「git 的作者那些字段
 *     应该自动识别」)。逐条 `file:line`、与上游的**一处有意偏离**、以及「预填什么时候
 *     才落盘」都写在下面「作者自动识别」一节 —— 那是本次改动的唯一真源。
 *     旧结论「弹窗没有保存动作 ⇒ 预填会被去抖立刻写进 gitconfig」**已经不再是理由**:
 *     预填值与「已落盘基线」是同一个值({@link WRITE_DEBOUNCE_MS} 那一段的 `saved`),
 *     所以**只是打开这一页不会写任何东西**,写入仍然只由用户的编辑触发。
 *
 * ⚠️ 一条**被纠正的旧结论**:本文件曾写「一旦传入非空 accounts,
 * `GitEmailNotFoundWarning` 就会恒判『不可归属』⇒ 恒定误报」。**那是错的** ——
 * 那个组件只在 `emailIsOther`(当前邮箱不在候选里)时才渲染,且它自己算
 * `isAttributableEmailFor`,可归属时给的是绿勾而不是警告。所以喂真候选不会造出误报,
 * 它正是上游那条「这个邮箱和你的 GitHub 账号对不上」的提示。
 *
 * ### ⭐ 作者自动识别:上游到底做了什么(用户点名的「应该自动识别」)
 *
 * **上游的答案只有一个来源:GitHub 账号 —— 不是仓库里既有提交的作者,也不是
 * `git var`。** 逐条读数(全部在 `references/desktop`,行号以该 checkout 为准):
 *
 * | 步骤 | 上游 | 内容 |
 * |---|---|---|
 * | 1 | `ui/preferences/preferences.tsx:277` | `initialCommitterName = await getGlobalConfigValue('user.name')` |
 * | 2 | `:278` | `initialCommitterEmail = await getGlobalConfigValue('user.email')` |
 * | 3 | `:279` | `initialDefaultBranch = await getDefaultBranch()`(`lib/helpers/default-branch.ts:25-27`:配置里的 `init.defaultBranch`,`?? 'main'`) |
 * | 4 | `:281-282` | **两个候选值从 `initial` 起手**(即:不是「先预填再和空值比」) |
 * | 5 | `:284-297` | `if (!committerName \|\| !committerEmail)` ⇒ `accounts.find(isDotComAccount) ?? accounts.at(0)`;`!name ⇒ name = account.login`;`!email ⇒ email = lookupPreferredEmail(account)` |
 * | 6 | `:299-300` | 兜底成 `''`(两个都可能是 `undefined`) |
 * | 7 | `:1040-1052` | **只在 `onSave` 时写**:`if (state.committerName !== state.initialCommitterName) setGlobalConfigValue('user.name', …)`,`email` 同理;写完 `dispatcher.refreshAuthor(repository)`(`lib/stores/app-store.ts:4391-4402` ⇒ `getAuthorIdentity` = `git var GIT_AUTHOR_IDENT`,`lib/git/var.ts:20-42`) |
 *
 * `lookupPreferredEmail`(`lib/email.ts:17-39`)自己的优先级是:
 * **公开的 primary → 邮箱里那条 `<login>@users.noreply.github.com` → `emails[0]`**;
 * 邮箱列表**为空**时才合成 stealth 地址(`:20-22` ⇒ `getStealthEmailForUser(account.id, …)`)。
 *
 * 三处**必须说清**的事:
 *
 *  1. **不是仓库里既有提交的作者。** 全文件 grep:`preferences.tsx` 从不读
 *     `git log` / 既有提交;`getAuthorIdentity` 只在 `onSave` 之后为了刷「Committing as」
 *     浮层而调一次(`:1051`),它读的是 **`git var GIT_AUTHOR_IDENT`**
 *     —— 也就是「git 自己这次会用的身份」(配置缺失时 git 会退回系统用户名 + 主机名),
 *     **不是**历史提交的 author。它也不回填表单。
 *  2. **我们与上游的唯一一处有意偏离**:`lookupPreferredEmail` 我们只在
 *     `account.emails.length > 0` 时调用。理由:上游的 stealth 地址是真的(Desktop 的
 *     `Account.id` 来自 `/user`,是数值 id),而我们的 `Account.id` 只能是 `-1`
 *     (`AuthStatePayload` 没有 id,见 `account-emails.tsx` 的文件头「诚实边界 1」)
 *     ⇒ 调它会得到一条**伪造的** `-1+<login>@users.noreply.github.com`,预填进
 *     `user.email` 就等于把用户的提交记到一个不存在的地址上。这正是
 *     `accountsUsableAsEmailCandidates`(`account-emails.tsx:211-215`)为下拉挡掉的那条地址。
 *     **回收条件**:host 在 `AuthStatePayload` 里补数值 `id` ⇒ 删掉这个长度判断,
 *     与上游逐字一致。
 *  3. **预填什么时候落盘**:上游是「Save 时写」(第 7 步;也就是说**打开设置点保存、
 *     一个字都不改,上游也会把预填值写进全局 gitconfig**)。我们的弹窗没有保存动作
 *     (`preferences-dialog.tsx` 的表单提交只关闭弹窗),写入走
 *     {@link WRITE_DEBOUNCE_MS} 的去抖。所以这里的映射是:**预填值 = 打开时的显示值 =
 *     已落盘基线** ⇒ 打开这一页**一个字节都不写**;只有用户真的改了字段,那一组值才落盘
 *     (与上游「只写与 initial 不同的字段」逐字同形)。**有意比上游少做的那一步**是
 *     「不改也写」;回收条件:弹窗外壳给出真正的提交回调(`onSubmit` 能拿到「保存」语义)
 *     时,照上游补上那一步,并把本条偏离删掉。
 *  4. **上游的校验我们还差过一次,现在补上了**:上游 `preferences.tsx:867-874` 用
 *     `gitAuthorNameIsValid`(`ui/lib/identifier-rules.ts`,`git` 自己那份 crud 字符规则的
 *     与上游一致)给姓名把关,`:514-521` 把消息渲染成 `<DialogError>`,`:1009` 用它
 *     **禁用「保存」**。我们这边的对应物是:{@link GIT_AUTHOR_NAME_INVALID_MESSAGE} 那行提示
 *     + **该批次一个字段都不写**(= 上游「保存被禁用」的等价物)。
 *     那行提示为什么不用上游 `DialogError`:它渲染的是 `.dialog-banner.dialog-error`,
 *     而那一族的样式在 `ui/_dialog.scss` 里 —— 那份 partial 的顶层选择器是 `dialog`
 *     (整棵死树,理由见 `scss/preferences.scss` 末尾),所以用它只会得到一个**没有样式**的
 *     banner。这里改用本面已有的 `setting-hint-warning`(`git-config-links.tsx` 的锁文件
 *     告警、设备码面板、通知页都用它)。
 *
 * ### Hooks:客户端这一半是真的,**桥**也已经接上(2026-10);本文件负责「写穿」
 *
 * ⚠️ **不要因为「客户端 localStorage 无消费方」就判定 Hooks 控件无效。**
 *
 * 上游 `lib/hooks/config.ts` 读写 **`localStorage`**,而它服务的是
 * `lib/hooks/with-hooks-env.ts` —— 后者 import 的是 `fs/promises` / `net` / `os` /
 * `path` / `process-proxy`,**全是 Node-only**,并且在 **git 执行的那一刻**由
 * `lib/git/core.ts` 调用。也就是说上游要求「读 localStorage 的那一侧」与
 * 「spawn 进程的那一侧」**在同一个进程里**;它成立只是因为 Desktop 是 Electron 且
 * renderer 开了 nodeIntegration —— **不是前后端分离**。
 *
 * 本插件是分离的,于是两边各缺一半:
 *
 * | | 有什么 | 缺什么 |
 * |---|---|---|
 * | 客户端半(浏览器沙箱) | `localStorage` | 不能 spawn 进程 |
 * | 宿主半(Node) | 能 spawn git(`git-runner` → `ctx.subprocess`) | 没有浏览器的 `localStorage` |
 *
 * ⇒ **缺的是一座桥,不是「做不到」。** 桥的两半现在**都已落地**:
 *
 * | 半边 | 实现 | 状态 |
 * |---|---|---|
 * | 三个键的宿主落点 | `prefs/set` / `prefs/get` → `RepoRegistry.prefHooksEnv()`(`PrefsPatch` 的三个键) | **已落地** |
 * | spawn 前注入 shell 环境 | `src/host/hooks-env.ts` → `subprocessRunner` 的第三参(合并规则见 `git-runner.ts` 的 `mergeSpawnEnv`) | **已落地**(宿主半,**要重启 DSH 才生效**) |
 * | 钩子改道 / 进程代理 / 进度上报 | 上游 `with-hooks-env` / `hooks-proxy` / `get-repo-hooks` / `process-proxy` | **未做**(见下「阶段 3」) |
 *
 * **本文件今天比以前多一件事:写穿**({@link pushHooksEnvPrefs})。浏览器与宿主是两个
 * 进程,`localStorage` 到不了宿主,所以三个回调在写完客户端镜像之后**再发一次
 * `prefs/set`**,而且**三个值一起发** —— 镜像 localStorage 里可能存着「写穿存在之前」
 * 的值(`cache` 关过 / shell 选过 pwsh),只发变化的那一个键会把它落在宿主默认值上。
 *
 * ⚠️ **诚实边界(不要越读越乐观)**:宿主半**不热重载**
 * (`docs/goal-port-desktop.md` §2.3),所以 `src/host/**` 那部分要**重启 DSH Desktop**
 * 才生效;而且「真实钩子真的看到了 shell 环境」**没有端到端验证**
 * (那需要一个真仓库的真钩子 + 重启后的宿主)。已有的是行为级证据:
 * `docs/probes/hooks-env-probe.mjs`(真 `GitRunner` + 真 `createGitHandler`)证明
 * **spawn 的 env 里确实带着捕获到的 shell 环境**、偏好关掉时确实不带、缓存打开时
 * 确实只启一次 shell —— 不证明钩子读到了它。
 *
 * #### 阶段 3(未做,逐个点名)
 *
 * 上游那条链上仍然缺席的东西,**一条都没做**:
 *
 *  - `lib/hooks/with-hooks-env.ts` 的**钩子改道**:
 *    `GIT_CONFIG_PARAMETERS='core.hooksPath=<临时目录>'`;
 *  - `lib/hooks/hooks-proxy.ts`(309 行)+ 原生 `process-proxy` 的**进程代理**,
 *    以及 `PROCESS_PROXY_PORT` / `PROCESS_PROXY_TOKEN` 两个环境变量;
 *  - `lib/hooks/get-repo-hooks.ts` 的钩子枚举(按仓库找 hooks 目录 + 可执行位);
 *  - 临时 hooks 目录的建立与清理,以及钩子的**进度 / 失败上报**
 *    (`onHookProgress` / `onHookFailure`,界面上「钩子正在跑」那一档);
 *  - `lib/hooks/get-shell.ts` 在 Windows 上靠 `which` + 注册表定位 Git for Windows
 *    的 `bash.exe`(本仓没有这两个依赖,`hooks-env.ts` 只按可执行名找)。
 *
 * ⇒ 今天的效果是「**git 带着用户 shell 的环境去跑钩子**」(钩子仍由 git 自己
 * spawn,继承它的环境),不是「钩子被改道后由代理执行」。前者已经让钩子看到 shell
 * 环境;后者额外带来进度/失败上报与 Windows 上「钩子不可执行时替它执行」的兜底。
 * 参见 {@link HOOKS_HOST_PIPELINE_NOTE}。
 *
 * ### 「edit your global Git config file」那行链接 —— **真接线**
 *
 * 上游 `git.tsx:210-220` 的 `LinkButton` 要拿系统编辑器打开 `~/.gitconfig`。
 * 它今天**能兑现**,链路是三段(每一段都已落地):
 *
 *  1. `ui/preferences/git.tsx` 的 `onEditGlobalGitConfig` prop(上游原样,零偏离);
 *  2. 本文件把它接到 `./git-config-links.tsx` 的 `useEditGlobalGitConfig()` —— 那个模块
 *     经 `host-api-bridge.ts` 的 `openGitConfigFile()` 把 `config-file-open` 路由的结果
 *     分档(`ok` / `missing` / `error`),并且
 *     **`missing` 单独一档**:文件不存在是**可预期的用户状态**(还没配过全局
 *     gitconfig),不是故障,文案必须不一样;
 *  3. host 侧的 `config-file-info` 与 `config-file-open` 两个路由
 *     (`src/host/git-config-file.ts`;客户端包装在 `src/client/api.ts`)。
 *
 * ⚠️ 宿主**本来就有**打开任意本地文件的能力(`src/host/routes.ts` 的
 * `system/open-in-app`、`src/host/system-service.ts` 的 `openInApp`),但那条路
 * **不通用**:`system-service.ts:58-71` 的 `guard()` 只放行「已添加仓库根之下」的路径,
 * 而 `~/.gitconfig` 在仓库之外。所以这条链**不能**复用 `open-in-app`,
 * 它需要一个**专用**路由 —— 这就是 `config-file-open` 存在的理由。
 *
 * ### ✅ 退役记录(2026-10):本文件的 gitconfig 胶水已删,唯一实现在 `git-config-links.tsx`
 *
 * 本文件曾经**内联**一份同一段胶水的更粗版本 —— 一个 `loadGitConfigFileInfo()` 的
 * `useEffect`、一个 `switch (result.kind)` 的回调体、一段锁文件提示、一段结果回声,
 * 合计约 50 行。当时的退役条件是:「`./git-config-links.tsx` 修好之后,本文件应当改成
 * import 它,并删掉那段机械的胶水(它只做「分档 + 一句话」,不承担任何自己的语义)」。
 *
 * **条件已满足**:那个模块今天 `tsc --noEmit` 零诊断(实测),而它曾经 import 的
 * `hasOpenGitConfigFileRoute` 在本仓 **grep 0 命中**(`host-api-bridge.ts` 里从来没有
 * 这个导出,是那次重构删掉的)⇒ 那条「无法编译」的理由**不再成立**。
 *
 * ⇒ 本文件现在只做三件**没有替代品**的事(见下),`useGitConfigFileInfo()` /
 * `useEditGlobalGitConfig()` / `<GitConfigLockAlert>` 全部从 `./git-config-links.tsx` 来。
 * 行为**只增不减**:`GitConfigLockAlert` 比原来那段内联提示多一条「读 config-file-info
 * 失败就说失败」的分支(原来那条支路是静默的)。
 *
 * 锁文件:`config-file-info` 带回 `lockExists` / `lockPath`。上游遇到锁会弹
 * `ConfigLockFileExists`(`preferences.tsx:609-619`);我们按负责人给的尺度只显示
 * **一行状态**,不实现那个弹窗与「重试」流程 —— 那一位于 `GitConfigLockAlert`。
 *
 * ### 本文件**没有**替代品的部分(它存在的理由)
 *
 *  1. **global 作用域**:`getGlobalConfigValue` / `setGlobalConfigValue`
 *     (上游 `preferences.tsx:277-278` / `:1041/:1046`);
 *  2. **Hooks 三个偏好**:客户端镜像 `lib/hooks/config.ts`(上游 `:262-264` /
 *     `:1077-1089`)**加上写穿到宿主偏好域的一次 `prefs/set`**(见文件头「Hooks」);
 *     宿主侧的消费点是 `src/host/hooks-env.ts`;
 *  3. **写入去抖** —— 我们的弹窗外壳没有「保存」动作(见文件头「邮箱下拉」第 3 条),
 *     所以把上游的「按保存写」换成了「停下 600ms 写」。
 *
 * ## 镜像纪律(供登记 `scripts/verify-mirror.mjs` 的 `EXPECTED` 用)
 *
 * 本页依赖两个**有意偏离上游**的镜像文件(两条都只改 import 说明符,语义逐字等价):
 *
 *  1. `src/core/desktop/ui/lib/ref-name-text-box.tsx:8`
 *     上游 `from '../autocompletion'` → `from '../autocompletion/autocompletion-provider'`
 *  2. `src/core/desktop/ui/autocompletion/autocompleting-text-input.tsx:8`
 *     上游 `from './index'` → `from './autocompletion-provider'`
 *
 * **理由**:桶 `ui/autocompletion/index.ts` 与上游字节一致,它 `export *` 六个模块,
 * 其中 `emoji-` / `issues-` / `user-autocompletion-provider` 与
 * `build-autocompletion-providers` **不在镜像里** —— 它们(即使只作类型用)指向
 * `lib/stores/**` / `lib/databases/**` / `ui/dispatcher`,即 `docs/goal-port-desktop.md`
 * §1.3 明令不沿用的应用层。esbuild 会**剥掉**那些 type-only import(实测:补齐它们
 * 只需 4 个文件、产物里 `accounts-store`/`dexie`/`trampoline` 全为 false),但
 * `tsc` 会在那 4 个**新**文件里留下 12 条**永远修不掉**的诊断(见
 * `scripts/type-baseline.json` 的棘轮语义:新文件带诊断即失败)。
 * ⇒ 改这两行 import 说明符,把整片排除层挡在闭包之外。
 *
 * **可回收条件**:上面那 4 个 provider 进镜像(即 §1.3 那层被移植或替身化)之后,
 * 这两行**改回上游原文**,并删掉 `EXPECTED` 里对应的两条登记。
 * @module dsh-git/client/git-page
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { Git } from '../core/desktop/ui/preferences/git.tsx';
import { isDotComAccount, type Account } from '../core/desktop/models/account.ts';
import { lookupPreferredEmail } from '../core/desktop/lib/email.ts';
/*
 * 上游 `ui/lib/identifier-rules.ts` —— 「姓名是不是合法的 Git author name」。
 * 本轮**逐字节带进镜像**(`src/core/desktop/ui/lib/identifier-rules.ts`,24 行、零依赖),
 * 因为它是 `git` 自己那段 crud 字符规则的复制品(上游 `:1-8` 的两个链接),
 * 手写等价物正是本仓反复禁止的「第二份真源」。
 *
 * ⚠️ 只取谓词,消息(`InvalidGitAuthorNameMessage`)由我们这层给中文
 * ({@link GIT_AUTHOR_NAME_INVALID_MESSAGE}) —— 与四个本地化镜像文件同一条裁决
 * (用户可见文案本地化、镜像文件一字不改)。
 */
import { gitAuthorNameIsValid } from '../core/desktop/ui/lib/identifier-rules.ts';
import {
  getGlobalConfigValue,
  setGlobalConfigValue,
} from '../core/desktop/lib/git/config.ts';
import {
  getCacheHooksEnv,
  getGitHookEnvShell,
  getHooksEnvEnabled,
  setCacheHooksEnv,
  setGitHookEnvShell,
  setHooksEnvEnabled,
} from '../core/desktop/lib/hooks/config.ts';
/*
 * gitconfig 那两件事(path/锁文件 + 「edit your global Git config file」的回调体与回声)
 * 的**唯一实现**在 `./git-config-links.tsx`。本文件曾经内联了一份更粗的同一段胶水,
 * 2026-10 已退役 —— 见文件头「退役记录」。
 */
import {
  GitConfigLockAlert,
  useEditGlobalGitConfig,
  useGitConfigFileInfo,
} from './git-config-links.tsx';
/*
 * 邮箱候选的**收窄**(没有任何已验证邮箱的账号不进下拉)。
 *
 * 为什么收窄发生在**本文件、而不是调用点**:同一个 `Account[]` 在本页有**两个角色** ——
 * ①给上游 `GitConfigUserForm` 当**下拉候选**(必须收窄,否则镜像会凭 `id = -1` 造出
 * 一条伪造的 noreply 地址);②给「作者自动识别」当**回退来源**(上游
 * `preferences.tsx:284-297` 用的就是**全部** accounts)。两个角色放在同一处,
 * 「哪个是哪个」才不用跨文件追。收窄的判据与回收条件在
 * `account-emails.tsx` 的 `accountsUsableAsEmailCandidates` 上(唯一真源)。
 */
import { accountsUsableAsEmailCandidates } from './account-emails.tsx';
/*
 * `DialogContent` —— 上游 `ui/dialog/content.tsx` 的类(`.dialog-content`),
 * 也就是那 20px 页内边距的**唯一**来源(`ui/_dialog.scss:241-242`)。
 * 与 `preferences-pages.tsx` 走同一个再导出(那里修了上游漏声明 `children` 的类型缺口,
 * 见 `host-modal.tsx` 的「以正确的 prop 类型再导出」)。
 */
import { DialogContent } from './host-modal.tsx';
import { api } from './api.ts';

/**
 * Hooks 的**宿主侧管线**现状 —— 引用给读代码的人,不是可执行逻辑。
 *
 * 三个偏好键(`git-hooks-env-enabled` / `git-cache-hooks-env` / `git-hook-env-shell`)
 * 由客户端镜像 `lib/hooks/config.ts` 写进**浏览器 localStorage**,并由本文件**写穿**到
 * 宿主偏好域(`prefs/set` → `RepoRegistry`);宿主侧在 spawn git 之前读它们、
 * 把用户 shell 的环境注入 `git-runner` 的环境(`src/host/hooks-env.ts`)。
 *
 * **仍未做的**(阶段 3,清单见本文件头「阶段 3」):
 * `lib/hooks/{with-hooks-env,hooks-proxy,get-repo-hooks}.ts` 那一族 —— 钩子改道
 * (`core.hooksPath`)、进程代理、临时 hooks 目录、钩子进度/失败上报。
 *
 * ⚠️ 宿主半**不热重载**:改了 `src/host/**` 要**重启 DSH Desktop** 才生效;客户端半
 * 刷新页面即可。本页**不**把这些控件 `disabled`:上游机制在本架构里不是「做不到」,
 * 而是「分两步做」;disable 反而会把「上游有这个设置」这件事藏掉。
 */
export const HOOKS_HOST_PIPELINE_NOTE =
  'hooks 偏好:客户端写 localStorage + 写穿到宿主偏好域;宿主在 spawn git 前注入 shell 环境。钩子改道/进程代理未做。';

/** 上游 `lib/helpers/default-branch.ts:15` 的 `DefaultBranchSettingName`。 */
const DEFAULT_BRANCH_SETTING = 'init.defaultBranch';

/** 上游 `lib/helpers/default-branch.ts:6` 的 `DefaultBranchInDesktop`。 */
const DEFAULT_BRANCH_FALLBACK = 'main';

/**
 * 邮箱候选的**运行时**兜底:空表。
 *
 * `IGitPageProps.emailCandidates` 在类型上是**必填**的(接线方必须显式表态),
 * 这个常量只服务两件事:①无类型调用方(探针那种 `.mjs`)漏传时,得到的是上游的
 * 「无候选 ⇒ 不渲染下拉」分支,而不是 `for…of undefined` 崩掉;②它给
 * `ReadonlyArray<Account>` 一个**落点**,让「空 = 上游的 return null」这件事一眼可见。
 * **同一个空表也是「没有可回退的账号」**:作者自动识别那一半随之整段不发生。
 */
const NO_EMAIL_CANDIDATES: ReadonlyArray<Account> = [];

/**
 * 姓名非法时的提示。
 *
 * 上游的对应物是 `ui/lib/identifier-rules.ts` 的 `InvalidGitAuthorNameMessage`
 * (`'Name is invalid, it consists only of disallowed characters.'`),
 * 由 `preferences.tsx:870-872` 填进 state、`:514-521` 渲染成 `<DialogError>`、`:1009` 用来
 * **禁用「保存」**。判据(谓词 `gitAuthorNameIsValid`)逐字来自镜像;这句**文案**是我们
 * 这层的中文(与四个本地化镜像文件同一条裁决:用户可见文案本地化,镜像一字不改)。
 *
 * 为什么不能直接用它渲染的 `DialogError`:那一族的样式在 `ui/_dialog.scss`(整棵 `dialog`
 * 根的死树,理由见 `scss/preferences.scss` 末尾)⇒ 只有 `setting-hint-warning`
 * 这条本面已有的配方能保证它**看得见**(见文件头第 4 条)。
 */
export const GIT_AUTHOR_NAME_INVALID_MESSAGE =
  '姓名无效:它完全由 Git 不允许的字符(空格/标点等 crud)组成。修好之前,这一页的改动不会写进全局 Git 配置。';

/**
 * 改动停下多久之后才写全局 git config。
 *
 * 上游是「改完按弹窗的**保存**才写」(`preferences.tsx:1040-1048` 在 `onSubmit` 里),
 * 而我们的弹窗外壳的保存按钮**只关闭**(`preferences-dialog.tsx` 的
 * `<form onSubmit={… props.onClose()}>`)—— 页面没有「提交」回调可用。
 * 于是这里做**写入去抖**:停下 600ms 就落盘。
 *
 * 为什么不每次按键都写:每次写都是一次宿主 `git config --global` 子进程,
 * 打字会打出一串进程。
 */
const WRITE_DEBOUNCE_MS = 600;

/** {@link GitPage} 的全部输入。 */
export interface IGitPageProps {
  /** 轻提示(`store.toast`)。写入成功/失败都要有回声,否则「点了没反应」。 */
  readonly toast: (message: string, kind?: 'ok' | 'err') => void;

  /**
   * Author 子页签的账号候选 —— **未收窄的那一份**(上游 `preferences.tsx` 的
   * `this.props.accounts`)。本文件内部把它用在**两处**,见文件头「作者自动识别」:
   *
   *  - **邮箱下拉**:先经 {@link accountsUsableAsEmailCandidates} 收窄
   *    (`Account.emails` 一条都没有的账号不进 → 上游 `git-config-user-form.tsx:168-170`
   *    的 `accountEmails.length === 0 ⇒ return null` 自己就不渲染下拉);
   *  - **作者自动识别**:不收窄,照上游 `preferences.tsx:284-297` 找
   *    `accounts.find(isDotComAccount) ?? accounts.at(0)`。
   *
   * **必填**:接线方必须表态 —— 要么给真候选,要么显式给空数组。
   * 数据源是 `preferences-pages.tsx` 的 `accountCandidatesFor`(`auth` + `auth/emails`)。
   */
  readonly emailCandidates: ReadonlyArray<Account>;
}

/**
 * 「Git」页签的正文 —— 喂上游 {@link Git} 组件所需的全部 prop。
 *
 * @param props - 见 {@link IGitPageProps}。
 * @returns 上游 `Git` 组件。
 */
export function GitPage(props: IGitPageProps): ReactNode {
  const toast = props.toast;
  const emailCandidates = props.emailCandidates ?? NO_EMAIL_CANDIDATES;

  /*
   * `toast` 走 ref:它是外壳每次渲染都可能新建的函数,若进 `useEffect` 的依赖数组,
   * 会不停清掉写入去抖的定时器,让写入**永远不发生**(静默假接线)。
   */
  const toastRef = useRef(toast);
  toastRef.current = toast;

  /*
   * ## 为什么四个字段挤在**一个** state 对象里(不是风格问题)
   *
   * 上游 `preferences.tsx:313-349` 在 `componentWillMount`(从 `:313` 起、`:348` 收尾)末尾用**一次**
   * `this.setState({ committerName, committerEmail, defaultBranch, isLoadingGitConfig: false })`
   * 把这四个值一起交出去。这一点是**行为**而不是整洁度:镜像
   * `ui/lib/git-config-user-form.tsx:109-129` 的 `componentDidUpdate` 只在
   * `prevProps.email !== props.email` 时重算 `emailIsOther`,而重算里带着
   * `!this.props.isLoadingGitConfig`。如果我们把「email」与「isLoadingGitConfig=false」
   * 拆成两次 setState(React 18 的 legacy `render` 在同步块里**不**批处理),
   * 表单会先收到「新 email + 仍在装载」⇒ `emailIsOther` 被算成 `false` 并**就此冻结**
   * (`isLoadingGitConfig` 之后翻转时 `email` 已经不再变化 ⇒ 那条 `if` 不会再进)。
   * 后果是**显示撒谎**:盘上的 `user.email` 不在账号候选里时,下拉会显示**第一条候选地址**
   * 而不是那条真实地址(实测:盘上 `kept@example.com`,界面显示 `ada@example.com`)。
   * 这个缺陷在本轮**被新探针抓到**(`docs/probes/git-author-autodetect-probe.mjs` 的 B1),
   * 是既有实现就有的 —— 与自动识别无关,只是同一段代码。
   */
  const [form, setForm] = useState<{
    readonly name: string;
    readonly email: string;
    readonly defaultBranch: string;
    /** 上游 `isLoadingGitConfig`。 */
    readonly loaded: boolean;
  }>({ name: '', email: '', defaultBranch: DEFAULT_BRANCH_FALLBACK, loaded: false });
  const { name, email, defaultBranch } = form;
  const isLoadingGitConfig = !form.loaded;
  const [selectedTabIndex, setSelectedTabIndex] = useState(0);

  /*
   * Hooks 三个值的初值 = 上游 `preferences.tsx:281-282` 的三个读法,逐字同样的函数。
   * 传函数本身给 `useState` 即「惰性初值」:只在挂载时读一次 localStorage。
   *
   * ⚠️ `selectedShell` 的 state 类型是 `string`(不是 `SupportedHooksEnvShell`):
   * 上游 `IGitProps.selectedShell` 与 `onSelectedShellChanged` 收发的都是 `string`
   * (`git.tsx:35/39`),而 `setGitHookEnvShell(shell: string)` 也只收 `string`。
   * 用窄类型会让这个回调需要一次没有依据的断言 —— 校验已经在读侧
   * (`getGitHookEnvShell` 会把非法值折回默认值),写侧原样透传即可。
   */
  const [enableGitHookEnv, setEnableGitHookEnv] = useState(getHooksEnvEnabled);
  const [cacheGitHookEnv, setCacheGitHookEnv] = useState(getCacheHooksEnv);
  const [selectedShell, setSelectedShell] = useState<string>(getGitHookEnvShell);

  /**
   * 「盘上的原始值」—— 自动识别的**判据**,也是「用户到底改没改」的另一半。
   *
   * `null` = 还没装载完。为什么不直接看 `name` / `email`:**它们是显示值**
   * (可能已经被自动识别填过了),拿它们当判据会把「配置里没有」和「用户填了」
   * 混成同一件事。上游那边两者是分开的(`preferences.tsx:277-282` 的
   * `initialCommitterName` vs `committerName`),这里同样分开。
   */
  const [rawConfig, setRawConfig] = useState<{
    readonly name: string | null;
    readonly email: string | null;
  } | null>(null);

  /**
   * 用户**动过**这两个字段没有。动过就不再自动识别(上游语义:自动识别只决定
   * **初值**,`preferences.tsx:281-282` 之后由组件自己的 state 接管)。
   * 用 ref 而不是 state:它只在回调里被读写,不该触发渲染。
   */
  const nameTouched = useRef(false);
  const emailTouched = useRef(false);

  /**
   * 自动识别的**回声**(为什么这两个框里已经有字了)。`null` = 没有做任何识别,
   * 界面不渲染那一行(与「没有锁文件就不渲染告警」同一条纪律:不占位、不说空话)。
   */
  const [identityNote, setIdentityNote] = useState<string | null>(null);

  // ---- 装载:读全局 git config(上游 `preferences.tsx:277-279`)----
  useEffect(() => {
    let dead = false;
    void (async () => {
      try {
        const [loadedName, loadedEmail, loadedBranch] = await Promise.all([
          getGlobalConfigValue('user.name'),
          getGlobalConfigValue('user.email'),
          getGlobalConfigValue(DEFAULT_BRANCH_SETTING),
        ]);
        if (dead) {
          return;
        }
        /*
         * 上游 `:281-282`:`committerName` / `committerEmail` **从原始值起手**,
         * 自动识别在下一步(下面那个 effect)做 —— 之所以拆成两步,是因为我们的
         * 回退来源(`Account.emails`)是**异步**到的(`api.accountEmails()`):
         * 上游 `componentWillMount` 时 `props.accounts` 早就有了,而这里第一次渲染
         * 拿到的 `emailCandidates` 可能还只有账号、没有邮箱。拆开之后,邮箱到了会补上
         * 自动识别(只要用户还没动过那个字段)。
         */
        setRawConfig({ name: loadedName, email: loadedEmail });
        /*
         * **一次**把四个值交出去(上游 `:313-353` 是同一次 `setState`)——
         * 拆开会踩上面 `form` 那段注释里记的 `emailIsOther` 冻结缺陷。
         */
        setForm({
          name: loadedName ?? '',
          email: loadedEmail ?? '',
          defaultBranch: loadedBranch ?? DEFAULT_BRANCH_FALLBACK,
          loaded: true,
        });
      } catch (error) {
        if (dead) {
          return;
        }
        toastRef.current(`读取全局 Git 配置失败:${String(error)}`, 'err');
        // 读失败也要退出装载态,否则表单永远停在 `isLoadingGitConfig`(上游 :351 同理)。
        setForm((previous) => ({ ...previous, loaded: true }));
      }
    })();
    return () => {
      dead = true;
    };
  }, []);

  /*
   * ⚠️ `emailCandidates` 在调用点**每次渲染都是新数组**(身份不稳)。下面那个 effect
   * 仍然把它原样列进依赖:①它必须能在「候选**内容**变了」时再跑一次(邮箱是异步到的);
   * ②所以两个 `setForm` 都写成**幂等**的(`prev.name === account.login ? prev : …` ——
   * 值没变就返回**同一个对象**,React 直接 bail out)。没有这一层,每次父组件重渲染
   * 都会让 form 换一次身份,而那会**不停重置写入去抖的定时器**
   * (`WRITE_DEBOUNCE_MS` 那一段),让写入永远不发生 —— 正是本仓那条「静默假接线」。
   */

  /**
   * **作者自动识别** —— 上游 `ui/preferences/preferences.tsx:284-300` 的逐条移植。
   *
   * ```
   * if (!committerName || !committerEmail) {
   *   const account = accounts.find(isDotComAccount) ?? accounts.at(0)
   *   if (account) {
   *     if (!committerName) committerName = account.login
   *     if (!committerEmail) committerEmail = lookupPreferredEmail(account)
   *   }
   * }
   * ```
   *
   * **一处有意偏离**(理由与回收条件在文件头「作者自动识别」第 2 条):
   * 邮箱只在 `account.emails.length > 0` 时才用 `lookupPreferredEmail`
   * —— 上游那份在邮箱为空时会**合成**一条基于数值 `id` 的 stealth 地址,而我们的 `id`
   * 只能是 `-1` ⇒ 合成出来的是**伪造地址**。
   *
   * 触发条件三条(缺一不可):装载完成、原始值为空、用户**没动过**那个字段。
   */
  useEffect(() => {
    if (rawConfig === null || isLoadingGitConfig) {
      return;
    }
    const account = emailCandidates.find(isDotComAccount) ?? emailCandidates[0];
    if (account === undefined) {
      return;
    }

    const applied: string[] = [];
    if (!nameTouched.current && (rawConfig.name === null || rawConfig.name === '')) {
      // 幂等:值已经一样就返回**同一个对象**(见上面那段注释)。
      setForm((previous) => (previous.name === account.login
        ? previous
        : { ...previous, name: account.login }));
      applied.push(`姓名取 GitHub 账号 @${account.login} 的登录名`);
    }
    if (!emailTouched.current && (rawConfig.email === null || rawConfig.email === '')) {
      if (account.emails.length > 0) {
        const preferred = lookupPreferredEmail(account);
        setForm((previous) => (previous.email === preferred
          ? previous
          : { ...previous, email: preferred }));
        applied.push(`邮箱取该账号的首选地址 ${preferred}`);
      } else {
        // 不伪造 noreply 地址(见文件头「作者自动识别」第 2 条),但要如实说明**为什么**空着。
        applied.push('邮箱留空:该账号没有已验证的邮箱,而合成 noreply 地址会误记提交归属');
      }
    }

    /*
     * ⚠️ **只写、不清**:`applied.length === 0` 时**保持原样**,不要 `setIdentityNote(null)`。
     *
     * 理由:这个 effect 的依赖里有 `emailCandidates`,而它在调用点**每次渲染都是新数组**
     * ⇒ 父组件**任何**一次重渲染都会让本 effect 再跑一遍。如果这里顺手清空,那一行回声
     * 就会在「用户刚敲了第一个字符 + 父组件恰好重渲染」时**时有时无** —— 一个由无关渲染
     * 决定的界面,排障时无法复现。清空的时机改成**确定的**两处:用户动 Name / Email
     * 那两个回调(见下 `onNameChanged` / `onEmailChanged`)。
     */
    if (applied.length > 0) {
      setIdentityNote(
        `全局 Git 配置里缺少作者信息,已按 GitHub 账号自动识别:${applied.join(';')}。` +
        '改动之后才会写进全局 Git 配置。',
      );
    }
    /*
     * `emailCandidates` 进依赖是**必须**的(邮箱异步到的那一刻要再判一次);
     * 它的身份不稳由上面那两条幂等 `setForm` 兜住,不会造成多余渲染或去抖重置。
     * `rawConfig` / `isLoadingGitConfig` 决定这一步什么时候**允许**发生。
     */
  }, [rawConfig, isLoadingGitConfig, emailCandidates]);

  /**
   * 姓名是否非法(上游 `preferences.tsx:867-874` 的同一个谓词)。
   *
   * `gitAuthorNameIsValid` 认为**空串合法**(上游 `identifier-rules.ts:17` 的注释),
   * 所以「清空姓名」不会命中这条 —— 与上游一致(上游只有 `onSave` 时才写,空值写下去
   * 等于清掉 `user.name`,那是用户的选择)。
   */
  const nameIsInvalid = !gitAuthorNameIsValid(name);

  /*
   * ---- 写入去抖 ----
   *
   * `saved` 记的是「已经落盘的那一组值」,`null` 表示还没装载完(此时不写)。
   * 用 ref 而不是 state:它不参与渲染,也不该触发重渲染。
   *
   * ⚠️ **自动识别的值也在基线里**:装载完第一次跑这个 effect 时 `previous === null`,
   * 于是把**当时显示的**那一组值记成基线 ⇒ 只是打开这一页**一个字节都不写**
   * (文件头「作者自动识别」第 3 条:这是与上游「不改也写」的唯一区别)。
   */
  const saved = useRef<{ name: string; email: string; defaultBranch: string } | null>(null);

  useEffect(() => {
    if (isLoadingGitConfig) {
      return;
    }
    const current = { name, email, defaultBranch };
    const previous = saved.current;
    if (previous === null) {
      // 刚装载完:当前值(含自动识别)就是盘上的值,不写。
      saved.current = current;
      return;
    }
    if (
      previous.name === current.name &&
      previous.email === current.email &&
      previous.defaultBranch === current.defaultBranch
    ) {
      return;
    }
    /*
     * ⚠️ **自动识别填进来的值不能覆盖基线**。上面那条 `previous === null` 分支只在
     * 「装载完成后的第一次」跑;而自动识别可能在那之后才发生(邮箱异步到)⇒
     * 那时 `previous` 里是**原始值**(比如 `name: null`),`current` 是识别出来的名字,
     * 差值会让去抖把识别值当成「用户改的」写下去。这与本条偏离的承诺直接冲突
     * ⇒ 识别出来的值要**同步进基线**,而且只有它(用户真的敲了字才算改)。
     */
    if (previous.name !== current.name && !nameTouched.current) {
      previous.name = current.name;
    }
    if (previous.email !== current.email && !emailTouched.current) {
      previous.email = current.email;
    }
    if (
      previous.name === current.name &&
      previous.email === current.email &&
      previous.defaultBranch === current.defaultBranch
    ) {
      return;
    }

    const timer = setTimeout(() => {
      /*
       * 上游 `preferences.tsx:1009` 的 `okButtonDisabled={hasDisabledError}`:
       * 姓名非法时「保存」是**禁用**的 ⇒ 整批一个字段都不写(不是只跳过姓名)。
       * 我们这里逐字同义:**不写、也不推进基线**(修好之后照样会写)。
       */
      if (nameIsInvalid) {
        return;
      }
      saved.current = current;
      void (async () => {
        try {
          if (previous.name !== current.name) {
            await setGlobalConfigValue('user.name', current.name);
          }
          if (previous.email !== current.email) {
            await setGlobalConfigValue('user.email', current.email);
          }
          /*
           * 上游 `preferences.tsx` 的保存逻辑对默认分支有一条:空值**不写**,
           * 保留上一个值(`default-branch.ts` 那一段的注释:「If the entered default
           * branch is empty, we don't store it and keep the previous value.」)。
           * 理由同上游:偏好弹窗没有错误态,不该因为一个空输入就清掉全局配置。
           */
          if (previous.defaultBranch !== current.defaultBranch && current.defaultBranch !== '') {
            await setGlobalConfigValue(DEFAULT_BRANCH_SETTING, current.defaultBranch);
          }
          toastRef.current('已写入全局 Git 配置');
        } catch (error) {
          toastRef.current(`写入全局 Git 配置失败:${String(error)}`, 'err');
        }
      })();
    }, WRITE_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [name, email, defaultBranch, isLoadingGitConfig, nameIsInvalid]);

  // ---- Author / Default branch 的值变化(上游 `preferences.tsx` 的两个 setState)----
  /*
   * ⚠️ 这两个回调**多一件事**:把「用户动过这个字段」记下来
   * (`nameTouched` / `emailTouched`)。没有它,自动识别会在用户打字之后再覆盖一次
   * (邮箱异步到时尤其明显:用户刚敲进去的名字被登录名盖掉)。
   * 上游不需要这个标记,因为它的自动识别只跑一次(`componentWillMount`)、
   * 之后 `props.accounts` 变化也**不会**重跑 —— 我们的回退来源是异步的,
   * 所以要用「用户有没有动过」补上那层时序保护。
   */
  const onNameChanged = useCallback((value: string) => {
    nameTouched.current = true;
    // 用户接手了:自动识别那一行随之收起(见自动识别 effect 里那条「只写、不清」的注释)。
    setIdentityNote(null);
    setForm((previous) => ({ ...previous, name: value }));
  }, []);
  const onEmailChanged = useCallback((value: string) => {
    emailTouched.current = true;
    setIdentityNote(null);
    setForm((previous) => ({ ...previous, email: value }));
  }, []);
  const onDefaultBranchChanged = useCallback((value: string) => {
    setForm((previous) => ({ ...previous, defaultBranch: value }));
  }, []);

  /*
   * ---- Hooks:客户端镜像写入 + **写穿到宿主** ----
   *
   * 上半段与上游 `preferences.tsx:1077-1089` 同形:先落客户端镜像(localStorage),
   * 再回显。下半段是本仓特有的**写穿**:消费方(spawn git 前注入 shell 环境)在
   * 宿主进程里,而 `localStorage` 到不了那里(文件头「Hooks」那一节)。
   *
   * 三条设计决定,每条都有更糟的替代品:
   *
   *  1. **三个值一起发**,不是只发变化的那一个。镜像的 localStorage 里可能存着
   *     「写穿存在之前」的值(用户以前把「缓存」关过、或把 shell 选成 pwsh),只发
   *     变化键会让另外两个键在宿主上停在默认值 ⇒ 界面显示 false/pwsh 而宿主是
   *     true/git-bash,又回到「控件看着活着、行为不一致」。三个一起发是**自愈**。
   *  2. **失败要回滚**,不是乐观更新。这是 `store.ts` 的 `setModelPersisted`
   *     (`:1225-1235`)已经定过的调子:写盘失败时界面照样显示新值 = 下一次刷新弹回,
   *     用户看到的是「设置存不住」。回滚**同时**回写镜像 localStorage ——
   *     否则刷新后界面又会从 localStorage 读回那个**没生效**的值。
   *  3. **`void` + 序号守卫**:回调必须同步返回(上游 `git.tsx` 把它当普通 handler
   *     用),而并发的两次点击里,只有**最后一次**允许回滚 —— 否则先失败的那次会把
   *     后成功的那次覆盖掉。
   */
  const hooksPushSeq = useRef(0);

  /**
   * 把三个 Hooks 偏好推给宿主。
   *
   * @param next - 要写的三元组(**三个都给**,见上第 1 条)。
   * @param rollback - 写失败且这次仍是最新一次时执行的还原动作。
   */
  const pushHooksEnvPrefs = useCallback(
    async (
      next: { enabled: boolean; cache: boolean; shell: string },
      rollback: () => void,
    ): Promise<void> => {
      hooksPushSeq.current += 1;
      const seq = hooksPushSeq.current;
      const result = await api.setPrefs({
        hooksEnvEnabled: next.enabled,
        cacheHooksEnv: next.cache,
        hookEnvShell: next.shell,
      });
      if (result.ok || seq !== hooksPushSeq.current) {
        return;
      }
      rollback();
      /*
       * 文案必须说清后果:git 钩子**不会**拿到 shell 环境(而不是「某个设置没存上」),
       * 因为那正是用户勾这个框要的东西。
       */
      toastRef.current(
        `Hooks 偏好没能存到宿主(git 钩子不会拿到 shell 环境):${result.error.message}`,
        'err',
      );
    },
    [],
  );

  // ---- Hooks:与上游 `preferences.tsx:1077-1089` 同形(先落偏好,再回显)----
  const onEnableGitHookEnvChanged = useCallback((value: boolean) => {
    const previous = enableGitHookEnv;
    setHooksEnvEnabled(value);
    setEnableGitHookEnv(value);
    void pushHooksEnvPrefs(
      { enabled: value, cache: cacheGitHookEnv, shell: selectedShell },
      () => {
        setHooksEnvEnabled(previous);
        setEnableGitHookEnv(previous);
      },
    );
  }, [enableGitHookEnv, cacheGitHookEnv, selectedShell, pushHooksEnvPrefs]);
  const onCacheGitHookEnvChanged = useCallback((value: boolean) => {
    const previous = cacheGitHookEnv;
    setCacheHooksEnv(value);
    setCacheGitHookEnv(value);
    void pushHooksEnvPrefs(
      { enabled: enableGitHookEnv, cache: value, shell: selectedShell },
      () => {
        setCacheHooksEnv(previous);
        setCacheGitHookEnv(previous);
      },
    );
  }, [enableGitHookEnv, cacheGitHookEnv, selectedShell, pushHooksEnvPrefs]);
  const onSelectedShellChanged = useCallback((value: string) => {
    const previous = selectedShell;
    setGitHookEnvShell(value);
    setSelectedShell(value);
    void pushHooksEnvPrefs(
      { enabled: enableGitHookEnv, cache: cacheGitHookEnv, shell: value },
      () => {
        setGitHookEnvShell(previous);
        setSelectedShell(previous);
      },
    );
  }, [enableGitHookEnv, cacheGitHookEnv, selectedShell, pushHooksEnvPrefs]);

  const onSelectedTabIndexChanged = useCallback((index: number) => setSelectedTabIndex(index), []);

  /*
   * ---- 「edit your global Git config file」那行链接 + gitconfig 锁文件 ----
   *
   * 上游 `git.tsx` 只认一个 `onEditGlobalGitConfig: () => void` prop,真正的行为在
   * 上游 `preferences.tsx` 里。那段行为的**唯一实现**在 `./git-config-links.tsx`:
   *
   *  - `useGitConfigFileInfo()` —— 读路径 / 存在性 / 锁文件(挂载一次 + 「重新检查」);
   *  - `useEditGlobalGitConfig(path)` —— 回调体 + 结果回声(含 `missing` 那一档,
   *    并把已知路径带进降级文案);
   *  - `<GitConfigLockAlert>` —— 锁文件告警(没有锁就什么都不渲染)。
   *
   * ⚠️ 本文件曾经把这三件事**内联**重写一遍(那正是文件头「退役记录」删掉的那 50 行)。
   * 不要在这里再加任何 gitconfig 的分档/文案 —— 那是第二份真源。
   */
  const configFileInfo = useGitConfigFileInfo();
  const configInfo =
    configFileInfo.result !== null && configFileInfo.result.kind === 'ok'
      ? configFileInfo.result.info
      : null;
  const editGlobalGitConfig = useEditGlobalGitConfig(configInfo === null ? null : configInfo.path);

  return (
    <>
      {/*
        锁文件告警(唯一实现:`git-config-links.tsx` 的 `GitConfigLockAlert`)。
        上游遇到锁会弹 `ConfigLockFileExists` 对话框(`preferences.tsx:609-619`);
        我们按负责人给的尺度只做一段 `role="alert"` 的提示 —— **没有锁的时候
        什么都不渲染**,不占位;读 `config-file-info` 失败也会说出来(原来内联那份
        在这条支路上是静默的)。
      */}
      <GitConfigLockAlert state={configFileInfo} />
      <Git
        name={name}
        email={email}
        defaultBranch={defaultBranch}
        isLoadingGitConfig={isLoadingGitConfig}
        /*
         * ⚠️ **这里是收窄后的那一份**(不是自动识别用的那一份)。
         * 上游 `preferences.tsx:627` 把同一个 `props.accounts` 直接交给 `Git`;
         * 我们多这一步是因为 `Account.id` 只能是 `-1`(见文件头「邮箱下拉」第 2 条),
         * 判据/证据/回收条件在 `account-emails.tsx` 的 `accountsUsableAsEmailCandidates`。
         */
        accounts={accountsUsableAsEmailCandidates(emailCandidates)}
        onNameChanged={onNameChanged}
        onEmailChanged={onEmailChanged}
        onDefaultBranchChanged={onDefaultBranchChanged}
        onEditGlobalGitConfig={editGlobalGitConfig.onEdit}
        selectedTabIndex={selectedTabIndex}
        onSelectedTabIndexChanged={onSelectedTabIndexChanged}
        onEnableGitHookEnvChanged={onEnableGitHookEnvChanged}
        onCacheGitHookEnvChanged={onCacheGitHookEnvChanged}
        onSelectedShellChanged={onSelectedShellChanged}
        enableGitHookEnv={enableGitHookEnv}
        cacheGitHookEnv={cacheGitHookEnv}
        selectedShell={selectedShell}
      />
      {/*
        ## 页签底部的三行回声 —— 为什么整段包在 `DialogContent` 里

        上游把它们放在**对话框顶部**的错误态里(`preferences.tsx:393` 的
        `renderDisallowedCharactersError()`),而那一层在弹窗外壳手里(页签与面板之上),
        本页拿不到。放在 `Git` **之后**是本页能做到的位置 —— 但**不能裸放**:
        给那 20px 的是 `.git-preferences-content`(`Git` **内部**的元素),
        裸放的 `<p>` 会成为 `.tab-container` 的直接子节点 ⇒ 左沿 0px,正文贴着页签栏那条
        竖线 —— 正是 `docs/preferences-port.md` §11 那次投诉的形状(实测 0px vs 21px)。
        用上游 `DialogContent` 而不是手写 `padding`:`_dialog.scss:242` 那 20px 只有一处真源。

        **整段条件渲染**:没有话要说时连盒子都不渲染 —— 否则 `DialogContent` 会留下一个
        只有内边距的空 `.dialog-content`(一条 40px 的空白带),那正是本仓禁止的「占位不留话」。
      */}
      {(identityNote !== null || nameIsInvalid || editGlobalGitConfig.status !== null) && (
        <DialogContent>
          {/*
            **自动识别的回声**(文件头「作者自动识别」)。上游没有这一行 —— 它的预填是
            「静默地填好,保存时写下去」。我们**不**在用户没动作时写盘(第 3 条那处偏离),
            所以必须说清这两个框里的字是哪儿来的、以及为什么现在还没落盘;否则用户看到的
            是「我什么都没做,设置里就有值了」,比空着更难解释。
          */}
          {identityNote !== null && (
            <p className="settings-description" role="status" aria-live="polite">
              {identityNote}
            </p>
          )}
          {/*
            **姓名非法的提示** —— 上游 `preferences.tsx:867-874` 的谓词 + `:514-521` 的
            `DialogError` + `:1004` 的「保存禁用」。三件事在这里合成一句话 + 一条行为:
            提示可见(`role="alert"`),而且写入被整批拦住(见上面去抖里那条提前 return)。
          */}
          {nameIsInvalid && (
            <p className="setting-hint-warning" role="alert">
              {GIT_AUTHOR_NAME_INVALID_MESSAGE}
            </p>
          )}
          {/*
            点完链接的**回声**(`useEditGlobalGitConfig` 的 `status`)。上游把它放在
            `preferences.tsx` 的错误态里;我们的弹窗没有那层错误态,所以就地用一条
            `role="status"` 的行 —— 否则「点了没反应」与本仓那条硬约束冲突。
          */}
          {editGlobalGitConfig.status !== null && (
            <p
              className={
                editGlobalGitConfig.statusIsWarning ? 'setting-hint-warning' : 'settings-description'
              }
              role="status"
              aria-live="polite"
            >
              {editGlobalGitConfig.status}
            </p>
          )}
        </DialogContent>
      )}
    </>
  );
}
