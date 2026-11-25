import { Facet } from "@codemirror/state"

export const INSPECT_POINTER_DRIFT_PX = 4

export type MediaInspectTarget =
  | {
      readonly kind: "image"
      readonly src: string
      readonly resolvedSrc: string
      readonly alt: string
      readonly title: string | null
      readonly editSource?: () => void
    }
  | {
      readonly kind: "mermaid"
      readonly source: string
      readonly editSource?: () => void
    }

export type MediaInspectHandler = (target: MediaInspectTarget) => void

/**
 * Host-injected callback for inspecting rendered images and Mermaid diagrams
 * (full-screen lightbox with zoom/pan). Null when the host does not mount a
 * lightbox, preserving default click-to-edit-source behavior.
 */
export const mediaInspectHandler = Facet.define<
  MediaInspectHandler | null,
  MediaInspectHandler | null
>({
  combine: values => values[values.length - 1] ?? null,
})

/** Plain primary-button click (no modifiers) opens media inspection; Alt/Shift/Mod clicks pass through. */
export function isInspectPointerEvent(event: MouseEvent): boolean {
  return event.button === 0
    && !event.altKey
    && !event.ctrlKey
    && !event.metaKey
    && !event.shiftKey
}

/**
 * Confirm click intent on pointer release rather than mousedown:
 * prevents premature modal pop on drag-selection or accidental press, and lets
 * the user cancel by dragging away (> INSPECT_POINTER_DRIFT_PX) before release.
 */
export function trackInspectClick(downEvent: MouseEvent, onConfirm: () => void): void {
  const startX = downEvent.clientX
  const startY = downEvent.clientY
  const cleanup = () => {
    window.removeEventListener("mouseup", handleUp, true)
    window.removeEventListener("blur", cleanup)
  }
  const handleUp = (upEvent: MouseEvent) => {
    cleanup()
    if (upEvent.button !== 0) return
    if (Math.hypot(upEvent.clientX - startX, upEvent.clientY - startY) > INSPECT_POINTER_DRIFT_PX) {
      return
    }
    onConfirm()
  }
  window.addEventListener("mouseup", handleUp, true)
  window.addEventListener("blur", cleanup)
}
