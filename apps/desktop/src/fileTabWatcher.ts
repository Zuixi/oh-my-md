import type { DiskSnapshot, ExpectedDocumentVersion } from "./desktopServices"
import { divergenceFromSnapshot, watcherIntent } from "./documentSaveCoordinator"
import { applyDivergence, isFreshObservation, tabSaveState, updateTabSaveState, type SaveStateByTab } from "./documentSaveState"
import { sessionContentLoaded, sessionDirty, sessionPath, type EditorSession } from "./session"
import type { Workspace } from "./workspace"

export interface FileTabWatcherHost {
  readonly getWorkspace: () => Workspace
  readonly getContents: (tabId: number) => string
  readonly getSaveStates: () => SaveStateByTab
  readonly setSaveStates: (next: SaveStateByTab) => void
  readonly readDocumentVersion: (path: string) => Promise<ExpectedDocumentVersion>
  readonly readDocument: (path: string) => Promise<DiskSnapshot>
  readonly logReadFailed: (error: unknown, tab: EditorSession, stage: "version" | "contents") => void
  readonly logReadRecovered?: (tab: EditorSession) => void
}

export function createFileTabWatcher(
  host: FileTabWatcherHost,
  unreadable = new Map<number, string>(),
): () => Promise<void> {
  // One outage per document, not consecutive-message deduplication. The host
  // may retain this map across bridge rebuilds; prune closed identities here.
  return async () => {
    const tabs = host.getWorkspace().tabs
    for (const [id, identity] of unreadable) {
      if (!tabs.some(tab => tab.id === id && identity === documentKey(tab))) unreadable.delete(id)
    }
    for (const tab of tabs) {
      const path = sessionPath(tab)
      if (!path || !sessionContentLoaded(tab)) continue
      const generation = tabSaveState(host.getSaveStates(), tab.id).ioGeneration
      const current = () => host.getWorkspace().tabs.some(item =>
        item.id === tab.id && documentKey(item) === documentKey(tab))
        && isFreshObservation(tabSaveState(host.getSaveStates(), tab.id), generation)
      if (!current()) continue
      const failed = (error: unknown, stage: "version" | "contents") => {
        if (!current() || unreadable.has(tab.id)) return
        unreadable.set(tab.id, documentKey(tab))
        host.logReadFailed(error, tab, stage)
      }
      const recovered = () => {
        if (unreadable.delete(tab.id)) host.logReadRecovered?.(tab)
      }
      let probe: ExpectedDocumentVersion
      try {
        probe = await host.readDocumentVersion(path)
      } catch (error) {
        failed(error, "version")
        continue
      }
      if (!current()) continue
      const intent = watcherIntent(tab, probe)
      if (intent.kind === "ignore") {
        recovered()
        continue
      }
      const contents = host.getContents(tab.id)
      if (intent.kind === "deleted" || intent.kind === "pathChanged") {
        recovered()
        host.setSaveStates(updateTabSaveState(host.getSaveStates(), tab.id, applyDivergence(
          tabSaveState(host.getSaveStates(), tab.id),
          { kind: intent.kind === "deleted" ? "deletedExternally" : "pathChanged", localSnapshot: contents },
        )))
        continue
      }
      let disk: DiskSnapshot
      try {
        disk = await host.readDocument(path)
      } catch (error) {
        failed(error, "contents")
        continue
      }
      if (!current()) continue
      recovered()
      if (disk.kind !== "existing") continue
      host.setSaveStates(updateTabSaveState(host.getSaveStates(), tab.id, applyDivergence(
        tabSaveState(host.getSaveStates(), tab.id),
        divergenceFromSnapshot(disk, sessionDirty(tab, contents), contents),
      )))
    }
  }
}

function documentKey(tab: EditorSession): string {
  return `${tab.documentId}:${sessionPath(tab) ?? ""}`
}
