import {
  type EditorState,
  StateEffect,
  StateField,
  type Transaction,
} from "@codemirror/state"
import { syntaxTree, syntaxTreeAvailable } from "@codemirror/language"
import { Decoration, type DecorationSet, EditorView, type WidgetType } from "@codemirror/view"
import { inlineRules } from "./inline"
import { blockRules } from "./blocks"
import type { SyntaxNode } from "@lezer/common"
import type { DecoSpec } from "./types"
import { mapDecoSpec, mapSpecsFast, reconcileSpecs, sortDecoSpecs, unrepresentableAtPoint } from "./specIndex"
import {
  docEndOwned,
  mergeRanges,
  outsideAllRegions,
  specKept,
  subtractRanges,
  type RebuildRange,
} from "./ranges"
import { measureBlockWidget } from "./widgetMeasure"
import { revealTableSource } from "../tables/sourceReveal"
import { editorReferenceContext } from "../semantic/references"
import { collectOrderedListLabels } from "../lists/ordered"

export { nearCursor, type DecoSpec } from "./types"
export { mergeRanges } from "./ranges"

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
  const orderedLabels = new Map<number, ReadonlyMap<number, string>>()
  const labelFor = (mark: SyntaxNode): string | null => {
    const list = mark.parent?.parent
    if (list?.name !== "OrderedList") return null
    let labels = orderedLabels.get(list.from)
    if (!labels) {
      labels = collectOrderedListLabels(list, state)
      orderedLabels.set(list.from, labels)
    }
    return labels.get(mark.from) ?? null
  }
  syntaxTree(state).iterate({
    from, to,
    enter(node) {
      inlineRules(node, state, out)
      // blockRules 返回 true = 产出了覆盖整个节点的块 widget → 跳过子树，
      // 否则子树内的行内装饰会与块 replace 范围重叠，Decoration.set 直接抛错
      if (blockRules(node, state, out, labelFor)) return false
    },
  })
  // 兜底：块 widget 范围内的外层装饰（如 blockquote 行装饰盖住表格）同样冲突，丢弃。
  // 覆盖判定含换行块替换的边界：点装饰落在 b.to 上属于「替换后的下一行」（行装饰
  // 挂在行首），不得丢弃 —— 头部 chrome 块替换的 to 恰是首个内容行的行首。
  const coveredByBlock = (s: DecoSpec) =>
    blockWidgets.some(b => s.from >= b.from && s.to <= b.to && s.from < b.to)
  const scoped = out.filter(s => s.from <= to && s.to >= from)
  const blockWidgets = scoped.filter(s => s.tag.startsWith("widget:block:"))
  if (!blockWidgets.length) return sortDecoSpecs(scoped)
  return sortDecoSpecs(scoped.filter(s =>
    s.tag.startsWith("widget:block:") || !coveredByBlock(s)))
}

// 原子区间只收“行中”的内联 replace 类装饰（折叠的语法标记 + 内联 widget，如 checkbox）。
// 三条规则：
//   Rule 1 — mark:/line: 装饰不进原子区间：光标移动/删除会被锁死在样式文本外（root cause B）。
//   Rule 2 — widget:block:* 块 widget 不进原子区间：块 widget 跨越多行，加入后 ↑/↓ 直接跳过
//     整块、paste 时 CM 扩展粘贴位置连带选中下一行。
//   Rule 3 — 行首原子（from === line.from）与跨行原子（to > line.to）不进原子区间：
//     skipAtomsForSelection 对指针选区端点做循环外推，这两类原子让外推跨过换行符、
//     级联高亮下一行（“点击选中连带下一行”）。行首标记退出后不会产生不可见光标：
//     nearCursor 的行级显源码会把整行展开（自愈路径）。
//   Rule 4 — 硬换行 marker（行末 `\` / 行末空格）不进原子区间：它紧贴换行符结束，
//     skipAtoms 会把「行末」的光标位推过换行符，表现为点击行末/← 落到下一行、
//     拖选连带下一行。显式按 tag 排除，不靠 Rule 3 的边界算术。
const HARD_BREAK_MARK_TAG = "replace:HardBreakMark"

function isAtomicTag(tag: string) {
  return tag !== HARD_BREAK_MARK_TAG &&
    (tag.startsWith("replace:") || tag.startsWith("widget:")) &&
    !tag.startsWith("widget:block:")
}

function isAtomicSpec(spec: DecoSpec, state: EditorState): boolean {
  if (!isAtomicTag(spec.tag)) return false
  const line = state.doc.lineAt(spec.from)
  return spec.from > line.from && spec.to <= line.to
}

export interface LiveDeco {
  deco: DecorationSet
  atomic: DecorationSet
  specs: DecoSpec[]
  treeLength: number
  /** 尚未构建装饰的区间（闭区间，有序、互不相交、from <= to）。 */
  pending: { from: number; to: number }[]
}

function decorationSets(specs: DecoSpec[], state: EditorState) {
  return {
    deco: Decoration.set(specs.map(s => s.deco.range(s.from, s.to)), true),
    atomic: Decoration.set(
      specs.filter(s => isAtomicSpec(s, state)).map(s => Decoration.replace({}).range(s.from, s.to)),
      true,
    ),
  }
}

// 全量构建（0..doc.length）：bench 与测试对拍的基准，不再被 field 的
// create/reconfigure 路径使用（那两条路径只做种子构建，见 seedLiveDecorations）。
export function buildLiveDecorations(state: EditorState): LiveDeco {
  const specs = collectDecorationSpecs(state, 0, state.doc.length)
  const sets = decorationSets(specs, state)
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
  const sets = decorationSets(specs, state)
  return {
    ...sets,
    specs,
    pending: subtractRanges([{ from: 0, to: length }], [seed]),
    treeLength: syntaxTree(state).length,
  }
}

// `mergeRanges` / `subtractRanges` / `specKept` live in `./ranges` (one owner for
// the closed-interval algebra shared with the build driver); `mergeRanges` is
// re-exported above for existing callers.

const SELECTION_BLOCKS = new Set(["FencedCode", "MathBlock", "Table", "HTMLBlock", "HorizontalRule", "FrontMatter"])

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
      // 位置落在顶层块之间的空白行（段落间隔、文末空行）时 resolve 返回
      // Document 本身：此处没有可外扩的块，行级区间已经覆盖该空行（空行不产出
      // 装饰）。若照旧外扩到 Document，一次普通段落内的逐键编辑就会把重建区间
      // 扩成整篇 —— 353 KB / 57 600 spec 的文档每键全量重建（66–81 ms）。
      if (node.parent === null) continue
      safeFrom = Math.min(safeFrom, node.from)
      safeTo = Math.max(safeTo, node.to)
    }
  }
  return { from: safeFrom, to: safeTo }
}

function rebuildRanges(tr: Transaction) {
  const ranges: RebuildRange[] = []

  for (const effect of tr.effects) {
    if (effect.is(measureBlockWidget)) {
      ranges.push(expandRange(tr.state, effect.value.pos, effect.value.pos, SELECTION_BLOCKS))
    } else if (effect.is(revealTableSource)) {
      const head = tr.newSelection.main.head
      ranges.push(expandRange(tr.state, head, head, SELECTION_BLOCKS))
    }
  }

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

// 语义投影的依赖身份表：spec.tag → 决定该投影内容的访问器身份。身份变了（引用定义
// 增删改、索引重建）说明已构建的这类投影可能过期 —— 但只重建「已构建的」那些：直接
// 取现有 specs 的区间映射，绝不为找候选而扫描文档其余部分。加一类投影依赖（如表格
// widget）只在此加一行，不动重组逻辑。
// 已知边界：从未挂载过的引用图片（无 spec）不会因为事后出现定义而被挂载 —— 找这类
// 候选需要全文档扫 Image 节点；只有仍在 pending 里的区间会在后续分片重建时自然挂载。
const semanticProjections: { tag: string; identity: (state: EditorState) => unknown }[] = [
  { tag: "widget:image", identity: state => editorReferenceContext(state).resolveReference },
  { tag: "widget:block:table", identity: state => editorReferenceContext(state).resolveReference },
]

function staleProjectionRanges(tr: Transaction, value: LiveDeco): RebuildRange[] {
  const stale = new Set(
    semanticProjections
      .filter(projection => projection.identity(tr.startState) !== projection.identity(tr.state))
      .map(projection => projection.tag),
  )
  if (stale.size === 0) return []
  return value.specs
    .filter(spec => stale.has(spec.tag))
    .map(spec => ({
      from: tr.changes.mapPos(spec.from, -1),
      to: tr.changes.mapPos(spec.to, 1),
    }))
    .filter(range => range.from <= range.to)
}

// 分片驱动 dispatch 的“构建 [from, to]（tr.state 坐标）”信号：
// 区间并入该交易的重建范围（走既有 map+filter+add 路径），并从 pending 中扣除。
export const liveBuildChunk = StateEffect.define<{ from: number; to: number }>()

// 安全模式窗口裁剪信号（Task 3）：value 为裁剪窗口（闭区间数组，可多段，tr.state
// 坐标）。字段移除「完全落在所有窗口区域之外」的 specs/deco/atomic，其行对齐
// 区间归还 pending，待重新滚入构建窗口时经 liveBuildChunk 重建；与任一区域相交
// （哪怕只是部分相交）的装饰保留 —— 不拆分装饰边界。由 liveBuildDriver 在
// safeModeRenderingEnabled() 时 dispatch；效果处理本身不查全局开关 —— effect 即
// 显式指令，开关只约束驱动策略（也便于字段级测试直接驱动）。
export const livePruneOutside = StateEffect.define<{ from: number; to: number }[]>()

function updateLiveDecorations(value: LiveDeco, tr: Transaction): LiveDeco {
  // 重配置（compartment 切换 / StateEffect.reconfigure）同样只做种子构建，不再全量
  if (tr.reconfigured) return seedLiveDecorations(tr.state)

  // 本交易携带的分片区间与裁剪窗口（tr.state 坐标，无需映射）。与 docChanged 同
  // 交易组合时，pending 先随变更映射、再归还裁剪区间、最后扣除分片，叠加语义正确。
  const chunkRanges: RebuildRange[] = []
  const pruneWindows: RebuildRange[] = []
  for (const effect of tr.effects) {
    if (effect.is(liveBuildChunk)) {
      const from = Math.max(0, effect.value.from)
      const to = Math.min(tr.state.doc.length, effect.value.to)
      if (from <= to) chunkRanges.push({ from, to })
    } else if (effect.is(livePruneOutside)) {
      for (const region of effect.value) {
        const from = Math.max(0, region.from)
        const to = Math.min(tr.state.doc.length, region.to)
        if (from <= to) pruneWindows.push({ from, to })
      }
    }
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

  // 窗口裁剪（安全模式）：映射后的 specs 中「完全落在裁剪窗口外」者移除，其行
  // 对齐区间（line.from..line.to）归还 pending。行对齐而非装饰自身区间的理由：
  // 相邻行的行 span 首尾相接（line N.to + 1 === line N+1.from），mergeRanges 能把
  // 成片裁剪压回一两个大 pending 区间 —— 按装饰区间归还会把 pending 打散成数千
  // 小段，此后每笔 docChanged 的映射都付 O(n log n) 归一化代价；行边界也让后续
  // 分片重建的区间与原构建可对拍（collectDecorationSpecs 按行边界切片产出稳定）。
  // 被裁装饰的行可能与窗口相交（装饰整体在外、所在行跨过窗口边缘）：整行归还
  // pending 没有错 —— 窗口内的部分随后续分片重建，窗口外的部分仍在 pending。
  // 先归还再扣分片：分片来自构建窗口（含可见区）、裁剪只动裁剪窗口外（驱动侧
  // 保证裁剪窗口 ⊇ 构建窗口），二者不相交，顺序不影响结果。
  const mappedSpecs = tr.docChanged
    ? mapSpecsFast(value.specs, tr.changes, mapDecoSpec)
    : value.specs
  const prunedSpecs = pruneWindows.length > 0
    ? mappedSpecs.filter(spec => outsideAllRegions(spec.from, spec.to, pruneWindows))
    : []
  if (prunedSpecs.length > 0) {
    pending = mergeRanges([...pending, ...prunedSpecs.map(spec => ({
      from: tr.state.doc.lineAt(spec.from).from,
      to: tr.state.doc.lineAt(spec.to).to,
    }))])
  }
  if (chunkRanges.length) pending = subtractRanges(pending, chunkRanges)

  const ranges = [...chunkRanges, ...rebuildRanges(tr)]
  if (growth) ranges.push(growth)
  // 访问器身份只可能随文档变更或树增长而变（选择变化与分片不改变定义集）。
  if (tr.docChanged || treeLength !== value.treeLength) {
    ranges.push(...staleProjectionRanges(tr, value))
  }
  if (!ranges.length && prunedSpecs.length === 0) {
    return treeLength === value.treeLength && pending === value.pending
      ? value
      : { ...value, treeLength, pending }
  }

  // 先让 CodeMirror 用 ChangeDesc 精确映射未受影响的装饰，再替换语法安全脏区。
  const mappedDeco = value.deco.map(tr.changes)
  const mappedAtomic = value.atomic.map(tr.changes)
  const dirty = docEndOwned(ranges, tr.state.doc.length)
  const rebuilt = dirty.flatMap(range =>
    collectDecorationSpecs(tr.state, range.from, range.to))
  // 新块 widget 可能从脏区内开始、却吞并后续旧块；移除范围必须覆盖它的完整 replace 区间。
  const removalRanges = mergeRanges([
    ...dirty,
    ...rebuilt
      .filter(spec => spec.tag.startsWith("widget:block:"))
      .map(spec => ({ from: spec.from, to: spec.to })),
  ])
  // 保留谓词 = 窗口内（或与窗口相交）∧ 不在脏区移除范围：specs/deco/atomic 三处
  // 必须共用同一口径，否则 specs 数组与 RangeSet 漂移（deco.size !== specs.length
  // 级别的不变量破坏）。分区与 filter 同一个 `specKept` 实现（specIndex.ts）。
  const keep = (from: number, to: number) => specKept(from, to, removalRanges, pruneWindows)
  // `RangeSet.update` only invokes `filter` for ranges inside [filterFrom, filterTo].
  // Every spec at which `keep` returns false intersects a removal range, so it
  // necessarily sits inside the removal envelope — whole B-tree chunks outside it
  // are skipped in O(log N) instead of walking all 57k decorations per keystroke.
  // A prune window is not bounded by the dirty ranges, so windowed updates keep
  // the unbounded filter (their spec count is bounded by the window as well).
  const bounded = pruneWindows.length === 0 && removalRanges.length > 0
  const filterSpec = bounded
    ? {
        filter: keep,
        filterFrom: removalRanges[0].from,
        filterTo: removalRanges[removalRanges.length - 1].to,
      }
    : pruneWindows.length > 0 ? { filter: keep } : {}
  // 身份复用（滚动稳定性）：重建区间内被移除的同键 spec，若 widget 等价（eq）则
  // 复用原 spec 对象。CM 的 heightRelevantDecoChanges 按对象身份判变（比较器不
  // 调 eq），Decoration 身份漂移 = height-relevant 变更 → applyChanges 用估算值
  // 重建该块高度图，丢弃已测高度 → 下一帧实测改回。measureBlockWidget 每次绘制
  // 都触发该重建，「实测→估算→实测」振荡表现为滚轮下滑时位置回撤、拖动滚动条
  // 时 thumb 与内容映射漂移。复用身份后该区间对高度图零变更。
  const widgetOf = (spec: DecoSpec): WidgetType | undefined =>
    (spec.deco.spec as { widget?: WidgetType }).widget
  const specs = reconcileSpecs({
    mapped: mappedSpecs,
    rebuilt,
    removalRanges,
    pruneWindows,
    reuse: (dropped, spec) => {
      const oldWidget = widgetOf(dropped)
      const newWidget = widgetOf(spec)
      // 仅 widget spec 等价时复用：非 widget 装饰（line/mark/replace）身份漂移
      // 不影响高度图（compareRange 是 no-op），不值得冒语义比较风险。
      return oldWidget && newWidget && oldWidget.eq(newWidget) ? dropped : spec
    },
  })

  const next: LiveDeco = {
    deco: mappedDeco.update({
      ...filterSpec,
      add: specs.additions.map(spec => spec.deco.range(spec.from, spec.to)),
      sort: true,
    }),
    atomic: mappedAtomic.update({
      ...filterSpec,
      add: specs.additions
        .filter(spec => isAtomicSpec(spec, tr.state))
        .map(spec => Decoration.replace({}).range(spec.from, spec.to)),
      sort: true,
    }),
    specs: specs.specs,
    treeLength,
    pending,
  }
  // Cardinality is the load-bearing invariant behind the shared `keep`
  // predicate: one range per spec. If a future change breaks it, rebuild from
  // the specs instead of feeding CodeMirror a drifted pairs/triples set —
  // a degraded but self-consistent frame beats a mis-mapped decoration range.
  if (next.deco.size === next.specs.length) return next
  // Repairing means rebuilding every range, and a collapsed mark/replace spec is
  // unrepresentable in a fresh DecorationSet. In that (now impossible) case a
  // degraded but consistent frame beats throwing on every transaction.
  const rebuildable = !next.specs.some(unrepresentableAtPoint)
  return rebuildable ? { ...next, ...decorationSets(next.specs, tr.state) } : next
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
