import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { EditorView } from "@codemirror/view"
import App, { type DesktopServices } from "../src/App"
import type { CreateEditorOptions } from "../src/Editor"

vi.mock("@omd/engine", async importOriginal => {
  const actual = await importOriginal<typeof import("@omd/engine")>()
  return {
    ...actual,
    exportHtml: () => "<!doctype html><html>exported</html>",
    collectOutline: () => [],
  }
})

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
    renderApp: (props: { autosaveMs?: number; watchMs?: number } = {}) =>
      render(
        <App
          services={services}
          autosaveMs={props.autosaveMs ?? 0}
          watchMs={props.watchMs ?? 0}
        />,
      ),
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
    harness.renderApp()

    act(() => harness.getOptions().onDocChanged("edited"))

    expect(screen.getByText("untitled •")).toBeTruthy()
  })

  it("clears dirty when undo returns to the loaded document baseline", async () => {
    const harness = makeHarness()
    vi.mocked(harness.services.pickOpenPath).mockResolvedValue("/notes/doc.md")
    vi.mocked(harness.services.readFile).mockResolvedValue("saved")
    harness.renderApp()
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
    harness.renderApp()
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
    harness.renderApp()

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
    harness.renderApp()

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
    harness.renderApp()
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
    harness.renderApp()
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
    harness.renderApp()

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
    harness.renderApp()

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
    harness.renderApp()
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
    harness.renderApp()

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
    harness.renderApp()

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
    harness.renderApp()

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

describe("App product shell", () => {
  it("restores a recovery draft when the user confirms", async () => {
    const harness = makeHarness()
    harness.services.listRecoveries = vi.fn(async () => [
      { key: "untitled_1", label: "untitled_1" },
    ])
    harness.services.readRecovery = vi.fn(async () => "recovered draft")
    harness.services.confirmRestore = vi.fn(() => true)
    harness.renderApp()

    await waitFor(() => expect(harness.editor.reset).toHaveBeenCalledOnce())
    expect(screen.getByText("untitled •")).toBeTruthy()
  })

  it("writes untitled edits only to recovery, not the filesystem", async () => {
    const harness = makeHarness()
    harness.services.writeRecovery = vi.fn(async () => undefined)
    harness.renderApp({ autosaveMs: 20 })
    act(() => harness.getOptions().onDocChanged("draft"))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)) })
    expect(harness.services.writeRecovery).toHaveBeenCalled()
    expect(harness.services.writeFile).not.toHaveBeenCalled()
  })

  it("autosaves a dirty pathed document through the save queue", async () => {
    const harness = makeHarness()
    vi.mocked(harness.services.pickOpenPath).mockResolvedValue("/notes/doc.md")
    vi.mocked(harness.services.readFile).mockResolvedValue("saved")
    harness.renderApp({ autosaveMs: 20 })
    fireEvent.keyDown(window, { key: "o", metaKey: true })
    await waitFor(() => expect(screen.getByText("/notes/doc.md")).toBeTruthy())
    harness.setContents("edited")
    act(() => harness.getOptions().onDocChanged("edited"))
    await waitFor(() => {
      expect(harness.services.writeFile).toHaveBeenCalledWith("/notes/doc.md", "edited")
    })
  })

  it("opens a second tab from the tab bar", async () => {
    const harness = makeHarness()
    harness.renderApp()
    fireEvent.click(screen.getByRole("button", { name: "+" }))
    await waitFor(() => expect(harness.editor.create).toHaveBeenCalledTimes(2))
    expect(screen.getAllByRole("button", { name: /untitled/ }).length).toBeGreaterThan(1)
  })

  it("opens the command palette on Cmd+K and runs a command", async () => {
    const harness = makeHarness()
    harness.renderApp()
    fireEvent.keyDown(window, { key: "k", metaKey: true })
    expect(screen.getByPlaceholderText("Run a command…")).toBeTruthy()
    fireEvent.change(screen.getByPlaceholderText("Run a command…"), {
      target: { value: "theme" },
    })
    fireEvent.keyDown(screen.getByPlaceholderText("Run a command…"), { key: "Enter" })
    expect(document.documentElement.dataset.theme).toBe("dark")
  })

  it("reloads a clean document when the file changes on disk", async () => {
    const harness = makeHarness()
    vi.mocked(harness.services.pickOpenPath).mockResolvedValue("/notes/doc.md")
    vi.mocked(harness.services.readFile)
      .mockResolvedValueOnce("saved")
      .mockResolvedValue("external")
    harness.renderApp({ watchMs: 15 })
    fireEvent.keyDown(window, { key: "o", metaKey: true })
    await waitFor(() => expect(screen.getByText("/notes/doc.md")).toBeTruthy())
    await waitFor(() => expect(harness.editor.reset).toHaveBeenCalledTimes(2))
  })

  it("searches the opened folder and opens a hit in a new tab", async () => {
    const harness = makeHarness()
    harness.services.pickFolder = vi.fn(async () => "/notes")
    harness.services.listDir = vi.fn(async () => [
      { name: "doc.md", path: "/notes/doc.md", is_dir: false },
    ])
    harness.services.searchMarkdown = vi.fn(async () => [
      { path: "/notes/hit.md", line: 2, text: "found it" },
    ])
    vi.mocked(harness.services.readFile).mockResolvedValue("found it")
    harness.renderApp()
    fireEvent.keyDown(window, { key: "k", metaKey: true })
    fireEvent.change(screen.getByPlaceholderText("Run a command…"), {
      target: { value: "Open folder" },
    })
    fireEvent.keyDown(screen.getByPlaceholderText("Run a command…"), { key: "Enter" })
    await waitFor(() => expect(screen.getByText("doc.md")).toBeTruthy())
    fireEvent.keyDown(window, { key: "k", metaKey: true })
    fireEvent.change(screen.getByPlaceholderText("Run a command…"), {
      target: { value: "Search in folder" },
    })
    fireEvent.keyDown(screen.getByPlaceholderText("Run a command…"), { key: "Enter" })
    fireEvent.change(screen.getByPlaceholderText("Find in folder…"), {
      target: { value: "found" },
    })
    await waitFor(() => expect(screen.getByText(/hit.md:2/)).toBeTruthy())
    fireEvent.click(screen.getByText(/hit.md:2/))
    await waitFor(() => expect(harness.services.readFile).toHaveBeenCalledWith("/notes/hit.md"))
  })

  it("shows files and outline sidebars without a chrome export panel", () => {
    const harness = makeHarness()
    harness.renderApp()
    expect(screen.getByText(/Open a folder from the File menu/)).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Open folder" })).toBeNull()
    expect(screen.getByRole("button", { name: "Search" })).toBeTruthy()
    expect(screen.getByText("Outline")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Export HTML" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Export PDF" })).toBeNull()
  })

  it("expands a directory in place without replacing the tree", async () => {
    const harness = makeHarness()
    harness.services.pickFolder = vi.fn(async () => "/notes")
    harness.services.listDir = vi.fn(async (path: string) => {
      if (path === "/notes/drafts") {
        return [{ name: "idea.md", path: "/notes/drafts/idea.md", is_dir: false }]
      }
      return [
        { name: "drafts", path: "/notes/drafts", is_dir: true },
        { name: "readme.md", path: "/notes/readme.md", is_dir: false },
      ]
    })
    harness.renderApp()
    fireEvent.keyDown(window, { key: "k", metaKey: true })
    fireEvent.change(screen.getByPlaceholderText("Run a command…"), {
      target: { value: "Open folder" },
    })
    fireEvent.keyDown(screen.getByPlaceholderText("Run a command…"), { key: "Enter" })
    await waitFor(() => expect(screen.getByText("readme.md")).toBeTruthy())
    fireEvent.click(screen.getByRole("button", { name: "drafts" }))
    await waitFor(() => expect(screen.getByText("idea.md")).toBeTruthy())
    expect(screen.getByText("readme.md")).toBeTruthy()
    expect(screen.queryByRole("button", { name: ".." })).toBeNull()
  })

  it("runs File menu commands including export", async () => {
    const harness = makeHarness()
    let send: ((id: string) => void) | undefined
    harness.services.listenMenu = handler => {
      send = handler
      return () => undefined
    }
    harness.services.pickFolder = vi.fn(async () => "/notes")
    harness.services.listDir = vi.fn(async () => [])
    harness.services.pickExportPath = vi.fn(async () => "/tmp/out.html")
    harness.renderApp()
    act(() => send?.("open-folder"))
    await waitFor(() => expect(harness.services.pickFolder).toHaveBeenCalled())
    act(() => send?.("export-html"))
    await waitFor(() => {
      expect(harness.services.writeFile).toHaveBeenCalledWith(
        "/tmp/out.html",
        "<!doctype html><html>exported</html>",
      )
    })
  })

  it("exports a PNG through native WebView capture", async () => {
    const harness = makeHarness()
    let send: ((id: string) => void) | undefined
    harness.services.listenMenu = handler => {
      send = handler
      return () => undefined
    }
    harness.services.exportPreview = vi.fn(async () => undefined)
    harness.services.pickExportPath = vi.fn(async () => "/tmp/out.png")
    harness.renderApp()
    act(() => send?.("export-image"))
    await waitFor(() => {
      expect(harness.services.pickExportPath).toHaveBeenCalledWith("png")
      expect(harness.services.exportPreview).toHaveBeenCalledWith(
        "<!doctype html><html>exported</html>",
        "/tmp/out.png",
        "png",
      )
    })
  })

  it("exports a PDF through native WebView capture", async () => {
    const harness = makeHarness()
    let send: ((id: string) => void) | undefined
    harness.services.listenMenu = handler => {
      send = handler
      return () => undefined
    }
    harness.services.exportPreview = vi.fn(async () => undefined)
    harness.services.pickExportPath = vi.fn(async () => "/tmp/out.pdf")
    harness.renderApp()
    act(() => send?.("export-pdf"))
    await waitFor(() => {
      expect(harness.services.pickExportPath).toHaveBeenCalledWith("pdf")
      expect(harness.services.exportPreview).toHaveBeenCalledWith(
        "<!doctype html><html>exported</html>",
        "/tmp/out.pdf",
        "pdf",
      )
    })
  })

  it("saves as a new path from the File menu even when a file is already open", async () => {
    const harness = makeHarness()
    let send: ((id: string) => void) | undefined
    harness.services.listenMenu = handler => {
      send = handler
      return () => undefined
    }
    vi.mocked(harness.services.pickOpenPath).mockResolvedValue("/notes/doc.md")
    vi.mocked(harness.services.readFile).mockResolvedValue("saved")
    vi.mocked(harness.services.pickSavePath).mockResolvedValue("/notes/copy.md")
    harness.renderApp()
    fireEvent.keyDown(window, { key: "o", metaKey: true })
    await waitFor(() => expect(screen.getByText("/notes/doc.md")).toBeTruthy())
    act(() => send?.("save-as"))
    await waitFor(() => {
      expect(harness.services.pickSavePath).toHaveBeenCalled()
      expect(harness.services.writeFile).toHaveBeenCalledWith("/notes/copy.md", "saved")
    })
  })

  it("creates and closes tabs from the File menu", async () => {
    const harness = makeHarness()
    let send: ((id: string) => void) | undefined
    harness.services.listenMenu = handler => {
      send = handler
      return () => undefined
    }
    harness.renderApp()
    act(() => send?.("new"))
    await waitFor(() => expect(harness.editor.create).toHaveBeenCalledTimes(2))
    act(() => send?.("close"))
    await waitFor(() => expect(screen.getAllByRole("button", { name: /untitled/ })).toHaveLength(1))
  })

  it("remembers opened files and reopens them from the File menu", async () => {
    const harness = makeHarness()
    let send: ((id: string) => void) | undefined
    harness.services.listenMenu = handler => {
      send = handler
      return () => undefined
    }
    harness.services.setRecentMenu = vi.fn(async () => undefined)
    harness.services.saveRecents = vi.fn()
    vi.mocked(harness.services.pickOpenPath).mockResolvedValue("/notes/doc.md")
    vi.mocked(harness.services.readFile).mockResolvedValue("saved")
    harness.renderApp()
    fireEvent.keyDown(window, { key: "o", metaKey: true })
    await waitFor(() => expect(harness.services.setRecentMenu).toHaveBeenCalledWith(["/notes/doc.md"]))
    fireEvent.click(screen.getByRole("button", { name: "+" }))
    await waitFor(() => expect(harness.editor.create).toHaveBeenCalledTimes(2))
    act(() => send?.("recent:/notes/doc.md"))
    await waitFor(() => expect(screen.getByText("/notes/doc.md")).toBeTruthy())
  })

  it("fills the file tree from the parent folder after opening a file", async () => {
    const harness = makeHarness()
    vi.mocked(harness.services.pickOpenPath).mockResolvedValue("/notes/doc.md")
    vi.mocked(harness.services.readFile).mockResolvedValue("saved")
    harness.services.listDir = vi.fn(async () => [
      { name: "doc.md", path: "/notes/doc.md", is_dir: false },
      { name: "other.md", path: "/notes/other.md", is_dir: false },
    ])
    harness.renderApp()
    fireEvent.keyDown(window, { key: "o", metaKey: true })
    await waitFor(() => expect(screen.getByText("other.md")).toBeTruthy())
    expect(harness.services.listDir).toHaveBeenCalledWith("/notes")
  })

  it("exports HTML through the save service", async () => {
    const harness = makeHarness()
    harness.services.pickExportPath = vi.fn(async () => "/tmp/out.html")
    harness.renderApp()
    fireEvent.keyDown(window, { key: "k", metaKey: true })
    fireEvent.change(screen.getByPlaceholderText("Run a command…"), {
      target: { value: "Export HTML" },
    })
    fireEvent.keyDown(screen.getByPlaceholderText("Run a command…"), { key: "Enter" })
    await waitFor(() => {
      expect(harness.services.writeFile).toHaveBeenCalledWith(
        "/tmp/out.html",
        "<!doctype html><html>exported</html>",
      )
    })
  })

  it("creates a tab with Cmd+N and save-as with Cmd+Shift+S", async () => {
    const harness = makeHarness()
    vi.mocked(harness.services.pickSavePath).mockResolvedValue("/notes/copy.md")
    harness.renderApp()
    fireEvent.keyDown(window, { key: "n", metaKey: true })
    await waitFor(() => expect(harness.editor.create).toHaveBeenCalledTimes(2))
    fireEvent.keyDown(window, { key: "s", metaKey: true, shiftKey: true })
    await waitFor(() => expect(harness.services.pickSavePath).toHaveBeenCalled())
  })
})
