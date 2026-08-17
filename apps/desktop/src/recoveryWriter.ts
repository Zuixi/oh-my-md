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

export interface RecoveryWriter {
  /** Writes one draft; the returned promise settles once the outcome has been surfaced. */
  readonly save: (draft: RecoveryDraft, host: RecoveryHost) => Promise<void>
  /** Drops a closed tab, so a recycled id cannot inherit its reporting state. */
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
  return {
    save: async (draft, host) => {
      try {
        await host.write?.(draft.key, draft.contents)
        reported.delete(draft.tabId)
      } catch (error) {
        surfaceFailure(reported, draft, host, error)
      }
    },
    forget: tabId => { reported.delete(tabId) },
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
