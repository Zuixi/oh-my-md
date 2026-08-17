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

export const orderedRenumber = ViewPlugin.fromClass(class {
  private isDestroyed = false
  // Latched by the user's first document change: from then on, a pass over a complete syntax tree
  // is a follow-up to that edit rather than part of entering live preview.
  private hasUserDocChange = false

  constructor(readonly view: EditorView) {
    queueMicrotask(() => this.apply())
  }

  update(update: ViewUpdate) {
    if (this.isDestroyed) return
    if (update.transactions.some(tr => tr.annotation(orderedRenumberAnn))) return
    const treeChanged = syntaxTree(update.state) !== syntaxTree(update.startState)
    if (!update.docChanged && !treeChanged) return
    if (update.docChanged) this.hasUserDocChange = true
    queueMicrotask(() => this.apply())
  }

  destroy() {
    this.isDestroyed = true
  }

  private apply() {
    if (this.isDestroyed || this.view.composing) return
    const state = this.view.state
    if (state.field(orderedNormalizationState, false)?.suppressed) return
    const changes = orderedRenumberChanges(state)
    if (changes.length === 0) return
    const trigger = normalizationTrigger(
      this.hasUserDocChange,
      syntaxTree(state).length,
      state.doc.length,
    )
    this.view.dispatch(buildOrderedNormalizationTransaction(state, trigger, changes))
  }
})
