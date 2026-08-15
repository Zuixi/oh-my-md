import { syntaxTree } from "@codemirror/language"
import type { EditorState } from "@codemirror/state"
import type { SyntaxNode } from "@lezer/common"

export interface FootnoteTarget {
  readonly id: string
  readonly kind: "reference" | "definition"
  readonly from: number
  readonly to: number
}

function footnoteId(state: EditorState, node: SyntaxNode, kind: FootnoteTarget["kind"]): string {
  if (kind === "definition") {
    const mark = node.getChild("FootnoteMark")
    if (mark) return state.doc.sliceString(mark.from + 2, mark.to - 2)
  }
  return state.doc.sliceString(node.from + 2, node.to - 1)
}

function targetFromNode(state: EditorState, node: SyntaxNode): FootnoteTarget | null {
  if (node.name !== "FootnoteReference" && node.name !== "FootnoteDefinition") return null
  const kind = node.name === "FootnoteReference" ? "reference" : "definition"
  return { id: footnoteId(state, node, kind), kind, from: node.from, to: node.to }
}

export function footnoteAt(state: EditorState, pos: number): FootnoteTarget | null {
  const tree = syntaxTree(state)
  for (const side of [1, -1] as const) {
    let node: SyntaxNode | null = tree.resolveInner(pos, side)
    while (node) {
      const target = targetFromNode(state, node)
      if (target) return target
      node = node.parent
    }
  }
  return null
}

function footnotePosition(
  state: EditorState,
  id: string,
  name: "FootnoteReference" | "FootnoteDefinition",
): number | null {
  const key = id.toLowerCase()
  let found: number | null = null
  syntaxTree(state).iterate({
    enter(node) {
      if (found !== null || node.name !== name) return
      const kind = name === "FootnoteReference" ? "reference" : "definition"
      if (footnoteId(state, node.node, kind).toLowerCase() === key) found = node.from
    },
  })
  return found
}

export function footnoteDefinitionPosition(state: EditorState, id: string): number | null {
  return footnotePosition(state, id, "FootnoteDefinition")
}

export function footnoteReferencePosition(state: EditorState, id: string): number | null {
  return footnotePosition(state, id, "FootnoteReference")
}
