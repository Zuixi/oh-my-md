/**
 * Spec 05a 拉取式物化的独立协调器：doc 更新只置位（`queue`），真正的文本从
 * view 拉取延到一个 trailing timer 触发（或 `delayMs === 0` 时同步触发）。
 * 只持有一个 pending tab 集合 + 一个 trailing timer id，供 App.tsx 复用而不
 * 各处散落 Set/setTimeout 操作。
 */
export interface DocumentMaterializer {
  /** Marks a tab dirty; schedules (or immediately runs, when `delayMs === 0`) a flush. */
  queue(tabId: number): void
  /** Flushes every pending tab and clears the trailing timer. */
  flush(): void
  /** Flushes one pending tab without touching the timer or other pending tabs. */
  flushTab(tabId: number): void
  /** Drops a tab's pending flag without materializing it. */
  discard(tabId: number): void
  /** Whether a tab currently has unmaterialized edits. */
  hasPending(tabId: number): boolean
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
}

export function createDocumentMaterializer(deps: DocumentMaterializerDeps): DocumentMaterializer {
  const pending = new Set<number>()
  let timerId: number | null = null

  function cancelTimer(): void {
    if (timerId === null) return
    deps.clearTimer(timerId)
    timerId = null
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
    pending.add(tabId)
    if (deps.delayMs === 0) {
      flush()
      return
    }
    if (timerId === null) {
      timerId = deps.setTimer(flush, deps.delayMs)
    }
  }

  function discard(tabId: number): void {
    pending.delete(tabId)
  }

  function hasPending(tabId: number): boolean {
    return pending.has(tabId)
  }

  function destroy(): void {
    cancelTimer()
    pending.clear()
  }

  return { queue, flush, flushTab, discard, hasPending, destroy }
}
