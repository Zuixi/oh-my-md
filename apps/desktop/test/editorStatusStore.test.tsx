import { act, renderHook } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { createEditorStatusStore, useEditorStatus } from "../src/editorStatusStore"
import { EDITOR_STATUS_FIELDS, type EditorStatus } from "../src/editorStatus"

const BASE: EditorStatus = { cursor: "1:1", mode: "live" }
const CHANGED: EditorStatus = { cursor: "9:4", mode: "source" }

/** Exhaustive by construction: adding an EditorStatus field breaks compilation
 * here, so the store's equality can never silently ignore a new field. */
function baseDifferingIn(field: keyof EditorStatus): EditorStatus {
  switch (field) {
    case "cursor":
      return { ...BASE, cursor: CHANGED.cursor }
    case "mode":
      return { ...BASE, mode: CHANGED.mode }
  }
}

describe("editor status store", () => {
  it("publishes when any single compared field changes", () => {
    for (const field of EDITOR_STATUS_FIELDS) {
      const store = createEditorStatusStore(BASE)
      const listener = vi.fn()
      store.subscribe(listener)
      store.publish({ ...BASE })
      expect(listener).not.toHaveBeenCalled()
      store.publish(baseDifferingIn(field))
      expect(listener, `store ignored a change in "${field}"`).toHaveBeenCalledTimes(1)
    }
  })

  it("notifies only when cursor or mode changes", () => {
    const store = createEditorStatusStore()
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)

    store.publish({ cursor: "1:1", mode: "live" })
    expect(listener).not.toHaveBeenCalled()

    store.publish({ cursor: "2:3", mode: "live" })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot()).toEqual({ cursor: "2:3", mode: "live" })

    unsubscribe()
    store.publish({ cursor: "2:3", mode: "source" })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("updates only consumers subscribed through the hook", () => {
    const store = createEditorStatusStore()
    const { result } = renderHook(() => useEditorStatus(store))
    act(() => store.publish({ cursor: "9:4", mode: "source" }))
    expect(result.current).toEqual({ cursor: "9:4", mode: "source" })
  })
})
