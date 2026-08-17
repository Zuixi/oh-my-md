import { describe, expect, it, vi } from "vitest"
import {
  canOpenDiff,
  diskSnapshotFromDivergence,
  makeConflictActions,
  SAVE_COPY_SAME_PATH_MESSAGE,
  type ConflictActionDeps,
} from "../src/conflictActions"
import { initialSaveState } from "../src/documentSaveState"
import { versionFor } from "./fakeDisk"

function makeDeps(overrides: Partial<ConflictActionDeps> = {}): ConflictActionDeps {
  const disk = {
    requestedPath: "/notes/a.md",
    contents: "theirs",
    version: versionFor("/notes/a.md", "theirs"),
  }
  return {
    services: {
      pickOpenPath: vi.fn(),
      pickSavePath: vi.fn(),
      readDocument: vi.fn(async () => ({ kind: "existing" as const, ...disk })),
      readDocumentVersion: vi.fn(),
      saveDocument: vi.fn(),
      readFile: vi.fn(),
      writeFile: vi.fn(),
      allowDocumentAssets: vi.fn(),
      confirmDiscard: vi.fn(() => true),
      reportError: vi.fn(),
    },
    getSession: () => ({
      id: 1,
      documentId: 1,
      persistence: {
        kind: "file" as const,
        requestedPath: "/notes/a.md",
        savedContents: "saved",
        version: versionFor("/notes/a.md", "saved"),
      },
    }),
    getContents: () => "mine",
    isDirty: () => true,
    getSaveState: () => ({
      ...initialSaveState(),
      divergence: { kind: "contentConflict", localSnapshot: "mine", disk },
    }),
    saveFile: vi.fn(async () => undefined),
    saveCopy: vi.fn(async () => undefined),
    resetFromSnapshot: vi.fn(),
    setDivergence: vi.fn(),
    clearDivergence: vi.fn(),
    clearSaveFailed: vi.fn(),
    openDiff: vi.fn(),
    closeTab: vi.fn(),
    reportStatus: vi.fn(),
    clearRecoveryForTab: vi.fn(),
    ...overrides,
  }
}

describe("diskSnapshotFromDivergence", () => {
  it("returns disk snapshots for comparable divergences", () => {
    const disk = {
      requestedPath: "/notes/a.md",
      contents: "theirs",
      version: versionFor("/notes/a.md", "theirs"),
    }
    expect(diskSnapshotFromDivergence({ kind: "contentConflict", localSnapshot: "mine", disk }))
      .toEqual(disk)
    expect(diskSnapshotFromDivergence({ kind: "externalChanged", disk })).toEqual(disk)
    expect(diskSnapshotFromDivergence({ kind: "pathChanged", localSnapshot: "mine" })).toBeNull()
    expect(canOpenDiff({ kind: "pathChanged", localSnapshot: "mine" })).toBe(false)
  })
})

describe("makeConflictActions", () => {
  it("compare opens the diff panel without touching disk or state", () => {
    const deps = makeDeps()
    const actions = makeConflictActions(deps)
    actions.compare(1)
    expect(deps.openDiff).toHaveBeenCalledWith(1)
    expect(deps.saveFile).not.toHaveBeenCalled()
  })

  it("keepCurrent promotes externalChanged to contentConflict", () => {
    const disk = {
      requestedPath: "/notes/a.md",
      contents: "theirs",
      version: versionFor("/notes/a.md", "theirs"),
    }
    const setDivergence = vi.fn()
    const deps = makeDeps({
      isDirty: () => false,
      getContents: () => "saved",
      getSaveState: () => ({
        ...initialSaveState(),
        divergence: { kind: "externalChanged", disk },
      }),
      setDivergence,
    })
    makeConflictActions(deps).keepCurrent(1)
    expect(setDivergence).toHaveBeenCalledWith(1, {
      kind: "contentConflict",
      localSnapshot: "saved",
      disk,
    })
  })

  it("reloadDisk asks before discarding dirty edits", async () => {
    const confirmDiscard = vi.fn(() => false)
    const deps = makeDeps({
      services: {
        ...makeDeps().services,
        confirmDiscard,
        readDocument: vi.fn(),
      },
    })
    await makeConflictActions(deps).reloadDisk(1)
    expect(confirmDiscard).toHaveBeenCalled()
    expect(deps.resetFromSnapshot).not.toHaveBeenCalled()
  })

  it("overwriteDisk uses the conflict disk version", async () => {
    const disk = {
      requestedPath: "/notes/a.md",
      contents: "theirs",
      version: versionFor("/notes/a.md", "theirs"),
    }
    const saveFile = vi.fn(async () => undefined)
    const deps = makeDeps({ saveFile })
    await makeConflictActions(deps).overwriteDisk(1)
    expect(saveFile).toHaveBeenCalledWith(1, "explicit", {
      kind: "overwrite",
      expected: { kind: "existing", version: disk.version },
    })
  })

  it("closeDiscard clears recovery after confirmation", () => {
    const deps = makeDeps()
    makeConflictActions(deps).closeDiscard(1)
    expect(deps.clearRecoveryForTab).toHaveBeenCalledWith(1)
    expect(deps.closeTab).toHaveBeenCalledWith(1)
  })

  it("retry clears save failed before saving again", async () => {
    const deps = makeDeps()
    await makeConflictActions(deps).retry(1)
    expect(deps.clearSaveFailed).toHaveBeenCalledWith(1)
    expect(deps.saveFile).toHaveBeenCalledWith(1, "explicit")
  })

  it("reports when save copy targets the original resolved path", async () => {
    const reportStatus = vi.fn()
    const deps = makeDeps({
      reportStatus,
      saveCopy: vi.fn(async () => {
        reportStatus(SAVE_COPY_SAME_PATH_MESSAGE)
      }),
    })
    await makeConflictActions(deps).saveCopy(1)
    expect(reportStatus).toHaveBeenCalledWith(SAVE_COPY_SAME_PATH_MESSAGE)
  })
})
