import { type ChangeDesc, type EditorState, StateField, type Transaction } from "@codemirror/state"
import { syntaxTree, syntaxTreeAvailable } from "@codemirror/language"
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
  const scoped = out.filter(s => s.from <= to && s.to >= from)
  const blockWidgets = scoped.filter(s => s.tag.startsWith("widget:block:"))
  if (!blockWidgets.length) return scoped
  return scoped.filter(s =>
    s.tag.startsWith("widget:block:") ||
    !blockWidgets.some(b => s.from >= b.from && s.to <= b.to))
}

// 原子区间只收内联 replace 类装饰（折叠的语法标记 + 内联 widget，如 checkbox）。
// mark/line 装饰若进原子区间，光标移动和删除会被锁死在样式文本外（root cause B）。
// widget:block:* 块 widget 不能进原子区间：
//   - 块 widget 跨越多行；加入原子区间后，方向键（↑/↓）会直接跳过整个块（bug: 第99行按↑跳到第1行）。
//   - paste 时 CM 会把粘贴位置扩展到原子区间边界，导致连带选中下一行（bug: 右键粘贴包含下一行）。
// block: true 的 Decoration.replace 已由 CM 自行处理块周围的光标定位，无需再加原子约束。
function isAtomicTag(tag: string) {
  return (tag.startsWith("replace:") || tag.startsWith("widget:")) &&
    !tag.startsWith("widget:block:")
}

interface RebuildRange { from: number; to: number }

export interface LiveDeco {
  deco: DecorationSet
  atomic: DecorationSet
  specs: DecoSpec[]
  treeLength: number
}

function decorationSets(specs: DecoSpec[]) {
  return {
    deco: Decoration.set(specs.map(s => s.deco.range(s.from, s.to)), true),
    atomic: Decoration.set(
      specs.filter(s => isAtomicTag(s.tag)).map(s => Decoration.replace({}).range(s.from, s.to)),
      true,
    ),
  }
}

export function buildLiveDecorations(state: EditorState): LiveDeco {
  const specs = collectDecorationSpecs(state, 0, state.doc.length)
  const sets = decorationSets(specs)
  return {
    ...sets,
    specs,
    treeLength: syntaxTree(state).length,
  }
}

function mergeRanges(ranges: RebuildRange[]): RebuildRange[] {
  const sorted = ranges
    .filter(range => range.from <= range.to)
    .sort((a, b) => a.from - b.from || a.to - b.to)
  const merged: RebuildRange[] = []
  for (const range of sorted) {
    const previous = merged[merged.length - 1]
    if (previous && range.from <= previous.to + 1) previous.to = Math.max(previous.to, range.to)
    else merged.push({ ...range })
  }
  return merged
}

const SELECTION_BLOCKS = new Set(["FencedCode", "MathBlock", "Table", "HorizontalRule"])

function expandRange(
  state: EditorState,
  from: number,
  to: number,
  blocks?: Set<string>,
): RebuildRange {
  const length = state.doc.length
  const start = Math.max(0, Math.min(from, length))
  const end = Math.max(start, Math.min(to, length))
  const startLine = state.doc.lineAt(start)
  const endLine = state.doc.lineAt(end)
  let safeFrom = startLine.from
  let safeTo = Math.min(length, endLine.to + 1)
  if (!syntaxTreeAvailable(state, safeTo)) return { from: safeFrom, to: safeTo }
  const tree = syntaxTree(state)

  for (const pos of [start, end]) {
    let node = tree.resolve(pos, pos === length ? -1 : 1)
    if (blocks) {
      for (; node; node = node.parent!) {
        if (blocks.has(node.name)) {
          safeFrom = Math.min(safeFrom, node.from)
          safeTo = Math.max(safeTo, node.to)
          break
        }
        if (!node.parent) break
      }
    } else {
      while (node.parent?.parent) node = node.parent
      safeFrom = Math.min(safeFrom, node.from)
      safeTo = Math.max(safeTo, node.to)
    }
  }
  return { from: safeFrom, to: safeTo }
}

// expandRange uses endLine.to + 1 as an exclusive end (the next line's from).
// A closed overlap would drop point decorations sitting exactly at that boundary
// (the next line's omd-blockquote-N / QuoteMark) without the inner Blockquote
// being visited again, so the following quote line loses its bar.
function intersects(from: number, to: number, range: RebuildRange) {
  if (range.from === range.to) return from <= range.to && to >= range.from
  return from < range.to && to >= range.from
}

function mapSpec(spec: DecoSpec, changes: ChangeDesc): DecoSpec | null {
  if (spec.from === spec.to) {
    const pos = changes.mapPos(spec.from, 1)
    return { ...spec, from: pos, to: pos }
  }
  const from = changes.mapPos(spec.from, 1)
  const to = changes.mapPos(spec.to, -1)
  return from <= to ? { ...spec, from, to } : null
}

function rebuildRanges(value: LiveDeco, tr: Transaction) {
  const ranges: RebuildRange[] = []

  if (tr.docChanged) {
    tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
      const oldRange = expandRange(tr.startState, fromA, toA)
      ranges.push(expandRange(
        tr.state,
        tr.changes.mapPos(oldRange.from, -1),
        tr.changes.mapPos(oldRange.to, 1),
      ))
      ranges.push(expandRange(tr.state, fromB, toB))
    })
  }

  if (!tr.startState.selection.eq(tr.newSelection)) {
    const oldSelection = tr.startState.selection.main
    const newSelection = tr.newSelection.main
    const oldRange = expandRange(tr.startState, oldSelection.from, oldSelection.to, SELECTION_BLOCKS)
    ranges.push({
      from: tr.changes.mapPos(oldRange.from, -1),
      to: tr.changes.mapPos(oldRange.to, 1),
    })
    ranges.push(expandRange(tr.state, newSelection.from, newSelection.to, SELECTION_BLOCKS))
  }

  const treeLength = syntaxTree(tr.state).length
  const selectionChanged = !tr.startState.selection.eq(tr.newSelection)
  if (!tr.docChanged && !selectionChanged && treeLength > value.treeLength) {
    ranges.push(expandRange(tr.state, value.treeLength, treeLength))
  }
  return mergeRanges(ranges)
}

function updateLiveDecorations(value: LiveDeco, tr: Transaction): LiveDeco {
  if (tr.reconfigured) return buildLiveDecorations(tr.state)
  const ranges = rebuildRanges(value, tr)
  const selectionChanged = !tr.startState.selection.eq(tr.newSelection)
  const treeLength = !tr.docChanged && selectionChanged
    ? value.treeLength
    : syntaxTree(tr.state).length
  if (!ranges.length) {
    return treeLength === value.treeLength ? value : { ...value, treeLength }
  }

  // 先让 CodeMirror 用 ChangeDesc 精确映射未受影响的装饰，再替换语法安全脏区。
  const mappedDeco = value.deco.map(tr.changes)
  const mappedAtomic = value.atomic.map(tr.changes)
  const mappedSpecs = value.specs
    .map(spec => mapSpec(spec, tr.changes))
    .filter((spec): spec is DecoSpec => spec !== null)
  const rebuilt = ranges.flatMap(range =>
    collectDecorationSpecs(tr.state, range.from, range.to))
  // 新块 widget 可能从脏区内开始、却吞并后续旧块；移除范围必须覆盖它的完整 replace 区间。
  const removalRanges = mergeRanges([
    ...ranges,
    ...rebuilt
      .filter(spec => spec.tag.startsWith("widget:block:"))
      .map(spec => ({ from: spec.from, to: spec.to })),
  ])
  const retained = mappedSpecs.filter(spec =>
    !removalRanges.some(range => intersects(spec.from, spec.to, range)))
  const seen = new Set(retained.map(spec => `${spec.tag}:${spec.from}:${spec.to}`))
  const additions = rebuilt.filter(spec => {
    const key = `${spec.tag}:${spec.from}:${spec.to}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const keep = (from: number, to: number) =>
    !removalRanges.some(range => intersects(from, to, range))

  return {
    deco: mappedDeco.update({
      filter: keep,
      add: additions.map(spec => spec.deco.range(spec.from, spec.to)),
      sort: true,
    }),
    atomic: mappedAtomic.update({
      filter: keep,
      add: additions
        .filter(spec => isAtomicTag(spec.tag))
        .map(spec => Decoration.replace({}).range(spec.from, spec.to)),
      sort: true,
    }),
    specs: [...retained, ...additions].sort((a, b) => a.from - b.from || a.to - b.to),
    treeLength,
  }
}

// block: true 的 widget 只能由 StateField 提供——经 ViewPlugin 提供会在 measure
// 阶段抛 "Block decorations may not be specified via plugins"（root cause A，
// 真实 app 中所有含块 widget 的文档全崩，但纯函数测试完全测不到）。
export const livePreviewField = StateField.define<LiveDeco>({
  create: state => buildLiveDecorations(state),
  update: updateLiveDecorations,
  provide: field => [
    EditorView.decorations.from(field, v => v.deco),
    // atomicRanges facet 的值类型是函数，包一层闭包
    EditorView.atomicRanges.compute([field], state => {
      const atomic = state.field(field).atomic
      return () => atomic
    }),
  ],
})
