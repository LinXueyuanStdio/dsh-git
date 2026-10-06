/**
 * 「Clone a repository」弹窗。
 *
 * 结构与字段顺序**沿用 GitHub Desktop**：
 *   - `ui/clone-repository/clone-repository.tsx:263-335`：标题、TabBar
 *     (GitHub.com / GitHub Enterprise / URL)、错误区、tabpanel、footer；
 *     禁用规则 `checkIfCloningDisabled` = url 空 / path 空 / loading / 有错误。
 *   - `ui/clone-repository/clone-generic-repository.tsx:35-64`：URL tab 的两个字段
 *     (「Repository URL or GitHub username and repository (hubot/cool-repo)」+
 *     「Local Path」+「Choose…」按钮)、`autoFocus` 在 URL 上。
 *   - `ui/clone-repository/clone-github-repository.tsx`：GitHub tab = 可过滤的仓库列表。
 *
 * 与 Desktop 的差异:不做 GitHub Enterprise(我们的令牌模型只认 github.com),
 * 因此 TabBar 只有 GitHub / URL 两项。
 * @module dsh-git/client/clone-dialog
 */

import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Icon } from './icons.ts';
import { api } from './api.ts';
import type { RemoteRepo } from './api.ts';
import type { GitStore } from './store.ts';
import { PluginDialog } from './host-modal.tsx';
import { parseRepositoryIdentifier, sanitizeCloneName } from '../core/desktop/lib/remote-parsing.ts';

/** 克隆来源页签（Desktop 的 CloneRepositoryTab 子集）。 */
type CloneTab = 'github' | 'url';

export function CloneDialog(props: { store: GitStore; onClose: () => void }): ReactNode {
  const { store } = props;
  const [tab, setTab] = useState<CloneTab>('url');
  const [url, setUrl] = useState('');
  const [path, setPath] = useState('');
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /*
   * ==========================================================================
   * 「点外面关闭」/ Esc / 焦点 trap / 焦点归还 —— **全部搬进了共享外壳**
   * ==========================================================================
   *
   * 2026-10:这段行为(逐条沿用上游 `references/desktop/app/src/ui/dialog/dialog.tsx` 的
   * mousedown/mouseup 语义)以前就写在本文件里,现在由
   * `./host-modal.tsx` 的 `PluginDialog` + `usePluginDialog` 提供 —— 因为
   * **Preferences 弹窗要的是同一份行为**,两处各写一遍必然漂移(而它 2026-10 刚修过
   * 一次:ref 曾经挂在**遮罩**上,而遮罩**包含**卡片 ⇒ 点遮罩恒判「在里面」⇒
   * 永不关闭,用户报过这个现象)。
   *
   * 搬走之后本文件**一点行为都没丢**,而且多拿到两条(改前明确记为未修的缺口):
   *   · **焦点 trap**:Tab / Shift+Tab 在卡片里首尾环绕,不再跑到弹窗背后的界面;
   *   · **焦点归还**:关闭时把焦点还给**打开它的那个控件**。
   * 上游是从原生 `<dialog>.showModal()` 免费拿到这两条的;我们这边由
   * `usePluginDialog` 按宿主 `useModalLayer.ts` 的同一份语义提供。
   *
   * ⚠️ **不要**把这段逻辑再引回本文件:一处行为、一处真源。本弹窗的关闭语义由
   * `docs/probes/clone-dialog-dismiss-probe.mjs` 钉着(B/C/D/E/F/G 组),契约没变。
   */

  useEffect(() => {
    if (tab === 'github') void store.loadRemoteRepos();
    // `store` 是 `props.store`,由 `src/client/index.ts` 的 `storeFor()` 按 session
    // 记忆化(`stores` Map),一个面板实例内身份恒定 —— 所以把它列进依赖不会造成
    // 重跑,而是把「这个 effect 依赖什么」写实。原来这里是空理由的
    // `eslint-disable-next-line`,见 docs/lint-layer.md §8.5。
  }, [tab, store]);

  // 选择 GitHub 仓库时把 URL 也填上,两个 tab 共用同一份提交逻辑
  useEffect(() => {
    if (tab === 'github' && selected !== null) setUrl(`https://github.com/${selected}.git`);
  }, [tab, selected]);

  const chooseDirectory = async (): Promise<void> => {
    const result = await api.pickDirectory();
    if (result.ok && result.value.path !== null) {
      // Desktop 的语义是选目录后拼上仓库名;没有仓库名时直接用所选目录
      const name = sanitizeCloneName(repoNameFromUrl(url) ?? '') ?? '';
      setPath(name === '' ? result.value.path : `${result.value.path}/${name}`);
    }
  };

  const disabled = url.trim() === '' || path.trim() === '' || loading || error !== null;

  const clone = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    const result = await api.clone(url.trim(), path.trim());
    setLoading(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    store.toast(`已克隆到 ${result.value.root}`);
    props.onClose();
    await store.refreshRepos();
  };

  return (
    /*
     * 卡片类名 `gw-clone` 与可达名字 `aria-labelledby="gw-clone-title"` 是**探针契约**
     * (`docs/probes/clone-dialog-dismiss-probe.mjs` 的 A1-A4 组),不要改。
     */
    <PluginDialog className="gw-clone" labelledBy="gw-clone-title" onClose={props.onClose}>
      <h4 id="gw-clone-title">Clone a repository</h4>

      {/* Desktop: TabBar(GitHub.com / GitHub Enterprise / URL);我们不做 Enterprise */}
      <div className="gw-clone-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'github'} className={`gw-clone-tab${tab === 'github' ? ' on' : ''}`}
          onClick={() => { setTab('github'); setError(null); }}>
          <Icon name="git-branch" size={12} /> GitHub
        </button>
        <button role="tab" aria-selected={tab === 'url'} className={`gw-clone-tab${tab === 'url' ? ' on' : ''}`}
          onClick={() => { setTab('url'); setError(null); }}>
          <Icon name="external-link" size={12} /> URL
        </button>
      </div>

      {error !== null && <div className="gw-errbox">{error}</div>}

      <div role="tabpanel" className="gw-dialog-body">
        {tab === 'url' ? (
          <>
            <div className="gw-field">
              <label htmlFor="gw-clone-url">
                Repository URL or GitHub username and repository
                <span className="gw-hint" style={{ padding: '0 0 0 4px' }}>(hubot/cool-repo)</span>
              </label>
              <input id="gw-clone-url" className="gw-input" autoFocus
                placeholder="URL or username/repository" value={url}
                onChange={(event) => setUrl(event.target.value)} />
            </div>
            <div className="gw-field">
              <label htmlFor="gw-clone-path">Local path</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <input id="gw-clone-path" className="gw-input" style={{ flex: 1 }}
                  placeholder="repository path" value={path}
                  onChange={(event) => setPath(event.target.value)} />
                <button className="gw-btn" onClick={() => { void chooseDirectory(); }}>Choose…</button>
              </div>
            </div>
          </>
        ) : (
          <GitHubPicker store={store} filter={filter} onFilter={setFilter}
            selected={selected} onSelect={setSelected} />
        )}
      </div>

      {/* Desktop: OkCancelButtonGroup okButtonText="Clone" + okButtonDisabled */}
      <div className="gw-dialog-actions">
        <button className="gw-btn" onClick={props.onClose}>Cancel</button>
        <button className="gw-btn primary" disabled={disabled}
          onClick={() => { void clone(); }}>
          {loading ? 'Cloning…' : 'Clone'}
        </button>
      </div>
    </PluginDialog>
  );
}

/** GitHub tab:可过滤的仓库列表（对应 Desktop 的 CloneableRepositoryFilterList）。 */
function GitHubPicker(props: {
  store: GitStore;
  filter: string;
  onFilter: (value: string) => void;
  selected: string | null;
  onSelect: (fullName: string) => void;
}): ReactNode {
  const repos = props.store.snapshot().remoteRepos;
  const query = props.filter.trim().toLowerCase();
  const hits = useMemo(
    () => repos.filter((r) => query === '' || r.fullName.toLowerCase().includes(query)).slice(0, 100),
    [repos, query],
  );
  const linked = new Set(props.store.snapshot().repos.map((r) => r.remote).filter((x): x is string => x !== null));

  if (repos.length === 0) {
    return (
      <div className="gw-hint">
        未登录 GitHub,或还没有可克隆的仓库。可以切到 <strong>URL</strong> 页签直接粘贴地址;
        在 ⚙ 设置里登录后这里会列出你有权限的全部仓库。
      </div>
    );
  }
  return (
    <>
      <div className="gw-field">
        <input className="gw-input" placeholder="Filter repositories" value={props.filter}
          onChange={(event) => props.onFilter(event.target.value)} />
      </div>
      <div className="gw-clone-list" role="listbox" aria-label="Repositories">
        {hits.map((repo: RemoteRepo) => (
          <div key={repo.fullName} role="option" aria-selected={props.selected === repo.fullName}
            className={`gw-pitem${props.selected === repo.fullName ? ' cur' : ''}`}
            onClick={() => props.onSelect(repo.fullName)} title={repo.description ?? repo.fullName}>
            <Icon name={repo.isPrivate ? 'lock' : 'git-branch'} size={11} />
            <span className="grow">{repo.fullName}</span>
            <span className="tail">{linked.has(repo.fullName) ? '已在本地' : repo.pushedAt.slice(0, 10)}</span>
          </div>
        ))}
        {hits.length === 0 && <div className="gw-hint">没有匹配的仓库。</div>}
      </div>
    </>
  );
}

/**
 * 从 URL 取出仓库目录名（只用于预填 Local path）。
 *
 * 目录名交给 Desktop 的 `sanitizeCloneName` 处理:它把 `/`、`\`、`:` 都当分隔符,
 * 取最后一个非空段、去掉 `.git` 后缀、并**拒绝 `..` / `.` 这类穿越段**
 * (见 `references/desktop/app/src/lib/remote-parsing.ts:88-118`,实现对齐 git 的
 * `git_url_basename()`)。这条路径守卫很重要:算出来的名字会拼进目标路径。
 * @param url - 用户输入的克隆地址。
 * @returns 单个路径段;无法安全得出时返回 null。
 */
function repoNameFromUrl(url: string): string | null {
  const parsed = parseRepositoryIdentifier(url.trim());
  if (parsed !== null) return sanitizeCloneName(parsed.name);
  return sanitizeCloneName(url.trim());
}
