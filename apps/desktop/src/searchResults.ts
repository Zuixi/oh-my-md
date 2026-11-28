import type { SearchHit } from "./SearchPanel"
import { baseName, parentDir, pathWithinDir, relativeToDir } from "./workspace"

export interface SearchFileGroup {
  readonly path: string
  readonly name: string
  readonly relativeDir: string
  readonly hits: readonly SearchHit[]
}

/**
 * Groups flat search hits by file path in O(N) while preserving the server's
 * hit order. Each group carries its display filename and workspace-relative
 * parent directory (empty string for files directly inside `folder`).
 */
export function groupSearchHits(
  hits: readonly SearchHit[],
  folder: string | null,
): SearchFileGroup[] {
  const groups: SearchFileGroup[] = []
  const byPath = new Map<string, { group: SearchFileGroup; hits: SearchHit[] }>()

  for (const hit of hits) {
    let bucket = byPath.get(hit.path)
    if (!bucket) {
      const bucketHits: SearchHit[] = []
      const group: SearchFileGroup = {
        path: hit.path,
        name: baseName(hit.path),
        relativeDir: relativeParentDir(hit.path, folder),
        hits: bucketHits,
      }
      bucket = { group, hits: bucketHits }
      byPath.set(hit.path, bucket)
      groups.push(group)
    }
    bucket.hits.push(hit)
  }

  return groups
}

function relativeParentDir(filePath: string, folder: string | null): string {
  const parent = parentDir(filePath)
  if (!parent) return ""
  if (folder && pathWithinDir(filePath, folder)) {
    const rel = relativeToDir(filePath, folder)
    const slash = rel.lastIndexOf("/")
    return slash > 0 ? rel.slice(0, slash) : ""
  }
  return parent
}
