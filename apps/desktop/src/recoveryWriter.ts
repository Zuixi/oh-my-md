import { errorMessage } from "./desktopServices"
import { t } from "./i18n"

export interface RecoveryDraft {
  readonly tabId: number
  readonly key: string
  readonly path: string | null
  readonly contents: string
}

export interface RecoveryHost {
  readonly write?: (key: string, contents: string) => Promise<void>
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
  /** Forces every pending write for hosts sharing this `write` function to run now. */
  readonly flush: (host: RecoveryHost) => Promise<void>
  /** Drops a closed tab: cancels its pending write and reporting state (recycled ids stay clean). */
  readonly forget: (tabId: number) => void
}

/**
 * A recovery directory that has gone bad (full disk, revoked permissions, stale `OMD_RECOVERY_DIR`)
 * fails on every document change, and `reportError` is a modal alert in production. So only the
 * first failure per tab reaches the user; later ones keep their detail in the log and leave editing
 * alone. A successful write re-arms the report, so a problem that comes back is announced again.
 *
 * The quiet path logs through `console.error` on purpose: the app has no logger yet, and swallowing
 * the rejection would hide a broken recovery directory entirely.
 */
export function createRecoveryWriter(): RecoveryWriter {
  const reported = new Set<number>()
  const lastWritten = new Map<number, string>()
  const pending = new Map<number, PendingWrite>()

  const writeNow = async (entry: PendingWrite) => {
    pending.delete(entry.draft.tabId)
    try {
      await entry.host.write?.(entry.draft.key, entry.draft.contents)
      lastWritten.set(entry.draft.tabId, entry.draft.contents)
      reported.delete(entry.draft.tabId)
    } catch (error) {
      surfaceFailure(reported, entry.draft, entry.host, error)
    }
  }

  return {
    save: (draft, host) => {
      // 同内容去重：物化节奏重发的未变草稿不再触发 IPC/写盘。
      if (lastWritten.get(draft.tabId) === draft.contents) return Promise.resolve()
      const existing = pending.get(draft.tabId)
      if (existing) window.clearTimeout(existing.timer)
      const entry: PendingWrite = { draft, host, timer: 0 }
      entry.timer = window.setTimeout(() => { void writeNow(entry) }, RECOVERY_DEBOUNCE_MS)
      pending.set(draft.tabId, entry)
      return Promise.resolve()
    },
    flush: async host => {
      for (const entry of [...pending.values()]) {
        if (entry.host.write !== host.write) continue
        window.clearTimeout(entry.timer)
        await writeNow(entry)
      }
    },
    forget: tabId => {
      const entry = pending.get(tabId)
      if (entry) window.clearTimeout(entry.timer)
      pending.delete(tabId)
      lastWritten.delete(tabId)
      reported.delete(tabId)
    },
  }
}

function surfaceFailure(
  reported: Set<number>,
  draft: RecoveryDraft,
  host: RecoveryHost,
  error: unknown,
): void {
  const message = errorMessage(t("error.recoveryWriteFailed"), error)
  if (reported.has(draft.tabId)) {
    console.error(message, { key: draft.key, path: draft.path }, error)
    return
  }
  reported.add(draft.tabId)
  host.reportError(message)
}
