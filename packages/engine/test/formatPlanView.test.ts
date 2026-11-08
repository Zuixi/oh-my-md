import { forceParsing } from "@codemirror/language"
import { EditorState } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { describe, expect, it } from "vitest"
import { editorExtensions } from "../src/index"

function mount(doc: string, anchor: number) {
  const parent = document.createElement("div")
  document.body.appendChild(parent)
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor },
      extensions: editorExtensions(),
    }),
    parent,
  })
  forceParsing(view, view.state.doc.length, 10_000)
  return {
    view,
    cleanup: () => {
      view.destroy()
      parent.remove()
    },
  }
}

function pressBold(view: EditorView): void {
  view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", {
    key: "b",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  }))
}

describe("large-document formatting plans", () => {
  it("keeps repeated Ctrl+B reversible inside one huge soft-wrapped paragraph", () => {
    const doc = Array.from(
      { length: 1_000 },
      (_, index) => `format line ${index}`,
    ).join("\n")
    const { view, cleanup } = mount(doc, doc.indexOf("999") + 2)
    try {
      pressBold(view)
      expect(view.state.doc.toString()).toContain("**999**")

      pressBold(view)
      expect(view.state.doc.toString()).toBe(doc)

      pressBold(view)
      expect(view.state.doc.toString()).toContain("**999**")
    } finally {
      cleanup()
    }
  })
})
