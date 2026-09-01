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

  it("extracts cells and aligns from short delimiter markers Lezer already accepts", () => {
    const short = `| A | B |
| - | -- |
| 1 | 2 |`
    const { data } = firstTable(short)

    expect(data.delimiter.cells.map(cell => cell && [cell.source, cell.from, cell.to])).toEqual([
      ["-", 12, 13],
      ["--", 16, 18],
    ])
    expect(data.aligns).toEqual(["", ""])
    expect(data.rows[0].cells.map(cell => cell?.source)).toEqual(["1", "2"])
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

  it("keeps an empty trailing slot source-backed when a row has no outer pipes", () => {
    const trailingEmpty = `A | B
--- | ---
1 |`
    const { data } = firstTable(trailingEmpty)

    expect(data.rows[0].leadingPipe).toBe(false)
    expect(data.rows[0].trailingPipe).toBe(false)
    expect(data.rows[0].cells).toEqual([
      expect.objectContaining({ source: "1", text: "1" }),
      expect.objectContaining({ source: "", text: "", from: 19, to: 19 }),
    ])
  })

  it("keeps an empty leading slot source-backed when a row has no outer pipes", () => {
    const leadingEmpty = `A | B
--- | ---
| 2`
    const { data } = firstTable(leadingEmpty)

    expect(data.rows[0].leadingPipe).toBe(false)
    expect(data.rows[0].trailingPipe).toBe(false)
    expect(data.rows[0].cells).toEqual([
      expect.objectContaining({ source: "", text: "", from: 16, to: 16 }),
      expect.objectContaining({ source: "2", text: "2" }),
    ])
  })

  it("preserves a leading outer pipe on a ragged row", () => {
    const leadingOuterRagged = `| A | B |
| --- | --- |
| only`
    const { data } = firstTable(leadingOuterRagged)

    expect(data.rows[0].leadingPipe).toBe(true)
    expect(data.rows[0].trailingPipe).toBe(false)
    expect(data.rows[0].cells).toEqual([
      expect.objectContaining({ source: "only", text: "only" }),
      null,
    ])
  })

  it("preserves a trailing outer pipe without inventing an empty ragged slot", () => {
    const trailingOuterRagged = `| A | B |
| --- | --- |
only |`
    const { data } = firstTable(trailingOuterRagged)

    expect(data.rows[0].leadingPipe).toBe(false)
    expect(data.rows[0].trailingPipe).toBe(true)
    expect(data.rows[0].cells).toEqual([
      expect.objectContaining({ source: "only", text: "only" }),
      null,
    ])
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
