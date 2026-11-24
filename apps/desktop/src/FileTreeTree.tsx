import {
  useEffect, useId, useMemo, useRef, useState, type KeyboardEvent,
} from "react"
import { createPortal } from "react-dom"
import {
  ROW_HEIGHT, draftRowIndex,
  type CreateKind, type VisibleRow,
} from "./fileTreeState"
import { parentDir, pathWithinDir, samePath } from "./workspace"
import { useT } from "./i18n"
import { TreeEditRow } from "./TreeEditRow"
import { useTreeEditSession } from "./useTreeEditSession"
import { FileTreeContextMenu, type FileTreeMenuItem } from "./FileTreeContextMenu"
import { treeKeyIntent, type TreeKeyInput } from "./fileTreeKeyboard"
import { useFileTreeScroll, type RevealRequest } from "./useFileTreeScroll"
import {
  TreeRow, absoluteRowStyle, findTreeRow, rowFeedbackText, rowPathFromTarget,
  type RowActions,
} from "./FileTreeRow"

interface TreeMenuState {
  readonly entry: VisibleRow["entry"] | null
  readonly dir: string
  readonly depth: number
  /** The context menu opened on a collapsed directory; creating expands it. */
  readonly expandDir: boolean
  readonly x: number
  readonly y: number
  /** Row that opened the menu; Escape hands focus back to it. */
  readonly returnPath: string | null
}

/** Keyboard-opened menus anchor to the row's lower-left corner, not the pointer. */
const KEYBOARD_MENU_ANCHOR_X_PX = 16
const KEYBOARD_MENU_ANCHOR_Y_PX = 2

/**
 * Virtualized tree body: only the rows intersecting the scroll viewport (plus
 * an overscan margin) are in the DOM, positioned absolutely inside a spacer
 * sized to the full row count. Row height is fixed (`ROW_HEIGHT`) so the
 * viewport window can be derived from scrollTop without measuring each row.
 *
 * A create draft is an extra display slot derived from `draftRowIndex`; entry
 * indexes shift by one after it, so the virtual window stays O(viewport).
 *
 * WAI-ARIA tree pattern: rows are `role="treeitem"` with roving `tabindex`,
 * `aria-level`/`aria-expanded`/`aria-selected`, arrow-key navigation, and
 * Shift+F10 / ContextMenu for the row menu.
 */
export function FileTreeTree(props: {
  folder: string
  rows: VisibleRow[]
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
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [focusedPath, setFocusedPath] = useState<string | null>(null)
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

  // Depends only on the target directory, not the draft text: keying this on
  // `edit` would rescan the visible rows on every keystroke.
  const draftDir = edit && edit.kind !== "rename" ? edit.dir : null
  const draftIndex = useMemo(
    () => (draftDir === null ? -1 : draftRowIndex(props.rows, draftDir, props.folder)),
    [props.rows, draftDir, props.folder],
  )

  const { scrollRef, rowCount, windowStart, windowEnd, revealRow, requestRowFocus, handleScroll } =
    useFileTreeScroll({
      rows: props.rows,
      activePath: props.activePath,
      draftIndex,
      editToken: edit?.id ?? null,
      revealRef,
    })

  const openMenu = (state: TreeMenuState) => {
    session.dismiss()
    // A reveal still waiting for refreshed rows must not steal focus after the
    // user moved on to the row menu.
    revealRef.current = null
    setMenu(state)
  }

  // Row handlers are stable so memoized rows are not invalidated by App
  // re-renders, but they must invoke the latest callbacks. The actions object
  // is refreshed after every commit; events always run against committed state.
  const actionsRef = useRef<RowActions | null>(null)
  useEffect(() => {
    actionsRef.current = {
      focus: path => setFocusedPath(path),
      openFile: path => {
        session.dismiss()
        revealRef.current = null
        setFocusedPath(path)
        setSelectedPath(path)
        props.onOpenFile(path)
      },
      toggleDir: path => {
        session.dismiss()
        revealRef.current = null
        setFocusedPath(path)
        setSelectedPath(path)
        props.onToggleDir(path)
      },
      contextMenu: (entry, depth, expanded, event) => {
        const dir = entry.is_dir ? entry.path : parentDir(entry.path)
        if (!dir) return
        event.preventDefault()
        setFocusedPath(entry.path)
        openMenu({
          entry,
          dir,
          depth: entry.is_dir ? depth + 1 : depth,
          expandDir: entry.is_dir && !expanded,
          x: event.clientX,
          y: event.clientY,
          returnPath: entry.path,
        })
      },
    }
  })
  const rowActions = useMemo<RowActions>(() => ({
    focus: path => actionsRef.current?.focus(path),
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
    const row = findTreeRow(scrollRef.current, path)
    if (row) row.focus({ preventScroll: true })
    else if (samePath(path, props.folder)) scrollRef.current?.focus({ preventScroll: true })
  }, [edit, props.rows, props.folder, scrollRef])

  // Roving tabindex target. A path that left the visible rows (collapsed
  // ancestor, deleted node) falls back to the active file, then to the first
  // row, so the tree always has exactly one tab stop.
  const effectiveFocusedPath = useMemo(() => {
    const exists = (path: string | null) =>
      path !== null && props.rows.some(row => samePath(row.entry.path, path))
    if (exists(focusedPath)) return focusedPath
    if (exists(props.activePath)) return props.activePath
    return props.rows[0]?.entry.path ?? null
  }, [focusedPath, props.activePath, props.rows])

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

  const focusRowAt = (index: number) => {
    const row = props.rows[index]
    if (!row) return
    setFocusedPath(row.entry.path)
    revealRow(index)
    requestRowFocus(row.entry.path)
  }

  const openMenuAt = (index: number) => {
    const row = props.rows[index]
    if (!row) return
    const dir = row.entry.is_dir ? row.entry.path : parentDir(row.entry.path)
    if (!dir) return
    const rect = findTreeRow(scrollRef.current, row.entry.path)?.getBoundingClientRect()
    setFocusedPath(row.entry.path)
    openMenu({
      entry: row.entry,
      dir,
      depth: row.entry.is_dir ? row.depth + 1 : row.depth,
      expandDir: row.entry.is_dir && !row.expanded,
      x: (rect?.left ?? 0) + KEYBOARD_MENU_ANCHOR_X_PX,
      y: (rect?.bottom ?? 0) + KEYBOARD_MENU_ANCHOR_Y_PX,
      returnPath: row.entry.path,
    })
  }

  const handleTreeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // An open menu and the inline create/rename input own their keys.
    if (menu || edit) return
    const input: TreeKeyInput = {
      key: event.key,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      isComposing: event.nativeEvent.isComposing,
      keyCode: event.keyCode,
    }
    // The event target wins over the roving state: a pointer-focused row is
    // the row the user is acting on even before the next render moves the stop.
    const intent = treeKeyIntent(
      input,
      props.rows,
      rowPathFromTarget(event.target) ?? effectiveFocusedPath,
    )
    if (!intent) return
    event.preventDefault()
    switch (intent.kind) {
      case "focus":
        focusRowAt(intent.index)
        return
      case "toggle":
        setFocusedPath(intent.path)
        props.onToggleDir(intent.path)
        return
      case "open":
        actionsRef.current?.openFile(intent.path)
        return
      case "contextMenu":
        openMenuAt(intent.index)
    }
  }

  // Window rows plus the draft slot; the draft is rendered even when the
  // window does not cover it, so the edit input is never unmounted mid-create.
  const displayIndexes: number[] = []
  for (let index = windowStart; index < windowEnd; index += 1) displayIndexes.push(index)
  if (draftIndex >= 0 && (draftIndex < windowStart || draftIndex >= windowEnd)) {
    displayIndexes.push(draftIndex)
    displayIndexes.sort((a, b) => a - b)
  }

  const startCreate = (kind: CreateKind, target: TreeMenuState) => {
    setMenu(null)
    revealRef.current = null
    if (target.expandDir) props.onToggleDir(target.dir)
    session.beginCreate(kind, target.dir, target.depth)
  }

  const closeMenu = (restoreFocus: boolean) => {
    const returnPath = menu?.returnPath ?? null
    setMenu(null)
    if (restoreFocus && returnPath) requestRowFocus(returnPath)
  }

  const menuItems = (target: TreeMenuState): FileTreeMenuItem[] => [
    {
      label: t("filetree.menu.newFile"),
      disabled: !props.onCreateFile || edit?.submitting,
      onSelect: () => startCreate("create-file", target),
    },
    {
      label: t("filetree.menu.newFolder"),
      disabled: !props.onCreateFolder || edit?.submitting,
      onSelect: () => startCreate("create-folder", target),
    },
    ...(target.entry ? [
      {
        label: t("filetree.menu.rename"),
        disabled: !props.onRename || edit?.submitting,
        onSelect: () => {
          const entry = target.entry
          setMenu(null)
          if (entry) session.beginRename(entry)
        },
      },
      {
        label: t("filetree.menu.delete"),
        onSelect: () => {
          const entry = target.entry
          setMenu(null)
          if (entry) props.onDelete?.(entry)
        },
      },
    ] : []),
    {
      label: t("filetree.menu.reveal"),
      onSelect: () => {
        setMenu(null)
        props.onReveal?.(target.entry?.path ?? props.folder)
      },
    },
  ]

  return (
    <div
      ref={scrollRef}
      className="filetree-tree"
      role="tree"
      tabIndex={-1}
      aria-label={t("sidebar.files")}
      onKeyDown={handleTreeKeyDown}
      onContextMenu={event => {
        if (event.defaultPrevented) return
        event.preventDefault()
        openMenu({
          entry: null,
          dir: props.folder,
          depth: 0,
          expandDir: false,
          x: event.clientX,
          y: event.clientY,
          returnPath: null,
        })
      }}
      onScroll={event => {
        handleScroll(event)
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
                  focusable={effectiveFocusedPath !== null
                    && samePath(row.entry.path, effectiveFocusedPath)}
                  actions={rowActions}
                />
              )}
            </div>
          )
        })}
      </div>
      {/* Portalled: a `role=tree` may only contain treeitems/groups, and the
          menu must not inherit the tree's key handling. */}
      {menu
        ? createPortal(
          <FileTreeContextMenu
            label={menu.entry
              ? t("filetree.aria.entryActions", { name: menu.entry.name })
              : t("filetree.aria.folderActions")}
            x={menu.x}
            y={menu.y}
            items={menuItems(menu)}
            onClose={closeMenu}
          />,
          document.body,
        )
        : null}
      <div
        id={feedbackId}
        role={edit || session.notice ? "status" : undefined}
        aria-live="polite"
        className={`filetree-edit-feedback${edit?.error || session.notice ? " is-error" : ""}`}
      >
        {rowFeedbackText(edit, session.notice, t)}
      </div>
    </div>
  )
}
