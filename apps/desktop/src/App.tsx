import { useEffect, useMemo, useRef, useState } from "react"
import {
  createEditor, documentOutline, editorStatus, resetEditorDocument,
  type CreateEditorOptions, type EditorDocumentUpdate,
} from "./Editor"
import type { EditorView } from "@codemirror/view"
import { applyToggle, type OutlineItem } from "@omd/engine"
import {
  advanceDocumentIdentity, createSession, openSession, recoveryKey,
  sessionDirty, sessionPath, type EditorSession,
} from "./session"
import {
  activeSession, addTab, closeTab, createWorkspace, ensureFolder, findTabByPath,
  focusTab, openFolder, parentDir, replaceTabSession, type Workspace,
} from "./workspace"
import {
  clearTabNormalization, projectNormalizationNotice,
  type NormalizationByTab,
} from "./normalizationState"
import {
  createNormalizationHandlers, createSkippedStatusNotifier,
} from "./normalizationCoordinator"
import { createRecoveryWriter } from "./recoveryWriter"
import { createDocumentSaveAppBridge } from "./documentSaveAppBridge"
import { useConflictSaveBinding } from "./conflictSaveBinding"
import { ConflictSaveRegion } from "./ConflictSaveRegion"
import { exportCurrent, loadCustomCss } from "./appExportActions"
import {
  canAutosave,
  topBanner,
  type TabSaveQueues,
} from "./documentSaveCoordinator"
import {
  createTransientStatusNotifier,
  DURABILITY_WARNING,
  saveStatusLabel,
  tabHasConflict,
} from "./documentSaveRunner"
import {
  initialSaveState,
  removeTabSaveState,
  tabSaveState,
  type SaveStateByTab,
} from "./documentSaveState"
import { NormalizationBanner } from "./NormalizationBanner"
import { applyTheme, toggleTheme, type ThemeName } from "./theme"
import { runMenuCommand, type AppCommand } from "./commands"
import { rememberPath } from "./recents"
import { defaultServices, errorMessage, toDocumentCommandError, wordCount, type DesktopServices } from "./desktopServices"
import type { SaveTrigger } from "./normalizationCoordinator"
import type { SaveMode } from "./documentSaveRunner"
import { StatusBar } from "./StatusBar"
import { TopBar } from "./TopBar"
import { FileTree } from "./FileTree"
import {
  emptyFileTree,
  pathsToRefresh,
  setChildren,
  toggleExpand,
  visibleRows,
  type FileTreeModel,
  type TreeEntry,
} from "./fileTreeState"
import { OutlinePanel } from "./OutlinePanel"
import { CommandPalette } from "./CommandPalette"
import { SearchPanel, type SearchHit } from "./SearchPanel"
import { PanelLeft, PanelLeftClose } from "lucide-react"
import "./styles.css"

export type { DesktopServices, RecoveryRecord } from "./desktopServices"

interface AppProps {
  services?: DesktopServices
  autosaveMs?: number
  watchMs?: number
}

const OUTLINE_OPEN_KEY = "omd-outline-open"
const OUTLINE_DEBOUNCE_MS = 150

/** Shallow directory listing equality; a mismatch means disk changed. */
function sameEntries(
  a: readonly TreeEntry[] | undefined,
  b: readonly TreeEntry[],
): boolean {
  if (!a || a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].name !== b[i].name || a[i].path !== b[i].path || a[i].is_dir !== b[i].is_dir) {
      return false
    }
  }
  return true
}

function readOutlineOpen(): boolean {
  try {
    return localStorage.getItem(OUTLINE_OPEN_KEY) === "1"
  } catch {
    return false
  }
}

function writeOutlineOpen(open: boolean): void {
  try {
    localStorage.setItem(OUTLINE_OPEN_KEY, open ? "1" : "0")
  } catch { /* storage unavailable (tests, private mode) */ }
}

export default function App({
  services = defaultServices,
  autosaveMs = 1500,
  watchMs = 2000,
}: AppProps) {
  const hostsRef = useRef(new Map<number, HTMLDivElement>())
  const viewRef = useRef<EditorView | null>(null)
  const viewsRef = useRef(new Map<number, EditorView>())
  const workspaceRef = useRef<Workspace>(createWorkspace())
  const [workspace, setWorkspace] = useState(workspaceRef.current)
  const sessionRef = useRef<EditorSession>(activeSession(workspaceRef.current))
  const [session, setSession] = useState(sessionRef.current)
  const [doc, setDoc] = useState("")
  const docRef = useRef("")
  const docsRef = useRef(new Map<number, string>([[session.id, ""]]))
  const openRequestRef = useRef(0)
  const tabSaveQueuesRef = useRef<TabSaveQueues>(new Map())
  const operationSeqRef = useRef(0)
  const saveStateRef = useRef<SaveStateByTab>({ [session.id]: initialSaveState() })
  const [saveStateByTab, setSaveStateByTab] = useState<SaveStateByTab>(saveStateRef.current)
  const [conflictFocusToken, setConflictFocusToken] = useState(0)
  const saveFileRef = useRef<
    (tabId: number, trigger: SaveTrigger, mode?: SaveMode | boolean) => Promise<void>
  >(async () => {})
  const saveCopyRef = useRef<(tabId: number) => Promise<void>>(async () => {})
  const requestCloseTabRef = useRef<(id: number) => void>(() => {})
  const resetTabDocumentRef = useRef<(session: EditorSession, contents: string) => boolean>(() => false)
  const [transientStatus, setTransientStatus] = useState<string | null>(null)
  const transientStatusTimerRef = useRef<number | null>(null)
  const showTransientStatus = createTransientStatusNotifier(
    setTransientStatus,
    transientStatusTimerRef,
    id => { transientStatusTimerRef.current = id },
  )
  const openingRef = useRef(false)
  const mountedRef = useRef(false)
  const [theme, setTheme] = useState<ThemeName>("light")
  const [customCss, setCustomCss] = useState("")
  const [focusMode, setFocusMode] = useState(false)
  const [outlineOpen, setOutlineOpen] = useState(readOutlineOpen)
  const [typewriter, setTypewriter] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [searchHits, setSearchHits] = useState<SearchHit[]>([])
  const [treeModel, setTreeModel] = useState(emptyFileTree())
  const treeModelRef = useRef(treeModel)
  const treePollInFlightRef = useRef(false)
  const pendingListDirsRef = useRef(new Set<string>())
  const recentsRef = useRef<string[]>([])
  const [outline, setOutline] = useState<OutlineItem[]>([])
  const pendingJumpRef = useRef<number | null>(null)
  const [normalizationByTab, setNormalizationByTab] = useState<NormalizationByTab>({})
  const normalizationRef = useRef(normalizationByTab)
  const recoveryWriterRef = useRef(createRecoveryWriter())
  const skippedStatusTimerRef = useRef<number | null>(null)
  const [skippedMarkersMessage, setSkippedMarkersMessage] = useState<string | null>(null)
  const dirty = sessionDirty(session, doc)
  const activeFilePath = sessionPath(session)

  function commitWorkspace(next: Workspace) {
    workspaceRef.current = next
    setWorkspace(next)
    const active = activeSession(next)
    sessionRef.current = active
    setSession(active)
  }

  function commitTree(next: FileTreeModel) {
    treeModelRef.current = next
    setTreeModel(next)
  }

  function commitNormalization(next: NormalizationByTab) {
    if (next === normalizationRef.current) return
    normalizationRef.current = next
    setNormalizationByTab(next)
  }

  function tabById(id: number): EditorSession | undefined {
    return workspaceRef.current.tabs.find(tab => tab.id === id)
  }

  function rememberRecent(path: string) {
    const next = rememberPath(recentsRef.current, path)
    recentsRef.current = next
    services.saveRecents?.(next)
    void services.setRecentMenu?.(next)
  }

  function clearRecents() {
    recentsRef.current = []
    services.saveRecents?.([])
    void services.setRecentMenu?.([])
  }

  function commitSaveState(next: SaveStateByTab) {
    if (next === saveStateRef.current) return
    saveStateRef.current = next
    setSaveStateByTab(next)
  }

  const conflictSave = useConflictSaveBinding({
    services,
    getTab: tabById,
    getContents: tabId => docsRef.current.get(tabId) ?? "",
    getSaveStates: () => saveStateRef.current,
    commitSaveState,
    saveFile: (...args) => saveFileRef.current(...args),
    saveCopy: tabId => saveCopyRef.current(tabId),
    resetTabDocument: (session, contents) => resetTabDocumentRef.current(session, contents),
    requestCloseTab: id => requestCloseTabRef.current(id),
    showTransientStatus,
  })

  const { saveFile, saveCopy, pollFileTabs } = createDocumentSaveAppBridge({
    services,
    tabSaveQueues: tabSaveQueuesRef.current,
    operationSeq: operationSeqRef,
    isOpening: () => openingRef.current,
    getTab: tabById,
    getView: tabId => viewsRef.current.get(tabId),
    getContents: tabId => docsRef.current.get(tabId) ?? "",
    getNormalization: () => normalizationRef.current,
    setNormalization: commitNormalization,
    getWorkspace: () => workspaceRef.current,
    setWorkspace: commitWorkspace,
    getViews: () => viewsRef.current,
    getSaveStates: () => saveStateRef.current,
    setSaveStates: commitSaveState,
    revealFolder,
    rememberRecent,
    syncDoc,
    clearRecovery: key => { void services.clearRecovery?.(key) },
    onDurabilityWarning: () => showTransientStatus(DURABILITY_WARNING),
    incrementFocusToken: () => setConflictFocusToken(token => token + 1),
    reportStatus: showTransientStatus,
    onSaveFailed: conflictSave.onSaveFailed,
  })

  saveFileRef.current = saveFile
  saveCopyRef.current = saveCopy

  const showSkippedMarkersStatus = createSkippedStatusNotifier(
    setSkippedMarkersMessage, skippedStatusTimerRef,
    id => { skippedStatusTimerRef.current = id },
  )
  function syncDoc(value: string, tabId = workspaceRef.current.activeId) {
    docsRef.current.set(tabId, value)
    if (tabId !== workspaceRef.current.activeId) return
    docRef.current = value
    setDoc(value)
  }

  function reportUserError(message: string) {
    if (mountedRef.current) services.reportError(message)
  }

  function saveRecovery(tab: EditorSession, contents: string) {
    void recoveryWriterRef.current.save(
      { tabId: tab.id, key: recoveryKey(tab), path: sessionPath(tab), contents },
      { write: services.writeRecovery, reportError: reportUserError },
    )
  }

  /** Applies an update to the tab it was built for, or drops stale bindings. */
  function handleDocumentUpdate(update: EditorDocumentUpdate) {
    const tab = tabById(update.tabId)
    if (!tab || tab.documentId !== update.documentId) return
    if (update.docChanged) {
      syncDoc(update.doc, update.tabId)
      saveRecovery(tab, update.doc)
    }
    commitNormalization(projectNormalizationNotice(
      normalizationRef.current,
      update.tabId,
      update.pendingNormalization,
    ))
  }

  function editorOptions(contents: string, tabId: number, documentId: number): CreateEditorOptions {
    return {
      doc: contents,
      tabId,
      documentId,
      getDocPath: () => {
        const tab = tabById(tabId)
        return tab ? sessionPath(tab) : null
      },
      getDocumentId: () => tabById(tabId)?.documentId ?? documentId,
      onDocumentUpdate: handleDocumentUpdate,
      onError: reportUserError,
    }
  }

  function resetTabDocument(nextSession: EditorSession, contents: string): boolean {
    const view = viewsRef.current.get(nextSession.id)
    if (!view) return false
    const previousWorkspace = workspaceRef.current
    const previousNormalization = normalizationRef.current
    const previousDoc = docsRef.current.get(nextSession.id) ?? ""
    commitWorkspace(replaceTabSession(previousWorkspace, nextSession))
    commitNormalization(clearTabNormalization(previousNormalization, nextSession.id))
    try {
      resetEditorDocument(view, editorOptions(contents, nextSession.id, nextSession.documentId))
    } catch (error) {
      commitWorkspace(previousWorkspace)
      commitNormalization(previousNormalization)
      syncDoc(previousDoc, nextSession.id)
      throw error
    }
    syncDoc(contents, nextSession.id)
    return true
  }
  resetTabDocumentRef.current = resetTabDocument

  function refreshChrome(view: EditorView | null) {
    setOutline(documentOutline(view))
  }

  function ensureViews() {
    for (const tab of workspaceRef.current.tabs) {
      if (viewsRef.current.has(tab.id)) continue
      const el = hostsRef.current.get(tab.id)
      if (!el) continue
      const view = createEditor(
        el,
        editorOptions(docsRef.current.get(tab.id) ?? "", tab.id, tab.documentId),
      )
      viewsRef.current.set(tab.id, view)
      if (tab.id === workspaceRef.current.activeId) viewRef.current = view
    }
    jumpPending()
  }

  function jumpPending() {
    const lineNo = pendingJumpRef.current
    const view = viewRef.current
    if (!lineNo || !view) return
    pendingJumpRef.current = null
    try {
      const line = view.state.doc.line(lineNo)
      view.dispatch({ selection: { anchor: line.from } })
    } catch {
      /* mock views */
    }
  }

  function bindHost(id: number, el: HTMLDivElement | null) {
    if (el) hostsRef.current.set(id, el)
    else hostsRef.current.delete(id)
  }

  useEffect(() => {
    mountedRef.current = true
    ensureViews()
    void restoreDraft()
    return () => {
      mountedRef.current = false
      viewRef.current = null
      viewsRef.current.forEach(item => item.destroy())
      viewsRef.current.clear()
      openRequestRef.current += 1
    }
  }, [])

  useEffect(() => {
    ensureViews()
  }, [workspace.tabs])

  useEffect(() => {
    applyTheme(theme, customCss)
  }, [theme, customCss])

  useEffect(() => {
    document.documentElement.dataset.typewriter = typewriter ? "on" : "off"
    document.documentElement.dataset.focus = focusMode ? "on" : "off"
  }, [typewriter, focusMode])

  useEffect(() => {
    writeOutlineOpen(outlineOpen)
  }, [outlineOpen])

  const activePendingId = normalizationByTab[session.id]?.notice.id ?? null

  useEffect(() => {
    if (!autosaveMs || !activeFilePath || !dirty) return
    const saveState = tabSaveState(saveStateRef.current, session.id)
    if (!canAutosave({
      tabId: session.id,
      dirty,
      hasPath: true,
      normalization: normalizationByTab,
      saveState,
    })) return
    const tabId = session.id
    const timer = window.setTimeout(
      () => { void saveFileRef.current(tabId, "autosave") },
      autosaveMs,
    )
    return () => window.clearTimeout(timer)
  }, [doc, activeFilePath, dirty, autosaveMs, session.id, activePendingId, saveStateByTab])

  useEffect(() => {
    if (!workspace.folder || !services.listDir) return
    let cancelled = false
    const folder = workspace.folder
    const listDir = services.listDir
    commitTree(emptyFileTree())
    void listDir(folder).then(entries => {
      if (!cancelled) commitTree(setChildren(emptyFileTree(), folder, entries))
    }).catch(error => {
      if (!cancelled) services.reportError(errorMessage("Folder listing failed", error))
    })
    return () => { cancelled = true }
  }, [workspace.folder, services])

  useEffect(() => {
    // Skip the whole poll while Search replaces the tree: the scan is pure
    // waste and its results are not rendered.
    if (!watchMs || !workspace.folder || !services.listDir || searchOpen) return
    const listDir = services.listDir
    const timer = window.setInterval(() => { void refreshTree(listDir) }, watchMs)
    return () => window.clearInterval(timer)
  }, [watchMs, workspace.folder, services, searchOpen])

  useEffect(() => {
    if (!watchMs) return
    const timer = window.setInterval(() => { void pollFileTabsRef.current() }, watchMs)
    return () => window.clearInterval(timer)
  }, [watchMs])

  // Outline follows the document, but only while the panel is open and only
  // after typing pauses: collectOutline walks the whole syntax tree, so it must
  // stay off the per-keystroke path. activateTab refreshes immediately instead.
  useEffect(() => {
    if (!outlineOpen) return
    const timer = window.setTimeout(() => {
      setOutline(documentOutline(viewRef.current))
    }, OUTLINE_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [doc, outlineOpen, session.id])

  async function restoreDraft() {
    const records = await services.listRecoveries?.() ?? []
    const first = records[0]
    if (!first || !services.readRecovery) return
    if (!services.confirmRestore?.(first.label)) {
      await services.clearRecovery?.(first.key)
      return
    }
    const contents = await services.readRecovery(first.key)
    if (!mountedRef.current) return
    resetTabDocument(advanceDocumentIdentity(sessionRef.current), contents)
  }

  async function openPath(nextPath: string, inNewTab = false, request?: number) {
    const existing = findTabByPath(workspaceRef.current, nextPath)
    if (existing) {
      activateTab(existing.id)
      rememberRecent(nextPath)
      return
    }
    let snapshot
    try {
      snapshot = await services.readDocument(nextPath)
    } catch (error) {
      const cmd = toDocumentCommandError(error)
      if (cmd.code === "invalidPath" && mountedRef.current) {
        reportUserError("That path is not valid.")
        return
      }
      if (cmd.code === "notUtf8" && mountedRef.current) {
        reportUserError("Only UTF-8 Markdown files are supported.")
        return
      }
      if (request === openRequestRef.current && mountedRef.current) {
        services.reportError(errorMessage("Open failed", error))
      }
      return
    }
    if (request !== undefined && request !== openRequestRef.current) return
    if (snapshot.kind === "missing") {
      if (mountedRef.current) {
        services.reportError(errorMessage("Open failed", new Error("File not found")))
      }
      return
    }
    const { contents } = snapshot
    await services.allowDocumentAssets(nextPath)
    revealFolder(nextPath)
    void expandToPath(nextPath)
    rememberRecent(nextPath)
    if (inNewTab) {
      const tab = openSession(createSession(workspaceRef.current.nextId), snapshot)
      docsRef.current.set(tab.id, contents)
      commitSaveState({ ...saveStateRef.current, [tab.id]: initialSaveState() })
      commitWorkspace(addTab(workspaceRef.current, tab))
      syncDoc(contents, tab.id)
      void services.clearRecovery?.(recoveryKey(tab))
      return
    }
    if (!resetTabDocument(openSession(sessionRef.current, snapshot), contents)) return
    void services.clearRecovery?.(recoveryKey(sessionRef.current))
  }

  async function runOpen(pickPath: () => Promise<string | null>) {
    const request = ++openRequestRef.current
    const activeId = workspaceRef.current.activeId
    await (tabSaveQueuesRef.current.get(activeId) ?? Promise.resolve()).catch(() => undefined)
    if (request !== openRequestRef.current || !mountedRef.current) return
    openingRef.current = true
    try {
      if (sessionDirty(sessionRef.current, docRef.current) && !services.confirmDiscard()) return
      const nextPath = await pickPath()
      if (!nextPath || request !== openRequestRef.current) return
      await openPath(nextPath, false, request)
    } catch (error) {
      if (request === openRequestRef.current && mountedRef.current) {
        services.reportError(errorMessage("Open failed", error))
      }
    } finally {
      if (request === openRequestRef.current) openingRef.current = false
    }
  }

  function openRecent(path: string) {
    return runOpen(async () => path)
  }

  function openFile() {
    return runOpen(() => services.pickOpenPath())
  }

  function activateTab(id: number) {
    const current = viewRef.current
    if (current) docsRef.current.set(sessionRef.current.id, current.state.doc.toString())
    commitWorkspace(focusTab(workspaceRef.current, id))
    const nextView = viewsRef.current.get(id)
    if (!nextView) return
    viewRef.current = nextView
    syncDoc(docsRef.current.get(id) ?? nextView.state.doc.toString(), id)
    refreshChrome(nextView)
    jumpPending()
  }

  function newTab() {
    const tab = createSession(workspaceRef.current.nextId)
    docsRef.current.set(tab.id, "")
    commitSaveState({ ...saveStateRef.current, [tab.id]: initialSaveState() })
    commitWorkspace(addTab(workspaceRef.current, tab))
    syncDoc("", tab.id)
  }

  function requestCloseTab(id: number) {
    const tab = tabById(id)
    if (!tab) return
    const contents = docsRef.current.get(id) ?? ""
    if (sessionDirty(tab, contents) && !(services.confirmClose ?? services.confirmDiscard)()) return
    // Per-tab state is dropped when the tab really disappears; closeTab keeps a lone tab open.
    const closed = closeTab(workspaceRef.current, id)
    if (!closed.tabs.some(item => item.id === id)) {
      commitNormalization(clearTabNormalization(normalizationRef.current, id))
      commitSaveState(removeTabSaveState(saveStateRef.current, id))
      recoveryWriterRef.current.forget(id)
      viewsRef.current.get(id)?.destroy()
      viewsRef.current.delete(id)
    }
    commitWorkspace(closed)
    const active = activeSession(workspaceRef.current)
    viewRef.current = viewsRef.current.get(active.id) ?? viewRef.current
    syncDoc(docsRef.current.get(active.id) ?? "", active.id)
  }
  requestCloseTabRef.current = requestCloseTab

  function revealFolder(path: string) {
    const next = ensureFolder(workspaceRef.current, path)
    if (next.folder === workspaceRef.current.folder) return
    commitWorkspace(next)
    if (next.folder) void services.allowWorkspaceDir?.(next.folder)
  }

  async function chooseFolder() {
    const folder = await services.pickFolder?.()
    if (!folder) return
    await services.allowWorkspaceDir?.(folder)
    commitWorkspace(openFolder(workspaceRef.current, folder))
  }

  async function refreshTree(listDir: (path: string) => Promise<TreeEntry[]>): Promise<void> {
    const folder = workspaceRef.current.folder
    if (!folder || treePollInFlightRef.current) return
    treePollInFlightRef.current = true
    try {
      let next = treeModelRef.current
      let changed = false
      for (const path of pathsToRefresh(folder, next)) {
        let entries: TreeEntry[]
        try {
          entries = await listDir(path)
        } catch {
          continue
        }
        // Skip re-rendering the whole tree when a directory is unchanged.
        if (sameEntries(next.childrenByPath[path], entries)) continue
        next = setChildren(next, path, entries)
        changed = true
      }
      if (changed) commitTree(next)
    } finally {
      treePollInFlightRef.current = false
    }
  }

  async function toggleDir(path: string): Promise<void> {
    const next = toggleExpand(treeModelRef.current, path)
    commitTree(next)
    if (!next.expanded.has(path) || next.childrenByPath[path] || !services.listDir) return
    if (pendingListDirsRef.current.has(path)) return
    pendingListDirsRef.current.add(path)
    try {
      const entries = await services.listDir(path)
      // The user may have collapsed the directory while the listing was in
      // flight; caching it would only produce a useless model update.
      if (!treeModelRef.current.expanded.has(path)) return
      commitTree(setChildren(treeModelRef.current, path, entries))
    } catch (error) {
      services.reportError(errorMessage("Folder listing failed", error))
    } finally {
      pendingListDirsRef.current.delete(path)
    }
  }

  /** Expands every ancestor of `path` down from the workspace root so the
   * opened file is reachable in the tree. Best-effort: a listing failure must
   * not block an open that already succeeded. */
  async function expandToPath(path: string): Promise<void> {
    const folder = workspaceRef.current.folder
    if (!folder || !services.listDir) return
    const dirs: string[] = []
    let current = parentDir(path)
    while (current && current !== folder && current.startsWith(folder)) {
      dirs.unshift(current)
      const above = parentDir(current)
      if (above === current) break
      current = above
    }
    for (const dir of dirs) {
      const toggled = toggleExpand(treeModelRef.current, dir)
      commitTree(toggled)
      if (toggled.childrenByPath[dir] || pendingListDirsRef.current.has(dir)) continue
      pendingListDirsRef.current.add(dir)
      try {
        const entries = await services.listDir(dir)
        if (treeModelRef.current.expanded.has(dir)) {
          commitTree(setChildren(treeModelRef.current, dir, entries))
        }
      } catch {
        // reveal is best-effort
      } finally {
        pendingListDirsRef.current.delete(dir)
      }
    }
  }

  const { accept: acceptNormalization, reject: keepOriginalNumbers } = createNormalizationHandlers({
    getActiveTabId: () => workspaceRef.current.activeId,
    getTab: tabById,
    getView: tabId => viewsRef.current.get(tabId),
    getNormalization: () => normalizationRef.current,
    setNormalization: commitNormalization,
    getWorkspace: () => workspaceRef.current,
    getViews: () => viewsRef.current,
    saveExplicit: tabId => { void saveFile(tabId, "explicit") },
    onSkippedMarkers: showSkippedMarkersStatus,
  })

  const openFileRef = useRef(openFile)
  const pollFileTabsRef = useRef(pollFileTabs)
  const newTabRef = useRef(newTab)
  const openRecentRef = useRef(openRecent)
  const closeActiveRef = useRef(() => requestCloseTab(workspaceRef.current.activeId))
  openFileRef.current = openFile
  pollFileTabsRef.current = pollFileTabs
  newTabRef.current = newTab
  openRecentRef.current = openRecent
  closeActiveRef.current = () => requestCloseTab(workspaceRef.current.activeId)

  const commands: AppCommand[] = [
    { id: "open", label: "Open…", shortcut: "⌘O", run: () => void openFile() },
    { id: "save", label: "Save", shortcut: "⌘S", run: () => void saveFile(workspaceRef.current.activeId, "explicit") },
    { id: "save-as", label: "Save As…", shortcut: "⇧⌘S", run: () => void saveFile(workspaceRef.current.activeId, "explicit", true) },
    { id: "folder", label: "Open Folder…", run: () => void chooseFolder() },
    { id: "tab", label: "New", shortcut: "⌘N", run: newTab },
    { id: "close", label: "Close", shortcut: "⌘W", run: () => requestCloseTab(workspaceRef.current.activeId) },
    { id: "theme", label: "Toggle theme", run: () => setTheme(current => toggleTheme(current)) },
    { id: "css", label: "Load custom CSS", run: () => void loadCustomCss(services, setCustomCss) },
    { id: "focus", label: "Toggle focus mode", run: () => setFocusMode(on => !on) },
    { id: "outline", label: "Toggle outline", shortcut: "⇧⌘O", run: () => setOutlineOpen(open => !open) },
    { id: "typewriter", label: "Toggle typewriter", run: () => setTypewriter(on => !on) },
    { id: "source", label: "Toggle live/source", shortcut: "⌘E", run: () => {
      const view = viewRef.current
      if (view) try { view.dispatch(applyToggle(view.state)) } catch { /* mock views */ }
    } },
    { id: "search", label: "Search in folder", run: () => setSearchOpen(true) },
    { id: "export-html", label: "Export HTML", run: () => void exportCurrent(services, viewRef.current, "html") },
    { id: "export-pdf", label: "Export PDF", run: () => void exportCurrent(services, viewRef.current, "pdf") },
    { id: "export-image", label: "Export Image", run: () => void exportCurrent(services, viewRef.current, "png") },
    { id: "clear-recents", label: "Clear Recents", run: clearRecents },
  ]
  const commandsRef = useRef(commands)
  commandsRef.current = commands

  useEffect(() => {
    recentsRef.current = services.loadRecents?.() ?? []
    void services.setRecentMenu?.(recentsRef.current)
  }, [services])

  useEffect(() => {
    if (!services.listenMenu) return
    return services.listenMenu(id => runMenuCommand(id, commandsRef.current, {
      openRecent: path => { void openRecentRef.current(path) },
    }))
  }, [services])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setPaletteOpen(open => !open)
        return
      }
      if (!e.metaKey && !e.ctrlKey) return
      if (e.key === "O" && e.shiftKey) {
        e.preventDefault()
        setOutlineOpen(open => !open)
      } else if (e.key === "o") {
        e.preventDefault()
        void openFileRef.current()
      } else if (e.key === "n") {
        e.preventDefault()
        newTabRef.current()
      } else if (e.key === "w") {
        e.preventDefault()
        closeActiveRef.current()
      } else if (e.key === "s") {
        e.preventDefault()
        void saveFileRef.current(workspaceRef.current.activeId, "explicit", e.shiftKey)
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [])

  useEffect(() => {
    if (!searchOpen || !workspace.folder || !searchQuery || !services.searchMarkdown) return
    const timer = window.setTimeout(() => {
      void services.searchMarkdown?.(workspace.folder!, searchQuery).then(setSearchHits)
    }, 200)
    return () => window.clearTimeout(timer)
  }, [searchOpen, searchQuery, workspace.folder, services])

  const { cursor, mode } = editorStatus(viewRef.current)

  const dirtyIds = workspace.tabs
    .filter(tab => sessionDirty(tab, docsRef.current.get(tab.id) ?? (tab.id === session.id ? doc : "")))
    .map(tab => tab.id)
  const activeNormalization = normalizationByTab[workspace.activeId]
  const activeSaveState = tabSaveState(saveStateByTab, workspace.activeId)
  const bannerKind = topBanner(
    activeSaveState,
    activeNormalization !== undefined,
  )
  const saveErrorCode = conflictSave.saveErrorCodeFor(activeSaveState, workspace.activeId)
  const conflictIds = workspace.tabs
    .filter(tab => tabHasConflict(saveStateByTab[tab.id]))
    .map(tab => tab.id)

  // Memoized so the flattened row list (and its object identities) stay stable
  // across unrelated App re-renders; TreeRow's comparator relies on that.
  const treeRows = useMemo(
    () => workspace.folder ? visibleRows(workspace.folder, treeModel) : [],
    [workspace.folder, treeModel],
  )

  return (
    <div className={`app theme-${theme}${focusMode ? " is-focus" : ""}`}>
      <TopBar
        workspace={workspace.folder}
        filePath={activeFilePath}
        dirty={dirty}
        tabs={workspace.tabs}
        activeId={workspace.activeId}
        dirtyIds={dirtyIds}
        conflictIds={conflictIds}
        onFocusTab={activateTab}
        onCloseTab={requestCloseTab}
        onNewTab={newTab}
      />
      <div className="workspace-body">
        <aside className="sidebar-primary">
          {searchOpen ? (
            <SearchPanel
              query={searchQuery}
              hits={searchHits}
              onQuery={setSearchQuery}
              onClose={() => setSearchOpen(false)}
              onOpen={hit => {
                pendingJumpRef.current = hit.line
                void openPath(hit.path, true)
              }}
            />
          ) : (
            <FileTree
              folder={workspace.folder}
              rows={treeRows}
              activePath={activeFilePath}
              onOpenFile={path => void openPath(path, true)}
              onToggleDir={path => void toggleDir(path)}
              onSearch={() => setSearchOpen(true)}
            />
          )}
        </aside>
        <aside
          id="outline-panel"
          className={`sidebar-secondary${outlineOpen ? "" : " is-hidden"}`}
          aria-hidden={!outlineOpen}
          inert={!outlineOpen}
        >
          <OutlinePanel
            items={outline}
            onJump={from => {
              const view = viewRef.current
              if (!view) return
              try {
                view.dispatch({ selection: { anchor: from } })
                view.focus()
              } catch { /* mock views */ }
            }}
          />
        </aside>
        <div className="outline-toggle-strip">
          <button
            type="button"
            className={`outline-toggle-btn${outlineOpen ? " is-active" : ""}`}
            onClick={() => setOutlineOpen(open => !open)}
            aria-expanded={outlineOpen}
            aria-controls="outline-panel"
            aria-label={outlineOpen ? "Hide outline" : "Show outline"}
            title={outlineOpen ? "Hide outline (⇧⌘O)" : "Show outline (⇧⌘O)"}
          >
            {outlineOpen ? <PanelLeftClose size={14} /> : <PanelLeft size={14} />}
          </button>
        </div>
        <div className="editor-canvas">
          <ConflictSaveRegion
            bannerKind={
              bannerKind === "conflict" || bannerKind === "saveFailed" ? bannerKind : null
            }
            activeTabId={workspace.activeId}
            activeSaveState={activeSaveState}
            saveErrorCode={saveErrorCode}
            localContents={doc}
            diffOpenTabId={conflictSave.diffOpenTabId}
            diffRefreshed={conflictSave.diffRefreshed}
            conflictFocusToken={conflictFocusToken}
            activeView={viewRef.current}
            onConflictAction={action => conflictSave.onConflictAction(action, workspace.activeId)}
            onDiffClose={conflictSave.closeDiff}
            onDiskFingerprintChange={conflictSave.handleDiskFingerprintChange}
          />
          <NormalizationBanner
            markerCount={activeNormalization?.notice.markerCount ?? null}
            busy={(activeNormalization?.action ?? "idle") !== "idle"}
            onSave={acceptNormalization}
            onKeepOriginal={keepOriginalNumbers}
          />
          {skippedMarkersMessage ? (
            <p className="normalization-skipped-status" role="status">{skippedMarkersMessage}</p>
          ) : null}
          {transientStatus ? (
            <p className="save-transient-status" role="status">{transientStatus}</p>
          ) : null}
          <div className="editor-stack">
            {workspace.tabs.map(tab => (
              <div
                key={tab.id}
                className="editor-host"
                hidden={tab.id !== workspace.activeId}
                ref={el => bindHost(tab.id, el)}
              />
            ))}
          </div>
        </div>
      </div>
      <StatusBar
        words={wordCount(doc)}
        cursor={cursor}
        mode={mode}
        normalizationReviewRequired={bannerKind === "normalization"}
        saveStatus={saveStatusLabel(activeSaveState)}
      />
      {paletteOpen ? (
        <CommandPalette commands={commands} onClose={() => setPaletteOpen(false)} />
      ) : null}
    </div>
  )
}
