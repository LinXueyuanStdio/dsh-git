import * as React from 'react'
import { UncommittedChangesStrategy } from '../../models/uncommitted-changes-strategy'
import { DialogContent } from '../dialog'
import { Checkbox, CheckboxValue } from '../lib/checkbox'
import { RadioGroup } from '../lib/radio-group'
import { assertNever } from '../../lib/fatal-error'
/*
 * --- 有意偏离(本轮唯一一处;登记在 `scripts/verify-mirror.mjs` 的 EXPECTED)---
 *
 * **用户裁决:统一中文** —— 与 `accessibility.tsx` / `accounts.tsx` / `git.tsx` /
 * `appearance.tsx` / `ui/lib/git-config-user-form.tsx` **同批**的第六条
 * (那五条是同一处裁决的五个文件,必须一起读一起撤;这是第六个)。
 *
 * 本偏离**严格限死为「用户可见字符串字面量的内容」**:
 *  · 改的只有文案(17 处,逐条对照表写在 `scripts/verify-mirror.mjs` 的登记里);
 *  · 结构 / 类名 / `id` / `aria-*` / prop 面 / 状态机 / `assertNever` 的开发者信息
 *    **一个字都没动**;
 *  · 本页原来是整页删除的(保真度账本),2026-10 用户裁决「可以加 Prompts 页」
 *    之后才渲染 —— 所以这条偏离是**这一页上屏的前提**,不是顺手改的。
 *
 * **退役条件**(与那五条完全同源,任一条出现即撤掉登记、把本文件还原成上游原文):
 *  1. i18n 项目落地(上游/我们引入真正的文案表,字符串改为查表);
 *  2. 用户改判「偏好设置弹窗统一英文」;
 *  3. 上游自己做了 i18n,`references/desktop` 的这份文件不再含英文字面量。
 */

interface IPromptsPreferencesProps {
  readonly confirmRepositoryRemoval: boolean
  readonly confirmDiscardChanges: boolean
  readonly confirmDiscardChangesPermanently: boolean
  readonly confirmDiscardStash: boolean
  readonly confirmCheckoutCommit: boolean
  readonly confirmForcePush: boolean
  readonly confirmUndoCommit: boolean
  readonly askForConfirmationOnCommitFilteredChanges: boolean
  readonly confirmCommitMessageOverride: boolean
  readonly confirmWorktreeRemoval: boolean
  readonly showCommitLengthWarning: boolean
  readonly uncommittedChangesStrategy: UncommittedChangesStrategy
  readonly onConfirmDiscardChangesChanged: (checked: boolean) => void
  readonly onConfirmDiscardChangesPermanentlyChanged: (checked: boolean) => void
  readonly onConfirmDiscardStashChanged: (checked: boolean) => void
  readonly onConfirmCheckoutCommitChanged: (checked: boolean) => void
  readonly onConfirmRepositoryRemovalChanged: (checked: boolean) => void
  readonly onConfirmForcePushChanged: (checked: boolean) => void
  readonly onConfirmUndoCommitChanged: (checked: boolean) => void
  readonly onShowCommitLengthWarningChanged: (checked: boolean) => void
  readonly onUncommittedChangesStrategyChanged: (
    value: UncommittedChangesStrategy
  ) => void
  readonly onAskForConfirmationOnCommitFilteredChanges: (value: boolean) => void
  readonly onConfirmCommitMessageOverrideChanged: (checked: boolean) => void
  readonly onConfirmWorktreeRemovalChanged: (checked: boolean) => void
}

interface IPromptsPreferencesState {
  readonly confirmRepositoryRemoval: boolean
  readonly confirmDiscardChanges: boolean
  readonly confirmDiscardChangesPermanently: boolean
  readonly confirmDiscardStash: boolean
  readonly confirmCheckoutCommit: boolean
  readonly confirmForcePush: boolean
  readonly confirmUndoCommit: boolean
  readonly askForConfirmationOnCommitFilteredChanges: boolean
  readonly confirmCommitMessageOverride: boolean
  readonly confirmWorktreeRemoval: boolean
  readonly uncommittedChangesStrategy: UncommittedChangesStrategy
}

export class Prompts extends React.Component<
  IPromptsPreferencesProps,
  IPromptsPreferencesState
> {
  public constructor(props: IPromptsPreferencesProps) {
    super(props)

    this.state = {
      confirmRepositoryRemoval: this.props.confirmRepositoryRemoval,
      confirmDiscardChanges: this.props.confirmDiscardChanges,
      confirmDiscardChangesPermanently:
        this.props.confirmDiscardChangesPermanently,
      confirmDiscardStash: this.props.confirmDiscardStash,
      confirmCheckoutCommit: this.props.confirmCheckoutCommit,
      confirmForcePush: this.props.confirmForcePush,
      confirmUndoCommit: this.props.confirmUndoCommit,
      uncommittedChangesStrategy: this.props.uncommittedChangesStrategy,
      askForConfirmationOnCommitFilteredChanges:
        this.props.askForConfirmationOnCommitFilteredChanges,
      confirmCommitMessageOverride: this.props.confirmCommitMessageOverride,
      confirmWorktreeRemoval: this.props.confirmWorktreeRemoval,
    }
  }

  private onConfirmDiscardChangesChanged = (
    event: React.FormEvent<HTMLInputElement>
  ) => {
    const value = event.currentTarget.checked

    this.setState({ confirmDiscardChanges: value })
    this.props.onConfirmDiscardChangesChanged(value)
  }

  private onConfirmDiscardChangesPermanentlyChanged = (
    event: React.FormEvent<HTMLInputElement>
  ) => {
    const value = event.currentTarget.checked

    this.setState({ confirmDiscardChangesPermanently: value })
    this.props.onConfirmDiscardChangesPermanentlyChanged(value)
  }

  private onConfirmDiscardStashChanged = (
    event: React.FormEvent<HTMLInputElement>
  ) => {
    const value = event.currentTarget.checked

    this.setState({ confirmDiscardStash: value })
    this.props.onConfirmDiscardStashChanged(value)
  }

  private onConfirmCheckoutCommitChanged = (
    event: React.FormEvent<HTMLInputElement>
  ) => {
    const value = event.currentTarget.checked

    this.setState({ confirmCheckoutCommit: value })
    this.props.onConfirmCheckoutCommitChanged(value)
  }

  private onConfirmForcePushChanged = (
    event: React.FormEvent<HTMLInputElement>
  ) => {
    const value = event.currentTarget.checked

    this.setState({ confirmForcePush: value })
    this.props.onConfirmForcePushChanged(value)
  }

  private onConfirmUndoCommitChanged = (
    event: React.FormEvent<HTMLInputElement>
  ) => {
    const value = event.currentTarget.checked

    this.setState({ confirmUndoCommit: value })
    this.props.onConfirmUndoCommitChanged(value)
  }

  private onAskForConfirmationOnCommitFilteredChanges = (
    event: React.FormEvent<HTMLInputElement>
  ) => {
    const value = event.currentTarget.checked

    this.setState({ askForConfirmationOnCommitFilteredChanges: value })
    this.props.onAskForConfirmationOnCommitFilteredChanges(value)
  }

  private onConfirmCommitMessageOverrideChanged = (
    event: React.FormEvent<HTMLInputElement>
  ) => {
    const value = event.currentTarget.checked

    this.setState({ confirmCommitMessageOverride: value })
    this.props.onConfirmCommitMessageOverrideChanged(value)
  }

  private onConfirmWorktreeRemovalChanged = (
    event: React.FormEvent<HTMLInputElement>
  ) => {
    const value = event.currentTarget.checked

    this.setState({ confirmWorktreeRemoval: value })
    this.props.onConfirmWorktreeRemovalChanged(value)
  }

  private onConfirmRepositoryRemovalChanged = (
    event: React.FormEvent<HTMLInputElement>
  ) => {
    const value = event.currentTarget.checked

    this.setState({ confirmRepositoryRemoval: value })
    this.props.onConfirmRepositoryRemovalChanged(value)
  }

  private onUncommittedChangesStrategyChanged = (
    value: UncommittedChangesStrategy
  ) => {
    this.setState({ uncommittedChangesStrategy: value })
    this.props.onUncommittedChangesStrategyChanged(value)
  }

  private onShowCommitLengthWarningChanged = (
    event: React.FormEvent<HTMLInputElement>
  ) => {
    this.props.onShowCommitLengthWarningChanged(event.currentTarget.checked)
  }

  private renderSwitchBranchOptionLabel = (key: UncommittedChangesStrategy) => {
    switch (key) {
      case UncommittedChangesStrategy.AskForConfirmation:
        return '问我改动要跟到哪里'
      case UncommittedChangesStrategy.MoveToNewBranch:
        return '总是把改动带到我的新分支'
      case UncommittedChangesStrategy.StashOnCurrentBranch:
        return '总是贮藏改动、留在当前分支'
      default:
        return assertNever(key, `Unknown uncommitted changes strategy: ${key}`)
    }
  }

  private renderSwitchBranchOptions = () => {
    const options = [
      UncommittedChangesStrategy.AskForConfirmation,
      UncommittedChangesStrategy.MoveToNewBranch,
      UncommittedChangesStrategy.StashOnCurrentBranch,
    ]

    const selectedKey =
      options.find(o => o === this.state.uncommittedChangesStrategy) ??
      UncommittedChangesStrategy.AskForConfirmation

    return (
      <div className="advanced-section">
        <h2 id="switch-branch-heading">
          如果我有改动却要切换分支……
        </h2>

        <RadioGroup<UncommittedChangesStrategy>
          ariaLabelledBy="switch-branch-heading"
          selectedKey={selectedKey}
          radioButtonKeys={options}
          onSelectionChanged={this.onUncommittedChangesStrategyChanged}
          renderRadioButtonLabelContents={this.renderSwitchBranchOptionLabel}
        />
      </div>
    )
  }

  private renderCommittingFilteredChangesPrompt = () => {
    return (
      <Checkbox
        label="提交被筛选隐藏的改动"
        value={
          this.state.askForConfirmationOnCommitFilteredChanges
            ? CheckboxValue.On
            : CheckboxValue.Off
        }
        onChange={this.onAskForConfirmationOnCommitFilteredChanges}
      />
    )
  }

  public render() {
    return (
      <DialogContent>
        <div className="advanced-section">
          <h2 id="show-confirm-dialog-heading">
            在这些操作前显示确认框……
          </h2>
          <div role="group" aria-labelledby="show-confirm-dialog-heading">
            <Checkbox
              label="移除仓库"
              value={
                this.state.confirmRepositoryRemoval
                  ? CheckboxValue.On
                  : CheckboxValue.Off
              }
              onChange={this.onConfirmRepositoryRemovalChanged}
            />
            <Checkbox
              label="丢弃改动"
              value={
                this.state.confirmDiscardChanges
                  ? CheckboxValue.On
                  : CheckboxValue.Off
              }
              onChange={this.onConfirmDiscardChangesChanged}
            />
            <Checkbox
              label="永久丢弃改动"
              value={
                this.state.confirmDiscardChangesPermanently
                  ? CheckboxValue.On
                  : CheckboxValue.Off
              }
              onChange={this.onConfirmDiscardChangesPermanentlyChanged}
            />
            <Checkbox
              label="丢弃贮藏"
              value={
                this.state.confirmDiscardStash
                  ? CheckboxValue.On
                  : CheckboxValue.Off
              }
              onChange={this.onConfirmDiscardStashChanged}
            />
            <Checkbox
              label="检出某次提交"
              value={
                this.state.confirmCheckoutCommit
                  ? CheckboxValue.On
                  : CheckboxValue.Off
              }
              onChange={this.onConfirmCheckoutCommitChanged}
            />
            <Checkbox
              label="强制推送"
              value={
                this.state.confirmForcePush
                  ? CheckboxValue.On
                  : CheckboxValue.Off
              }
              onChange={this.onConfirmForcePushChanged}
            />
            <Checkbox
              label="撤销提交"
              value={
                this.state.confirmUndoCommit
                  ? CheckboxValue.On
                  : CheckboxValue.Off
              }
              onChange={this.onConfirmUndoCommitChanged}
            />
            <Checkbox
              label="用生成的信息覆盖提交信息"
              value={
                this.state.confirmCommitMessageOverride
                  ? CheckboxValue.On
                  : CheckboxValue.Off
              }
              onChange={this.onConfirmCommitMessageOverrideChanged}
            />
            <Checkbox
              label="移除 worktree"
              value={
                this.state.confirmWorktreeRemoval
                  ? CheckboxValue.On
                  : CheckboxValue.Off
              }
              onChange={this.onConfirmWorktreeRemovalChanged}
            />
            {this.renderCommittingFilteredChangesPrompt()}
          </div>
        </div>
        {this.renderSwitchBranchOptions()}
        <div className="advanced-section">
          <h2>提交摘要长度</h2>
          <Checkbox
            label="显示提交摘要长度提示"
            value={
              this.props.showCommitLengthWarning
                ? CheckboxValue.On
                : CheckboxValue.Off
            }
            onChange={this.onShowCommitLengthWarningChanged}
          />
        </div>
      </DialogContent>
    )
  }
}
