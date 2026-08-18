import { fireEvent, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { EditorView } from "@codemirror/view"
import type { CreateEditorOptions } from "../src/Editor"
import { createFileSession, recoveryKey } from "../src/session"
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

afterEach(() => {
  vi.restoreAllMocks()
  resetMountedApps()
})

async function openTreeMenu(label: string): Promise<void> {
  const sidebar = document.getElementById("primary-sidebar")
  if (!sidebar) throw new Error("primary sidebar is not mounted")
  fireEvent.contextMenu(within(sidebar).getByRole("button", { name: label }))
  await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy())
}

describe("FileTree sidebar menu", () => {
  it("creates a new markdown file in the clicked file's parent and refreshes the listing", async () => {
    const harness = makeAppHarness()
    let entries = [
      { name: "doc.md", path: "/notes/doc.md", is_dir: false },
      { name: "untitled.md", path: "/notes/untitled.md", is_dir: false },
    ]
    harness.services.listDir = vi.fn(async () => entries)
    vi.spyOn(window, "prompt").mockImplementation((_message, defaultValue) => String(defaultValue))
    vi.mocked(harness.services.createMarkdown).mockImplementation(async (dir, name) => {
      entries = [...entries, { name, path: `${dir}/${name}`, is_dir: false }]
      return `${dir}/${name}`
    })

    harness.renderApp()
    await harness.openIntoActive("/notes/doc.md", "saved")
    await waitFor(() => expect(screen.getByText("untitled.md")).toBeTruthy())

    await openTreeMenu("doc.md")
    fireEvent.click(screen.getByRole("menuitem", { name: "New File" }))

    await waitFor(() => {
      expect(window.prompt).toHaveBeenCalledWith("New file name", "untitled-2.md")
    })
    await waitFor(() => {
      expect(harness.services.createMarkdown).toHaveBeenCalledWith("/notes", "untitled-2.md")
      expect(screen.getByText("untitled-2.md")).toBeTruthy()
    })
    expect(vi.mocked(harness.services.listDir).mock.calls.slice(-1)[0]?.[0]).toBe("/notes")
  })

  it("creates a new folder in the clicked directory and refreshes the listing", async () => {
    const harness = makeAppHarness()
    const childEntries: Record<string, Array<{ name: string; path: string; is_dir: boolean }>> = {
      "/notes": [{ name: "drafts", path: "/notes/drafts", is_dir: true }],
      "/notes/drafts": [],
    }
    harness.services.listDir = vi.fn(async path => childEntries[path] ?? [])
    vi.spyOn(window, "prompt").mockReturnValue("ideas")
    vi.mocked(harness.services.createDir).mockImplementation(async (dir: string, name: string) => {
      childEntries[dir] = [...(childEntries[dir] ?? []), { name, path: `${dir}/${name}`, is_dir: true }]
      childEntries[`${dir}/${name}`] = []
      return `${dir}/${name}`
    })

    harness.renderApp()
    await harness.openIntoActive("/notes/doc.md", "saved")
    await waitFor(() => expect(screen.getByText("drafts")).toBeTruthy())

    await openTreeMenu("drafts")
    fireEvent.click(screen.getByRole("menuitem", { name: "New Folder" }))

    expect(window.prompt).toHaveBeenCalledWith("New folder name", "untitled-folder")
    await waitFor(() => {
      expect(harness.services.createDir).toHaveBeenCalledWith("/notes/drafts", "ideas")
    })
    expect(vi.mocked(harness.services.listDir).mock.calls.slice(-1)[0]?.[0]).toBe("/notes/drafts")
  })

  it("renames an open markdown file without rereading it and refreshes the listing", async () => {
    const harness = makeAppHarness()
    let entries = [{ name: "doc.md", path: "/notes/doc.md", is_dir: false }]
    harness.services.listDir = vi.fn(async () => entries)
    vi.spyOn(window, "prompt").mockReturnValue("renamed")
    vi.mocked(harness.services.renamePath).mockImplementation(async (_from: string, toName: string) => {
      entries = [{ name: toName, path: `/notes/${toName}`, is_dir: false }]
      return `/notes/${toName}`
    })

    harness.renderApp()
    await harness.openIntoActive("/notes/doc.md", "saved")
    expect(harness.services.readDocument).toHaveBeenCalledTimes(1)

    await openTreeMenu("doc.md")
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }))

    await waitFor(() => {
      expect(harness.services.renamePath).toHaveBeenCalledWith("/notes/doc.md", "renamed.md")
      expectPathShown("/notes/renamed.md")
    })
    expect(harness.services.readDocument).toHaveBeenCalledTimes(1)
    expect(vi.mocked(harness.services.listDir).mock.calls.slice(-1)[0]?.[0]).toBe("/notes")
  })

  it("deletes a file after confirmation and refreshes the listing", async () => {
    const harness = makeAppHarness()
    let entries = [
      { name: "doc.md", path: "/notes/doc.md", is_dir: false },
      { name: "other.md", path: "/notes/other.md", is_dir: false },
    ]
    harness.services.listDir = vi.fn(async () => entries)
    vi.mocked(harness.services.deletePath).mockImplementation(async (path: string) => {
      entries = entries.filter(entry => entry.path !== path)
    })

    harness.renderApp()
    await harness.openIntoActive("/notes/doc.md", "saved")
    await waitFor(() => expect(screen.getByText("other.md")).toBeTruthy())

    await openTreeMenu("other.md")
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }))

    expect(harness.services.confirmDelete).toHaveBeenCalledWith("/notes/other.md")
    await waitFor(() => {
      expect(harness.services.deletePath).toHaveBeenCalledWith("/notes/other.md")
      expect(screen.queryByText("other.md")).toBeNull()
    })
    expect(vi.mocked(harness.services.listDir).mock.calls.slice(-1)[0]?.[0]).toBe("/notes")
  })

  it("confirms before deleting a dirty open file and replaces the last tab", async () => {
    const harness = makeAppHarness()
    let entries = [{ name: "doc.md", path: "/notes/doc.md", is_dir: false }]
    harness.services.listDir = vi.fn(async () => entries)
    vi.mocked(harness.services.deletePath).mockImplementation(async path => {
      entries = entries.filter(entry => entry.path !== path)
    })

    harness.renderApp()
    await harness.openIntoActive("/notes/doc.md", "saved")
    harness.editorForTab(1).emit({ doc: "dirty", docChanged: true, pendingNormalization: null })

    await openTreeMenu("doc.md")
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }))

    expect(harness.services.confirmClose).toHaveBeenCalledOnce()
    expect(harness.services.confirmDelete).toHaveBeenCalledWith("/notes/doc.md")
    await waitFor(() => expectPathShown("unnamed"))
    expect(screen.queryByText("doc.md")).toBeNull()
  })

  it("sees edits made inside the materialization window when dirty-checking a delete", async () => {
    // Spec 05a 回归护栏：docsRef 滞后 250ms（物化节奏），删除前的脏检查必须先 flush，
    // 否则窗口内的编辑被判定为"未修改"→ 跳过确认 → 删文件丢内容。
    const harness = makeAppHarness()
    const entries = [{ name: "doc.md", path: "/notes/doc.md", is_dir: false }]
    harness.services.listDir = vi.fn(async () => entries)
    // confirmClose 返回 false：只要脏检查看到编辑，删除就应被拦下。
    vi.mocked(harness.services.confirmClose).mockReturnValue(false)

    harness.renderApp({ docMaterializeMs: 250 })
    await harness.openIntoActive("/notes/doc.md", "saved")
    harness.editorForTab(1).emit({ doc: "edited just now", docChanged: true, pendingNormalization: null })

    await openTreeMenu("doc.md")
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }))

    expect(harness.services.confirmClose).toHaveBeenCalledOnce()
    expect(harness.services.deletePath).not.toHaveBeenCalled()
  })

  it("reveals the selected path in Finder", async () => {
    const harness = makeAppHarness()
    harness.services.listDir = vi.fn(async () => [
      { name: "doc.md", path: "/notes/doc.md", is_dir: false },
    ])

    harness.renderApp()
    await harness.openIntoActive("/notes/doc.md", "saved")

    await openTreeMenu("doc.md")
    fireEvent.click(screen.getByRole("menuitem", { name: "Reveal in Finder" }))

    await waitFor(() => expect(harness.services.revealInFinder).toHaveBeenCalledWith("/notes/doc.md"))
  })

  it("creates a file in the workspace root from the empty tree", async () => {
    const harness = makeAppHarness()
    let entries: Array<{ name: string; path: string; is_dir: boolean }> = []
    harness.services.listDir = vi.fn(async () => entries)
    vi.spyOn(window, "prompt").mockImplementation((_message, defaultValue) => String(defaultValue))
    vi.mocked(harness.services.createMarkdown).mockImplementation(async (dir, name) => {
      entries = [{ name, path: `${dir}/${name}`, is_dir: false }]
      return `${dir}/${name}`
    })

    harness.renderApp()
    await harness.openIntoActive("/notes/doc.md", "saved")
    fireEvent.contextMenu(screen.getByRole("tree", { name: "notes" }))
    await waitFor(() => expect(screen.getByRole("menu", { name: "Folder actions" })).toBeTruthy())
    expect(screen.queryByRole("menuitem", { name: "Rename" })).toBeNull()
    fireEvent.click(screen.getByRole("menuitem", { name: "New File" }))

    await waitFor(() => {
      expect(harness.services.createMarkdown).toHaveBeenCalledWith("/notes", "untitled.md")
      expect(screen.getByText("untitled.md")).toBeTruthy()
    })
  })

  it("clears the old recovery draft after renaming a dirty open file", async () => {
    const harness = makeAppHarness()
    let entries = [{ name: "doc.md", path: "/notes/doc.md", is_dir: false }]
    harness.services.listDir = vi.fn(async () => entries)
    vi.spyOn(window, "prompt").mockReturnValue("renamed")
    vi.mocked(harness.services.renamePath).mockImplementation(async (_from, toName) => {
      entries = [{ name: toName, path: `/notes/${toName}`, is_dir: false }]
      return `/notes/${toName}`
    })

    harness.renderApp()
    await harness.openIntoActive("/notes/doc.md", "saved")
    harness.editorForTab(1).emit({ doc: "dirty", docChanged: true, pendingNormalization: null })

    await openTreeMenu("doc.md")
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }))

    await waitFor(() => {
      expect(harness.services.clearRecovery).toHaveBeenCalledWith(
        recoveryKey(createFileSession(1, "/notes/doc.md", "saved", {
          resolvedPath: "/notes/doc.md",
          fingerprint: "0",
        })),
      )
      expectPathShown("/notes/renamed.md", { dirty: true })
    })
  })
})
