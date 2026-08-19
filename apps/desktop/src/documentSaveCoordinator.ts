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
  readonly messageKey: string
  readonly actions: readonly ConflictActionId[]
}

export type TopBannerKind = "conflict" | "saveFailed" | "normalization"

export const CONFLICT_ACTION_LABELS: Readonly<Record<ConflictActionId, string>> = {
  compare: "conflict.action.compare",
  saveCopy: "conflict.action.saveCopy",
  reloadDisk: "conflict.action.reloadDisk",
  overwriteDisk: "conflict.action.overwriteDisk",
  keepCurrent: "conflict.action.keepCurrent",
  recreateFile: "conflict.action.recreateFile",
  closeDiscard: "conflict.action.closeDiscard",
  reopenPrevious: "conflict.action.reopenPrevious",
  chooseAnotherPath: "conflict.action.chooseAnotherPath",
  retry: "conflict.action.retry",
  revealInFinder: "conflict.action.revealInFinder",
  cancel: "conflict.action.cancel",
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
  // 惰性 tab 没有磁盘基线；saveFile 已在入口拦截，这里按「无基线」处理，
  // 即便到达也不会盲目覆盖未知磁盘内容（CreatedConflict 兜底）。
  if (session.persistence.kind === "untitled" || session.persistence.kind === "lazyFile") {
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
        messageKey: "conflict.msg.contentConflict",
        actions: ["compare", "saveCopy", "reloadDisk", "overwriteDisk"],
      }
    case "externalChanged":
      return {
        messageKey: "conflict.msg.externalChanged",
        actions: ["compare", "reloadDisk", "keepCurrent"],
      }
    case "deletedExternally":
      return {
        messageKey: "conflict.msg.deletedExternally",
        actions: ["recreateFile", "saveCopy", "closeDiscard"],
      }
    case "createdAtMissingTarget":
      return {
        messageKey: "conflict.msg.createdAtMissingTarget",
        actions: ["compare", "chooseAnotherPath"],
      }
    case "pathChanged":
      return {
        messageKey: "conflict.msg.pathChanged",
        actions: ["saveCopy", "reopenPrevious", "closeDiscard"],
      }
    case "unexpectedSymlinkAtTarget":
      return {
        messageKey: "conflict.msg.unexpectedSymlinkAtTarget",
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
  return { messageKey: saveState.lifecycle.message, actions }
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