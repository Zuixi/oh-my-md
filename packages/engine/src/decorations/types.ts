import type { EditorState } from "@codemirror/state"
import type { Decoration } from "@codemirror/view"

export interface DecoSpec { from: number; to: number; tag: string; deco: Decoration }

// Typora model: folds are visual; only the caret reveals source. A non-empty
// selection (drag, Shift+arrows, Cmd+A) never expands marks — that both keeps
// the preview stable during drags and stops reveal-flicker from relayouting
// lines mid-selection (which used to push pointer-selection endpoints across
// newlines; see the atomicRanges Rule 3 entry in known-gotchas).
// Line-based check avoids all off-by-one issues with character boundaries
// (e.g. cursor at position 0 is legitimately "on" the heading line even though
// it also happens to be the start of the `# ` mark range).
export function nearCursor(state: EditorState, from: number, to: number) {
  const sel = state.selection.main
  if (!sel.empty) return false
  const cursorLine = state.doc.lineAt(sel.head)
  // The mark is on the same line as the cursor if their ranges overlap.
  return cursorLine.from <= to && cursorLine.to >= from
}

// Collapsed caret within [from, to) — start-boundary inclusive: typing the
// closing fence/mark leaves the caret exactly at `to`, which is "past" the
// mark (content side). Use this for quote markers and other marks that stay
// folded while editing the line. Non-caret selections return false: visual
// selection never reveals syntax.
export function cursorInside(state: EditorState, from: number, to: number): boolean {
  const { from: sf, to: st } = state.selection.main
  return sf === st && sf >= from && sf < to
}
