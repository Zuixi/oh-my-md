export interface LightboxTransform {
  readonly scale: number
  readonly x: number
  readonly y: number
}

export const LIGHTBOX_MIN_SCALE = 0.25
export const LIGHTBOX_MAX_SCALE = 8
export const LIGHTBOX_ZOOM_STEP = 1.25
export const LIGHTBOX_DOUBLE_CLICK_SCALE = 2
export const LIGHTBOX_WHEEL_SENSITIVITY = 0.002
export const LIGHTBOX_PINCH_SENSITIVITY = 0.01
export const LIGHTBOX_KEY_PAN_PX = 60
export const LIGHTBOX_STAGE_PADDING_PX = 96
export const LIGHTBOX_CLICK_DRAG_THRESHOLD_PX = 4
export const LIGHTBOX_MIN_VISIBLE_PX = 80
/** Line-mode wheel deltas (`deltaMode === 1`) are reported in lines, not pixels. */
export const LIGHTBOX_WHEEL_LINE_PX = 16
/** Notched mouse wheels emit integer pixel deltas of at least this size; finer
 *  or fractional deltas come from trackpads. */
export const LIGHTBOX_MOUSE_WHEEL_MIN_DELTA_PX = 40

export interface BoxSize {
  readonly width: number
  readonly height: number
}

export interface WheelGestureInput {
  readonly deltaX: number
  readonly deltaY: number
  readonly ctrlKey: boolean
  readonly metaKey?: boolean
  readonly deltaMode: number
}

export const IDENTITY_TRANSFORM: LightboxTransform = { scale: 1, x: 0, y: 0 }

export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1
  return Math.min(LIGHTBOX_MAX_SCALE, Math.max(LIGHTBOX_MIN_SCALE, scale))
}

/**
 * Zoom around a focal point expressed in stage-center coordinates so the pixel
 * under the pointer stays anchored while scaling.
 */
export function zoomAtPoint(
  current: LightboxTransform,
  nextScale: number,
  focalX: number,
  focalY: number,
): LightboxTransform {
  const clamped = clampScale(nextScale)
  if (clamped === current.scale) return current
  const ratio = clamped / current.scale
  return {
    scale: clamped,
    x: focalX - (focalX - current.x) * ratio,
    y: focalY - (focalY - current.y) * ratio,
  }
}

export function panBy(current: LightboxTransform, dx: number, dy: number): LightboxTransform {
  if (dx === 0 && dy === 0) return current
  return {
    scale: current.scale,
    x: current.x + dx,
    y: current.y + dy,
  }
}

export function wheelZoomScale(
  currentScale: number,
  deltaY: number,
  sensitivity = LIGHTBOX_WHEEL_SENSITIVITY,
): number {
  const factor = Math.exp(-deltaY * sensitivity)
  return clampScale(currentScale * factor)
}

/**
 * Interpret wheel/trackpad gestures like Figma/Apple Preview:
 * - Trackpad pinch (`ctrlKey`) and `Cmd+scroll` zoom with pinch sensitivity.
 * - Line-mode wheels (`deltaMode !== 0`) zoom, scaled from lines to pixels.
 * - Pixel-mode wheels with an integer, notched-sized vertical delta zoom at the
 *   pointer; that signature never comes from a trackpad.
 * - Everything else pans. A two-finger trackpad swipe reports `deltaX === 0` on
 *   some frames and a tiny `deltaX` on others, so keying zoom purely off
 *   `deltaX === 0` made one continuous swipe oscillate between zoom and pan.
 */
export function applyWheelGesture(
  current: LightboxTransform,
  gesture: WheelGestureInput,
  focalX: number,
  focalY: number,
): LightboxTransform {
  if (gesture.ctrlKey || gesture.metaKey) {
    const dy = gesture.deltaMode === 1 ? gesture.deltaY * LIGHTBOX_WHEEL_LINE_PX : gesture.deltaY
    return zoomAtPoint(
      current,
      wheelZoomScale(current.scale, dy, LIGHTBOX_PINCH_SENSITIVITY),
      focalX,
      focalY,
    )
  }
  if (gesture.deltaMode !== 0) {
    return zoomAtPoint(
      current,
      wheelZoomScale(current.scale, gesture.deltaY * LIGHTBOX_WHEEL_LINE_PX, LIGHTBOX_WHEEL_SENSITIVITY),
      focalX,
      focalY,
    )
  }
  const notchedWheel =
    gesture.deltaX === 0 &&
    Number.isInteger(gesture.deltaY) &&
    Math.abs(gesture.deltaY) >= LIGHTBOX_MOUSE_WHEEL_MIN_DELTA_PX
  if (notchedWheel) {
    return zoomAtPoint(
      current,
      wheelZoomScale(current.scale, gesture.deltaY, LIGHTBOX_WHEEL_SENSITIVITY),
      focalX,
      focalY,
    )
  }
  return panBy(current, -gesture.deltaX, -gesture.deltaY)
}

/**
 * Clamp pan translation so at least `LIGHTBOX_MIN_VISIBLE_PX` of the scaled
 * content remains reachable inside the viewport.
 */
export function clampPan(
  transform: LightboxTransform,
  content: BoxSize | null,
  viewport: BoxSize | null,
): LightboxTransform {
  if (!content || !viewport) return transform
  if (content.width <= 0 || content.height <= 0 || viewport.width <= 0 || viewport.height <= 0) {
    return transform
  }
  const scaledW = content.width * transform.scale
  const scaledH = content.height * transform.scale
  const keepX = Math.min(LIGHTBOX_MIN_VISIBLE_PX, scaledW)
  const keepY = Math.min(LIGHTBOX_MIN_VISIBLE_PX, scaledH)
  const maxX = Math.max(0, viewport.width / 2 + scaledW / 2 - keepX)
  const maxY = Math.max(0, viewport.height / 2 + scaledH / 2 - keepY)
  const x = Math.min(maxX, Math.max(-maxX, transform.x))
  const y = Math.min(maxY, Math.max(-maxY, transform.y))
  if (x === transform.x && y === transform.y) return transform
  return { scale: transform.scale, x, y }
}

/**
 * Compute an initial fit-to-viewport scale. Images default to at most 1x so
 * small screenshots are not upscaled blurry; vector diagrams (Mermaid) may
 * scale up slightly to fill comfortable reading space up to `maxAutoScale`.
 */
export function fitScale(
  contentWidth: number,
  contentHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  maxAutoScale = 1,
): number {
  if (contentWidth <= 0 || contentHeight <= 0) return 1
  const availW = Math.max(1, viewportWidth - LIGHTBOX_STAGE_PADDING_PX)
  const availH = Math.max(1, viewportHeight - LIGHTBOX_STAGE_PADDING_PX)
  const ratio = Math.min(availW / contentWidth, availH / contentHeight, maxAutoScale)
  return clampScale(ratio)
}

function parseSvgLength(raw: string | null): number | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (trimmed.endsWith("%")) return null
  const n = Number.parseFloat(trimmed)
  return Number.isFinite(n) && n > 0 ? n : null
}

function parseViewBoxSize(raw: string | null): BoxSize | null {
  if (!raw) return null
  const parts = raw.trim().split(/[\s,]+/).map(Number)
  if (parts.length !== 4 || parts.some(v => !Number.isFinite(v))) return null
  const [, , width, height] = parts
  return width > 0 && height > 0 ? { width, height } : null
}

/**
 * Prepare a live Mermaid SVG element mounted inside the lightbox for crisp
 * zoom/pan: removes Mermaid's inline `max-width` cap and materializes explicit
 * `width`/`height` attributes from `viewBox` (when available) so the diagram
 * never collapses inside flex containers.
 */
export function normalizeLightboxSvgElement(svg: Element): BoxSize | null {
  const rawStyle = svg.getAttribute("style")
  if (rawStyle) {
    const cleaned = rawStyle
      .split(";")
      .map(part => part.trim())
      .filter(part => part.length > 0 && !/^max-width\s*:/i.test(part))
      .join("; ")
    if (cleaned) svg.setAttribute("style", cleaned)
    else svg.removeAttribute("style")
  }
  const vb = parseViewBoxSize(svg.getAttribute("viewBox"))
  const width = vb?.width ?? parseSvgLength(svg.getAttribute("width"))
  const height = vb?.height ?? parseSvgLength(svg.getAttribute("height"))
  if (width !== null) svg.setAttribute("width", String(width))
  if (height !== null) svg.setAttribute("height", String(height))
  return width !== null && height !== null ? { width, height } : null
}

/**
 * Serialize a live `<svg>` element into well-formed standalone XML for clipboard
 * export (preserving XHTML self-closing `<br />` inside `<foreignObject>`).
 */
export function serializeSvgForClipboard(svg: Element): string {
  if (typeof XMLSerializer === "function") {
    return new XMLSerializer().serializeToString(svg)
  }
  return svg.outerHTML
}
