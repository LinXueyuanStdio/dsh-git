/**
 * 宿主插件页设置面的**行控件** —— 形状照 `references/dsh-context` 的设置卡
 * (`src/client/components/settingsCard.tsx` + `styles/settings.css`)。
 *
 * ## dsh-context 的行长什么样(我们逐条对齐)
 *
 * | 特征 | dsh-context | 本文件 |
 * |---|---|---|
 * | 行 | 标签在左(14px / `--dsw-alias-label-primary`)、控件在右、`gap: 8px`、`padding: 8px 0` | 同 |
 * | 提示 | 12px / `--dsw-alias-label-tertiary`,跟在标签下面 | 同 |
 * | 分组 | 标题 14px/500;组之间 `border-top: 0.5px solid var(--dsw-alias-border-l2)` + 12px 间距 | 同(间距用我们的 `--spacing-double`) |
 * | 枚举控件 | **胶囊**:高 36px、圆角 18px、底色 `--dsw-alias-bg-module-platform` | 同形,但用**原生 `<select>`** 而不是宿主 `Menu` |
 * | 文本控件 | 标签在上、整行输入框;`border: 0.5px solid var(--dsw-alias-border-l4)`、`radius: var(--dsw-radius-md)`、底色 `--dsw-alias-bg-layer-3` | 同 |
 *
 * ## 为什么枚举用原生 `<select>`(而不是像 dsh-context 那样用宿主 `Menu`)
 *
 * 两条都算「宿主风格」:dsh-context 自己拼了 `Menu` + 胶囊按钮,而 **宿主自己的
 * bundle-config 页面**(`packages/experimental/client-ui-cot-translation/.../TranslationSettings.tsx`)
 * 用的就是原生 `<select>`。我们选后者:
 *  1. `Menu` 要多一个宿主原语(`anchor` / `portal` / 键盘处理),而我们的探针替身与
 *     平台 shim 都得跟着加一份声明 —— 收益只是箭头图标;
 *  2. 原生 `<select>` 在**键盘、读屏、移动端**上是零成本正确的,而这一页是设置页。
 *
 * ## 每条处理函数都必须是 `useCallback`
 *
 * 本仓 `react/jsx-no-bind` 是 error,且实测**连局部函数标识符都拦**
 * (`function f(){}` / `const f = () => {}` 都报),只有 `useCallback` 的返回值与
 * **成员表达式**放行。所以下面每个组件都把处理函数写成 `useCallback`,
 * 并把用到的 prop 先解构出来(`exhaustive-deps` 不接受「依赖整个 `props` 对象」)。
 *
 * @module dsh-git/client/settings-rows
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives';

/**
 * 一个小节:标题 + 若干行。标题是 `aria-labelledby` 的目标。
 * @param props - 标题 id、标题文案与行。
 * @returns 那个小节。
 */
export function SettingsGroup(props: { readonly id: string; readonly title: string; readonly children: ReactNode }): ReactNode {
  return (
    <section className="gw-settings-group" aria-labelledby={props.id}>
      <h3 className="gw-settings-grouptitle" id={props.id}>{props.title}</h3>
      {props.children}
    </section>
  );
}

/**
 * 一行「标签(+提示)+ 开关」。
 * @param props - 文案 id、标签、提示、当前值、禁用态与写回调。
 * @returns 那一行。
 */
export function SwitchRow(props: {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly onChange: (value: boolean) => void;
}): ReactNode {
  return (
    <div className="gw-settings-row">
      <div className="gw-settings-rowtext">
        <span className="gw-settings-rowlabel" id={props.id}>{props.label}</span>
        {props.hint === undefined ? null : <span className="gw-settings-rowhint">{props.hint}</span>}
      </div>
      <Switch
        checked={props.checked}
        label={props.label}
        disabled={props.disabled ?? false}
        onChange={props.onChange}
      />
    </div>
  );
}

/** 枚举行的一个选项。 */
export interface ISettingsOption<V extends string> {
  readonly value: V;
  readonly label: string;
}

/**
 * 一行「标签(+提示)+ 胶囊下拉」。
 * @param props - 文案、选项表、当前值与写回调。
 * @returns 那一行。
 */
export function SelectRow<V extends string>(props: {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly value: V;
  readonly options: ReadonlyArray<ISettingsOption<V>>;
  readonly disabled?: boolean;
  readonly onPick: (value: V) => void;
}): ReactNode {
  const { options, onPick, id: selectId } = props;
  const onChange = useCallback((event: { target: { value: string } }): void => {
    onPick(event.target.value as V);
  }, [onPick]);
  return (
    <div className="gw-settings-row">
      <div className="gw-settings-rowtext">
        <label className="gw-settings-rowlabel" htmlFor={selectId}>{props.label}</label>
        {props.hint === undefined ? null : <span className="gw-settings-rowhint">{props.hint}</span>}
      </div>
      <select
        id={selectId}
        className="gw-settings-select"
        value={props.value}
        disabled={props.disabled ?? false}
        onChange={onChange}
      >
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </div>
  );
}

/**
 * 一行「标签在上 + 整行文本输入」—— **失焦(或回车)才提交**,与 dsh-context 的
 * `PromptTextRow` 同一手法:每敲一个字符就写一次偏好会让消费方每键重渲染一次。
 * @param props - 文案、当前值、占位符、校验与写回调。
 * @returns 那一行。
 */
export function TextRow(props: {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly value: string;
  readonly placeholder?: string;
  readonly invalid?: string;
  readonly disabled?: boolean;
  readonly onCommit: (value: string) => void;
}): ReactNode {
  const { value, onCommit, id: inputId } = props;
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);

  /** 只在**没在编辑**时跟随外部值,不打断正在输入的用户。 */
  if (!focused && draft !== value) {
    setDraft(value);
  }

  const commit = useCallback((): void => {
    if (draft !== value) {
      onCommit(draft);
    }
  }, [draft, value, onCommit]);
  const onFocus = useCallback((): void => { setFocused(true); }, []);
  const onChange = useCallback((event: { target: { value: string } }): void => {
    setDraft(event.target.value);
  }, []);
  const onBlur = useCallback((): void => { setFocused(false); commit(); }, [commit]);
  const onKeyDown = useCallback((event: { key: string; preventDefault: () => void }): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
    }
  }, [commit]);

  return (
    <div className="gw-settings-row gw-settings-rowwrap">
      <label className="gw-settings-rowlabel" htmlFor={inputId}>{props.label}</label>
      {props.hint === undefined ? null : <span className="gw-settings-rowhint">{props.hint}</span>}
      <input
        id={inputId}
        className="gw-settings-input"
        type="text"
        placeholder={props.placeholder}
        aria-invalid={props.invalid !== undefined || undefined}
        disabled={props.disabled ?? false}
        value={draft}
        onFocus={onFocus}
        onChange={onChange}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
      />
      {props.invalid === undefined ? null : <span className="gw-settings-gerror" role="status">{props.invalid}</span>}
    </div>
  );
}

/**
 * 一行「标签 + 数字输入」。
 *
 * 与 {@link TextRow} 同一手法(失焦/回车提交),多一层整数与范围校验:
 * 非法就**不写**,并在行下给出提示(不静默吞掉)。
 * @param props - 文案、当前值、上下界与写回调。
 * @returns 那一行。
 */
export function NumberRow(props: {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly invalid: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly onCommit: (value: number) => void;
}): ReactNode {
  const { value, min, max, onCommit, id: inputId } = props;
  const [draft, setDraft] = useState(String(value));
  const [focused, setFocused] = useState(false);
  const [invalid, setInvalid] = useState(false);
  if (!focused && draft !== String(value) && !invalid) {
    setDraft(String(value));
  }

  const commit = useCallback((): void => {
    const text = draft.trim();
    if (text === '') {
      setInvalid(false);
      setDraft(String(value));
      return;
    }
    const next = Number(text);
    if (!Number.isInteger(next) || next < min || next > max) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setDraft(String(next));
    onCommit(next);
  }, [draft, value, min, max, onCommit]);
  const onFocus = useCallback((): void => { setFocused(true); }, []);
  const onChange = useCallback((event: { target: { value: string } }): void => {
    setDraft(event.target.value);
    setInvalid(false);
  }, []);
  const onBlur = useCallback((): void => { setFocused(false); commit(); }, [commit]);
  const onKeyDown = useCallback((event: { key: string; preventDefault: () => void }): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
    }
  }, [commit]);

  return (
    <div className="gw-settings-row gw-settings-rowwrap">
      <label className="gw-settings-rowlabel" htmlFor={inputId}>{props.label}</label>
      <span className="gw-settings-rowhint">{props.hint}</span>
      <input
        id={inputId}
        className="gw-settings-input gw-settings-input-number"
        type="text"
        inputMode="numeric"
        aria-invalid={invalid || undefined}
        value={draft}
        onFocus={onFocus}
        onChange={onChange}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
      />
      {invalid ? <span className="gw-settings-gerror" role="status">{props.invalid}</span> : null}
    </div>
  );
}

/**
 * 一行「标签(+提示)+ 按钮」—— 动作用,不是状态用(例如「退出登录」「发送测试通知」)。
 * @param props - 文案、按钮文案、禁用态与动作。
 * @returns 那一行。
 */
export function ActionRow(props: {
  readonly label: string;
  readonly hint?: string;
  readonly actionLabel: string;
  readonly disabled?: boolean;
  readonly onAction: () => void;
}): ReactNode {
  return (
    <div className="gw-settings-row">
      <div className="gw-settings-rowtext">
        <span className="gw-settings-rowlabel">{props.label}</span>
        {props.hint === undefined ? null : <span className="gw-settings-rowhint">{props.hint}</span>}
      </div>
      <button
        type="button"
        className="gw-settings-button"
        disabled={props.disabled ?? false}
        onClick={props.onAction}
      >
        {props.actionLabel}
      </button>
    </div>
  );
}

/**
 * 一行**只读提示**(12px / tertiary)。用于「本次会话已发出 N 条」这类信息。
 * @param props - 内容。
 * @returns 那一行。
 */
export function NoteRow(props: { readonly children: ReactNode }): ReactNode {
  return <p className="gw-settings-note">{props.children}</p>;
}

/**
 * 一次性的「刚发生」提示:显示 `message` 若干毫秒后自己消失(用于登录失败、
 * 保存失败这类一次性反馈 —— dsh-context 的 `.lc-settings-note` 也这么用)。
 * @param props - 要显示的文案;`null` = 什么都不显示。
 * @returns 提示行或 `null`。
 */
export function FlashNote(props: { readonly message: string | null }): ReactNode {
  const { message } = props;
  const [shown, setShown] = useState<string | null>(message);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    setShown(message);
    if (message === null) {
      return undefined;
    }
    timer.current = setTimeout(() => { setShown(null); }, 6000);
    return () => { if (timer.current !== undefined) { clearTimeout(timer.current); } };
  }, [message]);
  return shown === null ? null : <p className="gw-settings-gerror" role="status">{shown}</p>;
}
