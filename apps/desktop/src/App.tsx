import { useEffect, useMemo, useRef, useState } from "react"
import {
  createEditor, documentOutline, editorStatus, resetEditorDocument, setEditorSpellcheck,
  type CreateEditorOptions, type EditorDocumentUpdate,
} from "./Editor"
import type { EditorView } from "@codemirror/view"
import { applyToggle, documentStats, type OutlineItem } from "@omd/engine"
import { pickAndInsertImage, type ImagePasteOptions } from "./imagePaste"
import {
  advanceDocumentIdentity, createSession, openSession, recoveryKey,
  sessionDirty, sessionPath, type EditorSession,
} from "./session"
import {
  activeSession, addTab, closeTab, createWorkspace, ensureFolder, findTabByPath,
  focusTab, openFolder, parentDir, replaceTabSession, resolveMarkdownHref, type Workspace,
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
import { applyTheme, toggleTheme, type AppTheme } from "./theme"
import { runMenuCommand, type AppCommand } from "./commands"
import { rememberPath } from "./recents"
import { defaultServices, errorMessage, toDocumentCommandError, type DesktopServices } from "./desktopServices"
import { collectMatches, nextIndex, prevIndex, replaceAll } from "./findReplace"
import { FindReplaceBar } from "./FindReplaceBar"
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
import {
  toggleBold,
  toggleBlockquote,
  toggleCodeBlock,
  toggleHeading,
  toggleInlineCode,
  toggleItalic,
  toggleOrderedList,
  toggleStrikethrough,
  toggleUnorderedList,
  insertLink,
} from "@omd/engine"
import { SettingsModal } from "./SettingsModal"
import {
  DEFAULT_SETTINGS,
  sanitizeSettings,
  type UserSettings,
} from "./settings"
import {
  extractSessionState,
} from "./sessionRestore"
import "./styles.css"

export type { DesktopServices, RecoveryRecord } from "./desktopServices"

interface AppProps {
  services?: DesktopServices
  autosaveMs?: number
  watchMs?: number
}

const OUTLINE_OPEN_KEY = "omd-outline-open"
const SIDEBAR_OPEN_KEY = "omd-sidebar-open"
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

function readSidebarOpen(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_OPEN_KEY) !== "0"
  } catch {
    return true
  }
}

function writeSidebarOpen(open: boolean): void {
  try {
    localStorage.setItem(SIDEBAR_OPEN_KEY, open ? "1" : "0")
  } catch { /* storage unavailable */ }
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
  const [settings, setSettings] = useState<UserSettings>(DEFAULT_SETTINGS)
  const settingsRef = useRef<UserSettings>(settings)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const sessionSaveTimerRef = useRef<number | null>(null)
  const sessionRestoredRef = useRef(false)
  const [theme, setTheme] = useState<AppTheme>("light")
  const [customCss, setCustomCss] = useState("")
  const [focusMode, setFocusMode] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(readSidebarOpen)
  const [outlineOpen, setOutlineOpen] = useState(readOutlineOpen)
  const [typewriter, setTypewriter] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [searchHits, setSearchHits] = useState<SearchHit[]>([])
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState("")
  const [findReplace, setFindReplace] = useState("")
  const [findCase, setFindCase] = useState(false)
  const [replaceOpen, setReplaceOpen] = useState(false)
  const [findIndex, setFindIndex] = useState(-1)
  const findOpenRef = useRef(false)
  findOpenRef.current = findOpen
  const findQueryRef = useRef(findQuery)
  findQueryRef.current = findQuery
  const findReplaceRef = useRef(findReplace)
  findReplaceRef.current = findReplace
  const findCaseRef = useRef(findCase)
  findCaseRef.current = findCase
  const findIndexRef = useRef(findIndex)
  findIndexRef.current = findIndex
  const [treeModel, setTreeModel] = useState(emptyFileTree())
  const treeModelRef = useRef(treeModel)
  const treePollInFlightRef = useRef(false)
  const pendingListDirsRef = useRef(new Set<string>())
  const recentsRef = useRef<string[]>([])
  const [outline, setOutline] = useState<OutlineItem[]>([])
  const [outlineHover, setOutlineHover] = useState(false)
  const outlineHoverTimerRef = useRef<number | null>(null)
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

  function imageInsertOptions(tabId: number, documentId: number): ImagePasteOptions {
    return {
      getDocPath: () => {
        const tab = tabById(tabId)
        return tab ? sessionPath(tab) : null
      },
      getDocumentId: () => tabById(tabId)?.documentId ?? documentId,
      onError: reportUserError,
    }
  }

  function editorOptions(contents: string, tabId: number, documentId: number): CreateEditorOptions {
    return {
      doc: contents,
      tabId,
      documentId,
      ...imageInsertOptions(tabId, documentId),
      onDocumentUpdate: handleDocumentUpdate,
      onOpenMarkdownHref: href => {
        const current = sessionPath(sessionRef.current)
        if (!current) {
          services.reportError(errorMessage("Open failed", new Error("File not found")))
          return
        }
        void openPath(resolveMarkdownHref(current, href), true)
      },
      tabSize: settingsRef.current.tabSize,
      spellcheck: settingsRef.current.spellcheck,
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
    void (async () => {
      await loadInitialSettings()
      const restored = await restoreSavedSession()
      if (!restored) {
        await restoreDraft()
      }
    })()
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
    document.documentElement.style.setProperty("--omd-font-size", `${settings.fontSize}px`)
    document.documentElement.style.setProperty("--omd-line-height", `${settings.lineHeight}`)
    document.documentElement.style.setProperty("--omd-font-family", settings.fontFamily)
  }, [settings.fontSize, settings.lineHeight, settings.fontFamily])

  useEffect(() => {
    if (!services.saveSessionState || !mountedRef.current) return
    if (sessionSaveTimerRef.current) window.clearTimeout(sessionSaveTimerRef.current)
    sessionSaveTimerRef.current = window.setTimeout(() => {
      const state = extractSessionState(workspaceRef.current)
      void services.saveSessionState?.(state)
    }, 1000)
    return () => {
      if (sessionSaveTimerRef.current) window.clearTimeout(sessionSaveTimerRef.current)
    }
  }, [workspace.folder, workspace.tabs, workspace.activeId, services])

  useEffect(() => {
    applyTheme(theme, customCss)
  }, [theme, customCss])

  useEffect(() => {
    document.documentElement.dataset.typewriter = typewriter ? "on" : "off"
    document.documentElement.dataset.focus = focusMode ? "on" : "off"
  }, [typewriter, focusMode])

  useEffect(() => {
    writeSidebarOpen(sidebarOpen)
  }, [sidebarOpen])

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

  useEffect(() => {
    return () => {
      if (outlineHoverTimerRef.current) window.clearTimeout(outlineHoverTimerRef.current)
    }
  }, [])

  function handleOutlineMouseEnter() {
    if (outlineOpen) return
    if (outlineHoverTimerRef.current) window.clearTimeout(outlineHoverTimerRef.current)
    outlineHoverTimerRef.current = window.setTimeout(() => {
      setOutline(documentOutline(viewRef.current))
      setOutlineHover(true)
    }, 180)
  }

  function handleOutlineMouseLeave() {
    if (outlineHoverTimerRef.current) window.clearTimeout(outlineHoverTimerRef.current)
    outlineHoverTimerRef.current = window.setTimeout(() => {
      setOutlineHover(false)
    }, 120)
  }

  function applySpellcheck(on: boolean) {
    for (const view of viewsRef.current.values()) {
      try { setEditorSpellcheck(view, on) } catch { /* mock views */ }
    }
  }

  function handleSaveSettings(next: UserSettings) {
    const sanitized = sanitizeSettings(next)
    if (sanitized.spellcheck !== settingsRef.current.spellcheck) {
      applySpellcheck(sanitized.spellcheck)
    }
    setSettings(sanitized)
    settingsRef.current = sanitized
    setTheme(sanitized.theme)
    void services.saveSettings?.(sanitized)
  }

  async function loadInitialSettings(): Promise<UserSettings> {
    if (!services.getSettings) return DEFAULT_SETTINGS
    try {
      const saved = await services.getSettings()
      if (saved) {
        if (mountedRef.current) {
          if (saved.spellcheck !== settingsRef.current.spellcheck) {
            applySpellcheck(saved.spellcheck)
          }
          setSettings(saved)
          settingsRef.current = saved
          setTheme(saved.theme)
        }
        return saved
      }
    } catch {
      /* tolerate settings read failure */
    }
    return DEFAULT_SETTINGS
  }

  async function restoreSavedSession(): Promise<boolean> {
    if (!services.getSessionState) return false
    try {
      const state = await services.getSessionState()
      if (!state || (!state.folder && state.openPaths.length === 0)) return false

      if (state.folder) {
        commitWorkspace(openFolder(workspaceRef.current, state.folder))
        void services.allowWorkspaceDir?.(state.folder)
      }

      if (state.openPaths.length > 0) {
        let currentWorkspace = workspaceRef.current
        let activeTabId = currentWorkspace.activeId
        let firstTabOpened = false

        for (const path of state.openPaths) {
          try {
            const snapshot = await services.readDocument(path)
            if (snapshot.kind === "missing") continue
            await services.allowDocumentAssets(path)
            const contents = snapshot.contents
            if (!firstTabOpened) {
              const updated = openSession(currentWorkspace.tabs[0], snapshot)
              docsRef.current.set(updated.id, contents)
              currentWorkspace = replaceTabSession(currentWorkspace, updated)
              firstTabOpened = true
              if (state.activePath === path) activeTabId = updated.id
            } else {
              const newSession = openSession(createSession(currentWorkspace.nextId), snapshot)
              docsRef.current.set(newSession.id, contents)
              currentWorkspace = addTab(currentWorkspace, newSession)
              if (state.activePath === path) activeTabId = newSession.id
            }
          } catch {
            /* skip unreadable files */
          }
        }

        if (firstTabOpened) {
          currentWorkspace = focusTab(currentWorkspace, activeTabId)
          commitWorkspace(currentWorkspace)
          const active = activeSession(currentWorkspace)
          syncDoc(docsRef.current.get(active.id) ?? "", active.id)
          sessionRestoredRef.current = true
          return true
        }
      }
    } catch {
      /* tolerate session restore failure */
    }
    return false
  }

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
    const prefix = folder === "/" ? folder : `${folder}/`
    while (current && current !== folder && current.startsWith(prefix)) {
      dirs.unshift(current)
      const above = parentDir(current)
      if (above === current) break
      current = above
    }
    for (const dir of dirs) {
      // Ensure the ancestor is expanded without toggling: the user may have
      // already opened it, and expandToPath must never collapse it.
      if (!treeModelRef.current.expanded.has(dir)) {
        commitTree(toggleExpand(treeModelRef.current, dir))
      }
      if (treeModelRef.current.childrenByPath[dir] || pendingListDirsRef.current.has(dir)) continue
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

  const runFormat = (command: (view: EditorView) => boolean): (() => void) => () => {
    const view = viewRef.current
    if (view) try { command(view) } catch { /* mock views */ }
  }

  const insertImage = () => {
    const view = viewRef.current
    const active = sessionRef.current
    if (!view) return
    void pickAndInsertImage(view, imageInsertOptions(active.id, active.documentId))
  }

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
    { id: "preferences", label: "Preferences / Settings…", shortcut: "⌘,", run: () => setSettingsOpen(true) },
    { id: "sidebar", label: "Toggle sidebar", shortcut: "⌘\\", run: () => setSidebarOpen(open => !open) },
    { id: "outline", label: "Toggle outline", shortcut: "⇧⌘O", run: () => setOutlineOpen(open => !open) },
    { id: "typewriter", label: "Toggle typewriter", run: () => setTypewriter(on => !on) },
    { id: "source", label: "Toggle live/source", shortcut: "⌘E", run: () => {
      const view = viewRef.current
      if (view) try { view.dispatch(applyToggle(view.state)) } catch { /* mock views */ }
    } },
    { id: "bold", label: "Bold", shortcut: "⌘B", run: runFormat(toggleBold) },
    { id: "italic", label: "Italic", shortcut: "⌘I", run: runFormat(toggleItalic) },
    { id: "strikethrough", label: "Strikethrough", shortcut: "⇧⌘X", run: runFormat(toggleStrikethrough) },
    { id: "inline-code", label: "Inline code", shortcut: "⇧⌘`", run: runFormat(toggleInlineCode) },
    { id: "code-block", label: "Code block", shortcut: "⇧⌘K", run: runFormat(toggleCodeBlock) },
    { id: "heading-1", label: "Heading 1", shortcut: "⌘1", run: runFormat(toggleHeading(1)) },
    { id: "heading-2", label: "Heading 2", shortcut: "⌘2", run: runFormat(toggleHeading(2)) },
    { id: "heading-3", label: "Heading 3", shortcut: "⌘3", run: runFormat(toggleHeading(3)) },
    { id: "heading-4", label: "Heading 4", shortcut: "⌘4", run: runFormat(toggleHeading(4)) },
    { id: "heading-5", label: "Heading 5", shortcut: "⌘5", run: runFormat(toggleHeading(5)) },
    { id: "heading-6", label: "Heading 6", shortcut: "⌘6", run: runFormat(toggleHeading(6)) },
    { id: "ordered-list", label: "Ordered list", shortcut: "⌥⌘7", run: runFormat(toggleOrderedList) },
    { id: "unordered-list", label: "Unordered list", shortcut: "⌥⌘8", run: runFormat(toggleUnorderedList) },
    { id: "blockquote", label: "Blockquote", shortcut: "⌥⌘9", run: runFormat(toggleBlockquote) },
    { id: "link", label: "Insert link", shortcut: "⌘K", run: runFormat(insertLink) },
    { id: "insert-image", label: "Insert image…", run: insertImage },
    { id: "find", label: "Find in document", shortcut: "⌘F", run: () => {
      setFindOpen(true)
      setReplaceOpen(false)
    } },
    { id: "search", label: "Search in folder", shortcut: "⇧⌘F", run: () => setSearchOpen(true) },
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

  function closeFind() {
    setFindOpen(false)
    setReplaceOpen(false)
    try { viewRef.current?.focus() } catch { /* mock views */ }
  }

  function goFind(direction: "next" | "prev") {
    const view = viewRef.current
    const query = findQueryRef.current
    if (!view || query === "") return
    let doc: string
    try { doc = view.state.doc.toString() } catch { doc = docRef.current }
    const matches = collectMatches(doc, query, findCaseRef.current)
    if (matches.length === 0) {
      setFindIndex(-1)
      return
    }
    const index = direction === "next"
      ? nextIndex(matches.length, findIndexRef.current)
      : prevIndex(matches.length, findIndexRef.current)
    const match = matches[index]
    try {
      view.dispatch({
        selection: { anchor: match.from, head: match.to },
        scrollIntoView: true,
      })
    } catch { /* mock views */ }
    setFindIndex(index)
  }

  function replaceCurrent() {
    const view = viewRef.current
    const query = findQueryRef.current
    if (!view || query === "") return
    let doc: string
    try { doc = view.state.doc.toString() } catch { doc = docRef.current }
    const matches = collectMatches(doc, query, findCaseRef.current)
    if (matches.length === 0) return
    const index = findIndexRef.current >= 0 && findIndexRef.current < matches.length
      ? findIndexRef.current
      : 0
    const match = matches[index]
    const replacement = findReplaceRef.current
    try {
      view.dispatch({
        changes: { from: match.from, to: match.to, insert: replacement },
        selection: { anchor: match.from, head: match.from + replacement.length },
        scrollIntoView: true,
      })
    } catch { /* mock views */ }
  }

  function replaceEvery() {
    const view = viewRef.current
    const query = findQueryRef.current
    if (!view || query === "") return
    let doc: string
    try { doc = view.state.doc.toString() } catch { doc = docRef.current }
    const next = replaceAll(doc, query, findReplaceRef.current, findCaseRef.current)
    if (next === doc) return
    try {
      view.dispatch({ changes: { from: 0, to: doc.length, insert: next } })
    } catch { /* mock views */ }
  }

  const goFindRef = useRef(goFind)
  const closeFindRef = useRef(closeFind)
  goFindRef.current = goFind
  closeFindRef.current = closeFind

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      if (e.key === "Escape" && findOpenRef.current) {
        e.preventDefault()
        closeFindRef.current()
        return
      }
      if (e.key === "p" && e.shiftKey && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setPaletteOpen(open => !open)
        return
      }
      if (!e.metaKey && !e.ctrlKey) return
      if (e.key === ",") {
        e.preventDefault()
        setSettingsOpen(open => !open)
      } else if (e.key === "\\") {
        e.preventDefault()
        setSidebarOpen(open => !open)
      } else if (e.key === "O" && e.shiftKey) {
        e.preventDefault()
        setOutlineOpen(open => !open)
      } else if ((e.key === "f" || e.key === "F") && e.shiftKey) {
        e.preventDefault()
        setSearchOpen(true)
      } else if (e.key === "f" || e.key === "F") {
        e.preventDefault()
        setFindOpen(true)
        setReplaceOpen(false)
      } else if (e.key === "h" || e.key === "H") {
        e.preventDefault()
        setFindOpen(true)
        setReplaceOpen(true)
      } else if ((e.key === "g" || e.key === "G") && findOpenRef.current) {
        e.preventDefault()
        goFindRef.current(e.shiftKey ? "prev" : "next")
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
  const stats = documentStats(doc)

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
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen(open => !open)}
        onFocusTab={activateTab}
        onCloseTab={requestCloseTab}
        onNewTab={newTab}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <div className="workspace-body">
        <aside
          id="primary-sidebar"
          className={`sidebar-primary${sidebarOpen ? "" : " is-hidden"}`}
          aria-hidden={!sidebarOpen}
          inert={!sidebarOpen}
        >
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
              onCollapse={() => setSidebarOpen(false)}
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
        <div
          className="outline-toggle-strip"
          onMouseEnter={handleOutlineMouseEnter}
          onMouseLeave={handleOutlineMouseLeave}
        >
          <button
            type="button"
            className={`outline-toggle-btn${outlineOpen ? " is-active" : ""}`}
            onClick={() => {
              if (outlineHoverTimerRef.current) window.clearTimeout(outlineHoverTimerRef.current)
              setOutlineHover(false)
              setOutlineOpen(open => !open)
            }}
            aria-expanded={outlineOpen}
            aria-controls="outline-panel"
            aria-label={outlineOpen ? "Hide outline" : "Show outline"}
            title={outlineOpen ? "Hide outline (⇧⌘O)" : "Show outline (⇧⌘O)"}
          >
            {outlineOpen ? <PanelLeftClose size={16} /> : <PanelLeft size={16} />}
          </button>
          {!outlineOpen && outlineHover ? (
            <div className="outline-hover-popover" role="dialog" aria-label="Outline preview">
              <div className="outline-hover-header">
                <span className="outline-hover-title">Outline</span>
                <span className="outline-hover-hint">Click to expand</span>
              </div>
              <div className="outline-hover-body">
                {outline.length === 0 ? (
                  <div className="sidebar-empty">No headings</div>
                ) : (
                  outline.map(item => (
                    <button
                      key={`${item.from}-${item.text}`}
                      type="button"
                      className={`outline-item level-${item.level}`}
                      onClick={() => {
                        const view = viewRef.current
                        if (!view) return
                        try {
                          view.dispatch({ selection: { anchor: item.from } })
                          view.focus()
                        } catch { /* mock views */ }
                        setOutlineHover(false)
                      }}
                    >
                      {item.text}
                    </button>
                  ))
                )}
              </div>
            </div>
          ) : null}
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
          <FindReplaceBar
            open={findOpen}
            query={findQuery}
            replacement={findReplace}
            caseSensitive={findCase}
            replaceOpen={replaceOpen}
            matchCount={collectMatches(doc, findQuery, findCase).length}
            activeIndex={findIndex}
            onQuery={query => {
              setFindQuery(query)
              setFindIndex(-1)
            }}
            onReplacement={setFindReplace}
            onCaseSensitive={value => {
              setFindCase(value)
              setFindIndex(-1)
            }}
            onNext={() => goFind("next")}
            onPrev={() => goFind("prev")}
            onReplace={replaceCurrent}
            onReplaceAll={replaceEvery}
            onClose={closeFind}
          />
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
        words={stats.words}
        chars={stats.chars}
        cursor={cursor}
        mode={mode}
        normalizationReviewRequired={bannerKind === "normalization"}
        saveStatus={saveStatusLabel(activeSaveState)}
      />
      {paletteOpen ? (
        <CommandPalette commands={commands} onClose={() => setPaletteOpen(false)} />
      ) : null}
      <SettingsModal
        isOpen={settingsOpen}
        settings={settings}
        onSave={handleSaveSettings}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  )
}
