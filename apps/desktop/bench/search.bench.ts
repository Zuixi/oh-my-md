import { performance } from "node:perf_hooks"
import { bench, describe } from "vitest"
import type { Text } from "@codemirror/state"
import { buildSearchFixture, type SearchFixture, type SearchFixtureName } from "./searchFixtures"
import {
  buildReplaceAll,
  findNextMatch,
  findPreviousMatch,
  type SearchMatch,
  type SearchRequest,
} from "../src/currentDocumentSearch"
import { startSearchCount, type SearchCount, type SearchScheduler } from "../src/searchCountJob"

const NEEDLE = "needle"
const MIB = 1024 * 1024
const WARMUP = 5
const SAMPLES = 30
const SLICE_MS = 4
const DISPLAY_CAP = 10_000
const SLICE_BUDGET_MS = 12
const NEXT_HIT_P95_LIMIT_MS = 100
const NEXT_HIT_GATE_DISTANCE = MIB
const GATED_SCENARIOS = 3
const REPLACEMENT = "REPLACED"

interface Latency {
  readonly n: number
  readonly p50: number
  readonly p95: number
  readonly peak: number
}

interface GuardCounters {
  readonly stringifyCalls: number
  readonly wholeDocumentSliceCalls: number
  readonly largestSliceChars: number
  readonly iterRangeCalls: number
}

interface NextRow {
  readonly scenario: string
  readonly anchor: number
  readonly distanceChars: number
  readonly from: number
  readonly to: number
  readonly expectedFrom: number
  readonly matchesExpected: boolean
  readonly latency: Latency
}

interface PreviousRow {
  readonly anchor: number
  readonly distanceChars: number
  readonly from: number
  readonly to: number
  readonly expectedFrom: number
  readonly matchesExpected: boolean
  readonly cursorWindows: number
  readonly earliestSearchedOffset: number
  readonly initialWindowChars: number
  readonly latency: Latency
}

interface CountRow {
  readonly fixture: SearchFixtureName
  readonly cap: number
  readonly count: number
  readonly complete: boolean
  readonly completionMs: number
  readonly slices: number
  readonly worstSliceMs: number
  readonly sliceBudgetMs: number
  readonly withinSliceBudget: number
}

interface ManualScheduler extends SearchScheduler {
  take(): (() => void) | null
}

const round = (value: number): number => Number(value.toFixed(3))

function latency(values: readonly number[]): Latency {
  const sorted = [...values].sort((left, right) => left - right)
  const at = (fraction: number): number => {
    const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)
    return sorted[Math.max(0, index)] ?? 0
  }
  return {
    n: sorted.length,
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    peak: round(sorted[sorted.length - 1] ?? 0),
  }
}

function request(query: string = NEEDLE): SearchRequest {
  return { query, caseSensitive: false, regexp: false, wholeWord: false, revision: 19 }
}

function guardText(doc: Text): {
  readonly doc: Text
  readonly counters: GuardCounters
  readonly ranges: (readonly [number, number])[]
} {
  const length = doc.length
  const counters = { stringifyCalls: 0, wholeDocumentSliceCalls: 0, largestSliceChars: 0, iterRangeCalls: 0 }
  const ranges: (readonly [number, number])[] = []
  const guarded = new Proxy(doc, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target)
      if (typeof value !== "function") return value
      if (property === "toString") {
        return () => {
          counters.stringifyCalls += 1
          return target.toString()
        }
      }
      if (property === "sliceString") {
        return (from: number, to: number, lineSep?: string) => {
          if (length > 0 && from === 0 && to === length) counters.wholeDocumentSliceCalls += 1
          counters.largestSliceChars = Math.max(counters.largestSliceChars, to - from)
          return target.sliceString(from, to, lineSep)
        }
      }
      if (property === "iterRange") {
        return (from: number, to?: number) => {
          counters.iterRangeCalls += 1
          ranges.push([from, to ?? length])
          return target.iterRange(from, to)
        }
      }
      return value.bind(target)
    },
  })
  return { doc: guarded, counters, ranges }
}

function manualScheduler(): ManualScheduler {
  let pending: (() => void) | null = null
  return {
    now: () => performance.now(),
    schedule(run) {
      pending = run
      return () => {
        pending = null
      }
    },
    take() {
      const run = pending
      pending = null
      return run
    },
  }
}

function buildTimed(name: SearchFixtureName): { readonly fixture: SearchFixture; readonly constructionMs: number } {
  const started = performance.now()
  const fixture = buildSearchFixture(name)
  return { fixture, constructionMs: round(performance.now() - started) }
}

function sampleNavigation(run: () => SearchMatch | null): { readonly latency: Latency; readonly from: number; readonly to: number } {
  for (let index = 0; index < WARMUP; index++) run()
  const values: number[] = []
  let from = -1
  let to = -1
  for (let index = 0; index < SAMPLES; index++) {
    const started = performance.now()
    const match = run()
    values.push(performance.now() - started)
    if (match) {
      from = match.from
      to = match.to
    }
  }
  return { latency: latency(values), from, to }
}

function measureNextFixture(fixture: SearchFixture): readonly NextRow[] {
  const offsets = fixture.expectedLiteralOffsets
  const lastHit = offsets[offsets.length - 1] ?? 0
  const scenarios: readonly { readonly scenario: string; readonly anchor: number; readonly expectedFrom: number }[] = [
    { scenario: "start", anchor: 0, expectedFrom: offsets[0] ?? 0 },
    { scenario: "middle", anchor: Math.floor(fixture.text.length / 2), expectedFrom: offsets[Math.floor(offsets.length / 2)] ?? 0 },
    { scenario: "end", anchor: lastHit - 1024, expectedFrom: lastHit },
    { scenario: "wrap", anchor: lastHit + NEEDLE.length, expectedFrom: offsets[0] ?? 0 },
  ]
  return scenarios.map(scenario => {
    const sampled = sampleNavigation(() => findNextMatch(fixture.text, request(), scenario.anchor))
    return {
      scenario: scenario.scenario,
      anchor: scenario.anchor,
      distanceChars: sampled.from - scenario.anchor,
      from: sampled.from,
      to: sampled.to,
      expectedFrom: scenario.expectedFrom,
      matchesExpected: sampled.from === scenario.expectedFrom && sampled.to === scenario.expectedFrom + NEEDLE.length,
      latency: sampled.latency,
    }
  })
}

function measurePreviousFixture(fixture: SearchFixture): PreviousRow {
  const offsets = fixture.expectedLiteralOffsets
  const expectedFrom = offsets[offsets.length - 1] ?? 0
  const anchor = fixture.text.length
  const guarded = guardText(fixture.text)
  const probe = findPreviousMatch(guarded.doc, request(), anchor)
  const earliestSearchedOffset =
    guarded.ranges.length === 0 ? anchor : Math.min(...guarded.ranges.map(range => range[0]))
  const sampled = sampleNavigation(() => findPreviousMatch(fixture.text, request(), anchor))
  return {
    anchor,
    distanceChars: sampled.from - anchor,
    from: sampled.from,
    to: sampled.to,
    expectedFrom,
    matchesExpected: sampled.from === expectedFrom && probe !== null,
    cursorWindows: guarded.ranges.length,
    earliestSearchedOffset,
    initialWindowChars: PREVIOUS_WINDOW_CHARS,
    latency: sampled.latency,
  }
}

function measureCount(doc: Text, fixture: SearchFixtureName, cap: number): CountRow {
  const scheduler = manualScheduler()
  const publishes: SearchCount[] = []
  const started = performance.now()
  startSearchCount(doc, request(), scheduler, published => publishes.push(published), { sliceMs: SLICE_MS, cap })
  const slices: number[] = []
  for (;;) {
    const run = scheduler.take()
    if (run === null) break
    const sliceStarted = performance.now()
    run()
    slices.push(performance.now() - sliceStarted)
  }
  const completionMs = performance.now() - started
  const last = publishes[publishes.length - 1]
  const worstSliceMs = round(Math.max(...slices, 0))
  return {
    fixture,
    cap,
    count: last?.count ?? 0,
    complete: last?.complete ?? false,
    completionMs: round(completionMs),
    slices: slices.length,
    worstSliceMs,
    sliceBudgetMs: SLICE_BUDGET_MS,
    withinSliceBudget: worstSliceMs <= SLICE_BUDGET_MS ? 1 : 0,
  }
}

function measureCancellation(doc: Text): {
  readonly cancellationMs: number
  readonly publishedBefore: number
  readonly publishedAfter: number
  readonly stalePublish: boolean
  readonly pendingCleared: boolean
  readonly cancelled: boolean
} {
  const scheduler = manualScheduler()
  const publishes: SearchCount[] = []
  const job = startSearchCount(doc, request(), scheduler, published => publishes.push(published), {
    sliceMs: SLICE_MS,
    cap: 10_000_000,
  })
  scheduler.take()?.()
  const publishedBefore = publishes.length
  const started = performance.now()
  job.cancel()
  const cancellationMs = performance.now() - started
  const leftover = scheduler.take()
  leftover?.()
  return {
    cancellationMs: round(cancellationMs),
    publishedBefore,
    publishedAfter: publishes.length,
    stalePublish: publishes.length !== publishedBefore,
    pendingCleared: leftover === null,
    cancelled: job.cancelled,
  }
}

function measureReplaceAll(fixture: SearchFixture): {
  readonly replacements: number
  readonly expectedReplacements: number
  readonly elapsedMs: number
  readonly originalUnchanged: boolean
  readonly originalHitIntact: boolean
} {
  const firstHit = fixture.expectedLiteralOffsets[0] ?? 0
  const lengthBefore = fixture.text.length
  const started = performance.now()
  const result = buildReplaceAll(fixture.text, request(), REPLACEMENT)
  const elapsedMs = performance.now() - started
  return {
    replacements: result?.replacements ?? 0,
    expectedReplacements: fixture.expectedLiteralCount,
    elapsedMs: round(elapsedMs),
    originalUnchanged: fixture.text.length === lengthBefore,
    originalHitIntact: fixture.text.sliceString(firstHit, firstHit + NEEDLE.length) === NEEDLE,
  }
}

function guardedPass(fixture: SearchFixture): GuardCounters & { readonly navigationMatched: boolean } {
  const guarded = guardText(fixture.text)
  const next = findNextMatch(guarded.doc, request(), Math.floor(fixture.text.length / 2))
  const previous = findPreviousMatch(guarded.doc, request(), fixture.text.length)
  const replaced = buildReplaceAll(guarded.doc, request(), REPLACEMENT)
  const scheduler = manualScheduler()
  const job = startSearchCount(guarded.doc, request(), scheduler, () => {}, { sliceMs: SLICE_MS, cap: DISPLAY_CAP })
  for (let index = 0; index < WARMUP; index++) scheduler.take()?.()
  job.cancel()
  return {
    ...guarded.counters,
    navigationMatched: next !== null && previous !== null && replaced !== null,
  }
}

function measureLongLine(fixture: SearchFixture): {
  readonly firstHitLatency: Latency
  readonly offsets: readonly number[]
  readonly expectedOffsets: readonly number[]
  readonly matchesExpected: boolean
} {
  const offsets: number[] = []
  let anchor = 0
  for (let index = 0; index < fixture.expectedLiteralCount; index++) {
    const match = findNextMatch(fixture.text, request(), anchor)
    if (match === null) break
    offsets.push(match.from)
    anchor = match.to
  }
  const sampled = sampleNavigation(() => findNextMatch(fixture.text, request(), 0))
  return {
    firstHitLatency: sampled.latency,
    offsets,
    expectedOffsets: fixture.expectedLiteralOffsets,
    matchesExpected:
      offsets.length === fixture.expectedLiteralOffsets.length &&
      offsets.every((offset, index) => offset === fixture.expectedLiteralOffsets[index]),
  }
}

const PREVIOUS_WINDOW_CHARS = 256 * 1024

function measureSpike() {
  const normal = buildTimed("normal-100m")
  const next = measureNextFixture(normal.fixture)
  const previous = measurePreviousFixture(normal.fixture)
  const guards = guardedPass(normal.fixture)
  const replaceAll = measureReplaceAll(normal.fixture)
  const normalCount = measureCount(normal.fixture.text, "normal-100m", 1_000_000)
  const dense = buildTimed("dense-100m")
  const denseCount = measureCount(dense.fixture.text, "dense-100m", DISPLAY_CAP)
  const cancellation = measureCancellation(dense.fixture.text)
  const longLine = buildTimed("long-line-20m")
  const longLineRow = measureLongLine(longLine.fixture)

  const gated = next.filter(
    row => row.from >= row.anchor && row.from - row.anchor <= NEXT_HIT_GATE_DISTANCE,
  )
  const worstP95 = gated.reduce((worst, row) => Math.max(worst, row.latency.p95), 0)
  const gate = {
    limitMs: NEXT_HIT_P95_LIMIT_MS,
    distanceChars: NEXT_HIT_GATE_DISTANCE,
    scenarios: gated.map(row => row.scenario),
    worstP95Ms: round(worstP95),
    pass: gated.length === GATED_SCENARIOS && worstP95 <= NEXT_HIT_P95_LIMIT_MS,
  }

  const report = {
    environment: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      warmup: WARMUP,
      samples: SAMPLES,
      sliceMs: SLICE_MS,
      sliceBudgetMs: SLICE_BUDGET_MS,
      displayCap: DISPLAY_CAP,
    },
    fixtures: [
      { name: normal.fixture.name, chars: normal.fixture.text.length, constructionMs: normal.constructionMs },
      { name: dense.fixture.name, chars: dense.fixture.text.length, constructionMs: dense.constructionMs },
      { name: longLine.fixture.name, chars: longLine.fixture.text.length, constructionMs: longLine.constructionMs },
    ],
    next,
    previous,
    count: [normalCount, denseCount],
    cancellation,
    replaceAll,
    longLine: longLineRow,
    guards,
    gate,
  }
  return { report, navigationText: normal.fixture.text }
}

type SpikeMeasurement = ReturnType<typeof measureSpike>

type BenchGlobal = typeof globalThis & { __omdSearchSpike?: SpikeMeasurement }

const benchGlobal = globalThis as BenchGlobal
const measured = benchGlobal.__omdSearchSpike ?? measureSpike()
if (!benchGlobal.__omdSearchSpike) {
  benchGlobal.__omdSearchSpike = measured
  console.log(JSON.stringify(measured.report, null, 2))
}
const navigationText = measured.navigationText

const gateRow = measured.report.gate
if (!gateRow.pass) {
  throw new Error(`next-hit p95 gate failed: ${String(gateRow.worstP95Ms)}ms > ${String(gateRow.limitMs)}ms`)
}

describe("spike search navigation (advisory)", () => {
  bench("normal-100m next hit from middle", () => {
    findNextMatch(navigationText, request(), Math.floor(navigationText.length / 2))
  })
  bench("normal-100m previous hit from tail", () => {
    findPreviousMatch(navigationText, request(), navigationText.length)
  })
})
