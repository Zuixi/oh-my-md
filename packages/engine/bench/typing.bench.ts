import { bench, describe } from "vitest"
import {
  budgetLine, fullyParsedLiveState, measureColdParseMs,
  measureDecoRebuildMs, measureStatsMs, measureTyping, STATS_BUDGET_MS, TYPING_P95_BUDGET_MS,
} from "./measure"
import { makeBenchmarkDoc } from "./generate"

const DOC_10K = makeBenchmarkDoc(10000)
const DOC_50K = makeBenchmarkDoc(50000)

describe("large document benchmarks (advisory)", () => {
  bench("typing 10k lines (live)", () => {
    const r = measureTyping(DOC_10K, { mode: "live" })
    console.info(budgetLine("typing p95 10k live", r.p95Ms, TYPING_P95_BUDGET_MS))
  })

  bench("typing 10k lines (source)", () => {
    const r = measureTyping(DOC_10K, { mode: "source" })
    console.info(budgetLine("typing p95 10k source", r.p95Ms, TYPING_P95_BUDGET_MS))
  })

  bench("typing 50k lines (source, safe mode)", () => {
    const r = measureTyping(DOC_50K, { mode: "source", keystrokes: 100 })
    console.info(budgetLine("typing p95 50k source", r.p95Ms, TYPING_P95_BUDGET_MS))
  })

  bench("cold parse 10k", () => {
    console.info(`cold parse 10k: ${measureColdParseMs(DOC_10K).toFixed(2)}ms`)
  })

  bench("cold parse 50k", () => {
    console.info(`cold parse 50k: ${measureColdParseMs(DOC_50K).toFixed(2)}ms`)
  })

  bench("decoration rebuild 10k (live)", () => {
    const state = fullyParsedLiveState(DOC_10K)
    console.info(`deco rebuild 10k: ${measureDecoRebuildMs(state).toFixed(2)}ms`)
  })

  bench("documentStats 50k", () => {
    console.info(budgetLine("documentStats 50k", measureStatsMs(DOC_50K), STATS_BUDGET_MS))
  })
})
