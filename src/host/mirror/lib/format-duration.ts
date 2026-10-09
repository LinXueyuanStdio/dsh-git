/**
 * **跨根转发(host 根 → client 根)** —— 上游 `lib/format-duration.ts`(58 行)。
 *
 * ## 为什么是转发而不是第二份副本
 *
 * 上游这份文件**零 import**(两个导出都是纯函数)⇒ 转发不拉进任何 client 模块;
 * client 根副本与上游逐字一致(`cmp` 无输出)。判据见
 * `docs/cross-root-adoption.md` §2。
 *
 * ## 为什么它在重测报告的清单里**没有**
 *
 * 它是本批**新发现的缺件**:它不在那「10 文件」里,也不在它们的**直接**缺件里 ——
 * 它是 `lib/ci-checks/ci-checks.ts`(722 行,host 根**新复制**)的 `../format-duration`
 * (`ci-checks.ts:17`)。⇒ 重测报告 §4.6 的「`../ci-checks/ci-checks` … **[今]**」
 * 低估了那一个说明符的闭包:**它自己有 1 个 host 根缺件**。
 *
 * ## 引用方
 *
 * `lib/ci-checks/ci-checks.ts:17`。
 *
 * ## 退役条件
 *
 * 同 `lib/offset-from.ts`。
 *
 * @module dsh-git/host-mirror/lib/format-duration
 */

export * from '../../../core/desktop/lib/format-duration.ts';
