/**
 * Tab lifecycle: activation (including lazy restore), creation, closing, and the
 * recovery/scale/save bookkeeping each of those owes the rest of the app.
 *
 * Extracted from `App.tsx` so the shell reads as composition; every changing
 * value is reached through getters or the returned controller, never captured.
 */
import {
  createSession, openSession, sessionContentLoaded, sessionDirty, sessionPath,
  recoveryKey, type EditorSession,
} from "./session"
import {
  activeSession, addTab, baseName, closeTab, focusTab,
  replaceTabSession, type Workspace,
} from "./workspace"
import { clearTabNormalization, type NormalizationByTab } from "./normalizationState"
import { initialSaveState, removeTabSaveState, type SaveStateByTab } from "./documentSaveState"
import type { EditorView } from "@codemirror/view"
import type { DocumentScaleRegistry } from "./documentScaleRegistry"
import type { DocumentStore } from "./documentStore"
import type { EditorRegistry } from "./editorRegistry"
import type { DocumentViews } from "./documentViews"
import type { DocumentOpen } from "./documentOpen"
import type { RecoveryWriter } from "./recoveryWriter"
import type { TabSaveQueues } from "./documentSaveCoordinator"
import type { DesktopServices } from "./desktopServices"
import { clearRecoveryAfterForget } from "./recoveryCleanup"
import { createEditor } from "./Editor"
import { errorMessage } from "./desktopServices"
import { t } from "./i18n"

export interface TabLifecycleDeps {
  readonly services: DesktopServices
  readonly store: DocumentStore
  readonly registry: EditorRegistry
  readonly views: DocumentViews
  readonly documentScaleRegistry: DocumentScaleRegistry
  readonly recoveryWriter: RecoveryWriter
  readonly tabSaveQueues: TabSaveQueues
  readonly getOpenCoordinator: () => DocumentOpen
  readonly commitWorkspace: (next: Workspace) => void
  readonly commitNormalization: (next: NormalizationByTab) => void
  readonly commitSaveState: (next: SaveStateByTab) => void
  readonly invalidateOutline: (tabId: number) => void
  readonly refreshOutline: (view: EditorView | null) => void
  /** Re-applies the per-view scale policy after a revived view is rebuilt. */
  readonly applyScalePolicy: (view: EditorView, tabId: number) => void
  readonly reportError: (message: string) => void
  readonly setOpeningLabel: (label: string | null) => void
  readonly setOpeningProgress: (progress: { bytesRead: number; byteLength: number } | null) => void
  readonly revealFolder: (path: string) => void
  readonly rememberRecent: (path: string) => void
  /** Cancels one tab's own autosave timer (tab closed or became clean). */
  readonly cancelAutosave: (tabId: number) => void
}

export interface TabLifecycle {
  readonly activateTab: (id: number) => void
  readonly loadLazyTab: (lazy: EditorSession) => Promise<void>
  readonly loadDraftTarget: (path: string) => Promise<void>
  readonly mountNewTab: (tabId: number) => void
  readonly newTab: (contents?: string) => void
  readonly closeTabInternal: (
    id: number,
    options: { confirm: boolean; allowReplaceLast: boolean },
  ) => boolean
  readonly requestCloseTab: (id: number) => void
}

export function createTabLifecycle(deps: TabLifecycleDeps): TabLifecycle {
  const { store, registry, views } = deps
  const materializer = views.materializer

  function tabById(id: number): EditorSession | undefined {
    return store.getWorkspace().tabs.find(tab => tab.id === id)
  }

  function activateTab(id: number): void {
    const activeBefore = store.getActiveSession()
    // Leaving a tab only needs materialization when edits are still pending.
    // Flushing through the materializer (instead of writing the store directly)
    // also persists crash recovery and arms that tab's own autosave, so a tab
    // switch cannot silently drop the outgoing tab's draft.
    if (materializer.hasPending(activeBefore.id)) materializer.flushTab(activeBefore.id)
    deps.commitWorkspace(focusTab(store.getWorkspace(), id))
    const nextView = registry.getView(id) ?? reviveEvicted(id)
    if (!nextView) return
    registry.setActiveView(id)
    // Bound the live set: past the budget, the least recently activated clean
    // background tab is released (its text already lives in the store).
    registry.evictOverBudget({
      activeTabId: id,
      isEvictable: tabId => !store.isTabDirty(tabId)
        && store.getNormalizationByTab()[tabId] === undefined,
      flush: (tabId, contents) => {
        store.setTabDoc(tabId, contents)
        store.bumpDocVersion(tabId)
      },
    })
    const tab = tabById(id)
    if (tab && !sessionContentLoaded(tab)) {
      void loadLazyTab(tab)
      return
    }
    views.syncDoc(store.getTabDoc(id) || nextView.state.doc.toString(), id)
    deps.refreshOutline(nextView)
    views.jumpPending()
    views.focusPendingEditor()
  }

  /** Rebuilds a view the registry released to stay inside its live budget. */
  function reviveEvicted(tabId: number): EditorView | null {
    if (!registry.isEvicted(tabId)) return null
    const tab = tabById(tabId)
    if (!tab) return null
    const text = deps.documentScaleRegistry.takeText(tabId)
    const view = registry.revive(tabId, host => createEditor(
      host,
      views.editorOptions(store.getTabDoc(tab.id), tab.id, tab.documentId, text),
    ))
    if (view) {
      deps.applyScalePolicy(view, tabId)
      // Settings may have changed while the tab had no view: the spellcheck and
      // auto-pair toggles only reach live views, so a revived one must catch up.
      views.syncEditorSettings?.(view)
    }
    return view
  }

  /** Spec 05b: a restored lazy tab reads its file on first activation. */
  async function loadLazyTab(lazy: EditorSession): Promise<void> {
    const path = sessionPath(lazy)
    if (!path) return
    const open = deps.getOpenCoordinator()
    const token = open.nextRequest()
    const tier = await open.resolveOpenTier(path)
    if (tier === "cancel" || token !== open.currentRequest) return
    const showOverlay = tier !== "normal"
    if (showOverlay) deps.setOpeningLabel(baseName(path))
    try {
      const snapshot = await open.readSnapshotForOpen(path, tier)
      if (token !== open.currentRequest) return
      if (snapshot.kind !== "existing") {
        deps.reportError(t("error.openFailed"))
        return
      }
      await deps.services.allowDocumentAssets(path)
      if (token !== open.currentRequest) return
      // The tab may have been closed while reading: do not stage a full Text
      // (or scale metadata) for a dead id — that would leak until exit.
      if (!store.getWorkspace().tabs.some(item => item.id === lazy.id)) return
      deps.revealFolder(path)
      deps.rememberRecent(path)
      const updated = openSession(lazy, snapshot)
      // Unconditional: a retry after a failed load must clear stale read-only
      // / byte metadata left by the previous attempt.
      deps.documentScaleRegistry.setBytes(updated.id, snapshot.stats?.byteLength)
      deps.documentScaleRegistry.setReadOnly(updated.id, tier === "readonly")
      if (!views.resetTabDocument(updated, snapshot.contents, snapshot.docText)) {
        // No view yet: commit the session and let ensureViews apply the policy.
        deps.commitWorkspace(replaceTabSession(store.getWorkspace(), updated))
        store.setTabDoc(updated.id, snapshot.contents)
        if (snapshot.docText) deps.documentScaleRegistry.stashText(updated.id, snapshot.docText)
        views.syncDoc(snapshot.contents, updated.id)
      }
    } catch (error) {
      if (token === open.currentRequest) {
        deps.reportError(errorMessage(t("error.openFailed"), error))
      }
    } finally {
      if (token === open.currentRequest && showOverlay) {
        deps.setOpeningLabel(null)
        deps.setOpeningProgress(null)
      }
    }
  }

  /**
   * Loads a restored lazy tab before its recovery draft is mounted, so the tab
   * has the disk baseline/version a guarded save compares against.
   */
  async function loadDraftTarget(path: string): Promise<void> {
    const tab = store.getWorkspace().tabs.find(item => sessionPath(item) === path)
    if (tab && !sessionContentLoaded(tab)) await loadLazyTab(tab)
  }

  /** Registers a new tab's derived state; callers own contents and ws commit. */
  function mountNewTab(tabId: number): void {
    store.setDocVersion(tabId, 0)
    deps.commitSaveState({ ...store.getSaveStateByTab(), [tabId]: initialSaveState() })
  }

  function newTab(contents = ""): void {
    const tab = createSession(store.getWorkspace().nextId)
    store.setTabDoc(tab.id, contents)
    mountNewTab(tab.id)
    deps.commitWorkspace(addTab(store.getWorkspace(), tab))
    views.syncDoc(contents, tab.id)
  }

  function closeTabInternal(
    id: number,
    options: { confirm: boolean; allowReplaceLast: boolean },
  ): boolean {
    const tab = tabById(id)
    if (!tab) return false
    const contents = store.getTabDoc(id)
    if (
      options.confirm
      && sessionDirty(tab, contents)
      && !(deps.services.confirmClose ?? deps.services.confirmDiscard)()
    ) {
      return false
    }
    let currentWorkspace = store.getWorkspace()
    if (options.allowReplaceLast && currentWorkspace.tabs.length === 1) {
      const replacement = createSession(currentWorkspace.nextId)
      store.setTabDoc(replacement.id, "")
      store.setDocVersion(replacement.id, 0)
      deps.commitSaveState({ ...store.getSaveStateByTab(), [replacement.id]: initialSaveState() })
      currentWorkspace = addTab(currentWorkspace, replacement)
    }
    const closed = closeTab(currentWorkspace, id)
    if (!closed.tabs.some(item => item.id === id)) {
      deps.commitNormalization(clearTabNormalization(store.getNormalizationByTab(), id))
      deps.commitSaveState(removeTabSaveState(store.getSaveStateByTab(), id))
      // A draft write that lands after the delete would recreate the record.
      clearRecoveryAfterForget(deps.recoveryWriter.forget(id), deps.services, recoveryKey(tab))
      store.deleteTabDoc(id)
      deps.invalidateOutline(id)
      // In-flight saves keep running, but no later open should await this queue.
      deps.tabSaveQueues.delete(id)
      materializer.discard(id)
      deps.cancelAutosave(id)
      deps.documentScaleRegistry.remove(id)
      registry.destroy(id)
    }
    deps.commitWorkspace(closed)
    const active = activeSession(closed)
    // The neighbor that slides into the closed slot may be an LRU-evicted tab or
    // a still-unloaded lazy tab; activating it blindly would leave a blank
    // editor (no view) or overwrite unread disk content with an empty doc.
    const nextView = registry.getView(active.id) ?? reviveEvicted(active.id)
    if (nextView) registry.setActiveView(active.id)
    if (!sessionContentLoaded(active)) {
      void loadLazyTab(active)
      return !closed.tabs.some(item => item.id === id)
    }
    views.syncDoc(
      store.getTabDoc(active.id) || (nextView ? nextView.state.doc.toString() : ""),
      active.id,
    )
    if (nextView) deps.refreshOutline(nextView)
    return !closed.tabs.some(item => item.id === id)
  }

  function requestCloseTab(id: number): void {
    materializer.flush()
    // Closing the last file swaps in a fresh untitled scratch (same swap as the
    // delete path). A clean untitled lone tab would only be swapped for an
    // identical one — and each swap churns the CodeMirror view — so that is a
    // no-op rather than cycling tab ids under a held Cmd+W.
    const tabs = store.getWorkspace().tabs
    const lone = tabs.length === 1 ? tabs[0] : undefined
    if (
      lone
      && lone.id === id
      && lone.persistence.kind === "untitled"
      && !sessionDirty(lone, store.getTabDoc(id))
    ) {
      return
    }
    closeTabInternal(id, { confirm: true, allowReplaceLast: true })
  }

  return {
    activateTab,
    loadLazyTab,
    loadDraftTarget,
    mountNewTab,
    newTab,
    closeTabInternal,
    requestCloseTab,
  }
}
