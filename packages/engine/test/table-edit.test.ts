import { syntaxTree } from "@codemirror/language"
import type { SyntaxNode } from "@lezer/common"
import { describe, expect, it } from "vitest"
import {
  deleteTableColumn,
  deleteTableRow,
  insertTableColumn,
  insertTableRow,
  replaceTableCell,
} from "../src/tables/edit"
import { tableDataFromNode, type TableCellData } from "../src/tables/model"
import { makeState } from "./helpers"

const src = `| A | B |
| --- | ---: |
| 1 | 2 |`
const cell: TableCellData = { text: "2", source: "2", from: 31, to: 32 }

function firstTableData(source: string) {
  const state = makeState(source)
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
  return data
}

function applyChange(source: string, change: { from: number; to: number; insert: string }) {
  return source.slice(0, change.from) + change.insert + source.slice(change.to)
}

describe("table source transforms", () => {
  it("returns an exact range change for a data cell", () => {
    expect(replaceTableCell(src, cell, "x")).toEqual({ from: 31, to: 32, insert: "x" })
  })

  it("escapes unescaped pipes without double-escaping existing escaped pipes", () => {
    expect(replaceTableCell(src, cell, "a|b")).toEqual({ from: 31, to: 32, insert: "a\\|b" })
    expect(replaceTableCell(src, cell, "a\\|b")).toEqual({ from: 31, to: 32, insert: "a\\|b" })
  })

  it("rejects stale or out-of-range cell metadata", () => {
    expect(replaceTableCell(src, { ...cell, source: "stale" }, "x")).toBeNull()
    expect(replaceTableCell(src, { ...cell, from: -1 }, "x")).toBeNull()
  })

  it("fills only a source-backed empty cell slot", () => {
    const source = `| A | B |
| --- | --- |
| 1 |  |`
    const empty: TableCellData = { text: "", source: "", from: 30, to: 30 }
    const change = replaceTableCell(source, empty, "x")
    expect(change).toEqual({ from: 30, to: 30, insert: "x" })
    expect(applyChange(source, change!)).toBe(`| A | B |
| --- | --- |
| 1 | x |`)
  })

  it("replaces an existing cell in a ragged Lezer table", () => {
    const source = `| A | B |
| --- | --- |
| only |`
    const data = firstTableData(source)
    const only = data.rows[0].cells[0]
    expect(only).not.toBeNull()
    expect(data.rows[0].cells[1]).toBeNull()
    const change = replaceTableCell(source, only!, "x")
    expect(change).toEqual({ from: only!.from, to: only!.to, insert: "x" })
    expect(applyChange(source, change!)).toBe(`| A | B |
| --- | --- |
| x |`)
  })

  it("inserts an empty row after the given data row", () => {
    expect(insertTableRow(src, 1)).toBe(`| A | B |
| --- | ---: |
| 1 | 2 |
|  |  |`)
  })

  it("inserts a column after the given column and keeps the alignment row", () => {
    expect(insertTableColumn(src, 1)).toBe(`| A | B |  |
| --- | ---: | --- |
| 1 | 2 |  |`)
  })

  it("deletes a column down to one remaining column", () => {
    expect(deleteTableColumn(src, 0)).toBe(`| B |
| ---: |
| 2 |`)
    expect(deleteTableColumn(`| B |
| ---: |
| 2 |`, 0)).toBeNull()
  })

  it("deletes a data row but never the last data row or the header", () => {
    const two = `| A | B |
| --- | ---: |
| 1 | 2 |
| 3 | 4 |`
    expect(deleteTableRow(two, 1)).toBe(`| A | B |
| --- | ---: |
| 3 | 4 |`)
    expect(deleteTableRow(src, 1)).toBeNull()
    expect(deleteTableRow(src, 0)).toBeNull()
  })

  it("returns null for a malformed table with no separator", () => {
    expect(insertTableRow("| no sep", 0)).toBeNull()
    expect(insertTableColumn("| no sep", 0)).toBeNull()
    expect(deleteTableRow("| no sep", 1)).toBeNull()
    expect(deleteTableColumn("| no sep", 0)).toBeNull()
  })

  it("keeps a trailing newline so the next block is not glued on", () => {
    const withNl = `${src}\n`
    expect(insertTableRow(withNl, 1)).toBe(`| A | B |
| --- | ---: |
| 1 | 2 |
|  |  |
`)
  })

  it("returns null when header, separator, or row column counts differ", () => {
    const raggedSep = `| A | B |
| --- |
| 1 | 2 |`
    expect(insertTableRow(raggedSep, 1)).toBeNull()
    expect(insertTableColumn(raggedSep, 0)).toBeNull()
    expect(deleteTableRow(raggedSep, 1)).toBeNull()
    expect(deleteTableColumn(raggedSep, 0)).toBeNull()
  })
})
