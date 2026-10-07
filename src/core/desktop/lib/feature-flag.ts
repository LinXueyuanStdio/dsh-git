/**
 * **dsh-git 手写替身(shim)** —— 上游 `app/src/lib/feature-flag.ts`(136 行)。
 *
 * 上游是一个**构建/环境配置读表**:靠 `__DEV__`(Desktop 的 esbuild/webpack 全局)
 * 与 `process.env.GITHUB_DESKTOP_PREVIEW_FEATURES` 决定每个预览特性开不开。
 * 浏览器半既没有 `__DEV__` 也没有 `process`,所以这里保留**全部同名导出**,
 * 一律返回「关」——这正是 Desktop 在正式版里的默认值(`enableFormattingPreferences`
 * 与 `enableCustomIntegration` 等少数几个上游本来就恒为 `true`,沿用)。
 *
 * 调用点全部不变(实证:`ui/lib/bytes.ts:3` 与 `lib/format-number.ts:5` 取
 * `enableFormattingPreferences`)。等宿主有了自己的特性开关表,把这里换成读宿主配置即可。
 * @module dsh-git/core/desktop/lib/feature-flag
 */

/** 上游 :124 —— `export const enableFormattingPreferences = () => true`。 */
export const enableFormattingPreferences = () => true

/** 上游 :87 —— `export const enableCustomIntegration = () => true`。 */
export const enableCustomIntegration = () => true

/** 上游 :89 —— `export const enableResizingToolbarButtons = () => true`。 */
export const enableResizingToolbarButtons = () => true

/** 上游 :114 —— `export const enableCopilotConflictResolution = () => true`。 */
export const enableCopilotConflictResolution = () => true

/** 上游 :120 —— `export const enableHooksEnvironment = () => true`。 */
export const enableHooksEnvironment = () => true

/** 上游 :127 —— `export const enableWorktreeSupport = () => true`。 */
export const enableWorktreeSupport = () => true

// 以下上游都需要运行时/环境信息;在当前宿主里按「关」处理(与正式版一致)。

export const enableTestMenuItems = () => false
export const enableReadmeOverwriteWarning = () => false
export const enableWSLDetection = () => false
export const enableUnhandledRejectionReporting = () => false
export const enableUpdateFromEmulatedX64ToARM64 = () => false
export const enablePreviousTagSuggestions = () => false
export const enablePullRequestQuickView = () => false
export const enableImagePreviewsForDDSFiles = () => false
export const enableCopilotAppHandoff = () => false
export const enableNewStatsEndpoint = () => false
export const enableAccessibleListToolTips = () => false
/**
 * 上游 `:122` 是 `export const enableHooksByDefault = enableBetaFeatures`
 * —— 也就是**一个函数**(`() => boolean`)。2026-10 更正:这里原本写的是
 * `false`,而 `lib/hooks/config.ts:4` 把它当函数调用
 * (`defaultHooksEnvEnabledValue = enableHooksByDefault()`)⇒
 * 「This expression is not callable」。改成同形状的函数(值仍是恒假:
 * 上游 `enableBetaFeatures()` 在非 `__DEV__` 时为 false)。
 */
export const enableHooksByDefault = () => false

/** 上游 :91 —— 需要 `Account`;保留签名,恒为关。 */
export const enableCommitMessageGeneration = (_account: unknown) => false
/** 上游 :102 —— 需要 `Account`;保留签名,恒为关。 */
export const enableCopilotSdkCommitMessageGeneration = (_account: unknown) =>
  false
