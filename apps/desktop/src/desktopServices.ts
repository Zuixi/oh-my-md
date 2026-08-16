import { invoke } from "@tauri-apps/api/core"
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

export interface SearchResponse {
  readonly hits: SearchHit[]
  readonly truncated: boolean
}

export interface DocumentVersion {
  readonly resolvedPath: string
  readonly fingerprint: string
}

export interface ExistingDiskSnapshot {
  readonly requestedPath: string
  readonly contents: string
  readonly version: DocumentVersion
}

export type DiskSnapshot =
  | { readonly kind: "missing"; readonly requestedPath: string }
  | ({ readonly kind: "existing" } & ExistingDiskSnapshot)

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
  allowDocumentAssets: (path: string) => Promise<void>
  allowWorkspaceDir?: (path: string) => Promise<void>
  listDir?: (path: string) => Promise<TreeEntry[]>
  searchMarkdown?: (root: string, query: string, caseSensitive?: boolean) => Promise<SearchResponse>
  writeRecovery?: (key: string, contents: string) => Promise<void>
  listRecoveries?: () => Promise<RecoveryRecord[]>
  readRecovery?: (key: string) => Promise<string>
  clearRecovery?: (key: string) => Promise<void>
  confirmDiscard: () => boolean
  confirmClose?: () => boolean
  confirmDelete?: (path: string) => boolean
  confirmRestore?: (label: string) => boolean
  confirmExternalChange?: () => boolean
  getSettings?: () => Promise<UserSettings>
  saveSettings?: (settings: UserSettings) => Promise<void>
  getSessionState?: () => Promise<SavedSessionState | null>
  saveSessionState?: (state: SavedSessionState) => Promise<void>
  reportError: (message: string) => void
  listenMenu?: (handler: (id: string) => void) => () => void
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
    const path = await save({ filters: [{ name: extensions[0] ?? "File", extensions }] })
    return typeof path === "string" ? path : null
  }
  const path = await open({ filters: [{ name: "Files", extensions }] })
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
  saveDocument: (path, contents, expected) =>
    invokeDocument<SaveDocumentResult>("save_document", { path, contents, expected }),
  readFile: (path) => invoke<string>("read_file", { path }),
  writeFile: async (path, contents) => {
    await invoke("write_file", { path, contents })
  },
  revealInFinder: path => invoke("plugin:opener|reveal_item_in_dir", { path }),
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
    const path = await save({ filters: [{ name: "Diagnostics", extensions: ["zip"] }] })
    if (typeof path !== "string") return
    await invoke("export_diagnostics", { path })
  },
  allowDocumentAssets: async (path) => {
    await invoke("allow_document_assets", { documentPath: path })
  },
  allowWorkspaceDir: async (path) => {
    await invoke("allow_workspace_dir", { path })
  },
  listDir: (path) => invoke<TreeEntry[]>("list_dir", { path }),
  searchMarkdown: (root, query, caseSensitive = false) =>
    invoke<SearchResponse>("search_markdown", { root, query, caseSensitive }),
  writeRecovery: (key, contents) => invoke("write_recovery", { key, contents }),
  listRecoveries: () => invoke<RecoveryRecord[]>("list_recoveries"),
  readRecovery: (key) => invoke<string>("read_recovery", { key }),
  clearRecovery: (key) => invoke("clear_recovery", { key }),
  confirmDiscard: () =>
    window.confirm("Discard unsaved changes and open another document?"),
  confirmClose: () => window.confirm("Close this tab and discard unsaved changes?"),
  confirmDelete: (path) => {
    const normalized = path.replace(/\\/g, "/")
    const name = normalized.slice(normalized.lastIndexOf("/") + 1) || normalized
    return window.confirm(`Delete ${name}? This cannot be undone.`)
  },
  confirmRestore: (label) => window.confirm(`Restore unsaved draft ${label}?`),
  confirmExternalChange: () => window.confirm("File changed on disk. Reload?"),
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
}

export function errorMessage(prefix: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  return `${prefix}: ${detail}`
}
