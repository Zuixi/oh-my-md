/**
 * The imperative document domain, as one composition unit: guarded saving and
 * its conflict binding, the open coordinator, file-tree actions, ordered-list
 * normalization, the command table, and the external-change watcher.
 *
 * These pieces are mutually recursive (an open must close tabs, a save must
 * reset views, the tree must open paths), so they are assembled together rather
 * than threaded through the shell. `App` receives the finished pieces and only
 * decides where they appear on screen.
 */
import {
  useMemo, useRef, type Dispatch, type MutableRefObject, type RefObject,
  type SetStateAction,
} from "react"
import type { Text } from "@codemirror/state"
import { errorMessage, type DesktopServices } from "./desktopServices"
import type { DocumentStore } from "./documentStore"
import type { EditorRegistry } from "./editorRegistry"
import type { DocumentViews } from "./documentViews"
import type { TabLifecycle } from "./appTabs"
import type { DocumentScaleRegistry } from "./documentScaleRegistry"
import type { RecoveryWriter } from "./recoveryWriter"
import type { AppTheme } from "./theme"
import { resolveTheme } from "./theme"
import type { UserSettings } from "./settings"
import { pageSetupFromSettings } from "./settings"
import type { EditorSession } from "./session"
import type { Workspace } from "./workspace"
import { baseName, openFolder } from "./workspace"
import type { FileTreeModel } from "./fileTreeState"
import type { TabSaveQueues } from "./documentSaveCoordinator"
import type { SaveStateByTab } from "./documentSaveState"
import type { NormalizationByTab } from "./normalizationState"
import { DURABILITY_WARNING } from "./documentSaveRunner"
import { createDocumentSaveAppBridge, snapshotAfterSave } from "./documentSaveAppBridge"
import { createDocumentOpen, type DocumentOpen } from "./documentOpen"
import { createFileTreeActions, type FileTreeActions } from "./fileTreeActions"
import { createNormalizationHandlers } from "./normalizationCoordinator"
import { useConflictSaveBinding } from "./conflictSaveBinding"
import { createPendingRecoveryCanceller, clearRecoveryRecord } from "./recoveryCleanup"
import { buildAppCommands } from "./appCommands"
import type { AppCommand } from "./commands"
import type { UpdateCoordinator } from "./updateCoordinator"
import type { FindReplaceHandle } from "./useFindReplace"
import { useFindReplace } from "./useFindReplace"
import { useWorkspaceSearch, type WorkspaceSearchState } from "./useWorkspaceSearch"
import { useSnapshotHistory } from "./useSnapshotHistory"

/** Workspace search debounce; the scan reads every Markdown file. */
const SEARCH_DEBOUNCE_MS = 200

export interface DocumentCoordinatorsHost {
  readonly services: DesktopServices
  readonly store: DocumentStore
  readonly registry: EditorRegistry
  readonly views: DocumentViews
  readonly tabs: TabLifecycle
  readonly documentScaleRegistry: DocumentScaleRegistry
  readonly recoveryWriter: RecoveryWriter
  readonly autosaveCancel: (tabId: number) => void
  readonly settings: UserSettings
  readonly theme: AppTheme
  readonly customCss: string
  readonly t: (key: string, params?: Record<string, string | number>) => string
  readonly isActiveSafeMode: () => boolean
  /** Workspace folder for the search panel. */
  readonly folder: string | null
  readonly updateCoordinatorRef: RefObject<UpdateCoordinator | null>
  readonly openCoordinatorRef: MutableRefObject<DocumentOpen | null>
  readonly saveFileRef: MutableRefObject<(
    tabId: number,
    trigger: import("./normalizationCoordinator").SaveTrigger,
    mode?: import("./documentSaveRunner").SaveMode | boolean,
  ) => Promise<void>>
  readonly saveCopyRef: MutableRefObject<(tabId: number) => Promise<void>>
  readonly requestCloseTabRef: MutableRefObject<(id: number) => void>
  readonly resetTabDocumentRef: MutableRefObject<(session: EditorSession, contents: string, docText?: Text) => boolean>
  readonly activateTabRef: MutableRefObject<(id: number) => void>
  readonly expandToPathRef: MutableRefObject<(path: string) => Promise<void>>
  readonly sessionRef: RefObject<EditorSession>
  readonly openingRef: MutableRefObject<boolean>
  readonly mountedRef: MutableRefObject<boolean>
  readonly tabSaveQueues: TabSaveQueues
  readonly operationSeq: MutableRefObject<number>
  readonly pollReadFailures: Map<number, string>
  readonly treeModelRef: MutableRefObject<FileTreeModel>
  /** Commits a fresh tree model to React state (App owns the ref + state pair). */
  readonly commitTree: (next: FileTreeModel) => void
  readonly treeErrorSignatures: Map<string, string>
  readonly treePollInFlight: MutableRefObject<boolean>
  readonly pendingListDirs: Set<string>
  readonly pendingFocusRef: MutableRefObject<boolean>
  readonly tabById: (id: number) => EditorSession | undefined
  readonly commitWorkspace: (next: Workspace) => void
  readonly commitNormalization: (next: NormalizationByTab) => void
  readonly commitSaveState: (next: SaveStateByTab) => void
  readonly revealFolder: (path: string) => void
  readonly rememberRecent: (path: string) => void
  readonly reportUserError: (message: string) => void
  readonly showTransientStatus: (message: string) => void
  readonly setConflictFocusToken: (update: (token: number) => number) => void
  readonly onSkippedMarkers: () => void
  readonly setTheme: Dispatch<SetStateAction<AppTheme>>
  readonly setCustomCss: Dispatch<SetStateAction<string>>
  readonly setFocusMode: Dispatch<SetStateAction<boolean>>
  readonly setSettingsOpen: Dispatch<SetStateAction<boolean>>
  readonly setSidebarOpen: Dispatch<SetStateAction<boolean>>
  readonly setOutlineOpen: Dispatch<SetStateAction<boolean>>
  readonly setTypewriter: Dispatch<SetStateAction<boolean>>
  readonly setAboutOpen: Dispatch<SetStateAction<boolean>>
  readonly setOpeningLabel: (label: string | null) => void
  readonly setOpeningProgress: (progress: { bytesRead: number; byteLength: number } | null) => void
  readonly setQuickOpenState: (state: import("./documentOpen").QuickOpenState) => void
  readonly clearRecents: () => void
}

export interface DocumentCoordinators {
  readonly conflictSave: ReturnType<typeof useConflictSaveBinding>
  readonly saveFile: (
    tabId: number,
    trigger: import("./normalizationCoordinator").SaveTrigger,
    mode?: import("./documentSaveRunner").SaveMode | boolean,
  ) => Promise<void>
  readonly saveCopy: (tabId: number) => Promise<void>
  readonly pollFileTabs: () => Promise<void>
  readonly openCoordinator: DocumentOpen
  readonly treeActions: FileTreeActions
  readonly commands: AppCommand[]
  readonly acceptNormalization: () => void
  readonly keepOriginalNumbers: () => void
  readonly openRecent: (path: string) => Promise<void>
  readonly search: WorkspaceSearchState
  readonly findReplace: FindReplaceHandle
  readonly history: ReturnType<typeof useSnapshotHistory>
  readonly openFile: () => Promise<void>
  readonly chooseFolder: () => Promise<void>
  readonly commandsRef: RefObject<AppCommand[]>
}

export function useDocumentCoordinators(
  host: DocumentCoordinatorsHost,
): DocumentCoordinators {
  const {
    services, store, registry, views, tabs, recoveryWriter, documentScaleRegistry,
    tabSaveQueues, tabById,
  } = host

  const search = useWorkspaceSearch({
    folder: host.folder,
    search: services.searchMarkdown,
    reportError: error => services.reportError(errorMessage(host.t("error.searchFailed"), error)),
    debounceMs: SEARCH_DEBOUNCE_MS,
  })
  const findReplace = useFindReplace({
    getView: () => registry.getActiveView(),
    getDoc: () => store.getTabDoc(store.getWorkspace().activeId),
    isActiveSafeMode: host.isActiveSafeMode,
  })
  const history = useSnapshotHistory({
    services,
    store,
    t: host.t,
    newTab: tabs.newTab,
    restoreTabContents: (tabId, contents) => {
      const tab = tabById(tabId)
      if (!tab) return false
      return host.resetTabDocumentRef.current(tab, contents)
    },
    activateTab: tabs.activateTab,
    showTransientStatus: host.showTransientStatus,
    isMounted: () => host.mountedRef.current,
  })

  const flushedContents = (tabId: number): string => {
    if (views.materializer.hasPending(tabId)) views.materializer.flush()
    return store.getTabDoc(tabId)
  }

  const conflictSave = useConflictSaveBinding({
    services,
    getTab: tabById,
    getContents: flushedContents,
    getSaveStates: () => store.getSaveStateByTab(),
    commitSaveState: host.commitSaveState,
    saveFile: (...args) => host.saveFileRef.current(...args),
    saveCopy: tabId => host.saveCopyRef.current(tabId),
    resetTabDocument: (session, contents) => host.resetTabDocumentRef.current(session, contents),
    requestCloseTab: id => host.requestCloseTabRef.current(id),
    showTransientStatus: host.showTransientStatus,
  })

  const { saveFile, saveCopy, pollFileTabs } = createDocumentSaveAppBridge({
    services,
    pollReadFailures: host.pollReadFailures,
    tabSaveQueues,
    operationSeq: host.operationSeq,
    isOpening: () => host.openingRef.current,
    getTab: tabById,
    getView: tabId => registry.getView(tabId),
    getContents: flushedContents,
    getNormalization: () => store.getNormalizationByTab(),
    setNormalization: host.commitNormalization,
    getWorkspace: () => store.getWorkspace(),
    setWorkspace: host.commitWorkspace,
    getViews: () => registry.views(),
    getSaveStates: () => store.getSaveStateByTab(),
    setSaveStates: host.commitSaveState,
    revealFolder: host.revealFolder,
    rememberRecent: host.rememberRecent,
    onSaved: path => { snapshotAfterSave(services, path) },
    onSavedAs: path => {
      services.notifySuccess?.(host.t("notify.saveAsCompleted", { name: baseName(path) }))
    },
    syncDoc: views.syncDoc,
    clearRecovery: key => { void clearRecoveryRecord(services, key) },
    cancelPendingRecovery: createPendingRecoveryCanceller({
      forget: tabId => recoveryWriter.forget(tabId), save: views.saveRecovery,
      load: tabId => [tabById(tabId), store.getTabDoc(tabId)],
    }),
    onDurabilityWarning: () => host.showTransientStatus(host.t(DURABILITY_WARNING)),
    incrementFocusToken: () => host.setConflictFocusToken(token => token + 1),
    reportStatus: host.showTransientStatus,
    onSaveFailed: conflictSave.onSaveFailed,
  })

  const saveFileTracked = useMemo(() => {
    return async (
      tabId: number,
      trigger: import("./normalizationCoordinator").SaveTrigger,
      mode?: import("./documentSaveRunner").SaveMode | boolean,
    ): Promise<void> => {
      try {
        await saveFile(tabId, trigger, mode)
      } finally {
        // A successful save makes a pending autosave redundant; any remaining
        // edit re-arms it through materialization.
        if (!store.isTabDirty(tabId)) host.autosaveCancel(tabId)
      }
    }
  }, [saveFile, store, host.autosaveCancel])
  host.saveFileRef.current = saveFileTracked
  host.saveCopyRef.current = saveCopy

  if (!host.openCoordinatorRef.current) {
    host.openCoordinatorRef.current = createDocumentOpen({
      services,
      documentScaleRegistry,
      tabSaveQueues,
      getWorkspace: () => store.getWorkspace(),
      commitWorkspace: host.commitWorkspace,
      getActiveSession: () => store.getActiveSession(),
      getDoc: () => store.getTabDoc(store.getWorkspace().activeId),
      getContents: tabId => store.getTabDoc(tabId),
      setContents: (tabId, contents) => store.setTabDoc(tabId, contents),
      getSaveStates: () => store.getSaveStateByTab(),
      commitSaveState: host.commitSaveState,
      activateTab: id => { host.activateTabRef.current(id) },
      resetTabDocument: (session, contents, docText) =>
        host.resetTabDocumentRef.current(session, contents, docText),
      flushMaterializer: () => { views.materializer.flush() },
      syncDoc: views.syncDoc,
      revealFolder: host.revealFolder,
      rememberRecent: host.rememberRecent,
      expandToPath: path => host.expandToPathRef.current(path),
      reportStatus: host.showTransientStatus,
      reportUserError: host.reportUserError,
      setOpening: open => { host.openingRef.current = open },
      setOpeningLabel: host.setOpeningLabel,
      setOpeningProgress: host.setOpeningProgress,
      setQuickOpenState: host.setQuickOpenState,
      isMounted: () => host.mountedRef.current,
    })
  }
  const openCoordinator = host.openCoordinatorRef.current

  const treeActions = createFileTreeActions({
    services,
    getTreeModel: () => host.treeModelRef.current,
    commitTree: host.commitTree,
    getWorkspace: () => store.getWorkspace(),
    commitWorkspace: host.commitWorkspace,
    getContents: tabId => store.getTabDoc(tabId),
    flushMaterializer: () => views.materializer.flush(),
    isOpenInFlight: path => openCoordinator.isOpenInFlight(path),
    invalidateOpen: path => { openCoordinator.invalidateOpen(path) },
    closeTab: tabs.closeTabInternal,
    recoveryWriter,
    notifySuccess: message => { services.notifySuccess?.(message) },
    reportError: message => { services.reportError(message) },
    reportUserError: host.reportUserError,
    t: host.t,
    confirmDiscard: () => services.confirmDiscard(),
    confirmClose: () => services.confirmClose?.(),
    confirmDelete: path => services.confirmDelete?.(path),
    isMounted: () => host.mountedRef.current,
    setPendingFocus: () => { host.pendingFocusRef.current = true },
    openPath: (path, inNewTab) => openCoordinator.openPath(path, inNewTab),
    treeErrorSignatures: host.treeErrorSignatures,
    treePollInFlight: host.treePollInFlight,
    pendingListDirs: host.pendingListDirs,
  })

  const { accept: acceptNormalization, reject: keepOriginalNumbers } = createNormalizationHandlers({
    getActiveTabId: () => store.getWorkspace().activeId,
    getTab: tabById,
    getView: tabId => registry.getView(tabId),
    getNormalization: () => store.getNormalizationByTab(),
    setNormalization: host.commitNormalization,
    getWorkspace: () => store.getWorkspace(),
    getViews: () => registry.views(),
    saveExplicit: tabId => { void saveFileTracked(tabId, "explicit") },
    onSkippedMarkers: host.onSkippedMarkers,
  })

  const openRecent = (path: string) => openCoordinator.runOpen(async () => path)
  const openFile = () => openCoordinator.runOpen(() => services.pickOpenPath())
  const chooseFolder = async (): Promise<void> => {
    const folder = await services.pickFolder?.()
    if (!folder) return
    await services.allowWorkspaceDir?.(folder)
    host.commitWorkspace(openFolder(store.getWorkspace(), folder))
  }

  const commands = buildAppCommands({
    services,
    t: host.t,
    getView: () => registry.getActiveView(),
    getSession: () => host.sessionRef.current,
    getWorkspace: () => store.getWorkspace(),
    tabById,
    openFile,
    saveFile: saveFileTracked,
    newTab: tabs.newTab,
    chooseFolder,
    openCoordinator,
    findReplace,
    search,
    requestCloseTab: tabs.requestCloseTab,
    clearRecents: host.clearRecents,
    openVersionHistory: history.open,
    setTheme: host.setTheme,
    setCustomCss: host.setCustomCss,
    setFocusMode: host.setFocusMode,
    setSettingsOpen: host.setSettingsOpen,
    setSidebarOpen: host.setSidebarOpen,
    setOutlineOpen: host.setOutlineOpen,
    setTypewriter: host.setTypewriter,
    setAboutOpen: host.setAboutOpen,
    customCss: host.customCss,
    exportOptions: () => ({
      width: host.settings.exportWidth,
      scale: host.settings.exportScale,
      theme: resolveTheme(host.theme),
      page: pageSetupFromSettings(host.settings),
    }),
    showTransientStatus: host.showTransientStatus,
    updateCoordinatorRef: host.updateCoordinatorRef,
    pasteOptions: views.pasteOptions,
    imageInsertOptions: views.imageInsertOptions,
    documentScaleRegistry,
  })
  const commandsRef = useRef(commands)
  commandsRef.current = commands

  return {
    conflictSave,
    saveFile: saveFileTracked,
    saveCopy,
    pollFileTabs,
    openCoordinator,
    treeActions,
    commands,
    acceptNormalization,
    keepOriginalNumbers,
    openRecent,
    openFile,
    chooseFolder,
    commandsRef,
    search,
    findReplace,
    history,
  }
}
