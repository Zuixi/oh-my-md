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

export interface BoxSize {
  readonly width: number
  readonly height: number
}

export interface WheelGestureInput {
  readonly deltaX: number
  readonly deltaY: number
  readonly ctrlKey: boolean
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
 * - Trackpad pinch (`ctrlKey`) zooms smoothly with higher pinch sensitivity.
 * - Trackpad two-finger horizontal/diagonal pan (`deltaX !== 0` in pixel mode) pans.
 * - Vertical mouse wheel zooms anchored at the pointer.
 */
export function applyWheelGesture(
  current: LightboxTransform,
  gesture: WheelGestureInput,
  focalX: number,
  focalY: number,
): LightboxTransform {
  if (gesture.ctrlKey) {
    return zoomAtPoint(
      current,
      wheelZoomScale(current.scale, gesture.deltaY, LIGHTBOX_PINCH_SENSITIVITY),
      focalX,
      focalY,
    )
  }
  if (Math.abs(gesture.deltaX) > 0 && gesture.deltaMode === 0) {
    return panBy(current, -gesture.deltaX, -gesture.deltaY)
  }
  return zoomAtPoint(
    current,
    wheelZoomScale(current.scale, gesture.deltaY, LIGHTBOX_WHEEL_SENSITIVITY),
    focalX,
    focalY,
  )
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

export interface PreparedSvg {
  readonly markup: string
  readonly width: number | null
  readonly height: number | null
}

/** Attributes that can carry an internal `#id` reference. `<text>`/`<tspan>`
 *  content is deliberately absent: a diagram label may read exactly like an id
 *  and must never be rewritten. */
const SVG_REFERENCE_ATTRIBUTES = [
  "href", "xlink:href", "marker-start", "marker-mid", "marker-end", "clip-path",
  "mask", "fill", "stroke", "filter", "aria-labelledby", "aria-describedby", "style",
]
const SVG_DANGEROUS_ELEMENTS = ["script", "iframe", "object", "embed"]
/** Executable URL schemes a hostile diagram could smuggle through the modal. */
const SVG_UNSAFE_URL = /^\s*(?:javascript|vbscript|data:text\/html)/i
const SVG_URL_ATTRIBUTES = new Set(["href", "xlink:href"])

function parseSvgLength(raw: string | null): number | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (trimmed.endsWith("%")) return null
  const n = Number.parseFloat(trimmed)
  return Number.isFinite(n) && n > 0 ? n : null
}

function parseViewBoxSize(raw: string | null): { width: number; height: number } | null {
  if (!raw) return null
  const parts = raw.trim().split(/[\s,]+/).map(Number)
  if (parts.length !== 4 || parts.some(v => !Number.isFinite(v))) return null
  const [, , width, height] = parts
  return width > 0 && height > 0 ? { width, height } : null
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Sanitizes one parsed SVG subtree and namespaces its ids in place. */
function sanitizeSvg(root: Element, idPrefix: string): void {
  for (const tag of SVG_DANGEROUS_ELEMENTS) {
    for (const node of [...root.querySelectorAll(tag)]) node.remove()
  }
  for (const element of [root, ...root.querySelectorAll("*")]) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase()
      if (name.startsWith("on") || (SVG_URL_ATTRIBUTES.has(name) && SVG_UNSAFE_URL.test(attribute.value))) {
        element.removeAttribute(attribute.name)
      }
    }
  }

  // Collect ids by DOM traversal (never by rewriting serialized text): a label
  // such as `<text>omd-mmd-1</text>` is content, not a reference.
  const renamed = new Map<string, string>()
  const idOwners = [...(root.hasAttribute("id") ? [root] : []), ...root.querySelectorAll("[id]")]
  for (const element of idOwners) {
    const oldId = element.getAttribute("id")
    if (!oldId) continue
    const newId = `${idPrefix}-${oldId}`
    renamed.set(oldId, newId)
    element.setAttribute("id", newId)
  }
  if (renamed.size === 0) return

  // One pass over the longest ids first, with an exact id-character boundary so
  // `omd-mmd-1` never rewrites `omd-mmd-10`.
  const pattern = new RegExp(
    `#(${[...renamed.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp).join("|")})(?![A-Za-z0-9_-])`,
    "g",
  )
  const rewrite = (text: string): string => text.replace(pattern, (match, id: string) => {
    const next = renamed.get(id)
    return next ? `#${next}` : match
  })
  for (const element of [root, ...root.querySelectorAll("*")]) {
    for (const attribute of SVG_REFERENCE_ATTRIBUTES) {
      const value = element.getAttribute(attribute)
      if (value?.includes("#")) element.setAttribute(attribute, rewrite(value))
    }
  }
  for (const style of root.querySelectorAll("style")) {
    const css = style.textContent
    if (css?.includes("#")) style.textContent = rewrite(css)
  }
}

/**
 * Prepare a Mermaid SVG snapshot for crisp full-screen zoom/pan:
 * - Rejects markup that cannot be parsed as an SVG document (`markup: ""`), so
 *   the lightbox renders its broken state instead of injecting raw text.
 * - Strips scriptable elements, event-handler attributes, and unsafe URL
 *   schemes before the markup reaches `dangerouslySetInnerHTML`.
 * - Namespaces every id (with digit-boundary guard so `omd-mmd-1` never
 *   rewrites `omd-mmd-10`) so the modal copy never collides with inline editor defs.
 * - Extracts intrinsic dimensions from `viewBox` (or width/height attributes)
 *   and removes Mermaid's inline `max-width` cap so scaling stays sharp.
 */
export function prepareLightboxSvg(svgMarkup: string, idPrefix: string): PreparedSvg {
  if (typeof DOMParser === "undefined" || typeof XMLSerializer === "undefined") {
    return { markup: "", width: null, height: null }
  }
  const doc = new DOMParser().parseFromString(svgMarkup, "image/svg+xml")
  const svg = doc.documentElement
  if (!svg || svg.tagName.toLowerCase() !== "svg" || doc.querySelector("parsererror")) {
    return { markup: "", width: null, height: null }
  }

  const vb = parseViewBoxSize(svg.getAttribute("viewBox"))
  const width = vb?.width ?? parseSvgLength(svg.getAttribute("width"))
  const height = vb?.height ?? parseSvgLength(svg.getAttribute("height"))

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
  if (width !== null) svg.setAttribute("width", String(width))
  if (height !== null) svg.setAttribute("height", String(height))

  sanitizeSvg(svg, idPrefix)
  return { markup: new XMLSerializer().serializeToString(svg), width, height }
}
