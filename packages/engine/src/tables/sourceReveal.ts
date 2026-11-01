import { syntaxTree } from "@codemirror/language"
import { StateEffect, StateField, type EditorState, type Transaction } from "@codemirror/state"
import type { SyntaxNode } from "@lezer/common"

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

function revealedTableAtHead(state: EditorState): RevealedTable | null {
  const head = state.selection.main.head
  const node = tableNodeAt(state, head)
  if (!node || head < node.from || head > node.to) return null
  return { from: node.from, to: node.to }
}

function tableNodeAt(state: EditorState, pos: number): SyntaxNode | null {
  const tree = syntaxTree(state)
  const walk = (side: -1 | 1): SyntaxNode | null => {
    let node: SyntaxNode | null = tree.resolveInner(pos, side)
    while (node && node.name !== "Table") node = node.parent
    return node
  }
  return walk(1) ?? (pos > 0 ? walk(-1) : null)
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
