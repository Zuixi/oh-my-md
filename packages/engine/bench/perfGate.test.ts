import { beforeAll, describe, expect, it } from "vitest"
import { livePreviewField } from "../src/decorations/build"
import { STANDARD_PERFORMANCE_POLICY, WINDOWED_PERFORMANCE_POLICY } from "../src/performancePolicy"
import { makeOrderedListDoc, makeRichFormattedDoc } from "./generate"
import {
  fullyParsedLiveState,
  measureDecoRebuildMs,
  measureTyping,
  measureTypingWithMicrotasks,
  prepareTypingView,
  type TypingLatency,
} from "./measure"

// PERF-01/PERF-03 blocking gate (run via `pnpm --filter @omd/engine perf:gate`,
// which uses `vitest.perf.config.ts`: one worker, no parallel files).
//
// Budgets are absolute wall-clock numbers because the regression they guard is
// an order of magnitude, not a few percent: before the incremental-update
// rewrite a keystroke in the 4 800-paragraph document re-mapped, re-keyed and
// re-sorted all 72 000 specs (66–81 ms). A shared CI runner is noisy, so each
// scenario gets `ATTEMPTS` runs and passes when at least one lands inside the
// budget — scheduling noise can spoil a run, it cannot fake an O(N) rebuild.
const ATTEMPTS = 3

/** 4 800 paragraphs ≈ 460 KB / 72 000 specs — denser than the 353 KB / 57 600-spec
 * probe that motivated the rewrite (inline code + links per paragraph). */
const RICH_350K = makeRichFormattedDoc(4_800)
/** ≈ 1.3 MB / 204 000 specs: windowed steady state must stay flat with size. */
const RICH_1MB = makeRichFormattedDoc(13_600)
const ORDERED_2000 = makeOrderedListDoc(2_000)

/** Windowed scenarios type inside the built window (the viewport window covers
 * the document head in a layout-less host) with the production steady tree —
 * forcing a complete tree would measure CodeMirror's own fragment update, which
 * production never pays (apps/desktop/test/crossLayerNoFullTree.test.ts). */
const WINDOWED_CARET = 20_000

interface Budget { p50Ms: number; p95Ms: number }

const FULL_TREE_BUDGET: Budget = { p50Ms: 10, p95Ms: 16 }
const WINDOWED_350K_BUDGET: Budget = { p50Ms: 5, p95Ms: 12 }
const WINDOWED_1MB_BUDGET: Budget = { p50Ms: 8, p95Ms: 16 }
const ORDERED_LIST_BUILD_BUDGET_MS = 50

// Wall-clock budgets below are the reference numbers for the dev machine. A
// shared CI runner is slower by a machine-dependent factor, so they are scaled
// by a calibration loop that has nothing to do with the decoration code (a
// fixed arithmetic dependency chain, min of 3 runs). Clamped to [1, 4]: a
// faster host never gets a tighter budget than the reference, and a
// pathologically slow host cannot hide the regression this gate exists for —
// a per-keystroke O(N) rebuild is ~10x slower, far beyond any plausible factor.
const CALIBRATION_ITERATIONS = 4_000_000
/** Min-of-3 duration of that loop on the reference machine. */
const CALIBRATION_REFERENCE_MS = 4
let budgetFactor = 1

function calibrationFactor(): number {
  let best = Number.POSITIVE_INFINITY
  let sink = 0
  for (let run = 0; run < 3; run++) {
    const started = performance.now()
    let acc = sink
    for (let i = 0; i < CALIBRATION_ITERATIONS; i++) acc = (acc + Math.imul(i ^ acc, 2654435761)) | 0
    sink = acc
    best = Math.min(best, performance.now() - started)
  }
  const factor = Math.min(4, Math.max(1, best / CALIBRATION_REFERENCE_MS))
  console.info(`[perf-gate] calibration ${best.toFixed(2)}ms → budget factor ${factor.toFixed(2)}`)
  // Keep the accumulator observable so the loop cannot be optimized away.
  if (sink === 0x7fffffff) throw new Error("unreachable calibration sink")
  return factor
}

const format = (latency: TypingLatency) =>
  `p50 ${latency.p50Ms.toFixed(2)}ms p95 ${latency.p95Ms.toFixed(2)}ms (${latency.samples} samples)`

/** Runs the scenario up to `ATTEMPTS` times and reports whether the achievable
 * cost fits the (calibrated) budget; every attempt is logged for the CI log. */
function expectWithinBudget(
  name: string,
  budget: Budget,
  measure: () => TypingLatency,
): void {
  const p50Budget = budget.p50Ms * budgetFactor
  const p95Budget = budget.p95Ms * budgetFactor
  const attempts: TypingLatency[] = []
  let passed = false
  for (let attempt = 0; attempt < ATTEMPTS && !passed; attempt++) {
    const latency = measure()
    attempts.push(latency)
    console.info(`[perf-gate] ${name} attempt ${attempt + 1}: ${format(latency)}`)
    passed = latency.p50Ms <= p50Budget && latency.p95Ms <= p95Budget
  }
  expect(
    passed,
    `${name} exceeded its budget (p50 <= ${p50Budget.toFixed(1)}ms, p95 <= ${p95Budget.toFixed(1)}ms): `
      + attempts.map(format).join(" | "),
  ).toBe(true)
}

/** `expectWithinBudget` for a scenario that awaits between keystrokes (microtask drain). */
async function expectWithinBudgetAsync(
  name: string,
  budget: Budget,
  measure: () => Promise<TypingLatency>,
): Promise<void> {
  const p50Budget = budget.p50Ms * budgetFactor
  const p95Budget = budget.p95Ms * budgetFactor
  const attempts: TypingLatency[] = []
  let passed = false
  for (let attempt = 0; attempt < ATTEMPTS && !passed; attempt++) {
    const latency = await measure()
    attempts.push(latency)
    console.info(`[perf-gate] ${name} attempt ${attempt + 1}: ${format(latency)}`)
    passed = latency.p50Ms <= p50Budget && latency.p95Ms <= p95Budget
  }
  expect(
    passed,
    `${name} exceeded its budget (p50 <= ${p50Budget.toFixed(1)}ms, p95 <= ${p95Budget.toFixed(1)}ms): `
      + attempts.map(format).join(" | "),
  ).toBe(true)
}

describe("engine live-preview perf budget (PERF-01 / PERF-03)", () => {
  beforeAll(() => {
    budgetFactor = calibrationFactor()
  })
  it("builds the 4 800-paragraph document to full parity before timing it", () => {
    // Guard against a hollow gate: the timed scenario must carry the full spec
    // set (the old full-drain shape), not a half-built progressive field.
    const view = prepareTypingView(RICH_350K, {
      mode: "live", tree: "complete", drain: true, policy: STANDARD_PERFORMANCE_POLICY,
    })
    const live = view.state.field(livePreviewField)
    expect(live.pending).toEqual([])
    expect(live.specs.length).toBeGreaterThan(50_000)
    expect(live.deco.size).toBe(live.specs.length)
    const parent = view.dom.parentElement
    view.destroy()
    parent?.remove()
  }, 120_000)

  it("keeps a full-tree keystroke in the 4 800-paragraph document under budget", () => {
    expectWithinBudget("rich 4.8k full-tree drained", FULL_TREE_BUDGET, () =>
      measureTyping(RICH_350K, {
        mode: "live", tree: "complete", drain: true, keystrokes: 60,
        policy: STANDARD_PERFORMANCE_POLICY,
      }))
  }, 240_000)

  it("keeps a full-tree keystroke + microtasks in the 4 800-paragraph document under budget", () =>
    expectWithinBudgetAsync("rich 4.8k full-tree drained + microtasks", FULL_TREE_BUDGET, () =>
      measureTypingWithMicrotasks(RICH_350K, {
        mode: "live", tree: "complete", drain: true, keystrokes: 60,
        policy: STANDARD_PERFORMANCE_POLICY,
      })), 240_000)

  it("builds a windowed steady state (window specs built, the rest pending)", () => {
    const view = prepareTypingView(RICH_350K, {
      mode: "live", tree: "steady", safeWindow: true, caret: WINDOWED_CARET,
      policy: WINDOWED_PERFORMANCE_POLICY,
    })
    const live = view.state.field(livePreviewField)
    expect(live.specs.length).toBeGreaterThan(500)
    expect(live.specs.length).toBeLessThan(20_000)
    expect(live.pending.length).toBeGreaterThan(0)
    expect(live.pending[live.pending.length - 1].to).toBe(RICH_350K.length)
    const parent = view.dom.parentElement
    view.destroy()
    parent?.remove()
  }, 120_000)

  it("keeps a windowed keystroke in the 4 800-paragraph document under budget", () => {
    expectWithinBudget("rich 4.8k windowed", WINDOWED_350K_BUDGET, () =>
      measureTyping(RICH_350K, {
        mode: "live", tree: "steady", safeWindow: true, caret: WINDOWED_CARET,
        keystrokes: 60, policy: WINDOWED_PERFORMANCE_POLICY,
      }))
  }, 240_000)

  it("keeps a windowed keystroke in the ~1.3 MB document under budget", () => {
    expectWithinBudget("rich 13.6k windowed", WINDOWED_1MB_BUDGET, () =>
      measureTyping(RICH_1MB, {
        mode: "live", tree: "steady", safeWindow: true, caret: WINDOWED_CARET,
        keystrokes: 60, policy: WINDOWED_PERFORMANCE_POLICY,
      }))
  }, 240_000)

  it("builds a 2 000-item ordered list from scratch under budget", () => {
    const state = fullyParsedLiveState(ORDERED_2000)
    const samples = Array.from({ length: ATTEMPTS }, () => measureDecoRebuildMs(state))
    console.info(`[perf-gate] ordered list 2000 build: ${samples.map(ms => ms.toFixed(2)).join(", ")}ms`)
    const budget = ORDERED_LIST_BUILD_BUDGET_MS * budgetFactor
    expect(
      Math.min(...samples),
      `ordered list 2000 build exceeded ${budget.toFixed(1)}ms: ${samples.join(", ")}ms`,
    ).toBeLessThan(budget)
  }, 120_000)
})
