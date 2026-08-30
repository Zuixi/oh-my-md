import { memo, useEffect, useRef, useState, type MouseEvent } from "react"
import { ChevronRight, FileText, Folder, FolderOpen, PanelLeftClose, Search } from "lucide-react"
import { ROW_HEIGHT, visibleRowRange, type VisibleRow } from "./fileTreeState"
import { parentDir } from "./workspace"
import { shortcutFor } from "./shortcuts"
import { useT } from "./i18n"

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
  onNewFile?: (dir: string) => void
  onNewFolder?: (dir: string) => void
  onRename?: (entry: VisibleRow["entry"]) => void
  onDelete?: (entry: VisibleRow["entry"]) => void
  onReveal?: (path: string) => void
  onCollapse?: () => void
}) {
  const t = useT()
  const title = (props.folder ?? "").replace(/\\/g, "/").split("/").pop() || t("filetree.title.fallback")
  return (
    <aside className="filetree">
      <div className="sidebar-title">
        <div className="sidebar-title-left">
          {props.onCollapse ? (
            <button
              type="button"
              className="sidebar-collapse-btn"
              onClick={props.onCollapse}
              aria-label={t("filetree.aria.hideSidebar")}
              title={t("filetree.title.hideSidebar", { shortcut: shortcutFor("sidebar") ?? "" })}
            >
              <PanelLeftClose size={16} />
            </button>
          ) : null}
          <span className="sidebar-title-text">{title}</span>
        </div>
      </div>
      <div className="filetree-search-bar">
        <button
          type="button"
          className="filetree-search-btn"
          onClick={props.onSearch}
          aria-label={t("filetree.aria.search")}
        >
          <Search size={13} className="filetree-search-icon" aria-hidden="true" />
          <span>{t("filetree.searchInFolder")}</span>
          <kbd>{t("filetree.kbd.searchShortcut", { shortcut: shortcutFor("search") ?? "" })}</kbd>
        </button>
      </div>
      {!props.folder ? (
        <p className="sidebar-empty">{t("filetree.empty")}</p>
      ) : (
        <TreeScroller
          folder={props.folder}
          rows={props.rows}
          title={title}
          activePath={props.activePath}
          onOpenFile={props.onOpenFile}
          onToggleDir={props.onToggleDir}
          onNewFile={props.onNewFile}
          onNewFolder={props.onNewFolder}
          onRename={props.onRename}
          onDelete={props.onDelete}
          onReveal={props.onReveal}
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
  folder: string
  rows: VisibleRow[]
  title: string
  activePath: string | null
  onOpenFile: (path: string) => void
  onToggleDir: (path: string) => void
  onNewFile?: (dir: string) => void
  onNewFolder?: (dir: string) => void
  onRename?: (entry: VisibleRow["entry"]) => void
  onDelete?: (entry: VisibleRow["entry"]) => void
  onReveal?: (path: string) => void
}) {
  const t = useT()
  const [menu, setMenu] = useState<{
    readonly entry: VisibleRow["entry"] | null
    readonly dir: string
    readonly x: number
    readonly y: number
  } | null>(null)
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

  useEffect(() => {
    if (!menu) return
    const handleClick = () => setMenu(null)
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null)
    }
    window.addEventListener("click", handleClick)
    window.addEventListener("keydown", handleKeyDown)
    return () => {
      window.removeEventListener("click", handleClick)
      window.removeEventListener("keydown", handleKeyDown)
    }
  }, [menu])

  // Keep the active file visible. Runs again once rows arrive after an
  // auto-reveal expansion; the per-path guard stops it from fighting the user.
  const scrolledToRef = useRef<string | null>(null)
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !props.activePath || scrolledToRef.current === props.activePath) return
    const index = props.rows.findIndex(row => row.entry.path === props.activePath)
    if (index < 0) return
    const rowTop = index * ROW_HEIGHT
    const rowBottom = rowTop + ROW_HEIGHT
    if (rowTop < el.scrollTop || rowBottom > el.scrollTop + el.clientHeight) {
      el.scrollTop = rowTop
    }
    scrolledToRef.current = props.activePath
  }, [props.activePath, props.rows])

  const { start, end } = visibleRowRange(props.rows.length, viewportH, scrollTop)

  return (
    <div
      ref={scrollRef}
      className="filetree-tree"
      role="tree"
      aria-label={props.title}
      onContextMenu={event => {
        if (event.defaultPrevented) return
        event.preventDefault()
        setMenu({
          entry: null,
          dir: props.folder,
          x: event.clientX,
          y: event.clientY,
        })
      }}
      onScroll={event => {
        setScrollTop(event.currentTarget.scrollTop)
        if (menu) setMenu(null)
      }}
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
              onContextMenu={event => {
                event.preventDefault()
                event.stopPropagation()
                const dir = row.entry.is_dir ? row.entry.path : parentDir(row.entry.path)
                if (!dir) return
                setMenu({
                  entry: row.entry,
                  dir,
                  x: event.clientX,
                  y: event.clientY,
                })
              }}
            />
          </div>
        ))}
      </div>
      {menu ? (
        <div
          role="menu"
          aria-label={menu.entry ? t("filetree.aria.entryActions", { name: menu.entry.name }) : t("filetree.aria.folderActions")}
          style={{
            position: "fixed",
            top: menu.y,
            left: menu.x,
            zIndex: 50,
            display: "grid",
            gap: 4,
            minWidth: 160,
            padding: 6,
            border: "1px solid var(--omd-border)",
            borderRadius: 8,
            background: "var(--omd-panel-bg)",
            boxShadow: "0 8px 24px rgba(15, 23, 42, 0.16)",
          }}
          onClick={event => event.stopPropagation()}
        >
          <MenuItem
            label={t("filetree.menu.newFile")}
            onSelect={() => {
              setMenu(null)
              props.onNewFile?.(menu.dir)
            }}
          />
          <MenuItem
            label={t("filetree.menu.newFolder")}
            onSelect={() => {
              setMenu(null)
              props.onNewFolder?.(menu.dir)
            }}
          />
          {menu.entry ? (
            <>
              <MenuItem
                label={t("filetree.menu.rename")}
                onSelect={() => {
                  const entry = menu.entry
                  setMenu(null)
                  if (entry) props.onRename?.(entry)
                }}
              />
              <MenuItem
                label={t("filetree.menu.delete")}
                onSelect={() => {
                  const entry = menu.entry
                  setMenu(null)
                  if (entry) props.onDelete?.(entry)
                }}
              />
            </>
          ) : null}
          <MenuItem
            label={t("filetree.menu.reveal")}
            onSelect={() => {
              setMenu(null)
              props.onReveal?.(menu.entry?.path ?? props.folder)
            }}
          />
        </div>
      ) : null}
    </div>
  )
}

function MenuItem(props: { label: string; onSelect: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={props.onSelect}
      style={{
        border: 0,
        background: "transparent",
        borderRadius: 6,
        padding: "6px 8px",
        textAlign: "left",
        font: "inherit",
        color: "inherit",
        cursor: "pointer",
      }}
    >
      {props.label}
    </button>
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
  onContextMenu: (event: MouseEvent<HTMLButtonElement>) => void
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
      onContextMenu={props.onContextMenu}
    >
      <span className="filetree-chevron" aria-hidden="true">
        {entry.is_dir ? <ChevronRight size={ICON_SIZE} className={expanded ? "is-open" : undefined} /> : null}
      </span>
      {entry.is_dir
        ? (expanded ? <FolderOpen size={ICON_SIZE} /> : <Folder size={ICON_SIZE} />)
        : <FileText size={ICON_SIZE} />}
      <span className="filetree-name" title={entry.name}>{entry.name}</span>
    </button>
  )
}, (prev, next) =>
  prev.row.entry === next.row.entry &&
  prev.row.depth === next.row.depth &&
  prev.row.expanded === next.row.expanded &&
  prev.active === next.active,
)