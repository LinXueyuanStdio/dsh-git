/**
 * dsh-git 从**宿主设置**读回来的那几个值 —— 读侧投影(卡片之外的消费方用)。
 *
 * ## 为什么需要这个文件
 *
 * 设置卡片(`./host-settings-card.ts`)自己读写表单;但同一个值还有**别的消费方** ——
 * `src/client/pulls-view.tsx` 的自动刷新定时器要拿到 `autoSec`。而组件**不碰 ctx**
 * (上游 `packages/client/AGENTS.md` 的 ctx 纪律),`ctx` 只在 `apply` 世界里;
 * 把值一路当 prop 传下去要经过 `workbench.tsx`(另一条线持有),不做。
 *
 * 所以这里是**一条从宿主表单快照到组件 hook 的单向投影**:
 *
 * ```
 * 宿主 settings.describe()  ──>  ctx.configForms.get('dsh-git')  ──>  本模块的只读投影  ──>  useAutoRefreshSec()
 *    (profile patch 的真源)            (ConfigForm 快照)                (单一真源的一份视图)      (组件)
 * ```
 *
 * ## 三条纪律
 *
 * 1. **单一真源是宿主的配置文档**(最终落进 profile 的 `cordis.patch.yml`)。本模块
 *    **不存值、不写值、不做 localStorage 镜像** —— 它只是真源的一份只读投影。
 *    镜像会重现「一个值两个真源」,那正是 `docs/plugin-settings.md` §6 警告的形态;
 * 2. **快照引用稳定**:`autoSec` 是数字,`Object.is` 比较天然稳定,所以
 *    `useSyncExternalStore` 不会因为「每次返回新对象」而空转重渲染;
 * 3. **宿主没服务该命名空间(或首次 describe 还没到)时回落到 `0` = 关闭**
 *    —— 与 schema 默认值(`default(0)`)一致,于是**升级时没有人会突然开始轮询**。
 *
 * @see src/client/host-settings-card.ts —— 同一命名空间的卡片(读写那一侧)
 * @module dsh-git/client/host-settings
 */

import { useSyncExternalStore } from 'react';
import type { SettingsFormScope } from '@deepseek-ai/dsh-client-ui-primitives';

/** 自动刷新的关闭值(也是 schema 的默认值:0 = 关)。 */
export const AUTO_REFRESH_OFF = 0;

/** 本插件读回来的设置切片 —— 与 host 半 `src/index.ts` 的 `Config` 对应。 */
export interface IHostSettingsSlice {
  /** Pulls 页签的自动刷新周期(秒);`0` = 关闭。 */
  readonly autoSec?: number;
}

/** 当前生效的自动刷新周期(秒);宿主未服务 / 尚未就绪时为 `AUTO_REFRESH_OFF`。 */
let autoSec: number = AUTO_REFRESH_OFF;
/** 订阅者(组件的 `useSyncExternalStore`)。 */
const listeners = new Set<() => void>();
/** 当前那次绑定的退订函数;重复绑定会先把上一次收掉(不留双份订阅)。 */
let activeUnbind: (() => void) | undefined;

/** 广播一次变更。拷贝后再派发,一个监听者抛错不会饿死其余。 */
function notify(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (error) {
      console.warn(`[dsh-git] 自动刷新订阅者抛错:${String(error)}`);
    }
  }
}

/** 写入投影值;值没变就不广播(避免无意义的重渲染)。 */
function publish(next: number): void {
  if (Object.is(next, autoSec)) {
    return;
  }
  autoSec = next;
  notify();
}

/**
 * 从宿主表单快照读一次当前值。
 *
 * `value` 是**已按 schema 解析**的那一节(用户层叠在组合层与默认值之上,
 * `SettingsForms.describe()` 的 `value = projectForm(form, plainConfig(fiber.config))`),
 * 所以字段缺失只可能是「快照还没就绪」,不是「用户没设」—— 两种都回落成关闭。
 * @param scope - `dsh-git` 命名空间的宿主表单面。
 * @returns 自动刷新周期(秒);不可读时为 `AUTO_REFRESH_OFF`。
 */
function readFromHost(scope: SettingsFormScope<IHostSettingsSlice>): number {
  const snapshot = scope.getSnapshot();
  if (snapshot.status !== 'ready') {
    return AUTO_REFRESH_OFF;
  }
  const raw = snapshot.value?.autoSec;
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : AUTO_REFRESH_OFF;
}

/**
 * 把宿主的设置快照接到本模块的投影上。
 *
 * 每次变化都重读整份快照;退订时把投影复位成 `AUTO_REFRESH_OFF`,于是宿主停止服务
 * 这个命名空间之后,**轮询不会带着旧周期继续跑**。
 * @param scope - `dsh-git` 命名空间的宿主表单面(`ctx.configForms.get('dsh-git')`)。
 * @returns 退订并把投影复位成关闭。
 */
export function bindAutoRefreshFromHost(scope: SettingsFormScope<IHostSettingsSlice>): () => void {
  activeUnbind?.();
  const sync = (): void => { publish(readFromHost(scope)); };
  const unsubscribe = scope.subscribe(sync);
  sync();
  const unbind = (): void => {
    unsubscribe();
    if (activeUnbind === unbind) {
      activeUnbind = undefined;
      publish(AUTO_REFRESH_OFF);
    }
  };
  activeUnbind = unbind;
  return unbind;
}

/** @returns 当前生效的自动刷新周期(秒);`0` = 关闭。 */
export function getAutoRefreshSec(): number {
  return autoSec;
}

/**
 * 订阅自动刷新周期的变化。
 * @param listener - 变更回调。
 * @returns 退订函数。
 */
export function subscribeAutoRefresh(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * 读自动刷新周期的 React 钩子。
 *
 * 服务端/首帧回退值与 `getAutoRefreshSec()` 的初值同为关闭,所以水合不会闪。
 * @returns 自动刷新周期(秒);`0` = 关闭。
 */
export function useAutoRefreshSec(): number {
  return useSyncExternalStore(subscribeAutoRefresh, getAutoRefreshSec, () => AUTO_REFRESH_OFF);
}
