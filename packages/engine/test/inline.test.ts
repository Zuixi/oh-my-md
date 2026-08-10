import { describe, expect, it } from "vitest"
import { collectDecorationSpecs } from "../src/decorations/build"
import { makeState } from "./helpers"

function tags(doc: string, cursor?: number) {
  let state = makeState(doc)
  if (cursor !== undefined) state = state.update({ selection: { anchor: cursor } }).state
  return collectDecorationSpecs(state, 0, state.doc.length).map(d => d.tag)
}

describe("inline marks", () => {
  it("folds strong + emphasis + strikethrough marks", () => {
    expect(tags("**bold**").filter(x => x === "replace:EmphasisMark")).toHaveLength(2)
    expect(tags("**bold**")).toContain("mark:omd-strong")
    expect(tags("*it*")).toContain("mark:omd-em")
    expect(tags("~~del~~").filter(x => x === "replace:StrikethroughMark")).toHaveLength(2)
    expect(tags("~~del~~")).toContain("mark:omd-del")
  })

  it("folds inline code backticks", () => {
    expect(tags("`c`").filter(x => x === "replace:CodeMark")).toHaveLength(2)
    expect(tags("`c`")).toContain("mark:omd-inline-code")
  })

  it("folds each link mark and the URL, keeps link text marked", () => {
    const t = tags("[text](http://x.com)")
    expect(t.filter(x => x === "replace:LinkMark")).toHaveLength(4)  // [ ] ( )
    expect(t).toContain("replace:URL")
    expect(t).toContain("mark:omd-link")
  })

  it("does not fold URL when cursor is inside it", () => {
    const doc = "[text](http://x.com)"
    const urlInside = doc.indexOf("http") + 2
    expect(tags(doc, urlInside)).not.toContain("replace:URL")
  })
})