export interface EditorSession {
  id: number
  documentId: number
  path: string | null
  savedContents: string
}

export function createSession(id: number, path: string | null = null, savedContents = ""): EditorSession {
  return { id, documentId: id, path, savedContents }
}

export function sessionDirty(session: EditorSession, doc: string): boolean {
  return doc !== session.savedContents
}

export function sessionLabel(session: EditorSession): string {
  if (!session.path) return "untitled"
  const normalized = session.path.replace(/\\/g, "/")
  const name = normalized.slice(normalized.lastIndexOf("/") + 1)
  return name || session.path
}

export function openSession(session: EditorSession, path: string, contents: string): EditorSession {
  return { ...session, documentId: session.documentId + 1, path, savedContents: contents }
}

export function markSaved(session: EditorSession, path: string, snapshot: string): EditorSession {
  return { ...session, path, savedContents: snapshot }
}

export function recoveryKey(session: EditorSession): string {
  return (session.path ?? `untitled_${session.id}`).replace(/[/\\: ]/g, "_")
}
