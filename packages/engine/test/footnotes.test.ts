import { describe, expect, it } from "vitest"
import { syntaxTree } from "@codemirror/language"
import { collectDecorationSpecs } from "../src/decorations/build"
import { makeState } from "./helpers"

const specs = (doc: string, sel?: number) => {
  let state = makeState(doc)
  if (sel !== undefined) state = state.update({ selection: { anchor: sel } }).state
  return collectDecorationSpecs(state, 0, state.doc.length)
}

const tags = (doc: string, sel?: number) => specs(doc, sel).map(d => d.tag)

describe("footnotes", () => {
  it("parses reference and definition nodes", () => {
    const names: string[] = []
    syntaxTree(makeState("text[^1]\n\n[^1]: note")).iterate({ enter: n => { names.push(n.name) } })
    expect(names).toContain("FootnoteReference")
    expect(names).toContain("FootnoteDefinition")
    expect(names).toContain("FootnoteMark")
  })

  it("marks references as superscript, folds definition label", () => {
    const t = tags("text[^1]\n\n[^1]: note")
    expect(t).toContain("mark:omd-footnote")
    expect(t).toContain("replace:FootnoteMark")
  })

  it("does not fold the definition label on the cursor's line", () => {
    const doc = "text[^1]\n\n[^1]: note"
    const defFrom = doc.indexOf("[^1]:")
    expect(specs(doc, doc.length).some(s => s.tag === "replace:FootnoteMark" && s.from === defFrom)).toBe(false)
  })

  it("does not treat plain [text] as a footnote reference", () => {
    const t = tags("[link](http://x.com)")
    expect(t).not.toContain("mark:omd-footnote")
  })

  it("folds reference brackets when the cursor is off the line", () => {
    const doc = "创建脚注格式类似这样 [^RUNOOB]。\n\n[^RUNOOB]: 菜鸟教程 -- 学的不仅是技术，更是梦想！！！\n\ntail"
    const t = tags(doc, doc.length)
    expect(t.filter(x => x === "replace:FootnoteMark")).toHaveLength(3)
    expect(t).toContain("mark:omd-footnote")
    expect(t).toContain("line:omd-footnote-def")
  })

  it("keeps reference brackets visible on the cursor's line", () => {
    const doc = "text[^1]\n\n[^1]: note"
    expect(tags(doc, 0).filter(x => x === "replace:FootnoteMark")).toHaveLength(1)
  })

  it("absorbs 4-space-indented continuation lines into the definition", () => {
    const doc = "[^1]: body\n    continued **bold**\n\nprose"
    const names: string[] = []
    let defTo = -1
    syntaxTree(makeState(doc)).iterate({
      enter: n => { names.push(n.name); if (n.name === "FootnoteDefinition") defTo = n.to },
    })
    expect(names).not.toContain("CodeBlock")
    // definition spans the continuation line; prose is outside it
    expect(defTo).toBe(doc.indexOf("**bold**") + 8)
    // inline marks inside the continuation still fold
    const t = tags(doc)
    expect(t).toContain("mark:omd-strong")
  })
})
