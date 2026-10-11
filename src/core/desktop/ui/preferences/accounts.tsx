import * as React from 'react'
import {
  Account,
  isDotComAccount,
  isEnterpriseAccount,
} from '../../models/account'
import { IAvatarUser } from '../../models/avatar'
import { lookupPreferredEmail } from '../../lib/email'
import { assertNever } from '../../lib/fatal-error'
import { Button } from '../lib/button'
import { Row } from '../lib/row'
import { DialogContent, DialogPreferredFocusClassName } from '../dialog'
import { Avatar } from '../lib/avatar'
import { CallToAction } from '../lib/call-to-action'
import { getHTMLURL } from '../../lib/api'

interface IAccountsProps {
  readonly accounts: ReadonlyArray<Account>

  readonly onDotComSignIn: () => void
  readonly onEnterpriseSignIn: () => void
  readonly onLogout: (account: Account) => void

  /*
   * ★ **dsh-git 加的两个可选插槽**(2026-11,作为**结构偏离**登记在
   * `scripts/verify-mirror.mjs` 的 EXPECTED 里)。上游没有这两个 prop;加它们是因为
   * 「PAT 令牌登录」这个入口**必须落在 GitHub.com 那一段的动作行里**(与登录 / 退出登录按钮
   * 同一行),而那段 DOM 由本组件渲染,从外面(页级兄弟节点)够不到。
   *
   * 为什么是**两个**而不是一个:按钮要在动作行里(横向),展开后的表单是一整块(纵向)——
   * 把整块塞进 `Row` 会被 flex 挤成一条。
   *
   * 两个都是**可选**:不传时本组件的 DOM 与上游逐字相同(几何探针照旧)。
   */
  /** 放进 GitHub.com 动作行(与登录 / 退出登录按钮同一行)的节点。 */
  readonly patSignInAction?: React.ReactNode
  /** 紧跟 GitHub.com 那一段之后的整块内容(PAT 表单展开时的那套输入)。 */
  readonly patSignInForm?: React.ReactNode
}

enum SignInType {
  DotCom,
  Enterprise,
}

export class Accounts extends React.Component<IAccountsProps, {}> {
  public render() {
    const { accounts } = this.props
    const dotComAccount = accounts.find(isDotComAccount)

    return (
      <DialogContent className="accounts-tab">
        <h2>GitHub.com</h2>
        {dotComAccount
          ? this.renderAccount(dotComAccount, SignInType.DotCom)
          : this.renderSignIn(SignInType.DotCom)}
        {/* dsh-git:我们的 PAT 表单(收起时是 null) */}
        {this.props.patSignInForm}

        <h2>GitHub Enterprise</h2>
        {this.renderMultipleEnterpriseAccounts()}
      </DialogContent>
    )
  }

  private renderMultipleEnterpriseAccounts() {
    const enterpriseAccounts = this.props.accounts.filter(isEnterpriseAccount)

    return (
      <>
        {enterpriseAccounts.map(account => {
          return this.renderAccount(account, SignInType.Enterprise)
        })}
        {enterpriseAccounts.length === 0 ? (
          this.renderSignIn(SignInType.Enterprise)
        ) : (
          <Button onClick={this.props.onEnterpriseSignIn}>
            添加 GitHub Enterprise 账号
          </Button>
        )}
      </>
    )
  }

  private renderAccount(account: Account, type: SignInType) {
    const avatarUser: IAvatarUser = {
      name: account.name,
      email: lookupPreferredEmail(account),
      avatarURL: account.avatarURL,
      endpoint: account.endpoint,
    }

    // The DotCom account is shown first, so its sign in/out button should be
    // focused initially when the dialog is opened.
    const className =
      type === SignInType.DotCom ? DialogPreferredFocusClassName : undefined

    return (
      <Row className="account-info">
        <div className="user-info-container">
          <Avatar accounts={this.props.accounts} user={avatarUser} />
          <div className="user-info">
            {isEnterpriseAccount(account) ? (
              <>
                <div className="account-title">
                  {account.name === account.login
                    ? `@${account.login}`
                    : `@${account.login} (${account.name})`}
                </div>
                <div className="endpoint">{getHTMLURL(account.endpoint)}</div>
              </>
            ) : (
              <>
                <div className="name">{account.name}</div>
                <div className="login">@{account.login}</div>
              </>
            )}
          </div>
        </div>
        <Button onClick={this.logout(account)} className={className}>
          {__DARWIN__ ? '退出登录' : '退出登录'}
        </Button>
        {/*
          dsh-git:插槽只在 **GitHub.com** 那一行渲染(企业账号行不加 —— 企业实例有自己的
          CTA 与「添加 GitHub Enterprise 账号」按钮,那个入口打开的是同一个表单)。
        */}
        {type === SignInType.DotCom ? this.props.patSignInAction : null}
      </Row>
    )
  }

  private onDotComSignIn = () => {
    this.props.onDotComSignIn()
  }

  private onEnterpriseSignIn = () => {
    this.props.onEnterpriseSignIn()
  }

  private renderSignIn(type: SignInType) {
    const signInTitle = __DARWIN__ ? '登录' : '登录'
    switch (type) {
      case SignInType.DotCom: {
        /*
         * dsh-git:上游这里**直接**返回 `CallToAction`。我们把它包进一个 `.row-component`
         * 的 div,好让「PAT 令牌登录」按钮落在同一个动作行里(那条
         * `.row-component .button-component{align-self:flex-end}` 正好让它与 CTA 的按钮底对齐)。
         * ⚠️ 这里**不用** `Row` 组件:它的 `IRowProps` 没有声明 `children`(与
         * `DialogContent` / `TabBar` 是同一处上游类型缺口),而它渲染出来的就是这个 div。
         */
        return (
          <div className="row-component">
            <CallToAction
              actionTitle={signInTitle + ' GitHub.com'}
              onAction={this.onDotComSignIn}
              // The DotCom account is shown first, so its sign in/out button should be
              // focused initially when the dialog is opened.
              buttonClassName={DialogPreferredFocusClassName}
            >
              <div>
                登录你的 GitHub.com 账号以访问你的仓库。
              </div>
            </CallToAction>
            {this.props.patSignInAction}
          </div>
        )
      }
      case SignInType.Enterprise:
        return (
          <CallToAction
            actionTitle={signInTitle + ' GitHub Enterprise'}
            onAction={this.onEnterpriseSignIn}
          >
            <div>
              如果你在工作中使用 GitHub Enterprise,登录它以访问你的仓库。
            </div>
          </CallToAction>
        )
      default:
        return assertNever(type, `Unknown sign in type: ${type}`)
    }
  }

  private logout = (account: Account) => {
    return () => {
      this.props.onLogout(account)
    }
  }
}
