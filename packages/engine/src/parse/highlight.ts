import type { InlineContext, MarkdownConfig } from "@lezer/markdown"
import { isEscaped, parseHtmlPair, skipInlineCode } from "./scan"

function findEqClose(cx: InlineContext, pos: number): number {
  let i = pos + 2
  while (i < cx.end - 1) {
    if (isEscaped(cx, i)) { i++; continue }
    const skipped = skipInlineCode(cx, i)
    if (skipped != i) { i = skipped; continue }
    if (cx.char(i) == 61 && cx.char(i + 1) == 61 && cx.char(i + 2) != 61) return i
    i++
  }
  return -1
}

const HTML_PAIRS = [
  { tag: "mark", node: "Highlight", mark: "HighlightMark" },
  { tag: "u", node: "Underline", mark: "UnderlineMark" },
] as const

export const Highlight: MarkdownConfig = {
  defineNodes: ["Highlight", "HighlightMark", "Underline", "UnderlineMark"],
  parseInline: [{
    name: "HighlightEq",
    after: "InlineCode",
    parse(cx, next, pos) {
      if (next != 61 || cx.char(pos + 1) != 61 || cx.char(pos + 2) == 61) return -1
      if (isEscaped(cx, pos)) return -1
      const close = findEqClose(cx, pos)
      if (close < 0 || close == pos + 2) return -1
      const inner = cx.parser.parseInline(cx.slice(pos + 2, close), pos + 2)
      return cx.addElement(cx.elt("Highlight", pos, close + 2, [
        cx.elt("HighlightMark", pos, pos + 2),
        ...inner,
        cx.elt("HighlightMark", close, close + 2),
      ]))
    },
  }, {
    name: "HighlightHtml",
    after: "InlineCode",
    before: "HTMLTag",
    parse(cx, next, pos) {
      if (next != 60) return -1
      for (const spec of HTML_PAIRS) {
        const end = parseHtmlPair(cx, pos, spec.tag, spec.node, spec.mark)
        if (end >= 0) return end
      }
      return -1
    },
  }],
}
