/**
 * Applies a tab's document-scale policy to its own view.
 *
 * A view is classified from its live line count (`view.state.doc.lines`, free —
 * never split the document) and its live length (the only size an unsaved tab
 * has, so a large paste into an untitled document raises the tier at once), then
 * the per-view engine policy (facet) is pushed into that tab's view only, so
 * background tabs can never inherit the active tab's budget/windowing and
 * activation order is irrelevant.
 *
 * Every view-creation path must go through the returned applier, or large
 * documents opened from the tree/search bypass safe mode.
 */
import type { EditorView } from "@codemirror/view"
import {
  editorPerformancePolicy, samePerformancePolicy, setEditorPerformancePolicy,
} from "@omd/engine"
import { LARGE_DOC_LINES } from "./constants"
import type { DocumentScaleRegistry } from "./documentScaleRegistry"

export interface LargeDocNotice {
  sessionId: number
  lines: number
  safeMode: boolean
  readonly?: boolean
}

export interface EditorScalePolicyHost {
  registry: DocumentScaleRegistry
  setNotice(notice: LargeDocNotice | null): void
  /** Asks the stats panel for a fresh computation (count = reset trigger). */
  requestStats(): void
}

function noticeFor(
  sessionId: number,
  lines: number,
  safeMode: boolean,
  readonly: boolean,
): LargeDocNotice | null {
  if (readonly) return { sessionId, lines, safeMode: true, readonly: true }
  if (safeMode) return { sessionId, lines, safeMode: true }
  return lines > LARGE_DOC_LINES ? { sessionId, lines, safeMode: false } : null
}

/** Live document length; fake views in unit tests expose no `length`. */
function docCharLength(view: EditorView): number {
  const length = (view.state.doc as { length?: number }).length
  return typeof length === "number" ? length : 0
}

/** No-op for fake views: only a real EditorState exposes `facet`. */
function pushPerformancePolicy(
  view: EditorView,
  registry: DocumentScaleRegistry,
  tabId: number,
) {
  const state = view.state as { facet?: unknown }
  if (typeof state.facet !== "function") return
  const next = registry.performancePolicy(tabId)
  if (samePerformancePolicy(editorPerformancePolicy(view.state), next)) return
  setEditorPerformancePolicy(view, next)
}

/** The policy applier plus its render-free refresh path. */
export interface EditorScalePolicyApplier {
  /** Classify a view and push its policy; always reports the notice + stats. */
  (view: EditorView, tabId: number): void
  /** Re-classify the live line count and push the policy only when it changed.
   * Used on the document-materialize tick: the notice/stats callbacks fire only
   * when the cached classification actually flips, so typing in a document that
   * stays in the same tier never re-renders the app. */
  refresh(view: EditorView | undefined, tabId: number): void
}

export function createEditorScalePolicyApplier(
  host: EditorScalePolicyHost,
): EditorScalePolicyApplier {
  const apply: EditorScalePolicyApplier = (view, tabId) => {
    const lines = view.state.doc.lines
    const { safeMode, readOnly } = host.registry.classify(tabId, lines, docCharLength(view))
    pushPerformancePolicy(view, host.registry, tabId)
    host.setNotice(noticeFor(tabId, lines, safeMode, readOnly))
    host.requestStats()
  }
  apply.refresh = (view, tabId) => {
    if (!view) return
    const wasSafeMode = host.registry.isSafeMode(tabId)
    const lines = view.state.doc.lines
    const { safeMode, readOnly } = host.registry.classify(tabId, lines, docCharLength(view))
    pushPerformancePolicy(view, host.registry, tabId)
    if (safeMode === wasSafeMode) return
    host.setNotice(noticeFor(tabId, lines, safeMode, readOnly))
    host.requestStats()
  }
  return apply
}
