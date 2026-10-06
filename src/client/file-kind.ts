/**
 * 宿主 `ChangedFile` / `IDesktopDiffInput` → `core/partial-stage.ts` 的 `FileStatusKind`。
 *
 * 为什么单开一个模块:这个映射有**两个**必须一致的使用者 ——
 *  - `desktop-diff.tsx`(决定部分暂存补丁的**文件头**:`new file mode` / `deleted file mode`);
 *  - `store.ts` 的提交期 materialize(决定每个文件用哪条 argv 重建补丁)。
 * 两处各写一份必然漂移(其中一处漂了就是「提交时补丁头不对」这种很难看出来的坏),
 * 所以放一个纯函数模块里,两边都引它。
 * @module dsh-git/client/file-kind
 */

import type { FileStatusKind } from '../core/partial-stage.ts';
import type { ChangeStatus } from '../core/types.ts';

/** 只要求这几个字段:宿主 `ChangedFile`、`IDesktopDiffInput` 都满足。 */
export interface IFileStatusLike {
  readonly status?: ChangeStatus | undefined;
  readonly untracked?: boolean | undefined;
  readonly conflicted?: boolean | undefined;
}

/**
 * 状态 → `partial-stage` 的 kind。
 *
 * 判据与 `desktop-diff.tsx` 的 `appFileStatusFor` 同源(冲突优先、未跟踪次之,
 * 再按宿主给的状态字母)。
 * @param input - 带 `status` / `untracked` / `conflicted` 的对象。
 */
export function fileStatusKindOf(input: IFileStatusLike): FileStatusKind {
  if (input.conflicted === true || input.status === 'U') {
    return 'conflicted';
  }
  if (input.untracked === true || input.status === '?') {
    return 'untracked';
  }
  switch (input.status) {
    case 'A': return 'new';
    case 'D': return 'deleted';
    case 'R': return 'renamed';
    case 'C': return 'copied';
    default: return 'modified';
  }
}

/**
 * 一个变更文件在**行级部分暂存**这条路上是否可用。
 *
 * 两个必须同时成立的硬条件(都是宿主当前能力的边界,不是界面选择):
 *  1. **索引里没有这个文件的内容**(`staged === undefined`)。宿主 `stageLines` 会
 *     重新取 **索引→工作区** 的 diff 再按索引重建补丁,而界面显示的可能
 *     (对 staged-only 文件)是 **HEAD→索引** 的 diff ⇒ 下标空间不同,行号会错位。
 *     Window:`git-service.ts:308-341` 只认 `{file, kind, selection}`,没有「补丁基准」参数。
 *  2. **不是未跟踪/新增文件**。`stageLines` 走的是 `diffUnstagedArgv`
 *     (索引→工作区),而未跟踪文件在那条命令下**输出为空**,host 会以
 *     `bad-request: 这个文件没有可选的改动行` 失败。
 *
 * 两条都只需要 host 侧各加一个参数就能解开(`againstHead` 与 `untracked`),
 * 已记进本轮报告的「重启批次」。在那之前,这类文件只支持**整文件**纳入/排除 ——
 * 这不会给出错的结果,只是比 Desktop 少一档粒度。
 * @param file - 宿主 `ChangedFile`。
 */
export function supportsLineSelection(file: {
  readonly staged?: ChangeStatus | undefined;
  readonly untracked?: boolean | undefined;
}): boolean {
  return file.staged === undefined && file.untracked !== true;
}
