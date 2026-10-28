import type { EditorView } from "@codemirror/view"
import type { Text, TransactionSpec } from "@codemirror/state"
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
import { sessionDirty, sessionPath, type EditorSession } from "./session"
import type { Workspace } from "./workspace"
import { createTransientStatusNotifier } from "./transientStatus"
import { t } from "./i18n"

export type SaveTrigger = "autosave" | "explicit"

export interface NormalizationOperationCapture {
  readonly tabId: number
  readonly documentId: number
  readonly view: EditorView
  readonly normalizationId: NormalizationId
}

export const SKIPPED_MARKERS_STATUS =
  "normalization.skippedMarkers"

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
  /** snapshot 物化自的 Text 引用：保存期间无文档变更（Text 身份不变）时，
   * 调用方可复用 snapshot 字符串引用写回 docsRef（sessionDirty 保持 O(1)）。 */
  readonly docAtStart: Text
  readonly capture: NormalizationOperationCapture | null
  readonly nextNormalization: NormalizationByTab
}

export function prepareTabSave(
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
  const docAtStart = view.state.doc
  const snapshot = docAtStart.toString()
  const tabNorm = normalization[tabId]
  if (trigger !== "explicit" || tabNorm?.action !== "idle" || !tabNorm.notice) {
    return { tab, view, documentId, snapshot, docAtStart, capture: null, nextNormalization: normalization }
  }
  const capture: NormalizationOperationCapture = {
    tabId, documentId, view, normalizationId: tabNorm.notice.id,
  }
  const saving = setNormalizationAction(normalization, tabId, tabNorm.notice.id, "saving")
  if (saving === normalization) return null
  return { tab, view, documentId, snapshot, docAtStart, capture, nextNormalization: saving }
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

export function createSkippedStatusNotifier(
  setMessage: (value: string | null) => void,
  timerRef: { readonly current: number | null },
  setTimer: (id: number | null) => void,
): () => void {
  const notify = createTransientStatusNotifier(setMessage, timerRef, setTimer)
  return () => notify(t(SKIPPED_MARKERS_STATUS))
}
