/**
 * **dsh-git 手写替身(shim)** —— 上游 `lib/stores/copilot-store.ts`(**1725 行**)。
 *
 * ## 上游那份为什么不能直接沿用
 *
 * 上游是 Copilot 的状态容器:`import crypto`(node 内置)、
 * `@github/copilot-sdk`(含 `/dist/generated/rpc`)、`lib/copilot/**`、
 * `lib/copilot-error`、`lib/copilot-commit-message`、`lib/stats`、
 * `lib/stores/accounts-store`、`./base-store`。
 * **Copilot 被用户明确排除**(目标文档 §1.3 与本次任务书),
 * `lib/copilot-*` 三处也归另一条线所有 —— 本文件不碰它们。
 *
 * ## 本 shim 为什么仍然存在
 *
 * 镜像文件 `ui/preferences/preferences.tsx` 在**顶层** import 了它
 * (`:46-52`,4 个 type + 1 个运行期函数)。镜像必须字节一致,**不许**为了删掉
 * Copilot 去改它;所以按 §10.3 的「需 shim」类处理:**保留上游导出名与签名**。
 *
 * ## 可达性(为什么这些替身不会在界面上出现)
 *
 * 上游 `preferences.tsx:1224-1226` 的 `isCopilotSdkEnabled` 是
 * `this.props.accounts.some(enableCopilotSdkCommitMessageGeneration)`,
 * 而 `lib/feature-flag.ts` 的 `enableCopilotSdkCommitMessageGeneration` 在我们的
 * shim 里恒 `false`(上游在非 `__DEV__` 时同样是
 * `enableDevelopmentFeatures() && enableCopilotConflictResolution()`)⇒
 * Copilot **页签**不渲染(`:408` 的 `this.isCopilotSdkEnabled && …`),
 * `tabToVisualIndex` 也把 `PreferencesTab.Copilot` 跳过。于是 `getCopilotAccountCacheKey`
 * 只在「用户点了 Copilot 页签」这条**不可达**分支里被调用。
 * 另外 `appearance.tsx` 一类页面一个 Copilot 名字都不 import。
 *
 * ## 保留的名字(全部逐字取自上游)
 *
 * | 本 shim 的导出 | 上游位置 |
 * |---|---|
 * | `CopilotFeature` | `:111` |
 * | `CopilotModelSelections` | `:147` |
 * | `CopilotModelSelectionsByAccount` | `:150` |
 * | `ICopilotQuotaSnapshot` | `:179` |
 * | `CopilotQuotaSnapshots` | `:182` |
 * | `CopilotModelsByAccount` | `:187` |
 * | `CopilotQuotaSnapshotsByAccount` | `:192` |
 * | `getCopilotAccountCacheKey` | `:223` |
 *
 * **两处必需的替代(不是偷懒,是浏览器半的硬约束)**:
 *  1. 上游 `CopilotModelsByAccount` 的 value 是
 *     `ReadonlyArray<Model> | null`,`Model` 来自 `@github/copilot-sdk/dist/generated/rpc`
 *     —— 那个包只在 Desktop 的 Electron 环境里装;我们的 `package.json` 里没有
 *     (构建会立刻报「Cannot resolve」)。这里换成结构等价的
 *     `ReadonlyArray<ICopilotModelLike>`,只声明上游实际读到的两个字段
 *     (`id` / `name`,见 `ui/lib/copilot-model-picker.tsx`)。
 *  2. 上游 `ICopilotQuotaSnapshot extends AccountQuotaSnapshot`(同样来自 SDK),
 *     这里把那个基类型的字段按上游 mock 的形状展开(`quota_remaining` /
 *     `quota_id` / `entitlement` / `percent_remaining` / `unlimited`),逐字取自
 *     `@github/copilot-sdk` 生成类型,避免为一个**不可达**分支拉一个 Electron 包。
 *
 * `getCopilotAccountCacheKey` 的实现**与上游一致**(`${account.id}:${account.endpoint}`),
 * 它是纯函数,没有任何依赖。
 * @module dsh-git/core/desktop/lib/stores/copilot-store
 */

import type { Account } from '../../models/account'

/** 上游 `:111`,逐字。 */
export type CopilotFeature = 'commit-message-generation' | 'conflict-resolution'

/** 上游 `:147`,逐字。 */
export type CopilotModelSelections = Partial<Record<CopilotFeature, string>>

/** 上游 `:150`,逐字。 */
export type CopilotModelSelectionsByAccount = ReadonlyMap<
  string,
  CopilotModelSelections
>

/**
 * 上游从 `@github/copilot-sdk` 的 `AccountQuotaSnapshot` 继承;
 * 这里按那个生成类型的字段展开(见文件头「必需的替代」2)。
 */
export interface IAccountQuotaSnapshotLike {
  readonly quota_remaining?: number
  readonly quota_id?: string
  readonly entitlement?: number
  readonly percent_remaining?: number
  readonly unlimited?: boolean
}

/** 上游 `:179`(基类型换成上面的结构等价声明)。 */
export interface ICopilotQuotaSnapshot extends IAccountQuotaSnapshotLike {
  readonly tokenBasedBilling: boolean
}

/** 上游 `:182`,逐字。 */
export type CopilotQuotaSnapshots = ReadonlyMap<string, ICopilotQuotaSnapshot>

/**
 * 上游 `@github/copilot-sdk` 的 `Model` 里我们真正读到的两个字段
 * (`ui/lib/copilot-model-picker.tsx` 读 `model.id` / `model.name`)。
 */
export interface ICopilotModelLike {
  readonly id: string
  readonly name: string
}

/** 上游 `:187`(`Model` → 上面的结构等价声明,见文件头)。 */
export type CopilotModelsByAccount = ReadonlyMap<
  string,
  ReadonlyArray<ICopilotModelLike> | null
>

/** 上游 `:192`,逐字。 */
export type CopilotQuotaSnapshotsByAccount = ReadonlyMap<
  string,
  CopilotQuotaSnapshots | null
>

/** 上游 `:223`,逐字(纯函数)。 */
export function getCopilotAccountCacheKey(account: Account): string {
  return `${account.id}:${account.endpoint}`
}
