/**
 * Closed-interval algebra shared by the live-decoration field and its build
 * driver: `LiveDeco.pending`, dirty/removal ranges, prune windows, and the
 * build windows derived from the viewport. One owner for `mergeRanges`
 * (ordering + adjacency normalization) and for the intersection predicate the
 * spec partition and `RangeSet.update({ filter })` must agree on.
 */

/** Closed range `from <= to` (point ranges are legal, e.g. an emptied pending slice). */
export interface RebuildRange { from: number; to: number }

// 有序不相交化（from 升序、相邻区间 from <= prev.to + 1 合并）：种子 pending
// 归一化、docChanged 映射、窗口裁剪归还、驱动（buildDriver）窗口区域计算共用。
export function mergeRanges(ranges: RebuildRange[]): RebuildRange[] {
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
export function subtractRanges(ranges: RebuildRange[], removals: RebuildRange[]): RebuildRange[] {
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

// expandRange uses endLine.to + 1 as an exclusive end (the next line's from).
// A closed overlap would drop point decorations sitting exactly at that boundary
// (the next line's omd-blockquote-N / QuoteMark) without the inner Blockquote
// being visited again, so the following quote line loses its bar.
export function intersects(from: number, to: number, range: RebuildRange): boolean {
  if (range.from === range.to) return from <= range.to && to >= range.from
  return from < range.to && to >= range.from
}

/**
 * Whether any range in a `mergeRanges` result intersects `[from, to]`. `start`
 * is a monotonic cursor: the caller may pass the first index whose `to` can
 * still reach `from` (specs sorted by position make that cursor non-decreasing).
 */
export function intersectsAny(
  from: number,
  to: number,
  ranges: readonly RebuildRange[],
  start = 0,
): boolean {
  for (let index = start; index < ranges.length; index++) {
    const range = ranges[index]
    if (range.from > to) return false
    if (range.to < from) continue
    if (intersects(from, to, range)) return true
  }
  return false
}

/** 闭区间 [from, to] 是否完全落在所有窗口区域之外（与任一区域相交即算窗口内）。 */
export function outsideAllRegions(
  from: number,
  to: number,
  regions: readonly RebuildRange[],
): boolean {
  for (const region of regions) {
    if (from <= region.to && to >= region.from) return false
  }
  return true
}

/**
 * The single keep predicate behind both the spec partition and
 * `RangeSet.update({ filter })`: kept = inside every prune window (when
 * pruning) and not overlapped by a dirty removal range. `removalStart` is the
 * partition's monotonic cursor over the sorted removal list.
 */
export function specKept(
  from: number,
  to: number,
  removalRanges: readonly RebuildRange[],
  pruneWindows: readonly RebuildRange[],
  removalStart = 0,
): boolean {
  if (pruneWindows.length > 0 && outsideAllRegions(from, to, pruneWindows)) return false
  return !intersectsAny(from, to, removalRanges, removalStart)
}
