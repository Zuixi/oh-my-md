import { syntaxTree } from "@codemirror/language"
import type { EditorState } from "@codemirror/state"
import type { SyntaxNode } from "@lezer/common"
import { parseCell, type CellNode } from "../parse/cell"
import { linkHref } from "../links"
import { EXPORT_BODY_CSS } from "./styles"

const SKIP = new Set([
  "HeaderMark", "EmphasisMark", "StrikethroughMark", "HighlightMark",
  "UnderlineMark", "CodeMark", "CodeInfo", "LinkMark", "QuoteMark",
  "ListMark", "TaskMarker", "TableDelimiter", "RiseMark",
])

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function children(node: SyntaxNode, state: EditorState): string {
  let html = ""
  let pos = node.from
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.from > pos) html += escapeHtml(state.doc.sliceString(pos, child.from))
    html += render(child, state)
    pos = child.to
  }
  if (pos < node.to) html += escapeHtml(state.doc.sliceString(pos, node.to))
  return html
}

function inline(node: SyntaxNode, state: EditorState): string {
  if (!node.firstChild) return escapeHtml(state.doc.sliceString(node.from, node.to))
  return children(node, state)
}

function autolinkHref(value: string): string {
  return value.includes("@") && !/^[a-z][a-z0-9+.-]*:/i.test(value)
    ? `mailto:${value}`
    : value.startsWith("www.") ? `https://${value}` : value
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
    case "math": return `<code>${escapeHtml(node.text)}</code>`
    case "em": return `<em>${cellChildrenHtml(node.children)}</em>`
    case "strong": return `<strong>${cellChildrenHtml(node.children)}</strong>`
    case "del": return `<del>${cellChildrenHtml(node.children)}</del>`
    case "mark": return `<mark>${cellChildrenHtml(node.children)}</mark>`
    case "underline": return `<u>${cellChildrenHtml(node.children)}</u>`
    case "link": return `<a href="${escapeHtml(node.href)}">${cellChildrenHtml(node.children)}</a>`
    case "image": return `<img src="${escapeHtml(node.src)}" alt="${escapeHtml(node.alt)}">`
    case "br": return "<br>"
    case "hr": return "<hr>"
    case "ul": return `<ul>${cellChildrenHtml(node.children)}</ul>`
    case "ol": return `<ol>${cellChildrenHtml(node.children)}</ol>`
    case "li": return `<li>${cellChildrenHtml(node.children)}</li>`
    case "blockquote": return `<blockquote>${cellChildrenHtml(node.children)}</blockquote>`
    case "pre": return `<pre><code>${escapeHtml(node.text)}</code></pre>`
  }
}

function cellText(node: SyntaxNode, state: EditorState): string {
  const source = state.doc.sliceString(node.from, node.to).replace(/\\\|/g, "|").trim()
  return cellChildrenHtml(parseCell(source))
}

function linkLabel(node: SyntaxNode, state: EditorState): string {
  const marks = Array.from((function* () {
    for (let child = node.firstChild; child; child = child.nextSibling)
      if (child.name === "LinkMark") yield child
  })())
  if (marks.length < 2) return ""

  let html = ""
  let pos = marks[0].to
  for (let child = marks[0].nextSibling; child && child.from < marks[1].from; child = child.nextSibling) {
    if (child.from > pos) html += escapeHtml(state.doc.sliceString(pos, child.from))
    html += render(child, state)
    pos = child.to
  }
  if (pos < marks[1].from) html += escapeHtml(state.doc.sliceString(pos, marks[1].from))
  return html
}

function renderRow(node: SyntaxNode, state: EditorState, cell: "th" | "td"): string {
  let html = "<tr>"
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "TableCell") html += `<${cell}>${cellText(child, state)}</${cell}>`
  }
  return `${html}</tr>`
}

function render(node: SyntaxNode, state: EditorState): string {
  if (SKIP.has(node.name)) return ""
  switch (node.name) {
    case "Document": return children(node, state)
    case "ATXHeading1":
    case "SetextHeading1": return `<h1>${inline(node, state).trim()}</h1>`
    case "ATXHeading2":
    case "SetextHeading2": return `<h2>${inline(node, state).trim()}</h2>`
    case "ATXHeading3": return `<h3>${inline(node, state).trim()}</h3>`
    case "ATXHeading4": return `<h4>${inline(node, state).trim()}</h4>`
    case "ATXHeading5": return `<h5>${inline(node, state).trim()}</h5>`
    case "ATXHeading6": return `<h6>${inline(node, state).trim()}</h6>`
    case "Paragraph": return `<p>${inline(node, state)}</p>`
    case "Emphasis": return `<em>${inline(node, state)}</em>`
    case "StrongEmphasis": return `<strong>${inline(node, state)}</strong>`
    case "Strikethrough": return `<del>${inline(node, state)}</del>`
    case "Highlight": return `<mark>${inline(node, state)}</mark>`
    case "Underline": return `<u>${inline(node, state)}</u>`
    case "Subscript": return `<sub>${inline(node, state)}</sub>`
    case "Superscript": return `<sup>${inline(node, state)}</sup>`
    case "InlineCode": return `<code>${escapeHtml(state.doc.sliceString(node.from, node.to).replace(/^`+|`+$/g, ""))}</code>`
    case "Link": {
      const href = linkHref(state, node) ?? ""
      const label = linkLabel(node, state)
      return `<a href="${escapeHtml(href)}">${label || escapeHtml(href)}</a>`
    }
    case "Autolink": {
      const url = node.getChild("URL")
      const value = url ? state.doc.sliceString(url.from, url.to) : state.doc.sliceString(node.from, node.to)
      return `<a href="${escapeHtml(autolinkHref(value))}">${escapeHtml(value)}</a>`
    }
    case "HTMLTag": {
      const raw = state.doc.sliceString(node.from, node.to)
      if (/^<a\b[^>]*\bid\s*=\s*(['"])[^'"]+\1[^>]*>$/i.test(raw) || /^<\/a\s*>$/i.test(raw))
        return raw
      return escapeHtml(raw)
    }
    case "Image": {
      const url = node.getChild("URL")
      const src = url ? state.doc.sliceString(url.from, url.to) : ""
      return `<img src="${escapeHtml(src)}" alt="">`
    }
    case "FencedCode":
    case "CodeBlock":
      return `<pre><code>${escapeHtml(fencedText(node, state) || state.doc.sliceString(node.from, node.to))}</code></pre>`
    case "BulletList":
    case "OrderedList":
      return `<${node.name === "OrderedList" ? "ol" : "ul"}>${children(node, state)}</${node.name === "OrderedList" ? "ol" : "ul"}>`
    case "ListItem": return `<li>${children(node, state)}</li>`
    case "Blockquote": return `<blockquote>${children(node, state)}</blockquote>`
    case "HorizontalRule": return "<hr>"
    case "Table": {
      let html = "<table>"
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.name === "TableHeader") html += `<thead>${renderRow(child, state, "th")}</thead>`
        if (child.name === "TableRow") html += renderRow(child, state, "td")
      }
      return `${html}</table>`
    }
    case "InlineMath":
    case "MathBlock":
      return `<code>${escapeHtml(state.doc.sliceString(node.from, node.to))}</code>`
    default:
      if (node.firstChild) return children(node, state)
      return escapeHtml(state.doc.sliceString(node.from, node.to))
  }
}

export function exportHtml(state: EditorState): string {
  const body = render(syntaxTree(state).topNode, state)
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

const mathHtmlCache = new Map<string, string>()

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
): Promise<string> {
  let html = ""
  let pos = node.from
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.from > pos) html += escapeHtml(state.doc.sliceString(pos, child.from))
    const rendered = renderRich(child, state, opts)
    html += typeof rendered === "string" ? rendered : await rendered
    pos = child.to
  }
  if (pos < node.to) html += escapeHtml(state.doc.sliceString(pos, node.to))
  return html
}

async function richLinkLabel(
  node: SyntaxNode,
  state: EditorState,
  opts: ExportRichHtmlOptions,
): Promise<string> {
  const marks: SyntaxNode[] = []
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "LinkMark") marks.push(child)
  }
  if (marks.length < 2) return ""
  let html = ""
  let pos = marks[0].to
  for (let child = marks[0].nextSibling; child && child.from < marks[1].from; child = child.nextSibling) {
    if (child.from > pos) html += escapeHtml(state.doc.sliceString(pos, child.from))
    const rendered = renderRich(child, state, opts)
    html += typeof rendered === "string" ? rendered : await rendered
    pos = child.to
  }
  if (pos < marks[1].from) html += escapeHtml(state.doc.sliceString(pos, marks[1].from))
  return html
}

function renderRich(
  node: SyntaxNode,
  state: EditorState,
  opts: ExportRichHtmlOptions,
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
      const urlNode = node.getChild("URL")
      const rawSrc = urlNode ? state.doc.sliceString(urlNode.from, urlNode.to) : ""
      // Do not inline remote http/https images; only rewrite local relative paths.
      const isRemote = /^https?:\/\//i.test(rawSrc)
      const src = (!isRemote && opts.resolveImageSrc) ? (opts.resolveImageSrc(rawSrc) ?? rawSrc) : rawSrc
      return `<img src="${escapeHtml(src)}" alt="">`
    }
    case "Link": {
      const href = linkHref(state, node) ?? ""
      return richLinkLabel(node, state, opts).then(label =>
        `<a href="${escapeHtml(href)}">${label || escapeHtml(href)}</a>`)
    }
    case "Table": {
      return (async () => {
        let html = "<table>"
        for (let child = node.firstChild; child; child = child.nextSibling) {
          if (child.name === "TableHeader") {
            html += "<thead><tr>"
            for (let cell = child.firstChild; cell; cell = cell.nextSibling) {
              if (cell.name === "TableCell") html += `<th>${await richChildren(cell, state, opts)}</th>`
            }
            html += "</tr></thead>"
          }
          if (child.name === "TableRow") {
            html += "<tr>"
            for (let cell = child.firstChild; cell; cell = cell.nextSibling) {
              if (cell.name === "TableCell") html += `<td>${await richChildren(cell, state, opts)}</td>`
            }
            html += "</tr>"
          }
        }
        return `${html}</table>`
      })()
    }
    // Structural containers: richly render their children.
    case "ATXHeading1":
    case "SetextHeading1": return richChildren(node, state, opts).then(s => `<h1>${s.trim()}</h1>`)
    case "ATXHeading2":
    case "SetextHeading2": return richChildren(node, state, opts).then(s => `<h2>${s.trim()}</h2>`)
    case "ATXHeading3": return richChildren(node, state, opts).then(s => `<h3>${s.trim()}</h3>`)
    case "ATXHeading4": return richChildren(node, state, opts).then(s => `<h4>${s.trim()}</h4>`)
    case "ATXHeading5": return richChildren(node, state, opts).then(s => `<h5>${s.trim()}</h5>`)
    case "ATXHeading6": return richChildren(node, state, opts).then(s => `<h6>${s.trim()}</h6>`)
    case "Paragraph": return richChildren(node, state, opts).then(s => `<p>${s}</p>`)
    case "Emphasis": return richChildren(node, state, opts).then(s => `<em>${s}</em>`)
    case "StrongEmphasis": return richChildren(node, state, opts).then(s => `<strong>${s}</strong>`)
    case "Strikethrough": return richChildren(node, state, opts).then(s => `<del>${s}</del>`)
    case "Highlight": return richChildren(node, state, opts).then(s => `<mark>${s}</mark>`)
    case "Underline": return richChildren(node, state, opts).then(s => `<u>${s}</u>`)
    case "Subscript": return richChildren(node, state, opts).then(s => `<sub>${s}</sub>`)
    case "Superscript": return richChildren(node, state, opts).then(s => `<sup>${s}</sup>`)
    case "BulletList": return richChildren(node, state, opts).then(s => `<ul>${s}</ul>`)
    case "OrderedList": return richChildren(node, state, opts).then(s => `<ol>${s}</ol>`)
    case "ListItem": return richChildren(node, state, opts).then(s => `<li>${s}</li>`)
    case "Blockquote": return richChildren(node, state, opts).then(s => `<blockquote>${s}</blockquote>`)
    default:
      // Any unrecognised container: walk children richly so nested math/code is rendered.
      if (node.firstChild) return richChildren(node, state, opts)
      // True leaf: delegate to synchronous renderer.
      return render(node, state)
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
  const body = await renderRich(syntaxTree(state).topNode, state, options)
  const baseStyle = `<style>${EXPORT_BODY_CSS}</style>`
  const customStyle = options.customCss ? `<style>${options.customCss}</style>` : ""
  return `<!doctype html><html><head><meta charset="utf-8"><title>oh-my-md</title>${baseStyle}${customStyle}${SHIKI_DARK_CSS}</head><body>${body}<script>window.__omdExportReady = true</script></body></html>`
}
