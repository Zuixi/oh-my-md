import { act, renderHook } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { createEditorStatusStore, useEditorStatus } from "../src/editorStatusStore"

describe("editor status store", () => {
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
