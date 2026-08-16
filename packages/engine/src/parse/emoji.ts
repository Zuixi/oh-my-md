import type { MarkdownConfig } from "@lezer/markdown"
import { isEscaped } from "./scan"
import {
  CHAR_COLON,
  CHAR_MINUS,
  CHAR_NINE,
  CHAR_PLUS,
  CHAR_UNDERSCORE,
  CHAR_ZERO,
  CHAR_LOWER_A,
  CHAR_LOWER_Z,
} from "./chars"
import emojiByAlias from "./emoji.json"

const EMOJI = emojiByAlias as Record<string, string>

export function resolveEmoji(alias: string): string | null {
  return EMOJI[alias] ?? null
}

export function suggestEmoji(query: string): { alias: string; ch: string }[] {
  const q = query.toLowerCase()
  const prefix: { alias: string; ch: string }[] = []
  const rest: { alias: string; ch: string }[] = []
  for (const alias of Object.keys(EMOJI)) {
    if (q && !alias.startsWith(q) && !alias.includes(q)) continue
    const item = { alias, ch: EMOJI[alias] }
    if (!q || alias.startsWith(q)) prefix.push(item)
    else rest.push(item)
  }
  return prefix.concat(rest)
}

function isAliasChar(code: number): boolean {
  if (code >= CHAR_LOWER_A && code <= CHAR_LOWER_Z) return true
  if (code >= CHAR_ZERO && code <= CHAR_NINE) return true
  return code === CHAR_UNDERSCORE || code === CHAR_PLUS || code === CHAR_MINUS
}

export const Emoji: MarkdownConfig = {
  defineNodes: ["Emoji"],
  parseInline: [{
    name: "Emoji",
    after: "InlineCode",
    parse(cx, next, pos) {
      if (next != CHAR_COLON || isEscaped(cx, pos)) return -1
      let i = pos + 1
      while (i < cx.end && isAliasChar(cx.char(i))) i++
      if (i === pos + 1 || i >= cx.end || cx.char(i) != CHAR_COLON) return -1
      if (!resolveEmoji(cx.slice(pos + 1, i))) return -1
      return cx.addElement(cx.elt("Emoji", pos, i + 1))
    },
  }],
}
