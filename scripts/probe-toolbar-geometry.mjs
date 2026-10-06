/**
 * 顶栏几何探针:用**真产物 CSS** + **与真实渲染树同构的 DOM** + 真 headless Chrome 量几何。
 *
 * ## 为什么这么写(两条都在 docs/probes/README-generated-css.md 里被踩过)
 *
 * 1. **产物 CSS 用 `import()` 取,绝不反引号截取**。`desktop-diff-styles.generated.ts` 导出的是
 *    双引号 JS 字符串(`\n` 转义),反引号截取会拿到「长度接近但内容坏掉」的 CSS,
 *    `.foldout` 的背景与 `pop-width` 都会静默失效 ⇒ 量出**错的数字**。这里顺带断言
 *    「没有字面量 `\n`」并把字节数与真值对照打印出来。
 * 2. **DOM 必须与真实渲染树同构**:`.gw-toolbar #desktop-app-toolbar` 要求 `#desktop-app-toolbar`
 *    是 `.gw-toolbar` 的**后代**;`#foldout-container` 挂在该段 `.toolbar-dropdown` 之下。
 *    层次错了,整族规则不匹配 —— 上一轮就是这么拿到错数字的。
 *
 * ## 这个探针量什么(2026-10-06 那条「header 的边距不对」)
 *
 * `.gw-toolbar`(外层包装,`src/client/toolbar.tsx` 的返回值最外层)与
 * `#desktop-app-toolbar`(上游 `Toolbar`)是**两个** flex 容器,而 DSH 的 `.gw-toolbar`
 * 基底规则(`src/client/styles.ts:118` / `styles-base.ts:111`)给的是
 * `display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 12px;
 * flex-wrap:wrap`(≥720px 的容器查询 `styles.ts:216` 再把左右内边距改成 16px)
 * —— 于是上游那条 50px 的通栏(应为「内容宽度、左对齐、无 padding」)被这层包装重新排版。
 * 探针逐区打印 rect / padding / margin / flex / min-width / border。
 *
 * ## variant 的含义(对照组写死在文件里,便于复现「修前 / 修后」)
 *
 * | variant | DOM | 包装层 | 对应用途 |
 * |---|---|---|---|
 * | `current` | 齿轮 / 绿点在**包装层**里(`</ToolbarEl>` 之后) | 原样(带基底 padding/居中) | 复现用户报的坏状态 |
 * | `fixed` | 齿轮 / 绿点进 `#desktop-app-toolbar` | 原样 | 只证明「DOM 归属」这一条 |
 * | `fixed-inline` | 同上 | 中和(无 padding / `align-items:stretch`) | 只证明「包装层中和」这一条 |
 * | `after` | **同上 + `src/client/toolbar.tsx` 现在的写法** | 中和(行内) | 验装配 |
 * | `after-noinline` | 同 `after`,但**删掉行内适配** | 只靠入口 SCSS 的 `&:has(> #desktop-app-toolbar)` | 判「行内适配能不能退休」 |
 * | `after-shrink` | 同上再给 `#desktop-app-toolbar` 一条 `width:100%` | 中和 | 验「待路由的样式项」的效果 |
 *
 * 用法:
 *   node scripts/probe-toolbar-geometry.mjs --variant=after --width=620   # 量一种结构
 *   node scripts/probe-toolbar-geometry.mjs --variant=current --width=620 --shot
 *
 * `--width=<px>` 是**面板宽度**(DSH 右侧栏),不是浏览器窗口宽;真机上是几百 px,
 * 固定成 1100 会量不出窄面板下绿点换行/段被挤扁那类缺陷。`--shot` 另存一张 PNG。
 *
 * 退出码:0 = 量到了;1 = Chrome/文件问题(绝不把「没量到」当通过)。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { DESKTOP_DIFF_CSS } = await import('../src/client/desktop-diff-styles.generated.ts');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = join(tmpdir(), 'dsh-git-toolbar-probe');
mkdirSync(OUT, { recursive: true });

const variantArg = process.argv.find((a) => a.startsWith('--variant='));
const variant = variantArg === undefined ? 'current' : variantArg.slice('--variant='.length);

/** 面板宽度 = DSH 右侧栏宽度。真机上是几百 px ⇒ 必须按真实宽度量,不能固定 1100。 */
const widthArg = process.argv.find((a) => a.startsWith('--width='));
const panelWidth = widthArg === undefined ? 1100 : Number(widthArg.slice('--width='.length));

/* ---------- 产物 CSS:import() 取,并证明它没坏 ---------- */
if (DESKTOP_DIFF_CSS.includes('\\n')) {
  throw new Error('产物 CSS 含字面量 \\n ⇒ 取法错了(见 docs/probes/README-generated-css.md)');
}
console.log(`[probe] DESKTOP_DIFF_CSS = ${Buffer.byteLength(DESKTOP_DIFF_CSS)} B;字面量 \\n = false`);
console.log(`[probe] variant = ${variant};panelWidth = ${panelWidth}`);

/* ---------- 基底样式:styles.ts 的模板字面量(仓库自己用同样方式取) ---------- */
const stylesTs = await (await import('node:fs/promises')).readFile(
  new URL('../src/client/styles.ts', import.meta.url),
  'utf8',
);
const baseCss = stylesTs
  .slice(stylesTs.indexOf('const CSS = `') + 'const CSS = `'.length, stylesTs.lastIndexOf('`'))
  .replace(/var\(--gw-mono\)/g, 'var(--gw-mono,ui-monospace,SFMono-Regular,Menlo,monospace)');

/* ---------- 宿主令牌:手搭(只覆盖顶栏闭包真的用到的那些) ---------- */
/*
 * ⚠️ **不要在这里手搭 `--dsw-alias-*`**(2026-10-06 实测到的探针自身缺陷)。
 *
 * 第一版这里是一坨**裸声明**(`--dsw-alias-bg-layer-1:#1b1c1f; …`)塞进 `<style>` ——
 * 裸声明没有选择器 ⇒ **一条都不生效**(CSS 解析器把整块当垃圾丢弃),于是
 * 每一个 `var(--dsw-alias-*)` 都解析失败,并顺着 `var()` 链一路传染:
 *
 * | 量 | 裸声明版(错) | 用产物自带令牌(对) |
 * |---|---|---|
 * | `.gw-toolbar` 的 `--background-color` | `''`(空) | `#1b1c1f` |
 * | `.foldout` 的 computed `background-color` | `rgba(0,0,0,0)` | `rgb(27,28,31)` |
 * | `.foldout` 的 `--background-color` | `''` | `#1b1c1f` |
 *
 * ⇒ 会**谎报「浮层没有底色」**(而 README-generated-css.md 里那次反引号截取是同一个
 * 失败模式:探针给出数字,但数字是错的)。证据链:`.foldout` 的规则
 * `.gw-toolbar #foldout-container .foldout{background:var(--background-color)}`
 * 在 live stylesheet 里**存在且 `matches()===true`**,而 `--foldout-z-index`(字面量 17)
 * 解析正常、只有 `var()` 链断掉 ⇒ 断点在令牌,不在选择器。
 *
 * 结论:**产物自己已经把全部令牌声明好了** —— `desktop-changes.scss` 的 `.gw-root`
 * 块 + 各面的 `@include dsh-desktop-bridge` 都发 `:root`/`.gw-root` 规则。
 * 之前那 5 分钟里我拿的 `--toolbar-height`/`--spacing`(字面量)能解析、`var()` 链不能,
 * 这正好是判据。所以这里**故意留空**:任何需要令牌的断言,一律断言在**产物**上,
 * 而不是断言在我们自己搭的假令牌上(README 第 1 条:手搭令牌只能判「有/无/谁提供」)。
 */
/**
 * 探针的焦点元素上要有的**假宿主令牌**。
 *
 * ⚠️ **必须有选择器**:裸声明(没有 `:root`)会被 CSS 解析器整块丢掉 ⇒ 每个
 * `var(--dsw-alias-*)` 都解析失败,并顺着 `var()` 链传染到
 * `.foldout{background:var(--background-color)}` ⇒ 探针会**谎报「浮层没有底色」**。
 * 第一版就是这么错的(2026-10-06):`.gw-toolbar` 的 `--background-color` 量到空串、
 * `.foldout` 的 computed 底色量到 `rgba(0,0,0,0)`,而那条规则在 live stylesheet 里
 * **存在且 `matches()===true`** —— 断点在令牌链,不在选择器。判据:同一棵树上
 * **字面量**能解析(`--foldout-z-index` = 17)、**只有 `var()` 链**断掉。
 *
 * 注意这些令牌**只服务于本探针**:产物自己不发 `:root` 令牌(它们由宿主的主题层运行时提供),
 * 所以这里按 `vendor/desktop/README.md` 的映射表手搭一小撮。手搭令牌只能判
 * 「有 / 无 / 谁提供」,不能判「对不对」(docs/probes/README-generated-css.md)。
 * 另外 `tokenChainHealthy` 每个 variant 都会自证一次这条链通不通。
 */
const HOST_TOKENS = `
:root {
  --dsw-alias-bg-layer-1:#1b1c1f; --dsw-alias-bg-layer-2:#232427; --dsw-alias-bg-layer-3:#2b2c30;
  --dsw-alias-bg-overlay:rgba(0,0,0,.4); --dsw-alias-bg-multi-select:#2f3550;
  --dsw-alias-border-l1:#3a3b3f; --dsw-alias-border-l2:#2e2f33;
  --dsw-alias-label-primary:#e8e8ea; --dsw-alias-label-secondary:#a8a9ad;
  --dsw-alias-label-tertiary:#7c7d81; --dsw-alias-label-primary-inverted:#16171a;
  --dsw-alias-interactive-bg-hover:#303136; --dsw-alias-brand-primary:#4d6bfe;
  --dsw-alias-brand-primary-invert:#ffffff; --dsw-alias-tooltip-bg:#2b2c30;
  --dsw-alias-state-success-primary:#33c46a; --dsw-alias-state-warn-primary:#e0a33a;
  --dsw-alias-state-error-primary:#e5534b; --dsw-alias-state-business-primary:#8b7bf7;
  --gw-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
body { background: #1b1c1f; }`;

/* ---------- 与真实渲染树同构的 DOM ----------
 * 真实树(src/client/toolbar.tsx + 镜像 ui/toolbar/{dropdown,button}.tsx):
 *   .gw-root
 *     .gw-toolbar.tooltip-host                       ← styles.ts:118 的基底规则打在这里
 *       #desktop-app-toolbar.toolbar                 ← 上游 Toolbar
 *         .sidebar-section  (① 当前仓库,ToolbarDropdown)
 *         .toolbar-dropdown (② 当前分支)
 *         .toolbar-button.push-pull-button (③ 推送,ToolbarDropdown 的 MultiOption 形态)
 *         .toolbar-button   (gear)
 *         span.gw-dot
 *   下游 .toolbar-button 内部:button > svg.octicon.icon + .text>(.description+.title) [+ .dropdownArrow]
 */
const ICON = (cls = '') =>
  `<svg class="octicon octicon-git-branch icon ${cls}" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M0 0h16v16H0z"/></svg>`;

/** 左栏宽:`repo-bar.tsx:useLeftPaneWidth()` 把实测左栏宽写成这一段的行内 width。 */
const leftPaneWidth = Math.max(200, Math.min(420, Math.round(panelWidth * 0.44)));

function repoSection() {
  return `
  <div class="sidebar-section" style="width:${leftPaneWidth}px">
    <div class="toolbar-dropdown resizable foldout-style closed">
      <div class="toolbar-button">
        <button type="button">
          ${ICON()}
          <div class="text">
            <div class="description">当前仓库</div>
            <div class="title">dsh-git</div>
          </div>
          <svg class="octicon octicon-triangle-down dropdownArrow" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M0 0h16v16H0z"/></svg>
        </button>
      </div>
      <div id="foldout-container"><div class="overlay"></div><div class="foldout"></div></div>
    </div>
  </div>`;
}

function branchSection() {
  return `
  <div class="toolbar-dropdown resizable foldout-style closed">
    <div class="toolbar-button">
      <button type="button">
        ${ICON()}
        <div class="text">
          <div class="description">当前分支</div>
          <div class="title">main</div>
        </div>
        <svg class="octicon octicon-triangle-down dropdownArrow" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M0 0h16v16H0z"/></svg>
      </button>
    </div>
    <div id="foldout-container"><div class="overlay"></div><div class="foldout"></div></div>
  </div>`;
}

/** ③ 同步段:上游 `push-pull-button.tsx` 的 MultiOption 下拉 = `.toolbar-dropdown` 里两个 `.toolbar-button`。 */
function syncSection() {
  return `
  <div class="toolbar-dropdown resizable multi-option-style closed push-pull-button">
    <div class="toolbar-button push-pull-button resizable">
      <button type="button" aria-label="推送、拉取、抓取选项">
        ${ICON()}
        <div class="text">
          <div class="title">抓取 origin</div>
          <div class="description">上次抓取 3 分钟前</div>
        </div>
        <div class="ahead-behind"><span>1<svg class="octicon" viewBox="0 0 16 16" width="10" height="16" aria-hidden="true"><path d="M0 0h16v16H0z"/></svg></span></div>
      </button>
    </div>
    <div class="toolbar-button toolbar-dropdown-arrow-button resizable">
      <button type="button" aria-label="推送、拉取、抓取选项">
        <svg class="octicon octicon-triangle-down dropdownArrow" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M0 0h16v16H0z"/></svg>
      </button>
    </div>
    <div id="foldout-container"><div class="overlay"></div><div class="foldout"></div></div>
  </div>`;
}

function gearAndDot() {
  return `
    <div class="toolbar-button">
      <button type="button" aria-label="更多">${ICON()}</button>
    </div>
    <span class="gw-dot ok" title="已登录"></span>`;
}

const innerToolbar = `
      <div id="desktop-app-toolbar" class="toolbar">
        ${repoSection()}
        ${branchSection()}
        ${syncSection()}
        ${gearAndDot()}
      </div>`;

/* -------- current:gear / dot 在 `.gw-toolbar` 包装层里(toolbar.tsx:293-309 今天的样子) -------- */
const currentTree = `
  <div class="gw-root">
    <div class="gw-toolbar tooltip-host">
      ${innerToolbar}
    </div>
  </div>`;

/* -------- open:展开态。`dropdown.tsx` 打开时把面板挂在该段之下 --------
   `#foldout-container` 的 `position:fixed;top:rect.bottom;height:calc(100% - rect.bottom)` 与
   `.foldout` 的 `marginLeft/top/height/width` 全是 `dropdown.tsx:366-407` 的**行内 style**
   (探针不复刻它就会量到 `height:0` 的假值 —— 这正是本探针之前的盲区)。 */
function repoSectionOpen() {
  return `
  <div class="sidebar-section" style="width:${leftPaneWidth}px">
    <div class="toolbar-dropdown resizable foldout-style open">
      <div class="toolbar-button">
        <button type="button">
          ${ICON()}
          <div class="text">
            <div class="description">当前仓库</div>
            <div class="title">dsh-git</div>
          </div>
          <svg class="octicon octicon-triangle-down dropdownArrow" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M0 0h16v16H0z"/></svg>
        </button>
      </div>
      <div id="foldout-container" style="position:fixed;left:0;right:0;top:50px;height:calc(100% - 50px);width:100%">
        <div class="overlay" style="position:fixed;top:50px;left:0;right:0;bottom:0;height:calc(100% - 50px)"></div>
        <div class="foldout" style="position:absolute;margin-left:0;left:0;top:0;height:100%;width:${leftPaneWidth}px">
          <div class="repository-list"><div class="repository-list-item">dsh-git</div></div>
        </div>
      </div>
    </div>
  </div>`;
}

const openTree = `
  <div class="gw-root">
    <div class="gw-toolbar tooltip-host">
      <div id="desktop-app-toolbar" class="toolbar">
        ${repoSectionOpen()}
        ${branchSection()}
        ${syncSection()}
        <div class="toolbar-button">
          <button type="button" aria-label="更多">${ICON()}</button>
        </div>
        <span class="gw-dot ok" style="align-self:center" title="已登录"></span>
      </div>
    </div>
  </div>`;

/* -------- fixed:gear / dot 回到 `#desktop-app-toolbar` 内(上游的 DOM 归属) -------- */
const fixedTree = `
  <div class="gw-root">
    <div class="gw-toolbar tooltip-host">
      <div id="desktop-app-toolbar" class="toolbar">
        ${repoSection()}
        ${branchSection()}
        ${syncSection()}
        ${gearAndDot()}
      </div>
    </div>
  </div>`;

/* -------- fixed-inline:同上,再把包装层自己的 flex/padding 中和掉(行内 style 适配) -------- */
const WRAPPER_RESET =
  'padding:0;align-items:stretch;justify-content:flex-start;flex-wrap:nowrap;gap:0';
const fixedInlineTree = `
  <div class="gw-root">
    <div class="gw-toolbar tooltip-host" style="${WRAPPER_RESET}">
      <div id="desktop-app-toolbar" class="toolbar">
        ${repoSection()}
        ${branchSection()}
        ${syncSection()}
        ${gearAndDot()}
      </div>
    </div>
  </div>`;

/* -------- after-noinline:装配 = 现在的代码,**但删掉行内 TOOLBAR_WRAPPER_STYLE** --------
   (用来回答「`:has()` 中和规则上线后,那支行内适配还需不需要」;其余结构一字不改) */
const afterNoInlineTree = `
  <div class="gw-root">
    <div class="gw-toolbar tooltip-host">
      <div id="desktop-app-toolbar" class="toolbar">
        ${repoSection()}
        ${branchSection()}
        ${syncSection()}
        <div class="toolbar-button">
          <button type="button" aria-label="更多">${ICON()}</button>
        </div>
        <span class="gw-dot ok" style="align-self:center" title="已登录"></span>
      </div>
    </div>
  </div>`;

/* -------- after:2026-10 修复后的真实结构(gear/dot 进 `#desktop-app-toolbar` + 包装层中和) -------- */
const afterTree = `
  <div class="gw-root">
    <div class="gw-toolbar tooltip-host" style="${WRAPPER_RESET}">
      <div id="desktop-app-toolbar" class="toolbar">
        ${repoSection()}
        ${branchSection()}
        ${syncSection()}
        <div class="toolbar-button">
          <button type="button" aria-label="更多">${ICON()}</button>
        </div>
        <span class="gw-dot ok" style="align-self:center" title="已登录"></span>
      </div>
    </div>
  </div>`;

/* -------- after-shrink:再给 `#desktop-app-toolbar` 一条 `width:100%`(待路由的样式项) -------- */
const afterShrinkTree = `
  <div class="gw-root">
    <div class="gw-toolbar tooltip-host" style="${WRAPPER_RESET}">
      <div id="desktop-app-toolbar" class="toolbar" style="width:100%">
        ${repoSection()}
        ${branchSection()}
        ${syncSection()}
        <div class="toolbar-button">
          <button type="button" aria-label="更多">${ICON()}</button>
        </div>
        <span class="gw-dot ok" style="align-self:center" title="已登录"></span>
      </div>
    </div>
  </div>`;

const tree =
  variant === 'fixed' ? fixedTree
  : variant === 'fixed-inline' ? fixedInlineTree
  : variant === 'open' ? openTree
  : variant === 'after' ? afterTree
  : variant === 'after-noinline' ? afterNoInlineTree
  : variant === 'after-shrink' ? afterShrinkTree
  : currentTree;

/* ---------- 量测脚本(在页面里跑,--dump-dom 把 JSON 带回来) ---------- */
const MEASURE = `
<script>
function box(el) {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  return {
    rect: { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2),
            top: +r.top.toFixed(2), bottom: +r.bottom.toFixed(2), right: +r.right.toFixed(2) },
    display: cs.display, position: cs.position,
    padding: cs.padding, margin: cs.margin,
    height: cs.height, width: cs.width,
    flex: cs.flex, flexGrow: cs.flexGrow, flexShrink: cs.flexShrink, flexBasis: cs.flexBasis,
    alignItems: cs.alignItems, alignSelf: cs.alignSelf, justifyContent: cs.justifyContent,
    flexDirection: cs.flexDirection, flexWrap: cs.flexWrap, gap: cs.gap,
    borderRight: cs.borderRightWidth + ' ' + cs.borderRightStyle + ' ' + cs.borderRightColor,
    borderBottom: cs.borderBottomWidth + ' ' + cs.borderBottomStyle + ' ' + cs.borderBottomColor,
    overflow: cs.overflow, minWidth: cs.minWidth, maxWidth: cs.maxWidth, boxSizing: cs.boxSizing, flexShrinkRaw: cs.flexShrink,
    fontFamily: cs.fontFamily.slice(0, 30), fontSize: cs.fontSize,
    color: cs.color, backgroundColor: cs.backgroundColor,
    lineHeight: cs.lineHeight, objectFit: cs.objectFit,
  };
}
const q = (s) => document.querySelector(s);
const results = {
  viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
  regions: {
    'gw-root': box(q('.gw-root')),
    'gw-toolbar(wrapper)': box(q('.gw-toolbar')),
    '#desktop-app-toolbar': box(q('#desktop-app-toolbar')),
    'sidebar-section(① repo cell)': box(q('.sidebar-section')),
    'repo .toolbar-dropdown': box(q('.sidebar-section .toolbar-dropdown')),
    'repo .toolbar-button': box(q('.sidebar-section .toolbar-button')),
    'repo button': box(q('.sidebar-section .toolbar-button > button')),
    'repo .icon': box(q('.sidebar-section .icon')),
    'repo .text': box(q('.sidebar-section .text')),
    'repo .description': box(q('.sidebar-section .description')),
    'repo .title': box(q('.sidebar-section .title')),
    'repo .dropdownArrow': box(q('.sidebar-section .dropdownArrow')),
    'branch .toolbar-dropdown(②)': box(q('#desktop-app-toolbar > .toolbar-dropdown')),
    'branch .toolbar-button': box(q('#desktop-app-toolbar > .toolbar-dropdown .toolbar-button')),
    'branch button': box(q('#desktop-app-toolbar > .toolbar-dropdown .toolbar-button > button')),
    'sync .toolbar-dropdown(③)': box(q('.push-pull-button.toolbar-dropdown')),
    'sync .toolbar-button(main)': box(q('.push-pull-button.toolbar-dropdown > .toolbar-button')),
    'sync main button': box(q('.push-pull-button.toolbar-dropdown > .toolbar-button > button')),
    'sync .text': box(q('.push-pull-button.toolbar-dropdown .toolbar-button .text')),
    'sync .ahead-behind': box(q('.ahead-behind')),
    'sync .toolbar-dropdown-arrow-button': box(q('.toolbar-dropdown-arrow-button')),
    'gear .toolbar-button': box(q('.gw-toolbar > .toolbar-button, #desktop-app-toolbar > .toolbar-button')),
    'gear button': box(q('.gw-toolbar > .toolbar-button > button, #desktop-app-toolbar > .toolbar-button > button')),
    'gw-dot': box(q('.gw-dot')),
    '#foldout-container': box(q('#foldout-container')),
    '.overlay': box(q('.overlay')),
    '.foldout': box(q('.foldout')),
    '.foldout .repository-list-item': box(q('.foldout .repository-list-item')),
  },
  ancestorsOfDot: (function () {
    const out = [];
    let el = document.querySelector('.gw-dot');
    while (el && el.classList && !el.classList.contains('gw-root')) {
      out.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
        (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).join('.') : ''));
      el = el.parentElement;
    }
    return out;
  })(),
  parentChainOfToolbar: (function () {
    const out = [];
    let el = document.querySelector('#desktop-app-toolbar');
    while (el && el !== document.documentElement) {
      const cs = getComputedStyle(el);
      out.push({
        el: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
            (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/).join('.') : ''),
        display: cs.display, alignItems: cs.alignItems, height: cs.height, padding: cs.padding,
      });
      el = el.parentElement;
    }
    return out;
  })(),
  /* 自证:令牌链必须真的通,否则上面所有 var() 相关的数字都不可信(见 HOST_TOKENS 注释)。
     探针元素**挂在 .gw-toolbar 里面** —— 因为 --background-color 是那一面声明的,
     挂在 body 下量到 red 是正常的,不能当成「链断了」。 */
  tokenChainHealthy: (function () {
    const root = getComputedStyle(document.documentElement);
    const host = document.querySelector('.gw-toolbar');
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;background:var(--background-color,red)';
    (host ?? document.body).appendChild(probe);
    const applied = getComputedStyle(probe).backgroundColor;
    const hostToken = host ? getComputedStyle(host).getPropertyValue('--background-color').trim() : '';
    probe.remove();
    return {
      'root --dsw-alias-bg-layer-1': root.getPropertyValue('--dsw-alias-bg-layer-1').trim() || '(empty)',
      '.gw-toolbar --background-color': hostToken || '(empty)',
      'var(--background-color,red) inside .gw-toolbar (red ⇒ chain broken)': applied,
    };
  })(),
  foldoutPaint: (function () {
    const f = document.querySelector('.foldout');
    const c = document.querySelector('#foldout-container');
    const o = document.querySelector('.overlay');
    if (!f || !c || !o) return null;
    const fs = getComputedStyle(f), cs = getComputedStyle(c), os = getComputedStyle(o);
    return {
      'foldout.background-color': fs.backgroundColor,
      'foldout.z-index': fs.zIndex,
      'foldout.width': fs.width,
      'foldout.height': fs.height,
      'foldout.left': fs.left,
      'foldout.top': fs.top,
      'container.position': cs.position,
      'container.top': cs.top,
      'container.height': cs.height,
      'container.width': cs.width,
      'container.z-index': cs.zIndex,
      'overlay.height': os.height,
      'overlay.position': os.position,
      'overlay.background-color': os.backgroundColor,
    };
  })(),
  tokensOnToolbar: (function () {
    const el = document.querySelector('#desktop-app-toolbar') ?? document.querySelector('.gw-toolbar');
    const cs = getComputedStyle(el);
    const names = ['--toolbar-height', '--spacing', '--font-size-sm', '--font-size-xs', '--toolbar-button-border-color', '--dsw-alias-bg-layer-2'];
    const out = {};
    for (const n of names) out[n] = cs.getPropertyValue(n).trim() || '(unresolved)';
    return out;
  })(),
};
document.title = 'PROBE-DONE';
const pre = document.createElement('pre');
pre.id = 'probe-result';
pre.textContent = JSON.stringify(results, null, 1);
document.body.appendChild(pre);
</script>`;

const html = `<!doctype html><html><head><meta charset="utf-8">
<style>${HOST_TOKENS}</style>
<style id="dsh-git-styles">${baseCss}</style>
<style id="dsh-git-desktop-diff-styles">${DESKTOP_DIFF_CSS}</style>
<style>html,body{margin:0;padding:0}body{background:#1b1c1f;font-family:-apple-system,"Helvetica Neue",sans-serif;font-size:12px}
.gw-root{width:${panelWidth}px;height:600px;overflow:hidden}</style>
</head><body>${tree}${MEASURE}</body></html>`;

const htmlPath = join(OUT, `toolbar-${variant}-${panelWidth}.html`);
writeFileSync(htmlPath, html);
console.log(`[probe] wrote ${htmlPath} (${Buffer.byteLength(html)} B)`);

/** `--shot` 顺手把首屏渲染成 PNG(结构性证据;真机验收仍然只能看用户截图,goal §5.5)。 */
const shotArg = process.argv.includes('--shot');
const shotPath = join(OUT, `toolbar-${variant}-${panelWidth}.png`);
const commonArgs = [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--force-device-scale-factor=1', '--window-size=${Math.max(panelWidth + 100, 900)},800',
  '--virtual-time-budget=2000',
];
if (shotArg) {
  execFileSync(CHROME, [...commonArgs, `--screenshot=${shotPath}`, `file://${htmlPath}`],
    { stdio: ['ignore', 'ignore', 'ignore'] });
  console.log(`[probe] screenshot: ${shotPath}`);
}

const dom = execFileSync(
  CHROME,
  ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--force-device-scale-factor=1',
   '--window-size=${Math.max(panelWidth + 100, 900)},800', '--virtual-time-budget=2000', '--dump-dom', `file://${htmlPath}`],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
);

const m = dom.match(/<pre id="probe-result">([\s\S]*?)<\/pre>/);
if (m === null) {
  console.error('[probe] FAILED: no #probe-result in dumped DOM');
  writeFileSync(join(OUT, `toolbar-${variant}.dump.html`), dom);
  process.exit(1);
}
const data = JSON.parse(
  m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&'),
);

const pad = (s, n) => String(s).padEnd(n);
console.log(`\n=== ${variant}: viewport ${data.viewport.w}x${data.viewport.h} dpr=${data.viewport.dpr} ===`);
console.log(pad('region', 34), pad('x', 8), pad('y', 8), pad('w', 8), pad('h', 8), pad('pad', 16), pad('margin', 14), pad('flex', 16), 'border-right');
for (const [name, b] of Object.entries(data.regions)) {
  if (b === null) { console.log(pad(name, 34), '(missing)'); continue; }
  console.log(
    pad(name, 34), pad(b.rect.x, 8), pad(b.rect.y, 8), pad(b.rect.w, 8), pad(b.rect.h, 8),
    pad(b.padding, 16), pad(b.margin, 14), pad(b.flex, 16), b.borderRight,
  );
}
console.log('\n-- computed style details --');
for (const [name, b] of Object.entries(data.regions)) {
  if (b === null) {
    continue;
  }
  console.log(pad(name, 34), `display=${b.display}`, `alignItems=${b.alignItems}`, `alignSelf=${b.alignSelf}`,
    `justify=${b.justifyContent}`, `dir=${b.flexDirection}`, `wrap=${b.flexWrap}`, `gap=${b.gap}`,
    `h=${b.height}`, `minW=${b.minWidth}`, `maxW=${b.maxWidth}`, `shrink=${b.flexShrinkRaw}`,
    `borderBottom=${b.borderBottom}`);
}
console.log('\n-- token chain self-check --', JSON.stringify(data.tokenChainHealthy, null, 1));
console.log('\n-- foldout paint --', JSON.stringify(data.foldoutPaint, null, 1));
console.log('\n-- tokens on .gw-toolbar --', JSON.stringify(data.tokensOnToolbar, null, 1));
console.log('\n-- dot ancestors --', JSON.stringify(data.ancestorsOfDot));
console.log('\n-- #desktop-app-toolbar ancestor chain (self → up) --');
for (const p of data.parentChainOfToolbar) {
  console.log('   ', pad(p.el, 36), `display=${p.display}`, `alignItems=${p.alignItems}`, `height=${p.height}`, `padding=${p.padding}`);
}
console.log(`\n[probe] html: ${htmlPath}`);
