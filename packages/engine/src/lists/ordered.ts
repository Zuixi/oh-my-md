import type { SyntaxNode } from "@lezer/common"
import {
  Annotation,
  ChangeSet,
  StateEffect,
  StateField,
  Transaction,
  type ChangeDesc,
  type EditorState,
  type TransactionSpec,
} from "@codemirror/state"
import { syntaxTree } from "@codemirror/language"
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view"
import { safeModeRenderingEnabled } from "../safeModeRendering"

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

// 安全模式（Task 4）重编号扫描的外扩半径：可见段与 docChanged 变更段两侧各扩
// 100_000 字符后归并为扫描区间。与 LIVE_WINDOW_CHARS（262_144）同量级而更小 ——
// 重编号扫描只找 OrderedList 节点，比装饰构建轻，100k 已覆盖视口滚动余量与
// 「编辑点邻近列表」的常见形态。区间之外的乱序列表（大文档远端）留待滚入窗口
// 或就近编辑时再编 —— 这是安全模式的既定取舍：远端乱序列表在被滚近/编辑近
// 之前不会产出规范化通知（notice UX 同样以窗口为界）。非安全模式不受影响。
export const RENUMBER_SCAN_MARGIN_CHARS = 100_000

/** 重编号扫描区间（文档位置，from <= to）。 */
export interface OrderedRenumberRange {
  readonly from: number
  readonly to: number
}

export function orderedRenumberChanges(
  state: EditorState,
  range?: OrderedRenumberRange,
): OrderedMarkChange[] {
  const changes: OrderedMarkChange[] = []
  // range 只限定「访问哪些列表」：syntaxTree.iterate 对与 [from, to] 相交的节点都会
  // enter，且 enter 拿到的 node.node 是完整的 OrderedList 节点 —— 跨区间边界的列表
  // 仍按完整范围重编号（forEachOrderedMark 语义不变）。缺省 range = 全树（既有行为）。
  const bounds = range === undefined ? {} : { from: range.from, to: range.to }
  syntaxTree(state).iterate({
    ...bounds,
    enter(node) {
      if (node.name !== "OrderedList") return
      forEachOrderedMark(node.node, state, (mark, raw, expected) => {
        if (raw !== expected) changes.push({ from: mark.from, to: mark.to, insert: expected })
      })
    },
  })
  return changes
}

declare const normalizationIdBrand: unique symbol

/** Opaque handle for one batch of ordered-list marker rewrites. */
export type NormalizationId = number & {
  readonly [normalizationIdBrand]: "NormalizationId"
}

export interface OrderedListNormalizationNotice {
  readonly id: NormalizationId
  readonly markerCount: number
}

export type OrderedListNormalizationAcceptResult =
  | { readonly kind: "accepted"; readonly transaction: TransactionSpec }
  | { readonly kind: "stale" }

export type OrderedListNormalizationRejectResult =
  | {
      readonly kind: "reverted"
      readonly transaction: TransactionSpec
      readonly restoredMarkers: number
      readonly skippedMarkers: number
    }
  | { readonly kind: "stale" }

interface ReversibleOrderedMarker {
  readonly from: number
  readonly to: number
  readonly original: string
  readonly normalized: string
}

interface PendingOrderedNormalization {
  readonly id: NormalizationId
  readonly markers: readonly ReversibleOrderedMarker[]
}

interface OrderedNormalizationState {
  readonly nextId: number
  readonly pending: PendingOrderedNormalization | null
  readonly suppressed: boolean
}

// A user edit at a marker boundary belongs to the surrounding text, never to the marker range.
const MAP_FROM_ASSOC = 1
const MAP_TO_ASSOC = -1
const FIRST_NORMALIZATION_ID = 1

const emptyNormalizationState: OrderedNormalizationState = {
  nextId: FIRST_NORMALIZATION_ID,
  pending: null,
  suppressed: false,
}

const resolveNormalization = StateEffect.define<{
  readonly id: NormalizationId
  readonly suppress: boolean
}>()

/** One batch of marker rewrites. The trigger decides whether the batch is reversible. */
interface OrderedNormalizationBatch {
  readonly trigger: "preview-entry" | "user-followup"
  readonly changes: readonly OrderedMarkChange[]
}

const orderedRenumberAnn = Annotation.define<OrderedNormalizationBatch>()

/**
 * Classifies one normalization pass. While the syntax tree does not yet cover the document, later
 * passes are still parse progress of the same preview entry: an early pass can see no list at all,
 * so the entry window must not close on pass count. Once the tree is complete, only a document
 * change the user made can have produced new wrong numbers.
 */
export function normalizationTrigger(
  hasUserDocChange: boolean,
  treeLength: number,
  docLength: number,
): "preview-entry" | "user-followup" {
  if (treeLength < docLength) return "preview-entry"
  return hasUserDocChange ? "user-followup" : "preview-entry"
}

/**
 * The only place that stamps a normalization batch. `changes` are positions in `state`'s document,
 * resolved against it here so an out-of-range batch fails instead of landing somewhere else; the
 * state field re-derives marker ranges from the resulting transaction.
 */
export function buildOrderedNormalizationTransaction(
  state: EditorState,
  trigger: "preview-entry" | "user-followup",
  changes: readonly OrderedMarkChange[],
): TransactionSpec {
  return {
    changes: ChangeSet.of(changes, state.doc.length),
    annotations: [
      orderedRenumberAnn.of({ trigger, changes }),
      Transaction.addToHistory.of(false),
    ],
  }
}

export function mapReversibleMarkerRange(
  marker: ReversibleOrderedMarker,
  changes: ChangeDesc,
): ReversibleOrderedMarker {
  return {
    ...marker,
    from: changes.mapPos(marker.from, MAP_FROM_ASSOC),
    to: changes.mapPos(marker.to, MAP_TO_ASSOC),
  }
}

/**
 * Merges a newer batch into the recorded markers. A marker rewritten again keeps the user's own
 * text as `original` and takes the latest `normalized`, so it stays one revertible marker.
 */
export function mergeReversibleOrderedMarkers(
  existing: readonly ReversibleOrderedMarker[],
  incoming: readonly ReversibleOrderedMarker[],
): readonly ReversibleOrderedMarker[] {
  const byStart = new Map(existing.map(marker => [marker.from, marker]))
  for (const marker of incoming) {
    const recorded = byStart.get(marker.from)
    byStart.set(marker.from, recorded ? { ...marker, original: recorded.original } : marker)
  }
  return [...byStart.values()].sort((a, b) => a.from - b.from)
}

/** Markers this normalization transaction wrote, in the coordinates of the resulting document. */
function batchMarkers(tr: Transaction): readonly ReversibleOrderedMarker[] {
  const markers: ReversibleOrderedMarker[] = []
  tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    markers.push({
      from: fromB,
      to: toB,
      original: tr.startState.doc.sliceString(fromA, toA),
      normalized: inserted.toString(),
    })
  })
  return markers
}

function mapPendingMarkers(
  value: OrderedNormalizationState,
  tr: Transaction,
): OrderedNormalizationState {
  if (!value.pending || !tr.docChanged) return value
  const markers = value.pending.markers.map(marker => mapReversibleMarkerRange(marker, tr.changes))
  return { ...value, pending: { ...value.pending, markers } }
}

function recordNormalizationBatch(
  value: OrderedNormalizationState,
  tr: Transaction,
): OrderedNormalizationState {
  const batch = tr.annotation(orderedRenumberAnn)
  if (!batch || value.suppressed) return value
  const incoming = batchMarkers(tr)
  const pending = value.pending
  if (!pending) {
    if (batch.trigger === "user-followup" || incoming.length === 0) return value
    const id = value.nextId as NormalizationId
    return { ...value, nextId: value.nextId + 1, pending: { id, markers: incoming } }
  }
  // A follow-up rewrite refreshes markers already pending, but never adds new ones.
  const known = new Set(pending.markers.map(marker => marker.from))
  const accepted =
    batch.trigger === "preview-entry"
      ? incoming
      : incoming.filter(marker => known.has(marker.from))
  if (accepted.length === 0) return value
  const markers = mergeReversibleOrderedMarkers(pending.markers, accepted)
  return { ...value, pending: { ...pending, markers } }
}

function applyResolveEffect(
  value: OrderedNormalizationState,
  effect: StateEffect<unknown>,
): OrderedNormalizationState {
  if (!effect.is(resolveNormalization) || value.pending?.id !== effect.value.id) return value
  return {
    nextId: value.nextId,
    pending: null,
    suppressed: value.suppressed || effect.value.suppress,
  }
}

/**
 * Stages run in a fixed order — map, record, resolve — so a transaction that both normalizes and
 * resolves ends resolved regardless of how its effects are ordered.
 */
function updateOrderedNormalization(
  value: OrderedNormalizationState,
  tr: Transaction,
): OrderedNormalizationState {
  const recorded = recordNormalizationBatch(mapPendingMarkers(value, tr), tr)
  return tr.effects.reduce(applyResolveEffect, recorded)
}

/**
 * Tracks the reversible preview-entry rewrite. Mounted outside the live-preview compartment so a
 * pending notice and its suppression survive Source/Live toggles.
 */
export const orderedNormalizationState = StateField.define<OrderedNormalizationState>({
  create: () => emptyNormalizationState,
  update: updateOrderedNormalization,
})

export function getPendingOrderedListNormalization(
  state: EditorState,
): OrderedListNormalizationNotice | null {
  const pending = state.field(orderedNormalizationState, false)?.pending
  return pending ? { id: pending.id, markerCount: pending.markers.length } : null
}

function pendingFor(
  state: EditorState,
  id: NormalizationId,
): PendingOrderedNormalization | null {
  const pending = state.field(orderedNormalizationState, false)?.pending
  return pending && pending.id === id ? pending : null
}

/** Keeps the rewrite and clears the notice; the document is untouched. */
export function acceptOrderedListNormalization(
  state: EditorState,
  id: NormalizationId,
): OrderedListNormalizationAcceptResult {
  if (!pendingFor(state, id)) return { kind: "stale" }
  return {
    kind: "accepted",
    transaction: { effects: [resolveNormalization.of({ id, suppress: false })] },
  }
}

/** Restores every marker the user has not since edited, and stops further rewrites. */
export function rejectOrderedListNormalization(
  state: EditorState,
  id: NormalizationId,
): OrderedListNormalizationRejectResult {
  const pending = pendingFor(state, id)
  if (!pending) return { kind: "stale" }
  const restorable = pending.markers.filter(
    marker => state.doc.sliceString(marker.from, marker.to) === marker.normalized,
  )
  return {
    kind: "reverted",
    transaction: {
      changes: restorable.map(m => ({ from: m.from, to: m.to, insert: m.original })),
      effects: [resolveNormalization.of({ id, suppress: true })],
      annotations: [Transaction.addToHistory.of(false)],
    },
    restoredMarkers: restorable.length,
    skippedMarkers: pending.markers.length - restorable.length,
  }
}

// 扫描区间归并（与 decorations/build.ts 的 mergeRanges 同语义：升序、重叠或相邻段
// 合一）。list 模块不便反向依赖 decorations —— blocks.ts 已依赖本模块的
// orderedLabel，会构成环 —— 故内联同款实现；外扩后相邻段合一，也保证同一列表
// 不会被两段区间重复扫描而产出重复变更。
function mergeRenumberRanges(ranges: OrderedRenumberRange[]): OrderedRenumberRange[] {
  const sorted = ranges
    .filter(range => range.from <= range.to)
    .sort((a, b) => a.from - b.from || a.to - b.to)
  const merged: { from: number; to: number }[] = []
  for (const range of sorted) {
    const previous = merged[merged.length - 1]
    if (previous && range.from <= previous.to + 1) previous.to = Math.max(previous.to, range.to)
    else merged.push({ ...range })
  }
  return merged
}

// 可见段锚点（CM 半开 [from, to) 的端点原样作为位置参与相交判定；空列表退化为
// 光标点，与 buildDriver.visibleRegions 的兜底同款 —— 类型契约不承诺非空）。
function visibleScanAnchors(view: EditorView): OrderedRenumberRange[] {
  const ranges = view.visibleRanges
  if (ranges.length > 0) return ranges.map(range => ({ from: range.from, to: range.to }))
  const head = view.state.selection.main.head
  return [{ from: head, to: head }]
}

// 扫描区间随文档变更映射：微任务 apply 前多笔 update 到达时，旧的变更区间要先
// 映射到最新坐标。邻接插入处的 ±1 关联差异由 RENUMBER_SCAN_MARGIN_CHARS 吸收
// （该插入自身也会作为变更区间记入计划）。
function mapRenumberRange(range: OrderedRenumberRange, changes: ChangeDesc): OrderedRenumberRange {
  return {
    from: changes.mapPos(range.from, MAP_FROM_ASSOC),
    to: changes.mapPos(range.to, MAP_TO_ASSOC),
  }
}

// 安全模式（Task 4）下一趟扫描的计划，由微任务 apply 消费：changed 是 docChanged
// 的变更区间（记录时已映射到最新状态坐标）；visible 标记入场/树增长触发的可见
// 窗口扫描。微任务前多笔 update 到达时计划累积（变更区间映射后合并，visible 只
// 置位；docChanged 与树增长同笔到达时取并集）。
interface RenumberScanPlan {
  changed: OrderedRenumberRange[]
  visible: boolean
}

const EMPTY_SCAN_PLAN: RenumberScanPlan = { changed: [], visible: false }

// 多区间扫描可能两次进入同一个 OrderedList（列表横跨两个归并后仍不相邻区间的
// 间隙）：同一状态下两次遍历产出完全相同的变更，按 marker 起点去重 —— 否则
// ChangeSet.of 会把同一改写静默应用两遍，在文档里写出 "2.2." 之类的叠加标记。
export function dedupeMarkChanges(changes: readonly OrderedMarkChange[]): OrderedMarkChange[] {
  const seen = new Set<number>()
  return changes.filter(change => {
    if (seen.has(change.from)) return false
    seen.add(change.from)
    return true
  })
}

export const orderedRenumber = ViewPlugin.fromClass(class {
  private isDestroyed = false
  // Latched by the user's first document change: from then on, a pass over a complete syntax tree
  // is a follow-up to that edit rather than part of entering live preview.
  private hasUserDocChange = false
  // 构造入场扫描即可见窗口扫描（安全模式）；非安全模式下 apply 走全树，计划仅为
  // 记录 —— 开关运行中切换（desktop 切 tab）时 apply 侧按读取时点的开关决定扫描
  // 范围，计划始终完整，切换不丢待扫区间。
  private scanPlan: RenumberScanPlan = { changed: [], visible: true }

  constructor(readonly view: EditorView) {
    queueMicrotask(() => this.apply())
  }

  update(update: ViewUpdate) {
    if (this.isDestroyed) return
    if (update.transactions.some(tr => tr.annotation(orderedRenumberAnn))) return
    const treeChanged = syntaxTree(update.state) !== syntaxTree(update.startState)
    if (!update.docChanged && !treeChanged) return
    if (update.docChanged) this.hasUserDocChange = true
    this.recordScan(update, treeChanged)
    queueMicrotask(() => this.apply())
  }

  destroy() {
    this.isDestroyed = true
  }

  // 记录本趟扫描计划：docChanged 记变更区间（update.changes 已复合为
  // startState→state，旧区间先映射再合并）；树增长置 visible（入场语义）。
  // 记录本身不改变非安全模式的行为 —— apply 在开关关闭时忽略计划走全树扫描。
  private recordScan(update: ViewUpdate, treeChanged: boolean) {
    if (update.docChanged) {
      const captured: OrderedRenumberRange[] = []
      update.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
        captured.push({ from: fromB, to: toB })
      })
      this.scanPlan = {
        changed: mergeRenumberRanges([
          ...this.scanPlan.changed.map(range => mapRenumberRange(range, update.changes)),
          ...captured,
        ]),
        visible: this.scanPlan.visible || treeChanged,
      }
    } else if (treeChanged) {
      this.scanPlan = { changed: this.scanPlan.changed, visible: true }
    }
  }

  private apply() {
    // composing 期间跳过但保留计划：组合输入是暂态，结束后下一笔 update 重新入队，
    // 组合期间累积的变更区间仍会被消费。
    if (this.isDestroyed || this.view.composing) return
    const state = this.view.state
    const scanRanges = this.consumeScanRanges()
    // 拒绝后的抑制无解除路径：排队中的扫描计划已随上面一行一并作废，变更区间不会
    // 在后续每笔编辑的坐标映射中无限累积。
    if (state.field(orderedNormalizationState, false)?.suppressed) return
    const changes = scanRanges === null
      ? orderedRenumberChanges(state)
      : dedupeMarkChanges(scanRanges.flatMap(range => orderedRenumberChanges(state, range)))
    if (changes.length === 0) return
    const trigger = normalizationTrigger(
      this.hasUserDocChange,
      syntaxTree(state).length,
      state.doc.length,
    )
    this.view.dispatch(buildOrderedNormalizationTransaction(state, trigger, changes))
  }

  // 取走并清空本趟扫描区间。非安全模式返回 null —— apply 走全树扫描，与既有行为
  // 完全一致；空计划（冗余微任务/已作废）返回空数组即无事可做。安全模式：可见
  // 锚点在读取时点取最新 visibleRanges（滚动后微任务拿到的是新视口），与变更区间
  // 一并外扩 RENUMBER_SCAN_MARGIN_CHARS、钳制到文档范围后归并。
  private consumeScanRanges(): OrderedRenumberRange[] | null {
    const plan = this.scanPlan
    this.scanPlan = EMPTY_SCAN_PLAN
    if (!safeModeRenderingEnabled()) return null
    const anchors = plan.visible ? visibleScanAnchors(this.view) : []
    const length = this.view.state.doc.length
    return mergeRenumberRanges([...anchors, ...plan.changed].map(range => ({
      from: Math.max(0, range.from - RENUMBER_SCAN_MARGIN_CHARS),
      to: Math.min(length, range.to + RENUMBER_SCAN_MARGIN_CHARS),
    })))
  }
})
