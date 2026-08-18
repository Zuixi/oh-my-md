import { act, fireEvent, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { EditorView } from "@codemirror/view"
import { acceptOrderedListNormalization } from "@omd/engine"
import type { CreateEditorOptions } from "../src/Editor"
import { createAppHarness, expectPathShown, normalizationId, resetMountedApps } from "./appHarness"

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

function makeAppHarness() {
  return createAppHarness(editor)
}

function edit(harness: ReturnType<typeof makeAppHarness>, tabId: number, doc: string) {
  harness.editorForTab(tabId).emit({ doc, docChanged: true, pendingNormalization: null })
}

async function openConflict(harness: ReturnType<typeof makeAppHarness>) {
  harness.renderApp()
  await harness.openFileTab("/notes/a.md", "saved")
  harness.disk("/notes/a.md").set("theirs")
  harness.editorForTab(1).emit({ doc: "mine", docChanged: true, pendingNormalization: null })
  await harness.saveActive()
}

afterEach(() => {
  vi.useRealTimers()
  resetMountedApps()
})

describe("App conflict actions", () => {
  beforeEach(() => {
    vi.useRealTimers()
    vi.mocked(acceptOrderedListNormalization).mockClear()
  })

  it("compare opens the diff panel without touching disk or state", async () => {
    const harness = makeAppHarness()
    await openConflict(harness)
    const attempts = harness.disk("/notes/a.md").saveCalls().length

    fireEvent.click(screen.getByRole("button", { name: "Compare" }))

    const panel = screen.getByRole("region", { name: "Document differences" })
    expect(panel.textContent).toContain("theirs")
    expect(panel.textContent).toContain("mine")
    expect(harness.disk("/notes/a.md").contents()).toBe("theirs")
    expect(harness.disk("/notes/a.md").saveCalls().length).toBe(attempts)
  })

  it("save copy keeps the original path, version, and conflict", async () => {
    const harness = makeAppHarness()
    await openConflict(harness)
    vi.mocked(harness.services.pickSavePath).mockResolvedValue("/notes/copy.md")

    fireEvent.click(screen.getByRole("button", { name: "Save copy" }))
    await waitFor(() => expect(harness.disk("/notes/copy.md").contents()).toBe("mine"))

    expect(harness.disk("/notes/a.md").contents()).toBe("theirs")
    expectPathShown("/notes/a.md", { dirty: true })
    expect(screen.getByRole("status", { name: "Save conflict" })).toBeTruthy()
  })

  it("save copy refuses the original resolved path", async () => {
    const harness = makeAppHarness()
    await openConflict(harness)
    vi.mocked(harness.services.pickSavePath).mockResolvedValue("/notes/a.md")

    fireEvent.click(screen.getByRole("button", { name: "Save copy" }))

    await waitFor(() => expect(screen.getByText("Choose a different file for the copy.")).toBeTruthy())
    expect(harness.disk("/notes/a.md").contents()).toBe("theirs")
  })

  it("reload re-reads on click and asks before discarding local edits", async () => {
    const harness = makeAppHarness()
    await openConflict(harness)
    harness.disk("/notes/a.md").set("newest")

    fireEvent.click(screen.getByRole("button", { name: "Reload disk" }))

    await waitFor(() => expect(harness.services.confirmDiscard).toHaveBeenCalled())
    await waitFor(() => expect(harness.editorForTab(1).getOptions().doc).toBe("newest"))
    expect(screen.queryByRole("status", { name: "Save conflict" })).toBeNull()
    expect(harness.services.clearRecovery).toHaveBeenCalled()
  })

  it("reload cancellation keeps the conflict and the local text", async () => {
    const harness = makeAppHarness()
    await openConflict(harness)
    vi.mocked(harness.services.confirmDiscard).mockReturnValue(false)

    fireEvent.click(screen.getByRole("button", { name: "Reload disk" }))

    await waitFor(() => expect(harness.services.confirmDiscard).toHaveBeenCalled())
    expect(screen.getByRole("status", { name: "Save conflict" })).toBeTruthy()
    expect(harness.editorForTab(1).getOptions().doc).toBe("saved")
  })

  it("overwrite uses the conflict version and replaces it when disk changes again", async () => {
    const harness = makeAppHarness()
    await openConflict(harness)
    const conflictVersion = harness.disk("/notes/a.md").version()

    harness.disk("/notes/a.md").set("newer theirs")
    fireEvent.click(screen.getByRole("button", { name: "Overwrite disk" }))

    await waitFor(() => expect(harness.disk("/notes/a.md").saveCalls().slice(-1)[0]?.expected).toEqual({
      kind: "existing", version: conflictVersion,
    }))
    expect(harness.disk("/notes/a.md").contents()).toBe("newer theirs")
    const banner = screen.getByRole("status", { name: "Save conflict" })
    expect(banner.textContent).toContain("changed on disk")

    fireEvent.click(screen.getByRole("button", { name: "Overwrite disk" }))
    await waitFor(() => expect(harness.disk("/notes/a.md").contents()).toBe("mine"))
    expect(screen.queryByRole("status", { name: "Save conflict" })).toBeNull()
    expectPathShown("/notes/a.md")
  })

  it("recreate uses expected missing and stays in conflict when the path reappears", async () => {
    const harness = makeAppHarness()
    harness.renderApp()
    await harness.openFileTab("/notes/a.md", "saved")
    edit(harness, 1, "mine")
    harness.disk("/notes/a.md").remove()
    await harness.saveActive()
    expect(screen.getByRole("button", { name: "Recreate file" })).toBeTruthy()

    harness.disk("/notes/a.md").set("someone else")
    fireEvent.click(screen.getByRole("button", { name: "Recreate file" }))

    await waitFor(() => expect(harness.disk("/notes/a.md").saveCalls().slice(-1)[0]?.expected)
      .toEqual({ kind: "missing" }))
    expect(harness.disk("/notes/a.md").contents()).toBe("someone else")
    expect(screen.getByRole("button", { name: "Choose another path" })).toBeTruthy()
  })

  it("close and discard confirms, clears recovery, and cancels safely", async () => {
    const harness = makeAppHarness()
    harness.renderApp()
    await harness.openFileTab("/notes/a.md", "saved")
    await harness.openInNewTab("/notes/b.md", "b body")
    harness.activateTab(1)
    edit(harness, 1, "mine")
    harness.disk("/notes/a.md").remove()
    await harness.saveActive()

    vi.mocked(harness.services.confirmClose).mockReturnValueOnce(false)
    fireEvent.click(screen.getByRole("button", { name: "Close and discard" }))
    expect(screen.getByRole("status", { name: "Save conflict" })).toBeTruthy()

    vi.mocked(harness.services.confirmClose).mockReturnValueOnce(true)
    fireEvent.click(screen.getByRole("button", { name: "Close and discard" }))
    await waitFor(() => expect(screen.queryByText("a.md")).toBeNull())
    expect(harness.services.clearRecovery).toHaveBeenCalled()
  })

  it("path changed reopens only the previous resolved path after confirmation", async () => {
    const harness = makeAppHarness()
    harness.renderApp()
    await harness.openFileTab("/notes/a.md", "saved")
    edit(harness, 1, "mine")
    harness.nextSaveResult({ status: "pathChangedConflict", requestedPath: "/notes/a.md" })
    await harness.saveActive()

    expect(screen.queryByRole("button", { name: "Compare" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Overwrite disk" })).toBeNull()

    vi.mocked(harness.services.confirmDiscard).mockReturnValueOnce(false)
    fireEvent.click(screen.getByRole("button", { name: "Reopen previous file" }))
    expect(harness.editorForTab(1).getOptions().doc).toBe("saved")

    vi.mocked(harness.services.confirmDiscard).mockReturnValueOnce(true)
    fireEvent.click(screen.getByRole("button", { name: "Reopen previous file" }))
    await waitFor(() => expect(harness.services.readDocument).toHaveBeenLastCalledWith("/notes/a.md"))
  })

  it("unexpected symlink offers only another path and never resets the editor", async () => {
    const harness = makeAppHarness()
    vi.mocked(harness.services.pickSavePath).mockResolvedValue("/notes/new.md")
    harness.renderApp()
    edit(harness, 1, "mine")
    harness.nextSaveResult({ status: "unexpectedSymlinkConflict", requestedPath: "/notes/new.md" })
    await harness.saveActive()

    expect(screen.queryByRole("button", { name: "Compare" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Overwrite disk" })).toBeNull()
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy()

    vi.mocked(harness.services.pickSavePath).mockResolvedValue("/notes/other.md")
    fireEvent.click(screen.getByRole("button", { name: "Choose another path" }))

    await waitFor(() => expect(harness.disk("/notes/other.md").contents()).toBe("mine"))
    expect(harness.editorForTab(1).getOptions().doc).toBe("")
    expect(harness.editorForTab(1).view.dispatch).not.toHaveBeenCalled()
  })

  it("permission denied offers retry, save copy, and reveal in file manager", async () => {
    const harness = makeAppHarness()
    harness.renderApp()
    await harness.openFileTab("/notes/a.md", "saved")
    edit(harness, 1, "mine")
    harness.failNextSave({ code: "permissionDenied", message: "cannot write to this location" })
    await harness.saveActive()

    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Save copy" })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Reveal in File Manager" }))
    expect(harness.services.revealInFinder).toHaveBeenCalledWith("/notes/a.md")

    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    await waitFor(() => expect(harness.disk("/notes/a.md").contents()).toBe("mine"))
  })

  it("shows a background conflict as a tab badge and reveals the banner after switching", async () => {
    const harness = makeAppHarness()
    harness.renderApp()
    await harness.openFileTab("/notes/a.md", "a saved")
    await harness.openInNewTab("/notes/b.md", "b saved")
    edit(harness, 2, "b mine")
    harness.disk("/notes/b.md").set("b theirs")
    await harness.saveActive()

    harness.activateTab(1)
    expect(screen.queryByRole("status", { name: "Save conflict" })).toBeNull()
    expect(screen.getByLabelText("Conflict")).toBeTruthy()

    harness.activateTab(2)
    expect(screen.getByRole("status", { name: "Save conflict" })).toBeTruthy()
  })

  it("accepts normalization only after a successful guarded save", async () => {
    const harness = makeAppHarness()
    harness.renderApp()
    await harness.openFileTab("/notes/a.md", "1. a\n3. b")
    harness.emitPending(1, normalizationId(1))
    harness.disk("/notes/a.md").set("theirs")

    await harness.saveNormalization(1)

    expect(vi.mocked(acceptOrderedListNormalization)).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "Save normalization" })).toBeTruthy()

    harness.disk("/notes/a.md").set("1. a\n3. b")
    fireEvent.click(screen.getByRole("button", { name: "Overwrite disk" }))

    await waitFor(() => expect(vi.mocked(acceptOrderedListNormalization)).toHaveBeenCalledOnce())
    expect(harness.editorForTab(1).view.dispatch).toHaveBeenCalledOnce()
  })

  it("recomputes the local diff after a debounce instead of on every keystroke", async () => {
    const harness = makeAppHarness()
    await openConflict(harness)
    vi.useFakeTimers()
    try {
      fireEvent.click(screen.getByRole("button", { name: "Compare" }))

      harness.editorForTab(1).emit({ doc: "mine edited", docChanged: true, pendingNormalization: null })
      expect(screen.getByRole("region", { name: "Document differences" }).textContent)
        .not.toContain("mine edited")

      await act(async () => { await vi.advanceTimersByTimeAsync(150) })

      expect(screen.getByRole("region", { name: "Document differences" }).textContent)
        .toContain("mine edited")
    } finally {
      vi.useRealTimers()
    }
  })

  it("refreshes the diff when the watcher sees a newer disk snapshot", async () => {
    const harness = makeAppHarness()
    await openConflict(harness)
    fireEvent.click(screen.getByRole("button", { name: "Compare" }))
    harness.disk("/notes/a.md").set("newest theirs")

    await harness.runWatcher()

    const panel = screen.getByRole("region", { name: "Document differences" })
    expect(panel.textContent).toContain("newest theirs")
    expect(screen.getByText("Disk contents were refreshed.")).toBeTruthy()
  })

  it("save copy does not accept normalization and reload clears stale pending", async () => {
    const harness = makeAppHarness()
    harness.renderApp()
    await harness.openFileTab("/notes/a.md", "1. a\n3. b")
    harness.emitPending(1, normalizationId(1))
    harness.disk("/notes/a.md").set("theirs")
    await harness.saveNormalization(1)

    vi.mocked(harness.services.pickSavePath).mockResolvedValue("/notes/copy.md")
    fireEvent.click(screen.getByRole("button", { name: "Save copy" }))
    await waitFor(() => expect(harness.disk("/notes/copy.md").contents()).toBe("1. a\n2. b"))
    expect(vi.mocked(acceptOrderedListNormalization)).not.toHaveBeenCalled()

    vi.mocked(harness.services.confirmDiscard).mockReturnValue(true)
    fireEvent.click(screen.getByRole("button", { name: "Reload disk" }))

    await waitFor(() => expect(screen.queryByRole("button", { name: "Save normalization" })).toBeNull())
  })
})
