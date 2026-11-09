import { act, fireEvent, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi, type Mock } from "vitest"
import { EditorState } from "@codemirror/state"
import type { EditorView } from "@codemirror/view"
import {
  blockRenderBudget, isLivePreview, safeModeRenderingEnabled,
} from "@omd/engine"
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

// 渐进渲染落地（2026-08-20）后，策略不再 dispatch setLivePreview；
// 本组断言保留 value 形状检查以防模式强制悄悄回归。
const dispatchCalls = (view: { dispatch: unknown }): unknown[][] =>
  (view.dispatch as unknown as Mock).mock.calls as unknown[][]

const forcedSourceOff = (calls: unknown[][]) =>
  calls.some(([spec]) => {
    const effects = (spec as { effects?: Array<{ value?: unknown }> } | undefined)?.effects
    return effects?.[0]?.value === false
  })

describe("large document safe mode", () => {
  it("opens >50k-line docs in live mode with safe-mode budget and a one-time banner", async () => {
    const harness = createAppHarness(editor)
    harness.renderApp()
    await harness.openFileTab("/big.md", bigDoc(50010))
    const view = harness.editorForTab(1).view
    expect(editor.reset).toHaveBeenCalledWith(view, expect.objectContaining({
      doc: expect.stringContaining("line 50009"),
    }))
    // 默认 Live：options 不携带 defaultLivePreview 键（引擎默认 live），策略不切模式。
    expect("defaultLivePreview" in harness.editorForTab(1).getOptions()).toBe(false)
    expect(forcedSourceOff(dispatchCalls(view))).toBe(false)
    expect(document.querySelector(".statusbar")?.textContent).toContain("live")
    // 安全模式只存在于该 view 的 facet 里：进程级全局保持默认（镜像已删除）。
    expect(blockRenderBudget()).toBe(Infinity)
    expect(safeModeRenderingEnabled()).toBe(false)
    const banner = document.querySelector(".update-banner-message")
    expect(banner?.textContent).toContain("50010")
    expect(banner?.textContent).toContain("progressively")
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

  it("never touches mode when re-applying the policy, even after an explicit switch", async () => {
    // 真 EditorState 使 palette 的 source 命令能读 isLivePreview 并切换模式；
    // dispatch 仍是 mock，用于断言策略完全不切模式。
    // reset 忠实同步 doc，因为 applyDocumentScalePolicy 从 view.state.doc.lines 读行数。
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
    expect(forcedSourceOff(fakeView.dispatch.mock.calls as unknown[][])).toBe(false)
    // 用户显式切换模式：source 命令记录本会话选择（策略此后永不干预模式）
    openPaletteAndRun("source")
    fakeView.dispatch.mockClear()
    // 同 tab 再次载入超大文档：策略不 dispatch 任何模式变更，
    // 且安全模式预算不因用户的模式选择而失效（预算与模式正交）。
    await harness.openFileTab("/b.md", bigDoc(50010))
    // 策略会重新下发 per-view 预算/窗口化（facet reconfigure），但绝不切模式。
    expect(forcedSourceOff(fakeView.dispatch.mock.calls as unknown[][])).toBe(false)
    expect(blockRenderBudget()).toBe(Infinity)
    expect(safeModeRenderingEnabled()).toBe(false)
  })

  it("shows the safe-mode banner for a big document and clears it for a small one in the same tab", async () => {
    const harness = createAppHarness(editor)
    harness.renderApp()
    await harness.openFileTab("/big.md", bigDoc(50010))
    expect(document.querySelector(".update-banner-message")?.textContent).toContain("progressively")
    // 同一 tab 打开普通小文档后策略回到标准档，横幅随通知清空。
    await harness.openFileTab("/small.md", "small")
    expect(document.querySelector(".update-banner-message")).toBeNull()
  })

  it("never rewrites the engine's process-global compatibility knobs", async () => {
    // 镜像已删除：安全模式只存在于每个 view 的 facet 里，进程级默认值不得被触碰。
    const harness = createAppHarness(editor)
    harness.renderApp()
    await harness.openFileTab("/big.md", bigDoc(50010))
    expect(document.querySelector(".update-banner-message")?.textContent).toContain("progressively")
    expect(blockRenderBudget()).toBe(Infinity)
    expect(safeModeRenderingEnabled()).toBe(false)
  })
})
