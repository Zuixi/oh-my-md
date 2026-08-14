import { describe, expect, it } from "vitest"
import { exportHtml } from "../src/export/html"
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
})
