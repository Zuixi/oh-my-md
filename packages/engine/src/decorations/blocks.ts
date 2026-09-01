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
import { parseFenceInfo } from "../fenceInfo"

const MAX_QUOTE_DEPTH = 4
const MAX_LIST_DEPTH = 4

// Folds a line-leading syntax mark ('[^id]:') plus its trailing space unless the
// caret is inside the mark itself — same span granularity as the inline reveal
// (cursorInside), not line-based: editing the definition content keeps the label
// folded; clicking into the label reveals it for editing.
function foldLineMark(node: SyntaxNodeRef, state: EditorState, out: DecoSpec[], name: string) {
  const line = state.doc.lineAt(node.from)
  const end = Math.min(node.to + 1, line.to)
  if (!cursorInside(state, node.from, end))
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

function foldFenceMark(node: SyntaxNodeRef, state: EditorState, out: DecoSpec[], name: string) {
  if (cursorInside(state, node.from, node.to)) return
  out.push({
    from: node.from, to: node.to, tag: `replace:${name}`,
    deco: Decoration.replace({}),
  })
}

function styleFencedCode(node: SyntaxNodeRef, state: EditorState, out: DecoSpec[]): boolean {
  const infoNode = node.node.getChild("CodeInfo")
  const infoRaw = infoNode ? state.doc.sliceString(infoNode.from, infoNode.to) : ""
  const { lang: langToken, title } = parseFenceInfo(infoRaw)
  const src = fencedCodeSource(node.node, state)
  const embed = blockEmbed(node.node)

  // 未闭合围栏正在输入（FencedCode 只有 opening 行且光标在其上）：保持纯文本。
  // 围栏行一旦被解析就立即灰底/挂 widget，用户观感是“``` 还没按 Enter 就渲染了”
  // （Typora 在 Enter 前不呈现块）。Enter 的闭合补全见 format/fences.ts，成块后
  // 走下方常规分支（光标在内 → 源码行样式，光标离开 → widget）。
  const singleLine = state.doc.lineAt(node.from).number === state.doc.lineAt(node.to).number
  if (singleLine && blockSelected(state, node.from, node.to)) {
    return true
  }

  // mermaid 与 lang-code 同一编辑模型：光标进入块 → 卸载成源码行。✎/wrap 点击、
  // ↑/↓ 进块派发的光标都依赖 blockSelected 门控触发卸载；缺门控时光标会落入被
  // replace 隐藏的源码区（✎ 点击"无效"、打字盲改）。
  if (langToken === "mermaid" && !blockSelected(state, node.from, node.to)) {
    out.push({
      from: node.from, to: node.to, tag: "widget:block:mermaid",
      deco: Decoration.replace({ widget: new MermaidWidget(src, node.from, embed), block: true }),
    })
    return true
  }
  if (!langToken || insideBlockquote(node.node)) {
    styleCodeblockLines(node, state, out)
    return false
  }
  if (blockSelected(state, node.from, node.to)) {
    styleCodeblockLines(node, state, out)
    return true
  }
  out.push({
    from: node.from, to: node.to, tag: "widget:block:code",
    deco: Decoration.replace({
      widget: new CodeWidget({
        src,
        pos: node.from,
        lang: langToken,
        title,
        embed,
      }),
      block: true,
    }),
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

function styleListMark(node: SyntaxNodeRef, state: EditorState, out: DecoSpec[]) {
  const line = state.doc.lineAt(node.from)
  let depth = 0
  for (let parent = node.node.parent; parent; parent = parent.parent) {
    if (parent.name === "ListItem") depth++
  }
  const cls = `omd-li-${Math.min(depth, MAX_LIST_DEPTH)}`
  out.push({ from: line.from, to: line.from, tag: `line:${cls}`, deco: Decoration.line({ class: cls }) })

  // 路线 A：列表符与缩进无条件折叠 —— 点击列表文本只定位光标，不闪源码；
  // 列表增删走 toggleOrderedList / toggleUnorderedList 命令。
  const indentFrom = listIndentStart(line.from, node.from, state)
  if (indentFrom < node.from) {
    out.push({
      from: indentFrom, to: node.from, tag: "replace:ListIndent",
      deco: Decoration.replace({}),
    })
  }
  if (node.node.parent?.getChild("Task")) {
    out.push({
      from: node.from,
      to: node.to,
      tag: "replace:ListMark",
      deco: Decoration.replace({}),
    })
    return
  }

  const text = state.doc.sliceString(node.from, node.to)
  if (/^\d/.test(text)) {
    const label = orderedLabel(node.node, state) ?? text
    out.push({
      from: node.from, to: node.to, tag: "widget:ordered-mark",
      deco: Decoration.replace({ widget: new OrderedWidget(label) }),
    })
    return
  }
  out.push({
    from: node.from, to: node.to, tag: "replace:ListMark",
    deco: Decoration.replace({ widget: new BulletWidget() }),
  })
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
      if (node.node.parent?.name === "FencedCode")
        foldFenceMark(node, state, out, "CodeMark")
      break
    }
    case "CodeInfo": {
      if (node.node.parent?.name === "FencedCode")
        foldFenceMark(node, state, out, "CodeInfo")
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
