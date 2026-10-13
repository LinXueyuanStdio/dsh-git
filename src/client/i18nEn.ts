/**
 * 英文(en)字典。`satisfies Record<DictKey, string>` 把它**钉在中文的键集上** ——
 * 少一条键、多一条键、拼错一条键都会在 `check-types` 当场报错。
 *
 * 与 `references/dsh-context/src/client/i18nEn.ts` 同形。
 *
 * @module dsh-git/client/i18nEn
 */

import type { DictKey } from './i18nZh';

export const DICT_EN = {
  /* ---------- settings page: group titles ---------- */
  'settings.group.general': 'General',
  'settings.group.diff': 'Diff & accessibility',
  'settings.group.notifications': 'Notifications',
  'settings.group.prompts': 'Prompts',
  'settings.group.hostConfig': 'Plugin configuration (Host settings document)',

  /* ---------- settings page: general ---------- */
  'settings.fontScale': 'Interface scale',
  'settings.fontScale.hint': 'In px; 0 follows the Host (range 0–24).',
  'settings.fontScale.invalid': 'Enter a whole number between 0 and 24.',

  /* ---------- settings page: diff & accessibility ---------- */
  'settings.diffCheckMarks': 'Show check marks in the diff',
  'settings.diffCheckMarks.hint': 'Whether each diff row shows its selection mark on the left.',
  'settings.underlineLinks': 'Underline links',
  'settings.underlineLinks.hint': 'Underline links in this plugin so they read as clickable without relying on colour.',

  /* ---------- settings page: notifications ---------- */
  'settings.notifications': 'High-signal notifications',
  'settings.notifications.hint': 'When off, background fetch / push / clone events stop raising system notifications.',

  /* ---------- settings page: prompts ---------- */
  'settings.confirmDiscardChanges': 'Confirm before discarding changes',
  'settings.confirmDiscardStash': 'Confirm before discarding a stash',
  'settings.confirmUndoCommit': 'Confirm before undoing a commit',
  'settings.confirmCommitFiltered': 'Confirm when committing changes hidden by the filter',
  'settings.commitLengthWarning': 'Warn when the commit message is too long',

  /* ---------- settings page: Host configuration form (auto-refresh) ---------- */
  'settings.autoSec': 'Pulls auto-refresh interval (seconds)',
  'settings.autoSec.hint': '0 disables auto-refresh; blank restores the default. The Pulls tab picks up a saved interval on its next refresh.',
  'settings.autoSec.invalid': 'Enter a whole number of seconds between 0 and 600.',

  /* ---------- settings page: Host configuration form chrome (Host `SettingsFormLabels`) ---------- */
  'settings.form.unavailable': 'The Host does not expose dsh-git settings on this page, so there is nothing to edit here.',
  'settings.form.readOnly': 'The configuration document is read-only; saving has no effect.',
  'settings.form.saveFailed': 'The Host did not accept this save; your draft is still here.',
  'settings.form.save': 'Save',
  'settings.form.saving': 'Saving…',
  'settings.form.overridden': 'Overridden',
  'settings.form.reset': 'Reset',
} satisfies Record<DictKey, string>;
