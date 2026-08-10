import type { EditorState } from "@codemirror/state"
import type { Decoration } from "@codemirror/view"

export interface DecoSpec { from: number; to: number; tag: string; deco: Decoration }

// A syntax marker the cursor is currently inside should NOT be hidden
// (otherwise the cursor can't enter it and IME composition jitters).
export function nearCursor(state: EditorState, from: number, to: number) {
  const { from: sf, to: st } = state.selection.main
  return from < st && to > sf
}
