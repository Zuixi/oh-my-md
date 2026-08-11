import { describe, expect, it } from "vitest"
import { collectDecorationSpecs } from "../src/decorations/build"
import { makeState } from "./helpers"

const tags = (doc: string) => collectDecorationSpecs(makeState(doc), 0, doc.length).map(d => d.tag)

describe("block syntax", () => {
  it("replaces task markers with checkbox widgets", () => {
    const doc = "- [x] done\n- [ ] todo"
    const t = tags(doc)
    expect(t.filter(x => x === "widget:checkbox")).toHaveLength(2)
  })

  it("styles blockquote lines and hides the QuoteMark", () => {
    // Cursor must be off the blockquote line for QuoteMark to be folded.
    const doc = "> quoted\n\nnormal"
    let state = makeState(doc)
    state = state.update({ selection: { anchor: doc.length } }).state  // cursor on 'normal' line
    const t = collectDecorationSpecs(state, 0, state.doc.length).map(d => d.tag)
    expect(t).toContain("line:omd-blockquote")
    expect(t).toContain("replace:QuoteMark")
  })

  it("styles horizontal rule", () => {
    expect(tags("---")).toContain("line:omd-hr")
  })
})
