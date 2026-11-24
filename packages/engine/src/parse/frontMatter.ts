import type { MarkdownConfig } from "@lezer/markdown"
import { lineDepth } from "./lineDepth"

// Top-of-document `---\n…\n---\n` YAML front matter treated as an opaque block:
// no YAML grammar validation and no YAML parser dependency (spec 2026-08-18-25).
// Recognized only at column 0 of line 1; `before: "HorizontalRule"` keeps the
// thematic-break rule from claiming an unindented opening fence.
export const FrontMatter: MarkdownConfig = {
  defineNodes: [
    { name: "FrontMatter", block: true },
    "FrontMatterMark",
  ],
  parseBlock: [{
    name: "FrontMatter",
    before: "HorizontalRule",
    parse(cx, line) {
      // Only column 0 of byte 0 opens front matter; indented `  ---` on line 1
      // or `---` anywhere later in the document stays a thematic break.
      if (cx.lineStart !== 0 || line.pos !== 0) return false
      if (line.text.trimEnd() !== "---") return false
      const start = 0
      const marks = [cx.elt("FrontMatterMark", start, start + 3)]

      // Consume through the next column-0 `---` line; unclosed blocks extend to EOF (matching math).
      while (cx.nextLine() && lineDepth(line) >= cx.depth) {
        const to = cx.lineStart + line.text.length
        if (line.text.trimEnd() === "---") {
          marks.push(cx.elt("FrontMatterMark", cx.lineStart, to))
          cx.nextLine()
          cx.addElement(cx.elt("FrontMatter", start, to, marks))
          return true
        }
      }
      const end = cx.lineStart + line.text.length
      cx.addElement(cx.elt("FrontMatter", start, end, marks))
      return true
    },
  }],
}
