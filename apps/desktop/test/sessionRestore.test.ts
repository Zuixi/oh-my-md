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
})
