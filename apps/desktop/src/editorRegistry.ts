/**
 * Live CodeMirror view ownership for the whole window.
 *
 * `App` used to hold four parallel refs (`hostsRef`, `viewsRef`, `viewRef`, and
 * the per-tab scale registry) and rebuilt their invariants in a dozen places.
 * This registry is the single owner of host elements and views, and adds a
 * bounded live-view budget: past `MAX_LIVE_EDITOR_VIEWS` the least recently
 * activated *clean* background tab is torn down (its text already lives in
 * `DocumentStore`) and rebuilt on return. A plain HTML host div stays mounted so
 * React keeps its DOM position; only the CodeMirror view is released.
 */
import type { EditorView } from "@codemirror/view"

export interface EvictedViewState {
  readonly anchor: number
  readonly head: number
  readonly scrollTop: number
}

/**
 * A live view is expensive for large documents (rope + decorations + widgets).
 * Eight keeps every ordinary multi-tab session churn-free while bounding memory
 * for a window that accumulates dozens of tabs.
 */
export const MAX_LIVE_EDITOR_VIEWS = 8

export interface EditorRegistry {
  /** React host ref callback: `null` unbinds, a node binds. */
  readonly bindHost: (tabId: number, el: HTMLDivElement | null) => void
  readonly getHost: (tabId: number) => HTMLDivElement | undefined
  readonly getView: (tabId: number) => EditorView | undefined
  readonly getActiveView: () => EditorView | null
  readonly setActiveView: (tabId: number) => void
  readonly views: () => ReadonlyMap<number, EditorView>
  readonly add: (tabId: number, view: EditorView) => void
  /** Rebuilds an evicted tab into its mounted host, restoring caret + scroll. */
  readonly revive: (tabId: number, create: (host: HTMLDivElement) => EditorView) => EditorView | null
  /** Whether a tab's view was released and must be revived before use. */
  readonly isEvicted: (tabId: number) => boolean
  readonly destroy: (tabId: number) => void
  readonly destroyAll: () => void
  /**
   * Tears down clean background views beyond the live budget. `flush` receives
   * the tab's final text so a pending edit is never lost with the view.
   */
  readonly evictOverBudget: (input: {
    readonly activeTabId: number
    readonly isEvictable: (tabId: number) => boolean
    readonly flush: (tabId: number, contents: string) => void
    readonly maxLiveViews?: number
  }) => void
}

export function createEditorRegistry(): EditorRegistry {
  const hosts = new Map<number, HTMLDivElement>()
  const views = new Map<number, EditorView>()
  const lastActivatedAt = new Map<number, number>()
  const evicted = new Map<number, EvictedViewState>()
  let activationClock = 0
  let activeViewId: number | null = null

  const touch = (tabId: number): void => {
    lastActivatedAt.set(tabId, ++activationClock)
  }

  const snapshot = (view: EditorView): EvictedViewState => {
    const length = docLength(view)
    return {
      anchor: clampToDoc(view.state.selection?.main.anchor ?? 0, length),
      head: clampToDoc(view.state.selection?.main.head ?? 0, length),
      // Fake views in tests have no scrollDOM; production ones always do.
      scrollTop: view.scrollDOM?.scrollTop ?? 0,
    }
  }

  const restore = (view: EditorView, state: EvictedViewState): void => {
    const length = docLength(view)
    try {
      view.dispatch({
        selection: {
          anchor: clampToDoc(state.anchor, length),
          head: clampToDoc(state.head, length),
        },
      })
    } catch {
      /* a view that rejects selection still shows the restored text */
    }
    if (view.scrollDOM) view.scrollDOM.scrollTop = state.scrollTop
  }

  return {
    bindHost: (tabId, el) => {
      if (el) hosts.set(tabId, el)
      else hosts.delete(tabId)
    },
    getHost: tabId => hosts.get(tabId),
    getView: tabId => views.get(tabId),
    getActiveView: () => activeViewId === null ? null : views.get(activeViewId) ?? null,
    setActiveView: tabId => {
      activeViewId = tabId
      touch(tabId)
    },
    views: () => views,
    add: (tabId, view) => {
      views.set(tabId, view)
      touch(tabId)
    },
    revive: (tabId, create) => {
      const host = hosts.get(tabId)
      if (!host) return null
      const state = evicted.get(tabId)
      evicted.delete(tabId)
      const view = create(host)
      views.set(tabId, view)
      touch(tabId)
      if (state) restore(view, state)
      return view
    },
    isEvicted: tabId => evicted.has(tabId),
    destroy: tabId => {
      if (activeViewId === tabId) activeViewId = null
      const view = views.get(tabId)
      if (view) view.destroy()
      views.delete(tabId)
      lastActivatedAt.delete(tabId)
      evicted.delete(tabId)
    },
    destroyAll: () => {
      for (const view of views.values()) view.destroy()
      views.clear()
      lastActivatedAt.clear()
      evicted.clear()
      activeViewId = null
    },
    evictOverBudget: ({ activeTabId, isEvictable, flush, maxLiveViews }) => {
      const budget = maxLiveViews ?? MAX_LIVE_EDITOR_VIEWS
      if (views.size <= budget) return
      const candidates = [...views.keys()]
        .filter(tabId => tabId !== activeTabId && isEvictable(tabId))
        .sort((a, b) => (lastActivatedAt.get(a) ?? 0) - (lastActivatedAt.get(b) ?? 0))
      for (const tabId of candidates) {
        if (views.size <= budget) return
        const view = views.get(tabId)
        if (!view) continue
        flush(tabId, view.state.doc.toString())
        evicted.set(tabId, snapshot(view))
        view.destroy()
        views.delete(tabId)
        lastActivatedAt.delete(tabId)
      }
    },
  }
}

function docLength(view: EditorView): number {
  // Fake views created by the test harness expose only `toString`/`lines`.
  const length = (view.state.doc as { length?: number }).length
  return typeof length === "number" ? length : 0
}

function clampToDoc(offset: number, length: number): number {
  if (length <= 0) return 0
  return Math.max(0, Math.min(offset, length))
}
