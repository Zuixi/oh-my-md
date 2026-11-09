import type { Text } from "@codemirror/state"
import {
  SAFE_PERFORMANCE_POLICY,
  STANDARD_PERFORMANCE_POLICY,
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
   * `classify`, which would otherwise fire cache writes on every render. */
  evaluate(tabId: number, lines: number): DocumentScaleClassification
  /** Recomputes safe mode from current bytes/read-only state plus the given
   * line count, and updates the cached safe-mode set accordingly. */
  classify(tabId: number, lines: number): DocumentScaleClassification
  /** The engine policy this tab's view must carry. Every view gets an explicit
   * policy, so tabs cannot inherit each other's budget/windowing and the
   * engine's process-global defaults are never consulted. */
  performancePolicy(tabId: number): EditorPerformancePolicy
  /** Drops all state for a closed tab. */
  remove(tabId: number): void
}

export function createDocumentScaleRegistry(deps: DocumentScaleRegistryDeps): DocumentScaleRegistry {
  const bytesByTab = new Map<number, number>()
  const textByTab = new Map<number, Text>()
  const readOnlyTabs = new Set<number>()
  const safeModeTabs = new Set<number>()

  function isReadOnly(tabId: number): boolean {
    return readOnlyTabs.has(tabId)
  }

  function isSafeMode(tabId: number): boolean {
    return safeModeTabs.has(tabId)
  }

  function evaluate(tabId: number, lines: number): DocumentScaleClassification {
    const bytes = bytesByTab.get(tabId)
    const readOnly = isReadOnly(tabId)
    const safeMode = lines > deps.safeModeLines
      || (bytes !== undefined && bytes > deps.safeModeBytes)
      || readOnly
    return { safeMode, readOnly }
  }

  function classify(tabId: number, lines: number): DocumentScaleClassification {
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
      return isSafeMode(tabId) ? SAFE_PERFORMANCE_POLICY : STANDARD_PERFORMANCE_POLICY
    },
    remove(tabId) {
      bytesByTab.delete(tabId)
      textByTab.delete(tabId)
      readOnlyTabs.delete(tabId)
      safeModeTabs.delete(tabId)
    },
  }
}
