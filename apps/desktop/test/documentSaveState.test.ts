import { describe, expect, it } from "vitest"
import {
  applyDivergence,
  beginSave,
  clearDivergence,
  completeSave,
  failSave,
  initialSaveState,
  isFreshObservation,
  removeTabSaveState,
  tabSaveState,
  updateTabSaveState,
  type ExistingDiskSnapshot,
} from "../src/documentSaveState"

const disk: ExistingDiskSnapshot = {
  requestedPath: "/notes/a.md",
  contents: "theirs",
  version: { resolvedPath: "/notes/a.md", fingerprint: "v1:bb" },
}

describe("document save state", () => {
  it("advances io generation on every save boundary", () => {
    const saving = beginSave(initialSaveState(), 1, "snapshot")
    expect(saving.lifecycle).toEqual({ kind: "saving", operationId: 1, snapshot: "snapshot" })
    const done = completeSave(saving, 1)
    expect(done.lifecycle.kind).toBe("idle")
    expect(done.ioGeneration).toBe(saving.ioGeneration + 1)
  })

  it("ignores completions from a stale operation", () => {
    const saving = beginSave(initialSaveState(), 2, "snapshot")
    expect(completeSave(saving, 1)).toBe(saving)
    expect(failSave(saving, 1, "disk full")).toBe(saving)
  })

  it("keeps lifecycle and divergence orthogonal", () => {
    const conflicted = applyDivergence(beginSave(initialSaveState(), 1, "mine"), {
      kind: "contentConflict",
      localSnapshot: "mine",
      disk,
    })
    expect(conflicted.lifecycle.kind).toBe("saving")
    expect(conflicted.divergence.kind).toBe("contentConflict")
  })

  it("keeps divergence and dirty context when a save fails", () => {
    const conflicted = applyDivergence(initialSaveState(), {
      kind: "contentConflict",
      localSnapshot: "mine",
      disk,
    })
    const failed = failSave(beginSave(conflicted, 1, "mine"), 1, "disk full")
    expect(failed.lifecycle).toEqual({ kind: "saveFailed", message: "disk full" })
    expect(failed.divergence.kind).toBe("contentConflict")
  })

  it("clears only divergence", () => {
    const failed = failSave(beginSave(initialSaveState(), 1, "mine"), 1, "disk full")
    const conflicted = applyDivergence(failed, { kind: "deletedExternally", localSnapshot: "mine" })
    const cleared = clearDivergence(conflicted)
    expect(cleared.divergence).toEqual({ kind: "none" })
    expect(cleared.lifecycle.kind).toBe("saveFailed")
  })

  it("discards observations captured before a newer io generation", () => {
    const state = initialSaveState()
    expect(isFreshObservation(state, state.ioGeneration)).toBe(true)
    const saving = beginSave(state, 1, "mine")
    expect(isFreshObservation(saving, state.ioGeneration)).toBe(false)
    expect(isFreshObservation(saving, saving.ioGeneration)).toBe(false)
    const done = completeSave(saving, 1)
    expect(isFreshObservation(done, saving.ioGeneration)).toBe(false)
    expect(isFreshObservation(done, done.ioGeneration)).toBe(true)
  })

  it("adds and removes tab entries immutably", () => {
    const states = updateTabSaveState({}, 2, beginSave(initialSaveState(), 1, "mine"))
    expect(tabSaveState(states, 2).lifecycle.kind).toBe("saving")
    expect(tabSaveState(states, 3)).toEqual(initialSaveState())
    expect(removeTabSaveState(states, 2)[2]).toBeUndefined()
    expect(states[2]).toBeDefined()
  })
})
