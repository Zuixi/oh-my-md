import { afterEach, describe, expect, it, vi } from "vitest"
import { EditorState } from "@codemirror/state"
import type { Extension, Transaction } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { typewriterExtension } from "../src/typewriter"

const views: EditorView[] = []
afterEach(() => {
  for (const view of views.splice(0)) view.destroy()
  delete document.documentElement.dataset.typewriter
})

function setTypewriter(value: "on" | "off" | null): void {
  if (value === null) delete document.documentElement.dataset.typewriter
  else document.documentElement.dataset.typewriter = value
}

/**
 * `EditorView.scrollIntoView` builds a `ScrollTarget` effect whose type is
 * module-private, so effects are recognized by that value shape rather than by
 * `effect.is(...)`.
 */
interface ScrollTarget { readonly range: { readonly from: number }; readonly y: string }

function scrollTargets(tr: Transaction): ScrollTarget[] {
  return tr.effects.flatMap(effect => {
    const value: unknown = effect.value
    if (typeof value !== "object" || value === null) return []
    if (!("range" in value) || !("y" in value)) return []
    return [value as ScrollTarget]
  })
}

function markupState(doc: string, head = 0, extra: Extension = []): EditorState {
  return EditorState.create({
    doc,
    selection: { anchor: head },
    extensions: [typewriterExtension(), extra],
  })
}

function mount(doc: string, extra: Extension = []): EditorView {
  const parent = document.body.appendChild(document.createElement("div"))
  const view = new EditorView({ state: markupState(doc, 0, extra), parent })
  views.push(view)
  return view
}

describe("typewriter mode", () => {
  it("centers the caret line inside the triggering transaction", () => {
    setTypewriter("on")
    const state = markupState("one\ntwo\nthree")

    const tr = state.update({
      changes: { from: 0, insert: "x\n" },
      selection: { anchor: 6 },
      userEvent: "input.type",
    })

    // The effect rides the original transaction — no follow-up dispatch is
    // needed, so nothing re-enters the view while the keypress is applied.
    const targets = scrollTargets(tr)
    expect(targets).toHaveLength(1)
    expect(targets[0].y).toBe("center")
    expect(targets[0].range.from).toBe(tr.state.doc.lineAt(6).from)
  })

  it("produces exactly one view update per keystroke", () => {
    setTypewriter("on")
    let updates = 0
    const view = mount("alpha\nbeta", EditorView.updateListener.of(() => { updates++ }))
    const dispatchSpy = vi.spyOn(view, "dispatch")

    view.dispatch({
      changes: { from: 0, insert: "z" },
      selection: { anchor: 1 },
      userEvent: "input.type",
    })

    // An update listener that dispatches the re-centering lands here as two
    // updates and two dispatches; the extender keeps it at one each.
    expect(updates).toBe(1)
    expect(dispatchSpy).toHaveBeenCalledTimes(1)
  })

  it("leaves pointer-driven selection scrolling to the browser", () => {
    setTypewriter("on")
    const state = markupState("one\ntwo\nthree")

    const tr = state.update({ selection: { anchor: 6 }, userEvent: "select.pointer" })

    // Re-centering on every drag transaction fights the drag: the viewport
    // would keep snapping back while the pointer moves away from the middle.
    expect(scrollTargets(tr)).toEqual([])
  })

  it("still centers on a keyboard selection", () => {
    setTypewriter("on")
    const tr = markupState("one\ntwo\nthree").update({
      selection: { anchor: 9 },
      userEvent: "select",
    })

    expect(scrollTargets(tr)).toHaveLength(1)
  })

  it("is inert when the mode is off or never set", () => {
    for (const value of ["off", null] as const) {
      setTypewriter(value)
      const tr = markupState("one\ntwo").update({
        changes: { from: 0, insert: "x" },
        selection: { anchor: 1 },
        userEvent: "input.type",
      })
      expect(scrollTargets(tr)).toEqual([])
    }
  })

  it("ignores transactions that neither edit nor move the caret", () => {
    setTypewriter("on")
    expect(scrollTargets(markupState("one\ntwo").update({ effects: [] }))).toEqual([])
  })
})
