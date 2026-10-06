/**
 * Issues 页签:列表(工具条 + 新建)+ 详情抽屉(正文 / 评论 / 编辑 / 关闭重开)。
 * 写操作:新建、评论、编辑标题正文、编辑/删除评论、关闭/重开(关闭需确认)。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { GhIcon as GwIcon, type IconName } from './icons-gh.ts';
import * as api from './gh-api.ts';
import { labelTextColor, timeAgo, type GhRef } from '../core/lib.ts';
import { Loading, ErrorBox, Empty } from './ui.tsx';
import { errText, useUI } from './gh.ts';
import { CommentComposer, CommentsBlock } from './comments.tsx';

export interface ListViewProps {
  ghRef: GhRef;
  visible: boolean;
  onCount: (n: number) => void;
  /** 外链深链:初始打开的 issue/PR 编号(消费一次)。 */
  initialDetail?: number | null;
  onConsumeDeep?: () => void;
}

export function IssuesView({ ghRef, onCount, initialDetail, onConsumeDeep }: ListViewProps): ReactNode {
  const [list, setList] = useState<api.GhIssue[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<number | null>(initialDetail ?? null);
  useEffect(() => { if (initialDetail != null) onConsumeDeep?.(); }, [initialDetail]);
  const [showNew, setShowNew] = useState(false);
  const [stateFilter, setStateFilter] = useState<api.IssueState>('open');
  const [sort, setSort] = useState<api.ListSort>('created');
  const [nextUrl, setNextUrl] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const reqId = useRef(0);

  /*
   * `onCount` 由父组件以**内联箭头**传入(`workbench.tsx` 的
   * `<IssuesView onCount={(n) => store.setCount('issues', n)} />`)⇒ 父组件每次渲染
   * 都是新身份;而父组件**每 5 秒**会因 store 轮询 `emit({status, sync})` 而重渲染
   * (`store.ts` 的 `emit()` 总是造新 state 对象,`useSyncExternalStore` 因此重渲染)。
   *
   * 若把 `onCount` 留在 `load` 的依赖里,`load` 就每 5 秒换一次身份,于是下面那个
   * 「切仓库/筛选时重置并重拉」的 effect 每 5 秒触发一次 —— 闪烁 + 重复请求 + 打断
   * 分页。这正是原来那行 `eslint-disable-next-line` 存在的原因,但它**没有写理由**,
   * 于是看起来像在禁空气(见 `docs/lint-layer.md` §8.5)。
   *
   * 解法:用**最新值 ref** 持有它,`load` 在调用时读 `onCountRef.current`,依赖表就
   * 只剩真正决定请求内容的那几个值 ⇒ `load` 身份稳定,抑制也就不需要了。
   * 这是 React 官方对「回调不该触发 effect」的惯用解法(ref 在 commit 后同步,而
   * `load` 只在事件/effect 里被调用,读到的必然是最新值)。
   */
  const onCountRef = useRef(onCount);
  useEffect(() => {
    onCountRef.current = onCount;
  });

  // 列表加载:仓库/筛选/排序变化 → 清空进加载态;加载更多 → 追加;写操作后 → 静默换新(不闪)
  const load = useCallback((silent: boolean, pageUrl?: string) => {
    const id = pageUrl ? reqId.current : ++reqId.current;
    if (pageUrl) setLoadingMore(true);
    else if (!silent) setList(null);
    setError(null);
    api.listIssues(ghRef, stateFilter, sort, pageUrl)
      .then((page) => {
        if (id !== reqId.current) return;
        setList((prev) => (pageUrl && prev ? [...prev, ...page.items] : page.items));
        setNextUrl(page.nextUrl);
        setTotal(page.totalCount);
        if (stateFilter === 'open' && page.totalCount != null) onCountRef.current(page.totalCount);
      })
      .catch((e) => { if (id === reqId.current) setError(errText(e)); })
      .finally(() => { if (id === reqId.current) setLoadingMore(false); });
    // `ghRef` 在父组件里是 `useMemo(..., [currentEntry?.remote])` ⇒ 轮询不改变它;
    // `stateFilter` / `sort` 是本地 state。三个都稳定,所以 `load` 也稳定。
  }, [ghRef, stateFilter, sort]);

  useEffect(() => {
    setList(null); setDetail(null); setNextUrl(null);
    load(false);
    // 依赖 `load` 即可:它的依赖恰好就是「仓库 / 筛选 / 排序」这三件事,
    // 所以触发面与原来的显式列表逐字等价(见上面的 ref 说明)。
  }, [load]);

  const reload = useCallback(() => load(true), [load]);

  return (
    <div className="gw-colpane" style={{ flex: 1, minHeight: 0, display: 'flex' }}>
      <div className="gw-toolbar">
        <span className="gw-open-count">{list
          ? `${list.length}${total != null ? ` / ${total}` : ''} ${stateFilter === 'open' ? 'open' : 'closed'}`
          : '…'}</span>
        <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <select className="gw-select" style={{ marginLeft: 0, maxWidth: 118 }}
            value={sort} onChange={(e) => setSort(e.target.value as api.ListSort)} title="排序">
            <option value="created">最新创建</option>
            <option value="updated">最近更新</option>
          </select>
          <button className={`gw-btn ${stateFilter === 'open' ? 'primary' : ''}`}
            onClick={() => setStateFilter('open')}>开放</button>
          <button className={`gw-btn ${stateFilter === 'closed' ? 'primary' : ''}`}
            onClick={() => setStateFilter('closed')}>已关闭</button>
          <button className="gw-btn primary" onClick={() => setShowNew(true)}>
            <GwIcon name="plus" size={12} />新建 Issue
          </button>
        </span>
      </div>
      <div className="gw-list">
        {error && <ErrorBox msg={error} onRetry={() => reload()} />}
        {!error && !list && <Loading />}
        {list?.length === 0 && <Empty>{stateFilter === 'open'
          ? <>没有打开的 Issue。<br />用上方按钮创建第一个。</>
          : '没有已关闭的 Issue。'}</Empty>}
        {list?.map((it) => (
          <button key={it.number} className="gw-row" onClick={() => setDetail(it.number)}>
            <span className="gw-stateic"
              style={{ color: it.state === 'closed' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-success-primary)' }}>
              <GwIcon name={it.state === 'closed' ? 'x-circle' : 'issue'} />
            </span>
            <span className="gw-rowmain">
              <span className="gw-rowtitle">{it.title}</span>
              <span className="gw-rowsub">
                #{it.number} · {timeAgo(it.updated_at)} 更新 · {it.user?.login ?? 'ghost'}
                {it.comments > 0 && <> · <GwIcon name="comment" size={10} /> {it.comments}</>}
                {it.labels.map((l) => (
                  <span key={l.name} className="gw-label-chip"
                    style={{ background: `#${l.color.replace('#', '')}`, color: labelTextColor(l.color), marginLeft: 4 }}>
                    {l.name}
                  </span>
                ))}
              </span>
            </span>
            <span className="gw-meta">更新<br />{timeAgo(it.updated_at)}</span>
          </button>
        ))}
        {nextUrl && (
          <div className="gw-more">
            <button className="gw-btn" disabled={loadingMore} onClick={() => load(true, nextUrl)}>
              {loadingMore ? '加载中…' : '加载更多'}
            </button>
          </div>
        )}
        {!nextUrl && total != null && (list?.length ?? 0) >= 1000 && total > 1000 && (
          <div className="gw-muted" style={{ textAlign: 'center', padding: '8px 12px 14px' }}>
            Search 最多展示 1000 条，其余请上 GitHub 网页
          </div>
        )}
      </div>

      {showNew && (
        <NewIssueDrawer ghRef={ghRef}
          onClose={() => setShowNew(false)}
          onCreated={(n) => { setShowNew(false); reload(); setDetail(n); }} />
      )}
      {detail !== null && (
        <IssueDrawer key={detail} ghRef={ghRef} number={detail}
          onClose={() => setDetail(null)}
          onChanged={() => { reload(); }} />
      )}
    </div>
  );
}

// ---------- 新建 Issue ----------

function NewIssueDrawer(props: { ghRef: GhRef; onClose: () => void; onCreated: (n: number) => void }): ReactNode {
  const ui = useUI();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="gw-detail">
      <div className="gw-detail-head">
        <button className="backbtn gw-btn" onClick={props.onClose}><GwIcon name="chevron-left" size={12} />返回列表</button>
        <div style={{ fontWeight: 600, marginTop: 6 }}>新建 Issue</div>
      </div>
      <div className="gw-detail-body" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <input className="gw-input" placeholder="标题(必填)" value={title}
          onChange={(e) => setTitle(e.target.value)} autoFocus />
        <textarea className="gw-input gw-textarea" rows={7} placeholder="正文(Markdown)"
          value={body} onChange={(e) => setBody(e.target.value)} />
        {error && <div className="gw-errbox">{error}</div>}
      </div>
      <div className="gw-composer">
        <div className="gw-composer-row" style={{ justifyContent: 'flex-end' }}>
          <button className="gw-btn" onClick={props.onClose}>取消</button>
          <button className="gw-btn primary" disabled={!title.trim() || busy}
            onClick={() => {
              setBusy(true); setError(null);
              api.createIssue(props.ghRef, title.trim(), body)
                .then((it) => { ui.toast(`Issue #${it.number} 已创建`);
                  props.onCreated(it.number); })
                .catch((e) => { setError(errText(e)); })
                .finally(() => setBusy(false));
            }}>{busy ? '创建中…' : '创建'}</button>
        </div>
      </div>
    </div>
  );
}

// ---------- 详情抽屉 ----------

function IssueDrawer(props: { ghRef: GhRef; number: number; onClose: () => void; onChanged: () => void }): ReactNode {
  const ui = useUI();
  const [issue, setIssue] = useState<api.GhIssue | null>(null);
  const [comments, setComments] = useState<api.GhComment[]>([]);
  const [commentsNext, setCommentsNext] = useState<string | null>(null);
  const [loadingMoreComments, setLoadingMoreComments] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [eTitle, setETitle] = useState('');
  const [eBody, setEBody] = useState('');

  const loadAll = useCallback(() => {
    setError(null);
    Promise.all([api.getIssue(props.ghRef, props.number), api.listComments(props.ghRef, props.number)])
      .then(([i, c]) => {
        setIssue(i); setComments(c.items); setCommentsNext(c.nextUrl);
        setETitle(i.title); setEBody(i.body ?? '');
      })
      .catch((e) => setError(errText(e)));
  }, [props.ghRef.owner, props.ghRef.repo, props.number]);

  useEffect(() => { loadAll(); }, [loadAll]);

  const closed = issue?.state === 'closed';

  async function toggleState(): Promise<void> {
    if (!issue) return;
    const toClosed = !closed;
    if (toClosed && !(await ui.confirm({
      title: `关闭 Issue #${issue.number}?`,
      body: issue.title,
      confirmText: '关闭', danger: true,
    }))) return;
    try {
      await api.patchIssue(props.ghRef, issue.number, { state: toClosed ? 'closed' : 'open' });
      ui.toast(toClosed ? `Issue #${issue.number} 已关闭` : `Issue #${issue.number} 已重新打开`);
      loadAll(); props.onChanged();
    } catch (e) { ui.toast(errText(e), 'err'); }
  }

  async function saveEdit(): Promise<void> {
    if (!issue) return;
    try {
      await api.patchIssue(props.ghRef, issue.number, { title: eTitle.trim(), body: eBody });
      ui.toast('已保存'); setEditing(false); loadAll(); props.onChanged();
    } catch (e) { ui.toast(errText(e), 'err'); }
  }

  return (
    <div className="pane-wrap gw-pane-wrap" style={{ position: 'absolute', inset: 0, zIndex: 30, display: 'flex' }}>
      <div className="gw-detail" style={{ position: 'static', flex: 1 }}>
        <div className="gw-detail-head">
          <button className="gw-btn backbtn" onClick={props.onClose}>
            <GwIcon name="chevron-left" size={12} />返回列表
          </button>
          {issue ? (
            <>
              <div style={{ fontWeight: 600, marginTop: 6, fontSize: 13 }}>
                <StateIcon closed={issue.state === 'closed'} />{issue.title} <span className="gw-muted">#{issue.number}</span>
              </div>
              <div className="gw-rowsub" style={{ marginTop: 3 }}>
                {issue.user?.login ?? 'ghost'} 创建于 {timeAgo(issue.created_at)} · {issue.state === 'closed' ? '已关闭' : '开放'}
                <a className="gw-link" href={issue.html_url} target="_blank" rel="noreferrer"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                  <GwIcon name="external-link" size={10} />GitHub
                </a>
              </div>
            </>
          ) : <div className="gw-muted" style={{ marginTop: 8 }}>加载中…</div>}
        </div>
        <div className="gw-detail-body">
          {error && <ErrorBox msg={error} onRetry={loadAll} />}
          {!error && !issue && <Loading />}
          {issue && (editing ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <input className="gw-input" value={eTitle} onChange={(e) => setETitle(e.target.value)} />
              <textarea className="gw-input gw-textarea" rows={8} value={eBody}
                onChange={(e) => setEBody(e.target.value)} />
              <div className="gw-composer-row">
                <button className="gw-btn primary" onClick={saveEdit}>保存修改</button>
                <button className="gw-btn" onClick={() => {
                  setEditing(false); setETitle(issue.title); setEBody(issue.body ?? '');
                }}>取消</button>
              </div>
            </div>
          ) : (
            <>
              {issue.body || '(无正文)'}
              {issue.labels.length > 0 && (
                <div style={{ marginTop: 10 }}>
                  {issue.labels.map((l) => (
                    <span key={l.name} className="gw-label-chip"
                      style={{ background: `#${l.color.replace('#', '')}`, color: labelTextColor(l.color) }}>
                      {l.name}
                    </span>
                  ))}
                </div>
              )}
              <CommentsBlock ghRef={props.ghRef} number={props.number}
                comments={comments} onChanged={loadAll}
                nextUrl={commentsNext} loadingMore={loadingMoreComments}
                onLoadMore={() => {
                  if (!commentsNext) return;
                  setLoadingMoreComments(true);
                  api.listComments(props.ghRef, props.number, commentsNext)
                    .then((page) => {
                      setComments((prev) => [...prev, ...page.items]);
                      setCommentsNext(page.nextUrl);
                    })
                    .catch((e) => ui.toast(errText(e), 'err'))
                    .finally(() => setLoadingMoreComments(false));
                }} />
            </>
          ))}
        </div>
        {issue && !editing && (
          <div className="gw-composer">
            <CommentComposer ghRef={props.ghRef} number={props.number} onDone={loadAll} />
            <div className="gw-composer-row">
              <button className={`gw-btn ${closed ? '' : 'danger'}`} onClick={toggleState}>
                {closed ? '重新打开' : '关闭 Issue'}
              </button>
              <button className="gw-btn" onClick={() => setEditing(true)}>
                <GwIcon name="pencil" size={11} />编辑
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function StateIcon(props: { closed: boolean; merged?: boolean }): ReactNode {
  const color = props.merged ? 'var(--dsw-alias-state-business-primary, #a371f7)'
    : props.closed ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-success-primary)';
  return <span className="gw-stateic" style={{ color, display: 'inline-flex', marginRight: 6, verticalAlign: '-2px' }}>
    <GwIcon name={props.merged ? 'merge' : props.closed ? 'x-circle' : 'issue'} size={13} />
  </span>;
}

// 复用类型引用(避免未使用告警的显式引用)
export type { IconName };
