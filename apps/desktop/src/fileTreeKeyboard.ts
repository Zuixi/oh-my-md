import type { VisibleRow } from "./fileTreeState"
import { samePath } from "./workspace"

/**
 * Pure key-to-intent mapping for the file tree's WAI-ARIA tree pattern.
 *
 * Keeping the decision free of DOM/React state makes the awkward cases
 * (expanded directory vs. its first child, left-arrow on a nested row, a
 * context-menu key on a virtualized row) directly testable, while the caller
 * owns scrolling, focus and the platform callbacks.
 */

/** Chrome/WebKit keyCode reported for keys that commit an IME composition. */
const IME_COMPOSING_KEYCODE = 229

export interface TreeKeyInput {
  readonly key: string
  readonly shiftKey: boolean
  readonly altKey: boolean
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly isComposing: boolean
  readonly keyCode: number
}

export type TreeKeyIntent =
  /** Move the roving focus to a row index. */
  | { readonly kind: "focus"; readonly index: number }
  /** Expand or collapse a directory. */
  | { readonly kind: "toggle"; readonly path: string }
  /** Open a file row. */
  | { readonly kind: "open"; readonly path: string }
  /** Open the row's context menu at its viewport rect. */
  | { readonly kind: "contextMenu"; readonly index: number }

export function treeKeyIntent(
  event: TreeKeyInput,
  rows: readonly VisibleRow[],
  focusedPath: string | null,
): TreeKeyIntent | null {
  // Composing text or an application shortcut (Cmd/Ctrl/Alt) is never tree
  // navigation; unhandled keys must fall through to the platform.
  if (event.isComposing || event.keyCode === IME_COMPOSING_KEYCODE) return null
  if (event.altKey || event.ctrlKey || event.metaKey) return null
  if (rows.length === 0) return null

  const found = indexOfPath(rows, focusedPath)
  const index = found < 0 ? 0 : found
  const row = rows[index]
  if (!row) return null
  const lastIndex = rows.length - 1

  switch (event.key) {
    case "ArrowDown":
      return { kind: "focus", index: Math.min(index + 1, lastIndex) }
    case "ArrowUp":
      return { kind: "focus", index: Math.max(index - 1, 0) }
    case "Home":
      return { kind: "focus", index: 0 }
    case "End":
      return { kind: "focus", index: lastIndex }
    case "ArrowRight": {
      if (!row.entry.is_dir) return null
      if (!row.expanded) return { kind: "toggle", path: row.entry.path }
      const child = rows[index + 1]
      return child && child.depth > row.depth ? { kind: "focus", index: index + 1 } : null
    }
    case "ArrowLeft": {
      if (row.entry.is_dir && row.expanded) return { kind: "toggle", path: row.entry.path }
      if (row.depth === 0) return null
      const parentIndex = findAncestorIndex(rows, index, row.depth)
      return parentIndex < 0 ? null : { kind: "focus", index: parentIndex }
    }
    case "Enter":
      return row.entry.is_dir
        ? { kind: "toggle", path: row.entry.path }
        : { kind: "open", path: row.entry.path }
    case "ContextMenu":
      return { kind: "contextMenu", index }
    case "F10":
      return event.shiftKey ? { kind: "contextMenu", index } : null
    default:
      return null
  }
}

function indexOfPath(rows: readonly VisibleRow[], path: string | null): number {
  if (path === null) return -1
  return rows.findIndex(row => samePath(row.entry.path, path))
}

/** Nearest preceding row one level up: the ancestor visible right above. */
function findAncestorIndex(rows: readonly VisibleRow[], index: number, depth: number): number {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const candidate = rows[cursor]
    if (!candidate) continue
    if (candidate.depth === depth - 1) return cursor
    if (candidate.depth < depth - 1) return -1
  }
  return -1
}
