const WORD =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[A-Za-z0-9]+/gu

// Leading YAML front matter is metadata, not prose — excluded from counts.
// Same ambiguity as any CommonMark parser: a stray hr pair at the doc start
// also matches, which is the accepted price of the heuristic.
const FRONT_MATTER_LF = "---\n"
const FRONT_MATTER_CRLF = "---\r\n"
const FRONT_MATTER_CLOSE = "\n---"

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
 * End of the leading front-matter block, or `0` when there is none. Mirrors
 * `/^---\r?\n[\s\S]*?\r?\n---\r?\n?/`: the first `\n---` after the opening
 * fence closes the block, and an optional `\r?\n?` is consumed after it.
 */
function frontMatterEnd(text: string): number {
  const openEnd = text.startsWith(FRONT_MATTER_CRLF) ? FRONT_MATTER_CRLF.length
    : text.startsWith(FRONT_MATTER_LF) ? FRONT_MATTER_LF.length
    : 0
  if (openEnd === 0) return 0
  const close = text.indexOf(FRONT_MATTER_CLOSE, openEnd)
  if (close < 0) return 0
  let end = close + FRONT_MATTER_CLOSE.length
  if (text.charCodeAt(end) === 0x0d) end += 1
  if (text.charCodeAt(end) === 0x0a) end += 1
  return end
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
