# 贡献指南

感谢你愿意花时间。这个仓库的几个约定比较特别（尤其是**产物不提交**和**闸门退出码**两节），
先扫一遍能省下不少来回。

## 环境

- **Node**：`engines` 要求 `^22.19.0 || >=24.0.0`（与宿主 DSH 自己的声明一致）。
- **npm**：任何 10+ 都可以；只有发布相关的事才需要更新版本。
- `npm install` 之后即可开发。运行期的第三方库（zod、react-virtualized、lodash…）都在
  `devDependencies` 里 —— 它们会被 esbuild **打进产物**，所以不是运行时依赖，
  详见 [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md) 里「为什么 package.json 里没有 dependencies」。

## 常用命令

```bash
npm run build                    # 两个半边一起构建 → lib/index.js + lib/client.js
npm run check                    # 产物语法检查（node --check）
npm run lint                     # ESLint
npm run typecheck                # 客户端类型闸门
npm run check:static             # 一条命令跑齐所有静态闸门
npm run check:generated:rebuild  # 重跑构建，逐字节比对生成物（改过生成物来源时用）
```

## 两条容易踩的约定

### 1. `lib/` 不提交，产物靠构建

`lib/` 在 `.gitignore` 里（连同 `docs/`、`design/`、`references/`、`screenshots/` 等）。
所以：

- **克隆下来先 `npm run build`**，否则 `npm run check` 会因为产物不存在而失败；
- 提交前**不要**用 `git add -A`（工作区里可能同时有别的 lane 的改动），
  **不要**用 `git add -f` 强行提交被忽略的目录；
- 发布前必须重新构建：`npm publish` 没有 `prepublish` 钩子，装进包里的就是你磁盘上那一刻的 `lib/`。

### 2. 闸门的退出码是契约

| 退出码 | 含义 |
|---|---|
| `0` | 通过（允许带**已登记**的棘轮债务） |
| `1` | 有**未登记**缺陷 |
| `2` | 跳过（例如检测到并发构建） |

棘轮基线在 `scripts/*-baseline.json`，生成物清单在 `scripts/generated-manifest.json`。

**新增的未登记缺陷必须修，不要往基线里塞。** 基线的用途是记录「已知且已接受」的既有缺口，
其中一部分（如 `check-unreachable-ancestors` 里的接线进度）是**进度条**：把「还没接」登记成
「已接受」会让这条进度条失效。确属可接受时，必须**在基线条目里写清理由**。

> 当前状态：`check-base-recipes` / `check-scripts-types` / `check-unreachable-ancestors`
> 是红的（已登记的遗留债）。这不影响你先提 PR，但**你引入的新条目**会被拦下。

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
  **布局记录的键**。改它会让所有用户已保存的布局孤儿化。显示名是另一回事 ——
  界面上的名字来自 `src/client/index.ts` 的 `TAB_TITLE`（当前是 `git`）。
- **页签标题走「标题席位」**：布局记录会在**打开时**捕获一次标题并写进 `localStorage`，
  所以标题改由 `sidebar.right.pane.tab.title` 席位实时渲染，别改回「定义里给死标题」的写法。
- **README 的 SVG 是确定性的**：系统字体、1200 宽 viewBox、字号有下限（正文 ≥18、
  次要 ≥16，在 900px 渲染宽度下可读），配色是**亮色**且与实机截图一致。改图请重新渲染确认
  （`rsvg-convert -w 1200 hero.svg -o /tmp/x.png`）再看一眼对比度。
- **产物里带 sourcemap**（`lib/*.js.map`，供 DSH 宿主喂给浏览器 devtools），
  但 `files` 是显式清单，**map 不进 npm 包**。这两件事不要弄反。

## 加第三方代码时

- 会被打进产物的库 → 进 `devDependencies`（不是 `dependencies`）；
- 宿主提供的（`@deepseek-ai/*`、`react`、`react-dom`）→ 进 `peerDependencies`，
  客户端那几个标 `optional`；
- 两者都要同步更新 [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md)（该文件里写了清单怎么复现）；
- 改过 `package.json` 的依赖后，跑一次 `npm install --package-lock-only` 让锁同步，
  并确认 diff 里**没有第三方版本漂移**。

## 提交与 PR

- 提交信息用**中文**、conventional 前缀（`feat` / `fix` / `chore` / `docs` / `refactor` / `test` / `perf`）。
  正文写**为什么**，不要复述 diff。
- 提 PR 前请跑：

  ```bash
  npm run build && npm run check && node scripts/verify-plugin.mjs
  ```

  这三步就是 CI 的全部（判的是发布物：构建、产物语法、包可用性）。**源码卫生闸门
  `npm run check:static` 不在 CI 里** —— 它盯的是这个仓库自己怎么写的，其中一部分是
  长期棘轮债，红着也不该拦下 PR；你想跑就跑，跑红了且不是你引入的，在描述里点名即可。
- 不要提交任何令牌、`.credentials.yaml`、个人路径；`GITHUB_TOKEN` 只作为环境变量出现。

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
