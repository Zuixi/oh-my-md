import { useEffect, useRef, useState } from "react"
import {
  createEditor, documentOutline, editorStatus, resetEditorDocument,
  type CreateEditorOptions, type EditorDocumentUpdate,
} from "./Editor"
import type { EditorView } from "@codemirror/view"
import { applyToggle, exportHtml, type OutlineItem } from "@omd/engine"
import {
  advanceDocumentIdentity, createSession, openSession, recoveryKey,
  sessionDirty, sessionPath, type EditorSession,
} from "./session"
import {
  activeSession, addTab, closeTab, createWorkspace, ensureFolder, findTabByPath,
  focusTab, openFolder, replaceTabSession, type Workspace,
} from "./workspace"
import {
  clearTabNormalization, projectNormalizationNotice,
  type NormalizationByTab,
} from "./normalizationState"
import {
  canAutosaveTab, createNormalizationHandlers, createSaveQueueRunner,
  createSessionPersistence, createSkippedStatusNotifier, createTabSaver,
} from "./normalizationCoordinator"
import { createRecoveryWriter } from "./recoveryWriter"
import { NormalizationBanner } from "./NormalizationBanner"
import { applyTheme, toggleTheme, type ThemeName } from "./theme"
import { runMenuCommand, type AppCommand } from "./commands"
import { rememberPath } from "./recents"
import { defaultServices, errorMessage, wordCount, type DesktopServices } from "./desktopServices"
import { StatusBar } from "./StatusBar"
import { TabBar } from "./TabBar"
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
import "./styles.css"

export type { DesktopServices, RecoveryRecord } from "./desktopServices"

interface AppProps {
  services?: DesktopServices
  autosaveMs?: number
  watchMs?: number
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
  const lastDiskRef = useRef(new Map<string, string>())
  const openRequestRef = useRef(0)
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve())
  const openingRef = useRef(false)
  const mountedRef = useRef(false)
  const [theme, setTheme] = useState<ThemeName>("light")
  const [customCss, setCustomCss] = useState("")
  const [focusMode, setFocusMode] = useState(false)
  const [typewriter, setTypewriter] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [searchHits, setSearchHits] = useState<SearchHit[]>([])
  const [treeModel, setTreeModel] = useState(emptyFileTree())
  const treeModelRef = useRef(treeModel)
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

  const saveFile = createTabSaver({
    isOpening: () => openingRef.current,
    getTab: tabById,
    getView: tabId => viewsRef.current.get(tabId),
    getContents: tabId => docsRef.current.get(tabId) ?? "",
    getNormalization: () => normalizationRef.current,
    setNormalization: commitNormalization,
    getWorkspace: () => workspaceRef.current,
    getViews: () => viewsRef.current,
    pickSavePath: () => services.pickSavePath(),
    writeFile: (path, contents) => services.writeFile(path, contents),
    readDocumentVersion: path => services.readDocumentVersion(path),
    allowDocumentAssets: path => services.allowDocumentAssets(path),
    onPersisted: createSessionPersistence({
      getWorkspace: () => workspaceRef.current,
      setWorkspace: commitWorkspace,
      revealFolder, rememberRecent,
      recordDiskSnapshot: (path, snapshot) => lastDiskRef.current.set(path, snapshot),
      syncDoc,
      clearRecovery: key => { void services.clearRecovery?.(key) },
    }),
    onSaveFailed: error => {
      if (mountedRef.current) services.reportError(errorMessage("Save failed", error))
    },
    enqueue: createSaveQueueRunner(saveQueueRef),
  })

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

  const activePendingId = normalizationByTab[session.id]?.notice.id ?? null

  useEffect(() => {
    if (!autosaveMs || !activeFilePath || !dirty) return
    if (!canAutosaveTab(session.id, normalizationByTab)) return
    const tabId = session.id
    const timer = window.setTimeout(
      () => { void saveFileRef.current(tabId, "autosave") },
      autosaveMs,
    )
    return () => window.clearTimeout(timer)
  }, [doc, activeFilePath, dirty, autosaveMs, session.id, activePendingId])

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
    if (!watchMs || !workspace.folder || !services.listDir) return
    const listDir = services.listDir
    const timer = window.setInterval(() => { void refreshTree(listDir) }, watchMs)
    return () => window.clearInterval(timer)
  }, [watchMs, workspace.folder, services])

  useEffect(() => {
    if (!watchMs || !activeFilePath) return
    const path = activeFilePath
    const timer = window.setInterval(() => { void checkExternalRef.current(path) }, watchMs)
    return () => window.clearInterval(timer)
  }, [activeFilePath, watchMs])

  useEffect(() => {
    refreshChrome(viewRef.current)
  }, [doc])

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
    const contents = await services.readFile(nextPath)
    if (request !== undefined && request !== openRequestRef.current) return
    const versionProbe = await services.readDocumentVersion(nextPath)
    if (versionProbe.kind !== "existing") {
      if (mountedRef.current) {
        services.reportError(errorMessage("Open failed", new Error("Document version is unavailable")))
      }
      return
    }
    const snapshot = {
      requestedPath: nextPath,
      contents,
      version: versionProbe.version,
    }
    await services.allowDocumentAssets(nextPath)
    lastDiskRef.current.set(nextPath, contents)
    revealFolder(nextPath)
    rememberRecent(nextPath)
    if (inNewTab) {
      const tab = openSession(createSession(workspaceRef.current.nextId), snapshot)
      docsRef.current.set(tab.id, contents)
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
    await saveQueueRef.current.catch(() => undefined)
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
      recoveryWriterRef.current.forget(id)
      viewsRef.current.get(id)?.destroy()
      viewsRef.current.delete(id)
    }
    commitWorkspace(closed)
    const active = activeSession(workspaceRef.current)
    viewRef.current = viewsRef.current.get(active.id) ?? viewRef.current
    syncDoc(docsRef.current.get(active.id) ?? "", active.id)
  }

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
    if (!folder) return
    let next = treeModelRef.current
    for (const path of pathsToRefresh(folder, next)) {
      try {
        next = setChildren(next, path, await listDir(path))
      } catch {
        continue
      }
    }
    commitTree(next)
  }

  async function toggleDir(path: string): Promise<void> {
    const next = toggleExpand(treeModelRef.current, path)
    commitTree(next)
    if (!next.expanded.includes(path) || next.childrenByPath[path] || !services.listDir) return
    try {
      commitTree(setChildren(treeModelRef.current, path, await services.listDir(path)))
    } catch (error) {
      services.reportError(errorMessage("Folder listing failed", error))
    }
  }

  async function checkExternal(path: string) {
    if (openingRef.current || sessionPath(sessionRef.current) !== path) return
    const disk = await services.readFile(path)
    if (disk === lastDiskRef.current.get(path)) return
    const keepMine = sessionDirty(sessionRef.current, docRef.current)
      && !services.confirmExternalChange?.()
    lastDiskRef.current.set(path, disk)
    if (keepMine || sessionPath(sessionRef.current) !== path) return
    const versionProbe = await services.readDocumentVersion(path)
    if (versionProbe.kind !== "existing") return
    resetTabDocument(openSession(sessionRef.current, {
      requestedPath: path,
      contents: disk,
      version: versionProbe.version,
    }), disk)
  }

  async function exportCurrent(kind: "html" | "pdf" | "png") {
    const view = viewRef.current
    if (!view) return
    try {
      const html = exportHtml(view.state)
      if (kind === "html") {
        const path = await services.pickExportPath?.("html")
        if (path) await services.writeFile(path, html)
        return
      }
      if (!services.exportPreview) {
        throw new Error("PDF and image export are only available in the desktop app")
      }
      const format = kind === "pdf" ? "pdf" : "png"
      const path = await services.pickExportPath?.(format)
      if (path) await services.exportPreview(html, path, format)
    } catch (error) {
      services.reportError(errorMessage("Export failed", error))
    }
  }

  async function loadCustomCss() {
    try {
      const path = await services.pickCssPath?.()
      if (!path) return
      setCustomCss(await services.readFile(path))
    } catch (error) {
      setCustomCss("")
      services.reportError(errorMessage("Custom CSS failed", error))
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
  const saveFileRef = useRef(saveFile)
  const checkExternalRef = useRef(checkExternal)
  const newTabRef = useRef(newTab)
  const openRecentRef = useRef(openRecent)
  const closeActiveRef = useRef(() => requestCloseTab(workspaceRef.current.activeId))
  openFileRef.current = openFile
  saveFileRef.current = saveFile
  checkExternalRef.current = checkExternal
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
    { id: "css", label: "Load custom CSS", run: () => void loadCustomCss() },
    { id: "focus", label: "Toggle focus mode", run: () => setFocusMode(on => !on) },
    { id: "typewriter", label: "Toggle typewriter", run: () => setTypewriter(on => !on) },
    { id: "source", label: "Toggle live/source", shortcut: "⌘E", run: () => {
      const view = viewRef.current
      if (view) try { view.dispatch(applyToggle(view.state)) } catch { /* mock views */ }
    } },
    { id: "search", label: "Search in folder", run: () => setSearchOpen(true) },
    { id: "export-html", label: "Export HTML", run: () => void exportCurrent("html") },
    { id: "export-pdf", label: "Export PDF", run: () => void exportCurrent("pdf") },
    { id: "export-image", label: "Export Image", run: () => void exportCurrent("png") },
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
      if (e.key === "o") {
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

  return (
    <div className={`app theme-${theme}${focusMode ? " is-focus" : ""}`}>
      <StatusBar
        path={activeFilePath ?? "untitled"}
        dirty={dirty}
        words={wordCount(doc)}
        cursor={cursor}
        mode={mode}
        normalizationReviewRequired={activeNormalization !== undefined}
      />
      <TabBar
        tabs={workspace.tabs}
        activeId={workspace.activeId}
        dirtyIds={dirtyIds}
        onFocus={activateTab}
        onClose={requestCloseTab}
        onNew={newTab}
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
      <div className="workspace-body">
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
            rows={workspace.folder ? visibleRows(workspace.folder, treeModel) : []}
            activePath={activeFilePath}
            onOpenFile={path => void openPath(path, true)}
            onToggleDir={path => void toggleDir(path)}
            onSearch={() => setSearchOpen(true)}
          />
        )}
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
        <div className="sidebar-right">
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
        </div>
      </div>
      {paletteOpen ? (
        <CommandPalette commands={commands} onClose={() => setPaletteOpen(false)} />
      ) : null}
    </div>
  )
}
