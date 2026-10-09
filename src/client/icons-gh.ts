/**
 * 远端视图(移植自 dsh-github-workbench)的图标集 —— 与 `./icons.ts` 一样,
 * **path 数据全部来自 GitHub Desktop 的 octicons 镜像,不再手写**。
 *
 * 原来这里的 25 条 path 有 24 条是我手写的近似物(只有 `pr` 与上游字节一致)。
 * 现在每条都引用 `src/core/desktop/ui/octicons/octicons.generated.ts`
 * (与 `references/desktop/app/src/ui/octicons/octicons.generated.ts` 字节一致,379 个符号);
 * 例外只有 `loader`,它用 Desktop 自己的 `ui/octicons/sync-clockwise.ts`,
 * 因为上游 octicons 里**没有** spinner 符号,而 Desktop 的 spinner 就是那个
 * (`ui/dialog/header.tsx:81`:`<Octicon className="icon spin" symbol={syncClockwise} />`)。
 *
 * 命名导出 `GwIcon` / `GhIcon` / `iconFor` / `IconName` 与 props(`name` / `size` /
 * `className` / `style` / `title`)全部保留,消费组件不需要改。
 * 名称 → 上游符号的完整对照表见 `docs/desktop-ui-port.md` §9。
 */

import { createElement } from 'react';
import type { CSSProperties } from 'react';
import * as octicons from '../core/desktop/ui/octicons/octicons.generated.ts';
import type { OcticonSymbol } from '../core/desktop/ui/octicons/octicons.generated.ts';
import { syncClockwise } from '../core/desktop/ui/octicons/sync-clockwise.ts';

export type IconName =
  | 'octo' | 'chevron-down' | 'chevron-left' | 'chevron-right' | 'refresh' | 'gear'
  | 'inbox'
  | 'code' | 'issue' | 'pr' | 'play' | 'check-circle' | 'x-circle' | 'loader'
  | 'circle-idle' | 'external-link' | 'plus' | 'pencil' | 'trash' | 'comment'
  | 'merge' | 'lock' | 'file' | 'folder' | 'folder-open'
  /*
   * CI 检查那一族 —— 符号身份与上游 `ui/branches/ci-status.tsx:124-148` 的
   * `getSymbolForCheck` **一一对应**(判断在 `src/client/check-runs.ts` 的
   * `getCheckAppearance`)。8 个结论 + 2 个「完整性指示器」的实心圆
   * (上游 `ui/check-runs/ci-check-run-popover.tsx:246-260`),共 10 个,
   * 全部来自 octicons 镜像,不是手写 path。
   */
  | 'check' | 'x' | 'stop' | 'alert' | 'skip' | 'square-fill' | 'dot-fill'
  | 'issue-reopened' | 'check-circle-fill' | 'x-circle-fill';

/**
 * 我们的图标名 → 上游 octicon 符号(键名与 `IconName` 一一对应,缺一个 TS 就报错)。
 *
 * 选择跟 Desktop 的调用点走:
 *  - `octo` = `octicons.markGithub`(`ui/window/title-bar.tsx:113`);
 *  - `merge` = `octicons.gitMerge`(`ui/branches/branches-container.tsx:188`);
 *  - `folder` / `folder-open` = `fileDirectory` / `fileDirectoryOpenFill`
 *    (`ui/toolbar/worktree-dropdown.tsx:158` 用前者作为目录的默认图标);
 *  - `loader` = `syncClockwise`(`ui/dialog/header.tsx:81`,配合 `.spin` 动画)。
 */
const SYMBOLS: Record<IconName, OcticonSymbol> = {
  octo: octicons.markGithub,
  'chevron-down': octicons.chevronDown,
  'chevron-left': octicons.chevronLeft,
  'chevron-right': octicons.chevronRight,
  // 刷新用上游 sync;Desktop 只有在「正在 checkout」时才换成翻转过的 syncClockwise。
  refresh: octicons.sync,
  gear: octicons.gear,
  inbox: octicons.inbox,
  code: octicons.code,
  issue: octicons.issueOpened,
  pr: octicons.gitPullRequest,
  play: octicons.play,
  'check-circle': octicons.checkCircle,
  'x-circle': octicons.xCircle,
  loader: syncClockwise,
  'circle-idle': octicons.circle,
  'external-link': octicons.linkExternal,
  plus: octicons.plus,
  pencil: octicons.pencil,
  trash: octicons.trash,
  comment: octicons.comment,
  merge: octicons.gitMerge,
  lock: octicons.lock,
  file: octicons.file,
  folder: octicons.fileDirectory,
  'folder-open': octicons.fileDirectoryOpenFill,
  /*
   * CI 检查那一族:逐条对应上游 `ui/branches/ci-status.tsx:127-147` 的 switch
   * (`pending` 那条是它的 `default`)。左边的名字是我们的,右边的符号是上游的。
   */
  check: octicons.check,
  x: octicons.x,
  stop: octicons.stop,
  alert: octicons.alert,
  skip: octicons.skip,
  'square-fill': octicons.squareFill,
  'dot-fill': octicons.dotFill,
  'issue-reopened': octicons.issueReopened,
  'check-circle-fill': octicons.checkCircleFill,
  'x-circle-fill': octicons.xCircleFill,
};

export interface GwIconProps {
  name: IconName;
  /** 像素尺寸,缺省 15。 */
  size?: number;
  className?: string;
  style?: CSSProperties;
  title?: string;
}

/**
 * 取出「自然高度最接近请求尺寸」的变体 —— 与 `./icons.ts` 同一份逻辑,
 * 逐字复刻 Desktop 的 `ui/octicons/octicon.tsx:138-143`。
 * @param naturalHeights - 符号声明的自然高度列表。
 * @param height - 请求的像素高度。
 * @returns 选中的自然高度。
 */
function closestNaturalHeight(naturalHeights: readonly number[], height: number): number {
  return naturalHeights.reduce((acc, naturalHeight) => (naturalHeight <= height ? naturalHeight : acc), naturalHeights[0]);
}

/**
 * 从 `OcticonSymbol` 里取出要渲染的那个变体。
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
  return picked ?? variants[heights[0]];
}

/**
 * 统一图标组件:多 path、fill 继承 currentColor。
 * `viewBox` 用符号自己声明的 `w`/`h`,不是写死的 `0 0 16 16`(上游有非正方形符号)。
 */
export function GwIcon(props: GwIconProps): React.ReactNode {
  const { name, size = 15, className = '', style, title } = props;
  const variant = variantFor(SYMBOLS[name], size);
  const width = (size * variant.w) / variant.h;
  return createElement('svg', {
    className: `gw-icon ${className}`.trim(),
    viewBox: `0 0 ${variant.w} ${variant.h}`,
    width,
    height: size,
    fill: 'currentColor',
    'aria-hidden': title ? undefined : true,
    role: title ? 'img' : undefined,
    style,
  }, title
    ? [createElement('title', { key: 't' }, title), ...variant.p.map((d, i) => createElement('path', { key: i, d }))]
    : variant.p.map((d, i) => createElement('path', { key: i, d })));
}

/** tab 注册用的图标工厂((size)=>ReactNode 形态)。 */
export function iconFor(name: IconName): (size: number) => React.ReactNode {
  return (size: number) => GwIcon({ name, size });
}

/** 别名:移植层以 GhIcon 引用同一实现。 */
export const GhIcon = GwIcon;
