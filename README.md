# @linxueyuan/dsh-git

**简体中文** | [English](./README.en.md)

[![CI](https://github.com/LinXueyuanStdio/dsh-git/actions/workflows/ci.yml/badge.svg)](https://github.com/LinXueyuanStdio/dsh-git/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@linxueyuan%2Fdsh-git?label=npm&color=4d6bfe)](https://www.npmjs.com/package/@linxueyuan/dsh-git)
[![License: MIT](https://img.shields.io/badge/license-MIT-4d6bfe.svg)](./LICENSE)

<p align="center">
  <img src="./assets/readme/hero.svg" width="100%"
       alt="dsh-git：把本地 Git 工作台和 GitHub 远端页签一起装进 DeepSeek Harness 的官方右侧栏">
</p>

**把本地 Git 装进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的官方右侧栏**：多仓库下拉、Changes / History 本地操作、Code / Issues / Pull requests / Actions 远端页签，提交信息由 DSH 模型列表里的模型生成。

<p align="center">
  <img src="./assets/readme/Changes.png" width="49%"
       alt="Changes 页签（实机截图）：仓库下拉显示 dsh-git 与 main 分支、工具栏「推送到 origin」的领先进度、六个页签、17 个变更文件的勾选列表、README.md 的逐行 diff，以及底部的提交区（摘要/描述、✨ 生成、提交按钮）">
  <img src="./assets/readme/History.png" width="49%"
       alt="History 页签（实机截图）：左侧提交列表，右上是选中提交的说明、短 sha 与 +/− 统计，下方是该提交改动的文件与逐行 diff">
</p>

## 你会得到

<p align="center">
  <img src="./assets/readme/section-tabs.svg" width="100%"
       alt="六个页签：Changes 文件级暂存与 diff、模型生成提交信息；History 提交历史；Code 远端文件树，无远端时看本地；Issues 列表加详情，可新建、评论、关闭；Pull requests 列表加详情，可新建；Actions workflow runs，可重跑或取消">
</p>

另外这些是所有页签共用的：

- **多仓库下拉** —— 你显式添加过的本地仓库；登录 GitHub 后还能列出你有权限的远端仓库。
- **同步与分支** —— fetch / pull / push；强推只允许 `--force-with-lease`（全库没有裸 `--force`）。分支可切换、新建、重命名，也能检出某个提交（分离头）或 cherry-pick。
- **没有远端也能用** —— Code 页签在本地仓库上退化为本地工作区视图，不是空页；Issues / PR / Actions 需要远端，缺远端时给的是可读说明而不是报错。
- **提交信息交给模型** —— host 半读 diff，走 `ctx.llm` 里你已经在 DSH 配好的任意 provider。
- **设置里能找到它** —— 侧栏「插件」页 ▸「已安装」▸ `@linxueyuan/dsh-git` ▸ 详情页的**配置区**：界面缩放、diff 勾选标记、通知与几个确认开关，外加插件自己的配置文档（Pulls 自动刷新周期）。GitHub Desktop 那几页偏好仍在右侧栏齿轮里。

## 它是怎么做的

<p align="center">
  <img src="./assets/readme/architecture.svg" width="100%"
       alt="一个包两个半边：浏览器半注册官方右侧栏页签、只显示令牌尾 4 位，经仅 loopback 的 /dsh-git/* 路由访问 host 半；host 半用 ctx.subprocess 跑 git、ctx.webServer 注册路由、ctx.credentials 存令牌、ctx.llm 生成提交信息，再连向本地 git 仓库与 GitHub REST">
</p>

一个 npm 包里是两个半边：**浏览器半**只画界面（注册官方右侧栏 tab，本地操作走 `/dsh-git/*`），**host 半**与 dsh 同进程，跑 git、注册路由、保管令牌、调模型。远端页签不直接打 GitHub，而是由 host 半代理，令牌因此从不进入浏览器。

- `/dsh-git/*` 只接受 **loopback** 请求；局域网 / 远程访问一律 403。
- git 只能操作**你显式添加过的仓库**清单里的路径（其他路径返回 `workspace-unknown`）。
- clone 关掉 `protocol.ext.*`。
- 令牌只存在 host，读 / 写 / 日志只有一处：`src/host/credential-bridge.ts`。

## 安装

```bash
# 从 npm 安装(npm 包名是 scoped 的 @linxueyuan/dsh-git)
dsh plugin --profile <profile> add @linxueyuan/dsh-git

# 从本地目录安装(开发态)
dsh plugin --profile <profile> add /path/to/dsh-git
```

注意是 `@linxueyuan/dsh-git` 而不是无 scope 的 `dsh-git`，后者已被他人占位（0.0.1，纯占位包，仓库链接 404）。

安装后重启 DSH 并硬刷新页面（host 半是 Node 模块，不随页面刷新重新加载）。

## GitHub 登录与令牌

两种登录方式：点「登录 GitHub.com」走**设备码**（开箱可用，包内已带 App），或填 **Personal Access Token**（细粒度 Token 要 Contents R / Issues RW / Pull requests RW / Actions RW；经典 Token 用 `repo`）。

> ⚠️ 内置的是 **GitHub App**，要先把它[安装](https://github.com/apps/dsh-git-local/installations/new)到你的账号 / 组织 —— 没装的表现是登录成功但看不到任何仓库。它的用户令牌 8 小时后过期，插件会自动续期。

想换成自己的 App：在 profile 的 `cordis.patch.yml` 里填 `clientId`，或给 `DSH_GIT_CLIENT_ID` 环境变量（写 `off` 关掉设备码登录）。

```yaml
- id: dsh-git
  name: '@linxueyuan/dsh-git'
  config:
    clientId: 'Ov23li…'   # 自己建的 App 的 Client ID
```

令牌只在 host 侧，浏览器只看得到尾 4 位；静止时是**明文 + `0600` 权限**，没有加密。

## 已知边界（M1）

- 远端页签以 GitHub 为准；本地未推送的提交在 Code 树里看不到对应文件。

## 开发

```bash
npm install           # 依赖：esbuild（打包）+ typescript / eslint / sass（闸门）
npm run build         # lib/index.js(host, esm) + lib/client.js(browser, ModuleLoader 包装)
npm run check         # 产物语法检查（node --check）
npm run lint          # ESLint
npm run typecheck     # 类型闸门
npm run check:static  # 一条命令跑齐所有静态闸门（check-all 自动发现并汇总）
```

**CI 只跑发布物**（构建 → 产物语法 → 包可用性：清单自洽、宿主能加载、运行时依赖都已声明、发布内容完整且不含源码）：

```bash
npm run build && npm run check && node scripts/verify-plugin.mjs
```

下面这些闸门是**本地的源码卫生工具**，不在 CI 里 —— 它们盯的是「这个仓库自己怎么写的」，
与「装上能不能用」无关，其中一部分是长期棘轮债：

| 闸门 | 拦下的静默失败 |
|---|---|
| `check-integration` | 产物没跃升 / 镜像不可达 / 类名缺失 |
| `check-generated` | 生成物与源码不同步（`npm run check:generated:rebuild` 会重跑构建逐字节比对） |
| `check-base-recipes` | 类名在、但真正的样式配方不在编译闭包里 |
| `check-scope-roots` | 作用域根在同一条选择器里出现两次 ⇒ 永不匹配 |
| `check-sass-leaks` | 产物里残留未编码的 `$var` ⇒ 浏览器静默丢弃整条声明 |
| `check-unreachable-ancestors` | 规则在，但它要求的祖先元素从不渲染 |
| `check-lint` / `check-types` / `check-scripts-types` | ESLint / 客户端类型 / `scripts/**` 自己的类型 |

退出码契约：`0` = 通过（允许带**已登记**的棘轮债务）、`1` = 有**未登记**缺陷、`2` = 跳过。


## License

[MIT](./LICENSE) · 第三方声明：[THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md)
