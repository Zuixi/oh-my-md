/**
 * Live CodeMirror view ownership for the whole window.
 *
 * `App` used to hold four parallel refs (`hostsRef`, `viewsRef`, `viewRef`, and
 * the per-tab scale registry) and rebuilt their invariants in a dozen places.
 * This registry is the single owner of host elements and views, and adds a
 * bounded live-view budget: past `MAX_LIVE_EDITOR_VIEWS` the least recently
 * activated *clean* background tab is torn down (its text already lives in
 * `DocumentStore`) and rebuilt on return. A plain HTML host div stays mounted so
 * React keeps its DOM position; only the CodeMirror view and its DOM are released.
 */
import { EditorState } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { isLivePreview, setLivePreview } from "@omd/engine"

export interface EvictedViewState {
  readonly anchor: number
  readonly head: number
  readonly scrollTop: number
  /**
   * The tab's own `EditorState`, kept across eviction so Undo/Redo history, the
   * text rope, selection, source/live mode, ordered-list normalization and every
   * bound view callback survive the round trip. Absent for the plain fake views
   * used by unit tests, which are rebuilt through the `create` callback. A
   * document reload that can reach an evicted tab must drop this entry
   * (`destroy(tabId)`), or the preserved text would win over the new one.
   */
  readonly detachedState?: EditorState
  /** Whether the tab was in Live mode when it was evicted (decorations stripped). */
  readonly wasLive?: boolean
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
  /**
   * Drops an evicted tab's preserved `EditorState` so `revive` rebuilds it from
   * the current document text through `create`, while keeping the tab evicted
   * (it must still be rebuilt on activation, not eagerly by `ensureViews`).
   */
  readonly discardDetachedState: (tabId: number) => void
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
      if (state?.detachedState) {
        // Re-mount the preserved state directly: it already carries the tab's
        // extensions, undo history, mode and callbacks, so `create` (which would
        // build a fresh state and lose all of it) must not run here.
        const restored = state.wasLive
          ? state.detachedState.update(setLivePreview(true)).state
          : state.detachedState
        const view = new EditorView({ state: restored, parent: host })
        views.set(tabId, view)
        touch(tabId)
        if (view.scrollDOM) view.scrollDOM.scrollTop = state.scrollTop
        return view
      }
      const view = create(host)
      views.set(tabId, view)
      touch(tabId)
      if (state) restore(view, state)
      return view
    },
    isEvicted: tabId => evicted.has(tabId),
    discardDetachedState: tabId => {
      if (!evicted.has(tabId)) return
      // Keep the entry: `isEvicted` still routes activation through `revive`.
      evicted.set(tabId, { anchor: 0, head: 0, scrollTop: 0 })
    },
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
        evicted.set(tabId, detachSnapshot(view))
        view.destroy()
        views.delete(tabId)
        lastActivatedAt.delete(tabId)
      }
    },
  }
}

/**
 * Snapshot for eviction. A real CodeMirror view keeps its `EditorState` with the
 * live-preview decorations stripped: a large document's decoration set (and the
 * block widgets' DOM) is the expensive half, while the rope, undo history,
 * mode facets and callbacks are cheap. `setLivePreview(false)` is a pure effect
 * transaction — it adds no history entry — so Undo/Redo still crosses the
 * eviction boundary, and `revive` restores Live mode when it was on.
 */
function detachSnapshot(view: EditorView): EvictedViewState {
  const length = docLength(view)
  const base: EvictedViewState = {
    anchor: clampToDoc(view.state.selection?.main.anchor ?? 0, length),
    head: clampToDoc(view.state.selection?.main.head ?? 0, length),
    // Fake views in tests have no scrollDOM; production ones always do.
    scrollTop: view.scrollDOM?.scrollTop ?? 0,
  }
  if (!(view.state instanceof EditorState)) return base
  const wasLive = view.state.field(isLivePreview, false) === true
  const detachedState = wasLive ? view.state.update(setLivePreview(false)).state : view.state
  return { ...base, detachedState, wasLive }
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
