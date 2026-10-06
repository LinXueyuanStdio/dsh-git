# 静态闸门(scripts/static-gates.md)

> **这份文档是什么**:`docs/toolchain-adoption.md` §5 里排在最前面的四条**零新依赖**
> 吸收项(第 2/3/4 名 + H4/H12/F2)的落地记录,以及**今天这些闸门的真实读数**。
> 所有数字都是实测(命令与时间见 §5),没有一个是估算。
>
> **为什么是静态闸门而不是测试**:`docs/goal-port-desktop.md` §3 的第一条失败模式是
> 「构建绿什么也不证明」。这个仓库的每一次昂贵返工都是**静默**的:
> 样式配方没进闭包(`.sr-only`)、prop 从没被传(死 prop)、
> 祖先元素从没被渲染(§10.9)、产物与源码不同步(octicons 被砍)。
> 闸门的作用是让这些类**不可能再无声复发**。

---

## 1. 一条命令

```bash
npm run check:static          # = node scripts/check-all.mjs
```

`check-all.mjs` **自动发现** `scripts/check-*.mjs`(除了自己),顺序执行并汇总。
新增一条闸门 = 新增一个 `scripts/check-*.mjs`,**不需要改清单**。

**退出码契约**(每条闸门都遵守,`check-all` 依赖它):

| 退出码 | 含义 |
|---|---|
| `0` | 通过(允许带**已登记**的棘轮债务) |
| `1` | 有**未登记**的缺陷 |
| `2` | **跳过**(输入读不到 / 工具不在)—— `check-all` 记为 SKIP,**不算通过** |

`--json` 的 stdout 一律是**纯 JSON**,警告只走 stderr。任何文件读不到都**警告并跳过,绝不抛异常**
(这棵树会被多条线并发编辑)。

另外两条:

```bash
node scripts/check-generated.mjs --rebuild --write-baseline   # 真正的「干净工作区」闸门(慢)
npm run check:generated:rebuild                              # 同上,不重记清单
```

> 上游的反面教材(`docs/toolchain-adoption.md` E3):Desktop 把 `markdownlint` 写成 npm script
> 却**没接进 `lint` 或 CI**,于是没人跑。**没有闸门的工具 = 没人跑的工具** —— 这就是
> `check-all.mjs` 存在的唯一理由。

---

## 2. 闸门清单

**自动发现集合 = `scripts/check-*.mjs`**(`check-all.mjs` 按名字发现)。下面第一行**不是**
闸门,列出来只为说清它为什么不在集合里。

| 闸门 | 消掉的静默失败类 | 今天的状态 | 基线(棘轮) |
|---|---|---|---|
| `verify-mirror.mjs`(**opt-in 探针**,不是闸门) | 镜像树与上游不一致 | 需要本机 `references/desktop` checkout;拿不到时退出码 **2(SKIP)** | — |
| `check-integration.mjs`(已有) | 产物没跃升 / 镜像不可达 / 类名缺失 | PASS | — |
| `check-base-recipes.mjs` | 类名在、**配方不在**(`.sr-only` 类) | **FAIL(2 条真缺口)** | `base-recipes-baseline.json`(15) |
| `check-scope-roots.mjs`(**新**) | 单条选择器里**作用域根出现 >1 次** ⇒ 永不匹配 | **PASS(0 条)** = 硬门禁 | `scope-roots-baseline.json`(0) |
| `check-sass-leaks.mjs`(**新**) | 产物里残留未编码的 `$var` ⇒ 浏览器静默丢弃整条声明 | **PASS(0 条)** | 无(前瞻性) |
| `check-unreachable-ancestors.mjs`(**新**) | 规则在,但它要求的**祖先元素从不渲染** | **FAIL(42 条新增)** | `unreachable-ancestors-baseline.json`(30) |
| `check-generated.mjs`(**新**) | 生成物与源码**不同步**(codegen 漂移 / 被手改) | **PASS**(两种模式) | `generated-manifest.json` |
| `check-scripts-types.mjs`(**新**) | `scripts/**` 自己的类型错(元级别静默失败) | **FAIL(12 个新增指纹)** | `scripts-types-baseline.json`(116) |
| `check-types.mjs` / `check-lint.mjs`(另两条线) | 客户端类型 / lint | 见 §5 | 各自的基线 |

**为什么镜像探针不能叫 `check-mirror.mjs`**:它的判据是「我们的镜像文件与**上游**逐字节
相同」,所以天然需要一份上游 checkout;而 `.gitignore:221` 把 `/references/` 整个排除
⇒ CI 与任何干净检出里一定没有它。放进自动发现集合只能得到**假绿**(拿不到上游时它以前
打印「上游找不到对应 307」然后**退出 0**)。改名 `verify-*` 后它与 `verify-install.mjs` 同类:
**环境探针**,由人显式调用;拿不到上游时按退出码契约报 2(SKIP)。

**上游样式表已经住在仓库里**:`src/client/scss/upstream/**`(183 个文件,与
`references/desktop/app/styles/**` 逐字节相同)。构建与样式类闸门
(`check-base-recipes.mjs` / `check-scope-roots.mjs` / `check-generated.mjs`)只读它,
**不依赖 `references/` 也不依赖 `vendor/`** —— 两者分别被 `.gitignore:221` / `:224` 排除,
靠它们就是靠假绿。

`.gitattributes`(**新**,零依赖):钉住行尾,保护 `verify-mirror.mjs` 的**逐字节**判据。

---

## 3. 每条新闸门

### 3.1 `check-scope-roots.mjs` —— 作用域根重复 ⇒ 永不匹配

**防什么**:一条选择器里作用域根出现两次,例如

```
.gw-desktop-diff .tab-bar.tabs .gw-desktop-diff .tab-bar-item { … }
```

**机制**:上游 `references/desktop/app/styles/ui/_tab-bar.scss:33,93,127` 写的是
`&.tabs &-item` / `&.switch &-item` / `&.vertical &-item`。在**嵌套 `@import` + 作用域根**
的编译方式下,第二个 `&` 被替换成**完整父选择器(含作用域根)** ⇒ 那条规则要求
「`.tab-bar.tabs` 里面再有一个 `.gw-desktop-diff`」,而我们的 DOM 里没有嵌套的作用域根。

**为什么三道旧守卫全放它过去**:类名都在产物里(覆盖率绿);基础配方那三个选择器是**对的**
(`check-base-recipes` 判 `ok`);CSS 语法合法。又一次「类名存在 ≠ 规则生效」。

**怎么判定**:读编译产物 → 逐条**单选择器**统计 `scripts/styles.mjs` 的 `PORT_SCOPES`
(只读)出现次数,总次数 `>1` 即记一条,按**唯一选择器**聚合(同一条在产物里被复制多次只算一条债)。

**今天**:0 条 —— 另一条线在本轮把编译方式修好了(产物里现在是
`.gw-desktop-diff .tab-bar.tabs .tab-bar-item`,单前缀)。**所以它今天是硬门禁**,
基线是空的 `{"selectors":{}}`;以后一旦复发立刻失败。

**盲区**:只看编译产物,看不到运行期拼出来的类名;理论上「作用域根出现两次」可以是合法的
(某个面真的嵌套在自己里面),今天没有这种面,真出现时应当在基线里写理由而不是放宽判定;
「`& … &` 来源提示」是提示不是证明。

### 3.2 `check-sass-leaks.mjs` —— Sass 变量泄漏进产物(**前瞻性棘轮,今天不响**)

**防什么**:编译产物里残留 `$foo` ⇒ 浏览器**静默丢弃整条声明**。同族的是未定义的 `var()`
(`--gw-mono` 被 4 处使用却从未定义,那些地方一直静默地不是等宽字体;goal 文档 §3 失败模式 10)。

**诚实交代**:这是一条**前瞻性**棘轮,**今天不响**,不是修 bug。

**为什么不能沿用上游**:上游 `references/desktop/script/validate-sass/validate-file.ts:25`
是**裸 `line.indexOf('$')`** ⇒ 注释里提到 `$var` 也判失败。我们产物的注释里大量引用 Sass 变量名
(例如「`$gray-300`:上游 `_repository-list.scss:115` 用它给 `<kbd>` 上边框色」),
沿用会立刻产生一批假报,闸门随即变噪声源被人关掉。

**做法**:先剥 CSS 注释(保留换行,行号仍有效)再扫描;字符串字面量里的 `$` 单独列为**提示**而非失败。
报告同时打印「原始 `$` 数」与「剥注释后的泄漏数」,让脚本自己证明「必须剥注释」这个决定。

**盲区**:`var(--x)` 未定义是**同族但不同**的失败模式,本脚本**不管** —— CSS 里的 `var()`
解析目前仍然无人管(`checkInlineTokens` 只管内联的 `--dsw-alias-*`)。这是一个**已知缺口**。

### 3.3 `check-unreachable-ancestors.mjs` —— 规则在,祖先不在

**防什么**:选择器写成「`X` 之下的 `Y`」,`X` 有规则、配方也在包里,但**祖先 `X` 我们的 DOM 从不渲染**
⇒ 永不匹配。`check-base-recipes.mjs` 按**类名**判定,结构上看不见这一类,所以它落进 `ok` 桶。

**判据**(三步):把选择器按顶层组合子拆开;从主体往前,只沿**后代空格**与**子选择器 `>`** 收集祖先
(遇到 `+`/`~` 停止);祖先要求的**类名与 id**必须能在**渲染树**里发出 —— 渲染树 =
从 `src/client/index.ts` + `src/client/diff-ui.ts` 沿相对 import 可达的模块,
用与 `check-base-recipes.mjs` **同一份** `computeLiveModules` / `collectLiveClasses`
(直接 `import` 那个模块,确保「活跃」只有一份定义)。

**基准真值(§10.9)**:`.seamless-diff-switcher` 的 10 条选择器。⚠️ **注意**:本次落地期间,
另一条线已经**真的把 `<SeamlessDiffSwitcher>` 挂进了 `src/client/desktop-diff.tsx`**
(该文件头部「2026-10 第二轮」),所以**今天这 10 条已经可达,本检查不再对它们报警** ——
这是修复生效的正确表现。证明它会响用的是 `/tmp` 夹具(§6)。

**盲区**:
- 只看类名与 id:祖先由元素名(`dialog`)、属性(`[data-x]`)、`:nth-child` 产生时看不见;
- **可达 ≠ 已渲染**:类名出现在可达模块里就算「能发出」,一个组件可以被 import 却从不被
  `<JSX>` 实例化 —— 这是**漏报方向**(§10.9 的 `.seamless-diff-switcher` 一度正是如此);
- `A B + C` 里 `A` 其实也是 `C` 的祖先,本检查在 `+` 处停止 ⇒ 少报,不会多报。

### 3.4 `check-generated.mjs` —— 生成物与源码不同步 / 干净工作区

**防什么**:codegen 漂移这一整类。上游等价物是一行 CI:
`references/desktop/.github/workflows/ci.yml:73-74` 的 **`git diff --name-status --exit-code`**
(「工作区必须干净」)。本次工具链审计把它列为**性价比最高的一条**(F2)。

**本仓库为什么不能沿用 `git diff`**:只有 3 个文件被 git 跟踪
(`.gitignore` / `LICENSE` / `README.md`),`lib/` 与 `references/` 都在 `.gitignore` 里
⇒ 判据换成**清单(manifest)**:`scripts/generated-manifest.json` 记录 4 个生成物
(**规范化构建时间戳之后**的 sha256)+ 输入摘要(`src/**`、`package.json`、`build.mjs`、`styles.mjs`)。

**动机案例**(`scripts/verify-mirror.mjs` 文件头逐字记录):一个子代理把
`octicons.generated.ts` 从 **379 个符号砍到 11 个**,而**构建绿、4 条检查全过** —— 因为没人 import 它。

**两种模式**:

| 模式 | 做什么 | 何时失败 |
|---|---|---|
| 默认(快) | 只读磁盘,与清单比对 | 生成物**被手改**(输入没变、产物却变了)或**缺失**;输入变了只提示(`--strict` 才失败) |
| `--rebuild`(慢,真闸门) | 记录 hash → 跑 `node scripts/build.mjs` → 再记录 → 要求逐字节一致 | 任何产物被重跑构建改写,或构建退出码非 0 |

**两个关键设计**(都是被现实逼出来的):
1. **时间戳规范化**:`build.mjs` 把 `__BUILD_STAMP__`(ISO 时间)编译进两个 bundle,
   所以「字节一致」必须先把 `YYYY-MM-DD HH:MM:SS` 换成 `<BUILD_STAMP>`;
2. **默认模式区分两种「不一致」**:输入也变了 ⇒ 只是**另一次合法构建**(提示重记清单);
   输入没变、产物却变了 ⇒ **手改**,判失败。不这样分的话,任何一个 lane 正常重建都会让闸门变红,
   它就会因为**正常行为**天天响然后被关掉。
3. `--write-baseline` 在**构建红了的时候拒绝写清单**(可用 `--force` 强行)——
   否则等于把一次坏构建固化成「正确」。

**盲区**:规范化本身是盲区(将来产物里出现别的每次构建都变的内容会误报,方向是吵不是漏);
输入摘要粗粒度(改一个不可达文件的注释也会提示重建,方向是多报);
`--rebuild` 检测到别的构建进程会**跳过**(退出码 2),但两次取样之间启动/结束的构建仍可能造成中间态。

### 3.5 `check-scripts-types.mjs` + `scripts/tsconfig.json` —— 承重脚本自己的类型程序

**防什么**:`scripts/*.mjs` 是承重结构(`check-base-recipes.mjs` 已 1700+ 行 / 60+ 处 JSDoc),
而它们此前**一行类型检查也没有**。一个判错样式的**检查器**会静默放过样式缺陷 —— 这是
**元级别**的静默失败:闸门本身坏了,而「闸门通过」被当成「代码没问题」。

**对应上游**:`references/desktop/script/tsconfig.json`(构建脚本自己的程序)+
`references/desktop/eslint-rules/tsconfig.json`(`allowJs + checkJs`,给用 JS 写的 lint 规则上类型)。
审计见 `docs/toolchain-adoption.md` B2/B3。

**配置**:`scripts/tsconfig.json` —— `allowJs + checkJs + noEmit + strict + types:["node"]`,
**刻意不 extends 根 `tsconfig.json`**(那三个程序由另一条线持有;Desktop 也是「一个程序一个 tsconfig」)。

**棘轮**:首次运行报出既有的 JSDoc 缺口(`implicitly has an 'any' type` 这一类),
一次性还清会阻塞在飞车线 ⇒ 基线把现状钉住,**只拦新增**。指纹刻意**不含行号**
(文件被并发编辑导致行号平移时不误报)。

**本次新增的 6 个脚本零错误**(`gates-lib.mjs` + 5 个闸门),所以新增代码不会让基线长大。

---

## 4. `.gitattributes`(行尾)

保护 `verify-mirror.mjs` 的**逐字节**判据:`* text=auto eol=lf` 让工作区一律 LF,
于是镜像在 macOS/Windows/Linux 上拿到同一份字节。**刻意不**对 `src/core/desktop/**` 用 `-text`
(上游对二进制夹具才那么做)——`-text` 只是关掉转换,一旦有人在 CRLF 工作区提交,CRLF 会原样留下,
而 `eol=lf` 才真正保证 LF。逐行理由写在文件自己的注释里。

---

## 5. 交付时读数(实测)

> ⚠️ 这棵树**同时被 3 条线编辑**(构建、样式/仓库列表、类型)。下面的数字是**某一时刻**的读数
> (2026-10-05 19:4x),并发编辑会让它们变化。每条的完整输出用括号里的命令复现。

| 闸门 | 命令 | 读数 |
|---|---|---|
| `check-scope-roots` | `node scripts/check-scope-roots.mjs` | 扫 665 规则 / 806 选择器 / 4 个作用域根 ⇒ **0** 条作用域根重复(硬门禁通过) |
| `check-sass-leaks` | `node scripts/check-sass-leaks.mjs` | 原始 `$` **27** 个 ⇒ 剥注释后**泄漏 0**、字符串里 0(**27 个全在注释内**) |
| `check-unreachable-ancestors` | `node scripts/check-unreachable-ancestors.mjs` | 渲染树 188 模块 / 352 类 ⇒ **72** 个不可达祖先压着 308 条选择器;**已登记 30,未登记 42** |
| `check-generated`(快) | `node scripts/check-generated.mjs` | 4 个生成物与清单一致 ⇒ PASS |
| `check-generated`(`--rebuild`) | `node scripts/check-generated.mjs --rebuild` | 构建 exit 0 / 11.2s;4 个生成物**逐字节一致**(时间戳已规范化)⇒ PASS |
| `check-scripts-types` | `node scripts/check-scripts-types.mjs` | 覆盖 15 个 `.mjs`;187 条错误 / 114 指纹;基线 116 ⇒ **12 个新增指纹** |
| `check-base-recipes` | `node scripts/check-base-recipes.mjs` | 闭包 42 文件(根 = `PORT_SURFACES` 的并集);`split` **17**(已登记 15)**未登记 2** |
| `check-all` | `node scripts/check-all.mjs` | 10 条闸门:**6 PASS / 4 FAIL / 0 SKIP** |

失败项与原因(全部如实列出,没有一条被粉饰):

| 失败 | 原因 | 归属 |
|---|---|---|
| `check-base-recipes` ×2 | `.label` / `.list-item-tooltip`:见 §6.1 | **本插件**(需要改 `src/client/scss/**`) |
| `check-unreachable-ancestors` ×42 | 新的 Changes 面:见 §6.2 | **另一条线(在飞)** |
| `check-scripts-types` ×12 | `build.mjs` / `styles.mjs` 的新类型错:见 §6.3 | **另一条线(在飞)** |
| `check-types` | 另一条线的客户端类型棘轮 | 另一条线 |

---

## 6. 仍未解决的真实缺口(不是被基线吞掉的)

### 6.1 `check-base-recipes`:2 条真缺口(`.label` / `.list-item-tooltip`)

两条都是**真的**:`src/core/desktop/ui/repositories-list/repositories-list.tsx:208-215` 渲染

```tsx
<div className="repository-list-item-tooltip list-item-tooltip">
  <div><div className="label">Full Name: </div>…</div>
  <div><div className="label">Path: </div>…</div>
```

而它们的配方只写在 `references/desktop/app/styles/ui/window/_tooltips.scss:224-231`
(`.list-item-tooltip > div { display:flex; flex-direction:row; margin-bottom }`、
`.label { min-width:60px; font-weight:bold }`),挂在 `body > .tooltip` 之下,
**不在闭包里**;而且把 `_tooltips.scss` 整个 import 进作用域只会编译出
`.gw-… body > .tooltip`(永不匹配),所以**修法不是在 SCSS 里加一行 import**:
要么在真实祖先下就地补那几条声明(与 `.sr-only` 的 local compensation 同一套路),
要么让 tooltip 的 DOM 落在作用域内。**这需要改 `src/client/scss/**`,不在本次所有权内。**

### 6.2 `check-unreachable-ancestors`:42 个新不可达祖先 = **新的 Changes 面还没接线**

产物里出现了新的移植面 `.gw-desktop-changes`(作用域根之一),以及
`changes-list-container` / `commit-message-component` / `filtered-changes-list` /
`commit-button` / `#undo-commit` / `#continue-rebase` / `#oversized-files` … 这批类。
**但 live 图里没有任何组件产出它们** —— 连作用域根 `.gw-desktop-changes` 本身都发不出来
(它压着 173 条选择器)。也就是说:**样式已经编译进包,渲染方还没挂上** ⇒
那 308 条选择器今天全是死的。这正是 §10.9 那类缺陷在**面级别**的复现。

**没有把它们登记进基线**:它们是**正在进行的接线工作**,不是可接受的债务;
登记等于把另一条线全新的缺口按成「已接受」(与 §7 的纪律直接冲突)。
接线完成后这个数字应当自己掉到 30 以下。

### 6.3 `check-scripts-types`:12 个新增指纹(全是别的线在飞的文件)

`scripts/styles.mjs`(`TS1109 Expression expected`、`TS7006`、2 × `TS2353 afterDedupe`)
与 `scripts/build.mjs`(`TS7006`)。其中 `TS1109` 是 **checkJs 的一个已知陷阱**:
**JSDoc 注释里的裸 `@word` 会被 TS 当成 JSDoc 标签去解析**。
本次在 `check-scope-roots.mjs` 里踩到同一个坑(JSDoc 里写 `@import …` ⇒ `TS1109`),
修法是不要在 JSDoc 里写裸的 `@import`(改写措辞或避免 `…` 紧跟其后)。
**没有把这 12 条写进基线** —— 那正是棘轮要拦的东西。

### 6.4 已知的、**故意**没做的

- `var(--x)` 未定义检查(§3.2 盲区):需要一个「宿主令牌全集」判据,与
  `build.mjs` 的 `checkInlineTokens()` 重叠,建议由那条线统一做;
- 构建产物里的**重复编译**:`desktop-diff.scss` 同时是 `diff` 与 `split` 两个面的入口,
  所以 tab-bar 那一段在产物里出现两遍(本次 scope-root 检查把它暴露出来)。
  不是缺陷,但可以瘦身 —— 属于样式线的取舍;
- lint / prettier / 客户端类型(`check-lint.mjs` / `check-types.mjs`)由另外两条线持有。

---

## 7. 棘轮政策(怎么改基线不算作弊)

1. **只降不升**:基线里的注册数**只能减少**。往基线里加一条 = 宣布「这个缺陷可以接受」,
   必须写清理由(每条基线条目都有 `reason` 字段);
2. **不许为了让闸门变绿而改上游文件**(`docs/goal-port-desktop.md` §2.1 的红线);
3. **不许为了让闸门变绿而重钉基线**:`--write-baseline` 的用途是「首次落地把现状钉住」与
   「修完之后收窄」,不是「把新缺陷按下去」;
4. 基线里出现**已失效**条目(报告里的 `stale`)就删掉 —— 保留它会让棘轮的数字失去意义。

---

## 8. 复现命令汇总

```bash
npm run check:static                                          # 一条命令跑齐(自动发现)
node scripts/check-all.mjs --json                             # 机器可读汇总
node scripts/check-all.mjs --list                             # 只列出会跑哪些闸门

node scripts/check-scope-roots.mjs                            # 作用域根重复
node scripts/check-sass-leaks.mjs                             # $var 泄漏(前瞻性)
node scripts/check-unreachable-ancestors.mjs                  # 祖先不可达
node scripts/check-generated.mjs                              # 生成物同步(快)
node scripts/check-generated.mjs --rebuild --write-baseline    # 干净工作区闸门(慢)
node scripts/check-scripts-types.mjs                          # scripts/** 的 checkJs
```
