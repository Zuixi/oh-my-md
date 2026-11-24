import { syntaxTree, syntaxTreeAvailable } from "@codemirror/language"
import type { EditorState, Line } from "@codemirror/state"
import { Prec } from "@codemirror/state"
import { BlockType, EditorView, keymap, type Command } from "@codemirror/view"
import type { SyntaxNode } from "@lezer/common"
import { openRenderedTableCell } from "../decorations/widgets/tableCellEdit"
import { tableDirectEditEnabled } from "../decorations/widgets/table"
import { blockPrefixOf } from "../format/blockPrefix"
import { beginTableEdit } from "../tables/directEdit"
import { cellAt, tableAt } from "../tables/navigate"
import { isTableSourceRevealed } from "../tables/sourceReveal"

/**
 * ArrowUp/ArrowDown line-by-line entry into rendered block widgets.
 *
 * CodeMirror's vertical motion skips non-text block widgets as a unit (`posAtCoords`
 * `scanY` steps around widget blocks; see discuss.codemirror.net/t/9491). Entering a
 * non-table block moves the caret inside `[from, to]`, triggering `blockSelected` to
 * unmount the widget and reveal source on the same path as clicking; leaving remounts
 * the widget. Entering a rendered GFM table opens an in-cell edit session with the
 * document selection parked on `table.from`.
 *
 * Shift+ArrowUp/Down is intentionally not intercepted: extending a selection across a
 * block covers the rendered widget (`blockSelectionOverlay`) rather than revealing source.
 */

const FENCED_BLOCKS = new Set(["FencedCode", "MathBlock", "FrontMatter"])

// Fallback fence patterns used only when the incremental syntax tree has not reached `blockTo`.
// CommonMark §4.5 forbids backticks in backtick fence info strings (tilde is allowed, e.g.
// `title="~/app.ts"`), while tilde fence info strings allow both backticks and tildes.
const FALLBACK_OPEN_BACKTICK_FENCE = /^\s{0,3}`{3,}[^`]*$/
const FALLBACK_OPEN_TILDE_FENCE = /^\s{0,3}~{3,}.*$/
const FALLBACK_OPEN_MATH_FENCE = /^\s{0,3}\$\$\s*$/
const FALLBACK_CLOSE_FENCE = /^\s{0,3}(?:`{3,}|~{3,}|\$\$)\s*$/
const FALLBACK_FRONT_MATTER_FENCE = /^---\s*$/

/**
 * Width of any leading quote/list prefix (mark + trailing space) on `line`, or 0.
 * Fence detection strips this prefix first, and the landing offset sits past it:
 * landing at `line.from` inside a `QuoteMark` would unfold the raw `> ` marker.
 */
function prefixWidth(state: EditorState, line: Line): number {
  return blockPrefixOf(state, line)?.text.length ?? 0
}

function findFencedBlock(state: EditorState, blockFrom: number, blockTo: number): SyntaxNode | null {
  if (!syntaxTreeAvailable(state, blockTo)) return null
  let cur: SyntaxNode | null = syntaxTree(state).resolveInner(blockFrom, 1)
  while (cur) {
    if (cur.from === blockFrom && cur.to === blockTo && FENCED_BLOCKS.has(cur.name)) return cur
    cur = cur.parent
  }
  return null
}

function hasClosingMarkAfter(node: SyntaxNode, markName: string, afterPos: number): SyntaxNode | null {
  let found: SyntaxNode | null = null
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === markName && child.from > afterPos) found = child
  }
  return found
}

function fenceLineSkips(
  state: EditorState,
  blockFrom: number,
  blockTo: number,
  first: Line,
  last: Line,
): { skipFirst: boolean; skipLast: boolean } {
  const node = findFencedBlock(state, blockFrom, blockTo)
  if (node) {
    if (node.name === "FencedCode") {
      return {
        skipFirst: true,
        skipLast: hasClosingMarkAfter(node, "CodeMark", first.to) !== null,
      }
    }
    if (node.name === "FrontMatter") {
      return {
        skipFirst: true,
        skipLast: hasClosingMarkAfter(node, "FrontMatterMark", first.to) !== null,
      }
    }
    if (node.name === "MathBlock") {
      const openMark = node.firstChild?.name === "MathMark" ? node.firstChild : null
      const skipFirst = openMark !== null
        && state.doc.sliceString(openMark.to, first.to).trim() === ""
      const closeMark = hasClosingMarkAfter(node, "MathMark", first.to)
      const skipLast = closeMark !== null
        && closeMark.from >= last.from
        && state.doc.sliceString(last.from + prefixWidth(state, last), closeMark.from).trim() === ""
      return { skipFirst, skipLast }
    }
  }
  const firstText = first.text.slice(prefixWidth(state, first))
  const lastText = last.text.slice(prefixWidth(state, last))
  const isFrontMatter = blockFrom === 0 && FALLBACK_FRONT_MATTER_FENCE.test(firstText)
  const skipFirst = isFrontMatter
    || FALLBACK_OPEN_BACKTICK_FENCE.test(firstText)
    || FALLBACK_OPEN_TILDE_FENCE.test(firstText)
    || FALLBACK_OPEN_MATH_FENCE.test(firstText)
  const skipLast = (isFrontMatter && FALLBACK_FRONT_MATTER_FENCE.test(lastText))
    || FALLBACK_CLOSE_FENCE.test(lastText)
  return { skipFirst, skipLast }
}

/**
 * Maps a rendered block's `[blockFrom, blockTo]` bounds to its keyboard entry offset.
 * Downward entry lands on the first content line (skipping a pure opening fence line,
 * while keeping table header rows); upward entry lands on the last content line
 * (skipping a real closing fence line, never an unclosed content line).
 * Single-line blocks (`---`, `$$x$$`) land on the block start so `blockSelected` holds.
 */
export function blockEntryPosition(
  state: EditorState,
  blockFrom: number,
  blockTo: number,
  dir: 1 | -1,
): number {
  const first = state.doc.lineAt(blockFrom)
  const last = state.doc.lineAt(Math.max(blockFrom, blockTo - 1))
  const { skipFirst, skipLast } = last.number > first.number
    ? fenceLineSkips(state, blockFrom, blockTo, first, last)
    : { skipFirst: false, skipLast: false }
  let pos: number
  if (dir === 1) {
    pos = skipFirst ? Math.min(first.to + 1, blockTo) : Math.min(first.from, blockTo)
  } else if (skipLast) {
    pos = state.doc.lineAt(last.from - 1).from
  } else {
    pos = last.from
  }
  const line = state.doc.lineAt(pos)
  return line.from + prefixWidth(state, line)
}

// Paragraphs and rendered blocks are commonly separated by blank lines. Probe across
// blank lines to reach the adjacent widget block; stop immediately on non-empty text.
const BLANK_LINE_PROBES = 4

// Adjacent widget block in direction `dir` (`BlockInfo.type !== Text` covers Widget/BlockWidget).
function adjacentWidgetBlock(view: EditorView, dir: 1 | -1): { from: number; to: number } | null {
  const head = view.state.selection.main.head
  const here = view.lineBlockAt(head)
  const rect = view.coordsAtPos(head)
  const line = view.defaultLineHeight
  const half = line / 2
  // `elementAtHeight` uses document-top-relative `y`. Layout-free hosts return rects
  // outside the current line block; fall back to the height map (`± half` past the line).
  const edge = rect ? (dir === 1 ? rect.bottom : rect.top) - view.documentTop : null
  const rectOnThisLine = edge !== null && edge >= here.top && edge <= here.top + here.height
  let y = rectOnThisLine
    ? edge + dir * half
    : dir === 1 ? here.top + here.height + half : here.top - half
  for (let probe = 0; probe < BLANK_LINE_PROBES && y >= 0; probe++) {
    const block = view.elementAtHeight(y)
    if (block.type !== BlockType.Text) {
      if (dir === 1 ? block.from <= head : block.to > head) return null
      return { from: block.from, to: block.to }
    }
    if (block.from !== block.to) return null
    y += dir * line
  }
  return null
}

/** GFM `Table` that is still rendered: open the entry cell instead of source. */
function enterRenderedTable(
  view: EditorView,
  block: { from: number; to: number },
  dir: 1 | -1,
): boolean {
  if (view.state.readOnly || !view.state.facet(tableDirectEditEnabled)) return false
  if (isTableSourceRevealed(view.state)) return false
  const probe = Math.min(block.from + 1, block.to)
  const table = tableAt(view.state, probe)
  if (!table || table.from !== block.from || table.to !== block.to) return false
  const hit = cellAt(view.state, blockEntryPosition(view.state, block.from, block.to, dir))
  if (!hit || hit.table.from !== table.from) return false
  view.dispatch({
    effects: beginTableEdit({
      tableFrom: table.from,
      tableTo: table.to,
      row: hit.slot.row,
      column: hit.slot.col,
      source: table.source,
    }),
    selection: { anchor: table.from },
    scrollIntoView: true,
  })
  openRenderedTableCell(view, table, hit.slot.row, hit.slot.col)
  return true
}

function enterBlock(dir: 1 | -1): Command {
  return view => {
    if (!view.state.selection.main.empty) return false
    const block = adjacentWidgetBlock(view, dir)
    if (!block) return false
    if (enterRenderedTable(view, block, dir)) return true
    const pos = blockEntryPosition(view.state, block.from, block.to, dir)
    view.dispatch({ selection: { anchor: pos }, scrollIntoView: true })
    return true
  }
}

/**
 * `Prec.highest` runs ahead of `caretClamp` (`Prec.high`), whose `cursorLineDown`
 * would otherwise skip the entire widget block first. Returning `false` delegates
 * back to normal clamped vertical motion. Mounted only in Live mode.
 */
export const blockMotionKeymap = Prec.highest(keymap.of([
  { key: "ArrowDown", run: enterBlock(1) },
  { key: "ArrowUp", run: enterBlock(-1) },
]))
