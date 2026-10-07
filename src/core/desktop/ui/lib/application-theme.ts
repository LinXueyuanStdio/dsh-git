/**
 * **dsh-git 手写替身(shim,纯类型 + 一个 enum)** —— 上游 `ui/lib/application-theme.ts`(132 行)。
 *
 * ## 上游那份为什么不能直接沿用
 *
 * 上游是**主题的宿主适配层**:`:1-11` import
 * `../../lib/get-os`(读 Electron 的 `process.getSystemVersion`)、
 * `../../lib/local-storage`(**我们树里没有这个文件**,不在 app-state 的闭包内)、
 * `../main-process-proxy`(Electron `nativeTheme`,`setNativeThemeSource`/`shouldUseDarkColors`)、
 * `./theme-source`(**同样没有**),并用 `localStorage` 与 `document.body.classList` 做副作用。
 * 主题由 **DSH 宿主**拥有(目标文档 §2.2「颜色只来自宿主令牌」;
 * `docs/storage-tables-design.md` §2.3 F 把 `selectedTheme`/`currentTheme` 明确列为**不沿用**)。
 *
 * ## 本 shim 必须保住的名字
 *
 * 实证:镜像 `lib/app-state.ts:48` 写的是
 * `import { ApplicableTheme, ApplicationTheme } from '../ui/lib/application-theme'`,
 * 恰好 **2 个名字**(用在 `readonly selectedTheme: ApplicableTheme | null` /
 * `readonly currentTheme: ApplicationTheme` 一类的字段上),两个都与上游一致自上游:
 *
 * | 本 shim 的导出 | 上游位置 | 形态 |
 * |---|---|---|
 * | `ApplicationTheme` | `:15` | 字符串 enum(3 个成员,**有运行期值**) |
 * | `ApplicableTheme` | `:21` | `ApplicationTheme.Light \| ApplicationTheme.Dark` |
 *
 * `ApplicationTheme` 保持上游的 enum(而不是字面量联合)—— 字符串 enum 是名义类型,
 * 换成联合会改变赋值语义。
 *
 * **刻意省略**:`getThemeName`、`setApplicationTheme`、`getAppliedTheme` 等全部函数
 * (main-process-proxy / get-os / local-storage 依赖),以及 `ThemeSource` 的转出。
 *
 * ## 2026-10 追加(Preferences ▸ Appearance 页接线)
 *
 * 上游 `ui/preferences/appearance.tsx:2-6` 从本模块取 **3 个**名字:
 * `ApplicationTheme`、`supportsSystemThemeChanges`、`getCurrentlyAppliedTheme`。
 * 后两个按 §2.1.5「Web 有真实等价物时**实现它**,不要打桩」就地实现:
 *
 * | 本 shim 的导出 | 上游位置 | 浏览器里的真实等价物 |
 * |---|---|---|
 * | `supportsSystemThemeChanges` | `:115` | `matchMedia('(prefers-color-scheme: dark)')` 可用即为真 |
 * | `getCurrentlyAppliedTheme` | `:86` | 同一个媒体查询的 `matches` ⇒ Dark / Light |
 *
 * 这**不是**在浏览器里替宿主决定主题:只是回答「系统当前偏好哪一档」,
 * 而真正生效的皮肤仍由 DSH 宿主令牌决定(§2.2)。上游 `getCurrentlyAppliedTheme`
 * 最终走 `isDarkModeEnabled()` ⇒ `ui/main-process-proxy.ts` 的 `shouldUseDarkColors()`,
 * 而那个 shim 里**已经是** `matchMedia` 实现 —— 这里只是把同一条等价物放在本模块,
 * 避免为一个纯查询多一层 import。
 * @module dsh-git/core/desktop/ui/lib/application-theme
 */

/**
 * A set of the user-selectable appearances (aka themes)
 * —— 上游 `ui/lib/application-theme.ts:15`,逐字。
 */
export enum ApplicationTheme {
  Light = 'light',
  Dark = 'dark',
  System = 'system',
}

/** 上游 `ui/lib/application-theme.ts:21`,逐字。 */
export type ApplicableTheme = ApplicationTheme.Light | ApplicationTheme.Dark

/**
 * 上游 `:115` —— 「这个平台支不支持跟随系统主题」。
 *
 * 上游按平台分支:`__DARWIN__` 查 macOS 版本、`__WIN32__` 查 Windows 10 1809+、
 * 其余(Linux)**直接 `return true`**。浏览器半唯一运行环境是 Chromium,
 * 而 `prefers-color-scheme` 在所有受支持的 Chromium 上都有 ⇒ 与上游的
 * Linux 分支**语义一致**,恒真。这不是降级:它决定的是 Appearance 页
 * 「跟随系统」那一档是否出现(`appearance.tsx:185,193`),而 Chromium 确实支持。
 */
export function supportsSystemThemeChanges(): boolean {
  return true
}

/**
 * 上游 `:86` —— 「系统当前实际生效的是浅色还是深色」。
 *
 * 上游是 `(await isDarkModeEnabled()) ? Dark : Light`,而 `isDarkModeEnabled`
 * 走 `main-process-proxy.shouldUseDarkColors()`(Electron `nativeTheme`)。
 * 浏览器里的**真实等价物**就是 `prefers-color-scheme` 媒体查询(§2.1.5),
 * 与那个 shim 的实现完全相同。
 */
export function getCurrentlyAppliedTheme(): Promise<ApplicableTheme> {
  const dark =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : false
  return Promise.resolve(dark ? ApplicationTheme.Dark : ApplicationTheme.Light)
}
