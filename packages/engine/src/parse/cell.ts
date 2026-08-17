import { Language } from "@codemirror/language"
import type { SyntaxNode } from "@lezer/common"
import { markdownLanguageSupport } from "./markdown"
import { decodeHtmlEntity } from "./entities"
import { resolveEmoji } from "./emoji"

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
  | { type: "link"; href: string; children: CellNode[] }
  | { type: "image"; src: string; alt: string }
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

// 语法标记节点本身不渲染，只用于在遍历时定位真正的文本内容。
const SKIPPED = new Set([
  "EmphasisMark", "StrikethroughMark", "HighlightMark", "UnderlineMark",
  "LinkMark", "CodeMark", "MathMark", "HeaderMark", "ListMark", "QuoteMark",
  "TaskMarker", "URL", "CodeInfo", "TableDelimiter",
])

function autolinkHref(value: string): string {
  return value.includes("@") && !/^[a-z][a-z0-9+.-]*:/i.test(value)
    ? `mailto:${value}`
    : value.startsWith("www.") ? `https://${value}` : value
}

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

function cellChild(node: SyntaxNode, src: string): CellNode | null {
  switch (node.name) {
    case "Document":
    case "Paragraph":
      return null // 由 cellChildren 展平到父级，cell 内段落不渲染成 <p>
    case "Emphasis": return { type: "em", children: cellChildren(node, src) }
    case "StrongEmphasis": return { type: "strong", children: cellChildren(node, src) }
    case "Strikethrough": return { type: "del", children: cellChildren(node, src) }
    case "Highlight": return { type: "mark", children: cellChildren(node, src) }
    case "Underline": return { type: "underline", children: cellChildren(node, src) }
    case "InlineCode": return { type: "code", text: betweenMarks(node, src, "CodeMark") }
    case "InlineMath":
    case "MathBlock": return { type: "math", text: betweenMarks(node, src, "MathMark") }
    case "Link": {
      const url = node.getChild("URL")
      return {
        type: "link",
        href: url ? src.slice(url.from, url.to) : src.slice(node.from, node.to),
        children: cellChildren(node, src),
      }
    }
    case "Autolink": {
      const url = node.getChild("URL")
      const value = url ? src.slice(url.from, url.to) : src.slice(node.from, node.to)
      return { type: "link", href: autolinkHref(value), children: [{ type: "text", text: value }] }
    }
    case "Image": {
      const url = node.getChild("URL")
      const head = src.slice(node.from, url ? url.from : node.to)
      const altEnd = head.indexOf("](")
      const alt = altEnd > 1 ? head.slice(2, altEnd) : ""
      return { type: "image", src: url ? src.slice(url.from, url.to) : "", alt }
    }
    case "Entity": {
      const raw = src.slice(node.from, node.to)
      return { type: "text", text: decodeHtmlEntity(raw) ?? raw }
    }
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
    case "BulletList": return { type: "ul", children: cellChildren(node, src) }
    case "OrderedList": return { type: "ol", children: cellChildren(node, src) }
    case "ListItem": return { type: "li", children: trimOuterText(cellChildren(node, src)) }
    case "Blockquote": return { type: "blockquote", children: trimOuterText(cellChildren(node, src)) }
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
      return { type: "strong", children: trimOuterText(cellChildren(node, src)) }
  }
  if (SKIPPED.has(node.name)) return null
  return { type: "text", text: src.slice(node.from, node.to) }
}

function cellChildren(node: SyntaxNode, src: string): CellNode[] {
  const out: CellNode[] = []
  let pos = node.from
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.from > pos) out.push({ type: "text", text: src.slice(pos, child.from) })
    if (child.name === "Document" || child.name === "Paragraph") {
      out.push(...cellChildren(child, src))
    } else {
      const rendered = cellChild(child, src)
      if (rendered) out.push(rendered)
    }
    pos = child.to
  }
  if (pos < node.to) out.push({ type: "text", text: src.slice(pos, node.to) })
  return out
}

export function parseCell(source: string): CellNode[] {
  return cellChildren(markdownLanguage().parser.parse(source).topNode, source)
}
