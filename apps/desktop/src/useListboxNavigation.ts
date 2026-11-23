import { useEffect, useMemo, useState, type KeyboardEvent } from "react"

/** Chrome/Safari keyCode reported for keys that commit an IME composition. */
const IME_COMPOSING_KEYCODE = 229

export interface ListboxNavigationOptions {
  readonly count: number
  /** Resets the active row when the filtered result set changes. */
  readonly resetKey: string
  readonly onChoose: (index: number) => void
  readonly onClose: () => void
  readonly itemId: (index: number) => string
}

/**
 * Keyboard/ARIA state shared by the command palette and quick open. The input
 * owns focus; rows are announced through aria-activedescendant.
 */
export function useListboxNavigation(options: ListboxNavigationOptions) {
  const [active, setActive] = useState(0)
  const { count, resetKey, onChoose, onClose } = options

  useEffect(() => {
    setActive(0)
  }, [resetKey, count])

  const bounded = useMemo(
    () => Math.max(0, Math.min(active, Math.max(0, count - 1))),
    [active, count],
  )

  const activeId = count > 0 ? options.itemId(bounded) : undefined

  // Rows are not focusable (tabIndex=-1), so the active row must be brought into
  // view imperatively; `nearest` keeps an already-visible list from jumping.
  useEffect(() => {
    if (activeId === undefined || typeof document === "undefined") return
    document.getElementById(activeId)?.scrollIntoView?.({ block: "nearest" })
  }, [activeId])

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    // Enter that commits (or cancels) an IME composition must reach the input:
    // running the active row here would execute a command mid-composition.
    if (event.nativeEvent.isComposing || event.keyCode === IME_COMPOSING_KEYCODE) return
    if (event.key === "Escape") {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key === "ArrowDown") {
      event.preventDefault()
      setActive(value => Math.min(value + 1, Math.max(0, count - 1)))
      return
    }
    if (event.key === "ArrowUp") {
      event.preventDefault()
      setActive(value => Math.max(value - 1, 0))
      return
    }
    if (event.key === "Home") {
      event.preventDefault()
      setActive(0)
      return
    }
    if (event.key === "End") {
      event.preventDefault()
      setActive(Math.max(0, count - 1))
      return
    }
    if (event.key === "Enter" && count > 0) {
      event.preventDefault()
      onChoose(bounded)
      onClose()
    }
  }

  return { active: bounded, setActive, activeId, onKeyDown }
}
