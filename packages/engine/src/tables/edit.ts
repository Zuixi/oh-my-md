import type { TableCellData, TableData, TableRowData } from "./model"

export interface TableSourceChange {
  readonly from: number
  readonly to: number
  readonly insert: string
}

/** Blank source slot inserted for new cells/rows so Lezer still sees a cell. */
const BLANK_CELL = "  "
/** Alignment marker padded like a piped separator row (` | --- |`). */
const MARKER_PIPED = " --- "
/** Pipeless alignment marker attached directly to the pipe (` |---`). */
const MARKER_NO_PIPE = "---"

export function escapeTableCellValue(value: string): string {
  let escaped = ""
  let backslashes = 0
  for (const char of value) {
    if (char === "\\") {
      escaped += char
      backslashes++
      continue
    }
    if (char === "|" && backslashes % 2 === 0) escaped += "\\"
    escaped += char
    backslashes = 0
  }
  return escaped
}

export function replaceTableCell(
  source: string,
  cell: TableCellData,
  value: string,
): TableSourceChange | null {
  const { from, to } = cell
  if (from < 0 || from > to || to > source.length) return null
  if (source.slice(from, to) !== cell.source) return null
  return { from, to, insert: escapeTableCellValue(value) }
}

function cellMatches(source: string, cell: TableCellData): boolean {
  return (
    cell.from >= 0
    && cell.from <= cell.to
    && cell.to <= source.length
    && source.slice(cell.from, cell.to) === cell.source
  )
}

/**
 * Validate every table-relative offset against the captured source before any
 * structural operator runs. `lineTo` must rest on a newline (or the document
 * end) because the changes own exactly one newline per row boundary; a row
 * whose line boundary drifted fails here and the operator returns `null`.
 *
 * `source` is the table substring itself (`Table` node text), so no absolute
 * base is needed: cell, line, and prefix slices all address `source` directly.
 */
function rowMatches(source: string, row: TableRowData): boolean {
  if (row.lineFrom < 0 || row.lineFrom > row.from || row.from > row.to || row.to > row.lineTo) return false
  if (row.lineTo > source.length) return false
  if (row.lineFrom !== row.from && source.slice(row.lineFrom, row.from) !== row.prefix) return false
  if (row.lineTo < source.length && source[row.lineTo] !== "\n") return false
  return row.cells.every(cell => cell === null || cellMatches(source, cell))
}

function tableMatches(source: string, table: TableData): boolean {
  if (table.header.cells.length === 0) return false
  if (table.delimiter.cells.length !== table.header.cells.length) return false
  if (!rowMatches(source, table.header)) return false
  if (!rowMatches(source, table.delimiter)) return false
  return table.rows.every(row => rowMatches(source, row))
}

export function insertTableRow(
  source: string,
  table: TableData,
  afterRow: number,
): readonly TableSourceChange[] | null {
  if (afterRow < 0 || afterRow > table.rows.length) return null
  if (!tableMatches(source, table)) return null

  const cols = table.header.cells.length
  const neighbor: TableRowData =
    table.rows.length > 0
      ? table.rows[Math.min(afterRow, table.rows.length - 1)]
      : table.delimiter
  const body = `${neighbor.leadingPipe ? "|" : ""}${Array.from({ length: cols }, () => BLANK_CELL).join("|")}${neighbor.trailingPipe ? "|" : ""}`
  const rowLine = `${neighbor.prefix}${body}`

  const hasFollowingRow = table.rows.length > 0 && afterRow < table.rows.length
  const insertAt = hasFollowingRow
    ? table.rows[afterRow].lineFrom
    : table.rows.length > 0
      ? table.rows[table.rows.length - 1].lineTo
      : table.delimiter.lineTo

  // 插在既有行之前时终止换行在新行之后；追加到表尾时换行在新行之前。
  // 都恰好引入一个换行符，表格不会与下一个块粘连。
  const insert = hasFollowingRow ? `${rowLine}\n` : `\n${rowLine}`
  return [{ from: insertAt, to: insertAt, insert }]
}

export function deleteTableRow(
  source: string,
  table: TableData,
  row: number,
): readonly TableSourceChange[] | null {
  if (row < 0 || row >= table.rows.length || table.rows.length <= 1) return null
  if (!tableMatches(source, table)) return null
  const target = table.rows[row]
  const lineFrom = target.lineFrom
  const lineTo = target.lineTo
  if (lineTo > source.length) return null
  // 拥有恰好一个换行：行内或表尾有换行则吞并它，否则吞并行首的前置换行，
  // 保证剩下的表与下一个块不粘连。
  const hasTrailingNewline = lineTo < source.length
  const from = hasTrailingNewline
    ? lineFrom
    : lineFrom > 0 && source[lineFrom - 1] === "\n"
      ? lineFrom - 1
      : lineFrom
  const to = hasTrailingNewline ? lineTo + 1 : lineTo
  return [{ from, to, insert: "" }]
}

export function insertTableColumn(
  source: string,
  table: TableData,
  afterColumn: number,
): readonly TableSourceChange[] | null {
  const cols = table.header.cells.length
  if (cols === 0 || afterColumn < 0 || afterColumn >= cols) return null
  if (!tableMatches(source, table)) return null

  const changes: TableSourceChange[] = []
  const insertAfter = (row: TableRowData, fill: string): boolean => {
    const cells = row.cells
    const present = cells.reduce((count, cell) => count + (cell === null ? 0 : 1), 0)
    if (present === 0) return false
    const anchorIndex = Math.min(afterColumn, present - 1)
    const anchor = cells[anchorIndex]
    if (!anchor) return false

    // 中间锚点：新单元格插进既有分隔符 ` | ` 中 —— 把该分隔符替换成
    // ` |<fill>| `，两侧各保留一个空格，新槽内容恰为 fill。
    if (anchorIndex < present - 1) {
      const next = cells[anchorIndex + 1]!
      changes.push({ from: anchor.to, to: next.from, insert: ` |${fill}| ` })
      return true
    }

    // 尾部锚点：行缺少插入列时先补齐到该列，再插入新槽；
    // 缺失槽的个数 = afterColumn + 1 - present，至少会插入一个新槽。
    const fillers = Math.max(0, afterColumn - present + 1)
    const slots = fillers + 1
    const pack = ` |${Array.from({ length: slots }, () => fill).join("|")}`
    if (row.trailingPipe) {
      // 有外层管道：吞掉锚点后的 ` |`，换成一个完整的新分隔符 + 槽 + 收尾管道。
      changes.push({ from: anchor.to, to: row.to, insert: `${pack}|` })
    } else {
      // 无外层管道：零宽插入 ` |<fill>…`，不新增收尾管道。
      changes.push({ from: anchor.to, to: anchor.to, insert: pack })
    }
    return true
  }

  if (!insertAfter(table.header, BLANK_CELL)) return null
  if (!insertAfter(table.delimiter, table.delimiter.trailingPipe ? MARKER_PIPED : MARKER_NO_PIPE)) return null
  for (const row of table.rows) if (!insertAfter(row, BLANK_CELL)) return null
  return changes.sort((a, b) => a.from - b.from)
}

export function deleteTableColumn(
  source: string,
  table: TableData,
  column: number,
): readonly TableSourceChange[] | null {
  const cols = table.header.cells.length
  if (cols <= 1 || column < 0 || column >= cols) return null
  if (!tableMatches(source, table)) return null

  const changes: TableSourceChange[] = []
  const dropFrom = (row: TableRowData) => {
    const cells = row.cells
    const present = cells.reduce((count, cell) => count + (cell === null ? 0 : 1), 0)
    if (column >= present) return // 缺失的 ragged 尾部：该行无需改动
    const last = present - 1
    if (column < last) {
      // 取右侧分隔符：单元格起点到下一单元格起点（含中间分隔符）
      const next = cells[column + 1]!
      changes.push({
        from: cells[column]!.from,
        to: next.from,
        insert: "",
      })
    } else if (column > 0) {
      // 最后一列取左侧分隔符：上一单元格结束到本单元格结束
      changes.push({
        from: cells[column - 1]!.to,
        to: cells[column]!.to,
        insert: "",
      })
    } else {
      // 单单元格行：只移除内容，保留外层管道
      changes.push({
        from: cells[0]!.from,
        to: cells[column]!.to,
        insert: "",
      })
    }
  }

  dropFrom(table.header)
  dropFrom(table.delimiter)
  for (const row of table.rows) dropFrom(row)
  return changes.sort((a, b) => a.from - b.from)
}
