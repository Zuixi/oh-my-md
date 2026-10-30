import { Language } from "@codemirror/language"
import type { SyntaxNode } from "@lezer/common"
import { markdownLanguageSupport } from "./markdown"
import { decodeHtmlEntity } from "./entities"
import { resolveEmoji } from "./emoji"
import { linkParts } from "../semantic/link"
import { imageParts } from "../semantic/image"
import { escapeParts } from "../semantic/breaks"
import { stringReferenceContext, type MarkdownReferenceContext } from "../semantic/references"

/** `parseCell` 的参考式链接解析入口：单元格外的定义由调用方提供。 */
export interface CellParseOptions {
  resolveReference?: MarkdownReferenceContext["resolveReference"]
  // "gfm-table"：源是 GFM 行切分后的原始 cell Markdown，表格层已经吃掉了 `\|` 的
  // 屏蔽反斜杠（行内代码没有 Escape 子节点，只能在这里补那一个）。默认 "markdown"
  // 保持独立调用的 Markdown 语义。
  pipeEscapes?: "markdown" | "gfm-table"
}

// 表格 cell 内容的渲染 AST：由引擎自有的 markdown parser 解析单个 cell（单行）
// 得到，DOM 渲染（decorations/widgets/table.ts）和 HTML 导出（export/html.ts）
// 都只消费这份 AST，保证预览与导出语义一致，且不重复实现 Markdown 语法识别。
export type CellNode =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "math"; text: string }
  | { type: "em"; children: CellNode[] }
  | { type: "strong"; children: CellNode[] }
  | { type: "del"; children: CellNode[] }
  | { type: "mark"; children: CellNode[] }
  | { type: "underline"; children: CellNode[] }
  | { type: "kbd"; children: CellNode[] }
  | { type: "sub"; children: CellNode[] }
  | { type: "sup"; children: CellNode[] }
  | { type: "link"; href: string; title: string | null; children: CellNode[] }
  | { type: "image"; src: string; alt: string; title: string | null }
  | { type: "br" }
  | { type: "hr" }
  | { type: "ul"; children: CellNode[] }
  | { type: "ol"; children: CellNode[] }
  | { type: "li"; children: CellNode[] }
  | { type: "blockquote"; children: CellNode[] }
  | { type: "pre"; text: string }

let language: Language | null = null

function markdownLanguage(): Language {
  if (!language) language = markdownLanguageSupport().language
  return language
}

// 有界上下文：切片只读本 cell 的 source，定义解析用调用方给的 resolver，
// 否则用片段自身的定义（同一个引擎 parser 解析，不另造 AST）。
interface CellContext extends MarkdownReferenceContext {
  readonly gfmPipes: boolean
}

function cellContext(source: string, options?: CellParseOptions): CellContext {
  const gfmPipes = options?.pipeEscapes === "gfm-table"
  const resolve = options?.resolveReference
  if (!resolve) return { ...stringReferenceContext(source), gfmPipes }
  return { sliceString: (from, to) => source.slice(from, to), resolveReference: resolve, gfmPipes }
}

// 行内代码是不透明值：GFM 行切分只为 `\|` 保留了「奇数个反斜杠 + 管道」里的一个
// 屏蔽反斜杠，去掉的只能是这一个；其余反斜杠是代码的字面量，必须原样保留。
function decodeShieldedPipes(text: string): string {
  return text.replace(/(\\+)\|/g, (match, run: string) =>
    run.length % 2 === 1 ? `${run.slice(1)}|` : match)
}

// 语法标记节点本身不渲染，只用于在遍历时定位真正的文本内容。
const SKIPPED = new Set([
  "EmphasisMark", "StrikethroughMark", "HighlightMark", "UnderlineMark", "KbdMark",
  "LinkMark", "CodeMark", "MathMark", "HeaderMark", "ListMark", "QuoteMark",
  "TaskMarker", "URL", "CodeInfo", "TableDelimiter", "RiseMark",
])

// 取首尾一对 mark 之间的内容，兼容 `` ` `` / `` `` ` `` `` 等不同宽度。
function betweenMarks(node: SyntaxNode, src: string, markName: string): string {
  const marks: { from: number; to: number }[] = []
  for (let child = node.firstChild; child; child = child.nextSibling)
    if (child.name === markName) marks.push({ from: child.from, to: child.to })
  if (marks.length >= 2) return src.slice(marks[0].to, marks[marks.length - 1].from)
  return src.slice(node.from, node.to).replace(/^`+|`+$/g, "")
}

function trimOuterText(nodes: CellNode[]): CellNode[] {
  const first = nodes[0]
  if (first?.type === "text") first.text = first.text.replace(/^[ \t]+/, "")
  const last = nodes[nodes.length - 1]
  if (last?.type === "text" && last !== first) last.text = last.text.replace(/[ \t]+$/, "")
  return nodes
}

function cellChild(node: SyntaxNode, src: string, ctx: CellContext): CellNode | null {
  switch (node.name) {
    case "Document":
    case "Paragraph":
      return null // 由 cellChildren 展平到父级，cell 内段落不渲染成 <p>
    case "Emphasis": return { type: "em", children: cellChildren(node, src, ctx) }
    case "StrongEmphasis": return { type: "strong", children: cellChildren(node, src, ctx) }
    case "Strikethrough": return { type: "del", children: cellChildren(node, src, ctx) }
    case "Highlight": return { type: "mark", children: cellChildren(node, src, ctx) }
    case "Underline": return { type: "underline", children: cellChildren(node, src, ctx) }
    case "Kbd": return { type: "kbd", children: cellChildren(node, src, ctx) }
    case "Subscript": return { type: "sub", children: cellChildren(node, src, ctx) }
    case "Superscript": return { type: "sup", children: cellChildren(node, src, ctx) }
    case "InlineCode": {
      const text = betweenMarks(node, src, "CodeMark")
      return { type: "code", text: ctx.gfmPipes ? decodeShieldedPipes(text) : text }
    }
    case "InlineMath":
    case "MathBlock": return { type: "math", text: betweenMarks(node, src, "MathMark") }
    case "Link":
    case "Autolink": {
      const parts = linkParts(node, ctx)
      // 未解析的引用链接保留成可见字面文本，不能整段消失。
      if (!parts) return { type: "text", text: src.slice(node.from, node.to) }
      return {
        type: "link",
        href: parts.href,
        title: parts.title,
        children: parts.kind === "autolink"
          ? [{ type: "text", text: parts.text }]
          // label 之外的 LinkLabel（`[text][id]` 的 `[id]`）不渲染。
          : cellChildren(node, src, ctx, parts.labelTo),
      }
    }
    case "Image": {
      const parts = imageParts(node, ctx)
      if (!parts) return { type: "text", text: src.slice(node.from, node.to) }
      return { type: "image", src: parts.src, alt: parts.alt, title: parts.title }
    }
    case "Entity": {
      const raw = src.slice(node.from, node.to)
      return { type: "text", text: decodeHtmlEntity(raw) ?? raw }
    }
    // Escape 是「marker + 真实字符」的双段语义：只保留被转义字符。
    case "Escape": {
      const parts = escapeParts(node)
      if (!parts) return { type: "text", text: src.slice(node.from, node.to) }
      return { type: "text", text: src.slice(parts.valueFrom, parts.valueTo) }
    }
    case "HardBreak": return { type: "br" }
    case "Emoji": {
      const raw = src.slice(node.from, node.to)
      return { type: "text", text: resolveEmoji(raw.slice(1, -1)) ?? raw }
    }
    case "HTMLTag": {
      const raw = src.slice(node.from, node.to)
      if (/^<br\s*\/?>/i.test(raw)) return { type: "br" }
      if (/^<hr\s*\/?>/i.test(raw)) return { type: "hr" }
      return { type: "text", text: raw }
    }
    case "BulletList": return { type: "ul", children: cellChildren(node, src, ctx) }
    case "OrderedList": return { type: "ol", children: cellChildren(node, src, ctx) }
    case "ListItem": return { type: "li", children: trimOuterText(cellChildren(node, src, ctx)) }
    case "Blockquote": return { type: "blockquote", children: trimOuterText(cellChildren(node, src, ctx)) }
    case "FencedCode": {
      const parts: string[] = []
      for (let child = node.firstChild; child; child = child.nextSibling)
        if (child.name === "CodeText") parts.push(src.slice(child.from, child.to))
      return { type: "pre", text: parts.join("") }
    }
    case "CodeBlock": return { type: "pre", text: src.slice(node.from, node.to) }
    case "HorizontalRule": return { type: "hr" }
    case "ATXHeading1": case "ATXHeading2": case "ATXHeading3":
    case "ATXHeading4": case "ATXHeading5": case "ATXHeading6":
    case "SetextHeading1": case "SetextHeading2":
      return { type: "strong", children: trimOuterText(cellChildren(node, src, ctx)) }
  }
  if (SKIPPED.has(node.name)) return null
  return { type: "text", text: src.slice(node.from, node.to) }
}

// `end` 限定读取范围：链接只取 label 区间，默认是整节点。
function cellChildren(
  node: SyntaxNode,
  src: string,
  ctx: CellContext,
  end = node.to,
): CellNode[] {
  const out: CellNode[] = []
  let pos = node.from
  for (let child = node.firstChild; child && child.from < end; child = child.nextSibling) {
    const stop = Math.min(child.to, end)
    if (child.from > pos) out.push({ type: "text", text: src.slice(pos, Math.min(child.from, end)) })
    if (child.name === "Document" || child.name === "Paragraph") {
      out.push(...cellChildren(child, src, ctx, stop))
    } else {
      const rendered = cellChild(child, src, ctx)
      if (rendered) out.push(rendered)
    }
    pos = stop
  }
  if (pos < end) out.push({ type: "text", text: src.slice(pos, end) })
  return out
}

export function parseCell(source: string, options?: CellParseOptions): CellNode[] {
  return cellChildren(markdownLanguage().parser.parse(source).topNode, source, cellContext(source, options))
}
