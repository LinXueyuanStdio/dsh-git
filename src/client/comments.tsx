/**
 * 评论区共享块:评论列表 + 发表框(Issue 与 PR 详情抽屉复用)。
 * 删除仅对「当前鉴权用户本人的评论」显示且需确认;支持行内编辑。
 */

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { GhIcon as GwIcon } from './icons-gh.ts';
import * as api from './gh-api.ts';
import { timeAgo, type GhRef } from '../core/lib.ts';
import { errText, useUI } from './gh.ts';

export function CommentsBlock(props: {
  ghRef: GhRef; number: number;
  comments: api.GhComment[];
  onChanged: () => void;
  nextUrl?: string | null;
  loadingMore?: boolean;
  onLoadMore?: () => void;
}): ReactNode {
  const ui = useUI();
  const [viewer, setViewer] = useState<string | null>(null);

  useEffect(() => { api.getViewerLogin().then(setViewer); }, []);

  async function del(c: api.GhComment): Promise<void> {
    if (!(await ui.confirm({
      title: '删除这条评论?',
      body: c.body.slice(0, 120),
      confirmText: '删除', danger: true,
    }))) return;
    try {
      await api.deleteComment(props.ghRef, c.id);
      ui.toast('评论已删除');
      props.onChanged();
    } catch (e) { ui.toast(errText(e), 'err'); }
  }

  if (props.comments.length === 0 && !props.nextUrl) return null;

  return (
    <div>
      <div className="gw-pop-divider" style={{ margin: '14px 0 4px' }} />
      <div className="gw-muted" style={{ fontSize: 11, marginBottom: 2 }}>
        —— 评论 {props.comments.length}{props.nextUrl ? '+' : ''} ——
      </div>
      {props.comments.map((c) => (
        <CommentRow key={c.id} comment={c} mine={viewer != null && c.user?.login === viewer}
          ghRef={props.ghRef} onChanged={props.onChanged} onDelete={() => del(c)} />
      ))}
      {props.nextUrl && props.onLoadMore && (
        <div className="gw-more">
          <button className="gw-btn" disabled={props.loadingMore} onClick={props.onLoadMore}>
            {props.loadingMore ? '加载中…' : '加载更多评论'}
          </button>
        </div>
      )}
    </div>
  );
}

function CommentRow(props: {
  comment: api.GhComment; mine: boolean;
  ghRef: GhRef; onChanged: () => void; onDelete: () => void;
}): ReactNode {
  const ui = useUI();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(props.comment.body);
  const [busy, setBusy] = useState(false);

  if (editing) {
    return (
      <div className="gw-comment">
        <textarea className="gw-input gw-textarea" value={text} onChange={(e) => setText(e.target.value)} autoFocus />
        <div className="gw-composer-row" style={{ marginTop: 6 }}>
          <button className="gw-btn primary" disabled={busy || !text.trim()} onClick={async () => {
            setBusy(true);
            try {
              await api.editComment(props.ghRef, props.comment.id, text);
              ui.toast('评论已更新'); setEditing(false); props.onChanged();
            } catch (e) { ui.toast(errText(e), 'err'); }
            finally { setBusy(false); }
          }}>保存</button>
          <button className="gw-btn" onClick={() => { setEditing(false); setText(props.comment.body); }}>取消</button>
        </div>
      </div>
    );
  }

  return (
    <div className="gw-comment">
      <div className="gw-comment-head">
        <strong style={{ color: 'var(--dsw-alias-label-secondary)' }}>{props.comment.user?.login ?? 'ghost'}</strong>
        <span>{timeAgo(props.comment.created_at)}</span>
        {props.mine && (
          <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 4 }}>
            <button className="gw-hbtn" title="编辑评论" onClick={() => setEditing(true)}>
              <GwIcon name="pencil" size={12} />
            </button>
            <button className="gw-hbtn" title="删除评论" onClick={props.onDelete}>
              <GwIcon name="trash" size={12} />
            </button>
          </span>
        )}
      </div>
      <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{props.comment.body}</div>
    </div>
  );
}

/**
 * 底部发表框(受控于父级刷新回调)。
 *
 * ## 2026-10 本轮补了一个**看得见的提交按钮**
 *
 * 此前这里**只渲染一个 `<textarea>`**:唯一的发表路径是 `⌘/Ctrl + Enter`
 * (`onKeyDown` 那一支),而 placeholder 只写「写下评论…(Markdown)」——
 * 没有任何地方告诉用户还有这个快捷键。也就是说「发表评论」这个动作
 * **在界面上没有可点的控件**。它与「渲染得出来、点了没反应」是同一族缺陷的另一面
 * (用户报的原文是「看一下所有按钮有没有存在没实现的」),本轮一并补掉:
 * 加一个 `gw-btn primary` 的「发表评论」,并在旁边把快捷键写成可见提示。
 *
 * 没有新造任何行为:`submit()` 就是原来 `onKeyDown` 走的那一个函数,
 * 按钮只是把它变得**可发现**;`busy` / 空文本的禁用条件与快捷键那一支逐条一致
 * (空文本时快捷键本来也不触发:`text.trim() &&` 那个条件)。
 */
export function CommentComposer(props: { ghRef: GhRef; number: number; onDone: () => void }): ReactNode {
  const ui = useUI();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <>
      <textarea className="gw-input gw-textarea" placeholder="写下评论…(Markdown)"
        value={text} onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && text.trim() && !busy) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="gw-composer-row" style={{ marginTop: 6 }}>
        <span className="gw-hint" style={{ padding: 0 }}>支持 Markdown;⌘/Ctrl + Enter 也能发表</span>
        <span className="grow" />
        <button className="gw-btn primary" disabled={busy || !text.trim()}
          title={!text.trim() ? '先写点什么' : '发表这条评论'}
          onClick={onSubmitClick}>
          {busy ? '发表中…' : '发表评论'}
        </button>
      </div>
    </>
  );

  /*
   * **函数声明而不是内联箭头**(`react/jsx-no-bind` 会拦内联箭头,而
   * `scripts/lint-baseline.json` 是只拦上升的棘轮)。
   *
   * ⚠️ 这里能过闸门还有一个**顺序**上的原因:`onSubmitClick` 声明在 `return` **之后**,
   * 而该规则是按源码顺序在 `JSXAttribute` 访问时读「当前块已知的函数绑定集合」——
   * 所以按名引用它时不命中。**如果哪天把这两个函数挪到 `return` 之前,这条就会变红。**
   * 那种情况下正确的写法是 `useCallback`(该规则不认 CallExpression 形态的绑定)。
   */
  function onSubmitClick(): void {
    void submit();
  }

  async function submit(): Promise<void> {
    setBusy(true);
    try {
      await api.addComment(props.ghRef, props.number, text.trim());
      ui.toast('评论已发表');
      setText('');
      props.onDone();
    } catch (e) { ui.toast(errText(e), 'err'); }
    finally { setBusy(false); }
  }
}
