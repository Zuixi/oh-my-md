import { syntaxTree } from "@codemirror/language"
import type { SyntaxNode } from "@lezer/common"
import { describe, expect, it } from "vitest"
import { tableDataFromNode } from "../src/tables/model"
import { makeState } from "./helpers"

function firstTable(doc: string) {
  const state = makeState(doc)
  let table: SyntaxNode | null = null
  const cursor = syntaxTree(state).cursor()
  do {
    if (cursor.name === "Table") {
      table = cursor.node
      break
    }
  } while (cursor.next())
  if (!table) throw new Error("expected a Table node")
  const data = tableDataFromNode(table, state)
  if (!data) throw new Error("expected table data")
  return { data, tableFrom: table.from }
}

describe("tableDataFromNode", () => {
  it("derives regular cell, delimiter, and alignment ranges from Lezer", () => {
    const regular = `| A | B |
| --- | ---: |
| 1 | 2 |`
    const { data } = firstTable(regular)

    expect(data.header.cells.map(cell => cell && [cell.source, cell.from, cell.to])).toEqual([
      ["A", 2, 3],
      ["B", 6, 7],
    ])
    expect(data.delimiter.cells.map(cell => cell && [cell.source, cell.from, cell.to])).toEqual([
      ["---", 12, 15],
      ["---:", 18, 22],
    ])
    expect(data.rows[0].cells.map(cell => cell?.source)).toEqual(["1", "2"])
    expect(data.aligns).toEqual(["", "right"])
  })

  it("preserves rows without outer pipes", () => {
    const noOuterPipes = `A | B
--- | ---
1 | 2`
    const { data } = firstTable(noOuterPipes)

    expect(data.header.leadingPipe).toBe(false)
    expect(data.header.trailingPipe).toBe(false)
    expect(data.header.cells.map(cell => cell?.source)).toEqual(["A", "B"])
  })

  it("distinguishes escaped pipes, empty slots, and missing ragged tails", () => {
    const escapedAndRagged = `| a\\|b | c |
| --- | --- |
| 1 | |
| only |`
    const { data } = firstTable(escapedAndRagged)

    expect(data.header.cells[0]?.source).toBe("a\\|b")
    expect(data.header.cells[0]?.text).toBe("a|b")
    expect(data.rows[0].cells).toHaveLength(2)
    expect(data.rows[0].cells[1]).toMatchObject({ source: "", text: "" })
    expect(data.rows[1].cells).toEqual([
      expect.objectContaining({ source: "only", text: "only" }),
      null,
    ])
  })

  it("records quote continuation prefixes inside table-relative line ranges", () => {
    const quoted = `> | A | B |
> | --- | --- |
> | 1 | 2 |`
    const { data, tableFrom } = firstTable(quoted)

    expect(data.rows[0].prefix).toBe("> ")
    expect(quoted.slice(tableFrom + data.rows[0].lineFrom, tableFrom + data.rows[0].from)).toBe("> ")
  })
})
