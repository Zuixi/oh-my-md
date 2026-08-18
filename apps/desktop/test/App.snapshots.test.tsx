import { fireEvent, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { EditorView } from "@codemirror/view"
import type { CreateEditorOptions } from "../src/Editor"
import { createAppHarness, resetMountedApps } from "./appHarness"

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

afterEach(() => {
  resetMountedApps()
})

function openHistoryViaPalette() {
  fireEvent.keyDown(window, { key: "p", metaKey: true, shiftKey: true })
  fireEvent.change(screen.getByPlaceholderText("Run a command…"), { target: { value: "history" } })
  fireEvent.keyDown(screen.getByPlaceholderText("Run a command…"), { key: "Enter" })
}

describe("version history snapshots", () => {
  it("snapshots the file after a successful explicit save", async () => {
    const harness = createAppHarness(editor)
    harness.seedFile("/notes/doc.md", "v1")
    const snapshotDocument = vi.fn(async () => undefined)
    harness.services.snapshotDocument = snapshotDocument

    harness.renderApp()
    await harness.openFileTab("/notes/doc.md", "v1")
    harness.editorForTab(1).emit({ doc: "v2", docChanged: true, pendingNormalization: null })
    fireEvent.keyDown(window, { key: "s", metaKey: true })

    await waitFor(() => {
      expect(snapshotDocument).toHaveBeenCalledWith("/notes/doc.md")
    })
  })

  it("lists snapshots, restores into a new tab, and clears history", async () => {
    const harness = createAppHarness(editor)
    harness.seedFile("/notes/doc.md", "v1")
    const entries = [
      { fileName: "1700000000001.md", mtimeMs: 1700000000001, sizeBytes: 2048 },
      { fileName: "1700000000000.md", mtimeMs: 1700000000000, sizeBytes: 1024 },
    ]
    harness.services.listSnapshots = vi.fn(async () => entries)
    const readSnapshot = vi.fn(async () => "restored content")
    harness.services.readSnapshot = readSnapshot
    const clearSnapshots = vi.fn(async () => undefined)
    harness.services.clearSnapshots = clearSnapshots

    harness.renderApp()
    await harness.openFileTab("/notes/doc.md", "v1")
    const editorsBefore = harness.allEditors().length

    openHistoryViaPalette()
    await waitFor(() => {
      expect(screen.getByText("Version History")).toBeTruthy()
    })
    expect(harness.services.listSnapshots).toHaveBeenCalledWith("/notes/doc.md")
    expect(screen.getByText("2 KB")).toBeTruthy()

    // The first entry renders "2 KB"; both buttons carry date + size text.
    fireEvent.click(screen.getByRole("button", { name: /2 KB/ }))
    await waitFor(() => {
      expect(readSnapshot).toHaveBeenCalledWith("/notes/doc.md", "1700000000001.md")
    })
    await waitFor(() => {
      // The restored snapshot opened in a new untitled tab.
      expect(harness.allEditors().length).toBe(editorsBefore + 1)
      expect(screen.queryByText("Version History")).toBeNull()
    })

    // Restoring switched the active tab to the untitled snapshot; go back to
    // the file tab before clearing its history.
    harness.activateTab(1)
    openHistoryViaPalette()
    await waitFor(() => {
      expect(screen.getByText("Version History")).toBeTruthy()
    })
    fireEvent.click(screen.getByRole("button", { name: "Clear History" }))
    await waitFor(() => {
      expect(clearSnapshots).toHaveBeenCalledWith("/notes/doc.md")
    })
    await waitFor(() => {
      expect(screen.getByText("No snapshots yet. Save the file to create one.")).toBeTruthy()
    })
  })

  it("hints when the active tab has no file path", async () => {
    const harness = createAppHarness(editor)
    harness.renderApp()

    openHistoryViaPalette()

    await waitFor(() => {
      expect(document.querySelector(".save-transient-status")?.textContent)
        .toContain("Open a saved file")
    })
    expect(screen.queryByText("Version History")).toBeNull()
  })
})
