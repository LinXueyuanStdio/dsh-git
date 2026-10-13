/**
 * 设置页的【Git】分组 —— 全局 git 身份(姓名 / 邮箱 / 默认分支)。
 *
 * ## 与偏好弹窗的 Git 页是什么关系
 *
 * 那一边是 GitHub Desktop `ui/preferences/git.tsx` 的**逐字节镜像** + `git-page.tsx` 的接线
 * (三个子页签 Author / Default branch / Hooks);这一边是**宿主风格的三行**。
 * 两者读写的是**同一份真源**(全局 git config,经 `lib/git/config.ts` 的
 * `getGlobalConfigValue` / `setGlobalConfigValue`),所以不存在「两个真源谁赢」。
 *
 * ## 这里**没有**搬过来的那些
 *
 * | 上游 Git 页的东西 | 为什么不在这一页 |
 * |---|---|
 * | 头像 / 邮箱下拉候选 | 那要 `account/emails` + `accountsWithEmails` 那一整套,是**复刻面**的控件形状;这一页只给一个文本框,想填什么填什么 |
 * | 作者自动识别 + 「这两个框里的字是哪儿来的」回声 | 同上:它是上游 `preferences.tsx` 的预填逻辑,弹窗那边仍然完整 |
 * | Hooks 三个偏好(`hooks/config.ts`) | 与 diff 无关、也不属于「Git 身份」;弹窗那一页仍然完整 |
 * | 「编辑全局 Git 配置文件」链接 + 锁文件告警 | 同上(`git-config-links.tsx` 那一套留在弹窗里) |
 *
 * ## 姓名校验:与弹窗**同一个谓词**
 *
 * `gitAuthorNameIsValid()` 是 `git` 自己那份 crud 字符规则的逐字复制品
 * (`src/core/desktop/ui/lib/identifier-rules.ts`,镜像树);非法时**不写盘**并在行下给提示
 * (文案与弹窗共用 `GIT_AUTHOR_NAME_INVALID_MESSAGE`)。手写第二份规则正是本仓禁止的
 * 「第二份真源」。
 *
 * @module dsh-git/client/settings-git
 */

import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import {
  getGlobalConfigValue, setGlobalConfigValue,
} from '../core/desktop/lib/git/config.ts';
import { gitAuthorNameIsValid } from '../core/desktop/ui/lib/identifier-rules.ts';
import type { Translate } from './i18n.ts';
import { GIT_AUTHOR_NAME_INVALID_MESSAGE } from './git-page.tsx';
import { SettingsGroup, TextRow } from './settings-rows.tsx';

/** 上游 `lib/helpers/default-branch.ts:15` 的 `DefaultBranchSettingName`。 */
const DEFAULT_BRANCH_SETTING = 'init.defaultBranch';

/**
 * 【Git】分组。
 * @param props - 文案函数与「偏好变了」回调。
 * @returns 那一组。
 */
export function SettingsGitGroup(props: { readonly t: Translate; readonly onPreferencesChanged: () => void }): ReactNode {
  const { t, onPreferencesChanged } = props;
  /** `null` = 还没读到(第一帧);读到之后即使是空串也照原样显示。 */
  const [name, setName] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [branch, setBranch] = useState<string | null>(null);

  /*
   * 读**全局**作用域的三个键。宿主没起来时 `getGlobalConfigValue` 会抛(路由不可达),
   * 那不该把整页带走 —— 所以两侧都兜住,读失败就保持空串(用户手填仍然能写)。
   */
  useEffect(() => {
    let live = true;
    void (async () => {
      const read = async (key: string): Promise<string> => {
        try {
          return (await getGlobalConfigValue(key)) ?? '';
        } catch {
          return '';
        }
      };
      const [nextName, nextEmail, nextBranch] = await Promise.all([
        read('user.name'), read('user.email'), read(DEFAULT_BRANCH_SETTING),
      ]);
      if (!live) {
        return;
      }
      setName(nextName);
      setEmail(nextEmail);
      setBranch(nextBranch);
    })();
    return () => { live = false; };
  }, []);

  /** 写一个全局配置键;失败只影响这一行,不抛到渲染层。 */
  const write = useCallback(async (key: string, value: string): Promise<void> => {
    try {
      await setGlobalConfigValue(key, value);
      onPreferencesChanged();
    } catch (error) {
      console.warn(`[dsh-git] 写全局 git config ${key} 失败:${String(error)}`);
    }
  }, [onPreferencesChanged]);

  const onNameCommit = useCallback((value: string) => {
    setName(value);
    if (gitAuthorNameIsValid(value)) {
      void write('user.name', value);
    }
  }, [write]);
  const onEmailCommit = useCallback((value: string) => {
    setEmail(value);
    void write('user.email', value);
  }, [write]);
  const onBranchCommit = useCallback((value: string) => {
    setBranch(value);
    void write(DEFAULT_BRANCH_SETTING, value);
  }, [write]);

  const nameInvalid = name !== null && !gitAuthorNameIsValid(name);

  return (
    <SettingsGroup id="gw-settings-git" title={t('settings.group.git')}>
      <TextRow
        id="gw-settings-git-name"
        label={t('settings.gitName')}
        hint={t('settings.gitName.hint')}
        value={name ?? ''}
        invalid={nameInvalid ? GIT_AUTHOR_NAME_INVALID_MESSAGE : undefined}
        onCommit={onNameCommit}
      />
      <TextRow
        id="gw-settings-git-email"
        label={t('settings.gitEmail')}
        hint={t('settings.gitEmail.hint')}
        value={email ?? ''}
        onCommit={onEmailCommit}
      />
      <TextRow
        id="gw-settings-git-branch"
        label={t('settings.gitBranch')}
        hint={t('settings.gitBranch.hint')}
        value={branch ?? ''}
        placeholder="main"
        onCommit={onBranchCommit}
      />
    </SettingsGroup>
  );
}
