import type { EditorView } from "@codemirror/view"
import type { DesktopServices } from "./desktopServices"
import {
  createTabSaveEnqueuer,
  type TabSaveQueues,
} from "./documentSaveCoordinator"
import {
  createFileTabWatcher,
  createGuardedDocumentSaver,
  createSaveCopy,
  type DocumentSaveHost,
} from "./documentSaveRunner"
import type { SaveStateByTab } from "./documentSaveState"
import type { NormalizationByTab } from "./normalizationState"
import type { EditorSession } from "./session"
import type { Workspace } from "./workspace"

export interface DocumentSaveAppBridge {
  readonly saveFile: ReturnType<typeof createGuardedDocumentSaver>
  readonly saveCopy: ReturnType<typeof createSaveCopy>
  readonly pollFileTabs: () => Promise<void>
}

export function createDocumentSaveAppBridge(deps: {
  readonly services: DesktopServices
  readonly tabSaveQueues: TabSaveQueues
  readonly operationSeq: { current: number }
  readonly isOpening: () => boolean
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
  readonly revealFolder: (path: string) => void
  readonly rememberRecent: (path: string) => void
  readonly onSaved?: (path: string) => void
  readonly syncDoc: (doc: string, tabId: number) => void
  readonly clearRecovery: (key: string) => void
  readonly onDurabilityWarning: () => void
  readonly incrementFocusToken: () => void
  readonly reportStatus: (message: string) => void
  readonly onSaveFailed?: (
    tabId: number,
    code: import("./desktopServices").DocumentErrorCode,
    message: string,
  ) => void
}): DocumentSaveAppBridge {
  const enqueue = createTabSaveEnqueuer(deps.tabSaveQueues)
  const saveHost: DocumentSaveHost = {
    isOpening: deps.isOpening,
    getTab: deps.getTab,
    getView: deps.getView,
    getContents: deps.getContents,
    getNormalization: deps.getNormalization,
    setNormalization: deps.setNormalization,
    getWorkspace: deps.getWorkspace,
    setWorkspace: deps.setWorkspace,
    getViews: deps.getViews,
    getSaveStates: deps.getSaveStates,
    setSaveStates: deps.setSaveStates,
    pickSavePath: () => deps.services.pickSavePath(),
    saveDocument: (path, contents, expected) =>
      deps.services.saveDocument(path, contents, expected),
    readDocument: path => deps.services.readDocument(path),
    readDocumentVersion: path => deps.services.readDocumentVersion(path),
    allowDocumentAssets: path => deps.services.allowDocumentAssets(path),
    revealFolder: deps.revealFolder,
    rememberRecent: deps.rememberRecent,
    onSaved: deps.onSaved,
    syncDoc: deps.syncDoc,
    clearRecovery: deps.clearRecovery,
    operationSeq: deps.operationSeq,
    enqueue,
    onDurabilityWarning: deps.onDurabilityWarning,
    incrementFocusToken: deps.incrementFocusToken,
    logReadFailed: error => { console.error(error) },
    reportStatus: deps.reportStatus,
    onSaveFailed: deps.onSaveFailed,
  }
  const saveFile = createGuardedDocumentSaver(saveHost)
  const saveCopy = createSaveCopy(saveHost)
  const pollFileTabs = createFileTabWatcher({
    getWorkspace: deps.getWorkspace,
    getContents: deps.getContents,
    getSaveStates: deps.getSaveStates,
    setSaveStates: deps.setSaveStates,
    readDocumentVersion: path => deps.services.readDocumentVersion(path),
    readDocument: path => deps.services.readDocument(path),
    logReadFailed: error => { console.error(error) },
  })
  return { saveFile, saveCopy, pollFileTabs }
}
