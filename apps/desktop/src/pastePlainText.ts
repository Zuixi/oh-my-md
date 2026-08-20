import { EditorView } from "@codemirror/view"

/**
 * Inserts the clipboard's plain text at the current selection, replacing it.
 * Reads `navigator.clipboard.readText()`; no-ops when the Clipboard API is
 * unavailable or the clipboard holds no text (so a normal paste still works).
 */
export async function pastePlainText(view: EditorView): Promise<void> {
  const read = navigator.clipboard?.readText()
  if (!read) return
  const text = await read
  if (!text) return
  const selection = view.state.selection.main
  view.dispatch({
    changes: { from: selection.from, to: selection.to, insert: text },
    // Set the caret explicitly: without a selection CM maps the old cursor
    // with assoc -1 and it stays before the pasted text instead of after it.
    selection: { anchor: selection.from + text.length },
    userEvent: "input.paste",
    scrollIntoView: true,
  })
}
