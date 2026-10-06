#!/usr/bin/env node
/**
 * 闸门:「**整体是一个 CSS 模板字符串**」的文件里,模板正文/注释中混进了反引号。
 *
 * ## 为什么需要它(用真实事故换来的)
 *
 * 本仓有几个源文件的形状是:
 *
 *     const CSS = `
 *       .foo { … }
 *     `;
 *
 * 往这种文件的**模板正文或注释**里再写一个反引号,会**提前闭合模板** ⇒ 后面的 CSS 被当成
 * TypeScript 解析。它的表现极具误导性:
 *
 *     ✘ [ERROR] Expected ";" but found "ui"
 *         src/client/styles.ts:646:31
 *
 * —— 指向一个**完全无关**的 token,真因却在上面某个注释里。2026-10 这一天里这一类事故
 * 发生了 **6 次**,其中 **3 次直接把构建打断**;每次都要先花一轮读那句错位的报错才找到真因
 * (最惨的一次:一条泳道因此卡住等了几十分钟,另一条被迫回滚改动)。
 *
 * ⇒ 本闸门把「一个读不懂的解析错误」换成「一句点名到行的话」。
 *
 * ## 判据(有意做得很窄 —— 零误报优先)
 *
 * 对每个含 `const CSS = \`` 的文件:
 *   1. 找到那个**打开分隔符**(紧跟 `const CSS =` 的那个反引号);
 *   2. 断言它**之后**的未转义反引号**恰好只有 1 个**,且它是文件里最后一个反引号
 *      (即收尾分隔符,通常就在文件末)。
 *
 * ## 为什么**不**用「反引号总数为偶数」这种更宽的判据
 *
 * 试过,它会**误报**,而且漏报:
 *   · **误报**:`src/client/styles-base.ts` 的未转义反引号总数是 **3** —— 第 3 个在
 *     `:3` 的一个块注释里(写了 `references/dsh-github-workbench/src/styles.ts`
 *     这个路径),而它在 `const CSS = \`` **之前**,根本不在模板体内。按「偶数」判它必红。
 *     ⚠️ 本段特意**不写**块注释的起止记号字面量 —— 在块注释里写出结束记号会**提前闭合
 *     本注释**(本闸门的第一版就是这样把自己写成了语法错误的,第 7 次同类事故)。
 *   · **漏报**:在同一个注释里写**两个**反引号,总数仍是偶数 ⇒ 判绿,而构建照样炸。
 * ⇒ 所以判据必须**看位置**,不能只数个数。
 *
 * ## 退出码 / 输出
 *   0 = 通过;1 = 至少一处。`--json` 给机器可读结果(与其它 `check-*.mjs` 同约定)。
 *
 * ## 已知边界(不许把结论读大)
 *   · **只覆盖「一个 `const CSS = \`` 模板」这一种形状**。它不解析 TypeScript,不覆盖
 *     普通的计算属性模板、嵌套模板、`${}` 里的模板等;
 *   · 真正通用的判据需要一个**词法分析器**(能区分代码 / 注释 / 字符串 / 模板四种状态,
 *     并且在模板里 `//` 与 `/*` **不是注释只是文本**)。本闸门是那个通用解的**窄代理**,
 *     用「零误报 + 精确命中已知事故形态」换掉了通用性;
 *   · 因此它**不能**宣称「本仓没有模板字面量问题」,只能说「这一种形状的这一类错没有」。
 */
import { readFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')

const SCAN_DIRS = ['src/client']
const EXTS = new Set(['.ts', '.tsx'])
const SKIP_DIRS = new Set(['node_modules', 'lib', 'dist', 'upstream', 'references'])

/** 只有这种形状的文件才受本闸门管辖。 */
const OPENER = /const\s+CSS\s*=\s*`/

async function* walk(dir) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return // 目录不存在(裁剪过的检出)⇒ 跳过,不是失败
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      yield* walk(full)
    } else if (entry.isFile()) {
      const dot = entry.name.lastIndexOf('.')
      if (dot >= 0 && EXTS.has(entry.name.slice(dot))) yield full
    }
  }
}

/** 未转义的反引号(前导反斜杠个数为偶数 ⇒ 未被转义)的位置。 */
function backticks(text) {
  const out = []
  const lines = text.split('\n')
  let offset = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    for (let c = 0; c < line.length; c++) {
      if (line[c] !== '`') continue
      let bs = 0
      for (let k = c - 1; k >= 0 && line[k] === '\\'; k--) bs++
      if (bs % 2 === 1) continue
      out.push({ offset: offset + c, line: i + 1, column: c + 1, text: line.trim().slice(0, 120) })
    }
    offset += line.length + 1
  }
  return out
}

const offenders = []
let governed = 0

for (const dir of SCAN_DIRS) {
  for await (const file of walk(join(ROOT, dir))) {
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const m = OPENER.exec(text)
    if (m === null) continue
    governed++

    const openerIndex = text.indexOf('`', m.index)
    const all = backticks(text)
    const after = all.filter((b) => b.offset > openerIndex)

    // 打开分隔符之后,合法的未转义反引号**只有收尾那一个**。
    if (after.length === 1) continue

    offenders.push({
      file: relative(ROOT, file).split(sep).join('/'),
      openerLine: text.slice(0, openerIndex).split('\n').length,
      expected: 1,
      found: after.length,
      hits: after,
    })
  }
}

const asJson = process.argv.includes('--json')

if (asJson) {
  console.log(
    JSON.stringify({ governedFiles: governed, offenders, pass: offenders.length === 0 }, null, 2)
  )
} else if (offenders.length === 0) {
  console.log(
    `dsh-git: CSS 模板字面量自检通过 —— ${String(governed)} 个受管辖文件,模板体内反引号都只有收尾那一个。`
  )
} else {
  console.error(
    '✘ 「整体是一个 CSS 模板字符串」的文件里,模板体内多出了反引号。\n' +
      '  这几乎总是「往注释里写了一个反引号」⇒ 模板提前闭合 ⇒ 后面的 CSS 被当成 TypeScript,\n' +
      '  而 esbuild 会报一个**指向无关 token** 的解析错误(例如 `Expected ";" but found "ui"`)。\n'
  )
  for (const o of offenders) {
    console.error(
      `  ${o.file} —— 打开分隔符在 :${String(o.openerLine)},` +
        `其后应有 1 个未转义反引号,实际 **${String(o.found)}** 个:`
    )
    for (const h of o.hits.slice(0, 20)) {
      console.error(`    ${String(h.line)}:${String(h.column)}  ${h.text}`)
    }
    if (o.hits.length > 20) console.error(`    …还有 ${String(o.hits.length - 20)} 处`)
  }
  console.error('\n  修法:把那处反引号换成「…」或单引号,不要动真正的模板分隔符。')
}

process.exit(offenders.length === 0 ? 0 : 1)
