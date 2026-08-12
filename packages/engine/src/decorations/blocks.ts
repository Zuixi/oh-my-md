import type { SyntaxNodeRef } from "@lezer/common"
import type { EditorState } from "@codemirror/state"
import { Decoration } from "@codemirror/view"
import { nearCursor, type DecoSpec } from "./types"
import { CheckboxWidget } from "./widgets"

// Folds a line-leading syntax mark ('>', '[^id]:') plus its trailing space,
// unless the cursor is on that line.
function foldLineMark(node: SyntaxNodeRef, state: EditorState, out: DecoSpec[], name: string) {
  const line = state.doc.lineAt(node.from)
  const end = Math.min(node.to + 1, line.to)
  if (!nearCursor(state, node.from, end))
    out.push({ from: node.from, to: end, tag: `replace:${name}`, deco: Decoration.replace({}) })
}

export function blockRules(node: SyntaxNodeRef, state: EditorState, out: DecoSpec[]) {
  switch (node.name) {
    case "TaskMarker": {
      const text = state.doc.sliceString(node.from, node.to)
      const checked = /x/i.test(text)
      out.push({
        from: node.from, to: node.to, tag: "widget:checkbox",
        deco: Decoration.replace({ widget: new CheckboxWidget(checked, node.from) }),
      })
      break
    }
    case "Blockquote": {
      for (let pos = node.from; pos <= node.to; ) {
        const line = state.doc.lineAt(pos)
        out.push({ from: line.from, to: line.from, tag: "line:omd-blockquote", deco: Decoration.line({ class: "omd-blockquote" }) })
        pos = line.to + 1
      }
      break
    }
    case "QuoteMark":    return foldLineMark(node, state, out, "QuoteMark")
    case "FootnoteMark": return foldLineMark(node, state, out, "FootnoteMark")
    case "HorizontalRule":
      out.push({ from: node.from, to: node.from, tag: "line:omd-hr", deco: Decoration.line({ class: "omd-hr" }) })
      break
  }
}
