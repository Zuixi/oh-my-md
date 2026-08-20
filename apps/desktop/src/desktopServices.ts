import { Channel, invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { open, save } from "@tauri-apps/plugin-dialog"
import { exportSaveOptions } from "./exportPath"
import { parseRecents } from "./recents"
import {
  MARKDOWN_EXTENSIONS,
  STORAGE_KEY_RECENTS,
  STORAGE_KEY_SESSION,
  STORAGE_KEY_SETTINGS,
} from "./constants"
import { parseSettings, type UserSettings } from "./settings"
import { parseSessionState, type SavedSessionState } from "./sessionRestore"
import type { TreeEntry } from "./FileTree"
import type { SearchHit } from "./SearchPanel"
import { t } from "./i18n"

export interface SearchResponse {
  readonly hits: SearchHit[]
  readonly truncated: boolean
}

export interface QuickOpenResponse {
  readonly paths: string[]
  readonly truncated: boolean
}

export interface SnapshotEntry {
  readonly fileName: string
  readonly mtimeMs: number
  readonly sizeBytes: number
}

export interface DocumentVersion {
  readonly resolvedPath: string
  readonly fingerprint: string
}

export interface DocumentFileStats {
  readonly byteLength: number
  readonly lineCount: number
}

export interface ExistingDiskSnapshot {
  readonly requestedPath: string
  readonly contents: string
  readonly version: DocumentVersion
  /** Optional for older fixtures; production snapshots always carry it. */
  readonly stats?: DocumentFileStats
}

export type DiskSnapshot =
  | { readonly kind: "missing"; readonly requestedPath: string }
  | ({ readonly kind: "existing" } & ExistingDiskSnapshot)

export type DocumentStat =
  | { readonly kind: "missing"; readonly requestedPath: string }
  | { readonly kind: "existing"; readonly requestedPath: string; readonly sizeBytes: number }

/** Spec 05b LARGE 档流式打开：分块文本 + 字节进度经 Channel 推送。 */
export type OpenStreamEvent =
  | { readonly kind: "progress"; readonly bytesRead: number; readonly byteLength: number }
  | { readonly kind: "chunk"; readonly index: number; readonly text: string }

export type DocumentOpenStream =
  | { readonly kind: "missing"; readonly requestedPath: string }
  | {
      readonly kind: "existing"
      readonly requestedPath: string
      readonly version: DocumentVersion
      readonly stats: DocumentFileStats
    }

export type ExpectedDocumentVersion =
  | { readonly kind: "missing" }
  | { readonly kind: "existing"; readonly version: DocumentVersion }

export type SaveDocumentResult =
  | {
      readonly status: "saved"
      readonly version: DocumentVersion
      readonly durability: "durable" | "directorySyncFailed"
    }
  | {
      readonly status: "contentConflict" | "createdConflict"
      readonly disk: ExistingDiskSnapshot
    }
  | { readonly status: "deletedConflict"; readonly requestedPath: string }
  | { readonly status: "pathChangedConflict"; readonly requestedPath: string }
  | { readonly status: "unexpectedSymlinkConflict"; readonly requestedPath: string }

export type DocumentErrorCode =
  | "invalidPath"
  | "notUtf8"
  | "readFailed"
  | "writeFailed"
  | "permissionDenied"
  | "metadataFailed"
  | "internal"

export interface DocumentCommandError {
  readonly code: DocumentErrorCode
  readonly message: string
}

export const DOCUMENT_ERROR_CODES = [
  "invalidPath",
  "notUtf8",
  "readFailed",
  "writeFailed",
  "permissionDenied",
  "metadataFailed",
  "internal",
] as const satisfies readonly DocumentErrorCode[]

export interface RecoveryRecord {
  key: string
  label: string
}

export interface UpdateCheck {
  readonly version: string
  readonly currentVersion: string
}

export interface ViewMenuState {
  readonly source: boolean
  readonly sidebar: boolean
  readonly outline: boolean
  readonly typewriter: boolean
  readonly focus: boolean
}

export interface DesktopServices {
  pickOpenPath: () => Promise<string | null>
  pickSavePath: () => Promise<string | null>
  pickFolder?: () => Promise<string | null>
  pickExportPath?: (format?: "html" | "png" | "pdf") => Promise<string | null>
  exportPreview?: (html: string, path: string, format: "pdf" | "png") => Promise<string | null>
  pickCssPath?: () => Promise<string | null>
  readDocument: (path: string) => Promise<DiskSnapshot>
  readDocumentVersion: (path: string) => Promise<ExpectedDocumentVersion>
  statDocument?: (path: string) => Promise<DocumentStat>
  readDocumentStreaming?: (
    path: string,
    onEvent: (event: OpenStreamEvent) => void,
  ) => Promise<DocumentOpenStream>
  saveDocument: (
    path: string,
    contents: string,
    expected: ExpectedDocumentVersion,
  ) => Promise<SaveDocumentResult>
  readFile: (path: string) => Promise<string>
  writeFile: (path: string, contents: string) => Promise<void>
  revealInFinder?: (path: string) => Promise<void>
  createMarkdown?: (dir: string, name: string) => Promise<string>
  createDir?: (dir: string, name: string) => Promise<string>
  renamePath?: (from: string, toName: string) => Promise<string>
  deletePath?: (path: string) => Promise<void>
  loadRecents?: () => string[]
  saveRecents?: (paths: string[]) => void
  setRecentMenu?: (paths: string[]) => Promise<void>
  setViewMenuState?: (state: ViewMenuState) => Promise<void>
  exportDiagnostics?: () => Promise<void>
  setMenuLocale?: (locale: string) => Promise<void>
  quitApp?: () => Promise<void>
  appVersion?: () => Promise<string>
  allowDocumentAssets: (path: string) => Promise<void>
  allowWorkspaceDir?: (path: string) => Promise<void>
  listDir?: (path: string) => Promise<TreeEntry[]>
  searchMarkdown?: (root: string, query: string, caseSensitive?: boolean) => Promise<SearchResponse>
  listMarkdownFiles?: (root: string) => Promise<QuickOpenResponse>
  snapshotDocument?: (path: string) => Promise<void>
  listSnapshots?: (path: string) => Promise<SnapshotEntry[]>
  readSnapshot?: (path: string, fileName: string) => Promise<string>
  clearSnapshots?: (path: string) => Promise<void>
  writeRecovery?: (key: string, contents: string) => Promise<void>
  listRecoveries?: () => Promise<RecoveryRecord[]>
  readRecovery?: (key: string) => Promise<string>
  clearRecovery?: (key: string) => Promise<void>
  confirmDiscard: () => boolean
  confirmClose?: () => boolean
  confirmLargeOpen?: (label: string, mb: number) => boolean
  confirmReadonlyOpen?: (label: string, mb: number) => boolean
  confirmDelete?: (path: string) => boolean
  confirmRestore?: (label: string) => boolean
  confirmExternalChange?: () => boolean
  getSettings?: () => Promise<UserSettings>
  saveSettings?: (settings: UserSettings) => Promise<void>
  getSessionState?: () => Promise<SavedSessionState | null>
  saveSessionState?: (state: SavedSessionState) => Promise<void>
  reportError: (message: string) => void
  listenMenu?: (handler: (id: string) => void) => () => void
  listenOpenFile?: (handler: (path: string) => void) => () => void
  listenDragDrop?: (handler: (paths: string[]) => void) => () => void
  listenWorkspaceChange?: (handler: (paths: string[]) => void) => () => void
  watchPaths?: (paths: string[]) => Promise<void>
  takePendingOpenFiles?: () => Promise<string[]>
  openExternal?: (url: string) => Promise<void>
  checkForUpdates?: () => Promise<UpdateCheck | null>
}

function isDocumentErrorCode(code: string): code is DocumentErrorCode {
  return (DOCUMENT_ERROR_CODES as readonly string[]).includes(code)
}

export function toDocumentCommandError(error: unknown): DocumentCommandError {
  if (
    typeof error === "object"
    && error !== null
    && "code" in error
    && "message" in error
    && typeof error.code === "string"
    && typeof error.message === "string"
    && isDocumentErrorCode(error.code)
  ) {
    return { code: error.code, message: error.message }
  }
  if (error instanceof Error) {
    return { code: "internal", message: error.message }
  }
  return { code: "internal", message: String(error) }
}

async function invokeDocument<T>(command: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args)
  } catch (error) {
    throw toDocumentCommandError(error)
  }
}

async function pickPath(kind: "file" | "folder" | "save", extensions: string[]): Promise<string | null> {
  if (kind === "folder") {
    const path = await open({ directory: true })
    return typeof path === "string" ? path : null
  }
  if (kind === "save") {
    const path = await save({ filters: [{ name: t("dialog.filter.file"), extensions }] })
    return typeof path === "string" ? path : null
  }
  const path = await open({ filters: [{ name: t("dialog.filter.files"), extensions }] })
  return typeof path === "string" ? path : null
}

export const defaultServices: DesktopServices = {
  pickOpenPath: () => pickPath("file", [...MARKDOWN_EXTENSIONS]),
  pickSavePath: () => pickPath("save", ["md"]),
  pickFolder: () => pickPath("folder", []),
  pickExportPath: async (format = "html") => {
    const path = await save(exportSaveOptions(format))
    return typeof path === "string" ? path : null
  },
  pickCssPath: () => pickPath("file", ["css"]),
  readDocument: path => invokeDocument<DiskSnapshot>("read_document", { path }),
  readDocumentVersion: path =>
    invokeDocument<ExpectedDocumentVersion>("read_document_version", { path }),
  statDocument: path => invokeDocument<DocumentStat>("stat_document", { path }),
  readDocumentStreaming: (path, onEvent) => {
    const channel = new Channel<OpenStreamEvent>()
    channel.onmessage = onEvent
    return invokeDocument<DocumentOpenStream>("read_document_streaming", {
      path,
      onChunk: channel,
    })
  },
  saveDocument: (path, contents, expected) =>
    invokeDocument<SaveDocumentResult>("save_document", { path, contents, expected }),
  readFile: (path) => invoke<string>("read_file", { path }),
  writeFile: async (path, contents) => {
    await invoke("write_file", { path, contents })
  },
  revealInFinder: async path => {
    // Rejects by design: callers report via .catch → reportError — do not swallow like openExternal (best-effort).
    const { revealItemInDir } = await import("@tauri-apps/plugin-opener")
    await revealItemInDir(path)
  },
  createMarkdown: (dir, name) => invoke<string>("create_markdown", { dir, name }),
  createDir: (dir, name) => invoke<string>("create_dir", { dir, name }),
  renamePath: (from, toName) => invoke<string>("rename_path", { from, toName }),
  deletePath: async path => {
    await invoke("delete_path", { path })
  },
  exportPreview: async (html, path, format) => {
    return await invoke<string | null>("export_preview", { html, path, format })
  },
  loadRecents: () => {
    try {
      return parseRecents(localStorage.getItem(STORAGE_KEY_RECENTS))
    } catch {
      return []
    }
  },
  saveRecents: paths => {
    localStorage.setItem(STORAGE_KEY_RECENTS, JSON.stringify(paths))
  },
  setRecentMenu: async paths => {
    await invoke("set_recent_files", { paths })
  },
  setViewMenuState: async state => {
    await invoke("set_view_menu_state", { state })
  },
  exportDiagnostics: async () => {
    const path = await save({ filters: [{ name: t("dialog.filter.diagnostics"), extensions: ["zip"] }] })
    if (typeof path !== "string") return
    await invoke("export_diagnostics", { path })
  },
  setMenuLocale: async locale => {
    await invoke("set_menu_locale", { locale })
  },
  quitApp: async () => {
    await invoke("quit_app")
  },
  appVersion: () => invoke<string>("app_version"),
  allowDocumentAssets: async (path) => {
    await invoke("allow_document_assets", { documentPath: path })
  },
  allowWorkspaceDir: async (path) => {
    await invoke("allow_workspace_dir", { path })
  },
  listDir: (path) => invoke<TreeEntry[]>("list_dir", { path }),
  searchMarkdown: (root, query, caseSensitive = false) =>
    invoke<SearchResponse>("search_markdown", { root, query, caseSensitive }),
  listMarkdownFiles: root =>
    invoke<QuickOpenResponse>("list_markdown_files", { root }),
  snapshotDocument: path => invoke<void>("snapshot_document", { path }),
  listSnapshots: path => invoke<SnapshotEntry[]>("list_snapshots", { path }),
  readSnapshot: (path, fileName) =>
    invoke<string>("read_snapshot", { path, fileName }),
  clearSnapshots: path => invoke<void>("clear_snapshots", { path }),
  writeRecovery: (key, contents) => invoke("write_recovery", { key, contents }),
  listRecoveries: () => invoke<RecoveryRecord[]>("list_recoveries"),
  readRecovery: (key) => invoke<string>("read_recovery", { key }),
  clearRecovery: (key) => invoke("clear_recovery", { key }),
  confirmDiscard: () => window.confirm(t("confirm.discard")),
  confirmClose: () => window.confirm(t("confirm.close")),
  confirmLargeOpen: (label, mb) => window.confirm(t("confirm.largeOpen", { label, mb })),
  confirmReadonlyOpen: (label, mb) => window.confirm(t("confirm.readonlyOpen", { label, mb })),
  confirmDelete: (path) => {
    const normalized = path.replace(/\\/g, "/")
    const name = normalized.slice(normalized.lastIndexOf("/") + 1) || normalized
    return window.confirm(t("confirm.delete", { name }))
  },
  confirmRestore: (label) => window.confirm(t("confirm.restore", { label })),
  confirmExternalChange: () => window.confirm(t("confirm.externalChange")),
  getSettings: async () => {
    try {
      const json = await invoke<string>("get_settings")
      return parseSettings(json)
    } catch {
      try {
        const local = localStorage.getItem(STORAGE_KEY_SETTINGS)
        return parseSettings(local ?? "{}")
      } catch {
        return parseSettings("{}")
      }
    }
  },
  saveSettings: async (settings: UserSettings) => {
    const json = JSON.stringify(settings, null, 2)
    try {
      await invoke("save_settings", { contents: json })
    } catch {
      try {
        localStorage.setItem(STORAGE_KEY_SETTINGS, json)
      } catch {
        // ignore
      }
    }
  },
  getSessionState: async () => {
    try {
      const json = await invoke<string>("get_session_state")
      return parseSessionState(json)
    } catch {
      try {
        const local = localStorage.getItem(STORAGE_KEY_SESSION)
        return parseSessionState(local ?? "{}")
      } catch {
        return null
      }
    }
  },
  saveSessionState: async (state: SavedSessionState) => {
    const json = JSON.stringify(state, null, 2)
    try {
      await invoke("save_session_state", { contents: json })
    } catch {
      try {
        localStorage.setItem(STORAGE_KEY_SESSION, json)
      } catch {
        // ignore
      }
    }
  },
  checkForUpdates: async () => {
    try {
      const { check } = await import("@tauri-apps/plugin-updater")
      const update = await check()
      if (!update) return null
      return { version: update.version, currentVersion: update.currentVersion }
    } catch {
      return null
    }
  },
  reportError: (message) => window.alert(message),
  listenMenu: handler => {
    const pending = listen<string>("menu-command", event => handler(event.payload))
    return () => { void pending.then(unlisten => unlisten()) }
  },
  listenOpenFile: handler => {
    const pending = listen<string>("open-file", event => handler(event.payload))
    return () => { void pending.then(unlisten => unlisten()) }
  },
  listenDragDrop: handler => {
    // Native drag events carry real file paths (HTML File objects do not);
    // the image drop channel in imagePaste.ts stays on HTML events.
    const pending = import("@tauri-apps/api/webview").then(({ getCurrentWebview }) =>
      getCurrentWebview().onDragDropEvent(event => {
        if (event.payload.type === "drop") handler(event.payload.paths)
      }))
    return () => { void pending.then(unlisten => unlisten()) }
  },
  listenWorkspaceChange: handler => {
    const pending = listen<string[]>("workspace-changed", event => handler(event.payload))
    return () => { void pending.then(unlisten => unlisten()) }
  },
  watchPaths: async paths => {
    try {
      await invoke("watch_paths", { paths })
    } catch {
      // Watching is only an early hint; the fallback poll keeps correctness.
    }
  },
  takePendingOpenFiles: async () => {
    try {
      return await invoke<string[]>("take_pending_open_files")
    } catch {
      return []
    }
  },
  openExternal: async url => {
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener")
      await openUrl(url)
    } catch {
      // Opening the browser is best-effort; never block the editor on it.
    }
  },
}

export function errorMessage(prefix: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  return `${prefix}: ${detail}`
}
