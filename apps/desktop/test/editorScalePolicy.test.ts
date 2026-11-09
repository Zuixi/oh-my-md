import { EditorState, Text } from "@codemirror/state"
import type { EditorView } from "@codemirror/view"
import { describe, expect, it, vi } from "vitest"
import {
  editorPerformancePolicy, performancePolicyExtension,
  SAFE_PERFORMANCE_POLICY, STANDARD_PERFORMANCE_POLICY,
} from "@omd/engine"
import { createDocumentScaleRegistry } from "../src/documentScaleRegistry"
import {
  createEditorScalePolicyApplier,
  type LargeDocNotice,
} from "../src/editorScalePolicy"

const THRESHOLDS = { safeModeLines: 50_000, safeModeBytes: 8_000_000 }

interface FakeView {
  state: EditorState
  dispatch(spec: Parameters<EditorState["update"]>[0]): void
}

/** A view whose state is a real `EditorState`, mounted the way `Editor.ts`
 *  mounts it, so the compartment reconfigure lands in the state. */
function makeView(doc: string | Text): FakeView {
  const view: FakeView = {
    state: EditorState.create({ doc, extensions: [performancePolicyExtension(null)] }),
    dispatch(spec) {
      view.state = view.state.update(spec).state
    },
  }
  return view
}

function makeApplier() {
  const registry = createDocumentScaleRegistry(THRESHOLDS)
  const notices: Array<LargeDocNotice | null> = []
  const requestStats = vi.fn()
  const apply = createEditorScalePolicyApplier({
    registry,
    setNotice: notice => notices.push(notice),
    requestStats,
  })
  return { registry, apply, notices, requestStats }
}

function bigDoc(lines: number): string {
  return Array.from({ length: lines }, (_, i) => `line ${i}`).join("\n")
}

describe("editor scale policy applier", () => {
  it("pushes the safe policy into the view that is over the line threshold", () => {
    const { apply, notices, requestStats } = makeApplier()
    const view = makeView(bigDoc(THRESHOLDS.safeModeLines + 10))
    apply(view as unknown as EditorView, 1)
    expect(editorPerformancePolicy(view.state)).toEqual(SAFE_PERFORMANCE_POLICY)
    expect(notices[notices.length - 1]).toMatchObject({ sessionId: 1, safeMode: true })
    expect(requestStats).toHaveBeenCalled()
  })

  it("pushes the standard policy into a small view and clears the notice", () => {
    const { apply, notices } = makeApplier()
    const view = makeView("small")
    apply(view as unknown as EditorView, 1)
    expect(editorPerformancePolicy(view.state)).toEqual(STANDARD_PERFORMANCE_POLICY)
    expect(notices[notices.length - 1]).toBeNull()
  })

  it("keeps each view's policy independent of the other views", () => {
    const { registry, apply } = makeApplier()
    const big = makeView(bigDoc(THRESHOLDS.safeModeLines + 10))
    const small = makeView("small")
    apply(big as unknown as EditorView, 1)
    apply(small as unknown as EditorView, 2)
    expect(registry.performancePolicy(1)).toEqual(SAFE_PERFORMANCE_POLICY)
    expect(registry.performancePolicy(2)).toEqual(STANDARD_PERFORMANCE_POLICY)
    expect(editorPerformancePolicy(big.state)).toEqual(SAFE_PERFORMANCE_POLICY)
    expect(editorPerformancePolicy(small.state)).toEqual(STANDARD_PERFORMANCE_POLICY)
  })

  it("treats a read-only tab as safe mode and reports the read-only notice", () => {
    const { registry, apply, notices } = makeApplier()
    registry.setReadOnly(3, true)
    const view = makeView("small")
    apply(view as unknown as EditorView, 3)
    expect(editorPerformancePolicy(view.state)).toEqual(SAFE_PERFORMANCE_POLICY)
    expect(notices[notices.length - 1]).toMatchObject({ sessionId: 3, safeMode: true, readonly: true })
  })

  it("does not dispatch when the view already carries the required policy", () => {
    const { apply } = makeApplier()
    const view = makeView("small")
    const baseline = view.state
    apply(view as unknown as EditorView, 1)
    const afterFirst = view.state
    apply(view as unknown as EditorView, 1)
    // Second application is a no-op: the facet already matches, so no reconfigure.
    expect(view.state).toBe(afterFirst)
    expect(afterFirst.doc).toBe(baseline.doc)
  })
})
