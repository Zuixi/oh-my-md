/**
 * Editor construction and document synchronization for every tab.
 *
 * These functions used to live in `App.tsx` and were rebuilt on each render,
 * which made them impossible to reason about in isolation: `editorOptions`
 * captured the shell, `resetTabDocument` restated the scale/version/cache
 * invariants, and every callback had to guess whether it was looking at the
 * active tab. The controller is created once per mount and reaches all changing
 * state through getters, exactly like `documentOpen.ts`.
 */
import type { EditorView } from "@codemirror/view"
import type { Text } from "@codemirror/state"
import {
  createEditor, resetEditorDocument, setEditorAutoPair, setEditorSpellcheck,
  type CreateEditorOptions, type EditorDocumentUpdate,
} from "./Editor"
import type { EditorStatusStore } from "./editorStatusStore"
import type { DocumentScaleRegistry } from "./documentScaleRegistry"
import {
  clearTabNormalization, projectNormalizationNotice, type NormalizationByTab,
} from "./normalizationState"
import { replaceTabSession } from "./workspace"
import type { Workspace } from "./workspace"
import { recoveryKey, sessionPath, type EditorSession } from "./session"
import type { RecoveryWriter } from "./recoveryWriter"
import { createDocumentMaterializer, type DocumentMaterializer } from "./documentMaterializer"
import type { EditorScalePolicyApplier, LargeDocNotice } from "./editorScalePolicy"
import { errorMessage, type DesktopServices } from "./desktopServices"
import type { UserSettings } from "./settings"
import type { DocumentStore } from "./documentStore"
import type { EditorRegistry } from "./editorRegistry"
import type { DocumentOpen } from "./documentOpen"
import type { ImagePasteOptions } from "./imagePaste"
import type { ClipboardPasteOptions } from "./clipboardPaste"
import { resolveMarkdownHref } from "./workspace"
import { t } from "./i18n"

export interface DocumentViewsDeps {
  readonly services: DesktopServices
  readonly store: DocumentStore
  readonly registry: EditorRegistry
  readonly documentScaleRegistry: DocumentScaleRegistry
  readonly editorStatusStore: EditorStatusStore
  readonly recoveryWriter: RecoveryWriter
  readonly getSettings: () => UserSettings
  readonly getOpenCoordinator: () => DocumentOpen
  readonly applyScalePolicy: EditorScalePolicyApplier
  readonly setNotice: (notice: LargeDocNotice | null) => void
  readonly setSourceMode: (source: boolean) => void
  readonly setTransientStatus: (message: string | null) => void
  readonly reportError: (message: string) => void
  /** Arms one tab's own autosave timer after a materialized edit. */
  readonly scheduleAutosave: (tabId: number) => void
  readonly commitWorkspace: (next: Workspace) => void
  readonly commitNormalization: (next: NormalizationByTab) => void
  /** Drops one tab's outline cache (a reload restarts its version at 0). */
  readonly invalidateOutline: (tabId: number) => void
  /** Pending line jump / focus requests handed over once a view exists. */
  readonly pendingJump: { current: number | null }
  readonly pendingFocus: { current: boolean }
  /** Pull-based materialization trailing window (0 = synchronous, tests). */
  readonly materializeDelayMs: number
}

export interface DocumentViews {
  readonly materializer: DocumentMaterializer
  readonly syncDoc: (value: string, tabId?: number) => void
  readonly saveRecovery: (tab: EditorSession, contents: string) => void
  readonly handleDocumentUpdate: (update: EditorDocumentUpdate) => void
  readonly editorOptions: (
    contents: string, tabId: number, documentId: number, docText?: Text,
  ) => CreateEditorOptions
  readonly pasteOptions: (tabId: number, documentId: number) => ClipboardPasteOptions
  readonly imageInsertOptions: (tabId: number, documentId: number) => ImagePasteOptions
  readonly resetTabDocument: (nextSession: EditorSession, contents: string, docText?: Text) => boolean
  /**
   * Re-applies the current settings to a rebuilt view. A tab that was evicted
   * for a while received none of the settings changes that only reach live
   * views, so a revive must not leave it on stale spellcheck/auto-pair state.
   */
  readonly syncEditorSettings?: (view: EditorView) => void
  readonly ensureViews: () => void
  readonly jumpPending: () => void
  readonly focusPendingEditor: () => void
  readonly requestFocus: () => void
}

export function createDocumentViews(deps: DocumentViewsDeps): DocumentViews {
  const { store, registry, documentScaleRegistry, services } = deps

  const syncDoc = (value: string, tabId = store.getWorkspace().activeId): void => {
    store.setTabDoc(tabId, value)
    // Re-classify from the live line count; unchanged tiers neither dispatch nor
    // publish a notice.
    deps.applyScalePolicy.refresh(registry.getView(tabId), tabId)
  }

  const saveRecovery = (tab: EditorSession, contents: string): void => {
    void deps.recoveryWriter.save(
      { tabId: tab.id, key: recoveryKey(tab), path: sessionPath(tab), contents },
      { write: services.writeRecovery, reportError: deps.reportError },
    )
  }

  const materializer = createDocumentMaterializer({
    delayMs: deps.materializeDelayMs,
    readViewText: tabId => registry.getView(tabId)?.state.doc.toString() ?? null,
    materialize: (tabId, contents) => {
      syncDoc(contents, tabId)
      const tab = store.getWorkspace().tabs.find(item => item.id === tabId)
      if (tab) saveRecovery(tab, contents)
      deps.scheduleAutosave(tabId)
    },
    setTimer: (callback, ms) => window.setTimeout(callback, ms),
    clearTimer: id => window.clearTimeout(id),
  })

  const handleDocumentUpdate = (update: EditorDocumentUpdate): void => {
    const tab = store.getWorkspace().tabs.find(item => item.id === update.tabId)
    if (!tab || tab.documentId !== update.documentId) return
    if (update.docChanged) {
      // Version is the outline/find cache axis: selection-only updates do not
      // invalidate an outline.
      store.bumpDocVersion(update.tabId)
      materializer.queue(update.tabId)
    }
    deps.commitNormalization(projectNormalizationNotice(
      store.getNormalizationByTab(),
      update.tabId,
      update.pendingNormalization,
    ))
  }

  const imageInsertOptions = (tabId: number, documentId: number): ImagePasteOptions => ({
    getDocPath: () => {
      const tab = store.getWorkspace().tabs.find(item => item.id === tabId)
      return tab ? sessionPath(tab) : null
    },
    getDocumentId: () => store.getWorkspace().tabs.find(item => item.id === tabId)?.documentId ?? documentId,
    onError: deps.reportError,
  })

  const pasteOptions = (tabId: number, documentId: number): ClipboardPasteOptions => ({
    ...imageInsertOptions(tabId, documentId),
    getTabId: () => store.getWorkspace().activeId ?? tabId,
    onNotice: deps.reportError,
    onConvertingChange: (active: boolean) => {
      deps.setTransientStatus(active ? t("paste.status.converting") : null)
    },
  })

  const editorOptions = (
    contents: string,
    tabId: number,
    documentId: number,
    docText?: Text,
  ): CreateEditorOptions => {
    // HUGE read-only tier: `readOnly` blocks edits; progressive rendering lands
    // large documents live, so no forced source mode or extension trimming.
    const readOnly = documentScaleRegistry.isReadOnly(tabId)
    const settings = deps.getSettings()
    return {
      // Streaming open passes Text straight through (no whole-string line split).
      doc: docText ?? contents,
      tabId,
      documentId,
      ...pasteOptions(tabId, documentId),
      onDocumentUpdate: handleDocumentUpdate,
      onModeChange: isLive => {
        const tab = store.getWorkspace().tabs.find(item => item.id === tabId)
        if (!tab || tab.documentId !== documentId) return
        if (store.getWorkspace().activeId !== tabId) return
        deps.setSourceMode(!isLive)
      },
      // Stale tab/document/view identities must not publish active status: a
      // background view keeps firing selection updates while hidden.
      onStatusChange: status => {
        const tab = store.getWorkspace().tabs.find(item => item.id === tabId)
        if (!tab || tab.documentId !== documentId) return
        if (store.getWorkspace().activeId !== tabId) return
        deps.editorStatusStore.publish(status)
      },
      onOpenExternalHref: href => { void services.openExternal?.(href) },
      onOpenMarkdownHref: href => {
        const current = activeSessionPath(store.getWorkspace())
        if (!current) {
          deps.reportError(errorMessage(t("error.openFailed"), new Error("File not found")))
          return
        }
        void deps.getOpenCoordinator().openPath(resolveMarkdownHref(current, href), true)
      },
      tabSize: settings.tabSize,
      spellcheck: settings.spellcheck,
      autoPair: settings.autoPair,
      readOnly,
      performancePolicy: documentScaleRegistry.performancePolicy(tabId),
    }
  }

  const syncEditorSettings = (view: EditorView): void => {
    const settings = deps.getSettings()
    // Fake views created by unit tests may reject both reconfigurations.
    try {
      setEditorSpellcheck(view, settings.spellcheck)
      setEditorAutoPair(view, settings.autoPair)
    } catch {
      /* a view without the settings compartments (test doubles) */
    }
  }

  const resetTabDocument = (
    nextSession: EditorSession,
    contents: string,
    docText?: Text,
  ): boolean => {
    const view = registry.getView(nextSession.id)
    if (!view) {
      // Reloading a document on an evicted tab: the new text is authoritative,
      // so its preserved state (old rope, undo history, caret) must not win when
      // the tab is revived. The eviction stays, so activation still rebuilds it.
      if (registry.isEvicted(nextSession.id)) registry.discardDetachedState(nextSession.id)
      return false
    }
    const previousWorkspace = store.getWorkspace()
    const previousNormalization = store.getNormalizationByTab()
    const previousDoc = store.getTabDoc(nextSession.id)
    deps.commitWorkspace(replaceTabSession(previousWorkspace, nextSession))
    deps.commitNormalization(clearTabNormalization(previousNormalization, nextSession.id))
    // Whole-document reload: the outline cache dies with the old document and
    // the version restarts at 0 (a cached v0 must not be served).
    store.setDocVersion(nextSession.id, 0)
    deps.invalidateOutline(nextSession.id)
    try {
      resetEditorDocument(view, editorOptions(
        contents, nextSession.id, nextSession.documentId, docText,
      ))
    } catch (error) {
      deps.commitWorkspace(previousWorkspace)
      deps.commitNormalization(previousNormalization)
      syncDoc(previousDoc, nextSession.id)
      throw error
    }
    // The view consumed the Text directly: drop any staging left for it.
    documentScaleRegistry.takeText(nextSession.id)
    deps.applyScalePolicy(view, nextSession.id)
    // Reloaded content is authoritative: drop pending so an older view text
    // cannot overwrite it (Spec 05a).
    materializer.discard(nextSession.id)
    syncDoc(contents, nextSession.id)
    return true
  }

  const ensureViews = (): void => {
    for (const tab of store.getWorkspace().tabs) {
      if (registry.getView(tab.id)) continue
      const el = registry.getHost(tab.id)
      if (!el) continue
      // An evicted view is rebuilt on activation, not here, so a background
      // eviction cannot be undone by an unrelated workspace commit.
      if (registry.isEvicted(tab.id)) continue
      const view = createEditor(
        el,
        // Streaming open's staged Text is consumed here for a fresh large tab.
        editorOptions(
          store.getTabDoc(tab.id),
          tab.id,
          tab.documentId,
          documentScaleRegistry.takeText(tab.id),
        ),
      )
      registry.add(tab.id, view)
      if (tab.id === store.getWorkspace().activeId) registry.setActiveView(tab.id)
      deps.applyScalePolicy(view, tab.id)
    }
    jumpPending()
    focusPendingEditor()
  }

  /** Views exist only after ensureViews/activateTab, so focus waits on a flag. */
  const jumpPending = (): void => {
    const lineNo = deps.pendingJump.current
    const view = registry.getActiveView()
    if (!lineNo || !view) return
    deps.pendingJump.current = null
    try {
      const line = view.state.doc.line(lineNo)
      view.dispatch({ selection: { anchor: line.from } })
    } catch {
      /* mock views */
    }
  }

  const focusPendingEditor = (): void => {
    if (!deps.pendingFocus.current) return
    deps.pendingFocus.current = false
    try { registry.getActiveView()?.focus() } catch { /* mock views */ }
  }

  return {
    materializer,
    syncDoc,
    saveRecovery,
    handleDocumentUpdate,
    editorOptions,
    pasteOptions,
    imageInsertOptions,
    resetTabDocument,
    syncEditorSettings,
    ensureViews,
    jumpPending,
    focusPendingEditor,
    requestFocus: () => { deps.pendingFocus.current = true },
  }
}

function activeSessionPath(workspace: import("./workspace").Workspace): string | null {
  const active = workspace.tabs.find(tab => tab.id === workspace.activeId)
  return active ? sessionPath(active) : null
}

/** Applies an editor-wide toggle to every live view (fake views may reject). */
export function forEachLiveView(
  registry: EditorRegistry,
  apply: (view: EditorView) => void,
): void {
  for (const view of registry.views().values()) {
    try { apply(view) } catch { /* mock views */ }
  }
}
