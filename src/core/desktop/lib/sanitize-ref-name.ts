// See https://www.kernel.org/pub/software/scm/git/docs/git-check-ref-format.html
// ASCII Control chars and space, DEL, ~ ^ : ? * [ \
// | " < and > is technically a valid refname but not on Windows
// the magic sequence @{, consecutive dots, leading and trailing dot, ref ending in .lock
const invalidCharacterRegex =
  /[\x00-\x20\x7F~^:?*\[\\|""<>]+|@{|\.\.+|^\.|\.$|\.lock$|\/$/g

/** Sanitize a proposed reference name by replacing illegal characters. */
export function sanitizedRefName(name: string): string {
  return name.replace(invalidCharacterRegex, '-').replace(/^[-\+]*/g, '')
}

/**
 * Validate that a reference does not contain any invalid characters.
 *
 * dsh-git 偏离上游 1 处(上游有 bug):`invalidCharacterRegex` 带 `g` 标志,而带 `g`
 * 的正则配 `.test()` 会**跨调用累积 `lastIndex`**,于是同一个非法名字会交替返回
 * true/false。实测 `testForInvalidChars('a b')` 连续四次得到
 * `true, false, true, false` —— 用户输入非法分支名时,每第二次校验都会放行。
 * `sanitizedRefName` 用的 `.replace()` 需要 `g`,所以这里保留 `g` 并把
 * `lastIndex` 归零,而不是去掉标志。
 */
export function testForInvalidChars(name: string): boolean {
  invalidCharacterRegex.lastIndex = 0
  const result = invalidCharacterRegex.test(name)
  invalidCharacterRegex.lastIndex = 0
  return result
}
