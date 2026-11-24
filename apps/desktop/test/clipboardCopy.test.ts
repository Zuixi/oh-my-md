import { afterEach, describe, expect, it, vi } from "vitest"
import type { EditorView } from "@codemirror/view"
import { inVerbatim, isLivePreview, setLivePreview } from "@omd/engine"
import {
  MAX_RICH_COPY_CHARS,
  OMD_INTERNAL_COPY_ATTR,
  isInternalMarkdownCopyHtml,
} from "../src/clipboardCopy"
import { pasteFromSystemClipboard, type ClipboardPasteOptions } from "../src/clipboardPaste"
import type { SystemClipboardReader } from "../src/clipboardPayload"
import { createEditor, type CreateEditorOptions } from "../src/Editor"

const BOLD_LINK = "**bold** and [link](https://example.com)"
const LOSSLESS_SOURCE = "==mark== and [ref][id]\n\n[id]: https://example.com\n\n  indented\n    more"

const teardowns: (() => void)[] = []
afterEach(() => { for (const teardown of teardowns.splice(0)) teardown() })

function options(): ClipboardPasteOptions {
  return {
    getTabId: () => 1,
    getDocumentId: () => 1,
    getDocPath: () => "/tmp/a.md",
    onError: () => {},
    onNotice: () => {},
    onConvertingChange: () => {},
  }
}

/** Mounts the real assembled editor, so the copy extension is wired as shipped. */
function mount(doc: string, overrides: Partial<CreateEditorOptions> = {}) {
  const host = document.body.appendChild(document.createElement("div"))
  const view = createEditor(host, {
    doc,
    tabId: 1,
    documentId: 1,
    getDocPath: () => "/tmp/a.md",
    getDocumentId: () => 1,
    onDocumentUpdate: () => {},
    onError: () => {},
    ...overrides,
  })
  teardowns.push(() => {
    view.destroy()
    host.remove()
  })
  return view
}

function select(view: EditorView, from: number, to: number): void {
  view.dispatch({ selection: { anchor: from, head: to } })
}

/** A clipboard stand-in: `setData` records what the handler wrote. */
function fireClipboard(view: EditorView, type: "copy" | "cut", target: Element = view.contentDOM) {
  const data: Record<string, string> = {}
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, "clipboardData", {
    value: {
      getData: (kind: string) => data[kind] ?? "",
      setData: (kind: string, value: string) => { data[kind] = value },
    },
  })
  target.dispatchEvent(event)
  return { event, data }
}

/** Dispatches a paste carrying the flavors a copy produced. */
function firePaste(view: EditorView, flavors: Readonly<Record<string, string>>): Event {
  const event = new Event("paste", { bubbles: true, cancelable: true })
  Object.defineProperty(event, "clipboardData", {
    value: {
      getData: (kind: string) => flavors[kind] ?? "",
      setData: () => {},
      items: [],
      files: [],
    },
  })
  view.contentDOM.dispatchEvent(event)
  return event
}

function reader(flavors: Readonly<Record<string, string>>): SystemClipboardReader {
  const entries: Record<string, Blob> = {}
  for (const [kind, value] of Object.entries(flavors)) {
    entries[kind] = new Blob([value], { type: kind })
  }
  const item: ClipboardItem = {
    types: Object.keys(entries),
    presentationStyle: "unspecified",
    getType: vi.fn(async (type: string) => entries[type]),
  }
  return { read: vi.fn(async () => [item]), readText: vi.fn(async () => flavors["text/plain"] ?? "") }
}

describe("rich copy in Live Preview", () => {
  it("writes the exact Markdown source plus rendered semantic HTML", () => {
    const view = mount(BOLD_LINK)
    expect(view.state.field(isLivePreview)).toBe(true)
    // Premise: outside verbatim content the rich path applies at all.
    expect(inVerbatim(view.state, 0)).toBe(false)
    select(view, 0, BOLD_LINK.length)

    const { event, data } = fireClipboard(view, "copy")

    expect(event.defaultPrevented).toBe(true)
    expect(data["text/plain"]).toBe(BOLD_LINK)
    const html = data["text/html"]
    expect(html.startsWith(`<div ${OMD_INTERNAL_COPY_ATTR}="1">`)).toBe(true)
    expect(html).toContain("<strong>bold</strong>")
    expect(html).toContain('<a href="https://example.com">link</a>')
    // Body only: a full document shell would leak export CSS and a CSP meta.
    expect(html).not.toContain("<html")
    expect(html).not.toContain("<body>")
    expect(isInternalMarkdownCopyHtml(html)).toBe(true)
  })

  it("drops unsafe link targets from the HTML flavor", () => {
    const doc = "[x](javascript:alert(1))"
    const view = mount(doc)
    select(view, 0, doc.length)

    const { data } = fireClipboard(view, "copy")

    expect(data["text/plain"]).toBe(doc)
    expect(data["text/html"]).not.toContain("javascript:")
    expect(data["text/html"]).toContain("<span>x</span>")
  })

  it("leaves Source mode to the native plain-text copy", () => {
    const view = mount(BOLD_LINK)
    view.dispatch(setLivePreview(false))
    expect(view.state.field(isLivePreview)).toBe(false)
    select(view, 0, BOLD_LINK.length)

    const { event, data } = fireClipboard(view, "copy")

    expect(event.defaultPrevented).toBe(false)
    expect(data).toEqual({})
  })

  it("leaves a selection inside inline code to the native copy", () => {
    // InlineCode, FencedCode, CodeBlock, math and frontmatter all gate on the
    // same verbatim node set; a fence cannot complete its parse under
    // happy-dom, so the code-span case is the one this environment can prove.
    const doc = "use `code` here"
    const view = mount(doc)
    expect(inVerbatim(view.state, 0)).toBe(false)
    expect(inVerbatim(view.state, 5)).toBe(true)
    select(view, 5, 9)

    const { event, data } = fireClipboard(view, "copy")

    expect(event.defaultPrevented).toBe(false)
    expect(data).toEqual({})
  })

  it("does not claim copies originating in a nested editor", () => {
    const view = mount("alpha")
    select(view, 0, 5)
    const nested = document.createElement("div")
    nested.className = "cm-editor"
    view.dom.appendChild(nested)

    const { event, data } = fireClipboard(view, "copy", nested)

    expect(event.defaultPrevented).toBe(false)
    expect(data).toEqual({})
  })

  it("skips an empty selection", () => {
    const view = mount("alpha")
    select(view, 2, 2)

    const { event, data } = fireClipboard(view, "copy")

    expect(event.defaultPrevented).toBe(false)
    expect(data).toEqual({})
  })

  it("keeps a copy over the size cap instant by writing no HTML flavor", () => {
    const doc = "a".repeat(MAX_RICH_COPY_CHARS + 1)
    const view = mount(doc)
    select(view, 0, doc.length)

    const { event, data } = fireClipboard(view, "copy")

    expect(event.defaultPrevented).toBe(false)
    expect(data).toEqual({})
  })
})

describe("rich cut", () => {
  it("writes both flavors and deletes the selection", () => {
    const view = mount(`before\n\n${BOLD_LINK}`)
    const from = view.state.doc.length - BOLD_LINK.length
    select(view, from, view.state.doc.length)

    const { event, data } = fireClipboard(view, "cut")

    expect(event.defaultPrevented).toBe(true)
    expect(data["text/plain"]).toBe(BOLD_LINK)
    expect(isInternalMarkdownCopyHtml(data["text/html"])).toBe(true)
    expect(view.state.doc.toString()).toBe("before\n\n")
    expect(view.state.selection.main.empty).toBe(true)
  })

  it("copies without deleting in a read-only editor", () => {
    const view = mount(BOLD_LINK, { readOnly: true })
    select(view, 0, BOLD_LINK.length)

    const { event, data } = fireClipboard(view, "cut")

    expect(event.defaultPrevented).toBe(true)
    expect(data["text/plain"]).toBe(BOLD_LINK)
    expect(view.state.doc.toString()).toBe(BOLD_LINK)
  })
})

describe("internal copy round trip", () => {
  it("keeps the DOM paste byte-for-byte by dropping the marked HTML flavor", async () => {
    const source = mount(LOSSLESS_SOURCE)
    select(source, 0, LOSSLESS_SOURCE.length)
    const { data } = fireClipboard(source, "copy")
    expect(data["text/plain"]).toBe(LOSSLESS_SOURCE)

    const target = mount("tail")
    expect(inVerbatim(target.state, 0)).toBe(false)
    select(target, 0, 0)
    firePaste(target, data)

    // The marked HTML flavor was dropped, so CodeMirror's own plain-text paste
    // inserts the source verbatim; the SmartPaste path would have normalized
    // `==mark==`, rewritten the reference link and flattened the indentation.
    // (Both paths call preventDefault, so the document is the discriminator.)
    await vi.waitFor(() => {
      expect(target.state.doc.toString()).toBe(`${LOSSLESS_SOURCE}tail`)
    })
  })

  it("uses the exact source bytes when pasting through the async clipboard path", async () => {
    const source = mount(LOSSLESS_SOURCE)
    select(source, 0, LOSSLESS_SOURCE.length)
    const { data } = fireClipboard(source, "copy")

    const target = mount("")
    await pasteFromSystemClipboard(target, reader(data), options())

    // `==mark==`, the reference definition and the indentation all survive: the
    // marked HTML flavor never reaches the HTML→Markdown converter.
    expect(target.state.doc.toString()).toBe(LOSSLESS_SOURCE)
  })

  it("still converts external HTML that carries the same visible text", async () => {
    const view = mount("")
    const event = firePaste(view, { "text/html": "<p><strong>bold</strong></p>", "text/plain": "bold" })

    expect(event.defaultPrevented).toBe(true)
    await vi.waitFor(() => expect(view.state.doc.toString()).toBe("**bold**"))
  })
})
