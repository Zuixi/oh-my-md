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
import { editorPerformancePolicy } from "../performancePolicy"
import { suppressOrderedRenumberForTableEdit, isTableSessionRestore } from "../tables/directEdit"
import { mergeRanges } from "../decorations/ranges"

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

export function collectOrderedListLabels(
  list: SyntaxNode,
  state: EditorState,
): ReadonlyMap<number, string> {
  const labels = new Map<number, string>()
  forEachOrderedMark(list, state, (mark, _raw, expected) => {
    labels.set(mark.from, expected)
  })
  return labels
}

export function orderedLabel(mark: SyntaxNode, state: EditorState): string | null {
  const list = mark.parent?.parent
  if (list?.name !== "OrderedList") return null
  return collectOrderedListLabels(list, state).get(mark.from) ?? null
}

// Preview-entry / parse-progress and legacy safe-mode scan radius: visible anchors and changed
// ranges widen by 100_000 chars per side (same order as LIVE_WINDOW_CHARS, 262_144 — a renumber
// scan only looks for OrderedList nodes). Stale lists farther out wait until they scroll into the
// window or the user edits next to them; that safe-mode trade-off also keeps notices windowed.
export const RENUMBER_SCAN_MARGIN_CHARS = 100_000

// Steady-state user edit: only lists next to the edit need repair. Scanning 100k — or the whole
// tree — per keystroke to find a distant stale list is pure waste, since that list is off screen
// anyway. 2k covers the visible lists and "new item typed into a long list", because an
// intersecting list is always renumbered as a whole.
export const STEADY_EDIT_SCAN_MARGIN_CHARS = 2_048

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

// Visible anchors: CM's half-open [from, to) endpoints participate as positions unchanged (unlike
// buildDriver.visibleRegions, which closes them to [from, to-1]); an empty viewport falls back to
// the caret, because the type contract does not promise a non-empty list.
function visibleScanAnchors(view: EditorView): OrderedRenumberRange[] {
  const ranges = view.visibleRanges
  if (ranges.length > 0) return ranges.map(range => ({ from: range.from, to: range.to }))
  const head = view.state.selection.main.head
  return [{ from: head, to: head }]
}

// Scan ranges map through document changes: updates arriving before the microtask `apply` must map
// the previous ranges to the newest coordinates. The margin (100k entry/safe mode, 2k steady)
// absorbs the ±1 assoc difference at an adjacent insertion.
function mapRenumberRange(range: OrderedRenumberRange, changes: ChangeDesc): OrderedRenumberRange {
  return {
    from: changes.mapPos(range.from, MAP_FROM_ASSOC),
    to: changes.mapPos(range.to, MAP_TO_ASSOC),
  }
}

// Plan for the next scan, consumed by the microtask `apply`: `changed` holds the docChanged
// ranges (already mapped to the newest state); `visible` marks a preview-entry or tree-growth
// pass, which scans the visible window (windowed) or the whole tree. Updates arriving before the
// microtask accumulate into one plan (changed ranges mapped and merged, `visible` only latched).
interface RenumberScanPlan {
  changed: OrderedRenumberRange[]
  visible: boolean
}

const EMPTY_SCAN_PLAN: RenumberScanPlan = { changed: [], visible: false }

// Multiple ranges can enter the same OrderedList (a list spanning the gap between two ranges that
// are still not adjacent): both visits see the same state and produce identical changes, so key by
// marker start — otherwise ChangeSet.of applies the same rewrite twice ("2.2." markers).
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
  // One queued apply per tick: a burst of keystrokes between two microtask checkpoints records
  // into the same scan plan and must not queue one full pass each.
  private microtaskScheduled = false
  // The constructor queues the preview-entry pass as a visible-window scan (safe mode); with the
  // switch off, `apply` ignores the plan and scans the whole tree. The plan is always complete
  // anyway, so flipping the switch mid-session (desktop tab switch) cannot drop pending ranges.
  private scanPlan: RenumberScanPlan = { changed: [], visible: true }

  constructor(readonly view: EditorView) {
    this.scheduleApply()
  }

  update(update: ViewUpdate) {
    if (this.isDestroyed) return
    if (update.transactions.some(tr => tr.annotation(orderedRenumberAnn))) return
    // A direct table edit (and its undo/redo replay) must not trigger renumbering: the replay
    // transaction only carries history effects, the suppression annotation stays on the input.
    if (update.transactions.some(tr => tr.docChanged && (
      tr.annotation(suppressOrderedRenumberForTableEdit)
      || tr.effects.some(isTableSessionRestore)
    ))) return
    // A doc change usually rebuilds the syntax tree, so `treeChanged` alone says nothing about
    // whether the renumberer has to look beyond the edit (see `recordScan`).
    const treeChanged = syntaxTree(update.state) !== syntaxTree(update.startState)
    if (!update.docChanged && !treeChanged) return
    if (update.docChanged) this.hasUserDocChange = true
    this.recordScan(update, treeChanged)
    this.scheduleApply()
  }

  destroy() {
    this.isDestroyed = true
  }

  /** Queues one apply per tick (see `microtaskScheduled`); a destroyed plugin stops scheduling. */
  private scheduleApply() {
    if (this.microtaskScheduled || this.isDestroyed) return
    this.microtaskScheduled = true
    queueMicrotask(() => {
      this.microtaskScheduled = false
      this.apply()
    })
  }

  // Records this pass's scan plan: a docChanged update contributes its changed ranges (mapped
  // from the previous plan, then merged); a latched `visible` means preview entry (constructor),
  // or background parse progress. Progress is a shrinking unparsed tail — only text the previous
  // pass never saw can hold newly numbered lists, while a user edit usually truncates the tree at
  // the change and grows that tail. Counting the latter as growth would make every keystroke an
  // entry-wide scan.
  private recordScan(update: ViewUpdate, treeChanged: boolean) {
    const unparsed = (state: EditorState) => state.doc.length - syntaxTree(state).length
    const grew = treeChanged && unparsed(update.startState) > unparsed(update.state)
    const captured: OrderedRenumberRange[] = []
    update.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
      captured.push({ from: fromB, to: toB })
    })
    this.scanPlan = {
      changed: mergeRanges([
        ...this.scanPlan.changed.map(range => mapRenumberRange(range, update.changes)),
        ...captured,
      ]),
      visible: this.scanPlan.visible || grew,
    }
  }

  private apply() {
    // Composing input is transient: skip the pass but keep the plan, so the next update after
    // composition ends re-queues and still consumes the ranges accumulated meanwhile.
    if (this.isDestroyed || this.view.composing) return
    const state = this.view.state
    // A read-only document (HUGE-tier live preview) must not be rewritten programmatically: stale
    // markers stay as typed, with no normalization transaction and no pending notice.
    if (state.readOnly) return
    const scanRanges = this.consumeScanRanges()
    // Suppression after a reject has no release path; the plan was already discarded above, so the
    // changed ranges cannot accumulate through coordinate mapping on every later edit.
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

  // Takes and clears this pass's scan ranges. Preview entry and parse progress (`visible`) return
  // null without windowing (whole-tree scan, unchanged behavior) and otherwise use the visible
  // anchors plus the changed ranges widened by RENUMBER_SCAN_MARGIN_CHARS. A steady-state edit
  // only widens its own changed ranges by `steadyScanMarginChars`. An empty plan means nothing was
  // recorded since the last pass, so it returns no ranges to scan.
  private consumeScanRanges(): OrderedRenumberRange[] | null {
    const plan = this.scanPlan
    this.scanPlan = EMPTY_SCAN_PLAN
    const state = this.view.state
    if (plan.visible) {
      if (!this.windowed(state)) return null
      return this.expandScanRanges(
        [...visibleScanAnchors(this.view), ...plan.changed],
        RENUMBER_SCAN_MARGIN_CHARS,
      )
    }
    if (plan.changed.length === 0) return []
    return this.expandScanRanges(plan.changed, this.steadyScanMarginChars(state))
  }

  private expandScanRanges(
    ranges: readonly OrderedRenumberRange[],
    margin: number,
  ): OrderedRenumberRange[] {
    const length = this.view.state.doc.length
    return mergeRanges(ranges.map(range => ({
      from: Math.max(0, range.from - margin),
      to: Math.min(length, range.to + margin),
    })))
  }

  // The legacy global safe mode (no per-view policy) keeps the 100k safety margin; every other
  // steady path narrows to the edit neighborhood. orderedRenumberSafeMode.test.ts pins the former.
  private steadyScanMarginChars(state: EditorState): number {
    const policy = editorPerformancePolicy(state)
    return this.windowed(state) && policy?.liveWindowChars === undefined
      ? RENUMBER_SCAN_MARGIN_CHARS
      : STEADY_EDIT_SCAN_MARGIN_CHARS
  }

  private windowed(state: EditorState = this.view.state): boolean {
    const policy = editorPerformancePolicy(state)
    return policy ? policy.windowLiveDecorations : safeModeRenderingEnabled()
  }
})
