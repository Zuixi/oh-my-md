import { describe, expect, it } from "vitest"
import { convertHtmlToMarkdown, htmlPasteToMarkdown } from "../src/paste/htmlPaste"

function clipboard(html: string, text = "") {
  const data = new Map([
    ["text/html", html],
    ["text/plain", text],
  ])
  return { getData: (type: string) => data.get(type) ?? "" }
}

describe("convertHtmlToMarkdown", () => {
  it("converts headings, emphasis, and links", async () => {
    const markdown = await convertHtmlToMarkdown(
      "<h1>Title</h1><p><strong>bold</strong> and <em>it</em> <a href=\"https://example.com\">link</a></p>",
    )
    expect(markdown).toContain("# Title")
    expect(markdown).toContain("**bold**")
    expect(markdown).toContain("*it*")
    expect(markdown).toContain("[link](https://example.com)")
  })

  it("converts gfm tables to pipe syntax", async () => {
    const markdown = await convertHtmlToMarkdown(
      "<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>",
    )
    expect(markdown).toContain("| a |")
    expect(markdown).toContain("| 1 |")
  })

  it("converts strikethrough", async () => {
    const markdown = await convertHtmlToMarkdown("<p><del>gone</del></p>")
    expect(markdown).toContain("~~gone~~")
  })

  it("converts pre blocks to fenced code", async () => {
    const markdown = await convertHtmlToMarkdown(
      "<pre><code class=\"language-js\">const x = 1</code></pre>",
    )
    expect(markdown).toContain("```js")
    expect(markdown).toContain("const x = 1")
  })

  it("returns empty output for empty input", async () => {
    expect(await convertHtmlToMarkdown("")).toBe("")
    expect(await convertHtmlToMarkdown("   ")).toBe("")
  })
})

describe("htmlPasteToMarkdown heuristics", () => {
  it("returns null without an html flavor", async () => {
    expect(await htmlPasteToMarkdown(clipboard("", "text"))).toBeNull()
  })

  it("keeps plain-text behavior when the conversion adds nothing", async () => {
    expect(await htmlPasteToMarkdown(clipboard("<p class='x'>plain words</p>", "plain words"))).toBeNull()
  })

  it("returns markdown when formatting survives the conversion", async () => {
    expect(await htmlPasteToMarkdown(clipboard("<p><strong>bold</strong></p>", "bold")))
      .toContain("**bold**")
  })
})
