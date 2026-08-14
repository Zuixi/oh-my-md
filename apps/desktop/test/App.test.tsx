import { act, fireEvent, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { EditorView } from "@codemirror/view"
import {
  getPendingOrderedListNormalization,
  rejectOrderedListNormalization,
} from "@omd/engine"
import type { CreateEditorOptions } from "../src/Editor"
import { createAppHarness, normalizationId, versionFor } from "./appHarness"

vi.mock("@omd/engine", async importOriginal => {
  const actual = await importOriginal<typeof import("@omd/engine")>()
  return {
    ...actual,
    exportHtml: () => "<!doctype html><html>exported</html>",
    collectOutline: () => [],
    getPendingOrderedListNormalization: vi.fn(() => null),
    acceptOrderedListNormalization: vi.fn(() => ({
      kind: "accepted" as const,
      transaction: {},
    })),
    rejectOrderedListNormalization: vi.fn(() => ({
      kind: "reverted" as const,
      transaction: {},
      restoredMarkers: 1,
      skippedMarkers: 0,
    })),
  }
})

const { editor } = vi.hoisted(() => ({
  editor: {
    create: vi.fn(),
    reset: vi.fn(),
  },
}))

vi.mock("../src/Editor", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/Editor")>()
  return {
    ...actual,
    createEditor: (parent: HTMLElement, options: CreateEditorOptions) =>
      editor.create(parent, options),
    resetEditorDocument: (view: EditorView, options: CreateEditorOptions) =>
      editor.reset(view, options),
  }
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function makeAppHarness() {
  return createAppHarness(editor)
}

function edit(harness: ReturnType<typeof makeAppHarness>, tabId: number, doc: string) {
  harness.editorForTab(tabId).emit({ doc, docChanged: true, pendingNormalization: null })
}

/** Lets the recovery write settle, since its failure is handled off the update callback. */
async function editAndSettle(
  harness: ReturnType<typeof makeAppHarness>,
  tabId: number,
  doc: string,
) {
  edit(harness, tabId, doc)
  await act(async () => { await Promise.resolve() })
}

describe("App harness ordered-list fake", () => {
  it("counts every rewritten marker in the pending notice", () => {
    const harness = makeAppHarness()
    harness.renderApp()
    harness.editorForTab(1).setContents("1. a\n3. b\n7. c")

    harness.emitPending(1, normalizationId(1))

    const view = harness.editorForTab(1).view
    expect(view.state.doc.toString()).toBe("1. a\n2. b\n3. c")
    expect(getPendingOrderedListNormalization(view.state)).toEqual({
      id: normalizationId(1),
      markerCount: 2,
    })
  })

  it("refuses list shapes it would renumber differently from the engine", () => {
    const harness = makeAppHarness()
    harness.renderApp()

    harness.editorForTab(1).setContents("0. a\n5. b")
    expect(() => harness.emitPending(1, normalizationId(1))).toThrow(/starting at 0/)

    harness.editorForTab(1).setContents("1. a\n\n3. b")
    expect(() => harness.emitPending(1, normalizationId(1))).toThrow(/blank line/)
  })
})

describe("App normalization wiring", () => {
  it("keeps one live region mounted before any notice appears", () => {
    const harness = makeAppHarness()
    harness.renderApp()

    const region = screen.getByRole("status")
    expect(region.textContent).toBe("")

    harness.editorForTab(1).setContents("1. a\n3. b")
    harness.emitPending(1, normalizationId(1))

    expect(screen.getByRole("status")).toBe(region)
    expect(region.textContent).toContain("1 item was renumbered.")
  })

  it("routes background pending to its bound tab", async () => {
    const harness = makeAppHarness()
    harness.renderApp()
    await harness.openInNewTab("/notes/b.md", "1. a\n3. b")
    harness.activateTab(1)

    harness.editorForTab(2).emit({
      doc: "1. a\n2. b",
      docChanged: true,
      pendingNormalization: { id: normalizationId(1), markerCount: 1 },
    })

    expect(screen.queryByRole("button", { name: "Save normalization" })).toBeNull()
    const active = document.querySelectorAll(".tabbar .tab.is-active")
    expect(active).toHaveLength(1)
    expect(active[0]?.textContent).toContain("untitled")
    harness.activateTab(2)
    expect(screen.getByRole("status").textContent).toContain("1")
  })

  it("ignores an update stamped with a replaced documentId", async () => {
    const harness = makeAppHarness()
    harness.renderApp()
    const stale = harness.editorForTab(1).getOptions()
    await harness.openIntoActive("/notes/fresh.md", "fresh")

    act(() => stale.onDocumentUpdate({
      tabId: 1,
      documentId: stale.documentId,
      doc: "zombie",
      docChanged: true,
      pendingNormalization: { id: normalizationId(9), markerCount: 3 },
    }))

    expect(screen.queryByRole("button", { name: "Save normalization" })).toBeNull()
    expect(screen.getByText("/notes/fresh.md")).toBeTruthy()
    expect(harness.services.writeRecovery).not.toHaveBeenCalled()
  })

  it("does not write recovery for a pending-only update", () => {
    const harness = makeAppHarness()
    harness.renderApp()
    harness.editorForTab(1).emit({
      doc: "",
      docChanged: false,
      pendingNormalization: { id: normalizationId(1), markerCount: 1 },
    })
    expect(harness.services.writeRecovery).not.toHaveBeenCalled()
  })

  it("commits bumped documentId before resetting an active view", async () => {
    const harness = makeAppHarness()
    harness.renderApp()
    const before = harness.editorForTab(1).getOptions().documentId
    const identityDuringReset: number[] = []
    const rebind = editor.reset.getMockImplementation()
    editor.reset.mockImplementationOnce((view: EditorView, options: CreateEditorOptions) => {
      identityDuringReset.push(options.getDocumentId())
      rebind?.(view, options)
    })

    await harness.requestOpen("/notes/new.md", "1. a\n3. b")

    expect(identityDuringReset).toEqual([before + 1])
  })

  it("binds reset options to the bumped document identity", async () => {
    const harness = makeAppHarness()
    harness.renderApp()
    const before = harness.editorForTab(1).getOptions().documentId
    await harness.requestOpen("/notes/new.md", "1. a\n3. b")
    expect(harness.editorForTab(1).getOptions().documentId).toBe(before + 1)
  })

  it("keeps path and document identity bound to a background tab", async () => {
    const harness = makeAppHarness()
    harness.renderApp()
    await harness.openInNewTab("/notes/background.md", "body")

    const options = harness.editorForTab(2).getOptions()
    harness.activateTab(1)

    expect(options.getDocPath()).toBe("/notes/background.md")
    expect(options.getDocumentId()).toBe(options.documentId)
  })

  it("clears old projection before open, external reload, and draft restore", async () => {
    const harness = makeAppHarness()
    const read = deferred<string>()
    harness.services.listRecoveries = vi.fn(async () => [
      { key: "untitled_1", label: "untitled_1" },
    ])
    harness.services.readRecovery = vi.fn(() => read.promise)
    harness.services.confirmRestore = vi.fn(() => true)
    harness.renderApp()

    harness.editorForTab(1).setContents("1. a\n3. b")
    harness.emitPending(1, normalizationId(1))
    expect(screen.getByRole("button", { name: "Save normalization" })).toBeTruthy()
    read.resolve("restored draft")
    await act(async () => { await read.promise })
    expect(screen.queryByRole("button", { name: "Save normalization" })).toBeNull()

    harness.editorForTab(1).setContents("1. a\n3. b")
    harness.emitPending(1, normalizationId(2))
    expect(screen.getByRole("button", { name: "Save normalization" })).toBeTruthy()
    await harness.openIntoActive("/notes/one.md", "1. a\n3. b")
    expect(screen.queryByRole("button", { name: "Save normalization" })).toBeNull()

    harness.emitPending(1, normalizationId(3))
    expect(screen.getByRole("button", { name: "Save normalization" })).toBeTruthy()
    vi.mocked(harness.services.readFile).mockResolvedValueOnce("disk version")
    await harness.runExternalCheck()
    expect(screen.queryByRole("button", { name: "Save normalization" })).toBeNull()
  })

  it("removes a closed tab projection before reusing the workspace", async () => {
    const harness = makeAppHarness()
    harness.renderApp()
    await harness.openInNewTab("/notes/b.md", "1. a\n3. b")
    harness.emitPending(2, normalizationId(1))
    harness.requestCloseTab(2)
    await harness.openInNewTab("/notes/c.md", "body")
    expect(screen.queryByRole("button", { name: "Save normalization" })).toBeNull()
  })

  it("confirms before closing a pending-only dirty tab", async () => {
    const harness = makeAppHarness()
    harness.renderApp()
    await harness.openIntoActive("/notes/a.md", "1. a\n3. b")
    harness.emitPending(1, normalizationId(1))
    harness.requestCloseTab(1)
    expect(harness.services.confirmClose).toHaveBeenCalledOnce()
  })

  it("restores session identity and projection when reset throws", async () => {
    const harness = makeAppHarness()
    harness.renderApp()
    harness.failNextReset(new Error("reset failed"))

    await harness.requestOpen("/notes/new.md", "1. a\n3. b")

    // Scoped to the status bar: an untitled tab button carries the same text.
    expect(screen.getByText("untitled", { selector: ".statusbar span" })).toBeTruthy()
    harness.editorForTab(1).emit({
      doc: "still editable",
      docChanged: true,
      pendingNormalization: null,
    })
    expect(screen.getByText("untitled •")).toBeTruthy()
  })

  it("restores the old projection when reset throws", async () => {
    const harness = makeAppHarness()
    harness.renderApp()
    harness.editorForTab(1).setContents("1. a\n3. b")
    harness.emitPending(1, normalizationId(1))
    harness.failNextReset(new Error("reset failed"))

    await harness.requestOpen("/notes/new.md", "body")

    expect(screen.getByRole("button", { name: "Save normalization" })).toBeTruthy()
    expect(screen.getByText("untitled •")).toBeTruthy()
  })
})

describe("App normalization autosave and accept/reject", () => {
  it("cancels autosave when pending arrives", async () => {
    const harness = makeAppHarness()
    harness.renderApp({ autosaveMs: 100 })
    await harness.openIntoActive("/notes/a.md", "saved")
    vi.useFakeTimers()
    try {
      harness.editorForTab(1).emit({
        doc: "edited", docChanged: true, pendingNormalization: null,
      })
      harness.editorForTab(1).emit({
        doc: "edited", docChanged: false,
        pendingNormalization: { id: normalizationId(1), markerCount: 1 },
      })
      await vi.advanceTimersByTimeAsync(100)
      expect(harness.services.writeFile).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it("does not autosave a pending normalization", async () => {
    const harness = makeAppHarness()
    harness.renderApp({ autosaveMs: 100 })
    await harness.openIntoActive("/notes/a.md", "1. a\n3. b")
    vi.useFakeTimers()
    try {
      harness.editorForTab(1).emit({
        doc: "1. a\n2. b",
        docChanged: true,
        pendingNormalization: { id: normalizationId(1), markerCount: 1 },
      })
      await vi.advanceTimersByTimeAsync(100)
      expect(harness.services.writeFile).not.toHaveBeenCalled()
      expect(harness.services.writeRecovery).toHaveBeenCalledWith(
        expect.any(String),
        "1. a\n2. b",
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it("accepts two pending tabs independently", async () => {
    const harness = makeAppHarness()
    harness.renderApp()
    await harness.openIntoActive("/notes/a.md", "1. a\n3. b")
    await harness.openInNewTab("/notes/b.md", "1. x\n4. y")
    harness.emitPending(1, normalizationId(1))
    harness.emitPending(2, normalizationId(2))
    await harness.saveNormalization(1)
    await harness.saveNormalization(2)
    expect(harness.editorForTab(1).view.dispatch).toHaveBeenCalledOnce()
    expect(harness.editorForTab(2).view.dispatch).toHaveBeenCalledOnce()
  })

  it("updates only the captured tab after switching during save", async () => {
    const write = deferred<void>()
    const harness = makeAppHarness()
    vi.mocked(harness.services.writeFile).mockReturnValueOnce(write.promise)
    harness.renderApp()
    await harness.openIntoActive("/notes/a.md", "1. a\n3. b")
    await harness.openInNewTab("/notes/b.md", "body")
    harness.emitPending(1, normalizationId(1))
    const saving = harness.saveNormalization(1)
    harness.activateTab(2)
    write.resolve()
    await saving
    expect(harness.editorForTab(1).view.dispatch).toHaveBeenCalledOnce()
    expect(harness.editorForTab(2).view.dispatch).not.toHaveBeenCalled()
  })

  it("keeps edits made after the saved snapshot dirty", async () => {
    const write = deferred<void>()
    const harness = makeAppHarness()
    vi.mocked(harness.services.writeFile).mockReturnValueOnce(write.promise)
    harness.renderApp()
    await harness.openIntoActive("/notes/a.md", "1. a\n3. b")
    harness.emitPending(1, normalizationId(1))
    const saving = harness.saveNormalization(1)
    harness.editorForTab(1).emit({
      doc: "1. a\n2. b\nlater",
      docChanged: true,
      pendingNormalization: { id: normalizationId(1), markerCount: 1 },
    })
    write.resolve()
    await saving
    expect(screen.getByText("/notes/a.md •")).toBeTruthy()
  })

  it("resyncs idle without accept when the notice id changes during save", async () => {
    const write = deferred<void>()
    const harness = makeAppHarness()
    vi.mocked(harness.services.writeFile).mockReturnValueOnce(write.promise)
    harness.renderApp()
    await harness.openIntoActive("/notes/a.md", "1. a\n3. b")
    harness.emitPending(1, normalizationId(1))
    const saving = harness.saveNormalization(1)
    harness.editorForTab(1).emit({
      doc: "1. a\n2. b",
      docChanged: false,
      pendingNormalization: { id: normalizationId(2), markerCount: 1 },
    })
    write.resolve()
    await saving
    expect(harness.editorForTab(1).view.dispatch).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "Save normalization" })).toBeTruthy()
  })

  it("does not accept when document identity changes during explicit save", async () => {
    let releaseWrite!: () => void
    const writeGate = new Promise<void>(resolve => { releaseWrite = resolve })
    const harness = makeAppHarness()
    vi.mocked(harness.services.writeFile).mockImplementationOnce(() => writeGate)
    harness.renderApp()
    await harness.openIntoActive("/notes/a.md", "1. a\n3. b")
    harness.emitPending(1, normalizationId(1))
    void harness.saveNormalization(1)
    await waitFor(() => expect(harness.services.writeFile).toHaveBeenCalledOnce())
    vi.mocked(harness.services.readFile).mockResolvedValueOnce("disk version")
    vi.mocked(harness.services.confirmExternalChange).mockReturnValueOnce(true)
    await harness.runExternalCheck()
    releaseWrite()
    await act(async () => { await Promise.resolve() })
    expect(harness.editorForTab(1).view.dispatch).not.toHaveBeenCalled()
    expect(screen.queryByRole("button", { name: "Save normalization" })).toBeNull()
  })

  it("keeps pending idle when Save As is cancelled", async () => {
    const harness = makeAppHarness()
    vi.mocked(harness.services.pickSavePath).mockResolvedValueOnce(null)
    harness.renderApp()
    harness.emitPending(1, normalizationId(1))
    await harness.saveNormalization(1)
    expect(harness.services.writeFile).not.toHaveBeenCalled()
    expect(harness.services.reportError).not.toHaveBeenCalled()
    expect((screen.getByRole("button", { name: "Save normalization" }) as HTMLButtonElement).disabled).toBe(false)
  })

  it("rejects on the captured view and restores focus", async () => {
    const harness = makeAppHarness()
    harness.renderApp()
    await harness.openIntoActive("/notes/a.md", "1. a\n3. b")
    harness.emitPending(1, normalizationId(1))
    vi.mocked(rejectOrderedListNormalization).mockReturnValue({
      kind: "reverted",
      transaction: { changes: { from: 5, to: 7, insert: "3." } },
      restoredMarkers: 1,
      skippedMarkers: 0,
    })
    fireEvent.click(screen.getByRole("button", { name: "Keep original numbers" }))
    expect(harness.editorForTab(1).view.dispatch).toHaveBeenCalledOnce()
    expect(harness.editorForTab(1).view.focus).toHaveBeenCalledOnce()
  })

  it("announces skipped source-mode markers without an alert", async () => {
    const harness = makeAppHarness()
    harness.renderApp()
    await harness.openIntoActive("/notes/a.md", "1. a\n3. b")
    harness.emitPending(1, normalizationId(1))
    vi.mocked(rejectOrderedListNormalization).mockReturnValue({
      kind: "reverted",
      transaction: {},
      restoredMarkers: 0,
      skippedMarkers: 1,
    })
    fireEvent.click(screen.getByRole("button", { name: "Keep original numbers" }))
    expect(screen.getByText(
      "Original numbers were restored where they were unchanged.",
    )).toBeTruthy()
    expect(harness.services.reportError).not.toHaveBeenCalled()
  })

  it("keeps review pending after save failure", async () => {
    const harness = makeAppHarness()
    vi.mocked(harness.services.writeFile).mockRejectedValueOnce(new Error("disk full"))
    harness.renderApp()
    await harness.openIntoActive("/notes/a.md", "1. a\n3. b")
    harness.emitPending(1, normalizationId(1))
    await harness.saveNormalization(1)
    expect((screen.getByRole("button", { name: "Save normalization" }) as HTMLButtonElement).disabled).toBe(false)
    expect(harness.services.reportError).toHaveBeenCalled()
  })

  it("clears pending when external disk content is loaded", async () => {
    const harness = makeAppHarness()
    harness.renderApp()
    await harness.openIntoActive("/notes/a.md", "1. a\n3. b")
    harness.emitPending(1, normalizationId(1))
    vi.mocked(harness.services.readFile).mockResolvedValueOnce("disk version")
    vi.mocked(harness.services.confirmExternalChange).mockReturnValueOnce(true)
    await harness.runExternalCheck()
    expect(screen.queryByRole("button", { name: "Save normalization" })).toBeNull()
    expect(screen.getByText("/notes/a.md")).toBeTruthy()
  })

  it("keeps pending when external disk content is rejected", async () => {
    const harness = makeAppHarness()
    harness.renderApp()
    await harness.openIntoActive("/notes/a.md", "1. a\n3. b")
    harness.emitPending(1, normalizationId(1))
    vi.mocked(harness.services.readFile).mockResolvedValueOnce("disk version")
    vi.mocked(harness.services.confirmExternalChange).mockReturnValueOnce(false)
    await harness.runExternalCheck()
    expect(screen.getByRole("button", { name: "Save normalization" })).toBeTruthy()
  })
})

describe("App document session", () => {
  it("marks dirty from a CodeMirror document transaction callback", async () => {
    const harness = makeAppHarness()
    harness.renderApp()

    edit(harness, 1, "edited")

    expect(screen.getByText("untitled •")).toBeTruthy()
  })

  it("reports a failing recovery write once per tab and keeps editing", async () => {
    const harness = makeAppHarness()
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined)
    vi.mocked(harness.services.writeRecovery).mockRejectedValue(new Error("disk full"))
    harness.renderApp()

    await editAndSettle(harness, 1, "first")
    await editAndSettle(harness, 1, "second")
    await editAndSettle(harness, 1, "one two three")

    expect(harness.services.reportError).toHaveBeenCalledOnce()
    expect(harness.services.reportError).toHaveBeenCalledWith("Recovery write failed: disk full")
    expect(logged).toHaveBeenCalledTimes(2)
    expect(screen.getByText("3 words")).toBeTruthy()
    expect(screen.getByText("untitled •")).toBeTruthy()
    logged.mockRestore()
  })

  it("reports a recovery failure again once a write has succeeded", async () => {
    const harness = makeAppHarness()
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined)
    vi.mocked(harness.services.writeRecovery)
      .mockRejectedValueOnce(new Error("first outage"))
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("second outage"))
    harness.renderApp()

    await editAndSettle(harness, 1, "first")
    await editAndSettle(harness, 1, "second")
    await editAndSettle(harness, 1, "third")

    expect(vi.mocked(harness.services.reportError).mock.calls).toEqual([
      ["Recovery write failed: first outage"],
      ["Recovery write failed: second outage"],
    ])
    expect(logged).not.toHaveBeenCalled()
    logged.mockRestore()
  })

  it("clears dirty when undo returns to the loaded document baseline", async () => {
    const harness = makeAppHarness()
    harness.renderApp()
    await harness.openIntoActive("/notes/doc.md", "saved")
    expect(harness.services.allowDocumentAssets).toHaveBeenCalledWith("/notes/doc.md")

    edit(harness, 1, "edited")
    expect(screen.getByText("/notes/doc.md •")).toBeTruthy()
    edit(harness, 1, "saved")

    expect(screen.getByText("/notes/doc.md")).toBeTruthy()
  })

  it("does not open or alter a dirty document when discard is cancelled", async () => {
    const harness = makeAppHarness()
    vi.mocked(harness.services.confirmDiscard).mockReturnValue(false)
    harness.renderApp()
    edit(harness, 1, "edited")

    fireEvent.keyDown(window, { key: "o", metaKey: true })

    await waitFor(() => {
      expect(harness.services.confirmDiscard).toHaveBeenCalledOnce()
    })
    expect(harness.services.pickOpenPath).not.toHaveBeenCalled()
    expect(editor.reset).not.toHaveBeenCalled()
    expect(screen.getByText("untitled •")).toBeTruthy()
  })

  it("ignores an older open response and primes the new image resolver path", async () => {
    const harness = makeAppHarness()
    const firstRead = deferred<string>()
    vi.mocked(harness.services.pickOpenPath)
      .mockResolvedValueOnce("/notes/old.md")
      .mockResolvedValueOnce("/notes/new.md")
    vi.mocked(harness.services.readFile)
      .mockReturnValueOnce(firstRead.promise)
      .mockImplementationOnce(async path => {
        harness.seedFile(path, "new")
        return "new"
      })
    vi.mocked(harness.services.readDocumentVersion).mockImplementation(async path => {
      const contents = path === "/notes/new.md" ? "new" : undefined
      if (contents === undefined) return { kind: "missing" }
      return { kind: "existing", version: versionFor(path, contents) }
    })
    harness.renderApp()

    fireEvent.keyDown(window, { key: "o", metaKey: true })
    await waitFor(() => expect(harness.services.readFile).toHaveBeenCalledTimes(1))
    fireEvent.keyDown(window, { key: "o", metaKey: true })

    await waitFor(() => expect(editor.reset).toHaveBeenCalledOnce())
    expect(harness.editorForTab(1).getOptions().getDocPath()).toBe("/notes/new.md")
    expect(screen.getByText("/notes/new.md")).toBeTruthy()

    fireEvent.keyDown(window, { key: "s", metaKey: true })
    await waitFor(() => expect(harness.services.writeFile).toHaveBeenCalledOnce())

    firstRead.resolve("old")
    await act(async () => firstRead.promise)
    expect(editor.reset).toHaveBeenCalledOnce()
    expect(screen.getByText("/notes/new.md")).toBeTruthy()
  })

  it("keeps dirty when editing continues while a captured snapshot saves", async () => {
    const harness = makeAppHarness()
    const write = deferred<void>()
    vi.mocked(harness.services.writeFile).mockReturnValue(write.promise)
    harness.renderApp()
    await harness.openIntoActive("/notes/doc.md", "before")
    edit(harness, 1, "snapshot")

    fireEvent.keyDown(window, { key: "s", metaKey: true })
    await waitFor(() => {
      expect(harness.services.writeFile).toHaveBeenCalledWith(
        "/notes/doc.md",
        "snapshot",
      )
    })
    edit(harness, 1, "edited during save")
    write.resolve()
    await act(async () => write.promise)

    expect(screen.getByText("/notes/doc.md •")).toBeTruthy()
  })

  it("serializes saves so a newer snapshot is written last", async () => {
    const harness = makeAppHarness()
    const firstWrite = deferred<void>()
    const secondWrite = deferred<void>()
    vi.mocked(harness.services.writeFile)
      .mockReturnValueOnce(firstWrite.promise)
      .mockReturnValueOnce(secondWrite.promise)
    harness.renderApp()
    await harness.openIntoActive("/notes/doc.md", "saved")

    edit(harness, 1, "first snapshot")
    fireEvent.keyDown(window, { key: "s", metaKey: true })
    await waitFor(() => expect(harness.services.writeFile).toHaveBeenCalledTimes(1))

    edit(harness, 1, "second snapshot")
    fireEvent.keyDown(window, { key: "s", metaKey: true })
    expect(harness.services.writeFile).toHaveBeenCalledTimes(1)

    edit(harness, 1, "first snapshot")
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
    const harness = makeAppHarness()
    const firstWrite = deferred<void>()
    vi.mocked(harness.services.pickSavePath)
      .mockResolvedValueOnce("/notes/first-choice.md")
      .mockResolvedValueOnce("/notes/wrong-second-choice.md")
    vi.mocked(harness.services.writeFile).mockImplementation(async (path, contents) => {
      harness.seedFile(path, contents)
      return firstWrite.promise
    })
    harness.renderApp()
    harness.editorForTab(1).setContents("untitled snapshot")

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
    const harness = makeAppHarness()
    harness.seedFile("/notes/doc.md", "disk snapshot")
    vi.mocked(harness.services.pickOpenPath).mockResolvedValue("/notes/doc.md")
    const write = deferred<void>()
    vi.mocked(harness.services.pickSavePath).mockResolvedValue(
      "/notes/saved-before-open.md",
    )
    vi.mocked(harness.services.writeFile).mockImplementation(async (path, contents) => {
      harness.seedFile(path, contents)
      return write.promise
    })
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
    const harness = makeAppHarness()
    const read = deferred<string>()
    vi.mocked(harness.services.pickOpenPath).mockResolvedValue("/notes/doc.md")
    vi.mocked(harness.services.readFile).mockImplementation(async path => {
      const contents = await read.promise
      harness.seedFile(path, contents)
      return contents
    })
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
    const harness = makeAppHarness()
    const firstWrite = deferred<void>()
    vi.mocked(harness.services.writeFile)
      .mockReturnValueOnce(firstWrite.promise)
      .mockRejectedValueOnce(new Error("second save failed"))
    harness.renderApp()
    await harness.openIntoActive("/notes/doc.md", "original")

    edit(harness, 1, "first")
    fireEvent.keyDown(window, { key: "s", metaKey: true })
    await waitFor(() => expect(harness.services.writeFile).toHaveBeenCalledOnce())
    edit(harness, 1, "second")
    fireEvent.keyDown(window, { key: "s", metaKey: true })
    edit(harness, 1, "first")

    firstWrite.resolve()
    await waitFor(() => {
      expect(harness.services.reportError).toHaveBeenCalledWith(
        "Save failed: second save failed",
      )
    })
    expect(screen.getByText("/notes/doc.md")).toBeTruthy()
  })

  it("waits for an unresolved Save As dialog before opening", async () => {
    const harness = makeAppHarness()
    const savePath = deferred<string | null>()
    vi.mocked(harness.services.pickSavePath).mockReturnValue(savePath.promise)
    vi.mocked(harness.services.pickOpenPath).mockResolvedValue("/notes/opened.md")
    harness.seedFile("/notes/opened.md", "opened")
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
    const harness = makeAppHarness()
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
    const harness = makeAppHarness()
    vi.mocked(harness.services.pickSavePath).mockResolvedValue(null)
    harness.renderApp()
    harness.failNextReset(new Error("reset failed"))

    await harness.requestOpen("/notes/broken.md", "broken")
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
    const harness = makeAppHarness()
    harness.services.listRecoveries = vi.fn(async () => [
      { key: "untitled_1", label: "untitled_1" },
    ])
    harness.services.readRecovery = vi.fn(async () => "recovered draft")
    harness.services.confirmRestore = vi.fn(() => true)
    harness.renderApp()

    await waitFor(() => expect(editor.reset).toHaveBeenCalledOnce())
    expect(screen.getByText("untitled •")).toBeTruthy()
  })

  it("writes untitled edits only to recovery, not the filesystem", async () => {
    const harness = makeAppHarness()
    harness.renderApp({ autosaveMs: 20 })
    edit(harness, 1, "draft")
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)) })
    expect(harness.services.writeRecovery).toHaveBeenCalled()
    expect(harness.services.writeFile).not.toHaveBeenCalled()
  })

  it("autosaves a dirty pathed document through the save queue", async () => {
    const harness = makeAppHarness()
    harness.renderApp({ autosaveMs: 20 })
    await harness.openIntoActive("/notes/doc.md", "saved")
    edit(harness, 1, "edited")
    await waitFor(() => {
      expect(harness.services.writeFile).toHaveBeenCalledWith("/notes/doc.md", "edited")
    })
  })

  it("opens a second tab from the tab bar", async () => {
    const harness = makeAppHarness()
    harness.renderApp()
    fireEvent.click(screen.getByRole("button", { name: "+" }))
    await waitFor(() => expect(editor.create).toHaveBeenCalledTimes(2))
    expect(screen.getAllByRole("button", { name: /untitled/ }).length).toBeGreaterThan(1)
  })

  it("opens the command palette on Cmd+K and runs a command", async () => {
    const harness = makeAppHarness()
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
    const harness = makeAppHarness()
    harness.renderApp()
    await harness.openIntoActive("/notes/doc.md", "saved")

    vi.mocked(harness.services.readFile).mockResolvedValueOnce("external")
    await harness.runExternalCheck()

    await waitFor(() => expect(editor.reset).toHaveBeenCalledTimes(2))
  })

  it("searches the opened folder and opens a hit in a new tab", async () => {
    const harness = makeAppHarness()
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
    const harness = makeAppHarness()
    harness.renderApp()
    expect(screen.getByText(/Open a folder from the File menu/)).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Open folder" })).toBeNull()
    expect(screen.getByRole("button", { name: "Search" })).toBeTruthy()
    expect(screen.getByText("Outline")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Export HTML" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Export PDF" })).toBeNull()
  })

  it("expands a directory in place without replacing the tree", async () => {
    const harness = makeAppHarness()
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
    const harness = makeAppHarness()
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
    const harness = makeAppHarness()
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
    const harness = makeAppHarness()
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
    const harness = makeAppHarness()
    let send: ((id: string) => void) | undefined
    harness.services.listenMenu = handler => {
      send = handler
      return () => undefined
    }
    vi.mocked(harness.services.pickSavePath).mockResolvedValue("/notes/copy.md")
    harness.renderApp()
    await harness.openIntoActive("/notes/doc.md", "saved")
    act(() => send?.("save-as"))
    await waitFor(() => {
      expect(harness.services.pickSavePath).toHaveBeenCalled()
      expect(harness.services.writeFile).toHaveBeenCalledWith("/notes/copy.md", "saved")
    })
  })

  it("creates and closes tabs from the File menu", async () => {
    const harness = makeAppHarness()
    let send: ((id: string) => void) | undefined
    harness.services.listenMenu = handler => {
      send = handler
      return () => undefined
    }
    harness.renderApp()
    act(() => send?.("new"))
    await waitFor(() => expect(editor.create).toHaveBeenCalledTimes(2))
    act(() => send?.("close"))
    await waitFor(() => expect(screen.getAllByRole("button", { name: /untitled/ })).toHaveLength(1))
  })

  it("remembers opened files and reopens them from the File menu", async () => {
    const harness = makeAppHarness()
    let send: ((id: string) => void) | undefined
    harness.services.listenMenu = handler => {
      send = handler
      return () => undefined
    }
    harness.services.setRecentMenu = vi.fn(async () => undefined)
    harness.services.saveRecents = vi.fn()
    harness.renderApp()
    await harness.openIntoActive("/notes/doc.md", "saved")
    await waitFor(() => expect(harness.services.setRecentMenu).toHaveBeenCalledWith(["/notes/doc.md"]))
    fireEvent.click(screen.getByRole("button", { name: "+" }))
    await waitFor(() => expect(editor.create).toHaveBeenCalledTimes(2))
    act(() => send?.("recent:/notes/doc.md"))
    await waitFor(() => expect(screen.getByText("/notes/doc.md")).toBeTruthy())
  })

  it("fills the file tree from the parent folder after opening a file", async () => {
    const harness = makeAppHarness()
    harness.services.listDir = vi.fn(async () => [
      { name: "doc.md", path: "/notes/doc.md", is_dir: false },
      { name: "other.md", path: "/notes/other.md", is_dir: false },
    ])
    harness.renderApp()
    await harness.openIntoActive("/notes/doc.md", "saved")
    await waitFor(() => expect(screen.getByText("other.md")).toBeTruthy())
    expect(harness.services.listDir).toHaveBeenCalledWith("/notes")
  })

  it("exports HTML through the save service", async () => {
    const harness = makeAppHarness()
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
    const harness = makeAppHarness()
    vi.mocked(harness.services.pickSavePath).mockResolvedValue("/notes/copy.md")
    harness.renderApp()
    fireEvent.keyDown(window, { key: "n", metaKey: true })
    await waitFor(() => expect(editor.create).toHaveBeenCalledTimes(2))
    fireEvent.keyDown(window, { key: "s", metaKey: true, shiftKey: true })
    await waitFor(() => expect(harness.services.pickSavePath).toHaveBeenCalled())
  })
})
