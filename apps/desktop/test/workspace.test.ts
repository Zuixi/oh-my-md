import { describe, expect, it } from "vitest"
import { createFileSession, createSession, markSaved, openSession, sessionPath, sessionSavedContents } from "../src/session"
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
  resolveMarkdownHref,
  replaceActive,
  replaceTabSession,
} from "../src/workspace"

const version = { resolvedPath: "/notes/a.md", fingerprint: "v1:aa" }

describe("workspace tabs", () => {
  it("starts with one untitled tab", () => {
    const workspace = createWorkspace()
    expect(workspace.tabs).toHaveLength(1)
    expect(sessionPath(activeSession(workspace))).toBeNull()
  })

  it("adds a tab and focuses it", () => {
    const workspace = addTab(createWorkspace(), createFileSession(9, "/b.md", "b", version))
    expect(workspace.tabs).toHaveLength(2)
    expect(workspace.activeId).toBe(9)
    expect(workspace.nextId).toBe(10)
  })

  it("refuses to close the last tab", () => {
    const workspace = createWorkspace()
    expect(closeTab(workspace, workspace.activeId)).toBe(workspace)
  })

  it("closes a tab and focuses a remaining neighbor", () => {
    const withSecond = addTab(createWorkspace(), createFileSession(2, "/b.md", "b", version))
    const closed = closeTab(withSecond, 2)
    expect(closed.tabs).toHaveLength(1)
    expect(closed.activeId).toBe(1)
  })

  it("replaces the active tab in place when a file is opened", () => {
    const workspace = createWorkspace()
    const opened = openSession(activeSession(workspace), {
      requestedPath: "/notes/a.md", contents: "a", version,
    })
    const next = replaceActive(workspace, opened)
    expect(next.tabs).toHaveLength(1)
    expect(next.activeId).toBe(1)
    expect(sessionPath(activeSession(next))).toBe("/notes/a.md")
  })

  it("replaces a background session without changing activeId", () => {
    const workspace = focusTab(addTab(createWorkspace(), createSession(2)), 1)
    const next = replaceTabSession(
      workspace,
      markSaved(workspace.tabs[1], "/b.md", "b", version),
    )
    expect(next.activeId).toBe(1)
    expect(sessionSavedContents(next.tabs.find(tab => tab.id === 2)!)).toBe("b")
  })

  it("ignores a session whose tab is already closed", () => {
    const workspace = createWorkspace()
    expect(replaceTabSession(workspace, createFileSession(7, "/gone.md", "gone", version))).toBe(workspace)
  })

  it("finds an open tab by path and focuses it", () => {
    const workspace = addTab(createWorkspace(), createFileSession(2, "/notes/b.md", "b", version))
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

  it("normalizes markdown hrefs against the document directory", () => {
    expect(resolveMarkdownHref("notes/doc.md", "./a.md")).toBe("notes/a.md")
    expect(resolveMarkdownHref("notes/doc.md", "../a.md")).toBe("a.md")
    expect(resolveMarkdownHref("notes/doc.md", "a.md#guide")).toBe("notes/a.md")
  })
})
