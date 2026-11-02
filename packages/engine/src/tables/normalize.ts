import { escapeTableCellValue, tableSourceMatches } from "./edit"
import type { TableAlignment, TableData, TableRowData } from "./model"

export interface NormalizedTableEdit {
  readonly source: string
  readonly activeCell: { readonly from: number; readonly to: number }
}

const DELIMITER_CELL: Record<TableAlignment, string> = {
  left: ":---",
  right: "---:",
  center: ":---:",
  "": "---",
}

/**
 * Normalization reserializes every row from scratch, so it needs a shape the
 * range operators tolerate but the serializer cannot: exactly one non-null cell
 * per column on every row. `tableSourceMatches` already checks the ranges.
 */
function completeShape(table: TableData, columns: number): boolean {
  if (table.aligns.length !== columns) return false
  const rows: readonly TableRowData[] = [table.header, table.delimiter, ...table.rows]
  return rows.every(row => row.cells.length === columns && row.cells.every(cell => cell !== null))
}

function lineSeparator(source: string): string {
  const newline = source.indexOf("\n")
  return newline > 0 && source[newline - 1] === "\r" ? "\r\n" : "\n"
}

export function normalizeTableForFirstEdit(
  source: string,
  table: TableData,
  row: number,
  column: number,
  value: string,
): NormalizedTableEdit | null {
  if (!tableSourceMatches(source, table)) return null
  const columns = table.header.cells.length
  if (!completeShape(table, columns)) return null
  if (column < 0 || column >= columns) return null
  if (row < 0 || row > table.rows.length) return null
  const targetRow = row === 0 ? table.header : table.rows[row - 1]

  const allRows = [table.header, table.delimiter, ...table.rows]
  const separator = lineSeparator(source)
  const activeContent = escapeTableCellValue(value)
  let text = ""
  let activeCell: NormalizedTableEdit["activeCell"] | null = null

  for (const [index, current] of allRows.entries()) {
    const isActiveRow = current === targetRow
    const isDelimiterRow = current === table.delimiter
    text += current.prefix
    for (let col = 0; col < columns; col++) {
      const isActive = isActiveRow && col === column
      const content =
        isDelimiterRow ? DELIMITER_CELL[table.aligns[col]]
        : isActive ? activeContent
        : (current.cells[col]?.source ?? "").trim()
      if (isActive) {
        const from = text.length + "| ".length
        activeCell = { from, to: from + content.length }
      }
      text += `| ${content} `
    }
    text += "|"
    if (index < allRows.length - 1) text += separator
  }

  if (!activeCell) return null
  return { source: text, activeCell }
}
