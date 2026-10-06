/**
 * **顶栏同步段(推送/拉取/抓取)的宽度** —— 可拖拽 + 持久化。
 *
 * ## 为什么需要它(这是**用户裁决**,不是我们自己加的功能)
 *
 * 2026-10-06 的裁决(逐字转述):同步段宽度**采纳上游的「固定 `clamp(230,200,350)` +
 * 可拖拽」**,放弃本仓此前「宽度受内容限制(max-content)」的做法。
 *
 * 上游那一半的形状很明确:
 *  - `lib/stores/app-store.ts:484` `const defaultPushPullButtonWidth: number = 230`;
 *  - `:648` `private pushPullButtonWidth = constrain(defaultPushPullButtonWidth)`;
 *  - `:6249-6250` 拖动时 `{...this.pushPullButtonWidth, value: width}` + **写 localStorage**
 *    (`pushPullButtonWidthConfigKey = 'push-pull-button-width'`,`:485`);
 *  - `:6258-6262` 双击复位:**删掉那个键**并回到默认值;
 *  - 消费方 `ui/toolbar/push-pull-button.tsx:418-423` 把 `value/min/max` 三个数传给
 *    `Resizable`;而 `ui/resizable/resizable.tsx:31-32` 自己写着「**本组件是纯的**,
 *    消费者必须订阅 `onResize`/`onReset` 并更新 width prop」。
 *
 * ⇒ 只传两个空函数的结果是「手柄能拖、松手弹回」—— 本仓最贵的那一类假控件。
 * 所以这里必须有一个**真的承重**的载体。先例是 `src/client/sidebar-width.ts`
 * (localStorage + 一个 clamp 纯函数,理由与实测都在那个文件头)。
 *
 * ## 与上游的两处**有意的**差别(逐条写明)
 *
 * 1. **存储键加前缀**:`dsh-git.push-pull-button-width`(上游是裸的
 *    `push-pull-button-width`)。理由是插件与宿主**同源**,裸键会与宿主的键空间撞名
 *    (本仓既有键一律带 `dsh-git.` / `dsh-git:` 前缀)。
 * 2. **min/max 取上游组件的默认值**:上游的 min/max 由 `updateResizableConstraints()`
 *    (`app-store.ts:2712-2799`)按**整个 Desktop 窗口**的宽度算出来;我们这里是宿主
 *    侧栏里的一格,没有「整个窗口」这个量。所以直接取 `Resizable` 自己在 props 缺省时
 *    用的那两个常数(`ui/resizable/resizable.tsx:5-6`:`DefaultMinWidth = 200` /
 *    `DefaultMaxWidth = 350`)—— 与上游在窗口足够宽时的取值一致,且**不是新数字**。
 *
 * ## 边界
 *
 * - 读失败(localStorage 被禁用 / 隐私模式)⇒ 回落到默认 230,不影响任何交互;
 * - 写失败 ⇒ 只丢持久化,本次拖动的宽度仍然生效(不假装写成功,也不抛);
 * - 值一律经 `clamp(value, min, max)`(镜像 `lib/clamp.ts`,逐字同一份)。
 *
 * @module dsh-git/client/push-pull-button-width
 */

import { useCallback, useState } from 'react';

import { clamp } from '../core/desktop/lib/clamp.ts';
import { DefaultMaxWidth, DefaultMinWidth } from '../core/desktop/ui/resizable/resizable.tsx';
import type { IConstrainedValue } from '../core/desktop/lib/app-state.ts';

/** localStorage 键(带插件前缀,理由见文件头 §1)。 */
export const PUSH_PULL_BUTTON_WIDTH_STORAGE_KEY = 'dsh-git.push-pull-button-width';

/** 上游 `app-store.ts:484` 的 `defaultPushPullButtonWidth`。 */
export const DEFAULT_PUSH_PULL_BUTTON_WIDTH = 230;

/**
 * 把任意数夹进 `[DefaultMinWidth, DefaultMaxWidth]`。
 *
 * 与 `Resizable.clampWidth()`(`resizable.tsx:56-59`)同一个区间、同一个 `clamp` 实现,
 * 所以「载体里的值」与「组件真正用的宽」不会分叉。
 */
export function clampPushPullButtonWidth(width: number): number {
  return clamp(width, DefaultMinWidth, DefaultMaxWidth);
}

/** 读持久化宽度;读不到 / 非法 / 存储不可用 ⇒ 默认 230。 */
function readStoredWidth(): number {
  try {
    const raw = window.localStorage.getItem(PUSH_PULL_BUTTON_WIDTH_STORAGE_KEY);
    const parsed = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(parsed) ? clampPushPullButtonWidth(parsed) : DEFAULT_PUSH_PULL_BUTTON_WIDTH;
  } catch {
    return DEFAULT_PUSH_PULL_BUTTON_WIDTH;
  }
}

/** 持久化宽度。写失败**只丢持久化**,不抛出(拖动本身必须照常生效)。 */
function writeStoredWidth(width: number): void {
  try {
    window.localStorage.setItem(PUSH_PULL_BUTTON_WIDTH_STORAGE_KEY, String(width));
  } catch {
    /* 隐私模式 / 存储配额:忽略 */
  }
}

/** 清掉持久化宽度(双击手柄复位,照上游 `:6258-6262`)。 */
function clearStoredWidth(): void {
  try {
    window.localStorage.removeItem(PUSH_PULL_BUTTON_WIDTH_STORAGE_KEY);
  } catch {
    /* 同上 */
  }
}

/** `usePushPullButtonWidth()` 的返回。 */
export interface IPushPullButtonWidthHandle {
  /** 直接喂给 `PushPullButton` 的 `pushPullButtonWidth` prop。 */
  readonly value: IConstrainedValue;
  /** 「推送/拉取」按钮的宽度手柄被拖动 ⇒ 新宽度(由 `Resizable` 夹过)。 */
  readonly setWidth: (width: number) => void;
  /** 双击宽度手柄 ⇒ 复位到默认值(并删掉持久化的键)。 */
  readonly resetWidth: () => void;
}

/**
 * 同步段宽度的**唯一真源**(与 `useSidebarWidth()` 同一形状,但那个的可变来源是
 * 分隔条、这个是 `Resizable` 的手柄)。
 *
 * 读值是**惰性初始化**(`useState(readStoredWidth)`):localStorage 是同步 API,
 * 这样首帧就是最终宽度,不会出现「先 200 再 230」的跳一下。
 */
export function usePushPullButtonWidth(): IPushPullButtonWidthHandle {
  const [width, setStored] = useState(readStoredWidth);

  const setWidth = useCallback((next: number): void => {
    const clamped = clampPushPullButtonWidth(next);
    writeStoredWidth(clamped);
    setStored(clamped);
  }, []);

  const resetWidth = useCallback((): void => {
    clearStoredWidth();
    setStored(DEFAULT_PUSH_PULL_BUTTON_WIDTH);
  }, []);

  return {
    value: { value: width, min: DefaultMinWidth, max: DefaultMaxWidth },
    setWidth,
    resetWidth,
  };
}
