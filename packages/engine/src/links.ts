import { syntaxTree } from "@codemirror/language"
import type { EditorState } from "@codemirror/state"
import type { SyntaxNode } from "@lezer/common"
import { collectOutline } from "./outline"
import { linkParts } from "./semantic/link"
import { snapshotReferenceContext } from "./semantic/references"

export interface LinkTarget {
  readonly href: string
  readonly from: number
  readonly to: number
}

/** Destination of a `Link`/`Autolink` node, resolved by the semantic layer. */
export function linkHref(state: EditorState, node: SyntaxNode): string | null {
  return linkParts(node, snapshotReferenceContext(state))?.href ?? null
}

export function headingSlug(text: string): string {
  return text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-")
}

export function linkAt(state: EditorState, pos: number): LinkTarget | null {
  let node: SyntaxNode | null = syntaxTree(state).resolve(pos, -1)
  while (node) {
    if (node.name === "Link" || node.name === "Autolink") {
      // `linkHref` already returns the normalized (mailto:/https:) destination.
      const href = linkHref(state, node)
      return href ? { href, from: node.from, to: node.to } : null
    }
    node = node.parent
  }
  return null
}

export type ResolvedLink =
  | { readonly kind: "heading"; readonly pos: number }
  | { readonly kind: "external"; readonly href: string }
  | { readonly kind: "markdown"; readonly href: string }
  | { readonly kind: "other"; readonly href: string }

export function classifyLink(href: string): Exclude<ResolvedLink, { kind: "heading" }> {
  if (/^(https?:|mailto:)/i.test(href)) return { kind: "external", href }
  const path = href.split("#")[0] ?? href
  if (/\.(md|markdown)$/i.test(path)) return { kind: "markdown", href }
  return { kind: "other", href }
}

export function headingPositionForAnchor(state: EditorState, href: string): number | null {
  if (!href.startsWith("#")) return null
  const slug = href.slice(1).toLowerCase()
  const heading = collectOutline(state).find(item => headingSlug(item.text) === slug)
  if (heading) return heading.from

  let target: number | null = null
  syntaxTree(state).iterate({
    enter(node) {
      if (target !== null || node.name !== "HTMLTag") return
      const raw = state.doc.sliceString(node.from, node.to)
      const match = raw.match(/^<a\b[^>]*\bid\s*=\s*(['"])([^'"]+)\1[^>]*>$/i)
      if (match?.[2].toLowerCase() === slug) target = node.from
    },
  })
  return target
}
