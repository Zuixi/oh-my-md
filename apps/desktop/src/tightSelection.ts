/**
 * Vendored "tight selection" drawing for the oh-my-md desktop editor.
 *
 * Ported from @codemirror/view 6.43.8,
 * Copyright (C) 2018-2021 by Marijn Haverbeke <marijn@haverbeke.berlin>
 * and others, MIT License (see the package's LICENSE file). Sources:
 * src/drawSelection.ts, src/layer.ts (the layer machinery itself is reused
 * through the public `layer()` API rather than copied), and the `blockAt`
 * helper from src/cursor.ts. Structure and naming intentionally stay close
 * to upstream so re-diffing against a future @codemirror/view bump stays
 * mechanical.
 *
 * Why vendor: stock `drawSelection()` deliberately extends every "open"
 * line end of a selection to the content-box right edge and covers the lines
 * between the first and last selected line with a single full-width band.
 * That is not configurable (discuss.codemirror.net threads 9495/9735), so
 * this port clamps the geometry instead (see NUB_PX and the Modification A–C
 * comments below).
 *
 * Every block-derived y in here is anchored at `view.documentTop`, which is
 * where `BlockInfo.top` is measured from. Upstream uses `contentRect.top` in
 * `drawForWidget`; that is short by the content's padding-top and is
 * deliberately not carried over — see the vendoring guards in
 * `test/tightSelection.test.ts`.
 *
 * iOS selection handles are out of scope (macOS-first desktop app), so the
 * vendored config only carries `cursorBlinkRate`/`drawRangeCursor`.
 */

import {
  BlockType,
  Direction,
  EditorView,
  RectangleMarker,
  layer,
} from "@codemirror/view"
import type { BlockInfo, Rect, ViewUpdate } from "@codemirror/view"
import {
  EditorSelection,
  Facet,
  Prec,
  combineConfig,
} from "@codemirror/state"
import type { EditorState, Extension, SelectionRange } from "@codemirror/state"

/**
 * Upstream's "kludge": passing ±2 (not just ±1) as the side forces the view
 * to return coordinates on the proper side of block widgets. The public
 * coordsAtPos type only admits ±1, though any nonzero magnitude is honored
 * at runtime — hence the documented narrowing cast.
 */
function coordsAtPos(view: EditorView, pos: number, side: number): Rect | null {
  return view.coordsAtPos(pos, side as 1 | -1)
}

/** Extra pixels painted past the last selected glyph on open line ends. */
export const NUB_PX = 2

/**
 * Minimum height (px) for a wrapped-remainder band. Smaller spans are
 * treated as empty so sub-pixel rounding cannot create hairline artifacts.
 */
const BAND_EPSILON_PX = 1

/**
 * Tolerance for the row-box snap, so a coordinate already sitting exactly on a
 * row boundary is not pushed out to the next row by floating-point noise.
 */
const SNAP_EPSILON = 1e-6

export interface TightSelectionConfig {
  /**
   * The length of a full cursor blink cycle, in milliseconds.
   * Defaults to 1200. Can be set to 0 to disable blinking.
   */
  cursorBlinkRate?: number
  /**
   * Whether to show a cursor for non-empty ranges. Defaults to true.
   */
  drawRangeCursor?: boolean
}

const selectionConfig = Facet.define<TightSelectionConfig, Required<TightSelectionConfig>>({
  combine(configs) {
    return combineConfig(configs, {
      cursorBlinkRate: 1200,
      drawRangeCursor: true,
    }, {
      cursorBlinkRate: (a, b) => Math.min(a, b),
      drawRangeCursor: (a, b) => a || b,
    })
  },
})

/**
 * Returns an extension that hides the browser's native selection and cursor,
 * replacing the selection with a background behind the text (with the
 * `cm-selectionBackground` class), and the cursors with elements overlaid
 * over the code (using `cm-cursor-primary` and `cm-cursor-secondary`).
 *
 * Stock `RectangleMarker.forRange` is not used for non-empty ranges because
 * its inner geometry (the private upstream `rectanglesForRange`) is the
 * over-extending behavior this module exists to replace.
 */
export function tightSelection(config: TightSelectionConfig = {}): Extension {
  return [selectionConfig.of(config ?? {}), cursorLayer, tightSelectionLayer, hideNativeSelection]
}

/** Port of the empty-range branch of `RectangleMarker.forRange`. */
function markersForRange(
  view: EditorView,
  className: string,
  range: SelectionRange,
): RectangleMarker[] {
  if (range.empty) {
    let pos = view.coordsAtPos(range.head, range.assoc || 1)
    if (!pos)
      return []
    let base = getBase(view)
    return [new RectangleMarker(className, pos.left - base.left, pos.top - base.top, null, pos.bottom - pos.top)]
  }
  else {
    return tightRectanglesForRange(view, className, range)
  }
}

function getBase(view: EditorView) {
  let rect = view.scrollDOM.getBoundingClientRect()
  let left = view.textDirection == Direction.LTR ? rect.left : rect.right - view.scrollDOM.clientWidth * view.scaleX
  return { left: left - view.scrollDOM.scrollLeft * view.scaleX, top: rect.top - view.scrollDOM.scrollTop * view.scaleY }
}

/**
 * A line-shaped range: a viewport line block or a wrapped line segment. The
 * owning block travels with it because Modification C needs that block's real
 * box from CodeMirror's height map.
 */
interface VisualLine { from: number; to: number; block: BlockInfo }

/** The whole block as a visual line (no soft wrapping applied yet). */
function wholeBlock(block: BlockInfo): VisualLine {
  return { from: block.from, to: block.to, block }
}

function wrappedLine(view: EditorView, pos: number, side: number, inside: VisualLine): VisualLine {
  let coords = coordsAtPos(view, pos, side * 2)
  if (!coords)
    return inside
  let editorRect = view.dom.getBoundingClientRect()
  let y = (coords.top + coords.bottom) / 2
  let left = view.posAtCoords({ x: editorRect.left + 1, y })
  let right = view.posAtCoords({ x: editorRect.right - 1, y })
  if (left == null || right == null)
    return inside
  return {
    ...inside,
    from: Math.max(inside.from, Math.min(left, right)),
    to: Math.min(inside.to, Math.max(left, right)),
  }
}

/** From src/cursor.ts: resolve the block for a position, entering composite lines. */
function blockAt(view: EditorView, pos: number, side: number): BlockInfo {
  let line = view.lineBlockAt(pos)
  if (Array.isArray(line.type)) {
    // Array.isArray narrows the declared union to any[]; re-assert the
    // real element type so the loop below stays strictly typed.
    const children = line.type as readonly BlockInfo[]
    let best: BlockInfo | undefined
    for (let l of children) {
      if (l.from > pos)
        break
      if (l.to < pos)
        continue
      if (l.from < pos && l.to > pos)
        return l
      if (!best || (l.type == BlockType.Text && (best.type != l.type || (side < 0 ? l.from < pos : l.to > pos))))
        best = l
    }
    return best || line
  }
  return line
}

/** Result shape of tightDrawForLine/tightDrawForWidget (upstream drawForLine). */
interface DrawnLine { top: number; bottom: number; horizontal: number[] }

function tightRectanglesForRange(
  view: EditorView,
  className: string,
  range: SelectionRange,
): RectangleMarker[] {
  if (range.to <= view.viewport.from || range.from >= view.viewport.to)
    return []
  let from = Math.max(range.from, view.viewport.from), to = Math.min(range.to, view.viewport.to)
  let ltr = view.textDirection == Direction.LTR
  let content = view.contentDOM, contentRect = content.getBoundingClientRect(), base = getBase(view)
  // The origin of every BlockInfo coordinate. NOT contentRect.top: that is the
  // content border box, which sits `padding-top` above the first line box.
  let docTop = view.documentTop
  let lineElt = content.querySelector(".cm-line"), lineStyle = lineElt && window.getComputedStyle(lineElt)
  let leftSide = contentRect.left +
    (lineStyle ? parseInt(lineStyle.paddingLeft) + Math.min(0, parseInt(lineStyle.textIndent)) : 0)
  let rightSide = contentRect.right - (lineStyle ? parseInt(lineStyle.paddingRight) : 0)
  let startBlock = blockAt(view, from, 1), endBlock = blockAt(view, to, -1)
  let visualStart: VisualLine | null = startBlock.type == BlockType.Text ? wholeBlock(startBlock) : null
  let visualEnd: VisualLine | null = endBlock.type == BlockType.Text ? wholeBlock(endBlock) : null
  if (visualStart && (view.lineWrapping || startBlock.widgetLineBreaks))
    visualStart = wrappedLine(view, from, 1, visualStart)
  if (visualEnd && (view.lineWrapping || endBlock.widgetLineBreaks))
    visualEnd = wrappedLine(view, to, -1, visualEnd)
  if (visualStart && visualEnd && visualStart.from == visualEnd.from && visualStart.to == visualEnd.to) {
    return pieces(tightDrawForLine(range.from, range.to, visualStart))
  }
  else {
    let top = visualStart ? tightDrawForLine(range.from, null, visualStart) : tightDrawForWidget(startBlock, false)
    let bottom = visualEnd ? tightDrawForLine(null, range.to, visualEnd) : tightDrawForWidget(endBlock, true)
    let between: RectangleMarker[] = []
    if ((visualStart || startBlock).to < (visualEnd || endBlock).from - (visualStart && visualEnd ? 1 : 0) ||
      startBlock.widgetLineBreaks > 1 && top.bottom + view.defaultLineHeight / 2 < bottom.top) {
      // Modification B: instead of one full-width band over the intermediate
      // lines, draw each viewport line block strictly between the start
      // block's `to` and the end block's `from` on its own row. Both bounds
      // are open, so Modification A clamps each line's end to its text end;
      // empty lines fall to the fallback span and get a nub-width bar.
      let startTo = (visualStart || startBlock).to, endFrom = (visualEnd || endBlock).from
      // Invariant: every fully-selected visual row must be painted. Under
      // line wrapping (or widget line breaks) the start/end document lines
      // hold rows below/above the drawn top/bottom row, and no whole block
      // sits between, so those rows need explicit remainder bands clamped
      // to [top.bottom, bottom.top]. Soft-wrapped rows end at the wrap
      // margin anyway, so full-width bands match Typora visually; without
      // wrapping these spans are zero-width. BAND_EPSILON_PX keeps sub-pixel
      // rounding from producing hairline artifacts.
      let startBlockBottom = docTop + startBlock.bottom
      let endBlockTop = docTop + endBlock.top
      let startBandBottom = Math.min(startBlockBottom, bottom.top)
      if (startBandBottom - top.bottom > BAND_EPSILON_PX)
        between.push(piece(leftSide, top.bottom, rightSide, startBandBottom))
      for (let block of view.viewportLineBlocks)
        if (block.from >= startTo && block.to <= endFrom)
          between.push(...pieces(tightDrawForLine(null, null, wholeBlock(block))))
      // When the selection stays inside one soft-wrapped block, both remainder
      // spans describe the same rows. `startBandBottom` in the lower bound
      // collapses the second one to nothing — the selection background is
      // translucent, so painting a row twice makes it darker than its
      // neighbours. When the spans are genuinely disjoint it changes nothing.
      let endBandTop = Math.max(endBlockTop, top.bottom, startBandBottom)
      if (bottom.top - endBandTop > BAND_EPSILON_PX)
        between.push(piece(leftSide, endBandTop, rightSide, bottom.top))
    }
    // elementAtHeight takes a height relative to documentTop, not a client y.
    else if (top.bottom < bottom.top &&
      view.elementAtHeight((top.bottom + bottom.top) / 2 - docTop).type == BlockType.Text)
      top.bottom = bottom.top = (top.bottom + bottom.top) / 2
    return pieces(top).concat(between).concat(pieces(bottom))
  }
  function piece(left: number, top: number, right: number, bottom: number): RectangleMarker {
    return new RectangleMarker(className, left - base.left, top - base.top, Math.max(0, right - left), bottom - top)
  }
  function pieces({ top, bottom, horizontal }: DrawnLine): RectangleMarker[] {
    let pieces: RectangleMarker[] = []
    for (let i = 0; i < horizontal.length; i += 2)
      pieces.push(piece(horizontal[i], top, horizontal[i + 1], bottom))
    return pieces
  }
  // Gets passed from/to in line-local positions
  function tightDrawForLine(from: number | null, to: number | null, line: VisualLine): DrawnLine {
    let top = 1e9, bottom = -1e9, horizontal: number[] = []
    function addSpan(from: number, fromOpen: boolean, to: number, toOpen: boolean, dir: Direction) {
      // Passing 2/-2 is a kludge to force the view to return
      // coordinates on the proper side of block widgets, since
      // normalizing the side there, though appropriate for most
      // coordsAtPos queries, would break selection drawing.
      let fromCoords = coordsAtPos(view, from, (from == line.to ? -2 : 2))
      let toCoords = coordsAtPos(view, to, (to == line.from ? 2 : -2))
      if (!fromCoords || !toCoords)
        return
      top = Math.min(fromCoords.top, toCoords.top, top)
      bottom = Math.max(fromCoords.bottom, toCoords.bottom, bottom)
      if (dir == Direction.LTR) {
        // Modification A: clamp open line-END edges to the text end plus a
        // nub instead of extending to the content-box right edge.
        // Open line-START edges stay stock (leftSide) so every fully-selected
        // row shares one vertical left edge — matching VS Code / Typora.
        let spanLeft = ltr && fromOpen ? leftSide : fromCoords.left
        let spanRight = ltr && toOpen ? Math.min(rightSide, toCoords.right + NUB_PX) : toCoords.right
        horizontal.push(spanLeft, spanRight)
      }
      else {
        // Modification A, mirrored for RTL spans: the logical end renders on
        // the left, so the open end clamps to the text end minus a nub
        // instead of extending to the content-box left edge.
        let spanLeft = !ltr && toOpen ? Math.max(leftSide, toCoords.left - NUB_PX) : toCoords.left
        let spanRight = !ltr && fromOpen ? rightSide : fromCoords.right
        horizontal.push(spanLeft, spanRight)
      }
    }
    let start = from ?? line.from, end = to ?? line.to
    // Split the range by visible range and document line
    for (let r of view.visibleRanges)
      if (r.to > start && r.from < end) {
        for (let pos = Math.max(r.from, start), endPos = Math.min(r.to, end);;) {
          let docLine = view.state.doc.lineAt(pos)
          for (let span of view.bidiSpans(docLine)) {
            let spanFrom = span.from + docLine.from, spanTo = span.to + docLine.from
            if (spanFrom >= endPos)
              break
            if (spanTo > pos)
              addSpan(Math.max(spanFrom, pos), from == null && spanFrom <= start, Math.min(spanTo, endPos), to == null && spanTo >= end, span.dir)
          }
          pos = docLine.to + 1
          if (pos >= endPos)
            break
        }
      }
    if (horizontal.length == 0)
      addSpan(line.from, from == null, end, to == null, view.textDirection)
    // Modification C: coordsAtPos returns glyph metrics (textHeight). When
    // CSS line-height > 1 the line box is taller, so per-line markers leave
    // visible gaps between rows. Snap the vertical span outward onto the row
    // boxes of the line's own block, taken from CodeMirror's height map, so
    // each touched row fills its line box and adjacent rows abut — matching
    // mainstream editors — while Modification A keeps horizontal clamps tight
    // to text. Outward snap (not mid-line expand) also preserves empty-line
    // spans whose before-side start coord sits on the previous row.
    //
    // A document-wide grid does not work here: this editor's line boxes are
    // not uniform (headings are 1.25-1.8em, block widgets are arbitrary), so
    // `defaultLineHeight` is a default rather than a row pitch. Clamping into
    // the block also bounds the worst case — an imprecise snap can only ever
    // over-paint inside the same block, never onto a neighbouring line.
    if (top < bottom) {
      let blockTop = docTop + line.block.top, blockBottom = blockTop + line.block.height
      // Rows within one block are equal-height, so the block's own height
      // divides evenly; defaultLineHeight only estimates how many there are.
      let rows = Math.max(1, Math.round(line.block.height / view.defaultLineHeight))
      let rowHeight = line.block.height / rows
      top = Math.max(blockTop, blockTop + Math.floor((top - blockTop) / rowHeight + SNAP_EPSILON) * rowHeight)
      bottom = Math.min(blockBottom, blockTop + Math.ceil((bottom - blockTop) / rowHeight - SNAP_EPSILON) * rowHeight)
      if (bottom <= top)
        bottom = Math.min(blockBottom, top + rowHeight)
    }
    return { top, bottom, horizontal }
  }
  function tightDrawForWidget(block: BlockInfo, top: boolean): DrawnLine {
    let y = docTop + (top ? block.top : block.bottom)
    return { top: y, bottom: y, horizontal: [] }
  }
}

function configChanged(update: ViewUpdate) {
  return update.startState.facet(selectionConfig) != update.state.facet(selectionConfig)
}

export function tightCursorMarkers(view: EditorView): RectangleMarker[] {
  let { state } = view, conf = state.facet(selectionConfig)
  let cursors: RectangleMarker[] = []
  for (let r of state.selection.ranges) {
    let prim = r == state.selection.main
    if (r.empty || conf.drawRangeCursor) {
      let className = prim ? "cm-cursor cm-cursor-primary" : "cm-cursor cm-cursor-secondary"
      let cursor = r.empty ? r : EditorSelection.cursor(r.head, r.assoc)
      for (let piece of markersForRange(view, className, cursor))
        cursors.push(piece)
    }
  }
  return cursors
}

const cursorLayer = layer({
  above: true,
  markers: tightCursorMarkers,
  update(update, dom) {
    if (update.transactions.some(tr => tr.selection))
      dom.style.animationName = dom.style.animationName == "cm-blink" ? "cm-blink2" : "cm-blink"
    let confChange = configChanged(update)
    if (confChange)
      setBlinkRate(update.state, dom)
    return update.docChanged || update.selectionSet || confChange
  },
  mount(dom, view) {
    setBlinkRate(view.state, dom)
  },
  class: "cm-cursorLayer",
})

function setBlinkRate(state: EditorState, dom: HTMLElement) {
  dom.style.animationDuration = state.facet(selectionConfig).cursorBlinkRate + "ms"
}

export function tightSelectionMarkers(view: EditorView): RectangleMarker[] {
  let markers: RectangleMarker[] = [], { ranges } = view.state.selection
  for (let r of ranges)
    if (!r.empty) {
      for (let marker of markersForRange(view, "cm-selectionBackground", r))
        markers.push(marker)
    }
  return markers
}

const tightSelectionLayer = layer({
  above: false,
  markers: tightSelectionMarkers,
  update(update) {
    return update.docChanged || update.selectionSet || update.viewportChanged || configChanged(update)
  },
  class: "cm-selectionLayer",
})

// Vendored from upstream's private `browser` detection — only the Gecko bits
// are needed (Firefox 153 ignores transparent selection styling; Tauri
// webviews are never Gecko, but keep upstream behavior for parity).
const nav = typeof navigator != "undefined" ? navigator : { userAgent: "" }
const gecko = /gecko\/(\d+)/i.test(nav.userAgent)
// https://discuss.codemirror.net/t/firefox-153-ignores-transparent-selection-styling/9838
const selectionBg = gecko && +(/Firefox\/(\d+)/.exec(nav.userAgent) || [0, 0])[1] == 153 ? "#ffffff01" : "transparent"
const hideNativeSelection = Prec.highest(EditorView.theme({
  ".cm-line": {
    "& ::selection, &::selection": { backgroundColor: `${selectionBg} !important` },
    caretColor: "transparent !important",
  },
  ".cm-content": {
    caretColor: "transparent !important",
    "& :focus": {
      caretColor: "initial !important",
      "&::selection, & ::selection": {
        backgroundColor: "Highlight !important",
      },
    },
  },
}))
