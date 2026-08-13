import { describe, expect, it, vi } from "vitest"
import { undo } from "@codemirror/commands"
import {
  createEditor,
  makeImageResolver,
  resetEditorDocument,
} from "../src/Editor"

describe("desktop editor lifecycle", () => {
  it("reports document transactions but ignores selection-only transactions", () => {
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
    view.destroy()
  })

  it("creates a fresh history when a different document is loaded", () => {
    const view = createEditor(document.createElement("div"), {
      doc: "first",
      getDocPath: () => "/tmp/first.md",
      getDocumentId: () => 1,
      onDocChanged: vi.fn(),
      onError: vi.fn(),
    })
    view.dispatch({ changes: { from: 5, insert: " changed" } })

    resetEditorDocument(view, {
      doc: "second",
      getDocPath: () => "/tmp/second.md",
      getDocumentId: () => 2,
      onDocChanged: vi.fn(),
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
