/**
 * **Preferences 的「插件根」适配规则** —— 只剩**一条**,而且它必须由 JS 注入。
 *
 * ## 为什么这个文件还在(以及为什么只剩一条)
 *
 * 2026-10:原先这里有 5 条删除 + 1 条下划线接线 + 设备码面板排版,全部由
 * `ensurePrefAdaptations()` 注入一个 `<style id="gw-pref-adaptations">`。**现在它们搬到了
 * `src/client/scss/preferences.scss` 的 `.gw-prefs` 适配块** —— 同一个作用域只该有一份真源,
 * 而那是 Preferences 这一面自己的入口(搬动的理由与 `!important` 的实测依据都写在那边)。
 *
 * 唯一搬不走的是**这一条**:
 *
 * ```css
 * .gw-root.gw-underline-links a,
 * .gw-root.gw-underline-links .link-button-component { text-decoration: underline; }
 * ```
 *
 * 原因:`.gw-root` 是**插件外壳**,不在任何已注册的移植面作用域里
 * (`PORT_SURFACES` 的 9 个根没有 `.gw-root`)。写进 `preferences.scss` 会被前缀化成
 * `.gw-prefs .gw-root…` —— 要求「卡片**里面**再有一个 `.gw-root`」,而卡片 portal 到
 * `document.body`,**结构上永不匹配**。要让它进编译产物,只能新开一个以 `.gw-root`
 * 为 scope 的移植面(要动 `scripts/styles.mjs` 的注册表);**一条规则不值得为它开一个面**,
 * 而且它服务的是插件外壳的链接,不是 Desktop 的移植配方。
 *
 * ## 「Underline links」这条接线的两半(别只找到一半)
 *
 * | 位置 | 规则 | 生效处 |
 * |---|---|---|
 * | `scss/preferences.scss` 第 6 条 | `.gw-prefs.gw-underline-links a, .link-button-component` | **弹窗卡片**(portal 到 body) |
 * | 本文件 | `.gw-root.gw-underline-links a, .link-button-component` | **插件根**(顶栏 / 列表 / 变更区) |
 *
 * 类名 `gw-underline-links` 由 `workbench.tsx`(挂在 `.gw-root`)与 `preferences-dialog.tsx`
 * (通过 `HostModal` 的 `className` 挂在卡片上)加;偏好读写在 `src/client/prefs.ts`。
 * 真 Chrome 探针两半都量:`docs/probes/preferences-geometry-probe.mjs` 的
 * `wired.underlineAfter.probeLinkDecoration` / `probeLinkInCardDecoration`。
 *
 * ## 注入发生在**模块加载时**(而不是 `apply(ctx)` 里)
 *
 * `ensurePrefAdaptations()` 由 `src/client/workbench.tsx` 在模块作用域调用 —— workbench 由
 * `src/client/index.ts` 静态 import,所以它在第一次渲染之前一定跑过(必须如此,
 * 否则会先画一帧没有下划线的界面)。等这条规则也搬走(例如外壳作用域也注册成面),
 * 本文件与那一行调用一起删掉即可。
 *
 * @see src/client/scss/preferences.scss —— 其余适配规则的所在地(单一真源)
 * @module dsh-git/client/pref-adapt
 */

/** 注入的 `<style>` 元素 id(幂等 + 探针可定位)。 */
export const PREF_ADAPT_STYLE_ID = 'gw-pref-adaptations';

/**
 * 插件根上的下划线规则(唯一残留)。
 *
 * ⚠️ 保持**只有这一条**,并且**只作用在 `.gw-root` 上** —— 任何针对 `.gw-prefs` 的规则
 * 都应该写进 `src/client/scss/preferences.scss` 的适配块。
 */
export const PREF_ADAPT_CSS = `
/* Accessibility ▸ Underline links 的**插件根**那一半(另一半在 scss/preferences.scss)。 */
.gw-root.gw-underline-links a,
.gw-root.gw-underline-links .link-button-component {
  text-decoration: underline;
}
`;

/**
 * 注入「插件根」适配样式表(**幂等**)。
 *
 * 由 `src/client/workbench.tsx` 在模块加载时调用一次 —— 与 `styles.ts` 的 `ensure*`
 * 同一套路子:必须早于第一次渲染。
 */
export function ensurePrefAdaptations(): void {
  if (typeof document === 'undefined') { return; }
  if (document.getElementById(PREF_ADAPT_STYLE_ID) !== null) { return; }
  const style = document.createElement('style');
  style.id = PREF_ADAPT_STYLE_ID;
  style.textContent = PREF_ADAPT_CSS;
  document.head.appendChild(style);
}
