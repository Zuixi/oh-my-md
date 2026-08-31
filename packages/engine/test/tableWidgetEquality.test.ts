import { describe, expect, it, vi } from "vitest"
import type { TableData } from "../src/decorations/widgets/table"

// TableWidget's base imports the live decoration field, which is irrelevant to equality tests.
vi.mock("../src/decorations/build", () => ({
  livePreviewField: {},
}))

describe("table widget equality", () => {
  it("distinguishes every table DOM input", async () => {
    const { tableEqualityKey } = await import("../src/decorations/widgets/table")
    expect(tableEqualityKey({ header: ["a"], rows: [["1"]], aligns: [""] }))
      .not.toBe(tableEqualityKey({ header: ["b"], rows: [["1"]], aligns: [""] }))
    expect(tableEqualityKey({ header: ["a"], rows: [["1"]], aligns: [""] }))
      .not.toBe(tableEqualityKey({ header: ["a"], rows: [["2"]], aligns: [""] }))
    expect(tableEqualityKey({ header: ["a"], rows: [["1"]], aligns: [""] }))
      .not.toBe(tableEqualityKey({ header: ["a"], rows: [["1"]], aligns: ["right"] }))
  })

  it("reuses a construction-time key across repeated equality checks", async () => {
    const stringifySpy = vi.spyOn(JSON, "stringify")
    const { TableWidget } = await import("../src/decorations/widgets/table")
    const table = { header: ["a"], rows: [["1"]], aligns: [""] } satisfies TableData
    const left = new TableWidget("| a |", 0, table)
    const right = new TableWidget("| a |", 10, table)
    try {
      stringifySpy.mockClear()
      expect(left.eq(right)).toBe(true)
      expect(left.eq(right)).toBe(true)
      expect(stringifySpy).not.toHaveBeenCalled()
    } finally {
      stringifySpy.mockRestore()
    }
  })

  it("does not reuse a table widget when its embed context changes", async () => {
    const { TableWidget } = await import("../src/decorations/widgets/table")
    const table = { header: ["a"], rows: [["1"]], aligns: [""] } satisfies TableData
    const root = new TableWidget("| a |", 0, table, {
      quoteDepth: 0,
      listDepth: 0,
      quoteInList: false,
    })
    const quoted = new TableWidget("| a |", 0, table, {
      quoteDepth: 1,
      listDepth: 0,
      quoteInList: false,
    })

    expect(root.eq(quoted)).toBe(false)
  })
})
