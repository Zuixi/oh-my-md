import { describe, expect, it } from "vitest"
import {
  tableNextCellSpec, tableNextRowSpec, tablePrevCellSpec,
} from "../src/format/tableKeymap"
import { makeState } from "./helpers"

const DOC = ["| A | B |", "| --- | --- |", "| a | b |", "", "after"].join("\n")

function stateAt(needle: string) {
  const base = makeState(DOC)
  return base.update({ selection: { anchor: DOC.indexOf(needle) } }).state
}

describe("tableNextCellSpec", () => {
  it("moves the caret to the next cell without touching the document", () => {
    const state = stateAt("A")
    const spec = tableNextCellSpec(state)!
    expect(spec.changes).toBeUndefined()
    const next = state.update(spec).state
    expect(next.doc.toString()).toBe(DOC)
    expect(next.selection.main.head).toBe(DOC.indexOf("B"))
  })

  it("appends a row when Tab is pressed in the last cell", () => {
    const state = stateAt("b")
    const next = state.update(tableNextCellSpec(state)!).state
    expect(next.doc.lines).toBe(DOC.split("\n").length + 1)
    const caretLine = next.doc.lineAt(next.selection.main.head)
    expect(caretLine.number).toBe(4)     // 原第 4 行是空行，新行插在表尾
    expect(caretLine.text.startsWith("|")).toBe(true)
  })

  it("returns null outside a table", () => {
    expect(tableNextCellSpec(stateAt("after"))).toBeNull()
  })
})

describe("tablePrevCellSpec", () => {
  it("moves backward", () => {
    const state = stateAt("B")
    const applied = state.update(tablePrevCellSpec(state)!).state
    expect(applied.selection.main.head).toBe(DOC.indexOf("A"))
  })

  it("returns null in the first cell (falls through)", () => {
    expect(tablePrevCellSpec(stateAt("A"))).toBeNull()
  })
})

describe("tableNextRowSpec", () => {
  it("moves to the same column in the next row", () => {
    const state = stateAt("A")
    const next = state.update(tableNextRowSpec(state)!).state
    expect(next.selection.main.head).toBe(DOC.indexOf("a"))
  })

  it("appends a row when pressed in the last row", () => {
    const state = stateAt("a")
    const next = state.update(tableNextRowSpec(state)!).state
    expect(next.doc.lines).toBe(DOC.split("\n").length + 1)
  })
})
