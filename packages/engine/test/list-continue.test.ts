import { EditorState } from "@codemirror/state"
import { describe, expect, it } from "vitest"
import { continueListSpec, indentListSpec, outdentListSpec } from "../src/format/lists"

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
