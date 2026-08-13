import { EditorView } from "@codemirror/view"

export function typewriterExtension() {
  return EditorView.updateListener.of(update => {
    if (document.documentElement.dataset.typewriter !== "on") return
    if (!update.selectionSet && !update.docChanged) return
    const line = update.state.doc.lineAt(update.state.selection.main.head)
    update.view.dispatch({
      effects: EditorView.scrollIntoView(line.from, { y: "center" }),
    })
  })
}
