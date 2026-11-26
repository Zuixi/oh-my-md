import type { SyntaxNode } from "@lezer/common"
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view"
import { syntaxTree, syntaxTreeAvailable } from "@codemirror/language"
import { cellHtmlBreakTag, cellLanguage, decodeShieldedPipes, type CellParseOptions } from "../../parse/cell"
import { getTableEditSession } from "../../tables/directEdit"
import { cellAt, type TableContext } from "../../tables/navigate"
import { isTableShownAsSource } from "../../tables/sourceReveal"
import { decodeHtmlEntity } from "../../parse/entities"
import { resolveEmoji } from "../../parse/emoji"
import { escapeParts } from "../../semantic/breaks"
import { imageParts } from "../../semantic/image"
import { linkParts } from "../../semantic/link"
import {
  stringReferenceContext,
  type MarkdownReferenceContext,
} from "../../semantic/references"

/**
 * 格内投影。强调类和行内代码始终折叠标记；光标落在链接、图片、行内公式等节点内部时，整节点输出源码。
 * 和 `parseCell` 共用 `cellLanguage()`，不改导出的 `CellNode`。
 */

const EMPHASIS_TAG: Record<string, string> = {
  Emphasis: "em",
  StrongEmphasis: "strong",
  Strikethrough: "del",
  Highlight: "mark",
  Underline: "u",
  Kbd: "kbd",
  Subscript: "sub",
  Superscript: "sup",
}

const REVEAL_WHOLE = new Set([
  "Link",
  "Autolink",
  "Image",
  "InlineMath",
  "Escape",
  "HardBreak",
  "Entity",
  "Emoji",
  "FootnoteReference",
])

const INPUT_ANCHOR_PX = "1px"

interface RenderCtx {
  readonly source: string
  readonly caret: number
  readonly options?: CellParseOptions
  readonly references: MarkdownReferenceContext
}

function parser(): { parse(source: string): { topNode: SyntaxNode } } {
  return cellLanguage().parser
}

function referenceContext(source: string, options?: CellParseOptions): MarkdownReferenceContext {
  if (!options?.resolveReference) return stringReferenceContext(source)
  return {
    sliceString: (from, to) => source.slice(from, to),
    resolveReference: options.resolveReference,
  }
}

function caretInside(node: SyntaxNode, caret: number): boolean {
  return caret >= node.from && caret < node.to
}

function appendText(parent: HTMLElement, text: string, from: number, to: number): void {
  if (from >= to && text === "") return
  const span = document.createElement("span")
  span.dataset.from = String(from)
  span.dataset.to = String(to)
  span.textContent = text
  parent.appendChild(span)
}

function markedInner(node: SyntaxNode, source: string, markName: string): { from: number; to: number; text: string } {
  const marks: { from: number; to: number }[] = []
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === markName) marks.push({ from: child.from, to: child.to })
  }
  if (marks.length >= 2) {
    const from = marks[0].to
    const to = marks[marks.length - 1].from
    return { from, to, text: source.slice(from, to) }
  }
  return { from: node.from, to: node.to, text: source.slice(node.from, node.to) }
}

export interface EditableCellSelection {
  readonly from: number
  readonly to: number
}

export function renderEditableCell(
  parent: HTMLElement,
  source: string,
  caret: number,
  options?: CellParseOptions,
  selection?: EditableCellSelection,
): void {
  parent.replaceChildren()
  const bounded = caret < 0 ? -1 : Math.min(Math.max(caret, 0), source.length)
  const ctx: RenderCtx = {
    source,
    caret: bounded,
    options,
    references: referenceContext(source, options),
  }
  const top = parser().parse(source).topNode
  if (top.from > 0) appendText(parent, source.slice(0, top.from), 0, top.from)
  renderChildren(parent, top, ctx, source.length)
  if (selection && selection.to > selection.from) {
    paintCellSelection(parent, selection.from, selection.to)
  } else {
    placeCaret(parent, Math.max(0, bounded))
  }
}

export function cellSourceOffsetAt(root: HTMLElement, clientX: number, clientY: number): number | null {
  if (typeof document.elementFromPoint !== "function") return null
  const hit = document.elementFromPoint(clientX, clientY)
  if (!(hit instanceof Element) || !root.contains(hit)) return null
  const span = nearestOffsetHost(hit, root)
  if (!span) return null
  const from = Number(span.dataset.from)
  const to = Number(span.dataset.to)
  if (!Number.isInteger(from) || !Number.isInteger(to) || to < from) return null
  const rect = span.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return from
  const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
  if (to - from > 1 && Array.from(span.textContent ?? "").length <= 1) {
    return ratio < 0.5 ? from : to
  }
  return from + Math.round((to - from) * ratio)
}

export function trimmedCellCaret(source: string): number {
  return source.length - source.trimStart().length
}

export function freezeEditableTableColumns(cell: HTMLElement): HTMLTableColElement | null {
  // shortcut: px 快照不随会话中的窗口 resize/字号变化重算，会话关闭即自愈；
  // 若出现长会话排版反馈再考虑 ResizeObserver 重冻结。
  const table = cell.closest("table")
  if (!table) return null
  const widths = [...table.querySelectorAll("thead th")].map(th => th.getBoundingClientRect().width)
  const group = document.createElement("colgroup")
  for (const width of widths) {
    const column = document.createElement("col")
    column.style.width = `${width}px`
    group.appendChild(column)
  }
  table.prepend(group)
  return group
}

export function mountEditableCell(cell: HTMLElement, input: HTMLInputElement): HTMLElement {
  const projection = document.createElement("div")
  projection.className = "omd-table-cell-view"
  input.style.position = "absolute"
  input.style.width = INPUT_ANCHOR_PX
  input.style.height = INPUT_ANCHOR_PX
  input.style.opacity = "0"
  cell.style.position = "relative"
  cell.replaceChildren(projection, input)
  return projection
}

export function syncEditableCell(
  projection: HTMLElement,
  cell: HTMLElement,
  input: HTMLInputElement,
  options?: CellParseOptions,
): void {
  const start = input.selectionStart ?? trimmedCellCaret(input.value)
  const end = input.selectionEnd ?? start
  const hasSelection = end > start
  const caret = hasSelection ? -1 : start
  renderEditableCell(
    projection,
    input.value,
    caret,
    options,
    hasSelection ? { from: start, to: end } : undefined,
  )
  positionTableCellInput(cell, input)
}

function wordRangeAt(text: string, offset: number): { from: number; to: number } {
  if (text.length === 0) return { from: 0, to: 0 }
  const clamped = Math.min(Math.max(offset, 0), text.length)
  const isWord = (ch: string) => /[\p{L}\p{N}_]/u.test(ch)
  const isSpace = (ch: string) => /\s/.test(ch)
  const pivot = clamped < text.length ? clamped : clamped - 1
  const kind = isWord(text[pivot]) ? isWord : isSpace(text[pivot]) ? isSpace : null
  if (!kind) return { from: pivot, to: pivot + 1 }
  let from = pivot
  let to = pivot + 1
  while (from > 0 && kind(text[from - 1])) from--
  while (to < text.length && kind(text[to])) to++
  return { from, to }
}

export function focusEditableCell(
  projection: HTMLElement,
  cell: HTMLElement,
  input: HTMLInputElement,
  clientX: number | undefined,
  clientY: number | undefined,
  options?: CellParseOptions,
  cellCaret?: number,
  clickDetail = 1,
): void {
  if (projection.childNodes.length === 0) {
    const start = trimmedCellCaret(input.value)
    input.setSelectionRange(start, start)
    if (cellCaret === undefined && clientX !== undefined && clientY !== undefined) {
      // Initial pointer entry hits a folded cell; render with caret = -1 so leading
      // entities/links/emojis do not unfold at offset 0 and shift the text under (clientX, clientY).
      renderEditableCell(projection, input.value, -1, options)
      positionTableCellInput(cell, input)
    } else {
      syncEditableCell(projection, cell, input, options)
    }
  }
  input.focus()
  const hit = clientX !== undefined && clientY !== undefined
    ? cellSourceOffsetAt(projection, clientX, clientY)
    : null
  const caret = hit ?? (cellCaret !== undefined ? Math.min(Math.max(cellCaret, 0), input.value.length) : null) ?? trimmedCellCaret(input.value)
  if (clickDetail >= 3) {
    input.setSelectionRange(0, input.value.length)
  } else if (clickDetail === 2) {
    const { from, to } = wordRangeAt(input.value, caret)
    input.setSelectionRange(from, to)
  } else {
    input.setSelectionRange(caret, caret)
  }
  syncEditableCell(projection, cell, input, options)
}

function positionTableCellInput(cell: HTMLElement, input: HTMLInputElement): void {
  const anchor = cell.querySelector<HTMLElement>(".omd-table-caret, .omd-table-cell-selected")
  if (!anchor) return
  const cellRect = cell.getBoundingClientRect()
  const anchorRect = anchor.getBoundingClientRect()
  input.style.left = `${anchorRect.left - cellRect.left}px`
  input.style.top = `${anchorRect.top - cellRect.top}px`
}

function nearestOffsetHost(hit: Element, root: HTMLElement): HTMLElement | null {
  const closest = hit.closest<HTMLElement>("[data-from]")
  if (closest && root.contains(closest)) return closest
  let cursor: Element | null = hit
  while (cursor && cursor !== root) {
    const previous = cursor.previousElementSibling
    if (previous instanceof HTMLElement && previous.matches("[data-from]")) return previous
    cursor = cursor.parentElement
  }
  return null
}

function placeCaret(root: HTMLElement, caret: number): void {
  const caretEl = document.createElement("span")
  caretEl.className = "omd-table-caret"
  caretEl.setAttribute("aria-hidden", "true")
  const spans = [...root.querySelectorAll<HTMLElement>("[data-from]")]
  for (const span of spans) {
    if (span.tagName === "BR" || span.tagName === "HR" || span.tagName === "IMG") continue
    const from = Number(span.dataset.from)
    const to = Number(span.dataset.to)
    if (caret > from && caret < to) {
      const text = span.textContent ?? ""
      const cut = Math.min(text.length, caret - from)
      const before = document.createElement("span")
      before.dataset.from = String(from)
      before.dataset.to = String(caret)
      before.textContent = text.slice(0, cut)
      const after = document.createElement("span")
      after.dataset.from = String(caret)
      after.dataset.to = String(to)
      after.textContent = text.slice(cut)
      span.replaceWith(before, caretEl, after)
      return
    }
  }
  for (const span of spans) {
    if (Number(span.dataset.from) >= caret) {
      span.before(caretEl)
      return
    }
  }
  root.appendChild(caretEl)
}

function paintCellSelection(root: HTMLElement, selFrom: number, selTo: number): void {
  const spans = [...root.querySelectorAll<HTMLElement>("[data-from]")]
  for (const span of spans) {
    const from = Number(span.dataset.from)
    const to = Number(span.dataset.to)
    if (!Number.isInteger(from) || !Number.isInteger(to) || to <= selFrom || from >= selTo) continue
    if (span.tagName === "BR" || span.tagName === "HR" || span.tagName === "IMG") {
      span.classList.add("omd-table-cell-selected")
      continue
    }
    const text = span.textContent ?? ""
    if (selFrom <= from && selTo >= to) {
      span.classList.add("omd-table-cell-selected")
      continue
    }
    const spanLen = to - from
    // Unspellable / decoded tokens (entities, emoji) highlight as a whole unit.
    if (spanLen !== text.length) {
      span.classList.add("omd-table-cell-selected")
      continue
    }
    const cutStart = Math.max(0, selFrom - from)
    const cutEnd = Math.min(text.length, selTo - from)
    const parts: HTMLElement[] = []
    if (cutStart > 0) {
      const before = document.createElement("span")
      before.dataset.from = String(from)
      before.dataset.to = String(from + cutStart)
      before.textContent = text.slice(0, cutStart)
      parts.push(before)
    }
    const mid = document.createElement("span")
    mid.className = "omd-table-cell-selected"
    mid.dataset.from = String(from + cutStart)
    mid.dataset.to = String(from + cutEnd)
    mid.textContent = text.slice(cutStart, cutEnd)
    parts.push(mid)
    if (cutEnd < text.length) {
      const after = document.createElement("span")
      after.dataset.from = String(from + cutEnd)
      after.dataset.to = String(to)
      after.textContent = text.slice(cutEnd)
      parts.push(after)
    }
    span.replaceWith(...parts)
  }
}

function renderChildren(parent: HTMLElement, node: SyntaxNode, ctx: RenderCtx, end: number): void {
  let pos = node.from
  for (let child = node.firstChild; child && child.from < end; child = child.nextSibling) {
    const stop = Math.min(child.to, end)
    if (child.from > pos) {
      const gapTo = Math.min(child.from, end)
      appendText(parent, ctx.source.slice(pos, gapTo), pos, gapTo)
    }
    renderNode(parent, child, ctx)
    pos = stop
  }
  if (pos < end) appendText(parent, ctx.source.slice(pos, end), pos, end)
}

function renderNode(parent: HTMLElement, node: SyntaxNode, ctx: RenderCtx): void {
  if (node.name.endsWith("Mark")) return
  // 与正文 foldPair 相同：行内代码的反引号对任意插入点保持隐藏。
  if (node.name === "InlineCode") {
    renderInlineCode(parent, node, ctx)
    return
  }
  if (REVEAL_WHOLE.has(node.name) && caretInside(node, ctx.caret)) {
    appendText(parent, ctx.source.slice(node.from, node.to), node.from, node.to)
    return
  }
  const tag = EMPHASIS_TAG[node.name]
  if (tag) {
    const el = document.createElement(tag)
    renderChildren(el, node, ctx, node.to)
    parent.appendChild(el)
    return
  }
  if (REVEAL_WHOLE.has(node.name)) {
    renderFolded(parent, node, ctx)
    return
  }
  // Rendered cells and HTML export project `<br>`/`<hr>` as elements (`parseCell`).
  // Keep them rendered as elements while typing on either side (including boundary
  // offsets `caret === node.from` and `caret === node.to`), and reveal the raw tag
  // only when the caret steps strictly inside `(node.from, node.to)` so `placeCaret`
  // splits text rather than destroying a void element.
  if (node.name === "HTMLTag") {
    const raw = ctx.source.slice(node.from, node.to)
    const tag = cellHtmlBreakTag(raw)
    if (tag) {
      if (ctx.caret > node.from && ctx.caret < node.to) {
        appendText(parent, raw, node.from, node.to)
        return
      }
      const element = document.createElement(tag)
      element.dataset.from = String(node.from)
      element.dataset.to = String(node.to)
      parent.appendChild(element)
      return
    }
  }
  if (node.firstChild) {
    renderChildren(parent, node, ctx, node.to)
    return
  }
  appendText(parent, ctx.source.slice(node.from, node.to), node.from, node.to)
}

function renderFolded(parent: HTMLElement, node: SyntaxNode, ctx: RenderCtx): void {
  switch (node.name) {
    case "InlineCode":
      renderInlineCode(parent, node, ctx)
      return
    case "Link":
    case "Autolink":
      renderLink(parent, node, ctx)
      return
    case "Image":
      renderImage(parent, node, ctx)
      return
    case "InlineMath":
      renderInlineMath(parent, node, ctx)
      return
    case "Escape":
      renderEscape(parent, node, ctx)
      return
    case "HardBreak":
      renderHardBreak(parent, node)
      return
    case "Entity":
      renderEntity(parent, node, ctx)
      return
    case "Emoji":
      renderEmoji(parent, node, ctx)
      return
    case "FootnoteReference":
      renderFootnote(parent, node, ctx)
      return
    default:
      appendText(parent, ctx.source.slice(node.from, node.to), node.from, node.to)
  }
}

function renderInlineCode(parent: HTMLElement, node: SyntaxNode, ctx: RenderCtx): void {
  const inner = markedInner(node, ctx.source, "CodeMark")
  const text = ctx.options?.pipeEscapes === "gfm-table" ? decodeShieldedPipes(inner.text) : inner.text
  const code = document.createElement("code")
  appendText(code, text, inner.from, inner.to)
  parent.appendChild(code)
}

function renderLink(parent: HTMLElement, node: SyntaxNode, ctx: RenderCtx): void {
  const parts = linkParts(node, ctx.references)
  if (!parts) {
    appendText(parent, ctx.source.slice(node.from, node.to), node.from, node.to)
    return
  }
  const anchor = document.createElement("a")
  anchor.className = "omd-link"
  anchor.href = parts.href
  if (parts.title !== null) anchor.title = parts.title
  renderRange(anchor, node, ctx, parts.labelFrom, parts.labelTo)
  parent.appendChild(anchor)
}

function renderRange(
  parent: HTMLElement,
  node: SyntaxNode,
  ctx: RenderCtx,
  from: number,
  to: number,
): void {
  let pos = from
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.to <= from) continue
    if (child.from >= to) break
    const start = Math.max(child.from, from)
    if (start > pos) appendText(parent, ctx.source.slice(pos, start), pos, start)
    if (child.from >= from && child.to <= to) renderNode(parent, child, ctx)
    pos = Math.min(child.to, to)
  }
  if (pos < to) appendText(parent, ctx.source.slice(pos, to), pos, to)
}

function renderImage(parent: HTMLElement, node: SyntaxNode, ctx: RenderCtx): void {
  const parts = imageParts(node, ctx.references)
  if (!parts) {
    appendText(parent, ctx.source.slice(node.from, node.to), node.from, node.to)
    return
  }
  const img = document.createElement("img")
  img.className = "omd-image"
  img.alt = parts.alt
  img.src = parts.src
  img.dataset.from = String(node.from)
  img.dataset.to = String(node.to)
  if (parts.title !== null) img.title = parts.title
  parent.appendChild(img)
}

function renderInlineMath(parent: HTMLElement, node: SyntaxNode, ctx: RenderCtx): void {
  const inner = markedInner(node, ctx.source, "MathMark")
  const code = document.createElement("code")
  code.className = "omd-cell-math"
  appendText(code, inner.text, inner.from, inner.to)
  parent.appendChild(code)
}

function renderEscape(parent: HTMLElement, node: SyntaxNode, ctx: RenderCtx): void {
  const parts = escapeParts(node)
  if (!parts) {
    appendText(parent, ctx.source.slice(node.from, node.to), node.from, node.to)
    return
  }
  appendText(
    parent,
    ctx.source.slice(parts.valueFrom, parts.valueTo),
    parts.valueFrom,
    parts.valueTo,
  )
}

function renderHardBreak(parent: HTMLElement, node: SyntaxNode): void {
  const br = document.createElement("br")
  br.dataset.from = String(node.from)
  br.dataset.to = String(node.to)
  parent.appendChild(br)
}

function renderEntity(parent: HTMLElement, node: SyntaxNode, ctx: RenderCtx): void {
  const raw = ctx.source.slice(node.from, node.to)
  appendText(parent, decodeHtmlEntity(raw) ?? raw, node.from, node.to)
}

function renderEmoji(parent: HTMLElement, node: SyntaxNode, ctx: RenderCtx): void {
  const raw = ctx.source.slice(node.from, node.to)
  appendText(parent, resolveEmoji(raw.slice(1, -1)) ?? raw, node.from, node.to)
}

function renderFootnote(parent: HTMLElement, node: SyntaxNode, ctx: RenderCtx): void {
  const sup = document.createElement("sup")
  sup.className = "omd-footnote"
  renderChildren(sup, node, ctx, node.to)
  parent.appendChild(sup)
}

type RenderedTableCellOpener = (
  view: EditorView,
  host: HTMLElement,
  row: number,
  column: number,
  table: TableContext,
  clientX?: number,
  clientY?: number,
  /** 格内选区落点（cell 源码相对）：保留外来跳转（脚注回跳/goto-line）的精确位置。 */
  cellCaret?: number,
) => void

let renderedTableCellOpener: RenderedTableCellOpener | null = null
let tableSelectionDragActive = false

/** Called by `tableSelection.ts` while a rendered-table pointer drag owns the window listeners. */
export function setTableSelectionDragActive(active: boolean): void {
  tableSelectionDragActive = active
}

/** Click and keyboard entry share `table.ts`'s cell opener. */
export function bindRenderedTableCellOpener(opener: RenderedTableCellOpener): void {
  renderedTableCellOpener = opener
}

export function openRenderedTableCell(
  view: EditorView,
  table: TableContext,
  row: number,
  column: number,
  cellCaret?: number,
): void {
  const host = renderedTableBody(view, table.from)
  if (!host || !renderedTableCellOpener) return
  renderedTableCellOpener(view, host, row, column, table, undefined, undefined, cellCaret)
}

function renderedTableBody(view: EditorView, tableFrom: number): HTMLElement | null {
  for (const wrap of view.dom.querySelectorAll<HTMLElement>(".omd-table")) {
    let pos: number
    try {
      pos = view.posAtDOM(wrap)
    } catch {
      continue
    }
    if (pos !== tableFrom) continue
    return wrap.querySelector<HTMLElement>(".omd-block-body")
  }
  return null
}

/** Collapsed caret strictly inside a rendered table, with no live cell session. */
function caretInsideUnrevealedTable(view: EditorView) {
  const state = view.state
  if (state.readOnly || tableSelectionDragActive) return null
  const selection = state.selection.main
  if (!selection.empty || getTableEditSession(state)) return null
  // Cheap `Table` node probe before `cellAt`, which builds `TableData` (one
  // `sliceString` per cell) on every keystroke: a caret outside any table, on the
  // table's start boundary or in a source-revealed table is decidable from the node.
  // `side = -1` also catches the `head === Table.to` end boundary that `side = 1`
  // skips, which the checks below treat as inside the table.
  if (!syntaxTreeAvailable(state, Math.min(selection.head + 1, state.doc.length))) return null
  let table: SyntaxNode | null = syntaxTree(state).resolveInner(selection.head, -1)
  while (table && table.name !== "Table") table = table.parent
  if (!table || selection.head <= table.from || selection.head > table.to) return null
  if (isTableShownAsSource(state, table.from, table.to)) return null
  return cellAt(state, selection.head)
}

/** Next frame after an in-table caret closed the session: reopen with the click opener and park on `table.from`. */
export const tableCaretFollower = ViewPlugin.fromClass(class {
  private frame: number | null = null
  private destroyed = false

  update(update: ViewUpdate) {
    if (this.destroyed || (!update.selectionSet && !update.docChanged)) return
    this.schedule(update.view)
  }

  destroy() {
    this.destroyed = true
    if (this.frame !== null) cancelAnimationFrame(this.frame)
    this.frame = null
  }

  private schedule(view: EditorView) {
    if (this.frame !== null || !caretInsideUnrevealedTable(view)) return
    this.frame = requestAnimationFrame(() => {
      this.frame = null
      if (!this.destroyed) this.follow(view)
    })
  }

  private follow(view: EditorView) {
    const hit = caretInsideUnrevealedTable(view)
    if (!hit) return
    const { table, slot } = hit
    if (!renderedTableBody(view, table.from)) return
    // 落点偏移随会话传递：光标停在 table.from 后，输入框内光标仍在原落点，
    // 脚注回跳/goto-line 才真正“回到原位”。
    const cellCaret = Math.min(Math.max(view.state.selection.main.head - slot.from, 0), slot.to - slot.from)
    view.dispatch({ selection: { anchor: table.from }, scrollIntoView: true })
    openRenderedTableCell(view, table, slot.row, slot.col, cellCaret)
  }
})
