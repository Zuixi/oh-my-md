import type { InlineParser } from "@lezer/markdown"
import {
  CHAR_AT,
  CHAR_LOWER_A,
  CHAR_LOWER_F,
  CHAR_LOWER_H,
  CHAR_LOWER_W,
  CHAR_LOWER_Z,
  CHAR_NINE,
  CHAR_UPPER_A,
  CHAR_UPPER_Z,
  CHAR_ZERO,
} from "./chars"

const URL_PATTERN = /^(?:https?:\/\/|ftp:\/\/|www\.)[^\s<>()]+/i
const EMAIL_PATTERN = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i
const TRAILING_PUNCTUATION = /[.,!?;:]+$/

function trimUrl(value: string): string {
  return value.replace(TRAILING_PUNCTUATION, "")
}

function isBoundary(character: number): boolean {
  return character < 0 || !/[A-Z0-9_]/i.test(String.fromCharCode(character))
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
    if (!isBoundary(cx.char(pos - 1))) return -1

    const rest = cx.slice(pos, cx.end)
    const match = rest.match(URL_PATTERN) ?? rest.match(EMAIL_PATTERN)
    if (!match) return -1

    const value = trimUrl(match[0])
    if (!value) return -1
    const to = pos + value.length
    return cx.addElement(cx.elt("Autolink", pos, to, [
      cx.elt("URL", pos, to),
    ]))
  },
}
