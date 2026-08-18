import { fireEvent, screen, waitFor } from "@testing-library/react"
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

afterEach(() => {
  resetMountedApps()
})

function openFolderHarness() {
  const harness = createAppHarness(editor)
  harness.seedFile("/notes/alpha.md", "# alpha")
  harness.seedFile("/notes/sub/beta.md", "# beta")
  harness.services.getSessionState = vi.fn(async () => ({
    folder: "/notes",
    openPaths: [],
    activePath: null,
  }))
  harness.services.listMarkdownFiles = vi.fn(async () => ({
    paths: ["/notes/alpha.md", "/notes/sub/beta.md"],
    truncated: false,
  }))
  return harness
}

describe("quick open", () => {
  it("opens via ⌘P, filters, and opens the chosen file", async () => {
    const harness = openFolderHarness()
    harness.renderApp()
    // Session restore must finish so the workspace folder is set before ⌘P.
    await waitFor(() => {
      expect(harness.services.allowWorkspaceDir).toHaveBeenCalledWith("/notes")
    })

    fireEvent.keyDown(window, { key: "p", metaKey: true })
    const input = await waitFor(() => screen.getByLabelText("Go to file…"))
    expect(harness.services.listMarkdownFiles).toHaveBeenCalledWith("/notes")

    fireEvent.change(input, { target: { value: "beta" } })
    fireEvent.keyDown(input, { key: "Enter" })

    await waitFor(() => {
      expectPathShown("/notes/sub/beta.md")
    })
  })

  it("shows the truncation note when the Rust listing is capped", async () => {
    const harness = openFolderHarness()
    harness.services.listMarkdownFiles = vi.fn(async () => ({
      paths: ["/notes/alpha.md"],
      truncated: true,
    }))
    harness.renderApp()
    await waitFor(() => {
      expect(harness.services.allowWorkspaceDir).toHaveBeenCalledWith("/notes")
    })

    fireEvent.keyDown(window, { key: "p", metaKey: true })
    await waitFor(() => {
      expect(document.querySelector(".omd-quick-open-note")?.textContent).toContain("truncated")
    })
  })

  it("hints instead of opening when no folder is loaded", async () => {
    const harness = createAppHarness(editor)
    harness.renderApp()

    fireEvent.keyDown(window, { key: "p", metaKey: true })
    await waitFor(() => {
      expect(document.querySelector(".save-transient-status")?.textContent)
        .toContain("Open a folder")
    })
    expect(screen.queryByLabelText("Go to file…")).toBeNull()
  })
})
