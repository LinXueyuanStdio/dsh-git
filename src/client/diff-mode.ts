/**
 * diff 显示选项的持久化 —— 键名与默认值**沿用 GitHub Desktop**。
 *
 * Desktop 的对应实现:`ui/lib/diff-mode.tsx`(Unified/Split)与
 * `lib/stores/app-store.ts:518-527`(空白与图片 diff 类型)。它用
 * `lib/local-storage.ts` 的 `getBoolean/setBoolean`;这里给一份最小的等价实现。
 *
 * 关键事实(审计核实):
 *  - 「隐藏空白改动」是**重新用 `git diff -w` 跑一次**,不是在界面里过滤 ——
 *    这样行号与 git 一致;
 *  - Desktop 有**三个**独立开关(Changes / History / Pull Request),
 *    键名各不相同,我们照用前两个;
 *  - Unified/Split 默认 **Unified**(`ShowSideBySideDiffDefault = false`)。
 * @module dsh-git/client/diff-mode
 */

import { useSyncExternalStore } from 'react';
import { ImageDiffType } from '../core/desktop/models/diff/index.ts';

/** Unified 是默认值(Desktop 的 ShowSideBySideDiffDefault = false)。 */
export const SHOW_SIDE_BY_SIDE_DEFAULT = false;

/** Desktop 的键名,原样照用,便于与它的行为对照。 */
const KEY_SIDE_BY_SIDE = 'show-side-by-side-diff';
const KEY_HIDE_WS_CHANGES = 'hide-whitespace-in-changes-diff';
const KEY_HIDE_WS_HISTORY = 'hide-whitespace-in-diff';

/**
 * 读一个布尔设置。
 * @param key - localStorage 键。
 * @param fallback - 键不存在或值非法时的默认值。
 */
function getBoolean(key: string, fallback: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) {
      return fallback;
    }
    return raw === 'true' || raw === '1';
  } catch {
    // 隐私模式/被禁用时 localStorage 会抛;退回默认值而不是崩。
    return fallback;
  }
}

function setBoolean(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, value ? 'true' : 'false');
  } catch {
    // 写不进去就只在本次会话生效
  }
}

/** 是否用并排(split)显示 diff;默认统一(unified)。 */
export const getShowSideBySideDiff = (): boolean => getBoolean(KEY_SIDE_BY_SIDE, SHOW_SIDE_BY_SIDE_DEFAULT);
export const setShowSideBySideDiff = (value: boolean): void => setBoolean(KEY_SIDE_BY_SIDE, value);

/** Changes 页签是否隐藏空白改动(Desktop 的独立开关之一)。 */
export const getHideWhitespaceInChangesDiff = (): boolean => getBoolean(KEY_HIDE_WS_CHANGES, false);
export const setHideWhitespaceInChangesDiff = (value: boolean): void => setBoolean(KEY_HIDE_WS_CHANGES, value);

/** History 页签是否隐藏空白改动(Desktop 的独立开关之二)。 */
export const getHideWhitespaceInHistoryDiff = (): boolean => getBoolean(KEY_HIDE_WS_HISTORY, false);
export const setHideWhitespaceInHistoryDiff = (value: boolean): void => setBoolean(KEY_HIDE_WS_HISTORY, value);

// ---------- 图片 diff 的呈现方式(Desktop 的第 4 个键) ----------

/**
 * 图片 diff 的呈现方式(2-up / Swipe / Onion skin / Difference)。
 *
 * Desktop:`app-store.ts:518-519`(`imageDiffTypeDefault = TwoUp`、键 `image-diff-type`)、
 * `:2563-2567`(读:`parseInt(localStorage.getItem(key))`,键不存在用默认)、
 * `:7940-7941`(写:`JSON.stringify(this.imageDiffType)` —— 存进去的是 `"0"`/`"1"`…)。
 *
 * 我们逐字沿用同一套键名与序列化形态,所以「切到 Swipe → 刷新 → 仍是 Swipe」
 * 与 Desktop 一致。缺这个键的后果不是报错,而是**每次刷新都回到 2-up**。
 */
const KEY_IMAGE_DIFF_TYPE = 'image-diff-type';
const IMAGE_DIFF_TYPE_DEFAULT = ImageDiffType.TwoUp;

/** 读图片 diff 的呈现方式;键缺失或值非法时回上游默认值(`TwoUp`)。 */
export function getImageDiffType(): ImageDiffType {
  try {
    const raw = window.localStorage.getItem(KEY_IMAGE_DIFF_TYPE);
    if (raw === null) {
      return IMAGE_DIFF_TYPE_DEFAULT;
    }
    const parsed = Number.parseInt(raw, 10);
    // 枚举是数字枚举;挡掉 NaN 与越界值(手改 localStorage 的情况)
    if (!Number.isFinite(parsed) || !Object.values(ImageDiffType).includes(parsed)) {
      return IMAGE_DIFF_TYPE_DEFAULT;
    }
    return parsed;
  } catch {
    return IMAGE_DIFF_TYPE_DEFAULT;
  }
}

/** 写图片 diff 的呈现方式(与上游同样存 JSON 数字)。 */
export function setImageDiffType(value: ImageDiffType): void {
  try {
    window.localStorage.setItem(KEY_IMAGE_DIFF_TYPE, JSON.stringify(value));
  } catch {
    // 写不进去就只在本次会话生效
  }
}

// ---------- 「在 diff 里显示勾选标记」(Desktop 的第 5 个键) ----------

/**
 * **Desktop 原键名与默认值(逐字取自上游,不是我们起的名字)**。
 *
 * `app-store.ts:565-566`:
 *
 * ```
 * export const showDiffCheckMarksDefault = true
 * export const showDiffCheckMarksKey = 'diff-check-marks-visible'
 * ```
 *
 * 读在 `:2632-2635`(`getBoolean(showDiffCheckMarksKey, showDiffCheckMarksDefault)`),
 * 写在 `:10323-10327`(`setBoolean`)。我们逐字沿用,所以行为与 Desktop 一致:
 * **默认开**,关掉后 diff 的行号栏不再画勾选列(上游
 * `side-by-side-diff-row.tsx:511` 的 gutter 宽度会少 20px)。
 *
 * ## 这为什么曾经是一个**假开关**(本键存在的理由)
 *
 * 在本次接线之前,`desktop-diff.tsx` 把 `showDiffCheckMarks` 传成
 * `showDiffCheckMarks={selectable}`,而 `changes-view.tsx` 的 `selectable` 恒 `true`
 * —— 于是那个 prop **不是偏好,是常量**。也就是说「Preferences ▸ Accessibility ▸
 * Show check marks in the diff」即便画出来也无法影响任何东西,属于目标文档
 * 反复点名的「可见但无作用的控件」缺陷类。现在它由本键驱动。
 */
const KEY_SHOW_DIFF_CHECK_MARKS = 'diff-check-marks-visible';

/** 上游 `app-store.ts:565` 的 `showDiffCheckMarksDefault`。 */
export const SHOW_DIFF_CHECK_MARKS_DEFAULT = true;

/**
 * 读「在 diff 里显示勾选标记」;键缺失或值非法时回上游默认值(**true**)。
 */
export const getShowDiffCheckMarks = (): boolean =>
  getBoolean(KEY_SHOW_DIFF_CHECK_MARKS, SHOW_DIFF_CHECK_MARKS_DEFAULT);

/**
 * 写「在 diff 里显示勾选标记」(Preferences ▸ Accessibility 页的开关)。
 *
 * ## 为什么要额外广播一个 `window` 事件(而不是只写 localStorage)
 *
 * 上游这个偏好住在 `AppStore` 里,`AppStore` 一改就**通知所有订阅者**,
 * 所以「在 Settings 里关掉 → diff 面板立刻不画勾」是自动的。
 * 我们这边有两个互不相邻的组件读它:`preferences-dialog.tsx`(写)与
 * `desktop-diff.tsx`(读)。`localStorage` 的 `storage` 事件**只在别的标签页**
 * 触发(规范如此),同页写入收不到任何通知 —— 只写 localStorage 的话,
 * diff 要等刷新才会变,那还是「看起来接上了、实际没反应」。
 *
 * 所以这里发射一个 `CustomEvent`(跨组件、不冒泡、同名同 key),
 * 读取方用 `useShowDiffCheckMarks()` 订阅。键名放进 `detail`,未来的开关
 * 可以复用同一个事件而互不串台。
 */
export const SHOW_DIFF_CHECK_MARKS_EVENT = 'dsh-git:diff-check-marks-visible';

export const setShowDiffCheckMarks = (value: boolean): void => {
  setBoolean(KEY_SHOW_DIFF_CHECK_MARKS, value);
  try {
    window.dispatchEvent(
      new CustomEvent(SHOW_DIFF_CHECK_MARKS_EVENT, { detail: value })
    );
  } catch {
    // 没有 window(SSR / 探针)时只持久化,不广播。
  }
};

/**
 * 订阅「在 diff 里显示勾选标记」的 React 钩子。
 *
 * 与 `workbench.tsx:35` 的 `useSyncExternalStore(store.subscribe, …)` 同一套机制,
 * 只是订阅源是这里的 localStorage + CustomEvent 广播。`getSnapshot` 每次读
 * localStorage 会返回**布尔原语**,所以不会触发 React 的「快照引用不稳定」死循环
 * (那条约束针对的是每次新建的对象/数组)。
 *
 * 订阅两条来源:同页的 `SHOW_DIFF_CHECK_MARKS_EVENT`(Preferences 写入时发),
 * 以及跨标签页的 `storage` 事件(浏览器原生,规范化过 key)。
 * @returns 当前偏好值。
 */
export function useShowDiffCheckMarks(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const onCustom = (): void => onChange();
      const onStorage = (event: StorageEvent): void => {
        if (event.key === KEY_SHOW_DIFF_CHECK_MARKS) onChange();
      };
      window.addEventListener(SHOW_DIFF_CHECK_MARKS_EVENT, onCustom);
      window.addEventListener('storage', onStorage);
      return () => {
        window.removeEventListener(SHOW_DIFF_CHECK_MARKS_EVENT, onCustom);
        window.removeEventListener('storage', onStorage);
      };
    },
    getShowDiffCheckMarks,
    () => SHOW_DIFF_CHECK_MARKS_DEFAULT
  );
}
