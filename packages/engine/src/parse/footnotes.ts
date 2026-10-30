import type { MarkdownConfig } from "@lezer/markdown"
import {
  CHAR_CARET,
  CHAR_CLOSE_BRACKET,
  CHAR_NEWLINE,
  CHAR_OPEN_BRACKET,
} from "./chars"
import { isEscaped } from "./scan"

// ponytail: continuation lines must be indented >= 4 and directly adjacent;
// a blank line still ends the definition (full CommonMark allows lazy/blank
// continuations — upgrade if multi-paragraph footnotes matter).
export const Footnotes: MarkdownConfig = {
  defineNodes: [
    "FootnoteReference",
    { name: "FootnoteDefinition", block: true },
    "FootnoteMark",
  ],
  parseBlock: [{
    name: "FootnoteDefinition",
    before: "LinkReference", // `[^id]:` shape matches LinkReference; must run first
    parse(cx, line) {
      const m = /^\[\^([^\]\s][^\]]*)\]:[ \t]?/.exec(line.text.slice(line.pos))
      if (!m) return false
      const start = cx.lineStart + line.pos
      const markTo = start + m[1].length + 4  // "[^" + label + "]:" is fixed-width
      const children = [
        cx.elt("FootnoteMark", start, markTo),
        ...cx.parser.parseInline(line.text.slice(line.pos + m[0].length), start + m[0].length),
      ]
      let to = cx.lineStart + line.text.length
      // Consume continuation lines indented >= 4 (same loop shape as IndentedCode;
      // Line.depth exists at runtime but is missing from the public typings)
      while (cx.nextLine() && (line as unknown as { depth: number }).depth >= cx.depth) {
        if (line.pos == line.text.length || line.indent < line.baseIndent + 4) break
        const cFrom = cx.lineStart + line.findColumn(line.baseIndent + 4)
        to = cx.lineStart + line.text.length
        if (cFrom < to)
          children.push(...cx.parser.parseInline(line.text.slice(cFrom - cx.lineStart), cFrom))
      }
      cx.addElement(cx.elt("FootnoteDefinition", start, to, children))
      return true
    },
  }],
  parseInline: [{
    name: "FootnoteReference",
    before: "Link", // claim '[^' before the Link parser sees '['
    parse(cx, next, pos) {
      if (next != CHAR_OPEN_BRACKET || cx.char(pos + 1) != CHAR_CARET) return -1
      if (isEscaped(cx, pos)) return -1 // 被转义的 '[' 是字面量
      let i = pos + 2
      while (i < cx.end) {
        const c = cx.char(i)
        if (c == CHAR_OPEN_BRACKET || c == CHAR_NEWLINE) return -1 // no nested '[' or newline
        if (c == CHAR_CLOSE_BRACKET && !isEscaped(cx, i)) break // 转义的 ']' 留在标签里
        i++
      }
      if (i == pos + 2 || i >= cx.end) return -1 // empty label or unterminated
      return cx.addElement(cx.elt("FootnoteReference", pos, i + 1))
    },
  }],
}
