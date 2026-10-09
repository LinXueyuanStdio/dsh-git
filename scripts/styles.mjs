/**
 * 移植面样式表的**声明式注册表**。
 *
 * ## 这个文件解决什么问题
 *
 * 在这之前,「新增一个移植面的样式」意味着去 `scripts/build.mjs` 里改判定逻辑:
 * 加常量、加分支、把编译调用串起来。于是 `build.mjs` 成了所有移植线的**争用热点**
 * —— 同一时刻只允许一个写入者,而每条线都要加样式表。
 *
 * 现在改成**一张表**:加一个移植面 = 加一条 `PORT_SURFACES` 表项(入口 SCSS 已存在,
 * 或同时加一个 `src/client/scss/*.scss`)。`build.mjs` 只负责遍历这张表,
 * **不再是每条线都要碰的文件**。判定的语义:
 *
 *  - 每个移植面的入口 SCSS 在**顶层**编译(**不**把上游 partial 嵌进作用域根),
 *    然后由本模块在**编译产物**上给每条顶层选择器加作用域前缀 ——
 *    见下面「为什么是编译后前缀化,而不是嵌套 `@import`」;
 *  - 编译产物里每条规则都必须落在某个移植面的**作用域根**下,否则**让构建失败**
 *    (白名单来自这张表,不是硬编码的常量);
 *  - 每条选择器里**同一个作用域根不允许出现两次**(双重前缀 = 永不匹配,见下面);
 *  - 每个移植面声明的**基底配方**必须在它自己的作用域下真的出现,否则让构建失败;
 *  - 每个移植面**引用**的 CSS 自定义属性必须在它自己的作用域下**有声明**,否则让构建失败
 *    (未定义的 `var()` 会让整条声明静默失效,goal 文档 §3 失败模式 10)。
 *
 * ## 为什么是「编译后前缀化」,而不是嵌套 `@import`
 *
 * 以前给上游选择器加作用域的唯一手段是把它们嵌进作用域根:
 * `.gw-desktop-diff { @import '.../ui/diff'; }`。它能加前缀,但会**改写 `&` 的语义**
 * —— `ui/_tab-bar.scss:33,93,127` 的 `&.tabs &-item` / `&.switch &-item` /
 * `&.vertical &-item` 里**第二个 `&`** 被替换成**完整父选择器**(含作用域根),产物长成
 *
 *     .gw-desktop-diff .tab-bar.switch .gw-desktop-diff .tab-bar-item { … }
 *
 * 永不匹配。19 条规则(42 条选择器)因此静默失效,而三道旧守卫全绿(类名在、基底配方在、
 * 类覆盖也「覆盖」了)—— 见 `docs/goal-port-desktop.md` §7.1/§10.9。
 *
 * 现在分两步,两步都机械可查:
 *  1. **顶层编译**:入口 SCSS 直接 `@import` 上游 partial,`&` 按上游语义展开
 *     (`&.switch &-item` → `.tab-bar.switch .tab-bar-item`);
 *  2. **产物前缀化**:`prefixTopLevelSelectors()` 给每条顶层选择器加上该面的作用域根,
 *     已带作用域根的选择器不重复加;`@keyframes`/`@font-face` 的块体不动,
 *     `:root` 换成作用域根,`html`/`body` 的前缀插在它们**之后**。
 *
 * ## 为什么需要「基底配方必须出现」这条断言
 *
 * 这是本项目最贵的一次返工(`.sr-only`,见 `docs/goal-port-desktop.md` §7):
 * 上游某个类在**包内**只有一条**覆盖**规则,而真正的基础配方(定位/尺寸/裁剪)
 * 写在另一个**没有被 import** 的 partial 里。三道现有守卫**全都抓不到**:
 * 构建不报错(类名合法);类名覆盖自检查的是「类名**存在**」—— 而它确实存在;
 * 令牌检查只管 `--dsw-alias-*`。三道全绿,界面却是坏的。
 *
 * 所以每个移植面必须**显式列出**「这个面需要哪些基础配方」(`requires`),
 * 由构建**断言它们真的进了编译闭包**。写漏了、或有人把某个 partial 从入口 SCSS
 * 里删掉,构建立刻失败,而不是等用户截图。
 *
 * ⚠️ 声明 `requires` 时,**先 `ls` 核实 SCSS 文件名**。猜文件名在上游是硬错误 ——
 * 上游没有 `_repositories-list.scss` / `_section-list.scss` / `_tooltip.scss` /
 * `_focus-container.scss` / `_aria-live.scss`,正确名分别是
 * `_repository-list.scss` / `_filter-list.scss` / `_list.scss` / `_no-repositories.scss`
 * / `_repository.scss`。
 *
 * ⚠️ **反引号陷阱(同类事故已发生两次,写进这里免得第三次)**:`src/client/styles.ts` 与
 * `src/client/styles-base.ts` 把 CSS 放在**模板字符串**里(`const CSS = \`…\``)。
 * 在那两个文件的 CSS 区段里写 **反引号 —— 包括注释里的反引号** —— 会**提前终止模板**,
 * 随后 esbuild 把 CSS 当 TS 解析,报出与真实原因毫不相干的错(实测:
 * `styles.ts:395:4 ERROR: Expected ";" but found "scss"`,根因只是注释里写了
 * `` `scss/preferences.scss` ``)。构建期 `checkCssTemplate()` 会先报「N 个游离反引号」,
 * 看到那条就先去那两个文件里搜反引号。**在 SCSS 入口里写反引号没有这个问题**
 * (`@import` 的 partial 是 `.scss`,不经过模板字符串);这条只针对 `styles.ts` /
 * `styles-base.ts`。
 *
 * ⚠️ **Sass `expanded` 保留块注释,但会丢掉 `//` 行注释**:长段理由写在
 * 块注释里会**进产物**;而且 **`_dsh-bridge.scss` 是 `@mixin`,它的块注释会被
 * **每个面各复制一份**(2026-10 实测:该文件 4.2KB 源文 ≈ **38KB** 产物 —— 9 个面)。
 * 这是本轮产物瘦身的**大头**:四个入口(四个入口文件)把 55 段整行块注释改成 `//` 后,
 * 产物 **414,491 → 346,796 B(−67,695 B / −16.3%)**。
 * 想留知识又不想让用户下载散文,就用 `//`(2026-10 实测:`_dsh-bridge.scss` /
 * `repository-list.scss` / `desktop-toolbar.scss` / `preferences.scss` 四个文件把
 * 55 段整行块注释改成 `//` 后,产物 **414,491 → 346,796 B,−67,695 B**)。
 *
 * ## 表项字段
 *
 * - `id`         —— 诊断信息里的名字。
 * - `scope`      —— 作用域根选择器(必须以 `.` 开头)。编译产物里所有规则都要落在
 *                   某个 `scope` 之下。
 * - `entry`      —— SCSS 入口文件(仓库相对路径)。**一个面一个入口文件** ——
 *                   两个面共用入口会让同一份样式被编译两遍(产物里每个选择器各出现
 *                   两次),这是「逐字相同的顶层规则只留一份」那条去重出现之前的主要冗余。
 * - `requires`   —— `选择器 → 为什么需要它`。断言该选择器**在本面作用域下存在**。
 *                   只写**这个面渲染路径必然依赖**的配方,不写「好看」的类。
 *
 *                   ⚠️ **语义边界(2026-10 明确记录,别再误解)**:这条断言的语义是
 *                   「**该类名在本面作用域下有一条规则**」,**不是**「该配方完整」。
 *                   反例(实测):`.blankslate` 的真正配方写在
 *                   `styles/_globals.scss:120-128`(应用 globals,任何移植面都没 import),
 *                   而 `requires` 只会证明「`.blankslate` 在作用域下存在」——
 *                   声明通过、配方仍然缺 8 条声明,空态照样不居中/不换底色。
 *                   所以:声明 `requires` 之后**仍要读一遍上游那份配方**,
 *                   缺的部分就地补(与 `.sr-only` 同一处置)。`requires` 守的是
 *                   「配方被去重掉 / 入口漏 import」,守不了「配方只沿用了一半」。
 *
 *                   ⚠️ **严格前缀不算命中(2026-10 修)**:判定要求命中的那个选择器
 *                   部分与键**完全相等**,或键后面紧跟的字符**不是类名 token 的一部分**
 *                   (`-` / `_` / 字母 / 数字)。所以 `.commit-list-item` **不会**因为产物里有
 *                   `.commit-list-item-tooltip` 而通过(那是**另一个类**),
 *                   `.commit-attribution` 也不会因为 `.commit-attribution-component` 而通过 ——
 *                   它们会被判为**假通过**并让构建失败。这条是机械化的:
 *                   假通过会让整面的断言「看起来在守卫、其实没守卫」(§7.1 同族)。
 *                   `.diff-contents-warning` 这类**真**命中不受影响:产物里的形状是
 *                   `.diff-contents-warning:not(:last-child)`,键后面跟的是 `:`。
 * - `usageFiles` —— 类名覆盖率的取样来源。可以是文件,也可以是目录(递归取 .ts/.tsx)。
 * - `usageNote`  —— 这个面在类覆盖统计里扮演什么角色(给人看)。
 * - `bootstrap`  —— 这个面在**运行时**怎么被装进 DOM(给人看;不是机械检查)。
 *
 * ## 加一个新移植面的步骤
 *
 * 1. 写入口 SCSS:`src/client/scss/<name>.scss`,**顶层** `@import` 上游 partial
 *    (需要变量桥/共用配方就顶层 import `dsh-bridge` / `sr-only-recipe`),
 *    自己手写的适配层写进 `.<scope> { … }` 块;
 * 2. 在 `PORT_SURFACES` 里加一条表项 —— **只加表项,不用碰 `build.mjs`**;
 * 3. 跑 `node scripts/build.mjs` —— 作用域外溢、双重前缀、配方缺失、变量未绑定
 *    都会在构建期报出来。
 *
 * (2026-10 实测:加 `.gw-desktop-changes` 那一面就是这么加进去的 —— 一个入口文件 +
 *  一条表项,判定逻辑一行没动。变量的绑定写在入口 SCSS 里,注册表不用逐条列举。)
 *
 * @module dsh-git/scripts/styles
 */

import { readdirSync } from 'node:fs';
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import * as sass from 'sass';

/** 生成的浏览器端样式模块(路径刻意不变:`check-integration.mjs` 也读它)。 */
export const STYLE_MODULE = 'src/client/desktop-diff-styles.generated.ts';

/**
 * 移植过来的 Desktop 样式表编译成的 CSS 字符串常量名。
 * 名字带 DIFF 是历史原因(第一个移植面是 diff);现在它是**所有**移植面的合并产物。
 */
const CSS_EXPORT_NAME = 'DESKTOP_DIFF_CSS';

/**
 * 产物里允许出现的**顶层作用域根**清单。**顺序 = CSS 输出顺序**。
 *
 * 语义(2026-10 明确):这张表 = 「产物里允许以哪些作用域根开头的顶层选择器」+
 * 「每个根由哪个入口 SCSS 产出」。绝大多数表项是**移植面**(根是上游 DOM 的类);
 * 少数是**我们自己的 DOM 标记类**(如 `.tooltip-host` 是 portal 宿主、`.gw-pop` 是
 * 本插件弹层)—— 它们同样必须是**具名的字面量**,白名单之外任何顶层选择器照旧让构建失败。
 * @type {ReadonlyArray<{
 *   id: string, scope: string, entry: string,
 *   requires: Readonly<Record<string, string>>,
 *   scopeNote?: string,
 *   portalHost?: boolean,
 *   usageFiles?: ReadonlyArray<string>, usageNote?: string, bootstrap?: string,
 * }>}
 *
 * - `scopeNote`   —— 这个作用域根**为什么可以是一个隔离边界**(给人看;白名单项必须写理由)。
 * - `portalHost`  —— 作用域元素是 `ReactDOM.createPortal` 的宿主(= 浮层的直接父节点)。
 *                   置真时变量断言切到**严格**模式:自定义属性只能声明在作用域元素**自己**
 *                   身上(声明在兄弟子树上浮层继承不到)。
 */
export const PORT_SURFACES = [
  {
    id: 'diff',
    scope: '.gw-desktop-diff',
    entry: 'src/client/scss/desktop-diff.scss',
    requires: {
      '.side-by-side-diff-container': 'diff 的根容器;缺它 react-virtualized 的 AutoSizer 算不到高度',
      '.side-by-side-diff': '虚拟列表本体',
      '.row': 'diff 行;缺它每行不再是 flex 行,行高会错',
      '.line-number': 'gutter 里的行号格',
      '.content': '行内容格',
      // 注意:上游把这条写成**复合**选择器 `.row.hunk-info`,所以这里声明的是
      // `.row` 的修饰类的实际形状 —— 断言的是「这个复合形状在作用域下存在」。
      '.row.hunk-info': 'hunk 头行(上游是复合选择器,不是独立的 .hunk-info)',
      '.no-newline-indicator': '「No newline at end of file」提示',
      '.panel': '空态/二进制/大 diff 面板(来自 _panel.scss)',
      '.image-header': '图片 diff 的表头(来自 _diff.scss)',
      '.diff-contents-warning': '大文件警告条',
      '.path-label-component': 'DiffHeader → PathLabel 的根(上游 `_path-label.scss:1`)。' +
        '缺它 `PathText` 拿不到 `display:flex;flex-grow:1;min-width:0`,表头里的长路径' +
        '既不会截断、也量不到可用宽度(2026-10-08 随 Changes 头部改用镜像 `DiffHeader` 新增)',
      '.path-text-component': '路径文本本体(上游 `_path-text.scss:3`)。镜像 `PathText` 的' +
        '截断算法按**这个盒子量出来的宽度**算字符预算(`ui/lib/path-text.tsx:396-404`)',
      '.button-component': 'Button 原语(来自 _button.scss)',
      '.popover-component': 'Popover 原语(来自 _popover.scss)',
      'svg.octicon': 'Octicon 图标基底(来自 _octicons.scss)',
      '.sr-only': '读屏专用文本的**基础配方**;缺它会让 "Lines N to M Added" 变成可见文本,' +
        '把行号格撑开、gutter 竖着堆叠(goal 文档 §7,本项目最贵的一次返工)',
    },
    usageFiles: [
      'src/core/desktop/ui/diff',
      'src/core/desktop/ui/lib/button.tsx',
      'src/core/desktop/ui/lib/link-button.tsx',
      'src/core/desktop/ui/lib/popover.tsx',
      'src/core/desktop/ui/lib/tooltip.tsx',
      'src/core/desktop/ui/lib/loading.tsx',
      'src/core/desktop/ui/octicons',
    ],
    usageNote: '类名覆盖率的主体(历史上是 100 个类名的来源)',
    bootstrap: 'src/client/desktop-diff.tsx 引入 desktop-diff-styles.generated.ts,再渲染 DesktopDiff',
  },
  {
    id: 'split',
    scope: '.gw-split',
    /*
     * 入口从 `desktop-diff.scss` 拆成 `split.scss`(2026-10):两个面共用入口会让
     * 同一份样式被编译两遍,产物里每个选择器各出现两次(约 80KB 纯冗余)。
     * 现在「一个面 = 一个入口文件」,而那两遍里的第二遍**在源头就没有了**。
     */
    entry: 'src/client/scss/split.scss',
    requires: {
      '.resizable-component': '可拖拽分隔条的容器(上游 _resizable.scss)',
      '.resize-handle': '手柄本体',
      '.sr-only': 'AriaLiveContainer 的 className="sr-only";缺配方时拖拽宣告会以可见文本挤进左栏',
    },
    usageNote: '与 diff 面同属「两栏 + diff 面板」这条路径,类覆盖由 diff 面负责,不重复取样',
    bootstrap: 'src/client/changes-view.tsx / history-view.tsx 用 Resizable 包住左栏',
  },
  {
    id: 'repository-list',
    scope: '.gw-repo-list',
    entry: 'src/client/scss/repository-list.scss',
    requires: {
      '.repository-list': '仓库列表的根(上游 _repository-list.scss)',
      '.repository-list-item': '一行仓库(29px 行高)',
      '.filter-list-group-header': '组头(Recent / owner login)',
      '.filter-list': 'FilterList 的列表容器(上游 _filter-list.scss)',
      '.filter-list-filter-field': '过滤输入框那一行',
      '.no-results-found': '空态(「找不到这个仓库」)',
      '.no-items': '空态容器',
      '.blankslate-image': '空态插图',
      '.kbd-shortcut': 'ProTip 里的快捷键块',
      '.new-repository-button': '「Add ▾」按钮',
      '.button-component': 'Button 原语(来自 _button.scss)',
      '.text-box-component': 'TextBox 原语(来自 _text-box.scss)',
      '.checkbox-component': 'Checkbox 原语(来自 _checkbox.scss;列表行的勾选列)',
      '.row-component': 'Row 原语(来自 _row.scss;过滤行用它包输入框)',
      '.popover-component': 'Popover 原语(来自 _popover.scss)',
      'svg.octicon': 'Octicon 图标基底(来自 _octicons.scss)',
      '.sr-only': 'TooltippedContent 在溢出时会渲染 sr-only 提示;缺配方会变成可见文本',
      /*
       * 这里**刻意没有** `.hoverable` / `.selected`。
       * 我一度把它们写进 requires,实测产物里 **0 条**(164 条选择器里一条都没有):
       * 它们是 `filter-list.tsx` 在 JS 里按状态拼出来的类,而
       * `_repository-list.scss` / `_filter-list.scss` **都没有**为它们写规则
       * (上游的 `.hoverable` / `.selected` 规则属于 `_list.scss` 的
       * `.list-item` / `.list-focus-container` 家族,不在本闭包)。
       * 声明一个产物里根本不存在的类,只会让构建永远红 —— 那是假的守卫。
       * 真接线后如果发现这两条状态没样式,那是**新的缺口**,应该单独修,不要在这里假装已经守住。
       */
    },
    usageFiles: [
      'src/core/desktop/ui/repositories-list',
      'src/core/desktop/ui/lib/filter-list.tsx',
      'src/core/desktop/ui/lib/section-filter-list.tsx',
      'src/core/desktop/ui/lib/list',
      'src/core/desktop/ui/lib/text-box.tsx',
      'src/core/desktop/ui/lib/checkbox.tsx',
      'src/core/desktop/ui/lib/row.tsx',
      'src/core/desktop/ui/lib/tooltipped-content.tsx',
      'src/core/desktop/ui/lib/highlight-text.tsx',
    ],
    usageNote: '仓库列表 + 它直接渲染的原语',
    bootstrap:
      'src/client/repo-bar.tsx 的 RepoPopover 渲染 <div className="gw-pop gw-repo-pop">,' +
      '面板必须在 .gw-header 内部(position:relative 的包含块),不能再套 inset:0 覆盖层',
  },
  {
    id: 'changes',
    scope: '.gw-desktop-changes',
    entry: 'src/client/scss/desktop-changes.scss',
    /*
     * 这一面是 2026-10 加的,机械证据:`desktop-diff.scss` 的 14 条 `@import` 里没有
     * `ui/changes`,于是上游 `ui/changes/**` 8 个 partial 从来没进过闭包,而
     * `src/client/styles.ts:546-611` 是「照 Desktop 数值手写」的。加这一面**只需要**
     * 「一个入口 SCSS + 一条表项」——判定逻辑一行没动(这就是注册表的契约)。
     *
     * `requires` 只写**上游 `ui/changes/**` 自己定义**的类:本面还没有渲染方
     * (Changes 容器仍是手写的 `changes-view.tsx`),`ui/changes/**` 的组件接线时会
     * 再渲染一堆原语(button/octicons/text-box/checkbox/row/popover/list/dialog),
     * 那些 partial 不在本入口闭包内 —— 缺口清单写在 `desktop-changes.scss` 的开头。
     */
    requires: {
      '.changes-list-container': 'Changes 文件列表的根(上游 `changes/_changes-list.scss:8`)',
      '.changes-list-check-all': '列表头的全选(上游 `_changes-list.scss`)',
      '.filter-popover': '「Filter changes」气泡(上游 `_changes-list.scss`)',
      '.hidden-changes-warning': '「有改动被隐藏」告警条(上游 `_changes-list.scss:257`)',
      '.no-changes-filtered': '过滤后空态(上游 `_changes-list.scss:278`)',
      '.changes-interstitial': '空态插页(上游 `changes/_changes-interstitial.scss:1`)',
      '.commit-message-component': '提交区本体(上游 `changes/_commit-message.scss:4`)',
      '.commit-warning-component': '提交告警(上游 `changes/_commit-warning.scss:3`)',
      '#undo-commit': '提交后的撤销条(上游 `changes/_undo-commit.scss:1`,**id** 选择器)',
      '#oversized-files': '超大文件告警(上游 `changes/_oversized-files-warning.scss:1`,**id** 选择器)',
      '.ref-component': '分支名 chip(来自 `ui/_ref.scss`;`no-changes.tsx` 就在本面渲染它)',
      'svg.octicon': 'Octicon 图标基底(`ui/_octicons.scss`;告警条的三角图标靠它才有 fill)',
      '.link-button-component': '`LinkButton` 本体(`ui/_button.scss`;告警条的「调整筛选」链接靠它)',
      /*
       * 2026-10-09:提交表单的 **作者输入框(co-author)与自动补全**。
       *
       * 镜像件 `ui/lib/author-input/author-input.tsx` 与
       * `ui/autocompletion/user-autocompletion-provider.tsx` 进活跃图之后,
       * `ui/_author-input.scss` / `ui/_autocompletion.scss` 才是它们的配方来源,而这两个
       * partial **此前不在任何面的闭包里** ⇒ `.author-input-component` / `.shadow-input` /
       * `.added-author-container` / `.user` 一直躺在 `check-base-recipes` 的**未登记 split**
       * 桶里(类名在、基础配方在闭包外)。
       *
       * 修法两步缺一不可:
       *   1. 入口 `src/client/scss/desktop-changes.scss` 顶层 `@import` 这两个 partial
       *      —— 把配方**真的带进编译产物**;
       *   2. 在这里逐条登记 —— 把「它必须在**本面作用域下**存在」变成**构建期断言**。
       *
       * 只做第 1 步,缺口就从「有闸门报的 split」退化成「没人守卫」;只做第 2 步则产物里
       * 没有那些规则,本闸门立刻红。两条要一起改。
       */
      '.author-input-component': '作者输入框本体(上游 `ui/_author-input.scss:3`);提交表单的 co-author 输入走它',
      '.shadow-input': '输入框的隐形量宽副本(上游 `_author-input.scss:21`;`@include textboxish` + `position:absolute`)',
      '.added-author-container': '已添加作者的容器(上游 `_author-input.scss:29`,配方只有 `display:contents`)',
      '.autocompletion-container': '自动补全容器(上游 `ui/_autocompletion.scss:3`;`autocompleting-text-input.tsx` 渲染)',
      '.autocompletion-popup': '自动补全弹层(上游 `_autocompletion.scss:14/18`;宽度由 `.emoji`/`.user`/`.issue` 修饰)',
      '.autocompletion-item': '自动补全里的一项(上游 `_autocompletion.scss:61`)',
      '.user': '自动补全里的用户行(上游 `_autocompletion.scss:133`;由 `user-autocompletion-provider.tsx:240` 渲染)',
    },
    /*
     * 刻意**没有** usageFiles:本面还没有渲染方,「实际用到的类名」没有取样来源。
     * 等上游 Changes 容器接线时再把 `src/core/desktop/ui/changes/**` 与它渲染的原语
     * 加进来 —— 那时类覆盖的分母会变大,新增缺口应当同时登记进 `CLASS_EXCEPTIONS`,
     * 而不是让它静默稀释数字。
     */
    usageNote: '尚未接线(Changes 容器仍是手写的 changes-view.tsx),所以不参与类覆盖取样;' +
      '本面进包与否由 `requires` + 「抽样类名 > 0」核对',
    bootstrap:
      '⚠️ **2026-10 更正:作用域根已经存在** —— `src/client/changes-view.tsx:202` 的视图根加了 ' +
      '`gw-desktop-changes`(该处有 §10.9 说明:为什么它不是「假祖先」、碰撞审计、退役条件)。' +
      '在此之前**这一面的规则一条都打不到节点**,实测后果:`.hidden-changes-warning` 退化成一行裸文字 ' +
      '+ 一条 UA 蓝色下划线链接(背景透明、无内边距/边框、图标纯黑)。' +
      '上游 `ui/changes/changes.tsx` 真正接线后,应删掉那个手加的根',
  },
  {
    /*
     * ## 顶栏面(2026-10 落地:入口由顶栏/分支泳道准备并验证)
     *
     * `src/client/toolbar.tsx` 最外层是 `<div className="gw-toolbar tooltip-host">`(第二步换独占类之后是 `gw-app-toolbar`),
     * 里面是上游 `ui/toolbar/toolbar.tsx` 的 `#desktop-app-toolbar` 三段布局
     * (仓库下拉 / 分支下拉 / 推送段),面板内容走 `src/client/branches-view.tsx` →
     * 上游 `ui/branches/branch-list.tsx`。下拉浮层由 `ui/toolbar/dropdown.tsx:430-443`
     * **就地**渲染 `#foldout-container > .overlay + .foldout`(不是 portal),所以它
     * 落在这个作用域里 —— 这一面的浮层规则真的能匹配(§7 的判据)。
     *
     * ⚠️ **作用域根是顶栏独占类 `.gw-app-toolbar`,不是共用类 `.gw-toolbar`**
     * (2026-10 第二步已落地;第一步的 `.gw-toolbar` + `:has()` 中和已删除)。
     *
     * 为什么不能用 `.gw-toolbar`:它也被 `src/client/{history,issues,pulls,actions}-view.tsx`
     * 用(插件外壳),`styles.ts:118` 给它 `padding:7px 12px` / `align-items:center` /
     * `justify-content:space-between` / `gap:8px` / `flex-wrap:wrap`。顶栏最外层挂它
     * 就多出一层带内边距的 flex 容器 —— 真 Chrome 实测 `#desktop-app-toolbar` 的
     * x/y = **12/7**(上游 **0/0**)、包装层高 **64**(上游无此元素)。
     * 换独占类之后实测 **x=0 / y=0、620×50、display:flex;row**(包装层 51 = 50 + 1px 边框)。
     *
     * ⚠️ **这是一对跨文件改动,不能只改一半**:`src/client/toolbar.tsx` 的最外层类名与
     * 本表项的 `scope` 必须同时成立 —— tsx 改了而这里没改(或反过来),本面**一条规则都
     * 匹配不到**(实测过一次:tsx 还是 `gw-toolbar` 时切 scope,`#desktop-app-toolbar`
     * 退化成 `display:block` 288px、按钮 250×78 竖排,`check-unreachable-ancestors` 里
     * `.gw-app-toolbar` 压了 185 条选择器)。改这一对时请**一次做完并复验**。
     */
    id: 'toolbar',
    scope: '.gw-app-toolbar',
    scopeNote:
      '`src/client/toolbar.tsx` 最外层那个 div 上的**顶栏独占**类(我们自己的 DOM 标记;' +
      '不再复用共用类 `.gw-toolbar`,理由见上一条注释),同时是 `.tooltip-host` —— ' +
      '顶栏 Toolbar/ToolbarButton 的 Tooltip 由 `ui/lib/tooltip.tsx` portal 到最近的 ' +
      '`.tooltip-host`,变量声明必须落在这个元素自己身上,浮层才继承得到。',
    entry: 'src/client/scss/desktop-toolbar.scss',
    portalHost: true,
    requires: {
      '#desktop-app-toolbar': '顶栏容器(上游 `ui/toolbar/_toolbar.scss:4`);它才是给顶栏 50px 高度与三段布局的那条规则',
      '.toolbar-button': '两行结构 `.text > .description + .title`(上游 `ui/toolbar/_button.scss:1`);缺它三个下拉只剩裸按钮',
      '.toolbar-dropdown': '下拉外壳与 chevron(上游 `ui/toolbar/_dropdown.scss:1`)',
      '.ahead-behind': '推送段的 ↑N/↓N 徽标(上游 `ui/toolbar/_toolbar.scss:84`;验收目标里点名要的 badge)',
      '.push-pull-dropdown-item': '同步下拉的菜单项(上游 `ui/toolbar/_push-pull-button.scss:8`)',
      '#foldout-container': '下拉浮层的容器(上游 `ui/_foldout.scss:1`;定位由 `dropdown.tsx` 的行内 style 给)',
      '.foldout': '浮层本体(同上;背景与 z-index 来自这一面)',
      '.overlay': '浮层遮罩(同上;点它关闭下拉)',
      '.branches-container': '分支面板的根(上游 `ui/_branches.scss:3` 的 `height:100%/flex/width:365px` 契约)',
      '.branches-list': '上游 `BranchList` 的列表本体(class 由 `branch-list.tsx` 给)',
      '.branches-list-item': '一行分支(上游 `ui/_branches.scss:36`)',
      '.filter-list': '`SectionFilterList` 的过滤与分组(上游 `ui/_filter-list.scss`)',
      '.list': 'react-virtualized 行容器(`ui/_list.scss`;缺它分支行没有行高/滚动)',
      '.text-box-component': '过滤输入框原语(上游 `ui/_text-box.scss`)',
      '.button-component': 'Button 原语(上游 `ui/_button.scss`)',
      '.popover-component': 'Tooltip 浮层原语(上游 `ui/_popover.scss`)',
      'svg.octicon': 'Octicon 图标基底(上游 `ui/_octicons.scss`)',
      '.sr-only': '可达性文本的基础配方(`BranchListItem` 的 tooltip 副本);缺它会变成可见文本',
    },
    usageFiles: [
      'src/client/toolbar.tsx',
      'src/client/branches-view.tsx',
      'src/core/desktop/ui/toolbar',
      'src/core/desktop/ui/branches',
    ],
    usageNote:
      '顶栏三段 + 分支面板。类覆盖的分母从这里取样:上面这些类名都来自**上游**文件,',
    bootstrap:
      '`src/client/workbench.tsx` 渲染 `<WorkbenchToolbar>`;它输出 ' +
      '`.gw-toolbar > #desktop-app-toolbar > .sidebar-section + .toolbar-dropdown ×2 + .toolbar-button`,' +
      '下拉打开时由 `ui/toolbar/dropdown.tsx` 渲染 `#foldout-container`(position:fixed)。',
  },
  {
    /*
     * ## History 面(2026-10 落地:入口由 History 泳道准备并验证)
     *
     * `src/client/history-view.tsx` 现在渲染的是**上游 `ui/history/**` 的组件**
     * (`CommitList` → `CommitListItem`、`ExpandableCommitSummary`、`FileList` →
     * `CommittedFileItem`)加上上游 `ui/diff/diff-header.tsx`,而
     * `references/desktop/app/styles/ui/history/**` 的 partial 此前**从来没进过任何
     * 作用域面的闭包** —— `desktop-diff.scss` 只 import 了 diff 那几张表。所以不建这一面,
     * 这些组件会**有 DOM、没样式**(用户截图里提交摘要竖着堆叠的直接原因)。
     *
     * 入口 `src/client/desktop-history.scss` **刻意不搬进 `src/client/scss/`**:
     * 它按 `src/client/` 这一层的相对路径写(`../../references/…`、`scss/dsh-bridge`),
     * 搬动要改 27 处 import 路径,收益为零、风险非零。注册表的 `entry` 是**仓库相对路径**,
     * 不要求在 `scss/` 下 —— 一个面一个入口文件这条契约不涉及目录。
     *
     * 为什么是逐条 import 而不是上游聚合表 `ui/_history.scss`:见入口文件头 ——
     * `history/_commit-summary.scss` 是 goal 文档 §1.3 点名的死代码
     * (`#commit-summary` 系列无渲染者),import 它只会给
     * `check-unreachable-ancestors` 添一批「祖先从不渲染」。
     */
    id: 'history',
    scope: '.gw-desktop-history',
    scopeNote:
      '适配层写在 src/client/history-view.tsx 最外层 div 上的类,不是上游类名。',
    entry: 'src/client/desktop-history.scss',
    requires: {
      '#history': 'History 页签的根(上游 selected-commits.tsx:310);缺它 flex 列布局不成立',
      '#commit-list': '提交列表容器(上游 commit-list.tsx:585)',
      '.commit': '一行提交的**真实类名**(上游 `history/_commit-list.scss:100` 的选择器是 `#commit-list .commit`)' +
        '—— 不是 `.commit-list-item`:那个类名在上游样式表里**不存在**(组件 `commit-list-item.tsx:150` 渲染的是 `className="commit"`)',
      '.commit-indicators': 'tag / unpushed 角的外框',
      '.unpushed-indicator': '↑ 未推送角',
      '.tag-name': 'tag chip',
      '.AvatarStack': '头像栈(上游 _avatar-stack.scss:1)',
      '.avatar': '单个头像',
      '.commit-attribution-component': '作者归属行(上游 `_commit-attribution.scss:3` 的真实类名;' +
        '组件 `lib/commit-attribution.tsx:44` 渲染它。`.commit-attribution` 只是外层宿主 div 的类,上游没为它写规则)',
      '#expandable-commit-summary': '提交摘要根',
      '.ecs-meta': '摘要的 meta 行(+N −M / 作者 / 标签)',
      '.lines-added': '增加行数',
      '.lines-deleted': '删除行数',
      '.commit-details': '「文件列表 | diff」两栏容器(上游 _commit-details.scss:3)',
      '.file-list-header': '「N changed files」那一行',
      '.file-list': '变更文件列表(上游 history/_file-list.scss:2)',
      '.fill-window': '空提交的占位',
      '.resizable-component': '内层分隔线(上游 _resizable.scss:1)',
      '.diff-container': 'diff 列(上游 _diff.scss:899)',
      '.header': 'DiffHeader 的根(上游 _diff.scss:906 要求 .diff-container 是它的祖先)',
      '.path-label-component': 'PathLabel(文件列表行与 diff 头部)',
      '.path-text-component': '路径文本的**真实配方类**(上游 `_path-text.scss:3`;' +
        '`lib/path-text.tsx:342` 渲染它)。严格前缀判定落地时发现旧键 `.path-text` 是**假通过**:' +
        '产物里只有 `.path-text-component`,而组件另外渲染的那个 `.path-text`(path-text.tsx:351)上游没有任何规则',
      '.button-component': 'Button / CopyButton / LinkButton 原语',
      'svg.octicon': '图标基底',
      '.list': '两个列表的本体(上游 _list.scss:1)',
      '.list-item': '列表行',
      '.panel': '空态面板',
      '.blankslate': '空态内容',
      '.diff-options-component': 'diff 齿轮弹层',
      '.checkbox-component': '弹层里的复选框',
      '.radio-button-component': '弹层里的统一↔并排单选',
      '.popover-component': '弹层宿主',
      '#commit-drag-element': '提交拖拽幽灵(上游 drag-elements/_commit-drag-element.scss:1)',
      '.emoji': 'RichText 的 emoji 占位',
      '.sr-only': '读屏文本配方;缺它会变成可见文本(goal §7)',
      '#multiple-commits-selected': '多选提交空态',
    },
    usageFiles: [
      'src/client/history-view.tsx',
      'src/core/desktop/ui/history',
      'src/core/desktop/ui/lib/avatar.tsx',
      'src/core/desktop/ui/lib/avatar-stack.tsx',
      'src/core/desktop/ui/lib/commit-attribution.tsx',
      'src/core/desktop/ui/lib/path-label.tsx',
      'src/core/desktop/ui/lib/path-text.tsx',
      'src/core/desktop/ui/diff/diff-header.tsx',
      'src/core/desktop/ui/diff/diff-options.tsx',
      'src/core/desktop/ui/copy-button.tsx',
      'src/core/desktop/ui/drag-elements/commit-drag-element.tsx',
      'src/core/desktop/ui/resizable/resizable.tsx',
      'src/core/desktop/ui/lib/list',
    ],
    usageNote: 'History 页签 + 它渲染的上游组件(提交列表/摘要/文件列表/diff 头部)',
    bootstrap: 'src/client/history-view.tsx 的最外层 <div className="gw-pane gw-desktop-history tooltip-host">',
  },
  {
    /*
     * ## 为什么 `.tooltip-host` 是一条**具名**作用域根(不是放宽白名单)
     *
     * 上游 Tooltip 的浮层由
     * `ReactDOM.createPortal(…, target.closest('.tooltip-host') ?? document.body)`
     * 挂出去(`ui/lib/tooltip.tsx:838-839`),所以浮层节点**不在触发点所在的作用域
     * 子树里**。上游 `ui/window/_tooltips.scss:1-2` 的入口选择器是
     * `body > .tooltip, .tooltip-host > .tooltip` —— 把它整体套上任何移植面的作用域根
     * 都**永不匹配**(浮层只能是透明裸文本,`.list-item-tooltip`/`.label` 那两条
     * 一直红的基底配方缺口就是它)。
     *
     * `.tooltip-host` 是**我们自己写在 DOM 上的标记类**(`repo-bar.tsx:63` 的
     * `.gw-header.tooltip-host`;`dialog.tsx:928` 的对话框同样带),不是上游类名。
     * 作为一条具名表项进注册表:白名单只多出**这一个字面量**,而且这一面的每条规则
     * 仍必须落在它里面(`findForeignScopedSelectors`),`body`-rooted 规则照旧让构建
     * 失败 —— 宿主 DSH 页面已 grep 确认没有同名类。
     */
    id: 'tooltips',
    scope: '.tooltip-host',
    scopeNote:
      '我们自己的 DOM 标记类(portal 宿主 = `tooltipHostFor()` 的返回值),不是上游类名。' +
      '具名白名单项,不放宽白名单:规则必须落在 `.tooltip-host` 里。',
    entry: 'src/client/scss/tooltips.scss',
    /*
     * `portalHost: true` —— 作用域元素**就是**浮层的直接父节点,于是:
     *   · 变量断言切到**严格**模式:自定义属性必须声明在**作用域元素自己**身上
     *     (声明在同级的兄弟子树上,浮层继承不到);
     *   · 上游那条裸入口选择器 `.tooltip-host > .tooltip` 才会原样留下。
     */
    portalHost: true,
    requires: {
      '.list-item-tooltip':
        '仓库行的 hover 提示(上游 `_tooltips.scss:224`);`check-base-recipes` 里' +
        '一直红的那个 split 桶就是这两条',
      '.label': '提示里的「Full Name: / Path:」标签列(`_tooltips.scss:231`)',
    },
    usageNote:
      'portal 宿主面:不参与类覆盖取样(浮层的类名由 `ui/lib/tooltip.tsx` 与 ' +
      '`repositories-list.tsx` 给,已在 CLASS_EXCEPTIONS 里逐条登记)',
    bootstrap:
      '`src/client/workbench.tsx` 的 <div className="gw-body tooltip-host">(**复用既有元素、不新增包裹层**,' +
      '避免 §11.1.1 的包裹层几何陷阱)。修复前有 2 个触发点(Changes 的 hunk 手柄 `Expand Down` 与 ' +
      '`.gw-desktop-diff`)portal 到 `document.body` 而拿不到这一面 ⇒ 浮层 0 条规则匹配、`position:static`,' +
      '落在视口外 ⇒ 正是用户报的「hover 没出来」。实测现在 body-based = 0',
  },
  {
    /*
     * `.gw-pop` 是**我们自己的**弹层类(不是上游类名)。这一面存在的唯一理由:
     * `styles.ts:358` 的 `.gw-pop{max-width:420px}` 会把 >420px 的左栏夹回去,而宽度
     * 真值由 `repo-bar.tsx` 的行内 `--gw-pop-width` 给(`useLeftWidth()`)。
     * 留在产物这一面而不是挪回 styles.ts:同特异性下胜负只由注入顺序决定
     * (`index.ts:78-79` 先 `ensureStyles()` 后 `ensureDesktopDiffStyles()`),
     * 写在这里是**确定性**的。
     */
    id: 'pop-width',
    scope: '.gw-pop',
    scopeNote:
      '我们自己的弹层类;作用域根只用于让这一行合法进产物并被逐面归属断言管住,不是上游移植面。' +
      '⚠️ **2026-10 起本面已失效,退役待批**:`--gw-pop-width` 的唯一写入方是仓库下拉面板的行内 style,' +
      '而那个面板已从「`.gw-pop` 卡片」改成「foldout 本身」⇒ 本面的 `.gw-pop{width:var(--gw-pop-width,auto)}`' +
      '再也打不到任何写这个变量的元素。其余 `.gw-pop` 使用者(`MenuPopover` 的 `.gw-pop.right`、设置弹层)' +
      '从不写它。**退役条件:全仓零 `.gw-pop` 写入方**(证据:对 `.gw-pop` 元素上出现 `--gw-pop-width` 的 grep)。' +
      '退役时与 `VARIABLE_EXCEPTIONS` 里 `--gw-pop-width` 那条、以及 `repo-bar.tsx` 那一行内 style 同一批做,' +
      '不要并发期做 —— 那会把「暂时没写入方」和「真死了」混起来。',
    entry: 'src/client/scss/pop-width.scss',
    requires: {
      '.gw-pop': '弹层本体;消费行内 `--gw-pop-width` 的那条规则必须真的进产物',
    },
    usageNote: '不参与类覆盖取样(`.gw-pop` 是本插件自己的样式,不在移植类名账里)',
    bootstrap:
      '⚠️ **已过时,勿照此理解**:面板 div 曾经带 `gw-pop`;2026-10 起面板已改为 **foldout 本身**' +
      '(`src/client/toolbar.tsx` 删掉了零高度定位锚),宽度改由 `foldoutStyleOverrides` 决定。' +
      '原描述(保留作历史):`src/client/repo-bar.tsx` 的面板 div 带 `gw-pop`;宽度来自 `useLeftWidth()` 的行内变量。' +
      '⚠️ **2026-10 更新:`useLeftPaneWidth()` 此后也已退出使用** —— `toolbar.tsx` 改用 ' +
      '`src/client/sidebar-width.ts` 的 `useSidebarWidth()`(**真源 = 存储值**,与 Desktop ' +
      '`app.tsx:3921` 的 `clamp(this.state.sidebarWidth)` 同模型)。原因:旧实现只在挂载时 ' +
      '`querySelector` + `observe` **一次**,而两个页签互斥挂载会卸载被观察的 `.gw.split` ⇒ ' +
      '回调量到 0 ⇒ 段宽塌回内容宽(**实测 250 → 117,且切回 Changes 也回不去**)。' +
      '⇒ 该函数与那条行内变量**现在都死了**,退役条件已满足。',
  },
  {
    /*
     * ## Preferences 面(2026-10 登记)
     *
     * 这个入口 `src/client/scss/preferences.scss` **早就写好了,却从来没进过这张表** ——
     * 于是它的上游配方(`_preferences.scss` / `_tab-bar.scss` / 原语)一条都不在编译产物里,
     * Preferences 弹窗只有 `styles.ts` 的 `.gw-prefs-card` / `-body` / `-form` 三个手写类
     * 撑着。**「入口文件存在」不等于「进了编译」** —— 这条和 §11.5 那次「整张样式表没进包」
     * 是同一族,只是形态更隐蔽(文件就在 `scss/` 里,看起来像已经接了)。
     *
     * ⚠️ **作用域语义(2026-10 翻转,别按旧版读)**:弹窗不再渲染上游 `Dialog`,
     * 改走宿主 `Modal`,`.gw-prefs` 加在**宿主卡片自己**身上
     * (`src/client/host-modal.tsx:111` 的 `CARD_CLASS = 'gw-prefs gw-prefs-card'`,
     * portal 到 `document.body`)。前缀化是 `.gw-prefs ` + 选择器(后代组合子),
     * 所以产物里每条上游规则都要求目标元素是**卡片的后代**(`.gw-prefs .tab-bar` ✓);
     * **永远不要把 `.gw-prefs` 与某个目标类加在同一个元素上**(那会产出永不匹配的后代选择器)。
     * 旧版那两条 `dialog#preferences` 基底配方已删(页面上没有 `<dialog>` 了,是纯死规则)。
     */
    id: 'preferences',
    scope: '.gw-prefs',
    scopeNote:
      '`src/client/host-modal.tsx` 加到**宿主 Modal 卡片自己**身上的类(我们自己的 DOM 标记,' +
      '不是上游类名;卡片由 `ReactDOM.createPortal` 挂到 `document.body`,不在 `.gw-root` 子树里,' +
      '所以作用域根必须显式落在卡片上)。',
    entry: 'src/client/scss/preferences.scss',
    requires: {
      '.preferences-container': '弹窗主体容器(上游 `ui/_preferences.scss:17` 的 `.preferences-container .tab-container`)',
      '.tab-container': '页签内容面板(`role=tabpanel`;上游给它 `border-left` + `flex:1`)',
      '.tab-bar': '竖向页签栏本体(上游 `ui/_tab-bar.scss:1`)',
      '.tab-bar-item': '一个页签(上游 `&.vertical &-item`)',
      '.button-component': 'Button 原语(页脚的保存/取消)',
      '.checkbox-component': '复选框原语(上游 `ui/_checkbox.scss`)',
      '.radio-button-component': '单选框原语(上游 `ui/_radio-button.scss`)',
      '.select-component': '原生 `<select>` 外壳(Integrations 页;上游 `ui/_select.scss`)',
      '.text-box-component': '输入框原语(上游 `ui/_text-box.scss`)',
      '.row-component': 'Row 原语(上游 `ui/_row.scss`)',
      '.ref-component': '分支名/标签 chip(上游 `ui/_ref.scss`)',
      'svg.octicon': 'Octicon 图标基底(页签图标)',
    },
    usageFiles: [
      'src/client/preferences-dialog.tsx',
      'src/client/host-modal.tsx',
      'src/core/desktop/ui/preferences',
      'src/core/desktop/ui/tab-bar.tsx',
    ],
    usageNote:
      'Preferences 弹窗(宿主 Modal 卡片)+ 它渲染的上游 `ui/preferences/**` 与 TabBar/原语',
    bootstrap:
      '`src/client/host-modal.tsx:111` 的 `CARD_CLASS = "gw-prefs gw-prefs-card"` 加在宿主 `Modal` ' +
      '的**卡片自己**身上(portal 到 `document.body`);`src/client/preferences-dialog.tsx` 渲染卡片内容。',
  },
];

/** 所有作用域根(顺序即输出顺序)。作用域检查的白名单就是这个集合。 */
export const PORT_SCOPES = PORT_SURFACES.map((surface) => surface.scope);

/**
 * ⚠️ **断言:每个非下划线的 `.scss` 都必须是某个移植面的 `entry`。**
 *
 * ## 为什么需要它(堵的是一个**静默**盲区)
 *
 * `checkInlineTokens()` 的扫描面是 `listSources('src/client')`,**只收 `.ts`/`.tsx`**;
 * `.scss` 只能**间接**经 `desktop-diff-styles.generated.ts` 被它看到。顺序是对的
 * (`buildPortStyles()` 先跑),所以**在某个面闭包内**的 SCSS 令牌确实被查 —— 但
 * **不在任何面闭包里的 `.scss`**(例如新写一个还没接进注册表的 partial)里的错令牌
 * **永远不会被这条闸门看到**。那是「令牌必须是宿主真实存在的」这条不变式上的一个洞。
 *
 * 这里把「没进闭包」从**静默盲区**变成**构建期错误**:任何非下划线的 `.scss`
 * 必须要么是某个面的 `entry`,要么改名为 `_` 开头的 partial 并由某个入口 `@import`。
 * 选这个方案而不是「把扫描面扩到 `src/client/**\/*.scss`」,是因为它**保住了
 * 「注释里的令牌名不算使用」这条已有的正确行为**(扩大扫描面要自带 SCSS 注释剥离,
 * 反而会引入新的假阴性)。
 *
 * ## 目录读不到时**静默跳过**
 *
 * 探针常在沙箱 cwd 里 `import` 本模块(`/tmp/...`)。那种情况下相对目录不存在,
 * 这里**不报错**(否则会打断所有探针),但下面的自检保证了「读到了」与
 * 「判据不是恒真」这两件事在**能读到时**都被证明。
 */
{
  const SCSS_DIRS = ['src/client', 'src/client/scss'];
  let readable = 0;
  const offenders = [];
  for (const dir of SCSS_DIRS) {
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    readable += 1;
    for (const name of names) {
      if (!name.endsWith('.scss') || name.startsWith('_')) continue;
      const rel = `${dir}/${name}`;
      if (!PORT_SURFACES.some((surface) => surface.entry === rel)) offenders.push(rel);
    }
  }
  if (readable > 0) {
    /*
     * 夹具(每次 import 都跑):证明这次扫描**真的读到了文件**,而且判据是**真的集合判据**
     * (不是恒真/恒假)。`_dsh-bridge.scss` 是下划线 partial:它**不该**是 entry,
     * 而它之所以没被判违规,正是因为上面那条下划线豁免 —— 去掉豁免它就会进 `offenders`。
     */
    const partial = 'src/client/scss/_dsh-bridge.scss';
    if (!readdirSync('src/client/scss').includes('_dsh-bridge.scss')) {
      throw new Error(
        'scss 扫描自检失败:在 src/client/scss 下没读到 _dsh-bridge.scss —— 目录或判据写错了',
      );
    }
    if (PORT_SURFACES.some((surface) => surface.entry === partial)) {
      throw new Error(`scss 扫描夹具失败:下划线 partial 不应该是 entry(${partial})`);
    }
  }
  if (offenders.length > 0) {
    throw new Error(
      `移植面注册表漏了 ${offenders.join(', ')} —— 这个 .scss 没有任何 PORT_SURFACES 表项 ⇒ ` +
        '`checkInlineTokens()` 看不到它里面的令牌(它只扫 .ts/.tsx,.scss 仅经编译产物被间接覆盖)。' +
        '请给它加一条表项(一个面 = 一条表项 + 一个入口 SCSS),或把它改名为下划线开头的 partial 并由某个入口 @import。',
    );
  }
}

/**
 * 类覆盖率的**账本**:这些 token 要么是提取器的误抓,要么属于**本条渲染路径到不了的分支**。
 * 每一条都逐条核实过(见每行的理由),不是为了让数字好看而拉黑的。
 * 加新条目必须写理由 —— 否则覆盖率就变成自欺欺人了。
 */
export const CLASS_EXCEPTIONS = new Map([
  ['cell', '源码里是 role="cell",提取器把属性值当成了类名'],
  ['lines', '注释里出现的英文单词'],
  ['diff', '同一个 div 上的 id="diff"(binary-file.tsx),不是类名'],
  ['name', '比较用的字符串字面量,不是类名'],
  ['range', '同上'],
  ['direction', '同上'],
  ['absolute', '内联 style 的 position 值'],
  ['small', 'Button 的 size 比较值;真实类名 small-button 已覆盖'],
  ['cm-', '`cm-${token}` 动态前缀;语法高亮 worker 是不产出 token 的替身'],
  ['selecting-', '`selecting-${column}` 动态前缀;selecting-before/after 已覆盖'],
  ['status-', '`status-${kind}` 动态前缀(运行期拼接,提取器只看字面量);`DiffHeader` 现已接线,所以理由不再是「未接线」'],
  /*
   * --- 2026-10 更新:顶栏 / History 面落地后暴露的 5 条 ---
   *
   * 这一组**不是同一类**,理由必须分开写 —— 一律写「例外」会让两类真问题被一起掩掉:
   *   (a) `gw-dot` / `ok`:规则**确实存在**,只是住在**另一个注入源**里;
   *   (b) `nudge-arrow*`:规则存在,但**所属的移植面尚未注册**;
   *   (c) `collapsed`:规则**上游也没有**,而且它还是提取器的一次假命中。
   */
  ['gw-dot', '规则在 `src/client/styles.ts`(登录状态圆点)。`styles.ts` 与移植面产物是**两个注入源**,所以类覆盖率永远看不到它 —— 与 `VARIABLE_EXCEPTIONS` 里 `--gw-pop-width` **完全同因**,不是缺口'],
  ['ok', '同上:`.gw-dot.ok` 也在 `src/client/styles.ts`,属另一个注入源'],
  /*
   * `gw-underline-links` —— 「Underline links」偏好打开时挂在 `.gw-root`(workbench.tsx)
   * 与宿主 Modal 卡片(preferences-dialog.tsx 传给 HostModal 的 className)上的类。
   * 与 `.gw-dot` / `.ok` **完全同因**:规则**存在**,但住在**另一个注入源**
   * (`src/client/pref-adapt.ts` 的 `PREF_ADAPT_CSS`,由 `ensurePrefAdaptations()` 注入
   * `<style id="gw-pref-adaptations">`)⇒ 类覆盖率只扫移植面产物,看不到它。
   * **不是缺口**:真 Chrome 探针 `docs/probes/preferences-geometry-probe.mjs` 量到
   * `.gw-root.gw-underline-links a` 的 computed `text-decoration-line === 'underline'`。
   * 若样式线把这条规则搬进 `preferences.scss` 的 `.gw-prefs` 适配块,本例外应随之删除。
   */
  ['gw-underline-links', '规则在 `src/client/pref-adapt.ts` 注入的 `<style id="gw-pref-adaptations">`(Underline links 那条)。与 `.gw-dot`/`.ok` 同因:规则**存在**且被真 Chrome 探针量到,只是住在**另一个注入源**,类覆盖率扫不到 —— 不是缺口'],
  ['nudge-arrow', '上游 `ui/toolbar/{branch-dropdown,push-pull-button}.tsx` 运行期拼的类;规则在 `ui/onboarding-tutorial/_nudge-arrow.scss`,而**引导教程面尚未注册** ⇒ 产物里没有它的规则。这是「规则所属的面未注册」,不是「找不到规则」'],
  ['nudge-arrow-up', '同上:同属 `ui/onboarding-tutorial/_nudge-arrow.scss`,该面尚未注册'],
  ['collapsed', '**提取器的假命中 + 上游本就没有这条规则**。(1) `ui/lib/button.tsx:97-100` 的**文档注释**里出现该词,提取器把注释文本当成了字符串 ⇒ 待修项:提取前应剔除注释。(2) History 渲染 `expanded|collapsed`(上游 `ui/history/selected-commits.tsx:308` 同样如此),而**上游只给 `.expanded` 写规则** ⇒ `.collapsed` 无规则是上游的事实,不是我们的缺口'],
  /*
   * --- 2026-10 更新:tooltip 家族 ---
   * 新增 `.tooltip-host` 面之后,`ui/window/_tooltips.scss` 进了闭包:
   *   · `.tooltip` / `.tooltip-content` **已经在产物里** ⇒ 这两条不再触发(留在这里是历史记录);
   *   · 曾经挡不住的「触发点不在任何 `.tooltip-host` 子树里、portal 到 document.body」那些浮层
   *     **已于 2026-10 由实测关闭**:`workbench.tsx` 的 `.gw-body` 补了 `tooltip-host` 标记,
   *     真实渲染树里枚举到的 14 个触发点**全部** host-based(实测 body-based = 0),
   *     以及下面那条**动态前缀**(`tooltip-${direction}` 这类拼出来的类名本来就无法静态枚举)。
   */
  ['tooltip',
    'portal 宿主面。`.gw-body` / `.gw-app-toolbar` / `.gw-desktop-history` / dialog 都带 marker。' +
    '**旧解释已废**:它说「createPortal 到 document.body ⇒ 在作用域之外 ⇒ 那几条规则永远打不到」——' +
    '2026-10 实测证伪:真实浮层带上的是 `.tooltip-se`/`.tooltip-e`,`.tooltip-host > .tooltip` 那条' +
    '**确实匹配**(探针的 matched-rule 列表里就有它),而且**修复前也不是 0 匹配**'],
  ['tooltip-content', '同 `tooltip` 那条'],
  ['tooltip-', '`tooltip-${direction}` 动态前缀(拼出来的类名无法静态枚举);host-based 的那些已随 `.tooltip-host` 面进产物'],
  ['submodule-diff', '子模块 diff 分支不可达:host 没有 show/cat-file 路由,构造不出 ISubmoduleDiff'],
  ['changes-interstitial', '同上'],
  ['interstitial-header', '同上'],
  ['text', '只在 submodule-diff.tsx 里用'],
  ['item', '只在 submodule-diff.tsx 里用'],
  ['secondary-text', '只在未接线的 DiffOptions 里用(我们保留自己的 DiffSettings 弹层)'],
  ['checkbox', 'Checkbox 原语;行级暂存未接线,showDiffCheckMarks=false'],
  ['spin', '只在未接线的 Loading(seamless-diff-switcher)里用'],
  ['content-wrapper', '上游样式表里也没有它的规则(纯结构 div)'],
  ['byline', '上游只在 commit-list 里定义 .byline;这里是 popover 里的段落,由 popover 兜底'],
  ['hunk-expansion-placeholder', '上游样式表里也没有它的规则;且展开分支需要 fileContents,当前恒为 null'],
  // --- 2026-06 加入仓库列表面后新增的三条(逐条核实过,不是为了让数字好看) ---
  ['selected-for-keyboard-insertion',
    '上游 `_list.scss` 里也没有这条规则;`repository-list-item.tsx:53` 只是把它拼进 className,' +
    '**没有任何样式表为它写规则** —— 上游也一样,所以不是我们的缺口'],
  ['selecting-${this.state.selectingTextInRow}',
    '`\`selecting-${...}\`` 这种**模板字面量**被提取器当成了类名(它连字面量都不是一个完整 token);' +
    '真实类是 selecting-before / selecting-after,两条都已覆盖'],
  ['tooltip-${direction}',
    '`tooltip-${direction}` 动态前缀,拼出来的类名无法静态枚举。**旧理由已废**:它写「portal 到 ' +
    'document.body、在作用域之外,所以 tooltip-top / -bottom 永远打不到」—— 2026-10 实测:浮层真实类名是 ' +
    '`.tooltip-se`/`.tooltip-e`,规则**匹配得上**,连修复前也不是 0 匹配'],
]);

/**
 * 类覆盖率的**关键类**:渲染路径必然用到,缺一个就是「接上了但没样式」。
 * 由所有移植面的 `requires` 汇总而来 —— 那份声明已经是「不能缺」的清单,
 * 再维护第二份必然漂移。
 */
export const CRITICAL_CLASSES = [
  ...new Set(
    PORT_SURFACES.flatMap((surface) =>
      Object.keys(surface.requires).flatMap((selector) => {
        // 只取**简单类选择器**作为「关键类名」,并且取第一段:
        // `.row.hunk-info` 的类名是 `row`(以及 `hunk-info`);
        // `svg.octicon` 是标签+类,类名是 `octicon`;带空格的后代选择器取最后一段。
        const last = selector.split(/\s+/).pop() ?? '';
        return last
          .split('.')
          .filter((one) => /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(one))
          // `svg.octicon` 的 `svg` 是标签名,不是类名 —— 只保留 `.` 后面的段
          .filter((one, index, all) => index > 0 || last.startsWith('.'));
      }),
    ),
  ),
].sort();

// ---------- 内部工具 ----------

/** 递归展开 usageFiles:目录取 .ts/.tsx,文件原样保留。 */
async function expandUsageFiles(usageFiles) {
  const out = [];
  for (const entry of usageFiles) {
    let info;
    try {
      info = await stat(entry);
    } catch {
      continue; // 镜像裁剪时目录可能不存在
    }
    if (info.isFile()) {
      out.push(entry);
      continue;
    }
    for (const child of await readdir(entry, { withFileTypes: true })) {
      const path = `${entry}/${child.name}`;
      if (child.isDirectory()) out.push(...(await expandUsageFiles([path])));
      else if (child.name.endsWith('.ts') || child.name.endsWith('.tsx')) out.push(path);
    }
  }
  return out;
}

/**
 * 找出与 `open` 配对的闭合括号(跳过字符串/注释里的括号)。
 * @param text - 文本。
 * @param open - 起始括号下标。
 * @param o - 开括号字符。
 * @param c - 闭括号字符。
 */
function matchBalanced(text, open, o, c) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === o) depth++;
    else if (ch === c) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * 走一遍一段 CSS 的**顶层**内容,对每条规则调用 `visit`。
 *
 * ## 为什么必须自己走一遍,而不是用正则
 *
 * 作用域块的块体里同时有**两种**东西,形状完全不同:
 *   - CSS 自定义属性声明:`--a: 1; --b: 2;`(结尾是 `;`,**没有** `{`)
 *   - 嵌套规则:`.foo { ... }` / `.a,\n.b { ... }`
 *
 * 用 `([^{}@;]+?)\{` 这类正则抓选择器会**一条都抓不到**:块体开头的变量声明里没有 `{`,
 * 于是正则从块体开头一路吃到第一条规则的 `{`,把整段声明当成「选择器」。实测:
 * 一个 5621 字符的作用域块提取出 **0 个选择器**,导致 14 条基底配方全部被误报缺失。
 *
 * 所以这里按「声明的结束符 `;`」切段:`;` 之后重新开始一段;遇到 `{` 时,
 * 当前这一段就是选择器,然后用括号配平跳过规则体,再重新开始一段。
 *
 * 已知取舍:不解析字符串字面量(`content: "a;b"` 会把段切错)。本项目实际用到的
 * 上游 partial 里没有这种写法;真出现也会被作用域检查/配方检查兜住(不会静默)。
 *
 * @param css - 一段 CSS。
 * @param visit - `(selector, isAtRule, start, end)`;`start`/`end` 是规则的含花括号区间。
 */
function walkRules(css, visit) {
  let segStart = 0;
  let i = 0;
  while (i < css.length) {
    const ch = css[i];
    if (ch === ';') {
      segStart = i + 1;
      i++;
      continue;
    }
    if (ch === '{') {
      const head = css.slice(segStart, i).trim();
      const end = matchBalanced(css, i, '{', '}');
      if (end === -1) return;
      visit(head, head.startsWith('@'), segStart, end);
      i = end + 1;
      segStart = i;
      continue;
    }
    if (ch === '}') {
      // 顶层不该出现孤立的 `}`;跳过以免死循环
      segStart = i + 1;
      i++;
      continue;
    }
    i++;
  }
}

/**
 * (2026-10 删除)`selectorsIn(css)`:它**不递归**进组 at-rule(`walkRules` 把 `@media` 整块
 * 交给 visit 后直接跳到块尾),而它唯一的调用者 `findLeakedRules` 因此**从来没检查过
 * `@media` 里的规则**(旧注释却写着「它内部的规则仍会被逐条看到」)。现在产物里
 * 「有哪些选择器」只有**一个**定义:{@link selectorsInArtifact}(递归)。
 * 留着这个不递归的版本只会让人再踩一次,所以删掉而不是标注。
 */

/**
 * 去掉 CSS 注释。注释里可能原样出现选择器文本,任何「按选择器找块」的逻辑都必须先剥。
 * @param css - CSS 文本。
 */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

// ---------- 编译后前缀化(post-compile scoping) ----------

/**
 * 把注释替换成**等长空白**,偏移量与原串一一对应。
 *
 * ## 为什么结构解析必须跑在它上面
 *
 * 响亮注释(Sass 的块注释)在 expanded 模式下会**逐字保留**在产物里,而我们的注释里
 * 就写着花括号与分号 —— `_dsh-bridge.scss` 的注释里有 `.gw-desktop-diff { … }`。
 * 实测:旧产物原文 `{` 959 个、`}` 956 个(差 3 个全在注释里),注释剥掉之后两边都是
 * 933。直接拿原文配平括号,会从注释里的花括号开始错位,前缀化会切错选择器。
 *
 * 所以:结构走 `maskComments(css)`,切片切**原文**,下标通用。
 * @param css - CSS 文本。
 */
function maskComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) => ' '.repeat(comment.length));
}

/** 组 at-rule:块体里仍是**样式规则**,选择器还要加前缀。 */
const GROUP_AT_RULES = new Set([
  'media', 'supports', 'container', 'layer', 'scope', 'document', 'starting-style',
]);

/**
 * 不透明 at-rule:头部与块体**逐字保留**。
 *
 * `@keyframes` 的「选择器」是 `from` / `to` / `50%`,**不是选择器** —— 给它们加
 * `.gw-x ` 前缀会把整段动画改坏(而且 `@keyframes .gw-x from` 本身就是语法错)。
 * 其它几个(字体/页面/计数器/自定义属性注册)也不含样式规则。
 */
const OPAQUE_AT_RULES = new Set([
  'keyframes', 'font-face', 'page', 'counter-style', 'font-feature-values', 'property',
  'viewport', 'font-palette-values', 'position-try', 'charset', 'import', 'namespace',
]);

/** at-rule 名字(去掉 `@` 与厂商前缀,小写)。 */
function atRuleName(head) {
  const raw = head.slice(1).split(/[\s({;]/, 1)[0]?.toLowerCase() ?? '';
  return raw.replace(/^-[a-z]+-/, '');
}

/** 转义正则元字符。 */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `scope` 在一条选择器里作为**类 token** 出现的次数。
 * `.gw-x` 不会命中 `.gw-x-y`(负向前瞻挡住 `-`/词字符)。
 */
function countScope(selector, scope) {
  return (selector.match(new RegExp(`${escapeRegExp(scope)}(?![\\w-])`, 'g')) ?? []).length;
}

/**
 * 根元素选择器。它们的实例只能是作用域根的**祖先**,不可能是后代 ——
 * 这正是 `html`/`body` 那两种形状必须特殊处理的原因。
 */
const ROOT_ELEMENT_RE = /^(html|body)(?![-\w])/;

/**
 * 根元素开头的**复合选择器**长度:`body` / `body.platform-win32` / `html.x` /
 * `body:not(.x):hover`。**伪元素**(`::before` / `::-webkit-scrollbar`)不算复合的一部分
 * —— 它选的是**另一个盒子**,作用域要插在它前面(`body::-webkit-scrollbar` →
 * `body .gw-x::-webkit-scrollbar`)。
 */
const ROOT_COMPOUND_RE = /^(html|body)(?![-\w])((?:[.#][\w-]+|\[[^\]]*\]|:(?!:)[\w-]+(?:\([^)]*\))?)*)/;

/**
 * 走一遍 CSS 的**顶层**,返回每个 `头部 { 块体 }` 项。
 *
 * - `head` 是**去掉前后空白与注释**的头部文本(选择器或 at-rule);
 * - `headStart`/`headEnd` 指向**原文**里的那段头部,用来原位替换;
 * - `braceAt`/`end` 是花括号下标;
 * - `;` 结尾的语句(`@charset "UTF-8";`)不是项,原样留在缝里。
 *
 * ⚠️ 头部里若**夹着**注释(选择器中间),这里显式抛错而不是猜 —— 静默切错会让
 * 选择器变形,而那正是本次要消灭的那一类失败。
 * @param css - CSS 文本。
 */
function topLevelItems(css) {
  const mask = maskComments(css);
  const items = [];
  let segStart = 0;
  let i = 0;
  while (i < mask.length) {
    const ch = mask[i];
    if (ch === ';') { segStart = i + 1; i++; continue; }
    if (ch === '{') {
      const end = matchBalanced(mask, i, '{', '}');
      if (end === -1) throw new Error(`CSS 结构损坏:偏移 ${i} 处的 “{” 没有配对`);
      const blankHead = mask.slice(segStart, i);
      const headStart = segStart + (blankHead.length - blankHead.trimStart().length);
      const headEnd = segStart + blankHead.trimEnd().length;
      const head = css.slice(headStart, headEnd);
      if (head.includes('/*')) {
        throw new Error(
          `选择器/at-rule 头部里夹着注释,前缀化无法安全定位:${JSON.stringify(head.slice(0, 80))}`,
        );
      }
      items.push({ head, headStart, headEnd, braceAt: i, end });
      i = end + 1;
      segStart = i;
      continue;
    }
    if (ch === '}') { segStart = i + 1; i++; continue; }
    i++;
  }
  return items;
}

/**
 * 按**顶层逗号**把选择器列表拆开:括号、方括号、引号里的逗号不算。
 * (`:not(.a, .b)` / `[data-x="a,b"]` 这类必须保持完整。)
 * @param text - 选择器列表。
 */
function splitSelectorList(text) {
  const out = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote !== '') {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) { out.push(text.slice(start, i)); start = i + 1; }
  }
  out.push(text.slice(start));
  return out;
}

/**
 * 一条选择器按**组合子**(空白 `>` `+` `~`)切出的「部分」;括号/方括号/引号里的不算。
 * `:nth-child(2n+1)` 里的 `+`、`[a~="x"]` 里的 `~` 都在括号内,会被正确跳过。
 * @param selector - 一条选择器。
 */
function selectorParts(selector) {  const parts = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i];
    if (quote !== '') {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '(' || ch === '[') { depth++; continue; }
    if (ch === ')' || ch === ']') { depth--; continue; }
    if (depth > 0) continue;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '>' || ch === '+' || ch === '~') {
      const piece = selector.slice(start, i).trim();
      if (piece !== '') parts.push(piece);
      while (i + 1 < selector.length && /[\s>+~]/.test(selector[i + 1])) i++;
      start = i + 1;
    }
  }
  const last = selector.slice(start).trim();
  if (last !== '') parts.push(last);
  return parts;
}

/**
 * 把一条选择器切成 `{ type: 'compound' | 'comb', text }` 的序列,**保留组合子是哪一个**
 * (空白 = 后代、`>`、`+`、`~`)。括号/方括号/引号里的组合子不算(交给 compound 文本)。
 *
 * 为什么需要它:`selectorParts` **丢掉了组合子**,而「作用域根后面跟的是兄弟组合子」
 * 与「跟的是后代组合子」在匹配语义上完全不同(前者命中的元素**不在**作用域里)。
 * `isScopedSelector` 要用它做状态机判定。
 * @param selector - 一条选择器(已 trim)。
 * @returns {ReadonlyArray<{ type: 'compound' | 'comb', text: string }>}
 */
function selectorCombinatorTokens(selector) {
  /** @type {Array<{ type: 'compound' | 'comb', text: string }>} */
  const tokens = [];
  let cur = '';
  let depth = 0;
  let quote = '';
  const flush = () => {
    if (cur !== '') tokens.push({ type: 'compound', text: cur });
    cur = '';
  };
  const pushComb = (text) => {
    // 空白与显式组合子相邻时**显式的那一个胜**:先把刚压进去的空格组合子弹掉。
    const last = tokens[tokens.length - 1];
    if (last !== undefined && last.type === 'comb' && last.text === ' ') tokens.pop();
    const now = tokens[tokens.length - 1];
    if (now !== undefined && now.type === 'comb') return;
    if (tokens.length === 0) return; // 开头的组合子在 CSS 里没有意义,丢掉
    tokens.push({ type: 'comb', text });
  };
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i];
    if (quote !== '') {
      cur += ch;
      if (ch === '\\') cur += selector[++i] ?? '';
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '(' || ch === '[') { depth++; cur += ch; continue; }
    if (ch === ')' || ch === ']') { depth--; cur += ch; continue; }
    if (depth > 0) { cur += ch; continue; }
    if (ch === '>' || ch === '+' || ch === '~') { flush(); pushComb(ch); continue; }
    if (ch === ' ' || ch === '\t' || ch === '\n') { flush(); pushComb(' '); continue; }
    cur += ch;
  }
  flush();
  while (tokens.length > 0 && tokens[tokens.length - 1].type === 'comb') tokens.pop();
  return tokens;
}

/**
 * 一个**复合选择器**(单个 compound)是否就是作用域根(或它的同元素修饰,
 * 例如 `.gw-x.foo` / `.gw-x:hover` / `.gw-x[data-y]`)。
 *
 * 刻意要求 scope 出现在 compound **开头**:`.foo.gw-x` 这种形状旧判据也不接受,不放宽。
 * @param compound - 一个复合选择器。
 * @param scope - 作用域根。
 */
function compoundIsScope(compound, scope) {
  return (
    compound === scope ||
    compound.startsWith(`${scope}.`) ||
    compound.startsWith(`${scope}:`) ||
    compound.startsWith(`${scope}[`)
  );
}

/**
 * 给**一条**选择器加作用域前缀。四种形状,顺序即优先级:
 *
 *  1. **`:root` 开头** → 把 `:root` **换成**作用域根:
 *     `:root { --a: 1 }` → `.gw-x { --a: 1 }`。
 *     合并成 `.gw-x :root` 会永不匹配;而把变量留在宿主 `:root` 上就是改宿主的皮肤
 *     (本项目的红线)。所以唯一正确的落点就是作用域元素自己。
 *  2. **`html` / `body` 开头** → 作用域根插在它**之后**:
 *     `body.platform-win32 ::-webkit-scrollbar` → `body.platform-win32 .gw-repo-list ::-webkit-scrollbar`。
 *     ⚠️ 这是与「双重前缀」**不同的第二个**机制:`body` 是作用域根的**祖先**,
 *     前缀加在最前面会产出 `.gw-repo-list body.platform-win32 …` —— 结构上永不匹配。
 *     嵌套 `@import` 下,上游 `_platform.scss` 的 `@include win32-context { … }`
 *     产出的 14 条选择器就是这个形状(Win/Linux 的滚动条样式全失效)。
 *  3. **已经含作用域根**(引用计数 > 0)→ **原样返回**:我们自己手写的适配层写成
 *     `.gw-x { … }` / `.gw-x.bounded { … }`,再前缀一次就会双重作用域。
 *  4. 其它 → 前缀加在整个选择器前面。
 *
 * `:root` 出现在**非开头**位置(如 `.a :root`)会直接抛错:作用域无法表达它,
 * 而静默产出永不匹配的选择器正是本次要消灭的东西(见 `findRootAfterScopeSelectors`)。
 * @param selector - 一条选择器(已 trim)。
 * @param scope - 作用域根。
 */
function prefixOneSelector(selector, scope) {
  const parts = selectorParts(selector);
  const first = parts[0] ?? '';
  if (/:root(?![-\w])/.test(selector)) {
    if (!/^:root(?![-\w])/.test(first)) {
      throw new Error(`:root 不在选择器开头,无法用 ${scope} 表达:${selector}`);
    }
    return scope + selector.slice(':root'.length);
  }
  if (ROOT_ELEMENT_RE.test(first)) {
    if (countScope(selector, scope) > 0) return selector;
    /*
     * 插在**根元素的复合选择器之后**(不是整个「部分」之后):`body.platform-win32`
     * 整段属于 body 自己;而 `body::-webkit-scrollbar` 里的 `::-webkit-scrollbar`
     * 选的是另一个盒子,前缀要插在 `body` 之后、伪元素之前。
     */
    const compound = ROOT_COMPOUND_RE.exec(first);
    const head = compound === null ? first : compound[0];
    return `${head} ${scope}${selector.slice(head.length)}`;
  }
  if (countScope(selector, scope) > 0) return selector;
  return `${scope} ${selector}`;
}

/**
 * 给一段 CSS 的**每条顶层选择器**加作用域前缀,块级 at-rule 递归处理。
 *
 * 非选择器内容(注释、`;` 语句、不透明 at-rule 的块体、规则体里的声明)逐字保留 ——
 * 只在「头部是选择器」的那些位置做原位替换。
 * @param css - Sass 编译产物(某个面,**未**加作用域)。
 * @param scope - 该面的作用域根。
 */
export function prefixTopLevelSelectors(css, scope) {
  const items = topLevelItems(css);
  if (items.length === 0) return css;
  let out = '';
  let cursor = 0;
  for (const item of items) {
    out += css.slice(cursor, item.headStart);
    let head = item.head;
    let body = css.slice(item.braceAt + 1, item.end);
    if (head.startsWith('@')) {
      const name = atRuleName(head);
      if (GROUP_AT_RULES.has(name)) body = prefixTopLevelSelectors(body, scope);
      else if (!OPAQUE_AT_RULES.has(name)) {
        throw new Error(
          `不认识的块级 at-rule,前缀化策略未定义:${head.slice(0, 60)} —— ` +
          '请在 scripts/styles.mjs 的 GROUP_AT_RULES / OPAQUE_AT_RULES 里显式归类。' +
          '静默放过会让它内部的规则漏掉作用域。',
        );
      }
    } else if (head !== '') {
      head = splitSelectorList(head)
        .map((one) => {
          const core = one.trim();
          if (core === '') return one;
          const lead = one.length - one.trimStart().length;
          const tail = one.length - one.trimEnd().length;
          const prefixed = prefixOneSelector(core, scope);
          return one.slice(0, lead) + prefixed + (tail > 0 ? one.slice(one.length - tail) : '');
        })
        .join(',');
    }
    out += head + css.slice(item.headEnd, item.braceAt + 1) + body + '}';
    cursor = item.end + 1;
  }
  return out + css.slice(cursor);
}

/**
 * 产物里**所有**样式选择器(逗号已拆开、空白已折叠、注释已剥)。
 *
 * `@media` / `@container` / `@supports` / `@layer` 是**透明容器**,内部规则照样收;
 * `@keyframes` / `@font-face` 的块体**不是**样式规则,整块跳过。
 * @param css - 编译产物。
 */
export function selectorsInArtifact(css) {
  const out = [];
  const visit = (text) => {
    for (const item of topLevelItems(text)) {
      if (item.head === '') continue;
      if (item.head.startsWith('@')) {
        if (GROUP_AT_RULES.has(atRuleName(item.head))) {
          visit(text.slice(item.braceAt + 1, item.end));
        }
        continue;
      }
      for (const one of splitSelectorList(item.head)) {
        const selector = one.replace(/\s+/g, ' ').trim();
        if (selector !== '') out.push(selector);
      }
    }
  };
  visit(maskComments(css));
  return out;
}

/**
 * **双重前缀断言**:任何一条选择器里,同一个作用域根都不允许出现两次。
 *
 * 出现两次 = 作用域根被夹在中间 ⇒ **结构上永不匹配**。这是嵌套 `@import` 对
 * `&.switch &-item` 的产物形状,19 条规则 / 42 条选择器因此静默失效
 * (goal 文档 §7.1)。前缀化本身不该再产出它;这条断言是**兜底**:任何来源
 * (手写 SCSS、新 partial、`@import` 的写法变化)产出双重作用域,构建立刻失败。
 *
 * 导出是为了能在 `/tmp` 夹具上证明它**真的会响**(见本轮报告 (e))。
 * @param css - 编译产物(或任何 CSS)。
 * @param scopes - 注册表里的作用域根。
 */
export function findDoubleScopedSelectors(css, scopes = PORT_SCOPES) {
  const bad = [];
  for (const selector of selectorsInArtifact(css)) {
    for (const scope of scopes) {
      const count = countScope(selector, scope);
      if (count > 1) bad.push({ selector, scope, count });
    }
  }
  return bad;
}

/**
 * **顺序颠倒断言**:根元素(`html` / `body` / `:root`)出现在作用域根**之后**。
 *
 * `body` 只能是作用域根的祖先,不可能是后代 ⇒ 这种选择器**结构上永不匹配**。
 * 它与「双重前缀」是**两个不同的机制**:一个是重复,一个是顺序颠倒。上游
 * `mixins/_platform.scss` 的 `body.platform-win32 &` / `darwin` / `linux` 在
 * **嵌套 `@import`** 下产出的正是这个形状(14 条选择器:Win/Linux 的假滚动条
 * `::-webkit-scrollbar` 一族全部失效),而 `body.platform-darwin .gw-repo-list …`
 * (前缀本来就在 body 之后)是**正确**形状 —— 这条断言必须能区分这两者。
 *
 * 前缀化按 `prefixOneSelector` 的规则 2 把作用域根插在根元素之后,所以**新产物
 * 应该是 0**;这条断言的价值在于:谁把上游 partial 嵌回选择器里(或写出一条
 * `body … .gw-x`),构建就会红,而不是等 Windows 用户发现滚动条不对。
 * 导出同样是为了在 `/tmp` 夹具 + 旧产物上证明它会响。
 * @param css - 编译产物(或任何 CSS)。
 * @param scopes - 注册表里的作用域根。
 */
export function findRootAfterScopeSelectors(css, scopes = PORT_SCOPES) {
  const bad = [];
  for (const selector of selectorsInArtifact(css)) {
    const parts = selectorParts(selector);
    const at = parts.findIndex((part) => scopes.some((scope) => countScope(part, scope) > 0));
    if (at === -1) continue;
    for (let i = at + 1; i < parts.length; i++) {
      if (ROOT_ELEMENT_RE.test(parts[i]) || /^:root(?![-\w])/.test(parts[i])) {
        bad.push({ selector, root: parts[i] });
        break;
      }
    }
  }
  return bad;
}

/**
 * **归属断言**:某个面的产物里,每条选择器都必须落在**它自己的**作用域根下。
 *
 * 比全局白名单(`findLeakedRules`)更严:白名单只问「有没有落在**某个**注册的作用域
 * 里」,于是「A 面产出了 B 面的作用域根」会溜过去(而那是错的:`.gw-desktop-diff`
 * 不可能出现在 `.gw-split` 的输出里)。两个面的入口拆开之后,这条断言也顺带把
 * 「有人把另一个面的入口 import 进来」变成构建失败。
 * @param css - 单个面的编译产物(已加前缀)。
 * @param scope - 该面的作用域根。
 * @param scopes - 全部注册的作用域根(用来在报错里指出它落到了哪个面)。
 */
export function findForeignScopedSelectors(css, scope, scopes = PORT_SCOPES) {
  const foreign = [];
  for (const selector of selectorsInArtifact(css)) {
    if (countScope(selector, scope) > 0) continue;
    foreign.push({ selector, landsIn: scopes.filter((one) => countScope(selector, one) > 0) });
  }
  return foreign;
}

/**
 * 变量账本:产物里**引用**了、但不由产物声明、也不由宿主令牌提供的自定义属性。
 * 每一条都要写理由(和 `CLASS_EXCEPTIONS` 同一套纪律)。
 */
export const VARIABLE_EXCEPTIONS = new Map([
  [
    '--gw-mono',
    '本插件自己的等宽字体变量,定义在 `src/client/styles.ts` 的 `.gw-root` 上 —— ' +
      'styles.ts 与这份产物是两个注入源,这里看不到它的声明。' +
      'goal 文档 §3 失败模式 10 记的正是它:一度**从未定义**却被 4 处引用,那些地方静默地不是等宽字体。',
  ],
  [
    '--gw-pop-width',
    '**行内**变量:`src/client/repo-bar.tsx` 的 `useLeftWidth()` 把量到的左栏像素宽以 ' +
      '`style={{ "--gw-pop-width": … }}` 写在面板元素自己身上(`pop-width.scss` 的 ' +
      '`width:var(--gw-pop-width,auto)` 消费它)。样式表**永远不会**声明它 —— 它不是缺失, ' +
      '而是另一条提供路径(行内 style);竖排 <420px 时客户端返回 0,那条规则回落到 auto。' +
      '⚠️ **2026-10 起本条已失效,退役待批**:面板已不是 `.gw-pop`(改成 foldout 本身),' +
      '所以 `pop-width.scss` 那条规则再也打不到写这个变量的元素;退役与 `PORT_SURFACES` 的 ' +
      '`pop-width` 表项、以及 `repo-bar.tsx` 那一行行内 style 同一批做,' +
      '**退役条件:全仓零 `.gw-pop` 写入方**。另:实际函数名是 `useLeftPaneWidth()`(原文写的 ' +
      '`useLeftWidth()` 不准确),而它**不是**死代码 —— 仍被 `toolbar.tsx` 用来给 foldout 定宽。',
  ],
]);

/**
 * 宿主令牌:存在性由 `build.mjs` 的 `checkInlineTokens()` 对着真实 DSH 安装核。
 *
 * ⚠️ 命名空间必须与 `build.mjs` 的那份**逐字一致**。宿主 `ui-theme` 真实声明了三族:
 * `--dsw-alias-*`(107 个)、`--dsw-specific-*`(`design-platform.css`,10 个)、
 * `--dsw-focus-ring-width` / `--dsw-focus-ring-color`(`focus.css`)。
 * 此前只认 `alias`,于是宿主**真的提供**的 `--dsw-specific-*` / `--dsw-focus-ring-*`
 * 被判成「未绑定变量」而拦下 ⇒ **逼实现者绕开宿主正确的设施**(实测:有人被迫把
 * `--dsw-specific-sidebar-nav-item-active` 换成同值别名、把焦点环的颜色/宽度交回宿主全局
 * `:focus-visible`)。**闸门不该逼人绕开宿主。**
 *
 * 放宽的**前提**是上面那个存在性检查同步放宽 —— 否则这两个族就成了「不校验的放行」,
 * 而那会重新打开我们刚关上的门(拼错的名字也能通过)。`build.mjs` 里有一条正向夹具
 * (`--dsw-specific-sidebar-nav-item-active` 必须在声明集里)专门守住这个前提。
 */
const HOST_VARIABLE_RE = /^--dsw-(alias|specific|focus-ring)-/;

/**
 * 一条规则块体里**直接写出**的自定义属性声明(`--a: …`),不含嵌套规则里的。
 * @param body - 规则块体原文。
 */
function directVariableDeclarations(body) {
  const out = [];
  const items = topLevelItems(body);
  let cursor = 0;
  const regions = [];
  for (const item of items) {
    regions.push(body.slice(cursor, item.headStart));
    cursor = item.end + 1;
  }
  regions.push(body.slice(cursor));
  for (const region of regions) {
    for (const m of maskComments(region).matchAll(/(^|[;{\s])--([a-zA-Z0-9_-]+)\s*:/g)) out.push(m[2]);
  }
  return out;
}

/**
 * 某个移植面的产物里**声明**的自定义属性集合。
 *
 * 判据是「这个面的产物里有一条规则声明了它」—— 规则的选择器必须落在这个面的作用域根下,
 * 取的是那条规则里**直接写出**的声明(不含嵌套规则里的)。
 *
 * **已知取舍**:这里**不校验继承链**。`_side-by-side-diff.scss:2-5` 把
 * `--width-line-number` / `--hunk-handle-width` 声明在 `.side-by-side-diff-container`
 * 上,由**后代**规则继承 —— 那是合法的,而静态判断「某条后代规则能不能继承到」需要
 * DOM 分析。所以本断言抓的是「**整个面里一条声明都没有**」这一类 —— 历史三次静默失效
 * (`--gw-mono` / `--drag-overlay-z-index` / 上游从未定义的 `--spacing-quarter`)
 * 全是这一类;反过来,「声明在某个兄弟元素上、引用方继承不到」它看不见。
 *
 * ⚠️ 例外(能看得见的那种):`portalHost` 面(作用域元素是 portal 宿主)走
 * `scopeElementOnly` 模式 —— 浮层是作用域元素的**直接子节点**,只有声明在作用域元素
 * **自己**身上的自定义属性才**保证**被浮层继承;声明在同级的兄弟子树上继承不到,
 * 所以这种面不接受「在作用域子树里某处有声明」。
 * @param css - 单个面的编译产物。
 * @param scope - 该面的作用域根。
 * @param options - `scopeElementOnly`:只认「选择器就是作用域元素自己」的规则。
 */
export function variablesDeclaredOnScope(css, scope, { scopeElementOnly = false } = {}) {
  const found = new Set();
  const visit = (text) => {
    for (const item of topLevelItems(text)) {
      if (item.head === '') continue;
      const body = text.slice(item.braceAt + 1, item.end);
      if (item.head.startsWith('@')) {
        if (GROUP_AT_RULES.has(atRuleName(item.head))) visit(body);
        continue;
      }
      const inSurface = scopeElementOnly
        ? splitSelectorList(item.head).some((one) => {
            const parts = selectorParts(one.trim());
            return parts.length === 1 && countScope(parts[0], scope) > 0;
          })
        : splitSelectorList(item.head).some((one) => countScope(one, scope) > 0);
      if (inSurface) for (const name of directVariableDeclarations(body)) found.add(`--${name}`);
    }
  };
  visit(maskComments(css));
  return found;
}

/**
 * **变量绑定断言**:某个面产物里每个 `var(--x)` 引用的自定义属性,都必须在
 * **它自己的作用域根**上有声明(或者由宿主令牌/账本提供)。
 *
 * 为什么必须有这一条(而不是只断言类名/基底配方):未定义的 `var()` 会让**整条声明**
 * 按 invalid-at-computed-value-time 丢掉,而构建、类覆盖、令牌检查**全都看不见**
 * —— `--gw-mono`(4 处静默不是等宽字体)、`--drag-overlay-z-index`(z-index 整条失效)、
 * 上游自己从未定义的 `--spacing-quarter` 都是这一类(goal 文档 §3 失败模式 10)。
 *
 * 为什么必须是「**它自己的**作用域」:每个面各有自己的变量桥(桥的声明落在各面的
 * 作用域根上),所以「另一个面绑过」不算数 —— `.gw-desktop-changes` 不能靠
 * `.gw-repo-list` 的绑定活着。
 *
 * `portalHost` 面(见注册表)走 `scopeElementOnly`:浮层只继承**作用域元素自己**身上的
 * 声明,「在这个子树里某处声明过」不算数。
 * @param css - 单个面的编译产物(已加前缀)。
 * @param scope - 该面的作用域根。
 * @param options - `portalHost`:作用域元素是 portal 宿主,变量必须声明在它自己身上。
 */
export function findUnboundVariables(css, scope, { portalHost = false } = {}) {
  const declared = variablesDeclaredOnScope(css, scope, { scopeElementOnly: portalHost });
  const uses = new Map();
  for (const m of maskComments(css).matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)/g)) {
    uses.set(m[1], (uses.get(m[1]) ?? 0) + 1);
  }
  const missing = [];
  for (const [variable, count] of uses) {
    if (HOST_VARIABLE_RE.test(variable)) continue;
    if (VARIABLE_EXCEPTIONS.has(variable)) continue;
    if (declared.has(variable)) continue;
    missing.push({ variable, uses: count });
  }
  return missing.sort((a, b) => (a.variable < b.variable ? -1 : 1));
}

/**
 * 顶层**逐字相同**的规则只留第一份。
 *
 * ## 只删「删掉一定无副作用」的两类
 *
 * 1. **定义式 at-rule**(`@keyframes` / `@font-face` / `@page` / …):同名同体,
 *    后一份覆盖前一份,而两份逐字相同 ⇒ 删掉后一份对计算值没有任何影响。
 *    实测:两个面都 `@import 'ui/popover'`,`@keyframes popover-shake` 各出一份。
 * 2. **空规则块**(块体剥掉注释与空白后为空):没有声明,对层叠没有任何作用。
 *
 * ## 为什么**不**删逐字相同的**样式规则**
 *
 * 即使两条规则逐字相同,删后面那份也**不一定**等价:如果它们之间夹着一条
 * 同特异性、同属性的规则,后者的作用正是「再断言一次」把中间那条压回去 —— 删掉它
 * 就静默改了谁赢。这个取舍是**测出来的**:旧产物里 392 份重复规则、79,797 字节,
 * 其中绝大部分来自「diff 面与 split 面共用入口 → 整份样式编译两遍」(现在从源头
 * 消失),而剩下的同作用域重复里真正可证安全的只有上面两类。
 *
 * ## 跨作用域的重复**不在**讨论范围
 *
 * `_button.scss` 被几个面各 import 一次,产生的是「作用域不同、其余逐字相同」的规则。
 * 那**不是**冗余:同一条规则在两个作用域下命中不相交的 DOM 子树,各面必须有自己的
 * 一份(删掉任何一份都会被 `requires`/变量断言立刻抓住)。
 * @param css - 合并后的编译产物。
 */
function dedupeIdenticalTopLevelRules(css) {
  const items = topLevelItems(css);
  const seen = new Map();
  const drop = [];
  const removedHeads = [];
  const kept = new Map();
  for (const item of items) {
    const key = css.slice(item.headStart, item.end + 1);
    const body = css.slice(item.braceAt + 1, item.end);
    const definitional = item.head.startsWith('@') && OPAQUE_AT_RULES.has(atRuleName(item.head));
    const empty = maskComments(body).trim() === '';
    const previous = seen.get(key);
    if (previous === undefined) { seen.set(key, item); continue; }
    if (definitional || empty) {
      drop.push(item);
      removedHeads.push(item.head.replace(/\s+/g, ' ').trim());
      continue;
    }
    // 逐字相同的**样式规则**:保守留下,但记账(报告里给数字,不声称赢了)
    const entry = kept.get(key) ?? {
      head: item.head.replace(/\s+/g, ' ').trim(),
      bytes: Buffer.byteLength(key),
      copies: 1,
    };
    entry.copies += 1;
    kept.set(key, entry);
  }
  if (drop.length === 0) {
    return { css, removed: 0, heads: [], bytes: 0, keptIdentical: [...kept.values()] };
  }
  let out = '';
  let cursor = 0;
  for (const item of drop) {
    out += css.slice(cursor, item.headStart);
    cursor = item.end + 1;
  }
  out += css.slice(cursor);
  return {
    css: out,
    removed: drop.length,
    heads: [...new Set(removedHeads)],
    bytes: drop.reduce((sum, item) => sum + Buffer.byteLength(css.slice(item.headStart, item.end + 1)), 0),
    keptIdentical: [...kept.values()],
  };
}

// ---------- 检查 ----------

/**
 * 一条选择器是否**落在某个已注册的作用域根之下**。
 *
 * 判据:作用域根出现在选择器**开头**,或在 `body.platform-*` 之类的平台前缀之后
 * (上游 `styles/mixins/_platform.scss` 会生成 `body.platform-darwin &` 这种形状 ——
 * 作用域根仍在,只是不是第一个 token)。只看 `startsWith(scope)` 会把后一种合法形状
 * 误报成泄漏。
 *
 * **紧跟作用域根的那个字符决定「是不是同一个复合部分里的修饰」**:` `/`.`/`:` 一直是
 * 合法形状;`[`(属性选择器)**2026-10 补进来** —— `.gw-x[data-y]` 是**完全合法的已作用域
 * 形状**(作用域根与属性在同一个复合选择器里),旧判据不认它,于是装配层只能绕路写两个类
 * (实测:`repository-list.scss` 的 `.gw-repo-list[data-gw-repo-pop]` 让构建报 2 条 leaked)。
 * **闸门不能把合法形状逼成绕路写法。**
 *
 * 负向边界(故意**不**接受):紧跟 `-`/`_`/字母/数字 —— 那是**另一个类**
 * (`.gw-x-y` 不是 `.gw-x`),必须仍然被拦;裸 `[data-y]`、`.gw-y[data-y]` 同样被拦。
 * 这条边界的夹具见 {@link leakPredicateSelfTest}。
 *
 * ⚠️ **2026-10 补的第二个负向边界:兄弟组合子后面那个元素不在作用域里。**
 * `+` / `~` 选的是「作用域根**旁边**的元素」,它不是作用域的后代 ——
 * `.gw-x + .host-sibling` 命中的是**宿主**元素。旧判据只做「字符串里有没有 `${scope} `」,
 * 于是这条形状被当成已作用域(真 Chrome 实测:它确实命中了 `.gw-root` 之外的兄弟节点)。
 *
 * ## 判据形态(2026-10 从「字符串匹配」改成**组合子状态机**)
 *
 * 逐步扫过 `{compound, comb}` 序列,状态三档:
 *
 * | 状态 | 含义 |
 * |---|---|
 * | 1 | 当前 compound **就是作用域根自己**(或它的同元素修饰 `.gw-x.foo`) |
 * | 2 | 当前元素在作用域根**里面**(有作用域根做祖先) |
 * | 0 | 还在作用域外面 |
 *
 * 转移:`.gw-x` ⇒ 1;从 1 出发,` `(后代)/`>`(子)⇒ 2,**`+`/`~` ⇒ 0**(那是根的**兄弟**,
 * 不是后代 —— 这就是旧判据漏掉的那一类);从 2 出发任何组合子都留在 2(同在作用域里的
 * 元素互为兄弟时,共同祖先仍在作用域内)。**主体**(最后一个 compound)必须落在 1 或 2。
 *
 * 这条状态机还顺手修正了旧判据的两个形状错误:`.foo .gw-x`(主体就是作用域根)
 * 旧判据会**误报**成泄漏;而 `body:has(.gw-x .foo)`(作用域只出现在 `:has()` 里,
 * 主体是 `body`)旧判据会**漏报**。两者现在都判对,夹具里各有一条。
 * @param selector - 一条完整选择器(逗号已拆、空白已折叠)。
 * @param scopes - 允许的作用域根。
 */
function isScopedSelector(selector, scopes) {
  const tokens = selectorCombinatorTokens(selector);
  /** 0 = 作用域外,1 = 就是作用域根自己,2 = 在作用域根里面 */
  let state = 0;
  let comb = '';
  for (const token of tokens) {
    if (token.type === 'comb') { comb = token.text; continue; }
    if (state === 0) {
      state = scopes.some((scope) => compoundIsScope(token.text, scope)) ? 1 : 0;
    } else if (state === 1) {
      state = comb === '+' || comb === '~' ? 0 : 2;
    }
    comb = '';
  }
  // 循环结束时 `state` 描述的就是**主体**(最后一个 compound)的落点。
  return state !== 0;
}

/**
 * `isScopedSelector` 的**自检夹具**(构建期每次跑,不通过就让构建失败)。
 *
 * 为什么要有它:`findLeakedRules` 是硬门禁,而它的判据是**字符串形状匹配** ——
 * 改一个字符类就可能顺手把「裸选择器」也放进来,或者又把合法形状拦掉。
 * 夹具把两类边界各钉死:
 *   · **必须通过**(已作用域):`.gw-x`、`.gw-x.foo`、`.gw-x:hover`、`.gw-x[data-y]`、
 *     `.gw-x .foo`、`body.platform-win32 .gw-x[data-y]`;
 *   · **必须被拦**(未作用域):`[data-y]`、`.gw-y[data-y]`、`.gw-x-y`、`.foo`,
 *     以及 **2026-10 补的兄弟组合子形状** `.gw-x + .foo` / `.gw-x ~ .foo`
 *     (真 Chrome 实测:这两条命中 `.gw-root` **外面**的兄弟节点 ⇒ 是泄漏,
 *      而旧判据把它们当成了已作用域)。
 *
 * @returns {string[]} 与预期不符的用例(空数组 = 通过)。
 */
export function leakPredicateSelfTest() {
  const scopes = ['.gw-x'];
  /** @type {ReadonlyArray<readonly [string, boolean]>} */
  const cases = [
    ['.gw-x', false],
    ['.gw-x.foo', false],
    ['.gw-x:hover', false],
    ['.gw-x[data-y]', false],
    ['.gw-x[data-y]:focus', false],
    ['.gw-x .foo', false],
    ['.gw-x > .foo', false],
    ['body.platform-win32 .gw-x[data-y]', false],
    // 兄弟组合子只在**作用域根紧邻**它时才是逃逸;`.gw-x > .a + .b` 两个元素都在作用域里。
    ['.gw-x > .a + .b', false],
    ['.gw-x .a ~ .b', false],
    ['[data-y]', true],
    ['.gw-y[data-y]', true],
    ['.gw-x-y', true],
    ['.foo', true],
    ['.gw-x + .foo', true],
    ['.gw-x ~ .foo', true],
    ['.gw-x  +  .foo', true],
    ['.gw-x[data-y] + .foo', true],
  ];
  const bad = [];
  for (const [selector, shouldLeak] of cases) {
    if (isScopedSelector(selector, scopes) === shouldLeak) bad.push(selector);
  }
  return bad;
}

/**
 * `findLeakedRules` 的**遍历**自检夹具(构建期每次跑)。
 *
 * 为什么单开一条:`leakPredicateSelfTest` 只证明**单个选择器**的形状判据没坏,不证明
 * 「哪些位置的规则真的被遍历到了」。2026-10 实测到两个遍历盲区,各有正反夹具:
 *
 *  1. **组 at-rule 的块体**:旧实现用 `selectorsIn()`,它对 `@media` 是**整块跳过**的
 *     (`walkRules` 把 `@media` 当 at-rule 交给 visit 后直接跳到块尾)⇒
 *     `@media (min-width:1px){ body { … } }` 里那条**裸 `body` 永远不被检查**。
 *     夹具:`@media { body {…} }` 必须被拦;`@media { .gw-x .foo {…} }` 必须放过。
 *  2. **兄弟组合子**:形状判据修好之后,还必须证明它接在遍历里(见上)。
 *
 * 夹具是**双向**的:只放「必须被拦」会让「什么都报」也算通过;只放「必须放过」会让
 * 「什么都不报」也算通过。两个方向都钉住,这条闸门才不是橡皮图章。
 *
 * @returns {string[]} 与预期不符的用例(空数组 = 通过)。
 */
export function leakTraversalSelfTest() {
  const scopes = ['.gw-x'];
  /** @type {ReadonlyArray<readonly [string, string[]]>} */
  const cases = [
    // 必须**拦下**至少一条
    ['body { color: red }', ['body']],
    ['@media (min-width: 1px) { body { color: red } }', ['body']],
    ['@media (min-width: 1px) { :root { --x: 1 } }', [':root']],
    ['@supports (display: grid) { .host-x { color: red } }', ['.host-x']],
    ['@container (min-width: 1px) { html { color: red } }', ['html']],
    ['.gw-x + .host-sibling { color: red }', ['.gw-x + .host-sibling']],
    ['.gw-x ~ .host-sibling { color: red }', ['.gw-x ~ .host-sibling']],
    ['@media (min-width: 1px) { .gw-x + .host-sibling { color: red } }', ['.gw-x + .host-sibling']],
    // 必须**放过**(已作用域,含组 at-rule 内部)
    ['.gw-x .foo { color: red }', []],
    ['@media (min-width: 1px) { .gw-x .foo { color: red } }', []],
    ['@media (min-width: 1px) { @supports (display: grid) { .gw-x .foo { color: red } } }', []],
    // `@keyframes` 的块体不是样式规则(from/to/50% 不是选择器)⇒ 不许被当成裸选择器报出来
    ['@keyframes gw-k { from { opacity: 0 } to { opacity: 1 } }', []],
    ['@keyframes gw-k { 50% { opacity: 0.5 } }', []],
  ];
  const bad = [];
  for (const [css, expected] of cases) {
    const got = findLeakedRules(css, scopes);
    const same = got.length === expected.length && got.every((one, i) => one === expected[i]);
    if (!same) bad.push(`${css} ⇒ 实际 ${JSON.stringify(got)} / 期望 ${JSON.stringify(expected)}`);
  }
  return bad;
}

/**
 * 作用域检查:**产物里任何位置的样式规则**都必须套在某个作用域根下。
 *
 * 「任何位置」= 顶层 **以及** `@media` / `@supports` / `@container` / `@layer` 的块体里。
 *
 * ## 2026-10 修的遍历盲区(有正反夹具,见 {@link leakTraversalSelfTest})
 *
 * 旧实现用 `selectorsIn()`,而它**不递归**进组 at-rule:`walkRules` 遇到 `@media` 会把整块
 * 交给 visit(以 at-rule 的身份被跳过)然后 `i = end + 1` 跳到块尾。于是
 * `@media (min-width:1px){ body { … } }` 这类规则**从来没被这条硬门禁看过**。
 * 注释里当时写的是「它内部的规则仍会被逐条看到」—— **代码不是这么做的**
 * (goal 文档 §3 失败模式 4:注释声称的行为 ≠ 代码实际行为,两者都要对齐)。
 * 现在改成用与 `findDoubleScopedSelectors` **同一个**遍历器 `selectorsInArtifact`:
 * 一份「产物里有哪些选择器」的定义,免得两个闸门各有一套遍历。
 *
 * `@keyframes` / `@font-face` 的块体**不是**样式规则,`selectorsInArtifact` 天然跳过
 * (`GROUP_AT_RULES` 之外),所以旧版那段手写的「先整块抠掉 @keyframes」不再需要。
 *
 * ⚠️ **仍然管不到的两类**(它们不是选择器,闸门表达不了,各有专门断言):
 *   · `@keyframes` 的**名字**是文档全局的 —— 见 {@link findUnnamespacedKeyframes};
 *   · 手写样式表(`src/client/styles.ts` / `styles-base.ts`)根本不经过本模块,
 *     它们靠 `gw-` 前缀约定 + 类名不撞宿主来隔离。
 *
 * 形状判据在 {@link isScopedSelector}(含 `[attr]` 复合形状与兄弟组合子逃逸),
 * 边界夹具在 {@link leakPredicateSelfTest},遍历夹具在 {@link leakTraversalSelfTest}。
 * @param css - 编译产物。
 * @param scopes - 允许的作用域根。
 */
export function findLeakedRules(css, scopes = PORT_SCOPES) {
  const leaked = [];
  for (const selector of selectorsInArtifact(css)) {
    if (selector === '' || selector.startsWith('@')) continue;
    if (isScopedSelector(selector, scopes)) continue;
    leaked.push(selector);
  }
  return leaked;
}

/** 插件自己的 `@keyframes` 名字前缀。手写样式表(`styles.ts`)一直用的就是它(`gw-spin`)。 */
export const KEYFRAME_PREFIX = 'gw-';

/**
 * 产物里所有 `@keyframes` 的**名字**。
 *
 * 为什么单独抽出来:`@keyframes` 的名字是**文档全局**的(不是「谁写在作用域块里就归谁」),
 * 而 `findLeakedRules` 按设计**整块跳过** keyframes(它的块体里是 `from`/`to`/`50%`,
 * 不是选择器)。所以这一类**闸门表达不了**,必须有专门断言。
 * 走 `maskComments`:注释里提到 `@keyframes` 只是说明文字。
 * @param css - 编译产物。
 */
export function keyframeNames(css) {
  return [...new Set([...maskComments(css).matchAll(/@keyframes\s+([^\s{]+)/g)].map((one) => one[1]))];
}

/**
 * 名字**没有**插件前缀的 `@keyframes`(空数组 = 全部已命名空间化)。
 * @param css - 编译产物。
 */
export function findUnnamespacedKeyframes(css) {
  return keyframeNames(css).filter((name) => !name.startsWith(KEYFRAME_PREFIX));
}

/**
 * 把上游 partial 里的 `@keyframes` 名字统一加上插件前缀,并**同步改写引用它的
 * `animation` / `animation-name` 声明**。
 *
 * ## 为什么必须改名(这是**真**的全局泄漏,不是洁癖)
 *
 * `@keyframes` 名字不像选择器那样受作用域约束:同名时**文档里最后一个定义赢**,
 * 而我们的 `<style>` 是运行期注入的 ⇒ **总是我们赢**。上游 `ui/_button.scss` 一族写的是
 * `@keyframes spin`,而宿主安装里**也有** `@keyframes spin`
 * (`@agents-anywhere/dsh-bridge-next/lib/index.js:1891` 与
 *  `lib/native-ui/assets/button-BVBZjOE6.css:2`,两条都是 `to{transform:rotate(360deg)}`)。
 * 今天两边**语义相同**所以看不出问题,但这是**运气**:哪天宿主把它改成别的关键帧,
 * 我们就会**静默改掉宿主的动画**。手写样式表(`src/client/styles.ts:218`)一直用
 * `gw-spin`,这里只是把上游那半边也对齐成同一个约定。
 *
 * ## 改写的边界(为什么是 token 级而不是字符串替换)
 *
 * 只动两处:(1) `@keyframes <name> {`;(2) `animation` / `animation-name` 声明**值**里
 * 「整个 token 恰好等于该名字」的位置(逗号或空白分隔,允许 `-webkit-` 前缀属性)。
 * `1s` / `linear` / `infinite` / `both` 这类 token 不会命中,所以简写不会被改坏。
 * **已知边界**:如果哪天有 JS 行内样式直接写 `animation: spin …`,改名会让它对不上 ——
 * 全仓 grep 过,今天没有(唯一的引用是 `iconClassName="spin"`,那是**类名**不是动画名)。
 *
 * @param css - 一段 CSS(某个面的编译产物,或合并产物)。
 * @param names - 要改写的名字集合;默认从 `css` 自己收集**未命名空间化**的那些。
 * @returns {{ css: string, renamed: ReadonlyArray<string> }} 改写结果与实际改掉的名字。
 */
export function namespaceKeyframeNames(css, names = findUnnamespacedKeyframes(css)) {
  const renamed = [...names];
  if (renamed.length === 0) return { css, renamed };
  let out = css;
  for (const name of renamed) {
    const next = `${KEYFRAME_PREFIX}${name}`;
    out = out.replace(new RegExp(`(@keyframes\\s+)${escapeRegExp(name)}(?![\\w-])`, 'g'), `$1${next}`);
    out = out.replace(
      /((?:^|[;{]\s*)(?:-[a-z]+-)?animation(?:-name)?\s*:\s*)([^;}]*)/g,
      (all, head, value) =>
        head + value.replace(new RegExp(`(^|[\\s,])${escapeRegExp(name)}(?![\\w-])`, 'g'), `$1${next}`),
    );
  }
  return { css: out, renamed };
}

/**
 * `namespaceKeyframeNames` 的**双向夹具**(构建期每次跑)。
 *
 * 只测「有没有改」会让「把 `1s` 也改了」通过;只测「没改坏别的 token」会让
 * 「一个都没改」通过。所以两个方向都钉住:正例(名字与引用都要变成带前缀的)、
 * 反例(时长/缓动/循环关键字与其它名字不许被动)。
 *
 * @returns {string[]} 与预期不符的用例(空数组 = 通过)。
 */
export function keyframeNamespaceSelfTest() {
  const bad = [];
  const cases = [
    [
      '@keyframes spin { to { transform: rotate(360deg) } }\n.a { animation: spin 1s linear infinite; }',
      'gw-spin',
    ],
    [
      '@keyframes popover-shake { from { opacity: 0 } }\n.a { animation: popover-shake 0.15s both; }',
      'gw-popover-shake',
    ],
    [
      '@keyframes fade { to { opacity: 1 } }\n.a { animation-name: fade, spin; }',
      'gw-fade',
    ],
    [
      '@keyframes spin { to { transform: rotate(360deg) } }\n.a { -webkit-animation: spin 1s; }',
      'gw-spin',
    ],
  ];
  for (const [css, expected] of cases) {
    const { css: out, renamed } = namespaceKeyframeNames(css);
    if (!renamed.includes(expected.replace(KEYFRAME_PREFIX, ''))) {
      bad.push(`没有收集到待改名的 ${expected}:${JSON.stringify(renamed)}`);
      continue;
    }
    if (!out.includes(`@keyframes ${expected}`)) bad.push(`@keyframes 没改成 ${expected}:${out}`);
    if (new RegExp(`animation[^;{]*[\\s,:]${escapeRegExp(expected.replace(KEYFRAME_PREFIX, ''))}(?![\\w-])`).test(out)) {
      bad.push(`animation 引用没改成 ${expected}:${out}`);
    }
    // 反例:这些 token 一个都不许动
    for (const keep of ['1s', 'linear', 'infinite', 'both', '0.15s']) {
      if (css.includes(keep) && !out.includes(keep)) bad.push(`把 ${keep} 改坏了:${out}`);
    }
    if (findUnnamespacedKeyframes(out).length > 0) bad.push(`改名后仍有未加前缀的名字:${out}`);
  }
  // 已经带前缀的名字必须**幂等**(重复跑不许变成 gw-gw-)
  const idempotent = namespaceKeyframeNames('@keyframes gw-spin { to { opacity: 1 } }\n.a{animation:gw-spin 1s}');
  if (idempotent.renamed.length !== 0 || !idempotent.css.includes('animation:gw-spin 1s')) {
    bad.push(`对已命名的 keyframes 不幂等:${idempotent.css}`);
  }
  return bad;
}

/**
 * 基底配方检查:每个移植面声明的 `requires` 必须真的出现在**它自己的作用域下**。
 *
 * ## 判据形状(别搞错)
 *
 * 作用域在编译产物里**不是一个包裹容器**,而是每条规则的**选择器前缀**:
 * `@import` 被嵌在 `.gw-desktop-diff { ... }` 里,Sass 会把嵌套展平成
 * `.gw-desktop-diff .side-by-side-diff-container { ... }` 这种**平铺**规则。
 * 所以判据是「存在一条顶层规则,它的选择器里,`scope` 是某个部分的**前缀**,
 * 且 `requires` 那个键**真的命中**某个部分(见 `hasPartHit` 的严格判定)」——
 * 而不是「在某个 `{ ... }` 块体里找」。
 *
 * (踩过:一开始按「作用域块体」去找,于是 `.gw-desktop-diff` 的**变量块**被当成
 * 唯一的作用域内容,14 条配方全部误报缺失。)
 *
 * 这条断言是「类名存在 ≠ 规则生效」的机械化防线:它比类名覆盖检查更严 ——
 * 类名覆盖只问「这个类名在产物里有没有」,这里问「**在这个面的作用域下**有没有」。
 * 于是「配方被去重掉」「入口 SCSS 漏 import 某个 partial」都会在构建期失败。
 *
 * ⚠️ **它守不了「配方只沿用了一半」**:本检查的语义是「该类名在作用域下存在」,
 * 不是「该配方完整」。反例:`.blankslate` 的配方在上游 `styles/_globals.scss:120-128`,
 * 键能通过而 8 条声明仍然缺 —— 必须人工读上游那份配方并就地补(2026-10 实测,已补进
 * `src/client/desktop-history.scss`)。
 *
 * ⚠️ `requires` 里**只写这个面渲染路径必然依赖的东西**。上游有的 partial 只在
 * `@media`/`@container` 里出现(例如 `_text-box.scss` 的 `:focus`),那种如果
 * 在**当前视口无关**的分支里,扁平前缀仍然会出现,所以不受影响;
 * 但如果你写了一个上游根本不存在的选择器,构建立刻失败 —— 那是**好事**
 * (说明你猜了名字,而不是 `ls` 核实过)。
 *
 * @param css - 编译产物(合并去重后的那份)。
 */
/**
 * 编译产物里所有**顶层规则**的选择器(逗号已拆开,空白已折叠)。
 *
 * `@media` / `@container` 是**透明容器**:它们内部的规则也会被收进来 ——
 * 作用域前缀在那些规则上同样存在,所以配方检查不该因为「规则恰好写在媒体查询里」而漏判。
 *
 * ⚠️ 必须在**剥掉注释**的文本上走:上游的注释里会原样写出选择器
 * (例如 `_dsh-bridge.scss` 的注释里就有 `.gw-desktop-diff { ... }`),
 * 不剥就会把注释里的文本当成一条规则(这个坑踩过一次,整面配方被误报缺失)。
 * @param css - 编译产物。
 */
function collectFlatSelectors(css) {
  const out = [];
  const visit = (text) => {
    walkRules(text, (head, atRule, start, end) => {
      if (atRule) {
        if (/^@(media|container|supports|layer)/.test(head)) {
          visit(text.slice(text.indexOf('{', start) + 1, end));
        }
        return;
      }
      if (head === '') return;
      for (const one of head.split(',')) {
        const selector = one.replace(/\s+/g, ' ').trim();
        if (selector !== '') out.push(selector);
      }
    });
  };
  visit(stripComments(css));
  return out;
}


export function findMissingRecipes(css) {
  const flat = collectFlatSelectors(css);
  const missing = [];
  for (const surface of PORT_SURFACES) {
    for (const wanted of Object.keys(surface.requires)) {
      /*
       * 判据是「**在这个面的作用域下**存在一条规则命中这个选择器」,而不是
       * 「选择器必须以 <scope> <wanted> 开头」。真实的产物长这样:
       *   `.gw-repo-list .repository-list .repository-list-item { … }`
       *   `.gw-desktop-diff .side-by-side-diff-container .row { … }`
       * —— required 的选择器是链条里的**一段**,前面还有别的祖先。
       * 所以先把作用域根从选择器里去掉,再在剩下的文本里按**token 边界**找 wanted。
       */
      const hit = flat.some((selector) => matchesScopedSelector(selector, surface.scope, wanted));
      if (!hit) missing.push({ surface: surface.id, selector: wanted, why: surface.requires[wanted] });
    }
  }
  if (flat.length === 0) {
    missing.push({ surface: '(all)', selector: '(编译产物里没有任何顶层规则)' });
  }
  return missing;
}

/**
 * 是否「选择器链里存在一段,它同时命中 `scope` 与 `wanted`」。
 *
 * ## 为什么按「部分」判,而不是在整串文本里找子串
 *
 * 产物里的选择器是**复合**的:
 *   `.gw-desktop-diff .side-by-side-diff-container .row.hunk-info { … }`
 * 要断言的 `wanted` 可能是 `.hunk-info` —— 它前面紧挨着 `.row`,**没有任何**分隔符。
 * 如果在整串里按「前一个字符必须是空白」去找,就会漏判(踩过:`.hunk-info` 明明在产物里
 * 出现 10 次,却被报成缺失)。
 *
 * 反过来,如果**不讲边界**地找子串,`.no-item` 会命中 `.no-items` —— 假通过,
 * 正是本检查要防的那类静默错误。
 *
 * 所以:先把选择器按**组合子/亲属分隔符**(空白、`>`、`+`、`~`、`,`)切成「部分」,
 * 再要求 `scope` 作为某个部分的**前缀**出现(部分内部的 `.a.b` 是复合,前缀匹配
 * 正好是我们要的语义),而 `wanted` 用 `hasPartHit` **严格**判定 ——
 * 只被**另一个类的前缀**命中的键算缺失(实测:`.commit-list-item` vs
 * `.commit-list-item-tooltip`、`.commit-attribution` vs `.commit-attribution-component`)。
 * `.no-item` 不是任何部分的命中(`.no-items` 才是),于是正确判为缺失。
 *
 * @param selector - 一条完整选择器。
 * @param scope - 作用域根(如 `.gw-repo-list`)。
 * @param wanted - `requires` 里声明的选择器(如 `.repository-list-item`)。
 */
function matchesScopedSelector(selector, scope, wanted) {
  return hasPartPrefix(selector, scope) && hasPartHit(selector, wanted);
}

/**
 * 是否存在一个部分,它**真的命中** `wanted`(而不是「另一个类的前缀」)。
 *
 * ## 为什么不能只用前缀匹配(实测踩到,2026-10 修)
 *
 * 旧实现是 `part.startsWith(wanted)`,于是:
 *   - `.commit-list-item` 被 `.commit-list-item-tooltip`(上游
 *     `history/_commit-list.scss:191`)**假通过** —— 而真正的行类名是 `.commit`;
 *   - `.commit-attribution` 被 `.commit-attribution-component`(上游
 *     `_commit-attribution.scss:3`)**假通过** —— 键只是它多一个的严格前缀。
 * ⇒ 那条 `requires` 看起来在守卫、其实什么都没守(§7.1 同一族)。
 *
 * ## 判据
 *
 * 部分与 `wanted` **完全相等**,或者 `wanted` 之后紧跟的字符不是类名 token 的一部分
 * (`-` / `_` / 字母 / 数字)。第二种是为了保留「复合/伪类选择器」的合法命中:
 * `.row.hunk-info` 让 `.row` 命中、`.diff-contents-warning:not(:last-child)` 让
 * `.diff-contents-warning` 命中 —— 因为后面跟的是 `.` / `:`。
 *
 * @param {string} selector - 一条完整选择器。
 * @param {string} wanted - `requires` 里声明的选择器(单个部分)。
 */
function hasPartHit(selector, wanted) {
  for (const part of selector.split(/[\s>+~,]+/)) {
    if (part === wanted) return true;
    if (!part.startsWith(wanted)) continue;
    const next = part.charAt(wanted.length);
    /*
     * `next === ''` 意味着 `part === wanted`,上面已经返回过了;
     * 走到这里 next 一定非空,紧跟 `-`/`_`/字母/数字 = 那是**另一个类**。
     */
    if (next !== '' && !/[A-Za-z0-9_-]/.test(next)) return true;
  }
  return false;
}

/**
 * 选择器里是否存在一个部分,以 `needle` 为前缀。
 * @param selector - 一条完整选择器。
 * @param needle - 目标片段。
 */
function hasPartPrefix(selector, needle) {
  for (const part of selector.split(/[\s>+~,]+/)) {
    if (part.startsWith(needle)) return true;
  }
  return false;
}

/**
 * 从 TSX 源码里提取「用到的类名」。
 *
 * 证据分两级:`className=` / `classNames(...)` 这类**语法上就是类名**的上下文,
 * 以及 kebab-case 的裸字符串(上游大量用 `octicons.repo` 之外的 `'filter-list'` 常量)。
 * PascalCase 一律当成组件名/文案,不当类名(react-virtualized 的 `ReactVirtualized__Grid` 例外)。
 * @param source - TSX/TS 源码。
 */
export function classNamesUsedIn(source) {
  const out = new Set();
  // 先剥注释:注释里提到某个类名只是说明文字
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const strong = [];
  for (const m of text.matchAll(/className\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\})/g)) {
    strong.push(m[1] ?? m[2] ?? m[3] ?? '');
  }
  for (const m of text.matchAll(/classNames\s*\(([\s\S]*?)\)/g)) strong.push(m[1]);
  for (const chunk of strong) {
    for (const m of chunk.matchAll(/['"`]([^'"`]+)['"`]/g)) {
      for (const token of m[1].split(/\s+/)) if (token !== '') out.add(token);
    }
  }
  return out;
}

/**
 * 从 TSX 源码里提取**候选**类名(强证据 + 松证据)。
 *
 * 强证据(`className=` / `classNames(...)` 里的字符串)一律采信 —— 那些**语法上就是类名**。
 * 松证据(任意字符串字面量里 kebab-case 的 token)只是**候选**:上游大量把类名当常量写
 * (`const className = 'repository-list-item'`),但也把事件名、aria 属性、库名写成同样的形状。
 * 所以松候选**是否成立由调用方拿编译产物去核**(见 `classCoverage`)。
 *
 * 这条规则是修一次误报改出来的:按「松证据全采信」统计时,`repo-bar` 这个面的
 * 264 个「用到的类名」里有 **143 个是噪声**(`click` / `aria-labelledby` /
 * `react-dom` / `mousedown` / `utf8` / `dxt1` …),覆盖率被稀释成 40%,
 * 数字不再指向任何真实缺陷。
 * @param source - TSX/TS 源码。
 */
export function classCandidatesIn(source) {
  const strong = classNamesUsedIn(source);
  const loose = new Set();
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const m of text.matchAll(/['"`]([a-zA-Z][a-zA-Z0-9_-]*)['"`]/g)) {
    const token = m[1];
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(token) || token.length < 2) continue;
    if (/^[A-Z]/.test(token) && !token.includes('__')) continue;
    loose.add(token);
  }
  return { strong, loose };
}

// ---------- 主流程 ----------

/**
 * 编译所有移植面的 SCSS(顶层、不包裹作用域根)→ 产物前缀化 → 结构断言 → 合并去重 →
 * 写成浏览器端模块。
 * @returns 编译产物与统计(给调用方打印与后续检查用)。
 */
export async function buildPortStyles() {
  const compiled = [];
  for (const surface of PORT_SURFACES) {
    const { css } = sass.compile(surface.entry, {
      style: 'expanded',
      // Sass 正在弃用 @import(改为 @use),但上游 partial 的 `&` 语义与变量可见性
      // 我们要逐字保留(「对齐优先」),所以继续用 @import,这条弃用警告是预期的,静音。
      logger: sass.Logger.silent,
    });
    /*
     * 作用域**不在 SCSS 里**加 —— 编译在顶层做,`&` 按上游语义展开;前缀化在这里,
     * 对编译产物逐条顶层选择器做。这样 `&.switch &-item` 才会得到
     * `.tab-bar.switch .tab-bar-item`(而不是把第二个 `&` 换成整条父选择器)。
     */
    compiled.push({ surface, css: prefixTopLevelSelectors(css, surface.scope) });
  }

  /**
   * ⚠️ `@charset` 必须**只在样式表最开头出现一次**。
   *
   * 每个面的 Sass 产物各自带一条 `@charset "UTF-8";`,而它是 `;` 结尾的**语句**、
   * 不是 `头部 { 块体 }` 项(见 `topLevelItems` 的说明),所以前缀化根本不碰它,
   * 它就原样站在该面产物的缝里。6 个面合并 ⇒ 产物里 6 条 `@charset`,**第 2 条起全部非法**
   * (规范要求它是样式表的第一条语句)。浏览器走 CSS 错误恢复:可能只是忽略,
   * **也可能把紧随其后的那条规则一起吞掉** —— 而每条 `@charset` 后面紧跟着的,
   * 正是一个**新作用域面的首条规则**。所以这里全部剥掉,只在最前面留一条。
   *
   * 写成「剥掉再补一条」而不是「保留第一条」:面的编译顺序不是语义,不该靠它决定
   * 哪条 `@charset` 活下来;而且剥干净后产物里**只有一个真理源**。
   * @param css - 单个面的编译产物。
   */
  const stripCharset = (css) => css.replace(/@charset\s+["'][^"']*["']\s*;/gi, '');

  // 断言跑在**去重前**的产物上:去重只删重复规则,不影响「在不在」。
  const combinedRaw = ['@charset "UTF-8";', ...compiled.map((one) => stripCharset(one.css))].join('\n');
  /*
   * 先跑**判据自检夹具**(`isScopedSelector` 的边界 + 组 at-rule 的遍历)。
   * 它们是硬门禁的判据本身,判据坏了的话「0 条 leaked」就毫无意义 ——
   * 所以夹具失败必须比样式缺陷**先**报出来。
   */
  const predicateFailures = leakPredicateSelfTest();
  if (predicateFailures.length > 0) {
    throw new Error(
      'findLeakedRules 的判据自检失败(leakPredicateSelfTest):' +
        `以下选择器的判定与预期不符 —— ${predicateFailures.join(' / ')}。` +
        '这表示作用域形状判据(isScopedSelector)被改坏了,先修它再谈样式。',
    );
  }
  const traversalFailures = leakTraversalSelfTest();
  if (traversalFailures.length > 0) {
    throw new Error(
      'findLeakedRules 的**遍历**自检失败(leakTraversalSelfTest):' +
        `以下夹具与预期不符 —— ${traversalFailures.join(' / ')}。` +
        '这表示「产物里哪些位置的规则会被检查」坏了(历史上 @media 块体整个是盲区),先修它再谈样式。',
    );
  }
  const keyframeFixtureFailures = keyframeNamespaceSelfTest();
  if (keyframeFixtureFailures.length > 0) {
    throw new Error(
      'keyframes 命名空间化的判据自检失败(keyframeNamespaceSelfTest):' +
        `以下夹具与预期不符 —— ${keyframeFixtureFailures.join(' / ')}。`,
    );
  }
  /*
   * `@keyframes` 名字是**文档全局**的,必须加插件前缀 —— 见 `namespaceKeyframeNames` 的注释
   * (上游写 `spin`,宿主安装里也有 `@keyframes spin`,同名时后注入的我们赢)。
   * 改名要**跨面**做:名字与引用可能落在不同的移植面里,所以收集名字时看合并产物、
   * 改名也改合并产物,再让后面所有断言/去重/写出都用改名后的那一份。
   */
  const keyframesRenamed = [...new Set(compiled.flatMap((one) => findUnnamespacedKeyframes(one.css)))];
  const combined = namespaceKeyframeNames(combinedRaw, keyframesRenamed).css;
  const stillUnnamespaced = findUnnamespacedKeyframes(combined);
  if (stillUnnamespaced.length > 0) {
    throw new Error(
      '`@keyframes` 名字空间化之后仍有未加前缀的名字:' +
        `${stillUnnamespaced.join(' / ')}。名字是文档全局的,与宿主同名会**静默接管宿主的动画**;` +
        '改 `namespaceKeyframeNames` 或在上游 partial 之外补一条映射,不要放过。',
    );
  }
  const leaked = findLeakedRules(combined);
  const missingRecipes = findMissingRecipes(combined);
  const doubleScoped = findDoubleScopedSelectors(combined);
  const rootAfterScope = findRootAfterScopeSelectors(combined);
  const foreign = [];
  const unboundVariables = [];
  for (const { surface, css } of compiled) {
    for (const one of findForeignScopedSelectors(css, surface.scope)) {
      foreign.push({ surface: surface.id, ...one });
    }
    for (const one of findUnboundVariables(css, surface.scope, { portalHost: surface.portalHost === true })) {
      unboundVariables.push({ surface: surface.id, portalHost: surface.portalHost === true, ...one });
    }
  }

  const dedupe = dedupeIdenticalTopLevelRules(combined);
  const deduped = dedupe.css;

  /*
   * 去重是**文本级删除**,不可能新增结构问题;真出现说明删除切坏了产物 —— 必须失败
   * (宁可留下冗余,也不要静默改坏 CSS)。
   */
  leaked.push(...findLeakedRules(deduped).map((one) => `${one} (去重后)`));
  for (const one of findDoubleScopedSelectors(deduped)) {
    doubleScoped.push({ ...one, afterDedupe: true });
  }
  for (const one of findRootAfterScopeSelectors(deduped)) {
    rootAfterScope.push({ ...one, afterDedupe: true });
  }

  const body = [
    '/**',
    ' * **生成物,不要手改。**',
    ' *',
    ' * 由 `scripts/build.mjs` 遍历 `scripts/styles.mjs` 的 `PORT_SURFACES` 表,',
    ' * 用 Dart Sass **在顶层**编译每个移植面的入口 SCSS(逐字编译上游 GitHub Desktop',
    ' * 的样式表,这样上游 `&` 的语义不会被改写),再在**编译产物**上给每条顶层选择器',
    ' * 加上该面的作用域根;`@keyframes`/`@font-face` 的块体不动,`:root` 换成作用域根,',
    ' * `html`/`body` 的前缀插在它们之后。合并后删掉逐字相同的定义式 at-rule 与空规则块。',
    ' *',
    ' * 改样式请改 SCSS 源(`src/client/scss/*.scss`);要新增一个移植面,',
    ' * 在 `scripts/styles.mjs` 的 `PORT_SURFACES` 里加一条表项,别改 build.mjs。',
    ' *',
    ...PORT_SURFACES.map((surface) => ` *  - ${surface.scope} ← ${surface.entry}(${surface.id})`),
    ' * @module dsh-git/client/desktop-diff-styles.generated',
    ' */',
    '',
    `/** 编译后的 CSS:${PORT_SURFACES.length} 个移植面,已作用域化,已把所有 Desktop 主题变量桥到 DSH 令牌。 */`,
    `export const ${CSS_EXPORT_NAME}: string = ${JSON.stringify(deduped)};`,
    '',
  ].join('\n');
  await writeFile(STYLE_MODULE, body);

  return {
    css: deduped,
    leaked,
    missingRecipes,
    doubleScoped,
    rootAfterScope,
    foreign,
    unboundVariables,
    dedupedRulesRemoved: dedupe.removed,
    dedupedRuleHeads: dedupe.heads,
    dedupedBytes: dedupe.bytes,
    keptIdenticalRules: dedupe.keptIdentical,
    /** 被加上 `gw-` 前缀的 `@keyframes` 名字(证据:名字是文档全局的,必须命名空间化)。 */
    keyframesRenamed,
    surfaces: PORT_SURFACES.length,
    scopes: PORT_SCOPES,
  };
}

/**
 * 类覆盖率统计。取样来源是**所有**移植面的 `usageFiles`(并集)。
 * @param css - 编译产物。
 */
export async function classCoverage(css) {
  const strong = new Set();
  const loose = new Set();
  for (const surface of PORT_SURFACES) {
    for (const file of await expandUsageFiles(surface.usageFiles ?? [])) {
      try {
        const candidates = classCandidatesIn(await readFile(file, 'utf8'));
        for (const token of candidates.strong) strong.add(token);
        for (const token of candidates.loose) loose.add(token);
      } catch {
        // 文件不存在(镜像裁剪)就跳过
      }
    }
  }
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const presentInCss = new Set([...stripped.matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]*)/g)].map((m) => m[1]));
  /*
   * 「用到的类名」的**判据**(这里改过一次,理由必须留下):
   *
   * `used = 强证据 ∪ (松候选 ∩ 产物里真的出现过的类名)`。
   *
   * 为什么松候选要拿产物过滤:不滤的话,repo-bar 面会多出 143 个**不是类名**的东西
   * (`click` / `mousedown` / `aria-labelledby` / `react-dom` / `utf8` / `dxt1` …),
   * 覆盖率被稀释,数字不再指向真实缺陷。
   * 为什么要保留「松候选 ∩ 产物」这一半:它正是最有价值的那部分 ——
   * `repositories-list.tsx` 的 `'filter-list-group-header'`、`repository-list-item.tsx`
   * 的 `'repository-list-item'` 都是裸字符串,如果只统计强证据,这两个**真实存在且已着色**
   * 的类就进不了分母;而它们的价值恰恰是「证明上游那些类已经有规则了」。
   *
   * 换句话说:这个指标只回答一个问题 ——「**我们用到的、有样式可言的类名,有多少真的上了色**」。
   * 它**不是**「所有字符串常量」的账。
   */
  const used = new Set(strong);
  for (const token of loose) if (presentInCss.has(token)) used.add(token);
  const missing = [...used].filter((token) => !presentInCss.has(token)).sort();
  const explained = missing.filter((token) => CLASS_EXCEPTIONS.has(token));
  const unexplained = missing.filter((token) => !CLASS_EXCEPTIONS.has(token));
  return {
    used, presentInCss, missing, explained, unexplained,
    strongCount: strong.size,
    loosePresentCount: used.size - strong.size,
    covered: used.size - missing.length,
    total: used.size,
  };
}

/** 一个移植面在覆盖率报告里的取样文件数(给人看的规模感)。 */
export async function usageFileCount(surface) {
  return (await expandUsageFiles(surface.usageFiles ?? [])).length;
}
