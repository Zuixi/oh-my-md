import { act, fireEvent, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi, type Mock } from "vitest"
import { EditorState } from "@codemirror/state"
import type { EditorView } from "@codemirror/view"
import { blockRenderBudget, isLivePreview, SAFE_MODE_RENDER_BUDGET_LINES, safeModeRenderingEnabled } from "@omd/engine"
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

function openPaletteAndRun(query: string) {
  fireEvent.keyDown(window, { key: "p", metaKey: true, shiftKey: true })
  fireEvent.change(screen.getByPlaceholderText("Run a command…"), { target: { value: query } })
  fireEvent.keyDown(screen.getByPlaceholderText("Run a command…"), { key: "Enter" })
}

function bigDoc(lines: number): string {
  return Array.from({ length: lines }, (_, i) => `line ${i}`).join("\n")
}

// setLivePreview(false) 的 effects[0] 是 toggleLivePreview.of(false)：value 为布尔 false
// （compartment reconfigure 的 effect.value 是扩展数组，不会是布尔）。
// 不 import toggleLivePreview —— engine index 未导出它，按 value 形状断言。
const dispatchCalls = (view: { dispatch: unknown }): unknown[][] =>
  (view.dispatch as unknown as Mock).mock.calls as unknown[][]

const forcedSourceOff = (calls: unknown[][]) =>
  calls.some(([spec]) => {
    const effects = (spec as { effects?: Array<{ value?: unknown }> } | undefined)?.effects
    return effects?.[0]?.value === false
  })

describe("large document safe mode", () => {
  it("forces source mode and shows a one-time banner for >50k-line docs", async () => {
    const harness = createAppHarness(editor)
    harness.renderApp()
    await harness.openFileTab("/big.md", bigDoc(50010))
    const view = harness.editorForTab(1).view
    expect(editor.reset).toHaveBeenCalledWith(view, expect.objectContaining({
      doc: expect.stringContaining("line 50009"),
    }))
    expect(forcedSourceOff(dispatchCalls(view))).toBe(true)
    const banner = document.querySelector(".update-banner-message")
    expect(banner?.textContent).toContain("50010")
    expect(banner?.textContent).toContain("source mode")
  })

  it("keeps the banner informational between 30k and 50k lines without forcing source", async () => {
    const harness = createAppHarness(editor)
    harness.renderApp()
    await harness.openFileTab("/medium.md", bigDoc(30010))
    const view = harness.editorForTab(1).view
    await waitFor(() => {
      expect(document.querySelector(".update-banner-message")?.textContent).toContain("30010")
    })
    expect(document.querySelector(".update-banner-message")?.textContent).not.toContain("source mode")
    expect(forcedSourceOff(dispatchCalls(view))).toBe(false)
  })

  it("shows an on-demand count button in safe mode and computes on click", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const harness = createAppHarness(editor)
      harness.renderApp()
      await harness.openFileTab("/big.md", bigDoc(50010))
      const button = await screen.findByRole("button", { name: "Count words" })
      expect(document.querySelector(".statusbar")?.textContent).not.toMatch(/\d+ words/)
      fireEvent.click(button)
      await act(async () => { await vi.advanceTimersByTimeAsync(300) })
      expect(document.querySelector(".statusbar")?.textContent).toMatch(/\d+ words/)
    } finally {
      vi.useRealTimers()
    }
  })

  it("remembers an explicit mode switch for the session", async () => {
    // 真 EditorState 使 palette 的 source 命令能读 isLivePreview 并记录用户选择；
    // dispatch 仍是 mock，用于断言后续载入不再强制 source。reset 忠实同步 doc，
    // 因为 applyDocumentScalePolicy 从 view.state.doc.lines 读行数。
    const fakeView = {
      state: EditorState.create({ doc: "", extensions: [isLivePreview] }),
      dispatch: vi.fn(),
      focus: vi.fn(),
      destroy: vi.fn(),
      dom: document.createElement("div"),
    }
    const harness = createAppHarness(editor)
    editor.create.mockImplementation(() => fakeView as unknown as EditorView)
    editor.reset.mockImplementation((view: EditorView, options: CreateEditorOptions) => {
      ;(view as unknown as { state: EditorState }).state = EditorState.create({
        doc: options.doc,
        extensions: [isLivePreview],
      })
    })
    harness.renderApp()
    await harness.openFileTab("/a.md", bigDoc(50010))
    expect(forcedSourceOff(fakeView.dispatch.mock.calls as unknown[][])).toBe(true)
    // 用户显式切换模式：source 命令记录本会话选择
    openPaletteAndRun("source")
    fakeView.dispatch.mockClear()
    // 同 tab 再次载入超大文档：尊重选择，不再强制
    await harness.openFileTab("/b.md", bigDoc(50010))
    expect(forcedSourceOff(fakeView.dispatch.mock.calls as unknown[][])).toBe(false)
  })

  it("sets a finite block render budget only for safe-mode documents", async () => {
    const harness = createAppHarness(editor)
    harness.renderApp()
    await harness.openFileTab("/big.md", bigDoc(50010))
    expect(blockRenderBudget()).toBe(SAFE_MODE_RENDER_BUDGET_LINES)
    // 打开普通小文档后恢复
    await harness.openFileTab("/small.md", "small")
    expect(blockRenderBudget()).toBe(Infinity)
  })

  it("re-applies the render budget when switching tabs", async () => {
    // 预算是 engine 全局状态，安全模式是 per-tab 的：切 tab 必须重新应用，
    // 否则小 tab 继承有限预算（远处块懒渲染）或安全 tab 切回后预算失效。
    const harness = createAppHarness(editor)
    harness.renderApp()
    await harness.openFileTab("/big.md", bigDoc(50010))
    await harness.openInNewTab("/small.md", "small")
    expect(blockRenderBudget()).toBe(Infinity)
    harness.activateTab(1)
    expect(blockRenderBudget()).toBe(SAFE_MODE_RENDER_BUDGET_LINES)
    harness.activateTab(2)
    expect(blockRenderBudget()).toBe(Infinity)
  })

  it("enables windowed rendering alongside the render budget for safe-mode tabs", async () => {
    // Task 3：applyRenderBudgetFor 同参联动 setSafeModeRendering —— 安全模式 tab
    // 启用 over-scale 窗口化装饰（只构建/保留视口附近），切回普通 tab 恢复
    // 排空到全量的语义。
    const harness = createAppHarness(editor)
    harness.renderApp()
    await harness.openFileTab("/big.md", bigDoc(50010))
    expect(blockRenderBudget()).toBe(SAFE_MODE_RENDER_BUDGET_LINES)
    expect(safeModeRenderingEnabled()).toBe(true)
    await harness.openFileTab("/small.md", "small")
    expect(blockRenderBudget()).toBe(Infinity)
    expect(safeModeRenderingEnabled()).toBe(false)
  })
})
