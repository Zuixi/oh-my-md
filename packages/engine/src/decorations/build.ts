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
    enter(node) {
      inlineRules(node, state, out)
      // blockRules 返回 true = 产出了覆盖整个节点的块 widget → 跳过子树，
      // 否则子树内的行内装饰会与块 replace 范围重叠，Decoration.set 直接抛错
      if (blockRules(node, state, out)) return false
    },
  })
  // 兜底：块 widget 范围内的外层装饰（如 blockquote 行装饰盖住表格）同样冲突，丢弃
  const blockWidgets = out.filter(s => s.tag.startsWith("widget:block:"))
  if (!blockWidgets.length) return out
  return out.filter(s =>
    s.tag.startsWith("widget:block:") ||
    !blockWidgets.some(b => s.from >= b.from && s.to <= b.to))
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
}, {
  decorations: v => v.decorations,
  // 光标运动整体跳过 replace 装饰（块 widget + 行内折叠），不会有半个光标进折叠区
  provide: plugin => EditorView.atomicRanges.of(view => view.plugin(plugin)?.decorations ?? Decoration.none),
})
