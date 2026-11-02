import type { SyntaxNode } from "@lezer/common"
import { decodeHtmlEntity } from "../parse/entities"
import type { MarkdownReferenceContext, MarkdownSlice } from "./references"

/** The visible label interval of a `Link`/`Image` node (brackets excluded). */
export interface LabelRange {
  readonly from: number
  readonly to: number
}

/** A resolved destination, as the reference resolver hands it back. */
export interface LinkTarget {
  readonly href: string
  readonly title: string | null
}

// Syntax marks (`LinkMark`, `EmphasisMark`, `CodeMark`, …) are structure, not
// visible text; Lezer names every one of them `*Mark`.
function isSyntaxMark(name: string): boolean {
  return name.endsWith("Mark")
}

function appendChild(
  source: MarkdownSlice,
  child: SyntaxNode,
  from: number,
  to: number,
  out: string[],
): void {
  const start = Math.max(child.from, from)
  const end = Math.min(child.to, to)
  if (end <= start) return
  switch (child.name) {
    case "Entity": {
      const raw = source.sliceString(start, end)
      out.push(decodeHtmlEntity(raw) ?? raw)
      return
    }
    case "Escape": {
      const raw = source.sliceString(start, end)
      out.push(raw.startsWith("\\") ? raw.slice(1) : raw)
      return
    }
    default:
  }
  if (isSyntaxMark(child.name)) return
  if (child.firstChild) {
    appendRange(source, child, start, end, out)
    return
  }
  out.push(source.sliceString(start, end))
}

function appendRange(
  source: MarkdownSlice,
  node: SyntaxNode,
  from: number,
  to: number,
  out: string[],
): void {
  let pos = from
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.to <= from) continue
    if (child.from >= to) break
    const start = Math.max(child.from, from)
    if (start > pos) out.push(source.sliceString(pos, start))
    appendChild(source, child, from, to, out)
    pos = Math.max(pos, Math.min(child.to, to))
  }
  if (pos < to) out.push(source.sliceString(pos, to))
}

/**
 * Visible text of an inline subtree: syntax marks dropped, entities and
 * backslash escapes decoded, everything else kept. Reads only `[from, to)`.
 */
export function visibleInlineText(
  source: MarkdownSlice,
  node: SyntaxNode,
  from: number,
  to: number,
): string {
  if (to <= from) return ""
  const out: string[] = []
  appendRange(source, node, from, to, out)
  return out.join("")
}

/** Destination text without CommonMark's `<…>` wrapper. */
export function destinationOf(raw: string): string {
  const text = raw.trim()
  return text.length >= 2 && text.startsWith("<") && text.endsWith(">") ? text.slice(1, -1) : text
}

/** Title text without its `"…"` / `'…'` / `(…)` delimiters. */
export function titleOf(node: SyntaxNode | null, source: MarkdownSlice): string | null {
  if (!node) return null
  const raw = source.sliceString(node.from, node.to).trim()
  if (raw.length < 2) return raw || null
  const open = raw[0]
  const close = open === "(" ? ")" : open
  if ((open === '"' || open === "'" || open === "(") && raw.endsWith(close)) return raw.slice(1, -1)
  return raw
}

/**
 * The label interval of a `Link`/`Image`: after its opening bracket mark, up to
 * the last closing `]` mark (a reference `LinkLabel` is a separate node).
 */
export function labelRange(node: SyntaxNode, source: MarkdownSlice): LabelRange | null {
  const open = node.firstChild
  if (!open || open.name !== "LinkMark") return null
  if (!source.sliceString(open.from, open.to).endsWith("[")) return null
  let close: SyntaxNode | null = null
  for (let child = open.nextSibling; child; child = child.nextSibling) {
    if (child.name === "LinkMark" && source.sliceString(child.from, child.to) === "]") close = child
  }
  return close ? { from: open.to, to: close.from } : null
}

/**
 * Destination and title of a `Link`/`Image`: inline `URL`/`LinkTitle` children,
 * or a reference label resolved through the bounded lookup. `null` when a
 * reference does not resolve.
 */
export function referenceTarget(
  node: SyntaxNode,
  source: MarkdownReferenceContext,
  label: LabelRange,
): LinkTarget | null {
  const url = node.getChild("URL")
  if (url) {
    return {
      href: destinationOf(source.sliceString(url.from, url.to)),
      title: titleOf(node.getChild("LinkTitle"), source),
    }
  }
  const reference = node.getChild("LinkLabel")
  const key = reference
    ? source.sliceString(reference.from, reference.to)
    : source.sliceString(label.from, label.to)
  // `[]` is a collapsed reference: it resolves by its own label text.
  const lookup = key === "[]" ? source.sliceString(label.from, label.to) : key
  if (!lookup) return null
  return source.resolveReference(lookup)
}
