/**
 * Spec 05a 拉取式物化的独立协调器：doc 更新只置位（`queue`），真正的文本从
 * view 拉取延到一个 trailing timer 触发（或 `delayMs === 0` 时同步触发）。
 * 只持有一个 pending tab 集合 + 一个 trailing timer id，供 App.tsx 复用而不
 * 各处散落 Set/setTimeout 操作。
 */
export interface DocumentMaterializer {
  /** Marks a tab dirty; schedules (or immediately runs, when `delayMs === 0`) a flush.
   * A no-op after `destroy()`, so a late update cannot re-arm the trailing timer. */
  queue(tabId: number): void
  /** Flushes every pending tab and clears the trailing timer. */
  flush(): void
  /** Flushes one pending tab without touching the timer or other pending tabs.
   * This is the tab-switch path: it persists crash recovery and arms autosave for
   * the outgoing tab instead of dropping its edits. */
  flushTab(tabId: number): void
  /** Drops a tab's pending flag without materializing it. */
  discard(tabId: number): void
  /** Whether a tab currently has unmaterialized edits. */
  hasPending(tabId: number): boolean
  /** Re-arms a destroyed instance (StrictMode effect re-run); clears stale state. */
  reset(): void
  /** Clears the trailing timer and all pending tabs (App unmount). */
  destroy(): void
}

export interface DocumentMaterializerDeps {
  delayMs: number
  /** Reads the latest text straight from the live view; `null` when the view is gone. */
  readViewText(tabId: number): string | null
  /** Applies materialized text to app state (sync doc, write recovery, ...). */
  materialize(tabId: number, contents: string): void
  setTimer(callback: () => void, ms: number): number
  clearTimer(id: number): void
  /** Monotonic milliseconds for the debounce math; injectable for tests. */
  now?: () => number
  /**
   * Upper bound on how long continuous typing may defer one materialization.
   * Defaults to `delayMs * 8`, and never below `DEFAULT_MAX_WAIT_MS`, so a
   * nonstop typist still gets a crash-recovery draft within a couple of seconds
   * while an idle typist materializes `delayMs` after the last keystroke.
   */
  maxWaitMs?: number
}

/** Floor for `maxWaitMs`: recovery is only useful if it lands during typing. */
const DEFAULT_MAX_WAIT_MS = 2_000

/**
 * Trailing debounce with a single timer for all tabs.
 *
 * The previous leading-edge throttle materialized (and therefore flattened the
 * rope of) every keystroke burst at a fixed 4 Hz. Now a burst arms exactly one
 * timer; when it fires and newer edits arrived in the meantime the timer is
 * re-armed for the remaining debounce (bounded by `maxWaitMs`) instead of
 * pulling the document mid-typing. Each `queue()` still only touches the timer
 * when there is none, so a fast typist pays one `setTimeout` per burst.
 */
export function createDocumentMaterializer(deps: DocumentMaterializerDeps): DocumentMaterializer {
  const now = deps.now ?? (() => performance.now())
  const maxWaitMs = deps.maxWaitMs ?? Math.max(deps.delayMs * 8, DEFAULT_MAX_WAIT_MS)
  const pending = new Set<number>()
  let timerId: number | null = null
  let destroyed = false
  // Clock readings that drive the debounce: when the current burst first/last
  // queued an edit, and when the armed timer would fire.
  let firstQueuedAt = 0
  let lastQueuedAt = 0
  let scheduledAt = 0
  let scheduledWaitMs = 0

  function cancelTimer(): void {
    if (timerId === null) return
    deps.clearTimer(timerId)
    timerId = null
  }

  function armTimer(at: number, ms: number): void {
    scheduledAt = at
    scheduledWaitMs = ms
    timerId = deps.setTimer(onTimer, ms)
  }

  function materializeTab(tabId: number): void {
    pending.delete(tabId)
    const contents = deps.readViewText(tabId)
    if (contents === null) return
    deps.materialize(tabId, contents)
  }

  function flush(): void {
    cancelTimer()
    for (const tabId of [...pending]) {
      materializeTab(tabId)
    }
  }

  function flushTab(tabId: number): void {
    if (!pending.has(tabId)) return
    materializeTab(tabId)
  }

  function queue(tabId: number): void {
    if (destroyed) return
    const at = now()
    pending.add(tabId)
    if (deps.delayMs === 0) {
      flush()
      return
    }
    lastQueuedAt = at
    if (timerId !== null) return
    firstQueuedAt = at
    armTimer(at, deps.delayMs)
  }

  function onTimer(): void {
    timerId = null
    if (destroyed || pending.size === 0) return
    const at = now()
    // Guard against a clock that moved backwards (fake timers installed
    // mid-burst) and against a unit test firing the callback synchronously:
    // only defer when the timer really waited, newer edits arrived after it was
    // armed, the typist is still inside the debounce window, and the burst has
    // not exhausted its max wait.
    const waited = at - scheduledAt >= scheduledWaitMs * 0.5
    const newerEdits = lastQueuedAt > scheduledAt
    const stillTyping = at - lastQueuedAt < deps.delayMs
    const withinMaxWait = at - firstQueuedAt < maxWaitMs
    if (waited && newerEdits && stillTyping && withinMaxWait) {
      const remainingDebounce = deps.delayMs - (at - lastQueuedAt)
      const remainingMaxWait = maxWaitMs - (at - firstQueuedAt)
      armTimer(at, Math.max(1, Math.min(remainingDebounce, remainingMaxWait)))
      return
    }
    flush()
  }

  function discard(tabId: number): void {
    pending.delete(tabId)
  }

  function hasPending(tabId: number): boolean {
    return pending.has(tabId)
  }

  function reset(): void {
    destroyed = false
    cancelTimer()
    pending.clear()
    firstQueuedAt = 0
    lastQueuedAt = 0
    scheduledAt = 0
    scheduledWaitMs = 0
  }

  function destroy(): void {
    destroyed = true
    cancelTimer()
    pending.clear()
  }

  return { queue, flush, flushTab, discard, hasPending, reset, destroy }
}
