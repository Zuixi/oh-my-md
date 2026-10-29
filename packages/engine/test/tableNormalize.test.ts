import { syntaxTree } from "@codemirror/language"
import type { SyntaxNode } from "@lezer/common"
import { describe, expect, it } from "vitest"
import {
  tableDataFromNode,
  type TableCellData,
  type TableData,
  type TableRowData,
} from "../src/tables/model"
import { normalizeTableForFirstEdit } from "../src/tables/normalize"
import { makeState } from "./helpers"

interface TableRecord {
  readonly data: TableData
  readonly source: string
}

function tableRecord(doc: string): TableRecord {
  const state = makeState(doc)
  let node: SyntaxNode | null = null
  const cursor = syntaxTree(state).cursor()
  do {
    if (cursor.name === "Table") {
      node = cursor.node
      break
    }
  } while (cursor.next())
  if (!node) throw new Error("expected a Table node")
  const data = tableDataFromNode(node, state)
  if (!data) throw new Error("expected table data")
  return { data, source: state.doc.sliceString(node.from, node.to) }
}

function normalize(record: TableRecord, row: number, column: number, value: string, source = record.source) {
  return normalizeTableForFirstEdit(source, record.data, row, column, value)
}

function cellFixture(source: string, from: number, to: number): TableCellData {
  const slice = source.slice(from, to)
  return { source: slice, text: slice, from, to }
}

function rowFixture(
  source: string,
  [lineFrom, from, to, lineTo]: [number, number, number, number],
  cells: readonly TableCellData[],
): TableRowData {
  return {
    from,
    to,
    lineFrom,
    lineTo,
    prefix: source.slice(lineFrom, from),
    leadingPipe: true,
    trailingPipe: true,
    cells,
  }
}

const CRLF_SOURCE = "| A | B |\r\n| --- | ---: |\r\n| 1 | 2 |"
const CRLF_DATA: TableData = {
  header: rowFixture(CRLF_SOURCE, [0, 0, 9, 9], [cellFixture(CRLF_SOURCE, 2, 3), cellFixture(CRLF_SOURCE, 6, 7)]),
  delimiter: rowFixture(CRLF_SOURCE, [11, 11, 25, 25], [
    cellFixture(CRLF_SOURCE, 13, 16),
    cellFixture(CRLF_SOURCE, 19, 23),
  ]),
  rows: [rowFixture(CRLF_SOURCE, [27, 27, 36, 36], [cellFixture(CRLF_SOURCE, 29, 30), cellFixture(CRLF_SOURCE, 33, 34)])],
  aligns: ["", "right"],
}

interface SourceCase {
  readonly name: string
  readonly before: string
  readonly row: number
  readonly column: number
  readonly value: string
  readonly after: string
  readonly data?: TableData
}

const sourceCases: readonly SourceCase[] = [
  {
    name: "keeps an already canonical table canonical",
    before: "| A | B |\n| --- | --- |\n| 1 | 2 |",
    row: 0,
    column: 0,
    value: "X",
    after: "| X | B |\n| --- | --- |\n| 1 | 2 |",
  },
  {
    name: "adds missing outer pipes and canonical alignments",
    before: "A|  B\n:-----|---:\nC | D",
    row: 0,
    column: 0,
    value: "X",
    after: "| X | B |\n| :--- | ---: |\n| C | D |",
  },
  {
    name: "collapses irregular spacing around cells and pipes",
    before: "|A|B|\n|---|---|\n|  1  |  2|",
    row: 1,
    column: 1,
    value: "Y",
    after: "| A | B |\n| --- | --- |\n| 1 | Y |",
  },
  {
    name: "shrinks long alignment hyphen runs to three",
    before: "| A | B | C |\n| :-------- | --------: | :-------: |\n| 1 | 2 | 3 |",
    row: 1,
    column: 0,
    value: "X",
    after: "| A | B | C |\n| :--- | ---: | :---: |\n| X | 2 | 3 |",
  },
  {
    name: "preserves escaped pipes in untouched cells",
    before: "| A | B |\n| --- | --- |\n| C\\|D | E |",
    row: 0,
    column: 0,
    value: "X",
    after: "| X | B |\n| --- | --- |\n| C\\|D | E |",
  },
  {
    name: "escapes pipes typed into the active cell",
    before: "| A | B |\n| --- | --- |\n| 1 | 2 |",
    row: 1,
    column: 1,
    value: "P|Q",
    after: "| A | B |\n| --- | --- |\n| 1 | P\\|Q |",
  },
  {
    name: "keeps the CRLF line separator",
    before: CRLF_SOURCE,
    row: 0,
    column: 1,
    value: "X",
    after: "| A | X |\r\n| --- | ---: |\r\n| 1 | 2 |",
    data: CRLF_DATA,
  },
  {
    name: "keeps ordered-list continuation row prefixes",
    before: "| A | B |\n   | :--- | ---: |\n   | 1 | 2 |",
    row: 1,
    column: 1,
    value: "Y",
    after: "| A | B |\n   | :--- | ---: |\n   | 1 | Y |",
  },
]

describe("normalizeTableForFirstEdit", () => {
  for (const testCase of sourceCases) {
    it(testCase.name, () => {
      const record = testCase.data
        ? { data: testCase.data, source: testCase.before }
        : tableRecord(testCase.before)
      expect(record.source).toBe(testCase.before)
      const result = normalize(record, testCase.row, testCase.column, testCase.value)
      expect(result?.source).toBe(testCase.after)
    })
  }

  it("keeps the continuation prefix of a table inside an ordered-list item", () => {
    const record = tableRecord("1. | A | B |\n   | :--- | ---: |\n   | 1 | 2 |\n2. after")
    expect(record.data.delimiter.prefix).toBe("   ")
    expect(record.data.rows[0].prefix).toBe("   ")
    expect(normalize(record, 1, 0, "X")?.source).toBe("| A | B |\n   | :--- | ---: |\n   | X | 2 |")
  })

  it("reports the table-relative range of the active canonical cell content", () => {
    const result = normalize(tableRecord("| A |  B |\n|---|---|\n|  1  |  2|"), 1, 1, "XYZ")
    if (!result) throw new Error("expected a normalized table")
    expect(result.source).toBe("| A | B |\n| --- | --- |\n| 1 | XYZ |")
    expect(result.activeCell).toEqual({ from: 30, to: 33 })
    expect(result.source.slice(result.activeCell.from, result.activeCell.to)).toBe("XYZ")
  })

  it("points the active range at the escaped value, not at its padding", () => {
    const result = normalize(tableRecord("| A | B |\n| --- | --- |\n| 1 | 2 |"), 0, 1, "P|Q")
    if (!result) throw new Error("expected a normalized table")
    const { from, to } = result.activeCell
    expect(result.source.slice(from, to)).toBe("P\\|Q")
    expect(result.source.slice(from - 2, from)).toBe("| ")
    expect(result.source.slice(to, to + 2)).toBe(" |")
  })

  it("rejects table data captured from a different source", () => {
    const record = tableRecord("| A | B |\n| --- | --- |\n| 1 | 2 |")
    const stale = record.source.replace("| 1 |", "| 9 |")
    expect(stale).not.toBe(record.source)
    expect(normalize(record, 0, 0, "X", stale)).toBeNull()
  })

  it("rejects ragged table data with a missing cell slot", () => {
    const record = tableRecord("| A | B |\n| --- | --- |\n| 1 |")
    expect(record.data.rows[0].cells).toEqual([expect.objectContaining({ source: "1" }), null])
    expect(normalize(record, 0, 0, "X")).toBeNull()
  })

  it("rejects out-of-bounds rows and columns", () => {
    const record = tableRecord("| A | B |\n| --- | --- |\n| 1 | 2 |")
    expect(record.data.rows).toHaveLength(1)
    for (const [row, column] of [
      [-1, 0],
      [2, 0],
      [99, 0],
      [0, -1],
      [0, 2],
      [1, 99],
    ]) {
      expect(normalize(record, row, column, "X"), `row ${row} column ${column}`).toBeNull()
    }
    expect(normalize(record, 0, 1, "X")).not.toBeNull()
  })
})
