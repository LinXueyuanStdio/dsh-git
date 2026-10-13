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
 * ## 分组(顺序沿用旧卡片的页签顺序)
 *
 * | 分组 | 内容 | 接线 |
 * |---|---|---|
 * | 通用 | 界面缩放 | `prefs-bus.ts` + `hooks.fontScaleValue` |
 * | 账号 | 登录态 / 登录 / 退出登录 | `store`(见 `settings-account.tsx`) |
 * | Git | 姓名 / 邮箱 / 默认分支 | 全局 git config(`settings-git.tsx`) |
 * | 外观 | 主题 / 标签宽度 / 日期·时间·数字格式 / 绝对日期 | `useAppearanceWiring`(`settings-appearance.tsx`) |
 * | 通知 | 启用高信号通知 / 发送测试通知 / 已发出条数 | `notify.ts` |
 * | 提示与确认 | 5 个确认开关 | `usePromptsWiring` |
 * | Diff 与无障碍 | diff 勾选标记 / 链接下划线 | `useAccessibilityWiring` |
 * | 插件配置(宿主设置文档) | Pulls 自动刷新周期 | 宿主 `Config`(`autoSec`)+ `SettingsForm` |
 *
 * ## 共用的是**接线**,不是 UI
 *
 * `useAppearanceWiring` / `useAccessibilityWiring` / `usePromptsWiring` 本来就住在
 * `preferences-pages.tsx` 的「与外壳无关的那一半」里,偏好弹窗与这一页**共用同一份
 * 读写 + 订阅**,所以两处永远不会漂移。这里没有复制任何一条偏好的键名或默认值。
 *
 * ## 为什么「当场生效」的开关不需要「保存」,而 `autoSec` 需要
 *
 * 前者写 localStorage + 广播,消费方同帧重渲染;后者是宿主**配置文档**里的字段,
 * 必须经过宿主的 `SettingsFormModel` 暂存 / 保存。两套写入语义混进同一张表单是本仓
 * 点过名的坑,所以 `autoSec` 自成最后一组、自带保存条。
 *
 * 行的形状(标签左 / 控件右 / 胶囊下拉 / 分组标题 + 细分隔线)与逐条依据见
 * `./settings-rows.tsx` 的文件头。
 *
 * @module dsh-git/client/settings-page
 */

import { useCallback, useId, useState } from 'react';
import type { ReactNode } from 'react';
import { SettingsForm, SettingsValueField } from '@deepseek-ai/dsh-client-ui-primitives';
import type { SettingsFormLabels } from '@deepseek-ai/dsh-client-ui-primitives';
import type { DshGitSettingsProps } from './settings-controller.ts';
import { SettingsAccountGroup } from './settings-account.tsx';
import { SettingsAppearanceGroup } from './settings-appearance.tsx';
import { SettingsGitGroup } from './settings-git.tsx';
import {
  ActionRow, FlashNote, NoteRow, NumberRow, SettingsGroup, SwitchRow,
} from './settings-rows.tsx';
import { useAccessibilityWiring, usePromptsWiring } from './preferences-pages.tsx';
import { FONT_SCALE_DEFAULT, FONT_SCALE_MAX } from './prefs-bus.ts';
import { describeNotificationOutcome } from './notifications-panel.tsx';
import {
  getNotificationsSent, notificationsSupported, notifyTest, setNotificationsEnabled, useNotificationsEnabled,
} from './notify.ts';

/**
 * 宿主配置表单的外壳文案(逐条来自本插件的字典)。
 * @param t - 命名空间 `dsh-git` 的翻译函数。
 * @returns 宿主 `SettingsFormLabels`。
 */
function formLabels(t: DshGitSettingsProps['t']): SettingsFormLabels {
  return {
    unavailable: t('settings.form.unavailable'),
    readOnly: t('settings.form.readOnly'),
    saveFailed: t('settings.form.saveFailed'),
    save: t('settings.form.save'),
    saving: t('settings.form.saving'),
  };
}

/**
 * 渲染整页设置(见文件头的分组表)。
 * @param props - 设置面注入面(`t` / 宿主表单状态与写动作 / store / 偏好写回调)。
 * @returns 设置页。
 */
export function DshGitSettingsPage(props: DshGitSettingsProps): ReactNode {
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
  /** 「本次会话已发出 N 条」—— 发过一次之后要跟着涨,所以进 state。 */
  const [sentCount, setSentCount] = useState(getNotificationsSent);
  const [testOutcome, setTestOutcome] = useState<string | null>(null);

  const base = useId();
  const id = (name: string): string => `${base}-${name}`;
  const disabled = !state.writable;
  /* 依赖必须写成具体成员,不能是 `props`(`react-hooks/exhaustive-deps` 的要求)。 */
  const { onFontScale, onPreferencesChanged, store } = props;

  /** 字号那一行的提交:写偏好 + 通知外壳。 */
  const onFontScaleCommit = useCallback((value: number): void => {
    onFontScale(value);
    onPreferencesChanged();
  }, [onFontScale, onPreferencesChanged]);
  /** 通知开关:写偏好 + 通知外壳。 */
  const onNotificationsChanged = useCallback((value: boolean): void => {
    setNotificationsEnabled(value);
    onPreferencesChanged();
  }, [onPreferencesChanged]);
  /** 发一条测试通知,并把结果原样说给用户(可读文案来自 `describeNotificationOutcome`)。 */
  const onSendTest = useCallback((): void => {
    const outcome = notifyTest();
    setTestOutcome(describeNotificationOutcome(outcome));
    setSentCount(getNotificationsSent());
  }, []);

  return (
    <div className="gw-settings">
      <SettingsGroup id={id('general')} title={t('settings.group.general')}>
        <NumberRow
          id={id('font-scale')}
          label={t('settings.fontScale')}
          hint={t('settings.fontScale.hint')}
          invalid={t('settings.fontScale.invalid')}
          value={fontScale}
          min={FONT_SCALE_DEFAULT}
          max={FONT_SCALE_MAX}
          onCommit={onFontScaleCommit}
        />
      </SettingsGroup>

      <SettingsAccountGroup t={t} store={store} onPreferencesChanged={onPreferencesChanged} />
      <SettingsGitGroup t={t} onPreferencesChanged={onPreferencesChanged} />
      <SettingsAppearanceGroup t={t} onPreferencesChanged={onPreferencesChanged} />

      <SettingsGroup id={id('notifications')} title={t('settings.group.notifications')}>
        <SwitchRow
          id={id('notifications-enabled')}
          label={t('settings.notifications')}
          hint={t('settings.notifications.hint')}
          checked={notificationsEnabled}
          onChange={onNotificationsChanged}
        />
        <ActionRow
          label={t('settings.notifications.test')}
          hint={t('settings.notifications.test.hint')}
          actionLabel={t('settings.notifications.test.action')}
          disabled={!notificationsSupported()}
          onAction={onSendTest}
        />
        <NoteRow>{t('settings.notifications.sent', { n: String(sentCount) })}</NoteRow>
        <FlashNote message={testOutcome} />
      </SettingsGroup>

      <SettingsGroup id={id('prompts')} title={t('settings.group.prompts')}>
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
      </SettingsGroup>

      <SettingsGroup id={id('diff')} title={t('settings.group.diff')}>
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
      </SettingsGroup>

      {/*
        ⚠️ **单独一组、自带保存条**:`autoSec` 是宿主**配置文档**里的字段(写 profile 的
        `cordis.patch.yml`),与上面那些「当场生效」的 localStorage 偏好**不是同一类东西**。
        把两种写入语义塞进同一张表单是本仓点过名的坑,所以这里只共享页面,不共享表单。
      */}
      <SettingsGroup id={id('host-config')} title={t('settings.group.hostConfig')}>
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
      </SettingsGroup>
    </div>
  );
}
