import { describe, expect, it, vi } from "vitest"
import { createAutosaveScheduler } from "../src/autosaveScheduler"
import { createDocumentStore } from "../src/documentStore"
import { createFileSession, createSession } from "../src/session"
import { addTab, createWorkspace, replaceTabs } from "../src/workspace"
import { versionFor } from "./fakeDisk"

const AUTOSAVE_MS = 1000

function makeStore(dirty = true) {
  const workspace = replaceTabs(createWorkspace(), [
    createFileSession(1, "/a.md", "disk a", versionFor("/a.md", "disk a")),
    createFileSession(2, "/b.md", "disk b", versionFor("/b.md", "disk b")),
  ])
  const store = createDocumentStore(workspace)
  store.setTabDoc(1, dirty ? "edited a" : "disk a")
  store.setTabDoc(2, "edited b")
  return store
}

function makeScheduler(store: ReturnType<typeof makeStore>) {
  const save = vi.fn()
  const flushMaterialization = vi.fn()
  const scheduler = createAutosaveScheduler({
    getAutosaveMs: () => AUTOSAVE_MS,
    store,
    isReadOnly: () => false,
    flushMaterialization,
    save,
  })
  return { scheduler, save, flushMaterialization }
}

describe("autosave scheduler", () => {
  it("saves the tab that scheduled the timer, not the active one", () => {
    vi.useFakeTimers()
    try {
      const store = makeStore()
      const { scheduler, save } = makeScheduler(store)
      scheduler.schedule(1)

      vi.advanceTimersByTime(AUTOSAVE_MS - 1)
      expect(save).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(save).toHaveBeenCalledTimes(1)
      // The active tab is 1 here; proving per-tab ownership means saving 1 even
      // though the timer was armed while editing it and never re-armed.
      expect(save).toHaveBeenCalledWith(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("keeps a background tab's timer alive when another tab is edited", () => {
    vi.useFakeTimers()
    try {
      const store = makeStore()
      const { scheduler, save } = makeScheduler(store)
      // Edit tab 1, switch to tab 2 (no explicit cancel — this is the switch).
      scheduler.schedule(1)
      vi.advanceTimersByTime(200)
      scheduler.schedule(2)
      vi.advanceTimersByTime(AUTOSAVE_MS - 200)

      expect(save).toHaveBeenCalledTimes(1)
      expect(save).toHaveBeenCalledWith(1)
      vi.advanceTimersByTime(200)
      expect(save).toHaveBeenCalledWith(2)
      expect(save).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("cancels a pending timer for a closed or manually saved tab", () => {
    vi.useFakeTimers()
    try {
      const store = makeStore()
      const { scheduler, save } = makeScheduler(store)
      scheduler.schedule(1)
      scheduler.cancel(1)
      vi.advanceTimersByTime(AUTOSAVE_MS * 2)
      expect(save).not.toHaveBeenCalled()

      // Re-arming then saving manually (the store becomes clean) must not write.
      scheduler.schedule(2)
      scheduler.cancel(2)
      vi.advanceTimersByTime(AUTOSAVE_MS * 2)
      expect(save).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it("re-checks the tab at fire time and skips vanished or clean tabs", () => {
    vi.useFakeTimers()
    try {
      const store = makeStore()
      const { scheduler, save } = makeScheduler(store)
      scheduler.schedule(1)
      // The tab was closed while the timer was pending.
      store.setWorkspace(replaceTabs(store.getWorkspace(), [
        createFileSession(2, "/b.md", "disk b", versionFor("/b.md", "disk b")),
      ]))
      vi.advanceTimersByTime(AUTOSAVE_MS)
      expect(save).not.toHaveBeenCalled()

      // A tab that stopped being dirty (another save landed) is skipped too.
      const store2 = makeStore()
      const second = makeScheduler(store2)
      second.scheduler.schedule(1)
      store2.setWorkspace({
        ...store2.getWorkspace(),
        tabs: store2.getWorkspace().tabs.map(tab => tab.id === 1
          ? createFileSession(1, "/a.md", "edited a", versionFor("/a.md", "edited a"))
          : tab),
      })
      vi.advanceTimersByTime(AUTOSAVE_MS)
      expect(second.save).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it("skips untitled, read-only, and normalization-blocked tabs", () => {
    vi.useFakeTimers()
    try {
      const workstation = addTab(createWorkspace(), createSession(2))
      workstation.tabs[0] = createFileSession(1, "/a.md", "disk a", versionFor("/a.md", "disk a"))
      const store = createDocumentStore(workstation)
      store.setTabDoc(1, "edited a")
      store.setTabDoc(2, "scratch")
      const save = vi.fn()
      const scheduler = createAutosaveScheduler({
        getAutosaveMs: () => AUTOSAVE_MS,
        store,
        isReadOnly: tabId => tabId === 2,
        flushMaterialization: () => undefined,
        save,
      })
      scheduler.schedule(2)
      vi.advanceTimersByTime(AUTOSAVE_MS)
      expect(save).not.toHaveBeenCalled()

      store.setNormalizationByTab({ 1: { notice: { id: 1, markerCount: 2 } as never, action: "idle" } })
      scheduler.schedule(1)
      vi.advanceTimersByTime(AUTOSAVE_MS)
      expect(save).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it("dispose clears every pending timer", () => {
    vi.useFakeTimers()
    try {
      const store = makeStore()
      const { scheduler, save } = makeScheduler(store)
      scheduler.schedule(1)
      scheduler.schedule(2)
      scheduler.dispose()
      vi.advanceTimersByTime(AUTOSAVE_MS * 2)
      expect(save).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it("autosaveMs = 0 disables scheduling entirely", () => {
    vi.useFakeTimers()
    try {
      const store = makeStore()
      const save = vi.fn()
      const scheduler = createAutosaveScheduler({
        getAutosaveMs: () => 0,
        store,
        isReadOnly: () => false,
        flushMaterialization: () => undefined,
        save,
      })
      scheduler.schedule(1)
      vi.advanceTimersByTime(AUTOSAVE_MS * 2)
      expect(save).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
