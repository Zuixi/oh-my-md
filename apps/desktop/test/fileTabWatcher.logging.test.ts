import { describe, expect, it, vi } from "vitest"
import { createFileTabWatcher } from "../src/documentSaveRunner"
import { initialSaveState, type SaveStateByTab } from "../src/documentSaveState"
import { createFileSession } from "../src/session"
import { createWorkspace, type Workspace } from "../src/workspace"
import type { DiskSnapshot, ExpectedDocumentVersion } from "../src/desktopServices"
import { versionFor } from "./fakeDisk"

function fixture() {
  const tabs = [1, 2].map(id => createFileSession(id, `/notes/${id}.md`, "baseline", versionFor(`/notes/${id}.md`, "baseline")))
  let workspace: Workspace = { ...createWorkspace(), tabs }
  let states: SaveStateByTab = Object.fromEntries(tabs.map(tab => [tab.id, initialSaveState()]))
  const failures = new Set<number>()
  const logReadFailed = vi.fn()
  const logReadRecovered = vi.fn()
  const readDocument = vi.fn(async (path: string): Promise<DiskSnapshot> => ({
    kind: "existing", requestedPath: path, contents: "external", version: versionFor(path, "external"),
  }))
  const readDocumentVersion = vi.fn(async (path: string): Promise<ExpectedDocumentVersion> => {
    const tab = tabs.find(item => item.persistence.kind === "file" && item.persistence.requestedPath === path)!
    if (failures.has(tab.id)) throw { code: "readFailed", message: "offline" }
    return { kind: "existing", version: versionFor(path, "baseline") }
  })
  const unreadable = new Map<number, string>()
  const buildPoll = () => createFileTabWatcher({
    getWorkspace: () => workspace,
    getContents: () => "baseline",
    getSaveStates: () => states,
    setSaveStates: next => { states = next },
    readDocumentVersion, readDocument, logReadFailed, logReadRecovered,
  }, unreadable)
  const poll = buildPoll()
  return { poll, buildPoll, tabs, failures, logReadFailed, logReadRecovered, readDocumentVersion, readDocument,
    setWorkspace: (next: Workspace) => { workspace = next },
    states: () => states }
}

describe("file polling diagnostics", () => {
  it("reports each unreadable file once, even when failures alternate across tabs", async () => {
    const fx = fixture()
    fx.failures.add(1).add(2)
    for (let tick = 0; tick < 20; tick++) await fx.poll()
    expect(fx.logReadFailed).toHaveBeenCalledTimes(2)
    expect(fx.states()[1]?.divergence.kind).toBe("none")
    fx.failures.delete(1)
    await fx.poll()
    expect(fx.logReadRecovered).toHaveBeenCalledExactlyOnceWith(fx.tabs[0])
    fx.failures.add(1)
    await fx.poll()
    expect(fx.logReadFailed).toHaveBeenCalledTimes(3)
  })

  it("retains outage suppression when React rebuilds the host bridge", async () => {
    const fx = fixture()
    fx.failures.add(1).add(2)
    await fx.poll()
    await fx.buildPoll()()
    expect(fx.logReadFailed).toHaveBeenCalledTimes(2)
  })

  it("does not announce recovery between a successful stat and a failed contents read", async () => {
    const fx = fixture()
    fx.readDocumentVersion.mockImplementation(async path => ({ kind: "existing", version: versionFor(path, "external") }))
    fx.readDocument.mockRejectedValue({ code: "readFailed", message: "cannot read" })
    for (let tick = 0; tick < 5; tick++) await fx.poll()
    expect(fx.logReadFailed).toHaveBeenCalledTimes(2)
    expect(fx.logReadRecovered).not.toHaveBeenCalled()
    fx.readDocument.mockImplementation(async path => ({
      kind: "existing", requestedPath: path, contents: "external", version: versionFor(path, "external"),
    }))
    await fx.poll()
    expect(fx.logReadRecovered).toHaveBeenCalledTimes(2)
  })

  it("ignores late failures for a document replaced during the read", async () => {
    const fx = fixture()
    fx.readDocumentVersion.mockImplementation(async () => {
      fx.setWorkspace({ ...createWorkspace(), tabs: [] })
      throw { code: "readFailed", message: "stale" }
    })
    await fx.poll()
    expect(fx.logReadFailed).not.toHaveBeenCalled()
    expect(fx.logReadRecovered).not.toHaveBeenCalled()
  })
})
