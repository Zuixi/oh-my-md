import { describe, expect, it } from "vitest"
import { editorExtensions } from "../src/index"
import { livePreviewField } from "../src/decorations/build"
import { makeState } from "./helpers"

const DOC = ["| A | B |", "| --- | --- |", "| a | b |", "", "after"].join("\n")

// 光标在表格外时仍是块 widget。必须让表格前有内容、光标落在文档首字符：
// blockSelected 把节点起点算作块内（root cause C：敲完 closing fence 光标恰在 to
// 必须留在块内），锚点 0 若正好是表格起点就永远进不了渲染态。
const OUTSIDE_DOC = ["Intro.", "", "| A | B |", "| --- | --- |", "| a | b |", "", "after"].join("\n")

describe("table source mode", () => {
  it("emits line decorations and no folding inside a focused table", () => {
    const state = makeState(DOC, [editorExtensions()], { anchor: DOC.indexOf("a") })
    const specs = state.field(livePreviewField).specs
    const tableFrom = DOC.indexOf("| A")
    const tableTo = DOC.indexOf("\n\nafter")
    const inside = specs.filter(s => s.from >= tableFrom && s.from <= tableTo)

    expect(inside.some(s => s.tag.startsWith("replace:"))).toBe(false)
    expect(inside.filter(s => s.tag === "line:omd-table-src").length).toBe(3)
    expect(inside.some(s => s.tag === "line:omd-table-src-head")).toBe(true)
    expect(inside.some(s => s.tag === "line:omd-table-src-delim")).toBe(true)
  })

  it("still emits the block widget when the caret is outside", () => {
    const state = makeState(OUTSIDE_DOC, [editorExtensions()], { anchor: 0 })
    const specs = state.field(livePreviewField).specs
    expect(specs.some(s => s.tag === "widget:block:table")).toBe(true)
    expect(specs.some(s => s.tag === "line:omd-table-src")).toBe(false)
  })
})
