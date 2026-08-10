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
    const t = tags("> quoted")
    expect(t).toContain("line:omd-blockquote")
    expect(t).toContain("replace:QuoteMark")
  })

  it("styles horizontal rule", () => {
    expect(tags("---")).toContain("line:omd-hr")
  })
})
