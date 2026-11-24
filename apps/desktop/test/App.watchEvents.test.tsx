import { act, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { EditorView } from "@codemirror/view"
import type { CreateEditorOptions } from "../src/Editor"
import type { TreeEntry } from "../src/FileTree"
import { createAppHarness, resetMountedApps } from "./appHarness"
import { t } from "../src/i18n"

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
  const watchPaths = vi.fn(async (_paths: string[]) => undefined)
  harness.services.watchPaths = watchPaths
  const listDir = vi.fn(async () => [] as TreeEntry[])
  harness.services.listDir = listDir
  const probeVersion = vi.fn(harness.services.readDocumentVersion)
  harness.services.readDocumentVersion = probeVersion
  return { harness, watchPaths, listDir, probeVersion, getChangeHandler: () => changeHandler }
}

describe("native workspace-change events", () => {
  it("watches the restored folder only after allowWorkspaceDir resolves", async () => {
    const { harness, watchPaths } = folderHarness()
    const order: string[] = []
    const pendingReleases: Array<() => void> = []
    harness.services.allowWorkspaceDir = vi.fn(
      () => new Promise<void>(resolve => {
        order.push("allow:start")
        pendingReleases.push(() => {
          order.push("allow:done")
          resolve()
        })
      }),
    )
    watchPaths.mockImplementation(async (paths: string[]) => {
      if (paths.length > 0) order.push(`watch:${paths.join(",")}`)
    })
    harness.renderApp()

    await waitFor(() => {
      expect(pendingReleases.length).toBeGreaterThan(0)
    })
    expect(watchPaths).not.toHaveBeenCalledWith(["/notes"])

    // Release session-init authorization, then watcher authorization if issued.
    await act(async () => {
      while (pendingReleases.length > 0) pendingReleases.shift()!()
    })
    await waitFor(() => {
      if (pendingReleases.length > 0) {
        while (pendingReleases.length > 0) pendingReleases.shift()!()
      }
      expect(watchPaths).toHaveBeenCalledWith(["/notes"])
    })
    const watchIdx = order.indexOf("watch:/notes")
    const lastAllowDone = order.lastIndexOf("allow:done")
    expect(watchIdx).toBeGreaterThan(lastAllowDone)
    expect(lastAllowDone).toBeGreaterThan(-1)
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

  it("retries a rejected folder authorization on the next workspace change", async () => {
    const { harness, getChangeHandler, listDir } = folderHarness()
    // The restored session's own grant succeeds, then every later grant fails —
    // the tree/watcher effects run right after that first call.
    let denyGrants = false
    const allowWorkspaceDir = vi.fn(async () => {
      if (!denyGrants) {
        denyGrants = true
        return
      }
      throw new Error("directory not authorized")
    })
    harness.services.allowWorkspaceDir = allowWorkspaceDir
    harness.renderApp()

    await waitFor(() => {
      expect(harness.services.reportError).toHaveBeenCalledWith(
        `${t("error.folderListingFailed")}: directory not authorized`,
      )
    })

    // Unauthorized: the listing must never be issued for the folder.
    listDir.mockClear()
    await act(async () => { await Promise.resolve() })
    expect(listDir).not.toHaveBeenCalled()

    // The failure is not cached, so the next refresh re-authorizes and lists.
    denyGrants = false
    const grantsBefore = allowWorkspaceDir.mock.calls.length
    await act(async () => {
      getChangeHandler()!(["/notes/watched.md"])
    })
    await waitFor(() => {
      expect(listDir).toHaveBeenCalledWith("/notes")
    })
    expect(allowWorkspaceDir.mock.calls.length).toBeGreaterThan(grantsBefore)
    expect(allowWorkspaceDir).toHaveBeenLastCalledWith("/notes")
  })
})
