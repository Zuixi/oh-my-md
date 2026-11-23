import { useCallback, useMemo, useRef, useSyncExternalStore } from "react"
import type { DocumentStore } from "./documentStore"
import { FindReplaceBar } from "./FindReplaceBar"
import { collectMatches, validateFindPattern } from "./findReplace"
import type { FindReplaceHandle } from "./useFindReplace"

/** No subscription while the bar is closed. */
const NOOP_UNSUBSCRIBE = (): void => {}

/**
 * The active tab's materialized text, subscribed only while `enabled`.
 *
 * A closed Find bar has nothing to count, so it must not wake on materialized
 * edits: the subscribe/snapshot identities change with `enabled`, which makes
 * `useSyncExternalStore` re-subscribe on open (and read the current text then).
 */
function useActiveTabDocWhen(store: DocumentStore, enabled: boolean): string {
  const subscribe = useCallback(
    (listener: () => void) => (enabled ? store.subscribe(listener) : NOOP_UNSUBSCRIBE),
    [store, enabled],
  )
  const getSnapshot = useCallback(
    () => (enabled ? store.getTabDoc(store.getWorkspace().activeId) : ""),
    [store, enabled],
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/**
 * Find bar wiring. The full-document match count needs the materialized text, so
 * it is computed here — the shell must not subscribe to the document for it.
 */
export function FindBarHost(props: {
  readonly store: DocumentStore
  readonly find: FindReplaceHandle
  /** Over-scale gate: a safe-mode tab never runs the whole-document scan. */
  readonly isSafeMode: () => boolean
}) {
  const { find } = props
  const doc = useActiveTabDocWhen(props.store, find.open)
  // Stable indirection so an inline getter from the shell cannot defeat the
  // full-document memoization below.
  const isSafeModeRef = useRef(props.isSafeMode)
  isSafeModeRef.current = props.isSafeMode

  const patternError = useMemo(
    () => find.open && find.regexMode && find.query !== ""
      ? validateFindPattern({
          query: find.query,
          caseSensitive: find.caseSensitive,
          regex: true,
          wholeWord: false,
        })
      : null,
    [find.open, find.regexMode, find.query, find.caseSensitive],
  )

  const matchCount = useMemo<number | null>(() => {
    if (!find.open) return 0
    if (isSafeModeRef.current()) return null
    return collectMatches(doc, {
      query: find.query,
      caseSensitive: find.caseSensitive,
      regex: find.regexMode,
      wholeWord: find.wholeWord,
    }).length
  }, [doc, find.open, find.query, find.caseSensitive, find.regexMode, find.wholeWord])

  return (
    <FindReplaceBar
      open={find.open}
      query={find.query}
      replacement={find.replacement}
      caseSensitive={find.caseSensitive}
      regex={find.regexMode}
      wholeWord={find.wholeWord}
      patternError={patternError}
      replaceOpen={find.replaceOpen}
      matchCount={matchCount}
      activeIndex={find.index}
      onQuery={find.onQuery}
      onReplacement={find.onReplacement}
      onCaseSensitive={find.onCaseSensitive}
      onRegex={find.onRegex}
      onWholeWord={find.onWholeWord}
      onNext={() => find.go("next")}
      onPrev={() => find.go("prev")}
      onReplace={find.replaceCurrent}
      onReplaceAll={find.replaceEvery}
      onClose={find.close}
    />
  )
}
