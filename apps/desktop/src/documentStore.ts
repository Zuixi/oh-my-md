/**
 * Desktop document state, held outside React.
 *
 * `App` used to keep the workspace, the per-tab text, the per-tab edit counter,
 * the dirty flags, the save states, and the normalization projections in its own
 * `useState`/`useRef` pairs. Any materialized keystroke therefore re-rendered the
 * whole shell (TopBar, FileTree, OutlinePanel, modals) even though only the
 * status bar shows word counts.
 *
 * This store is the single owner of that state. Components subscribe through the
 * narrow `useSyncExternalStore` hooks below, and every snapshot is
 * reference-stable while its inputs are unchanged — in particular
 * `dirtyTabIds`, which is rebuilt only when a tab's dirty *boolean* flips (or
 * when the tab set changes). Steady-state typing in an already-dirty tab
 * therefore notifies subscribers without changing any shell snapshot.
 */
import { useCallback, useSyncExternalStore } from "react"
import type { NormalizationByTab } from "./normalizationState"
import { sessionDirty, sessionSavedContents } from "./session"
import type { EditorSession } from "./session"
import { activeSession, createWorkspace, type Workspace } from "./workspace"
import type { SaveStateByTab } from "./documentSaveState"

export interface DocumentStore {
  readonly subscribe: (listener: () => void) => () => void
  readonly getWorkspace: () => Workspace
  readonly setWorkspace: (next: Workspace) => void
  readonly getActiveSession: () => EditorSession
  /** Materialized text of one tab (empty when the tab never materialized). */
  readonly getTabDoc: (tabId: number) => string
  readonly setTabDoc: (tabId: number, text: string) => void
  readonly deleteTabDoc: (tabId: number) => void
  /** Read-only view of the materialized text; consumers that need a `Map`. */
  readonly docs: () => ReadonlyMap<number, string>
  /** Monotonic per-tab edit counter; used as the outline/find cache axis. */
  readonly getDocVersion: (tabId: number) => number
  readonly bumpDocVersion: (tabId: number) => void
  readonly setDocVersion: (tabId: number, version: number) => void
  readonly deleteDocVersion: (tabId: number) => void
  readonly getDirtyTabIds: () => readonly number[]
  readonly isTabDirty: (tabId: number) => boolean
  readonly getSaveStateByTab: () => SaveStateByTab
  readonly setSaveStateByTab: (next: SaveStateByTab) => void
  readonly getNormalizationByTab: () => NormalizationByTab
  readonly setNormalizationByTab: (next: NormalizationByTab) => void
  /**
   * Bumped when a document's scale tier flips. The status bar drops a
   * previously granted on-demand word count so a reloaded/over-scale document
   * cannot show a stale number.
   */
  readonly getStatsEpoch: () => number
  readonly bumpStatsEpoch: () => void
}

const NO_TABS: readonly number[] = Object.freeze([])

function computeDirtyTabIds(
  workspace: Workspace,
  docs: ReadonlyMap<number, string>,
): readonly number[] {
  const ids: number[] = []
  for (const tab of workspace.tabs) {
    if (sessionDirty(tab, docs.get(tab.id) ?? "")) ids.push(tab.id)
  }
  if (ids.length === 0) return NO_TABS
  // Sorted so a tab inserted mid-restore cannot reorder an equal set.
  return ids.sort((a, b) => a - b)
}

function sameIds(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return false
  }
  return true
}

/**
 * A tab whose text was never materialized stands for its saved baseline, so a
 * workspace restored with file tabs is not momentarily reported as all-dirty.
 * Lazy tabs have no baseline yet and keep no entry until they are loaded.
 */
function seedDocs(workspace: Workspace, docs: Map<number, string>): void {
  for (const tab of workspace.tabs) {
    if (docs.has(tab.id) || tab.persistence.kind === "lazyFile") continue
    docs.set(tab.id, sessionSavedContents(tab))
  }
}

export function createDocumentStore(workspace: Workspace = createWorkspace()): DocumentStore {
  const listeners = new Set<() => void>()
  const docs = new Map<number, string>()
  seedDocs(workspace, docs)
  const docVersions = new Map<number, number>()
  let currentWorkspace = workspace
  let dirtyTabIds = computeDirtyTabIds(currentWorkspace, docs)
  let saveStateByTab: SaveStateByTab = {}
  let normalizationByTab: NormalizationByTab = {}
  let statsEpoch = 0

  const notify = (): void => {
    for (const listener of [...listeners]) listener()
  }

  const refreshDirtyTabIds = (): void => {
    const next = computeDirtyTabIds(currentWorkspace, docs)
    if (sameIds(next, dirtyTabIds)) return
    dirtyTabIds = next
  }

  return {
    subscribe: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getWorkspace: () => currentWorkspace,
    setWorkspace: next => {
      if (next === currentWorkspace) return
      currentWorkspace = next
      // Tab add/close/replace and save baselines both land here, so the dirty
      // projection is recomputed exactly once per workspace commit.
      seedDocs(currentWorkspace, docs)
      refreshDirtyTabIds()
      notify()
    },
    getActiveSession: () => activeSession(currentWorkspace),
    getTabDoc: tabId => docs.get(tabId) ?? "",
    setTabDoc: (tabId, text) => {
      if (docs.get(tabId) === text) return
      docs.set(tabId, text)
      // A keystroke that leaves the tab's dirty boolean alone keeps the exact
      // same `dirtyTabIds` reference, so shell subscribers do not re-render.
      refreshDirtyTabIds()
      notify()
    },
    deleteTabDoc: tabId => {
      if (!docs.delete(tabId)) return
      docVersions.delete(tabId)
      refreshDirtyTabIds()
      notify()
    },
    docs: () => docs,
    getDocVersion: tabId => docVersions.get(tabId) ?? 0,
    bumpDocVersion: tabId => {
      docVersions.set(tabId, (docVersions.get(tabId) ?? 0) + 1)
      notify()
    },
    setDocVersion: (tabId, version) => {
      if (docVersions.get(tabId) === version) return
      docVersions.set(tabId, version)
      notify()
    },
    deleteDocVersion: tabId => {
      if (docVersions.delete(tabId)) notify()
    },
    getDirtyTabIds: () => dirtyTabIds,
    isTabDirty: tabId => dirtyTabIds.includes(tabId),
    getSaveStateByTab: () => saveStateByTab,
    setSaveStateByTab: next => {
      if (next === saveStateByTab) return
      saveStateByTab = next
      notify()
    },
    getNormalizationByTab: () => normalizationByTab,
    setNormalizationByTab: next => {
      if (next === normalizationByTab) return
      normalizationByTab = next
      notify()
    },
    getStatsEpoch: () => statsEpoch,
    bumpStatsEpoch: () => {
      statsEpoch += 1
      notify()
    },
  }
}

function useStoreValue<T>(store: DocumentStore, read: (store: DocumentStore) => T): T {
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store])
  const getSnapshot = useCallback(() => read(store), [store, read])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useWorkspace(store: DocumentStore): Workspace {
  return useStoreValue(store, readWorkspace)
}

export function useDirtyTabIds(store: DocumentStore): readonly number[] {
  return useStoreValue(store, readDirtyTabIds)
}

export function useSaveStateByTab(store: DocumentStore): SaveStateByTab {
  return useStoreValue(store, readSaveStateByTab)
}

export function useNormalizationByTab(store: DocumentStore): NormalizationByTab {
  return useStoreValue(store, readNormalizationByTab)
}

export function useStatsEpoch(store: DocumentStore): number {
  return useStoreValue(store, readStatsEpoch)
}

/** Active tab's materialized text; subscribe only where the text is rendered. */
export function useActiveTabDoc(store: DocumentStore): string {
  return useStoreValue(store, readActiveTabDoc)
}

/** One tab's edit counter, for caches that must invalidate on content change. */
export function useDocVersion(store: DocumentStore, tabId: number): number {
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store])
  const getSnapshot = useCallback(() => store.getDocVersion(tabId), [store, tabId])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

function readWorkspace(store: DocumentStore): Workspace {
  return store.getWorkspace()
}

function readDirtyTabIds(store: DocumentStore): readonly number[] {
  return store.getDirtyTabIds()
}

function readSaveStateByTab(store: DocumentStore): SaveStateByTab {
  return store.getSaveStateByTab()
}

function readNormalizationByTab(store: DocumentStore): NormalizationByTab {
  return store.getNormalizationByTab()
}

function readStatsEpoch(store: DocumentStore): number {
  return store.getStatsEpoch()
}

function readActiveTabDoc(store: DocumentStore): string {
  return store.getTabDoc(store.getWorkspace().activeId)
}
