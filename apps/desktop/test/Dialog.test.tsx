import { useState } from "react"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { EditorView } from "@codemirror/view"
import type { CreateEditorOptions } from "../src/Editor"
import { Dialog, isAnyModalOpen } from "../src/Dialog"
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

afterEach(() => {
  vi.restoreAllMocks()
  resetMountedApps()
})

/** Minimal shell around the real primitive: a trigger, two focusable siblings
 * inside, one `tabindex="-1"` option that must stay out of the Tab cycle, and
 * the app's background regions. */
function DialogHost() {
  const [isOpen, setIsOpen] = useState(false)
  return (
    <>
      <div className="topbar">
        <button type="button">Topbar action</button>
      </div>
      <button type="button" onClick={() => setIsOpen(true)}>Open dialog</button>
      <div className="workspace-body">
        <button type="button">Outside action</button>
      </div>
      <Dialog
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        ariaLabel="Test dialog"
        className="test-dialog"
      >
        <button type="button">First</button>
        <button type="button" tabIndex={-1}>Skipped option</button>
        <button type="button">Last</button>
      </Dialog>
    </>
  )
}

function openDialog(): HTMLElement {
  const opener = screen.getByRole("button", { name: "Open dialog" })
  opener.focus()
  fireEvent.click(opener)
  return opener
}

describe("Dialog primitive", () => {
  it("moves initial focus into the dialog and marks the shell inert", () => {
    render(<DialogHost />)
    expect(isAnyModalOpen()).toBe(false)

    openDialog()

    expect(isAnyModalOpen()).toBe(true)
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "First" }))
    expect(document.querySelector(".topbar")?.getAttribute("data-modal-inert")).toBe("true")
    expect(document.querySelector(".workspace-body")?.getAttribute("data-modal-inert")).toBe("true")
  })

  it("traps Tab at the last and Shift+Tab at the first focusable element", () => {
    render(<DialogHost />)
    openDialog()
    const first = screen.getByRole("button", { name: "First" })
    const last = screen.getByRole("button", { name: "Last" })
    // A tabindex="-1" row is never part of the cycle.
    expect(screen.getByRole("button", { name: "Skipped option" }).tabIndex).toBe(-1)

    last.focus()
    fireEvent.keyDown(last, { key: "Tab" })
    expect(document.activeElement).toBe(first)

    first.focus()
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true })
    expect(document.activeElement).toBe(last)
  })

  it("closes on Escape and hands focus back to the opener", () => {
    render(<DialogHost />)
    const opener = openDialog()

    fireEvent.keyDown(screen.getByRole("button", { name: "First" }), { key: "Escape" })

    expect(screen.queryByRole("dialog")).toBeNull()
    expect(isAnyModalOpen()).toBe(false)
    expect(document.activeElement).toBe(opener)
    expect(document.querySelector(".topbar")?.hasAttribute("data-modal-inert")).toBe(false)
    expect(document.querySelector(".workspace-body")?.hasAttribute("data-modal-inert")).toBe(false)
  })

  it("ignores Escape that commits an IME composition", () => {
    render(<DialogHost />)
    openDialog()

    fireEvent.keyDown(screen.getByRole("button", { name: "First" }), {
      key: "Escape",
      keyCode: 229,
    })

    expect(screen.getByRole("dialog")).toBeTruthy()
  })
})

describe("global shortcut isolation (UX-01)", () => {
  it("keeps the active tab open when Cmd+W arrives while settings is open", async () => {
    const harness = createAppHarness(editor)
    harness.renderApp()
    await harness.openIntoActive("/notes/doc.md", "saved")

    fireEvent.keyDown(window, { key: ",", metaKey: true })
    expect(screen.getByRole("dialog", { name: "Preferences" })).toBeTruthy()

    fireEvent.keyDown(window, { key: "w", metaKey: true })

    const dialogs = screen.getAllByRole("dialog")
    expect(dialogs).toHaveLength(1)
    expect(document.querySelectorAll(".topbar-tabs .tab")).toHaveLength(1)
    expectPathShown("/notes/doc.md")
    expect(harness.services.confirmClose).not.toHaveBeenCalled()
  })

  it("keeps the active tab open when Cmd+W arrives while the command palette is open", async () => {
    const harness = createAppHarness(editor)
    harness.renderApp()
    await harness.openIntoActive("/notes/doc.md", "saved")

    fireEvent.keyDown(window, { key: "p", shiftKey: true, metaKey: true })
    await waitFor(() => expect(screen.getByRole("combobox")).toBeTruthy())

    fireEvent.keyDown(window, { key: "w", metaKey: true })

    expect(screen.getByRole("combobox")).toBeTruthy()
    expect(document.querySelectorAll(".topbar-tabs .tab")).toHaveLength(1)
    expectPathShown("/notes/doc.md")
  })

  it("still closes the active tab once the dialog is gone", async () => {
    const harness = createAppHarness(editor)
    harness.renderApp()
    await harness.openIntoActive("/notes/doc.md", "saved")

    fireEvent.keyDown(window, { key: ",", metaKey: true })
    fireEvent.click(screen.getByRole("button", { name: "Done" }))
    await act(async () => { await Promise.resolve() })
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())

    harness.requestCloseTab(1)

    await waitFor(() => expectPathShown("unnamed"))
  })
})
