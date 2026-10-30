/**
 * Smart Paste 的确定性 Markdown 序列化（plan 02 Task 3）。
 *
 * 纯函数：输入 Paste AST，输出项目规范 Markdown（ATX heading、`-` bullet、
 * fenced code、GFM table、`<u>`/`<kbd>` 固定 HTML）。没有 DOM、属性、source map，
 * 也不原地修改输入；重复调用字节相同。
 *
 * 边界事实（`PasteBoundary`）由 AST 形状直接给出，绝不复述解析结果。
 * literal text 的转义规则全部来自 `./triggerPolicy`。
 */

import type {
  PasteBlock,
  PasteBoundary,
  PasteDiagnostic,
  PasteDocument,
  PasteInline,
  PasteListItem,
  PasteTable,
  PasteTableCell,
  SerializedPaste,
} from "./model"
import { canSerializeComplexTable, serializeComplexTable } from "./serializeComplexTable"
import { escapePasteText, type PasteTextContext } from "./triggerPolicy"

export interface SerializePasteOptions {
  readonly mode: "minimal" | "strict"
  readonly resolveAsset: (key: string) => string | null
  readonly allowComplexTable?: boolean
}

interface Ctx {
  readonly mode: "minimal" | "strict"
  readonly resolveAsset: (key: string) => string | null
  readonly allowComplexTable: boolean
  /** 当前行内上下文是 GFM cell 源码（管道/反斜杠按 cell 规则编码）。 */
  readonly cell: boolean
  unresolved: number
  unsupportedTables: number
}

type InlineNode = PasteInline
type Wrapper = Extract<PasteInline, { readonly children: readonly PasteInline[] }>
type ImageNode = Extract<PasteInline, { readonly type: "image" }>
type ListBlock = Extract<PasteBlock, { readonly type: "list" }>
type CodeBlock = Extract<PasteBlock, { readonly type: "codeBlock" }>

export function serializePasteDocument(
  document: PasteDocument,
  options: SerializePasteOptions,
): SerializedPaste {
  const allowComplexTable = options.allowComplexTable ?? options.mode === "minimal"
  const ctx: Ctx = {
    mode: options.mode,
    resolveAsset: options.resolveAsset,
    allowComplexTable,
    cell: false,
    unresolved: 0,
    unsupportedTables: 0,
  }
  const text = blocks(document.blocks, ctx)
  return {
    text,
    boundary: boundaryOf(document.blocks, allowComplexTable),
    diagnostics: diagnosticsOf(ctx),
  }
}

// ------------------------------------------------------------------ blocks

function blocks(list: readonly PasteBlock[], ctx: Ctx): string {
  const parts: string[] = []
  for (const block of list) {
    const text = blockText(block, ctx)
    if (text !== "") parts.push(text)
  }
  // 显式空行分隔：块边界不靠紧凑解析猜。
  return parts.join("\n\n")
}

function blockText(block: PasteBlock, ctx: Ctx): string {
  switch (block.type) {
    case "paragraph":
      return inlines(block.children, "lineStart", ctx)
    case "heading":
      return `${"#".repeat(block.level)} ${inlines(block.children, "lineStart", ctx)}`
    case "blockquote":
      return quote(blocks(block.children, ctx))
    case "list":
      return listText(block, ctx)
    case "codeBlock":
      return fencedCode(block)
    case "table":
      return tableText(block.table, ctx)
    case "horizontalRule":
      return "---"
  }
}

function quote(inner: string): string {
  if (inner === "") return ">"
  return inner.split("\n").map(line => (line === "" ? ">" : `> ${line}`)).join("\n")
}

function listText(block: ListBlock, ctx: Ctx): string {
  const lines: string[] = []
  let index = block.start ?? 1
  for (const item of block.items) {
    const marker = block.ordered ? `${index}. ` : "- "
    if (block.ordered) index++
    const task = taskPrefix(item)
    const indent = " ".repeat(marker.length + task.length)
    const content = blocks(item.children, ctx)
    const head = marker + task
    lines.push(content === "" ? head.trimEnd() : head + indentRest(content, indent))
  }
  return lines.join("\n")
}

function taskPrefix(item: PasteListItem): string {
  if (item.checked === null) return ""
  return item.checked ? "[x] " : "[ ] "
}

/** 续行缩进到内容列；空行保持空行（不留尾随空格）。 */
function indentRest(content: string, indent: string): string {
  return content
    .split("\n")
    .map((line, index) => (index === 0 || line === "" ? line : indent + line))
    .join("\n")
}

function longestRun(value: string, char: string): number {
  let longest = 0
  let current = 0
  for (const item of value) {
    current = item === char ? current + 1 : 0
    if (current > longest) longest = current
  }
  return longest
}

/** fence 永远比内容里最长的反引号 run 宽一位；info string 只留安全 token。 */
function fencedCode(block: CodeBlock): string {
  const fence = "`".repeat(Math.max(3, longestRun(block.value, "`") + 1))
  const info = /^[A-Za-z0-9_+#.-]+$/.test(block.language) ? block.language : ""
  const body = block.value.endsWith("\n") ? block.value : `${block.value}\n`
  return `${fence}${info}\n${body}${fence}`
}

// ------------------------------------------------------------------ tables

function tableText(table: PasteTable, ctx: Ctx): string {
  const rows = table.rows.filter(row => row.cells.length > 0)
  if (rows.length === 0) return ""
  const width = Math.max(...rows.map(row => row.cells.length))
  const complex = table.requiresComplexHtml
    || rows.slice(1).some(row => row.cells.some(cell => cell.header))
    || !rows.every(row => row.cells.every(cellEncodable))
  if (complex && table.requiresComplexHtml && ctx.allowComplexTable && canSerializeComplexTable(table)) {
    const lowered = serializeComplexTable(table, {
      mode: ctx.mode,
      resolveAsset: ctx.resolveAsset,
    })
    for (const diag of lowered.diagnostics) {
      if (diag.kind === "unresolvedAsset") ctx.unresolved += diag.count
    }
    return lowered.text
  }
  if (complex) ctx.unsupportedTables++
  const cellCtx: Ctx = { ...ctx, cell: true }
  const lines = rows.map(row => {
    const cells: string[] = []
    for (let column = 0; column < width; column++) {
      const cell = row.cells[column]
      cells.push(cell ? cellText(cell, cellCtx, complex) : "")
    }
    return `| ${cells.join(" | ")} |`
  })
  const separator = `| ${alignRow(rows[0], width)} |`
  return [lines[0], separator, ...lines.slice(1)].join("\n")
}

function cellText(cell: PasteTableCell, ctx: Ctx, complex: boolean): string {
  // 复杂表只保留可见文本：严格转义成 cell 单行文本，不发射任意 HTML。
  if (complex) return escapePasteText(visibleText(cell.blocks), "tableCell", "strict")
  const paragraph = cell.blocks[0]
  if (!paragraph || paragraph.type !== "paragraph") return ""
  return inlines(paragraph.children, "paragraph", ctx)
}

function alignRow(row: { readonly cells: readonly PasteTableCell[] }, width: number): string {
  const markers: string[] = []
  for (let column = 0; column < width; column++) {
    switch (row.cells[column]?.align ?? null) {
      case "left": markers.push(":--"); break
      case "center": markers.push(":-:"); break
      case "right": markers.push("--:"); break
      default: markers.push("---")
    }
  }
  return markers.join(" | ")
}

/** GFM cell 只能承载单段行内内容；其余一律降级成可见文本。 */
function cellEncodable(cell: PasteTableCell): boolean {
  if (cell.rowSpan > 1 || cell.colSpan > 1) return false
  const [only, ...rest] = cell.blocks
  if (!only) return true
  if (rest.length > 0) return false
  if (only.type !== "paragraph") return false
  return inlinesEncodable(only.children)
}

function inlinesEncodable(nodes: readonly PasteInline[]): boolean {
  for (const node of nodes) {
    switch (node.type) {
      case "code":
        // 行内代码里偶数反斜杠 run 后的管道无法被 GFM 行切分屏蔽。
        if (encodeCellCode(node.value) === null) return false
        break
      case "text":
      case "image":
      case "hardBreak":
        break
      case "link":
        if (!inlinesEncodable(node.children)) return false
        break
      default:
        if (!inlinesEncodable((node as Wrapper).children)) return false
    }
  }
  return true
}

/** cell 内联内容的可见文本（复杂表降级 + 测试断言共用）。 */
function visibleText(list: readonly PasteBlock[], separator = " "): string {
  return list.map(blockVisibleText).filter(text => text !== "").join(separator)
}

function blockVisibleText(block: PasteBlock): string {
  switch (block.type) {
    case "paragraph":
    case "heading":
      return inlineVisibleText(block.children)
    case "blockquote":
      return visibleText(block.children)
    case "list":
      return block.items.map(item => visibleText(item.children)).filter(text => text !== "").join(" ")
    case "codeBlock":
      return block.value
    case "table":
      return block.table.rows.map(row => row.cells.map(cell => visibleText(cell.blocks)).join(" ")).join(" ")
    case "horizontalRule":
      return ""
  }
}

function inlineVisibleText(nodes: readonly PasteInline[]): string {
  let out = ""
  for (const node of nodes) {
    switch (node.type) {
      case "text": out += node.value; break
      case "code": out += node.value; break
      case "image": out += node.alt; break
      case "hardBreak": out += " "; break
      case "link": out += inlineVisibleText(node.children); break
      default: out += inlineVisibleText((node as Wrapper).children)
    }
  }
  return out
}

// ----------------------------------------------------------------- inlines

const WRAPPERS: Readonly<Record<Exclude<Wrapper["type"], "link">, readonly [string, string]>> = {
  strong: ["**", "**"],
  emphasis: ["*", "*"],
  strike: ["~~", "~~"],
  highlight: ["==", "=="],
  underline: ["<u>", "</u>"],
  kbd: ["<kbd>", "</kbd>"],
  subscript: ["~", "~"],
  superscript: ["^", "^"],
}

/** `<u>` / `<kbd>` 里继续走 Lezer inline parser，`<`/`>` 必须保持字面。 */
const TAG_CHILDREN: ReadonlySet<string> = new Set(["underline", "kbd"])

function inlines(nodes: readonly PasteInline[], context: PasteTextContext, ctx: Ctx): string {
  const paragraphish = context === "paragraph" || context === "lineStart"
  let atLineStart = context === "lineStart"
  let out = ""
  for (const node of nodes) {
    if (node.type === "text") {
      if (node.value === "") continue
      const textContext: PasteTextContext = !paragraphish
        ? context
        : atLineStart ? "lineStart" : "paragraph"
      out += text(node.value, textContext, ctx)
      atLineStart = false
      continue
    }
    if (node.type === "hardBreak") {
      out += ctx.cell ? "<br>" : "\\\n"
      atLineStart = paragraphish && !ctx.cell
      continue
    }
    if (node.type === "code") {
      out += ctx.cell ? cellCodeSpan(node.value) : codeSpan(node.value)
      atLineStart = false
      continue
    }
    if (node.type === "image") {
      out += imageText(node, ctx)
      atLineStart = false
      continue
    }
    if (node.type === "link") {
      out += linkText(node, ctx)
      atLineStart = false
      continue
    }
    out += wrapperText(node as Wrapper, ctx)
    atLineStart = false
  }
  return out
}

function wrapperText(node: Wrapper, ctx: Ctx): string {
  const [open, close] = WRAPPERS[node.type as Exclude<Wrapper["type"], "link">]
  const inner = inlines(node.children, TAG_CHILDREN.has(node.type) ? "htmlText" : "emphasis", ctx)
  return open + inner + close
}

function text(value: string, context: PasteTextContext, ctx: Ctx): string {
  if (!ctx.cell) return escapePasteText(value, context, ctx.mode)
  // cell 源码里所有文本都要屏蔽管道；label 还要挡住 `[]` 收尾。
  const escaped = escapePasteText(value, "tableCell", ctx.mode)
  return context === "linkLabel" ? escapeBrackets(escaped) : escaped
}

function escapeBrackets(value: string): string {
  let out = ""
  let backslashes = 0
  for (const char of value) {
    if (char === "\\") { out += char; backslashes++; continue }
    if ((char === "[" || char === "]") && backslashes % 2 === 0) out += "\\"
    out += char
    backslashes = 0
  }
  return out
}

/** code span 定界符永远比内容里最长的反引号 run 宽一位。 */
function codeSpan(value: string): string {
  const fence = "`".repeat(longestRun(value, "`") + 1)
  const pad = value.startsWith("`") || value.endsWith("`") ? " " : ""
  return fence + pad + value + pad + fence
}

/**
 * cell 内联代码与 `parse/cell.ts::decodeShieldedPipes` 互为逆运算：GFM 行切分只
 * 保留「奇数个反斜杠 + 管道」里的一个屏蔽反斜杠，解码时正好去掉它。偶数 run 补
 * 一个；奇数 run 无法表达（解码会少一个），整表降级。
 */
function encodeCellCode(value: string): string | null {
  let out = ""
  let backslashes = 0
  for (const char of value) {
    if (char === "|") {
      if (backslashes % 2 === 1) return null
      out += "\\|"
      backslashes = 0
      continue
    }
    out += char
    backslashes = char === "\\" ? backslashes + 1 : 0
  }
  return out
}

function cellCodeSpan(value: string): string {
  const encoded = encodeCellCode(value)
  return codeSpan(encoded ?? value)
}

function linkText(node: Extract<InlineNode, { readonly type: "link" }>, ctx: Ctx): string {
  const label = inlines(node.children, "linkLabel", ctx)
  const fallback = text(node.href, "linkLabel", ctx)
  const destination = destinationText(node.href, ctx)
  const title = node.title === null ? "" : ` "${titleText(node.title, ctx)}"`
  return `[${label === "" ? fallback : label}](${destination}${title})`
}

function destinationText(href: string, ctx: Ctx): string {
  const destination = escapePasteText(href, "linkDestination", ctx.mode)
  return ctx.cell ? destination.replace(/\|/g, "%7C") : destination
}

function titleText(title: string, ctx: Ctx): string {
  const escaped = title.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
  const single = escaped.replace(/\r\n|\r|\n/g, " ")
  return ctx.cell ? single.replace(/\|/g, "\\|") : single
}

function imageText(node: ImageNode, ctx: Ctx): string {
  const source = imageSource(node, ctx)
  if (source === null) {
    // 未解析的资源只留 alt 可见文本，并聚合一条诊断。
    ctx.unresolved++
    return node.alt === "" ? "" : text(node.alt, "linkLabel", ctx)
  }
  const alt = text(node.alt, "linkLabel", ctx)
  const destination = destinationText(source, ctx)
  const title = node.title === null ? "" : ` "${titleText(node.title, ctx)}"`
  return `![${alt}](${destination}${title})`
}

function imageSource(node: ImageNode, ctx: Ctx): string | null {
  const source = node.source
  if (source.kind === "url") return source.value
  if (source.kind === "unavailable") return null
  const resolved = ctx.resolveAsset(source.key)
  return resolved === null || resolved === "" ? null : resolved
}

// ---------------------------------------------------- boundary / diagnostics

function boundaryOf(list: readonly PasteBlock[], allowComplexTable: boolean): PasteBoundary {
  const first = list[0]
  if (!first) return { start: "inline", end: "inline" }
  const single = list.length === 1 && first.type === "paragraph"
  if (single) return { start: "inline", end: "inline" }
  const last = list[list.length - 1]
  if (
    last.type === "table" &&
    last.table.requiresComplexHtml &&
    allowComplexTable &&
    canSerializeComplexTable(last.table)
  ) {
    return { start: "block", end: "htmlBlock" }
  }
  const opaque = last.type === "codeBlock" || last.type === "table" || last.type === "horizontalRule"
  return { start: "block", end: opaque ? "opaque" : "block" }
}

function diagnosticsOf(ctx: Ctx): PasteDiagnostic[] {
  const out: PasteDiagnostic[] = []
  if (ctx.unsupportedTables > 0) out.push({ kind: "unsupportedTable", count: ctx.unsupportedTables })
  if (ctx.unresolved > 0) out.push({ kind: "unresolvedAsset", count: ctx.unresolved })
  return out
}
