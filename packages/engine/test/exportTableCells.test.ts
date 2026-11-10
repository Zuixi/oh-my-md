import { describe, expect, it, vi } from "vitest"
import { makeState } from "./helpers"

vi.mock("mermaid", () => ({ default: { initialize: vi.fn(), render: vi.fn() } }))
const { exportHtml, exportRichHtml } = await import("../src/export/html")

// Lezer has no TableCell node for an empty slot; export must keep the column.
describe("tables with empty cells", () => {
  const DOC = "| a | b | c |\n|---|---|---|\n| 1 |  | 3 |\n|  | 5 |  |\n| 7 |"
  const grid = (html: string) =>
    [...new DOMParser().parseFromString(html, "text/html").querySelectorAll("tr")]
      .map(tr => [...tr.children].map(cell => cell.textContent))
  const expected = [["a", "b", "c"], ["1", "", "3"], ["", "5", ""], ["7", "", ""]]

  it("keeps every column in the synchronous export", () => {
    expect(grid(exportHtml(makeState(DOC)))).toEqual(expected)
  })

  it("keeps every column in the rich export", async () => {
    expect(grid(await exportRichHtml(makeState(DOC)))).toEqual(expected)
  })

  it("ignores cells beyond the header width (GFM)", () => {
    expect(grid(exportHtml(makeState("| a |\n|---|\n| 1 | extra |")))).toEqual([["a"], ["1"]])
  })
})
