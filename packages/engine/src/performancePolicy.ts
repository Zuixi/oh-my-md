import { Compartment, Facet, type EditorState, type Extension } from "@codemirror/state"
import type { EditorView } from "@codemirror/view"

export interface EditorPerformancePolicy {
  readonly windowLiveDecorations: boolean
  readonly blockRenderBudgetLines: number | null
}

export const SAFE_MODE_RENDER_BUDGET_LINES = 60

export const STANDARD_PERFORMANCE_POLICY: EditorPerformancePolicy = Object.freeze({
  windowLiveDecorations: false,
  blockRenderBudgetLines: null,
})

export const SAFE_PERFORMANCE_POLICY: EditorPerformancePolicy = Object.freeze({
  windowLiveDecorations: true,
  blockRenderBudgetLines: SAFE_MODE_RENDER_BUDGET_LINES,
})

function checked(policy: EditorPerformancePolicy): EditorPerformancePolicy {
  const budget = policy.blockRenderBudgetLines
  if (budget !== null && (!Number.isFinite(budget) || budget < 0)) {
    throw new RangeError(
      `blockRenderBudgetLines must be null or a finite non-negative number, got ${String(budget)}`,
    )
  }
  return policy
}

function policyValue(policy: EditorPerformancePolicy | null) {
  return performancePolicyFacet.of(policy === null ? null : checked(policy))
}

const performancePolicyFacet = Facet.define<EditorPerformancePolicy | null, EditorPerformancePolicy | null>({
  combine: values => {
    let policy: EditorPerformancePolicy | null = null
    for (const value of values) {
      if (value === null) continue
      if (policy) throw new RangeError("An editor may configure only one performance policy")
      policy = checked(value)
    }
    return policy
  },
})

const performancePolicyCompartment = new Compartment()

export function performancePolicyExtension(policy: EditorPerformancePolicy | null): Extension {
  return performancePolicyCompartment.of(policyValue(policy))
}

export function editorPerformancePolicy(state: EditorState): EditorPerformancePolicy | null {
  return state.facet(performancePolicyFacet)
}

export function setEditorPerformancePolicy(view: EditorView, policy: EditorPerformancePolicy): void {
  view.dispatch({ effects: performancePolicyCompartment.reconfigure(policyValue(policy)) })
}

export function samePerformancePolicy(
  left: EditorPerformancePolicy | null,
  right: EditorPerformancePolicy | null,
): boolean {
  if (left === null || right === null) return left === right
  return left.windowLiveDecorations === right.windowLiveDecorations
    && left.blockRenderBudgetLines === right.blockRenderBudgetLines
}
