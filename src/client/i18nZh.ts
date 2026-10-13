/**
 * 中文(简体)字典 —— **键集真源**:`DictKey` 从这张表推导,`i18nEn.ts` 由它钉住
 * (`satisfies Record<DictKey, string>`),少一条键就编译不过。
 *
 * 形状逐字照 `references/dsh-context/src/client/i18nZh.ts`:
 *
 * ```ts
 * export const DICT_ZH = { … } satisfies Record<string, string>
 * export type DictKey = keyof typeof DICT_ZH
 * ```
 *
 * ## 这个文件覆盖什么(以及**不**覆盖什么)
 *
 * 覆盖**本插件自己写的**界面文案 —— 今天就是宿主插件页详情里那一页设置
 * (`./settings-page.tsx`)。
 *
 * ⚠️ **不覆盖** `src/core/desktop/**` 那棵镜像树里的文案:那是 GitHub Desktop 的
 * 逐字节复刻面(`scripts/verify-mirror.mjs` 盯着),里面的字串改了就不再是镜像;
 * 而且 `ctx.locale` 只在浏览器半存在(host 半没有这个服务),镜像的 `React.Component`
 * 也调不到钩子。那一面的既有裁决见 `docs/preferences-port.md` §6 的账本。
 *
 * @module dsh-git/client/i18nZh
 */

export const DICT_ZH = {
  /* ---------- 设置页:分组标题 ---------- */
  'settings.group.general': '通用',
  'settings.group.diff': 'Diff 与无障碍',
  'settings.group.notifications': '通知',
  'settings.group.prompts': '提示与确认',
  'settings.group.hostConfig': '插件配置(宿主设置文档)',

  /* ---------- 设置页:通用 ---------- */
  'settings.fontScale': '界面缩放',
  'settings.fontScale.hint': '单位 px,0 = 跟随宿主(范围 0–24)。',
  'settings.fontScale.invalid': '请填 0–24 之间的整数。',

  /* ---------- 设置页:Diff 与无障碍 ---------- */
  'settings.diffCheckMarks': '在 diff 里显示勾选标记',
  'settings.diffCheckMarks.hint': 'diff 每一行左侧是否显示「已勾选」标记。',
  'settings.underlineLinks': '链接加下划线',
  'settings.underlineLinks.hint': '本插件里的链接是否带下划线(不依赖颜色也能看出可点)。',

  /* ---------- 设置页:通知 ---------- */
  'settings.notifications': '启用高信号通知',
  'settings.notifications.hint': '关闭后,拉取 / 推送 / 克隆等后台事件不再发系统通知。',

  /* ---------- 设置页:提示与确认 ---------- */
  'settings.confirmDiscardChanges': '丢弃改动前先确认',
  'settings.confirmDiscardStash': '丢弃贮藏前先确认',
  'settings.confirmUndoCommit': '撤销提交前先确认',
  'settings.confirmCommitFiltered': '提交被筛选隐藏的改动前先确认',
  'settings.commitLengthWarning': '提交信息过长时给出提示',

  /* ---------- 设置页:宿主配置表单(自动刷新周期) ---------- */
  'settings.autoSec': 'Pulls 自动刷新周期(秒)',
  'settings.autoSec.hint': '0 = 关闭自动刷新;留空 = 回到默认值。改完保存后,Pulls 页签下一次刷新按新周期走。',
  'settings.autoSec.invalid': '请填 0–600 之间的整数(秒)。',

  /* ---------- 设置页:宿主配置表单的外壳文案(宿主 `SettingsFormLabels`) ---------- */
  'settings.form.unavailable': '宿主没有把 dsh-git 的设置暴露给这个页面,这里没有可编辑的内容。',
  'settings.form.readOnly': '当前配置文档只读,保存不会生效。',
  'settings.form.saveFailed': '宿主没有接受这次保存,暂存的内容还在。',
  'settings.form.save': '保存',
  'settings.form.saving': '保存中…',
  'settings.form.overridden': '已覆盖',
  'settings.form.reset': '恢复默认',
} satisfies Record<string, string>;

/** 本插件每一种语言都必须**完整**带上的键集(从 {@link DICT_ZH} 推导)。 */
export type DictKey = keyof typeof DICT_ZH;
