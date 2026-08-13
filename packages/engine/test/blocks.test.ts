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

  it("styles horizontal rule source when the cursor is on it", () => {
    expect(tags("---")).toContain("line:omd-hr")
    expect(tags("---")).not.toContain("widget:block:hr")
  })

  it("replaces thematic breaks with a rule widget when the cursor is away", () => {
    const variants = ["***", "* * *", "*****", "- - -", "----------"]
    for (const rule of variants) {
      const doc = `${rule}\n\ntail`
      const s = makeState(doc).update({ selection: { anchor: doc.length } }).state
      const t = collectDecorationSpecs(s, 0, s.doc.length).map(d => d.tag)
      expect(t, rule).toContain("widget:block:hr")
      expect(t, rule).not.toContain("line:omd-hr")
    }
  })

  it("replaces bullet marks, keeps ordered numbers", () => {
    const doc = "- a\n- b\n\n1. first\n"
    const state = makeState(doc)
    // cursor far away so marks fold
    const s = state.update({ selection: { anchor: doc.length } }).state
    const t = collectDecorationSpecs(s, 0, doc.length).map(d => d.tag)
    expect(t.filter(x => x === "replace:ListMark")).toHaveLength(2)
    expect(t).toContain("mark:omd-list-mark")
    expect(t).not.toContain("widget:checkbox")
  })

  it("does not bullet task list items (checkbox owns the mark)", () => {
    const t = tags("- [x] done")
    expect(t).toContain("widget:checkbox")
    expect(t).not.toContain("replace:ListMark")
  })

  it("expands bullet mark when cursor is on it", () => {
    const doc = "- item"
    const state = makeState(doc).update({ selection: { anchor: 0 } }).state
    expect(collectDecorationSpecs(state, 0, doc.length).map(d => d.tag)).not.toContain("replace:ListMark")
  })

  it("tags list items with nesting depth classes", () => {
    const t = tags("- outer\n  - inner\n      - deep")
    expect(t).toContain("line:omd-li-1")
    expect(t).toContain("line:omd-li-2")
    expect(t).toContain("line:omd-li-3")
  })

  it("hides source indent spaces when cursor is off the line", () => {
    const doc = "- outer\n  - inner\n\ntail"
    const s = makeState(doc).update({ selection: { anchor: doc.length } }).state
    const t = collectDecorationSpecs(s, 0, doc.length).map(d => `${d.tag}@${d.from}-${d.to}`)
    expect(t).toContain("replace:ListIndent@8-10")
  })

  it("reveals indent spaces on the cursor's line", () => {
    const doc = "- outer\n  - inner"
    const s = makeState(doc).update({ selection: { anchor: 12 } }).state  // cursor on inner line
    expect(collectDecorationSpecs(s, 0, doc.length).map(d => d.tag)).not.toContain("replace:ListIndent")
  })

  it("styles fenced code block lines in edit state (cursor inside)", () => {
    const doc = "```js\nconst x = **not bold**\n```"
    // 光标在块内 → 编辑态：行样式 + 无 widget；行内语法不折叠
    const s = makeState(doc).update({ selection: { anchor: 10 } }).state
    const t = collectDecorationSpecs(s, 0, doc.length).map(d => d.tag)
    expect(t.filter(x => x === "line:omd-codeblock")).toHaveLength(3)
    expect(t).not.toContain("widget:block:code")
    expect(t).not.toContain("replace:EmphasisMark")
  })
})
