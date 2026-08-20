import {
  errorMessage,
  type DocumentErrorCode,
  type ExistingDiskSnapshot,
} from "./desktopServices"
import { t } from "./i18n"
import type { ConflictActionId } from "./documentSaveCoordinator"
import type { DiskDivergence, DocumentSaveState } from "./documentSaveState"
import type { DesktopServices } from "./desktopServices"
import type { SaveMode } from "./documentSaveRunner"
import type { SaveTrigger } from "./normalizationCoordinator"
import { sessionPath, sessionVersion, type EditorSession } from "./session"

export const SAVE_COPY_SAME_PATH_MESSAGE = "Choose a different file for the copy."

export function diskSnapshotFromDivergence(
  divergence: DiskDivergence,
): ExistingDiskSnapshot | null {
  switch (divergence.kind) {
    case "contentConflict":
    case "externalChanged":
    case "createdAtMissingTarget":
      return divergence.disk
    default:
      return null
  }
}

export function canOpenDiff(divergence: DiskDivergence): boolean {
  return diskSnapshotFromDivergence(divergence) !== null
}

export interface ConflictActionDeps {
  readonly services: DesktopServices
  readonly getSession: (tabId: number) => EditorSession | null
  readonly getContents: (tabId: number) => string
  readonly isDirty: (tabId: number) => boolean
  readonly getSaveState: (tabId: number) => DocumentSaveState
  readonly saveFile: (
    tabId: number,
    trigger: SaveTrigger,
    mode?: SaveMode | boolean,
  ) => Promise<void>
  readonly saveCopy: (tabId: number) => Promise<void>
  readonly resetFromSnapshot: (tabId: number, snapshot: ExistingDiskSnapshot) => void
  readonly setDivergence: (
    tabId: number,
    divergence: Exclude<DiskDivergence, { kind: "none" }>,
  ) => void
  readonly clearDivergence: (tabId: number) => void
  readonly clearSaveFailed: (tabId: number) => void
  readonly openDiff: (tabId: number) => void
  readonly closeTab: (tabId: number) => void
  readonly reportStatus: (message: string) => void
  readonly clearRecoveryForTab: (tabId: number) => void
}

async function readExistingSnapshot(
  services: DesktopServices,
  path: string,
): Promise<ExistingDiskSnapshot | "missing" | "failed"> {
  try {
    const snapshot = await services.readDocument(path)
    return snapshot.kind === "existing" ? snapshot : "missing"
  } catch {
    return "failed"
  }
}

export function makeConflictActions(
  deps: ConflictActionDeps,
): Record<ConflictActionId, (tabId: number) => void | Promise<void>> {
  return {
    compare(tabId) {
      const divergence = deps.getSaveState(tabId).divergence
      if (!canOpenDiff(divergence)) return
      deps.openDiff(tabId)
    },

    saveCopy(tabId) {
      return deps.saveCopy(tabId)
    },

    async reloadDisk(tabId) {
      const session = deps.getSession(tabId)
      if (!session) return
      const path = sessionPath(session)
      if (!path) return
      if (deps.isDirty(tabId) && !deps.services.confirmDiscard()) return

      const snapshot = await readExistingSnapshot(deps.services, path)
      if (snapshot === "failed") return
      if (snapshot === "missing") {
        deps.setDivergence(tabId, {
          kind: "deletedExternally",
          localSnapshot: deps.getContents(tabId),
        })
        return
      }
      deps.resetFromSnapshot(tabId, snapshot)
      deps.clearDivergence(tabId)
      deps.clearRecoveryForTab(tabId)
    },

    async overwriteDisk(tabId) {
      const session = deps.getSession(tabId)
      const divergence = deps.getSaveState(tabId).divergence
      const diskSnap = diskSnapshotFromDivergence(divergence)
      if (!diskSnap || !session) return

      const baseline = sessionVersion(session)
      const live = await readExistingSnapshot(deps.services, diskSnap.requestedPath)
      if (live === "failed" || live === "missing") return

      let expectedVersion = diskSnap.version
      if (
        baseline !== null
        && live.version.fingerprint === baseline.fingerprint
        && live.version.fingerprint !== diskSnap.version.fingerprint
      ) {
        expectedVersion = live.version
        if (divergence.kind === "contentConflict") {
          deps.setDivergence(tabId, {
            kind: "contentConflict",
            localSnapshot: deps.getContents(tabId),
            disk: live,
          })
        } else if (divergence.kind === "externalChanged") {
          deps.setDivergence(tabId, {
            kind: "contentConflict",
            localSnapshot: deps.getContents(tabId),
            disk: live,
          })
        }
      }

      return deps.saveFile(tabId, "explicit", {
        kind: "overwrite",
        expected: { kind: "existing", version: expectedVersion },
      })
    },

    keepCurrent(tabId) {
      const divergence = deps.getSaveState(tabId).divergence
      if (divergence.kind !== "externalChanged") return
      deps.setDivergence(tabId, {
        kind: "contentConflict",
        localSnapshot: deps.getContents(tabId),
        disk: divergence.disk,
      })
    },

    recreateFile(tabId) {
      return deps.saveFile(tabId, "explicit", { kind: "recreate" })
    },

    closeDiscard(tabId) {
      const confirm = deps.services.confirmClose ?? deps.services.confirmDiscard
      if (!confirm()) return
      deps.clearRecoveryForTab(tabId)
      deps.closeTab(tabId)
    },

    async reopenPrevious(tabId) {
      const session = deps.getSession(tabId)
      if (!session) return
      const version = sessionVersion(session)
      if (!version) return
      if (deps.isDirty(tabId) && !deps.services.confirmDiscard()) return

      const snapshot = await readExistingSnapshot(deps.services, version.resolvedPath)
      if (snapshot === "failed" || snapshot === "missing") return
      deps.resetFromSnapshot(tabId, snapshot)
      deps.clearDivergence(tabId)
      deps.clearRecoveryForTab(tabId)
    },

    chooseAnotherPath(tabId) {
      return deps.saveFile(tabId, "explicit", true)
    },

    async retry(tabId) {
      deps.clearSaveFailed(tabId)
      await deps.saveFile(tabId, "explicit")
    },

    revealInFinder(tabId) {
      const session = deps.getSession(tabId)
      const path = session ? sessionPath(session) : null
      if (!path) return
      void deps.services.revealInFinder?.(path)?.catch(error => {
        deps.services.reportError(errorMessage(t("error.revealFailed"), error))
      })
    },

    cancel(tabId) {
      deps.clearDivergence(tabId)
    },
  }
}

export type SaveFailedCallback = (
  tabId: number,
  code: DocumentErrorCode,
  message: string,
) => void
