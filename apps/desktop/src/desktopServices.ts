import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { open, save } from "@tauri-apps/plugin-dialog"
import type { TreeEntry } from "./FileTree"
import type { SearchHit } from "./SearchPanel"

export interface RecoveryRecord {
  key: string
  label: string
}

export interface DesktopServices {
  pickOpenPath: () => Promise<string | null>
  pickSavePath: () => Promise<string | null>
  pickFolder?: () => Promise<string | null>
  pickExportPath?: () => Promise<string | null>
  pickCssPath?: () => Promise<string | null>
  readFile: (path: string) => Promise<string>
  writeFile: (path: string, contents: string) => Promise<void>
  allowDocumentAssets: (path: string) => Promise<void>
  allowWorkspaceDir?: (path: string) => Promise<void>
  listDir?: (path: string) => Promise<TreeEntry[]>
  searchMarkdown?: (root: string, query: string) => Promise<SearchHit[]>
  writeRecovery?: (key: string, contents: string) => Promise<void>
  listRecoveries?: () => Promise<RecoveryRecord[]>
  readRecovery?: (key: string) => Promise<string>
  clearRecovery?: (key: string) => Promise<void>
  confirmDiscard: () => boolean
  confirmClose?: () => boolean
  confirmRestore?: (label: string) => boolean
  confirmExternalChange?: () => boolean
  reportError: (message: string) => void
  printHtml?: (html: string) => Promise<void>
  listenMenu?: (handler: (id: string) => void) => () => void
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

function printHtml(html: string): Promise<void> {
  const frame = document.createElement("iframe")
  frame.setAttribute("aria-hidden", "true")
  frame.style.display = "none"
  document.body.appendChild(frame)
  const doc = frame.contentDocument
  if (!doc) {
    frame.remove()
    return Promise.resolve()
  }
  doc.open()
  doc.write(html)
  doc.close()
  frame.contentWindow?.print()
  frame.remove()
  return Promise.resolve()
}

export const defaultServices: DesktopServices = {
  pickOpenPath: () => pickPath("file", ["md", "markdown", "mdx"]),
  pickSavePath: () => pickPath("save", ["md"]),
  pickFolder: () => pickPath("folder", []),
  pickExportPath: () => pickPath("save", ["html"]),
  pickCssPath: () => pickPath("file", ["css"]),
  readFile: (path) => invoke<string>("read_file", { path }),
  writeFile: async (path, contents) => {
    await invoke("write_file", { path, contents })
  },
  allowDocumentAssets: async (path) => {
    await invoke("allow_document_assets", { documentPath: path })
  },
  allowWorkspaceDir: async (path) => {
    await invoke("allow_workspace_dir", { path })
  },
  listDir: (path) => invoke<TreeEntry[]>("list_dir", { path }),
  searchMarkdown: (root, query) => invoke<SearchHit[]>("search_markdown", { root, query }),
  writeRecovery: (key, contents) => invoke("write_recovery", { key, contents }),
  listRecoveries: () => invoke<RecoveryRecord[]>("list_recoveries"),
  readRecovery: (key) => invoke<string>("read_recovery", { key }),
  clearRecovery: (key) => invoke("clear_recovery", { key }),
  confirmDiscard: () =>
    window.confirm("Discard unsaved changes and open another document?"),
  confirmClose: () => window.confirm("Close this tab and discard unsaved changes?"),
  confirmRestore: (label) => window.confirm(`Restore unsaved draft ${label}?`),
  confirmExternalChange: () => window.confirm("File changed on disk. Reload?"),
  reportError: (message) => window.alert(message),
  printHtml,
  listenMenu: handler => {
    const pending = listen<string>("menu-command", event => handler(event.payload))
    return () => { void pending.then(unlisten => unlisten()) }
  },
}

export function errorMessage(prefix: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  return `${prefix}: ${detail}`
}

export function wordCount(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0
}
