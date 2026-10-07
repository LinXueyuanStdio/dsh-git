/**
 * dsh-git 在**宿主设置**里的那张卡片 —— 渲染层。
 *
 * `plugins.item` 与 `settings.plugins.tab` 两个席位的占用者被渲染的方式不同
 * (见 `packages/client/ui-plugin-manager/src/client/PluginManagerPage.tsx` 与
 * `packages/client/ui-settings-plugins/src/client/PluginsSettingsSection.tsx`):
 *  - `view: 'summary'` —— 卡片标题下的那一行说明;
 *  - `view: 'page'` —— 点开后的正文。**这里放的是三个页面本体**
 *    (账号 / 仓库 / 无障碍,与 `preferences-dialog.tsx` 那份弹窗同源,
 *    真正渲染它们的是 `./preferences-pages.tsx` 的 `PreferencesPageBody`)。
 *
 * ## 作用域根(`.gw-prefs`)为什么必须由**本文件**包一层
 *
 * 那三个页面的样式全部来自移植面 `src/client/scss/preferences.scss`,而
 * `scripts/styles.mjs` 的 `PORT_SURFACES` 把它的作用域根定成 `.gw-prefs`
 * (前缀化方式是 `.gw-prefs ` + 选择器 = **后代组合子**)。
 *
 * 弹窗那一侧,`.gw-prefs` 由 `host-modal.tsx` 的 `CARD_CLASS`
 * (`'gw-prefs gw-prefs-card'`)加在**卡片自己**身上;卡片这一侧没有宿主卡片可用
 * (我们的正文直接落在宿主设置的分区里),所以**必须自己包一层** ——
 * 否则上游那条规则一条都不匹配,界面裸奔。
 *
 * ⚠️ **不要把 `.gw-prefs` 与任何目标类加在同一个元素上**(会产出永不匹配的后代
 * 选择器);也不要去改上游 SCSS 或新登记一个移植面 —— 作用域根就是 `.gw-prefs`,
 * 落点由调用方决定,这是那一面**早就写好**的契约。
 *
 * ## 组件不碰 ctx
 *
 * 数据与回调全部来自 `DshGitCardProps` 里的注入面,以及由 `hooks` 隔间绑成的两个
 * 选择器钩子(`useDshGitSettings` / `useFontScaleValue`)。它也不自己订阅 ——
 * `SettingsFormModel` 与本插件的 `prefs-bus.ts` 已经把投影发布成裸 observable 了。
 *
 * @module dsh-git/client/host-settings-card
 */

import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import {
  SegmentedTabs, SettingsForm, SettingsValueField,
} from '@deepseek-ai/dsh-client-ui-primitives';
import type {
  SegmentedTab, SettingsFormLabels,
} from '@deepseek-ai/dsh-client-ui-primitives';
import type { DshGitCardProps } from './host-settings-card.ts';
import {
  PAGE_PANEL_ID,
  PreferencesPageBody,
  TABS,
  useUnderlineLinks,
  type PreferencesTabId,
} from './preferences-pages.tsx';
import { FONT_SCALE_DEFAULT } from './prefs-bus.ts';

/**
 * 卡片文案。
 *
 * 刻意**不走 `ctx.locale`**:那是另一个可选服务(本插件声明的是
 * `slots` / `sidebarRightTabs`),为一个卡片再引入一个硬依赖会让整块 UI 在该服务
 * 缺席时一起消失。宿主文案表是上游的规约,这里是本插件自己的中文界面
 * (与 `src/client/**` 其余部分一致)。
 */
const COPY = {
  summary: '本地仓库工作台:多仓库 Changes/History 与远端页签(dsh-git)。',
  formLabels: {
    unavailable: '宿主没有把 dsh-git 的设置暴露给这个页面,这里没有可编辑的内容。',
    readOnly: '当前配置文档只读,保存不会生效。',
    saveFailed: '宿主没有接受这次保存,暂存的内容还在。',
    save: '保存',
    saving: '保存中…',
  } satisfies SettingsFormLabels,
  autoSecLabel: 'Pulls 自动刷新周期(秒)',
  autoSecHint: '0 = 关闭自动刷新;留空 = 回到默认值。周期改完保存后,Pulls 页签下一次刷新按新周期走。',
  overridden: '已覆盖',
  reset: '恢复默认',
  invalidNumber: '请填 0–600 之间的整数(秒)。',
  pagesLabel: 'dsh-git 设置分区',
  tabsLabel: 'dsh-git 偏好页面',
  hostConfigHeading: '插件配置(宿主设置文档)',
} as const;

/**
 * 宿主 `SegmentedTabs` 的 `items` —— 由 `TABS` **逐条映射**,不是第二张表。
 *
 * `id` / `panelId` 的约定(宿主 `SegmentedTabs.tsx`):
 *  - `id` 落在页签按钮自己身上(`role="tab"`),`Pill` 把它原样放进 DOM;
 *  - `panelId` 原样写进那个按钮的 `aria-controls` ⇒ **必须真的存在**一个
 *    带这个 id 的 `role=tabpanel`,否则就是可达性缺陷。这正是
 *    `preferences-pages.tsx` 的 `PAGE_PANEL_ID` 与下面那个面板用同一张表的理由。
 */
const TAB_ITEMS = TABS.map((entry) => ({
  value: entry.id,
  label: entry.label,
  id: `dsh-git-preferences-tab-${entry.id}`,
  panelId: PAGE_PANEL_ID[entry.id],
})) as unknown as readonly [SegmentedTab<PreferencesTabId>, ...SegmentedTab<PreferencesTabId>[]];

/**
 * 渲染 dsh-git 的一行说明,或它的完整设置面(三个页面 + 宿主配置表单)。
 *
 * @param props - 要的视图、表单快照(经钩子)、页面数据面与其写动作。
 * @returns 一行说明,或那张设置面。
 */
export function DshGitCard(props: DshGitCardProps): ReactNode {
  const state = props.useDshGitSettings((snapshot) => snapshot);
  /**
   * **实时数据面**(仓库清单 + 登录态)。
   *
   * ⚠️ 这一行是本卡片「参数加载得出来」的**唯一**通道,不要退回读 `props.pages.snap`:
   * 那两个字段是 `index.ts` 在**注册那一瞬间**拍的快照(`apply()` 期间,`WorkbenchApp`
   * 都还没挂载),里面 `repos: []`、`auth: null`,而且没有任何订阅 ⇒
   * 仓库页永远「还没有仓库」、账号页永远「未登录」、点按钮界面不动。
   * 判据与改前读数见 `docs/probes/host-settings-card-live-probe.mjs` 的 A2/A3/B1/B2。
   *
   * `props.pages.auth/snap` 仍然在注入面里 —— 它们是**静态回退面**
   * (`hooks.dshGitSnapshot` 由 controller 用 `staticSource()` 造出来给没有 `live` 的
   * 调用点,例如 `docs/probes/host-settings-card-driver.tsx`),不是第二份真源。
   */
  const live = props.useDshGitSnapshot((view) => view);
  /**
   * 界面缩放的**当前值** —— 从 `hooks.fontScaleValue` 那个 observable 读。
   *
   * ⚠️ 这里的 `?? FONT_SCALE_DEFAULT` 不只是「运行期兜底」,它还是**正确性**:
   * 一个缺席的 observable 会让钩子返回 `undefined`
   * (`bindings.tsx:100` 的 `absentSource`),而选择器钩子的比较是
   * `Object.is(选择结果)` —— `undefined ?? 0` 得到**稳定**的 `0`,而裸
   * `undefined` 在「每次渲染算一次 `NaN`」(或任何非原始值)时会永远不相等,
   * 于是 `useSyncExternalStore` 每次渲染都判定「变了」⇒ 无限重渲染。
   * 实测踩过这条(`Maximum update depth exceeded`),所以选择器必须收敛到原始值。
   */
  const fontScale = props.useFontScaleValue((value) => value ?? FONT_SCALE_DEFAULT);
  /** 「Underline links」—— 它决定**作用域根**上那个类,见文件头。 */
  const underlineLinks = useUnderlineLinks();
  /** 当前页面。`useState` 而不是注入面:它是这个组件的**视图** state,与表单无关。 */
  const [tab, setTab] = useState<PreferencesTabId>('accounts');

  /**
   * 宿主 `SegmentedTabs` 的 `onChange` 是 `(value: PreferencesTabId) => void`,
   * 而 `useState` 的 setter 是 `Dispatch<SetStateAction<…>>` —— 前者可赋给后者
   * (`PreferencesTabId` 是 `SetStateAction` 的子集),写清楚是为了让**签名**可读,
   * 顺带满足 `react/jsx-no-bind`(它连 JSX 里的内联箭头都拦,成员/标识符不拦)。
   */
  const onTabChange = useCallback((value: PreferencesTabId) => { setTab(value); }, []);

  if (props.view === 'summary') {
    return COPY.summary;
  }

  return (
    <div className={underlineLinks ? 'gw-prefs gw-underline-links' : 'gw-prefs'}>
      {/*
        ## 为什么这里需要**两层**(`.gw-prefs` 包 `#preferences`)
        1. `.gw-prefs` 是移植面的作用域根(`scripts/styles.mjs` 的 `PORT_SURFACES`
           里 id `preferences` 的那条:`scope: '.gw-prefs'`)。上游每条规则都是它的**后代**;
        2. `id="preferences"` 是**上游那个 `<dialog id="preferences">` 的角色**:
           `src/core/desktop/ui/preferences/_preferences.scss` 整份以 `#preferences { … }`
           为根,编译+作用域化后产出的是
           `.gw-prefs #preferences .accounts-tab .account-info .user-info-container` /
           `.gw-prefs #preferences .settings-description` 这类**三段**选择器。
           弹窗那边由 `preferences-dialog.tsx` 渲染的
           `<div id="preferences" className="gw-prefs-body">` 扮演它;卡片这边以前**没有**
           ⇒ 上游那一族(账号页的头像/行距、`.settings-description` 字号与颜色、
           `.example-link` 的 `cursor`、`.tab-container` 的左边框…)**一条都不匹配**。
           界面不报错,只是「看起来差点意思」,而静态闸门也不会红。
        3. ⚠️ **两层不能合成一层**:`#preferences` 必须是 `.gw-prefs` 的**后代**。
           同元素会让 `.gw-prefs #preferences …` 变成「要求自己里面还有一个自己」——
           实测就是 `el.matches('.gw-prefs #preferences .settings-description') === false`
           (而 `.gw-prefs .settings-description` 与 `#preferences .settings-description`
           各自都 true)。这正是 `scss/preferences.scss` 头注释里那条禁令的具体形态。
        4. 布局由**里面**这一层承担(`scss/preferences.scss` 的 `.gw-prefs-preferences`:
           `display:flex; flex-direction:column; min-height:0`)——
           因为它是页签 / 页面 / 配置表单这三层的直接父节点。
      */}
      <div id="preferences" className="gw-prefs-preferences" aria-label={COPY.pagesLabel}>
      <SegmentedTabs
        items={TAB_ITEMS}
        value={tab}
        onChange={onTabChange}
        label={COPY.tabsLabel}
        className="gw-prefs-tabs"
      />

      {/*
        ## 三个面板**都渲染**,用 `hidden` 控制可见性(与宿主 `PluginsSettingsSection`
        自己的做法同形:`hidden={!selected}`)。

        为什么要这样而不是只渲染选中的那一页:
        1. **可达性契约**:宿主 `SegmentedTabs` 把 `items[].panelId` 原样写进每个页签的
           `aria-controls`(`SegmentedTabs.tsx` 的 `SegmentedTab` 契约)。只渲染一页
           时,另外两个 `aria-controls` 指向**不存在的节点** —— 那是缺陷,而
           `docs/probes/host-settings-card-probe.mjs` 会当场抓住它(第一版就是这么红的);
        2. 代价可接受:每页都只是几个表单控件,而且宿主自己的设置分区就是「访问过就常驻」
           的语义(`PluginsSettingsSection.tsx:44-48` 的 `visitedIds`)。
      */}
      {TABS.map((entry) => (
        <div
          key={entry.id}
          id={PAGE_PANEL_ID[entry.id]}
          className="gw-prefs-page tab-container"
          role="tabpanel"
          hidden={entry.id !== tab}
          aria-label={entry.label}
        >
          <PreferencesPageBody
            tab={entry.id}
            auth={live.auth}
            store={props.pages.store}
            snap={live.snap}
            fontScale={fontScale}
            onFontScale={props.onFontScale}
            onLogout={props.onLogout}
            startDeviceSignIn={props.onDeviceSignIn}
            onPreferencesChanged={props.onPreferencesChanged}
          />
        </div>
      ))}

      {/*
        ## 已有的「Pulls 自动刷新周期」表单**保留**,与三个页面**并列**在下面

        为什么并列而不是塞进「仓库」页:它是**宿主配置文档**里的一段(host 半
        `src/index.ts` 的 `export const Config` 里那个 volatile 字段),与三个
        客户端页面**不是同一类东西** —— 前者写 profile 的 `cordis.patch.yml`、
        由宿主的 `SettingsFormModel` 负责暂存/保存,后两者当场生效。

        为什么不合并进 `SettingsForm`:三个页面的开关「当场生效」(写 localStorage
        并广播),把它们塞进一个「保存才写」的外壳会造出**两套写入语义在同一张表单里**
        —— 那是比「多一个小节」坏得多的东西。
      */}
      <section className="gw-prefs-host-config">
        <h3>{COPY.hostConfigHeading}</h3>
        <SettingsForm
          labels={COPY.formLabels}
          state={state}
          onSave={props.save}
          onDiscard={props.discard}
        >
          <SettingsValueField
            id="plugin-config-dsh-git-auto-sec"
            label={COPY.autoSecLabel}
            hint={COPY.autoSecHint}
            overriddenLabel={COPY.overridden}
            resetLabel={COPY.reset}
            invalidLabel={COPY.invalidNumber}
            numeric={true}
            disabled={!state.writable}
            {...state.autoSec}
            onEdit={props.editAutoSec}
            onReset={props.resetAutoSec}
          />
        </SettingsForm>
      </section>
      </div>
    </div>
  );
}
