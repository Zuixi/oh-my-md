import type { InlineParser } from "@lezer/markdown"

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
    if (next !== 0x68 && next !== 0x77 && next !== 0x66 && next !== 0x40 &&
        !(next >= 0x30 && next <= 0x39) && !((next >= 0x41 && next <= 0x5a) || (next >= 0x61 && next <= 0x7a))) {
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
