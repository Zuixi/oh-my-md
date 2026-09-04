import { describe, expect, it } from "vitest"
import type { NormalizationId } from "@omd/engine"
import type { DocumentSaveState } from "../src/documentSaveState"
import type { TabNormalizationState } from "../src/normalizationState"
import { createFileSession, createSession, type EditorSession } from "../src/session"
import { updateRestartReadiness } from "../src/updateRestartReadiness"
import type { Workspace } from "../src/workspace"

function fileSession(id: number, path: string, saved: string): EditorSession {
  return createFileSession(id, path, saved, { resolvedPath: path, fingerprint: "v0:base" })
}

function workspace(activeId: number, ...tabs: EditorSession[]): Workspace {
  return { tabs, activeId, nextId: tabs.length + 1, folder: null }
}

function idleSave(divergence: DocumentSaveState["divergence"] = { kind: "none" }): DocumentSaveState {
  return { lifecycle: { kind: "idle" }, divergence, ioGeneration: 0 }
}

function activeSave(): DocumentSaveState {
  return {
    lifecycle: { kind: "saving", operationId: 1, snapshot: "snapshot" },
    divergence: { kind: "none" },
    ioGeneration: 1,
  }
}

function failedSave(): DocumentSaveState {
  return {
    lifecycle: { kind: "saveFailed", message: "disk full" },
    divergence: { kind: "none" },
    ioGeneration: 1,
  }
}

function contentConflict(path: string): DocumentSaveState {
  return idleSave({
    kind: "contentConflict",
    localSnapshot: "mine",
    disk: { requestedPath: path, contents: "theirs", version: { resolvedPath: path, fingerprint: "v1:disk" } },
  })
}

function pendingNormalization(): TabNormalizationState {
  return { notice: { id: 1 as NormalizationId, markerCount: 2 }, action: "idle" }
}

describe("update restart readiness", () => {
  it("is ready when no tab blocks restart", () => {
    const result = updateRestartReadiness({
      workspace: workspace(1, createSession(1)),
      contentsByTab: new Map([[1, ""]]),
      saveStates: {},
      normalization: {},
      opening: false,
    })
    expect(result).toEqual({ ready: true, reasons: [] })
  })

  it("blocks on dirty documents with the tab basename", () => {
    const result = updateRestartReadiness({
      workspace: workspace(1, fileSession(1, "/tmp/draft.md", "saved")),
      contentsByTab: new Map([[1, "changed"]]),
      saveStates: {},
      normalization: {},
      opening: false,
    })
    expect(result).toEqual({
      ready: false,
      reasons: [{ tabId: 1, displayName: "draft.md", reason: "dirtyDocument" }],
    })
  })

  it("blocks on a save conflict", () => {
    const result = updateRestartReadiness({
      workspace: workspace(1, fileSession(1, "/tmp/draft.md", "saved")),
      contentsByTab: new Map([[1, "changed"]]),
      saveStates: { 1: contentConflict("/tmp/draft.md") },
      normalization: {},
      opening: false,
    })
    expect(result).toEqual({
      ready: false,
      reasons: [{ tabId: 1, displayName: "draft.md", reason: "saveConflict" }],
    })
  })

  it("blocks on a failed save", () => {
    const result = updateRestartReadiness({
      workspace: workspace(1, createSession(1)),
      contentsByTab: new Map([[1, ""]]),
      saveStates: { 1: failedSave() },
      normalization: {},
      opening: false,
    })
    expect(result).toEqual({
      ready: false,
      reasons: [{ tabId: 1, displayName: "unnamed", reason: "saveFailed" }],
    })
  })

  it("blocks while a save is active", () => {
    const result = updateRestartReadiness({
      workspace: workspace(1, fileSession(1, "/tmp/draft.md", "saved")),
      contentsByTab: new Map([[1, "changed"]]),
      saveStates: { 1: activeSave() },
      normalization: {},
      opening: false,
    })
    expect(result).toEqual({
      ready: false,
      reasons: [{ tabId: 1, displayName: "draft.md", reason: "activeSave" }],
    })
  })

  it("blocks on pending ordered-list normalization", () => {
    const result = updateRestartReadiness({
      workspace: workspace(1, createSession(1)),
      contentsByTab: new Map([[1, ""]]),
      saveStates: {},
      normalization: { 1: pendingNormalization() },
      opening: false,
    })
    expect(result).toEqual({
      ready: false,
      reasons: [{ tabId: 1, displayName: "unnamed", reason: "pendingNormalization" }],
    })
  })

  it("blocks restart while an open operation is in flight", () => {
    const result = updateRestartReadiness({
      workspace: workspace(1, createSession(1)),
      contentsByTab: new Map([[1, ""]]),
      saveStates: {},
      normalization: {},
      opening: true,
    })
    expect(result).toEqual({
      ready: false,
      reasons: [{ tabId: 1, displayName: "unnamed", reason: "openOperation" }],
    })
  })

  it("prioritizes conflict over dirty and normalization for one tab", () => {
    const result = updateRestartReadiness({
      workspace: workspace(1, fileSession(1, "/tmp/draft.md", "original")),
      contentsByTab: new Map([[1, "changed"]]),
      saveStates: { 1: contentConflict("/tmp/draft.md") },
      normalization: { 1: pendingNormalization() },
      opening: false,
    })
    expect(result).toEqual({
      ready: false,
      reasons: [{ tabId: 1, displayName: "draft.md", reason: "saveConflict" }],
    })
  })

  it("prioritizes save conflict over a failed save", () => {
    const result = updateRestartReadiness({
      workspace: workspace(1, fileSession(1, "/tmp/draft.md", "saved")),
      contentsByTab: new Map([[1, "changed"]]),
      saveStates: { 1: { ...failedSave(), divergence: contentConflict("/tmp/draft.md").divergence } },
      normalization: {},
      opening: false,
    })
    expect(result.reasons).toEqual([
      { tabId: 1, displayName: "draft.md", reason: "saveConflict" },
    ])
  })

  it("prioritizes failed save over pending normalization and dirty", () => {
    const result = updateRestartReadiness({
      workspace: workspace(1, fileSession(1, "/tmp/draft.md", "saved")),
      contentsByTab: new Map([[1, "changed"]]),
      saveStates: { 1: failedSave() },
      normalization: { 1: pendingNormalization() },
      opening: false,
    })
    expect(result.reasons).toEqual([
      { tabId: 1, displayName: "draft.md", reason: "saveFailed" },
    ])
  })

  it("prioritizes active save over dirty documents", () => {
    const result = updateRestartReadiness({
      workspace: workspace(1, fileSession(1, "/tmp/draft.md", "saved")),
      contentsByTab: new Map([[1, "changed"]]),
      saveStates: { 1: activeSave() },
      normalization: {},
      opening: false,
    })
    expect(result.reasons).toEqual([
      { tabId: 1, displayName: "draft.md", reason: "activeSave" },
    ])
  })

  it("prioritizes pending normalization over dirty documents", () => {
    const result = updateRestartReadiness({
      workspace: workspace(1, fileSession(1, "/tmp/draft.md", "saved")),
      contentsByTab: new Map([[1, "changed"]]),
      saveStates: {},
      normalization: { 1: pendingNormalization() },
      opening: false,
    })
    expect(result.reasons).toEqual([
      { tabId: 1, displayName: "draft.md", reason: "pendingNormalization" },
    ])
  })

  it("reports blockers in deterministic workspace tab order", () => {
    const result = updateRestartReadiness({
      workspace: workspace(2,
        fileSession(3, "/tmp/c.md", "saved"),
        fileSession(1, "/tmp/a.md", "saved"),
        fileSession(2, "/tmp/b.md", "saved"),
      ),
      contentsByTab: new Map([[1, "changed"], [2, "changed"], [3, "changed"]]),
      saveStates: {},
      normalization: {},
      opening: false,
    })
    expect(result.reasons.map(row => row.tabId)).toEqual([3, 1, 2])
  })

  it("uses the untitled label for unnamed buffers", () => {
    const result = updateRestartReadiness({
      workspace: workspace(1, createSession(1)),
      contentsByTab: new Map([[1, "stuff"]]),
      saveStates: {},
      normalization: {},
      opening: false,
    })
    expect(result).toEqual({
      ready: false,
      reasons: [{ tabId: 1, displayName: "unnamed", reason: "dirtyDocument" }],
    })
  })

  it("blocks when a non-active tab is dirty", () => {
    const result = updateRestartReadiness({
      workspace: workspace(2, fileSession(1, "/tmp/a.md", "saved"), createSession(2)),
      contentsByTab: new Map([[1, "changed"], [2, ""]]),
      saveStates: {},
      normalization: {},
      opening: false,
    })
    expect(result).toEqual({
      ready: false,
      reasons: [{ tabId: 1, displayName: "a.md", reason: "dirtyDocument" }],
    })
  })

  it("appends an active-tab openOperation row after per-tab rows", () => {
    const result = updateRestartReadiness({
      workspace: workspace(1,
        fileSession(1, "/tmp/a.md", "saved"),
        fileSession(2, "/tmp/b.md", "saved"),
      ),
      contentsByTab: new Map([[1, "changed"]]),
      saveStates: { 1: contentConflict("/tmp/a.md"), 2: activeSave() },
      normalization: {},
      opening: true,
    })
    expect(result).toEqual({
      ready: false,
      reasons: [
        { tabId: 1, displayName: "a.md", reason: "saveConflict" },
        { tabId: 2, displayName: "b.md", reason: "activeSave" },
        { tabId: 1, displayName: "a.md", reason: "openOperation" },
      ],
    })
  })
})
