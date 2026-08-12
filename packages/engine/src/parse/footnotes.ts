import type { MarkdownConfig } from "@lezer/markdown"

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
      if (next != 91 /* '[' */ || cx.char(pos + 1) != 94 /* '^' */) return -1
      let i = pos + 2
      while (i < cx.end && cx.char(i) != 93 /* ']' */) {
        if (cx.char(i) == 91 || cx.char(i) == 10) return -1 // no nested '[' or newline
        i++
      }
      if (i == pos + 2 || i >= cx.end) return -1 // empty label or unterminated
      return cx.addElement(cx.elt("FootnoteReference", pos, i + 1))
    },
  }],
}
