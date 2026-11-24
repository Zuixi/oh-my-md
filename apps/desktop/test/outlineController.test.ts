import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { EditorView } from "@codemirror/view"
import type { OutlineItem } from "@omd/engine"
import { createDocumentStore } from "../src/documentStore"
import { createWorkspace } from "../src/workspace"
import type { EditorRegistry } from "../src/editorRegistry"
import type { DocumentScaleRegistry } from "../src/documentScaleRegistry"
import {
  OUTLINE_DEBOUNCE_MS,
  createOutlineController,
} from "../src/outlineController"

const outline = vi.hoisted(() => vi.fn<() => OutlineItem[]>(() => []))
vi.mock("../src/Editor", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/Editor")>()),
  documentOutline: outline,
}))

describe("outline controller lifecycle", () => {
  beforeEach(() => { vi.useFakeTimers(); outline.mockClear() })
  afterEach(() => { vi.useRealTimers() })

  it("re-subscribes to the store after dispose, so StrictMode keeps refreshing", () => {
    const store = createDocumentStore(createWorkspace())
    const view = {} as EditorView
    const registry = {
      getView: (tabId: number) => (tabId === store.getWorkspace().activeId ? view : undefined),
      getActiveView: () => view,
    } as unknown as EditorRegistry
    const scale = { isSafeMode: () => false } as unknown as DocumentScaleRegistry
    const controller = createOutlineController({ store, registry, documentScaleRegistry: scale })

    controller.setPanelOpen(true)
    vi.advanceTimersByTime(OUTLINE_DEBOUNCE_MS + 1)
    expect(outline).toHaveBeenCalledTimes(1)

    const subscriber = vi.fn()
    const unsubscribe = controller.subscribe(subscriber)

    // StrictMode unmount → remount against the same controller instance.
    controller.dispose()
    controller.reset()

    outline.mockReturnValueOnce([{ level: 1, text: "Heading", from: 0 }])
    store.bumpDocVersion(store.getWorkspace().activeId)
    vi.advanceTimersByTime(OUTLINE_DEBOUNCE_MS + 1)
    expect(outline).toHaveBeenCalledTimes(2)
    expect(subscriber).toHaveBeenCalledTimes(1)
    expect(controller.getItems()).toHaveLength(1)

    unsubscribe()
    controller.dispose()
  })
})
