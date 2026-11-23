import { memo, type CSSProperties, type MouseEvent } from "react"
import { DEPTH_INDENT, ROW_HEIGHT, ROW_INSET, type VisibleRow } from "./fileTreeState"
import { samePath } from "./workspace"
import type { Translator } from "./i18n"
import { TreeIcons } from "./TreeEditRow"
import type { TreeEdit } from "./useTreeEditSession"

/**
 * One virtualized tree row (WAI-ARIA `treeitem`) plus the small DOM helpers the
 * tree body needs to place, find and announce rows.
 */
export interface RowActions {
  focus(path: string): void
  openFile(path: string): void
  toggleDir(path: string): void
  contextMenu(
    entry: VisibleRow["entry"],
    depth: number,
    expanded: boolean,
    event: MouseEvent<HTMLButtonElement>,
  ): void
}

export function absoluteRowStyle(index: number): CSSProperties {
  return {
    position: "absolute",
    top: index * ROW_HEIGHT,
    left: 0,
    right: 0,
    height: ROW_HEIGHT,
  }
}

/** Focus/scroll target lookup; paths are compared with the platform's case rules. */
export function findTreeRow(container: HTMLElement | null, path: string): HTMLButtonElement | null {
  if (!container) return null
  const rows = container.querySelectorAll<HTMLButtonElement>("[data-tree-path]")
  for (const row of rows) {
    if (row.dataset.treePath && samePath(row.dataset.treePath, path)) return row
  }
  return null
}

/** Row path behind a key event: the roving row is whatever dispatch focuses. */
export function rowPathFromTarget(target: EventTarget | null): string | null {
  if (!(target instanceof HTMLElement)) return null
  return target.closest<HTMLElement>("[data-tree-path]")?.dataset.treePath ?? null
}

export function rowFeedbackText(
  edit: TreeEdit | null,
  notice: string | null,
  t: Translator,
): string {
  if (edit?.error) return edit.error
  if (notice) return notice
  if (!edit) return ""
  if (edit.kind === "rename") {
    return edit.submitting ? t("filetree.rename.submitting") : t("filetree.rename.hint")
  }
  return edit.submitting ? t("filetree.create.submitting") : t("filetree.create.hint")
}

/**
 * Rows are memoized on entry/depth/expanded/active/selected/focusable so an
 * unrelated App re-render (e.g. every keystroke) skips rows whose data did not
 * change. `actions` is a stable object that reads the latest committed
 * callbacks, so excluding it from re-render decisions does not freeze stale
 * behavior.
 */
export const TreeRow = memo(function TreeRow(props: {
  row: VisibleRow
  active: boolean
  selected: boolean
  focusable: boolean
  actions: RowActions
}) {
  const { entry, depth, expanded } = props.row
  const className = [
    "filetree-item",
    props.selected ? "is-selected" : "",
    props.active ? "is-active" : "",
  ].filter(Boolean).join(" ")
  return (
    <button
      type="button"
      role="treeitem"
      className={className}
      data-tree-path={entry.path}
      style={{ paddingLeft: ROW_INSET + depth * DEPTH_INDENT }}
      tabIndex={props.focusable ? 0 : -1}
      aria-level={depth + 1}
      aria-expanded={entry.is_dir ? expanded : undefined}
      aria-selected={props.active}
      aria-current={props.active ? "page" : undefined}
      onClick={() => {
        props.actions.focus(entry.path)
        if (entry.is_dir) props.actions.toggleDir(entry.path)
        else props.actions.openFile(entry.path)
      }}
      onContextMenu={event => props.actions.contextMenu(entry, depth, expanded, event)}
    >
      <TreeIcons isDirectory={entry.is_dir} expanded={expanded} />
      <span className="filetree-name" title={entry.name}>{entry.name}</span>
    </button>
  )
}, (prev, next) =>
  prev.row.entry === next.row.entry &&
  prev.row.depth === next.row.depth &&
  prev.row.expanded === next.row.expanded &&
  prev.active === next.active &&
  prev.selected === next.selected &&
  prev.focusable === next.focusable,
)
