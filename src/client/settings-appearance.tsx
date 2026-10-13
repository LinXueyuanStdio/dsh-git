/**
 * 设置页的【外观】分组 —— 主题 / 标签宽度 / 日期·时间·数字格式 / 相对时间。
 *
 * ## 接线来自**弹窗那一份**(共用,不复制)
 *
 * `useAppearanceWiring`(`preferences-pages.tsx`)就是偏好弹窗 `Appearance` 页的读写层:
 * 主题走**宿主 `theme` 服务**(真源是宿主,可能被宿主自己的设置改),三条格式走
 * `models/formatting-preferences.ts` 的 localStorage 偏好,标签宽度走 `prefs.ts` 的
 * `diff-tab-size`。这一页只是把它们画成宿主风格的行 —— 键名、默认值、订阅一份都不复制。
 *
 * ## 选项表也来自镜像,不自造
 *
 * 日期 / 时间格式的选项表是 `dateFormats` / `timeFormats`(label 就是上游的
 * `{example} ({pattern})`),数字格式是 `numberFormats`(label 是
 * `formatNumber(1234567.89, format)` 的渲染结果)—— 与上游 `appearance.tsx:256-289`
 * **逐字同一个口径**,所以同一份偏好在两处显示成同一个样子。
 *
 * @module dsh-git/client/settings-appearance
 */

import { useCallback } from 'react';
import type { ReactNode } from 'react';
import {
  dateFormats, numberFormats, numberFormatFromKey, numberFormatToKey, timeFormats,
  type DateFormat, type INumberFormat, type TimeFormat,
} from '../core/desktop/models/formatting-preferences.ts';
import { formatNumber } from '../core/desktop/lib/format-number.ts';
import { ApplicationTheme } from '../core/desktop/ui/lib/application-theme.ts';
import type { Translate } from './i18n.ts';
import { useAppearanceWiring } from './preferences-pages.tsx';
import { SelectRow, SettingsGroup, SwitchRow, type ISettingsOption } from './settings-rows.tsx';

/** 上游 `appearance.tsx:306` 的可用标签宽度,逐字。 */
const AVAILABLE_TAB_SIZES: readonly number[] = [1, 2, 3, 4, 5, 6, 8, 10, 12];

/**
 * 【外观】分组。
 * @param props - 文案函数与「偏好变了」回调。
 * @returns 那一组。
 */
export function SettingsAppearanceGroup(props: { readonly t: Translate; readonly onPreferencesChanged: () => void }): ReactNode {
  const { t, onPreferencesChanged } = props;
  const appearance = useAppearanceWiring(onPreferencesChanged);
  /* 先解构:`exhaustive-deps` 不接受「依赖整个 appearance 对象」(实测报它)。 */
  const {
    onSelectedThemeChanged, onSelectedTabSizeChanged, onSelectedDateFormatChanged,
    onSelectedTimeFormatChanged, onSelectedNumberFormatChanged,
  } = appearance;

  const onPickTheme = useCallback((value: string) => {
    onSelectedThemeChanged(value as ApplicationTheme);
  }, [onSelectedThemeChanged]);
  const onPickTabSize = useCallback((value: string) => {
    onSelectedTabSizeChanged(Number(value));
  }, [onSelectedTabSizeChanged]);
  const onPickDateFormat = useCallback((value: string) => {
    onSelectedDateFormatChanged(value as DateFormat);
  }, [onSelectedDateFormatChanged]);
  const onPickTimeFormat = useCallback((value: string) => {
    onSelectedTimeFormatChanged(value as TimeFormat);
  }, [onSelectedTimeFormatChanged]);
  const onPickNumberFormat = useCallback((value: string) => {
    onSelectedNumberFormatChanged(numberFormatFromKey(value));
  }, [onSelectedNumberFormatChanged]);

  const themeOptions: ReadonlyArray<ISettingsOption<string>> = [
    { value: ApplicationTheme.Light, label: t('settings.theme.light') },
    { value: ApplicationTheme.Dark, label: t('settings.theme.dark') },
    { value: ApplicationTheme.System, label: t('settings.theme.system') },
  ];
  const tabSizeOptions: ReadonlyArray<ISettingsOption<string>> =
    AVAILABLE_TAB_SIZES.map((size) => ({ value: String(size), label: String(size) }));
  const dateOptions: ReadonlyArray<ISettingsOption<string>> =
    dateFormats.map(({ pattern, example }) => ({ value: pattern, label: `${example} (${pattern})` }));
  const timeOptions: ReadonlyArray<ISettingsOption<string>> =
    timeFormats.map(({ pattern, example }) => ({ value: pattern, label: `${example} (${pattern})` }));
  const numberOptions: ReadonlyArray<ISettingsOption<string>> =
    numberFormats.map((format: INumberFormat) => ({
      value: numberFormatToKey(format),
      label: formatNumber(1234567.89, format),
    }));

  return (
    <SettingsGroup id="gw-settings-appearance" title={t('settings.group.appearance')}>
      <SelectRow
        id="gw-settings-theme"
        label={t('settings.theme')}
        hint={t('settings.theme.hint')}
        value={appearance.selectedTheme}
        options={themeOptions}
        onPick={onPickTheme}
      />
      <SelectRow
        id="gw-settings-tab-size"
        label={t('settings.tabSize')}
        hint={t('settings.tabSize.hint')}
        value={String(appearance.selectedTabSize)}
        options={tabSizeOptions}
        onPick={onPickTabSize}
      />
      <SelectRow
        id="gw-settings-date-format"
        label={t('settings.dateFormat')}
        value={appearance.selectedDateFormat}
        options={dateOptions}
        onPick={onPickDateFormat}
      />
      <SelectRow
        id="gw-settings-time-format"
        label={t('settings.timeFormat')}
        value={appearance.selectedTimeFormat}
        options={timeOptions}
        onPick={onPickTimeFormat}
      />
      <SelectRow
        id="gw-settings-number-format"
        label={t('settings.numberFormat')}
        value={numberFormatToKey(appearance.selectedNumberFormat)}
        options={numberOptions}
        onPick={onPickNumberFormat}
      />
      {/* 开关的语义与偏好**同向**(不做取反):上游那一行就是「优先绝对日期」的复选框。 */}
      <SwitchRow
        id="gw-settings-absolute-dates"
        label={t('settings.preferAbsoluteDates')}
        hint={t('settings.preferAbsoluteDates.hint')}
        checked={appearance.preferAbsoluteDates}
        onChange={appearance.onPreferAbsoluteDatesChanged}
      />
    </SettingsGroup>
  );
}
