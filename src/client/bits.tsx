/**
 * 共享小件:确认气泡、toast 栈、可复制 SHA。
 * 破坏性动作(丢弃/强推/删除分支)统一走确认气泡。
 * @module dsh-git/client/bits
 */

import { useEffect, useId, useState } from 'react';
import type { ReactNode } from 'react';
/*
 * 通知横幅用**宿主原语**(`Toast`),错误档用宿主自带的警告图标。
 *
 * 为什么这两个名字能在这里裸 import(不需要 `@ts-expect-error`、也不需要 `require`):
 *  · **运行期**:已安装的宿主包就是它们
 *    (`/Applications/DSH Desktop.app/…/node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/index.js`
 *    的导出列表里 `Toast` 与 `IconWarningOutlineRegular` 都在,逐个核过;参考实现在
 *    `references/deepseek-harness/packages/client/ui-primitives/src/Toast.tsx` 与 `src/icons/index.tsx`)。
 *    构建里它是 external(`scripts/build.mjs:67` 的 `clientExternal`),产物只多一条
 *    `require("@deepseek-ai/dsh-client-ui-primitives")` —— require 家族数仍是 **4**。
 *  · **类型面**:`types/client-platform-shims.d.ts` 的显式 `declare module` 按「用过谁声明谁」
 *    维护。**这里记一笔互相依赖的经过**:本轮先加了这两行 import,而当时 shim 里只有
 *    Modal / SegmentedTabs / SettingsForm / SettingsValueField ⇒ tsc 报两条 TS2305;
 *    因为 `types/**` 不在当时那份可改清单里,临时加过一行 `@ts-expect-error`
 *    (并写明退役条件)。随后补 shim 的那条线把 `Toast`(含 prop 面与 `holdMs` 的说明)
 *    与 `IconWarningOutlineRegular` 补了进去,于是那行指令按退役条件**删掉了**
 *    (留着它会在本就没有错误时反过来报 `Unused '@ts-expect-error'`/TS2578)。
 *  · 依据的读数:`tsc --noEmit --pretty false -p tsconfig.json | grep bits.tsx` ——
 *    补 shim 前是 **2 条 TS2305**,补后是 **0 条**(先出现 1 条 TS2578 说明指令已多余)。
 */
import { IconWarningOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives';
import { Icon } from './icons.ts';
import type { GitStore } from './store.ts';

/** 确认气泡。 */
export function ConfirmDialog(props: {
  title: string;
  body?: string;
  confirmText?: string;
  danger?: boolean;
  /** 给了就在对话框里加一个单行输入框(Desktop 的 Create Alias / Rename 都是这个形状)。 */
  input?: { value: string; placeholder?: string; onChange: (value: string) => void };
  onDone: (value: boolean) => void;
}): ReactNode {
  const [busy] = useState(false);
  const titleId = useId();
  // Esc 取消:对话框必须有键盘退出路径,否则键盘用户被困住。
  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      props.onDone(false);
    }
  };
  return (
    <div className="gw-dialog-scrim" onKeyDown={onKeyDown}
      onMouseDown={(event) => { if (event.target === event.currentTarget) props.onDone(false); }}>
      <div className="gw-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h4 id={titleId}>{props.title}</h4>
        {props.body !== undefined && <p>{props.body}</p>}
        {props.input !== undefined && (
          <input className="gw-input" autoFocus value={props.input.value}
            placeholder={props.input.placeholder}
            onChange={(event) => props.input?.onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') { event.preventDefault(); props.onDone(true); }
            }} />
        )}
        <div className="gw-dialog-actions">
          <button className="gw-btn" disabled={busy} onClick={() => props.onDone(false)}>取消</button>
          <button className={`gw-btn ${props.danger === true ? 'danger' : 'primary'}`}
            autoFocus={props.input === undefined}
            onClick={() => props.onDone(true)}>
            {props.confirmText ?? '确认'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 宿主 toast 原语的**停留时长**(它自己管「停留 → 淡出 → 调 onDone」)。
 *
 * 这两个数不是审美量,是从 `store.ts` 的既有两个定时器**倒推**出来的:
 *
 *   store.ts:318   setTimeout(..., kind === 'err' ? 7000 : 3600)
 *   Toast.tsx:8    const FADE_MS = 1000   // 淡出时长,与样式表的 fade 1500→… 一致(原语自己的注释)
 *
 * 原语的可见总时长 = holdMs + FADE_MS。取 `store 的定时器 − FADE_MS − 200`,于是:
 *   · ok : 2400 + 1000 = 3400 < 3600 ✓
 *   · err: 5800 + 1000 = 6800 < 7000 ✓
 * 那 200ms 是**余量**,目的是让**原语先结束**(onDone → `store.dismissToast`),
 * 而不是让 store 的定时器把还在淡出的元素直接卸载掉(那会在最后一帧硬切)。
 * ⚠️ `store.ts` 改这两个数时,这里必须同批改(它是被沿用的那一侧,我们不是真源)。
 */
const TOAST_HOLD_MS_OK = 2400;
const TOAST_HOLD_MS_ERR = 5800;

/**
 * 宿主 `Toast` 的 `anchor`:它**只**决定横幅的**水平中心**(纵向由原语固定在视口
 * `top:40px`,见 `Toast.module.css:8`)。传插件根 `.gw-root` ⇒ 横幅居中在**侧栏这一列**上,
 * 而不是整个窗口中心 —— 这正是原语文档里 anchor 的用途(它举的例子是 composer card
 * 那种「这一列」;本插件长在宿主侧栏里,「这一列」就是插件根)。
 *
 * ⚠️ **遮挡提交按钮的问题不是靠 anchor 解决的**:anchor 动不了纵向。让「通知盖住提交
 * 按钮」在构造上不可能的,是原语自己的 `position:fixed; top:40px; width:max-content`
 * (视口顶部 + 收缩到内容)—— 见 `docs/probes/toast-commit-button-probe.mjs` 的实测。
 *
 * `bits.tsx` 拿不到 `.gw-root` 的 ref(`Toasts` 是它的兄弟子树的最后一个子级,而
 * `workbench.tsx` 不在本轮可改清单里)⇒ 挂载后查一次。`Toasts` 从第一次渲染起就挂着
 * (没有通知时返回 null),所以通知出现时 anchor 早就定位好了。
 */
function usePluginRootAnchor(): HTMLElement | null {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setAnchor(document.querySelector<HTMLElement>('.gw-root'));
  }, []);
  return anchor;
}

/**
 * 通知栈 —— **渲染宿主原语 `@deepseek-ai/dsh-client-ui-primitives` 的 `Toast`**。
 *
 * ## 为什么换掉我们自己的 `.gw-toast`(2026-10,用户报缺陷后)
 *
 * 用户原话:「生成 commit message 后的通知是宽度铺满的,会挡到提交按钮」。
 * 根因不是一个宽度数字:改前我们**自己手搓**了一个通知栈,把它绝对定位在插件根
 * 底部通栏(`styles-base.ts:174-178` 的 `left:12px;right:12px;bottom:34px`)——
 * 那正好压在 `.gw-commit` 的提交按钮上。
 *
 * 这个仓库对「宿主已有的东西」有成文规矩:**对齐优先,不要自己造**。通知这件事宿主
 * 已经有一等公民:`Toast`(`ui-primitives` 的 `Toast.tsx`,由
 * `lib/client.js` 的 4 个 require 家族之一 `@deepseek-ai/dsh-client-ui-primitives` 提供,
 * **不新增依赖、不新增家族**),它自己管:
 *
 * | 原语负责 | 出处(file:line) |
 * |---|---|
 * | 定位:`position:fixed; top:40px; left:50%; transform:translateX(-50%)` | `Toast.module.css:8-9,33` |
 * | 宽度:`width:max-content; max-width:min(640px, calc(100vw - 48px))`(**永不铺满**) | 同上 `:24-25` |
 * | 层级/不吃点击:`z-index:1100; pointer-events:none` | 同上 `:11-13` |
 * | 颜色角色:`--dsw-alias-toast-bg` / `--dsw-alias-toast-label` + `--dsw-radius-lg` | 同上 `:26,29-31` |
 * | 停留 → 淡出 → 回调卸载(`holdMs`,默认 3000) | `Toast.tsx:6-8,52-57` |
 * | 可点的行内动作(只有动作文字吃指针) | 同上 `:44-48` + `Toast.module.css:70-72` |
 * | `anchor`:把水平中心对到某一列 | `Toast.tsx:60-73` |
 * | portal 到 `document.body`(不会被 `.gw-root` 的 `contain:paint` 裁掉) | `Toast.tsx:74-76` |
 *
 * ⇒ 「铺满 + 盖住提交按钮」在**构造上**不可能再出现:横幅在视口顶部、只有内容宽。
 *
 * ## 与旧实现的**行为差异**(不是漏做,是取舍,必须知道)
 *
 * 1. **一次只显示一条**。原语是单横幅设计(`anchor` 只有水平方向,没有纵向堆叠能力),
 *    所以只渲染**最新**那条,并把更早的从 store 里 dismiss 掉。
 *    ⚠️ **不能只是不渲染旧的**:那样最新那条淡出之后,旧的会**迟到地弹出来**(比丢弃更坏)。
 *    代价:极短时间内连发两条时,只看得到最后一条。
 * 2. **位置从「插件根底部」变成「视口顶部中央(对齐插件这一列)」**。这是宿主自己的通知
 *    语汇(`ui-open-in-app/src/client/open-failure-toast.tsx`、`ui-schedule` 的 DeleteToast
 *    都是这个形状:插件自己持有一条横幅状态),而且它**不可能**压住任何插件内的按钮。
 * 3. `role` 由原语给定(`role="alert"`,原语文件里写死);旧实现是容器 `role=status` +
 *    每条的 `alert/status` 二选一。屏幕阅读器仍然会宣告。
 * 4. 旧实现的 `action` 按钮**点了没反应**:容器 `pointer-events:none` 会被子元素继承,
 *    而那条规则从没把 `auto` 加回去。原语把 `pointer-events:auto` 只加在动作文字上
 *    (`Toast.module.css:70-72`)⇒ 这里映到它的 `actions`,顺带修掉那个静默缺陷。
 *    (取证:`store.toast` 的 `action` 形参今天**零调用方**,所以这条映射是保留 store 的
 *    既有能力,探针不覆盖它。)
 */
export function Toasts(props: {
  store: GitStore;
  toasts: readonly {
    id: number;
    message: string;
    kind: 'ok' | 'err';
    actionLabel?: string;
    action?: () => void;
  }[];
}): ReactNode {
  const { store, toasts } = props;
  const current = toasts.length === 0 ? null : toasts[toasts.length - 1];
  /*
   * 更早的那些:只留它们的 id(字符串化后当依赖)。`toasts` 每次 emit 都是新数组,
   * 直接进依赖数组会让这个 effect 每次渲染都跑;而 effect 里的 `dismissToast` 又会 emit
   * ⇒ 很容易滑向「渲染-派发」互相触发的坏形状。用 id 列表的字符串做依赖,
   * 内容不变时就不重跑,收敛条件一眼可见。
   */
  const olderIds = toasts.slice(0, -1).map((toast) => toast.id).join(',');
  useEffect(() => {
    if (olderIds === '') return;
    for (const id of olderIds.split(',').map(Number)) store.dismissToast(id);
  }, [olderIds, store]);
  const anchor = usePluginRootAnchor();
  if (current === null) return null;
  const isError = current.kind === 'err';
  return (
    <Toast
      /* `key` 绑 id:同一条文案再次出现时原语要**重新播一遍**,而不是原地不动。 */
      key={current.id}
      text={current.message}
      /* 成功档用原语自带的绿色对勾(`tone="success"`,它自己的图标位);错误档给警告图标
         —— 与 `open-failure-toast.tsx` 对失败横幅的做法一致。 */
      tone={isError ? undefined : 'success'}
      icon={isError ? <IconWarningOutlineRegular /> : undefined}
      anchor={anchor}
      holdMs={isError ? TOAST_HOLD_MS_ERR : TOAST_HOLD_MS_OK}
      /* store 的 `action` / `actionLabel` 是成对写入的(`store.ts:315`);这里只做映射。 */
      actions={current.action === undefined ? undefined : [{
        label: current.actionLabel ?? '执行',
        onClick: () => {
          current.action?.();
          store.dismissToast(current.id);
        },
      }]}
      /* 淡出结束 ⇒ 从 store 里摘掉(原语只负责可见期;条目属于 store)。 */
      onDone={() => store.dismissToast(current.id)}
    />
  );
}

/** 可复制的短 SHA。 */
export function Sha(props: { value: string }): ReactNode {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <span className="pill" title="点击复制完整 SHA"
      onClick={() => {
        void navigator.clipboard?.writeText(props.value);
        setCopied(true);
      }}>
      {copied ? '已复制' : props.value.slice(0, 7)}
    </span>
  );
}

/** 状态字母。 */
export function StatusLetter(props: { status: string }): ReactNode {
  const letter = props.status === '?' ? '?' : props.status[0] ?? 'M';
  return <span className={`gw-st ${letter === '?' ? 'gw-st?' : letter}`}>{letter}</span>;
}

/** 空态。 */
export function Empty(props: { icon?: string; title: string; body?: string; children?: ReactNode }): ReactNode {
  return (
    <div className="gw-empty">
      {props.icon !== undefined && <div style={{ marginBottom: 8, opacity: 0.6 }}><Icon name={props.icon} size={26} /></div>}
      <div style={{ color: 'var(--dsw-alias-label-secondary)' }}>{props.title}</div>
      {props.body !== undefined && <div style={{ marginTop: 6 }}>{props.body}</div>}
      {props.children !== undefined && <div style={{ marginTop: 12 }}>{props.children}</div>}
    </div>
  );
}
