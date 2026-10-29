import { describe, expect, it } from "vitest"
import { Text } from "@codemirror/state"
import { createMatchCursor, type SearchRequest } from "../src/currentDocumentSearch"
import { startSearchCount, type SearchCount, type SearchScheduler } from "../src/searchCountJob"

const NEEDLE = "ab"
const MIB = 1024 * 1024
const WINDOW_LIMIT = 64 * 1024
const SPARSE_LINE_CHARS = 64 * 1024
const SPARSE_HIT_PERIOD = 16

function request(query: string, overrides: Partial<SearchRequest> = {}): SearchRequest {
  return {
    query,
    caseSensitive: false,
    regexp: false,
    wholeWord: false,
    revision: 0,
    ...overrides,
  }
}

function hitDoc(hits: number): Text {
  return Text.of([`${NEEDLE}xx`.repeat(hits)])
}

interface FakeScheduler extends SearchScheduler {
  clock(): number
  pending(): number
  cancelCalls(): number
  scheduleCalls(): number
  takeNext(): () => void
  runUntilIdle(limit?: number): number
}

function fakeScheduler(msPerNowCall = 1): FakeScheduler {
  const queue = new Map<number, () => void>()
  let clock = 0
  let nextId = 0
  let cancelCalls = 0
  let scheduleCalls = 0

  const take = (): (() => void) | undefined => {
    const first = queue.entries().next()
    if (first.done) return undefined
    queue.delete(first.value[0])
    return first.value[1]
  }

  return {
    now() {
      const value = clock
      clock += msPerNowCall
      return value
    },
    schedule(run) {
      scheduleCalls += 1
      const id = nextId
      nextId += 1
      queue.set(id, run)
      return () => {
        queue.delete(id)
        cancelCalls += 1
      }
    },
    clock: () => clock,
    pending: () => queue.size,
    cancelCalls: () => cancelCalls,
    scheduleCalls: () => scheduleCalls,
    takeNext() {
      const run = take()
      if (!run) throw new Error("no scheduled callback")
      return run
    },
    runUntilIdle(limit = 1000) {
      let runs = 0
      while (queue.size > 0 && runs < limit) {
        const run = take()
        if (!run) break
        run()
        runs += 1
      }
      return runs
    },
  }
}

interface TextCalls {
  stringify: number
  slices: (readonly [number, number])[]
  ranges: (readonly [number, number])[]
  iterCalls: number
}

function guardText(doc: Text): { doc: Text; calls: TextCalls } {
  const calls: TextCalls = { stringify: 0, slices: [], ranges: [], iterCalls: 0 }
  const guarded = new Proxy(doc, {
    get(target, property) {
      const value = Reflect.get(target, property, target)
      if (typeof value !== "function") return value
      if (property === "toString") {
        return () => {
          calls.stringify += 1
          return target.toString()
        }
      }
      if (property === "sliceString") {
        return (from: number, to: number, lineSep?: string) => {
          calls.slices.push([from, to])
          return target.sliceString(from, to, lineSep)
        }
      }
      if (property === "iterRange") {
        return (from: number, to?: number) => {
          calls.ranges.push([from, to ?? target.length])
          return target.iterRange(from, to)
        }
      }
      if (property === "iter") {
        return () => {
          calls.iterCalls += 1
          return target.iter()
        }
      }
      return value.bind(target)
    },
  })
  return { doc: guarded, calls }
}

function countWholeDocument(doc: Text, search: SearchRequest): number {
  const cursor = createMatchCursor(doc, search, 0, doc.length)
  let total = 0
  while (cursor.next() !== null) total += 1
  return total
}

function sparseHundredMib(): { readonly doc: Text; readonly hits: number } {
  const plain = "x".repeat(SPARSE_LINE_CHARS)
  const hit = `${NEEDLE}${"x".repeat(SPARSE_LINE_CHARS - NEEDLE.length)}`
  const lines: string[] = []
  let hits = 0
  for (let index = 0; index < (100 * MIB) / SPARSE_LINE_CHARS; index++) {
    const isHit = index % SPARSE_HIT_PERIOD === 0
    if (isHit) hits += 1
    lines.push(isHit ? hit : plain)
  }
  return { doc: Text.of(lines), hits }
}

function windowStarts(length: number, search: SearchRequest): readonly number[] {
  const { doc, calls } = guardText(Text.of(["x".repeat(length)]))
  const scheduler = fakeScheduler()
  startSearchCount(doc, search, scheduler, () => {}, { cap: 1_000_000 })
  scheduler.runUntilIdle()
  return calls.ranges.map(([from]) => from)
}

describe("startSearchCount", () => {
  it("yields after the slice budget instead of draining a dense document", () => {
    const published: SearchCount[] = []
    const scheduler = fakeScheduler()
    const job = startSearchCount(hitDoc(5000), request(NEEDLE), scheduler, (count) =>
      published.push(count),
    )

    expect(scheduler.scheduleCalls()).toBe(1)
    scheduler.takeNext()()

    expect(published).toEqual([])
    expect(scheduler.pending()).toBe(1)
    expect(scheduler.clock()).toBeGreaterThanOrEqual(4)

    expect(scheduler.runUntilIdle()).toBeGreaterThan(1)
    expect(published).toEqual([{ count: 5000, complete: true, revision: 0 }])
    expect(job.cancelled).toBe(false)
  })

  it("counts through the cursor without materializing the document", () => {
    const { doc, calls } = guardText(hitDoc(1200))
    const published: SearchCount[] = []
    const scheduler = fakeScheduler()
    const job = startSearchCount(doc, request(NEEDLE), scheduler, (count) => published.push(count))
    scheduler.runUntilIdle()

    expect(calls.stringify).toBe(0)
    expect(calls.slices.filter(([from, to]) => to - from >= doc.length)).toEqual([])
    expect(published).toHaveLength(1)
    expect(Object.keys(published[0])).toEqual(["count", "complete", "revision"])
    expect(Array.isArray(published[0])).toBe(false)
    expect(published[0].count).toBe(1200)
    expect(Object.keys(job).sort()).toEqual(["cancel", "cancelled"])
  })

  it("cancels the queued callback and never publishes even if it runs", () => {
    const published: SearchCount[] = []
    const scheduler = fakeScheduler()
    const job = startSearchCount(hitDoc(5000), request(NEEDLE), scheduler, (count) =>
      published.push(count),
    )
    const queued = scheduler.takeNext()

    expect(job.cancelled).toBe(false)
    job.cancel()
    expect(job.cancelled).toBe(true)
    expect(scheduler.cancelCalls()).toBe(1)

    queued()
    expect(published).toEqual([])

    job.cancel()
    expect(scheduler.cancelCalls()).toBe(1)
    expect(scheduler.pending()).toBe(0)
  })

  it("keeps a superseded job from publishing its stale revision", () => {
    const published: SearchCount[] = []
    const scheduler = fakeScheduler()
    const stale = startSearchCount(hitDoc(5000), request(NEEDLE, { revision: 1 }), scheduler, (count) =>
      published.push(count),
    )
    const fresh = startSearchCount(hitDoc(3), request(NEEDLE, { revision: 2 }), scheduler, (count) =>
      published.push(count),
    )

    stale.cancel()
    scheduler.runUntilIdle()

    expect(published).toEqual([{ count: 3, complete: true, revision: 2 }])
    expect(stale.cancelled).toBe(true)
    expect(fresh.cancelled).toBe(false)
  })

  it("caps dense counting at 10,000 and reports incomplete", () => {
    const published: SearchCount[] = []
    const scheduler = fakeScheduler()
    const job = startSearchCount(hitDoc(20_000), request(NEEDLE, { revision: 3 }), scheduler, (count) =>
      published.push(count),
    )

    expect(scheduler.runUntilIdle()).toBeGreaterThan(1)
    expect(published).toEqual([{ count: 10_000, complete: false, revision: 3 }])
    expect(scheduler.pending()).toBe(0)
    expect(job.cancelled).toBe(false)
  })

  it("honours an explicit display cap", () => {
    const published: SearchCount[] = []
    const scheduler = fakeScheduler()
    startSearchCount(hitDoc(100), request(NEEDLE), scheduler, (count) => published.push(count), {
      cap: 25,
    })
    scheduler.runUntilIdle()

    expect(published).toEqual([{ count: 25, complete: false, revision: 0 }])
  })

  it("reports the exact complete count and request revision for sparse input", () => {
    const published: SearchCount[] = []
    const scheduler = fakeScheduler()
    startSearchCount(hitDoc(7), request(NEEDLE, { revision: 5 }), scheduler, (count) =>
      published.push(count),
    )
    scheduler.runUntilIdle()

    expect(published).toEqual([{ count: 7, complete: true, revision: 5 }])
  })

  it("finishes empty and invalid requests after one callback without rescheduling", () => {
    for (const query of [request(""), request("(", { regexp: true })]) {
      const published: SearchCount[] = []
      const scheduler = fakeScheduler()
      const job = startSearchCount(hitDoc(10), query, scheduler, (count) => published.push(count))

      expect(scheduler.runUntilIdle()).toBe(1)
      expect(scheduler.scheduleCalls()).toBe(1)
      expect(published).toEqual([{ count: 0, complete: true, revision: query.revision }])
      expect(job.cancelled).toBe(false)
    }
  })

  it("defaults to a 4 ms slice and honours an explicit sliceMs", () => {
    const fastScheduler = fakeScheduler()
    const fast: SearchCount[] = []
    startSearchCount(hitDoc(128), request(NEEDLE), fastScheduler, (count) => fast.push(count))

    const slowScheduler = fakeScheduler()
    const slow: SearchCount[] = []
    startSearchCount(hitDoc(128), request(NEEDLE), slowScheduler, (count) => slow.push(count), {
      sliceMs: 1,
    })

    expect(fastScheduler.runUntilIdle()).toBe(1)
    expect(slowScheduler.runUntilIdle()).toBeGreaterThan(1)
    expect(slow).toEqual(fast)
    expect(fast).toEqual([{ count: 128, complete: true, revision: 0 }])
  })

  it("does not publish twice when a finished callback runs again", () => {
    const published: SearchCount[] = []
    const scheduler = fakeScheduler()
    startSearchCount(hitDoc(3), request(NEEDLE), scheduler, (count) => published.push(count))

    const run = scheduler.takeNext()
    run()
    run()

    expect(published).toEqual([{ count: 3, complete: true, revision: 0 }])
    expect(scheduler.pending()).toBe(0)
  })

  it("bounds every count callback on a sparse 100 MiB literal search", () => {
    const { doc: source, hits } = sparseHundredMib()
    const { doc, calls } = guardText(source)
    const published: SearchCount[] = []
    const scheduler = fakeScheduler()
    startSearchCount(
      doc,
      request(NEEDLE, { caseSensitive: true, revision: 7 }),
      scheduler,
      (count) => published.push(count),
      { cap: 1_000_000 },
    )

    const windowsPerCallback: number[] = []
    const elapsedPerCallback: number[] = []
    let seen = 0
    while (scheduler.pending() > 0 && windowsPerCallback.length < 50_000) {
      const started = scheduler.clock()
      scheduler.takeNext()()
      elapsedPerCallback.push(scheduler.clock() - started)
      windowsPerCallback.push(calls.ranges.length - seen)
      seen = calls.ranges.length
    }

    expect(published).toEqual([{ count: hits, complete: true, revision: 7 }])
    expect(calls.stringify).toBe(0)
    expect(windowsPerCallback.length).toBeGreaterThan(100)
    expect(calls.ranges.length).toBeGreaterThan(100)
    expect(Math.max(...windowsPerCallback)).toBeLessThanOrEqual(5)
    expect(Math.max(...elapsedPerCallback)).toBeLessThanOrEqual(5)
    expect(calls.ranges.filter(([from, to]) => to - from > WINDOW_LIMIT + NEEDLE.length)).toEqual([])
    expect(calls.ranges[0][0]).toBe(0)
    expect(calls.ranges[calls.ranges.length - 1][1]).toBe(source.length)
    for (let index = 1; index < calls.ranges.length; index++) {
      expect(calls.ranges[index][0]).toBe(calls.ranges[index - 1][1] - NEEDLE.length)
    }
  }, 60_000)

  it("counts hits exactly once at every window boundary", () => {
    const length = 200_000
    const search = request(NEEDLE, { caseSensitive: true })
    const starts = windowStarts(length, search).slice(1)
    expect(starts.length).toBeGreaterThanOrEqual(4)

    const offsets = [-NEEDLE.length, -1, 0, 1]
    const kept: number[] = []
    for (const [index, start] of starts.entries()) {
      const position = start + offsets[index % offsets.length]
      const previous = kept[kept.length - 1]
      if (position < 0 || position + NEEDLE.length > length) continue
      if (previous !== undefined && position - previous < NEEDLE.length) continue
      kept.push(position)
    }

    const chars = new Array<string>(length).fill("x")
    for (const position of kept) {
      chars[position] = "a"
      chars[position + 1] = "b"
    }
    const source = Text.of([chars.join("")])
    const expected = countWholeDocument(source, search)
    expect(kept.length).toBeGreaterThanOrEqual(4)
    expect(expected).toBe(kept.length)

    const published: SearchCount[] = []
    const scheduler = fakeScheduler()
    startSearchCount(source, search, scheduler, (count) => published.push(count), {
      cap: 1_000_000,
    })
    scheduler.runUntilIdle()

    expect(published).toEqual([{ count: expected, complete: true, revision: 0 }])
  })

  it("matches full-document non-overlapping counts for self-overlapping queries and NFKD ligatures across window boundaries", () => {
    const boundary = 16 * 1024
    const chars = new Array<string>(boundary * 3).fill("x")
    // "aaa" straddling boundary 1 (16383..16385) -> 1 match for "aa";
    // "aaaa" straddling boundary 2 (32767..32770) -> 2 matches for "aa".
    chars[boundary - 1] = "a"
    chars[boundary] = "a"
    chars[boundary + 1] = "a"
    chars[boundary * 2 - 1] = "a"
    chars[boundary * 2] = "a"
    chars[boundary * 2 + 1] = "a"
    chars[boundary * 2 + 2] = "a"
    const overlapDoc = Text.of([chars.join("")])
    const aaQuery = request("aa", { caseSensitive: true })
    const publishedAa: SearchCount[] = []
    const schedulerAa = fakeScheduler()
    startSearchCount(overlapDoc, aaQuery, schedulerAa, count => publishedAa.push(count))
    schedulerAa.runUntilIdle()
    expect(publishedAa[0]?.count).toBe(countWholeDocument(overlapDoc, aaQuery))
    expect(publishedAa[0]?.count).toBe(3)

    // Precomposed ligature "\uFB03" ("ﬃ", length 1, NFKD "ffi" length 3) matching "ffi" across 16 KiB boundary.
    const ligatureChars = new Array<string>(boundary * 2).fill("x")
    ligatureChars[boundary - 1] = "f"
    ligatureChars[boundary] = "f"
    ligatureChars[boundary + 1] = "i"
    const ligatureDoc = Text.of([ligatureChars.join("")])
    const ligatureQuery = request("\uFB03", { caseSensitive: true })
    const publishedLigature: SearchCount[] = []
    const schedulerLigature = fakeScheduler()
    startSearchCount(ligatureDoc, ligatureQuery, schedulerLigature, count => publishedLigature.push(count))
    schedulerLigature.runUntilIdle()
    expect(publishedLigature[0]?.count).toBe(countWholeDocument(ligatureDoc, ligatureQuery))
    expect(publishedLigature[0]?.count).toBe(1)
  })

  it("keeps regex counting on the single unwindowed cursor", () => {
    const source = Text.of([`${NEEDLE}x`.repeat(40_000)])
    const { doc, calls } = guardText(source)
    const published: SearchCount[] = []
    const scheduler = fakeScheduler()
    startSearchCount(
      doc,
      request(`${NEEDLE}(?=x)`, { regexp: true }),
      scheduler,
      (count) => published.push(count),
      { cap: 1_000_000 },
    )
    scheduler.runUntilIdle()

    expect(source.length).toBeGreaterThan(WINDOW_LIMIT)
    expect(calls.ranges).toEqual([])
    expect(calls.iterCalls).toBe(1)
    expect(published).toEqual([{ count: 40_000, complete: true, revision: 0 }])
  })
})
