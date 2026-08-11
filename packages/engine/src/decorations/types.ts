import type { EditorState } from "@codemirror/state"
import type { Decoration } from "@codemirror/view"

export interface DecoSpec { from: number; to: number; tag: string; deco: Decoration }

// Returns true when the cursor is on the same line as the syntax mark [from, to].
// Typora model: fold marks on any line the cursor is NOT on.
// Line-based check avoids all off-by-one issues with character boundaries
// (e.g. cursor at position 0 is legitimately "on" the heading line even though
// it also happens to be the start of the `# ` mark range).
export function nearCursor(state: EditorState, from: number, to: number) {
  const cursorPos = state.selection.main.head
  const cursorLine = state.doc.lineAt(cursorPos)
  // The mark is on the same line as the cursor if their ranges overlap.
  return cursorLine.from <= to && cursorLine.to >= from
}
