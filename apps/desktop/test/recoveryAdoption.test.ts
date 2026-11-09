import { describe, expect, it } from "vitest"
import { createRecoveryAdopter, type RecoveryAdoptionHost } from "../src/recoveryAdoption"
import { createFileSession, createSession, lazyFileSession, recoveryKey } from "../src/session"
import { addTab, createWorkspace, replaceActive, type Workspace } from "../src/workspace"

/** A recording host; `resetOk` lets a test force the "no view" outcome. */
function makeHost(initial: Workspace, resetOk = true) {
  let workspace = initial
  const contents = new Map<number, string>()
  const resets: number[] = []
  const host: RecoveryAdoptionHost = {
    getWorkspace: () => workspace,
    commitWorkspace: next => { workspace = next },
    getContents: tabId => contents.get(tabId) ?? "",
    setContents: (tabId, value) => { contents.set(tabId, value) },
    resetTabDocument: (session, value) => {
      if (!resetOk) return false
      resets.push(session.id)
      contents.set(session.id, value)
      return true
    },
    mountNewTab: () => {},
    syncDoc: (value, tabId) => { contents.set(tabId, value) },
  }
  return { host, contents, resets, workspace: () => workspace }
}

const VERSION = { resolvedPath: "/notes/one.md", fingerprint: "v1" }

describe("recovery adoption", () => {
  it("returns a path-keyed draft to its matching file tab, keeping the path", () => {
    const fileTab = createFileSession(1, "/notes/one.md", "disk body", VERSION)
    const state = makeHost(replaceActive(createWorkspace(), fileTab))

    expect(createRecoveryAdopter(state.host)({
      key: recoveryKey(fileTab),
      path: "/notes/one.md",
      contents: "recovered body",
    })).toBe(1)

    expect(state.resets).toEqual([1])
    expect(state.workspace().tabs).toHaveLength(1)
    expect(state.contents.get(1)).toBe("recovered body")
  })

  it("reuses the matching untitled tab instead of adding a second one", () => {
    const workspace = addTab(createWorkspace(), createSession(2))
    const state = makeHost(workspace)

    expect(createRecoveryAdopter(state.host)({
      key: recoveryKey(createSession(1)),
      path: null,
      contents: "draft",
    })).toBe(1)

    expect(state.resets).toEqual([1])
    expect(state.workspace().tabs.map(tab => tab.id)).toEqual([1, 2])
  })

  it("opens a new tab when no tab matches and the workspace is not pristine", () => {
    const workspace = addTab(createWorkspace(), createSession(2))
    const state = makeHost(workspace)

    expect(createRecoveryAdopter(state.host)({
      key: "untitled_main_9",
      path: null,
      contents: "orphan draft",
    })).toBe(3)

    expect(state.workspace().tabs.map(tab => tab.id)).toEqual([1, 2, 3])
    expect(state.workspace().activeId).toBe(3)
    expect(state.contents.get(3)).toBe("orphan draft")
  })

  it("never mounts into a lazy tab whose disk baseline is still unread", () => {
    // Mounting there would leave `persistence.kind === "lazyFile"`, so the next
    // activation would fetch the file and overwrite the draft after its record
    // was already deleted. The draft therefore opens in its own tab.
    const lazyTab = lazyFileSession(1, "/notes/one.md")
    const state = makeHost(replaceActive(createWorkspace(), lazyTab))

    expect(createRecoveryAdopter(state.host)({
      key: recoveryKey(lazyTab),
      path: "/notes/one.md",
      contents: "recovered body",
    })).toBe(2)

    expect(state.resets).toEqual([])
    expect(state.workspace().tabs.map(tab => tab.id)).toEqual([1, 2])
    expect(state.workspace().tabs[0].persistence).toMatchObject({ kind: "lazyFile" })
    expect(state.contents.get(2)).toBe("recovered body")
  })

  it("reports failure so the caller keeps the record when reset cannot run", () => {
    const fileTab = createFileSession(1, "/notes/one.md", "disk body", VERSION)
    const state = makeHost(replaceActive(createWorkspace(), fileTab), false)

    expect(createRecoveryAdopter(state.host)({
      key: recoveryKey(fileTab),
      path: "/notes/one.md",
      contents: "recovered body",
    })).toBeNull()
  })

  it("matches a path draft on its path, never on the record key", () => {
    // The key is an opaque name, not an identity the adopter may trust: even a
    // record keyed exactly like the open tab must not drop another file's draft
    // into it.
    const other = lazyFileSession(1, "/notes/a_b.md")
    const state = makeHost(replaceActive(createWorkspace(), other))

    createRecoveryAdopter(state.host)({
      key: recoveryKey(other),
      path: "/notes/a b.md",
      contents: "draft for the spaced file",
    })

    // No tab holds that exact path, and tab 1 is a saved file: a new tab opens.
    expect(state.resets).toEqual([])
    expect(state.workspace().tabs).toHaveLength(2)
    expect(state.workspace().tabs[1].persistence).toMatchObject({ kind: "untitled" })
    expect(state.contents.get(2)).toBe("draft for the spaced file")
  })
})
