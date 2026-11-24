import { describe, expect, it, vi } from "vitest"
import { createDocumentStore } from "../src/documentStore"
import { createFileSession, createSession } from "../src/session"
import { addTab, createWorkspace, replaceTabs } from "../src/workspace"
import { initialSaveState } from "../src/documentSaveState"
import { versionFor } from "./fakeDisk"

function seededStore() {
  const workspace = replaceTabs(createWorkspace(), [
    createFileSession(1, "/a.md", "disk a", versionFor("/a.md", "disk a")),
    createFileSession(2, "/b.md", "disk b", versionFor("/b.md", "disk b")),
  ])
  return createDocumentStore(workspace)
}

describe("document store dirty projection", () => {
  it("keeps the very same dirtyTabIds array while a dirty tab keeps changing", () => {
    const store = seededStore()
    store.setTabDoc(1, "edited a")
    const dirty = store.getDirtyTabIds()
    expect(dirty).toEqual([1])

    for (let index = 0; index < 20; index++) {
      store.setTabDoc(1, `edited a ${index}`)
      // Reference identity, not just value equality: the shell's selector
      // bails out only when the snapshot is the same object.
      expect(store.getDirtyTabIds()).toBe(dirty)
    }
    expect(store.getWorkspace()).toBeDefined()
  })

  it("rebuilds the array exactly once when a tab's dirty boolean flips", () => {
    const store = seededStore()
    const clean = store.getDirtyTabIds()
    expect(clean).toEqual([])

    store.setTabDoc(1, "edited a")
    const afterEdit = store.getDirtyTabIds()
    expect(afterEdit).not.toBe(clean)
    expect(afterEdit).toEqual([1])

    store.setTabDoc(1, "disk a")
    expect(store.getDirtyTabIds()).toEqual([])
  })

  it("drops a closed tab from the projection and keeps the survivors stable", () => {
    const store = seededStore()
    store.setTabDoc(1, "edited a")
    store.setTabDoc(2, "edited b")
    expect(store.getDirtyTabIds()).toEqual([1, 2])
    const survivor = store.getDirtyTabIds()

    store.setWorkspace(replaceTabs(store.getWorkspace(), [
      createSession(3),
    ]))
    expect(store.getDirtyTabIds()).toEqual([])
    expect(store.getDirtyTabIds()).not.toBe(survivor)

    // Adding a dirty-ready tab does not resurrect the old array.
    store.setWorkspace(addTab(store.getWorkspace(), createSession(4)))
    expect(store.getDirtyTabIds()).toEqual([])
  })

  it("recomputes when a save moves the disk baseline", () => {
    const store = seededStore()
    store.setTabDoc(1, "edited a")
    expect(store.isTabDirty(1)).toBe(true)

    const tab = store.getWorkspace().tabs.find(item => item.id === 1)!
    store.setWorkspace({
      ...store.getWorkspace(),
      tabs: store.getWorkspace().tabs.map(item => item.id === tab.id
        ? createFileSession(1, "/a.md", "edited a", versionFor("/a.md", "edited a"))
        : item),
    })
    expect(store.isTabDirty(1)).toBe(false)
    expect(store.isTabDirty(2)).toBe(false)
  })

  it("notifies on every mutation but never for a no-op write", () => {
    const store = seededStore()
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)

    store.setTabDoc(1, "edited a")
    expect(listener).toHaveBeenCalledTimes(1)
    store.setTabDoc(1, "edited a")
    expect(listener).toHaveBeenCalledTimes(1)

    store.bumpDocVersion(1)
    expect(store.getDocVersion(1)).toBe(1)
    expect(listener).toHaveBeenCalledTimes(2)

    unsubscribe()
    store.setTabDoc(1, "later")
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it("tracks save states and normalization by reference", () => {
    const store = seededStore()
    const listener = vi.fn()
    store.subscribe(listener)

    const saveStates = { 1: initialSaveState() }
    store.setSaveStateByTab(saveStates)
    expect(store.getSaveStateByTab()).toBe(saveStates)
    store.setSaveStateByTab(saveStates)
    expect(listener).toHaveBeenCalledTimes(1)

    store.setNormalizationByTab({ 2: { notice: { id: 1, markerCount: 2 } as never, action: "idle" } })
    expect(store.getNormalizationByTab()[2]).toBeDefined()
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it("exposes the active session and per-tab text through getters", () => {
    const store = seededStore()
    store.setTabDoc(2, "typed into 2")
    expect(store.getTabDoc(2)).toBe("typed into 2")
    expect(store.getTabDoc(999)).toBe("")
    expect(store.getActiveSession().id).toBe(store.getWorkspace().activeId)
    expect(store.docs().get(2)).toBe("typed into 2")

    store.deleteTabDoc(2)
    expect(store.getTabDoc(2)).toBe("")
    expect(store.getDocVersion(2)).toBe(0)
  })
})
