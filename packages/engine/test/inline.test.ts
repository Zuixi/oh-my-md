import { describe, expect, it } from "vitest"
import { collectDecorationSpecs } from "../src/decorations/build"
import { makeState } from "./helpers"

// Build tags with cursor on a separate line (so marks on line 1 are folded).
function tagsOffLine(doc: string) {
  const full = doc + "\nx"
  let state = makeState(full)
  // Move cursor to last character (on the 'x' line).
  state = state.update({ selection: { anchor: full.length } }).state
  return collectDecorationSpecs(state, 0, state.doc.length).map(d => d.tag)
}

// Build tags with cursor at specific position (for cursor-inside tests).
function tagsAt(doc: string, cursor: number) {
  let state = makeState(doc)
  state = state.update({ selection: { anchor: cursor } }).state
  return collectDecorationSpecs(state, 0, state.doc.length).map(d => d.tag)
}

describe("inline marks", () => {
  it("folds strong + emphasis + strikethrough marks", () => {
    expect(tagsOffLine("**bold**").filter(x => x === "replace:EmphasisMark")).toHaveLength(2)
    expect(tagsOffLine("**bold**")).toContain("mark:omd-strong")
    expect(tagsOffLine("*it*")).toContain("mark:omd-em")
    expect(tagsOffLine("~~del~~").filter(x => x === "replace:StrikethroughMark")).toHaveLength(2)
    expect(tagsOffLine("~~del~~")).toContain("mark:omd-del")
  })

  it("folds inline code backticks", () => {
    expect(tagsOffLine("`c`").filter(x => x === "replace:CodeMark")).toHaveLength(2)
    expect(tagsOffLine("`c`")).toContain("mark:omd-inline-code")
  })

  it("folds each link mark and the URL, keeps link text marked", () => {
    const t = tagsOffLine("[text](http://x.com)")
    expect(t.filter(x => x === "replace:LinkMark")).toHaveLength(4)  // [ ] ( )
    expect(t).toContain("replace:URL")
    expect(t).toContain("mark:omd-link")
  })

  it("does not fold URL when cursor is on the same line", () => {
    const doc = "[text](http://x.com)"
    const urlInside = doc.indexOf("http") + 2
    expect(tagsAt(doc, urlInside)).not.toContain("replace:URL")
  })

  it("folds underscore strong/emphasis next to CJK the same way as asterisks", () => {
    expect(tagsOffLine("这是**粗体**")).toContain("mark:omd-strong")
    expect(tagsOffLine("这是__粗体__")).toContain("mark:omd-strong")
    expect(tagsOffLine("这是__粗体__").filter(x => x === "replace:EmphasisMark")).toHaveLength(2)
    expect(tagsOffLine("这是_斜体_")).toContain("mark:omd-em")
  })

  it("does not treat intra-word ASCII underscores as emphasis", () => {
    expect(tagsOffLine("foo_bar_baz")).not.toContain("mark:omd-em")
    expect(tagsOffLine("foo__bar__baz")).not.toContain("mark:omd-strong")
  })

  it("folds ==highlight== markers", () => {
    expect(tagsOffLine("这是==高亮文本==").filter(x => x === "replace:HighlightMark")).toHaveLength(2)
    expect(tagsOffLine("这是==高亮文本==")).toContain("mark:omd-highlight")
  })

  it("folds <mark> tags as highlight", () => {
    expect(tagsOffLine("这是<mark>高亮文本</mark>").filter(x => x === "replace:HighlightMark")).toHaveLength(2)
    expect(tagsOffLine("这是<mark>高亮文本</mark>")).toContain("mark:omd-highlight")
  })
})