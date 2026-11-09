import type { DocumentVersion, ExistingDiskSnapshot } from "./desktopServices"
import { t } from "./i18n"
import { currentWindowLabel } from "./windowScope"

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

/** Longest readable part kept from the identity; the hash carries uniqueness. */
const RECOVERY_KEY_SLUG_MAX = 48

/**
 * Recovery-file identity.
 *
 * A named tab keys on its path so drafts survive restarts and dedupe per file.
 * An untitled tab has no path, so its tab id is the only stable-in-process
 * identity — but tab ids restart at 1 in every window and on every launch.
 * Prefixing the window label keeps concurrent windows from overwriting each
 * other's drafts; cross-run reuse is intentional, because the next launch's
 * untitled tab is exactly the tab that draft belongs to.
 *
 * The key must also be a *portable file name*: it is written inside the app's
 * recovery directory on Windows, macOS, and Linux alike. A lossy sanitizer was
 * not enough — two paths differing only in a replaced character (`a b.md` vs
 * `a_b.md`) shared one draft, a whole long path could exceed the 255-byte name
 * limit (write failure on every keystroke), and Windows reserves `<>:"|?*`,
 * device names, and trailing dots/spaces. So the key is an ASCII slug plus a
 * 64-bit hash of the exact identity: bounded, collision-free in practice, and
 * identical in shape on every platform. The stored envelope still holds the
 * exact path, so adoption never depends on this name.
 */
export function recoveryKey(session: EditorSession): string {
  const path = sessionPath(session)
  const identity = path ?? `untitled_${currentWindowLabel()}_${session.id}`
  return `${recoveryKeySlug(identity)}_${recoveryKeyHash(identity)}`
}

/** Readable, filename-safe tail of the identity (never a Windows device name
 *  because the `_<hash>` suffix makes the base name longer than the device
 *  name, and dots are removed so it cannot read as an extension). */
function recoveryKeySlug(identity: string): string {
  const slug = identity
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
  // The end of a path is the file name, which is what makes a record readable
  // when its envelope is unreadable; the hash still disambiguates the rest.
  return slug.slice(-RECOVERY_KEY_SLUG_MAX) || "draft"
}

/** 64 bits (two independent 32-bit lanes) over the exact identity, in hex. */
function recoveryKeyHash(identity: string): string {
  let fnv = 0x811c9dc5
  let djb = 5381
  for (let index = 0; index < identity.length; index++) {
    const code = identity.charCodeAt(index)
    fnv = Math.imul(fnv ^ code, 0x01000193)
    djb = (Math.imul(djb, 33) ^ code) >>> 0
  }
  return `${(fnv >>> 0).toString(16).padStart(8, "0")}${djb.toString(16).padStart(8, "0")}`
}
