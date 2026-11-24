import { useEffect, useRef, useState, type RefObject, type UIEvent } from "react"
import { ROW_HEIGHT, visibleRowRange, type VisibleRow } from "./fileTreeState"
import { samePath } from "./workspace"
import { findTreeRow } from "./FileTreeRow"

/**
 * Virtualization viewport plus the imperative focus/scroll plumbing the tree
 * pattern needs.
 *
 * Rows are absolutely positioned in a spacer sized to the full list, so only
 * the rows intersecting the scroll viewport (plus overscan) exist in the DOM.
 * Keyboard focus therefore has two steps: scroll the target into the rendered
 * window, then focus its button once that window actually commits.
 */
export interface RevealRequest {
  readonly path: string
  /** Folder creation moves row focus; file creation focuses the editor. */
  readonly focus: boolean
}

export interface FileTreeScrollOptions {
  readonly rows: readonly VisibleRow[]
  readonly activePath: string | null
  /** Display slot of an open create draft, or -1 when there is none. */
  readonly draftIndex: number
  /** Open edit session identity: a change re-runs the reveal pass. */
  readonly editToken: number | null
  readonly revealRef: RefObject<RevealRequest | null>
}

export interface FileTreeScroll {
  readonly scrollRef: RefObject<HTMLDivElement | null>
  readonly rowCount: number
  readonly windowStart: number
  readonly windowEnd: number
  revealRow(index: number): void
  requestRowFocus(path: string): void
  handleScroll(event: UIEvent<HTMLDivElement>): void
}

export function useFileTreeScroll(options: FileTreeScrollOptions): FileTreeScroll {
  const { rows, activePath, draftIndex, editToken, revealRef } = options
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportH, setViewportH] = useState(0)
  // Arrow-key focus needs the virtual window to render the target row first.
  const focusRequestRef = useRef<string | null>(null)
  const [focusRequestId, setFocusRequestId] = useState(0)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const observer = new ResizeObserver(() => setViewportH(el.clientHeight))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useEffect(() => () => { focusRequestRef.current = null }, [])

  const revealRow = (index: number) => {
    const el = scrollRef.current
    if (!el) return
    const rowTop = index * ROW_HEIGHT
    const rowBottom = rowTop + ROW_HEIGHT
    if (rowTop < el.scrollTop) el.scrollTop = rowTop
    else if (el.clientHeight > 0 && rowBottom > el.scrollTop + el.clientHeight) {
      el.scrollTop = rowBottom - el.clientHeight
    }
    // Keep the React window in step even when the browser suppresses the event
    // (a programmatic scroll that did not move).
    setScrollTop(el.scrollTop)
  }

  const requestRowFocus = (path: string) => {
    focusRequestRef.current = path
    setFocusRequestId(id => id + 1)
  }

  // Focus lands once the requested row is actually rendered: scrolling may have
  // changed the virtual window in this same commit.
  useEffect(() => {
    const path = focusRequestRef.current
    if (!path) return
    const row = findTreeRow(scrollRef.current, path)
    if (!row) return
    focusRequestRef.current = null
    row.focus({ preventScroll: true })
  }, [focusRequestId, scrollTop, viewportH, rows])

  // Keep the active file visible. Runs again once rows arrive after an
  // auto-reveal expansion; the per-path guard stops it from fighting the user.
  const scrolledToRef = useRef<string | null>(null)
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !activePath || scrolledToRef.current === activePath) return
    const index = rows.findIndex(row => samePath(row.entry.path, activePath))
    if (index < 0) return
    const rowTop = index * ROW_HEIGHT
    if (rowTop < el.scrollTop || rowTop + ROW_HEIGHT > el.scrollTop + el.clientHeight) {
      el.scrollTop = rowTop
    }
    scrolledToRef.current = activePath
  }, [activePath, rows])

  // Reveal a just-created node: scroll it into the window, then focus it on the
  // next pass (the row did not exist in the committed DOM when scrolling was
  // requested). File creation leaves focus to the editor.
  useEffect(() => {
    const reveal = revealRef.current
    if (!reveal) return
    const index = rows.findIndex(row => samePath(row.entry.path, reveal.path))
    if (index < 0) return
    const el = scrollRef.current
    if (!el) { revealRef.current = null; return }
    const rowTop = index * ROW_HEIGHT
    const rowBottom = rowTop + ROW_HEIGHT
    const row = findTreeRow(el, reveal.path)
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
    // `editToken` is a trigger, not a read: the committed rows and the create
    // callback can land in either order, and closing the session must give
    // the reveal effect one more pass even when rows already matched.
  }, [rows, scrollTop, editToken, revealRef])

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
  }, [draftIndex, editToken])

  const rowCount = rows.length + (draftIndex >= 0 ? 1 : 0)
  const { start, end } = visibleRowRange(rowCount, viewportH, scrollTop)

  return {
    scrollRef,
    rowCount,
    windowStart: start,
    windowEnd: end,
    revealRow,
    requestRowFocus,
    handleScroll: event => setScrollTop(event.currentTarget.scrollTop),
  }
}
