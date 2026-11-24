/**
 * Decoration-spec list algebra: the ordering, per-change mapping, dirty-range
 * partition, and sorted merge behind `updateLiveDecorations`.
 *
 * A 353 KB formatted document carries ~57 600 specs, so every op here is
 * written for O(n) passes with no per-spec string keys: mapping short-circuits
 * the untouched prefix/suffix, the partition uses a monotonic cursor over the
 * removal ranges, dedup binary-searches the retained list, and the final merge
 * is a two-pointer walk instead of a comparator sort.
 */

import type { ChangeDesc } from "@codemirror/state"
import type { DecoSpec } from "./types"
import { specKept, type RebuildRange } from "./ranges"

/**
 * Total order of a spec list: position first, then tag. The tag comparison uses
 * the `<`/`>` code-unit order rather than `localeCompare`, which is an order of
 * magnitude slower and locale-dependent — the list order is an internal
 * invariant, not human-facing text.
 */
export function compareDecoSpecs(a: DecoSpec, b: DecoSpec): number {
  return a.from - b.from || a.to - b.to || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0)
}

/** Sorted copy in `compareDecoSpecs` order (the input is left untouched). */
export function sortDecoSpecs(specs: readonly DecoSpec[]): DecoSpec[] {
  return [...specs].sort(compareDecoSpecs)
}

// CodeMirror's `RangeSet.map` drops a non-point range when it collapses and
// `startSide > 0 && endSide <= 0` (marks and non-block replaces; line
// decorations use side -200000000 and survive as points). Read the sides from
// the decoration itself rather than inferring them from the tag string.
export function dropsWhenCollapsed(spec: DecoSpec): boolean {
  return spec.deco.startSide > 0 && spec.deco.endSide <= 0
}

/** Maps one spec through a change set; `null` when CodeMirror would drop it. */
export function mapDecoSpec(spec: DecoSpec, changes: ChangeDesc): DecoSpec | null {
  if (spec.from === spec.to) {
    const pos = changes.mapPos(spec.from, 1)
    return { ...spec, from: pos, to: pos }
  }
  const from = changes.mapPos(spec.from, 1)
  const to = changes.mapPos(spec.to, -1)
  if (from > to) return null
  // Mirror that drop rule here so the spec list never counts ranges the
  // RangeSet has dropped, and a later rebuild never feeds `Decoration.range`
  // an empty mark/replace.
  if (from === to && dropsWhenCollapsed(spec)) return null
  return { ...spec, from, to }
}

// Mirrors each decoration's own `range(from, to)` check for an empty range:
// `MarkDecoration` always rejects one, `PointDecoration` rejects a replace with
// non-inclusive sides but accepts a widget, and `LineDecoration` accepts it.
// `point`/`isReplace` are CodeMirror internals; treat an unknown shape as the
// conservative (reject) case. A representable empty spec must not block a repair.
export function unrepresentableAtPoint(spec: DecoSpec): boolean {
  if (spec.from !== spec.to) return false
  const deco = spec.deco as { point?: boolean; isReplace?: boolean }
  if (deco.point !== true) return true
  return deco.isReplace === true && dropsWhenCollapsed(spec)
}

/**
 * Maps a position-sorted spec list through `changes` in one linear pass.
 *
 * Only specs straddling a changed range need `ChangeDesc.mapPos` calls; specs
 * strictly before the first change cannot move, and specs strictly after the
 * last change shift by the same net delta (no object clone when delta is 0).
 * The three runs stay individually sorted, so the result is a merge of sorted
 * runs rather than a full comparator sort.
 */
export function mapSpecsFast(
  specs: readonly DecoSpec[],
  changes: ChangeDesc,
  mapOne: (spec: DecoSpec, changes: ChangeDesc) => DecoSpec | null,
): DecoSpec[] {
  let firstFromA = Infinity
  let lastToA = -Infinity
  changes.iterChangedRanges((fromA, toA) => {
    if (fromA < firstFromA) firstFromA = fromA
    if (toA > lastToA) lastToA = toA
  })
  if (firstFromA === Infinity) return specs as DecoSpec[]
  const netDelta = changes.newLength - changes.length
  const prefix: DecoSpec[] = []
  const overlap: DecoSpec[] = []
  const suffix: DecoSpec[] = []
  for (const spec of specs) {
    if (spec.to < firstFromA) {
      prefix.push(spec)
    } else if (spec.from > lastToA) {
      suffix.push(netDelta === 0
        ? spec
        : { ...spec, from: spec.from + netDelta, to: spec.to + netDelta })
    } else {
      const mapped = mapOne(spec, changes)
      if (mapped !== null) overlap.push(mapped)
    }
  }
  if (overlap.length > 1) overlap.sort(compareDecoSpecs)
  // A spec crossing the first change start keeps its unmapped `from`, which can
  // sort before the last prefix spec, so the runs are merged (still linear)
  // rather than concatenated.
  return mergeSortedSpecs(mergeSortedSpecs(prefix, overlap), suffix)
}

/** Two-pointer merge of two `compareDecoSpecs`-sorted runs (left wins ties). */
export function mergeSortedSpecs(left: DecoSpec[], right: DecoSpec[]): DecoSpec[] {
  if (right.length === 0) return left
  if (left.length === 0) return right
  const out: DecoSpec[] = new Array(left.length + right.length)
  let i = 0
  let j = 0
  let k = 0
  while (i < left.length && j < right.length) {
    out[k++] = compareDecoSpecs(left[i], right[j]) <= 0 ? left[i++] : right[j++]
  }
  while (i < left.length) out[k++] = left[i++]
  while (j < right.length) out[k++] = right[j++]
  return out
}

/**
 * Membership of `spec` in the sorted `retained` list without allocating a key:
 * binary-search the first equal `from`, then scan the (short) run of specs that
 * start there for the same end and tag.
 */
export function retainedHasSpec(retained: readonly DecoSpec[], spec: DecoSpec): boolean {
  let low = 0
  let high = retained.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (retained[mid].from < spec.from) low = mid + 1
    else high = mid
  }
  for (let index = low; index < retained.length && retained[index].from === spec.from; index++) {
    if (retained[index].to === spec.to && retained[index].tag === spec.tag) return true
  }
  return false
}

export interface SpecPartition {
  /** Surviving specs in `compareDecoSpecs` order (input order preserved). */
  readonly retained: DecoSpec[]
  /** Removed specs keyed `tag:from:to`, for block-widget identity reuse. */
  readonly removed: Map<string, DecoSpec>
}

/**
 * Splits a mapped, position-sorted spec list in one pass: kept specs go to
 * `retained`, the rest are keyed for identity reuse. `removalRanges` and
 * `pruneWindows` are `mergeRanges` results, so the cursor over them only moves
 * forward as the (position-sorted) specs advance.
 */
export function partitionSpecs(
  specs: readonly DecoSpec[],
  removalRanges: readonly RebuildRange[],
  pruneWindows: readonly RebuildRange[],
): SpecPartition {
  const retained: DecoSpec[] = []
  const removed = new Map<string, DecoSpec>()
  let cursor = 0
  for (const spec of specs) {
    while (cursor < removalRanges.length && removalRanges[cursor].to < spec.from) cursor++
    if (specKept(spec.from, spec.to, removalRanges, pruneWindows, cursor)) {
      retained.push(spec)
      continue
    }
    removed.set(`${spec.tag}:${spec.from}:${spec.to}`, spec)
  }
  return { retained, removed }
}

export interface SpecUpdateInput {
  /** Specs of the previous field value, mapped into the new document. */
  readonly mapped: readonly DecoSpec[]
  /** Fresh specs collected for the dirty ranges (unsorted, may repeat). */
  readonly rebuilt: readonly DecoSpec[]
  /** Merged dirty ranges: every spec intersecting one is replaced by `rebuilt`. */
  readonly removalRanges: readonly RebuildRange[]
  /** Prune windows (empty = no windowing); see `specKept`. */
  readonly pruneWindows: readonly RebuildRange[]
  /** Keeps the old spec object when a rebuilt block widget is equivalent. */
  readonly reuse?: (dropped: DecoSpec, rebuilt: DecoSpec) => DecoSpec
}

export interface ReconcileResult {
  /** Full spec list for the next field value, in `compareDecoSpecs` order. */
  readonly specs: DecoSpec[]
  /** The rebuilt specs that entered the list (the ranges to add to RangeSets). */
  readonly additions: DecoSpec[]
}

/**
 * The spec list for an incremental update: retained specs plus the rebuilt ones
 * that are neither retained nor duplicated, deduplicated by (tag, from, to) and
 * merged in order. `additions` is the subset of `rebuilt` that is new, so the
 * caller feeds `RangeSet.update` exactly the ranges this list added.
 */
export function reconcileSpecs(input: SpecUpdateInput): ReconcileResult {
  const { retained, removed } = partitionSpecs(input.mapped, input.removalRanges, input.pruneWindows)
  const additions: DecoSpec[] = []
  const seen = new Set<string>()
  for (const spec of input.rebuilt) {
    if (retainedHasSpec(retained, spec)) continue
    const key = `${spec.tag}:${spec.from}:${spec.to}`
    if (seen.has(key)) continue
    seen.add(key)
    const dropped = removed.get(key)
    additions.push(dropped !== undefined && input.reuse ? input.reuse(dropped, spec) : spec)
  }
  if (additions.length > 1) additions.sort(compareDecoSpecs)
  return { specs: mergeSortedSpecs(retained, additions), additions }
}
