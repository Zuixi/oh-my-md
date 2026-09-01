import { fireEvent, screen, waitFor } from "@testing-library/react"
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

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe("stale workspace folder and repeated listing errors", () => {
  it("drops a restored session whose folder no longer exists and reports once", async () => {
    const harness = createAppHarness(editor)
    harness.services.getSessionState = vi.fn(async () => ({
      folder: "/gone",
      openPaths: ["/gone/a.md"],
      activePath: "/gone/a.md",
    }))
    harness.services.listDir = vi.fn(async () => {
      throw new Error("path is not a directory")
    })
    const readDocument = vi.fn(harness.services.readDocument)
    harness.services.readDocument = readDocument

    harness.renderApp()

    // 失效会话：单次明确提示，而不是 folderListingFailed 的重复轰炸
    await waitFor(() => {
      expect(harness.services.reportError).toHaveBeenCalledWith(t("error.workspaceFolderMissing"))
    })
    expect(harness.services.reportError).toHaveBeenCalledTimes(1)
    // 死目录下的 tab 不应再尝试读取
    expect(readDocument).not.toHaveBeenCalledWith("/gone/a.md")
  })

  it("reports each distinct tree failure once instead of on every retry", async () => {
    const harness = createAppHarness(editor)
    harness.services.getSessionState = vi.fn(async () => ({
      folder: "/notes",
      openPaths: [],
      activePath: null,
    }))
    // 根目录可列出（树渲染出子目录行）；子目录按需翻转成败，模拟运行期故障。
    let childError: string | null = null
    harness.services.listDir = vi.fn(async (path: string): Promise<TreeEntry[]> => {
      if (path === "/notes") return [{ name: "drafts", path: "/notes/drafts", is_dir: true }]
      if (childError) throw new Error(childError)
      return []
    })

    harness.renderApp()
    const drafts = await screen.findByText("drafts")
    expect(harness.services.reportError).not.toHaveBeenCalled()

    // 展开 drafts 失败 → 第一次上报
    childError = "path is not a directory"
    fireEvent.click(drafts)
    await waitFor(() => {
      expect(harness.services.reportError).toHaveBeenCalledOnce()
    })
    expect(harness.services.reportError).toHaveBeenCalledWith(
      `${t("error.folderListingFailed")}: path is not a directory`,
    )

    // 折叠再展开（或反复点击重试）：同一错误保持静默——状态没变就不重复打扰
    fireEvent.click(drafts)
    await sleep(30)
    fireEvent.click(drafts)
    await sleep(30)
    fireEvent.click(drafts)
    await sleep(30)
    expect(harness.services.reportError).toHaveBeenCalledOnce()

    // 错误内容变化（新的故障形态）必须再次上报——对变化保持敏感
    childError = "permission denied"
    fireEvent.click(drafts)
    await sleep(30)
    fireEvent.click(drafts)
    await sleep(30)
    await waitFor(() => {
      expect(harness.services.reportError).toHaveBeenCalledTimes(2)
    })
    expect(harness.services.reportError).toHaveBeenLastCalledWith(
      `${t("error.folderListingFailed")}: permission denied`,
    )
  })
})
