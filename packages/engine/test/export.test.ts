import { describe, expect, it } from "vitest"
import { exportHtml, exportRichHtml } from "../src/export/html"
import { EXPORT_BODY_CSS } from "../src/export/styles"
import { makeState } from "./helpers"

describe("html export", () => {
  it("projects headings, emphasis, and lists without rewriting the source", () => {
    const doc = "# Hello\n\nThis is **bold** and `code`.\n\n- one\n- two\n"
    const html = exportHtml(makeState(doc))
    expect(html).toContain("<h1>Hello</h1>")
    expect(html).toContain("<strong>bold</strong>")
    expect(html).toContain("<code>code</code>")
    expect(html).toContain("<li>")
    expect(html).toContain("one")
    expect(makeState(doc).doc.toString()).toBe(doc)
  })

  it("projects fenced code and tables", () => {
    const doc = "```js\nconst x = 1\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n"
    const html = exportHtml(makeState(doc))
    expect(html).toContain("<pre><code")
    expect(html).toContain("const x = 1")
    expect(html).toContain("<table>")
    expect(html).toContain("<th>a</th>")
    expect(html).toContain("<td>1</td>")
  })

  it("exports autolinks and same-document anchors as links", () => {
    const html = exportHtml(makeState("# Guide\n\n[GitHub][]\n\n[GitHub]: https://github.com\n\n<a id=\"custom-anchor\"></a>\n\n<https://www.runoob.com> <foo@bar.com> https://example.com foo@example.com\n\n[Back](#guide)"))
    expect(html).toContain('<a href="https://github.com">GitHub</a>')
    expect(html).toContain('<a id="custom-anchor"></a>')
    expect(html).toContain('<a href="https://www.runoob.com">https://www.runoob.com</a>')
    expect(html).toContain('<a href="mailto:foo@bar.com">foo@bar.com</a>')
    expect(html).toContain('<a href="https://example.com">https://example.com</a>')
    expect(html).toContain('<a href="mailto:foo@example.com">foo@example.com</a>')
    expect(html).toContain('<a href="#guide">Back</a>')
  })

  it("exports rich markdown inside table cells", () => {
    const doc = "| **a** | [x](https://e.com) | ~~del~~ |\n|---|---|---|\n| - one | `code` | > q |\n"
    const html = exportHtml(makeState(doc))
    expect(html).toContain("<th><strong>a</strong></th>")
    expect(html).toContain('<th><a href="https://e.com">x</a></th>')
    expect(html).toContain("<th><del>del</del></th>")
    expect(html).toContain("<td><ul><li>one</li></ul></td>")
    expect(html).toContain("<td><code>code</code></td>")
    expect(html).toContain("<td><blockquote>q</blockquote></td>")
  })

  it("includes base typography CSS in sync export", () => {
    const html = exportHtml(makeState("# Hi\n\nbody\n"))
    expect(html).toContain(`<style>${EXPORT_BODY_CSS}</style>`)
  })
})

describe("rich html export", () => {
  it("includes base typography CSS and preserves Shiki dark CSS", async () => {
    const html = await exportRichHtml(makeState("# Hi\n\nbody\n"))
    expect(html).toContain(`<style>${EXPORT_BODY_CSS}</style>`)
    expect(html).toContain("prefers-color-scheme: dark")
  })

  it("injects customCss after the base CSS so user rules win", async () => {
    const custom = ".foo{color:red}"
    const html = await exportRichHtml(makeState("# Hi\n"), { customCss: custom })
    expect(html).toContain(`<style>${EXPORT_BODY_CSS}</style>`)
    expect(html).toContain(`<style>${custom}</style>`)
    expect(html.indexOf(custom)).toBeGreaterThan(html.indexOf(EXPORT_BODY_CSS))
  })

  it("omits customCss style block when not provided", async () => {
    const html = await exportRichHtml(makeState("# Hi\n"))
    expect(html).not.toContain("<style></style>")
  })
})
