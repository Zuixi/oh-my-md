import { describe, expect, it } from "vitest"
import { collectDecorationSpecs } from "../src/decorations/build"
import { makeState } from "./helpers"

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

  it("keeps the HeaderMark folded even when the cursor is on the heading line", () => {
    const doc = "# Title"
    let state = makeState(doc)
    // 路线 A：光标落在标题行也折叠 —— 点击只定位光标，不显源码。
    state = state.update({ selection: { anchor: 1 } }).state
    const t = collectDecorationSpecs(state, 0, state.doc.length).map(d => `${d.tag}@${d.from}-${d.to}`)
    expect(t).toContain("replace:HeaderMark@0-2")
  })

  it("styles a Setext H1 title line and hides the underline when the cursor is away", () => {
    const doc = "Title\n=====\n\nbody"
    let state = makeState(doc)
    state = state.update({ selection: { anchor: doc.length } }).state
    const away = collectDecorationSpecs(state, 0, state.doc.length).map(d => `${d.tag}@${d.from}-${d.to}`)
    expect(away).toContain("line:omd-h1@0-0")
    expect(away).toContain("replace:HeaderMark@6-12")
  })

  it("styles a Setext H2 title line and hides the dash underline when the cursor is away", () => {
    const doc = "Title\n-----\n\nbody"
    let state = makeState(doc)
    state = state.update({ selection: { anchor: doc.length } }).state
    const away = collectDecorationSpecs(state, 0, state.doc.length).map(d => `${d.tag}@${d.from}-${d.to}`)
    expect(away).toContain("line:omd-h2@0-0")
    expect(away).toContain("replace:HeaderMark@6-12")
  })

  it("collapses the Setext underline line when the next paragraph is adjacent", () => {
    const doc = "Title\n=====\nNext"
    let state = makeState(doc)
    state = state.update({ selection: { anchor: doc.length } }).state
    const away = collectDecorationSpecs(state, 0, state.doc.length).map(d => `${d.tag}@${d.from}-${d.to}`)
    expect(away).toContain("line:omd-h1@0-0")
    expect(away).toContain("replace:HeaderMark@6-12")
  })

  it("keeps the Setext underline hidden when the cursor is on the title line", () => {
    const doc = "Title\n====="
    let state = makeState(doc)
    state = state.update({ selection: { anchor: 0 } }).state
    const t = collectDecorationSpecs(state, 0, state.doc.length).map(d => d.tag)
    expect(t).toContain("line:omd-h1")
    expect(t).toContain("replace:HeaderMark")
  })

  it("keeps the Setext underline hidden when the cursor is on the underline", () => {
    const doc = "Title\n====="
    let state = makeState(doc)
    state = state.update({ selection: { anchor: 6 } }).state
    const t = collectDecorationSpecs(state, 0, state.doc.length).map(d => d.tag)
    expect(t).toContain("line:omd-h1")
    expect(t).toContain("replace:HeaderMark")
  })
})
