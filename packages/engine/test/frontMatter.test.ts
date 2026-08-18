import { describe, expect, it } from "vitest"
import { collectDecorationSpecs } from "../src/decorations/build"
import { collectOutline } from "../src/outline"
import { documentStats } from "../src/stats"
import { makeState } from "./helpers"

function tags(doc: string, anchor = doc.length) {
  const state = makeState(doc).update({ selection: { anchor } }).state
  return collectDecorationSpecs(state, 0, doc.length).map(d => d.tag)
}

const DOC = "---\ntitle: hello\n---\n\n# Heading\n\nbody\n"

describe("front matter", () => {
  it("folds to a chip widget when the cursor is outside the block", () => {
    const t = tags(DOC)
    expect(t).toContain("widget:block:front-matter")
    expect(t).toContain("line:omd-h1")
  })

  it("shows source lines while the cursor is inside the block", () => {
    const t = tags(DOC, 2)
    expect(t).not.toContain("widget:block:front-matter")
    expect(t.filter(x => x === "line:omd-front-matter").length).toBeGreaterThanOrEqual(3)
  })

  it("keeps thematic rules everywhere else", () => {
    const t = tags("intro\n\n---\n\noutro")
    expect(t).toContain("widget:block:hr")
  })

  it("does not treat a mid-document hr pair as front matter", () => {
    const doc = "---\nfirst rule\n---\n\n# H\n\n---\nsecond rule\n---\n"
    const t = tags(doc)
    // Only the leading pair is front matter; the later pair stays hr rules.
    expect(t.filter(x => x === "widget:block:front-matter")).toHaveLength(1)
  })

  it("swallows an unclosed block to EOF", () => {
    // The unclosed block spans the whole doc, so the cursor is always inside
    // and the source view (not the chip) is rendered.
    const t = tags("---\ntitle: dangling\n")
    expect(t).not.toContain("widget:block:front-matter")
    expect(t).toContain("line:omd-front-matter")
  })

  it("keeps outline and stats free of front matter content", () => {
    const state = makeState("---\n# not a heading\n---\n\n# real\n")
    expect(collectOutline(state).map(item => item.text)).toEqual(["real"])

    const stats = documentStats("---\ntitle: hello world\n---\n\n正文\n")
    expect(stats.words).toBe(2)
    expect(stats.chars).toBe(2)
  })
})
