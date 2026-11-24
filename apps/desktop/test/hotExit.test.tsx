import { act, fireEvent, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { EditorView } from "@codemirror/view"
import type { CreateEditorOptions } from "../src/Editor"
import type { SavedSessionState } from "../src/sessionRestore"
import { createAppHarness, resetMountedApps } from "./appHarness"

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

afterEach(() => resetMountedApps())

interface RecoveryStore {
  readonly records: Map<string, { path: string | null; contents: string }>
  readonly write: (key: string, path: string | null, contents: string) => Promise<void>
  readonly list: () => Promise<Array<{ key: string; label: string; path: string | null }>>
  readonly read: (key: string) => Promise<{ path: string | null; contents: string }>
  readonly remove: (key: string) => Promise<void>
}

/** In-memory stand-in for the Rust recovery directory. */
function recoveryStore(): RecoveryStore {
  const records = new Map<string, { path: string | null; contents: string }>()
  return {
    records,
    write: async (key, path, contents) => { records.set(key, { path, contents }) },
    list: async () => [...records.keys()].map(key => ({
      key,
      label: key,
      path: records.get(key)?.path ?? null,
    })),
    read: async key => records.get(key) ?? { path: null, contents: "" },
    remove: async key => { records.delete(key) },
  }
}

describe("Hot Exit", () => {
  it("restores named, untitled-dirty, and clean tabs in order without a crash prompt", async () => {
    const recovery = recoveryStore()
    const harness = createAppHarness(editor)
    harness.services.writeRecovery = vi.fn(recovery.write)
    harness.services.readRecovery = vi.fn(recovery.read)
    harness.services.listRecoveries = vi.fn(recovery.list)
    harness.services.clearRecovery = vi.fn(recovery.remove)
    harness.services.confirmRestore = vi.fn(() => true)
    let saved: SavedSessionState | null = null
    harness.services.saveSessionState = vi.fn(async state => { saved = state })

    harness.seedFile("/notes/a.md", "disk a")
    harness.seedFile("/notes/clean.md", "clean disk")
    harness.renderApp()
    await harness.openFileTab("/notes/a.md", "disk a")
    // Dirty file tab, then a dirty untitled tab, then a clean file tab.
    harness.editorForTab(1).emit({ doc: "dirty a", docChanged: true, pendingNormalization: null })
    fireEvent.keyDown(window, { key: "n", metaKey: true })
    await waitFor(() => expect(harness.allEditors().length).toBe(2))
    harness.editorForTab(2).emit({ doc: "scratch draft", docChanged: true, pendingNormalization: null })
    fireEvent.keyDown(window, { key: "n", metaKey: true })
    await waitFor(() => expect(harness.allEditors().length).toBe(3))
    await harness.requestOpen("/notes/clean.md", "clean disk")

    await act(async () => { await harness.triggerSessionFlush() })
    expect(saved).not.toBeNull()
    const flushed: SavedSessionState = saved!
    expect(flushed.hotExitTabs?.map(entry => entry.kind)).toEqual(["file", "untitled", "file"])
    expect(flushed.hotExitTabs?.map(entry => entry.path)).toEqual([
      "/notes/a.md",
      null,
      "/notes/clean.md",
    ])
    expect(flushed.hotExitTabs?.[0]?.recoveryKey).not.toBeNull()
    expect(flushed.hotExitTabs?.[1]?.recoveryKey).not.toBeNull()
    expect(flushed.hotExitTabs?.[2]?.recoveryKey).toBeNull()
    expect(flushed.activeTabIndex).toBe(2)
    expect(recovery.records.size).toBe(2)

    // Relaunch: same shard, same recovery directory.
    vi.mocked(harness.services.getSessionState!).mockResolvedValue(flushed)
    vi.mocked(harness.services.confirmRestore!).mockClear()
    harness.renderApp()

    await waitFor(() => {
      expect(harness.services.getSessionState).toHaveBeenCalled()
      // All three tabs came back; the clean one was restored lazily.
      expect(document.querySelectorAll(".topbar-tabs .tab").length).toBe(3)
    })
    const labels = [...document.querySelectorAll(".topbar-tabs .tab-title")]
      .map(el => el.textContent)
    expect(labels).toEqual(["a.md", "unnamed", "clean.md"])
    // Both dirty buffers survived the quit, and nothing was offered as a crash.
    expect(document.querySelectorAll(".topbar-tabs .tab-dirty").length).toBe(2)
    expect(document.querySelector(".topbar-tabs .tab.is-active .tab-title")?.textContent)
      .toBe("clean.md")
    expect(harness.services.confirmRestore).not.toHaveBeenCalled()
    const restoredContents = harness.allEditors().slice(-3).map(handle => handle.getOptions().doc)
    // The active (clean) tab was read eagerly; the dirty buffers came back too.
    expect(restoredContents).toEqual(["dirty a", "scratch draft", "clean disk"])
  })

  it("still offers a recovery record the shard never claimed", async () => {
    const recovery = recoveryStore()
    const harness = createAppHarness(editor)
    harness.services.writeRecovery = vi.fn(recovery.write)
    harness.services.readRecovery = vi.fn(recovery.read)
    harness.services.listRecoveries = vi.fn(recovery.list)
    harness.services.clearRecovery = vi.fn(recovery.remove)
    harness.services.confirmRestore = vi.fn(() => false)

    // A crash left a record behind, but the shard knows nothing about it.
    await recovery.write("orphan_draft_key", null, "orphan contents")
    vi.mocked(harness.services.getSessionState!).mockResolvedValue({
      folder: null,
      openPaths: [],
      activePath: null,
    })

    harness.renderApp()

    await waitFor(() => {
      expect(harness.services.confirmRestore).toHaveBeenCalledWith("orphan_draft_key")
    })
    // Declining deletes the record instead of resurrecting it next launch.
    await waitFor(() => expect(recovery.records.has("orphan_draft_key")).toBe(false))
  })

  it("upgrades a dirty tab whose file disappeared into an untitled draft", async () => {
    const recovery = recoveryStore()
    const harness = createAppHarness(editor)
    harness.services.writeRecovery = vi.fn(recovery.write)
    harness.services.readRecovery = vi.fn(recovery.read)
    harness.services.listRecoveries = vi.fn(recovery.list)
    harness.services.clearRecovery = vi.fn(recovery.remove)
    harness.services.confirmRestore = vi.fn(() => true)

    // The file was deleted between quit and relaunch: the buffer must survive.
    await recovery.write("deleted_file_key", "/notes/gone.md", "contents of a deleted file")
    vi.mocked(harness.services.getSessionState!).mockResolvedValue({
      folder: null,
      openPaths: ["/notes/gone.md"],
      activePath: "/notes/gone.md",
      hotExitTabs: [{ kind: "file", path: "/notes/gone.md", recoveryKey: "deleted_file_key" }],
      activeTabIndex: 0,
    })

    harness.renderApp()

    await waitFor(() => {
      expect(harness.allEditors().length).toBe(1)
      expect(harness.allEditors()[0]!.getOptions().doc).toBe("contents of a deleted file")
    })
    expect(screen.getByLabelText("Unsaved")).toBeTruthy()
    expect(harness.services.confirmRestore).not.toHaveBeenCalled()
  })
})
