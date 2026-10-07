/**
 * 镜像完整性探针(**opt-in**):把 `src/core/desktop/**` 与上游
 * `references/desktop/app/src/**` 逐一比对,报告**非预期**的偏离。
 *
 * 为什么需要它:上轮两个子代理并发写同一个仓库,其中一个把
 * `ui/octicons/octicons.generated.ts` 从 **379 个符号砍成 11 个**。而
 * 构建是绿的、4 条预构建检查全过、语法检查也过 —— 因为那个文件当时
 * **没有任何东西 import 它**。没有任何现有守卫能发现这类损坏。
 *
 * 判据:镜像文件应当与上游**字节一致**,除了下方 `EXPECTED` 里登记过的偏离。
 * 新增偏离必须显式登记并写明理由,否则视为损坏。
 *
 * ## 为什么文件名是 `verify-mirror.mjs` 而**不是** `verify-mirror.mjs`
 *
 * 本探针判的是「我们与上游逐字节相同」,所以它**天然需要一份上游 checkout**;
 * 而 `.gitignore:221` 把 `/references/` 整个排除 ⇒ CI 与任何干净检出里都没有它。
 * `scripts/check-all.mjs` 的自动发现集合只收「能自证」的闸门(名字 `check-*.mjs`),
 * 把本文件放进去只会得到一条**假绿**(拿不到上游时它以前会打印「上游找不到对应」
 * 然后退出 0)。所以它改名为 `verify-*`,与 `verify-install.mjs` 同一类:
 * **环境探针,不是静态闸门**,由人显式调用。
 *
 * 拿不到上游时**跳过**(退出码 2,与闸门契约一致),绝不装成通过。
 *
 * 用法(需要本机有 `references/desktop` checkout,见 docs/desktop-inventory.md):
 *
 *     node scripts/verify-mirror.mjs
 *
 * 退出码:0 = 无非预期偏离;1 = 有非预期偏离;2 = 拿不到上游 checkout(跳过)。
 * @module dsh-git/scripts/verify-mirror
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

const MIRROR = 'src/core/desktop';
const UPSTREAM = 'references/desktop/app/src';

/**
 * 允许与上游不一致的文件,以及理由。
 * 键是相对 `src/core/desktop` 的路径。
 */
const EXPECTED = new Map([
  // --- Electron / node 专属:必须 shim,不可能逐字一致 ---
  ['lib/app-shell.ts', '打开外部链接走 Electron shell'],
  ['lib/file-system.ts', '读写文件走 node:fs'],
  ['lib/get-os.ts', '读 Electron 的 process.getSystemVersion'],
  ['lib/menu-item.ts', '原生右键菜单走 ipcRenderer'],
  ['lib/git/show.ts', '取 blob 内容走 dugite'],
  ['lib/git/interpret-trailers.ts', 'git 调用走 dugite'],
  [
    'lib/git/log.ts',
    '上游 383 行整个是宿主侧 git 能力:`./core` 就是 dugite,再加 assert/Commit/' +
      'CommitIdentity/git-delimiter-parser —— §1.3/§2.3 排除(node + dugite 在浏览器半不存在)。' +
      '实测镜像里**只有** `ui/branches/branch-list.tsx:23` 一个 importer,它只取 `getAuthors`(:239),' +
      '所以只保留这一个导出(名字与签名逐字);上游另外 5 个导出(getCommits/IChangesetData/' +
      'getChangedFiles/parseRawLogWithNumstat/getCommit)今天零 importer,刻意省略 —— ' +
      '引进来只会变成不可达的死重(§3 失败模式 1)。' +
      '`getAuthors` 返回 `[]`:上游是按**给定 sha 列表**跑 `git log --no-walk --stdin`,而 host 只有' +
      '按 ref 从新到旧分页的 `log` 路由(`routes.ts:466` → `git-service.ts:629`),形状对不上 ——' +
      '拿它硬凑会给出**错误的提交日期**(静默坏数据),所以宁缺勿假。唯一消费方把它填进分支行的' +
      'commit 日期缓存(`branch-list.tsx:238-246`,失败路径本就 catch),且 `authorDate === undefined`' +
      '是合法输入(`branch-list-item.tsx`)。' +
      '⚠️ **「一个都不受影响」这个结论已于 2026-10 被实测证伪,别再沿用**:返回 `[]` 让 ' +
      '`branch-list.tsx:215-246` 的 `populateCommitDates()` **无限微任务递归**(`missing` 永不缩小、' +
      '每圈 `setState`),微任务队列永不清空 ⇒ 事件循环**到不了 timer 阶段** ⇒ **整个页面假死**' +
      '(用户报的「点当前分支下拉就卡死」,`setTimeout` 再也不跑;实测 CDP `Runtime.evaluate` 连续超时)。' +
      '客户端侧已用 `BranchListWithoutCommitDates` 子类绕过;**根治是把这里改成 reject**' +
      '(上游唯一调用方 `branch-list.tsx:239` 本就带 `.catch`)—— 但必须与 ' +
      '`src/client/desktop-globals.ts` 补一个真实 `log` **同批**落地,否则 catch 里那句 ' +
      '`log.error(...)` 会变成 3 条 `log is not defined` 的未处理拒绝。' +
      '待补宿主能力(不在本泳道所有权内):`log/authors {path, shas}` → `{authors:{name,email,date}[]}`。',
  ],
  ['lib/highlighter/worker.ts', 'Web Worker + node 路径'],
  ['ui/main-process-proxy.ts', '主进程代理走 ipcRenderer'],
  ['ui/window/title-bar.tsx', 'Electron 窗口标题栏'],
  ['ui/diff/syntax-highlighting/index.ts', '取旧/新文件内容走 node:fs + dugite'],
  ['lib/feature-flag.ts', '依赖构建期 globals'],
  // --- 仓库列表移植(ui/repositories-list + ui/lib/list + filter-list)带进来的 shim ---
  // 这 4 个都是「上游那份属于 §1.3 排除范围(应用层/Electron/node),但仓库列表的
  // 相对 import 写死了它的路径」的情况。放在镜像同路径是刻意的:上游写的是
  // `from '../models/popup'` / `from '../../lib/api'` 这类相对导入,只有同路径才能零改动。
  [
    'lib/api.ts',
    '上游 2499 行的 GitHub REST 客户端(API 类 + request/./http + token 池),' +
      'import 了 lib/copilot-*、lib/databases/**、ui/secret-scanning/** —— §1.3 排除。' +
      '仓库列表一个网络请求都不需要,只用 getHTMLURL/getDotComAPIEndpoint(逐字取自上游)' +
      '与 GitHubAccountType 类型(镜像里 models/owner.ts 早已 import)。' +
      '两处刻意偏离:process.env 的两个调试变量按「未设置」处理。',
  ],
  [
    'lib/helpers/non-fatal-exception.ts',
    '上游的投递是 process.emit(主进程监听者转发),是否上报取决于 lib/stats/stats-store' +
      '(§1.3 排除的遥测)。这里保留导出名/签名与「每分钟最多一条」的节流,投递换成可' +
      '替换的宿主钩子 setNonFatalExceptionHost(),默认 console.warn。' +
      '调用点:ui/lib/list/list.tsx、section-list.tsx 的 invalidListSelection。',
  ],
  [
    'models/popup.ts',
    '上游 555 行是整个弹窗系统的类型总表,import 了 lib/copilot/byok、lib/ci-checks/ci-checks、' +
      'lib/git、ui/history/unreachable-commits-dialog、ui/repository-settings/**、' +
      'ui/secret-scanning/** —— §1.3 排除。' +
      'PopupType 枚举逐字保留上游全部成员;PopupDetail 只保留仓库列表用到的 5 个变体' +
      '(AddRepository/CreateRepository/CloneRepository/ChangeRepositoryAlias/AddWorktree),' +
      '字段逐字取自上游对应行。',
  ],
  [
    'ui/dispatcher/index.ts',
    '上游是 2 行 re-export(ui/dispatcher.ts 不存在,`from \'../dispatcher\'` 靠目录 index 解析),' +
      '指向 4356 行的命令总线;方法体几乎全是 this.appStore._xxx(...),而 lib/stores/**' +
      '(含 10936 行 app-store.ts)是 §1.3 排除的应用层。' +
      '这里**只声明类型面**(方法体一律 Promise.resolve()/no-op),名字与签名逐字取自上游。' +
      '当前 19 个,分三批:' +
      '仓库列表 5 个(showPopup:405 / changeRepositoryAlias:868 / selectRepository:301 / ' +
      'showWorktreesFoldout:441 / recordRepoClicked:2709);' +
      'History 面 7 个(changeFileSelection:288 / showUnreachableCommits:4117 / ' +
      'updateShasToHighlight:273 / onHideWhitespaceInHistoryDiffChanged:2401 / ' +
      'onShowSideBySideDiffChanged:2427 / setCommitSummaryWidth:1139 / ' +
      'resetCommitSummaryWidth:1147);' +
      '顶栏同步面 7 个(closeFoldout:436 / push:744 / pull:757 / fetch:770 / ' +
      'confirmOrForcePush:2608 / setPushPullButtonWidth:1082 / resetPushPullButtonWidth:1090;' +
      '2026-10-06 为 ui/toolbar/push-pull-button.tsx 补 —— 那一批让该文件 7 条 ' +
      '"Property x does not exist on type Dispatcher" 消失,另有 4 个 toolbar 文件与 ' +
      '3 个 branches 文件的 15 条同类错误一并消失)。' +
      '行为一律由我们这层的门面覆盖(RepoListDispatcher / HistoryDispatcher / ' +
      'SyncDropdownDispatcher,最后一个是 src/client/sync-dropdown-dispatcher.ts)。' +
      /*
       * --- 有心偏离(2026-10-06,pull.rebase 同源那条线)---
       *
       * 与上面两批「逐字取自上游」不同,`pull` 的签名**刻意**多了一个可选参数。
       * 这是本文件里第一处真正的签名扩展,所以把判据写全:
       *   · **上游原文**:`dispatcher.ts:757` 的 `pull(repository)`;
       *   · **这里**:`pull(repository, pullWithRebase?: boolean)`;
       *   · **为什么上游不需要它**:上游的 `_pull`(app-store.ts:5484)自己从
       *     `gitStore.pullWithRebase` 取那个值 —— 而 `lib/stores/**` 是 §1.3 排除的应用层,
       *     浏览器半**不存在**那个 store,于是「文案用的值」与「执行用的值」会在
       *     两个进程里各读一次 git 配置(本次修的就是这个:host 的 pull 读一次、
       *     客户端文案另有一份缺省 ⇒ 「拉取 origin」与真变基不一致)。
       *   · **纯增量**:只**增加**一个可选参数,没有增删任何一行已有逻辑,
       *     已有调用点(`push-pull-button.tsx:356` 只传 repository)完全不受影响。
       *   · **值的方向与上游一致**:上游 `ui/app.tsx:3630` 从 `IBranchesState` 解构
       *     `pullWithRebase`、`:3666` 喂给按钮、`push-pull-button.tsx:497` 再把它交给
       *     拉取动作 —— 这里传的就是 `Snapshot.sync.pullWithRebase`,同一个字段。
       *   · **判据**:`docs/probes/pull-rebase-probe.mjs` 的 (e) 断言
       *     「到达宿主 pull 路由的 rebase 值 === 渲染文案的那个值」。
       *   · **退役条件**:本插件出现真正的应用层 store(能在门面里读到
       *     `branchesState.pullWithRebase`)时,删掉这个参数、把本文件按上游与上游一致回去;
       *     或上游自己把该值改成经参数传给 dispatcher(那时照上游签名即可)。
       */
      '⚠️ **一处有心的签名扩展**(2026-10-06,pull.rebase 同源那条线):`pull` 多了一个' +
      '**可选**参数 —— 上游 `:757` 是 `pull(repository)`,这里是 ' +
      '`pull(repository, pullWithRebase?: boolean)`。上游的 `_pull`(app-store.ts:5484)自己从 ' +
      '`gitStore.pullWithRebase` 取值,而那个 store 属 §1.3 排除的应用层 ⇒ 浏览器半读数只能靠传参;' +
      '传进来的正是上游 `ui/app.tsx:3630/3666` + `push-pull-button.tsx:497` 用的**同一个**字段' +
      '(`Snapshot.sync.pullWithRebase`),于是按钮文案与拉取动作不可能分家。' +
      '纯增量(只增加可选参数,`push-pull-button.tsx:356` 的既有调用一字未动),判据见 ' +
      '`docs/probes/pull-rebase-probe.mjs` 的 (e)。' +
      '**退役条件**:出现真正的应用层 store(门面里能读到 `branchesState.pullWithRebase`)' +
      '⇒ 删掉该参数、本文件按上游与上游一致回去;或上游自己改成传参(那时照上游签名)。' +
      '**退役条件**:本插件出现真正的应用层命令总线时,本文件按上游与上游一致回去,并删除那三个门面。',
  ],
  // --- app-state 契约(与 lib/app-state.ts 逐字一致)带进来的**纯类型** shim ---
  // 注意:任务书/§10.10 说 app-state.ts「只从 ./api 与 ./stores/* 取 3 个名字」——
  // **实测不是**(18 个模块缺失,见 docs/app-state-port.md §2)。下面这些替身
  // 都只为让那个文件**类型可解析**,没有一处运行期逻辑(除上游本来就有的 enum)。
  [
    'lib/stores/sign-in-store.ts',
    '上游 467 行的主体是 SignInStore 类(TypedBaseStore + lib/api 的 OAuth 请求 + ' +
      'lib/app-shell 的 shell + accounts-store + lodash/noop),lib/stores/** 属 §1.3 排除的应用层。' +
      '这里只保留类型面:lib/app-state.ts:43 只取 SignInState,但那是四个状态接口的判别联合,要窄化' +
      '还必须同时有 SignInStep,所以连构件一起保留 —— 8 个导出全是上游导出名,声明与上游一致自上游' +
      '(:29/:41/:50/:80/:100/:112/:143/:152),刻意省略 SignInStore 类与未导出的 IAuthenticationEvent。' +
      '除上游那个 enum 外零运行期代码;在打包图里不可达(产物 0 命中 EndpointEntry),不进产物。',
  ],
  [
    'lib/stores/api-repositories-store.ts',
    '上游 239 行的主体是 ApiRepositoriesStore 类(BaseStore + ../api 的 API 类 + accounts-store + ' +
      '../merge),属 §1.3 排除的应用层。这里只保留 lib/app-state.ts:49 唯一取用的 IAccountRepositories' +
      '(上游 :66,两个字段与上游一致,含文档注释),刻意省略 ApiRepositoriesStore 类;零运行期代码。',
  ],
  [
    'lib/shells/index.ts',
    '上游 2 行 `export *` 会把 ./shared 整份带进来,而 shared(183 行)import child_process、' +
      './darwin|./win32|./linux(各自 exec-file/is-git-on-path/registry-js/app-path)、path-exists —— ' +
      'node 内置与 Electron 环境在浏览器半不存在(§2.3)。这里只保留 lib/app-state.ts:46 取用的 Shell, ' +
      '按上游 lib/shells/shared.ts:10 的定义给出「三个平台枚举的并集」;三个 enum 的成员与值与上游一致自 ' +
      'darwin.ts:13/win32.ts:22/linux.ts:13(只改成局部名以免同名冲突)。' +
      '2026-10 追加(Preferences ▸ Integrations 接线):补回上游 shared.ts:38 的 parse() 与 ' +
      'shared.ts:53 的 getAvailableShells()。起因是上游 ui/preferences/integrations.tsx:6 取 ' +
      '{ Shell, parse as parseShell },而 :188 在用户换 shell 时**真的调用**它 —— 缺了就是运行期崩溃;' +
      'parse 只需在「三个 enum 的并集」里查值(三个 enum 的值与友好名逐字相同)。' +
      'getAvailableShells 返回空表(浏览器半探测不到本机 shell,与上游「一个都没找到」的分支一致)。' +
      '刻意省略 FoundShell/launchShell/launchCustomShell/ShellError。',
  ],
  [
    'lib/window-state.ts',
    '上游 :1 就 import ../main-process/ipc-webcontents,两个函数的签名直接是 Electron.BrowserWindow —— ' +
      'main-process/** 与 Electron 都是 §1.3 排除项。这里只保留 lib/app-state.ts:45 取用的 WindowState' +
      '(上游 :3-8 的纯字面量联合,逐字),刻意省略 getWindowState/registerWindowStateChangedEvents。',
  ],
  [
    'lib/git/index.ts',
    '上游是 36 行 `export *` 的桶文件,把整个 git 层一次转出;那一层每一支都走 dugite' +
      '(lib/git/core.ts:1 import dugite)并依赖 path/buffer/child_process —— 实测朴素闭包 = lib/git/** 51 文件' +
      '+ dugite,而 lib/git/** 正是宿主已取代的一层(§2.4)。这里只保留 type-only 名字:' +
      'HookProgress(上游 lib/git/core.ts:38)、TerminalOutputListener(core.ts:32)、' +
      'IChangesetData(lib/git/log.ts:215),声明逐字。一处必需替代:上游 TerminalOutput(core.ts:30)是 ' +
      'string|Buffer|Buffer[],而浏览器半 types:[] 没有 Buffer(TS2591),改用其超类 Uint8Array。' +
      '**2026-10 补第四个名字 `IStatusResult`**(上游 lib/git/status.ts:33-69,**逐字**):' +
      '上游 lib/stores/updates/changes-state.ts 写的是 `import { IStatusResult } from \'../../git\'`,' +
      '也走这个桶文件;那份 353 行的「状态合并」纯函数(updateChangedFiles / updateConflictState /' +
      'selectWorkingDirectoryFiles)是 Changes 页失效规则的上游原文,已逐字落到' +
      'src/core/desktop/lib/stores/updates/changes-state.ts,所以这个类型名必须像上游一样从这里可解析。' +
      '**回收条件**:若将来 changes-state.ts 被裁掉(那套合并规则不再逐字保留),这里的 IStatusResult' +
      '也应一并删除 —— 它没有别的消费方。',
  ],
  // --- Preferences ▸ 弹窗移植(task:PORT A WHOLE SURFACE / Preferences)带进来的 shim ---
  // `ui/preferences/preferences.tsx` **没有被移植**(它把 Copilot 页签、`../dispatcher`
  // 总线与 `lib/git/config` 写死在文件内部,见 docs/preferences-port.md);被逐字沿用过来的是
  // **7 个页面**(accessibility/accounts/advanced/appearance/prompts/integrations/
  // custom-integration-form),它们每一处 import 都归入了 §10.3 的四类之一。
  /*
   * --- 有意偏离:`models/diff/image.ts` 给 `Image` 加**可选** `src`(2026-10-06) ---
   *
   * **改的是什么**:给上游那个 `Image` 类型加一个**可选**字段 `src?: string`,**纯增量** ——
   * 不传 `src` 时,镜像组件的行为与改动前逐字一致。
   *
   * **为什么值得动上游**(2~3 行 vs 一份平行实现):
   * 宿主里图片的原始字节走 blob 端点(裸字节 + ETag),而**上游 `Image` 只有 base64 表示**;
   * `ui/diff/image-diffs/image-container.tsx:42` 更把地址**写死**成 `` `data:${mediaType};base64,${contents}` ``。
   * 不动镜像就只剩一条路:**另写一份渲染层** —— 那就是 `src/client/image-diff-view.tsx`
   * (408 行,复刻了容器 + 4 个模式 + 分派)。上游 `image-diffs/**` **11 文件已字节一致地躺在镜像里**,
   * 却因为这一处写死的 base64 而无法用。**这正是本项目反复纠正的那类问题:上游有实现,我们却手写了一份。**
   *
   * **完整的根治(后续 lane 必须做,尚未完成)**:① 本文件加可选 `src`(本次已做);
   * ② `ui/diff/image-diffs/image-container.tsx` 的 `loadImage` 在 `image.src` 存在时直接用它
   * (**那时必须把那个文件也登记在这里**);③ 让 `src/client/image-diff.ts` 产出带 `src` 的 `Image`;
   * ④ **删掉 `src/client/image-diff-view.tsx` 的 408 行**,改用镜像的 `Diff.renderImage`
   * (`ui/diff/index.tsx:148-181`)或直接渲染镜像的 `ModifiedImageDiff`/`NewImageDiff`/`DeletedImageDiff`。
   * **④ 才是这次偏离买到的东西,也是它的验收条件。**
   *
   * ⚠️ **未完成的原因**:改动的作者在收尾前**失败退出**,`image-diff-view.tsx` 仍在(17,138 字节)。
   * 补登记的直接原因:红着的头号不变式会让真回归和草稿噪声分不开。
   */
  [
    'models/diff/image.ts',
    '有意偏离:`Image` 增加**可选** `src?: string`(纯增量,不传时行为与上游逐字一致),' +
      '让镜像 `image-diffs/**` 能直接用 URL 渲染宿主 blob 端点的裸字节 —— 上游 11 个文件已字节一致地镜像在库,' +
      '只因 `image-container.tsx:42` 把地址写死成 base64 的 data URL 而无法使用,逼出了 `src/client/image-diff-view.tsx` 那份 408 行手写渲染层。' +
      '⚠️ **根治未完成**:还需 `image-container.tsx` 支持 `src`(届时一并登记)、并**删除那 408 行重复实现** ——' +
      '删除它才算这次偏离真正买到东西。作者在收尾前失败退出,故本条目先行补登记。',
  ],
  // --- 另一条 lane 建的手写 shim,此前**漏登记**(2026-10-06 补) ---
  [
    'lib/git/config.ts',
    '上游 297 行**每一支都走 dugite**(`import { git } from \'./core\'` ⇒ lib/git/core.ts ⇒ dugite),' +
      '外加 path / fs/promises(node 内置);浏览器半不能跑 git ⇒ 这是「保留上游导出名与签名、' +
      '把 git 调用交给宿主」的最小替身(§1.3 允许,文件头已写明理由,属 §10.3 的「需 shim」类)。' +
      '**不是死代码**:src/core/parse.ts、src/core/lib.ts、src/host/auth.ts、' +
      'ui/changes/commit-message.tsx、ui/changes/commit-message-avatar.tsx 都在用它。' +
      '补登记的直接原因:作者建了文件但没登记,让 verify-mirror 一直红着 ——' +
      '红着的头号不变式会让真回归和草稿噪声分不开。',
  ],
  // 下面 5 条是那 7 个页面**自己**逼出来的替身。
  [
    'lib/stats/index.ts',
    '上游是 2 行 `export { … }`,指向遥测层:./stats-database 是 Dexie 数据库定义,' +
      './stats-store 是 1486 行的上报器(HTTP + lib/get-architecture/get-renderer-guid)—— ' +
      '§1.3 明确把 lib/stats 列为不沿用的应用层。实证:Preferences 的 Advanced 页' +
      '(ui/preferences/advanced.tsx:5)只取**一个**名字 SamplesURL(用于「usage data」说明链接),' +
      '这里与上游一致它(stats-store.ts:69)与 ILaunchStats(stats-database.ts:7,纯类型),' +
      '刻意省略 StatsDatabase/StatsStore。' +
      '**2026-10 修订**:原登记写着「刻意省略 … IStatsStore」,**那条已作废** —— ' +
      'lib/stores/repository-state-cache.ts:26 写的是 `import { IStatsStore } from \'../stats\'`, ' +
      '走的就是这个桶文件;那份 476 行的镜像已逐字落地(cmp 无输出),所以桶文件必须像上游 ' +
      'index.ts:2 一样转出这个名字(只砍掉 StatsStore 类)。类型本体在 ./stats-store.ts。',
  ],
  [
    'lib/stats/stats-store.ts',
    '上游 1486 行是 Desktop 的**遥测上报器**:import ./stats-database(Dexie)、' +
      '../get-architecture、../get-renderer-guid、../store、./samples、../http 与 os/path/process, ' +
      '并真的往 GitHub 的 Central/CAFE 端点 POST —— §1.3 明确把 lib/stats 列为不沿用的应用层, ' +
      '浏览器半也没有 process 与遥测后端。需要这个同路径替身的原因是两条**类型级** import: ' +
      'lib/stores/repository-state-cache.ts:26 `from \'../stats\'`(经桶文件)与 ' +
      'lib/stores/updates/changes-state.ts:18 `from \'../../stats/stats-store\'`(直接指本文件), ' +
      '两者只要一个名字 IStatsStore。这里**逐字**复制三段(sed 机械拼接,非手打):' +
      'IDailyMeasures(stats-database.ts:27-720,纯 number 接口,是 NumericMeasures 的基数)、' +
      'NumericMeasures(stats-store.ts:291-296)、IStatsStore(stats-store.ts:496-498)。' +
      '**刻意省略**:StatsStore 类、SamplesURL(由 ./index.ts 逐字提供)、buildStatsPayload 一族' +
      '(只服务上报,零本仓调用方)。' +
      '**为什么不窄化成 increment:(k: string)**:那是本仓最敏感的一类静默失效 —— ' +
      '上游 increment 收 keyof NumericMeasures,窄化后任何拼错的度量键都会静默通过类型检查。' +
      '**no-op 的 increment 会不会让逻辑走偏 —— 已核实不会**:全仓对 IStatsStore 的方法调用只有两处, ' +
      '都在 repository-state-cache.ts(:131 submoduleDiffViewedFromChangesListCount、' +
      ':159 submoduleDiffViewedFromHistoryCount),两个 private record*IfNeeded() 里除计数外' +
      '没有任何副作用(不写 IRepositoryState、不返回值、不决定分支)。' +
      '**回收条件**:若将来宿主提供了真遥测端点并要接回计数,把本文件升级为带实现的替身即可; ' +
      '若 repository-state-cache.ts 被决定不移镜像,本文件应随之删除并撤掉 index.ts 的转出。',
  ],
  [
    'lib/ssh/ssh.ts',
    '上游 import memoize-one、../path-exists(fs/promises)、../local-storage 与 ' +
      '../trampoline/trampoline-environment —— 最后那个是 SSH askpass 蹦床(写临时脚本 + ' +
      'SSH_ASKPASS 注入),依赖 fs/path/child_process,§1.3 明确把 lib/trampoline 列为不沿用。' +
      '实证:Preferences 的 Advanced 页(ui/preferences/advanced.tsx:6)只取**一个**名字 ' +
      'isWindowsOpenSSHAvailable()。上游 :13 的实现第一步就是 `if (!__WIN32__) return false`, ' +
      '再查 process.arch、最后才 pathExists(Windows 系统 ssh.exe)⇒ 浏览器半恒 false 与上游' +
      '非 Windows 分支**逐字一致**,于是 Advanced 页那一栏按上游自己的分支(:158)不渲染 —— ' +
      '不是我们遮掉了控件。另保留 UseWindowsOpenSSHKey(:11,逐字)、getSSHEnvironment(:44,恒 {})' +
      '与 parseAddSSHHostPrompt(:72,**与上游一致**,纯正则无依赖)。',
  ],
  [
    'lib/stores/app-store.ts',
    '上游 10935 行(实测 `awk END{NR}`,旧记述写 10936)是 Desktop 的**整个应用状态容器**' +
      '(import lib/api、lib/git/**、lib/stores/**、lib/databases/**、lib/notifications/**、' +
      'lib/trampoline/**、main-process/** 与 dugite/dexie/keytar),§1.3 把它列为不沿用的第一名。' +
      '本文件承担**两个角色**:' +
      '① 常量替身 —— Preferences 的 Appearance 页(ui/preferences/appearance.tsx:13)取**一个**名字 ' +
      'tabSizeDefault(上游 :532 的值 4,逐字);' +
      '② **状态机采纳接缝(2026-10 新增)** —— 上游 `lib/stores/updates/changes-state.ts` 的 importer ' +
      '**全仓库只有一处**:`app-store.ts:302-306`。那份 353 行是 Changes 页的失效/合并规则,已逐字 ' +
      '镜像在 `lib/stores/updates/changes-state.ts`,但此前**零 importer** ⇒ 一直在 ' +
      '`check-integration` 的「失去可达」名单里(在树里、没被用上)。' +
      '同一个路径上的这份替身就是那条 import 边在浏览器半的**唯一合法落点**,所以这里' +
      '**原样转出**上游那三个名字(名字与签名逐字,零实现),并额外给出一个**纯函数** ' +
      '`applyChangesStatus()`,把上游 `_loadStatus` 对 changesState 的那两处写入' +
      '(`app-store.ts:2999-3004`)合成一个状态进/状态出的函数。' +
      '**刻意不复刻**:AppStore 类、repositoryStateCache/gitStoreCache/emitUpdate、' +
      '`gitStore.loadStatus()`(一次真 git 调用,属 host)、`_loadStatus` 末尾的 ' +
      '`updateChangesWorkingDirectoryDiff`(`:3018`,我们已落在 `src/client/store.ts` 的 `refreshStatus()`)。' +
      '**退役条件**:`src/client/store.ts` 的授权模型换成镜像的 ' +
      '`WorkingDirectoryFileChange.selection` 之后,它会直接 import 那个镜像模块并丢掉自己的 ' +
      '`clearPartialAfterCommit` —— 那一刻本文件的 `applyChangesStatus` 与那三条 re-export ' +
      '**必须删掉**(否则就是第二份必然漂移的真源),同时 `lib/git/index.ts` 的 `IStatusResult` ' +
      '也一并删。计划见 `docs/changes-state-adoption.md`。',
  ],
  [
    'lib/stores/git-store.ts',
    '上游 1777 行**整个是宿主侧 git 能力**:import path / fs/promises / dugite / ../git(每一支都 ' +
      "`import { git } from './core'` ⇒ dugite)/ ../git/stash / ../find-default-branch。" +
      '§2.3 的「client 禁止 node 内置」+ §2.4 的「git 一律走 host 路由」合起来 ⇒ 这一层在浏览器半' +
      '**不存在、也不应该存在**。这里保留上游的**导出名** `GitStore`(上游 :112 的 ' +
      '`export class GitStore extends BaseStore`),但**刻意把它窄化成纯类型声明** —— 这是本文件' +
      '唯一有争议的一处,判据写全:① 上游 `lib/stores/git-store-cache.ts:34` 会 `new GitStore(...)`, ' +
      '若写成 no-op class 就得到**一个什么都不做的 store**,编译照过、错误推迟到用户点下去,是 §3 ' +
      '失败模式 7/9 那一类**静默**失效;② 写成 `declare class` 则错误漏到**运行期**' +
      '(`TypeError: GitStore is not a constructor`);③ 写成 **interface**,任何把它当值用的上游文件' +
      '(最先会是 git-store-cache.ts)**在 `check-types` 那一刻就红**(TS2693)。' +
      '⇒ 取 ③:唯一让错误停在编译期的写法。③ 写成 `type` 而不是 `interface`,是因为 ' +
      '`.eslintrc.yml:67-75` 的 naming-convention 对 `selector: interface` 强制 `/^I[A-Z]/` ' +
      '—— 写成 `interface GitStore` 会新增一条 lint 违规(实测 check-lint 0 → 1), ' +
      '而改名 `IGitStore` 就不是上游导出名了;`type` 选择器不在那条规则里, ' +
      '两者在 `new` 上的行为完全一样(都是 TS2693)。' +
      '**本替身不复现**:任何 git 调用、`TypedBaseStore<string>` ' +
      '的事件面(onDidUpdate/onDidError)、可实例化/可继承性;成员只声明**已落地消费方真正碰过**的' +
      '两个(`defaultRemote` 上游 :1406、`setRemoteURL` 上游 :1534 —— 签名逐字,后者返回 ' +
      '`Promise<boolean>`),所以它是一个**会随消费方增长而需要补成员**的窄化替身,漏成员会编译报错。' +
      '零运行期代码、不可达、产物 0 字节(实测)。当前唯一消费方:' +
      '`lib/stores/updates/update-remote-url.ts`(上游逐字)。' +
      '**退役条件**:接上真实的宿主 git 门面(§2.4 的 git-argv → git-service → routes → api 四层)' +
      '后,把本文件换成一份带实现的真替身;若那一天不来,它就一直是窄化替身。',
  ],
  [
    'lib/stores/copilot-store.ts',
    '上游 1725 行是 Copilot 的状态容器(import crypto、@github/copilot-sdk、lib/copilot/**、' +
      'lib/copilot-*、lib/stats、lib/stores/accounts-store)。Copilot 被用户明确排除(§1.3 + 任务书),' +
      'lib/copilot* 三处归另一条线所有,本文件不碰它们。这里之所以仍需要一个同路径替身:' +
      '**镜像必须字节一致**,而 ui/preferences/preferences.tsx:46-52 在顶层 import 了它(4 个 type + ' +
      'getCopilotAccountCacheKey);按 §10.3「需 shim」保留上游导出名与签名。' +
      '可达性已核实:上游 :1224 的 isCopilotSdkEnabled 依赖 feature-flag 的 ' +
      'enableCopilotSdkCommitMessageGeneration,我们的 shim 里它恒 false ⇒ Copilot 页签不渲染、' +
      'getCopilotAccountCacheKey 只在那条不可达分支里被调用。两处必需替代(浏览器半没有那个 Electron 包):' +
      'CopilotModelsByAccount 的 value 由 SDK 的 Model 换成只含 id/name 的结构等价声明;' +
      'ICopilotQuotaSnapshot 的基类 AccountQuotaSnapshot 按生成类型字段展开。' +
      'getCopilotAccountCacheKey 的实现与上游一致(纯函数)。',
  ],
  [
    'lib/copilot-app/index.ts',
    '上游 155 行走 node/Electron:path(isAbsolute)、../exec-file(child_process)、' +
      '../path-exists(fs/promises)、./darwin|./win32(app-path/registry-js/os)。Copilot 被用户明确排除, ' +
      'lib/copilot* 三处归另一条线所有。两个调用点逼出它:ui/preferences/integrations.tsx:18 取 ' +
      'copilotAppMarketingUrl(常量,逐字)、ui/preferences/preferences.tsx:87 取 validateCopilotAppPath。' +
      'CopilotAppError/ICopilotAppDependencies/createCopilotAppIntegration 都是纯 JS 且上游刻意做成' +
      '依赖注入形状,**与上游一致**;顶层 integration 注入「探测不到安装」的实现:' +
      '因为 feature-flag 的 enableCopilotAppHandoff() 我们恒 false(上游非 __DEV__ 时同样 false),' +
      'preferences.tsx:1022 的整段校验与 integrations.tsx:388 的渲染分支都不可达。',
  ],
  [
    'lib/custom-integration.ts',
    '上游 230 行是「探测并启动外部自定义集成」的宿主能力:import child_process/fs/fs-promises/' +
      'path/util/string-argv/windows-argv-parser 并读 __DARWIN__ 一类构建期全局量 —— 而 client 的 paths ' +
      '只 alias 了 path/url/fs-promises,没有 child_process(§2.3),这类能力按 §2.4 属 host。' +
      '2026-10 Preferences ▸ Integrations 接线后,本文件已**不只是零运行期代码的替身**:' +
      'ui/preferences/{integrations,custom-integration-form}.tsx 是**值级** import,' +
      '所以下面这些**与上游一致上游的纯函数**会真的执行:WindowsExecutableExtensions(:17)、' +
      'TargetPathArgument(:20)、checkTargetPathArgument(:98)、parseCustomIntegrationArguments(:36)。' +
      '仍属 host 的部分只保留签名:validateCustomIntegrationPath(:121,浏览器无 fs,只判路径非空)、' +
      'isValidCustomIntegration(:158,组合上一条);刻意省略 expandTargetPathArgument/' +
      'migratedCustomIntegration/spawnCustomIntegration(启动外部程序属 host,且前两个当前零调用方)。' +
      '一处必需替代:上游 parseCustomIntegrationArguments 的 Windows 分支走 windows-argv-parser,而它在' +
      '上游是 file:../vendor/windows-argv-parser(原生 C++ 插件,需 node-gyp)——我们**刻意不装**,两个' +
      '分支都走 string-argv(**已装**,package.json 的版本 ^0.3.2 取自上游 app/package.json:66)。' +
      '差别只在「Windows 下用户写了 windows-argv-parser 独有引号语法」这类输入上,而' +
      'enableCustomIntegration() 在我们的 feature-flag shim 里恒 false ⇒ 该输入路径当前不可达。' +
      '⚠️ 纪律记录:上一次把 string-argv 做成值级 import 时它**尚未安装**,全仓 build 一度 exit 1;' +
      '顺序必须是「先确认/装依赖,再让值级 import 进打包图」。',
  ],
  [
    'ui/lib/application-theme.ts',
    '上游 132 行是主题的宿主适配层:import lib/get-os(Electron process.getSystemVersion)、' +
      'lib/local-storage 与 ./theme-source(两者我们树里都没有,也不在 app-state 闭包内)、' +
      'ui/main-process-proxy(Electron nativeTheme),并有 localStorage/document.body 副作用。' +
      '主题由 DSH 宿主拥有(§2.2),storage-tables-design §2.3 F 明确把 selectedTheme/currentTheme 列为不沿用。' +
      '这里只保留 lib/app-state.ts:48 取用的 ApplicationTheme(上游 :15 字符串 enum,逐字)与 ' +
      'ApplicableTheme(:21),刻意省略全部函数。' +
      '2026-10 追加(Preferences ▸ Appearance 接线):上游 ui/preferences/appearance.tsx:2-6 还取' +
      'supportsSystemThemeChanges(:115)与 getCurrentlyAppliedTheme(:86),按 §2.1.5「Web 有真实等价物' +
      '时实现它」就地实现 —— 前者恒 true(上游 Linux 分支就是 return true,而浏览器半唯一运行环境是' +
      'Chromium,prefers-color-scheme 一定有),后者读 matchMedia(与 ui/main-process-proxy.ts 里' +
      'shouldUseDarkColors 的替身同一等价物)。这不是替宿主决定皮肤:真正生效的主题仍由 §2.2 的宿主令牌管。',
  ],
  [
    'ui/lib/update-store.ts',
    '上游 378 行是自动更新器 store:import ui/main-process-proxy 的整套 Electron 自动更新 IPC,' +
      '另有 9 个我们树里没有的文件(error-with-metadata/squirrel-error-parser/release-notes/' +
      'local-storage/http/feature-flag/app-proxy 等)以及 semver/mem/quick-lru/fs-promises/date-fns。' +
      'Desktop 自更新由 DSH Desktop 自己管(storage-tables-design §2.3 F)。这里只保留 ' +
      'lib/app-state.ts:71 取用的 IUpdateState(上游 :49,6 个字段逐字)与其 UpdateStatus(:32,数值 enum 逐字);' +
      'ReleaseSummary 来自已字节一致的 models/release-notes.ts。刻意省略 UpdateStore 类。',
  ],
  [
    'ui/autocompletion/autocompleting-text-input.tsx',
    '只改 import 说明符:`./index` → `./autocompletion-provider`(上游 `:8`)。' +
      '上游的 `ui/autocompletion/index.ts` 是 `export *` 桶文件,esbuild 会把它整份拉进' +
      '客户端包并连带它 re-export 的东西;这里直接指向定义 `IAutocompletionProvider` 的' +
      '那个模块,语义逐字相同、只是绕开桶。**唯一的改动就是这一行**,' +
      '`git-page.tsx` 的 Git 页是这条链的消费方。' +
      '回收条件:桶文件不再是 `export *`(或打包器能 tree-shake 掉桶)⇒ 还原成上游原文,' +
      '本登记删除。',
  ],
  [
    'ui/lib/ref-name-text-box.tsx',
    '同上,只改 import 说明符:`../autocompletion` → `../autocompletion/autocompletion-provider`' +
      '(上游 `:8`),绕开 `export *` 桶以直接取 `AutocompletingInput` 与' +
      ' `IAutocompletionProvider`。**唯一的改动就是这一行**。' +
      '回收条件:同上(桶文件不再 `export *`)⇒ 还原成上游原文,本登记删除。',
  ],
  // --- 有意的最小改动(每处都在文件内注明) ---
  ['lib/patch-formatter.ts', '补一行显式 log import'],
  ['lib/sanitize-ref-name.ts', '修正上游 g 标志 .test() 的 lastIndex 状态性 bug'],
  /*
   * --- 有意偏离:**同步面(推送/拉取/抓取)的用户可见文案本地化成中文** ---
   *
   * 这是 2026-10-06 **人类裁决**的直接产物(goal 文档 §11.9「界面文案统一中文,
   * 国际化以后单独做」),不是遗漏了,也不是改崩了。裁决原文给了两条落地机制:
   *   ① 从**调用点**以 prop 传进去的标签 ⇒ 我们这层传中文,镜像不动;
   *   ② **写死在镜像文件内部**的字符串 ⇒ 首选薄包装;退而求其次「暂时接受英文并登记」。
   * 本条目是 ③:用户本轮**明确否掉了**②里那个「退而求其次」,裁决为
   * **「登记一条有意偏离,把那几句改成中文」**。所以 §11.9 里那句
   * 「**绝不**为了让文案对上而改 `src/core/desktop/**`」在本面被这条人类裁决**取代**
   * (它针对的是「为了美观随手改镜像」,而这里是一处**登记在案、逐条可查**的偏离)。
   *
   * **偏离的范围被刻意限死在「字符串字面量」**:
   *  - 只改 `JSX` 文本与字符串字面量的**内容**,一个字符的结构/逻辑都没动:
   *    没有任何一行被增删,分支、优先级链、prop 名、类名、条件渲染、
   *    focus-trap 的处理、`Progress.kind` 的比较值全部逐字保持;
   *  - **刻意没有**汉化那些**结构性**字符串:`ActionInProgress` 的四个值
   *    (`'push' | 'pull' | 'fetch' | 'force push'`)、`DropdownItemType` 的值、
   *    类名、`key`、`'ArrowUp'/'ArrowDown'`、`'spin'`、`'open'/'closed'` ——
   *    它们要么与上游 `models/progress.ts` 的 `kind` 逐字比较
   *    (`push-pull-button.tsx:225-227` 的 `isPullPushFetchProgress`),
   *    要么是 DOM/React 的协议值;改它们就不再是「只改文案」了。
   *    ⇒ 一处**已知的残留**:`componentDidUpdate` 里那条 aria-live 播报是
   *    `` `${actionInProgress ?? '拉取、推送或抓取'}已完成` ``,当 `actionInProgress`
   *    非空时插进去的仍是内部枚举值(例如 `push 已完成`)。它是屏幕阅读器文案,
   *    要读成纯中文需要给那三个值与中文之间加一层映射 —— 那属于**逻辑改动**,
   *    不在本次范围,留给 i18n 项目。
   *
   * **为什么"薄包装"这条路在本面走不通(排除了,而不是没想到)**:
   *  这两个文件渲染的全部文案都来自**文件内部的局部变量/常量**
   *  (`renderLastFetched()`、`fetchButton()` 的 `` `Fetch ${remoteName}` ``、
   *  `defaultDropdownProps()` 的 `ariaLabel`、下拉项对象里的 `title`/`description`),
   *  没有任何一个是从 props 传进来的 —— 与 `ui/app.tsx:3541` 的
   *  `description={__DARWIN__ ? 'Current Repository' : …}` 那种可传参的情况不同。
   *  而这两个文件**本身不可替换**:`PushPullButton` 的 17 个 prop 里没有
   *  `className` / `label` / `strings` 一类的注入口,`push-pull-button-dropdown.tsx`
   *  更是只在 `PushPullButton.getDropdownContentRenderer()` 内部被 new 出来。
   *  ⇒ 要么改这两个文件,要么整份重写一个并行实现(那正是本项目反复纠正的
   *  「上游有实现,我们却手写了一份」)。
   *
   * **验收/回归判据**:`docs/probes/sync-dropdown-probe.mjs` 断言的是**中文**文案,
   *  并且每条断言都同时给出英文原文的语义位置(文件内注释保留上游原文对照)。
   *  该探针在换装前也会跑(它驱动镜像组件本身)。
   *
   * **退役条件**:出现下面**任意一条**即撤掉本偏离、把两个文件从上游与上游一致回来:
   *  1. i18n 项目落地 —— 上游/我们引入真正的文案表(`<FormattedMessage>` 一类),
   *     这两个文件里的字符串改为查表 ⇒ 不再需要改字面量;
   *  2. 用户改判「顶栏统一英文」(§11.9 的反向裁决);
   *  3. 上游自己做了 i18n,`references/desktop` 的那两份文件不再含英文字面量
   *     ⇒ 直接与上游同步即可。
   *  撤除时**同时**删掉本条登记,并把 `sync-dropdown-probe.mjs` 的期望表切回上游文案。
   */
  [
    'ui/toolbar/push-pull-button.tsx',
    '有意偏离(**用户本轮裁决**):把 12 处**用户可见**字符串本地化成中文,`push-pull-button-dropdown.tsx` 同批(两条登记是同一处裁决的一半,必须一起看)。' +
      '范围严格限死为「字符串字面量的内容」—— 逐处清单(左=上游原文,右=现在):' +
      '`Last fetched` → `上次抓取`(:164);`Never fetched` → `从未抓取`(:168),与 `repo-bar.tsx` 的 `lastFetchedText()` 用词一致;' +
      'aria-live 的 `` `${… ?? 「Pull, push, or fetch」} complete` `` → `…已完成`(:217);' +
      '`` `${title} ${description ?? 「Hang on…」}` `` → `请稍候…`(:237)与 `progressButton` 的同一句(:517);' +
      "`ariaLabel: 'Push, pull, fetch options'` → `推送、拉取、抓取选项`(:263),与换装前 `toolbar.tsx` 的 `ariaLabel` 逐字一致;" +
      '`description="Push pull button"` → `推送/拉取按钮`(:424,`Resizable` 的宽度播报用);' +
      '`Publish repository` / `Publish this repository to GitHub` → `发布仓库` / `把这个仓库发布到 GitHub`(:531-532);' +
      '`Rebase in progress` / `Cannot publish detached HEAD` → `变基进行中` / `分离头状态下无法发布`(:544-545);' +
      '`Publish branch`(两处,:549/:577)→ `发布分支`;`Publish this branch to GitHub` / `…to the remote` → `把这个分支发布到 GitHub` / `把这个分支发布到远端`(:562-564);' +
      '`` `Fetch ${remoteName}` `` → `抓取 ${remoteName}`(:594);' +
      '`` `Pull ${remoteName} with rebase` `` / `` `Pull ${remoteName}` `` → **两者都是** `` `拉取 ${remoteName}` ``(:615-617)。' +
      '**这是用户本轮的明确裁决**(原话:「不要『变基拉取 origin』,请保留『拉取 origin』」):该处三元分支、分支顺序、props 与 dispatch 值全部照上游**逐字保留**,' +
      '只把 rebase 支的字面量改成与另一支**刻意相等** ⇒ `pull.rebase=true` 的仓库界面上显示「拉取 origin」,而 git 仍按配置变基 ——' +
      '**文案与行为不再一致,这是裁决的结果,不是修好的 bug**。' +
      '**为什么不删那个已经冗余的分支**:删掉它就是**结构偏离**,越过本条登记的范围(本偏离严格限死为「字符串字面量的内容」);' +
      '冗余但忠实的三元优于结构偏离 —— 后者会让「把本文件重新从上游与上游一致回去」变成破坏性操作(见 `docs/goal-port-desktop.md` §2.1/§10.3)。' +
      '同一取舍已有一例:`ui/preferences/appearance.tsx` 那两处 `__DARWIN__ ? 同值 : 同值`。' +
      '**哪些判据因此改变**:`docs/probes/pull-rebase-probe.mjs` 的 1b/1b2(文案)与 C1 的期望值随之改为常量,它们自此**只断言「文案恒定」**;' +
      '四种 `pull.rebase` 配置的区别只剩 **dispatch 值**(到达 `store.pull` / `pull` 路由的 `rebase`),由该探针的 1c–4c 与 (e) 守着 —— **那几条比裁决前更重要**。' +
      '**用户再改判时**:把这一处字面量恢复成 `` `变基拉取 ${remoteName}` `` 即可,仍属同一处字符串偏离,不需要新登记。' +
      '`` `Push ${remoteName}` `` → `推送到 ${remoteName}`(:653);`` `Force push ${remoteName}` `` → `强推到 ${remoteName}`(:676)。' +
      '**用词来源不是自创**:`抓取/拉取/推送/强推/发布分支/发布仓库` 与 `repo-bar.tsx` 的 `syncPresentation()`、`store.ts` 的 toast、' +
      '`workbench.tsx` 的「更多」菜单逐字一致;`从未抓取/上次抓取` 同 `repo-bar.tsx:171-175`。' +
      '**没有动的**(刻意):`ActionInProgress` 的四个值、`DropdownItemType` 的值、类名、`key`、`ArrowUp`/`ArrowDown`、`spin`、`open`/`closed` —— ' +
      '前者与 `models/progress.ts` 的 `kind` **逐字比较**(`isPullPushFetchProgress`,`:225-227`),改它就不是「只改文案」。' +
      '**一处已知残留**:`actionInProgress` 非空时那条 aria-live 播报仍是 `push 已完成`(混排),要全中文需要给枚举值加映射 = 逻辑改动,留给 i18n 项目。' +
      '**为什么不能包一层**:这两个文件的文案全部来自**文件内部**的局部变量(' +
      '`renderLastFetched()` / `fetchButton()` / `defaultDropdownProps()` / 下拉项对象),没有一处是 prop —— 与 `ui/app.tsx:3541` 那种「调用点传 description」不同;' +
      '而 `PushPullButton` 的 17 个 prop 里**没有** `className`/文案注入口,`PushPullButtonDropDown` 只在 `getDropdownContentRenderer()` 内部被构造。' +
      '**退役条件**:i18n 项目落地(字符串改为查表)/ 用户改判「顶栏统一英文」/ 上游自己做了 i18n —— 三者任一出现,就把本文件从上游与上游一致回来、删掉本条登记,并把 ' +
      '`docs/probes/sync-dropdown-probe.mjs` 的期望表切回英文。判据:该探针断言的就是这批中文文案。',
  ],
  [
    'ui/toolbar/push-pull-button-dropdown.tsx',
    '有意偏离(**用户本轮裁决,同一处的另一半** —— 必须与 `ui/toolbar/push-pull-button.tsx` 那条一起读一起撤)。' +
      '改动同样只有字符串字面量的内容,逐处:下拉项 `Fetch ${remoteName}` → `抓取 ${remoteName}`(:74);' +
      '`Fetch the latest changes from ${remoteName}` → `从 ${remoteName} 抓取最新的变更`(:75);' +
      '`Warning:` → `警告:`(:83);那整段强推警告从上游的' +
      '`A force push will rewrite history on the remote. Any collaborators working on this branch will need to reset their own local branch to match the history of the remote.`' +
      ' → `强推会重写远端上的历史。所有正在这个分支上协作的人都必须把自己的本地分支重置成远端的历史。`;' +
      '`Force push ${remoteName}` → `强推到 ${remoteName}`(:90);' +
      '`Overwrite any changes on ${remoteName} with your local changes` → `用你本地的变更覆盖 ${remoteName} 上的内容`(:93)。' +
      '**没有动的**:组件结构、`itemTypes` 的遍历顺序、`<Octicon>`/`.text-container > .title + .detail` 的 DOM、`warning` 的**条件渲染**' +
      '(`askForConfirmationOnForcePush` 为真时**仍然**整块不渲染 —— 探针 S6 就是这条的判据)、键盘上下键那段逻辑。' +
      '**一处刻意的排版事实**:那句中文警告写成**一整行** JSX 文本。上游是跨 4 行写的,而 JSX 会把「跨行文本」折成一个空格 —— ' +
      '中文句子中间插空格是错的,所以这里不能保持上游的换行方式(这不是格式偏好,是渲染结果不同)。' +
      '**退役条件**:同 `ui/toolbar/push-pull-button.tsx` 那条(i18n 落地 / 用户改判英文 / 上游自己 i18n),两条必须同批撤除。',
  ],
  [
    'ui/lib/popover.tsx',
    '修正上游 `:168-176` 把 `--available-height` 拼成 `"…pxpx"` 的 bug:' +
      '`newMaxHeight` 的两个分支(`:170`/`:171`)已经带 `px`,上游又拼了一次 ⇒' +
      ' 自定义属性存的是 token 串,拼错不报错,直到 `_popover.scss:15` 的' +
      ' `max-height: var(--available-height)` 在计算值阶段失效 ⇒ 回落到 `none`,' +
      ' 即上游那条 max-height **从未生效**。我们这里去掉重复拼接(唯一的改动,' +
      ' 位置与语义逐字保留)。' +
      '实测前提:`--available-height` 在产物里**同时**有写入方(本文件)与' +
      '消费方(4 个面的 `@import ./upstream/ui/popover`),不是死规则。' +
      '回收条件:上游修掉重复拼接 ⇒ 本文件重新字节一致,本登记删除。',
  ],
  /*
   * --- 有意偏离:Preferences 弹窗的**用户可见文案本地化成中文** ---
   *
   * 与上面 `ui/toolbar/push-pull-button*.tsx` 那两条是**同一处人类裁决**
   * (goal 文档 §11.9「界面文案统一中文,国际化以后单独做」),只是换到了偏好设置弹窗这一面。
   * 用户本轮又复述了一次(「先统一中文」),并把自己截图里的三块英文点了名:
   * 账号页的 GitHub Enterprise 段、Git 页的「These preferences will edit your global Git
   * config file.」、以及**整页**的无障碍页。这一批就是那三块的落地。
   *
   * **偏离的范围同样严格限死为「字符串字面量的内容」**:
   *  - 没有增删任何一行逻辑:分支、条件渲染、prop 名、类名、`aria-describedby` 的 id、
   *    `assertNever` 的调用、`__DARWIN__` / `__WIN32__` 的条件、`<Ref>` / `<LinkButton>`
   *    的嵌套结构全部逐字保留;
   *  - **刻意没有汉化结构性字符串**:`OtherEmailSelectValue = 'Other'`(它是 `<option value>`,
   *    并与 `event.currentTarget.value` **逐字比较**,只把它的**可见文本**换成「其它」)、
   *    `shellFriendlyNames` 的值(来自 `lib/hooks/config.ts` 的镜像)、`warningMessageVerb="saved"`、
   *    `Unknown sign in type: ${type}`(assertNever 的开发者信息,不上屏)。
   *
   * **用词不是自创**,逐条都能指到本仓已有中文的真源:
   *  - 无障碍页两条:`src/client/prefs.ts:14` 的「给链接加下划线」、
   *    `src/client/diff-mode.ts:108/139/145` 的「在 diff 里显示勾选标记」;
   *  - 页签名「无障碍」与 `src/client/preferences-pages.tsx` 的 `TABS` 逐字一致;
   *  - 品牌名(`GitHub.com` / `GitHub Enterprise` / `GitHub` / `main` / `master` / `nvm` …)一律不译。
   *
   * **一处刻意的排版事实(与 `push-pull-button-dropdown.tsx` 那条同因)**:无障碍页第一段说明
   * 上游是**跨 3 行**写的、且 `{this.renderExampleLink()}` 前有一个 `{' '}`;JSX 会把跨行文本
   * 折成**一个空格**,而中文句子中间插空格是错的 ⇒ 中文写成**一整行** JSX 文本、表达式另起一行
   * (不带 `{' '}`)。`git.tsx` 的「这些偏好会<LinkButton>…</LinkButton>。」同样去掉了那个 `{' '}`
   * 与句末的 ASCII 句点(中文用「。」)。
   *
   * **验收/回归判据**:`node docs/probes/preferences-uitune-probe.mjs` 的 C 组会枚举
   * **弹窗六个页面上实际渲染出来的**文本(真 Chrome 里读 textContent,不是 grep 源码),
   * 断言这批中文出现、且点名的那几个英文串不再出现。
   *
   * **退役条件**:出现下面**任意一条**即撤掉这几条登记、把四个文件从上游与上游一致回来:
   *  1. i18n 项目落地(上游/我们引入真正的文案表,字符串改为查表);
   *  2. 用户改判「偏好设置弹窗统一英文」;
   *  3. 上游自己做了 i18n,`references/desktop` 的这四份文件不再含英文字面量。
   * ⚠️ 四条登记是**同一处裁决的四个文件**,必须同批撤除。
   */
  [
    'ui/preferences/accessibility.tsx',
    '有意偏离(用户裁决:统一中文;`git.tsx` / `accounts.tsx` / `ui/lib/git-config-user-form.tsx` 同批,四条一起读一起撤)。' +
      '**整页**本地化 —— 逐处清单(左=上游原文,右=现在):' +
      '`Accessibility` → `无障碍`(与 `preferences-pages.tsx` 的 `TABS` 页签名逐字一致);' +
      '`Underline links` → `给链接加下划线`(与 `src/client/prefs.ts:14` 逐字一致);' +
      '`:38-40` 整段 → `开启后,提交信息、评论和其它文本字段里的链接会带上下划线,这样更容易分辨。`;' +
      '`Show check marks in the diff` → `在 diff 里显示勾选标记`(与 `src/client/diff-mode.ts:108/139/145` 逐字一致);' +
      '`:57-59` 整段 → `开启后,提交时 diff 里的行号与行号组旁边会显示勾选标记;关闭后,行号控件会不那么显眼。`;' +
      '`This is an example link` → `这是一个示例链接`。' +
      '**没有动的**:`ariaDescribedBy` 的两个 id(`underline-setting-description` / ' +
      '`diff-checkmarks-setting-description`,它们是 DOM 协议值)、`.accessibility-section` / `.example-link` 类名、' +
      '`renderExampleLink()` 的内联 `textDecoration`(那个示例链接的行为不变)。' +
      '**排版**:第一段写成一行 JSX 文本 + 表达式另起一行,见上面总注释第 5 段。',
  ],
  [
    'ui/preferences/accounts.tsx',
    '有意偏离(用户裁决:统一中文,四条同批)。逐处:' +
      '`Sign Out` / `Sign out`(`:103` 的 `__DARWIN__` 三分支)→ `退出登录`;' +
      '`Sign Into` / `Sign into`(`:118` 的局部变量,被拼成 `登录 GitHub.com` / `登录 GitHub Enterprise`)→ `登录`;' +
      '`Add GitHub Enterprise account` → `添加 GitHub Enterprise 账号`;' +
      '`Sign in to your GitHub.com account to access your repositories.` → `登录你的 GitHub.com 账号以访问你的仓库。`;' +
      '`If you are using GitHub Enterprise at work, sign in to it to get access to your repositories.` → ' +
      '`如果你在工作中使用 GitHub Enterprise,登录它以访问你的仓库。`(用户截图里那一段)。' +
      '⚠️ 两处 `__DARWIN__ ? a : b` 的**三元结构逐字保留**,只是两个分支的中文相同(中文没有大小写之分);' +
      '这一点是刻意的:把三元删掉才是**结构改动**,不在本次授权范围内。' +
      '**没有动的**:`<h2>GitHub.com</h2>` / `<h2>GitHub Enterprise</h2>`(品牌名)、' +
      '`(GitHub.com)` / `(GitHub Enterprise)` 后缀、`Unknown sign in type: ${type}`(assertNever 的开发者信息)。',
  ],
  [
    'ui/preferences/git.tsx',
    '有意偏离(用户裁决:统一中文,四条同批)。逐处:' +
      '三个子页签 `Author` / `Default branch` / `Hooks`(`:147-149`)→ `作者` / `默认分支` / `钩子`;' +
      '`Load Git hook environment variables from shell` → `从 shell 加载 Git 钩子环境变量`;' +
      '`When enabled, GitHub Desktop will attempt to load environment variables …` 整段 → 中文;' +
      '`Shell to use when loading environment` → `加载环境时使用的 shell`;' +
      '`Cache Git hook environment variables` → `缓存 Git 钩子环境变量`;' +
      '`Cache hook environment variables to improve performance. …` 整段 → 中文;' +
      '`Default branch name for new repositories` → `新仓库的默认分支名`;' +
      '`GitHub\'s default branch name is <Ref>main</Ref>. You may want to change it … <Ref>master</Ref>.` → ' +
      '`GitHub 的默认分支名是 <Ref>main</Ref>。工作流不同、或者你的集成仍然需要历史上的默认分支名 <Ref>master</Ref> 时,你可以把它改掉。`(两个 `<Ref>` 原样保留);' +
      '`These preferences will{\' \'}<LinkButton>edit your global Git config file</LinkButton>.` → ' +
      '`这些偏好会<LinkButton>编辑你的全局 Git 配置文件</LinkButton>。`(用户截图里的那一行)。' +
      '**没有动的**:`warningMessageVerb="saved"`(它插进的是 `ui/lib/ref-name-text-box.tsx` 里那句**仍为英文**的' +
      '「Will be … as …」模板,单改这一个词只会得到中英混排 ⇒ 见下面「仍未中文」的登记)、' +
      '`shellFriendlyNames` 的值(来自 `lib/hooks/config.ts` 的镜像,Windows 专属分支)、' +
      '`ariaLabelledBy` / `ariaDescribedBy` 的 id(`default-branch-heading` / `default-branch-description`)。',
  ],
  [
    'ui/lib/git-config-user-form.tsx',
    '有意偏离(用户裁决:统一中文,四条同批)。逐处:`Name` → `姓名`;`Email` → `邮箱`' +
      '(两处:邮箱**下拉**的 `label`,以及**独立文本框**的 `label` 与 `ariaLabel` —— 上游那两处本来' +
      '就是同一个字符串的两个角色,一起改才不会出现「标题中文、读屏英文」);' +
      '下拉里 `Other` 这一项的**可见文本** → `其它`。' +
      '⚠️ **`OtherEmailSelectValue` 这个常量的值仍然是 `\'Other\'`**:它同时是 `<option value>` 与' +
      '`onEmailSelectChange` 里 `value === OtherEmailSelectValue` 的比较对象,改它就是改逻辑' +
      '(与 `push-pull-button.tsx` 那条「不动 `ActionInProgress` 的枚举值」同一判据)。' +
      '**没有动的**:`(GitHub.com)` / `(GitHub Enterprise)` 两个后缀(品牌名)、`getStealthEmailForAccount` 的拼接。' +
      '⚠️ 这个文件同时被 `ui/repository-settings/**`(§1.3 排除面)引用 —— 那边的标题会跟着变中文,' +
      '那是**一致的好处**而不是回归。',
  ],
  [
    'ui/preferences/appearance.tsx',
    '有意偏离(用户裁决:统一中文,五条同批 —— 这一条是**用户发来的「外观」页截图**那一页,' +
      '六张截图里唯一没被点名却又整页英文的一页,一并做了)。逐处(14 行,每行只改字符串内容):' +
      '`Light` / `Dark` / `System`(色板标签)→ `浅色` / `深色` / `跟随系统`;' +
      '`Loading system theme` → `正在读取系统主题`;`Theme` → `主题`;`Formatting` → `格式`;' +
      '`Date Format` / `Date format` → `日期格式`;`Time Format` / `Time format` → `时间格式`;' +
      '`Number Format` / `Number format` → `数字格式`;' +
      '`Prefer absolute dates over relative` → `优先显示绝对日期,而不是相对日期`;' +
      '`Miscellaneous` → `其它`;`Diff Tab Size` / `Diff tab size` → `Diff 制表符宽度`;' +
      '`` `${n} (default)` `` → `` `${n} (默认)` ``;`Always show worktree list` → `始终显示 worktree 列表`' +
      '(最后这一条由适配层 `display:none !important` 删除、**不上屏**,顺手一起译是为了让这一页' +
      '不再残留任何英文字面量,判据是探针的「六页文本里不再出现这些英文」那一组)。' +
      '⚠️ 六处 `__DARWIN__ ? a : b` 的三元结构逐字保留(中文没有大小写差异,两个分支同值),' +
      '删掉三元才是结构改动。' +
      '**没有动的**:`theme-value-label` / `theme-selector` / `appearance-section` 等类名,' +
      '`ariaLabelledBy="theme-heading"` 等 id,`dateFormats` / `timeFormats` / `numberFormats` 的' +
      '**示例值**(`Oct 19, 2017 (MMM d, yyyy)` 一类是格式样例,不是文案)。' +
      /*
       * --- 同一文件上的**第二处**有意偏离:主题色板图改成构建期内联(2026-10)---
       *
       * 触发者:用户报「为什么主题这里图片加载失败了」(外观页三个色板的裂图)。
       * 上面那条(中文文案)与本条是**独立的两件事**,必须分开读、可分开撤。
       */
      '\n【第二处偏离:主题色板图改为构建期内联 data URL(2026-10,用户报裂图)】' +
      '**改的是什么**(2 行 + 1 条 import):' +
      '`(before)` `import { encodePathAsUrl } from \'../../lib/path\'`;' +
      '`const darkThemeImage = encodePathAsUrl(__dirname, \'static/ghd_dark.svg\')`;' +
      '`const lightThemeImage = encodePathAsUrl(__dirname, \'static/ghd_light.svg\')` ⇒ ' +
      '`(after)` `import ghdDarkThemeImage from \'../../static/common/ghd_dark.svg\'`、' +
      '`import ghdLightThemeImage from \'../../static/common/ghd_light.svg\'`;' +
      '`const darkThemeImage = ghdDarkThemeImage`;`const lightThemeImage = ghdLightThemeImage`。' +
      '**为什么是 default 而不是命名导出**:esbuild 的 `dataurl` loader 对 `.svg` **只**产出' +
      '默认导出(取 `{ dataUrl }` 会直接打包失败:`No matching export … for import "dataUrl"`),' +
      '而本仓 ESLint 的 `no-restricted-syntax` 禁止 default export ⇒ 类型声明' +
      '(`types/desktop-globals-client.d.ts` 的 `declare module \'*.svg\'`,写在**基线 0 条**的那个' +
      'client 全局文件里而非 `client-platform-shims.d.ts`)是唯一能同时满足两边的位置。' +
      '`<img src={…} alt="" />` 的五处标记与 `theme-value-label` 的标签文本**一字未动**。' +
      '**为什么必须动上游这一处**(实测读数,不是推断):' +
      '① 上游 `lib/path.ts:10` 是 `pathToFileURL(Path.resolve(...))`,而浏览器半的 ' +
      '`src/client/shim-node-url.ts:36-38` 的 `pathToFileURL` **返回原串** ⇒ 产出的 `src` 是' +
      '**根相对 HTTP 路径** `/dsh-git-diff/static/ghd_light.svg`(`__dirname` 固定为 `/dsh-git-diff`,' +
      '见 `src/client/desktop-globals.ts:45`);' +
      '② 宿主只注册 `/dsh-git` 前缀(`src/host/routes.ts:22`),`/dsh-git-diff/*` 必然 403/404 ⇒ ' +
      '五张 `<img>` 的 `naturalWidth === 0`(裸 Chrome 实时读数:`complete=true, natural=0x0`,即裂图)。' +
      '⚠️ **它不是 `file://`** —— 探针页是 `file://` 时那个相对路径才解析成 `file:`;生产页面是 ' +
      '`http://127.0.0.1:43120/` 时它解析成 `http://127.0.0.1:43120/dsh-git-diff/…`(实测 403)。' +
      '`dataurl` 内联后浏览器**不发任何请求**,于是既不依赖 `__dirname`、也不需要新增宿主静态路由。' +
      '**资产来源**:两张 SVG **逐字节复制**自上游 `references/desktop/app/static/common/' +
      'ghd_{light,dark}.svg`(1802 / 1765 字节,sha256 `befc478a…` / `5a29c02e…`),' +
      '落在镜像同构路径 `src/core/desktop/static/common/`;该目录在上游是 `app/static/common/`,' +
      '所以镜像里 `../../static/common/x.svg` 与上游同构(本探针的 A2/A4 判据读到的 ' +
      '`naturalWidth=228` 与内容标记就是这两个文件真的被内联进产物的证据)。' +
      '**为什么偏离落在调用点而不是 `lib/path.ts` 的 `encodePathAsUrl`**(评估过,结论是不该):' +
      '① 那条 `src` 是**运行期拼串**,构建期 loader 碰不到它;全局改法只能让 `pathToFileURL` 返回' +
      '**猜出来**的路径,且**必须新增一条宿主静态路由**(host 改动 = 必须重启应用);' +
      '② `encodePathAsUrl` 还有 6 个**同类但已裁定为「不是缺陷」**的调用点' +
      '(`ui/diff/index.tsx:38` 的 `NoDiffImage`、`ui/changes/no-changes.tsx:54`、' +
      '`ui/repositories-list/repositories-list.tsx:31`、`ui/changes/multiple-selection.tsx`、' +
      '`ui/branches/no-branches.tsx`、`ui/branches/no-pull-requests.tsx`,' +
      '见 goal 文档 §5 与 §10.9),全局改动会把那 7 处一起换掉 —— 越权。' +
      '**判据**(`docs/probes/appearance-theme-swatch-probe.mjs`,真 headless Chrome + CDP,' +
      '对**真 `Appearance` 组件**的读数):' +
      'A1 `src` 属性是 `data:` / A2 `complete=true` 且 `naturalWidth×naturalHeight = 228×120` /' +
      'A3 逐张顺序与「解码后 SVG 长度只有 1802 与 1765 两种」/ A4 解码内容归属(浅色带 `#F6F8FA`、' +
      '深色带 `#25292E`)/ A5 0 未捕获异常。**改后 19/19 · exit 0**;' +
      '`--pre-fix`(用 esbuild 内存插件把这两行换回改动前的形式;**不碰磁盘**)' +
      '**17 条红 · exit 1**(A1/A2/A3/A4 全红,A0/A5 仍绿)⇒ 判据承重。' +
      '**退役条件**:出现**任意一条**即撤掉本偏离、把这 2 行按上游原文还原、并把两张 SVG 从' +
      '`src/core/desktop/static/common/` 删除、同时删掉 `scripts/build.mjs` 的 ' +
      '`clientLoader`(`.svg → dataurl`):' +
      '① 宿主开始以 HTTP 提供插件的静态资产(例如 `ctx.webServer` 上有了一条能服务 ' +
      '`/dsh-*/*.svg` 的路由)—— 那时 `encodePathAsUrl(__dirname, …)` 会真的取到文件,' +
      '按上游原文还原即可(注意届时 `__dirname` 也必须指向宿主的服务根);' +
      '② 上游自己把这两张图改成 import(或别的构建期内联机制)—— 直接与上游同步;' +
      '③ 上游把 `static/` 挪出 `app/`(镜像同构路径不再成立)—— 重新核对资产来源后再定。' +
      '撤除时**同时**删掉本条登记,并同步更新 `docs/probes/appearance-theme-swatch-probe.mjs` 的' +
      '期望(它的 A1 会因此翻红,那是**正确**的)。',
  ],
  // 注:`lib/diff-parser.ts` 与 `ui/diff/text-diff-expansion.ts` 原本登记在这里
  // (上一轮把 `diff-helpers` 的说明符钉到我们自建的 `.ts` 孪生文件上)。
  // 2026-05 接线时改掉了那个做法:自建的 `ui/diff/diff-helpers.ts` 已删除、
  // 上游 `diff-helpers.tsx` 逐字还原,这两个文件的 import 也随之还原成上游原文,
  // 于是它们**重新变成字节一致** —— 登记随之删除。
]);

/** 上游没有对应文件:我们自己写的,或按审计建议提取的。 */
const OURS = new Set([
  'lib/log.ts',
  'lib/path-display.ts',
  // `ui/diff/diff-helpers.ts`(自建的 React-free 孪生)已删除,见上面 EXPECTED 里的说明。
  'ui/diff/diff-rows.ts',
]);

/**
 * 递归列出某目录下的 .ts/.tsx(相对路径,统一用 `/` 分隔)。
 * @param root - 根目录。
 */
async function listFiles(root) {
  const out = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full);
    }
  }
  await walk(root);
  return out;
}

/**
 * 找一个镜像文件对应的上游文件。
 *
 * 镜像刻意沿用上游的 `lib/` 与 `models/` 目录结构,所以多数情况同路径即可命中;
 * 少数文件上游放在别处(如 `models/diff/`、`ui/` 下),这里逐个兜底试。
 * @param rel - 相对镜像根的路径(用 `/`)。
 */
async function findUpstream(rel) {
  const candidates = [join(UPSTREAM, rel)];
  const parts = rel.split('/');
  if (parts[0] === 'lib' || parts[0] === 'models' || parts[0] === 'ui') {
    // 上游也可能把它放在别的顶层目录下
    for (const pref of ['lib', 'models', 'ui', 'lib/git', 'lib/stores']) {
      candidates.push(join(UPSTREAM, pref, parts.slice(1).join('/')));
    }
  }
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // 继续试下一个
    }
  }
  return null;
}

/** 主流程。 */
async function main() {
  /*
   * 拿不到上游 checkout ⇒ **跳过**(退出码 2),绝不装成「通过」。
   * `.gitignore:221` 把 `/references/` 排除,所以 CI 与干净检出里一定没有它;
   * 这正是本探针不叫 `check-*.mjs` 的原因(见文件头)。
   */
  try {
    await stat(UPSTREAM);
  } catch {
    console.log(
      `dsh-git: 镜像完整性探针 —— SKIP\n` +
        `  拿不到上游 checkout(${UPSTREAM});本探针需要它才能判定「我们与上游逐字节相同」。\n` +
        `  本机取法见 docs/desktop-inventory.md;CI 里**不跑**这条(它已从 check-*.mjs 集合移出)。`,
    );
    process.exitCode = 2;
    return;
  }

  const files = await listFiles(MIRROR);
  const identical = [];
  const expected = [];
  const suspicious = [];
  const ours = [];
  const noUpstream = [];

  for (const file of files) {
    const rel = relative(MIRROR, file).split(sep).join('/');
    if (OURS.has(rel)) {
      ours.push(rel);
      continue;
    }
    const upstream = await findUpstream(rel);
    if (upstream === null) {
      noUpstream.push(rel);
      continue;
    }
    const same = Buffer.compare(await readFile(file), await readFile(upstream)) === 0;
    if (same) identical.push(rel);
    else if (EXPECTED.has(rel)) expected.push(rel);
    else suspicious.push(rel);
  }

  const total = files.length;
  console.log(`dsh-git: 镜像完整性 — 共 ${total} 个文件`);
  console.log(`  与上游字节一致: ${identical.length}`);
  console.log(`  已登记的偏离:   ${expected.length}`);
  console.log(`  我们自己新增:   ${ours.length}`);
  if (noUpstream.length > 0) {
    console.log(`  上游找不到对应: ${noUpstream.length} (${noUpstream.join(', ')})`);
  }

  // 登记了但实际已一致(说明上游变了或我们对齐了)→ 提醒清理,不算失败
  const staleExpected = expected.filter((rel) => !identical.includes(rel));
  const registered = [...EXPECTED.keys()].filter((rel) => !expected.includes(rel) && !ours.includes(rel));
  if (registered.length > 0) {
    console.log(`  提示: 登记表里这些文件不在镜像里(已删除?): ${registered.join(', ')}`);
  }
  void staleExpected;

  if (suspicious.length > 0) {
    console.error('');
    console.error('dsh-git: 以下镜像文件与上游不一致,且**没有登记理由** —— 视为被改坏:');
    for (const rel of suspicious) console.error(`  ≠ ${rel}`);
    console.error('');
    console.error('  若是有意偏离,请在 scripts/verify-mirror.mjs 的 EXPECTED 里登记并写明理由;');
    console.error('  若是被改坏,直接从上游与上游一致回去。');
    process.exitCode = 1;
    return;
  }
  console.log('  非预期偏离: 0 ✓');
}

await main();
