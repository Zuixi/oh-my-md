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

describe("statusbar stats debouncing", () => {
  it("defers word count until typing pauses", async () => {
    vi.useFakeTimers()
    try {
      const harness = createAppHarness(editor)
      harness.renderApp()
      act(() => {
        harness.editorForTab(1).emit({
          doc: "hello world", docChanged: true, pendingNormalization: null,
        })
      })
      // 防抖窗口内：statusbar 仍显示 0 词（空文档基线）。
      // 注意两级窗口：物化 250ms（doc 进 App state）+ 统计防抖 250ms。
      expect(document.querySelector(".statusbar")?.textContent).not.toContain("2")
      act(() => { vi.advanceTimersByTime(600) })
      // 防抖到期：显示 "hello world" 的 2 词
      expect(document.querySelector(".statusbar")?.textContent).toContain("2")
    } finally {
      vi.useRealTimers()
    }
  })
})
