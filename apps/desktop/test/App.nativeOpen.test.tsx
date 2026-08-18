import { act, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { EditorView } from "@codemirror/view"
import type { CreateEditorOptions } from "../src/Editor"
import type { SavedSessionState } from "../src/sessionRestore"
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

describe("native open-file delivery", () => {
  it("opens launch-time pending files instead of restoring the session", async () => {
    const harness = createAppHarness(editor)
    harness.seedFile("/notes/launch.md", "# launched")
    harness.services.takePendingOpenFiles = vi.fn(async () => ["/notes/launch.md"])
    const sessionState: SavedSessionState = {
      folder: "/notes",
      openPaths: ["/notes/session.md"],
      activePath: "/notes/session.md",
    }
    harness.services.getSessionState = vi.fn(async () => sessionState)

    harness.renderApp()
    await waitFor(() => {
      expectPathShown("/notes/launch.md")
    })

    expect(harness.services.getSessionState).not.toHaveBeenCalled()
    expect(harness.services.readDocument).toHaveBeenCalledWith("/notes/launch.md")
  })

  it("restores the session when no pending files exist", async () => {
    const harness = createAppHarness(editor)
    harness.seedFile("/notes/session.md", "# session")
    harness.services.takePendingOpenFiles = vi.fn(async () => [])
    harness.services.getSessionState = vi.fn(async () => ({
      folder: "/notes",
      openPaths: ["/notes/session.md"],
      activePath: "/notes/session.md",
    }))

    harness.renderApp()
    await waitFor(() => {
      expectPathShown("/notes/session.md")
    })

    expect(harness.services.getSessionState).toHaveBeenCalled()
  })

  it("opens files delivered through the open-file event after mount", async () => {
    const harness = createAppHarness(editor)
    harness.seedFile("/notes/evented.md", "# evented")
    let handler: ((path: string) => void) | undefined
    harness.services.listenOpenFile = next => {
      handler = next
      return () => { handler = undefined }
    }

    harness.renderApp()
    await waitFor(() => {
      expect(handler).toBeDefined()
    })

    await act(async () => {
      handler?.("/notes/evented.md")
    })
    await waitFor(() => {
      expectPathShown("/notes/evented.md")
    })
  })

  it("opens the first markdown path from a native drag-drop and ignores others", async () => {
    const harness = createAppHarness(editor)
    harness.seedFile("/notes/dragged.md", "# dragged")
    let dropHandler: ((paths: string[]) => void) | undefined
    harness.services.listenDragDrop = next => {
      dropHandler = next
      return () => { dropHandler = undefined }
    }

    harness.renderApp()
    await waitFor(() => {
      expect(dropHandler).toBeDefined()
    })

    await act(async () => {
      dropHandler?.(["/notes/readme.txt", "/notes/dragged.md"])
    })
    await waitFor(() => {
      expectPathShown("/notes/dragged.md")
    })
  })
})
