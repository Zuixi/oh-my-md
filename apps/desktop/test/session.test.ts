import { describe, expect, it } from "vitest"
import {
  advanceDocumentIdentity,
  createSession,
  markSaved,
  openSession,
  recoveryKey,
  sessionDirty,
  sessionLabel,
} from "../src/session"

describe("EditorSession", () => {
  it("starts clean and becomes dirty when the buffer diverges", () => {
    const session = createSession(1, "/notes/a.md", "saved")
    expect(sessionDirty(session, "saved")).toBe(false)
    expect(sessionDirty(session, "edited")).toBe(true)
  })

  it("keeps the tab id stable when opening a file and bumps documentId", () => {
    const session = createSession(3)
    const opened = openSession(session, "/notes/doc.md", "# hi")
    expect(opened.id).toBe(3)
    expect(opened.documentId).toBe(4)
    expect(opened.path).toBe("/notes/doc.md")
    expect(opened.savedContents).toBe("# hi")
    expect(sessionDirty(opened, "# hi")).toBe(false)
  })

  it("marks a save without changing tab identity", () => {
    const session = createSession(1)
    const saved = markSaved(session, "/notes/out.md", "body")
    expect(saved.id).toBe(1)
    expect(saved.documentId).toBe(1)
    expect(saved.path).toBe("/notes/out.md")
    expect(sessionDirty(saved, "body")).toBe(false)
  })

  it("advances identity without changing path or baseline", () => {
    const session = createSession(4, "/a.md", "saved")
    expect(advanceDocumentIdentity(session)).toEqual({
      ...session, documentId: session.documentId + 1,
    })
  })

  it("labels untitled buffers and file basenames", () => {
    expect(sessionLabel(createSession(1))).toBe("untitled")
    expect(sessionLabel(createSession(1, "/notes/doc.md"))).toBe("doc.md")
  })

  it("builds a recovery key from path or untitled id", () => {
    expect(recoveryKey(createSession(2))).toBe("untitled_2")
    expect(recoveryKey(createSession(1, "/notes/My Doc.md"))).toBe("_notes_My_Doc.md")
  })
})
