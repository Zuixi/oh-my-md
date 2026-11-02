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

/**
 * 光标所在的 Table 节点。
 *
 * `side = 1`（向前看）会跳过任何 `to <= pos` 的节点，所以在表尾边界（`pos === Table.to`，
 * 末行 End / Cmd+→ 可达）它直接越过整张表、返回 null —— 而装饰层刻意把两个边界都算作
 * "在表内"（blockWidget.ts::blockSelected）。边界上退回 `side = -1`（向后看）再试一次，
 * 让查询层与装饰层对"在表内"的判定一致。
 */
function tableNodeAt(state: EditorState, pos: number): SyntaxNode | null {
  const tree = syntaxTree(state)
  const walk = (side: -1 | 1) => {
    let node: SyntaxNode | null = tree.resolveInner(pos, side)
    while (node && node.name !== "Table") node = node.parent
    return node
  }
  return walk(1) ?? (pos > 0 ? walk(-1) : null)
}

/**
 * 便宜的"表格在哪"查询：只走到 `Table` 节点取起点，**不构建 `TableData`**。
 * 浮层工具栏每次 ViewUpdate 都要判断"光标是否还在表内"，而它只需要那个起点；
 * 走 `tableAt` 会为每个单元格做一次 sliceString —— 大表上是逐键 O(单元格数)。
 */
export function tableStartAt(state: EditorState, pos: number): number | null {
  const probe = Math.min(Math.max(pos, 0), state.doc.length)
  if (!syntaxTreeAvailable(state, Math.min(probe + 1, state.doc.length))) return null
  return tableNodeAt(state, probe)?.from ?? null
}

/** 只读查询：树未覆盖 pos 时返回 null（绝不推进解析）。 */
export function tableAt(state: EditorState, pos: number): TableContext | null {
  const probe = Math.min(Math.max(pos, 0), state.doc.length)
  if (!syntaxTreeAvailable(state, Math.min(probe + 1, state.doc.length))) return null
  const node = tableNodeAt(state, probe)
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
