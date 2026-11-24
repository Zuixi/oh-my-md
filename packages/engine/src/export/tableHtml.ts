/**
 * Table HTML projection shared by the sync and rich exporters: GFM cells
 * (parsed once by `parseCell`, the widget's own AST) and closed Complex Table
 * HTMLBlocks. Both walkers emit links/images through `primitives.ts`, so a
 * `javascript:` destination cannot slip past the top-level URL gate.
 */

import type { EditorState } from "@codemirror/state"
import type { SyntaxNode } from "@lezer/common"
import { parseCell, type CellNode } from "../parse/cell"
import {
  type ComplexTableCell,
  type ComplexTableInline,
  type ComplexTableModel,
} from "../parse/complexTable"
import { tableDataFromNode, type TableAlignment, type TableRowData } from "../tables/model"
import type { ExportContext } from "./exportDoc"
import { anchorHtml, escapeHtml, imageHtml, richImageSrc, type RichImageOptions } from "./primitives"
import { renderMathHtml } from "./richRenderers"


function cellChildrenHtml(children: CellNode[]): string {
  return children.map(cellNodeHtml).join("")
}

// Same parseCell AST the preview's renderTableCellContent consumes, so the export
// projection cannot drift from what the editor shows.
function cellNodeHtml(node: CellNode): string {
  switch (node.type) {
    case "text": return escapeHtml(node.text)
    case "code": return `<code>${escapeHtml(node.text)}</code>`
    // Known sync-export limitation: no KaTeX here, so cell math degrades to
    // <code>tex</code> without the `$` markers; the rich path renders KaTeX.
    case "math": return `<code>${escapeHtml(node.text)}</code>`
    case "em": return `<em>${cellChildrenHtml(node.children)}</em>`
    case "strong": return `<strong>${cellChildrenHtml(node.children)}</strong>`
    case "del": return `<del>${cellChildrenHtml(node.children)}</del>`
    case "mark": return `<mark>${cellChildrenHtml(node.children)}</mark>`
    case "underline": return `<u>${cellChildrenHtml(node.children)}</u>`
    case "kbd": return `<kbd>${cellChildrenHtml(node.children)}</kbd>`
    case "sub": return `<sub>${cellChildrenHtml(node.children)}</sub>`
    case "sup": return `<sup>${cellChildrenHtml(node.children)}</sup>`
    case "link": return anchorHtml(node.href, node.title, cellChildrenHtml(node.children))
    case "image": return imageHtml(node.src, node.alt, node.title)
    case "br": return "<br>"
    case "hr": return "<hr>"
    case "ul": return `<ul>${cellChildrenHtml(node.children)}</ul>`
    case "ol": return `<ol>${cellChildrenHtml(node.children)}</ol>`
    case "li": return `<li>${cellChildrenHtml(node.children)}</li>`
    case "blockquote": return `<blockquote>${cellChildrenHtml(node.children)}</blockquote>`
    case "pre": return `<pre><code>${escapeHtml(node.text)}</code></pre>`
  }
}

// The rich projection of the same CellNode tree: identical semantics, with two
// differences — cell math goes through the KaTeX renderer, and local images go
// through the rich resolveImageSrc policy.
function richCellNodeHtml(
  node: CellNode,
  opts: RichImageOptions,
): string | Promise<string> {
  switch (node.type) {
    case "text": return escapeHtml(node.text)
    case "code": return `<code>${escapeHtml(node.text)}</code>`
    case "math": return renderMathHtml(node.text, false)
    case "em": return richCellNodesHtml(node.children, opts).then(s => `<em>${s}</em>`)
    case "strong": return richCellNodesHtml(node.children, opts).then(s => `<strong>${s}</strong>`)
    case "del": return richCellNodesHtml(node.children, opts).then(s => `<del>${s}</del>`)
    case "mark": return richCellNodesHtml(node.children, opts).then(s => `<mark>${s}</mark>`)
    case "underline": return richCellNodesHtml(node.children, opts).then(s => `<u>${s}</u>`)
    case "kbd": return richCellNodesHtml(node.children, opts).then(s => `<kbd>${s}</kbd>`)
    case "sub": return richCellNodesHtml(node.children, opts).then(s => `<sub>${s}</sub>`)
    case "sup": return richCellNodesHtml(node.children, opts).then(s => `<sup>${s}</sup>`)
    case "link":
      return richCellNodesHtml(node.children, opts).then(s => anchorHtml(node.href, node.title, s))
    case "image": return richImageSrc(node.src, opts).then(src => imageHtml(src, node.alt, node.title))
    case "br": return "<br>"
    case "hr": return "<hr>"
    case "ul": return richCellNodesHtml(node.children, opts).then(s => `<ul>${s}</ul>`)
    case "ol": return richCellNodesHtml(node.children, opts).then(s => `<ol>${s}</ol>`)
    case "li": return richCellNodesHtml(node.children, opts).then(s => `<li>${s}</li>`)
    case "blockquote":
      return richCellNodesHtml(node.children, opts).then(s => `<blockquote>${s}</blockquote>`)
    case "pre": return `<pre><code>${escapeHtml(node.text)}</code></pre>`
  }
}

async function richCellNodesHtml(
  nodes: readonly CellNode[],
  opts: RichImageOptions,
): Promise<string> {
  let html = ""
  for (const node of nodes) html += await richCellNodeHtml(node, opts)
  return html
}

interface ExportTableGrid {
  readonly header: string[]
  readonly rows: string[][]
  readonly aligns: readonly TableAlignment[]
}

/**
 * Cell sources per row from the shared table model (`tables/model.ts`, the
 * one the table widget uses). Lezer emits no TableCell node for an empty slot
 * (`| 1 |  | 3 |`), so walking TableCell children dropped empty cells and
 * shifted the rest left. Rows are normalized to the delimiter-row column count
 * (GFM: short rows are padded, extra cells ignored).
 */
function tableGrid(node: SyntaxNode, state: EditorState): ExportTableGrid | null {
  const data = tableDataFromNode(node, state)
  if (!data) return null
  const width = data.delimiter.cells.length
  const sources = (row: TableRowData) => Array.from({ length: width }, (_, i) => row.cells[i]?.source.trim() ?? "")
  return { header: sources(data.header), rows: data.rows.map(sources), aligns: data.aligns }
}

function alignAttr(align: TableAlignment | undefined): string {
  return align ? ` align="${align}"` : ""
}

function cellNodes(source: string, ctx: ExportContext): CellNode[] {
  return parseCell(source, { pipeEscapes: "gfm-table", resolveReference: ctx.refs.resolveReference })
}

function cellSourceHtml(source: string, ctx: ExportContext): string {
  return cellChildrenHtml(cellNodes(source, ctx))
}

/** The GFM table, or null when the shared table model rejects the node. */
export function syncTableHtml(node: SyntaxNode, state: EditorState, ctx: ExportContext): string | null {
  const grid = tableGrid(node, state)
  if (!grid) return null
  const row = (cells: string[], tag: "th" | "td") =>
    `<tr>${cells.map((source, i) => `<${tag}${alignAttr(grid.aligns[i])}>${cellSourceHtml(source, ctx)}</${tag}>`).join("")}</tr>`
  return `<table><thead>${row(grid.header, "th")}</thead>${grid.rows.map(cells => row(cells, "td")).join("")}</table>`
}

/** The rich GFM table, or null when the shared table model rejects the node. */
export async function richTableHtml(
  node: SyntaxNode,
  state: EditorState,
  ctx: ExportContext,
  opts: RichImageOptions,
): Promise<string | null> {
  const grid = tableGrid(node, state)
  if (!grid) return null
  const row = async (cells: readonly string[], tag: "th" | "td"): Promise<string> => {
    let html = "<tr>"
    for (const [i, source] of cells.entries()) {
      html += `<${tag}${alignAttr(grid.aligns[i])}>${await richCellNodesHtml(cellNodes(source, ctx), opts)}</${tag}>`
    }
    return `${html}</tr>`
  }
  let html = `<table><thead>${await row(grid.header, "th")}</thead>`
  for (const cells of grid.rows) html += await row(cells, "td")
  return `${html}</table>`
}

function complexInlineHtml(
  node: ComplexTableInline,
  resolveSrc?: (src: string) => string,
): string {
  switch (node.type) {
    case "text": return escapeHtml(node.value)
    case "code": return `<code>${escapeHtml(node.value)}</code>`
    case "strong": return `<strong>${complexInlinesHtml(node.children, resolveSrc)}</strong>`
    case "emphasis": return `<em>${complexInlinesHtml(node.children, resolveSrc)}</em>`
    case "strike": return `<del>${complexInlinesHtml(node.children, resolveSrc)}</del>`
    case "highlight": return `<mark>${complexInlinesHtml(node.children, resolveSrc)}</mark>`
    case "underline": return `<u>${complexInlinesHtml(node.children, resolveSrc)}</u>`
    case "kbd": return `<kbd>${complexInlinesHtml(node.children, resolveSrc)}</kbd>`
    case "subscript": return `<sub>${complexInlinesHtml(node.children, resolveSrc)}</sub>`
    case "superscript": return `<sup>${complexInlinesHtml(node.children, resolveSrc)}</sup>`
    case "link":
      return anchorHtml(node.href, node.title, complexInlinesHtml(node.children, resolveSrc))
    case "image":
      return imageHtml(resolveSrc ? resolveSrc(node.src) : node.src, node.alt, node.title)
    case "break": return "<br>"
  }
}

function complexInlinesHtml(
  nodes: readonly ComplexTableInline[],
  resolveSrc?: (src: string) => string,
): string {
  return nodes.map(n => complexInlineHtml(n, resolveSrc)).join("")
}

function complexCellHtml(
  cell: ComplexTableCell,
  resolveSrc?: (src: string) => string,
): string {
  const tag = cell.header ? "th" : "td"
  let attrs = ""
  if (cell.rowSpan > 1) attrs += ` rowspan="${cell.rowSpan}"`
  if (cell.colSpan > 1) attrs += ` colspan="${cell.colSpan}"`
  if (cell.header && cell.scope) attrs += ` scope="${cell.scope}"`
  if (cell.align) attrs += ` align="${cell.align}"`
  return `<${tag}${attrs}>${complexInlinesHtml(cell.children, resolveSrc)}</${tag}>`
}

function renderComplexTableHtml(
  model: ComplexTableModel,
  resolveSrc?: (src: string) => string,
): string {
  const headRows: string[] = []
  const bodyRows: string[] = []
  let inHead = true
  for (const row of model.rows) {
    if (inHead && row.length > 0 && row.every(c => c.header)) {
      headRows.push(`<tr>${row.map(c => complexCellHtml(c, resolveSrc)).join("")}</tr>`)
    } else {
      inHead = false
      bodyRows.push(`<tr>${row.map(c => complexCellHtml(c, resolveSrc)).join("")}</tr>`)
    }
  }
  const thead = headRows.length > 0 ? `<thead>${headRows.join("")}</thead>` : ""
  const tbody = bodyRows.length > 0 ? `<tbody>${bodyRows.join("")}</tbody>` : ""
  return `<table>${thead}${tbody}</table>`
}

export function syncComplexTableHtml(model: ComplexTableModel): string {
  return renderComplexTableHtml(model)
}

// renderComplexTableHtml stays sync by design: collect every image src from the
// parsed model, await the (possibly async) host resolver, then hand the renderer
// a pure Map-backed lookup so it keeps its synchronous shape.
export async function richComplexTableHtml(
  model: ComplexTableModel,
  opts: RichImageOptions,
): Promise<string> {
  const srcs = collectComplexImageSrcs(model)
  const resolved = new Map<string, string>()
  await Promise.all(srcs.map(async (src) => {
    resolved.set(src, await richImageSrc(src, opts))
  }))
  return renderComplexTableHtml(model, src => resolved.get(src) ?? src)
}

function collectComplexImageSrcs(model: ComplexTableModel): string[] {
  const srcs: string[] = []
  for (const row of model.rows) for (const cell of row) collectInlineImageSrcs(cell.children, srcs)
  return srcs
}

function collectInlineImageSrcs(nodes: readonly ComplexTableInline[], out: string[]): void {
  for (const node of nodes) {
    if (node.type === "image") out.push(node.src)
    if ("children" in node) collectInlineImageSrcs(node.children, out)
  }
}
