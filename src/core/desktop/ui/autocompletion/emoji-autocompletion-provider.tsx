/*
 * ============================================================================
 * dsh-git 登记偏离 —— 见 `scripts/verify-mirror.mjs` 的 EXPECTED,
 * 键名 `ui/autocompletion/emoji-autocompletion-provider.tsx`
 * ============================================================================
 *
 * 本文件与上游
 * `references/desktop/app/src/ui/autocompletion/emoji-autocompletion-provider.tsx`
 * (160 行)**逐字一致**,只有**一处**不同:
 *
 * 上游 `:1` 的 `import * as React from 'react'` 在这里**删掉了**。
 *
 * **为什么**:上游的 `tsconfig` 是 `jsx: "react"`(经典 JSX 运行时),所以那个 import
 * 是 JSX 的**必需**依赖;我们的是 `jsx: "react-jsx"`(自动运行时 ——
 * `scripts/build.mjs` 的 esbuild `jsx: 'automatic'` 与 `tsconfig.base.json` 同源),
 * JSX 走 `react/jsx-runtime` ⇒ `React` 这个名字在本文件里**一次都没被用到**
 * (本文件只有 `renderItem` / `renderHighlightedTitle` 两处 JSX,没有 `React.xxx`),
 * 而 `tsconfig.base.json` 开着 `noUnusedLocals` ⇒ 实测
 * `TS6133: 'React' is declared but its value is never read`。
 *
 * **为什么不能像 `branch-autocompletion-provider.tsx` 那样留着**:那一个文件与本文件
 * 同形(它也报同一条 TS6133),但它是**存量**文件,那条诊断**早就登记在**
 * `scripts/type-baseline.json` 里;本文件是**新文件**,留一个未登记的诊断就是
 * `check-types` 的「回归」判据(棘轮只拦上升,实测:`0 → 1` 直接红),而
 * `--write-baseline` 是**明令禁止**的动作。⇒ 删掉这一行是**唯一**不新增诊断、
 * 又不动基线的做法。
 *
 * **它不是行为改动**:JSX 的编译目标由 `tsconfig`/esbuild 决定,与有没有这个 import
 * 无关(删掉前后产出的元素树逐字相同),而本文件一个 `React.` 引用都没有。
 *
 * **退役条件**:① 本仓回到 `jsx: "react"`,或 ② `noUnusedLocals` 关掉,或
 * ③ `scripts/type-baseline.json` 允许登记新文件的既有诊断 —— 三条任一成立即可
 * 还原成上游原文,并删除 `verify-mirror.mjs` 上本文件的 EXPECTED 条目。
 * (同一处偏离、同一段理由已经登记在 `ui/autocompletion/user-autocompletion-provider.tsx`
 * 的偏离④上 —— 那不是两次发明,是同一条口径。)
 */

import { IAutocompletionProvider } from './index'
import { compare } from '../../lib/compare'
import { DefaultMaxHits } from './common'
import { Emoji } from '../../lib/emoji'

const sanitizeEmoji = (emoji: string) => emoji.replaceAll(':', '')

/**
 * Interface describing a autocomplete match for the given search
 * input passed to EmojiAutocompletionProvider#getAutocompletionItems.
 */
export interface IEmojiHit {
  /** A human-readable markdown representation of the emoji, ex :heart: */
  readonly title: string

  /**
   * The unicode string of the emoji if emoji is part of
   * the unicode specification. If missing this emoji is
   * a GitHub custom emoji such as :shipit:
   */
  readonly emoji?: string

  /**
   * The offset into the emoji string where the
   * match started, used for highlighting matches.
   */
  readonly matchStart: number

  /**
   * The length of the match or zero if the filter
   * string was empty, causing the provider to return
   * all possible matches.
   */
  readonly matchLength: number
}

/** Autocompletion provider for emoji. */
export class EmojiAutocompletionProvider
  implements IAutocompletionProvider<IEmojiHit>
{
  public readonly kind = 'emoji'

  private readonly allEmoji: Map<string, Emoji>

  public constructor(emoji: Map<string, Emoji>) {
    this.allEmoji = emoji
  }

  public getRegExp(): RegExp {
    return /(?:^|\n| )(?::)([a-z\d\\+-][a-z\d_]*)?/g
  }

  public async getAutocompletionItems(
    text: string,
    maxHits = DefaultMaxHits
  ): Promise<ReadonlyArray<IEmojiHit>> {
    // This is the happy path to avoid sorting and matching
    // when the user types a ':'. We want to open the popup
    // with suggestions as fast as possible.
    if (text.length === 0) {
      return [...this.allEmoji.entries()]
        .map(([title, { emoji }]) => ({
          title,
          emoji,
          matchStart: 0,
          matchLength: 0,
        }))
        .slice(0, maxHits)
    }

    const results = new Array<IEmojiHit>()
    const needle = text.toLowerCase()

    for (const [key, emoji] of this.allEmoji.entries()) {
      const index = key.indexOf(needle)
      if (index !== -1) {
        results.push({
          title: key,
          emoji: emoji.emoji,
          matchStart: index,
          matchLength: needle.length,
        })
      }
    }

    // Naive emoji result sorting
    //
    // Matches closer to the start of the string are sorted
    // before matches further into the string
    //
    // Longer matches relative to the emoji length is sorted
    // before the same match in a longer emoji
    // (:heart over :heart_eyes)
    //
    // If both those start and length are equal we sort
    // alphabetically
    return results
      .sort(
        (x, y) =>
          compare(x.matchStart, y.matchStart) ||
          compare(x.title.length, y.title.length) ||
          compare(x.title, y.title)
      )
      .slice(0, maxHits)
  }

  public getItemAriaLabel(hit: IEmojiHit): string {
    const emoji = this.allEmoji.get(hit.title)
    const sanitizedEmoji = sanitizeEmoji(hit.title)
    const emojiDescription = emoji?.emoji
      ? emoji.emoji
      : emoji?.description ?? sanitizedEmoji
    return emojiDescription === sanitizedEmoji
      ? emojiDescription
      : `${emojiDescription}, ${sanitizedEmoji}`
  }

  public renderItem(hit: IEmojiHit) {
    const emoji = this.allEmoji.get(hit.title)

    return (
      <div className="emoji" key={hit.title}>
        {emoji?.emoji ? (
          <div className="icon">{emoji?.emoji}</div>
        ) : (
          <img
            className="icon"
            src={emoji?.url}
            alt={emoji?.description ?? hit.title}
          />
        )}
        {this.renderHighlightedTitle(hit)}
      </div>
    )
  }

  private renderHighlightedTitle(hit: IEmojiHit) {
    const emoji = sanitizeEmoji(hit.title)

    if (!hit.matchLength) {
      return <div className="title">{emoji}</div>
    }

    // Offset the match start by one to account for the leading ':' that was
    // removed from the emoji string
    const matchStart = hit.matchStart - 1

    return (
      <div className="title">
        {emoji.substring(0, matchStart)}
        <mark>{emoji.substring(matchStart, matchStart + hit.matchLength)}</mark>
        {emoji.substring(matchStart + hit.matchLength)}
      </div>
    )
  }

  public getCompletionText(item: IEmojiHit) {
    return item.emoji ?? item.title
  }
}
