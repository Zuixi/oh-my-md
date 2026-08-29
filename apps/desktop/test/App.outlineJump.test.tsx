import { fireEvent, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest"
import { type StateEffect } from "@codemirror/state"
import type { EditorView } from "@codemirror/view"
import { type OutlineItem } from "@omd/engine"
import { STORAGE_KEY_OUTLINE_OPEN } from "../src/constants"
import type { CreateEditorOptions } from "../src/Editor"
import { createAppHarness, resetMountedApps, type FakeEditorHandle } from "./appHarness"

vi.mock("@omd/engine", async importOriginal => {
  const actual = await importOriginal<typeof import("@omd/engine")>()
  return {
    ...actual,
    exportHtml: () => "<!doctype html><html>exported</html>",
    exportRichHtml: async () => "<!doctype html><html>exported</html>",
    // 固定 from 值：点击哪一项，dispatch 的锚点就应指向哪一项。
    collectOutline: vi.fn((): OutlineItem[] => [
      { level: 1, text: "Intro", from: 0 },
      { level: 2, text: "Deep", from: 8 },
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

// setup.ts 的内存 localStorage 在同文件各用例间共享：清掉面板开合状态。
beforeEach(() => { localStorage.removeItem(STORAGE_KEY_OUTLINE_OPEN) })

function dispatchSpecs(handle: FakeEditorHandle): Array<Record<string, unknown>> {
  return (handle.view.dispatch as unknown as Mock).mock.calls.map(call => call[0])
}

function asArray(effects: unknown): StateEffect<unknown>[] {
  if (!effects) return []
  const list = Array.isArray(effects) ? effects : [effects]
  return list as StateEffect<unknown>[]
}

/** ScrollTarget 不导出、effect 类型常量也不导出：按值结构识别滚动 effect。 */
function scrollTargets(effects: unknown): Array<{ y: string; range: { from: number } }> {
  return asArray(effects)
    .map(effect => effect.value)
    .filter((value): value is { y: string; range: { from: number } } =>
      typeof value === "object" && value !== null && "y" in value && "range" in value)
}

describe("outline jump", () => {
  it("scrolls the editor to the heading when an outline item is clicked", async () => {
    const harness = createAppHarness(editor)
    harness.renderApp()
    await harness.openFileTab("/a.md", "# Alpha")
    // 首开的大纲填充走防抖；显式重激活走同步首算，条目立即可点。
    harness.activateTab(1)
    fireEvent.click(screen.getByRole("button", { name: "Show outline" }))
    const handle = harness.editorForTab(1)
    ;(handle.view.dispatch as unknown as Mock).mockClear()

    fireEvent.click(screen.getByRole("button", { name: "Deep" }))

    const spec = dispatchSpecs(handle).find(candidate => "selection" in candidate)
    expect(spec?.selection).toEqual({ anchor: 8 })
    const targets = scrollTargets(spec?.effects)
    expect(targets).toHaveLength(1)
    expect(targets[0].y).toBe("start")
    expect(targets[0].range.from).toBe(8)
    expect(handle.view.focus as unknown as Mock).toHaveBeenCalled()
  })
})
