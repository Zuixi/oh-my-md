import { type EditorState, type Range, StateField } from "@codemirror/state"
import { syntaxTree } from "@codemirror/language"
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view"
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

// 原子区间只收 replace 类装饰（折叠的语法标记 + widget）。
// mark/line 装饰若进原子区间，光标移动和删除会被锁死在样式文本外（root cause B）。
function isAtomicTag(tag: string) {
  return tag.startsWith("replace:") || tag.startsWith("widget:")
}

export interface LiveDeco { deco: DecorationSet; atomic: DecorationSet }

// ponytail: 全量重建（StateField 拿不到 viewport，且 viewport 裁剪对块 widget
// 的高度计算有害）；large.md 级文档实测毫秒级，真成瓶颈再做 dirty 区间增量。
export function buildLiveDecorations(state: EditorState): LiveDeco {
  const specs = collectDecorationSpecs(state, 0, state.doc.length)
  return {
    deco: Decoration.set(specs.map(s => s.deco.range(s.from, s.to)), true),
    atomic: Decoration.set(
      specs.filter(s => isAtomicTag(s.tag)).map(s => Decoration.replace({}).range(s.from, s.to)), true),
  }
}

// block: true 的 widget 只能由 StateField 提供——经 ViewPlugin 提供会在 measure
// 阶段抛 "Block decorations may not be specified via plugins"（root cause A，
// 真实 app 中所有含块 widget 的文档全崩，但纯函数测试完全测不到）。
export const livePreviewField = StateField.define<LiveDeco>({
  create: state => buildLiveDecorations(state),
  update: (value, tr) =>
    (tr.docChanged || !tr.startState.selection.eq(tr.newSelection)) ? buildLiveDecorations(tr.state) : value,
  provide: field => [
    EditorView.decorations.from(field, v => v.deco),
    // atomicRanges facet 的值类型是函数，包一层闭包
    EditorView.atomicRanges.compute([field], state => {
      const atomic = state.field(field).atomic
      return () => atomic
    }),
  ],
})
