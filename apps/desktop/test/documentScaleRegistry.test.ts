import { EditorState, Text } from "@codemirror/state"
import type { EditorView } from "@codemirror/view"
import { describe, expect, it } from "vitest"
import {
  editorPerformancePolicy,
  performancePolicyExtension,
  SAFE_PERFORMANCE_POLICY,
  STANDARD_PERFORMANCE_POLICY,
  WINDOWED_LIVE_MIN_BYTES,
  WINDOWED_LIVE_MIN_LINES,
  WINDOWED_PERFORMANCE_POLICY,
} from "@omd/engine"
import { createDocumentScaleRegistry } from "../src/documentScaleRegistry"
import { createEditorScalePolicyApplier } from "../src/editorScalePolicy"

const THRESHOLDS = { safeModeLines: 50_000, safeModeBytes: 8_000_000 }

function makeRegistry() {
  return createDocumentScaleRegistry(THRESHOLDS)
}

describe("document scale registry", () => {
  it("classifies safe mode by the line threshold", () => {
    const registry = makeRegistry()
    expect(registry.classify(1, THRESHOLDS.safeModeLines)).toEqual({ safeMode: false, readOnly: false })
    expect(registry.isSafeMode(1)).toBe(false)
    expect(registry.classify(1, THRESHOLDS.safeModeLines + 1)).toEqual({ safeMode: true, readOnly: false })
    expect(registry.isSafeMode(1)).toBe(true)
  })

  it("classifies safe mode by the byte threshold even under the line threshold", () => {
    const registry = makeRegistry()
    registry.setBytes(1, THRESHOLDS.safeModeBytes)
    expect(registry.classify(1, 10)).toEqual({ safeMode: false, readOnly: false })
    registry.setBytes(1, THRESHOLDS.safeModeBytes + 1)
    expect(registry.classify(1, 10)).toEqual({ safeMode: true, readOnly: false })
  })

  it("clears bytes when set to undefined, dropping the byte-axis contribution", () => {
    const registry = makeRegistry()
    registry.setBytes(1, THRESHOLDS.safeModeBytes + 1)
    expect(registry.classify(1, 10).safeMode).toBe(true)
    registry.setBytes(1, undefined)
    expect(registry.classify(1, 10).safeMode).toBe(false)
  })

  it("read-only always implies safe mode regardless of size", () => {
    const registry = makeRegistry()
    registry.setReadOnly(1, true)
    expect(registry.classify(1, 1)).toEqual({ safeMode: true, readOnly: true })
    expect(registry.isReadOnly(1)).toBe(true)
    registry.setReadOnly(1, false)
    expect(registry.classify(1, 1)).toEqual({ safeMode: false, readOnly: false })
  })

  it("isReadOnly/isSafeMode default to false for an unknown tab", () => {
    const registry = makeRegistry()
    expect(registry.isReadOnly(99)).toBe(false)
    expect(registry.isSafeMode(99)).toBe(false)
  })

  it("stashes and takes a Text exactly once", () => {
    const registry = makeRegistry()
    const text = Text.of(["a", "b"])
    expect(registry.takeText(1)).toBeUndefined()
    registry.stashText(1, text)
    expect(registry.takeText(1)).toBe(text)
    expect(registry.takeText(1)).toBeUndefined()
  })

  it("performancePolicy derives the engine policy from the cached safe-mode state", () => {
    const registry = makeRegistry()
    registry.classify(1, THRESHOLDS.safeModeLines + 1)
    expect(registry.performancePolicy(1)).toBe(SAFE_PERFORMANCE_POLICY)

    registry.classify(2, 10)
    expect(registry.performancePolicy(2)).toBe(STANDARD_PERFORMANCE_POLICY)
  })

  it("performancePolicy reads whichever tab id it is given, independent of any notion of an active tab", () => {
    const registry = makeRegistry()
    registry.classify(1, THRESHOLDS.safeModeLines + 1)
    registry.classify(2, 10)
    expect(registry.performancePolicy(2)).toBe(STANDARD_PERFORMANCE_POLICY)
    expect(registry.performancePolicy(1)).toBe(SAFE_PERFORMANCE_POLICY)
  })

  it("derives the windowed policy from the recorded line and byte scale", () => {
    const registry = makeRegistry()
    // Exactly at a threshold stays standard ("above", not "at or above").
    registry.classify(1, WINDOWED_LIVE_MIN_LINES)
    expect(registry.performancePolicy(1)).toBe(STANDARD_PERFORMANCE_POLICY)
    registry.classify(1, WINDOWED_LIVE_MIN_LINES + 1)
    expect(registry.performancePolicy(1)).toBe(WINDOWED_PERFORMANCE_POLICY)

    registry.setBytes(2, WINDOWED_LIVE_MIN_BYTES)
    registry.classify(2, 10)
    expect(registry.performancePolicy(2)).toBe(STANDARD_PERFORMANCE_POLICY)
    registry.setBytes(2, WINDOWED_LIVE_MIN_BYTES + 1)
    expect(registry.performancePolicy(2)).toBe(WINDOWED_PERFORMANCE_POLICY)

    // Safe mode wins over windowing: it still needs the block render budget.
    registry.classify(3, THRESHOLDS.safeModeLines + 1)
    expect(registry.performancePolicy(3)).toBe(SAFE_PERFORMANCE_POLICY)
  })

  it("drops the recorded line count when the tab is removed", () => {
    const registry = makeRegistry()
    registry.classify(1, WINDOWED_LIVE_MIN_LINES + 1)
    expect(registry.performancePolicy(1)).toBe(WINDOWED_PERFORMANCE_POLICY)
    registry.remove(1)
    expect(registry.performancePolicy(1)).toBe(STANDARD_PERFORMANCE_POLICY)
  })

  it("evaluate reads the line, byte, and read-only axes without mutating cached isSafeMode", () => {
    const registry = makeRegistry()
    // Line axis.
    expect(registry.evaluate(1, THRESHOLDS.safeModeLines)).toEqual({ safeMode: false, readOnly: false })
    expect(registry.evaluate(1, THRESHOLDS.safeModeLines + 1)).toEqual({ safeMode: true, readOnly: false })
    expect(registry.isSafeMode(1)).toBe(false) // still unmutated by either call above

    // Byte axis.
    registry.setBytes(2, THRESHOLDS.safeModeBytes + 1)
    expect(registry.evaluate(2, 10)).toEqual({ safeMode: true, readOnly: false })
    expect(registry.isSafeMode(2)).toBe(false)

    // Read-only axis.
    registry.setReadOnly(3, true)
    expect(registry.evaluate(3, 1)).toEqual({ safeMode: true, readOnly: true })
    expect(registry.isSafeMode(3)).toBe(false)
  })

  it("evaluate never mutates the cached safe-mode set even after classify has cached a different value", () => {
    const registry = makeRegistry()
    registry.classify(1, 10)
    expect(registry.isSafeMode(1)).toBe(false)
    // A render-time evaluate() crossing the threshold must not update the cache.
    expect(registry.evaluate(1, THRESHOLDS.safeModeLines + 1).safeMode).toBe(true)
    expect(registry.isSafeMode(1)).toBe(false)
    // classify() still owns writing the cache.
    expect(registry.classify(1, THRESHOLDS.safeModeLines + 1).safeMode).toBe(true)
    expect(registry.isSafeMode(1)).toBe(true)
  })

  it("remove clears bytes, stashed text, read-only, and safe-mode state for a tab", () => {
    const registry = makeRegistry()
    const text = Text.of(["x"])
    registry.setBytes(1, 999)
    registry.setReadOnly(1, true)
    registry.stashText(1, text)
    registry.classify(1, THRESHOLDS.safeModeLines + 1)
    expect(registry.isSafeMode(1)).toBe(true)

    registry.remove(1)

    expect(registry.evaluate(1, 10)).toEqual({ safeMode: false, readOnly: false })
    expect(registry.isReadOnly(1)).toBe(false)
    expect(registry.isSafeMode(1)).toBe(false)
    expect(registry.takeText(1)).toBeUndefined()
  })

  it("keeps per-tab state independent across multiple tabs", () => {
    const registry = makeRegistry()
    registry.setReadOnly(5, true)
    registry.classify(5, 1)
    registry.classify(6, 1)
    expect(registry.isSafeMode(5)).toBe(true)
    expect(registry.isSafeMode(6)).toBe(false)
    registry.remove(5)
    expect(registry.isSafeMode(6)).toBe(false)
  })
})

/** A view-shaped double that applies dispatched specs to a real state. */
interface DispatchableView {
  state: EditorState
  dispatch(spec: Parameters<EditorState["update"]>[0]): void
}

// An unsaved tab has no disk byte count: the live document length is the only
// size signal, so pasting a large document must raise the tier immediately.
describe("document scale registry live document size", () => {
  it("classifies the windowed tier from the live length alone", () => {
    const registry = makeRegistry()
    registry.classify(1, 1, WINDOWED_LIVE_MIN_BYTES)
    expect(registry.performancePolicy(1)).toBe(STANDARD_PERFORMANCE_POLICY)
    registry.classify(1, 1, WINDOWED_LIVE_MIN_BYTES + 1)
    expect(registry.performancePolicy(1)).toBe(WINDOWED_PERFORMANCE_POLICY)
  })

  it("classifies safe mode from the live length alone", () => {
    const registry = makeRegistry()
    expect(registry.classify(1, 1, THRESHOLDS.safeModeBytes + 1))
      .toEqual({ safeMode: true, readOnly: false })
    expect(registry.isSafeMode(1)).toBe(true)
  })

  it("evaluate honours a live length without mutating the cached tier", () => {
    const registry = makeRegistry()
    expect(registry.evaluate(1, 1, THRESHOLDS.safeModeBytes + 1).safeMode).toBe(true)
    expect(registry.isSafeMode(1)).toBe(false)
  })

  it("keeps the largest known size so a shrunk document never reconfigures back", () => {
    const registry = makeRegistry()
    registry.classify(1, 1, WINDOWED_LIVE_MIN_BYTES + 1)
    registry.classify(1, 1, 10)
    expect(registry.performancePolicy(1)).toBe(WINDOWED_PERFORMANCE_POLICY)
    // A larger disk byte count still wins.
    registry.setBytes(1, THRESHOLDS.safeModeBytes + 1)
    expect(registry.classify(1, 1, 10).safeMode).toBe(true)
  })

  it("remove drops the recorded live size", () => {
    const registry = makeRegistry()
    registry.classify(1, 1, WINDOWED_LIVE_MIN_BYTES + 1)
    registry.remove(1)
    expect(registry.performancePolicy(1)).toBe(STANDARD_PERFORMANCE_POLICY)
    expect(registry.evaluate(1, 1).safeMode).toBe(false)
  })

  it("the policy applier feeds the view's live length into the classification", () => {
    const registry = makeRegistry()
    const applier = createEditorScalePolicyApplier({
      registry,
      setNotice: () => undefined,
      requestStats: () => undefined,
    })
    // One very long line: under the line threshold, far over the byte threshold.
    const view: DispatchableView = {
      state: EditorState.create({
        doc: "a".repeat(WINDOWED_LIVE_MIN_BYTES + 1),
        extensions: [performancePolicyExtension(STANDARD_PERFORMANCE_POLICY)],
      }),
      dispatch(spec) {
        view.state = view.state.update(spec).state
      },
    }

    applier(view as unknown as EditorView, 1)

    expect(registry.performancePolicy(1)).toBe(WINDOWED_PERFORMANCE_POLICY)
    expect(editorPerformancePolicy(view.state)).toBe(WINDOWED_PERFORMANCE_POLICY)
  })
})
