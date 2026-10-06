/**
 * 浏览器半的宿主类型最小重述:不 value-import 任何 @deepseek-ai/* 包,
 * 只声明用到的席位注册面(与 dsh-client-ui-sidebar-right 的公开契约一致)。
 * @module dsh-git/client/types
 */

import type { ReactNode } from 'react';

/** tab 类型注册定义(公开契约的子集)。 */
export interface TabTypeDefinition {
  id: string;
  kind: string;
  priority?: 'extension' | 'builtin' | 'fallback';
  title: (address?: string) => string;
  patterns?: readonly string[];
  canOpen?: (address: string) => boolean;
  guide?: readonly {
    id?: string;
    order: number;
    title: () => string;
    description?: () => string;
    icon?: unknown;
  }[];
  keepMounted?: boolean;
}

/** 右侧栏 tab 注册表。 */
export interface SidebarRightTabsLike {
  register(definition: TabTypeDefinition): () => void;
  openTab?(kind: string, options?: Record<string, unknown>): void;
}

/** 席位系统。 */
export interface SlotsLike {
  inject(name: string, fn: () => (() => void) | void): () => void;
  register(spec: Record<string, unknown>, component: unknown): () => void;
}

/** 客户端 cordis context 的最小切面。 */
export interface ClientCtx {
  effect(fn: () => (() => void) | void, label?: string): void;
  /**
   * 可选服务访问。cordis 会拒绝访问未在 inject 里声明的服务属性,可选服务必须走 get()。
   */
  get?(name: string): unknown;
  on?(event: string, listener: (...args: unknown[]) => void): () => void;
  inject?(deps: readonly string[], fn: (injected: { get(name: string): unknown }) => (() => void) | void): { dispose?: () => void };
  slots?: SlotsLike;
  sidebarRightTabs?: SidebarRightTabsLike;
  locale?: {
    bind(ns: string): (key: string, params?: Record<string, unknown>) => string;
    register(ns: string, dicts: Record<string, Record<string, string>>): () => void;
  };
}

/** 视图组件的共享 props。 */
export interface ViewProps {
  store: GitStoreLike;
}

/** store 形状(避免循环 import,这里声明最小面)。 */
export interface GitStoreLike {
  subscribe(listener: () => void): () => void;
  snapshot(): unknown;
  [key: string]: unknown;
}

/** React 节点类型别名。 */
export type Node = ReactNode;
