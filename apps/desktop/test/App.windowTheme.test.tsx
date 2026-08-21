import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { screen, fireEvent, waitFor } from "@testing-library/react"
import type { EditorView } from "@codemirror/view"
import type { CreateEditorOptions } from "../src/Editor"
import { createAppHarness, resetMountedApps } from "./appHarness"
import { DEFAULT_SETTINGS, type UserSettings } from "../src/settings"

vi.mock("@omd/engine", async importOriginal => {
  const actual = await importOriginal<typeof import("@omd/engine")>()
  return {
    ...actual,
    exportHtml: () => "<!doctype html><html>exported</html>",
    exportRichHtml: async () => "<!doctype html><html>exported</html>",
    collectOutline: () => [],
    getPendingOrderedListNormalization: vi.fn(() => null),
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

function settingsWith(overrides: Partial<UserSettings>): UserSettings {
  return { ...DEFAULT_SETTINGS, ...overrides }
}

describe("App native window theme sync", () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  afterEach(() => {
    resetMountedApps()
  })

  it("pushes the resolved theme to the native window on startup", async () => {
    const harness = createAppHarness(editor)
    vi.mocked(harness.services.getSettings!).mockResolvedValue(settingsWith({ theme: "dark" }))
    harness.renderApp()

    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe("dark")
      expect(harness.services.setWindowTheme).toHaveBeenCalledWith("dark")
    })
  })

  it("maps the system theme to null so the window follows the OS", async () => {
    const harness = createAppHarness(editor)
    vi.mocked(harness.services.getSettings!).mockResolvedValue(settingsWith({ theme: "system" }))
    harness.renderApp()

    await waitFor(() => {
      expect(harness.services.setWindowTheme).toHaveBeenCalledWith(null)
    })
  })

  it("re-syncs the native window when the theme changes in settings", async () => {
    const harness = createAppHarness(editor)
    vi.mocked(harness.services.getSettings!).mockResolvedValue(settingsWith({ theme: "dark" }))
    harness.renderApp()

    await waitFor(() => {
      expect(harness.services.setWindowTheme).toHaveBeenCalledWith("dark")
    })

    fireEvent.keyDown(window, { key: ",", metaKey: true })
    fireEvent.change(screen.getByLabelText("Theme"), { target: { value: "system" } })
    fireEvent.click(screen.getByRole("button", { name: "Done" }))

    await waitFor(() => {
      expect(harness.services.setWindowTheme).toHaveBeenCalledWith(null)
    })
  })
})
