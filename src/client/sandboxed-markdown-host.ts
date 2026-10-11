/**
 * **沙箱 markdown 的静态样式供给**(2026-10-09 新增)—— 把上游在**运行期读文件**的那一步
 * 换成**构建期字符串**。
 *
 * ## 上游那一步是什么
 *
 * `ui/lib/sandboxed-markdown.tsx:231-235`(逐字镜像,447 行):
 *
 * ```ts
 * private async getInlineStyleSheet(): Promise<string> {
 *   const css = await readFile(Path.join(__dirname, 'static', 'markdown.css'), 'utf8')
 *   …
 * }
 * ```
 *
 * 它把一份 CSS 拼进 iframe 的 `<style>`,让沙箱里的 markdown 与宿主主题一致。
 * 在 Electron 渲染进程里 `readFile` 是真的;在浏览器半**既没有 `__dirname`
 * 也没有文件系统**。
 *
 * ## 换成了什么,以及为什么这样换
 *
 * | 方案 | 为什么不 |
 * |---|---|
 * | 走宿主路由把 CSS 读出来 | 为一份**编译期已知的常量**加一条网络往返 + 一条宿主路由,是拿运行期复杂度换静态数据;而且它会在离线/宿主未激活时**静默少一份样式** |
 * | 把 CSS 内联进 `shim-node-fs-promises.ts` | 9,568 字节的样式塞进一个「通用平台替身」,会让那个文件的职责从「补 node 契约」变成「顺便当资源表」 |
 * | **构建期 `import` 成字符串**(本方案) | —— |
 *
 * `scripts/build.mjs` 的 `clientLoader` 里有 `'.css': 'text'`,所以下面那条 import
 * 在**打包期**就变成一个字符串常量,浏览器一个请求都不发。
 *
 * ## 那份 CSS 是上游原件,逐字节
 *
 * `src/client/static/markdown.css` 是 `references/desktop/app/static/common/markdown.css`
 * 的**逐字节副本**(9,568 B,sha256 `57d968ab…05fa4`,`cmp` 相同)。它**放在 `src/client/`
 * 下而不是镜像根里**,因为上游那份在 `app/static/` 而不在 `app/src/` —— 放进
 * `src/core/desktop/**` 会让 `verify-mirror` 多出一个它按映射规则**找不到上游对应物**
 * 的文件。这份是**资源**,不是镜像源码。
 *
 * ## 它只认一个路径,而且是**故意**的
 *
 * `readFileText` 只对**文件名是 `markdown.css`** 的请求给内容,其余一律
 * `ENOENT`(与没接宿主时同一语义)。**不是**「浏览器也能读文件」的假装 ——
 * 一旦哪天有第二个调用点,它必须**明确地**在这里加一行,而不是靠一条通配规则
 * 悄悄拿到错内容。
 *
 * @module dsh-git/client/sandboxed-markdown-host
 */

import markdownCss from './static/markdown.css'
import { setFsPromisesHost, type IFsPromisesHost } from './shim-node-fs-promises.ts'

/** 这个供给方认识的**唯一**路径特征(见文件头最后一段)。 */
const MARKDOWN_CSS_BASENAME = 'markdown.css'

/** 已经装进去的那一份(幂等;`null` = 还没装)。 */
let installed: IFsPromisesHost | null = null

/**
 * 把「`markdown.css` ⇒ 构建期内联的那份样式」这一条供给**合并进**现有的 fs 宿主。
 *
 * ⚠️ **必须合并,不能覆盖**:`src/client/history-view.tsx` 已经装了一份带
 * `access` 的宿主(那是 `pathExists` 的唯一来源,右键菜单靠它)。直接
 * `setFsPromisesHost({ readFileText })` 会把 `access` 一起抹掉 ⇒
 * 右键菜单退化成永远只有一句「File Does Not Exist on Disk」。
 *
 * @param current - 现在装着的那一份(可能为 `null`)。
 * @returns 合并后的那一份(调用方应把它交给 `setFsPromisesHost`)。
 */
export function withSandboxedMarkdownStyles(current: IFsPromisesHost | null): IFsPromisesHost {
  const base: IFsPromisesHost = current ?? { access: async (path: string) => { throw new Error(`ENOENT: ${path}`) } }
  installed = {
    ...base,
    readFileText: async (path: string): Promise<string> => {
      if (path.endsWith(MARKDOWN_CSS_BASENAME)) {
        return markdownCss
      }
      /*
       * 其余路径：**明确失败**,不编内容、也不回空串。
       * 回空串会让 iframe 少一份样式而**没有任何错误** —— 那正是最难查的形状。
       */
      throw new Error(`ENOENT: no such file or directory, readFile '${path}'`)
    },
  }
  return installed
}

/**
 * 一步到位:把样式供给装进 fs 替身。
 *
 * @param current - 现在装着的那一份(见 {@link withSandboxedMarkdownStyles} 的 ⚠️)。
 */
export function installSandboxedMarkdownStyles(current: IFsPromisesHost | null): void {
  setFsPromisesHost(withSandboxedMarkdownStyles(current))
}

/** 探针用:构建期内联进来的那份 CSS(证明它**真的**被打进包里了)。 */
export function sandboxedMarkdownCss(): string {
  return markdownCss
}
