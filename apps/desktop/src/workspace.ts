import { createSession, type EditorSession } from "./session"

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

export function openFolder(workspace: Workspace, folder: string): Workspace {
  return { ...workspace, folder }
}

export function ensureFolder(workspace: Workspace, path: string): Workspace {
  if (workspace.folder) return workspace
  const folder = parentDir(path)
  return folder ? openFolder(workspace, folder) : workspace
}

export function findTabByPath(workspace: Workspace, path: string): EditorSession | undefined {
  return workspace.tabs.find(tab => tab.path === path)
}
