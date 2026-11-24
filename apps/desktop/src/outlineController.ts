/**
 * Outline state for the whole window: the debounced refresh after edits, the
 * idle backfill for over-scale documents, the per-tab cache, and the hover
 * preview timers.
 *
 * Deliberately not a React hook: `App`'s tab activation must be able to refresh
 * the outline without the shell subscribing to the document (that subscription
 * is what used to re-render the whole tree on every materialized keystroke).
 * Only the outline panel subscribes, through `useOutlineItems` / `useOutlineHover`.
 */
import { useCallback, useSyncExternalStore } from "react"
import type { EditorView } from "@codemirror/view"
import type { OutlineItem } from "@omd/engine"
import { documentOutline } from "./Editor"
import type { DocumentScaleRegistry } from "./documentScaleRegistry"
import type { DocumentStore } from "./documentStore"
import type { EditorRegistry } from "./editorRegistry"

/** collectOutline walks the whole syntax tree; it must stay off the key path. */
export const OUTLINE_DEBOUNCE_MS = 150
/** Idle backfill deadline for over-scale documents on a busy main thread. */
const OUTLINE_IDLE_TIMEOUT_MS = 200
export const OUTLINE_HOVER_OPEN_MS = 180
export const OUTLINE_HOVER_CLOSE_MS = 120

const EMPTY_OUTLINE: OutlineItem[] = []

// Same fallback as the engine's buildDriver: browsers use requestIdleCallback
// (timeout guarantees it eventually runs); happy-dom and friends degrade to a
// macrotask.
interface OutlineIdleGlobal {
  requestIdleCallback?: (callback: () => void, options: { timeout: number }) => void
  cancelIdleCallback?: (handle: number) => void
}

function scheduleOutlineIdle(callback: () => void): void {
  const idle = globalThis as OutlineIdleGlobal
  if (typeof idle.requestIdleCallback === "function" && typeof idle.cancelIdleCallback === "function") {
    idle.requestIdleCallback(callback, { timeout: OUTLINE_IDLE_TIMEOUT_MS })
    return
  }
  window.setTimeout(callback, 0)
}

interface CachedOutline {
  readonly version: number
  readonly outline: OutlineItem[]
}

export interface OutlineController {
  readonly subscribe: (listener: () => void) => () => void
  /** Reference-stable between real changes (safe for `useSyncExternalStore`). */
  readonly getItems: () => OutlineItem[]
  readonly isHoverOpen: () => boolean
  /** The panel was opened/closed; opening re-schedules a refresh. */
  readonly setPanelOpen: (open: boolean) => void
  readonly refresh: (view: EditorView | null) => void
  /** Drops one tab's cache entry; a reload restarts its version at 0, so the
   *  version counter alone cannot distinguish old from new content. */
  readonly invalidate: (tabId: number) => void
  readonly openHoverPreview: () => void
  readonly scheduleHoverClose: () => void
  readonly closeHover: () => void
  readonly dispose: () => void
  /** Re-attaches after a StrictMode cleanup disposed the controller. */
  readonly reset: () => void
}

export function createOutlineController(input: {
  readonly store: DocumentStore
  readonly registry: EditorRegistry
  readonly documentScaleRegistry: DocumentScaleRegistry
}): OutlineController {
  const { store, registry, documentScaleRegistry } = input
  const listeners = new Set<() => void>()
  const cache = new Map<number, CachedOutline>()
  let items: OutlineItem[] = EMPTY_OUTLINE
  let hoverOpen = false
  let panelOpen = false
  // Generation token for the async over-scale backfill: every new schedule or
  // unmount bumps it, so an old idle callback can never write a stale outline.
  let fillToken = 0
  let hoverTimer: number | null = null
  let debounceTimer: number | null = null
  let lastTabId = store.getWorkspace().activeId
  let lastVersion = store.getDocVersion(lastTabId)

  const notify = (): void => {
    for (const listener of [...listeners]) listener()
  }

  const setItems = (next: OutlineItem[]): void => {
    if (next === items) return
    items = next
    notify()
  }

  const setHoverOpen = (next: boolean): void => {
    if (next === hoverOpen) return
    hoverOpen = next
    notify()
  }

  const refresh = (view: EditorView | null): void => {
    const tabId = store.getWorkspace().activeId
    const version = store.getDocVersion(tabId)
    const cached = cache.get(tabId)
    if (cached && cached.version === version) {
      setItems(cached.outline)
      return
    }
    // The view must belong to the active tab: during a lazy tab's first
    // activation the registry may still hand out the previous tab's view, and
    // computing from it would file another document under this tab's cache.
    if (!view || registry.getView(tabId) !== view) {
      setItems(EMPTY_OUTLINE)
      return
    }
    if (!documentScaleRegistry.isSafeMode(tabId)) {
      const outline = documentOutline(view)
      cache.set(tabId, { version, outline })
      setItems(outline)
      return
    }
    setItems(cached ? cached.outline : EMPTY_OUTLINE)
    const token = ++fillToken
    scheduleOutlineIdle(() => {
      if (token !== fillToken) return
      if (store.getWorkspace().activeId !== tabId) return
      if (store.getDocVersion(tabId) !== version) return
      const outline = documentOutline(view)
      cache.set(tabId, { version, outline })
      setItems(outline)
    })
  }

  const scheduleRefresh = (): void => {
    if (!panelOpen) return
    if (debounceTimer !== null) window.clearTimeout(debounceTimer)
    debounceTimer = window.setTimeout(() => {
      debounceTimer = null
      refresh(registry.getActiveView())
    }, OUTLINE_DEBOUNCE_MS)
  }

  // The store is the edit signal: a version bump (content change) or an active
  // tab change are the only things that can invalidate the panel.
  let unsubscribe: (() => void) | null = null
  const attachStore = (): void => {
    unsubscribe?.()
    unsubscribe = store.subscribe(() => {
      const tabId = store.getWorkspace().activeId
      const version = store.getDocVersion(tabId)
      if (tabId === lastTabId && version === lastVersion) return
      lastTabId = tabId
      lastVersion = version
      scheduleRefresh()
    })
  }
  attachStore()

  const cancelHoverTimer = (): void => {
    if (hoverTimer !== null) window.clearTimeout(hoverTimer)
    hoverTimer = null
  }

  return {
    subscribe: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getItems: () => items,
    isHoverOpen: () => hoverOpen,
    setPanelOpen: open => {
      panelOpen = open
      if (open) scheduleRefresh()
    },
    refresh,
    invalidate: tabId => { cache.delete(tabId) },
    openHoverPreview: () => {
      if (panelOpen) return
      cancelHoverTimer()
      hoverTimer = window.setTimeout(() => {
        hoverTimer = null
        refresh(registry.getActiveView())
        setHoverOpen(true)
      }, OUTLINE_HOVER_OPEN_MS)
    },
    scheduleHoverClose: () => {
      cancelHoverTimer()
      hoverTimer = window.setTimeout(() => {
        hoverTimer = null
        setHoverOpen(false)
      }, OUTLINE_HOVER_CLOSE_MS)
    },
    closeHover: () => {
      cancelHoverTimer()
      setHoverOpen(false)
    },
    dispose: () => {
      unsubscribe?.()
      unsubscribe = null
      cancelHoverTimer()
      if (debounceTimer !== null) window.clearTimeout(debounceTimer)
      debounceTimer = null
      fillToken += 1
    },
    reset: () => {
      if (unsubscribe !== null) return
      lastTabId = store.getWorkspace().activeId
      lastVersion = store.getDocVersion(lastTabId)
      attachStore()
      if (panelOpen) scheduleRefresh()
    },
  }
}

export function useOutlineItems(controller: OutlineController): OutlineItem[] {
  const subscribe = useCallback((listener: () => void) => controller.subscribe(listener), [controller])
  return useSyncExternalStore(subscribe, controller.getItems, controller.getItems)
}

export function useOutlineHover(controller: OutlineController): boolean {
  const subscribe = useCallback((listener: () => void) => controller.subscribe(listener), [controller])
  return useSyncExternalStore(subscribe, controller.isHoverOpen, controller.isHoverOpen)
}
