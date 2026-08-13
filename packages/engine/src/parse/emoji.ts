import type { MarkdownConfig } from "@lezer/markdown"
import { isEscaped } from "./scan"
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
  if (code >= 97 && code <= 122) return true
  if (code >= 48 && code <= 57) return true
  return code === 95 || code === 43 || code === 45
}

export const Emoji: MarkdownConfig = {
  defineNodes: ["Emoji"],
  parseInline: [{
    name: "Emoji",
    after: "InlineCode",
    parse(cx, next, pos) {
      if (next != 58 || isEscaped(cx, pos)) return -1
      let i = pos + 1
      while (i < cx.end && isAliasChar(cx.char(i))) i++
      if (i === pos + 1 || i >= cx.end || cx.char(i) != 58) return -1
      if (!resolveEmoji(cx.slice(pos + 1, i))) return -1
      return cx.addElement(cx.elt("Emoji", pos, i + 1))
    },
  }],
}
