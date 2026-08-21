import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { screen, fireEvent, waitFor, act } from "@testing-library/react"
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

  it("does not push the default light theme before settings load", async () => {
    const harness = createAppHarness(editor)
    let resolveSettings: (value: UserSettings) => void = () => {}
    vi.mocked(harness.services.getSettings!).mockImplementation(
      () => new Promise<UserSettings>(resolve => { resolveSettings = resolve }),
    )
    harness.renderApp()

    // Mount-time theme state is the "light" default; pushing it would flip
    // the title bar dark→light→dark after Rust already applied the saved
    // theme before first paint.
    await act(async () => { await Promise.resolve() })
    expect(harness.services.setWindowTheme).not.toHaveBeenCalled()

    await act(async () => { resolveSettings(settingsWith({ theme: "dark" })) })
    await waitFor(() => {
      expect(harness.services.setWindowTheme).toHaveBeenCalledWith("dark")
    })
    expect(harness.services.setWindowTheme).not.toHaveBeenCalledWith("light")
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
