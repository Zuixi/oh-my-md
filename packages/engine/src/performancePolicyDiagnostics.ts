import type { EditorView } from "@codemirror/view"
import {
  editorPerformancePolicy,
  performanceWindowChars,
  type EditorPerformancePolicy,
} from "./performancePolicy"
import { livePreviewField } from "./decorations/build"
import { expandedRegions, pendingInWindow } from "./decorations/buildDriver"

export interface PerformancePolicyDiagnostics {
  readonly policy: EditorPerformancePolicy | null
  readonly pendingInBuildWindow: number
  readonly pendingRanges: number
  readonly decorationSpecs: number
}

export function getPerformancePolicyDiagnostics(view: EditorView): PerformancePolicyDiagnostics {
  const policy = editorPerformancePolicy(view.state)
  const live = view.state.field(livePreviewField, false)
  if (!live) {
    return { policy, pendingInBuildWindow: 0, pendingRanges: 0, decorationSpecs: 0 }
  }
  return {
    policy,
    pendingInBuildWindow: pendingInWindow(
      live.pending,
      expandedRegions(view, performanceWindowChars(policy)),
    ).length,
    pendingRanges: live.pending.length,
    decorationSpecs: live.specs.length,
  }
}
