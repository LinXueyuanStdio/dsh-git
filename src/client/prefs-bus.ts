/**
 * **本插件自己的运行期偏好总线** —— 三个页面搬进宿主设置卡片之后,那条
 * 「写值的人」与「读值的人」不是同一棵 React 子树的链路的落点。
 *
 * ## 为什么必须有这个模块(而不是继续把值当 prop 传)
 *
 * `preferences-dialog.tsx` 时代,三个页面的宿主是 `WorkbenchApp`:
 * `fontScale` 是它的 `useState`、`onPreferencesChanged` 是它的 `setPrefsRevision`,
 * 一路当 prop 传进弹窗即可。搬进**宿主设置卡片**之后,渲染卡片的
 * `src/client/host-settings-card.tsx` 与 `WorkbenchApp` 是**两棵互不相邻的树**
 * (卡片 portal 到宿主自己的设置弹窗里),更关键的是:`index.ts` 里
 * **拿不到** `WorkbenchApp` 的任何 state(它在另一个组件的闭包里)。
 *
 * ⇒ 「字号」与「偏好变更通知」这两件事需要一份**两边都能看见**的真源。
 * 本模块就是它,而且刻意只做两件事、不存服务、不碰 ctx:
 *
 * | 成员 | 语义 | 谁写 | 谁读 |
 * |---|---|---|---|
 * | {@link fontScaleStore} | 界面缩放(px;`0` = 跟随宿主) | 设置卡片的「仓库」页 | 设置卡片的「仓库」页(回显) |
 * | {@link bumpPreferencesRevision} | 「某个显示类偏好变了,请重渲染」的计数器 | 无障碍页的两个开关 | (今天没有消费方,见下) |
 *
 * ## ⚠️ 诚实的边界(不要把它读成「已经全接上了」)
 *
 * `WorkbenchApp`(`src/client/workbench.tsx`)今天仍然持有**它自己**的
 * `fontScale` / `prefsRevision` 两个 `useState`,并把它们用在自己的根节点上。
 * 本轮**不许改**那个文件(另一条泳道在改它),所以:
 *
 *  - 卡片里改字号写进 {@link fontScaleStore},**右侧栏那一半不会当场变字号**
 *    (它读的是 `WorkbenchApp` 的 state)。合并所有权之后,`workbench.tsx` 只要把
 *    `const [fontScale, setFontScale] = useState(0)` 换成
 *    `useSyncExternalStore(subscribeFontScale, getFontScale, getFontScale)`
 *    + `setFontScale`(两行),这条链就通了 —— 本模块的 API 就是照那个用法设计的;
 *  - {@link bumpPreferencesRevision} 今天**没有任何消费方**:它有的唯一原因是
 *    「设置卡片里的开关也必须能发出那条信号」,而 `index.ts` 没有别的发送点。
 *    等 `workbench.tsx` 改成订阅它,`data-prefs-revision` 就会继续增长。
 *
 * ⇒ 这两条都**如实登记在交付报告里**,不假装已经打通。
 *
 * ## 为什么 observable 是 `{getSnapshot, subscribe}` 的形状
 *
 * 卡片**不碰 ctx、不自己造订阅**(上游 `packages/client/AGENTS.md` 的纪律):
 * 值经 slot 的 `hooks` 隔间交给渲染层绑成选择器钩子。而那个隔间接受的正是
 * `HostObservable<Snapshot>` = `getSnapshot` + `subscribe` 这一对
 * (`packages/client/ui-slots/src/index.ts:499-505`)。
 *
 * ⚠️ `getSnapshot` 必须**返回同一个引用直到值真的变**(`useSyncExternalStore`
 * 的硬要求,否则无限重渲染)。两个值都是原始值,`Object.is` 天然满足。
 *
 * @see src/client/host-settings-card.ts —— 把这两个 observable 放进 `hooks` 隔间的地方
 * @module dsh-git/client/prefs-bus
 */

/** 一个只读 observable(与 `ui-slots` 的 `HostObservable` 同形,结构类型)。 */
export interface IPreferenceSource<T> {
  /** 当前值;同一引用直到值真的变。 */
  getSnapshot(): T;
  /** 订阅变更;返回退订函数。 */
  subscribe(listener: () => void): () => void;
}

/** 订阅者集合的通用实现:拷贝后再派发,一个监听者抛错不饿死其余。 */
function notify(listeners: ReadonlySet<() => void>, what: string): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (error) {
      console.warn(`[dsh-git] ${what} 的订阅者抛错:${String(error)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 界面缩放(px;0 = 跟随宿主)
// ---------------------------------------------------------------------------

/** 「跟随宿主」的取值(也是初值:升级后没有人会突然被改字号)。 */
export const FONT_SCALE_DEFAULT = 0;

/** 卡片接受的区间(与 `preferences-dialog.tsx` 里那个 `<input type=number>` 一致)。 */
export const FONT_SCALE_MAX = 24;

let fontScale: number = FONT_SCALE_DEFAULT;
const fontScaleListeners = new Set<() => void>();

/** 收敛到 `[0, 24]` 的整数;非有限数一律落回「跟随宿主」。 */
function clampFontScale(value: number): number {
  if (!Number.isFinite(value)) {
    return FONT_SCALE_DEFAULT;
  }
  return Math.min(FONT_SCALE_MAX, Math.max(0, Math.round(value)));
}

/** @returns 当前界面缩放(px);`0` = 跟随宿主。 */
export function getFontScale(): number {
  return fontScale;
}

/** 写入界面缩放;值按 {@link FONT_SCALE_MAX} 收敛,没变就不广播。 */
export function setFontScale(value: number): void {
  const next = clampFontScale(value);
  if (Object.is(next, fontScale)) {
    return;
  }
  fontScale = next;
  notify(fontScaleListeners, '界面缩放');
}

/**
 * 卡片的 `hooks` 隔间要的那个 observable。
 *
 * 刻意**不导出可变面**:写入口只有 {@link setFontScale},于是「谁改了字号」在
 * `grep` 里只有一处。
 */
export const fontScaleStore: IPreferenceSource<number> = {
  getSnapshot: getFontScale,
  subscribe: (listener: () => void) => {
    fontScaleListeners.add(listener);
    return () => { fontScaleListeners.delete(listener); };
  },
};

// ---------------------------------------------------------------------------
// 「显示类偏好变了」的计数器
// ---------------------------------------------------------------------------

/**
 * `WorkbenchApp` 根节点 `data-prefs-revision` 的对应物。
 *
 * 语义与 `preferences-dialog.tsx` 里传给弹窗的那个 `onPreferencesChanged` **逐字相同**:
 * 「某个**渲染时直读**的偏好(今天是无障碍页那两条)刚被写进去了,请让整棵树重读一次」。
 * 日期/时间/数字格式与首选编辑器是这样读的(`lib/format-date.ts` 每次调用都读偏好),
 * 而 localStorage 写入**不会**通知同页组件 —— 只写不重渲染 = 「设置看着改了、要刷新才变」。
 */
let preferencesRevision = 0;
const revisionListeners = new Set<() => void>();

/** @returns 已发出的偏好变更次数(探针据此判「写入真的触发了重渲染」)。 */
export function getPreferencesRevision(): number {
  return preferencesRevision;
}

/** 发一次「偏好变了」:计数器加一并广播。 */
export function bumpPreferencesRevision(): void {
  preferencesRevision += 1;
  notify(revisionListeners, '偏好变更计数器');
}

/** 订阅计数器(供将来的 `workbench.tsx` 用;今天没有消费方,见文件头)。 */
export function subscribePreferencesRevision(listener: () => void): () => void {
  revisionListeners.add(listener);
  return () => { revisionListeners.delete(listener); };
}
