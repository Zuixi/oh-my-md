import type { EditorState } from "@codemirror/state"
import type { SyntaxNode } from "@lezer/common"
import { parseComplexTableBlock } from "../parse/complexTable"
import { resolveEmoji } from "../parse/emoji"
import { decodeHtmlEntity } from "../parse/entities"
import { parseFenceInfo } from "../fenceInfo"
import { linkParts, type LinkParts } from "../semantic/link"
import { isEffectiveHeading, isEffectiveSetextHeading } from "../semantic/heading"
import { imageParts } from "../semantic/image"
import { escapeParts } from "../semantic/breaks"
import {
  footnoteIdFromDef,
  footnoteIdFromRef,
  footnoteSlug,
  headingPlainText,
  prepareExportDocument,
  taskCheckboxHtml,
  type ExportContext,
} from "./exportDoc"
import { loadKatexExportCss } from "./katexAssets"
import { EXPORT_BODY_CSS } from "./styles"
import { anchorHtml, escapeHtml, imageHtml, richImageSrc, type RichImageOptions } from "./primitives"
import { mathTexOf } from "../semantic/math"
import { renderCodeHtml, renderMathHtml, renderMermaidHtml } from "./richRenderers"
import { richComplexTableHtml, richTableHtml, syncComplexTableHtml, syncTableHtml } from "./tableHtml"
import { sanitizeRawAnchorTag } from "./sanitize"
import { EXPORT_NATIVE_CSP_META, EXPORT_READY_SCRIPT } from "./readyScript"
import {
  DEFAULT_PRINT_SETUP,
  isExplicitPageBreakHtml,
  PAGE_BREAK_HTML,
  renderPrintCss,
  type PrintSetup,
} from "./printSetup"

const SKIP = new Set([
  "HeaderMark", "EmphasisMark", "StrikethroughMark", "HighlightMark",
  "UnderlineMark", "KbdMark", "CodeMark", "CodeInfo", "LinkMark", "QuoteMark",
  "ListMark", "TableDelimiter", "RiseMark", "FootnoteMark",
])

function children(
  node: SyntaxNode,
  state: EditorState,
  ctx: ExportContext,
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

function inline(node: SyntaxNode, state: EditorState, ctx: ExportContext): string {
  if (!node.firstChild) return escapeHtml(state.doc.sliceString(node.from, node.to))
  return children(node, state, ctx)
}

function headingTag(level: number, node: SyntaxNode, state: EditorState, ctx: ExportContext, inner: string): string {
  const id = ctx.nextHeadingId(headingPlainText(node, state))
  const attr = id ? ` id="${escapeHtml(id)}"` : ""
  return `<h${level}${attr}>${inner.trim()}</h${level}>`
}

function fencedText(node: SyntaxNode, state: EditorState): string {
  const parts: string[] = []
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "CodeText") parts.push(state.doc.sliceString(child.from, child.to))
  }
  return parts.join("")
}

/** `3. a` exports as `<ol start="3">`; a list starting at 1 keeps the bare `<ol>`. */
function orderedListOpen(node: SyntaxNode, state: EditorState): string {
  const mark = node.getChild("ListItem")?.getChild("ListMark")
  const start = mark ? Number.parseInt(state.doc.sliceString(mark.from, mark.to), 10) : 1
  return Number.isFinite(start) && start !== 1 ? `ol start="${start}"` : "ol"
}

function labelHtml(
  node: SyntaxNode,
  state: EditorState,
  ctx: ExportContext,
  parts: LinkParts,
): string {
  if (parts.kind === "autolink") return escapeHtml(parts.text)
  return children(node, state, ctx, parts.labelFrom, parts.labelTo)
}

function skippedMarkHtml(node: SyntaxNode, state: EditorState): string | null {
  if (!SKIP.has(node.name)) return null
  if (node.name === "HeaderMark" && node.parent && !isEffectiveHeading(node.parent)) {
    return escapeHtml(state.doc.sliceString(node.from, node.to))
  }
  return ""
}

function render(node: SyntaxNode, state: EditorState, ctx: ExportContext): string {
  const skipped = skippedMarkHtml(node, state)
  if (skipped !== null) return skipped
  switch (node.name) {
    case "Document": return children(node, state, ctx)
    case "FrontMatter": return ""
    case "ATXHeading1": return headingTag(1, node, state, ctx, inline(node, state, ctx))
    case "SetextHeading1":
      return isEffectiveSetextHeading(node)
        ? headingTag(1, node, state, ctx, inline(node, state, ctx))
        : `<p>${inline(node, state, ctx)}</p>`
    case "ATXHeading2": return headingTag(2, node, state, ctx, inline(node, state, ctx))
    case "SetextHeading2":
      return isEffectiveSetextHeading(node)
        ? headingTag(2, node, state, ctx, inline(node, state, ctx))
        : `<p>${inline(node, state, ctx)}</p>`
    case "ATXHeading3": return headingTag(3, node, state, ctx, inline(node, state, ctx))
    case "ATXHeading4": return headingTag(4, node, state, ctx, inline(node, state, ctx))
    case "ATXHeading5": return headingTag(5, node, state, ctx, inline(node, state, ctx))
    case "ATXHeading6": return headingTag(6, node, state, ctx, inline(node, state, ctx))
    case "Paragraph": return `<p>${inline(node, state, ctx)}</p>`
    case "Emphasis": return `<em>${inline(node, state, ctx)}</em>`
    case "StrongEmphasis": return `<strong>${inline(node, state, ctx)}</strong>`
    case "Strikethrough": return `<del>${inline(node, state, ctx)}</del>`
    case "Highlight": return `<mark>${inline(node, state, ctx)}</mark>`
    case "Underline": return `<u>${inline(node, state, ctx)}</u>`
    case "Kbd": return `<kbd>${inline(node, state, ctx)}</kbd>`
    case "Subscript": return `<sub>${inline(node, state, ctx)}</sub>`
    case "Superscript": return `<sup>${inline(node, state, ctx)}</sup>`
    case "TaskMarker": return taskCheckboxHtml(state.doc.sliceString(node.from, node.to))
    case "Emoji": {
      const raw = state.doc.sliceString(node.from, node.to)
      return escapeHtml(resolveEmoji(raw.slice(1, -1)) ?? raw)
    }
    case "FootnoteReference": {
      const id = footnoteIdFromRef(state.doc.sliceString(node.from, node.to))
      if (!id) return escapeHtml(state.doc.sliceString(node.from, node.to))
      const slug = footnoteSlug(id)
      return `<sup class="omd-fn-ref"><a href="#fn-${slug}" id="fnref-${slug}">${escapeHtml(id)}</a></sup>`
    }
    case "FootnoteDefinition": {
      const id = footnoteIdFromDef(node, state)
      if (!id) return escapeHtml(state.doc.sliceString(node.from, node.to))
      const slug = footnoteSlug(id)
      return `<section class="omd-fn-def" id="fn-${slug}"><span class="omd-fn-label">${escapeHtml(id)}.</span> ${children(node, state, ctx).trim()}</section>`
    }
    case "InlineCode": return `<code>${escapeHtml(state.doc.sliceString(node.from, node.to).replace(/^`+|`+$/g, ""))}</code>`
    case "Link":
    case "Autolink": {
      const parts = linkParts(node, ctx.refs)
      if (!parts) return escapeHtml(state.doc.sliceString(node.from, node.to))
      return anchorHtml(parts.href, parts.title, labelHtml(node, state, ctx, parts))
    }
    case "HTMLTag": {
      const raw = state.doc.sliceString(node.from, node.to)
      const anchor = sanitizeRawAnchorTag(raw)
      if (anchor !== null) return anchor
      if (isExplicitPageBreakHtml(raw)) return PAGE_BREAK_HTML
      return escapeHtml(raw)
    }
    case "Image": {
      const parts = imageParts(node, ctx.refs)
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
      return `<${node.name === "OrderedList" ? orderedListOpen(node, state) : "ul"}>${children(node, state, ctx)}</${node.name === "OrderedList" ? "ol" : "ul"}>`
    case "ListItem": return `<li>${children(node, state, ctx)}</li>`
    case "Blockquote": return `<blockquote>${children(node, state, ctx)}</blockquote>`
    case "HorizontalRule": return "<hr>"
    case "Table":
      return syncTableHtml(node, state, ctx) ?? escapeHtml(state.doc.sliceString(node.from, node.to))
    case "HTMLBlock": {
      const raw = state.doc.sliceString(node.from, node.to)
      if (isExplicitPageBreakHtml(raw)) return PAGE_BREAK_HTML
      const model = parseComplexTableBlock(raw)
      if (model) return syncComplexTableHtml(model)
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

function printStyleTag(setup?: PrintSetup): string {
  return `<style>${renderPrintCss(setup ?? DEFAULT_PRINT_SETUP)}</style>`
}

/**
 * Source gaps before the first block are text nodes. They make that heading
 * `:not(:first-child)`, so an opt-in heading break inserts a blank first page.
 * Whitespace inside the first block stays put.
 */
function exportDocumentBody(body: string): string {
  return body.trimStart()
}

function exportTitleHtml(setup?: PrintSetup): string {
  const title = setup?.headerTitle?.trim()
  return escapeHtml(title || "oh-my-md")
}

const EXPORT_CSP_META = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data: https: http:; style-src 'unsafe-inline'; script-src 'none'; font-src data:; base-uri 'none'; form-action 'none'">`

export function exportHtml(state: EditorState, print?: PrintSetup): string {
  const ctx = prepareExportDocument(state)
  const body = exportDocumentBody(render(ctx.topNode, state, ctx))
  return `<!doctype html><html><head><meta charset="utf-8">${EXPORT_CSP_META}<title>${exportTitleHtml(print)}</title><style>${EXPORT_BODY_CSS}</style>${printStyleTag(print)}</head><body>${body}</body></html>`
}

// ---------------------------------------------------------------------------
// Rich async export: KaTeX math, Shiki code, Mermaid SVG
// ---------------------------------------------------------------------------

export interface ExportRichHtmlOptions extends RichImageOptions {
  /** Page setup embedded after base typography and before custom CSS. Defaults to the shared contract. */
  print?: PrintSetup
  /** Explicit export theme; drives the data-omd-theme/data-theme root attributes. */
  theme?: "light" | "dark"
  /** Use the full render width instead of the 720px reading column (native screenshots). */
  fullWidth?: boolean
  /** User custom CSS, appended after the base typography so it wins. */
  customCss?: string
  /**
   * Emit the native readiness handshake script. Defaults to true so the native
   * PDF/PNG exporters can await it; a standalone `.html` file passes false and
   * gets the no-script CSP meta instead.
   */
  includeReadyScript?: boolean
}

async function richChildren(
  node: SyntaxNode,
  state: EditorState,
  opts: ExportRichHtmlOptions,
  ctx: ExportContext,
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
  ctx: ExportContext,
  parts: LinkParts,
): Promise<string> {
  if (parts.kind === "autolink") return escapeHtml(parts.text)
  return richChildren(node, state, opts, ctx, parts.labelFrom, parts.labelTo)
}

function renderRich(
  node: SyntaxNode,
  state: EditorState,
  opts: ExportRichHtmlOptions,
  ctx: ExportContext,
): string | Promise<string> {
  const skipped = skippedMarkHtml(node, state)
  if (skipped !== null) return skipped
  switch (node.name) {
    case "FrontMatter": return ""
    case "InlineMath": {
      const tex = state.doc.sliceString(node.from, node.to).replace(/^\$|\$$/g, "")
      return renderMathHtml(tex.trim(), false)
    }
    case "MathBlock": {
      const tex = mathTexOf(state.doc.sliceString(node.from, node.to))
      return renderMathHtml(tex, true)
    }
    case "FencedCode":
    case "CodeBlock": {
      const codeText = fencedText(node, state) || state.doc.sliceString(node.from, node.to)
      const infoNode = node.getChild("CodeInfo")
      const { lang, title } = parseFenceInfo(infoNode ? state.doc.sliceString(infoNode.from, infoNode.to) : "")
      if (lang.toLowerCase() === "mermaid") return renderMermaidHtml(codeText, opts.theme ?? "light")
      return renderCodeHtml(codeText, lang, title)
    }
    case "Image": {
      const parts = imageParts(node, ctx.refs)
      if (!parts) return escapeHtml(state.doc.sliceString(node.from, node.to))
      return richImageSrc(parts.src, opts).then(src => imageHtml(src, parts.alt, parts.title))
    }
    case "Link":
    case "Autolink": {
      const parts = linkParts(node, ctx.refs)
      if (!parts) return escapeHtml(state.doc.sliceString(node.from, node.to))
      return richLabelHtml(node, state, opts, ctx, parts).then(label =>
        anchorHtml(parts.href, parts.title, label))
    }
    case "Table":
      return richTableHtml(node, state, ctx, opts).then(
        table => table ?? escapeHtml(state.doc.sliceString(node.from, node.to)))
    case "HTMLBlock": {
      const raw = state.doc.sliceString(node.from, node.to)
      if (isExplicitPageBreakHtml(raw)) return PAGE_BREAK_HTML
      const model = parseComplexTableBlock(raw)
      if (model) return richComplexTableHtml(model, opts)
      return escapeHtml(raw)
    }
    case "FootnoteDefinition": {
      const id = footnoteIdFromDef(node, state)
      if (!id) return escapeHtml(state.doc.sliceString(node.from, node.to))
      const slug = footnoteSlug(id)
      return richChildren(node, state, opts, ctx).then(
        s => `<section class="omd-fn-def" id="fn-${slug}"><span class="omd-fn-label">${escapeHtml(id)}.</span> ${s.trim()}</section>`,
      )
    }
    case "ATXHeading1": return richChildren(node, state, opts, ctx).then(s => headingTag(1, node, state, ctx, s))
    case "SetextHeading1":
      return richChildren(node, state, opts, ctx).then(s =>
        isEffectiveSetextHeading(node) ? headingTag(1, node, state, ctx, s) : `<p>${s}</p>`)
    case "ATXHeading2": return richChildren(node, state, opts, ctx).then(s => headingTag(2, node, state, ctx, s))
    case "SetextHeading2":
      return richChildren(node, state, opts, ctx).then(s =>
        isEffectiveSetextHeading(node) ? headingTag(2, node, state, ctx, s) : `<p>${s}</p>`)
    case "ATXHeading3": return richChildren(node, state, opts, ctx).then(s => headingTag(3, node, state, ctx, s))
    case "ATXHeading4": return richChildren(node, state, opts, ctx).then(s => headingTag(4, node, state, ctx, s))
    case "ATXHeading5": return richChildren(node, state, opts, ctx).then(s => headingTag(5, node, state, ctx, s))
    case "ATXHeading6": return richChildren(node, state, opts, ctx).then(s => headingTag(6, node, state, ctx, s))
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
    case "OrderedList": return richChildren(node, state, opts, ctx).then(s => `<${orderedListOpen(node, state)}>${s}</ol>`)
    case "ListItem": return richChildren(node, state, opts, ctx).then(s => `<li>${s}</li>`)
    case "Blockquote": return richChildren(node, state, opts, ctx).then(s => `<blockquote>${s}</blockquote>`)
    default:
      // Any unrecognised container: walk children richly so nested math/code is rendered.
      if (node.firstChild) return richChildren(node, state, opts, ctx)
      // True leaf: delegate to synchronous renderer.
      return render(node, state, ctx)
  }
}

// Dark-scheme mapping for dual-theme shiki output; scoped to the export
// document's explicit theme attribute (mirrors the app stylesheet).
const SHIKI_DARK_CSS = `<style>
html[data-omd-theme="dark"] .shiki,
html[data-omd-theme="dark"] .shiki span {
  color: var(--shiki-dark) !important;
  background-color: var(--shiki-dark-bg) !important;
  font-style: var(--shiki-dark-font-style) !important;
  font-weight: var(--shiki-dark-font-weight) !important;
  text-decoration: var(--shiki-dark-text-decoration) !important;
}
</style>`

/** Prevent user CSS from closing the style element and injecting markup. */
function escapeStyleText(css: string): string {
  return css.replace(/<\/style/gi, "<\\/style")
}

export async function exportRichHtml(
  state: EditorState,
  options: ExportRichHtmlOptions = {},
): Promise<string> {
  const theme = options.theme ?? "light"
  // Standalone `.html` files must not carry the native handshake script: it is
  // dead weight there, and the document gets the no-script CSP instead.
  const includeReadyScript = options.includeReadyScript ?? true
  // Both shapes carry a policy: the standalone file forbids every script, and
  // the native inline document allows exactly the readiness handshake by hash.
  const csp = includeReadyScript ? EXPORT_NATIVE_CSP_META : EXPORT_CSP_META
  const readyScript = includeReadyScript ? EXPORT_READY_SCRIPT : ""
  const ctx = prepareExportDocument(state)
  const [renderedBody, katexCss] = await Promise.all([
    renderRich(ctx.topNode, state, options, ctx),
    loadKatexExportCss(),
  ])
  const body = exportDocumentBody(renderedBody)
  // KaTeX first so both the base typography and user CSS can override it.
  // `@media print` adds zero CSS specificity, so `printStyle` must follow
  // `baseStyle`/`widthStyle` to reset body padding/max-width while preceding
  // `customStyle` so user `@page` and print rules win.
  const katexStyle = katexCss ? `<style>${katexCss}</style>` : ""
  const baseStyle = `<style>${EXPORT_BODY_CSS}</style>`
  const widthStyle = options.fullWidth
    ? "<style>html,body{max-width:none;overflow-x:hidden}</style>"
    : ""
  const printStyle = printStyleTag(options.print)
  const customStyle = options.customCss
    ? `<style>${escapeStyleText(options.customCss)}</style>`
    : ""
  return `<!doctype html><html data-omd-theme="${theme}" data-theme="${theme}"><head><meta charset="utf-8">${csp}<title>${exportTitleHtml(options.print)}</title>${katexStyle}${baseStyle}${widthStyle}${printStyle}${customStyle}${SHIKI_DARK_CSS}</head><body>${body}${readyScript}</body></html>`
}
