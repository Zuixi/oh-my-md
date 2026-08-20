import { describe, expect, it } from "vitest"
import { EditorState } from "@codemirror/state"
import type { Extension, Line } from "@codemirror/state"
import { BlockType, Direction, EditorView } from "@codemirror/view"
import {
  NUB_PX,
  tightCursorMarkers,
  tightSelection,
  tightSelectionMarkers,
} from "../src/tightSelection"

// --- Fake-view geometry harness -------------------------------------------
//
// happy-dom has no layout engine (getBoundingClientRect returns zeros,
// EditorView#coordsAtPos returns null), so the vendored selection geometry
// cannot be exercised through a real view. This harness stubs the members
// tightSelection.ts reads with a fixed character grid (CHAR_W × LINE_H cells
// starting at CONTENT_LEFT/CONTENT_TOP) over a real EditorState document.
// The object is duck-typed and cast once to EditorView — the repo's
// documented cast pattern (see test/imagePaste.test.ts).
//
// Geometry model (verified against @codemirror/view 6.43.8 semantics:
// Line.to/Line.length exclude the terminator, and a negative `side` bases
// the rect on the element before the position):
// - coordsAtPos(pos, side >= 0) covers the character cell at `pos` on the
//   position's own row; a position at/past a line's text end collapses to a
//   zero-width rect at the text end (no glyph follows).
// - coordsAtPos(pos, side < 0) covers the character cell preceding `pos`;
//   at a line-break position that resolves to a zero-width rect at the end
//   of the previous visual line.
// - viewportLineBlocks entries are plain objects shaped like BlockInfo (the
//   real constructor is @internal in the package's .d.ts).
// - With `wrapColumn`, each document line soft-wraps into rows of that many
//   characters (one block per line, height = rows × LINE_H, block tops
//   document-relative like real BlockInfo); `posAtCoords` maps y → row then
//   x → col so `wrappedLine()` narrowing works through these stubs.

const CHAR_W = 8 // fake character cell width (px)
const LINE_H = 20 // fake line height (px)
const CONTENT_LEFT = 100 // fake content-box left edge (px)
const CONTENT_TOP = 50 // fake content-box top edge (px)
const CONTENT_RIGHT = 700 // fake content-box right edge (px)
const WRAP_COL = 20 // fake soft-wrap column (characters per visual row)

interface FakeBlock {
  from: number
  to: number
  top: number
  bottom: number
  type: BlockType
  widgetLineBreaks: number
}

/** Right edge of a marker (range markers always carry a width). */
const rightEdge = (m: { left: number; width: number | null }) =>
  m.left + (m.width ?? Number.NaN)

interface FakeViewSpec {
  doc: string
  anchor: number
  head?: number
  textDirection?: Direction
  /** 1-based line numbers rendered as a single RTL bidi span. */
  rtlLines?: number[]
  extensions?: Extension[]
  /**
   * Soft-wrap visual rows at this many characters per row (turns
   * `lineWrapping` on; one block per document line spanning all its rows).
   */
  wrapColumn?: number
}

function makeFakeView(spec: FakeViewSpec): EditorView {
  const state = EditorState.create({
    doc: spec.doc,
    selection: { anchor: spec.anchor, head: spec.head ?? spec.anchor },
    extensions: spec.extensions ?? [],
  })
  const doc = state.doc
  const wrap = spec.wrapColumn ?? 0
  const lines: Line[] = []
  for (let i = 1; i <= doc.lines; i++) lines.push(doc.line(i))
  // Block tops are document-relative, like real BlockInfo (the module maps
  // them through contentRect.top, mirroring upstream's drawForWidget).
  const rowsOf = (line: Line) =>
    wrap > 0 ? Math.max(1, Math.ceil(line.length / wrap)) : 1
  const blocks: FakeBlock[] = []
  const blockTops: number[] = []
  let docTop = 0
  for (const line of lines) {
    blockTops.push(docTop)
    blocks.push({
      from: line.from,
      to: line.to,
      top: docTop,
      bottom: docTop + rowsOf(line) * LINE_H,
      type: BlockType.Text,
      widgetLineBreaks: 0,
    })
    docTop += rowsOf(line) * LINE_H
  }
  // Cell of the glyph at index `glyph` within the line; glyph == length is
  // the collapsed line-end caret on the line's last row.
  const glyphCell = (line: Line, glyph: number) => {
    const row = wrap > 0 ? Math.min(Math.floor(glyph / wrap), rowsOf(line) - 1) : 0
    const x = CONTENT_LEFT + (glyph - row * wrap) * CHAR_W
    const top = CONTENT_TOP + blockTops[line.number - 1] + row * LINE_H
    return { x, top, bottom: top + LINE_H }
  }
  const coordsAtPos = (pos: number, side = 1) => {
    if (side < 0 && pos > 0 && pos < doc.length && doc.lineAt(pos).from === pos) {
      const prev = doc.lineAt(pos - 1)
      const end = glyphCell(prev, prev.length)
      return { left: end.x, right: end.x, top: end.top, bottom: end.bottom }
    }
    const line = doc.lineAt(pos)
    const len = line.length
    const col = Math.min(pos - line.from, len)
    if (side < 0 && col > 0) {
      // Negative side: the rect of the character preceding the position.
      const cell = glyphCell(line, col - 1)
      return { left: cell.x, right: cell.x + CHAR_W, top: cell.top, bottom: cell.bottom }
    }
    if (col < len) {
      const cell = glyphCell(line, col)
      return { left: cell.x, right: cell.x + CHAR_W, top: cell.top, bottom: cell.bottom }
    }
    const end = glyphCell(line, len)
    return { left: end.x, right: end.x, top: end.top, bottom: end.bottom }
  }
  const posAtCoords = ({ x, y }: { x: number; y: number }): number | null => {
    if (!wrap) return null
    const block = blocks.find(b => CONTENT_TOP + b.top <= y && y < CONTENT_TOP + b.bottom)
    if (!block) return null
    const line = doc.lineAt(block.from)
    const row = Math.max(0, Math.min(
      Math.floor((y - CONTENT_TOP - block.top) / LINE_H), rowsOf(line) - 1))
    const rowLen = Math.min(wrap, line.length - row * wrap)
    const col = Math.max(0, Math.min(Math.round((x - CONTENT_LEFT) / CHAR_W), rowLen))
    return line.from + row * wrap + col
  }
  const bidiSpans = (line: Line) => {
    // One span covering the whole line including its terminator; RTL lines
    // get level 1 so the span direction mirrors an RTL run.
    const rtl = spec.rtlLines?.includes(line.number) ?? false
    return [{ from: 0, to: line.length, dir: rtl ? Direction.RTL : Direction.LTR }]
  }
  const fakeRect = () =>
    new DOMRect(CONTENT_LEFT, CONTENT_TOP, CONTENT_RIGHT - CONTENT_LEFT, 300)
  const contentDOM = document.createElement("div")
  contentDOM.getBoundingClientRect = fakeRect
  const scrollDOM = document.createElement("div")
  scrollDOM.getBoundingClientRect = fakeRect
  Object.defineProperty(scrollDOM, "clientWidth", {
    value: CONTENT_RIGHT - CONTENT_LEFT,
  })
  const dom = document.createElement("div")
  dom.getBoundingClientRect = fakeRect
  return {
    state,
    viewport: { from: 0, to: doc.length },
    visibleRanges: [{ from: 0, to: doc.length }],
    viewportLineBlocks: blocks,
    textDirection: spec.textDirection ?? Direction.LTR,
    lineWrapping: wrap > 0,
    scaleX: 1,
    scaleY: 1,
    defaultLineHeight: LINE_H,
    coordsAtPos,
    posAtCoords,
    lineBlockAt: (pos: number) =>
      blocks.find(b => b.from <= pos && pos <= b.to) ?? blocks[blocks.length - 1],
    elementAtHeight: (h: number) =>
      blocks.find(b => CONTENT_TOP + b.top <= h && h < CONTENT_TOP + b.bottom) ?? blocks[blocks.length - 1],
    bidiSpans,
    contentDOM,
    scrollDOM,
    dom,
  } as unknown as EditorView
}

describe("tightSelection geometry (fake view)", () => {
  it("single-line range: one marker ending at the text end without a nub", () => {
    const view = makeFakeView({ doc: "abc", anchor: 0, head: 3 })
    const markers = tightSelectionMarkers(view)
    expect(markers).toHaveLength(1)
    const marker = markers[0]
    expect(marker.left).toBe(0)
    expect(marker.width).toBe(3 * CHAR_W) // text end, not text end + NUB_PX
    expect(marker.top).toBe(0)
    expect(marker.height).toBe(LINE_H)
  })

  it("multi-line range: per-line markers with open ends clamped to text end + nub", () => {
    const view = makeFakeView({ doc: "abc\ndefg\nhij", anchor: 1, head: 11 })
    const markers = tightSelectionMarkers(view)
    expect(markers).toHaveLength(3)
    const [top, middle, bottom] = markers
    // Top line: starts at the first selected glyph, ends at the top line's
    // text end + nub — not at the content right edge.
    expect(top.left).toBe(CHAR_W)
    expect(rightEdge(top)).toBe(3 * CHAR_W + NUB_PX)
    expect(top.top).toBe(0)
    // Middle line: full line drawn on its own row, ending at its own text
    // end + nub instead of one full-width band across the gap.
    expect(middle.left).toBe(0)
    expect(rightEdge(middle)).toBe(4 * CHAR_W + NUB_PX)
    expect(middle.top).toBe(LINE_H)
    // Bottom line: starts at leftSide, ends at the selected text end.
    expect(bottom.left).toBe(0)
    expect(rightEdge(bottom)).toBe(2 * CHAR_W)
    expect(bottom.top).toBe(2 * LINE_H)
  })

  it("empty middle line: nub-width bar, never a full-width band", () => {
    const view = makeFakeView({ doc: "abc\n\nhij", anchor: 1, head: 8 })
    const markers = tightSelectionMarkers(view)
    expect(markers).toHaveLength(3)
    // The empty line's fallback span starts at leftSide and its open end
    // clamps to the (empty) text end + nub. Its before-side start rect sits
    // at the previous line's end, so it may cover part of the row above.
    const emptyLine = markers.find(m => m.width === NUB_PX)
    expect(emptyLine).toBeDefined()
    expect(emptyLine!.left).toBe(0)
    expect(emptyLine!.top).toBeLessThanOrEqual(LINE_H)
    expect(emptyLine!.top + emptyLine!.height).toBeGreaterThanOrEqual(2 * LINE_H)
    // No marker anywhere approaches the content width.
    expect(markers.every(m => m.width !== null && m.width < 10 * CHAR_W)).toBe(true)
  })

  it("RTL bidi span in an RTL editor: end clamp lands on the left/text end", () => {
    const view = makeFakeView({
      doc: "abc\nשלום\nabc",
      anchor: 1,
      head: 12,
      textDirection: Direction.RTL,
      rtlLines: [2],
    })
    const markers = tightSelectionMarkers(view)
    expect(markers).toHaveLength(3)
    const middle = markers[1]
    expect(middle.top).toBe(LINE_H)
    // The RTL span's logical end renders on the left: the open end clamps to
    // the last glyph's left edge minus the nub instead of extending to the
    // content-box left edge (leftSide would put the marker's left edge at 0).
    expect(middle.left).toBe(3 * CHAR_W - NUB_PX)
    expect(middle.left).not.toBe(0)
  })

  it("wrapped start line: tight top row, full-width remainder band, tight middle/bottom lines", () => {
    // Line 1 soft-wraps into 3 rows of 20/20/10 chars; the selection starts
    // mid row 0 and ends mid line 3.
    const view = makeFakeView({
      doc: `${"a".repeat(50)}\nshort\nlast`,
      anchor: 10,
      head: 59,
      wrapColumn: WRAP_COL,
    })
    const markers = tightSelectionMarkers(view)
    expect(markers).toHaveLength(4)
    const [topRow, band, middle, bottom] = markers
    // Top row: tight bar ending at the row's text end + nub.
    expect(topRow.top).toBe(0)
    expect(rightEdge(topRow)).toBe(WRAP_COL * CHAR_W + NUB_PX)
    // Remainder band: full width, covering exactly rows 1-2 of the wrapped
    // start block (the rows below the drawn top row).
    expect(band.left).toBe(0)
    expect(band.width).toBe(CONTENT_RIGHT - CONTENT_LEFT)
    expect(band.top).toBe(LINE_H)
    expect(band.top + band.height).toBe(3 * LINE_H)
    // Whole intermediate line keeps its tight per-line bar.
    expect(middle.top).toBe(3 * LINE_H)
    expect(rightEdge(middle)).toBe(5 * CHAR_W + NUB_PX)
    // Bottom line tight as before (single row, no remainder above it).
    expect(bottom.top).toBe(4 * LINE_H)
    expect(rightEdge(bottom)).toBe(2 * CHAR_W)
  })

  it("selection within one wrapped line: every visual row painted", () => {
    // One 50-char line wrapping into 3 rows; selection spans row 0 into
    // row 2 — no whole block is ever "between", so the middle row only
    // gets painted by the remainder bands.
    const view = makeFakeView({ doc: "a".repeat(50), anchor: 5, head: 45, wrapColumn: WRAP_COL })
    const markers = tightSelectionMarkers(view)
    // Row 0: tight bar from the selection start to the row text end + nub.
    const row0 = markers.find(m => m.top === 0)
    expect(row0).toBeDefined()
    expect(row0!.left).toBe(5 * CHAR_W)
    expect(rightEdge(row0!)).toBe(WRAP_COL * CHAR_W + NUB_PX)
    // Row 1: full-width remainder band with the exact vertical span.
    const band = markers.find(m => m.top === LINE_H && m.width === CONTENT_RIGHT - CONTENT_LEFT)
    expect(band).toBeDefined()
    expect(band!.top + band!.height).toBe(2 * LINE_H)
    // Row 2: tight bar from the row start to the selection end.
    const row2 = markers.find(m => m.top === 2 * LINE_H)
    expect(row2).toBeDefined()
    expect(row2!.left).toBe(0)
    expect(rightEdge(row2!)).toBe(5 * CHAR_W)
    // Every visual row of the line is covered by at least one marker.
    for (let row = 0; row < 3; row++) {
      const rowTop = row * LINE_H
      expect(markers.some(m => m.top <= rowTop && m.top + m.height >= rowTop + LINE_H)).toBe(true)
    }
  })

  it("cursor layer: empty range draws a cursor; non-empty honors drawRangeCursor", () => {
    const caret = tightCursorMarkers(makeFakeView({ doc: "abc", anchor: 2 }))
    expect(caret).toHaveLength(1)
    expect(caret[0].width).toBeNull() // cursors get no width style
    expect(caret[0].left).toBe(2 * CHAR_W)
    expect(caret[0].top).toBe(0)

    const range = tightCursorMarkers(makeFakeView({ doc: "abc", anchor: 0, head: 3 }))
    expect(range).toHaveLength(1) // drawRangeCursor defaults to true
    expect(range[0].width).toBeNull()

    const noRangeCursor = tightCursorMarkers(makeFakeView({
      doc: "abc",
      anchor: 0,
      head: 3,
      extensions: [tightSelection({ drawRangeCursor: false })],
    }))
    expect(noRangeCursor).toHaveLength(0)
  })

  it("composes with a real EditorView without exceptions and mounts both layers", async () => {
    const errors: unknown[] = []
    const parent = document.createElement("div")
    document.body.appendChild(parent)
    const view = new EditorView({
      state: EditorState.create({
        doc: "abc\ndef",
        selection: { anchor: 0, head: 7 }, // non-empty: exercises the range path
        extensions: [tightSelection(), EditorView.exceptionSink.of(e => { errors.push(e) })],
      }),
      parent,
    })
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(errors.map(String)).toEqual([])
    expect(view.dom.querySelector(".cm-layer.cm-selectionLayer")).toBeTruthy()
    expect(view.dom.querySelector(".cm-layer.cm-cursorLayer")).toBeTruthy()
    view.destroy()
  })
})
