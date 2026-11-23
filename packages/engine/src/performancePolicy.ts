import { Compartment, Facet, type EditorState, type Extension } from "@codemirror/state"
import type { EditorView } from "@codemirror/view"
import { LIVE_PRUNE_MARGIN_CHARS, LIVE_WINDOW_CHARS } from "./safeModeRendering"

export interface EditorPerformancePolicy {
  readonly windowLiveDecorations: boolean
  readonly blockRenderBudgetLines: number | null
  /** Build-window radius in characters (default `LIVE_WINDOW_CHARS`). */
  readonly liveWindowChars?: number
  /** Prune hysteresis beyond the build window (default `LIVE_PRUNE_MARGIN_CHARS`). */
  readonly livePruneMarginChars?: number
}

export const SAFE_MODE_RENDER_BUDGET_LINES = 60

/** Windowed live preview starts at this scale: above either axis the legacy
 * full-drain decoration set costs more per keystroke than a viewport window. */
export const WINDOWED_LIVE_MIN_LINES = 2_000
export const WINDOWED_LIVE_MIN_BYTES = 100 * 1024

// A dense formatted paragraph yields ~12 specs, so ±32k chars keeps the window
// at a few hundred specs — small enough that mapping/filtering it is far below
// a frame, wide enough to cover multi-screen scrolling before a rebuild.
export const WINDOWED_LIVE_WINDOW_CHARS = 32_768
export const WINDOWED_LIVE_PRUNE_MARGIN_CHARS = 16_384

export const STANDARD_PERFORMANCE_POLICY: EditorPerformancePolicy = Object.freeze({
  windowLiveDecorations: false,
  blockRenderBudgetLines: null,
})

export const SAFE_PERFORMANCE_POLICY: EditorPerformancePolicy = Object.freeze({
  windowLiveDecorations: true,
  blockRenderBudgetLines: SAFE_MODE_RENDER_BUDGET_LINES,
})

/** Medium/large formatted documents: viewport windowing without safe-mode's
 * block render budget, so blocks keep rendering in full. */
export const WINDOWED_PERFORMANCE_POLICY: EditorPerformancePolicy = Object.freeze({
  windowLiveDecorations: true,
  blockRenderBudgetLines: null,
  liveWindowChars: WINDOWED_LIVE_WINDOW_CHARS,
  livePruneMarginChars: WINDOWED_LIVE_PRUNE_MARGIN_CHARS,
})

function checked(policy: EditorPerformancePolicy): EditorPerformancePolicy {
  const budget = policy.blockRenderBudgetLines
  if (budget !== null && (!Number.isFinite(budget) || budget < 0)) {
    throw new RangeError(
      `blockRenderBudgetLines must be null or a finite non-negative number, got ${String(budget)}`,
    )
  }
  for (const [name, value] of [
    ["liveWindowChars", policy.liveWindowChars],
    ["livePruneMarginChars", policy.livePruneMarginChars],
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
      throw new RangeError(`${name} must be undefined or a finite positive number, got ${String(value)}`)
    }
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

/** Build-window radius for a policy; `null`/omitted falls back to the legacy
 * module constant so the pre-policy global toggle keeps its exact behavior. */
export function performanceWindowChars(policy: EditorPerformancePolicy | null): number {
  return policy?.liveWindowChars ?? LIVE_WINDOW_CHARS
}

/** Prune hysteresis for a policy (see `performanceWindowChars`). */
export function performancePruneMarginChars(policy: EditorPerformancePolicy | null): number {
  return policy?.livePruneMarginChars ?? LIVE_PRUNE_MARGIN_CHARS
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
    && (left.liveWindowChars ?? null) === (right.liveWindowChars ?? null)
    && (left.livePruneMarginChars ?? null) === (right.livePruneMarginChars ?? null)
}
