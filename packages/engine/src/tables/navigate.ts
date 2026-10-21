import type { EditorState } from "@codemirror/state"
import { syntaxTree, syntaxTreeAvailable } from "@codemirror/language"
import type { SyntaxNode } from "@lezer/common"
import { tableDataFromNode, type TableData } from "./model"

export interface TableContext {
  readonly from: number
  readonly to: number
  readonly source: string
  readonly data: TableData
}

export interface CellSlot {
  readonly row: number
  readonly col: number
  readonly from: number
  readonly to: number
}

/** 只读查询：树未覆盖 pos 时返回 null（绝不推进解析）。 */
export function tableAt(state: EditorState, pos: number): TableContext | null {
  const probe = Math.min(Math.max(pos, 0), state.doc.length)
  if (!syntaxTreeAvailable(state, Math.min(probe + 1, state.doc.length))) return null
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(probe, 1)
  while (node && node.name !== "Table") node = node.parent
  if (!node) return null
  const data = tableDataFromNode(node, state)
  if (!data) return null
  return { from: node.from, to: node.to, source: state.doc.sliceString(node.from, node.to), data }
}

function slotsOf(table: TableContext): CellSlot[] {
  const out: CellSlot[] = []
  const rows = [table.data.header, ...table.data.rows]
  for (let row = 0; row < rows.length; row++) {
    const cells = rows[row].cells
    for (let col = 0; col < cells.length; col++) {
      const cell = cells[col]
      if (!cell) continue
      out.push({ row, col, from: table.from + cell.from, to: table.from + cell.to })
    }
  }
  return out
}

function distance(slot: CellSlot, pos: number): number {
  if (pos < slot.from) return slot.from - pos
  if (pos > slot.to) return pos - slot.to
  return 0
}

/**
 * 光标所在（或最近）的单元格。源码里落在管道 / 分隔行上时按距离归最近的格，
 * 等距时取左侧（单元格先于其右侧管道出现）。空表或树未覆盖时返回 null。
 */
export function cellAt(state: EditorState, pos: number): { table: TableContext; slot: CellSlot } | null {
  const table = tableAt(state, pos)
  if (!table) return null
  const slots = slotsOf(table)
  for (const slot of slots) {
    if (pos >= slot.from && pos <= slot.to) return { table, slot }
  }
  let best: CellSlot | null = null
  let bestDistance = Infinity
  for (const slot of slots) {
    const d = distance(slot, pos)
    if (d < bestDistance || (d === bestDistance && best !== null && slot.from < best.from)) {
      best = slot
      bestDistance = d
    }
  }
  return best ? { table, slot: best } : null
}

export function nextCell(state: EditorState, pos: number, step: 1 | -1): CellSlot | null {
  const hit = cellAt(state, pos)
  if (!hit) return null
  const slots = slotsOf(hit.table)
  const index = slots.findIndex(s => s.row === hit.slot.row && s.col === hit.slot.col)
  return slots[index + step] ?? null
}

/** 同列上下移动；越界返回 null（由命令层决定是否加行）。 */
export function cellBelow(state: EditorState, pos: number, dir: 1 | -1): CellSlot | null {
  const hit = cellAt(state, pos)
  if (!hit) return null
  return slotsOf(hit.table).find(s => s.row === hit.slot.row + dir && s.col === hit.slot.col) ?? null
}
