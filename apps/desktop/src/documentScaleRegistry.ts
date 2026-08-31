import type { Text } from "@codemirror/state"

/**
 * Spec 05/05b 文档档位策略的单一持有者：字节数、只读标记、暂存 Text、以及
 * 由此推导的安全模式集合，原先散落在 App.tsx 的四个 ref（safeModeTabsRef /
 * docBytesRef / docTextsRef / readonlyTabsRef）现在都在这里。App.tsx 只负责
 * 在正确的时机调用 `classify` / `applyRenderPolicy`，不再直接持有任何 Map/Set。
 */
export interface DocumentScaleClassification {
  safeMode: boolean
  readOnly: boolean
}

export interface DocumentScaleRegistryDeps {
  safeModeLines: number
  safeModeBytes: number
  renderBudgetLines: number
  setRenderBudget(lines: number): void
  setSafeModeRendering(enabled: boolean): void
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
  /** Applies the process-global engine render budget/windowing flags for the
   * given tab's last-classified safe-mode state. Callers must only invoke
   * this for the active tab. */
  applyRenderPolicy(tabId: number): void
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
    applyRenderPolicy(tabId) {
      const safeMode = isSafeMode(tabId)
      deps.setRenderBudget(safeMode ? deps.renderBudgetLines : Infinity)
      deps.setSafeModeRendering(safeMode)
    },
    remove(tabId) {
      bytesByTab.delete(tabId)
      textByTab.delete(tabId)
      readOnlyTabs.delete(tabId)
      safeModeTabs.delete(tabId)
    },
  }
}
