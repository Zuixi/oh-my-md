import { describe, expect, it } from "vitest"
import { prepareTypingView } from "../bench/measure"
import { makeBenchmarkDoc } from "../bench/generate"
import { livePreviewField } from "../src/decorations/build"

describe("prepareTypingView", () => {
  it("drains a live complete-tree view before timing starts", () => {
    const doc = makeBenchmarkDoc(500)
    const view = prepareTypingView(doc, { mode: "live", tree: "complete", drain: true })
    const live = view.state.field(livePreviewField)
    expect(live.pending).toEqual([])
    expect(live.specs.length).toBeGreaterThan(100)
    const parent = view.dom.parentElement
    view.destroy()
    parent?.remove()
  })
})
