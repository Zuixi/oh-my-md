import { describe, expect, it } from "vitest"
import { EditorView } from "@codemirror/view"
import { EditorState } from "@codemirror/state"
import { makeState } from "./helpers"
import { editorExtensions } from "../src/index"
import { applyToggle } from "../src/modes/livePreview"
import { orderedRenumberChanges } from "../src/lists/ordered"

function apply(doc: string) {
  const state = makeState(doc)
  const changes = orderedRenumberChanges(state)
  return state.update({ changes }).state.doc.toString()
}

describe("orderedRenumberChanges", () => {
  it("rewrites skipped numbers to a consecutive sequence from the first item", () => {
    expect(apply("1. 第一项\n3. 第二项\n7. 第三项")).toBe("1. 第一项\n2. 第二项\n3. 第三项")
  })

  it("keeps the first item's number as the start", () => {
    expect(apply("3. a\n7. b")).toBe("3. a\n4. b")
  })

  it("returns no changes when numbers are already consecutive", () => {
    const doc = "1. a\n2. b\n3. c"
    expect(orderedRenumberChanges(makeState(doc))).toEqual([])
  })

  it("renumbers nested ordered lists independently", () => {
    const doc = "1. outer\n   1. inner a\n   3. inner b\n2. second"
    expect(apply(doc)).toBe("1. outer\n   1. inner a\n   2. inner b\n2. second")
  })

  it("does not rewrite unordered lists", () => {
    const doc = "- a\n- b\n1. x\n3. y"
    expect(apply(doc)).toBe("- a\n- b\n1. x\n2. y")
  })

  it("preserves parenthesis delimiters", () => {
    expect(apply("1) a\n3) b")).toBe("1) a\n2) b")
  })
})

describe("ordered list source rewrite in the editor", () => {
  function makeView(doc: string) {
    const parent = document.createElement("div")
    document.body.appendChild(parent)
    const errors: unknown[] = []
    const view = new EditorView({
      state: EditorState.create({
        doc,
        selection: { anchor: doc.length },
        extensions: [editorExtensions(), EditorView.exceptionSink.of(e => { errors.push(e) })],
      }),
      parent,
    })
    return { view, errors }
  }

  const tick = () => new Promise(r => setTimeout(r, 100))

  it("writes consecutive numbers back into the document in live preview", async () => {
    const { view, errors } = makeView("1. 第一项\n3. 第二项\n7. 第三项\n\ntail")
    await tick()
    expect(errors.map(String)).toEqual([])
    expect(view.state.doc.toString()).toBe("1. 第一项\n2. 第二项\n3. 第三项\n\ntail")
    view.destroy()
  })

  it("shows the rewritten source when the cursor enters a list line", async () => {
    const { view, errors } = makeView("1. 第一项\n3. 第二项\n7. 第三项")
    await tick()
    const line2 = view.state.doc.line(2)
    view.dispatch({ selection: { anchor: line2.from } })
    await tick()
    expect(errors.map(String)).toEqual([])
    expect(view.state.doc.line(2).text.startsWith("2.")).toBe(true)
    expect(view.dom.textContent).toContain("2. 第二项")
    view.destroy()
  })

  it("does not rewrite source while in source mode", async () => {
    const { view, errors } = makeView("1. a\n3. b")
    view.dispatch(applyToggle(view.state))
    await tick()
    expect(errors.map(String)).toEqual([])
    expect(view.state.doc.toString()).toBe("1. a\n3. b")
    view.destroy()
  })
})
