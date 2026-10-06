/**
 * **宿主设置入口桥** —— 把顶栏齿轮接到**宿主自己的设置面板**上。
 *
 * ## 结论(先说最重要的一条):宿主**没有**可编程打开设置的服务
 *
 * 本轮把四条可能的通路全部查过,结论是**没有一条**能从一个第三方插件调用:
 *
 * | 候选 | 位置 | 为什么够不到 |
 * |---|---|---|
 * | client **Service** | —— | `ui-settings` / `ui-settings-general` / `ui-settings-plugins` / `ui-settings-shell` 四个包**一个服务都不 provide**(全仓 `provide(` 普查里没有任何 settings 面板相关服务;完整服务表见 `docs/host-settings-card.md` §1) |
 * | **command** | `ui-settings-general/src/client/index.ts:180-196` 注册 `settings.open` 快捷键命令,`run()` 直接调 `shellInstance.actions.open()` | `Shortcuts` 服务面(`packages/client/shortcuts/src/client/types.ts:83-140`)**没有** `invoke`/`run`;`ShortcutRegistry.invoke` 是私有的(`registry.ts:140`),只有 Desktop 原生菜单桥会调它(`native.ts:28`) |
 * | **slot** | `settings.launcher` 的 owner props 里有 `openSettings`(`ui-settings/src/client/contract/slots.ts:143-152`) | 该槽是 `kind:'single'`,已被 `ui-settings-account` 的 `AccountMenu` 占住(`ui-settings-account/src/client/index.ts:285`);`settings.trigger` 同样 single |
 * | **overlay / 事件** | —— | client 侧**没有** settings 相关事件;`settings/document-updated` 是**数据**变更,不是打开面板 |
 *
 * 唯一的真实入口是 `ui-settings-general/src/client/SettingsRoot.tsx` 里那个 `<button>`
 * (`:224-238` 的 fallback 触发按钮,`onClick={() => { actions.open() }}`)以及占住
 * `settings.launcher` 的 `AccountMenu`(`ui-settings-account/src/client/AccountMenu.tsx:63-86`,
 * 菜单项 `id:'settings'` 的 `onSelect` 调 `openSettings()`)。两者的 `actions.open()`
 * 都来自 `shell-store.ts` 的 `createSettingsShellStore()`,而那个实例活在
 * `ui-settings-general/src/client/index.ts:175-181` 的 `slots.inject('sidebar.settings', …)`
 * 闭包里,**不作为任何服务导出**。
 *
 * ## 所以这里怎么做(以及为什么这不是「伪造」)
 *
 * 本模块**只驱动宿主自己的控件**:点击宿主自己渲染的那个按钮 / 菜单项 ⇒ 走的是宿主
 * 自己的 `onClick` ⇒ 宿主自己的 `actions.open()`。**没有** iframe、**没有**重写宿主
 * 设置界面、**没有**复制宿主的设置状态。
 *
 * 判据(不依赖任何写死的本地化文案):宿主 `settings.open` 命令在
 * `ctx.shortcuts.catalog` 里的那一行(`{ id:'settings.open', keys, aria, … }`)。
 * 菜单项用同一个 `aria-keyshortcuts`(宿主自己写在 `AccountMenu` 的 item 上)或
 * `keys` 键帽文本命中 ⇒ **用户改键位之后这里跟着改**。
 *
 * 拿不到宿主控件时 `openHostSettings()` 返回 `'unavailable'`,调用方回退到自己的
 * 弹窗(现有行为),并且**只打印一次**有界诊断 —— 不会静默失败。
 *
 * ⚠️ 这是**权宜之计**,不是终局:正确修法是宿主暴露一个服务(或把 `settings.open`
 * 变成可调用的 command)。一旦宿主有了,这个文件的 DOM 部分应当整段删掉。
 * 决策与证据见 `docs/host-settings-card.md` §1。
 *
 * @see docs/host-settings-card.md —— 宿主设置入口的完整证据链与替代方案
 * @module dsh-git/client/host-settings-open
 */

/** 宿主 `settings.open` 命令在 catalog 里我们真正用到的三个成员(结构化类型,不 import 宿主)。 */
export interface IHostSettingsCommand {
  readonly id: string;
  /** 键帽文本(如 `['⌘', ',']`),用于菜单项文本匹配与 tooltip。 */
  readonly keys: readonly string[];
  /** 宿主自己的 `aria-keyshortcuts` 串,用于精确命中菜单项。 */
  readonly aria?: string | undefined;
}

/** cordis 的**可选**注入面(`inject` / `effect` 都可能缺席:profile 不同)。 */
export interface IHostSettingsCtx {
  inject?(deps: string[], callback: (injected: IHostSettingsInjectedCtx) => unknown): unknown;
  effect?(callback: () => (() => void) | void, label?: string): unknown;
}

/** `ctx.inject` 回调收到的派生上下文(与 `host-theme.ts` 同形)。 */
export interface IHostSettingsInjectedCtx {
  get(name: string): unknown;
}

/** 宿主 `shortcuts` 服务里我们真正用到的成员。 */
interface IShortcutsLike {
  readonly catalog?: {
    getSnapshot(): readonly {
      readonly id?: string;
      readonly keys?: readonly string[];
      readonly aria?: string | undefined;
    }[];
    subscribe(listener: () => void): () => void;
  };
}

/** `openHostSettings()` 的结果。 */
export type HostSettingsOpenResult =
  /** 已经开着(无需动手)。 */
  | 'already-open'
  /** 宿主设置面板已打开(由宿主自己的控件完成)。 */
  | 'opened'
  /** 找不到宿主控件;调用方应回退。 */
  | 'unavailable';

/** 宿主 `settings.open` 命令 id(逐字取自 `ui-settings-general/src/client/index.ts:181`)。 */
const HOST_SETTINGS_COMMAND_ID = 'settings.open';

/**
 * 宿主设置面板的**存在判据**:`SettingsRoot.tsx:70` 的
 * `data-shortcut-modal="settings"` + `role="dialog"`(面板 portal 到 `document.body`)。
 */
const SETTINGS_DIALOG_SELECTOR = '[data-shortcut-modal="settings"][role="dialog"]';

/** 当前已知的宿主命令行;`undefined` = 还没接上 `shortcuts`(不是「没有该命令」)。 */
let command: IHostSettingsCommand | undefined;
/** `shortcuts` 服务是否已接入。 */
let attached = false;
/** 有界诊断只打一次。 */
let diagnosed = false;

/** 出错只影响「打开设置」这一件事,不能影响插件其余部分。 */
function warnOnce(reason: string): void {
  if (diagnosed) {
    return;
  }
  diagnosed = true;
  console.info(
    `[dsh-git] 宿主设置入口:${reason};` +
    '齿轮将回退到 dsh-git 自己的弹窗。宿主目前没有可编程打开设置的服务,' +
    '详见 docs/host-settings-card.md §1。',
  );
}

/**
 * 接上宿主的 `shortcuts` 服务,只为了**读**它 catalog 里 `settings.open` 那一行
 * (宿主自己的键位真源)。拿不到就什么都不做 —— 上面那张表里已说明没有别的通路。
 * @param ctx - 浏览器插件上下文(只用到 `inject` / `effect`)。
 */
export function attachHostSettingsOpener(ctx: IHostSettingsCtx): void {
  if (typeof ctx.inject !== 'function') {
    warnOnce('ctx.inject 不可用');
    return;
  }
  try {
    ctx.inject(['shortcuts'], (injected) => {
      const shortcuts = injected.get('shortcuts') as IShortcutsLike | undefined;
      const catalog = shortcuts?.catalog;
      if (catalog === undefined || typeof catalog.getSnapshot !== 'function') {
        return undefined;
      }
      const read = (): void => {
        const row = catalog.getSnapshot().find((entry) => entry.id === HOST_SETTINGS_COMMAND_ID);
        command = row === undefined
          ? undefined
          : { id: HOST_SETTINGS_COMMAND_ID, keys: row.keys ?? [], aria: row.aria };
        attached = true;
      };
      const effect = ctx.effect;
      const bind = (): (() => void) | void => {
        read();
        const off = typeof catalog.subscribe === 'function' ? catalog.subscribe(read) : undefined;
        return () => {
          if (typeof off === 'function') {
            off();
          }
          command = undefined;
          attached = false;
        };
      };
      if (typeof effect === 'function') {
        effect(bind, 'dsh-git: host settings opener');
        return undefined;
      }
      bind();
      return undefined;
    });
  } catch (error) {
    warnOnce(`shortcuts 接不上(${String(error)})`);
  }
}

/**
 * 宿主自己那份 `settings.open` 命令行的只读投影(给 tooltip / 文案用)。
 * @returns 命令行的键帽文本;未接入或拿不到时为空数组。
 */
export function hostSettingsShortcutKeys(): readonly string[] {
  return command?.keys ?? [];
}

/**
 * 宿主 `settings.open` 命令是否已在 catalog 里看到(⇒ 宿主确实有设置面板)。
 * @returns 是否已看到。
 */
export function isHostSettingsAvailable(): boolean {
  return attached;
}

/**
 * 等 React 把一次点击引起的提交落到 DOM 上。
 *
 * ⚠️ **必须与计时器赛跑**:后台标签页里 `requestAnimationFrame` **不触发**,
 * 只等 rAF 会让 `openHostSettings()` 永远 pending ⇒ 齿轮点了没反应(回退分支
 * 也永远走不到)。所以这里 rAF 与 32ms 计时器取先到者,最坏情况也只是慢一帧。
 */
async function nextPaint(): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    };
    setTimeout(done, 32);
    if (typeof requestAnimationFrame !== 'function') {
      done();
      return;
    }
    requestAnimationFrame(() => { requestAnimationFrame(done); });
  });
}

/** 有界等待一个查询命中(默认 8 次 paint ≈ 130ms)。 */
async function waitFor<T>(probe: () => T | null, attempts = 8): Promise<T | null> {
  for (let index = 0; index < attempts; index += 1) {
    const found = probe();
    if (found !== null) {
      return found;
    }
    await nextPaint();
  }
  return null;
}

/** 宿主设置面板此刻是否已经开着。 */
function settingsDialogOpen(): boolean {
  return document.querySelector(SETTINGS_DIALOG_SELECTOR) !== null;
}

/**
 * `SettingsRoot.tsx:224-238` 的 fallback 触发按钮 —— 只有在**没有任何**占位者注册进
 * `settings.launcher` 时才渲染(本 profile 里被 `AccountMenu` 占住,所以通常找不到)。
 * @returns 是否点到了。
 */
function clickShellTrigger(): boolean {
  const button = document.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]');
  if (button === null) {
    return false;
  }
  button.click();
  return true;
}

/**
 * 在已打开的菜单里找**宿主自己的「设置」项**。
 *
 * 两个判据都来自宿主自己的运行时状态,不写死任何本地化文案:
 *  1. `aria-keyshortcuts` === 宿主 `settings.open` 的 `aria`(宿主写在
 *     `AccountMenu.tsx:76` 的 item 上,`Menu.tsx:461` 落到 DOM);
 *  2. 退一步:菜单项文本里含**全部**键帽(`Menu.tsx:475` 的 `ShortcutKeys`)。
 * @returns 命中的菜单项按钮;没有则 `null`。
 */
function findSettingsMenuItem(): HTMLButtonElement | null {
  const items = [...document.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]')];
  if (command?.aria !== undefined && command.aria !== '') {
    const byAria = items.find((item) => item.getAttribute('aria-keyshortcuts') === command?.aria);
    if (byAria !== undefined) {
      return byAria;
    }
  }
  const keys = command?.keys ?? [];
  if (keys.length > 0) {
    const byKeys = items.find((item) => {
      const text = item.textContent ?? '';
      return keys.every((key) => text.includes(key));
    });
    if (byKeys !== undefined) {
      return byKeys;
    }
  }
  return null;
}

/**
 * 走 `settings.launcher` 占位者(`AccountMenu`)那条路:先点开它的菜单,再点其中的「设置」。
 *
 * 候选触发器用 `button[aria-haspopup="menu"]` 枚举(**从后往前**:侧栏脚在文档序末尾),
 * 每个候选点开后**只在菜单里找宿主自己的设置项**;没找到就按 Esc 关掉再试下一个 ——
 * 绝不点任何我们无法归因的菜单项。
 * @returns 是否点到了宿主自己的设置项。
 */
async function clickLauncherSettingsItem(): Promise<boolean> {
  const triggers = [...document.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="menu"]')].reverse();
  for (const trigger of triggers) {
    trigger.click();
    /*
     * 先确认**这次点击真的开出了一个菜单**(宿主 `Menu` 的触发按钮带
     * `aria-expanded`,`AccountMenu.tsx:64` 就是这么写的)。没开出来就跳过 ——
     * 不去猜一个我们没认出来的控件里有什么。
     */
    const opened = await waitFor(
      () => (trigger.getAttribute('aria-expanded') === 'true' ? true : null),
      3,
    );
    if (opened === null) {
      continue;
    }
    const item = await waitFor(findSettingsMenuItem, 4);
    if (item !== null) {
      item.click();
      return true;
    }
    // 关掉我们刚点开的那个菜单(宿主 Menu 自己处理 Escape),再试下一个候选。
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await nextPaint();
  }
  // 兜底:一个候选都没命中时,别把菜单留在屏幕上。
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  return false;
}

/**
 * 打开**宿主自己的设置面板**(由宿主自己的控件完成)。
 *
 * 顺序:已开着 ⇒ 什么都不做;宿主 shell 的 fallback 触发按钮 ⇒ 点它;否则
 * `settings.launcher` 占位者的菜单 ⇒ 点它的「设置」项。两条都走不通返回
 * `'unavailable'`,由调用方回退。
 * @returns 见 {@link HostSettingsOpenResult}。
 */
export async function openHostSettings(): Promise<HostSettingsOpenResult> {
  if (typeof document === 'undefined') {
    return 'unavailable';
  }
  if (settingsDialogOpen()) {
    return 'already-open';
  }
  if (clickShellTrigger() && await waitFor(() => (settingsDialogOpen() ? true : null), 4) !== null) {
    return 'opened';
  }
  if (await clickLauncherSettingsItem()
    && await waitFor(() => (settingsDialogOpen() ? true : null), 4) !== null) {
    return 'opened';
  }
  warnOnce('没有找到宿主自己的设置入口控件');
  return 'unavailable';
}
