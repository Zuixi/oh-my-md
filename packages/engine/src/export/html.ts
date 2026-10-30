import { syntaxTree } from "@codemirror/language"
import type { EditorState } from "@codemirror/state"
import type { SyntaxNode } from "@lezer/common"
import { parseCell, type CellNode } from "../parse/cell"
import {
  parseComplexTableBlock,
  type ComplexTableCell,
  type ComplexTableInline,
  type ComplexTableModel,
} from "../parse/complexTable"
import { decodeHtmlEntity } from "../parse/entities"
import { linkParts, type LinkParts } from "../semantic/link"
import { imageParts } from "../semantic/image"
import { escapeParts } from "../semantic/breaks"
import { snapshotReferenceContext, type MarkdownReferenceContext } from "../semantic/references"
import { createMathHtmlCache } from "./mathHtmlCache"
import { EXPORT_BODY_CSS } from "./styles"

const SKIP = new Set([
  "HeaderMark", "EmphasisMark", "StrikethroughMark", "HighlightMark",
  "UnderlineMark", "KbdMark", "CodeMark", "CodeInfo", "LinkMark", "QuoteMark",
  "ListMark", "TaskMarker", "TableDelimiter", "RiseMark",
])

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function children(
  node: SyntaxNode,
  state: EditorState,
  ctx: MarkdownReferenceContext,
  from = node.from,
  to = node.to,
): string {
  let html = ""
  let pos = from
  for (let child = node.firstChild; child && child.from < to; child = child.nextSibling) {
    if (child.from > pos) html += escapeHtml(state.doc.sliceString(pos, child.from))
    html += render(child, state, ctx)
    pos = Math.min(child.to, to)
  }
  if (pos < to) html += escapeHtml(state.doc.sliceString(pos, to))
  return html
}

function inline(node: SyntaxNode, state: EditorState, ctx: MarkdownReferenceContext): string {
  if (!node.firstChild) return escapeHtml(state.doc.sliceString(node.from, node.to))
  return children(node, state, ctx)
}

// 可选 title 属性：null 时不输出，非 null 时同样走 escapeHtml。
function titleAttr(title: string | null): string {
  return title === null ? "" : ` title="${escapeHtml(title)}"`
}

function anchorHtml(href: string, title: string | null, label: string): string {
  return `<a href="${escapeHtml(href)}"${titleAttr(title)}>${label || escapeHtml(href)}</a>`
}

function imageHtml(src: string, alt: string, title: string | null): string {
  return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"${titleAttr(title)}>`
}

// Rich export rewrites only local relative paths: remote http/https images are
// never inlined.
function richImageSrc(src: string, opts: ExportRichHtmlOptions): string {
  const isRemote = /^https?:\/\//i.test(src)
  return (!isRemote && opts.resolveImageSrc) ? (opts.resolveImageSrc(src) ?? src) : src
}

// 每个 cell 都按 GFM 表格语义解析：表格层已经吃掉了 `\|` 的屏蔽反斜杠。
function cellSource(node: SyntaxNode, state: EditorState): string {
  return state.doc.sliceString(node.from, node.to).trim()
}

function fencedText(node: SyntaxNode, state: EditorState): string {
  const parts: string[] = []
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "CodeText") parts.push(state.doc.sliceString(child.from, child.to))
  }
  return parts.join("")
}

function cellChildrenHtml(children: CellNode[]): string {
  return children.map(cellNodeHtml).join("")
}

// 与 preview 的 renderTableCellContent 消费同一份 parseCell AST，保证导出与预览一致。
function cellNodeHtml(node: CellNode): string {
  switch (node.type) {
    case "text": return escapeHtml(node.text)
    case "code": return `<code>${escapeHtml(node.text)}</code>`
    // 同步导出的已知限制：没有 KaTeX，cell 数学回退成不带 `$` 标记的 <code>tex</code>；
    // rich 导出 (richCellNodesHtml) 才渲染 KaTeX。
    case "math": return `<code>${escapeHtml(node.text)}</code>`
    case "em": return `<em>${cellChildrenHtml(node.children)}</em>`
    case "strong": return `<strong>${cellChildrenHtml(node.children)}</strong>`
    case "del": return `<del>${cellChildrenHtml(node.children)}</del>`
    case "mark": return `<mark>${cellChildrenHtml(node.children)}</mark>`
    case "underline": return `<u>${cellChildrenHtml(node.children)}</u>`
    case "kbd": return `<kbd>${cellChildrenHtml(node.children)}</kbd>`
    case "sub": return `<sub>${cellChildrenHtml(node.children)}</sub>`
    case "sup": return `<sup>${cellChildrenHtml(node.children)}</sup>`
    case "link": return `<a href="${escapeHtml(node.href)}"${titleAttr(node.title)}>${cellChildrenHtml(node.children)}</a>`
    case "image": return imageHtml(node.src, node.alt, node.title)
    case "br": return "<br>"
    case "hr": return "<hr>"
    case "ul": return `<ul>${cellChildrenHtml(node.children)}</ul>`
    case "ol": return `<ol>${cellChildrenHtml(node.children)}</ol>`
    case "li": return `<li>${cellChildrenHtml(node.children)}</li>`
    case "blockquote": return `<blockquote>${cellChildrenHtml(node.children)}</blockquote>`
    case "pre": return `<pre><code>${escapeHtml(node.text)}</code></pre>`
  }
}

// 与 preview 的 renderTableCellContent 消费同一份 parseCell AST，保证导出与预览一致；
// 单元格外的引用定义由导出级的同一份 snapshot context 解析。
function cellText(node: SyntaxNode, state: EditorState, ctx: MarkdownReferenceContext): string {
  return cellChildrenHtml(parseCell(cellSource(node, state), {
    pipeEscapes: "gfm-table",
    resolveReference: ctx.resolveReference,
  }))
}

// rich 版的同一份 CellNode 投影：语义与同步导出一致，只有两处不同 —— cell 数学
// 走已有的 KaTeX 渲染器，本地图片走 rich 的 resolveImageSrc 策略。
function richCellNodeHtml(
  node: CellNode,
  opts: ExportRichHtmlOptions,
): string | Promise<string> {
  switch (node.type) {
    case "text": return escapeHtml(node.text)
    case "code": return `<code>${escapeHtml(node.text)}</code>`
    case "math": return renderMathHtml(node.text, false)
    case "em": return richCellNodesHtml(node.children, opts).then(s => `<em>${s}</em>`)
    case "strong": return richCellNodesHtml(node.children, opts).then(s => `<strong>${s}</strong>`)
    case "del": return richCellNodesHtml(node.children, opts).then(s => `<del>${s}</del>`)
    case "mark": return richCellNodesHtml(node.children, opts).then(s => `<mark>${s}</mark>`)
    case "underline": return richCellNodesHtml(node.children, opts).then(s => `<u>${s}</u>`)
    case "kbd": return richCellNodesHtml(node.children, opts).then(s => `<kbd>${s}</kbd>`)
    case "sub": return richCellNodesHtml(node.children, opts).then(s => `<sub>${s}</sub>`)
    case "sup": return richCellNodesHtml(node.children, opts).then(s => `<sup>${s}</sup>`)
    case "link":
      return richCellNodesHtml(node.children, opts).then(s =>
        `<a href="${escapeHtml(node.href)}"${titleAttr(node.title)}>${s}</a>`)
    case "image": return imageHtml(richImageSrc(node.src, opts), node.alt, node.title)
    case "br": return "<br>"
    case "hr": return "<hr>"
    case "ul": return richCellNodesHtml(node.children, opts).then(s => `<ul>${s}</ul>`)
    case "ol": return richCellNodesHtml(node.children, opts).then(s => `<ol>${s}</ol>`)
    case "li": return richCellNodesHtml(node.children, opts).then(s => `<li>${s}</li>`)
    case "blockquote":
      return richCellNodesHtml(node.children, opts).then(s => `<blockquote>${s}</blockquote>`)
    case "pre": return `<pre><code>${escapeHtml(node.text)}</code></pre>`
  }
}

async function richCellNodesHtml(
  nodes: readonly CellNode[],
  opts: ExportRichHtmlOptions,
): Promise<string> {
  let html = ""
  for (const node of nodes) html += await richCellNodeHtml(node, opts)
  return html
}

async function richRowHtml(
  node: SyntaxNode,
  state: EditorState,
  cell: "th" | "td",
  opts: ExportRichHtmlOptions,
  ctx: MarkdownReferenceContext,
): Promise<string> {
  let html = "<tr>"
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name !== "TableCell") continue
    const content = await richCellNodesHtml(
      parseCell(cellSource(child, state), {
        pipeEscapes: "gfm-table",
        resolveReference: ctx.resolveReference,
      }),
      opts,
    )
    html += `<${cell}>${content}</${cell}>`
  }
  return `${html}</tr>`
}

// 链接可见文本：autolink 取语义层给的文本，普通链接渲染 label 区间内的格式化内容。
function labelHtml(
  node: SyntaxNode,
  state: EditorState,
  ctx: MarkdownReferenceContext,
  parts: LinkParts,
): string {
  if (parts.kind === "autolink") return escapeHtml(parts.text)
  return children(node, state, ctx, parts.labelFrom, parts.labelTo)
}

function renderRow(
  node: SyntaxNode,
  state: EditorState,
  cell: "th" | "td",
  ctx: MarkdownReferenceContext,
): string {
  let html = "<tr>"
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "TableCell") html += `<${cell}>${cellText(child, state, ctx)}</${cell}>`
  }
  return `${html}</tr>`
}

function complexInlineHtml(
  node: ComplexTableInline,
  resolveSrc?: (src: string) => string,
): string {
  switch (node.type) {
    case "text": return escapeHtml(node.value)
    case "code": return `<code>${escapeHtml(node.value)}</code>`
    case "strong": return `<strong>${complexInlinesHtml(node.children, resolveSrc)}</strong>`
    case "emphasis": return `<em>${complexInlinesHtml(node.children, resolveSrc)}</em>`
    case "strike": return `<del>${complexInlinesHtml(node.children, resolveSrc)}</del>`
    case "highlight": return `<mark>${complexInlinesHtml(node.children, resolveSrc)}</mark>`
    case "underline": return `<u>${complexInlinesHtml(node.children, resolveSrc)}</u>`
    case "kbd": return `<kbd>${complexInlinesHtml(node.children, resolveSrc)}</kbd>`
    case "subscript": return `<sub>${complexInlinesHtml(node.children, resolveSrc)}</sub>`
    case "superscript": return `<sup>${complexInlinesHtml(node.children, resolveSrc)}</sup>`
    case "link":
      return `<a href="${escapeHtml(node.href)}"${titleAttr(node.title ?? null)}>${complexInlinesHtml(node.children, resolveSrc)}</a>`
    case "image":
      return imageHtml(resolveSrc ? resolveSrc(node.src) : node.src, node.alt, node.title ?? null)
    case "break": return "<br>"
  }
}

function complexInlinesHtml(
  nodes: readonly ComplexTableInline[],
  resolveSrc?: (src: string) => string,
): string {
  return nodes.map(n => complexInlineHtml(n, resolveSrc)).join("")
}

function complexCellHtml(
  cell: ComplexTableCell,
  resolveSrc?: (src: string) => string,
): string {
  const tag = cell.header ? "th" : "td"
  let attrs = ""
  if (cell.rowSpan > 1) attrs += ` rowspan="${cell.rowSpan}"`
  if (cell.colSpan > 1) attrs += ` colspan="${cell.colSpan}"`
  if (cell.header && cell.scope) attrs += ` scope="${cell.scope}"`
  if (cell.align) attrs += ` align="${cell.align}"`
  return `<${tag}${attrs}>${complexInlinesHtml(cell.children, resolveSrc)}</${tag}>`
}

function renderComplexTableHtml(
  model: ComplexTableModel,
  resolveSrc?: (src: string) => string,
): string {
  const headRows: string[] = []
  const bodyRows: string[] = []
  let inHead = true
  for (const row of model.rows) {
    if (inHead && row.length > 0 && row.every(c => c.header)) {
      headRows.push(`<tr>${row.map(c => complexCellHtml(c, resolveSrc)).join("")}</tr>`)
    } else {
      inHead = false
      bodyRows.push(`<tr>${row.map(c => complexCellHtml(c, resolveSrc)).join("")}</tr>`)
    }
  }
  const thead = headRows.length > 0 ? `<thead>${headRows.join("")}</thead>` : ""
  const tbody = bodyRows.length > 0 ? `<tbody>${bodyRows.join("")}</tbody>` : ""
  return `<table>${thead}${tbody}</table>`
}

function render(node: SyntaxNode, state: EditorState, ctx: MarkdownReferenceContext): string {
  if (SKIP.has(node.name)) return ""
  switch (node.name) {
    case "Document": return children(node, state, ctx)
    case "ATXHeading1":
    case "SetextHeading1": return `<h1>${inline(node, state, ctx).trim()}</h1>`
    case "ATXHeading2":
    case "SetextHeading2": return `<h2>${inline(node, state, ctx).trim()}</h2>`
    case "ATXHeading3": return `<h3>${inline(node, state, ctx).trim()}</h3>`
    case "ATXHeading4": return `<h4>${inline(node, state, ctx).trim()}</h4>`
    case "ATXHeading5": return `<h5>${inline(node, state, ctx).trim()}</h5>`
    case "ATXHeading6": return `<h6>${inline(node, state, ctx).trim()}</h6>`
    case "Paragraph": return `<p>${inline(node, state, ctx)}</p>`
    case "Emphasis": return `<em>${inline(node, state, ctx)}</em>`
    case "StrongEmphasis": return `<strong>${inline(node, state, ctx)}</strong>`
    case "Strikethrough": return `<del>${inline(node, state, ctx)}</del>`
    case "Highlight": return `<mark>${inline(node, state, ctx)}</mark>`
    case "Underline": return `<u>${inline(node, state, ctx)}</u>`
    case "Kbd": return `<kbd>${inline(node, state, ctx)}</kbd>`
    case "Subscript": return `<sub>${inline(node, state, ctx)}</sub>`
    case "Superscript": return `<sup>${inline(node, state, ctx)}</sup>`
    case "InlineCode": return `<code>${escapeHtml(state.doc.sliceString(node.from, node.to).replace(/^`+|`+$/g, ""))}</code>`
    case "Link":
    case "Autolink": {
      const parts = linkParts(node, ctx)
      if (!parts) return escapeHtml(state.doc.sliceString(node.from, node.to))
      return anchorHtml(parts.href, parts.title, labelHtml(node, state, ctx, parts))
    }
    case "HTMLTag": {
      const raw = state.doc.sliceString(node.from, node.to)
      if (/^<a\b[^>]*\bid\s*=\s*(['"])[^'"]+\1[^>]*>$/i.test(raw) || /^<\/a\s*>$/i.test(raw))
        return raw
      return escapeHtml(raw)
    }
    case "Image": {
      const parts = imageParts(node, ctx)
      if (!parts) return escapeHtml(state.doc.sliceString(node.from, node.to))
      return imageHtml(parts.src, parts.alt, parts.title)
    }
    case "Entity": {
      const raw = state.doc.sliceString(node.from, node.to)
      return escapeHtml(decodeHtmlEntity(raw) ?? raw)
    }
    // Escape 只导出被转义的字符；HardBreak 导出换行本身。两者都走 semantic/breaks
    // 的共享 accessor，与预览/cell 投影保持同一份语义。
    case "Escape": {
      const parts = escapeParts(node)
      if (!parts) return escapeHtml(state.doc.sliceString(node.from, node.to))
      return escapeHtml(state.doc.sliceString(parts.valueFrom, parts.valueTo))
    }
    case "HardBreak": return "<br>"
    case "FencedCode":
    case "CodeBlock":
      return `<pre><code>${escapeHtml(fencedText(node, state) || state.doc.sliceString(node.from, node.to))}</code></pre>`
    case "BulletList":
    case "OrderedList":
      return `<${node.name === "OrderedList" ? "ol" : "ul"}>${children(node, state, ctx)}</${node.name === "OrderedList" ? "ol" : "ul"}>`
    case "ListItem": return `<li>${children(node, state, ctx)}</li>`
    case "Blockquote": return `<blockquote>${children(node, state, ctx)}</blockquote>`
    case "HorizontalRule": return "<hr>"
    case "Table": {
      let html = "<table>"
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.name === "TableHeader") html += `<thead>${renderRow(child, state, "th", ctx)}</thead>`
        if (child.name === "TableRow") html += renderRow(child, state, "td", ctx)
      }
      return `${html}</table>`
    }
    case "HTMLBlock": {
      const raw = state.doc.sliceString(node.from, node.to)
      const model = parseComplexTableBlock(raw)
      if (model) return renderComplexTableHtml(model)
      return escapeHtml(raw)
    }
    case "InlineMath":
    case "MathBlock":
      return `<code>${escapeHtml(state.doc.sliceString(node.from, node.to))}</code>`
    default:
      if (node.firstChild) return children(node, state, ctx)
      return escapeHtml(state.doc.sliceString(node.from, node.to))
  }
}

export function exportHtml(state: EditorState): string {
  const ctx = snapshotReferenceContext(state)
  const body = render(syntaxTree(state).topNode, state, ctx)
  return `<!doctype html><html><head><meta charset="utf-8"><title>oh-my-md</title><style>${EXPORT_BODY_CSS}</style></head><body>${body}</body></html>`
}

// ---------------------------------------------------------------------------
// Rich async export: KaTeX math, Shiki code, Mermaid SVG
// ---------------------------------------------------------------------------

export interface ExportRichHtmlOptions {
  resolveImageSrc?: (src: string) => string
  /** User custom CSS, appended after the base typography so it wins. */
  customCss?: string
}

const mathHtmlCache = createMathHtmlCache()

async function renderMathHtml(tex: string, displayMode: boolean): Promise<string> {
  const cacheKey = `${displayMode ? "d" : "i"}:${tex}`
  const cached = mathHtmlCache.get(cacheKey)
  if (cached !== undefined) return cached
  try {
    const katex = (await import("katex")).default
    const html = katex.renderToString(tex, { displayMode, throwOnError: true })
    mathHtmlCache.set(cacheKey, html)
    return html
  } catch {
    return `<code>${escapeHtml(displayMode ? `$$${tex}$$` : `$${tex}$`)}</code>`
  }
}

let _mermaidCounter = 0

let _mermaidInitialized = false

async function renderMermaidHtml(src: string): Promise<string> {
  try {
    const mermaid = (await import("mermaid")).default
    if (!_mermaidInitialized) {
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict" })
      _mermaidInitialized = true
    }
    const id = `omd-export-mmd-${++_mermaidCounter}`
    const { svg } = await mermaid.render(id, src)
    return svg
  } catch {
    return `<pre>${escapeHtml(src)}</pre>`
  }
}

async function renderCodeHtml(src: string, lang: string): Promise<string> {
  const { resolveCodeLanguage, getHighlighterForExport } = await import("./shikiExport")
  const canonical = resolveCodeLanguage(lang)
  if (!canonical) return `<pre><code>${escapeHtml(src)}</code></pre>`
  try {
    const hl = await getHighlighterForExport(canonical)
    return hl.codeToHtml(src, {
      lang: canonical,
      themes: { light: "github-light", dark: "github-dark" },
      defaultColor: "light",
    })
  } catch {
    return `<pre><code>${escapeHtml(src)}</code></pre>`
  }
}

async function richChildren(
  node: SyntaxNode,
  state: EditorState,
  opts: ExportRichHtmlOptions,
  ctx: MarkdownReferenceContext,
  from = node.from,
  to = node.to,
): Promise<string> {
  let html = ""
  let pos = from
  for (let child = node.firstChild; child && child.from < to; child = child.nextSibling) {
    if (child.from > pos) html += escapeHtml(state.doc.sliceString(pos, child.from))
    const rendered = renderRich(child, state, opts, ctx)
    html += typeof rendered === "string" ? rendered : await rendered
    pos = Math.min(child.to, to)
  }
  if (pos < to) html += escapeHtml(state.doc.sliceString(pos, to))
  return html
}

async function richLabelHtml(
  node: SyntaxNode,
  state: EditorState,
  opts: ExportRichHtmlOptions,
  ctx: MarkdownReferenceContext,
  parts: LinkParts,
): Promise<string> {
  if (parts.kind === "autolink") return escapeHtml(parts.text)
  return richChildren(node, state, opts, ctx, parts.labelFrom, parts.labelTo)
}

function renderRich(
  node: SyntaxNode,
  state: EditorState,
  opts: ExportRichHtmlOptions,
  ctx: MarkdownReferenceContext,
): string | Promise<string> {
  if (SKIP.has(node.name)) return ""
  switch (node.name) {
    case "InlineMath": {
      const tex = state.doc.sliceString(node.from, node.to).replace(/^\$|\$$/g, "")
      return renderMathHtml(tex.trim(), false)
    }
    case "MathBlock": {
      const tex = state.doc.sliceString(node.from, node.to).replace(/^\$\$|\$\$\s*$/g, "").trim()
      return renderMathHtml(tex, true)
    }
    case "FencedCode":
    case "CodeBlock": {
      const codeText = fencedText(node, state) || state.doc.sliceString(node.from, node.to)
      const infoNode = node.getChild("CodeInfo")
      const lang = infoNode ? state.doc.sliceString(infoNode.from, infoNode.to).trim() : ""
      if (lang.toLowerCase() === "mermaid") return renderMermaidHtml(codeText)
      return renderCodeHtml(codeText, lang)
    }
    case "Image": {
      const parts = imageParts(node, ctx)
      if (!parts) return escapeHtml(state.doc.sliceString(node.from, node.to))
      return imageHtml(richImageSrc(parts.src, opts), parts.alt, parts.title)
    }
    case "Link":
    case "Autolink": {
      const parts = linkParts(node, ctx)
      if (!parts) return escapeHtml(state.doc.sliceString(node.from, node.to))
      return richLabelHtml(node, state, opts, ctx, parts).then(label =>
        anchorHtml(parts.href, parts.title, label))
    }
    case "Table": {
      return (async () => {
        let html = "<table>"
        for (let child = node.firstChild; child; child = child.nextSibling) {
          if (child.name === "TableHeader") html += `<thead>${await richRowHtml(child, state, "th", opts, ctx)}</thead>`
          if (child.name === "TableRow") html += await richRowHtml(child, state, "td", opts, ctx)
        }
        return `${html}</table>`
      })()
    }
    case "HTMLBlock": {
      const raw = state.doc.sliceString(node.from, node.to)
      const model = parseComplexTableBlock(raw)
      if (model) return renderComplexTableHtml(model, src => richImageSrc(src, opts))
      return escapeHtml(raw)
    }
    // Structural containers: richly render their children.
    case "ATXHeading1":
    case "SetextHeading1": return richChildren(node, state, opts, ctx).then(s => `<h1>${s.trim()}</h1>`)
    case "ATXHeading2":
    case "SetextHeading2": return richChildren(node, state, opts, ctx).then(s => `<h2>${s.trim()}</h2>`)
    case "ATXHeading3": return richChildren(node, state, opts, ctx).then(s => `<h3>${s.trim()}</h3>`)
    case "ATXHeading4": return richChildren(node, state, opts, ctx).then(s => `<h4>${s.trim()}</h4>`)
    case "ATXHeading5": return richChildren(node, state, opts, ctx).then(s => `<h5>${s.trim()}</h5>`)
    case "ATXHeading6": return richChildren(node, state, opts, ctx).then(s => `<h6>${s.trim()}</h6>`)
    case "Paragraph": return richChildren(node, state, opts, ctx).then(s => `<p>${s}</p>`)
    case "Emphasis": return richChildren(node, state, opts, ctx).then(s => `<em>${s}</em>`)
    case "StrongEmphasis": return richChildren(node, state, opts, ctx).then(s => `<strong>${s}</strong>`)
    case "Strikethrough": return richChildren(node, state, opts, ctx).then(s => `<del>${s}</del>`)
    case "Highlight": return richChildren(node, state, opts, ctx).then(s => `<mark>${s}</mark>`)
    case "Underline": return richChildren(node, state, opts, ctx).then(s => `<u>${s}</u>`)
    case "Kbd": return richChildren(node, state, opts, ctx).then(s => `<kbd>${s}</kbd>`)
    case "Subscript": return richChildren(node, state, opts, ctx).then(s => `<sub>${s}</sub>`)
    case "Superscript": return richChildren(node, state, opts, ctx).then(s => `<sup>${s}</sup>`)
    case "BulletList": return richChildren(node, state, opts, ctx).then(s => `<ul>${s}</ul>`)
    case "OrderedList": return richChildren(node, state, opts, ctx).then(s => `<ol>${s}</ol>`)
    case "ListItem": return richChildren(node, state, opts, ctx).then(s => `<li>${s}</li>`)
    case "Blockquote": return richChildren(node, state, opts, ctx).then(s => `<blockquote>${s}</blockquote>`)
    default:
      // Any unrecognised container: walk children richly so nested math/code is rendered.
      if (node.firstChild) return richChildren(node, state, opts, ctx)
      // True leaf: delegate to synchronous renderer.
      return render(node, state, ctx)
  }
}

// Dark-scheme mapping for dual-theme shiki output; mirrors the app stylesheet.
const SHIKI_DARK_CSS = `<style>
@media (prefers-color-scheme: dark) {
  .shiki, .shiki span {
    color: var(--shiki-dark) !important;
    background-color: var(--shiki-dark-bg) !important;
    font-style: var(--shiki-dark-font-style) !important;
    font-weight: var(--shiki-dark-font-weight) !important;
    text-decoration: var(--shiki-dark-text-decoration) !important;
  }
}
</style>`

export async function exportRichHtml(
  state: EditorState,
  options: ExportRichHtmlOptions = {},
): Promise<string> {
  const ctx = snapshotReferenceContext(state)
  const body = await renderRich(syntaxTree(state).topNode, state, options, ctx)
  const baseStyle = `<style>${EXPORT_BODY_CSS}</style>`
  const customStyle = options.customCss ? `<style>${options.customCss}</style>` : ""
  return `<!doctype html><html><head><meta charset="utf-8"><title>oh-my-md</title>${baseStyle}${customStyle}${SHIKI_DARK_CSS}</head><body>${body}<script>window.__omdExportReady = true</script></body></html>`
}
