/**
 * **LFS 覆盖检查的宿主适配层** —— 上游 `lib/git/lfs.ts:107-122` 的
 * `filesNotTrackedByLFS` 从镜像层接到宿主路由上。
 *
 * ## 为什么是一个单独的模块,而不是写在 `git-service.ts` / `routes.ts` 里
 *
 * 因为那份镜像实现走的是 **dugite**(`mirror/lib/git/{core,lfs}.ts`),而仓里
 * **24 个探针**各自 esbuild 一份宿主入口(`src/index.ts:405-419` 已记同一课)。
 * 谁 `import` 了镜像 git 层,谁就要复制宿主产物的四条构建参数
 * (`external: ['dugite']` / `inject` / `alias: byline` / `banner: createRequire`)。
 * 所以这里照**既有注入模式**办(`system` / `alive` / `afterPushFetch` 同一条):
 *  - 本文件是那份「需要 dugite 的实现」的**唯一落点**;
 *  - `routes.ts` 只声明一个**可选**依赖 `RouteDeps.lfs`,由 `src/index.ts` 注入;
 *  - 探针不注入时路由回可读的 `unsupported`,于是它们的产物里**一个 dugite
 *    字节都不会被拉进来**。
 *
 * ## 逐字复用的是哪一份
 *
 * `filesNotTrackedByLFS`(`mirror/lib/git/lfs.ts:107`)与它内部的
 * `isTrackedByLFS`(`:69`):`git check-attr filter <path>` + 正则 `/: filter: lfs/`。
 * **一行都没有重写**(`verify-mirror` 的字节账不变)。
 *
 * ## 两个运行期前置(都不是可选的)
 *
 * 1. `repositoryFor(root)`(`src/host/mirror-git.ts`)—— 镜像函数要一个上游
 *    `Repository`,它按路径合成并缓存(同一路径拿到同一份,`hash` 稳定);
 * 2. `ensureDugiteGitDirectory()`(`src/host/dugite-env.ts`,幂等)—— 镜像那条路
 *    是 dugite **直接 spawn** git,dugite 不回落到 `PATH`。`mirror-git.ts` 只在
 *    「推送后的刷新」里调过它,所以这里必须自己调一次(调用点少一处就是
 *    「命令找得到、运行期 ENOENT」这种最难查的形态)。
 *
 * ## 诚实边界
 *
 * · **属性是模式匹配的,与文件是否存在无关**:`.gitattributes` 里 `*.bin filter=lfs`
 *   会让一个**不存在**的 `x.bin` 也被判成「已跟踪」。这是上游的行为(实测
 *   `git check-attr filter missing.bin` ⇒ `missing.bin: filter: lfs`),不是缺陷;
 * · **不检查 git-lfs 是否安装**:上游也只读属性,不看过滤器能不能跑;
 * · 逐文件一次 git 调用(上游同形);文件多时是 N 次子进程,不做批处理 ——
 *   批处理会造出第二份解析(`check-attr` 的 `-z`/`--stdin` 形状与上游不同)。
 * @module dsh-git/host/lfs-check
 */

import { ensureDugiteGitDirectory } from './dugite-env.ts';
import { repositoryFor } from './mirror-git.ts';
import { filesNotTrackedByLFS } from './mirror/lib/git/lfs.ts';

/**
 * 这一批相对路径里,哪些**没有被** LFS 跟踪(上游同名函数的语义)。
 * @param root - 仓库工作区根(绝对路径;调用方负责过 `GitService.gate`)。
 * @param files - 仓库内相对路径。
 * @returns 未被 LFS 跟踪的那些,顺序与入参一致。
 */
export async function lfsUntracked(
  root: string,
  files: ReadonlyArray<string>,
): Promise<ReadonlyArray<string>> {
  ensureDugiteGitDirectory();
  return filesNotTrackedByLFS(repositoryFor(root), files);
}
