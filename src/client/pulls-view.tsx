/**
 * Pull requests 页签:列表(工具条 + 新建 PR)+ 详情抽屉
 * (diffstat / check-runs 摘要 / 合并三法强确认 / 关闭重开 / 评论区)。
 *
 * ## CI 检查那一半(2026-10 接线)
 *
 * 本文件是 `src/client/check-runs.ts` 那套**判断**的**消费者**。判断(有哪些状态、
 * 结论 ⇒ 图标/颜色/形容词、多条怎么合成、摘要句子、分组)全部来自上游
 * `lib/ci-checks/ci-checks.ts` + `ui/branches/ci-status.tsx` + `ui/check-runs/**`,
 * 逐条抄在那个文件里;**取数与缓存**用我们已有的机制(`gh-api.ts` 经宿主代理 +
 * 一个 60 秒 TTL 的 memo),没有第二个 store、没有第二个传输层。
 *
 * 两处消费者,都是**上游真有的面**(不是我们发明的):
 *  - **列表行**:上游 `ui/branches/pull-request-list-item.tsx:181-190` 在每条 PR
 *    行里画一个 `CIStatus`(ref = `refs/pull/<n>/head`,`models/pull-request.ts:4-6`);
 *  - **详情抽屉**:上游 `ui/check-runs/ci-check-run-popover.tsx` 的头部四态 +
 *    `getCombinedStatusSummary` + 按 workflow 分组的列表(`ci-check-run-list.tsx`)。
 *    我们的抽屉就是这条信息的落点(浮层形态见 `docs/ci-checks-verdict.md` 的裁决)。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { GhIcon as GwIcon } from './icons-gh.ts';
import * as api from './gh-api.ts';
import * as checkRuns from './check-runs.ts';
/*
 * **抄进来的上游 UI**(2026-10-07「抄优先」,逐字镜像,`verify-mirror` 盯着字节一致):
 *  - `CIStatus`:`ui/branches/ci-status.tsx`(早就在树里,来自仓库列表面);
 *  - `CICheckRunPopover`:`ui/check-runs/ci-check-run-popover.tsx`(本轮抄进来的 9 个文件之一);
 *  - `getPullRequestCommitRef`:`models/pull-request.ts:4-6`(上游给 PR 用的 ref 形状);
 *  - 门面 `ciDispatcher` / `githubRepositoryFor`:`./ci-transport.ts`
 *    (它把抄进来的 `CommitStatusStore` 的数据源接到 `gh-api.ts`)。
 *
 * ⚠️ 这两处**真的渲染**(不是抄完躺着):PR 列表行右端一个 `CIStatus` 徽标
 * (上游 `ui/branches/pull-request-list-item.tsx:181-190` 的形状),点它开
 * 上游那个浮层。读数见 `docs/probes/ci-checks-probe.mjs`。
 */
import { CIStatus } from '../core/desktop/ui/branches/ci-status.tsx';
import { CICheckRunPopover } from '../core/desktop/ui/check-runs/ci-check-run-popover.tsx';
import { getPullRequestCommitRef } from '../core/desktop/models/pull-request.ts';
import { ciDispatcher, githubRepositoryFor } from './ci-transport.ts';
import { timeAgo, type GhRef } from '../core/lib.ts';
import { Loading, ErrorBox, Empty } from './ui.tsx';
import { errText, useUI } from './gh.ts';
import { CommentsBlock, CommentComposer } from './comments.tsx';
import { useAutoRefreshSec } from './host-settings.ts';
import { StateIcon, type ListViewProps } from './issues-view.tsx';

type MergeMethod = 'merge' | 'squash' | 'rebase';
const METHOD_LABEL: Record<MergeMethod, string> = {
  merge: 'Merge', squash: 'Squash and merge', rebase: 'Rebase and merge',
};
const FILTER_LABEL: Record<api.PullFilter, string> = {
  open: 'open', closed: 'closed', merged: 'merged',
};

export function PullsView({ ghRef, branches, visible, onCount, initialDetail, onConsumeDeep }: ListViewProps & { branches: api.BranchLite[] }): ReactNode {
  const [list, setList] = useState<api.GhPull[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<number | null>(initialDetail ?? null);
  useEffect(() => { if (initialDetail != null) onConsumeDeep?.(); }, [initialDetail]);
  const [showNew, setShowNew] = useState(false);
  const [stateFilter, setStateFilter] = useState<api.PullFilter>('open');
  const [sort, setSort] = useState<api.ListSort>('created');
  const [nextUrl, setNextUrl] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const reqId = useRef(0);

  /*
   * `onCount` 由父组件以**内联箭头**传入(`workbench.tsx`),而父组件每 5 秒会因
   * store 轮询而重渲染(`store.ts` 的 `emit()` 总是造新 state 对象)。把它留在
   * `load` 的依赖里 ⇒ `load` 每 5 秒换身份 ⇒
   *   1. 下面那个「切仓库/筛选时重置并重拉」的 effect 每 5 秒触发(闪烁 + 重复请求);
   *   2. **自动刷新定时器每 5 秒被 clear 再重建** —— 周期是 30~300 秒量级,
   *      于是它**永远等不到第一次 tick**(「自动刷新」实际上是死的)。
   *      这是本轮发现的一个真 bug,见 `docs/lint-layer.md` §8.5。
   * 用最新值 ref 持有 `onCount`,把 `load` 的身份稳定在「仓库/筛选/排序」上,
   * 两个问题一起消失,抑制也就不需要了。
   */
  const onCountRef = useRef(onCount);
  useEffect(() => {
    onCountRef.current = onCount;
  });

  // 自动刷新周期**来自宿主设置**(设置 ▸ 插件 ▸ dsh-git 的 `autoSec`),
  // 不再读 localStorage 的那个孤儿键:那个键全仓 0 个写点 ⇒ 自动刷新恒关、
  // 用户也改不了(见 docs/plugin-settings.md §6 桶 (i) 与 §7.2)。
  // 单一真源是宿主的配置文档,这里只是它的一份只读投影(`./host-settings.ts`)。
  const autoSec = useAutoRefreshSec();

  /*
   * 「哪个 PR 的 CI 浮层开着 + 锚在哪个元素上」。上游把这两样放在 `Dispatcher` 的
   * `showCIStatusPopover` state 里(`ui/toolbar/branch-dropdown.tsx:443-448`),
   * 我们的机制是就地 useState(单一真源仍只有一份:这个 state)。
   */
  const [ciPopover, setCiPopover] = useState<{ number: number; anchor: HTMLElement } | null>(null)
  const openCiPopover = useCallback((prNumber: number, anchor: HTMLElement) => {
    setCiPopover({ number: prNumber, anchor })
  }, [])
  const closeCiPopover = useCallback(() => {
    setCiPopover(null)
  }, [])

  const load = useCallback((silent: boolean, pageUrl?: string) => {
    const id = pageUrl ? reqId.current : ++reqId.current;
    if (pageUrl) setLoadingMore(true);
    else if (!silent) setList(null);
    setError(null);
    api.listPulls(ghRef, stateFilter, sort, pageUrl)
      .then((page) => {
        if (id !== reqId.current) return;
        setList((prev) => (pageUrl && prev ? [...prev, ...page.items] : page.items));
        setNextUrl(page.nextUrl);
        setTotal(page.totalCount);
        if (stateFilter === 'open' && page.totalCount != null) onCountRef.current(page.totalCount);
      })
      .catch((e) => { if (id === reqId.current) setError(errText(e)); })
      .finally(() => { if (id === reqId.current) setLoadingMore(false); });
    // `ghRef` 在父组件里是 `useMemo(..., [currentEntry?.remote])` ⇒ 轮询不改变它。
  }, [ghRef, stateFilter, sort]);

  useEffect(() => {
    setList(null); setDetail(null); setNextUrl(null);
    load(false);
    // 依赖 `load`:它的依赖恰好是「仓库 / 筛选 / 排序」,与原来的显式列表等价。
  }, [load]);

  // 自动刷新(visible 门控,静默不闪;周期来自宿主设置)
  useEffect(() => {
    if (!visible || autoSec <= 0) return;
    const t = setInterval(() => load(true), autoSec * 1000);
    return () => clearInterval(t);
    // `load` 只在仓库/筛选/排序变化时换身份 ⇒ 定时器不再被每次渲染重置;
    // `autoSec` 变化(用户在宿主设置里改了周期)会按新周期重建定时器。
  }, [visible, load, autoSec]);

  return (
    <div className="gw-colpane" style={{ flex: 1, minHeight: 0, display: 'flex' }}>
      <div className="gw-toolbar">
        <span className="gw-open-count">{list
          ? `${list.length}${total != null ? ` / ${total}` : ''} ${FILTER_LABEL[stateFilter]}`
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
          <button className={`gw-btn ${stateFilter === 'merged' ? 'primary' : ''}`}
            onClick={() => setStateFilter('merged')}>已合并</button>
          <button className="gw-btn primary" onClick={() => setShowNew(true)}>
            <GwIcon name="plus" size={12} />新建 PR
          </button>
        </span>
      </div>
      <div className="gw-list">
        {error && <ErrorBox msg={error} onRetry={() => load(true)} />}
        {!error && !list && <Loading />}
        {list?.length === 0 && <Empty>{stateFilter === 'open'
          ? '没有打开的 Pull Request。'
          : stateFilter === 'merged' ? '没有已合并的 Pull Request。' : '没有已关闭(未合并)的 Pull Request。'}</Empty>}
        {list?.map((pr) => (
          <button key={pr.number} className="gw-row" onClick={() => setDetail(pr.number)}>
            <span className="gw-stateic"
              style={{ color: stateFilter === 'merged' || (pr.merged_at && pr.state === 'closed')
                ? 'var(--dsw-alias-state-business-primary, #a371f7)'
                : pr.state === 'closed'
                ? 'var(--dsw-alias-state-error-primary)'
                : pr.draft ? 'var(--dsw-alias-label-tertiary)'
                : 'var(--dsw-alias-state-success-primary)' }}>
              <GwIcon name={stateFilter === 'merged' || pr.merged_at ? 'merge' : pr.state === 'closed' ? 'x-circle' : 'pr'} />
            </span>
            <span className="gw-rowmain">
              <span className="gw-rowtitle">
                {pr.title}{pr.draft && <span className="gw-chip" style={{ marginLeft: 6 }}>draft</span>}
              </span>
              <span className="gw-rowsub">
                #{pr.number}
                {pr.head.ref && <> · <span className="gw-branch-chip">{pr.head.ref} → {pr.base.ref}</span></>}
                 · {timeAgo(pr.updated_at)}
              </span>
            </span>
            <CiBadge ghRef={ghRef} number={pr.number} onOpen={openCiPopover} />
            <span className="gw-meta">更新<br />{timeAgo(pr.updated_at)}</span>
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
        <NewPRDrawer ghRef={ghRef} branches={branches}
          onClose={() => setShowNew(false)}
          onCreated={(n) => { setShowNew(false); load(true); setDetail(n); }} />
      )}
      {detail !== null && (
        <PullDrawer key={detail} ghRef={ghRef} number={detail}
          onClose={() => setDetail(null)} onChanged={() => load(true)} />
      )}
      {/*
        上游的 CI 浮层 —— **逐字抄进来的那个组件**。锚点是我们自己的
        `<span>`(上游锚在 `pr-badge` 上,`ui/toolbar/branch-dropdown.tsx:488`)。
        `branchName` 给空串:Search 版列表拿不到 head.ref(`gh-api.ts:342`),
        而 dotcom 路径上它本来就不被读(`ci-checks.ts:429-472` 只看 `check_suite.id`)。
      */}
      {ciPopover !== null && (
        <CICheckRunPopover
          dispatcher={ciDispatcher}
          repository={githubRepositoryFor(ghRef)}
          branchName=""
          prNumber={ciPopover.number}
          anchor={ciPopover.anchor}
          closePopover={closeCiPopover}
        />
      )}
    </div>
  );
}

// ---------- 新建 PR ----------

function NewPRDrawer(props: {
  ghRef: GhRef; branches: api.BranchLite[];
  onClose: () => void; onCreated: (n: number) => void;
}): ReactNode {
  const ui = useUI();
  const defBase = props.branches[0]?.name ?? '';
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [head, setHead] = useState('');
  const [base, setBase] = useState(defBase);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 30, display: 'flex' }}>
      <div className="gw-detail" style={{ position: 'static', flex: 1 }}>
        <div className="gw-detail-head">
          <button className="gw-btn backbtn" onClick={props.onClose}><GwIcon name="chevron-left" size={12} />返回列表</button>
          <div style={{ fontWeight: 600, marginTop: 6 }}>新建 Pull Request</div>
        </div>
        <div className="gw-detail-body" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className="gw-formrow">
            <div className="gw-field" style={{ flex: 1 }}>
              <label>head(源分支)</label>
              <input className="gw-input" placeholder="feature/xxx" value={head} list="gw-branches"
                onChange={(e) => setHead(e.target.value)} autoFocus />
              <datalist id="gw-branches">
                {props.branches.map((b) => <option key={b.name} value={b.name} />)}
              </datalist>
            </div>
            <div className="gw-field" style={{ width: 140 }}>
              <label>base(目标分支)</label>
              <select className="gw-input" value={base} onChange={(e) => setBase(e.target.value)}
                style={{ appearance: 'auto', backgroundImage: 'none', paddingRight: 8 }}>
                {props.branches.map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
              </select>
            </div>
          </div>
          <input className="gw-input" placeholder="标题(必填)" value={title}
            onChange={(e) => setTitle(e.target.value)} />
          <textarea className="gw-input gw-textarea" rows={6} placeholder="描述(Markdown)"
            value={body} onChange={(e) => setBody(e.target.value)} />
          {error && <div className="gw-errbox">{error}</div>}
        </div>
        <div className="gw-composer">
          <div className="gw-composer-row" style={{ justifyContent: 'flex-end' }}>
            <button className="gw-btn" onClick={props.onClose}>取消</button>
            <button className="gw-btn primary" disabled={!title.trim() || !head.trim() || !base || busy}
              onClick={() => {
                setBusy(true); setError(null);
                api.createPull(props.ghRef, { title: title.trim(), body, head: head.trim(), base })
                  .then((pr) => { ui.toast(`PR #${pr.number} 已创建`);
                  props.onCreated(pr.number); })
                  .catch((e) => setError(errText(e)))
                  .finally(() => setBusy(false));
              }}>{busy ? '创建中…' : '创建 PR'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- 详情抽屉 ----------

function PullDrawer(props: { ghRef: GhRef; number: number; onClose: () => void; onChanged: () => void }): ReactNode {
  const ui = useUI();
  const [pull, setPull] = useState<api.GhPull | null>(null);
  const [comments, setComments] = useState<api.GhComment[]>([]);
  const [commentsNext, setCommentsNext] = useState<string | null>(null);
  const [loadingMoreComments, setLoadingMoreComments] = useState(false);
  const [checks, setChecks] = useState<checkRuns.IRefChecksResult | null>(null);
  /*
   * 「重试」= 自增这个计数 ⇒ effect 重跑一次并带 `force`(跳过 60 秒 TTL)。
   * 用计数而不是布尔,是为了让**连点两次**也各发一次(布尔会吃掉第二次)。
   */
  const [checksAttempt, setChecksAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [method, setMethod] = useState<MergeMethod>('squash');
  const [busy, setBusy] = useState(false);

  const loadAll = useCallback(() => {
    setError(null);
    Promise.all([
      api.getPull(props.ghRef, props.number),
      api.listComments(props.ghRef, props.number),
    ])
      .then(([p, c]) => { setPull(p); setComments(c.items); setCommentsNext(c.nextUrl); })
      .catch((e) => setError(errText(e)));
  }, [props.ghRef.owner, props.ghRef.repo, props.number]);

  useEffect(() => { loadAll(); }, [loadAll]);

  /*
   * check 状态:走 `check-runs.ts` 的 `loadRefChecks`(60 秒 TTL + 并发去重 +
   * 每 key 序号守卫)。ref 用 PR 的 head sha —— 与上游对 PR 的 ref
   * (`refs/pull/<n>/head`,`models/pull-request.ts:4-6`)指向同一个提交,
   * 而我们的 `getPull` 已经带了 sha ⇒ **不额外取一次**。
   *
   * `live` 是卸载护栏:抽屉在请求在飞时被关掉/换 key,不许再 setState。
   */
  useEffect(() => {
    const sha = pull?.head.sha ?? '';
    if (sha === '') {
      return;
    }
    let live = true;
    setChecks(null);
    checkRuns
      .loadRefChecks(props.ghRef, sha, checksAttempt > 0)
      .then((result) => {
        if (live) {
          setChecks(result);
        }
      })
      .catch((reason: unknown) => {
        if (live) {
          setChecks({ check: null, error: errText(reason), fromCache: false });
        }
      });
    return () => {
      live = false;
    };
  }, [pull?.head.sha, props.ghRef.owner, props.ghRef.repo, checksAttempt]);

  const retryChecks = useCallback(() => {
    setChecksAttempt((n) => n + 1);
  }, []);

  if (error) {
    return (
      <div style={{ position: 'absolute', inset: 0, zIndex: 30, display: 'flex' }}>
        <div className="gw-detail" style={{ position: 'static', flex: 1 }}>
          <div className="gw-detail-head">
            <button className="gw-btn backbtn" onClick={props.onClose}>
              <GwIcon name="chevron-left" size={12} />返回列表
            </button>
          </div>
          <ErrorBox msg={error} onRetry={loadAll} />
        </div>
      </div>
    );
  }
  if (!pull) return <Loading />;

  const closed = pull.state === 'closed';
  const merged = Boolean(pull.merged_at);
  /*
   * CI 检查的**判断**全部来自 `check-runs.ts`(上游的判断表)。
   * ⚠️ 这里原来是三个**就地硬编码**的计数器(只认 `success` 与「非 success」),
   * 与上游不一致:上游把 `neutral`/`skipped` 算**成功**
   * (`ci-checks.ts:267-278`)、把 `cancelled`/`stale` 算**未完成**
   * (`:240-251`)而不是失败,总状态则用「有未完成或失败 ⇒ Failure」(`:190-222`)。
   * 现在 `if` 一个都没有了 —— 判断只有一份,在 check-runs.ts 里。
   */
  const combined = checks === null ? null : checks.check;
  const checkList: ReadonlyArray<checkRuns.IRefCheck> = combined === null ? [] : combined.checks;
  const headerFlags = checkRuns.getCheckHeaderFlags(checkList, checks === null);
  const headerState = checkRuns.getCheckTitleState(headerFlags);
  const checkSummary = checkRuns.getCombinedStatusSummary(checkList);
  const checkGroups = combined === null ? null : checkRuns.getCheckRunGroups(checkList);
  const checkGroupNames = checkGroups === null ? [] : checkRuns.getCheckRunGroupNames(checkGroups);
  const checkError = checks === null ? null : checks.error;
  const canMerge = !closed && !pull.draft;

  async function doMerge(): Promise<void> {
    if (!pull) return;
    if (!(await ui.confirm({
      title: `以 ${METHOD_LABEL[method]} 合并 #${pull.number}?`,
      body: `${pull.head.ref} → ${pull.base.ref}\n将按 GitHub 的该方式产生提交,合并后通常自动删除源分支。`,
      confirmText: METHOD_LABEL[method], danger: true,
    }))) return;
    setBusy(true);
    try {
      await api.mergePull(props.ghRef, pull.number, method);
      ui.toast(`PR #${pull.number} 已合并(${METHOD_LABEL[method]})`);
      props.onChanged(); loadAll();
    } catch (e) { ui.toast(errText(e), 'err'); }
    finally { setBusy(false); }
  }

  async function toggleState(): Promise<void> {
    if (!pull) return;
    const toClosed = !closed;
    if (toClosed && !(await ui.confirm({
      title: `关闭 PR #${pull.number}?`, body: pull.title, confirmText: '关闭', danger: true,
    }))) return;
    try {
      await api.patchIssue(props.ghRef, pull.number, { state: toClosed ? 'closed' : 'open' });
      ui.toast(toClosed ? `PR #${pull.number} 已关闭` : `PR #${pull.number} 已重新打开`);
      props.onChanged(); loadAll();
    } catch (e) { ui.toast(errText(e), 'err'); }
  }

  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 30, display: 'flex' }}>
      <div className="gw-detail" style={{ position: 'static', flex: 1 }}>
        <div className="gw-detail-head">
          <button className="gw-btn backbtn" onClick={props.onClose}>
            <GwIcon name="chevron-left" size={12} />返回列表
          </button>
          <div style={{ fontWeight: 600, marginTop: 6, fontSize: 13 }}>
            <StateIcon closed={closed} merged={merged} />{pull.title} <span className="gw-muted">#{pull.number}</span>
          </div>
          <div className="gw-rowsub" style={{ marginTop: 3, flexWrap: 'wrap' }}>
            <span className="gw-branch-chip">{pull.head.label} → {pull.base.label}</span>
            {(pull.additions !== undefined) && (
              <span><span className="gw-diffstat-add">+{pull.additions}</span> <span className="gw-diffstat-del">−{pull.deletions}</span>
                {pull.changed_files !== undefined ? ` · ${pull.changed_files} files` : ''}</span>
            )}
            · {timeAgo(pull.created_at)} 创建
            {combined !== null && (
              <span className="gw-ci-rollup" data-gw-ci-state={headerState}>
                <CheckDot conclusion={combined.conclusion} description={checkRuns.getCompletenessAriaLabel(checkList)} size={12} />
                <span className="gw-ci-title" data-gw-ci-title={headerState}>
                  {checkRuns.getCheckTitle(headerState)}
                </span>
                {checkSummary !== '' && <span className="gw-muted gw-ci-summary">{checkSummary}</span>}
              </span>
            )}
            {checkError !== null && (
              <span className="gw-ci-error" style={{ color: 'var(--dsw-alias-state-error-primary)' }}>
                检查状态取不到:{checkError}
                <button className="gw-btn" onClick={retryChecks}>重试</button>
              </span>
            )}
            <a className="gw-link" href={pull.html_url} target="_blank" rel="noreferrer"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              <GwIcon name="external-link" size={10} />GitHub
            </a>
          </div>

          {/* 合并控制条 */}
          {canMerge && (
            <div className="gw-composer-row" style={{ marginTop: 8 }}>
              <select className="gw-select" style={{ marginLeft: 0, maxWidth: 190 }}
                value={method} onChange={(e) => setMethod(e.target.value as MergeMethod)}>
                <option value="merge">Create a merge commit</option>
                <option value="squash">Squash and merge</option>
                <option value="rebase">Rebase and merge</option>
              </select>
              <button className="gw-btn primary" disabled={busy || pull.mergeable === false}
                onClick={doMerge}>
                <GwIcon name="merge" size={12} />{METHOD_LABEL[method]}
              </button>
              {pull.mergeable === false && (
                <span className="gw-muted" style={{ fontSize: 10 }}>存在冲突,无法合并</span>
              )}
            </div>
          )}

          {/*
            checks 明细:按上游的**组**渲染(`ci-checks.ts:598-669` 的分组 + 组名排序,
            `Other` 永远最后;`GitHub Code Scanning` 那一组叫 `Code scanning results`)。
            两条消费侧的判断也照抄上游 `ui/check-runs/ci-check-run-list.tsx:185-206`:
              · **只有一组且它就是 `Other`** ⇒ **不画组头**(直接列条目);
              · 否则按 `getCheckRunGroupNames()` 的**排序**逐个画组头(不是 Map 的插入序 ——
                `Map.set` 对已有键不改变顺序,所以直接用 `entries()` 会得到插入序)。
            ⚠️ 我们**不**为每个 check suite 再取一次 workflow 名(那是每个 suite 一次请求),
            所以除 Code scanning 外都落在上游自己的兜底组 `Other` 里 —— 见
            `docs/ci-checks-verdict.md` 的「不加取」一节。
          */}
          {checkGroups !== null && checkList.length > 0 && (
            <div className="gw-ci-groups" style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 3 }}>
              {checkGroupNames.length === 1 && checkGroupNames[0] === 'Other'
                ? <CheckRows checks={checkGroups.get('Other') ?? []} fallbackHref={pull.html_url} />
                : checkGroupNames.map((group) => (
                  <div key={group} className="gw-ci-group" data-gw-ci-group={group}>
                    <div className="gw-rowsub gw-ci-group-name" style={{ fontWeight: 600, opacity: 0.75 }}>
                      {group}
                    </div>
                    <CheckRows checks={checkGroups.get(group) ?? []} fallbackHref={pull.html_url} />
                  </div>
                ))}
            </div>
          )}
        </div>

        <div className="gw-detail-body">
          {pull.body || '(无描述)'}
          <CommentsBlock ghRef={props.ghRef} number={props.number} comments={comments} onChanged={loadAll}
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
        </div>

        <div className="gw-composer">
          <CommentComposer ghRef={props.ghRef} number={props.number} onDone={loadAll} />
          <div className="gw-composer-row">
            <button className={`gw-btn ${closed ? '' : 'danger'}`} onClick={toggleState}>
              {closed ? '重新打开' : '关闭 PR'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * 一条 check 的**状态图标**(总状态、列表行、逐条 check 三处共用同一个)。
 *
 * ⚠️ **2026-10 改过形状,不是搬了个家**:原来这里是就地三档硬编码的圆点
 * (`success` ⇒ 绿 / 「非 success 且非 skipped/neutral」⇒ 红 / 其余 ⇒ 黄),与上游
 * `ui/branches/ci-status.tsx:124-169` 的判断**不一致**:上游
 * `cancelled`/`stale`/`skipped`/`neutral` 四档是 **gray**、`pending` 才是黄。
 * 现在符号与颜色都走 `check-runs.ts` 的 `getCheckAppearance`(上游那张表),
 * props 也从「原始 `GhCheckRun`」换成判断层的字段 —— 于是三个现场共用一份判断。
 */
function CheckDot(props: {
  readonly conclusion: checkRuns.CheckConclusion | null;
  readonly description: string;
  readonly size?: number;
}): ReactNode {
  const appearance = checkRuns.getCheckAppearance(props.conclusion);
  return (
    <GwIcon
      name={appearance.icon}
      size={props.size ?? 13}
      className={`gw-ci-icon ${appearance.className}`}
      title={props.description}
      style={{ color: checkRuns.CHECK_TONE_COLOR[appearance.tone], flexShrink: 0 }}
    />
  );
}

/**
 * 一组 check 的条目(上游 `ui/check-runs/ci-check-run-list.tsx:190` 的
 * `renderListItems` 那一层):图标 + 名字 + 描述(形容词+时长)+ 外链。
 */
function CheckRows(props: {
  readonly checks: ReadonlyArray<checkRuns.IRefCheck>;
  readonly fallbackHref: string;
}): ReactNode {
  return (
    <>
      {props.checks.map((one) => (
        <a key={one.id} className="gw-rowsub gw-link gw-ci-row" href={one.htmlUrl ?? props.fallbackHref} target="_blank" rel="noreferrer"
          style={{ textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 4 }}>
          <CheckDot conclusion={one.conclusion} description={one.description} />
          <span className="gw-ci-name">{one.name === '' ? '(未命名检查)' : one.name}</span>
          <span className="gw-muted gw-ci-desc">{one.description}</span>
        </a>
      ))}
    </>
  );
}

/**
 * 列表行右侧的 **CI 徽标** —— **上游 `CIStatus` 本体**
 * (`ui/branches/ci-status.tsx`,早就在树里的逐字镜像),位置照
 * `ui/branches/pull-request-list-item.tsx:181-190`(一行一个、`ci-status-container`)。
 *
 * ## 数据从哪来(这一条是本轮「抄优先」的关键)
 *
 * `CIStatus` 只做两件事:`dispatcher.tryGetCommitStatus(repository, ref)` 同步读缓存
 * + `dispatcher.subscribeToCommitStatus(...)` 订阅。**两个方法都由抄进来的
 * `lib/stores/commit-status-store.ts` 实现**,数据源是 `./ci-transport.ts` 注入的
 * `gh-api.ts`(`/commits/{ref}/check-runs` + `/commits/{ref}/status`,ref 就是上游那一份
 * `refs/pull/<n>/head`)。⇒ 我们**没有**再写一遍聚合。
 *
 * ## 点击
 *
 * 点徽标 ⇒ 开上游的 `CICheckRunPopover`(见 `PullsView` 里的 `ciPopover` state)。
 * ⚠️ `stopPropagation`:徽标在列表行的 `<button>` **里面**,不拦住会同时打开抽屉。
 */
function CiBadge(props: {
  readonly ghRef: GhRef
  readonly number: number
  readonly onOpen: (prNumber: number, anchor: HTMLElement) => void
}): ReactNode {
  /* ⚠️ 解构出来必须改名:`.eslintrc.yml` 的 `naming-convention` 把 `number` 列为**禁用的名字**
     (`variableLike` 的 custom regex),解构成 `const { number }` 就是一条新违规。 */
  const { ghRef, onOpen } = props
  const prNumber = props.number
  const containerRef = useRef<HTMLSpanElement | null>(null)
  const repository = githubRepositoryFor(ghRef)
  const commitRef = getPullRequestCommitRef(prNumber)
  /*
   * 上游 `ci-status.tsx` 只输出 **`ci-status-<结论>` 类名**,颜色由
   * `styles/ui/_ci-status.scss` 的规则给 —— 而那 4 条颜色规则**不在我们的产物里**
   * (实测 `grep -c ci-status-failure src/client/desktop-diff-styles.generated.ts` = 0;
   * 我们没开那个移植面,理由见 `docs/ci-checks-verdict.md` §3)。
   * 于是这里用**我们已经有的**判断表(`check-runs.ts` 的 `CHECK_TONE_COLOR`)把颜色
   * 补在**外层**(Octicon 的 `fill: currentColor` 会继承)⇒ 上游组件一个字不改,
   * 主题令牌单一真源仍在 `check-runs.ts` 里。
   *
   * 顺带这就是本组件自己的订阅:它同时给浮层用的 store **预热**缓存
   * (同一 key 的并发订阅在 store 里只发一次请求,`commit-status-store.ts:468-483`)。
   */
  /*
   * 类型是**上游**那个 `ICombinedRefCheck`(抄进来的 `lib/ci-checks/ci-checks.ts`),
   * 与我们 `check-runs.ts` 的同名接口**值相同、类型不同**(枚举 vs 字符串联合)——
   * 两者之间只有 `checkRuns.asConclusion()` 这一个显式收窄点。
   */
  const [combined, setCombined] = useState(
    () => ciDispatcher.tryGetCommitStatus(repository, commitRef),
  )
  useEffect(() => {
    const subscription = ciDispatcher.subscribeToCommitStatus(repository, commitRef, (next) => {
      setCombined(next)
    })
    return () => {
      subscription.dispose()
    }
  }, [repository, commitRef])
  const tone = checkRuns.getCheckAppearance(
    checkRuns.asConclusion(combined === null || combined.conclusion === null ? null : String(combined.conclusion)),
  ).tone
  const onActivate = useCallback(() => {
    const anchor = containerRef.current
    if (anchor !== null) {
      onOpen(prNumber, anchor)
    }
  }, [prNumber, onOpen])
  const onClick = useCallback(
    (event: { stopPropagation(): void }) => {
      event.stopPropagation()
      onActivate()
    },
    [onActivate],
  )
  const onKeyDown = useCallback(
    (event: { key: string; stopPropagation(): void }) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.stopPropagation()
        onActivate()
      }
    },
    [onActivate],
  )
  return (
    <span
      ref={containerRef}
      className="ci-status-container gw-ci-badge"
      data-gw-ci-status={prNumber}
      data-gw-ci-tone={tone}
      style={{ color: checkRuns.CHECK_TONE_COLOR[tone] }}
    >
      {/*
        ⚠️ **不能**在这里放 `<button>`:整个列表行已经是一个 `<button>`
        (`PullsView` 的行渲染),嵌套 button 是非法 HTML(React 会警告
        `validateDOMNesting`,真浏览器里交互语义也是坏的)。
        所以徽标自己是一个 `role="button"` 的 span(上游那边行是 `<div>`,
        所以 `ui/branches/pull-request-list-item.tsx:181` 可以直接用组件)。
      */}
      <span
        className="gw-ci-badge-btn"
        role="button"
        tabIndex={0}
        aria-haspopup={true}
        onClick={onClick}
        onKeyDown={onKeyDown}
      >
        <CIStatus dispatcher={ciDispatcher} repository={repository} commitRef={commitRef} />
      </span>
    </span>
  )
}

