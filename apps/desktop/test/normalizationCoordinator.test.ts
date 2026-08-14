import { describe, expect, it } from "vitest"
import type { EditorView } from "@codemirror/view"
import type { NormalizationId } from "@omd/engine"
import { createSession } from "../src/session"
import { addTab, createWorkspace } from "../src/workspace"
import {
  canAutosaveTab,
  isCurrentNormalizationTarget,
  type NormalizationOperationCapture,
} from "../src/normalizationCoordinator"
import { projectNormalizationNotice } from "../src/normalizationState"

const notice = { id: 1 as NormalizationId, markerCount: 2 }
const targetView = {} as EditorView
const workspace = addTab(createWorkspace(), {
  ...createSession(2, "/notes/b.md", "b"),
  documentId: 8,
})
const views = new Map<number, EditorView>([[2, targetView]])

function makeCapture(
  overrides: Partial<NormalizationOperationCapture> = {},
): NormalizationOperationCapture {
  return {
    tabId: 2,
    documentId: 8,
    view: targetView,
    normalizationId: notice.id,
    ...overrides,
  }
}

describe("normalizationCoordinator", () => {
  it("blocks autosave only for the pending tab", () => {
    const state = projectNormalizationNotice({}, 2, notice)
    expect(canAutosaveTab(1, state)).toBe(true)
    expect(canAutosaveTab(2, state)).toBe(false)
  })

  it("requires tab, document, view, and notice identity to match", () => {
    const capture = makeCapture({ tabId: 2, documentId: 8, normalizationId: notice.id })
    expect(isCurrentNormalizationTarget(capture, workspace, views, notice)).toBe(true)
    expect(isCurrentNormalizationTarget({ ...capture, documentId: 9 }, workspace, views, notice)).toBe(false)
    expect(isCurrentNormalizationTarget(capture, workspace, new Map(), notice)).toBe(false)
    expect(isCurrentNormalizationTarget(capture, workspace, views, null)).toBe(false)
  })
})
