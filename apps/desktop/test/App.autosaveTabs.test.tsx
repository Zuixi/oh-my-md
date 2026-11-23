import { act } from "@testing-library/react"
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
    acceptOrderedListNormalization: vi.fn(() => ({ kind: "accepted" as const, transaction: {} })),
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
  vi.useRealTimers()
  resetMountedApps()
})

const AUTOSAVE_MS = 1000
const SWITCH_AFTER_MS = 200

describe("per-tab autosave", () => {
  it("saves a background tab that was left inside the autosave window", async () => {
    const harness = createAppHarness(editor)
    harness.seedFile("/notes/a.md", "a")
    harness.seedFile("/notes/b.md", "b")
    harness.renderApp({ autosaveMs: AUTOSAVE_MS })
    await harness.openFileTab("/notes/a.md", "a")
    await harness.openInNewTab("/notes/b.md", "b")

    vi.useFakeTimers()
    harness.activateTab(1)
    harness.editorForTab(1).emit({
      doc: "edited a", docChanged: true, pendingNormalization: null,
    })
    act(() => { vi.advanceTimersByTime(SWITCH_AFTER_MS) })
    // Switch away inside the window: the old wiring cleared tab 1's timer here.
    harness.activateTab(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTOSAVE_MS) })

    expect(harness.disk("/notes/a.md").contents()).toBe("edited a")
    // Tab 2 stayed active and was never written with tab 1's content.
    expectPathShown("/notes/b.md")
    expect(harness.disk("/notes/b.md").contents()).toBe("b")
  })

  it("cancels the timer when the dirty tab is closed", async () => {
    const harness = createAppHarness(editor)
    harness.seedFile("/notes/a.md", "a")
    harness.seedFile("/notes/b.md", "b")
    harness.renderApp({ autosaveMs: AUTOSAVE_MS })
    await harness.openFileTab("/notes/a.md", "a")
    await harness.openInNewTab("/notes/b.md", "b")

    vi.useFakeTimers()
    harness.activateTab(1)
    harness.editorForTab(1).emit({
      doc: "edited a", docChanged: true, pendingNormalization: null,
    })
    // Confirmed close discards the buffer; a later write would resurrect it.
    harness.requestCloseTab(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTOSAVE_MS) })

    expect(harness.disk("/notes/a.md").contents()).toBe("a")
  })
})
