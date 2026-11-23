import { describe, expect, it, vi } from "vitest"
import { EditorState } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { history, undo } from "@codemirror/commands"
import { editorExtensions, isLivePreview, setLivePreview } from "@omd/engine"
import { MAX_LIVE_EDITOR_VIEWS, createEditorRegistry } from "../src/editorRegistry"

interface FakeView {
  readonly view: EditorView
  readonly destroyed: () => boolean
  readonly dispatch: ReturnType<typeof vi.fn>
}

function fakeView(text: string, anchor = 0, head = 0, scrollTop = 0): FakeView {
  let destroyed = false
  const dispatch = vi.fn()
  const view = {
    state: {
      doc: { length: text.length, toString: () => text },
      selection: { main: { anchor, head } },
    },
    dispatch,
    destroy: vi.fn(() => { destroyed = true }),
    scrollDOM: { scrollTop },
  } as unknown as EditorView
  return { view, destroyed: () => destroyed, dispatch }
}

function fakeHost(): HTMLDivElement {
  return document.createElement("div")
}

describe("editor registry live-view budget", () => {
  it("keeps every view while the tab count is within the budget", () => {
    const registry = createEditorRegistry()
    const flush = vi.fn()
    for (let tabId = 1; tabId <= MAX_LIVE_EDITOR_VIEWS; tabId++) {
      registry.bindHost(tabId, fakeHost())
      registry.add(tabId, fakeView(`tab ${tabId}`).view)
    }
    registry.evictOverBudget({ activeTabId: 1, isEvictable: () => true, flush })
    expect(registry.views().size).toBe(MAX_LIVE_EDITOR_VIEWS)
    expect(flush).not.toHaveBeenCalled()
  })

  it("evicts the least recently activated clean background tab", () => {
    const registry = createEditorRegistry()
    const flush = vi.fn()
    const views = new Map<number, FakeView>()
    const total = MAX_LIVE_EDITOR_VIEWS + 2
    for (let tabId = 1; tabId <= total; tabId++) {
      registry.bindHost(tabId, fakeHost())
      const entry = fakeView(`text of ${tabId}`, 3, 4, 120)
      views.set(tabId, entry)
      registry.add(tabId, entry.view)
    }
    // Reactivate 1 and 2 so 3 and 4 are the coldest.
    registry.setActiveView(1)
    registry.setActiveView(2)
    registry.evictOverBudget({ activeTabId: 2, isEvictable: () => true, flush })

    expect(registry.views().size).toBe(MAX_LIVE_EDITOR_VIEWS)
    expect(registry.isEvicted(3)).toBe(true)
    expect(registry.isEvicted(4)).toBe(true)
    expect(views.get(3)?.destroyed()).toBe(true)
    // The buffer was persisted before the view died.
    expect(flush).toHaveBeenCalledWith(3, "text of 3")
    // The active tab and other background tabs survived.
    expect(registry.isEvicted(2)).toBe(false)
    expect(registry.getView(2)).toBeDefined()
  })

  it("evicts nothing when every background tab is protected", () => {
    const registry = createEditorRegistry()
    const flush = vi.fn()
    const total = MAX_LIVE_EDITOR_VIEWS + 3
    for (let tabId = 1; tabId <= total; tabId++) {
      registry.bindHost(tabId, fakeHost())
      registry.add(tabId, fakeView(`text ${tabId}`).view)
    }
    // Every background tab is dirty (or inside a pending normalization): the
    // budget cannot be met, and nothing may be dropped.
    registry.evictOverBudget({
      activeTabId: 1,
      isEvictable: () => false,
      flush,
    })
    expect(registry.views().size).toBe(total)
    expect(flush).not.toHaveBeenCalled()
  })

  it("rebuilds an evicted tab from the store and restores caret + scroll", () => {
    const registry = createEditorRegistry()
    const flush = vi.fn()
    const total = MAX_LIVE_EDITOR_VIEWS + 1
    for (let tabId = 1; tabId <= total; tabId++) {
      registry.bindHost(tabId, fakeHost())
      registry.add(tabId, fakeView(`text of tab number ${tabId}`, 5, 7, 300).view)
    }
    registry.evictOverBudget({ activeTabId: 1, isEvictable: () => true, flush })
    // Activation order was 1..total, so the coldest background tab is 2.
    expect(registry.isEvicted(2)).toBe(true)
    const target = 2
    const revived = fakeView("restored text")
    const create = vi.fn(() => revived.view)
    const view = registry.revive(target, create)

    expect(create).toHaveBeenCalledTimes(1)
    expect(view).toBe(revived.view)
    expect(registry.isEvicted(target)).toBe(false)
    // Caret was clamped into the restored document and scroll restored verbatim.
    expect(revived.dispatch).toHaveBeenCalledWith({
      selection: { anchor: 5, head: 7 },
    })
    expect(revived.view.scrollDOM.scrollTop).toBe(300)
  })

  it("revive returns null when the host element is gone", () => {
    const registry = createEditorRegistry()
    expect(registry.revive(99, () => fakeView("x").view)).toBeNull()
  })

  it("destroyAll releases every live view and clears the active binding", () => {
    const registry = createEditorRegistry()
    const entry = fakeView("x")
    registry.bindHost(1, fakeHost())
    registry.add(1, entry.view)
    registry.setActiveView(1)
    registry.destroyAll()
    expect(entry.destroyed()).toBe(true)
    expect(registry.views().size).toBe(0)
    expect(registry.getActiveView()).toBeNull()
  })
})

/**
 * A real CodeMirror view, mounted like `Editor.ts` mounts it. These tests cover
 * the production eviction path: the tab's `EditorState` is preserved (not
 * rebuilt), so the expensive things that are *not* decorations survive.
 */
function realView(host: HTMLDivElement, doc: string): EditorView {
  return new EditorView({
    state: EditorState.create({
      doc,
      extensions: [history(), editorExtensions({ performancePolicy: null })],
    }),
    parent: host,
  })
}

describe("editor registry state preservation across eviction", () => {
  it("keeps undo history, source mode and scroll position for a real view", () => {
    const registry = createEditorRegistry()
    const host = fakeHost()
    registry.bindHost(2, host)
    const view = realView(host, "beta")
    registry.add(2, view)
    registry.bindHost(1, fakeHost())
    registry.add(1, fakeView("active tab").view)
    // Typing, a Live -> Source toggle, and a scroll position the user chose.
    view.dispatch({ changes: { from: 0, insert: "alpha " } })
    view.dispatch(setLivePreview(false))
    expect(view.state.doc.toString()).toBe("alpha beta")
    view.scrollDOM.scrollTop = 240

    registry.evictOverBudget({
      activeTabId: 1,
      isEvictable: () => true,
      flush: vi.fn(),
      maxLiveViews: 1,
    })
    expect(registry.isEvicted(2)).toBe(true)
    expect(view.state.doc.toString()).toBe("alpha beta")

    const create = vi.fn(() => fakeView("rebuilt").view)
    const revived = registry.revive(2, create)

    // The preserved state is re-mounted directly: no fresh state, no lost history.
    expect(create).not.toHaveBeenCalled()
    expect(revived).toBe(registry.getView(2))
    expect(revived?.state.doc.toString()).toBe("alpha beta")
    expect(revived?.state.field(isLivePreview)).toBe(false)
    expect(revived?.scrollDOM.scrollTop).toBe(240)

    const undone: string[] = []
    const handled = undo({
      state: revived!.state,
      dispatch: transaction => { undone.push(transaction.state.doc.toString()) },
    })
    expect(handled).toBe(true)
    expect(undone).toEqual(["beta"])
  })

  it("restores Live mode after the decorations were stripped for eviction", () => {
    const registry = createEditorRegistry()
    const host = fakeHost()
    registry.bindHost(2, host)
    const view = realView(host, "live tab")
    registry.add(2, view)
    registry.bindHost(1, fakeHost())
    registry.add(1, fakeView("active tab").view)
    expect(view.state.field(isLivePreview)).toBe(true)

    registry.evictOverBudget({
      activeTabId: 1,
      isEvictable: () => true,
      flush: vi.fn(),
      maxLiveViews: 1,
    })
    const revived = registry.revive(2, () => fakeView("rebuilt").view)

    expect(revived?.state.field(isLivePreview)).toBe(true)
    expect(revived?.state.doc.toString()).toBe("live tab")
  })
})

/**
 * A document reload can reach an evicted tab: `resetTabDocument` has no view to
 * update, so the preserved state must be dropped while the tab stays evicted.
 */
describe("editor registry detached state discard", () => {
  function evictSecondTab(text: string) {
    const registry = createEditorRegistry()
    const host = fakeHost()
    registry.bindHost(2, host)
    const view = realView(host, text)
    registry.add(2, view)
    registry.bindHost(1, fakeHost())
    registry.add(1, fakeView("active tab").view)
    registry.evictOverBudget({
      activeTabId: 1,
      isEvictable: () => true,
      flush: vi.fn(),
      maxLiveViews: 1,
    })
    expect(registry.isEvicted(2)).toBe(true)
    expect(registry.getView(2)).toBeUndefined()
    return { registry }
  }

  it("keeps the tab evicted but rebuilds it through create", () => {
    const { registry } = evictSecondTab("reloaded text")

    registry.discardDetachedState(2)

    // Still evicted: activation rebuilds it, `ensureViews` must not do so eagerly.
    expect(registry.isEvicted(2)).toBe(true)
    const rebuilt = fakeView("reloaded text", 40, 40, 500)
    const create = vi.fn(() => rebuilt.view)
    const revived = registry.revive(2, create)

    // The preserved state is gone, so the reloaded document wins over the old
    // text and the caret/scroll restart from the beginning of the new document.
    expect(create).toHaveBeenCalledTimes(1)
    expect(revived).toBe(rebuilt.view)
    expect(rebuilt.dispatch).toHaveBeenCalledWith({ selection: { anchor: 0, head: 0 } })
    expect(rebuilt.view.scrollDOM.scrollTop).toBe(0)
    expect(registry.isEvicted(2)).toBe(false)
    expect(registry.getView(2)).toBe(rebuilt.view)
  })

  it("ignores a tab that is not evicted", () => {
    const registry = createEditorRegistry()
    const host = fakeHost()
    registry.bindHost(1, host)
    const view = realView(host, "still live")
    registry.add(1, view)

    registry.discardDetachedState(1)

    expect(registry.isEvicted(1)).toBe(false)
    expect(registry.getView(1)).toBe(view)
    expect(view.state.doc.toString()).toBe("still live")
  })
})
