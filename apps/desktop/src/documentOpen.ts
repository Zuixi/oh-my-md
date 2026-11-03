import type { Text } from "@codemirror/state"
import { createTextAssembler } from "@omd/engine"
import {
  createSession, openSession, recoveryKey, sessionDirty, sessionPath,
  type EditorSession,
} from "./session"
import { addTab, baseName, findTabByPath, type Workspace } from "./workspace"
import {
  errorMessage, toDocumentCommandError,
  type DesktopServices, type DiskSnapshot,
} from "./desktopServices"
import type { DocumentScaleRegistry } from "./documentScaleRegistry"
import type { TabSaveQueues } from "./documentSaveCoordinator"
import { initialSaveState, type SaveStateByTab } from "./documentSaveState"
import { t } from "./i18n"
import {
  OPEN_READONLY_THRESHOLD_BYTES,
  OPEN_SAVE_QUEUE_TIMEOUT_MS,
  OPEN_STREAM_THRESHOLD_BYTES,
} from "./constants"

/** Spec 05b 打开档位：normal 一次读；large 流式 + 默认源码；readonly 只读纯文本。 */
export type OpenTier = "normal" | "large" | "readonly" | "cancel"

export interface QuickOpenState {
  open: boolean
  files: string[]
  truncated: boolean
  loading: boolean
}

/** 文档打开协调器的宿主访问器。协调器一次构造、跨渲染保活（见
 * createDocumentOpen），宿主侧只允许经 refs/getter/稳定 setState 暴露可变
 * 状态；随渲染变化的实现必须经 *Ref.current 间接调用，否则协调器捕获的
 * 是首渲染闭包。 */
export interface DocumentOpenHost {
  readonly services: DesktopServices
  readonly documentScaleRegistry: DocumentScaleRegistry
  readonly tabSaveQueues: TabSaveQueues
  getWorkspace(): Workspace
  commitWorkspace(next: Workspace): void
  getActiveSession(): EditorSession
  getDoc(): string
  getContents(tabId: number): string
  setContents(tabId: number, contents: string): void
  getSaveStates(): SaveStateByTab
  commitSaveState(next: SaveStateByTab): void
  activateTab(id: number): void
  resetTabDocument(session: EditorSession, contents: string, docText?: Text): boolean
  flushMaterializer(): void
  syncDoc(doc: string, tabId: number): void
  revealFolder(path: string): void
  rememberRecent(path: string): void
  expandToPath(path: string): Promise<void>
  reportStatus(message: string): void
  reportUserError(message: string): void
  /** 「isOpening」布尔（App 的 openingRef）只写不读：保存/冲突侧的读者留在 App。 */
  setOpening(open: boolean): void
  setOpeningLabel(label: string | null): void
  setOpeningProgress(progress: { bytesRead: number; byteLength: number } | null): void
  setQuickOpenState(next: QuickOpenState | ((current: QuickOpenState) => QuickOpenState)): void
  isMounted(): boolean
}

export interface DocumentOpen {
  readonly openPath: (nextPath: string, inNewTab?: boolean, request?: number) => Promise<void>
  readonly runOpen: (pickPath: () => Promise<string | null>) => Promise<void>
  readonly openExternal: (nextPath: string) => Promise<void>
  readonly cancelOpening: () => void
  readonly openQuickOpen: () => Promise<void>
  readonly resolveOpenTier: (path: string) => Promise<OpenTier>
  readonly readSnapshotForOpen: (path: string, tier: OpenTier) => Promise<DiskSnapshot>
  /** 留在 App 的直开入口（loadLazyTab 等）自铸令牌：自增并返回新的请求代。 */
  readonly nextRequest: () => number
  readonly currentRequest: number
  readonly isOpenInFlight: (path: string) => boolean
  readonly invalidateOpen: (path: string) => void
  /** 作废所有在途打开（App 卸载时调用，等价原卸载 effect 的令牌自增）。 */
  readonly dispose: () => void
}

/**
 * Bounded wait: a large-document save (double probe + fsync) can run for
 * minutes under Windows antivirus scanning, and its queue promise is the only
 * unbounded await on the open path. Resolving on timeout lets the open proceed
 * while the save chain keeps running on its own.
 */
function awaitWithTimeout(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = window.setTimeout(() => resolve(), ms)
    promise
      .catch(() => undefined)
      .finally(() => {
        window.clearTimeout(timer)
        resolve()
      })
  })
}

/** 文档打开协调器：打开链路（分档预检、流式读取、令牌作废）的自有可变状态
 * （请求令牌、在途路径集、作废登记、LARGE 确认标记）私有化为实例字段。
 * 必须整个实例跨渲染保活（App 侧 `useRef` 一次构造）——工厂每渲染重建会
 * 重置令牌，并发作废与取消逻辑全部失效。 */
export function createDocumentOpen(host: DocumentOpenHost): DocumentOpen {
  const { services, documentScaleRegistry, tabSaveQueues } = host
  // 请求令牌：自增即作废所有更早的打开（取消/新打开/卸载共用）。
  let openRequest = 0
  // 在途打开的路径集合（openPath 进入 try 时登记、finally 移除），供删除侧判断
  // 是否需要作废登记。
  const openInFlight = new Set<string>()
  // 已删除路径的作废登记：仅在「删除时该路径存在在途打开」才登记，openPath 在
  // 让出事件循环的 await 之后自检并放弃（新建→立刻删除的竞态）。命中即移除，
  // 无条件登记会让同名重建文件的首个打开被静默吞掉。
  const invalidatedOpenPaths = new Set<string>()
  // LARGE 档确认本会话只需一次；HUGE（只读）每次都问。
  let largeOpenAccepted = false

  /**
   * Spec 05b 分档预检：先 stat（metadata，不读内容）再决定档位与确认，
   * 避免为一个大文件白付整读 + IPC。stat 失败按 normal 处理，
   * 真实错误由后续读取报告。LARGE 档确认一次后本会话不再问。
   */
  async function resolveOpenTier(path: string): Promise<OpenTier> {
    const stat = await services.statDocument?.(path).catch(() => undefined)
    if (!stat || stat.kind !== "existing") return "normal"
    const mb = Math.max(1, Math.round(stat.sizeBytes / (1024 * 1024)))
    const label = baseName(path)
    if (stat.sizeBytes >= OPEN_READONLY_THRESHOLD_BYTES) {
      return services.confirmReadonlyOpen?.(label, mb) ? "readonly" : "cancel"
    }
    if (stat.sizeBytes >= OPEN_STREAM_THRESHOLD_BYTES) {
      if (!largeOpenAccepted) {
        if (!services.confirmLargeOpen?.(label, mb)) return "cancel"
        largeOpenAccepted = true
      }
      return "large"
    }
    return "normal"
  }

  /**
   * Spec 05b：LARGE 档走流式（Channel 分块 + 进度，分块间 UI 线程自然让出），
   * 拼装后复用既有 ExistingDiskSnapshot 下游；其余档一次读。
   */
  async function readSnapshotForOpen(path: string, tier: OpenTier): Promise<DiskSnapshot> {
    if (tier !== "large" || !services.readDocumentStreaming) {
      return services.readDocument(path)
    }
    try {
      const parts: string[] = []
      // Task 10：与 parts 同步维护分块 Text 组装 —— chunk 到达途中即做 chunk
      // 局部切行（跨 chunk 的 \r\n 由 assembler 携带裁决），EditorState.create
      // 收到 Text 后跳过对整串的 regex 切行。镜像字符串 join 仍只做一次
      // （05b 偏差 #1 决策：脏检查/保存/恢复继续用字符串口径）。
      const assembler = createTextAssembler()
      const stream = await services.readDocumentStreaming(path, event => {
        if (event.kind === "chunk") {
          parts.push(event.text)
          assembler.push(event.text)
        } else {
          host.setOpeningProgress({ bytesRead: event.bytesRead, byteLength: event.byteLength })
        }
      })
      if (stream.kind === "missing") {
        return { kind: "missing", requestedPath: stream.requestedPath }
      }
      const contents = parts.join("")
      host.setOpeningProgress(null)
      return {
        kind: "existing",
        requestedPath: stream.requestedPath,
        contents,
        docText: assembler.finish(),
        version: stream.version,
        stats: stream.stats,
      }
    } catch {
      host.setOpeningProgress(null)
      return services.readDocument(path)
    }
  }

  async function openPath(nextPath: string, inNewTab = false, request?: number) {
    const existing = findTabByPath(host.getWorkspace(), nextPath)
    if (existing) {
      host.activateTab(existing.id)
      host.rememberRecent(nextPath)
      return
    }
    // 树/搜索等直开入口没有 runOpen 令牌：自铸一个，使「取消打开」与并发
    // 打开作废逻辑对所有入口统一（in-flight 的旧打开被更新者取代）。
    const token = request ?? nextToken()
    const tier = await resolveOpenTier(nextPath)
    if (tier === "cancel" || token !== openRequest) return
    const showOverlay = tier !== "normal"
    if (showOverlay) host.setOpeningLabel(baseName(nextPath))
    try {
      openInFlight.add(nextPath)
      let snapshot
      try {
        snapshot = await readSnapshotForOpen(nextPath, tier)
      } catch (error) {
        const cmd = toDocumentCommandError(error)
        if (cmd.code === "invalidPath" && host.isMounted()) {
          host.reportUserError(t("error.invalidPath"))
          return
        }
        if (cmd.code === "notUtf8" && host.isMounted()) {
          host.reportUserError(t("error.notUtf8"))
          return
        }
        if (token === openRequest && host.isMounted()) {
          services.reportError(errorMessage(t("error.openFailed"), error))
        }
        return
      }
      if (token !== openRequest) return
      if (snapshot.kind === "missing") {
        // 竞态里文件是被用户刚删掉的：静默放弃，不弹「文件不存在」。
        if (invalidatedOpenPaths.delete(nextPath)) return
        if (host.isMounted()) {
          services.reportError(errorMessage(t("error.openFailed"), new Error("File not found")))
        }
        return
      }
      const { contents, docText } = snapshot
      const byteLength = snapshot.stats?.byteLength
      await services.allowDocumentAssets(nextPath)
      // allowDocumentAssets 是提交前最后一个真实 await：删除可能恰在其间完成并
      // 登记，此处自检覆盖两条提交路径（新 tab 与替换当前 tab）。
      if (invalidatedOpenPaths.delete(nextPath)) return
      host.revealFolder(nextPath)
      void host.expandToPath(nextPath)
      host.rememberRecent(nextPath)
      if (inNewTab) {
        const tab = openSession(createSession(host.getWorkspace().nextId), snapshot)
        host.setContents(tab.id, contents)
        if (docText) documentScaleRegistry.stashText(tab.id, docText)
        documentScaleRegistry.setBytes(tab.id, byteLength)
        documentScaleRegistry.setReadOnly(tab.id, tier === "readonly")
        host.commitSaveState({ ...host.getSaveStates(), [tab.id]: initialSaveState() })
        host.commitWorkspace(addTab(host.getWorkspace(), tab))
        host.syncDoc(contents, tab.id)
        void services.clearRecovery?.(recoveryKey(tab))
        return
      }
      // 替换当前 tab：档位与字节数随新文档重置，避免沿用旧档残留。
      documentScaleRegistry.setBytes(host.getActiveSession().id, byteLength)
      documentScaleRegistry.setReadOnly(host.getActiveSession().id, tier === "readonly")
      if (!host.resetTabDocument(openSession(host.getActiveSession(), snapshot), contents, docText)) return
      void services.clearRecovery?.(recoveryKey(host.getActiveSession()))
    } finally {
      openInFlight.delete(nextPath)
      if (token === openRequest && showOverlay) {
        host.setOpeningLabel(null)
        host.setOpeningProgress(null)
      }
    }
  }

  /** 作废进行中的打开：读取照旧完成，但结果不再落地。 */
  function cancelOpening() {
    openRequest += 1
    host.setOpening(false)
    host.setOpeningLabel(null)
    host.setOpeningProgress(null)
  }

  async function runOpen(pickPath: () => Promise<string | null>) {
    host.flushMaterializer()
    const request = nextToken()
    const activeId = host.getWorkspace().activeId
    await awaitWithTimeout(
      tabSaveQueues.get(activeId) ?? Promise.resolve(),
      OPEN_SAVE_QUEUE_TIMEOUT_MS,
    )
    if (request !== openRequest || !host.isMounted()) return
    host.setOpening(true)
    try {
      if (sessionDirty(host.getActiveSession(), host.getDoc()) && !services.confirmDiscard()) return
      const nextPath = await pickPath()
      if (!nextPath || request !== openRequest) return
      await openPath(nextPath, false, request)
    } catch (error) {
      if (request === openRequest && host.isMounted()) {
        services.reportError(errorMessage(t("error.openFailed"), error))
      }
    } finally {
      if (request === openRequest) host.setOpening(false)
    }
  }

  function openExternal(nextPath: string): Promise<void> {
    const existing = findTabByPath(host.getWorkspace(), nextPath)
    if (existing) {
      host.activateTab(existing.id)
      host.rememberRecent(nextPath)
      return Promise.resolve()
    }
    const active = host.getActiveSession()
    const activeHasContent =
      sessionPath(active) !== null
      || host.getContents(active.id).length > 0
      || sessionDirty(active, host.getDoc())
    return openPath(nextPath, activeHasContent)
  }

  async function openQuickOpen() {
    const folder = host.getWorkspace().folder
    if (!folder) {
      host.reportStatus(t("quickOpen.noFolder"))
      return
    }
    if (!services.listMarkdownFiles) return
    host.setQuickOpenState({ open: true, files: [], truncated: false, loading: true })
    try {
      const response = await services.listMarkdownFiles(folder)
      if (!host.isMounted()) return
      host.setQuickOpenState({
        open: true,
        files: response.paths,
        truncated: response.truncated,
        loading: false,
      })
    } catch (error) {
      if (host.isMounted()) {
        host.setQuickOpenState(current => ({ ...current, loading: false }))
        services.reportError(errorMessage(t("error.openFailed"), error))
      }
    }
  }

  function nextToken(): number {
    openRequest += 1
    return openRequest
  }

  return {
    openPath,
    runOpen,
    openExternal,
    cancelOpening,
    openQuickOpen,
    resolveOpenTier,
    readSnapshotForOpen,
    nextRequest: nextToken,
    get currentRequest() { return openRequest },
    isOpenInFlight: path => openInFlight.has(path),
    invalidateOpen: path => { invalidatedOpenPaths.add(path) },
    dispose: () => { openRequest += 1 },
  }
}
