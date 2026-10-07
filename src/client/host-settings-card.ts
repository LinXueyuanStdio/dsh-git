/**
 * dsh-git 在**宿主设置**里的那张卡片 —— client 半的 controller。
 *
 * ## 这是什么、为什么要有
 *
 * DSH 的插件设置是**两半**的机制(`docs/plugin-settings.md` §1):
 *  - **host 半**:插件 `export const Config`(schemastery),标 `.volatile()` 的字段
 *    被 `SettingsForms.describe()` 投影成表单 —— 见 `src/index.ts`;
 *  - **client 半**:插件把一张卡片注册进**设置 ▸ 插件**的 `plugins.item` 席位,
 *    卡片读写那块命名空间的表单值。
 *
 * 只有 host 半 ⇒ 值可编辑但没有任何页面渲染它(宿主 README 明说
 * 「no shipped client does so yet」,`packages/settings/settings/README.md:39`);
 * 只有 client 半 ⇒ 有页面但没有可编辑的东西。**两半都做**才叫「进了宿主设置」。
 *
 * 形状逐字照 `packages/client/ui-settings-agent-loop/src/client/`:
 *  - `agent-loop-card-controller.ts`(本文件)
 *  - `index.ts`(注册;见 `src/client/index.ts`)
 *  - `AgentLoopCard.tsx`(渲染;见 `./host-settings-card.tsx`)
 *
 * ## 三条不许越的线(上游 `packages/client/AGENTS.md` 与客户端纯度闸门)
 *
 * 1. **跨插件协作走服务,不 value-import**。所以本文件对 `@deepseek-ai/*` 只有
 *    `import type`,编译后**全部擦除** —— `lib/client.js` 的 `require` 集合一条不多;
 * 2. **组件不碰 ctx**:ctx 只活在 `apply` 世界与注入面里,组件拿的是这里的 `inject()` 面;
 * 3. **业务组件不自己造订阅**:`SettingsFormModel.bind()` 产出的裸快照走 slot 的
 *    `hooks` 隔间,由渲染层绑成 `useDshGitSettings` —— 组件里没有 `useSyncExternalStore`。
 *
 * @module dsh-git/client/host-settings-card
 */

import {
  SettingsFormModel, settingsNumberField,
  type SettingsFieldState, type SettingsFormActions, type SettingsFormScope, type SettingsFormShell,
} from '@deepseek-ai/dsh-client-ui-primitives';
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store';
import { waitForRoutes, type AuthStatePayload } from './api.ts';
import { fontScaleStore, setFontScale, type IPreferenceSource } from './prefs-bus.ts';
import {
  startDeviceSignIn,
  type IDeviceCodeStart, type IPreferencesSnapshot, type IPreferencesStore,
} from './preferences-pages.tsx';

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
 */
export const DSH_GIT_NS = 'dsh-git';

/**
 * 宿主设置表单服务(`ctx.configForms`)的最小面。
 *
 * 上游是 cordis Service(`packages/client/ui-settings/src/client/config-form.ts:241` 的
 * `super(ctx, 'configForms')`),`get()` 返回一个实现 `SettingsFormScope` 的
 * `ConfigForm<T>`(`:293`)。这里只声明**卡片真正用到的那一面**(与 `src/client/types.ts`
 * 里 `SidebarRightTabsLike` 同一手法):跨插件协作走**服务**,不做 value import。
 *
 * 刻意**声明在本文件而不是 `types.ts`**:它是这一张卡片自己的依赖面,放进 `ClientCtx`
 * 会同时多出两条 lint 违规(`naming-convention` + `member-ordering`),而本仓不允许
 * 「新增违规」。服务是经 `ctx.inject(['configForms'], …)` 拿到的,`ClientCtx` 不需要它。
 */
export interface IConfigFormsLike {
  /**
   * 取某个宿主插件条目的共享表单。
   * @param entryId - 宿主 Loader 条目的 `options.id`(即 `Config.listConfigs` 的 `patchId`)。
   *        命名空间一律是 patchId,而不是 `include:<patchId>`:`SettingsForms.describe()`
   *        写的是 `ns: entry.options.id`(`packages/settings/settings/src/index.ts:315,326`),
   *        本机实测三方佐证 —— `include:agent-loop`↔`AGENT_LOOP_NS='agent-loop'`、
   *        `include:bash-sandbox`↔`BASH_NS='bash-sandbox'`、`include:subagent`↔`SUBAGENT_NS='subagent'`。
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
 * 这张卡片编辑的字段 —— 宿主 `Config` 里那几个 volatile 字段的**子集**。
 *
 * 与 host 半 `src/index.ts` 的 `Config` 同源不同层:那边是 schema(真身),
 * 这里是「本页面承认编辑哪些」的声明。两边都有 `autoSec`。
 *
 * 三个接口名带 `I` 前缀(上游 `agent-loop-card-controller.ts` 写的是不带前缀的
 * `AgentLoopSettings` / `AgentLoopCardState` / `AgentLoopCardFace`):本仓
 * `@typescript-eslint/naming-convention` 要求接口名匹配 `/^I[A-Z]/`,而
 * 「新增违规」会被 `scripts/check-lint.mjs` 的棘轮拦住。前缀是本仓规矩,不是上游契约。
 */
export interface IDshGitSettings {
  /** Pulls 页签的自动刷新周期(秒);`0` = 关闭。 */
  readonly autoSec?: number;
}

/** 这张卡片渲染的状态。 */
export interface IDshGitCardState extends SettingsFormShell {
  /** Pulls 自动刷新周期(秒)。 */
  readonly autoSec: SettingsFieldState;
}

/**
 * 卡片里「谁登录了」的最小形状(账号页)。
 *
 * 与 `preferences-pages.tsx` 的 `PreferencesAuth` 结构兼容(多了可缺省的 `endpoint`)。
 * 单独具名是为了让 {@link IDshGitCardLiveView} 与静态回退面共用同一份契约。
 */
export interface IDshGitCardAuth {
  readonly login: string;
  readonly tokenTail: string;
  /** 该账号的 GitHub API 基址;缺省 = 未知(老 host / 静态回退面)。 */
  readonly endpoint?: string;
}

/**
 * 卡片要读的 **live store 面**(结构化类型,不是 `GitStore` 的别名)。
 *
 * ## 2026-10:这个接口从「声明了但没人用」变成承重件
 *
 * 它原先**只被声明、零引用**(`grep -rn IDshGitCardStoreLike src/` 只有定义行),
 * 而真正喂给卡片的是 `pages.snap` / `pages.auth` 两个**普通值**。于是
 * `src/client/index.ts` 里那句 `snap: globalStore.snapshot()` 把
 * **注册那一瞬间**的快照冻进了卡片:注册发生在 `apply()` 期间(`WorkbenchApp`
 * 都还没挂载),那份快照里 `repos: []`、`auth: null`;而卡片**没有任何订阅** ⇒
 * 仓库清单永远是空的、账号页永远显示未登录、点「添加 / 切换 / 移除」界面不动。
 *
 * 实测(`docs/probes/host-settings-card-live-probe.mjs`,改前):
 * 「仓库」面板 = 「…还没有仓库。…」、「账号」面板里没有 `auth/state` 报的登录名,
 * 而卡片自己打过的路由**只有 2 条**(`config-get` / `config-file-info`)——
 * 连 `repos` / `auth/state` 都没请求过。
 */
export interface IDshGitCardStoreLike {
  /** 订阅快照变化。 */
  subscribe(listener: () => void): () => void;
  /**
   * 当前快照;**同一个引用必须一直返回到真的变了**
   * (`useSyncExternalStore` 的硬要求:`getSnapshot` 每次现造新对象 ⇒ 无限重渲染)。
   */
  snapshot(): IDshGitCardStoreSnapshot;
}

/** {@link IDshGitCardStoreLike} 的一份快照:卡片读的那几个字段。 */
export interface IDshGitCardStoreSnapshot extends IPreferencesSnapshot {
  /** 登录态;`null` = 还没读到 / 未登录(由 {@link cardAuthOf} 收窄)。 */
  readonly auth: AuthStatePayload | null;
}

/**
 * 卡片**实时**读的那份视图 —— 由 `hooks.dshGitSnapshot` 交给渲染层绑成
 * `useDshGitSnapshot`,组件在**每次 store emit** 时重读。
 */
export interface IDshGitCardLiveView {
  /** 登录态(账号页)。`null` = 未登录。 */
  readonly auth: IDshGitCardAuth | null;
  /** 「仓库」页签的数据源(仓库清单 + 当前仓库)。 */
  readonly snap: IPreferencesSnapshot;
}

/**
 * 三个页面的**数据与回调**注入面 —— 与 `IPreferencesDialogProps` 语义等价的那一半。
 *
 * 刻意**不**把 `store` 整个塞进来:卡片只用得到「读快照 + 那几个写动作」,
 * 而写动作(`selectRepo` / `logout` / …)已经在 `IPreferencesStore` 里声明过了,
 * 由 `preferences-pages.tsx` 拥有真源 —— 这里再声明一遍就是第二份契约。
 */
export interface IDshGitCardPagesFace {
  /** 登录态(账号页)。`null` = 未登录。**静态回退面**;`live` 存在时以 live 为准。 */
  readonly auth: IDshGitCardAuth | null;
  /** 「仓库」页签的数据源(仓库清单 + 当前仓库)。**静态回退面**;同上。 */
  readonly snap: IPreferencesSnapshot;
  /** 「仓库」页签 + 账号页要的那几条 store 动作(`preferences-pages.tsx` 的类型)。 */
  readonly store: IPreferencesStore;
  /**
   * **可选**:实时数据源。
   *
   * - 给了(真实席位 `src/client/index.ts` 给的是本插件的全局 `GitStore`)⇒
   *   卡片订阅它,仓库清单 / 登录态 / 写动作的后果都**当场**反映到界面;
   * - 不给(探针夹具 / 旧调用点)⇒ 退回上面那两个静态字段,逐字保持改动前的行为。
   *
   * 为什么用「可选 + 回退」而不是直接换掉 `auth`/`snap`:那是给已经存在的调用点
   * (含 `docs/probes/host-settings-card-driver.tsx`,那份夹具不允许改)留的兼容面。
   */
  readonly live?: IDshGitCardStoreLike;
}

/**
 * 卡片组件上那个泛型选择器钩子的**具名类型**。
 *
 * 为什么非要具名:带泛型的**函数类型签名**写在 `.tsx` 里会被
 * `scripts/build.mjs` 的 `checkJsxIdentifiers` 当成一个 JSX 标签(它的判据是
 * 「`<` 前面不是标识符字符」),于是构建失败。`.ts` 里的类型签名不受那条扫描影响
 * (它只扫 `.tsx`),所以这种签名一律住在 `.ts`(`DshGitCardProps` 头注释记的是同一条)。
 */
export type DshGitCardSelector = <S>(selector: (state: IDshGitCardState) => S) => S;

/**
 * `hooks.fontScaleValue` 由渲染层绑成的选择器钩子。
 *
 * 与 `useDshGitSettings` **同形不同源**:那个读宿主表单,这个读本插件自己的
 * `prefs-bus.ts`。两者都是 `HostObservable`(getSnapshot + subscribe),
 * 渲染层按同一个规则绑成 `use<Name>`
 * (`packages/client/ui-slots/src/index.ts:566-571` 的 `PropsHooks`)。
 */
export type DshGitFontScaleSelector = <S>(selector: (value: number) => S) => S;

/**
 * `hooks.dshGitSnapshot` 由渲染层绑成的选择器钩子(卡片读的**实时**数据面)。
 *
 * 为什么必须是选择器钩子而不是把快照当 prop:`pages.snap` 是**普通值**,一旦传进来
 * 就与 store 脱钩;只有走 slot 的 `hooks` 隔间,宿主渲染层才会把它绑成
 * `useSyncExternalStore` 订阅,store 每次 `emit` 都让卡片重渲染。
 */
export type DshGitSnapshotSelector = <S>(selector: (view: IDshGitCardLiveView) => S) => S;

/** 卡片席位注入给组件的那一面(快照 + 写动作)。 */
export interface IDshGitCardFace extends SettingsFormActions {
  /**
   * 暂存 `autoSec` 的草稿文本。
   *
   * 与 `edit('autoSec', …)` 等价,单独给一个**具名成员**是为了让组件写成
   * `onEdit={props.editAutoSec}`:本仓的 `react/jsx-no-bind` 连**局部函数标识符**都拦
   * (默认 `allowFunctions: false`),而**成员表达式**不拦(`src/client/host-modal.tsx:130`
   * 的 `onClose={props.onClose}` 就是同一手法)。所以回调在注入面上具名,不在组件里就地造。
   */
  editAutoSec: (text: string) => void;
  /** 把 `autoSec` 复位到组合层默认值(等价于 `resetField('autoSec')`)。 */
  resetAutoSec: () => void;
  /** 写 `fontScale`(px;`0` = 跟随宿主)。 */
  readonly onFontScale: (value: number) => void;
  /**
   * **卡片那一侧的「偏好变了」**。
   *
   * 语义与弹窗的 `onPreferencesChanged` 逐字相同(「某个显示类偏好刚被写进去了,
   * 请重渲染」),实现是 `prefs-bus.ts` 的 `bumpPreferencesRevision()` ——
   * 卡片与 `WorkbenchApp` 是两棵树,这里**拿不到**后者的 revision state。
   */
  readonly onPreferencesChanged: () => void;
  /** 退出登录(`store.logout()`)。 */
  readonly onLogout: () => void;
  /**
   * 「去要一个设备码」—— 实现是 `preferences-pages.tsx` 的 `startDeviceSignIn()`
   * (与弹窗**同一个函数**,不是两份拷贝)。
   *
   * 形状必须与 {@link StartDeviceSignIn} 逐字相同,否则 `PreferencesPageBody`
   * 那个 prop 接不上;这里复述签名而不是 import 那个类型,是因为它已经在
   * `preferences-pages.tsx` 里定义了,重复声明第二份就是这个仓库反复踩的
   * 「本地重声明与真身漂移」。
   */
  readonly onDeviceSignIn: (onStarted: (started: IDeviceCodeStart) => void) => void;
  /** 三个页面(账号 / 仓库 / 无障碍)要的数据与回调。 */
  readonly pages: IDshGitCardPagesFace;
  readonly hooks: {
    /** 渲染层绑成 `useDshGitSettings` 的页面快照。 */
    readonly dshGitSettings: SnapshotStore<IDshGitCardState>;
    /**
     * 渲染层绑成 `useFontScaleValue` 的字号 observable。
     *
     * 名字带 `Value` 是刻意的:`useFontScale` 会与本文件里那个**写**回调
     * (`onFontScale`)在调用点看起来像一对「读 / 写」,而它们其实是
     * 「选择器钩子 / 普通回调」两种不同的东西。
     */
    readonly fontScaleValue: IPreferenceSource<number>;
    /**
     * 渲染层绑成 `useDshGitSnapshot` 的**实时数据面**(仓库清单 + 登录态)。
     *
     * 它是「卡片读得到数据」这件事的**唯一**通道:`pages.live` 给了就订阅真 store,
     * 没给就返回 `pages.auth` / `pages.snap` 那份静态视图(同一个 observable 接口,
     * 只是永不广播)。两种情况都**必须**有这个键 —— 组件无条件调这个钩子。
     */
    readonly dshGitSnapshot: IPreferenceSource<IDshGitCardLiveView>;
  };
}

/**
 * 渲染层绑给卡片的完整 prop 面:注入面 + 页面要的视图 + 由 `hooks` 合成的选择器钩子。
 *
 * 刻意声明在**本文件(.ts)而不是组件文件(.tsx)**:带泛型的选择器签名
 * `<S>(selector) => S` 在 `.tsx` 里会被 `scripts/build.mjs` 的 `checkJsxIdentifiers`
 * 当成一个 JSX 标签 `<S>`(它的判据是「`<` 前面不是标识符字符」),于是报
 * 「这些 JSX 标签既没定义也没导入」并让构建失败。仓库里其它泛型签名
 * (`src/client/api.ts:276`、`gh-api.ts:129`)本来也都在 `.ts` 里。
 */
export type DshGitCardProps = IDshGitCardFace & {
  /** 页面要的是哪一种视图;缺省按正文处理。 */
  readonly view?: 'summary' | 'page';
  /** `hooks.dshGitSettings` 由渲染层绑成的选择器钩子。 */
  readonly useDshGitSettings: DshGitCardSelector;
  /** `hooks.fontScaleValue` 由渲染层绑成的选择器钩子。 */
  readonly useFontScaleValue: DshGitFontScaleSelector;
  /** `hooks.dshGitSnapshot` 由渲染层绑成的选择器钩子(实时数据面)。 */
  readonly useDshGitSnapshot: DshGitSnapshotSelector;
};

/** 把 `dsh-git` 命名空间的那块表单桥到本页面的暂存表单上。 */
export class DshGitSettingsCardController {
  private readonly form: SettingsFormModel<IDshGitSettings>;
  private readonly store: SnapshotStore<IDshGitCardState>;
  /** 三个页面的数据面;缺省时为 `undefined`(见构造函数)。 */
  private readonly pages: IDshGitCardPagesFace | undefined;
  /** 卡片那一侧的「偏好变了」;缺省时为 `undefined`。 */
  private readonly onPreferencesChanged: (() => void) | undefined;
  /** 注入面的**唯一**实例(`inject()` 的返回值;见那里的注释)。 */
  private face: IDshGitCardFace | undefined;

  /**
   * @param scope - `dsh-git` 命名空间绑定的设置表单面。
   * @param pages - 三个页面要的 store 面与「偏好变了」回调。
   *
   * ⚠️ `pages` 是**可选**的:它让控制器在只做 autoSec 的旧用法下依然能构造
   * (也是 `scripts/` 里那些只测表单模型的探针不改就能跑的原因)。缺省时
   * `inject()` 会注入一个**只读的空页面面** —— 见下面 `inject()` 的注释,
   * 那里解释为什么「静默给一个假 store」比「直接抛」更符合本仓的失败观。
   */
  public constructor(
    scope: SettingsFormScope<IDshGitSettings>,
    pages?: IDshGitCardPagesFace,
    onPreferencesChanged?: () => void,
  ) {
    this.form = new SettingsFormModel(scope, [settingsNumberField('autoSec')]);
    this.store = this.form.bind(() => this.projection());
    this.pages = pages;
    this.onPreferencesChanged = onPreferencesChanged;
  }

  private projection(): IDshGitCardState {
    return { ...this.form.shell(), autoSec: this.form.field('autoSec') };
  }

  /**
   * 造出卡片席位要注入的那一面(**同一个实例,只造一次**)。
   *
   * ⚠️ 为什么要缓存:宿主 `ui-renderer` 的 `cachedSlotInject()` 用**对象身份**做
   * `WeakMap` 键(`packages/client/ui-renderer/src/client/scoped-slots.tsx:208-220`),
   * 同一个 face 每次渲染都新建会让那份缓存次次落空(每次都重新绑一遍钩子)。
   * 返回**同一个冻结对象**也让「这个面一成不变」成为可断言的事实。
   *
   * @returns 页面快照、三个页面的数据面与其写动作。
   */
  public inject(): IDshGitCardFace {
    if (this.face !== undefined) {
      return this.face;
    }
    const actions = this.form.actions();
    /** 三个页面的数据面;**没有**时用那份空 store(见 `EMPTY_PAGES_STORE`)。 */
    const pages: IDshGitCardPagesFace = this.pages ?? {
      auth: null,
      snap: { current: '', repos: [] },
      store: EMPTY_PAGES_STORE,
    };
    this.face = {
      ...actions,
      editAutoSec: (text: string) => { actions.edit('autoSec', text); },
      resetAutoSec: () => { actions.resetField('autoSec'); },
      onFontScale: (value: number) => { setFontScale(value); },
      onLogout: () => { void pages.store.logout(); },
      onDeviceSignIn: startDeviceSignIn,
      onPreferencesChanged: this.onPreferencesChanged ?? (() => { /* 没有发送点:什么都不做 */ }),
      pages,
      hooks: {
        dshGitSettings: this.store,
        fontScaleValue: fontScaleStore,
        dshGitSnapshot: pages.live === undefined ? staticSource(pages) : liveSource(pages.live),
      },
    };
    return this.face;
  }

  /** 释放已接受值的订阅。 */
  public dispose(): void { this.form.dispose(); }
}

/**
 * 把宿主 `auth/state` 的原始登录态**收窄**成卡片要的那一份。
 *
 * ⚠️ **必须判 `signedIn`**:`auth/state` 在未登录时也回一个**对象**
 * (`{signedIn:false, login:'', tokenTail:'', …}`,`src/host/auth.ts:263-280`),
 * 所以「`auth !== null`」**不等于**「登录了」。只看后者会让账号页渲染出一个
 * 登录名为空串的假账号(`accountsWithEmails` 无条件造 `Account`;
 * `src/client/preferences-pages.tsx:1143` 只判 `identity === null`)。
 * @param raw - 宿主登录态;`null` = 还没读到。
 * @returns 已登录时给卡片要的形状,否则 `null`。
 */
export function cardAuthOf(raw: AuthStatePayload | null): IDshGitCardAuth | null {
  if (raw === null || !raw.signedIn) {
    return null;
  }
  return raw.endpoint === undefined
    ? { login: raw.login, tokenTail: raw.tokenTail }
    : { login: raw.login, tokenTail: raw.tokenTail, endpoint: raw.endpoint };
}

/**
 * `pages.live` **缺席**时的静态视图(探针夹具 / 旧调用点)。
 *
 * 只造一次对象:`useSyncExternalStore` 的 `getSnapshot` 必须引用稳定。
 * @param pages - 静态回退面。
 * @returns 永不广播的 observable。
 */
function staticSource(pages: IDshGitCardPagesFace): IPreferenceSource<IDshGitCardLiveView> {
  const view: IDshGitCardLiveView = { auth: pages.auth, snap: pages.snap };
  return {
    getSnapshot: () => view,
    subscribe: () => () => { /* 静态面:没有变化可广播 */ },
  };
}

/**
 * `pages.live` **存在**时的实时视图。
 *
 * 两条契约,写在这里免得被「优化」掉:
 *  1. **投影按原始快照身份缓存**(`raw !== lastRaw` 才重算)—— `useSyncExternalStore`
 *     用 `Object.is` 比较 `getSnapshot()` 的返回值,每次现造一个新对象会
 *     `Maximum update depth exceeded`;
 *  2. `subscribe` 的**函数身份稳定**(闭包只造一次)—— 否则 React 每次渲染都重新订阅。
 * @param live - 真 store 的读面。
 * @returns 订阅真 store 的 observable。
 */
function liveSource(live: IDshGitCardStoreLike): IPreferenceSource<IDshGitCardLiveView> {
  let lastRaw: IDshGitCardStoreSnapshot | undefined;
  let lastView: IDshGitCardLiveView = { auth: null, snap: { current: '', repos: [] } };
  return {
    getSnapshot: () => {
      const raw = live.snapshot();
      if (raw !== lastRaw) {
        lastRaw = raw;
        lastView = { auth: cardAuthOf(raw.auth), snap: { current: raw.current, repos: raw.repos } };
      }
      return lastView;
    },
    subscribe: (listener: () => void) => live.subscribe(listener),
  };
}

/**
 * 把卡片读到的那颗 store **装载起来**。
 *
 * ## 为什么必须有这一步(2026-10 的第二个根因)
 *
 * `settings.plugins.tab` 席位拿到的是 `storeFor('')`(`src/client/index.ts`),
 * 而**只有** `WorkbenchApp` 会调 `store.start()`(`workbench.tsx:163`)——
 * 那是一颗**按 session 键**、给右侧栏用的 store。`settings.plugins.tab` 不带
 * sessionId ⇒ 卡片那颗 `storeFor('')` **从来没有被启动过**:`ready` 恒 false、
 * `repos` 恒 `[]`、`auth` 恒 `null`。
 *
 * 实测(`docs/probes/host-settings-card-live-probe.mjs`,改前):卡片自己打过的路由
 * **只有 2 条**(`config-get` / `config-file-info`),`repos` / `auth/state` /
 * `auth/emails` **一次都没请求过**。
 *
 * ## 为什么是这两步而不是 `store.start()`
 *
 * 卡片只读「仓库清单 + 登录态」。`start()` 还会跑 `repos/autodetect`
 * (它会把**最近使用的工作区**自动登记进仓库清单 —— 渲染一个设置页不该改用户的仓库列表)、
 * 以及 status / log / branches / diff 一串只有右侧栏才用得上的请求。
 * 所以这里**只**做这两步,把副作用收在「读」的范围内。
 *
 * 失败**不抛**:卡片是附加能力,而 `waitForRoutes()` 已经把「host 半没起来」
 * 折成 `ok:false`(那条路径下不发请求,免得在控制台留下一串无意义的失败日志)。
 * @param store - 卡片读的那颗 store(真 `GitStore` 结构相容)。
 */
export async function bootstrapCardStore(
  store: IDshGitCardStoreLike & {
    refreshRepos(): Promise<void>;
    loadAuth(): Promise<void>;
  },
): Promise<void> {
  const readiness = await waitForRoutes();
  if (!readiness.ok) {
    console.info('[dsh-git] 宿主设置卡片:host 路由未就绪,仓库清单与登录态这次没装载');
    return;
  }
  await store.refreshRepos();
  await store.loadAuth();
}

/**
 * `pages` 缺省时用的**空 store 面**。
 *
 * 每一问都返回一个**已经完成、什么也不做**的 Promise,而不是抛错:
 * 卡片是附加能力(`index.ts:336-339` 那条 catch 的精神),而「什么也不做」
 * 比「点一下就炸」更接近「这个 profile 里没有这些服务」的真实语义。
 * `addRepoViaDialog` 回 `false` = 「没有可用选择器,请走 host 侧回退」,
 * 与 `clientPickDirectory()` 返回 `null` 是同一条既有契约。
 */
const EMPTY_PAGES_STORE: IPreferencesStore = {
  selectRepo: () => Promise.resolve(),
  removeRepo: () => Promise.resolve(),
  addRepoViaDialog: () => Promise.resolve(false),
  logout: () => Promise.resolve(),
  setAuth: () => { /* 没有 store:登录态无处可写 */ },
  loadRemoteRepos: () => Promise.resolve(),
  toast: () => { /* 没有 store:没有提示通道 */ },
};
