/**
 * 系统动作:在文件管理器里显示、用外部编辑器打开。
 *
 * 对应 GitHub Desktop 的 `Show in Finder` / `Open in <editor>` 两个建议动作
 * (`ui/changes/no-changes.tsx:266-340`)。Desktop 是通过 Electron 的
 * `shell.showItemInFolder` / 编辑器集成做的;我们走 `ctx.subprocess` 调平台命令。
 *
 * **安全边界**:这两个动作会执行系统命令,所以目标路径必须先落在用户显式添加过的
 * 仓库清单里(与 `GitService` 的 `allowedRoots` 同一套判据)。绝不允许任意路径,
 * 否则一个网页就能借它执行 `open` 打开任意东西。
 * @module dsh-git/host/system-service
 */

import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { globalGitConfigPath } from './git-service.ts';
import { spawnCommand, type SubprocessLike } from './git-runner.ts';

/** 可被「用编辑器打开」的候选应用(仅 macOS 按 .app 探测;其他平台交给系统默认)。 */
const MAC_EDITORS: readonly { id: string; label: string; bundles: readonly string[] }[] = [
  { id: 'vscode', label: 'Visual Studio Code', bundles: ['Visual Studio Code.app', 'Visual Studio Code - Insiders.app'] },
  { id: 'cursor', label: 'Cursor', bundles: ['Cursor.app'] },
  { id: 'windsurf', label: 'Windsurf', bundles: ['Windsurf.app'] },
  { id: 'zed', label: 'Zed', bundles: ['Zed.app'] },
  { id: 'sublime', label: 'Sublime Text', bundles: ['Sublime Text.app'] },
  { id: 'webstorm', label: 'WebStorm', bundles: ['WebStorm.app'] },
  { id: 'idea', label: 'IntelliJ IDEA', bundles: ['IntelliJ IDEA.app', 'IntelliJ IDEA Ultimate.app', 'IntelliJ IDEA CE.app'] },
  { id: 'xcode', label: 'Xcode', bundles: ['Xcode.app'] },
];

/** 一个可在界面上列出的外部应用。 */
export interface ExternalApp {
  id: string;
  label: string;
  /** 传给 `open -a` 的实参(应用名或 .app 路径)。 */
  target: string;
}

/** 系统动作服务。 */
export class SystemService {
  /**
   * @param ctx - 携带 `subprocess` 的宿主上下文。
   * @param allowedRoots - 允许操作的仓库根路径(来自用户显式添加的清单)。
   * @param platform - `process.platform`(可覆盖,便于验证)。
   */
  constructor(
    private readonly ctx: { subprocess?: unknown },
    private readonly allowedRoots: () => readonly string[],
    private readonly platform: string = process.platform,
  ) {}

  /**
   * 校验目标路径落在某个已登记仓库内。
   * @param target - 待校验的绝对路径。
   * @returns 规范化后的绝对路径。
   * @throws Error 越界时。
   */
  private guard(target: string): string {
    if (typeof target !== 'string' || target.trim() === '') {
      throw new Error('缺少路径。');
    }
    const resolved = resolve(target);
    for (const root of this.allowedRoots()) {
      const normalizedRoot = resolve(root);
      // 必须带分隔符比较:否则 /a/repomalicious 会被判成在 /a/repo 之下。
      if (resolved === normalizedRoot || resolved.startsWith(normalizedRoot + sep)) {
        return resolved;
      }
    }
    throw new Error('该路径不在已添加的仓库清单里,拒绝执行系统动作。');
  }

  /**
   * 在文件管理器中显示该路径。
   *
   * 照 Desktop 的 `open-working-directory`(`Show in Finder` /
   * `Show in Explorer` / 文件管理器)。
   * @param target - 仓库内(或仓库根)的绝对路径。
   * @returns 是否成功。
   */
  async reveal(target: string): Promise<boolean> {
    const path = this.guard(target);
    const argv = this.platform === 'darwin'
      ? ['open', '-R', path]
      : this.platform === 'win32'
        ? ['explorer', `/select,${path}`]
        : ['xdg-open', path];
    const result = await this.exec(argv, path);
    return result.exitCode === 0;
  }

  /**
   * 用外部应用打开该路径。
   * @param target - 仓库内(或仓库根)的绝对路径。
   * @param appId - `listApps()` 返回的 id;省略则用系统默认应用。
   * @returns 是否成功。
   */
  async openInApp(target: string, appId?: string): Promise<boolean> {
    // guard 先跑(越界直接抛),再交给共用的 launch。
    const path = this.guard(target);
    return this.launch(path, appId);
  }

  /**
   * 用**系统默认应用**打开全局 gitconfig。
   *
   * 对应上游的「Edit your global Git config」两个链接
   * (`references/desktop/app/src/ui/preferences/git.tsx:214`、
   * `ui/lfs/attribute-mismatch.tsx:32` → `AppStore._editGlobalGitConfig()`,
   * `lib/stores/app-store.ts:7664-7668`)。
   *
   * 为什么单独一个入口而不是直接走 {@link openInApp}:后者开头的 {@link guard}
   * 要求目标落在**用户显式添加过的仓库清单**里,而 `~/.gitconfig` 永远不在那份清单里,
   * 走它必然被拒。
   *
   * 这**不是**给 guard 开口子:能被打开的路径由**宿主自己**算出
   * (`globalGitConfigPath()`),不接受任何调用方给的路径,所以
   * 「一个网页借它执行系统命令打开任意东西」这条威胁模型不成立 ——
   * 与 `system/open-in-app` 的能力边界相比,这里多出来的只有一个**固定**的文件。
   * 路由侧还会先核对它确实存在(不存在 ⇒ `bad-request`)。
   * @returns 系统命令是否成功退出(`open` 的退出码为 0)。
   * @throws Error 读不到主目录时(路径解析不出来)。
   */
  async openGlobalGitConfig(): Promise<boolean> {
    const path = globalGitConfigPath();
    if (path === null) {
      throw new Error('无法确定全局 git 配置文件的路径(读不到用户主目录)。');
    }
    return this.launch(path, undefined);
  }

  /**
   * 拼平台命令并执行。
   *
   * `path` 必须是**已经被校验过的**绝对路径(`guard()` 或由宿主自己算出的)——
   * 本方法不做任何路径校验,这是刻意把它留成私有方法的原因。
   * @param path - 目标绝对路径。
   * @param appId - 外部应用 id;省略/空 = 系统默认应用。
   */
  private async launch(path: string, appId?: string): Promise<boolean> {
    let argv: string[];
    if (appId === undefined || appId === '') {
      argv = this.platform === 'darwin' ? ['open', path] : this.platform === 'win32' ? ['cmd', '/c', 'start', '', path] : ['xdg-open', path];
    } else {
      const app = (await this.listApps()).find((candidate) => candidate.id === appId);
      if (app === undefined) throw new Error(`没有可用的应用:${appId}`);
      argv = this.platform === 'darwin'
        ? ['open', '-a', app.target, path]
        : this.platform === 'win32'
          ? ['cmd', '/c', 'start', '', path]
          : ['xdg-open', path];
    }
    const result = await this.exec(argv, path);
    return result.exitCode === 0;
  }

  /**
   * 列出本机可用的外部编辑器。
   *
   * macOS 上按 `.app` 是否存在探测(和 Desktop 读 `applications(path)` 的意图一致,
   * 但我们不需要走远程);其他平台只提供「系统默认」一项。
   * @returns 可用应用列表(至少含默认项时为非空)。
   */
  async listApps(): Promise<ExternalApp[]> {
    if (this.platform !== 'darwin') {
      return [{ id: 'default', label: '系统默认应用', target: '' }];
    }
    const roots = ['/Applications', join(homedir(), 'Applications')];
    const found: ExternalApp[] = [{ id: 'default', label: '系统默认应用', target: '' }];
    for (const editor of MAC_EDITORS) {
      for (const bundle of editor.bundles) {
        for (const root of roots) {
          const full = join(root, bundle);
          try {
            const info = await stat(full);
            if (info.isDirectory()) {
              found.push({ id: editor.id, label: editor.label, target: full });
              break;
            }
          } catch {
            // 不存在:继续试
          }
        }
        if (found.some((app) => app.id === editor.id)) break;
      }
    }
    return found;
  }

  /**
   * 执行一条系统命令;cwd 用目标路径的父目录(保证一定存在)。
   *
   * `exitCode` 是 `number | null`(`GitRunResult` 的形状):`null` 表示子进程
   * **被信号杀掉或超时**(`git-runner.ts:183-190`),没有退出码可言。以前这里的
   * 返回类型写成 `number`,于是把 `null` 当成一个不存在的「退出码」往外传。
   * 如实保留 `null` 而不是编一个 `1`:两个调用方都只判 `exitCode === 0`
   * (「打开」/「在 shell 里显示」成功与否),`null` 与任何非 0 一样落到失败分支,
   * 行为不变,但类型不再撒谎。
   */
  private async exec(argv: readonly string[], target: string): Promise<{ exitCode: number | null; stderr: string }> {
    const service = this.ctx.subprocess as SubprocessLike | undefined;
    if (service === undefined || typeof service.spawn !== 'function') {
      return { exitCode: 127, stderr: 'subprocess 服务不可用' };
    }
    const parent = target.includes(sep) ? target.slice(0, target.lastIndexOf(sep)) : target;
    const result = await spawnCommand(service, argv, parent === '' ? '/' : parent, {});
    return { exitCode: result.exitCode, stderr: result.stderr };
  }
}
