import { describe, expect, it } from "vitest"
import type { EditorView } from "@codemirror/view"
import type { NormalizationId } from "@omd/engine"
import {
  allocateOperationId,
  canAutosave,
  CONFLICT_ACTION_LABELS,
  conflictBannerModel,
  createTabSaveEnqueuer,
  divergenceFromSaveResult,
  divergenceFromSnapshot,
  expectedVersionFor,
  isCurrentSaveTarget,
  topBanner,
  watcherIntent,
} from "../src/documentSaveCoordinator"
import {
  applyDivergence,
  beginSave,
  failSave,
  initialSaveState,
  type ExistingDiskSnapshot,
} from "../src/documentSaveState"
import { projectNormalizationNotice } from "../src/normalizationState"
import { createFileSession, createSession } from "../src/session"
import { addTab, createWorkspace } from "../src/workspace"

const notice = { id: 1 as NormalizationId, markerCount: 2 }
const version = { resolvedPath: "/notes/a.md", fingerprint: "v1:aa" } as const
const nextVersion = { resolvedPath: "/notes/a.md", fingerprint: "v1:bb" } as const
const disk: ExistingDiskSnapshot = {
  requestedPath: "/notes/a.md",
  contents: "theirs",
  version: { resolvedPath: "/notes/a.md", fingerprint: "v1:bb" },
}
const pathChanged = { kind: "pathChanged", localSnapshot: "mine" } as const
const unexpectedSymlink = { kind: "unexpectedSymlinkAtTarget", localSnapshot: "mine" } as const

describe("documentSaveCoordinator", () => {
  it("blocks autosave for normalization, failure, saving, and divergence", () => {
    const base = {
      tabId: 1,
      dirty: true,
      hasPath: true,
      normalization: {},
      saveState: initialSaveState(),
    }
    expect(canAutosave(base)).toBe(true)
    expect(canAutosave({ ...base, dirty: false })).toBe(false)
    expect(canAutosave({ ...base, hasPath: false })).toBe(false)
    expect(canAutosave({ ...base, normalization: projectNormalizationNotice({}, 1, notice) })).toBe(false)
    expect(canAutosave({ ...base, saveState: beginSave(initialSaveState(), 1, "x") })).toBe(false)
    expect(canAutosave({ ...base, saveState: failSave(beginSave(initialSaveState(), 1, "x"), 1, "io") })).toBe(false)
    expect(canAutosave({ ...base, saveState: applyDivergence(initialSaveState(), pathChanged) })).toBe(false)
  })

  it("offers no compare or overwrite for symlink divergence", () => {
    expect(conflictBannerModel(applyDivergence(initialSaveState(), pathChanged))?.actions)
      .toEqual(["saveCopy", "reopenPrevious", "closeDiscard"])
    expect(conflictBannerModel(applyDivergence(initialSaveState(), unexpectedSymlink))?.actions)
      .toEqual(["chooseAnotherPath", "cancel"])
  })

  it("requires tab, document, and view identity for completion", () => {
    const view = {} as EditorView
    const workspace = addTab(createWorkspace(), {
      ...createFileSession(2, "/notes/b.md", "b", version),
      documentId: 8,
    })
    const views = new Map<number, EditorView>([[2, view]])
    const capture = { tabId: 2, documentId: 8, view, operationId: 1, normalizationId: null }
    expect(isCurrentSaveTarget(capture, workspace, views)).toBe(true)
    expect(isCurrentSaveTarget({ ...capture, documentId: 9 }, workspace, views)).toBe(false)
    expect(isCurrentSaveTarget({ ...capture, tabId: 3 }, workspace, views)).toBe(false)
    expect(isCurrentSaveTarget(capture, workspace, new Map())).toBe(false)
  })

  it("classifies watcher probes without fetching contents", () => {
    const session = createFileSession(1, "/notes/a.md", "body", version)
    expect(watcherIntent(session, { kind: "existing", version })).toEqual({ kind: "ignore" })
    expect(watcherIntent(session, { kind: "missing" })).toEqual({ kind: "deleted" })
    expect(watcherIntent(session, {
      kind: "existing",
      version: { resolvedPath: "/notes/other.md", fingerprint: version.fingerprint },
    })).toEqual({ kind: "pathChanged" })
    expect(watcherIntent(session, { kind: "existing", version: nextVersion }))
      .toEqual({ kind: "fetchContents" })
  })

  it("maps every save result to a divergence", () => {
    expect(divergenceFromSaveResult({ status: "saved", version, durability: "durable" }, "mine")).toBeNull()
    expect(divergenceFromSaveResult({ status: "contentConflict", disk }, "mine"))
      .toEqual({ kind: "contentConflict", localSnapshot: "mine", disk })
    expect(divergenceFromSaveResult({ status: "createdConflict", disk }, "mine"))
      .toEqual({ kind: "createdAtMissingTarget", localSnapshot: "mine", disk })
    expect(divergenceFromSaveResult({ status: "deletedConflict", requestedPath: "/notes/a.md" }, "mine"))
      .toEqual({ kind: "deletedExternally", localSnapshot: "mine" })
    expect(divergenceFromSaveResult({ status: "pathChangedConflict", requestedPath: "/notes/a.md" }, "mine"))
      .toEqual(pathChanged)
    expect(divergenceFromSaveResult({ status: "unexpectedSymlinkConflict", requestedPath: "/notes/a.md" }, "mine"))
      .toEqual(unexpectedSymlink)
  })

  it("chooses divergence by local dirty state", () => {
    expect(divergenceFromSnapshot(disk, false, "body")).toEqual({ kind: "externalChanged", disk })
    expect(divergenceFromSnapshot(disk, true, "mine"))
      .toEqual({ kind: "contentConflict", localSnapshot: "mine", disk })
  })

  it("announces one banner by priority", () => {
    const deleted = applyDivergence(initialSaveState(), { kind: "deletedExternally", localSnapshot: "mine" })
    const conflict = applyDivergence(initialSaveState(), { kind: "contentConflict", localSnapshot: "mine", disk })
    const failed = failSave(beginSave(initialSaveState(), 1, "mine"), 1, "disk full")
    expect(topBanner(deleted, true)).toBe("conflict")
    expect(topBanner(conflict, true)).toBe("conflict")
    expect(topBanner(failed, true)).toBe("saveFailed")
    expect(topBanner(initialSaveState(), true)).toBe("normalization")
    expect(topBanner(initialSaveState(), false)).toBeNull()
  })

  it("labels every conflict action", () => {
    for (const action of Object.values(CONFLICT_ACTION_LABELS)) {
      expect(action.length).toBeGreaterThan(0)
    }
    expect(CONFLICT_ACTION_LABELS.reopenPrevious).toBe("conflict.action.reopenPrevious")
  })

  it("derives expected version from session persistence", () => {
    expect(expectedVersionFor(createSession(1))).toEqual({ kind: "missing" })
    expect(expectedVersionFor(createFileSession(1, "/notes/a.md", "body", version)))
      .toEqual({ kind: "existing", version })
  })

  it("allocates monotonically increasing operation ids", () => {
    const seq = { current: 0 }
    expect(allocateOperationId(seq)).toBe(1)
    expect(allocateOperationId(seq)).toBe(2)
    expect(seq.current).toBe(2)
  })

  it("serializes saves per tab while allowing other tabs to run", async () => {
    const queues = new Map<number, Promise<void>>()
    const enqueue = createTabSaveEnqueuer(queues)
    const order: string[] = []

    const firstTabFirst = enqueue(1, async () => {
      order.push("1-start")
      await new Promise<void>(resolve => { setTimeout(resolve, 20) })
      order.push("1-end")
    })
    const firstTabSecond = enqueue(1, async () => {
      order.push("1-second")
    })
    const secondTab = enqueue(2, async () => {
      order.push("2-start")
      await new Promise<void>(resolve => { setTimeout(resolve, 5) })
      order.push("2-end")
    })

    await Promise.all([firstTabFirst, firstTabSecond, secondTab])
    expect(order.indexOf("2-end")).toBeLessThan(order.indexOf("1-end"))
    expect(order.indexOf("1-second")).toBeGreaterThan(order.indexOf("1-end"))
  })
})
