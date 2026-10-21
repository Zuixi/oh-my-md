import { describe, expect, it } from "vitest"
import { EditorState } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { forceParsing, syntaxTree } from "@codemirror/language"
import { markdownLanguageSupport } from "../src/parse/markdown"
import { tableDataFromNode } from "../src/tables/model"
import { applyTableTool, tableSourceToolbar } from "../src/tables/sourceToolbar"
import { tableToolChanges } from "../src/tables/tools"
import { makeState } from "./helpers"

const DOC = ["| A | B |", "| --- | --- |", "| a | b |"].join("\n")

function model(doc = DOC) {
  const state = makeState(doc)
  const node = syntaxTree(state).topNode.firstChild!
  return { source: doc, table: tableDataFromNode(node, state)! }
}

describe("tableToolChanges", () => {
  it("inserts a row below the given row", () => {
    const { source, table } = model()
    const changes = tableToolChanges("insert-row", source, table, 1, 0)!
    expect(changes).toHaveLength(1)
    expect(changes[0].insert).toContain("|  |")
  })

  it("inserts a row right after the header", () => {
    const { source, table } = model()
    const changes = tableToolChanges("insert-row", source, table, 0, 0)!
    // 表头之后插入 = 首数据行之前：零宽插入落在首数据行行首。
    expect(changes).toHaveLength(1)
    expect(changes[0].from).toBe(source.indexOf("| a | b |"))
  })

  it("refuses to delete the last remaining data row", () => {
    const { source, table } = model()
    expect(tableToolChanges("delete-row", source, table, 1, 0)).toBeNull()
  })

  it("refuses to delete the header row", () => {
    const { source, table } = model()
    expect(tableToolChanges("delete-row", source, table, 0, 0)).toBeNull()
  })

  it("deletes a data row when another one remains", () => {
    const doc = ["| A | B |", "| --- | --- |", "| a | b |", "| c | d |"].join("\n")
    const { source, table } = model(doc)
    const changes = tableToolChanges("delete-row", source, table, 1, 0)!
    expect(changes).toHaveLength(1)
    expect(source.slice(changes[0].from, changes[0].to)).toContain("| a | b |")
    expect(changes[0].insert).toBe("")
  })

  it("inserts a column to the right of the given one", () => {
    const { source, table } = model()
    const changes = tableToolChanges("insert-col", source, table, 1, 0)!
    // 表头、分隔行、数据行各一处改动。
    expect(changes).toHaveLength(3)
  })

  it("deletes the second column", () => {
    const { source, table } = model()
    const changes = tableToolChanges("delete-col", source, table, 1, 1)!
    const next = applyFirst(source, changes)
    expect(next.split("\n")[0]).toBe("| A |")
    expect(next.split("\n")[2]).toBe("| a |")
  })

  it("aligns a column", () => {
    const { source, table } = model()
    const changes = tableToolChanges("align-center", source, table, 1, 1)!
    expect(changes[0].insert).toBe(":---:")
  })

  it("aligns left and right", () => {
    const { source, table } = model()
    expect(tableToolChanges("align-left", source, table, 1, 0)![0].insert).toBe(":---")
    expect(tableToolChanges("align-right", source, table, 1, 0)![0].insert).toBe("---:")
  })

  it("returns null when the captured model no longer matches the source", () => {
    const { source, table } = model()
    const stale = source.replace("| A |", "| A2 |")
    expect(tableToolChanges("insert-row", stale, table, 1, 0)).toBeNull()
    expect(tableToolChanges("delete-row", stale, table, 1, 0)).toBeNull()
    expect(tableToolChanges("align-center", stale, table, 1, 0)).toBeNull()
  })

  it("returns null for an out-of-range column", () => {
    const { source, table } = model()
    expect(tableToolChanges("align-center", source, table, 1, 5)).toBeNull()
    expect(tableToolChanges("insert-col", source, table, 1, 5)).toBeNull()
  })
})

/** 把 table-relative changes 应用到整段源码上（测试辅助，模拟 dispatch）。 */
function applyFirst(
  source: string,
  changes: readonly { from: number; to: number; insert: string }[],
): string {
  let out = source
  for (const change of [...changes].sort((a, b) => b.from - a.from)) {
    out = out.slice(0, change.from) + change.insert + out.slice(change.to)
  }
  return out
}

describe("applyTableTool resolves the caret cell and refuses read-only views", () => {
  function mount(doc: string, head: number, readOnly = false) {
    const parent = document.createElement("div")
    document.body.appendChild(parent)
    const view = new EditorView({
      state: EditorState.create({
        doc,
        selection: { anchor: head },
        extensions: [
          markdownLanguageSupport(),
          tableSourceToolbar,
          ...(readOnly ? [EditorState.readOnly.of(true)] : []),
        ],
      }),
      parent,
    })
    forceParsing(view, view.state.doc.length, 10_000)
    return { view, cleanup: () => { view.destroy(); parent.remove() } }
  }

  it("inserts a row below the caret's row", () => {
    const { view, cleanup } = mount(DOC, DOC.indexOf("b") + 1)
    expect(applyTableTool(view, "insert-row")).toBe(true)
    const lines = view.state.doc.toString().split("\n")
    expect(lines).toHaveLength(4)
    expect(lines[3]).toBe("|  |  |")
    cleanup()
  })

  it("aligns the caret's column in the delimiter row only", () => {
    const { view, cleanup } = mount(DOC, DOC.indexOf("b") + 1)
    expect(applyTableTool(view, "align-right")).toBe(true)
    expect(view.state.doc.toString().split("\n")[1]).toBe("| --- | ---: |")
    cleanup()
  })

  it("returns false outside a table and leaves the doc untouched", () => {
    const doc = `${DOC}\n\nafter`
    const { view, cleanup } = mount(doc, doc.indexOf("after") + 1)
    expect(applyTableTool(view, "insert-row")).toBe(false)
    expect(view.state.doc.toString()).toBe(doc)
    cleanup()
  })

  it("returns false on a read-only view", () => {
    const { view, cleanup } = mount(DOC, DOC.indexOf("b") + 1, true)
    expect(applyTableTool(view, "insert-row")).toBe(false)
    expect(applyTableTool(view, "align-center")).toBe(false)
    expect(view.state.doc.toString()).toBe(DOC)
    cleanup()
  })
})
