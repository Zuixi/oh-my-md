import { Prec, type EditorState, type TransactionSpec } from "@codemirror/state"
import { keymap, type Command } from "@codemirror/view"
import { cellAt, cellBelow, nextCell, tableAt, type CellSlot } from "../tables/navigate"
import { insertTableRow } from "../tables/edit"

function dispatchSpec(spec: (state: EditorState) => TransactionSpec | null): Command {
  return target => {
    if (target.state.readOnly) return false
    const result = spec(target.state)
    if (!result) return false
    target.dispatch(result)
    return true
  }
}

const caret = (pos: number) => ({ selection: { anchor: pos } })

/** 单元格内容起点：跳过源码前导空格（TableCell 节点可能含首空格）。 */
function contentStart(state: EditorState, slot: CellSlot): number {
  const text = state.doc.sliceString(slot.from, slot.to)
  return slot.from + (text.length - text.trimStart().length)
}

/** 在表尾追加一行，光标落到新行首格。返回 null 表示模型已失效。 */
function appendRowSpec(state: EditorState, pos: number): TransactionSpec | null {
  const table = tableAt(state, pos)
  if (!table) return null
  const change = insertTableRow(table.source, table.data, table.data.rows.length)?.[0]
  if (!change) return null
  // insert 形如 "\n<rowLine>"：rowLine = prefix + 可选 "|" + 两空格一组的单元格
  const neighbor = table.data.rows[table.data.rows.length - 1] ?? table.data.delimiter
  const rowLine = change.insert.replace(/^\n/, "")
  const prefixLength = neighbor.prefix.length
  const leading = rowLine.slice(prefixLength).startsWith("|") ? 1 : 0
  const rowStart = table.from + change.from + (change.insert.startsWith("\n") ? 1 : 0)
  const caretInRow = rowStart + prefixLength + leading + 1
  return {
    changes: { from: table.from + change.from, to: table.from + change.to, insert: change.insert },
    selection: { anchor: caretInRow },
  }
}

export function tableNextCellSpec(state: EditorState): TransactionSpec | null {
  const pos = state.selection.main.head
  const next = nextCell(state, pos, 1)
  if (next) return caret(contentStart(state, next))
  if (!cellAt(state, pos)) return null
  return appendRowSpec(state, pos)
}

export function tablePrevCellSpec(state: EditorState): TransactionSpec | null {
  const pos = state.selection.main.head
  const prev = nextCell(state, pos, -1)
  return prev ? caret(contentStart(state, prev)) : null
}

export function tableNextRowSpec(state: EditorState): TransactionSpec | null {
  const pos = state.selection.main.head
  const below = cellBelow(state, pos, 1)
  if (below) return caret(contentStart(state, below))
  return cellAt(state, pos) ? appendRowSpec(state, pos) : null
}

export function tablePrevRowSpec(state: EditorState): TransactionSpec | null {
  const pos = state.selection.main.head
  const above = cellBelow(state, pos, -1)
  return above ? caret(contentStart(state, above)) : null
}

export function exitTableSpec(state: EditorState): TransactionSpec | null {
  const table = tableAt(state, state.selection.main.head)
  if (!table) return null
  const at = state.doc.length === table.to ? table.to : table.to + 1
  const insert = at >= state.doc.length ? "\n\n" : "\n"
  return {
    changes: { from: at, to: at, insert },
    selection: { anchor: at + insert.length },
  }
}

// Prec.highest 且注册在 codeLine/fence/quote/list 之前：同优先级下先注册者胜。
export const tableKeymap = Prec.highest(keymap.of([
  { key: "Tab", run: dispatchSpec(tableNextCellSpec) },
  { key: "Shift-Tab", run: dispatchSpec(tablePrevCellSpec) },
  { key: "Enter", run: dispatchSpec(tableNextRowSpec) },
  { key: "Shift-Enter", run: dispatchSpec(tablePrevRowSpec) },
  { key: "Mod-Enter", run: dispatchSpec(exitTableSpec) },
]))
