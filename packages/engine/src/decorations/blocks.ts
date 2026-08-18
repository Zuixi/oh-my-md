import type { SyntaxNode, SyntaxNodeRef } from "@lezer/common"
import type { EditorState } from "@codemirror/state"
import { Decoration } from "@codemirror/view"
import { cursorInside, nearCursor, type DecoSpec } from "./types"
import { CheckboxWidget, BulletWidget, OrderedWidget, HrWidget, FrontMatterWidget } from "./widgets"
import { blockSelected, type BlockEmbed } from "./blockWidget"
import { TableWidget, type TableAlignment, type TableData } from "./widgets/table"
import { imageResolver } from "./widgets/image"
import { CodeWidget } from "./widgets/code"
import { MathBlockWidget } from "./widgets/math"
import { MermaidWidget } from "./widgets/mermaid"
import { orderedLabel } from "../lists/ordered"

const MAX_QUOTE_DEPTH = 4
const MAX_LIST_DEPTH = 4

// Folds a line-leading syntax mark ('[^id]:') plus its trailing space,
// unless the cursor is on that line.
function foldLineMark(node: SyntaxNodeRef, state: EditorState, out: DecoSpec[], name: string) {
  const line = state.doc.lineAt(node.from)
  const end = Math.min(node.to + 1, line.to)
  if (!nearCursor(state, node.from, end))
    out.push({ from: node.from, to: end, tag: `replace:${name}`, deco: Decoration.replace({}) })
}

function quoteMarkEnd(node: SyntaxNodeRef, state: EditorState): number {
  const line = state.doc.lineAt(node.from)
  if (node.to < line.to && state.doc.sliceString(node.to, node.to + 1) === " ")
    return node.to + 1
  return node.to
}

function foldQuoteMark(node: SyntaxNodeRef, state: EditorState, out: DecoSpec[]) {
  const line = state.doc.lineAt(node.from)
  if (node.from > line.from && !cursorInside(state, line.from, node.from)) {
    const prefix = state.doc.sliceString(line.from, node.from)
    if (/^[ \t]+$/.test(prefix)) {
      out.push({
        from: line.from, to: node.from, tag: "replace:QuoteIndent",
        deco: Decoration.replace({}),
      })
    }
  }
  const end = quoteMarkEnd(node, state)
  if (cursorInside(state, node.from, end)) return
  out.push({
    from: node.from, to: end, tag: "replace:QuoteMark",
    deco: Decoration.replace({}),
  })
}

function quoteDepth(node: SyntaxNode): number {
  let depth = 0
  for (let parent: SyntaxNode | null = node; parent; parent = parent.parent) {
    if (parent.name === "Blockquote") depth++
  }
  return depth
}

function childQuoteCoversLine(blockquote: SyntaxNode, lineFrom: number, lineTo: number): boolean {
  for (let child = blockquote.firstChild; child; child = child.nextSibling) {
    if (child.name === "Blockquote" && child.from < lineTo && child.to > lineFrom)
      return true
  }
  return false
}

function fencedCodeSource(node: SyntaxNode, state: EditorState): string {
  const parts: string[] = []
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "CodeText") parts.push(state.doc.sliceString(child.from, child.to))
  }
  return parts.join("")
}

function listDepth(node: SyntaxNode): number {
  let depth = 0
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.name === "ListItem") depth++
  }
  return depth
}

function ancestorQuoteDepth(node: SyntaxNode): number {
  let depth = 0
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.name === "Blockquote") depth++
  }
  return depth
}

function quoteInsideList(node: SyntaxNode): boolean {
  for (let parent: SyntaxNode | null = node; parent; parent = parent.parent) {
    if (parent.name === "Blockquote") return listDepth(parent) > 0
  }
  return false
}

function blockEmbed(node: SyntaxNode): BlockEmbed {
  return {
    quoteDepth: Math.min(ancestorQuoteDepth(node), MAX_QUOTE_DEPTH),
    listDepth: Math.min(listDepth(node), MAX_LIST_DEPTH),
    quoteInList: quoteInsideList(node),
  }
}

function styleCodeblockLines(node: SyntaxNodeRef, state: EditorState, out: DecoSpec[]) {
  for (let pos = node.from; pos <= node.to; ) {
    const line = state.doc.lineAt(pos)
    out.push({
      from: line.from, to: line.from, tag: "line:omd-codeblock",
      deco: Decoration.line({ class: "omd-codeblock" }),
    })
    pos = line.to + 1
  }
}

function foldQuotedFenceMark(node: SyntaxNodeRef, state: EditorState, out: DecoSpec[], name: string) {
  if (cursorInside(state, node.from, node.to)) return
  out.push({
    from: node.from, to: node.to, tag: `replace:${name}`,
    deco: Decoration.replace({}),
  })
}

function styleFencedCode(node: SyntaxNodeRef, state: EditorState, out: DecoSpec[]): boolean {
  if (blockSelected(state, node.from, node.to)) {
    styleCodeblockLines(node, state, out)
    return false
  }
  const info = node.node.getChild("CodeInfo")
  const lang = info ? state.doc.sliceString(info.from, info.to).trim().split(/\s/)[0] : ""
  const src = fencedCodeSource(node.node, state)
  const embed = blockEmbed(node.node)
  if (lang === "mermaid") {
    out.push({
      from: node.from, to: node.to, tag: "widget:block:mermaid",
      deco: Decoration.replace({ widget: new MermaidWidget(src, node.from, embed), block: true }),
    })
    return true
  }
  if (!lang || insideBlockquote(node.node)) {
    styleCodeblockLines(node, state, out)
    return false
  }
  out.push({
    from: node.from, to: node.to, tag: "widget:block:code",
    deco: Decoration.replace({ widget: new CodeWidget(src, node.from, lang, embed), block: true }),
  })
  return true
}

function styleBlockquote(node: SyntaxNodeRef, state: EditorState, out: DecoSpec[]) {
  const depth = Math.min(Math.max(quoteDepth(node.node), 1), MAX_QUOTE_DEPTH)
  const itemDepth = Math.min(listDepth(node.node), MAX_LIST_DEPTH)
  for (let pos = node.from; pos <= node.to; ) {
    const line = state.doc.lineAt(pos)
    if (!childQuoteCoversLine(node.node, line.from, line.to)) {
      out.push({
        from: line.from, to: line.from,
        tag: `line:omd-blockquote-${depth}`,
        deco: Decoration.line({ class: `omd-blockquote omd-blockquote-${depth}` }),
      })
      if (itemDepth > 0) {
        out.push({
          from: line.from, to: line.from,
          tag: `line:omd-quote-in-li-${itemDepth}`,
          deco: Decoration.line({ class: `omd-quote-in-li-${itemDepth}` }),
        })
      }
    }
    pos = line.to + 1
  }
}

function insideBlockquote(node: SyntaxNode): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.name === "Blockquote") return true
  }
  return false
}

function listIndentStart(lineFrom: number, markFrom: number, state: EditorState): number {
  let from = markFrom
  while (from > lineFrom) {
    const ch = state.doc.sliceString(from - 1, from)
    if (ch !== " " && ch !== "\t") break
    from--
  }
  // `> ` is owned by QuoteMark; only extra spaces after it are list indent.
  if (from > lineFrom && state.doc.sliceString(from - 1, from) === ">")
    return from + 1
  return from
}

function listMarkActive(state: EditorState, from: number, to: number, inQuote: boolean): boolean {
  return inQuote ? cursorInside(state, from, to) : nearCursor(state, from, to)
}

function styleListMark(node: SyntaxNodeRef, state: EditorState, out: DecoSpec[]) {
  const line = state.doc.lineAt(node.from)
  let depth = 0
  for (let parent = node.node.parent; parent; parent = parent.parent) {
    if (parent.name === "ListItem") depth++
  }
  const cls = `omd-li-${Math.min(depth, MAX_LIST_DEPTH)}`
  out.push({ from: line.from, to: line.from, tag: `line:${cls}`, deco: Decoration.line({ class: cls }) })

  const inQuote = insideBlockquote(node.node)
  const indentFrom = listIndentStart(line.from, node.from, state)
  if (indentFrom < node.from && !listMarkActive(state, indentFrom, node.from, inQuote)) {
    out.push({
      from: indentFrom, to: node.from, tag: "replace:ListIndent",
      deco: Decoration.replace({}),
    })
  }
  if (node.node.parent?.getChild("Task")) return

  const text = state.doc.sliceString(node.from, node.to)
  const active = listMarkActive(state, node.from, node.to, inQuote)
  if (/^\d/.test(text)) {
    if (active) {
      out.push({
        from: node.from, to: node.to, tag: "mark:omd-list-mark",
        deco: Decoration.mark({ class: "omd-list-mark" }),
      })
    } else {
      const label = orderedLabel(node.node, state) ?? text
      out.push({
        from: node.from, to: node.to, tag: "widget:ordered-mark",
        deco: Decoration.replace({ widget: new OrderedWidget(label) }),
      })
    }
    return
  }
  if (!active) {
    out.push({
      from: node.from, to: node.to, tag: "replace:ListMark",
      deco: Decoration.replace({ widget: new BulletWidget() }),
    })
  }
}

function directCells(row: SyntaxNode, state: EditorState) {
  const cells: string[] = []
  for (let child = row.firstChild; child; child = child.nextSibling) {
    if (child.name !== "TableCell") continue
    const source = state.doc.sliceString(child.from, child.to)
    cells.push(source
      .replace(/\\\|/g, "|")
      .trim())
  }
  return cells
}

function tableData(node: SyntaxNode, state: EditorState): TableData | null {
  const header = node.getChild("TableHeader")
  if (!header) return null
  const rows: string[][] = []
  let delimiter = ""
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "TableRow") rows.push(directCells(child, state))
    else if (child.name === "TableDelimiter") {
      delimiter = state.doc.sliceString(child.from, child.to)
    }
  }
  const aligns = delimiter
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map<TableAlignment>(cell => {
      const marker = cell.trim()
      if (/^:-/.test(marker) && /-:$/.test(marker)) return "center"
      if (/-:$/.test(marker)) return "right"
      if (/^:-/.test(marker)) return "left"
      return ""
    })
  return { header: directCells(header, state), rows, aligns }
}

export function blockRules(node: SyntaxNodeRef, state: EditorState, out: DecoSpec[]): boolean {
  switch (node.name) {
    case "ListMark": { styleListMark(node, state, out); break }
    case "FencedCode": return styleFencedCode(node, state, out)
    case "CodeMark": {
      if (node.node.parent?.name === "FencedCode" && insideBlockquote(node.node))
        foldQuotedFenceMark(node, state, out, "CodeMark")
      break
    }
    case "CodeInfo": {
      if (insideBlockquote(node.node)) foldQuotedFenceMark(node, state, out, "CodeInfo")
      break
    }
    case "CodeBlock": {   // 缩进代码块保持行样式（无语言信息，不值得 widget）
      styleCodeblockLines(node, state, out)
      return false
    }
    case "MathBlock": {
      if (blockSelected(state, node.from, node.to)) return false
      out.push({
        from: node.from, to: node.to, tag: "widget:block:math",
        deco: Decoration.replace({
          widget: new MathBlockWidget(
            state.doc.sliceString(node.from, node.to),
            node.from,
            blockEmbed(node.node),
          ),
          block: true,
        }),
      })
      return true
    }
    case "Table": {
      if (blockSelected(state, node.from, node.to)) return false
      const table = tableData(node.node, state)
      if (!table) return false
      out.push({
        from: node.from, to: node.to, tag: "widget:block:table",
        deco: Decoration.replace({
          widget: new TableWidget(
            state.doc.sliceString(node.from, node.to),
            node.from,
            table,
            blockEmbed(node.node),
            state.facet(imageResolver),
          ),
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
    case "Blockquote": { styleBlockquote(node, state, out); break }
    case "QuoteMark":    { foldQuoteMark(node, state, out); return false }
    case "FootnoteMark": { foldLineMark(node, state, out, "FootnoteMark"); return false }
    case "FootnoteDefinition": {
      for (let pos = node.from; pos <= node.to; ) {
        const line = state.doc.lineAt(pos)
        out.push({ from: line.from, to: line.from, tag: "line:omd-footnote-def", deco: Decoration.line({ class: "omd-footnote-def" }) })
        pos = line.to + 1
      }
      break
    }
    case "HorizontalRule":
      if (blockSelected(state, node.from, node.to)) {
        out.push({ from: node.from, to: node.from, tag: "line:omd-hr", deco: Decoration.line({ class: "omd-hr" }) })
        return false
      }
      out.push({
        from: node.from, to: node.to, tag: "widget:block:hr",
        deco: Decoration.replace({
          widget: new HrWidget(
            state.doc.sliceString(node.from, node.to),
            node.from,
            blockEmbed(node.node),
          ),
          block: true,
        }),
      })
      return true
    case "FrontMatter":
      if (blockSelected(state, node.from, node.to)) {
        for (let pos = node.from; pos < node.to; ) {
          const line = state.doc.lineAt(pos)
          out.push({ from: line.from, to: line.from, tag: "line:omd-front-matter", deco: Decoration.line({ class: "omd-front-matter-src" }) })
          pos = line.to + 1
        }
        return false
      }
      out.push({
        from: node.from, to: node.to, tag: "widget:block:front-matter",
        deco: Decoration.replace({
          widget: new FrontMatterWidget(
            state.doc.sliceString(node.from, node.to),
            node.from,
            blockEmbed(node.node),
          ),
          block: true,
        }),
      })
      return true
  }
  return false
}
