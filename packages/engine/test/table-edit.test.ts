import { describe, expect, it } from "vitest"
import {
  deleteTableColumn,
  deleteTableRow,
  insertTableColumn,
  insertTableRow,
  replaceTableCell,
} from "../src/tables/edit"

const src = `| A | B |
| --- | ---: |
| 1 | 2 |`

describe("table source transforms", () => {
  it("replaces a data cell without rewriting the rest of the table", () => {
    expect(replaceTableCell(src, 1, 1, "x")).toBe(`| A | B |
| --- | ---: |
| 1 | x |`)
  })

  it("replaces a header cell", () => {
    expect(replaceTableCell(src, 0, 0, "Z")).toBe(`| Z | B |
| --- | ---: |
| 1 | 2 |`)
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

  it("preserves escaped pipes in unedited cells", () => {
    const escaped = `| A \\| B | C |
| --- | --- |
| 1 | 2 |`
    expect(replaceTableCell(escaped, 0, 1, "D")).toBe(`| A \\| B | D |
| --- | --- |
| 1 | 2 |`)
  })

  it("returns null for a malformed table with no separator", () => {
    expect(replaceTableCell("| no sep", 0, 0, "x")).toBeNull()
    expect(insertTableRow("| no sep", 0)).toBeNull()
    expect(insertTableColumn("| no sep", 0)).toBeNull()
    expect(deleteTableRow("| no sep", 1)).toBeNull()
    expect(deleteTableColumn("| no sep", 0)).toBeNull()
  })

  it("keeps a trailing newline so the next block is not glued on", () => {
    const withNl = `${src}\n`
    expect(replaceTableCell(withNl, 1, 1, "x")).toBe(`| A | B |
| --- | ---: |
| 1 | x |
`)
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
    const raggedRow = `| A | B |
| --- | --- |
| 1 |`
    expect(replaceTableCell(raggedSep, 1, 1, "x")).toBeNull()
    expect(insertTableRow(raggedSep, 1)).toBeNull()
    expect(insertTableColumn(raggedSep, 0)).toBeNull()
    expect(deleteTableRow(raggedSep, 1)).toBeNull()
    expect(deleteTableColumn(raggedSep, 0)).toBeNull()
    expect(replaceTableCell(raggedRow, 1, 0, "x")).toBeNull()
  })
})
