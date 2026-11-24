import { act } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { EditorView } from "@codemirror/view"
import type { CreateEditorOptions } from "../src/Editor"
import { createAppHarness, resetMountedApps } from "./appHarness"

vi.mock("@omd/engine", async importOriginal => {
  const actual = await importOriginal<typeof import("@omd/engine")>()
  return {
    ...actual,
    exportHtml: () => "<!doctype html><html>exported</html>",
    exportRichHtml: async () => "<!doctype html><html>exported</html>",
    collectOutline: () => [],
    getPendingOrderedListNormalization: vi.fn(() => null),
  }
})

const { editor, topBarRender } = vi.hoisted(() => ({
  editor: { create: vi.fn(), reset: vi.fn() },
  topBarRender: vi.fn(),
}))

// Counting TopBar renders is how this suite measures "did the App shell
// re-render": TopBar only re-renders with its parent.
vi.mock("../src/TopBar", () => ({
  TopBar: (props: { dirtyIds: readonly number[] }) => {
    topBarRender(props.dirtyIds)
    return <div data-testid="topbar-probe" />
  },
}))

vi.mock("../src/Editor", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/Editor")>()
  return {
    ...actual,
    createEditor: (parent: HTMLElement, options: CreateEditorOptions) =>
      editor.create(parent, options),
    resetEditorDocument: (view: EditorView, options: CreateEditorOptions) =>
      editor.reset(view, options),
  }
})

afterEach(() => {
  vi.useRealTimers()
  resetMountedApps()
})

const DOC_MATERIALIZE_MS = 250
/** One stats debounce after the materialization that carried the text. */
const STATS_DEBOUNCE_MS = 250

describe("zero App re-render while typing", () => {
  it("keeps the shell still when an already-dirty tab materializes more edits", () => {
    vi.useFakeTimers()
    const harness = createAppHarness(editor)
    harness.renderApp({ docMaterializeMs: DOC_MATERIALIZE_MS })
    const handle = harness.editorForTab(1)

    // clean -> dirty flips `dirtyTabIds`, which legitimately re-renders once.
    act(() => handle.emit({ doc: "alpha", docChanged: true, pendingNormalization: null }))
    act(() => { vi.advanceTimersByTime(DOC_MATERIALIZE_MS + 10) })
    expect(topBarRender).toHaveBeenCalled()
    const lastCall = topBarRender.mock.calls[topBarRender.mock.calls.length - 1]
    expect(lastCall?.[0]).toEqual([1])
    const shellRendersAfterDirty = topBarRender.mock.calls.length

    const FINAL_DOC = "alpha beta gamma delta"
    for (let index = 0; index < 10; index += 1) {
      const doc = index === 9 ? FINAL_DOC : `alpha${" beta".repeat(index + 1)}`
      act(() => handle.emit({ doc, docChanged: true, pendingNormalization: null }))
      act(() => { vi.advanceTimersByTime(DOC_MATERIALIZE_MS + 10) })
    }

    // Ten materialized edits on an already-dirty tab: not one shell render.
    expect(topBarRender).toHaveBeenCalledTimes(shellRendersAfterDirty)

    // …while the status bar did follow the text and count it accurately.
    act(() => { vi.advanceTimersByTime(STATS_DEBOUNCE_MS + 10) })
    const status = document.querySelector(".statusbar")?.textContent ?? ""
    expect(status).toContain("4 words")
    expect(status).toContain(`${FINAL_DOC.length} chars`)
    expect(topBarRender).toHaveBeenCalledTimes(shellRendersAfterDirty)
  })
})
