import type { InlineContext, MarkdownConfig } from "@lezer/markdown"
import { isEscaped } from "./scan"
import {
  CHAR_CARET,
  CHAR_NEWLINE,
  CHAR_SPACE,
  CHAR_TILDE,
} from "./chars"

// Typora-parity inline markup: `~x~` → Subscript, `^x^` → Superscript.
// Boundary checks mirror parse/math.ts InlineMath: no leading/trailing space,
// no newline inside, and `~~` (strikethrough) is never treated as subscript.
function findClose(cx: InlineContext, open: number, close: number): number {
  let i = open + 1
  while (i < cx.end) {
    if (isEscaped(cx, i)) { i += 2; continue }
    const c = cx.char(i)
    if (c == CHAR_NEWLINE) return -1
    if (c == close) {
      // For `~` skip a `~~` pair (strikethrough) as a closing delimiter.
      if (close == CHAR_TILDE && cx.char(i + 1) == CHAR_TILDE) { i += 2; continue }
      return i
    }
    i++
  }
  return -1
}

function riseParser(open: number, close: number, node: string) {
  return (cx: InlineContext, next: number, pos: number): number => {
    if (next != open) return -1
    if (isEscaped(cx, pos)) return -1
    // Double opener is a different construct (e.g. strikethrough `~~`).
    if (cx.char(pos + 1) == open) return -1
    if (cx.char(pos + 1) == CHAR_SPACE || cx.char(pos + 1) == CHAR_NEWLINE) return -1
    const closePos = findClose(cx, pos, close)
    if (closePos < 0 || closePos == pos + 1) return -1
    if (cx.char(closePos - 1) == CHAR_SPACE) return -1
    const inner = cx.parser.parseInline(cx.slice(pos + 1, closePos), pos + 1)
    return cx.addElement(cx.elt(node, pos, closePos + 1, [
      cx.elt("RiseMark", pos, pos + 1),
      ...inner,
      cx.elt("RiseMark", closePos, closePos + 1),
    ]))
  }
}

export const Rise: MarkdownConfig = {
  defineNodes: ["Subscript", "Superscript", "RiseMark"],
  parseInline: [
    { name: "Subscript", before: "Emphasis", parse: riseParser(CHAR_TILDE, CHAR_TILDE, "Subscript") },
    { name: "Superscript", before: "Emphasis", parse: riseParser(CHAR_CARET, CHAR_CARET, "Superscript") },
  ],
}
