import { describe, expect, it } from "vitest"
import { ChangeSet } from "@codemirror/state"
import { Decoration, WidgetType } from "@codemirror/view"
import type { DecoSpec } from "../src/decorations/types"
import {
  compareDecoSpecs,
  mapDecoSpec,
  mapSpecsFast,
  mergeSortedSpecs,
  reconcileSpecs,
  retainedHasSpec,
  sortDecoSpecs,
} from "../src/decorations/specIndex"

const mark = (tag: string) => Decoration.mark({ class: tag })
const line = (tag: string) => Decoration.line({ class: tag })

class TestWidget extends WidgetType {
  constructor(readonly tag: string) { super() }
  eq(other: WidgetType) { return other instanceof TestWidget && other.tag === this.tag }
  toDOM() { return document.createElement("span") }
}

const widget = (tag: string) => Decoration.widget({ widget: new TestWidget(tag) })
const blockWidget = (tag: string) => Decoration.replace({ widget: new TestWidget(tag), block: true })

function spec(tag: string, from: number, to: number, deco = mark(tag)): DecoSpec {
  return { tag, from, to, deco }
}

const keys = (specs: readonly DecoSpec[]) => specs.map(s => `${s.tag}:${s.from}:${s.to}`)

/** Reference slow path: map every spec individually, then sort. */
function referenceMap(specs: readonly DecoSpec[], changes: ChangeSet): DecoSpec[] {
  const mapped: DecoSpec[] = []
  for (const item of specs) {
    const result = mapDecoSpec(item, changes)
    if (result !== null) mapped.push(result)
  }
  return sortDecoSpecs(mapped)
}

/** Deterministic PRNG so a failing case is reproducible from the seed. */
function mulberry32(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function randomSpecs(random: () => number, count: number, docLength: number): DecoSpec[] {
  const tags = ["line:omd-quote-1", "mark:strong", "replace:EmphasisMark", "widget:checkbox"]
  const specs: DecoSpec[] = []
  for (let index = 0; index < count; index++) {
    const from = Math.floor(random() * docLength)
    const to = random() < 0.2 ? from : Math.min(docLength, from + 1 + Math.floor(random() * 24))
    const tag = tags[Math.floor(random() * tags.length)]
    const deco = tag.startsWith("line:")
      ? line(tag)
      : tag.startsWith("widget:")
        ? widget(tag)
        : mark(tag)
    specs.push(spec(tag, from, to, deco))
  }
  return sortDecoSpecs(specs)
}

function randomChanges(random: () => number, docLength: number): ChangeSet {
  const changes: { from: number; to: number; insert: string }[] = []
  let cursor = Math.floor(random() * 20)
  while (cursor < docLength - 10) {
    const from = cursor
    const deleted = random() < 0.5 ? 0 : 1 + Math.floor(random() * 6)
    const to = Math.min(docLength, from + deleted)
    const insert = random() < 0.4 ? "" : "x".repeat(1 + Math.floor(random() * 4))
    changes.push({ from, to, insert })
    cursor = to + 1 + Math.floor(random() * 40)
  }
  if (changes.length === 0) changes.push({ from: 0, to: 0, insert: "x" })
  return ChangeSet.of(changes, docLength)
}

describe("mapSpecsFast equivalence", () => {
  it("returns the input array unchanged for an empty change set", () => {
    const specs = [spec("mark:strong", 5, 9)]
    const empty = ChangeSet.empty(10)
    expect(mapSpecsFast(specs, empty, mapDecoSpec)).toBe(specs)
  })

  it("matches the per-spec map + full sort for random edits (fixed seeds)", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const random = mulberry32(seed)
      const docLength = 200 + Math.floor(random() * 800)
      const specs = randomSpecs(random, 40 + Math.floor(random() * 80), docLength)
      const changes = randomChanges(random, docLength)
      expect(keys(mapSpecsFast(specs, changes, mapDecoSpec))).toEqual(keys(referenceMap(specs, changes)))
    }
  })

  it("leaves the untouched prefix uncloned and shifts the suffix without mapPos", () => {
    const before = spec("line:omd-quote-1", 2, 8, line("line:omd-quote-1"))
    const shifted = spec("mark:strong", 40, 50)
    const mapped = mapSpecsFast([before, shifted], ChangeSet.of({ from: 20, insert: "xx" }, 60), mapDecoSpec)
    expect(mapped[0]).toBe(before)
    expect(mapped[1]).not.toBe(shifted)
    expect(mapped[1].from).toBe(42)
    expect(mapped[1].to).toBe(52)
  })

  it("keeps suffix identity when an edit has net-zero delta", () => {
    const suffix = spec("mark:strong", 40, 50)
    const mapped = mapSpecsFast(
      [suffix],
      ChangeSet.of({ from: 20, to: 22, insert: "xx" }, 60),
      mapDecoSpec,
    )
    expect(mapped[0]).toBe(suffix)
  })

  it("re-sorts a spec that crosses the first change start ahead of an earlier point spec", () => {
    // A deletion at [10, 12) pulls the crossing mark's start back to 8, outside the
    // prefix run's tip (the point decoration at 9): a plain prefix+overlap
    // concatenation would leave the list unsorted.
    const point = spec("line:omd-quote-1", 9, 9, line("line:omd-quote-1"))
    const crossing = spec("mark:strong", 8, 20)
    const mapped = mapSpecsFast([crossing, point], ChangeSet.of({ from: 10, to: 12 }, 40), mapDecoSpec)
    expect(keys(mapped)).toEqual(["mark:strong:8:18", "line:omd-quote-1:9:9"])
    expect(keys(mapped)).toEqual(keys(referenceMap([crossing, point], ChangeSet.of({ from: 10, to: 12 }, 40))))
  })

  it("drops specs the RangeSet would drop (collapsed marks, inverted ranges)", () => {
    const collapsedMark = spec("mark:strong", 10, 14)
    const deleted = spec("mark:emphasis", 14, 20)
    // Deleting [10, 20) collapses the mark to a point (dropped) and removes the other.
    const changes = ChangeSet.of({ from: 10, to: 20 }, 40)
    expect(mapSpecsFast([collapsedMark, deleted], changes, mapDecoSpec)).toEqual([])
    // A line decoration survives collapsing to a point (side -200000000).
    const quote = spec("line:omd-quote-1", 10, 25, line("line:omd-quote-1"))
    expect(keys(mapSpecsFast([quote], ChangeSet.of({ from: 10, to: 25 }, 40), mapDecoSpec)))
      .toEqual(["line:omd-quote-1:10:10"])
  })
})

describe("sorted merge helpers", () => {
  it("orders by position then code-unit tag order", () => {
    const specs = sortDecoSpecs([
      spec("mark:b", 5, 6),
      spec("mark:a", 5, 6),
      spec("mark:a", 1, 9),
      spec("mark:a", 1, 2),
    ])
    expect(keys(specs)).toEqual(["mark:a:1:2", "mark:a:1:9", "mark:a:5:6", "mark:b:5:6"])
  })

  it("merges two sorted runs left-first on ties", () => {
    const left = [spec("mark:a", 1, 2)]
    const right = [spec("mark:a", 1, 2), spec("mark:b", 3, 4)]
    const merged = mergeSortedSpecs(left, right)
    expect(keys(merged)).toEqual(["mark:a:1:2", "mark:a:1:2", "mark:b:3:4"])
    expect(merged[0]).toBe(left[0])
    expect(merged[1]).toBe(right[0])
  })

  it("finds retained specs by position and tag without allocating keys", () => {
    const retained = sortDecoSpecs([
      spec("mark:a", 1, 2),
      spec("line:omd-quote-1", 5, 5, line("line:omd-quote-1")),
      spec("mark:b", 5, 9),
    ])
    expect(retainedHasSpec(retained, spec("mark:a", 1, 2))).toBe(true)
    expect(retainedHasSpec(retained, spec("mark:b", 5, 9))).toBe(true)
    expect(retainedHasSpec(retained, spec("mark:b", 5, 8))).toBe(false)
    expect(retainedHasSpec(retained, spec("mark:c", 5, 9))).toBe(false)
    expect(retainedHasSpec(retained, spec("mark:a", 0, 2))).toBe(false)
    expect(retainedHasSpec([], spec("mark:a", 1, 2))).toBe(false)
  })
})

describe("reconcileSpecs", () => {
  const removal = [{ from: 10, to: 20 }]

  it("retains untouched specs, excludes removed ones and dedupes rebuilt specs", () => {
    const kept = spec("mark:strong", 0, 5)
    const removed = spec("mark:strong", 12, 18)
    const rebuilt = [spec("mark:strong", 14, 18), spec("mark:strong", 14, 18), spec("mark:strong", 0, 5)]
    const result = reconcileSpecs({
      mapped: [kept, removed],
      rebuilt,
      removalRanges: removal,
      pruneWindows: [],
    })
    expect(keys(result.specs)).toEqual(["mark:strong:0:5", "mark:strong:14:18"])
    expect(keys(result.additions)).toEqual(["mark:strong:14:18"])
    expect(result.specs[0]).toBe(kept)
  })

  it("reuses the removed spec when the rebuild yields an equivalent widget", () => {
    const oldWidget = spec("widget:block:table", 10, 20, blockWidget("t"))
    const newWidget = spec("widget:block:table", 10, 20, blockWidget("t"))
    const result = reconcileSpecs({
      mapped: [oldWidget],
      rebuilt: [newWidget],
      removalRanges: removal,
      pruneWindows: [],
      reuse: (dropped, rebuiltSpec) => dropped.tag === rebuiltSpec.tag ? dropped : rebuiltSpec,
    })
    expect(result.additions[0]).toBe(oldWidget)
    expect(result.specs[0]).toBe(oldWidget)
  })

  it("prunes specs entirely outside every prune window and keeps the rest", () => {
    const inside = spec("mark:strong", 10, 14)
    const outside = spec("mark:strong", 40, 44)
    const result = reconcileSpecs({
      mapped: [inside, outside],
      rebuilt: [],
      removalRanges: [],
      pruneWindows: [{ from: 0, to: 30 }],
    })
    expect(keys(result.specs)).toEqual(["mark:strong:10:14"])
    expect(result.additions).toEqual([])
  })

  it("sorts candidates with the shared comparator", () => {
    expect(compareDecoSpecs(spec("a", 1, 2), spec("a", 1, 3))).toBeLessThan(0)
    expect(compareDecoSpecs(spec("a", 1, 2), spec("b", 1, 2))).toBeLessThan(0)
    expect(compareDecoSpecs(spec("a", 1, 2), spec("a", 1, 2))).toBe(0)
  })
})
