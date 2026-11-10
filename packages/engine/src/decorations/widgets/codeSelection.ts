import type { EditorState, Line } from "@codemirror/state"
import type { EditorView } from "@codemirror/view"
import { blockPrefixOf } from "../../format/blockPrefix"

/** Pointer travel below which a press stays a click (source entry) instead of a drag. */
export const CODE_POINTER_DRIFT_PX = 4

/** Lines measured per gesture: a pathological block must not stall a press. */
const MAX_CAPTURED_LINES = 400
/** Characters measured per line; longer lines map columns proportionally. */
const MAX_MEASURED_LINE_CHARS = 4096
/** Rows a line starting above the viewport may still reach into it (no wrapping today). */
const VISIBLE_LINE_LOOKBACK = 4

export interface CodeSourceRange {
  readonly from: number
  readonly to: number
}

export interface CodePointerTarget {
  /** Content line index inside the rendered body (Shiki `.line` order). */
  readonly lineIndex: number
  /** UTF-16 column inside that content line. */
  readonly column: number
}

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(value, max))

/**
 * Map a rendered code line/column to an EditorState offset.
 *
 * `src` is the source-derived fence content (`fencedCodeSource`), so the result can
 * never invent DOM text. Content lines map 1:1 onto the physical lines after the
 * opening fence; see `contentStart` for where the content begins inside its line.
 */
export function codeSourceOffset(
  state: EditorState,
  range: CodeSourceRange,
  src: string,
  lineIndex: number,
  column: number,
): number {
  const sourceLines = src.split("\n")
  const index = clamp(lineIndex, 0, sourceLines.length - 1)
  const content = sourceLines[index]
  const openingLine = state.doc.lineAt(clamp(range.from, 0, state.doc.length)).number
  const line = state.doc.line(clamp(openingLine + 1 + index, 1, state.doc.lines))
  const start = contentStart(state, line, content)
  return clamp(start + clamp(column, 0, content.length), line.from, line.to)
}

/**
 * Lezer's `CodeText` always ends at the physical line end — quote/list prefixes and
 * their whitespace belong to the surrounding structure — so fence content is a
 * suffix of its source line and starts at `line.to - content.length`.
 *
 * Derived from that structure and *verified* against the text, never searched:
 * substring search answers from text that merely looks like the content
 * (`> foo > foo` matches the quoted `foo` before the real content start) and would
 * silently shift if `src` ever stopped being a physical-line suffix.
 */
function contentStart(state: EditorState, line: Line, content: string): number {
  const start = line.to - content.length
  if (start >= line.from && line.text.slice(start - line.from) === content) return start
  const prefix = blockPrefixOf(state, line)
  return prefix ? line.from + prefix.text.length : line.from
}

interface CapturedLine {
  /** Original line index, including lines skipped as offscreen. */
  readonly index: number
  readonly text: string
  readonly top: number
  readonly bottom: number
  /** X coordinate of every UTF-16 column boundary, length = text.length + 1. */
  readonly boundaries: readonly number[]
}

export interface CodeGeometry {
  readonly lines: readonly CapturedLine[]
  readonly left: number
  readonly right: number
  readonly top: number
  readonly bottom: number
}

/**
 * Snapshot one frame of rendered code geometry. A partial selection unmounts the
 * widget (`blockSelected`), so the still-open drag must map later pointer moves
 * against the layout the user actually grabbed instead of the reflowed source.
 * Only lines intersecting the viewport are measured.
 */
export function captureCodeGeometry(
  body: HTMLElement,
  src: string,
  viewportTop: number,
  viewportBottom: number,
): CodeGeometry | null {
  const lines = renderedLines(body, viewportTop, viewportBottom)
    ?? plainLines(body, src, viewportTop, viewportBottom)
  if (!lines || lines.length === 0) return null
  const bodyRect = body.getBoundingClientRect()
  return {
    lines,
    left: bodyRect.left,
    right: bodyRect.right,
    top: Math.min(...lines.map(line => line.top)),
    bottom: Math.max(...lines.map(line => line.bottom)),
  }
}

/** Shiki body: one `.line` span per content line, so a visible window is enough. */
function renderedLines(
  body: HTMLElement,
  viewportTop: number,
  viewportBottom: number,
): CapturedLine[] | null {
  const elements = [...body.querySelectorAll<HTMLElement>(".line")]
  if (elements.length === 0) return null
  const captured: CapturedLine[] = []
  for (let index = firstVisibleLine(elements, viewportTop); index < elements.length; index++) {
    if (captured.length >= MAX_CAPTURED_LINES) break
    const rect = elements[index].getBoundingClientRect()
    if (rect.height <= 0) continue
    if (rect.top > viewportBottom) break
    if (rect.bottom < viewportTop) continue
    const text = elements[index].textContent ?? ""
    captured.push({
      index,
      text,
      top: rect.top,
      bottom: rect.bottom,
      boundaries: measuredBoundaries(elements[index], text, 0, text.length),
    })
  }
  return captured
}

/**
 * Binary-search the first line reaching into the viewport (line tops are ordered),
 * then step back over rows that start above it. Keeps a 10k-line block from reading
 * every rect on press.
 */
function firstVisibleLine(elements: readonly HTMLElement[], viewportTop: number): number {
  let low = 0
  let high = elements.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (elements[middle].getBoundingClientRect().top >= viewportTop) high = middle
    else low = middle + 1
  }
  let index = Math.min(low, elements.length - 1)
  for (let back = 0; back < VISIBLE_LINE_LOOKBACK && index > 0; back++) {
    if (elements[index - 1].getBoundingClientRect().bottom <= viewportTop) break
    index--
  }
  return index
}

/** Plaintext fallback body: no `.line` spans, so lines come from src and line-height. */
function plainLines(
  body: HTMLElement,
  src: string,
  viewportTop: number,
  viewportBottom: number,
): CapturedLine[] | null {
  const pre = body.querySelector("pre")
  if (!pre) return null
  const style = getComputedStyle(pre)
  const paddingTop = Number.parseFloat(style.paddingTop) || 0
  const fontSize = Number.parseFloat(style.fontSize) || 16
  const lineHeight = Number.parseFloat(style.lineHeight) || fontSize * 1.4
  const contentTop = pre.getBoundingClientRect().top + paddingTop
  const captured: CapturedLine[] = []
  let start = 0
  for (const [index, text] of src.split("\n").entries()) {
    const top = contentTop + index * lineHeight
    const bottom = top + lineHeight
    const lineStart = start
    start += text.length + 1
    if (bottom < viewportTop || top > viewportBottom) continue
    if (captured.length >= MAX_CAPTURED_LINES) break
    captured.push({
      index,
      text,
      top,
      bottom,
      boundaries: measuredBoundaries(pre, text, lineStart, lineStart + text.length),
    })
  }
  return captured
}

/** Map a point against a captured frame, preserving the grabbed gesture layout. */
export function codePointerTargetFromGeometry(
  geometry: CodeGeometry,
  x: number,
  y: number,
): CodePointerTarget {
  const line = nearestCapturedLine(geometry.lines, y)
  return { lineIndex: line.index, column: nearestBoundary(line.boundaries, x) }
}

export function isInsideCodeGeometry(geometry: CodeGeometry, x: number, y: number): boolean {
  return x >= geometry.left && x <= geometry.right && y >= geometry.top && y <= geometry.bottom
}

function nearestCapturedLine(lines: readonly CapturedLine[], y: number): CapturedLine {
  let best = lines[0]
  let bestDistance = Number.POSITIVE_INFINITY
  for (const line of lines) {
    if (y >= line.top && y <= line.bottom) return line
    const distance = y < line.top ? line.top - y : y - line.bottom
    if (distance < bestDistance) {
      best = line
      bestDistance = distance
    }
  }
  return best
}

function nearestBoundary(boundaries: readonly number[], x: number): number {
  if (boundaries.length === 0) return 0
  let low = 0
  let high = boundaries.length - 1
  while (low < high) {
    const middle = (low + high) >> 1
    if (boundaries[middle] < x) low = middle + 1
    else high = middle
  }
  if (low > 0 && Math.abs(boundaries[low - 1] - x) <= Math.abs(boundaries[low] - x)) low--
  return low
}

function textLeft(root: HTMLElement): number {
  const style = getComputedStyle(root)
  return root.getBoundingClientRect().left + (Number.parseFloat(style.paddingLeft) || 0)
}

/**
 * One X boundary per UTF-16 code unit of `text` (the [start, end) slice of `root`'s
 * text). Surrogate pairs stay two columns (CodeMirror offsets are UTF-16) but share
 * the visual glyph's midpoint boundary.
 */
function measuredBoundaries(root: HTMLElement, text: string, start: number, end: number): number[] {
  const boundaries = text.length > MAX_MEASURED_LINE_CHARS
    ? proportionalBoundaries(root, text)
    : glyphBoundaries(root, start, end)
  padBoundaries(boundaries, text.length + 1, boundaries[boundaries.length - 1] ?? textLeft(root))
  return boundaries.slice(0, text.length + 1)
}

function glyphBoundaries(root: HTMLElement, start: number, end: number): number[] {
  const doc = root.ownerDocument
  const boundaries: number[] = []
  let previous = textLeft(root)
  let global = 0
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const data = (node as Text).data
    const nodeStart = global
    global += data.length
    if (global <= start || nodeStart >= end) continue
    const from = Math.max(0, start - nodeStart)
    const to = Math.min(data.length, end - nodeStart)
    for (let offset = from; offset < to;) {
      const code = data.codePointAt(offset) ?? 0
      const units = code > 0xffff ? 2 : 1
      if (boundaries.length === 0) boundaries.push(previous)
      const range = doc.createRange()
      range.setStart(node, offset)
      range.setEnd(node, Math.min(offset + units, data.length))
      const rect = range.getBoundingClientRect()
      const left = rect.width > 0 || rect.height > 0 ? rect.left : previous
      if (boundaries.length === 0) boundaries[0] = left
      const right = rect.width > 0 || rect.height > 0 ? rect.right : left
      if (units === 1) boundaries.push(right)
      else {
        boundaries.push(left + (right - left) / 2)
        boundaries.push(right)
      }
      previous = right
      offset += units
    }
    if (global >= end) break
  }
  return boundaries
}

/**
 * Very long lines degrade to evenly spaced columns between the measured text edges.
 * Measuring tens of thousands of glyph rects on a press costs more than the
 * sub-pixel error of proportional columns in monospace code.
 */
function proportionalBoundaries(root: HTMLElement, text: string): number[] {
  const left = textLeft(root)
  const style = getComputedStyle(root)
  const right = root.getBoundingClientRect().right - (Number.parseFloat(style.paddingRight) || 0)
  const width = Math.max(0, right - left)
  return Array.from({ length: text.length + 1 },
    (_, column) => left + (width * column) / Math.max(1, text.length))
}

function padBoundaries(boundaries: number[], length: number, fallback: number): void {
  if (boundaries.length === 0) boundaries.push(fallback)
  while (boundaries.length < length) boundaries.push(boundaries[boundaries.length - 1])
}

interface CaretPoint {
  readonly node: Node
  readonly offset: number
}

function caretPoint(doc: Document, x: number, y: number): CaretPoint | null {
  const withPosition = doc as Document & {
    caretPositionFromPoint?: (px: number, py: number) => { offsetNode: Node; offset: number } | null
  }
  const position = withPosition.caretPositionFromPoint?.(x, y)
  if (position?.offsetNode) return { node: position.offsetNode, offset: position.offset }
  const withRange = doc as Document & {
    caretRangeFromPoint?: (px: number, py: number) => Range | null
  }
  const range = withRange.caretRangeFromPoint?.(x, y)
  return range ? { node: range.startContainer, offset: range.startOffset } : null
}

function posAtPointer(view: EditorView, x: number, y: number): number {
  // Prefer the DOM caret over the height map: a just-revealed source block can
  // still be mid-measure, and `posAtCoords` then answers from stale line blocks.
  const point = caretPoint(view.contentDOM.ownerDocument, x, y)
  if (point && view.contentDOM.contains(point.node)) {
    try {
      const pos = view.posAtDOM(point.node, point.offset)
      if (pos >= 0 && pos <= view.state.doc.length) return pos
    } catch {
      // Fall through to view coordinates when the DOM point is not a document point.
    }
  }
  const direct = view.posAtCoords({ x, y })
  if (direct !== null) return direct
  const rect = view.contentDOM.getBoundingClientRect()
  const clamped = view.posAtCoords({
    x: clamp(x, rect.left + 1, rect.right - 1),
    y: clamp(y, rect.top + 1, rect.bottom - 1),
  })
  return clamped ?? view.state.selection.main.head
}

export interface CodeSelectionDragOptions {
  readonly view: EditorView
  readonly body: HTMLElement
  readonly src: string
  readonly range: CodeSourceRange
  readonly event: MouseEvent
}

export interface CodeSelectionDragHandle {
  /** Remove every listener; no further selection update may be dispatched. */
  cancel(): void
  /** True once the gesture passed the click threshold and committed a selection. */
  readonly dragging: boolean
}

/** At most one gesture owns the window listeners; a new press replaces the old one. */
let activeDrag: (() => void) | null = null

/**
 * Own a drag that starts inside a rendered code body. The widget may unmount as soon
 * as the partial selection reveals source lines, so the gesture lives on `window`,
 * maps against the captured frame while inside the grabbed block, and switches to
 * `view.posAtCoords` for targets outside it.
 *
 * Returns null when the press cannot be mapped (no rendered line geometry); the
 * caller's click path then enters source editing.
 */
export function startCodeSelectionDrag(
  options: CodeSelectionDragOptions,
): CodeSelectionDragHandle | null {
  const { view, body, src, range, event } = options
  if (event.button !== 0 || !view.dom.isConnected) return null
  const scrollRect = view.scrollDOM.getBoundingClientRect()
  const geometry = captureCodeGeometry(body, src, scrollRect.top, scrollRect.bottom)
  if (!geometry) return null
  const pressed = codePointerTargetFromGeometry(geometry, event.clientX, event.clientY)
  const anchor = codeSourceOffset(view.state, range, src, pressed.lineIndex, pressed.column)
  const document = view.state.doc
  const origin = { x: event.clientX, y: event.clientY }
  let dragging = false
  let head = anchor
  let disposed = false

  // A destroyed view (or a document that changed under the gesture) invalidates both
  // the captured layout and every source offset: stop instead of retargeting.
  const stale = (): boolean => view.state.doc !== document || !view.dom.isConnected

  const pointerPos = (move: MouseEvent): number => {
    if (isInsideCodeGeometry(geometry, move.clientX, move.clientY)) {
      const target = codePointerTargetFromGeometry(geometry, move.clientX, move.clientY)
      return codeSourceOffset(view.state, range, src, target.lineIndex, target.column)
    }
    return posAtPointer(view, move.clientX, move.clientY)
  }

  const commit = (pos: number): void => {
    head = pos
    view.dispatch({ selection: { anchor, head }, scrollIntoView: false })
  }

  const onMove = (move: MouseEvent): void => {
    if (stale()) {
      cancel()
      return
    }
    if (!dragging) {
      const drift = Math.abs(move.clientX - origin.x) + Math.abs(move.clientY - origin.y)
      if (drift <= CODE_POINTER_DRIFT_PX) return
      dragging = true
      move.preventDefault()
      commit(pointerPos(move))
      return
    }
    move.preventDefault()
    const pos = pointerPos(move)
    if (pos !== head) commit(pos)
  }

  const cancel = (): void => {
    if (disposed) return
    disposed = true
    window.removeEventListener("mousemove", onMove, true)
    window.removeEventListener("mouseup", onUp, true)
    window.removeEventListener("blur", onDismiss, true)
    window.removeEventListener("keydown", onKeyDown, true)
    if (activeDrag === cancel) activeDrag = null
  }

  const onUp = (up: MouseEvent): void => {
    // The last mousemove already committed the head. Re-mapping on mouseup would
    // shrink the range whenever the reveal reflowed another line under the cursor.
    if (dragging) up.preventDefault()
    cancel()
  }

  // Releasing outside the window, alt-tabbing, or Escape must end the gesture: the
  // listeners are gone, so a later move cannot drive this view again.
  const onDismiss = (): void => cancel()
  const onKeyDown = (key: KeyboardEvent): void => {
    if (key.key === "Escape") cancel()
  }

  activeDrag?.()
  event.preventDefault()
  event.stopPropagation()
  view.focus()
  window.addEventListener("mousemove", onMove, true)
  window.addEventListener("mouseup", onUp, true)
  window.addEventListener("blur", onDismiss, true)
  window.addEventListener("keydown", onKeyDown, true)
  activeDrag = cancel
  return { cancel, get dragging() { return dragging } }
}
