import { EditorState } from "@codemirror/state"
import { EditorView } from "@codemirror/view"

/**
 * Typewriter mode: keep the caret's line vertically centered.
 *
 * Implemented as a `transactionExtender` rather than an `updateListener` that
 * dispatches. Extenders fold their effects into the *original* transaction, so
 * one keystroke stays one update — a listener-driven dispatch produces a
 * second transaction per keystroke and re-enters the update machinery.
 *
 * Pointer drags (`select.pointer`) are skipped on purpose: the browser scrolls
 * the viewport itself while dragging a selection, and forcing a re-center on
 * every pointer-move transaction fights that drag and makes the selection
 * crawl away from the cursor.
 */
export function typewriterExtension() {
  return EditorState.transactionExtender.of(tr => {
    if (typeof document === "undefined" || document.documentElement.dataset.typewriter !== "on") {
      return null
    }
    if (!tr.selection && !tr.docChanged) return null
    if (tr.isUserEvent("select.pointer")) return null
    const line = tr.state.doc.lineAt(tr.newSelection.main.head)
    return { effects: EditorView.scrollIntoView(line.from, { y: "center" }) }
  })
}
