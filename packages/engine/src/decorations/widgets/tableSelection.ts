import type { StateEffect } from "@codemirror/state"
import type { EditorView } from "@codemirror/view"
import { CELL_HIDDEN_NODES, cellHtmlBreakTag, cellLanguage, type CellParseOptions } from "../../parse/cell"
import { decodeHtmlEntity } from "../../parse/entities"
import { escapeParts } from "../../semantic/breaks"
import { imageParts } from "../../semantic/image"
import { linkParts } from "../../semantic/link"
import { stringReferenceContext, type MarkdownReferenceContext } from "../../semantic/references"
import type { TableCellData } from "../../tables/model"
import type { TableContext } from "../../tables/navigate"
import { widgetPointerTargetAtPoint } from "../blockSelectionLayer"
import { setTableSelectionDragActive, trimmedCellCaret } from "./tableCellEdit"

/**
 * Pointer selection inside a rendered GFM table.
 *
 * A press still keeps its click behavior (opening the cell session unchanged), but once the
 * pointer travels past the drift threshold the gesture closes the cell input and commits a
 * source-backed CodeMirror range while keeping the rendered table mounted. The selection
 * layer (`blockSelectionLayer.ts`) paints the range over the rendered cells so `EditorState.selection`
 * remains the single clipboard truth without flipping the table into pipe rows.
 */

/** Pointer travel (px) below which a table press stays a click on the cell session. */
export const TABLE_POINTER_DRIFT_PX = 4
const MAX_ALIGN_CACHE_ENTRIES = 256

export interface TableCellSlot {
  readonly element: HTMLTableCellElement
  /** Source slot row: 0 is the header row, 1..n are the body rows (same order as `TableData`). */
  readonly row: number
  readonly column: number
}

/** The rendered `td`/`th` under an event and the source slot it projects. */
export function tableCellSlotAt(target: EventTarget | null): TableCellSlot | null {
  if (!(target instanceof Element)) return null
  const element = target.closest<HTMLTableCellElement>("td, th")
  if (!element) return null
  // `rowIndex` counts the thead row, which is the same order as `[header, ...rows]`.
  const row = element.parentElement instanceof HTMLTableRowElement
    ? element.parentElement.rowIndex
    : 0
  return { element, row, column: element.cellIndex }
}

/**
 * Map a position inside a rendered cell's visible text onto a real source offset.
 *
 * The projection folds inline syntax (`**bold**` renders as `bold`, `\|` as `|`, a link as
 * its label, an image as no text), so the rendered text is not `TableCellData.source`.
 * `visible` is the DOM text the user actually saw and the result is an index into `source`
 * that always falls on a real boundary:
 *
 * - any boundary → the end of the last visible glyph the source can spell before it, so the
 *   bytes between two visible glyphs (markup, escape backslashes, entity tails) belong to a
 *   selection that spans them and never leak into one that stops before;
 * - a boundary with no spellable glyph in front of it → where the first spellable glyph
 *   really starts, so folded markup in front of it stays outside a selection that starts at
 *   the press;
 * - a visible glyph the source cannot spell (an emoji shortcode resolving to another code
 *   point, an entity with no literal form) is skipped instead of ending the alignment, and
 *   the boundaries around it land on the nearest real boundary. The projection may render
 *   text the source cannot anchor, and inventing an offset there would copy bytes the user
 *   never selected. The characters *inside* an entity or shortcode are markup too, so the
 *   search never claims them as the rendered glyph.
 */
export function cellVisibleSourceOffset(
  source: string,
  visible: string,
  index: number,
  resolveReference?: CellParseOptions["resolveReference"],
): number {
  const target = Math.max(0, Math.min(index, visible.length))
  const glyphs = alignVisibleGlyphs(source, visible, resolveReference)
  // Glyphs entirely before the requested boundary, so a boundary inside a surrogate pair
  // reads as the boundary in front of that glyph.
  let before = 0
  while (before < glyphs.length && glyphs[before].visibleStart < target) {
    before++
  }
  for (let at = before - 1; at >= 0; at--) {
    const end = glyphs[at]?.end
    if (end !== undefined) return end
  }
  const first = glyphs.find(glyph => glyph.start !== undefined)
  return first?.start ?? 0
}

export interface VisibleGlyph {
  /** UTF-16 start index in `visible`. */
  readonly visibleStart: number
  /** UTF-16 end index in `visible` (exclusive). */
  readonly visibleEnd: number
  /** Source index where this visible glyph starts, undefined when the source cannot spell it. */
  readonly start: number | undefined
  /** Source index just past it, undefined for the same reason. */
  readonly end: number | undefined
}

const defaultAlignCache = new Map<string, readonly VisibleGlyph[]>()
const refAlignCaches = new WeakMap<
  NonNullable<CellParseOptions["resolveReference"]>,
  Map<string, readonly VisibleGlyph[]>
>()

function alignCacheFor(
  resolveReference?: CellParseOptions["resolveReference"],
): Map<string, readonly VisibleGlyph[]> {
  if (!resolveReference) return defaultAlignCache
  let cache = refAlignCaches.get(resolveReference)
  if (!cache) {
    cache = new Map()
    refAlignCaches.set(resolveReference, cache)
  }
  return cache
}

/** Visible glyphs in order, each matched to the next place the source spells it. */
export function alignVisibleGlyphs(
  source: string,
  visible: string,
  resolveReference?: CellParseOptions["resolveReference"],
): readonly VisibleGlyph[] {
  const cache = alignCacheFor(resolveReference)
  const key = `${source}\u0000${visible}`
  const cached = cache.get(key)
  if (cached) return cached

  const glyphs: VisibleGlyph[] = []
  const markup = unspellableSpans(source, resolveReference)
  let search = 0
  for (let at = 0; at < visible.length;) {
    const glyph = glyphAt(visible, at)
    const found = spellingIndex(source, glyph, search, markup)
    glyphs.push(found < 0
      ? { visibleStart: at, visibleEnd: at + glyph.length, start: undefined, end: undefined }
      : {
          visibleStart: at,
          visibleEnd: at + glyph.length,
          start: found,
          end: found + glyph.length,
        })
    // A match only ever moves the search forward, so skipping an unspellable glyph can never
    // pull a later match back onto bytes an earlier glyph already claimed.
    if (found >= 0) search = found + glyph.length
    at += glyph.length
  }
  if (cache.size >= MAX_ALIGN_CACHE_ENTRIES) cache.clear()
  cache.set(key, glyphs)
  return glyphs
}


/**
 * Source spans hidden or replaced by the cell projection (`parseCell`): syntax marks, link
 * URLs/titles, image syntax, `<br>`/`<hr>` tags, escape backslashes, emoji shortcodes, and
 * HTML entities. Matching a visible glyph inside these spans would anchor a selection to
 * hidden markup instead of the text the user actually pointed at.
 */
function unspellableSpans(
  source: string,
  resolveReference?: CellParseOptions["resolveReference"],
): readonly (readonly [number, number])[] {
  const spans: (readonly [number, number])[] = []
  const baseRefs = stringReferenceContext(source)
  const references: MarkdownReferenceContext = resolveReference
    ? {
        sliceString: (from, to) => baseRefs.sliceString(from, to),
        resolveReference: label => resolveReference(label) ?? baseRefs.resolveReference(label),
      }
    : baseRefs
  // The cell parser owns what counts as an entity/shortcode; never re-detect the syntax here.
  cellLanguage().parser.parse(source).iterate({
    enter: node => {
      if (CELL_HIDDEN_NODES.has(node.name) || node.name === "Emoji") {
        spans.push([node.from, node.to])
        return
      }
      if (node.name === "Entity") {
        const decoded = decodeHtmlEntity(source.slice(node.from, node.to))
        spans.push([decoded === "&" ? node.from + 1 : node.from, node.to])
        return
      }
      if (node.name === "Escape") {
        const parts = escapeParts(node.node)
        if (parts) spans.push([parts.markerFrom, parts.markerTo])
        return
      }
      if (node.name === "Link") {
        const parts = linkParts(node.node, references)
        if (parts && parts.kind !== "autolink") {
          spans.push([node.from, parts.labelFrom], [parts.labelTo, node.to])
        }
        return
      }
      if (node.name === "Image" && imageParts(node.node, references)) {
        spans.push([node.from, node.to])
        return
      }
      if (node.name === "HTMLTag" && cellHtmlBreakTag(source.slice(node.from, node.to)) !== null) {
        spans.push([node.from, node.to])
      }
    },
  })
  return spans
}

/** Next place the source spells `glyph` outside hidden cell markup, or -1. */
function spellingIndex(
  source: string,
  glyph: string,
  from: number,
  markup: readonly (readonly [number, number])[],
): number {
  const inside = (at: number): boolean =>
    markup.some(([start, end]) => at < end && at + glyph.length > start)
  let found = source.indexOf(glyph, from)
  while (found >= 0 && inside(found)) found = source.indexOf(glyph, found + 1)
  return found
}

/** Code-point safe: a surrogate pair is one visible glyph but two UTF-16 columns. */
function glyphAt(text: string, index: number): string {
  return String.fromCodePoint(text.codePointAt(index) ?? 0)
}

/**
 * Cell-source offset of a pointer press on a rendered cell without a live cell session
 * (read-only views). Live sessions reuse the input caret instead, so click and drag anchors
 * stay identical there.
 */
export function renderedCellSourceOffset(
  cell: TableCellData,
  element: HTMLElement,
  clientX: number,
  clientY: number,
  resolveReference?: CellParseOptions["resolveReference"],
): number {
  const visible = element.textContent ?? ""
  const point = caretPoint(element.ownerDocument, clientX, clientY)
  if (point && element.contains(point.node)) {
    return cellVisibleSourceOffset(cell.source, visible, visiblePrefixLength(element, point), resolveReference)
  }
  // A press on cell padding or a textless glyph (image/`<br>`) has no rendered column:
  // pick the nearer cell edge instead of guessing a character inside the content.
  const rect = element.getBoundingClientRect()
  const near = rect.width <= 0 || clientX < rect.left + rect.width / 2 ? 0 : visible.length
  return cellVisibleSourceOffset(cell.source, visible, near, resolveReference)
}

/**
 * Document offset under a viewport point inside a specific rendered table container.
 * Checking `host.contains(hit.element)` prevents a drag over a second table in the same
 * document from indexing into the starting table's `TableContext`.
 */
export function renderedTableOffsetAtPoint(
  host: HTMLElement,
  tableFrom: number,
  cellAt: (row: number, column: number) => TableCellData | null,
  clientX: number,
  clientY: number,
  resolveReference?: CellParseOptions["resolveReference"],
): number | null {
  const hit = tableCellSlotAt(host.ownerDocument.elementFromPoint(clientX, clientY))
  if (!hit || !host.contains(hit.element)) return null
  const cell = cellAt(hit.row, hit.column)
  if (!cell) return null
  const offset = renderedCellSourceOffset(cell, hit.element, clientX, clientY, resolveReference)
  return tableFrom + cell.from + offset
}

export function renderedTablePointerOffset(
  event: MouseEvent,
  host: HTMLElement,
  table: TableContext,
  cellAt: (row: number, column: number) => TableCellData | null,
  resolveReference?: CellParseOptions["resolveReference"],
): number | null {
  return renderedTableOffsetAtPoint(host, table.from, cellAt, event.clientX, event.clientY, resolveReference)
}

/**
 * Cell-source offset of the press. `input` is the live cell session's input (its caret was
 * placed by the shared cell projection, `tableCellEdit.ts`); read-only views have none and
 * fall back to aligning the rendered cell text against the cell source.
 */
export function pressCaretOffset(
  cell: TableCellData,
  element: HTMLElement,
  input: HTMLInputElement | null,
  event: MouseEvent,
  resolveReference?: CellParseOptions["resolveReference"],
): number {
  const offset = input
    ? input.selectionStart ?? trimmedCellCaret(cell.source)
    : renderedCellSourceOffset(cell, element, event.clientX, event.clientY, resolveReference)
  return Math.max(0, Math.min(offset, cell.source.length))
}

interface CaretPoint {
  readonly node: Node
  readonly offset: number
}

/** `caretPositionFromPoint` (Firefox/Chrome) with the WebKit `caretRangeFromPoint` fallback. */
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

/** Visible characters before a DOM caret point; text nodes decide the rendered text. */
function visiblePrefixLength(root: HTMLElement, point: CaretPoint): number {
  try {
    const range = root.ownerDocument.createRange()
    range.setStart(root, 0)
    range.setEnd(point.node, point.offset)
    return range.toString().length
  } catch {
    // A caret point outside `root` cannot describe a prefix; the caller picks a cell edge.
    return 0
  }
}

/**
 * Document offset under a pointer. `posAtDOM` is preferred over the height map because the
 * reveal that starts this gesture replaces a tall rendered table with Markdown rows, and
 * `posAtCoords` can still answer from pre-reveal line blocks for a frame.
 */
function pointerOffset(view: EditorView, x: number, y: number): number {
  const point = caretPoint(view.contentDOM.ownerDocument, x, y)
  if (point && view.contentDOM.contains(point.node)) {
    try {
      const pos = view.posAtDOM(point.node, point.offset)
      if (pos >= 0 && pos <= view.state.doc.length) return pos
    } catch {
      // Fall through: the DOM point may not belong to a document position.
    }
  }
  const direct = view.posAtCoords({ x, y })
  if (direct !== null) return direct
  const rect = view.contentDOM.getBoundingClientRect()
  const clamped = view.posAtCoords({
    x: Math.max(rect.left + 1, Math.min(x, rect.right - 1)),
    y: Math.max(rect.top + 1, Math.min(y, rect.bottom - 1)),
  })
  return clamped ?? view.state.selection.main.head
}

export interface TableSelectionDragOptions {
  readonly view: EditorView
  readonly event: MouseEvent
  /** Source offset of the press: fixed selection anchor for the whole gesture. */
  readonly anchor: number
  /**
   * Maps a pointer move against the rendered table (null when the pointer left this table).
   * The rendered table stays mounted during selection, so this mapping stays valid for the
   * entire drag.
   */
  readonly renderedOffset: (event: MouseEvent) => number | null
  /**
   * Called once on promotion before mapping the pointer move, so the caller can tear down
   * any active cell `<input>` and restore the rendered cell DOM before `renderedOffset` reads it.
   */
  readonly onPromote?: () => void
  /**
   * Dispatched with the first promoted selection (e.g. `closeTableEdit()`).
   */
  readonly promoteEffects: readonly StateEffect<unknown>[]
  /**
   * Outer `.omd-table` container. When the pointer stays inside this container over a
   * non-selectable gap (padding, borders, toolbar, ragged missing cell), keep the previous
   * head instead of snapping to the widget boundary via `pointerOffset`.
   */
  readonly hostWrap?: HTMLElement
  /** Start already promoted (used by Shift+Click / Shift+Drag extension). */
  readonly startImmediately?: boolean
  /** Initial head when `startImmediately` is true (defaults to `anchor`). */
  readonly initialHead?: number
}

export interface TableSelectionDragHandle {
  /** Remove every listener; no further selection update may be dispatched. */
  cancel(): void
  /** True once the gesture passed the click threshold and committed a selection. */
  readonly dragging: boolean
}

/** At most one gesture owns the window listeners; a new press replaces the old one. */
let activeDrag: (() => void) | null = null

/**
 * Own a drag that starts on a rendered table cell.
 *
 * The press keeps its click meaning (the caller already opened the cell session), so nothing
 * is dispatched until the pointer exceeds the drift threshold. The first promoted move runs
 * `onPromote` to restore the rendered cell DOM, then commits a source-backed selection while
 * keeping the rendered table mounted. Copy always reads `EditorState.selection`.
 */
export function startTableSelectionDrag(
  options: TableSelectionDragOptions,
): TableSelectionDragHandle | null {
  const {
    view,
    event,
    anchor,
    renderedOffset,
    onPromote,
    promoteEffects,
    hostWrap,
    startImmediately = false,
    initialHead = anchor,
  } = options
  if (event.button !== 0 || !view.dom.isConnected) return null
  const document = view.state.doc
  const origin = { x: event.clientX, y: event.clientY }
  let dragging = startImmediately
  let head = initialHead
  let disposed = false

  // A destroyed view (or a document that changed under the gesture) invalidates every mapped
  // offset: stop instead of retargeting a new document.
  const stale = (): boolean => view.state.doc !== document || !view.dom.isConnected

  const select = (pos: number, effects?: readonly StateEffect<unknown>[]): void => {
    head = pos
    view.dispatch({ selection: { anchor, head: pos }, effects, scrollIntoView: false })
  }

  const resolvePos = (move: MouseEvent): number | null => {
    const direct = renderedOffset(move)
    if (direct !== null) return direct
    if (hostWrap && typeof hostWrap.ownerDocument.elementFromPoint === "function") {
      const hit = hostWrap.ownerDocument.elementFromPoint(move.clientX, move.clientY)
      if (hit && hostWrap.contains(hit)) return null
    }
    const widget = widgetPointerTargetAtPoint(view, move.clientX, move.clientY)
    if (widget.insideWidget) return widget.offset
    return pointerOffset(view, move.clientX, move.clientY)
  }

  const onMove = (move: MouseEvent): void => {
    if (stale()) {
      cancel()
      return
    }
    if (!dragging) {
      const drift = Math.abs(move.clientX - origin.x) + Math.abs(move.clientY - origin.y)
      if (drift <= TABLE_POINTER_DRIFT_PX) return
      dragging = true
      move.preventDefault()
      // Destroy the cell input and restore the rendered cell DOM before reading hit rects.
      onPromote?.()
      select(resolvePos(move) ?? head, promoteEffects)
      view.focus()
      return
    }
    move.preventDefault()
    const pos = resolvePos(move)
    if (pos !== null && pos !== head) select(pos)
  }

  const cancel = (): void => {
    if (disposed) return
    disposed = true
    window.removeEventListener("mousemove", onMove, true)
    window.removeEventListener("mouseup", onUp, true)
    // No capture: a capturing `blur` listener also sees every element blur, and this
    // gesture's own cell input loses focus on promotion (`view.focus()`).
    window.removeEventListener("blur", onDismiss)
    window.removeEventListener("keydown", onKeyDown, true)
    if (activeDrag === cancel) {
      activeDrag = null
      setTableSelectionDragActive(false)
    }
  }

  const onUp = (up: MouseEvent): void => {
    if (dragging) {
      up.preventDefault()
    } else if (!stale() && view.state.readOnly && !view.state.selection.main.empty) {
      // Read-only presses have no cell session to collapse an existing rendered selection.
      view.dispatch({ selection: { anchor }, scrollIntoView: false })
    }
    cancel()
  }

  // Releasing outside the window, alt-tabbing, or Escape must end the gesture: the
  // listeners are gone, so a later move cannot drive this view again.
  const onDismiss = (): void => cancel()
  const onKeyDown = (key: KeyboardEvent): void => {
    if (key.key === "Escape") cancel()
  }

  activeDrag?.()
  window.addEventListener("mousemove", onMove, true)
  window.addEventListener("mouseup", onUp, true)
  window.addEventListener("blur", onDismiss)
  window.addEventListener("keydown", onKeyDown, true)
  activeDrag = cancel
  setTableSelectionDragActive(true)
  return { cancel, get dragging() { return dragging } }
}
