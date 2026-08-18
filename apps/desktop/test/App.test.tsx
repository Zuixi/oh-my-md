import { act, fireEvent, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi, afterEach } from "vitest"
import type { EditorView } from "@codemirror/view"
import {
  getPendingOrderedListNormalization,
  rejectOrderedListNormalization,
} from "@omd/engine"
import type { CreateEditorOptions } from "../src/Editor"
import type { DiskSnapshot } from "../src/desktopServices"
import { t } from "../src/i18n"
import { createAppHarness, expectPathShown, normalizationId, resetMountedApps, versionFor } from "./appHarness"
import * as findReplaceModule from "../src/findReplace"

vi.mock("@omd/engine", async importOriginal => {
  const actual = await importOriginal<typeof import("@omd/engine")>()
  return {
    ...actual,
    exportHtml: () => "<!doctype html><html>exported</html>",
    exportRichHtml: async () => "<!doctype html><html>exported</html>",
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

function deferSaveDocument(harness: ReturnType<typeof makeAppHarness>) {
  return harness.pauseNextSave()
}

function deferSaveDocuments(harness: ReturnType<typeof makeAppHarness>, count: number) {
  return Array.from({ length: count }, () => harness.pauseNextSave())
}

function makeAppHarness() {
  return createAppHarness(editor)
}

afterEach(() => {
  vi.useRealTimers()
  resetMountedApps()
})

function edit(harness: ReturnType<typeof makeAppHarness>, tabId: number, doc: string) {
  harness.editorForTab(tabId).emit({ doc, docChanged: true, pendingNormalization: null })
}

/** Lets the recovery write settle: it is an 800ms trailing debounce, and the next
 * edit's draft would otherwise replace the pending one before it fires. */
async function editAndSettle(
  harness: ReturnType<typeof makeAppHarness>,
  tabId: number,
  doc: string,
) {
  edit(harness, tabId, doc)
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 850)) })
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
    const active = document.querySelectorAll(".topbar-tabs .tab.is-active")
    expect(active).toHaveLength(1)
    expect(active[0]?.textContent).toContain("unnamed")
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
      docChanged: true,
      pendingNormalization: { id: normalizationId(9), markerCount: 3 },
    }))

    expect(screen.queryByRole("button", { name: "Save normalization" })).toBeNull()
    expectPathShown("/notes/fresh.md")
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
    harness.disk("/notes/one.md").set("disk version")
    await harness.runExternalCheck()
    expect(screen.getByRole("status", { name: "Save conflict" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Save normalization" })).toBeTruthy()
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

    // Scoped to the top bar breadcrumb: an untitled tab button carries the same text.
    expectPathShown("unnamed")
    harness.editorForTab(1).emit({
      doc: "still editable",
      docChanged: true,
      pendingNormalization: null,
    })
    expectPathShown("unnamed", { dirty: true })
  })

  it("restores the old projection when reset throws", async () => {
    const harness = makeAppHarness()
    harness.renderApp()
    harness.editorForTab(1).setContents("1. a\n3. b")
    harness.emitPending(1, normalizationId(1))
    harness.failNextReset(new Error("reset failed"))

    await harness.requestOpen("/notes/new.md", "body")

    expect(screen.getByRole("button", { name: "Save normalization" })).toBeTruthy()
    expectPathShown("unnamed", { dirty: true })
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
      expect(harness.services.saveDocument).not.toHaveBeenCalled()
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
      await vi.advanceTimersByTimeAsync(1100)
      expect(harness.services.saveDocument).not.toHaveBeenCalled()
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
    const harness = makeAppHarness()
    const write = deferSaveDocument(harness)
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
    const harness = makeAppHarness()
    const write = deferSaveDocument(harness)
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
    expectPathShown("/notes/a.md", { dirty: true })
  })

  it("resyncs idle without accept when the notice id changes during save", async () => {
    const harness = makeAppHarness()
    const write = deferSaveDocument(harness)
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
    const harness = makeAppHarness()
    const write = deferSaveDocument(harness)
    harness.renderApp()
    await harness.openIntoActive("/notes/a.md", "1. a\n3. b")
    harness.emitPending(1, normalizationId(1))
    void harness.saveNormalization(1)
    await waitFor(() => expect(harness.services.saveDocument).toHaveBeenCalledOnce())
    harness.disk("/notes/a.md").set("disk version")
    await harness.runExternalCheck()
    write.resolve()
    await act(async () => { await write.promise })
    expect(harness.editorForTab(1).view.dispatch).not.toHaveBeenCalled()
    expect(screen.getByRole("status", { name: "Save conflict" })).toBeTruthy()
  })

  it("keeps pending idle when Save As is cancelled", async () => {
    const harness = makeAppHarness()
    vi.mocked(harness.services.pickSavePath).mockResolvedValueOnce(null)
    harness.renderApp()
    harness.emitPending(1, normalizationId(1))
    await harness.saveNormalization(1)
    expect(harness.services.saveDocument).not.toHaveBeenCalled()
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
    harness.failNextSave({ code: "internal", message: "disk full" })
    harness.renderApp()
    await harness.openIntoActive("/notes/a.md", "1. a\n3. b")
    harness.emitPending(1, normalizationId(1))
    await harness.saveNormalization(1)
    expect((screen.getByRole("button", { name: "Save normalization" }) as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getByText("save failed")).toBeTruthy()
  })

  it("clears pending when external disk content is loaded", async () => {
    const harness = makeAppHarness()
    harness.renderApp()
    await harness.openIntoActive("/notes/a.md", "1. a\n3. b")
    harness.emitPending(1, normalizationId(1))
    harness.disk("/notes/a.md").set("disk version")
    await harness.runExternalCheck()
    expect(screen.getByRole("status", { name: "Save conflict" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Save normalization" })).toBeTruthy()
  })

  it("keeps pending when external disk content is rejected", async () => {
    const harness = makeAppHarness()
    harness.renderApp()
    await harness.openIntoActive("/notes/a.md", "1. a\n3. b")
    harness.emitPending(1, normalizationId(1))
    harness.disk("/notes/a.md").set("disk version")
    await harness.runExternalCheck()
    expect(screen.getByRole("status", { name: "Save conflict" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Save normalization" })).toBeTruthy()
  })
})

describe("App document session", () => {
  it("marks dirty from a CodeMirror document transaction callback", async () => {
    const harness = makeAppHarness()
    harness.renderApp()

    edit(harness, 1, "edited")

    expectPathShown("unnamed", { dirty: true })
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
    expect(harness.services.reportError).toHaveBeenCalledWith(`${t("error.recoveryWriteFailed")}: disk full`)
    expect(logged).toHaveBeenCalledTimes(2)
    // Word count is debounced off the per-keystroke path; wait out the window.
    await waitFor(() => { expect(screen.getByText("3 words · 13 chars")).toBeTruthy() })
    expectPathShown("unnamed", { dirty: true })
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
      [`${t("error.recoveryWriteFailed")}: first outage`],
      [`${t("error.recoveryWriteFailed")}: second outage`],
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
    expectPathShown("/notes/doc.md", { dirty: true })
    edit(harness, 1, "saved")

    expectPathShown("/notes/doc.md")
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
    expectPathShown("unnamed", { dirty: true })
  })

  it("ignores an older open response and primes the new image resolver path", async () => {
    const harness = makeAppHarness()
    const firstRead = deferred<DiskSnapshot>()
    vi.mocked(harness.services.pickOpenPath)
      .mockResolvedValueOnce("/notes/old.md")
      .mockResolvedValueOnce("/notes/new.md")
    vi.mocked(harness.services.readDocument)
      .mockReturnValueOnce(firstRead.promise)
      .mockImplementationOnce(async path => {
        harness.seedFile(path, "new")
        return {
          kind: "existing" as const,
          requestedPath: path,
          contents: "new",
          version: versionFor(path, "new"),
        }
      })
    harness.renderApp()

    fireEvent.keyDown(window, { key: "o", metaKey: true })
    await waitFor(() => expect(harness.services.readDocument).toHaveBeenCalledTimes(1))
    fireEvent.keyDown(window, { key: "o", metaKey: true })

    await waitFor(() => expect(editor.reset).toHaveBeenCalledOnce())
    expect(harness.editorForTab(1).getOptions().getDocPath()).toBe("/notes/new.md")
    expectPathShown("/notes/new.md")

    fireEvent.keyDown(window, { key: "s", metaKey: true })
    await waitFor(() => expect(harness.services.saveDocument).toHaveBeenCalledOnce())

    firstRead.resolve({
      kind: "existing",
      requestedPath: "/notes/old.md",
      contents: "old",
      version: versionFor("/notes/old.md", "old"),
    })
    await act(async () => firstRead.promise)
    expect(editor.reset).toHaveBeenCalledOnce()
    expectPathShown("/notes/new.md")
  })

  it("keeps dirty when editing continues while a captured snapshot saves", async () => {
    const harness = makeAppHarness()
    const write = deferSaveDocument(harness)
    harness.renderApp()
    await harness.openIntoActive("/notes/doc.md", "before")
    edit(harness, 1, "snapshot")

    fireEvent.keyDown(window, { key: "s", metaKey: true })
    await waitFor(() => {
      expect(harness.services.saveDocument).toHaveBeenCalledWith(
        "/notes/doc.md",
        "snapshot",
        expect.objectContaining({ kind: "existing" }),
      )
    })
    edit(harness, 1, "edited during save")
    write.resolve()
    await act(async () => write.promise)

    expectPathShown("/notes/doc.md", { dirty: true })
  })

  it("serializes saves so a newer snapshot is written last", async () => {
    const harness = makeAppHarness()
    const [firstWrite, secondWrite] = deferSaveDocuments(harness, 2)
    harness.renderApp()
    await harness.openIntoActive("/notes/doc.md", "saved")

    edit(harness, 1, "first snapshot")
    fireEvent.keyDown(window, { key: "s", metaKey: true })
    await waitFor(() => expect(harness.services.saveDocument).toHaveBeenCalledTimes(1))

    edit(harness, 1, "second snapshot")
    fireEvent.keyDown(window, { key: "s", metaKey: true })
    expect(harness.services.saveDocument).toHaveBeenCalledTimes(1)

    edit(harness, 1, "first snapshot")
    firstWrite.resolve()
    await act(async () => firstWrite.promise)
    await waitFor(() => expect(harness.services.saveDocument).toHaveBeenCalledTimes(2))
    secondWrite.resolve()
    await act(async () => secondWrite.promise)
    expect(harness.services.saveDocument).toHaveBeenNthCalledWith(
      2,
      "/notes/doc.md",
      "second snapshot",
      expect.objectContaining({ kind: "existing" }),
    )
    await waitFor(() => expectPathShown("/notes/doc.md", { dirty: true }))
  })

  it("reuses the first path for concurrent Save As requests", async () => {
    const harness = makeAppHarness()
    const firstWrite = harness.pauseNextSave()
    vi.mocked(harness.services.pickSavePath)
      .mockResolvedValueOnce("/notes/first-choice.md")
      .mockResolvedValueOnce("/notes/wrong-second-choice.md")
    harness.renderApp()
    harness.editorForTab(1).setContents("untitled snapshot")

    fireEvent.keyDown(window, { key: "s", metaKey: true })
    fireEvent.keyDown(window, { key: "s", metaKey: true })
    await waitFor(() => expect(harness.services.saveDocument).toHaveBeenCalledOnce())
    expect(harness.services.pickSavePath).toHaveBeenCalledOnce()
    firstWrite.resolve()
    await act(async () => firstWrite.promise)

    await waitFor(() => {
      expectPathShown("/notes/first-choice.md")
    })
    expect(harness.services.allowDocumentAssets).toHaveBeenCalledWith(
      "/notes/first-choice.md",
    )
    expect(harness.services.pickSavePath).toHaveBeenCalledOnce()
    await waitFor(() => expect(harness.services.saveDocument).toHaveBeenCalledTimes(2))
    expect(harness.services.saveDocument).toHaveBeenNthCalledWith(
      2,
      "/notes/first-choice.md",
      "untitled snapshot",
      expect.objectContaining({ kind: "existing" }),
    )
  })

  it("waits for pending saves before opening and reading a path", async () => {
    const harness = makeAppHarness()
    harness.seedFile("/notes/doc.md", "disk snapshot")
    vi.mocked(harness.services.pickOpenPath).mockResolvedValue("/notes/doc.md")
    const write = deferSaveDocument(harness)
    vi.mocked(harness.services.pickSavePath).mockResolvedValue(
      "/notes/saved-before-open.md",
    )
    harness.renderApp()

    fireEvent.keyDown(window, { key: "s", metaKey: true })
    await waitFor(() => expect(harness.services.saveDocument).toHaveBeenCalledOnce())
    fireEvent.keyDown(window, { key: "o", metaKey: true })
    expect(harness.services.pickOpenPath).not.toHaveBeenCalled()

    write.resolve()
    await act(async () => write.promise)
    await waitFor(() => expect(harness.services.pickOpenPath).toHaveBeenCalledOnce())
    await waitFor(() => expectPathShown("/notes/doc.md"))
  })

  it("does not start a save while an earlier open is still reading", async () => {
    const harness = makeAppHarness()
    const read = deferred<DiskSnapshot>()
    vi.mocked(harness.services.pickOpenPath).mockResolvedValue("/notes/doc.md")
    vi.mocked(harness.services.readDocument).mockImplementation(async path => {
      const snapshot = await read.promise
      if (snapshot.kind === "existing") {
        harness.seedFile(path, snapshot.contents)
      }
      return snapshot
    })
    vi.mocked(harness.services.pickSavePath).mockResolvedValue(
      "/notes/should-not-save.md",
    )
    harness.renderApp()

    fireEvent.keyDown(window, { key: "o", metaKey: true })
    await waitFor(() => expect(harness.services.readDocument).toHaveBeenCalledOnce())
    fireEvent.keyDown(window, { key: "s", metaKey: true })
    await act(async () => Promise.resolve())
    expect(harness.services.pickSavePath).not.toHaveBeenCalled()

    read.resolve({
      kind: "existing",
      requestedPath: "/notes/doc.md",
      contents: "opened",
      version: versionFor("/notes/doc.md", "opened"),
    })
    await act(async () => read.promise)
    await waitFor(() => expectPathShown("/notes/doc.md"))
    expect(harness.services.saveDocument).not.toHaveBeenCalled()
  })

  it("keeps the last successful baseline when a newer queued save fails", async () => {
    const harness = makeAppHarness()
    const [firstWrite] = deferSaveDocuments(harness, 1)
    harness.renderApp()
    await harness.openIntoActive("/notes/doc.md", "original")

    edit(harness, 1, "first")
    fireEvent.keyDown(window, { key: "s", metaKey: true })
    await waitFor(() => expect(harness.services.saveDocument).toHaveBeenCalledOnce())
    firstWrite.resolve()
    await act(async () => firstWrite.promise)
    await waitFor(() => expectPathShown("/notes/doc.md"))

    harness.failNextSave({ code: "internal", message: "second save failed" })
    edit(harness, 1, "second")
    fireEvent.keyDown(window, { key: "s", metaKey: true })
    edit(harness, 1, "first")

    await waitFor(() => {
      expect(screen.getByText("save failed")).toBeTruthy()
    })
    expectPathShown("/notes/doc.md")
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

    await waitFor(() => expectPathShown("/notes/opened.md"))
    expect(harness.services.saveDocument).not.toHaveBeenCalled()
  })

  it("reports Save As dialog failures", async () => {
    const harness = makeAppHarness()
    vi.mocked(harness.services.pickSavePath).mockRejectedValue(
      new Error("dialog unavailable"),
    )
    harness.renderApp()

    fireEvent.keyDown(window, { key: "s", metaKey: true })

    await waitFor(() => {
      expect(screen.getByText("save failed")).toBeTruthy()
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
        `${t("error.openFailed")}: reset failed`,
      )
    })
    fireEvent.keyDown(window, { key: "s", metaKey: true })

    await waitFor(() => expect(harness.services.pickSavePath).toHaveBeenCalledOnce())
    expect(harness.services.saveDocument).not.toHaveBeenCalled()
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
    expectPathShown("unnamed", { dirty: true })
  })

  it("writes untitled edits only to recovery, not the filesystem", async () => {
    const harness = makeAppHarness()
    harness.renderApp({ autosaveMs: 20 })
    edit(harness, 1, "draft")
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 900)) })
    expect(harness.services.writeRecovery).toHaveBeenCalled()
    expect(harness.services.saveDocument).not.toHaveBeenCalled()
  })

  it("autosaves a dirty pathed document through the save queue", async () => {
    const harness = makeAppHarness()
    harness.renderApp({ autosaveMs: 20 })
    await harness.openIntoActive("/notes/doc.md", "saved")
    edit(harness, 1, "edited")
    await waitFor(() => {
      expect(harness.services.saveDocument).toHaveBeenCalledWith(
        "/notes/doc.md",
        "edited",
        expect.objectContaining({ kind: "existing" }),
      )
    })
  })

  it("opens a second tab from the tab bar", async () => {
    const harness = makeAppHarness()
    harness.renderApp()
    fireEvent.click(screen.getByRole("button", { name: "+" }))
    await waitFor(() => expect(editor.create).toHaveBeenCalledTimes(2))
    expect(screen.getAllByRole("button", { name: /unnamed/ }).length).toBeGreaterThan(1)
  })

  it("opens the command palette on Cmd+K and runs a command", async () => {
    const harness = makeAppHarness()
    harness.renderApp()
    fireEvent.keyDown(window, { key: "p", metaKey: true, shiftKey: true })
    expect(screen.getByPlaceholderText("Run a command…")).toBeTruthy()
    fireEvent.change(screen.getByPlaceholderText("Run a command…"), {
      target: { value: "theme" },
    })
    fireEvent.keyDown(screen.getByPlaceholderText("Run a command…"), { key: "Enter" })
    expect(document.documentElement.dataset.theme).toBe("dark")
  })

  it("shows a clean external update without reloading automatically", async () => {
    const harness = makeAppHarness()
    harness.renderApp()
    await harness.openFileTab("/notes/doc.md", "saved")
    harness.disk("/notes/doc.md").set("external")

    await harness.runWatcher()

    const banner = screen.getByRole("status", { name: "Save conflict" })
    expect(banner.textContent).toContain("updated on disk")
    expect(screen.getByRole("button", { name: "Keep current" })).toBeTruthy()
    expect(harness.editorForTab(1).getOptions().doc).toBe("saved")
    expect(editor.reset).toHaveBeenCalledOnce()
  })

  it("searches the opened folder and opens a hit in a new tab", async () => {
    const harness = makeAppHarness()
    harness.services.pickFolder = vi.fn(async () => "/notes")
    harness.services.listDir = vi.fn(async () => [
      { name: "doc.md", path: "/notes/doc.md", is_dir: false },
    ])
    harness.services.searchMarkdown = vi.fn(async () => ({
      hits: [{ path: "/notes/hit.md", line: 2, text: "found it", start: 0, end: 5 }],
      truncated: false,
    }))
    vi.mocked(harness.services.readDocument).mockImplementation(async path => {
      harness.seedFile(path, "found it")
      return {
        kind: "existing" as const,
        requestedPath: path,
        contents: "found it",
        version: versionFor(path, "found it"),
      }
    })
    harness.renderApp()
    fireEvent.keyDown(window, { key: "p", metaKey: true, shiftKey: true })
    fireEvent.change(screen.getByPlaceholderText("Run a command…"), {
      target: { value: "Open folder" },
    })
    fireEvent.keyDown(screen.getByPlaceholderText("Run a command…"), { key: "Enter" })
    await waitFor(() => expect(screen.getByText("doc.md")).toBeTruthy())
    fireEvent.keyDown(window, { key: "p", metaKey: true, shiftKey: true })
    fireEvent.change(screen.getByPlaceholderText("Run a command…"), {
      target: { value: "Search in folder" },
    })
    fireEvent.keyDown(screen.getByPlaceholderText("Run a command…"), { key: "Enter" })
    fireEvent.change(screen.getByPlaceholderText("Find in folder…"), {
      target: { value: "found" },
    })
    await waitFor(() => expect(screen.getByText(/hit.md:2/)).toBeTruthy())
    fireEvent.click(screen.getByText(/hit.md:2/))
    await waitFor(() => expect(harness.services.readDocument).toHaveBeenCalledWith("/notes/hit.md"))
  })

  it("opens document find with meta+f and does not open folder search", () => {
    const harness = makeAppHarness()
    harness.renderApp()
    fireEvent.keyDown(window, { key: "f", metaKey: true })
    expect(screen.queryByPlaceholderText("Find in folder…")).toBeNull()
    expect(screen.getByLabelText("Find")).toBeTruthy()
  })

  it("skips collectMatches scan while find bar is closed", () => {
    const spy = vi.spyOn(findReplaceModule, "collectMatches")
    const harness = makeAppHarness()
    harness.renderApp()
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
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

  it("toggles the outline via button and shortcut", () => {
    const harness = makeAppHarness()
    harness.renderApp()
    const toggle = screen.getByRole("button", { name: "Show outline" })
    expect(toggle.getAttribute("aria-expanded")).toBe("false")

    fireEvent.click(toggle)
    expect(screen.getByRole("button", { name: "Hide outline" }).getAttribute("aria-expanded"))
      .toBe("true")

    fireEvent.keyDown(window, { key: "O", metaKey: true, shiftKey: true })
    expect(screen.getByRole("button", { name: "Show outline" }).getAttribute("aria-expanded"))
      .toBe("false")
  })

  it("shows outline preview popover on hover when outline sidebar is collapsed", async () => {
    const harness = makeAppHarness()
    harness.renderApp()
    const strip = document.querySelector(".outline-toggle-strip")
    expect(strip).toBeTruthy()

    expect(screen.queryByRole("dialog", { name: "Outline preview" })).toBeNull()

    fireEvent.mouseEnter(strip!)
    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Outline preview" })).toBeTruthy()
    })

    fireEvent.mouseLeave(strip!)
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Outline preview" })).toBeNull()
    })
  })

  it("toggles the primary sidebar via collapse button, topbar expand button, and shortcut", () => {
    const harness = makeAppHarness()
    harness.renderApp()
    const sidebar = document.getElementById("primary-sidebar")
    expect(sidebar?.classList.contains("is-hidden")).toBe(false)

    const collapseBtn = screen.getByRole("button", { name: "Hide sidebar" })
    fireEvent.click(collapseBtn)
    expect(sidebar?.classList.contains("is-hidden")).toBe(true)

    const expandBtn = screen.getByRole("button", { name: "Show sidebar" })
    fireEvent.click(expandBtn)
    expect(sidebar?.classList.contains("is-hidden")).toBe(false)

    fireEvent.keyDown(window, { key: "\\", metaKey: true })
    expect(sidebar?.classList.contains("is-hidden")).toBe(true)

    fireEvent.keyDown(window, { key: "\\", metaKey: true })
    expect(sidebar?.classList.contains("is-hidden")).toBe(false)
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
    fireEvent.keyDown(window, { key: "p", metaKey: true, shiftKey: true })
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
    harness.services.exportPreview = vi.fn(async () => null)
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
    harness.services.exportPreview = vi.fn(async () => null)
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
      expect(harness.services.saveDocument).toHaveBeenCalledWith(
        "/notes/copy.md",
        "saved",
        { kind: "missing" },
      )
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
    await waitFor(() => expect(screen.getAllByRole("button", { name: /unnamed/ })).toHaveLength(1))
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
    await waitFor(() => expectPathShown("/notes/doc.md"))
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
    fireEvent.keyDown(window, { key: "p", metaKey: true, shiftKey: true })
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

describe("App conflict-safe save integration", () => {
  it("opens a document through readDocument and saves the exact expected version", async () => {
    const harness = makeAppHarness()
    harness.renderApp()
    await harness.openFileTab("/notes/a.md", "disk body")
    const opened = harness.disk("/notes/a.md").version()
    expect(harness.services.readDocument).toHaveBeenCalledWith("/notes/a.md")
    expect(harness.services.readFile).not.toHaveBeenCalled()

    edit(harness, 1, "mine")
    await harness.saveActive()

    expect(harness.disk("/notes/a.md").saveCalls().slice(-1)[0]).toEqual({
      path: "/notes/a.md",
      contents: "mine",
      expected: { kind: "existing", version: opened },
    })
    expectPathShown("/notes/a.md")
  })

  it("sends expected missing for an untitled document", async () => {
    const harness = makeAppHarness()
    vi.mocked(harness.services.pickSavePath).mockResolvedValue("/notes/new.md")
    harness.renderApp()
    edit(harness, 1, "mine")
    await harness.saveActive()
    expect(harness.disk("/notes/new.md").saveCalls().slice(-1)[0]?.expected).toEqual({ kind: "missing" })
  })

  it("uses the check-time version for an existing Save As target", async () => {
    const harness = makeAppHarness()
    harness.disk("/notes/target.md").set("target body")
    vi.mocked(harness.services.pickSavePath).mockResolvedValue("/notes/target.md")
    harness.renderApp()
    edit(harness, 1, "mine")
    await harness.saveActive()
    expect(harness.disk("/notes/target.md").saveCalls().slice(-1)[0]?.expected).toEqual({
      kind: "existing",
      version: { resolvedPath: "/notes/target.md", fingerprint: "v1:11:target body" },
    })
  })

  it("keeps content and recovery and pauses retries when autosave conflicts", async () => {
    const harness = makeAppHarness()
    harness.renderApp({ autosaveMs: 50 })
    await harness.openFileTab("/notes/a.md", "saved")
    harness.disk("/notes/a.md").set("theirs")
    edit(harness, 1, "mine")

    await waitFor(() => {
      expect(screen.getByRole("status", { name: "Save conflict" }).textContent)
        .toContain("changed on disk")
    })

    await waitFor(() => {
      expect(harness.services.writeRecovery).toHaveBeenCalled()
    }, { timeout: 2000 })
    expect(harness.services.reportError).not.toHaveBeenCalled()
    expect(harness.disk("/notes/a.md").contents()).toBe("theirs")
    const attempts = harness.disk("/notes/a.md").saveCalls().length
    await new Promise(resolve => window.setTimeout(resolve, 200))
    expect(harness.disk("/notes/a.md").saveCalls().length).toBe(attempts)
  })

  it("focuses the conflict banner instead of overwriting on Cmd+S", async () => {
    const harness = makeAppHarness()
    harness.renderApp()
    await harness.openFileTab("/notes/a.md", "saved")
    harness.disk("/notes/a.md").set("theirs")
    edit(harness, 1, "mine")
    await harness.saveActive()
    const attempts = harness.disk("/notes/a.md").saveCalls().length

    fireEvent.keyDown(window, { key: "s", metaKey: true })

    expect(document.activeElement?.textContent).toBe("Compare")
    expect(harness.disk("/notes/a.md").saveCalls().length).toBe(attempts)
  })

  it("polls every file tab and fetches contents only after a version change", async () => {
    const harness = makeAppHarness()
    harness.renderApp()
    await harness.openFileTab("/notes/a.md", "a body")
    await harness.openInNewTab("/notes/b.md", "b body")
    vi.mocked(harness.services.readDocument).mockClear()

    await harness.runWatcher()
    expect(harness.services.readDocumentVersion).toHaveBeenCalledWith("/notes/a.md")
    expect(harness.services.readDocumentVersion).toHaveBeenCalledWith("/notes/b.md")
    expect(harness.services.readDocument).not.toHaveBeenCalled()

    harness.disk("/notes/b.md").set("b changed")
    await harness.runWatcher()
    expect(harness.services.readDocument).toHaveBeenCalledWith("/notes/b.md")
  })

  it("does not report an external change for the app's own save", async () => {
    const harness = makeAppHarness()
    harness.renderApp()
    await harness.openFileTab("/notes/a.md", "saved")
    edit(harness, 1, "mine")
    await harness.saveActive()

    await harness.runWatcher()

    expect(screen.queryByRole("status", { name: "Save conflict" })).toBeNull()
    expectPathShown("/notes/a.md")
  })

  it("records a durability warning without failing the save", async () => {
    const harness = makeAppHarness()
    harness.renderApp()
    await harness.openFileTab("/notes/a.md", "saved")
    edit(harness, 1, "mine")
    harness.nextSaveResult({
      status: "saved",
      version: { resolvedPath: "/notes/a.md", fingerprint: "v1:4:mine" },
      durability: "directorySyncFailed",
    })

    await harness.saveActive()

    expectPathShown("/notes/a.md")
    expect(screen.getByText("Saved, but the folder could not be flushed to disk.")).toBeTruthy()
    expect(screen.queryByRole("status", { name: "Save conflict" })).toBeNull()
  })

  it("completes two tabs in either order without polluting the active tab", async () => {
    const harness = makeAppHarness()
    harness.renderApp()
    await harness.openFileTab("/notes/a.md", "a saved")
    await harness.openInNewTab("/notes/b.md", "b saved")
    edit(harness, 1, "a mine")
    edit(harness, 2, "b mine")

    harness.activateTab(1)
    const first = harness.saveActive()
    harness.activateTab(2)
    const second = harness.saveActive()
    await Promise.all([first, second])

    expect(harness.disk("/notes/a.md").contents()).toBe("a mine")
    expect(harness.disk("/notes/b.md").contents()).toBe("b mine")
    expectPathShown("/notes/b.md")
  })
})
