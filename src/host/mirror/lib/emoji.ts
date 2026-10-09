/**
 * **跨根转发(host 根 → client 根)** —— 上游 `lib/emoji.ts`(18 行)。
 *
 * ## 为什么是转发而不是第二份副本
 *
 * 上游这份文件**只导出一个类型** `Emoji`(**零运行期代码、零 import**),
 * client 根的副本与上游逐字一致(`cmp` 无输出)⇒ 转发不拉进任何 client 模块。
 * 判据见 `docs/cross-root-adoption.md` §2。
 *
 * ## 引用方
 *
 * `models/banner.ts:1`(只用 `Emoji` 这个类型)。
 *
 * ## 退役条件
 *
 * 同 `lib/offset-from.ts`。
 *
 * @module dsh-git/host-mirror/lib/emoji
 */

export * from '../../../core/desktop/lib/emoji.ts';
