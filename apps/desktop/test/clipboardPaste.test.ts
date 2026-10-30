import { EditorState, EditorSelection } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { editorExtensions } from "@omd/engine"
import { afterEach, describe, expect, it, vi } from "vitest"
import { clipboardPasteExtension, pasteFromSystemClipboard, type ClipboardPasteOptions } from "../src/clipboardPaste"
import { pasteBookmarkExtension } from "../src/pasteBookmark"
import type { SystemClipboardReader } from "../src/clipboardPayload"
import type { PasteAssetStore, PasteAssetWrite } from "../src/pasteAssets"

const views: EditorView[] = []
afterEach(() => { for (const view of views.splice(0)) view.destroy() })

function setup(doc = "", selection = EditorSelection.single(0), readOnly = false) {
  let documentId = 1
  let path: string | null = "/tmp/a.md"
  const notices: string[] = []
  const errors: string[] = []
  const options: ClipboardPasteOptions = {
    getTabId: () => 1,
    getDocumentId: () => documentId,
    getDocPath: () => path,
    onError: message => errors.push(message),
    onNotice: message => notices.push(message),
    onConvertingChange: vi.fn(),
  }
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection,
      extensions: [
        editorExtensions(),
        pasteBookmarkExtension,
        EditorState.allowMultipleSelections.of(true),
        readOnly ? EditorState.readOnly.of(true) : [],
        clipboardPasteExtension(options),
      ],
    }),
    parent: document.body.appendChild(document.createElement("div")),
  })
  views.push(view)
  return {
    view, options, notices, errors,
    setDocumentId: (value: number) => { documentId = value },
    setPath: (value: string | null) => { path = value },
  }
}

function reader(html: string | null, text: string): SystemClipboardReader {
  const entries: Record<string, Blob> = {
    "text/plain": new Blob([text], { type: "text/plain" }),
  }
  if (html !== null) entries["text/html"] = new Blob([html], { type: "text/html" })
  const item: ClipboardItem = {
    types: Object.keys(entries),
    presentationStyle: "unspecified",
    getType: vi.fn(async type => entries[type]),
  }
  return { read: vi.fn(async () => [item]), readText: vi.fn(async () => text) }
}

describe("clipboard paste controller", () => {
  it("imports system HTML through the semantic engine planner", async () => {
    const ctx = setup("hello world", EditorSelection.single(6))
    await pasteFromSystemClipboard(ctx.view, reader("<b>XY</b>", "XY"), ctx.options)
    expect(ctx.view.state.doc.toString()).toBe("hello **XY**world")
    expect(ctx.options.onConvertingChange).not.toHaveBeenCalled()
  })

  it("uses exact plain text for multiple selections", async () => {
    const ctx = setup("ab", EditorSelection.create([
      EditorSelection.cursor(0),
      EditorSelection.cursor(2),
    ]))
    await pasteFromSystemClipboard(ctx.view, reader("<b># x</b>", "# x"), ctx.options)
    expect(ctx.view.state.doc.toString()).toBe("# xab# x")
  })

  it("does not read or dispatch in readOnly state", async () => {
    const ctx = setup("locked", EditorSelection.single(0), true)
    const source = reader("<b>x</b>", "x")
    await pasteFromSystemClipboard(ctx.view, source, ctx.options)
    expect(source.read).not.toHaveBeenCalled()
    expect(ctx.view.state.doc.toString()).toBe("locked")
  })

  it("cancels when the document path changes during acquisition", async () => {
    const ctx = setup("")
    let release!: (items: readonly ClipboardItem[]) => void
    const read = new Promise<readonly ClipboardItem[]>(resolve => { release = resolve })
    const source: SystemClipboardReader = { read: vi.fn(() => read), readText: vi.fn(async () => "x") }
    const job = pasteFromSystemClipboard(ctx.view, source, ctx.options)
    ctx.setPath("/tmp/b.md")
    release([])
    await job
    expect(ctx.view.state.doc.toString()).toBe("")
  })

  it("keeps an ordinary plain-only clipboard exact", async () => {
    const ctx = setup("")
    const source = reader(null, "# title")
    await pasteFromSystemClipboard(ctx.view, source, ctx.options)
    expect(ctx.view.state.doc.toString()).toBe("# title")
  })

  it("publishes converting state around a large rich paste", async () => {
    const ctx = setup("")
    await pasteFromSystemClipboard(ctx.view, reader("x".repeat(262_145), "x"), ctx.options)
    expect(ctx.options.onConvertingChange).toHaveBeenNthCalledWith(1, true)
    expect(ctx.options.onConvertingChange).toHaveBeenLastCalledWith(false)
  })

  it("persists embedded data images before dispatch and commits the batch", async () => {
    const store: PasteAssetStore = {
      write: vi.fn(async () => ({
        batchId: "batch-1",
        items: [{ key: "paste-embedded-1", relativePath: "assets/pasted-safe.png" }],
        failures: [],
      })),
      commit: vi.fn(async () => undefined),
      discard: vi.fn(async () => undefined),
    }
    const ctx = setup("")
    ctx.options.assetStore = store
    await pasteFromSystemClipboard(
      ctx.view,
      reader('<img alt="pixel" src="data:image/png;base64,iVBORw0KGgo=">', "pixel"),
      ctx.options,
    )
    expect(store.write).toHaveBeenCalledWith("/tmp/a.md", [{
      key: "paste-embedded-1",
      mime: "image/png",
      base64: "iVBORw0KGgo=",
    }])
    expect(ctx.view.state.doc.toString()).toBe("![pixel](assets/pasted-safe.png)")
    expect(store.commit).toHaveBeenCalledWith("batch-1")
    expect(store.discard).not.toHaveBeenCalled()
  })

  it("keeps multiple clipboard images in one ordered asset batch", async () => {
    const store: PasteAssetStore = {
      write: vi.fn(async (_path: string, assets: readonly PasteAssetWrite[]) => ({
        batchId: "batch-2",
        items: assets.map((asset, index) => ({
          key: asset.key,
          relativePath: `assets/pasted-${index}.png`,
        })),
        failures: [],
      })),
      commit: vi.fn(async () => undefined),
      discard: vi.fn(async () => undefined),
    }
    const item = (byte: number): ClipboardItem => ({
      types: ["image/png"],
      presentationStyle: "unspecified",
      getType: vi.fn(async () => new Blob([new Uint8Array([byte])], { type: "image/png" })),
    })
    const source: SystemClipboardReader = {
      read: vi.fn(async () => [item(1), item(2)]),
      readText: vi.fn(async () => ""),
    }
    const ctx = setup("")
    ctx.options.assetStore = store
    await pasteFromSystemClipboard(ctx.view, source, ctx.options)
    expect(ctx.view.state.doc.toString()).toBe(
      "![](assets/pasted-0.png)\n\n![](assets/pasted-1.png)",
    )
    expect(store.write).toHaveBeenCalledOnce()
    expect(store.commit).toHaveBeenCalledWith("batch-2")
  })
})
