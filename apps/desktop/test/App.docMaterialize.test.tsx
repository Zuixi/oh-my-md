import { act } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { EditorView } from "@codemirror/view"
import type { CreateEditorOptions } from "../src/Editor"
import { createAppHarness, resetMountedApps } from "./appHarness"

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

describe("deferred doc materialization", () => {
  it("coalesces rapid keystrokes into one recovery write after the debounce", async () => {
    const harness = createAppHarness(editor)
    harness.renderApp({ docMaterializeMs: 250 })
    await harness.openFileTab("/a.md", "hello")
    harness.services.writeRecovery = vi.fn(async () => undefined)
    const handle = harness.editorForTab(1)
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      for (const text of ["a", "b", "c"]) {
        handle.emit({ doc: text, docChanged: true, pendingNormalization: null })
      }
      // 物化 250ms + 恢复防抖 800ms 内：零写盘
      expect(harness.services.writeRecovery).not.toHaveBeenCalled()
      await act(async () => { await vi.advanceTimersByTimeAsync(1100) })
      expect(harness.services.writeRecovery).toHaveBeenCalledTimes(1)
      expect(harness.services.writeRecovery).toHaveBeenCalledWith(
        expect.anything(), expect.stringContaining("c"),
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it("saves the newest content when saving inside the debounce window", async () => {
    const harness = createAppHarness(editor)
    harness.renderApp({ docMaterializeMs: 250 })
    await harness.openFileTab("/a.md", "hello")
    const handle = harness.editorForTab(1)
    handle.emit({ doc: "world", docChanged: true, pendingNormalization: null })
    // 防抖窗口内直接 ⌘S：flush 必须让落盘内容为最新
    await harness.saveActive()
    expect(harness.disk("/a.md").contents()).toBe("world")
  })

  it("update payloads never carry the document string (Spec 05a §10.4)", async () => {
    const harness = createAppHarness(editor)
    harness.renderApp()
    await harness.openFileTab("/a.md", "hello")
    // openFileTab 会经 editor.reset 重新绑定一个新的 options 对象，取最新的那个
    const opts = editor.reset.mock.calls[editor.reset.mock.calls.length - 1][1] as CreateEditorOptions
    const seen: object[] = []
    const original = opts.onDocumentUpdate
    opts.onDocumentUpdate = update => { seen.push(update); original(update) }
    harness.editorForTab(1).emit({ doc: "typed", docChanged: true, pendingNormalization: null })
    expect(seen.length).toBeGreaterThan(0)
    for (const payload of seen) {
      expect("doc" in payload).toBe(false)
    }
  })
})
