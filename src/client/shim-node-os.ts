/**
 * `node:os` 的浏览器替身 —— 只实现镜像里真正被用到的那一个导出:`EOL`。
 *
 * ## 谁需要它(实证,不是猜)
 *
 * 全仓库只有一处 import:`src/core/desktop/ui/changes/filter-changes-list.tsx:56`
 * (上游原文 `references/desktop/app/src/ui/changes/filter-changes-list.tsx:56`),
 * 而它在两处使用,且**都只用于拼剪贴板文本**:
 *
 * ```
 * :611  writeClipboardText(fullPaths.join(EOL))
 * :623  writeClipboardText(paths.join(EOL))
 * ```
 *
 * 也就是「复制文件路径」这个动作:把多个路径**一行一个**拼起来。
 * 它不参与任何解析、比较或渲染。
 *
 * ## 为什么取值是 `'\n'` 而不是打桩
 *
 * 上游用的是 `os.EOL`(跟随运行平台:Windows 上是 `\r\n`,其余是 `\n`)。
 * 浏览器里没有「运行平台」这个概念 —— 插件的浏览器半跑在 DSH 的渲染进程里,
 * 而真正决定这些路径最终被谁消费的是**用户粘贴到哪里**。
 *
 * `'\n'` 是这里唯一站得住的选择:
 *  - 本插件的宿主(DSH Desktop)在 macOS/Linux 上运行时,`os.EOL` **本来就是 `'\n'`**,
 *    所以这一行与上游在本机的行为**逐字节一致**;
 *  - 即使粘到 Windows 的程序里,`'\n'` 也是被普遍接受的换行(记事本自 2018 起、
 *    PowerShell、git、编辑器都认),而 `'\r\n'` 粘进 Unix 终端反而会带出多余的 CR。
 *  ⇒ 所以这是**真实实现**,不是「先返回个东西让编译过」。
 *
 * ## 有意不实现的导出
 *
 * `platform()` / `homedir()` / `arch()` 等一概**不导出**。理由:浏览器半**禁止**
 * 依赖 node 内置能力,一旦镜像里新增了对 `os` 其它导出的引用,这里就应该**编译期报错**
 * (esbuild 解析不到导出)而不是静默给一个假的平台名。要补就补得**有理由**,
 * 和本文件一样写清「谁用、怎么用、为什么是这个值」。
 *
 * 接线(尚未完成,归 `scripts/build.mjs` 的持有者):`clientAlias` 里加一行
 * `os: './src/client/shim-node-os.ts'`,与已有的 `path` / `url` / `fs/promises` 三项并列。
 * 不加这一行,`filter-changes-list.tsx` 一旦被接进活路径就构建失败 —— 它现在
 * **不可达**所以一直没暴露。
 *
 * @module dsh-git/client/shim-node-os
 */

/**
 * 行分隔符。上游 `os.EOL` 的等价物;取值理由见文件头。
 *
 * 用途:把多个文件路径拼成一行一个的剪贴板文本
 * (`ui/changes/filter-changes-list.tsx:611,623`)。
 */
export const EOL = '\n';
