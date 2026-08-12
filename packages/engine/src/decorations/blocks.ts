import type { SyntaxNodeRef } from "@lezer/common"
import type { EditorState } from "@codemirror/state"
import { Decoration } from "@codemirror/view"
import { nearCursor, type DecoSpec } from "./types"
import { CheckboxWidget, BulletWidget } from "./widgets"

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
    case "ListMark": {
      const line = state.doc.lineAt(node.from)
      // Nesting depth = number of ListItem ancestors (incl. own); cap styling at 4.
      let depth = 0
      for (let p = node.node.parent; p; p = p.parent) if (p.name === "ListItem") depth++
      const cls = `omd-li-${Math.min(depth, 4)}`
      out.push({ from: line.from, to: line.from, tag: `line:${cls}`, deco: Decoration.line({ class: cls }) })
      // Hide the source indent spaces; CSS provides the visual indent.
      if (node.from > line.from && !nearCursor(state, line.from, node.from))
        out.push({ from: line.from, to: node.from, tag: "replace:ListIndent", deco: Decoration.replace({}) })
      // Task list items show a checkbox instead of a bullet — skip the mark there.
      if (node.node.parent?.getChild("Task")) break
      const text = state.doc.sliceString(node.from, node.to)
      if (/^\d/.test(text)) {   // ordered list: keep the number, just style it
        out.push({ from: node.from, to: node.to, tag: "mark:omd-list-mark", deco: Decoration.mark({ class: "omd-list-mark" }) })
      } else if (!nearCursor(state, node.from, node.to)) {
        out.push({ from: node.from, to: node.to, tag: "replace:ListMark", deco: Decoration.replace({ widget: new BulletWidget() }) })
      }
      break
    }
    case "FencedCode":
    case "CodeBlock": {   // ponytail: line styling only; syntax highlight is M2
      for (let pos = node.from; pos <= node.to; ) {
        const line = state.doc.lineAt(pos)
        out.push({ from: line.from, to: line.from, tag: "line:omd-codeblock", deco: Decoration.line({ class: "omd-codeblock" }) })
        pos = line.to + 1
      }
      break
    }
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
