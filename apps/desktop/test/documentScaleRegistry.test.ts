import { Text } from "@codemirror/state"
import { describe, expect, it, vi } from "vitest"
import { createDocumentScaleRegistry } from "../src/documentScaleRegistry"

const THRESHOLDS = { safeModeLines: 50_000, safeModeBytes: 8_000_000, renderBudgetLines: 60 }

function makeRegistry(setRenderBudget = vi.fn(), setSafeModeRendering = vi.fn()) {
  const registry = createDocumentScaleRegistry({
    ...THRESHOLDS,
    setRenderBudget,
    setSafeModeRendering,
  })
  return { registry, setRenderBudget, setSafeModeRendering }
}

describe("document scale registry", () => {
  it("classifies safe mode by the line threshold", () => {
    const { registry } = makeRegistry()
    expect(registry.classify(1, THRESHOLDS.safeModeLines)).toEqual({ safeMode: false, readOnly: false })
    expect(registry.isSafeMode(1)).toBe(false)
    expect(registry.classify(1, THRESHOLDS.safeModeLines + 1)).toEqual({ safeMode: true, readOnly: false })
    expect(registry.isSafeMode(1)).toBe(true)
  })

  it("classifies safe mode by the byte threshold even under the line threshold", () => {
    const { registry } = makeRegistry()
    registry.setBytes(1, THRESHOLDS.safeModeBytes)
    expect(registry.classify(1, 10)).toEqual({ safeMode: false, readOnly: false })
    registry.setBytes(1, THRESHOLDS.safeModeBytes + 1)
    expect(registry.classify(1, 10)).toEqual({ safeMode: true, readOnly: false })
  })

  it("clears bytes when set to undefined, dropping the byte-axis contribution", () => {
    const { registry } = makeRegistry()
    registry.setBytes(1, THRESHOLDS.safeModeBytes + 1)
    expect(registry.classify(1, 10).safeMode).toBe(true)
    registry.setBytes(1, undefined)
    expect(registry.classify(1, 10).safeMode).toBe(false)
  })

  it("read-only always implies safe mode regardless of size", () => {
    const { registry } = makeRegistry()
    registry.setReadOnly(1, true)
    expect(registry.classify(1, 1)).toEqual({ safeMode: true, readOnly: true })
    expect(registry.isReadOnly(1)).toBe(true)
    registry.setReadOnly(1, false)
    expect(registry.classify(1, 1)).toEqual({ safeMode: false, readOnly: false })
  })

  it("isReadOnly/isSafeMode default to false for an unknown tab", () => {
    const { registry } = makeRegistry()
    expect(registry.isReadOnly(99)).toBe(false)
    expect(registry.isSafeMode(99)).toBe(false)
  })

  it("stashes and takes a Text exactly once", () => {
    const { registry } = makeRegistry()
    const text = Text.of(["a", "b"])
    expect(registry.takeText(1)).toBeUndefined()
    registry.stashText(1, text)
    expect(registry.takeText(1)).toBe(text)
    expect(registry.takeText(1)).toBeUndefined()
  })

  it("applyRenderPolicy sets a finite budget and enables safe-mode rendering only when safe mode is active", () => {
    const { registry, setRenderBudget, setSafeModeRendering } = makeRegistry()
    registry.classify(1, THRESHOLDS.safeModeLines + 1)
    registry.applyRenderPolicy(1)
    expect(setRenderBudget).toHaveBeenCalledWith(THRESHOLDS.renderBudgetLines)
    expect(setSafeModeRendering).toHaveBeenCalledWith(true)

    setRenderBudget.mockClear()
    setSafeModeRendering.mockClear()
    registry.classify(2, 10)
    registry.applyRenderPolicy(2)
    expect(setRenderBudget).toHaveBeenCalledWith(Infinity)
    expect(setSafeModeRendering).toHaveBeenCalledWith(false)
  })

  it("applyRenderPolicy reads whichever tab id it is given, independent of any notion of an active tab", () => {
    const { registry, setRenderBudget, setSafeModeRendering } = makeRegistry()
    registry.classify(1, THRESHOLDS.safeModeLines + 1)
    registry.classify(2, 10)
    registry.applyRenderPolicy(2)
    expect(setRenderBudget).toHaveBeenLastCalledWith(Infinity)
    expect(setSafeModeRendering).toHaveBeenLastCalledWith(false)
    registry.applyRenderPolicy(1)
    expect(setRenderBudget).toHaveBeenLastCalledWith(THRESHOLDS.renderBudgetLines)
    expect(setSafeModeRendering).toHaveBeenLastCalledWith(true)
  })

  it("evaluate reads the line, byte, and read-only axes without mutating cached isSafeMode", () => {
    const { registry } = makeRegistry()
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
    const { registry } = makeRegistry()
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
    const { registry } = makeRegistry()
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
    const { registry } = makeRegistry()
    registry.setReadOnly(5, true)
    registry.classify(5, 1)
    registry.classify(6, 1)
    expect(registry.isSafeMode(5)).toBe(true)
    expect(registry.isSafeMode(6)).toBe(false)
    registry.remove(5)
    expect(registry.isSafeMode(6)).toBe(false)
  })
})
