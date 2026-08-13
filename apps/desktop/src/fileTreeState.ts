export interface TreeEntry {
  name: string
  path: string
  is_dir: boolean
}

export interface FileTreeModel {
  childrenByPath: Readonly<Record<string, readonly TreeEntry[]>>
  expanded: readonly string[]
}

export interface VisibleRow {
  entry: TreeEntry
  depth: number
  expanded: boolean
}

export function emptyFileTree(): FileTreeModel {
  return { childrenByPath: {}, expanded: [] }
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
  const expanded = model.expanded.includes(path)
    ? model.expanded.filter(item => item !== path)
    : [...model.expanded, path]
  return { ...model, expanded }
}

export function visibleRows(root: string, model: FileTreeModel): VisibleRow[] {
  return rowsFor(root, 0, model)
}

function rowsFor(dir: string, depth: number, model: FileTreeModel): VisibleRow[] {
  const entries = model.childrenByPath[dir] ?? []
  return entries.flatMap(entry => {
    const expanded = entry.is_dir && model.expanded.includes(entry.path)
    const row = { entry, depth, expanded }
    return expanded ? [row, ...rowsFor(entry.path, depth + 1, model)] : [row]
  })
}

export function pathsToRefresh(root: string, model: FileTreeModel): string[] {
  return [...new Set([root, ...Object.keys(model.childrenByPath)])]
}
