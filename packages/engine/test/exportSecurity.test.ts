import { describe, expect, it } from "vitest"
import { exportHtml, exportRichHtml } from "../src/export/html"
import { makeState } from "./helpers"

describe("export URL and raw-HTML policy", () => {
  it("drops dangerous link schemes while keeping the label", () => {
    const html = exportHtml(makeState("[click](javascript:alert(1))"))
    expect(html).not.toContain("javascript:")
    expect(html).toContain("<span>click</span>")
  })

  it("keeps safe link schemes and relative paths", () => {
    const html = exportHtml(makeState("[web](https://example.com) [mail](mailto:a@b.example) [rel](./doc.md)"))
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('href="mailto:a@b.example"')
    expect(html).toContain('href="./doc.md"')
  })

  it("escapes raw anchors with extra attributes", () => {
    const html = exportHtml(makeState('<a id="x" href="javascript:alert(1)" onclick="alert(2)">hi</a>'))
    expect(html).not.toMatch(/<a[^>]+onclick/)
    expect(html).not.toContain('href="javascript:')
    expect(html).toContain("&lt;a id=&quot;x&quot;")
  })

  it("keeps a bare anchor id for same-document navigation", () => {
    const html = exportHtml(makeState('<a id="sec-1">Section</a>'))
    expect(html).toContain('<a id="sec-1">')
    expect(html).toContain("</a>")
  })

  it("drops dangerous image sources but keeps the alt text", () => {
    const js = exportHtml(makeState("![alt](javascript:alert(1))"))
    expect(js).not.toContain("javascript:")
    expect(js).toContain("alt")

    const svg = exportHtml(makeState("![alt](data:image/svg+xml;base64,AAAA)"))
    expect(svg).not.toContain("data:image/svg+xml")
  })

  it("keeps raster data images and rejects SVG in rich export", async () => {
    const png = await exportRichHtml(makeState("![alt](data:image/png;base64,AAAA)"))
    expect(png).toContain('src="data:image/png;base64,AAAA"')

    const svg = await exportRichHtml(makeState("![alt](data:image/svg+xml;base64,AAAA)"))
    expect(svg).not.toContain("data:image/svg+xml")
  })

  it("adds a no-script CSP to the standalone HTML export", () => {
    const html = exportHtml(makeState("hello"))
    expect(html).toContain("Content-Security-Policy")
    expect(html).toContain("default-src 'none'")
    expect(html).not.toContain("script-src 'unsafe-inline'")
  })
})
