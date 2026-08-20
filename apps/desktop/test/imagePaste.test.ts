import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EditorState } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import {
  handleImageDrop,
  imagePasteHandler,
  insertImageFile,
  pasteImage,
  pickAndInsertImage,
  type ImagePasteOptions,
} from "../src/imagePaste"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function makeView(options: { readOnly?: boolean } = {}) {
  let doc = { marker: "initial" }
  let selection = { from: 2, to: 4 }
  const dispatch = vi.fn()
  const posAtCoords = vi.fn(() => 0)
  const view = {
    get state() {
      return {
        doc,
        selection: { main: selection },
        readOnly: options.readOnly ?? false,
      }
    },
    dispatch,
    posAtCoords,
  } as unknown as EditorView

  return {
    view,
    dispatch,
    posAtCoords,
    setSelection: (from: number, to: number) => {
      selection = { from, to }
    },
    changeDocument: () => {
      doc = { marker: "changed" }
    },
  }
}

function makeOptions(
  overrides: Partial<ImagePasteOptions> = {},
): ImagePasteOptions {
  return {
    getDocPath: () => "/notes/doc.md",
    getDocumentId: () => 7,
    onError: vi.fn(),
    readFile: vi.fn(async () => "base64"),
    writeImage: vi.fn(async () => undefined),
    ...overrides,
  }
}

describe("image paste pipeline", () => {
  beforeEach(() => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("uuid" as ReturnType<typeof crypto.randomUUID>)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })
  it("writes the image before inserting Markdown at the captured selection", async () => {
    const { view, dispatch } = makeView()
    const order: string[] = []
    dispatch.mockImplementation(() => {
      order.push("dispatch")
    })
    const options = makeOptions({
      writeImage: vi.fn(async () => {
        order.push("write")
      }),
    })

    await pasteImage(new File(["png"], "clip.png", { type: "image/png" }), view, options)

    expect(options.writeImage).toHaveBeenCalledWith(
      "/notes/assets/pasted-uuid.png",
      "base64",
      "/notes/doc.md",
    )
    expect(dispatch).toHaveBeenCalledWith({
      changes: {
        from: 2,
        to: 4,
        insert: "![](assets/pasted-uuid.png)",
      },
      selection: { anchor: 29 },
      scrollIntoView: true,
    })
    expect(order).toEqual(["write", "dispatch"])
  })

  it.each([
    ["image/png", "png"],
    ["image/jpeg", "jpg"],
    ["image/webp", "webp"],
  ])("maps %s to a safe %s extension", async (mime, extension) => {
    const { view } = makeView()
    const options = makeOptions()

    await pasteImage(new File(["image"], "ignored.bin", { type: mime }), view, options)

    expect(options.writeImage).toHaveBeenCalledWith(
      `/notes/assets/pasted-uuid.${extension}`,
      "base64",
      "/notes/doc.md",
    )
  })

  it("does not paste when the document has no saved path", async () => {
    const { view, dispatch } = makeView()
    const options = makeOptions({ getDocPath: () => null })

    await pasteImage(new File(["png"], "clip.png", { type: "image/png" }), view, options)

    expect(options.onError).toHaveBeenCalledWith("Save the file before inserting an image")
    expect(options.readFile).not.toHaveBeenCalled()
    expect(options.writeImage).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it("writes dropped images and inserts Markdown at the drop position", async () => {
    const { view, dispatch, posAtCoords } = makeView()
    posAtCoords.mockReturnValue(9)
    const options = makeOptions()
    const preventDefault = vi.fn()

    const handled = handleImageDrop(
      {
        clientX: 30,
        clientY: 12,
        dataTransfer: {
          files: [new File(["png"], "drop.png", { type: "image/png" })],
        },
        preventDefault,
      } as unknown as DragEvent,
      view,
      options,
    )

    expect(handled).toBe(true)
    expect(preventDefault).toHaveBeenCalledOnce()
    await vi.waitFor(() => {
      expect(options.writeImage).toHaveBeenCalledWith(
        "/notes/assets/pasted-uuid.png",
        "base64",
        "/notes/doc.md",
      )
      expect(dispatch).toHaveBeenCalledWith({
        changes: {
          from: 9,
          to: 9,
          insert: "![](assets/pasted-uuid.png)",
        },
        selection: { anchor: 36 },
        scrollIntoView: true,
      })
    })
  })

  it("ignores non-image drops without preventing the event", async () => {
    const { view, dispatch, posAtCoords } = makeView()
    posAtCoords.mockReturnValue(9)
    const options = makeOptions()
    const preventDefault = vi.fn()

    const handled = await handleImageDrop(
      {
        clientX: 30,
        clientY: 12,
        dataTransfer: {
          files: [new File(["text"], "notes.txt", { type: "text/plain" })],
        },
        preventDefault,
      } as unknown as DragEvent,
      view,
      options,
    )

    expect(handled).toBe(false)
    expect(preventDefault).not.toHaveBeenCalled()
    expect(options.readFile).not.toHaveBeenCalled()
    expect(options.writeImage).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it("ignores unsupported image drops without preventing the event", async () => {
    const { view, dispatch } = makeView()
    const options = makeOptions()
    const preventDefault = vi.fn()

    const handled = handleImageDrop(
      {
        clientX: 30,
        clientY: 12,
        dataTransfer: {
          files: [new File(["gif"], "clip.gif", { type: "image/gif" })],
        },
        preventDefault,
      } as unknown as DragEvent,
      view,
      options,
    )

    expect(handled).toBe(false)
    expect(preventDefault).not.toHaveBeenCalled()
    expect(options.writeImage).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it("reports an error when inserting into an untitled document", async () => {
    const { view, dispatch } = makeView()
    const options = makeOptions({ getDocPath: () => null })

    await insertImageFile(
      new File(["png"], "clip.png", { type: "image/png" }),
      view,
      options,
      "image/png",
    )

    expect(options.onError).toHaveBeenCalledWith("Save the file before inserting an image")
    expect(options.readFile).not.toHaveBeenCalled()
    expect(options.writeImage).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it("does not open the picker for an untitled document", async () => {
    const { view, dispatch } = makeView()
    const options = makeOptions({ getDocPath: () => null })
    const pick = vi.fn(async () => new File(["png"], "picked.png", { type: "image/png" }))

    await pickAndInsertImage(view, options, pick)

    expect(pick).not.toHaveBeenCalled()
    expect(options.onError).toHaveBeenCalledWith("Save the file before inserting an image")
    expect(options.writeImage).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it("picks an image file and inserts it at the current selection", async () => {
    const { view, dispatch } = makeView()
    const options = makeOptions()
    const pick = vi.fn(async () => new File(["png"], "picked.png", { type: "image/png" }))

    await pickAndInsertImage(view, options, pick)

    expect(pick).toHaveBeenCalledOnce()
    expect(options.writeImage).toHaveBeenCalledWith(
      "/notes/assets/pasted-uuid.png",
      "base64",
      "/notes/doc.md",
    )
    expect(dispatch).toHaveBeenCalledWith({
      changes: {
        from: 2,
        to: 4,
        insert: "![](assets/pasted-uuid.png)",
      },
      selection: { anchor: 29 },
      scrollIntoView: true,
    })
  })

  it("aborts picking if the document changes while the picker is open", async () => {
    const { view, dispatch, changeDocument } = makeView()
    const options = makeOptions()
    const pick = vi.fn(async () => {
      changeDocument()
      return new File(["png"], "picked.png", { type: "image/png" })
    })

    await pickAndInsertImage(view, options, pick)

    expect(options.onError).toHaveBeenCalledWith(
      "Document changed before the image could be inserted",
    )
    expect(options.writeImage).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it("rejects GIF before reading or writing", async () => {
    const { view, dispatch } = makeView()
    const options = makeOptions()

    await pasteImage(new File(["gif"], "clip.gif", { type: "image/gif" }), view, options)

    expect(options.onError).toHaveBeenCalledWith("Unsupported image type: image/gif")
    expect(options.readFile).not.toHaveBeenCalled()
    expect(options.writeImage).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it("rejects an unsupported image MIME before reading or writing", async () => {
    const { view, dispatch } = makeView()
    const options = makeOptions()

    await pasteImage(
      new File(["svg"], "clip.svg", { type: "image/svg+xml" }),
      view,
      options,
    )

    expect(options.onError).toHaveBeenCalledWith("Unsupported image type: image/svg+xml")
    expect(options.readFile).not.toHaveBeenCalled()
    expect(options.writeImage).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it("uses the clipboard MIME when File.type is empty", async () => {
    const { view } = makeView()
    const options = makeOptions()

    await pasteImage(
      new File(["png"], "clipboard-image", { type: "" }),
      view,
      options,
      "image/png",
    )

    expect(options.writeImage).toHaveBeenCalledWith(
      "/notes/assets/pasted-uuid.png",
      "base64",
      "/notes/doc.md",
    )
  })

  it("rejects an oversized image before reading or writing", async () => {
    const { view, dispatch } = makeView()
    const options = makeOptions()
    const oversized = new File(
      [new Uint8Array(10 * 1024 * 1024 + 1)],
      "large.png",
      { type: "image/png" },
    )

    await pasteImage(oversized, view, options)

    expect(options.onError).toHaveBeenCalledWith(
      "Image is too large (maximum 10 MiB)",
    )
    expect(options.readFile).not.toHaveBeenCalled()
    expect(options.writeImage).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it("reports FileReader failures without writing or dispatching", async () => {
    const { view, dispatch } = makeView()
    const options = makeOptions({
      readFile: vi.fn(async () => {
        throw new Error("reader failed")
      }),
    })

    await pasteImage(new File(["png"], "clip.png", { type: "image/png" }), view, options)

    expect(options.onError).toHaveBeenCalledWith("Image insert failed: reader failed")
    expect(options.writeImage).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it("reports write failures without inserting Markdown", async () => {
    const { view, dispatch } = makeView()
    const options = makeOptions({
      writeImage: vi.fn(async () => {
        throw new Error("disk full")
      }),
    })

    await pasteImage(new File(["png"], "clip.png", { type: "image/png" }), view, options)

    expect(options.onError).toHaveBeenCalledWith("Image insert failed: disk full")
    expect(dispatch).not.toHaveBeenCalled()
  })

  it("uses the captured selection if only the cursor moves during the write", async () => {
    const { view, dispatch, setSelection } = makeView()
    const write = deferred<void>()
    const options = makeOptions({
      writeImage: vi.fn(() => write.promise),
    })

    const paste = pasteImage(
      new File(["png"], "clip.png", { type: "image/png" }),
      view,
      options,
    )
    await vi.waitFor(() => expect(options.writeImage).toHaveBeenCalledOnce())
    setSelection(9, 9)
    write.resolve()
    await paste

    expect(dispatch).toHaveBeenCalledWith({
      changes: {
        from: 2,
        to: 4,
        insert: "![](assets/pasted-uuid.png)",
      },
      selection: { anchor: 29 },
      scrollIntoView: true,
    })
  })

  it("does not dispatch after the document path changes", async () => {
    const { view, dispatch } = makeView()
    const write = deferred<void>()
    let path = "/notes/doc.md"
    const options = makeOptions({
      getDocPath: () => path,
      writeImage: vi.fn(() => write.promise),
    })

    const paste = pasteImage(
      new File(["png"], "clip.png", { type: "image/png" }),
      view,
      options,
    )
    await vi.waitFor(() => expect(options.writeImage).toHaveBeenCalledOnce())
    path = "/notes/other.md"
    write.resolve()
    await paste

    expect(dispatch).not.toHaveBeenCalled()
  })

  it("does not dispatch after the document identity changes", async () => {
    const { view, dispatch } = makeView()
    const write = deferred<void>()
    let documentId = 7
    const options = makeOptions({
      getDocumentId: () => documentId,
      writeImage: vi.fn(() => write.promise),
    })

    const paste = pasteImage(
      new File(["png"], "clip.png", { type: "image/png" }),
      view,
      options,
    )
    await vi.waitFor(() => expect(options.writeImage).toHaveBeenCalledOnce())
    documentId = 8
    write.resolve()
    await paste

    expect(dispatch).not.toHaveBeenCalled()
  })

  it("does not dispatch after the captured document is edited", async () => {
    const { view, dispatch, changeDocument } = makeView()
    const write = deferred<void>()
    const options = makeOptions({
      writeImage: vi.fn(() => write.promise),
    })

    const paste = pasteImage(
      new File(["png"], "clip.png", { type: "image/png" }),
      view,
      options,
    )
    await vi.waitFor(() => expect(options.writeImage).toHaveBeenCalledOnce())
    changeDocument()
    write.resolve()
    await paste

    expect(dispatch).not.toHaveBeenCalled()
  })

  it("serializes concurrent pastes and rejects a stale second capture before writing", async () => {
    const { view, dispatch, changeDocument } = makeView()
    dispatch.mockImplementation(changeDocument)
    const firstWrite = deferred<void>()
    const writeImage = vi
      .fn<(path: string, base64: string, documentPath: string) => Promise<void>>()
      .mockReturnValueOnce(firstWrite.promise)
      .mockResolvedValueOnce()
    const options = makeOptions({
      writeImage,
    })

    const first = pasteImage(
      new File(["png"], "first.png", { type: "image/png" }),
      view,
      options,
    )
    const second = pasteImage(
      new File(["png"], "second.png", { type: "image/png" }),
      view,
      options,
    )
    await vi.waitFor(() => expect(writeImage).toHaveBeenCalledOnce())
    firstWrite.resolve()
    await Promise.all([first, second])

    expect(writeImage).toHaveBeenCalledOnce()
    expect(options.onError).toHaveBeenCalledWith(
      "Document changed before the image could be inserted",
    )
  })

  it("rejects image paste on a read-only view without reading, writing, or dispatching", async () => {
    // readOnly 是建议性 facet：domEventHandlers 的 paste 先于 CM 内建 readOnly
    // 分支运行，insertImageFile 必须自己挡，且挡在读文件/写资产之前。
    const { view, dispatch } = makeView({ readOnly: true })
    const options = makeOptions()

    await pasteImage(new File(["png"], "clip.png", { type: "image/png" }), view, options)

    expect(options.onError).not.toHaveBeenCalled()
    expect(options.readFile).not.toHaveBeenCalled()
    expect(options.writeImage).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it("prevents image drops on a read-only view without writing assets", async () => {
    const { view, dispatch, posAtCoords } = makeView({ readOnly: true })
    posAtCoords.mockReturnValue(9)
    const options = makeOptions()
    const preventDefault = vi.fn()

    const handled = handleImageDrop(
      {
        clientX: 30,
        clientY: 12,
        dataTransfer: {
          files: [new File(["png"], "drop.png", { type: "image/png" })],
        },
        preventDefault,
      } as unknown as DragEvent,
      view,
      options,
    )

    // 仍拦截事件（first-true-wins，不能放给内建 drop 分支），但不落任何变更。
    expect(handled).toBe(true)
    expect(preventDefault).toHaveBeenCalledOnce()
    // insertImageFile 是 fire-and-forget 且排队在微任务链上：给足排空时间，
    // 「未调用」断言才可信（单个 Promise.resolve 不够）。
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(options.readFile).not.toHaveBeenCalled()
    expect(options.writeImage).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it("does not open the picker for a read-only view", async () => {
    const { view, dispatch } = makeView({ readOnly: true })
    const options = makeOptions()
    const pick = vi.fn(async () => new File(["png"], "picked.png", { type: "image/png" }))

    await pickAndInsertImage(view, options, pick)

    expect(pick).not.toHaveBeenCalled()
    expect(options.writeImage).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })
})

describe("imagePasteHandler contextmenu selection", () => {
  it("dispatches selection to clicked position when right clicking outside selection", () => {
    const parent = document.createElement("div")
    document.body.appendChild(parent)
    const options = makeOptions()
    const view = new EditorView({
      state: EditorState.create({
        doc: "hello world\nsecond line",
        selection: { anchor: 0 },
        extensions: [imagePasteHandler(options)],
      }),
      parent,
    })

    vi.spyOn(view, "posAtCoords").mockReturnValue(6)

    const event = new MouseEvent("contextmenu", { clientX: 100, clientY: 200, bubbles: true })
    view.contentDOM.dispatchEvent(event)

    expect(view.state.selection.main.anchor).toBe(6)
    view.destroy()
    parent.remove()
  })

  it("preserves non-empty selection when right clicking inside it", () => {
    const parent = document.createElement("div")
    document.body.appendChild(parent)
    const options = makeOptions()
    const view = new EditorView({
      state: EditorState.create({
        doc: "hello world\nsecond line",
        selection: { anchor: 2, head: 8 },
        extensions: [imagePasteHandler(options)],
      }),
      parent,
    })

    vi.spyOn(view, "posAtCoords").mockReturnValue(5)

    const event = new MouseEvent("contextmenu", { clientX: 100, clientY: 200, bubbles: true })
    view.dom.dispatchEvent(event)

    expect(view.state.selection.main.from).toBe(2)
    expect(view.state.selection.main.to).toBe(8)
    view.destroy()
    parent.remove()
  })
})

describe("imagePasteHandler context-menu text paste", () => {
  function makePasteView(doc: string, selection: { anchor: number; head?: number }) {
    const parent = document.createElement("div")
    document.body.appendChild(parent)
    const view = new EditorView({
      state: EditorState.create({
        doc,
        selection,
        extensions: [imagePasteHandler(makeOptions())],
      }),
      parent,
    })
    return { view, parent }
  }

  function rightClick(view: EditorView, at: number) {
    vi.spyOn(view, "posAtCoords").mockReturnValue(at)
    view.contentDOM.dispatchEvent(
      new MouseEvent("contextmenu", { clientX: 100, clientY: 200, bubbles: true }),
    )
  }

  function fireTextPaste(view: EditorView, text: string) {
    const event = new Event("paste", { cancelable: true, bubbles: true })
    Object.defineProperty(event, "clipboardData", {
      value: {
        getData: (type: string) => (type === "text/plain" ? text : ""),
        items: [],
      },
    })
    view.contentDOM.dispatchEvent(event)
  }

  it("moves the caret to the end of text pasted at the context-menu target", () => {
    const { view, parent } = makePasteView("hello world", { anchor: 0 })

    rightClick(view, 6)
    fireTextPaste(view, "XY")

    expect(view.state.doc.toString()).toBe("hello XYworld")
    expect(view.state.selection.main.head).toBe(8)
    expect(view.state.selection.main.empty).toBe(true)
    view.destroy()
    parent.remove()
  })

  it("moves the caret to the end when replacing the context-menu selection", () => {
    const { view, parent } = makePasteView("hello world", { anchor: 2, head: 8 })

    rightClick(view, 5)
    fireTextPaste(view, "XY")

    expect(view.state.doc.toString()).toBe("heXYrld")
    expect(view.state.selection.main.head).toBe(4)
    view.destroy()
    parent.remove()
  })

  it("drops the saved target once the selection moves elsewhere", () => {
    const { view, parent } = makePasteView("hello world", { anchor: 0 })

    rightClick(view, 6)
    // User moves the caret (click/keyboard) after the right click, then
    // pastes with the keyboard: the insert must land at the current caret,
    // not at the stale right-click position.
    view.dispatch({ selection: { anchor: 3 } })
    fireTextPaste(view, "XY")

    expect(view.state.doc.toString()).toBe("helXYlo world")
    expect(view.state.selection.main.head).toBe(5)
    view.destroy()
    parent.remove()
  })
})

describe("imagePasteHandler contextmenu platform gating", () => {
  const WINDOWS_WEBVIEW2_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
  const MACOS_WEBKIT_UA =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)"
  const DEFAULT_USER_AGENT = window.navigator.userAgent

  function setUserAgent(userAgent: string): void {
    Object.defineProperty(window.navigator, "userAgent", { value: userAgent, configurable: true })
  }

  afterEach(() => {
    setUserAgent(DEFAULT_USER_AGENT)
  })

  function makeContextMenuView() {
    const parent = document.createElement("div")
    document.body.appendChild(parent)
    const view = new EditorView({
      state: EditorState.create({
        doc: "hello world\nsecond line",
        selection: { anchor: 0 },
        extensions: [imagePasteHandler(makeOptions())],
      }),
      parent,
    })
    vi.spyOn(view, "posAtCoords").mockReturnValue(6)
    return { view, parent }
  }

  it("skips the WebKit selectionchange dispatch on Windows", () => {
    setUserAgent(WINDOWS_WEBVIEW2_UA)
    const { view, parent } = makeContextMenuView()
    const dispatch = vi.spyOn(view, "dispatch")

    const event = new MouseEvent("contextmenu", { clientX: 100, clientY: 200, bubbles: true })
    view.contentDOM.dispatchEvent(event)

    expect(dispatch).not.toHaveBeenCalled()
    expect(view.state.selection.main.anchor).toBe(0)
    view.destroy()
    parent.remove()
  })

  it("keeps the WebKit selectionchange dispatch on macOS", () => {
    setUserAgent(MACOS_WEBKIT_UA)
    const { view, parent } = makeContextMenuView()

    const event = new MouseEvent("contextmenu", { clientX: 100, clientY: 200, bubbles: true })
    view.contentDOM.dispatchEvent(event)

    expect(view.state.selection.main.anchor).toBe(6)
    view.destroy()
    parent.remove()
  })
})
