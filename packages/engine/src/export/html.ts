import { syntaxTree } from "@codemirror/language"
import type { EditorState } from "@codemirror/state"
import type { SyntaxNode } from "@lezer/common"

const SKIP = new Set([
  "HeaderMark", "EmphasisMark", "StrikethroughMark", "HighlightMark",
  "UnderlineMark", "CodeMark", "CodeInfo", "LinkMark", "QuoteMark",
  "ListMark", "TaskMarker", "TableDelimiter",
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

function fencedText(node: SyntaxNode, state: EditorState): string {
  const parts: string[] = []
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "CodeText") parts.push(state.doc.sliceString(child.from, child.to))
  }
  return parts.join("")
}

function cellText(node: SyntaxNode, state: EditorState): string {
  return escapeHtml(state.doc.sliceString(node.from, node.to).replace(/\\\|/g, "|").trim())
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
    case "InlineCode": return `<code>${escapeHtml(state.doc.sliceString(node.from, node.to).replace(/^`+|`+$/g, ""))}</code>`
    case "Link": {
      let href = ""
      let label = ""
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.name === "URL") href = state.doc.sliceString(child.from, child.to)
        else if (!SKIP.has(child.name)) label += render(child, state)
      }
      return `<a href="${escapeHtml(href)}">${label || escapeHtml(href)}</a>`
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
  return `<!doctype html><html><head><meta charset="utf-8"><title>oh-my-md</title></head><body>${body}</body></html>`
}
