import { defaultKeymap, historyKeymap } from "@codemirror/commands"
import { EditorState, type Extension } from "@codemirror/state"
import { EditorView, keymap } from "@codemirror/view"
import { describe, expect, it } from "vitest"
import { editorExtensions } from "../src/index"
import { continueListSpec, indentListSpec, listKeymap, outdentListSpec } from "../src/format/lists"

function state(doc: string, head: number) {
  return EditorState.create({ doc, selection: { anchor: head } })
}

describe("continueListSpec", () => {
  it("continues an unordered item", () => {
    const s = state("- hello", 7)
    const spec = continueListSpec(s)
    expect(spec?.changes).toEqual({ from: 7, to: 7, insert: "\n- " })
  })
  it("exits an empty unordered item", () => {
    const s = state("- hello\n- ", 10)
    const spec = continueListSpec(s)
    expect(spec).toBeTruthy()
    const next = s.update(spec!)
    expect(next.state.doc.toString()).toBe("- hello\n")
  })
  it("keeps the quote when exiting an empty quoted item", () => {
    const s = state("> - ", 4)
    const next = s.update(continueListSpec(s)!)
    expect(next.state.doc.toString()).toBe("> ")
  })
  it("keeps the quote when exiting a following empty quoted item", () => {
    const s = state("> - hello\n> - ", 14)
    const next = s.update(continueListSpec(s)!)
    expect(next.state.doc.toString()).toBe("> - hello\n> ")
  })
  it("continues an ordered item with next number", () => {
    const s = state("1. a\n2. b", 9)
    const spec = continueListSpec(s)
    expect(spec).toBeTruthy()
    const next = s.update(spec!)
    expect(next.state.doc.toString()).toBe("1. a\n2. b\n3. ")
  })
  it("continues a task item with empty checkbox", () => {
    const s = state("- [x] done", 10)
    const next = s.update(continueListSpec(s)!)
    expect(next.state.doc.toString()).toBe("- [x] done\n- [ ] ")
  })
  it("returns null outside lists", () => {
    expect(continueListSpec(state("hello", 5))).toBeNull()
  })
  it("continues a list inside one quote", () => {
    const s = state("> - hello", 9)
    const next = s.update(continueListSpec(s)!)
    expect(next.state.doc.toString()).toBe("> - hello\n> - ")
  })
  it("continues a nested quote list", () => {
    const s = state("> > - hello", 11)
    const next = s.update(continueListSpec(s)!)
    expect(next.state.doc.toString()).toBe("> > - hello\n> > - ")
  })
})

describe("indentListSpec", () => {
  it("indents two spaces", () => {
    const s = state("- a", 3)
    const next = s.update(indentListSpec(s)!)
    expect(next.state.doc.toString()).toBe("  - a")
  })
  it("outdents two spaces", () => {
    const s = state("  - a", 5)
    const next = s.update(outdentListSpec(s)!)
    expect(next.state.doc.toString()).toBe("- a")
  })
})

function pressEnter(view: EditorView) {
  view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Enter",
    code: "Enter",
    bubbles: true,
    cancelable: true,
  }))
}

function viewWith(extensions: Extension[]) {
  const parent = document.createElement("div")
  document.body.appendChild(parent)
  return new EditorView({
    state: EditorState.create({
      doc: "- hello",
      selection: { anchor: 7 },
      extensions,
    }),
    parent,
  })
}

describe("listKeymap vs defaultKeymap", () => {
  const hostKeys = keymap.of([...defaultKeymap, ...historyKeymap])

  it("continues a list on Enter when defaultKeymap is registered first", () => {
    const view = viewWith([hostKeys, editorExtensions()])
    pressEnter(view)
    expect(view.state.doc.toString()).toBe("- hello\n- ")
    view.destroy()
  })

  it("continues a list on Enter when only listKeymap follows defaultKeymap", () => {
    const view = viewWith([hostKeys, listKeymap])
    pressEnter(view)
    expect(view.state.doc.toString()).toBe("- hello\n- ")
    view.destroy()
  })
})
