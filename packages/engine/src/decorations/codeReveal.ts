import { StateField, type EditorState } from "@codemirror/state"
import { syntaxTree, syntaxTreeAvailable } from "@codemirror/language"
import type { SyntaxNode } from "@lezer/common"
import { blockSelected } from "./blockSelection"

export interface CodeEditingRange {
  readonly from: number
  readonly to: number
}

function fencedCodeAt(state: EditorState, pos: number): CodeEditingRange | null {
  if (!syntaxTreeAvailable(state, Math.min(pos + 1, state.doc.length))) return null
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1)
  while (node && node.name !== "FencedCode") node = node.parent
  if (!node || pos < node.from || pos > node.to) return null
  return { from: node.from, to: node.to }
}

/**
 * Tracks whether a fenced code block is currently in source-editing mode.
 *
 * Entering a code block with a collapsed caret (click, ArrowUp/Down, goto-line) reveals
 * its numbered source lines and keeps that block revealed even if the user later drags
 * a non-empty selection inside the revealed source. Conversely, dragging directly over a
 * rendered `CodeWidget` (or dragging into it from outside) jumps straight to a non-empty
 * selection without ever placing a collapsed caret inside, so the widget stays mounted
 * and paints its selection overlay instead of flipping to source.
 */
export const codeEditingField = StateField.define<CodeEditingRange | null>({
  create(state) {
    const sel = state.selection.main
    return sel.empty ? fencedCodeAt(state, sel.head) : null
  },
  update(prev, tr) {
    const mapped = prev
      ? { from: tr.changes.mapPos(prev.from, 1), to: tr.changes.mapPos(prev.to, -1) }
      : null
    const sel = tr.state.selection.main
    if (sel.empty) {
      if (mapped && sel.head >= mapped.from && sel.head <= mapped.to) {
        return fencedCodeAt(tr.state, sel.head) ?? mapped
      }
      return fencedCodeAt(tr.state, sel.head)
    }
    if (mapped && blockSelected(tr.state, mapped.from, mapped.to)) {
      return mapped
    }
    return null
  },
})

/**
 * True when a syntax-highlighted fenced code block should project as numbered editing
 * source lines rather than a rendered `CodeWidget`.
 */
export function isCodeShownAsSource(state: EditorState, from: number, to: number): boolean {
  if (!blockSelected(state, from, to)) return false
  if (state.selection.main.empty) return true
  const editing = state.field(codeEditingField, false)
  if (!editing) return false
  return editing.from <= to && editing.to >= from
}
