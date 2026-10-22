import { describe, expect, it } from "vitest"
import { EditorState, type TransactionSpec } from "@codemirror/state"
import {
  exitTableSpec, tableNextCellSpec, tableNextRowSpec, tablePrevCellSpec,
} from "../src/format/tableKeymap"
import { markdownLanguageSupport } from "../src/parse/markdown"
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

describe("exitTableSpec keeps an existing blank line idempotent", () => {
  it("only moves the caret when the table is already followed by a blank line", () => {
    const state = stateAt("a")
    const spec = exitTableSpec(state)!
    expect(spec.changes).toBeUndefined()
    const next = state.update(spec).state
    expect(next.doc.toString()).toBe(DOC)
    expect(next.doc.lineAt(next.selection.main.head).text).toBe("")
  })

  it("still opens a blank line when the table ends the document", () => {
    const tail = "| A | B |\n| --- | --- |\n| a | b |"
    const state = makeState(tail).update({ selection: { anchor: tail.indexOf("a |") } }).state
    const next = state.update(exitTableSpec(state)!).state
    expect(next.doc.toString()).toBe(`${tail}\n\n`)
    expect(next.doc.lineAt(next.selection.main.head).text).toBe("")
  })
})

describe("unresolved syntax tree inside a table row", () => {
  // 大文档刚打开/刚滚到未解析区时语法树还没覆盖光标：查不到 Table 节点。此时 Tab
  // 若穿透到 defaultKeymap 的 indentMore，会把空白写进表格行首并破坏表结构。
  function tailState(lastLine: string) {
    const filler = Array.from({ length: 400 }, (_, i) => `paragraph ${i} with some words`).join("\n\n")
    const doc = `${filler}\n\n${lastLine}`
    return { doc, state: EditorState.create({ doc, extensions: [markdownLanguageSupport()] }) }
  }

  it("swallows Tab on a table row instead of falling through to indentation", () => {
    const { doc, state } = tailState("| A | B |\n| --- | --- |\n| a | b |")
    const pos = doc.indexOf("| a | b |") + 2
    const withCaret = state.update({ selection: { anchor: pos } }).state
    const spec = tableNextCellSpec(withCaret)!
    expect(spec).toBeTruthy()
    expect(spec.changes).toBeUndefined()
    expect(withCaret.update(spec).state.doc.toString()).toBe(doc)
  })

  it("swallows Shift-Tab on the same row", () => {
    const { doc, state } = tailState("| A | B |\n| --- | --- |\n| a | b |")
    const pos = doc.indexOf("| a | b |") + 2
    const withCaret = state.update({ selection: { anchor: pos } }).state
    expect(tablePrevCellSpec(withCaret)?.changes).toBeUndefined()
  })

  it("does not swallow Tab on an ordinary paragraph in the same unparsed region", () => {
    const { doc, state } = tailState("an ordinary trailing paragraph")
    const pos = doc.indexOf("an ordinary") + 2
    const withCaret = state.update({ selection: { anchor: pos } }).state
    expect(tableNextCellSpec(withCaret)).toBeNull()
  })
})
