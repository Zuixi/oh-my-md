import type { DocumentVersion, ExistingDiskSnapshot } from "./desktopServices"

export type SessionPersistence =
  | { readonly kind: "untitled"; readonly savedContents: string }
  | {
      readonly kind: "file"
      readonly requestedPath: string
      readonly savedContents: string
      readonly version: DocumentVersion
    }

export interface EditorSession {
  readonly id: number
  readonly documentId: number
  readonly persistence: SessionPersistence
}

export function createSession(id: number): EditorSession {
  return { id, documentId: id, persistence: { kind: "untitled", savedContents: "" } }
}

export function createFileSession(
  id: number,
  requestedPath: string,
  savedContents: string,
  version: DocumentVersion,
): EditorSession {
  return {
    id,
    documentId: id,
    persistence: { kind: "file", requestedPath, savedContents, version },
  }
}

export function sessionPath(session: EditorSession): string | null {
  return session.persistence.kind === "file" ? session.persistence.requestedPath : null
}

export function sessionSavedContents(session: EditorSession): string {
  return session.persistence.savedContents
}

export function sessionVersion(session: EditorSession): DocumentVersion | null {
  return session.persistence.kind === "file" ? session.persistence.version : null
}

export function sessionDirty(session: EditorSession, doc: string): boolean {
  return doc !== sessionSavedContents(session)
}

export function sessionLabel(session: EditorSession): string {
  const path = sessionPath(session)
  if (!path) return "unnamed"
  const normalized = path.replace(/\\/g, "/")
  const name = normalized.slice(normalized.lastIndexOf("/") + 1)
  return name || path
}

export function openSession(
  session: EditorSession,
  snapshot: ExistingDiskSnapshot,
): EditorSession {
  return {
    ...session,
    documentId: session.documentId + 1,
    persistence: {
      kind: "file",
      requestedPath: snapshot.requestedPath,
      savedContents: snapshot.contents,
      version: snapshot.version,
    },
  }
}

/** Invalidates in-flight async work for this tab without touching path or saved baseline. */
export function advanceDocumentIdentity(session: EditorSession): EditorSession {
  return { ...session, documentId: session.documentId + 1 }
}

export function markSaved(
  session: EditorSession,
  requestedPath: string,
  snapshot: string,
  version: DocumentVersion,
): EditorSession {
  return {
    ...session,
    persistence: {
      kind: "file",
      requestedPath,
      savedContents: snapshot,
      version,
    },
  }
}

export function retargetSessionPath(
  session: EditorSession,
  requestedPath: string,
): EditorSession {
  if (session.persistence.kind !== "file") return session
  return {
    ...session,
    persistence: {
      ...session.persistence,
      requestedPath,
      version: {
        ...session.persistence.version,
        resolvedPath: requestedPath,
      },
    },
  }
}

export function recoveryKey(session: EditorSession): string {
  return (sessionPath(session) ?? `untitled_${session.id}`).replace(/[/\\: ]/g, "_")
}
