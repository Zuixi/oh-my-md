import { describe, expect, it } from "vitest"
import { EditorState } from "@codemirror/state"
import { EditorView, type WidgetType } from "@codemirror/view"
import { forceParsing } from "@codemirror/language"
import { editorExtensions } from "../src/index"
import { drainPendingLiveBuild, livePreviewField } from "../src/decorations/build"
import { measureBlockWidget } from "../src/decorations/widgetMeasure"
import type { DecoSpec } from "../src/decorations/types"

// 滚动稳定性守护：重建区间内等价 widget 的 spec 必须复用原对象（Decoration 身份
// 不变）。CM 的 heightRelevantDecoChanges 按对象身份判变（比较器不调 eq），
// 身份漂移 = height-relevant 变更 → applyChanges 用估算值重建该块高度图、丢弃
// 已测高度 → 下一帧实测改回。measureBlockWidget 每次块绘制都触发重建，
// 「实测→估算→实测」振荡表现为滚轮下滑时位置回撤、拖动滚动条时 thumb 与
// 内容映射漂移。
describe("decoration rebuild preserves equivalent widget identity", () => {
  const DOC = [
    "| h1 | h2 |",
    "|---|---|",
    "| a | b |",
    "| c | d |",
    "",
    "```js",
    "let x = 1",
    "```",
    "",
    "tail",
  ].join("\n")

  function widgetOf(spec: DecoSpec): WidgetType | undefined {
    return (spec.deco.spec as { widget?: WidgetType }).widget
  }

  function mount(): { view: EditorView; tableSpec: () => DecoSpec | undefined } {
    const parent = document.createElement("div")
    document.body.appendChild(parent)
    const view = new EditorView({ state: baseLiveState(), parent })
    forceParsing(view, DOC.length, 10000)
    drainPendingLiveBuild(view)
    const tableSpec = () =>
      view.state.field(livePreviewField).specs.find(s => s.tag === "widget:block:table")
    return { view, tableSpec }
  }

  function baseLiveState() {
    // editorExtensions 默认 live；光标放到文末（远离表格/代码块，保持 widget 态）。
    return EditorState.create({
      doc: DOC,
      extensions: editorExtensions(),
      selection: { anchor: DOC.length },
    })
  }

  it("measureBlockWidget rebuild reuses the equivalent widget instance", () => {
    const { view, tableSpec } = mount()
    try {
      const before = tableSpec()
      expect(before).toBeTruthy()
      const widgetBefore = widgetOf(before!)
      const heightBefore = view.contentHeight

      // blockWidget.toDOM 渲染完成后 dispatch 的正是这个 effect。
      view.dispatch({ effects: measureBlockWidget.of({ pos: before!.from }) })

      const after = tableSpec()
      expect(after).toBeTruthy()
      // 身份不变 = Decoration 不变 = CM 高度图对该块零变更（无估算↔实测振荡）。
      expect(widgetOf(after!)).toBe(widgetBefore)
      expect(view.contentHeight).toBe(heightBefore)
    } finally {
      view.destroy()
      view.dom.remove()
    }
  })

  it("content edits still rotate the widget instance (reuse is equivalence-gated)", () => {
    const { view, tableSpec } = mount()
    try {
      const widgetBefore = widgetOf(tableSpec()!)
      // 改单元格内容：src 变化 → eq false → 必须换新实例（否则 DOM 不刷新）。
      view.dispatch({ changes: { from: DOC.indexOf("| a |") + 2, to: DOC.indexOf("| a |") + 3, insert: "z" } })
      const widgetAfter = widgetOf(tableSpec()!)
      expect(widgetAfter).toBeTruthy()
      expect(widgetAfter).not.toBe(widgetBefore)
    } finally {
      view.destroy()
      view.dom.remove()
    }
  })
})
