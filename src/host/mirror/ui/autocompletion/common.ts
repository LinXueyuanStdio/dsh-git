/**
 * **跨根转发(host 根 → client 根)** —— 上游 `ui/autocompletion/common.ts`
 * (**5 行,内容就是一个 `export const DefaultMaxHits = 25`**)。
 *
 * ## 为什么是转发而不是第二份副本
 *
 * 上游这份文件**没有任何 import**,client 根的副本与上游逐字一致(`cmp` 无输出)。
 * 转发不会把任何 client 侧模块拉进宿主程序;而复制一份会让那 25 这个常量在树里
 * 有两个可改的地方。判据与逐条读数见 `docs/cross-root-adoption.md` §2。
 *
 * ## 引用方
 *
 * `lib/stores/github-user-store.ts:12` · `lib/stores/issues-store.ts:6`
 * (两者都是 host 根里与上游逐字一致的文件,只缺这一个说明符 ⇒ 上游原文里
 * 这个常量是**同一份**)。
 *
 * ## 退役条件
 *
 * 同 `lib/offset-from.ts`:需要 host 专属值,或 host 根不再镜像上游时消失。
 *
 * @module dsh-git/host-mirror/ui/autocompletion/common
 */

export * from '../../../../core/desktop/ui/autocompletion/common.ts';
