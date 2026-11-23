import { useEffect, useMemo, useState } from "react"
import { documentStats } from "@omd/engine"
import { useActiveTabDoc, useStatsEpoch, type DocumentStore } from "./documentStore"

/** `documentStats` scans the whole document; keep it off the per-keystroke path. */
export const STATS_DEBOUNCE_MS = 250

export interface DocumentStatsSnapshot {
  readonly words: number
  readonly chars: number
}

export interface DocumentStatsController {
  /** null = suppressed (safe-mode tab) until `requestStats` is invoked. */
  readonly stats: DocumentStatsSnapshot | null
  readonly requestStats: () => void
}

/**
 * Word/character counts for the active tab.
 *
 * The subscription lives here, not in `App`: a materialized keystroke re-renders
 * only the component that shows the numbers. Line counts never come from here —
 * those read the CodeMirror rope directly (a full-text split is forbidden).
 */
export function useDocumentStats(input: {
  readonly store: DocumentStore
  /**
   * Over-scale (safe-mode) tabs only count on demand, so an idle status bar
   * cannot drag a 50MB document back into a full scan.
   */
  readonly isSafeMode: () => boolean
}): DocumentStatsController {
  const doc = useActiveTabDoc(input.store)
  const statsEpoch = useStatsEpoch(input.store)
  const [deferredDoc, setDeferredDoc] = useState(doc)
  const [statsRequested, setStatsRequested] = useState(0)

  // A scale-tier flip or a whole-document reload retires an on-demand count:
  // the number the user asked for belonged to a different document.
  useEffect(() => { setStatsRequested(0) }, [statsEpoch])

  useEffect(() => {
    const timer = window.setTimeout(() => setDeferredDoc(doc), STATS_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [doc])

  const safeMode = input.isSafeMode()
  const stats = useMemo(
    () => (safeMode && statsRequested === 0 ? null : documentStats(deferredDoc)),
    [deferredDoc, safeMode, statsRequested],
  )

  return { stats, requestStats: () => setStatsRequested(count => count + 1) }
}
