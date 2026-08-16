import type { InlineContext } from "@lezer/markdown"
import { CHAR_BACKSLASH, CHAR_BACKTICK } from "./chars"

export function isEscaped(cx: InlineContext, pos: number): boolean {
  let n = 0
  for (let i = pos - 1; i >= cx.offset && cx.char(i) == CHAR_BACKSLASH; i--) n++
  return n % 2 === 1
}

// Advance past a backtick code span starting at pos; if unclosed, skip the opener ticks.
export function skipInlineCode(cx: InlineContext, pos: number): number {
  if (cx.char(pos) != CHAR_BACKTICK) return pos
  let ticks = 0
  while (cx.char(pos + ticks) == CHAR_BACKTICK) ticks++
  let i = pos + ticks
  while (i < cx.end) {
    if (cx.char(i) != CHAR_BACKTICK) { i++; continue }
    let n = 0
    while (cx.char(i + n) == CHAR_BACKTICK) n++
    if (n === ticks) return i + n
    i += n
  }
  return pos + ticks
}

export function parseHtmlPair(
  cx: InlineContext,
  pos: number,
  tag: string,
  node: string,
  mark: string,
): number {
  const open = new RegExp(`^<${tag}\\s*>`, "i").exec(cx.slice(pos, cx.end))
  if (!open) return -1
  const contentStart = pos + open[0].length
  const rest = cx.slice(contentStart, cx.end)
  const close = new RegExp(`</${tag}\\s*>`, "i").exec(rest)
  if (!close) return -1
  const contentEnd = contentStart + close.index
  const closeEnd = contentEnd + close[0].length
  const inner = cx.parser.parseInline(cx.slice(contentStart, contentEnd), contentStart)
  return cx.addElement(cx.elt(node, pos, closeEnd, [
    cx.elt(mark, pos, contentStart),
    ...inner,
    cx.elt(mark, contentEnd, closeEnd),
  ]))
}
