import { normalizePasteUrl } from "../paste/urlPolicy"

export type ComplexTableInline =
  | { readonly type: "text"; readonly value: string }
  | {
      readonly type: "strong" | "emphasis" | "strike" | "underline" | "highlight" | "kbd"
      readonly children: readonly ComplexTableInline[]
    }
  | { readonly type: "subscript" | "superscript"; readonly children: readonly ComplexTableInline[] }
  | { readonly type: "code"; readonly value: string }
  | {
      readonly type: "link"
      readonly href: string
      readonly title: string | null
      readonly children: readonly ComplexTableInline[]
    }
  | { readonly type: "image"; readonly src: string; readonly alt: string; readonly title: string | null }
  | { readonly type: "break" }

export interface ComplexTableCell {
  readonly header: boolean
  readonly rowSpan: number
  readonly colSpan: number
  readonly scope: "row" | "col" | null
  readonly align: "left" | "center" | "right" | null
  readonly children: readonly ComplexTableInline[]
}

export interface ComplexTableModel {
  readonly rows: readonly (readonly ComplexTableCell[])[]
}

export const MAX_COMPLEX_TABLE_SPAN = 64
export const MAX_COMPLEX_TABLE_ROWS = 256
export const MAX_COMPLEX_TABLE_COLS = 64

const ENVELOPE_RE = /^<table>\n[\s\S]*\n<\/table>$/
const BLANK_LINE_RE = /(?:^|\n)[ \t]*(?:\n|$)/
const POSITIVE_INT_RE = /^[1-9]\d*$/

type InlineWrapperKind =
  | "strong"
  | "emphasis"
  | "strike"
  | "underline"
  | "highlight"
  | "kbd"
  | "subscript"
  | "superscript"

const INLINE_WRAPPERS: Readonly<Record<string, InlineWrapperKind>> = {
  strong: "strong",
  b: "strong",
  em: "emphasis",
  i: "emphasis",
  del: "strike",
  s: "strike",
  u: "underline",
  mark: "highlight",
  kbd: "kbd",
  sub: "subscript",
  sup: "superscript",
}

const SECTION_TAGS: ReadonlySet<string> = new Set(["thead", "tbody", "tfoot"])

/**
 * Persisted `HTMLBlock` source → closed `ComplexTableModel`.
 *
 * Fails closed (`null`) on any blank physical line, missing explicit `</table>`,
 * content outside the single `<table>` root, unknown tags/attributes, unsafe URLs,
 * or invalid/overlapping rowspan/colspan grid geometry.
 */
export function parseComplexTableBlock(source: string): ComplexTableModel | null {
  const normalized = source.replace(/\r\n/g, "\n").trim()
  if (normalized.includes("\r")) return null
  if (!ENVELOPE_RE.test(normalized)) return null
  if (BLANK_LINE_RE.test(normalized)) return null

  const doc = new DOMParser().parseFromString(normalized, "text/html")
  const body = doc.body
  if (!body) return null

  const root = singleRootTable(body)
  if (!root) return null

  const rawRows = collectRowElements(root)
  if (!rawRows || rawRows.length === 0 || rawRows.length > MAX_COMPLEX_TABLE_ROWS) return null

  const rows: ComplexTableCell[][] = []
  for (const tr of rawRows) {
    const cells = parseRowCells(tr)
    if (!cells || cells.length === 0) return null
    rows.push(cells)
  }

  if (!validateGridOccupancy(rows)) return null
  return { rows }
}

function singleRootTable(body: HTMLElement): Element | null {
  let table: Element | null = null
  for (let child = body.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === Node.TEXT_NODE) {
      if ((child.nodeValue ?? "").trim() !== "") return null
      continue
    }
    if (child.nodeType !== Node.ELEMENT_NODE) return null
    const el = child as Element
    if (table !== null || el.tagName.toLowerCase() !== "table") return null
    if (el.attributes.length > 0) return null
    table = el
  }
  return table
}

function collectRowElements(table: Element): Element[] | null {
  const rows: Element[] = []
  for (let child = table.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === Node.TEXT_NODE) {
      if ((child.nodeValue ?? "").trim() !== "") return null
      continue
    }
    if (child.nodeType !== Node.ELEMENT_NODE) return null
    const el = child as Element
    const tag = el.tagName.toLowerCase()
    if (tag === "tr") {
      if (el.attributes.length > 0) return null
      rows.push(el)
      continue
    }
    if (!SECTION_TAGS.has(tag) || el.attributes.length > 0) return null
    for (let secChild = el.firstChild; secChild; secChild = secChild.nextSibling) {
      if (secChild.nodeType === Node.TEXT_NODE) {
        if ((secChild.nodeValue ?? "").trim() !== "") return null
        continue
      }
      if (secChild.nodeType !== Node.ELEMENT_NODE) return null
      const rowEl = secChild as Element
      if (rowEl.tagName.toLowerCase() !== "tr" || rowEl.attributes.length > 0) return null
      rows.push(rowEl)
    }
  }
  return rows
}

function parseRowCells(tr: Element): ComplexTableCell[] | null {
  const cells: ComplexTableCell[] = []
  for (let child = tr.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === Node.TEXT_NODE) {
      if ((child.nodeValue ?? "").trim() !== "") return null
      continue
    }
    if (child.nodeType !== Node.ELEMENT_NODE) return null
    const cell = parseCellElement(child as Element)
    if (!cell) return null
    cells.push(cell)
  }
  return cells
}

function parseCellElement(el: Element): ComplexTableCell | null {
  const tag = el.tagName.toLowerCase()
  if (tag !== "th" && tag !== "td") return null
  const header = tag === "th"

  let rowSpan = 1
  let colSpan = 1
  let scope: "row" | "col" | null = null
  let align: "left" | "center" | "right" | null = null

  for (let i = 0; i < el.attributes.length; i++) {
    const attr = el.attributes[i]
    const name = attr.name.toLowerCase()
    const value = attr.value
    if (name === "rowspan") {
      const parsed = parseSpan(value)
      if (parsed === null) return null
      rowSpan = parsed
    } else if (name === "colspan") {
      const parsed = parseSpan(value)
      if (parsed === null) return null
      colSpan = parsed
    } else if (name === "scope") {
      if (!header || (value !== "row" && value !== "col")) return null
      scope = value
    } else if (name === "align") {
      if (value !== "left" && value !== "center" && value !== "right") return null
      align = value
    } else {
      return null
    }
  }

  const children = parseInlineChildren(el, false)
  if (!children) return null
  return { header, rowSpan, colSpan, scope, align, children }
}

function parseSpan(raw: string): number | null {
  if (!POSITIVE_INT_RE.test(raw)) return null
  const value = Number.parseInt(raw, 10)
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_COMPLEX_TABLE_SPAN) return null
  return value
}

function parseInlineChildren(parent: Element, insideLink: boolean): ComplexTableInline[] | null {
  const out: ComplexTableInline[] = []
  for (let child = parent.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === Node.TEXT_NODE) {
      const value = child.nodeValue ?? ""
      if (value !== "") appendText(out, value)
      continue
    }
    if (child.nodeType !== Node.ELEMENT_NODE) return null
    const node = parseInlineElement(child as Element, insideLink)
    if (!node) return null
    if (node.type === "text") {
      if (node.value !== "") appendText(out, node.value)
    } else {
      out.push(node)
    }
  }
  return out
}

function appendText(out: ComplexTableInline[], value: string): void {
  const last = out[out.length - 1]
  if (last?.type === "text") {
    out[out.length - 1] = { type: "text", value: last.value + value }
  } else {
    out.push({ type: "text", value })
  }
}

function parseInlineElement(el: Element, insideLink: boolean): ComplexTableInline | null {
  const tag = el.tagName.toLowerCase()
  const wrapper = INLINE_WRAPPERS[tag]
  if (wrapper) {
    if (el.attributes.length > 0) return null
    const children = parseInlineChildren(el, insideLink)
    if (!children) return null
    return { type: wrapper, children }
  }
  if (tag === "br") {
    return el.attributes.length === 0 ? { type: "break" } : null
  }
  if (tag === "code") {
    if (el.attributes.length > 0) return null
    for (let child = el.firstChild; child; child = child.nextSibling) {
      if (child.nodeType !== Node.TEXT_NODE) return null
    }
    return { type: "code", value: el.textContent ?? "" }
  }
  if (tag === "a") {
    if (insideLink) return null
    return parseLinkElement(el)
  }
  if (tag === "img") {
    return parseImageElement(el)
  }
  return null
}

function parseLinkElement(el: Element): ComplexTableInline | null {
  let rawHref: string | null = null
  let title: string | null = null
  for (let i = 0; i < el.attributes.length; i++) {
    const attr = el.attributes[i]
    const name = attr.name.toLowerCase()
    if (name === "href") rawHref = attr.value
    else if (name === "title") title = attr.value
    else return null
  }
  if (rawHref === null || rawHref !== rawHref.trim()) return null
  const href = normalizePasteUrl(rawHref, "link")
  if (href === null || href !== rawHref) return null
  const children = parseInlineChildren(el, true)
  if (!children) return null
  return { type: "link", href, title, children }
}

function parseImageElement(el: Element): ComplexTableInline | null {
  if (el.firstChild !== null) return null
  let rawSrc: string | null = null
  let alt = ""
  let title: string | null = null
  for (let i = 0; i < el.attributes.length; i++) {
    const attr = el.attributes[i]
    const name = attr.name.toLowerCase()
    if (name === "src") rawSrc = attr.value
    else if (name === "alt") alt = attr.value
    else if (name === "title") title = attr.value
    else return null
  }
  if (rawSrc === null || rawSrc !== rawSrc.trim()) return null
  const src = normalizePasteUrl(rawSrc, "image")
  if (src === null || src !== rawSrc) return null
  return { type: "image", src, alt, title }
}

/**
 * Validates that cell spans fit within row/column bounds and never overlap
 * an already-occupied slot.
 */
function validateGridOccupancy(rows: readonly (readonly ComplexTableCell[])[]): boolean {
  const rowCount = rows.length
  const occupied: boolean[][] = Array.from({ length: rowCount }, () => [])
  let maxCols = 0

  for (let r = 0; r < rowCount; r++) {
    const row = rows[r]
    let c = 0
    for (const cell of row) {
      while (occupied[r][c]) c++
      if (r + cell.rowSpan > rowCount) return false
      if (c + cell.colSpan > MAX_COMPLEX_TABLE_COLS) return false
      for (let dr = 0; dr < cell.rowSpan; dr++) {
        for (let dc = 0; dc < cell.colSpan; dc++) {
          if (occupied[r + dr][c + dc]) return false
          occupied[r + dr][c + dc] = true
        }
      }
      c += cell.colSpan
      if (c > maxCols) maxCols = c
    }
  }
  return maxCols > 0 && maxCols <= MAX_COMPLEX_TABLE_COLS
}
