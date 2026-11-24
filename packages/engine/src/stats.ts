const WORD =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[A-Za-z0-9]+/gu

// Leading YAML front matter is metadata, not prose — excluded from counts.
// Same ambiguity as any CommonMark parser: a stray hr pair at the doc start
// also matches, which is the accepted price of the heuristic.
/** A fence line is `---` plus optional trailing whitespace, with no leading
 * whitespace — the same check `parse/frontMatter.ts` makes on a Lezer line. */
function isFrontMatterFence(text: string, from: number, to: number): boolean {
  let end = to
  while (end > from && TRIM_WHITESPACE_CODES.has(text.charCodeAt(end - 1))) end -= 1
  return end - from === 3 && text.startsWith("---", from)
}

/**
 * Every code unit `String.prototype.trim` strips (WhiteSpace + LineTerminator,
 * U+180E excluded since ES2016). Kept as a table so the trim bounds can be
 * computed without materializing substrings of the document.
 */
const TRIM_WHITESPACE_CODES: ReadonlySet<number> = new Set([
  0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x0020, 0x00a0, 0x1680,
  ...Array.from({ length: 11 }, (_, index) => 0x2000 + index),
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
])

export interface DocumentStats {
  readonly words: number
  readonly chars: number
}

/**
 * End of the leading front-matter block, or `0` when there is none.
 *
 * This must agree with `parse/frontMatter.ts`: the block opens only on the
 * first line whose trimmed end is exactly `---`, closes on the next such line,
 * and an unclosed block swallows the whole document. A prefix match such as
 * `\n---` would close on `----` or `---text`, counting metadata as prose.
 */
function frontMatterEnd(text: string): number {
  let lineStart = 0
  let first = true
  for (;;) {
    const newline = text.indexOf("\n", lineStart)
    const lineEnd = newline < 0 ? text.length : newline
    const fence = isFrontMatterFence(text, lineStart, lineEnd)
    if (first) {
      if (!fence) return 0
      first = false
    } else if (fence) {
      return newline < 0 ? text.length : newline + 1
    }
    if (newline < 0) return text.length
    lineStart = newline + 1
  }
}

/**
 * Counts `WORD` matches whose start lies inside `[start, end)`. `end` sits on
 * the last counted character (both bounds are trimmed), so no match can extend
 * past it — the global regex can run over the whole document and simply stop
 * once it reaches the body end, with no substring copy of the body.
 */
function countWordsIn(text: string, start: number, end: number): number {
  WORD.lastIndex = start
  let words = 0
  let match = WORD.exec(text)
  while (match !== null && match.index < end) {
    words += 1
    match = WORD.exec(text)
  }
  return words
}

export function documentStats(text: string): DocumentStats {
  let start = frontMatterEnd(text)
  let end = text.length
  while (start < end && TRIM_WHITESPACE_CODES.has(text.charCodeAt(start))) start += 1
  while (end > start && TRIM_WHITESPACE_CODES.has(text.charCodeAt(end - 1))) end -= 1
  if (start >= end) return { words: 0, chars: 0 }
  return { words: countWordsIn(text, start, end), chars: end - start }
}
