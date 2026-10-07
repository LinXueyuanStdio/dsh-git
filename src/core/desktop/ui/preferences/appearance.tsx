import * as React from 'react'
import {
  ApplicationTheme,
  supportsSystemThemeChanges,
  getCurrentlyAppliedTheme,
} from '../lib/application-theme'
import { Row } from '../lib/row'
import { DialogContent } from '../dialog'
import { RadioGroup } from '../lib/radio-group'
import { Select } from '../lib/select'
import { Checkbox, CheckboxValue } from '../lib/checkbox'
/*
 * --- 有意偏离(本轮唯一一处;登记在 `scripts/verify-mirror.mjs` 的 EXPECTED)---
 *
 * **上游原文**:
 *   import { encodePathAsUrl } from '../../lib/path'
 *   const darkThemeImage = encodePathAsUrl(__dirname, 'static/ghd_dark.svg')
 *   const lightThemeImage = encodePathAsUrl(__dirname, 'static/ghd_light.svg')
 *
 * **这里**:两张图改成**静态 import**,由 `scripts/build.mjs` 的
 * `loader: { '.svg': 'dataurl' }` 在构建期内联成 data URL。
 *
 * **为什么上游那条路在我们这儿必然裂图**(实测,不是推断):
 * `lib/path.ts:10` 是 `pathToFileURL(Path.resolve(...))`,而浏览器半的
 * `src/client/shim-node-url.ts:36-38` 的 `pathToFileURL` **返回原串** ⇒ 产出的
 * `src` 是**根相对 HTTP 路径** `/dsh-git-diff/static/ghd_light.svg`
 * (`__dirname` = `/dsh-git-diff`,同上目录的 `desktop-globals.ts:45`);
 * 宿主只注册了 `/dsh-git` 前缀(`src/host/routes.ts:22`)⇒ 那个请求必然 403/404 ⇒
 * 三张 `<img>` 的 `naturalWidth` 恒为 **0**(用户看到的裂图)。
 * ⚠️ 注意:它**不是** `file://`;`file://` 只是探针页的 base 把那个相对路径解析出来的
 * 结果。判据见 `docs/probes/appearance-theme-swatch-probe.mjs`。
 *
 * **为什么不改 `lib/path.ts` 的 `encodePathAsUrl`**(评估过,结论是**不该**):
 * ① 那条 `src` 是**运行期拼出来的字符串**,任何构建期 loader 都碰不到它 ——
 *    全局改法只能让 `shim-node-url.pathToFileURL` 返回一个**猜出来**的路径
 *    (`/dsh-git/static/...`),那还需要**新增一条宿主静态路由**,而宿主改动要重启应用;
 * ② 更关键:`encodePathAsUrl` 还有 6 个**同类但不同结论**的调用点
 *    (`ui/diff/index.tsx:38` 的 `NoDiffImage`、`ui/changes/no-changes.tsx:54`、
 *    `ui/repositories-list/repositories-list.tsx:31` 等),它们是 goal 文档 §5
 *    已登记的「**不是**缺陷」现象,全局改动会把这 7 处**一起**换掉 ——
 *    修一处用户可见的裂图,顺手改掉 6 处已裁定的现状 = 越权。
 * ⇒ 偏离落在**调用点**,范围恰好 = 用户报的那 5 个 `<img>`。
 */
import ghdDarkThemeImage from '../../static/common/ghd_dark.svg'
import ghdLightThemeImage from '../../static/common/ghd_light.svg'
import { tabSizeDefault } from '../../lib/stores/app-store'
import { enableFormattingPreferences } from '../../lib/feature-flag'
import {
  DateFormat,
  TimeFormat,
  INumberFormat,
  dateFormats,
  timeFormats,
  numberFormats,
  numberFormatToKey,
} from '../../models/formatting-preferences'
import { formatNumber } from '../../lib/format-number'

interface IAppearanceProps {
  readonly selectedTheme: ApplicationTheme
  readonly onSelectedThemeChanged: (theme: ApplicationTheme) => void
  readonly selectedTabSize: number
  readonly onSelectedTabSizeChanged: (tabSize: number) => void
  readonly alwaysShowWorktreeList: boolean
  readonly onAlwaysShowWorktreeListChanged: (value: boolean) => void
  readonly selectedDateFormat: DateFormat
  readonly onSelectedDateFormatChanged: (format: DateFormat) => void
  readonly selectedTimeFormat: TimeFormat
  readonly onSelectedTimeFormatChanged: (format: TimeFormat) => void
  readonly selectedNumberFormat: INumberFormat
  readonly onSelectedNumberFormatChanged: (format: INumberFormat) => void
  readonly preferAbsoluteDates: boolean
  readonly onPreferAbsoluteDatesChanged: (value: boolean) => void
}

interface IAppearanceState {
  readonly selectedTheme: ApplicationTheme | null
  readonly selectedTabSize: number
}

export class Appearance extends React.Component<
  IAppearanceProps,
  IAppearanceState
> {
  public constructor(props: IAppearanceProps) {
    super(props)

    const usePropTheme =
      props.selectedTheme !== ApplicationTheme.System ||
      supportsSystemThemeChanges()

    this.state = {
      selectedTheme: usePropTheme ? props.selectedTheme : null,
      selectedTabSize: props.selectedTabSize,
    }

    if (!usePropTheme) {
      this.initializeSelectedTheme()
    }
  }

  public async componentDidUpdate(prevProps: IAppearanceProps) {
    if (prevProps === this.props) {
      return
    }

    const usePropTheme =
      this.props.selectedTheme !== ApplicationTheme.System ||
      supportsSystemThemeChanges()

    const selectedTheme = usePropTheme
      ? this.props.selectedTheme
      : await getCurrentlyAppliedTheme()

    const selectedTabSize = this.props.selectedTabSize

    this.setState({ selectedTheme, selectedTabSize })
  }

  private initializeSelectedTheme = async () => {
    const selectedTheme = await getCurrentlyAppliedTheme()
    const selectedTabSize = this.props.selectedTabSize
    this.setState({ selectedTheme, selectedTabSize })
  }

  private onSelectedThemeChanged = (theme: ApplicationTheme) => {
    this.props.onSelectedThemeChanged(theme)
  }

  private onSelectedTabSizeChanged = (
    event: React.FormEvent<HTMLSelectElement>
  ) => {
    this.props.onSelectedTabSizeChanged(parseInt(event.currentTarget.value))
  }

  private onDateFormatChanged = (event: React.FormEvent<HTMLSelectElement>) => {
    const value = event.currentTarget.value
    const match = dateFormats.find(f => f.pattern === value)
    if (match !== undefined) {
      this.props.onSelectedDateFormatChanged(match.pattern)
    }
  }

  private onTimeFormatChanged = (event: React.FormEvent<HTMLSelectElement>) => {
    const value = event.currentTarget.value
    const match = timeFormats.find(f => f.pattern === value)
    if (match !== undefined) {
      this.props.onSelectedTimeFormatChanged(match.pattern)
    }
  }

  private onNumberFormatChanged = (
    event: React.FormEvent<HTMLSelectElement>
  ) => {
    const match = numberFormats.find(
      n => numberFormatToKey(n) === event.currentTarget.value
    )
    if (match) {
      this.props.onSelectedNumberFormatChanged(match)
    }
  }

  private onPreferAbsoluteDatesChanged = (
    event: React.FormEvent<HTMLInputElement>
  ) => {
    this.props.onPreferAbsoluteDatesChanged(event.currentTarget.checked)
  }

  private onAlwaysShowWorktreeListChanged = (
    event: React.FormEvent<HTMLInputElement>
  ) => {
    this.props.onAlwaysShowWorktreeListChanged(event.currentTarget.checked)
  }

  public renderThemeSwatch = (theme: ApplicationTheme) => {
    const darkThemeImage = ghdDarkThemeImage
    const lightThemeImage = ghdLightThemeImage

    switch (theme) {
      case ApplicationTheme.Light:
        return (
          <span>
            <img src={lightThemeImage} alt="" />
            <span className="theme-value-label">浅色</span>
          </span>
        )
      case ApplicationTheme.Dark:
        return (
          <span>
            <img src={darkThemeImage} alt="" />
            <span className="theme-value-label">深色</span>
          </span>
        )
      case ApplicationTheme.System:
        /** Why three images? The system theme swatch uses the first image
         * positioned relatively to get the label container size and uses the
         * second and third positioned absolutely over first and third one
         * clipped in half to render a split dark and light theme swatch. */
        return (
          <span>
            <span className="system-theme-swatch">
              <img src={lightThemeImage} alt="" />
              <img src={lightThemeImage} alt="" />
              <img src={darkThemeImage} alt="" />
            </span>
            <span className="theme-value-label">跟随系统</span>
          </span>
        )
    }
  }

  private renderSelectedTheme() {
    const selectedTheme = this.state.selectedTheme

    if (selectedTheme == null) {
      return <Row>正在读取系统主题</Row>
    }

    const themes = [
      ApplicationTheme.Light,
      ApplicationTheme.Dark,
      ...(supportsSystemThemeChanges() ? [ApplicationTheme.System] : []),
    ]

    return (
      <div className="appearance-section">
        <h2 id="theme-heading">主题</h2>

        <RadioGroup<ApplicationTheme>
          ariaLabelledBy="theme-heading"
          className="theme-selector"
          selectedKey={selectedTheme}
          radioButtonKeys={themes}
          onSelectionChanged={this.onSelectedThemeChanged}
          renderRadioButtonLabelContents={this.renderThemeSwatch}
        />
      </div>
    )
  }

  private renderFormatting() {
    if (!enableFormattingPreferences()) {
      return null
    }

    return (
      <div className="appearance-section formatting-section">
        <h2 id="formatting-heading">格式</h2>

        <Row>
          <Select
            label={__DARWIN__ ? '日期格式' : '日期格式'}
            value={this.props.selectedDateFormat}
            onChange={this.onDateFormatChanged}
          >
            {dateFormats.map(({ pattern, example }) => (
              <option key={pattern} value={pattern}>
                {example} ({pattern})
              </option>
            ))}
          </Select>

          <Select
            label={__DARWIN__ ? '时间格式' : '时间格式'}
            value={this.props.selectedTimeFormat}
            onChange={this.onTimeFormatChanged}
          >
            {timeFormats.map(({ pattern, example }) => (
              <option key={pattern} value={pattern}>
                {example} ({pattern})
              </option>
            ))}
          </Select>
        </Row>

        <Select
          label={__DARWIN__ ? '数字格式' : '数字格式'}
          value={numberFormatToKey(this.props.selectedNumberFormat)}
          onChange={this.onNumberFormatChanged}
        >
          {numberFormats.map(format => (
            <option
              key={numberFormatToKey(format)}
              value={numberFormatToKey(format)}
            >
              {formatNumber(1234567.89, format)}
            </option>
          ))}
        </Select>

        <Checkbox
          className="prefer-absolute-dates"
          label="优先显示绝对日期,而不是相对日期"
          value={
            this.props.preferAbsoluteDates
              ? CheckboxValue.On
              : CheckboxValue.Off
          }
          onChange={this.onPreferAbsoluteDatesChanged}
        />
      </div>
    )
  }

  private renderMiscellaneous() {
    const availableTabSizes: number[] = [1, 2, 3, 4, 5, 6, 8, 10, 12]

    return (
      <div className="appearance-section">
        <h2 id="miscellaneous-heading">其它</h2>

        <Select
          value={this.state.selectedTabSize.toString()}
          label={__DARWIN__ ? 'Diff 制表符宽度' : 'Diff 制表符宽度'}
          onChange={this.onSelectedTabSizeChanged}
        >
          {availableTabSizes.map(n => (
            <option key={n} value={n}>
              {n === tabSizeDefault ? `${n} (默认)` : n}
            </option>
          ))}
        </Select>

        <Checkbox
          className="always-show-worktree-list"
          label="始终显示 worktree 列表"
          value={
            this.props.alwaysShowWorktreeList
              ? CheckboxValue.On
              : CheckboxValue.Off
          }
          onChange={this.onAlwaysShowWorktreeListChanged}
        />
      </div>
    )
  }

  public render() {
    return (
      <DialogContent>
        {this.renderSelectedTheme()}
        {this.renderFormatting()}
        {this.renderMiscellaneous()}
      </DialogContent>
    )
  }
}
