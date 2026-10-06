/**
 * 移植层:把从 dsh-github-workbench 复制来的远端视图接到 dsh-git 的骨架上,
 * 统一导出它们原本从 icons / api / lib / ui / workbench 拿的东西。
 * @module dsh-git/client/gh
 */

import { createContext, useContext } from 'react';

export { GwIcon, GhIcon, type IconName } from './icons-gh.ts';
export * as api from './gh-api.ts';
export * from '../core/lib.ts';
export { Loading, ErrorBox, Empty } from './ui.tsx';

/** 与 workbench 的 errText 同形。 */
export function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 确认/提示能力:远端视图里的破坏性动作走它。 */
export interface ConfirmOptions {
  title: string;
  body?: string;
  confirmText?: string;
  danger?: boolean;
}

export interface UICapability {
  confirm(opts: ConfirmOptions): Promise<boolean>;
  toast(msg: string, kind?: 'ok' | 'err'): void;
}

export const UICtx = createContext<UICapability>({
  confirm: async () => false,
  toast: () => undefined,
});

export function useUI(): UICapability {
  return useContext(UICtx);
}
