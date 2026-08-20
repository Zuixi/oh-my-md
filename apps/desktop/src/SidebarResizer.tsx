import { useEffect, useRef, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react"
import { SIDEBAR_KEYBOARD_STEP, SIDEBAR_MIN_WIDTH } from "./constants"
import { clampSidebarWidth } from "./sidebarResize"
import { useT } from "./i18n"

/** Applied to <body> while dragging so the sidebar's width transition and
 *  text selection never fight the pointer (see styles.css). */
const BODY_RESIZING_CLASS = "omd-resizing-sidebar"

interface DragState {
  pointerId: number
  startX: number
  startWidth: number
  lastWidth: number
}

/**
 * Vertical sash on the file sidebar's edge: drag to resize (pointer-captured),
 * double-click to restore the default width, arrows to resize from the
 * keyboard. Mounted as a flex sibling of the sidebar so it never scrolls with
 * the tree; rendered only while the sidebar is visible.
 */
export function SidebarResizer(props: {
  width: number
  onResize: (px: number) => void
  onCommit: (px: number) => void
  onReset: () => void
}) {
  const dragRef = useRef<DragState | null>(null)
  const t = useT()

  // Collapsing the sidebar (⌘\) unmounts the sash mid-drag; without this the
  // resize-mode body class would outlive the drag (stuck cursor, no width
  // transition).
  useEffect(() => () => {
    document.body.classList.remove(BODY_RESIZING_CLASS)
  }, [])

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    const target = event.currentTarget
    if (typeof target.setPointerCapture === "function") {
      try {
        target.setPointerCapture(event.pointerId)
      } catch { /* capture is best-effort; drag still works over the handle */ }
    }
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: props.width,
      lastWidth: props.width,
    }
    document.body.classList.add(BODY_RESIZING_CLASS)
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    drag.lastWidth = clampSidebarWidth(drag.startWidth + event.clientX - drag.startX, window.innerWidth)
    props.onResize(drag.lastWidth)
  }

  function endDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    document.body.classList.remove(BODY_RESIZING_CLASS)
    const target = event.currentTarget
    if (typeof target.releasePointerCapture === "function") {
      try {
        target.releasePointerCapture(event.pointerId)
      } catch { /* already released by the browser */ }
    }
    props.onCommit(drag.lastWidth)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
    event.preventDefault()
    const delta = event.key === "ArrowLeft" ? -SIDEBAR_KEYBOARD_STEP : SIDEBAR_KEYBOARD_STEP
    const next = clampSidebarWidth(props.width + delta, window.innerWidth)
    props.onResize(next)
    props.onCommit(next)
  }

  return (
    <div
      className="sidebar-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={t("sidebar.aria.resize")}
      aria-valuemin={SIDEBAR_MIN_WIDTH}
      aria-valuenow={Math.round(props.width)}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => props.onReset()}
      onKeyDown={handleKeyDown}
    />
  )
}
