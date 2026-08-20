import { describe, expect, it } from "vitest"
import { EditorState } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import {
  convertHtmlToMarkdown,
  htmlPaste,
  htmlPasteToMarkdown,
} from "../src/paste/htmlPaste"

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

describe("htmlPaste caret placement (real EditorView)", () => {
  function makeView(doc: string, selection: { anchor: number; head?: number }) {
    const parent = document.createElement("div")
    document.body.appendChild(parent)
    const view = new EditorView({
      state: EditorState.create({
        doc,
        selection,
        extensions: [htmlPaste()],
      }),
      parent,
    })
    return { view, parent }
  }

  function firePaste(view: EditorView, html: string, text = "") {
    const data = new Map([
      ["text/html", html],
      ["text/plain", text],
      ["text/uri-list", ""],
    ])
    const event = new Event("paste", { cancelable: true, bubbles: true })
    Object.defineProperty(event, "clipboardData", {
      value: {
        getData: (type: string) => data.get(type) ?? "",
        items: [],
      },
    })
    view.contentDOM.dispatchEvent(event)
  }

  // The turndown conversion runs after a dynamic import, so poll for the
  // document to settle instead of sleeping a fixed tick.
  async function waitForInsert(view: EditorView, fragment: string, timeout = 3000) {
    const started = Date.now()
    while (!view.state.doc.toString().includes(fragment)) {
      if (Date.now() - started > timeout) {
        throw new Error(`paste did not insert "${fragment}" within ${timeout}ms`)
      }
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }

  it("places the caret at the end of the inserted markdown", async () => {
    const { view, parent } = makeView("beforeafter", { anchor: 6 })
    firePaste(view, "<p><strong>bold</strong></p>", "bold")

    await waitForInsert(view, "**bold**")
    expect(view.state.doc.toString()).toBe("before**bold**after")
    const caret = 6 + "**bold**".length
    expect(view.state.selection.main.anchor).toBe(caret)
    expect(view.state.selection.main.head).toBe(caret)
    view.destroy()
    parent.remove()
  })

  it("places the caret at the end when the paste replaces a selection", async () => {
    const { view, parent } = makeView("beforeXXXafter", { anchor: 6, head: 9 })
    firePaste(view, "<p><em>it</em></p>", "it")

    await waitForInsert(view, "*it*")
    expect(view.state.doc.toString()).toBe("before*it*after")
    const caret = 6 + "*it*".length
    expect(view.state.selection.main.head).toBe(caret)
    expect(view.state.selection.main.empty).toBe(true)
    view.destroy()
    parent.remove()
  })
})
