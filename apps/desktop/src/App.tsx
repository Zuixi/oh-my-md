import { useEffect, useMemo, useRef, useState } from "react"
import {
  createEditor, documentOutline, editorStatus, makeImageResolver, resetEditorDocument, setEditorSpellcheck,
  type CreateEditorOptions, type EditorDocumentUpdate,
} from "./Editor"
import type { EditorView } from "@codemirror/view"
import {
  applyToggle, documentStats, isLivePreview, SAFE_MODE_RENDER_BUDGET_LINES,
  setBlockRenderBudget, setLivePreview, type OutlineItem,
} from "@omd/engine"
import { pickAndInsertImage, type ImagePasteOptions } from "./imagePaste"
import {
  advanceDocumentIdentity, createSession, openSession, recoveryKey,
  retargetSessionPath, sessionDirty, sessionPath, type EditorSession,
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
  DURABILITY_WARNING,
  saveStatusLabel,
  tabHasConflict,
} from "./documentSaveRunner"
import { createTransientStatusNotifier } from "./transientStatus"
import {
  initialSaveState,
  removeTabSaveState,
  tabSaveState,
  type SaveStateByTab,
} from "./documentSaveState"
import { NormalizationBanner } from "./NormalizationBanner"
import { UpdateBanner } from "./UpdateBanner"
import { applyTheme, toggleTheme, type AppTheme } from "./theme"
import { runMenuCommand, type AppCommand } from "./commands"
import { matchesWindowShortcut, shortcutFor, WINDOW_SHORTCUTS } from "./shortcuts"
import { rememberPath } from "./recents"
import { defaultServices, errorMessage, toDocumentCommandError, type DesktopServices, type SnapshotEntry } from "./desktopServices"
import {
  collectMatches,
  nextIndex,
  prevIndex,
  replaceAll,
  validateFindPattern,
  type FindQuery,
} from "./findReplace"
import { FindReplaceBar } from "./FindReplaceBar"
import type { SaveTrigger } from "./normalizationCoordinator"
import type { SaveMode } from "./documentSaveRunner"
import { StatusBar } from "./StatusBar"
import { LargeDocBanner } from "./LargeDocBanner"
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
import { QuickOpenModal } from "./QuickOpenModal"
import { VersionHistoryModal } from "./VersionHistoryModal"
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
import { initLocale, setLocale, useT } from "./i18n"
import {
  LARGE_DOC_LINES,
  MARKDOWN_EXTENSIONS,
  MARKDOWN_FILE_EXTENSION,
  RELEASES_URL,
  SAFE_MODE_LINES,
  STORAGE_KEY_OUTLINE_OPEN,
  STORAGE_KEY_SIDEBAR_OPEN,
} from "./constants"
import { extractSessionState,
} from "./sessionRestore"
import "./styles.css"

export type { DesktopServices, RecoveryRecord } from "./desktopServices"

interface AppProps {
  services?: DesktopServices
  autosaveMs?: number
  watchMs?: number
  /** Spec 05a 拉取式物化的 trailing 窗口。0 = 同步物化（测试专用时序缝隙，同 autosaveMs 先例）。 */
  docMaterializeMs?: number
}

const OUTLINE_DEBOUNCE_MS = 150
// documentStats 是全文档逐字符扫描；防抖后离开每键同步路径（Spec 05）。
const STATS_DEBOUNCE_MS = 250
// Spec 05a：每键不物化整文档字符串；250ms trailing 从 view 拉取（消费前 flush）。
const DOC_MATERIALIZE_MS = 250
const OUTLINE_HOVER_OPEN_MS = 180
const OUTLINE_HOVER_CLOSE_MS = 120
const SEARCH_DEBOUNCE_MS = 200
const SESSION_SAVE_DEBOUNCE_MS = 1000

/** Startup update check delay: late enough to stay off the launch path. */
const UPDATE_CHECK_DELAY_MS = 8000

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

function replaceTreePrefix(path: string, from: string, to: string): string {
  if (path === from) return to
  return path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : path
}

function removeTreePath(model: FileTreeModel, path: string): FileTreeModel {
  const prefix = `${path}/`
  const childrenByPath = Object.fromEntries(
    Object.entries(model.childrenByPath)
      .filter(([key]) => key !== path && !key.startsWith(prefix))
      .map(([key, entries]) => [
        key,
        entries.filter(entry => entry.path !== path && !entry.path.startsWith(prefix)),
      ]),
  )
  const expanded = new Set(
    [...model.expanded].filter(entryPath => entryPath !== path && !entryPath.startsWith(prefix)),
  )
  return { childrenByPath, expanded }
}

function renameTreePath(model: FileTreeModel, from: string, to: string): FileTreeModel {
  const childrenByPath = Object.fromEntries(
    Object.entries(model.childrenByPath).map(([key, entries]) => [
      replaceTreePrefix(key, from, to),
      entries.map(entry => ({
        ...entry,
        path: replaceTreePrefix(entry.path, from, to),
      })),
    ]),
  )
  const expanded = new Set([...model.expanded].map(path => replaceTreePrefix(path, from, to)))
  return { childrenByPath, expanded }
}

function readSidebarOpen(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY_SIDEBAR_OPEN) !== "0"
  } catch {
    return true
  }
}

function writeSidebarOpen(open: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY_SIDEBAR_OPEN, open ? "1" : "0")
  } catch { /* storage unavailable */ }
}

function readOutlineOpen(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY_OUTLINE_OPEN) === "1"
  } catch {
    return false
  }
}

function writeOutlineOpen(open: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY_OUTLINE_OPEN, open ? "1" : "0")
  } catch { /* storage unavailable (tests, private mode) */ }
}

export default function App({
  services = defaultServices,
  autosaveMs = 1500,
  // Fallback poll only: native notify events drive day-to-day refreshes.
  watchMs = 30000,
  docMaterializeMs = DOC_MATERIALIZE_MS,
}: AppProps) {
  const t = useT()
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
  const [updateVersion, setUpdateVersion] = useState<string | null>(null)
  const openingRef = useRef(false)
  const mountedRef = useRef(false)
  const [settings, setSettings] = useState<UserSettings>(DEFAULT_SETTINGS)
  const settingsRef = useRef<UserSettings>(settings)
  const localeInitRef = useRef(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const sessionSaveTimerRef = useRef<number | null>(null)
  const sessionRestoredRef = useRef(false)
  const [theme, setTheme] = useState<AppTheme>("light")
  const [customCss, setCustomCss] = useState("")
  const [focusMode, setFocusMode] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(readSidebarOpen)
  const [outlineOpen, setOutlineOpen] = useState(readOutlineOpen)
  const [typewriter, setTypewriter] = useState(false)
  const [sourceMode, setSourceMode] = useState(false)
  // Spec 05a：拉取式物化——doc 更新只发轻量信号，内容按 250ms 节奏从 view 拉取。
  const pendingDocTabsRef = useRef(new Set<number>())
  const docMaterializeTimerRef = useRef<number | null>(null)
  // 每键（仅 docChanged，纯选区更新在 reportEditorUpdate 已早退）触发一次 O(UI) 重渲染：
  // 状态栏光标列号在渲染期读 viewRef（editorStatus），需要每键刷新才能与 05a 前行为一致。
  // stats/find 均不在此渲染路径上（memo/防抖），不会引入 O(doc)。
  const [, setDocVersion] = useState(0)
  // Spec 05：安全模式。choice 只存内存（本会话），不写 localStorage、不进 session 持久化。
  const safeModeChoiceRef = useRef(new Map<number, boolean>())
  const [largeDocNotice, setLargeDocNotice] = useState<
    { sessionId: number; lines: number; safeMode: boolean } | null
  >(null)
  const [statsRequested, setStatsRequested] = useState(0)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [quickOpenState, setQuickOpenState] = useState<{
    open: boolean
    files: string[]
    truncated: boolean
    loading: boolean
  }>({ open: false, files: [], truncated: false, loading: false })
  const [historyState, setHistoryState] = useState<{
    open: boolean
    path: string | null
    entries: SnapshotEntry[]
    loading: boolean
  }>({ open: false, path: null, entries: [], loading: false })
  const [searchOpen, setSearchOpen] = useState(false)
  const searchOpenRef = useRef(searchOpen)
  searchOpenRef.current = searchOpen
  const [searchQuery, setSearchQuery] = useState("")
  const [searchHits, setSearchHits] = useState<SearchHit[]>([])
  const [searchTruncated, setSearchTruncated] = useState(false)
  const [searchCase, setSearchCase] = useState(false)
  const searchRequestRef = useRef(0)
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState("")
  const [findReplace, setFindReplace] = useState("")
  const [findCase, setFindCase] = useState(false)
  const [findRegexMode, setFindRegexMode] = useState(false)
  const [findWholeWord, setFindWholeWord] = useState(false)
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
  const findRegexModeRef = useRef(findRegexMode)
  findRegexModeRef.current = findRegexMode
  const findWholeWordRef = useRef(findWholeWord)
  findWholeWordRef.current = findWholeWord
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
    getContents: tabId => {
      if (pendingDocTabsRef.current.has(tabId)) materializePendingDocs()
      return docsRef.current.get(tabId) ?? ""
    },
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
    getContents: tabId => {
      if (pendingDocTabsRef.current.has(tabId)) materializePendingDocs()
      return docsRef.current.get(tabId) ?? ""
    },
    getNormalization: () => normalizationRef.current,
    setNormalization: commitNormalization,
    getWorkspace: () => workspaceRef.current,
    setWorkspace: commitWorkspace,
    getViews: () => viewsRef.current,
    getSaveStates: () => saveStateRef.current,
    setSaveStates: commitSaveState,
    revealFolder,
    rememberRecent,
    onSaved: path => { void services.snapshotDocument?.(path).catch(() => undefined) },
    syncDoc,
    clearRecovery: key => { void services.clearRecovery?.(key) },
    onDurabilityWarning: () => showTransientStatus(t(DURABILITY_WARNING)),
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

  function invalidName(name: string): boolean {
    return (
      !name
      || name === "."
      || name === `.${MARKDOWN_FILE_EXTENSION}`
      || name.includes("/")
      || name.includes("\\")
      || name.includes("..")
    )
  }

  function normalizeMarkdownName(name: string): string {
    const trimmed = name.trim()
    return trimmed.toLowerCase().endsWith(`.${MARKDOWN_FILE_EXTENSION}`)
      ? trimmed
      : `${trimmed}.${MARKDOWN_FILE_EXTENSION}`
  }

  async function refreshTreePath(path: string): Promise<void> {
    if (!services.listDir) return
    try {
      const entries = await services.listDir(path)
      commitTree(setChildren(treeModelRef.current, path, entries))
    } catch (error) {
      services.reportError(errorMessage(t("error.folderListingFailed"), error))
    }
  }

  async function nextUntitledMarkdownName(dir: string): Promise<string> {
    if (!services.listDir) return `untitled.${MARKDOWN_FILE_EXTENSION}`
    const entries = await services.listDir(dir)
    const names = new Set(entries.map(entry => entry.name))
    if (!names.has(`untitled.${MARKDOWN_FILE_EXTENSION}`)) return `untitled.${MARKDOWN_FILE_EXTENSION}`
    let suffix = 2
    while (names.has(`untitled-${suffix}.${MARKDOWN_FILE_EXTENSION}`)) suffix += 1
    return `untitled-${suffix}.${MARKDOWN_FILE_EXTENSION}`
  }

  function retargetOpenTabs(from: string, to: string, isDir: boolean): void {
    const previousTabs = workspaceRef.current.tabs
    const nextTabs = previousTabs.map(tab => {
      const path = sessionPath(tab)
      if (!path) return tab
      if (path === from) return retargetSessionPath(tab, to)
      if (isDir && path.startsWith(`${from}/`)) {
        return retargetSessionPath(tab, `${to}${path.slice(from.length)}`)
      }
      return tab
    })
    if (nextTabs.every((tab, index) => tab === previousTabs[index])) return
    previousTabs.forEach((tab, index) => {
      const next = nextTabs[index]
      if (tab === next) return
      const oldKey = recoveryKey(tab)
      if (oldKey !== recoveryKey(next)) void services.clearRecovery?.(oldKey)
      const contents = docsRef.current.get(next.id)
      if (contents !== undefined && sessionDirty(next, contents)) saveRecovery(next, contents)
    })
    commitWorkspace({ ...workspaceRef.current, tabs: nextTabs })
    const affectedPaths = nextTabs
      .map(tab => sessionPath(tab))
      .filter((path): path is string => path !== null)
      .filter(path => path === to || (isDir && path.startsWith(`${to}/`)))
    for (const path of new Set(affectedPaths)) {
      void services.allowDocumentAssets(path)
    }
  }

  function saveRecovery(tab: EditorSession, contents: string) {
    void recoveryWriterRef.current.save(
      { tabId: tab.id, key: recoveryKey(tab), path: sessionPath(tab), contents },
      { write: services.writeRecovery, reportError: reportUserError },
    )
  }

  /** Applies an update to the tab it was built for, or drops stale bindings. */
  /** 把 pending tab 的最新内容从 view 拉进 docsRef/React state，并跟随恢复写节奏。 */
  function materializePendingDocs() {
    if (docMaterializeTimerRef.current !== null) {
      window.clearTimeout(docMaterializeTimerRef.current)
      docMaterializeTimerRef.current = null
    }
    for (const tabId of [...pendingDocTabsRef.current]) {
      pendingDocTabsRef.current.delete(tabId)
      const view = viewsRef.current.get(tabId)
      if (!view) continue
      const contents = view.state.doc.toString()
      syncDoc(contents, tabId)
      const tab = workspaceRef.current.tabs.find(t => t.id === tabId)
      if (tab) saveRecovery(tab, contents)
    }
  }

  function flushPendingDocs() {
    materializePendingDocs()
  }

  function handleDocumentUpdate(update: EditorDocumentUpdate) {
    const tab = tabById(update.tabId)
    if (!tab || tab.documentId !== update.documentId) return
    if (update.docChanged) {
      pendingDocTabsRef.current.add(update.tabId)
      if (docMaterializeMs === 0) {
        materializePendingDocs()
      } else if (docMaterializeTimerRef.current === null) {
        docMaterializeTimerRef.current = window.setTimeout(
          () => materializePendingDocs(),
          docMaterializeMs,
        )
      }
      setDocVersion(v => v + 1)
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
          services.reportError(errorMessage(t("error.openFailed"), new Error("File not found")))
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
    // Spec 05：超大文档进入安全模式 —— 默认源码模式 + 块渲染预算 + 一次性提示
    // + 按需字数。用户本会话内显式切换过模式的 tab 不再强制。
    const lines = contents ? contents.split("\n").length : 0
    const safeMode = lines > SAFE_MODE_LINES
      && safeModeChoiceRef.current.get(nextSession.id) === undefined
    if (safeMode) {
      try { view.dispatch(setLivePreview(false)) } catch { /* mock views */ }
      setBlockRenderBudget(SAFE_MODE_RENDER_BUDGET_LINES)
    } else {
      setBlockRenderBudget(Infinity)
    }
    setLargeDocNotice(
      safeMode
        ? { sessionId: nextSession.id, lines, safeMode: true }
        : lines > LARGE_DOC_LINES
          ? { sessionId: nextSession.id, lines, safeMode: false }
          : null,
    )
    setStatsRequested(0)
    // 重载内容即最新：清掉 pending，防止物化用旧 view 内容覆盖（Spec 05a）。
    pendingDocTabsRef.current.delete(nextSession.id)
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
      const initial = await loadInitialSettings()
      if (!localeInitRef.current) {
        localeInitRef.current = true
        initLocale(initial.locale, locale => { void services.setMenuLocale?.(locale) })
      }
      const pendingOpen = await services.takePendingOpenFiles?.() ?? []
      if (pendingOpen.length > 0) {
        // An explicit launch request (double-click / Open With) wins over
        // restoring the previous session.
        for (const path of pendingOpen) openRecentRef.current(path)
      } else {
        const restored = await restoreSavedSession()
        if (!restored) {
          await restoreDraft()
        }
      }
    })()
    return () => {
      mountedRef.current = false
      if (docMaterializeTimerRef.current !== null) window.clearTimeout(docMaterializeTimerRef.current)
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
    }, SESSION_SAVE_DEBOUNCE_MS)
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
      if (!cancelled) services.reportError(errorMessage(t("error.folderListingFailed"), error))
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

  // Native notify events are the primary external-change channel; the slow
  // interval above is only a safety net for dropped events.
  useEffect(() => {
    if (!services.listenWorkspaceChange) return
    return services.listenWorkspaceChange(() => {
      void pollFileTabsRef.current()
      const listDir = services.listDir
      if (listDir && workspaceRef.current.folder && !searchOpenRef.current) {
        void refreshTreeRef.current(listDir)
      }
    })
  }, [services])

  // Keep the Rust watch set in sync with the folder and open files outside it.
  useEffect(() => {
    if (!services.watchPaths) return
    const folder = workspace.folder
    const paths = new Set<string>()
    if (folder) paths.add(folder)
    for (const tab of workspace.tabs) {
      const path = sessionPath(tab)
      if (path && (!folder || !path.startsWith(`${folder}/`))) paths.add(path)
    }
    void services.watchPaths([...paths])
  }, [workspace.folder, workspace.tabs, services])

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
    }, OUTLINE_HOVER_OPEN_MS)
  }

  function handleOutlineMouseLeave() {
    if (outlineHoverTimerRef.current) window.clearTimeout(outlineHoverTimerRef.current)
    outlineHoverTimerRef.current = window.setTimeout(() => {
      setOutlineHover(false)
    }, OUTLINE_HOVER_CLOSE_MS)
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
    const localeChanged = sanitized.locale !== settingsRef.current.locale
    setSettings(sanitized)
    settingsRef.current = sanitized
    setTheme(sanitized.theme)
    void services.saveSettings?.(sanitized)
    if (localeChanged) setLocale(sanitized.locale)
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
        reportUserError(t("error.invalidPath"))
        return
      }
      if (cmd.code === "notUtf8" && mountedRef.current) {
        reportUserError(t("error.notUtf8"))
        return
      }
      if (request === openRequestRef.current && mountedRef.current) {
        services.reportError(errorMessage(t("error.openFailed"), error))
      }
      return
    }
    if (request !== undefined && request !== openRequestRef.current) return
    if (snapshot.kind === "missing") {
      if (mountedRef.current) {
        services.reportError(errorMessage(t("error.openFailed"), new Error("File not found")))
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
    flushPendingDocs()
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
        services.reportError(errorMessage(t("error.openFailed"), error))
      }
    } finally {
      if (request === openRequestRef.current) openingRef.current = false
    }
  }

  function openRecent(path: string) {
    return runOpen(async () => path)
  }

  async function checkForUpdatesNow(manual: boolean) {
    if (!services.checkForUpdates) return
    const update = await services.checkForUpdates()
    if (!mountedRef.current) return
    if (update) {
      setUpdateVersion(update.version)
    } else if (manual) {
      showTransientStatus(t("update.upToDate"))
    }
  }

  async function openQuickOpen() {
    const folder = workspaceRef.current.folder
    if (!folder) {
      showTransientStatus(t("quickOpen.noFolder"))
      return
    }
    if (!services.listMarkdownFiles) return
    setQuickOpenState({ open: true, files: [], truncated: false, loading: true })
    try {
      const response = await services.listMarkdownFiles(folder)
      if (!mountedRef.current) return
      setQuickOpenState({
        open: true,
        files: response.paths,
        truncated: response.truncated,
        loading: false,
      })
    } catch (error) {
      if (mountedRef.current) {
        setQuickOpenState(current => ({ ...current, loading: false }))
        services.reportError(errorMessage(t("error.openFailed"), error))
      }
    }
  }

  async function openVersionHistory() {
    const tab = tabById(workspaceRef.current.activeId)
    const path = tab ? sessionPath(tab) : null
    if (!path) {
      showTransientStatus(t("history.noFile"))
      return
    }
    if (!services.listSnapshots) return
    setHistoryState({ open: true, path, entries: [], loading: true })
    try {
      const entries = await services.listSnapshots(path)
      if (mountedRef.current) {
        setHistoryState({ open: true, path, entries, loading: false })
      }
    } catch (error) {
      if (mountedRef.current) {
        setHistoryState(current => ({ ...current, loading: false }))
        services.reportError(errorMessage(t("history.failed"), error))
      }
    }
  }

  function restoreSnapshot(entry: SnapshotEntry) {
    const path = historyState.path
    if (!path || !services.readSnapshot) return
    void services.readSnapshot(path, entry.fileName)
      .then(contents => {
        if (!mountedRef.current) return
        newTab()
        resetTabDocumentRef.current(advanceDocumentIdentity(sessionRef.current), contents)
        setHistoryState(current => ({ ...current, open: false }))
      })
      .catch(() => undefined)
  }

  function clearSnapshotHistory() {
    const path = historyState.path
    if (!path) return
    void services.clearSnapshots?.(path)
      .then(() => {
        if (mountedRef.current) {
          setHistoryState(current => ({ ...current, entries: [] }))
        }
      })
      .catch(() => undefined)
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

  function closeTabInternal(
    id: number,
    options: { confirm: boolean; allowReplaceLast: boolean },
  ): boolean {
    const tab = tabById(id)
    if (!tab) return false
    const contents = docsRef.current.get(id) ?? ""
    if (
      options.confirm
      && sessionDirty(tab, contents)
      && !(services.confirmClose ?? services.confirmDiscard)()
    ) {
      return false
    }
    let currentWorkspace = workspaceRef.current
    if (options.allowReplaceLast && currentWorkspace.tabs.length === 1) {
      const replacement = createSession(currentWorkspace.nextId)
      docsRef.current.set(replacement.id, "")
      commitSaveState({ ...saveStateRef.current, [replacement.id]: initialSaveState() })
      currentWorkspace = addTab(currentWorkspace, replacement)
    }
    // Per-tab state is dropped when the tab really disappears; closeTab keeps a lone tab open.
    const closed = closeTab(currentWorkspace, id)
    if (!closed.tabs.some(item => item.id === id)) {
      commitNormalization(clearTabNormalization(normalizationRef.current, id))
      commitSaveState(removeTabSaveState(saveStateRef.current, id))
      recoveryWriterRef.current.forget(id)
      docsRef.current.delete(id)
      viewsRef.current.get(id)?.destroy()
      viewsRef.current.delete(id)
    }
    commitWorkspace(closed)
    const active = activeSession(closed)
    viewRef.current = viewsRef.current.get(active.id) ?? viewRef.current
    syncDoc(docsRef.current.get(active.id) ?? "", active.id)
    return !closed.tabs.some(item => item.id === id)
  }

  function requestCloseTab(id: number) {
    flushPendingDocs()
    closeTabInternal(id, { confirm: true, allowReplaceLast: false })
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
      services.reportError(errorMessage(t("error.folderListingFailed"), error))
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

  const pollFileTabsRef = useRef(pollFileTabs)
  const openRecentRef = useRef(openRecent)
  const refreshTreeRef = useRef(refreshTree)
  pollFileTabsRef.current = pollFileTabs
  openRecentRef.current = openRecent
  refreshTreeRef.current = refreshTree

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

  async function createTreeFile(dir: string) {
    if (!services.createMarkdown) return
    let defaultName = `untitled.${MARKDOWN_FILE_EXTENSION}`
    try {
      defaultName = await nextUntitledMarkdownName(dir)
    } catch (error) {
      services.reportError(errorMessage(t("error.folderListingFailed"), error))
      return
    }
    const rawName = window.prompt(t("filetree.prompt.newFile"), defaultName)
    if (rawName === null) return
    const name = normalizeMarkdownName(rawName)
    if (invalidName(name)) {
      reportUserError(t("error.emptyName"))
      return
    }
    try {
      await services.createMarkdown(dir, name)
      await refreshTreePath(dir)
    } catch (error) {
      services.reportError(errorMessage(t("error.createFileFailed"), error))
    }
  }

  async function createTreeFolder(dir: string) {
    if (!services.createDir) return
    const rawName = window.prompt(t("filetree.prompt.newFolder"), "untitled-folder")
    if (rawName === null) return
    const name = rawName.trim()
    if (invalidName(name)) {
      reportUserError(t("error.emptyName"))
      return
    }
    try {
      await services.createDir(dir, name)
      await refreshTreePath(dir)
    } catch (error) {
      services.reportError(errorMessage(t("error.createFolderFailed"), error))
    }
  }

  async function renameTreeEntry(entry: TreeEntry) {
    if (!services.renamePath) return
    const rawName = window.prompt(t("filetree.prompt.rename"), entry.name)
    if (rawName === null) return
    const name = entry.is_dir ? rawName.trim() : normalizeMarkdownName(rawName)
    if (name === entry.name) return
    if (invalidName(name)) {
      reportUserError(t("error.emptyName"))
      return
    }
    const dir = parentDir(entry.path)
    if (!dir) return
    try {
      const nextPath = await services.renamePath(entry.path, name)
      commitTree(renameTreePath(treeModelRef.current, entry.path, nextPath))
      retargetOpenTabs(entry.path, nextPath, entry.is_dir)
      await refreshTreePath(dir)
    } catch (error) {
      services.reportError(errorMessage(t("error.renameFailed"), error))
    }
  }

  async function deleteTreeEntry(entry: TreeEntry) {
    if (!services.deletePath) return
    // 脏检查前物化：250ms 窗口内的编辑必须被看见，否则跳过确认删文件丢内容（Spec 05a）。
    flushPendingDocs()
    const openTab = !entry.is_dir ? findTabByPath(workspaceRef.current, entry.path) : undefined
    if (
      openTab
      && sessionDirty(openTab, docsRef.current.get(openTab.id) ?? "")
      && !(services.confirmClose ?? services.confirmDiscard)()
    ) {
      return
    }
    const confirmDelete = services.confirmDelete
      ?? (path => defaultServices.confirmDelete?.(path) ?? true)
    if (!confirmDelete(entry.path)) return
    try {
      await services.deletePath(entry.path)
      commitTree(removeTreePath(treeModelRef.current, entry.path))
      if (openTab) closeTabInternal(openTab.id, { confirm: false, allowReplaceLast: true })
      const dir = parentDir(entry.path)
      if (dir) await refreshTreePath(dir)
    } catch (error) {
      services.reportError(errorMessage(t("error.deleteFailed"), error))
    }
  }

  const commands: AppCommand[] = [
    { id: "open", label: t("cmd.label.open"), shortcut: shortcutFor("open"), run: () => void openFile() },
    { id: "quick-open", label: t("cmd.label.quick-open"), shortcut: shortcutFor("quick-open"), run: () => void openQuickOpen() },
    { id: "save", label: t("cmd.label.save"), shortcut: shortcutFor("save"), run: () => void saveFile(workspaceRef.current.activeId, "explicit") },
    { id: "save-as", label: t("cmd.label.save-as"), shortcut: shortcutFor("save-as"), run: () => void saveFile(workspaceRef.current.activeId, "explicit", true) },
    { id: "folder", label: t("cmd.label.folder"), run: () => void chooseFolder() },
    { id: "tab", label: t("cmd.label.tab"), shortcut: shortcutFor("tab"), run: newTab },
    { id: "close", label: t("cmd.label.close"), shortcut: shortcutFor("close"), run: () => requestCloseTab(workspaceRef.current.activeId) },
    { id: "theme", label: t("cmd.label.theme"), run: () => setTheme(current => toggleTheme(current)) },
    { id: "css", label: t("cmd.label.css"), run: () => void loadCustomCss(services, setCustomCss) },
    { id: "focus", label: t("cmd.label.focus"), run: () => setFocusMode(on => !on) },
    { id: "preferences", label: t("cmd.label.preferences"), shortcut: shortcutFor("preferences"), run: () => setSettingsOpen(true) },
    { id: "sidebar", label: t("cmd.label.sidebar"), shortcut: shortcutFor("sidebar"), run: () => setSidebarOpen(open => !open) },
    { id: "outline", label: t("cmd.label.outline"), shortcut: shortcutFor("outline"), run: () => setOutlineOpen(open => !open) },
    { id: "typewriter", label: t("cmd.label.typewriter"), run: () => setTypewriter(on => !on) },
    { id: "source", label: t("cmd.label.source"), shortcut: shortcutFor("source"), run: () => {
      const view = viewRef.current
      if (!view) return
      try {
        const next = !view.state.field(isLivePreview)
        safeModeChoiceRef.current.set(workspaceRef.current.activeId, next)
        view.dispatch(applyToggle(view.state))
        setSourceMode(next)
      } catch { /* mock views */ }
    } },
    { id: "bold", label: t("cmd.label.bold"), shortcut: shortcutFor("bold"), run: runFormat(toggleBold) },
    { id: "italic", label: t("cmd.label.italic"), shortcut: shortcutFor("italic"), run: runFormat(toggleItalic) },
    { id: "strikethrough", label: t("cmd.label.strikethrough"), shortcut: shortcutFor("strikethrough"), run: runFormat(toggleStrikethrough) },
    { id: "inline-code", label: t("cmd.label.inline-code"), shortcut: shortcutFor("inline-code"), run: runFormat(toggleInlineCode) },
    { id: "code-block", label: t("cmd.label.code-block"), shortcut: shortcutFor("code-block"), run: runFormat(toggleCodeBlock) },
    { id: "heading-1", label: t("cmd.label.heading-1"), shortcut: shortcutFor("heading-1"), run: runFormat(toggleHeading(1)) },
    { id: "heading-2", label: t("cmd.label.heading-2"), shortcut: shortcutFor("heading-2"), run: runFormat(toggleHeading(2)) },
    { id: "heading-3", label: t("cmd.label.heading-3"), shortcut: shortcutFor("heading-3"), run: runFormat(toggleHeading(3)) },
    { id: "heading-4", label: t("cmd.label.heading-4"), shortcut: shortcutFor("heading-4"), run: runFormat(toggleHeading(4)) },
    { id: "heading-5", label: t("cmd.label.heading-5"), shortcut: shortcutFor("heading-5"), run: runFormat(toggleHeading(5)) },
    { id: "heading-6", label: t("cmd.label.heading-6"), shortcut: shortcutFor("heading-6"), run: runFormat(toggleHeading(6)) },
    { id: "ordered-list", label: t("cmd.label.ordered-list"), shortcut: shortcutFor("ordered-list"), run: runFormat(toggleOrderedList) },
    { id: "unordered-list", label: t("cmd.label.unordered-list"), shortcut: shortcutFor("unordered-list"), run: runFormat(toggleUnorderedList) },
    { id: "blockquote", label: t("cmd.label.blockquote"), shortcut: shortcutFor("blockquote"), run: runFormat(toggleBlockquote) },
    { id: "link", label: t("cmd.label.link"), shortcut: shortcutFor("link"), run: runFormat(insertLink) },
    { id: "insert-image", label: t("cmd.label.insert-image"), run: insertImage },
    { id: "find", label: t("cmd.label.find"), shortcut: shortcutFor("find"), run: () => {
      setFindOpen(true)
      setReplaceOpen(false)
    } },
    { id: "search", label: t("cmd.label.search"), shortcut: shortcutFor("search"), run: () => setSearchOpen(true) },
    { id: "export-html", label: t("cmd.label.export-html"), run: () => void exportCurrent(services, viewRef.current, "html", { resolveImageSrc: makeImageResolver(() => { const t = tabById(workspaceRef.current.activeId); return t ? sessionPath(t) : null }) }) },
    { id: "export-pdf", label: t("cmd.label.export-pdf"), run: () => void exportCurrent(services, viewRef.current, "pdf", { resolveImageSrc: makeImageResolver(() => { const t = tabById(workspaceRef.current.activeId); return t ? sessionPath(t) : null }) }) },
    { id: "export-image", label: t("cmd.label.export-image"), run: () => void exportCurrent(services, viewRef.current, "png", { resolveImageSrc: makeImageResolver(() => { const t = tabById(workspaceRef.current.activeId); return t ? sessionPath(t) : null }) }) },
    { id: "clear-recents", label: t("cmd.label.clear-recents"), run: clearRecents },
    { id: "check-updates", label: t("cmd.label.check-updates"), run: () => void checkForUpdatesNow(true) },
    { id: "export-diagnostics", label: t("cmd.label.export-diagnostics"), run: () => void services.exportDiagnostics?.() },
    { id: "history", label: t("cmd.label.history"), run: () => void openVersionHistory() },
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
    if (!services.listenOpenFile) return
    return services.listenOpenFile(path => { void openRecentRef.current(path) })
  }, [services])

  useEffect(() => {
    if (!services.listenDragDrop) return
    return services.listenDragDrop(paths => {
      const markdown = paths.find(path => {
        const ext = path.split(".").pop()?.toLowerCase() ?? ""
        return MARKDOWN_EXTENSIONS.includes(ext)
      })
      if (markdown) void openRecentRef.current(markdown)
    })
  }, [services])

  // Background update check after launch settles; failures stay silent.
  useEffect(() => {
    if (!services.checkForUpdates) return
    const timer = window.setTimeout(() => { void checkForUpdatesNow(false) }, UPDATE_CHECK_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [services])

  // Mirror the active tab's editor mode into React so the native View menu
  // checkbox can reflect it. The active view is read, not tracked per tab.
  useEffect(() => {
    setSourceMode(editorStatus(viewRef.current).mode === "source")
  }, [workspace.activeId])

  // Push view-mode state to the native menu checkboxes. The menu item click
  // itself flows back through the same commands and settles here.
  useEffect(() => {
    void services.setViewMenuState?.({
      source: sourceMode,
      sidebar: sidebarOpen,
      outline: outlineOpen,
      typewriter,
      focus: focusMode,
    })
  }, [services, sourceMode, sidebarOpen, outlineOpen, typewriter, focusMode])

  function closeFind() {
    setFindOpen(false)
    setReplaceOpen(false)
    try { viewRef.current?.focus() } catch { /* mock views */ }
  }

  function currentFindQuery(): FindQuery {
    return {
      query: findQueryRef.current,
      caseSensitive: findCaseRef.current,
      regex: findRegexModeRef.current,
      wholeWord: findWholeWordRef.current,
    }
  }

  function goFind(direction: "next" | "prev") {
    const view = viewRef.current
    const query = findQueryRef.current
    if (!view || query === "") return
    let doc: string
    try { doc = view.state.doc.toString() } catch { doc = docRef.current }
    const matches = collectMatches(doc, currentFindQuery())
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
    const matches = collectMatches(doc, currentFindQuery())
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
    const next = replaceAll(doc, currentFindQuery(), findReplaceRef.current)
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
      // Find/replace navigation stays editor-scoped: only active while the bar is open.
      if ((e.key === "g" || e.key === "G") && findOpenRef.current) {
        e.preventDefault()
        goFindRef.current(e.shiftKey ? "prev" : "next")
        return
      }
      if (e.key === "h" || e.key === "H") {
        e.preventDefault()
        setFindOpen(true)
        setReplaceOpen(true)
        return
      }
      const binding = WINDOW_SHORTCUTS.find(shortcut => matchesWindowShortcut(shortcut, e))
      if (!binding) return
      const command = commandsRef.current.find(candidate => candidate.id === binding.id)
      if (!command) return
      e.preventDefault()
      command.run()
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [])

  useEffect(() => {
    if (!searchOpen || !workspace.folder || !searchQuery || !services.searchMarkdown) return
    const request = ++searchRequestRef.current
    const timer = window.setTimeout(() => {
      void services.searchMarkdown?.(workspace.folder!, searchQuery, searchCase)
        .then(response => {
          if (searchRequestRef.current === request) {
            setSearchHits(response.hits)
            setSearchTruncated(response.truncated)
          }
        })
        .catch(() => { /* stale or failed search; ignore */ })
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [searchOpen, searchQuery, searchCase, workspace.folder, services])

  const { cursor, mode } = editorStatus(viewRef.current)
  const [deferredDoc, setDeferredDoc] = useState(doc)
  useEffect(() => {
    const timer = window.setTimeout(() => setDeferredDoc(doc), STATS_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [doc])
  // 安全模式（Spec 05）：字数按需 —— 点击状态栏按钮前不跑全文档扫描。
  const activeLines = useMemo(() => (deferredDoc ? deferredDoc.split("\n").length : 0), [deferredDoc])
  const safeModeActive = activeLines > SAFE_MODE_LINES
  const stats = useMemo(() => {
    if (safeModeActive && statsRequested === 0) return null
    return documentStats(deferredDoc)
  }, [deferredDoc, safeModeActive, statsRequested])

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

  // collectMatches is a full-document regex scan; memoized so it reruns only
  // when find inputs or the document actually change, not on every App render.
  // 注意（Spec 05a）：doc 是 250ms 物化节奏的 React state —— 编辑器里打字时匹配数
  // 最多滞后 ~250ms 才刷新（与字数统计防抖同语义）；换来的是全文扫描不进每键路径。
  const findPatternError = useMemo(
    () => findOpen && findRegexMode && findQuery !== ""
      ? validateFindPattern({ query: findQuery, caseSensitive: findCase, regex: true, wholeWord: false })
      : null,
    [findOpen, findRegexMode, findQuery, findCase],
  )
  const matchCount = useMemo(
    () => findOpen
      ? collectMatches(doc, {
        query: findQuery,
        caseSensitive: findCase,
        regex: findRegexMode,
        wholeWord: findWholeWord,
      }).length
      : 0,
    [findOpen, doc, findQuery, findCase, findRegexMode, findWholeWord],
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
              truncated={searchTruncated}
              caseSensitive={searchCase}
              onQuery={setSearchQuery}
              onCaseSensitive={setSearchCase}
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
              onNewFile={dir => void createTreeFile(dir)}
              onNewFolder={dir => void createTreeFolder(dir)}
              onRename={entry => void renameTreeEntry(entry)}
              onDelete={entry => void deleteTreeEntry(entry)}
              onReveal={path => { void services.revealInFinder?.(path) }}
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
            aria-label={outlineOpen ? t("outline.aria.toggleHide") : t("outline.aria.toggleShow")}
            title={outlineOpen ? t("outline.title.toggleHide") : t("outline.title.toggleShow")}
          >
            {outlineOpen ? <PanelLeftClose size={16} /> : <PanelLeft size={16} />}
          </button>
          {!outlineOpen && outlineHover ? (
            <div className="outline-hover-popover" role="dialog" aria-label={t("outline.aria.preview")}>
              <div className="outline-hover-header">
                <span className="outline-hover-title">{t("outline.preview.title")}</span>
                <span className="outline-hover-hint">{t("outline.preview.hint")}</span>
              </div>
              <div className="outline-hover-body">
                {outline.length === 0 ? (
                  <div className="sidebar-empty">{t("outline.empty")}</div>
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
          {updateVersion ? (
            <UpdateBanner
              version={updateVersion}
              onView={() => {
                setUpdateVersion(null)
                void services.openExternal?.(RELEASES_URL)
              }}
              onDismiss={() => setUpdateVersion(null)}
            />
          ) : null}
          {largeDocNotice && largeDocNotice.sessionId === workspace.activeId ? (
            <LargeDocBanner
              lines={largeDocNotice.lines}
              safeMode={largeDocNotice.safeMode}
              onDismiss={() => setLargeDocNotice(null)}
            />
          ) : null}
          {transientStatus ? (
            <p className="save-transient-status" role="status">{transientStatus}</p>
          ) : null}
          <FindReplaceBar
            open={findOpen}
            query={findQuery}
            replacement={findReplace}
            caseSensitive={findCase}
            regex={findRegexMode}
            wholeWord={findWholeWord}
            patternError={findPatternError}
            replaceOpen={replaceOpen}
            matchCount={matchCount}
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
            onRegex={value => {
              setFindRegexMode(value)
              setFindIndex(-1)
            }}
            onWholeWord={value => {
              setFindWholeWord(value)
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
        stats={stats}
        cursor={cursor}
        mode={mode}
        normalizationReviewRequired={bannerKind === "normalization"}
        saveStatus={saveStatusLabel(activeSaveState)}
        onRequestStats={safeModeActive ? () => setStatsRequested(n => n + 1) : undefined}
      />
      {paletteOpen ? (
        <CommandPalette commands={commands} onClose={() => setPaletteOpen(false)} />
      ) : null}
      {quickOpenState.open ? (
        <QuickOpenModal
          files={quickOpenState.files}
          folder={workspace.folder}
          truncated={quickOpenState.truncated}
          loading={quickOpenState.loading}
          onChoose={path => { void openRecentRef.current(path) }}
          onClose={() => setQuickOpenState(current => ({ ...current, open: false }))}
        />
      ) : null}
      {historyState.open ? (
        <VersionHistoryModal
          path={historyState.path}
          entries={historyState.entries}
          loading={historyState.loading}
          onRestore={restoreSnapshot}
          onClear={clearSnapshotHistory}
          onClose={() => setHistoryState(current => ({ ...current, open: false }))}
        />
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
