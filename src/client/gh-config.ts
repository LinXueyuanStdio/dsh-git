/**
 * 移植视图用到的少量本地偏好:自动刷新周期与字号。
 * 本插件的设置面板只管模型与登录,这里给出安全缺省(0 = 关闭自动刷新)。
 * @module dsh-git/client/gh-config
 */

export type FontSizePref = 'dsh' | '13' | '14';

/** PR / Actions 自动刷新周期(秒),0 = 关闭。 */
export function loadAutoRefreshSec(): number {
  return 0;
}

/** 正文字号偏好(远端视图沿用宿主字号)。 */
export function loadFontSize(): FontSizePref {
  return 'dsh';
}
