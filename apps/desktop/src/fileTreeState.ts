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

export interface RowWindow {
  readonly start: number
  readonly end: number
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
