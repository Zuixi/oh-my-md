import type { InlineContext, InlineParser } from "@lezer/markdown"
import {
  CHAR_ASTERISK,
  CHAR_AT,
  CHAR_LOWER_A,
  CHAR_LOWER_F,
  CHAR_LOWER_H,
  CHAR_LOWER_W,
  CHAR_LOWER_Z,
  CHAR_NINE,
  CHAR_TILDE,
  CHAR_UNDERSCORE,
  CHAR_UPPER_A,
  CHAR_UPPER_Z,
  CHAR_ZERO,
} from "./chars"

const URL_PATTERN = /^(?:https?:\/\/|ftp:\/\/|www\.)[^\s<>()]+/i
const EMAIL_PATTERN = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i
const TRAILING_PUNCTUATION = /[.,!?;:]+$/

function isMarkdownDelimiter(character: number): boolean {
  return character === CHAR_ASTERISK || character === CHAR_TILDE
}

/**
 * Trims Markdown emphasis/strikethrough delimiters that would otherwise be
 * swallowed into the URL (`**https://x**`, `~~https://x~~`). A trailing `_`
 * is trimmed only when it can be the closer of an underscore emphasis pair:
 * the URL starts right after `_`, or the URL is already bounded by a `*`/`~`
 * closer. Plain URLs ending in `_` are preserved.
 */
function trimUrl(value: string, cx: InlineContext, pos: number): string {
  let end = value.length
  let sawDelimiter = false
  while (end > 0 && isMarkdownDelimiter(value.charCodeAt(end - 1))) {
    sawDelimiter = true
    end--
  }
  const underscoreOpener = cx.char(pos - 1) === CHAR_UNDERSCORE && isUnderscoreBoundary(cx, pos)
  if (underscoreOpener || sawDelimiter) {
    while (end > 0 && value.charCodeAt(end - 1) === CHAR_UNDERSCORE) end--
  }
  return value.slice(0, end).replace(TRAILING_PUNCTUATION, "")
}

/**
 * `_` is a boundary only when it opens a Markdown emphasis run, not when it is
 * an intra-word underscore (`foo_bar`, `foo_https://…`).
 */
function isUnderscoreBoundary(cx: InlineContext, pos: number): boolean {
  if (cx.char(pos - 1) !== CHAR_UNDERSCORE) return false
  const before = cx.char(pos - 2)
  return before < 0 || !/[A-Z0-9]/i.test(String.fromCharCode(before))
}

function isBoundary(cx: InlineContext, pos: number): boolean {
  const previous = cx.char(pos - 1)
  if (previous < 0) return true
  if (previous === CHAR_UNDERSCORE) return isUnderscoreBoundary(cx, pos)
  return !/[A-Z0-9_]/i.test(String.fromCharCode(previous))
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
