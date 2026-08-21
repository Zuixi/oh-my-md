import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { waitFor, act } from "@testing-library/react"
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

async function openTwoFilesAndCloseOne(harness: ReturnType<typeof createAppHarness>) {
  harness.seedFile("/notes/a.md", "a")
  harness.seedFile("/notes/b.md", "b")
  await harness.openFileTab("/notes/a.md", "a")
  await harness.openInNewTab("/notes/b.md", "b")
  // Close tab 2 (b.md) well inside the 1s debounce window, then quit —
  // the exact sequence that used to restore a stale 10-file-style snapshot.
  harness.requestCloseTab(2)
  await waitFor(() => expectPathShown("/notes/a.md"))
}

describe("App quit-time session flush", () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  afterEach(() => {
    resetMountedApps()
  })

  it("flushes the post-close session state on quit request, then acks", async () => {
    const harness = createAppHarness(editor)
    harness.renderApp()
    await openTwoFilesAndCloseOne(harness)

    await act(async () => { await harness.triggerSessionFlush() })

    expect(harness.services.saveSessionState).toHaveBeenCalledWith(
      expect.objectContaining({
        openPaths: ["/notes/a.md"],
        activePath: "/notes/a.md",
      }),
    )
    expect(harness.services.sessionFlushAck).toHaveBeenCalledTimes(1)
  })

  it("cancels the pending debounced save when flushing", async () => {
    const harness = createAppHarness(editor)
    harness.renderApp()
    await openTwoFilesAndCloseOne(harness)

    vi.useFakeTimers()
    try {
      await act(async () => {
        await harness.triggerSessionFlush()
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(harness.services.sessionFlushAck).toHaveBeenCalledTimes(1)
      const saves = vi.mocked(harness.services.saveSessionState!)
      const savesAfterFlush = saves.mock.calls.length

      // The stale 1s debounce timer must be gone — quitting on it is how
      // session.json kept pre-close snapshots.
      await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
      expect(saves.mock.calls.length).toBe(savesAfterFlush)
    } finally {
      vi.useRealTimers()
    }
  })

  it("acks even when the session save fails, so quit never stalls", async () => {
    const harness = createAppHarness(editor)
    harness.renderApp()
    await openTwoFilesAndCloseOne(harness)
    vi.mocked(harness.services.saveSessionState!).mockRejectedValueOnce(new Error("disk full"))

    await act(async () => { await harness.triggerSessionFlush() })

    expect(harness.services.sessionFlushAck).toHaveBeenCalledTimes(1)
  })
})
