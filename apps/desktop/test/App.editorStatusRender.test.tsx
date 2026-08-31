import { act, screen } from "@testing-library/react"
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
  it("updates StatusBar without rerendering the App shell", async () => {
    vi.useFakeTimers()
    try {
      const harness = createAppHarness(editor)
      harness.renderApp({ docMaterializeMs: 250 })
      const before = topBarRender.mock.calls.length
      const handle = harness.editorForTab(1)

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
})
