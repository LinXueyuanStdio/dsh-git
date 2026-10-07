/**
 * **dsh-git 手写替身(shim,纯类型)** —— 上游 `lib/stores/sign-in-store.ts`(467 行)。
 *
 * ## 上游那份为什么不能直接沿用
 *
 * 上游的主体是 **`SignInStore` 类**(`:160`):`extends TypedBaseStore`、
 * 走 `lib/api` 的 `requestOAuthToken`/`fetchUser`(Desktop 的 GitHub REST 客户端)、
 * `lib/app-shell` 的 `shell`(Electron `shell.openExternal`)、`./accounts-store`,
 * 还 import `lodash/noop`/`../parse-app-url`/`../endpoint-capabilities`。
 * `lib/stores/**`(含 10936 行的 `app-store.ts`)是目标文档 **§1.3 明确不沿用**的
 * Desktop 应用层 —— 引进来会把闭包从 130 文件涨到 347 文件 / 76291 行,
 * 而且登录流程的职责属于 host。
 *
 * ## 本 shim 必须保住的名字(以及为什么多留了几个)
 *
 * 实证:镜像 `lib/app-state.ts:43` 写的是
 * `import { SignInState } from './stores/sign-in-store'`,只取 **`SignInState`**。
 * 但 `SignInState` 是四个状态接口的**判别联合**,消费者必然同时需要
 * `SignInStep`(`kind` 的取值)才能窄化 —— 所以连同它的构件一起保留。
 * 这些都是**上游的导出名**,声明**与上游一致**自上游(含文档注释),没有一处是我编的:
 *
 * | 本 shim 的导出 | 上游位置 | 谁需要 |
 * |---|---|---|
 * | `SignInStep` | `:29` | `ISignInState.kind` |
 * | `SignInState` | `:41` | **`lib/app-state.ts:43`(唯一的实证消费者)** |
 * | `ISignInState` | `:50` | 下面四个的基接口 |
 * | `IExistingAccountWarning` | `:80` | 联合成员 |
 * | `IEndpointEntryState` | `:100` | 联合成员 |
 * | `IAuthenticationState` | `:112` | 联合成员 |
 * | `ISuccessState` | `:143` | 联合成员 |
 * | `SignInResult` | `:152` | `resultCallback` 的入参 |
 *
 * **刻意省略**(不是遗漏):
 *  - `SignInStore` 类(`:160`,§1.3 的应用层);
 *  - 非导出的 `IAuthenticationEvent`(`:148`)—— 只被那个类用,`noUnusedLocals`
 *    会把它报成未使用。
 *
 * **本 shim 零运行期代码副作用**:`SignInStep` 是上游的 enum(有运行期值,
 * 与上游一致),其余全是类型;本文件**没有任何函数/常量**。整个文件**不可达**
 * (没有模块 import 它),所以不进产物。
 * @module dsh-git/core/desktop/lib/stores/sign-in-store
 */

import { Account } from '../../models/account'

/**
 * An enumeration of the possible steps that the sign in
 * store can be in save for the uninitialized state (null).
 */
export enum SignInStep {
  EndpointEntry = 'EndpointEntry',
  ExistingAccountWarning = 'ExistingAccountWarning',
  Authentication = 'Authentication',
  TwoFactorAuthentication = 'TwoFactorAuthentication',
  Success = 'Success',
}

/**
 * The union type of all possible states that the sign in
 * store can be in save the uninitialized state (null).
 */
export type SignInState =
  | IEndpointEntryState
  | IExistingAccountWarning
  | IAuthenticationState
  | ISuccessState

/**
 * Base interface for shared properties between states
 */
export interface ISignInState {
  /**
   * The sign in step represented by this state
   */
  readonly kind: SignInStep

  /**
   * An error which, if present, should be presented to the
   * user in close proximity to the actions or input fields
   * related to the current step.
   */
  readonly error: Error | null

  /**
   * A value indicating whether or not the sign in store is
   * busy processing a request. While this value is true all
   * form inputs and actions save for a cancel action should
   * be disabled and the user should be made aware that the
   * sign in process is ongoing.
   */
  readonly loading: boolean

  readonly resultCallback: (result: SignInResult) => void
}

/**
 * State interface representing the endpoint entry step.
 * This is the initial step in the Enterprise sign in
 * flow and is not present when signing in to GitHub.com
 */
export interface IExistingAccountWarning extends ISignInState {
  readonly kind: SignInStep.ExistingAccountWarning
  /**
   * The URL to the host which we're currently authenticating
   * against. This will be either https://api.github.com when
   * signing in against GitHub.com or a user-specified
   * URL when signing in against a GitHub Enterprise
   * instance.
   */
  readonly existingAccount: Account
  readonly endpoint: string

  readonly resultCallback: (result: SignInResult) => void
}

/**
 * State interface representing the endpoint entry step.
 * This is the initial step in the Enterprise sign in
 * flow and is not present when signing in to GitHub.com
 */
export interface IEndpointEntryState extends ISignInState {
  readonly kind: SignInStep.EndpointEntry
  readonly resultCallback: (result: SignInResult) => void
}

/**
 * State interface representing the Authentication step where
 * the user provides credentials and/or initiates a browser
 * OAuth sign in process. This step occurs as the first step
 * when signing in to GitHub.com and as the second step when
 * signing in to a GitHub Enterprise instance.
 */
export interface IAuthenticationState extends ISignInState {
  readonly kind: SignInStep.Authentication

  /**
   * The URL to the host which we're currently authenticating
   * against. This will be either https://api.github.com when
   * signing in against GitHub.com or a user-specified
   * URL when signing in against a GitHub Enterprise
   * instance.
   */
  readonly endpoint: string

  /** Whether Git supplied this unfamiliar Enterprise Server endpoint. */
  readonly isUnrecognizedEnterpriseServer?: boolean

  readonly resultCallback: (result: SignInResult) => void

  readonly oauthState?: {
    state: string
    endpoint: string
    onAuthCompleted: (account: Account) => void
    onAuthError: (error: Error) => void
  }
}

/**
 * Sentinel step representing a successful sign in process. Sign in
 * components may use this as a signal to dismiss the ongoing flow
 * or to show a message to the user indicating that they've been
 * successfully signed in.
 */
export interface ISuccessState {
  readonly kind: SignInStep.Success
  readonly resultCallback: (result: SignInResult) => void
}

export type SignInResult =
  | { kind: 'success'; account: Account }
  | { kind: 'cancelled' }
