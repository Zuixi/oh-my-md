import { describe, expect, it } from "vitest"
import { editorExtensions } from "../src/index"
import { livePreviewField } from "../src/decorations/build"
import { isTableSourceRevealed, revealTableSource } from "../src/tables/sourceReveal"
import { makeState } from "./helpers"

const DOC = ["| A | B |", "| --- | --- |", "| a | b |", "", "after"].join("\n")

// 光标在表格外时仍是块 widget。必须让表格前有内容、光标落在文档首字符：
// blockSelected 把节点起点算作块内（root cause C：敲完 closing fence 光标恰在 to
// 必须留在块内），锚点 0 若正好是表格起点就永远进不了渲染态。
const OUTSIDE_DOC = ["Intro.", "", "| A | B |", "| --- | --- |", "| a | b |", "", "after"].join("\n")

// 单元格内联标记（**a**）是「必须跳过子树」的唯一真实证据：没有它，
// replace:/mark: 从来不会在这段窗口里出现，把 Table 分支的 return true 改回
// return false（源码网格里 inlineRules 折叠 ** 并加粗 = 半个预览）也照样绿。
const INLINE_DOC = "x\n\n| **a** |\n| --- |\n| b |\n"

describe("table source mode", () => {
  it("emits line decorations and no folding inside a focused table", () => {
    const anchor = DOC.indexOf("a")
    const state = makeState(DOC, [editorExtensions()], { anchor })
    const revealed = state.update({
      selection: { anchor: anchor + 1 },
      effects: revealTableSource.of(null),
    }).state
    const specs = revealed.field(livePreviewField).specs
    const tableFrom = DOC.indexOf("| A")
    const tableTo = DOC.indexOf("\n\nafter")
    const inside = specs.filter(s => s.from >= tableFrom && s.from <= tableTo)

    expect(inside.some(s => s.tag.startsWith("replace:"))).toBe(false)
    expect(inside.filter(s => s.tag === "line:omd-table-src").length).toBe(3)
    expect(inside.some(s => s.tag === "line:omd-table-src-head")).toBe(true)
    expect(inside.some(s => s.tag === "line:omd-table-src-delim")).toBe(true)
  })

  it("keeps inline markup raw inside a focused table", () => {
    const anchor = INLINE_DOC.lastIndexOf("| b |") + 2
    const state = makeState(INLINE_DOC, [editorExtensions()], { anchor })
    const revealed = state.update({
      selection: { anchor: anchor + 1 },
      effects: revealTableSource.of(null),
    }).state
    const specs = revealed.field(livePreviewField).specs
    const tableFrom = INLINE_DOC.indexOf("| **a**")
    const inside = specs.filter(s => s.from >= tableFrom && s.from <= INLINE_DOC.length)

    // 先证明表格确实处于源码态：否则 widget 分支同样跳过子树，
    // 下面两条断言会因为「什么都没生成」而假绿。
    expect(inside.filter(s => s.tag === "line:omd-table-src").length).toBe(3)
    expect(inside.some(s => s.tag.startsWith("replace:"))).toBe(false)
    expect(inside.some(s => s.tag === "mark:omd-strong")).toBe(false)
  })

  it("still emits the block widget when the caret is outside", () => {
    const state = makeState(OUTSIDE_DOC, [editorExtensions()], { anchor: 0 })
    const specs = state.field(livePreviewField).specs
    expect(specs.some(s => s.tag === "widget:block:table")).toBe(true)
    expect(specs.some(s => s.tag === "line:omd-table-src")).toBe(false)
  })

  it("keeps the rendered table while a collapsed caret rests inside a header cell", () => {
    const headerCaret = DOC.indexOf("A")
    const state = makeState(DOC, [editorExtensions()], { anchor: headerCaret })
    const tableFrom = DOC.indexOf("| A")
    const tableTo = DOC.indexOf("\n\nafter")
    const inside = state.field(livePreviewField).specs
      .filter(s => s.from >= tableFrom && s.from <= tableTo)

    expect(inside.some(s => s.tag === "widget:block:table")).toBe(true)
    expect(inside.some(s => s.tag === "line:omd-table-src")).toBe(false)

    const revealed = state.update({
      selection: { anchor: headerCaret + 1 },
      effects: revealTableSource.of(null),
    }).state
    const revealedInside = revealed.field(livePreviewField).specs
      .filter(s => s.from >= tableFrom && s.from <= tableTo)

    expect(revealedInside.filter(s => s.tag === "line:omd-table-src").length).toBe(3)
    expect(revealedInside.some(s => s.tag === "widget:block:table")).toBe(false)
  })

  it("reveals source lines when the effect is dispatched without moving the caret", () => {
    const headerCaret = DOC.indexOf("A")
    const state = makeState(DOC, [editorExtensions()], { anchor: headerCaret })
    const tableFrom = DOC.indexOf("| A")
    const tableTo = DOC.indexOf("\n\nafter")
    const revealed = state.update({ effects: revealTableSource.of(null) }).state
    const inside = revealed.field(livePreviewField).specs
      .filter(s => s.from >= tableFrom && s.from <= tableTo)

    expect(inside.filter(s => s.tag === "line:omd-table-src").length).toBe(3)
    expect(inside.some(s => s.tag === "widget:block:table")).toBe(false)
  })

  it("source-styles only the table that contains the selection head", () => {
    const doc = [
      "| A | B |",
      "| --- | --- |",
      "| a | b |",
      "",
      "| C | D |",
      "| --- | --- |",
      "| c | d |",
    ].join("\n")
    const state = makeState(doc, [editorExtensions()], { anchor: 0 })
    const revealed = state.update({
      selection: { anchor: doc.indexOf("A"), head: doc.indexOf("C") },
      effects: revealTableSource.of(null),
    }).state
    const secondFrom = doc.indexOf("| C")
    const specs = revealed.field(livePreviewField).specs
    const first = specs.filter(s => s.from < secondFrom)
    const second = specs.filter(s => s.from >= secondFrom)

    expect(first.some(s => s.tag === "widget:block:table")).toBe(true)
    expect(first.some(s => s.tag === "line:omd-table-src")).toBe(false)
    expect(second.filter(s => s.tag === "line:omd-table-src").length).toBe(3)
    expect(second.some(s => s.tag === "widget:block:table")).toBe(false)
  })

  it("renders the table again after the caret leaves and re-enters without a new reveal", () => {
    const inside = DOC.indexOf("a")
    const revealed = makeState(DOC, [editorExtensions()], { anchor: 0 }).update({
      selection: { anchor: inside },
      effects: revealTableSource.of(null),
    }).state
    expect(isTableSourceRevealed(revealed)).toBe(true)

    const left = revealed.update({ selection: { anchor: DOC.length } }).state
    expect(isTableSourceRevealed(left)).toBe(false)

    const returned = left.update({ selection: { anchor: inside + 1 } }).state
    const specs = returned.field(livePreviewField).specs
    expect(specs.some(s => s.tag === "widget:block:table")).toBe(true)
    expect(specs.some(s => s.tag === "line:omd-table-src")).toBe(false)
  })

  it("keeps source lines while typing inside a revealed table", () => {
    const anchor = DOC.indexOf("a")
    const revealed = makeState(DOC, [editorExtensions()], { anchor: 0 }).update({
      selection: { anchor },
      effects: revealTableSource.of(null),
    }).state
    const typed = revealed.update({
      changes: { from: anchor, to: anchor, insert: "z" },
      selection: { anchor: anchor + 1 },
    }).state
    const specs = typed.field(livePreviewField).specs
    expect(isTableSourceRevealed(typed)).toBe(true)
    expect(specs.some(s => s.tag === "widget:block:table")).toBe(false)
    expect(specs.some(s => s.tag === "line:omd-table-src")).toBe(true)
  })

  it("keeps the reveal flag false when the caret is not inside a table", () => {
    const state = makeState(OUTSIDE_DOC, [editorExtensions()], { anchor: 0 })
    const next = state.update({ effects: revealTableSource.of(null) }).state
    expect(isTableSourceRevealed(next)).toBe(false)
    expect(next.field(livePreviewField).specs.some(s => s.tag === "widget:block:table")).toBe(true)
  })
})
