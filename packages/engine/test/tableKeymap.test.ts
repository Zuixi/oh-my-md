import { describe, expect, it } from "vitest"
import type { EditorState, TransactionSpec } from "@codemirror/state"
import {
  exitTableSpec, tableNextCellSpec, tableNextRowSpec, tablePrevCellSpec,
} from "../src/format/tableKeymap"
import { makeState } from "./helpers"

const DOC = ["| A | B |", "| --- | --- |", "| a | b |", "", "after"].join("\n")

function stateAt(needle: string) {
  const base = makeState(DOC)
  return base.update({ selection: { anchor: DOC.indexOf(needle) } }).state
}

function applyAt(pos: number, spec: (state: EditorState) => TransactionSpec | null) {
  const state = makeState(DOC).update({ selection: { anchor: pos } }).state
  const change = spec(state)
  return change ? state.update(change).state : null
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

describe("exitTableSpec", () => {
  it("inserts a blank paragraph after the table and moves the caret there", () => {
    const state = stateAt("a")
    const next = state.update(exitTableSpec(state)!).state
    expect(next.doc.toString()).toContain("| a | b |\n\n")
    expect(next.doc.lineAt(next.selection.main.head).text).toBe("")
  })

  it("returns null outside a table", () => {
    expect(exitTableSpec(stateAt("after"))).toBeNull()
  })
})

describe("caret on the table end boundary", () => {
  // 末行末格的 End / Cmd+→ 会把光标停在 Table.to 上（最后一行的行尾）。装饰层把两个
  // 边界都算作在表内，所以查询层与键位必须与"边界前一字符"完全一致。
  const BOUNDARY = DOC.indexOf("| a | b |") + "| a | b |".length

  it("Tab does what it does one character earlier (appends a row)", () => {
    const fromBoundary = applyAt(BOUNDARY, tableNextCellSpec)
    const oneBefore = applyAt(BOUNDARY - 1, tableNextCellSpec)
    expect(oneBefore).not.toBeNull()
    expect(fromBoundary).not.toBeNull()
    expect(fromBoundary!.doc.toString()).toBe(oneBefore!.doc.toString())
    expect(fromBoundary!.selection.main.head).toBe(oneBefore!.selection.main.head)
    expect(fromBoundary!.doc.lines).toBe(DOC.split("\n").length + 1)
  })

  it("Enter does what it does one character earlier (appends a row)", () => {
    const fromBoundary = applyAt(BOUNDARY, tableNextRowSpec)
    const oneBefore = applyAt(BOUNDARY - 1, tableNextRowSpec)
    expect(oneBefore).not.toBeNull()
    expect(fromBoundary).not.toBeNull()
    expect(fromBoundary!.doc.toString()).toBe(oneBefore!.doc.toString())
    expect(fromBoundary!.selection.main.head).toBe(oneBefore!.selection.main.head)
  })
})
