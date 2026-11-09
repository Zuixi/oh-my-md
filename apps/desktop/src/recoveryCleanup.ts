/**
 * Best-effort deletion of one recovery record.
 *
 * Every caller is a cleanup path outside the user's immediate focus (tab
 * close, save-as follow-up, conflict resolution, startup discard): a failed
 * delete must neither surface as an unhandled rejection nor abort the
 * workflow around it. The record simply stays on disk and is offered again
 * next launch, which is strictly safer than deleting unverified state.
 */
import type { DesktopServices } from "./desktopServices"
import { describeThrown } from "./globalErrorHandlers"
import { getGlobalLogger } from "./logger"
import { keyField } from "./logPath"
import { sessionDirty, type EditorSession } from "./session"

export async function clearRecoveryRecord(
  services: Pick<DesktopServices, "clearRecovery">,
  key: string,
): Promise<void> {
  try {
    await services.clearRecovery?.(key)
  } catch (error) {
    getGlobalLogger().warn(
      "recovery",
      `could not delete record ${keyField(key)}: ${describeThrown(error)}`,
    )
  }
}

/**
 * Save-as moves a tab's recovery identity. The draft timer armed under the old
 * key has to stop before that record is deleted, or it would recreate it; but
 * an edit that landed during the save is still unsaved and must keep a draft
 * under the tab's new key. Cancellation therefore re-arms, it does not discard.
 */
export function createPendingRecoveryCanceller(source: {
  readonly forget: (tabId: number) => Promise<void>
  /** The tab as it is now plus its latest document text, if both still exist. */
  readonly load: (tabId: number) => readonly [EditorSession | undefined, string | undefined]
  readonly save: (tab: EditorSession, contents: string) => void
}): (tabId: number) => Promise<void> {
  return async tabId => {
    await source.forget(tabId)
    const [tab, contents] = source.load(tabId)
    if (tab && contents !== undefined && sessionDirty(tab, contents)) {
      source.save(tab, contents)
    }
  }
}

/**
 * Deletes a closed tab's record only after `forget` settles: a draft write that
 * lands after the delete would resurrect the tab the user just discarded.
 */
export function clearRecoveryAfterForget(
  pending: Promise<void>,
  services: Pick<DesktopServices, "clearRecovery">,
  key: string,
): void {
  void pending.then(
    () => clearRecoveryRecord(services, key),
    // `forget` did not settle its write: keep the record instead of deleting
    // state we could not confirm is free of a late write.
    () => undefined,
  )
}
