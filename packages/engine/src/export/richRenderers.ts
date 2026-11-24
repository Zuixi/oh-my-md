/**
 * Async rich-export renderers for math, code, and Mermaid. The rich document
 * walker and the rich table-cell projection share them so a GFM cell and a
 * top-level block render the same way. Every renderer degrades to escaped
 * source text; none may throw into the export pipeline.
 */

import { createMathHtmlCache } from "./mathHtmlCache"
import { escapeHtml } from "./primitives"

const mathHtmlCache = createMathHtmlCache()

export async function renderMathHtml(tex: string, displayMode: boolean): Promise<string> {
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

let mermaidCounter = 0

export async function renderMermaidHtml(src: string, theme: "light" | "dark"): Promise<string> {
  try {
    const mermaid = (await import("mermaid")).default
    // Mermaid's global config must be re-applied per export; alternating light
    // and dark exports would otherwise reuse the previous palette.
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: theme === "dark" ? "dark" : "default",
    })
    const id = `omd-export-mmd-${++mermaidCounter}`
    const { svg } = await mermaid.render(id, src)
    return svg
  } catch {
    return `<pre>${escapeHtml(src)}</pre>`
  }
}

export async function renderCodeHtml(src: string, lang: string, title = ""): Promise<string> {
  const { resolveCodeLanguage, getHighlighterForExport } = await import("./shikiExport")
  const canonical = resolveCodeLanguage(lang)
  let pre = `<pre><code>${escapeHtml(src)}</code></pre>`
  if (canonical) {
    try {
      const hl = await getHighlighterForExport(canonical)
      pre = hl.codeToHtml(src, {
        lang: canonical,
        themes: { light: "github-light", dark: "github-dark" },
        defaultColor: "light",
      })
    } catch {
      pre = `<pre><code>${escapeHtml(src)}</code></pre>`
    }
  }
  if (!title) return pre
  return `<div class="omd-code-block"><div class="omd-code-title">${escapeHtml(title)}</div>${pre}</div>`
}
