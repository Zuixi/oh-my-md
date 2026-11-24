/**
 * Per-tab autosave timers.
 *
 * The previous wiring kept one `setTimeout` in an effect that watched only the
 * *active* tab and cleared it on every tab switch: editing tab A and switching
 * to tab B inside the autosave window cancelled A's write, so A stayed unsaved
 * on disk until the user came back to it. A timer per tab makes the schedule a
 * property of the tab, not of the window's focus.
 */
import { canAutosave } from "./documentSaveCoordinator"
import { tabSaveState } from "./documentSaveState"
import type { DocumentStore } from "./documentStore"
import { sessionDirty, sessionPath } from "./session"

export interface AutosaveSchedulerDeps {
  /** 0 disables autosave entirely (`autosaveMs` test/disabled setting). */
  readonly getAutosaveMs: () => number
  readonly store: DocumentStore
  /** Read-only (HUGE) tabs must never persist their buffer (defense in depth). */
  readonly isReadOnly: (tabId: number) => boolean
  /** Pulls a tab's pending edits into the store so the dirty check is current. */
  readonly flushMaterialization: (tabId: number) => void
  readonly save: (tabId: number) => void
}

export interface AutosaveScheduler {
  /** Arms (or re-arms) one tab's timer; tab switches never touch other tabs. */
  readonly schedule: (tabId: number) => void
  readonly cancel: (tabId: number) => void
  readonly dispose: () => void
}

export function createAutosaveScheduler(deps: AutosaveSchedulerDeps): AutosaveScheduler {
  const timers = new Map<number, ReturnType<typeof setTimeout>>()
  /** True while a fired timer re-reads state, so its own materialize cannot re-arm. */
  let evaluating = false

  function cancel(tabId: number): void {
    const timer = timers.get(tabId)
    if (timer === undefined) return
    clearTimeout(timer)
    timers.delete(tabId)
  }

  function shouldSave(tabId: number): boolean {
    deps.flushMaterialization(tabId)
    const tab = deps.store.getWorkspace().tabs.find(item => item.id === tabId)
    // Closed while the timer was pending, or the tab lost its file identity.
    if (!tab || sessionPath(tab) === null) return false
    if (!sessionDirty(tab, deps.store.getTabDoc(tabId))) return false
    if (deps.isReadOnly(tabId)) return false
    return canAutosave({
      tabId,
      dirty: true,
      hasPath: true,
      normalization: deps.store.getNormalizationByTab(),
      saveState: tabSaveState(deps.store.getSaveStateByTab(), tabId),
    })
  }

  function schedule(tabId: number): void {
    // A materialize triggered by the fire-time flush is the same edit, not a
    // new one; re-arming here would leave a pointless trailing timer behind.
    if (evaluating) return
    if (deps.getAutosaveMs() <= 0) return
    cancel(tabId)
    timers.set(tabId, setTimeout(() => {
      timers.delete(tabId)
      evaluating = true
      try {
        if (shouldSave(tabId)) deps.save(tabId)
      } finally {
        evaluating = false
      }
    }, deps.getAutosaveMs()))
  }

  return {
    schedule,
    cancel,
    dispose: () => {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    },
  }
}
