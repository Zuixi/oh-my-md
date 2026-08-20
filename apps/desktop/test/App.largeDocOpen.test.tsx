import { fireEvent, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { EditorView } from "@codemirror/view"
import { Text } from "@codemirror/state"
import { blockRenderBudget, SAFE_MODE_RENDER_BUDGET_LINES, safeModeRenderingEnabled } from "@omd/engine"
import type { CreateEditorOptions } from "../src/Editor"
import type { DocumentOpenStream } from "../src/desktopServices"
import { createAppHarness, expectPathShown, resetMountedApps, versionFor, type FakeEditorHandle } from "./appHarness"
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

/** Task 10：流式打开必须把 chunk 组装的 Text 交给编辑器（而非整串字符串）。 */
function streamedDocText(handle: FakeEditorHandle): Text {
  const doc = handle.getOptions().doc
  if (typeof doc !== "object" || doc === null) {
    throw new Error(`expected a Text doc from the streaming path, got: ${typeof doc}`)
  }
  return doc
}

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
    // Task 10：编辑器收到的是 chunk 组装的 Text（而非 join 后的整串），
    // 且与整串 split 的参照 Text 同构 —— EditorState.create 由此跳过整串切行。
    const doc = streamedDocText(harness.editorForTab(1))
    expect(doc.eq(Text.of("alpha beta".split(/\r\n?|\n/)))).toBe(true)
    expect(harness.editorForTab(1).view.state.doc).toBe(doc)
    // LARGE 档开箱即 Live（渐进渲染），不再以源码模式打开。
    expect("defaultLivePreview" in harness.editorForTab(1).getOptions()).toBe(false)
  })

  it("carries a \\r\\n split across chunk boundaries into the Text doc", async () => {
    // Rust 分块只对齐 UTF-8 字符边界：\r 与 \n 可能分属两个 chunk，切行助手
    // 必须携带 pending 裁决（含空 chunk 不裁决）；编辑用 Text 归一为 \n 行。
    const harness = createAppHarness(editor)
    const joined = "alpha\r\nbeta\r\ngamma"
    harness.seedFile("/crlf.md", joined)
    harness.services.statDocument = vi.fn(async () => ({
      kind: "existing" as const,
      requestedPath: "/crlf.md",
      sizeBytes: 20 * MB,
    }))
    harness.services.confirmLargeOpen = vi.fn(() => true)
    harness.services.readDocumentStreaming = vi.fn(async (_path, onEvent) => {
      onEvent({ kind: "chunk", index: 0, text: "alpha\r" })
      onEvent({ kind: "chunk", index: 1, text: "" })
      onEvent({ kind: "chunk", index: 2, text: "\nbeta\r" })
      onEvent({ kind: "chunk", index: 3, text: "\ngamma" })
      return {
        kind: "existing" as const,
        requestedPath: "/crlf.md",
        version: versionFor("/crlf.md", joined),
        stats: { byteLength: joined.length, lineCount: 3 },
      }
    })
    harness.renderApp()
    await harness.openFileTab("/crlf.md", joined)
    const doc = streamedDocText(harness.editorForTab(1))
    expect(doc.eq(Text.of(joined.split(/\r\n?|\n/)))).toBe(true)
    expect(doc.lines).toBe(3)
    expect(harness.editorForTab(1).view.state.doc).toBe(doc)
    // 字符串镜像仍是原始 joined（与 openSession 的 savedContents 同源）：
    // 脏检查口径不变 —— 打开即是干净状态，无未保存标记。
    expectPathShown("/crlf.md")
  })

  it("hands the streamed Text to a NEW tab's view via the docTexts stash", async () => {
    // 新 tab 分支不经 resetTabDocument：组装 Text 走 docTextsRef 暂存（App.openPath
    // inNewTab），由 ensureViews 建 view 时消费 —— 钉死 create 收到的就是 Text。
    const harness = createAppHarness(editor)
    harness.seedFile("/root.md", "root body")
    harness.seedFile("/stream.md", "disk copy that must not be used")
    harness.services.statDocument = vi.fn(async (path: string) => ({
      kind: "existing" as const,
      requestedPath: path,
      sizeBytes: path === "/stream.md" ? 20 * MB : 9,
    }))
    harness.services.confirmLargeOpen = vi.fn(() => true)
    harness.services.readDocumentStreaming = vi.fn(async (_path, onEvent) => {
      onEvent({ kind: "chunk", index: 0, text: "alpha " })
      onEvent({ kind: "chunk", index: 1, text: "beta" })
      return {
        kind: "existing" as const,
        requestedPath: "/stream.md",
        version: { resolvedPath: "/stream.md", fingerprint: "v1:stream" },
        stats: { byteLength: 10, lineCount: 1 },
      }
    })
    harness.renderApp()
    await harness.openFileTab("/root.md", "root body")
    expect(editor.create).toHaveBeenCalledTimes(1)
    // markdown 链接是新 tab 打开的真实入口（openPath(…, inNewTab=true)）。
    await act(async () => {
      harness.editorForTab(1).getOptions().onOpenMarkdownHref?.("/stream.md")
      await Promise.resolve()
    })
    await waitFor(() => expect(harness.allEditors()).toHaveLength(2))
    expect(harness.services.readDocument).not.toHaveBeenCalledWith("/stream.md")
    expect(editor.create).toHaveBeenCalledTimes(2)
    const doc = streamedDocText(harness.editorForTab(2))
    expect(doc.eq(Text.of("alpha beta".split(/\r\n?|\n/)))).toBe(true)
    expect(harness.editorForTab(2).view.state.doc).toBe(doc)
    // ensureViews 消费暂存的直接证据：第二次 create 的入参 options.doc 即该 Text。
    expect(editor.create.mock.calls[1][1].doc).toBe(doc)
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

  it("streams a lazily activated LARGE tab into a Text doc for the existing view", async () => {
    // 惰性 tab 首激活走 loadLazyTab：流式快照的 docText 直达已挂载的空 view
    // （resetTabDocument 主路径）；view 缺位的兜底与新 tab 分支共用 docTextsRef
    // 暂存链路（ensureViews 消费），此处钉住 Text 端到端落到 view.state.doc。
    const harness = createAppHarness(editor)
    const joined = "alpha\r\nbeta\r\ngamma"
    harness.seedFile("/small.md", "small")
    harness.seedFile("/lazy.md", joined)
    harness.services.getSessionState = vi.fn(async () => ({
      folder: null,
      openPaths: ["/small.md", "/lazy.md"],
      activePath: "/small.md",
    }))
    harness.services.statDocument = vi.fn(async (path: string) => ({
      kind: "existing" as const,
      requestedPath: path,
      sizeBytes: path === "/lazy.md" ? 20 * MB : 5,
    }))
    harness.services.confirmLargeOpen = vi.fn(() => true)
    harness.services.readDocumentStreaming = vi.fn(async (_path, onEvent) => {
      onEvent({ kind: "chunk", index: 0, text: "alpha\r" })
      onEvent({ kind: "chunk", index: 1, text: "\nbeta\r" })
      onEvent({ kind: "chunk", index: 2, text: "\ngamma" })
      return {
        kind: "existing" as const,
        requestedPath: "/lazy.md",
        version: versionFor("/lazy.md", joined),
        stats: { byteLength: joined.length, lineCount: 3 },
      }
    })
    harness.renderApp()
    await waitFor(() => {
      expect(harness.editorForTab(1).getOptions().doc).toBe("small")
    })
    harness.activateTab(2)
    await waitFor(() => {
      expect(streamedDocText(harness.editorForTab(2)).eq(Text.of(joined.split(/\r\n?|\n/)))).toBe(true)
    })
    const doc = streamedDocText(harness.editorForTab(2))
    expect(doc.lines).toBe(3)
    expect(harness.editorForTab(2).view.state.doc).toBe(doc)
    // 惰性档只有主路径整读一次；LARGE 激活必须走流式（不二次整读）。
    expect(harness.services.readDocument).toHaveBeenCalledTimes(1)
  })
})
