import type { SyntaxNode, SyntaxNodeRef } from "@lezer/common"
import type { EditorState } from "@codemirror/state"
import { Decoration } from "@codemirror/view"
import {
  cursorInside,
  lineDeco,
  REPLACE_MARK,
  styleLines,
  type DecoSpec,
} from "./types"
import { CheckboxWidget, BulletWidget, OrderedWidget, HrWidget, FrontMatterWidget } from "./widgets"
import { blockSelected, type BlockEmbed } from "./blockWidget"
import { foldFenceMark, styleCodeblockLines, styleFencedCode } from "./fencedCode"
import { TableWidget, tableDirectEditEnabled } from "./widgets/table"
import { createComplexTableWidget } from "./widgets/complexTable"
import { parseComplexTableBlock } from "../parse/complexTable"
import { tableDataFromNode } from "../tables/model"
import { isTableShownAsSource } from "../tables/sourceReveal"
import { imageResolver } from "./widgets/image"
import { MathBlockWidget } from "./widgets/math"
import { orderedLabel } from "../lists/ordered"
import { editorReferenceContext } from "../semantic/references"

const MAX_QUOTE_DEPTH = 4
// A complex table is one `<table>…</table>` envelope (`parseComplexTableBlock`), so a
// short prefix decides whether an HTML block can render as a table at all — the whole
// block (potentially hundreds of KiB) is only sliced once that gate passes.
const HTML_TABLE_PROBE_CHARS = 64
const HTML_TABLE_PROBE_RE = /^\s*<table[\s>]/i

const BULLET_WIDGET = new BulletWidget()

// Folds a line-leading syntax mark ('[^id]:') plus its trailing space unless the
// caret is inside the mark itself — same span granularity as the inline reveal
// (cursorInside), not line-based: editing the definition content keeps the label
// folded; clicking into the label reveals it for editing.
function foldLineMark(node: SyntaxNodeRef, state: EditorState, out: DecoSpec[], name: string) {
  const line = state.doc.lineAt(node.from)
  const end = Math.min(node.to + 1, line.to)
  if (!cursorInside(state, node.from, end))
    out.push({ from: node.from, to: end, tag: `replace:${name}`, deco: REPLACE_MARK })
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
        from: line.from, to: node.from, tag: "replace:QuoteIndent", deco: REPLACE_MARK,
      })
    }
  }
  const end = quoteMarkEnd(node, state)
  if (cursorInside(state, node.from, end)) return
  out.push({
    from: node.from, to: end, tag: "replace:QuoteMark", deco: REPLACE_MARK,
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
    listDepth: listDepth(node),
    quoteInList: quoteInsideList(node),
  }
}

// 列表行深度用**一个**稳定类 + 行内 `--omd-list-depth` 表达（视觉换算在 desktop
// CSS）。tag 保留真实深度：增量装饰身份必须随深度变化，否则缩进变化时旧行装饰
// 会被复用。
function listDepthLine(cssClass: string, depth: number): Decoration {
  return Decoration.line({ class: cssClass, attributes: { style: `--omd-list-depth: ${depth}` } })
}

// Explicit source-mode table: keep editable Markdown source with monospace line
// styling and header/delimiter markers so pipes stay vertically aligned without
// folding inline markers inside cells.
function styleTableSource(
  node: { from: number; to: number },
  state: EditorState,
  out: DecoSpec[],
): void {
  const first = state.doc.lineAt(node.from)
  const last = state.doc.lineAt(node.to).number
  styleLines(state, out, first.from, node.to, "line:omd-table-src", "omd-table-src")
  out.push({
    from: first.from, to: first.from, tag: "line:omd-table-src-head", deco: lineDeco("omd-table-src-head"),
  })
  if (first.number < last) {
    const delim = state.doc.line(first.number + 1)
    out.push({
      from: delim.from, to: delim.from, tag: "line:omd-table-src-delim", deco: lineDeco("omd-table-src-delim"),
    })
  }
}

function styleBlockquote(node: SyntaxNodeRef, state: EditorState, out: DecoSpec[]) {
  const depth = Math.min(Math.max(quoteDepth(node.node), 1), MAX_QUOTE_DEPTH)
  const itemDepth = listDepth(node.node)
  for (let pos = node.from; pos <= node.to; ) {
    const line = state.doc.lineAt(pos)
    if (!childQuoteCoversLine(node.node, line.from, line.to)) {
      out.push({
        from: line.from, to: line.from,
        tag: `line:omd-blockquote-${depth}`,
        deco: lineDeco(`omd-blockquote omd-blockquote-${depth}`),
      })
      if (itemDepth > 0) {
        out.push({
          from: line.from, to: line.from,
          tag: `line:omd-quote-in-li-${itemDepth}`,
          deco: listDepthLine("omd-quote-in-li", itemDepth),
        })
      }
    }
    pos = line.to + 1
  }
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

function styleListMark(
  node: SyntaxNodeRef,
  state: EditorState,
  out: DecoSpec[],
  labelFor?: (mark: SyntaxNode) => string | null,
) {
  const line = state.doc.lineAt(node.from)
  const depth = listDepth(node.node)
  out.push({
    from: line.from, to: line.from, tag: `line:omd-li-${depth}`,
    deco: listDepthLine("omd-li", depth),
  })

  // 路线 A：列表符与缩进无条件折叠 —— 点击列表文本只定位光标，不闪源码；
  // 列表增删走 toggleOrderedList / toggleUnorderedList 命令。
  const indentFrom = listIndentStart(line.from, node.from, state)
  if (indentFrom < node.from) {
    out.push({
      from: indentFrom, to: node.from, tag: "replace:ListIndent", deco: REPLACE_MARK,
    })
  }
  if (node.node.parent?.getChild("Task")) {
    out.push({
      from: node.from,
      to: node.to,
      tag: "replace:ListMark",
      deco: REPLACE_MARK,
    })
    return
  }

  const text = state.doc.sliceString(node.from, node.to)
  if (/^\d/.test(text)) {
    const label = labelFor ? labelFor(node.node) ?? text : orderedLabel(node.node, state) ?? text
    out.push({
      from: node.from, to: node.to, tag: "widget:ordered-mark",
      deco: Decoration.replace({ widget: new OrderedWidget(label) }),
    })
    return
  }
  out.push({
    from: node.from, to: node.to, tag: "replace:ListMark",
    deco: Decoration.replace({ widget: BULLET_WIDGET }),
  })
}

export function blockRules(
  node: SyntaxNodeRef,
  state: EditorState,
  out: DecoSpec[],
  labelFor?: (mark: SyntaxNode) => string | null,
): boolean {
  switch (node.name) {
    case "ListMark": { styleListMark(node, state, out, labelFor); break }
    case "FencedCode": return styleFencedCode(node, state, out, blockEmbed(node.node))
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
      // 光标停在表内仍保持渲染。只有字段记下的那张表，且选区落在其上时才卸成源码行。
      // 源码态必须跳过子树：否则 inlineRules 会在单元格里折叠 `**` 并加粗。
      if (isTableShownAsSource(state, node.from, node.to)) {
        styleTableSource(node, state, out)
        return true
      }
      const table = tableDataFromNode(node.node, state)
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
            state.facet(tableDirectEditEnabled),
            // 表格 cell 的引用式链接/图片定义在表格外：一份当前 state 的引用上下文。
            editorReferenceContext(state).resolveReference,
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
      styleLines(state, out, node.from, node.to, "line:omd-footnote-def", "omd-footnote-def")
      break
    }
    case "HorizontalRule":
      if (blockSelected(state, node.from, node.to)) {
        out.push({ from: node.from, to: node.from, tag: "line:omd-hr", deco: lineDeco("omd-hr") })
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
        styleLines(state, out, node.from, Math.max(node.from, node.to - 1), "line:omd-front-matter", "omd-front-matter-src")
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
    case "HTMLBlock": {
      // Only a single-`<table>` envelope can render as a complex table, so the short
      // prefix gate keeps non-table HTML blocks from being sliced whole.
      const prefix = state.doc.sliceString(node.from, Math.min(node.to, node.from + HTML_TABLE_PROBE_CHARS))
      if (!HTML_TABLE_PROBE_RE.test(prefix)) return false
      // Selected: keep the source editable, but never build (or discard) a widget for it.
      if (blockSelected(state, node.from, node.to)) {
        if (!parseComplexTableBlock(state.doc.sliceString(node.from, node.to))) return false
        styleLines(state, out, node.from, node.to, "line:omd-table-src", "omd-table-src")
        return true
      }
      const widget = createComplexTableWidget(
        state.doc.sliceString(node.from, node.to),
        node.from,
        blockEmbed(node.node),
        state.facet(imageResolver),
      )
      if (!widget) return false
      out.push({
        from: node.from,
        to: node.to,
        tag: "widget:block:complex-table",
        deco: Decoration.replace({
          widget,
          block: true,
        }),
      })
      return true
    }
  }
  return false
}
