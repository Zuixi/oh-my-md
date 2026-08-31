import { act, fireEvent, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { EditorView } from "@codemirror/view"
import type { CreateEditorOptions } from "../src/Editor"
import { createAppHarness, resetMountedApps } from "./appHarness"

vi.mock("@omd/engine", async importOriginal => {
  const actual = await importOriginal<typeof import("@omd/engine")>()
  return {
    ...actual,
    getPendingOrderedListNormalization: vi.fn(() => null),
  }
})

const { editor, topBarRender } = vi.hoisted(() => ({
  editor: { create: vi.fn(), reset: vi.fn() },
  topBarRender: vi.fn(),
}))

vi.mock("../src/TopBar", () => ({
  TopBar: (props: { filePath: string | null }) => {
    topBarRender(props.filePath)
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

afterEach(() => resetMountedApps())

describe("editor status render boundary", () => {
  it("updates StatusBar without rerendering the App shell", () => {
    vi.useFakeTimers()
    try {
      const harness = createAppHarness(editor)
      harness.renderApp({ docMaterializeMs: 250 })
      const before = topBarRender.mock.calls.length
      const handle = harness.editorForTab(1)

      expect(handle.getOptions().onStatusChange).toBeDefined()
      act(() => handle.getOptions().onStatusChange?.({ cursor: "4:2", mode: "source" }))
      expect(screen.getByText("4:2")).toBeTruthy()
      expect(screen.getByText("source")).toBeTruthy()
      expect(topBarRender).toHaveBeenCalledTimes(before)

      handle.emit({ doc: "typed", docChanged: true, pendingNormalization: null })
      expect(topBarRender).toHaveBeenCalledTimes(before)
    } finally {
      vi.useRealTimers()
    }
  })

  it("ignores a stale onStatusChange captured from a tab that is no longer active", async () => {
    const harness = createAppHarness(editor)
    harness.renderApp()
    // Tab 1 is created by App on mount; capture its onStatusChange before a
    // second tab is opened and takes over as the active tab. TopBar is
    // mocked in this file, so open into the new tab via the raw shortcut +
    // `requestOpen` rather than `openInNewTab` (which waits on the real
    // `.topbar-file` text to confirm the path landed).
    const inactiveHandle = harness.editorForTab(1)
    expect(inactiveHandle.getOptions().onStatusChange).toBeDefined()

    const before = harness.allEditors().length
    fireEvent.keyDown(window, { key: "n", metaKey: true })
    await waitFor(() => expect(harness.allEditors().length).toBe(before + 1))
    await harness.requestOpen("/notes/b.md", "second tab")
    expect(screen.getByText("1:1")).toBeTruthy()
    expect(screen.getByText("live")).toBeTruthy()

    // Guard: `workspaceRef.current.activeId !== tabId` must reject this call
    // — tab 1's view is still hidden in the background.
    act(() => inactiveHandle.getOptions().onStatusChange?.({ cursor: "9:9", mode: "source" }))
    expect(screen.queryByText("9:9")).toBeNull()
    expect(screen.queryByText("source")).toBeNull()
    expect(screen.getByText("1:1")).toBeTruthy()
    expect(screen.getByText("live")).toBeTruthy()

    // Sanity: the guard is identity-specific, not a frozen store — the
    // now-active tab's own callback still reaches the StatusBar.
    const activeHandle = harness.editorForTab(2)
    expect(activeHandle.getOptions().onStatusChange).toBeDefined()
    act(() => activeHandle.getOptions().onStatusChange?.({ cursor: "9:9", mode: "source" }))
    expect(screen.getByText("9:9")).toBeTruthy()
    expect(screen.getByText("source")).toBeTruthy()
  })

  it("ignores a stale onStatusChange captured before the active tab's document identity was bumped", async () => {
    const harness = createAppHarness(editor)
    harness.renderApp()
    const handle = harness.editorForTab(1)
    // Capture the options bound to tab 1's original document identity before
    // replacing its content, which bumps `documentId` on the same tab id.
    const staleOptions = handle.getOptions()
    expect(staleOptions.onStatusChange).toBeDefined()

    // TopBar is mocked in this file, so replace the active tab's document
    // via the raw `requestOpen` rather than `openIntoActive` (which waits on
    // the real `.topbar-file` text to confirm the path landed).
    await harness.requestOpen("/notes/a.md", "replaced contents")
    expect(screen.getByText("1:1")).toBeTruthy()
    expect(screen.getByText("live")).toBeTruthy()

    // Guard: `tab.documentId !== documentId` must reject this call — the
    // closure still carries the pre-reset documentId for tab 1.
    act(() => staleOptions.onStatusChange?.({ cursor: "7:7", mode: "source" }))
    expect(screen.queryByText("7:7")).toBeNull()
    expect(screen.queryByText("source")).toBeNull()
    expect(screen.getByText("1:1")).toBeTruthy()
    expect(screen.getByText("live")).toBeTruthy()

    // Sanity: the rebound options for the same tab (post-reset identity)
    // still reach the StatusBar.
    const freshOptions = harness.editorForTab(1).getOptions()
    act(() => freshOptions.onStatusChange?.({ cursor: "7:7", mode: "source" }))
    expect(screen.getByText("7:7")).toBeTruthy()
    expect(screen.getByText("source")).toBeTruthy()
  })
})
