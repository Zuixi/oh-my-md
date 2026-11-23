import type { InlineContext, InlineParser } from "@lezer/markdown"
import {
  CHAR_ASTERISK,
  CHAR_AT,
  CHAR_CLOSE_PAREN,
  CHAR_LOWER_A,
  CHAR_LOWER_F,
  CHAR_LOWER_H,
  CHAR_LOWER_W,
  CHAR_LOWER_Z,
  CHAR_NINE,
  CHAR_OPEN_PAREN,
  CHAR_TILDE,
  CHAR_UNDERSCORE,
  CHAR_UPPER_A,
  CHAR_UPPER_Z,
  CHAR_ZERO,
} from "./chars"

// Parentheses stay in the match so `trimUrl` can balance them: `Foo_(bar)` is
// URL punctuation, the `)` in `(https://x)` is prose punctuation.
const URL_PATTERN = /^(?:https?:\/\/|ftp:\/\/|www\.)[^\s<>]+/i
const EMAIL_PATTERN = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i
const TRAILING_PUNCTUATION = /[.,!?;:]+$/
const ALPHANUMERIC = /[A-Z0-9]/i
const WORD_CHAR = /[A-Z0-9_]/i

function isMarkdownDelimiter(character: number): boolean {
  return character === CHAR_ASTERISK || character === CHAR_TILDE
}

function isDelimiterRunChar(character: number): boolean {
  return isMarkdownDelimiter(character) || character === CHAR_UNDERSCORE
}

/**
 * `_` opens an emphasis run only when the contiguous `_*~` run before the URL
 * contains an underscore and that run itself starts a word boundary. The run
 * scan is what makes composite openers work: in `_**https://x**_` the character
 * before the URL is `_`, not `*`.
 */
function hasUnderscoreOpener(cx: InlineContext, pos: number): boolean {
  let sawUnderscore = false
  let index = pos - 1
  let character = cx.char(index)
  while (isDelimiterRunChar(character)) {
    if (character === CHAR_UNDERSCORE) sawUnderscore = true
    index--
    character = cx.char(index)
  }
  if (!sawUnderscore) return false
  return isWordBoundaryBefore(cx, index)
}

/**
 * `_` is a boundary only when it opens a Markdown emphasis run, not when it is
 * an intra-word underscore (`foo_bar`, `foo_https://…`).
 */
function isUnderscoreBoundary(cx: InlineContext, pos: number): boolean {
  if (cx.char(pos - 1) !== CHAR_UNDERSCORE) return false
  const before = cx.char(pos - 2)
  return before < 0 || !ALPHANUMERIC.test(String.fromCharCode(before))
}

function isWordBoundaryBefore(cx: InlineContext, index: number): boolean {
  const before = cx.char(index)
  return before < 0 || !WORD_CHAR.test(String.fromCharCode(before))
}

function isBoundary(cx: InlineContext, pos: number): boolean {
  const previous = cx.char(pos - 1)
  if (previous < 0) return true
  if (previous === CHAR_UNDERSCORE) return isUnderscoreBoundary(cx, pos)
  return !WORD_CHAR.test(String.fromCharCode(previous))
}

/**
 * A URL may carry balanced parentheses (`Foo_(bar)`); a closer without a
 * matching opener inside the URL belongs to the surrounding prose. A dangling
 * opener at the end is prose punctuation too.
 */
function trimParens(value: string, end: number): number {
  let openCount = 0
  let closeCount = 0
  for (let index = 0; index < end; index++) {
    const character = value.charCodeAt(index)
    if (character === CHAR_OPEN_PAREN) openCount++
    else if (character === CHAR_CLOSE_PAREN) closeCount++
  }
  while (end > 0 && value.charCodeAt(end - 1) === CHAR_CLOSE_PAREN && closeCount > openCount) {
    end--
    closeCount--
  }
  if (end > 0 && value.charCodeAt(end - 1) === CHAR_OPEN_PAREN) end--
  return end
}

/**
 * Trims prose punctuation and Markdown emphasis/strikethrough delimiters that
 * would otherwise be swallowed into the URL (`**https://x**.`,
 * `(~~https://x~~, next)`). Trailing punctuation can expose a delimiter and the
 * reverse, so the pass repeats until it stops changing the value; a trailing
 * `_` is trimmed only when it can be the closer of an underscore emphasis pair.
 */
function trimUrl(value: string, cx: InlineContext, pos: number): string {
  const underscoreOpener = hasUnderscoreOpener(cx, pos)
  let sawDelimiter = false
  let end = value.length
  let previousEnd = -1
  while (end > 0 && end !== previousEnd) {
    previousEnd = end
    const punctuation = TRAILING_PUNCTUATION.exec(value.slice(0, end))
    if (punctuation) end -= punctuation[0].length
    end = trimParens(value, end)
    while (end > 0 && isMarkdownDelimiter(value.charCodeAt(end - 1))) {
      sawDelimiter = true
      end--
    }
    if (underscoreOpener || sawDelimiter) {
      while (end > 0 && value.charCodeAt(end - 1) === CHAR_UNDERSCORE) end--
    }
  }
  return value.slice(0, end)
}

export const BareAutolink: InlineParser = {
  name: "BareAutolink",
  before: "Link",
  parse(cx, next, pos) {
    if (next !== CHAR_LOWER_H && next !== CHAR_LOWER_W && next !== CHAR_LOWER_F && next !== CHAR_AT &&
        !(next >= CHAR_ZERO && next <= CHAR_NINE) && !((next >= CHAR_UPPER_A && next <= CHAR_UPPER_Z) || (next >= CHAR_LOWER_A && next <= CHAR_LOWER_Z))) {
      return -1
    }
    if (cx.hasOpenLink) return -1
    if (!isBoundary(cx, pos)) return -1

    const rest = cx.slice(pos, cx.end)
    const match = rest.match(URL_PATTERN) ?? rest.match(EMAIL_PATTERN)
    if (!match) return -1

    const value = trimUrl(match[0], cx, pos)
    if (!value) return -1
    const to = pos + value.length
    return cx.addElement(cx.elt("Autolink", pos, to, [
      cx.elt("URL", pos, to),
    ]))
  },
}
