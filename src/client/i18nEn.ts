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
  'settings.autoSec.hint': '0 disables auto-refresh; blank restores the default.',
  'settings.autoSec.invalid': 'Enter a whole number of seconds between 0 and 600.',

  /* ---------- settings page: Host configuration form chrome (Host `SettingsFormLabels`) ---------- */
  'settings.form.unavailable': 'The Host does not expose dsh-git settings on this page, so there is nothing to edit here.',
  'settings.form.readOnly': 'The configuration document is read-only; saving has no effect.',
  'settings.form.saveFailed': 'The Host did not accept this save; your draft is still here.',
  'settings.form.save': 'Save',
  'settings.form.saving': 'Saving…',
  'settings.form.overridden': 'Overridden',
  'settings.form.reset': 'Reset',

  /* ---------- settings page: account ---------- */
  'settings.group.account': 'Account',
  'settings.account.identity': 'Current account',
  'settings.account.signedOut': 'Not signed in',
  'settings.account.loadFailed': 'Could not read the sign-in state: the dsh-git service may be unreachable (is the Host half active?).',
  'settings.account.signIn': 'Sign in to GitHub.com',
  'settings.account.signIn.hint': 'Sign in with a device code: the authorisation page opens in your browser and the code to enter is shown here.',
  'settings.account.signOut': 'Sign out',
  'settings.account.endpoint': 'Enterprise host',
  'settings.account.endpoint.hint': 'e.g. github.example.com or https://github.example.com; blank means github.com.',
  'settings.account.enterpriseSignIn': 'Sign in to GitHub Enterprise',
  'settings.account.token': 'Personal access token (PAT)',
  'settings.account.token.hint': 'Fine-grained tokens need Contents R / Issues RW / Pull requests RW / Actions RW; a classic token needs repo.',
  'settings.account.tokenSignIn': 'Sign in with a token',
  'settings.account.device.code': 'Device code',
  'settings.account.device.hint': 'Open {uri} in your browser and enter the code below (the window we opened is already there).',
  'settings.account.signInFailed': 'Sign-in failed: {message}',
  'settings.account.signedInAs': 'Signed in as @{login}',

  /* ---------- settings page: Git identity ---------- */
  'settings.group.git': 'Git',
  'settings.gitName': 'Name',
  'settings.gitName.hint': 'Author name used for commits (writes the global Git config).',
  'settings.gitEmail': 'Email',
  'settings.gitEmail.hint': 'Author email used for commits (writes the global Git config).',
  'settings.gitBranch': 'Default branch',
  'settings.gitBranch.hint': 'Initial branch name for new repositories (writes the global Git config).',

  /* ---------- settings page: appearance ---------- */
  'settings.group.appearance': 'Appearance',
  'settings.theme': 'Theme',
  'settings.theme.hint': 'Follows the Host theme; a change in the Host settings shows up here.',
  'settings.theme.light': 'Light',
  'settings.theme.dark': 'Dark',
  'settings.theme.system': 'System',
  'settings.tabSize': 'Diff tab size',
  'settings.tabSize.hint': 'How many spaces one tab renders as in the diff.',
  'settings.dateFormat': 'Date format',
  'settings.timeFormat': 'Time format',
  'settings.numberFormat': 'Number format',
  'settings.preferAbsoluteDates': 'Prefer absolute dates',
  'settings.preferAbsoluteDates.hint': 'When off, lists show relative times such as "3 days ago".',

  /* ---------- settings page: notifications (test row) ---------- */
  'settings.notifications.test': 'Test notification',
  'settings.notifications.test.hint': 'Send one system notification to verify permission and delivery.',
  'settings.notifications.test.action': 'Send',
  'settings.notifications.sent': '{n} sent this session.',
  'settings.account.signInAction': 'Sign in',
} satisfies Record<DictKey, string>;
