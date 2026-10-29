import type { Text } from "@codemirror/state"
import { createMatchCursor, literalOverlap, type MatchCursor, type SearchRequest } from "./currentDocumentSearch"

export interface SearchCount {
  readonly count: number
  readonly complete: boolean
  readonly revision: number
}

export interface SearchScheduler {
  now(): number
  schedule(run: () => void): () => void
}

export interface SearchCountJob {
  cancel(): void
  readonly cancelled: boolean
}

const DEFAULT_SLICE_MS = 4
const DEFAULT_DISPLAY_CAP = 10_000
const CANDIDATES_PER_TIME_CHECK = 64
const WINDOW_CHARS = 16 * 1024

function idleSchedule(run: () => void): () => void {
  if (typeof globalThis.requestIdleCallback === "function") {
    const handle = globalThis.requestIdleCallback(() => run())
    return () => globalThis.cancelIdleCallback(handle)
  }
  const handle = setTimeout(run, 0)
  return () => clearTimeout(handle)
}

const defaultScheduler: SearchScheduler = {
  now: () => performance.now(),
  schedule: idleSchedule,
}

export function startSearchCount(
  doc: Text,
  request: SearchRequest,
  scheduler: SearchScheduler,
  publish: (count: SearchCount) => void,
  options: { readonly sliceMs?: number; readonly cap?: number } = {},
): SearchCountJob {
  const sliceMs = options.sliceMs ?? DEFAULT_SLICE_MS
  const cap = Math.max(1, Math.trunc(options.cap ?? DEFAULT_DISPLAY_CAP))
  const active = scheduler ?? defaultScheduler
  const unwindowed = request.regexp || request.query.length === 0
  const overlap = unwindowed ? 0 : Math.max(request.query.length, literalOverlap(request) + 1)
  const windowChars = unwindowed ? doc.length : Math.max(WINDOW_CHARS, overlap + 1)
  let windowFrom = 0
  let windowTo = Math.min(windowChars, doc.length)
  let nextCursorFrom = 0
  let cursor: MatchCursor | null = null
  let count = 0
  let stopped = false
  let cancelled = false
  let pending: (() => void) | null = null

  function finish(complete: boolean): void {
    stopped = true
    pending = null
    publish({ count, complete, revision: request.revision })
  }

  function slice(): void {
    pending = null
    if (stopped) return
    const started = active.now()
    let candidates = 0
    for (;;) {
      if (cursor === null) {
        if (windowFrom >= doc.length) {
          finish(true)
          return
        }
        const from = Math.max(windowFrom, nextCursorFrom)
        const to = Math.min(windowTo + overlap, doc.length)
        if (from >= to) {
          if (windowTo >= doc.length) {
            finish(true)
            return
          }
          windowFrom = windowTo
          windowTo = Math.min(windowTo + windowChars, doc.length)
          continue
        }
        cursor = createMatchCursor(doc, request, from, to)
      }
      const match = cursor.next()
      if (match === null) {
        cursor = null
        if (windowTo >= doc.length) {
          finish(true)
          return
        }
        windowFrom = windowTo
        windowTo = Math.min(windowTo + windowChars, doc.length)
        if (active.now() - started >= sliceMs) {
          pending = active.schedule(slice)
          return
        }
        continue
      }
      if (match.from < windowFrom || match.from >= windowTo) continue
      nextCursorFrom = match.to
      count += 1
      if (count >= cap) {
        finish(false)
        return
      }
      candidates += 1
      if (candidates >= CANDIDATES_PER_TIME_CHECK) {
        candidates = 0
        if (active.now() - started >= sliceMs) {
          pending = active.schedule(slice)
          return
        }
      }
    }
  }

  pending = active.schedule(slice)

  return {
    cancel(): void {
      if (cancelled) return
      cancelled = true
      stopped = true
      const cancelPending = pending
      pending = null
      if (cancelPending) cancelPending()
    },
    get cancelled(): boolean {
      return cancelled
    },
  }
}
