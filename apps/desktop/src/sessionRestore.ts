import { sessionPath } from "./session"
import type { Workspace } from "./workspace"

/**
 * One tab of a per-window Hot Exit: the tab identities that `openPaths` cannot
 * express (dirty untitled buffers) plus the recovery record that carries each
 * dirty buffer. `recoveryKey` is null for a clean file tab, whose disk content
 * is the authoritative copy.
 */
export interface HotExitTabEntry {
  readonly kind: "file" | "untitled"
  readonly path: string | null
  readonly recoveryKey: string | null
}

export interface SavedSessionState {
  folder: string | null
  openPaths: readonly string[]
  activePath: string | null
  /** Tab order + dirty buffers of a Hot Exit; absent for legacy/clean shards. */
  readonly hotExitTabs?: readonly HotExitTabEntry[]
  /** Index into `hotExitTabs` of the active tab when the window was closed. */
  readonly activeTabIndex?: number
}

/**
 * Projection of a workspace into the session shard.
 *
 * Without `dirtyRecoveryKeys` this is the legacy file-only view: a plain
 * `{ folder, openPaths, activePath }` with no extra keys, so shards written by
 * older builds and their readers stay byte-compatible.
 *
 * With `dirtyRecoveryKeys` (tab id → recovery record key) the shard also
 * records the full tab order and every dirty untitled tab, which is what makes
 * a Hot Exit restore identical to the closed window instead of an approximation.
 */
export function extractSessionState(
  workspace: Workspace,
  dirtyRecoveryKeys?: ReadonlyMap<number, string>,
): SavedSessionState {
  const openPaths: string[] = []
  let activePath: string | null = null
  const hotExitTabs: HotExitTabEntry[] = []
  let activeTabIndex = 0

  for (const tab of workspace.tabs) {
    const path = sessionPath(tab)
    if (path) {
      openPaths.push(path)
      if (tab.id === workspace.activeId) {
        activePath = path
      }
    }
    if (!dirtyRecoveryKeys) continue
    const recoveryKey = dirtyRecoveryKeys.get(tab.id) ?? null
    if (path !== null) {
      hotExitTabs.push({ kind: "file", path, recoveryKey })
    } else if (recoveryKey !== null) {
      hotExitTabs.push({ kind: "untitled", path: null, recoveryKey })
    } else {
      // A clean scratch tab holds nothing worth restoring.
      continue
    }
    if (tab.id === workspace.activeId) activeTabIndex = hotExitTabs.length - 1
  }

  const state: SavedSessionState = {
    folder: workspace.folder,
    openPaths,
    activePath,
  }
  if (!dirtyRecoveryKeys) return state
  return { ...state, hotExitTabs, activeTabIndex }
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
    const state: SavedSessionState = { folder, openPaths, activePath }
    // An unreadable Hot Exit must degrade to the legacy restore, never to a
    // partially trusted one: one malformed entry drops the whole list.
    const hotExitTabs = parseHotExitTabs(parsed.hotExitTabs)
    if (hotExitTabs) {
      return {
        ...state,
        hotExitTabs,
        activeTabIndex: parseActiveTabIndex(parsed.activeTabIndex, hotExitTabs.length),
      }
    }
    return state
  } catch {
    return null
  }
}

function parseHotExitTabs(value: unknown): HotExitTabEntry[] | null {
  if (!Array.isArray(value)) return null
  const entries: HotExitTabEntry[] = []
  for (const raw of value) {
    const entry = parseHotExitTab(raw)
    if (!entry) return null
    entries.push(entry)
  }
  return entries
}

function parseHotExitTab(raw: unknown): HotExitTabEntry | null {
  if (!raw || typeof raw !== "object") return null
  const record = raw as Record<string, unknown>
  const kind = record.kind === "file" || record.kind === "untitled" ? record.kind : null
  if (!kind) return null
  const path = typeof record.path === "string" && record.path.length > 0 ? record.path : null
  // A file tab without a path has no identity to reopen.
  if (kind === "file" && path === null) return null
  const recoveryKey = typeof record.recoveryKey === "string" && record.recoveryKey.length > 0
    ? record.recoveryKey
    : null
  return { kind, path, recoveryKey }
}

function parseActiveTabIndex(value: unknown, tabCount: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return 0
  return tabCount > 0 ? Math.min(value, tabCount - 1) : 0
}
