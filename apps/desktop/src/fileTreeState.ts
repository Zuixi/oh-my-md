import {
  baseName,
  comparablePath,
  pathSeparator,
  pathWithinDir,
  samePath,
} from "./workspace"

export interface TreeEntry {
  name: string
  path: string
  is_dir: boolean
}

export interface FileTreeModel {
  childrenByPath: Readonly<Record<string, readonly TreeEntry[]>>
  expanded: ReadonlySet<string>
}

export interface VisibleRow {
  entry: TreeEntry
  depth: number
  expanded: boolean
}

/** Fixed tree row height; must match `.filetree-item` in styles.css. */
export const ROW_HEIGHT = 26
/** Extra rows kept rendered above and below the viewport window. */
export const OVERSCAN = 10
/** Row inset and per-level indent; must match the `.filetree-item` padding. */
export const ROW_INSET = 8
export const DEPTH_INDENT = 14
/** Tree icon size; keep the reserved chevron slot stable across depths. */
export const ICON_SIZE = 14

export interface RowWindow {
  readonly start: number
  readonly end: number
}

export type CreateKind = "create-file" | "create-folder"

/**
 * Failure routing for tree edits: duplicate and invalid names stay inline in
 * the edit row; io failures leave the row and surface through the app's toast.
 */
export class TreeEditError extends Error {
  constructor(readonly kind: "duplicate" | "invalid" | "io", message: string) {
    super(message)
    this.name = "TreeEditError"
  }
}

/**
 * Index in the virtual display list where a create draft for `dir` belongs:
 * after the directory's last visible descendant, or at the end for the root.
 * Returns -1 while the directory is hidden (collapsed ancestor or missing), so
 * the draft row is not rendered at a misleading position.
 */
export function draftRowIndex(
  rows: readonly VisibleRow[],
  dir: string,
  folder: string,
): number {
  if (samePath(dir, folder)) return rows.length
  const index = rows.findIndex(row => row.entry.is_dir && samePath(row.entry.path, dir))
  if (index < 0) return -1
  const depth = rows[index]!.depth
  let end = index + 1
  while (end < rows.length && rows[end]!.depth > depth) end += 1
  return end
}

/** Viewport window for virtualization: rows [start, end) intersect the scroll
 * viewport, clamped to the list and to valid scroll positions. */
export function visibleRowRange(
  rowCount: number,
  viewportH: number,
  scrollTop: number,
  rowHeight: number = ROW_HEIGHT,
  overscan: number = OVERSCAN,
): RowWindow {
  const totalHeight = rowCount * rowHeight
  const effectiveTop = Math.min(scrollTop, Math.max(0, totalHeight - viewportH))
  const start = Math.max(0, Math.floor(effectiveTop / rowHeight) - overscan)
  const end = Math.min(rowCount, Math.ceil((effectiveTop + viewportH) / rowHeight) + overscan)
  return { start, end }
}

export function emptyFileTree(): FileTreeModel {
  return { childrenByPath: {}, expanded: new Set() }
}

export function setChildren(
  model: FileTreeModel,
  path: string,
  entries: readonly TreeEntry[],
): FileTreeModel {
  return {
    ...model,
    childrenByPath: { ...model.childrenByPath, [path]: entries },
  }
}

export function toggleExpand(model: FileTreeModel, path: string): FileTreeModel {
  const expanded = new Set(model.expanded)
  if (expanded.has(path)) expanded.delete(path)
  else expanded.add(path)
  return { ...model, expanded }
}

export function visibleRows(root: string, model: FileTreeModel): VisibleRow[] {
  return rowsFor(root, 0, model)
}

function rowsFor(dir: string, depth: number, model: FileTreeModel): VisibleRow[] {
  const entries = model.childrenByPath[dir] ?? []
  return entries.flatMap(entry => {
    const expanded = entry.is_dir && model.expanded.has(entry.path)
    const row = { entry, depth, expanded }
    return expanded ? [row, ...rowsFor(entry.path, depth + 1, model)] : [row]
  })
}

export function pathsToRefresh(root: string, model: FileTreeModel): string[] {
  return [...new Set([root, ...Object.keys(model.childrenByPath)])]
}

/**
 * Rewrite a cached path from the edited entry's old location to the new one.
 * `to` is already spelled in the tree's own form (IPC results are rebased onto
 * the caller's directory at the wire boundary), so it is used verbatim.
 */
export function replaceTreePrefix(path: string, from: string, to: string): string {
  if (!pathWithinDir(path, from)) return path
  const base = comparablePath(from).replace(/\/+$/, "")
  const suffix = comparablePath(path).slice(base.length)
  return to + (pathSeparator(to) === "\\" ? suffix.replace(/\//g, "\\") : suffix)
}

/** Drop a deleted subtree from cached listings and expansion in any path form. */
export function removeTreePath(model: FileTreeModel, path: string): FileTreeModel {
  const childrenByPath = Object.fromEntries(
    Object.entries(model.childrenByPath)
      .filter(([key]) => !pathWithinDir(key, path))
      .map(([key, entries]) => [
        key,
        entries.filter(entry => !pathWithinDir(entry.path, path)),
      ]),
  )
  const expanded = new Set(
    [...model.expanded].filter(entryPath => !pathWithinDir(entryPath, path)),
  )
  return { childrenByPath, expanded }
}

export function renameTreePath(model: FileTreeModel, from: string, to: string): FileTreeModel {
  const childrenByPath = Object.fromEntries(
    Object.entries(model.childrenByPath).map(([key, entries]) => [
      replaceTreePrefix(key, from, to),
      entries.map(entry => ({
        ...entry,
        name: samePath(entry.path, from) ? baseName(to) : entry.name,
        path: replaceTreePrefix(entry.path, from, to),
      })),
    ]),
  )
  const expanded = new Set([...model.expanded].map(path => replaceTreePrefix(path, from, to)))
  return { childrenByPath, expanded }
}
