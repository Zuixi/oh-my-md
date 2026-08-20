import {
  type ChangeDesc,
  type EditorState,
  StateEffect,
  StateField,
  type Transaction,
} from "@codemirror/state"
import { syntaxTree, syntaxTreeAvailable } from "@codemirror/language"
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view"
import { inlineRules } from "./inline"
import { blockRules } from "./blocks"
import type { DecoSpec } from "./types"

export { nearCursor, type DecoSpec } from "./types"

// 大文档（50MB 级）全量装饰同步构建会冻结数秒 —— live 预览改为渐进：
// create/reconfigure 只同步构建光标附近的“种子”区间，其余记入 LiveDeco.pending，
// 由分片驱动（idle 切片 ViewPlugin，后续任务）逐片 dispatch liveBuildChunk 消耗。
// 种子半径行数与字符数双重截断：300 行覆盖视口滚动余量，
// 120k 字符防住超长行文档（行数半径在单行超长时失去意义）。
export const LIVE_SEED_RADIUS_LINES = 300
export const LIVE_SEED_RADIUS_CHARS = 120_000

// 单个 liveBuildChunk 的字符上限（2^18）：测试排空与分片驱动共用同一粒度。
export const LIVE_BUILD_CHUNK_CHARS = 262_144

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
  /** 尚未构建装饰的区间（闭区间，有序、互不相交、from <= to）。 */
  pending: { from: number; to: number }[]
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

// 全量构建（0..doc.length）：bench 与测试对拍的基准，不再被 field 的
// create/reconfigure 路径使用（那两条路径只做种子构建，见 seedLiveDecorations）。
export function buildLiveDecorations(state: EditorState): LiveDeco {
  const specs = collectDecorationSpecs(state, 0, state.doc.length)
  const sets = decorationSets(specs)
  return {
    ...sets,
    specs,
    treeLength: syntaxTree(state).length,
    pending: [],
  }
}

// 种子构建：以主选区 head 所在行为中心，构建 [seedFrom, seedTo]
// （行半径 + 字符半径双重截断），pending = [0, doc.length] 减去种子区间（0/1/2 段）。
// 树不完整时种子只产出树内 specs；树增长经 updateLiveDecorations 并入 pending，由分片补齐。
export function seedLiveDecorations(state: EditorState): LiveDeco {
  const length = state.doc.length
  const head = state.selection.main.head
  const cursorLine = state.doc.lineAt(head)
  const firstLine = Math.max(1, cursorLine.number - LIVE_SEED_RADIUS_LINES)
  const lastLine = Math.min(state.doc.lines, cursorLine.number + LIVE_SEED_RADIUS_LINES)
  const from = Math.max(state.doc.line(firstLine).from, Math.max(0, head - LIVE_SEED_RADIUS_CHARS))
  const to = Math.min(state.doc.line(lastLine).to, Math.min(length, head + LIVE_SEED_RADIUS_CHARS))
  const seed = { from: Math.min(from, to), to: Math.max(from, to) }
  const specs = collectDecorationSpecs(state, seed.from, seed.to)
  const sets = decorationSets(specs)
  return {
    ...sets,
    specs,
    pending: subtractRanges([{ from: 0, to: length }], [seed]),
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

// 闭区间减法：从有序不相交的 ranges 中挖掉 removals 覆盖的部分，
// 结果保持有序、互不相交、from <= to（挖空即丢弃）。种子与 chunk 消耗
// 共用此语义：端点 +1/-1，使点装饰位置在种子与各 chunk 间恰好划分一次。
function subtractRanges(ranges: RebuildRange[], removals: RebuildRange[]): RebuildRange[] {
  const cuts = mergeRanges(removals)
  const out: RebuildRange[] = []
  for (const range of ranges) {
    let from = range.from
    for (const cut of cuts) {
      if (cut.to < from) continue          // 剪裁区间完全在左侧
      if (cut.from > range.to) break       // 完全在右侧，后续更不可能相交
      if (cut.from > from) out.push({ from, to: cut.from - 1 })
      from = Math.max(from, cut.to + 1)
      if (from > range.to) break
    }
    if (from <= range.to) out.push({ from, to: range.to })
  }
  return out
}

const SELECTION_BLOCKS = new Set(["FencedCode", "MathBlock", "Table", "HorizontalRule", "FrontMatter"])

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

function rebuildRanges(tr: Transaction) {
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

  return mergeRanges(ranges)
}

// 分片驱动 dispatch 的“构建 [from, to]（tr.state 坐标）”信号：
// 区间并入该交易的重建范围（走既有 map+filter+add 路径），并从 pending 中扣除。
export const liveBuildChunk = StateEffect.define<{ from: number; to: number }>()

function updateLiveDecorations(value: LiveDeco, tr: Transaction): LiveDeco {
  // 重配置（compartment 切换 / StateEffect.reconfigure）同样只做种子构建，不再全量
  if (tr.reconfigured) return seedLiveDecorations(tr.state)

  // 本交易携带的分片区间（tr.state 坐标，无需映射）。与 docChanged 同交易组合时，
  // pending 先随变更映射、再扣除分片，二者叠加语义正确。
  const chunkRanges: RebuildRange[] = []
  for (const effect of tr.effects) {
    if (!effect.is(liveBuildChunk)) continue
    const from = Math.max(0, effect.value.from)
    const to = Math.min(tr.state.doc.length, effect.value.to)
    if (from <= to) chunkRanges.push({ from, to })
  }

  const selectionChanged = !tr.startState.selection.eq(tr.newSelection)
  const treeLength = !tr.docChanged && selectionChanged
    ? value.treeLength
    : syntaxTree(tr.state).length

  // pending 随文档变更映射（端点外扩关联 from:-1 / to:+1：pending 边界处的新增文本
  // 也算未构建；区间塌缩为 from > to 时丢弃）。映射可能让两侧区间重叠或紧贴
  // （如整段删除把左右 pending 压到同一点/相邻），mergeRanges 归一化回
  // 「有序、互不相交」——LiveDeco.pending 的文档化不变量，分片驱动据此挑区间。
  let pending = value.pending
  if (tr.docChanged) {
    pending = mergeRanges(pending
      .map(range => ({
        from: tr.changes.mapPos(range.from, -1),
        to: tr.changes.mapPos(range.to, 1),
      })))
  }

  // 树增长：pending 非空时增长区间并入 pending（由分片驱动消化，避免同步跟进与
  // 分片重复构建；并集也能让“树未就绪时被消耗掉的空区间”随增长回到 pending）；
  // pending 为空时保持现状 —— 同步重建增长区间。
  const treeGrew = !tr.docChanged && !selectionChanged && treeLength > value.treeLength
  let growth: RebuildRange | undefined
  if (treeGrew) growth = expandRange(tr.state, value.treeLength, treeLength)
  if (growth && pending.length > 0) {
    pending = mergeRanges([...pending, growth])
    growth = undefined
  }

  if (chunkRanges.length) pending = subtractRanges(pending, chunkRanges)

  const ranges = [...chunkRanges, ...rebuildRanges(tr)]
  if (growth) ranges.push(growth)
  if (!ranges.length) {
    return treeLength === value.treeLength && pending === value.pending
      ? value
      : { ...value, treeLength, pending }
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
    pending,
  }
}

// 仅供测试：同步排空 pending —— 循环按 ≤LIVE_BUILD_CHUNK_CHARS 切片 dispatch
// liveBuildChunk，直到 pending 为空。不推进语法树解析（解析由调用方先行完成）：
// pending 中树尚未覆盖的区域收不到 specs，仅从 pending 移除。
export function drainPendingLiveBuild(view: EditorView) {
  if (!view.state.field(livePreviewField, false)) return
  for (;;) {
    const pending = view.state.field(livePreviewField).pending
    if (pending.length === 0) return
    const first = pending[0]
    const to = Math.min(first.to, first.from + LIVE_BUILD_CHUNK_CHARS - 1)
    const before = pending.map(r => `${r.from}:${r.to}`).join(",")
    view.dispatch({ effects: liveBuildChunk.of({ from: first.from, to }) })
    const after = view.state.field(livePreviewField).pending
    if (after.map(r => `${r.from}:${r.to}`).join(",") === before) {
      throw new Error(`drainPendingLiveBuild made no progress on [${first.from}, ${to}]`)
    }
  }
}

// block: true 的 widget 只能由 StateField 提供——经 ViewPlugin 提供会在 measure
// 阶段抛 "Block decorations may not be specified via plugins"（root cause A，
// 真实 app 中所有含块 widget 的文档全崩，但纯函数测试完全测不到）。
export const livePreviewField = StateField.define<LiveDeco>({
  create: state => seedLiveDecorations(state),
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
