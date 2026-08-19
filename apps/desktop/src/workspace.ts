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
  const tabs = workspace.tabs.filter(tab => tab.id !== id)
  const activeId = workspace.activeId === id ? tabs[tabs.length - 1].id : workspace.activeId
  return { ...workspace, tabs, activeId }
}

export function focusTab(workspace: Workspace, id: number): Workspace {
  if (!workspace.tabs.some(tab => tab.id === id)) return workspace
  return { ...workspace, activeId: id }
}

export function parentDir(path: string): string | null {
  const normalized = path.replace(/\\/g, "/")
  const index = normalized.lastIndexOf("/")
  if (index <= 0) return null
  return normalized.slice(0, index)
}

/**
 * True when `path` is `dir` itself or inside it. Separators are normalized
 * because watch-set inputs mix native separators (`C:\a\b.md`) with
 * forward-slash folder paths on Windows — a plain `startsWith(dir + "/")`
 * containment check is always false there and every open file got watched
 * twice (folder recursion + the file itself), doubling watcher events.
 */
export function pathWithinDir(path: string, dir: string): boolean {
  const normalizedPath = path.replace(/\\/g, "/")
  const normalizedDir = dir.replace(/\\/g, "/").replace(/\/+$/, "")
  return normalizedPath === normalizedDir || normalizedPath.startsWith(`${normalizedDir}/`)
}

/** Final path segment, separator-agnostic (used for open-status labels). */
export function baseName(path: string): string {
  const normalized = path.replace(/\\/g, "/")
  const name = normalized.slice(normalized.lastIndexOf("/") + 1)
  return name || path
}

/** Join href to the document directory and collapse `.` / `..`. Strips `#anchor`. */
export function resolveMarkdownHref(docPath: string, href: string): string {
  const file = (href.split("#")[0] ?? href).replace(/\\/g, "/")
  const current = docPath.replace(/\\/g, "/")
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
  return workspace.tabs.find(tab => sessionPath(tab) === path)
}
