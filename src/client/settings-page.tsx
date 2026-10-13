/**
 * dsh-git 在**宿主插件页详情**里的设置页 —— DSH 宿主风格的**行列表**。
 *
 * ## 为什么不是那几个 Preferences 页面
 *
 * 2026-10-13 用户裁决:这个席位里**不再复用** `preferences-pages.tsx` 的
 * `PreferencesPageBody`(那是 GitHub Desktop 的逐字节复刻面,自带 `#preferences`
 * 作用域根与一套 Desktop 变量桥);设置页要**和 DSH 宿主的界面风格统一**,
 * 参考实现是 `references/dsh-context/src/client/components/settingsCard.tsx`。
 *
 * ⇒ 这一页只呈现**插件自己的偏好**,一行一个:
 *
 * | 分组 | 行 | 偏好真源 |
 * |---|---|---|
 * | 通用 | 界面缩放 | `prefs-bus.ts`(`FONT_SCALE_*`) |
 * | Diff 与无障碍 | 在 diff 里显示勾选标记 / 链接加下划线 | `diff-mode.ts` / `preferences-pages.tsx` 的 `useAccessibilityWiring` |
 * | 通知 | 启用高信号通知 | `notify.ts` 的 `useNotificationsEnabled` |
 * | 提示与确认 | 5 个确认开关 | `usePromptsWiring` |
 * | 插件配置(宿主设置文档) | Pulls 自动刷新周期 | host `Config`(`autoSec`,走 `SettingsForm`) |
 *
 * ## 共用的是**接线**,不是 UI
 *
 * `useAccessibilityWiring` / `usePromptsWiring` 本来就住在
 * `preferences-pages.tsx` 的「与外壳无关的那一半」里(那一节的文件头写明了边界),
 * 弹窗与这一页**共用同一份读写 + 订阅**,所以两处永远不会漂移。
 * 这里没有复制任何一条偏好的键名或默认值。
 *
 * ## 为什么两个开关(勾选标记 / 通知)不需要「保存」
 *
 * 它们**当场生效**(写 localStorage + 广播,消费方同帧重渲染)。
 * 只有 `autoSec` 是宿主**配置文档**里的字段,必须经过宿主的
 * `SettingsFormModel` 暂存 / 保存 —— 所以它是最后一组、自带保存条,
 * **不**和上面那些开关混在同一张表单里(两套写入语义混在一张表单里是本仓点过名的坑)。
 *
 * @module dsh-git/client/settings-page
 */

import { useCallback, useId, useState } from 'react';
import type { ReactNode } from 'react';
import { SettingsForm, SettingsValueField, Switch } from '@deepseek-ai/dsh-client-ui-primitives';
import type { SettingsFormLabels } from '@deepseek-ai/dsh-client-ui-primitives';
import type { DshGitCardProps } from './host-settings-card.ts';
import { useAccessibilityWiring, usePromptsWiring } from './preferences-pages.tsx';
import { FONT_SCALE_DEFAULT, FONT_SCALE_MAX } from './prefs-bus.ts';
import { setNotificationsEnabled, useNotificationsEnabled } from './notify.ts';

/**
 * 宿主配置表单的外壳文案(逐条来自本插件的字典)。
 * @param t - 命名空间 `dsh-git` 的翻译函数。
 * @returns 宿主 `SettingsFormLabels`。
 */
function formLabels(t: DshGitCardProps['t']): SettingsFormLabels {
  return {
    unavailable: t('settings.form.unavailable'),
    readOnly: t('settings.form.readOnly'),
    saveFailed: t('settings.form.saveFailed'),
    save: t('settings.form.save'),
    saving: t('settings.form.saving'),
  };
}

/**
 * 一行「标签 + 开关」。
 *
 * 控件用宿主的 `Switch`(`role="switch"`,`aria-label` 必填 —— 上游就是为「渲染点不能
 * 省掉无障碍名」这么设计的),与宿主自己的设置行同一套控件。
 * @param props - 文案、当前值、写回调与禁用态。
 * @returns 那一行。
 */
function SwitchRow(props: {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly onChange: (value: boolean) => void;
}): ReactNode {
  const hintId = `${props.id}-hint`;
  return (
    <div className="gw-settings-row">
      <div className="gw-settings-rowtext">
        <span className="gw-settings-rowlabel" id={props.id}>{props.label}</span>
        {props.hint === undefined ? null : (
          <span className="gw-settings-rowhint" id={hintId}>{props.hint}</span>
        )}
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

/**
 * 一行「标签 + 数字输入」。
 *
 * 与 dsh-context 的 `PromptTextRow` 同一手法:**草稿在本地,失焦(或回车)才写**
 * —— 每敲一个字符就写一次偏好会让消费方每键重渲染一次。
 * 写失败(越界)时**不写**,并在行下给出提示;再次聚焦时草稿回到当前生效值。
 * @param props - 标签 / 提示 / 当前值 / 上下界 / 写回调。
 * @returns 那一行。
 */
function NumberRow(props: {
  readonly label: string;
  readonly hint: string;
  readonly invalid: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly onCommit: (value: number) => void;
}): ReactNode {
  const inputId = useId();
  /* 解构出真正用到的几项:`exhaustive-deps` 不接受「依赖整个 props 对象」(实测报它)。 */
  const { value, min, max, onCommit } = props;
  const [draft, setDraft] = useState(String(value));
  const [focused, setFocused] = useState(false);
  const [invalid, setInvalid] = useState(false);
  // 只在**没在编辑**时跟随外部值(宿主改 / 别处改),不打断正在输入的用户。
  if (!focused && draft !== String(value) && !invalid) {
    setDraft(String(value));
  }

  /** 提交草稿:合法才写,非法就只留提示(不写、不静默吞掉)。 */
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
    onCommit(next);
  }, [draft, value, min, max, onCommit]);

  /*
   * ⚠️ 四个处理函数必须是 `useCallback`(局部 `const f = () => …` 与 `function f() {}`
   * 都会被 `react/jsx-no-bind` 抓 —— 实测:只有 `useCallback` 的返回值与**成员表达式**
   * 两种形状放行)。理由与实测见 `docs/host-settings-card.md` §14.5。
   */
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
        className="gw-settings-number"
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
 * 一个小节:标题 + 若干行。标题是 `aria-labelledby` 的目标,行顺序即阅读顺序。
 * @param props - 标题 id、标题文案与行。
 * @returns 那个小节。
 */
function Group(props: { readonly id: string; readonly title: string; readonly children: ReactNode }): ReactNode {
  return (
    <section className="gw-settings-group" aria-labelledby={props.id}>
      <h3 className="gw-settings-grouptitle" id={props.id}>{props.title}</h3>
      {props.children}
    </section>
  );
}

/**
 * 渲染整页设置(见文件头的分组表)。
 * @param props - 卡片注入面(`t` / 宿主表单状态与写动作 / 偏好写回调)。
 * @returns 设置页。
 */
export function DshGitSettingsPage(props: DshGitCardProps): ReactNode {
  const { t } = props;
  const state = props.useDshGitSettings((snapshot) => snapshot);
  /**
   * 界面缩放的当前值。
   *
   * ⚠️ `?? FONT_SCALE_DEFAULT` 不只是兜底,它是**正确性**:缺席的 observable 会让钩子
   * 返回 `undefined`,而选择器钩子用 `Object.is` 比较 —— 非原始值的抖动会让
   * `useSyncExternalStore` 每次渲染都判定「变了」⇒ 无限重渲染(本仓实测踩过)。
   */
  const fontScale = props.useFontScaleValue((value) => value ?? FONT_SCALE_DEFAULT);
  /** 两条「当场生效」的显示类偏好(与弹窗共用同一份接线)。 */
  const a11y = useAccessibilityWiring(props.onPreferencesChanged);
  /** 「提示与确认」的 5 条(同上)。 */
  const prompts = usePromptsWiring(props.onPreferencesChanged);
  /** 通知开关(宿主 Web Notifications;`notify.ts` 自带订阅)。 */
  const notificationsEnabled = useNotificationsEnabled();

  const base = useId();
  const id = (name: string): string => `${base}-${name}`;
  const disabled = !state.writable;
  /* 同上:依赖必须写成具体成员,不能是 `props`。 */
  const { onFontScale, onPreferencesChanged } = props;
  /** 字号那一行的提交:写偏好 + 通知外壳(必须是 `useCallback`,见 `NumberRow` 里的说明)。 */
  const onFontScaleCommit = useCallback((value: number): void => {
    onFontScale(value);
    onPreferencesChanged();
  }, [onFontScale, onPreferencesChanged]);
  /** 通知开关:写偏好 + 通知外壳。 */
  const onNotificationsChanged = useCallback((value: boolean): void => {
    setNotificationsEnabled(value);
    onPreferencesChanged();
  }, [onPreferencesChanged]);

  return (
    <div className="gw-settings">
      <Group id={id('general')} title={t('settings.group.general')}>
        <NumberRow
          label={t('settings.fontScale')}
          hint={t('settings.fontScale.hint')}
          invalid={t('settings.fontScale.invalid')}
          value={fontScale}
          min={FONT_SCALE_DEFAULT}
          max={FONT_SCALE_MAX}
          onCommit={onFontScaleCommit}
        />
      </Group>

      <Group id={id('diff')} title={t('settings.group.diff')}>
        <SwitchRow
          id={id('diff-check-marks')}
          label={t('settings.diffCheckMarks')}
          hint={t('settings.diffCheckMarks.hint')}
          checked={a11y.showDiffCheckMarks}
          onChange={a11y.onShowDiffCheckMarksChanged}
        />
        <SwitchRow
          id={id('underline-links')}
          label={t('settings.underlineLinks')}
          hint={t('settings.underlineLinks.hint')}
          checked={a11y.underlineLinks}
          onChange={a11y.onUnderlineLinksChanged}
        />
      </Group>

      <Group id={id('notifications')} title={t('settings.group.notifications')}>
        <SwitchRow
          id={id('notifications-enabled')}
          label={t('settings.notifications')}
          hint={t('settings.notifications.hint')}
          checked={notificationsEnabled}
          onChange={onNotificationsChanged}
        />
      </Group>

      <Group id={id('prompts')} title={t('settings.group.prompts')}>
        <SwitchRow
          id={id('confirm-discard-changes')}
          label={t('settings.confirmDiscardChanges')}
          checked={prompts.confirmDiscardChanges}
          onChange={prompts.onConfirmDiscardChangesChanged}
        />
        <SwitchRow
          id={id('confirm-discard-stash')}
          label={t('settings.confirmDiscardStash')}
          checked={prompts.confirmDiscardStash}
          onChange={prompts.onConfirmDiscardStashChanged}
        />
        <SwitchRow
          id={id('confirm-undo-commit')}
          label={t('settings.confirmUndoCommit')}
          checked={prompts.confirmUndoCommit}
          onChange={prompts.onConfirmUndoCommitChanged}
        />
        <SwitchRow
          id={id('confirm-commit-filtered')}
          label={t('settings.confirmCommitFiltered')}
          checked={prompts.askForConfirmationOnCommitFilteredChanges}
          onChange={prompts.onAskForConfirmationOnCommitFilteredChanges}
        />
        <SwitchRow
          id={id('commit-length-warning')}
          label={t('settings.commitLengthWarning')}
          checked={prompts.showCommitLengthWarning}
          onChange={prompts.onShowCommitLengthWarningChanged}
        />
      </Group>

      {/*
        ⚠️ **单独一组、自带保存条**:`autoSec` 是宿主**配置文档**里的字段(写 profile 的
        `cordis.patch.yml`),与上面那些「当场生效」的 localStorage 偏好**不是同一类东西**。
        把两种写入语义塞进同一张表单是本仓点过名的坑,所以这里只共享页面,不共享表单。
      */}
      <Group id={id('host-config')} title={t('settings.group.hostConfig')}>
        <SettingsForm
          labels={formLabels(t)}
          state={state}
          onSave={props.save}
          onDiscard={props.discard}
        >
          <SettingsValueField
            id="plugin-config-dsh-git-auto-sec"
            label={t('settings.autoSec')}
            hint={t('settings.autoSec.hint')}
            overriddenLabel={t('settings.form.overridden')}
            resetLabel={t('settings.form.reset')}
            invalidLabel={t('settings.autoSec.invalid')}
            numeric={true}
            disabled={disabled}
            {...state.autoSec}
            onEdit={props.editAutoSec}
            onReset={props.resetAutoSec}
          />
        </SettingsForm>
      </Group>
    </div>
  );
}
