import type { EditorState, TransactionSpec } from "@codemirror/state"
import type { SyntaxNode } from "@lezer/common"
import { inVerbatim } from "../parse/verbatim"
import {
  containingNode,
  directChildren,
  inlineContainer,
  intersectingNode,
  partialInlineStructure,
  treeCovers,
} from "./semantics"

function urlRange(link: SyntaxNode): { from: number; to: number } | null {
  const url = directChildren(link, "URL")[0]
  if (url) return { from: url.from, to: url.to }
  const marks = directChildren(link, "LinkMark")
  if (marks.length < 4) return null
  return { from: marks[2].to, to: marks[3].from }
}

function labelRange(link: SyntaxNode): { from: number; to: number } | null {
  const marks = directChildren(link, "LinkMark")
  if (marks.length < 2) return null
  return { from: marks[0].to, to: marks[1].from }
}

type LinkLookup =
  | { readonly kind: "none" }
  | { readonly kind: "handled"; readonly spec: TransactionSpec }
  | { readonly kind: "blocked" }

function linkAt(state: EditorState, from: number, to: number): LinkLookup {
  const link = containingNode(state, from, to, name => name === "Link")
  if (!link) return { kind: "none" }
  if (from === to) {
    const url = urlRange(link)
    return url
      ? { kind: "handled", spec: { selection: { anchor: url.from, head: url.to } } }
      : { kind: "blocked" }
  }
  // A non-empty subrange would make the command's meaning ambiguous. Only an
  // exact whole-node selection is the deliberate "unlink" gesture.
  if (from !== link.from || to !== link.to) return { kind: "blocked" }
  const url = urlRange(link)
  const label = labelRange(link)
  if (!url || !label) return { kind: "blocked" }
  const text = state.sliceDoc(label.from, label.to)
  return {
    kind: "handled",
    spec: {
      changes: { from: link.from, to: link.to, insert: text },
      selection: { anchor: link.from, head: link.from + text.length },
    },
  }
}

function isDelimitedAutolink(autolink: SyntaxNode): boolean {
  return directChildren(autolink, "LinkMark").length > 0
}

type AutolinkLookup =
  | { readonly kind: "none" }
  | { readonly kind: "range"; readonly from: number; readonly to: number }
  | { readonly kind: "blocked" }

function autolinkTarget(state: EditorState, from: number, to: number): AutolinkLookup {
  if (from === to) {
    const autolink = containingNode(state, from, to, name => name === "Autolink")
    if (!autolink) return { kind: "none" }
    return isDelimitedAutolink(autolink)
      ? { kind: "blocked" }
      : { kind: "range", from: autolink.from, to: autolink.to }
  }
  const autolink = intersectingNode(state, from, to, name => name === "Autolink")
  if (!autolink) return { kind: "none" }
  if (isDelimitedAutolink(autolink) || from !== autolink.from || to !== autolink.to) {
    return { kind: "blocked" }
  }
  return { kind: "range", from: autolink.from, to: autolink.to }
}

function unsafeInsertionRange(state: EditorState, from: number, to: number): boolean {
  if (!treeCovers(state, from, to)) return true
  const container = inlineContainer(state, from, to)
  if (!container || container.from > from || container.to < to) return true
  if (from === to ? inVerbatim(state, from) : inVerbatim(state, from) || inVerbatim(state, to - 1)) {
    return true
  }
  if (intersectingNode(state, from, to, name => name === "Link"
    || name === "Image"
    || name === "FencedCode"
    || name === "CodeBlock"
    || name === "InlineCode"
    || name === "InlineMath"
    || name === "MathBlock"
    || name === "FrontMatter")) return true
  return partialInlineStructure(state, from, to) !== null
}

export function insertLinkSpec(state: EditorState): TransactionSpec | null {
  const { from, to } = state.selection.main
  if (!treeCovers(state, from, to)) return null
  const existing = linkAt(state, from, to)
  if (existing.kind === "handled") return existing.spec
  if (existing.kind === "blocked") return null

  const autolink = autolinkTarget(state, from, to)
  if (autolink.kind === "blocked") return null
  // Reference links and autolinks have no safely editable destination slot.
  // A collapsed caret inside one must not fall through to wrapping its text.

  const image = containingNode(state, from, to, name => name === "Image")
  if (image) return null
  let textFrom = from
  let textTo = to
  if (autolink.kind === "range") {
    textFrom = autolink.from
    textTo = autolink.to
  } else if (from === to) {
    const word = state.wordAt(from)
    if (word) {
      textFrom = word.from
      textTo = word.to
    }
  }
  if (unsafeInsertionRange(state, textFrom, textTo)) return null
  const text = state.sliceDoc(textFrom, textTo)
  const href = /^(?:https?:\/\/|www\.)/i.test(text) ? text : ""
  const cursor = textFrom + text.length + "[".length + "](".length
  return {
    changes: { from: textFrom, to: textTo, insert: `[${text}](${href})` },
    selection: { anchor: cursor, head: cursor + href.length },
  }
}
