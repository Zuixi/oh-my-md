import type { InlineContext } from "@lezer/markdown"
import {
  CHAR_BACKSLASH,
  CHAR_BACKTICK,
  CHAR_CARRIAGE_RETURN,
  CHAR_GT,
  CHAR_LT,
  CHAR_NEWLINE,
  CHAR_SLASH,
  CHAR_SPACE,
  CHAR_TAB,
} from "./chars"

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

const isTagSpace = (ch: number) =>
  ch == CHAR_SPACE || ch == CHAR_TAB || ch == CHAR_NEWLINE || ch == CHAR_CARRIAGE_RETURN

// `</tag\s*>` — the fixed no-attribute close shape, case-insensitive and scanned
// character by character (never a regex over the remaining document).
// Returns the close tag's length, or -1.
function matchCloseTag(cx: InlineContext, pos: number, tag: string): number {
  if (cx.char(pos) != CHAR_LT || cx.char(pos + 1) != CHAR_SLASH) return -1
  let i = pos + 2
  for (let t = 0; t < tag.length; t++, i++) {
    const ch = cx.char(i)
    if (ch < 0 || String.fromCharCode(ch).toLowerCase() != tag[t]) return -1
  }
  while (isTagSpace(cx.char(i))) i++
  return cx.char(i) == CHAR_GT ? i + 1 - pos : -1
}

export function parseHtmlPair(
  cx: InlineContext,
  pos: number,
  tag: string,
  node: string,
  mark: string,
): number {
  if (isEscaped(cx, pos)) return -1
  const open = new RegExp(`^<${tag}\\s*>`, "i").exec(cx.slice(pos, cx.end))
  if (!open) return -1
  const contentStart = pos + open[0].length
  // Iterative close search: skips escaped chars and complete inline-code spans, so a
  // same-name closing tag inside code never terminates the pair early.
  let contentEnd = -1
  let closeEnd = -1
  for (let i = contentStart; i < cx.end;) {
    if (isEscaped(cx, i)) { i++; continue }
    const skipped = skipInlineCode(cx, i)
    if (skipped != i) { i = skipped; continue }
    const len = matchCloseTag(cx, i, tag)
    if (len >= 0) { contentEnd = i; closeEnd = i + len; break }
    i++
  }
  if (contentEnd < 0) return -1
  const inner = cx.parser.parseInline(cx.slice(contentStart, contentEnd), contentStart)
  return cx.addElement(cx.elt(node, pos, closeEnd, [
    cx.elt(mark, pos, contentStart),
    ...inner,
    cx.elt(mark, contentEnd, closeEnd),
  ]))
}
