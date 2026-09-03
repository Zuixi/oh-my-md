import { act, fireEvent, screen } from "@testing-library/react"
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
  vi.useRealTimers()
  resetMountedApps()
})

function openPaletteAndRun(query: string) {
  fireEvent.keyDown(window, { key: "p", metaKey: true, shiftKey: true })
  fireEvent.change(screen.getByPlaceholderText("Run a command…"), { target: { value: query } })
  fireEvent.keyDown(screen.getByPlaceholderText("Run a command…"), { key: "Enter" })
}

describe("update check wiring", () => {
  it("routes editor external links through the desktop opener", () => {
    const harness = createAppHarness(editor)
    const openExternal = vi.fn(async () => undefined)
    harness.services.openExternal = openExternal

    harness.renderApp()
    harness.editorForTab(1).getOptions().onOpenExternalHref?.("https://example.com")

    expect(openExternal).toHaveBeenCalledWith("https://example.com")
  })

  it("shows the unavailable notice when Check for Updates is run manually", () => {
    const harness = createAppHarness(editor)
    const legacyCheck = vi.fn(async () => null)
    Object.assign(harness.services, { checkForUpdates: legacyCheck })

    harness.renderApp()
    openPaletteAndRun("check")

    const notice = document.querySelector(".update-banner-message")
    expect(notice?.textContent).toContain("Automatic updates are not available yet")
    expect(notice?.textContent).toContain("download the latest release")
    expect(legacyCheck).not.toHaveBeenCalled()
  })

  it("opens the latest GitHub release from Download", () => {
    const harness = createAppHarness(editor)
    const openExternal = vi.fn(async () => undefined)
    harness.services.openExternal = openExternal

    harness.renderApp()
    openPaletteAndRun("check")
    fireEvent.click(screen.getByRole("button", { name: "Download" }))

    expect(openExternal).toHaveBeenCalledWith("https://github.com/Zuixi/oh-my-md/releases/latest")
  })

  it("does not perform a background startup update check", async () => {
    const harness = createAppHarness(editor)
    const legacyCheck = vi.fn(async () => null)
    Object.assign(harness.services, { checkForUpdates: legacyCheck })

    vi.useFakeTimers()
    harness.renderApp()
    await act(async () => {
      vi.advanceTimersByTime(60_000)
    })

    expect(legacyCheck).not.toHaveBeenCalled()
    expect(document.querySelector(".update-banner")).toBeNull()
  })
})
