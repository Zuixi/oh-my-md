import { describe, expect, it, vi } from "vitest"
import { undo } from "@codemirror/commands"
import { RectangleMarker } from "@codemirror/view"
import {
  acceptOrderedListNormalization,
  getPendingOrderedListNormalization,
  isLivePreview,
  rejectOrderedListNormalization,
} from "@omd/engine"
import {
  createEditor,
  documentOutline,
  editorStatus,
  activateLink,
  makeImageResolver,
  resetEditorDocument,
  type CreateEditorOptions,
  type EditorDocumentUpdate,
} from "../src/Editor"
import { NUB_PX, tightSelectionMarkers } from "../src/tightSelection"
import { pastePlainText } from "../src/pastePlainText"

const TAB_ID = 7
const DOCUMENT_ID = 11

function editorOptions(
  onDocumentUpdate: (update: EditorDocumentUpdate) => void,
  doc = "alpha",
): CreateEditorOptions {
  return {
    doc,
    tabId: TAB_ID,
    documentId: DOCUMENT_ID,
    getDocPath: () => null,
    getDocumentId: () => DOCUMENT_ID,
    onDocumentUpdate,
    onError: vi.fn(),
  }
}

/** Lets the engine's queued preview-entry normalization reach the update listener. */
function tick(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

describe("desktop editor lifecycle", () => {
  it("reports bound identity and document changes", () => {
    const onDocumentUpdate = vi.fn()
    const view = createEditor(document.createElement("div"), {
      doc: "alpha", tabId: 7, documentId: 11,
      getDocPath: () => null, getDocumentId: () => 11,
      onDocumentUpdate, onError: vi.fn(),
    })
    view.dispatch({ changes: { from: 5, insert: "!" } })
    expect(onDocumentUpdate).toHaveBeenLastCalledWith(expect.objectContaining({
      tabId: 7, documentId: 11, docChanged: true,
    }))
    // Spec 05a：载荷不携带整文档字符串（每键 rope 展平是 O(doc) 应用层工作）。
    expect("doc" in onDocumentUpdate.mock.calls[0][0]).toBe(false)
    expect(view.state.doc.toString()).toBe("alpha!")
    view.destroy()
  })

  it("ignores selection-only updates when pending is unchanged", () => {
    const onDocumentUpdate = vi.fn()
    const view = createEditor(document.createElement("div"), editorOptions(onDocumentUpdate))
    view.dispatch({ selection: { anchor: 1 } })
    expect(onDocumentUpdate).not.toHaveBeenCalled()
    view.destroy()
  })

  it("reports pending-only state changes without docChanged", async () => {
    const onDocumentUpdate = vi.fn()
    const view = createEditor(
      document.createElement("div"),
      editorOptions(onDocumentUpdate, "1. a\n3. b"),
    )
    await tick()
    const notice = getPendingOrderedListNormalization(view.state)!
    const accepted = acceptOrderedListNormalization(view.state, notice.id)
    if (accepted.kind === "accepted") view.dispatch(accepted.transaction)
    expect(onDocumentUpdate).toHaveBeenLastCalledWith(expect.objectContaining({
      docChanged: false,
      pendingNormalization: null,
    }))
    view.destroy()
  })

  it("keeps reject out of history and preserves user undo", async () => {
    const view = createEditor(document.createElement("div"), editorOptions(vi.fn(), "1. a\n3. b"))
    await tick()
    const notice = getPendingOrderedListNormalization(view.state)!
    const result = rejectOrderedListNormalization(view.state, notice.id)
    if (result.kind === "reverted") view.dispatch(result.transaction)
    view.dispatch({ changes: { from: view.state.doc.length, insert: "\nbody" } })
    expect(undo(view)).toBe(true)
    expect(view.state.doc.toString()).toBe("1. a\n3. b")
    expect(undo(view)).toBe(false)
    view.destroy()
  })

  it("creates a fresh history when a different document is loaded", () => {
    const view = createEditor(document.createElement("div"), {
      doc: "first",
      tabId: 1,
      documentId: 1,
      getDocPath: () => "/tmp/first.md",
      getDocumentId: () => 1,
      onDocumentUpdate: vi.fn(),
      onError: vi.fn(),
    })
    view.dispatch({ changes: { from: 5, insert: " changed" } })

    resetEditorDocument(view, {
      doc: "second",
      tabId: 1,
      documentId: 2,
      getDocPath: () => "/tmp/second.md",
      getDocumentId: () => 2,
      onDocumentUpdate: vi.fn(),
      onError: vi.fn(),
    })

    expect(view.state.doc.toString()).toBe("second")
    expect(undo(view)).toBe(false)
    expect(view.state.doc.toString()).toBe("second")
    view.destroy()
  })

  it("creates a source-mode view when defaultLivePreview is false", () => {
    const view = createEditor(
      document.createElement("div"),
      { ...editorOptions(vi.fn(), "# Title"), defaultLivePreview: false },
    )
    expect(editorStatus(view).mode).toBe("source")
    view.destroy()
  })

  it("reads cursor position, mode, and outline from a view", () => {
    const view = createEditor(
      document.createElement("div"),
      editorOptions(vi.fn(), "# Title\nbeta"),
    )
    view.dispatch({ selection: { anchor: 10 } })

    expect(editorStatus(view)).toEqual({ cursor: "2:3", mode: "live" })
    expect(documentOutline(view).map(item => item.text)).toEqual(["Title"])
    view.destroy()
  })

  it("follows same-document anchor links inside the editor", () => {
    const view = createEditor(
      document.createElement("div"),
      editorOptions(vi.fn(), "# Guide\n\n[Back](#guide)"),
    )
    const link = view.dom.querySelector(".omd-link")
    expect(link).not.toBeNull()
    vi.spyOn(view, "posAtCoords").mockReturnValue(10)
    const event = new MouseEvent("click", { bubbles: true, button: 0 })
    Object.defineProperty(event, "target", { value: link })

    expect(activateLink(view, event)).toBe(true)
    expect(view.state.selection.main.head).toBe(0)
    view.destroy()
  })

  it("opens local markdown hrefs through the host callback", () => {
    const onOpenMarkdownHref = vi.fn()
    const open = vi.spyOn(window, "open").mockReturnValue(null)
    const view = createEditor(
      document.createElement("div"),
      { ...editorOptions(vi.fn(), "[n](a.md)"), onOpenMarkdownHref },
    )
    const link = view.dom.querySelector(".omd-link")
    expect(link).not.toBeNull()
    vi.spyOn(view, "posAtCoords").mockReturnValue(1)
    const event = new MouseEvent("click", { bubbles: true, button: 0 })
    Object.defineProperty(event, "target", { value: link })

    expect(activateLink(view, event)).toBe(true)
    expect(onOpenMarkdownHref).toHaveBeenCalledWith("a.md")
    expect(open).not.toHaveBeenCalled()
    open.mockRestore()
    view.destroy()
  })

  it("opens https links with window.open", () => {
    const onOpenMarkdownHref = vi.fn()
    const open = vi.spyOn(window, "open").mockReturnValue(null)
    const view = createEditor(
      document.createElement("div"),
      { ...editorOptions(vi.fn(), "[n](https://example.com)"), onOpenMarkdownHref },
    )
    const link = view.dom.querySelector(".omd-link")
    expect(link).not.toBeNull()
    vi.spyOn(view, "posAtCoords").mockReturnValue(1)
    const event = new MouseEvent("click", { bubbles: true, button: 0 })
    Object.defineProperty(event, "target", { value: link })

    expect(activateLink(view, event)).toBe(true)
    expect(open).toHaveBeenCalledWith("https://example.com", "_blank", "noopener,noreferrer")
    expect(onOpenMarkdownHref).not.toHaveBeenCalled()
    open.mockRestore()
    view.destroy()
  })

  it("jumps from a footnote reference to its definition and back", () => {
    const doc = "Hi[^a]\n\n[^a]: note"
    const view = createEditor(document.createElement("div"), editorOptions(vi.fn(), doc))
    const mark = view.dom.querySelector(".omd-footnote") ?? document.createElement("span")
    mark.classList.add("omd-footnote")
    const clickAt = (pos: number) => {
      vi.spyOn(view, "posAtCoords").mockReturnValue(pos)
      const event = new MouseEvent("click", { bubbles: true, button: 0 })
      Object.defineProperty(event, "target", { value: mark })
      return activateLink(view, event)
    }

    expect(clickAt(doc.indexOf("[^a]"))).toBe(true)
    expect(view.state.selection.main.head).toBe(doc.indexOf("[^a]:"))
    expect(clickAt(doc.indexOf("[^a]:"))).toBe(true)
    expect(view.state.selection.main.head).toBe(doc.indexOf("[^a]"))
    view.destroy()
  })

  it("forgets the footnote jump after the document is reset", () => {
    const docA = "Hi[^a]\n\n[^a]: note"
    const docB = "Longer intro[^a]\n\n[^a]: other"
    const view = createEditor(document.createElement("div"), editorOptions(vi.fn(), docA))
    const mark = document.createElement("span")
    mark.classList.add("omd-footnote")
    const clickAt = (pos: number) => {
      vi.spyOn(view, "posAtCoords").mockReturnValue(pos)
      const event = new MouseEvent("click", { bubbles: true, button: 0 })
      Object.defineProperty(event, "target", { value: mark })
      return activateLink(view, event)
    }

    expect(clickAt(docA.indexOf("[^a]"))).toBe(true)
    resetEditorDocument(view, editorOptions(vi.fn(), docB))
    const before = view.state.selection.main.head
    expect(clickAt(docB.indexOf("[^a]:"))).toBe(true)
    expect(view.state.doc.toString()).toBe(docB)
    expect(view.state.selection.main.head).toBe(before)
    expect(view.state.selection.main.head).not.toBe(docA.indexOf("[^a]"))
    view.destroy()
  })

  it("binds markdown formatting shortcuts from the engine keymap", () => {
    const view = createEditor(
      document.createElement("div"),
      editorOptions(vi.fn(), "hello world"),
    )
    view.dispatch({ selection: { anchor: 6 } })
    // happy-dom reports a non-mac platform, so CodeMirror maps "Mod" to Ctrl
    // (on a real macOS webview the same bindings fire on ⌘).
    const bold = new KeyboardEvent("keydown", {
      key: "b", ctrlKey: true, bubbles: true, cancelable: true,
    })
    view.contentDOM.dispatchEvent(bold)
    expect(view.state.doc.toString()).toBe("hello **world**")

    const heading = new KeyboardEvent("keydown", {
      key: "2", ctrlKey: true, bubbles: true, cancelable: true,
    })
    view.contentDOM.dispatchEvent(heading)
    expect(view.state.doc.toString()).toBe("## hello **world**")
    view.destroy()
  })

  it("falls back to a neutral status and empty outline without a view", () => {
    expect(editorStatus(null)).toEqual({ cursor: "1:1", mode: "live" })
    expect(documentOutline(null)).toEqual([])
  })

  it("resolves a relative image from the first state of an opened document", () => {
    const convert = vi.fn((path: string) => `asset://${path}`)
    const resolve = makeImageResolver(
      () => "/notes/opened/document.md",
      convert,
    )

    expect(resolve("assets/photo.png")).toBe(
      "asset:///notes/opened/assets/photo.png",
    )
    expect(convert).toHaveBeenCalledWith("/notes/opened/assets/photo.png")
  })

  it("sets spellcheck on the content element", () => {
    const view = createEditor(
      document.createElement("div"),
      { ...editorOptions(vi.fn()), spellcheck: true },
    )
    expect(view.contentDOM.getAttribute("spellcheck")).toBe("true")
    view.destroy()
  })

  it("configures line wrapping on the editor view", () => {
    const view = createEditor(
      document.createElement("div"),
      editorOptions(vi.fn(), "sample text"),
    )
    expect(view.lineWrapping).toBe(true)
    view.destroy()
  })

  it("draws selection through the vendored tight-selection extension, not stock drawSelection", async () => {
    // Stock drawSelection's marker entry point: it fires for every cursor
    // and selection draw, while the vendored layer never calls it.
    const forRange = vi.spyOn(RectangleMarker, "forRange")
    const view = createEditor(
      document.createElement("div"),
      editorOptions(vi.fn(), "alpha\nbeta"),
    )
    // The vendored extension mounts exactly one selection and one cursor
    // layer; re-adding stock drawSelection alongside would mount a second pair.
    expect(view.dom.querySelectorAll(".cm-layer.cm-selectionLayer")).toHaveLength(1)
    expect(view.dom.querySelectorAll(".cm-layer.cm-cursorLayer")).toHaveLength(1)

    // happy-dom has no layout engine, so the geometry path reads a stubbed
    // character grid (8px cells) instead of real coordinates.
    const CHAR_W = 8
    const LINE_H = 20
    const CONTENT_LEFT = 100
    const doc = view.state.doc
    vi.spyOn(view, "coordsAtPos").mockImplementation((pos, side = 1) => {
      const line = doc.lineAt(pos)
      const col = Math.min(pos - line.from, line.length)
      const top = (line.number - 1) * LINE_H
      const row = { top, bottom: top + LINE_H }
      if (side < 0 && col > 0) {
        const left = CONTENT_LEFT + (col - 1) * CHAR_W
        return { left, right: left + CHAR_W, ...row }
      }
      const left = CONTENT_LEFT + col * CHAR_W
      return { left, right: col < line.length ? left + CHAR_W : left, ...row }
    })
    // Wrapped-line resolution is not under test; null keeps whole-line blocks.
    vi.spyOn(view, "posAtCoords").mockReturnValue(null)
    const contentRect = () => new DOMRect(CONTENT_LEFT, 0, 600, 300)
    view.contentDOM.getBoundingClientRect = contentRect
    view.scrollDOM.getBoundingClientRect = contentRect
    // happy-dom reports "" for padding/text-indent styles, which parseInt
    // turns into NaN inside the geometry path; feed it parseable zeros.
    const realComputedStyle = window.getComputedStyle.bind(window)
    const computedStyle = vi.spyOn(window, "getComputedStyle").mockImplementation((elt, pseudo) => {
      const style = realComputedStyle(elt, pseudo)
      if (elt instanceof Element && elt.classList.contains("cm-line")) {
        return new Proxy(style, {
          get(target, prop) {
            return prop === "paddingLeft" || prop === "paddingRight" || prop === "textIndent"
              ? "0px"
              : Reflect.get(target, prop)
          },
        })
      }
      return style
    })

    view.dispatch({ selection: { anchor: 1, head: 10 } })

    const markers = tightSelectionMarkers(view)
    expect(markers).toHaveLength(2)
    // First line "lpha": the highlight stops at the line's text end plus
    // the nub, not at the content right edge (stock drawSelection would
    // run an open line end to the ~600px-wide content box edge).
    expect(markers[0].width).toBe(4 * CHAR_W + NUB_PX)
    // Last line "beta": from the content left edge to the selection end.
    expect(markers[1].width).toBe(4 * CHAR_W)

    // After the layers' measure pass runs, stock drawSelection's marker
    // entry point has still never fired — the assembled editor contains
    // only the vendored selection drawing.
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(forRange).not.toHaveBeenCalled()
    forRange.mockRestore()
    computedStyle.mockRestore()
    view.destroy()
  })

  it("notifies the host when the live/source mode flips via the keymap", () => {
    const onModeChange = vi.fn()
    const view = createEditor(
      document.createElement("div"),
      { ...editorOptions(vi.fn()), onModeChange },
    )
    expect(view.state.field(isLivePreview)).toBe(true)
    view.dispatch({ changes: { from: 4, insert: "!" } })
    // Doc edits must not be reported as a mode flip.
    expect(onModeChange).not.toHaveBeenCalled()

    // happy-dom reports a non-mac platform, so "Mod-e" maps to Ctrl-E
    // (on a real macOS webview the same binding fires on ⌘E).
    const toggle = new KeyboardEvent("keydown", {
      key: "e", ctrlKey: true, bubbles: true, cancelable: true,
    })
    view.contentDOM.dispatchEvent(toggle)
    expect(onModeChange).toHaveBeenCalledWith(false)
    expect(editorStatus(view).mode).toBe("source")

    const toggleBack = new KeyboardEvent("keydown", {
      key: "e", ctrlKey: true, bubbles: true, cancelable: true,
    })
    view.contentDOM.dispatchEvent(toggleBack)
    expect(onModeChange).toHaveBeenCalledWith(true)
    expect(editorStatus(view).mode).toBe("live")
    view.destroy()
  })

  it("inserts the literal clipboard text, replacing the selection", async () => {
    const readText = vi.fn(() => Promise.resolve("**bold**"))
    Object.defineProperty(window.navigator, "clipboard", {
      value: { readText }, configurable: true,
    })
    const view = createEditor(
      document.createElement("div"),
      editorOptions(vi.fn(), "hello"),
    )
    view.dispatch({ selection: { anchor: 5 } })
    await pastePlainText(view)
    expect(view.state.doc.toString()).toBe("hello**bold**")
    view.destroy()
  })

  it("does nothing when the clipboard is empty", async () => {
    const readText = vi.fn(() => Promise.resolve(""))
    Object.defineProperty(window.navigator, "clipboard", {
      value: { readText }, configurable: true,
    })
    const view = createEditor(
      document.createElement("div"),
      editorOptions(vi.fn(), "hello"),
    )
    await pastePlainText(view)
    expect(view.state.doc.toString()).toBe("hello")
    expect(readText).toHaveBeenCalled()
    view.destroy()
  })
})
