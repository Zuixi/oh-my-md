import { act, fireEvent, screen, waitFor } from "@testing-library/react"
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

function makeAppHarness() {
  return createAppHarness(editor)
}

/**
 * Route the native menu channel — the path macOS/Windows accelerators take, and
 * the one that never reaches the `keydown` handler in `useGlobalShortcuts`.
 */
function installMenuChannel(harness: ReturnType<typeof makeAppHarness>): (id: string) => void {
  let send: ((id: string) => void) | undefined
  harness.services.listenMenu = handler => {
    send = handler
    return () => { send = undefined }
  }
  return id => { act(() => send?.(id)) }
}

function tabCount(): number {
  return document.querySelectorAll(".topbar-tabs .tab").length
}

function openDialogNames(): Array<string | null> {
  return screen.queryAllByRole("dialog").map(dialog => dialog.getAttribute("aria-label"))
}

async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve() })
}

afterEach(() => {
  vi.restoreAllMocks()
  resetMountedApps()
})

describe("native menu commands behind a modal dialog", () => {
  it("ignores document menu ids while the command palette owns the window", async () => {
    const harness = makeAppHarness()
    const send = installMenuChannel(harness)
    harness.renderApp()
    await harness.openIntoActive("/notes/doc.md", "saved")
    const createsBefore = editor.create.mock.calls.length

    fireEvent.keyDown(window, { key: "p", metaKey: true, shiftKey: true })
    const palette = await screen.findByPlaceholderText("Run a command…")

    // Every id below would mutate or close a document the user cannot see.
    send("close")
    send("save")
    send("new")
    send("bold")
    send("recent:/notes/doc.md")
    await settle()

    expect(palette.isConnected).toBe(true)
    expectTabUnchanged({ harness, createsBefore })
    // Overlay switching stays reachable from the native menu while a modal is open.
    send("preferences")
    await waitFor(() => {
      expect(openDialogNames()).toContain("Preferences")
    })
  })

  it("ignores document menu ids while Preferences owns the window, then resumes", async () => {
    const harness = makeAppHarness()
    const send = installMenuChannel(harness)
    harness.renderApp()
    await harness.openIntoActive("/notes/doc.md", "saved")
    const createsBefore = editor.create.mock.calls.length

    fireEvent.keyDown(window, { key: ",", metaKey: true })
    await waitFor(() => expect(openDialogNames()).toEqual(["Preferences"]))

    send("close")
    send("save")
    await settle()
    expectTabUnchanged({ harness, createsBefore })
    expect(openDialogNames()).toEqual(["Preferences"])

    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })
    await waitFor(() => expect(openDialogNames()).toEqual([]))

    send("close")
    // Closing the only file lands on a fresh untitled tab: the deferred close
    // now runs exactly as it would from the accelerator itself.
    await waitFor(() => expectPathShown("unnamed"))
    expect(tabCount()).toBe(1)
  })

  it("opens the command palette when Shift produces uppercase P in real browsers", async () => {
    const harness = makeAppHarness()
    harness.renderApp()
    await harness.openIntoActive("/notes/doc.md", "saved")

    fireEvent.keyDown(window, { key: "P", metaKey: true, shiftKey: true })
    await screen.findByPlaceholderText("Run a command…")

    fireEvent.keyDown(window, { key: "P", ctrlKey: true, shiftKey: true })
    await waitFor(() => expect(screen.queryByPlaceholderText("Run a command…")).toBeNull())
  })
})

function expectTabUnchanged(
  context: { harness: ReturnType<typeof makeAppHarness>; createsBefore: number },
): void {
  expectPathShown("/notes/doc.md")
  expect(tabCount()).toBe(1)
  expect(editor.create.mock.calls.length).toBe(context.createsBefore)
  expect(context.harness.services.saveDocument).not.toHaveBeenCalled()
}
