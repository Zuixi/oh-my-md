import type { DocumentVersion, ExistingDiskSnapshot } from "./desktopServices"
import { t } from "./i18n"

export type SessionPersistence =
  | { readonly kind: "untitled"; readonly savedContents: string }
  | {
      readonly kind: "file"
      readonly requestedPath: string
      readonly savedContents: string
      readonly version: DocumentVersion
    }
  | {
      /** Spec 05b 会话恢复的惰性 tab：只有路径，内容在首次激活时读取。 */
      readonly kind: "lazyFile"
      readonly requestedPath: string
    }

export interface EditorSession {
  readonly id: number
  readonly documentId: number
  readonly persistence: SessionPersistence
}

export function createSession(id: number): EditorSession {
  return { id, documentId: id, persistence: { kind: "untitled", savedContents: "" } }
}

/** A restored-but-unread tab; activation loads it via `openSession`. */
export function lazyFileSession(id: number, requestedPath: string): EditorSession {
  return { id, documentId: id, persistence: { kind: "lazyFile", requestedPath } }
}

/** False only for lazy restored tabs whose disk content has not been read yet. */
export function sessionContentLoaded(session: EditorSession): boolean {
  return session.persistence.kind !== "lazyFile"
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
  return session.persistence.kind === "untitled"
    ? null
    : session.persistence.requestedPath
}

export function sessionSavedContents(session: EditorSession): string {
  return session.persistence.kind === "lazyFile" ? "" : session.persistence.savedContents
}

export function sessionVersion(session: EditorSession): DocumentVersion | null {
  return session.persistence.kind === "file" ? session.persistence.version : null
}

export function sessionDirty(session: EditorSession, doc: string): boolean {
  if (session.persistence.kind === "lazyFile") return false
  return doc !== sessionSavedContents(session)
}

export function sessionLabel(session: EditorSession): string {
  const path = sessionPath(session)
  if (!path) return t("session.unnamed")
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
