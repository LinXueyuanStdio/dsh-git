/**
 * 设置弹窗（对应 GitHub Desktop 的 Preferences / Options）。
 *
 * 结构沿用 Desktop：
 *   - 外壳 = `ui/preferences/preferences.tsx:385-443`：Dialog(title) +
 *     `<div class="preferences-container">` + **竖向** TabBar(每项一个图标 + 文案)
 *     + 当前分区 + footer；
 *   - Accounts = `ui/preferences/accounts.tsx:35-108`：登出态是行动号召,
 *     登录态是账号卡片(头像 / 姓名 / @login) + 「Sign Out」；
 *   - Git = `ui/preferences/git.tsx:143-208`：**子页签** Author / Default branch，
 *     Author 用 `ui/lib/git-config-user-form.tsx:143-166` 的 Name + Email 两栏；
 *   - 其余分区沿用 Desktop 的命名与信息层级(Appearance / Prompts / Advanced)。
 *
 * 我们特有的「Repositories」分区:Desktop 把仓库清单放在左栏,我们放在设置里。
 * 令牌只提交给 host,界面只显示尾 4 位。
 * @module dsh-git/client/settings
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Icon, type IconName } from './icons.ts';
import { api } from './api.ts';
import type { GitStore, Snapshot } from './store.ts';

/** 设置分区(对应 Desktop 的 PreferencesTab)。 */
type SettingsTab = 'accounts' | 'git' | 'appearance' | 'prompts' | 'advanced' | 'repositories';

const TABS: readonly { id: SettingsTab; label: string; icon: IconName }[] = [
  { id: 'accounts', label: 'Accounts', icon: 'repo' },
  { id: 'git', label: 'Git', icon: 'commit' },
  { id: 'appearance', label: 'Appearance', icon: 'sparkle' },
  { id: 'prompts', label: 'Prompts', icon: 'file' },
  { id: 'advanced', label: 'Advanced', icon: 'gear' },
  { id: 'repositories', label: 'Repositories', icon: 'folder' },
];

export function SettingsPopover(props: {
  store: GitStore;
  snap: Snapshot;
  onClose: () => void;
  onOpenClone: () => void;
  fontScale: number;
  onFontScale: (value: number) => void;
}): ReactNode {
  const { store, snap } = props;
  const [tab, setTab] = useState<SettingsTab>('accounts');
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [props]);

  return (
    <div className="gw-dialog-scrim" ref={wrap}
      onMouseDown={(event) => { if (event.target === event.currentTarget) props.onClose(); }}>
      {/* Desktop: Dialog title="Settings" */}
      <div className="gw-dialog gw-settings" role="dialog" aria-modal="true" aria-labelledby="gw-settings-title">
        <h4 id="gw-settings-title">Settings</h4>

        <div className="gw-settings-container">
          {/* Desktop: TabBar type=Vertical,每项 `<Octicon class="icon"/> 文案` */}
          <div className="gw-settings-tabs" role="tablist" aria-orientation="vertical">
            {TABS.map((entry) => (
              <button key={entry.id} role="tab" aria-selected={tab === entry.id}
                className={`gw-settings-tab${tab === entry.id ? ' on' : ''}`}
                onClick={() => setTab(entry.id)}>
                <Icon name={entry.icon} size={13} className="icon" />
                {entry.label}
              </button>
            ))}
          </div>

          <div className="gw-settings-content" role="tabpanel">
            {tab === 'accounts' && <AccountsSection store={store} snap={snap} />}
            {tab === 'git' && <GitSection store={store} snap={snap} />}
            {tab === 'appearance' && (
              <AppearanceSection fontScale={props.fontScale} onFontScale={props.onFontScale} />
            )}
            {tab === 'prompts' && <PromptsSection />}
            {tab === 'advanced' && <AdvancedSection store={store} snap={snap} />}
            {tab === 'repositories' && (
              <RepositoriesSection store={store} snap={snap} onClone={props.onOpenClone} />
            )}
          </div>
        </div>

        <div className="gw-dialog-actions">
          <button className="gw-btn primary" onClick={props.onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

// ---------- Accounts（照 Desktop preferences/accounts.tsx） ----------

function AccountsSection(props: { store: GitStore; snap: Snapshot }): ReactNode {
  const { store, snap } = props;
  const [pat, setPat] = useState('');
  const [device, setDevice] = useState<null | { deviceCode: string; userCode: string; verificationUri: string; interval: number }>(null);
  const [deviceError, setDeviceError] = useState('');
  const [polling, setPolling] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (device === null || !polling) return;
    let dead = false;
    const tick = async (): Promise<void> => {
      const result = await api.devicePoll(device.deviceCode);
      if (dead) return;
      if (!result.ok) { setDeviceError(result.error.message); setPolling(false); return; }
      const value = result.value;
      if (value.status === 'done') {
        store.setAuth(value.state);
        setPolling(false);
        setDevice(null);
        store.toast(`已登录 @${value.state.login}`);
        void store.loadRemoteRepos(true);
        return;
      }
      if (value.status === 'error') { setDeviceError(value.message); setPolling(false); return; }
      const wait = value.slowDown === true ? (device.interval + 5) * 1000 : device.interval * 1000;
      pollTimer.current = setTimeout(() => { void tick(); }, wait);
    };
    pollTimer.current = setTimeout(() => { void tick(); }, device.interval * 1000);
    return () => { dead = true; if (pollTimer.current !== undefined) clearTimeout(pollTimer.current); };
  }, [device, polling, store]);

  const signedIn = snap.auth?.signedIn === true;

  return (
    <div className="gw-settings-section">
      <h3>GitHub.com</h3>
      {signedIn ? (
        /* Desktop: 账号卡片 = 头像 + 姓名 + @login,右侧 Sign Out */
        <div className="gw-account-card">
          <span className="gw-avatar" aria-hidden="true" />
          <div className="gw-account-meta">
            <strong>{snap.auth?.login}</strong>
            <span className="gw-account-login">@{snap.auth?.login}</span>
          </div>
          <button className="gw-btn" onClick={() => { void store.logout(); }}>Sign Out</button>
        </div>
      ) : (
        <>
          <p className="gw-settings-desc">
            登录后可以列出你有权限的仓库、克隆私有库、推送与拉取。
            令牌只保存在 host,浏览器与日志里都拿不到完整值。
          </p>
          {snap.auth?.deviceFlow === true && (
            device === null ? (
              <button className="gw-btn primary"
                onClick={() => {
                  setDeviceError('');
                  void (async () => {
                    const result = await api.deviceStart();
                    if (!result.ok) { setDeviceError(result.error.message); return; }
                    setDevice(result.value);
                    setPolling(true);
                  })();
                }}>
                使用 GitHub 登录（设备码）
              </button>
            ) : (
              <div className="gw-device">
                <span className="code">{device.userCode}</span>
                <button className="gw-btn" onClick={() => { void navigator.clipboard?.writeText(device.userCode); }}>复制</button>
                <button className="gw-btn" onClick={() => { window.open(device.verificationUri, '_blank', 'noopener'); }}>打开授权页</button>
                {polling && <span className="gw-hint" style={{ padding: 0 }}>等待授权…</span>}
              </div>
            )
          )}
          <div className="gw-field">
            <label htmlFor="gw-pat">或粘贴 Personal Access Token</label>
            <input id="gw-pat" className="gw-input" type="password" placeholder="ghp_… / github_pat_…"
              value={pat} onChange={(event) => setPat(event.target.value)} />
          </div>
          <div className="gw-formrow" style={{ justifyContent: 'flex-end' }}>
            <button className="gw-btn primary" disabled={pat.trim() === ''}
              onClick={() => { void store.setPat(pat.trim()).then((okay) => { if (okay) setPat(''); }); }}>
              Sign in
            </button>
          </div>
          {snap.auth?.deviceFlow !== true && (
            <div className="gw-settings-desc">
              host 未配置 OAuth App Client ID，因此只提供 PAT 登录。细粒度 Token 需要
              Contents R、Issues RW、Pull requests RW、Actions RW；经典 Token 用 <code>repo</code>。
            </div>
          )}
        </>
      )}
      {deviceError !== '' && <div className="gw-errbox">{deviceError}</div>}
    </div>
  );
}

// ---------- Git（照 Desktop preferences/git.tsx:143-208 的子页签） ----------

type GitSubTab = 'author' | 'defaultBranch';

function GitSection(props: { store: GitStore; snap: Snapshot }): ReactNode {
  const { store, snap } = props;
  const [sub, setSub] = useState<GitSubTab>('author');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [defaultBranch, setDefaultBranch] = useState('main');
  const [saving, setSaving] = useState(false);
  const path = snap.current;

  // 读当前生效值
  useEffect(() => {
    if (path === '') return;
    let dead = false;
    void (async () => {
      const [n, e, d] = await Promise.all([
        api.configGet(path, 'user.name', 'local'),
        api.configGet(path, 'user.email', 'local'),
        api.configGet(path, 'init.defaultBranch', 'global'),
      ]);
      if (dead) return;
      if (n.ok) setName(n.value.value ?? '');
      if (e.ok) setEmail(e.value.value ?? '');
      if (d.ok && d.value.value !== null) setDefaultBranch(d.value.value);
    })();
    return () => { dead = true; };
  }, [path]);

  const save = async (): Promise<void> => {
    if (path === '') return;
    setSaving(true);
    if (sub === 'author') {
      await Promise.all([
        api.configSet(path, 'user.name', name, 'local'),
        api.configSet(path, 'user.email', email, 'local'),
      ]);
      store.toast('已保存作者信息');
    } else {
      await api.configSet(path, 'init.defaultBranch', defaultBranch, 'global');
      store.toast('已保存默认分支名');
    }
    setSaving(false);
  };

  return (
    <div className="gw-settings-section">
      {/* Desktop: 分区内部再用一个横向 TabBar(Author / Default branch / Hooks) */}
      <div className="gw-subtabs" role="tablist">
        <button role="tab" aria-selected={sub === 'author'} className={`gw-subtab${sub === 'author' ? ' on' : ''}`}
          onClick={() => setSub('author')}>Author</button>
        <button role="tab" aria-selected={sub === 'defaultBranch'} className={`gw-subtab${sub === 'defaultBranch' ? ' on' : ''}`}
          onClick={() => setSub('defaultBranch')}>Default branch</button>
      </div>

      {path === '' ? (
        <div className="gw-hint">先选择一个仓库,作者信息是按仓库设置的。</div>
      ) : sub === 'author' ? (
        /* Desktop: git-config-user-form.tsx:143-166 —— Name + Email 两栏 */
        <>
          <div className="gw-field">
            <label htmlFor="gw-author-name">Name</label>
            <input id="gw-author-name" className="gw-input" value={name}
              onChange={(event) => setName(event.target.value)} />
          </div>
          <div className="gw-field">
            <label htmlFor="gw-author-email">Email</label>
            <input id="gw-author-email" className="gw-input" type="email" value={email}
              onChange={(event) => setEmail(event.target.value)} />
          </div>
          <p className="gw-settings-desc">
            提交会同时写入 <code>user.name</code> / <code>user.email</code>（作用域为本仓库）。
            Desktop 在这里会给出账号邮箱下拉;我们只写本地值,避免与 host 凭据耦合。
          </p>
        </>
      ) : (
        <>
          <div className="gw-field">
            <label htmlFor="gw-default-branch">Default branch name for new repositories</label>
            <input id="gw-default-branch" className="gw-input gw-mono" value={defaultBranch}
              onChange={(event) => setDefaultBranch(event.target.value)} />
          </div>
          <p className="gw-settings-desc">
            GitHub 的默认分支名是 <code>main</code>。如果你的集成仍要求历史的 <code>master</code>，
            可以在这里改。该值写入全局 <code>init.defaultBranch</code>。
          </p>
        </>
      )}

      <div className="gw-formrow" style={{ justifyContent: 'flex-end' }}>
        <button className="gw-btn primary" disabled={saving || path === ''}
          onClick={() => { void save(); }}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

// ---------- Appearance ----------

function AppearanceSection(props: { fontScale: number; onFontScale: (value: number) => void }): ReactNode {
  return (
    <div className="gw-settings-section">
      <h3>Appearance</h3>
      <div className="gw-field">
        <label htmlFor="gw-font-size">正文字号</label>
        <select id="gw-font-size" className="gw-input" value={String(props.fontScale)}
          onChange={(event) => props.onFontScale(Number(event.target.value))}>
          <option value="0">跟随 DSH 侧边栏</option>
          <option value="13">13 px</option>
          <option value="14">14 px</option>
        </select>
      </div>
      <p className="gw-settings-desc">
        颜色与其余排版一律跟随宿主主题令牌,所以深浅色与皮肤会自动同步,不需要在这里选主题。
      </p>
    </div>
  );
}

// ---------- Prompts（照 Desktop 的「Show a confirmation dialog before…」） ----------

/**
 * 「Show a confirmation dialog before…」那一组。
 *
 * ## 2026-10 本轮修正:它们原来是**看着能点、点了没有任何作用**的控件
 *
 * 这四行此前是 `<input type="checkbox" checked={on} readOnly />` —— 对复选框来说
 * `readOnly` **不是**「禁用」(HTML 规范里 `readonly` 不适用于 checkbox),浏览器照旧
 * 响应点击并翻转视觉状态,而 `checked` 又来自下面这张**写死的常量表**,
 * 于是用户看到的是「勾了一下、什么都没变」(下一个渲染帧还会被打回去)。
 * 这正是本项目反复点名的缺陷类:**可见但无作用**。
 *
 * ## 为什么是「明确禁用 + 说明」而不是「接线」
 *
 * 上游这四个键由应用层 store 持有(`lib/stores/app-store.ts` 的
 * `confirmForcePush` / `confirmDiscardChanges` / `confirmRepositoryRemoval` /
 * `confirmDiscardUntrackedFiles`),消费方是 `ui/toolbar/push-pull-button.tsx`、
 * `ui/changes/**` 与 `ui/repositories-list/**` 的**动作分发处** —— 也就是本插件里
 * `toolbar.tsx` / `changes-view.tsx` / `repo-bar.tsx` 三个文件(本轮**冻结**,不在本泳道
 * 授权内)。真要接线,必须同时改那三处(每个动作读偏好决定是否弹确认)+ 一个偏好层,
 * 那是三文件跨泳道的改动,**不是**在设置页里加个开关就能兑现的。
 *
 * 所以这里如实降级:禁用 + 每条写清「为什么不可改」,而不是留一个会动的假开关。
 *
 * ## 可回收条件
 *
 * 四个动作各自接上「读偏好 → 决定是否弹 `ConfirmDialog`」之后,本表改成
 * `[label, key]` 两列并把 `disabled` 去掉,接 `prefs.ts` 那一套 localStorage + 广播。
 */
function PromptsSection(): ReactNode {
  const rows: [string, boolean][] = [
    ['Force pushing', true],
    ['Discarding changes', true],
    ['Discarding untracked files', true],
    ['Removing a repository from the list', false],
  ];
  return (
    <div className="gw-settings-section">
      <h3>Show a confirmation dialog before…</h3>
      <p className="gw-settings-desc">
        这些动作当前固定按右边标出的那一档执行(与 Desktop 的默认档一致)。开关本身是禁用状态:
        本插件还没有把四个「是否确认」的偏好接到各自的动作上(接线要同时改工具栏 / 变更 /
        仓库列表三处动作分发),所以这里如实禁用,而不是给一个点了没作用的勾选框。
      </p>
      {rows.map(([label, on]) => (
        <label key={label} className="gw-chk gw-settings-row"
          title={`固定为「${on ? '确认' : '不确认'}」:本插件暂不提供这个开关`}>
          <input type="checkbox" checked={on} disabled />
          {label}
          <span className="gw-muted" style={{ marginLeft: 'auto', fontSize: 11 }}>
            {on ? '要确认' : '不确认'}
          </span>
        </label>
      ))}
    </div>
  );
}

// ---------- Advanced（我们的「辅助生成」） ----------

function AdvancedSection(props: { store: GitStore; snap: Snapshot }): ReactNode {
  const { store, snap } = props;
  return (
    <div className="gw-settings-section">
      <h3>Commit message generation</h3>
      <div className="gw-field">
        <label htmlFor="gw-model">默认模型</label>
        <select id="gw-model" className="gw-input" value={snap.model}
          onChange={(event) => { void store.setModelPersisted(event.target.value); }}>
          {snap.models.length === 0 && <option value="">（没有可用模型）</option>}
          {snap.models.map((model) => (
            <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>
              {model.name} · {model.providerName}
            </option>
          ))}
        </select>
      </div>
      <label className="gw-chk gw-settings-row">
        <input type="checkbox" checked={snap.stagedOnly}
          onChange={(event) => { void store.setStagedOnlyPersisted(event.target.checked); }} />
        只依据纳入提交的变更生成
      </label>
      <p className="gw-settings-desc">
        勾选 = 生成提交信息时只把<strong>已纳入提交</strong>的文件送给模型；
        取消勾选 = 把工作区<strong>全部</strong>未提交改动都送给模型。
        （存储键名仍是 <code>stagedOnly</code>，语义已从「已暂存」改为「纳入提交」，
        与「勾选 = 纳入、不写 git 索引」的模型一致。）
      </p>
      <p className="gw-settings-desc">
        直接调用 DSH 里已配置的 provider（<code>ctx.llm</code>），不使用任何 Copilot 付费能力。
      </p>
    </div>
  );
}

// ---------- Repositories（我们特有） ----------

function RepositoriesSection(props: { store: GitStore; snap: Snapshot; onClone: () => void }): ReactNode {
  const { store, snap } = props;
  const [manual, setManual] = useState('');
  const list = useMemo(() => snap.repos, [snap.repos]);
  return (
    <div className="gw-settings-section">
      <h3>Repositories</h3>
      <div className="gw-formrow">
        <button className="gw-btn" disabled={!snap.canPickDirectory}
          onClick={() => { void store.addRepo('@pick'); }}>
          <Icon name="plus" size={10} /> Add
        </button>
        <button className="gw-btn" onClick={props.onClone}>Clone a repository…</button>
      </div>
      <div className="gw-formrow">
        <input className="gw-input" style={{ flex: 1 }} placeholder="或直接输入 /path/to/repo"
          value={manual} onChange={(event) => setManual(event.target.value)} />
        <button className="gw-btn" disabled={manual.trim() === ''}
          onClick={() => { void store.addRepo(manual.trim()); setManual(''); }}>Add</button>
      </div>
      {list.length === 0 && <div className="gw-hint">还没有添加任何本地仓库。</div>}
      <div className="gw-settings-list">
        {list.map((repo) => (
          <div key={repo.path} className="gw-pitem" style={{ cursor: 'default' }} title={repo.path}>
            <Icon name="repo" size={12} />
            <span className="grow">{repo.alias ?? repo.name}</span>
            <span className="sub">{repo.path}</span>
            <span className="gw-x" title="移除" onClick={() => { void store.removeRepo(repo.path); }}>
              <Icon name="trash" size={10} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
