/**
 * **dsh-git 自己的偏好层** —— Preferences 弹窗里那些「上游有键、我们也要有行为」的开关。
 *
 * ## 这个文件解决什么问题(以及它**不**解决什么)
 *
 * 目标文档 §11.3 与 `docs/preferences-port.md` §8.3 记着同一件事:Preferences 弹窗里
 * 大部分开关**只有界面**(`noopBoolean`),那是本项目反复点名的静默缺陷类
 * ——「可见但无作用的控件」(与 `gw.autoSec` 同族)。本文件把**我们产品里真的有行为**
 * 的五个键收在一处:
 *
 * | 键(localStorage) | 上游来源 | 我们的消费方 |
 * |---|---|---|
 * | `diff-tab-size` | `app-store.ts` 的 `selectedTabSize`(默认 `tabSizeDefault = 4`) | `src/client/desktop-diff.tsx` 把 diff 根元素的 CSS `tab-size` 设成它 |
 * | `underline-links` | `app-state.ts:410` 的 `underlineLinks`(偏好「给链接加下划线」) | `src/client/workbench.tsx` 在 `.gw-root` 上挂 `gw-underline-links`,规则见 `pref-adapt.ts` |
 * | `preferred-external-editor` | `app-state.ts` 的 `selectedExternalEditor` | `src/client/changes-view.tsx` 的 `NoChanges` 用它挑「在 … 中打开」的主编辑器 |
 * | `confirmCommitFilteredChangesKey` | `app-store.ts:509-510`(默认 `:496` = `true`) | `src/client/changes-view.tsx` 的过滤隐藏确认框(读)+ 镜像确认框的「不再提示」(写) |
 * | `showCommitLengthWarning` | `app-store.ts:501`(**声明**默认 `:489` = `false`,但 `:2492-2498` 的迁移垫片把首启值钉成 `true` ⇒ **观测默认 = `true`**,本实现取观测口径) | `src/client/changes-view.tsx` 的 `CommitBox`(那条 50 字提示)。**设置面在上游那一页**:2026-10 用户裁决「可以加 Prompts 页」之后,开关就在**镜像** `ui/preferences/prompts.tsx:326-337` 的 `Commit Length` 一节里(接线 = `preferences-pages.tsx` 的 `usePromptsWiring`,节标题/文案按统一中文裁决本地化)。历史:曾经自造的「外观页那一行」已被用户裁决删除,后按登记的回收条件迁回上游那一页(见 12.13) |
 * | `confirmDiscardChanges` | `app-store.ts:502`(默认 `:490` = `true`;**无迁移垫片**) | `src/client/changes-view.tsx` 的整文件 / 行级丢弃闸门(见该文件的 `gateOf`)+ `preferences-pages.tsx` 的开关行 |
 * | `confirmDiscardStash` | `app-store.ts:503`(默认 `:492` = `true`;**无迁移垫片**) | 同上,stash 面板那颗「丢弃」 |
 * | `confirmUndoCommit` | `app-store.ts:508`(默认 `:495` = `true`;**无迁移垫片**) | 同上,撤销提交条的 `requestUndo` |
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

// ---------- `confirmCommitFilteredChangesKey`(上游「提交被筛选隐藏的改动时先确认」) ----------

/**
 * `确认提交被筛选隐藏的改动` 那个偏好 —— 上游 `lib/stores/app-store.ts:509-510` 的键名,
 * **逐字**(注意它自己就带 `Key` 后缀,不是我们起的名字):
 *
 * ```ts
 * const confirmCommitFilteredChangesKey: string =
 *   'confirmCommitFilteredChangesKey'
 * ```
 *
 * 上游把它写进 **localStorage**(同文件 `:7881-7882`:赋值之后
 * `setBoolean(confirmCommitFilteredChangesKey, value)`,而 `setBoolean` 在
 * `lib/local-storage.ts` 里就是 `localStorage.setItem`),所以这里走本模块同一条路径
 * —— 不新增第二套存储机制,也不改宿主的 `prefs/set`(那个 `PrefsPatch` 的键集在
 * `src/host/repo-registry.ts:55-67` 是固定的,加键要同时改宿主与 `src/index.ts` 的
 * zod schema,那超出本泳道的文件范围)。
 *
 * 上游的**写侧**是应用菜单 ▸ Preferences ▸ Prompts 的复选框
 * (`ui/preferences/prompts.tsx:224`)以及确认框自己的
 * 「Do not show this message again」(`ui/changes/confirm-commit-filtered-changes-dialog.tsx:57-64,90`);
 * **读侧**是 `ui/changes/filter-changes-list.tsx:945-951`
 * (`askForConfirmationOnCommitFilteredChanges` ⇒ `showPromptForCommittingFileHiddenByFilter`)。
 * 本插件在这之前**两侧都没有**(既没有写方也没有读方);现在两侧都落在这两个函数上。
 */
const KEY_CONFIRM_COMMIT_FILTERED_CHANGES = 'confirmCommitFilteredChangesKey';

/** 上游 `lib/stores/app-store.ts:496` 的 `confirmCommitFilteredChangesDefault`(逐字 `true`)。 */
export const CONFIRM_COMMIT_FILTERED_CHANGES_DEFAULT = true;

/**
 * 读「提交被筛选隐藏的改动时先弹确认框」。
 *
 * 取值口径照上游 `lib/local-storage.ts:20-39` 的 `getBoolean`:键不存在 ⇒ 默认值;
 * `'1'`/`'true'` ⇒ 真;`'0'`/`'false'` ⇒ 假;其余(被手改过的值)⇒ 默认值。
 */
export function getConfirmCommitFilteredChanges(): boolean {
  const raw = readRaw(KEY_CONFIRM_COMMIT_FILTERED_CHANGES);
  if (raw === null) { return CONFIRM_COMMIT_FILTERED_CHANGES_DEFAULT; }
  if (raw === '1' || raw === 'true') { return true; }
  if (raw === '0' || raw === 'false') { return false; }
  return CONFIRM_COMMIT_FILTERED_CHANGES_DEFAULT;
}

/** 写该偏好(上游 `app-store.ts:7879-7885` 的 `_setConfirmCommitFilteredChanges`)。 */
export function setConfirmCommitFilteredChanges(value: boolean): void {
  writeRaw(KEY_CONFIRM_COMMIT_FILTERED_CHANGES, value ? 'true' : 'false');
}

/**
 * ⚠️ **这个键刻意没有 `useSyncExternalStore` 版本的订阅钩子**(本文件其余三个键都有),
 * 理由是一条**实测过的**渲染路径约束,不是风格选择:
 *
 * 它唯一的读方是 `src/client/changes-view.tsx` 的 `ChangesView`,而 **20+ 条 jsdom 探针
 * 直接挂载 `ChangesView`**(`commit-form-parity-probe` / `hidden-changes-warning*` /
 * `changes-*` …),它们跑的是 `node_modules` 里的 **React 17.0.2** ——
 * `useSyncExternalStore` 是 React 18 才有的导出,第一条探针就炸成
 * `TypeError: (0, import_react16.useSyncExternalStore) is not a function`,
 * 整棵树被卸载(实测:`commit-form-parity-probe` 从 exit 0 变成未捕获异常)。
 * 产品里没有这个问题(真渲染层是 React 18),但**判据不能在探针里失真**。
 *
 * ⇒ 读方改用本文件本来就导出的两个**原语**:`subscribePreference(key, cb)` +
 * `getConfirmCommitFilteredChanges()`(见 `changes-view.tsx` 里的那两行)。
 * 存储、键名、广播机制**一个字都没换** —— 换的只是 React 侧的订阅写法。
 * 退役条件:仓库把探针的 React 抬到 18(或给所有挂 `ChangesView` 的探针统一垫
 * `useSyncExternalStore`)之后,这个键可以照其余三个键的形状补一个钩子。
 */
export const CONFIRM_COMMIT_FILTERED_CHANGES_KEY = KEY_CONFIRM_COMMIT_FILTERED_CHANGES;

// ---------- `showCommitLengthWarning`(上游「Show commit length warning」) ----------

/**
 * 「提交摘要超过 50 个字符时给一条提示」的偏好(功能点 **12.13** / 7.20)。
 *
 * ## 键名与默认值:逐字取上游(`file:line`)
 *
 * ```ts
 * // references/desktop/app/src/lib/stores/app-store.ts:489
 * const showCommitLengthWarningDefault: boolean = false
 * // references/desktop/app/src/lib/stores/app-store.ts:501
 * const showCommitLengthWarningKey: string = 'showCommitLengthWarning'
 * ```
 *
 * 上游把这个键写进 **localStorage**:同文件 `:4333-4336` 的 `_setShowCommitLengthWarning`
 * 调 `setBoolean(showCommitLengthWarningKey, …)`,而 `lib/local-storage.ts:48-50` 的
 * `setBoolean` 就是 `localStorage.setItem`。所以这里**照抄上游的键名**、走本模块同一条
 * localStorage 路径,不去动宿主的 `prefs/set`(`PrefsPatch` 的键集在
 * `src/host/repo-registry.ts:55-67` 是固定的,加键要同时改宿主与 `src/index.ts` 的 zod
 * schema,那超出本泳道的文件范围)—— 与 {@link CONFIRM_COMMIT_FILTERED_CHANGES_KEY} 同一裁决。
 *
 * ## ⚠️ 声明默认 vs 观测默认:两者不同,本实现取**观测默认 = 开**
 *
 * **声明默认**是 `false`(`:489`,逐字如上)。但同文件 `:2492-2498` 有一段迁移垫片:
 *
 * ```ts
 * // We're planning to flip the default value to false. As such we'll
 * // start persisting the current behavior to localstorage, so we
 * // can change the default in the future without affecting current
 * // users by removing this if statement.
 * if (getBoolean(showCommitLengthWarningKey) === undefined) {
 *   setBoolean(showCommitLengthWarningKey, true)
 * }
 * ```
 *
 * ⇒ 它在 `AppStore` 构造期跑 ⇒ 任何**没有**这个键的机器一启动就被写成 `true`
 * ⇒ **上游今天真正观测到的默认是「开」**;那个 `false` 只活在一个装完就没人碰过的
 * 常量里。本仓另一份台账读的也是观测口径:`docs/changes-parity/E-upstream-changes-inventory.md:391`
 * 写的是「`localStorage['showCommitLengthWarning']`(**默认 true**)」。
 *
 * ⇒ **本实现取观测默认**:{@link SHOW_COMMIT_LENGTH_WARNING_DEFAULT} = `true`,
 * 键不存在时那条提示**照旧显示**,与一个 Desktop 用户实际体验到的行为一致。
 *
 * ⚠️ **2026-10 更正(留痕)**:上一轮取的是**声明默认** `false` —— 那会让我们的
 * 默认行为与 Desktop **相反**(Desktop 用户看到提示,我们的用户看不到)。用户裁决
 * 「`showCommitLengthWarning` 按上游的来」⇒ 改成观测口径。**声明的 `false` 与观测的
 * `true` 是两个事实,两个都要留在这里**,不许互相冒充。
 *
 * ## 我们没有复刻那段垫片的**持久化副作用**(以及为什么)
 *
 * 那段垫片做两件事:① 让「键不存在」的读数为**真**;② **把 `true` 写进 localStorage**。
 * 本实现只做了 ①(把默认值设成 `true` 即等价),**刻意没有做 ②**,理由三条:
 *
 *  · ② 唯一的目的写在它自己的注释里 —— 「将来把默认翻成 `false` 时**不要影响当前用户**」
 *    (先把今天的行为钉进存储,以后才能安全地改默认值)。我们**没有这样一批「当前用户」**:
 *    这个键是本轮才进本仓的,不存在「已经默认开着、将来不能被翻转」的历史包袱。
 *    真要翻转默认,改 {@link SHOW_COMMIT_LENGTH_WARNING_DEFAULT} 一行即可 ——
 *    与上游「不能影响老用户」的处境不是一回事。
 *  · ② 是**写副作用**,而本模块的 {@link getShowCommitLengthWarning} 是**只读 getter**
 *    (上游是 `getBoolean(…)` 读、紧接着 `setBoolean(…)` 写,两件事在构造期显式分开)。
 *    「读一次就改存储」的 getter 是坏味道:它会污染任何一次只读调用(探针、SSR、
 *    将来某个只想读值的消费方)⇒ 不接受把 ② 塞进 getter。
 *  · 若将来**真的**需要 ②(例如要求与上游存储逐字节一致),落点是**显式的、有名字的、
 *    只在启动路径上调一次**的函数(例如 `ensureCommitLengthWarningPersisted()`),
 *    并在调用点写清「为什么读之前要写」。今天不需要,所以它不存在。
 *
 * `C0` 判据把这两半都钉住了:干净存储 ⇒ 提示**在**,且键**仍然不存在**。
 *
 * ## 读 / 写口径
 *
 * 读:{@link getShowCommitLengthWarning} 逐字照上游 `lib/local-storage.ts:16-36` 的
 * `getBoolean` —— 键不存在 ⇒ 默认(**今天是 `true`**,见上);`'1'`/`'true'` ⇒ 真;
 * `'0'`/`'false'` ⇒ 假;其余(被手改过的值)⇒ 默认。
 *
 * 写:编码用 `'true'`/`'false'`,与**本模块的兄弟键**
 * ({@link setConfirmCommitFilteredChanges})一致。上游 `setBoolean` 写的是 `'1'`/`'0'`
 * (`local-storage.ts:48-50`),而它自己的 `getBoolean` 明说 `'true'`/`'false'` 是**兼容值**
 * (`:21-26`)⇒ 两种编码都在上游的接受集里,这里选与同文件兄弟键一致的那一种。
 *
 * ## 这个键的**设置面**(2026-10 三笔历史,别按旧版读)
 *
 * 上游那个复选框住在 **Preferences ▸ Prompts ▸ `Commit Length`**
 * (`ui/preferences/prompts.tsx:326-337`)。
 *  a. 当时本仓按保真度账本**整页删除** Prompts ⇒ 上游那个家在这里不存在;上一轮把它放进
 *     **外观页**(`preferences-pages.tsx` 的 `CommitLengthWarningSection`),用户裁决那是
 *     **自造入口** ⇒ 删除;
 *  b. 那一轮同时登记了**回收条件**:「若将来 Prompts 页真的落地,把复选框接在**那一页**,
 *     **不要**接回外观页」;
 *  c. **2026-10 用户裁决「可以加 Prompts 页」** ⇒ 回收条件满足:开关**就在上游那一页的镜像里**
 *     (节标题 `提交摘要长度` / 文案 `显示提交摘要长度提示`,本地化登记在
 *     `scripts/verify-mirror.mjs`),接线 = `preferences-pages.tsx` 的 `usePromptsWiring`,
 *     判据 = `changes-summary-length-pref-probe` 的 `S1` + `preferences-prompts-probe` 的 `W5`。
 *
 * ⇒ 读 / 写 / 订阅与消费方(`CommitBox`)一个字没变,变的只是**开关重新有了家**。
 *
 * ## 为什么没有 `useSyncExternalStore` 钩子(与兄弟键同一个理由)
 *
 * 本键唯一的读方是 `changes-view.tsx` 的 `CommitBox`,它会被 **React 17** 的 jsdom 探针
 * 渲染(20+ 条探针直接挂 `ChangesView`,而 `node_modules` 里是 React 17.0.2,
 * 没有那个 18-only 的导出)。所以那一面用本模块本来就导出的
 * {@link subscribePreference} + 本文件的 getter;存储、键名、广播机制一个字都没换。
 * 完整理由见 {@link CONFIRM_COMMIT_FILTERED_CHANGES_KEY} 上那段注释。
 */
const KEY_SHOW_COMMIT_LENGTH_WARNING = 'showCommitLengthWarning';

/**
 * 「键不存在 / 垃圾值」时那条提示的读数 —— **取上游的观测默认 `true`**。
 *
 * ⚠️ 上游**声明**的默认是 `false`(`lib/stores/app-store.ts:489`),但它 `:2492-2498`
 * 的迁移垫片把首启值写成 `true` ⇒ Desktop 用户的观感是「开」。两者为什么不同、
 * 以及我们为什么**没有**复刻那段垫片的写副作用,逐字写在上面那段 JSDoc 里。
 */
export const SHOW_COMMIT_LENGTH_WARNING_DEFAULT = true;

/** 读「显示提交摘要长度提示」。取值口径照上游 `getBoolean`(见上)。 */
export function getShowCommitLengthWarning(): boolean {
  const raw = readRaw(KEY_SHOW_COMMIT_LENGTH_WARNING);
  if (raw === null) { return SHOW_COMMIT_LENGTH_WARNING_DEFAULT; }
  if (raw === '1' || raw === 'true') { return true; }
  if (raw === '0' || raw === 'false') { return false; }
  return SHOW_COMMIT_LENGTH_WARNING_DEFAULT;
}

/** 写该偏好(上游 `app-store.ts:4333-4336` 的 `_setShowCommitLengthWarning`)。 */
export function setShowCommitLengthWarning(value: boolean): void {
  writeRaw(KEY_SHOW_COMMIT_LENGTH_WARNING, value ? 'true' : 'false');
}

/** 该键的键名,给 `subscribePreference` 的订阅方用(与兄弟键同形)。 */
export const SHOW_COMMIT_LENGTH_WARNING_KEY = KEY_SHOW_COMMIT_LENGTH_WARNING;

// ---------- 三条「确认提示」偏好(功能点 12.16) ----------

/**
 * 上游 `lib/local-storage.ts:16-36` 的 `getBoolean` 口径的**唯一实现** ——
 * 上面两个兄弟键各自内联了同一段,这里抽出来给下面三个键用
 * (上面两个**刻意不动**:它们各自的探针已经钉住那份内联实现的行为,重写只是无谓的 diff)。
 *
 * ```ts
 * // references/desktop/app/src/lib/local-storage.ts:20-39(语义)
 * //  键不存在 ⇒ defaultValue;'1'/'true' ⇒ true;'0'/'false' ⇒ false;其余 ⇒ defaultValue
 * ```
 *
 * @param key - localStorage 键。
 * @param fallback - 上游声明的默认值(键不存在 / 垃圾值时用)。
 * @returns 该键的布尔读数。
 */
function readBoolean(key: string, fallback: boolean): boolean {
  const raw = readRaw(key);
  if (raw === null) { return fallback; }
  if (raw === '1' || raw === 'true') { return true; }
  if (raw === '0' || raw === 'false') { return false; }
  return fallback;
}

/**
 * 功能点 **12.16** 的共享说明 —— 三个键(丢弃 / 贮藏 / 撤销)的键名、默认值、
 * 写侧与**为什么没有 `useSyncExternalStore` 钩子**完全同形,所以只写一遍。
 *
 * ## 键名与默认值:逐字取上游(`file:line`,全部本轮现读)
 *
 * ```ts
 * // references/desktop/app/src/lib/stores/app-store.ts:490-495
 * const confirmDiscardChangesDefault: boolean = true
 * const confirmDiscardStashDefault: boolean = true
 * const confirmUndoCommitDefault: boolean = true
 * // 同文件 :502 / :503 / :508
 * const confirmDiscardChangesKey: string = 'confirmDiscardChanges'
 * const confirmDiscardStashKey: string = 'confirmDiscardStash'
 * const confirmUndoCommitKey: string = 'confirmUndoCommit'
 * ```
 *
 * ## ⚠️ 迁移垫片:这三个键**没有**(与 12.13 的 `showCommitLengthWarning` 相反)
 *
 * 三条都逐字核过:上游全仓对这三个键名只有「声明 / 首启读 / setter 写」三类命中,
 * **没有** `getBoolean(key) === undefined ⇒ setBoolean(key, …)` 那种「把运行期默认
 * 钉住」的垫片 —— 上游唯一那处垫片是 `showCommitLengthWarning`(`:2492-2498`)。
 *
 * ⇒ 这三个键**声明的默认 = 观测的默认 = `true`**。所以本实现**不改变任何默认行为**:
 * 改前我们是「恒弹」,改后默认仍是「弹」;偏好打开时走**与上游逐字相同的旁路**
 * (直接调 `store.discardFiles` / `dropStash` / `undoCommit`,不经确认框)。
 * ⚠️ 2026-10 更正后 **12.13 也属于「默认行为没变」这一族**(它的键同样
 * 「声明 ≠ 观测」,而本实现取观测 ⇒ 那条提示改前改后都默认显示);两个功能点现在
 * 在「默认行为不变」这一点上**相同**,不同的只是 12.13 **没有设置面**、而这三个键
 * 有(见各自 JSDoc)。
 *
 * ⚠️ 其中 **`confirmDiscardChanges` 关掉之后是「丢弃改动不再二次确认」** ——
 * 这是**贴近数据丢失**的一档(丢弃无法从 dsh-git 恢复)。它之所以安全,靠两条:
 *  1. 默认 `true`(与上游一致,用户不动它就不会失去那道闸门);
 *  2. 「丢弃**全部** / 丢弃**选中 N 个**」那条路**不受这个键控制** ——
 *     上游 `filter-changes-list.tsx:477-482`(全部)与 `:497-518`(多选)都走
 *     `onDiscardChangesFromFiles`,而 `sidebar.tsx:256-267` 那个函数**无条件**弹框
 *     (它甚至把 `showDiscardChangesSetting` 写成 `false`,即连「不再提示」都不给)。
 *     我们逐字沿用 ⇒ 只有**单文件**丢弃与**行/块级**丢弃会被这个键放行。
 *
 * ## 写侧
 *
 * 上游 `app-store.ts:7823-7873` 的 `_setConfirmDiscardChanges` / `_setConfirmDiscardStash` /
 * `_setConfirmUndoCommit` 各自 `setBoolean(<key>, value)` = `localStorage.setItem`
 * (`lib/local-storage.ts:48-50`)。所以这里照抄键名、走本模块同一条 localStorage 路径
 * —— 与 {@link CONFIRM_COMMIT_FILTERED_CHANGES_KEY} / {@link SHOW_COMMIT_LENGTH_WARNING_KEY}
 * 同一裁决,不去动宿主的 `prefs/set`(`PrefsPatch` 的键集在 `src/host/repo-registry.ts:55-67`
 * 是固定的)。
 *
 * ## 为什么没有 `useSyncExternalStore` 钩子
 *
 * 与那两个兄弟键同一个**实测过的**理由(全文见
 * {@link CONFIRM_COMMIT_FILTERED_CHANGES_KEY} 的 JSDoc):三个读方
 * (`changes-view.tsx` 的三处闸门 + `preferences-pages.tsx` 的设置行)都会被
 * **React 17** 的 jsdom 探针渲染,而 `useSyncExternalStore` 是 React 18 才有的导出。
 * ⇒ 读方一律用 {@link subscribePreference} + 本文件的 getter。
 *
 * ## 上游的「Do not show this message again」复选框(我们今天**没有**)
 *
 * 上游三个确认框各自带一个复选框,勾了就把对应偏好写成 `false`
 * (`discard-changes-dialog.tsx:111-130`、`confirm-discard-stash.tsx:60-72`、
 * `warn-local-changes-before-undo.tsx:73-83`)。我们共用 `bits.tsx` 的 `ConfirmDialog`
 * (无复选框面),所以这条**就近写侧**没有落点 —— 用户改这三条只能去设置页。
 * 这是**已知的缺口**,登记在 `changes-view.tsx` 的 `StashDiffViewer` JSDoc 里。
 */

/** 上游 `lib/stores/app-store.ts:502` 的键名(逐字)。 */
const KEY_CONFIRM_DISCARD_CHANGES = 'confirmDiscardChanges';
/** 上游 `:490` 的 `confirmDiscardChangesDefault`(逐字 `true`;**无垫片**)。 */
export const CONFIRM_DISCARD_CHANGES_DEFAULT = true;
/** 读「丢弃改动前先确认」。取值口径 = 上游 `getBoolean`(见 {@link readBoolean})。 */
export function getConfirmDiscardChanges(): boolean {
  return readBoolean(KEY_CONFIRM_DISCARD_CHANGES, CONFIRM_DISCARD_CHANGES_DEFAULT);
}
/** 写「丢弃改动前先确认」(上游 `app-store.ts:7823-7826`)。 */
export function setConfirmDiscardChanges(value: boolean): void {
  writeRaw(KEY_CONFIRM_DISCARD_CHANGES, value ? 'true' : 'false');
}
/** 该键的键名,给 `subscribePreference` 的订阅方用(与兄弟键同形)。 */
export const CONFIRM_DISCARD_CHANGES_KEY = KEY_CONFIRM_DISCARD_CHANGES;

/** 上游 `lib/stores/app-store.ts:503` 的键名(逐字)。 */
const KEY_CONFIRM_DISCARD_STASH = 'confirmDiscardStash';
/** 上游 `:492` 的 `confirmDiscardStashDefault`(逐字 `true`;**无垫片**)。 */
export const CONFIRM_DISCARD_STASH_DEFAULT = true;
/** 读「丢弃贮藏前先确认」。取值口径 = 上游 `getBoolean`(见 {@link readBoolean})。 */
export function getConfirmDiscardStash(): boolean {
  return readBoolean(KEY_CONFIRM_DISCARD_STASH, CONFIRM_DISCARD_STASH_DEFAULT);
}
/** 写「丢弃贮藏前先确认」(上游 `app-store.ts:7842-7846`)。 */
export function setConfirmDiscardStash(value: boolean): void {
  writeRaw(KEY_CONFIRM_DISCARD_STASH, value ? 'true' : 'false');
}
/** 该键的键名,给 `subscribePreference` 的订阅方用(与兄弟键同形)。 */
export const CONFIRM_DISCARD_STASH_KEY = KEY_CONFIRM_DISCARD_STASH;

/** 上游 `lib/stores/app-store.ts:508` 的键名(逐字)。 */
const KEY_CONFIRM_UNDO_COMMIT = 'confirmUndoCommit';
/** 上游 `:495` 的 `confirmUndoCommitDefault`(逐字 `true`;**无垫片**)。 */
export const CONFIRM_UNDO_COMMIT_DEFAULT = true;
/**
 * 读「撤销提交前先确认」。
 *
 * ⚠️ 它**不是**「撤销前恒弹框」:上游 `app-store.ts:5829-5840` 的完整判据是
 *
 * ```ts
 * if (showConfirmationDialog &&
 *     ((this.confirmUndoCommit && !isWorkingDirectoryClean) || commit.isMergeCommit)) { …弹… }
 * ```
 *
 * ⇒ 工作区**干净且不是合并提交**时**本来就不弹**;合并提交时**即使这个键是 `false`
 * 也照弹**(那个 `||`,不能被偏好带走)。消费方是 `changes-view.tsx` 的 `requestUndo`。
 */
export function getConfirmUndoCommit(): boolean {
  return readBoolean(KEY_CONFIRM_UNDO_COMMIT, CONFIRM_UNDO_COMMIT_DEFAULT);
}
/** 写「撤销提交前先确认」(上游 `app-store.ts:7870-7874`)。 */
export function setConfirmUndoCommit(value: boolean): void {
  writeRaw(KEY_CONFIRM_UNDO_COMMIT, value ? 'true' : 'false');
}
/** 该键的键名,给 `subscribePreference` 的订阅方用(与兄弟键同形)。 */
export const CONFIRM_UNDO_COMMIT_KEY = KEY_CONFIRM_UNDO_COMMIT;

