import { bench, describe } from "vitest"
import { measureFragmentedRangeSelection } from "./measure"

type Scenario = {
  name: string
  pendingCount: number
  regionCount: number
  iterations: number
}

type BenchGlobal = typeof globalThis & { __omdBuildDriverBenchLogged?: boolean }

const scenarios: Scenario[] = [
  { name: "1×1", pendingCount: 1, regionCount: 1, iterations: 20_000 },
  { name: "1000×1", pendingCount: 1_000, regionCount: 1, iterations: 2_000 },
  { name: "1000×64", pendingCount: 1_000, regionCount: 64, iterations: 1_000 },
]

const benchGlobal = globalThis as BenchGlobal

describe("build driver fragmented range selection (advisory)", () => {
  if (!benchGlobal.__omdBuildDriverBenchLogged) {
    benchGlobal.__omdBuildDriverBenchLogged = true
    const baseline = measureFragmentedRangeSelection(scenarios[0])
    console.info(`fragmented range selection ${scenarios[0].name}: ${baseline.toFixed(4)}ms/pass (1.00× baseline)`)

    for (const scenario of scenarios.slice(1)) {
      const ms = measureFragmentedRangeSelection(scenario)
      console.info(
        `fragmented range selection ${scenario.name}: ${ms.toFixed(4)}ms/pass (${(ms / baseline).toFixed(2)}× baseline)`,
      )
    }
  }

  bench("fragmented range selection 1000×64", () => {
    measureFragmentedRangeSelection(scenarios[2])
  })
})
