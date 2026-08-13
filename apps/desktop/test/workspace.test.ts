import { describe, expect, it } from "vitest"
import { createSession, openSession } from "../src/session"
import {
  activeSession,
  addTab,
  closeTab,
  createWorkspace,
  findTabByPath,
  focusTab,
  ensureFolder,
  openFolder,
  parentDir,
  replaceActive,
} from "../src/workspace"

describe("workspace tabs", () => {
  it("starts with one untitled tab", () => {
    const workspace = createWorkspace()
    expect(workspace.tabs).toHaveLength(1)
    expect(activeSession(workspace).path).toBeNull()
  })

  it("adds a tab and focuses it", () => {
    const workspace = addTab(createWorkspace(), createSession(9, "/b.md", "b"))
    expect(workspace.tabs).toHaveLength(2)
    expect(workspace.activeId).toBe(9)
    expect(workspace.nextId).toBe(10)
  })

  it("refuses to close the last tab", () => {
    const workspace = createWorkspace()
    expect(closeTab(workspace, workspace.activeId)).toBe(workspace)
  })

  it("closes a tab and focuses a remaining neighbor", () => {
    const withSecond = addTab(createWorkspace(), createSession(2, "/b.md", "b"))
    const closed = closeTab(withSecond, 2)
    expect(closed.tabs).toHaveLength(1)
    expect(closed.activeId).toBe(1)
  })

  it("replaces the active tab in place when a file is opened", () => {
    const workspace = createWorkspace()
    const opened = openSession(activeSession(workspace), "/notes/a.md", "a")
    const next = replaceActive(workspace, opened)
    expect(next.tabs).toHaveLength(1)
    expect(next.activeId).toBe(1)
    expect(activeSession(next).path).toBe("/notes/a.md")
  })

  it("finds an open tab by path and focuses it", () => {
    const workspace = addTab(createWorkspace(), createSession(2, "/notes/b.md", "b"))
    expect(findTabByPath(workspace, "/notes/b.md")?.id).toBe(2)
    expect(focusTab(workspace, 1).activeId).toBe(1)
  })

  it("records the opened folder root", () => {
    expect(openFolder(createWorkspace(), "/notes").folder).toBe("/notes")
  })

  it("derives a folder root from a document path only when none is set", () => {
    expect(parentDir("/Users/wqz/Documents/test.md")).toBe("/Users/wqz/Documents")
    expect(parentDir("/test.md")).toBeNull()
    const inferred = ensureFolder(createWorkspace(), "/notes/doc.md")
    expect(inferred.folder).toBe("/notes")
    expect(ensureFolder(inferred, "/other/file.md").folder).toBe("/notes")
  })
})
