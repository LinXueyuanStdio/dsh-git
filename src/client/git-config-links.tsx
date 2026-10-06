/**
 * **「edit your global Git config file」两处链接的行为 + gitconfig 锁文件告警**。
 *
 * ## 1. 两处链接 —— 为什么这里**没有**一个「链接组件」
 *
 * 上游那个私有方法 `renderEditGlobalGitConfigInfo()`
 * (`references/desktop/app/src/ui/preferences/git.tsx:210-217`)被**调两次**:
 *
 * | 调用点 | 页面上的位置 |
 * |---|---|
 * | `git.tsx:179`(`renderGitConfigAuthorInfo`) | 「姓名 / 邮箱」表单下面 |
 * | `git.tsx:205`(`renderDefaultBranchSetting`) | 「新仓库默认分支」下面 |
 *
 * 这两处在我们的渲染路径上是**逐字节镜像**的那个 `git.tsx` 自己渲染的
 * (`src/core/desktop/ui/preferences/git.tsx`,`verify-mirror.mjs` 盯着),
 * 点击回调经 `Git` 的 `onEditGlobalGitConfig` prop 传进去。
 *
 * ⇒ 所以我们**故意不**再提供一个「链接组件」:那会把同两处链接变成**两份真源**,
 * 上游改一次文案/位置,我们的那份不会跟着动。本文件提供的是那条链上**唯一**缺的
 * 东西 —— **回调体 + 结果回声**({@link useEditGlobalGitConfig}),由 `git-page.tsx`
 * 的 `onEditGlobalGitConfig` prop 用上。
 *
 * 链路上的位置:
 *
 * ```
 * 镜像 git.tsx:210-217 ──onEditGlobalGitConfig──> git-page.tsx 的 onEdit
 *                                                        └─> useEditGlobalGitConfig()  ← 本文件
 *                                                              └─> api.openGitConfigFile()
 * ```
 *
 * 点下去的动作来自上游 `app-store.ts:7664-7668` 的 `_editGlobalGitConfig()`
 * (`getGlobalConfigPath()` → 用外部编辑器打开),在浏览器半对应冻结路由
 * `api.openGitConfigFile()`(`config-file-open`,**文件不存在 ⇒ bad-request**)。
 *
 * ## 2. 锁文件(上游 `ui/lib/config-lock-file-exists.tsx` + `preferences.tsx:609-619`)
 *
 * 上游在 Git 页**上方**渲染一段 `DialogError`:
 *
 * ```
 * Failed to update Git configuration file. A lock file already exists at <path>.
 * This can happen if another tool is currently modifying the Git configuration or
 * if a Git process has terminated earlier without cleaning up the lock file.
 * Do you want to [delete the lock file] and try again?
 * ```
 *
 * 触发器是 `state.existingLockFilePath` —— 写配置**失败**时被填上。我们这边锁的存在性
 * 有**独立的**数据源(`api.gitConfigFileInfo()` 直接给 `lockExists` / `lockPath`),
 * 所以不必等一次写失败:进页面就查一次,锁在就直接告警 —— 见
 * {@link useGitConfigFileInfo} + {@link GitConfigLockAlert}。
 *
 * ## ⚠️ 一处**如实**的不同:上游那个「delete the lock file」今天没有按钮
 *
 * 上游的修法是 `unlink(lockFilePath)`(`config-lock-file-exists.tsx:26-39`)。
 * 我们这边删文件要走 host,而**冻结的四条路由里没有这一条**(只有
 * `config-file-info` / `config-file-open` / `auth/*`)。
 *
 * ⇒ 本组件**不画**那个链接。画一个点了什么都不做的「删除锁文件」正是本仓反复点名的
 * 「可见但无作用」缺陷;而自己在客户端「发明」一条 host 没有的路由,失败形态更糟
 * (看起来删了、其实没删)。
 *
 * 今天给的是**真能走**的三条:锁文件路径(可复制)、为什么会锁、以及「重新检查」
 * (重读 `config-file-info`,另一条工具放手之后这里会自己变绿)。
 *
 * ### 回收条件
 *
 * host 半提供删除路由(例如 `config-file-lock-delete`,或 `config-set` 在锁冲突时
 * 返回一个可执行的 `removeLock` 动作)⇒ 在 {@link GitConfigLockAlert} 里加回上游那个
 * `createElement(LinkButton, …)`,调它并 `reload()`。
 *
 * @see src/client/host-api-bridge.ts —— 两条路由的适配层(含 `bad-request` 那一档)
 * @module dsh-git/client/git-config-links
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import {
  loadGitConfigFileInfo,
  openGitConfigFile,
  type GitConfigFileInfoResult,
} from './host-api-bridge.ts';

/** {@link openGlobalGitConfig} 的结果回调。 */
type GitConfigOpenReporter = (message: string, isWarning: boolean) => void;

/** {@link openGlobalGitConfig} 的输入。 */
interface IOpenGlobalGitConfigOptions {
  /** 已知的全局 gitconfig 路径;`null`/省略 = 还不知道(降级文案里就不点名)。 */
  readonly configPath?: string | null;
  /** 结果怎么说(`err` 是「不好」的那一类)。 */
  readonly onResult: GitConfigOpenReporter;
}

/**
 * 「打开全局 Git 配置」——**两处链接唯一的回调体**。
 *
 * 每一种失败都有一句**不同**的话,因为用户接下来要做的事不同:
 *
 * | 路由给的 | 文案 | 用户该做什么 |
 * |---|---|---|
 * | `bad-request`(文件不存在) | 「全局配置还不存在」 | 先在任一字段上做一次修改,git 会创建它 |
 * | 其它错误(含老 host 的 404) | 原样转发 host 的话 | 看那句话 |
 *
 * @param options - 见 {@link IOpenGlobalGitConfigOptions}。
 */
function openGlobalGitConfig(options: IOpenGlobalGitConfigOptions): void {
  void (async () => {
    const path = options.configPath ?? null;
    const result = await openGitConfigFile();
    switch (result.kind) {
      case 'ok':
        options.onResult('已交给系统默认应用打开。', false);
        return;
      case 'missing':
        options.onResult(
          '全局 Git 配置还不存在 —— git 会在第一次写入全局配置时创建它。' +
            (path === null ? '' : `(预期路径:${path})`),
          true,
        );
        return;
      case 'error':
        options.onResult(result.message, true);
        return;
      default:
        return;
    }
  })();
}

/** {@link useEditGlobalGitConfig} 的返回面。 */
export interface IEditGlobalGitConfigState {
  /** 结果文案;`null` = 还没有点过(调用方据此决定渲不渲染那一行)。 */
  readonly status: string | null;
  /** 结果是不是「不好」的那一类(决定挂哪组样式)。 */
  readonly statusIsWarning: boolean;
  /** 挂到上游 `Git` 的 `onEditGlobalGitConfig` 上。 */
  readonly onEdit: () => void;
}

/**
 * 「打开全局 Git 配置」的 React 形态 —— 上游 `git.tsx` 那两处链接的点击行为。
 *
 * 它是 `src/client/git-page.tsx` 接线时用的那个入口(`useEditGlobalGitConfig(configPath)`),
 * 因为上游只给一个 `onEditGlobalGitConfig: () => void` prop、而**两处**链接共用它
 * (`git.tsx:179` 与 `:205`),结果回声也只好挂在同一个地方。
 *
 * @param configPath - `useGitConfigFileInfo()` 给的路径,用于「文件还不存在」时的降级文案。
 */
export function useEditGlobalGitConfig(configPath: string | null): IEditGlobalGitConfigState {
  const [state, setState] = useState<{ status: string | null; isWarning: boolean }>({
    status: null,
    isWarning: false,
  });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /** 最新路径(回调身份必须与它无关,否则 `react/jsx-no-bind` 那一侧会换 prop 身份)。 */
  const latestPath = useRef(configPath);
  latestPath.current = configPath;

  const onEdit = useCallback(() => {
    openGlobalGitConfig({
      configPath: latestPath.current,
      onResult: (message, isWarning) => {
        if (alive.current) {
          setState({ status: message, isWarning });
        }
      },
    });
  }, []);

  return { status: state.status, statusIsWarning: state.isWarning, onEdit };
}

/** {@link useGitConfigFileInfo} 的返回面。 */
export interface IGitConfigFileInfoState {
  /** `null` = 还没读完。 */
  readonly result: GitConfigFileInfoResult | null;
  /** 重新读一次(「重新检查」按钮、或写配置失败之后)。 */
  readonly reload: () => void;
}

/**
 * 读全局 gitconfig 的路径/存在性/锁文件。
 *
 * 挂载时读一次。**不轮询**:锁的生命周期由用户自己的动作驱动(关掉另一个工具、
 * 或那次写失败之后重试),所以「重新检查」按钮比定时器更准也更省。
 */
export function useGitConfigFileInfo(): IGitConfigFileInfoState {
  const [result, setResult] = useState<GitConfigFileInfoResult | null>(null);
  const [nonce, setNonce] = useState(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    void (async () => {
      const next = await loadGitConfigFileInfo();
      if (alive.current) {
        setResult(next);
      }
    })();
  }, [nonce]);
  const reload = useCallback(() => {
    setNonce((value) => value + 1);
  }, []);
  return { result, reload };
}

/**
 * gitconfig 锁文件告警(上游 `preferences.tsx:609-619` 的 `DialogError` 分支)。
 *
 * **锁不在的时候它什么都不渲染** —— 与上游 `existingLockFilePath !== undefined`
 * 那条判断同形,不会在 Git 页上常驻一个空盒子。
 *
 * 它挂在 Git 页**上方**(上游那段 `DialogError` 也在 `<Git>` 之前),由
 * `git-page.tsx` 直接用 `useGitConfigFileInfo()` 的返回值渲染
 * (`<GitConfigLockAlert state={configFileInfo} />`)。
 *
 * @param props - `useGitConfigFileInfo()` 的当前值(调用方持有,因为「两处链接」的
 *   降级文案也要用同一个路径)。
 */
export function GitConfigLockAlert(props: { readonly state: IGitConfigFileInfoState }): ReactNode {
  const { result, reload } = props.state;
  if (result === null) {
    return null;
  }
  if (result.kind === 'error') {
    /*
     * 读不到就**说**读不到。它可能是老 host 没有这条路由(404),也可能是真的出错;
     * 两种都值得知道 —— 静默会让「锁文件存在」这件事永远不被发现。
     */
    return (
      <p className="setting-hint-warning" role="status">
        读取全局 Git 配置状态失败:{result.message}
      </p>
    );
  }
  if (!result.info.lockExists) {
    return null;
  }
  const lockPath = result.info.lockPath;
  return (
    <div className="setting-hint-warning" role="alert">
      <p>
        <span className="warning-icon">⚠️</span> 无法更新 Git 配置文件:锁文件已经存在
        {lockPath === null ? '(宿主没有给出路径)' : ` 于 ${lockPath}`}。
      </p>
      <p>
        这通常是因为另一个工具正在修改 Git 配置,或者某个 git 进程早先异常退出、
        没来得及清掉锁文件。请在确认没有 git 进程在跑之后**手工删除**那个
        <code>.lock</code> 文件,然后点下面的「重新检查」。
      </p>
      <p className="settings-description">
        ⚠️ 这里**故意没有**「删除锁文件」按钮:删文件要走 host,而冻结的路由里没有这一条
        (`config-file-info` / `config-file-open` 都不删文件)。画一个点了什么都不做的链接,
        比没有它更糟。
      </p>
      <div className="gw-formrow">
        <button className="gw-btn" onClick={reload}>
          重新检查
        </button>
      </div>
    </div>
  );
}
