import type { SyntaxNodeRef } from "@lezer/common"
import type { EditorState } from "@codemirror/state"
import { Decoration } from "@codemirror/view"
import { nearCursor, type DecoSpec } from "./types"

const HEADING_CLASS: Record<string, string> = {
  ATXHeading1: "omd-h1", ATXHeading2: "omd-h2", ATXHeading3: "omd-h3",
  ATXHeading4: "omd-h4", ATXHeading5: "omd-h5", ATXHeading6: "omd-h6",
}

export function inlineRules(node: SyntaxNodeRef, state: EditorState, out: DecoSpec[]) {
  const headingClass = HEADING_CLASS[node.name]
  if (!headingClass) return

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
}
