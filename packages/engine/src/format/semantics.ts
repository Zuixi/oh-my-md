import { syntaxTree, syntaxTreeAvailable } from "@codemirror/language"
import type { ChangeSpec, EditorState, Line } from "@codemirror/state"
import type { SyntaxNode } from "@lezer/common"
import { VERBATIM_NODES } from "../parse/verbatim"
import {
  blockPrefixOf,
  lineContentStart,
  type BlockPrefix,
} from "./blockPrefix"

// Tree-reading primitives shared by the formatting commands. Commands decide
// what to do; this module only answers structural questions about the current
// source. Every helper is pure and never forces parsing.

export type NodeNameTest = (name: string) => boolean

/** Inline nodes whose delimiters make a partial selection unsafe to wrap. */
const INLINE_STRUCTURE = new Set([
  "Emphasis",
  "StrongEmphasis",
  "Strikethrough",
  "InlineCode",
  "InlineMath",
  "Highlight",
  "Underline",
  "Kbd",
  "Subscript",
  "Superscript",
  "Link",
  "Image",
  "Autolink",
  "FootnoteReference",
])

/** Block constructs whose source shape must not be rewritten by heading/list. */
const BLOCK_MUTATION_HOSTS = new Set([
  "FencedCode",
  "CodeBlock",
  "MathBlock",
  "FrontMatter",
  "Table",
  "CommentBlock",
  "HTMLBlock",
  "LinkReference",
  "FootnoteDefinition",
])

const ATX_HEADING = /^ATXHeading([1-6])$/
const SETEXT_HEADING = /^SetextHeading[12]$/

function isInlineContainer(name: string): boolean {
  return name === "Paragraph"
    || name === "TableCell"
    || ATX_HEADING.test(name)
    || SETEXT_HEADING.test(name)
}

/** The tree must cover the whole touched range before a command may rewrite it. */
export function treeCovers(state: EditorState, from: number, to: number): boolean {
  const end = Math.min(Math.max(from, to), state.doc.length)
  return syntaxTreeAvailable(state, end)
}

/**
 * Innermost node of a matching name that contains the selection. A collapsed
 * caret is resolved with `-1`, so it belongs to the node whose last character
 * precedes it; boundaries are excluded for collapsed carets.
 */
export function containingNode(
  state: EditorState,
  from: number,
  to: number,
  test: NodeNameTest,
): SyntaxNode | null {
  const side = from === to ? -1 : 1
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(from, side)
  while (node && !(node.from <= from && to <= node.to)) node = node.parent
  while (node) {
    if (test(node.name) && !(from === to && (from <= node.from || to >= node.to))) {
      return node
    }
    node = node.parent
  }
  return null
}

/** First matching node that overlaps the range (including exact containment). */
export function intersectingNode(
  state: EditorState,
  from: number,
  to: number,
  test: NodeNameTest,
): SyntaxNode | null {
  if (from === to) return null
  let found: SyntaxNode | null = null
  syntaxTree(state).iterate({
    from,
    to,
    enter(node) {
      if (node.from >= to || node.to <= from || !test(node.name)) return
      found = node.node
      return false
    },
  })
  return found
}

/**
 * A selection only partly covering a syntax node cannot be wrapped without
 * either splitting that node or nesting a second copy of its delimiters.
 * Fully containing the node (or sitting fully inside it) is structurally safe.
 */
export function partialInlineStructure(
  state: EditorState,
  from: number,
  to: number,
): SyntaxNode | null {
  if (from === to) return null
  let found: SyntaxNode | null = null
  syntaxTree(state).iterate({
    from,
    to,
    enter(node) {
      if (node.from >= to || node.to <= from || !INLINE_STRUCTURE.has(node.name)) return
      if (node.from <= from && to <= node.to) return
      if (from <= node.from && node.to <= to) return
      found = node.node
      return false
    },
  })
  return found
}

/** True when any verbatim node intersects a non-empty selection. */
export function intersectsVerbatim(state: EditorState, from: number, to: number): boolean {
  return intersectingNode(state, from, to, name => VERBATIM_NODES.has(name)) !== null
}

/** Smallest paragraph/heading/cell that contains the whole selection. */
export function inlineContainer(
  state: EditorState,
  from: number,
  to: number,
): SyntaxNode | null {
  const side = from === to ? -1 : 1
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(from, side)
  while (node && !(node.from <= from && to <= node.to)) node = node.parent
  for (; node; node = node.parent) {
    if (isInlineContainer(node.name)) return node
  }
  return null
}

export function directChildren(node: SyntaxNode, name: string): SyntaxNode[] {
  const result: SyntaxNode[] = []
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === name) result.push(child)
  }
  return result
}

export function hasAncestor(node: SyntaxNode, names: ReadonlySet<string>): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (names.has(parent.name)) return true
  }
  return false
}

/** Maps a selection through one command's changes using CodeMirror's own mapping. */
export function mapSelection(
  state: EditorState,
  changes: readonly ChangeSpec[],
  from: number,
  to: number,
): { anchor: number; head?: number } {
  const set = state.changes(changes)
  const anchor = set.mapPos(from, 1)
  return from === to ? { anchor } : { anchor, head: set.mapPos(to, -1) }
}

export interface LineSyntax {
  readonly prefix: BlockPrefix | null
  /** Opening `#` run of an ATX heading that owns this line. */
  readonly heading: SyntaxNode | null
  readonly headingLevel: number | null
  readonly setext: boolean
  /** Line is inside a construct whose source shape heading/list must not touch. */
  readonly blocked: boolean
  /** Position after the block prefix, or after leading indentation on plain lines. */
  readonly contentStart: number
}

/**
 * Reads one line's block context from the available tree. Returns null when the
 * tree has not reached the line; callers treat that as "not handled" and leave
 * the document alone.
 */
export function lineSyntax(state: EditorState, line: Line): LineSyntax | null {
  if (!treeCovers(state, line.from, line.to)) return null
  let heading: SyntaxNode | null = null
  let headingLevel: number | null = null
  let setext = false
  let blocked = false
  const tree = syntaxTree(state)
  for (const pos of [line.from, Math.max(line.from, line.to - 1)]) {
    for (let node: SyntaxNode | null = tree.resolveInner(pos, -1); node; node = node.parent) {
      if (BLOCK_MUTATION_HOSTS.has(node.name)) blocked = true
    }
  }
  tree.iterate({
    from: line.from,
    to: line.to,
    enter(node) {
      const atx = ATX_HEADING.exec(node.name)
      if (atx && node.from >= line.from) {
        heading = node.node
        headingLevel = Number(atx[1])
      }
      if (SETEXT_HEADING.test(node.name)) setext = true
    },
  })
  const prefix = blockPrefixOf(state, line)
  const contentStart = prefix && prefix.marks.length > 0
    ? lineContentStart(state, line)
    : line.from + /^[ \t]*/.exec(line.text)![0].length
  return { prefix, heading, headingLevel, setext, blocked, contentStart }
}
