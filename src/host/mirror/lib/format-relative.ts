/**
 * **跨根转发(host 根 → client 根)** —— 上游 `lib/format-relative.ts`(44 行)。
 *
 * ## 为什么是转发而不是第二份副本
 *
 * 它的 import 面只有两个**裸包**(`mem`、`quick-lru`,本仓都已安装),
 * **没有任何相对 import** ⇒ 转发不会把 client 侧模块拉进宿主程序。
 * client 根的副本与上游逐字一致(`cmp` 无输出)。判据见
 * `docs/cross-root-adoption.md` §2。
 *
 * ## 引用方
 *
 * `lib/stores/helpers/branch-pruner.ts:20`。⚠️ 它和 `lib/offset-from.ts` 一样是
 * **本批新发现的第三个缺件**(重测报告 §4.6 只列了 `../../offset-from`):
 * `branch-pruner.ts` 缺的是**两个**说明符,只补 `offset-from` 不够。
 *
 * ## 退役条件
 *
 * 同 `lib/offset-from.ts`。
 *
 * @module dsh-git/host-mirror/lib/format-relative
 */

export * from '../../../core/desktop/lib/format-relative.ts';
