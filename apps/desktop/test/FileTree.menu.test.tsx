import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { EditorView } from "@codemirror/view"
import type { CreateEditorOptions } from "../src/Editor"
import { FileTree } from "../src/FileTree"
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
  it("creates a new markdown file in the clicked file's parent, opens and focuses it, and refreshes the listing", async () => {
    const harness = makeAppHarness()
    let entries = [
      { name: "doc.md", path: "/notes/doc.md", is_dir: false },
      { name: "untitled.md", path: "/notes/untitled.md", is_dir: false },
    ]
    harness.services.listDir = vi.fn(async () => entries)
    vi.spyOn(window, "prompt").mockImplementation((_message, defaultValue) => String(defaultValue))
    vi.mocked(harness.services.createMarkdown).mockImplementation(async (dir, name) => {
      entries = [...entries, { name, path: `${dir}/${name}`, is_dir: false }]
      harness.seedFile(`${dir}/${name}`, "")
      return `${dir}/${name}`
    })

    harness.renderApp()
    await harness.openIntoActive("/notes/doc.md", "saved")
    await waitFor(() => expect(screen.getByText("untitled.md")).toBeTruthy())
    const editorsBefore = new Set(harness.allEditors())

    await openTreeMenu("doc.md")
    fireEvent.click(screen.getByRole("menuitem", { name: "New File" }))

    await waitFor(() => {
      expect(window.prompt).toHaveBeenCalledWith("New file name", "untitled-2.md")
    })
    await waitFor(() => {
      expect(harness.services.createMarkdown).toHaveBeenCalledWith("/notes", "untitled-2.md")
      expect(screen.getByText("untitled-2.md", { selector: ".filetree-name" })).toBeTruthy()
    })
    expect(vi.mocked(harness.services.listDir).mock.calls.slice(-1)[0]?.[0]).toBe("/notes")
    await waitFor(() => expectPathShown("/notes/untitled-2.md"))
    const added = harness.allEditors().filter(handle => !editorsBefore.has(handle))
    expect(added).toHaveLength(1)
    expect(added[0].view.focus).toHaveBeenCalled()
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

  it("abandons an in-flight open when the file is deleted before the open lands", async () => {
    // 新建→立刻删除的竞态：openPath 停在 allowDocumentAssets 时删除完成，
    // 放行后 openPath 必须自检作废登记并放弃 —— 不加 tab、不报错。
    const harness = makeAppHarness()
    let entries = [
      { name: "doc.md", path: "/notes/doc.md", is_dir: false },
      { name: "untitled.md", path: "/notes/untitled.md", is_dir: false },
    ]
    harness.services.listDir = vi.fn(async () => entries)
    vi.spyOn(window, "prompt").mockImplementation((_message, defaultValue) => String(defaultValue))
    vi.mocked(harness.services.createMarkdown).mockImplementation(async (dir, name) => {
      entries = [...entries, { name, path: `${dir}/${name}`, is_dir: false }]
      harness.seedFile(`${dir}/${name}`, "")
      return `${dir}/${name}`
    })
    vi.mocked(harness.services.deletePath).mockImplementation(async path => {
      entries = entries.filter(entry => entry.path !== path)
    })

    harness.renderApp()
    await harness.openIntoActive("/notes/doc.md", "saved")
    let releaseAssets!: () => void
    const assetsHeld = new Promise<void>(resolve => { releaseAssets = resolve })
    vi.mocked(harness.services.allowDocumentAssets).mockImplementation(async () => {
      await assetsHeld
    })

    await openTreeMenu("doc.md")
    fireEvent.click(screen.getByRole("menuitem", { name: "New File" }))
    await waitFor(() => expect(screen.getByText("untitled-2.md", { selector: ".filetree-name" })).toBeTruthy())

    await openTreeMenu("untitled-2.md")
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }))
    await waitFor(() => expect(harness.services.deletePath).toHaveBeenCalledWith("/notes/untitled-2.md"))
    await waitFor(() => expect(screen.queryByText("untitled-2.md")).toBeNull())

    await act(async () => {
      releaseAssets()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expectPathShown("/notes/doc.md")
    expect(screen.queryByText("untitled-2.md")).toBeNull()
    expect(vi.mocked(harness.services.reportError)).not.toHaveBeenCalled()
  })

  it("closes a tab that lands inside the delete await window", async () => {
    // 竞态的另一侧：tab 在 await deletePath 让出的窗口内才落地，删除完成后的
    // 重查必须把它关掉（旧实现在 confirm 前快照 openTab，会漏掉）。
    const harness = makeAppHarness()
    let entries = [
      { name: "doc.md", path: "/notes/doc.md", is_dir: false },
      { name: "untitled.md", path: "/notes/untitled.md", is_dir: false },
    ]
    harness.services.listDir = vi.fn(async () => entries)
    vi.spyOn(window, "prompt").mockImplementation((_message, defaultValue) => String(defaultValue))
    vi.mocked(harness.services.createMarkdown).mockImplementation(async (dir, name) => {
      entries = [...entries, { name, path: `${dir}/${name}`, is_dir: false }]
      harness.seedFile(`${dir}/${name}`, "")
      return `${dir}/${name}`
    })
    let releaseAssets!: () => void
    const assetsHeld = new Promise<void>(resolve => { releaseAssets = resolve })
    let releaseDelete!: () => void
    const deleteHeld = new Promise<void>(resolve => { releaseDelete = resolve })
    vi.mocked(harness.services.deletePath).mockImplementation(async path => {
      await deleteHeld
      entries = entries.filter(entry => entry.path !== path)
    })

    harness.renderApp()
    await harness.openIntoActive("/notes/doc.md", "saved")
    vi.mocked(harness.services.allowDocumentAssets).mockImplementation(async () => {
      await assetsHeld
    })

    await openTreeMenu("doc.md")
    fireEvent.click(screen.getByRole("menuitem", { name: "New File" }))
    await waitFor(() => expect(screen.getByText("untitled-2.md", { selector: ".filetree-name" })).toBeTruthy())

    // 删除先行（deletePath 停住），随后在途打开落地 —— tab 出现在竞态窗口内。
    await openTreeMenu("untitled-2.md")
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }))
    await waitFor(() => expect(harness.services.deletePath).toHaveBeenCalledWith("/notes/untitled-2.md"))
    releaseAssets()
    await waitFor(() => expectPathShown("/notes/untitled-2.md"))

    releaseDelete()
    await waitFor(() => expect(screen.queryByText("untitled-2.md", { selector: ".filetree-name" })).toBeNull())
    expectPathShown("/notes/doc.md")
    expect(vi.mocked(harness.services.reportError)).not.toHaveBeenCalled()
  })

  it("reveals the selected path in the file manager", async () => {
    const harness = makeAppHarness()
    harness.services.listDir = vi.fn(async () => [
      { name: "doc.md", path: "/notes/doc.md", is_dir: false },
    ])

    harness.renderApp()
    await harness.openIntoActive("/notes/doc.md", "saved")

    await openTreeMenu("doc.md")
    fireEvent.click(screen.getByRole("menuitem", { name: "Reveal in File Manager" }))

    await waitFor(() => expect(harness.services.revealInFinder).toHaveBeenCalledWith("/notes/doc.md"))
  })

  it("creates a file in the workspace root from the empty tree", async () => {
    const harness = makeAppHarness()
    let entries: Array<{ name: string; path: string; is_dir: boolean }> = []
    harness.services.listDir = vi.fn(async () => entries)
    vi.spyOn(window, "prompt").mockImplementation((_message, defaultValue) => String(defaultValue))
    vi.mocked(harness.services.createMarkdown).mockImplementation(async (dir, name) => {
      entries = [{ name, path: `${dir}/${name}`, is_dir: false }]
      harness.seedFile(`${dir}/${name}`, "")
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
      expect(screen.getByText("untitled.md", { selector: ".filetree-name" })).toBeTruthy()
    })
    await waitFor(() => expectPathShown("/notes/untitled.md"))
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

describe("FileTree shortcut hints", () => {
  const MACOS_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)"
  const WINDOWS_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0"

  function withUserAgent(userAgent: string, run: () => void): void {
    const original = Object.getOwnPropertyDescriptor(window.navigator, "userAgent")
    Object.defineProperty(window.navigator, "userAgent", { value: userAgent, configurable: true })
    try {
      run()
    } finally {
      if (original) Object.defineProperty(window.navigator, "userAgent", original)
    }
  }

  function renderFileTree(): void {
    render(
      <FileTree
        folder="/notes"
        rows={[]}
        activePath={null}
        onOpenFile={() => {}}
        onToggleDir={() => {}}
        onSearch={() => {}}
        onCollapse={() => {}}
      />,
    )
  }

  it("shows macOS glyphs in the search kbd and collapse tooltip on mac", () => {
    withUserAgent(MACOS_UA, () => {
      renderFileTree()
      expect(document.querySelector(".filetree-search-bar kbd")?.textContent).toBe("⇧⌘F")
      expect(screen.getByRole("button", { name: /hide sidebar/i }).getAttribute("title"))
        .toBe("Hide sidebar (⌘\\)")
    })
  })

  it("shows Ctrl forms in the search kbd and collapse tooltip on windows", () => {
    withUserAgent(WINDOWS_UA, () => {
      renderFileTree()
      expect(document.querySelector(".filetree-search-bar kbd")?.textContent).toBe("Ctrl+Shift+F")
      expect(screen.getByRole("button", { name: /hide sidebar/i }).getAttribute("title"))
        .toBe("Hide sidebar (Ctrl+\\)")
    })
  })
})
