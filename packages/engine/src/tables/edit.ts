type Line = { lead: boolean; trail: boolean; cells: string[] }

const ALIGN = /^:?-+:?$/
const EMPTY = "  "
const NEW_ALIGN = " --- "

function splitCells(line: string): string[] {
  const parts: string[] = []
  let cur = ""
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\" && line[i + 1] === "|") {
      cur += "\\|"
      i++
    } else if (line[i] === "|") {
      parts.push(cur)
      cur = ""
    } else {
      cur += line[i]
    }
  }
  parts.push(cur)
  return parts
}

function parseLine(line: string): Line {
  const parts = splitCells(line)
  const lead = parts.length > 0 && parts[0] === ""
  const trail = parts.length > 1 && parts[parts.length - 1] === ""
  const cells = parts.slice(lead ? 1 : 0, trail ? -1 : undefined)
  return { lead, trail, cells }
}

function joinLine(line: Line): string {
  const inner = line.cells.join("|")
  return `${line.lead ? "|" : ""}${inner}${line.trail ? "|" : ""}`
}

function isAlign(cell: string): boolean {
  const t = cell.trim()
  return t.includes("-") && ALIGN.test(t)
}

type Table = { header: Line; sep: Line; rows: Line[]; nl: boolean }

function parseTable(source: string): Table | null {
  const nl = source.endsWith("\n")
  const raw = source.split("\n")
  if (raw.length > 0 && raw[raw.length - 1] === "") raw.pop()
  if (raw.length < 2) return null
  const header = parseLine(raw[0])
  const sep = parseLine(raw[1])
  const rows = raw.slice(2).map(parseLine)
  const cols = header.cells.length
  if (cols === 0 || sep.cells.length !== cols || !sep.cells.every(isAlign)) return null
  if (rows.some(row => row.cells.length !== cols)) return null
  return { header, sep, rows, nl }
}

function dataLine(table: Table, row: number): Line | null {
  if (row === 0) return table.header
  return table.rows[row - 1] ?? null
}

function serialize(table: Table): string {
  const body = [table.header, table.sep, ...table.rows].map(joinLine).join("\n")
  return table.nl ? `${body}\n` : body
}

function padded(cell: string, value: string): string {
  const lead = cell.match(/^\s*/)?.[0] ?? ""
  const trail = cell.match(/\s*$/)?.[0] ?? ""
  if (cell.trim() === "" && lead.length + trail.length === cell.length)
    return value === "" ? (cell || EMPTY) : `${lead || " "}${value}${trail || " "}`
  return `${lead}${value}${trail}`
}

export function replaceTableCell(
  source: string,
  row: number,
  column: number,
  value: string,
): string | null {
  const table = parseTable(source)
  const line = table ? dataLine(table, row) : null
  if (!table || !line || column < 0 || column >= line.cells.length) return null
  line.cells[column] = padded(line.cells[column], value)
  return serialize(table)
}

export function insertTableRow(source: string, afterRow: number): string | null {
  const table = parseTable(source)
  if (!table || afterRow < 0 || afterRow > table.rows.length) return null
  const cols = table.header.cells.length
  const blank: Line = {
    lead: table.header.lead,
    trail: table.header.trail,
    cells: Array.from({ length: cols }, () => EMPTY),
  }
  table.rows.splice(afterRow, 0, blank)
  return serialize(table)
}

export function insertTableColumn(source: string, afterColumn: number): string | null {
  const table = parseTable(source)
  const cols = table?.header.cells.length ?? 0
  if (!table || afterColumn < 0 || afterColumn >= cols) return null
  const at = afterColumn + 1
  const add = (line: Line, cell: string) => {
    while (line.cells.length < at) line.cells.push(EMPTY)
    line.cells.splice(at, 0, cell)
  }
  add(table.header, EMPTY)
  add(table.sep, NEW_ALIGN)
  for (const row of table.rows) add(row, EMPTY)
  return serialize(table)
}

export function deleteTableRow(source: string, row: number): string | null {
  const table = parseTable(source)
  if (!table || row < 1 || row > table.rows.length || table.rows.length <= 1) return null
  table.rows.splice(row - 1, 1)
  return serialize(table)
}

export function deleteTableColumn(source: string, column: number): string | null {
  const table = parseTable(source)
  const cols = table?.header.cells.length ?? 0
  if (!table || column < 0 || column >= cols || cols <= 1) return null
  const drop = (line: Line) => {
    if (column < line.cells.length) line.cells.splice(column, 1)
  }
  drop(table.header)
  drop(table.sep)
  for (const row of table.rows) drop(row)
  return serialize(table)
}
