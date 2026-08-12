import type { SyntaxNodeRef } from "@lezer/common"
import type { EditorState } from "@codemirror/state"
import { Decoration } from "@codemirror/view"
import { nearCursor, type DecoSpec } from "./types"
import { CheckboxWidget, BulletWidget } from "./widgets"
import { blockSelected } from "./blockWidget"
import { TableWidget } from "./widgets/table"
import { CodeWidget } from "./widgets/code"
import { MathBlockWidget } from "./widgets/math"
import { MermaidWidget } from "./widgets/mermaid"

// Folds a line-leading syntax mark ('>', '[^id]:') plus its trailing space,
// unless the cursor is on that line.
function foldLineMark(node: SyntaxNodeRef, state: EditorState, out: DecoSpec[], name: string) {
  const line = state.doc.lineAt(node.from)
  const end = Math.min(node.to + 1, line.to)
  if (!nearCursor(state, node.from, end))
    out.push({ from: node.from, to: end, tag: `replace:${name}`, deco: Decoration.replace({}) })
}

export function blockRules(node: SyntaxNodeRef, state: EditorState, out: DecoSpec[]): boolean {
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
    case "FencedCode": {
      if (blockSelected(state, node.from, node.to)) {
        // 编辑态：退回 M1 行样式
        for (let pos = node.from; pos <= node.to; ) {
          const line = state.doc.lineAt(pos)
          out.push({ from: line.from, to: line.from, tag: "line:omd-codeblock", deco: Decoration.line({ class: "omd-codeblock" }) })
          pos = line.to + 1
        }
        return false
      }
      const info = node.node.getChild("CodeInfo")
      const lang = info ? state.doc.sliceString(info.from, info.to).trim().split(/\s/)[0] : ""
      // 内容 = 全部 CodeText 子节点合并区间
      let cFrom = -1, cTo = -1
      for (let c = node.node.firstChild; c; c = c.nextSibling) {
        if (c.name === "CodeText") { if (cFrom < 0) cFrom = c.from; cTo = c.to }
      }
      const src = cFrom >= 0 ? state.doc.sliceString(cFrom, cTo) : ""
      if (lang === "mermaid") {
        out.push({
          from: node.from, to: node.to, tag: "widget:block:mermaid",
          deco: Decoration.replace({ widget: new MermaidWidget(src, node.from), block: true }),
        })
      } else {
        out.push({
          from: node.from, to: node.to, tag: "widget:block:code",
          deco: Decoration.replace({ widget: new CodeWidget(src, node.from, lang), block: true }),
        })
      }
      return true
    }
    case "CodeBlock": {   // 缩进代码块保持行样式（无语言信息，不值得 widget）
      for (let pos = node.from; pos <= node.to; ) {
        const line = state.doc.lineAt(pos)
        out.push({ from: line.from, to: line.from, tag: "line:omd-codeblock", deco: Decoration.line({ class: "omd-codeblock" }) })
        pos = line.to + 1
      }
      return false
    }
    case "MathBlock": {
      if (blockSelected(state, node.from, node.to)) return false
      out.push({
        from: node.from, to: node.to, tag: "widget:block:math",
        deco: Decoration.replace({
          widget: new MathBlockWidget(state.doc.sliceString(node.from, node.to), node.from),
          block: true,
        }),
      })
      return true
    }
    case "Table": {
      if (blockSelected(state, node.from, node.to)) return false
      out.push({
        from: node.from, to: node.to, tag: "widget:block:table",
        deco: Decoration.replace({
          widget: new TableWidget(state.doc.sliceString(node.from, node.to), node.from),
          block: true,
        }),
      })
      return true
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
    case "QuoteMark":    { foldLineMark(node, state, out, "QuoteMark"); return false }
    case "FootnoteMark": { foldLineMark(node, state, out, "FootnoteMark"); return false }
    case "HorizontalRule":
      out.push({ from: node.from, to: node.from, tag: "line:omd-hr", deco: Decoration.line({ class: "omd-hr" }) })
      break
  }
  return false
}
