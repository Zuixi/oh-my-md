import { describe, expect, it, vi } from "vitest"
import { makeState } from "./helpers"

vi.mock("mermaid", () => ({ default: { initialize: vi.fn(), render: vi.fn() } }))
const { exportHtml, exportRichHtml } = await import("../src/export/html")

describe("ordered list start numbers in HTML export", () => {
  it("keeps the first number in the sync and rich exports", async () => {
    expect(exportHtml(makeState("3. three\n4. four"))).toContain('<ol start="3">')
    expect(await exportRichHtml(makeState("3. three\n4. four"))).toContain('<ol start="3">')
  })

  it("leaves lists that start at 1 unchanged", () => {
    expect(exportHtml(makeState("1. one\n2. two"))).toContain("<ol>")
  })
})
