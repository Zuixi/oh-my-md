import { useEffect, useRef, useState } from "react"
import {
  createEditor, documentOutline, editorStatus, resetEditorDocument,
  type CreateEditorOptions, type EditorDocumentUpdate,
} from "./Editor"
import type { EditorView } from "@codemirror/view"
import { applyToggle, exportHtml, type OutlineItem } from "@omd/engine"
import {
  advanceDocumentIdentity, createSession, markSaved, openSession, recoveryKey,
  sessionDirty, type EditorSession,
} from "./session"
import {
  activeSession, addTab, closeTab, createWorkspace, ensureFolder, findTabByPath,
  focusTab, openFolder, replaceTabSession, type Workspace,
} from "./workspace"
import {
  clearTabNormalization, projectNormalizationNotice, type NormalizationByTab,
} from "./normalizationState"
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
  const dirty = sessionDirty(session, doc)

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

  function commitSession(next: EditorSession) {
    commitWorkspace(replaceTabSession(workspaceRef.current, next))
  }

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
      { tabId: tab.id, key: recoveryKey(tab), path: tab.path, contents },
      { write: services.writeRecovery, reportError: reportUserError },
    )
  }

  /** Applies an update to the tab it was built for, or drops it if that binding is gone. */
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
      getDocPath: () => tabById(tabId)?.path ?? null,
      getDocumentId: () => tabById(tabId)?.documentId ?? documentId,
      onDocumentUpdate: handleDocumentUpdate,
      onError: reportUserError,
    }
  }

  /**
   * Replaces one tab's document with a fresh EditorState. The bumped identity is committed
   * before the view is touched, so a failing reset cannot leave a live editor bound to an
   * identity the workspace no longer has; on failure all three stores roll back together.
   */
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

  function sameSession(documentId: number, view: EditorView) {
    return sessionRef.current.documentId === documentId && viewRef.current === view && mountedRef.current
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

  useEffect(() => {
    if (!autosaveMs || !session.path || !dirty) return
    const timer = window.setTimeout(() => { void saveFileRef.current() }, autosaveMs)
    return () => window.clearTimeout(timer)
  }, [doc, session.path, dirty, autosaveMs])

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
    if (!watchMs || !session.path) return
    const path = session.path
    const timer = window.setInterval(() => { void checkExternalRef.current(path) }, watchMs)
    return () => window.clearInterval(timer)
  }, [session.path, watchMs])

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
    await services.allowDocumentAssets(nextPath)
    lastDiskRef.current.set(nextPath, contents)
    revealFolder(nextPath)
    rememberRecent(nextPath)
    if (inNewTab) {
      const tab = openSession(createSession(workspaceRef.current.nextId), nextPath, contents)
      docsRef.current.set(tab.id, contents)
      commitWorkspace(addTab(workspaceRef.current, tab))
      syncDoc(contents, tab.id)
      void services.clearRecovery?.(recoveryKey(tab))
      return
    }
    if (!resetTabDocument(openSession(sessionRef.current, nextPath, contents), contents)) return
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

  async function saveFile(saveAs = false) {
    if (openingRef.current) return
    const view = viewRef.current
    if (!view) return
    const documentId = sessionRef.current.documentId
    const tabId = sessionRef.current.id
    const snapshot = view.state.doc.toString()

    const operation = saveQueueRef.current.catch(() => undefined).then(async () => {
      try {
        if (!sameSession(documentId, view)) return
        const targetPath = saveAs || !sessionRef.current.path
          ? await services.pickSavePath()
          : sessionRef.current.path
        if (!targetPath || !sameSession(documentId, view)) return
        await services.writeFile(targetPath, snapshot)
        if (!sameSession(documentId, view)) return
        await services.allowDocumentAssets(targetPath)
        if (!sameSession(documentId, view)) return
        commitSession(markSaved(sessionRef.current, targetPath, snapshot))
        revealFolder(targetPath)
        rememberRecent(targetPath)
        lastDiskRef.current.set(targetPath, snapshot)
        syncDoc(view.state.doc.toString(), tabId)
        void services.clearRecovery?.(recoveryKey(sessionRef.current))
      } catch (error) {
        if (mountedRef.current) services.reportError(errorMessage("Save failed", error))
      }
    })
    saveQueueRef.current = operation
    await operation
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
    if (openingRef.current || sessionRef.current.path !== path) return
    const disk = await services.readFile(path)
    if (disk === lastDiskRef.current.get(path)) return
    const keepMine = sessionDirty(sessionRef.current, docRef.current)
      && !services.confirmExternalChange?.()
    lastDiskRef.current.set(path, disk)
    if (keepMine || sessionRef.current.path !== path) return
    resetTabDocument(openSession(sessionRef.current, path, disk), disk)
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

  /**
   * Task 7 owns accept/reject orchestration (`normalizationCoordinator.ts`): both actions must
   * capture tab, documentId, view and notice id and revalidate them before dispatching, so they
   * stay inert until that capture exists rather than dispatching into a replaced view.
   */
  function acceptNormalization() {}

  function keepOriginalNumbers() {}

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
    { id: "save", label: "Save", shortcut: "⌘S", run: () => void saveFile() },
    { id: "save-as", label: "Save As…", shortcut: "⇧⌘S", run: () => void saveFile(true) },
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
        void saveFileRef.current(e.shiftKey)
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
        path={session.path ?? "untitled"}
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
            activePath={session.path}
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
