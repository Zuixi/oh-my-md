import { describe, expect, it, vi } from "vitest"
import { BlockWidget } from "../src/decorations/blockWidget"
import type { TableData } from "../src/decorations/widgets/table"

vi.mock("../src/decorations/build", () => ({
  livePreviewField: {},
}))

describe("table widget equality", () => {
  it("loads the block widget base first", () => {
    expect(BlockWidget).toBeTruthy()
  })

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
      expect(left.eq(right)).toBe(true)
      expect(left.eq(right)).toBe(true)
      expect(stringifySpy).toHaveBeenCalledTimes(2)
    } finally {
      stringifySpy.mockRestore()
    }
  })
})
