import { act, fireEvent, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { EditorState } from "@codemirror/state"
import type { EditorView } from "@codemirror/view"
import { collectOutline, SAFE_MODE_LINES, type OutlineItem } from "@omd/engine"
import { STORAGE_KEY_OUTLINE_OPEN } from "../src/constants"
import type { CreateEditorOptions } from "../src/Editor"
import { createAppHarness, resetMountedApps } from "./appHarness"

vi.mock("@omd/engine", async importOriginal => {
  const actual = await importOriginal<typeof import("@omd/engine")>()
  return {
    ...actual,
    exportHtml: () => "<!doctype html><html>exported</html>",
    exportRichHtml: async () => "<!doctype html><html>exported</html>",
    // 大纲条目文本带上 doc 首行：调用次数（缓存命中与否）与来源 tab 都可断言。
    collectOutline: vi.fn((state: EditorState): OutlineItem[] => [
      { level: 1, text: `outline-of:${state.doc.toString().split("\n")[0]}`, from: 0 },
    ]),
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

// setup.ts 的内存 localStorage 在同文件各用例间共享：不重置的话，前一个用例
// 点开的 outline 面板会被后续用例的 readOutlineOpen 读到，按钮名翻转。
beforeEach(() => { localStorage.removeItem(STORAGE_KEY_OUTLINE_OPEN) })

const outlineCalls = () => vi.mocked(collectOutline).mock.calls.length

/** 面板隐藏（is-hidden）时 DOM 仍在，textContent 可读；显隐由别处覆盖。 */
function outlinePanelText(): string {
  return document.querySelector("#outline-panel")?.textContent ?? ""
}

function bigDoc(lines: number): string {
  return Array.from({ length: lines }, (_, i) => `line ${i}`).join("\n")
}

describe("per-tab outline cache", () => {
  it("serves revisited tabs from cache without re-walking the syntax tree", async () => {
    const harness = createAppHarness(editor)
    harness.renderApp()
    // 面板保持关闭打开文件：真实计时器阶段的防抖不参与，计数才确定。
    await harness.openFileTab("/a.md", "# Alpha")
    await harness.openInNewTab("/b.md", "# Beta")
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      fireEvent.click(screen.getByRole("button", { name: "Show outline" }))
      vi.mocked(collectOutline).mockClear()

      // 首次激活：普通文档保持同步首算（refreshChrome 在 activateTab 内同步执行）
      harness.activateTab(1)
      expect(outlineCalls()).toBe(1)
      expect(outlinePanelText()).toContain("outline-of:# Alpha")
      harness.activateTab(2)
      expect(outlineCalls()).toBe(2)
      await act(async () => { await vi.advanceTimersByTimeAsync(200) })
      // 防抖 effect 经同一缓存：两次落缓存后无新增遍历
      expect(outlineCalls()).toBe(2)
      vi.mocked(collectOutline).mockClear()

      // 反复切换全部命中缓存：零次全树遍历，面板内容跟随激活 tab（不串数据）
      harness.activateTab(1)
      harness.activateTab(2)
      harness.activateTab(1)
      expect(outlineCalls()).toBe(0)
      expect(outlinePanelText()).toContain("outline-of:# Alpha")
      expect(outlinePanelText()).not.toContain("outline-of:# Beta")
      harness.activateTab(2)
      expect(outlineCalls()).toBe(0)
      expect(outlinePanelText()).toContain("outline-of:# Beta")
      expect(outlinePanelText()).not.toContain("outline-of:# Alpha")
    } finally {
      vi.useRealTimers()
    }
  })

  it("recomputes on the next activation after an edit bumps the tab's version", async () => {
    const harness = createAppHarness(editor)
    harness.renderApp()
    await harness.openFileTab("/a.md", "# Alpha")
    await harness.openInNewTab("/b.md", "# Beta")
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      fireEvent.click(screen.getByRole("button", { name: "Show outline" }))
      vi.mocked(collectOutline).mockClear()
      harness.activateTab(1)
      harness.activateTab(2)
      expect(outlineCalls()).toBe(2)
      vi.mocked(collectOutline).mockClear()

      // 后台 tab 编辑：版本号自增，缓存即刻失效
      harness.editorForTab(1).emit({
        doc: "# Alpha edited",
        docChanged: true,
        pendingNormalization: null,
      })
      expect(outlineCalls()).toBe(0)
      // 切回该 tab：未命中（版本号变了）→ 重算一次并落新缓存
      harness.activateTab(1)
      expect(outlineCalls()).toBe(1)
      expect(outlinePanelText()).toContain("outline-of:# Alpha edited")
      vi.mocked(collectOutline).mockClear()

      // 新版本再次落缓存：此后切走再切回又是零重算
      harness.activateTab(2)
      harness.activateTab(1)
      expect(outlineCalls()).toBe(0)
      expect(outlinePanelText()).toContain("outline-of:# Alpha edited")
    } finally {
      vi.useRealTimers()
    }
  })

  it("fills over-scale outlines asynchronously without blocking activation", async () => {
    const harness = createAppHarness(editor)
    harness.renderApp()
    await harness.openFileTab("/big.md", bigDoc(SAFE_MODE_LINES + 10))
    await harness.openInNewTab("/small.md", "small")
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      fireEvent.click(screen.getByRole("button", { name: "Show outline" }))
      vi.mocked(collectOutline).mockClear()
      // 预热普通 tab（同步路径）
      harness.activateTab(2)
      expect(outlineCalls()).toBe(1)
      vi.mocked(collectOutline).mockClear()

      // 切到 over-scale tab：激活立即返回（先空大纲，不同步计算）
      harness.activateTab(1)
      expect(outlineCalls()).toBe(0)
      expect(outlinePanelText()).not.toContain("outline-of:")
      // idle 补算（happy-dom 无 requestIdleCallback → setTimeout(0) 回退）落地
      await act(async () => { await vi.advanceTimersByTimeAsync(200) })
      expect(outlineCalls()).toBe(1)
      expect(outlinePanelText()).toContain("outline-of:line 0")
      vi.mocked(collectOutline).mockClear()

      // 异步补算也落缓存：再次切换零重算
      harness.activateTab(2)
      harness.activateTab(1)
      expect(outlineCalls()).toBe(0)
      expect(outlinePanelText()).toContain("outline-of:line 0")
    } finally {
      vi.useRealTimers()
    }
  })

  it("discards a stale async fill when the active tab changed mid-compute", async () => {
    const harness = createAppHarness(editor)
    harness.renderApp()
    await harness.openFileTab("/big.md", bigDoc(SAFE_MODE_LINES + 10))
    await harness.openInNewTab("/small.md", "small")
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      fireEvent.click(screen.getByRole("button", { name: "Show outline" }))
      vi.mocked(collectOutline).mockClear()
      harness.activateTab(2)
      expect(outlineCalls()).toBe(1)
      vi.mocked(collectOutline).mockClear()

      // over-scale 补算在途时切走：回调执行时激活 tab 已变 → 丢弃，不污染任何缓存
      harness.activateTab(1)
      harness.activateTab(2)
      expect(outlineCalls()).toBe(0)
      expect(outlinePanelText()).toContain("outline-of:small")
      await act(async () => { await vi.advanceTimersByTimeAsync(200) })
      expect(outlineCalls()).toBe(0)
      expect(outlinePanelText()).toContain("outline-of:small")
      expect(outlinePanelText()).not.toContain("outline-of:line 0")

      // 切回 over-scale tab 重新调度，补算正常落地且不残留 small 的大纲
      harness.activateTab(1)
      await act(async () => { await vi.advanceTimersByTimeAsync(200) })
      expect(outlineCalls()).toBe(1)
      expect(outlinePanelText()).toContain("outline-of:line 0")
      expect(outlinePanelText()).not.toContain("outline-of:small")
    } finally {
      vi.useRealTimers()
    }
  })

  it("discards an async fill superseded by an edit on the same tab", async () => {
    const harness = createAppHarness(editor)
    harness.renderApp()
    await harness.openFileTab("/big.md", bigDoc(SAFE_MODE_LINES + 10))
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      vi.mocked(collectOutline).mockClear()
      // 重激活当前 over-scale tab：补算挂起（版本 0），尚未执行
      harness.activateTab(1)
      expect(outlineCalls()).toBe(0)
      // 同 tab 编辑 bump 版本号 → 再激活重新调度（代际令牌 + 版本号双保险）
      harness.editorForTab(1).emit({
        doc: `# Edited\n${bigDoc(SAFE_MODE_LINES + 10)}`,
        docChanged: true,
        pendingNormalization: null,
      })
      harness.activateTab(1)
      await act(async () => { await vi.advanceTimersByTimeAsync(200) })
      // 旧回调被丢弃，只有新版本补算恰好执行一次
      expect(outlineCalls()).toBe(1)
      expect(outlinePanelText()).toContain("outline-of:# Edited")
      expect(outlinePanelText()).not.toContain("outline-of:line 0")
    } finally {
      vi.useRealTimers()
    }
  })

  it("invalidates the cached outline when resetTabDocument swaps the document", async () => {
    const harness = createAppHarness(editor)
    harness.renderApp()
    await harness.openFileTab("/a.md", "# Alpha")
    await harness.openInNewTab("/b.md", "# Beta")
    // 面板关闭：无防抖参与，全部断言走同步路径
    vi.mocked(collectOutline).mockClear()
    harness.activateTab(1)
    expect(outlineCalls()).toBe(1)
    expect(outlinePanelText()).toContain("outline-of:# Alpha")
    vi.mocked(collectOutline).mockClear()

    // 整文档重载清缓存并归零版本号：即使版本号回到 0 也不得命中旧大纲
    await harness.openFileTab("/fresh.md", "# Fresh")
    harness.activateTab(1)
    expect(outlineCalls()).toBe(1)
    expect(outlinePanelText()).toContain("outline-of:# Fresh")
    expect(outlinePanelText()).not.toContain("outline-of:# Alpha")
  })
})
