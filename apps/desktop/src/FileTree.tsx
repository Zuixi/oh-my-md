import {
  memo, useEffect, useId, useMemo, useRef, useState,
  type CSSProperties, type MouseEvent,
} from "react"
import { PanelLeftClose, Search } from "lucide-react"
import {
  DEPTH_INDENT, ROW_HEIGHT, ROW_INSET, draftRowIndex, visibleRowRange,
  type CreateKind, type VisibleRow,
} from "./fileTreeState"
import { baseName, parentDir, pathWithinDir, samePath } from "./workspace"
import { shortcutFor } from "./shortcuts"
import { useT, type Translator } from "./i18n"
import { TreeEditRow, TreeIcons } from "./TreeEditRow"
import { useTreeEditSession, type TreeEdit } from "./useTreeEditSession"

export type { TreeEntry } from "./fileTreeState"

interface TreeMenuState {
  readonly entry: VisibleRow["entry"] | null
  readonly dir: string
  readonly depth: number
  /** The context menu opened on a collapsed directory; creating expands it. */
  readonly expandDir: boolean
  readonly x: number
  readonly y: number
}

interface RevealRequest {
  readonly path: string
  /** Folder creation moves row focus; file creation focuses the editor. */
  readonly focus: boolean
}

interface RowActions {
  openFile(path: string): void
  toggleDir(path: string): void
  contextMenu(
    entry: VisibleRow["entry"],
    depth: number,
    expanded: boolean,
    event: MouseEvent<HTMLButtonElement>,
  ): void
}

export function FileTree(props: {
  folder: string | null
  rows: VisibleRow[]
  activePath: string | null
  activeTabId?: number
  visible?: boolean
  onOpenFile: (path: string) => void
  onToggleDir: (path: string) => void
  onSearch: () => void
  onCreateFile?: (dir: string, name: string) => Promise<string>
  onCreateFolder?: (dir: string, name: string) => Promise<string>
  onSuggestName?: (kind: CreateKind, dir: string) => Promise<string>
  onRename?: (entry: VisibleRow["entry"], name: string) => Promise<string>
  onEditError?: (message: string) => void
  onDelete?: (entry: VisibleRow["entry"]) => void
  onReveal?: (path: string) => void
  onCollapse?: () => void
}) {
  const t = useT()
  const title = props.folder ? baseName(props.folder) : t("filetree.title.fallback")
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
          key={props.folder}
          folder={props.folder}
          rows={props.rows}
          title={title}
          activePath={props.activePath}
          activeTabId={props.activeTabId}
          visible={props.visible}
          onOpenFile={props.onOpenFile}
          onToggleDir={props.onToggleDir}
          onCreateFile={props.onCreateFile}
          onCreateFolder={props.onCreateFolder}
          onSuggestName={props.onSuggestName}
          onRename={props.onRename}
          onEditError={props.onEditError}
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
 *
 * A create draft is an extra display slot derived from `draftRowIndex`; entry
 * indexes shift by one after it, so the virtual window stays O(viewport).
 */
function TreeScroller(props: {
  folder: string
  rows: VisibleRow[]
  title: string
  activePath: string | null
  activeTabId?: number
  visible?: boolean
  onOpenFile: (path: string) => void
  onToggleDir: (path: string) => void
  onCreateFile?: (dir: string, name: string) => Promise<string>
  onCreateFolder?: (dir: string, name: string) => Promise<string>
  onSuggestName?: (kind: CreateKind, dir: string) => Promise<string>
  onRename?: (entry: VisibleRow["entry"], name: string) => Promise<string>
  onEditError?: (message: string) => void
  onDelete?: (entry: VisibleRow["entry"]) => void
  onReveal?: (path: string) => void
}) {
  const t = useT()
  const [menu, setMenu] = useState<TreeMenuState | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportH, setViewportH] = useState(0)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const feedbackId = useId()
  const focusPathRef = useRef<string | null>(null)
  const revealRef = useRef<RevealRequest | null>(null)

  const session = useTreeEditSession({
    folder: props.folder,
    rows: props.rows,
    visible: props.visible,
    activePath: props.activePath,
    activeTabId: props.activeTabId,
    onRename: props.onRename,
    onCreateFile: props.onCreateFile,
    onCreateFolder: props.onCreateFolder,
    onSuggestName: props.onSuggestName,
    onEditError: props.onEditError,
    onCommitted: (path, kind) => {
      setSelectedPath(path)
      revealRef.current = { path, focus: kind === "create-folder" }
    },
    onFocusRow: path => { focusPathRef.current = path },
  })
  const edit = session.edit

  // Row handlers are stable so memoized rows are not invalidated by App
  // re-renders, but they must invoke the latest callbacks. The actions object
  // is refreshed after every commit; events always run against committed state.
  const actionsRef = useRef<RowActions | null>(null)
  useEffect(() => {
    actionsRef.current = {
      openFile: path => {
        session.dismiss()
        revealRef.current = null
        setSelectedPath(path)
        props.onOpenFile(path)
      },
      toggleDir: path => {
        session.dismiss()
        revealRef.current = null
        setSelectedPath(path)
        props.onToggleDir(path)
      },
      contextMenu: (entry, depth, expanded, event) => {
        const dir = entry.is_dir ? entry.path : parentDir(entry.path)
        if (!dir) return
        event.preventDefault()
        session.dismiss()
        // A reveal still waiting for refreshed rows must not steal focus
        // after the user moved on to another row.
        revealRef.current = null
        setMenu({
          entry,
          dir,
          depth: entry.is_dir ? depth + 1 : depth,
          expandDir: entry.is_dir && !expanded,
          x: event.clientX,
          y: event.clientY,
        })
      },
    }
  })
  const rowActions = useMemo<RowActions>(() => ({
    openFile: path => actionsRef.current?.openFile(path),
    toggleDir: path => actionsRef.current?.toggleDir(path),
    contextMenu: (entry, depth, expanded, event) =>
      actionsRef.current?.contextMenu(entry, depth, expanded, event),
  }), [])

  useEffect(() => () => { focusPathRef.current = null }, [])

  // Escape restores focus to the originating row after the edit closes. The
  // effect also runs when rows arrive, so a row revealed by an expansion is
  // focusable without racing the render.
  useEffect(() => {
    if (edit || !focusPathRef.current) return
    const path = focusPathRef.current
    focusPathRef.current = null
    const row = findRow(scrollRef.current, path)
    if (row) row.focus({ preventScroll: true })
    else if (samePath(path, props.folder)) scrollRef.current?.focus({ preventScroll: true })
  }, [edit, props.rows, props.folder])

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
    const index = props.rows.findIndex(row => samePath(row.entry.path, props.activePath!))
    if (index < 0) return
    const rowTop = index * ROW_HEIGHT
    if (rowTop < el.scrollTop || rowTop + ROW_HEIGHT > el.scrollTop + el.clientHeight) {
      el.scrollTop = rowTop
    }
    scrolledToRef.current = props.activePath
  }, [props.activePath, props.rows])

  // Reveal a just-created node: scroll it into the window, then focus it on the
  // next pass (the row did not exist in the committed DOM when scrolling was
  // requested). File creation leaves focus to the editor.
  useEffect(() => {
    const reveal = revealRef.current
    if (!reveal) return
    const index = props.rows.findIndex(row => samePath(row.entry.path, reveal.path))
    if (index < 0) return
    const el = scrollRef.current
    if (!el) { revealRef.current = null; return }
    const rowTop = index * ROW_HEIGHT
    const rowBottom = rowTop + ROW_HEIGHT
    const row = findRow(el, reveal.path)
    if (row) {
      if (rowTop < el.scrollTop) {
        el.scrollTop = rowTop
        setScrollTop(rowTop)
      } else if (rowBottom > el.scrollTop + el.clientHeight) {
        el.scrollTop = rowTop
        setScrollTop(rowTop)
      }
      if (reveal.focus) row.focus({ preventScroll: true })
      revealRef.current = null
      return
    }
    // Not in the rendered window yet: scroll and let the state update render it.
    if (scrollTop !== rowTop) {
      el.scrollTop = rowTop
      setScrollTop(rowTop)
    } else {
      // Already at the target offset but not rendered: never leave a stale
      // request that would steal focus after an unrelated scroll.
      revealRef.current = null
    }
    // `edit` is a trigger, not a read: the committed rows and the create
    // callback can land in either order, and closing the session must give
    // the reveal effect one more pass even when rows already matched.
  }, [props.rows, scrollTop, edit])

  // Drop the tree cursor once the selected node is gone for real (collapsing
  // an ancestor only hides it, mirroring the rename-draft rule). A node that
  // was just created is selected before the refreshed rows arrive, so the
  // pending reveal keeps its selection alive across those stale rows.
  useEffect(() => {
    if (!selectedPath) return
    if (props.rows.some(row => samePath(row.entry.path, selectedPath))) return
    const reveal = revealRef.current
    if (reveal && samePath(reveal.path, selectedPath)) return
    const hidden = props.rows.some(row =>
      row.entry.is_dir && !row.expanded && pathWithinDir(selectedPath, row.entry.path))
    if (!hidden) setSelectedPath(null)
  }, [props.rows, selectedPath])

  // Depends only on the target directory, not the draft text: keying this on
  // `edit` would rescan the visible rows on every keystroke.
  const draftDir = edit && edit.kind !== "rename" ? edit.dir : null
  const draftIndex = useMemo(
    () => (draftDir === null ? -1 : draftRowIndex(props.rows, draftDir, props.folder)),
    [props.rows, draftDir, props.folder],
  )
  const rowCount = props.rows.length + (draftIndex >= 0 ? 1 : 0)
  const { start, end } = visibleRowRange(rowCount, viewportH, scrollTop)

  // A draft appended after a long folder's children can start outside the
  // virtual window. The row below stays mounted anyway (so the input keeps
  // focus), and this effect scrolls it into view whenever its slot moves.
  useEffect(() => {
    const el = scrollRef.current
    if (!el || draftIndex < 0) return
    const rowTop = draftIndex * ROW_HEIGHT
    const rowBottom = rowTop + ROW_HEIGHT
    if (rowTop < el.scrollTop) {
      el.scrollTop = rowTop
      setScrollTop(rowTop)
    } else if (el.clientHeight > 0 && rowBottom > el.scrollTop + el.clientHeight) {
      const next = rowBottom - el.clientHeight
      el.scrollTop = next
      setScrollTop(next)
    }
  }, [edit?.id, draftIndex])

  // Window rows plus the draft slot; the draft is rendered even when the
  // window does not cover it, so the edit input is never unmounted mid-create.
  const displayIndexes: number[] = []
  for (let index = start; index < end; index += 1) displayIndexes.push(index)
  if (draftIndex >= 0 && (draftIndex < start || draftIndex >= end)) {
    displayIndexes.push(draftIndex)
    displayIndexes.sort((a, b) => a - b)
  }

  const openMenu = (state: Omit<TreeMenuState, "x" | "y">, event: MouseEvent) => {
    event.preventDefault()
    session.dismiss()
    setMenu({ ...state, x: event.clientX, y: event.clientY })
  }

  const startCreate = (kind: CreateKind, target: TreeMenuState) => {
    setMenu(null)
    revealRef.current = null
    if (target.expandDir) props.onToggleDir(target.dir)
    session.beginCreate(kind, target.dir, target.depth)
  }

  return (
    <div
      ref={scrollRef}
      className="filetree-tree"
      role="tree"
      tabIndex={-1}
      aria-label={props.title}
      onContextMenu={event => {
        if (event.defaultPrevented) return
        openMenu({ entry: null, dir: props.folder, depth: 0, expandDir: false }, event)
      }}
      onScroll={event => {
        setScrollTop(event.currentTarget.scrollTop)
        if (menu) setMenu(null)
      }}
    >
      <div style={{ height: rowCount * ROW_HEIGHT, position: "relative" }}>
        {displayIndexes.map(index => {
          if (index === draftIndex && edit) {
            return (
              <div key="__draft__" style={absoluteRowStyle(index)}>
                <TreeEditRow
                  edit={edit}
                  depth={edit.depth}
                  isDirectory={edit.kind === "create-folder"}
                  expanded={false}
                  feedbackId={feedbackId}
                  onChange={session.changeDraft}
                  onSubmit={() => void session.submit()}
                  onCancel={() => session.cancel(true)}
                  onBlur={() => session.cancel(false)}
                />
              </div>
            )
          }
          const rowIndex = draftIndex >= 0 && index >= draftIndex ? index - 1 : index
          const row = props.rows[rowIndex]
          if (!row) return null
          const editing = edit?.kind === "rename" && edit.entry !== null
            && samePath(edit.entry.path, row.entry.path)
          return (
            <div key={row.entry.path} style={absoluteRowStyle(index)}>
              {editing && edit ? (
                <TreeEditRow
                  edit={edit}
                  depth={row.depth}
                  isDirectory={row.entry.is_dir}
                  expanded={row.expanded}
                  feedbackId={feedbackId}
                  onChange={session.changeDraft}
                  onSubmit={() => void session.submit()}
                  onCancel={() => session.cancel(true)}
                  onBlur={() => session.cancel(false)}
                />
              ) : (
                <TreeRow
                  row={row}
                  active={props.activePath !== null && samePath(row.entry.path, props.activePath)}
                  selected={selectedPath !== null && samePath(row.entry.path, selectedPath)}
                  actions={rowActions}
                />
              )}
            </div>
          )
        })}
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
            disabled={!props.onCreateFile || edit?.submitting}
            onSelect={() => startCreate("create-file", menu)}
          />
          <MenuItem
            label={t("filetree.menu.newFolder")}
            disabled={!props.onCreateFolder || edit?.submitting}
            onSelect={() => startCreate("create-folder", menu)}
          />
          {menu.entry ? (
            <>
              <MenuItem
                label={t("filetree.menu.rename")}
                disabled={!props.onRename || edit?.submitting}
                onSelect={() => {
                  const entry = menu.entry
                  setMenu(null)
                  if (entry) session.beginRename(entry)
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
      <div
        id={feedbackId}
        role={edit || session.notice ? "status" : undefined}
        aria-live="polite"
        className={`filetree-edit-feedback${edit?.error || session.notice ? " is-error" : ""}`}
      >
        {feedbackText(edit, session.notice, t)}
      </div>
    </div>
  )
}

function absoluteRowStyle(index: number): CSSProperties {
  return {
    position: "absolute",
    top: index * ROW_HEIGHT,
    left: 0,
    right: 0,
    height: ROW_HEIGHT,
  }
}

function findRow(container: HTMLElement | null, path: string): HTMLButtonElement | null {
  if (!container) return null
  const rows = container.querySelectorAll<HTMLButtonElement>("[data-tree-path]")
  for (const row of rows) {
    if (row.dataset.treePath && samePath(row.dataset.treePath, path)) return row
  }
  return null
}

function feedbackText(
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

function MenuItem(props: { label: string; onSelect: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={props.disabled}
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
 * Rows are memoized on entry/depth/expanded/active/selected so an unrelated
 * App re-render (e.g. every keystroke) skips rows whose data did not change.
 * `actions` is a stable object that reads the latest committed callbacks, so
 * excluding it from re-render decisions does not freeze stale behavior.
 */
const TreeRow = memo(function TreeRow(props: {
  row: VisibleRow
  active: boolean
  selected: boolean
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
      className={className}
      data-tree-path={entry.path}
      style={{ paddingLeft: ROW_INSET + depth * DEPTH_INDENT }}
      aria-expanded={entry.is_dir ? expanded : undefined}
      aria-current={props.active ? "page" : undefined}
      onClick={() => entry.is_dir
        ? props.actions.toggleDir(entry.path)
        : props.actions.openFile(entry.path)}
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
  prev.selected === next.selected,
)
