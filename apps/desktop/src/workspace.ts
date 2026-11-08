import { createSession, sessionPath, type EditorSession } from "./session"

export interface Workspace {
  tabs: EditorSession[]
  activeId: number
  nextId: number
  folder: string | null
}

export function createWorkspace(): Workspace {
  const first = createSession(1)
  return { tabs: [first], activeId: first.id, nextId: 2, folder: null }
}

export function activeSession(workspace: Workspace): EditorSession {
  return workspace.tabs.find(tab => tab.id === workspace.activeId) ?? workspace.tabs[0]
}

export function replaceActive(workspace: Workspace, session: EditorSession): Workspace {
  return {
    ...workspace,
    tabs: workspace.tabs.map(tab => tab.id === workspace.activeId ? session : tab),
    activeId: session.id,
  }
}

export function replaceTabSession(workspace: Workspace, session: EditorSession): Workspace {
  if (!workspace.tabs.some(tab => tab.id === session.id)) return workspace
  return {
    ...workspace,
    tabs: workspace.tabs.map(tab => tab.id === session.id ? session : tab),
  }
}

export function addTab(workspace: Workspace, session?: EditorSession): Workspace {
  const tab = session ?? createSession(workspace.nextId)
  return {
    ...workspace,
    tabs: [...workspace.tabs, tab],
    activeId: tab.id,
    nextId: Math.max(workspace.nextId, tab.id + 1),
  }
}

export function closeTab(workspace: Workspace, id: number): Workspace {
  if (workspace.tabs.length === 1) return workspace
  const index = workspace.tabs.findIndex(tab => tab.id === id)
  if (index < 0) return workspace
  const tabs = workspace.tabs.filter(tab => tab.id !== id)
  // Closing the active tab activates the neighbor that slides into its slot
  // (next, else previous) — with equal-width tabs the close button stays under
  // the pointer, so tabs can be closed in one continuous click run.
  const activeId = workspace.activeId === id
    ? (tabs[index] ?? tabs[index - 1]).id
    : workspace.activeId
  return { ...workspace, tabs, activeId }
}

export function focusTab(workspace: Workspace, id: number): Workspace {
  if (!workspace.tabs.some(tab => tab.id === id)) return workspace
  return { ...workspace, activeId: id }
}

const EXTENDED_DRIVE_PREFIX = /^[\\/]{2}\?[\\/](?=[A-Za-z]:)/
const EXTENDED_UNC_PREFIX = /^[\\/]{2}\?[\\/]UNC[\\/]/i
const DRIVE_PREFIX = /^[A-Za-z]:/
const DRIVE_ROOT = /^[A-Za-z]:$/

/**
 * Strip a Windows extended-length prefix (`\\?\C:\…`, `\\?\UNC\server\…`)
 * without otherwise touching the path. Rust create/rename commands return
 * `fs::canonicalize(parent).join(name)`, so the wire result arrives verbatim
 * while `list_dir` rows stay native. Verbatim semantics belong to the native
 * layer; only forms crossing into UI state are simplified here.
 */
export function plainPath(path: string): string {
  const unc = EXTENDED_UNC_PREFIX.exec(path)
  if (unc) return `\\\\${path.slice(unc[0].length)}`
  const drive = EXTENDED_DRIVE_PREFIX.exec(path)
  return drive ? path.slice(drive[0].length) : path
}

function windowsForm(plain: string): boolean {
  return DRIVE_PREFIX.test(plain) || plain.startsWith("\\\\")
}

/** True for drive-letter (`C:\…`) and UNC (`\\server…`) forms, verbatim included. */
export function isWindowsPath(path: string): boolean {
  return windowsForm(plainPath(path))
}

/**
 * Separator implied by the path's own form. Backslash is a separator only on
 * Windows; on POSIX it is an ordinary file-name character and must survive
 * every join and rewrite.
 */
export function pathSeparator(path: string): "/" | "\\" {
  const plain = plainPath(path)
  return windowsForm(plain) && plain.includes("\\") ? "\\" : "/"
}

/** Canonical form for path identity: plain, forward-slash on Windows only. */
export function comparablePath(path: string): string {
  const plain = plainPath(path)
  return windowsForm(plain) ? plain.replace(/\\/g, "/") : plain
}

function lastSeparatorIndex(path: string): number {
  return isWindowsPath(path)
    ? Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))
    : path.lastIndexOf("/")
}

/**
 * Parent directory in the caller's own separator form, so tree keys keep
 * matching `list_dir` results (`C:\notes` stays native, not `C:/notes`).
 * A drive root keeps its separator (`C:\`, never the drive-relative `C:`) and
 * reports no parent of its own; the POSIX root is the parent of every
 * first-level entry and has no parent itself.
 */
export function parentDir(path: string): string | null {
  const index = lastSeparatorIndex(path)
  if (index < 0) return null
  if (index === 0) return path.length > 1 ? "/" : null
  const parent = path.slice(0, index)
  if (!DRIVE_ROOT.test(parent)) return parent
  return index + 1 === path.length ? null : path.slice(0, index + 1)
}

/**
 * True when `path` is `dir` itself or inside it. Separators are normalized
 * because watch-set inputs mix native separators (`C:\a\b.md`) with
 * forward-slash folder paths on Windows — a plain `startsWith(dir + "/")`
 * containment check is always false there and every open file got watched
 * twice (folder recursion + the file itself), doubling watcher events.
 */
export function pathWithinDir(path: string, dir: string): boolean {
  // Hot path: tree rows are keyed by the same strings the caller passes in.
  if (path === dir) return true
  const normalizedPath = comparablePath(path)
  const normalizedDir = comparablePath(dir).replace(/\/+$/, "")
  return normalizedPath === normalizedDir || normalizedPath.startsWith(`${normalizedDir}/`)
}

/** Separator- and extended-prefix-agnostic path equality (see pathWithinDir). */
export function samePath(a: string, b: string): boolean {
  return a === b || comparablePath(a) === comparablePath(b)
}

/** Final path segment, separator- and extended-prefix-agnostic. */
export function baseName(path: string): string {
  const name = path.slice(lastSeparatorIndex(path) + 1)
  return name || path
}

/** Join `name` to `dir` in the directory's own separator form. */
export function childPath(dir: string, name: string): string {
  const separator = pathSeparator(dir)
  return dir.endsWith(separator) ? dir + name : `${dir}${separator}${name}`
}

/**
 * Keep a Rust create/rename result in the caller's directory *spelling*.
 * Those commands canonicalize the parent (`fs::canonicalize`), so a workspace
 * reached through a symlink returns `/private/tmp/notes/a.md` for a
 * `/tmp/notes` tree — an identity mismatch against every tree key.
 *
 * Parent identity alone is not enough to reuse the result: `C:/notes` and
 * `C:\notes` (or a verbatim `\\?\C:\notes`) name the same directory but tree
 * keys keep whichever form `list_dir` returned for the caller's root. Reuse
 * only an exactly-spelled parent; otherwise rebuild from the caller's path.
 */
export function rebaseToDir(result: string, dir: string, name: string): string {
  return parentDir(result) === dir ? result : childPath(dir, name)
}

/** `path` relative to `dir` in comparable form, or the input when outside it. */
export function relativeToDir(path: string, dir: string): string {
  if (!pathWithinDir(path, dir)) return path
  const base = comparablePath(dir).replace(/\/+$/, "")
  const suffix = comparablePath(path).slice(base.length).replace(/^\/+/, "")
  return suffix || path
}

/**
 * Join href to the document directory and collapse `.` / `..`. Strips `#anchor`.
 * Backslashes are separators only for Windows documents; elsewhere they are
 * literal file-name characters and must not be rewritten.
 */
export function resolveMarkdownHref(docPath: string, href: string): string {
  const windows = isWindowsPath(docPath)
  const normalize = (value: string) => windows ? value.replace(/\\/g, "/") : value
  const file = normalize(href.split("#")[0] ?? href)
  const current = normalize(docPath)
  const joined = file.startsWith("/") ? file : current.slice(0, current.lastIndexOf("/") + 1) + file
  const rooted = joined.startsWith("/")
  const parts: string[] = []
  for (const part of joined.split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") {
      parts.pop()
      continue
    }
    parts.push(part)
  }
  return (rooted ? "/" : "") + parts.join("/")
}

export function openFolder(workspace: Workspace, folder: string): Workspace {
  return { ...workspace, folder }
}

export function ensureFolder(workspace: Workspace, path: string): Workspace {
  if (workspace.folder) return workspace
  const folder = parentDir(path)
  return folder ? openFolder(workspace, folder) : workspace
}

export function findTabByPath(workspace: Workspace, path: string): EditorSession | undefined {
  return workspace.tabs.find(tab => {
    const openPath = sessionPath(tab)
    return openPath !== null && samePath(openPath, path)
  })
}
