/**
 * Draft recovery adoption (App split).
 *
 * The startup flow in `appSessionInit.ts` only decides *whether* a recovered
 * draft may be mounted; this module decides *where* it belongs.
 *
 * A draft that recorded its document path returns to the tab holding exactly
 * that path; the record key is an opaque file name, not an identity. A draft
 * without a path (untitled or a pre-header legacy record) falls back to the
 * tab whose `recoveryKey` matches. Only when no tab matches is a fresh
 * launch's single pristine untitled tab reused (avoids an empty extra tab);
 * every remaining draft becomes its own new tab. Existing content is never
 * overwritten silently — the user has already confirmed this record.
 *
 * Only tabs whose content is loaded are eligible: a lazy restored tab's
 * persistence still says "not read", so the next activation would fetch the
 * disk copy and overwrite the just-mounted draft (the caller is expected to
 * load the target first; see `AppSessionInitHost.ensureDraftTarget`).
 */
import {
  advanceDocumentIdentity, createSession, recoveryKey, sessionContentLoaded, sessionPath,
  sessionSavedContents, type EditorSession,
} from "./session"
import { activeSession, addTab, type Workspace } from "./workspace"

export interface RecoveryDraft {
  key: string
  path: string | null
  contents: string
}

export interface RecoveryAdoptionHost {
  getWorkspace(): Workspace
  commitWorkspace(next: Workspace): void
  getContents(tabId: number): string
  setContents(tabId: number, contents: string): void
  resetTabDocument(session: EditorSession, contents: string): boolean
  /** Registers a brand-new tab's derived state (doc version + save state).
   *  The caller sets contents and commits the workspace around this call. */
  mountNewTab(tabId: number): void
  syncDoc(value: string, tabId: number): void
}

function isPristine(workspace: Workspace, tab: EditorSession, contents: string) {
  return workspace.tabs.length === 1
    && tab.persistence.kind === "untitled"
    && sessionSavedContents(tab) === ""
    && contents === ""
}

/** Returns the tab that now holds the draft, or `null` when it was not mounted. */
export function createRecoveryAdopter(
  host: RecoveryAdoptionHost,
): (draft: RecoveryDraft) => number | null {
  const mountInto = (tab: EditorSession, contents: string): boolean => {
    // Replacing a tab's document keeps its path and adds a fresh undo history;
    // it is the same path an explicit open uses. A failed reset keeps the
    // record so the draft is still offered next launch.
    try {
      return host.resetTabDocument(advanceDocumentIdentity(tab), contents)
    } catch {
      return false
    }
  }

  return ({ key, path, contents }) => {
    const current = host.getWorkspace()
    const matching = path !== null
      ? current.tabs.find(tab => sessionContentLoaded(tab) && sessionPath(tab) === path)
      : current.tabs.find(tab => sessionContentLoaded(tab) && recoveryKey(tab) === key)
    if (matching) return mountInto(matching, contents) ? matching.id : null

    const active = activeSession(current)
    if (isPristine(current, active, host.getContents(active.id))) {
      if (mountInto(active, contents)) return active.id
      // No view yet: the tab's content store still carries the draft and the
      // view will mount from it.
      host.setContents(active.id, contents)
      host.syncDoc(contents, active.id)
      return active.id
    }
    const tab = createSession(current.nextId)
    host.setContents(tab.id, contents)
    host.mountNewTab(tab.id)
    host.commitWorkspace(addTab(current, tab))
    host.syncDoc(contents, tab.id)
    return tab.id
  }
}
