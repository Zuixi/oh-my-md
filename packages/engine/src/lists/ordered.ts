import type { SyntaxNode } from "@lezer/common"
import {
  Annotation,
  StateEffect,
  StateField,
  Transaction,
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

const recordNormalization = StateEffect.define<readonly ReversibleOrderedMarker[]>()
const resolveNormalization = StateEffect.define<{
  readonly id: NormalizationId
  readonly suppress: boolean
}>()

/** Marker positions in the document produced by `changes`, paired with the replaced text. */
function reversibleOrderedMarkers(
  state: EditorState,
  changes: readonly OrderedMarkChange[],
): readonly ReversibleOrderedMarker[] {
  const ordered = [...changes].sort((a, b) => a.from - b.from)
  let shift = 0
  return ordered.map(change => {
    const from = change.from + shift
    shift += change.insert.length - (change.to - change.from)
    return {
      from,
      to: from + change.insert.length,
      original: state.doc.sliceString(change.from, change.to),
      normalized: change.insert,
    }
  })
}

function mapPendingMarkers(
  value: OrderedNormalizationState,
  tr: Transaction,
): OrderedNormalizationState {
  if (!value.pending || !tr.docChanged) return value
  const markers = value.pending.markers.map(marker => ({
    ...marker,
    from: tr.changes.mapPos(marker.from, MAP_FROM_ASSOC),
    to: tr.changes.mapPos(marker.to, MAP_TO_ASSOC),
  }))
  return { ...value, pending: { ...value.pending, markers } }
}

function applyNormalizationEffect(
  value: OrderedNormalizationState,
  effect: StateEffect<unknown>,
): OrderedNormalizationState {
  if (effect.is(recordNormalization)) {
    if (value.suppressed || value.pending || effect.value.length === 0) return value
    const id = value.nextId as NormalizationId
    return { nextId: value.nextId + 1, pending: { id, markers: effect.value }, suppressed: false }
  }
  if (effect.is(resolveNormalization)) {
    if (value.pending?.id !== effect.value.id) return value
    return {
      nextId: value.nextId,
      pending: null,
      suppressed: value.suppressed || effect.value.suppress,
    }
  }
  return value
}

/**
 * Tracks the reversible preview-entry rewrite. Mounted outside the live-preview compartment so a
 * pending notice and its suppression survive Source/Live toggles.
 */
export const orderedNormalizationState = StateField.define<OrderedNormalizationState>({
  create: () => emptyNormalizationState,
  update: (value, tr) =>
    tr.effects.reduce(applyNormalizationEffect, mapPendingMarkers(value, tr)),
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

const orderedRenumberAnn = Annotation.define<boolean>()

export const orderedRenumber = ViewPlugin.fromClass(class {
  private isDestroyed = false
  // Only the first pass after entering live preview is reversible; later passes follow user edits.
  private isPreviewEntry = true

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
    const isPreviewEntry = this.isPreviewEntry
    this.isPreviewEntry = false
    const state = this.view.state
    if (state.field(orderedNormalizationState, false)?.suppressed) return
    const changes = orderedRenumberChanges(state)
    if (changes.length === 0) return
    this.view.dispatch({
      changes,
      effects: isPreviewEntry
        ? [recordNormalization.of(reversibleOrderedMarkers(state, changes))]
        : [],
      annotations: [orderedRenumberAnn.of(true), Transaction.addToHistory.of(false)],
    })
  }
})
