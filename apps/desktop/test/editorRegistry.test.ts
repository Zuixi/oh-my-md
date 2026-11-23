import { describe, expect, it, vi } from "vitest"
import type { EditorView } from "@codemirror/view"
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
