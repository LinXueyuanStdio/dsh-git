/**
 * **dsh-git 手写替身(shim)** —— 上游 `models/popup.ts`(555 行)。
 *
 * 上游这份文件是 Desktop **整个弹窗系统**的类型总表:`PopupType` 枚举(约 100 个成员)
 * 与 `PopupDetail`(约 90 个变体)。它的 import 列表里有
 * `../lib/ci-checks/ci-checks`、`../lib/copilot/byok`、`../lib/git`、
 * `../models/account`、`../ui/history/unreachable-commits-dialog`、
 * `../ui/repository-settings/repository-settings`、
 * `../ui/secret-scanning/*` —— 目标文档 §1.3 明确**不沿用**的部分。
 *
 * 移植的仓库列表只用到 5 个变体(实证:`ui/repositories-list/repositories-list.tsx`
 * 的 `dispatcher.showPopup(...)` 调用点):
 *   `CloneRepository` / `AddRepository` / `CreateRepository` /
 *   `ChangeRepositoryAlias` / `AddWorktree`。
 *
 * 因此本 shim:
 *  - **`PopupType` 枚举逐字保留上游全部成员与字符串值**,不改名、不裁剪 ——
 *    它是运行期值,裁剪等于埋雷;
 *  - `Popup` / `PopupDetail` / `IBasePopup` 只保留上述 5 个变体,
 *    每个变体的字段与上游**逐字相同**(见上游 `:187`、`:188`、`:190`、`:346`、`:533`)。
 *
 * 缺口:若以后要接 `Preferences` / `RepositorySettings` 等弹窗,
 * 需要把对应变体补回来(或把上游那份按 §1.3 的例外重新评估)。
 * @module dsh-git/core/desktop/models/popup
 */

import { Repository } from './repository'

/** 上游 `models/popup.ts:32`,逐字保留。 */
export enum PopupType {
  RenameBranch = 'RenameBranch',
  DeleteBranch = 'DeleteBranch',
  DeleteRemoteBranch = 'DeleteRemoteBranch',
  ConfirmDiscardChanges = 'ConfirmDiscardChanges',
  Preferences = 'Preferences',
  RepositorySettings = 'RepositorySettings',
  AddRepository = 'AddRepository',
  CreateRepository = 'CreateRepository',
  CloneRepository = 'CloneRepository',
  CreateBranch = 'CreateBranch',
  SignIn = 'SignIn',
  About = 'About',
  InstallGit = 'InstallGit',
  PublishRepository = 'PublishRepository',
  Acknowledgements = 'Acknowledgements',
  UntrustedCertificate = 'UntrustedCertificate',
  RemoveRepository = 'RemoveRepository',
  TermsAndConditions = 'TermsAndConditions',
  PushBranchCommits = 'PushBranchCommits',
  CLIInstalled = 'CLIInstalled',
  GenericGitAuthentication = 'GenericGitAuthentication',
  ExternalEditorFailed = 'ExternalEditorFailed',
  CopilotAppNotFound = 'CopilotAppNotFound',
  OpenWithExternalEditor = 'OpenWithExternalEditor',
  OpenShellFailed = 'OpenShellFailed',
  InitializeLFS = 'InitializeLFS',
  LFSAttributeMismatch = 'LFSAttributeMismatch',
  UpstreamAlreadyExists = 'UpstreamAlreadyExists',
  ReleaseNotes = 'ReleaseNotes',
  DeletePullRequest = 'DeletePullRequest',
  OversizedFiles = 'OversizedFiles',
  CommitConflictsWarning = 'CommitConflictsWarning',
  PushNeedsPull = 'PushNeedsPull',
  ConfirmForcePush = 'ConfirmForcePush',
  StashAndSwitchBranch = 'StashAndSwitchBranch',
  ConfirmOverwriteStash = 'ConfirmOverwriteStash',
  ConfirmDiscardStash = 'ConfirmDiscardStash',
  ConfirmCheckoutCommit = 'ConfirmCheckoutCommit',
  CreateTutorialRepository = 'CreateTutorialRepository',
  ConfirmExitTutorial = 'ConfirmExitTutorial',
  PushRejectedDueToMissingWorkflowScope = 'PushRejectedDueToMissingWorkflowScope',
  SAMLReauthRequired = 'SAMLReauthRequired',
  CreateFork = 'CreateFork',
  CreateTag = 'CreateTag',
  DeleteTag = 'DeleteTag',
  LocalChangesOverwritten = 'LocalChangesOverwritten',
  ChooseForkSettings = 'ChooseForkSettings',
  ConfirmDiscardSelection = 'ConfirmDiscardSelection',
  MoveToApplicationsFolder = 'MoveToApplicationsFolder',
  ChangeRepositoryAlias = 'ChangeRepositoryAlias',
  ThankYou = 'ThankYou',
  CommitMessage = 'CommitMessage',
  MultiCommitOperation = 'MultiCommitOperation',
  WarnLocalChangesBeforeUndo = 'WarnLocalChangesBeforeUndo',
  WarningBeforeReset = 'WarningBeforeReset',
  InvalidatedToken = 'InvalidatedToken',
  AddSSHHost = 'AddSSHHost',
  SSHKeyPassphrase = 'SSHKeyPassphrase',
  SSHUserPassword = 'SSHUserPassword',
  PullRequestChecksFailed = 'PullRequestChecksFailed',
  CICheckRunRerun = 'CICheckRunRerun',
  WarnForcePush = 'WarnForcePush',
  DiscardChangesRetry = 'DiscardChangesRetry',
  PullRequestReview = 'PullRequestReview',
  UnreachableCommits = 'UnreachableCommits',
  StartPullRequest = 'StartPullRequest',
  Error = 'Error',
  InstallingUpdate = 'InstallingUpdate',
  TestNotifications = 'TestNotifications',
  PullRequestComment = 'PullRequestComment',
  UnknownAuthors = 'UnknownAuthors',
  TestIcons = 'TestIcons',
  ConfirmCommitFilteredChanges = 'ConfirmCommitFilteredChanges',
  TestAbout = 'TestAbout',
  TestCLIAction = 'TestCLIAction',
  TestCopilotSnapshotCard = 'TestCopilotSnapshotCard',
  PushProtectionError = 'PushProtectionError',
  BypassPushProtection = 'BypassPushProtection',
  GenerateCommitMessageOverrideWarning = 'GenerateCommitMessageOverrideWarning',
  GenerateCommitMessageDisclaimer = 'GenerateCommitMessageDisclaimer',
  CopilotConflictResolutionDisclaimer = 'CopilotConflictResolutionDisclaimer',
  HookFailed = 'HookFailed',
  CommitProgress = 'CommitProgress',
  AddWorktree = 'AddWorktree',
  RenameWorktree = 'RenameWorktree',
  DeleteWorktree = 'DeleteWorktree',
  EditCopilotBYOKProvider = 'EditCopilotBYOKProvider',
  EditCopilotBYOKModel = 'EditCopilotBYOKModel',
  CopilotUserSettings = 'CopilotUserSettings',
  CopilotCustomProviders = 'CopilotCustomProviders',
  ConfirmDeleteCopilotBYOKProvider = 'ConfirmDeleteCopilotBYOKProvider',
  CopilotConflictResolutionAlwaysNudge = 'CopilotConflictResolutionAlwaysNudge',
  DeleteWorktreeFailed = 'DeleteWorktreeFailed',
}

/** 上游 `models/popup.ts:128`。 */
interface IBasePopup {
  /**
   * Unique id of the popup that it receives upon adding to the stack.
   */
  readonly id?: number
}

/**
 * 上游 `models/popup.ts:136` 的 `PopupDetail`,这里只保留仓库列表用到的 5 个变体。
 * 字段逐字取自上游对应行(行号见每个变体上方注释)。
 */
export type PopupDetail =
  // 上游 :187
  | { type: PopupType.AddRepository; path?: string }
  // 上游 :188
  | { type: PopupType.CreateRepository; path?: string }
  // 上游 :190
  | {
      type: PopupType.CloneRepository
      initialURL: string | null
    }
  // 上游 :346
  | { type: PopupType.ChangeRepositoryAlias; repository: Repository }
  // 上游 :533
  | {
      type: PopupType.AddWorktree
      repository: Repository
      initialBranchName?: string
      initialWorktreeName?: string
    }

/** 上游 `models/popup.ts:555`。 */
export type Popup = IBasePopup & PopupDetail
