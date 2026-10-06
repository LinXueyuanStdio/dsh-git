/**
 * 本地 Code 视图:仓库没有 GitHub 远端时,远端 Code 页签无法工作。
 *
 * **这里原来复用 Changes 的两栏布局**(变更列表 + diff),那是个错误 —— Code 页签
 * 的语义是「浏览仓库里的文件」,不是「看改了哪些文件」。现在改成**完整的工作区文件树**,
 * 结构与样式**直接复用远端 Code 页签那一套**:`.gw-codepane` / `.gw-tree` /
 * `.gw-tree-item` / `.gw-tree-name` / `.gw-tree-fab` / `.gw-filepane` / `.gw-crumb` /
 * `.gw-code` / `.gw-ln` / `.gw-no`,以及 <600px 时树变成覆盖式抽屉的容器查询。
 * **不新增任何 CSS**。
 *
 * 数据来源是宿主新增的 `repo/tree`(`git ls-files -z --cached --others
 * --exclude-standard`,遵守 .gitignore)与 `file-text`;树结构由既有的
 * `buildTree`(与远端 Code 页签同一份实现)从扁平路径列表合成。
 *
 * 与远端版本的差异只有数据源,以及「在 Finder 中显示」替代了「在 GitHub 上打开」。
 * @module dsh-git/client/local-code-view
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Icon } from './icons.ts';
import { Empty } from './bits.tsx';
import type { GitStore, Snapshot } from './store.ts';
import { buildTree, type TreeNode } from '../core/lib.ts';
import { api } from './api.ts';

export function LocalCodeView(props: { store: GitStore; snap: Snapshot }): ReactNode {
  const { store, snap } = props;
  const cached = snap.repoFiles !== null && snap.repoFiles.path === snap.current ? snap.repoFiles : null;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [treeOpen, setTreeOpen] = useState(false);

  useEffect(() => { void store.loadRepoFiles(); }, [store, snap.current]);

  const files = cached?.files ?? null;
  // 树结构从扁平路径列表合成(与远端页签同一个 buildTree)
  const nodes = useMemo(
    () => (files === null ? [] : buildTree(files.map((path) => ({ path, type: 'blob' as const })))),
    [files],
  );

  // 默认展开顶层目录(照远端 Code 页签的做法)
  useEffect(() => {
    if (files === null) return;
    const top = new Set<string>();
    for (const path of files) {
      const first = path.split('/')[0];
      if (path.includes('/') && first !== undefined) top.add(first);
    }
    setExpanded(top);
  }, [files]);

  const toggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  if (snap.current === '') return <Empty icon="folder" title="先选择一个仓库" />;
  if (files === null) return <Empty icon="file" title="读取工作区文件…" />;

  return (
    <div className={'gw-codepane' + (treeOpen ? ' tree-open' : '')}>
      <button className="gw-btn gw-tree-fab" title={treeOpen ? '收起文件树' : '展开文件树'}
        aria-expanded={treeOpen} onClick={() => setTreeOpen((v) => !v)}>
        <Icon name={treeOpen ? 'x-circle' : 'folder'} size={12} />
      </button>

      <div className="gw-tree" role="tree" aria-label="工作区文件">
        {cached?.truncated === true && (
          <div className="gw-pop-hint" style={{ padding: '2px 6px 8px' }}>
            文件过多,只列出了前 {files.length} 个
          </div>
        )}
        {files.length === 0 && (
          <Empty icon="folder" title="空仓库"
            body="工作区里没有可列出的文件:仓库是空的,或者全部被 .gitignore 排除了。" />
        )}
        {nodes.map((node) => (
          <TreeRow key={node.path} node={node} depth={0} expanded={expanded}
            selected={selected} onToggle={toggle}
            onSelect={(path) => { setSelected(path); setTreeOpen(false); }} />
        ))}
      </div>

      <div className="gw-filepane">
        {selected === null ? (
          <Empty icon="file" title="选择一个文件查看内容"
            body="这是本地仓库(没有 GitHub 远端),所以显示的是工作区里的真实文件。" />
        ) : (
          <FilePane key={`${snap.current}:${selected}`} store={store} repoPath={snap.current} file={selected} />
        )}
      </div>
    </div>
  );
}

/**
 * 一行树节点。**结构与远端 Code 页签完全一致**:
 * 缩进用内联 `paddingLeft: 6 + depth * 13`(远端也是这么写的),目录才有 chevron。
 * 深度做一次钳制,免得深路径把名字列挤没。
 */
function TreeRow(props: {
  node: TreeNode;
  depth: number;
  expanded: ReadonlySet<string>;
  selected: string | null;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}): ReactNode {
  const { node, depth } = props;
  const isDir = node.type === 'tree';
  const isOpen = props.expanded.has(node.path);
  const sel = props.selected === node.path;
  return (
    <>
      <button className={'gw-tree-item' + (sel ? ' sel' : '')}
        style={{ paddingLeft: 6 + Math.min(depth, 8) * 13 }}
        title={node.path} role="treeitem" aria-expanded={isDir ? isOpen : undefined}
        aria-selected={sel}
        onClick={() => { if (isDir) props.onToggle(node.path); else props.onSelect(node.path); }}>
        {isDir
          ? <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} size={11} />
          : <span style={{ width: 11, flex: 'none' }} />}
        <Icon name={isDir ? (isOpen ? 'folder' : 'folder') : 'file'} size={13}
          className={isDir ? 'gw-tree-dir' : ''} />
        <span className="gw-tree-name">{node.name}</span>
      </button>
      {isDir && isOpen && node.children?.map((child) => (
        <TreeRow key={child.path} node={child} depth={depth + 1} expanded={props.expanded}
          selected={props.selected} onToggle={props.onToggle} onSelect={props.onSelect} />
      ))}
    </>
  );
}

/** 右侧文件内容 —— 呈现与远端 Code 页签一致(面包屑 + 行号 + 代码)。 */
function FilePane(props: { store: GitStore; repoPath: string; file: string }): ReactNode {
  const { store, repoPath, file } = props;
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'error'; message: string }
    | { kind: 'ready'; kind2: 'text' | 'binary' | 'too-big'; text: string; size: number; truncated: boolean }
  >({ kind: 'loading' });

  useEffect(() => {
    let dead = false;
    void (async () => {
      const result = await api.fileText(repoPath, file);
      if (dead) return;
      if (!result.ok) { setState({ kind: 'error', message: result.error.message }); return; }
      setState({
        kind: 'ready', kind2: result.value.kind, text: result.value.text,
        size: result.value.size, truncated: result.value.truncated,
      });
    })();
    return () => { dead = true; };
  }, [repoPath, file]);

  const parts = file.split('/');
  const name = parts.pop() ?? file;
  const dir = parts.length > 0 ? `${parts.join('/')}/` : '';

  return (
    <>
      <div className="gw-crumb">
        <span className="gw-crumb-path" title={file}>
          <span className="gw-muted">{dir}</span><b>{name}</b>
        </span>
        <span className="grow" />
        <button className="gw-hbtn" title="在 Finder 中显示"
          onClick={() => { void store.revealInFileManager(`${repoPath}/${file}`); }}>
          <Icon name="folder" size={12} />
        </button>
      </div>
      {state.kind === 'loading' && <Empty icon="file" title="读取文件…" />}
      {state.kind === 'error' && <Empty icon="x-circle" title="读不到这个文件" body={state.message} />}
      {state.kind === 'ready' && state.kind2 !== 'text' && (
        <Empty icon="file"
          title={state.kind2 === 'binary' ? '二进制文件' : '文件太大'}
          body={state.kind2 === 'binary'
            ? '这个文件不是文本,无法在这里显示。'
            : `文件 ${Math.round(state.size / 1024)}KB,超过内联显示上限。`} />
      )}
      {state.kind === 'ready' && state.kind2 === 'text' && (
        <>
          {state.truncated && (
            <div className="gw-pop-hint" style={{ padding: '2px 8px' }}>只显示前 3000 行</div>
          )}
          <div className="gw-code">
            {state.text.split('\n').map((line, index) => (
              <div className="gw-ln" key={index}>
                <span className="gw-no">{index + 1}</span>
                <span style={{ whiteSpace: 'pre' }}>{line}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
