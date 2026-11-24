import type { EditorState } from "@codemirror/state"

/**
 * A block is editable when the selection overlaps its closed range without
 * covering the whole block from outside. Leaf module: `blockWidget.ts`,
 * `sourceReveal.ts`, and the block dispatchers must agree on this predicate,
 * and importing it from `blockWidget.ts` pulls the widget/build cycle in.
 */
export function blockSelected(state: EditorState, from: number, to: number): boolean {
  const { from: sf, to: st } = state.selection.main
  return sf <= to && st >= from && !(sf <= from && st >= to)
}
