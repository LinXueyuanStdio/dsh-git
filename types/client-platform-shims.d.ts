/**
 * **宿主平台种子模块的类型面** —— 只声明我们**真的**从平台表里取的成员。
 *
 * ## 为什么需要这个文件(而不是加进 `@types/*` 或 tsconfig 的 `paths`)
 *
 * `tsconfig.json` 的 `types: []` 与「浏览器半禁止 node 内置」是**同一条机器检查**
 * (见 `tsconfig.json` 的头注释):它关掉 `node_modules/@types` 的全局自动加载。
 * 连带效果是:任何 `@deepseek-ai/*` 的 import 都会得到 **TS2307** —— 这正是
 * `docs/type-check.md:163` 记录的那条硬约束的机器检查(「一旦有客户端文件 import
 * 它,就会得到 TS2307」)。
 *
 * 但那条约束的**真实意图**是「不要伸手进别的插件/宿主内部包」。DSH 自己把
 * **平台种子模块表**(`packages/client/web/src/platform.ts:8` 的 `PLATFORM_MODULES`)
 * 定为**所有动态 bundle 的隐式 external 基座**,`ui-primitives` 就在表里(与
 * `react` / `react-dom` 同级)。`docs/type-check.md:163` 把两者写成同一句话是
 * **过窄的**;`react` 之所以不报 TS2307,靠的是 `@types/react` 这个 devDependency,
 * 不是因为 `react` 不是 `@deepseek-ai/*`。
 *
 * 所以本文件是那句约束的**精确化**:从 `PLATFORM_MODULES` 里取用的成员,按
 * 「保留上游导出名与签名」的最小替身声明(与 `types/host-shims.d.ts` 同一手法),
 * 逐条写清来源;表外的 `@deepseek-ai/*` 仍然报 TS2307,约束**没有放宽**。
 *
 * 改这里之前先读 `references/deepseek-harness/packages/client/ui-primitives/src/`
 * 的同名文件:签名要逐字对得上,对不上就是「本地重声明与真身漂移」(目标文档
 * §10.5 / §10.7 记的那类死 prop 就是这样长出来的)。
 *
 * @module dsh-git/types/client-platform-shims
 */

declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { KeyboardEventHandler, ReactNode } from 'react';
  // 设置表单模型把投影发布成宿主快照存储;那个类型由我们自己的 ambient 声明提供
  // (见本文件末尾),所以这里**只借类型、不借值**。
  import type { SnapshotStore } from '@deepseek-ai/dsh-client-store';

  /**
   * 宿主模态的公共 prop 面。
   *
   * 逐字对应上游 `references/deepseek-harness/packages/client/ui-primitives/src/Modal.tsx:8-20`
   * 的 `ModalBaseProps` + `ModalProps` 判别式联合。判别式的两条分支都保留:
   * `headless: true` 时 `closeLabel` 必须缺省(上游是 `closeLabel?: never`)。
   */
  interface IModalBaseProps {
    readonly open: boolean;
    readonly onClose: () => void;
    readonly title: string;
    readonly description?: string;
    readonly children?: ReactNode;
    readonly footer?: ReactNode;
    readonly className?: string;
    readonly contentClassName?: string;
    readonly shortcutModal?: string;
    readonly onKeyDownCapture?: KeyboardEventHandler<HTMLDivElement>;
    readonly backdropBlur?: boolean;
  }

  /** 无默认头部/关闭钮/正文壳(headless)分支。 */
  interface IModalHeadlessProps extends IModalBaseProps {
    readonly headless: true;
    readonly closeLabel?: never;
  }

  /** 带宿主默认头部与关闭钮的分支。 */
  interface IModalChromeProps extends IModalBaseProps {
    readonly headless?: false;
    readonly closeLabel: string;
  }

  export type ModalProps = IModalHeadlessProps | IModalChromeProps;

  /**
   * 居中、portal 到 `document.body` 的宿主模态。
   *
   * 行为由上游 `useModalLayer`(`useModalLayer.ts:56-126`)提供:栈顶独占 Esc 与 Tab、
   * 打开时自动聚焦(优先 `[data-modal-autofocus]`)、关闭时把焦点还给触发控件。
   */
  export const Modal: (props: ModalProps) => ReactNode;

  // ---------------------------------------------------------------------------
  // 瞬时横幅与宿主图标(`Toast.tsx` / `icons/**`)—— 通知栈改用宿主原语之后补的成员。
  //
  // 逐字对应上游:
  //   · Toast
  //       `packages/client/ui-primitives/src/Toast.tsx:46-53`
  //   · IconWarningOutlineRegular
  //       `packages/client/ui-primitives/src/icons/index.tsx:599`
  //       (props 面 = `icons/props.ts:2-8`;它经由 `src/index.ts:109` 的
  //        `export * from './icons/index.tsx'` 从**包根**再导出 —— 这正是宿主自己
  //        `ui-open-in-app/src/client/open-failure-toast.tsx` 的取法,所以它
  //        **确实**在包根导出表里,只是不在 `index.ts` 的字面列表里)
  //
  // 为什么是这两个:`src/client/bits.tsx` 的通知栈 2026-10 从手写 `.gw-toast`
  // 换成宿主原语(用户报「通知铺满、盖住提交按钮」),而这两个名字**不在**本文件
  // 原来的成员表里 ⇒ 那两行 import 报 TS2305。**上游签名本身没有变**。
  //
  // ⚠️ `holdMs` 只声明**可选**、不写默认值:`3000` 是上游实现的默认
  // (`Toast.tsx:8` 的 `HOLD_MS`)。本地重声明再写一遍默认值,两边一改就会静默分叉
  // —— 那正是本文件头注释记的漂移缺陷类。
  //
  // ⚠️ **2026-10 修正:`actions` 的元素属性不能加 `readonly`(曾经的漂移)**。
  // 上游那三个元素属性是**可变的**——`readonly` 只加在**数组**上:
  //
  //     上游 Toast.tsx:52  actions?: readonly { label: string; prefix?: string; onClick: () => void }[]
  //     逐字展开            actions?: ReadonlyArray<{ label: string; prefix?: string; onClick: () => void }>
  //
  // (两者 TypeScript 语义**完全等价**:`readonly T[]` 就是 `ReadonlyArray<T>` 的语法糖。)
  //
  // 为什么写成 `ReadonlyArray<…>` 而不是 `readonly {…}[]`:本文件把上游的**内联对象类型**
  // 拆成了 `IToastProps`(见下面那条),于是 `react-readonly-props-and-state` 的
  // `arraySignaturesShouldBeReadonly` 会检查这个成员。那个检查只看
  // **类型注解的文本**是否以 `[]` 结尾(`eslint-rules/react-readonly-props-and-state.js:93-104`),
  // 分不清 `readonly T[]`(已是只读数组)与 `T[]`(可变数组)⇒ 对 `readonly {…}[]`
  // 是**假阳性**。`ReadonlyArray<…>` 是唯一既能逐字表达上游语义、
  // 又能让那条规则安静下来的写法。**不要**把它改回 `readonly {…}[]` 去「更逐字」——
  // 那会把这条闸门重新点亮,而两者编译后与类型上都没有区别。
  // ---------------------------------------------------------------------------

  /** `Toast` 的 prop 面(上游是 `Toast.tsx:46-53` 的内联对象类型;这里按本文件惯例拆成 `I*` 接口)。 */
  interface IToastProps {
    /** 解析后的横幅文案;由调用点负责本地化。 */
    readonly text: string;
    /** 可选的前导字形;`tone: 'success'` 时被忽略(那一档自带绿色对勾)。 */
    readonly icon?: ReactNode;
    /** `'success'` 用宿主自带的绿色对勾;省略时图标位保持警告色。 */
    readonly tone?: 'success';
    /** 横幅**水平中心**要对齐的元素(例如插件根那一列);省略时对齐视口。 */
    readonly anchor?: HTMLElement | null;
    /** 淡出前的全不透明停留时长(毫秒);默认值属于实现(`HOLD_MS = 3000`)。 */
    readonly holdMs?: number;
    /**
     * 续在句子后面的行内动作;只有动作文字吃指针。
     *
     * 上游逐字:`readonly { label: string; prefix?: string; onClick: () => void }[]`
     * ⇒ 等价于下面的 `ReadonlyArray<…>`,元素属性**可变**(理由见上方那段)。
     */
    readonly actions?: ReadonlyArray<{
      label: string;
      prefix?: string;
      onClick: () => void;
    }>;
    /** 淡出结束时调一次;由调用方在这里卸载。 */
    readonly onDone: () => void;
  }

  /** portal 到 `document.body` 的瞬时顶部横幅:滑入 → 停留 → 淡出 → `onDone`。 */
  export const Toast: (props: IToastProps) => ReactNode;

  /** 宿主图标组件的 prop 面(`icons/props.ts:2-8`)。 */
  interface IIconProps {
    /** 方形边长(px);省略时用字形自己的绘制尺寸。 */
    readonly size?: number;
    /** 额外类名(布局用);颜色走 `currentColor`。 */
    readonly className?: string;
  }

  /**
   * 错误档通知的前导警告图标(octicon 形状)。
   *
   * 它是**函数组件**(与 `Modal` 同一种值),不是别的种类的值:上游
   * `icons/index.tsx:599` 写的是
   * `export const IconWarningOutlineRegular = (props: IconProps) => (<svg …/>)`。
   */
  export const IconWarningOutlineRegular: (props: IIconProps) => ReactNode;

  // ---------------------------------------------------------------------------
  // 分段页签(`SegmentedTabs.tsx`)—— 宿主设置卡片里那三个页面的页签控件。
  //
  // 逐字对应上游:
  //   · SegmentedTab / SegmentedTabs
  //       `packages/client/ui-primitives/src/SegmentedTabs.tsx:5,25`
  //
  // 为什么用它而不是我们手写一套:`dsh-git` 的偏好页面(账号 / 仓库 / 无障碍)以前
  // 只在自建模态里出现,页签用的是**上游 Desktop** 的竖向 `TabBar`;搬进宿主设置卡片后
  // 裁决是「页签控件一律用宿主原语」—— 手写第二套会同时丢掉宿主的键盘语义
  // (Left/Right/Home/End + 单一 tab stop)与主题令牌。
  //
  // 这个符号在**已安装的** `ui-primitives@0.2.0-rc.2` 的导出表里确实存在
  // (`lib/index.js` 的 `SegmentedTabs`),所以引用它**不增加任何 `require`** ——
  // 整个包早就是平台种子模块(`packages/client/web/src/platform.ts` 的
  // `PLATFORM_MODULES`),我们已经在取它的 `Modal` / `SettingsForm`。
  // ---------------------------------------------------------------------------

  /** 一个页签:`label` 是本地化文案,`id` / `panelId` 是 DOM 契约。 */
  interface ISegmentedTab<Value extends string = string> {
    /** 选中判定用的值;必须与 `SegmentedTabs` 的 `items` 里其它值互不相同。 */
    readonly value: Value;
    /** 页签上显示的内容(由调用点本地化)。 */
    readonly label: ReactNode;
    /** `role="tab"` 那个按钮的 DOM id。 */
    readonly id: string;
    /**
     * 该页签 `aria-controls` 指向的面板 id。
     * ⚠️ 上游把它**原样**写进 `aria-controls` ⇒ 调用方必须让那个面板真的存在。
     */
    readonly panelId: string;
  }

  /** `SegmentedTabs` 的 prop 面(非空元组:至少一个页签)。 */
  interface ISegmentedTabsProps<Value extends string> {
    /** 有序页签;`value` 必须落在其中。 */
    readonly items: readonly [ISegmentedTab<Value>, ...ISegmentedTab<Value>[]];
    /** 当前选中的值。 */
    readonly value: Value;
    /** 点击 / 键盘请求切换。 */
    readonly onChange: (value: Value) => void;
    /** 页签栏的无障碍名(`role=tablist` 上的 `aria-label`)。 */
    readonly label: string;
    /** 额外类名(布局用);面板本身仍由调用方拥有。 */
    readonly className?: string;
  }

  export type SegmentedTab<Value extends string = string> = ISegmentedTab<Value>;

  /** 等宽、受控、带滑动选中指示器的页签栏(**不含面板**)。 */
  export const SegmentedTabs: <Value extends string>(
    props: ISegmentedTabsProps<Value>,
  ) => ReactNode;

  // ---------------------------------------------------------------------------
  // 设置表单(`settings-form/**`)—— 宿主「设置 ▸ 插件」里插件卡片用的那一套。
  //
  // 逐字对应上游(签名必须对得上,漂移就是「本地重声明与真身分叉」):
  //   · SettingsForm / SettingsFormProps / SettingsFormLabels
  //       `packages/client/ui-primitives/src/settings-form/SettingsForm.tsx:17,31`
  //   · SettingsValueField / SettingsFieldProps
  //       `packages/client/ui-primitives/src/settings-form/fields.tsx:13,53`
  //   · SettingsFormModel / settingsNumberField / SettingsFieldSpec / SettingsFieldState /
  //     SettingsFormShell / SettingsFormActions / SettingsFormScope / SettingsFormScopeSnapshot /
  //     SettingsFormPathOp
  //       `packages/client/ui-primitives/src/settings-form/form-model.ts:19,35,64,89,103,119,40,195,156`
  //
  // 这几个名字在**已安装的** `ui-primitives@0.2.0-rc.2` 里确实存在
  // (`lib/index.js` 的导出表里有 SettingsForm / SettingsFormModel / SettingsValueField /
  // settingsNumberField),所以引用它们**不增加任何 `require`**:整个包早就是平台种子模块
  // (`packages/client/web/src/platform.ts` 的 `PLATFORM_MODULES`),我们已经在取它的 `Modal`。
  // ---------------------------------------------------------------------------

  /** 表单外壳的文案(来自卡片自己的字典)。 */
  interface ISettingsFormLabels {
    /** 命名空间未被宿主服务时替代控件显示的那句。 */
    readonly unavailable: string;
    /** 文档只读时显示在控件上方的那句。 */
    readonly readOnly: string;
    /** 宿主没接受保存时显示在保存钮旁的那句。 */
    readonly saveFailed: string;
    /** 保存钮。 */
    readonly save: string;
    /** 保存跨线期间的保存钮。 */
    readonly saving: string;
  }

  /** 每个设置卡片共用的表单外壳 prop。 */
  interface ISettingsFormProps {
    readonly labels: ISettingsFormLabels;
    readonly state: ISettingsFormShell;
    readonly onSave: () => void;
    /** 丢弃全部暂存;表单在离开页面时自己调用。 */
    readonly onDiscard: () => void;
    readonly children: ReactNode;
  }

  /** 一个字段控件需要的全部 prop(与值类型无关的部分)。 */
  interface ISettingsFieldProps {
    readonly id: string;
    readonly label: string;
    readonly hint: string;
    /** 本控件渲染的草稿文本。 */
    readonly text: string;
    /** 保存是否会为该字段留下用户层条目。 */
    readonly overridden: boolean;
    /** 草稿不是该字段接受的值(阻断保存)。 */
    readonly invalid: boolean;
    readonly overriddenLabel: string;
    readonly resetLabel: string;
    readonly invalidLabel: string;
    readonly disabled: boolean;
    readonly onEdit: (text: string) => void;
    readonly onReset: () => void;
  }

  /** 一次保存要发出的单个路径编辑。 */
  type SettingsFormPathOp =
    | { op: 'set'; path: readonly string[]; value: unknown }
    | { op: 'unset'; path: readonly string[] };

  /** 表单读取的某个宿主条目表单快照。 */
  interface ISettingsFormScopeSnapshot<T> {
    readonly status: 'loading' | 'ready' | 'unavailable';
    readonly value: T | undefined;
    readonly base: unknown;
    readonly user: unknown;
    readonly writable: boolean;
    readonly revision: number | undefined;
  }

  /** 卡片暂存其上的那个条目表单:读 + 一次带修订栅栏的原子写。 */
  interface ISettingsFormScope<T> {
    getSnapshot(): ISettingsFormScopeSnapshot<T>;
    subscribe(listener: () => void): () => void;
    mutate(ops: readonly SettingsFormPathOp[], expectedRevision?: number): Promise<boolean>;
  }

  /** 单个字段的状态(草稿文本 / 是否覆盖 / 是否非法)。 */
  interface ISettingsFieldState {
    readonly text: string;
    readonly overridden: boolean;
    readonly invalid: boolean;
  }

  /** 每个插件卡片共用的表单状态。 */
  interface ISettingsFormShell {
    readonly available: boolean;
    readonly writable: boolean;
    readonly dirty: boolean;
    readonly invalid: boolean;
    readonly saving: boolean;
    readonly failed: boolean;
  }

  /** 每个卡片席位注入的那组写动作。 */
  interface ISettingsFormActions {
    edit: (field: string, text: string) => void;
    resetField: (field: string) => void;
    save: () => void;
    discard: () => void;
  }

  /** 一个字段在存储值与草稿文本之间的转换规则。 */
  interface ISettingsFieldSpec {
    readonly field: string;
    readonly format: (value: unknown) => string;
    readonly parse: (text: string) => { kind: 'set'; value: unknown } | { kind: 'clear' } | undefined;
  }

  export type SettingsFormLabels = ISettingsFormLabels;
  export type SettingsFormProps = ISettingsFormProps;
  export type SettingsFieldProps = ISettingsFieldProps;
  export type SettingsFieldState = ISettingsFieldState;
  export type SettingsFormShell = ISettingsFormShell;
  export type SettingsFormActions = ISettingsFormActions;
  export type SettingsFieldSpec = ISettingsFieldSpec;
  export type SettingsFormScopeSnapshot<T> = ISettingsFormScopeSnapshot<T>;
  export type SettingsFormScope<T> = ISettingsFormScope<T>;

  /** 整数/小数文本字段:空草稿 = 清除,非有限数 = 阻断保存。 */
  export const settingsNumberField: (field: string) => SettingsFieldSpec;

  /** 在某个命名空间上暂存编辑、保存时一次写出的表单模型。 */
  export class SettingsFormModel<T> {
    public constructor(scope: SettingsFormScope<T>, specs: SettingsFieldSpec[]);
    /** 发布本表单的一个投影;scope 或草稿变化时重建。 */
    public bind<S>(project: () => S): SnapshotStore<S>;
    public shell(): SettingsFormShell;
    public field(field: string): SettingsFieldState;
    public actions(): SettingsFormActions;
    public dispose(): void;
  }

  /** 一个插件设置的完整表单外壳(控件 + 保存/丢弃)。 */
  export const SettingsForm: (props: SettingsFormProps) => ReactNode;

  /** 一个暂存值字段(标签 / 覆盖徽标 / 重置 / 校验提示)。 */
  export const SettingsValueField: (
    props: Omit<SettingsFieldProps, 'hint'> & {
      hint?: string;
      numeric?: boolean;
      placeholder?: string;
    },
  ) => ReactNode;
}

declare module '@deepseek-ai/dsh-client-store' {
  /**
   * 可写快照存储的**数据面**(React 选择器钩子由渲染层合成)。
   *
   * 逐字对应上游 `references/deepseek-harness/packages/client/store/src/index.ts:27`
   * 与 `:contract.ts:4`:引擎产物是裸 observable —— subscribe / getSnapshot / update / set,
   * **没有** selector hook。我们只把 `SettingsFormModel.bind()` 返回的它塞进 `hooks` 隔间,
   * 从不自己造钩子,所以这里只需要数据面。
   *
   * 与 `ui-primitives` 同理:这是平台种子模块之一(`PLATFORM_MODULES` 里有 `client/store`),
   * 而且我们**只用类型** —— 编译后擦除,产物里不多一条 `require`。
   */
  interface IObservableSnapshot<T> {
    getSnapshot(): T;
    subscribe(fn: () => void): () => void;
  }

  interface ISnapshotStore<T> extends IObservableSnapshot<T> {
    update(mutator: (draft: T) => void): void;
    set(next: T): void;
  }

  // 上游名是 `ObservableSnapshot` / `SnapshotStore`(`store/src/index.ts:27`、
  // `store/src/contract.ts:4`)。这里把**接口**按本仓的 naming-convention 叫 `I*`,
  // 再用同名类型别名把上游名字留给调用方 —— 于是签名与上游逐字一致,闸门也不新增违规。
  export type ObservableSnapshot<T> = IObservableSnapshot<T>;
  export type SnapshotStore<T> = ISnapshotStore<T>;
}
