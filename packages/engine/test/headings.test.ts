import { describe, expect, it } from "vitest"
import { collectDecorationSpecs } from "../src/decorations/build"
import { makeState } from "./helpers"

const tags = (doc: string) =>
  collectDecorationSpecs(makeState(doc), 0, doc.length).map(d => `${d.tag}@${d.from}-${d.to}`)

describe("headings", () => {
  it("tags heading line and hides the HeaderMark + trailing space", () => {
    const state = makeState("# Title\n\nbody")
    const t = collectDecorationSpecs(state, 0, state.doc.length).map(d => `${d.tag}@${d.from}-${d.to}`)
    expect(t).toContain("line:omd-h1@0-0")
    expect(t).toContain("replace:HeaderMark@0-2")   // "# " hidden
  })

  it("does not hide the HeaderMark when the cursor is inside it", () => {
    const doc = "# Title"
    let state = makeState(doc)
    // Cursor placed inside the HeaderMark + trailing space range [0, 2]
    // (between '#' and ' '), so strict nearCursor picks it up.
    state = state.update({ selection: { anchor: 1 } }).state
    const t = collectDecorationSpecs(state, 0, state.doc.length).map(d => d.tag)
    expect(t).not.toContain("replace:HeaderMark")
  })
})
