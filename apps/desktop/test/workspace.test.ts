import { describe, expect, it } from "vitest"
import { createFileSession, createSession, markSaved, openSession, sessionPath, sessionSavedContents } from "../src/session"
import {
  activeSession,
  addTab,
  baseName,
  closeTab,
  createWorkspace,
  findTabByPath,
  focusTab,
  ensureFolder,
  openFolder,
  parentDir,
  pathWithinDir,
  resolveMarkdownHref,
  replaceActive,
  replaceTabSession,
} from "../src/workspace"
import { OPEN_STREAM_THRESHOLD_BYTES, SAFE_MODE_BYTES } from "../src/constants"

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

  it("closing the active tab activates the neighbor that takes its slot", () => {
    // [1, 2, 3] close 2 → 3 slides into slot 2 → 3 becomes active.
    const workspace = [2, 3].reduce(
      (ws, id) => addTab(ws, createFileSession(id, `/${id}.md`, "", version)),
      createWorkspace(),
    )
    const closed = closeTab(workspace, 2)
    expect(closed.tabs.map(tab => tab.id)).toEqual([1, 3])
    expect(closed.activeId).toBe(3)
  })

  it("closing the last tab activates the previous one", () => {
    const workspace = [2, 3].reduce(
      (ws, id) => addTab(ws, createFileSession(id, `/${id}.md`, "", version)),
      createWorkspace(),
    )
    const closed = closeTab(workspace, 3)
    expect(closed.tabs.map(tab => tab.id)).toEqual([1, 2])
    expect(closed.activeId).toBe(2)
  })

  it("closing a background tab keeps the active tab", () => {
    const workspace = [2, 3].reduce(
      (ws, id) => addTab(ws, createFileSession(id, `/${id}.md`, "", version)),
      createWorkspace(),
    )
    const closed = closeTab(focusTab(workspace, 1), 2)
    expect(closed.tabs.map(tab => tab.id)).toEqual([1, 3])
    expect(closed.activeId).toBe(1)
  })

  it("closing an unknown tab leaves the workspace unchanged", () => {
    const workspace = addTab(createWorkspace(), createFileSession(2, "/b.md", "b", version))
    expect(closeTab(workspace, 99)).toBe(workspace)
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

describe("path helpers (Spec 05b)", () => {
  it("pathWithinDir normalizes windows separators", () => {
    expect(pathWithinDir("C:\\docs\\a.md", "C:\\docs")).toBe(true)
    expect(pathWithinDir("C:\\docs\\sub\\a.md", "C:\\docs")).toBe(true)
    expect(pathWithinDir("C:\\docs", "C:\\docs")).toBe(true)
    expect(pathWithinDir("C:\\other\\a.md", "C:\\docs")).toBe(false)
    expect(pathWithinDir("/docs/a.md", "/docs/")).toBe(true)
  })

  it("pathWithinDir does not match sibling prefixes", () => {
    expect(pathWithinDir("/docs-other/a.md", "/docs")).toBe(false)
    expect(pathWithinDir("/docs", "/docs/")).toBe(true)
  })

  it("baseName returns the final segment, separator-agnostic", () => {
    expect(baseName("/docs/a.md")).toBe("a.md")
    expect(baseName("C:\\docs\\a.md")).toBe("a.md")
    expect(baseName("a.md")).toBe("a.md")
    // Degenerate inputs fall back to the input rather than an empty label.
    // A trailing slash (never a real file path) yields the full input.
    expect(baseName("/docs/sub/")).toBe("/docs/sub/")
    expect(baseName("/")).toBe("/")
    expect(baseName("")).toBe("")
  })

  it("keeps the byte safe-mode axis aligned with the streaming tier boundary", () => {
    // constants.ts promises SAFE_MODE_BYTES === OPEN_STREAM_THRESHOLD_BYTES;
    // a LARGE-tier confirm must always imply the byte axis of safe mode.
    expect(SAFE_MODE_BYTES).toBe(OPEN_STREAM_THRESHOLD_BYTES)
  })
})
