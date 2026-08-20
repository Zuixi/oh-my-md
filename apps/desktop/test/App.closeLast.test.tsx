import { waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { EditorView } from "@codemirror/view"
import type { CreateEditorOptions } from "../src/Editor"
import { createAppHarness, expectPathShown, resetMountedApps } from "./appHarness"

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

afterEach(() => {
  vi.restoreAllMocks()
  resetMountedApps()
})

describe("closing the last open file", () => {
  it("closes the only file and lands on a fresh untitled tab", async () => {
    const harness = makeAppHarness()
    harness.renderApp()
    await harness.openIntoActive("/notes/doc.md", "saved")
    const createsBefore = editor.create.mock.calls.length

    harness.requestCloseTab(1)

    await waitFor(() => expectPathShown("unnamed"))
    // The swap must produce a NEW tab id, not reuse the closed file's tab.
    const tabIdsAfter = editor.create.mock.calls.map(call => call[1].tabId)
    expect(new Set(tabIdsAfter).size).toBe(tabIdsAfter.length)
    expect(tabIdsAfter.length).toBe(createsBefore + 1)
    expect(document.querySelectorAll(".topbar-tabs .tab")).toHaveLength(1)
    expect(harness.services.confirmClose).not.toHaveBeenCalled()
  })

  it("confirms before closing a dirty last file and keeps it when cancelled", async () => {
    const harness = makeAppHarness()
    vi.mocked(harness.services.confirmClose).mockReturnValue(false)
    harness.renderApp()
    await harness.openIntoActive("/notes/doc.md", "saved")
    harness.editorForTab(1).emit({ doc: "dirty", docChanged: true, pendingNormalization: null })

    harness.requestCloseTab(1)

    expect(harness.services.confirmClose).toHaveBeenCalledOnce()
    expectPathShown("/notes/doc.md", { dirty: true })
  })

  it("keeps the current tab when closing a clean untitled lone tab", async () => {
    const harness = makeAppHarness()
    harness.renderApp()
    const createsBefore = editor.create.mock.calls.length

    harness.requestCloseTab(1)

    await waitFor(() => expectPathShown("unnamed"))
    expect(harness.services.confirmClose).not.toHaveBeenCalled()
    expect(editor.create.mock.calls).toHaveLength(createsBefore)
  })
})
