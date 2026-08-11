import { describe, expect, it } from "vitest"
import { collectDecorationSpecs } from "../src/decorations/build"
import { makeState } from "./helpers"

const tags = (doc: string) =>
  collectDecorationSpecs(makeState(doc), 0, doc.length).map(d => `${d.tag}@${d.from}-${d.to}`)

describe("headings", () => {
  it("tags heading line and hides the HeaderMark + trailing space", () => {
    // Cursor must be on a different line for the heading mark to be folded.
    // Place cursor at 'body' (line 3) so H1's mark on line 1 is collapsed.
    const doc = "# Title\n\nbody"
    let state = makeState(doc)
    state = state.update({ selection: { anchor: doc.length } }).state  // cursor on 'body' line
    const t = collectDecorationSpecs(state, 0, state.doc.length).map(d => `${d.tag}@${d.from}-${d.to}`)
    expect(t).toContain("line:omd-h1@0-0")
    expect(t).toContain("replace:HeaderMark@0-2")   // "# " hidden (cursor is on a different line)
  })

  it("does not hide the HeaderMark when the cursor is on the heading line", () => {
    const doc = "# Title"
    let state = makeState(doc)
    // Cursor anywhere on the heading line → the mark stays visible.
    state = state.update({ selection: { anchor: 1 } }).state
    const t = collectDecorationSpecs(state, 0, state.doc.length).map(d => d.tag)
    expect(t).not.toContain("replace:HeaderMark")
  })
})
