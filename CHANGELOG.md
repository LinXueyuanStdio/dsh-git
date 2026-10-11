# Changelog

本文件记录**面向用户**的变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增

- **GitHub App 的用户令牌会自动续期**（改前 8 小时后就到处 401）。GitHub App 的令牌默认 8 小时过期，
  续期靠设备码响应里那枚 `refresh_token`（6 个月不用则失效）。现在：
  ①**主动**——到期前 5 分钟自动换一对新令牌（`src/host/token-refresh.ts`；`git push` 只能靠这一道，
  因为交给 git 子进程的令牌是同步取的）；
  ②**被动**——任何一次取数遇到 401 就问续期器要新令牌并**重试一次**（重启之后进程内存里的到期时间没了，
  靠这一道兜；`/user`、`/user/repos`、`/user/emails`、`gh` 代理、安装状态检查都覆盖）。
  refresh token 住在 `refs.GITHUB_REFRESH_TOKEN`（与 access token 同一条凭据缝、同一套「不可写就绝不退回
  明文」的策略）；**先写 refresh 再写 access** —— GitHub 的规则是用完即换，反过来崩在中间会让磁盘上留下
  一对已经作废的凭据。日志只报结果（`令牌已自动续期(新令牌 N 分钟后到期)`），永不打印令牌值。
  并发去重（同一刻十个 401 只换一次）、`bad_refresh_token`（清掉不再重试，如实说「需要重新登录」）
  都有用例钉住。若 GitHub 用 `incorrect_client_credentials` 拒掉续期，日志会给出两条出路：
  在 App 的 **Optional Features** 里关掉 “User-to-server token expiration”，或用
  `DSH_GIT_CLIENT_SECRET` 给部署侧一个 client secret（env，不进仓库）。
- **账号页会检测 GitHub App 是否已安装，并给出安装入口**。GitHub App 的「授权」与「安装」是两件事：
  设备码授权成功后 `GET /user/installations` 仍可能是 `total_count: 0`，此时**所有仓库级**端点一律 403，
  而 GitHub 只回一句 `Resource not accessible by integration`（不解释、也不给下一步）—— 用户只能
  在各页签里看到同一个错。现在账号页会直接显示「这个 App 还没有安装到你的账号」+ 安装链接
  （自带 App 时只说明该做什么，**不会**替你编一条链接 —— slug 是内置 App 才有的信息）。
  判据是 host 半的纯函数 `installationStatusOf()`（五档：未登录 / 不是 App 令牌 / 查不到 / 已安装 /
  未安装），只有最后一档会在界面上说话 —— PAT 用户与一次网络抖动都不会被误报。7 条用例离线钉住。
- **`Resource not accessible by integration` 这句 403 现在有可操作的解释**：说清「授权 ≠ 安装」，
  并列出另外三种常见原因（权限没勾全 / 改过权限后没重新授权 / 安装范围不含这个仓库）。
- **设备码登录开箱可用**：包内内置一个 GitHub App 的 Client ID（**只登记在代码里**：
  `src/index.ts` 的 `BUILTIN_CLIENT_ID`；README / CHANGELOG / profile 注释等文档里不重复它），
  装好即可点「登录 GitHub.com」走设备码，不必自己注册 App。要换成自己的 App，优先级为
  `config.clientId` > `DSH_GIT_CLIENT_ID` > 包内内置值；其中任意一层写 `off` 就**关掉**设备码登录、
  只用 Personal Access Token。host 启动日志里 `clientId` 后面那句会说明这台机器实际生效的是哪一层
  （**只报来源，不报值**）。
  ⚠️ 内置的是 **GitHub App**，所以有两条要知道：①仓库访问要求先把该 App **安装**到你的账号/组织
  （没安装的表现是「登录成功但仓库列表为空」，安装入口
  <https://github.com/apps/dsh-git-local/installations/new>）；②它的用户令牌**默认 8 小时后过期**，
  但插件会**自动续期**（见上面第一条）。
- **host 会在设备码登录成功时记一行「令牌形态」**（令牌前缀 / 是否过期 / 有没有 `refresh_token`）。
  它只报形状、不报令牌值，是「要不要实现自动续期」这件事的现场证据。
- **设备码起不来时不再静默**：host 给的原因会显示在设备码面板里（改前会永远停在
  「正在向 GitHub 申请设备码…」，而实际上什么都没在申请）。

### 修复

- **设备码登录不再卡在「等待授权」**（浏览器里已经授权、插件却一直拿不到令牌）。GitHub 对过快的
  轮询会回 `slow_down`，并**每次把要求的间隔再加 5 秒**且不下发令牌 —— 真机实测
  （每 1 秒打一次）：`authorization_pending` → `slow_down interval=10` → `15` → `20` …；
  而按要求的间隔等够之后，下一次就恢复正常（`authorization_pending`）。旧实现把 `slow_down`
  当普通 pending、继续按原节奏打，于是令牌**永远**拿不到。
  现在：host 把 GitHub 给的新 `interval` 原样带出（`src/host/auth.ts`），客户端据此退避
  （缺失才 +5 秒，**只增不减**），并用「上一轮结束后再排下一轮」的 `setTimeout` 链取代固定
  `setInterval`（不会再叠加并发轮询）；设备码面板上「每 N 秒检查一次」随真实节奏更新。
  判据是纯函数 `nextDevicePollInterval()`，7 条用例离线钉住。
- **账号页重排为三段，PAT 入口挪到登录按钮旁边**：自上而下现在是
  ① 设备码面板 → ② 上游 `Accounts`（谁已登录 + 两个登录 CTA）→ ③ `AccountNotice`（安装检测与引导）。
  「GitHub 端点 + 访问令牌(PAT) + 用令牌登录」那块不再无条件占屏：**入口按钮【PAT 令牌登录】与
  登录 / 退出登录按钮同一行**，点开才是表单（表单紧跟 GitHub.com 那一段）；上游的企业登录 CTA
  仍然会把它打开并把焦点送进令牌输入。为此给上游 `ui/preferences/accounts.tsx` 加了两个**可选插槽**
  （`patSignInAction` / `patSignInForm`）—— 这是该文件上的第一条**结构**偏离，已写进
  `scripts/verify-mirror.mjs` 的 EXPECTED 说明里（不传插槽时 DOM 与上游逐字相同）。
  另外**邮箱来源那句不再上屏**（「邮箱候选来自你的 GitHub 账号（N 个已验证地址）」没有动作可做），
  邮箱读取**失败**才显示 —— 那通常意味着 App 少了 `Email addresses: Read`。
  可见性只有一个布尔量（两条入口都写它），所以先前那套「自动展开 + 用户收起」的判据
  （`enterprisePanelReveal()`）随之删除。
- **登出后账号页不再显示一张空账号卡**：`auth/state` 在**未登录时也回一个对象**
  （`{signedIn:false, login:''}`），弹窗那一半原先只判 `auth !== null`，于是会构造出
  `login: ''` 的假登录态、渲染出没有名字的账号卡。现在弹窗也走 `cardAuthOf()`
  （与设置卡片同一个收窄点，判据只此一处）。
- **普通 `dsh web` profile 里右侧栏不再缺 `git` 页签**。`sidebarRightTabs` 在浏览器半
  `apply` 时**还没挂载**（它随后才到），此前用 `ctx.get()` 只采样一次，于是**所有**环境里
  都跳过注册、只有控制台的一句 warning —— 表现为「右侧栏在、官方页签都在、就是没有 git」。
  改为动态 `ctx.inject(['sidebarRightTabs'], …)` 懒等待：服务到了就注册，不来就什么都不做，
  且不阻塞插件激活（静态 `inject` 会把整条客户端启动链卡成 pending，整个 Web UI 一起不可用）。

## [1.0.0] - 2026-10-07

首个版本。

### 新增

- **官方右侧栏页签** —— 在 DSH 右侧栏注册一个 tab（实例 id `dsh-git`，显示名 `git`），
  与官方其它页签同一套交互；侧栏「插件」页与「设置 ▸ 内置插件」两处都有设置卡片。
- **多仓库下拉** —— 你显式添加过的本地仓库；登录 GitHub 后还能列出你有权限的远端仓库。
- **Changes** —— 文件级暂存 / 取消暂存、逐行 diff、提交（摘要 + 描述），
  提交信息可由 DSH 模型列表里已配好的模型生成。
- **History** —— 提交列表；选中提交显示说明、短 sha 与 `+`/`−` 统计，
  以及该提交改动的文件与逐行 diff。
- **Code** —— 远端文件树；**没有远端时退化为本地工作区视图**，不是空页。
- **Issues** —— 列表 + 详情，可新建、评论、关闭 / 重开。
- **Pull requests** —— 列表 + 详情，可新建 PR。
- **Actions** —— workflow runs 列表，可重跑或取消。
- **同步与分支** —— fetch / pull / push；强推只允许 `--force-with-lease`
  （全库没有裸 `--force`）。分支可切换、新建、重命名；可检出某个提交（分离头）或 cherry-pick。
- **克隆** —— 走 host 半，且关掉 `protocol.ext.*`。
- **GitHub 登录** —— Personal Access Token（细粒度需 Contents R / Issues RW /
  Pull requests RW / Actions RW；经典 Token 用 `repo`）；
  在 profile 里填了 OAuth App 的 `clientId` 时额外提供**设备码登录**。

### 安全

- `/dsh-git/*` 路由**只接受 loopback** 请求，局域网 / 远程访问一律 403。
- git 只能操作**你显式添加过的仓库**清单里的路径，其他路径返回 `workspace-unknown`。
- 令牌只存在 host 半：挂在宿主凭据接缝 `ctx.credentials` 的 `GITHUB_TOKEN` 上，
  界面只显示尾 4 位；git 通过环境变量拿凭据，不进 argv、不进 `.git/config`。
  令牌**不在**插件的通用状态域里（整域读 / 写 / 导出 / 备份都不会带上它）。
- `GITHUB_TOKEN=… dsh` 是**只读覆盖**（写它会被拒），轮换令牌不需要改代码。
- 静止保护是**明文 + 文件权限**（文件 `0600` / 目录 `0700`），**没有加密** ——
  与宿主 `credentials-local` 自己的做法一致，详见 README 的「GitHub 登录与令牌」一节。

### 已知边界

- 远端页签以 GitHub 为准；本地**未推送**的提交在 Code 树里看不到对应文件。
- 暂存是**文件级**的（M1），没有 hunk 级暂存。

[Unreleased]: https://github.com/LinXueyuanStdio/dsh-git/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/LinXueyuanStdio/dsh-git/releases/tag/v1.0.0
