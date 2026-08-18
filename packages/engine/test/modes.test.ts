import { describe, expect, it } from "vitest"
import { makeState } from "./helpers"
import {
  livePreviewCompartment, livePreviewExt, isLivePreview, applyToggle, setLivePreview,
} from "../src/modes/livePreview"

// NOTE: packet used isLivePreview.get(s), but @codemirror/state 6.7.1 exposes
// StateField values via state.field(isLivePreview). Same intent, correct API.
const mode = (s: any) => s.field(isLivePreview)

function stateWith(doc = "# x") {
  return makeState(doc, [livePreviewCompartment.of(livePreviewExt()), isLivePreview])
}

describe("mode switching", () => {
  it("is live by default", () => {
    const s = stateWith()
    expect(mode(s)).toBe(true)
  })

  it("toggle turns decorations off and preserves doc text", () => {
    const s0 = stateWith()
    const s1 = s0.update(applyToggle(s0)).state
    expect(mode(s1)).toBe(false)
    expect(livePreviewCompartment.get(s1)).toEqual([])   // source mode = no decorations
    expect(s1.doc.toString()).toBe("# x")
  })

  it("round-trips back to live", () => {
    const s0 = stateWith()
    const s1 = s0.update(applyToggle(s0)).state
    const s2 = s1.update(applyToggle(s1)).state
    expect(mode(s2)).toBe(true)
    expect(s2.doc.toString()).toBe("# x")
  })

  it("setLivePreview forces an explicit mode without flipping", () => {
    const s0 = stateWith()
    const s1 = s0.update(setLivePreview(false)).state
    expect(mode(s1)).toBe(false)
    const s2 = s1.update(setLivePreview(false)).state
    expect(mode(s2)).toBe(false)
    const s3 = s2.update(setLivePreview(true)).state
    expect(mode(s3)).toBe(true)
  })
})