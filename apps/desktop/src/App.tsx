import { useMemo, useRef, useState } from "react"
import { createEditorStatusStore } from "./editorStatusStore"
import { useAppChrome } from "./useAppChrome"
import { createDocumentScaleRegistry } from "./documentScaleRegistry"
import {
  createDocumentStore, useDirtyTabIds, useNormalizationByTab, useSaveStateByTab, useWorkspace,
} from "./documentStore"
import { createEditorRegistry } from "./editorRegistry"
import { createOutlineController } from "./outlineController"
import { sessionPath, type EditorSession } from "./session"
import { createRecoveryWriter } from "./recoveryWriter"
import { restartToApplyLogging } from "./appLoggingActions"
import { useDocumentCoordinators } from "./useDocumentCoordinators"
import { topBanner } from "./documentSaveCoordinator"
import { saveStatusLabel, tabHasConflict } from "./documentSaveRunner"
import { tabSaveState } from "./documentSaveState"
import type { UpdateFailureKind } from "./updateCoordinator"
import { createTauriUpdateAdapter, type UpdateAdapter } from "./updateAdapter"
import { runMenuCommand } from "./commands"
import { isMacOS } from "./platform"
import { AppMenu } from "./AppMenu"
import { defaultServices, errorMessage, type DesktopServices } from "./desktopServices"
import { logUpdateStartupFailure } from "./logging"
import { useWorkspaceWatcher } from "./useWorkspaceWatcher"
import { useGlobalShortcuts } from "./useGlobalShortcuts"
import { useDocumentAppearance, useShellEffects } from "./useShellEffects"
import { useAppLifecycleEffects } from "./useAppLifecycleEffects"
import { useAppWorkspaceRuntime } from "./useAppWorkspaceRuntime"
import { AppSidebar } from "./AppSidebar"
import { AppOutlinePanel } from "./AppOutlinePanel"
import { AppCanvas } from "./AppCanvas"
import { AppOverlays } from "./AppOverlays"
import { useMediaLightbox } from "./MediaLightbox"
import { AppStatusBar } from "./AppStatusBar"
import { TopBar } from "./TopBar"
import { visibleRows } from "./fileTreeState"
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
  const lightbox = useMediaLightbox(workspace.activeId, session.documentId)

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
  const {
    treeModel, treeModelRef, treeErrorSignaturesRef, treePollInFlightRef,
    pendingListDirsRef, recentsRef, pendingJumpRef, pendingFocusRef,
    tabSaveQueuesRef, operationSeqRef, pollReadFailures,
    saveFileRef, saveCopyRef, requestCloseTabRef, activateTabRef, resetTabDocumentRef,
    updateCoordinatorRef, openCoordinatorRef, expandToPathRef,
    commitWorkspace, commitTree, commitNormalization, commitSaveState,
    tabById, reportUserError, rememberRecent, clearRecents, revealFolder, isActiveSafeMode,
    autosave, views, tabs, adoptRecovery,
  } = useAppWorkspaceRuntime({
    services,
    store,
    registry,
    documentScaleRegistry,
    editorStatusStore,
    outlineController,
    recoveryWriter,
    dirtyIds,
    autosaveMs,
    docMaterializeMs,
    sessionRef,
    settingsRef,
    mountedRef,
    setLargeDocNotice,
    setSourceMode,
    setTransientStatus,
    setOpeningLabel,
    setOpeningProgress,
    onInspectMedia: lightbox.open,
  })

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
    acceptNormalization, keepOriginalNumbers, openRecent, chooseFolder, pollFileTabs,
    search, findReplace, history,
  } = coordinators

  const openRecentRef = useRef(openRecent)
  openRecentRef.current = openRecent
  // Created after the coordinator host (which only holds the ref), so the real
  // implementation must be attached here; a no-op ref silently kept every open
  // path from revealing its ancestors in the file tree.
  expandToPathRef.current = treeActions.expandToPath
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
    paletteOpen || quickOpenState.open || search.open || settingsOpen || aboutOpen ||
    lightbox.target !== null
  // Keyboard isolation (UX-01) covers real dialogs only: the search panel is a
  // side panel, so `Cmd+W` keeps closing tabs while it is open.
  const dialogOpenRef = useRef(false)
  dialogOpenRef.current =
    settingsOpen || aboutOpen || history.state.open || paletteOpen || quickOpenState.open ||
    lightbox.target !== null
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
    resetDisposed: () => outlineController.reset(),
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
      />
      <div className="workspace-body">
        <AppSidebar
          services={services}
          open={sidebarOpen}
          width={sidebarWidth}
          folder={workspace.folder}
          rows={treeRows}
          tabs={workspace.tabs}
          dirtyIds={dirtyIds}
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
          onOpenFolder={() => void chooseFolder()}
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
        workspace={workspace.folder}
        filePath={activeFilePath}
        onOpenSettings={() => setSettingsOpen(true)}
        onRevealPath={services.revealInFinder
          ? path => {
              void services.revealInFinder?.(path)?.catch(error => {
                services.reportError(errorMessage(t("error.revealFailed"), error))
              })
            }
          : undefined}
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
        lightboxTarget={lightbox.target}
        onCloseLightbox={lightbox.close}
      />
    </div>
  )
}
