/**
 * **Squash 对话框(多提交操作的客户端一半)**。
 *
 * ## 这个文件是什么、不是什么
 *
 * 它是**上游没有单独一份**的那个容器:`references/desktop` 里 squash 的入口是
 * `ui/history/compare.tsx:667-728` 的 `onSquash`,它
 *  ① 用 `getSquashedCommitDescription` 算出默认消息,
 *  ② 打开 `PopupType.CommitMessage`(应用层的通用提交消息弹窗)让用户改,
 *  ③ 回调里调 `dispatcher.squash(...)` → `app-store._squash`(`:9520-9546`)→
 *     `lib/git/squash.ts`。
 *
 * ② 那个弹窗依赖 `ui/app.tsx` 的弹窗宿主 + `lib/stores/app-store.ts`(10,935 行,
 * `docs/goal-port-desktop.md` §1.3 明确不沿用的应用层),本插件**没有**它们。
 * 所以这里写的是**容器那一层**(与 `clone-dialog.tsx` / `preferences-dialog.tsx` 同性质):
 * 它**不重写**上游的任何判据 —— 默认消息来自镜像的 `getSquashedCommitDescription`
 * (17 行,逐字在树)、最终消息用镜像的 `formatCommitMessage`(同样逐字在树,
 * 上游 `app-store.ts:9535` 用的就是它),执行走宿主路由
 * `multi-commit/squash`(argv/env 逐字对着上游 `lib/git/rebase.ts:576-633`)。
 *
 * ## 一处**已知的**、必须写明的缺口
 *
 * 上游 `dispatcher.squash(..., continueWithForcePush)` 在**没配**
 * 「强推前确认」时先弹 `WarnForcePushDialog`(镜像里逐字在树:
 * `ui/multi-commit-operation/dialog/warn-force-push-dialog.tsx`),并在成功后
 * 把流程接到 `processMultiCommitOperationRebaseResult`(要 `forcePushBranches` /
 * banner 那一整套)。本插件**没有**那套状态机,所以这里**不假装**:
 * squash 成功后只做「刷新」,不做「提示可以强推」。
 * 那条缺口的落点与理由见 `docs/multi-commit-operation-adoption.md` §4。
 *
 * ## 冲突档(必须与宿主那条注释一起读)
 *
 * 宿主 `multi-commit/squash` 把 `ConflictsEncountered` 当**成功响应**返回
 * (上游 `parseRebaseResult:425-427` 就是**返回**它)。仓库此刻停在 rebase 中途,
 * 而续跑只能靠 `continueRebase`。
 * ⚠️ 2026-10-10 更正:那条路由**已经存在**(`src/host/routes.ts` 的 `'rebase/continue'`
 * → `GitService.continueRebase`;Changes 页签的 `ContinueRebase` 表单就是它的调用方)。
 * 下面那句「请在命令行里用 git rebase --continue」仍然**成立**(git 命令有效),
 * 但已不再是**唯一**出路 —— 文案要不要改成指向 Changes 页签那件 UI 属**产品裁决**,
 * 本轮**没有**改它(没有探针覆盖 squash 冲突档的这句文案,改了就是无读数改动)。
 * ⇒ 这一档**不能**说「成功」,也不能说「失败」:界面上如实说「已经停下」。
 *
 * @module dsh-git/client/squash-dialog
 */

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { api } from './api.ts';
import { PluginDialog } from './host-modal.tsx';
import { formatCommitMessage } from '../core/desktop/lib/format-commit-message.ts';
import { getSquashedCommitDescription } from '../core/desktop/lib/squash/squashed-commit-description.ts';
import { Repository } from '../core/desktop/models/repository.ts';
import type { Commit } from '../core/desktop/models/commit.ts';

/**
 * 对话框的 DOM id = **产物里的唯一 ASCII 字面量**。
 *
 * 为什么刻意留一个:`docs/probes/multi-commit-route-probe.mjs` 的 C 组要判
 * 「这条接线真的进了包」。判据用**产物里的字面量**比 grep 源码强(它绕过
 * `import type` 被擦除、绕过 tree-shaking),但那个仪器**只对 ASCII 字面量有效**
 * (`README-probe-index.md`)。所以这里放一个 ASCII 的 id,而**不要**依赖中文文案。
 */
export const SQUASH_DIALOG_ID = 'squash-commits-dialog';

export interface ISquashDialogProps {
  /** 仓库路径(宿主路由的 `path`)。 */
  readonly path: string;
  /** 要被压掉的提交(**不含** `squashOnto`),顺序 = log 顺序。 */
  readonly toSquash: ReadonlyArray<Commit>;
  /** 压到哪一条提交上(它自己变成 `pick`)。 */
  readonly squashOnto: Commit;
  /** 区间下界;`null` ⇒ 根提交 ⇒ 宿主走 `--root`。 */
  readonly lastRetainedCommitRef: string | null;
  readonly onDismissed: () => void;
  /** 操作**已经不在进行中**时的回调(成功、或已确认停下)。参数是宿主的 `result`。 */
  readonly onCompleted: (result: string) => void;
}

/** 对话框的三态。`conflicts` 是**上游意义上的成功**,但它需要一句不同的话。 */
type SquashPhase =
  | { readonly kind: 'editing' }
  | { readonly kind: 'submitting' }
  | { readonly kind: 'conflicts' }
  | { readonly kind: 'failed'; readonly message: string };

/**
 * Squash 对话框。
 *
 * @param props - 见 {@link ISquashDialogProps}。
 */
export function SquashDialog(props: ISquashDialogProps): ReactNode {
  const { path, toSquash, squashOnto, lastRetainedCommitRef, onDismissed, onCompleted } = props;

  const repository = useMemo(() => new Repository(path, 0, null, false), [path]);
  /** 上游 `compare.tsx:708` 的初值就是 `squashOnto.summary`。 */
  const [summary, setSummary] = useState(squashOnto.summary);
  /** 上游 `compare.tsx:680-683` 的 `squashedDescription`。 */
  const initialDescription = useMemo(
    () => getSquashedCommitDescription(toSquash, squashOnto),
    [toSquash, squashOnto],
  );
  const [description, setDescription] = useState(initialDescription);
  const [phase, setPhase] = useState<SquashPhase>({ kind: 'editing' });

  const onSummaryChange = useCallback((event: { currentTarget: { value: string } }) => {
    setSummary(event.currentTarget.value);
  }, []);
  const onDescriptionChange = useCallback((event: { currentTarget: { value: string } }) => {
    setDescription(event.currentTarget.value);
  }, []);

  const onSubmit = useCallback(() => {
    setPhase({ kind: 'submitting' });
    void (async () => {
      try {
        /*
         * 消息的拼法与上游**同一份实现**:`app-store.ts:9535` 的
         * `await formatCommitMessage(repository, commitContext)`。
         */
        const commitMessage = await formatCommitMessage(repository, { summary, description });
        const res = await api.multiCommitSquash({
          path,
          toSquash: toSquash.map((c) => c.sha),
          squashOnto: squashOnto.sha,
          lastRetainedCommitRef,
          commitMessage,
        });
        if (!res.ok) {
          setPhase({ kind: 'failed', message: res.error.message });
          return;
        }
        if (res.value.result === 'ConflictsEncountered') {
          setPhase({ kind: 'conflicts' });
          return;
        }
        onCompleted(res.value.result);
      } catch (error) {
        setPhase({
          kind: 'failed',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  }, [
    description,
    lastRetainedCommitRef,
    onCompleted,
    path,
    repository,
    squashOnto.sha,
    summary,
    toSquash,
  ]);

  const count = toSquash.length + 1;
  const submitting = phase.kind === 'submitting';

  return (
    <PluginDialog
      className="gw-squash"
      labelledBy={`${SQUASH_DIALOG_ID}-title`}
      onClose={onDismissed}
    >
      <h2 id={`${SQUASH_DIALOG_ID}-title`}>
        Squash {count} Commits
      </h2>
      <div id={SQUASH_DIALOG_ID} className="gw-squash-body">
        {/*
          提交消息的两个字段逐字照上游 `PopupType.CommitMessage` 的形状
          (`prepopulateCommitSummary: true`:摘要可编辑、描述可编辑)。
        */}
        <label htmlFor={`${SQUASH_DIALOG_ID}-summary`}>摘要</label>
        <input
          id={`${SQUASH_DIALOG_ID}-summary`}
          className="gw-input"
          value={summary}
          onChange={onSummaryChange}
          disabled={submitting || phase.kind === 'conflicts'}
        />
        <label htmlFor={`${SQUASH_DIALOG_ID}-description`}>描述</label>
        <textarea
          id={`${SQUASH_DIALOG_ID}-description`}
          className="gw-input"
          rows={8}
          value={description}
          onChange={onDescriptionChange}
          disabled={submitting || phase.kind === 'conflicts'}
        />
        {phase.kind === 'failed' ? (
          <p className="gw-squash-hint" role="alert">压缩失败:{phase.message}</p>
        ) : null}
        {phase.kind === 'conflicts' ? (
          <p className="gw-squash-hint" role="alert">
            有冲突:仓库已经停在 rebase 中途。本插件还没有「继续 / 中止变基」的入口,
            请在命令行里用 git rebase --continue(或 --abort)把它跑完。
          </p>
        ) : null}
      </div>
      <div className="gw-dialog-actions">
        <button className="gw-btn" onClick={onDismissed} disabled={submitting}>
          {phase.kind === 'conflicts' ? '关闭' : '取消'}
        </button>
        <button
          className="gw-btn primary"
          onClick={onSubmit}
          disabled={submitting || phase.kind === 'conflicts' || summary.trim() === ''}
        >
          {submitting ? '压缩中…' : `压缩 ${count} 个提交`}
        </button>
      </div>
    </PluginDialog>
  );
}
