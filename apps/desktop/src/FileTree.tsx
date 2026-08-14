import { memo, useEffect, useRef, useState } from "react"
import { ChevronRight, FileText, Folder, FolderOpen } from "lucide-react"
import { ROW_HEIGHT, visibleRowRange, type VisibleRow } from "./fileTreeState"

export type { TreeEntry } from "./fileTreeState"

const ROW_INSET = 8
const DEPTH_INDENT = 14
const ICON_SIZE = 14

export function FileTree(props: {
  folder: string | null
  rows: VisibleRow[]
  activePath: string | null
  onOpenFile: (path: string) => void
  onToggleDir: (path: string) => void
  onSearch: () => void
}) {
  const title = (props.folder ?? "").replace(/\\/g, "/").split("/").pop() || "Files"
  return (
    <aside className="filetree">
      <div className="sidebar-title">
        <span>{title}</span>
        <span className="sidebar-actions">
          <button type="button" onClick={props.onSearch}>Search</button>
        </span>
      </div>
      {!props.folder ? (
        <p className="sidebar-empty">Open a folder from the File menu.</p>
      ) : (
        <TreeScroller
          rows={props.rows}
          title={title}
          activePath={props.activePath}
          onOpenFile={props.onOpenFile}
          onToggleDir={props.onToggleDir}
        />
      )}
    </aside>
  )
}

/**
 * Virtualized tree body: only the rows intersecting the scroll viewport (plus
 * an overscan margin) are in the DOM, positioned absolutely inside a spacer
 * sized to the full row count. Row height is fixed (`ROW_HEIGHT`) so the
 * viewport window can be derived from scrollTop without measuring each row.
 */
function TreeScroller(props: {
  rows: VisibleRow[]
  title: string
  activePath: string | null
  onOpenFile: (path: string) => void
  onToggleDir: (path: string) => void
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportH, setViewportH] = useState(0)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const observer = new ResizeObserver(() => setViewportH(el.clientHeight))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const { start, end } = visibleRowRange(props.rows.length, viewportH, scrollTop)

  return (
    <div
      ref={scrollRef}
      className="filetree-tree"
      role="tree"
      aria-label={props.title}
      onScroll={event => setScrollTop(event.currentTarget.scrollTop)}
    >
      <div style={{ height: props.rows.length * ROW_HEIGHT, position: "relative" }}>
        {props.rows.slice(start, end).map((row, i) => (
          <div
            key={row.entry.path}
            style={{
              position: "absolute",
              top: (start + i) * ROW_HEIGHT,
              left: 0,
              right: 0,
              height: ROW_HEIGHT,
            }}
          >
            <TreeRow
              row={row}
              active={row.entry.path === props.activePath}
              onOpenFile={props.onOpenFile}
              onToggleDir={props.onToggleDir}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * Rows are memoized on entry/depth/expanded/active so an unrelated App
 * re-render (e.g. every keystroke) skips rows whose data did not change. The
 * handler props are intentionally excluded from the comparison: both closures
 * read refs only and are behaviourally stable across renders. If a handler ever
 * captures React state, it must participate in the comparison instead.
 */
const TreeRow = memo(function TreeRow(props: {
  row: VisibleRow
  active: boolean
  onOpenFile: (path: string) => void
  onToggleDir: (path: string) => void
}) {
  const { entry, depth, expanded } = props.row
  const className = props.active ? "filetree-item is-active" : "filetree-item"
  return (
    <button
      type="button"
      className={className}
      style={{ paddingLeft: ROW_INSET + depth * DEPTH_INDENT }}
      aria-expanded={entry.is_dir ? expanded : undefined}
      onClick={() => entry.is_dir ? props.onToggleDir(entry.path) : props.onOpenFile(entry.path)}
    >
      <span className="filetree-chevron" aria-hidden="true">
        {entry.is_dir ? <ChevronRight size={ICON_SIZE} className={expanded ? "is-open" : undefined} /> : null}
      </span>
      {entry.is_dir
        ? (expanded ? <FolderOpen size={ICON_SIZE} /> : <Folder size={ICON_SIZE} />)
        : <FileText size={ICON_SIZE} />}
      <span>{entry.name}</span>
    </button>
  )
}, (prev, next) =>
  prev.row.entry === next.row.entry &&
  prev.row.depth === next.row.depth &&
  prev.row.expanded === next.row.expanded &&
  prev.active === next.active,
)
