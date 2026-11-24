import { useEffect, useRef, type ReactNode, type RefObject } from "react"

/**
 * Modal primitive shared by every overlay (settings, about, version history,
 * command palette, quick open).
 *
 * Three things only this component owns:
 * - **Focus lifecycle:** the opener is recorded on open, initial focus moves
 *   into the dialog, and closing (or unmounting) hands focus back to the
 *   element that opened it. Re-renders while open never steal focus again.
 * - **Tab trap:** Tab / Shift+Tab cycle inside the dialog. Rows rendered with
 *   `tabindex="-1"` (palette options) are skipped, so the trap never walks 200
 *   command rows.
 * - **Background inertness:** the shell regions (`.topbar`, `.workspace-body`)
 *   become `inert` while any dialog is open, so pointer and screen-reader
 *   navigation cannot reach the document behind the overlay.
 */
export interface DialogProps {
  readonly isOpen: boolean
  readonly onClose: () => void
  readonly ariaLabel?: string
  readonly ariaLabelledBy?: string
  readonly backdropClassName?: string
  readonly className: string
  readonly initialFocusRef?: RefObject<HTMLElement | null>
  readonly children: ReactNode
}

/**
 * Focusable candidates inside a dialog. Every clause excludes `tabindex="-1"`
 * explicitly: the selector list is OR-ed, so `button:not(:disabled)` alone
 * would put the palette's roving options back into the Tab cycle.
 */
const FOCUSABLE_SELECTOR = [
  'a[href]:not([tabindex="-1"])',
  'button:not(:disabled):not([tabindex="-1"])',
  'input:not(:disabled):not([tabindex="-1"])',
  'select:not(:disabled):not([tabindex="-1"])',
  'textarea:not(:disabled):not([tabindex="-1"])',
  '[tabindex]:not([tabindex="-1"])',
].join(", ")

/** Shell regions that must stop accepting input while a modal is open. */
const MODAL_BACKGROUND_SELECTOR = ".workspace-body, .topbar"
/** Marks the `inert` attribute we added, so foreign ones are never cleared. */
const MODAL_INERT_MARKER = "data-modal-inert"
/** Chrome/WebKit keyCode reported for keys that commit an IME composition. */
const IME_COMPOSING_KEYCODE = 229

let openDialogCount = 0
/** Open dialogs, topmost last: only the topmost one traps Tab/Escape. */
const dialogStack: HTMLElement[] = []

/** True while at least one `Dialog` is open (used by the global shortcut guard). */
export function isAnyModalOpen(): boolean {
  return openDialogCount > 0
}

function setBackgroundInert(inert: boolean): void {
  if (typeof document === "undefined") return
  for (const element of document.querySelectorAll<HTMLElement>(MODAL_BACKGROUND_SELECTOR)) {
    if (inert) {
      element.setAttribute(MODAL_INERT_MARKER, "true")
      // Set both the property and the attribute: the property is the API, the
      // attribute is what a test environment without layout support reflects.
      element.inert = true
      element.setAttribute("inert", "")
      continue
    }
    if (!element.hasAttribute(MODAL_INERT_MARKER)) continue
    element.removeAttribute(MODAL_INERT_MARKER)
    element.removeAttribute("inert")
    element.inert = false
  }
}

function registerDialog(dialog: HTMLElement): void {
  openDialogCount += 1
  dialogStack.push(dialog)
  if (openDialogCount === 1) setBackgroundInert(true)
}

function unregisterDialog(dialog: HTMLElement): void {
  const index = dialogStack.indexOf(dialog)
  if (index >= 0) dialogStack.splice(index, 1)
  openDialogCount = Math.max(0, openDialogCount - 1)
  if (openDialogCount === 0) setBackgroundInert(false)
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
}

function focusInitial(
  dialog: HTMLElement,
  initialFocusRef: RefObject<HTMLElement | null> | undefined,
): void {
  const target = initialFocusRef?.current
    ?? dialog.querySelector<HTMLElement>("[autofocus]")
    ?? focusableElements(dialog)[0]
  target?.focus()
}

function trapTab(dialog: HTMLElement, event: KeyboardEvent): void {
  const focusables = focusableElements(dialog)
  if (focusables.length === 0) {
    event.preventDefault()
    return
  }
  const first = focusables[0]
  const last = focusables[focusables.length - 1]
  const active = document.activeElement
  const inside = active instanceof HTMLElement && dialog.contains(active)
  if (event.shiftKey) {
    if (inside && active !== first) return
    event.preventDefault()
    last?.focus()
    return
  }
  if (inside && active !== last) return
  event.preventDefault()
  first?.focus()
}

export function Dialog(props: DialogProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const openerRef = useRef<HTMLElement | null>(null)
  // Read through a ref so the keydown listener registers once per open/close
  // transition instead of once per parent render.
  const onCloseRef = useRef(props.onClose)
  onCloseRef.current = props.onClose
  const { isOpen, initialFocusRef } = props

  useEffect(() => {
    if (!isOpen) return
    const dialog = dialogRef.current
    if (!dialog) return
    openerRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    registerDialog(dialog)
    focusInitial(dialog, initialFocusRef)

    const handleKeyDown = (event: KeyboardEvent) => {
      // A nested control (e.g. the font picker popover) already consumed it.
      if (event.defaultPrevented) return
      if (event.isComposing || event.keyCode === IME_COMPOSING_KEYCODE) return
      if (dialogStack[dialogStack.length - 1] !== dialog) return
      if (event.key === "Escape") {
        event.preventDefault()
        event.stopPropagation()
        onCloseRef.current()
        return
      }
      if (event.key === "Tab") trapTab(dialog, event)
    }
    document.addEventListener("keydown", handleKeyDown)
    return () => {
      document.removeEventListener("keydown", handleKeyDown)
      unregisterDialog(dialog)
      const opener = openerRef.current
      openerRef.current = null
      if (!opener?.isConnected) return
      opener.focus()
      // Chromium resolves `inert` during style recalculation, so the focus call
      // above can be dropped in the very frame that clears it (the opener in the
      // topbar or the sidebar is inside an inert region). Retry once the frame
      // has committed; a detached or still-inert opener is left alone.
      if (document.activeElement === opener) return
      if (typeof requestAnimationFrame !== "function") return
      requestAnimationFrame(() => {
        if (opener.isConnected && opener.closest("[inert]") === null) opener.focus()
      })
    }
  }, [isOpen, initialFocusRef])

  if (!isOpen) return null

  return (
    <div className={props.backdropClassName ?? "modal-backdrop"} onClick={props.onClose}>
      <div
        ref={dialogRef}
        className={props.className}
        role="dialog"
        aria-modal="true"
        aria-label={props.ariaLabel}
        aria-labelledby={props.ariaLabelledBy}
        onClick={event => event.stopPropagation()}
      >
        {props.children}
      </div>
    </div>
  )
}
