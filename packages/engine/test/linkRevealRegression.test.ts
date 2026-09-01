import { describe, expect, it } from "vitest"
import { collectDecorationSpecs } from "../src/decorations/build"
import { makeState } from "./helpers"

// 回归 fixture：用户报告的 README credits 原文（2026-09-01，同最初截图段落）——
// 单个软换行段落、8 个链接密集分布。行级展开（nearCursor）年代里，点击段内任意
// 文本都会把全部 8 个链接裸奔成 [text](url)。此 fixture 钉死节点级 cursorInside
// 语义：普通文本上的光标一个都不展开，进入某个链接只展开那一个。
const doc = "Built on excellent open source: [CodeMirror 6](https://codemirror.net/) and [Lezer](https://lezer.codemirror.net/), [Tauri](https://tauri.app/), [KaTeX](https://katex.org/), [Mermaid](https://mermaid.js.org/), [Shiki](https://shiki.style/), [React](https://react.dev/), and [Vite](https://vite.dev/). Typora's interaction design remains a standing inspiration."

const LINK_COUNT = 8

const tagsAt = (cursor: number) => {
  let state = makeState(doc)
  state = state.update({ selection: { anchor: cursor } }).state
  return collectDecorationSpecs(state, 0, state.doc.length).map(d => d.tag)
}

describe("link reveal regression (README credits paragraph)", () => {
  it("caret at plain-text spots keeps all links folded", () => {
    for (const cursor of [
      1,                                     // "B|uilt" 段首
      doc.indexOf("open source") + 3,        // 链接之前的普通文本
      doc.indexOf("and [Vite") - 2,          // 最后一个链接之前的普通文本
      doc.indexOf("Typora's"),               // 全部链接之后的文本
      doc.length,                            // 段尾
    ]) {
      const t = tagsAt(cursor)
      expect(t.filter(x => x === "replace:LinkMark").length, `cursor=${cursor}`)
        .toBe(LINK_COUNT * 4)
      expect(t.filter(x => x === "replace:URL").length, `cursor=${cursor}`)
        .toBe(LINK_COUNT)
    }
  })

  it("caret inside one link reveals only that link", () => {
    const t = tagsAt(doc.indexOf("CodeMirror 6") + 3)
    expect(t.filter(x => x === "replace:LinkMark").length).toBe((LINK_COUNT - 1) * 4)
    expect(t.filter(x => x === "replace:URL").length).toBe(LINK_COUNT - 1)
  })

  it("caret just past a link's closing paren keeps it folded", () => {
    const t = tagsAt(doc.indexOf("(https://codemirror.net/)") + "(https://codemirror.net/)".length)
    expect(t.filter(x => x === "replace:URL").length).toBe(LINK_COUNT)
  })
})
