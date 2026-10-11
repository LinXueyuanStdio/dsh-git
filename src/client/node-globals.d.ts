/**
 * `src/client/desktop-globals.ts` 里那几条**运行期全局**的类型声明。
 *
 * ## 为什么必须单独有一份
 *
 * esbuild 的 `inject` 把 `desktop-globals.ts` 的导出名替换掉**源码里的自由标识符**
 * —— 所以运行期是正确的。但 **tsc 看不见 `inject`**:它只按普通的作用域规则解析,
 * 于是 `Buffer` 这类名字会报 **TS2591**(“Cannot find name 'Buffer'”)。
 *
 * 也就是说:**运行期对、类型层报错**。这份文件就是那个差的补丁。
 *
 * ⚠️ **两份必须同源**:`desktop-globals.ts` 加一个导出,这里就要加一条声明;
 * 少一条 ⇒ 镜像文件多一条 TS2591;多一条 ⇒ 那个名字从此不再受 tsc 保护
 * (`check-types` 会把**新增**诊断判红,所以一份过宽的声明比不写更糟)。
 *
 * @module dsh-git/client/node-globals
 */

/**
 * 对应 `src/client/desktop-globals.ts` 的 `Buffer`(最小子集)。
 *
 * 只声明**真的被调用过**的两个成员,理由与「不许静默回一个看起来对的值」
 * 那条约定写在那个导出的注释里。
 */
declare const Buffer: {
  /**
   * 字符串 → 一个能 `toString('base64')` 的最小对象。
   * @param input - 输入字符串。
   * @param encoding - 只支持 `'utf8'`。
   */
  from(input: string, encoding?: string): { toString(enc: string): string }
  /**
   * 恒 `false`(浏览器半没有真 `Buffer` 实例)。
   * @param value - 被检查的值。
   */
  isBuffer(value: unknown): boolean
}
