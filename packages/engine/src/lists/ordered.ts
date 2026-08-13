import type { SyntaxNode } from "@lezer/common"
import { Annotation, Transaction, type EditorState } from "@codemirror/state"
import { syntaxTree } from "@codemirror/language"
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view"

export interface OrderedMarkChange {
  from: number
  to: number
  insert: string
}

function forEachOrderedMark(
  list: SyntaxNode,
  state: EditorState,
  visit: (mark: SyntaxNode, raw: string, expected: string) => void,
) {
  let index = 0
  let start = 1
  for (let child = list.firstChild; child; child = child.nextSibling) {
    if (child.name !== "ListItem") continue
    const mark = child.getChild("ListMark")
    if (!mark) continue
    const raw = state.doc.sliceString(mark.from, mark.to)
    if (!/^\d/.test(raw)) continue
    if (index === 0) {
      const n = parseInt(raw, 10)
      start = Number.isFinite(n) && n >= 0 ? n : 1
    }
    const delim = raw.includes(")") ? ")" : "."
    visit(mark, raw, `${start + index}${delim}`)
    index += 1
  }
}

export function orderedLabel(mark: SyntaxNode, state: EditorState): string | null {
  const list = mark.parent?.parent
  if (list?.name !== "OrderedList") return null
  let label: string | null = null
  forEachOrderedMark(list, state, (itemMark, _raw, expected) => {
    if (itemMark.from === mark.from) label = expected
  })
  return label
}

export function orderedRenumberChanges(state: EditorState): OrderedMarkChange[] {
  const changes: OrderedMarkChange[] = []
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== "OrderedList") return
      forEachOrderedMark(node.node, state, (mark, raw, expected) => {
        if (raw !== expected) changes.push({ from: mark.from, to: mark.to, insert: expected })
      })
    },
  })
  return changes
}

const orderedRenumberAnn = Annotation.define<boolean>()

export const orderedRenumber = ViewPlugin.fromClass(class {
  private isDestroyed = false

  constructor(readonly view: EditorView) {
    queueMicrotask(() => this.apply())
  }

  update(update: ViewUpdate) {
    if (this.isDestroyed) return
    if (update.transactions.some(tr => tr.annotation(orderedRenumberAnn))) return
    const treeChanged = syntaxTree(update.state) !== syntaxTree(update.startState)
    if (!update.docChanged && !treeChanged) return
    queueMicrotask(() => this.apply())
  }

  destroy() {
    this.isDestroyed = true
  }

  private apply() {
    if (this.isDestroyed || this.view.composing) return
    const changes = orderedRenumberChanges(this.view.state)
    if (changes.length === 0) return
    this.view.dispatch({
      changes,
      annotations: [orderedRenumberAnn.of(true), Transaction.addToHistory.of(false)],
    })
  }
})
