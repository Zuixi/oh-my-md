import type { DesktopServices } from "./desktopServices"
import type { RecoveryWriter } from "./recoveryWriter"
import { recoveryKey, sessionDirty, sessionPath } from "./session"
import { extractSessionState } from "./sessionRestore"
import type { Workspace } from "./workspace"

export interface SessionFlushHost {
  readonly services: DesktopServices
  getWorkspace(): Workspace
  getContents(tabId: number): string | undefined
  getSessionSaveTimer(): number | null
  clearSessionSaveTimer(): void
  getSessionSaveInFlight(): Promise<void> | null
  getRecoveryWriter(): RecoveryWriter
  flushMaterializer(): void
  flushLogs(): Promise<void>
}

/**
 * Persist dirty buffers to crash recovery before the session shard/ack. This is
 * the safe half of hot exit: content survives a quit even when the active tab
 * never reached the autosave window, and every background tab is included.
 */
async function flushDirtyRecoveries(host: SessionFlushHost): Promise<void> {
  const writer = host.getRecoveryWriter()
  const writes: Promise<boolean>[] = []
  for (const tab of host.getWorkspace().tabs) {
    const contents = host.getContents(tab.id)
    if (contents === undefined || !sessionDirty(tab, contents)) continue
    writes.push(writer.persistNow(
      { tabId: tab.id, key: recoveryKey(tab), path: sessionPath(tab), contents },
      { write: host.services.writeRecovery, reportError: host.services.reportError },
    ))
  }
  await Promise.allSettled(writes)
}

/** Installs the Rust-driven session-flush listener; returns its unlisten. */
export function installSessionFlush(host: SessionFlushHost): () => void {
  const { services } = host
  if (!services.listenSessionFlush || !services.sessionFlushAck) return () => {}
  return services.listenSessionFlush(async () => {
    if (host.getSessionSaveTimer() !== null) host.clearSessionSaveTimer()
    // A debounced save may still be in Rust. Waiting here keeps it from landing
    // after the final shard write / close-time shard deletion.
    const inFlight = host.getSessionSaveInFlight()
    if (inFlight) {
      try { await inFlight } catch { /* absorbed by the debounce path */ }
    }
    try {
      host.flushMaterializer()
      await flushDirtyRecoveries(host)
      await services.saveSessionState?.(extractSessionState(host.getWorkspace()))
    } catch {
      // A failed write must still ack: otherwise Rust waits out its timeout.
    } finally {
      await host.flushLogs()
      await services.sessionFlushAck?.()
    }
  })
}
