import type { DesktopServices } from "./desktopServices"
import type { RecoveryWriter } from "./recoveryWriter"
import { recoveryKey, sessionDirty, sessionPath } from "./session"
import { extractSessionState } from "./sessionRestore"
import type { Workspace } from "./workspace"
import { getGlobalLogger } from "./logger"

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
 * Recovery-record key per dirty tab. Shared by the quit-time flush and the
 * debounced shard write so both describe the same dirty set.
 */
export function dirtyRecoveryKeysFor(
  workspace: Workspace,
  getContents: (tabId: number) => string | undefined,
): ReadonlyMap<number, string> {
  const keys = new Map<number, string>()
  for (const tab of workspace.tabs) {
    const contents = getContents(tab.id)
    if (contents === undefined || !sessionDirty(tab, contents)) continue
    keys.set(tab.id, recoveryKey(tab))
  }
  return keys
}

/**
 * Persist dirty buffers to crash recovery before the session shard/ack and
 * return each dirty tab's record key, so the shard written right after can
 * point at the exact buffer that belongs to that tab (Hot Exit).
 */
async function flushDirtyRecoveries(
  host: SessionFlushHost,
): Promise<ReadonlyMap<number, string>> {
  const writer = host.getRecoveryWriter()
  const workspace = host.getWorkspace()
  const keys = dirtyRecoveryKeysFor(workspace, tabId => host.getContents(tabId))
  const writes: Promise<boolean>[] = []
  for (const tab of workspace.tabs) {
    const key = keys.get(tab.id)
    if (key === undefined) continue
    writes.push(writer.persistNow(
      { tabId: tab.id, key, path: sessionPath(tab), contents: host.getContents(tab.id) ?? "" },
      { write: host.services.writeRecovery, reportError: host.services.reportError },
    ))
  }
  await Promise.allSettled(writes)
  return keys
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
      const dirtyRecoveryKeys = await flushDirtyRecoveries(host)
      await services.saveSessionState?.(
        extractSessionState(host.getWorkspace(), dirtyRecoveryKeys),
      )
    } catch (error) {
      // A failed write must still ack (Rust waits on it), but the layout loss
      // must not be invisible: dirty content already has recovery records.
      getGlobalLogger().warn("session", `session flush failed: ${error instanceof Error ? error.message : "unknown"}`)
    } finally {
      await host.flushLogs()
      await services.sessionFlushAck?.()
    }
  })
}
