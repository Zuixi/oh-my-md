import { tabSaveState, type SaveStateByTab } from "./documentSaveState"
import type { NormalizationByTab } from "./normalizationState"
import { activeSession, type Workspace } from "./workspace"
import { sessionDirty, sessionLabel, type EditorSession } from "./session"

export type UpdateBlockReason =
  | "dirtyDocument"
  | "saveConflict"
  | "saveFailed"
  | "pendingNormalization"
  | "openOperation"
  | "activeSave"

export interface UpdateBlockedTab {
  readonly tabId: number
  readonly displayName: string
  readonly reason: UpdateBlockReason
}

export interface UpdateReadinessInput {
  readonly workspace: Workspace
  readonly contentsByTab: ReadonlyMap<number, string>
  readonly saveStates: SaveStateByTab
  readonly normalization: NormalizationByTab
  readonly opening: boolean
}

export interface UpdateRestartReadiness {
  readonly ready: boolean
  readonly reasons: readonly UpdateBlockedTab[]
}

function tabBlocker(
  tab: EditorSession,
  contents: string | undefined,
  saveStates: SaveStateByTab,
  normalization: NormalizationByTab,
): UpdateBlockReason | null {
  const save = tabSaveState(saveStates, tab.id)
  if (save.divergence.kind !== "none") return "saveConflict"
  if (save.lifecycle.kind === "saveFailed") return "saveFailed"
  if (save.lifecycle.kind === "saving") return "activeSave"
  if (normalization[tab.id]) return "pendingNormalization"
  if (contents !== undefined && sessionDirty(tab, contents)) return "dirtyDocument"
  return null
}

/**
 * Pure restart-readiness classification for the automatic-updates flow:
 * whether the app may restart to apply an update without losing work. Never
 * initiates saves or mutates state — it only reports what blocks the restart.
 */
export function updateRestartReadiness(input: UpdateReadinessInput): UpdateRestartReadiness {
  const { workspace, contentsByTab, saveStates, normalization, opening } = input
  const reasons: UpdateBlockedTab[] = []
  for (const tab of workspace.tabs) {
    const reason = tabBlocker(tab, contentsByTab.get(tab.id), saveStates, normalization)
    if (reason) {
      reasons.push({ tabId: tab.id, displayName: sessionLabel(tab), reason })
    }
  }
  if (opening) {
    const tab = activeSession(workspace)
    const alreadyListed = reasons.some(
      row => row.tabId === tab.id && row.reason === "openOperation",
    )
    if (!alreadyListed) {
      reasons.push({ tabId: tab.id, displayName: sessionLabel(tab), reason: "openOperation" })
    }
  }
  return { ready: reasons.length === 0, reasons }
}