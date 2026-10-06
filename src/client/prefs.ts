/**
 * **dsh-git 自己的偏好层** —— Preferences 弹窗里那些「上游有键、我们也要有行为」的开关。
 *
 * ## 这个文件解决什么问题(以及它**不**解决什么)
 *
 * 目标文档 §11.3 与 `docs/preferences-port.md` §8.3 记着同一件事:Preferences 弹窗里
 * 大部分开关**只有界面**(`noopBoolean`),那是本项目反复点名的静默缺陷类
 * ——「可见但无作用的控件」(与 `gw.autoSec` 同族)。本文件把**我们产品里真的有行为**
 * 的三个键收在一处:
 *
 * | 键(localStorage) | 上游来源 | 我们的消费方 |
 * |---|---|---|
 * | `diff-tab-size` | `app-store.ts` 的 `selectedTabSize`(默认 `tabSizeDefault = 4`) | `src/client/desktop-diff.tsx` 把 diff 根元素的 CSS `tab-size` 设成它 |
 * | `underline-links` | `app-state.ts:410` 的 `underlineLinks`(偏好「给链接加下划线」) | `src/client/workbench.tsx` 在 `.gw-root` 上挂 `gw-underline-links`,规则见 `pref-adapt.ts` |
 * | `preferred-external-editor` | `app-state.ts` 的 `selectedExternalEditor` | `src/client/changes-view.tsx` 的 `NoChanges` 用它挑「在 … 中打开」的主编辑器 |
 *
 * **刻意不放在这里**的三个键,它们各有更正确的归属:
 *  - `diff-check-marks-visible` —— 在 `src/client/diff-mode.ts`(Desktop 原键、原默认);
 *  - `dateFormat` / `timeFormat` / `numberFormat` / `preferAbsoluteDates` —— 在镜像
 *    `models/formatting-preferences.ts`,那**本身就是真的 localStorage 实现**(沿用);
 *  - `show-side-by-side-diff` / `hide-whitespace-*` / `image-diff-type` —— 同上,`diff-mode.ts`。
 *
 * ## 为什么是「localStorage + 同页事件」而不是 React 状态
 *
 * 与 `diff-mode.ts` 的 `useShowDiffCheckMarks()` **同一套机制**,理由也相同:
 * 写 localStorage **不会**让同页的其它组件重渲染(规范规定 `storage` 事件只在**别的**
 * 标签页触发),而写入方(Preferences 弹窗)与读取方(diff / 顶栏 / Changes)互不相邻
 * (`Modal` 甚至 portal 到 `document.body`)。只写不广播 = 「看起来接上了、刷新才生效」。
 *
 * 所以每次写入都广播一个 `CustomEvent`,并把**键名**放进 `detail` —— 订阅方按自己的键过滤,
 * 多个键共用一个事件而不串台。订阅同时收 `storage` 事件(跨标签页/多窗口)。
 *
 * @see src/client/pref-adapt.ts —— 我们**删掉**了哪些无法实现的控件、为什么
 * @see docs/preferences-port.md —— 这份弹窗的移植记录
 * @module dsh-git/client/prefs
 */

import { useSyncExternalStore } from 'react';

/** 偏好变化广播事件名(同页)。`detail` = 发生变化的 localStorage 键。 */
export const PREFERENCE_CHANGED_EVENT = 'dsh-git:preference-changed';

// ---------- 读写原语(隐私模式/被禁用时 localStorage 会抛,一律退回默认值) ----------

function readRaw(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // 写不进去就只在本次会话内生效(与 diff-mode.ts 的取合同)。
  }
  try {
    window.dispatchEvent(new CustomEvent(PREFERENCE_CHANGED_EVENT, { detail: key }));
  } catch {
    // 没有 window(SSR / 探针)时只持久化,不广播。
  }
}

/** 订阅某个键的变化(同页广播 + 跨标签页 `storage`)。返回退订函数。 */
export function subscribePreference(key: string, onChange: () => void): () => void {
  const onCustom = (event: Event): void => {
    const detail = (event as CustomEvent<string>).detail;
    if (detail === undefined || detail === key) { onChange(); }
  };
  const onStorage = (event: StorageEvent): void => {
    if (event.key === key) { onChange(); }
  };
  window.addEventListener(PREFERENCE_CHANGED_EVENT, onCustom);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(PREFERENCE_CHANGED_EVENT, onCustom);
    window.removeEventListener('storage', onStorage);
  };
}

// ---------- `diff-tab-size`(上游「Diff Tab Size」) ----------

/**
 * Desktop 的 `selectedTabSize` 键名。上游把它存在应用数据库里(不是 localStorage),
 * 所以这是我们**自己起的键名**(前缀保持与其它键同风格);可接受值也与上游那个
 * `<Select>` 的选项表逐字一致(`appearance.tsx:273`)。
 */
const KEY_DIFF_TAB_SIZE = 'diff-tab-size';

/** 上游 `appearance.tsx:273` 的 `availableTabSizes`(逐字)。 */
export const DIFF_TAB_SIZES: ReadonlyArray<number> = [1, 2, 3, 4, 5, 6, 8, 10, 12];

/** 上游 `lib/stores/app-store.ts:532` 的 `tabSizeDefault`(逐字 = 4)。 */
export const DIFF_TAB_SIZE_DEFAULT = 4;

/** 读「Diff Tab Size」;非法值(手改 localStorage / 不在选项表里)回默认值。 */
export function getDiffTabSize(): number {
  const raw = readRaw(KEY_DIFF_TAB_SIZE);
  if (raw === null) { return DIFF_TAB_SIZE_DEFAULT; }
  const parsed = Number.parseInt(raw, 10);
  return DIFF_TAB_SIZES.includes(parsed) ? parsed : DIFF_TAB_SIZE_DEFAULT;
}

/** 写「Diff Tab Size」(写入前按上游的选项表收敛,越界值落回默认)。 */
export function setDiffTabSize(size: number): void {
  const value = DIFF_TAB_SIZES.includes(size) ? size : DIFF_TAB_SIZE_DEFAULT;
  writeRaw(KEY_DIFF_TAB_SIZE, String(value));
}

/** 订阅「Diff Tab Size」的 React 钩子。 */
export function useDiffTabSize(): number {
  return useSyncExternalStore(
    (onChange) => subscribePreference(KEY_DIFF_TAB_SIZE, onChange),
    getDiffTabSize,
    () => DIFF_TAB_SIZE_DEFAULT
  );
}

// ---------- `underline-links`(上游「Underline links」) ----------

/** Desktop 的 `underlineLinks` 默认值:上游 app-state 里默认关(我们原始实现也是 `false`)。 */
const KEY_UNDERLINE_LINKS = 'underline-links';
export const UNDERLINE_LINKS_DEFAULT = false;

/** 读「给链接加下划线」。 */
export function getUnderlineLinks(): boolean {
  const raw = readRaw(KEY_UNDERLINE_LINKS);
  return raw === null ? UNDERLINE_LINKS_DEFAULT : raw === 'true' || raw === '1';
}

/** 写「给链接加下划线」。 */
export function setUnderlineLinks(value: boolean): void {
  writeRaw(KEY_UNDERLINE_LINKS, value ? 'true' : 'false');
}

/** 订阅「给链接加下划线」的 React 钩子(`workbench.tsx` 用它给根节点挂类)。 */
export function useUnderlineLinks(): boolean {
  return useSyncExternalStore(
    (onChange) => subscribePreference(KEY_UNDERLINE_LINKS, onChange),
    getUnderlineLinks,
    () => UNDERLINE_LINKS_DEFAULT
  );
}

// ---------- `preferred-external-editor`(上游「External Editor」) ----------

/**
 * 首选外部编辑器的键。存的是 **`externalApps[].id`**(host `system/apps` 返回的应用 id),
 * 不是界面上的 label —— label 可能重名,id 才是 `systemOpenInApp(path, appId)` 吃的东西。
 */
const KEY_PREFERRED_EXTERNAL_EDITOR = 'preferred-external-editor';

/** 读首选外部编辑器 id;没选过返回 `null`(消费方回落到探测到的第一个)。 */
export function getPreferredExternalEditor(): string | null {
  const raw = readRaw(KEY_PREFERRED_EXTERNAL_EDITOR);
  return raw === null || raw === '' ? null : raw;
}

/** 写首选外部编辑器 id;传 `null` 表示「没有偏好」。 */
export function setPreferredExternalEditor(id: string | null): void {
  writeRaw(KEY_PREFERRED_EXTERNAL_EDITOR, id ?? '');
}

/** 订阅首选外部编辑器的 React 钩子。 */
export function usePreferredExternalEditor(): string | null {
  return useSyncExternalStore(
    (onChange) => subscribePreference(KEY_PREFERRED_EXTERNAL_EDITOR, onChange),
    getPreferredExternalEditor,
    () => null
  );
}

