import { describe, expect, it } from "vitest"
import { collectDecorationSpecs } from "../src/decorations/build"
import { makeState } from "./helpers"

const tags = (doc: string) =>
  collectDecorationSpecs(makeState(doc), 0, doc.length).map(d => d.tag)

describe("tables (M1 parse-only)", () => {
  it("parses a GFM table", () => {
    // sanity: Table node is produced by the GFM extension (verified in parse.test).
    // Here we assert M1 produces NO table widget (TableWidget is deferred to M2).
    const doc = "| a | b |\n|---|---|\n| 1 | 2 |"
    expect(tags(doc)).not.toContain("widget:table")
  })
})
