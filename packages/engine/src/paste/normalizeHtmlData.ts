/**
 * 数据下沉（plan 02 Task 2 拆分）：不属于遍历状态机的纯读者/降级判定 ——
 * URL 与 data: 图片资产、表格/cell 元数据与 GFM 复杂度、以及诊断聚合。
 *
 * 只读 attribute 与 AST，不接触 writer：调用方负责把计数落到 ledger。
 */
import { COLLAPSIBLE_WHITESPACE, DECORATION_TOKENS, type Align, type StyleFacts } from "./normalizeHtmlInline"
import type { PasteBlock, PasteDiagnostic, PasteInline, PasteTableRow, PreparedSmartPaste } from "./model"

// --- 图片与资产 -------------------------------------------------------------

const BLOB_OR_FILE = /^\s*(?:blob|file):/i
const EMBEDDED_IMAGE = /^data:image\/(png|jpeg|webp);base64,([\s\S]*)$/i
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

export interface EmbeddedImage { readonly mime: string; readonly base64: string }

/** `data:image/(png|jpeg|webp);base64,…` → 资产；形状不合法就返回 null。 */
export function parseEmbeddedImage(src: string): EmbeddedImage | null {
  const match = EMBEDDED_IMAGE.exec(src.trim())
  if (!match) return null
  const payload = match[2].replace(COLLAPSIBLE_WHITESPACE, "")
  if (payload === "" || !BASE64.test(payload) || payload.length % 4 === 1) return null
  return { mime: `image/${match[1].toLowerCase()}`, base64: payload }
}

/** blob:/file: 的字节拿不到（和 data: 不同，闸门之前就要分类）。 */
export function isUnavailableImageSrc(src: string): boolean {
  return BLOB_OR_FILE.test(src)
}

// --- 列表与代码块元数据 -----------------------------------------------------

/** `<ol start>`：只接受非负十进制，其余视为无 start。 */
export function orderedStart(el: Element): number | null {
  const raw = el.getAttribute("start")
  if (raw === null) return null
  const value = Number.parseInt(raw.trim(), 10)
  return Number.isFinite(value) && value >= 0 && value <= 999_999_999 ? value : null
}

/**
 * 只有 li 的第一个非空白子节点且为 `input[type=checkbox]` 时才提供 checked
 * 状态；attribute 存在即勾选，不依赖 DOM 的 checked property。
 */
export function leadingCheckbox(el: Element): Element | null {
  let child = el.firstChild
  while (child) {
    const next = child.nextSibling
    if (child.nodeType === Node.TEXT_NODE) {
      if ((child.nodeValue ?? "").trim() !== "") return null
    } else {
      const element = child as Element
      if (child.nodeType !== Node.ELEMENT_NODE || element.tagName.toLowerCase() !== "input") return null
      return (element.getAttribute("type") ?? "").trim().toLowerCase() === "checkbox" ? element : null
    }
    child = next
  }
  return null
}

const LANGUAGE_CLASS = /^(?:language|lang)-(.+)$/

/** `class="language-js"` → `js`；没有语言就空串。 */
export function languageOf(el: Element): string {
  for (const token of (el.getAttribute("class") ?? "").split(DECORATION_TOKENS)) {
    const match = LANGUAGE_CLASS.exec(token)
    if (match) return match[1].toLowerCase()
  }
  return ""
}

// --- 表格元数据与复杂度 -----------------------------------------------------

export interface CellMeta {
  readonly header: boolean
  readonly scope: "row" | "col" | null
  readonly rowSpan: number
  readonly colSpan: number
  readonly align: Align | null
}

export function readCellMeta(el: Element, facts: StyleFacts): CellMeta {
  const header = el.tagName.toLowerCase() === "th"
  const scope = header ? (el.getAttribute("scope") ?? "").trim().toLowerCase() : ""
  const align = (el.getAttribute("align") ?? "").trim().toLowerCase()
  return {
    header,
    scope: scope === "row" || scope === "col" ? scope : null,
    rowSpan: spanAttribute(el, "rowspan"),
    colSpan: spanAttribute(el, "colspan"),
    align: align === "left" || align === "center" || align === "right" ? align : facts.align,
  }
}

function spanAttribute(el: Element, name: string): number {
  const raw = el.getAttribute(name)
  if (raw === null) return 1
  const value = Number.parseInt(raw.trim(), 10)
  return Number.isFinite(value) && value > 1 ? Math.min(value, 1000) : 1
}

/**
 * GFM 无法表达的表格：任何跨格、非首行表头、位置非法的 scope、或 cell 里
 * 超出 paragraph/list 的块，都让整表降级为可见文本。
 */
export function tableRequiresComplexHtml(rows: readonly PasteTableRow[]): boolean {
  return rows.some((row, rowIndex) =>
    row.cells.some((cell, cellIndex) => {
      if (cell.rowSpan > 1 || cell.colSpan > 1) return true
      if (!cell.blocks.every(block => block.type === "paragraph" || block.type === "list")) return true
      if (cell.scope === "col" && rowIndex !== 0) return true
      if (cell.scope === "row" && !(cellIndex === 0 && cell.header)) return true
      if (cell.header && rowIndex > 0) {
        // 首列 `th[scope=row]` 可以提升成普通数据行；其它表头行 GFM 表达不了。
        return !(cellIndex === 0 && cell.scope === "row" && row.cells.slice(1).every(other => !other.header))
      }
      return false
    }),
  )
}

// --- 诊断与文档形状 ---------------------------------------------------------

const DIAGNOSTIC_ORDER = ["strictFallback", "unsupportedTable", "droppedStyle", "rejectedUrl", "unresolvedAsset"] as const

export type DiagnosticCounts = Partial<Record<PasteDiagnostic["kind"], number>>

export function collectDiagnostics(counts: DiagnosticCounts): PasteDiagnostic[] {
  const diagnostics: PasteDiagnostic[] = []
  for (const kind of DIAGNOSTIC_ORDER) {
    const count = counts[kind] ?? 0
    if (count > 0) diagnostics.push({ kind, count })
  }
  return diagnostics
}

/** 整段粘贴只有一个图片段落 → 交给图片粘贴路径。 */
export function isSingleImageDocument(blocks: readonly PasteBlock[]): boolean {
  return blocks.length === 1
    && blocks[0].type === "paragraph"
    && blocks[0].children.length === 1
    && blocks[0].children[0].type === "image"
}

/** 不使用 DOM 的字面文本 fallback：空行分段，行内换行变 hardBreak。 */
export function preparePlainTextFallback(plainText: string): PreparedSmartPaste {
  const blocks: PasteBlock[] = []
  let children: PasteInline[] = []
  for (const line of plainText.split(/\r\n|\r|\n/)) {
    if (line === "") {
      if (children.length > 0) blocks.push({ type: "paragraph", children })
      children = []
      continue
    }
    if (children.length > 0) children.push({ type: "hardBreak" })
    children.push({ type: "text", value: line })
  }
  if (children.length > 0) blocks.push({ type: "paragraph", children })
  return {
    policy: "literalFallback",
    document: { blocks },
    plainText,
    assets: [],
    unavailableImageKeys: [],
    isSingleImageOnly: false,
    diagnostics: collectDiagnostics({ strictFallback: 1 }),
  }
}
