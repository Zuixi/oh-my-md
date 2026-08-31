import { useEffect, useRef, useState } from "react"
import type { SearchHit } from "./SearchPanel"
import type { SearchResponse } from "./desktopServices"

export interface WorkspaceSearchState {
  open: boolean
  query: string
  hits: SearchHit[]
  truncated: boolean
  caseSensitive: boolean
  setOpen(open: boolean): void
  setQuery(query: string): void
  setCaseSensitive(caseSensitive: boolean): void
  /** Resets query/results and invalidates the in-flight request. Reserved
   * (plan-mandated API): the panel currently clears by closing or emptying the
   * query, which the effect already invalidates. */
  clear(): void
}

/**
 * Debounced workspace search state. A monotonically increasing request
 * generation is bumped on every effect cleanup — i.e. on every transition
 * that makes the in-flight request irrelevant (close, empty query,
 * folder/case/query change, `clear()`, or unmount) — so a stale promise can
 * never repopulate `hits`/`truncated` or report an error after the fact.
 */
export function useWorkspaceSearch(options: {
  folder: string | null
  search?: (root: string, query: string, caseSensitive: boolean) => Promise<SearchResponse>
  reportError(error: unknown): void
  debounceMs: number
}): WorkspaceSearchState {
  const { folder, search, debounceMs } = options
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [hits, setHits] = useState<SearchHit[]>([])
  const [truncated, setTruncated] = useState(false)
  const [caseSensitive, setCaseSensitive] = useState(false)

  const requestRef = useRef(0)
  const reportErrorRef = useRef(options.reportError)
  reportErrorRef.current = options.reportError

  useEffect(() => {
    if (!open || !folder || query === "" || !search) {
      setHits(prev => prev.length === 0 ? prev : [])
      setTruncated(false)
      return () => { requestRef.current += 1 }
    }
    const request = ++requestRef.current
    const timer = window.setTimeout(() => {
      void search(folder, query, caseSensitive).then(response => {
        if (requestRef.current !== request) return
        setHits(response.hits)
        setTruncated(response.truncated)
      }).catch(error => {
        if (requestRef.current === request) reportErrorRef.current(error)
      })
    }, debounceMs)
    return () => {
      window.clearTimeout(timer)
      requestRef.current += 1
    }
  }, [open, folder, query, caseSensitive, search, debounceMs])

  function clear() {
    requestRef.current += 1
    setQuery("")
    setHits([])
    setTruncated(false)
  }

  return {
    open, query, hits, truncated, caseSensitive,
    setOpen, setQuery, setCaseSensitive, clear,
  }
}
