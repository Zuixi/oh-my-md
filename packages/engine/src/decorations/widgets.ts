import { EditorView, WidgetType } from "@codemirror/view"

export class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean, readonly pos: number) { super() }
  eq(other: CheckboxWidget) { return this.checked === other.checked }
  toDOM() {
    const el = document.createElement("input")
    el.type = "checkbox"
    el.checked = this.checked
    el.className = "omd-checkbox"
    // prevent the editor from losing focus / moving the cursor on click
    el.addEventListener("mousedown", e => e.preventDefault())
    el.addEventListener("click", e => {
      e.preventDefault()
      const view = EditorView.findFromDOM(el.parentElement!)
      if (!view) return
      const from = this.pos, to = from + 3   // "[ ]" / "[x]" — TaskMarker is 3 chars
      const insert = this.checked ? "[ ]" : "[x]"
      view.dispatch({ changes: { from, to, insert } })
    })
    return el
  }
  ignoreEvent() { return false }
}
