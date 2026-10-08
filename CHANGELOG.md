# Changelog

本文件记录**面向用户**的变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 修复

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
