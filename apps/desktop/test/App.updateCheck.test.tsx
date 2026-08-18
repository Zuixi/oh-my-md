import { act, fireEvent, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { EditorView } from "@codemirror/view"
import type { CreateEditorOptions } from "../src/Editor"
import { RELEASES_URL } from "../src/constants"
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
  it("shows a dismissible banner when a manual check finds an update", async () => {
    const harness = createAppHarness(editor)
    harness.services.checkForUpdates = vi.fn(async () => ({
      version: "9.9.9",
      currentVersion: "0.1.0",
    }))
    const openExternal = vi.fn(async () => undefined)
    harness.services.openExternal = openExternal

    harness.renderApp()
    openPaletteAndRun("check")

    await waitFor(() => {
      expect(document.querySelector(".update-banner-message")?.textContent).toContain("9.9.9")
    })

    fireEvent.click(screen.getByRole("button", { name: "View Release" }))
    expect(openExternal).toHaveBeenCalledWith(RELEASES_URL)
    await waitFor(() => {
      expect(document.querySelector(".update-banner")).toBeNull()
    })
  })

  it("reports up to date when no update is available and never opens the banner", async () => {
    const harness = createAppHarness(editor)
    harness.services.checkForUpdates = vi.fn(async () => null)

    harness.renderApp()
    openPaletteAndRun("check")

    await waitFor(() => {
      expect(document.querySelector(".save-transient-status")?.textContent).toContain("up to date")
    })
    expect(document.querySelector(".update-banner")).toBeNull()
  })

  it("stays silent when the background startup check has no update", async () => {
    const harness = createAppHarness(editor)
    const checkForUpdates = vi.fn(async () => null)
    harness.services.checkForUpdates = checkForUpdates

    vi.useFakeTimers()
    harness.renderApp()
    await act(async () => {
      vi.advanceTimersByTime(8500)
    })

    expect(checkForUpdates).toHaveBeenCalled()
    expect(document.querySelector(".update-banner")).toBeNull()
    expect(document.querySelector(".save-transient-status")).toBeNull()
  })
})
