import { describe, expect, it } from "vitest"
import {
  advanceDocumentIdentity,
  createFileSession,
  createSession,
  markSaved,
  openSession,
  recoveryKey,
  sessionDirty,
  sessionLabel,
  sessionPath,
  sessionSavedContents,
  sessionVersion,
} from "../src/session"

const version = { resolvedPath: "/notes/a.md", fingerprint: "v1:aa" } as const
const nextVersion = { resolvedPath: "/notes/a.md", fingerprint: "v1:bb" } as const

describe("EditorSession", () => {
  it("starts clean and becomes dirty when the buffer diverges", () => {
    const session = createFileSession(1, "/notes/a.md", "saved", version)
    expect(sessionDirty(session, "saved")).toBe(false)
    expect(sessionDirty(session, "edited")).toBe(true)
  })

  it("exposes no path or version for untitled sessions", () => {
    const untitled = createSession(1)
    expect(sessionPath(untitled)).toBeNull()
    expect(sessionVersion(untitled)).toBeNull()
    expect(sessionSavedContents(untitled)).toBe("")
  })

  it("keeps path, baseline, and version in one atomic transition", () => {
    const saved = markSaved(createSession(1), "/notes/a.md", "body", version)
    expect(sessionPath(saved)).toBe("/notes/a.md")
    expect(sessionSavedContents(saved)).toBe("body")
    expect(sessionVersion(saved)).toEqual(version)
    expect(sessionDirty(saved, "body")).toBe(false)
  })

  it("opens from an existing snapshot and bumps identity", () => {
    const opened = openSession(createSession(1), {
      requestedPath: "/notes/a.md", contents: "disk", version,
    })
    expect(opened.documentId).toBe(2)
    expect(sessionVersion(opened)).toEqual(version)
  })

  it("keeps the tab id stable when opening a file and bumps documentId", () => {
    const session = createSession(3)
    const opened = openSession(session, {
      requestedPath: "/notes/doc.md", contents: "# hi", version,
    })
    expect(opened.id).toBe(3)
    expect(opened.documentId).toBe(4)
    expect(sessionPath(opened)).toBe("/notes/doc.md")
    expect(sessionSavedContents(opened)).toBe("# hi")
    expect(sessionDirty(opened, "# hi")).toBe(false)
  })

  it("marks a save without changing tab identity", () => {
    const session = createSession(1)
    const saved = markSaved(session, "/notes/out.md", "body", version)
    expect(saved.id).toBe(1)
    expect(saved.documentId).toBe(1)
    expect(sessionPath(saved)).toBe("/notes/out.md")
    expect(sessionDirty(saved, "body")).toBe(false)
  })

  it("advances identity while preserving persistence", () => {
    const session = createFileSession(1, "/notes/a.md", "body", version)
    expect(advanceDocumentIdentity(session)).toEqual({
      ...session,
      documentId: session.documentId + 1,
    })
  })

  it("replaces path, baseline, and version together", () => {
    const saved = markSaved(createSession(1), "/notes/a.md", "body", version)
    const resaved = markSaved(saved, "/notes/a.md", "next", nextVersion)
    expect(sessionSavedContents(resaved)).toBe("next")
    expect(sessionVersion(resaved)).toEqual(nextVersion)
    expect(sessionDirty(resaved, "next")).toBe(false)
  })

  it("labels untitled buffers and file basenames", () => {
    expect(sessionLabel(createSession(1))).toBe("unnamed")
    expect(sessionLabel(createFileSession(1, "/notes/doc.md", "", version))).toBe("doc.md")
  })

  it("derives label and recovery key from persistence", () => {
    const session = createFileSession(3, "/notes/a b.md", "body", version)
    expect(sessionLabel(session)).toBe("a b.md")
    expect(recoveryKey(session)).toBe("_notes_a_b.md")
  })

  it("builds a recovery key from path or untitled id", () => {
    expect(recoveryKey(createSession(2))).toBe("untitled_2")
    expect(recoveryKey(createFileSession(1, "/notes/My Doc.md", "", version))).toBe("_notes_My_Doc.md")
  })
})
