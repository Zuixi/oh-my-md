import type { EditorState } from "@codemirror/state"
import type { SyntaxNode } from "@lezer/common"

export type TableAlignment = "left" | "center" | "right" | ""

export interface TableCellData {
  readonly text: string
  readonly source: string
  readonly from: number
  readonly to: number
}

export interface TableRowData {
  readonly from: number
  readonly to: number
  readonly lineFrom: number
  readonly lineTo: number
  readonly prefix: string
  readonly leadingPipe: boolean
  readonly trailingPipe: boolean
  readonly cells: readonly (TableCellData | null)[]
}

export interface TableData {
  readonly header: TableRowData
  readonly delimiter: TableRowData
  readonly rows: readonly TableRowData[]
  readonly aligns: readonly TableAlignment[]
}

function directChildren(node: SyntaxNode, name: string): SyntaxNode[] {
  const children: SyntaxNode[] = []
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === name) children.push(child)
  }
  return children
}

function cellData(node: SyntaxNode, tableFrom: number, state: EditorState): TableCellData {
  const source = state.doc.sliceString(node.from, node.to)
  return {
    source,
    text: source.replace(/\\\|/g, "|").trim(),
    from: node.from - tableFrom,
    to: node.to - tableFrom,
  }
}

function rowEnvelope(
  row: SyntaxNode,
  table: SyntaxNode,
  cells: readonly (TableCellData | null)[],
  leadingPipe: boolean,
  trailingPipe: boolean,
  state: EditorState,
): TableRowData {
  const line = state.doc.lineAt(row.from)
  const lineFrom = Math.max(table.from, line.from)
  const lineTo = Math.min(table.to, line.to)
  return {
    from: row.from - table.from,
    to: row.to - table.from,
    lineFrom: lineFrom - table.from,
    lineTo: lineTo - table.from,
    prefix: state.doc.sliceString(lineFrom, row.from),
    leadingPipe,
    trailingPipe,
    cells,
  }
}

function sourceRow(row: SyntaxNode, table: SyntaxNode, state: EditorState): TableRowData {
  const cellNodes = directChildren(row, "TableCell")
  const pipes = directChildren(row, "TableDelimiter")
  const leadingPipe = pipes.length > 0 && pipes[0].from < (cellNodes[0]?.from ?? row.to)
  const trailingPipe = pipes.length > 0 && pipes[pipes.length - 1].to >= (cellNodes[cellNodes.length - 1]?.to ?? row.from)
  const boundaries = [row.from, ...pipes.map(pipe => pipe.to), row.to]
  const segmentEnds = [...pipes.map(pipe => pipe.from), row.to]
  const first = leadingPipe ? 1 : 0
  const last = segmentEnds.length - (trailingPipe ? 1 : 0)
  const cells: TableCellData[] = []

  for (let index = first; index < last; index++) {
    const from = boundaries[index]
    const to = segmentEnds[index]
    const node = cellNodes.find(cell => cell.from >= from && cell.to <= to)
    if (node) {
      cells.push(cellData(node, table.from, state))
      continue
    }
    const source = state.doc.sliceString(from, to)
    const leading = source.match(/^\s*/)?.[0].length ?? 0
    const trailing = source.match(/\s*$/)?.[0].length ?? 0
    const pos = from + Math.min(leading, source.length - trailing)
    cells.push({ source: "", text: "", from: pos - table.from, to: pos - table.from })
  }

  return rowEnvelope(row, table, cells, leadingPipe, trailingPipe, state)
}

function delimiterRow(row: SyntaxNode, table: SyntaxNode, state: EditorState): TableRowData {
  const source = state.doc.sliceString(row.from, row.to)
  const leadingPipe = /^\s*\|/.test(source)
  const trailingPipe = /\|\s*$/.test(source)
  const cells: TableCellData[] = []
  const marker = /:?-{3,}:?/g
  for (let match = marker.exec(source); match; match = marker.exec(source)) {
    const from = row.from + match.index
    cells.push({ source: match[0], text: match[0], from: from - table.from, to: from + match[0].length - table.from })
  }
  return rowEnvelope(row, table, cells, leadingPipe, trailingPipe, state)
}

export function tableDataFromNode(node: SyntaxNode, state: EditorState): TableData | null {
  const headerNode = directChildren(node, "TableHeader")[0]
  const delimiterNode = directChildren(node, "TableDelimiter")[0]
  if (!headerNode || !delimiterNode) return null

  const header = sourceRow(headerNode, node, state)
  if (header.cells.length === 0) return null
  const delimiter = delimiterRow(delimiterNode, node, state)
  const rows = directChildren(node, "TableRow").map(row => {
    const data = sourceRow(row, node, state)
    const cells = [...data.cells]
    while (cells.length < header.cells.length) cells.push(null)
    return { ...data, cells }
  })
  const aligns = delimiter.cells.map<TableAlignment>(cell => {
    if (!cell) return ""
    if (cell.source.startsWith(":") && cell.source.endsWith(":")) return "center"
    if (cell.source.endsWith(":")) return "right"
    if (cell.source.startsWith(":")) return "left"
    return ""
  })
  return { header, delimiter, rows, aligns }
}
