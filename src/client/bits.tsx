/**
 * 共享小件:确认气泡、toast 栈、可复制 SHA。
 * 破坏性动作(丢弃/强推/删除分支)统一走确认气泡。
 * @module dsh-git/client/bits
 */

import { useCallback, useEffect, useId, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
/*
 * 通知横幅用**宿主原语**(`Toast`),错误档用宿主自带的警告图标。
 *
 * 为什么这两个名字能在这里裸 import(不需要 `@ts-expect-error`、也不需要 `require`):
 *  · **运行期**:已安装的宿主包就是它们
 *    (`/Applications/DSH Desktop.app/…/node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/index.js`
 *    的导出列表里 `Toast` 与 `IconWarningOutlineRegular` 都在,逐个核过;参考实现在
 *    `references/deepseek-harness/packages/client/ui-primitives/src/Toast.tsx` 与 `src/icons/index.tsx`)。
 *    构建里它是 external(`scripts/build.mjs:67` 的 `clientExternal`),产物只多一条
 *    `require("@deepseek-ai/dsh-client-ui-primitives")` —— require 家族数仍是 **4**。
 *  · **类型面**:`types/client-platform-shims.d.ts` 的显式 `declare module` 按「用过谁声明谁」
 *    维护。**这里记一笔互相依赖的经过**:本轮先加了这两行 import,而当时 shim 里只有
 *    Modal / SegmentedTabs / SettingsForm / SettingsValueField ⇒ tsc 报两条 TS2305;
 *    因为 `types/**` 不在当时那份可改清单里,临时加过一行 `@ts-expect-error`
 *    (并写明退役条件)。随后补 shim 的那条线把 `Toast`(含 prop 面与 `holdMs` 的说明)
 *    与 `IconWarningOutlineRegular` 补了进去,于是那行指令按退役条件**删掉了**
 *    (留着它会在本就没有错误时反过来报 `Unused '@ts-expect-error'`/TS2578)。
 *  · 依据的读数:`tsc --noEmit --pretty false -p tsconfig.json | grep bits.tsx` ——
 *    补 shim 前是 **2 条 TS2305**,补后是 **0 条**(先出现 1 条 TS2578 说明指令已多余)。
 */
import { IconWarningOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives';
import { Icon } from './icons.ts';
import type { GitStore } from './store.ts';
import type { GitError } from '../core/types.ts';

/** 确认气泡。 */
export function ConfirmDialog(props: {
  title: string;
  body?: string;
  confirmText?: string;
  danger?: boolean;
  /** 给了就在对话框里加一个单行输入框(Desktop 的 Create Alias / Rename 都是这个形状)。 */
  input?: { value: string; placeholder?: string; onChange: (value: string) => void };
  onDone: (value: boolean) => void;
}): ReactNode {
  const [busy] = useState(false);
  const titleId = useId();
  // Esc 取消:对话框必须有键盘退出路径,否则键盘用户被困住。
  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      props.onDone(false);
    }
  };
  return (
    <div className="gw-dialog-scrim" onKeyDown={onKeyDown}
      onMouseDown={(event) => { if (event.target === event.currentTarget) props.onDone(false); }}>
      <div className="gw-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h4 id={titleId}>{props.title}</h4>
        {props.body !== undefined && <p>{props.body}</p>}
        {props.input !== undefined && (
          <input className="gw-input" autoFocus value={props.input.value}
            placeholder={props.input.placeholder}
            onChange={(event) => props.input?.onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') { event.preventDefault(); props.onDone(true); }
            }} />
        )}
        <div className="gw-dialog-actions">
          <button className="gw-btn" disabled={busy} onClick={() => props.onDone(false)}>取消</button>
          <button className={`gw-btn ${props.danger === true ? 'danger' : 'primary'}`}
            autoFocus={props.input === undefined}
            onClick={() => props.onDone(true)}>
            {props.confirmText ?? '确认'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 推送失败:上游那一族**弹窗**的分派(用户 2026-10 报「推送到 origin 失败没有弹窗」)
 * ------------------------------------------------------------------ */

/**
 * 上游对「推送失败」按 **git 的机器可读错误码 + stderr 正则**分成几种弹窗;
 * 我们的宿主把这两样都原样交给客户端(`src/core/types.ts:33-38` 的
 * `{ code, message, detail }`),所以这里只做**照上游判据的分派**,不新增宿主字段。
 *
 * | 上游 surface(弹窗本体) | 上游判据(file:line) | 这里的分派依据 |
 * |---|---|---|
 * | `PopupType.PushNeedsPull` → `PushNeedsPullWarning`(`ui/push-needs-pull/push-needs-pull-warning.tsx`,标题 `Newer commits on remote`) | `DugiteError.PushNotFastForward`(`ui/dispatcher/error-handlers.ts:201`,弹窗在 `:214`) | `error.code === 'not-fast-forward'`(宿主 `git-service.ts:87-89`) |
 * | `PopupType.PushRejectedDueToMissingWorkflowScope` → `WorkflowPushRejectedDialog`(`ui/workflow-push-rejected/workflow-push-rejected.tsx`,标题 `Push rejected`) | `rejectedPathRe` 命中消息(`ui/dispatcher/error-handlers.ts:382-383` 定义、`:413` 判、`:419-423` 弹) | **同一个正则**命中 `error.detail`(宿主把 git 原始 stderr 放在这里,`git-service.ts:83`) |
 * | `PopupType.Error` → `AppError`(`ui/app-error.tsx:49`,推送时标题是 **`Failed to push`**,见 `:170-175` 的 `RetryActionType.Push`) | 兜底 `defaultErrorHandler`(`error-handlers.ts:81-89` → `app-store.ts:5005-5010` 的 `_pushError` → `lib/popup-manager.ts:131` 的 `addErrorPopup`) | 其余一律 |
 *
 * 同一族的**其余** surface 不在本仓可达范围内(逐条登记,不是漏了):
 * `SAMLReauthRequired`(`error-handlers.ts:435-478`,要 GHES endpoint)、
 * `insufficientGitHubRepoPermissions`(`:484-522`,要 GitHub 仓库的 write 权限模型)、
 * `PushProtectionError`(`:670-696` 的 `ui/secret-scanning/**`,按 `goal-port-desktop.md`
 * §1.3 整块排除)、`UpstreamAlreadyExists`(`:314-329`,来源是
 * `git-store.ts:1326-1341` 的 `addUpstreamRemoteIfNeeded` —— **不在推送路径上**)。
 * 「没有远端」那一条上游走的是 `PopupType.PublishRepository`
 * (`app-store.ts:5222-5229`),而发布向导需要宿主 `publishRepository` 路由(我们没有),
 * 那条排除已经登记在 `toolbar.tsx:579-603`。
 */
export type PushFailureKind = 'needs-pull' | 'workflow-scope' | 'generic';

/**
 * 上游 `ui/dispatcher/error-handlers.ts:382-383` 的 `rejectedPathRe`,**逐字**。
 * 唯一的区别:上游跑在 `error.message` 上(那是 dugite 拼的整段输出),
 * 这里跑在 `error.detail` 上 —— 宿主的 `message` 是本地化过的中文短句,
 * git 原始 stderr 在 `detail`(`git-service.ts:83` 的 `truncate(stderr, 2000)`)。
 */
const WORKFLOW_SCOPE_RE =
  /^ ! \[remote rejected\] .*? -> .*? \(refusing to allow an OAuth App to create or update workflow `(.*?)` without `workflow` scope\)/m;

/** 从推送失败的 stderr 里取出被拒的工作流文件路径(上游 `:421` 的 `match[1]`)。 */
export function workflowRejectedPathOf(error: GitError): string | null {
  const match = WORKFLOW_SCOPE_RE.exec(error.detail ?? '');
  return match === null ? null : match[1] ?? null;
}

/**
 * 一条推送失败该弹哪个窗。判据逐条对上游(见 {@link PushFailureKind} 的表);
 * 顺序也有意义:上游的处理器链是**后注册先跑**
 * (`ui/dispatcher/dispatcher.ts:797-806` 的倒序遍历),`pushNeedsPullHandler`
 * 在 `refusedWorkflowUpdate` **之前**被调用(`ui/index.tsx:337,347` 的注册表),
 * 所以 `not-fast-forward` 优先。
 */
export function pushFailureKindOf(error: GitError): PushFailureKind {
  if (error.code === 'not-fast-forward') {
    return 'needs-pull';
  }
  if (workflowRejectedPathOf(error) !== null) {
    return 'workflow-scope';
  }
  return 'generic';
}

/**
 * 宿主在 **git 的 stderr 为空**时写进 `message` 的占位符
 * (`src/host/git-service.ts:102`:`detail.split('\n').find(...) ?? '未知错误'`)。
 *
 * 用户报的缺陷就是它:「推送失败居中弹窗里,出现未知错误」——弹窗把宿主的占位符
 * **当原因播了出去**,而宿主其实一个原因都没拿到。它**不是**原因,所以不许出现在正文里
 * (用户追加要求:「不许出现「未知错误」这种占位符」「应该给出详细的错误信息」)。
 *
 * 为什么在**客户端**补偿而不是改宿主:占位符的产出点在 `src/host/**`,本轮不在授权范围内
 * (`docs/push-failure-surfaces.md` §3 已登记宿主契约不变)。
 * **退役条件**:宿主的 `classifyGitFailure` 不再用占位符(例如改成上游 `core.ts:172` 那种
 * `Unknown error (exit code N)`,或干脆把「stderr 为空」单独给一个码)时,这个常量与
 * {@link GENERIC_NO_HOST_REASON} 一起删掉,正文直接回落到 `error.message`。
 *
 * ⚠️ **判据是这个字面量本身**。理论上 git 的 stderr 也可能带这三个字(自建 hook 可以随便打中文),
 * 那种情况的后果仅仅是:我们跳过 `message`、只播 `detail` —— 而宿主那句 `message` 的正文**就是**
 * stderr 的第一行(`git-service.ts:102`),所以证据一个字都不会丢,只是少一行重复。
 *
 * ⚠️ **行号是读数、不是契约**:`src/host/git-service.ts` 在 2026-10-06 深夜**正被另一条泳道改写**
 * (本轮实测 mtime 23:53;`:98` 是它在上一版的位置)。判据锚在**表达式**上
 * (`detail.split('\n').find(非空行) ?? '未知错误'`),行号漂移不影响这个常量。
 */
const HOST_PLACEHOLDER = '未知错误';

/**
 * 通用档在**宿主一个原因都没给出**时的正文。
 *
 * 触发条件三条同时成立(`{@link PushFailureDialog}` 里逐条判):
 *   · `message` 含 {@link HOST_PLACEHOLDER};且
 *   · `detail` 缺席(宿主连 git 的 stderr 都没有)。
 * 实测能造出这一档的**真**失败:远端把 TCP 连接挂住 ⇒ git 在写出任何 stderr 之前就被宿主
 * 按超时杀掉(`exitCode=null`,见 `git-service.ts:1724-1735` 那条推送调用的
 * `timeoutMs: 180_000`)⇒ `classifyGitFailure('', '推送')` 落兜底 ⇒ 信封是
 * `{code:'internal', message:'推送失败:未知错误'}`、**没有 `detail`**。
 *
 * 措辞只陈述宿主真正知道的事(「在写出任何输出之前被中止」是判据,「典型情形是超时」是实测机制),
 * 不编造 git 的命令行与退出码 —— 载荷里没有那两样(用户要求:没有就别编)。
 * 出处:上游 `lib/git/core.ts:161-172` 在没有 stderr/stdout 时也会把**机器事实**播出去
 * (`Unknown error (exit code ${result.exitCode})`);我们这里对应的机器事实就是下面那行
 * `错误码:<code>`。
 */
const GENERIC_NO_HOST_REASON =
  '这次推送在 git 写出任何错误输出之前就被中止了(典型情形:网络把连接挂住,直到宿主的超时上限生效),'
  + '所以没有 git 的原文可以引用。下面是宿主给出的机器可读错误码。';

/**
 * **推送失败的弹窗** —— 上游 `PushNeedsPullWarning` / `WorkflowPushRejectedDialog` /
 * `AppError` 三者在浏览器半的等价物。
 *
 * 文案按 `goal-port-desktop.md` §11.9 的人类裁决**本地化成中文**(结构/行为沿用上游,
 * 用户可见文案中文化);标题与正文的**语义**逐条对应上游:
 *  - `needs-pull`:上游 `push-needs-pull-warning.tsx:34-37` 的标题 + `:41-47` 的正文 +
 *    `:49-53` 的 `okButtonText="Fetch"` 单按钮;
 *  - `workflow-scope`:上游 `workflow-push-rejected.tsx:39-59` 的标题 + 两段正文
 *    (第二段问「要不要开浏览器授权」);**我们只保留说明、不给那个按钮** ——
 *    那个按钮要 OAuth scope 授权流程,本插件用 PAT、宿主也没有该路由
 *    (登记为排除,理由见 `prefs.ts` 的凭据一节)。
 *  - `generic`:上游 `app-error.tsx:296-311` 的标题 + 正文,`error.message` 之外
 *    把 git 原始输出放进 `<pre>`(上游是 `<Terminal rows={15}>`,`:80-83`);
 *    页脚按 `:246-262`:认证类失败 ⇒ `Close` + `Open Preferences`
 *    (`:275-281` 的 `renderOpenPreferencesFooter`),其余 ⇒ 单个 `Close`
 *    (`:283-285` 的 `DefaultDialogFooter`,`default-dialog-footer.tsx:39` 的 `'Close'`)。
 *
 * ## 「详细错误信息」这条契约(用户追加要求,是硬验收)
 *
 * 弹窗必须给出这次失败的**全部可用证据**,一个都不许丢:
 *  1. **标题按种类**(非快进 ⇒ `远端有更新的提交`;workflow scope ⇒ `推送被拒绝`;
 *     其余含认证失败 ⇒ `推送失败` = 上游 `app-error.tsx:170-175` 的 `Failed to push`)。
 *     ⚠️ 上游**没有**认证专用表面 —— 认证失败只是把页脚换成 `Close` + `Open Preferences`
 *     (`:275-281`),标题仍是 `Failed to push`。所以这里刻意不另造一个认证标题。
 *  2. **宿主的 `message` 逐字**(见渲染处);
 *  3. **`detail`(git 原始 stderr)逐字、不截断**,长则滚动(`.gw-dialog pre` 的
 *     `max-height:180px; overflow:auto`),**不把原因裁掉**;
 *  4. **可选中**:上游这一族**没有**复制按钮(在 `app-error.tsx` / `default-dialog-footer.tsx`
 *     / `terminal.tsx` 里 grep `copy` 命中 0),所以按用户要求「至少保证文本可选中」——
 *     `.gw-dialog pre` 显式 `user-select:text`(拒绝 `user-select:none`)。
 *  5. **有机器字段就显示**:载荷里只有 `code`(`core/types.ts:33-38`)⇒ 显示 `错误码:<code>`;
 *     **没有** git 退出码/失败命令,所以不编那两样。
 *
 * ⚠️ **唯一一处不逐字播 `message` 的情形**是 {@link HOST_PLACEHOLDER}:宿主在 stderr 为空时
 * 写的是占位符,把它当原因播出去就是用户报的那个缺陷(`未知错误`),所以那种情形改播
 * {@link GENERIC_NO_HOST_REASON}(它只陈述宿主真正知道的事)。
 */
export function PushFailureDialog(props: {
  error: GitError;
  /** 「抓取」按钮(只在 `needs-pull` 档出现)—— 接 `store.fetch()`。 */
  onFetch: () => void;
  /** 「打开设置」按钮(只在认证类失败时出现)—— 接我们的偏好弹窗(含登录页)。 */
  onOpenPreferences: () => void;
  onDismiss: () => void;
}): ReactNode {
  const { error } = props;
  const titleId = useId();
  const kind = pushFailureKindOf(error);
  const rejectedPath = kind === 'workflow-scope' ? workflowRejectedPathOf(error) : null;
  const authFailed = error.code === 'auth-failed';
  /*
   * 正文里那两行「证据」的判据(见下面渲染处)。两条都**只读载荷**,不做任何网络/仓库探测。
   *
   * `reasonText` 的三态:
   *   · 宿主 message 不含占位符 ⇒ 逐字播它(最常见);
   *   · 含占位符 **且** 有 detail ⇒ 不播 message(占位符不是原因),真因就在下面的 `pre` 里;
   *   · 含占位符 **且** 没有 detail ⇒ 播 {@link GENERIC_NO_HOST_REASON}(宿主一个原因都没给)。
   */
  const hasDetail = error.detail !== undefined && error.detail !== '';
  const hostPlaceholder = error.message.includes(HOST_PLACEHOLDER);
  const reasonText = hostPlaceholder
    ? (hasDetail ? '' : GENERIC_NO_HOST_REASON)
    : error.message;
  const { onDismiss } = props;

  /*
   * 两个处理器都过 `useCallback` —— 不是为了性能,是因为本仓的
   * `react/jsx-no-bind`(默认配置)**会解析标识符**:`const f = () => …` 之后再
   * 把 `f` 交给 JSX 属性一样算违规(插件 `jsx-no-bind.js` 的 `VariableDeclarator`
   * 分支只认 `node.init` 是不是箭头/函数表达式)。`useCallback(...)` 的 init 是
   * `CallExpression` ⇒ 不落进那个集合。这条**是被闸门逼出来的,而闸门是对的**:
   * 本仓不许用 lint disable 换绿。
   */
  const onKeyDown = useCallback((event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onDismiss();
    }
  }, [onDismiss]);
  const onBackdropMouseDown = useCallback((event: React.MouseEvent): void => {
    if (event.target === event.currentTarget) {
      onDismiss();
    }
  }, [onDismiss]);

  return (
    <div className="gw-dialog-scrim" onKeyDown={onKeyDown} onMouseDown={onBackdropMouseDown}>
      <div className="gw-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h4 id={titleId}>
          {kind === 'needs-pull' ? '远端有更新的提交'
            : kind === 'workflow-scope' ? '推送被拒绝'
              : '推送失败'}
        </h4>
        {kind === 'needs-pull' && (
          <p>
            无法推送到这个分支:远端存在你本地没有的提交。请先抓取这些新提交,
            与本地提交协调之后再推送。
          </p>
        )}
        {kind === 'workflow-scope' && (
          <>
            <p>
              服务器拒绝了这次推送,因为它改动了工作流文件
              {rejectedPath === null ? null : <code> {rejectedPath}</code>}。
              要推送工作流文件,GitHub 需要额外授权。
            </p>
            <p>
              本插件使用 Personal Access Token 登录,不能在这里追加 scope:
              请到 GitHub 重新签发一个带 <code>workflow</code> scope 的 Token,
              再回到设置里重新登录。
            </p>
          </>
        )}
        {/*
         * 宿主的 `message`,**逐字**(用户要求「宿主给的 message 原样显示」)。
         *
         * 通用档这一行就是上游 app-error 的正文本身(`ui/app-error.tsx:168` 的兜底
         * `return <p>{e.message}</p>`);识别出的两档把它**追加**在上游正文之后 ——
         * 上游那两档不带原文,而用户明确要求「全部可用证据」都在弹窗里,且宿主这句
         * 常常比上游文案多一条可操作信息(例如非快进那句里的「或在推送菜单里选择强推」)。
         *
         * 唯一的例外见 {@link HOST_PLACEHOLDER}:占位符不算原因,不许播出去。
         */}
        {reasonText === '' ? null : <p>{reasonText}</p>}
        {/*
         * git 的**原始 stderr**,逐字、不截断(`error.detail`,`core/types.ts:33-38`)。
         * 上游把原始 git 输出交给 `Terminal(rows=15)`(`ui/app-error.tsx:80-83`);
         * 我们的等价物是限高可滚的 `pre`(`styles.ts` 的 `.gw-dialog pre`:
         * `max-height:180px; overflow:auto; user-select:text`)—— 长 stderr **滚动**,
         * 不是把原因裁掉(用户要求)。
         */}
        {hasDetail ? <pre className="gw-dialog-detail">{error.detail}</pre> : null}
        {/*
         * 载荷里**唯一**的机器可读字段(`core/types.ts:33-38` 的 `code`)。
         * 用户要求「载荷里另有失败命令/退出码之类字段就一并显示;没有就别编」——
         * 我们**没有** git 的退出码(宿主没有透出它),所以只显示这个真实存在的码。
         * 上游等价物:没有 stderr/stdout 时播出机器事实(`lib/git/core.ts:172` 的
         * `Unknown error (exit code ${result.exitCode})`)。
         */}
        <p className="gw-dialog-code">错误码:{error.code}</p>
        <div className="gw-dialog-actions">
          {kind === 'generic' && authFailed && (
            <button className="gw-btn" onClick={props.onOpenPreferences}>打开设置</button>
          )}
          {kind === 'needs-pull'
            ? (
              <>
                <button className="gw-btn" onClick={props.onDismiss}>取消</button>
                <button className="gw-btn primary" autoFocus={true} onClick={props.onFetch}>抓取</button>
              </>
            )
            : (
              <button className="gw-btn primary" autoFocus={true} onClick={props.onDismiss}>关闭</button>
            )}
        </div>
      </div>
    </div>
  );
}

/**
 * 宿主 toast 原语的**停留时长**(它自己管「停留 → 淡出 → 调 onDone」)。
 *
 * 这两个数不是审美量,是从 `store.ts` 的既有两个定时器**倒推**出来的:
 *
 *   store.ts:318   setTimeout(..., kind === 'err' ? 7000 : 3600)
 *   Toast.tsx:8    const FADE_MS = 1000   // 淡出时长,与样式表的 fade 1500→… 一致(原语自己的注释)
 *
 * 原语的可见总时长 = holdMs + FADE_MS。取 `store 的定时器 − FADE_MS − 200`,于是:
 *   · ok : 2400 + 1000 = 3400 < 3600 ✓
 *   · err: 5800 + 1000 = 6800 < 7000 ✓
 * 那 200ms 是**余量**,目的是让**原语先结束**(onDone → `store.dismissToast`),
 * 而不是让 store 的定时器把还在淡出的元素直接卸载掉(那会在最后一帧硬切)。
 * ⚠️ `store.ts` 改这两个数时,这里必须同批改(它是被沿用的那一侧,我们不是真源)。
 */
const TOAST_HOLD_MS_OK = 2400;
const TOAST_HOLD_MS_ERR = 5800;

/* ------------------------------------------------------------------ *
 * 帧级通知来源:谁的通知该出现在 `shell.overlay` 那一份通知面上
 * ------------------------------------------------------------------ */

/**
 * 一条通知属于**某一颗 store**(`store.ts:259` 的 `toasts` 各自成栈),而
 * `shell.overlay` 席位是 `scope:'root'`、**不带 sessionId**
 * (`references/deepseek-harness/packages/extensions/cordis-client-runner/src/client/slot-catalog.ts:2845`
 * 起的 `ownerProps: []`、`hookContext: ''`)⇒ 席位那一棵树上问不出「现在是哪一颗 store」。
 *
 * 所以这里放一份**来源注册表**:每颗活着的 store 登记进来,席位上的
 * {@link FrameToasts} 只渲染**最新到的那一条**。它同时兑现了宿主文档给这个席位的正典
 * 语义之一 ——「一条通知要活过报出它的那个面板」
 * (`packages/client/ui-chat/src/client/apply.ts:264-272` 的 quota notice 正是为此搬上去的)。
 *
 * ## 选择规则(与改前逐字同义,只是范围从「同一颗 store」扩到「所有来源」)
 *
 * 1. **新到的那条赢**:某颗来源的通知栈里出现新 id ⇒ 它成为当前来源,其余来源里还活着的
 *    条目**当场摘掉**。
 *    ⚠️ **不能只是不渲染**:那样最新那条淡出之后,旧的会**迟到地弹出来**(比丢弃更坏)。
 *    单横幅原语没有堆叠能力,所以「极短时间内连发两条只看得到最后一条」仍是既有代价。
 * 2. 当前来源的通知栈变空 ⇒ 通知面渲染 null。
 * 3. 多颗 store 同时活着时,**后到的赢**;先到且仍在显示的那条被摘掉(同上)。
 */
const toastSources = new Set<GitStore>();

/**
 * 每颗来源**上一次看到**的通知 id 集合:在 emit 里认出「新到的那条」。
 *
 * ⚠️ **不能用 id 大小比较**:`id` 是 `store.ts:398` 的 `++this.toastSeq`,**每颗 store
 * 各自的计数器**,跨 store 不可比(两颗 store 都从 1 开始)。
 */
const seenToastIds = new Map<GitStore, Set<number>>();

/** 通知面的当前投影;`revision` 只为了让 `useSyncExternalStore` 看到**新对象**。 */
let toastView: { store: GitStore | null; revision: number } = { store: null, revision: 0 };
const toastViewListeners = new Set<() => void>();

function publishToastView(store: GitStore | null): void {
  toastView = { store, revision: toastView.revision + 1 };
  for (const listener of toastViewListeners) {
    try {
      listener();
    } catch {
      /* 单个订阅者异常不影响其他(与 store.ts:376-380 同规矩) */
    }
  }
}

function subscribeToastView(listener: () => void): () => void {
  toastViewListeners.add(listener);
  return () => { toastViewListeners.delete(listener); };
}

/** `useSyncExternalStore` 的读取入口:引用只在 {@link publishToastView} 里换。 */
function toastViewSnapshot(): { store: GitStore | null; revision: number } {
  return toastView;
}

/**
 * 把一颗 store 登记成**帧级通知来源**,返回注销函数。
 *
 * 两个调用点各一次:`workbench.tsx`(每颗 session store)与 `src/client/index.ts`
 * (设置卡片用的全局 store)。注销由各自的 `ctx.effect` / `useEffect` 清理函数负责,
 * 所以 store 消失后不会留下悬挂订阅。
 * @param store - 要登记的 store(必须实现 `subscribe` + `snapshot`)。
 * @returns 注销函数(幂等)。
 */
export function registerToastSource(store: GitStore): () => void {
  toastSources.add(store);
  seenToastIds.set(store, new Set(store.snapshot().toasts.map((toast) => toast.id)));
  const unsubscribe = store.subscribe(() => { onToastSourceChange(store); });
  return () => {
    unsubscribe();
    toastSources.delete(store);
    seenToastIds.delete(store);
    if (toastView.store === store) {
      publishToastView(null);
    }
  };
}

/**
 * 某颗来源的通知栈变了:认出「新到的」并按选择规则重投影。
 *
 * 重入是**预期**的(摘别的来源会触发它们自己的这个函数),所以每一步都不假设
 * 「现在只有我在跑」:摘除只写各自 store,投影只在最后一步发一次。
 * @param store - 变化的那颗来源。
 */
function onToastSourceChange(store: GitStore): void {
  const toasts = store.snapshot().toasts;
  const seen = seenToastIds.get(store) ?? new Set<number>();
  const arrived = toasts.some((toast) => !seen.has(toast.id));
  seenToastIds.set(store, new Set(toasts.map((toast) => toast.id)));
  if (arrived) {
    for (const other of toastSources) {
      if (other === store) {
        continue;
      }
      for (const stale of other.snapshot().toasts) {
        other.dismissToast(stale.id);
      }
    }
    publishToastView(store);
    return;
  }
  /*
   * 没有新条目、但变了(当前那条被 dismissToast 摘掉 / store 的定时器到点)⇒ 重投一次,
   * 让通知面重读快照(空栈 ⇒ 渲染 null)。
   */
  if (toastView.store === store) {
    publishToastView(store);
  }
}

/**
 * `shell.overlay` 席位上的通知面 —— **注册进席位的那个组件**
 * (`src/client/index.ts` 的 `dsh-git.toasts` 条目)。
 *
 * 它自己不渲染任何本地 DOM:真正的横幅由原语 portal 到 `document.body`
 * (`Toast.tsx:74-76`)。所以这个席位条目**不会**占住帧里任何一块可点区域。
 * @returns 当前那条通知,或 null(没有通知时不占任何东西)。
 */
export function FrameToasts(): ReactNode {
  const view = useSyncExternalStore(subscribeToastView, toastViewSnapshot, toastViewSnapshot);
  const store = view.store;
  if (store === null) {
    return null;
  }
  return <Toasts store={store} toasts={store.snapshot().toasts} />;
}

/* ------------------------------------------------------------------ *
 * 右下角 + 按右栏夹宽:几何写成 CSS 变量,由 styles.ts 那条规则消费
 * ------------------------------------------------------------------ */

/**
 * 通知带两侧的留白(px)。
 *
 * ⚠️ 这个数与 `styles.ts` 里 `html[data-gw-toast-clamp] body > div[role="alert"]:has(…)`
 * 那条规则**必须同源**:数值只在这里定,规则里用 `--gw-toast-*` 变量消费。改这个数
 * 只改这一处。
 */
const TOAST_GUTTER_PX = 12;

/**
 * 左栏的**网格下限**(px)—— `styles.ts:359` 的 `grid-template-columns:minmax(190px,44%) 1fr`。
 *
 * 只在「量不到右栏」的保守回退里用(见 {@link toastBand}),正常路径用实测值。
 */
const LEFT_COLUMN_MIN_PX = 190;

/** 通知带(气泡可以占据的那块矩形,视口坐标)。 */
interface IToastBand {
  /** 带子的右缘(视口 x)。 */
  right: number;
  /** 带子的下缘(视口 y)。 */
  bottom: number;
  /** 带子的宽(气泡夹宽 = 它 − 两侧留白)。 */
  width: number;
  /** 带子的高(气泡夹高 = 它 − 两侧留白)。 */
  height: number;
}

/**
 * 通知带的那颗元素 = **右栏**(`.gw-split > .right`,即 diff 那一侧)。
 *
 * 为什么是它:提交按钮在**左栏底部**(`.gw-commit` 在 `.gw-split > .left` 里),而两栏是
 * 同一个 grid 的两个轨道、矩形不相交 ⇒ **把气泡夹在右栏的矩形内,与提交按钮的交集就是
 * 0,与左栏多宽无关**(构造性,不是调参调出来的)。
 *
 * `.right` 的 `overflow:hidden`(`styles.ts:362`)与这件事无关:气泡是原语 portal 到
 * `document.body` 的 `position:fixed` 元素,不在 `.right` 的盒子里,不会被它裁 ——
 * 我们只是**借它的实测矩形当带宽**。
 * @returns 第一颗可见的右栏元素,或 null。
 */
function toastBandElement(): HTMLElement | null {
  for (const candidate of Array.from(document.querySelectorAll<HTMLElement>('.gw-split > .right'))) {
    if (candidate.getBoundingClientRect().width > 0) {
      return candidate;
    }
  }
  return null;
}

/**
 * 量出通知带。两级:
 *
 * 1. **右栏实测**(正常路径);
 * 2. **整个插件根**(`.gw-root`)的保守版:横向预留左栏的网格下限 + 纵向只取一半高度。
 *    两处预留都不是审美量 —— 窄档(`@container (max-width:420px)`,`styles.ts:717-719`)
 *    会把 `.gw-split` 换成 `1fr / 1fr` 的**上下堆叠**,那时横向夹宽不再保护纵向,
 *    所以回退档必须同时把纵向压到下半区。
 *
 * 量不到(既没有 `.right` 也没有可见的 `.gw-root`)⇒ `null`,调用方**不覆盖**原语的
 * 位置,退回它自己的 `top:40px` 居中 —— 那是改前的行为,永远不会比改前更坏。
 * @returns 通知带,或 null。
 */
function toastBand(): IToastBand | null {
  const right = toastBandElement();
  if (right !== null) {
    const rect = right.getBoundingClientRect();
    return { right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
  }
  for (const root of Array.from(document.querySelectorAll<HTMLElement>('.gw-root'))) {
    const rect = root.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      continue;
    }
    return {
      right: rect.right,
      bottom: rect.bottom,
      width: Math.max(0, rect.width - LEFT_COLUMN_MIN_PX),
      height: rect.height / 2,
    };
  }
  return null;
}

/**
 * 有通知在显示时,把右下角的**位置与夹宽**写成四个 CSS 变量,并在 `<html>` 上打一个门控
 * 属性 `data-gw-toast-clamp`。
 *
 * ## 为什么必须走 CSS 变量,而不是给原语传 prop
 *
 * 原语的 `anchor` **只**能改水平中心(`Toast.tsx:60-73`,纵向写死 `top:40px`),而原语还把
 * 横幅 portal 到 `document.body`(`:74-76`)—— 于是「放进 `shell.overlay` 的盒子里」这条
 * 路**不存在**:座位那棵树不是它的 DOM 祖先。唯一能同时改「右下角」和「夹宽」的地方,
 * 是 `styles.ts` 里那条**带门控的 CSS 规则**;这里负责把实测几何喂给它。
 *
 * 变量挂在 `<html>` 上(原生 `:root`):`position:fixed` 的包含块是视口,只有根上的变量
 * 才能被它继承到。**它们只被那条规则消费**(规则另外还要求 `:has()` 命中我们自己的
 * 图标标记),所以挂根上不会影响宿主或别的东西。
 *
 * 量不到带子时:**不写任何变量、也不打门控属性** ⇒ 规则整条不生效 ⇒ 原语退回它自己的
 * 顶部居中。宁可退化成改前的样子,也不要半套覆盖。
 * @param active - 现在有没有通知在显示。
 */
function useToastBandClamp(active: boolean): void {
  useLayoutEffect(() => {
    if (!active) {
      return;
    }
    const html = document.documentElement;
    const names = ['--gw-toast-right', '--gw-toast-bottom', '--gw-toast-max-w', '--gw-toast-max-h'];
    const clear = (): void => {
      for (const name of names) {
        html.style.removeProperty(name);
      }
      html.removeAttribute('data-gw-toast-clamp');
    };
    const apply = (): void => {
      const band = toastBand();
      if (band === null) {
        clear();
        return;
      }
      const viewportW = html.clientWidth;
      const viewportH = html.clientHeight;
      html.style.setProperty('--gw-toast-right', `${Math.max(0, viewportW - band.right) + TOAST_GUTTER_PX}px`);
      html.style.setProperty('--gw-toast-bottom', `${Math.max(0, viewportH - band.bottom) + TOAST_GUTTER_PX}px`);
      html.style.setProperty('--gw-toast-max-w', `${Math.max(0, band.width - TOAST_GUTTER_PX * 2)}px`);
      html.style.setProperty('--gw-toast-max-h', `${Math.max(0, band.height - TOAST_GUTTER_PX * 2)}px`);
      html.setAttribute('data-gw-toast-clamp', '');
    };
    apply();
    /*
     * 用户拖分隔条会改右栏宽,而窗口不 resize ⇒ 必须观察**带子自己**。
     * 拿不到 ResizeObserver(旧 WebView)时还有 window resize 兜底,不会完全不工作。
     */
    const target = toastBandElement();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(apply);
    if (target !== null && observer !== null) {
      observer.observe(target);
    }
    window.addEventListener('resize', apply);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', apply);
      clear();
    };
  }, [active]);
}

/**
 * 通知栈 —— **渲染宿主原语 `@deepseek-ai/dsh-client-ui-primitives` 的 `Toast`**,
 * 位置改到**右下角 + 按右栏夹宽**(2026-10,用户裁决)。
 *
 * ## 为什么换掉我们自己的 `.gw-toast`(2026-10,用户报缺陷后)
 *
 * 用户原话:「生成 commit message 后的通知是宽度铺满的,会挡到提交按钮」。
 * 根因不是一个宽度数字:改前我们**自己手搓**了一个通知栈,把它绝对定位在插件根
 * 底部通栏(`styles-base.ts:174-178` 的 `left:12px;right:12px;bottom:34px`)——
 * 那正好压在 `.gw-commit` 的提交按钮上。
 *
 * 这个仓库对「宿主已有的东西」有成文规矩:**对齐优先,不要自己造**。通知这件事宿主
 * 已经有一等公民:`Toast`(`ui-primitives` 的 `Toast.tsx`,由
 * `lib/client.js` 的 4 个 require 家族之一 `@deepseek-ai/dsh-client-ui-primitives` 提供,
 * **不新增依赖、不新增家族**),它自己管:
 *
 * | 原语负责 | 出处(file:line) |
 * |---|---|
 * | 定位:`position:fixed; top:40px; left:50%; transform:translateX(-50%)` | `Toast.module.css:8-9,33` |
 * | 宽度:`width:max-content; max-width:min(640px, calc(100vw - 48px))`(**永不铺满**) | 同上 `:24-25` |
 * | 层级/不吃点击:`z-index:1100; pointer-events:none` | 同上 `:11-13` |
 * | 颜色角色:`--dsw-alias-toast-bg` / `--dsw-alias-toast-label` + `--dsw-radius-lg` | 同上 `:26,29-31` |
 * | 停留 → 淡出 → 回调卸载(`holdMs`,默认 3000) | `Toast.tsx:6-8,52-57` |
 * | 可点的行内动作(只有动作文字吃指针) | 同上 `:44-48` + `Toast.module.css:70-72` |
 * | `anchor`:只改**水平中心** | `Toast.tsx:60-73` |
 * | portal 到 `document.body`(不会被 `.gw-root` 的 `contain:paint` 裁掉) | `Toast.tsx:74-76` |
 *
 * ## 位置:为什么不是原语的顶部居中,以及是怎么改的(2026-10 用户裁决「右下角」)
 *
 * 用户要「右下角气泡,类似 VS Code」,而且要**碰不到提交按钮**。原语把自己的位置写死在
 * CSS module 里(`top:40px; left:50%`),`anchor` 只动水平中心 ⇒ 位置改不了;
 * 而它 portal 到 `document.body` ⇒ 也没法「放进某一列的盒子里」。
 *
 * 所以位置与夹宽由 **`styles.ts` 里一条带门控的规则**完成,它同时用两个条件锁死作用范围:
 *
 *  1. `html[data-gw-toast-clamp]` —— 由 {@link useToastBandClamp} 在**量到通知带**时打上;
 *  2. `:has(> span > .gw-toast-mark)` —— 命中**我们自己的图标位标记**(见下面
 *     {@link ToastIcon}),宿主自己的横幅(clip 也走同一个原语)不会被波及。
 *
 * 于是**别的插件/宿主的 toast 一个字节都不会被改**:没有标记就命中不了那条规则。
 * 唯一的可见代价是成功档的图标从原语的 `tone="success"` 换成
 * `Icon name="check-circle"`(同一个宿主令牌上色,理由与实测都写在该组件上)。
 *
 * ## 与旧实现的**行为差异**(不是漏做,是取舍,必须知道)
 *
 * 1. **一次只显示一条**。原语是单横幅设计(没有纵向堆叠能力),所以只渲染**最新**那条,
 *    并把更早的从各自 store 里 dismiss 掉。⚠️ **不能只是不渲染旧的**:那样最新那条淡出
 *    之后,旧的会**迟到地弹出来**(比丢弃更坏)。代价:极短时间内连发两条时,只看得到
 *    最后一条(改前也一样)。
 * 2. **位置从「插件根底部通栏」变成「右下角、按右栏(diff 侧)夹宽」**。这是本轮的用户
 *    裁决;`docs/probes/toast-overlay-probe.mjs` 量的是它与提交按钮的交集(要求恒为 0)。
 * 3. `role` 由原语给定(`role="alert"`,原语文件里写死);旧实现是容器 `role=status` +
 *    每条的 `alert/status` 二选一。屏幕阅读器仍然会宣告。
 * 4. 旧实现的 `action` 按钮**点了没反应**:容器 `pointer-events:none` 会被子元素继承,
 *    而那条规则从没把 `auto` 加回去。原语把 `pointer-events:auto` 只加在动作文字上
 *    (`Toast.module.css:70-72`)⇒ 这里映到它的 `actions`,那个静默缺陷是**原语**修好的;
 *    夹宽规则只写 `max-width`/位置,没有碰 `pointer-events`(见 styles.ts 那条规则的注释)。
 */
export function Toasts(props: {
  store: GitStore;
  toasts: readonly {
    id: number;
    message: string;
    kind: 'ok' | 'err';
    actionLabel?: string;
    action?: () => void;
  }[];
}): ReactNode {
  const { store, toasts } = props;
  const current = toasts.length === 0 ? null : toasts[toasts.length - 1];
  /*
   * 更早的那些:只留它们的 id(字符串化后当依赖)。`toasts` 每次 emit 都是新数组,
   * 直接进依赖数组会让这个 effect 每次渲染都跑;而 effect 里的 `dismissToast` 又会 emit
   * ⇒ 很容易滑向「渲染-派发」互相触发的坏形状。用 id 列表的字符串做依赖,
   * 内容不变时就不重跑,收敛条件一眼可见。
   */
  const olderIds = toasts.slice(0, -1).map((toast) => toast.id).join(',');
  useEffect(() => {
    if (olderIds === '') {
      return;
    }
    for (const id of olderIds.split(',').map(Number)) {
      store.dismissToast(id);
    }
  }, [olderIds, store]);
  /* 钩子必须在提前 return 之前调用(它无条件;`active` 才是条件)。 */
  useToastBandClamp(current !== null);
  if (current === null) return null;
  const isError = current.kind === 'err';
  return (
    <Toast
      /* `key` 绑 id:同一条文案再次出现时原语要**重新播一遍**,而不是原地不动。 */
      key={current.id}
      text={current.message}
      /*
       * ⚠️ **刻意不用 `tone="success"`**:那一档会把 `icon` prop 整个忽略
       * (`Toast.tsx:78-80` 的三元),而我们需要图标位里有一个**能当 CSS 选择器用**的
       * 标记(见上面 `:has(> span > .gw-toast-mark)`),否则没法只命中我们自己的横幅。
       * 代价是成功档的字形换成上游 octicon 的环状对勾(`Icon name="check-circle"`,
       * `src/client/icons.ts:89` 指向 `octicons.checkCircle`,与镜像字节一致),
       * 颜色仍用原语那一档自己的令牌(`--dsw-alias-state-success-primary`,
       * 见 `Toast.module.css` 的 `.icon.success`),尺寸也对齐原语默认的 20。
       */
      icon={<ToastIcon kind={current.kind} />}
      holdMs={isError ? TOAST_HOLD_MS_ERR : TOAST_HOLD_MS_OK}
      /* store 的 `action` / `actionLabel` 是成对写入的(`store.ts:399-405`);这里只做映射。 */
      actions={current.action === undefined ? undefined : [{
        label: current.actionLabel ?? '执行',
        onClick: () => {
          current.action?.();
          store.dismissToast(current.id);
        },
      }]}
      /* 淡出结束 ⇒ 从 store 里摘掉(原语只负责可见期;条目属于 store)。 */
      onDone={() => store.dismissToast(current.id)}
    />
  );
}

/**
 * 通知的**图标位** —— 同时充当「这条横幅是我们的」那个 CSS 标记。
 *
 * 类名 `gw-toast-mark` 是**跨文件契约**:`styles.ts` 那条夹宽规则的选择器里写的就是它,
 * `docs/probes/toast-overlay-probe.mjs` 会同时读这两个源文件、断言两边的名字一致
 * (改一边忘另一边 ⇒ 探针红,而不是横幅静默回到顶部居中)。
 *
 * ⚠️ 它必须是**原语 icon 位的直接子节点**:原语把 `icon` 包在自己的
 * `<span class="…icon">` 里,所以规则写成 `:has(> span > .gw-toast-mark)`。
 * 错误档用宿主自己的警告图标(`IconWarningOutlineRegular`,与
 * `ui-open-in-app/src/client/open-failure-toast.tsx` 同一做法)。
 * @param props - 通知档位。
 * @returns 带标记类的图标节点。
 */
function ToastIcon(props: { kind: 'ok' | 'err' }): ReactNode {
  if (props.kind === 'err') {
    return <span className="gw-toast-mark"><IconWarningOutlineRegular /></span>;
  }
  /* `size={20}` 对齐原语图标位默认尺寸(宿主那几个图标组件的默认 `size = 20`)。 */
  return <span className="gw-toast-mark gw-toast-ok"><Icon name="check-circle" size={20} /></span>;
}

/** 可复制的短 SHA。 */
export function Sha(props: { value: string }): ReactNode {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <span className="pill" title="点击复制完整 SHA"
      onClick={() => {
        void navigator.clipboard?.writeText(props.value);
        setCopied(true);
      }}>
      {copied ? '已复制' : props.value.slice(0, 7)}
    </span>
  );
}

/** 状态字母。 */
export function StatusLetter(props: { status: string }): ReactNode {
  const letter = props.status === '?' ? '?' : props.status[0] ?? 'M';
  return <span className={`gw-st ${letter === '?' ? 'gw-st?' : letter}`}>{letter}</span>;
}

/** 空态。 */
export function Empty(props: { icon?: string; title: string; body?: string; children?: ReactNode }): ReactNode {
  return (
    <div className="gw-empty">
      {props.icon !== undefined && <div style={{ marginBottom: 8, opacity: 0.6 }}><Icon name={props.icon} size={26} /></div>}
      <div style={{ color: 'var(--dsw-alias-label-secondary)' }}>{props.title}</div>
      {props.body !== undefined && <div style={{ marginTop: 6 }}>{props.body}</div>}
      {props.children !== undefined && <div style={{ marginTop: 12 }}>{props.children}</div>}
    </div>
  );
}
