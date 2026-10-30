import type { SyntaxNode } from "@lezer/common"
import type { MarkdownReferenceContext } from "./references"
import { labelRange, referenceTarget, visibleInlineText } from "./inlineText"

/** Everything the host needs to render an `Image`, read from its own node. */
export interface ImageParts {
  readonly alt: string
  readonly src: string
  readonly title: string | null
}

/**
 * Image semantics for a Lezer `Image` node. Alt is visible label text
 * (formatted, entity-decoded); reference destinations resolve through the
 * bounded context, and unresolved references give `null`.
 */
export function imageParts(node: SyntaxNode, source: MarkdownReferenceContext): ImageParts | null {
  if (node.name !== "Image") return null
  const label = labelRange(node, source)
  if (!label) return null
  const target = referenceTarget(node, source, label)
  if (!target) return null
  return {
    alt: visibleInlineText(source, node, label.from, label.to),
    src: target.href,
    title: target.title,
  }
}
