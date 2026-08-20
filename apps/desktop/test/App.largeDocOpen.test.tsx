import { fireEvent, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { EditorView } from "@codemirror/view"
import { blockRenderBudget, SAFE_MODE_RENDER_BUDGET_LINES, safeModeRenderingEnabled } from "@omd/engine"
import type { CreateEditorOptions } from "../src/Editor"
import type { DocumentOpenStream } from "../src/desktopServices"
import { createAppHarness, resetMountedApps } from "./appHarness"
import {
  OPEN_READONLY_THRESHOLD_BYTES,
  SAFE_MODE_BYTES,
} from "../src/constants"

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

const MB = 1024 * 1024

/** Cmd+O 触发 runOpen → pickPath，等待 readDocument 完成（或不发生）。 */
async function pressOpenAndSettle(harness: ReturnType<typeof createAppHarness>, path: string) {
  vi.mocked(harness.services.pickOpenPath).mockResolvedValueOnce(path)
  fireEvent.keyDown(window, { key: "o", metaKey: true })
  await act(async () => { await Promise.resolve() })
}

import { act } from "@testing-library/react"

describe("open tiers (Spec 05b)", () => {
  it("opens a NORMAL file with one-shot read and no overlay", async () => {
    const harness = createAppHarness(editor)
    harness.seedFile("/note.md", "hello")
    harness.services.statDocument = vi.fn(async () => ({
      kind: "existing" as const,
      requestedPath: "/note.md",
      sizeBytes: 5,
    }))
    harness.services.confirmLargeOpen = vi.fn(() => true)
    harness.services.readDocumentStreaming = vi.fn()
    harness.renderApp()
    await harness.openFileTab("/note.md", "hello")
    expect(harness.services.confirmLargeOpen).not.toHaveBeenCalled()
    expect(harness.services.readDocumentStreaming).not.toHaveBeenCalled()
    expect(harness.services.readDocument).toHaveBeenCalledWith("/note.md")
    expect(harness.editorForTab(1).getOptions().doc).toBe("hello")
    expect(document.querySelector(".opening-overlay")).toBeNull()
  })

  it("does not flash the overlay while a NORMAL file is still reading", async () => {
    const harness = createAppHarness(editor)
    harness.seedFile("/note.md", "hello")
    harness.services.statDocument = vi.fn(async () => ({
      kind: "existing" as const,
      requestedPath: "/note.md",
      sizeBytes: 5,
    }))
    let resolveRead!: (value: Awaited<ReturnType<typeof harness.services.readDocument>>) => void
    harness.services.readDocument = vi.fn(
      () => new Promise<Awaited<ReturnType<typeof harness.services.readDocument>>>(resolve => {
        resolveRead = resolve
      }),
    )
    harness.renderApp()
    vi.mocked(harness.services.pickOpenPath).mockResolvedValueOnce("/note.md")
    fireEvent.keyDown(window, { key: "o", metaKey: true })
    await act(async () => { await Promise.resolve() })
    expect(document.querySelector(".opening-overlay")).toBeNull()
    await act(async () => {
      resolveRead({
        kind: "existing",
        requestedPath: "/note.md",
        contents: "hello",
        version: { resolvedPath: "/note.md", fingerprint: "v1:note" },
        stats: { byteLength: 5, lineCount: 1 },
      })
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(harness.editorForTab(1).getOptions().doc).toBe("hello")
    })
    expect(document.querySelector(".opening-overlay")).toBeNull()
  })

  it("asks before a LARGE open and honors cancel without reading", async () => {
    const harness = createAppHarness(editor)
    harness.seedFile("/big.md", "big body")
    harness.services.statDocument = vi.fn(async () => ({
      kind: "existing" as const,
      requestedPath: "/big.md",
      sizeBytes: 20 * MB,
    }))
    const confirm = vi.fn(() => false)
    harness.services.confirmLargeOpen = confirm
    harness.renderApp()
    await pressOpenAndSettle(harness, "/big.md")
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
    expect(harness.services.readDocument).not.toHaveBeenCalled()
  })

  it("enters safe mode by bytes for a long-line document under the line threshold", async () => {
    // 10MB+ 的单行文件：行数轴失明，字节轴必须兜住（Spec 05b 盲区回归）。
    // 渐进渲染落地后仍默认 Live —— 安全模式只影响预算/窗口化，不切模式。
    const singleLine = "x".repeat(SAFE_MODE_BYTES + 1)
    const harness = createAppHarness(editor)
    harness.seedFile("/long.md", singleLine)
    harness.services.statDocument = vi.fn(async () => ({
      kind: "existing" as const,
      requestedPath: "/long.md",
      sizeBytes: SAFE_MODE_BYTES + 1,
    }))
    harness.services.confirmLargeOpen = vi.fn(() => true)
    harness.renderApp()
    await harness.openFileTab("/long.md", singleLine)
    expect(harness.editorForTab(1).getOptions().doc).toBe(singleLine)
    // 默认 Live：键完全缺席（undefined 赋值也算缺席的更严口径），防回归。
    expect("defaultLivePreview" in harness.editorForTab(1).getOptions()).toBe(false)
    expect(blockRenderBudget()).toBe(SAFE_MODE_RENDER_BUDGET_LINES)
    expect(safeModeRenderingEnabled()).toBe(true)
  })

  it("opens a HUGE file read-only in live preview after confirm", async () => {
    const harness = createAppHarness(editor)
    harness.seedFile("/huge.md", "huge body\n")
    harness.services.statDocument = vi.fn(async () => ({
      kind: "existing" as const,
      requestedPath: "/huge.md",
      sizeBytes: OPEN_READONLY_THRESHOLD_BYTES + 1,
    }))
    harness.services.confirmReadonlyOpen = vi.fn(() => true)
    harness.renderApp()
    await harness.openFileTab("/huge.md", "huge body\n")
    const options = harness.editorForTab(1).getOptions()
    // 只读挡编辑，但语言/装饰照常装配（plainText 路径已从引擎移除）。
    expect(options.readOnly).toBe(true)
    expect("plainText" in options).toBe(false)
    expect("defaultLivePreview" in options).toBe(false)
    expect(safeModeRenderingEnabled()).toBe(true)
    await waitFor(() => {
      expect(document.querySelector(".update-banner-message")?.textContent)
        .toContain("read-only")
    })
  })

  it("cancels a HUGE open without reading", async () => {
    const harness = createAppHarness(editor)
    harness.seedFile("/huge.md", "huge body")
    harness.services.statDocument = vi.fn(async () => ({
      kind: "existing" as const,
      requestedPath: "/huge.md",
      sizeBytes: OPEN_READONLY_THRESHOLD_BYTES + 1,
    }))
    harness.services.confirmReadonlyOpen = vi.fn(() => false)
    harness.renderApp()
    await pressOpenAndSettle(harness, "/huge.md")
    await waitFor(() =>
      expect(harness.services.confirmReadonlyOpen).toHaveBeenCalledTimes(1))
    expect(harness.services.readDocument).not.toHaveBeenCalled()
  })

  it("streams a LARGE open through chunks instead of one read", async () => {
    const harness = createAppHarness(editor)
    harness.seedFile("/stream.md", "disk copy that must not be used")
    harness.services.statDocument = vi.fn(async () => ({
      kind: "existing" as const,
      requestedPath: "/stream.md",
      sizeBytes: 20 * MB,
    }))
    harness.services.confirmLargeOpen = vi.fn(() => true)
    harness.services.readDocumentStreaming = vi.fn(async (_path, onEvent) => {
      onEvent({ kind: "chunk", index: 0, text: "alpha " })
      onEvent({ kind: "progress", bytesRead: 6, byteLength: 12 })
      onEvent({ kind: "chunk", index: 1, text: "beta" })
      onEvent({ kind: "progress", bytesRead: 10, byteLength: 12 })
      return {
        kind: "existing" as const,
        requestedPath: "/stream.md",
        version: { resolvedPath: "/stream.md", fingerprint: "v1:stream" },
        stats: { byteLength: 10, lineCount: 1 },
      }
    })
    harness.renderApp()
    await harness.openFileTab("/stream.md", "disk copy that must not be used")
    expect(harness.services.readDocument).not.toHaveBeenCalled()
    expect(harness.editorForTab(1).getOptions().doc).toBe("alpha beta")
    // LARGE 档开箱即 Live（渐进渲染），不再以源码模式打开。
    expect("defaultLivePreview" in harness.editorForTab(1).getOptions()).toBe(false)
  })

  it("falls back to a one-shot read when streaming fails", async () => {
    const harness = createAppHarness(editor)
    harness.seedFile("/stream.md", "fallback body")
    harness.services.statDocument = vi.fn(async () => ({
      kind: "existing" as const,
      requestedPath: "/stream.md",
      sizeBytes: 20 * MB,
    }))
    harness.services.confirmLargeOpen = vi.fn(() => true)
    harness.services.readDocumentStreaming = vi.fn(async () => {
      throw { code: "readFailed", message: "channel closed" }
    })
    harness.renderApp()
    await harness.openFileTab("/stream.md", "fallback body")
    expect(harness.services.readDocument).toHaveBeenCalledWith("/stream.md")
    expect(harness.editorForTab(1).getOptions().doc).toBe("fallback body")
  })

  /** LARGE 档流式打开中途取消：流稍后才完成，late 结果必须全部作废。 */
  async function cancelDuringStreamTest(cancel: () => void) {
    const harness = createAppHarness(editor)
    harness.seedFile("/stream.md", "disk copy")
    harness.services.statDocument = vi.fn(async () => ({
      kind: "existing" as const,
      requestedPath: "/stream.md",
      sizeBytes: 20 * MB,
    }))
    harness.services.confirmLargeOpen = vi.fn(() => true)
    let resolveStream!: (value: DocumentOpenStream) => void
    harness.services.readDocumentStreaming = vi.fn((_path, onEvent) => {
      onEvent({ kind: "chunk", index: 0, text: "alpha " })
      onEvent({ kind: "progress", bytesRead: 6, byteLength: 12 })
      return new Promise<DocumentOpenStream>(resolve => { resolveStream = resolve })
    })
    harness.renderApp()
    await pressOpenAndSettle(harness, "/stream.md")
    await waitFor(() => expect(document.querySelector(".opening-overlay")).toBeTruthy())
    cancel()
    expect(document.querySelector(".opening-overlay")).toBeNull()
    // 流迟到完成：不落地任何内容——未授权 assets、未重置编辑器、无 tab。
    await act(async () => {
      resolveStream({
        kind: "existing",
        requestedPath: "/stream.md",
        version: { resolvedPath: "/stream.md", fingerprint: "v1:stream" },
        stats: { byteLength: 10, lineCount: 1 },
      })
      await Promise.resolve()
    })
    expect(harness.services.allowDocumentAssets).not.toHaveBeenCalledWith("/stream.md")
    expect(harness.editorForTab(1).getOptions().doc).toBe("")
    expect(harness.allEditors()).toHaveLength(1)
  }

  it("canceling a streaming open via the overlay button discards late chunks", async () => {
    await cancelDuringStreamTest(() => {
      fireEvent.click(document.querySelector(".opening-overlay-cancel")!)
    })
  })

  it("Escape cancels an in-flight streaming open", async () => {
    await cancelDuringStreamTest(() => {
      fireEvent.keyDown(window, { key: "Escape" })
    })
  })
})

describe("lazy session restore (Spec 05b)", () => {
  it("restores only the active path eagerly and loads the rest on activation", async () => {
    const harness = createAppHarness(editor)
    harness.seedFile("/a.md", "alpha")
    harness.seedFile("/b.md", "beta")
    harness.services.getSessionState = vi.fn(async () => ({
      folder: null,
      openPaths: ["/a.md", "/b.md"],
      activePath: "/a.md",
    }))
    harness.renderApp()
    await waitFor(() => {
      expect(harness.editorForTab(1).getOptions().doc).toBe("alpha")
    })
    expect(harness.services.readDocument).toHaveBeenCalledTimes(1)

    harness.activateTab(2)
    await waitFor(() => {
      expect(harness.editorForTab(2).getOptions().doc).toBe("beta")
    })
    expect(harness.services.readDocument).toHaveBeenCalledTimes(2)
  })
})
