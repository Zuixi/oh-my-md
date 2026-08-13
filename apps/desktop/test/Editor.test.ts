import { describe, expect, it, vi } from "vitest"
import { undo } from "@codemirror/commands"
import {
  acceptOrderedListNormalization,
  getPendingOrderedListNormalization,
  rejectOrderedListNormalization,
} from "@omd/engine"
import {
  createEditor,
  makeImageResolver,
  resetEditorDocument,
  type CreateEditorOptions,
  type EditorDocumentUpdate,
} from "../src/Editor"

const TAB_ID = 7
const DOCUMENT_ID = 11

function editorOptions(
  onDocumentUpdate: (update: EditorDocumentUpdate) => void,
  doc = "alpha",
): CreateEditorOptions {
  return {
    doc,
    tabId: TAB_ID,
    documentId: DOCUMENT_ID,
    getDocPath: () => null,
    getDocumentId: () => DOCUMENT_ID,
    onDocumentUpdate,
    onError: vi.fn(),
  }
}

/** Lets the engine's queued preview-entry normalization reach the update listener. */
function tick(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

describe("desktop editor lifecycle", () => {
  it("reports bound identity and document changes", () => {
    const onDocumentUpdate = vi.fn()
    const view = createEditor(document.createElement("div"), {
      doc: "alpha", tabId: 7, documentId: 11,
      getDocPath: () => null, getDocumentId: () => 11,
      onDocumentUpdate, onError: vi.fn(),
    })
    view.dispatch({ changes: { from: 5, insert: "!" } })
    expect(onDocumentUpdate).toHaveBeenLastCalledWith(expect.objectContaining({
      tabId: 7, documentId: 11, doc: "alpha!", docChanged: true,
    }))
    view.destroy()
  })

  it("ignores selection-only updates when pending is unchanged", () => {
    const onDocumentUpdate = vi.fn()
    const view = createEditor(document.createElement("div"), editorOptions(onDocumentUpdate))
    view.dispatch({ selection: { anchor: 1 } })
    expect(onDocumentUpdate).not.toHaveBeenCalled()
    view.destroy()
  })

  it("reports pending-only state changes without docChanged", async () => {
    const onDocumentUpdate = vi.fn()
    const view = createEditor(
      document.createElement("div"),
      editorOptions(onDocumentUpdate, "1. a\n3. b"),
    )
    await tick()
    const notice = getPendingOrderedListNormalization(view.state)!
    const accepted = acceptOrderedListNormalization(view.state, notice.id)
    if (accepted.kind === "accepted") view.dispatch(accepted.transaction)
    expect(onDocumentUpdate).toHaveBeenLastCalledWith(expect.objectContaining({
      docChanged: false,
      pendingNormalization: null,
    }))
    view.destroy()
  })

  it("keeps reject out of history and preserves user undo", async () => {
    const view = createEditor(document.createElement("div"), editorOptions(vi.fn(), "1. a\n3. b"))
    await tick()
    const notice = getPendingOrderedListNormalization(view.state)!
    const result = rejectOrderedListNormalization(view.state, notice.id)
    if (result.kind === "reverted") view.dispatch(result.transaction)
    view.dispatch({ changes: { from: view.state.doc.length, insert: "\nbody" } })
    expect(undo(view)).toBe(true)
    expect(view.state.doc.toString()).toBe("1. a\n3. b")
    expect(undo(view)).toBe(false)
    view.destroy()
  })

  // Covers the production path App.tsx still takes. Delete together with the
  // LegacyEditorOptions variant when Task 6 migrates App.tsx.
  it("reports document changes to an unbound host through onDocChanged", () => {
    const onDocChanged = vi.fn()
    const view = createEditor(document.createElement("div"), {
      doc: "alpha",
      getDocPath: () => null,
      getDocumentId: () => 1,
      onDocChanged,
      onError: vi.fn(),
    })

    view.dispatch({ selection: { anchor: 1 } })
    expect(onDocChanged).not.toHaveBeenCalled()

    view.dispatch({ changes: { from: 5, insert: "!" } })
    expect(onDocChanged).toHaveBeenCalledOnce()
    expect(onDocChanged).toHaveBeenLastCalledWith("alpha!")
    view.destroy()
  })

  it("creates a fresh history when a different document is loaded", () => {
    const view = createEditor(document.createElement("div"), {
      doc: "first",
      tabId: 1,
      documentId: 1,
      getDocPath: () => "/tmp/first.md",
      getDocumentId: () => 1,
      onDocumentUpdate: vi.fn(),
      onError: vi.fn(),
    })
    view.dispatch({ changes: { from: 5, insert: " changed" } })

    resetEditorDocument(view, {
      doc: "second",
      tabId: 1,
      documentId: 2,
      getDocPath: () => "/tmp/second.md",
      getDocumentId: () => 2,
      onDocumentUpdate: vi.fn(),
      onError: vi.fn(),
    })

    expect(view.state.doc.toString()).toBe("second")
    expect(undo(view)).toBe(false)
    expect(view.state.doc.toString()).toBe("second")
    view.destroy()
  })

  it("resolves a relative image from the first state of an opened document", () => {
    const convert = vi.fn((path: string) => `asset://${path}`)
    const resolve = makeImageResolver(
      () => "/notes/opened/document.md",
      convert,
    )

    expect(resolve("assets/photo.png")).toBe(
      "asset:///notes/opened/assets/photo.png",
    )
    expect(convert).toHaveBeenCalledWith("/notes/opened/assets/photo.png")
  })
})
