import { describe, expect, it, vi } from "vitest"
import type { TableAlignment, TableCellData, TableData, TableRowData } from "../src/tables/model"

// TableWidget's base imports the live decoration field, which is irrelevant to equality tests.
vi.mock("../src/decorations/build", () => ({
  livePreviewField: {},
}))

function cell(source: string, from = 0): TableCellData {
  return { text: source, source, from, to: from + source.length }
}

function row(values: readonly string[], from = 0): TableRowData {
  const cells = values.map((value, index) => cell(value, from + index * 4))
  return {
    from,
    to: from + Math.max(1, values.length * 4 - 1),
    lineFrom: from,
    lineTo: from + Math.max(1, values.length * 4 - 1),
    prefix: "",
    leadingPipe: true,
    trailingPipe: true,
    cells,
  }
}

function table(
  header: readonly string[],
  rows: readonly (readonly string[])[],
  aligns: readonly TableAlignment[] = header.map(() => ""),
): TableData {
  return {
    header: row(header),
    delimiter: row(aligns.map(align => align === "right" ? "---:" : "---"), 10),
    rows: rows.map((values, index) => row(values, 20 + index * 10)),
    aligns,
  }
}

describe("table widget equality", () => {
  it("distinguishes every table DOM input", async () => {
    const { tableEqualityKey } = await import("../src/decorations/widgets/table")
    expect(tableEqualityKey(table(["a"], [["1"]])))
      .not.toBe(tableEqualityKey(table(["b"], [["1"]])))
    expect(tableEqualityKey(table(["a"], [["1"]])))
      .not.toBe(tableEqualityKey(table(["a"], [["2"]])))
    expect(tableEqualityKey(table(["a"], [["1"]])))
      .not.toBe(tableEqualityKey(table(["a"], [["1"]], ["right"])))
  })

  it("reuses a construction-time key across repeated equality checks", async () => {
    const stringifySpy = vi.spyOn(JSON, "stringify")
    const { TableWidget } = await import("../src/decorations/widgets/table")
    const data = table(["a"], [["1"]])
    const left = new TableWidget("| a |", 0, data)
    const right = new TableWidget("| a |", 10, data)
    try {
      stringifySpy.mockClear()
      expect(left.eq(right)).toBe(true)
      expect(left.eq(right)).toBe(true)
      expect(stringifySpy).not.toHaveBeenCalled()
    } finally {
      stringifySpy.mockRestore()
    }
  })

  it("does not reuse a table widget when a row is added", async () => {
    const { TableWidget } = await import("../src/decorations/widgets/table")
    const compact = new TableWidget("| a |", 0, table(["a"], [["1"]]))
    const expanded = new TableWidget("| a |", 0, table(["a"], [["1"], ["2"]]))

    expect(compact.eq(expanded)).toBe(false)
  })

  it("does not reuse a table widget when its embed context changes", async () => {
    const { TableWidget } = await import("../src/decorations/widgets/table")
    const data = table(["a"], [["1"]])
    const root = new TableWidget("| a |", 0, data, {
      quoteDepth: 0,
      listDepth: 0,
      quoteInList: false,
    })
    const quoted = new TableWidget("| a |", 0, data, {
      quoteDepth: 1,
      listDepth: 0,
      quoteInList: false,
    })

    expect(root.eq(quoted)).toBe(false)
  })
})
