import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { EditorView } from "@codemirror/view"
import App, { type DesktopServices } from "../src/App"
import type { CreateEditorOptions } from "../src/Editor"

const { editor } = vi.hoisted(() => ({
  editor: {
    create: vi.fn(),
    reset: vi.fn(),
  },
}))

vi.mock("../src/Editor", () => ({
  createEditor: (parent: HTMLElement, options: CreateEditorOptions) =>
    editor.create(parent, options),
  resetEditorDocument: (view: EditorView, options: CreateEditorOptions) =>
    editor.reset(view, options),
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function makeHarness() {
  let contents = ""
  let options: CreateEditorOptions | null = null
  const view = {
    get state() {
      return {
        doc: {
          toString: () => contents,
        },
      }
    },
    destroy: vi.fn(),
  } as unknown as EditorView

  editor.create.mockReset()
  editor.reset.mockReset()
  editor.create.mockImplementation((_parent, nextOptions) => {
    options = nextOptions
    contents = nextOptions.doc
    return view
  })
  editor.reset.mockImplementation((_view, nextOptions) => {
    options = nextOptions
    contents = nextOptions.doc
  })

  const services: DesktopServices = {
    pickOpenPath: vi.fn(async () => null),
    pickSavePath: vi.fn(async () => null),
    readFile: vi.fn(async () => ""),
    writeFile: vi.fn(async () => undefined),
    allowDocumentAssets: vi.fn(async () => undefined),
    confirmDiscard: vi.fn(() => true),
    reportError: vi.fn(),
  }

  return {
    editor,
    services,
    getOptions: () => {
      if (!options) throw new Error("editor was not created")
      return options
    },
    setContents: (value: string) => {
      contents = value
    },
  }
}

describe("App document session", () => {
  it("marks dirty from a CodeMirror document transaction callback", async () => {
    const harness = makeHarness()
    render(<App services={harness.services} />)

    act(() => harness.getOptions().onDocChanged("edited"))

    expect(screen.getByText("untitled •")).toBeTruthy()
  })

  it("clears dirty when undo returns to the loaded document baseline", async () => {
    const harness = makeHarness()
    vi.mocked(harness.services.pickOpenPath).mockResolvedValue("/notes/doc.md")
    vi.mocked(harness.services.readFile).mockResolvedValue("saved")
    render(<App services={harness.services} />)
    fireEvent.keyDown(window, { key: "o", metaKey: true })
    await waitFor(() => expect(screen.getByText("/notes/doc.md")).toBeTruthy())
    expect(harness.services.allowDocumentAssets).toHaveBeenCalledWith("/notes/doc.md")

    act(() => harness.getOptions().onDocChanged("edited"))
    expect(screen.getByText("/notes/doc.md •")).toBeTruthy()
    act(() => harness.getOptions().onDocChanged("saved"))

    expect(screen.getByText("/notes/doc.md")).toBeTruthy()
  })

  it("does not open or alter a dirty document when discard is cancelled", async () => {
    const harness = makeHarness()
    vi.mocked(harness.services.confirmDiscard).mockReturnValue(false)
    render(<App services={harness.services} />)
    act(() => harness.getOptions().onDocChanged("edited"))

    fireEvent.keyDown(window, { key: "o", metaKey: true })

    await waitFor(() => {
      expect(harness.services.confirmDiscard).toHaveBeenCalledOnce()
    })
    expect(harness.services.pickOpenPath).not.toHaveBeenCalled()
    expect(harness.editor.reset).not.toHaveBeenCalled()
    expect(screen.getByText("untitled •")).toBeTruthy()
  })

  it("ignores an older open response and primes the new image resolver path", async () => {
    const harness = makeHarness()
    const firstRead = deferred<string>()
    vi.mocked(harness.services.pickOpenPath)
      .mockResolvedValueOnce("/notes/old.md")
      .mockResolvedValueOnce("/notes/new.md")
    vi.mocked(harness.services.readFile)
      .mockReturnValueOnce(firstRead.promise)
      .mockResolvedValueOnce("new")
    render(<App services={harness.services} />)

    fireEvent.keyDown(window, { key: "o", metaKey: true })
    await waitFor(() => expect(harness.services.readFile).toHaveBeenCalledTimes(1))
    fireEvent.keyDown(window, { key: "o", metaKey: true })

    await waitFor(() => expect(harness.editor.reset).toHaveBeenCalledOnce())
    expect(harness.getOptions().getDocPath()).toBe("/notes/new.md")
    expect(screen.getByText("/notes/new.md")).toBeTruthy()

    fireEvent.keyDown(window, { key: "s", metaKey: true })
    await waitFor(() => expect(harness.services.writeFile).toHaveBeenCalledOnce())

    firstRead.resolve("old")
    await act(async () => firstRead.promise)
    expect(harness.editor.reset).toHaveBeenCalledOnce()
    expect(screen.getByText("/notes/new.md")).toBeTruthy()
  })

  it("keeps dirty when editing continues while a captured snapshot saves", async () => {
    const harness = makeHarness()
    vi.mocked(harness.services.pickOpenPath).mockResolvedValue("/notes/doc.md")
    vi.mocked(harness.services.readFile).mockResolvedValue("before")
    const write = deferred<void>()
    vi.mocked(harness.services.writeFile).mockReturnValue(write.promise)
    render(<App services={harness.services} />)

    fireEvent.keyDown(window, { key: "o", metaKey: true })
    await waitFor(() => expect(screen.getByText("/notes/doc.md")).toBeTruthy())
    harness.setContents("snapshot")
    act(() => harness.getOptions().onDocChanged("snapshot"))

    fireEvent.keyDown(window, { key: "s", metaKey: true })
    await waitFor(() => {
      expect(harness.services.writeFile).toHaveBeenCalledWith(
        "/notes/doc.md",
        "snapshot",
      )
    })
    harness.setContents("edited during save")
    act(() => harness.getOptions().onDocChanged("edited during save"))
    write.resolve()
    await act(async () => write.promise)

    expect(screen.getByText("/notes/doc.md •")).toBeTruthy()
  })

  it("serializes saves so a newer snapshot is written last", async () => {
    const harness = makeHarness()
    vi.mocked(harness.services.pickOpenPath).mockResolvedValue("/notes/doc.md")
    vi.mocked(harness.services.readFile).mockResolvedValue("saved")
    const firstWrite = deferred<void>()
    const secondWrite = deferred<void>()
    vi.mocked(harness.services.writeFile)
      .mockReturnValueOnce(firstWrite.promise)
      .mockReturnValueOnce(secondWrite.promise)
    render(<App services={harness.services} />)
    fireEvent.keyDown(window, { key: "o", metaKey: true })
    await waitFor(() => expect(screen.getByText("/notes/doc.md")).toBeTruthy())

    harness.setContents("first snapshot")
    act(() => harness.getOptions().onDocChanged("first snapshot"))
    fireEvent.keyDown(window, { key: "s", metaKey: true })
    await waitFor(() => expect(harness.services.writeFile).toHaveBeenCalledTimes(1))

    harness.setContents("second snapshot")
    act(() => harness.getOptions().onDocChanged("second snapshot"))
    fireEvent.keyDown(window, { key: "s", metaKey: true })
    expect(harness.services.writeFile).toHaveBeenCalledTimes(1)

    harness.setContents("first snapshot")
    act(() => harness.getOptions().onDocChanged("first snapshot"))
    firstWrite.resolve()
    await waitFor(() => {
      expect(harness.services.writeFile).toHaveBeenNthCalledWith(
        2,
        "/notes/doc.md",
        "second snapshot",
      )
    })
    secondWrite.resolve()
    await act(async () => secondWrite.promise)
    await waitFor(() => expect(screen.getByText("/notes/doc.md •")).toBeTruthy())
  })

  it("reuses the first path for concurrent Save As requests", async () => {
    const harness = makeHarness()
    const firstWrite = deferred<void>()
    vi.mocked(harness.services.pickSavePath)
      .mockResolvedValueOnce("/notes/first-choice.md")
      .mockResolvedValueOnce("/notes/wrong-second-choice.md")
    vi.mocked(harness.services.writeFile).mockReturnValue(firstWrite.promise)
    render(<App services={harness.services} />)
    harness.setContents("untitled snapshot")

    fireEvent.keyDown(window, { key: "s", metaKey: true })
    fireEvent.keyDown(window, { key: "s", metaKey: true })
    await waitFor(() => expect(harness.services.writeFile).toHaveBeenCalledOnce())
    expect(harness.services.pickSavePath).toHaveBeenCalledOnce()
    firstWrite.resolve()
    await act(async () => firstWrite.promise)

    await waitFor(() => {
      expect(screen.getByText("/notes/first-choice.md")).toBeTruthy()
    })
    expect(harness.services.allowDocumentAssets).toHaveBeenCalledWith(
      "/notes/first-choice.md",
    )
    expect(harness.services.pickSavePath).toHaveBeenCalledOnce()
    await waitFor(() => expect(harness.services.writeFile).toHaveBeenCalledTimes(2))
    expect(harness.services.writeFile).toHaveBeenNthCalledWith(
      2,
      "/notes/first-choice.md",
      "untitled snapshot",
    )
  })

  it("waits for pending saves before opening and reading a path", async () => {
    const harness = makeHarness()
    vi.mocked(harness.services.pickOpenPath).mockResolvedValue("/notes/doc.md")
    vi.mocked(harness.services.readFile).mockResolvedValue("disk snapshot")
    const write = deferred<void>()
    vi.mocked(harness.services.pickSavePath).mockResolvedValue(
      "/notes/saved-before-open.md",
    )
    vi.mocked(harness.services.writeFile).mockReturnValue(write.promise)
    render(<App services={harness.services} />)

    fireEvent.keyDown(window, { key: "s", metaKey: true })
    await waitFor(() => expect(harness.services.writeFile).toHaveBeenCalledOnce())
    fireEvent.keyDown(window, { key: "o", metaKey: true })
    expect(harness.services.pickOpenPath).not.toHaveBeenCalled()

    write.resolve()
    await act(async () => write.promise)
    await waitFor(() => expect(harness.services.pickOpenPath).toHaveBeenCalledOnce())
    await waitFor(() => expect(screen.getByText("/notes/doc.md")).toBeTruthy())
  })

  it("does not start a save while an earlier open is still reading", async () => {
    const harness = makeHarness()
    const read = deferred<string>()
    vi.mocked(harness.services.pickOpenPath).mockResolvedValue("/notes/doc.md")
    vi.mocked(harness.services.readFile).mockReturnValue(read.promise)
    vi.mocked(harness.services.pickSavePath).mockResolvedValue(
      "/notes/should-not-save.md",
    )
    render(<App services={harness.services} />)

    fireEvent.keyDown(window, { key: "o", metaKey: true })
    await waitFor(() => expect(harness.services.readFile).toHaveBeenCalledOnce())
    fireEvent.keyDown(window, { key: "s", metaKey: true })
    await act(async () => Promise.resolve())
    expect(harness.services.pickSavePath).not.toHaveBeenCalled()

    read.resolve("opened")
    await act(async () => read.promise)
    await waitFor(() => expect(screen.getByText("/notes/doc.md")).toBeTruthy())
    expect(harness.services.writeFile).not.toHaveBeenCalled()
  })

  it("keeps the last successful baseline when a newer queued save fails", async () => {
    const harness = makeHarness()
    vi.mocked(harness.services.pickOpenPath).mockResolvedValue("/notes/doc.md")
    vi.mocked(harness.services.readFile).mockResolvedValue("original")
    const firstWrite = deferred<void>()
    vi.mocked(harness.services.writeFile)
      .mockReturnValueOnce(firstWrite.promise)
      .mockRejectedValueOnce(new Error("second save failed"))
    render(<App services={harness.services} />)
    fireEvent.keyDown(window, { key: "o", metaKey: true })
    await waitFor(() => expect(screen.getByText("/notes/doc.md")).toBeTruthy())

    harness.setContents("first")
    act(() => harness.getOptions().onDocChanged("first"))
    fireEvent.keyDown(window, { key: "s", metaKey: true })
    await waitFor(() => expect(harness.services.writeFile).toHaveBeenCalledOnce())
    harness.setContents("second")
    act(() => harness.getOptions().onDocChanged("second"))
    fireEvent.keyDown(window, { key: "s", metaKey: true })
    harness.setContents("first")
    act(() => harness.getOptions().onDocChanged("first"))

    firstWrite.resolve()
    await waitFor(() => {
      expect(harness.services.reportError).toHaveBeenCalledWith(
        "Save failed: second save failed",
      )
    })
    expect(screen.getByText("/notes/doc.md")).toBeTruthy()
  })

  it("waits for an unresolved Save As dialog before opening", async () => {
    const harness = makeHarness()
    const savePath = deferred<string | null>()
    vi.mocked(harness.services.pickSavePath).mockReturnValue(savePath.promise)
    vi.mocked(harness.services.pickOpenPath).mockResolvedValue("/notes/opened.md")
    vi.mocked(harness.services.readFile).mockResolvedValue("opened")
    render(<App services={harness.services} />)

    fireEvent.keyDown(window, { key: "s", metaKey: true })
    await waitFor(() => expect(harness.services.pickSavePath).toHaveBeenCalledOnce())
    fireEvent.keyDown(window, { key: "o", metaKey: true })
    expect(harness.services.pickOpenPath).not.toHaveBeenCalled()
    savePath.resolve(null)
    await act(async () => savePath.promise)

    await waitFor(() => expect(screen.getByText("/notes/opened.md")).toBeTruthy())
    expect(harness.services.writeFile).not.toHaveBeenCalled()
  })

  it("reports Save As dialog failures", async () => {
    const harness = makeHarness()
    vi.mocked(harness.services.pickSavePath).mockRejectedValue(
      new Error("dialog unavailable"),
    )
    render(<App services={harness.services} />)

    fireEvent.keyDown(window, { key: "s", metaKey: true })

    await waitFor(() => {
      expect(harness.services.reportError).toHaveBeenCalledWith(
        "Save failed: dialog unavailable",
      )
    })
  })

  it("rolls back session refs if resetting the editor fails", async () => {
    const harness = makeHarness()
    vi.mocked(harness.services.pickOpenPath).mockResolvedValue("/notes/broken.md")
    vi.mocked(harness.services.readFile).mockResolvedValue("broken")
    vi.mocked(harness.editor.reset).mockImplementation(() => {
      throw new Error("reset failed")
    })
    vi.mocked(harness.services.pickSavePath).mockResolvedValue(null)
    render(<App services={harness.services} />)

    fireEvent.keyDown(window, { key: "o", metaKey: true })
    await waitFor(() => {
      expect(harness.services.reportError).toHaveBeenCalledWith(
        "Open failed: reset failed",
      )
    })
    fireEvent.keyDown(window, { key: "s", metaKey: true })

    await waitFor(() => expect(harness.services.pickSavePath).toHaveBeenCalledOnce())
    expect(harness.services.writeFile).not.toHaveBeenCalled()
  })
})
