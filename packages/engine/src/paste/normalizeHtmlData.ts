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

// --- 数学公式节点提取与 $$ 块切分 --------------------------------------------

export interface ExtractedMath {
  readonly display: boolean
  readonly value: string
}

const MATH_ATTRS = ["data-latex", "data-tex", "data-math", "data-formula", "tex"] as const
const TEX_ENCODINGS = new Set(["application/x-tex", "text/x-tex", "tex", "latex"])

function hasClassToken(el: Element, target: string): boolean {
  for (const token of (el.getAttribute("class") ?? "").split(DECORATION_TOKENS)) {
    if (token.toLowerCase() === target) return true
  }
  return false
}

function readTexAnnotation(root: Element): string | null {
  const annotations = root.getElementsByTagName("annotation")
  for (let i = 0; i < annotations.length; i++) {
    const ann = annotations[i]
    const enc = (ann.getAttribute("encoding") ?? "").trim().toLowerCase()
    if (TEX_ENCODINGS.has(enc) || enc.includes("tex")) {
      const tex = (ann.textContent ?? "").trim()
      if (tex !== "") return tex
    }
  }
  return null
}

function stripOuterMathDelimiters(raw: string, display: boolean): { readonly display: boolean; readonly value: string } {
  const trimmed = raw.trim()
  if (trimmed.startsWith("$$") && trimmed.endsWith("$$") && trimmed.length > 4) {
    return { display: true, value: trimmed.slice(2, -2).trim() }
  }
  if (trimmed.startsWith("\\[") && trimmed.endsWith("\\]") && trimmed.length > 4) {
    return { display: true, value: trimmed.slice(2, -2).trim() }
  }
  if (trimmed.startsWith("\\(") && trimmed.endsWith("\\)") && trimmed.length > 4) {
    return { display, value: trimmed.slice(2, -2).trim() }
  }
  if (trimmed.startsWith("$") && trimmed.endsWith("$") && trimmed.length > 2 && !trimmed.startsWith("$$")) {
    return { display, value: trimmed.slice(1, -1).trim() }
  }
  return { display, value: trimmed }
}

function isDisplayMathElement(el: Element, tag: string): boolean {
  const displayAttr = (el.getAttribute("display") ?? "").trim().toLowerCase()
  if (displayAttr === "true" || displayAttr === "block") return true
  if ((el.getAttribute("type") ?? "").trim().toLowerCase() === "display") return true
  if (hasClassToken(el, "katex-display") || hasClassToken(el, "math-display") || hasClassToken(el, "math-block")) {
    return true
  }
  if (tag !== "math") {
    const mathChild = el.getElementsByTagName("math")[0]
    if (mathChild) {
      const childDisplay = (mathChild.getAttribute("display") ?? "").trim().toLowerCase()
      if (childDisplay === "block" || childDisplay === "true") return true
    }
  }
  return false
}

/**
 * 识别网页已渲染的 MathJax / KaTeX / MathML 节点，直接提取原始 LaTeX 源码，
 * 避免遍历视觉 DOM 产生重复文本或无空格乱码。
 */
export function extractMathElement(el: Element): ExtractedMath | null {
  const tag = el.tagName.toLowerCase()
  if (tag === "script") {
    const type = (el.getAttribute("type") ?? "").trim().toLowerCase()
    if (!type.startsWith("math/tex")) return null
    const value = (el.textContent ?? "").trim()
    if (value === "") return null
    return stripOuterMathDelimiters(value, type.includes("mode=display"))
  }

  if (tag === "img") {
    const isWikiMath =
      hasClassToken(el, "mwe-math-fallback-image-inline") ||
      hasClassToken(el, "mwe-math-fallback-image-display") ||
      hasClassToken(el, "tex")
    if (isWikiMath) {
      const alt = (el.getAttribute("alt") ?? "").trim()
      if (alt !== "") {
        return stripOuterMathDelimiters(alt, hasClassToken(el, "mwe-math-fallback-image-display"))
      }
    }
  }

  const isMathContainer =
    tag === "mjx-container" ||
    tag === "math-renderer" ||
    tag === "math" ||
    hasClassToken(el, "mwe-math-element") ||
    hasClassToken(el, "katex-display") ||
    hasClassToken(el, "katex") ||
    hasClassToken(el, "mathjax") ||
    hasClassToken(el, "math-inline") ||
    hasClassToken(el, "math-display") ||
    hasClassToken(el, "math-block")

  const display = isDisplayMathElement(el, tag)
  for (const attr of MATH_ATTRS) {
    const val = el.getAttribute(attr)
    if (val !== null && val.trim() !== "") {
      return stripOuterMathDelimiters(val, display)
    }
  }
  if (!isMathContainer) return null

  const annotated = readTexAnnotation(el)
  if (annotated !== null) return stripOuterMathDelimiters(annotated, display)

  if (hasClassToken(el, "mwe-math-element")) {
    const img = el.getElementsByTagName("img")[0]
    if (img) {
      const alt = (img.getAttribute("alt") ?? "").trim()
      if (alt !== "") {
        const imgDisplay = display || hasClassToken(img, "mwe-math-fallback-image-display")
        return stripOuterMathDelimiters(alt, imgDisplay)
      }
    }
  }

  if (tag === "math-renderer") {
    const scripts = el.getElementsByTagName("script")
    for (let i = 0; i < scripts.length; i++) {
      const type = (scripts[i].getAttribute("type") ?? "").trim().toLowerCase()
      if (type.startsWith("math/tex")) {
        const tex = (scripts[i].textContent ?? "").trim()
        if (tex !== "") return stripOuterMathDelimiters(tex, display || type.includes("mode=display"))
      }
    }
  }
  return null
}

const CODE_FENCE_OPEN = /^(`{3,}|~{3,})([A-Za-z0-9_+#.-]*)[ \t]*$/

function parseCodeFenceOpen(raw: string): { readonly marker: string; readonly language: string } | null {
  const match = CODE_FENCE_OPEN.exec(raw.trim())
  if (!match) return null
  return { marker: match[1], language: match[2].toLowerCase() }
}

function isCodeFenceClose(raw: string, marker: string): boolean {
  const trimmed = raw.trim()
  return trimmed.length >= marker.length && trimmed === marker[0].repeat(trimmed.length)
}

/**
 * 将段落内由 `<br>`（hardBreak）分隔的物理行中的配对 `$$ ... $$` 或 ` ``` ... ``` `
 * 切分为独立 `mathBlock` / `codeBlock`，使从网页或聊天复制的原始块级语法能直接渲染。
 */
export function splitParagraphDisplayMath(children: readonly PasteInline[]): PasteBlock[] {
  const lines: PasteInline[][] = [[]]
  for (const node of children) {
    if (node.type === "hardBreak") lines.push([])
    else lines[lines.length - 1].push(node)
  }
  if (lines.length < 3) return [{ type: "paragraph", children }]

  const isPlainTextLine = (line: readonly PasteInline[]): boolean =>
    line.every(node => node.type === "text")
  const lineTextOf = (line: readonly PasteInline[]): string =>
    line.map(node => (node.type === "text" ? node.value : "")).join("")
  const isMathFenceLine = (line: readonly PasteInline[]): boolean =>
    line.length === 1 && line[0].type === "text" && line[0].value.trim() === "$$"

  const blocks: PasteBlock[] = []
  let paraRun: PasteInline[] = []
  const flushPara = (): void => {
    if (paraRun.length > 0) {
      blocks.push({ type: "paragraph", children: paraRun })
      paraRun = []
    }
  }
  const pushParaLine = (line: readonly PasteInline[]): void => {
    if (line.length === 0) return
    if (paraRun.length > 0) paraRun.push({ type: "hardBreak" })
    paraRun.push(...line)
  }

  for (let i = 0; i < lines.length;) {
    if (isMathFenceLine(lines[i])) {
      let close = -1
      for (let j = i + 1; j < lines.length; j++) {
        if (isMathFenceLine(lines[j])) { close = j; break }
        if (!isPlainTextLine(lines[j])) break
      }
      if (close > i + 1) {
        const value = lines.slice(i + 1, close).map(lineTextOf).join("\n").trim()
        if (value !== "") {
          flushPara()
          blocks.push({ type: "mathBlock", value })
          i = close + 1
          continue
        }
      }
    }
    const line = lines[i]
    if (line.length === 1 && line[0].type === "text") {
      const open = parseCodeFenceOpen(line[0].value)
      if (open) {
        let close = -1
        for (let j = i + 1; j < lines.length; j++) {
          const next = lines[j]
          if (next.length === 1 && next[0].type === "text" && isCodeFenceClose(next[0].value, open.marker)) {
            close = j
            break
          }
          if (!isPlainTextLine(next)) break
        }
        if (close > i + 1) {
          const value = lines.slice(i + 1, close).map(lineTextOf).join("\n")
          if (value.trim() !== "") {
            flushPara()
            blocks.push({ type: "codeBlock", language: open.language, value })
            i = close + 1
            continue
          }
        }
      }
    }
    pushParaLine(lines[i])
    i += 1
  }
  flushPara()
  return blocks.length > 0 ? blocks : [{ type: "paragraph", children }]
}

/**
 * 合并跨 `<p>` / `<div>` 块级容器被拆成独立段落的配对 `$$ ... $$` 或 ` ``` ... ``` `。
 */
export function mergeAdjacentFencedBlocks(blocks: readonly PasteBlock[]): PasteBlock[] {
  if (blocks.length < 3) return [...blocks]
  const plainParagraphLines = (block: PasteBlock): string[] | null => {
    if (block.type !== "paragraph" || block.children.length === 0) return null
    const lines: string[] = [""]
    for (const node of block.children) {
      if (node.type === "hardBreak") lines.push("")
      else if (node.type === "text") lines[lines.length - 1] += node.value
      else return null
    }
    return lines
  }

  const out: PasteBlock[] = []
  for (let i = 0; i < blocks.length;) {
    const firstLines = plainParagraphLines(blocks[i])
    if (firstLines && firstLines.length === 1 && firstLines[0].trim() === "$$") {
      let close = -1
      const bodyLines: string[] = []
      for (let j = i + 1; j < blocks.length; j++) {
        const lines = plainParagraphLines(blocks[j])
        if (!lines) break
        if (lines.length === 1 && lines[0].trim() === "$$") { close = j; break }
        bodyLines.push(...lines)
      }
      if (close > i + 1) {
        const value = bodyLines.join("\n").trim()
        if (value !== "") {
          out.push({ type: "mathBlock", value })
          i = close + 1
          continue
        }
      }
    }
    if (firstLines && firstLines.length === 1) {
      const open = parseCodeFenceOpen(firstLines[0])
      if (open) {
        let close = -1
        const bodyLines: string[] = []
        for (let j = i + 1; j < blocks.length; j++) {
          const lines = plainParagraphLines(blocks[j])
          if (!lines) break
          if (lines.length === 1 && isCodeFenceClose(lines[0], open.marker)) { close = j; break }
          bodyLines.push(...lines)
        }
        if (close > i + 1) {
          const value = bodyLines.join("\n")
          if (value.trim() !== "") {
            out.push({ type: "codeBlock", language: open.language, value })
            i = close + 1
            continue
          }
        }
      }
    }
    out.push(blocks[i])
    i += 1
  }
  return out
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
