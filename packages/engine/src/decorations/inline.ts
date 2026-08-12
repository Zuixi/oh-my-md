import type { SyntaxNodeRef } from "@lezer/common"
import type { EditorState } from "@codemirror/state"
import { Decoration } from "@codemirror/view"
import { nearCursor, type DecoSpec } from "./types"

const HEADING_CLASS: Record<string, string> = {
  ATXHeading1: "omd-h1", ATXHeading2: "omd-h2", ATXHeading3: "omd-h3",
  ATXHeading4: "omd-h4", ATXHeading5: "omd-h5", ATXHeading6: "omd-h6",
}

function childMarks(node: SyntaxNodeRef, name: string): { from: number; to: number }[] {
  const marks: { from: number; to: number }[] = []
  const c = node.node.cursor()
  if (c.firstChild()) do { if (c.name === name) marks.push({ from: c.from, to: c.to }) } while (c.nextSibling())
  return marks
}

function foldPair(node: SyntaxNodeRef, state: EditorState, out: DecoSpec[], markName: string, markClass: string) {
  const marks = childMarks(node, markName)
  if (marks.length >= 2) {
    for (const m of [marks[0], marks[marks.length - 1]])
      if (!nearCursor(state, m.from, m.to))
        out.push({ from: m.from, to: m.to, tag: `replace:${markName}`, deco: Decoration.replace({}) })
  }
  out.push({ from: node.from, to: node.to, tag: `mark:${markClass}`, deco: Decoration.mark({ class: markClass }) })
}

function foldLink(node: SyntaxNodeRef, state: EditorState, out: DecoSpec[]) {
  for (const m of childMarks(node, "LinkMark"))
    if (!nearCursor(state, m.from, m.to))
      out.push({ from: m.from, to: m.to, tag: "replace:LinkMark", deco: Decoration.replace({}) })
  const c = node.node.cursor()
  if (c.firstChild()) do {
    if (c.name === "URL" && !nearCursor(state, c.from, c.to))
      out.push({ from: c.from, to: c.to, tag: "replace:URL", deco: Decoration.replace({}) })
  } while (c.nextSibling())
  out.push({ from: node.from, to: node.to, tag: "mark:omd-link", deco: Decoration.mark({ class: "omd-link" }) })
}

export function inlineRules(node: SyntaxNodeRef, state: EditorState, out: DecoSpec[]) {
  const headingClass = HEADING_CLASS[node.name]
  if (headingClass) {
    out.push({
      from: node.from, to: node.from, tag: `line:${headingClass}`,
      deco: Decoration.line({ class: headingClass }),
    })

    const cursor = node.node.cursor()
    if (cursor.firstChild()) {
      do {
        if (cursor.name === "HeaderMark") {
          const line = state.doc.lineAt(node.from)
          const end = Math.min(cursor.to + 1, line.to)  // include the trailing space after '#'
          if (!nearCursor(state, cursor.from, end))
            out.push({ from: cursor.from, to: end, tag: "replace:HeaderMark", deco: Decoration.replace({}) })
        }
      } while (cursor.nextSibling())
    }
    return
  }

  switch (node.name) {
    case "StrongEmphasis": return foldPair(node, state, out, "EmphasisMark", "omd-strong")
    case "Emphasis":       return foldPair(node, state, out, "EmphasisMark", "omd-em")
    case "Strikethrough":  return foldPair(node, state, out, "StrikethroughMark", "omd-del")
    case "InlineCode":     return foldPair(node, state, out, "CodeMark", "omd-inline-code")
    case "Link":           return foldLink(node, state, out)
    case "FootnoteReference":
      out.push({ from: node.from, to: node.to, tag: "mark:omd-footnote",
                 deco: Decoration.mark({ class: "omd-footnote" }) })
      return
  }
}
