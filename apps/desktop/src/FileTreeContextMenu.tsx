import { Fragment, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react"

/**
 * File-tree context menu: `role="menu"` with roving ArrowUp/ArrowDown focus,
 * Escape to close, and viewport clamping.
 *
 * The menu is rendered `position: fixed` at the pointer (or the focused row's
 * rect). Near a window edge the raw coordinates would push the menu off-screen,
 * so the real box is measured before paint and clamped inside the viewport.
 */

/** Gap kept between the menu and the viewport edge. */
const VIEWPORT_MARGIN_PX = 8
/** Chrome/WebKit keyCode reported for keys that commit an IME composition. */
const IME_COMPOSING_KEYCODE = 229

export interface FileTreeMenuItem {
  readonly label: string
  readonly disabled?: boolean
  readonly danger?: boolean
  readonly separatorBefore?: boolean
  readonly onSelect: () => void
}

export interface FileTreeContextMenuProps {
  readonly label: string
  readonly x: number
  readonly y: number
  readonly items: readonly FileTreeMenuItem[]
  /** `restoreFocus` is true for Escape, which returns the cursor to the row. */
  readonly onClose: (restoreFocus: boolean) => void
}

export function FileTreeContextMenu(props: FileTreeContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [position, setPosition] = useState({ left: props.x, top: props.y })
  // Read through a ref: the outside-pointer listener must not re-register on
  // every parent render while the menu is open.
  const onCloseRef = useRef(props.onClose)
  onCloseRef.current = props.onClose

  useLayoutEffect(() => {
    const rect = menuRef.current?.getBoundingClientRect()
    if (!rect) return
    const left = Math.max(
      VIEWPORT_MARGIN_PX,
      Math.min(props.x, window.innerWidth - rect.width - VIEWPORT_MARGIN_PX),
    )
    const top = Math.max(
      VIEWPORT_MARGIN_PX,
      Math.min(props.y, window.innerHeight - rect.height - VIEWPORT_MARGIN_PX),
    )
    setPosition(current =>
      current.left === left && current.top === top ? current : { left, top })
  }, [props.x, props.y])

  useEffect(() => {
    menuItems(menuRef.current)[0]?.focus()
  }, [])

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return
      onCloseRef.current(false)
    }
    window.addEventListener("mousedown", handlePointerDown)
    return () => window.removeEventListener("mousedown", handlePointerDown)
  }, [])

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // The menu lives inside the tree; its keys must not scroll the tree.
    event.stopPropagation()
    if (event.nativeEvent.isComposing || event.keyCode === IME_COMPOSING_KEYCODE) return
    if (event.key === "Escape") {
      event.preventDefault()
      onCloseRef.current(true)
      return
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
    event.preventDefault()
    const items = menuItems(menuRef.current)
    if (items.length === 0) return
    const currentIndex = items.findIndex(item => item === document.activeElement)
    const step = event.key === "ArrowDown" ? 1 : -1
    const nextIndex = currentIndex < 0
      ? (step > 0 ? 0 : items.length - 1)
      : (currentIndex + step + items.length) % items.length
    items[nextIndex]?.focus()
  }

  return (
    <div
      ref={menuRef}
      role="menu"
      className="filetree-menu"
      aria-label={props.label}
      style={{ top: position.top, left: position.left }}
      onClick={event => event.stopPropagation()}
      onKeyDown={handleKeyDown}
    >
      {props.items.map(item => (
        <Fragment key={item.label}>
          {item.separatorBefore ? (
            <div className="filetree-menu-separator" role="separator" />
          ) : null}
          <button
            type="button"
            role="menuitem"
            className={item.danger ? "filetree-menu-item is-danger" : "filetree-menu-item"}
            disabled={item.disabled}
            onClick={item.onSelect}
          >
            {item.label}
          </button>
        </Fragment>
      ))}
    </div>
  )
}

function menuItems(container: HTMLElement | null): HTMLButtonElement[] {
  if (!container) return []
  return Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'))
}
