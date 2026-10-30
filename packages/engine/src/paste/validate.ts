/**
 * Smart Paste 的「至多一次解析」断路器（plan 02 Task 4）。
 *
 * 输入已经定稿：host 已按 `PasteBoundary` 规整过候选文本，验证器只回答
 * 「这串字节放进这个位置会不会改变别处的语义」，绝不改写候选 —— 不接受、
 * 不 trim、不再次规整。因此返回值里没有 text：编排层要么原样插入传入的
 * `text`，要么整段退回 strict literal（不重试、不二次解析）。
 *
 * 只读当前语法树**已覆盖**的上下文窗口；窗口不足、树没覆盖到、或候选/上下文
 * 超过 `limits.ts` 的护栏时，返回 `unavailable` / `limit`，绝不推进解析。
 * 真正需要判断时只解析一次：prefix + 候选 + suffix。
 *
 * 这是 engine 内部契约：不经 `src/index.ts` 导出，只由 `smartPaste.ts` 消费。
 */

import type { EditorState, Text } from "@codemirror/state"
import { syntaxTree } from "@codemirror/language"
import type { Parser, SyntaxNode, Tree } from "@lezer/common"
import { markdownLanguageSupport } from "../parse/markdown"
import { canSerializeComplexTable } from "./serializeComplexTable"
import {
  MAX_PASTE_VALIDATED_INSERT_CHARS,
  MAX_PASTE_VALIDATION_CONTEXT_CHARS,
} from "./limits"
import type { PasteBlock, PasteBoundary, PasteDocument, PasteInline } from "./model"

export interface PasteValidationRange {
  readonly from: number
  readonly to: number
}

/**
 * 候选的语义意图：`literal` 是逐字可见文本（明文快路径），`structured` 是
 * serializer 产出的最小 Markdown，附带它的 AST 作为「请求了哪些语义」的基准。
 */
export type PasteCandidateIntent =
  | { readonly kind: "literal" }
  | { readonly kind: "structured"; readonly document: PasteDocument }

export interface PasteValidationRequest {
  readonly state: EditorState
  readonly range: PasteValidationRange
  /** host 已规整（`normalizeBlockPaste`）过的最终候选文本。 */
  readonly text: string
  /** serializer 给出的边界事实。 */
  readonly boundary: PasteBoundary
  readonly intent: PasteCandidateIntent
}

export type PasteValidationRejection =
  /** 段落/硬换行边界与声明不符（候选会被宿主行/块吸收）。 */
  | "boundary"
  /** 关键块种类序列与意图不符。 */
  | "blockKind"
  /** 行内语义节点跨进了固定 prefix/suffix。 */
  | "crossingNode"
  /** 信封内被计数的行内语义与意图数量不符。 */
  | "inlineCount"
  /** literal 意图却产生了未请求的语义节点。 */
  | "unrequestedNode"

export type PasteValidationResult =
  | { readonly kind: "accepted" }
  | { readonly kind: "rejected"; readonly reason: PasteValidationRejection }
  /** 候选或上下文超过护栏：不解析，保守处理。 */
  | { readonly kind: "limit" }
  /** 当前语法树没有覆盖所需上下文：不解析，保守处理。 */
  | { readonly kind: "unavailable" }

// ------------------------------------------------------------ test seams

/**
 * 测试专用的解析/护栏注入点。生产路径永远用真实 parser 与 `limits.ts` 的常量；
 * 这里只为了让「下/恰好/上」三档护栏不依赖 256 KiB 夹具，并能数解析次数。
 */
export interface PasteValidationTestSeams {
  readonly maxContextChars?: number
  readonly maxInsertChars?: number
  readonly parse?: (source: string) => Tree
}

let parseCalls = 0
let maxContextChars = MAX_PASTE_VALIDATION_CONTEXT_CHARS
let maxInsertChars = MAX_PASTE_VALIDATED_INSERT_CHARS
let injectedParse: ((source: string) => Tree) | null = null
let cachedParser: Parser | null = null

/** 仅供测试：装/卸注入点并清零解析计数（`null` = 恢复生产路径）。 */
export function setPasteValidationTestSeams(seams: PasteValidationTestSeams | null): void {
  maxContextChars = seams?.maxContextChars ?? MAX_PASTE_VALIDATION_CONTEXT_CHARS
  maxInsertChars = seams?.maxInsertChars ?? MAX_PASTE_VALIDATED_INSERT_CHARS
  injectedParse = seams?.parse ?? null
  parseCalls = 0
}

/** 仅供测试：自上次 `setPasteValidationTestSeams` 以来的解析次数。 */
export function pasteValidationTestParseCalls(): number {
  return parseCalls
}

function parseOnce(source: string): Tree {
  parseCalls++
  if (injectedParse !== null) return injectedParse(source)
  cachedParser ??= markdownLanguageSupport().language.parser
  return cachedParser.parse(source)
}

// ----------------------------------------------------------------- entry

export function validatePasteCandidate(request: PasteValidationRequest): PasteValidationResult {
  const doc = request.state.doc
  const { from, to } = request.range
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > doc.length) {
    return { kind: "unavailable" }
  }
  const text = request.text
  // 空候选改不了任何字节，也就不需要电路保护。
  if (text.length === 0) return { kind: "accepted" }
  if (text.length > maxInsertChars) return { kind: "limit" }

  const tree = syntaxTree(request.state)
  const window = contextWindow(doc, tree, from, to)
  if (window === null) return { kind: "limit" }
  if (tree.length < window.end) return { kind: "unavailable" }

  const prefix = doc.sliceString(window.start, from)
  const suffix = doc.sliceString(to, window.end)
  const parsed = parseOnce(prefix + text + suffix)
  const reason = inspectSyntheticTree(parsed, prefix.length, prefix.length + text.length, request)
  return reason === null ? { kind: "accepted" } : { kind: "rejected", reason }
}

// ------------------------------------------------------------- context

interface ContextWindow {
  readonly start: number
  readonly end: number
}

/**
 * 从已覆盖的语法树里取一段有界上下文：优先落在块边界上，其次行边界，
 * 这样 prefix/suffix 不会被切成半个块。超过上下文护栏返回 `null`。
 */
function contextWindow(doc: Text, tree: Tree, from: number, to: number): ContextWindow | null {
  let start = doc.lineAt(from).from
  if (start === from && start > 0) {
    // 行首插入：上一行（哪怕空白）也是宿主事实，而且能保住「这里不是 BOF」——
    // 否则文档开头的 `---` 会被当成 FrontMatter，块判定凭空出错。
    start = blockStart(tree, doc.lineAt(start - 1).from)
  }
  start = blockStart(tree, start)
  if (from - start > maxContextChars) return null

  let end = doc.lineAt(to).to
  if (end === to && end < doc.length) {
    // 行尾插入：把下一行整行纳入，合成文档的行/块结构与真实文档一致。
    end = blockEnd(tree, doc.lineAt(end + 1).to)
  }
  end = blockEnd(tree, end)
  if (end - to > maxContextChars) return null
  return { start, end }
}

/** 若 `pos` 落在某个顶层块内部，退到该块起点。 */
function blockStart(tree: Tree, pos: number): number {
  const node = enclosingTopBlock(tree, pos)
  return node !== null && node.from < pos ? node.from : pos
}

/** 若 `pos` 落在某个顶层块内部，进到该块终点。 */
function blockEnd(tree: Tree, pos: number): number {
  const node = enclosingTopBlock(tree, pos)
  return node !== null && node.to > pos ? node.to : pos
}

function enclosingTopBlock(tree: Tree, pos: number): SyntaxNode | null {
  if (pos < 0 || pos > tree.length) return null
  for (let child = tree.topNode.firstChild; child !== null; child = child.nextSibling) {
    if (child.from > pos) return null
    if (child.from <= pos && pos < child.to) return child
  }
  return null
}

// ------------------------------------------------------------- checks

/** 信封边界节点：跨边界即意味着候选被宿主吸收或拆断了既有边界。 */
const BOUNDARY_NODES = new Set(["Paragraph", "HardBreak"])

/** 被逐类计数的行内语义节点（结构化候选按 `PasteDocument` 的期望值对齐）。 */
const COUNTED_INLINE = new Set([
  "StrongEmphasis", "Emphasis", "Strikethrough", "Highlight", "Underline", "Kbd",
  "Subscript", "Superscript", "InlineCode", "Link", "Image", "HardBreak",
  "InlineMath", "Entity", "Emoji", "Autolink", "LinkReference",
])

/** 跨界即改写了邻接语义的行内节点（含 mark 与字面转义节点）。 */
const INLINE_SEMANTIC = new Set([
  ...COUNTED_INLINE,
  // Link 的 destination 是 Link 的子节点；Autolink 另行计数。
  "URL", "HTMLTag", "Escape", "LinkLabel",
  "EmphasisMark", "StrikethroughMark", "HighlightMark", "UnderlineMark", "KbdMark",
  "RiseMark", "CodeMark", "LinkMark",
])

/** literal 候选在信封内不许凭空出现的块节点。 */
const LITERAL_BLOCK = new Set([
  "ATXHeading1", "ATXHeading2", "ATXHeading3", "ATXHeading4", "ATXHeading5", "ATXHeading6",
  "SetextHeading", "SetextHeading1", "SetextHeading2", "FencedCode", "CodeBlock",
  "HTMLBlock", "Table", "MathBlock", "Blockquote", "BulletList", "OrderedList",
  "HorizontalRule", "FrontMatter", "CommentBlock", "LinkReference", "FootnoteDefinition",
])

const INLINE_NODE_NAME: Partial<Record<PasteInline["type"], string>> = {
  strong: "StrongEmphasis",
  emphasis: "Emphasis",
  strike: "Strikethrough",
  highlight: "Highlight",
  underline: "Underline",
  kbd: "Kbd",
  subscript: "Subscript",
  superscript: "Superscript",
}

function inspectSyntheticTree(
  tree: Tree,
  start: number,
  end: number,
  request: PasteValidationRequest,
): PasteValidationRejection | null {
  const literal = request.intent.kind === "literal"
  const inlineStart = request.boundary.start === "inline"
  const inlineEnd = request.boundary.end === "inline"
  const blocks: string[] = []
  const counts = new Map<string, number>()
  let reason: PasteValidationRejection | null = null
  const fail = (next: PasteValidationRejection): false => {
    if (reason === null) reason = next
    return false
  }

  tree.iterate({
    from: start,
    to: end,
    enter(ref) {
      if (reason !== null) return false
      const name = ref.name
      const crossesStart = ref.from < start && ref.to > start
      const crossesEnd = ref.from < end && ref.to > end
      const inside = ref.from >= start && ref.to <= end

      if (BOUNDARY_NODES.has(name) && ((crossesStart && !inlineStart) || (crossesEnd && !inlineEnd))) {
        return fail("boundary")
      }
      if (INLINE_SEMANTIC.has(name)) {
        if (crossesStart || crossesEnd) return fail("crossingNode")
        if (inside && !inTableCell(ref.node)) {
          if (literal) return fail("unrequestedNode")
          if (COUNTED_INLINE.has(name)) counts.set(name, (counts.get(name) ?? 0) + 1)
        }
        return true
      }
      // 顶层块：只比较完整落在信封内的那些（跨界的宿主块由上面的边界规则管）。
      if (inside && ref.from < end && isTopLevel(ref.node)) {
        if (literal) {
          if (LITERAL_BLOCK.has(name)) return fail("unrequestedNode")
        } else {
          blocks.push(name)
        }
      }
      return true
    },
  })
  if (reason !== null || literal) return reason

  const document = request.intent.kind === "structured" ? request.intent.document : null
  if (document === null) return null
  const dropParagraphs = inlineStart && inlineEnd
  const expectedBlocks = document.blocks
    .map(blockKind)
    .filter(name => !(dropParagraphs && name === "Paragraph"))
  const observedBlocks = blocks.filter(name => !(dropParagraphs && name === "Paragraph"))
  if (!sameKinds(expectedBlocks, observedBlocks)) return "blockKind"

  const expectedCounts = inlineCounts(document.blocks)
  for (const name of new Set([...expectedCounts.keys(), ...counts.keys()])) {
    if ((expectedCounts.get(name) ?? 0) !== (counts.get(name) ?? 0)) return "inlineCount"
  }
  return null
}

/** 平衡树会把顶层块包进匿名分支节点里，所以沿父链跳过匿名节点。 */
function isTopLevel(node: SyntaxNode): boolean {
  let parent = node.parent
  while (parent !== null && parent.type.isAnonymous) parent = parent.parent
  return parent !== null && parent.type.isTop
}

function inTableCell(node: SyntaxNode): boolean {
  for (let parent = node.parent; parent !== null; parent = parent.parent) {
    if (parent.name === "Table") return true
  }
  return false
}

function sameKinds(expected: readonly string[], observed: readonly string[]): boolean {
  return expected.length === observed.length && expected.every((name, index) => name === observed[index])
}

function blockKind(block: PasteBlock): string {
  switch (block.type) {
    case "paragraph": return "Paragraph"
    case "heading": return `ATXHeading${block.level}`
    case "blockquote": return "Blockquote"
    case "list": return block.ordered ? "OrderedList" : "BulletList"
    case "codeBlock": return "FencedCode"
    case "table":
      return block.table.requiresComplexHtml && canSerializeComplexTable(block.table)
        ? "HTMLBlock"
        : "Table"
    case "horizontalRule": return "HorizontalRule"
  }
}

/**
 * 意图期望的行内语义计数。表格 cell 故意跳过：GFM cell 源码走的是另一套
 * 单行编码（`<br>`、屏蔽管道），由 `parse/cell.ts` 的契约守护。
 */
function inlineCounts(blocks: readonly PasteBlock[]): Map<string, number> {
  const counts = new Map<string, number>()
  const bump = (name: string) => counts.set(name, (counts.get(name) ?? 0) + 1)

  const visitInlines = (nodes: readonly PasteInline[]): void => {
    for (const node of nodes) {
      switch (node.type) {
        case "text": break
        case "code": bump("InlineCode"); break
        case "image": bump("Image"); break
        case "hardBreak": bump("HardBreak"); break
        case "link": bump("Link"); visitInlines(node.children); break
        default: {
          const name = INLINE_NODE_NAME[node.type]
          if (name !== undefined) bump(name)
          visitInlines(node.children)
        }
      }
    }
  }

  const visitBlocks = (list: readonly PasteBlock[]): void => {
    for (const block of list) {
      switch (block.type) {
        case "paragraph":
        case "heading":
          visitInlines(block.children)
          break
        case "blockquote":
          visitBlocks(block.children)
          break
        case "list":
          for (const item of block.items) visitBlocks(item.children)
          break
        case "codeBlock":
        case "table":
        case "horizontalRule":
          break
      }
    }
  }

  visitBlocks(blocks)
  return counts
}
