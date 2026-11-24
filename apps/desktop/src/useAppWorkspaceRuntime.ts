/**
 * Per-mount workspace runtime wiring extracted from `App.tsx`:
 * file-tree state, cross-render coordination refs, store commit adapters,
 * scale policy applier, autosave scheduler, document views, tab lifecycle,
 * and recovery adoption.
 */
import { useEffect, useMemo, useRef, useState } from "react"
import type { Text } from "@codemirror/state"
import type { EditorStatusStore } from "./editorStatusStore"
import type { DocumentScaleRegistry } from "./documentScaleRegistry"
import { createEditorScalePolicyApplier } from "./editorScalePolicy"
import type { DocumentStore } from "./documentStore"
import type { EditorRegistry } from "./editorRegistry"
import type { OutlineController } from "./outlineController"
import { createDocumentViews } from "./documentViews"
import { createTabLifecycle } from "./appTabs"
import { createAutosaveScheduler } from "./autosaveScheduler"
import type { EditorSession } from "./session"
import { createRecoveryAdopter } from "./recoveryAdoption"
import type { RecoveryWriter } from "./recoveryWriter"
import { activeSession, ensureFolder, type Workspace } from "./workspace"
import type { DocumentOpen } from "./documentOpen"
import type { TabSaveQueues } from "./documentSaveCoordinator"
import type { NormalizationByTab } from "./normalizationState"
import type { SaveStateByTab } from "./documentSaveState"
import type { UpdateCoordinator } from "./updateCoordinator"
import type { DesktopServices } from "./desktopServices"
import { reportSaveStateTransitions } from "./saveDiagnostics"
import { rememberPath } from "./recents"
import { emptyFileTree, type FileTreeModel } from "./fileTreeState"
import type { DocumentMaterializer } from "./documentMaterializer"

type LargeDocNoticeSetter = Parameters<typeof createEditorScalePolicyApplier>[0]["setNotice"]
type EditorSettings = ReturnType<Parameters<typeof createDocumentViews>[0]["getSettings"]>

export interface AppWorkspaceRuntimeInput {
  readonly services: DesktopServices
  readonly store: DocumentStore
  readonly registry: EditorRegistry
  readonly documentScaleRegistry: DocumentScaleRegistry
  readonly editorStatusStore: EditorStatusStore
  readonly outlineController: OutlineController
  readonly recoveryWriter: RecoveryWriter
  readonly dirtyIds: readonly number[]
  readonly autosaveMs: number
  readonly docMaterializeMs: number
  readonly sessionRef: React.MutableRefObject<EditorSession>
  readonly settingsRef: React.MutableRefObject<EditorSettings>
  readonly mountedRef: React.MutableRefObject<boolean>
  readonly setLargeDocNotice: LargeDocNoticeSetter
  readonly setSourceMode: (sourceMode: boolean) => void
  readonly setTransientStatus: (status: string | null) => void
  readonly setOpeningLabel: (label: string | null) => void
  readonly setOpeningProgress: (progress: { bytesRead: number; byteLength: number } | null) => void
}

export function useAppWorkspaceRuntime(input: AppWorkspaceRuntimeInput) {
  const {
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
  } = input

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

  function tabById(id: number): EditorSession | undefined {
    return store.getWorkspace().tabs.find(tab => tab.id === id)
  }

  function commitSaveState(next: SaveStateByTab): void {
    const previous = store.getSaveStateByTab()
    if (next === previous) return
    reportSaveStateTransitions(previous, next, tabById)
    store.setSaveStateByTab(next)
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

  const materializerRef = useRef<DocumentMaterializer | null>(null)
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

  return {
    treeModel,
    treeModelRef,
    treeErrorSignaturesRef,
    treePollInFlightRef,
    pendingListDirsRef,
    recentsRef,
    pendingJumpRef,
    pendingFocusRef,
    tabSaveQueuesRef,
    operationSeqRef,
    pollReadFailures,
    saveFileRef,
    saveCopyRef,
    requestCloseTabRef,
    activateTabRef,
    resetTabDocumentRef,
    updateCoordinatorRef,
    openCoordinatorRef,
    expandToPathRef,
    commitWorkspace,
    commitTree,
    commitNormalization,
    commitSaveState,
    tabById,
    reportUserError,
    rememberRecent,
    clearRecents,
    revealFolder,
    isActiveSafeMode,
    applyDocumentScalePolicy,
    autosave,
    views,
    tabs,
    adoptRecovery,
  }
}
