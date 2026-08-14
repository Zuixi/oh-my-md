import type { EditorView } from "@codemirror/view"
import type { TransactionSpec } from "@codemirror/state"
import {
  acceptOrderedListNormalization,
  getPendingOrderedListNormalization,
  rejectOrderedListNormalization,
  type NormalizationId,
  type OrderedListNormalizationNotice,
} from "@omd/engine"
import {
  resyncNormalizationIdle,
  setNormalizationAction,
  type NormalizationByTab,
} from "./normalizationState"
import { markSaved, recoveryKey, sessionDirty, sessionPath, type EditorSession } from "./session"
import { replaceTabSession, type Workspace } from "./workspace"
import type { DocumentVersion, ExpectedDocumentVersion } from "./desktopServices"

export type SaveTrigger = "autosave" | "explicit"

export interface NormalizationOperationCapture {
  readonly tabId: number
  readonly documentId: number
  readonly view: EditorView
  readonly normalizationId: NormalizationId
}

export const SKIPPED_MARKERS_STATUS =
  "Original numbers were restored where they were unchanged."

export const TRANSIENT_STATUS_MS = 4000

export function canAutosaveTab(
  tabId: number,
  state: NormalizationByTab,
): boolean {
  return state[tabId] === undefined
}

export function isCurrentNormalizationTarget(
  capture: NormalizationOperationCapture,
  workspace: Workspace,
  views: ReadonlyMap<number, EditorView>,
  currentNotice: OrderedListNormalizationNotice | null,
): boolean {
  const tab = workspace.tabs.find(item => item.id === capture.tabId)
  if (!tab || tab.documentId !== capture.documentId) return false
  if (views.get(capture.tabId) !== capture.view) return false
  if (!currentNotice || currentNotice.id !== capture.normalizationId) return false
  return true
}

export function sameSaveTarget(
  tabId: number,
  documentId: number,
  view: EditorView,
  tab: EditorSession | undefined,
  views: ReadonlyMap<number, EditorView>,
): boolean {
  if (!tab || tab.documentId !== documentId) return false
  return views.get(tabId) === view
}

export function resyncTabNormalization(
  state: NormalizationByTab,
  tabId: number,
  view: EditorView,
): NormalizationByTab {
  const freshNotice = getPendingOrderedListNormalization(view.state)
  return resyncNormalizationIdle(state, tabId, freshNotice)
}

export interface AcceptCompletion {
  readonly transaction: TransactionSpec | null
  readonly nextState: NormalizationByTab
}

export function completeAccept(
  capture: NormalizationOperationCapture,
  workspace: Workspace,
  views: ReadonlyMap<number, EditorView>,
  state: NormalizationByTab,
): AcceptCompletion {
  const currentNotice = getPendingOrderedListNormalization(capture.view.state)
  if (!isCurrentNormalizationTarget(capture, workspace, views, currentNotice)) {
    return {
      transaction: null,
      nextState: resyncTabNormalization(state, capture.tabId, capture.view),
    }
  }
  const result = acceptOrderedListNormalization(
    capture.view.state,
    capture.normalizationId,
  )
  if (result.kind === "stale") {
    return {
      transaction: null,
      nextState: resyncTabNormalization(state, capture.tabId, capture.view),
    }
  }
  return {
    transaction: result.transaction,
    nextState: resyncNormalizationIdle(state, capture.tabId, null),
  }
}

export interface RejectCompletion {
  readonly transaction: TransactionSpec | null
  readonly skippedMarkers: number
  readonly nextState: NormalizationByTab
}

export function completeReject(
  capture: NormalizationOperationCapture,
  workspace: Workspace,
  views: ReadonlyMap<number, EditorView>,
  state: NormalizationByTab,
): RejectCompletion {
  const currentNotice = getPendingOrderedListNormalization(capture.view.state)
  if (!isCurrentNormalizationTarget(capture, workspace, views, currentNotice)) {
    return {
      transaction: null,
      skippedMarkers: 0,
      nextState: resyncTabNormalization(state, capture.tabId, capture.view),
    }
  }
  const result = rejectOrderedListNormalization(
    capture.view.state,
    capture.normalizationId,
  )
  if (result.kind === "stale") {
    return {
      transaction: null,
      skippedMarkers: 0,
      nextState: resyncTabNormalization(state, capture.tabId, capture.view),
    }
  }
  return {
    transaction: result.transaction,
    skippedMarkers: result.skippedMarkers,
    nextState: resyncNormalizationIdle(state, capture.tabId, null),
  }
}

export function armRejectCapture(
  tabId: number,
  tab: EditorSession | undefined,
  view: EditorView | undefined,
  normalization: NormalizationByTab,
): { capture: NormalizationOperationCapture; nextState: NormalizationByTab } | null {
  const tabNorm = normalization[tabId]
  if (!tabNorm || tabNorm.action !== "idle" || !tab || !view) return null
  const capture: NormalizationOperationCapture = {
    tabId,
    documentId: tab.documentId,
    view,
    normalizationId: tabNorm.notice.id,
  }
  const reverting = setNormalizationAction(
    normalization, tabId, tabNorm.notice.id, "reverting",
  )
  if (reverting === normalization) return null
  return { capture, nextState: reverting }
}

interface PreparedTabSave {
  readonly tab: EditorSession
  readonly view: EditorView
  readonly documentId: number
  readonly snapshot: string
  readonly capture: NormalizationOperationCapture | null
  readonly nextNormalization: NormalizationByTab
}

function prepareTabSave(
  tabId: number,
  trigger: SaveTrigger,
  tab: EditorSession | undefined,
  view: EditorView | undefined,
  contents: string,
  normalization: NormalizationByTab,
): PreparedTabSave | null {
  if (!tab || !view) return null
  if (trigger === "autosave") {
    if (!sessionPath(tab) || !sessionDirty(tab, contents)) return null
    if (!canAutosaveTab(tabId, normalization)) return null
  }
  const documentId = tab.documentId
  const snapshot = view.state.doc.toString()
  const tabNorm = normalization[tabId]
  if (trigger !== "explicit" || tabNorm?.action !== "idle" || !tabNorm.notice) {
    return { tab, view, documentId, snapshot, capture: null, nextNormalization: normalization }
  }
  const capture: NormalizationOperationCapture = {
    tabId, documentId, view, normalizationId: tabNorm.notice.id,
  }
  const saving = setNormalizationAction(normalization, tabId, tabNorm.notice.id, "saving")
  if (saving === normalization) return null
  return { tab, view, documentId, snapshot, capture, nextNormalization: saving }
}

export interface TabSaveHost {
  readonly isOpening: () => boolean
  readonly getTab: (tabId: number) => EditorSession | undefined
  readonly getView: (tabId: number) => EditorView | undefined
  readonly getContents: (tabId: number) => string
  readonly getNormalization: () => NormalizationByTab
  readonly setNormalization: (next: NormalizationByTab) => void
  readonly getWorkspace: () => Workspace
  readonly getViews: () => ReadonlyMap<number, EditorView>
  readonly pickSavePath: () => Promise<string | null>
  readonly writeFile: (path: string, contents: string) => Promise<void>
  readonly allowDocumentAssets: (path: string) => Promise<void>
  readonly readDocumentVersion: (path: string) => Promise<ExpectedDocumentVersion>
  readonly onPersisted: (
    tab: EditorSession,
    path: string,
    snapshot: string,
    version: DocumentVersion,
    view: EditorView,
  ) => void
  readonly onSaveFailed: (error: unknown) => void
  readonly enqueue: (work: () => Promise<void>) => Promise<void>
}

export function createNormalizationHandlers(host: {
  readonly getActiveTabId: () => number
  readonly getTab: (tabId: number) => EditorSession | undefined
  readonly getView: (tabId: number) => EditorView | undefined
  readonly getNormalization: () => NormalizationByTab
  readonly setNormalization: (next: NormalizationByTab) => void
  readonly getWorkspace: () => Workspace
  readonly getViews: () => ReadonlyMap<number, EditorView>
  readonly saveExplicit: (tabId: number) => void
  readonly onSkippedMarkers: () => void
}): { accept: () => void; reject: () => void } {
  function reject() {
    const tabId = host.getActiveTabId()
    const armed = armRejectCapture(
      tabId, host.getTab(tabId), host.getView(tabId), host.getNormalization(),
    )
    if (!armed) return
    host.setNormalization(armed.nextState)
    const done = completeReject(
      armed.capture, host.getWorkspace(), host.getViews(), host.getNormalization(),
    )
    host.setNormalization(done.nextState)
    if (done.transaction) {
      armed.capture.view.dispatch(done.transaction)
      armed.capture.view.focus()
    }
    if (done.skippedMarkers > 0) host.onSkippedMarkers()
  }
  return {
    accept: () => host.saveExplicit(host.getActiveTabId()),
    reject,
  }
}

export function createSaveQueueRunner(
  queueRef: { current: Promise<void> },
): TabSaveHost["enqueue"] {
  return async work => {
    const operation = queueRef.current.catch(() => undefined).then(work)
    queueRef.current = operation
    await operation
  }
}

export interface SessionPersistenceHost {
  readonly getWorkspace: () => Workspace
  readonly setWorkspace: (next: Workspace) => void
  readonly revealFolder: (path: string) => void
  readonly rememberRecent: (path: string) => void
  readonly recordDiskSnapshot: (path: string, snapshot: string) => void
  readonly syncDoc: (doc: string, tabId: number) => void
  readonly clearRecovery: (key: string) => void
}

export function createSessionPersistence(
  host: SessionPersistenceHost,
): TabSaveHost["onPersisted"] {
  return (tab, path, snapshot, version, view) => {
    const saved = markSaved(tab, path, snapshot, version)
    host.setWorkspace(replaceTabSession(host.getWorkspace(), saved))
    host.revealFolder(path)
    host.rememberRecent(path)
    host.recordDiskSnapshot(path, snapshot)
    host.syncDoc(view.state.doc.toString(), tab.id)
    host.clearRecovery(recoveryKey(saved))
  }
}

export function createSkippedStatusNotifier(
  setMessage: (value: string | null) => void,
  timerRef: { readonly current: number | null },
  setTimer: (id: number | null) => void,
): () => void {
  return () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    setMessage(SKIPPED_MARKERS_STATUS)
    setTimer(window.setTimeout(() => {
      setMessage(null)
      setTimer(null)
    }, TRANSIENT_STATUS_MS))
  }
}

export function createTabSaver(host: TabSaveHost) {
  return async function saveFile(
    tabId: number,
    trigger: SaveTrigger,
    saveAs = false,
  ): Promise<void> {
    if (host.isOpening()) return
    const prepared = prepareTabSave(
      tabId,
      trigger,
      host.getTab(tabId),
      host.getView(tabId),
      host.getContents(tabId),
      host.getNormalization(),
    )
    if (!prepared) return
    if (prepared.nextNormalization !== host.getNormalization()) {
      host.setNormalization(prepared.nextNormalization)
    }
    const { view, documentId, snapshot, capture } = prepared
    const resync = () => {
      if (!capture) return
      host.setNormalization(resyncTabNormalization(
        host.getNormalization(), capture.tabId, capture.view,
      ))
    }
    const stillTarget = () => sameSaveTarget(
      tabId, documentId, view, host.getTab(tabId), host.getViews(),
    )
    await host.enqueue(async () => {
      try {
        if (!stillTarget()) {
          resync()
          return
        }
        const queuedTab = host.getTab(tabId)
        if (!queuedTab) {
          resync()
          return
        }
        const targetPath = saveAs || !sessionPath(queuedTab)
          ? await host.pickSavePath()
          : sessionPath(queuedTab)!
        if (!targetPath || !stillTarget()) {
          resync()
          return
        }
        await host.writeFile(targetPath, snapshot)
        if (!stillTarget()) {
          resync()
          return
        }
        const versionProbe = await host.readDocumentVersion(targetPath)
        if (versionProbe.kind !== "existing") {
          throw new Error("Save succeeded but document version is unavailable")
        }
        await host.allowDocumentAssets(targetPath)
        if (!stillTarget()) {
          resync()
          return
        }
        const currentTab = host.getTab(tabId)
        if (!currentTab) {
          resync()
          return
        }
        host.onPersisted(currentTab, targetPath, snapshot, versionProbe.version, view)
        if (capture) {
          const done = completeAccept(
            capture, host.getWorkspace(), host.getViews(), host.getNormalization(),
          )
          host.setNormalization(done.nextState)
          if (done.transaction) view.dispatch(done.transaction)
        }
      } catch (error) {
        resync()
        host.onSaveFailed(error)
      }
    })
  }
}
