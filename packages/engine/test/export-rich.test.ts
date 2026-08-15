import { describe, expect, it, vi, beforeEach } from "vitest"
import { makeState } from "./helpers"

// Mock mermaid so valid diagrams don't stall in happy-dom.
vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: "<svg>mock-mermaid</svg>" }),
  },
}))

// Import after mocks are set up.
const { exportRichHtml } = await import("../src/export/html")

describe("exportRichHtml", () => {
  beforeEach(() => { vi.clearAllMocks() })

  it("sets window.__omdExportReady = true in the script tag", async () => {
    const html = await exportRichHtml(makeState("hello"))
    expect(html).toContain("window.__omdExportReady = true")
  })

  it("renders inline math with KaTeX, not bare <code>$a$</code>", async () => {
    const html = await exportRichHtml(makeState("Here is $a$ inline."))
    // Must contain KaTeX-generated markup (class or style from KaTeX)
    expect(html).toMatch(/katex|<math/)
    // Must NOT be the bare code output from the plain exporter
    expect(html).not.toContain("<code>$a$</code>")
  })

  it("renders block math with KaTeX, not bare <code>", async () => {
    const html = await exportRichHtml(makeState("$$\n\\alpha\n$$"))
    expect(html).toMatch(/katex|<math/)
    expect(html).not.toMatch(/<code>\$\$/)
  })

  it("renders js fenced code with Shiki highlighting (style attributes or span)", async () => {
    const html = await exportRichHtml(makeState("```js\nconst x = 1\n```"))
    // Shiki output has class or inline style attributes
    expect(html).toMatch(/class=|style=/)
    // tokens appear (may be split across spans)
    expect(html).toContain("const")
  })

  it("renders valid mermaid as SVG", async () => {
    const html = await exportRichHtml(makeState("```mermaid\ngraph TD; A-->B\n```"))
    expect(html).toContain("<svg>")
  })

  it("falls back to escaped source for bad mermaid, does not throw", async () => {
    const { default: mermaid } = await import("mermaid")
    vi.mocked(mermaid.render).mockRejectedValueOnce(new Error("parse error"))
    const src = "```mermaid\n!!!invalid syntax!!!\n```"
    const html = await exportRichHtml(makeState(src))
    expect(html).toContain("!!!invalid syntax!!!")
    expect(html).not.toThrow
  })

  it("preserves source document (does not mutate state)", async () => {
    const doc = "# Title\n\n$x^2$\n\n```js\nfoo()\n```\n"
    const state = makeState(doc)
    await exportRichHtml(state)
    expect(state.doc.toString()).toBe(doc)
  })
})
