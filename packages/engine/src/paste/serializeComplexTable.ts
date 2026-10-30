import {
  MAX_COMPLEX_TABLE_COLS,
  MAX_COMPLEX_TABLE_ROWS,
  MAX_COMPLEX_TABLE_SPAN,
  parseComplexTableBlock,
} from "../parse/complexTable"
import type {
  PasteBlock,
  PasteDiagnostic,
  PasteInline,
  PasteTable,
  PasteTableCell,
  PasteTableRow,
  SerializedPaste,
} from "./model"
import type { SerializePasteOptions } from "./serialize"
import { escapePasteText } from "./triggerPolicy"

interface LoweringState {
  readonly resolveAsset: (key: string) => string | null
  unresolved: number
}

/**
 * Lowers a `PasteTable` into canonical Type 6 HTML (`<table>\n...\n</table>`)
 * without blank physical lines.
 *
 * Callers may first probe `canSerializeComplexTable(table)` or validate the
 * lowered output through `parseComplexTableBlock`.
 */
export function serializeComplexTable(
  table: PasteTable,
  options: SerializePasteOptions,
): SerializedPaste {
  const state: LoweringState = {
    resolveAsset: options.resolveAsset,
    unresolved: 0,
  }
  const rows = table.rows.filter(row => row.cells.length > 0)
  const { headRows, bodyRows } = splitHeaderAndBodyRows(rows)
  const lines: string[] = ["<table>"]
  if (headRows.length > 0) {
    lines.push("<thead>")
    for (const row of headRows) lines.push(...serializeRow(row, state))
    lines.push("</thead>")
  }
  if (bodyRows.length > 0) {
    lines.push("<tbody>")
    for (const row of bodyRows) lines.push(...serializeRow(row, state))
    lines.push("</tbody>")
  }
  lines.push("</table>")

  const diagnostics: PasteDiagnostic[] = state.unresolved > 0
    ? [{ kind: "unresolvedAsset", count: state.unresolved }]
    : []

  return {
    text: lines.join("\n"),
    boundary: { start: "block", end: "htmlBlock" },
    diagnostics,
  }
}

export function canSerializeComplexTable(table: PasteTable): boolean {
  const rows = table.rows.filter(row => row.cells.length > 0)
  if (rows.length === 0 || rows.length > MAX_COMPLEX_TABLE_ROWS) return false

  const rowCount = rows.length
  const occupied: boolean[][] = Array.from({ length: rowCount }, () => [])
  let maxCols = 0

  for (let r = 0; r < rowCount; r++) {
    let c = 0
    for (const cell of rows[r].cells) {
      if (
        !Number.isInteger(cell.rowSpan) ||
        !Number.isInteger(cell.colSpan) ||
        cell.rowSpan < 1 ||
        cell.colSpan < 1 ||
        cell.rowSpan > MAX_COMPLEX_TABLE_SPAN ||
        cell.colSpan > MAX_COMPLEX_TABLE_SPAN
      ) {
        return false
      }
      while (occupied[r][c]) c++
      if (r + cell.rowSpan > rowCount) return false
      if (c + cell.colSpan > MAX_COMPLEX_TABLE_COLS) return false
      for (let dr = 0; dr < cell.rowSpan; dr++) {
        for (let dc = 0; dc < cell.colSpan; dc++) {
          if (occupied[r + dr][c + dc]) return false
          occupied[r + dr][c + dc] = true
        }
      }
      c += cell.colSpan
      if (c > maxCols) maxCols = c
    }
  }
  if (maxCols === 0 || maxCols > MAX_COMPLEX_TABLE_COLS) return false

  const probe = serializeComplexTable(table, { mode: "minimal", resolveAsset: () => null })
  return parseComplexTableBlock(probe.text) !== null
}

function splitHeaderAndBodyRows(rows: readonly PasteTableRow[]): {
  readonly headRows: readonly PasteTableRow[]
  readonly bodyRows: readonly PasteTableRow[]
} {
  let headCount = 0
  let requiredHeadEnd = 0
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const allHeader = row.cells.length > 0 && row.cells.every(cell => cell.header && cell.scope !== "row")
    if (!allHeader) break
    const rowEnd = Math.max(...row.cells.map(cell => i + cell.rowSpan))
    requiredHeadEnd = Math.max(requiredHeadEnd, rowEnd)
    headCount = i + 1
  }
  if (requiredHeadEnd > headCount) {
    return { headRows: [], bodyRows: rows }
  }
  return {
    headRows: rows.slice(0, headCount),
    bodyRows: rows.slice(headCount),
  }
}

function serializeRow(row: PasteTableRow, state: LoweringState): string[] {
  const lines: string[] = ["<tr>"]
  for (const cell of row.cells) {
    lines.push(serializeCell(cell, state))
  }
  lines.push("</tr>")
  return lines
}

function serializeCell(cell: PasteTableCell, state: LoweringState): string {
  const tag = cell.header ? "th" : "td"
  let attrs = ""
  if (cell.header && (cell.scope === "row" || cell.scope === "col")) {
    attrs += ` scope="${cell.scope}"`
  }
  if (cell.rowSpan > 1) attrs += ` rowspan="${cell.rowSpan}"`
  if (cell.colSpan > 1) attrs += ` colspan="${cell.colSpan}"`
  if (cell.align === "left" || cell.align === "center" || cell.align === "right") {
    attrs += ` align="${cell.align}"`
  }
  const content = serializeCellBlocks(cell.blocks, state)
  return `<${tag}${attrs}>${content}</${tag}>`
}

function serializeCellBlocks(blocks: readonly PasteBlock[], state: LoweringState): string {
  const parts: string[] = []
  for (const block of blocks) {
    const html = serializeCellBlock(block, state)
    if (html !== "") parts.push(html)
  }
  return parts.join("<br>")
}

function serializeCellBlock(block: PasteBlock, state: LoweringState): string {
  switch (block.type) {
    case "paragraph":
    case "heading":
      return serializeInlines(block.children, state)
    case "blockquote":
      return serializeCellBlocks(block.children, state)
    case "list": {
      const items: string[] = []
      for (const item of block.items) {
        const text = serializeCellBlocks(item.children, state)
        if (text !== "") items.push(text)
      }
      return items.join("<br>")
    }
    case "codeBlock": {
      const lines = block.value.replace(/\r\n|\r/g, "\n").split("\n")
      return lines.map(line => `<code>${escapeHtmlText(line)}</code>`).join("<br>")
    }
    case "table": {
      const rows: string[] = []
      for (const row of block.table.rows) {
        const cells = row.cells
          .map(cell => serializeCellBlocks(cell.blocks, state))
          .filter(text => text !== "")
        if (cells.length > 0) rows.push(cells.join(" "))
      }
      return rows.join("<br>")
    }
    case "horizontalRule":
      return ""
  }
}

const WRAPPER_TAG: Readonly<Record<string, string>> = {
  strong: "strong",
  emphasis: "em",
  strike: "del",
  underline: "u",
  highlight: "mark",
  kbd: "kbd",
  subscript: "sub",
  superscript: "sup",
}

function serializeInlines(nodes: readonly PasteInline[], state: LoweringState): string {
  let out = ""
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        out += escapeHtmlText(node.value)
        break
      case "hardBreak":
        out += "<br>"
        break
      case "code":
        out += `<code>${escapeHtmlText(node.value.replace(/\r\n|\r|\n/g, " "))}</code>`
        break
      case "link": {
        const href = escapeAttr(node.href)
        const title = node.title === null ? "" : ` title="${escapeAttr(node.title)}"`
        const inner = serializeInlines(node.children, state)
        out += `<a href="${href}"${title}>${inner || escapeHtmlText(node.href)}</a>`
        break
      }
      case "image":
        out += serializeImage(node, state)
        break
      default: {
        const tag = WRAPPER_TAG[node.type]
        const inner = serializeInlines(node.children, state)
        if (tag && inner !== "") out += `<${tag}>${inner}</${tag}>`
        break
      }
    }
  }
  return out
}

function serializeImage(
  node: Extract<PasteInline, { readonly type: "image" }>,
  state: LoweringState,
): string {
  const src = resolveImageSrc(node, state)
  if (src === null) {
    state.unresolved++
    return node.alt === "" ? "" : escapeHtmlText(node.alt)
  }
  const title = node.title === null ? "" : ` title="${escapeAttr(node.title)}"`
  return `<img src="${escapeAttr(src)}" alt="${escapeAttr(node.alt)}"${title}>`
}

function resolveImageSrc(
  node: Extract<PasteInline, { readonly type: "image" }>,
  state: LoweringState,
): string | null {
  if (node.source.kind === "url") return node.source.value
  if (node.source.kind === "unavailable") return null
  const resolved = state.resolveAsset(node.source.key)
  return resolved === null || resolved === "" ? null : resolved
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/\r\n|\r|\n/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

function escapeAttr(value: string): string {
  return escapePasteText(value, "htmlAttribute", "strict")
}
