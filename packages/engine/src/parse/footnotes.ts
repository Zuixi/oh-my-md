import { tags as t } from "@lezer/highlight"
import type { MarkdownConfig } from "@lezer/markdown"

// ponytail: definitions consume a single line only (`[^id]: body`); continuation
// lines degrade to a plain paragraph. Upgrade to a LeafBlockParser (like
// LinkReference's nextLine accumulation) when multi-line footnotes matter.
export const Footnotes: MarkdownConfig = {
  defineNodes: [
    { name: "FootnoteReference", style: t.link },
    { name: "FootnoteDefinition", block: true },
    { name: "FootnoteMark", style: t.processingInstruction },
  ],
  parseBlock: [{
    name: "FootnoteDefinition",
    before: "LinkReference", // `[^id]:` shape matches LinkReference; must run first
    parse(cx, line) {
      const m = /^\[\^([^\]\s][^\]]*)\]:[ \t]?/.exec(line.text.slice(line.pos))
      if (!m) return false
      const start = cx.lineStart + line.pos
      const trailing = m[0].endsWith(" ") || m[0].endsWith("\t") ? 1 : 0
      const markTo = start + m[0].length - trailing
      const bodyFrom = start + m[0].length
      const body = line.text.slice(line.pos + m[0].length)
      cx.addElement(cx.elt("FootnoteDefinition", start, cx.lineStart + line.text.length, [
        cx.elt("FootnoteMark", start, markTo),
        ...cx.parser.parseInline(body, bodyFrom),
      ]))
      cx.nextLine()
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
