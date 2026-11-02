/**
 * Smart Paste 编排（plan 02 Task 4）：prepare → 选候选 → 宿主边界规整一次 →
 * 验证一次 → 原样返回或整段 strict 回退。
 *
 * 三条硬约束：
 * 1. 候选在解析之前就选定（`access_token` 走明文快路径，字面 `# title` 走
 *    结构化最小 Markdown），解析只做「这串字节会不会改别处的语义」的一次性
 *    断路器。
 * 2. 每个候选都经 `normalizeBlockPaste` 精确规整一次；被验证接受后**不再**
 *    改写（不 trim、不二次规整、不替换资产）。
 * 3. 验证失败 / 超护栏 / 树不可用一律直接整段 strict 序列化（不再解析第二次）；
 *    `policy: "literalFallback"` 完全不进候选与验证流程。
 *
 * 这里是 engine 内部编排，public 面只经 `src/index.ts` 导出。
 */

import type { EditorState, Text } from "@codemirror/state"
import { syntaxTree } from "@codemirror/language"
import type { SyntaxNode } from "@lezer/common"
import { normalizeBlockPaste } from "./blockBoundaries"
import type {
  PasteBlock,
  PasteBoundary,
  PasteDiagnostic,
  PasteDocument,
  PasteImageSource,
  PasteInline,
  PasteTableRow,
  PreparedSmartPaste,
  SmartPasteInput,
  SmartPastePlan,
} from "./model"
import { normalizeHtmlPaste } from "./normalizeHtml"
import { collectDiagnostics, preparePlainTextFallback, type DiagnosticCounts } from "./normalizeHtmlData"
import { serializePasteDocument } from "./serialize"
import { escapePasteText, type PasteTextContext } from "./triggerPolicy"
import { validatePasteCandidate } from "./validate"

export { preparePlainTextFallback }

export type PasteRange = { readonly from: number; readonly to: number }
export type PasteAssetResolution = ReadonlyMap<string, string>

type ResolveAsset = (key: string) => string | null

const INLINE: PasteBoundary = { start: "inline", end: "inline" }
/** strict 回退的块位：inline 片段也要独占块，否则转义字节会被邻座消费。 */
const ISOLATED: PasteBoundary = { start: "block", end: "block" }

/** 剪贴板 HTML → 规整后的 `PreparedSmartPaste`（detached DOM normalizer）。 */
export function prepareSmartPaste(input: SmartPasteInput): PreparedSmartPaste {
  return normalizeHtmlPaste(input)
}

/**
 * 为一次粘贴决定最终插入文本与诊断。
 *
 * 纯函数：不改 `prepared`，不 dispatch，不读 DOM，只读当前 state 的**已覆盖**
 * 语法树（绝不推进解析）。
 */
export function planSmartPaste(
  prepared: PreparedSmartPaste,
  state: EditorState,
  range: PasteRange,
  assets?: PasteAssetResolution,
): SmartPastePlan {
  const resolveAsset: ResolveAsset = key => assets?.get(key) ?? null
  const doc = state.doc
  // 宿主传进来的 range 必须落在文档内：规整函数会按位置切行，越界直接抛。
  const from = Math.min(Math.max(range.from, 0), doc.length)
  const safeRange: PasteRange = { from, to: Math.min(Math.max(range.to, from), doc.length) }
  if (prepared.policy === "literalFallback") {
    // 归一化护栏溢出 / host 转换失败：零候选、零验证解析。
    return strictPlan(prepared, safeRange, doc, resolveAsset, false)
  }

  const plainText = prepared.plainText
  if (canUsePlainCandidate(prepared.document, plainText, state, from)) {
    const boundary = INLINE
    const text = normalizeBlockPaste(doc, safeRange.from, safeRange.to, plainText, boundary).text
    const result = validatePasteCandidate({ state, range: safeRange, text, boundary, intent: { kind: "literal" } })
    if (result.kind === "accepted") {
      return { kind: "plain", text, diagnostics: aggregate(prepared.diagnostics) }
    }
    return strictPlan(prepared, safeRange, doc, resolveAsset, true)
  }

  const allowComplexTable = canHostComplexTable(state, safeRange)
  const serialized = serializePasteDocument(prepared.document, {
    mode: "minimal",
    resolveAsset,
    allowComplexTable,
  })
  // 候选边界就是 serializer 的事实；宿主只能在 `normalizeBlockPaste` 里决定
  // 是否补分隔（行中/行首），不得改写已验证的字节。
  const boundary = serialized.boundary
  const text = normalizeBlockPaste(doc, safeRange.from, safeRange.to, serialized.text, boundary).text
  const result = validatePasteCandidate({
    state,
    range: safeRange,
    text,
    boundary,
    intent: {
      kind: "structured",
      document: lowerValidationDocument(prepared.document, resolveAsset, allowComplexTable),
    },
  })
  if (result.kind === "accepted") {
    return { kind: "markdown", text, diagnostics: aggregate(prepared.diagnostics, serialized.diagnostics) }
  }
  return strictPlan(prepared, safeRange, doc, resolveAsset, true)
}

// ------------------------------------------------------------ candidates

/**
 * 明文快路径：文档只有 Text/Paragraph/HardBreak、可见文本与边界都和归一化后的
 * plain text 相等，且 trigger policy 在宿主上下文里找不到任何隐患。
 */
function canUsePlainCandidate(
  document: PasteDocument,
  plainText: string,
  state: EditorState,
  pos: number,
): boolean {
  if (plainText === "") return true
  if (document.blocks.some(block => block.type !== "paragraph" || !block.children.every(isPlainInline))) {
    return false
  }
  if (!sameVisibleText(document, plainText)) return false
  return !hasTriggerHazard(plainText, hostTextContext(state, pos))
}

function isPlainInline(node: PasteInline): boolean {
  return node.type === "text" || node.type === "hardBreak"
}

/** CRLF/CR → LF 只用于「HTML 可见文本 = plain text」这一处等价判断。 */
function toLf(value: string): string {
  return value.replace(/\r\n|\r/g, "\n")
}

function sameVisibleText(document: PasteDocument, plainText: string): boolean {
  const paragraphs: string[] = []
  for (const block of document.blocks) {
    if (block.type !== "paragraph") return false
    let text = ""
    for (const node of block.children) {
      if (node.type === "text") text += node.value
      else if (node.type === "hardBreak") text += "\n"
      else return false
    }
    paragraphs.push(text)
  }
  return paragraphs.join("\n\n") === toLf(plainText)
}

/**
 * trigger policy 是「这段可见文本会不会被读成语义」的唯一判据：最小转义若改变
 * 了字节，说明宿主上下文里存在隐患，明文快路径不安全。
 */
function hasTriggerHazard(text: string, context: PasteTextContext): boolean {
  if (escapePasteText(text, "lineStart", "minimal") !== text) return true
  if (context === "paragraph") return false
  return escapePasteText(text, context, "minimal") !== text
}

/** 插入点所在的宿主行内上下文（未覆盖的树按 `paragraph` 处理）。 */
function hostTextContext(state: EditorState, pos: number): PasteTextContext {
  const tree = syntaxTree(state)
  if (pos < 0 || pos > tree.length) return "paragraph"
  let node: SyntaxNode | null = tree.resolveInner(pos, 1)
  while (node !== null) {
    switch (node.name) {
      case "Link":
      case "LinkLabel":
      case "Image":
        return "linkLabel"
      case "Emphasis":
      case "StrongEmphasis":
      case "Strikethrough":
      case "Highlight":
      case "Underline":
      case "Subscript":
      case "Superscript":
        return "emphasis"
      case "Document":
        return "paragraph"
      default:
        node = node.parent
    }
  }
  return "paragraph"
}

/**
 * 整段 strict 回退：strict 序列化 + 宿主边界规整一次，**不再解析**。
 * `addDiagnostic` 为 false 时沿用 prepared 已带的 `strictFallback`（literalFallback）。
 */
function strictPlan(
  prepared: PreparedSmartPaste,
  range: PasteRange,
  doc: Text,
  resolveAsset: ResolveAsset,
  addDiagnostic: boolean,
): SmartPastePlan {
  const serialized = serializePasteDocument(prepared.document, { mode: "strict", resolveAsset })
  const boundary: PasteBoundary = {
    start: "block",
    end: serialized.boundary.end === "inline" ? ISOLATED.end : serialized.boundary.end,
  }
  const text = normalizeBlockPaste(doc, range.from, range.to, serialized.text, boundary).text
  return {
    kind: "markdown",
    text,
    diagnostics: aggregate(
      prepared.diagnostics,
      serialized.diagnostics,
      addDiagnostic ? [{ kind: "strictFallback", count: 1 }] : [],
    ),
  }
}

/**
 * 复杂表 canonical HTML（CommonMark Type 6）只有在顶层/段落上下文才安全隔离；
 * 树未覆盖或插入点在列表/引用/围栏/HTML/表格等块容器内时一律禁止发射 HTMLBlock，
 * 由 serializer 直接降级为可见单元格文本 + `unsupportedTable`。
 */
function canHostComplexTable(state: EditorState, range: PasteRange): boolean {
  const tree = syntaxTree(state)
  if (tree.length < state.doc.length && tree.length < range.to) return false
  if (state.doc.length > 0 && tree.length === 0) return false
  return isTopLevelOrParagraphHost(tree, range.from) && isTopLevelOrParagraphHost(tree, range.to)
}

function isTopLevelOrParagraphHost(tree: ReturnType<typeof syntaxTree>, pos: number): boolean {
  for (const side of [-1, 1] as const) {
    let node: SyntaxNode | null = tree.resolveInner(pos, side)
    while (node !== null) {
      switch (node.name) {
        case "BulletList":
        case "OrderedList":
        case "ListItem":
        case "Blockquote":
        case "FencedCode":
        case "CodeBlock":
        case "HTMLBlock":
        case "Table":
        case "MathBlock":
        case "FrontMatter":
        case "CommentBlock":
          return false
        default:
          node = node.parent
      }
    }
  }
  return true
}

/**
 * 未解析（embedded 缺资产 / unavailable）的图片在进验证基准前先降级成 alt 文本，
 * 否则「意图里有 Image、候选里只有 alt」会被判成 inlineCount 假阳性。
 * 若宿主不允许复杂 HTML 表，则同步清除 `requiresComplexHtml`，使验证器期望 `Table`。
 */
function lowerValidationDocument(
  document: PasteDocument,
  resolveAsset: ResolveAsset,
  allowComplexTable: boolean,
): PasteDocument {
  return { blocks: lowerBlocks(document.blocks, resolveAsset, allowComplexTable) }
}

function lowerBlocks(
  blocks: readonly PasteBlock[],
  resolveAsset: ResolveAsset,
  allowComplexTable: boolean,
): readonly PasteBlock[] {
  let changed = false
  const out: PasteBlock[] = []
  for (const block of blocks) {
    switch (block.type) {
      case "paragraph":
      case "heading": {
        const children = lowerInlines(block.children, resolveAsset)
        changed ||= children !== block.children
        out.push(children === block.children ? block : { ...block, children })
        break
      }
      case "blockquote": {
        const children = lowerBlocks(block.children, resolveAsset, allowComplexTable)
        changed ||= children !== block.children
        out.push(children === block.children ? block : { ...block, children })
        break
      }
      case "list": {
        const items = block.items.map(item => {
          const children = lowerBlocks(item.children, resolveAsset, allowComplexTable)
          return children === item.children ? item : { ...item, children }
        })
        changed ||= items.some((item, index) => item !== block.items[index])
        out.push(items.every((item, index) => item === block.items[index]) ? block : { ...block, items })
        break
      }
      case "table": {
        const rows = lowerRows(block.table.rows, resolveAsset, allowComplexTable)
        const requiresComplexHtml = allowComplexTable ? block.table.requiresComplexHtml : false
        const tableChanged = rows !== block.table.rows || requiresComplexHtml !== block.table.requiresComplexHtml
        changed ||= tableChanged
        out.push(
          !tableChanged
            ? block
            : { ...block, table: { ...block.table, rows, requiresComplexHtml } },
        )
        break
      }
      default:
        out.push(block)
    }
  }
  return changed ? out : blocks
}

function lowerRows(
  rows: readonly PasteTableRow[],
  resolveAsset: ResolveAsset,
  allowComplexTable: boolean,
): readonly PasteTableRow[] {
  let changed = false
  const out = rows.map(row => {
    const cells = row.cells.map(cell => {
      const blocks = lowerBlocks(cell.blocks, resolveAsset, allowComplexTable)
      return blocks === cell.blocks ? cell : { ...cell, blocks }
    })
    if (cells.every((cell, index) => cell === row.cells[index])) return row
    changed = true
    return { ...row, cells }
  })
  return changed ? out : rows
}

function lowerInlines(nodes: readonly PasteInline[], resolveAsset: ResolveAsset): readonly PasteInline[] {
  let changed = false
  const out: PasteInline[] = []
  for (const node of nodes) {
    if (node.type === "image") {
      if (resolvable(node.source, resolveAsset)) {
        out.push(node)
        continue
      }
      changed = true
      if (node.alt !== "") out.push({ type: "text", value: node.alt })
      continue
    }
    if (node.type === "link") {
      const children = lowerInlines(node.children, resolveAsset)
      changed ||= children !== node.children
      out.push(children === node.children ? node : { ...node, children })
      continue
    }
    if (node.type === "text" || node.type === "code" || node.type === "hardBreak") {
      out.push(node)
      continue
    }
    const children = lowerInlines(node.children, resolveAsset)
    changed ||= children !== node.children
    out.push(children === node.children ? node : { ...node, children })
  }
  return changed ? out : nodes
}

/** 与 `serialize.ts::imageSource` 同一条判定：url 直通，unavailable/缺资产降级。 */
function resolvable(source: PasteImageSource, resolveAsset: ResolveAsset): boolean {
  if (source.kind === "url") return true
  if (source.kind === "unavailable") return false
  const resolved = resolveAsset(source.key)
  return resolved !== null && resolved !== ""
}

// ------------------------------------------------------------ diagnostics

/** 聚合诊断：同类计数相加，顺序与 normalizer 的稳定顺序一致。 */
function aggregate(...lists: readonly (readonly PasteDiagnostic[])[]): PasteDiagnostic[] {
  const counts: DiagnosticCounts = {}
  for (const list of lists) {
    for (const diagnostic of list) {
      counts[diagnostic.kind] = (counts[diagnostic.kind] ?? 0) + diagnostic.count
    }
  }
  return collectDiagnostics(counts)
}
