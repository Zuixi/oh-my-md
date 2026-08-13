import { describe, expect, it } from "vitest"
import { collectOutline } from "../src/outline"
import { makeState } from "./helpers"

describe("document outline", () => {
  it("collects ATX and Setext headings with levels and positions", () => {
    const doc = "# Top\n\n## Nested\n\nTitle\n=====\n\n## Also"
    const items = collectOutline(makeState(doc))
    expect(items).toEqual([
      { level: 1, text: "Top", from: 0 },
      { level: 2, text: "Nested", from: doc.indexOf("## Nested") },
      { level: 1, text: "Title", from: doc.indexOf("Title") },
      { level: 2, text: "Also", from: doc.lastIndexOf("## Also") },
    ])
  })

  it("does not invent headings from paragraph text", () => {
    expect(collectOutline(makeState("not a heading\n\n# Real"))).toEqual([
      { level: 1, text: "Real", from: "not a heading\n\n".length },
    ])
  })
})
