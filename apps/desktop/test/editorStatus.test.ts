import { describe, expect, it, vi } from "vitest"
import { createEditor, editorStatus } from "../src/Editor"
import { EDITOR_STATUS_FIELDS, sameEditorStatus, type EditorStatus } from "../src/editorStatus"

const BASE: EditorStatus = { cursor: "1:1", mode: "live" }
const CHANGED: EditorStatus = { cursor: "9:4", mode: "source" }

/** Exhaustive by construction: a new EditorStatus field breaks compilation here,
 * which is the point — equality and this drift guard must be updated together. */
function baseDifferingIn(field: keyof EditorStatus): EditorStatus {
  switch (field) {
    case "cursor":
      return { ...BASE, cursor: CHANGED.cursor }
    case "mode":
      return { ...BASE, mode: CHANGED.mode }
  }
}

describe("editor status equality", () => {
  it("compares exactly the fields a produced snapshot carries", () => {
    const view = createEditor(document.createElement("div"), {
      doc: "# Title\nbody",
      tabId: 1,
      documentId: 1,
      getDocPath: () => null,
      getDocumentId: () => 1,
      onDocumentUpdate: vi.fn(),
      onError: vi.fn(),
    })
    const expected = [...EDITOR_STATUS_FIELDS].sort()
    expect(Object.keys(editorStatus(view)).sort()).toEqual(expected)
    expect(Object.keys(editorStatus(null)).sort()).toEqual(expected)
    view.destroy()
  })

  it("treats a change in any single compared field as a different status", () => {
    expect(sameEditorStatus(BASE, { ...BASE })).toBe(true)
    for (const field of EDITOR_STATUS_FIELDS) {
      expect(sameEditorStatus(BASE, baseDifferingIn(field))).toBe(false)
    }
  })
})
