import { describe, expect, it, vi } from "vitest"
import { exportHtml, exportRichHtml } from "../src/export/html"
import { EXPORT_READY_SCRIPT_SHA256 } from "../src/export/readyScript"
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

  it("rejects entity-, percent-, and protocol-relative obfuscation", () => {
    const html = exportHtml(makeState(
      "[a](&#x6a;avascript:alert(1)) [b](%6aavascript:alert(1)) [c](//evil.example)",
    ))
    expect(html).not.toContain("javascript:")
    expect(html).not.toContain("//evil.example")
    expect(html).toContain("<span>a</span>")
    expect(html).toContain("<span>b</span>")
    expect(html).toContain("<span>c</span>")
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

  it("keeps a single-quoted bare anchor id as canonical double quotes", () => {
    const html = exportHtml(makeState("<a id='sec-1'>Section</a>"))
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

describe("export table link policy", () => {
  const GFM_ROW = "| link |\n|---|\n| [click](javascript:alert(1)) |"
  const COMPLEX_TABLE = (anchor: string) =>
    ["<table>", `<tr><td>${anchor}</td></tr>`, "</table>"].join("\n")

  it("rejects a dangerous link inside a GFM cell for both exporters", async () => {
    const sync = exportHtml(makeState(GFM_ROW))
    expect(sync).not.toContain("javascript:")
    expect(sync).toContain("<span>click</span>")

    const rich = await exportRichHtml(makeState(GFM_ROW))
    expect(rich).not.toContain("javascript:")
    expect(rich).toContain("<span>click</span>")
  })

  it("rejects a protocol-relative href inside a Complex Table cell", async () => {
    const doc = COMPLEX_TABLE('<a href="//evil.example">click</a>')
    const sync = exportHtml(makeState(doc))
    expect(sync).not.toContain("//evil.example")
    expect(sync).toContain("<span>click</span>")

    const rich = await exportRichHtml(makeState(doc))
    expect(rich).not.toContain("//evil.example")
    expect(rich).toContain("<span>click</span>")
  })

  it("never turns a dangerous Complex Table anchor into an href", async () => {
    // The closed-whitelist parser rejects this block outright, so the whole
    // table stays escaped source: no live anchor may appear either way.
    const doc = COMPLEX_TABLE('<a href="javascript:alert(1)">click</a>')
    const sync = exportHtml(makeState(doc))
    expect(sync).not.toMatch(/href="javascript:/)
    expect(sync).toContain("&lt;a href=")

    const rich = await exportRichHtml(makeState(doc))
    expect(rich).not.toMatch(/href="javascript:/)
    expect(rich).toContain("&lt;a href=")
  })
})

describe("standalone rich export lockdown", () => {
  it("validates image sources before the host resolver and locks the document down", async () => {
    const resolveImageSrc = vi.fn(async (src: string) => `data:image/png;base64,${src}`)
    const html = await exportRichHtml(makeState("![x](javascript:alert(1))"), {
      includeReadyScript: false,
      resolveImageSrc,
    })
    expect(resolveImageSrc).not.toHaveBeenCalled()
    expect(html).not.toContain("javascript:")
    expect(html).toContain("Content-Security-Policy")
    expect(html).not.toContain("<script")
    expect(html).not.toContain("__omdExportReady")
  })

  it("keeps the native ready script and pins it by hash instead of inline script", async () => {
    const html = await exportRichHtml(makeState("hello"))
    expect(html).toContain("__omdExportReady")
    // WKWebView loads this HTML string with no response headers, so the policy
    // must travel in the document itself — hash-pinned, never 'unsafe-inline'.
    expect(html).toContain("Content-Security-Policy")
    expect(html).toContain(`script-src '${EXPORT_READY_SCRIPT_SHA256}'`)
    expect(html).not.toContain("script-src 'unsafe-inline'")
  })

  it("denies every script in the standalone HTML export", async () => {
    const html = await exportRichHtml(makeState("hello"), { includeReadyScript: false })
    expect(html).toContain("script-src 'none'")
    expect(html).not.toContain("<script")
  })

  it("never hands an unsafe local image source to the resolver", async () => {
    const resolveImageSrc = vi.fn(async (src: string) => src)
    const html = await exportRichHtml(makeState("![alt](file:///etc/passwd)"), { resolveImageSrc })
    expect(resolveImageSrc).not.toHaveBeenCalled()
    expect(html).not.toContain("file:///etc/passwd")
  })
})
