import { StateEffect, StateField, type EditorState, type Transaction } from "@codemirror/state"
import { blockSelected } from "../decorations/blockSelection"
import { tableNodeAt } from "./navigate"

/**
 * 被展开成源码的那一张表。`null` 表示没有表处于源码态。
 * 范围记在字段值里：`revealTableSource` 本身不带位置，位置由同一事务的选区头决定。
 */
interface RevealedTable {
  readonly from: number
  readonly to: number
}

export const revealTableSource = StateEffect.define<null>()

export const tableSourceRevealed: StateField<RevealedTable | null> = StateField.define<RevealedTable | null>({
  create() {
    return null
  },
  update(value, tr) {
    if (tr.effects.some(effect => effect.is(revealTableSource))) {
      return revealedTableAtHead(tr.state)
    }
    if (!value) return null
    const mapped = mapRevealedTable(value, tr)
    if (!mapped) return null
    const selection = tr.newSelection.main
    if (!selectionIntersects(selection.from, selection.to, mapped)) return null
    if (mapped.from === value.from && mapped.to === value.to) return value
    return mapped
  },
})

export function isTableSourceRevealed(state: EditorState): boolean {
  return state.field(tableSourceRevealed, false) != null
}

/** 只有字段记下的那一张表可以进入源码行。范围按节点起止比较。 */
export function isRevealedTableRange(state: EditorState, from: number, to: number): boolean {
  const range = state.field(tableSourceRevealed, false)
  return range != null && range.from === from && range.to === to
}

/**
 * True while the table at `from..to` is projected as Markdown source in Live Preview: it is
 * the revealed table and the selection still reaches into it (partly selected, or anchored
 * inside). A selection that covers the whole table from outside renders the widget again even
 * though the reveal is kept. `blocks.ts` (source lines vs `TableWidget`) and the floating
 * source toolbar both decide with this, so the toolbar never floats over a mounted widget.
 * Global Source mode has no widget; callers check it before asking.
 */
export function isTableShownAsSource(state: EditorState, from: number, to: number): boolean {
  if (!isRevealedTableRange(state, from, to)) return false
  const { anchor } = state.selection.main
  return blockSelected(state, from, to) || (anchor >= from && anchor <= to)
}

function revealedTableAtHead(state: EditorState): RevealedTable | null {
  const head = state.selection.main.head
  const node = tableNodeAt(state, head)
  if (!node || head < node.from || head > node.to) return null
  return { from: node.from, to: node.to }
}

function mapRevealedTable(range: RevealedTable, tr: Transaction): RevealedTable | null {
  if (!tr.docChanged) return range
  const from = tr.changes.mapPos(range.from, -1)
  const to = tr.changes.mapPos(range.to, 1)
  return from <= to ? { from, to } : null
}

function selectionIntersects(from: number, to: number, range: RevealedTable): boolean {
  return from <= range.to && to >= range.from
}
