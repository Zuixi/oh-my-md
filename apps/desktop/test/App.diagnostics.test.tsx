import { act, fireEvent, screen, waitFor } from "@testing-library/react"
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
  }
})

const { editor } = vi.hoisted(() => ({
  editor: { create: vi.fn(), reset: vi.fn() },
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

function openPaletteAndRun(query: string) {
  fireEvent.keyDown(window, { key: "p", metaKey: true, shiftKey: true })
  fireEvent.change(screen.getByPlaceholderText("Run a command…"), { target: { value: query } })
  fireEvent.keyDown(screen.getByPlaceholderText("Run a command…"), { key: "Enter" })
}

describe("export diagnostics wiring", () => {
  it("runs the diagnostics export service from the palette", async () => {
    const harness = createAppHarness(editor)
    const exportDiagnostics = vi.fn(async () => undefined)
    harness.services.exportDiagnostics = exportDiagnostics

    harness.renderApp()
    openPaletteAndRun("diagnostics")

    await waitFor(() => { expect(exportDiagnostics).toHaveBeenCalledTimes(1) })
  })
})

describe("open log folder wiring", () => {
  // The palette test below reaches the command by id directly, so it cannot see
  // `MENU_TO_COMMAND`. This drives the native menu id through the same
  // `listenMenu` seam App wires up, so a menu id mapped to a missing or renamed
  // command fails here instead of only in the string-level crossLayerMenu guard
  // (a dead menu item compiles and renders fine).
  it("runs openLogDir from the native menu id", async () => {
    const harness = createAppHarness(editor)
    let send: ((id: string) => void) | undefined
    harness.services.listenMenu = handler => {
      send = handler
      return () => undefined
    }
    const openLogDir = vi.fn(async () => undefined)
    harness.services.openLogDir = openLogDir

    harness.renderApp()
    act(() => send?.("open-log-folder"))

    await waitFor(() => { expect(openLogDir).toHaveBeenCalledTimes(1) })
  })

  // The whole point of the menu entry is that the user does not have to know the
  // path, so the palette command must reach the service — a label with no run
  // path compiles and renders fine while doing nothing.
  it("runs openLogDir from the palette", async () => {
    const harness = createAppHarness(editor)
    const openLogDir = vi.fn(async () => undefined)
    harness.services.openLogDir = openLogDir

    harness.renderApp()
    openPaletteAndRun("log folder")

    await waitFor(() => { expect(openLogDir).toHaveBeenCalledTimes(1) })
  })

  // A rejected invoke must surface through reportError rather than vanish as an
  // unhandled rejection: the interesting case is exactly the one where the
  // folder does not exist (file logging disabled).
  it("reports a failed open instead of swallowing the rejection", async () => {
    const harness = createAppHarness(editor)
    const failure = new Error("no log folder")
    harness.services.openLogDir = vi.fn(async () => { throw failure })

    harness.renderApp()
    openPaletteAndRun("log folder")

    await waitFor(() => { expect(harness.services.reportError).toHaveBeenCalled() })
  })
})
