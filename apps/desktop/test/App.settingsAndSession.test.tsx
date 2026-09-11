import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { screen, fireEvent, waitFor, act } from "@testing-library/react"
import type { EditorView } from "@codemirror/view"
import type { CreateEditorOptions } from "../src/Editor"
import { createAppHarness, expectPathShown, resetMountedApps } from "./appHarness"
import type { UserSettings } from "../src/settings"
import type { SavedSessionState } from "../src/sessionRestore"

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

describe("App Settings & Session Restore integration", () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  afterEach(() => {
    resetMountedApps()
  })

  it("loads user settings on startup and applies theme and CSS custom properties", async () => {
    const harness = createAppHarness(editor)
    const customSettings: UserSettings = {
      theme: "dark",
      fontSize: 18,
      lineHeight: 1.8,
      fontFamily: "Menlo, monospace",
      tabSize: 4,
      defaultMode: "source",
      spellcheck: true,
      locale: "auto",
    }

    vi.mocked(harness.services.getSettings!).mockResolvedValue(customSettings)
    harness.renderApp()

    await waitFor(() => {
      expect(harness.services.getSettings).toHaveBeenCalled()
      expect(document.documentElement.dataset.theme).toBe("dark")
      expect(document.documentElement.style.getPropertyValue("--omd-font-size")).toBe("18px")
      expect(document.documentElement.style.getPropertyValue("--omd-line-height")).toBe("1.8")
      expect(document.documentElement.style.getPropertyValue("--omd-font-family")).toBe("Menlo, monospace")
    })
  })

  it("opens settings modal with Cmd+, shortcut, modifies a setting, and saves", async () => {
    const harness = createAppHarness(editor)
    harness.renderApp()

    // Press Cmd+,
    fireEvent.keyDown(window, { key: ",", metaKey: true })

    expect(screen.getByRole("dialog", { name: "Preferences" })).toBeTruthy()

    // Change font size input
    const fontSizeInput = screen.getByLabelText("Font Size") as HTMLInputElement
    fireEvent.change(fontSizeInput, { target: { value: "20" } })

    // Click Done to save
    const doneBtn = screen.getByRole("button", { name: "Done" })
    fireEvent.click(doneBtn)

    await waitFor(() => {
      expect(harness.services.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ fontSize: 20 }),
      )
      expect(screen.queryByRole("dialog", { name: "Preferences" })).toBeNull()
    })
  })

  it("restores saved workspace folder and tabs from session state on startup", async () => {
    const harness = createAppHarness(editor)
    const savedSession: SavedSessionState = {
      folder: "/projects/my-notes",
      openPaths: ["/projects/my-notes/readme.md", "/projects/my-notes/todo.md"],
      activePath: "/projects/my-notes/todo.md",
    }

    vi.mocked(harness.services.getSessionState!).mockResolvedValue(savedSession)
    harness.seedFile("/projects/my-notes/readme.md", "Readme content")
    harness.seedFile("/projects/my-notes/todo.md", "Todo content")

    harness.renderApp()

    await waitFor(() => {
      expect(harness.services.getSessionState).toHaveBeenCalled()
      expect(harness.services.allowWorkspaceDir).toHaveBeenCalledWith("/projects/my-notes")
      expect(screen.getAllByText("todo.md").length).toBeGreaterThan(0)
      expect(screen.getAllByText("readme.md").length).toBeGreaterThan(0)
    })
  })

  it("debounces and saves workspace session state when tabs change", async () => {
    const harness = createAppHarness(editor)
    harness.seedFile("/notes/work.md", "work notes")
    harness.renderApp()

    await harness.openFileTab("/notes/work.md", "work notes")

    await waitFor(() => {
      expect(harness.services.saveSessionState).toHaveBeenCalledWith(
        expect.objectContaining({
          openPaths: expect.arrayContaining(["/notes/work.md"]),
          activePath: "/notes/work.md",
        }),
      )
    }, { timeout: 2500 })
  })

  describe("non-main window mount flow", () => {
    // windowScope.currentWindowLabel reads __TAURI_INTERNALS__ lazily at call
    // time, so stubbing the global before renderApp turns this webview into a
    // restored editor-N window — no module mocking needed.
    const tauriInternals = window as { __TAURI_INTERNALS__?: unknown }

    beforeEach(() => {
      tauriInternals.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: "editor-1" } } }
    })

    afterEach(() => {
      delete tauriInternals.__TAURI_INTERNALS__
    })

    it("restores its own session shard on mount without offering the app-global draft", async () => {
      const harness = createAppHarness(editor)
      const savedSession: SavedSessionState = {
        folder: null,
        openPaths: ["/projects/shard.md"],
        activePath: "/projects/shard.md",
      }
      vi.mocked(harness.services.getSessionState!).mockResolvedValue(savedSession)
      harness.seedFile("/projects/shard.md", "Shard content")
      harness.services.listRecoveries = vi.fn(async () => [])
      harness.services.readRecovery = vi.fn(async () => "")

      harness.renderApp()

      // The restored tab comes from THIS window's shard (get_session_state is
      // window-scoped) — not just geometry, and not a fresh untitled tab.
      await waitFor(() => {
        expect(harness.services.getSessionState).toHaveBeenCalled()
        expect(screen.getAllByText("shard.md").length).toBeGreaterThan(0)
      })
      // Recovery records are app-global: a non-main window must never even
      // list them, let alone offer the draft.
      expect(harness.services.listRecoveries).not.toHaveBeenCalled()
      expect(harness.services.readRecovery).not.toHaveBeenCalled()

      // Normal flow intact: the restored workspace re-arms the 1s debounce
      // and re-saves this window's shard.
      await waitFor(() => {
        expect(harness.services.saveSessionState).toHaveBeenCalledWith(
          expect.objectContaining({ openPaths: ["/projects/shard.md"] }),
        )
      }, { timeout: 2500 })
    })

    it("keeps the fresh untitled tab on an empty shard and never drafts", async () => {
      const harness = createAppHarness(editor)
      // Empty shard (get_session_state "{}"): nothing to restore.
      vi.mocked(harness.services.getSessionState!).mockResolvedValue({
        folder: null,
        openPaths: [],
        activePath: null,
      })
      harness.services.listRecoveries = vi.fn(async () => [])

      harness.renderApp()

      await waitFor(() => {
        expect(harness.services.getSessionState).toHaveBeenCalled()
      })
      // Let the mount chain finish the restoreDraft gate decision.
      await act(async () => { await Promise.resolve() })

      expectPathShown("unnamed")
      expect(harness.services.listRecoveries).not.toHaveBeenCalled()
    })
  })
})
