import { getGlobalLogger } from "./logger"
import { pathField } from "./logPath"
import type { SaveStateByTab } from "./documentSaveState"
import { sessionPath, type EditorSession } from "./session"

/** Observe the committed state boundary; never stringify snapshots or sample
 * editor updates. Repeated polls of the same divergence stay silent. */
export function reportSaveStateTransitions(
  previous: SaveStateByTab,
  next: SaveStateByTab,
  getTab: (id: number) => EditorSession | undefined,
): void {
  for (const [key, state] of Object.entries(next)) {
    if (!state || state === previous[Number(key)]) continue
    const tabId = Number(key)
    const before = previous[tabId]
    const divergenceChanged = state.divergence.kind !== (before?.divergence.kind ?? "none")
    const saveFailed = state.lifecycle.kind === "saveFailed" && before?.lifecycle.kind !== "saveFailed"
    if (!divergenceChanged && !saveFailed) continue
    const tab = getTab(tabId)
    if (!tab) continue
    const identity = `tab=${tabId} document=${tab.documentId} ${pathField(sessionPath(tab) ?? "")}`
    if (divergenceChanged) getGlobalLogger().info("document", `divergence=${state.divergence.kind} previous=${before?.divergence.kind ?? "none"} ${identity}`)
    // The native save owns the detailed failure. This is the host's transition,
    // including failures before a native save was attempted, not a second stack.
    if (saveFailed) getGlobalLogger().warn("save", `state=saveFailed ${identity}`)
  }
}
