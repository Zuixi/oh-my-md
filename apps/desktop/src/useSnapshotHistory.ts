/**
 * Version-history modal controller: listing snapshots, restoring one as a copy,
 * restoring one into the file's own tab, and clearing the history.
 *
 * Every failure is surfaced (transient status + a diagnostics record). The old
 * wiring ended several of these paths in `.catch(() => undefined)`, which made a
 * broken snapshot directory indistinguishable from an empty one.
 */
import { useCallback, useState } from "react"
import { errorMessage, type DesktopServices, type SnapshotEntry } from "./desktopServices"
import type { DocumentStore } from "./documentStore"
import { getGlobalLogger } from "./logger"
import { pathField } from "./logPath"
import { sessionPath } from "./session"
import type { Workspace } from "./workspace"

export interface SnapshotHistoryState {
  readonly open: boolean
  readonly path: string | null
  readonly entries: readonly SnapshotEntry[]
  readonly loading: boolean
}

const CLOSED_HISTORY: SnapshotHistoryState = {
  open: false,
  path: null,
  entries: [],
  loading: false,
}

export interface SnapshotHistoryDeps {
  readonly services: DesktopServices
  readonly store: DocumentStore
  readonly t: (key: string) => string
  /** Opens the snapshot in a new untitled tab (never touches the file). */
  readonly newTab: (contents: string) => void
  /** Replaces one tab's buffer while its disk baseline stays untouched. */
  readonly restoreTabContents: (tabId: number, contents: string) => boolean
  readonly activateTab: (tabId: number) => void
  readonly showTransientStatus: (message: string) => void
  readonly isMounted: () => boolean
}

export interface SnapshotHistory {
  readonly state: SnapshotHistoryState
  readonly open: () => Promise<void>
  readonly restoreCopy: (entry: SnapshotEntry) => void
  readonly restoreInPlace: (entry: SnapshotEntry) => void
  readonly clear: () => void
  readonly close: () => void
}

export function useSnapshotHistory(deps: SnapshotHistoryDeps): SnapshotHistory {
  const [state, setState] = useState<SnapshotHistoryState>(CLOSED_HISTORY)
  const { services, store, t } = deps

  const fail = useCallback((message: string, detail: string, error: unknown): void => {
    getGlobalLogger().warn("snapshots", `${detail}: ${errorMessage(t(message), error)}`)
    services.reportError(errorMessage(t(message), error))
  }, [services, t])

  const open = useCallback(async (): Promise<void> => {
    const path = activeFilePath(store.getWorkspace())
    if (!path) {
      deps.showTransientStatus(t("history.noFile"))
      return
    }
    const listSnapshots = services.listSnapshots
    if (!listSnapshots) return
    setState({ open: true, path, entries: [], loading: true })
    try {
      const entries = await listSnapshots(path)
      if (deps.isMounted()) setState({ open: true, path, entries, loading: false })
    } catch (error) {
      if (!deps.isMounted()) return
      setState(current => ({ ...current, loading: false }))
      fail("history.failed", `list failed ${pathField(path)}`, error)
    }
  }, [deps, fail, services, store, t])

  const restoreCopy = useCallback((entry: SnapshotEntry): void => {
    const path = state.path
    const read = services.readSnapshot
    if (!path || !read) return
    void read(path, entry.fileName)
      .then(contents => {
        if (!deps.isMounted()) return
        deps.newTab(contents)
        setState(current => ({ ...current, open: false }))
      })
      .catch(error => {
        if (!deps.isMounted()) return
        fail("history.failed", `read failed ${pathField(path)}`, error)
      })
  }, [deps, fail, services, state.path, t])

  const restoreInPlace = useCallback((entry: SnapshotEntry): void => {
    const path = state.path
    const read = services.readSnapshot
    if (!path || !read) return
    const tab = store.getWorkspace().tabs.find(item => sessionPath(item) === path)
    if (!tab) {
      deps.showTransientStatus(t("history.noFile"))
      return
    }
    // Replacing a buffer that holds edits the disk does not have would destroy
    // them silently; ask first, exactly like a close.
    if (store.isTabDirty(tab.id) && !(services.confirmClose ?? services.confirmDiscard)()) {
      return
    }
    void read(path, entry.fileName)
      .then(contents => {
        if (!deps.isMounted()) return
        deps.activateTab(tab.id)
        if (!deps.restoreTabContents(tab.id, contents)) {
          deps.showTransientStatus(t("history.failed"))
          getGlobalLogger().warn(
            "snapshots",
            `in-place restore could not reach the view ${pathField(path)}`,
          )
          return
        }
        setState(current => ({ ...current, open: false }))
      })
      .catch(error => {
        if (!deps.isMounted()) return
        fail("history.failed", `read failed ${pathField(path)}`, error)
      })
  }, [deps, fail, services, state.path, store, t])

  const clear = useCallback((): void => {
    const path = state.path
    const clearSnapshots = services.clearSnapshots
    if (!path || !clearSnapshots) return
    void clearSnapshots(path)
      .then(() => {
        if (deps.isMounted()) setState(current => ({ ...current, entries: [] }))
      })
      .catch(error => {
        if (!deps.isMounted()) return
        fail("history.failed", `clear failed ${pathField(path)}`, error)
      })
  }, [deps, fail, services, state.path, t])

  const close = useCallback((): void => {
    setState(current => ({ ...current, open: false }))
  }, [])

  return { state, open, restoreCopy, restoreInPlace, clear, close }
}

function activeFilePath(workspace: Workspace): string | null {
  const active = workspace.tabs.find(tab => tab.id === workspace.activeId)
  return active ? sessionPath(active) : null
}
