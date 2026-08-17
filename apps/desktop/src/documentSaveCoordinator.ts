import type { EditorView } from "@codemirror/view"
import type { NormalizationId } from "@omd/engine"
import type {
  DocumentErrorCode,
  ExpectedDocumentVersion,
  ExistingDiskSnapshot,
  SaveDocumentResult,
} from "./desktopServices"
import {
  type DiskDivergence,
  type DocumentSaveState,
} from "./documentSaveState"
import { canAutosaveTab } from "./normalizationCoordinator"
import type { NormalizationByTab } from "./normalizationState"
import { sessionVersion, type EditorSession } from "./session"
import type { Workspace } from "./workspace"

export type ConflictActionId =
  | "compare"
  | "saveCopy"
  | "reloadDisk"
  | "overwriteDisk"
  | "keepCurrent"
  | "recreateFile"
  | "closeDiscard"
  | "reopenPrevious"
  | "chooseAnotherPath"
  | "retry"
  | "revealInFinder"
  | "cancel"

export interface SaveOperationCapture {
  readonly tabId: number
  readonly documentId: number
  readonly view: EditorView
  readonly operationId: number
  readonly normalizationId: NormalizationId | null
}

export interface CanAutosaveInput {
  readonly tabId: number
  readonly dirty: boolean
  readonly hasPath: boolean
  readonly normalization: NormalizationByTab
  readonly saveState: DocumentSaveState
}

export type WatcherIntent =
  | { readonly kind: "ignore" }
  | { readonly kind: "deleted" }
  | { readonly kind: "pathChanged" }
  | { readonly kind: "fetchContents" }

export interface ConflictBannerModel {
  readonly message: string
  readonly actions: readonly ConflictActionId[]
}

export type TopBannerKind = "conflict" | "saveFailed" | "normalization"

export const CONFLICT_ACTION_LABELS: Readonly<Record<ConflictActionId, string>> = {
  compare: "Compare",
  saveCopy: "Save copy",
  reloadDisk: "Reload disk",
  overwriteDisk: "Overwrite disk",
  keepCurrent: "Keep current",
  recreateFile: "Recreate file",
  closeDiscard: "Close and discard",
  reopenPrevious: "Reopen previous file",
  chooseAnotherPath: "Choose another path",
  retry: "Retry",
  revealInFinder: "Reveal in Finder",
  cancel: "Cancel",
}

export function allocateOperationId(seq: { current: number }): number {
  seq.current += 1
  return seq.current
}

export type TabSaveQueues = Map<number, Promise<void>>

export function createTabSaveEnqueuer(
  queues: TabSaveQueues,
): (tabId: number, work: () => Promise<void>) => Promise<void> {
  return async (tabId, work) => {
    const previous = queues.get(tabId) ?? Promise.resolve()
    const operation = previous.catch(() => undefined).then(work)
    queues.set(tabId, operation)
    await operation
  }
}

export function canAutosave(input: CanAutosaveInput): boolean {
  if (!input.dirty || !input.hasPath) return false
  if (!canAutosaveTab(input.tabId, input.normalization)) return false
  if (input.saveState.lifecycle.kind !== "idle") return false
  if (input.saveState.divergence.kind !== "none") return false
  return true
}

export function isCurrentSaveTarget(
  capture: SaveOperationCapture,
  workspace: Workspace,
  views: ReadonlyMap<number, EditorView>,
): boolean {
  const tab = workspace.tabs.find(item => item.id === capture.tabId)
  if (!tab || tab.documentId !== capture.documentId) return false
  return views.get(capture.tabId) === capture.view
}

export function expectedVersionFor(session: EditorSession): ExpectedDocumentVersion {
  if (session.persistence.kind === "untitled") {
    return { kind: "missing" }
  }
  return { kind: "existing", version: session.persistence.version }
}

export function watcherIntent(
  session: EditorSession,
  probe: ExpectedDocumentVersion,
): WatcherIntent {
  if (probe.kind === "missing") {
    return { kind: "deleted" }
  }
  const version = sessionVersion(session)
  if (!version) {
    return { kind: "ignore" }
  }
  if (probe.version.resolvedPath !== version.resolvedPath) {
    return { kind: "pathChanged" }
  }
  if (probe.version.fingerprint === version.fingerprint) {
    return { kind: "ignore" }
  }
  return { kind: "fetchContents" }
}

export function divergenceFromSnapshot(
  disk: ExistingDiskSnapshot,
  dirty: boolean,
  localSnapshot: string,
): Exclude<DiskDivergence, { kind: "none" }> {
  if (dirty) {
    return { kind: "contentConflict", localSnapshot, disk }
  }
  return { kind: "externalChanged", disk }
}

export function divergenceFromSaveResult(
  result: SaveDocumentResult,
  localSnapshot: string,
): Exclude<DiskDivergence, { kind: "none" }> | null {
  switch (result.status) {
    case "saved":
      return null
    case "contentConflict":
      return { kind: "contentConflict", localSnapshot, disk: result.disk }
    case "createdConflict":
      return { kind: "createdAtMissingTarget", localSnapshot, disk: result.disk }
    case "deletedConflict":
      return { kind: "deletedExternally", localSnapshot }
    case "pathChangedConflict":
      return { kind: "pathChanged", localSnapshot }
    case "unexpectedSymlinkConflict":
      return { kind: "unexpectedSymlinkAtTarget", localSnapshot }
  }
}

function divergenceBanner(
  divergence: Exclude<DiskDivergence, { kind: "none" }>,
): ConflictBannerModel {
  switch (divergence.kind) {
    case "contentConflict":
      return {
        message: "The file changed on disk while you were editing.",
        actions: ["compare", "saveCopy", "reloadDisk", "overwriteDisk"],
      }
    case "externalChanged":
      return {
        message: "The file was updated on disk.",
        actions: ["compare", "reloadDisk", "keepCurrent"],
      }
    case "deletedExternally":
      return {
        message: "The file was deleted on disk.",
        actions: ["recreateFile", "saveCopy", "closeDiscard"],
      }
    case "createdAtMissingTarget":
      return {
        message: "Another file was created at this path.",
        actions: ["compare", "chooseAnotherPath"],
      }
    case "pathChanged":
      return {
        message: "The file path changed on disk.",
        actions: ["saveCopy", "reopenPrevious", "closeDiscard"],
      }
    case "unexpectedSymlinkAtTarget":
      return {
        message: "A symlink appeared at the save target.",
        actions: ["chooseAnotherPath", "cancel"],
      }
  }
}

export function conflictBannerModel(
  saveState: DocumentSaveState,
  errorCode?: DocumentErrorCode,
): ConflictBannerModel | null {
  if (saveState.divergence.kind !== "none") {
    return divergenceBanner(saveState.divergence)
  }
  if (saveState.lifecycle.kind !== "saveFailed") {
    return null
  }
  const actions: ConflictActionId[] = ["retry", "saveCopy"]
  if (errorCode === "permissionDenied") {
    actions.push("revealInFinder")
  }
  return { message: saveState.lifecycle.message, actions }
}

function isConflictDivergence(divergence: DiskDivergence): boolean {
  return divergence.kind !== "none"
}

export function topBanner(
  saveState: DocumentSaveState,
  hasNormalizationReview: boolean,
): TopBannerKind | null {
  if (isConflictDivergence(saveState.divergence)) {
    return "conflict"
  }
  if (saveState.lifecycle.kind === "saveFailed") {
    return "saveFailed"
  }
  if (hasNormalizationReview) {
    return "normalization"
  }
  return null
}
