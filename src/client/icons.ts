/**
 * 图标集 —— **path 数据全部来自 GitHub Desktop 的 octicons 镜像,不再手写**。
 *
 * 改这个文件的起因:这里的 33 条 path 原本是我手写的「octicon 风格」近似物,
 * 逐条比过上游才发现 **只有 3 条**(`repo` / `repo-forked` / `pr`)与上游字节一致,
 * 另外 30 条是自己画的、尺寸也不对(`filter` 甚至把 16 与 24 两个变体拼进了同一个
 * 16 viewBox)。现在每一条 path 都直接引用
 * `src/core/desktop/ui/octicons/octicons.generated.ts` —— 那份文件与
 * `references/desktop/app/src/ui/octicons/octicons.generated.ts` **字节一致**(379 个符号)。
 *
 * 唯一的例外是 `loader`:`octicons.generated.ts` 里**没有** loader/spinner 这个符号,
 * 用的是 Desktop 自己的 `ui/octicons/sync-clockwise.ts`(`ui/dialog/header.tsx:81`
 * 就是 `<Octicon className="icon spin" symbol={syncClockwise} />`,那个文件的注释也写明
 * 是「水平翻转过的 sync」)。我们的 `.gw-spin` 动画是 `rotate(360deg)`,方向与它一致。
 *
 * **`Icon` 的 API 一字未改**:同样的 props(`name` / `size` / `className` / `title`)、
 * 同样的导出名(`Icon` / `IconName`)。改的只是它渲染什么。约 20 个消费组件不需要动。
 *
 * 名称 → 上游符号的完整对照表(含 `file:line`)见 `docs/desktop-ui-port.md` §9。
 * @module dsh-git/client/icons
 */

import { createElement } from 'react';
import type { ReactNode } from 'react';
import * as octicons from '../core/desktop/ui/octicons/octicons.generated.ts';
import type { OcticonSymbol } from '../core/desktop/ui/octicons/octicons.generated.ts';
import { syncClockwise } from '../core/desktop/ui/octicons/sync-clockwise.ts';

/**
 * 我们的图标名 → 上游 octicon 符号。
 *
 * 保持键名不变是刻意的:消费组件里有 `name={meta.icon}`(`changes-view.tsx` 的
 * `STATUS_META`)、`name={props.icon}`(`bits.tsx` 的 `Empty`)、`name={entry.icon}`
 * (`settings.tsx` 的 `TABS`)三处**动态**取值,它们传的都是这些字符串。
 *
 * 概念 → 符号的选择优先跟 Desktop 的调用点,而不是「长得像」:
 *  - 文件状态四件套 = `ui/octicons/status.ts` 的 `iconForStatus`(diffAdded/diffModified/
 *    diffRemoved/diffRenamed);
 *  - 仓库图标 = `ui/octicons/repository.ts` 的 `iconForRepository`(repo / repoForked / lock);
 *  - `pr` / `merge` = `ui/toolbar/branch-dropdown.tsx:149` 与 `ui/branches/branches-container.tsx:188`;
 *  - `octo`(品牌标记)= `ui/window/title-bar.tsx:113` 的 `octicons.markGithub`;
 *  - 目录 = `ui/toolbar/worktree-dropdown.tsx:158` 的 `octicons.fileDirectory`。
 */
const SYMBOLS: Record<string, OcticonSymbol> = {
  // ---- 原本就是上游数据(字节一致,这次只是换成引用) ----
  repo: octicons.repo,
  'repo-forked': octicons.repoForked,
  pr: octicons.gitPullRequest,

  // ---- 文件状态(ui/octicons/status.ts:iconForStatus) ----
  'diff-modified': octicons.diffModified,
  'diff-added': octicons.diffAdded,
  'diff-removed': octicons.diffRemoved,
  'diff-renamed': octicons.diffRenamed,
  'file-directory': octicons.fileDirectory,

  // 顺带修掉一处坏数据:原来这条 filter 把上游 **16 与 24 两个变体拼在同一个
  // 16 viewBox** 里(第二段 `M2.75 6a.75.75 0 0 0 0 1.5h18.5…` 是 24 档的,
  // 18.5 宽在 16 viewBox 里会溢出并被裁掉)。现在整条换成上游 filter 的 16 档。
  filter: octicons.filter,

  // ---- 导航 / 通用 ----
  'git-branch': octicons.gitBranch,
  'chevron-down': octicons.chevronDown,
  'chevron-right': octicons.chevronRight,
  'arrow-up': octicons.arrowUp,
  'arrow-down': octicons.arrowDown,
  'arrow-left': octicons.arrowLeft,
  check: octicons.check,
  plus: octicons.plus,

  // 刷新/同步都用上游 sync(圆环箭头)。原本 `refresh` 与 `sync` 是两条不同的手写近似物。
  refresh: octicons.sync,
  sync: octicons.sync,

  // ---- 概念图标 ----
  gear: octicons.gear,
  commit: octicons.gitCommit,
  sparkle: octicons.sparkle,
  trash: octicons.trash,
  folder: octicons.fileDirectory,
  file: octicons.file,
  issue: octicons.issueOpened,
  play: octicons.play,
  history: octicons.history,
  lock: octicons.lock,
  'external-link': octicons.linkExternal,
  'x-circle': octicons.xCircle,
  'check-circle': octicons.checkCircle,
  'dot-fill': octicons.dotFill,
  /*
   * **stash 的图标** —— 上游把它**内联**在 `ui/changes/filter-changes-list.tsx:86-98`
   * 的 `const StashIcon: OcticonSymbolVariant`(不在 `octicons.generated.ts` 里),
   * 只被 `renderStashedChanges()` 那一颗按钮用(`:1125` 的
   * `<Octicon className="stack-icon" symbol={StashIcon} />`)。
   * 这里把那个字面量**逐字搬过来**(路径字符串一个字没改),
   * 因为「按名字查表」是本文件唯一的取图标方式 —— 不搬就只剩
   * `SYMBOLS[name] ?? dot-fill` 的静默兜底(那会画出一个**错的**图标,而且不报错)。
   */
  stash: {
    w: 16,
    h: 16,
    p: [
      'M10.5 1.286h-9a.214.214 0 0 0-.214.214v9a.214.214 0 0 0 .214.214h9a.214.214 0 0 0 '
        + '.214-.214v-9a.214.214 0 0 0-.214-.214zM1.5 0h9A1.5 1.5 0 0 1 12 1.5v9a1.5 1.5 0 0 1-1.5 '
        + '1.5h-9A1.5 1.5 0 0 1 0 10.5v-9A1.5 1.5 0 0 1 1.5 0zm5.712 7.212a1.714 1.714 0 1 '
        + '1-2.424-2.424 1.714 1.714 0 0 1 2.424 2.424zM2.015 12.71c.102.729.728 1.29 1.485 '
        + '1.29h9a1.5 1.5 0 0 0 1.5-1.5v-9a1.5 1.5 0 0 0-1.29-1.485v1.442a.216.216 0 0 1 '
        + '.004.043v9a.214.214 0 0 1-.214.214h-9a.216.216 0 0 1-.043-.004H2.015zm2 2c.102.729.728 '
        + '1.29 1.485 1.29h9a1.5 1.5 0 0 0 1.5-1.5v-9a1.5 1.5 0 0 0-1.29-1.485v1.442a.216.216 0 0 1 '
        + '.004.043v9a.214.214 0 0 1-.214.214h-9a.216.216 0 0 1-.043-.004H4.015z',
    ],
  },
};

export type IconName = keyof typeof SYMBOLS | string;

/**
 * 取出「自然高度最接近请求尺寸」的那一个变体 —— 逐字复刻 Desktop 的
 * `ui/octicons/octicon.tsx:138-143` `closestNaturalHeight`。
 *
 * 上游符号的形状是 `{ '16': {p,w,h}, '24': {p,w,h} }`,少数还有 `'12'`(箭头/chevron),
 * 另有 3 个只有 `'24'`。JS 对整数型字符串键按**升序**枚举,所以 `heights[0]` 就是最小的
 * 那个 —— Desktop 的 reduce 初值正是 `naturalHeights[0]`,即「没有比请求尺寸更小的变体时
 * 退回最小变体」。这里保持一致。
 * @param naturalHeights - 符号声明的自然高度列表。
 * @param height - 请求的像素高度。
 * @returns 选中的自然高度。
 */
function closestNaturalHeight(naturalHeights: readonly number[], height: number): number {
  return naturalHeights.reduce((acc, naturalHeight) => (naturalHeight <= height ? naturalHeight : acc), naturalHeights[0]);
}

/**
 * 从 `OcticonSymbol`(单变体或变体集)里取出要渲染的那一个变体。
 * @param symbol - 上游符号。
 * @param size - 请求的像素高度。
 * @returns 变体(`p` / `w` / `h`)。
 */
function variantFor(symbol: OcticonSymbol, size: number): { p: readonly string[]; w: number; h: number } {
  if (Array.isArray((symbol as { p?: unknown }).p)) {
    return symbol as { p: readonly string[]; w: number; h: number };
  }
  const variants = symbol as Record<string, { p: readonly string[]; w: number; h: number }>;
  const heights = Object.keys(variants).map((key) => parseInt(key, 10));
  const picked = variants[closestNaturalHeight(heights, size)];
  // 理论上取不到(变体集至少有一个键),但 API 不能因为图标数据异常就崩
  return picked ?? variants[heights[0]];
}

/**
 * 图标组件:size 默认 14,颜色继承 currentColor。
 *
 * `viewBox` 用**符号自己声明的 `w`/`h`**,不是写死的 `0 0 16 16` —— 上游有 4 个符号的
 * 16 档并非正方形(`logoGithub` 49×16、`lockupGithub` 68×16、`logoGist` 25×16、
 * `feedIssueReopen` 17×16),写死 16 viewBox 会把它们压扁。宽高按 `size` 与
 * `w/h` 的比缩放,所以宽高比永远正确。
 */
export function Icon(props: { name: IconName; size?: number; className?: string; title?: string }): ReactNode {
  const symbol = SYMBOLS[props.name] ?? SYMBOLS['dot-fill'];
  const size = props.size ?? 14;
  const variant = variantFor(symbol, size);
  const width = (size * variant.w) / variant.h;
  return createElement('svg', {
    width,
    height: size,
    viewBox: `0 0 ${variant.w} ${variant.h}`,
    fill: 'currentColor',
    className: props.className,
    'aria-hidden': props.title === undefined ? 'true' : undefined,
    role: props.title === undefined ? undefined : 'img',
  },
  props.title === undefined ? null : createElement('title', undefined, props.title),
  ...variant.p.map((d, i) => createElement('path', { key: i, d })));
}
