import { sessionPath } from "./session"
import type { Workspace } from "./workspace"

export interface SavedSessionState {
  folder: string | null
  openPaths: readonly string[]
  activePath: string | null
}

export function extractSessionState(workspace: Workspace): SavedSessionState {
  const openPaths: string[] = []
  let activePath: string | null = null

  for (const tab of workspace.tabs) {
    const path = sessionPath(tab)
    if (path) {
      openPaths.push(path)
      if (tab.id === workspace.activeId) {
        activePath = path
      }
    }
  }

  return {
    folder: workspace.folder,
    openPaths,
    activePath,
  }
}

export function parseSessionState(json: string): SavedSessionState | null {
  try {
    const parsed = JSON.parse(json)
    if (!parsed || typeof parsed !== "object") return null
    const folder = typeof parsed.folder === "string" ? parsed.folder : null
    const openPaths = Array.isArray(parsed.openPaths)
      ? parsed.openPaths.filter((p: unknown): p is string => typeof p === "string" && p.length > 0)
      : []
    const activePath = typeof parsed.activePath === "string" ? parsed.activePath : null
    return { folder, openPaths, activePath }
  } catch {
    return null
  }
}
