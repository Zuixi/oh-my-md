import type { SyntaxNode } from "@lezer/common"
import type { MarkdownReferenceContext } from "./references"
import { labelRange, referenceTarget, visibleInlineText } from "./inlineText"

/** Everything the host needs to render a `Link`, read from its own node. */
export interface LinkParts {
  readonly href: string
  readonly title: string | null
  readonly text: string
  readonly labelFrom: number
  readonly labelTo: number
  readonly kind: "link" | "autolink"
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i
const WWW = /^www\./i

function autolinkHref(raw: string): string {
  if (WWW.test(raw)) return `https://${raw}`
  if (SCHEME.test(raw)) return raw
  return `mailto:${raw}`
}

function autolinkParts(node: SyntaxNode, source: MarkdownReferenceContext): LinkParts | null {
  const url = node.getChild("URL")
  if (!url) return null
  // Visible text stays the source text; only the destination is normalized.
  const text = source.sliceString(url.from, url.to)
  return {
    href: autolinkHref(text),
    title: null,
    text,
    labelFrom: url.from,
    labelTo: url.to,
    kind: "autolink",
  }
}

/**
 * Link semantics for a Lezer `Link`/`Autolink` node. Reference links resolve
 * through the bounded context; unresolved references and other nodes give
 * `null`.
 */
export function linkParts(node: SyntaxNode, source: MarkdownReferenceContext): LinkParts | null {
  if (node.name === "Autolink") return autolinkParts(node, source)
  if (node.name !== "Link") return null
  const label = labelRange(node, source)
  if (!label) return null
  const target = referenceTarget(node, source, label)
  if (!target) return null
  return {
    href: target.href,
    title: target.title,
    text: visibleInlineText(source, node, label.from, label.to),
    labelFrom: label.from,
    labelTo: label.to,
    kind: "link",
  }
}
