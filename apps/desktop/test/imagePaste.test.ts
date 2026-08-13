import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { EditorView } from "@codemirror/view"
import { pasteImage, type ImagePasteOptions } from "../src/imagePaste"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function makeView() {
  let doc = { marker: "initial" }
  let selection = { from: 2, to: 4 }
  const dispatch = vi.fn()
  const view = {
    get state() {
      return {
        doc,
        selection: { main: selection },
      }
    },
    dispatch,
  } as unknown as EditorView

  return {
    view,
    dispatch,
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

    expect(options.onError).toHaveBeenCalledWith("Save the file before pasting an image")
    expect(options.readFile).not.toHaveBeenCalled()
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

    expect(options.onError).toHaveBeenCalledWith("Image paste failed: reader failed")
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

    expect(options.onError).toHaveBeenCalledWith("Image paste failed: disk full")
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
      "Document changed before the image could be pasted",
    )
  })
})
