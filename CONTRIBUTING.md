# 贡献指南

感谢你愿意花时间。本仓库有两条比较特别的约定（`lib/` 不提交、闸门的退出码），
先扫一遍能省下不少来回。

## 环境

- **Node**：`^22.19.0 || >=24.0.0`。
- **npm**：10 以上即可。
- `npm install` 之后就能开始开发。为什么第三方库大多在 `devDependencies` 里，
  见 [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md)。

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm run build` | 构建两个半边 → `lib/index.js` + `lib/client.js` |
| `npm run check` | 产物语法检查（`node --check`） |
| `npm run lint` | ESLint |
| `npm run typecheck` | 客户端类型闸门 |
| `npm run check:static` | 一条命令跑齐所有源码卫生闸门 |

## 两条容易踩的约定

### 1. 克隆下来先构建


- **克隆下来先跑 `npm run build`**，否则 `npm run check` 会因为产物不存在而失败；
- 提交时**不要**用 `git add -A`（工作区里可能同时有别的改动），
  **不要**用 `git add -f` 强行提交被忽略的目录。

### 2. 闸门的退出码是契约

| 退出码 | 含义 |
|---|---|
| `0` | 通过（允许带**已登记**的棘轮债务） |
| `1` | 有**未登记**缺陷 |
| `2` | 跳过（例如检测到并发构建） |

**你引入的未登记缺陷必须修，不要往基线里塞。** 基线记录的是「已知且已接受」的既有
缺口（其中一部分同时兼作进度条），确属可接受时，要在条目里写清理由。

仓库里有一些长期红着的棘轮债，这**不该拦住你的 PR** —— 只要不是你引入的新条目。

## 代码在哪

| 路径 | 是什么 |
|---|---|
| `src/index.ts` | host 半入口（cordis 插件、配置 schema、接缝装配） |
| `src/host/**` | host 半：git 子进程与解析、HTTP 路由、令牌桥、仓库注册表、同步进度 |
| `src/client/**` | 浏览器半：右侧栏席位注册、各视图、store、样式入口 |
| `src/core/desktop/**` | **与上游 GitHub Desktop 对齐的那一层**（模型 / 组件 / 状态接缝） |
| `scripts/**` | 构建器（`build.mjs`）与全部闸门 |
| `assets/readme/**` | README 的图（确定性 SVG，见下） |

关于 `src/core/desktop/**`：它是对齐上游的一层，改动前请先看
`scripts/verify-mirror.mjs`（它拿上游逐字节比对）以及文件里已有的**出处引用**
（上游文件路径、小节号）。**不要删掉这些引用** —— 保留出处既是 MIT 的要求，也是这类镜像层
唯一可维护的前提。若你的改动让某个文件不再与上游一致，请在提交信息里说明原因。

## 几个不要改坏的东西

- **插件实例 id 保持 `dsh-git`**：它是 profile 里 cordis 行的 `id`，也是右侧栏
  **布局记录的键**。改它会让所有用户已保存的布局孤儿化。界面上的显示名是另一回事
  （来自 `src/client/index.ts` 的 `TAB_TITLE`）。
- **页签标题走「标题席位」**：布局记录会在**打开时**捕获一次标题并写进 `localStorage`，
  所以标题由 `sidebar.right.pane.tab.title` 席位实时渲染，别改回「定义里给死标题」的写法。
- **README 的 SVG 是确定性的**：系统字体、1200 宽 viewBox、字号有下限（正文 ≥18、
  次要 ≥16，在 900px 渲染宽度下可读），配色是**亮色**且与实机截图一致。改图请重新渲染
  （`rsvg-convert -w 1200 hero.svg -o /tmp/x.png`）再看一眼对比度。

## 加第三方代码时

- 会被打进产物的库 → 进 `devDependencies`（不是 `dependencies`）；
- 宿主提供的（`@deepseek-ai/*`、`react`、`react-dom`）→ 进 `peerDependencies`，
  客户端那几个标 `optional`；
- 两者都要同步更新 [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md)（该文件里写了清单怎么复现）；
- 动过依赖后跑一次 `npm install --package-lock-only` 让锁同步，并确认 diff 里
  **没有第三方版本漂移**。

## 提交与 PR

- 提交信息用**中文**、conventional 前缀（`feat` / `fix` / `chore` / `docs` / `refactor` / `test` / `perf`）。
  正文写**为什么**，不要复述 diff。
- 提 PR 前请跑：

  ```bash
  npm run build && npm run check && node scripts/verify-plugin.mjs
  ```

  这三步就是 CI 的全部（判的是发布物：构建、产物语法、包可用性）。**源码卫生闸门
  `npm run check:static` 不在 CI 里**：你想跑就跑，跑红了且不是你引入的，在 PR 描述里
  点名即可。
- 不要提交任何令牌、`.credentials.yaml`、个人路径；`GITHUB_TOKEN` 只作为环境变量出现。

## 发布

发布由维护者手动触发 `.github/workflows/release.yml`；触发方式与注意事项写在 workflow
自己的注释里。发布后把 `CHANGELOG.md` 的 `[Unreleased]` 段落整理成新版本一节。

## 报告问题

用 [issue 模板](.github/ISSUE_TEMPLATE/) 提交，并带上：

- `dsh --version` 的输出（宿主版本）；
- 插件版本（`npm ls @linxueyuan/dsh-git`，或设置卡片上的版本）；
- 操作系统与架构、安装方式（npm 还是本地目录）；
- 复现步骤，以及 host 半的日志片段（**贴之前把令牌、仓库路径、远端地址打码**）。

安全问题请不要开公开 issue，见 [SECURITY 说明](.github/ISSUE_TEMPLATE/config.yml) 里的联系方式。

## 许可

MIT。贡献即表示你同意以同一许可分发；新增第三方代码请一并更新
[THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md)。
