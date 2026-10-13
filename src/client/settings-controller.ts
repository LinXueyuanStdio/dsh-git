/**
 * dsh-git 在**宿主插件页**里的设置面 —— client 半的 controller(渲染层在 `./settings-page.tsx`)。
 *
 * ## 这是什么、为什么要有
 *
 * DSH 的插件设置是**两半**的机制(`docs/plugin-settings.md` §1):
 *  - **host 半**:插件 `export const Config`(schemastery),标 `.volatile()` 的字段
 *    被 `SettingsForms.describe()` 投影成表单 —— 见 `src/index.ts`;
 *  - **client 半**:插件把一页设置注册进**「插件」页**的 `plugins.bundle.config` 席位
 *    (keyed,key = bundle 包名 `@linxueyuan/dsh-git`),页面读写那块命名空间的表单值。
 *
 * ⚠️ 席位在 2026-10 迁过两次:`plugins.item`(渲染在「插件」页的**官方**组)→ 再补
 * `settings.plugins.tab`(设置 ▸ 内置插件的页签)→ 只留 `plugins.bundle.config`
 * (bundle 详情页)。理由与判据见 `docs/plugin-settings-seat-migration-plan.md`。
 *
 * ⚠️ 2026-10-13 第三次变化:那一页**不再复用** GitHub Desktop 的 Preferences 页面
 * (`preferences-pages.tsx` 的 `PreferencesPageBody`),改成 DSH 宿主风格的行列表
 * (`./settings-page.tsx`)。⇒ 本控制器随之瘦身:它**不再**提供仓库清单 / 登录态那份
 * 数据面(`pages` / `hooks.dshGitSnapshot` / `bootstrapCardStore` 全部删除)——
 * 那些数据今天只有弹窗(账号页 / Git 页)在读,而弹窗自己拿 store。
 *
 * ⚠️ 2026-10-13 同日改名:`host-settings-card.ts` → **`settings-controller.ts`**
 * (那一页已经不是「card」),符号里的 `Card` 一并去掉;原先住在这里的
 * 「宿主 `auth/state` → 外壳登录态形状」那个收窄点搬到了消费方一侧
 * (`preferences-pages.tsx` 的 `hostAuthOf()`,与 `PreferencesAuth` 同一文件)。
 *
 * ## 三条不许越的线(上游 `packages/client/AGENTS.md` 与客户端纯度闸门)
 *
 * 1. **跨插件协作走服务,不 value-import**。所以本文件对 `@deepseek-ai/*` 只有
 *    `import type`,编译后**全部擦除** —— `lib/client.js` 的 `require` 集合一条不多;
 * 2. **组件不碰 ctx**:ctx 只活在 `apply` 世界与注入面里,组件拿的是这里的 `inject()` 面;
 * 3. **业务组件不自己造订阅**:`SettingsFormModel.bind()` 产出的裸快照走 slot 的
 *    `hooks` 隔间,由渲染层绑成 `useDshGitSettings` —— 组件里没有 `useSyncExternalStore`。
 *
 * @module dsh-git/client/settings-controller
 */

import {
  SettingsFormModel, settingsNumberField,
  type SettingsFieldState, type SettingsFormActions, type SettingsFormScope, type SettingsFormShell,
} from '@deepseek-ai/dsh-client-ui-primitives';
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store';
import type { Translate } from './i18n.ts';
import type { AuthStatePayload } from './api.ts';
import { fontScaleStore, setFontScale, type IPreferenceSource } from './prefs-bus.ts';

/**
 * 本插件在宿主设置里的**命名空间**。
 *
 * 它是宿主 Loader 条目的 `options.id`,也就是 `Config.listConfigs` 报的 `patchId` ——
 * **不是** `include:dsh-git` 那个完整 id:`SettingsForms.describe()` 写的是
 * `ns: entry.options.id`(`packages/settings/settings/src/index.ts:315,326`)。
 * 实测佐证:本机 profile 里 `include:agent-loop`(`patchId: agent-loop`)对应客户端
 * `ui-settings-agent-loop` 的 `AGENT_LOOP_NS = 'agent-loop'`;
 * `include:bash-sandbox` 对应 `BASH_NS = 'bash-sandbox'`;`include:subagent` 对应
 * `SUBAGENT_NS = 'subagent'`。
 *
 * ⚠️ 它与 `i18n.ts` 的 `LOCALE_NS` **取值相同、含义不同**:那一个是语言服务的命名空间。
 */
export const DSH_GIT_NS = 'dsh-git';

/**
 * 宿主设置表单服务(`ctx.configForms`)的最小面。
 *
 * 上游是 cordis Service(`packages/client/ui-settings/src/client/config-form.ts:241` 的
 * `super(ctx, 'configForms')`),`get()` 返回一个实现 `SettingsFormScope` 的
 * `ConfigForm<T>`(`:293`)。这里只声明**这一页真正用到的那一面**(与 `src/client/types.ts`
 * 里 `SidebarRightTabsLike` 同一手法):跨插件协作走**服务**,不做 value import。
 *
 * 刻意**声明在本文件而不是 `types.ts`**:它是这一页设置自己的依赖面,放进 `ClientCtx`
 * 会同时多出两条 lint 违规(`naming-convention` + `member-ordering`),而本仓不允许
 * 「新增违规」。服务是经 `ctx.inject(['configForms'], …)` 拿到的,`ClientCtx` 不需要它。
 */
export interface IConfigFormsLike {
  /**
   * 取某个宿主插件条目的共享表单。
   * @param entryId - 宿主 Loader 条目的 `options.id`(即 `Config.listConfigs` 的 `patchId`)。
   */
  get<T>(entryId: string): SettingsFormScope<T>;
  /**
   * 只在宿主真的服务了其中某个命名空间时注册,否则一点痕迹都不留。
   * @param namespaces - 这个注册跟随的命名空间。
   * @param register - 安装贡献并返回其 disposer。
   */
  whileServed(namespaces: readonly string[], register: (served: ReadonlySet<string>) => () => void): () => void;
}

/**
 * 这一页设置编辑的字段 —— 宿主 `Config` 里那几个 volatile 字段的**子集**。
 *
 * 与 host 半 `src/index.ts` 的 `Config` 同源不同层:那边是 schema(真身),
 * 这里是「本页面承认编辑哪些」的声明。两边都有 `autoSec`。
 *
 * 接口名带 `I` 前缀:本仓 `@typescript-eslint/naming-convention` 要求接口名匹配
 * `/^I[A-Z]/`,而「新增违规」会被 `scripts/check-lint.mjs` 的棘轮拦住。
 */
export interface IDshGitSettings {
  /** Pulls 页签的自动刷新周期(秒);`0` = 关闭。 */
  readonly autoSec?: number;
}

/**
 * 【账号】组要的那一面 store(结构化类型,不是 `GitStore` 的别名)。
 *
 * 只声明**真正用到的**成员(与 `IPreferencesStore` 同一手法:窄接口让「谁改了这几个方法」
 * 立刻在编译期报错)。真身是 `src/client/store.ts` 的 `GitStore` ——
 * 它在 `index.ts` 里被传进来,而那张类型不需要认识整个 store。
 *
 * ⚠️ `subscribe` / `snapshot` 是**登录态的读面**:设置页要跟着别处的登录/登出一起变
 * (设备码轮询成功、弹窗里登录),所以不能只在挂载时拍一张快照。
 */
export interface IDshGitSettingsStoreLike {
  /** 订阅 store 的变化。 */
  subscribe(listener: () => void): () => void;
  /** 当前快照(**同一引用必须一直返回到真的变了** —— `useSyncExternalStore` 的硬要求)。 */
  snapshot(): { readonly auth: AuthStatePayload | null };
  /** 读一次登录态(`auth/state` 路由)。 */
  loadAuth(): Promise<void>;
  /** 登录成功后写入登录态。 */
  setAuth(state: AuthStatePayload): void;
  /** 刷新远端仓库清单。 */
  loadRemoteRepos(force?: boolean): Promise<void>;
  /** 轻提示。 */
  toast(message: string, kind?: 'ok' | 'err'): void;
  /** 退出登录。 */
  logout(): Promise<void>;
}

/** 这一页渲染的宿主表单状态。 */
export interface IDshGitSettingsState extends SettingsFormShell {
  /** Pulls 自动刷新周期(秒)。 */
  readonly autoSec: SettingsFieldState;
}

/**
 * 组件上那个泛型选择器钩子的**具名类型**。
 *
 * 为什么非要具名:带泛型的**函数类型签名**写在 `.tsx` 里会被
 * `scripts/build.mjs` 的 `checkJsxIdentifiers` 当成一个 JSX 标签(它的判据是
 * 「`<` 前面不是标识符字符」),于是构建失败。`.ts` 里的类型签名不受那条扫描影响
 * (它只扫 `.tsx`),所以这种签名一律住在 `.ts`(`DshGitSettingsProps` 头注释记的是同一条)。
 */
export type DshGitSettingsSelector = <S>(selector: (state: IDshGitSettingsState) => S) => S;

/**
 * `hooks.fontScaleValue` 由渲染层绑成的选择器钩子。
 *
 * 与 `useDshGitSettings` **同形不同源**:那个读宿主表单,这个读本插件自己的
 * `prefs-bus.ts`。两者都是 `HostObservable`(getSnapshot + subscribe),
 * 渲染层按同一个规则绑成 `use<Name>`
 * (`packages/client/ui-slots/src/index.ts:566-571` 的 `PropsHooks`)。
 */
export type DshGitFontScaleSelector = <S>(selector: (value: number) => S) => S;

/** 席位注入给设置页的那一面(宿主表单动作 + 偏好写动作 + 文案)。 */
export interface IDshGitSettingsFace extends SettingsFormActions {
  /**
   * **本插件的文案函数**(命名空间 `dsh-git`,见 `./i18n.ts` 的 {@link Translate})。
   *
   * 来自 `ctx.locale.bind(LOCALE_NS)` —— 那个函数**在调用时**读当前语言,
   * 所以语言切换后同一个引用照样给出新文案,席位不必重新注册
   * (`ui-slots/src/renderer.ts:24`)。形状与 dsh-context 的卡片一致(它把 `t` 放进 kit)。
   */
  readonly t: Translate;
  /**
   * 暂存 `autoSec` 的草稿文本。
   *
   * 与 `edit('autoSec', …)` 等价,单独给一个**具名成员**是为了让组件写成
   * `onEdit={props.editAutoSec}`:本仓的 `react/jsx-no-bind` 连**局部函数标识符**都拦
   * (默认 `allowFunctions: false`),而**成员表达式**不拦。所以回调在注入面上具名。
   */
  editAutoSec: (text: string) => void;
  /** 把 `autoSec` 复位到组合层默认值(等价于 `resetField('autoSec')`)。 */
  resetAutoSec: () => void;
  /** 写 `fontScale`(px;`0` = 跟随宿主)。 */
  readonly onFontScale: (value: number) => void;
  /**
   * 本插件的**全局 store** —— 给【账号】组用(读登录态、登录成功后 `setAuth` /
   * `loadRemoteRepos` / `toast`、退出登录)。
   *
   * ⚠️ 它**不是**仓库清单 / Changes 那条数据面(那份数据今天只有右侧栏与弹窗在读,
   * 走的是按 session 键的**另一颗** store)。设置页只用它做登录态与账号动作。
   */
  readonly store: IDshGitSettingsStoreLike;
  /**
   * **设置页那一侧的「偏好变了」**。
   *
   * 语义与弹窗的 `onPreferencesChanged` 逐字相同(「某个显示类偏好刚被写进去了,
   * 请重渲染」),实现是 `prefs-bus.ts` 的 `bumpPreferencesRevision()` ——
   * 设置页与 `WorkbenchApp` 是两棵树,这里**拿不到**后者的 revision state。
   */
  readonly onPreferencesChanged: () => void;
  readonly hooks: {
    /** 渲染层绑成 `useDshGitSettings` 的宿主表单快照。 */
    readonly dshGitSettings: SnapshotStore<IDshGitSettingsState>;
    /**
     * 渲染层绑成 `useFontScaleValue` 的字号 observable。
     *
     * 名字带 `Value` 是刻意的:`useFontScale` 会与本文件里那个**写**回调
     * (`onFontScale`)在调用点看起来像一对「读 / 写」,而它们其实是
     * 「选择器钩子 / 普通回调」两种不同的东西。
     */
    readonly fontScaleValue: IPreferenceSource<number>;
  };
}

/**
 * 渲染层绑给设置页的完整 prop 面:注入面 + 页面要的视图 + 由 `hooks` 合成的选择器钩子。
 *
 * 刻意声明在**本文件(.ts)而不是组件文件(.tsx)**:带泛型的选择器签名
 * `<S>(selector) => S` 在 `.tsx` 里会被 `scripts/build.mjs` 的 `checkJsxIdentifiers`
 * 当成一个 JSX 标签 `<S>`,于是构建失败。
 */
export type DshGitSettingsProps = IDshGitSettingsFace & {
  /**
   * 页面要的是哪一种视图。
   *
   * ⚠️ 只可能是 `'page'`:`plugins.bundle.config` 的契约逐字写「`view: 'page'` only」
   * (`ui-plugin-manager/src/client/slot-contract.ts:103-107`),页面自己画标题/图标/面包屑。
   */
  readonly view?: 'summary' | 'page';
  /** `hooks.dshGitSettings` 由渲染层绑成的选择器钩子。 */
  readonly useDshGitSettings: DshGitSettingsSelector;
  /** `hooks.fontScaleValue` 由渲染层绑成的选择器钩子。 */
  readonly useFontScaleValue: DshGitFontScaleSelector;
};

/** 把 `dsh-git` 命名空间的那块表单桥到本页面的暂存表单上。 */
export class DshGitSettingsController {
  private readonly form: SettingsFormModel<IDshGitSettings>;
  private readonly store: SnapshotStore<IDshGitSettingsState>;
  /** 设置页那一侧的「偏好变了」;缺省时为 `undefined`(见构造函数)。 */
  private readonly onPreferencesChanged: (() => void) | undefined;
  /** 文案函数(命名空间 `dsh-git`)。 */
  private readonly t: Translate;
  /**
   * 全局 store(见 {@link IDshGitSettingsFace.store})。
   *
   * ⚠️ 名字带 `Account` 是为了与上面那个 `store`(**表单模型绑出来的快照**)区分开 ——
   * 两个都叫 store 会撞在一起(实测 TS2300)。
   */
  private readonly accountStore: IDshGitSettingsStoreLike;
  /** 注入面的**唯一**实例(`inject()` 的返回值;见那里的注释)。 */
  private face: IDshGitSettingsFace | undefined;

  /**
   * @param scope - `dsh-git` 命名空间绑定的设置表单面。
   * @param onPreferencesChanged - 设置页那一侧的「偏好变了」回调。
   * @param t - 文案函数(命名空间 `dsh-git`);见 {@link IDshGitSettingsFace.t}。
   * @param store - 全局 store;见 {@link IDshGitSettingsFace.store}。
   */
  public constructor(
    scope: SettingsFormScope<IDshGitSettings>,
    onPreferencesChanged: (() => void) | undefined,
    t: Translate,
    store: IDshGitSettingsStoreLike,
  ) {
    this.form = new SettingsFormModel(scope, [settingsNumberField('autoSec')]);
    this.store = this.form.bind(() => this.projection());
    this.onPreferencesChanged = onPreferencesChanged;
    this.t = t;
    this.accountStore = store;
  }

  private projection(): IDshGitSettingsState {
    return { ...this.form.shell(), autoSec: this.form.field('autoSec') };
  }

  /**
   * 造出席位要注入的那一面(**同一个实例,只造一次**)。
   *
   * ⚠️ 为什么要缓存:宿主 `ui-renderer` 的 `cachedSlotInject()` 用**对象身份**做
   * `WeakMap` 键(`packages/client/ui-renderer/src/client/scoped-slots.tsx:208-220`),
   * 同一个 face 每次渲染都新建会让那份缓存次次落空(每次都重新绑一遍钩子)。
   * 返回**同一个冻结对象**也让「这个面一成不变」成为可断言的事实。
   *
   * @returns 宿主表单快照、字号的 observable 与写动作。
   */
  public inject(): IDshGitSettingsFace {
    if (this.face !== undefined) {
      return this.face;
    }
    const actions = this.form.actions();
    this.face = {
      ...actions,
      t: this.t,
      editAutoSec: (text: string) => { actions.edit('autoSec', text); },
      resetAutoSec: () => { actions.resetField('autoSec'); },
      onFontScale: (value: number) => { setFontScale(value); },
      onPreferencesChanged: this.onPreferencesChanged ?? (() => { /* 没有发送点:什么都不做 */ }),
      store: this.accountStore,
      hooks: {
        dshGitSettings: this.store,
        fontScaleValue: fontScaleStore,
      },
    };
    return this.face;
  }

  /** 释放已接受值的订阅。 */
  public dispose(): void { this.form.dispose(); }
}

