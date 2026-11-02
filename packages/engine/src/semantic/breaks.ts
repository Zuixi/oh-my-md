import type { SyntaxNode } from "@lezer/common"
import type { MarkdownSlice } from "./references"

/** A `Escape` split into its backslash marker and the escaped character. */
export interface EscapeParts {
  readonly markerFrom: number
  readonly markerTo: number
  readonly valueFrom: number
  readonly valueTo: number
}

/** A `HardBreak` split into its line-end marker and the line break itself. */
export interface HardBreakParts {
  readonly markerFrom: number
  readonly markerTo: number
  readonly newlineFrom: number
  readonly newlineTo: number
  readonly kind: "backslash" | "spaces"
}

const BACKSLASH = "\\"
const LF = "\n"
const CRLF = "\r\n"
const SPACES = /^ {2,}$/

/**
 * Escape semantics: the marker is the leading backslash byte, the value is the
 * escaped character. Only a real `Escape` range (backslash + one character)
 * qualifies; everything else is `null`.
 */
export function escapeParts(node: SyntaxNode): EscapeParts | null {
  if (node.name !== "Escape") return null
  if (node.to - node.from < 2) return null
  return {
    markerFrom: node.from,
    markerTo: node.from + 1,
    valueFrom: node.from + 1,
    valueTo: node.to,
  }
}

/**
 * HardBreak semantics: the marker ends before the line break and the newline
 * range covers it, LF or CRLF. `kind` is read from the marker bytes only, so
 * the caller never has to scan the surrounding line.
 */
export function hardBreakParts(node: SyntaxNode, source: MarkdownSlice): HardBreakParts | null {
  if (node.name !== "HardBreak" || node.to <= node.from) return null
  const tail = source.sliceString(Math.max(node.from, node.to - CRLF.length), node.to)
  const newlineFrom = tail.endsWith(CRLF)
    ? node.to - CRLF.length
    : tail.endsWith(LF)
      ? node.to - LF.length
      : -1
  if (newlineFrom <= node.from) return null
  const marker = source.sliceString(node.from, newlineFrom)
  const kind = marker === BACKSLASH ? "backslash" : SPACES.test(marker) ? "spaces" : null
  if (!kind) return null
  return {
    markerFrom: node.from,
    markerTo: newlineFrom,
    newlineFrom,
    newlineTo: node.to,
    kind,
  }
}
