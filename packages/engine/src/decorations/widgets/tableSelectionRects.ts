import type { CellParseOptions } from "../../parse/cell"
import type { TableCellData, TableData } from "../../tables/model"
import type { BlockSourceRange } from "../blockWidget"
import { alignVisibleGlyphs } from "./tableSelection"

export interface VisibleRun {
  /** Inclusive UTF-16 start offset in the cell's visible text. */
  readonly start: number
  /** Exclusive UTF-16 end offset in the cell's visible text. */
  readonly end: number
}

/** Width (px) of the fallback selection nub painted when a selection spans an empty cell. */
const EMPTY_CELL_NUB_PX = 4

/**
 * Inverse of `cellVisibleSourceOffset`: map a cell-local source interval `[from, to)` onto
 * contiguous UTF-16 runs in `visible` using the shared `alignVisibleGlyphs` alignment.
 *
 * Unspellable glyphs (emoji shortcodes, decoded HTML entities) have no literal character in
 * `source`, so they are included whenever the source span between their neighbouring
 * spellable glyphs intersects `[from, to)`.
 */
export function cellVisibleSelectionRuns(
  source: string,
  visible: string,
  from: number,
  to: number,
  resolveReference?: CellParseOptions["resolveReference"],
): VisibleRun[] {
  const selFrom = Math.max(0, Math.min(from, source.length))
  const selTo = Math.max(selFrom, Math.min(to, source.length))
  if (selFrom >= selTo || visible.length === 0) return []

  const glyphs = alignVisibleGlyphs(source, visible, resolveReference)
  if (glyphs.length === 0) return []

  const runs: VisibleRun[] = []
  for (let i = 0; i < glyphs.length; i++) {
    const glyph = glyphs[i]
    let selected = false
    if (glyph.start !== undefined && glyph.end !== undefined) {
      selected = glyph.end > selFrom && glyph.start < selTo
    } else {
      let prevEnd = 0
      for (let left = i - 1; left >= 0; left--) {
        const end = glyphs[left].end
        if (end !== undefined) {
          prevEnd = end
          break
        }
      }
      let nextStart = source.length
      for (let right = i + 1; right < glyphs.length; right++) {
        const start = glyphs[right].start
        if (start !== undefined) {
          nextStart = start
          break
        }
      }
      selected = prevEnd < nextStart && selFrom < nextStart && selTo > prevEnd
    }
    if (!selected) continue
    const last = runs[runs.length - 1]
    if (last && last.end === glyph.visibleStart) {
      runs[runs.length - 1] = { start: last.start, end: glyph.visibleEnd }
    } else {
      runs.push({ start: glyph.visibleStart, end: glyph.visibleEnd })
    }
  }
  return runs
}

function clipRect(rect: DOMRectReadOnly, clip: DOMRectReadOnly): DOMRect | null {
  const left = Math.max(rect.left, clip.left)
  const right = Math.min(rect.right, clip.right)
  const top = Math.max(rect.top, clip.top)
  const bottom = Math.min(rect.bottom, clip.bottom)
  if (right <= left || bottom <= top) return null
  return new DOMRect(left, top, right - left, bottom - top)
}

function collectRunRects(
  cellEl: HTMLElement,
  runs: readonly VisibleRun[],
  clip: DOMRectReadOnly,
  out: DOMRect[],
): void {
  const doc = cellEl.ownerDocument
  const textNodes: { node: Text; start: number; end: number }[] = []
  const walker = doc.createTreeWalker(cellEl, NodeFilter.SHOW_TEXT)
  let offset = 0
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text
    const len = text.data.length
    if (len > 0) textNodes.push({ node: text, start: offset, end: offset + len })
    offset += len
  }
  if (textNodes.length === 0) return

  for (const run of runs) {
    let startNode: Text | null = null
    let startOffset = 0
    let endNode: Text | null = null
    let endOffset = 0
    for (const entry of textNodes) {
      if (!startNode && entry.end > run.start) {
        startNode = entry.node
        startOffset = Math.max(0, run.start - entry.start)
      }
      if (entry.start < run.end) {
        endNode = entry.node
        endOffset = Math.min(entry.node.data.length, run.end - entry.start)
      }
      if (entry.end >= run.end) break
    }
    if (!startNode || !endNode) continue
    const range = doc.createRange()
    range.setStart(startNode, startOffset)
    range.setEnd(endNode, endOffset)
    for (const rect of range.getClientRects()) {
      const clipped = clipRect(rect, clip)
      if (clipped) out.push(clipped)
    }
  }
}

function emptyCellNub(cellEl: HTMLElement, clip: DOMRectReadOnly): DOMRect | null {
  const rect = cellEl.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return null
  const style = getComputedStyle(cellEl)
  const padLeft = Number.parseFloat(style.paddingLeft) || 0
  const padTop = Number.parseFloat(style.paddingTop) || 0
  const padBottom = Number.parseFloat(style.paddingBottom) || 0
  const height = Math.max(0, rect.height - padTop - padBottom)
  if (height <= 0) return null
  return clipRect(
    new DOMRect(rect.left + padLeft, rect.top + padTop, EMPTY_CELL_NUB_PX, height),
    clip,
  )
}

function tableCellElements(body: HTMLElement): HTMLElement[][] {
  const head = Array.from(body.querySelectorAll<HTMLElement>("thead th"))
  const rows = Array.from(body.querySelectorAll<HTMLElement>("tbody tr"))
    .map(tr => Array.from(tr.children) as HTMLElement[])
  return head.length > 0 ? [head, ...rows] : rows
}

function tableCellDataRows(table: TableData): readonly (readonly (TableCellData | null)[])[] {
  return [table.header.cells, ...table.rows.map(row => row.cells)]
}

/**
 * Project a partial document selection intersecting a rendered table into clipped
 * viewport-space rectangles over its cells.
 */
export function renderedTableSelectionRects(
  table: TableData,
  dom: HTMLElement,
  blockRange: BlockSourceRange,
  selRange: BlockSourceRange,
  resolveReference?: CellParseOptions["resolveReference"],
): DOMRect[] {
  const body = dom.querySelector<HTMLElement>(".omd-block-body") ?? dom
  const clip = body.getBoundingClientRect()
  if (clip.width <= 0 || clip.height <= 0) return []

  const cellEls = tableCellElements(body)
  const dataRows = tableCellDataRows(table)
  const out: DOMRect[] = []

  for (let r = 0; r < cellEls.length; r++) {
    const rowData = dataRows[r]
    if (!rowData) continue
    for (let c = 0; c < cellEls[r].length; c++) {
      const cell = rowData[c]
      if (!cell) continue
      const cellEl = cellEls[r][c]
      const cellFrom = blockRange.from + cell.from
      const cellTo = blockRange.from + cell.to
      const interFrom = Math.max(selRange.from, cellFrom)
      const interTo = Math.min(selRange.to, cellTo)
      const spansEmpty = cellFrom === cellTo && selRange.from <= cellFrom && selRange.to >= cellTo
      if (interFrom >= interTo && !spansEmpty) continue

      const before = out.length
      if (interFrom < interTo) {
        const visible = cellEl.textContent ?? ""
        const runs = cellVisibleSelectionRuns(
          cell.source,
          visible,
          interFrom - cellFrom,
          interTo - cellFrom,
          resolveReference,
        )
        if (runs.length > 0) collectRunRects(cellEl, runs, clip, out)
      }
      if (out.length === before && (spansEmpty || (selRange.from <= cellFrom && selRange.to >= cellTo))) {
        const nub = emptyCellNub(cellEl, clip)
        if (nub) out.push(nub)
      }
    }
  }
  return out
}
