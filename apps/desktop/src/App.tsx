import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react"
import {
  createEditor, documentOutline, editorStatus, resetEditorDocument,
  setEditorAutoPair, setEditorSpellcheck,
  type CreateEditorOptions, type EditorDocumentUpdate,
} from "./Editor"
import { EditorView } from "@codemirror/view"
import type { Text } from "@codemirror/state"
import { createEditorStatusStore } from "./editorStatusStore"
import { createDocumentScaleRegistry, type DocumentScaleRegistry } from "./documentScaleRegistry"
import {
  documentStats, SAFE_MODE_RENDER_BUDGET_LINES,
  setBlockRenderBudget, setSafeModeRendering,
  type AutoPairOptions, type OutlineItem,
} from "@omd/engine"
import { type ImagePasteOptions } from "./imagePaste"
import {
  advanceDocumentIdentity, createSession, openSession, recoveryKey,
  sessionContentLoaded, sessionDirty, sessionPath,
  type EditorSession,
} from "./session"
import {
  activeSession, addTab, baseName, closeTab, createWorkspace, ensureFolder,
  focusTab, openFolder, pathWithinDir, replaceTabSession, resolveMarkdownHref,
  type Workspace,
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
import { createDocumentOpen, type DocumentOpen, type QuickOpenState } from "./documentOpen"
import { createFileTreeActions } from "./fileTreeActions"
import { loadInitialSettings, restoreDraft, restoreSavedSession, type AppSessionInitHost } from "./appSessionInit"
import { restartToApplyLogging } from "./appLoggingActions"
import { persistSettingsChange } from "./settingsPersistence"
import { useConflictSaveBinding } from "./conflictSaveBinding"
import { ConflictSaveRegion } from "./ConflictSaveRegion"
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
import {
  classifyUpdateError,
  createUpdateCoordinator,
  type UpdateCoordinator,
  type UpdateFailureKind,
  type UpdateState,
} from "./updateCoordinator"
import { updateRestartReadiness } from "./updateRestartReadiness"
import { createTauriUpdateAdapter, type UpdateAdapter } from "./updateAdapter"
import { applyTheme, type AppTheme } from "./theme"
import { runMenuCommand, MACOS_ONLY_COMMANDS, type AppCommand } from "./commands"
import { buildAppCommands } from "./appCommands"
import { isMacOS, isWindows } from "./platform"
import { matchesWindowShortcut, shortcutFor, WINDOW_SHORTCUTS } from "./shortcuts"
import { isMainWindow } from "./windowScope"
import { rememberPath } from "./recents"
import { AppMenu } from "./AppMenu"
import { AboutDialog } from "./AboutDialog"
import { defaultServices, errorMessage, type DesktopServices, type SnapshotEntry } from "./desktopServices"
import { flushLogs, logUpdateStartupFailure } from "./logging"
import { useLoggingState } from "./useLoggingState"
import { collectMatches, validateFindPattern } from "./findReplace"
import { FindReplaceBar } from "./FindReplaceBar"
import { useFindReplace } from "./useFindReplace"
import type { SaveTrigger } from "./normalizationCoordinator"
import type { SaveMode } from "./documentSaveRunner"
import { StatusBar } from "./StatusBar"
import { LargeDocBanner } from "./LargeDocBanner"
import { OpeningOverlay } from "./OpeningOverlay"
import { TopBar } from "./TopBar"
import { FileTree } from "./FileTree"
import {
  emptyFileTree,
  setChildren,
  visibleRows,
  type FileTreeModel,
} from "./fileTreeState"
import { OutlinePanel } from "./OutlinePanel"
import { SidebarResizer } from "./SidebarResizer"
import {
  clampSidebarWidth,
  readSidebarWidth,
  writeSidebarWidth,
} from "./sidebarResize"
import { CommandPalette } from "./CommandPalette"
import { QuickOpenModal } from "./QuickOpenModal"
import { VersionHistoryModal } from "./VersionHistoryModal"
import { SearchPanel } from "./SearchPanel"
import { useWorkspaceSearch } from "./useWorkspaceSearch"
import { PanelLeft, PanelLeftClose } from "lucide-react"
import { SettingsModal } from "./SettingsModal"
import {
  DEFAULT_SETTINGS,
  sameAutoPair,
  type UserSettings,
} from "./settings"
import { initLocale, setLocale, t as localeT, useT } from "./i18n"
import { reportSaveStateTransitions } from "./saveDiagnostics"
import { createDocumentMaterializer, type DocumentMaterializer } from "./documentMaterializer"
import {
  LARGE_DOC_LINES,
  MARKDOWN_EXTENSIONS,
  RELEASES_URL,
  SAFE_MODE_BYTES,
  STARTUP_UPDATE_CHECK_MS,
  SAFE_MODE_LINES,
  SIDEBAR_DEFAULT_WIDTH,
  STORAGE_KEY_OUTLINE_OPEN,
  STORAGE_KEY_SIDEBAR_OPEN,
  windowsSetupAssetUrl,
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
  /** Automatic-update adapter; tests inject a fake, production uses the Tauri plugin adapter. */
  updateAdapter?: UpdateAdapter
  /** Startup-check failure log sink (spec §10/§14); tests inject a spy, production logs through the facade. */
  logUpdateFailure?: (failure: UpdateFailureKind) => void
}

const OUTLINE_DEBOUNCE_MS = 150
// over-scale 大纲 idle 补算的兜底超时：主线程持续繁忙时也保证最终触发。
const OUTLINE_IDLE_TIMEOUT_MS = 200
// documentStats 是全文档逐字符扫描；防抖后离开每键同步路径（Spec 05）。
const STATS_DEBOUNCE_MS = 250
// Spec 05a：每键不物化整文档字符串；250ms trailing 从 view 拉取（消费前 flush）。
const DOC_MATERIALIZE_MS = 250
const OUTLINE_HOVER_OPEN_MS = 180
const OUTLINE_HOVER_CLOSE_MS = 120
const SEARCH_DEBOUNCE_MS = 200
const SESSION_SAVE_DEBOUNCE_MS = 1000

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

// 与 engine buildDriver 的 scheduleIdle 同款兜底：浏览器走 requestIdleCallback
// （timeout 保证最终触发），happy-dom 等宿主无此 API 时退化为 setTimeout(0)。
interface OutlineIdleGlobal {
  requestIdleCallback?: (callback: () => void, options: { timeout: number }) => number
  cancelIdleCallback?: (handle: number) => void
}

function scheduleOutlineIdle(callback: () => void): void {
  const idle = globalThis as OutlineIdleGlobal
  if (typeof idle.requestIdleCallback === "function" && typeof idle.cancelIdleCallback === "function") {
    idle.requestIdleCallback(callback, { timeout: OUTLINE_IDLE_TIMEOUT_MS })
    return
  }
  window.setTimeout(callback, 0)
}

export default function App({
  services = defaultServices,
  autosaveMs = 1500,
  // Fallback poll only: native notify events drive day-to-day refreshes.
  watchMs = 30000,
  docMaterializeMs = DOC_MATERIALIZE_MS,
  updateAdapter = createTauriUpdateAdapter(),
  logUpdateFailure = logUpdateStartupFailure,
}: AppProps) {
  const t = useT()
  const hostsRef = useRef(new Map<number, HTMLDivElement>())
  const viewRef = useRef<EditorView | null>(null)
  const viewsRef = useRef(new Map<number, EditorView>())
  // Task 3：状态栏订阅这个外部 store，与 App 渲染树解耦——光标/模式逐键更新
  // 不再经 App state，避免每键触发整棵应用重渲染。每次 App 挂载仅建一个实例。
  const [editorStatusStore] = useState(createEditorStatusStore)
  const workspaceRef = useRef<Workspace>(createWorkspace())
  const [workspace, setWorkspace] = useState(workspaceRef.current)
  const sessionRef = useRef<EditorSession>(activeSession(workspaceRef.current))
  const [session, setSession] = useState(sessionRef.current)
  const [doc, setDoc] = useState("")
  const docRef = useRef("")
  const docsRef = useRef(new Map<number, string>([[session.id, ""]]))
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
  // activateTab 是随渲染重建的函数声明：打开协调器一次构造，只能经 ref 拿最新实现。
  const activateTabRef = useRef<(id: number) => void>(() => {})
  const resetTabDocumentRef = useRef<(session: EditorSession, contents: string, docText?: Text) => boolean>(() => false)
  const [transientStatus, setTransientStatus] = useState<string | null>(null)
  const transientStatusTimerRef = useRef<number | null>(null)
  const showTransientStatus = createTransientStatusNotifier(
    setTransientStatus,
    transientStatusTimerRef,
    id => { transientStatusTimerRef.current = id },
  )
  const [updateState, setUpdateState] = useState<UpdateState>({ kind: "idle" })
  const openingRef = useRef(false)
  const mountedRef = useRef(false)
  const [settings, setSettings] = useState<UserSettings>(DEFAULT_SETTINGS)
  const settingsRef = useRef<UserSettings>(settings)
  const localeInitRef = useRef(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)
  const sessionSaveTimerRef = useRef<number | null>(null)
  // 最近一次防抖 saveSessionState 的在途 Promise。退出 flush 前先等它落定，
  // 否则该次写可能在 Rust 侧晚于 finisher 的 shard 删除抵达，把已关窗口的
  // shard 复活（下次启动又恢复该窗口）。
  const sessionSaveInFlightRef = useRef<Promise<void> | null>(null)
  const sessionRestoredRef = useRef(false)
  const [theme, setTheme] = useState<AppTheme>("light")
  // The window theme is applied pre-paint by Rust from persisted settings;
  // frontend pushes stay off until those settings load, so the "light"
  // default can't flip the title bar dark→light→dark.
  const [themeSyncReady, setThemeSyncReady] = useState(false)
  const logState = useLoggingState(services, themeSyncReady)
  const [customCss, setCustomCss] = useState("")
  const [focusMode, setFocusMode] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(readSidebarOpen)
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth)
  const [outlineOpen, setOutlineOpen] = useState(readOutlineOpen)
  const [typewriter, setTypewriter] = useState(false)
  const [sourceMode, setSourceMode] = useState(false)
  // Spec 05a：拉取式物化——doc 更新只发轻量信号，内容按 250ms 节奏从 view 拉取。
  // 协调器只建一次（每次 App 挂载一个实例），持有 pending set + trailing timer；
  // 依赖闭包只捕获稳定 ref/setState，重渲染不需要重建它（不要运行时改 delayMs）。
  const materializerRef = useRef<DocumentMaterializer | null>(null)
  if (!materializerRef.current) {
    materializerRef.current = createDocumentMaterializer({
      delayMs: docMaterializeMs,
      readViewText: tabId => viewsRef.current.get(tabId)?.state.doc.toString() ?? null,
      materialize: (tabId, contents) => {
        syncDoc(contents, tabId)
        const tab = workspaceRef.current.tabs.find(item => item.id === tabId)
        if (tab) saveRecovery(tab, contents)
      },
      setTimer: (callback, ms) => window.setTimeout(callback, ms),
      clearTimer: id => window.clearTimeout(id),
    })
  }
  const materializer = materializerRef.current
  const updateCoordinatorRef = useRef<UpdateCoordinator | null>(null)
  const updateCheckTimerRef = useRef<number | null>(null)
  // Spec 05/05b：文档档位（安全模式集合、字节数、只读标记、流式打开暂存 Text）
  // 的单一持有者，取代原先四个并行的 ref（safeModeTabsRef / docBytesRef /
  // docTextsRef / readonlyTabsRef）。预算/窗口化是 engine 进程级全局而安全模式
  // 是 per-tab 的，激活切换时经 registry.applyRenderPolicy 重应用（useEffect on
  // activeId 兜住 focusTab/会话恢复等全部路径）。
  const documentScaleRegistryRef = useRef<DocumentScaleRegistry | null>(null)
  if (!documentScaleRegistryRef.current) {
    documentScaleRegistryRef.current = createDocumentScaleRegistry({
      safeModeLines: SAFE_MODE_LINES,
      safeModeBytes: SAFE_MODE_BYTES,
      renderBudgetLines: SAFE_MODE_RENDER_BUDGET_LINES,
      setRenderBudget: setBlockRenderBudget,
      setSafeModeRendering,
    })
  }
  const documentScaleRegistry = documentScaleRegistryRef.current
  // LARGE 档流式打开的进度（overlay 百分比）。
  const [openingProgress, setOpeningProgress] = useState<{ bytesRead: number; byteLength: number } | null>(null)
  const [largeDocNotice, setLargeDocNotice] = useState<
    { sessionId: number; lines: number; safeMode: boolean; readonly?: boolean } | null
  >(null)
  const [statsRequested, setStatsRequested] = useState(0)
  const [openingLabel, setOpeningLabel] = useState<string | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [quickOpenState, setQuickOpenState] = useState<QuickOpenState>(
    { open: false, files: [], truncated: false, loading: false },
  )
  const [historyState, setHistoryState] = useState<{
    open: boolean
    path: string | null
    entries: SnapshotEntry[]
    loading: boolean
  }>({ open: false, path: null, entries: [], loading: false })
  const search = useWorkspaceSearch({
    folder: workspace.folder,
    search: services.searchMarkdown,
    reportError: error => services.reportError(errorMessage(t("error.searchFailed"), error)),
    debounceMs: SEARCH_DEBOUNCE_MS,
  })
  const searchOpenRef = useRef(search.open)
  searchOpenRef.current = search.open
  // 查找替换状态与命令在 useFindReplace 内；编辑器 view、App 物化文档、档位
  // 判断按 getter 注入，避免 hook 按值捕获（getter 始终读当前 ref）。
  const findReplace = useFindReplace({
    getView: () => viewRef.current,
    getDoc: () => docRef.current,
    isActiveSafeMode,
  })
  const [treeModel, setTreeModel] = useState(emptyFileTree())
  const treeModelRef = useRef(treeModel)
  // 跨渲染可变协调状态：treeActions 工厂每渲染重建，这些去重/在途集合
  // 必须经 refs 保持（否则重渲染即重置，见 fileTreeActions.ts host 注释）。
  const treeErrorSignaturesRef = useRef(new Map<string, string>())
  const treePollInFlightRef = useRef(false)
  const pendingListDirsRef = useRef(new Set<string>())
  const recentsRef = useRef<string[]>([])
  const [outline, setOutline] = useState<OutlineItem[]>([])
  const [outlineHover, setOutlineHover] = useState(false)
  const outlineHoverTimerRef = useRef<number | null>(null)
  // 大纲缓存（tab 切换时延）：docVersionsRef 是 per-tab 文档版本号 —— 全局
  // docVersion 状态跨 tab 递增，不能当失效轴；此处 handleDocumentUpdate 仅在
  // docChanged 时为对应 tab 自增（纯选区更新不影响大纲）。outlineCacheRef 存
  // 「该版本号下的大纲」，切回已算过的 tab 命中内存即免同步全树遍历。
  const docVersionsRef = useRef(new Map<number, number>())
  const outlineCacheRef = useRef(new Map<number, { version: number; outline: OutlineItem[] }>())
  // over-scale 大纲异步补算的代际令牌：每次新调度/卸载自增，旧 idle 回调据此作废。
  const outlineFillTokenRef = useRef(0)
  const pendingJumpRef = useRef<number | null>(null)
  const pendingFocusRef = useRef(false)
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
    reportSaveStateTransitions(saveStateRef.current, next, tabById)
    saveStateRef.current = next
    setSaveStateByTab(next)
  }

  const conflictSave = useConflictSaveBinding({
    services,
    getTab: tabById,
    getContents: tabId => {
      if (materializer.hasPending(tabId)) materializer.flush()
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

  const pollReadFailures = useRef(new Map<number, string>())
  const { saveFile, saveCopy, pollFileTabs } = createDocumentSaveAppBridge({
    services,
    pollReadFailures: pollReadFailures.current,
    tabSaveQueues: tabSaveQueuesRef.current,
    operationSeq: operationSeqRef,
    isOpening: () => openingRef.current,
    getTab: tabById,
    getView: tabId => viewsRef.current.get(tabId),
    getContents: tabId => {
      if (materializer.hasPending(tabId)) materializer.flush()
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
    onSavedAs: path => {
      services.notifySuccess?.(t("notify.saveAsCompleted", { name: baseName(path) }))
    },
    syncDoc,
    clearRecovery: key => { void services.clearRecovery?.(key) },
    onDurabilityWarning: () => showTransientStatus(t(DURABILITY_WARNING)),
    incrementFocusToken: () => setConflictFocusToken(token => token + 1),
    reportStatus: showTransientStatus,
    onSaveFailed: conflictSave.onSaveFailed,
  })

  saveFileRef.current = saveFile
  saveCopyRef.current = saveCopy

  // 文档打开协调器：打开链路（分档预检、流式读取、令牌作废）一次构造、跨渲染
  // 保活（P2 教训：工厂每渲染重建会重置令牌，并发作废全部失效）。自有可变状态
  // （请求令牌、在途/作废路径集、LARGE 确认）私有化为实例字段；App 侧只保留
  // UI 投影（overlay 文案/进度）与 openingRef 布尔（保存/更新侧仍读）。
  const openRef = useRef<DocumentOpen | null>(null)
  if (!openRef.current) {
    openRef.current = createDocumentOpen({
      services,
      documentScaleRegistry,
      tabSaveQueues: tabSaveQueuesRef.current,
      getWorkspace: () => workspaceRef.current,
      commitWorkspace,
      getActiveSession: () => sessionRef.current,
      getDoc: () => docRef.current,
      getContents: tabId => docsRef.current.get(tabId) ?? "",
      setContents: (tabId, contents) => { docsRef.current.set(tabId, contents) },
      getSaveStates: () => saveStateRef.current,
      commitSaveState,
      activateTab: id => { activateTabRef.current(id) },
      resetTabDocument: (session, contents, docText) =>
        resetTabDocumentRef.current(session, contents, docText),
      flushMaterializer: () => { materializer.flush() },
      syncDoc,
      revealFolder,
      rememberRecent,
      expandToPath: path => expandToPathRef.current(path),
      reportStatus: showTransientStatus,
      reportUserError,
      setOpening: open => { openingRef.current = open },
      setOpeningLabel,
      setOpeningProgress,
      setQuickOpenState,
      isMounted: () => mountedRef.current,
    })
  }
  const openCoordinator = openRef.current

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

  function handleDocumentUpdate(update: EditorDocumentUpdate) {
    const tab = tabById(update.tabId)
    if (!tab || tab.documentId !== update.documentId) return
    if (update.docChanged) {
      // 大纲缓存失效轴：内容变化才 bump 对应 tab 的版本号（选区更新不动大纲）。
      docVersionsRef.current.set(
        update.tabId,
        (docVersionsRef.current.get(update.tabId) ?? 0) + 1,
      )
      materializer.queue(update.tabId)
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

  function pasteOptions(tabId: number, documentId: number) {
    return {
      ...imageInsertOptions(tabId, documentId),
      getTabId: () => workspaceRef.current.activeId ?? tabId,
      onNotice: reportUserError,
      onConvertingChange: (active: boolean) => {
        if (transientStatusTimerRef.current !== null) {
          window.clearTimeout(transientStatusTimerRef.current)
          transientStatusTimerRef.current = null
        }
        setTransientStatus(active ? t("paste.status.converting") : null)
      },
    }
  }

  function editorOptions(
    contents: string,
    tabId: number,
    documentId: number,
    docText?: Text,
  ): CreateEditorOptions {
    // HUGE 只读档：readOnly 挡编辑；渐进渲染（视口优先装饰 + idle 排空）落地后，
    // 大文档开箱即 Live 不再冻结，无需强制源码模式或裁剪语言扩展。
    const readOnly = documentScaleRegistry.isReadOnly(tabId)
    return {
      // Task 10：流式打开带 Text 时直传（免整串切行）；否则回退字符串路径。
      doc: docText ?? contents,
      tabId,
      documentId,
      ...pasteOptions(tabId, documentId),
      onDocumentUpdate: handleDocumentUpdate,
      onModeChange: isLive => {
        const tab = tabById(tabId)
        if (!tab || tab.documentId !== documentId) return
        if (workspaceRef.current.activeId !== tabId) return
        setSourceMode(!isLive)
      },
      // Stale tab/document/view identities must not publish active status:
      // a background tab's view keeps firing selection/mode updates while
      // hidden, and only the currently active binding may reach the store.
      onStatusChange: status => {
        const tab = tabById(tabId)
        if (!tab || tab.documentId !== documentId) return
        if (workspaceRef.current.activeId !== tabId) return
        editorStatusStore.publish(status)
      },
      onOpenExternalHref: href => { void services.openExternal?.(href) },
      onOpenMarkdownHref: href => {
        const current = sessionPath(sessionRef.current)
        if (!current) {
          services.reportError(errorMessage(t("error.openFailed"), new Error("File not found")))
          return
        }
        void openCoordinator.openPath(resolveMarkdownHref(current, href), true)
      },
      tabSize: settingsRef.current.tabSize,
      spellcheck: settingsRef.current.spellcheck,
      autoPair: settingsRef.current.autoPair,
      readOnly,
    }
  }

  /**
   * Spec 05 / 05b（2026-08-20 渐进渲染落地后）：超大文档进入安全模式 ——
   * 不再强制源码模式（默认 Live，装饰以视口优先构建 + idle 排空），策略只负责
   * 块渲染预算 + 窗口化装饰 + 一次性提示 + 按需字数，任何模式下都生效。
   * 所有新建 view 的路径（resetTabDocument、ensureViews 的新标签/会话恢复/初始挂载）
   * 必须经由此入口，否则文件树、搜索面板等入口打开的大文档会绕过安全模式。
   * 行数取 view.state.doc.lines（免费），绝不对全文 split。
   *
   * 预算/窗口化是 engine 进程级全局，而 App 每 tab 各挂一个 view：只有激活
   * tab 的档位才允许改写全局（本函数只做 per-tab 标记 + 激活 tab 的全局应用），
   * 否则会话恢复为惰性占位 tab 建空 view 时会把激活 50MB tab 的窗口化翻掉。
   */
  function applyDocumentScalePolicy(view: EditorView, tabId: number) {
    const lines = view.state.doc.lines
    const { safeMode, readOnly: readonly } = documentScaleRegistry.classify(tabId, lines)
    // 全局只跟随激活 tab：restore 主 tab 复用 tabs[0] 的 id，activeId 全程不变，
    // 惰性空 view 在此应用全局后 [activeId] effect 不会纠正 —— 激活的 over-scale
    // tab 会丢窗口化/预算（I-1）。非激活 tab 只标记，切换由 effect 重应用。
    if (tabId === workspaceRef.current.activeId) documentScaleRegistry.applyRenderPolicy(tabId)
    setLargeDocNotice(
      readonly
        ? { sessionId: tabId, lines, safeMode: true, readonly: true }
        : safeMode
          ? { sessionId: tabId, lines, safeMode: true }
          : lines > LARGE_DOC_LINES
            ? { sessionId: tabId, lines, safeMode: false }
            : null,
    )
    setStatsRequested(0)
  }

  function resetTabDocument(nextSession: EditorSession, contents: string, docText?: Text): boolean {
    const view = viewsRef.current.get(nextSession.id)
    if (!view) return false
    const previousWorkspace = workspaceRef.current
    const previousNormalization = normalizationRef.current
    const previousDoc = docsRef.current.get(nextSession.id) ?? ""
    commitWorkspace(replaceTabSession(previousWorkspace, nextSession))
    commitNormalization(clearTabNormalization(previousNormalization, nextSession.id))
    // 整文档重载：大纲缓存作废、版本号归零（与新建 tab 同口径），旧大纲不再命中。
    docVersionsRef.current.set(nextSession.id, 0)
    outlineCacheRef.current.delete(nextSession.id)
    try {
      resetEditorDocument(view, editorOptions(contents, nextSession.id, nextSession.documentId, docText))
    } catch (error) {
      commitWorkspace(previousWorkspace)
      commitNormalization(previousNormalization)
      syncDoc(previousDoc, nextSession.id)
      throw error
    }
    // view 已存在并直接消费了入参 Text：清掉可能残留的 ensureViews 暂存（作废）。
    documentScaleRegistry.takeText(nextSession.id)
    applyDocumentScalePolicy(view, nextSession.id)
    // 重载内容即最新：清掉 pending，防止物化用旧 view 内容覆盖（Spec 05a）。
    materializer.discard(nextSession.id)
    syncDoc(contents, nextSession.id)
    return true
  }
  resetTabDocumentRef.current = resetTabDocument

  // 大纲刷新（tab 感知）。调用方有三：activateTab 传入激活 tab 的 view；大纲
  // 防抖 effect 与悬停弹出传 viewRef.current —— 惰性 tab 首激活的窗口期它可能
  // 仍指向上一个 tab 的 view，故 view 并不恒属激活 tab，下方守卫对外来 view
  // 保守置空大纲（fail-safe），真正计算/入缓存前再校验归属：
  //   1. 缓存命中（tabId + 文档版本一致）—— setOutline 复用，零重算，这是
  //      大文件 tab 反复切换的主要成本来源（collectOutline 同步全树遍历）。
  //   2. 未命中且非 over-scale —— 同步首算并写缓存（普通文档便宜，维持原行为）。
  //   3. 未命中且 over-scale（documentScaleRegistry 的安全模式集合）—— 先给旧
  //      缓存/空大纲让激活立即返回，idle 回调（requestIdleCallback，宿主缺失
  //      退化为 setTimeout(0)）补算落缓存；回调执行前自检代际令牌/激活 tab/
  //      版本号，任一漂移即丢弃，杜绝把过期或他 tab 的大纲写进当前 tab 的缓存
  //      （串数据）。
  function refreshChrome(view: EditorView | null) {
    const tabId = workspaceRef.current.activeId
    const version = docVersionsRef.current.get(tabId) ?? 0
    const cached = outlineCacheRef.current.get(tabId)
    if (cached && cached.version === version) {
      setOutline(cached.outline)
      return
    }
    // view 必须确属激活 tab 才可计算/入缓存：惰性 tab 首激活的窗口期 viewRef
    // 可能仍指向上一个 tab 的 view，拿它计算会把别的文档写进本 tab 的缓存。
    if (!view || viewsRef.current.get(tabId) !== view) {
      setOutline([])
      return
    }
    if (!documentScaleRegistry.isSafeMode(tabId)) {
      const outline = documentOutline(view)
      outlineCacheRef.current.set(tabId, { version, outline })
      setOutline(outline)
      return
    }
    setOutline(cached ? cached.outline : [])
    const token = ++outlineFillTokenRef.current
    scheduleOutlineIdle(() => {
      if (token !== outlineFillTokenRef.current) return
      if (workspaceRef.current.activeId !== tabId) return
      if ((docVersionsRef.current.get(tabId) ?? 0) !== version) return
      const outline = documentOutline(view)
      outlineCacheRef.current.set(tabId, { version, outline })
      setOutline(outline)
    })
  }

  function ensureViews() {
    for (const tab of workspaceRef.current.tabs) {
      if (viewsRef.current.has(tab.id)) continue
      const el = hostsRef.current.get(tab.id)
      if (!el) continue
      const view = createEditor(
        el,
        // Task 10：流式打开暂存的 Text（若有）在此消费 —— 大档新 tab 免整串切行。
        editorOptions(
          docsRef.current.get(tab.id) ?? "",
          tab.id,
          tab.documentId,
          documentScaleRegistry.takeText(tab.id),
        ),
      )
      viewsRef.current.set(tab.id, view)
      if (tab.id === workspaceRef.current.activeId) viewRef.current = view
      applyDocumentScalePolicy(view, tab.id)
    }
    // 不变量（I-1）：ensureViews 结束时进程级预算/窗口化必须与激活 tab 的档位
    // 一致。循环可能只为非激活 tab 建 view（如会话恢复的惰性占位），策略在非
    // 激活 tab 上不碰全局 —— 此处按激活 tab 幂等重应用，钉死最终状态。
    documentScaleRegistry.applyRenderPolicy(workspaceRef.current.activeId)
    jumpPending()
    focusPendingEditor()
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

  /** 视图要到 ensureViews/activateTab 时才存在，故焦点用 pending 标记延迟移交（同 jumpPending 模式）。 */
  function focusPendingEditor() {
    if (!pendingFocusRef.current) return
    pendingFocusRef.current = false
    try { viewRef.current?.focus() } catch { /* mock views */ }
  }

  function bindHost(id: number, el: HTMLDivElement | null) {
    if (el) hostsRef.current.set(id, el)
    else hostsRef.current.delete(id)
  }

  useEffect(() => {
    mountedRef.current = true
    ensureViews()
    void (async () => {
      // P4：启动流程在 appSessionInit（纯动作模块）；host 全为 getter/ref 转发，
      // 编排顺序（设置 → pendingOpen → 恢复）留在 App，首渲染闭包构造一次即可。
      const sessionInit: AppSessionInitHost = {
        services, documentScaleRegistry,
        isMounted: () => mountedRef.current, applySpellcheck, applyAutoPair,
        getSettingsState: () => settingsRef.current,
        commitSettings: next => { settingsRef.current = next; setSettings(next) },
        commitTheme: setTheme,
        getWorkspace: () => workspaceRef.current, commitWorkspace,
        getContents: tabId => docsRef.current.get(tabId) ?? "",
        setContents: (tabId, contents) => docsRef.current.set(tabId, contents),
        resetTabDocument: (session, contents) => resetTabDocumentRef.current(session, contents),
        syncDoc, getActiveSession: () => sessionRef.current,
        markSessionRestored: () => { sessionRestoredRef.current = true },
      }
      const initial = await loadInitialSettings(sessionInit)
      if (mountedRef.current) setThemeSyncReady(true)
      if (!localeInitRef.current) {
        localeInitRef.current = true
        initLocale(initial.locale, locale => { void services.setMenuLocale?.(locale) })
      }
      const pendingOpen = await services.takePendingOpenFiles?.() ?? []
      if (pendingOpen.length > 0) {
        // An explicit launch request (double-click / Open With / CLI) wins over
        // restoring the previous session.
        for (const path of pendingOpen) {
          await openExternalRef.current(path)
        }
      } else {
        // Session shards are per-window (get_session_state resolves the
        // calling webview), so EVERY window consults its own shard here —
        // restored editor-N windows reopen their tabs and folder. Only the
        // draft-recovery prompt below is main-gated. A window without a
        // shard (empty payload) keeps its fresh untitled tab and never
        // drafts: recovery records are app-global, so a non-main window
        // offering one would hijack the main window's record.
        const restored = await restoreSavedSession(sessionInit)
        if (!restored && isMainWindow()) {
          await restoreDraft(sessionInit)
        }
      }
    })()
    return () => {
      mountedRef.current = false
      materializer.destroy()
      viewRef.current = null
      viewsRef.current.forEach(item => item.destroy())
      viewsRef.current.clear()
      openCoordinator.dispose()
    }
  }, [])

  // Automatic updates (spec §10): one coordinator per mounted app, one startup
  // check eight seconds after mount (silent on failure, never a silent download).
  // Creating the coordinator here — subscribe once, schedule once, dispose on
  // cleanup — also survives React StrictMode's effect double-invoke: each effect
  // pass builds a fresh coordinator instead of reusing a disposed one.
  useEffect(() => {
    const coordinator = createUpdateCoordinator({
      updater: updateAdapter,
      capability: async () =>
        services.updateCapability?.() ?? { check: false, install: false, reason: "development" },
      flushPendingEdits: () => materializer.flush(),
      checkRestartReadiness: () => updateRestartReadiness({
        workspace: workspaceRef.current,
        contentsByTab: docsRef.current,
        saveStates: saveStateRef.current,
        normalization: normalizationRef.current,
        opening: openingRef.current,
      }),
      prepareRestart: async () => {
        const prepare = services.prepareUpdateRestart
        if (!prepare) throw new Error("update restart is not supported here")
        return prepare()
      },
      openReleasePage: async () => { await services.openExternal?.(RELEASES_URL) },
      openManualDownload: async version => { await services.openExternal?.(windowsSetupAssetUrl(version)) },
      reportManualFailure: failure => {
        if (mountedRef.current) services.reportError(localeT(`update.failure.${failure}`))
      },
      logFailure: logUpdateFailure,
      notifyLatest: () => {
        services.notifySuccess?.(localeT("update.current"))
      },
      isWindows: () => isWindows(),
      classifyError: classifyUpdateError,
    })
    updateCoordinatorRef.current = coordinator
    const unsubscribe = coordinator.subscribe(setUpdateState)
    updateCheckTimerRef.current = window.setTimeout(() => {
      void coordinator.check("startup")
    }, STARTUP_UPDATE_CHECK_MS)
    return () => {
      if (updateCheckTimerRef.current !== null) {
        window.clearTimeout(updateCheckTimerRef.current)
        updateCheckTimerRef.current = null
      }
      unsubscribe()
      coordinator.dispose()
      if (updateCoordinatorRef.current === coordinator) updateCoordinatorRef.current = null
    }
  }, [])

  useEffect(() => {
    ensureViews()
  }, [workspace.tabs])

  // 预算重应用兜住所有激活路径（activateTab、会话恢复 focusTab 等）；effect 在 DOM
  // 提交后、CM 视口重测量前运行，widget 渲染前预算已就位。
  useEffect(() => {
    documentScaleRegistry.applyRenderPolicy(workspace.activeId)
  }, [workspace.activeId])

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
      const save = services.saveSessionState?.(state) ?? Promise.resolve()
      sessionSaveInFlightRef.current = save
      // 本地 catch：失败由该路径自行消化，避免在途 rejection 变成 webview
      // 未处理拒绝（flush 侧还有一层兜底 catch）。
      void save.catch(() => {})
    }, SESSION_SAVE_DEBOUNCE_MS)
    return () => {
      if (sessionSaveTimerRef.current) window.clearTimeout(sessionSaveTimerRef.current)
    }
  }, [workspace.folder, workspace.tabs, workspace.activeId, services])

  // 退出前 flush：Rust 在 CloseRequested/ExitRequested 先 emit session-flush，
  // 这里立即取消挂起的防抖、落盘当前 workspace，再 ack 放行关闭/退出。
  // 保存失败也要 ack——ack 卡住只会把退出拖到 Rust 的 2s 超时。
  useEffect(() => {
    if (!services.listenSessionFlush || !services.sessionFlushAck) return
    return services.listenSessionFlush(async () => {
      if (sessionSaveTimerRef.current !== null) {
        window.clearTimeout(sessionSaveTimerRef.current)
        sessionSaveTimerRef.current = null
      }
      // 刚触发的防抖 save 可能仍在 Rust 侧在途：先等它落定，保证它不可能
      // 晚于最终落盘 / finisher 的 shard 删除抵达。已失败的 straggler 的
      // rejection 已被防抖路径吸收，这里不得让它连带拒绝 flush。
      const inFlight = sessionSaveInFlightRef.current
      if (inFlight) {
        try { await inFlight } catch { /* absorbed by the debounce path */ }
      }
      try {
        await services.saveSessionState?.(extractSessionState(workspaceRef.current))
      } catch {
        // 落盘失败也要走完 ack——事件回调里的逃逸 rejection 只会变成
        // webview 的未处理拒绝，还拖慢退出。
      } finally {
        await flushLogs()
        await services.sessionFlushAck?.()
      }
    })
  }, [services])

  useEffect(() => {
    applyTheme(theme, customCss)
    if (!themeSyncReady) return
    // data-theme only restyles the webview; the native title bar follows the
    // window's own appearance, so the resolved theme must also cross IPC.
    // "system" clears the override so the window keeps following the OS.
    void services.setWindowTheme?.(theme === "system" ? null : theme)
  }, [theme, customCss, services, themeSyncReady])

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

  // A stored width can outlive a smaller window (relaunch, external resize);
  // re-clamp so the sidebar never eats the editor. Functional setState keeps
  // the listener registered once with no stale closure.
  useEffect(() => {
    const onWindowResize = () => {
      setSidebarWidth(prev => clampSidebarWidth(prev, window.innerWidth))
    }
    window.addEventListener("resize", onWindowResize)
    return () => window.removeEventListener("resize", onWindowResize)
  }, [])

  function commitSidebarWidth(px: number) {
    setSidebarWidth(px)
    writeSidebarWidth(px)
  }

  function resetSidebarWidth() {
    commitSidebarWidth(clampSidebarWidth(SIDEBAR_DEFAULT_WIDTH, window.innerWidth))
  }

  const activePendingId = normalizationByTab[session.id]?.notice.id ?? null

  useEffect(() => {
    // 只读档永不写回（纵深防御）：即便未来出现新的变异路径把 buffer 弄脏，
    // autosave 也不得把变化持久化到用户的 ≥50MiB HUGE 文件。
    if (!autosaveMs || !activeFilePath || !dirty
      || documentScaleRegistry.isReadOnly(session.id)) return
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
      if (!cancelled) {
        treeActions.clearTreeError(folder)
        commitTree(setChildren(emptyFileTree(), folder, entries))
      }
    }).catch(error => {
      if (!cancelled) treeActions.reportTreeError(folder, error)
    })
    return () => { cancelled = true }
  }, [workspace.folder, services])

  useEffect(() => {
    // Skip the whole poll while Search replaces the tree: the scan is pure
    // waste and its results are not rendered.
    if (!watchMs || !workspace.folder || !services.listDir || search.open) return
    const listDir = services.listDir
    const timer = window.setInterval(() => { void treeActions.refreshTree(listDir) }, watchMs)
    return () => window.clearInterval(timer)
  }, [watchMs, workspace.folder, services, search.open])

  useEffect(() => {
    if (!watchMs) return
    const timer = window.setInterval(() => { void runFileTabsPoll() }, watchMs)
    return () => window.clearInterval(timer)
  }, [watchMs])

  // Native notify events are the primary external-change channel; the slow
  // interval above is only a safety net for dropped events.
  useEffect(() => {
    if (!services.listenWorkspaceChange) return
    return services.listenWorkspaceChange(() => {
      void runFileTabsPoll()
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
      if (path && (!folder || !pathWithinDir(path, folder))) paths.add(path)
    }
    void services.watchPaths([...paths])
  }, [workspace.folder, workspace.tabs, services])

  // Outline follows the document, but only while the panel is open and only
  // after typing pauses: collectOutline walks the whole syntax tree, so it must
  // stay off the per-keystroke path. activateTab refreshes immediately instead.
  // 编辑后版本号已 bump，此处经 refreshChrome 走同一缓存：未变内容零重算，
  // over-scale 编辑后的补算同样异步化。
  useEffect(() => {
    if (!outlineOpen) return
    const timer = window.setTimeout(() => {
      refreshChrome(viewRef.current)
    }, OUTLINE_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [doc, outlineOpen, session.id])

  useEffect(() => {
    return () => {
      if (outlineHoverTimerRef.current) window.clearTimeout(outlineHoverTimerRef.current)
      // 卸载即作废在途的大纲 idle 补算（代际令牌自增，旧回调全部丢弃）。
      outlineFillTokenRef.current += 1
    }
  }, [])

  function handleOutlineMouseEnter() {
    if (outlineOpen) return
    if (outlineHoverTimerRef.current) window.clearTimeout(outlineHoverTimerRef.current)
    outlineHoverTimerRef.current = window.setTimeout(() => {
      // 悬停弹出同享缓存：命中即免同步全树遍历，over-scale 异步补齐。
      refreshChrome(viewRef.current)
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

  function applyAutoPair(next: AutoPairOptions) {
    for (const view of viewsRef.current.values()) {
      try { setEditorAutoPair(view, next) } catch { /* mock views */ }
    }
  }

  const settingsSaveRef = useRef<Promise<boolean>>(Promise.resolve(true))

  function handleSaveSettings(next: UserSettings) {
    const sanitized = persistSettingsChange({
      current: settingsRef.current,
      next,
      slot: settingsSaveRef,
      services,
    })
    if (sanitized.spellcheck !== settingsRef.current.spellcheck) {
      applySpellcheck(sanitized.spellcheck)
    }
    if (!sameAutoPair(sanitized.autoPair, settingsRef.current.autoPair)) {
      applyAutoPair(sanitized.autoPair)
    }
    const localeChanged = sanitized.locale !== settingsRef.current.locale
    setSettings(sanitized)
    settingsRef.current = sanitized
    setTheme(sanitized.theme)
    if (localeChanged) setLocale(sanitized.locale)
  }

  function openRecent(path: string) {
    return openCoordinator.runOpen(async () => path)
  }

  function runUpdateDownload() {
    const coordinator = updateCoordinatorRef.current
    if (!coordinator) return
    void coordinator.download().catch(error => {
      // A check-only download routes to the Release page before any download;
      // that open rejection is not published through update state, so surface
      // it at the UI/service boundary (review ruling, Task 4 deferred note).
      if (mountedRef.current) {
        services.reportError(errorMessage(t("update.releaseOpenFailed"), error))
      }
    })
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
    return openCoordinator.runOpen(() => services.pickOpenPath())
  }

  function activateTab(id: number) {
    const current = viewRef.current
    // Spec 05a/05b：离开的 tab 只有 pending 时才需要物化（docChanged 置位、
    // 250ms 内未拉取）；无条件 rope 展平是 50MB tab 的切换悬崖。
    if (current && materializer.hasPending(sessionRef.current.id)) {
      // 直接读 view 落 docsRef，不走 materialize()：切到懒加载 tab 时它会
      // 提前返回不给新 tab 调 syncDoc，materialize() 的 syncDoc 却按当前
      // activeId 写 doc state —— 此刻 activeId 还是旧 tab，会短暂把 doc
      // state 刷成旧内容。这里只需要落 docsRef，不需要 recovery 写或 doc
      // state 更新（新 tab 的 syncDoc 会在下面或 loadLazyTab 里补上）。
      docsRef.current.set(sessionRef.current.id, current.state.doc.toString())
      materializer.discard(sessionRef.current.id)
    }
    commitWorkspace(focusTab(workspaceRef.current, id))
    const nextView = viewsRef.current.get(id)
    if (!nextView) return
    viewRef.current = nextView
    const tab = tabById(id)
    if (tab && !sessionContentLoaded(tab)) {
      void loadLazyTab(tab)
      return
    }
    syncDoc(docsRef.current.get(id) ?? nextView.state.doc.toString(), id)
    refreshChrome(nextView)
    jumpPending()
    focusPendingEditor()
  }

  /** Spec 05b：会话恢复的惰性 tab 首次激活时才读盘装载（含分档确认）。 */
  async function loadLazyTab(lazy: EditorSession) {
    const path = sessionPath(lazy)
    if (!path) return
    const open = openCoordinator
    const token = open.nextRequest()
    const tier = await open.resolveOpenTier(path)
    if (tier === "cancel" || token !== open.currentRequest) return
    const showOverlay = tier !== "normal"
    if (showOverlay) setOpeningLabel(baseName(path))
    try {
      const snapshot = await open.readSnapshotForOpen(path, tier)
      if (token !== open.currentRequest) return
      if (snapshot.kind !== "existing") {
        if (mountedRef.current) {
          services.reportError(errorMessage(t("error.openFailed"), new Error("File not found")))
        }
        return
      }
      await services.allowDocumentAssets(path)
      if (token !== open.currentRequest) return
      // await 期间 tab 可能已被关闭（关闭不打断 openRequest 令牌）：装载作废，
      // 不给已死 id 落 docBytes/readonly 档位或在 refs 里暂存整份内容 ——
      // 大档 docText 会常驻到进程结束（M-1 泄漏）。
      if (!workspaceRef.current.tabs.some(item => item.id === lazy.id)) return
      revealFolder(path)
      rememberRecent(path)
      const updated = openSession(lazy, snapshot)
      // 无条件写入：装载可能是一次失败尝试后的重试（resetTabDocument 抛错会
      // 保留惰性会话），降档重试必须清掉上一轮留下的只读/字节元数据。
      documentScaleRegistry.setBytes(updated.id, snapshot.stats?.byteLength)
      documentScaleRegistry.setReadOnly(updated.id, tier === "readonly")
      if (!resetTabDocument(updated, snapshot.contents, snapshot.docText)) {
        // view 尚未创建的窗口期：先落 session 与内容，策略由 ensureViews 兜底。
        commitWorkspace(replaceTabSession(workspaceRef.current, updated))
        docsRef.current.set(updated.id, snapshot.contents)
        if (snapshot.docText) documentScaleRegistry.stashText(updated.id, snapshot.docText)
        syncDoc(snapshot.contents, updated.id)
      }
    } catch (error) {
      if (token === open.currentRequest && mountedRef.current) {
        services.reportError(errorMessage(t("error.openFailed"), error))
      }
    } finally {
      if (token === open.currentRequest && showOverlay) {
        setOpeningLabel(null)
        setOpeningProgress(null)
      }
    }
  }

  function newTab() {
    const tab = createSession(workspaceRef.current.nextId)
    docsRef.current.set(tab.id, "")
    docVersionsRef.current.set(tab.id, 0)
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
      docVersionsRef.current.set(replacement.id, 0)
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
      // 大纲缓存随 tab 一起销毁（版本号 + 缓存条目），防 id 复用时串数据/泄漏。
      docVersionsRef.current.delete(id)
      outlineCacheRef.current.delete(id)
      // In-flight saves keep running (the chain is independent of the map), but
      // no later open should await a closed tab's queue promise.
      tabSaveQueuesRef.current.delete(id)
      materializer.discard(id)
      documentScaleRegistry.remove(id)
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
    materializer.flush()
    // Closing the last file swaps in a fresh untitled scratch (the same swap
    // the delete path uses). A clean untitled lone tab would only be swapped
    // for an identical one — and each swap churns the CodeMirror view — so
    // treat that as a no-op instead of cycling tab ids under held Cmd+W.
    const lone = workspaceRef.current.tabs.length === 1 ? workspaceRef.current.tabs[0] : undefined
    if (
      lone
      && lone.id === id
      && lone.persistence.kind === "untitled"
      && !sessionDirty(lone, docsRef.current.get(id) ?? "")
    ) {
      return
    }
    closeTabInternal(id, { confirm: true, allowReplaceLast: true })
  }
  requestCloseTabRef.current = requestCloseTab
  activateTabRef.current = activateTab

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

  const treeActions = createFileTreeActions({
    services,
    getTreeModel: () => treeModelRef.current,
    commitTree,
    getWorkspace: () => workspaceRef.current,
    commitWorkspace,
    getContents: tabId => docsRef.current.get(tabId) ?? "",
    flushMaterializer: () => materializer.flush(),
    isOpenInFlight: path => openCoordinator.isOpenInFlight(path),
    invalidateOpen: path => { openCoordinator.invalidateOpen(path) },
    closeTab: closeTabInternal,
    saveRecovery,
    notifySuccess: message => { services.notifySuccess?.(message) },
    reportError: message => { services.reportError(message) },
    reportUserError,
    t,
    confirmDiscard: () => services.confirmDiscard(),
    confirmClose: () => services.confirmClose?.(),
    confirmDelete: path => services.confirmDelete?.(path),
    isMounted: () => mountedRef.current,
    setPendingFocus: () => { pendingFocusRef.current = true },
    openPath: (path, inNewTab) => openCoordinator.openPath(path, inNewTab),
    treeErrorSignatures: treeErrorSignaturesRef.current,
    treePollInFlight: treePollInFlightRef,
    pendingListDirs: pendingListDirsRef.current,
  })

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
  // Spec 05b：轮询 in-flight 去重。30s 定时 + 事件批（Windows 下文件夹递归
  // watch 与单文件 watch 双源）会并发起多轮，每轮对大 tab 全量读盘探测。
  const pollInFlightRef = useRef(false)
  function runFileTabsPoll(): Promise<void> {
    if (pollInFlightRef.current) return Promise.resolve()
    pollInFlightRef.current = true
    return pollFileTabsRef.current().finally(() => { pollInFlightRef.current = false })
  }
  const openRecentRef = useRef(openRecent)
  // 挂载 effect / 监听器经此 ref 调最新打开协调器（协调器一次构造，不变）。
  const openExternalRef = useRef((path: string) => openCoordinator.openExternal(path))
  const refreshTreeRef = useRef(treeActions.refreshTree)
  const expandToPathRef = useRef(treeActions.expandToPath)
  pollFileTabsRef.current = pollFileTabs
  openRecentRef.current = openRecent
  refreshTreeRef.current = treeActions.refreshTree
  expandToPathRef.current = treeActions.expandToPath

  const allCommands: AppCommand[] = buildAppCommands({
    services,
    t,
    viewRef,
    sessionRef,
    workspaceRef,
    tabById,
    openFile,
    saveFile,
    newTab,
    chooseFolder,
    openCoordinator,
    findReplace,
    search,
    requestCloseTab,
    clearRecents,
    openVersionHistory,
    setTheme,
    setCustomCss,
    setFocusMode,
    setSettingsOpen,
    setSidebarOpen,
    setOutlineOpen,
    setTypewriter,
    setAboutOpen,
    customCss,
    showTransientStatus,
    updateCoordinatorRef,
    pasteOptions,
    imageInsertOptions,
    documentScaleRegistry,
  })

  // Native PDF/image export is macOS-only (spec D3); on macOS the set filters
  // nothing. Filtering the single definition point covers the palette,
  // commandsRef, runMenuCommand, and the future native AppMenu alike.
  const commands: AppCommand[] = allCommands.filter(
    command => isMacOS() || !MACOS_ONLY_COMMANDS.has(command.id),
  )
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
    return services.listenOpenFile(path => { void openExternalRef.current(path) })
  }, [services])

  useEffect(() => {
    if (!services.listenDragDrop) return
    return services.listenDragDrop(paths => {
      const markdown = paths.find(path => {
        const ext = path.split(".").pop()?.toLowerCase() ?? ""
        return MARKDOWN_EXTENSIONS.includes(ext)
      })
      if (markdown) void openExternalRef.current(markdown)
    })
  }, [services])

  // Mirror the active tab's editor mode into React so the native View menu
  // checkbox can reflect it. The active view is read, not tracked per tab.
  useEffect(() => {
    const status = editorStatus(viewRef.current)
    setSourceMode(status.mode === "source")
    // Activating a tab does not fire the editor's update listener, so the
    // store must be re-published here to reflect the newly active view.
    editorStatusStore.publish(status)
  }, [workspace.activeId, editorStatusStore])

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

  function isActiveSafeMode(): boolean {
    let lines = 0
    try { lines = viewRef.current?.state.doc.lines ?? 0 } catch { lines = 0 }
    return documentScaleRegistry.evaluate(workspaceRef.current.activeId, lines).safeMode
  }

  // Spec 05b：Escape 取消进行中的打开。overlay 非模态，但其上的模态/面板
  // （palette、quick open、search、settings、about）优先消费 Escape，
  // 只有这些 chrome 都关闭时 Escape 才落到「取消打开」。
  const openingLabelRef = useRef<string | null>(null)
  openingLabelRef.current = openingLabel
  const cancelOpeningRef = useRef(openCoordinator.cancelOpening)
  cancelOpeningRef.current = openCoordinator.cancelOpening
  const modalChromeOpenRef = useRef(false)
  modalChromeOpenRef.current =
    paletteOpen || quickOpenState.open || search.open || settingsOpen || aboutOpen

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      if (e.key === "Escape" && findReplace.openRef.current) {
        e.preventDefault()
        findReplace.closeRef.current()
        return
      }
      if (e.key === "Escape" && openingLabelRef.current && !modalChromeOpenRef.current) {
        e.preventDefault()
        cancelOpeningRef.current()
        return
      }
      if (e.key === "p" && e.shiftKey && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setPaletteOpen(open => !open)
        return
      }
      if (!e.metaKey && !e.ctrlKey) return
      // Find/replace navigation stays editor-scoped: only active while the bar is open.
      if ((e.key === "g" || e.key === "G") && findReplace.openRef.current) {
        e.preventDefault()
        findReplace.goRef.current(e.shiftKey ? "prev" : "next")
        return
      }
      if (e.key === "h" || e.key === "H") {
        e.preventDefault()
        findReplace.setOpen(true)
        findReplace.setReplaceOpen(true)
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

  const [deferredDoc, setDeferredDoc] = useState(doc)
  useEffect(() => {
    const timer = window.setTimeout(() => setDeferredDoc(doc), STATS_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [doc])
  // 安全模式（Spec 05）：字数按需 —— 点击状态栏按钮前不跑全文档扫描。
  // 行数走 CM rope / snapshot，禁止对全文 split（Spec 05b）。
  let activeLines = 0
  try { activeLines = viewRef.current?.state.doc.lines ?? 0 } catch { activeLines = 0 }
  const safeModeActive = documentScaleRegistry.evaluate(workspace.activeId, activeLines).safeMode
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
    () => findReplace.open && findReplace.regexMode && findReplace.query !== ""
      ? validateFindPattern({
          query: findReplace.query,
          caseSensitive: findReplace.caseSensitive,
          regex: true,
          wholeWord: false,
        })
      : null,
    [findReplace.open, findReplace.regexMode, findReplace.query, findReplace.caseSensitive],
  )
  const matchCount = useMemo<number | null>(
    () => {
      if (!findReplace.open) return 0
      // 安全模式（Spec 05）门控全文正则扫描：over-scale tab（含只读）与字数统计
      // 同口径不跑 collectMatches，计数返回 null 由 FindBar 显示占位；文档缩回
      // 正常规模或切到普通 tab 后恢复即时计数。
      if (safeModeActive) return null
      return collectMatches(doc, {
        query: findReplace.query,
        caseSensitive: findReplace.caseSensitive,
        regex: findReplace.regexMode,
        wholeWord: findReplace.wholeWord,
      }).length
    },
    [
      findReplace.open, doc, findReplace.query, findReplace.caseSensitive,
      findReplace.regexMode, findReplace.wholeWord, safeModeActive,
    ],
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
          style={{ "--omd-sidebar-width": `${sidebarWidth}px` } as CSSProperties}
          aria-hidden={!sidebarOpen}
          inert={!sidebarOpen}
        >
          {search.open ? (
            <SearchPanel
              query={search.query}
              hits={search.hits}
              truncated={search.truncated}
              caseSensitive={search.caseSensitive}
              onQuery={search.setQuery}
              onCaseSensitive={search.setCaseSensitive}
              onClose={() => search.setOpen(false)}
              onOpen={hit => {
                pendingJumpRef.current = hit.line
                void openCoordinator.openPath(hit.path, true)
              }}
            />
          ) : (
            <FileTree
              folder={workspace.folder}
              rows={treeRows}
              activePath={activeFilePath}
              activeTabId={workspace.activeId}
              visible={sidebarOpen}
              onOpenFile={path => void openCoordinator.openPath(path, true)}
              onToggleDir={path => void treeActions.toggleDir(path)}
              onSearch={() => search.setOpen(true)}
              onNewFile={dir => void treeActions.createTreeFile(dir)}
              onNewFolder={dir => void treeActions.createTreeFolder(dir)}
              onRename={services.renamePath ? treeActions.renameTreeEntry : undefined}
              onRenameError={message => services.reportError(message)}
              onDelete={entry => void treeActions.deleteTreeEntry(entry)}
              onReveal={path => {
                void services.revealInFinder?.(path)?.catch(error => {
                  services.reportError(errorMessage(t("error.revealFailed"), error))
                })
              }}
              onCollapse={() => setSidebarOpen(false)}
            />
          )}
        </aside>
        {sidebarOpen ? (
          <SidebarResizer
            width={sidebarWidth}
            onResize={setSidebarWidth}
            onCommit={commitSidebarWidth}
            onReset={resetSidebarWidth}
          />
        ) : null}
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
                // CM6 选区变更不自动滚动：必须显式请求滚动到标题处。
                view.dispatch({
                  selection: { anchor: from },
                  effects: EditorView.scrollIntoView(from, { y: "start" }),
                })
                view.focus()
              } catch { /* mock views */ }
            }}
          />
        </aside>
        <div className="outline-toggle-strip">
          <button
            type="button"
            className={`outline-toggle-btn${outlineOpen ? " is-active" : ""}`}
            onClick={() => {
              if (outlineHoverTimerRef.current) window.clearTimeout(outlineHoverTimerRef.current)
              setOutlineHover(false)
              setOutlineOpen(open => !open)
            }}
            onMouseEnter={handleOutlineMouseEnter}
            onMouseLeave={handleOutlineMouseLeave}
            aria-expanded={outlineOpen}
            aria-controls="outline-panel"
            aria-label={outlineOpen ? t("outline.aria.toggleHide") : t("outline.aria.toggleShow")}
            title={outlineOpen
              ? t("outline.title.toggleHide", { shortcut: shortcutFor("outline") ?? "" })
              : t("outline.title.toggleShow", { shortcut: shortcutFor("outline") ?? "" })}
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
          {updateState.kind !== "idle" ? (
            <UpdateBanner
              state={updateState}
              onDownload={runUpdateDownload}
              onViewRelease={() => { void services.openExternal?.(RELEASES_URL) }}
              onDismiss={() => { updateCoordinatorRef.current?.dismiss() }}
              onRequestInstall={() => { void updateCoordinatorRef.current?.requestInstall() }}
              onInstall={() => { void updateCoordinatorRef.current?.install() }}
              onFocusBlockedTab={tabId => activateTab(tabId)}
            />
          ) : null}
          {largeDocNotice && largeDocNotice.sessionId === workspace.activeId ? (
            <LargeDocBanner
              lines={largeDocNotice.lines}
              safeMode={largeDocNotice.safeMode}
              readonly={largeDocNotice.readonly}
              onDismiss={() => setLargeDocNotice(null)}
            />
          ) : null}
          {transientStatus ? (
            <p className="save-transient-status" role="status">{transientStatus}</p>
          ) : null}
          <FindReplaceBar
            open={findReplace.open}
            query={findReplace.query}
            replacement={findReplace.replacement}
            caseSensitive={findReplace.caseSensitive}
            regex={findReplace.regexMode}
            wholeWord={findReplace.wholeWord}
            patternError={findPatternError}
            replaceOpen={findReplace.replaceOpen}
            matchCount={matchCount}
            activeIndex={findReplace.index}
            onQuery={findReplace.onQuery}
            onReplacement={findReplace.onReplacement}
            onCaseSensitive={findReplace.onCaseSensitive}
            onRegex={findReplace.onRegex}
            onWholeWord={findReplace.onWholeWord}
            onNext={() => findReplace.go("next")}
            onPrev={() => findReplace.go("prev")}
            onReplace={findReplace.replaceCurrent}
            onReplaceAll={findReplace.replaceEvery}
            onClose={findReplace.close}
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
        statusStore={editorStatusStore}
        stats={stats}
        normalizationReviewRequired={bannerKind === "normalization"}
        saveStatus={saveStatusLabel(activeSaveState)}
        onRequestStats={safeModeActive ? () => setStatsRequested(n => n + 1) : undefined}
      />
      {openingLabel !== null ? (
        <OpeningOverlay
          label={openingLabel}
          progress={openingProgress}
          onCancel={openCoordinator.cancelOpening}
        />
      ) : null}
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
        listSystemFonts={services.listSystemFonts}
        logState={logState}
        openUrl={url => { void services.openExternal?.(url) }}
        onRestartToApplyLogging={() => { void restartToApplyLogging(services, () => settingsSaveRef.current) }}
      />
      <AboutDialog
        isOpen={aboutOpen}
        services={services}
        onClose={() => setAboutOpen(false)}
      />
    </div>
  )
}
