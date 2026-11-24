import type { Text } from "@codemirror/state"
import {
  SAFE_PERFORMANCE_POLICY,
  STANDARD_PERFORMANCE_POLICY,
  WINDOWED_LIVE_MIN_BYTES,
  WINDOWED_LIVE_MIN_LINES,
  WINDOWED_PERFORMANCE_POLICY,
  type EditorPerformancePolicy,
} from "@omd/engine"

/**
 * Spec 05/05b 文档档位策略的单一持有者：字节数、只读标记、暂存 Text、以及
 * 由此推导的安全模式集合，原先散落在 App.tsx 的四个 ref（safeModeTabsRef /
 * docBytesRef / docTextsRef / readonlyTabsRef）现在都在这里。`editorScalePolicy`
 * 在正确的时机调用 `classify` / `performancePolicy`，App.tsx 不再直接持有任何
 * Map/Set，也不再改写 engine 的进程级全局预算。
 */
export interface DocumentScaleClassification {
  safeMode: boolean
  readOnly: boolean
}

export interface DocumentScaleRegistryDeps {
  safeModeLines: number
  safeModeBytes: number
}

export interface DocumentScaleRegistry {
  setBytes(tabId: number, bytes: number | undefined): void
  setReadOnly(tabId: number, readOnly: boolean): void
  stashText(tabId: number, text: Text): void
  /** One-shot: returns the stashed Text (if any) and clears it. */
  takeText(tabId: number): Text | undefined
  isReadOnly(tabId: number): boolean
  isSafeMode(tabId: number): boolean
  /** Pure read of what the classification *would* be for the given live line
   * count, from current bytes/read-only state. Does not mutate the cached
   * safe-mode set — callers that need a render-time gate (e.g. reacting to
   * the document crossing the line threshold mid-typing) use this instead of
   * `classify`, which would otherwise fire cache writes on every render.
   * `minBytes` lets a caller add the live document size, which is the only size
   * an unsaved (untitled) tab has. */
  evaluate(tabId: number, lines: number, minBytes?: number): DocumentScaleClassification
  /** Recomputes safe mode from current bytes/read-only state plus the given
   * line count, and updates the cached safe-mode set accordingly. A supplied
   * `minBytes` (live document length) is latched as the tab's known size so
   * pasting a large document into an unsaved tab raises its tier immediately. */
  classify(tabId: number, lines: number, minBytes?: number): DocumentScaleClassification
  /** The engine policy this tab's view must carry. Every view gets an explicit
   * policy, so tabs cannot inherit each other's budget/windowing and the
   * engine's process-global defaults are never consulted. Medium/large
   * documents (over `WINDOWED_LIVE_MIN_LINES`/`BYTES`, but under the safe-mode
   * thresholds) get viewport windowing only — no block render budget — so dense
   * formatted prose stays at full fidelity. */
  performancePolicy(tabId: number): EditorPerformancePolicy
  /** Drops all state for a closed tab. */
  remove(tabId: number): void
}

export function createDocumentScaleRegistry(deps: DocumentScaleRegistryDeps): DocumentScaleRegistry {
  const bytesByTab = new Map<number, number>()
  // Last line count seen by `classify`: the windowed tier is derived from the
  // document scale, and only `classify` (view creation / policy refresh) is
  // allowed to move a tab between tiers.
  const linesByTab = new Map<number, number>()
  const textByTab = new Map<number, Text>()
  // Largest live document size `classify` has seen (characters, a lower bound
  // for bytes). Kept apart from the disk byte count so a reload can still move a
  // tab down. Upward-only: reconfiguring a view down and back while a document
  // hovers around a threshold would trade a memory win for policy churn.
  const liveBytesByTab = new Map<number, number>()
  const readOnlyTabs = new Set<number>()
  const safeModeTabs = new Set<number>()

  function isReadOnly(tabId: number): boolean {
    return readOnlyTabs.has(tabId)
  }

  function isSafeMode(tabId: number): boolean {
    return safeModeTabs.has(tabId)
  }

  /** Largest size known for the tab: disk bytes, live length, or the caller's. */
  function sizeOf(tabId: number, minBytes?: number): number {
    return Math.max(
      bytesByTab.get(tabId) ?? 0,
      liveBytesByTab.get(tabId) ?? 0,
      minBytes ?? 0,
    )
  }

  function evaluate(
    tabId: number,
    lines: number,
    minBytes?: number,
  ): DocumentScaleClassification {
    const readOnly = isReadOnly(tabId)
    const safeMode = lines > deps.safeModeLines
      || sizeOf(tabId, minBytes) > deps.safeModeBytes
      || readOnly
    return { safeMode, readOnly }
  }

  function classify(
    tabId: number,
    lines: number,
    minBytes?: number,
  ): DocumentScaleClassification {
    linesByTab.set(tabId, lines)
    if (minBytes !== undefined) {
      liveBytesByTab.set(tabId, Math.max(liveBytesByTab.get(tabId) ?? 0, minBytes))
    }
    const result = evaluate(tabId, lines)
    if (result.safeMode) safeModeTabs.add(tabId)
    else safeModeTabs.delete(tabId)
    return result
  }

  return {
    setBytes(tabId, bytes) {
      if (bytes === undefined) bytesByTab.delete(tabId)
      else bytesByTab.set(tabId, bytes)
    },
    setReadOnly(tabId, readOnly) {
      if (readOnly) readOnlyTabs.add(tabId)
      else readOnlyTabs.delete(tabId)
    },
    stashText(tabId, text) {
      textByTab.set(tabId, text)
    },
    takeText(tabId) {
      const text = textByTab.get(tabId)
      textByTab.delete(tabId)
      return text
    },
    isReadOnly,
    isSafeMode,
    evaluate,
    classify,
    performancePolicy(tabId) {
      if (isSafeMode(tabId)) return SAFE_PERFORMANCE_POLICY
      const windowed = (linesByTab.get(tabId) ?? 0) > WINDOWED_LIVE_MIN_LINES
        || sizeOf(tabId) > WINDOWED_LIVE_MIN_BYTES
      return windowed ? WINDOWED_PERFORMANCE_POLICY : STANDARD_PERFORMANCE_POLICY
    },
    remove(tabId) {
      bytesByTab.delete(tabId)
      linesByTab.delete(tabId)
      liveBytesByTab.delete(tabId)
      textByTab.delete(tabId)
      readOnlyTabs.delete(tabId)
      safeModeTabs.delete(tabId)
    },
  }
}
