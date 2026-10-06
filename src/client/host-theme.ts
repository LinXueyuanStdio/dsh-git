/**
 * **宿主主题桥** —— 把 DSH 的 `theme` 服务接成我们这层能用的一个 Observable。
 *
 * ## 为什么需要它(以及为什么以前那个开关是「删掉」而不是「接线」)
 *
 * Preferences ▸ 外观 页的主题色板(Light / Dark / System)在 **DSH 里是宿主拥有的设置**:
 * `references/deepseek-harness/packages/client/ui-theme/src/client/index.ts:433` 的
 * `ctx.provide('theme', theme)` 提供 `ThemeRuntime`(`getTheme()` 返回不可变快照、
 * `setTheme(id)` 是**唯一**的偏好写入口、状态变化只在 `theme/change` 事件上发布),
 * 而且**宿主自己的设置里就有这一行**(同文件头注释:它把 Appearance row 注册进 General 段)。
 *
 * 上一轮我够不到这个服务(`ctx` 只在 `src/client/index.ts` 被捕获,而那个文件当时不在授权内),
 * 于是把主题分区**删掉**了(`pref-adapt.ts` 第 1 条)—— 那是正确但不理想的临时处置:
 * 现在 `index.ts` 授权到手,这里用 cordis 的**可选服务注入**
 * (`ctx.inject(['theme'], cb)`,与本仓 `uiWorkspace` / `configForms` 两处同一套路子)
 * 把它接起来:
 *
 * | 方向 | 用什么 | 证据 |
 * |---|---|---|
 * | 读回显 | `theme.getTheme().preference` | `ui-theme/src/client/index.ts` 的 `ThemeSnapshot.preference: 'light'\|'dark'\|'system'` |
 * | 写偏好 | `theme.setTheme(id)` | 同上:`setTheme` 是唯一写入口,未知 id 会抛 |
 * | 变化订阅 | `ctx.on('theme/change', …)` | 宿主自己的三个消费方都这么写:`ui-layout/src/client/index.ts:221`、`ui-sidebar-terminal/src/client/index.ts:83-84`、`ui-settings-account/src/client/index.ts:202-203` |
 *
 * **不硬依赖**:`export const inject` 里**不**加 `theme` —— 硬依赖会让本插件在没有该服务的
 * profile 里整个不激活(与 `index.ts` 里 `uiWorkspace` 那段注释立的规矩一致)。拿不到服务时
 * `isHostThemeAvailable()` 为假,弹窗给卡片挂 `gw-prefs-no-theme`,**把主题分区删掉**
 * (那条规则在 `src/client/scss/preferences.scss` 的适配块里)⇒ 永远不会出现
 * 「点了没反应」的可见控件。
 *
 * ## 与宿主皮肤的关系(红线)
 *
 * 这里**不碰任何 DOM、不写任何 CSS 变量**:只调用宿主自己的服务。真正把
 * `body[data-ds-dark-theme]` 与令牌切换的是宿主的 presenter(`ui-layout`)——
 * 我们只是它的一个**消费者**,与「把变量绑到宿主 `:root` 上」那条红线无关。
 *
 * @see src/client/scss/preferences.scss —— `gw-prefs-no-theme` 与其余适配规则的所在地
 * @see docs/preferences-port.md —— 这份弹窗的移植记录
 * @module dsh-git/client/host-theme
 */

import { useSyncExternalStore } from 'react';

/** 宿主 `ThemeSnapshot.preference` 的三个合法值(逐字取自 ui-theme 的类型)。 */
export type HostThemePreference = 'light' | 'dark' | 'system';

/** 宿主 `theme` 服务里我们真正用到的三个成员(结构化类型;不 import 宿主的类型)。 */
export interface IHostThemeService {
  /** 读当前不可变快照;我们只取 `preference`。 */
  getTheme(): { readonly preference: string };
  /** 切偏好;未知 id 会抛(宿主的行为,我们就让它抛给调用方)。 */
  setTheme(id: string): void;
}

/** cordis 的**可选**注入面(`inject` / `effect` 都可能缺席:profile 不同)。 */
export interface IThemeHostCtx {
  inject?(deps: string[], callback: (injected: IInjectedThemeCtx) => unknown): unknown;
  effect?(callback: () => (() => void) | void, label?: string): unknown;
}

/** `ctx.inject` 回调收到的那个派生上下文(与 `index.ts` 里 `uiWorkspace` 的用法同形)。 */
export interface IInjectedThemeCtx {
  get(name: string): unknown;
  on?(event: string, listener: (...args: unknown[]) => void): unknown;
}

/** `preference` 收敛:任何意外值都当 `system`(默认档)。 */
function normalizePreference(value: unknown): HostThemePreference {
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
}

let service: IHostThemeService | undefined;
let available = false;
let preference: HostThemePreference = 'system';
/**
 * 上一次**发布过**的可用性。
 *
 * 为什么要单独跟踪:弹窗用 `isHostThemeAvailable()` 决定是否渲染主题分区,而可用性是
 * `boolean`、不在 `getTheme()` 的快照里 ⇒ 只比 `preference` 的话,「服务接上但偏好本来就是
 * `system`」这条路径**不会通知任何人**,界面就会停在一个过期的判断上。所以这里把
 * 「(偏好, 可用性)」当成一个二元快照比较,任一变化都广播。
 */
let publishedAvailable = false;
const listeners = new Set<() => void>();

/** 通知所有订阅者(localStorage 那套事件在这里不适用:值住在宿主里)。 */
function publish(): void {
  const next = service === undefined ? 'system' : normalizePreference(service.getTheme().preference);
  if (next === preference && available === publishedAvailable) {
    return;
  }
  preference = next;
  publishedAvailable = available;
  for (const listener of [...listeners]) {
    listener();
  }
}

/**
 * 接上宿主的 `theme` 服务(由 `src/client/index.ts` 的 `apply()` 调用,**可选**)。
 *
 * 拿不到服务就什么都不做:调用方据此把主题分区删掉(`gw-prefs-no-theme`),
 * 而不是画一个点了没反应的色板。
 * @param ctx - 浏览器插件上下文(只用到 `inject` / `effect`)。
 */
export function attachHostTheme(ctx: IThemeHostCtx): void {
  if (typeof ctx.inject !== 'function') {
    return;
  }
  try {
    ctx.inject(['theme'], (injected) => {
      const candidate = injected.get('theme') as IHostThemeService | undefined;
      if (candidate === undefined || typeof candidate.getTheme !== 'function' || typeof candidate.setTheme !== 'function') {
        return undefined;
      }
      const effect = ctx.effect;
      const bind = (): (() => void) | void => {
        service = candidate;
        available = true;
        publish();
        /*
         * 订阅 `theme/change`:宿主**自己的**设置行改主题时,我们的色板必须回显。
         * 优先用注入上下文上的 `on`(它属于那个服务可达的作用域),退化到外层 ctx 的 `on`
         * —— 宿主里三个消费方都是 `ctx.on('theme/change', …)`,两种写法等价。
         */
        const onInjected = injected.on;
        const onOuter = (ctx as { on?: (event: string, listener: (...args: unknown[]) => void) => unknown }).on;
        const on = typeof onInjected === 'function' ? onInjected.bind(injected) : onOuter?.bind(ctx);
        const off = typeof on === 'function' ? on('theme/change', () => { publish(); }) : undefined;
        return () => {
          if (typeof off === 'function') {
            (off as () => void)();
          }
          service = undefined;
          available = false;
          preference = 'system';
          publish();
        };
      };
      // 与宿主设置卡片同一路子:副作用包在 `ctx.effect` 里,服务消失时清理干净。
      if (typeof effect === 'function') {
        effect(bind, 'dsh-git: host theme bridge');
        return undefined;
      }
      bind();
      return undefined;
    });
  } catch (error) {
    // 主题是附加能力:接不上必须只影响那个分区,不能影响插件其余部分。
    console.warn(`[dsh-git] 宿主主题服务未接入(theme 接不上):${String(error)}`);
  }
}

/** 宿主主题服务是否已接入(弹窗据此决定是否渲染主题分区)。 */
export function isHostThemeAvailable(): boolean {
  return available;
}

/** 当前偏好(非 React 读法)。 */
export function getHostThemePreference(): HostThemePreference {
  return preference;
}

/**
 * 写偏好(外观页色板 → 宿主)。
 *
 * @param next - `light` / `dark` / `system`。
 * @returns 是否真的写进去了(`false` = 服务未接入,调用方据此不假装成功)。
 */
export function setHostThemePreference(next: HostThemePreference): boolean {
  if (service === undefined) {
    return false;
  }
  service.setTheme(next);
  // 宿主是异步落盘 + 事件回显;这里立刻同步一次,避免控件在事件到达前短暂回跳。
  publish();
  return true;
}

/** 订阅偏好变化(给 `useSyncExternalStore` 用)。 */
export function subscribeHostTheme(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => { listeners.delete(onChange); };
}

/** React 读法:偏好(`getSnapshot` 是字符串原语,不会触发快照引用不稳的死循环)。 */
export function useHostThemePreference(): HostThemePreference {
  return useSyncExternalStore(subscribeHostTheme, getHostThemePreference, () => 'system');
}
