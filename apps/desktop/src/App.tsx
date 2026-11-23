import { useEffect, useMemo, useRef, useState } from "react"
import { createEditorStatusStore } from "./editorStatusStore"
import { useAppChrome } from "./useAppChrome"
import { createDocumentScaleRegistry } from "./documentScaleRegistry"
import { createEditorScalePolicyApplier } from "./editorScalePolicy"
import {
  createDocumentStore, useDirtyTabIds, useNormalizationByTab, useSaveStateByTab, useWorkspace,
} from "./documentStore"
import { createEditorRegistry } from "./editorRegistry"
import { createOutlineController } from "./outlineController"
import { createDocumentViews } from "./documentViews"
import { createTabLifecycle } from "./appTabs"
import { createAutosaveScheduler } from "./autosaveScheduler"
import { sessionPath, type EditorSession } from "./session"
import { createRecoveryAdopter } from "./recoveryAdoption"
import { createRecoveryWriter } from "./recoveryWriter"
import { activeSession, ensureFolder, type Workspace } from "./workspace"
import type { DocumentOpen } from "./documentOpen"
import { restartToApplyLogging } from "./appLoggingActions"
import { useDocumentCoordinators } from "./useDocumentCoordinators"
import { topBanner, type TabSaveQueues } from "./documentSaveCoordinator"
import type { NormalizationByTab } from "./normalizationState"
import { saveStatusLabel, tabHasConflict } from "./documentSaveRunner"
import { tabSaveState, type SaveStateByTab } from "./documentSaveState"
import type { UpdateCoordinator, UpdateFailureKind } from "./updateCoordinator"
import { createTauriUpdateAdapter, type UpdateAdapter } from "./updateAdapter"
import { runMenuCommand } from "./commands"
import { isMacOS } from "./platform"
import { AppMenu } from "./AppMenu"
import { defaultServices, errorMessage, type DesktopServices } from "./desktopServices"
import { logUpdateStartupFailure } from "./logging"
import { reportSaveStateTransitions } from "./saveDiagnostics"
import { rememberPath } from "./recents"
import type { Text } from "@codemirror/state"
import { useWorkspaceWatcher } from "./useWorkspaceWatcher"
import { useGlobalShortcuts } from "./useGlobalShortcuts"
import { useDocumentAppearance, useShellEffects } from "./useShellEffects"
import { useAppLifecycleEffects } from "./useAppLifecycleEffects"
import { AppSidebar } from "./AppSidebar"
import { AppOutlinePanel } from "./AppOutlinePanel"
import { AppCanvas } from "./AppCanvas"
import { AppOverlays } from "./AppOverlays"
import { AppStatusBar } from "./AppStatusBar"
import { TopBar } from "./TopBar"
import { emptyFileTree, visibleRows, type FileTreeModel } from "./fileTreeState"
import { clampSidebarWidth, writeSidebarWidth } from "./sidebarResize"
import { useT } from "./i18n"
import { SAFE_MODE_BYTES, SAFE_MODE_LINES, SIDEBAR_DEFAULT_WIDTH } from "./constants"
import "./styles.css"

export type { DesktopServices, RecoveryRecord } from "./desktopServices"

interface AppProps {
  services?: DesktopServices
  autosaveMs?: number
  watchMs?: number
  /** Pull-based materialization trailing window; 0 = synchronous (test-only). */
  docMaterializeMs?: number
  /** Automatic-update adapter; tests inject a fake, production the Tauri one. */
  updateAdapter?: UpdateAdapter
  /** Startup-check failure log sink; tests inject a spy. */
  logUpdateFailure?: (failure: UpdateFailureKind) => void
}

const DOC_MATERIALIZE_MS = 250

export default function App(props: AppProps) {
  const {
    services = defaultServices,
    autosaveMs = 1500,
    // Fallback poll only: native notify events drive day-to-day refreshes.
    watchMs = 30000,
    docMaterializeMs = DOC_MATERIALIZE_MS,
    updateAdapter = createTauriUpdateAdapter(),
    logUpdateFailure = logUpdateStartupFailure,
  } = props
  const t = useT()

  // ---- per-mount state owners -------------------------------------------
  const [editorStatusStore] = useState(createEditorStatusStore)
  // Document state lives outside React: a materialized keystroke no longer
  // re-renders the shell, only the narrow subscribers below.
  const [store] = useState(createDocumentStore)
  const [registry] = useState(createEditorRegistry)
  const [documentScaleRegistry] = useState(() => createDocumentScaleRegistry({
    safeModeLines: SAFE_MODE_LINES,
    safeModeBytes: SAFE_MODE_BYTES,
  }))
  const [outlineController] = useState(() => createOutlineController({
    store, registry, documentScaleRegistry,
  }))
  const [recoveryWriter] = useState(createRecoveryWriter)

  const workspace = useWorkspace(store)
  const dirtyIds = useDirtyTabIds(store)
  const saveStateByTab = useSaveStateByTab(store)
  const normalizationByTab = useNormalizationByTab(store)
  const sessionRef = useRef<EditorSession>(store.getActiveSession())
  const session = sessionRef.current
  const activeFilePath = sessionPath(session)

  // ---- UI state ----------------------------------------------------------
  const chrome = useAppChrome({ services, registry })
  const {
    transientStatus, setTransientStatus, showTransientStatus, updateState, setUpdateState,
    openingRef, mountedRef, settings, setSettings, settingsRef, settingsSaveRef,
    logState, handleSaveSettings,
    settingsOpen, setSettingsOpen, aboutOpen, setAboutOpen,
    theme, setTheme, themeSyncReady, setThemeSyncReady, customCss, setCustomCss,
    focusMode, setFocusMode, sidebarOpen, setSidebarOpen, sidebarWidth, setSidebarWidth,
    outlineOpen, setOutlineOpen, typewriter, setTypewriter, sourceMode, setSourceMode,
    openingProgress, setOpeningProgress, openingLabel, setOpeningLabel,
    paletteOpen, setPaletteOpen, quickOpenState, setQuickOpenState,
    largeDocNotice, setLargeDocNotice, conflictFocusToken, setConflictFocusToken,
    skippedMarkersMessage, showSkippedMarkersStatus, applySpellcheck, applyAutoPair,
  } = chrome
  const [treeModel, setTreeModel] = useState(emptyFileTree())
  const treeModelRef = useRef(treeModel)
  // Cross-render coordination state: the factory-built coordinators are rebuilt
  // per render, so de-duplication/in-flight sets must live in refs.
  const treeErrorSignaturesRef = useRef(new Map<string, string>())
  const treePollInFlightRef = useRef(false)
  const pendingListDirsRef = useRef(new Set<string>())
  const recentsRef = useRef<string[]>([])
  const pendingJumpRef = useRef<number | null>(null)
  const pendingFocusRef = useRef(false)
  const tabSaveQueuesRef = useRef<TabSaveQueues>(new Map())
  const operationSeqRef = useRef(0)
  const pollReadFailures = useRef(new Map<number, string>())
  const saveFileRef = useRef<(
    tabId: number,
    trigger: import("./normalizationCoordinator").SaveTrigger,
    mode?: import("./documentSaveRunner").SaveMode | boolean,
  ) => Promise<void>>(async () => {})
  const saveCopyRef = useRef<(tabId: number) => Promise<void>>(async () => {})
  const requestCloseTabRef = useRef<(id: number) => void>(() => {})
  // These are rebuilt per render and needed by once-created coordinators.
  const activateTabRef = useRef<(id: number) => void>(() => {})
  const resetTabDocumentRef = useRef<(session: EditorSession, contents: string, docText?: Text) => boolean>(() => false)
  const updateCoordinatorRef = useRef<UpdateCoordinator | null>(null)
  const openCoordinatorRef = useRef<DocumentOpen | null>(null)
  const expandToPathRef = useRef<(path: string) => Promise<void>>(async () => {})

  function commitWorkspace(next: Workspace): void {
    store.setWorkspace(next)
    sessionRef.current = activeSession(next)
  }

  function commitTree(next: FileTreeModel): void {
    treeModelRef.current = next
    setTreeModel(next)
  }

  function commitNormalization(next: NormalizationByTab): void {
    store.setNormalizationByTab(next)
  }

  function commitSaveState(next: SaveStateByTab): void {
    const previous = store.getSaveStateByTab()
    if (next === previous) return
    reportSaveStateTransitions(previous, next, tabById)
    store.setSaveStateByTab(next)
  }

  function tabById(id: number): EditorSession | undefined {
    return store.getWorkspace().tabs.find(tab => tab.id === id)
  }

  function reportUserError(message: string): void {
    if (mountedRef.current) services.reportError(message)
  }

  function rememberRecent(path: string): void {
    const next = rememberPath(recentsRef.current, path)
    recentsRef.current = next
    services.saveRecents?.(next)
    void services.setRecentMenu?.(next)
  }

  function clearRecents(): void {
    recentsRef.current = []
    services.saveRecents?.([])
    void services.setRecentMenu?.([])
  }

  function revealFolder(path: string): void {
    const next = ensureFolder(store.getWorkspace(), path)
    if (next.folder === store.getWorkspace().folder) return
    commitWorkspace(next)
  }

  function isActiveSafeMode(): boolean {
    let lines = 0
    try { lines = registry.getActiveView()?.state.doc.lines ?? 0 } catch { lines = 0 }
    return documentScaleRegistry.evaluate(store.getWorkspace().activeId, lines).safeMode
  }

  // ---- document views / tabs / autosave ---------------------------------
  const applyDocumentScalePolicy = useMemo(() => createEditorScalePolicyApplier({
    registry: documentScaleRegistry,
    setNotice: setLargeDocNotice,
    requestStats: () => store.bumpStatsEpoch(),
  }), [documentScaleRegistry, store])

  const autosaveMsRef = useRef(autosaveMs)
  autosaveMsRef.current = autosaveMs
  const autosave = useMemo(() => createAutosaveScheduler({
    getAutosaveMs: () => autosaveMsRef.current,
    store,
    isReadOnly: tabId => documentScaleRegistry.isReadOnly(tabId),
    flushMaterialization: tabId => { materializerRef.current?.flushTab(tabId) },
    save: tabId => { void saveFileRef.current(tabId, "autosave") },
  }), [store, documentScaleRegistry])

  const materializerRef = useRef<import("./documentMaterializer").DocumentMaterializer | null>(null)
  const views = useMemo(() => createDocumentViews({
    services,
    store,
    registry,
    documentScaleRegistry,
    editorStatusStore,
    recoveryWriter,
    getSettings: () => settingsRef.current,
    getOpenCoordinator: () => openCoordinatorRef.current!,
    applyScalePolicy: applyDocumentScalePolicy,
    setNotice: setLargeDocNotice,
    setSourceMode,
    setTransientStatus,
    reportError: reportUserError,
    scheduleAutosave: tabId => autosave.schedule(tabId),
    commitWorkspace,
    commitNormalization,
    invalidateOutline: tabId => outlineController.invalidate(tabId),
    pendingJump: pendingJumpRef,
    pendingFocus: pendingFocusRef,
    materializeDelayMs: docMaterializeMs,
  }), [])
  materializerRef.current = views.materializer

  const tabs = useMemo(() => createTabLifecycle({
    services,
    store,
    registry,
    views,
    documentScaleRegistry,
    recoveryWriter,
    tabSaveQueues: tabSaveQueuesRef.current,
    getOpenCoordinator: () => openCoordinatorRef.current!,
    commitWorkspace,
    commitNormalization,
    commitSaveState,
    invalidateOutline: tabId => outlineController.invalidate(tabId),
    refreshOutline: view => outlineController.refresh(view),
    applyScalePolicy: applyDocumentScalePolicy,
    reportError: reportUserError,
    setOpeningLabel,
    setOpeningProgress,
    revealFolder,
    rememberRecent,
    cancelAutosave: tabId => autosave.cancel(tabId),
  }), [])
  resetTabDocumentRef.current = views.resetTabDocument
  activateTabRef.current = tabs.activateTab
  requestCloseTabRef.current = tabs.requestCloseTab

  // A dirty tab arms its own timer (one per tab), so leaving it for another tab
  // can no longer cancel its pending autosave.
  useEffect(() => {
    for (const tabId of dirtyIds) autosave.schedule(tabId)
  }, [dirtyIds, autosave])

  const adoptRecovery = useMemo(() => createRecoveryAdopter({
    getWorkspace: () => store.getWorkspace(),
    commitWorkspace,
    getContents: tabId => store.getTabDoc(tabId),
    setContents: (tabId, contents) => store.setTabDoc(tabId, contents),
    resetTabDocument: (session, contents) => resetTabDocumentRef.current(session, contents),
    mountNewTab: tabs.mountNewTab,
    syncDoc: views.syncDoc,
  }), [])

  // ---- document domain --------------------------------------------------
  const coordinators = useDocumentCoordinators({
    services,
    store,
    registry,
    views,
    tabs,
    documentScaleRegistry,
    recoveryWriter,
    autosaveCancel: autosave.cancel,
    settings,
    theme,
    customCss,
    t,
    isActiveSafeMode,
    folder: workspace.folder,
    updateCoordinatorRef,
    openCoordinatorRef,
    saveFileRef,
    saveCopyRef,
    requestCloseTabRef,
    resetTabDocumentRef,
    activateTabRef,
    expandToPathRef,
    sessionRef,
    openingRef,
    mountedRef,
    tabSaveQueues: tabSaveQueuesRef.current,
    operationSeq: operationSeqRef,
    pollReadFailures: pollReadFailures.current,
    treeModelRef,
    commitTree,
    treeErrorSignatures: treeErrorSignaturesRef.current,
    treePollInFlight: treePollInFlightRef,
    pendingListDirs: pendingListDirsRef.current,
    pendingFocusRef,
    tabById,
    commitWorkspace,
    commitNormalization,
    commitSaveState,
    revealFolder,
    rememberRecent,
    reportUserError,
    showTransientStatus,
    setConflictFocusToken,
    onSkippedMarkers: showSkippedMarkersStatus,
    setTheme,
    setCustomCss,
    setFocusMode,
    setSettingsOpen,
    setSidebarOpen,
    setOutlineOpen,
    setTypewriter,
    setAboutOpen,
    setOpeningLabel,
    setOpeningProgress,
    setQuickOpenState,
    clearRecents,
  })
  const {
    conflictSave, openCoordinator, treeActions, commands, commandsRef,
    acceptNormalization, keepOriginalNumbers, openRecent, pollFileTabs,
    search, findReplace, history,
  } = coordinators

  const openRecentRef = useRef(openRecent)
  openRecentRef.current = openRecent
  const openExternalRef = useRef((path: string) => openCoordinator.openExternal(path))

  useWorkspaceWatcher({
    services,
    watchMs,
    folder: workspace.folder,
    tabs: workspace.tabs,
    searchOpen: search.open,
    treeActions,
    commitTree,
    pollFileTabs,
  })

  const modalChromeOpenRef = useRef(false)
  modalChromeOpenRef.current =
    paletteOpen || quickOpenState.open || search.open || settingsOpen || aboutOpen
  // Keyboard isolation (UX-01) covers real dialogs only: the search panel is a
  // side panel, so `Cmd+W` keeps closing tabs while it is open.
  const dialogOpenRef = useRef(false)
  dialogOpenRef.current =
    settingsOpen || aboutOpen || history.state.open || paletteOpen || quickOpenState.open
  const openingLabelRef = useRef<string | null>(null)
  openingLabelRef.current = openingLabel
  const cancelOpeningRef = useRef(openCoordinator.cancelOpening)
  cancelOpeningRef.current = openCoordinator.cancelOpening

  useGlobalShortcuts({
    services,
    find: findReplace,
    commandsRef,
    openRecentRef,
    openExternalRef,
    openingLabelRef,
    cancelOpeningRef,
    isModalChromeOpen: () => modalChromeOpenRef.current,
    isDialogOpen: () => dialogOpenRef.current,
    togglePalette: () => setPaletteOpen(open => !open),
  })

  // ---- lifecycle & shell effects ---------------------------------------
  useAppLifecycleEffects({
    services,
    store,
    registry,
    views,
    tabs,
    documentScaleRegistry,
    recoveryWriter,
    mountedRef,
    openExternalRef,
    updateCoordinatorRef,
    updateAdapter,
    logUpdateFailure,
    setUpdateState,
    commitWorkspace,
    getSettings: () => settingsRef.current,
    commitSettings: next => { settingsRef.current = next; setSettings(next) },
    commitTheme: setTheme,
    setThemeSyncReady: () => setThemeSyncReady(true),
    applySpellcheck,
    applyAutoPair,
    adoptRecovery,
    isOpening: () => openingRef.current,
    dispose: () => {
      autosave.dispose()
      outlineController.dispose()
      openCoordinator.dispose()
    },
  })

  useDocumentAppearance({
    settings, theme, themeSyncReady, customCss, typewriter, focusMode, services,
  })

  useShellEffects({
    services,
    registry,
    statusStore: editorStatusStore,
    typewriter,
    focusMode,
    sourceMode,
    sidebarOpen,
    outlineOpen,
    activeTabId: workspace.activeId,
    recentsRef,
    setSidebarWidth,
    setSourceMode,
  })

  function runUpdateDownload(): void {
    const coordinator = updateCoordinatorRef.current
    if (!coordinator) return
    void coordinator.download().catch(error => {
      // A check-only download routes to the Release page before any download;
      // that rejection is not published through update state.
      if (mountedRef.current) {
        services.reportError(errorMessage(t("update.releaseOpenFailed"), error))
      }
    })
  }

  function commitSidebarWidth(px: number): void {
    setSidebarWidth(px)
    writeSidebarWidth(px)
  }

  function resetSidebarWidth(): void {
    commitSidebarWidth(clampSidebarWidth(SIDEBAR_DEFAULT_WIDTH, window.innerWidth))
  }

  // ---- derived render values ------------------------------------------
  const activeSaveState = tabSaveState(saveStateByTab, workspace.activeId)
  const activeNormalization = normalizationByTab[workspace.activeId]
  const bannerKind = topBanner(activeSaveState, activeNormalization !== undefined)
  const saveErrorCode = conflictSave.saveErrorCodeFor(activeSaveState, workspace.activeId)
  const conflictIds = workspace.tabs
    .filter(tab => tabHasConflict(saveStateByTab[tab.id]))
    .map(tab => tab.id)
  // Memoized so flattened row identities stay stable across unrelated renders
  // (TreeRow's comparator relies on it).
  const treeRows = useMemo(
    () => workspace.folder ? visibleRows(workspace.folder, treeModel) : [],
    [workspace.folder, treeModel],
  )

  return (
    <div className={`app theme-${theme}${focusMode ? " is-focus" : ""}`}>
      {!isMacOS() ? (
        <AppMenu
          getRecents={() => recentsRef.current}
          onCommand={id => runMenuCommand(id, commandsRef.current, {
            openRecent: path => { void openRecentRef.current(path) },
          })}
          viewState={{
            source: sourceMode,
            sidebar: sidebarOpen,
            outline: outlineOpen,
            typewriter,
            focus: focusMode,
          }}
        />
      ) : null}
      <TopBar
        workspace={workspace.folder}
        filePath={activeFilePath}
        tabs={workspace.tabs}
        activeId={workspace.activeId}
        dirtyIds={dirtyIds}
        conflictIds={conflictIds}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen(open => !open)}
        onFocusTab={tabs.activateTab}
        onCloseTab={tabs.requestCloseTab}
        onNewTab={tabs.newTab}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <div className="workspace-body">
        <AppSidebar
          services={services}
          open={sidebarOpen}
          width={sidebarWidth}
          folder={workspace.folder}
          rows={treeRows}
          activePath={activeFilePath}
          activeTabId={workspace.activeId}
          search={search}
          onResize={setSidebarWidth}
          onCommitWidth={commitSidebarWidth}
          onResetWidth={resetSidebarWidth}
          onOpenHit={hit => {
            pendingJumpRef.current = hit.line
            void openCoordinator.openPath(hit.path, true)
          }}
          onOpenFile={path => void openCoordinator.openPath(path, true)}
          onToggleDir={path => void treeActions.toggleDir(path)}
          onSearch={() => search.setOpen(true)}
          onCreateFile={services.createMarkdown ? treeActions.createTreeFile : undefined}
          onCreateFolder={services.createDir ? treeActions.createTreeFolder : undefined}
          onSuggestName={services.listDir ? treeActions.suggestName : undefined}
          onRename={services.renamePath ? treeActions.renameTreeEntry : undefined}
          onEditError={message => services.reportError(message)}
          onDelete={entry => void treeActions.deleteTreeEntry(entry)}
          onReveal={path => {
            void services.revealInFinder?.(path)?.catch(error => {
              services.reportError(errorMessage(t("error.revealFailed"), error))
            })
          }}
          onCollapse={() => setSidebarOpen(false)}
        />
        <AppOutlinePanel
          store={store}
          registry={registry}
          outline={outlineController}
          statusStore={editorStatusStore}
          outlineOpen={outlineOpen}
          onToggleOutline={() => setOutlineOpen(open => !open)}
        />
        <AppCanvas
          services={services}
          store={store}
          registry={registry}
          find={findReplace}
          isSafeMode={isActiveSafeMode}
          tabs={workspace.tabs}
          activeTabId={workspace.activeId}
          activeView={registry.getActiveView()}
          bannerKind={bannerKind}
          activeSaveState={activeSaveState}
          saveErrorCode={saveErrorCode}
          activeNormalization={activeNormalization}
          normalizationBusy={(activeNormalization?.action ?? "idle") !== "idle"}
          skippedMarkersMessage={skippedMarkersMessage}
          transientStatus={transientStatus}
          largeDocNotice={largeDocNotice}
          updateState={updateState}
          conflict={{
            diffOpenTabId: conflictSave.diffOpenTabId,
            diffRefreshed: conflictSave.diffRefreshed,
            conflictFocusToken,
            onConflictAction: action => conflictSave.onConflictAction(action, workspace.activeId),
            onDiffClose: conflictSave.closeDiff,
            onDiskFingerprintChange: conflictSave.handleDiskFingerprintChange,
          }}
          onAcceptNormalization={acceptNormalization}
          onKeepOriginalNumbers={keepOriginalNumbers}
          onDismissLargeDoc={() => setLargeDocNotice(null)}
          onDownloadUpdate={runUpdateDownload}
          onDismissUpdate={() => { updateCoordinatorRef.current?.dismiss() }}
          onRequestInstallUpdate={() => { void updateCoordinatorRef.current?.requestInstall() }}
          onInstallUpdate={() => { void updateCoordinatorRef.current?.install() }}
          onFocusBlockedTab={tabId => tabs.activateTab(tabId)}
          getLocalContents={() => store.getTabDoc(store.getWorkspace().activeId)}
        />
      </div>
      <AppStatusBar
        statusStore={editorStatusStore}
        store={store}
        documentScaleRegistry={documentScaleRegistry}
        getActiveLines={() => {
          try { return registry.getActiveView()?.state.doc.lines ?? 0 } catch { return 0 }
        }}
        normalizationReviewRequired={bannerKind === "normalization"}
        saveStatus={saveStatusLabel(activeSaveState)}
      />
      <AppOverlays
        services={services}
        openCoordinator={openCoordinator}
        openingLabel={openingLabel}
        openingProgress={openingProgress}
        paletteOpen={paletteOpen}
        commands={commands}
        onClosePalette={() => setPaletteOpen(false)}
        quickOpen={quickOpenState}
        folder={workspace.folder}
        onChooseRecent={path => { void openRecentRef.current(path) }}
        history={history}
        settingsOpen={settingsOpen}
        settings={settings}
        logState={logState}
        onSaveSettings={handleSaveSettings}
        onCloseSettings={() => setSettingsOpen(false)}
        onRestartForLogging={() => {
          void restartToApplyLogging(services, () => settingsSaveRef.current)
        }}
        aboutOpen={aboutOpen}
        onCloseAbout={() => setAboutOpen(false)}
      />
    </div>
  )
}
