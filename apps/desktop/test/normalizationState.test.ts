import { describe, expect, it } from "vitest"
import type { NormalizationId } from "@omd/engine"
import {
  clearTabNormalization,
  projectNormalizationNotice,
  resyncNormalizationIdle,
  setNormalizationAction,
} from "../src/normalizationState"

const id = 1 as NormalizationId
const notice = { id, markerCount: 2 }

describe("normalization projection", () => {
  it("projects tabs independently and rejects stale actions", () => {
    const first = projectNormalizationNotice({}, 1, notice)
    const second = projectNormalizationNotice(first, 2, { ...notice, markerCount: 3 })
    expect(first[2]).toBeUndefined()
    expect(second[1]?.notice.markerCount).toBe(2)
    expect(setNormalizationAction(second, 1, 2 as NormalizationId, "saving")).toBe(second)
  })

  it("resyncs fresh notice and idle atomically", () => {
    const saving = setNormalizationAction(
      projectNormalizationNotice({}, 1, notice), 1, id, "saving",
    )
    const next = resyncNormalizationIdle(saving, 1, { id, markerCount: 4 })
    expect(next[1]).toEqual({ notice: { id, markerCount: 4 }, action: "idle" })
    expect(clearTabNormalization(next, 1)[1]).toBeUndefined()
  })

  it("removes a tab when projected or resynced notice is null", () => {
    const state = projectNormalizationNotice({}, 1, notice)
    expect(projectNormalizationNotice(state, 1, null)[1]).toBeUndefined()
    expect(resyncNormalizationIdle(state, 1, null)[1]).toBeUndefined()
  })

  it("keeps the same state when an unchanged notice is projected again", () => {
    const state = projectNormalizationNotice({}, 1, notice)
    expect(projectNormalizationNotice(state, 1, { id, markerCount: 2 })).toBe(state)
    expect(clearTabNormalization(state, 2)).toBe(state)
  })

  it("keeps a busy action while the pending marker count grows", () => {
    const saving = setNormalizationAction(
      projectNormalizationNotice({}, 1, notice), 1, id, "saving",
    )
    const next = projectNormalizationNotice(saving, 1, { ...notice, markerCount: 4 })
    expect(next[1]).toEqual({ notice: { ...notice, markerCount: 4 }, action: "saving" })
    expect(setNormalizationAction(next, 1, id, "reverting")).toBe(next)
  })
})
