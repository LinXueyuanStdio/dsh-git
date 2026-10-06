/**
 * 注入编译后的 Desktop diff 样式表(一次)。
 *
 * CSS 本体是**生成物**:`scripts/build.mjs` 的 `buildDesktopDiffStyles()` 用 Dart Sass
 * 编译 `src/client/scss/desktop-diff.scss`(逐字编译上游 GitHub Desktop 的 diff 样式表,
 * 整体嵌在 `.gw-desktop-diff` 作用域下,取色全部桥到 DSH `--dsw-alias-*` 令牌),
 * 写进同目录的 `desktop-diff-styles.generated.ts`。
 *
 * 为什么在 `apply()` 里就注入、而不是等第一次渲染 diff:
 *  - 与 `ensureStyles()` / `ensureBaseStyles()` 同一模式,顺序与时机一目了然;
 *  - 产物是一次 `<style>` 插入,约 60KB,解析成本可忽略;
 *  - 反过来做懒注入就得在组件里做副作用,还得处理「先画一帧无样式」的闪烁。
 * @module dsh-git/client/desktop-diff-styles
 */

import { DESKTOP_DIFF_CSS } from './desktop-diff-styles.generated.ts';

const STYLE_ID = 'dsh-git-desktop-diff-styles';

/** 注入 Desktop diff 样式(幂等)。 */
export function ensureDesktopDiffStyles(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID) !== null) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = DESKTOP_DIFF_CSS;
  document.head.appendChild(style);
}
