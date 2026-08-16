import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { screen, fireEvent, waitFor } from "@testing-library/react"
import type { EditorView } from "@codemirror/view"
import type { CreateEditorOptions } from "../src/Editor"
import { createAppHarness, resetMountedApps } from "./appHarness"
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
})
