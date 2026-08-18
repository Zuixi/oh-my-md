import type { EditorView } from "@codemirror/view"
import type {
  DiskSnapshot,
  DocumentErrorCode,
  DocumentCommandError,
  ExpectedDocumentVersion,
  SaveDocumentResult,
} from "./desktopServices"
import { toDocumentCommandError } from "./desktopServices"
import {
  applyDivergence,
  beginSave,
  clearDivergence,
  completeSave,
  failSave,
  initialSaveState,
  isFreshObservation,
  tabSaveState,
  updateTabSaveState,
  type DocumentSaveState,
  type SaveStateByTab,
} from "./documentSaveState"
import {
  allocateOperationId,
  canAutosave,
  divergenceFromSaveResult,
  divergenceFromSnapshot,
  expectedVersionFor,
  isCurrentSaveTarget,
  watcherIntent,
  type SaveOperationCapture,
} from "./documentSaveCoordinator"
import {
  completeAccept,
  prepareTabSave,
  resyncTabNormalization,
  type SaveTrigger,
} from "./normalizationCoordinator"
import type { NormalizationByTab } from "./normalizationState"
import { SAVE_COPY_SAME_PATH_MESSAGE } from "./conflictActions"
import { markSaved, recoveryKey, sessionDirty, sessionPath, sessionVersion, type EditorSession } from "./session"
import { replaceTabSession, type Workspace } from "./workspace"
import { t } from "./i18n"

export type SaveMode =
  | { readonly kind: "current" }
  | { readonly kind: "saveAs" }
  | { readonly kind: "overwrite"; readonly expected: ExpectedDocumentVersion }
  | { readonly kind: "recreate" }

export const DURABILITY_WARNING =
  "save.durabilityWarning"

export type SaveStatusLabel = "idle" | "saving" | "save failed" | "conflict"

export function saveStatusLabel(state: DocumentSaveState): SaveStatusLabel {
  if (state.lifecycle.kind === "saving") return "saving"
  if (state.lifecycle.kind === "saveFailed") return "save failed"
  if (state.divergence.kind !== "none") return "conflict"
  return "idle"
}

export interface DocumentSaveHost {
  readonly isOpening: () => boolean
  /** Fires after a successful save; used for fire-and-forget snapshots. */
  readonly onSaved?: (path: string) => void
  readonly getTab: (tabId: number) => EditorSession | undefined
  readonly getView: (tabId: number) => EditorView | undefined
  readonly getContents: (tabId: number) => string
  readonly getNormalization: () => NormalizationByTab
  readonly setNormalization: (next: NormalizationByTab) => void
  readonly getWorkspace: () => Workspace
  readonly setWorkspace: (next: Workspace) => void
  readonly getViews: () => ReadonlyMap<number, EditorView>
  readonly getSaveStates: () => SaveStateByTab
  readonly setSaveStates: (next: SaveStateByTab) => void
  readonly pickSavePath: () => Promise<string | null>
  readonly saveDocument: (
    path: string,
    contents: string,
    expected: ExpectedDocumentVersion,
  ) => Promise<SaveDocumentResult>
  readonly readDocument: (path: string) => Promise<DiskSnapshot>
  readonly readDocumentVersion: (path: string) => Promise<ExpectedDocumentVersion>
  readonly allowDocumentAssets: (path: string) => Promise<void>
  readonly revealFolder: (path: string) => void
  readonly rememberRecent: (path: string) => void
  readonly syncDoc: (doc: string, tabId: number) => void
  readonly clearRecovery: (key: string) => void
  readonly operationSeq: { current: number }
  readonly enqueue: (tabId: number, work: () => Promise<void>) => Promise<void>
  readonly onDurabilityWarning: () => void
  readonly incrementFocusToken: () => void
  readonly logReadFailed: (error: unknown) => void
  readonly reportStatus: (message: string) => void
  readonly onSaveFailed?: (
    tabId: number,
    code: DocumentErrorCode,
    message: string,
  ) => void
}

function expectedForMode(
  tab: EditorSession,
  mode: SaveMode,
): ExpectedDocumentVersion {
  switch (mode.kind) {
    case "overwrite":
      return mode.expected
    case "recreate":
      return { kind: "missing" }
    case "saveAs":
    case "current":
      return expectedVersionFor(tab)
  }
}

function resolveTargetPath(
  tab: EditorSession,
  mode: SaveMode,
  pickedPath: string | null,
): string | null {
  if (mode.kind === "saveAs" || tab.persistence.kind === "untitled") {
    return pickedPath
  }
  return sessionPath(tab)
}

function userFacingSaveError(error: DocumentCommandError): string {
  return error.message || t("error.save.failed")
}

function shouldReportPathError(code: DocumentCommandError["code"]): boolean {
  return code !== "readFailed"
}

export function createGuardedDocumentSaver(host: DocumentSaveHost) {
  return async function saveFile(
    tabId: number,
    trigger: SaveTrigger,
    saveAsOrMode: SaveMode | boolean = false,
  ): Promise<void> {
    const saveAs = saveAsOrMode === true
    const mode: SaveMode = typeof saveAsOrMode === "object"
      ? saveAsOrMode
      : { kind: "current" }
    if (host.isOpening()) return
    const effectiveMode = saveAs ? { kind: "saveAs" as const } : mode
    const saveState = tabSaveState(host.getSaveStates(), tabId)
    if (
      trigger === "explicit"
      && effectiveMode.kind === "current"
      && saveState.divergence.kind !== "none"
    ) {
      host.incrementFocusToken()
      return
    }
    const prepared = prepareTabSave(
      tabId,
      trigger,
      host.getTab(tabId),
      host.getView(tabId),
      host.getContents(tabId),
      host.getNormalization(),
    )
    if (!prepared) return
    if (trigger === "autosave") {
      const tab = host.getTab(tabId)
      if (!tab) return
      const input = {
        tabId,
        dirty: sessionDirty(tab, host.getContents(tabId)),
        hasPath: sessionPath(tab) !== null,
        normalization: host.getNormalization(),
        saveState,
      }
      if (!canAutosave(input)) return
    }
    if (prepared.nextNormalization !== host.getNormalization()) {
      host.setNormalization(prepared.nextNormalization)
    }
    const { view, documentId, snapshot, capture } = prepared
    const operationId = allocateOperationId(host.operationSeq)
    const saveCapture: SaveOperationCapture = {
      tabId,
      documentId,
      view,
      operationId,
      normalizationId: capture?.normalizationId ?? null,
    }
    const resync = () => {
      if (!capture) return
      host.setNormalization(resyncTabNormalization(
        host.getNormalization(), capture.tabId, capture.view,
      ))
    }
    const stillTarget = () => isCurrentSaveTarget(
      saveCapture, host.getWorkspace(), host.getViews(),
    )
    await host.enqueue(tabId, async () => {
      host.setSaveStates(updateTabSaveState(
        host.getSaveStates(),
        tabId,
        beginSave(tabSaveState(host.getSaveStates(), tabId), operationId, snapshot),
      ))
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
        const pickedPath = effectiveMode.kind === "saveAs" || queuedTab.persistence.kind === "untitled"
          ? await host.pickSavePath()
          : null
        const targetPath = resolveTargetPath(queuedTab, effectiveMode, pickedPath)
        if (!targetPath || !stillTarget()) {
          resync()
          host.setSaveStates(updateTabSaveState(
            host.getSaveStates(),
            tabId,
            completeSave(tabSaveState(host.getSaveStates(), tabId), operationId),
          ))
          return
        }
        let expected = expectedForMode(queuedTab, effectiveMode)
        if (effectiveMode.kind === "saveAs" || queuedTab.persistence.kind === "untitled") {
          const probe = await host.readDocumentVersion(targetPath)
          expected = probe.kind === "existing"
            ? { kind: "existing", version: probe.version }
            : { kind: "missing" }
        }
        if (!stillTarget()) {
          resync()
          return
        }
        const result = await host.saveDocument(targetPath, snapshot, expected)
        if (!stillTarget()) {
          resync()
          return
        }
        const currentState = tabSaveState(host.getSaveStates(), tabId)
        if (currentState.lifecycle.kind !== "saving"
          || currentState.lifecycle.operationId !== operationId) {
          return
        }
        if (result.status === "saved") {
          await host.allowDocumentAssets(targetPath)
          if (!stillTarget()) return
          const currentTab = host.getTab(tabId)
          if (!currentTab) return
          const saved = markSaved(currentTab, targetPath, snapshot, result.version)
          host.setWorkspace(replaceTabSession(host.getWorkspace(), saved))
          host.revealFolder(targetPath)
          host.rememberRecent(targetPath)
          host.onSaved?.(targetPath)
          host.syncDoc(view.state.doc.toString(), tabId)
          host.clearRecovery(recoveryKey(saved))
          host.setSaveStates(updateTabSaveState(
            host.getSaveStates(),
            tabId,
            clearDivergence(completeSave(currentState, operationId)),
          ))
          if (result.durability === "directorySyncFailed") {
            host.onDurabilityWarning()
          }
          if (capture) {
            const done = completeAccept(
              capture, host.getWorkspace(), host.getViews(), host.getNormalization(),
            )
            host.setNormalization(done.nextState)
            if (done.transaction) view.dispatch(done.transaction)
          }
          return
        }
        const divergence = divergenceFromSaveResult(result, snapshot)
        if (!divergence) return
        host.setSaveStates(updateTabSaveState(
          host.getSaveStates(),
          tabId,
          applyDivergence(completeSave(currentState, operationId), divergence),
        ))
        resync()
      } catch (error) {
        resync()
        const cmd = toDocumentCommandError(error)
        if (cmd.code === "readFailed") {
          host.logReadFailed(error)
          host.setSaveStates(updateTabSaveState(
            host.getSaveStates(),
            tabId,
            completeSave(tabSaveState(host.getSaveStates(), tabId), operationId),
          ))
          return
        }
        if (!shouldReportPathError(cmd.code)) {
          host.setSaveStates(updateTabSaveState(
            host.getSaveStates(),
            tabId,
            completeSave(tabSaveState(host.getSaveStates(), tabId), operationId),
          ))
          return
        }
        host.setSaveStates(updateTabSaveState(
          host.getSaveStates(),
          tabId,
          failSave(
            tabSaveState(host.getSaveStates(), tabId),
            operationId,
            userFacingSaveError(cmd),
          ),
        ))
        host.onSaveFailed?.(tabId, cmd.code, userFacingSaveError(cmd))
      }
    })
  }
}

export function createSaveCopy(host: Pick<
  DocumentSaveHost,
  | "getTab"
  | "getContents"
  | "pickSavePath"
  | "readDocumentVersion"
  | "saveDocument"
  | "allowDocumentAssets"
  | "enqueue"
  | "reportStatus"
>) {
  return async function saveCopy(tabId: number): Promise<void> {
    const tab = host.getTab(tabId)
    if (!tab) return
    const pickedPath = await host.pickSavePath()
    if (!pickedPath) return

    const resolvedPath = sessionVersion(tab)?.resolvedPath ?? null
    if (resolvedPath !== null && resolvedPath === pickedPath) {
      host.reportStatus(SAVE_COPY_SAME_PATH_MESSAGE)
      return
    }

    const contents = host.getContents(tabId)
    await host.enqueue(tabId, async () => {
      let expected: ExpectedDocumentVersion
      try {
        const probe = await host.readDocumentVersion(pickedPath)
        expected = probe.kind === "existing"
          ? { kind: "existing", version: probe.version }
          : { kind: "missing" }
      } catch (error) {
        const cmd = toDocumentCommandError(error)
        host.reportStatus(userFacingSaveError(cmd))
        return
      }
      try {
        const result = await host.saveDocument(pickedPath, contents, expected)
        if (result.status === "saved") {
          await host.allowDocumentAssets(pickedPath)
          host.reportStatus(`Saved copy to ${pickedPath}`)
          return
        }
        host.reportStatus("Save copy failed")
      } catch (error) {
        const cmd = toDocumentCommandError(error)
        host.reportStatus(userFacingSaveError(cmd))
      }
    })
  }
}

export interface FileTabWatcherHost {
  readonly getWorkspace: () => Workspace
  readonly getContents: (tabId: number) => string
  readonly getSaveStates: () => SaveStateByTab
  readonly setSaveStates: (next: SaveStateByTab) => void
  readonly readDocumentVersion: (path: string) => Promise<ExpectedDocumentVersion>
  readonly readDocument: (path: string) => Promise<DiskSnapshot>
  readonly logReadFailed: (error: unknown) => void
}

export function createFileTabWatcher(host: FileTabWatcherHost): () => Promise<void> {
  return async () => {
    for (const tab of host.getWorkspace().tabs) {
      const path = sessionPath(tab)
      if (!path) continue
      const prior = tabSaveState(host.getSaveStates(), tab.id)
      const generation = prior.ioGeneration
      let probe: ExpectedDocumentVersion
      try {
        probe = await host.readDocumentVersion(path)
      } catch (error) {
        host.logReadFailed(error)
        continue
      }
      const intent = watcherIntent(tab, probe)
      if (intent.kind === "ignore") continue
      const contents = host.getContents(tab.id)
      const localSnapshot = contents
      if (intent.kind === "deleted") {
        const current = tabSaveState(host.getSaveStates(), tab.id)
        if (!isFreshObservation(current, generation)) continue
        host.setSaveStates(updateTabSaveState(
          host.getSaveStates(),
          tab.id,
          applyDivergence(current, { kind: "deletedExternally", localSnapshot }),
        ))
        continue
      }
      if (intent.kind === "pathChanged") {
        const current = tabSaveState(host.getSaveStates(), tab.id)
        if (!isFreshObservation(current, generation)) continue
        host.setSaveStates(updateTabSaveState(
          host.getSaveStates(),
          tab.id,
          applyDivergence(current, { kind: "pathChanged", localSnapshot }),
        ))
        continue
      }
      let disk: DiskSnapshot
      try {
        disk = await host.readDocument(path)
      } catch (error) {
        host.logReadFailed(error)
        continue
      }
      if (disk.kind !== "existing") continue
      const current = tabSaveState(host.getSaveStates(), tab.id)
      if (!isFreshObservation(current, generation)) continue
      const dirty = sessionDirty(tab, contents)
      host.setSaveStates(updateTabSaveState(
        host.getSaveStates(),
        tab.id,
        applyDivergence(
          current,
          divergenceFromSnapshot(disk, dirty, localSnapshot),
        ),
      ))
    }
  }
}

export function initialSaveStatesForTabs(tabs: readonly EditorSession[]): SaveStateByTab {
  const next: Record<number, DocumentSaveState> = {}
  for (const tab of tabs) {
    next[tab.id] = initialSaveState()
  }
  return next
}

export function tabHasConflict(state: DocumentSaveState | undefined): boolean {
  return state !== undefined && state.divergence.kind !== "none"
}
