import type { SyntaxNode } from "@lezer/common"

/**
 * Minimum underline length (`--` or `==`) required before a `SetextHeading`
 * projects as an H1/H2 across live preview, outline, format commands, and
 * export. CommonMark allows a single `-` or `=`, which turns the preceding
 * paragraph into an H2/H1 on the very first keystroke of typing `- item` or
 * `---`. We cannot replace `DefaultLeafBlocks.SetextHeading` in `@lezer/markdown`
 * directly because its `isHorizontalRule` checks that parser reference by
 * identity; gating Setext semantics here preserves `Title\n---` while keeping
 * transient single-character `-` / `=` lines as plain paragraph text.
 */
export const MIN_SETEXT_UNDERLINE_CHARS = 2

export function isEffectiveSetextHeading(node: SyntaxNode): boolean {
  if (node.name !== "SetextHeading1" && node.name !== "SetextHeading2") return false
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "HeaderMark") {
      return child.to - child.from >= MIN_SETEXT_UNDERLINE_CHARS
    }
  }
  return false
}

export function isEffectiveHeading(node: SyntaxNode): boolean {
  if (node.name === "SetextHeading1" || node.name === "SetextHeading2") {
    return isEffectiveSetextHeading(node)
  }
  return /^ATXHeading[1-6]$/.test(node.name)
}
