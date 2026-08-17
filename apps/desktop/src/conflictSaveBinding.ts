import { useRef, useState } from "react"
import type { DocumentErrorCode } from "./desktopServices"
import { makeConflictActions } from "./conflictActions"
import type { ConflictActionId } from "./documentSaveCoordinator"
import {
  applyDivergence,
  clearDivergence,
  clearSaveFailed,
  tabSaveState,
  updateTabSaveState,
  type DocumentSaveState,
  type SaveStateByTab,
} from "./documentSaveState"
import type { SaveMode } from "./documentSaveRunner"
import type { SaveTrigger } from "./normalizationCoordinator"
import { openSession, recoveryKey, sessionDirty, type EditorSession } from "./session"

export interface ConflictSaveBindingHost {
  readonly services: import("./desktopServices").DesktopServices
  readonly getTab: (tabId: number) => EditorSession | undefined
  readonly getContents: (tabId: number) => string
  readonly getSaveStates: () => SaveStateByTab
  readonly commitSaveState: (next: SaveStateByTab) => void
  readonly saveFile: (tabId: number, trigger: SaveTrigger, mode?: SaveMode | boolean) => Promise<void>
  readonly saveCopy: (tabId: number) => Promise<void>
  readonly resetTabDocument: (session: EditorSession, contents: string) => boolean
  readonly requestCloseTab: (tabId: number) => void
  readonly showTransientStatus: (message: string) => void
}

export function useConflictSaveBinding(host: ConflictSaveBindingHost) {
  const [diffOpenTabId, setDiffOpenTabId] = useState<number | null>(null)
  const [diffRefreshed, setDiffRefreshed] = useState(false)
  const [saveErrorCodeByTab, setSaveErrorCodeByTab] = useState<
    Record<number, DocumentErrorCode | undefined>
  >({})

  const hostRef = useRef(host)
  hostRef.current = host

  const conflictActionsRef = useRef(
    makeConflictActions({
      services: host.services,
      getSession: tabId => hostRef.current.getTab(tabId) ?? null,
      getContents: tabId => hostRef.current.getContents(tabId),
      isDirty: tabId => {
        const tab = hostRef.current.getTab(tabId)
        if (!tab) return false
        return sessionDirty(tab, hostRef.current.getContents(tabId))
      },
      getSaveState: tabId => tabSaveState(hostRef.current.getSaveStates(), tabId),
      saveFile: (...args) => hostRef.current.saveFile(...args),
      saveCopy: tabId => hostRef.current.saveCopy(tabId),
      resetFromSnapshot: (tabId, snapshot) => {
        const tab = hostRef.current.getTab(tabId)
        if (!tab) return
        hostRef.current.resetTabDocument(openSession(tab, snapshot), snapshot.contents)
      },
      setDivergence: (tabId, divergence) => {
        hostRef.current.commitSaveState(updateTabSaveState(
          hostRef.current.getSaveStates(),
          tabId,
          applyDivergence(tabSaveState(hostRef.current.getSaveStates(), tabId), divergence),
        ))
      },
      clearDivergence: tabId => {
        hostRef.current.commitSaveState(updateTabSaveState(
          hostRef.current.getSaveStates(),
          tabId,
          clearDivergence(tabSaveState(hostRef.current.getSaveStates(), tabId)),
        ))
      },
      clearSaveFailed: tabId => {
        hostRef.current.commitSaveState(updateTabSaveState(
          hostRef.current.getSaveStates(),
          tabId,
          clearSaveFailed(tabSaveState(hostRef.current.getSaveStates(), tabId)),
        ))
      },
      openDiff: tabId => {
        setDiffOpenTabId(tabId)
        setDiffRefreshed(false)
      },
      closeTab: tabId => hostRef.current.requestCloseTab(tabId),
      reportStatus: message => hostRef.current.showTransientStatus(message),
      clearRecoveryForTab: tabId => {
        const tab = hostRef.current.getTab(tabId)
        if (!tab) return
        void hostRef.current.services.clearRecovery?.(recoveryKey(tab))
      },
    }),
  )

  return {
    diffOpenTabId,
    diffRefreshed,
    onConflictAction: (action: ConflictActionId, tabId: number) => {
      void conflictActionsRef.current[action](tabId)
    },
    onSaveFailed: (tabId: number, code: DocumentErrorCode) => {
      setSaveErrorCodeByTab(previous => ({ ...previous, [tabId]: code }))
    },
    saveErrorCodeFor: (state: DocumentSaveState, tabId: number) =>
      state.lifecycle.kind === "saveFailed" ? saveErrorCodeByTab[tabId] : undefined,
    handleDiskFingerprintChange: (_fingerprint: string) => {
      setDiffRefreshed(true)
    },
    closeDiff: () => setDiffOpenTabId(null),
  }
}
