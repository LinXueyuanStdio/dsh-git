/**
 * **跨根转发(host 根 → client 根)** —— 上游 `ui/lib/list/list-row-index-path.ts`
 * (99 行,纯函数 + 一个类型)。
 *
 * ## 为什么是转发而不是第二份副本
 *
 * 上游这份文件**零 import** ⇒ 转发不会拉进任何 client 侧模块;
 * client 根副本与上游逐字一致(`cmp` 无输出)。判据见
 * `docs/cross-root-adoption.md` §2。
 *
 * ## 引用方
 *
 * `models/drag-drop.ts:1`(只用 `RowIndexPath` 这个类型)。
 *
 * ## 退役条件
 *
 * 同 `lib/offset-from.ts`。
 *
 * @module dsh-git/host-mirror/ui/lib/list/list-row-index-path
 */

export * from '../../../../../core/desktop/ui/lib/list/list-row-index-path.ts';
