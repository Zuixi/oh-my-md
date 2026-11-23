import { describe, expect, it } from "vitest"
import { createFileSession, createSession } from "../src/session"
import { addTab, createWorkspace, openFolder } from "../src/workspace"
import { extractSessionState, parseSessionState } from "../src/sessionRestore"

describe("sessionRestore model", () => {
  it("extracts session state from workspace with pathed tabs", () => {
    let ws = createWorkspace()
    ws = openFolder(ws, "/workspace/notes")
    const version = { resolvedPath: "/workspace/notes/a.md", fingerprint: "v1:a" }
    ws = addTab(ws, createFileSession(1, "/workspace/notes/a.md", "a", version))
    ws = addTab(ws, createSession(2))
    const versionB = { resolvedPath: "/workspace/notes/b.md", fingerprint: "v1:b" }
    ws = addTab(ws, createFileSession(3, "/workspace/notes/b.md", "b", versionB))
    ws = { ...ws, activeId: 3 }

    const extracted = extractSessionState(ws)
    expect(extracted).toEqual({
      folder: "/workspace/notes",
      openPaths: ["/workspace/notes/a.md", "/workspace/notes/b.md"],
      activePath: "/workspace/notes/b.md",
    })
  })

  it("parses valid JSON session state", () => {
    const json = JSON.stringify({
      folder: "/my/folder",
      openPaths: ["/my/folder/doc1.md", "/my/folder/doc2.md"],
      activePath: "/my/folder/doc1.md",
    })

    const parsed = parseSessionState(json)
    expect(parsed).toEqual({
      folder: "/my/folder",
      openPaths: ["/my/folder/doc1.md", "/my/folder/doc2.md"],
      activePath: "/my/folder/doc1.md",
    })
  })

  it("handles corrupted or empty session state JSON gracefully", () => {
    expect(parseSessionState("bad json")).toBeNull()
    expect(parseSessionState("{}")).toEqual({
      folder: null,
      openPaths: [],
      activePath: null,
    })
  })

  it("keeps the legacy shape when no dirty buffers are passed", () => {
    let ws = createWorkspace()
    ws = addTab(ws, createFileSession(2, "/notes/a.md", "a", {
      resolvedPath: "/notes/a.md", fingerprint: "v1:a",
    }))
    ws = addTab(ws, createSession(3))
    ws = { ...ws, activeId: 2 }
    // A clean untitled tab adds nothing to the legacy projection…
    const legacy = extractSessionState(ws)
    expect(Object.keys(legacy).sort()).toEqual(["activePath", "folder", "openPaths"])
    expect(legacy).toEqual({ folder: null, openPaths: ["/notes/a.md"], activePath: "/notes/a.md" })
    // …while a hot-exit projection records the untitled tab once it is dirty.
    const keys = new Map<number, string>([[3, "draft_key"]])
    const hotExit = extractSessionState({ ...ws, activeId: 3 }, keys)
    expect(hotExit.hotExitTabs).toEqual([
      { kind: "file", path: "/notes/a.md", recoveryKey: null },
      { kind: "untitled", path: null, recoveryKey: "draft_key" },
    ])
    expect(hotExit.activeTabIndex).toBe(1)
  })

  it("records the active tab's index rather than its path", () => {
    let ws = createWorkspace()
    ws = addTab(ws, createFileSession(2, "/notes/a.md", "a", {
      resolvedPath: "/notes/a.md", fingerprint: "v1:a",
    }))
    ws = addTab(ws, createFileSession(3, "/notes/b.md", "b", {
      resolvedPath: "/notes/b.md", fingerprint: "v1:b",
    }))
    ws = { ...ws, activeId: 2 }
    const state = extractSessionState(ws, new Map([[2, "dirty_a"]]))
    expect(state.hotExitTabs?.map(entry => entry.recoveryKey)).toEqual(["dirty_a", null])
    expect(state.activeTabIndex).toBe(0)
  })

  it("round-trips hot exit tabs through JSON", () => {
    const json = JSON.stringify({
      folder: "/notes",
      openPaths: ["/notes/a.md"],
      activePath: "/notes/a.md",
      hotExitTabs: [
        { kind: "file", path: "/notes/a.md", recoveryKey: "dirty_a" },
        { kind: "untitled", path: null, recoveryKey: "draft" },
      ],
      activeTabIndex: 1,
    })
    expect(parseSessionState(json)).toEqual({
      folder: "/notes",
      openPaths: ["/notes/a.md"],
      activePath: "/notes/a.md",
      hotExitTabs: [
        { kind: "file", path: "/notes/a.md", recoveryKey: "dirty_a" },
        { kind: "untitled", path: null, recoveryKey: "draft" },
      ],
      activeTabIndex: 1,
    })
  })

  it("drops an unreadable hot exit list instead of trusting part of it", () => {
    const json = JSON.stringify({
      folder: null,
      openPaths: ["/notes/a.md"],
      activePath: "/notes/a.md",
      hotExitTabs: [{ kind: "file", path: "/notes/a.md", recoveryKey: null }, { kind: "bogus" }],
    })
    const parsed = parseSessionState(json)
    expect(parsed).not.toBeNull()
    expect(parsed?.openPaths).toEqual(["/notes/a.md"])
    expect(parsed?.hotExitTabs).toBeUndefined()
  })

  it("clamps an out-of-range active tab index to the tab list", () => {
    const json = JSON.stringify({
      folder: null,
      openPaths: [],
      activePath: null,
      hotExitTabs: [{ kind: "untitled", path: null, recoveryKey: "draft" }],
      activeTabIndex: 9,
    })
    expect(parseSessionState(json)?.activeTabIndex).toBe(0)
  })
})
