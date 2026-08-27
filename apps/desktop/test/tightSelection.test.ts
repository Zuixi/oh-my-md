import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
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
//   real constructor is @internal in the package's .d.ts), with `top`/`height`
//   relative to `view.documentTop` exactly like the real height map.
// - With `wrapColumn`, each document line soft-wraps into rows of that many
//   characters (one block per line, height = rows × the line's box height,
//   block tops document-relative like real BlockInfo); `posAtCoords` maps
//   y → row then x → col so `wrappedLine()` narrowing works through these stubs.
//
// Three properties of the real editor are modeled deliberately, because the
// geometry code has been wrong about all of them:
// - `.cm-content` has a non-zero padding-top (CONTENT_PAD_TOP), so the first
//   line box starts *below* the content box top. `view.documentTop` — not
//   `contentRect.top` — is the origin of every BlockInfo coordinate.
// - `.cm-content` has non-zero horizontal padding (CONTENT_PAD_LEFT/RIGHT), so
//   `contentRect.left` is the border box, not where text starts. Upstream can
//   ignore this because stock `.cm-content` has no horizontal padding.
// - Line boxes are not uniform (`lineHeights`): headings are 1.25–1.8em and
//   block widgets have arbitrary heights, so `defaultLineHeight` is a default,
//   never a document-wide row pitch.

const CHAR_W = 8 // fake character cell width (px)
const LINE_H = 20 // fake default line-box height (px)
// Glyph client-rect height — WebKit (Tauri) returns text metrics shorter than
// the line box when line-height > 1. Modeling that gap is what surfaces the
// striped multi-line selection bug.
const TEXT_H = 14 // fake glyph/textHeight (px) at LINE_H; must stay < LINE_H
const CONTENT_LEFT = 100 // fake `.cm-content` border-box left edge (px)
const CONTENT_TOP = 50 // fake `.cm-content` border-box top edge (px)
const CONTENT_RIGHT = 700 // fake `.cm-content` border-box right edge (px)
const CONTENT_PAD_TOP = 16 // fake `.cm-content` padding-top (px); must stay > 0
const CONTENT_PAD_LEFT = 24 // fake `.cm-content` padding-left (px); must stay > 0
const CONTENT_PAD_RIGHT = 24 // fake `.cm-content` padding-right (px); must stay > 0
const DOC_TOP = CONTENT_TOP + CONTENT_PAD_TOP // fake view.documentTop
const WRAP_COL = 20 // fake soft-wrap column (characters per visual row)

interface FakeBlock {
  from: number
  to: number
  top: number
  bottom: number
  height: number
  type: BlockType
  widgetLineBreaks: number
}

/** Right edge of a marker (range markers always carry a width). */
const rightEdge = (m: { left: number; width: number | null }) =>
  m.left + (m.width ?? Number.NaN)

/** Marker-space top of visual row `row` in a uniform-line-height document. */
const rowTop = (row: number) => CONTENT_PAD_TOP + row * LINE_H

// Marker coordinates are relative to `base.left`, i.e. the content border box.
/** Marker-space x of glyph column `col`, i.e. where text actually starts. */
const textX = (col: number) => CONTENT_PAD_LEFT + col * CHAR_W
/** Marker-space right edge that full-width remainder bands must stop at. */
const RIGHT_SIDE = CONTENT_RIGHT - CONTENT_LEFT - CONTENT_PAD_RIGHT

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
  /**
   * `.cm-line` padding-left (px) for leftSide. Glyph coords stay un-padded so
   * tests can reproduce code-block/widget lines where leftSide sits left of text.
   */
  linePaddingLeft?: number
  /**
   * Extra px per 1-based line number added to glyph x (simulates omd-li-N padding).
   */
  lineNestIndent?: number
  /**
   * When set, visible ranges skip this many leading chars on every line (hidden
   * list-indent / syntax folds still in the document selection).
   */
  hiddenPrefixChars?: number
  /**
   * Line-box height (px) per 1-based line number; lines without an entry use
   * LINE_H. Models headings and block widgets, whose boxes are taller than
   * `defaultLineHeight`.
   */
  lineHeights?: Record<number, number>
  /**
   * CodeMirror's measured default font line height. WebKit/font metrics can
   * differ from a wrapped block's actual row pitch, so this must be
   * independently configurable rather than derived from LINE_H.
   */
  defaultLineHeight?: number
}

// The harness stubs computed styles for its own detached elements; the real
// EditorView test at the bottom of this file needs the genuine implementation.
const nativeGetComputedStyle = window.getComputedStyle.bind(window)
afterEach(() => {
  window.getComputedStyle = nativeGetComputedStyle as typeof window.getComputedStyle
})

/** A line box in marker coordinates (marker `top` is relative to `base.top`). */
interface Box { top: number; bottom: number }

/**
 * Per-document-line geometry shared by the fake view and the assertions, so a
 * test can say "this marker must equal line 2's box" without restating layout.
 */
function geometryOf(spec: FakeViewSpec) {
  const wrap = spec.wrapColumn ?? 0
  const lengths = spec.doc.split("\n").map(l => l.length)
  const rowsOf = (lineNumber: number) =>
    wrap > 0 ? Math.max(1, Math.ceil(lengths[lineNumber - 1] / wrap)) : 1
  const rowHeightOf = (lineNumber: number) => spec.lineHeights?.[lineNumber] ?? LINE_H
  // Document-relative block tops, i.e. relative to view.documentTop.
  const blockTops: number[] = []
  let docTop = 0
  for (let n = 1; n <= lengths.length; n++) {
    blockTops.push(docTop)
    docTop += rowsOf(n) * rowHeightOf(n)
  }
  return { wrap, rowsOf, rowHeightOf, blockTops }
}

/**
 * Line boxes in marker coordinates. `base.top` is the scroll DOM top
 * (CONTENT_TOP), so a marker sitting exactly on line 1 has `top` equal to the
 * content padding — never 0.
 */
function boxes(spec: FakeViewSpec): Box[] {
  const { rowsOf, rowHeightOf, blockTops } = geometryOf(spec)
  return blockTops.map((top, i) => ({
    top: CONTENT_PAD_TOP + top,
    bottom: CONTENT_PAD_TOP + top + rowsOf(i + 1) * rowHeightOf(i + 1),
  }))
}

/**
 * The invariant that generalizes past any single geometry bug: a selection may
 * only paint inside the line boxes of the lines it actually covers. Bleeding
 * onto a neighbouring row is the whole class of defect this suite guards.
 */
function expectConfinedToLines(
  markers: readonly { top: number; height: number | null }[],
  spec: FakeViewSpec,
  selectedLines: readonly number[],
): void {
  const covered = selectedLines.map(n => boxes(spec)[n - 1])
  const lo = Math.min(...covered.map(b => b.top))
  const hi = Math.max(...covered.map(b => b.bottom))
  for (const m of markers) {
    expect(m.top).toBeGreaterThanOrEqual(lo)
    expect(m.top + (m.height ?? 0)).toBeLessThanOrEqual(hi)
  }
}

function makeFakeView(spec: FakeViewSpec): EditorView {
  const state = EditorState.create({
    doc: spec.doc,
    selection: { anchor: spec.anchor, head: spec.head ?? spec.anchor },
    extensions: spec.extensions ?? [],
  })
  const doc = state.doc
  const { wrap, rowsOf, rowHeightOf, blockTops } = geometryOf(spec)
  const lines: Line[] = []
  for (let i = 1; i <= doc.lines; i++) lines.push(doc.line(i))
  // Block tops/heights are relative to view.documentTop, like real BlockInfo.
  const blocks: FakeBlock[] = lines.map(line => ({
    from: line.from,
    to: line.to,
    top: blockTops[line.number - 1],
    bottom: blockTops[line.number - 1] + rowsOf(line.number) * rowHeightOf(line.number),
    height: rowsOf(line.number) * rowHeightOf(line.number),
    type: BlockType.Text,
    widgetLineBreaks: 0,
  }))
  // Cell of the glyph at index `glyph` within the line; glyph == length is
  // the collapsed line-end caret on the line's last row.
  const glyphCell = (line: Line, glyph: number) => {
    const rowH = rowHeightOf(line.number)
    const row = wrap > 0 ? Math.min(Math.floor(glyph / wrap), rowsOf(line.number) - 1) : 0
    const nest = spec.lineNestIndent ?? 0
    const x = CONTENT_LEFT + CONTENT_PAD_LEFT + (line.number - 1) * nest + (glyph - row * wrap) * CHAR_W
    const rowTop = DOC_TOP + blockTops[line.number - 1] + row * rowH
    // Center the shorter glyph rect inside the line box (half-leading above/below).
    const glyphH = rowH * (TEXT_H / LINE_H)
    const top = rowTop + (rowH - glyphH) / 2
    return { x, top, bottom: top + glyphH }
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
    const block = blocks.find(b => DOC_TOP + b.top <= y && y < DOC_TOP + b.bottom)
    if (!block) return null
    const line = doc.lineAt(block.from)
    const row = Math.max(0, Math.min(
      Math.floor((y - DOC_TOP - block.top) / rowHeightOf(line.number)), rowsOf(line.number) - 1))
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
  const lineElt = document.createElement("div")
  lineElt.className = "cm-line"
  contentDOM.appendChild(lineElt)
  const fakeStyle = (paddingLeft: number, paddingRight: number) => ({
    paddingLeft: String(paddingLeft),
    paddingRight: String(paddingRight),
    textIndent: "0",
  } as CSSStyleDeclaration)
  const styles = new Map<Element, CSSStyleDeclaration>([
    [contentDOM, fakeStyle(CONTENT_PAD_LEFT, CONTENT_PAD_RIGHT)],
    [lineElt, fakeStyle(spec.linePaddingLeft ?? 0, 0)],
  ])
  window.getComputedStyle = ((elt: Element) =>
    styles.get(elt) ?? nativeGetComputedStyle(elt)) as typeof window.getComputedStyle
  const scrollDOM = document.createElement("div")
  scrollDOM.getBoundingClientRect = fakeRect
  Object.defineProperty(scrollDOM, "clientWidth", {
    value: CONTENT_RIGHT - CONTENT_LEFT,
  })
  const dom = document.createElement("div")
  dom.getBoundingClientRect = fakeRect
  const hiddenPrefix = spec.hiddenPrefixChars ?? 0
  const visibleRanges = hiddenPrefix > 0
    ? lines.flatMap(line => {
        const skip = Math.min(hiddenPrefix, line.length)
        const from = line.from + skip
        return from < line.to ? [{ from, to: line.to }] : []
      })
    : [{ from: 0, to: doc.length }]
  return {
    state,
    viewport: { from: 0, to: doc.length },
    visibleRanges,
    viewportLineBlocks: blocks,
    textDirection: spec.textDirection ?? Direction.LTR,
    lineWrapping: wrap > 0,
    scaleX: 1,
    scaleY: 1,
    defaultLineHeight: spec.defaultLineHeight ?? LINE_H,
    documentTop: DOC_TOP,
    coordsAtPos,
    posAtCoords,
    lineBlockAt: (pos: number) =>
      blocks.find(b => b.from <= pos && pos <= b.to) ?? blocks[blocks.length - 1],
    // Real `elementAtHeight` takes a height relative to documentTop, not a
    // client y — passing a client y is the bug this stub is strict about.
    elementAtHeight: (h: number) =>
      blocks.find(b => b.top <= h && h < b.bottom) ?? blocks[blocks.length - 1],
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
    expect(marker.left).toBe(textX(0))
    expect(marker.width).toBe(3 * CHAR_W) // text end, not text end + NUB_PX
    expect(marker.top).toBe(rowTop(0))
    expect(marker.height).toBe(LINE_H)
  })

  it("open line starts align with the text, not the content border box", () => {
    // Typora keeps every fully-selected row flush with the text's left edge.
    // Upstream's leftSide adds only the `.cm-line` padding to contentRect.left,
    // which is the border box — stock `.cm-content` has no horizontal padding,
    // ours has 24px, so the bars used to overhang the text on the left.
    const view = makeFakeView({ doc: "abc\ndefg\nhij", anchor: 1, head: 11 })
    const [, middle, bottom] = tightSelectionMarkers(view)
    expect(middle.left).toBe(textX(0))
    expect(bottom.left).toBe(textX(0))
  })

  it("single-line range: the marker stays inside its own line box", () => {
    // Regression: the vertical snap used contentRect.top as the document
    // origin, so the content's padding-top shifted every marker up by that
    // padding and stretched it across the neighbouring rows.
    const spec: FakeViewSpec = { doc: "abc\ndefg\nhij", anchor: 5, head: 8 }
    const markers = tightSelectionMarkers(makeFakeView(spec))
    expect(markers).toHaveLength(1)
    const [line2] = boxes(spec).slice(1)
    expect(markers[0].top).toBe(line2.top)
    expect(markers[0].top + markers[0].height).toBe(line2.bottom)
    expectConfinedToLines(markers, spec, [2])
  })

  it("selection inside one wrapped row never expands into the next row", () => {
    // WKWebView can report a default font line height that differs from the
    // actual row pitch of a wrapped block. Inferring row count from
    // block.height/defaultLineHeight then snaps a one-row selection across
    // two rows. A selection whose endpoints resolve to the same visual row
    // must use their actual coordinates instead.
    const spec: FakeViewSpec = {
      doc: "a".repeat(50),
      anchor: 2,
      head: 12,
      wrapColumn: WRAP_COL,
      defaultLineHeight: 14,
    }
    const markers = tightSelectionMarkers(makeFakeView(spec))
    expect(markers).toHaveLength(1)
    expect(markers[0].top).toBeGreaterThanOrEqual(rowTop(0))
    expect(markers[0].height).toBeGreaterThanOrEqual(TEXT_H)
    expect(markers[0].top + markers[0].height).toBeLessThanOrEqual(rowTop(1))
  })

  it("selection on an unwrapped line still fills its row when wrapping is enabled", () => {
    const view = makeFakeView({
      doc: "short",
      anchor: 1,
      head: 4,
      wrapColumn: WRAP_COL,
    })
    const markers = tightSelectionMarkers(view)
    expect(markers).toHaveLength(1)
    expect(markers[0].top).toBe(rowTop(0))
    expect(markers[0].height).toBe(LINE_H)
  })

  it("selection below a taller line is not displaced by the line-height grid", () => {
    // Regression: snapping onto a defaultLineHeight grid drifts as soon as any
    // line is taller than the default (headings are 1.25-1.8em, block widgets
    // are arbitrary), and the drift accumulates down the document.
    const spec: FakeViewSpec = {
      doc: "Title\nbody\ntail",
      anchor: 6,
      head: 10,
      lineHeights: { 1: 2.5 * LINE_H },
    }
    const markers = tightSelectionMarkers(makeFakeView(spec))
    expect(markers).toHaveLength(1)
    const [, line2] = boxes(spec)
    expect(markers[0].top).toBe(line2.top)
    expect(markers[0].top + markers[0].height).toBe(line2.bottom)
    expectConfinedToLines(markers, spec, [2])
  })

  it("selection covering a taller line fills that line's own box", () => {
    const spec: FakeViewSpec = {
      doc: "Title\nbody\ntail",
      anchor: 1,
      head: 13,
      lineHeights: { 1: 2.5 * LINE_H },
    }
    const markers = tightSelectionMarkers(makeFakeView(spec))
    const [heading, body] = boxes(spec)
    // The heading's bar is as tall as the heading's own box, not defaultLineHeight.
    expect(markers[0].top).toBe(heading.top)
    expect(markers[0].height).toBe(heading.bottom - heading.top)
    expect(markers[1].top).toBe(body.top)
    expectConfinedToLines(markers, spec, [1, 2, 3])
  })

  it("multi-line range: per-line markers with open ends clamped to text end + nub", () => {
    const view = makeFakeView({ doc: "abc\ndefg\nhij", anchor: 1, head: 11 })
    const markers = tightSelectionMarkers(view)
    expect(markers).toHaveLength(3)
    const [top, middle, bottom] = markers
    // Top line: starts at the first selected glyph, ends at the top line's
    // text end + nub — not at the content right edge.
    expect(top.left).toBe(textX(1))
    expect(rightEdge(top)).toBe(textX(3) + NUB_PX)
    expect(top.top).toBe(rowTop(0))
    // Middle line: full line drawn on its own row at the shared leftSide,
    // ending at its own text end + nub instead of one full-width band.
    expect(middle.left).toBe(textX(0))
    expect(rightEdge(middle)).toBe(textX(4) + NUB_PX)
    expect(middle.top).toBe(rowTop(1))
    // Bottom line: starts at the line's text start, ends at the selected text end.
    expect(bottom.left).toBe(textX(0))
    expect(rightEdge(bottom)).toBe(textX(2))
    expect(bottom.top).toBe(rowTop(2))
  })

  it("multi-line range: open line starts align at leftSide, not per-line glyph padding", () => {
    // VS Code / Typora: fully-selected rows share one vertical left edge
    // (content padding), even when nested lists or hidden syntax shift glyphs.
    const view = makeFakeView({
      doc: "abc\ndefg\nhij",
      anchor: 1,
      head: 11,
      linePaddingLeft: 32,
    })
    const markers = tightSelectionMarkers(view)
    expect(markers).toHaveLength(3)
    const [, middle, bottom] = markers
    expect(middle.left).toBe(CONTENT_PAD_LEFT + 32)
    expect(bottom.left).toBe(CONTENT_PAD_LEFT + 32)
  })

  it("multi-line range: open line starts ignore per-line nest indent", () => {
    const view = makeFakeView({
      doc: "abc\ndefg\nhij",
      anchor: 1,
      head: 11,
      lineNestIndent: 3 * CHAR_W,
      linePaddingLeft: 32,
    })
    const markers = tightSelectionMarkers(view)
    expect(markers).toHaveLength(3)
    const [, middle, bottom] = markers
    expect(middle.left).toBe(CONTENT_PAD_LEFT + 32)
    expect(bottom.left).toBe(CONTENT_PAD_LEFT + 32)
    expect(middle.left).not.toBe(textX(3))
    expect(bottom.left).not.toBe(textX(6))
  })

  it("multi-line range: hidden list-indent prefix still uses unified leftSide", () => {
    const view = makeFakeView({
      doc: "abc\n    defg\nhij",
      anchor: 1,
      head: 13,
      hiddenPrefixChars: 4,
      linePaddingLeft: 48,
    })
    const markers = tightSelectionMarkers(view)
    const middle = markers[1]
    expect(middle.left).toBe(CONTENT_PAD_LEFT + 48)
  })

  it("multi-line range: per-line markers fill the line box and abut with no vertical gaps", () => {
    // Regression: coordsAtPos returns TEXT_H < LINE_H (WebKit). Markers must
    // expand to the line box so adjacent rows share an edge — otherwise the
    // selection reads as striped bands instead of a continuous highlight.
    const view = makeFakeView({ doc: "abc\ndefg\nhij", anchor: 1, head: 11 })
    const markers = tightSelectionMarkers(view)
    expect(markers).toHaveLength(3)
    const [top, middle, bottom] = markers
    for (const m of markers) expect(m.height).toBe(LINE_H)
    expect(top.top).toBe(rowTop(0))
    expect(middle.top).toBe(top.top + top.height)
    expect(bottom.top).toBe(middle.top + middle.height)
    // Horizontal tight clamps stay intact (open ends still stop at text + nub).
    expect(rightEdge(top)).toBe(textX(3) + NUB_PX)
    expect(rightEdge(middle)).toBe(textX(4) + NUB_PX)
    expect(rightEdge(bottom)).toBe(textX(2))
  })

  it("empty middle line: nub-width bar confined to its own line box", () => {
    const spec: FakeViewSpec = { doc: "abc\n\nhij", anchor: 1, head: 8 }
    const markers = tightSelectionMarkers(makeFakeView(spec))
    expect(markers).toHaveLength(3)
    // The empty line's fallback span starts at the line text start and its open
    // end clamps to the (empty) text end + nub. Its before-side start rect sits
    // on the previous row, so the bar must be clamped back to its own box.
    const emptyLine = markers.find(m => m.width === NUB_PX)
    expect(emptyLine).toBeDefined()
    expect(emptyLine!.left).toBe(textX(0))
    expect(emptyLine!.top).toBe(rowTop(1))
    expect(emptyLine!.height).toBe(LINE_H)
    // No marker anywhere approaches the content width.
    expect(markers.every(m => m.width !== null && m.width < 10 * CHAR_W)).toBe(true)
    expectConfinedToLines(markers, spec, [1, 2, 3])
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
    expect(middle.top).toBe(rowTop(1))
    // The RTL span's logical end renders on the left: the open end clamps to
    // the last glyph's left edge minus the nub instead of extending to the
    // content-box left edge.
    expect(middle.left).toBe(textX(3) - NUB_PX)
    expect(middle.left).not.toBe(textX(0))
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
    expect(topRow.top).toBe(rowTop(0))
    expect(rightEdge(topRow)).toBe(textX(WRAP_COL) + NUB_PX)
    // Remainder band: spans the text column (content box, not border box),
    // covering exactly rows 1-2 of the wrapped start block.
    expect(band.left).toBe(textX(0))
    expect(rightEdge(band)).toBe(RIGHT_SIDE)
    expect(band.top).toBe(rowTop(1))
    expect(band.top + band.height).toBe(rowTop(3))
    // Whole intermediate line keeps its tight per-line bar.
    expect(middle.top).toBe(rowTop(3))
    expect(rightEdge(middle)).toBe(textX(5) + NUB_PX)
    // Bottom line tight as before (single row, no remainder above it).
    expect(bottom.top).toBe(rowTop(4))
    expect(rightEdge(bottom)).toBe(textX(2))
  })

  it("selection within one wrapped line: every visual row painted", () => {
    // One 50-char line wrapping into 3 rows; selection spans row 0 into
    // row 2 — no whole block is ever "between", so the middle row only
    // gets painted by the remainder bands.
    const spec: FakeViewSpec = { doc: "a".repeat(50), anchor: 5, head: 45, wrapColumn: WRAP_COL }
    const markers = tightSelectionMarkers(makeFakeView(spec))
    // Row 0: tight bar from the selection start to the row text end + nub.
    const row0 = markers.find(m => m.top === rowTop(0))
    expect(row0).toBeDefined()
    expect(row0!.left).toBe(textX(5))
    expect(rightEdge(row0!)).toBe(textX(WRAP_COL) + NUB_PX)
    // Row 1: full-width remainder band with the exact vertical span.
    const bands = markers.filter(m => rightEdge(m) === RIGHT_SIDE)
    // Exactly one band: the start-block and end-block remainders describe the
    // same rows here, and the selection background is translucent, so painting
    // it twice would render this row darker than its neighbours.
    expect(bands).toHaveLength(1)
    expect(bands[0].top).toBe(rowTop(1))
    expect(bands[0].top + bands[0].height).toBe(rowTop(2))
    // Row 2: tight bar from the row start to the selection end.
    const row2 = markers.find(m => m.top === rowTop(2))
    expect(row2).toBeDefined()
    expect(row2!.left).toBe(textX(0))
    expect(rightEdge(row2!)).toBe(textX(5))
    // Every visual row of the line is covered by at least one marker.
    for (let row = 0; row < 3; row++) {
      const top = rowTop(row)
      expect(markers.some(m => m.top <= top && m.top + m.height >= top + LINE_H)).toBe(true)
    }
    expectConfinedToLines(markers, spec, [1])
  })

  it("cursor layer: empty range draws a cursor; non-empty honors drawRangeCursor", () => {
    const caret = tightCursorMarkers(makeFakeView({ doc: "abc", anchor: 2 }))
    expect(caret).toHaveLength(1)
    expect(caret[0].width).toBeNull() // cursors get no width style
    expect(caret[0].left).toBe(textX(2))
    // Cursors keep the raw glyph rect (no line-box snap), but still start from
    // the first line box, i.e. below the content padding.
    expect(caret[0].top).toBe(rowTop(0) + (LINE_H - TEXT_H) / 2)

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

describe("tightSelection vendoring guards", () => {
  // vitest runs with the desktop package as cwd.
  const read = (relative: string) => readFileSync(resolve(process.cwd(), relative), "utf8")
  const source = read("src/tightSelection.ts")
  // Comments explain what the code must *not* do, so they would trip a naive
  // source-pattern guard. Match against code only.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")

  it("anchors block coordinates at view.documentTop, never at contentRect.top", () => {
    // BlockInfo.top/bottom are relative to documentTop ("the top of the first
    // line, not above the padding"). Using contentRect.top instead silently
    // offsets every block-derived y by the content's padding-top — the defect
    // that made single-line selections bleed onto their neighbours.
    expect(code).toContain("view.documentTop")
    expect(code).not.toMatch(/contentRect\.top/)
  })

  it("records the upstream version it was ported from, and it matches the installed one", () => {
    // The vendored copy replaces upstream drawSelection.ts, so upstream fixes
    // to it (e.g. 6.43.7 "incorrectly drawn selection when a line wrap point
    // lies between widgets") no longer arrive automatically. Failing here on a
    // bump is the prompt to re-diff rather than silently drift.
    const ported = /Ported from @codemirror\/view (\d+\.\d+\.\d+)/.exec(source)
    expect(ported).not.toBeNull()
    const installed = JSON.parse(
      read("node_modules/@codemirror/view/package.json"),
    ) as { version: string }
    expect(ported![1]).toBe(installed.version)
  })
})
