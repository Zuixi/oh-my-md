import { syntaxTree, syntaxTreeAvailable } from "@codemirror/language"
import type { EditorState } from "@codemirror/state"
import type { SyntaxNode } from "@lezer/common"

export const CODE_NODES = new Set(["InlineCode", "FencedCode", "CodeBlock"])

export const VERBATIM_NODES = new Set([
  ...CODE_NODES,
  "InlineMath",
  "MathBlock",
  "FrontMatter",
])

function inNodes(state: EditorState, pos: number, names: ReadonlySet<string>): boolean {
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent) {
    if (names.has(node.name)) return true
  }
  return false
}

export function inCode(state: EditorState, pos: number): boolean {
  return inNodes(state, pos, CODE_NODES)
}

export function inVerbatim(state: EditorState, pos: number): boolean {
  if (!syntaxTreeAvailable(state, pos + 1)) return true
  return inNodes(state, pos, VERBATIM_NODES)
}
