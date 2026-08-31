import { syntaxTree } from "@codemirror/language"
import type { SyntaxNode } from "@lezer/common"
import { describe, expect, it } from "vitest"
import {
  deleteTableColumn,
  deleteTableRow,
  insertTableColumn,
  insertTableRow,
  replaceTableCell,
  type TableSourceChange,
} from "../src/tables/edit"
import { tableDataFromNode, type TableCellData, type TableData } from "../src/tables/model"
import { makeState } from "./helpers"

const src = `| A | B |
| --- | ---: |
| 1 | 2 |`
const cell: TableCellData = { text: "2", source: "2", from: 31, to: 32 }

// A parsed table record: model metadata plus the exact source substring the
// transforms edit. All model offsets are relative to the Table node, so
// `text` is that same substring — the widget passes `this.src`, which is the
// table node's source captured at construction.
interface TableRecord {
  readonly data: TableData
  readonly text: string
  readonly start: number
}

function tableRecord(source: string): TableRecord {
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
  return { data, text: source.slice(table.from, table.to), start: table.from }
}

// Reconstruct the full document after applying table-relative changes:
// the table substring swapped by the changes, everything outside untouched.
function applyChanges(source: string, changes: readonly TableSourceChange[]) {
  let out = source
  for (const change of [...changes].sort((a, b) => b.from - a.from)) {
    out = out.slice(0, change.from) + change.insert + out.slice(change.to)
  }
  return out
}

// The brief contract: every returned change list is sorted ascending and
// pairwise non-overlapping, so CodeMirror can consume it as one transaction.
function expectSortedNonOverlapping(changes: readonly TableSourceChange[]) {
  for (const [i, change] of changes.entries()) {
    expect(change.from).toBeGreaterThanOrEqual(0)
    expect(change.from).toBeLessThanOrEqual(change.to)
    if (i > 0) expect(change.from).toBeGreaterThanOrEqual(changes[i - 1].to)
  }
  const sorted = [...changes].sort((a, b) => a.from - b.from)
  expect(changes.map(c => c.from)).toEqual(sorted.map(c => c.from))
}

describe("table source transforms: cell edits", () => {
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
    expect(applyChanges(source, [change!])).toBe(`| A | B |
| --- | --- |
| 1 | x |`)
  })

  it("replaces an existing cell in a ragged Lezer table", () => {
    const source = `| A | B |
| --- | --- |
| only |`
    const { data, text } = tableRecord(source)
    const only = data.rows[0].cells[0]
    expect(only).not.toBeNull()
    expect(data.rows[0].cells[1]).toBeNull()
    const change = replaceTableCell(text, only!, "x")
    expect(change).toEqual({ from: only!.from, to: only!.to, insert: "x" })
    expect(applyChanges(text, [change!])).toBe(`| A | B |
| --- | --- |
| x |`)
  })
})

describe("table row transforms", () => {
  it("appends a blank row and preserves every other source byte", () => {
    const { data, text } = tableRecord(src)
    const changes = insertTableRow(text, data, 1)
    expect(changes).toEqual([{ from: 34, to: 34, insert: "\n|  |  |" }])
    expect(applyChanges(text, changes!)).toBe(`| A | B |
| --- | ---: |
| 1 | 2 |
|  |  |`)
    expect(tableRecord(applyChanges(text, changes!)).data.rows).toHaveLength(2)
  })

  it("inserts directly after the separator for afterRow 0", () => {
    const two = `| A | B |
| --- | ---: |
| 1 | 2 |
| 3 | 4 |`
    const { data, text } = tableRecord(two)
    const changes = insertTableRow(text, data, 0)
    expect(changes).toEqual([{ from: 25, to: 25, insert: "|  |  |\n" }])
    const out = applyChanges(text, changes!)
    expect(out).toBe(`| A | B |
| --- | ---: |
|  |  |
| 1 | 2 |
| 3 | 4 |`)
    expect(tableRecord(out).data.rows).toHaveLength(3)
  })

  it("inserts a quoted row that carries the neighbor prefix", () => {
    const quoted = `> | A | B |
> | --- | --- |
> | 1 | 2 |`
    const record = tableRecord(quoted)
    expect(record.start).toBe(2)
    const changes = insertTableRow(record.text, record.data, 0)
    expect(changes).toEqual([{ from: 26, to: 26, insert: "> |  |  |\n" }])
    // 表子串内第一行的 `> ` 在 Table 节点之外；前缀只由模型 prefix 字段带入新行。
    const out = applyChanges(record.text, changes!)
    expect(`> ${out}`).toBe(`> | A | B |
> | --- | --- |
> |  |  |
> | 1 | 2 |`)
    const rebuilt = tableRecord(`> ${out}`).data
    expect(rebuilt.rows).toHaveLength(2)
    expect(rebuilt.rows.map(row => row.prefix)).toEqual(["> ", "> "])
  })

  it("owns exactly one newline even with a trailing table newline", () => {
    const withNl = `${src}\n`
    const record = tableRecord(withNl)
    // The trailing newline sits outside the Table node; the change inserts the
    // row's own newline and the editor keeps the untouched newline after it.
    expect(record.text).toBe(src)
    const changes = insertTableRow(record.text, record.data, 1)
    expect(changes).toEqual([{ from: 34, to: 34, insert: "\n|  |  |" }])
    const out = applyChanges(record.text, changes!)
    expect(out).toBe(`${src}\n|  |  |`)
    expect((out.match(/\n/g) ?? []).length).toBe((src.match(/\n/g) ?? []).length + 1)
  })

  it("matches the one-sided outer-pipe style of the neighbor row", () => {
    const oneSided = `| A | B
| --- | ---
| 1 | 2`
    const { data, text } = tableRecord(oneSided)
    const changes = insertTableRow(text, data, 1)
    expect(changes).toEqual([{ from: 27, to: 27, insert: "\n|  |  " }])
    expect(applyChanges(text, changes!)).toBe(`| A | B
| --- | ---
| 1 | 2
|  |  `)
  })

  it("rejects an out-of-range afterRow", () => {
    const { data, text } = tableRecord(src)
    expect(insertTableRow(text, data, -1)).toBeNull()
    expect(insertTableRow(text, data, 2)).toBeNull()
  })

  it("rejects stale row metadata after the source drifts", () => {
    // 改到表子串内部字节，使 cell/prefix 校验失效。
    const stale = src.slice(0, 27) + "9" + src.slice(28)
    const { data } = tableRecord(src)
    const { data: staleData } = tableRecord(stale)
    expect(insertTableRow(src, staleData, 1)).toBeNull()
    expect(insertTableRow(stale, data, 1)).toBeNull()
  })

  it("deletes exactly one data row plus its newline", () => {
    const two = `| A | B |
| --- | ---: |
| 1 | 2 |
| 3 | 4 |`
    const { data, text } = tableRecord(two)
    const changes = deleteTableRow(text, data, 0)
    expect(changes).toEqual([{ from: 25, to: 35, insert: "" }])
    const out = applyChanges(text, changes!)
    expect(out).toBe(`| A | B |
| --- | ---: |
| 3 | 4 |`)
    expect(tableRecord(out).data.rows).toHaveLength(1)
  })

  it("deletes the final data row when the file ends without a newline", () => {
    const two = `| A | B |
| --- | ---: |
| 1 | 2 |
| 3 | 4 |`
    const { data, text } = tableRecord(two)
    const changes = deleteTableRow(text, data, 1)
    expect(changes).toEqual([{ from: 34, to: 44, insert: "" }])
    expect(applyChanges(text, changes!)).toBe(`| A | B |
| --- | ---: |
| 1 | 2 |`)
  })

  it("never deletes the last remaining data row and rejects out-of-range rows", () => {
    const { data, text } = tableRecord(src)
    expect(deleteTableRow(text, data, -1)).toBeNull()
    expect(deleteTableRow(text, data, 0)).toBeNull()
    expect(deleteTableRow(text, data, 1)).toBeNull()
  })

  it("rejects stale row metadata when deleting", () => {
    const stale = src.slice(0, 33) + "x"
    const { data } = tableRecord(src)
    expect(deleteTableRow(stale, data, 0)).toBeNull()
  })
})

describe("table column transforms", () => {
  it("inserts a column into a pipeless table without adding outer pipes", () => {
    const noOuter = `A | B
--- | ---
1 | 2`
    const { data, text } = tableRecord(noOuter)
    const changes = insertTableColumn(text, data, 1)
    expect(changes).toEqual([
      { from: 5, to: 5, insert: " |  " },
      { from: 15, to: 15, insert: " |---" },
      { from: 21, to: 21, insert: " |  " },
    ])
    expectSortedNonOverlapping(changes!)
    // 新增列的内容是 `  `（两空格），落在一行末尾；用拼接避免源文件行尾空白。
    expect(applyChanges(text, changes!)).toBe(`A | B |` + `  \n--- | --- |---\n1 | 2 |` + `  `)
  })

  it("inserts a column into a quoted table preserving every prefix", () => {
    const quoted = `> | A | B |
> | --- | --- |
> | 1 | 2 |`
    const { data, text, start } = tableRecord(quoted)
    const changes = insertTableColumn(text, data, 1)
    expect(changes).toEqual([
      { from: 7, to: 9, insert: " |  |" },
      { from: 23, to: 25, insert: " | --- |" },
      { from: 35, to: 37, insert: " |  |" },
    ])
    expectSortedNonOverlapping(changes!)
    const out = applyChanges(text, changes!)
    // 表子串不包含第一行前缀；重建整篇文档后校验每行前缀仍在。
    expect(out).toBe(`| A | B |  |
> | --- | --- | --- |
> | 1 | 2 |  |`)
    const doc = `> ${out}`
    expect(doc.split("\n").every(line => line.startsWith("> "))).toBe(true)
    expect(start).toBe(2)
    expect(tableRecord(doc).data.header.cells).toHaveLength(3)
  })

  it("inserts a column after the final existing column", () => {
    const { data, text } = tableRecord(src)
    const changes = insertTableColumn(text, data, 1)
    expect(changes).toEqual([
      { from: 7, to: 9, insert: " |  |" },
      { from: 22, to: 24, insert: " | --- |" },
      { from: 32, to: 34, insert: " |  |" },
    ])
    const out = applyChanges(text, changes!)
    expect(out).toBe(`| A | B |  |
| --- | ---: | --- |
| 1 | 2 |  |`)
    expect(tableRecord(out).data.aligns).toEqual(["", "right", ""])
  })

  it("inserts a column after a middle column", () => {
    const { data, text } = tableRecord(src)
    const changes = insertTableColumn(text, data, 0)
    expect(changes).toEqual([
      { from: 3, to: 6, insert: " |  | " },
      { from: 15, to: 18, insert: " | --- | " },
      { from: 28, to: 31, insert: " |  | " },
    ])
    expect(applyChanges(text, changes!)).toBe(`| A |  | B |
| --- | --- | ---: |
| 1 |  | 2 |`)
  })

  it("fills ragged rows up to the requested insertion column", () => {
    const ragged = `| a\\|b | c |
| --- | --- |
| 1 | |
| only |`
    const { data, text } = tableRecord(ragged)
    const changes = insertTableColumn(text, data, 1)
    expect(changes).toEqual([
      { from: 10, to: 12, insert: " |  |" },
      { from: 24, to: 26, insert: " | --- |" },
      { from: 32, to: 34, insert: " |  |" },
      { from: 41, to: 43, insert: " |  |  |" },
    ])
    expectSortedNonOverlapping(changes!)
    const out = applyChanges(text, changes!)
    expect(out).toBe(`| a\\|b | c |  |
| --- | --- | --- |
| 1 | |  |
| only |  |  |`)
    // 补齐后的每行都拥有与表头一致的 3 个源槽，且没有 null（缺失）槽。
    const model = tableRecord(out).data
    expect(model.rows.map(row => row.cells.length)).toEqual([3, 3])
    expect(model.rows.every(row => row.cells.every(cell => cell !== null))).toBe(true)
  })

  it("returns sorted non-overlapping changes for a ragged quoted insert", () => {
    const raggedQuoted = `> | a | b |
> | --- | --- |
> | only |`
    const { data, text } = tableRecord(raggedQuoted)
    const changes = insertTableColumn(text, data, 0)
    expect(changes).not.toBeNull()
    expectSortedNonOverlapping(changes!)
    const out = applyChanges(text, changes!)
    expect(`> ${out}`.split("\n").every(line => line.startsWith("> "))).toBe(true)
    expect(tableRecord(`> ${out}`).data.header.cells).toHaveLength(3)
  })

  it("rejects a stale header slice anywhere in the table", () => {
    const stale = src.slice(0, 2) + "X" + src.slice(3)
    const { data } = tableRecord(src)
    // 同源 fresh 元数据必须可用；漂移后的 source 必须被拒绝。
    expect(insertTableColumn(src, data, 1)).not.toBeNull()
    expect(insertTableColumn(stale, data, 1)).toBeNull()
  })

  it("rejects an out-of-range column index", () => {
    const { data, text } = tableRecord(src)
    expect(insertTableColumn(text, data, -1)).toBeNull()
    expect(insertTableColumn(text, data, 2)).toBeNull()
    expect(deleteTableColumn(text, data, -1)).toBeNull()
    expect(deleteTableColumn(text, data, 2)).toBeNull()
  })

  it("deletes a column and keeps the remaining alignment marker", () => {
    const { data, text } = tableRecord(src)
    const changes = deleteTableColumn(text, data, 0)
    expect(changes).toEqual([
      { from: 2, to: 6, insert: "" },
      { from: 12, to: 18, insert: "" },
      { from: 27, to: 31, insert: "" },
    ])
    expectSortedNonOverlapping(changes!)
    const out = applyChanges(text, changes!)
    expect(out).toBe(`| B |
| ---: |
| 2 |`)
    expect(tableRecord(out).data.aligns).toEqual(["right"])
  })

  it("deletes the final column using the left delimiter", () => {
    const { data, text } = tableRecord(src)
    const changes = deleteTableColumn(text, data, 1)
    expect(changes).toEqual([
      { from: 3, to: 7, insert: "" },
      { from: 15, to: 22, insert: "" },
      { from: 28, to: 32, insert: "" },
    ])
    expect(applyChanges(text, changes!)).toBe(`| A |
| --- |
| 1 |`)
  })

  it("skips a missing ragged-tail cell when deleting its column", () => {
    const ragged = `| a\\|b | c |
| --- | --- |
| 1 | |
| only |`
    const { data, text } = tableRecord(ragged)
    const changes = deleteTableColumn(text, data, 1)
    expect(changes).toEqual([
      { from: 6, to: 10, insert: "" },
      { from: 18, to: 24, insert: "" },
      { from: 30, to: 32, insert: "" },
    ])
    expect(applyChanges(text, changes!)).toBe(`| a\\|b |
| --- |
| 1 |
| only |`)
    const model = tableRecord(applyChanges(text, changes!)).data
    expect(model.rows[1].cells[0]?.source).toBe("only")
  })

  it("keeps both pipes when deleting the only cell of a ragged row", () => {
    const ragged = `| a\\|b | c |
| --- | --- |
| 1 | |
| only |`
    const { data, text } = tableRecord(ragged)
    const changes = deleteTableColumn(text, data, 0)
    expect(changes).toEqual([
      { from: 2, to: 9, insert: "" },
      { from: 15, to: 21, insert: "" },
      { from: 29, to: 32, insert: "" },
      { from: 37, to: 41, insert: "" },
    ])
    expectSortedNonOverlapping(changes!)
    expect(applyChanges(text, changes!)).toBe(`| c |
| --- |
|  |
|  |`)
  })

  it("never deletes the last column", () => {
    const single = `| A |
|---|
| 1 |`
    const { data, text } = tableRecord(single)
    expect(deleteTableColumn(text, data, 0)).toBeNull()
  })
})
