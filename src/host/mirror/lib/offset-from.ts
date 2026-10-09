/**
 * **跨根转发(host 根 → client 根)** —— 上游 `lib/offset-from.ts`(37 行)。
 *
 * ## 为什么是转发而不是第二份副本
 *
 * 上游这份文件**没有任何 import**(实测:AST 逐说明符清点 = 0),所以把它转发到
 * client 根的逐字副本**不会把任何 client 侧模块拉进宿主程序** —— 这是本批选
 * 「转发」而不是「复制」的**判据**,逐条读数在
 * `docs/cross-root-adoption.md` §2(该文件是唯一的一份字节:
 * `src/core/desktop/lib/offset-from.ts`,`cmp` 与上游**无输出**)。
 *
 * 反例(本批实测,所以是**复制**而不是转发):
 * `lib/email.ts` / `lib/web-flow-committer.ts` / `lib/ci-checks/ci-checks.ts` 的
 * client 闭包里有 **7 个与 host 根同名**的模块(含 `lib/api.ts` —— host 那份
 * 349 行、client 那份 632 行,是**两份不同的替身**)。转发它们会让同一个程序里
 * 同时存在两份 `lib/api.ts`,那才是真正的「第二个真相源」。
 *
 * ## 引用方
 *
 * `lib/stores/commit-status-store.ts:20` · `lib/stores/helpers/branch-pruner.ts:19`
 * (两者都是 host 根里与上游逐字一致的文件,它们只缺这一个说明符)。
 *
 * ## 退役条件
 *
 * ① 上游 `lib/offset-from.ts` 有一天需要 host 专属改动(那时改成 host 自己的
 * 实现并登记偏离);② 或者 host 根整体不再镜像上游(那时本文件随镜像树一起消失)。
 *
 * @module dsh-git/host-mirror/lib/offset-from
 */

export * from '../../../core/desktop/lib/offset-from.ts';
