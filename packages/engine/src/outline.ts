import { syntaxTree } from "@codemirror/language"
import type { EditorState } from "@codemirror/state"
import type { SyntaxNode } from "@lezer/common"

const HEADING_LEVEL: Record<string, number> = {
  ATXHeading1: 1, ATXHeading2: 2, ATXHeading3: 3,
  ATXHeading4: 4, ATXHeading5: 5, ATXHeading6: 6,
  SetextHeading1: 1, SetextHeading2: 2,
}

export interface OutlineItem {
  level: number
  text: string
  from: number
}

function headingText(node: SyntaxNode, state: EditorState): string {
  const parts: string[] = []
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "HeaderMark") continue
    parts.push(state.doc.sliceString(child.from, child.to))
  }
  const text = parts.join("").trim()
  if (text) return text
  const line = state.doc.lineAt(node.from)
  return line.text.replace(/^#{1,6}\s+/, "").trim()
}

export function collectOutline(state: EditorState): OutlineItem[] {
  const items: OutlineItem[] = []
  syntaxTree(state).iterate({
    enter(node) {
      const level = HEADING_LEVEL[node.name]
      if (!level) return
      items.push({ level, text: headingText(node.node, state), from: node.from })
      return false
    },
  })
  return items
}

/**
 * Index of the outline item whose section contains `pos`, or -1 when `pos`
 * precedes every heading (or the outline is empty). A section spans from its
 * heading's `from` to the next heading's `from`; the last one reaches the
 * document end, so callers may pass any clamped-or-stale position. Returns
 * the last array item starting at or before `pos` — with `collectOutline`'s
 * ordered output that is the deepest enclosing heading (VS Code / Typora
 * outline semantics); array order is not assumed, only scanned.
 */
export function outlineCurrentIndex(items: OutlineItem[], pos: number): number {
  let current = -1
  for (let i = 0; i < items.length; i++) {
    if (items[i].from <= pos) current = i
  }
  return current
}
