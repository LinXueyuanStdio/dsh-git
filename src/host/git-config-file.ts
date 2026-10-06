/**
 * 全局 gitconfig 的**文件级**信息:路径、存在性、锁文件。
 *
 * 这一小块对应上游 GitHub Desktop 的两处功能(它们此前在本插件里被判成
 * 「原生能力缺失」而没做):
 *
 *  1. **「Edit your global Git config」两个链接**
 *     (`references/desktop/app/src/ui/preferences/git.tsx:214` 与
 *      `references/desktop/app/src/ui/lfs/attribute-mismatch.tsx:32`)——
 *     上游由 `AppStore._editGlobalGitConfig()`(`lib/stores/app-store.ts:7664-7668`)
 *     先 `getGlobalConfigPath()` 再用外部编辑器打开。我们的「打开」动作走**已有的**
 *     系统动作能力(`SystemService.openGlobalGitConfig()`,它内部复用
 *     `system/open-in-app` 的那套平台命令),路径由本文件算出。
 *  2. **`ConfigLockFileExists`**(`references/desktop/app/src/ui/lib/config-lock-file-exists.tsx`,
 *     渲染点是 `references/desktop/app/src/ui/preferences/preferences.tsx:609-619` 的
 *     `existingLockFilePath !== undefined` 分支)——写全局配置撞上 git 的锁文件时提示用户。
 *
 * ## 锁文件的形状(逐字核过上游,不是猜的)
 *
 * 上游**不自己拼**锁文件路径:它从**一次失败的写入**的 git stderr 里解析出来 ——
 * `references/desktop/app/src/lib/git/core.ts:422` 的正则
 * `/^error: could not lock config file (.+?): File exists$/m`,再
 * `:444` `Path.resolve(result.path, `${normalized}.lock`)`。
 * 也就是说形状是 **`<出错的那个配置文件>.lock`**,正好是 git 自己的
 * `lockfile.h` 约定(锁 = 目标文件 + `.lock`)。
 *
 * ⚠️ 我们的路由是**只读**的:没有「一次失败的写入」可解析,所以按同一约定**推导**
 * `lockPath = <全局 gitconfig>.lock`。已知差别:若锁文件属于**另一个**被 `include`
 * 进来的配置文件(上游那种情形),这条推导会指错文件 —— 那种情况下它的 `lockExists`
 * 是 false,界面因此不会误报,但也就看不到那个锁。这是我们**做不到**上游那一步的
 * 地方,如实记在这里。
 *
 * ## 只读
 *
 * 本模块**不创建**任何文件。上游的 `git config --edit --global` 会顺带把全局配置
 * 创建出来(`lib/git/config.ts:126-140` 的注释明说这一点),而我们的契约是
 * 「文件不存在 ⇒ `bad-request`」,所以绝不能让 git 去 `edit`。
 * @module dsh-git/host/git-config-file
 */

import { stat } from 'node:fs/promises';
import { globalGitConfigPath } from './git-service.ts';

/** 全局 gitconfig 的文件级信息(路由 `config-file-info` 的载荷)。 */
export interface GitConfigFileInfo {
  /** 解析出来的全局 gitconfig 绝对路径;解析不出 ⇒ null。 */
  path: string | null;
  exists: boolean;
  /** 锁文件路径,约定为 `<path>.lock`(见文件头);`path` 为 null 时也是 null。 */
  lockPath: string | null;
  lockExists: boolean;
}

/** 路径是否存在(任何类型;stat 失败 = 不存在)。 */
async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * 读全局 gitconfig 的路径、存在性与锁文件。
 *
 * 两个 `stat` 并发跑;任何一次失败都只是「不存在」,不抛错 —— 这条路由不该因为
 * 用户没有 `~/.gitconfig` 而变成 500。
 * @returns 见 {@link GitConfigFileInfo}。
 */
export async function gitConfigFileInfo(): Promise<GitConfigFileInfo> {
  const path = globalGitConfigPath();
  if (path === null) {
    return { path: null, exists: false, lockPath: null, lockExists: false };
  }
  const lockPath = `${path}.lock`;
  const [fileExists, lockExists] = await Promise.all([exists(path), exists(lockPath)]);
  return { path, exists: fileExists, lockPath, lockExists };
}
