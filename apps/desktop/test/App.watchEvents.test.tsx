import { act, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { EditorView } from "@codemirror/view"
import type { CreateEditorOptions } from "../src/Editor"
import type { TreeEntry } from "../src/FileTree"
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
  resetMountedApps()
})

function folderHarness() {
  const harness = createAppHarness(editor)
  harness.seedFile("/notes/watched.md", "# watched")
  harness.services.getSessionState = vi.fn(async () => ({
    folder: "/notes",
    openPaths: ["/notes/watched.md"],
    activePath: "/notes/watched.md",
  }))
  let changeHandler: ((paths: string[]) => void) | undefined
  harness.services.listenWorkspaceChange = next => {
    changeHandler = next
    return () => { changeHandler = undefined }
  }
  const watchPaths = vi.fn(async () => undefined)
  harness.services.watchPaths = watchPaths
  const listDir = vi.fn(async () => [] as TreeEntry[])
  harness.services.listDir = listDir
  const probeVersion = vi.fn(harness.services.readDocumentVersion)
  harness.services.readDocumentVersion = probeVersion
  return { harness, watchPaths, listDir, probeVersion, getChangeHandler: () => changeHandler }
}

describe("native workspace-change events", () => {
  it("watches the restored folder", async () => {
    const { harness, watchPaths } = folderHarness()
    harness.renderApp()

    await waitFor(() => {
      expect(watchPaths).toHaveBeenCalledWith(["/notes"])
    })
  })

  it("probes open tabs and refreshes the tree when an event arrives", async () => {
    const { harness, getChangeHandler, probeVersion, listDir } = folderHarness()
    harness.renderApp()
    await waitFor(() => {
      expect(getChangeHandler()).toBeDefined()
    })
    probeVersion.mockClear()
    listDir.mockClear()

    await act(async () => {
      getChangeHandler()!(["/notes/watched.md"])
    })

    await waitFor(() => {
      expect(probeVersion).toHaveBeenCalledWith("/notes/watched.md")
    })
    expect(listDir).toHaveBeenCalled()
  })
})
