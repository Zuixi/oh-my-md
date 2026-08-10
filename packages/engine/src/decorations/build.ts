import { type EditorState, type Range } from "@codemirror/state"
import { syntaxTree } from "@codemirror/language"
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view"
import { inlineRules } from "./inline"
import { blockRules } from "./blocks"
import type { DecoSpec } from "./types"

export { nearCursor, type DecoSpec } from "./types"

export function collectDecorationSpecs(state: EditorState, from: number, to: number): DecoSpec[] {
  const out: DecoSpec[] = []
  syntaxTree(state).iterate({
    from, to,
    enter(node) { inlineRules(node, state, out); blockRules(node, state, out) },
  })
  return out
}

export function buildLiveDecorations(state: EditorState, from: number, to: number): DecorationSet {
  const ranges: Range<Decoration>[] = collectDecorationSpecs(state, from, to)
    .map(s => s.deco.range(s.from, s.to))
  return Decoration.set(ranges, true)
}

export const livePreviewPlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet
  constructor(view: EditorView) {
    this.decorations = buildLiveDecorations(view.state, view.viewport.from, view.viewport.to)
  }
  update(u: ViewUpdate) {
    if (u.docChanged || u.viewportChanged || u.selectionSet)
      this.decorations = buildLiveDecorations(u.view.state, u.view.viewport.from, u.view.viewport.to)
  }
}, { decorations: v => v.decorations })
