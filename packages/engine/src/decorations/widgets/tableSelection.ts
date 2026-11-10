import type { StateEffect } from "@codemirror/state"
import type { EditorView } from "@codemirror/view"
import { cellLanguage } from "../../parse/cell"
import type { TableCellData } from "../../tables/model"
import type { TableContext } from "../../tables/navigate"
import { trimmedCellCaret } from "./tableCellEdit"

/**
 * Pointer selection inside a rendered GFM table.
 *
 * The widget's press used to open the cell input immediately and stop there, so a drag over
 * rendered cells never reached `EditorState.selection` and the browser copied the previous
 * caret. A press must still keep the click behavior (the cell session opens unchanged), but
 * once the pointer travels past the drift threshold the gesture becomes a source-backed
 * CodeMirror range: the pressed cell maps to a real source offset (see
 * `cellVisibleSourceOffset`) and the first promoted move reveals the Markdown rows so every
 * later position comes from `posAtDOM`/`posAtCoords` on the document itself.
 */

/** Pointer travel (px) below which a table press stays a click on the cell session. */
export const TABLE_POINTER_DRIFT_PX = 4

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
export function cellVisibleSourceOffset(source: string, visible: string, index: number): number {
  const target = Math.max(0, Math.min(index, visible.length))
  const glyphs = alignVisibleGlyphs(source, visible)
  // Glyphs entirely before the requested boundary, so a boundary inside a surrogate pair
  // reads as the boundary in front of that glyph.
  let before = 0
  let consumed = 0
  while (consumed < target && before < glyphs.length) {
    consumed += glyphAt(visible, consumed).length
    before++
  }
  for (let at = before - 1; at >= 0; at--) {
    const end = glyphs[at]?.end
    if (end !== undefined) return end
  }
  const first = glyphs.find(glyph => glyph.start !== undefined)
  return first?.start ?? 0
}

interface VisibleGlyph {
  /** Source index where this visible glyph starts, undefined when the source cannot spell it. */
  readonly start: number | undefined
  /** Source index just past it, undefined for the same reason. */
  readonly end: number | undefined
}

/** Visible glyphs in order, each matched to the next place the source spells it. */
function alignVisibleGlyphs(source: string, visible: string): VisibleGlyph[] {
  const glyphs: VisibleGlyph[] = []
  const markup = unspellableSpans(source)
  let search = 0
  for (let at = 0; at < visible.length;) {
    const glyph = glyphAt(visible, at)
    const found = spellingIndex(source, glyph, search, markup)
    glyphs.push(found < 0
      ? { start: undefined, end: undefined }
      : { start: found, end: found + glyph.length })
    // A match only ever moves the search forward, so skipping an unspellable glyph can never
    // pull a later match back onto bytes an earlier glyph already claimed.
    if (found >= 0) search = found + glyph.length
    at += glyph.length
  }
  return glyphs
}

/**
 * Source spans the projection renders as one glyph the source does not spell as those
 * characters: an HTML entity (`&amp;` renders `&`) or an emoji shortcode (`:smile:` renders
 * 😀). Their inner characters are markup, so matching a visible glyph inside them would
 * anchor a selection to bytes the user never saw (`&hellip;hello` must map `hello` onto the
 * literal text, not onto the `h` of the entity name).
 */
function unspellableSpans(source: string): readonly (readonly [number, number])[] {
  const spans: (readonly [number, number])[] = []
  // The cell parser owns what counts as an entity/shortcode; never re-detect the syntax here.
  cellLanguage().parser.parse(source).iterate({
    enter: node => {
      if (node.name === "Entity" || node.name === "Emoji") spans.push([node.from, node.to])
    },
  })
  return spans
}

/** Next place the source spells `glyph` outside entity/shortcode markup, or -1. */
function spellingIndex(
  source: string,
  glyph: string,
  from: number,
  markup: readonly (readonly [number, number])[],
): number {
  const inside = (at: number): boolean =>
    markup.some(([start, end]) => at > start && at + glyph.length <= end)
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
): number {
  const visible = element.textContent ?? ""
  const point = caretPoint(element.ownerDocument, clientX, clientY)
  if (point && element.contains(point.node)) {
    return cellVisibleSourceOffset(cell.source, visible, visiblePrefixLength(element, point))
  }
  // A press on cell padding or a textless glyph (image/`<br>`) has no rendered column:
  // pick the nearer cell edge instead of guessing a character inside the content.
  const rect = element.getBoundingClientRect()
  const near = clientX < rect.left + rect.width / 2 ? 0 : visible.length
  return cellVisibleSourceOffset(cell.source, visible, near)
}

/**
 * Document offset under a pointer while the rendered table is still on screen (the
 * promotion move). The reveal re-flows the table into Markdown rows, so mapping this move
 * against the layout the user actually pointed at avoids a one-row jump at the threshold.
 */
export function renderedTablePointerOffset(
  event: MouseEvent,
  table: TableContext,
  cellAt: (row: number, column: number) => TableCellData | null,
): number | null {
  const hit = tableCellSlotAt(document.elementFromPoint(event.clientX, event.clientY))
  const cell = hit ? cellAt(hit.row, hit.column) : null
  if (!hit || !cell) return null
  const offset = renderedCellSourceOffset(cell, hit.element, event.clientX, event.clientY)
  return table.from + cell.from + offset
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
): number {
  const offset = input
    ? input.selectionStart ?? trimmedCellCaret(cell.source)
    : renderedCellSourceOffset(cell, element, event.clientX, event.clientY)
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
   * Maps the promotion move against the still-rendered table (null when it left the table).
   * Without it, the head would be read after the reveal re-flowed the rows and could land on
   * a neighbouring line.
   */
  readonly renderedOffset: (event: MouseEvent) => number | null
  /**
   * Dispatched with the first promoted selection. The table's own reveal/close effects
   * belong here so the visible Markdown rows and the committed range are one transaction.
   */
  readonly revealEffects: readonly StateEffect<unknown>[]
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
 * is dispatched until the pointer exceeds the drift threshold. The first promoted move
 * commits the anchor together with `revealEffects`; from then on the table is real Markdown
 * in the document DOM and every pointer position is a document offset. Copy therefore always
 * reads `EditorState.selection`, never a stale caret or a whole-table guess.
 */
export function startTableSelectionDrag(
  options: TableSelectionDragOptions,
): TableSelectionDragHandle | null {
  const { view, event, anchor, renderedOffset, revealEffects } = options
  if (event.button !== 0 || !view.dom.isConnected) return null
  const document = view.state.doc
  const origin = { x: event.clientX, y: event.clientY }
  let dragging = false
  let head = anchor
  let disposed = false

  // A destroyed view (or a document that changed under the gesture) invalidates the
  // revealed rows and every mapped offset: stop instead of retargeting a new document.
  const stale = (): boolean => view.state.doc !== document || !view.dom.isConnected

  const select = (pos: number, effects?: readonly StateEffect<unknown>[]): void => {
    head = pos
    view.dispatch({ selection: { anchor, head: pos }, effects, scrollIntoView: false })
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
      const rendered = renderedOffset(move)
      select(rendered ?? anchor, revealEffects)
      // The reveal replaced the rendered widget, so focus the editor (the removed input
      // must not keep it) and only then map a pointer that left the table's rendered box.
      view.focus()
      if (rendered === null) {
        const pos = pointerOffset(view, move.clientX, move.clientY)
        if (pos !== head) select(pos)
      }
      return
    }
    move.preventDefault()
    const pos = pointerOffset(view, move.clientX, move.clientY)
    if (pos !== head) select(pos)
  }

  const cancel = (): void => {
    if (disposed) return
    disposed = true
    window.removeEventListener("mousemove", onMove, true)
    window.removeEventListener("mouseup", onUp, true)
    // No capture: a capturing `blur` listener also sees every element blur, and this
    // gesture's own cell input loses focus on promotion (`view.focus()` + widget removal).
    window.removeEventListener("blur", onDismiss)
    window.removeEventListener("keydown", onKeyDown, true)
    if (activeDrag === cancel) activeDrag = null
  }

  const onUp = (up: MouseEvent): void => {
    // The last mousemove already committed the head; re-mapping on mouseup would shrink the
    // range whenever the reveal re-laid out a row under the cursor.
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
  window.addEventListener("mousemove", onMove, true)
  window.addEventListener("mouseup", onUp, true)
  window.addEventListener("blur", onDismiss)
  window.addEventListener("keydown", onKeyDown, true)
  activeDrag = cancel
  return { cancel, get dragging() { return dragging } }
}
