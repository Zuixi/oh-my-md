import type {
  DiskSnapshot,
  DocumentCommandError,
  DocumentVersion,
  ExpectedDocumentVersion,
  SaveDocumentResult,
} from "../src/desktopServices"

export interface SaveCall {
  readonly path: string
  readonly contents: string
  readonly expected: ExpectedDocumentVersion
}

export interface DiskFixture {
  readonly set: (contents: string) => void
  readonly remove: () => void
  readonly contents: () => string | null
  readonly version: () => DocumentVersion
  readonly saveCalls: () => readonly SaveCall[]
}

function fakeFingerprint(contents: string): string {
  return `v1:${contents.length}:${contents}`
}

export function versionFor(path: string, contents: string): DocumentVersion {
  return { resolvedPath: path, fingerprint: fakeFingerprint(contents) }
}

export interface FakeDisk {
  readonly readDocument: (path: string) => DiskSnapshot
  readonly readDocumentVersion: (path: string) => ExpectedDocumentVersion
  readonly saveDocument: (
    path: string,
    contents: string,
    expected: ExpectedDocumentVersion,
  ) => SaveDocumentResult
  readonly disk: (path: string) => DiskFixture
  readonly seed: (path: string, contents: string) => void
}

export function makeFakeDisk(): FakeDisk {
  const files = new Map<string, string>()
  const calls: SaveCall[] = []

  function readDocument(path: string): DiskSnapshot {
    const contents = files.get(path)
    return contents === undefined
      ? { kind: "missing", requestedPath: path }
      : {
          kind: "existing",
          requestedPath: path,
          contents,
          version: versionFor(path, contents),
          // 与生产 stats 同约定（ASCII 测试内容下 length 即字节数）。
          stats: {
            byteLength: contents.length,
            lineCount: contents ? contents.split("\n").length : 1,
          },
        }
  }

  function readDocumentVersion(path: string): ExpectedDocumentVersion {
    const contents = files.get(path)
    return contents === undefined
      ? { kind: "missing" }
      : { kind: "existing", version: versionFor(path, contents) }
  }

  function saveDocument(
    path: string,
    contents: string,
    expected: ExpectedDocumentVersion,
  ): SaveDocumentResult {
    calls.push({ path, contents, expected })
    const current = files.get(path)
    if (expected.kind === "missing") {
      if (current === undefined) {
        files.set(path, contents)
        return { status: "saved", version: versionFor(path, contents), durability: "durable" }
      }
      return {
        status: "createdConflict",
        disk: { requestedPath: path, contents: current, version: versionFor(path, current) },
      }
    }
    if (current === undefined) {
      return { status: "deletedConflict", requestedPath: path }
    }
    if (expected.version.resolvedPath !== path) {
      return { status: "pathChangedConflict", requestedPath: path }
    }
    if (expected.version.fingerprint !== fakeFingerprint(current)) {
      return {
        status: "contentConflict",
        disk: { requestedPath: path, contents: current, version: versionFor(path, current) },
      }
    }
    files.set(path, contents)
    return { status: "saved", version: versionFor(path, contents), durability: "durable" }
  }

  function disk(path: string): DiskFixture {
    return {
      set: contents => { files.set(path, contents) },
      remove: () => { files.delete(path) },
      contents: () => files.get(path) ?? null,
      version: () => {
        const contents = files.get(path)
        if (contents === undefined) {
          throw new Error(`fake disk: ${path} is missing`)
        }
        return versionFor(path, contents)
      },
      saveCalls: () => calls.filter(call => call.path === path),
    }
  }

  return {
    readDocument,
    readDocumentVersion,
    saveDocument,
    disk,
    seed: (path, contents) => { files.set(path, contents) },
  }
}

export type SaveDocumentOverride =
  | { readonly kind: "result"; readonly result: SaveDocumentResult }
  | { readonly kind: "error"; readonly error: DocumentCommandError }
