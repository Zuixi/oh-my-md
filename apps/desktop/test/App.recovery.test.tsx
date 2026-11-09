import { waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { EditorView } from "@codemirror/view"
import type { CreateEditorOptions } from "../src/Editor"
import { createSession, recoveryKey } from "../src/session"
import { createAppHarness, expectPathShown, resetMountedApps } from "./appHarness"

// Keys the launch tabs will use from now on (default window: "main").
const KEY_1 = recoveryKey(createSession(1))
const KEY_2 = recoveryKey(createSession(2))

// Recovery adoption is a startup path, so these tests live apart from the
// product-shell suite: mounting several tabs per launch would bloat that file.
// The harness installs its own pending-lookup implementation on this mock.
vi.mock("@omd/engine", async importOriginal => {
  const actual = await importOriginal<typeof import("@omd/engine")>()
  return { ...actual, getPendingOrderedListNormalization: vi.fn(() => null) }
})

const { editor } = vi.hoisted(() => ({
  editor: {
    create: vi.fn(),
    reset: vi.fn(),
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

function makeAppHarness() {
  return createAppHarness(editor)
}

afterEach(() => {
  vi.useRealTimers()
  resetMountedApps()
})

function edit(harness: ReturnType<typeof makeAppHarness>, tabId: number, doc: string) {
  harness.editorForTab(tabId).emit({ doc, docChanged: true, pendingNormalization: null })
}

describe("App recovery drafts", () => {
  it("restores a recovery draft when the user confirms", async () => {
    const harness = makeAppHarness()
    harness.services.listRecoveries = vi.fn(async () => [
      { key: "untitled_1", label: "untitled_1", path: null },
    ])
    harness.services.readRecovery = vi.fn(async () => ({ path: null, contents: "recovered draft" }))
    harness.services.confirmRestore = vi.fn(() => true)
    harness.renderApp()

    await waitFor(() => expect(editor.reset).toHaveBeenCalledOnce())
    expectPathShown("unnamed", { dirty: true })
  })

  it("offers every recovery record and mounts each draft in its own tab", async () => {
    const harness = makeAppHarness()
    harness.services.listRecoveries = vi.fn(async () => [
      { key: KEY_1, label: "first", path: null },
      { key: KEY_2, label: "second", path: null },
    ])
    harness.services.readRecovery = vi.fn(async key => ({
      path: null,
      contents: key === KEY_1 ? "first draft" : "second draft",
    }))
    harness.services.confirmRestore = vi.fn(() => true)
    harness.renderApp()

    await waitFor(() => expect(harness.editorForTab(2).getOptions().doc).toBe("second draft"))
    expect(harness.services.confirmRestore).toHaveBeenCalledTimes(2)
    // First record reuses the pristine launch tab; the second needs a new tab
    // because the first draft already made tab 1 dirty.
    expect(harness.editorForTab(1).getOptions().doc).toBe("first draft")
    // Both drafts landed in the tab their record key names, so the record is
    // already the tab's durable copy and must not be deleted (the mounted
    // content is memory-only until the next edit is written).
    expect(harness.services.clearRecovery).not.toHaveBeenCalled()
  })

  it("keeps a recovery record when its read fails", async () => {
    const harness = makeAppHarness()
    harness.services.listRecoveries = vi.fn(async () => [
      { key: KEY_1, label: "broken", path: null },
      { key: KEY_2, label: "readable", path: null },
    ])
    harness.services.readRecovery = vi.fn(async key => {
      if (key === KEY_1) throw new Error("disk hiccup")
      return { path: null, contents: "second draft" }
    })
    harness.services.confirmRestore = vi.fn(() => true)
    harness.renderApp()

    await waitFor(() =>
      expect(harness.services.clearRecovery).toHaveBeenCalledWith(KEY_2))
    expect(harness.services.clearRecovery).not.toHaveBeenCalledWith(KEY_1)
  })

  it("deletes the on-disk draft when a discarded untitled tab is closed", async () => {
    const harness = makeAppHarness()
    harness.renderApp()
    edit(harness, 1, "draft")
    harness.requestCloseTab(1)

    await waitFor(() =>
      expect(harness.services.clearRecovery).toHaveBeenCalledWith(KEY_1))
  })
})
