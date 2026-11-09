import { errorMessage } from "./desktopServices"
import { t } from "./i18n"
import { getGlobalLogger } from "./logger"
import { keyField, pathField } from "./logPath"

export interface RecoveryDraft {
  readonly tabId: number
  readonly key: string
  readonly path: string | null
  readonly contents: string
}

export interface RecoveryHost {
  readonly write?: (key: string, path: string | null, contents: string) => Promise<void>
  readonly reportError: (message: string) => void
}

// Spec 05a：崩溃恢复允许 ≤1s 丢失窗口（物化 250ms + 本防抖）；每键整文档 IPC/写盘必须消失。
export const RECOVERY_DEBOUNCE_MS = 800

interface PendingWrite {
  readonly draft: RecoveryDraft
  readonly host: RecoveryHost
  timer: number
}

export interface RecoveryWriter {
  /** Schedules one trailing write per tab; settled when the outcome has been surfaced. */
  readonly save: (draft: RecoveryDraft, host: RecoveryHost) => Promise<void>
  /**
   * Drops a closed tab: cancels its pending write, invalidates its in-flight
   * one, and clears reporting state (recycled ids stay clean). Resolves once
   * the tab's in-flight write has settled, so a caller deleting the record
   * afterwards cannot race a late write that recreates it.
   */
  readonly forget: (tabId: number) => Promise<void>
}

/**
 * A recovery directory that has gone bad (full disk, revoked permissions, stale `OMD_RECOVERY_DIR`)
 * fails on every document change, and `reportError` is a modal alert in production. So an outage is
 * reported **once per tab**: the first failure reaches the user and the log with its full detail,
 * later attempts only increment a counter, and the first success after an outage logs how many
 * writes it covered. A broken recovery directory therefore leaves one record, not one per keystroke,
 * and the count still says how long the drafts were unprotected.
 *
 * Nothing is swallowed silently: while an outage persists the recovery file is genuinely not being
 * written, and the single record says so.
 */
export function createRecoveryWriter(): RecoveryWriter {
  /** Tabs whose current outage has already been announced. */
  const reported = new Set<number>()
  /** Writes that failed since the announced one, per tab. */
  const suppressed = new Map<number, number>()
  const lastWritten = new Map<number, string>()
  const pending = new Map<number, PendingWrite>()
  /** Per-tab epoch; `forget` bumps it so a write that settles afterwards is inert. */
  const epochs = new Map<number, number>()
  /** Writes already past the timer, so `forget` can wait for their IPC to land. */
  const inFlight = new Map<number, Set<Promise<void>>>()

  const writeNow = (entry: PendingWrite): Promise<void> => {
    const { tabId } = entry.draft
    pending.delete(tabId)
    const epoch = epochs.get(tabId) ?? 0
    const task = (async () => {
      try {
        await entry.host.write?.(entry.draft.key, entry.draft.path, entry.draft.contents)
        // The tab was closed meanwhile: its record is being deleted, so this
        // completion must neither revive `lastWritten` nor report success.
        if ((epochs.get(tabId) ?? 0) !== epoch) return
        lastWritten.set(tabId, entry.draft.contents)
        announceRecovery(entry.draft, reported, suppressed)
      } catch (error) {
        if ((epochs.get(tabId) ?? 0) !== epoch) return
        surfaceFailure(reported, suppressed, entry.draft, entry.host, error)
      }
    })()
    const writes = inFlight.get(tabId) ?? new Set<Promise<void>>()
    writes.add(task)
    inFlight.set(tabId, writes)
    const settle = () => {
      writes.delete(task)
      if (writes.size === 0) inFlight.delete(tabId)
    }
    void task.then(settle, settle)
    return task
  }

  return {
    save: (draft, host) => {
      // 同内容去重：物化节奏重发的未变草稿不再触发 IPC/写盘。
      if (lastWritten.get(draft.tabId) === draft.contents) return Promise.resolve()
      const existing = pending.get(draft.tabId)
      if (existing) window.clearTimeout(existing.timer)
      const entry: PendingWrite = { draft, host, timer: 0 }
      // Reporting must never break recovery: a logger failure here is not the
      // writer's outcome and has nowhere useful to go.
      entry.timer = window.setTimeout(
        () => { void writeNow(entry).catch(() => undefined) },
        RECOVERY_DEBOUNCE_MS,
      )
      pending.set(draft.tabId, entry)
      return Promise.resolve()
    },
    forget: async tabId => {
      const entry = pending.get(tabId)
      if (entry) window.clearTimeout(entry.timer)
      pending.delete(tabId)
      // Invalidate any write that already started; its completion becomes inert.
      epochs.set(tabId, (epochs.get(tabId) ?? 0) + 1)
      lastWritten.delete(tabId)
      reported.delete(tabId)
      suppressed.delete(tabId)
      const writes = inFlight.get(tabId)
      if (writes) await Promise.allSettled([...writes])
    },
  }
}

/** `path=` carries the location for a named tab. The key is emitted only for a
 *  tab with no path: there the generated key is the tab's only identity, while
 *  for a named tab it would add nothing the path does not already say (and is
 *  not a path for the export redactor to collapse). */
function recoveryIdentity(draft: RecoveryDraft): string {
  return draft.path === null
    ? `${pathField("")} ${keyField(draft.key)}`
    : pathField(draft.path)
}

function surfaceFailure(
  reported: Set<number>,
  suppressed: Map<number, number>,
  draft: RecoveryDraft,
  host: RecoveryHost,
  error: unknown,
): void {
  if (reported.has(draft.tabId)) {
    // One record per outage, not one per document change.
    suppressed.set(draft.tabId, (suppressed.get(draft.tabId) ?? 0) + 1)
    return
  }
  reported.add(draft.tabId)
  suppressed.set(draft.tabId, 0)
  const message = errorMessage(t("error.recoveryWriteFailed"), error)
  getGlobalLogger().error("recovery", `${message} ${recoveryIdentity(draft)}`)
  host.reportError(message)
}

/** The first success after an outage closes it and says how long it lasted. */
function announceRecovery(
  draft: RecoveryDraft,
  reported: Set<number>,
  suppressed: Map<number, number>,
): void {
  if (!reported.delete(draft.tabId)) return
  const failed = suppressed.get(draft.tabId) ?? 0
  suppressed.delete(draft.tabId)
  getGlobalLogger().info(
    "recovery",
    `recovered after ${failed + 1} failed write(s) ${recoveryIdentity(draft)}`,
  )
}
